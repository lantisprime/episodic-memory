# PLAN — Session auto-capture (wave 6 #2)

**Status:** ready to execute. **Executor:** any capable agent session (written for Opus 4.8 with zero prior context). **Authorized by:** maintainer (2026-07-07, in-session; scope may exceed CAPABILITIES.md/PRINCIPLES.md where noted). **Predecessors:** PRs #464–#467 + the em-graph commit on `claude/episodic-memory-improvements-anlbxt`.

## Goal

Memory only works if things get stored, and today storing depends on agent discipline. Build **session auto-capture**: at session end, candidate episodes (decisions, lessons, discoveries) are *drafted automatically* from the session transcript; the next session (or the user) *confirms* them into the store instead of authoring from scratch. Drafts are never silently promoted to episodes — confirm-before-store is the design invariant.

## Architecture (respect the substrate/enforcement split — RFC-008)

Three pieces, mirroring patterns already proven in this repo:

### 1. `scripts/em-capture.mjs` (substrate; auto-deploys via the `em-*` allowlist)

```
em-capture extract [--transcript <path>] [--session-id <id>] [--project <name>]
                   [--mode heuristic|cmd] [--cmd "<command>"] [--max <n>] [--dry-run]
em-capture list                                   # pending drafts across scopes
em-capture review --draft <id> (--accept <n,...> | --accept-all | --reject <n,...> | --discard)
```

- **Draft storage:** `~/.episodic-memory/drafts/<draft-id>.json` (draft-id = same `YYYYMMDD-HHMMSS-<slug>-<hex4>` shape as episodes). Draft = `{ id, session_id, project, ts, source: "transcript-path", candidates: [{ category, summary, body, tags, confidence, evidence_excerpt }] }`. Drafts are NOT episodes: no index.jsonl rows, invisible to search/recall ranking.
- **`extract` heuristic mode (default, zero-LLM):** reuse `scripts/lib/transcript-walker.mjs` (already ships; used by `em-mine-transcripts.mjs` — read that script first, it solves transcript discovery for Claude Code under `~/.claude/projects/<slug>/`). Candidate signals, each with an `evidence_excerpt`:
  - explicit markers: user text matching `remember this|save this|note that|lesson:|decision:` (case-insensitive)
  - decision language in assistant text: `decided to|chose X over Y|going with` near a user approval
  - error→fix pairs: a failing command output followed by a passing rerun of the same command → `discovery`/`lesson` candidate
  - merged-PR / milestone lines (`PR #\d+ .*merged`) → `milestone`
  - Cap via `--max` (default 5); confidence = crude tier (marker 0.9 / decision 0.6 / error-fix 0.5 / milestone 0.7).
