# JARVIS — Antigravity Agent Instructions

> **Scope:** These rules apply to all Antigravity sessions within the JARVIS workspace. They supplement the security principles in README.md, POC.md, POC2.md, and docs/PERSONALIZED_JARVIS_REQUIREMENTS.md. Do not rely on an ADR path unless that file exists in the checked-out branch.

---

## 1. Routine Development Commands and Approval Boundaries

For an assigned task, use narrow, existing project commands and avoid requesting approval repeatedly for the same understood, non-destructive operation. These instructions describe agent behavior; they do **not** grant terminal permissions, override an IDE approval prompt, or authorize a command the IDE blocks. Never disable or bypass the IDE's approval controls.

An executable name alone is not a trusted rule. Do not approve arbitrary argument strings, command chains, scripts, or working directories just because they start with powershell, cmd, git, node, npm, python, or java. Prefer individual executable-and-argument approvals, constrained to this repository when the IDE supports that scope. Do not create a universal wildcard.

### 1a. Navigation and non-destructive inspection

Routine project-scoped inspection includes cd, pwd, Get-Location, dir, ls, Get-ChildItem, Get-Content, type, cat, Test-Path, Resolve-Path, Select-String, findstr, where.exe, Get-Command, and non-destructive find, grep, head, tail, or less. Use mkdir/New-Item only to create explicitly needed project files or directories. Do not infer permission to read secrets, credentials, private keys, or sensitive identity state from permission to inspect the workspace.

### 1b. Git inspection and authorized branch work

Read-only inspection may use git status, log, diff, show, branch, remote -v, rev-parse, ls-files, ls-tree, for-each-ref, merge-base, and stash list. git fetch is permitted for the requested repository when needed.

Authorized working branches are **fix**, **test**, **new**, and **enhancement**. The **dev** branch is the integration target; **main** is the protected production/release branch.

Before any Git write, inspect status and current branch, understand uncommitted work, and do not discard it. git pull is only for an understood remote and authorized branch. git add is limited to reviewed task-related files in this repository. Commits and pushes are only for explicitly requested task work on an authorized non-main branch. PRs from non-main branches target dev only.

Never automate a commit, push, or merge directly to dev. Use a PR for integration. Never automate changes or merges into main; the owner performs the eventual dev-to-main release merge manually. Keep force-push, hard reset, destructive restore/checkout, branch deletion, history rewriting, and operations that discard uncommitted work protected by explicit approval.

### 1c. Node.js, npm, and frontend development

Routine commands include node --version, node --check <reviewed-file>, npm --version, npm run, npm ls, and npm audit diagnostics. Use scripts already defined in package.json for build, test, lint/type checking, browser tests and coverage. Current scripts include npm run build, npm run lint, npm test, npm run test:browser and npm start; there is no npm run dev script. Check package.json before selecting or inventing a script.

npm ci is appropriate when the lockfile is authoritative and installation effects are understood. Install dependencies only when needed after reviewing the package and its effects. Do not auto-approve global installs, forced upgrades, untrusted packages/lifecycle scripts or destructive cleanup. Use only frameworks, bundlers and scripts present in the relevant project area.

### 1d. Python and Java development

Use the project's virtual environment when available. Routine Python commands include python --version, python3 --version, py --version, python -m pip --version, python -m pip list, python -m pytest, python -m unittest, python -m compileall <project-path>, and python -m venv .venv. Install from a reviewed requirements file only when required and within the project environment.

Only when project configuration exists, routine Java commands include java -version, javac -version, jshell --version, mvn -version, mvn test/package/verify, gradle --version, and the project's Gradle wrapper tasks. Do not auto-approve untrusted wrapper downloads, global JDK installs or system-wide Java changes.

### 1e. Tests, builds, and quality checks

Run existing unit, integration, regression, API, browser E2E, security, static analysis, type-check, lint, build and coverage commands when relevant. Batch related checks where practical without hiding failures. Do not skip failing tests, suppress errors, weaken assertions, or report success without verification.

### 1f. Windows, WSL, Linux, and project files

Routine non-destructive diagnostics may include Get-ComputerInfo, Get-CimInstance, Get-Process, Get-Service, scoped Get-WinEvent, systeminfo, tasklist, whoami, hostname, ipconfig, winget --version, wsl --status, wsl --list --verbose, uname, df, free, ps, id and command -v. Use only as needed and scope sensitive output.

