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
| `em-recall-sessionstart.sh` | SessionStart | Invokes `enforce-contract --session-start` (RFC-008 P3d): writes the `.session-baseline`, sweeps stale plan/preflight markers, and surfaces the bp-001 advisory. Arms nothing (planning-passive — the pre-checkpoint is lazily armed by checkpoint-gate.sh at first repo write). |
| `stop-gate.sh` | Stop / SubagentStop | Blocks turn-end when post-checkpoint required but absent (#128). |
| `lib/marker-paths.sh` | sourced | Shared marker-path constants and dual-root helpers (2026-05-09 .checkpoints/ migration) |
| `lib/repo-root.sh` | sourced | `resolve_repo_root` git-common-dir walker (PR #105 / #85) |
| `lib/command-classifier.sh` | sourced | Quote/heredoc-aware Bash classifier (#86 PR-B / #89 / #101) |

## Gate decision telemetry (E5) — `.checkpoints/gate-log.jsonl`

`checkpoint-gate.sh`, `plan-gate.sh`, and `stop-gate.sh` append one JSON line
per terminal decision to `<repo>/.checkpoints/gate-log.jsonl`:

```json
{"ts":<epoch-s>,"gate":"checkpoint|plan|stop","tool":"Bash","label":"<classifier label>","reason":"<site token>","decision":"allow|silence|hold|block","sid":"<session>","cmd_sha256":"<sha256>"}
```

Design constraints (all load-bearing):

- **Observability only, never decision-bearing.** Pure-bash `printf >>` under
  `|| true`; a telemetry failure can neither fail the hook nor change its
  decision, and no node process is spawned for logging.
- **Quoting safety.** The raw command is NEVER embedded (bash-side JSON
  escaping of arbitrary command text is a bug factory). `cmd_sha256` is the
  sha256 of the WHITESPACE-NORMALIZED command (runs of space/tab/CR/LF
  collapsed to one space, trimmed — the same collapse
  `classifier-marker.mjs` `normalizeCommand` applies, minus its
  trailing-comment strip). All other fields are controlled tokens sanitized
  to `[A-Za-z0-9._:-]`.
- **Never creates `.checkpoints/`.** Appends only when the dir already
  exists — a fallback REPO_ROOT (non-git cwd, off-project invocation) must
  not grow a marker dir (the SA-cwd-strict caller-leak class). Telemetry is
  silently off until the project's first marker/classify activity creates
  the dir.
- **Decision vocabulary.** `hold` = novel Bash command parked for agent
  classification (`_block_needs_classification`) — distinct from `block`
  (checkpoint/plan/push/integrity blocks). `silence` = an enforce-config
  consult (`active:false` / clamp) turned the gate off for this call.
- **Deliberately unlogged sites**: the read-only-TOOL early exit (one line
  per Read/Grep would swamp the log with non-decisions), the hooks/lib-missing
  block (telemetry helpers not defined yet at that point), and plan-gate's
  allow paths (its no-op common case; checkpoint-gate logs the allow story).

Consumers: `em-doctor` gate-friction section (counts per decision,
false-positive metric via the `.checkpoints/classify/` join, >5MB warning) —
see `docs/EM_SCRIPTS_GUIDE.md`. Conformance: `tests/test-gate-conformance.mjs`
asserts one line per decision with the expected `decision` values against the
real installed gate.

## Marker storage (.checkpoints/ migration, 2026-05-09)

Marker WRITES land at `<repo-root>/.checkpoints/.X` (PRIMARY); reads check
PRIMARY first then fall back to `<repo-root>/.claude/.X` (LEGACY) until the
fallback branch is removed. CLEANUP sweeps BOTH roots until then. Migration
exists because Claude Code's built-in sensitive-file guard prompts on every
Write to a `.X` basename inside any `.claude/` segment, regardless of
allowlist. See `tools/migration-cutover.mjs` and `tools/migration-sweep.mjs`
for the install-parity check and burn-in exit gate that protect the
fallback-removal commit.

## Classifier verdict cache — canonical key (E3)

`checkpoint-gate.sh` holds novel Bash commands for agent classification; the
verdicts live in `<repo>/.checkpoints/classify/<sha>.json` and are read/written
by `scripts/classifier-marker.mjs`. The cache key is a CONSERVATIVE canonical
command form (`scripts/lib/command-canonical.mjs`): executable +
subcommand/script-path token (absolute prefixes under the repo root / `$HOME`
normalized to `<REPO>` / `<HOME>`) + the sorted SET of flag names — flag VALUES
and positional operands dropped. So `node em-x.mjs --limit 1` and
`node em-x.mjs --limit 2` share one verdict, while:

- different flag-NAME sets never share a verdict;
- any redirect / pipe / substitution / quoting / env-prefix / `key=value`
  operand form is NOT canonicalizable and keys on its literal form only — a
  write-capable variant can never hit a `read_only` verdict cached from a form
  without it;
- in-repo interpreter scripts keep the stronger script-identity key
  (exe + content digest, args fully ignored).

Reads try the canonical key first, then fall back to the pre-E3 legacy literal
key (existing markers keep hitting until TTL/`--vacuum` reaps them). Writes
persist under the canonical key with the raw command preserved in the marker's
`command_raw` field for audit. Tests: `tests/test-canonical-cache-key.mjs`.

## Pre-hold consult order (E4 read-only manifest + E2 LLM auto-classify)

When a novel Bash command would otherwise be HELD for agent classification
(LABEL=shared_write with an unevaluated-novel reason — the per-session marker
cache already missed), `checkpoint-gate.sh` consults
`scripts/classifier-hold-consult.mjs` BEFORE emitting the hold (spawn
discipline: the common allow paths never pay the node spawn). Consult order:

1. **Per-session marker cache** (already consulted inside the classifier —
   the miss is what made the reason unevaluated-novel).
2. **First-party read-only manifest** `patterns/readonly-commands.json`
   (schema: `patterns/readonly-commands.schema.json`): canonical command
   shapes that are read-only BY DESIGN (em-* readers, `em-doctor` without
   `--fix`, `em-pattern-health --check`, `em-recall` with its documented read
   flags, `node --version`). A match classifies `read_only` with no agent
   involvement and the command runs; nothing is persisted (the manifest is the
   durable authority). Matching runs on the canonical form, so a redirect or
   extra write-flag variant can never match.
3. **LLM auto-classify (E2)** `scripts/llm-classify.mjs --three-way`:
   non-interactive only — it requires `ANTHROPIC_API_KEY` (skipped instantly
   without one; a PreToolUse hook can never prompt for auth) and honors
   `classifier-config.json` (`enabled:false` disables the stage; env/project/
   global precedence via `classifier-config-loader.mjs`). Strict 3-way rubric
   (`read_only` / `nonsrc_write` / `shared_write`), hard-killed at 10s. A
   verdict with confidence >= 0.8 is persisted into the SAME per-session
   verdict cache (`classifier-marker.mjs --write --source llm`, payload gains
   `"source":"llm"`) and the command proceeds per verdict: read_only /
   nonsrc_write run; shared_write falls through to the existing arm/block
   branch.
4. **Existing agent hold** (fail-closed): manifest miss + LLM
   miss/failure/timeout/low-confidence/malformed output, malformed manifest,
   helper absent, or garbage output all fall through to
   `_block_needs_classification`.

Installed layouts resolve the manifest from
`~/.episodic-memory/patterns/readonly-commands.json` (deployed by
`install.mjs`); repo-source runs use `patterns/` directly. Tests:
`tests/test-readonly-manifest.mjs` (E4),
`tests/test-llm-hold-classify.mjs` (E2 — stubbed local API, never live).

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
