---
pattern_id: bp-003-pattern-promotion
name: "Promote project-specific best practices to global memory"
category: decision
tags: [behavioral-pattern, bp-003-pattern-promotion, global-memory, best-practice]
scope: global
version: 1.0.0
---

# Pattern Promotion

When a project-specific decision or behavior proves to be a best practice, promote it to global episodic memory so all projects and tools benefit.

## Detection criteria

A project-specific behavior should be promoted to global when:

1. It has been confirmed across 2+ projects (not a one-off)
2. It represents a generalizable best practice (not project-specific tooling)
3. It prevented bugs, saved time, or improved quality in a measurable way

## Promotion workflow

1. At session end, review project-specific episodes stored during the session
2. Check if any represent generalizable patterns (not project-specific config/tooling)
3. If yes, store a global episode with category 'decision' and tag 'behavioral-pattern'
4. If the pattern is significant enough, create a pattern file in `patterns/` and update `_index.json`

## Detection triggers

- Session end review
- User says "this should apply everywhere"
- Same decision made independently in 2+ projects

## Scope

All projects, all AI tools. The promotion itself creates a global episode. Project-specific episodes remain unchanged.
