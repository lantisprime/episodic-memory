---
pattern_id: bp-010-habits-override-knowledge
name: "Habits override knowledge — always add mechanical enforcement"
category: decision
tags: [behavioral-pattern, bp-010-habits-override-knowledge, discipline, enforcement, cognitive-bias]
scope: global
version: 1.0.0
---

# Habits Override Knowledge — Always Add Mechanical Enforcement

When a rule is important enough to define, add a mechanical enforcement mechanism. Knowing a rule does not prevent violations — habits and flow state override conscious knowledge.

## The evidence

On 2026-05-01, an AI agent:
- Wrote Rule 18 (implementation workflow)
- Got it reviewed by two independent AIs
- Stored it as a behavioral pattern
- Started building CI enforcement for it
- Violated it 3 times in the same session

If the author of the rule can't follow it while actively building its enforcement, no one will follow it under normal conditions.

## The principle

For every documented rule, ask: "What mechanically prevents this from being violated?"

| Enforcement type | Strength | Example |
|------------------|----------|---------|
| Documentation only | Weak — skipped under pressure | AGENT-RULES.md |
| Behavioral pattern in memory | Medium — surfaced at session start but can be ignored | bp-001 in episodic memory |
| PR template checklist | Medium — visible but not blocking | Rule 18 checklist |
| CI status check | Strong — blocks merge | rule18-check.yml |
| Pre-commit/pre-push hook | Strong — blocks locally | plan-gate.sh |

Always aim for at least one "strong" enforcement for important rules.

## Detection triggers

- Writing a new rule in documentation
- Saying "from now on, always do X" — that needs enforcement, not just a note
- Reviewing AGENT-RULES and finding rules with no CI or hook backing them

## Scope

All projects, all AI tools. This is a meta-pattern about how to make rules stick.
