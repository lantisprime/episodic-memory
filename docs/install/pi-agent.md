# Install episodic-memory for Pi Agent

Self-contained guide. Everything you need is here.

## WHEN TO USE
- You are setting up episodic memory for a Pi Agent project.

## WHEN NOT TO USE
- You are installing for Claude Code, Cursor, Codex, OpenCode, or Windsurf. Use that
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
node <ABSOLUTE_PATH_TO_CLONE>/install.mjs --tool pi-agent --project <ABSOLUTE_PATH_TO_TARGET_PROJECT>
```

Expected output (abbreviated; `<HOME>` is your resolved home, `<PROJ>` your project):

```
Installed 21 scripts to <HOME>/.episodic-memory/scripts
Seeded default LLM classifier config at <HOME>/.episodic-memory/classifier-config.json
Installed patterns/_index.json to <HOME>/.episodic-memory/patterns
Installed EM_SCRIPTS_GUIDE.md to <HOME>/.episodic-memory
Created empty .gitignore at <PROJ>/.gitignore (RFC-004 §671)
Added .episodic-memory/ to .gitignore
Added **/.episodic-memory/runs/*/run.key to .gitignore
Created BP-1 verify-key at <HOME>/.episodic-memory/.verify-key (mode 0600)
Created BP-1 config skeleton at <HOME>/.episodic-memory/config.json
Installed Pi Agent skill to <PROJ>/.agents/skills/episodic-memory/SKILL.md
Seeded 11 behavioral patterns (0 already existed)

Done! Episodic memory is ready.
```

## Artifacts (what lands where)

| Path | What |
|---|---|
| `~/.episodic-memory/scripts/` | 21 substrate scripts (em-*, second-opinion) + `lib/` |
| `~/.episodic-memory/EM_SCRIPTS_GUIDE.md` | agent-facing per-script reference |
| `~/.episodic-memory/patterns/_index.json` | pattern registry |
| `<project>/.agents/skills/episodic-memory/SKILL.md` | the Pi Agent skill (points at the guide) |
| `<project>/.episodic-memory/` | local episode store |
| `<project>/.gitignore` | created/appended with `.episodic-memory/` + run.key pattern |

The Pi Agent project tree after install is just:

```
<PROJ>/.agents/skills/episodic-memory/SKILL.md
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

- CRITICAL: Do NOT hand-author episode `.md` files or hand-append `index.jsonl` rows.
  This is the exact failure that a Pi Agent session hit on 2026-07-04: it wrote an
  episode file plus a raw index row with frontmatter `created:` instead of
  `date:`/`time:`, and every later session then crashed on `em-list`
  (`TypeError: (b.date + b.time).localeCompare is not a function`). Always go through
  `em-store` / `em-revise` so the frontmatter and the index row are written together.
- Pi Agent uses the SAME destination as Codex:
  `.agents/skills/episodic-memory/SKILL.md`. If Codex is already installed (or you run
  `--tool all`), the Pi Agent step reports "already current". That is expected.
- Support is instruction-only in this slice: no hooks, no MCP server, no proactive
  session-start automation. The skill tells the agent how to call the scripts.
- Do NOT add the Claude Code hook / enforcement flags.

## Uninstall / reinstall

- Reinstall is idempotent: re-run the same command after `git pull`. Re-runs print
  "already current" and "All 11 behavioral patterns already seeded"; these are
  normal.
- To uninstall, remove `<project>/.agents/skills/episodic-memory/SKILL.md` (shared
  with Codex; remove only if neither tool needs it).

## Universal traps (apply to every harness)

- `--project` defaults to `process.cwd()`. Always pass an absolute `--project`.
- Never hand-write episode files or index rows (see the harness trap above). PR #447
  is the read-side fix; issue #448 tracks writer-side validation. Repair a bad store:
  fix the frontmatter + index row, or delete the bad episode and run
  `em-rebuild-index --scope all`.
- Full per-script reference: `~/.episodic-memory/EM_SCRIPTS_GUIDE.md`.
