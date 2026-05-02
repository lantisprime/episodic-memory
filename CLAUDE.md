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

## Testing
```bash
node scripts/em-store.mjs --project test --category decision --summary "test" --body "test body"
node scripts/em-search.mjs --project test
node scripts/em-list.mjs
node scripts/em-revise.mjs --original <id> --summary "revised" --body "correction"
node scripts/em-search.mjs --history <id> --full
node scripts/em-rebuild-index.mjs --scope all
```
