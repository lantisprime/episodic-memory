# FIX-628 Sibling module-init index guard Plan

## §1 Status

| Round | Reviewer | Verdict | Notes |
|---|---|---|---|
| 0 | negative-scenario-planner (pre-review audit, 2026-08-02) | **HOLD** | 6 gaps; see §19 Round 0 |
| 0-rev | orchestrator revision (2026-08-02) | READY FOR BUILD | all 6 gaps dispositioned (map below + §19 Revision 1) |
| 1 | kimi-k3 frozen-diff review (2026-08-02) | **APPROVE** | 13 runtime probes incl. falsification vs main; 0 BLOCKER/MAJOR; 2 NITs + 1 plan-rationale MINOR + 1 informational — all dispositioned in §19 Round 1 (`:447` note: shadowed for pre-existing corruption, guard kept for TOCTOU fail-open conversion) |

**HOLD gap dispositions (evidence in §19 Revision 1):**
1. BLOCKER (T4 argv + untested `:140`) — RESOLVED: T4 argv now carries all 7 required flags (§14, L6); new leg T3a exercises the `:140` guard via a registered identity-carrying store. Identity resolution reads `episodes/*.md` only (`store-identity.mjs:95-113` `listIdentityEpisodes`), never `index.jsonl`, so a dir-shaped index cannot mask identity — `:140` is reachable with a PRE-EXISTING corrupt index.
2. MAJOR (silent-`[]` bypass) — DEFERRED with full 5-field block DEFER-4 (§17) + follow-up issue filed at PR time (§5); scope-in rejected because it forces existence-semantics changes into every loader including `lib/relevance.mjs` (REQ-6 byte-unchanged).
3. MAJOR (DEFER-1 falsified) — SCOPED IN: `:447/:466/:468` now route through the guard (REQ-2, A.7 steps 2.4–2.7); I4 re-verified for all three (they run before any `withStoreLockSync` — locks begin `:488/:663/:787`); DEFER-1 rewritten to cover only `:653/:671/:795` (§17); new leg T3c inverts the audit's falsification repro into a regression test.
4. MINOR — DEFER-2/DEFER-3 now carry 5-field blocks (§17).
5. MINOR — TOCTOU-residual sweep enumerates em-prune `partitionPrunable` (`:96-104`) and em-review-request's under-lock re-read (`:499-506`) in DEFER-1's same-class field (§17).
6. MINOR — A.7 step 2.2 now uses a three-line anchor unique to `:140` (the `:653` lookalike sits at deeper indentation inside the migrate branch and does not match the sequence); L5 rewritten to the ACTUAL `prune()` helper contract (`{status, out, raw}` + `stderr` added by step 5.0) and drops the nonexistent `--min-age-days` flag — the module-init crash precedes all arg-dependent logic, so no age flag is needed at all.

## §2 Episode Search Summary

- Workplan v292 (`20260801-083254-...-a762`): queue head #628.
- #626 arc: plan `docs/plans/fix-626-consolidate-init-guard.md`, commit `97a4309` ("Sibling exposure: #628" in its own message) — establishes the guard-pair pattern this plan replicates.
- Scout A (2026-08-02, runtime probes at `c88c90f`): every #628-claimed site CONFIRMED with raw EISDIR stack + empty stdout; corrected line for foldStore residual is `em-consolidate.mjs:365` (issue cites the comment line :344). New same-class findings OUTSIDE this slice: `em-doctor.mjs` (4 unguarded sites), `em-stats.mjs:78` (issue's "clean" claim is wrong), `em-store.mjs:455` write-side EISDIR leaving an orphaned episode `.md`.
- Scout B (2026-08-02): t4b/t4c–f reproducer mechanics (`rmSync` + `mkdirSync` on `index.jsonl`); `test-prune-protection.mjs` 29/29 green baseline, helpers `mkWorld`/`prune`/`survives`; new test files must be wired in `.github/workflows/tests.yml` or `test-ci-suite-registration.mjs` fails.

## §3 Objective

A pre-existing `index.jsonl` that is a directory (EISDIR class) makes `em-prune`, `em-promote`, `em-review-request`, and `em-workflow-validate` abort with each script's own typed `{status:'error', message}` envelope on stdout (exit code 1, unchanged from today's crash), never a raw Node stack trace with empty stdout.

## §4 Requirements (Ground Truth)

| REQ | Statement | Parent | Tests | Priority |
|---|---|---|---|---|
| REQ-1 | `em-prune` module-init reference-scan loads (`em-prune.mjs:244`, both stores) route through a guard emitting the existing R5(b) abort envelope (`:271` shape): exit 1, archive nothing, message naming the offending `index.jsonl` with reason `episode index unreadable (<code>)` | RFC-011 R5(b) posture (crash today bypasses it in spirit) | T1, T2 | MUST |
| REQ-2 | `em-promote` module-init loads (`:140`, `:238`) AND the pre-lock migrate-path loads (`:447`, `:466`, `:468`) route through a local guard emitting `{status:'error', message}` exit 1 naming the file | #626 pattern + §19 Round 0 gap 3 | T3, T3a, T3c | MUST |
| REQ-3 | `em-review-request` module-init loads (`:215-216`) route through a local guard using its `fail(1, message)` helper (`:84`) | #626 pattern | T4 | MUST |
| REQ-4 | `em-workflow-validate` module-init loads (`:907-908`) route through a local guard using its `fail(message, 1)` helper (`:104`) | #626 pattern | T5 | MUST |
| REQ-5 | On every guarded abort: typed JSON is the LAST stdout line, exit code 1, no partial writes (prune archives nothing) | #626 REQ parity | T1–T5 | MUST |
| REQ-6 | Guards live per-script; `scripts/lib/relevance.mjs:loadIndex` is byte-unchanged (blast-radius rule, fix-626 §5) | fix-626 §5 | V-static | MUST |

## §5 Non-Goals

