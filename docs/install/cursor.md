# Install episodic-memory for Cursor

Self-contained guide. Everything you need is here.

## WHEN TO USE
- You are setting up episodic memory for a Cursor project.

## WHEN NOT TO USE
- You are installing for Claude Code, Codex, OpenCode, Pi Agent, or Windsurf. Use
  that harness's file in this directory.
- Do NOT pass `--install-hooks`, `--install-enforcement`, or
  `--install-second-opinion`. Those are Claude Code only.

## Prerequisites
- git and Node.js (standard library only; zero npm dependencies, no build step).
- Verified on Node v26.0.0; any recent LTS works. Check: `node --version`.

## Step 1: clone

```
git clone <repo-url> <ABSOLUTE_PATH_TO_CLONE>
```

## Step 2: install

Run from anywhere. Always pass `--project` with an absolute path so the installer
does not target the clone itself.

```
node <ABSOLUTE_PATH_TO_CLONE>/install.mjs --tool cursor --project <ABSOLUTE_PATH_TO_TARGET_PROJECT>
```

Expected output (abbreviated; `<HOME>` is your resolved home, `<PROJ>` your project):

```
Installed 23 scripts to <HOME>/.episodic-memory/scripts
Seeded default LLM classifier config at <HOME>/.episodic-memory/classifier-config.json
Installed patterns/_index.json to <HOME>/.episodic-memory/patterns
Installed EM_SCRIPTS_GUIDE.md to <HOME>/.episodic-memory
Created empty .gitignore at <PROJ>/.gitignore (RFC-004 §671)
Added .episodic-memory/ to .gitignore
Added **/.episodic-memory/runs/*/run.key to .gitignore
Created BP-1 verify-key at <HOME>/.episodic-memory/.verify-key (mode 0600)
Created BP-1 config skeleton at <HOME>/.episodic-memory/config.json
Installed Cursor rules to <PROJ>/.cursor/rules/episodic-memory.mdc
Seeded 11 behavioral patterns (0 already existed)

Done! Episodic memory is ready.
```

The BP-1 verify-key / config skeleton and the pattern seed are shared global setup;
they are created once and skipped on later installs.

## Artifacts (what lands where)

| Path | What |
|---|---|
| `~/.episodic-memory/scripts/` | 21 substrate scripts (em-*, second-opinion) + `lib/` |
| `~/.episodic-memory/EM_SCRIPTS_GUIDE.md` | agent-facing per-script reference |
| `~/.episodic-memory/patterns/_index.json` | pattern registry |
| `<project>/.cursor/rules/episodic-memory.mdc` | the Cursor rule (points at the guide) |
| `<project>/.episodic-memory/` | local episode store |
| `<project>/.gitignore` | created/appended with `.episodic-memory/` + run.key pattern |

The Cursor project tree after install is just:

```
<PROJ>/.cursor/rules/episodic-memory.mdc
<PROJ>/.gitignore
```

(plus the created-but-empty `<PROJ>/.episodic-memory/` store).

## Post-install verify

Run these from your target project root: `--scope local` resolves the local store
from the current working directory, so running them elsewhere writes to the wrong
repo's `.episodic-memory/`.

```
ls ~/.episodic-memory/scripts
cat ~/.episodic-memory/EM_SCRIPTS_GUIDE.md
node ~/.episodic-memory/scripts/em-store.mjs --project <name> --category decision --summary "install smoke" --body "verifying store" --scope local
node ~/.episodic-memory/scripts/em-list.mjs --project <name> --limit 5
```

`em-store` prints:

```json
{"status":"ok","id":"20260704-133309-install-smoke-....","file":".../episodes/....md","scope":"local"}
```

`em-list` prints `{"status":"ok","count":N,"episodes":[...]}`.

## Harness-specific traps

- The Cursor rule is `alwaysApply: true`, so it loads every session. No further
  wiring is needed.
- Do NOT add the Claude Code hook / enforcement flags. There are no Cursor hooks in
  this installer slice; the rule tells the agent how to call the scripts.

## Uninstall / reinstall

- Reinstall is idempotent: re-run the same command after `git pull`. The Cursor rule
  file is silently overwritten with the fresh copy; a re-run prints
  "All 11 behavioral patterns already seeded", which is normal.
- To uninstall, remove `<project>/.cursor/rules/episodic-memory.mdc`. The shared
  global store under `~/.episodic-memory/` is left intact.

## Universal traps (apply to every harness)

- `--project` defaults to `process.cwd()`. Always pass an absolute `--project`.
- Never hand-write episode files or index rows. Known crash:
  `TypeError: (b.date + b.time).localeCompare is not a function` from `em-list` means
  a hand-appended index row lacks `date`/`time` (PR #447 read-side fix; issue #448
  writer-side). Repair: fix the frontmatter + index row, or delete the bad episode
  and run `em-rebuild-index --scope all`.
- Full per-script reference: `~/.episodic-memory/EM_SCRIPTS_GUIDE.md`.
