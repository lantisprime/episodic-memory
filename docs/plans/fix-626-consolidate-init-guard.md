# FIX-626 em-consolidate primary-index load guard (R4d envelope on corrupt store)

## §1 Status

`Approved for build.` Round 1 (GLM-5.2, plan + Appendix A): **ACCEPT-WITH-MOD** — F1 (P2,
§14 falsifiability mechanism corrected + reason-prefix assertions added to the four new
legs), F2 (P3, :750 pre-existing catch documented), F3 (NIT, `clerkReadIndexRows:1550`
enumerated). All three mods applied 2026-07-28; reply at
`.review-store/fix-626-review-r1-reply.md`. Round 2 reviews the frozen diff.

| Field | Value |
|---|---|
| RFC | `RFC-015` (R4d fail-closed abort contract) |
| Parent requirements | `R4d` |
| Tracking issue | `#626` |
| Workplan episode | `20260726-154333-workplan-v280-rfc-015-p1-s2-built-pr-625-a3ef` |
| Target branch | `fix/626-consolidate-init-guard` |
| Executor altitude (§0.1) | **low** (pi/MiniMax-M3 builder seat; Appendix A is the build path) |

## §2 Episode Search Summary

Run this session (2026-07-28): workplan v280 (`…-a3ef`), handoff 103 (`…-76fa`),
authoritative playbook v15 (`…-99bf`), seat-brief hard rules (`…-5824`), pinned deploy
legs (`…-4a52`). Constraints they impose on this plan:

- Seats never invoke `em-*` directly; the test harness (fixture `cwd` + `HOME` spawn) is
  the only permitted runner. Verifies in Appendix A therefore run ONLY the registered
  suite `node tests/test-rfc-015-p1-s2-consolidation.mjs` and greps — no ad-hoc em-* runs.
- Builders do not commit; the orchestrator commits the frozen slice.
- `#626` was filed with 5-field DEFER evidence in PR #625; the t4b leg's assertions are
  frozen and must pass UNCHANGED (`tests/test-rfc-015-p1-s2-consolidation.mjs:191-204`).

## §3 Objective

A corrupt primary store (concretely: `index.jsonl` that is a directory, EISDIR) makes
`em-consolidate.mjs` abort with the existing R4d envelope
`{ status: 'error', mode, code: 'protection-abort:protection', message }` on stdout with
exit 1 — in every run mode — instead of dying with a raw Node stack trace and empty
stdout. Provable by the un-pended `t4b` leg plus four new per-mode legs in the registered
CI suite.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | Default cluster mode `--apply --confirm` on an EISDIR index exits 1 with JSON `code: 'protection-abort:protection'`, message matching `/index\.jsonl/` and NOT `/playbooks\.json/` | R4d | `t4b_abort_message_discriminates` (un-pended, assertions verbatim) | MUST | The #626 reproducer; assertions frozen since PR #625 |
| REQ-2 | Default cluster mode WITHOUT `--apply` (dry-run) same fixture → envelope with `mode: 'consolidate-dry-run'`, same code class, exit 1 | R4d | `t4c_dry_run_abort_envelope` | MUST | Site em-consolidate.mjs:830 serves both modes; label branches on `apply` |
| REQ-3 | Clerk report mode (`--clerk`) same fixture → envelope with `mode: 'clerk-report'`, same code class, exit 1 | R4d | `t4d_clerk_report_abort_envelope` | MUST | Mode previously had NO protection call at all (sites :592, :750) |
| REQ-4 | Clerk apply mode (`--clerk --apply --confirm`) same fixture → envelope with `mode: 'clerk-apply'`, exit 1 | R4d | `t4e_clerk_apply_abort_envelope` | MUST | Site :2054 ran before its own resolve at :2112 |
| REQ-5 | Clerk enrich mode (`--clerk --enrich`) same fixture → envelope with `mode: 'clerk-enrich'`, exit 1 | R4d | `t4f_clerk_enrich_abort_envelope` | MUST | Mode previously had no resolve anywhere (site :2297) |
| REQ-6 | No unguarded primary-store load remains: every `loadIndex(DATA_DIR, scope)` call site is either `loadIndexOrAbort(...)` or the single in-lock try/catch site | R4d | `grep -c 'loadIndexOrAbort(DATA_DIR' scripts/em-consolidate.mjs` → `5`; `grep -c 'loadIndex(DATA_DIR, scope)' scripts/em-consolidate.mjs` → `1` (the in-lock site, inside try/catch) | MUST | Static invariant; the in-lock site releases the lock before emitting |
| REQ-7 | Registered suite fully green with zero pending: `node tests/test-rfc-015-p1-s2-consolidation.mjs` prints `34/34 pass` (no `pending` suffix) | R4d | suite exit 0 + final line | MUST | 30 current legs (29 pass + 1 pending) + 4 new legs, t4b un-pended |

