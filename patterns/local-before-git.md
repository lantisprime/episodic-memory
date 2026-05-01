---
pattern_id: bp-011-local-before-git
name: "Local files first, external actions only after confirmation"
category: decision
tags: [behavioral-pattern, bp-011-local-before-git, workflow, git, github, review, discipline]
scope: global
version: 1.1.0
---

# Local Files First, External Actions Only After Confirmation

When creating plans, review requests, or draft documents, write to local project files first. Get reviews done locally (subagents, episodic memory). Only commit, push, or create GitHub issues/PRs after the content is reviewed and the user confirms the external action. Local operations and external operations are separate steps — never bundle them.

## Rules

1. Write draft content to local files (e.g., `docs/rfcs/`, `memory/`, episodic memory)
2. Run reviews locally (subagents, episodic memory search, local validation)
3. Iterate on findings locally — no commits during review cycles
4. Once content is stable and reviewed, commit and push
5. **After any local store, pause and confirm with the user before any external action** — this includes `git commit`, `git push`, `gh issue create`, `gh pr create`, GitHub comments, or any action visible outside the local machine
6. **Exception:** when an external reviewer (e.g., Codex) can only access content via GitHub, push to a feature branch first — but use a draft PR or issue, not a main-branch commit, and confirm with the user first

## Detection triggers

- About to `git add` a file that hasn't been reviewed yet
- Creating a plan or RFC and reaching for `git commit` before getting a second opinion
- Writing a review request directly as a GitHub issue before the content exists locally
- **Just stored something in local episodic memory and about to run a `gh` command in the same response** — stop and ask first
- About to create a GitHub issue, PR, or comment without explicit user instruction to do so

## Why this exists

Pushing draft content to git creates unnecessary commits, merge conflicts, and noise. Each review iteration adds another commit. GitHub issues and PRs created prematurely can't be undone — they notify watchers and create permanent records. The local-first approach keeps work private until the user is ready to share it.

## Violations

- 2026-05-01: Claude stored RFC-002 proposals in local episodic memory, then immediately created GitHub issue #14 without pausing for user confirmation. The local store was correct; the GitHub issue creation should have been a separate, confirmed step.

## Scope

All projects, all AI tools. Applies to any content that will go through review before implementation, and to any action that creates externally visible artifacts.
