# Epic 7 — Compatibility Matrix and Snapshot Comparison

## Purpose
Compare a previously collected environment snapshot with a customer/ACI-approved
compatibility matrix. This is a generic comparison engine; it does not contain
vendor-certified versions or make certification claims.

## Matrix format (schema version 1)
A matrix is JSON with a `checks` array. Each check has a unique `id`, a dotted
JSON `field` path, and one supported operator:
- `equals`: exact value match using JSON value equality.
- `one_of`: actual value must match one value in the supplied expected array.
- `exists`: field must be present and non-empty.

A placeholder template is provided at `compatibility/example-matrix.template.json`.
It deliberately contains a placeholder expected value and is not an executable
certification profile. Replace it only with values approved by the project owner/ACI.

## Run
```sh
python3 scripts/compatibility_matrix.py environment-snapshot.json approved-matrix.json
python3 scripts/compatibility_matrix.py environment-snapshot.json approved-matrix.json --output reports/compatibility.json
```

Exit codes: 0 = all checks supported; 2 = at least one mismatch or unavailable field;
1 = invalid input, invalid matrix, or report-writing failure.

## Result semantics
- `supported`: all supplied checks match.
- `unsupported`: one or more actual values do not match the approved matrix.
- `incomplete`: no mismatches, but one or more required fields are unavailable.
- If any mismatch exists, overall status is `unsupported`, even if other checks are unavailable.

The report includes per-check actual/expected values and counts. Treat reports as
potentially sensitive because they may contain host configuration values.

## Boundaries and pending inputs
- No hardware, storage, disk, filesystem, or mount discovery is added.
- No network calls, privilege escalation, configuration changes, package installation,
  or automatic transmission of snapshot/report data.
- This comparison engine does not define MODE A/B. Their fields and semantics must
  come from the approved ACI specification before those modes are implemented.
- Exact certified OS/runtime/database/middleware versions and the authoritative matrix
  owner remain external inputs and must not be guessed.
- The current snapshot utility gathers only its documented fields. Checks for other
  components will correctly return unavailable until approved collectors provide them.
- No Jenkins/Nexus release integration is included in this epic; the planned consumer
  is the release-side Python verification utility after its interface is agreed.
