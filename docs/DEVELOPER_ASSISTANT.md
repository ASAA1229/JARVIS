# JARVIS Developer Assistant (JARVIS-US-063)

Status: implemented, not yet tested (testing paused by the owner).

The developer assistant works only on repositories you explicitly connect, and only within the scopes you grant. Every request goes through the normal JARVIS path: planner → policy gateway (owner device, `DEVICE_MANAGE`) → approval where required → audit.

## Scopes

| Scope | Allows |
|---|---|
| `read` (always granted) | file tree, bounded file read, text search, git status / log / diff, PR draft text |
| `suggest` | model-generated explanations and draft change suggestions |
| `git-write` | apply a reviewed suggestion to the working tree, create a branch, commit, push a feature branch |
| `ci` | read recent CI runs (needs the GitHub CLI, `gh`, signed in) |

## Phrases

| Say or type | Operation | Approval |
|---|---|---|
| `connect repo portfolio at C:\path\to\pixel-perfect-pixel with scopes read, suggest, git-write` | connect | yes |
| `disconnect repo portfolio` | disconnect | yes |
| `list repos` | list | no |
| `show files of portfolio` · `show file src/server.ts in portfolio` · `search "RESUME_BUCKET" in portfolio` | read | no |
| `git status of portfolio` · `git log of portfolio` · `show changes in portfolio` | read | no |
| `explain src/server.ts in portfolio: how is admin auth checked?` | explain (draft) | no |
| `suggest a fix for src/lib/seo.ts in portfolio: escape the title` | draft diff | no |
| `list suggestions for portfolio` | list drafts | no |
| `apply suggestion <id> in portfolio` | apply to working tree (not committed) | yes |
| `create branch feature/seo-fix in portfolio` | branch | yes |
| `commit to portfolio: fix SEO title escaping` · `commit suggestion <id> to portfolio: …` | commit | yes |
| `push portfolio` | push current feature branch | yes |
| `draft a pr for portfolio: SEO title fix` | PR text targeting `dev` (not opened) | no |
| `ci status of portfolio` | CI runs | no |

## Safety rules (enforced in code)

- **Branches:** `main`, `master`, `dev`, `production` and `release` cannot be committed to or pushed. Work happens on feature branches, and PR drafts always target `dev`. There is no force push.
- **Protected paths:** `.env*`, keys and certificates, `.npmrc`, credential files, `data/`, `node_modules/`, `.git/` and `.local-storage/` are never listed, read, searched, sent to a model, patched or committed.
- **Secrets:** API keys, tokens, JWTs, private keys and `password=`/`token:` style assignments are redacted from file excerpts, model prompts, model output, diffs, git output and PR drafts. A commit message that contains a secret is refused.
- **Suggestions are drafts:**
  - The model never applies, commits or pushes anything.
  - Applying a suggestion changes only the working tree. The result is confirmed by `git status`.
  - A commit is confirmed by `git rev-parse HEAD`. A push is confirmed by checking that `origin/<branch>` equals `HEAD`; a mismatch is reported as uncertain.
- **Git commands:** git always runs with a fixed argument array (`git -C <repo> …`), never through a shell.
- **Model:** the configured JARVIS model is used, local by default. If none is configured, the assistant says so instead of inventing an answer.

## State files

The assistant keeps two files next to the other JARVIS state files: `<state>.developer.repos.json` for connections and `<state>.developer.suggestions.json` for the last 100 suggestions. The default `<state>` is `./data/developer`.

## Not yet done

- **Testing:** unit, integration and scratch-repo end-to-end testing.
- **Opening PRs remotely:** draft text only for now.
- **CI actions:** only read-only status today. Re-running workflows would need its own approval rule.
- **HUD panel:** there's no dedicated panel for suggestions yet; results appear in the normal task feed.
