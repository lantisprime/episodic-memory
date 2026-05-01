---
pattern_id: bp-001-implementation-workflow
name: "Standard implementation workflow"
category: decision
tags: [behavioral-pattern, bp-001-implementation-workflow, workflow, sdlc, testing, code-review, enforcement]
scope: global
version: 2.0.0
---

# Standard Implementation Workflow

Mandatory workflow for any non-trivial implementation across all projects and AI tools. Catches bugs at three stages: plan review (design gaps), code review (implementation bugs), and E2E testing (integration failures).

## Scope Tiers

Classify every task before starting. Use mechanical criteria, not judgment calls.

### Full (all 9 steps)

Applies when ANY of these are true:
- Touches any `.mjs`, `.js`, `.ts`, `.yml` file
- Modifies 3+ files of any type
- Creates new scripts or features
- RFC phase moving to implementation
- `.json`/`.yml` edit that changes runtime behavior (CI, tool config, pattern indexes, generated behavior)

### Light (steps 1 and 4 only: plan + approval)

Applies when ALL of these are true:
- Modifies 1-2 non-code files (`.md`, metadata-only `.json`)
- Status changes not accompanied by code changes
- No behavioral or runtime impact

### Skip

- Single-file typo or comment fix, no semantic change
- Must be marked with exemption (see Exemptions below)

## Steps (in order)

1. Present implementation plan
2. Second-opinion review on the plan (cross-AI or subagent)
3. Fix all P1/P2 findings from the second review
4. Show final plan, wait for explicit approval (plan-gate)
5. Implement with unit tests written alongside code
6. Code review the implementation (local subagent; offer Codex as option)
7. Fix all code review bugs
8. End-to-end testing
9. Log all bugs to GitHub Issues with root cause + resolution (if connected)

## Pre-implementation Checkpoint

Required visible block before the first Edit/Write in any Full or Light task:

```
## Rule 18 checkpoint
- Task: <description>
- Classification: full / light / skip
- Plan: presented (link/date) / not needed
- Second opinion: done (by whom) / not needed
- Approval: received / not needed
```

- This is documentation of intent (medium enforcement per bp-010)
- Claude Code: backed by `plan-gate.sh` which hard-blocks Edit/Write when `.plan-approval-pending` exists (strong enforcement)
- Other tools: checkpoint block is the best available gate

## Post-implementation Checkpoint

Required before push/PR for Full tasks. References bp-006 pre-push checklist:

```
## Rule 18 post-implementation
- Tests: written alongside code / not needed
- Code review: done (by whom) / not needed
- E2E: passed / not needed
- Bugs logged: yes (issue #s) / none found
```

## Detection Triggers

- **Active trigger:** About to make the first code edit in a task — have all pre-implementation steps been completed?
- User requests a new feature or multi-file change
- RFC phase is moving to implementation
- Refactor with behavioral changes planned
- Any change modifying more than 3 files

## Enforcement

| Mechanism | Strength | Scope |
|-----------|----------|-------|
| `plan-gate.sh` (Rule 8) | Strong | Claude Code only |
| Pre-implementation checkpoint block | Medium | All tools |
| bp-006 pre-push checklist | Strong | All tools |
| Violation escalation via em-recall | Medium | All tools (when RFC-002 Phase 3 ships) |

## Exemptions

To skip for a qualifying change, include `[skip-bp-001: reason]` in the checkpoint block, local episodic memory note, or commit/PR message. Exemptions without reasons are violations.

## Why Violations Occur

The planning-to-implementation transition is where violations cluster. After completing a plan, the natural momentum is to begin coding immediately. The checkpoint must appear at this transition point — not before planning and not during implementation. bp-010 (habits-override-knowledge) confirms: cognitive enforcement fails under flow state; mechanical enforcement is required.

## Violation History (6 total; 5 most recent shown)

- 2026-05-01 (session 3): Phase 3 implementation — skipped pre/post checkpoints, E2E testing, and bug logging; only corrected after user caught it
- 2026-05-01 (session 2): RFC-002 status changed to accepted without review step
- 2026-05-01 (session 2): RFC-002 text fixes (F1-F4) applied without final plan
- 2026-05-01 (session 2): P3 fixes implemented without tests or code review
- 2026-05-01 (session 1): Pluggable patterns PR #7 pushed without tests (3 violations in one session)

## Related Patterns

- bp-006 (push-after-verify) — post-implementation gate
- bp-009 (store-violations-as-evidence) — violation tracking
- bp-010 (habits-override-knowledge) — enforcement philosophy
- bp-011 (local-before-git) — local-first workflow
