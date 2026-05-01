---
pattern_id: bp-011-local-before-git
name: "Local files first, git only for reviewed content"
category: decision
tags: [behavioral-pattern, bp-011-local-before-git, workflow, git, review, discipline]
scope: global
version: 1.0.0
---

# Local Files First, Git Only for Reviewed Content

When creating plans, review requests, or draft documents, write to local project files first. Get reviews done locally (subagents, episodic memory). Only commit and push after the content is reviewed and stable. Git is for reviewed artifacts, not drafts.

## Rules

1. Write draft content to local files (e.g., `docs/rfcs/`, `memory/`)
2. Run reviews locally (subagents, episodic memory search, local validation)
3. Iterate on findings locally — no commits during review cycles
4. Once content is stable and reviewed, commit and push
5. **Exception:** when an external reviewer (e.g., Codex) can only access content via GitHub, push to a feature branch first — but use a draft PR or issue, not a main-branch commit

## Detection triggers

- About to `git add` a file that hasn't been reviewed yet
- Creating a plan or RFC and reaching for `git commit` before getting a second opinion
- Writing a review request directly as a GitHub issue before the content exists locally

## Why this exists

Pushing draft content to git creates unnecessary commits, merge conflicts, and noise. Each review iteration adds another commit. The result is a messy history that obscures the actual implementation work.

## Scope

All projects, all AI tools. Applies to any content that will go through review before implementation.
