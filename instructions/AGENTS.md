# Episodic Memory

You have access to a persistent episodic memory system for storing and recalling significant decisions, discoveries, milestones, and context across sessions. The system is self-correcting — when a decision proves wrong, create a revision that supersedes it.

**Scripts:** `~/.episodic-memory/scripts/`
**Local data:** `.episodic-memory/` (this project)
**Global data:** `~/.episodic-memory/` (cross-project)

## When to Use

**Store** an episode (0-3 per session) when:
- A significant decision is made (technology, architecture, trade-off)
- An important discovery is found (bug root cause, undocumented behavior)
- A milestone is reached (feature shipped, migration completed)
- Critical context emerges (constraints, environment quirks)
- User says "remember this"

**Recall** episodes when:
- Starting work — proactively search for this project's episodes (limit 5)
- User asks "what did we decide about X"
- Before making a decision that might contradict a past one

**Revise** when a prior decision proves wrong — don't delete, create a revision chain.

## Commands

Store:
```bash
node ~/.episodic-memory/scripts/em-store.mjs --project <name> --category <decision|discovery|milestone|context|research> --tags "<t1,t2>" --summary "<text>" --body "<text>" --scope <global|local>
```

Revise (self-correction):
```bash
node ~/.episodic-memory/scripts/em-revise.mjs --original <episode-id> --summary "<text>" --body "<text>" --tags "<t1,t2>"
```

Search:
```bash
node ~/.episodic-memory/scripts/em-search.mjs --project <name> [--query <text>] [--category <cat>] [--full]
node ~/.episodic-memory/scripts/em-search.mjs --history <episode-id> --full
```

List recent:
```bash
node ~/.episodic-memory/scripts/em-list.mjs --project <name> --limit 5
```

Rebuild index:
```bash
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```

## Categories
- `decision` — Technology choices, architecture, trade-offs
- `discovery` — Bug root causes, undocumented behavior, insights
- `milestone` — Features shipped, migrations completed
- `context` — Constraints, dependencies, environment quirks
- `research` — Web research, distilled docs, reference material (include `--url`)

## What NOT to Store
- Routine edits, test runs, file reads
- Credentials or sensitive data
- Information already in project documentation
