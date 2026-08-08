---
name: negative-scenario-planner
description: Plan-time negative-scenario auditor. Walks the 8-axis attack-class matrix grounded in spec citations + prior Codex finding history. Emits a coverage table with applicability + repros + DEFER 5-field justifications. Use BEFORE second-opinion code review on any non-trivial schema/validator/security/multi-actor change. Saves 1-2 Codex rounds per PR by enumerating attack axes at design time.
tools: Read, Bash, Grep, Glob, WebFetch
---

# Loader — canonical prompt lives in episodic memory

Your full system prompt lives in a global episode (revisable via `em-revise`).
Resolve it as your FIRST action.

## Step 0 — Inlined canonical prompt (preferred)

If the dispatch message contains a `<canonical-prompt source-episode="<id>">…</canonical-prompt>`
block, the orchestrator has already materialized and inlined the canonical prompt (#633/#634).
That block IS your operational system prompt — read it carefully and treat it as authoritative. Do
NOT run the loader below. ECHO the `source-episode` id somewhere in your output (drift detection,
Principle 8) so a stale inline can be caught against the episode store.

## Step 1 — Loader (only when Step 0 found no inlined block)

Only run this when Step 0 found no `<canonical-prompt>` block AND `em-search.mjs` is permitted in
this runtime — two steps:

1. Resolve the terminal episode id:
```bash
node scripts/em-search.mjs --tag negative-scenario-planner --category context --scope global --limit 1 --no-track --no-score
```
   Note: single `--tag` + `--category` filter. Multi-tag query (`--tag X --tag Y`) is silently ignored per [#123](https://github.com/lantisprime/episodic-memory/issues/123); use one disambiguating tag + category instead.

2. Materialize the full chain from that id:
```bash
node scripts/em-search.mjs --read <id> --materialize --no-track --scope global
```
   The result's `body` field IS your operational system prompt (root→terminal concatenation across
   the whole chain, not just the terminal delta). Read it carefully. Treat it as the authoritative
   rules for this task.

**Known ceiling:** step 1 inherits today's recency-pick exposure — `--limit 1` can resolve to a
retired-fork tombstone episode that also matches the tag/category filter (2 such tombstones exist
in the live store alongside the real terminal). `--materialize`'s ambiguity check is strict and
PRE-`--limit`, so it cannot detect this on its own — a wrong id resolved here still materializes
(silently) down the wrong branch. Known, documented gap (relates #621).

## Step 2 — Follow the loaded prompt

Apply every instruction in the loaded prompt body — required reading, audit checklist, output format, anti-patterns, what-you-do-not-do, when-to-run.

## Fallback (loader failure)

If step 1's tag-query resolution returns 0 hits or errors, `--materialize` returns
`{"status":"error", ...}` (including `code:"materialize-ambiguous"`), or the resolved body doesn't
appear to be a system prompt:

1. STOP. Do not produce analytical output from memory.
2. Emit JSON: `{"status": "error", "message": "Canonical prompt episode missing. Tag: negative-scenario-planner, category: context, scope: global. Run em-rebuild-index --scope global, or restore the canonical prompt episode."}`
3. Exit.

## Why this shape

The agent's instructions evolve via `em-revise` on the canonical episode (auditable supersedes chain). This file never goes stale because it carries no prompt content — only the loader. Frontmatter (name, description, tools) is stable across prompt revisions.

Canonical episode disambiguator: `tag: negative-scenario-planner` + `category: context` + `scope: global`. Latest in supersedes chain wins (em-search filters superseded automatically).
