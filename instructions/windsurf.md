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
- Starting work — proactively `em-recall.mjs` with `--task-type` for the upcoming work (surfaces episodes + violation pre-flight; RFC-002 Phase 3)
- User asks "what did we decide about X" — `em-search.mjs`
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

Recall (session-start, proactive — surfaces episodes + violation pre-flight):
```bash
node ~/.episodic-memory/scripts/em-recall.mjs --project <name> [--task-type <implementation|push|rule|general>] [--limit 5]
```
Use `--task-type implementation` before code work to surface recent bp-001/bp-006 violations from the last 30 days. Pass `general` (or omit) for ad-hoc recall without violation pre-flight.

Search (ad-hoc):
```bash
node ~/.episodic-memory/scripts/em-search.mjs --project <name> [--query <text>] [--category <cat>] [--full]
node ~/.episodic-memory/scripts/em-search.mjs --history <episode-id> --full
```

List recent:
```bash
node ~/.episodic-memory/scripts/em-list.mjs --project <name> --limit 5
```

Check stale research (re-fetch URLs older than N days):
```bash
node ~/.episodic-memory/scripts/em-check-stale.mjs --days 30
```

When encountering a URL during coding, check if it's stored (`em-search.mjs --query "<url>"`). If stale, re-fetch and revise. If missing, fetch and store.

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

## Command Invocation Hygiene

**Env-prefix wrapper escape** (specific instance of safety-check bypass). Don't invoke commands with leading environment-variable assignments where the var name hints at gate-bypass intent — names containing `BYPASS_*`, `SKIP_*`, `DISABLE_*`, `ALLOW_*`, `OVERRIDE_*`, `UNSAFE_*`, or known internal gate prefixes. The wrapping invocation looks innocuous to a permission check while the env var carries the bypass payload (documented cross-session attack class; tracked in episodes tagged `pr-271`). Reject the entire form; don't tokenize allowed vs. disallowed vars.

Does NOT cover routine framework / runtime env vars on their normal commands — `NODE_ENV=production npm start`, `DEBUG=1 ./run.sh`, `CI=true pytest`, `PYTHONPATH=. python script.py`, `LOG_LEVEL=debug ./service` are fine.
