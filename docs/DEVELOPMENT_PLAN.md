# JARVIS — Development Planning Index

Use these documents as the source of truth for planning and delivery:

- [POC.md](../POC.md) — implemented repository baseline and verified capability boundaries.
- [POC2.md](../POC2.md) — prioritized remaining gaps, blockers and acceptance checklist.
- [EPICS.md](EPICS.md) — epic register, priorities, outcomes, exit gates and recommended execution order.
- [USER_STORIES.md](USER_STORIES.md) — user stories and testable acceptance criteria.

## How to update

1. Update implementation evidence in POC.md only when the source supports the claim.
2. Keep unfinished work and blockers in POC2.md.
3. Update epic/story status only with branch, commit and evidence.
4. Distinguish authored tests from executed tests and CI-verified results.
5. Keep physical Windows/Android acceptance separate from hosted CI.
6. Do not open unrelated epics until the existing epic exit gates are closed.

**Current planning baseline:** branch `new`, latest observed code checkpoint `09b45366318ed27ee109b8635d56b0448c65b3c8`, 2026-11-05. Voice lifecycle hardening is implemented; focused tests are authored but not yet executed. Overall project remains **IN PROGRESS / NOT RELEASE-READY**.