- **`extract` cmd mode (LLM, opt-in):** same command-protocol pattern as `em-embed --cmd` and `examples/rerankers/claude-rerank.sh` (READ BOTH — they are the template): pipe `{session_text_chunks}` JSON to a user command, get `{candidates:[...]}` JSON back. Ship `examples/capturers/claude-capture.sh` driving `claude -p` (the user's Claude Code OAuth login — no API key). Persisted default via `capture_cmd` key in `~/.episodic-memory/embed-config.json`? **No** — use a separate `~/.episodic-memory/capture-config.json` (`{mode, cmd, max}`); keep configs single-purpose.
- **`review --accept`:** accepted candidates are written **through `em-store.mjs` as a subprocess** (never hand-write episode files/index rows — Hard Rule 1; category validation, tags, tokens.json all come free). Add tag `auto-captured`. Then the draft file is updated (accepted entries marked with the resulting episode id) or deleted when fully resolved.
- **Category safety:** candidate categories must come from `loadCategories()` (scripts/lib/categories.mjs). NEVER a hardcoded category array — the CI guard `testNoHardcodedCategoryList` (tests/test-categories-lib.mjs) rejects any `['decision', ...]`-shaped literal in scripts/*.mjs. Heuristics may map marker→category via single-string constants (single values are allowed; arrays are not).

### 2. Hook wiring (enforcement/per-project layer — NOT global)

- Extend the **existing SessionEnd path**: `scripts/em-session-end-prompt.mjs` is the SessionEnd hook (enforcement-layer, installs per-project via `--install-hooks`; see `scripts/lib/install-manifest.mjs` `SESSION_END_SCRIPT` + `HOOK_SPECS`). Do **not** make em-capture itself a hook script (it must stay substrate/global). Instead: the SessionEnd hook additionally invokes `node ~/.episodic-memory/scripts/em-capture.mjs extract --session-id <id>` best-effort (never blocks session end; swallow failures to stderr).
- **em-recall purity (CRITICAL):** `em-recall.mjs` may gain a `pending_drafts: <n>` count in its output (pure memory-side read of the drafts dir). It must NOT gain any enforcement tokens — `tests/test-em-recall-purity.mjs` (F60) greps for a forbidden token class and `install.mjs` has a matching F45 sentinel. Check `scripts/lib/em-recall-purity.mjs` for the forbidden list before editing em-recall. The REQUIRED_RECALL tokens (`loadIndex`, `inferContext`, `preflight_warnings`, `--scope`, `--project`, `--limit`) must all survive.
- Wizard: add a capture step AFTER the routines step (`scripts/install-wizard.mjs`, function order in `flowInstall`). **EOF/enter must default to skip** — existing piped-answer test sequences in `tests/test-install-wizard.mjs` rely on starved answers defaulting safely. Follow `maybeConfigureSemantic`/`maybeConfigureRoutines` as templates.

### 3. Maintenance integration

- `em-doctor.mjs`: new `drafts` check — pending drafts older than 14 days → warn ("review or discard: em-capture list"). Follow the existing per-check `report(id, scope, level, message, extra)` pattern.
- `em-routines.mjs`: no new builtin needed (capture is event-driven, not scheduled). Optionally mention drafts in `hygiene-report`.

## Repo conventions the executor MUST follow (all enforced by tests/CI)

1. **Zero npm dependencies**, Node stdlib only; every script prints exactly one JSON object to stdout; `--help/-h` short-circuits with `{status:'help',script,usage}` (tests/test-em-help-flags.mjs auto-covers new `em-*` scripts).
2. New `em-capture.mjs` auto-joins the substrate allowlist by name (`isSubstrateScript` in scripts/lib/install-manifest.mjs) and the `em` CLI by directory discovery — only add a `DESCRIPTIONS` line in `scripts/em.mjs`.
3. **Update installed-script counts** in docs: `docs/install/README.md` + all six per-harness files say "Installed 32 scripts" / "32 substrate scripts" today; em-capture makes it 33. Grep `"32 scripts\|32 substrate"` and bump.
4. **Testing bar is runtime probes, not smoke** (maintainer instruction): isolated `HOME` + fixture stores via `fs.mkdtempSync`; byte-level store snapshots proving no-write on every refusal/dry-run path; drive the real scripts, never stubs of them. Templates: `tests/test-em-move.mjs` (snapshot/no-write helpers), `tests/test-em-routines.mjs` (platform-binary shims), `tests/test-embedder-presets.mjs` (**external-process stub server** — an in-process server deadlocks against spawnSync, learned the hard way).
5. **Shell adapters:** pass python through `-c` with double-quote-only strings, never a heredoc (`<<'PY'` replaces stdin and silently swallows piped JSONL — bug class hit twice; see NOTE comments in `examples/embedders/*.sh`).
6. **Transcript parsing:** bodies/texts scanned for signals must strip fenced code blocks + inline backticks before matching (fabricated-signal class; see `bodyCitations` in `scripts/em-graph.mjs`).
7. **Git hygiene:** `git config user.email noreply@anthropic.com && git config user.name Claude` before committing (stop-hook rejects other committers). Force-push is blocked by the environment — if the designated branch (`claude/episodic-memory-improvements-anlbxt`) holds already-merged history, `git merge origin/<branch>` content-neutrally instead (precedent in this branch's history). Merging PRs requires the maintainer's admin bypass (self-approval impossible — same account).
8. **CI test registration:** CI workflows run *explicitly listed* test files (see `.github/workflows/plugin-validate.yml` — `run: node tests/test-*.mjs` lines). Add the new test files to the appropriate workflow, and while there, check whether the wave-1..6 test files (test-relevance, test-recall-v2, test-em-move, test-em-stats-semantic, test-em-consolidate, test-embedder-presets, test-em-routines, test-em-graph, test-em-doctor, test-em-cli, test-install-wizard) are listed — if not, register them in the same PR (they currently run only locally).

## Test plan (new `tests/test-em-capture.mjs`, ~10 cases)

1. heuristic extract from a synthetic transcript fixture (build a fake `~/.claude/projects/<slug>/<session>.jsonl` matching transcript-walker's expected shape — copy a fixture from `tests/` if one exists for em-mine-transcripts): marker/decision/error-fix/milestone candidates each detected with evidence excerpts; `--max` caps.
2. code blocks in transcripts never produce candidates (fabricated-signal guard).
3. drafts land in `drafts/`, are NOT in index.jsonl, invisible to em-search/em-recall results (except the `pending_drafts` count).
4. `--dry-run` writes nothing (byte snapshot).
5. `review --accept` stores through em-store: episode exists, indexed, tokens.json updated, tagged `auto-captured`; draft resolved.
6. `review --reject/--discard` never writes episodes.
7. cmd mode via a deterministic python capturer (external process); failing command → error, no partial drafts.
8. `claude-capture.sh` plumbing via `$CLAUDE_BIN` shim (template: the claude-rerank test in test-em-stats-semantic.mjs).
9. em-recall emits `pending_drafts` and purity suite still passes (`node tests/test-em-recall-purity.mjs`).
10. doctor `drafts` staleness warn; wizard capture step opt-in/skip (extend test-install-wizard.mjs).

**Regression sweep before shipping** (all green as of this plan): relevance, recall-v2, em-move, em-stats-semantic, em-consolidate, embedder-presets, em-routines, em-graph, em-doctor, em-cli, install-wizard, phase2, phase3, category-*, em-recall-purity, em-help-flags, p12-*, bp1-build-artifact-manifest, migration-cutover, em-restore, categories-lib, seed-patterns + `validate-schemas` + `em-rfc-validate`.

## Docs

README (new "Auto-capture" section under Scripts Reference), `docs/EM_SCRIPTS_GUIDE.md` (full em-capture entry + intent-routing row "significant session, nothing stored yet → em-capture"), install docs (wizard step mention + script count), `examples/capturers/` README-comment header in the adapter.

## Acceptance (falsifiable)

- Fresh install e2e in isolated HOME: install → run a synthetic session transcript through `em-capture extract` → `em-capture review --accept-all` → `em-search` finds the episode → `em-doctor` fully green.
- All 10 new cases + full sweep green; CI workflow updated to run them.
- No hardcoded category arrays (categories-lib guard green); em-recall purity green; no enforcement scripts in the global scripts dir (p12 gate green).

## Known open items adjacent to this work (do not block on them)

- Pre-existing `test-rfc002-phase3` T6b failure (fails on clean main; environment-specific).
- GitHub connector may need re-auth for PR creation; the branch push always works.
- `npx` distribution and Windows (`schtasks` routines backend) remain unplanned waves.