Create or edit only task-related files within the approved repository. Existing project areas include src/, test/, docs/, .github/workflows/ and root-level project configuration. Treat data/ as sensitive runtime state: only use it in explicitly authorized test/CI contexts, and never overwrite, truncate, or delete audit logs, identity state, or recovery data without specific approval. Do not edit outside the repository without explicit instruction.

### 1g. Actions that remain protected

Obtain required explicit approval for destructive deletion/mass cleanup; administrator/root elevation; arbitrary remote scripts; untrusted package installation/lifecycle scripts; secret or credential access; system-wide/registry changes; firewall, service, account or security-setting changes; production deployment; irreversible data changes; and operations outside the approved project. Approval for one task does not carry over to another.

---

## 2. Preferred Command Hygiene

- Combine related checks where practical.
- Reuse results from earlier commands in the same session when still applicable.
- Prefer narrow, targeted commands over broad shell pipelines.
- Never use sudo, runas, UAC elevation or global npm installs.
- Do not use force/no-verify flags that suppress safety checks unless explicitly requested and justified.

---

## 3. Commands Requiring Explicit User Approval

Always stop and ask before:
- Destructive Git operations such as force push, hard reset, clean, branch deletion, history rewriting or discarding uncommitted work.
- Any automated write/merge to main, or direct commit/push/merge to dev. Use a PR to dev only.
- Deleting non-temporary files or directories.
- Reading .env, keys, tokens or other secrets.
- Administrator elevation or system-wide/registry/network changes.
- Publishing, production deployment, untrusted scripts or irreversible data changes.
- External service mutations outside the explicitly requested repository/branch work.

Approval for one task does not carry over to an unrelated action.

---

## 4. JARVIS Git Branch Rules (Mandatory)

- **main** — production/release branch. Never automate commits, pushes, merges or changes to main. The owner performs the final dev → main merge manually.
- **dev** — integration branch. Non-main feature/fix/test/enhancement work is proposed by PR. Do not commit or push directly to dev.
- **fix** — bug fixes and regressions.
- **test** — tests, audits, test evidence and issue tracking.
- **new** — new feature development and staged work.
- **enhancement** — broader feature enhancements.

Before any write:
1. Confirm current branch and working-tree status.
2. Understand existing changes; do not discard user work.
3. Keep commits/pushes on the authorized non-main working branch.
4. Target PRs to dev. Do not create a PR to main.

---

## 5. Task Autonomy Guidelines

For an assigned development, testing, debugging or documentation task:
1. Inspect current source, tests, branch state and relevant docs.
2. Identify the minimal safe changes.
3. Execute authorized work and run relevant tests.
4. Report exact outcomes, test/CI evidence, commit SHAs and remaining blockers.
5. Do not claim success without evidence.

Ask when a decision materially affects security controls, cryptographic invariants, credentials/audit integrity, unapproved architecture, branch/scope boundaries, cost or irreversible consequences. Resolve ordinary implementation details from existing source/docs without needless questions.

---

## 6. JARVIS Security Invariants

- **Default-deny policy gateway:** every operation requires explicit permission.
- **No arbitrary shell execution** or unsafe shell interpolation.
- **No administrator elevation.**
- **Cryptographic identity:** do not weaken Ed25519/session signing or fake it to make tests pass.
- **Single-use approvals:** approval consumption cannot be bypassed.
- **Tamper-evident audit chain:** verify integrity and fail closed when required.
- **Secret redaction:** private keys, tokens and signatures must not appear in logs, audit records or API responses.
- **Financial/payment operations excluded:** no bank, payment or trading actions.
- **Honest outcomes:** command acknowledgement is not proof of application success.
- **Privacy and platform boundaries:** no security bypass, silent sideloading, or voice-only authorization for high-risk actions.

No agent instruction, test convenience or CI shortcut may override these invariants.

---

## 7. IDE Permission Configuration Is Separate

AGENTS.md is behavioral guidance, not an IDE permission file. Editing it cannot persist terminal approvals, suppress an IDE prompt, or override a higher-priority security policy. Do not claim a permission is configured until the IDE confirms it.

When an IDE supports per-command persistent approvals, keep execution in review mode and allow only individual, understood routine commands scoped to this repository. Do not select a global always-proceed mode or allow unrestricted shell commands. If no per-command approval control exists, leave the security mode unchanged and use the required approval prompt.

This workspace instruction does not configure VS Code's separate terminal auto-approval setting or any user-level IDE setting. Those must be reviewed in their own supported settings surface.

---

*Last updated: 2026-10-24. Keep this file aligned with the README, POC, POC2 and personalized requirements. Do not reference non-existent ADR paths as authoritative.*
