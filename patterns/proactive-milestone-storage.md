---
pattern_id: bp-002-proactive-milestone-storage
name: "Proactive milestone storage"
category: decision
tags: [behavioral-pattern, bp-002-proactive-milestone-storage, episodic-memory, milestone, session-discipline]
scope: global
version: 1.0.0
---

# Proactive Milestone Storage

When a milestone is reached, proactively offer to store it in local episodic memory. Do not wait for the user to ask.

## Detection triggers

- Phase or feature shipped and merged
- PR merged
- RFC status change (draft → accepted → implemented)
- Significant bug found and fixed (with root cause)
- Architecture decision made
- CI/CD pipeline change
- New rule or pattern established

## Episode content

The stored episode should include: what shipped, key decisions made, bugs found during the process, and what comes next.

## Scope

All projects, all AI tools. Store the milestone episode in local scope (project-specific). This pattern itself lives in global scope.
