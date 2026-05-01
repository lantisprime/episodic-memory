---
pattern_id: bp-009-store-violations-as-evidence
name: "Store rule violations as evidence for enforcement"
category: decision
tags: [behavioral-pattern, bp-009-store-violations-as-evidence, discipline, learning, enforcement]
scope: global
version: 1.0.0
---

# Store Rule Violations as Evidence for Enforcement

When a rule is violated, store the violation in episodic memory as a discovery. The violation is data — it proves the rule needs mechanical enforcement, documents the failure pattern, and prevents the same mistake in future sessions.

## What to store

- Which rule was violated
- The exact sequence of actions that led to the violation
- Why the violation happened (flow state, urgency, forgot, didn't apply)
- What the correct sequence should have been
- Whether mechanical enforcement exists and whether it would have caught this

## Why this matters

- A rule that is only documented but never enforced will be violated. The violation proves enforcement is needed.
- Future sessions can search for past violations of the same rule and preemptively avoid them.
- Patterns of violations across sessions reveal systemic issues (e.g., "Rule 18 is always violated on the first implementation after planning" → add a checkpoint between planning and implementation).

## Detection triggers

- Any time a rule is violated and caught (by the user, by CI, by self-review)
- The phrase "I should have..." or "I forgot to..." — that's a violation worth storing
- When building enforcement for a rule — search for past violations first to understand the failure modes

## What NOT to store

- Intentional exemptions (e.g., `[skip-rule18]` for docs-only changes)
- Rules that were followed correctly (that's normal, not noteworthy)

## Scope

All projects, all AI tools. Store as global episodes with tags: violated rule name, `violation`, `learning`.