## §5 Non-Goals

- **Sibling scripts** (`em-prune.mjs:244` before its R5(b) check, `em-promote.mjs:140/238`,
  `em-review-request.mjs:215`, `em-workflow-validate.mjs:907`, and the read-only tools
  sharing `lib/relevance.mjs:97-108`): same exposure class, but no R4d envelope contract
  to violate. Filed as a follow-up issue (§17), NOT fixed here.
- **`lib/relevance.mjs` `loadIndex` itself is UNCHANGED.** The R4d contract belongs to
  em-consolidate; changing the shared primitive alters every consumer's failure mode
  (blast radius) for no #626 requirement.
- **`foldStore`'s load (`em-consolidate.mjs:344`)**: the fold branch resolves protection
  (which reads the same `index.jsonl`) BEFORE calling `foldStore`, so only mid-run
  corruption (TOCTOU) reaches it. Deferred with the sibling issue (§17).
- No behavior change on healthy stores; no change to the three degrade-by-design helpers
  (`clerkLoadLatestRunRecord:1576`, `clerkDetectOrphans:1609`, `clerkReadIndexRows:1550` —
  the third enumerated per round-1 F3; all reached only after a primary load has already
  aborted on a corrupt store).
- No change to `resolveProtectionOrAbort` / `emitProtectionAbort` themselves.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads | Writes | Notes |
|---|---|---|---|---|
| `scripts/em-consolidate.mjs` | 2411 | targeted ranges only (~400 lines) | ~35 lines | 7 anchored edits |
| `tests/test-rfc-015-p1-s2-consolidation.mjs` | 509 | ~120 lines | ~60 lines | flip + comment + 4 legs |

Single session, one PR. Builder reads are anchor-window only.

## §8 Design

One new module-scope guard pair, placed directly after `emitProtectionAbort` (:186):

- `indexUnreadableAbort(dataDir, e)` → builds the abort object with
  `kind: PROTECTION_ABORT_PROTECTION`,
  `reason: 'episode index unreadable (' + (e.code || e.message || 'unknown') + ')'`,
  `file: path.join(dataDir, 'index.jsonl')`. Mirrors the reason convention of
  `resolveProtectionOrAbort`'s own catch at :155 (`protection index unreadable (EISDIR)`)
  with a distinct prefix naming the primary-index load.
- `loadIndexOrAbort(dataDir, source, mode)` → `try { return loadIndex(...) } catch (e) {
  emitProtectionAbort(indexUnreadableAbort(dataDir, e), mode) }`. Never returns on failure
  (emit exits 1).

