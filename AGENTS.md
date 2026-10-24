# JARVIS — Antigravity Agent Instructions

> **Scope:** These rules apply to all Antigravity sessions within the JARVIS workspace.
> They extend — and never weaken — the security invariants defined in
> `docs/adr/ADR-002-security-invariants.md` and the README security principles.

---

## 1. Routine Development Commands and Approval Boundaries

For an assigned task, use narrow, existing project commands and avoid requesting
approval repeatedly for the same understood, non-destructive operation. These
instructions describe agent behavior; they do **not** grant terminal permissions,
override an IDE approval prompt, or authorize a command the IDE blocks. Never
disable or bypass the IDE's approval controls.

An executable name alone is not a trusted rule. In particular, do not approve
arbitrary argument strings, command chains, scripts, or working directories just
because they start with `powershell`, `cmd`, `git`, `node`, `npm`, `python`, or
`java`. Prefer individual executable-and-argument approvals, constrained to this
repository when the IDE supports that scope. Do not create a universal wildcard.

### 1a. Navigation and non-destructive inspection

Routine project-scoped inspection includes `cd`, `pwd`, `Get-Location`, `dir`,
`ls`, `Get-ChildItem` (including `-Force`), `Get-Content`, `type`, `cat`,
`Test-Path`, `Resolve-Path`, `Select-String`, `findstr`, `where.exe`,
`Get-Command`, and non-destructive `find`, `grep`, `head`, `tail`, or `less`.
Use `mkdir` or `New-Item` only to create explicitly needed project files or
directories. Do not infer permission to read secrets, credentials, private keys,
or sensitive identity state from permission to inspect the workspace.

### 1b. Git inspection and authorized branch work

Read-only development inspection may use `git status`, `git log`, `git diff`,
`git show`, `git branch`, `git remote -v`, `git rev-parse`, `git ls-files`,
`git ls-tree`, `git for-each-ref`, `git merge-base`, and `git stash list`.
`git fetch` is permitted for the requested repository when needed.

The authorized working branches are **`test`**, **`fix`**, and **`new`**.
Before any Git write, inspect `git status` and the current branch; understand
existing uncommitted work and do not discard it. `git pull` is only for an
understood remote and authorized branch. `git add` is limited to reviewed,
task-related files inside this repository. Commits and pushes are only for explicitly requested task work on the owning
authorized branch. A pull request may target `dev` when explicitly requested or
required by the task and project policy.

Never automate a commit, push, merge, or pull request directly to `main` or a
direct commit/push to `dev`. Keep `git push --force`, `git reset --hard`,
destructive restore/checkout, branch deletion, history rewriting, and any
operation that discards uncommitted work protected by explicit approval.

### 1c. Node.js, npm, and frontend development

Routine commands include `node --version`, `node --check <reviewed-file>`,
`npm --version`, `npm run` (to inspect scripts), `npm ls`, and `npm audit`
(diagnostics). Use scripts already defined in `package.json` for build, test,
lint, type checking, development servers, component/UI tests, browser E2E tests,
and coverage. In this repository the existing scripts include `npm run build`,
`npm run lint`, `npm test`, and `npm start`; there is currently no `npm run dev`
script. Check `package.json` before selecting or inventing a script.

`npm ci` is appropriate when the repository lockfile is authoritative and
installation effects are understood. Install a project dependency only when
needed, after reviewing the package and its effects. Do not auto-approve global
installs, forced upgrades, untrusted packages or lifecycle scripts, or
destructive cleanup. For React or another frontend stack, use only the
framework, bundler, and scripts already present in the relevant project area.

### 1d. Python and Java development

Use the project's virtual environment when available. Routine Python commands
include `python --version`, `python3 --version`, `py --version`,
`python -m pip --version`, `python -m pip list`, `python -m pip show <package>`,
`python -m pytest`, `python -m unittest`, `python -m compileall <project-path>`,
and `python -m venv .venv`. Install from a reviewed `requirements.txt` only
when required and within the project environment.

