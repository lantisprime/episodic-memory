---
pattern_id: bp-012-complete-session-wrap-up
name: "Complete session wrap-up — episodic memory, changes, handoff"
category: decision
tags: [behavioral-pattern, bp-012-complete-session-wrap-up, session-discipline, episodic-memory, completeness]
scope: global
version: 1.0.0
---

# Complete Session Wrap-Up

At session end, complete ALL three steps in order. Do not skip any. The session is not over until all three are done.

## Steps (in order)

1. **Store episodic memories** — review session for significant decisions, discoveries, milestones, lessons learned. Store 0-3 episodes via `em-store.mjs`. Check if any project-specific decisions are generalizable to global behavioral patterns.

2. **Reconcile changes** — ensure all code changes are committed, pushed, and in a PR. Check `git status` and `git log origin/main...HEAD`. If changes exist that aren't in a PR, create one. Update any existing PRs with new commits.

3. **Write session handoff** — write/overwrite `memory/session_handoff.md` (~300 words). Must reflect actual repo state (correct branch, correct PR numbers, correct merge status). Tell user to `/clear`.

## Detection triggers

- User says "wrap up", "session handoff", "let's stop", "what's next session"
- About to write session_handoff.md — have episodes been stored?
- About to tell user to `/clear` — have all changes been pushed?

## Why this exists

Across 3+ sessions, the AI consistently:
- Forgot to store learnings in episodic memory before handoff
- Left uncommitted changes on branches that had already been merged
- Wrote session handoff with stale PR numbers or branch names
- Had to be reminded by the user every time

The session "feels done" after the handoff is written, but loose ends remain. This is the same "after work feels done" failure mode that causes bp-001 violations at task end.

## Enforcement

- **Current:** Documentation only (this pattern + MEMORY.md reminder)
- **Future:** SessionEnd hook could run a checklist script that verifies: (a) recent em-store calls in session, (b) clean git status, (c) session_handoff.md freshness

## Scope

All projects, all AI tools. Applies at every session end.
