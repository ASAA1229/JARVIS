#!/usr/bin/env python3
"""Customer-side pre-upgrade verification. Standard library only; read-only inputs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from scripts.compatibility_matrix import MatrixError, compare, load_json
from scripts.environment_snapshot import SnapshotError, collect_snapshot


class VerificationError(RuntimeError):
    """Raised when any required verification stage cannot be completed."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise VerificationError(f"Cannot read file {path}: {exc}") from exc
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"Cannot read valid JSON from {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"{path} must contain a JSON object")
    return value


def regular_file(path: Path, label: str) -> None:
    try:
        if path.is_symlink() or not path.is_file():
            raise VerificationError(f"{label} must be a regular, non-symlink file: {path}")
    except OSError as exc:
        raise VerificationError(f"Cannot inspect {label}: {exc}") from exc


def safe_relative_path(raw: Any) -> str:
    if not isinstance(raw, str) or not raw or "\x00" in raw or "\\" in raw:
        raise VerificationError("Manifest contains an invalid relative file path")
    segments = raw.split("/")
    if raw.startswith("/") or any(part in ("", ".", "..") for part in segments):
        raise VerificationError(f"Unsafe manifest path: {raw!r}")
    if re.match(r"^[A-Za-z]:", raw):
        raise VerificationError(f"Absolute manifest path is not allowed: {raw!r}")
    return PurePosixPath(*segments).as_posix()


def inventory(root: Path) -> dict[str, dict[str, Any]]:
    if root.is_symlink() or not root.is_dir():
        raise VerificationError("Extracted package must be a real directory")
    entries: dict[str, dict[str, Any]] = {}
    for current, dirs, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        dirs.sort()
        files.sort()
        for name in list(dirs):
            candidate = current_path / name
            if candidate.is_symlink():
                raise VerificationError(f"Symbolic link is not allowed: {candidate.relative_to(root)}")
        for name in files:
            candidate = current_path / name
            if candidate.is_symlink() or not candidate.is_file():
                raise VerificationError(f"Unsupported package entry: {candidate.relative_to(root)}")
            relative = candidate.relative_to(root).as_posix()
            stat = candidate.stat()
            entries[relative] = {"size": stat.st_size, "sha256": sha256_file(candidate)}
    return entries


def verify_release(policy_path: Path, manifest_path: Path, artifact_path: Path,
                   extracted_dir: Path, trusted_policy_sha256: str) -> dict[str, Any]:
    # Stage 1: authenticate manifest-ignore before reading its contents.
    regular_file(policy_path, "manifest-ignore")
    trusted = trusted_policy_sha256.strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", trusted):
        raise VerificationError("A trusted manifest-ignore SHA-256 (64 hex characters) is required")
    policy_hash = sha256_file(policy_path)
    if policy_hash != trusted:
        raise VerificationError("Stage 1 FAILED: manifest-ignore does not match the independently trusted SHA-256")
    policy = read_json(policy_path)
    if (policy.get("schemaVersion") != 1 or policy.get("algorithm") != "SHA256"
            or policy.get("purpose") != "manifest-ignore"
            or not isinstance(policy.get("manifest"), dict)
            or not isinstance(policy.get("artifact"), dict)):
        raise VerificationError("Stage 1 FAILED: invalid manifest-ignore schema")
    print("Stage 1 PASSED: manifest-ignore authenticated")

    # Stage 2: authenticate manifest bytes using the already trusted policy.
    regular_file(manifest_path, "release manifest")
    manifest_ref = policy["manifest"]
    if manifest_path.name != manifest_ref.get("name") or sha256_file(manifest_path) != manifest_ref.get("sha256"):
        raise VerificationError("Stage 2 FAILED: manifest name or SHA-256 mismatch")
    manifest = read_json(manifest_path)
    if (manifest.get("schemaVersion") != 1 or manifest.get("algorithm") != "SHA256"
            or manifest.get("project") != policy.get("project")
            or not isinstance(manifest.get("files"), list)
            or not isinstance(manifest.get("artifact"), dict)
            or not isinstance(manifest.get("source"), dict)):
        raise VerificationError("Stage 2 FAILED: invalid release manifest schema or project")
    print("Stage 2 PASSED: release manifest authenticated")

    # Stage 3: verify the delivered archive, then its already-extracted contents.
    regular_file(artifact_path, "release artifact")
    artifact_ref = policy["artifact"]
    artifact = manifest["artifact"]
    actual_size = artifact_path.stat().st_size
    actual_hash = sha256_file(artifact_path)
    for ref in (artifact_ref, artifact):
        if (ref.get("name") != artifact_path.name or ref.get("size") != actual_size
                or ref.get("sha256") != actual_hash):
            raise VerificationError("Stage 3 FAILED: release package name, size, or SHA-256 mismatch")

    expected: dict[str, dict[str, Any]] = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict):
            raise VerificationError("Manifest contains an invalid inventory entry")
        relative = safe_relative_path(entry.get("path"))
        size, digest = entry.get("size"), entry.get("sha256")
        if relative in expected or not isinstance(size, int) or size < 0 or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise VerificationError(f"Invalid or duplicate manifest inventory entry: {relative}")
        expected[relative] = {"size": size, "sha256": digest}
    if manifest.get("fileCount") != len(expected):
        raise VerificationError("Manifest fileCount does not match its inventory")

    actual = inventory(extracted_dir)
    problems: list[str] = []
    for name, entry in expected.items():
        if name not in actual:
            problems.append(f"MISSING: {name}")
        elif actual[name] != entry:
            problems.append(f"MISMATCH: {name}")
    for name in actual:
        if name not in expected:
            problems.append(f"UNEXPECTED: {name}")
    if problems:
        raise VerificationError("Stage 3 FAILED: " + "; ".join(problems))
    print(f"Stage 3 PASSED: archive SHA-256 and {len(actual)} extracted files verified")
    return {
        "project": manifest["project"],
        "source": manifest["source"],
        "artifact": {"name": artifact_path.name, "size": actual_size, "sha256": actual_hash},
        "verified_file_count": len(actual),
    }


