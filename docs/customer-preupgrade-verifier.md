# Epic 8 — Customer Pre-Upgrade Verification Utility

## Purpose
A customer-runnable Python 3 utility that performs a local release-integrity check,
uses an environment snapshot, compares it with an approved compatibility matrix,
and writes one consolidated JSON report. It uses only the Python standard library.

## Inputs
- `manifest-ignore.json`: release policy created from the release manifest and package.
- Trusted SHA-256 for that policy, obtained independently (for example, a signed hand-off
  or a controlled release communication). Do not obtain the trusted digest from the same
  untrusted package directory.
- Release manifest JSON and delivered package archive.
- Customer-extracted package directory, to compare every file with the manifest.
- Customer/ACI-approved compatibility matrix.
- Existing snapshot JSON, or use `--collect-snapshot` to collect a fresh Linux/AIX snapshot.

## Run
From the repository root, with Python 3.9+:

```sh
python3 scripts/customer_preupgrade_verifier.py \
  --manifest-ignore manifest-ignore.json \
  --trusted-policy-sha256 <trusted-64-character-sha256> \
  --manifest release-manifest.json \
  --artifact customer-release.tar.gz \
  --extracted-dir ./customer-release \
  --matrix approved-compatibility.json \
  --collect-snapshot \
  --snapshot-output environment-snapshot.json \
  --report pre-upgrade-report.json
```

To reuse an existing snapshot, replace `--collect-snapshot` with
`--snapshot environment-snapshot.json`.

## Verification order
1. Authenticate manifest-ignore against the independently trusted SHA-256 before
   parsing its policy fields.
2. Verify manifest filename and SHA-256 against the authenticated policy.
3. Verify package filename, size and SHA-256 against both policy and manifest.
4. Validate every extracted file path, size and SHA-256; reject missing, modified,
   unexpected, symlinked, or special entries.
5. Compare snapshot fields against the supplied compatibility matrix.

The compatibility matrix is the only source of expected platform values. The utility
does not claim ACI certification or invent OS/runtime/database/middleware support.

## Results and exit codes
- `0`: all package checks and compatibility checks passed.
- `2`: compatibility is unsupported or incomplete; inspect the report.
- `1`: invalid inputs, trust failure, collection failure, or package verification failure.

The JSON report includes release identity, package hash, verified file count,
compatibility results, and limitations. Reports may contain customer host details;
review before sharing.

## Safety boundaries
- Read-only inputs; only requested snapshot/report output files are written.
- No network requests, automatic upload, package installation, configuration changes,
  service restarts, privilege escalation, or admin requirement.
- Hardware, storage, filesystem and mount collection remain excluded.
- The utility expects the archive to be extracted by the customer; it does not unpack
  untrusted archives itself.
- Python's standard library does not implement Ed25519 verification. This utility
  anchors manifest-ignore to an independently trusted SHA-256; use the existing
  signed-policy verifier if a cryptographic signature workflow is mandated.
- The supplied extracted directory must correspond to the delivered archive. The
  manifest's inventory is checked, but archive extraction itself is outside this tool.

## Tests
```sh
python3 -m unittest discover -s tests -p 'test_customer_preupgrade_verifier.py' -v
```
