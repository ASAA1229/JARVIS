# Git worktree workflow

## Current inventory

As of 2026-10-23, Git reports one checkout: branch `new`, commit
`542692b515b12fa2a2a536c0a34a3d8e4b02123a`. The tracked
`.worktrees/milestone-9` submodule entry has a pre-existing local deletion.
That deletion is preserved. Its former worktree is not present in
`git worktree list`; do not recreate it or update the gitlink as part of routine
worktree setup.

## Create an approved milestone workspace

First check the repository root, current branch, status, refs, and worktrees:

```powershell
git status --short
git branch -avv
git worktree list --porcelain
```

Only provision a worktree after its approved specification exists, its target
branch is authorized by `AGENTS.md`, and no existing path/branch will be reused.
The repository currently authorizes `test`, `fix`, and `new` as working
branches; this may prevent multiple simultaneous milestone branches. Do not
invent branch names or attach multiple checkouts to one branch to work around
that rule. Record a clear blocker and work in the current authorized checkout
when appropriate.

Example after authorization and an available branch name:

```powershell
git worktree add ..\JARVIS-M<N> <authorized-branch>
git worktree list --porcelain
```

Do not create an M8, M10, or M11 worktree while its approved scope is missing.
Do not create a replacement M9 checkout while the pre-existing deletion is
unresolved.

## Inspect and integrate

Use `git worktree list --porcelain`, `git -C <path> status --short`, and
`git -C <path> log -1 --oneline` to inspect each checkout. Keep generated
builds and runtime state isolated. Integrate reviewed feature work through a
PR into `dev`; never commit, merge, or push to `main`, and do not directly
write to `dev`.

## Safe removal

Before removal, confirm the exact path and branch, then check both the worktree
and branch for uncommitted or unmerged work:

```powershell
git worktree list --porcelain
git -C <exact-path> status --short
git -C <exact-path> diff --stat
git -C <exact-path> diff --cached --stat
```

If any changes exist, stop and preserve them. After a human reviews and backs
up or integrates the work, remove only the confirmed path with
`git worktree remove <exact-path>` (without `--force`), then verify the
inventory again. Removing a worktree does not authorize deleting its branch or
changing a submodule gitlink.
