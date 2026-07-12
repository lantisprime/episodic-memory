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

### Lessons that activate (RFC-009)

Store a durable lesson with `--category lesson` plus activation flags so it resurfaces
automatically instead of only on search: `--trigger "<phrase>"` / `--trigger tool:Bash:git*` /
`--trigger activity:plan` (repeatable), `--applies-to-project <slug|*>`, `--applies-to-tool
claude-code`, `--priority <1-7>` (the 8-9 critical band is EARNED from linked violations, never
declared). When the advisory activation adapter is installed (`install.mjs --install-activation`,
Claude Code, per-project), these lessons surface as advisory context at prompt / tool /
session-start events — exit 0, never a block. Mute a lesson for one project by id via a
hand-authored `<project>/.episodic-memory/lesson-suppress.json` (fail-open). Full flag reference:
"Lesson activation" in `EM_SCRIPTS_GUIDE.md`.

### Playbooks (RFC-011)

A consumer project may declare per-project playbook loading preferences in an optional
hand-authored `<project>/.episodic-memory/playbooks.json` (schema-backed, at most 32 entries /
64 KiB). Each entry selects a playbook lesson episode by **episode id** — any chain member;
the trigger-index build resolves it to the terminal active revision — and a `mode`:
`session_start` (surface at every session start) or `on_demand` (surface when the RFC-009
trigger matcher fires). When the advisory activation adapter is installed, declared playbooks
render as provenance-prefixed imperative `READ <id>` pointers into the tracked bounded
`em-search --read <id>` (never bodies), the voluntary counterpart to the earned critical band.
A missing or malformed file degrades to no playbooks loaded (advisory fail-open);
`em-prune` / `em-consolidate --fold-superseded` protect referenced chains and fail CLOSED
(abort) on a present-but-unparseable file. Full reference: “Playbooks (RFC-011 R1/R2)” and
“Playbooks (RFC-011 R3/R4)” in `EM_SCRIPTS_GUIDE.md`.

```json
{"schema_version":1,"playbooks":[{"id":"<episode-id-a>","mode":"session_start"},{"id":"<episode-id-b>","mode":"on_demand","triggers":["review panel"]}],"bounds":{"max_playbooks":2}}
```

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

## Pattern-health + review-dispatch surfaces (RFC-009 P3)

- `em-trigger-index.mjs --with-pattern-health` recomputes and persists `session_start.pattern_health` (verdict derived from `em-pattern-health --hermetic --check`); without the flag the prior field carries forward verbatim. The SessionStart adapter renders one `pattern-health:` advisory line when the verdict is unhealthy.
- `second-opinion.mjs request|consensus --timeout <ms>` (>= 1000) bounds each provider dispatch round; expiry kills the child, records `{round, timeoutMs}`, and persists partial output to `.review-store/forensics/` (never parsed as a verdict).
- Every second-opinion dispatch prepends up to 3 matched lesson pointers (500-token bound, `--no-track`, incl. `activity:review` lessons) from the merged trigger index.
