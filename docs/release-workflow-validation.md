# Epic 10 — End-to-End Release Workflow Validation

## Objective
Validate the existing release-integrity and customer-verification components as one
offline workflow. This epic adds integration coverage; it does not connect to or
modify Jenkins, Nexus, customer systems, or production release directories.

## Workflow contract
1. A build produces a package archive and a release manifest containing project,
   source commit/build identity, package metadata, and extracted-file inventory.
2. The manifest-ignore policy binds the manifest and package by name, size, and
   SHA-256. Its digest must be obtained independently, or its signature verified
   with an independently trusted Ed25519 public key.
3. Customer verification authenticates manifest-ignore before parsing it, then
   authenticates the manifest, then validates the package and extracted inventory.
4. The environment snapshot is compared only with a supplied owner/ACI-approved
   compatibility matrix.
5. The customer tool writes one JSON report and returns a meaningful exit code.

## Automated integration checks
Run from the repository root:

```sh
python3 -m unittest discover -s tests -p 'test_release_workflow.py' -v
```

Coverage includes successful end-to-end CLI execution, trusted-policy tampering,
manifest tampering, archive tampering, modified and unexpected extracted files,
and unsupported compatibility results. The tests use temporary synthetic fixtures;
they do not require a customer package or a real Linux/AIX server.

## Exit contract
- `0`: release integrity and compatibility checks passed.
- `2`: release integrity passed, but compatibility is unsupported or incomplete.
- `1`: trust, manifest, package, snapshot, matrix, or input verification failed.

## Explicitly out of scope
- Live Jenkins pipeline changes, build-server access, Nexus upload/download, and
  credential integration pending an approved POC hand-off contract.
- ACI support claims or compatibility values not supplied by the project owner.
- Hardware, storage, filesystem, and mount inventory.
- Automatic extraction of untrusted archives, installation, configuration changes,
  network transmission, or privilege escalation.

## Handoff questions before pipeline integration
- Which Jenkins job/build parameters are authoritative for customer, product,
  version, release, source commit, and build number?
- What exact Nexus repository/path convention and artifact naming rules are used?
- Is the customer trust anchor delivered as a pinned Ed25519 public key, a signed
  release communication, or another approved authenticated channel?
- Who owns approval/versioning of the ACI compatibility matrix?
