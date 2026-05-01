---
pattern_id: bp-009-store-violations-as-evidence
name: "Store rule violations as evidence for enforcement"
category: decision
tags: [behavioral-pattern, bp-009-store-violations-as-evidence, discipline, learning, enforcement]
scope: global
version: 2.0.0
---

# Store Rule Violations as Evidence for Enforcement

When a rule is violated, store the violation using `em-violation.mjs` (category: `violation`). The violation is data — it proves the rule needs mechanical enforcement, documents the failure pattern, and prevents the same mistake in future sessions.

## How to store

```bash
node ~/.episodic-memory/scripts/em-violation.mjs \
  --pattern <pattern_id> \
  --summary "<what happened>" \
  --body "<why it happened, context>" \
  --sequence "<action1,action2,...>" \
  --correct "<action1,action2,...>"
```

The script auto-tags with `violation`, `behavioral-pattern`, and `violated:<pattern_id>`, validates the pattern exists, and builds a structured body with "What happened", "Violation sequence", and "Correct sequence" sections.

## Why this matters

- A rule that is only documented but never enforced will be violated. The violation proves enforcement is needed.
- Future sessions can search for past violations of the same rule and preemptively avoid them.
- Patterns of violations across sessions reveal systemic issues (e.g., "The implementation workflow (bp-001) is always violated on the first implementation after planning" → add a checkpoint between planning and implementation).

## Detection triggers

- Any time a rule is violated and caught (by the user, by CI, by self-review)
- The phrase "I should have..." or "I forgot to..." — that's a violation worth storing
- When building enforcement for a rule — search for past violations first to understand the failure modes

## What NOT to store

- Intentional exemptions (e.g., `[skip-bp-001]` for docs-only changes)
- Rules that were followed correctly (that's normal, not noteworthy)

## Scope

All projects, all AI tools. Store as global episodes. Auto-tagged: `violation`, `behavioral-pattern`, `violated:<pattern_id>` (e.g., `violated:bp-006-push-after-verify`).