- Read-only query tools (`em-search`, `em-recall`, `em-list`, `em-check-stale`, `em-graph`, `em-semantic`): no RFC binds an envelope contract for them (Scout A spec check); needs contract design first → follow-up issue.
- `em-stats.mjs:78` and `em-doctor.mjs` (4 sites): same no-contract diagnostics class → same follow-up issue (and #628's same-class table gets corrected there).
- `em-store.mjs:455` write-side EISDIR + orphaned episode file: distinct defect (write ordering, not read guard) → its own follow-up issue.
- `em-consolidate.mjs:365` foldStore TOCTOU: stays deferred exactly as #626 §17 left it.
- Function-internal `loadIndex` sites in `em-promote` `:653,:671,:795` ONLY: genuinely TOCTOU-only (§19 Round 0 probe) — `:653` runs in the per-candidate apply loop after the `:585` selector already read the same indexes; `:671/:795` execute inside `withStoreLockSync` bodies where the #626 in-lock complication applies — see §17 DEFER-1. (`:447/:466/:468` were reclassified reachable-pre-existing by the Round 0 audit and are now IN scope — REQ-2.)
- Silent-`[]` bypass class (symlink-loop / dangling-symlink / parent-dir-EACCES → `existsSync` false → loader returns `[]` → exit 0 with protection evidence lost; FIFO-shaped index → indefinite hang): pre-existing behavior in ALL loaders including `lib/relevance.mjs` (REQ-6 byte-unchanged) — follow-up issue filed at PR time; see §17 DEFER-4.
- No change to `lib/relevance.mjs` (REQ-6).

## §6 Token Budget (Rule 12)

Builder seat (MiniMax M3): single-pass mechanical execution of Appendix A, est. ≤ 400k up / ≤ 35k down (627-arc actual: 409k/27k for a larger plan; this one adds 4 steps + 3 test legs over the pre-revision estimate). Reviewer: one frozen-diff round, est. ≤ 120k.

## §7 Safety / Security

No destructive operations. All new test fixtures live under `os.tmpdir()` with `HOME` pinned (Scout B §1 pattern); no repo or user store is touched. Guards only convert an existing crash (exit 1) into a typed abort (exit 1) — fail direction unchanged, fail-closed preserved.

## §8 Design

### 8.1 Key types

None new. Envelope shapes are each script's existing ones (§4).

### 8.2 Key invariants

- I1: guard wraps the EXISTING loader; loader bodies are unchanged.
- I2: abort emits on stdout and exits 1 — mirrors `em-prune.mjs:270-273` and #626's `emitProtectionAbort`.
- I3: reason string is `episode index unreadable (<e.code || e.message || 'unknown'>)` — the same discriminator #626 tests grep for, reused so operators see one vocabulary.
- I4: no lock is held at any guarded site (all four are module-init, before any lock acquisition), so plain `process.exit(1)` is safe — the in-lock inline-guard complication from fix-626 (`em-consolidate.mjs:1231`) does not arise here.

### 8.3 Resolution / flow

Per script: define `loadIndex(Rows)OrAbort` beside the existing loader → replace only the module-init call sites. Listings L1–L4.

## §9 Existing Hook Points

- `em-prune.mjs:270-273` — R5(b) abort emitter (shape copied, not refactored).
- `em-review-request.mjs:84` `fail(code, message, errors)`; `em-workflow-validate.mjs:104` `fail(msg, code)` — reused directly.
- `tests/test-prune-protection.mjs` `mkWorld`/`prune`/`survives` helpers — reused for T1/T2.

## §10 Slice Ladder

Single slice S1 (four small script edits + tests + CI wiring). No ladder needed.

### 10.1 Dependency graph

Steps are independent per script; tests depend on their script's edit; CI wiring last.

## §11 Cut Order

If cut mid-way, each completed script edit + its test leg is independently shippable; em-prune (steps 1.x) leads per the issue.

## §12 Contracts

### `loadIndexRowsOrAbort(dataDir, storeLabel) → rows[]` (em-prune)

Returns `loadIndexRows(...)`; on throw prints `{status:'error', message:'em-prune: aborting archival — episode index unreadable (<code>) (<file>)'}` and exits 1.

### `loadIndexOrAbort(dataDir, source) → rows[]` (em-promote / em-review-request / em-workflow-validate)

Same shape; emitter is the script's own (§4 REQ-2/3/4).

## §13 Edge Cases

- Missing `index.jsonl`: unchanged — loaders return `[]` before any read (existsSync short-circuit).
- Malformed JSON lines: unchanged — per-line try/catch inside loaders still skips.
- Directory-shaped `index.jsonl`: NEW typed abort (was raw EISDIR stack).
- Unreadable file (EACCES): same guard path, reason carries `EACCES`.
- `em-promote` with empty registry: `:140` loop not reached; `:238` still guarded (Scout A probe row 2).
- Registered store WITH identity + dir-shaped index: `:140` guard fires naming THAT store's `index.jsonl` — identity resolution reads `episodes/*.md`, not the index (`store-identity.mjs:95-113`), so identity survives index corruption (T3a).
- `--migrate` + registered identity-LESS store + dir-shaped index: `:137` skips it in the `:140` loop, `:238` global load passes (valid global fixture), `migrationRows` `:468` guard fires (T3c — the §19 Round 0 falsification repro, inverted).
- Corrupt LOCAL index + `--scope global` prune: abort names the LOCAL `index.jsonl` — the `:244` union loads both stores regardless of scope; attribution asserted by T2b (§19 Round 0 axis-6 note).
- Symlink-loop / dangling-symlink / parent-EACCES index: NOT covered by the guard (`existsSync` false → silent `[]`) — dispositioned in §17 DEFER-4, not silently ignored.
- Valid `playbooks.json` + corrupt index (prune): abort must name `index.jsonl`, not `playbooks.json` (T1 discriminator, mirrors t4b).

## §14 Test Case Catalog

| ID | File | Scenario | Assertions |
|---|---|---|---|
| T1 | `tests/test-prune-protection.mjs` (new leg) | valid playbooks, LOCAL `index.jsonl` replaced by directory, `--scope local` | exit 1; last stdout line parses; message matches `/episode index unreadable/` and `/index\.jsonl/`, NOT `/playbooks\.json/`; no episode file moved (`survives` unchanged) |
| T2 | same (new leg) | GLOBAL index corrupted, `--scope global` | same assertions against global store; global episode file untouched (direct `existsSync`, NOT `survives()` — see L5 note) |
| T2b | same (new leg) | LOCAL index corrupted, `--scope global` | exit 1; message names `proj/.episodic-memory/index.jsonl` and NOT `home/.episodic-memory/index.jsonl` (cross-scope attribution honesty, §19 Round 0 axis-6 note) |
| T3 | `tests/test-628-sibling-init-guard.mjs` (new) | fake-HOME global index corrupted, empty registry, run `em-promote.mjs` | exit 1 (`:238` site); stdout typed envelope matches `/em-promote: episode index unreadable/`; stderr has no `at ` stack frame |
| T3a | same | registered store WITH hand-written identity episode + `installs.json` entry, THAT store's index dir-shaped, global index valid, run `em-promote.mjs` | exit 1 (`:140` site); typed envelope; message contains `regproj/.episodic-memory/index.jsonl` (names the registered store, not global) |
| T3c | same | registered identity-LESS store with dir-shaped index, global valid, run `em-promote.mjs --migrate` | exit 1 (`:468` site, was raw crash — §19 Round 0 DEFER-1 falsification); typed envelope; no stack frame on stderr |
| T4 | same | local index corrupted, run `em-review-request.mjs --task t1 --plan-ref file:README.md --approval-ref episode:x --pre-checkpoint-ref episode:x --post-checkpoint-ref episode:x --tests-ref file:README.md --code-review-ref episode:x --no-new-bugs --scope local --branch main --head deadbeef --dry-run` | exit 1; envelope matches `/em-review-request: episode index unreadable/`; has `errors` array (`fail()` `:85-88` always emits `errors: []`) |
| T5 | same | local index corrupted, run `em-workflow-validate.mjs --task t1 --gate pre-checkpoint --scope local --branch main --head deadbeef` | exit 1; envelope matches `/em-workflow-validate: episode index unreadable/` |

T4 argv note: TWO usage gates sit before the guarded loads (`:215-216`) and both must pass — the required-flag gate (`:118-129`, needs all 7 refs; the Round 0 BLOCKER) and the bug-log XOR gate (`:153-158`, needs `--no-new-bugs` OR `--bug-log-ref`; caught by the builder's step-6.1 STOP, 2026-08-02). Dummy ref values are safe: `checkRef` (`:339`) runs AFTER the guarded site, so the abort fires first.

Falsifiability: every T-leg fails on HEAD `c88c90f` — T1/T2/T2b/T3/T4/T5 raw EISDIR stack with empty stdout (Scout A transcript), T3a raw crash at `:140`, T3c raw crash at `:468` (§19 Round 0 probe) — and passes only when the guard emits the typed envelope.

## §15 Verification Ledger (verify by artifact)

Baseline (captured 2026-08-02, HEAD `c88c90f`, Scout B §4): `test-prune-protection.mjs` 29/29 exit 0; `test-rfc-015-p1-s2-consolidation.mjs` 34/34 exit 0; `test-em-consolidate.mjs` 8/8 exit 0; `test-fold-superseded.mjs` 11/11 exit 0. Post-change expectations are in §A.7/§A.8.

## §16 Risk Analysis

Low. Guards add a try/catch around existing calls; behavior changes ONLY on the throw path, which today is an uncaught crash with the same exit code.

## §17 Open Decisions

DEFER-1 (em-promote TOCTOU-only `loadIndex` sites `:653,:671,:795` — REWRITTEN per §19 Round 0 gap 3; `:447/:466/:468` are now IN scope, REQ-2):
- Run-the-scenario: with a pre-existing corrupt index, the `:585` selector (via `migrationRows` `:466/:468`, now guarded) aborts before `:653` executes; `:671/:795` sit inside `withStoreLockSync` bodies (`:663/:787`) that only run after earlier reads of the same files succeeded. Round 0 probe: "`:653/:671/:795` remain genuinely TOCTOU-only."
- Spec check: no RFC binds mid-run (TOCTOU) index corruption for em-promote.
- History check: same boundary as #626's foldStore deferral (`fix-626-consolidate-init-guard.md:63-65`).
- Same-class check (full TOCTOU-residual sweep): em-promote `:653/:671/:795`; em-consolidate foldStore `:365` (#626 §17, unchanged); em-prune `partitionPrunable` `:96-104`; em-review-request under-lock re-read `:499-506`. The last two were Round-0-verified unreachable with a pre-existing corrupt index (their module-init guards abort first). None silently omitted.
- Residual risk: mid-run corruption still crashes raw; fail direction safe (exit 1, no partial global write). `:671/:795` additionally hold the global lock, where the #626 in-lock complication makes a plain `process.exit` guard the wrong shape — deferring avoids importing that complexity for a TOCTOU-only window.

DEFER-2 (read-only query tools + `em-stats.mjs:78` + `em-doctor.mjs` 4 sites):
- Run-the-scenario: Scout A runtime-probed `em-stats.mjs:78` raw crash (the issue's "clean" claim is wrong); em-doctor's 4 unguarded sites confirmed same class.
- Spec check: no RFC binds an error-envelope contract for read-only/diagnostic tools (Scout A spec check). The Round 0 envelope note (em-consolidate carries a typed `code` field, siblings are message-only) makes contract design a prerequisite — consumers verified tolerant today (`em-routines.mjs:361-366`, `em-manage.mjs` runJson, `em-console.mjs:216`).
- History check: no prior arc guards diagnostics; #628's own same-class table needs the em-stats correction, which belongs in the follow-up.
- Same-class check: `em-search`, `em-recall`, `em-list`, `em-check-stale`, `em-graph`, `em-semantic`, `em-stats:78`, `em-doctor` (4 sites) — Scout A's enumeration, none omitted.
- Residual risk: diagnostics crash raw on a corrupt index; read-only, no data-loss direction; follow-up issue filed at PR time (§5, §18).

DEFER-3 (`em-store.mjs:455` write-side EISDIR orphan):
- Run-the-scenario: Scout A probe — the episode `.md` write succeeds, the index append crashes EISDIR, an orphaned episode file is left behind.
- Spec check: write-ordering defect (episode-file-then-index), a store-consistency invariant — different contract than this plan's read-guard abort envelope.
- History check: new defect class found by Scout A this arc; no prior deferral to inherit.
- Same-class check: single site (`em-store.mjs:455`); other writers go through `withStoreLockSync` + atomic temp-rename paths.
- Residual risk: repeated crashes accumulate orphans until `em-rebuild-index` heals; bounded and recoverable; follow-up issue filed at PR time (§5, §18).

DEFER-4 (silent-`[]` bypass: symlink-loop / dangling-symlink / parent-dir-EACCES / FIFO — §19 Round 0 gap 2):
- Run-the-scenario: Round 0 runtime probes — the three `existsSync`-false shapes return `[]` and exit 0 with protection evidence silently lost; a FIFO-shaped index hangs indefinitely (no guard can fire in either case: the throw path is never reached).
- Spec check: RFC-011 R5(b) binds "index unreadable" to abort for em-prune archival, but an index whose existence check is false is currently indistinguishable from genuinely-absent-on-first-use; distinguishing them requires lstat-based existence semantics in EVERY loader including `lib/relevance.mjs` — which REQ-6 holds byte-unchanged. Scope-in is a contract change, not a guard.
- History check: pre-existing in #626's guards too (same `existsSync` short-circuit); neither introduced nor widened by this plan.
- Same-class check: all four shapes enumerated (symlink-loop, dangling symlink, parent-dir EACCES, FIFO); the class affects all loaders uniformly.
- Residual risk: HIGH-direction — exit 0 with protection evidence silently lost is a strictly WORSE fail direction than the EISDIR crash this plan fixes. The follow-up issue filed at PR time must present it as its own defect (fail-open protection bypass), not a footnote.

Follow-up issues to file at PR time (§18): DEFER-2, DEFER-3, DEFER-4 (three issues; DEFER-4 gets the envelope `code`-field note from §19 Round 0 attached to the DEFER-2 contract-design issue).

## §18 Done Criteria

All §A.8 commands green; diff contains exactly the four script edits + two test-file changes + one workflow edit; PR opened referencing #628; three follow-up issues filed at PR time (DEFER-2 contract-design incl. the envelope `code`-field note, DEFER-3 em-store orphan, DEFER-4 silent-`[]` fail-open bypass — §17); CI green; operator merges.

## §19 Review Consensus (Rule 18)

To be filled from the reviewer round(s).

### Round 0 — negative-scenario-planner pre-review audit (2026-08-02, verdict HOLD)

Runtime-probed at c88c88f→c88c90f fixtures (probe harnesses were at session scratchpad `nsp628/probe.mjs`, `probe2.mjs`; findings restated here because scratchpad is ephemeral):

- Invariants I1–I4 verified (I4 lock claim confirmed by line cites: em-prune lock `:177` inside `pruneDir` post-`:244`; em-promote locks `:488/:663/:787` post-module-init; em-review-request lock `:489` post-`:215`; em-workflow-validate imports no lock lib). I5 falsified for T4.
- Corruption-variant probes: dir (empty and non-empty) → EISDIR raw crash (guard covers); file-level EACCES → throw (guard's `e.code` chain covers); symlink-loop / dangling symlink / parent-dir EACCES → `existsSync` false → silent `[]`, exit 0 (guard NEVER fires — Gap 2); FIFO → indefinite hang (guard can't help; document as residual).
- DEFER-1 falsification repro: fixture with `installs.json` entry whose store lacks identity episodes (`registered-stores.mjs:105` attaches no `store_id`) + pre-existing dir index → `em-promote --migrate` raw-crashes at `migrationRows` `:468` (with and without `--confirm`). `:653/:671/:795` remain genuinely TOCTOU-only.
- Cross-scope attribution note (Gap under axis 6): corrupt LOCAL index + `--scope global` prune — guard will abort naming the LOCAL path (the `:244` union loads both stores regardless of scope); consider a test leg asserting attribution.
- Envelope-contract note (MINOR, for the follow-up contract-design issue): sibling envelopes carry no typed `code` field while em-consolidate's does (`protection-abort:protection`); `message` doubles as machine discriminator. Consumers verified tolerant (`em-routines.mjs:361-366`, `em-manage.mjs` runJson, `em-console.mjs:216`).
- T4 repro of the blocker: the T4 argv exits 2 at `Missing required flags: --plan-ref…` before `:215`; with full refs the site crashes today.

### Revision 1 — orchestrator response to Round 0 (2026-08-02, all claims re-ground-truthed against source)

| Gap | Classification | Disposition + evidence |
|---|---|---|
| 1a T4 argv | ACCEPT | T4 argv carries all 7 required flags (gate `em-review-request.mjs:118-129`); `checkRef` `:339` runs after the guarded loads `:215-216`, so dummy refs are never dereferenced; `fail(code, message, errors = [])` `:85-88` always emits `errors: []`, so the errors-array assertion stands |
| 1b `:140` untested | ACCEPT | `listIdentityEpisodes` (`store-identity.mjs:95-113`) scans `episodes/*.md` and never reads `index.jsonl`, so identity survives a dir-shaped index and `:140` is reachable pre-existing. T3a fixture: `installs.json` `{entries:[{project_path, tool}]}` (`install-version.mjs:338-357` schema) + identity episode with `record_type: store-identity` and 16-hex `store_id` (`STORE_ID_RE`, `store-identity.mjs:12-14`) |
| 2 silent-`[]` | ACCEPT-WITH-MOD (defer, not scope-in) | DEFER-4 §17 + follow-up issue; scope-in forces existence-semantics changes into `lib/relevance.mjs`, violating REQ-6 |
| 3 DEFER-1 falsified | ACCEPT (scope-in `:447/:466/:468`) | All three run OUTSIDE any lock: `:447` in `selectMigrationCandidates` (called `:556/:585`, pre-lock), `:466/:468` in `migrationRows` (called `:556/:585`, pre-lock); locks begin `:488/:663/:787` — I4 holds for the new sites. `insufficientStores` (`:127`) is advisory-only (a `note` in output at `:567/:843`), so a single-entry registry reaches `migrationRows` under `--migrate`. DEFER-1 rewritten to `:653/:671/:795`; T3c inverts the falsification repro |
| 4 DEFER 5-field | ACCEPT | §17 fully rewritten; DEFER-1..4 each carry the 5 fields |
| 5 TOCTOU sweep | ACCEPT | em-prune `partitionPrunable :96-104` + em-review-request `:499-506` enumerated in DEFER-1 same-class field |
| 6 anchors/flags | ACCEPT | Step 2.2 three-line anchor (unique to `:140`; the `:653` lookalike has 14-space indentation and a different preceding context); L5 rewritten to the actual `prune()` contract `{status, out, raw}` (`test-prune-protection.mjs:80-86`) with `stderr` added by step 5.0; age flag dropped — module-init crash at `:244` precedes arg-dependent logic. Bonus fix found during re-ground-truth: original L5's `survives()` call in T1 would itself throw EISDIR (it reads the now-dir-shaped local `index.jsonl`) — T1/T2 assert episode-file existence directly instead |

Matrix re-walk on new surfaces (per the Round 0 reminder): the new guarded sites `:447/:466/:468` sit on the same EISDIR/EACCES axis Round 0 already runtime-probed (its DEFER-1 falsification IS the `:468` probe); no new axes open. Silent-`[]`/FIFO dispositions are unaffected by the scope-in (same `existsSync`/hang behavior at the new sites).

### Round 1 — kimi-k3 frozen-diff review (2026-08-02, verdict APPROVE)

13 runtime probes (P1–P13) in mkdtemp fixtures incl. falsification vs main (`git archive`-extracted copies: raw EISDIR stacks on main, typed envelopes on the diff, every probed leg). No BLOCKER/MAJOR. Findings + orchestrator classification:

1. NIT (ACCEPT, routed to builder): `.github/workflows/tests.yml:314` step name `Run #628…` — unquoted `#` is a YAML comment, display name degrades to "Run"; `run:` line unaffected. Fixed in-arc: scalar double-quoted.
2. MINOR plan-rationale (ACCEPT, plan-only): the gap-3 reclassification of `:447` as reachable-pre-existing is falsified by argument evaluation order — `selectMigrationCandidates(migrationRows())` evaluates `migrationRows()` first over the identical store set, so `:466/:468` always abort before `:447` can see pre-existing corruption (probe P13: dual-corrupt fixture aborts naming the global index). Pre-fix, `:447` throws were swallowed by the enclosing `catch {}` (silent source-skip, never a raw crash). The `:447` guard REMAINS correct and in scope: `process.exit(1)` is uncatchable, so it converts a TOCTOU-window silent-skip (fail-open direction) into a typed abort. No test leg can cover `:447` with pre-existing corruption; none is required.
3. NIT (ACCEPT-WITH-MOD, recorded here per #627 listing discipline instead of rewriting L6): as-built `mkStore` deviates from L6 verbatim — `fs.mkdirSync(globalDir, {recursive:true})` became `fs.mkdirSync(path.join(globalDir,'episodes'), {recursive:true})`, and the T4 argv tokens were re-wrapped (same tokens). Behavior-equivalent (5/5 pass, P-series green); permitted by L6's executor adaptation note.
4. Informational (ACCEPT, folded into DEFER-2 follow-up): em-promote never reads an unregistered cwd-local store (P5: corrupt local index + empty registry → exit 0) — pre-existing design, not the DEFER-4 silent-`[]` class (file never read, not `existsSync`-masked); one row in the follow-up issue's same-class table so it is not rediscovered as a missed guard.

## §20 Lessons Encoded

- #626: guard helper routes into the script's OWN abort emitter; never touch the shared primitive for a per-script contract.
- #627: verifies use absolute observed→expected counts; listings are fenced; suppression markers only fence-guarded.
- Exit-code lesson (`20260730-003429`): every Verify below measures exit codes directly, never through a pipe.

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

Node ≥ 20 (`node --version` in pre-flight), repo root `/Users/charltonho/Developer/projects/episodic-memory`, branch `fix-628-sibling-init-guard` off `main` at `c88c90f`. Executor edits files and runs single-command verifies only; NO commits, NO pushes, NO memory writes, NO files outside the seven named in §A.7.

## A.2 Executor contract

Steps run in strict numeric order, one file per step. Each step's Exact action names a verbatim ANCHOR; if the anchor is missing or non-unique, emit `STOP — step <n.m> blocked.` (Reason / File / Expected anchor / What I found / Question) and halt. No design decisions in the executor.

## A.3 STOP-and-ask protocol

As `docs/PLAN_TEMPLATE.md` §A.3 — fixed STOP block, wait for plan owner.

## A.4 Pre-flight environment check

Step 0: `git -C /Users/charltonho/Developer/projects/episodic-memory status --porcelain` → only pre-existing untracked lines (`.claude/hooks/runbooks/`, `.claude/hooks/second-opinion-gate.mjs`, `.review-store/`, `docs/plans/issue-628-sibling-init-guard.md`); `git log -1 --format=%h` → `c88c90f`; `node tests/test-prune-protection.mjs` → `29/29 pass` exit 0.

## A.6b Falsifiable Verify

Every Verify below is a single command with an absolute expected value; counts state observed→expected including occurrences the step's own Listing introduces.

## A.7 Per-slice step table

### S1 — sibling module-init guards (REQ-1..6)

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 1.1 | `scripts/em-prune.mjs` | EDIT | Insert Listing L1 verbatim immediately after the closing `}` of `loadIndexRows` (ANCHOR: the line `function loadInvertedIndex(dataDir, fileName) {` — insert L1 as a new block ABOVE the blank line preceding this anchor) | `grep -c 'function loadIndexRowsOrAbort' scripts/em-prune.mjs` → `1` |
| 1.2 | `scripts/em-prune.mjs` | EDIT | Replace the single line (ANCHOR, verbatim): `const referenceRows = [...loadIndexRows(LOCAL_DIR, 'local'), ...loadIndexRows(GLOBAL_DIR, 'global')]` with: `const referenceRows = [...loadIndexRowsOrAbort(LOCAL_DIR, 'local'), ...loadIndexRowsOrAbort(GLOBAL_DIR, 'global')]` | `grep -c 'loadIndexRowsOrAbort(' scripts/em-prune.mjs` → `3` (1 def from L1 + 2 calls; L1 itself contains the name once) |
| 1.3 | `scripts/em-prune.mjs` | VERIFY | Raw-call regression check | `grep -c 'loadIndexRows(LOCAL_DIR' scripts/em-prune.mjs` → `0` |
| 2.1 | `scripts/em-promote.mjs` | EDIT | Insert Listing L2 verbatim immediately BELOW the `missingSources` declaration (ANCHOR: the line `const missingSources = []`) | `grep -c 'function loadIndexOrAbort' scripts/em-promote.mjs` → `1` |
| 2.2 | `scripts/em-promote.mjs` | EDIT | Locate the three-line ANCHOR (verbatim, unique — the `:653` lookalike has 14-space indentation and does not match this sequence): `    continue` / `  }` / `  const rows = loadIndex(st.data_dir, st.label)` — in the anchor's THIRD line replace `loadIndex(` with `loadIndexOrAbort(` | `grep -c '  const rows = loadIndexOrAbort(st.data_dir, st.label)' scripts/em-promote.mjs` → `1` |
| 2.3 | `scripts/em-promote.mjs` | EDIT | Replace the line (ANCHOR, verbatim): `const globalRows = loadIndex(GLOBAL_DIR, 'global')` with: `const globalRows = loadIndexOrAbort(GLOBAL_DIR, 'global')` | `grep -c 'const globalRows = loadIndex(GLOBAL_DIR' scripts/em-promote.mjs` → `0` |
| 2.4 | `scripts/em-promote.mjs` | EDIT | In the single line containing (ANCHOR): `stores.flatMap(st => loadIndex(st.data_dir, st.label)` (the `## Sources` parse inside `selectMigrationCandidates`) replace `loadIndex(` with `loadIndexOrAbort(` — one occurrence in that line | `grep -c 'stores.flatMap(st => loadIndexOrAbort(st.data_dir, st.label)' scripts/em-promote.mjs` → `1` |
| 2.5 | `scripts/em-promote.mjs` | EDIT | Replace the line (ANCHOR, verbatim — unique: `:671/:795/:238` lookalikes bind different variable names): `  const out = loadIndex(GLOBAL_DIR, 'global')` with the same line calling `loadIndexOrAbort(` | `grep -c 'const out = loadIndexOrAbort(GLOBAL_DIR' scripts/em-promote.mjs` → `1` |
| 2.6 | `scripts/em-promote.mjs` | EDIT | Replace the line (ANCHOR, verbatim): `    for (const r of loadIndex(st.data_dir, st.label)) out.push(r)` with the same line calling `loadIndexOrAbort(` | `grep -c 'for (const r of loadIndexOrAbort(st.data_dir, st.label)) out.push(r)' scripts/em-promote.mjs` → `1` |
| 2.7 | `scripts/em-promote.mjs` | VERIFY | Total guarded-call census: 1 definition (L2) + 5 call sites (`:140,:238,:447,:466,:468`); raw `loadIndex(` remains ONLY at the L2 wrapper body + the three DEFER-1 sites (`:653,:671,:795`) | `grep -c 'loadIndexOrAbort(' scripts/em-promote.mjs` → `6` |
| 3.1 | `scripts/em-review-request.mjs` | EDIT | Insert Listing L3 verbatim immediately after the closing `}` of its local `loadIndex` (ANCHOR: the comment line `// Load BOTH scopes regardless of --scope (folded gap #4 — wrapper-validator` — insert L3 ABOVE this comment) | `grep -c 'function loadIndexOrAbort' scripts/em-review-request.mjs` → `1` |
| 3.2 | `scripts/em-review-request.mjs` | EDIT | Replace the two adjacent lines (ANCHOR, verbatim): `const localEntries = loadIndex(LOCAL_DIR, 'local')` and `const globalEntries = loadIndex(GLOBAL_DIR, 'global')` with the same lines calling `loadIndexOrAbort(` | `grep -c 'loadIndexOrAbort(' scripts/em-review-request.mjs` → `3` |
| 4.1 | `scripts/em-workflow-validate.mjs` | EDIT | Insert Listing L4 verbatim immediately after the closing `}` of its local `loadIndex` (ANCHOR: the comment block starting `// Frontmatter scalar read (issue 558` — insert L4 ABOVE it) | `grep -c 'function loadIndexOrAbort' scripts/em-workflow-validate.mjs` → `1` |
| 4.2 | `scripts/em-workflow-validate.mjs` | EDIT | Replace the two adjacent lines (ANCHOR, verbatim): `const localEntries = loadIndex(LOCAL_DIR, 'local')` and `const globalEntries = loadIndex(GLOBAL_DIR, 'global')` (the pair directly under the comment ending `(#98 finding 2 follow-up).`) with the same lines calling `loadIndexOrAbort(` | `grep -c 'loadIndexOrAbort(' scripts/em-workflow-validate.mjs` → `3` |
| 5.0 | `tests/test-prune-protection.mjs` | EDIT | In the `prune()` helper's return statement (ANCHOR, verbatim): `return { status: r.status, out: parsed && Array.isArray(parsed.results) ? parsed.results[0] : parsed, raw: r.stdout }` — insert `, stderr: r.stderr` before the closing ` }` (additive field; existing legs unaffected) | `grep -c 'stderr: r.stderr' tests/test-prune-protection.mjs` → `1` |
| 5.1 | `tests/test-prune-protection.mjs` | EDIT | Append Listing L5 (three new legs T1, T2, T2b) after the last existing test function and register all three in the `tests[]` array following the file's existing pattern | `node tests/test-prune-protection.mjs` → `32/32 pass`, exit 0 |
| 6.1 | `tests/test-628-sibling-init-guard.mjs` | CREATE | Create with Listing L6 (T3, T3a, T3c, T4, T5) | `node tests/test-628-sibling-init-guard.mjs` → `5/5 pass`, exit 0 |
| 7.1 | `.github/workflows/tests.yml` | EDIT | In the `clerk-consolidation` job, add a run step `node tests/test-628-sibling-init-guard.mjs` directly after the existing `node tests/test-prune-protection.mjs` step, matching indentation | `grep -c 'test-628-sibling-init-guard' .github/workflows/tests.yml` → `1` |
| 7.2 | — | VERIFY | Suite-registration meta-lint | `node tests/test-ci-suite-registration.mjs` → pass, exit 0 |

## A.8 Definition of done (whole plan, mechanical)

1. `node tests/test-prune-protection.mjs` → `32/32 pass` exit 0
2. `node tests/test-628-sibling-init-guard.mjs` → `5/5 pass` exit 0
3. `node tests/test-rfc-015-p1-s2-consolidation.mjs` → `34/34 pass` exit 0
4. `node tests/test-em-consolidate.mjs` → 8 passed exit 0
5. `node tests/test-fold-superseded.mjs` → `11/11 pass` exit 0
6. `node tests/test-ci-suite-registration.mjs` → pass exit 0
7. `git diff --stat main` names exactly: 4 scripts, 2 test files, 1 workflow file (7 files)
8. `git diff main -- scripts/lib/relevance.mjs` → empty output (REQ-6)

## Listings

### Listing L1 — em-prune guard

```js
// #628: a corrupt primary index (e.g. index.jsonl that is a directory — EISDIR)
// must abort with the R5(b) envelope, never a raw stack trace. Both module-init
// reference-scan loads route through this guard: exit 1, archive nothing, name
// the offending file. Shape mirrors the R5(b) abort emitter below.
function loadIndexRowsOrAbort(dataDir, storeLabel) {
  try {
    return loadIndexRows(dataDir, storeLabel)
  } catch (e) {
    const file = path.join(dataDir, 'index.jsonl')
    console.log(JSON.stringify({ status: 'error', message: `em-prune: aborting archival — episode index unreadable (${e && e.code ? e.code : (e && e.message) || 'unknown'}) (${file})` }))
    process.exit(1)
  }
}
```

### Listing L2 — em-promote guard

```js
// #628: the module-init loads (:140, :238) and the pre-lock migrate-path loads
// (:447, :466, :468) abort with a typed envelope on a corrupt index.jsonl
// (EISDIR class) instead of a raw stack. The remaining raw sites (:653, :671,
// :795) are TOCTOU-only — reachable solely via mid-run corruption after these
// guarded loads already succeeded — and stay raw, mirroring #626's foldStore.
function loadIndexOrAbort(dataDir, source) {
  try {
    return loadIndex(dataDir, source)
  } catch (e) {
    const file = path.join(dataDir, 'index.jsonl')
    console.log(JSON.stringify({ status: 'error', message: `em-promote: episode index unreadable (${e && e.code ? e.code : (e && e.message) || 'unknown'}) (${file})` }))
    process.exit(1)
  }
}
```

### Listing L3 — em-review-request guard

```js
// #628: module-init index loads abort via fail() on a corrupt index.jsonl
// (EISDIR class) instead of a raw stack trace.
function loadIndexOrAbort(dataDir, source) {
  try {
    return loadIndex(dataDir, source)
  } catch (e) {
    fail(1, `em-review-request: episode index unreadable (${e && e.code ? e.code : (e && e.message) || 'unknown'}) (${path.join(dataDir, 'index.jsonl')})`)
  }
}
```

### Listing L4 — em-workflow-validate guard

```js
// #628: module-init index loads abort via fail() on a corrupt index.jsonl
// (EISDIR class) instead of a raw stack trace. Exit 1 preserves today's
// observable exit code (the uncaught crash also exits 1).
function loadIndexOrAbort(dataDir, source) {
  try {
    return loadIndex(dataDir, source)
  } catch (e) {
    fail(`em-workflow-validate: episode index unreadable (${e && e.code ? e.code : (e && e.message) || 'unknown'}) (${path.join(dataDir, 'index.jsonl')})`, 1)
  }
}
```

### Listing L5 — prune corrupt-index legs (T1, T2, T2b)

Contract notes (re-ground-truthed 2026-08-02): `prune()` returns `{status, out, raw}` — `status` is the exit code, `out` the parsed envelope (step 5.0 adds `stderr`). No age flag is passed: the module-init crash at `:244` precedes all arg-dependent logic. `survives()` reads the LOCAL `index.jsonl` and would itself throw EISDIR once that index is dir-shaped — T1/T2 assert episode-file existence directly instead.

```js
function corruptIndexDir(dir) {
  fs.rmSync(path.join(dir, 'index.jsonl'))
  fs.mkdirSync(path.join(dir, 'index.jsonl'))
}

function testCorruptLocalIndexAbortsTyped() {
  const w = mkWorld([row('20240101-000000-keep-aaaa')], [], {})
  corruptIndexDir(path.join(w.proj, '.episodic-memory'))
  const r = prune(w, [], 'local')
  assert(r.status === 1, `exit 1, got ${r.status}`)
  assert(r.out && r.out.status === 'error', 'typed envelope on stdout')
  assert(/episode index unreadable/.test(r.out.message), 'reason discriminator')
  assert(/index\.jsonl/.test(r.out.message), 'names index.jsonl')
  assert(!/playbooks\.json/.test(r.out.message), 'not attributed to playbooks')
  assert(!/at .*\.mjs/.test(r.stderr), 'no raw stack frames on stderr')
  assert(fs.existsSync(path.join(w.proj, '.episodic-memory', 'episodes', '20240101-000000-keep-aaaa.md')), 'nothing archived')
}

function testCorruptGlobalIndexAbortsTyped() {
  const w = mkWorld([], [row('20240101-000000-keep-bbbb')], {})
  corruptIndexDir(path.join(w.home, '.episodic-memory'))
  const r = prune(w, [], 'global')
  assert(r.status === 1, `exit 1, got ${r.status}`)
  assert(r.out && r.out.status === 'error', 'typed envelope on stdout')
  assert(/episode index unreadable/.test(r.out.message), 'reason discriminator')
  assert(/index\.jsonl/.test(r.out.message), 'names index.jsonl')
  assert(fs.existsSync(path.join(w.home, '.episodic-memory', 'episodes', '20240101-000000-keep-bbbb.md')), 'nothing archived')
}

function testCorruptLocalIndexAttributionUnderGlobalScope() {
  // §19 Round 0 axis-6: the :244 union loads BOTH stores regardless of --scope;
  // the abort must name the store that is actually corrupt (local), not global.
  const w = mkWorld([row('20240101-000000-keep-cccc')], [row('20240101-000000-keep-dddd')], {})
  corruptIndexDir(path.join(w.proj, '.episodic-memory'))
  const r = prune(w, [], 'global')
  assert(r.status === 1, `exit 1, got ${r.status}`)
  assert(r.out && r.out.status === 'error', 'typed envelope on stdout')
  assert(r.out.message.includes(path.join('proj', '.episodic-memory', 'index.jsonl')), 'names the LOCAL index')
  assert(!r.out.message.includes(path.join('home', '.episodic-memory', 'index.jsonl')), 'does not blame the global index')
}
```

(Executor: adapt `row(...)` ids to the file's ACTUAL helper signatures — §A.3 STOP if `mkWorld`/`prune`/`survives` signatures differ from Scout B §2's description; the assertions themselves are fixed.)

### Listing L6 — sibling guard suite (T3, T3a, T3c, T4, T5)

```js
#!/usr/bin/env node
// #628: sibling scripts abort with typed envelopes (not raw stacks) on a
// directory-shaped index.jsonl. Companion to test-prune-protection.mjs legs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function t(name, fn) { try { fn(); pass++; console.log(`ok - ${name}`) } catch (e) { fail++; console.log(`not ok - ${name}: ${e.message}`) } }

function mkStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em628-'))
  const proj = path.join(root, 'proj'); fs.mkdirSync(proj)
  const seed = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'em-store.mjs'),
    '--project', 'test', '--category', 'decision', '--summary', 'seed', '--body', 'seed', '--scope', 'local'],
    { cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: root } })
  assert(seed.status === 0, `seed store failed: ${seed.stderr}`)
  const localDir = path.join(proj, '.episodic-memory')
  fs.rmSync(path.join(localDir, 'index.jsonl'))
  fs.mkdirSync(path.join(localDir, 'index.jsonl'))
  const globalDir = path.join(root, '.episodic-memory')
  fs.mkdirSync(globalDir, { recursive: true })
  fs.rmSync(path.join(globalDir, 'index.jsonl'), { force: true })
  fs.mkdirSync(path.join(globalDir, 'index.jsonl'), { recursive: true })
  return { root, proj }
}

function run(script, args, store) {
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args],
    { cwd: store.proj, encoding: 'utf8', env: { ...process.env, HOME: store.root } })
}

function lastJson(stdout) {
  try { return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()) } catch { return null }
}

function checkTyped(r, who) {
  assert(r.status === 1, `${who}: exit 1, got ${r.status}`)
  const j = lastJson(r.stdout)
  assert(j && j.status === 'error', `${who}: typed envelope on stdout, got: ${r.stdout.slice(0, 120)}`)
  assert(new RegExp(`${who}: episode index unreadable`).test(j.message), `${who}: reason discriminator`)
  assert(/index\.jsonl/.test(j.message), `${who}: names index.jsonl`)
  assert(!/at .*\.mjs/.test(r.stderr), `${who}: no raw stack frames on stderr`)
  return j
}

// T3a/T3c fixture: a REGISTERED project store with a dir-shaped index and a
// VALID (empty) global index, so the abort attribution is unambiguous. With
// identity: a hand-written store-identity episode (record_type + 16-hex
// store_id per store-identity.mjs STORE_ID_RE) — identity resolution scans
// episodes/*.md, never index.jsonl, so it survives the corrupt index and the
// :140 loop reaches the store. Without identity: :137 skips it in that loop
// and only the migrate path (:468) touches its index.
function mkRegisteredWorld({ identity }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em628r-'))
  const proj = path.join(root, 'proj'); fs.mkdirSync(proj)
  const globalDir = path.join(root, '.episodic-memory')
  fs.mkdirSync(path.join(globalDir, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(globalDir, 'index.jsonl'), '')
  const regProj = path.join(root, 'regproj')
  const regDir = path.join(regProj, '.episodic-memory')
  fs.mkdirSync(path.join(regDir, 'episodes'), { recursive: true })
  fs.mkdirSync(path.join(regDir, 'index.jsonl'))
  if (identity) {
    fs.writeFileSync(path.join(regDir, 'episodes', '20240101-000000-store-identity-abcd.md'), [
      '---', 'id: 20240101-000000-store-identity-abcd', 'record_type: store-identity',
      'store_id: abcdefabcdefabcd', 'status: active', '---', '',
    ].join('\n'))
  }
  fs.writeFileSync(path.join(globalDir, 'installs.json'),
    JSON.stringify({ schema_version: 1, entries: [{ project_path: regProj, tool: 'test' }] }))
  return { root, proj }
}

t('em-promote aborts typed on corrupt global index', () => {
  const s = mkStore()
  checkTyped(run('em-promote.mjs', [], s), 'em-promote')
})

t('em-promote :140 aborts typed on registered identity-carrying store with corrupt index', () => {
  const s = mkRegisteredWorld({ identity: true })
  const j = checkTyped(run('em-promote.mjs', [], s), 'em-promote')
  assert(j.message.includes(path.join('regproj', '.episodic-memory', 'index.jsonl')),
    'em-promote: names the REGISTERED store index, not global')
})

t('em-promote --migrate aborts typed on registered identity-less store with corrupt index', () => {
  const s = mkRegisteredWorld({ identity: false })
  checkTyped(run('em-promote.mjs', ['--migrate'], s), 'em-promote')
})

t('em-review-request aborts typed on corrupt local index', () => {
  const s = mkStore()
  const r = run('em-review-request.mjs', ['--task', 't1',
    '--plan-ref', 'file:README.md', '--approval-ref', 'episode:x',
    '--pre-checkpoint-ref', 'episode:x', '--post-checkpoint-ref', 'episode:x',
    '--tests-ref', 'file:README.md', '--code-review-ref', 'episode:x',
    '--no-new-bugs', '--scope', 'local', '--branch', 'main', '--head', 'deadbeef', '--dry-run'], s)
  const j = checkTyped(r, 'em-review-request')
  assert(Array.isArray(j.errors), 'em-review-request: errors array present')
})

t('em-workflow-validate aborts typed on corrupt local index', () => {
  const s = mkStore()
  checkTyped(run('em-workflow-validate.mjs', ['--task', 't1', '--gate', 'pre-checkpoint',
    '--scope', 'local', '--branch', 'main', '--head', 'deadbeef'], s), 'em-workflow-validate')
})

console.log(`${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
```

(Executor: if `em-store.mjs` cannot seed because the corrupt-global mkdir ordering interferes, seed BEFORE corrupting both stores — §A.3 STOP only if the seed itself fails on a clean store.)
