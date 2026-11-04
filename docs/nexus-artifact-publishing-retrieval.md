# Epic 12 — Nexus Artifact Publishing and Retrieval Contract

## Goal and boundary

Define a repository-neutral contract for publishing a release artifact set to Nexus and retrieving it for customer verification. This is design/schema work only. It does not connect to a live Nexus instance, alter repository settings, change Jenkins jobs, create credentials, or publish/delete artifacts.

The existing CMM pipeline hierarchy has been described as folder → subfolder → version → customer → package. The exact order and meaning of those segments are not yet authoritative. The path below is therefore a logical coordinate, not a configured Nexus URL or confirmed repository layout.

## Logical release coordinate

A release is identified by the tuple:

- customer ID
- product
- version
- optional release ID

The build provenance contract from Epic 11 supplies source commit, Jenkins pipeline/job/build identity, artifact filename, SHA-256 and size. The Nexus publication record in `schemas/nexus-artifact-set.schema.json` inventories the companion files and marks the artifact set as `staged` or `complete`.

Do not derive customer/product/version/release values from untrusted branch names, folder names, artifact names or user-supplied paths. Resolve them from the authoritative CMM/Jenkins configuration once the ACI POC confirms the source and validation rules. Reject missing or ambiguous coordinates.

## Proposed artifact set

| Logical role | Proposed filename | Purpose |
|---|---|---|
| package | Original package filename | ZIP/TAR/TAR.GZ or other POC-approved package |
| package_checksum | `<package>.sha256` | SHA-256 digest of the exact package bytes |
| release_manifest | `release-manifest.json` | File inventory and release metadata; placement inside the archive and beside it must follow the confirmed delivery requirement |
| manifest_ignore | `manifest-ignore.json` | Explicit exclusions used by the manifest/inventory process |
| manifest_ignore_checksum | `manifest-ignore.json.sha256` | Digest of the exact ignore-policy bytes |
| manifest_ignore_signature | `manifest-ignore.sig` | Optional detached signature, only after signing/trust design is approved |

The publication record itself may be stored as a sidecar or retained by the publisher; its final placement is a POC decision. The record's `files` list describes the artifact set and its SHA-256/size values. It must not contain credentials, tokens, private keys, connection strings or customer secrets.

The package format is not assumed. ZIP, TAR, TAR.GZ and any additional format must be explicitly supported by the verifier before being enabled. Do not silently treat an unknown extension as a supported archive.

## Repository path convention

Use a logical path assembled from the confirmed release coordinate:

```text
<approved-repository>/<confirmed-customer-and-product-path>/<version>/<release-id>/
  <package>
  <package>.sha256
  release-manifest.json
  manifest-ignore.json
  manifest-ignore.json.sha256
  [manifest-ignore.sig]
  [publication-record.json]
```

This is illustrative only. It is not a proposed hard-coded path and must not be used to configure Jenkins or Nexus until the POC confirms:

1. Nexus repository key and format (hosted/proxy/group, raw/Maven/etc.).
2. Canonical path segment order and exact mapping to the existing folder/subfolder/version/customer/package hierarchy.
3. Whether customer is before or after version, and whether release ID is mandatory.
4. Filename casing, allowed characters, URL encoding and case-sensitivity rules.
5. Whether the manifest is both embedded inside the archive and beside it.
6. Which file types and package extensions are officially supported.

Treat every coordinate segment as data, not a filesystem path. Reject separators, dot segments, control characters and traversal forms. Encode path segments using the Nexus client's documented mechanism; never concatenate unchecked user input into a URL.

## Publish workflow

1. Resolve and validate the release coordinate from the approved configuration source.
2. Build the package and freeze the finalized package bytes.
3. Generate the manifest and ignore policy from approved inputs; calculate package, manifest and ignore-policy SHA-256 values.
4. Validate the Epic 11 provenance input and this artifact-set publication record. Re-read the finalized package and verify its size and digest before upload.
5. Upload to a unique staging coordinate where repository capabilities permit. If Nexus cannot atomically promote a complete set, publish a completion record/marker last and require consumers to ignore sets without a valid `complete` state.
6. Read back every uploaded object and verify byte size and SHA-256 against the publication record. Nexus-provided checksum metadata is useful as an additional signal, but the client-side digest check remains authoritative.
7. Mark the set complete only after all required objects have been read back and verified.
8. Emit a non-secret publication report containing coordinate, filenames, digests, sizes, build identity, outcome and actionable failure details.

