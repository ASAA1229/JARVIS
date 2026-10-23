# Milestone dependency map

This map records integration dependencies visible in the current architecture;
it does not define missing product scope. Resolve approved milestone
specifications before implementation.

```mermaid
flowchart TD
  M1[M1 foundation] --> M2[M2 secure Windows core]
  M2 --> M4[M4 approvals and task lifecycle]
  M2 --> M5[M5 AI planner boundary]
  M4 --> M6[M6 verification and hardening]
  M6 --> M7[M7 security remediation]
  M2 --> M3[M3 Android enrollment and channel]
  M3 --> M9[M9 Android companion integration]
  M7 --> M9
  M7 --> M8[M8 approved scope required]
  M8 -. specification required .-> M10[M10 scope unknown]
  M10 -. specification required .-> M11[M11 scope unknown]
  M7 --> M12[M12 gesture HUD foundation]
  M12 -. future arbitration contract required .-> M4
```

M12 currently ends at local HUD proposal/preview and does not feed the shared
command router or policy gateway. Any future action integration must depend on
the existing authentication, policy, approval, and audit contracts. M8, M10,
and M11 edges are placeholders for planning only; no scope is inferred.

## Integration rules

- Shared identity, policy, approval, command routing, API contracts, and audit
  foundations have a single implementation owner in the integration path.
- Feature work is reviewed on an authorized working branch and integrated into
  `dev` only through the repository's reviewed PR process.
- `main` remains human-controlled. Worktree existence is not milestone evidence.
