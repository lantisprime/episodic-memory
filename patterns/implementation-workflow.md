---
pattern_id: bp-001-implementation-workflow
name: "Standard implementation workflow"
category: decision
tags: [behavioral-pattern, bp-001-implementation-workflow, workflow, sdlc, testing, code-review]
scope: global
version: 1.0.0
---

# Standard Implementation Workflow

Mandatory workflow for any non-trivial implementation across all projects and AI tools. Catches bugs at three stages: plan review (design gaps), code review (implementation bugs), and E2E testing (integration failures).

## Steps (in order)

1. Present implementation plan
2. Second-opinion review on the plan (cross-AI or subagent)
3. Fix all P1/P2 findings from the second review
4. Show final plan, wait for explicit approval (plan-gate)
5. Implement with unit tests written alongside code
6. Code review the implementation
7. Fix all code review bugs
8. End-to-end testing
9. Log all bugs to GitHub Issues with root cause + resolution (if connected)

## Detection triggers

- User requests a new feature or multi-file change
- RFC phase is moving to implementation
- Refactor with behavioral changes planned
- Any change modifying more than 3 files

## Scope

All projects, all AI tools. Does NOT apply to trivial fixes (typo, one-liner, config change), documentation-only changes, or exploratory spikes.
