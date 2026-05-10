# Episodic Memory

Cross-tool episodic memory system for AI coding assistants (Claude Code, Cursor, Codex, Windsurf).

## Project structure
- `scripts/` — Core .mjs scripts (tool-agnostic, zero deps, Node.js stdlib only)
- `instructions/` — Per-tool instruction files (SKILL.md, cursor.mdc, AGENTS.md, windsurf.md)
- `install.mjs` — Installer: copies scripts globally + instruction files to target project
- `.claude-plugin/plugin.json` — Claude Code plugin manifest
- `skills/episodic-memory/` — Claude Code skill (symlinks to instructions/ and scripts/)


## Data locations
- Global: `~/.episodic-memory/` (scripts, episodes, index)
- Per-project: `.episodic-memory/` (local episodes + index)
- `docs/rfcs/` — contains the RFC to be used in implementation when the status is ACCEPTED
- `PRINCIPLES.md` — when planning, designing, and implementing requirements, Claude Code must read this and follow

## Development conventions
- Scripts are `.mjs` (ESM) with zero external dependencies
- All scripts output JSON to stdout
- Scripts handle missing data directories gracefully (create on first use)
- Episode IDs are immutable; decisions are corrected via revision chains, not edits
- Use atomic write (temp + rename) for index rebuilds
- You must not do mental tracing always use the actual files or data
- You must do code review and use the actual files

## Second-opinion review harness
Pluggable cross-tool review at `scripts/second-opinion.mjs`. Replaces the
manual 5-step `em-store + codex exec + episode-reply` recipe with a callable
harness that handles preamble composition, provider dispatch, and
consensus-loop iteration in one invocation.

```bash
# Single-shot: write request → dispatch → write reply (synchronous).
node scripts/second-opinion.mjs request \
  --provider codex --project . --storage files \
  --body "review this diff..." --summary "diff review" --dispatch

# Consensus loop: dispatch → parse verdict → rebuttal-cb → next round.
node scripts/second-opinion.mjs request \
  --provider codex --project . --storage files \
  --body-file plan.md --summary "plan review" \
  --consensus --max-rounds 5 --rebuttal-cb scripts/my-rebuttal.mjs
```

Providers: `codex`, `claude-subagent`, `gemini`, `stub` (testing).
Storage backends: `files` (`.review-store/`) or `episodic` (uses em-store).
Preambles: per-provider defaults at `scripts/second-opinion/preambles/`,
overridable via `--preamble <id>` CLI flag or
`<project>/.review-store/preambles/<provider>.md` file.

Run `node install.mjs --tool claude-code --install-second-opinion` to
write the install snapshot at `~/.claude/hooks/second-opinion-providers.json`
(required for harness I-27a registry-stale-at-gate + composer I-27b
preamble-tamper-at-composer + Claude Code PreToolUse hook gating).

The Claude Code PreToolUse hook (`hooks/second-opinion-gate.mjs`) blocks
direct provider invocations (Bash + Agent variants) so reviews route
through the harness. Hook is fail-closed on missing/malformed snapshot.

## Discovering active priorities (read on session start)
Before recommending or starting work, fetch the latest workplan:
```bash
node scripts/em-search.mjs --tag workplan --category decision --limit 1 --scope all --full --no-score --no-track
```
Workplans are stored as `category: decision` with tag `workplan`. The terminal revision in the supersedes chain is the current one. The active queue table holds priority/status/session/tokens/depends-on per item. (Tier-2 of MEMORY.md "Current workplan" pointer; tool-agnostic for Cursor/Codex/Windsurf.)

Notes on the flags: `--tag` (singular — em-search silently ignores `--tags` per #123), `--category decision` (filters out evidence/lesson siblings that share the `workplan` tag), `--no-score` (recency sort; remove when #123 ships `--sort recency`), `--full` (returns body so the table renders), `--no-track` (avoids access-counter pollution from session-start polling).

## Testing
```bash
node scripts/em-store.mjs --project test --category decision --summary "test" --body "test body"
node scripts/em-search.mjs --project test
node scripts/em-list.mjs
node scripts/em-revise.mjs --original <id> --summary "revised" --body "correction"
node scripts/em-search.mjs --history <id> --full
node scripts/em-rebuild-index.mjs --scope all
```
