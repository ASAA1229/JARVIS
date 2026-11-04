#!/usr/bin/env python3
"""Customer-facing, read-only Linux/AIX environment snapshot collector.

Intentionally excludes hardware inventory, storage/filesystem inventory, secrets,
environment variables, process lists, and user/account enumeration.
"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Sequence

Command = tuple[str, ...]
Runner = Callable[[Sequence[str]], str]

LINUX_COMMANDS: dict[str, Command] = {
    "os_release": ("cat", "/etc/os-release"),
    "kernel": ("uname", "-srm"),
    "hostname": ("hostname",),
    "uptime": ("uptime", "-p"),
    "timezone_offset": ("date", "+%z"),
}
AIX_COMMANDS: dict[str, Command] = {
    "os_level": ("oslevel", "-s"),
    "kernel": ("uname", "-a"),
    "hostname": ("hostname",),
    "uptime": ("uptime",),
    "timezone_offset": ("date", "+%z"),
}


class SnapshotError(RuntimeError):
    """Raised when a complete snapshot cannot be collected."""


def run_command(command: Sequence[str]) -> str:
    try:
        result = subprocess.run(
            list(command),
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise SnapshotError(f"Command failed ({command[0]}): {exc}") from exc
    output = result.stdout.strip()
    if not output:
        raise SnapshotError(f"Command returned no output: {command[0]}")
    return output[:16_384]


def collect_snapshot(system_name: str | None = None,
                     runner: Runner = run_command) -> dict[str, object]:
    detected = (system_name or platform.system()).strip()
    normalized = detected.lower()
    if normalized == "linux":
        family = "Linux"
        commands = LINUX_COMMANDS
    elif normalized == "aix":
        family = "AIX"
        commands = AIX_COMMANDS
    else:
        raise SnapshotError(
            f"Unsupported operating system '{detected}'. Supported: Linux and AIX."
        )

    details: dict[str, str] = {}
    for key, command in commands.items():
        details[key] = runner(command)

    return {
        "schema_version": 1,
        "snapshot_type": "environment",
        "collected_at_utc": datetime.now(timezone.utc).isoformat(),
        "operating_system": family,
        "system_identifier": detected,
        "details": details,
        "scope": {
            "included": ["OS release/level", "kernel", "hostname", "uptime", "timezone offset"],
            "excluded": [
                "hardware inventory",
                "storage and filesystem inventory",
                "environment variables and secrets",
                "process lists",
                "user and account enumeration",
            ],
        },
    }


def write_snapshot(snapshot: dict[str, object], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        temporary.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
        temporary.replace(output)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise SnapshotError(f"Unable to write snapshot to {output}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Collect a read-only environment snapshot on Linux or AIX."
    )
    parser.add_argument(
        "-o", "--output", default="environment-snapshot.json",
        help="JSON output path (default: environment-snapshot.json)",
    )
    parser.add_argument("--stdout", action="store_true",
                        help="Write JSON to standard output instead of a file")
    args = parser.parse_args(argv)

    try:
        snapshot = collect_snapshot()
        if args.stdout:
            print(json.dumps(snapshot, indent=2))
        else:
            output = Path(args.output)
            write_snapshot(snapshot, output)
            print(f"Environment snapshot written: {output}")
        return 0
    except SnapshotError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
