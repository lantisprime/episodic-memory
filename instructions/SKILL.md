---
name: episodic-memory
description: >
  Manage persistent episodic memories across sessions. Use this skill whenever
  the user says "remember this", "save this decision", "what did we decide
  about X", "recall", "what do you know about project X", or when a significant
  architectural decision, bug root cause, or milestone is reached. Also use
  when starting work on a project to proactively recall relevant past episodes.
  Even if the user doesn't explicitly ask, store episodes for important
  decisions, discoveries, or context valuable in future sessions.
version: 0.2.0
---

# Episodic Memory

Persistent, self-correcting memory across coding sessions. Markdown files with YAML frontmatter. When a decision proves wrong, revise it — the original is superseded and future searches show only the corrected version.

**Scripts:** `~/.episodic-memory/scripts/`
**Data:** global `~/.episodic-memory/episodes/` (default) | local `.episodic-memory/episodes/`
**Full per-script reference:** `~/.episodic-memory/EM_SCRIPTS_GUIDE.md`. Read it before first script use.

## Store (0-3 per session)

Store when: significant decision or trade-off, bug root cause or non-obvious behavior, milestone reached, critical constraint discovered, user says "remember this". Do NOT store: routine edits, credentials, info already in auto-memory.

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

When encountering a URL, check if stored research exists and is stale. At session start or when recalling research, check for outdated entries. Re-fetch and revise if content changed.

```bash
node ~/.episodic-memory/scripts/em-check-stale.mjs [--days 30] [--project <name>]
```

## Behavioral Patterns

Global episodic memory stores behavioral patterns — reusable workflows that apply across all projects. Tag with `behavioral-pattern` and scope `global`.

**Pattern promotion:** When a project-specific decision proves to be a best practice (confirmed across 2+ projects), promote it to global memory:
```bash
node ~/.episodic-memory/scripts/em-store.mjs --project global --category decision --tags "behavioral-pattern,<topic>" --summary "<pattern name>" --body "<pattern details>" --scope global
```

**Pattern detection at session end:** Before storing session episodes, check if any project-specific decisions are generalizable. If a pattern would benefit other projects, store it globally with tag `behavioral-pattern`.

## Session End

Review session for 0-3 significant events, store them, then proceed with normal session handoff. Also examine project-specific decisions for potential promotion to global behavioral patterns.

After writing the handoff (or a PR body), scan it so cited episodes earn recall weight: `node ~/.episodic-memory/scripts/em-feedback.mjs --scan-text <file>` records one +1 per resolved episode id it finds.

## Maintenance

Rebuild index if corrupted: `node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all`
