# hooks/

Canonical source of Claude Code hook scripts shipped by this repo.

## Why this directory exists

Phase 3b (RFC-002) introduces user-level hooks that need to be installed into `~/.claude/hooks/`. Without a versioned source path in the repo, install-time changes can't be code-reviewed, tested, or rolled back. Codex review of the Phase 3b plan flagged this gap; the directory closes it.

## Conventions

- **One hook per file.** Each script handles a single hook event (PreToolUse, SessionStart, etc.).
- **POSIX bash + jq + grep.** No Node, no other runtime dependencies.
- **`set -e` and JSON via stdin.** Claude Code passes hook input as JSON on stdin; emit a `{"decision": "block", "reason": "..."}` JSON to block.
- **Test against the repo source.** Tests in `tests/test-*.sh` invoke `$REPO/hooks/<name>.sh` directly with a temp `cwd` and `HOME`, not the installed copy at `~/.claude/hooks/`. This means PR diffs verify the actual checked-in hook content, not whatever a maintainer happened to install locally. Exception: hook *composition* tests must reference an installed peer hook (e.g. `plan-gate.sh`), since that hook is currently user-maintained outside this repo. Such tests gracefully skip if the peer is absent.

## Files

| Hook | Event | Purpose |
|------|-------|---------|
| `checkpoint-gate.sh` | PreToolUse | RFC-002 Phase 3b two-gate write/push enforcement |
| `em-recall-sessionstart.sh` | SessionStart | Mechanically invokes em-recall so its activator can arm checkpoint-gate before any user interaction |

## Installation

`install.mjs --install-hooks` (when extended in PR-B per #59) copies these files into `~/.claude/hooks/`, registers them in `~/.claude/settings.json`, and chmods them executable. Until that lands, manual install is required for the runtime gate to actually fire.

## Editing rules

**Edit here, not the installed copy.** `install.mjs` overwrites `~/.claude/hooks/*.sh` on each `--install-hooks` run (with conservative skip-on-modified once #59 PR-B lands). Changes made directly to `~/.claude/hooks/` will be lost on the next install.

## Related

- RFC-002 Phase 3b spec: `docs/rfcs/RFC-002-learning-loop.md`
- Tracking issue: #59
