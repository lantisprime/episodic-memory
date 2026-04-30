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
version: 0.1.0
---

# Episodic Memory

Structured, persistent memory for significant events across coding sessions. Episodes are stored as markdown files with YAML frontmatter. The system is self-correcting: when a decision proves wrong, create a revision that supersedes it.

**Scripts location:** `~/.episodic-memory/scripts/`
**Data locations:**
- Per-project: `.episodic-memory/episodes/` (local to current project)
- Global: `~/.episodic-memory/episodes/` (cross-project decisions)

## When to Store

Create an episode (0-3 per session max) when:

- A significant **decision** is made (technology choice, architecture approach, trade-off)
- An important **discovery** is found (bug root cause, undocumented behavior, performance insight)
- A notable **milestone** is reached (feature shipped, migration completed)
- Critical **context** emerges (constraints, external dependencies, environment quirks)
- The user explicitly says "remember this" or "save this"

**What qualifies:**
- "We chose PostgreSQL over MongoDB because of transaction requirements"
- "The auth middleware silently swallows 403 errors"
- "Migrated from CJS to ESM across the entire monorepo"

**What does NOT qualify:**
- Routine file reads, edits, or test runs
- Information already in auto-memory (user preferences)
- Credentials, tokens, or sensitive data

## When to Recall

- When starting work on a project — proactively search for episodes (limit 5)
- When the user asks "what did we decide about X", "recall", "do you remember"
- Before making a decision that might contradict a past one

## Self-Correction: Revision Chains

When a prior decision proves wrong or needs updating:

1. Search for the original decision
2. Create a revision using `em-revise.mjs`
3. The original is automatically marked `superseded`
4. Future searches show only the latest active version

Use `--history <id>` to show the full revision chain for any episode.

## Episode Schema

Categories: `decision`, `discovery`, `milestone`, `context`

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Auto-generated: `{YYYYMMDD-HHmmss-slug-xxxx}` |
| `date` | string | `YYYY-MM-DD` |
| `time` | string | `HH:MM` |
| `project` | string | Project name (from cwd basename or git remote) |
| `category` | enum | `decision \| discovery \| milestone \| context` |
| `status` | enum | `active \| superseded` |
| `supersedes` | string? | ID of the episode this revises (null if original) |
| `tags` | string[] | Searchable labels |
| `summary` | string | One-line description |

## How to Determine Project Name

Use the basename of the current working directory. If a git remote is available, prefer the repo name.

## Store Workflow

```bash
node ~/.episodic-memory/scripts/em-store.mjs \
  --project <project-name> \
  --category <decision|discovery|milestone|context> \
  --tags "<tag1,tag2>" \
  --summary "<one-line summary>" \
  --body "<detailed description>" \
  --scope <local|global>
```

Use `--scope local` (default) for project-specific decisions. Use `--scope global` for cross-project decisions.

## Revise Workflow (Self-Correction)

When a decision needs correction:

```bash
node ~/.episodic-memory/scripts/em-revise.mjs \
  --original <original-episode-id> \
  --summary "<what changed>" \
  --body "<why the original was wrong and what the correction is>" \
  --tags "<updated,tags>"
```

## Search / Recall Workflow

```bash
# Search by project (local + global)
node ~/.episodic-memory/scripts/em-search.mjs --project my-project

# Full-text search with body content
node ~/.episodic-memory/scripts/em-search.mjs --query "PostgreSQL" --full

# Show revision history for a decision
node ~/.episodic-memory/scripts/em-search.mjs --history <episode-id> --full

# Include superseded decisions
node ~/.episodic-memory/scripts/em-search.mjs --project my-project --include-superseded

# Filter by scope
node ~/.episodic-memory/scripts/em-search.mjs --scope local --category decision
```

## List Recent Episodes

```bash
node ~/.episodic-memory/scripts/em-list.mjs --project my-project --limit 5
```

## Session Integration

Before session wrap-up:

1. Review the session for significant events (0-3 max)
2. Store them as episodes
3. Then proceed with normal session handoff

## Index Maintenance

```bash
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```
