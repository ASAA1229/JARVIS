# JARVIS Pending Work and Epic Reconciliation Register

**Updated:** 2026-11-19 | **Branch:** `new` | **Planning only**

## Carried-forward pending work
- Re-run exact-head CI after Live DAG hardening; do not treat local test results as CI verification.
- Complete physical MSI Windows microphone, STT, wake-word and Notepad automation acceptance.
- Complete per-device session and QR/authenticator flows on both target Android phones.
- Measure physical false-accept/false-reject voice rates and validate offline/local-cloud separation on target devices.
- Resolve environment-sensitive real-Notepad E2E behavior; retain the failure history and exact test evidence.
- Build an owner-labelled real retrieval corpus and approve evaluation thresholds.
- Verify Jenkins/Nexus only with authorized live infrastructure, credentials and explicit approval.
- Complete operational owner acceptance, recovery exercises and release gates.

## Cross-project candidate work from Sets 1–12
Map applicable requirements for shared architecture and integrations; data ownership/privacy/retention/recovery; security and AI-agent safety; CI/CD and artifact provenance; and complete quality engineering including device, voice, offline, security, regression and acceptance testing.

All answers were “all of the above”; these are candidate requirements, not implementation evidence or delivery commitments. Reconcile them to existing JARVIS epic IDs and stories, identify duplicates/conflicts, assign owners/dependencies, define measurable acceptance criteria and attach evidence. Preserve the current local/test/integration/acceptance distinctions.

Master Requirements Baseline v1.0 remains unchanged. Documentation only: no code, tests, deployment, merge, paid services or release are authorized.


## Organization verification update — 2026-11-20

- Re-run and record CI on `dev` and `main`; the current organization audit found no workflow runs for those branches, so they remain NOT TESTED.
- Apply and verify branch protection and required checks on `main`, `dev`, `new`, `fix`, and `test`.
- Complete physical Windows 11 laptop and Android-device testing for wake word, voice commands, pairing, QR/authenticator, session isolation, privacy, offline/local operation and recovery.
- Validate hybrid local/cloud routing and confirm no continuous cloud audio upload under the approved privacy design.
- Verify Jenkins integration with an approved live endpoint, and test artifact publishing, retrieval, integrity, rollback and recovery; mock/fake-server tests are not live integration evidence.
- Complete owner acceptance, security/privacy review and release operations evidence. Current state remains NO-GO / NOT ACCEPTED.

No implementation, device test, deployment, merge or promotion was performed by this documentation refresh.
