# ISSUE-539 Prune orphaned files from deployed script subtrees

## §1 Status

`Planning only.` Do not implement until this plan, the plan review, and the adversarial
review are accepted (Rule 18). Current stage: **reviewed (ACCEPT-WITH-MOD, 0 blockers); awaiting operator approval to build**.

| Field | Value |
|---|---|
| RFC | `n/a` (installer/deploy adjacent layer — CAPABILITIES.md "Distribution", not a substrate capability) |
| Parent requirements | `n/a` |
| Workplan episode | `20260724-123857-workplan-v251-pr-579-merged-abfe8c8-and--4d23` (queue head #539) |
| Target branch | `feat/issue-539-prune-subtree-orphans` |
| Executor altitude (§0.1) | `low` (pi/MiniMax-M3 builder → Appendix A mandatory) |

## §2 Episode Search Summary

```bash
node scripts/em-search.mjs --tag issue-539 --scope all --limit 10 --full --no-track
```

Governing memories (verified live this session):

- Issue #539 body (`gh issue view 539`): the deferred candidate fix is a `--prune-subtree-orphans`
  opt-in in install.mjs OR an explicit prune recommendation in deploy-audit, riding the existing
  `GLOBAL_SCRIPT_SUBTREES` manifest data.
- `docs/plans/issue-531-scripts-subtree-deploy.md` §17: the DEFER that spawned #539. Locks the shape:
  prune is opt-in / separately invoked; deploy-audit stays REPORT-ONLY by design
  (`tools/deploy-audit.mjs:24-27`); reuse the manifest; same-class treatment (all members); residual
  risk accepted low (an orphan data file is never executed).
- PRINCIPLES.md P3 (explicit consent for side-effecting activation) + P10 (consent + reversibility for
  destructive ops; declared side effects). CAPABILITIES.md "Adjacent layers → Distribution": no new
  plugin type; governed directly by P3/P10/P12.
- lesson `…540d`: filtered checks are structurally blind; investigate live consumers before pruning.

All file/function/flag references below were re-verified against current `HEAD` (`abfe8c8`) this
session — line numbers are current, not recalled.

## §3 Objective

A consumer can converge their global `~/.episodic-memory/scripts/<subtree>/` copy to the repo's
current file set by running install with an explicit opt-in flag. After
`node install.mjs --tool claude-code --prune-subtree-orphans`, every regular file present under a
deployed `GLOBAL_SCRIPT_SUBTREES` member but absent from the repo's copy of that subtree is removed,
and every path removed is printed. Provable by an isolated-HOME mock E2E: plant an orphan, re-run
install with the flag, assert the orphan is gone and the real repo files survive; and by the negative
control (flag absent → orphan retained). Default install behavior is unchanged.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | `subtreeOrphanFindings(repoDir, installedScriptsDir)` returns the sorted `scripts/<subtree>/<rel>` paths present under `installedScriptsDir/<subtree>` (for each `GLOBAL_SCRIPT_SUBTREES` member) but absent from `repoDir/scripts/<subtree>`. Empty array when convergent. Never throws on missing dirs. | n/a | `testSubtreeOrphanGreen`, `testSubtreeOrphanDetected` | MUST | Reuses the existing private `walkRegularFiles` (symlink-skipping) on both sides. |
| REQ-2 | `subtreeOrphanFindings` never reports a symlink on the installed side (a symlinked installed file is not an orphan candidate). | n/a | `testSubtreeOrphanSkipsSymlink` | MUST | `walkRegularFiles` skips non-regular dirents (install-manifest.mjs:549). |
| REQ-3 | `install.mjs --prune-subtree-orphans` deletes every path `subtreeOrphanFindings` reports under `SCRIPTS_DIR`, printing `Pruned orphan scripts/<subtree>/<rel>` per removal; repo-present files survive. | n/a | `testPruneFlagRemovesOrphan` | MUST | Runs after the substrate copy; gated on the flag. |
| REQ-4 | Without `--prune-subtree-orphans`, install deletes nothing from deployed subtrees (default behavior unchanged). | n/a | `testPruneFlagAbsentKeepsOrphan` | MUST | Negative control — both polarities of the controlling flag on the same input. |
| REQ-5 | Every prune deletion is guarded by `assertContained(abs, SCRIPTS_DIR)`; a symlinked subtree dir whose target escapes `SCRIPTS_DIR` aborts install non-zero and deletes nothing outside the tree. | n/a | `testPruneContainmentGuard` | MUST | Reuses `install.mjs:1489 assertContained` (realpaths both sides). §7. |
| REQ-6 | `--prune-subtree-orphans` appears in the `install.mjs` usage/help text with a one-line description. | n/a | `manual: node install.mjs` (no `--tool`) shows the flag; `grep -n '\-\-prune-subtree-orphans' install.mjs` ≥ 3 | SHOULD | Usage line + description block. |
| REQ-7 | `tools/deploy-audit.mjs` reports subtree orphans as a distinct `PRUNABLE` recommendation (safe-to-prune with the flag), reusing `subtreeOrphanFindings`; stays report-only (deletes nothing). | n/a | `manual: node tools/deploy-audit.mjs --json` with a planted orphan → `prunable` array non-empty | SHOULD | First to cut (§11). deploy-audit already surfaces the same file as `EXTRA`. |

## §5 Non-Goals

- **No automatic/default pruning.** The flag is the only trigger (P3/P10). A plain install never deletes.
- **No removal of now-empty subtree directories.** Empty dirs left in place are harmless and inert; not in scope.
- **No quarantine/rename-to-`.stale`.** Considered and rejected (§16) — heavier surface than the issue's
  accepted residual-risk warrants for inert data files. Prune is a hard delete behind the opt-in.
- **No change to flat `scripts/*.mjs` or `scripts/lib/*.mjs` drift semantics.** #539 scope is
  `scripts/<subtree>/` data files only.
- **No whole-subtree orphan removal** (review F1). The detector iterates the *current*
  `GLOBAL_SCRIPT_SUBTREES`, so files inside a still-listed subtree are pruned, but an entire
  `~/.episodic-memory/scripts/<removed>/` tree left behind after a member is de-classified or
  removed from that constant is out of scope — surface it via `deploy-audit` EXTRA (which walks
  actual dirs) and trace consumers before a manual removal.
- **No fix to the `globalArtifactPairs` under-reporting gap** (install-version.mjs walks only
  `second-opinion`, not `em-consolidate`/`topic-tracks`). Discovered during scouting; filed separately
  (§17). The detector builds its expected-set from a fresh repo walk, so it does not depend on that manifest.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `install.mjs` | 3614 | targeted regions only (~200 lines read) | ~15 lines added | flag + prune block + import + help |
| `scripts/lib/install-manifest.mjs` | 605 | ~90 | ~20 lines added | detector append |
| `tools/deploy-audit.mjs` | 144 | 144 | ~6 lines | S3 only (cuttable) |
| `tests/test-install-scripts-subtrees.mjs` | 243 | 243 | ~90 lines added | 5 new tests |

**Baseline (single session):** ~55k tokens. **Optimized:** ~40k, one slice per dependency layer (§10).

## §7 Safety / Security

This feature deletes files under a user's home directory. The trust boundary is
`SCRIPTS_DIR = ~/.episodic-memory/scripts`; nothing outside it may ever be removed.

| Concern | Severity | Attack/abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| Path escape via symlinked subtree dir | High | An installed `scripts/<subtree>/` is a symlink to `~/` or `/`; a naive walk+delete would remove files outside the tree. | Every delete calls `assertContained(abs, SCRIPTS_DIR)` which realpaths **both** sides and throws `CONTAINMENT_VIOLATION` on any `..`/absolute/`''` relative — the install aborts, deletes nothing outside. | `testPruneContainmentGuard` (negative: escaping symlink → non-zero exit, outside target survives) |
| Symlinked file mis-detected as orphan | Med | A symlink inside the installed subtree gets flagged and its target deleted. | Detection uses `walkRegularFiles` which skips non-regular dirents on both sides, so symlinks are never orphan candidates. | `testSubtreeOrphanSkipsSymlink` |
| Deleting a repo-present file (false orphan) | Med | Detector over-reports and removes a file the repo still ships. | Detector diffs installed vs a fresh recursive repo walk of the same subtree; repo-present files are never in the finding set. | `testSubtreeOrphanGreen` (convergent → `[]`), `testPruneFlagRemovesOrphan` (repo files survive) |

**8-axis symlink matrix** (delete-side path authority — the only path predicate this feature adds):

| Axis | Case | Behavior |
|---|---|---|
| 1. Regular file orphan | installed file absent from repo | reported → deleted (in-tree) |
| 2. Symlinked file in subtree | `link.md → a.md` | skipped by `walkRegularFiles`; never reported/deleted |
| 3. Symlinked subtree dir → in-tree | `<subtree>` symlink resolves inside `SCRIPTS_DIR` | `assertContained` passes; deletes resolve in-tree |
| 4. Symlinked subtree dir → escape | `<subtree>` symlink → `~/` or `/tmp` | `assertContained` realpath → `..`/absolute → throws, abort |
| 5. Sibling-prefix escape | `scripts-backup/` sharing a string prefix | `path.relative` (not `startsWith`) rejects; throws |
| 6. Target already gone (ENOENT) | orphan removed between detect and delete | `fs.rmSync(..., {force:true})` is idempotent; no throw |
| 7. `/var`→`/private/var` (macOS) | realpath canonicalization differs from lexical | `assertContained` realpaths both sides; consistent |
| 8. Non-existent subtree dir | `<subtree>` not deployed | `walkRegularFiles` `existsSync` guard → `[]`; no-op |

**Canonical-planner note:** this change adds one path-authority predicate reusing an already-hardened
guard (`assertContained`, tested across the enforcement uninstall suite). The `negative-scenario-planner`
dispatch is folded into the plan-review step (§19) rather than a separate pre-pass, since the attack
surface is a single well-understood delete-containment axis, not a new schema/validator/multi-actor class.

## §8 Design

### 8.1 Key types

```js
/**
 * subtreeOrphanFindings(repoDir, installedScriptsDir) → string[]
 * @param {string} repoDir — repo root (contains scripts/<subtree>/…)
 * @param {string} installedScriptsDir — the deployed scripts/ dir (…/.episodic-memory/scripts)
 * @returns {string[]} sorted 'scripts/<subtree>/<rel>' paths present installed-side but absent repo-side.
 *   Empty = convergent. Never throws on missing dirs (walkRegularFiles guards existsSync).
 */
```

### 8.2 Key invariants

- **Containment:** no path outside `realpath(SCRIPTS_DIR)` is ever passed to `fs.rmSync` — `assertContained` gates every delete.
- **Symmetry with detection:** both the repo side and the installed side are walked by the same
  `walkRegularFiles` (symlink-skipping), so the finding set never contains a non-regular entry.
- **Opt-in only:** the prune block is unreachable unless `argv.includes('--prune-subtree-orphans')`.
- **Same-class:** the loop iterates `GLOBAL_SCRIPT_SUBTREES`, so every current and future global member
  is treated identically (satisfies #531 §17 field 4).
- **Cross-platform:** `path.join`/`path.relative` throughout; no shell, no GNU flags, no `readlink -f`.
  `walkRegularFiles` and `assertContained` are already cross-OS.
- **Ordering:** prune runs **after** the substrate copy completes (copy-then-prune, never
  prune-then-copy). The detector's authoritative set is a fresh `REPO_DIR` walk, not the just-copied
  files, so ordering does not affect detector correctness (review F3); copy-first avoids racing a file
  the copy is refreshing.

### 8.3 Resolution / flow

```text
install (substrate copy done)
  └─ if --prune-subtree-orphans:
       findings = subtreeOrphanFindings(REPO_DIR, SCRIPTS_DIR)
       for rel in findings:
         abs = SCRIPTS_DIR / rel.slice('scripts/'.length)
         assertContained(abs, SCRIPTS_DIR)   # throws → abort, nothing outside removed
         fs.rmSync(abs, {force:true})         # idempotent
         log "Pruned orphan <rel>"
       log "Pruned N orphan(s)" (or "no subtree orphans")
```

## §9 Existing Hook Points

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `scripts/lib/install-manifest.mjs` | 542-554 | `walkRegularFiles(absDir)` — private, symlink-skipping recursive walk | Reused by the new detector (both sides) |
| `scripts/lib/install-manifest.mjs` | 563-605 | `repoCompletenessFindings` — repo→installed MISSING/DIFFER, one-directional | Sibling to the new inverse detector; unchanged |
| `scripts/lib/install-manifest.mjs` | 605 (EOF) | end of file | APPEND `subtreeOrphanFindings` |
| `install.mjs` | 25-32 | import block from install-manifest.mjs | Add `subtreeOrphanFindings` to the import |
| `install.mjs` | 85 | `const installSecondOpinion = argv.includes('--install-second-opinion')` | Add `const pruneSubtreeOrphans` after it |
| `install.mjs` | 448 | `console.log(\`Installed ${scriptFiles.length} scripts to ${SCRIPTS_DIR}\`)` | Insert the prune block after this line |
| `install.mjs` | 1489-1498 | `assertContained(target, root)` — realpath containment guard (hoisted) | Reused per delete |
| `install.mjs` | 191 | usage line (flag list) | Add `--prune-subtree-orphans` |
| `install.mjs` | 268+ | Second-opinion / flag description block | Add a description entry |
| `tools/deploy-audit.mjs` | 128-142 | `findings.undeployed = …`; report loop | S3: add `findings.prunable` + a `PRUNABLE` line |
| `tests/test-install-scripts-subtrees.mjs` | 228-229 | after `testCompletenessSkipsSymlinks`, before summary (233) | Register 5 new tests here |

## §10 Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `539-S1` | Pure detector (zero behavior change) | `install-manifest.mjs`, `test-install-scripts-subtrees.mjs` | `subtreeOrphanFindings` + 3 unit tests | `testSubtreeOrphanGreen/Detected/SkipsSymlink` | Do NOT touch install.mjs |
| `539-S2` | Opt-in prune (the MUST feature) | `install.mjs`, `test-install-scripts-subtrees.mjs` | flag + prune block + import + help + 3 E2E tests | `testPruneFlagRemovesOrphan/AbsentKeepsOrphan/ContainmentGuard` | Do NOT change default (no-flag) behavior |
| `539-S3` | deploy-audit prune recommendation (SHOULD) | `tools/deploy-audit.mjs` | `PRUNABLE` line reusing detector | `manual: deploy-audit --json` | Stays report-only; deletes nothing |

### 10.1 Dependency graph

```text
S1 ── S2 ── S3
```

S2 hard-depends on S1 (imports the detector). S3 hard-depends on S1 (imports the detector); soft vs S2.

## §11 Cut Order

1. **S3** (deploy-audit recommendation) — deploy-audit already surfaces the orphan as `EXTRA`; the
   sharper line is a nicety.
2. **REQ-6 help text** — functional flag works without it (but keep if S2 lands).

Do **not** cut:

- REQ-3/REQ-4 (the opt-in prune + its no-flag negative control) — the feature.
- REQ-5 containment guard — the security invariant.

## §12 Contracts

### `subtreeOrphanFindings(repoDir, installedScriptsDir) → string[]`

**Input contract:** two absolute path strings. Neither dir need exist.
**Output contract:** sorted `string[]` of `scripts/<subtree>/<rel>` paths; never null; never throws.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. convergent | every installed subtree file exists in repo subtree | `[]` | none |
| B. orphan present | installed file absent from repo subtree | `['scripts/<s>/<rel>', …]` sorted | none |
| C. installed subtree missing | `installedScriptsDir/<s>` absent | that subtree contributes nothing | none |
| D. repo subtree missing | `repoDir/scripts/<s>` absent | every installed file under `<s>` is an orphan | none |
| E. symlink installed-side | non-regular dirent | skipped (not reported) | none |

### prune block (install.mjs, gated on `pruneSubtreeOrphans`)

**Error codes:**

| Code | Field | Trigger | Fail mode |
|---|---|---|---|
| `CONTAINMENT_VIOLATION` | delete path | `assertContained` realpath escapes `SCRIPTS_DIR` | **closed** — throws, install aborts non-zero, nothing outside removed |

The prune block has no gate/fail-open path: it only ever removes in-tree regular-file orphans; any
containment doubt throws.

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | subtree dir not deployed (missing) | `walkRegularFiles` existsSync guard → `[]`; no-op | `testSubtreeOrphanGreen` (covers missing via convergent) |
| EC2 | symlinked subtree dir escaping `SCRIPTS_DIR` | realpath both sides; `assertContained` throws; abort | `testPruneContainmentGuard` |
| EC3 | concurrent install invocation | each prune is an independent idempotent `rmSync({force:true})`; no torn state | covered by idempotent delete (EC6) |
| EC4 | orphan removed between detect and delete (ENOENT) | `{force:true}` swallows ENOENT; no throw | `testPruneFlagRemovesOrphan` (re-run idempotency implicit) |
| EC5 | empty finding set (convergent) | prune prints "no subtree orphans"; deletes nothing | `testPruneFlagAbsentKeepsOrphan` asserts no deletion; green path asserts empty |
| EC6 | validate-then-write ordering | `assertContained` fires **before** every `rmSync`, never after | `testPruneContainmentGuard` (nothing deleted when guard throws) |

## §14 Test Case Catalog

```text
Group 2 (unit, install-manifest): detector (3 tests)
  testSubtreeOrphanGreen        — convergent install → subtreeOrphanFindings === []
  testSubtreeOrphanDetected     — plant extra file in installed subtree → finding includes its 'scripts/<s>/<rel>'
  testSubtreeOrphanSkipsSymlink — symlink in installed subtree → not reported

Group 1 (E2E, real install.mjs): prune (3 tests)
  testPruneFlagRemovesOrphan     — mock install; plant orphan; re-run with --prune-subtree-orphans → orphan gone, clerk.md survives
  testPruneFlagAbsentKeepsOrphan — mock install; plant orphan; re-run WITHOUT flag → orphan retained (default unchanged)
  testPruneContainmentGuard      — installed subtree symlinked to an outside dir; --prune-subtree-orphans → non-zero exit, outside file survives
```

Total: 6 new tests. Test runner: `node tests/test-install-scripts-subtrees.mjs`.

Install/prune behavior is proven by isolated-HOME mock + REAL `install.mjs` (harness
`tests/lib/activation-scoping-harness.mjs`), never by mental-trace.

## §15 Verification Ledger (verify by artifact)

| Claim | Command (strong-layer) | Observed artifact |
|---|---|---|
| Detector + prune tests pass | `node tests/test-install-scripts-subtrees.mjs` | `<15/15 pass>` (9 existing + 6 new) |
| Prune E2E drives the REAL installer | `testPruneFlagRemovesOrphan` via `runInstall` (real install.mjs) | `<orphan absent, clerk.md present>` |
| Default behavior unchanged (negative) | `testPruneFlagAbsentKeepsOrphan` | `<orphan retained without flag>` |
| Containment holds (negative) | `testPruneContainmentGuard` | `<exit ≠ 0, outside file survives>` |
| Deploys clean | `node tools/deploy-audit.mjs` (unfiltered) | `<CLEAN>` |
| Merged | `gh pr view <n> --json state,mergeCommit` | `<commit>` |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Delete escapes the tree | High | Low | `assertContained` realpath guard per delete + EC2 negative test |
| Hard delete unrecoverable | Low | Med | Opt-in only; #539 §17 accepts residual risk (inert data file); quarantine rejected below |
| Detector false-positive removes live file | Med | Low | fresh repo-walk diff; convergent + repo-survive tests |
| deploy-audit becomes non-report-only (S3) | Med | Low | S3 only adds a print line; deletes nothing; asserted report-only |

**Quarantine-rename rejected:** renaming orphans to `<name>.stale.<ts>` (the snapshot pattern at
`install.mjs:341-355`) trades one inert file for another and leaves accumulating `.stale` cruft that
deploy-audit would then flag as EXTRA forever. The issue's §17 residual-risk analysis explicitly accepts
deletion of an inert, never-executed data file. Hard delete behind an explicit opt-in is the minimal
solution.

## §17 Open Decisions

- **`globalArtifactPairs` under-reporting** (install-version.mjs recursively walks only
  `second-opinion`, not `em-consolidate`/`topic-tracks`) → deferred; tracked in a **new issue filed at
  §18/step 9** (not #539 scope). 5-field DEFER:
  1. **Run the scenario:** `~/.episodic-memory/install-manifest.json` under-lists two of three global
     subtrees (Scout A read of install-version.mjs:250-261). This plan's detector sidesteps it by walking
     the repo fresh, so #539 is unaffected.
  2. **Spec check:** no MUST row here requires the manifest be complete; the detector does not consume it.
  3. **History check:** discovered during #539 scouting (this session); no prior reviewer episode.
  4. **Same-class check:** affects every non-`second-opinion` global subtree equally; the whole class is
     deferred together into the new issue.
  5. **Residual-risk:** the on-disk global manifest under-reports subtree files; downstream consumers of
     that manifest (if any) see an incomplete list. No corruption; recovery is regenerating the manifest
     after the fix. Low.

## §18 Done Criteria

- [ ] REQ-1..REQ-5 (all MUST) passing via `node tests/test-install-scripts-subtrees.mjs` → 15/15.
- [ ] `node tools/deploy-audit.mjs` → CLEAN after implementation.
- [ ] REQ-6 help text present (SHOULD) if S2 landed.
- [ ] The `globalArtifactPairs` gap filed as a GitHub issue (Rule 18 step 9) — issue number recorded here.
- [ ] Every review finding dispositioned (§19).

## §19 Review Consensus (Rule 18)

Second-opinion review on this plan before implementation:

```bash
node scripts/second-opinion.mjs request --provider codex --project /Users/charltondho/Developer/projects/episodic-memory \
  --storage episodic --body-file docs/plans/issue-539-prune-subtree-orphans.md \
  --summary "issue-539 prune-subtree-orphans plan review" --dispatch
```

| Pass | Reviewer | Provider/Model | Blocker count | Verdict | Reply episode |
|---|---|---|---|---|---|
| 1 | claude-subagent (codex flaked: SessionStart hook leaked into its subprocess) | claude-subagent | 0 | ACCEPT-WITH-MOD | `.review-store/replies/20260724-130048-9fab8009cdfd` |

### 19.1 Resolved blockers / findings

| # | Finding | Verdict | Resolution |
|---|---|---|---|
| F1 | prune iterates only current `GLOBAL_SCRIPT_SUBTREES`; whole de-classified subtree never converges | ACCEPT | §5 Non-Goals row added (doc-only) |
| F2 | deploy-audit `prunable ⊆ extra` double-print with contradictory guidance (S3) | ACCEPT-WITH-MOD | S3 steps 3.2-3.4 reworked: subtree orphan lands in `prunable` only, advisory-only (not in drift sum) |
| F3 | §8.2 ordering rationale misstated (detector reads repo, not copied set) | ACCEPT | §8.2 bullet corrected |
| F4 | containment test leaks repo files into `outsideDir` | ACCEPT | step 2.6 note: `outsideDir` added to try/finally cleanup |

Cap at 2 rounds (§A.7 stopping rule). Three-layer review: per-function (detector) → cross-file
(install.mjs prune block calling the detector + assertContained) → PR-level (whole diff + help/doc drift).

## §20 Lessons Encoded (traceability)

| Lesson | One-line rule | Enforced in |
|---|---|---|
| `…540d` unfiltered deploy audit / investigate before prune | prune is opt-in + report-only detection; deploy-audit never deletes | §5, §15, §16 |
| `…937a` lstat/realpath authority | `assertContained` realpaths both sides before delete | §7, §12 |
| mock-project not mental-trace | prune behavior proven by isolated-HOME mock + real install.mjs | §14 |
| verify both polarities of the controlling flag | flag-on removes, flag-off retains — same input | §4 REQ-3/REQ-4 |
| bp1 step-9 5-field DEFER | the globalArtifactPairs gap gets an issue + 5 fields | §17, §18 |
| simplicity-first | hard delete over quarantine; no empty-dir removal | §5, §16 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value for this plan |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check (§A.4) | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-install-scripts-subtrees.mjs` → `N/N pass` |
| New-function phrasing | `export function fnName(args) { … }` |
| Portable break-input override | argv/fixture-driven (the E2E negative controls plant a real symlink/orphan; no env prefix) |
| Search tool for verifies | `grep -n` / `grep -c` from repo root |
| Repo-specific done-commands | `node tools/deploy-audit.mjs` |

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/issue-539-prune-subtree-orphans.md
```

Expected: matches only §0-quoted template prose (none inside §A.5 or §A.7 rows). Author disposition:
record each match line; ready iff no match falls inside a step-table row.

## A.2 Executor contract

Copy verbatim into the handoff. (1) Steps in numeric order. (2) Each names one file + exact change +
verify. (3) **Make no design decisions**; anchor not found verbatim → STOP (§A.3). (4) Run the verify
after each step; fix only that step. (5) **One file per step.** Read-only refs: `docs/plans/issue-539-prune-subtree-orphans.md`.
(6) One command per verify — no `;`/`&&`/`||`/pipes/subshells. (7) One slice = one commit
`539-S<n>: <title>` + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. (8) No
push/PR until §18 green **and** human approved. (9) No aspirational output.

## A.3 STOP-and-ask protocol

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <±3 lines>
Question: <the single decision the plan owner must make>
```

## A.4 Pre-flight (step 0 of every slice)

| Check | Command | Expected |
|---|---|---|
| Right branch | `git branch --show-current` | `feat/issue-539-prune-subtree-orphans` |
| Clean tree | `git status --porcelain` | empty |
| Baseline green | `node tests/test-install-scripts-subtrees.mjs` | `9/9 pass` |
| Runtime | `node --version` | `v20`+ |

## A.5 Shared constants / types

```js
// install-manifest.mjs already exports: GLOBAL_SCRIPT_SUBTREES = ['em-consolidate','second-opinion','topic-tracks']
// and the private helper walkRegularFiles(absDir) → string[] (repo-relative, symlink-skipping).
// install.mjs already declares (hoisted): function assertContained(target, root) — throws 'CONTAINMENT_VIOLATION: '+target on escape.
// install.mjs already binds: SCRIPTS_DIR = <home>/.episodic-memory/scripts ; REPO_DIR = repo root ; scriptFiles = deployed flat .mjs list.
```

## A.6 Anchor format

Standard: **ANCHOR** = verbatim unique substring; **CREATE** whole-file write; **EDIT** anchored
replace (smallest diff, no reflow); **APPEND** add block at EOF.

## A.6b Falsifiable Verify

Every verify names the observed value + expected value and fails on a stub. Negative controls
(`testPruneFlagAbsentKeepsOrphan`, `testPruneContainmentGuard`, `testSubtreeOrphanSkipsSymlink`) are their
own test bodies that fail if the guard/skip is absent. One command per verify.

## A.7 Per-slice step tables

### `539-S1` — detector `subtreeOrphanFindings` (REQ-1, REQ-2)

**Files this slice may touch:** `scripts/lib/install-manifest.mjs`, `tests/test-install-scripts-subtrees.mjs`. **Read-only:** the plan.

| Step | File | Kind | Exact action (anchor + literal change) | Verify (observed → expected) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4. | every row passes |
| 1.1 | `scripts/lib/install-manifest.mjs` | **APPEND** | Add at end of file:<br>`` /**``<br>`` * Inverse of repoCompletenessFindings: regular files present under``<br>`` * installedScriptsDir/<subtree> (for each GLOBAL_SCRIPT_SUBTREES member) but``<br>`` * absent from repoDir/scripts/<subtree>. Sorted 'scripts/<subtree>/<rel>'.``<br>`` * Never throws on missing dirs (walkRegularFiles guards existsSync).``<br>`` */``<br>`export function subtreeOrphanFindings(repoDir, installedScriptsDir) {`<br>`  const findings = []`<br>`  for (const s of GLOBAL_SCRIPT_SUBTREES) {`<br>`    const repoSet = new Set(walkRegularFiles(path.join(repoDir, 'scripts', s)))`<br>`    for (const rel of walkRegularFiles(path.join(installedScriptsDir, s))) {`<br>`      if (!repoSet.has(rel)) findings.push(\`scripts/${s}/${rel}\`)`<br>`    }`<br>`  }`<br>`  return findings.sort()`<br>`}` | `grep -n 'export function subtreeOrphanFindings' scripts/lib/install-manifest.mjs` → 1 match |
| 1.2 | `tests/test-install-scripts-subtrees.mjs` | **EDIT** | ANCHOR (import): `  classifyScriptSubtree, repoCompletenessFindings,` → REPLACE: `  classifyScriptSubtree, repoCompletenessFindings, subtreeOrphanFindings,` | `grep -n 'subtreeOrphanFindings' tests/test-install-scripts-subtrees.mjs` → ≥1 match |
| 1.3 | `tests/test-install-scripts-subtrees.mjs` | **EDIT** | ANCHOR: `// ---------------------------------------------------------------------------\n// Summary` → insert BEFORE it the three unit tests below, then keep the anchor. Bodies (verbatim):<br>`testSubtreeOrphanGreen`: build synthetic `repo/scripts/em-consolidate/a.md`='SENTINEL_539g' + `installed/em-consolidate/a.md` (copy of a.md); `assert.deepStrictEqual(subtreeOrphanFindings(repo, installed), [])`.<br>`testSubtreeOrphanDetected`: same trees plus `installed/em-consolidate/gone.md`='ORPHAN_539'; `assert.ok(subtreeOrphanFindings(repo, installed).includes('scripts/em-consolidate/gone.md'))`.<br>`testSubtreeOrphanSkipsSymlink`: `installed/em-consolidate/a.md` real + `installed/em-consolidate/link.md`→a.md symlink; `assert.deepStrictEqual(subtreeOrphanFindings(repo, installed), [])` (symlink not reported). Each wraps its tmpdirs in try/finally `fs.rmSync(..., {recursive:true,force:true})`, models `testCompletenessSkipsSymlinks` (lines 202-228). | `node tests/test-install-scripts-subtrees.mjs` → `12/12 pass` |
| 1.4 | — | — | Commit `539-S1: subtreeOrphanFindings detector + unit tests`. | `git log -1 --oneline` → shows `539-S1` |

### `539-S2` — opt-in prune in install.mjs (REQ-3, REQ-4, REQ-5, REQ-6)

**Files this slice may touch:** `install.mjs`, `tests/test-install-scripts-subtrees.mjs`. **Read-only:** the plan, `install-manifest.mjs`.

| Step | File | Kind | Exact action (anchor + literal change) | Verify |
|---|---|---|---|---|
| 2.0 | — | — | Pre-flight §A.4 (baseline now `12/12`). | passes |
| 2.1 | `install.mjs` | **EDIT** | ANCHOR: `  activationSupportFiles, classifyScriptSubtree,` → REPLACE: `  activationSupportFiles, classifyScriptSubtree, subtreeOrphanFindings,` | `grep -n 'subtreeOrphanFindings' install.mjs` → ≥1 |
| 2.2 | `install.mjs` | **EDIT** | ANCHOR: `const installSecondOpinion = argv.includes('--install-second-opinion')` → REPLACE: keep that line, then add on the next line `const pruneSubtreeOrphans = argv.includes('--prune-subtree-orphans')` | `grep -n "pruneSubtreeOrphans = argv" install.mjs` → 1 |
| 2.3 | `install.mjs` | **EDIT** | ANCHOR: `` console.log(`Installed ${scriptFiles.length} scripts to ${SCRIPTS_DIR}`) `` → insert AFTER it:<br>`if (pruneSubtreeOrphans) {`<br>`  const orphans = subtreeOrphanFindings(REPO_DIR, SCRIPTS_DIR)`<br>`  for (const rel of orphans) {`<br>`    const abs = path.join(SCRIPTS_DIR, rel.slice('scripts/'.length))`<br>`    assertContained(abs, SCRIPTS_DIR)`<br>`    fs.rmSync(abs, { force: true })`<br>`    console.log(\`Pruned orphan ${rel}\`)`<br>`  }`<br>`  console.log(orphans.length ? \`Pruned ${orphans.length} subtree orphan(s)\` : 'No subtree orphans to prune')`<br>`}` | `grep -n 'Pruned orphan' install.mjs` → 1 |
| 2.4 | `install.mjs` | **EDIT** | ANCHOR (usage line): `[--install-second-opinion] [--bootstrap-last-prompt]` → REPLACE: `[--install-second-opinion] [--prune-subtree-orphans] [--bootstrap-last-prompt]` | `grep -c 'prune-subtree-orphans' install.mjs` → ≥3 |
| 2.5 | `install.mjs` | **EDIT** | ANCHOR: `Second-opinion harness:` → insert BEFORE it a description block:<br>`  --prune-subtree-orphans Opt-in: after deploying scripts/<subtree>/ data,`<br>`                          delete files under ~/.episodic-memory/scripts/<subtree>/`<br>`                          that no longer exist in the repo subtree (orphans from`<br>`                          a removed file). Report-only detection lives in`<br>`                          tools/deploy-audit.mjs; this flag is the deliberate`<br>`                          deletion. Default install deletes nothing.` (keep the anchor after) | `node install.mjs` (no --tool) prints `--prune-subtree-orphans` line — observed stdout contains the string |
| 2.6 | `tests/test-install-scripts-subtrees.mjs` | **EDIT** | ANCHOR: `// ---------------------------------------------------------------------------\n// Summary` → insert BEFORE it the three E2E tests (verbatim bodies):<br>`testPruneFlagRemovesOrphan`: `mkMock`; `runInstall({home,project,callerCwd})`; plant `home/.episodic-memory/scripts/em-consolidate/ORPHAN_539.md`='x'; `runInstall({home,project,callerCwd,flags:['--prune-subtree-orphans']})`; assert exit 0, `!existsSync(orphan)`, `existsSync(.../em-consolidate/prompts/clerk.md)` (repo file survived).<br>`testPruneFlagAbsentKeepsOrphan`: same setup; second `runInstall` WITHOUT the flag; assert orphan STILL exists (default unchanged).<br>`testPruneContainmentGuard`: `mkMock`; `runInstall`; then `rmSync(.../scripts/em-consolidate,{recursive})` and `symlinkSync(outsideDir, .../scripts/em-consolidate)` where `outsideDir` holds `keep.txt`; `runInstall({...,flags:['--prune-subtree-orphans']})`; assert `r.status !== 0` AND `existsSync(outsideDir/keep.txt)` (nothing deleted outside). Note (review F4): the second `runInstall` copies repo em-consolidate files *into* `outsideDir` through the symlinked dst before prune throws — so the `try/finally` MUST `fs.rmSync(outsideDir, {recursive:true,force:true})` to avoid leaving repo files in the tmp escape dir. | `node tests/test-install-scripts-subtrees.mjs` → `15/15 pass` |
| 2.7 | — | — | Commit `539-S2: --prune-subtree-orphans opt-in + E2E tests`. | `git log -1 --oneline` → `539-S2` |

### `539-S3` — deploy-audit PRUNABLE recommendation (REQ-7, SHOULD — cut first)

**Files this slice may touch:** `tools/deploy-audit.mjs`. **Read-only:** the plan.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 3.1 | `tools/deploy-audit.mjs` | **EDIT** | ANCHOR (import): `import { repoCompletenessFindings } from '../scripts/lib/install-manifest.mjs'` → REPLACE: `import { repoCompletenessFindings, subtreeOrphanFindings } from '../scripts/lib/install-manifest.mjs'` | `grep -c subtreeOrphanFindings tools/deploy-audit.mjs` → 1 |
| 3.2 | `tools/deploy-audit.mjs` | **EDIT** | ANCHOR: `const findings = { missing: [], differ: [], cosmetic: [], extra: [] }` → REPLACE: `const findings = { missing: [], differ: [], cosmetic: [], extra: [], prunable: [] }` and (as the same step's second line, still one file) add ABOVE the `for (const d of DIRS)` loop: `const subtreePrunableSet = new Set(subtreeOrphanFindings(REPO_ROOT, path.join(REAL, '.episodic-memory', 'scripts')).map(p => p.replace(/^scripts\//, '.episodic-memory/scripts/')))` | `grep -n 'subtreePrunableSet' tools/deploy-audit.mjs` → ≥1 |
| 3.3 | `tools/deploy-audit.mjs` | **EDIT** | ANCHOR: `    if (!mockSet.has(f) && !IGNORE_EXTRA.has(key)) findings.extra.push(key)` → REPLACE: `    if (!mockSet.has(f) && !IGNORE_EXTRA.has(key)) { if (subtreePrunableSet.has(key)) findings.prunable.push(key); else findings.extra.push(key) }` — a subtree orphan lands in `prunable` ONLY, never double-counted as `EXTRA` (review F2). | `node tools/deploy-audit.mjs --json` → a file in `prunable` is absent from `extra` |
| 3.4 | `tools/deploy-audit.mjs` | **EDIT** | ANCHOR: `  for (const k of findings.extra) console.log(\`  EXTRA    ${k}  (orphan — TRACE consumers before pruning)\`)` → insert AFTER it: `  for (const k of findings.prunable) console.log(\`  PRUNABLE    ${k}  (subtree orphan — safe: rerun install with --prune-subtree-orphans)\`)`. `prunable` is advisory-only — NOT added to the `drift` sum (line 129); a prunable orphan is a known-safe refinement, surfaced but never a fail condition (state this in a one-line comment above the loop). | `grep -c 'findings.prunable' tools/deploy-audit.mjs` → ≥2 |
| 3.5 | — | — | Commit `539-S3: deploy-audit PRUNABLE subtree-orphan recommendation`. | `git log -1 --oneline` → shows `539-S3` |

## A.8 Definition of done

```bash
node tests/test-install-scripts-subtrees.mjs   # → 15/15 pass (12 after S1)
node tools/deploy-audit.mjs                     # → CLEAN
grep -c 'prune-subtree-orphans' install.mjs     # → ≥3 (flag + usage + description)
```

## A.9 Blast-radius patterns applied

- **Red-then-green:** `testPruneFlagAbsentKeepsOrphan` (flag off → orphan kept) is the negative control
  for `testPruneFlagRemovesOrphan`; `testSubtreeOrphanGreen` vs `testSubtreeOrphanDetected` discriminate
  on a single planted file; `testPruneContainmentGuard` proves the guard goes red on an escaping symlink.
- **Pure-extraction first:** S1 lands the detector with zero install.mjs change (existing 9 tests stay green).
- **Discriminating sentinel:** planted orphans carry `ORPHAN_539` / `SENTINEL_539g` so a pass proves the
  exact file flowed through, not "non-empty".
- **Mock-project E2E:** all prune tests drive the REAL install.mjs via the activation-scoping harness.
- **Flag high-blast-radius:** S2 touches install.mjs's global deploy path — marked **focused review
  before build** even though fully specified.
