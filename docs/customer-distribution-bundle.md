# Epic 9 — Customer Distribution Bundle

## Goal
Create a portable ZIP that a customer can extract and run offline. The bundle contains
only the Python pre-upgrade verifier, its Python helper modules, a compatibility
template, and relevant documentation. It excludes Node/Jenkins runtime, private keys,
credentials, release artifacts, customer snapshots, and reports.

## Build
Run from the repository root with Python 3:

```sh
python3 scripts/build_customer_bundle.py --output /tmp/customer-preupgrade-tool.zip
```

A SHA-256 sidecar is written beside the ZIP. Existing outputs are not overwritten
unless `--force` is supplied. Output must be outside the repository.

## Customer usage
Extract the ZIP, read `README-CUSTOMER.md`, populate the compatibility matrix only
with owner/ACI-approved values, and run the documented Python module command.
No third-party packages are required.

## Validation
```sh
python3 -m unittest discover -s tests -p 'test_customer_bundle.py' -v
```

## Boundaries
- No network transmission, install, privileged command, or configuration change.
- Linux and AIX snapshot collection only; unsupported operating systems exit early.
- Hardware/storage/filesystem/mount collection remains excluded.
- The compatibility template is deliberately non-authoritative.
- A SHA-256 sidecar is for transfer integrity; authenticity requires a trusted digest
  or Ed25519 public key delivered independently.
