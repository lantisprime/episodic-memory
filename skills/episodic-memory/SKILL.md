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

Structured, persistent memory for significant events across Claude Code sessions. Episodes are stored as markdown files with YAML frontmatter in `~/.claude/episodic-memory/episodes/`.

## When to Store

Create an episode (0-3 per session max) when:

- A significant **decision** is made (technology choice, architecture approach, trade-off accepted)
- An important **discovery** is found (bug root cause, undocumented behavior, performance insight)
- A notable **milestone** is reached (feature shipped, migration completed, PR merged)
- Critical **context** emerges (constraints, external dependencies, environment quirks)
- The user explicitly says "remember this" or "save this"

**Examples that qualify:**
- "We chose PostgreSQL over MongoDB because of transaction requirements"
- "The auth middleware silently swallows 403 errors — discovered during login bug investigation"
- "Migrated from CJS to ESM across the entire monorepo"

**Examples that do NOT qualify:**
- Routine file reads, edits, or test runs
- Information already captured in auto-memory (user preferences, feedback)
- Session audit trail entries (those go in `session_summaries/`)
- Credentials, tokens, or sensitive data (never store these)

## When to Recall

Search for relevant episodes:

- When starting work on a project — proactively search for that project's episodes (limit 5)
- When the user asks "what did we decide about X", "do you remember", "recall"
- Before making a decision that might contradict a past one
- When context about a prior session would help the current task

## When NOT to Use

Do not duplicate other memory systems:

- **Auto-memory** (`~/.claude/projects/*/memory/`) handles user preferences and feedback — don't re-store those as episodes
- **Session summaries** (`session_summaries/`) are audit logs — don't duplicate session-level records
- **Session handoff** (`memory/session_handoff.md`) is an ephemeral bridge — episodes are the permanent complement

## Episode Schema

Four categories: `decision`, `discovery`, `milestone`, `context`

Frontmatter fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | `{YYYYMMDD-HHmmss-slug-xxxx}` (auto-generated) |
| `date` | string | `YYYY-MM-DD` |
| `time` | string | `HH:MM` |
| `project` | string | Project name |
| `category` | enum | `decision \| discovery \| milestone \| context` |
| `tags` | string[] | Searchable labels |
| `summary` | string | One-line description |

## How to Determine Project Name

Use the basename of the current working directory. If a git remote is available, prefer the repo name from the remote URL (e.g., `origin` → `my-repo`). Fall back to the directory name.

## Store Workflow

1. Identify the significant event during the session
2. Determine category and relevant tags
3. Run the store script:

```bash
node <plugin-path>/skills/episodic-memory/scripts/em-store.mjs \
  --project <project-name> \
  --category <decision|discovery|milestone|context> \
  --tags "<tag1,tag2>" \
  --summary "<one-line summary>" \
  --body "<detailed description with context>"
```

4. Confirm to the user what was stored

## Search / Recall Workflow

1. Run the search script with appropriate filters:

```bash
# By project
node <plugin-path>/skills/episodic-memory/scripts/em-search.mjs --project my-project

# By tag and category
node <plugin-path>/skills/episodic-memory/scripts/em-search.mjs --tag auth --category decision

# Full-text search with body content
node <plugin-path>/skills/episodic-memory/scripts/em-search.mjs --query "PostgreSQL" --full

# Recent episodes since a date
node <plugin-path>/skills/episodic-memory/scripts/em-search.mjs --since 2026-04-01 --limit 5
```

2. Present matching episode summaries to the user
3. Offer to read full episode bodies if the user wants details

To list recent episodes without filters:

```bash
node <plugin-path>/skills/episodic-memory/scripts/em-list.mjs --project my-project --limit 5
```

## Session Integration

Before writing `session_handoff.md` at session end:

1. Review the session for 0-3 significant events worth remembering
2. Store them as episodes using the store workflow
3. Then write `session_handoff.md` as usual — it remains the ephemeral bridge, while episodes are the permanent record

## Index Maintenance

If the index becomes corrupted or out of sync:

```bash
node <plugin-path>/skills/episodic-memory/scripts/em-rebuild-index.mjs
```

To delete an episode manually: remove the file from `~/.claude/episodic-memory/episodes/` then rebuild the index.
