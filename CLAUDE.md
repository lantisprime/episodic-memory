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
- `docs/rfcs/` — RFC specs; implement from those with status `ACCEPTED`. Index: `docs/rfcs/README.md` + `_index.json`.
- `PRINCIPLES.md` — governing principles (memory-as-substrate, JSON-defs/`.mjs`-adapters, explicit activation, etc.). Read before planning/designing/implementing; new features that violate a principle either revise it or get rejected.
- `CAPABILITIES.md` — capability charter (the guiding post): the substrate capability families the project supports — memory-store strategy, recall strategy, learning strategy — and the rule for adding new ones as plugin types. Capabilities *use* the memory substrate; they do NOT enforce workflows (that is behavior patterns' job, a decoupled layer). Read alongside `PRINCIPLES.md` before adding any capability or plugin type.

## Development conventions
- Scripts are `.mjs` (ESM) with zero external dependencies
- All scripts output JSON to stdout
- Scripts handle missing data directories gracefully (create on first use)
- Episode IDs are immutable; decisions are corrected via revision chains, not edits
- Use atomic write (temp + rename) for index rebuilds
- No mental tracing — use the actual files/data, and read them for code review

## Second-opinion review harness
Pluggable cross-tool review at `scripts/second-opinion.mjs`. Replaces the
manual 5-step `em-store + codex exec + episode-reply` recipe with a callable
harness handling preamble composition, provider dispatch, and consensus loop.

```bash
# Single-shot: write request → dispatch → write reply.
node scripts/second-opinion.mjs request \
  --provider codex --project . --storage files \
  --body "review this diff..." --summary "diff review" --dispatch
```

Consensus-loop variant: pass `--consensus --max-rounds N --rebuttal-cb <script>`. See `scripts/second-opinion.mjs --help`.

Providers: `codex`, `claude-subagent`, `gemini`, `stub`. Storage: `files` (`.review-store/`) or `episodic`. Preambles default to `scripts/second-opinion/preambles/`, overridable via `--preamble <id>` or `<project>/.review-store/preambles/<provider>.md`.

Run `node install.mjs --tool claude-code --install-second-opinion` to write the registry snapshot at `~/.claude/hooks/second-opinion-providers.json`. The PreToolUse hook (`plugins/claude-code/hooks/second-opinion-gate.mjs`) blocks direct Bash + Agent provider invocations so all reviews route through the harness; fail-closed on missing/malformed snapshot.

## Discovering active priorities (read on session start)
Before recommending or starting work, fetch the latest workplan:
```bash
node scripts/em-search.mjs --tag workplan --category decision --limit 1 --scope all --full --no-score --no-track
```
Workplans are `category: decision` + tag `workplan`. The terminal revision in the supersedes chain is current. The active queue table holds priority/status/session/tokens/depends-on per item. Flag rationale: see `scripts/em-search.mjs --help`.

## Testing
```bash
node scripts/em-store.mjs --project test --category decision --summary "test" --body "test body"
node scripts/em-search.mjs --project test
node scripts/em-list.mjs
node scripts/em-revise.mjs --original <id> --summary "revised" --body "correction"
node scripts/em-search.mjs --history <id> --full
node scripts/em-rebuild-index.mjs --scope all
```
