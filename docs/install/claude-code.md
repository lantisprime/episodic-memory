# Install episodic-memory for Claude Code

Self-contained guide. Everything you need is here.

## WHEN TO USE
- You are setting up episodic memory for a Claude Code project.
- You want proactive session-start recall and (optionally) the checkpoint / plan /
  stop enforcement gates.

## WHEN NOT TO USE
- You are installing for Cursor, Codex, OpenCode, Pi Agent, or Windsurf. Use that
  harness's file in this directory.

## Prerequisites
- git and Node.js (standard library only; zero npm dependencies, no build step).
- Verified on Node v26.0.0; any recent LTS works. Check: `node --version`.

## Step 1: clone

```
git clone <repo-url> <ABSOLUTE_PATH_TO_CLONE>
```

## Step 2: install (plain)

Run from anywhere. Always pass `--project` with an absolute path so the installer
does not target the clone itself.

```
node <ABSOLUTE_PATH_TO_CLONE>/install.mjs --tool claude-code --project <ABSOLUTE_PATH_TO_TARGET_PROJECT>
```

Expected output (abbreviated; `<HOME>` is your resolved home, `<PROJ>` your project):

```
Installed 32 scripts to <HOME>/.episodic-memory/scripts
Seeded default LLM classifier config at <HOME>/.episodic-memory/classifier-config.json
Installed patterns/_index.json to <HOME>/.episodic-memory/patterns
Installed EM_SCRIPTS_GUIDE.md to <HOME>/.episodic-memory
Created empty .gitignore at <PROJ>/.gitignore (RFC-004 §671)
Added .episodic-memory/ to .gitignore
Added **/.episodic-memory/runs/*/run.key to .gitignore
Created BP-1 verify-key at <HOME>/.episodic-memory/.verify-key (mode 0600)
Created BP-1 config skeleton at <HOME>/.episodic-memory/config.json
Installed BP-1 H2 SessionStart hook at <PROJ>/.claude/hooks/bp1-sweep-on-session.sh
Wired BP-1 H2 SessionStart hook into <PROJ>/.claude/settings.json
Note: artifact_version_hash changed; activated projects must re-run M5 to regenerate.
Installed BP-1 H1 SessionStart hook at <PROJ>/.claude/hooks/bp1-approval-check.sh
Wired BP-1 H1 SessionStart hook into <PROJ>/.claude/settings.json (h1-inserted-before-h2)
Installed Claude Code skill to <PROJ>/.claude/skills/episodic-memory/SKILL.md
Installed Claude Code classify-correction skill to <PROJ>/.claude/skills/classify-correction/SKILL.md
Seeded 11 behavioral patterns (0 already existed)

Done! Episodic memory is ready.
```

Note: the BP-1 auto-pilot hooks are CORE for Claude Code and install per-project on a
plain install (not gated on any flag). The `artifact_version_hash changed` line is
informational on a fresh install.

## Optional flags (Claude Code only)

Add these only if you want them. They are Claude Code only and never write to
`~/.claude`.

- `--install-hooks`: install the non-enforcement hooks (SessionStart recall,
  session-handoff, SessionEnd prompt) into `<project>/.claude/` and register them in
  `<project>/.claude/settings.json`.
- `--install-enforcement`: install the per-project enforcement gates
  (checkpoint-gate, plan-gate, preflight-gate, stop-gate) plus their lib closure and
  the enforce-contract config set under `<project>/.claude/`, and seed
  `<project>/.episodic-memory/enforce-config.json` = `{"active": true}` (create if
  absent; never overwritten).
- `--install-second-opinion`: write the second-opinion provider snapshot to
  `~/.claude/hooks/second-opinion-providers.json` and gate direct provider calls.
- `--install-hooks-force`: overwrite locally edited hook files.

Turn enforcement off for one project without touching other repos by editing
`<project>/.episodic-memory/enforce-config.json` to `{"active": false}`. A missing,
empty, or malformed file leaves enforcement fully ON (fail-closed).

