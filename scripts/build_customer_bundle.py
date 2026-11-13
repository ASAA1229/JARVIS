#!/usr/bin/env python3
"""Create a minimal, offline customer distribution bundle for pre-upgrade verification."""
from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "scripts/__init__.py",
    "scripts/customer_preupgrade_verifier.py",
    "scripts/environment_snapshot.py",
    "scripts/compatibility_matrix.py",
    "compatibility/example-matrix.template.json",
    "docs/customer-preupgrade-verifier.md",
    "docs/environment-snapshot-utility.md",
    "docs/compatibility-matrix.md",
)
README = """# Customer Pre-Upgrade Verification Tool

This is an offline Python 3 customer bundle. It uses only the Python standard
library and does not install packages, connect to the network, or transmit data.

## Prepare
1. Copy `compatibility/example-matrix.template.json` to
   `approved-compatibility.json`.
2. Replace every placeholder with values from the compatibility specification
   approved by the project owner/ACI. Do not treat the template as certification.
3. Place the release manifest, manifest-ignore policy, package archive, and the
   extracted package directory in a working directory.
4. Obtain the trusted manifest-ignore SHA-256 through a separate authenticated
   channel. Never trust a digest copied only from the same package directory.

## Run from the bundle root
Linux:
```sh
python3 -m scripts.customer_preupgrade_verifier \\
  --manifest-ignore /path/to/manifest-ignore.json \\
  --trusted-policy-sha256 <trusted-64-character-sha256> \\
  --manifest /path/to/release-manifest.json \\
  --artifact /path/to/customer-release.tar.gz \\
  --extracted-dir /path/to/extracted-package \\
  --matrix /path/to/approved-compatibility.json \\
  --collect-snapshot --snapshot-output environment-snapshot.json \\
  --report pre-upgrade-report.json
```

Windows PowerShell:
```powershell
py -3 -m scripts.customer_preupgrade_verifier `
  --manifest-ignore .\\manifest-ignore.json `
  --trusted-policy-sha256 <trusted-64-character-sha256> `
  --manifest .\\release-manifest.json `
  --artifact .\\customer-release.tar.gz `
  --extracted-dir .\\extracted-package `
  --matrix .\\approved-compatibility.json `
  --collect-snapshot --snapshot-output .\\environment-snapshot.json `
  --report .\\pre-upgrade-report.json
```

Use `--snapshot existing-snapshot.json` instead of `--collect-snapshot` to
compare a previously collected snapshot. Exit codes: 0 passed, 2 compatibility
unsupported/incomplete, 1 verification/input error.

The snapshot collector supports Linux and AIX only. Other operating systems exit
before OS-specific collection commands run. Hardware, storage, filesystem, and
mount collection are intentionally excluded. Read the bundled documentation
before customer use.
"""

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_bundle(destination: Path, force: bool = False) -> tuple[Path, str]:
    destination = destination.expanduser()
    if destination.is_symlink():
        raise ValueError("Output must not be a symbolic link.")
    destination = destination.resolve()
    if destination == ROOT or ROOT in destination.parents:
        raise ValueError("Output must be outside the repository to avoid bundling generated files.")
    if destination.exists() and not force:
        raise FileExistsError(f"Refusing to overwrite existing output: {destination}")
    for relative in FILES:
        source = ROOT / relative
        if not source.is_file() or source.is_symlink():
            raise FileNotFoundError(f"Required bundle source is missing or unsafe: {relative}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=destination.name + ".", suffix=".tmp", dir=destination.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            archive.writestr("README-CUSTOMER.md", README)
            for relative in FILES:
                archive.write(ROOT / relative, arcname=relative)
        digest = sha256(temporary)
        temporary.replace(destination)
        return destination, digest
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("customer-preupgrade-tool.zip"))
    parser.add_argument("--force", action="store_true", help="Replace an existing output file")
    args = parser.parse_args(argv)
    try:
        requested_output = args.output.expanduser()
        if requested_output.is_symlink():
            raise ValueError("Output must not be a symbolic link.")
        output_path = requested_output.resolve()
        sidecar = output_path.with_name(output_path.name + ".sha256")
        if sidecar.is_symlink():
            raise ValueError("Checksum sidecar must not be a symbolic link.")
        if output_path.exists() and not output_path.is_file():
            raise ValueError("Output destination must be a regular file when it already exists.")
        if sidecar.exists() and not sidecar.is_file():
            raise ValueError("Checksum sidecar destination must be a regular file.")
        # Validate both destinations before creating/replacing either file. This
        # prevents a stale sidecar from leaving a newly-created bundle behind.
        if not args.force:
            if output_path.exists():
                raise FileExistsError(f"Refusing to overwrite existing output: {output_path}")
            if sidecar.exists():
                raise FileExistsError(f"Refusing to overwrite existing checksum sidecar: {sidecar}")
        output, digest = build_bundle(output_path, args.force)
        fd, temporary_name = tempfile.mkstemp(
            prefix=sidecar.name + ".", suffix=".tmp", dir=sidecar.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(f"{digest}  {output.name}\n")
            temporary.replace(sidecar)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        print(f"Bundle created: {output}")
        print(f"SHA-256: {digest}")
        print(f"Checksum sidecar: {sidecar}")
        return 0
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Bundle creation failed: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