Five lock-free sites route through the helper: `:592` and `:750` (mode `'clerk-report'`),
`:830` (mode `apply ? 'consolidate-apply' : 'consolidate-dry-run'`), `:2054`
(`'clerk-apply'`), `:2297` (`'clerk-enrich'`). The in-lock reload at `:1213` CANNOT use the
helper — `emitProtectionAbort` calls `process.exit`, which skips `finally` and would leak
the store write lock (the emitter's own doc comment at :176-177). It gets an inline
try/catch that mirrors the existing abort shape at :1202-1205: release
`_csLockHandles`, null it, then emit with `indexUnreadableAbort`.

### 8.2 Key invariants

- Abort is the only failure direction; no site degrades to `[]` (that would silently run
  consolidation logic against an empty view of a corrupt store).
- The envelope reuses the EXISTING code string `protection-abort:protection` (`:182`);
  no new code class is introduced (t4b asserts this exact string).
- Every emit path with a held lock releases it first (only site: `:1213`).
- **Cross-platform:** no shell tricks; fixture corruption is `fs.rmSync` + `fs.mkdirSync`
  (already proven in t4/t4b); EISDIR is the POSIX/macOS/Linux code and the assertion on
  `message` matches `/index\.jsonl/`, not the errno spelling (Windows raises EISDIR here
  too via libuv, and the code branch falls back to `e.message`).
- **Atomicity:** untouched — no writes are added.

## §9 Existing Hook Points (verified 2026-07-28 at ee2997b)

| File | Line(s) | What it does today | Impact |
|---|---|---|---|
| `scripts/em-consolidate.mjs` | 176-186 | `emitProtectionAbort(abort, mode)` — single R4d emitter, stdout JSON + exit 1 | helper pair appended after it |
| `scripts/em-consolidate.mjs` | 73-74 | `PROTECTION_ABORT_PROTECTION` kind constants | reused, unchanged |
| `scripts/em-consolidate.mjs` | 592, 830, 2054, 2297 | unguarded `loadIndex(DATA_DIR, scope)` | rerouted through helper |
| `scripts/em-consolidate.mjs` | 750 | `loadIndex(DATA_DIR, scope)` inside a pre-existing silent-degrade `try {} catch {}` (:749/:765) | rerouted through helper — closes the :592→:750 TOCTOU silent-degrade (round-1 F2) |
| `scripts/em-consolidate.mjs` | 1213 | in-lock `loadIndex` reload | inline try/catch + lock release |
| `scripts/em-consolidate.mjs` | 1202-1205 | existing release-then-emit shape | mirrored verbatim at 1213 |
| `tests/test-rfc-015-p1-s2-consolidation.mjs` | 27-44 | `T4B_PENDING_626` + `tPending` | flip to `false`, comment rewritten |
| `tests/test-rfc-015-p1-s2-consolidation.mjs` | 191-204 | t4b leg, assertions frozen | UNCHANGED (only un-pended) |

## §12 Contracts

### `loadIndexOrAbort(dataDir, source, mode) → row[]`

**Input contract:** `dataDir` absolute store dir; `source` `'local'|'global'` label;
`mode` one of `'clerk-report' | 'clerk-apply' | 'clerk-enrich' | 'consolidate-apply' |
'consolidate-dry-run'`.
**Output contract:** returns `loadIndex`'s row array on success. On ANY throw from
`loadIndex`, emits the R4d envelope and exits 1 — never returns, never partially returns.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. healthy | `index.jsonl` readable (or absent → `[]` per loadIndex) | row array | none |
| B. corrupt-dir | `index.jsonl` is a directory (EISDIR) | stdout envelope `{status:'error', mode, code:'protection-abort:protection', message: 'em-consolidate: aborting <mode> — episode index unreadable (EISDIR) (<path>)'}` | `process.exit(1)` |
| C. other read error | any other throw (EACCES etc.) | same envelope, reason carries `e.code` or `e.message` | `process.exit(1)` |

**Fail direction: closed** (abort; no degrade).

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `index.jsonl` absent entirely | NOT an abort — `loadIndex` returns `[]` (`relevance.mjs:99`), modes proceed on empty store (existing behavior, unchanged) | existing suite legs stay green (29 current) |
| EC2 | corrupt index + VALID playbooks.json | message names `index.jsonl`, never `playbooks.json` | t4b (frozen assertion) |
| EC3 | corruption appears mid-apply, after resolve, at the in-lock reload | lock released, then envelope, exit 1 — no leaked lock | REQ-6 grep + review (window not deterministically reachable from outside; residual documented §17) |
| EC4 | clerk-apply without `--confirm` on corrupt store | existing `unconfirmed` fast-exit at :2049-2052 fires BEFORE the load — unchanged | t4e uses `--confirm` to reach the site |

## §14 Test Case Catalog

```text
Group 1: #626 envelope per mode (5 legs, all in tests/test-rfc-015-p1-s2-consolidation.mjs)
  t4b_abort_message_discriminates — un-pended; assertions verbatim (exit 1, /index\.jsonl/, not /playbooks\.json/, code protection-abort:protection)
  t4c_dry_run_abort_envelope — dry-run: exit 1, code, mode 'consolidate-dry-run', /index\.jsonl/
  t4d_clerk_report_abort_envelope — --clerk: exit 1, code, mode 'clerk-report', /index\.jsonl/
  t4e_clerk_apply_abort_envelope — --clerk --apply --confirm: exit 1, code, mode 'clerk-apply', /index\.jsonl/
  t4f_clerk_enrich_abort_envelope — --clerk --enrich: exit 1, code, mode 'clerk-enrich', /index\.jsonl/
```

Falsifiability (corrected per round-1 finding F1): a no-fix build makes every leg fail
(`r.json` is `null` → member access throws). A stub guard that swallows the throw and
returns `[]` is caught by TWO independent mechanisms: (a) t4d and t4f fail outright —
clerk-report and clerk-enrich have no downstream `resolveProtectionOrAbort`, so a swallow
yields a normal report envelope with the wrong/absent `code`; (b) t4c/t4d/t4e/t4f each
assert the reason prefix `/episode index unreadable/`, which ONLY `indexUnreadableAbort`
emits — the downstream resolver's independent catch (`em-consolidate.mjs:148-158`) emits
`protection index unreadable` instead, so a per-site swallow at :830 or :2054 that falls
through to the resolver still fails the new legs. t4b's assertions are frozen and do not
check the prefix; its :830 site is covered by t4c's stronger assertion. The EISDIR fixture
is the negative control per P1-S2 review finding F7 (`docs/plans/rfc-015-p1-s2.md:577`).

Runner: `node tests/test-rfc-015-p1-s2-consolidation.mjs` (registered in CI at
`.github/workflows/tests.yml:457-458`).

## §15 Verification Ledger (fill at implementation)

| Claim | Command | Observed artifact (2026-07-28, orchestrator-run) |
|---|---|---|
| Suite green, zero pending | `node tests/test-rfc-015-p1-s2-consolidation.mjs` | `34/34 pass`, exit 0, t4b + t4c-f all `ok` (also independently reproduced by the round-2 reviewer) |
| Adjacent suites unaffected | `node tests/test-em-consolidate.mjs` | `8 passed, 0 failed` |
| Fold path unaffected | `node tests/test-fold-superseded.mjs` | `11/11 pass` |
| Invariant: 5 helper sites | `grep -c 'loadIndexOrAbort(DATA_DIR' scripts/em-consolidate.mjs` | `5` |
| Invariant: 1 in-lock direct site | `grep -c 'loadIndex(DATA_DIR, scope)' scripts/em-consolidate.mjs` | `1` |
| CI green | `gh run list` on the PR head SHA | `<fill at PR>` |

Review record: R1 (GLM-5.2, plan + Appendix A) ACCEPT-WITH-MOD — F1 P2 / F2 P3 / F3 NIT,
all three ACCEPTED and applied (`.review-store/fix-626-review-r1-reply.md`). R2 (GLM-5.2,
frozen diff) ACCEPT — 2 record-only NITs, diff-vs-listing fidelity PASS on all 9 hunks
(`.review-store/fix-626-review-r2-reply.md`). Follow-up sibling-exposure issue: **#628**.

## §17 Open Decisions / DEFERs

- **Sibling-script exposure** → new follow-up issue (filed at step 9, before wrap-up).
  5 fields: (1) scenario runs — scout sweep 2026-07-28 confirmed unguarded top-level
  loads in em-prune:244 (before its R5(b) protection check), em-promote:140/238,
  em-review-request:215-216, em-workflow-validate:907-908, plus read-only tools via
  `lib/relevance.mjs:100`; (2) spec check — R4d binds em-consolidate only; no RFC binds
  the siblings' failure envelope, so defer is legal; (3) history — #626 itself, plus
  `tests/test-prune-protection.mjs` covers only corrupt-playbooks legs; (4) same-class —
  this PR fixes ALL six em-consolidate sites; siblings enumerated in the new issue, none
  left silently; (5) residual — siblings crash with raw stack trace exit 1: ugly but
  fail-closed, no data-loss path.
- **TOCTOU window at `foldStore:344`** → same follow-up issue; protection resolve reads
  the identical file first, residual is mid-run corruption only, crash direction safe.

## §18 Done Criteria

- [ ] All §4 MUST rows green (suite `34/34 pass`, both invariant greps).
- [ ] Frozen diff reviewed (§19) with every finding dispositioned.
- [ ] PR open, CI green verified via `gh run list` (not `gh pr checks`).
- [ ] Follow-up sibling issue filed (step 9) and cross-linked from #626.

## §19 Review Consensus

Provider: **pi/GLM-5.2 (neuralwatt) over Herdr** — pre-authorized reviewer; codex provider
is blocked by #516 (returns the SessionStart prompt) so the template's codex default does
not apply. Round 1 reviews THIS plan with Appendix A attached (freeze-before-review
lesson: the executor's verbatim code goes to the FIRST round). Round 2 reviews the frozen
diff. Cap 2 rounds; findings classified ACCEPT / ACCEPT-WITH-MOD / REJECT / DEFER /
NEEDS-EVIDENCE. Reviewer carries R1-R3 (enforcement gates only repo-src writes) and the
seat hard rules 1-8 (`…-5824`), including: NEVER invoke `em-*`; runtime probes ONLY via
`node tests/test-rfc-015-p1-s2-consolidation.mjs` from a repo checkout.

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check | `node --version` → `v2x` |
| Test-runner shape | `node tests/test-rfc-015-p1-s2-consolidation.mjs` |
| New-function phrasing | module-scope `function name(args) { }` (NOT exported — script-internal) |
| Break-input override | none needed: the EISDIR fixture inside each test leg IS the negative control (P1-S2 F7) |
| Search tool for verifies | `grep -c` / `grep -n` from the repo root |
| Repo-specific done-commands | `node tests/test-em-consolidate.mjs`, `node tests/test-fold-superseded.mjs` |

## A.2 Executor contract

Verbatim from PLAN_TEMPLATE §A.2 items 1-9, plus the seat hard rules 1-8 from episode
`20260726-092229-…-5824` — in particular: NEVER invoke any `em-*` script; the ONLY
runnable commands are the per-step verifies below and the three test suites named in A.8;
no git commit/push/checkout; one file per step; single-command verifies.

Read-only references: `scripts/lib/relevance.mjs`, `docs/plans/rfc-015-p1-s2.md`.

## A.4 Pre-flight (step 0)

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `fix/626-consolidate-init-guard` |
| Clean tree | `git status --porcelain` | empty (except pre-existing `.gitignore` modification — IGNORE it, never commit/revert it) |
| Baseline suite | `node tests/test-rfc-015-p1-s2-consolidation.mjs` | `29/29 pass, 1 pending`, exit 0 |

## A.7 Step table — slice FIX-626 (REQ-1..7)

**Files this slice may touch:** `scripts/em-consolidate.mjs`,
`tests/test-rfc-015-p1-s2-consolidation.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight A.4 | all rows pass |
| 1.1 | `scripts/em-consolidate.mjs` | APPEND (after anchor) | ANCHOR (verbatim, unique): <br>`    message: \`em-consolidate: aborting ${mode} — ${abort.reason} (${abort.file})\`,`<br>`  }))`<br>`  process.exit(1)`<br>`}` <br>Immediately AFTER this block, insert Listing L1 (below). | `grep -c 'function loadIndexOrAbort' scripts/em-consolidate.mjs` → `1` |
| 1.2 | `scripts/em-consolidate.mjs` | EDIT | ANCHOR: `  const _clerkAllRows = loadIndex(DATA_DIR, scope)` → REPLACE: `  const _clerkAllRows = loadIndexOrAbort(DATA_DIR, scope, 'clerk-report')` | `grep -c "_clerkAllRows = loadIndexOrAbort(DATA_DIR, scope, 'clerk-report')" scripts/em-consolidate.mjs` → `1` |
| 1.3 | `scripts/em-consolidate.mjs` | EDIT | ANCHOR: `      const allRows = loadIndex(DATA_DIR, scope)` → REPLACE: `      const allRows = loadIndexOrAbort(DATA_DIR, scope, 'clerk-report')` | `grep -c "allRows = loadIndexOrAbort(DATA_DIR, scope, 'clerk-report')" scripts/em-consolidate.mjs` → `1` |
| 1.4 | `scripts/em-consolidate.mjs` | EDIT | ANCHOR: `const rows = loadIndex(DATA_DIR, scope).filter(r =>` → REPLACE: `const rows = loadIndexOrAbort(DATA_DIR, scope, apply ? 'consolidate-apply' : 'consolidate-dry-run').filter(r =>` | `grep -c "const rows = loadIndexOrAbort(DATA_DIR, scope, apply" scripts/em-consolidate.mjs` → `1` |
| 1.5 | `scripts/em-consolidate.mjs` | EDIT | ANCHOR: `  const freshLiveRows = loadIndex(DATA_DIR, scope)` → REPLACE with Listing L2 (below). | `grep -c 'let freshLiveRows' scripts/em-consolidate.mjs` → `1` |
| 1.6 | `scripts/em-consolidate.mjs` | EDIT | ANCHOR (3 lines, verbatim): <br>`    process.exit(1)`<br>`  }`<br>(blank line)<br>`  const activeRaw = loadIndex(DATA_DIR, scope).filter(r =>` <br>→ REPLACE final line of the anchor with: `  const activeRaw = loadIndexOrAbort(DATA_DIR, scope, 'clerk-apply').filter(r =>` (other anchor lines unchanged) | `grep -c "loadIndexOrAbort(DATA_DIR, scope, 'clerk-apply')" scripts/em-consolidate.mjs` → `1` |
| 1.7 | `scripts/em-consolidate.mjs` | EDIT | ANCHOR (2 lines, verbatim): <br>`  const _revisePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'em-revise.mjs')`<br>(blank line)<br>`  const activeRaw = loadIndex(DATA_DIR, scope).filter(r =>` <br>→ REPLACE final line of the anchor with: `  const activeRaw = loadIndexOrAbort(DATA_DIR, scope, 'clerk-enrich').filter(r =>` (other anchor lines unchanged) | `grep -c "loadIndexOrAbort(DATA_DIR, scope, 'clerk-enrich')" scripts/em-consolidate.mjs` → `1` |
| 1.8 | — | — | Interim: suite must still pass with t4b still pending | `node tests/test-rfc-015-p1-s2-consolidation.mjs` → `29/29 pass, 1 pending`, exit 0 |
| 1.9 | `tests/test-rfc-015-p1-s2-consolidation.mjs` | EDIT | Replace the 9-line block from ANCHOR `// #626: scripts/em-consolidate.mjs:808 does \`const rows = loadIndex(DATA_DIR, scope)\`` through `const T4B_PENDING_626 = true` with Listing L3 (below). | `grep -c 'const T4B_PENDING_626 = false' tests/test-rfc-015-p1-s2-consolidation.mjs` → `1` |
| 1.10 | `tests/test-rfc-015-p1-s2-consolidation.mjs` | APPEND (after anchor) | ANCHOR (verbatim, unique): <br>`  assert.equal(r.json.code, 'protection-abort:protection',`<br>`    \`abort class must be the protection class, got ${r.json.code}\`)`<br>`})` <br>Immediately AFTER this block, insert Listing L4 (below). | `grep -c "await t('t4c_dry_run_abort_envelope'" tests/test-rfc-015-p1-s2-consolidation.mjs` → `1` |
| 1.11 | — | — | Full suite | `node tests/test-rfc-015-p1-s2-consolidation.mjs` → `34/34 pass`, exit 0 |
| 1.12 | — | — | Adjacent suite 1 | `node tests/test-em-consolidate.mjs` → `8/8 pass`, exit 0 |
| 1.13 | — | — | Adjacent suite 2 | `node tests/test-fold-superseded.mjs` → `11/11 pass`, exit 0 |

### Listing L1 (step 1.1 — inserted after `emitProtectionAbort`'s closing brace)

```js

// #626: a corrupt primary index (e.g. index.jsonl that is a directory — EISDIR)
// must abort with the R4d envelope above, never a raw stack trace. Every run
// mode's primary-store load routes through loadIndexOrAbort. The one in-lock
// reload (consolidate-apply) instead inlines indexUnreadableAbort after
// releasing its lock: emitProtectionAbort exits, and exit skips finally.
function indexUnreadableAbort(dataDir, e) {
  return {
    kind: PROTECTION_ABORT_PROTECTION,
    reason: `episode index unreadable (${e && e.code ? e.code : (e && e.message) || 'unknown'})`,
    file: path.join(dataDir, 'index.jsonl'),
  }
}

function loadIndexOrAbort(dataDir, source, mode) {
  try {
    return loadIndex(dataDir, source)
  } catch (e) {
    emitProtectionAbort(indexUnreadableAbort(dataDir, e), mode)
  }
}
```

### Listing L2 (step 1.5 — replaces the single line `  const freshLiveRows = loadIndex(DATA_DIR, scope)`)

```js
  let freshLiveRows
  try {
    freshLiveRows = loadIndex(DATA_DIR, scope)
  } catch (e) {
    releaseStoreWriteLocks(_csLockHandles)
    _csLockHandles = null
    emitProtectionAbort(indexUnreadableAbort(DATA_DIR, e), 'consolidate-apply')
  }
```

### Listing L3 (step 1.9 — replaces the comment block + flag line)

```js
// #626 (fixed): em-consolidate now guards every primary-index load — a corrupt
// store (EISDIR) routes into emitProtectionAbort instead of crashing with a raw
// stack trace. T4B_PENDING_626 stays as the pending mechanism's example wiring;
// tPending is kept for future issue-blocked legs.
const T4B_PENDING_626 = false
```

### Listing L4 (step 1.10 — inserted after the t4b block; four legs, verbatim)

```js

await t('t4c_dry_run_abort_envelope', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'dryrun' })
  writePlaybooks(s, { schema_version: 1, playbooks: [] })
  fs.rmSync(path.join(s.dir, 'index.jsonl'))
  fs.mkdirSync(path.join(s.dir, 'index.jsonl'))
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3'])
  assert.equal(r.code, 1, `dry-run must abort on a corrupt index, got exit ${r.code}: ${r.stdout}`)
  assert.equal(r.json && r.json.code, 'protection-abort:protection', `got ${r.json && r.json.code}`)
  assert.equal(r.json.mode, 'consolidate-dry-run', `got ${r.json.mode}`)
  assert.match(r.json.message, /index\.jsonl/, `must name index.jsonl, got ${r.json.message}`)
  assert.match(r.json.message, /episode index unreadable/, `must carry the init-guard reason prefix, got ${r.json.message}`)
})

await t('t4d_clerk_report_abort_envelope', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'clerkrep' })
  writePlaybooks(s, { schema_version: 1, playbooks: [] })
  fs.rmSync(path.join(s.dir, 'index.jsonl'))
  fs.mkdirSync(path.join(s.dir, 'index.jsonl'))
  const r = run(s, ['--clerk', '--scope', 'local'])
  assert.equal(r.code, 1, `clerk report must abort on a corrupt index, got exit ${r.code}: ${r.stdout}`)
  assert.equal(r.json && r.json.code, 'protection-abort:protection', `got ${r.json && r.json.code}`)
  assert.equal(r.json.mode, 'clerk-report', `got ${r.json.mode}`)
  assert.match(r.json.message, /index\.jsonl/, `must name index.jsonl, got ${r.json.message}`)
  assert.match(r.json.message, /episode index unreadable/, `must carry the init-guard reason prefix, got ${r.json.message}`)
})

await t('t4e_clerk_apply_abort_envelope', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'clerkapp' })
  writePlaybooks(s, { schema_version: 1, playbooks: [] })
  fs.rmSync(path.join(s.dir, 'index.jsonl'))
  fs.mkdirSync(path.join(s.dir, 'index.jsonl'))
  const r = run(s, ['--clerk', '--scope', 'local', '--apply', '--confirm'])
  assert.equal(r.code, 1, `clerk apply must abort on a corrupt index, got exit ${r.code}: ${r.stdout}`)
  assert.equal(r.json && r.json.code, 'protection-abort:protection', `got ${r.json && r.json.code}`)
  assert.equal(r.json.mode, 'clerk-apply', `got ${r.json.mode}`)
  assert.match(r.json.message, /index\.jsonl/, `must name index.jsonl, got ${r.json.message}`)
  assert.match(r.json.message, /episode index unreadable/, `must carry the init-guard reason prefix, got ${r.json.message}`)
})

await t('t4f_clerk_enrich_abort_envelope', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'clerkenr' })
  writePlaybooks(s, { schema_version: 1, playbooks: [] })
  fs.rmSync(path.join(s.dir, 'index.jsonl'))
  fs.mkdirSync(path.join(s.dir, 'index.jsonl'))
  const r = run(s, ['--clerk', '--enrich', '--scope', 'local'])
  assert.equal(r.code, 1, `clerk enrich must abort on a corrupt index, got exit ${r.code}: ${r.stdout}`)
  assert.equal(r.json && r.json.code, 'protection-abort:protection', `got ${r.json && r.json.code}`)
  assert.equal(r.json.mode, 'clerk-enrich', `got ${r.json.mode}`)
  assert.match(r.json.message, /index\.jsonl/, `must name index.jsonl, got ${r.json.message}`)
  assert.match(r.json.message, /episode index unreadable/, `must carry the init-guard reason prefix, got ${r.json.message}`)
})
```

## A.8 Definition of done (mechanical)

```bash
node tests/test-rfc-015-p1-s2-consolidation.mjs   # → 34/34 pass, exit 0
node tests/test-em-consolidate.mjs                # → 8/8 pass
node tests/test-fold-superseded.mjs               # → 11/11 pass
grep -c 'loadIndexOrAbort(DATA_DIR' scripts/em-consolidate.mjs    # → 5
grep -c 'loadIndex(DATA_DIR, scope)' scripts/em-consolidate.mjs   # → 1
```

Deploy-audit runs at post-merge deploy (orchestrator), not in this slice.
