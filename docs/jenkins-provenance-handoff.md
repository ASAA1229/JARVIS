# Epic 11 — Jenkins Build-to-Manifest Handoff

## Goal
Define a vendor-neutral contract between a Jenkins build and the existing release
manifest tooling. This epic is contract/design work only: it does not modify a
customer Jenkins controller, build server, Nexus repository, credentials, or
existing production pipeline.

## Existing implementation inspected
`scripts/artifact-integrity.mjs` creates a SHA-256 inventory and accepts:
- `PROJECT_NAME`
- `GIT_COMMIT` (or `GIT_COMMIT_SHA`)
- `BUILD_NUMBER` (or `GITHUB_RUN_NUMBER`)
- `REQUIRE_BUILD_PROVENANCE=true` to require a full commit SHA and build number

The generated manifest currently stores project, source commit/build number,
creation timestamp, file count, file inventory, and optional archive metadata.
It does not yet include customer/product/version/release metadata. Those fields
must be supplied from the authoritative CMM/Jenkins configuration after the POC
confirms their source and naming rules.

## Proposed handoff

1. Jenkins checks out the exact source revision and records the resolved full Git
   commit SHA (not a branch name or short SHA).
2. The pipeline resolves customer/product/version/release identifiers from the
   approved configuration source. It must fail if required values are absent or
   ambiguous; it must not guess from folder names.
3. The pipeline builds the package and creates the release manifest from the
   finalized package directory and archive.
4. The pipeline computes and verifies SHA-256 for the archive and manifest
   inventory. The build must stop on any mismatch.
5. A separate provenance input document records the agreed customer/release
   identity plus the artifact name, size, digest, Jenkins job/build identity and
   source commit. Schema: `schemas/release-provenance.schema.json`.
6. Only after validation and approval should the existing publishing stage upload
   package, manifest, checksum and manifest-ignore sidecars to the agreed Nexus
   destination. This epic does not implement that upload.
7. The customer verifier remains offline and consumes the delivered files; it
   does not need Jenkins credentials or Nexus connectivity.

## Required environment variables for current manifest generator

| Variable | Meaning | Rule |
|---|---|---|
| `PROJECT_NAME` | Stable project identifier | Required for release jobs |
| `GIT_COMMIT` | Full source commit SHA | 40–64 hex characters |
| `BUILD_NUMBER` | Jenkins build number | Non-empty string |
| `REQUIRE_BUILD_PROVENANCE` | Enforce provenance | Set to `true` in release validation |

Do not put passwords, access tokens, private keys, customer secrets, or connection
strings in the manifest or provenance document. Signing keys must be held in an
approved Jenkins credential store and used only by a narrowly scoped signing step.
Never print secret values to console logs or archive them as build artifacts.

## Artifact handoff layout (proposed; confirm with POC)

```text
release/
  <customer>/<product>/<version>/<build-or-release-id>/
    <package>.zip
    <package>.zip.sha256
    release-manifest.json
    manifest-ignore.json
    manifest-ignore.json.sha256
    manifest-ignore.sig       # only when approved signing is enabled
```

The final folder hierarchy, whether the manifest is also embedded inside the
archive, naming conventions, Nexus repository key, retention and overwrite policy
must be confirmed against the existing CMM pipeline and ACI POC response.

## Fail-closed rules
- Reject missing/short/invalid Git commit SHA and missing build number.
- Reject missing customer/product/version identifiers once their source is agreed.
- Reject artifact checksum, size, or manifest inventory mismatch.
- Never publish a partially generated release.
- Do not overwrite an existing release coordinate unless an explicit versioned
  replacement policy is approved.
- Do not infer customer identity from untrusted user input or branch names.
- Keep logs free of credentials and sensitive environment variables.

## POC decisions required before implementation

1. Which Jenkins job parameters or CMM customer configuration record is the
   authoritative source for customer ID, product, version and release ID?
2. Are IVP, E2E, ACQ and PERF expected to use one common contract or have
   pipeline-specific required metadata?
3. What is the canonical Nexus repository key and exact path layout
   (folder/subfolder/version/customer/package order)?
4. Are artifacts ZIP, TAR/TAR.GZ, or another format, and is the manifest required
   both inside and beside each artifact?
5. Which identity signs the manifest-ignore policy, where is its public key
   distributed, and who rotates/revokes it?
6. What are the immutability, retention, re-run and release overwrite rules?
7. Who approves and versions the ACI compatibility matrix?

## Acceptance criteria
- Contract schema is explicit and rejects unknown fields.
- No secret fields are present in the contract.
- Required provenance and customer/release fields have identified owners.
- Jenkins integration is not enabled until the POC confirms authoritative inputs,
  Nexus layout and signing/trust procedure.
- Customer verification remains offline and does not depend on Jenkins/Nexus.
