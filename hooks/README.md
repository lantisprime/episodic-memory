# hooks/

Canonical source of Claude Code hook scripts shipped by this repo.

## Why this directory exists

Phase 3b (RFC-002) introduces user-level hooks that need to be installed into `~/.claude/hooks/`. Without a versioned source path in the repo, install-time changes can't be code-reviewed, tested, or rolled back. Codex review of the Phase 3b plan flagged this gap; the directory closes it.

## Conventions

- **One hook per file.** Each script handles a single hook event (PreToolUse, SessionStart, etc.).
- **Hooks are bash + jq + grep.** Some hooks (e.g. `em-recall-sessionstart.sh`) delegate to Node scripts living elsewhere; the hook *script itself* stays bash so install + diagnosis don't depend on Node being available before any tool runs.
- **`set -e` and JSON via stdin.** Claude Code passes hook input as JSON on stdin; emit a `{"decision": "block", "reason": "..."}` JSON to block.
- **Test against the repo source.** Tests in `tests/test-*.sh` invoke `$REPO/hooks/<name>.sh` directly with a temp `cwd` and `HOME`, not the installed copy at `~/.claude/hooks/`. This means PR diffs verify the actual checked-in hook content, not whatever a maintainer happened to install locally.

## Files

| Hook | Event | Purpose |
|------|-------|---------|
| `checkpoint-gate.sh` | PreToolUse | RFC-002 Phase 3b two-gate write/push enforcement |
| `plan-gate.sh` | PreToolUse | Blocks write tools while `.plan-approval-pending` exists at the repo root; allows read-only tools (canonical list lives in the `case` at `hooks/plan-gate.sh` — do not duplicate here). Issue #86 PR-A canonicalized this from a previously user-maintained file. |
| `em-recall-sessionstart.sh` | SessionStart | Mechanically invokes em-recall so its activator can arm checkpoint-gate before any user interaction |
| `stop-gate.sh` | Stop / SubagentStop | Blocks turn-end when post-checkpoint required but absent (#128). |
| `lib/marker-paths.sh` | sourced | Shared marker-path constants and dual-root helpers (2026-05-09 .checkpoints/ migration) |
| `lib/repo-root.sh` | sourced | `resolve_repo_root` git-common-dir walker (PR #105 / #85) |
| `lib/command-classifier.sh` | sourced | Quote/heredoc-aware Bash classifier (#86 PR-B / #89 / #101) |

## Marker storage (.checkpoints/ migration, 2026-05-09)

Marker WRITES land at `<repo-root>/.checkpoints/.X` (PRIMARY); reads check
PRIMARY first then fall back to `<repo-root>/.claude/.X` (LEGACY) until the
fallback branch is removed. CLEANUP sweeps BOTH roots until then. Migration
exists because Claude Code's built-in sensitive-file guard prompts on every
Write to a `.X` basename inside any `.claude/` segment, regardless of
allowlist. See `tools/migration-cutover.mjs` and `tools/migration-sweep.mjs`
for the install-parity check and burn-in exit gate that protect the
fallback-removal commit.

## Installation

`install.mjs --install-hooks` (PR-B per #59 + PR-A per #86):

- Compares each repo file against the user-installed copy at `~/.claude/hooks/`
- **Skips with a warning** when they differ (preserving local edits) AND withholds new settings registration unless a prior canonical registration exists
- Only overwrites under explicit `--install-hooks-force`
- Registers hooks in `~/.claude/settings.json` (atomic temp+rename) and chmods them executable
- Surfaces stale-canonical-named entries (same basename, different path) as warnings without auto-removing them

## Bash command-level allowlisting (deferred to PR-B per issue #86)

`plan-gate.sh` currently blocks **all** Bash invocations while the marker is set, even read-only ones (`ls`, `grep`, `cat`, etc.). PR-A canonicalizes the hook + adds the missing read-only tool-name allowlist entries (`NotebookRead`, `ToolSearch`); strict per-command Bash allowlisting is the scope of a follow-up PR-B.

## Editing rules

**Edit here as the canonical source**, but local edits to `~/.claude/hooks/*.sh` are also fine in the meantime — PR-B's installer will diff them against the repo source rather than silently overwriting. If you choose to edit the installed copy directly, expect to either re-apply that edit here on next sync or use `--install-hooks-force` to overwrite when you're done.

## macOS `com.apple.provenance` xattr — recovery from undeletable marker

On macOS Sequoia (Darwin 25+) with App Management or an EDR agent, files written by Claude Code's Write tool inherit `com.apple.provenance` and can become **undeletable** — `sudo rm` returns `EPERM` ("Operation not permitted") even with full disk access. If a marker file (`.plan-approval-pending`, `.checkpoint-required`, `.pre-checkpoint-done`, etc.) gets stuck in this state, the gate hooks fire on every turn-end with no escape from inside the agent.

**Escape hatch** (run from a terminal, NOT from the agent):

```sh
# Temporarily disable the hooks so the gate doesn't fire while you triage:
sudo mv ~/.claude/hooks/checkpoint-gate.sh /tmp/
sudo mv ~/.claude/hooks/plan-gate.sh       /tmp/
sudo mv ~/.claude/hooks/stop-gate.sh       /tmp/

# Resolve the marker situation (move the offending marker to /tmp/, or
# wait for the xattr to age out, or contact your IT for an EDR override).

# Restore the hooks:
sudo mv /tmp/checkpoint-gate.sh ~/.claude/hooks/
sudo mv /tmp/plan-gate.sh       ~/.claude/hooks/
sudo mv /tmp/stop-gate.sh       ~/.claude/hooks/
```

`sudo mv` of the hook scripts themselves works because the parent `~/.claude/hooks/` directory typically doesn't carry the provenance protection — only files written by Claude Code's Write tool do. The marker file itself remains stuck; once the hooks are absent, the gates don't fire, and Claude Code can resume work. The stuck marker can be cleaned up when the xattr ages out (usually 24-48 hours) or via IT-level provenance override.

**Long-term fix** tracked at #178 F3 — Claude Code harness change to strip `com.apple.provenance` post-write on marker files in `.checkpoints/`. Out of scope for this repo. Cross-link to writer-side worktree audit: `feedback_project_root_binding_audit.md`.

## Related

- RFC-002 Phase 3b spec: `docs/rfcs/RFC-002-learning-loop.md`
- Tracking issue: #59
- plan-gate canonicalization: #86 (PR-A: tool-name allowlist + canonicalize; PR-B: strict Bash command allowlist)
- Hook-deadlock cluster: #178, #191, #202 (rank-1 plan v7 — wrong-root marker write detection + stop-gate active-plan exemption)