Only when the corresponding project configuration exists, routine Java commands
include `java -version`, `javac -version`, `jshell --version`, `mvn -version`,
`mvn test`, `mvn package`, `mvn verify`, `gradle --version`,
`gradlew test`, or `.\gradlew.bat test`, plus existing project build/test tasks.
Do not auto-approve untrusted wrapper downloads, global JDK installs, or
system-wide Java changes.

### 1e. Tests, builds, and quality checks

Run existing unit, integration, regression, API, browser E2E, security, static
analysis, type-check, lint, build, and coverage commands when they are relevant
to the task. Batch related checks where practical without hiding individual
failures. Do not skip failing tests, suppress errors, weaken assertions, or
report success without verification.

### 1f. Windows, WSL, Linux, and project files

Routine non-destructive diagnostics may include `Get-ComputerInfo`,
`Get-CimInstance`, `Get-Process`, `Get-Service`, `Get-ChildItem Env:`,
`Get-PSDrive`, `Get-Volume`, `Get-NetAdapter`, scoped read-only `Get-WinEvent`,
`systeminfo`, `tasklist`, `whoami`, `hostname`, `ipconfig`, `winget --version`,
`wsl --status`, `wsl --list --verbose`, `wsl -l -v`, and Unix/WSL `uname`,
`df`, `free`, `ps`, `id`, and `command -v`. Use only as needed; a diagnostic
command may still expose sensitive information and should be scoped accordingly.

Create or edit only task-related files within the approved repository. Existing
project areas include `src/`, `test/`, `docs/`, `.github/workflows/`, and
root-level project configuration. Treat `data/` as sensitive runtime state:
only use it in explicitly authorized test/CI contexts, and never overwrite,
truncate, or delete audit logs, identity state, or recovery data without
specific approval. Do not edit outside the repository without explicit
instruction.

### 1g. Actions that remain protected

Obtain the required explicit approval for destructive deletion or mass cleanup;
administrator/root elevation; arbitrary remote scripts; untrusted package
installation or lifecycle scripts; secret or credential access; system-wide or
registry changes; firewall, service, user-account, or security-setting changes;
publishing or production deployment; irreversible database/data changes; and
operations outside the approved project. Approval for one task does not carry
over to another.

Do **not** edit files outside the workspace without explicit instruction.

---

## 2. Preferred Command Hygiene

- **Combine related checks** into a single invocation where practical (e.g., run
  build, lint, and test together rather than three separate approval events).
- **Reuse the result** of an earlier command in the same session rather than
  re-running it and prompting again.
- **Prefer narrow, targeted commands** over broad shell pipelines.
- **Never use `sudo`, `runas`, or UAC elevation** for any command.
- Do not install packages globally (`npm install -g`).
- Do not use `--force`, `--no-verify`, or flags that suppress safety checks unless
  the user has explicitly requested and justified them.

---

## 3. Commands Requiring Explicit User Approval

**Always stop and ask** before executing any of the following, regardless of context:

| Category | Examples |
| --- | --- |
| Destructive Git operations | `git push --force`, `git reset --hard`, `git clean -fd`, `git branch -D`, history rewriting, discarding uncommitted work |
| Production/integration branch writes | Any automated write to **`main`**; direct commit, push, or merge to **`dev`**. A PR to `dev` is allowed only as stated in Section 4. |
| File deletion | `rm -rf`, `Remove-Item -Recurse -Force` on non-temporary paths |
| Credential / secret access | Reading `.env`, key files, tokens, or anything resembling a secret |
| Administrator elevation | UAC prompts, `sudo`, `runas`, `Set-ExecutionPolicy` |
| System-wide changes | Global npm installs, registry edits, firewall/network changes |
| Publishing / deploying | Pushing Docker images, publishing npm packages, deploying to any environment |
| Untrusted scripts | Running downloaded scripts, `curl | sh`, or pipelines from external sources |
| External service mutations | API calls that change external state (GitHub settings, cloud resources, etc.) |
| Irreversible data changes | Truncating, overwriting, or deleting audit logs or identity state files |