Never expose a partially uploaded set as complete. Do not delete or overwrite a previous release as an automatic retry strategy.

## Retrieval and verification workflow

The customer verifier remains offline after the files are downloaded; it must not require Nexus credentials or make network calls.

1. Retrieve the package and every required companion file for one exact release coordinate.
2. Reject incomplete sets, duplicate/conflicting filenames, unexpected required-role omissions and mismatched coordinates.
3. Verify the manifest-ignore policy against its independently trusted SHA-256 anchor (and verify its signature when a future approved signature scheme is enabled). Do this before trusting ignore rules.
4. Parse and validate the release manifest; reject unknown fields, invalid paths, unsupported schema versions and inconsistent release identity.
5. Verify the package checksum and size against the published release metadata.
6. Compare the extracted package inventory against the manifest, applying only the now-validated ignore policy. Report missing, modified and unexpected files.
7. Produce a machine-readable verification report and non-zero exit status for any failed or incomplete check.

A checksum proves byte equality with the referenced digest; it does not prove who created the digest. Signature verification and public-key distribution require an approved trust model and must not be improvised in this epic.

## Immutability, retry and lifecycle

- Prefer a dedicated hosted release repository with redeploy/overwrite disabled, subject to Nexus repository format capabilities and administrator approval.
- A release coordinate should be immutable. A corrected build should receive a new release/build coordinate or an explicitly approved superseding release; it must not silently replace bytes under an existing coordinate.
- Retry only idempotent operations. Before retrying an upload, inspect the existing object: accept it only if its bytes match the expected digest; otherwise fail and raise a conflict.
- Use bounded retries for transient network/server failures, with backoff and a clear final error. Do not retry authentication/authorization failures indefinitely.
- Never automatically delete a partially published or previously released object. Quarantine/cleanup must be a separately authorized operation with audit records.
- Retention, staging cleanup, legal hold, archival and deletion ownership remain unresolved POC/admin decisions.

## Failure handling

| Failure | Required behavior |
|---|---|
| Missing/ambiguous release coordinate | Stop before upload; report the missing authoritative field |
| Unsupported package type | Reject before publishing |
| Package changes after manifest generation | Recompute and fail the build on mismatch |
| Missing sidecar or incomplete upload | Keep set non-complete; customer retrieval rejects it |
| Read-back digest/size mismatch | Fail publication; do not mark complete |
| Existing coordinate with identical bytes | Treat as idempotent only if policy permits |
| Existing coordinate with different bytes | Conflict; never overwrite |
| Nexus unavailable / transient 5xx | Bounded retry, then fail with report |
| 401/403 or credential error | Fail immediately; never print secret values |
| Invalid manifest-ignore trust anchor/signature | Reject policy before applying exclusions |
| Retrieval returns wrong customer/version | Reject the set; do not fall back to a nearby version |

Reports and logs must not include credentials, authorization headers, private keys, secret environment variables or sensitive customer configuration.

## Decisions required from ACI POC / Nexus owner

- Nexus base URL, repository key, repository format and authentication mechanism (share secrets only through the approved secret manager; never in source or chat).
- Canonical path structure and exact mapping to the current CMM folder hierarchy.
- Package formats/extensions and maximum artifact size.
- Required sidecars, manifest embedding and completion-marker mechanism.
- Whether Nexus supports staging/promotion and redeploy prevention for the selected repository format.
- Checksum algorithm policy (SHA-256 required by this design) and whether Nexus-native checksums are exposed.
- Signing algorithm, key custody, public-key distribution, rotation/revocation and trust-anchor delivery.
- Retry limits, timeout policy, retention, cleanup, audit and release supersession policy.
- Which Jenkins stages/jobs own publish and read-back verification, and which team owns Nexus permissions.

## Acceptance criteria

- Logical coordinate and artifact roles are explicitly described without inventing real Nexus paths or ACI values.
- JSON Schema rejects unknown fields and invalid digest/filename shapes.
- Publishing requires validated provenance and a complete artifact set.
- Partial publication cannot be consumed as a complete release.
- Read-back verification checks every required object by SHA-256 and size.
- Existing releases are never silently overwritten or automatically deleted.
- Customer verification remains offline and fails closed for incomplete, mismatched or untrusted inputs.
- Live Nexus/Jenkins integration remains disabled until POC decisions, credentials and explicit implementation approval are available.

## Out of scope

Live Nexus connectivity, Jenkinsfile edits, credential provisioning, repository administration, artifact upload/download, retention cleanup, and any hardware/storage snapshot collection.
