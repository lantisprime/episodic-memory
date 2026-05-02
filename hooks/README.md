# hooks/

Canonical source of Claude Code hook scripts shipped by this repo.

## Why this directory exists

Phase 3b (RFC-002) introduces user-level hooks that need to be installed into `~/.claude/hooks/`. Without a versioned source path in the repo, install-time changes can't be code-reviewed, tested, or rolled back. Codex review of the Phase 3b plan flagged this gap; the directory closes it.

## Conventions

- **One hook per file.** Each script handles a single hook event (PreToolUse, SessionStart, etc.).
- **Hooks are bash + jq + grep.** Some hooks (e.g. `em-recall-sessionstart.sh`) delegate to Node scripts living elsewhere; the hook *script itself* stays bash so install + diagnosis don't depend on Node being available before any tool runs.
- **`set -e` and JSON via stdin.** Claude Code passes hook input as JSON on stdin; emit a `{"decision": "block", "reason": "..."}` JSON to block.
- **Test against the repo source.** Tests in `tests/test-*.sh` invoke `$REPO/hooks/<name>.sh` directly with a temp `cwd` and `HOME`, not the installed copy at `~/.claude/hooks/`. This means PR diffs verify the actual checked-in hook content, not whatever a maintainer happened to install locally. Exception: hook *composition* tests must reference an installed peer hook (e.g. `plan-gate.sh`), since that hook is currently user-maintained outside this repo. Such tests gracefully skip if the peer is absent.

## Files

| Hook | Event | Purpose |
|------|-------|---------|
| `checkpoint-gate.sh` | PreToolUse | RFC-002 Phase 3b two-gate write/push enforcement |
| `em-recall-sessionstart.sh` | SessionStart | Mechanically invokes em-recall so its activator can arm checkpoint-gate before any user interaction |

## Installation

Until PR-B (per #59) lands its conservative installer, users must install hooks manually. The PR-B `install.mjs --install-hooks` will:

- Compare each repo file against the user-installed copy at `~/.claude/hooks/`
- **Skip with a warning** when they differ (preserving local edits)
- Only overwrite under explicit `--install-hooks-force`
- Register hooks in `~/.claude/settings.json` and chmod them executable

## Editing rules

**Edit here as the canonical source**, but local edits to `~/.claude/hooks/*.sh` are also fine in the meantime — PR-B's installer will diff them against the repo source rather than silently overwriting. If you choose to edit the installed copy directly, expect to either re-apply that edit here on next sync or use `--install-hooks-force` to overwrite when you're done.

## Related

- RFC-002 Phase 3b spec: `docs/rfcs/RFC-002-learning-loop.md`
- Tracking issue: #59
