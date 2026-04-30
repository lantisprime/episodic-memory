# Episodic Memory Plugin

## Project structure
- Plugin manifest: `.claude-plugin/plugin.json`
- Skill definition: `skills/episodic-memory/SKILL.md`
- Scripts: `skills/episodic-memory/scripts/em-*.mjs`
- Runtime data: `~/.claude/episodic-memory/` (not in this repo)

## Development conventions
- Scripts are `.mjs` (ESM) with zero external dependencies — Node.js stdlib only
- All scripts output JSON to stdout for Claude to parse
- Scripts must handle missing data directory gracefully (create on first use)
- Episode IDs are immutable once created
- `index.jsonl` is append-only; rebuild with `em-rebuild-index.mjs` if corrupted
- Use atomic write (temp file + rename) for index rebuilds

## Testing
```bash
node skills/episodic-memory/scripts/em-store.mjs --project test --category decision --summary "test" --body "test body"
node skills/episodic-memory/scripts/em-search.mjs --project test
node skills/episodic-memory/scripts/em-list.mjs
node skills/episodic-memory/scripts/em-rebuild-index.mjs
```
