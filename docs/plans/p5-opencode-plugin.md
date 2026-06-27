# P5 — OpenCode enforcement plugin Plan

## §1 Status

`Planning only.` Do not implement until this plan, the plan review, and the adversarial
review are accepted (Rule 18). Current stage: **review-consensus ACCEPT (round 3); awaiting user Rule 18 step-4 approval.**

| Field | Value |
|---|---|
| RFC | `RFC-008` |
| Parent requirements | `R6` (plugin-to-harness binding), `R10` (enforcement runbooks); principle anchors P4, P9, P11 |
| Workplan episode | `20260622-095311-workplan-v147-rfc-008-p4d-complete-s8-me-e996` |
| Target branch | `feat/rfc-008-p5-opencode-plugin` |
| **Executor altitude (§0.1)** | **`low`** — target executor is **Haiku** or **DeepSeek V4 Flash**. Appendix A (A.1-A.9) is **mandatory** and is the build path. Every step names one file, a verbatim anchor or full CREATE contents, and a falsifiable (behavioral) verify. |

**Rounds 1+2 adversarial review folded (§19.1, §19.2).** Round 1 (HOLD, 2B+4M): tool_result→MEDIUM
(B1); decision surface re-architected onto the real `repo-source.sh` carve-outs + a new S4 (B2/M3);
fixture-dir param (M1); synchronous turn_index (M2); unsound E2E branch deleted (M4); cwd-divergence
fixture (axis-9). Round 2 (HOLD, 1B+1M+2m; B1/M1 cleared): the round-1 decision-surface fix was still
mis-modeled as a pipe — round-2 **corrects the boundary** to the live gate's real two-layer **AND**
(`toolTargetsRepoSource` AND `gateDisposition.token∈{enforce,block}`), resolves the disposition wiring
inline (B-NEW-2/4), mandates exact-segment carve-out matching + boundary parity corpus (B-NEW-1),
deploy-safe JSON with bash fallback (B-NEW-3), and scopes the bp-001 marker lifecycle out as OD-4.

**Executor-readiness by slice:** S1 and S2 are fully mechanical now. S3 (runbook byte-derivation),
S4 (repo-source extraction), S5 (adapter+bridge), and S6 (install) carry `<READ-PIN>` cells closed by
the §A.0 pre-authoring reads; do not hand those to a weak executor until §A.0 is discharged.

## §2 Episode Search Summary

```bash
node scripts/em-search.mjs --tag rfc-008 --tag workplan --scope all --limit 10 --full --no-track
```

Key active memories constraining this plan:

- `…e996` (workplan v147): next = P5-P8 tool breadth; P5 = `plugins/opencode/`. This plan is that work.
- `…7918` verify-the-strong-claim: E2E drives the **real deployed hook**, not the engine CLI token; review PR-level. → §14,§15,§19.
- `…540d` unfiltered deploy audit: `tools/deploy-audit.mjs`, never `diff | grep differ` — S6 touches `install.mjs`. → §15.
- `…16c4` isMain fail-open under symlink; `…937a` lstat-before-realpath. → §7,§13.
- `feedback_enforcement_gate_only_repo_src` (R1-R3, LOCKED): gate ONLY repo-source writes; never episodes/plan-files/non-repo/`.git`. The carve-out set is `repo-source.sh` (single source). → §7,§12,§14.
- `feedback_plan_template_first` (2026-06-23): default altitude = **low**; full appendix; behavioral verifies.
- KB `opencode-plugin-api.md` (2026-06-23): OpenCode hook API ground truth (installed `@opencode-ai/plugin@1.14.50`). Resolves OD-1/OD-2 (§17).

Verified against disk at `9ab5663`; re-verify in §A.4 per slice.

## §3 Objective