## Artifacts (what lands where)

| Path | What |
|---|---|
| `~/.episodic-memory/scripts/` | 32 substrate scripts (em-*, em.mjs, second-opinion) + `lib/` |
| `~/.episodic-memory/EM_SCRIPTS_GUIDE.md` | agent-facing per-script reference |
| `~/.episodic-memory/patterns/_index.json` | pattern registry |
| `~/.episodic-memory/classifier-config.json`, `config.json`, `.verify-key` | global config seeds (create-if-absent) |
| `<project>/.claude/skills/episodic-memory/SKILL.md` | the episodic-memory skill (points at the guide) |
| `<project>/.claude/skills/classify-correction/SKILL.md` | classifier-correction skill |
| `<project>/.claude/hooks/bp1-*` + `hooks/lib/bp1-*` | BP-1 auto-pilot hooks (core) |
| `<project>/.claude/settings.json` | SessionStart hook registrations |
| `<project>/.episodic-memory/` | local episode store |
| `<project>/.gitignore` | created/appended with `.episodic-memory/` + run.key pattern |

With `--install-enforcement` you additionally get `<project>/.claude/hooks/`
checkpoint-gate.sh, plan-gate.sh, preflight-gate.sh, stop-gate.sh, their `hooks/lib`
closure, `hooks/patterns/`, and `<project>/.episodic-memory/enforce-config.json`.

## Post-install verify

```
ls ~/.episodic-memory/scripts
cat ~/.episodic-memory/EM_SCRIPTS_GUIDE.md
node ~/.episodic-memory/scripts/em-recall.mjs --project <name> --limit 3
```

`em-recall` prints JSON of this shape:

```json
{"status":"ok","context":{"project":"<name>","branch_tokens":["..."],"effective_tokens":["..."],"task_type":null},"count":3,"episodes":[{"id":"...","summary":"...","source":"global","score":0.998}],"preflight_warnings":[],"prune_suggestion":null}
```

Store a test episode and read it back:

```
node ~/.episodic-memory/scripts/em-store.mjs --project <name> --category decision --summary "install smoke" --body "verifying store" --scope local
node ~/.episodic-memory/scripts/em-list.mjs --project <name> --limit 5
```

`em-store` prints `{"status":"ok","id":"...","file":"...","scope":"local"}`; `em-list`
returns `{"status":"ok","count":N,"episodes":[...]}`.

## Harness-specific traps

- The BP-1 hooks are core and register in `<project>/.claude/settings.json` even on a
  plain install. That is intended.
- Enforcement is per-project. Nothing episodic-memory installs should write to
  `~/.claude` except the second-opinion snapshot under `--install-second-opinion`.
- Do not pass enforcement flags when you only want the memory substrate.

## Uninstall / reinstall

- Reinstall is idempotent: re-run the same command after `git pull` to refresh
  scripts and the guide. Re-runs print "already current" and "All 11 behavioral
  patterns already seeded"; these are normal.
- Remove enforcement for one project: `--uninstall-enforcement` (add `--purge-config`
  to also delete `enforce-config.json`).
- Opt out of gates entirely: do not pass the hook/enforcement flags, or remove the
  hook entries from `<project>/.claude/settings.json`.

## Universal traps (apply to every harness)

- `--project` defaults to `process.cwd()`. Always pass an absolute `--project`.
- Never hand-write episode files or index rows. Known crash:
  `TypeError: (b.date + b.time).localeCompare is not a function` from `em-list` means
  a hand-appended index row lacks `date`/`time` (PR #447 read-side fix; #448 repair
  side closed). Repair: `em-doctor --fix` (or `em-rebuild-index --scope all`) —
  the rebuild backfills `date`/`time` from the episode id prefix.
- Full per-script reference: `~/.episodic-memory/EM_SCRIPTS_GUIDE.md`.
