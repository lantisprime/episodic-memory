# Install episodic-memory for Windsurf

Self-contained guide. Everything you need is here.

## WHEN TO USE
- You are setting up episodic memory for a Windsurf project.

## WHEN NOT TO USE
- You are installing for Claude Code, Cursor, Codex, OpenCode, or Pi Agent. Use that
  harness's file in this directory.
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
node <ABSOLUTE_PATH_TO_CLONE>/install.mjs --tool windsurf --project <ABSOLUTE_PATH_TO_TARGET_PROJECT>
```

Expected output (abbreviated; `<HOME>` is your resolved home, `<PROJ>` your project):

```
Installed 30 scripts to <HOME>/.episodic-memory/scripts
Seeded default LLM classifier config at <HOME>/.episodic-memory/classifier-config.json
Installed patterns/_index.json to <HOME>/.episodic-memory/patterns
Installed EM_SCRIPTS_GUIDE.md to <HOME>/.episodic-memory
Created empty .gitignore at <PROJ>/.gitignore (RFC-004 §671)
Added .episodic-memory/ to .gitignore
Added **/.episodic-memory/runs/*/run.key to .gitignore
Created BP-1 verify-key at <HOME>/.episodic-memory/.verify-key (mode 0600)
Created BP-1 config skeleton at <HOME>/.episodic-memory/config.json
Created <PROJ>/.windsurfrules
Seeded 11 behavioral patterns (0 already existed)

Done! Episodic memory is ready.
```

If `<PROJ>/.windsurfrules` already exists, the installer APPENDS the episodic-memory
section to it (and prints "Appended episodic-memory section to existing
.windsurfrules"), unless the file already contains an `episodic-memory` section, in
which case it prints ".windsurfrules already contains episodic-memory instructions"
and leaves the file unchanged.

## Artifacts (what lands where)

| Path | What |
|---|---|
| `~/.episodic-memory/scripts/` | 30 substrate scripts (em-*, em.mjs, second-opinion) + `lib/` |
| `~/.episodic-memory/EM_SCRIPTS_GUIDE.md` | agent-facing per-script reference |
| `~/.episodic-memory/patterns/_index.json` | pattern registry |
| `<project>/.windsurfrules` | the Windsurf rules (created or appended; points at the guide) |
| `<project>/.episodic-memory/` | local episode store |
| `<project>/.gitignore` | created/appended with `.episodic-memory/` + run.key pattern |

The Windsurf project tree after install is just:

```
<PROJ>/.windsurfrules
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

`em-store` prints `{"status":"ok","id":"...","file":"...","scope":"local"}`.
`em-list` prints `{"status":"ok","count":N,"episodes":[...]}`.

## Harness-specific traps

- `.windsurfrules` is created if absent, or appended if present. The installer will
  not duplicate the section on a re-run once it is present.
- Support is instruction-only: the rules tell the agent how to call the scripts. No
  hooks, no MCP server.
- Do NOT add the Claude Code hook / enforcement flags.

## Uninstall / reinstall

- Reinstall is idempotent: re-run the same command after `git pull`. If the section
  is already present the installer reports it and leaves `.windsurfrules` unchanged.
- To uninstall, remove the episodic-memory section from `<project>/.windsurfrules`
  (or delete the file if you created it only for this).

## Universal traps (apply to every harness)

- `--project` defaults to `process.cwd()`. Always pass an absolute `--project`.
- Never hand-write episode files or index rows. Known crash:
  `TypeError: (b.date + b.time).localeCompare is not a function` from `em-list` means
  a hand-appended index row lacks `date`/`time` (PR #447 read-side fix; issue #448
  writer-side). Repair: fix the frontmatter + index row, or delete the bad episode
  and run `em-rebuild-index --scope all`.
- Full per-script reference: `~/.episodic-memory/EM_SCRIPTS_GUIDE.md`.
