---
pattern_id: bp-007-verify-before-push
name: "Self-check Rule 18 compliance before every push"
category: decision
tags: [behavioral-pattern, bp-007-verify-before-push, workflow, discipline, prevention]
scope: global
version: 1.0.0
---

# Self-Check Rule 18 Compliance Before Every Push

Before executing `git push`, pause and explicitly verify each Rule 18 step was completed. This pattern exists because Rule 18 was violated 3 times in one session by the agent who wrote it — proving that knowing a rule doesn't prevent violations.

## The checklist (run mentally before every push)

1. Was an implementation plan presented and approved?
2. Was a second-opinion review done on the plan?
3. Were review findings fixed?
4. Were unit tests written DURING implementation (not after)?
5. Was a code review done on the finished code?
6. Were code review bugs fixed?
7. Was E2E testing done?
8. Were bugs logged to GitHub Issues?

If ANY answer is "no" for a non-trivial change — STOP. Do not push. Complete the missing steps first.

## Detection triggers

- About to call `git push` or `git commit` on implementation code
- The words "let me push this and then..." — that's the violation signal
- Multiple commits on a branch before tests exist — sign of push-before-verify

## Why this exists

On 2026-05-01, Rule 18 was violated 3 times while building its own enforcement. Each time the pattern was: implement → push → get caught → remediate. The remediation produced messier PRs (fix-up commits, retroactive tests) than doing it right the first time.

## Scope

All projects, all AI tools. Non-trivial changes only — trivial fixes (typo, config, docs-only) can skip.
