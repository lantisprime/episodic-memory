---
pattern_id: bp-006-push-after-verify
name: "Push only after all verification steps complete"
category: decision
tags: [behavioral-pattern, bp-006-push-after-verify, workflow, git, discipline, prevention]
scope: global
version: 1.1.0
---

# Push Only After All Verification Steps Complete

Do not push code until all pre-push verification steps (unit tests, code review, E2E testing) are complete locally. The push is the deliverable — not a checkpoint.

## The anti-pattern

1. Implement code
2. Push to PR immediately ("save progress")
3. Write tests after pushing
4. Do code review after pushing
5. Fix bugs and push again

This turns tests and reviews into remediation instead of quality gates. The mindset shifts from "building" to "patching."

## The correct flow

1. Implement code + write unit tests alongside (same step)
2. Code review locally (read your own code critically)
3. Fix code review findings
4. Run E2E tests locally
5. THEN push — one clean commit or commit series
6. Create PR with confidence that all checks pass

## Pre-push checklist

Before every `git push`, run through these mentally:

1. Was an implementation plan presented and approved?
2. Was a second-opinion review done on the plan?
3. Were review findings fixed?
4. Were unit tests written DURING implementation (not after)?
5. Was a code review done on the finished code?
6. Were code review bugs fixed?
7. Was E2E testing done?
8. Were bugs logged to GitHub Issues?

If ANY answer is "no" for a non-trivial change — STOP. Do not push. Complete the missing steps first.

## Why this matters

- Pushing before testing creates a false sense of completion
- Once code is on a PR, the psychological pressure is to merge, not to rework
- Tests written after pushing tend to verify what was built, not what should have been built
- Code review after pushing becomes "find bugs to fix" instead of "catch design issues"

## Detection triggers

- About to run `git push` — pause and check: are all implementation workflow steps done (see bp-001)?
- The words "let me push this and then..." — that's the violation signal
- Feeling the urge to "save progress" to remote — that's the signal to slow down
- Multiple fix-up commits on a PR — sign that verification was done post-push

## Scope

All projects, all AI tools. Non-trivial changes only — trivial fixes (typo, config, docs-only) can skip.

## Origin

Discovered during episodic-memory Phase 1 + behavioral patterns implementation. The implementation workflow (bp-001) was violated three times in one session while building its own enforcement. Each time: implement → push → get caught → remediate. The remediation produced messier PRs (fix-up commits, retroactive tests) than doing it right the first time.