A previous approval for one task does **not** carry over to an unrelated action,
even within the same session.

---

## 4. JARVIS Git Branch Rules (Mandatory — Never Override)

```
main   → PRODUCTION RELEASE. Never commit, push, merge, create automated PRs,
          or touch this branch programmatically under any circumstances.

dev    → INTEGRATION. Accepts pull requests from fix / test / new only.
          Do not commit directly to dev. Merges require human review.

fix    → Bug fixes and regression tests. Primary implementation branch for
          Milestone 7 remediation work.

test   → Security audits, test cases, test evidence, coverage reports, and
          traceability matrices. No production implementation changes here.

new    → New feature development work.
```

**Before any write operation:**

1. Run `git status` and `git branch` to confirm the current branch.
2. Confirm the working tree is clean or that any uncommitted work is understood.
3. Never switch branches silently; state the branch switch in the response.
4. Never force-push, reset, or cherry-pick in a way that discards user commits.

---

## 5. Task Autonomy Guidelines

When the user assigns a development, testing, debugging, or documentation task:

1. **Inspect first** — read current source, test output, and relevant docs before
   acting.
2. **Plan** — identify the minimal safe set of changes needed.
3. **Execute** — make changes, run tests, and verify results without stopping for
   routine approvals.
4. **Report** — summarise exact outcomes (pass/fail counts, commit SHAs, CI links,
   remaining blockers). Never claim success without evidence.
5. **Leave a clean state** — commit only what was changed, leave the working tree
   clean, and document open issues.

**Do not ask** about ordinary implementation details that can be resolved from the
existing project documentation, README, or ADRs.

**Do ask** when a decision materially affects:

- Security controls or cryptographic invariants.
- Production data, user credentials, or audit-chain integrity.
- Architecture choices not covered by existing ADRs.
- An action that would exceed the approved branch/scope boundaries.
- A cost or irreversible consequence.

---

## 6. JARVIS Security Invariants (Summary — Always Enforce)

These invariants are defined in full in `docs/adr/ADR-002-security-invariants.md`
and must never be weakened by agent instructions:

- **Default-deny policy gateway** — every operation requires explicit permission.
- **No shell interpolation or arbitrary command execution** in source code.
- **No administrator elevation** — fail closed if elevation is required.
- **Cryptographic identity** — Ed25519 key validation and session signing cannot
  be weakened or mocked to make tests pass.
- **Single-use approvals** — approval consumption cannot be bypassed.
- **Tamper-evident audit chain** — hash chain integrity must be verified.
- **Secret redaction** — private keys, tokens, and signatures must never appear
  in logs, audit records, or API responses.
- **Financial operations excluded** — no bank, payment, or trading actions.

No agent instruction, test convenience, or CI shortcut may override these invariants.

---

## 7. IDE Permission Configuration Is Separate

`AGENTS.md` is behavioral guidance, not an IDE permission file. Editing it cannot
persist terminal approvals, suppress an IDE prompt, or override a higher-priority
security policy. Do not claim a permission is configured until the IDE confirms
it.

When using an Antigravity build that supports per-command persistent approvals,
open its Settings and find **Agent > Terminal Command Auto Execution**. Keep
execution in review mode; use **Allow Always** only for an individual, understood
routine command when the UI offers that choice. Prefer exact command patterns
scoped to this repository. Do not select a global **Always Proceed** mode or
allow an unrestricted shell command. If the installed build has no per-command
approval control, leave its security mode unchanged and request the required
approval in the UI.

This workspace instruction does not configure VS Code's separate
`chat.tools.terminal.autoApprove` setting or any Antigravity user-level setting.
Those must be reviewed and changed in their own supported settings surface.

---

*Last updated: 2026-10-23. Maintained alongside the JARVIS POC codebase.*
*This file must be kept in sync with `docs/adr/ADR-002-security-invariants.md` and the README security principles.*