def atomic_json_write(document: dict[str, Any], destination: Path) -> None:
    temporary = destination.with_name(destination.name + ".tmp")
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        temporary.replace(destination)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise VerificationError(f"Cannot write report {destination}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run customer-side release and pre-upgrade checks.")
    parser.add_argument("--manifest-ignore", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, required=True, help="Delivered ZIP/TAR package file")
    parser.add_argument("--extracted-dir", type=Path, required=True, help="Customer-extracted package directory")
    parser.add_argument("--trusted-policy-sha256", required=True,
                        help="64-character digest obtained through an independent trusted channel")
    parser.add_argument("--matrix", type=Path, required=True, help="Customer/ACI-approved compatibility matrix")
    parser.add_argument("--snapshot", type=Path, help="Existing environment snapshot JSON")
    parser.add_argument("--collect-snapshot", action="store_true",
                        help="Collect a fresh Linux/AIX snapshot before comparison")
    parser.add_argument("--snapshot-output", type=Path, default=Path("environment-snapshot.json"))
    parser.add_argument("--report", type=Path, default=Path("pre-upgrade-report.json"))
    args = parser.parse_args(argv)

    try:
        if args.collect_snapshot and args.snapshot:
            raise VerificationError("Use either --snapshot or --collect-snapshot, not both")
        if args.collect_snapshot:
            snapshot = collect_snapshot()
            atomic_json_write(snapshot, args.snapshot_output)
            snapshot_path = args.snapshot_output
        elif args.snapshot:
            snapshot_path = args.snapshot
            snapshot = read_json(snapshot_path)
        else:
            raise VerificationError("Provide --snapshot or --collect-snapshot")

        release = verify_release(args.manifest_ignore, args.manifest, args.artifact,
                                 args.extracted_dir, args.trusted_policy_sha256)
        matrix = load_json(args.matrix)
        compatibility = compare(snapshot, matrix)
        report = {
            "report_schema_version": 1,
            "verification_type": "customer-pre-upgrade",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "overall_status": (
                "failed" if compatibility["overall_status"] == "unsupported" else
                "incomplete" if compatibility["overall_status"] == "incomplete" else "passed"
            ),
            "release": release,
            "snapshot_file": str(snapshot_path),
            "compatibility": compatibility,
            "limitations": [
                "Compatibility results are only as authoritative as the supplied approved matrix.",
                "No hardware, storage, filesystem, or mount inventory is collected.",
                "No data is transmitted; all inputs remain local.",
                "Package verification checks the supplied extracted directory against the manifest.",
            ],
        }
        atomic_json_write(report, args.report)
        print(f"Pre-upgrade report written: {args.report} ({report['overall_status']})")
        return 0 if report["overall_status"] == "passed" else 2
    except (VerificationError, SnapshotError, MatrixError) as exc:
        print(f"VERIFICATION ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
