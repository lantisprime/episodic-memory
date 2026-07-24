# 573-CIWIRE — Wire the eleven second-opinion suites into CI + fix the #573 stale assertion

## §1 Status

`Planning only.` Do not implement until this plan and its review are accepted (Rule 18).
Current stage: **draft**.

| Field | Value |
|---|---|
| RFC | n/a (CI wiring + test-rot fix; no substrate behavior change) |
| Parent requirements | Issue #573 (stale assertion), backlog decision episode `20260724-002809-issue-backlog-diverges-222-open-20-month-b187`, workplan v244 recommended item |
| Workplan episode | `20260724-052302-workplan-v244-pr-574-merged-and-deployed-8169` |
| Target branch | `fix/573-ci-wire-second-opinion-suites` (worktree `/Users/charltondho/Developer/projects/episodic-memory-ciwire`, based on `9c41012`) |
| Executor altitude (§0.1) | **low** (pi/MiniMax-M3 builder seat) — Appendix A is the build path |

## §2 Episode Search Summary

`node scripts/em-search.mjs --query "ci wiring KNOWN_UNWIRED suite registration" --scope all --limit 5 --no-track` returned (observed 2026-07-24):

- `20260724-002809-issue-backlog-diverges-222-open-20-month-b187` — backlog diverges 222 open / +20 per month; generator = unwired CI suites + append-only filing. This PR is the first remediation step that decision recommends.
- `20260710-234718-negative-scenario-review-504-lint-final--5613` — the #504 lint (test-ci-suite-registration) FINAL ACCEPT: all mutation forgeries exit 1 at runtime. Constrains this plan: the lint's wire-form regex is trustworthy and strict; wiring steps must match it byte-exactly.
- Workplan v244 (`…-8169`) — this work item, RECOMMENDED and operator-approved in-session 2026-07-24 ("go #1").

## §3 Objective

