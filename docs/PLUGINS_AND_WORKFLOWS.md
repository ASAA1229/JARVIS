# Plugins and Workflows (JARVIS-US-062)

## Workflows

A workflow is a versioned template of steps (`operation`, `parameters`, `dependsOn`).
Running one never bypasses security: `workflow:run` only **expands** the template into
the current task, and each step is then planned-allowlisted, evaluated by the policy
gateway, approved when it changes anything, checkpointed, cancellable and recoverable,
exactly like any other multi-step request.

| Say | Operation | Approval |
|---|---|---|
| `list workflows` | `workflow:list` | no |
| `show workflow <name>` / `workflow history <name>` | `workflow:show` / `workflow:history` | no |
| `run workflow <name>` | `workflow:run` (then each step) | per step |
| `create workflow <name>: <step>; <step>; …` (or `then`) | `workflow:create` | yes |
| `draft workflow <name>: <goal>` | `workflow:draft_ai` (local-first model, advisory draft) | no — draft cannot run |
| `approve workflow draft <name>` | `workflow:approve_draft` | yes |
| `archive workflow <name>` | `workflow:archive` | yes |
| `schedule workflow <name> every N minutes/hours` | `schedule:create` → re-plans `run workflow <name>` each time | yes |

Rules:
- 1–20 steps; unique step ids; dependencies must exist and be acyclic (deterministic order).
- Steps must be operations allowlisted by **both** the planner and the policy gateway, with allowed parameter keys.
- Workflows cannot contain `workflow:*` or `plugin:*` steps (no recursion, no self-escalation).
- Every change appends a version; history is never rewritten (`workflow history <name>`).
- Built-ins: `morning-brief` (read-only status + schedules), `open-dev-workspace` (two app launches + repo list).
- AI drafts record mapping problems; a draft with problems cannot be approved.

State: `<statePath>.workflows.json` (default `data/workflows.json`).

## Plugins

Plugins are **data-only** manifests — no executable code, no shell. They declare what
they relate to and which operations they need, and may contribute workflow templates.

```json
{
  "id": "example.focus-tools",
  "name": "Focus tools",
  "version": "1.0.0",
  "publisher": "Owner",
  "description": "Opens the editor and shows battery status.",
  "compatibility": { "minJarvisVersion": "0.1.0" },
  "capabilities": ["automation.workflows"],
  "permissions": ["app:launch", "system:get_battery_status"],
  "workflows": [
    { "name": "focus-start", "description": "Editor + battery",
      "steps": [
        { "id": "editor", "operation": "app:launch", "parameters": { "appId": "Visual Studio Code" }, "dependsOn": [] },
        { "id": "battery", "operation": "system:get_battery_status", "parameters": {}, "dependsOn": ["editor"] }
      ] }
  ]
}
```

Lifecycle:
1. `install plugin from C:\path\manifest.json` — approval; validated; installed **disabled with no grants**.
2. `grant plugin <id> app:launch system:get_battery_status` — approval; only requested permissions.
3. `enable plugin <id>` — approval; registers templates whose steps are all granted.
4. `revoke plugin <id> <perm>` / `disable plugin <id>` — immediate; plugin workflows fail closed or are archived.
5. `uninstall plugin <id>` — approval; archives its workflows.

Fail-closed checks: unknown fields; non-semver versions; newer `minJarvisVersion`; capabilities
missing from the catalogue or restricted; permissions that are not allowlisted, or are
never grantable (`device:*`, `security:*`, `plugin:*`, `workflow:*`, `memory:delete/update`,
`terminal:*`, `file:delete/restore`, `dev:push/commit/repo_connect`, `comms:handoff_email`);
template steps outside the requested permissions or policy parameter allowlists. Manifests are
re-validated on every load; an invalid one is kept disabled with no grants. Upgrades require a
higher version, start disabled and keep only still-requested grants.

State: `<statePath>.plugins.json` (default `data/plugins.json`).

## Not yet built
- Visual workflow composer (workflows are created by phrase or plugin manifest).
- HUD panel for plugins/workflows (use the request box).
