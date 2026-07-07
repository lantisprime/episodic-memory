# Installing episodic-memory (per-harness agent guides)

This directory is the installation hub for AI coding agents. Each harness has one
self-contained file below. Read only the file for your harness; it repeats
everything you need so you do not have to read the others.

If you are a human looking for scenario walkthroughs (what the system feels like in
use), read `../USER_MANUAL.md` instead. For the per-script command reference used
after install, read `../EM_SCRIPTS_GUIDE.md` (also deployed to
`~/.episodic-memory/EM_SCRIPTS_GUIDE.md`).

## Which file to read

| Harness | Guide | Instruction artifact it installs |
|---|---|---|
| Claude Code | [claude-code.md](claude-code.md) | `.claude/skills/episodic-memory/SKILL.md` |
| Cursor | [cursor.md](cursor.md) | `.cursor/rules/episodic-memory.mdc` |
| Codex (OpenAI) | [codex.md](codex.md) | `.agents/skills/episodic-memory/SKILL.md` |
| OpenCode | [opencode.md](opencode.md) | `.opencode/skills/episodic-memory/SKILL.md` |
| Pi Agent | [pi-agent.md](pi-agent.md) | `.agents/skills/episodic-memory/SKILL.md` (shared with Codex) |
| Windsurf | [windsurf.md](windsurf.md) | `.windsurfrules` (created or appended) |

## The shared model (same for every harness)

- One global store per machine: `~/.episodic-memory/`. Holds the scripts, the
  global episodes, the pattern registry, the global index, and the deployed
  `EM_SCRIPTS_GUIDE.md`. Scripts are deployed here once and shared by every project
  and every tool.
- One local store per project: `<project>/.episodic-memory/`. Holds episodes scoped
  to that repo. Created by the installer.
- Searches read local and global together. Writes default to global; pass
  `--scope local` to keep an episode inside the current repo.
- The instruction artifact per tool (table above) is the only per-tool difference.
  The data and the scripts are shared.

## Prerequisites

- git (to clone the repo) and Node.js. The scripts are zero-dependency: Node.js
  standard library only, no npm install, no build step.
- Verified on Node v26.0.0 this session. Any recent LTS works; there is nothing to
  compile. Check with `node --version`.

## Install shape (details in each harness file)

```
git clone <repo-url> <ABSOLUTE_PATH_TO_CLONE>
node <ABSOLUTE_PATH_TO_CLONE>/install.mjs --tool <harness> --project <ABSOLUTE_PATH_TO_TARGET_PROJECT>
```

Interactive alternative — `node <ABSOLUTE_PATH_TO_CLONE>/install.mjs --wizard`
walks prerequisite checks, tool + project selection, optional Claude Code
hooks, optional backup config, the `em` PATH shim, and verifies the result
with `em-doctor`. The wizard also has a **migrate** flow (restore stores from
an em-backup repository, dry-run first) and a **doctor** flow. Answers are
plain stdin lines, so agents can script it:
`printf '1\n2\n/abs/project\nn\nn\n' | node install.mjs --wizard`.

Every install (all tools) prints, among other lines:

```
Installed 23 scripts to <HOME>/.episodic-memory/scripts
Installed patterns/_index.json to <HOME>/.episodic-memory/patterns
Installed EM_SCRIPTS_GUIDE.md to <HOME>/.episodic-memory
...
Done! Episodic memory is ready.
```

(Absolute paths in the real output are the resolved `~/.episodic-memory` and your
project path; abbreviated as `<HOME>` here.)

## Shared traps (read before installing)

1. `--project` defaults to `process.cwd()`. If you run `install.mjs` from inside the
   clone without `--project`, it installs the local store into the clone itself.
   Always pass `--project` with an absolute path to your real target project.
2. `--tool all` deliberately EXCLUDES OpenCode. OpenCode discovery loads
   `.opencode/skills`, `.claude/skills`, AND `.agents/skills`, so a broad all-tools
   install would expose duplicate `episodic-memory` skills. OpenCode is
   explicit-only: `--tool opencode`.
3. Codex and Pi Agent share the same destination:
   `.agents/skills/episodic-memory/SKILL.md`. Installing one then the other reports
   "already current" for the second (this is fine).
4. The hook / enforcement flags `--install-hooks`, `--install-enforcement`, and
   `--install-second-opinion` are Claude Code only. Enforcement is per-project, never
   written to `~/.claude`. Plain installs for the other tools must OMIT these flags.
5. The installer creates or appends the target project's `.gitignore`
   (`.episodic-memory/` plus a `run.key` pattern). This is expected, not a bug.
6. The installer is idempotent. Re-run it to refresh scripts after pulling a new
   version. Lines like "already current" and "All 11 behavioral patterns already
   seeded" on a re-run are normal.
7. NEVER hand-write episode `.md` files or hand-append rows to `index.jsonl`. On
   2026-07-04 a Pi Agent session hand-authored an episode plus a raw index row
   (frontmatter `created:` instead of `date:`/`time:`), which crashed `em-list` for
   every later session. Use `em-store` / `em-revise`. See trap 8.
8. Known error:
   `TypeError: (b.date + b.time).localeCompare is not a function`
   from `em-list` (or `em-search` without `--no-score`) means a hand-appended index
   row is missing `date` / `time`. Fixed read-side in PR #447; repair side closed in
   issue #448: `em-doctor` reports the row (`row-shape`), and
   `em-rebuild-index` (or `em-doctor --fix`) backfills `date`/`time` from the
   episode id prefix.

## After install

Verify the shared substrate with one command and read the command reference:

```
node <HOME>/.episodic-memory/scripts/em-doctor.mjs   # {"status":"ok",...} + exit 0 = healthy
ls <HOME>/.episodic-memory/scripts        # 23 scripts (21 em-*.mjs + em.mjs + second-opinion.mjs) + lib/
cat <HOME>/.episodic-memory/EM_SCRIPTS_GUIDE.md
```

The `em` unified CLI is at `<HOME>/.episodic-memory/bin/em` (`em help` lists
every command; `em doctor --fix` repairs index drift and stale lock/tmp litter).

Then follow your harness file for the tool-specific verify commands.
