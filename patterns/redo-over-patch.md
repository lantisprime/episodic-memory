---
pattern_id: bp-008-redo-over-patch
name: "Redo properly instead of patching retroactively"
category: decision
tags: [behavioral-pattern, bp-008-redo-over-patch, discipline, quality, git]
scope: global
version: 1.0.0
---

# Redo Properly Instead of Patching Retroactively

When a process violation is caught (skipped tests, missing review, wrong order), close/revert the work and redo it from scratch following the correct process. Do not patch with follow-up commits.

## Why redo beats patching

- **Patching produces messy history.** Fix-up commits, "add missing tests" commits, and "address review" commits obscure the original intent. A redo produces one clean commit.
- **Patching shifts the mindset.** When you patch, you're in "fix what's broken" mode. When you redo, you're in "build it right" mode. The quality of the output differs.
- **Patching validates the shortcut.** If patching is accepted, the lesson is "skip steps, fix later." If redo is required, the lesson is "do it right the first time."
- **Patching leaves ambiguity.** Did the test actually cover the code? Was the review thorough? With a redo, the steps are done in order and the evidence is clear.

## Detection triggers

- A process violation is discovered after code is pushed
- PR has fix-up commits that add missing tests or address skipped reviews
- Someone says "I'll add the tests in a follow-up PR"

## The correct response

1. Acknowledge the violation
2. Close the PR with an explanation
3. Delete the branch
4. Start fresh on a new branch
5. Follow the correct process step by step
6. Push once all steps are complete

## Scope

All projects, all AI tools. Applies to process violations, not code bugs. Code bugs found during review should be fixed in place.

## Origin

PR #7 was patched retroactively. PR #9 was redone properly. PR #9 was cleaner: single commit, no fix-up chain, full Rule 18 compliance.