Ship the first non-Claude-Code enforcement plugin, `plugins/opencode/`, binding the contract to
OpenCode at its **honest** tiers (`pre_tool_use: STRONG`, `tool_result: MEDIUM`, `session_start:
MEDIUM`, `stop: MEDIUM` — all verified against the installed OpenCode types; tool_result is MEDIUM
because OpenCode's after-hook has no proven result-re-read, §17). "Done" is provable by: the
`test-plugin.mjs` 9-step gauntlet passing for the `opencode` entry (steps 1-4,7,8,9; 5-6 stay
`deferred-P3`); a **real-OpenCode-runtime** mock-project E2E where the deployed adapter throws on a
repo-source write and allows every carve-out (episode/plan/`.git`/`.checkpoints`/`.review-store`/
git-ignored/non-repo); and a clean unfiltered deploy audit after `install.mjs`.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | `test-plugin.mjs` accepts `--harness <id>`, defaulting to `claude-code`; the registry lookup **and the harness-event fixture dir** (`test-plugin.mjs:143`) are both parameterized by it. | R6 | `testHarnessDefault/Opencode/UnknownThrows`; `manual: node scripts/test-plugin.mjs --harness opencode --json` | MUST | M1: fixture dir was hardcoded `claude-code/`. |
| REQ-2 | `_index.json` has an `opencode` entry; `opencode/manifest.json` validates vs `manifest.schema.json`; the two `capabilities` blocks **deep-equal**. | R6,R8 | gauntlet 1-2; `test-plugin-registry.mjs` | MUST | tiers `pre_tool_use:STRONG, tool_result:MEDIUM, session_start:MEDIUM, stop:MEDIUM`. |
| REQ-3 | The manifest declares `event_translations` for all 4 events; each replayed against its `opencode/<event>.json` fixture yields a payload valid vs `schemas/events/event-*.schema.json`. | R6 | gauntlet 8 | MUST | Fixtures are the post-normalize object (§8.3). |
| REQ-4 | `tests/fixtures/harness-events/opencode/{pre-tool-use,tool-result,session-start,stop}.json` exist in post-normalize shape. | R6 | gauntlet 8 | MUST | Exact contents §A.7 S2. |
| REQ-5 | `opencode/runbooks/enforcement.md` (+ `.quickref.md`) passes M7/M7a/M7c/M7d/M7e/M7f. | R10 | gauntlet 3,9; `validate-plugin-registry.mjs` | MUST | Byte-derived (§A.0 read #2). |
| REQ-6 | `bypass_known.json` has an honest record per `{opencode,event}` pair; `tool_result` records the MEDIUM observe ceiling honestly. | R6 | gauntlet 7 (M4a) | MUST | §A.7 S2. |
| REQ-7 | The carve-out set is defined **once** in a machine-readable form read by BOTH `repo-source.sh` and a new node classifier `scripts/lib/repo-source.mjs`; a parity test proves they agree. | R1-R3,R5 | `test-repo-source-parity.mjs` | MUST | B2/M3: today carve-outs live only in `repo-source.sh:75-85`. Rule 14. |
| REQ-8 | `opencode/capabilities/enforcement.ts` normalizes a raw OpenCode hook event → canonical payload → decision via `repo-source.mjs` + `enforce-contract.gateDisposition` → OpenCode effect (`throw` on block; observe/log on tool_result; `return` on allow). | R6 | `test-opencode-adapter.mjs` + real-runtime E2E | MUST | First `capabilities/` adapter. Gates ONLY repo-source writes. |
| REQ-9 | A zero-dep node bridge `enforce-bridge.mjs` does field_bindings → schema-validate → classify (`repo-source.mjs`) → `gateDisposition` → decision JSON; it resolves repo root from the payload's `cwd`, **never its own process cwd**. | R5,R6 | `test-enforce-bridge.mjs` incl. cwd-divergence | MUST | Axis-9: bridge cwd ≠ target repo. |
| REQ-10 | The adapter synthesizes `cwd` (from `realpath(PluginInput.directory)`) and `turn_index` (per-`sessionID` monotonic counter incremented **synchronously before any await**). | R6 | `testCwdFromContext`, `testTurnIndexMonotonic` | MUST | M2: sync increment; reset-on-reload accepted (ordering-only). |
| REQ-11 | `install.mjs --tool opencode --install-enforcement` deploys adapter+bridge+runbook+registry+repo-source.mjs+carve-out JSON + registers the plugin in `opencode.json[c]`; `--uninstall-enforcement` removes them. | R6 | `test-install-opencode-enforcement.mjs` (mock) | MUST | Today only the substrate skill installs. |
| REQ-12 | The OpenCode gauntlet run is a CI gate in `plugin-validate.yml`. | R10 | CI green; `manual: gh run view` | SHOULD | Rule 13; references #377; may defer (OD-3). |
| REQ-13 | The adapter never blocks a carve-out write: `.episodic-memory/`, `docs/plans/`, `.git/`, `.checkpoints/`, `.review-store/`, a `git check-ignore` match, or any non-repo target. | R5,R1-R3 | `test-opencode-adapter.mjs` negative controls (§14 Group 4) | MUST | M3: carve-out set = `repo-source.sh`. |
| REQ-14 | The adapter/bridge fail **closed**: malformed event, schema-invalid payload, bridge non-zero exit, bridge timeout, or unparseable decision → **throw** (block). | R5 | `testMalformedFailsClosed`, `testBridgeErrorFailsClosed` | MUST | No uncertainty→allow path. |

**Priority:** MUST = first-merge blocker; SHOULD = before phase complete (defer w/ issue); MAY = nice-to-have.

## §5 Non-Goals

- P6 (Codex) / P7 (Pi) plugins.
- A general multi-contract refactor of `THIS_HARNESS`/`BP_ID` — S5 reaches the opencode decision via `gateDisposition` + a `harness` param at the **minimum**.
- Promoting `tool_result` to STRONG — blocked on a real-runtime re-read proof (§17 B1); ships MEDIUM.
- Promoting gauntlet steps 5/6 out of `deferred-P3`.
- OpenCode substrate-skill authoring (already shipped).
- Any claude-code behavior change — S1's `--harness`/fixture-dir defaults preserve it byte-for-byte.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (×5) | Writes | Notes |
|---|---|---|---|---|
| `scripts/test-plugin.mjs` | 361 | ~1.8k | S1 edits | param harness + fixture dir |
| `.claude/hooks/lib/repo-source.sh` | ~104 | ~0.5k | S4 edit (read carve-outs from JSON) | §A.0 read #3 |
| `scripts/enforce-contract.mjs` | 789 | ~3.9k | S5 read (gateDisposition surface) | §A.0 read #1 |
| `.claude/hooks/lib/command-classifier.sh` | (read) | ~1.5k | S4/S5 label logic | §A.0 read #3 |
| `install.mjs` | 2246 | ~11k | S6 edits | scope to opencode + enforcement regions |
| `scripts/validate-plugin-registry.mjs` | 680 | ~3.4k | read-only | §A.0 read #2 (runbook derivation) |
| New: manifest, enforcement.ts, enforce-bridge.mjs, repo-source.mjs, carve-out JSON, runbook+quickref, 4 fixtures, 4 bypass records, 6 test files | — | — | writes | net-new |

**Baseline (single session):** ~130-150k → autocompact risk. **Optimized, by dep layer (§10.1):**
S1+S2 (~45k); §A.0 reads + S3 (~35k); S4 extraction (~30k); S5 adapter+bridge (~45k); S6 install+CI (~30k). Slice across ≥5 sessions.

## §7 Safety / Security

Dispatch `negative-scenario-planner` again on the **revised** S5 adapter design before building S5
(round-2). Draft seed (round-1 findings already folded):

| Concern | Sev | Scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| Over-block (R1-R3) | High | Adapter throws on episode/plan/`.git`/`.checkpoints`/`.review-store`/git-ignored/non-repo write. | Classify via `repo-source.mjs` reading the SHARED carve-out set (= `repo-source.sh`). | Group 4: each carve-out → allow (negative controls). |
| Fail-open under degrade | High | Bridge error/timeout swallowed → allow. | Bridge exit≠0 / bad JSON / timeout → adapter **throws**. | `testBridgeErrorFailsClosed`. |
| cwd divergence (axis-9) | High | Bridge resolves repo root from its own cwd (= OpenCode launch dir), not the target. | Bridge uses `payload.cwd` only; `realpath` it; `repo-source.mjs` takes repo_root as an arg. | `testBridgeCwdDivergence` (bridge cwd=tmpdir, payload.cwd=mock repo; assert decision + any marker land under mock repo on disk). |
| Capability dishonesty | Med | Declaring STRONG where OpenCode can't enforce. | tool_result = MEDIUM (no proven re-read); honest `bypass_known`. | gauntlet 7. |
| turn_index race | Low | post-await increment → two calls share an index. | Increment synchronously at normalize entry. | `testTurnIndexMonotonic`. |

**8-axis symlink matrix:** symlinked repo root; symlinked `directory`; `/var`→`/private/var`
(`realpath`/`pwd -P`, not `path.resolve`); marker-path symlink (lstat before realpath, `…937a`);
linked worktree; `.git/` carve-out; isMain under symlink (`…16c4`); nested project root. Each → a
row in §A.7 S5 fixtures or explicit N/A.

## §8 Design

### 8.1 Key types

```js
/** OpenCode hooks (from @opencode-ai/plugin@1.14.50 dist/index.d.ts):
 *   tool.execute.before(input{tool,sessionID,callID}, output{args})  — block by throw
 *   tool.execute.after(input{tool,sessionID,callID,args}, output{title,output:string,metadata}) — returns void; result re-read NOT proven ⇒ observe/MEDIUM
 *   experimental.chat.system.transform(input{sessionID?,model}, output{system:string[]}) — best-effort inject
 *   event(input{event}) — observe-only; session.idle ⇒ "stop"
 * cwd from PluginInput.directory (NOT events). turn_index NOT provided.
 * @typedef {Object} NormalizedEvent
 * @property {string} tool @property {object|null} args @property {string} [result]
 * @property {string} sessionID @property {string} cwd  // realpath(ctx.directory)
 * @property {number} turn_index @property {string} [harness] @property {boolean} [is_subagent] */
```

### 8.2 Key invariants

- The opencode manifest `capabilities` block **deep-equals** the `_index.json` opencode entry's (validator uses `deepEqualJson`).
- `event_translations` are near-identity `$.field` + `$$now`; all harness-specific work (context merge, turn_index, typed constants) is in the adapter **normalize** step (no `$$const` type coercion).
- Adapter/bridge fail **closed** (REQ-14).
- Gate scope = repo-source writes only; the carve-out set is `repo-source.sh` via the shared JSON (REQ-7).
- The bridge resolves repo root from `payload.cwd` only, never its own process cwd (REQ-9, axis-9).
- **Cross-platform:** `path`/`os.tmpdir()`; `cwd` = `realpath` (handles `/var`→`/private/var`); no GNU-only flags. Adapter TS (Bun); bridge + `repo-source.mjs` zero-dep node `.mjs`.
- **Atomicity:** marker writes temp+rename.

### 8.3 Resolution / flow

```text
OpenCode hook (input, output)
  → enforcement.ts NORMALIZE: cwd=realpath(ctx.directory), turn_index++ (sync, pre-await), typed consts → NormalizedEvent
  → spawn `node enforce-bridge.mjs`, stdin {harness:"opencode", event:<id>, normalized}
  → bridge: field_bindings → canonical payload (validate vs schema; exit 2 on fail)
          → TWO INDEPENDENT LAYERS, composed by AND (mirrors checkpoint-gate.sh):
            (L1) label = classifyLabel(tool,args); gatedWrite = repoSource.toolTargetsRepoSource(realpath(payload.cwd), tool, targetPath, label)  // is this a gated repo-source write?
            (L2) disp  = gateDisposition({duplicate, harnessCap:"STRONG", contractTier, active, configTier, events, event:"pre_tool_use"})  // is the gate enforcing at all?
            → action = (gatedWrite===GATED && disp.token∈{enforce,block}) ? "block" : "allow"
          → {action, effective_tier:disp.effTier, reason, label} on stdout (exit 0); ANY error → exit≠0
  → enforcement.ts apply: block→throw(reason) | allow→return | (tool_result/session_start/stop MEDIUM)→observe/log, return
  Note (scope): P5 enforces the repo-source-write × disposition AND. The bp-001 checkpoint/plan-approval
  MARKER lifecycle (checkpoint-gate.sh's armed/approval-token state) is NOT replicated for OpenCode in
  P5 — documented capability boundary; tracked as a follow-up (OD-4).
```

```mermaid
sequenceDiagram
    actor OC as OpenCode (Bun)
    participant ADP as enforcement.ts
    participant BR as enforce-bridge.mjs (node)
    participant RS as repo-source.mjs
    participant EC as enforce-contract.gateDisposition
    OC->>ADP: hook(input, output)
    ADP->>ADP: normalize → cwd=realpath(ctx.directory), turn_index++ (sync)
    ADP->>BR: spawn, stdin {harness,event,normalized}
    BR->>BR: field_bindings → payload (validate; exit 2 on fail)
    BR->>RS: toolTargetsRepoSource(realpath(payload.cwd), tool, target, label)
    RS-->>BR: gatedWrite (GATED | ALLOW)
    BR->>EC: gateDisposition({harnessCap:"STRONG", contractTier, active, configTier, events, event})
    EC-->>BR: {token: enforce|block|silence|clamp-off, effTier}
    BR-->>ADP: action = (gatedWrite=GATED AND token∈{enforce,block}) ? block : allow ; any error → exit≠0
    ADP-->>OC: block→throw | allow→return | tool_result→observe+return
    Note over ADP: bridge exit≠0 / bad JSON / timeout ⇒ throw (fail-closed)
```

## §9 Existing Hook Points

| File | Line(s) | Today | Impact |
|---|---|---|---|
| `scripts/test-plugin.mjs` | L55 | `runGauntlet({projectRoot,now,cwd})` | S1: add `harness` param. |
| `scripts/test-plugin.mjs` | L66 | `…p.id==="claude-code"` | S1: `p.id === harness`. |
| `scripts/test-plugin.mjs` | L143 | `tests/fixtures/harness-events/claude-code/${dash}.json` (hardcoded) | **S1 (M1): parameterize dir by harness.** |
| `scripts/test-plugin.mjs` | L318,321,343 | argv parse + dispatch | S1: `--harness` arg threaded. |
| `.claude/hooks/lib/repo-source.sh` | L53-104 (carve-outs L75-85) | `_path_is_repo_source` + carve-outs in bash | **S4 (B2/M3): read carve-outs from shared JSON; node `repo-source.mjs` mirrors it.** |
| `.claude/hooks/lib/command-classifier.sh` | (read) | tool/command → label | S4/S5 (§A.0 read #3): label logic the bridge needs. |
| `scripts/enforce-contract.mjs` | L365 `gateDisposition`, L110 `decideStop` | closed-token disposition over tiers (no path/label) | **S5 (§A.0 read #1): the bridge calls `gateDisposition`; there is NO `{action}` write-decision fn (B2).** |
| `plugins/_index.json` | L3-18 | claude-code entry | S2: append opencode entry. |
| `plugins/bypass_known.json` | L2-37 | codex+claude-code | S2: append 4 opencode records. |
| `install.mjs` | L877-893 / L1640-1706 | skill-only / claude-code deploy | S6: add opencode enforcement deploy. |
| `.github/workflows/plugin-validate.yml` | job `validate` | gauntlet not wired (#377) | S6: add opencode gauntlet step. |

**Re-verify every line in §A.4 — they drift.**

## §10 Slice Ladder

| Slice | Objective | Primary files | Tests | Hard stops |
|---|---|---|---|---|
| `P5-S1` | Gauntlet `--harness` + fixture-dir param (pure refactor) | `scripts/test-plugin.mjs`, `tests/test-plugin-gauntlet.mjs` | `testHarness*` | No opencode authoring; don't touch steps 5/6. |
| `P5-S2` | Declarative opencode plugin (gauntlet 1,2,4,7,8) | `_index.json`, `opencode/manifest.json`, 4 fixtures, `bypass_known.json` | gauntlet 1,2,4,7,8 + `test-opencode-translations.mjs` | No runbook/adapter. tool_result MEDIUM. |
| `P5-S3` | Runbook (3,9) | `opencode/runbooks/enforcement.md`+`.quickref.md` | gauntlet 3,9; validator | §A.0 read #2. focused-review. |
| `P5-S4` | Shared carve-out JSON + node `repo-source.mjs` (pure extraction, parity-tested) | `patterns/repo-source-carveouts.json`, `scripts/lib/repo-source.mjs`, `.claude/hooks/lib/repo-source.sh` | `test-repo-source-parity.mjs` | §A.0 read #3. Zero behavior change to the bash gate. focused-review. |
| `P5-S5` | TS adapter + node bridge (uses S4 + gateDisposition) | `opencode/capabilities/enforcement.ts`, `…/enforce-bridge.mjs`, `scripts/enforce-contract.mjs` | `test-opencode-adapter.mjs`, `test-enforce-bridge.mjs`, real-runtime E2E | §A.0 read #1. Gate ONLY repo-src. focused-review (security core). |
| `P5-S6` | Install deploy + CI | `install.mjs`, `plugin-validate.yml` | `test-install-opencode-enforcement.mjs`; CI; `deploy-audit.mjs` | Unfiltered deploy audit. |

### 10.1 Dependency graph

```text
S1 ──┬── S2 ──┬── S3 ──────────┐
     │        └── S5 ──┐       │
S4 ──────────────┘     ├───────┼── S6
                       (S5 needs S2 + S4)
```

S1 hard-deps S2. S4 is independent (depends only on the current repo) — can start in parallel with S1/S2.
S5 needs S2 (manifest/translations) + S4 (`repo-source.mjs`). S6 needs S2+S3+S5.

## §11 Cut Order

1. REQ-12 CI wiring → follow-up issue (#377).
2. tool_result observe hook → ship `pre_tool_use` block first.

Do **not** cut: REQ-1; REQ-7 (shared carve-out source); REQ-8/13/14 (repo-src-only, fail-closed — security core); REQ-2/3.

## §12 Contracts

### `runGauntlet({projectRoot, harness, now, cwd}) → result` (S1)

| State | Condition | Output | Side effects |
|---|---|---|---|
| A | `harness` absent | claude-code entry + `claude-code/` fixtures (byte-identical to today) | none |
| B | `harness="opencode"` | opencode entry + `opencode/` fixtures | none |
| C | `harness="zzz"` | throw `UsageError` naming `zzz` | exit 2 |

### `repo-source.mjs` — node mirror of `repo-source.sh` (S4)

Mirrors BOTH bash predicates verbatim (parity-tested). **Path matching is exact-segment** (`<root>/.git` or `<root>/.git/*`), NEVER substring — else `.github/` / `.gitignore` would be wrongly carved (B-NEW-1). Canonicalize via `realpath`/`pwd -P` equivalent (handles `/var`→`/private/var`).

`isRepoSource(repoRoot, targetPath) → {isRepoSource, carveout}` (mirrors `_path_is_repo_source`, sh:54):

| State | Condition | Output |
|---|---|---|
| A | target exact-segment under repoRoot, not a carve-out | `{isRepoSource:true, carveout:null}` |
| B | target under a carve-out dir (shared JSON: `.episodic-memory/.checkpoints/.review-store/.git/docs/plans`) | `{isRepoSource:false, carveout:<name>}` |
| C | `git -C repoRoot check-ignore` matches | `{isRepoSource:false, carveout:"gitignore"}` |
| D | target not under repoRoot | `{isRepoSource:false, carveout:"outside-repo"}` |
| E | **empty/whitespace targetPath** | `{isRepoSource:true}` (**fail-closed**, sh:56 `return 0`) |
| F | `..`-traversal path | canonicalize first, then A-D (sh:67-73; off-repo `..` → allow, R3) |

`toolTargetsRepoSource(repoRoot, tool, path, label) → GATED|ALLOW` (mirrors `_tool_targets_repo_source_shared`, sh:90): for `tool==="Bash"` (OpenCode `bash`): `read_only|nonsrc_write`→ALLOW; `shared_write|unsafe_complex|push_or_pr_create`→`isRepoSource(repoRoot,path)`; else GATED. For non-Bash tools (write/edit)→`isRepoSource(repoRoot,path)`.

Parity: `test-repo-source-parity.mjs` runs a corpus (repo-src file; each carve-out; `.github/` and `.gitignore` adjacent-name; empty path; `..`-traversal; git-ignored) through BOTH `repo-source.mjs` and `repo-source.sh`, asserts identical verdicts — **with the carve-out JSON present AND absent** (the bash fallback path, B-NEW-3).

### `enforce-bridge.mjs` (stdin JSON → stdout decision) (S5) — the AND composition (B-NEW-2 resolved inline)

**Input:** stdin `{harness:"opencode", event, normalized}`. **Output:** stdout `{action, effective_tier, reason, label}` exit 0; ANY error → exit≠0 (adapter blocks). **Repo root = `realpath(payload.cwd)` only; never process cwd.**

The decision is an **AND of two independent layers** (mirrors how `checkpoint-gate.sh:862` + `plan-gate.sh:192` compose them — NOT a pipe where one consumes the other):

```js
// pre_tool_use only (the sole blocking event; STRONG):
const label = classifyLabel(tool, args)                 // L1a: node port of command-classifier subset (§A.0 read #3)
const gatedWrite = toolTargetsRepoSource(repoRoot, tool, targetPath, label)  // L1b: repo-source.mjs → GATED|ALLOW
const disp = gateDisposition({                           // L2: enforce-contract.mjs:365 — reuse its loaders for the inputs
  duplicate,          // registry: >1 active enforcement plugin binds opencode → token "block"
  harnessCap: "STRONG",   // opencode manifest cap for pre_tool_use
  contractTier,       // bp-001 contract tier (loaded via the same reader the gates use)
  active,             // loadEnforceConfig(repoRoot).active  (operator kill switch → "silence")
  configTier,         // operator tier clamp → "clamp-off"
  events,             // patterns/events.json
  event: "pre_tool_use",
})
const action = (gatedWrite === "GATED" && (disp.token === "enforce" || disp.token === "block")) ? "block" : "allow"
```

| State | Condition | stdout / exit |
|---|---|---|
| A | pre_tool_use, gatedWrite=GATED, disp.token∈{enforce,block} | `{action:"block"}` exit 0 |
| B | pre_tool_use, gatedWrite=ALLOW (read / carve-out / non-repo) | `{action:"allow"}` exit 0 |
| C | pre_tool_use, gatedWrite=GATED but disp.token∈{silence,clamp-off} (operator kill/clamp) | `{action:"allow"}` exit 0 |
| D | tool_result / session_start / stop (all MEDIUM) | `{action:"allow"}` exit 0 (adapter observes/logs; no mutation) |
| E | schema-invalid payload | exit 2 |
| F | classify / gateDisposition / loader throws | exit 3 |

`gateDisposition` token semantics (verified `enforce-contract.mjs:365-378`): `duplicate→"block"`;
`active===false→"silence"`; `pre_tool_use action==="block"→"enforce"`; `warn/inject→"clamp-off"`;
unknown/unresolved→`"enforce"` (fail-closed). Only `enforce`/`block` keep the gate blocking.
The gateDisposition input loaders (`loadEnforceConfig`, the contract-tier reader, the registry
duplicate check) are reused from `enforce-contract.mjs`, not re-implemented (§A.0 read #1 — DONE inline).

### adapter apply (enforcement.ts) (S5)

| decision.action | OpenCode effect |
|---|---|
| `block` | `throw new Error(decision.reason)` |
| `allow` | `return` |
| (tool_result event) | observe/log, `return` (result unchanged — MEDIUM) |
| (bridge exit≠0 / bad JSON / timeout) | `throw new Error("opencode-enforce: fail-closed: " + detail)` |

## §13 Edge Cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | empty/missing event fields | normalize throws → block | `testMalformedFailsClosed` |
| EC2 | symlinked `directory` / `/var`→`/private/var` / isMain under symlink | realpath both sides; repo-root stable; gate fires | `testSymlinkRepoRoot` |
| EC3 | concurrent `tool.execute.before` same session | turn_index incremented **synchronously before any await**; no shared index | `testTurnIndexMonotonic` |
| EC4 | bridge spawn aborts / times out | adapter throws (no partial allow) | `testBridgeErrorFailsClosed` |
| EC5 | bridge cwd ≠ target repo (axis-9) | decision uses `payload.cwd`; marker lands under target repo on disk | `testBridgeCwdDivergence` |
| EC6 | validate-then-write ordering | schema-validate before any marker/alert side effect | `testValidateBeforeSideEffect` |
| EC7 | carve-out writes (`.git/`,`.checkpoints/`,`.review-store/`,`.episodic-memory/`,`docs/plans/`,git-ignored) | allow | Group 4 negative controls |

## §14 Test Case Catalog

```text
Group 1: gauntlet param (S1) — node tests/test-plugin-gauntlet.mjs
  testHarnessDefault       — runGauntlet({projectRoot}); read_trace includes plugins/claude-code/manifest.json AND a claude-code/ fixture path
  testHarnessOpencode      — harness:"opencode"; read_trace includes plugins/opencode/manifest.json AND an opencode/ fixture path
  testHarnessUnknownThrows — harness:"zzz" throws, /zzz/.test(err.message)

Group 2: declarative plugin (S2) — node scripts/test-plugin.mjs --harness opencode --json + node tests/test-opencode-translations.mjs
  testPreToolUse/ToolResult/SessionStart/StopTranslation — replay fixture → payload valid vs schema; sentinel session_id flows through
  (negative) testEmptySessionIdRejected — fixture sessionID:"" → payload invalid

Group 3: runbook (S3) — gauntlet 3,9 + validator M7a/M7c/M7d/M7e/M7f

Group 4: adapter repo-src gate, fail-closed (S5) — node tests/test-opencode-adapter.mjs
  testRepoSrcWriteBlocks    — write under repoRoot/src/SENTINEL.mjs → throws (message===bridge reason)
  testReadAllows            — read_only → no throw
  testNonRepoWriteAllows / testEpisodeWriteAllows / testPlanFileWriteAllows / testGitWriteAllows /
  testCheckpointsWriteAllows / testReviewStoreWriteAllows / testGitIgnoredWriteAllows  — each a negative control: no throw on the carve-out sentinel path
  testMalformedFailsClosed  — normalized missing tool → throw
  testBridgeErrorFailsClosed— bridge stub exits 1 → throw
  testTurnIndexMonotonic    — two before-calls → 0 then 1
  testCwdFromContext        — normalized.cwd === realpath(ctx.directory)
  testToolResultObserveNoMutate — tool_result → no throw, output.output UNCHANGED (MEDIUM)

Group 5: bridge (S5) — node tests/test-enforce-bridge.mjs
  testBridgeRepoSrcBlock / testBridgeReadAllow / testBridgeInvalidPayloadExit2 / testBridgeEngineThrowExit3 /
  testBridgeCwdDivergence — bridge process cwd=os.tmpdir(), payload.cwd=mock repo; decision uses mock repo carve-outs; any marker on disk under mock repo

Group 6: repo-source parity (S4) — node tests/test-repo-source-parity.mjs
  testParityCorpus     — repo-src + each carve-out + non-repo + git-ignored: identical verdict repo-source.mjs vs repo-source.sh
  testAdjacentNameNotCarved — .github/x AND .gitignore → GATED (isRepoSource:true) in BOTH (exact-segment, not substring)
  testEmptyPathFailsClosed  — "" → GATED in both
  testTraversalAllows       — ../outside → ALLOW in both (R3)
  testToolTargetsParity     — toolTargetsRepoSource(Bash, read_only|shared_write,…) matches _tool_targets_repo_source_shared
  testFallbackMode          — JSON hidden → bash fallback verdicts still ≡ mjs (B-NEW-3)
  testDeployedPathResolution — "JSON present" mode exercises the $HOME/.episodic-memory/patterns/ path the deployed copy uses (NEW-R3-1), not only the repo-relative path

Group 7: install + deploy (S6) mock-project E2E — node tests/test-install-opencode-enforcement.mjs
  testInstallDeploysAll / testUninstallRemoves / testDeployAuditClean
```

Total: ~33 named tests + 5 gauntlet steps × opencode.

> **No aspirational output:** every assertion is on real captured output (thrown error/stdout/exit/file/return), never a typed constant. Negative controls inject a unique sentinel path and assert on THAT path.
> **Real-runtime E2E, never mental-trace:** S5/S6 drive the **deployed** adapter under the real OpenCode runtime via real `install.mjs` (M4 — no node-call OR-branch).

## §15 Verification Ledger (verify by artifact)

| Claim | Command (strong layer) | Observed artifact |
|---|---|---|
| Gauntlet param green (claude-code unaffected) | `node tests/test-plugin-gauntlet.mjs` | `<fill: N/N pass>` |
| Opencode gauntlet | `node scripts/test-plugin.mjs --harness opencode --json` | `<fill: 1-4,7,8,9 pass; 5,6 deferred>` |
| repo-source.mjs ≡ repo-source.sh | `node tests/test-repo-source-parity.mjs` | `<fill: N/N identical>` |
| Adapter gates repo-src only (real-runtime E2E) | mock-project: real `install.mjs`, drive deployed OpenCode adapter on repo-src vs carve-out write | `<fill: throw vs return>` |
| Deploys clean | `node tools/deploy-audit.mjs` (unfiltered) | `<fill: clean>` |
| Registry valid | `node scripts/validate-plugin-registry.mjs --project .` | `<fill: PASS>` |

**Order + strong-layer rules** as in the template (artifact precedes claim; E2E = deployed adapter; deploy = unfiltered audit; review = 3 layers).

## §16 Risk Analysis

| Risk | Sev | Lik | Mitigation |
|---|---|---|---|
| tool_result MEDIUM is over-cautious (OpenCode DOES re-read output.output) | Low | Med | Promote to STRONG only after a real-runtime E2E proves re-read; until then MEDIUM is the honest floor (B1). |
| Bun(adapter)/node(bridge) spawn fragility | Med | Med | Bridge plain node `.mjs`; adapter spawns `node` by abs path resolved at install; real-runtime E2E covers it. |
| repo-source.mjs drifts from repo-source.sh | High | Med | Single shared carve-out JSON (Rule 14) + parity test (REQ-7). |
| gateDisposition token→action mapping mis-pinned | High | Med | §A.0 read #1 pins it; bridge unit tests (Group 5) assert each branch. |
| `.opencode/plugins/` dir / config shape varies by version | Med | Med | Register via config `plugin` array + plural dir; install E2E probes installed opencode. |

## §17 Open Decisions

**RESOLVED (ground truth: KB `opencode-plugin-api.md`, `@opencode-ai/plugin@1.14.50`):**

- **OD-1 (hook-event shapes) — RESOLVED.** `tool.execute.before`→pre_tool_use STRONG (throw). `tool.execute.after`→tool_result; the after-hook returns `void` with **no proven result re-read**, so **MEDIUM (observe)**, NOT STRONG (round-1 B1; web docs were wrong both ways). `experimental.chat.system.transform`→session_start MEDIUM. `event`→session.idle observe→stop MEDIUM (no refuse hook). Events omit `cwd` (use `PluginInput.directory`) and `turn_index` (adapter synthesizes, sync).
- **OD-2 (TS vs zero-dep) — RESOLVED.** `enforcement.ts` with a type-only import of `@opencode-ai/plugin` (erased → zero runtime dep), loaded by OpenCode (Bun); spawns zero-dep node `enforce-bridge.mjs`. Registered via the config `plugin` array + `.opencode/plugins/` fallback.

**Still deferrable:**

- **OD-3: REQ-12 CI wiring** → may defer to a follow-up issue referencing #377.
- **OD-4: bp-001 marker lifecycle for OpenCode (round-2 scope boundary).** P5 enforces the repo-source-write × disposition AND (§12). The checkpoint/plan-approval MARKER lifecycle (checkpoint-gate.sh's armed/approval-token state) is claude-code-specific bp-001 machinery and is NOT replicated for OpenCode in P5. Tracked as a follow-up issue.

| Field | OD-4 |
|---|---|
| 1. Run scenario | An OpenCode session writes repo source without a plan-approval/checkpoint marker; P5 blocks it iff the contract is enforcing, but does not additionally require the bp-001 lifecycle markers. |
| 2. Spec | R5/R6 require harness binding + per-project enforcement; the bp-001 LIFECYCLE is a behavior pattern (decoupled layer per CAPABILITIES.md), not required for the first OpenCode binding. |
| 3. History | Round-2 review (`…3fdb`) surfaced the marker-lifecycle depth; reviewer's prescribed AND model excludes it. |
| 4. Same-class | P6/P7 share the same boundary; resolve the lifecycle-port once, later, for all non-claude harnesses. |
| 5. Residual | If deferred: OpenCode gets repo-source-write gating (honest STRONG) but not the full plan/checkpoint workflow. Graceful; recover by a follow-up lifecycle-port slice. |

| Field | OD-3 |
|---|---|
| 1. Run scenario | Without CI the gauntlet runs only locally; a regression merges green. |
| 2. Spec | R10 + Rule 13 → SHOULD, defer allowed with a tracked issue. |
| 3. History | #377 tracks the same for claude-code. |
| 4. Same-class | claude-code gauntlet also uncovered; wire both. |
| 5. Residual | Local run still exists; recover by wiring the follow-up. Graceful. |

## §18 Done Criteria

- [ ] REQ-1..11, REQ-13, REQ-14 passing with §15 artifacts.
- [ ] `node scripts/test-plugin.mjs --harness opencode` → 1-4,7,8,9 pass, 5-6 deferred.
- [ ] claude-code gauntlet byte-identical to pre-S1.
- [ ] `repo-source.mjs` ≡ `repo-source.sh` (parity test green).
- [ ] Real-runtime mock-project E2E: deployed adapter throws on a repo-src write; allows every carve-out.
- [ ] `tools/deploy-audit.mjs` clean after S6.
- [ ] Every deferred finding (OD-3, any round-2 DEFER) has an issue/comment/violation (Rule 18 step 9).

## §19 Review Consensus (Rule 18)

```bash
node scripts/second-opinion.mjs request --provider claude-subagent --project . \
  --storage episodic --body-file docs/plans/p5-opencode-plugin.md \
  --summary "P5 OpenCode plugin plan review (round 2)" --dispatch
```

| Pass | Reviewer | Provider | Blockers | Verdict | Reply episode |
|---|---|---|---|---|---|
| 1 | `negative-scenario-planner` | (Agent subagent) | 2 + 4 major | **HOLD** | `20260623-063907-hold-p5-opencode-plan-tool-result-strong-13d5` |
| 2 | `negative-scenario-planner` (revised) | (Agent subagent) | 1 + 1 major + 2 minor | **HOLD** (B1/M1 cleared) | `20260623-083618-hold-round-2-p5-opencode-plan-b2-re-arch-3fdb` |
| 3 | `negative-scenario-planner` (boundary-corrected) | (Agent subagent) | 0 blocker, 1 minor (NEW-R3-1, fixed) | **ACCEPT** | `20260623-084701-accept-round-3-final-p5-opencode-plan-b--0da3` |

**Consensus reached at round 3 (ACCEPT).** B-NEW-1/2/3/4 all verified adequate against the real repo
(the two-layer AND is byte-accurate to `enforce-contract.mjs:365-378`; exact-segment mirrors
`repo-source.sh:75-85`; repo copy is the right edit target, diffed identical to deployed). The one new
minor (NEW-R3-1, JSON resolution order for the deployed copy) is applied to S4 4.2 + the parity test.
Reviewer flagged its ACCEPT is a technical verdict, NOT a substitute for the user's Rule 18 step-4 approval.

### 19.1 Resolved blockers (round 1)

| # | Finding (R) | Verdict | Resolution + evidence |
|---|---|---|---|
| B1 | tool_result STRONG dishonest (R6) | ACCEPT (MODIFY) | → MEDIUM (observe) everywhere; promotion gated on real-runtime re-read E2E. `index.d.ts:248-257` returns `void`, no re-read contract. |
| B2 | bridge "decision fn" absent (R5/R6/R1-R3) | ACCEPT | Decision = `repo-source.mjs` (carve-outs) + `gateDisposition` (`enforce-contract.mjs:365`); new pure-extraction slice S4; bridge spec rewritten (§12). |
| M1 | gauntlet step 8 reads claude-code fixtures (R6) | ACCEPT | S1 now parameterizes the fixture dir (`test-plugin.mjs:143`); `testHarnessOpencode` asserts an `opencode/` fixture path in read_trace. |
| M2 | turn_index fixture-vs-live + race (R6) | ACCEPT (MODIFY) | Sync pre-await increment (REQ-10, EC3); reset-on-reload accepted (ordering-only). |
| M3 | §A.5 carve-out list incomplete → over-block (R1-R3) | ACCEPT | Carve-out set = `repo-source.sh` via shared JSON (REQ-7); Group-4 controls for `.checkpoints/`,`.review-store/`,git-ignored. |
| M4 | unsound E2E OR-branch (R5/R6) | ACCEPT | OR-branch deleted; real-runtime E2E required or `deferred-unverified` + issue. |
| axis-9 | bridge cwd divergence | ACCEPT | Bridge uses `payload.cwd` only (REQ-9); `testBridgeCwdDivergence`. |
| OD-3 | CI wiring (R10) | DEFER | 5-field block (§17); references #377. |

### 19.2 Resolved blockers (round 2)

| # | Finding (R) | Verdict | Resolution + evidence |
|---|---|---|---|
| B-NEW-2 | bridge sequences classify→gateDisposition as a pipe; the real decision is a two-layer AND (R5/R6/R1-R3) | ACCEPT | §8.3/§12/mermaid rewritten to the explicit AND: `toolTargetsRepoSource` (`repo-source.sh:90`) AND `gateDisposition.token∈{enforce,block}` (`enforce-contract.mjs:365`). READ-PIN A.0#1 resolved inline. |
| B-NEW-1 | "zero behavior change" to the live bash gate unverified; substring carve-out would catch `.github` (R1-R3) | ACCEPT | §12 + S4 mandate **exact-segment** match; parity corpus adds `.github`/`.gitignore`/empty/`..`/git-ignored, run JSON-present AND fallback. |
| B-NEW-3 | half-migrated gate: JSON read at runtime but deployed only in S6 (R5) | ACCEPT | S4 4.2: JSON path resolved relative to the script + install-fallback; **bash falls back to inline literals if JSON unreadable** (never fail-open); parity test runs both modes. |
| B-NEW-4 | A.0#1 READ-PIN re-buried the B2 decision (R5/R6) | ACCEPT | A.0#1 resolved inline in §12; only #2 (runbook) + #3 (label map) remain pinned (reviewer agreed those are mechanical). |
| marker-lifecycle | the bp-001 checkpoint/approval lifecycle is deeper than P5 models | ACCEPT (scope) | Documented as OD-4 (out of P5 scope; follow-up); P5 = repo-source-write × disposition AND only. |

Three layers (per-artifact → cross-file → PR-level). The round-1/2 cap is exceeded by explicit user
direction ("reach consensus"); round-2's B-NEW-2 was same-class as B1's B2, so this revision **changes
the boundary** (models the real two-layer AND from the live gate) rather than re-spelling the patch —
the reviewer's prescribed fix, which it predicted "clears." Round-3 confirms.

## §20 Lessons Encoded

| Lesson | Rule | Enforced in |
|---|---|---|
| `…7918` verify-strong-claim | E2E = deployed adapter; review PR-level | §14,§15,§19 |
| `…540d` unfiltered deploy audit | `deploy-audit.mjs`, never `diff\|grep differ` | §15 |
| `…16c4`/`…937a` symlink/isMain | realpath both sides; lstat before realpath | §7,§13 |
| enforcement-gate-only-repo-src (R1-R3) | gate ONLY repo-src; carve-out set = `repo-source.sh` | §7,§12,§14 |
| Rule 14 single source | carve-outs in one JSON read by bash + node | REQ-7, §A.7 S4 |
| mock-project-not-mental-trace | install/hook proven by real `install.mjs` E2E | §14, §A.7 S5/S6 |
| model-scratch-I/O | carve `.git/` out | §13 EC7 |
| canonical-agent dispatch | `negative-scenario-planner` before self-walk | §7,§19 |
| pure-extraction-first | S1 + S4 ship before new callers | §10 |
| plan-template low-altitude | low executor; full appendix; behavioral verifies | §1, App A |
| Rule 4 / Rule 7 | probe installed types; distil to KB | §2,§17 |

---

# Appendix A: Mechanical Execution Spec (target executor: Haiku / DeepSeek V4 Flash)

## A.0 Pre-authoring reads (plan author completes before S3/S4/S5/S6 handoff; fills `<READ-PIN>` cells)

1. **~~enforce-contract decision surface~~ — DONE inline (B-NEW-4).** Read `enforce-contract.mjs:365-378` (`gateDisposition`) + the composition at `checkpoint-gate.sh:862` / `plan-gate.sh:192`. The exact AND composition + token semantics are now in §12 (no READ-PIN remains). S5 wires the reused loaders named there.
2. **runbook derivation** — read `scripts/validate-plugin-registry.mjs:297-446` (M7a/M7c/M7d/M7e/M7f). Pin: byte-derivation of §7/§8/§9/§10. Fills S3 3.x. (`…2f5d`: reading pass, not phrase-grep.)
3. **classifier label map** — read `.claude/hooks/lib/command-classifier.sh`. Pin: the tool/command→label mapping `classifyLabel(tool,args)` mirrors for OpenCode tools (write/edit/bash/read). Fills S5 step 5.1's `classifyLabel`. (Carve-out set is already pinned: `repo-source.sh:75-85` → §A.7 4.1.)

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/p5-opencode-plugin.md
```

Expected: **no matches inside Appendix A step tables.** Matches in §17/§19 (decision/disposition prose), the mermaid `gateDisposition`, and A.0 are excluded. Plus a reading pass (`…2f5d`).

## A.2 Executor contract (copy verbatim into the handoff)

1. Steps in numeric order; no skip/reorder/batch.
2. Each step = one file, exact change, a verify.
3. **No design decisions.** Ambiguity, missing verbatim anchor, or an unfilled `<READ-PIN>` → STOP (§A.3).
4. Run the verify after each step; fix only that step before proceeding.
5. **One file per step** (the `File` column). Read-only refs: §A.5.
6. Each verify is a **single** command — no `;`/`&&`/`||`/pipes/subshells (compound-bash-gate blocks them).
7. One slice = one commit `P5-S<n>: <title>` + `Co-Authored-By` trailer.
8. No commit/push/PR until the slice's §18 criteria are green AND the human approved.
9. **No aspirational output** — every printed check has a backing assertion.

## A.3 STOP-and-ask protocol

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous | verify failed after fix | READ-PIN unfilled>.
File: <path> ; Expected anchor (verbatim): <text> ; Found instead: <±3 lines>
Question: <the single decision the plan owner must make>
```

## A.4 Pre-flight (step 0 of every slice)

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `feat/rfc-008-p5-opencode-plugin` |
| Clean tree | `git status --porcelain` | empty |
| Baseline gauntlet | `node tests/test-plugin-gauntlet.mjs` | `<N>/<N> pass` |
| Anchor live | `grep -n 'claude-code/' scripts/test-plugin.mjs` | matches L143 (S1) |

## A.5 Shared constants / types

```js
// Tiers (manifest + _index, deep-equal):
//   pre_tool_use:"STRONG", tool_result:"MEDIUM", session_start:"MEDIUM", stop:"MEDIUM"
// Version hashes (reuse current — same taxonomy/events files):
//   taxonomy_version:"sha256:7ea41ed82edef968baee6880f040008080afd962fec9120336ee336796013cc4"
//   events_version:"sha256:13f01e5a599272b349eabd66694b7898e68438e8aad6497e80a9b780bea34ab0"
// emits_labels (default classifier): ["read_only","nonsrc_write","shared_write","push_or_pr_create","marker_write","unsafe_complex","unknown"]
// invocation_modality:"agent"
// Carve-outs: DO NOT hardcode a list here — read patterns/repo-source-carveouts.json (S4), the single source mirrored from repo-source.sh:75-85 (Rule 14).
```
**Read-only refs:** `plugins/claude-code/manifest.json`, `schemas/events/event-*.schema.json`,
`patterns/events.json`, `patterns/taxonomy.json`, `scripts/validate-plugin-registry.mjs`,
`.claude/hooks/lib/repo-source.sh`, `scripts/lib/field-bindings.mjs`, KB `opencode-plugin-api.md`.

## A.6 Anchor format

EDIT = verbatim unique `ANCHOR`→`REPLACE`, smallest span, no reflow. CREATE = whole-file `Write`, full verbatim contents. APPEND = end-of-file add. Anchor not found verbatim → STOP.

## A.6b Falsifiable Verify

Every verify FAILS if intent is absent/stubbed, visible in the command. **Deny-list:** grep for the
literal the step just wrote (self-fulfilling); tolerant exit (`|| true`); happy-path only with no
negative control; a MUST/Safety row guarded only by a `command -v`-skippable smoke w/o `UNGUARDED-IN-CI`.
**Obligation:** name the observed value (captured stdout/exit/return/file) + the expected concrete value.
One command per verify.

## A.7 Per-slice step tables

### `P5-S1` — Gauntlet `--harness` + fixture-dir param (REQ-1) — FULLY SPECIFIED

**May touch:** `scripts/test-plugin.mjs`, `tests/test-plugin-gauntlet.mjs`. **Read-only:** `plugins/_index.json`.

| Step | File | Kind | Exact action | Verify (observed → expected; falsifiable) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4. | passes |
| 1.1 | `scripts/test-plugin.mjs` | EDIT | `ANCHOR:` `export function runGauntlet({ projectRoot, now = NOW, cwd = process.cwd() } = {}) {` → `REPLACE:` `export function runGauntlet({ projectRoot, harness = "claude-code", now = NOW, cwd = process.cwd() } = {}) {` | `node -e "import('./scripts/test-plugin.mjs').then(m=>m.runGauntlet({projectRoot:process.cwd(),harness:'zzz'})).catch(e=>{if(!/zzz/.test(e.message))process.exit(1)})"` → exit 0 |
| 1.2 | `scripts/test-plugin.mjs` | EDIT | `ANCHOR:` `(p) => p.type === "enforcement" && p.id === "claude-code"` → `REPLACE:` `(p) => p.type === "enforcement" && p.id === harness` | covered by 1.8 |
| 1.3 | `scripts/test-plugin.mjs` | EDIT | `ANCHOR:` `no enforcement entry 'claude-code' in plugins/_index.json` → `REPLACE:` `` `no enforcement entry '${harness}' in plugins/_index.json` `` (template literal) | covered by 1.8 testHarnessUnknownThrows |
| 1.4 | `scripts/test-plugin.mjs` | EDIT | `<READ-PIN: confirm L143 exact text + `stepEventReplay` signature at slice start>` `ANCHOR:` the `tests/fixtures/harness-events/claude-code/` literal at L143 → `REPLACE:` `tests/fixtures/harness-events/${harness}/`. The READ-PIN resolves how `harness` reaches L143: add `harness` as a parameter to `stepEventReplay(...)` and pass `entry.id` (the resolved registry id) at its call site (~L99). Smallest diff; no other line changes. | `node scripts/test-plugin.mjs --harness opencode --json` (after S2) → step 8 read_trace contains `harness-events/opencode/` |
| 1.5 | `scripts/test-plugin.mjs` | EDIT | `ANCHOR:` `const args = { project: null, json: false, help: false };` → `REPLACE:` `const args = { project: null, harness: "claude-code", json: false, help: false };` | `node scripts/test-plugin.mjs --harness claude-code --json` → not "unknown argument" |
| 1.6 | `scripts/test-plugin.mjs` | EDIT | `ANCHOR:` `if (a === "--project") args.project = argv[++i];` → `REPLACE:` `if (a === "--project") args.project = argv[++i];\n    else if (a === "--harness") args.harness = argv[++i];` | covered by 1.5 |
| 1.7 | `scripts/test-plugin.mjs` | EDIT | `ANCHOR:` `runGauntlet({ projectRoot: args.project })` → `REPLACE:` `runGauntlet({ projectRoot: args.project, harness: args.harness })` | covered by 1.5 |
| 1.8 | `tests/test-plugin-gauntlet.mjs` | EDIT | Add `testHarnessDefault` (read_trace has `claude-code/manifest.json` and a `harness-events/claude-code/` path), `testHarnessUnknownThrows` (`harness:"zzz"` throws, `/zzz/`). `testHarnessOpencode` after S2 (until then a skip-guard comment referencing S2). Full verbatim at slice start. | `node tests/test-plugin-gauntlet.mjs` → all pass incl. `testHarnessUnknownThrows` |
| 1.9 | — | — | Commit `P5-S1: parameterize gauntlet by harness` + trailer. | `git log -1 --oneline` shows `P5-S1` |

**Red-then-green:** `testHarnessUnknownThrows` goes RED on un-refactored code (hardwired claude-code ignores `harness:"zzz"`).

### `P5-S2` — Declarative opencode plugin (REQ-2,3,4,6) — FULLY SPECIFIED

**May touch:** `plugins/_index.json`, `plugins/opencode/manifest.json` (new), 4 fixtures (new), `plugins/bypass_known.json`, `tests/test-opencode-translations.mjs` (new). **Read-only:** `plugins/claude-code/manifest.json`, event schemas.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 2.0 | — | — | Pre-flight §A.4. | passes |
| 2.1 | `plugins/_index.json` | EDIT | `ANCHOR:` `      "status": "active"\n    }\n  ]\n}` → `REPLACE:` (append a second entry) `      "status": "active"\n    },\n    {\n      "type": "enforcement",\n      "id": "opencode",\n      "harness": "opencode",\n      "directory": "plugins/opencode",\n      "capabilities": {\n        "pre_tool_use": "STRONG",\n        "tool_result": "MEDIUM",\n        "session_start": "MEDIUM",\n        "stop": "MEDIUM"\n      },\n      "classifier": "default",\n      "manifest": "plugins/opencode/manifest.json",\n      "status": "active"\n    }\n  ]\n}` | `node -e "const i=require('./plugins/_index.json');process.exit(i.plugins.some(p=>p.id==='opencode'&&p.capabilities.tool_result==='MEDIUM')?0:1)"` exit 0 |
| 2.2 | `plugins/opencode/manifest.json` | CREATE | Full contents = §A.7-S2-manifest block below. | `node scripts/validate-plugin-registry.mjs --project .` → no M2 violation for opencode |
| 2.3 | `tests/fixtures/harness-events/opencode/pre-tool-use.json` | CREATE | `{"tool":"write","args":{"filePath":"/Users/juan.delacruz/repo/src/x.mjs","content":"x"},"sessionID":"ses_abc","cwd":"/Users/juan.delacruz/repo","turn_index":3}` | gauntlet step 8 (after S1) → pre_tool_use payload valid |
| 2.4 | `tests/fixtures/harness-events/opencode/tool-result.json` | CREATE | `{"tool":"bash","args":{"command":"ls"},"result":"a.txt\nb.txt","sessionID":"ses_abc","cwd":"/Users/juan.delacruz/repo","turn_index":4}` | step 8 → tool_result payload valid |
| 2.5 | `tests/fixtures/harness-events/opencode/session-start.json` | CREATE | `{"sessionID":"ses_abc","cwd":"/Users/juan.delacruz/repo","harness":"opencode"}` | step 8 → session_start payload valid |
| 2.6 | `tests/fixtures/harness-events/opencode/stop.json` | CREATE | `{"sessionID":"ses_abc","cwd":"/Users/juan.delacruz/repo","turn_index":5,"is_subagent":false}` | step 8 → stop payload valid |
| 2.7 | `plugins/bypass_known.json` | EDIT | `ANCHOR:` `      "auditor": "rfc008-p1b-capability-audit"\n    }\n  ]\n}` → `REPLACE:` append 4 records `{harness:"opencode", event:<pre_tool_use|tool_result|session_start|stop>, no_known_bypass_evidence:true, last_audited_iso8601:"2026-06-23T00:00:00Z", auditor:"rfc008-p5-opencode-capability-audit"}` (full JSON, comma-joined, closing `]}`). | gauntlet step 7 → clean (M4a) |
| 2.8 | `tests/test-opencode-translations.mjs` | CREATE | Full verbatim: for each event, read the fixture, run the manifest field_bindings via the interpreter `scripts/lib/field-bindings.mjs` (import it), validate the payload vs `schemas/events/event-<event>.schema.json` with the repo instance validator; assert `valid===true` AND `payload.session_id==="ses_abc"`. Plus `testEmptySessionIdRejected` (clone the pre-tool-use fixture with `sessionID:""` → assert invalid). | `node tests/test-opencode-translations.mjs` → 5/5 (4 valid + 1 negative) |
| 2.9 | — | — | Commit `P5-S2: declarative opencode plugin` + trailer. | `node scripts/test-plugin.mjs --harness opencode --json` → steps 1,2,4,7,8 pass |

**§A.7-S2-manifest block — full verbatim `plugins/opencode/manifest.json`:**

```json
{
  "type": "enforcement",
  "schema_version": "1.0.0",
  "id": "opencode",
  "harness": "opencode",
  "version": "1.0.0",
  "invocation_modality": "agent",
  "capabilities": {
    "pre_tool_use": "STRONG",
    "tool_result": "MEDIUM",
    "session_start": "MEDIUM",
    "stop": "MEDIUM"
  },
  "classifier": {
    "mode": "default",
    "emits_labels": ["read_only","nonsrc_write","shared_write","push_or_pr_create","marker_write","unsafe_complex","unknown"]
  },
  "taxonomy_ref": "patterns/taxonomy.json",
  "taxonomy_version": "sha256:7ea41ed82edef968baee6880f040008080afd962fec9120336ee336796013cc4",
  "events_version": "sha256:13f01e5a599272b349eabd66694b7898e68438e8aad6497e80a9b780bea34ab0",
  "event_translations": {
    "pre_tool_use": { "source_format": "opencode-tool-execute-before-normalized",
      "field_bindings": { "tool":"$.tool","tool_args":"$.args","cwd":"$.cwd","session_id":"$.sessionID","turn_index":"$.turn_index","timestamp_iso8601":"$$now" } },
    "tool_result": { "source_format": "opencode-tool-execute-after-normalized",
      "field_bindings": { "tool":"$.tool","tool_args":"$.args","result":"$.result","cwd":"$.cwd","session_id":"$.sessionID","turn_index":"$.turn_index","timestamp_iso8601":"$$now" } },
    "session_start": { "source_format": "opencode-system-transform-normalized",
      "field_bindings": { "cwd":"$.cwd","session_id":"$.sessionID","harness":"$.harness","timestamp_iso8601":"$$now" } },
    "stop": { "source_format": "opencode-session-idle-normalized",
      "field_bindings": { "cwd":"$.cwd","session_id":"$.sessionID","turn_index":"$.turn_index","is_subagent":"$.is_subagent","timestamp_iso8601":"$$now" } }
  },
  "runbook": { "full": "plugins/opencode/runbooks/enforcement.md", "quickref": "plugins/opencode/runbooks/enforcement.quickref.md" }
}
```

### `P5-S3` — Runbook (REQ-5) — NEEDS §A.0 read #2; focused-review

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 3.0 | — | — | Pre-flight; confirm §A.0 read #2 done else STOP. | passes |
| 3.1 | `plugins/opencode/runbooks/enforcement.md` | CREATE | sentinel `## ⚠️ Self-trigger checklist` + COMMON block byte-copied from `scripts/scaffold-plugin/templates/common-rows.md` + `## §1`…`## §10` headers (mirror claude-code runbook). | `grep -c '^## §' plugins/opencode/runbooks/enforcement.md` → 10 |
| 3.2 | `plugins/opencode/runbooks/enforcement.md` | EDIT | `<READ-PIN A.0#2>` §7 resolution matrix from opencode caps×taxonomy×events R3 ternary (tool_result row = MEDIUM/observe). | validator → no M7c |
| 3.3 | same | EDIT | §8 `**Invocation modality:** agent`. | no M7d |
| 3.4 | same | EDIT | `<READ-PIN A.0#2>` §9 agent-manifest JSON: `command_shapes`=`["node","plugins/opencode/capabilities/enforce-bridge.mjs"]`, `expected_outputs.shape:"json-object"`, `return_codes` {0:ok,2:invalid,3:engine-error}. | no M7e; gauntlet step 9 dispatches in sandbox → marker armed in sandbox only |
| 3.5 | same | EDIT | `<READ-PIN A.0#2>` §10 config cross-binding (values byte-equal manifest). | no M7f |
| 3.6 | `plugins/opencode/runbooks/enforcement.quickref.md` | CREATE | quickref mirroring claude-code's. | gauntlet step 3 → present + sentinel + COMMON byte-match |
| 3.7 | — | — | Commit `P5-S3: opencode enforcement runbook` + trailer. | `node scripts/test-plugin.mjs --harness opencode` → steps 3,9 pass |

### `P5-S4` — Shared carve-out JSON + node `repo-source.mjs` (REQ-7) — NEEDS §A.0 read #3; pure extraction; focused-review

**May touch (one per step):** `patterns/repo-source-carveouts.json`, `scripts/lib/repo-source.mjs`, `.claude/hooks/lib/repo-source.sh`, `tests/test-repo-source-parity.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 4.0 | — | — | Pre-flight; confirm carve-out set = `repo-source.sh:75-85` (exact list: `.episodic-memory`,`.checkpoints`,`.review-store`,`.git`,`docs/plans` + `git check-ignore`). | passes |
| 4.1 | `patterns/repo-source-carveouts.json` | CREATE | Full JSON of the exact set: `{"exact_segment_dirs":[".episodic-memory",".checkpoints",".review-store",".git","docs/plans"],"git_check_ignore":true}`. (Comment in-file: dirs match by **exact segment** under repo root, never substring — `.github`/`.gitignore` must NOT match.) | `node -e "const c=require('./patterns/repo-source-carveouts.json');process.exit(c.exact_segment_dirs.length===5&&c.git_check_ignore?0:1)"` exit 0 |
| 4.2 | `plugins/claude-code/hooks/lib/repo-source.sh` | EDIT | `ANCHOR:` the 5 inline carve-out `case` lines (`"$repo_canon"/.episodic-memory\|...` block, sh:76-80) → `REPLACE:` a loop reading `exact_segment_dirs` from the JSON, resolved in this **exact order (NEW-R3-1)**: (1) `$HOME/.episodic-memory/patterns/repo-source-carveouts.json` — the **deployed canonical** path the live `~/.claude/hooks/lib/` copy actually uses (the script-relative form overshoots above `$HOME` for the deployed copy: `~/.claude/hooks/lib/` + `../../../../` = `/Users/`, wrong); (2) `${BASH_SOURCE[0]%/*}/../../../../patterns/repo-source-carveouts.json` — in-repo dev/test only; (3) **inline 5-dir literals** if both are unreadable (fail-safe: a deploy-lag never opens the gate; zero behavior change). Keep exact-segment `case` semantics; never substring. | `bash tests/test-repo-source.sh` green; **negative:** hide BOTH JSON locations → the inline fallback still gates `.git/` (one-shot bash assert) |
| 4.3 | `scripts/lib/repo-source.mjs` | CREATE | Full verbatim node mirror per §12: `isRepoSource(repoRoot,targetPath)` + `toolTargetsRepoSource(repoRoot,tool,path,label)`. **Exact-segment** match (`p===root+"/"+d || p.startsWith(root+"/"+d+"/")`), realpath canonicalize, empty-path→fail-closed gated, `..`-traversal→canonicalize-first, `git -C repoRoot check-ignore`. Reads the same JSON with the same fallback. | imported in 4.4 |
| 4.4 | `tests/test-repo-source-parity.mjs` | CREATE | Full verbatim corpus run through BOTH `repo-source.sh` AND `repo-source.mjs`, asserting identical verdict per path, **twice — JSON present and JSON hidden (fallback)**. Corpus MUST include: a repo-src file (GATED); each carve-out dir; **`.github/x` and `.gitignore` (adjacent-name → GATED, NOT carved)**; empty path (→ fail-closed GATED); a `../outside` traversal (→ ALLOW); a `git check-ignore` match (→ ALLOW). | `node tests/test-repo-source-parity.mjs` → all identical in BOTH JSON modes; **negative row:** `.github/x` returns isRepoSource:true (GATED) in both impls |
| 4.5 | — | — | Commit `P5-S4: shared repo-source carve-outs (bash+node, parity)` + trailer. | parity green (both modes); bash gate tests green |

### `P5-S5` — TS adapter + node bridge (REQ-8,9,10,13,14) — NEEDS §A.0 read #1+#3; focused-review (security core)

**May touch (one per step):** `plugins/opencode/capabilities/enforce-bridge.mjs`, `tests/test-enforce-bridge.mjs`, `plugins/opencode/capabilities/enforcement.ts`, `tests/test-opencode-adapter.mjs`, `scripts/enforce-contract.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 5.0 | — | — | Pre-flight; confirm §A.0 read #3 (classifyLabel map) done. (Read #1 is resolved inline in §12.) | passes |
| 5.1 | `plugins/opencode/capabilities/enforce-bridge.mjs` | CREATE | Zero-dep node CLI = the §12 AND composition verbatim: stdin `{harness,event,normalized}`; `field-bindings.mjs` → payload; validate vs event schema (exit 2); for `event!=="pre_tool_use"` → `{action:"allow"}` (MEDIUM observe); for `pre_tool_use`: `label=classifyLabel(tool,args)` (§A.0#3 map), `gatedWrite=toolTargetsRepoSource(realpath(payload.cwd),tool,target,label)`, `disp=gateDisposition({...})` reusing `loadEnforceConfig`+contract-tier+duplicate from enforce-contract, `action=(gatedWrite==="GATED"&&disp.token∈{enforce,block})?block:allow`; print `{action,effective_tier:disp.effTier,reason,label}`; any throw → exit 3. Repo root = `realpath(payload.cwd)` ONLY. | `node tests/test-enforce-bridge.mjs` → all pass (incl. State-C operator-kill → allow even on a gated write) |
| 5.2 | `tests/test-enforce-bridge.mjs` | CREATE | Full verbatim Group 5 incl. `testBridgeCwdDivergence` (process cwd=`os.tmpdir()`, payload.cwd=mock repo → decision uses mock repo carve-outs; marker on disk under mock repo) + `testBridgeInvalidPayloadExit2` + `testBridgeEngineThrowExit3`. Assert captured stdout/exit; sentinel path flows through. | `node tests/test-enforce-bridge.mjs` → 5/5 |
| 5.3 | `plugins/opencode/capabilities/enforcement.ts` | CREATE | Full verbatim TS: `export const EpisodicEnforcement: Plugin = async (ctx) => ({...})` with `tool.execute.before`/`tool.execute.after`/`experimental.chat.system.transform`/`event`. Each: NORMALIZE (cwd=`realpath(ctx.directory)`, per-session turn_index Map incremented **synchronously before any await**, typed consts), spawn bridge (`node` abs path), apply §12 (throw on block; tool_result observe/log + return; allow return; bridge exit≠0/bad JSON/timeout → throw). Type-only import of `@opencode-ai/plugin`. | `node tests/test-opencode-adapter.mjs` → all pass |
| 5.4 | `tests/test-opencode-adapter.mjs` | CREATE | Full verbatim Group 4 (§14): repo-src→throw; read→allow; ALL carve-out negative controls (episode/plan/git/checkpoints/review-store/git-ignored/non-repo)→no throw; malformed→throw; bridge-error→throw; turn_index 0→1; cwd from ctx; tool_result no-mutate. Unique sentinel path per case. | `node tests/test-opencode-adapter.mjs` → all pass; each negative control asserted on its sentinel path |
| 5.5 | `scripts/enforce-contract.mjs` | EDIT | Add thin `export` for any loader the bridge imports but that is currently module-private (`gateDisposition` is already exported, L365; confirm `loadEnforceConfig` + the contract-tier reader + the registry duplicate check are exported, else APPEND thin re-export wrappers). NO logic change; claude-code path untouched (smallest diff). | existing `node tests/test-*enforce*` green; `node -e "import('./scripts/enforce-contract.mjs').then(m=>process.exit(typeof m.gateDisposition==='function'&&typeof m.loadEnforceConfig==='function'?0:1))"` exit 0 |
| 5.6 | — | — | Commit `P5-S5: opencode adapter + bridge` + trailer; run the real-runtime E2E (§A.7-S5-E2E). | E2E: deployed adapter throws on repo-src write |

**§A.7-S5-E2E (real OpenCode runtime, no OR-branch — M4):** isolated-`HOME` mock project; install the
plugin via real `install.mjs --tool opencode --install-enforcement` (S6) into the mock; run OpenCode
against a `write` to a repo-source path → assert the tool is refused (hook threw); run a `write` to
`.episodic-memory/` → assert it proceeds. If the real runtime cannot be driven in CI, mark
`deferred-unverified` + file an issue (do NOT substitute a node-call).

### `P5-S6` — Install deploy + CI (REQ-11,12) — anchored

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 6.0 | — | — | Pre-flight. | passes |
| 6.1 | `install.mjs` | EDIT | `<READ-PIN: opencode install region L877-893 + enforcement deploy L1640-1706>` extend `--install-enforcement` to deploy `plugins/opencode/{manifest.json,capabilities/,runbooks/}` + `_index.json` + `scripts/lib/repo-source.mjs` + `patterns/repo-source-carveouts.json` + register the plugin in the project `opencode.json[c]` `plugin` array. | `node tests/test-install-opencode-enforcement.mjs` → `testInstallDeploysAll` pass |
| 6.2 | `install.mjs` | EDIT | `<READ-PIN>` extend `--uninstall-enforcement` to remove the opencode artifacts + config entry. | `testUninstallRemoves` pass |
| 6.3 | `tests/test-install-opencode-enforcement.mjs` | CREATE | Full verbatim mock-project E2E: install → assert files on disk + config `plugin` entry; uninstall → assert gone; `tools/deploy-audit.mjs` → clean. | `node tests/test-install-opencode-enforcement.mjs` → 3/3 |
| 6.4 | `.github/workflows/plugin-validate.yml` | EDIT | `ANCHOR:` the `validate` step running `test-plugin-registry.mjs` → add `node scripts/test-plugin.mjs --harness opencode --json`. (If OD-3 deferred, file the issue + skip 6.4.) | `gh run view <id>` → opencode gauntlet step present + green |
| 6.5 | — | — | Commit `P5-S6: install + CI for opencode plugin` + trailer; run `node tools/deploy-audit.mjs`. | deploy-audit clean |

## A.8 Definition of done (mechanical)

```bash
node tests/test-plugin-gauntlet.mjs               # claude-code unaffected: all pass
node scripts/test-plugin.mjs --harness opencode   # 1-4,7,8,9 pass, 5-6 deferred
node tests/test-opencode-translations.mjs         # 5/5
node tests/test-repo-source-parity.mjs            # N/N identical
node tests/test-enforce-bridge.mjs                # 5/5 incl. cwd-divergence
node tests/test-opencode-adapter.mjs              # all incl. carve-out negative controls
node tests/test-install-opencode-enforcement.mjs  # 3/3 (mock-project E2E)
node scripts/validate-plugin-registry.mjs --project .  # PASS
node tools/deploy-audit.mjs                       # clean (S6 touched install.mjs)
```

## A.9 Blast-radius patterns (applied)

- **Red-then-green:** every Group-4/5/6 negative control (each carve-out→allow; malformed/bridge-error→throw; parity repo-src→isRepoSource:true) is a discriminating row going RED on broken input. Break is inline (sentinel path / bridge-exit fixture / cwd flag), never an added-then-removed fixture.
- **Pure-extraction first:** S1 (param) and S4 (carve-out extraction) ship before any opencode caller; the enforce-contract edit (5.5) is the **minimum** reach to `gateDisposition`, not a refactor; the bridge is a thin wrapper.
- **Single source (Rule 14):** carve-outs in `patterns/repo-source-carveouts.json` read by bash + node; parity test guards drift.
- **Discriminating sentinel:** adapter/bridge tests inject a unique path and assert the action on THAT path.
- **Flag high-blast-radius:** S3, S4, S5 are `focused-review-before-build`.
- **Real-runtime E2E for install/hook:** S5/S6 drive the deployed adapter under real OpenCode + real `install.mjs`; no node-call substitute (M4).
- **Two-runtime caveat:** adapter (Bun) spawns bridge (`node`); only the real-runtime E2E proves OpenCode honors the thrown error and that the bridge resolves the target repo from `payload.cwd`.
```
