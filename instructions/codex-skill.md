# Episodic Memory

Persistent, self-correcting memory across coding sessions. Markdown files with YAML frontmatter. When a decision proves wrong, revise it — the original is superseded and future searches show only the corrected version.

**Scripts:** `~/.episodic-memory/scripts/`
**Data:** global `~/.episodic-memory/episodes/` (default) | local `.episodic-memory/episodes/`

## Store (0-3 per session)

Store when: significant decision or trade-off, bug root cause or non-obvious behavior, milestone reached, critical constraint discovered, user says "remember this". Do NOT store: routine edits, credentials, info already in project docs.

```bash
node ~/.episodic-memory/scripts/em-store.mjs --project <name> --category <decision|discovery|milestone|context|research> --tags "<t1,t2>" --summary "<text>" --body "<text>" [--scope global|local] [--url "<source-url>"]
```

Project name: cwd basename or git remote name. Default scope is global (available to all projects).

## Research (web search + store)

When researching from the web: first check `em-search.mjs --category research --query "<topic>"` to avoid duplicates. Distill findings into body with enough detail to be useful without revisiting the URL. Add `--url` and `--category research`.

## Recall

- Session start: proactively `em-recall.mjs --project <name> [--task-type <implementation|push|rule|general>] [--limit 5]` — surfaces relevant episodes + violation pre-flight for behavioral patterns related to the task type (RFC-002 Phase 3). Use `--task-type implementation` before code work to surface recent bp-001/bp-006 violations.
- User asks about past decisions: `em-search.mjs --query "<topic>" [--full]`
- Before contradicting a past decision: search first

```bash
node ~/.episodic-memory/scripts/em-recall.mjs [--project <name>] [--task-type <implementation|push|rule|general>] [--scope local|global|all] [--limit <n>] [--days <n>]
node ~/.episodic-memory/scripts/em-search.mjs [--project <name>] [--query <text>] [--tag <t>] [--category <c>] [--since <date>] [--limit <n>] [--full] [--scope local|global|all] [--include-superseded] [--history <id>]
node ~/.episodic-memory/scripts/em-list.mjs [--project <name>] [--limit <n>]
```

## Revise (self-correction)

When a prior decision proves wrong: search for original, then revise. Original is auto-marked superseded. Use `--history <id>` to show the full chain.

```bash
node ~/.episodic-memory/scripts/em-revise.mjs --original <id> --summary "<text>" --body "<text>" [--tags "<t1,t2>"]
```

## Staleness Check

When encountering a URL, check if stored research exists and is stale. Re-fetch and revise if content changed.

```bash
node ~/.episodic-memory/scripts/em-check-stale.mjs [--days 30] [--project <name>]
```

## Session End

Review session for 0-3 significant events, store them, then proceed with normal wrap-up.

## Maintenance

Rebuild index if corrupted: `node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all`

## Command Invocation Hygiene

**Env-prefix wrapper escape** (specific instance of safety-check bypass). Don't invoke commands with leading environment-variable assignments where the var name hints at gate-bypass intent — names containing `BYPASS_*`, `SKIP_*`, `DISABLE_*`, `ALLOW_*`, `OVERRIDE_*`, `UNSAFE_*`, or known internal gate prefixes. The wrapping invocation looks innocuous to a permission check while the env var carries the bypass payload (documented cross-session attack class; tracked in episodes tagged `pr-271`). Reject the entire form; don't tokenize allowed vs. disallowed vars.

Does NOT cover routine framework / runtime env vars on their normal commands — `NODE_ENV=production npm start`, `DEBUG=1 ./run.sh`, `CI=true pytest`, `PYTHONPATH=. python script.py`, `LOG_LEVEL=debug ./service` are fine.
