# Milestone registry

Statuses below reflect repository evidence checked on 2026-10-23. A historical
report can support a status only for the exact source and checks it identifies.
Creating a branch or worktree never completes a milestone.

| Milestone | Status | Evidence and remaining gate |
|---|---|---|
| M1 — Foundation & project setup | PASS | Historical acceptance audit on `fix`; current M12 build/lint also pass, but this does not retest every M1 criterion. |
| M2 — Secure Windows core | PARTIAL | Historical audit: policy and read-only checks covered; real Notepad runtime/visible-window acceptance incomplete. |
| M3 — Android enrollment & channel | BLOCKED | Physical Android, trusted transport, Keystore, and two-device acceptance unavailable. |
| M4 — Approval & task lifecycle | PARTIAL | Historical test evidence exists; concurrent interruption used a mock adapter. |
| M5 — AI planner integration | PARTIAL | Planner boundary tests exist; broad intent quality and external provider behavior are not established. |
| M6 — Verification, hardening & release | PARTIAL | Historical local tests exist; Linux/WSL and performance evidence remain incomplete. |
| M7 — Security remediation & completion | BLOCKED | Exact-source hosted CI, target-owner device, physical microphone, Android, and other acceptance gates remain. |
| M8 — Approved scope not located | UNVERIFIED | Current checkout and inspected `origin/new`/`origin/lovable` trees did not expose an approved specification or decision records. Do not infer scope. |
| M9 — Android companion | PARTIAL | Historical audit describes an isolated prototype. Its submodule checkout is currently absent due to a pre-existing working-tree deletion; do not recreate or claim current inspection. Android build/device integration remains blocked. |
| M10 — Approved scope not located | UNVERIFIED | No authoritative specification found in the current docs or inspected branch trees. |
| M11 — Approved scope not located | UNVERIFIED | No authoritative specification found in the current docs or inspected branch trees. |
| M12 — Gesture & spatial interaction | PARTIAL | Local camera/tracking and HUD-only previews committed as `542692b`; unit/browser automation passed with simulated camera input. Physical precision, target-device latency, and integrated arbitration/actions remain unverified. |

## M12 completion boundary

M12 currently implements opt-in video-only camera access, same-origin local
MediaPipe inference, visible camera state, lifecycle cleanup, a HUD target
allowlist, and proposal-only gesture feedback. Gestures cannot invoke backend
operations. See the [M12 scope](../m12-gesture-spatial-interaction.md),
[manual acceptance checklist](../m12-gesture-manual-verification.md), and
[ADR-006](../adr/ADR-006-local-gesture-tracking.md).

## Adding future milestones

Create a specification from [the template](template.md) only after the owner
approves the scope. Add its prerequisites to the [dependency map](dependency-map.md)
and add a registry row with one of PASS, PARTIAL, BLOCKED, UNVERIFIED, or FAIL.
Record implementation, test evidence, and external gates before changing status.
