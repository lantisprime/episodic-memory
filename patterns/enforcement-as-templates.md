---
pattern_id: bp-005-enforcement-as-templates
name: "Enforcement lives in consuming repos, not rule repos"
category: decision
tags: [behavioral-pattern, bp-005-enforcement-as-templates, enforcement, ci, templates]
scope: global
version: 1.0.0
---

# Enforcement Lives in Consuming Repos

When a rule repo (like user-preferences) defines behavioral rules, the enforcement mechanisms (CI workflows, hooks, PR templates) should ship as **copyable templates**, not as forced installations. Each consuming repo decides what to adopt.

## The split

| Layer | Where | What |
|-------|-------|------|
| Rule definition | Rule repo (user-preferences) | The rule text and rationale |
| Reference templates | Rule repo (user-preferences) | CI workflow, PR template, hook scripts — as templates |
| Actual enforcement | Consuming repo | Each project copies and adapts the templates it needs |

## Why

- Not every repo uses the same CI (GitHub Actions vs GitLab CI vs none)
- Not every repo has the same structure (`scripts/` vs `src/` vs `lib/`)
- Forcing CI workflows on install couples the rule repo to GitHub
- Templates let projects adapt paths, thresholds, and exemptions

## Detection triggers

- Building enforcement for a cross-project rule
- Tempted to add CI workflows to a shared/template repo's installer
- User asks "should this enforcement go in repo X or repo Y?"

## Scope

All rule/template repos. The rule repo is the source of truth for **what** to enforce. The consuming repo is the source of truth for **how** to enforce it.