All eleven `tests/test-second-opinion-*.mjs` suites currently sitting in the shrink-only
`KNOWN_UNWIRED` baseline run on every CI push/PR, and the one known stale assertion (#573)
is fixed so they are all green. Provable by: `node tests/test-ci-suite-registration.mjs`
prints PASS with baseline shrunk 82 → 71, and each of the eleven suites exits 0.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent | Test(s) | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | `tests/test-second-opinion-storage.mjs:286` asserts the three-fragment codex default `['review-ladder-v9.4', 'env-prefix-discipline-v1', 'adversarial-depth-v1']`, matching `scripts/second-opinion/preambles/index.json:4` | #573 | `node tests/test-second-opinion-storage.mjs` → `11 passed, 0 failed` | MUST | The stale comment at lines 283-285 is updated in the same edit |
| REQ-2 | Eleven new steps in `.github/workflows/tests.yml` (`recall-activation` shard), each byte-matching the lint regex `^run:\s*(?:node|bash|sh)\s+tests\/(\S+)$` (`tests/test-ci-suite-registration.mjs:180`) | backlog decision `…b187` | `node tests/test-ci-suite-registration.mjs` → `test-ci-suite-registration: PASS` | MUST | No args, no trailing comments, no block scalars |
| REQ-3 | The eleven `test-second-opinion-*` entries are deleted from `KNOWN_UNWIRED` (`tests/test-ci-suite-registration.mjs:135-145`); baseline stays sorted and duplicate-free | shrink-only ratchet contract (`:67-71`) | `t_baseline_not_wired` + `t_baseline_sorted_unique` inside the same lint run | MUST | Wiring + deletion land in the same PR because `t_baseline_not_wired` fails on any wired-but-baselined entry |
| REQ-4 | Each of the eleven suites exits 0 when run exactly as CI will run it (`node tests/<file>.mjs`, repo root cwd, no extra env) | #573 same-class field 4 | eleven individual runs, pass counts recorded in §15 | MUST | Baseline observed 2026-07-24: 10 of 11 already green; only storage red via REQ-1 |
| REQ-5 | No other file, workflow job, or baseline entry changes; `test-so-gate-timeout-floor-integration.mjs` / `test-so-gate-timeout-floor.mjs` stay baselined | surgical-changes rule | `git diff --stat` shows exactly 3 product files (this plan doc is additionally committed per repo convention, as #538 committed `docs/plans/issue-538-reply-sanity-gate.md`) | MUST | The two test-so-gate-timeout-floor suites are #541-adjacent scope, not this PR |

## §5 Non-Goals

- Issue #541 (stray top-level files under `scripts/`) — separate class, separate PR.
- Wiring `test-so-gate-timeout-floor-integration.mjs` / `test-so-gate-timeout-floor.mjs` (not part of the approved eleven; they exercise the timeout floor differently and were not analyzed for hermeticity).
- Triage of the remaining 71 `KNOWN_UNWIRED` entries (bp1/rfc002/phase suites) — the follow-up triage sweep the backlog decision names.
- Any change to harness/provider/preamble behavior. Zero `scripts/` edits.
- Fixing the misleading I-21 test name in `test-second-opinion-consensus-e2e.mjs` (scout-B finding; filed separately per §17).

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads | Writes | Notes |
|---|---|---|---|---|
| `.github/workflows/tests.yml` | 472 | ~2.4k tok | +33 lines | eleven 3-line step blocks |
| `tests/test-ci-suite-registration.mjs` | 559 | ~2.8k tok | -11 lines | baseline deletion only |
| `tests/test-second-opinion-storage.mjs` | 412 | ~2.1k tok | 4 lines edited | assertion + comment |

Baseline single-session: ~10k tokens of file I/O; trivially fits one session.

## §7 Safety / Security

No new trust boundary, no data flow, no path-resolution logic — the diff is CI YAML plus
test expectations. The negative-control net is the #504 lint itself, already
mutation-tested (episode `…5613`): a malformed wire (args, comment, wrong indent, block
scalar) is NOT counted as wired, which then fails `t_all_suites_registered` because the
baseline entry was deleted. The build sequence in §A.7 deliberately passes through the
lint's RED state (wired-but-baselined → `t_baseline_not_wired` fails) as the red-then-green
proof that the ratchet observes the change. No `negative-scenario-planner` dispatch: no
schema/validator/security/multi-actor surface (and built-in subagents remain prohibited
this session).

CI-runner hermeticity of the eleven suites (scout-verified with file:line evidence,
orchestrator-rerun locally 2026-07-24, all anchors re-read by the orchestrator; GLM round-1
fresh-runner sim E7/E8 confirmed CI-green and sharpened the wording below):

- Fixture state (projects, worktrees, snapshots) lives under `os.tmpdir()` with `process.on('exit')` cleanup. NOT fully HOME-clean: four suites (consensus-e2e, dispatch, install-snapshot, storage) write an idempotent `~/.episodic-memory/trigger-index.json` into the runner HOME uncleaned, and dispatch + providers leave provider-probe dirs (`.codex`, `.config/opencode`, `.local/share/opencode`, `.cache/opencode`) there. All eleven pass under both an empty and a populated HOME (GLM E7), so these leftovers are non-failing and ephemeral on a throwaway ubuntu-latest runner.
- `SO_INSTALL_SNAPSHOT_PATH` dev-mode override defaulted to a nonexistent path by every harness-spawning suite (consensus-e2e :79-80, dispatch :65-67, storage :67-68 and :204-205) — correct on a runner with no `~/.claude/hooks/`.
- Only system dependency: `git` (init / commit --allow-empty / worktree add) — present on ubuntu-latest; suites pass explicit GIT_AUTHOR_*/GIT_COMMITTER_* identity.
- No network, no codex/pi/gemini binaries required (`available()` probes accept absence); the gate suites' `enforce-contract.mjs` consult fail-closes on ENOENT by design.

## §8 Design

Two independent concerns, ordered so CI can never observe a red suite:

1. **S1 — fix the rot first.** Update the storage-suite assertion to the live three-fragment registry. After S1 all eleven suites are green locally.
2. **S2 — wire + shrink in one commit.** Append eleven steps to the `recall-activation` shard immediately after the #538 reply-sanity block (subject-matter grouping, same anchor pattern the #538 slice used), and delete the eleven baseline entries. The lint forces these two edits to be co-committed.

### 8.2 Key invariants

- Wire-form byte-exactness: `run: node tests/<file>.mjs` — regex at `tests/test-ci-suite-registration.mjs:180`.
- Baseline stays sorted/unique after deletion (contiguous block removal preserves both).
- Shard-time budget: the eleven suites total < 30 s locally (heaviest: storage 2.97 s, gate-runbook 2.07 s, consensus-e2e 1.49 s wall, observed 2026-07-24); `recall-activation` headroom per `tests.yml:17-21` absorbs this.
- **Cross-platform:** CI target is ubuntu-latest only; suites themselves already handle macOS `/var` realpath. No new platform surface.

### 8.3 Flow

```text
S1 assertion fix → storage 11/11 green
S2a eleven steps appended → lint RED (t_baseline_not_wired: wired entries still baselined)
S2b eleven baseline entries deleted → lint PASS, baseline 82 → 71
```

## §9 Existing Hook Points (anchors verified by orchestrator 2026-07-24 at `9c41012`)

| File | Line(s) | What it is today | Impact |
|---|---|---|---|
| `.github/workflows/tests.yml` | 194-195 | `- name: Run reply-sanity harness E2E …` + `run: node tests/test-so-reply-sanity-e2e.mjs` (last step of the second-opinion group in `recall-activation`) | Anchor: eleven step blocks appended after it |
| `tests/test-ci-suite-registration.mjs` | 135-145 | the eleven `test-second-opinion-*` baseline entries (contiguous, sorted) | Deleted |
| `tests/test-ci-suite-registration.mjs` | 180 | `STEP_INVOCATION` wire-form regex | Read-only contract |
| `tests/test-ci-suite-registration.mjs` | 374-381 | `t_baseline_not_wired` ratchet | Forces co-commit |
| `tests/test-second-opinion-storage.mjs` | 283-286 | stale comment + two-fragment assertion | Replaced |
| `scripts/second-opinion/preambles/index.json` | 4 | live codex default (three fragments) | Read-only source of truth |

## §10 Slice Ladder

| Slice | Objective | Primary files | Tests | Hard stops |
|---|---|---|---|---|
| 573-S1 | Fix stale assertion (#573) | `tests/test-second-opinion-storage.mjs` | storage suite 11/11 | Touch nothing but lines 283-286 |
| 573-S2 | Wire eleven + shrink baseline | `.github/workflows/tests.yml`, `tests/test-ci-suite-registration.mjs` | lint PASS, baseline 71 | No other workflow/job edits; do not touch the two test-so-gate-timeout-floor entries |

One PR, two source commits (`573-S1: …`, `573-S2: …`) plus a third docs commit freezing this spec (REQ-5 note, #538 precedent).

## §12 Contracts

No new/changed functions. The only behavioral contract is the lint's, unchanged.

## §13 Edge Cases

| # | Scenario | Expected behavior | Verify |
|---|---|---|---|
| EC1 | Wire line carries an argument or trailing comment | lint does not count it as wired → `t_all_suites_registered` fails (entry already deleted) | §A.7 step 2.3 lint run |
| EC2 | Baseline deletion breaks sort order | impossible for contiguous-block removal; `t_baseline_sorted_unique` guards regardless | same lint run |
| EC3 | A wired suite is red on ubuntu-latest despite local green | CI `recall-activation` shard fails loud on the PR; nothing merges red | `gh pr checks` before merge |
| EC4 | Step lands outside `jobs.<job>.steps` path (indent error) | lint's path-stack check (`:239-244`) rejects it → `t_all_suites_registered` fails | §A.7 step 2.3 lint run |

## §14 Test Case Catalog

No new test files. The verification set:

```text
Group 1: rot fix (1)
  storage suite full run — 11 passed, 0 failed
Group 2: registration (1)
  test-ci-suite-registration — PASS, header line reports baseline: 71
Group 3: CI-shape runs (11)
  node tests/test-second-opinion-<each>.mjs — exit 0, pass counts per §15
```

## §15 Verification Ledger (fill observed output at implementation time)

| Claim | Command | Observed artifact |
|---|---|---|
| #573 fixed | `node tests/test-second-opinion-storage.mjs` | `11 passed, 0 failed`, exit 0 (orchestrator rerun post-build, 2026-07-24) |
| Ratchet observed the wiring (RED state) | `node tests/test-ci-suite-registration.mjs` after 2.1, before 2.2 | exit 1, `t_baseline_not_wired: now wired — remove from KNOWN_UNWIRED: test-second-opinion-audit-drift.mjs, … test-second-opinion-storage.mjs` (builder step 2.2; message format is the assertion text at `tests/test-ci-suite-registration.mjs:374-381`, reproducible by wiring any baselined suite) |
| Registration green | `node tests/test-ci-suite-registration.mjs` after 2.3 | `# suites: 260, baseline: 71, step-wired: 165` … `16 passed, 0 failed` … `test-ci-suite-registration: PASS` (orchestrator rerun) |
| Each suite green | eleven `node tests/<file>.mjs` runs | audit-drift 4, consensus-e2e 7, consensus 18, dispatch 9, gate-runbook 20/20, gate 23, i22 6, install-snapshot 14, preamble 45, providers 24 (orchestrator baseline runs at `9c41012`; GLM round 2 re-ran all ten at HEAD, all exit 0, identical counts), storage 11 (orchestrator post-build rerun) |
| P12 untouched | `node tests/test-p12-invariant-suite.mjs` | `P12 INVARIANT GATE: PASS` (orchestrator rerun) |
| Diff surgical | `git diff --stat main` | `3 files changed, 37 insertions(+), 15 deletions(-)` (tests.yml +33, lint -11, storage 4 lines) |
| CI green | `gh pr checks <PR>` | `<fill at PR time: all six checks>` |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| A suite is slower/flaky on ubuntu-latest than locally (subprocess-heavy gate suites) | Med | Low | Suites are hermetic + deterministic (stub provider); CI failure is loud and pre-merge; revert = re-baseline via reviewed add |
| recall-activation shard time creeps past balance | Low | Low | +<30 s on an ~80-95 s shard; if review flags it, split across shards in the fold round |
| Preamble-registry drift re-rots the pinned arrays (storage + preamble suites) | Low | Med (over months) | That is the point of wiring: drift now fails CI on the next PR instead of rotting silently |

## §17 Open Decisions / Deferred findings

- **Misleading I-21 test name in `test-second-opinion-consensus-e2e.mjs:239-262`** (scout-B): the E2E entry named `I-21: ACCEPT-with-FU + P1 finding → accept-with-fu-malformed` actually accepts `cap-reached-no-success` too, with an honest inline comment deferring real I-21 coverage to the unit suite. DEFER → file as a GitHub issue at step 9 (wrap-up), 5 fields: (1) scenario runs green today — the looseness is observable only by reading L239-262; (2) no spec requires E2E-layer I-21 coverage (unit suite `test-second-opinion-consensus.mjs:156-227` covers all three poles); (3) history: first surfaced by this arc's scout; (4) class = "test name promises more than assertion checks" — no sibling instance found in the other ten suites; (5) residual: a future stub change could silently un-cover the E2E path while the name still claims it; recovery is a rename or a real driver. Issue to be filed before wrap-up.
- **Remaining 71 baseline entries** — triage sweep deferred to the next backlog work item (workplan `…b187` recommendation part 2).

## §18 Done Criteria

- [ ] All §4 MUST rows green with §15 artifacts pasted.
- [ ] PR open, CI six checks green (`gh pr checks`).
- [ ] Rule 17 bot COMMENTED review posted; operator merges in UI.
- [ ] §17 deferred finding filed as a GitHub issue (step 9) before wrap-up.

## §19 Review Consensus (Rule 18)

Reviewer = pi/GLM-5.2 on neuralwatt (standing: no codex as second-opinion provider,
operator 2026-07-23). Round 1 = this plan doc (frozen); round 2 = frozen diff post-build.
Verdicts recorded here with three-state ACCEPT/HOLD-n/REJECT.

| Pass | Reviewer | Scope | Blockers | Verdict | Record |
|---|---|---|---|---|---|
| 1 | GLM-5.2 (neuralwatt) | plan doc | 1 P2 + 2 P3 | HOLD-1 | `scratchpad/glm-plan-review-r1.md` (runtime-probed: real parseWorkflow sim counted the eleven; fresh-HOME sim all-green) |
| 1b | GLM-5.2 (neuralwatt) | fold confirmation | 0 (1 P3 doc-hygiene residual, swept) | ACCEPT | `scratchpad/glm-plan-review-r1.md` ROUND-1B |
| 2 | GLM-5.2 (neuralwatt) | frozen diff (`70de5f2` + `c030829` + `5642609`) | 0 P1 / 0 P2 / 3 P3 (cosmetic, folded) | ACCEPT | `scratchpad/glm-diff-review-r2.md` (byte-exact per-commit audit R4-R6; lint/storage/p12 reruns R8-R11; YAML damage hunt R15-R21; fresh-runner sim R22) |

### 19.1 Resolved blockers (round 1)

| # | Blocker | Disposition | Resolution + evidence |
|---|---|---|---|
| F1 (P2) | Baseline count stale: plan said 77 → 66; live lint header says `baseline: 82` → post-deletion 71 | ACCEPT | Orchestrator reran the lint (observed `# suites: 260, baseline: 82, step-wired: 154`, PASS) and corrected all five spots to 82/71 |
| F2 (P3) | §7 hermeticity wording overstated (four suites write `~/.episodic-memory/trigger-index.json` + provider-probe dirs into HOME, uncleaned) | ACCEPT | §7 reworded to name the HOME leftovers and why they are non-failing (GLM E7/E8) |
| F3 (P3) | §7 snapshot-override line citations imprecise | ACCEPT | Corrected to consensus-e2e :79-80, dispatch :65-67, storage :67-68 and :204-205 |

## §20 Governing-artifact consult (three legs, discharged)

- **PRINCIPLES.md:** P5 (honest capability labels — the baseline's blanket "structurally CI-unsuitable" comment overstated; these eleven are hermetic, and wiring makes the label honest), P6 (tokens/budget — CI time +<30 s, no background spend), P12 untouched (no enforcement registration anywhere; CI YAML is repo-scoped). No principle violated; none needs revision.
- **CAPABILITIES.md:** no capability added/changed; this is the Distribution-adjacent test layer. Boundary respected: zero substrate edits.
- **em-\* disposition sweep (38 scripts at `9c41012`):** ALL 38 `scripts/em-*.mjs` = **UNCHANGED**. INTERACTS (read-only, pre-existing): `em-search.mjs` + `em-store.mjs` are spawned inside `test-second-opinion-storage.mjs`'s episodic round-trip fixture; their invocation surface is not edited. No em-script is CHANGED.

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check | `node --version` → `v2x` (20 or higher) |
| Test-runner shape | `node tests/test-<feature>.mjs` |
| New-function phrasing | n/a (no new functions) |
| Break-input override | n/a — the negative control is the lint's own RED state between steps 2.1 and 2.2 |
| Search tool for verifies | `grep -c` / `grep -n` from the worktree root |
| Repo-specific done-commands | none beyond §A.8 (no hooks/scripts/patterns touched → no deploy-audit) |

## A.2 Executor contract (builder seat: copy verbatim)

1. Work ONLY inside `/Users/charltondho/Developer/projects/episodic-memory-ciwire`.
2. Steps in numeric order; one file per step; anchored smallest-diff EDITs only.
3. NO design decisions. Anchor missing verbatim → STOP and report (§A.3 format).
4. Run each step's verify before the next step.
5. HARD RULES: no `git commit`, no `git stash`, no `git push`, no edits outside the three named files, no episode/memory writes, no new files.
6. One command per verify — no `;`/`&&`/pipes/subshells.

## A.4 Pre-flight (step 0)

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `fix/573-ci-wire-second-opinion-suites` |
| Clean tree | `git status --porcelain` | empty (this plan doc excepted if present) |
| Known baseline state | `node tests/test-second-opinion-storage.mjs` | exits 1, `10 passed, 1 failed` (the #573 red — expected pre-fix) |
| Lint green at baseline | `node tests/test-ci-suite-registration.mjs` | `test-ci-suite-registration: PASS`, header `baseline: 82` |
| Runtime | `node --version` | v20+ |

## A.7 Step tables

### 573-S1 — fix the #573 stale assertion (REQ-1)

**Files this slice may touch:** `tests/test-second-opinion-storage.mjs`. **Read-only:** `scripts/second-opinion/preambles/index.json`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 1.1 | `tests/test-second-opinion-storage.mjs` | **EDIT** | ANCHOR (4 lines, verbatim):<br>`  // codex default = review ladder + env-prefix discipline (per committed`<br>`  // preambles/index.json). This assertion was stale (review-ladder only) and`<br>`  // failing pre-existing; corrected to match the source-of-truth registry.`<br>`  assert.deepStrictEqual(result.fragment_ids, ['review-ladder-v9.4', 'env-prefix-discipline-v1'])`<br>REPLACE with:<br>`  // codex default = review ladder + env-prefix discipline + adversarial depth`<br>`  // (per committed preambles/index.json). Kept in sync with the source-of-truth`<br>`  // registry; previous two-fragment drift was issue #573.`<br>`  assert.deepStrictEqual(result.fragment_ids, ['review-ladder-v9.4', 'env-prefix-discipline-v1', 'adversarial-depth-v1'])` | `node tests/test-second-opinion-storage.mjs` → stdout ends `11 passed, 0 failed`, exit 0 |

### 573-S2 — wire eleven + shrink baseline (REQ-2, REQ-3, REQ-4)

**Files this slice may touch:** `.github/workflows/tests.yml`, `tests/test-ci-suite-registration.mjs` (one per step).

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 2.1 | `.github/workflows/tests.yml` | **EDIT** | ANCHOR (2 lines, verbatim):<br>`      - name: Run reply-sanity harness E2E (#538 — bootstrap-shaped reply rejected, nothing persisted)`<br>`        run: node tests/test-so-reply-sanity-e2e.mjs`<br>REPLACE with the same 2 lines followed by a blank line and this verbatim block (11 steps, 2-space step indent identical to the anchor):<br>`      - name: Run second-opinion audit-drift suite (#573 wiring sweep — I-23 audit table)`<br>`        run: node tests/test-second-opinion-audit-drift.mjs`<br>(blank line)<br>`      - name: Run second-opinion consensus E2E suite (#573 wiring sweep — stub-driven consensus loop)`<br>`        run: node tests/test-second-opinion-consensus-e2e.mjs`<br>(blank line)<br>`      - name: Run second-opinion consensus unit suite (#573 wiring sweep — parseVerdict + stop conditions)`<br>`        run: node tests/test-second-opinion-consensus.mjs`<br>(blank line)<br>`      - name: Run second-opinion dispatch suite (#573 wiring sweep — stub dispatch + #221 fail-closed axes)`<br>`        run: node tests/test-second-opinion-dispatch.mjs`<br>(blank line)<br>`      - name: Run second-opinion gate-runbook suite (#573 wiring sweep — runbook injection branch)`<br>`        run: node tests/test-second-opinion-gate-runbook.mjs`<br>(blank line)<br>`      - name: Run second-opinion gate suite (#573 wiring sweep — snapshot fail-closed + Bash/Agent branches)`<br>`        run: node tests/test-second-opinion-gate.mjs`<br>(blank line)<br>`      - name: Run second-opinion I-22 algorithm-parity suite (#573 wiring sweep — canonical-root parity)`<br>`        run: node tests/test-second-opinion-i22-algorithm-parity.mjs`<br>(blank line)<br>`      - name: Run second-opinion install-snapshot suite (#573 wiring sweep — I-27a/I-27b freshness + tamper)`<br>`        run: node tests/test-second-opinion-install-snapshot.mjs`<br>(blank line)<br>`      - name: Run second-opinion preamble suite (#573 wiring sweep — composer + registry validator)`<br>`        run: node tests/test-second-opinion-preamble.mjs`<br>(blank line)<br>`      - name: Run second-opinion providers suite (#573 wiring sweep — provider module contract)`<br>`        run: node tests/test-second-opinion-providers.mjs`<br>(blank line)<br>`      - name: Run second-opinion storage suite (#573 wiring sweep — storage + preamble_source, fixes #573)`<br>`        run: node tests/test-second-opinion-storage.mjs` | `grep -c 'run: node tests/test-second-opinion-' .github/workflows/tests.yml` → `12` (eleven new + the pre-existing reply-sanity step) |
| 2.2 | — | — | **Negative control (red-then-green):** run the lint while the eleven are wired AND still baselined. | `node tests/test-ci-suite-registration.mjs` → exit 1, failure text contains `now wired — remove from KNOWN_UNWIRED: test-second-opinion-audit-drift.mjs` |
| 2.3 | `tests/test-ci-suite-registration.mjs` | **EDIT** | ANCHOR (11 lines, verbatim — the contiguous block):<br>`  'test-second-opinion-audit-drift.mjs',`<br>`  'test-second-opinion-consensus-e2e.mjs',`<br>`  'test-second-opinion-consensus.mjs',`<br>`  'test-second-opinion-dispatch.mjs',`<br>`  'test-second-opinion-gate-runbook.mjs',`<br>`  'test-second-opinion-gate.mjs',`<br>`  'test-second-opinion-i22-algorithm-parity.mjs',`<br>`  'test-second-opinion-install-snapshot.mjs',`<br>`  'test-second-opinion-preamble.mjs',`<br>`  'test-second-opinion-providers.mjs',`<br>`  'test-second-opinion-storage.mjs',`<br>REPLACE with: nothing (delete the 11 lines; the neighbors `  'test-script-identity-key.mjs',` above and `  'test-seed-patterns.mjs',` below stay untouched) | `node tests/test-ci-suite-registration.mjs` → exit 0, stdout contains `baseline: 71` and `test-ci-suite-registration: PASS` |
| 2.4 | — | — | Full CI-shape sweep: run each of the eleven suites once from the worktree root. | eleven commands `node tests/test-second-opinion-<name>.mjs`, each exit 0; pass counts: audit-drift 4, consensus-e2e 7, consensus 18, dispatch 9, gate-runbook 20, gate 23, i22 6, install-snapshot 14, preamble 45, providers 24, storage 11 |

## A.8 Definition of done (mechanical)

```bash
node tests/test-second-opinion-storage.mjs      # → 11 passed, 0 failed
node tests/test-ci-suite-registration.mjs       # → PASS, baseline: 71
node tests/test-p12-invariant-suite.mjs         # → P12 INVARIANT GATE: PASS (untouched, belt-and-braces)
git diff --stat main                            # → exactly 3 files changed
```

No deploy-audit row: no hooks/scripts/patterns touched, nothing deploys.
