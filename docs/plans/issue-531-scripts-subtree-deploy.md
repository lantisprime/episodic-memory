# ISSUE-531 Class-closing deployment of scripts/ data subtrees Plan

## §1 Status

`Planning only.` Do not implement until this plan, the plan review, and the adversarial
review are accepted (Rule 18). Current stage: **reviewed (planner HOLD folded; GLM r2
ACCEPT) — awaiting user approval**.

| Field | Value |
|---|---|
| RFC | `n/a` (GitHub issue #531; distribution layer per CAPABILITIES.md "Adjacent layers") |
| Parent requirements | issue #531 items 1–5 (5-field defer format) |
| Workplan episode | `20260714-092000-workplan-v200-fork-resolved-c8a7-branch--3d6d` |
| Target branch | `feat/531-scripts-subtree-deploy` |
| Executor altitude (§0.1) | `low` (pi/MiniMax-M3 builder seat) |

## §2 Episode Search Summary

Ran: `node scripts/em-search.mjs --query "installer deploy audit blind subdirectory" --scope all --limit 5 --no-track` (2026-07-14).

Key active memories:

- `20260619-153204-a-manifest-filtered-deploy-check-migrati-540d`: a manifest/filtered
  deploy check is structurally blind to classes it does not enumerate — constrains this
  plan to close the class in the UNFILTERED audit (`tools/deploy-audit.mjs`), not only in
  the manifest.
- `20260619-145942-verify-the-strong-claim-not-the-proxy-la-7918`: E2E = isolated-HOME
  mock + real `install.mjs`, never mental-trace — constrains §14.
- `20260714-092000-…-3d6d` (workplan v200): #531 must land BEFORE the aggregator arc;
  the aggregator will be the first runtime consumer of the deployed prompt.

Verified 2026-07-14 (memories vs disk): `scripts/em-consolidate/prompts/clerk.md` exists
in repo; `~/.episodic-memory/scripts/` contains `lib/` and `second-opinion/` but **no**
`em-consolidate/` (observed `ls`); `scripts/scaffold-plugin/templates/` exists in repo and
is deployed nowhere.

## §3 Objective

After `node install.mjs --tool claude-code`, every file under `scripts/em-consolidate/`
exists byte-identical under `~/.episodic-memory/scripts/em-consolidate/` — and the fix is
class-closing: `scripts/<name>/` subtree deployment is driven by one exported data list,
an unclassified new subtree fails the install closed, and `tools/deploy-audit.mjs` gains a
repo→install completeness check so `CLEAN` proves repo == deployed, not merely mock == real.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | Core install deploys `scripts/em-consolidate/**` recursively; every file byte-identical to repo | #531 item 1 | `testEmConsolidateDeployed` | MUST | includes `prompts/clerk.md`; sentinel = repo file bytes |
| REQ-2 | Subtree deployment is data-driven: `GLOBAL_SCRIPT_SUBTREES` / `REPO_ONLY_SCRIPT_SUBTREES` + `classifyScriptSubtree()` exported from `scripts/lib/install-manifest.mjs`; `second-opinion/` migrates to the same mechanism with zero behavior change | #531 item 4 | `testSecondOpinionStillDeployed`, `node tests/test-install-second-opinion-e2e.mjs` (existing, stays green) | MUST | P2: definitions are data behind a stable contract |
| REQ-3 | An unclassified `scripts/<dir>/` fails the install CLOSED with an error naming the dir and both lists | #531 item 4 | `testUnclassifiedSubtreeFailsClosed` (copied-repo E2E, red control), `testClassifierUnknown` (unit) | MUST | fail direction: closed (§12) |
| REQ-4 | `tools/deploy-audit.mjs` reports `UNDEPLOYED` for any repo global-scripts file (flat substrate entries, global lib closure, `GLOBAL_SCRIPT_SUBTREES` subtrees) missing or byte-different in the clean mock install; drift exit stays 1 | #531 item 4; lesson `…540d` | `testRepoCompletenessGreen`, `testRepoCompletenessRed` (unit on `repoCompletenessFindings`), `manual: node tools/deploy-audit.mjs` | MUST | closes the repo==deployed direction the mock-vs-real diff cannot see |
| REQ-5 | `scripts/scaffold-plugin/` is classified repo-only and is NOT deployed | #531 item 4 same-class | `testScaffoldPluginNotDeployed` | MUST | repo-dev class per `install-manifest.mjs:271` |
| REQ-6 | Every `scripts/` subtree existing in repo today is classified (no `unclassified` at HEAD) | #531 item 4 | `testAllCurrentSubtreesClassified` | MUST | walks real repo dirents |

## §5 Non-Goals

- No runtime prompt loader (`readFileSync` of `clerk.md`) — that is the aggregator arc
  (issue #531 item 2: P4 ships no loader).
- No change to `tools/migration-cutover.mjs` or `buildInstallManifest` (deferred, §17).
- No behavior change to `em-consolidate.mjs`, the second-opinion harness, or per-project
  enforcement installs.
- No pruning of anything in real `~/.episodic-memory` (deploy-audit stays report-only).

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (targeted) | Writes | Notes |
|---|---|---|---|---|
| `install.mjs` | 3601 | ~130 lines (355–440, 18–33) | 2 anchored edits | builder must NOT read whole file |
| `scripts/lib/install-manifest.mjs` | 510 | ~100 lines (185–285) | 1 append | |
| `tools/deploy-audit.mjs` | 140 | all | 2 anchored edits | |
| `tests/test-install-scripts-subtrees.mjs` | new | — | 1 create | models `test-install-second-opinion-e2e.mjs:197` |
| `tests/lib/activation-scoping-harness.mjs` | 260+ | ~60 lines | 1 anchored edit | `runInstall` gains optional `installerRepo` (planner Gap 2a) |

**Baseline (single session):** ~35k tokens. **Optimized:** same (one slice).

## §7 Safety / Security

Negative-scenario-planner: DISPATCHED 2026-07-14, verdict HOLD, 2 P1 gaps — both folded
below (reply episode `20260714-093850-plan-time-negative-scenario-audit-issue--31e3`,
full command+output pairs there). Gap 1: validate-then-write held only for subtrees, not
the flat/lib copies that precede them → classification hoisted BEFORE any `scripts/`
write (§8.2/§8.3, step 1.3). Gap 2: red-control test was non-hermetic — `runInstall`
hardcodes the real repo's `install.mjs` (`activation-scoping-harness.mjs:225`), and
`fs.cpSync` absolutizes the repo's two tracked relative symlinks unless
`verbatimSymlinks: true` (probed on Node v26) → harness gains `installerRepo` override;
test uses `verbatimSymlinks: true` (steps 1.6a/1.7). Gap 3 (stale files inside a deployed
subtree are never pruned and invisible to MISSING/DIFFER) → sanctioned DEFER, §17.

| Concern | Severity | Attack/abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| New subtree silently ships nowhere (the #531 class) | Med | contributor adds `scripts/foo/data.json`, installer ignores it, consumer breaks at runtime months later | fail-closed classification at install time | `testUnclassifiedSubtreeFailsClosed` (negative: unclassified dir → non-zero exit) |
| Audit false-CLEAN (mock==real but repo≠mock) | Med | installer bug drops a file from BOTH mock and real → old audit prints CLEAN | `repoCompletenessFindings` in deploy-audit | `testRepoCompletenessRed` (negative: delete a file from installed tree → finding returned) |
| Symlink inside a deployed subtree | Low | a symlink entry in `scripts/<name>/` is neither `isDirectory()` nor `isFile()` in `copyDirRecursive` → silently skipped; completeness check would then flag it forever | keep skip behavior; completeness walk counts only regular files on the REPO side too (same dirent filter) so behavior is consistent and loud only for real files | `testCompletenessSkipsSymlinks` (synthetic fixture, real injected symlink — GLM r1 W3) |
| Fail-closed throw aborts mid-install with partial copy | Low | unclassified dir discovered after flat `.mjs`/`lib/` files already copied (planner Gap 1: the flat copy at `install.mjs:377-400` precedes the old block's position) | classification of ALL dirents runs BEFORE the first write under `scripts/` — hoisted above the flat-file copy (step 1.3) | `testUnclassifiedSubtreeFailsClosed` asserts error + mock global scripts dir has NO flat script (`em-store.mjs` absent) and NO subtree |
| Classification throw routes through the second-opinion quarantine catch (GLM r1 B3.3) | Med | with `--install-second-opinion` + unclassified dir, a throw INSIDE the try hits `catch (copyErr)` at `install.mjs:411-420`: still-valid snapshot spuriously quarantined + false "Runtime copy failed / partially modified" stderr | classification block placed OUTSIDE (before) the `try` — the throw propagates uncaught; no new throw site inside the quarantine's try | `testUnclassifiedSubtreeFailsClosed` second polarity: rerun with `--install-second-opinion`, assert same classification error, exit non-zero, and output does NOT match `/quarantining snapshot/` |
| Red-control test runs the real installer instead of the copied repo | High (test validity) | `runInstall` resolves `path.join(REPO_ROOT, 'install.mjs')` — fake unclassified dir in tmpRepo never seen; control passes vacuously | `installerRepo` override in harness; test asserts the FAILING run's stderr names the fake dir (proves the copied installer ran) | `testUnclassifiedSubtreeFailsClosed` output match on `aaa-unclassified-531` |
| cpSync corrupts tracked relative symlinks in the copied repo | Low | default cpSync absolutizes symlink targets back to the REAL repo (probed, Node v26): `plugins/claude-code/hooks/lib/{local-dir,registry-validator}.mjs` | `verbatimSymlinks: true` in the test's cpSync call | copied-repo install exits on the classification error, not a symlink resolution error |

Path-authority predicates: none added (no `realpath`/`lstat` authority decisions; paths
are `path.join` of trusted constants). 8-axis symlink matrix therefore reduced to the
copy/walk row above.

## §8 Design

Three disjoint classes exist today for flat `scripts/*.mjs` (`install-manifest.mjs:194-197`):
substrate → global, enforcement → per-project, repo-dev → nowhere. This plan extends the
same explicit-classification rule to `scripts/<name>/` **subtrees**:

| Subtree | Class | Handling |
|---|---|---|
| `lib/` | `lib` | existing filtered copy (`relocatedOnlyLibs`), unchanged |
| `second-opinion/` | `global` | recursive copy (mechanism migrates from hardcoded block to data-driven loop) |
| `em-consolidate/` | `global` | recursive copy (NEW — fixes #531) |
| `scaffold-plugin/` | `repo-only` | never copied |
| anything else | `unclassified` | install throws (fail closed) |

Consumed by two sites: `install.mjs` (copy loop) and `tools/deploy-audit.mjs` (repo
completeness via `repoCompletenessFindings`). Single source of truth in
`scripts/lib/install-manifest.mjs` (Principle 2: definitions are data; the interpreting
code sits behind a stable export). Substrate stays global and hook-free (P12 I-4: prompt
data under `~/.episodic-memory/scripts/em-consolidate/` is substrate payload, zero
registrations). No new background work (P6), no consent surface change (P3/P10: same
installer invocation, side effect is two more copied dirs, declared in install output).

### 8.1 Key types

```js
/**
 * classifyScriptSubtree(name) → 'lib' | 'global' | 'repo-only' | 'unclassified'
 * repoCompletenessFindings(repoDir, installedScriptsDir) → string[] — sorted
 *   repo-relative paths ('scripts/…') expected in a clean install but missing
 *   or byte-different under installedScriptsDir. Empty array = complete.
 */
```

### 8.2 Key invariants

- Every `scripts/` dirent that is a directory has exactly one class; `unclassified` is
  unreachable at HEAD (REQ-6) and fatal at install time (REQ-3).
- Classification of ALL subtrees is checked BEFORE the FIRST write under the global
  scripts dir — including the flat `.mjs` copy and the `lib/` copy (planner Gap 1) —
  and OUTSIDE the copy/quarantine `try` (GLM r1 B3.3): a classification throw
  propagates uncaught with its own accurate message and can NEVER route through the
  `catch (copyErr)` at `install.mjs:411-420`, so no spurious snapshot quarantine and
  no false "Runtime copy failed / partially modified" stderr under
  `--install-second-opinion`. The quarantine catch keeps its semantics because no new
  throw site exists inside its try.
- **Cross-platform:** `path.join` throughout; test repo-copy via `fs.cpSync` with a filter;
  no shell, no GNU flags, no env-prefix break inputs.
- **Atomicity:** unchanged from current installer (per-file `copyFileSync`; the quarantine
  path at `install.mjs:411-420` keeps its semantics — the new loop stays inside the same `try`).

### 8.3 Resolution / flow

```text
install:  readdirSync(scripts) → classify ALL dirs → any unclassified? throw
          (OUTSIDE the quarantine try — uncaught, accurate, pre-write)
          → try { flat .mjs copy (unchanged) → lib/ copy (unchanged)
                  → copy 'global' subtrees recursively } catch: quarantine (unchanged)
audit:    clean mock install → mock-vs-real diff (existing)
          → repoCompletenessFindings(repo, mockScripts) → UNDEPLOYED findings → drift
```

## §9 Existing Hook Points

Verified 2026-07-14 at `9fa965e`:

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `install.mjs` | 25–32 | imports manifest exports | add 2 names |
| `install.mjs` | 402–410 | hardcoded `second-opinion/` recursive copy | replaced by data-driven loop |
| `install.mjs` | 422–433 | `copyDirRecursive` helper | reused unchanged |
| `install.mjs` | 91 | `REPO_SECOND_OPINION` constant | KEEP (used by snapshot logic elsewhere); only the copy block stops using it |
| `scripts/lib/install-manifest.mjs` | 510 (EOF) | — | append lists + 2 functions |
| `tools/deploy-audit.mjs` | 43 | imports test harness | add manifest import |
| `tools/deploy-audit.mjs` | 104–126 | findings loop + drift calc | add UNDEPLOYED section |

## §10 Slice Ladder

Single slice (one concern: class-closing deployment). One PR.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| 531-S1 | data-driven subtree deploy + fail-closed + audit completeness | `scripts/lib/install-manifest.mjs`, `install.mjs`, `tools/deploy-audit.mjs`, `tests/lib/activation-scoping-harness.mjs`, `tests/test-install-scripts-subtrees.mjs` | classes list, install loop (classification hoisted pre-write), `repoCompletenessFindings`, UNDEPLOYED reporting, `installerRepo` harness option | 9 new + existing suites green | NO runtime loader; NO migration-cutover changes; NO edits to `copyDirRecursive`; NO change to existing `runInstall` callers |

## §11 Cut Order

1. Nothing — the slice is already minimal (`testCompletenessSkipsSymlinks` is a MUST-row
   control and is not cuttable).

Do **not** cut: fail-closed classification (REQ-3); the UNDEPLOYED audit check (REQ-4).

## §12 Contracts

### `classifyScriptSubtree(name) → string`

**Input contract:** basename string of a direct child directory of `scripts/`.
**Output contract:** exactly one of `'lib' | 'global' | 'repo-only' | 'unclassified'`; never throws.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A | `name === 'lib'` | `'lib'` | none |
| B | `GLOBAL_SCRIPT_SUBTREES.includes(name)` | `'global'` | none |
| C | `REPO_ONLY_SCRIPT_SUBTREES.includes(name)` | `'repo-only'` | none |
| D | none of the above | `'unclassified'` | none |

### `repoCompletenessFindings(repoDir, installedScriptsDir) → string[]`

**Input contract:** `repoDir` = repo root; `installedScriptsDir` = a scripts dir produced
by a clean install (mock or real).
**Output contract:** sorted array of repo-relative paths; empty = complete. Never throws
on missing dirs (missing installed file → finding, not exception).

| State | Condition | Output | Side effects |
|---|---|---|---|
| A | every expected file present + byte-equal | `[]` | none |
| B | expected file absent in installed tree | path in array | none |
| C | expected file present, bytes differ | path in array | none |
| D | repo-side non-regular entry (symlink) | ignored (not expected) | none |

Expected-file universe: `globalEntryScripts(repoDir)` + `lib/<f>` for `globalScriptLibs(repoDir)`
+ recursive regular files of each `GLOBAL_SCRIPT_SUBTREES` member.

**Error codes (install.mjs fail-closed):**

| Code | Field | Trigger | Fail mode |
|---|---|---|---|
| exit 1 (thrown Error, UNCAUGHT — outside the quarantine try) | message contains `not classified in install-manifest.mjs` and the dir name; stderr NEVER contains `quarantining snapshot` for this trigger | unclassified subtree | **closed** |

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `scripts/em-consolidate/` missing entirely (consumer dist copy) | loop skips absent members: copy guarded by existence — classifier loop iterates only dirents that EXIST, so absence = nothing to copy, no throw | `testRepoCompletenessGreen` (mock has it) |
| EC2 | symlink entry inside a global subtree | skipped by both copy and completeness walk (consistent dirent filter) | assertion inside `testRepoCompletenessGreen` |
| EC3 | concurrent install runs | unchanged from current installer semantics (per-file copy; last writer wins) — out of scope, no new shared state | n/a |
| EC4 | unclassified dir found after partial work | classification of ALL dirs precedes ANY write under global scripts/ → nothing copied (flat, lib, or subtree) | `testUnclassifiedSubtreeFailsClosed` |
| EC5 | empty subtree (dir with no files) | copy creates empty dir; completeness finds zero expected files → no finding | covered by `repoCompletenessFindings` contract state A |
| EC6 | validate-then-write ordering | classifier sweep before first copy of ANY class | `testUnclassifiedSubtreeFailsClosed` asserts error + mock global scripts dir absent-or-empty (no `em-store.mjs`, no `second-opinion/`) |

## §14 Test Case Catalog

```text
Group 1: install E2E (isolated-HOME mock + REAL install.mjs) (4 tests)
  testEmConsolidateDeployed — mock install; clerk.md exists + bytes === repo bytes
  testSecondOpinionStillDeployed — adversarial-depth-v1.md exists + bytes === repo bytes
  testScaffoldPluginNotDeployed — no scripts/scaffold-plugin in mock global
  testUnclassifiedSubtreeFailsClosed — repo copied via cpSync({recursive, verbatimSymlinks: true,
    filter}) + scripts/aaa-unclassified-531/x.txt added to the COPY; TWO polarities against
    the copied installer (installerRepo: tmpRepo): (i) core install → exit non-zero, output
    contains 'not classified in install-manifest.mjs' AND 'aaa-unclassified-531' (proves the
    copied installer ran), mock global scripts/ has NO em-store.mjs and NO second-opinion/
    (EC4/EC6); (ii) rerun with flags ['--install-second-opinion'] into a second mock →
    same classification error, exit non-zero, output does NOT match /quarantining snapshot/
    (GLM r1 B3.3 interaction proven, not asserted)

Group 2: classifier + completeness units (5 tests)
  testClassifierUnknown — classifyScriptSubtree('zz-no-such-dir-531') === 'unclassified'
  testAllCurrentSubtreesClassified — every scripts/ dirent dir at HEAD !== 'unclassified'
  testRepoCompletenessGreen — findings === [] on a fresh mock install
  testRepoCompletenessRed — delete scripts/em-consolidate/prompts/clerk.md from the MOCK
    install tree → findings includes 'scripts/em-consolidate/prompts/clerk.md'
  testCompletenessSkipsSymlinks — SYNTHETIC fixture repo dir (tmp): scripts/em-consolidate/
    contains real file a.md + symlink link.md → a.md; installed tree contains only a.md;
    repoCompletenessFindings(fixtureRepo, installedDir) === [] (symlink never expected —
    real filter assertion, not vacuous at HEAD where scripts/ has zero symlinks; GLM r1 W3)
```

Total: 9 tests. Runner: `node tests/test-install-scripts-subtrees.mjs`.
Regression: `node tests/test-install-second-opinion-e2e.mjs` and `node tests/test-p12-global-clean.mjs` stay green.

## §15 Verification Ledger (fill at implementation)

| Claim | Command (strong layer) | Observed artifact |
|---|---|---|
| All new tests pass | `node tests/test-install-scripts-subtrees.mjs` | `<fill>` |
| Existing e2e green | `node tests/test-install-second-opinion-e2e.mjs` | `<fill>` |
| P12 clean | `node tests/test-p12-global-clean.mjs` | `<fill>` |
| Deploys clean (post-merge) | `node tools/deploy-audit.mjs` (unfiltered) | `<fill>` |
| CI green | `gh pr checks <PR>` | `<fill>` |
| Merged | `gh pr view <n> --json state,mergeCommit` | `<fill>` |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Fail-closed throw breaks a downstream consumer with a scratch dir under scripts/ | Low | Low | error message names the exact fix; scratch dirs under scripts/ are already a repo-hygiene violation |
| deploy-audit runtime grows (extra walk) | Low | Low | one extra recursive walk of ~3 small dirs |
| second-opinion copy regression during mechanism migration | Med | Low | `testSecondOpinionStillDeployed` + existing e2e suite |

## §17 Open Decisions

- **Stale files inside a deployed subtree are never pruned (planner Gap 3)** → deferred;
  tracked in `#539` (filed 2026-07-14, step 9).
  1. Run the scenario: a file removed from `scripts/em-consolidate/` in the repo lingers
     in every consumer's global copy; `repoCompletenessFindings` emits only MISSING/DIFFER,
     never EXTRA-in-subtree (planner-confirmed by contract read).
  2. Spec check: §5 Non-Goals excludes pruning; deploy-audit is report-only by design
     (`tools/deploy-audit.mjs:24-27`); no MUST row requires pruning.
  3. History check: planner episode `…-31e3`; lesson `…540d` (EXTRA class exists at the
     whole-dir level in deploy-audit's mock-vs-real diff, which DOES flag real-global
     orphans — the residual is repo-deleted-but-mock-still-deploys never occurring, plus
     subtree-internal orphans on consumers who never re-run install).
  4. Same-class check: every current and future `GLOBAL_SCRIPT_SUBTREES` member equally
     affected; deferring the class together, no member left uniquely vulnerable.
  5. Residual risk: low — an orphan data file is never executed; recovery = manual prune
     after deploy-audit EXTRA flags it on re-deploy.

- **`buildInstallManifest` / `tools/migration-cutover.mjs` stay blind to subtrees** →
  deferred; tracked in `#531` closing comment (or new issue if reviewer insists).
  1. Run the scenario: cutover verifies manifest `.mjs` entries only; a subtree file
     never appears — confirmed by scout read of `tools/migration-cutover.mjs:33` usage.
  2. Spec check: no RFC row requires cutover to cover data subtrees; deploy-audit is the
     authoritative unfiltered check (its own header, `tools/deploy-audit.mjs:5-12`, says so).
  3. History check: lesson `…540d` created deploy-audit precisely because manifest checks
     are structurally blind; the sanctioned closure lives there.
  4. Same-class check: all subtree members (`second-opinion/`, `em-consolidate/`) equally
     not in cutover; REQ-4 covers the whole class via deploy-audit instead.
  5. Residual risk: cutover alone could report parity while a subtree is stale; graceful
     (deploy-audit catches it; cutover is only used for the checkpoint-marker migration gate).

## §18 Done Criteria

- [ ] All 6 MUST rows green (§4) with artifacts in §15.
- [ ] Existing suites green (`test-install-second-opinion-e2e`, `test-p12-global-clean`).
- [ ] Post-merge: global deploy re-run + `deploy-audit` CLEAN + 13-store sweep unchanged.
- [ ] Every deferred finding has an issue/comment artifact (Rule 18 step 9).

## §19 Review Consensus (Rule 18)

Negative-scenario-planner (pre-review): HOLD → amendments folded (§7); reply episode
`20260714-093850-plan-time-negative-scenario-audit-issue--31e3`. Re-walk satisfied by
this revision (Gap 1 → step 1.3 hoist; Gap 2 → steps 1.6a/1.7; Gap 3 → §17 DEFER).

```bash
node scripts/second-opinion.mjs request --provider codex --project /Users/charltondho/Developer/projects/episodic-memory \
  --storage episodic --body-file docs/plans/issue-531-scripts-subtree-deploy.md --summary "issue-531 plan review" --dispatch
```

Provider note: the codex harness dispatch on 2026-07-14 returned the seat's
SessionStart bootstrap prompt as its "reply" (episode `20260714-094235-…-9082`,
body = the y/n question — harness defect tracked in `#538`). Fallback per
§19: interactive pi/GLM-5.2 (neuralwatt) seat, full report at
`.review-store/issue-531-plan/glm-r1.md`.

| Pass | Reviewer | Provider/Model | Blocker count | Verdict | Reply artifact |
|---|---|---|---|---|---|
| 1 | GLM r1 (interactive seat) | pi/GLM-5.2 neuralwatt | 2 | HOLD-2 | `.review-store/issue-531-plan/glm-r1.md` |
| 2 | GLM r2 (delta re-review, same seat) | pi/GLM-5.2 neuralwatt | 0 | **ACCEPT** (all 4 resolutions verified RESOLVED; polarity ii traced by execution: throw fires, quarantine does not; N1 doc-drift residual fixed in this revision) | `.review-store/issue-531-plan/glm-r2.md` |

### 19.1 Resolved blockers

| # | Blocker | Verdict | Resolution + evidence |
|---|---|---|---|
| 1 | Classification throw inside the copy/quarantine try → spurious snapshot quarantine + false stderr under `--install-second-opinion`; §8.2 invariant inaccurate; path untested (GLM B3.3) | ACCEPT | Step 1.3 re-anchored to `let scriptFiles` (install.mjs:368, BEFORE `try`); §8.2/§8.3/§7/§12 reworded; `testUnclassifiedSubtreeFailsClosed` gains the `--install-second-opinion` polarity asserting no `/quarantining snapshot/` |
| 2 | Test-count inconsistency: §14 itemized 8 tests, plan said 7 and `7/7 pass` (GLM #2) | ACCEPT-WITH-MOD | Catalog restructured to 9 tests (the 9th, `testCompletenessSkipsSymlinks`, also resolves W3's vacuous-assertion finding); §14/§A.7 1.6/§A.8 all say 9/9 |
| W1 | Step 1.5 cosmetic sub-actions lacked anchors | ACCEPT | Split into 1.5 (anchored core), 1.5b (print loop, anchor `deploy-audit.mjs:132`), 1.5c (summary line) |
| W3 | Symlink-skip assertion vacuous at HEAD (zero symlinks under scripts/) | ACCEPT | Replaced with `testCompletenessSkipsSymlinks` on a synthetic fixture with a real injected symlink |

## §20 Lessons Encoded

| Lesson | One-line rule | Enforced in |
|---|---|---|
| `…540d` unfiltered audit | close the class in deploy-audit, not only the manifest | §4 REQ-4, §17 |
| `…7918` strong claim | E2E = mock-HOME + real install.mjs | §14 Group 1 |
| mock-project not mental-trace | copied-repo E2E for the fail-closed path | §14 `testUnclassifiedSubtreeFailsClosed` |
| red-then-green | completeness red control deletes a real deployed file | §14 `testRepoCompletenessRed` |
| validate-then-write | classify ALL before copying ANY | §8.2, §13 EC6 |
| compound-bash gate | one command per verify | §A.7 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value for this plan |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-install-scripts-subtrees.mjs` |
| New-function phrasing | `export function fnName(args)` / `export const NAME = […]` |
| Portable break-input override | not env-based: the red controls are self-contained test cases (copied repo / deleted mock file) |
| Search tool for verifies | `grep -c` / `grep -n` from the repo root |
| Repo-specific done-commands | `node tools/deploy-audit.mjs` (post-merge, local only) |

## A.1 Forbidden-phrase lint

Run `grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/issue-531-scripts-subtree-deploy.md` — every match must fall outside §A.5 blocks and §A.7 rows.

## A.2 Executor contract

Standard (template §A.2 items 1–9). Read-only references: `tests/lib/activation-scoping-harness.mjs`,
`tests/test-install-second-opinion-e2e.mjs`, `install.mjs` outside the two anchored spans.

## A.3 STOP-and-ask protocol — template verbatim.

## A.4 Pre-flight

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `feat/531-scripts-subtree-deploy` |
| Clean tree | `git status --porcelain` | empty (plan file committed separately by orchestrator) |
| Baseline green | `node tests/test-install-second-opinion-e2e.mjs` | all pass |
| Runtime | `node --version` | `v20+` |

## A.5 Shared constants

```js
export const GLOBAL_SCRIPT_SUBTREES = ['em-consolidate', 'second-opinion']
export const REPO_ONLY_SCRIPT_SUBTREES = ['scaffold-plugin']
```

## A.7 Step table — 531-S1

**Files this slice may touch:** `scripts/lib/install-manifest.mjs`, `install.mjs`,
`tools/deploy-audit.mjs`, `tests/lib/activation-scoping-harness.mjs`,
`tests/test-install-scripts-subtrees.mjs`.

| Step | File | Kind | Exact action | Verify (falsifiable) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4 | every row passes |
| 1.1 | `scripts/lib/install-manifest.mjs` | **APPEND** | At end of file add (verbatim): the §A.5 constants, then `classifyScriptSubtree(name)` implementing the §12 state table (4 returns, no throw), then `repoCompletenessFindings(repoDir, installedScriptsDir)` implementing §12: build expected list from `globalEntryScripts(repoDir)`, `globalScriptLibs(repoDir)` prefixed `lib/`, and a recursive regular-file walk (dirent `isFile()` only; recurse `isDirectory()`; skip others) of `path.join(repoDir,'scripts',s)` for each `s` of `GLOBAL_SCRIPT_SUBTREES` that exists; for each expected relative path `p`, finding iff `!fs.existsSync(path.join(installedScriptsDir, p))` OR bytes differ (`fs.readFileSync` buffer `.equals`); return sorted `scripts/`-prefixed paths | `grep -c "export function classifyScriptSubtree" scripts/lib/install-manifest.mjs` → 1 |
| 1.2 | `install.mjs` | **EDIT** | ANCHOR: `  activationSupportFiles,` → REPLACE: `  activationSupportFiles, classifyScriptSubtree,` | `grep -c "classifyScriptSubtree," install.mjs` → 1 |
| 1.3 | `install.mjs` | **EDIT** | (Planner Gap 1 hoist + GLM r1 B3.3 — classification precedes the FIRST write AND sits OUTSIDE the quarantine `try`.) ANCHOR: `let scriptFiles` (unique, install.mjs:368, immediately BEFORE `try {`) → REPLACE: a comment citing #531 fail-closed + never-quarantine, then `const scriptSubdirs = fs.readdirSync(REPO_SCRIPTS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)` and `for (const name of scriptSubdirs) { if (classifyScriptSubtree(name) === 'unclassified') throw new Error(\`scripts/${name}/ is not classified in install-manifest.mjs (add to GLOBAL_SCRIPT_SUBTREES or REPO_ONLY_SCRIPT_SUBTREES) — #531 fail-closed\`) }`, then the original line `let scriptFiles` unchanged. `scriptSubdirs` is declared in the OUTER scope so the 1.3b loop inside the try can read it | `grep -c "531 fail-closed" install.mjs` → 1 |
| 1.3b | `install.mjs` | **EDIT** | ANCHOR (verbatim lines from `  // scripts/second-opinion/ — pluggable second-opinion review harness subtree.` through the closing `  }` after `copyDirRecursive(REPO_SECOND_OPINION, soDst)`) → REPLACE with: comment `// scripts/<name>/ subtrees — classified in install-manifest.mjs (#531); 'global' copies recursively, 'repo-only' ships nowhere; unclassified already threw above (before any copy).` + `for (const name of scriptSubdirs) { if (classifyScriptSubtree(name) === 'global') copyDirRecursive(path.join(REPO_SCRIPTS, name), path.join(SCRIPTS_DIR, name)) }`. Do NOT touch `REPO_SECOND_OPINION` at line 91, `copyDirRecursive`, or the catch block | `grep -c "copyDirRecursive(REPO_SECOND_OPINION" install.mjs` → 0 |
| 1.4 | `tools/deploy-audit.mjs` | **EDIT** | ANCHOR: `import { mkMock, runInstall } from '../tests/lib/activation-scoping-harness.mjs'` → REPLACE: same line + newline + `import { repoCompletenessFindings } from '../scripts/lib/install-manifest.mjs'` | `grep -c "repoCompletenessFindings" tools/deploy-audit.mjs` → 2 (import + call after 1.5) — run after 1.5; interim expected 1 |
| 1.5 | `tools/deploy-audit.mjs` | **EDIT** | ANCHOR: `const drift = findings.missing.length + findings.differ.length + findings.extra.length` → REPLACE: `const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')` + newline + `findings.undeployed = repoCompletenessFindings(REPO_ROOT, path.join(M.home, '.episodic-memory', 'scripts'))` + newline + `const drift = findings.missing.length + findings.differ.length + findings.extra.length + findings.undeployed.length` | `node tools/deploy-audit.mjs --json` → JSON contains an `"undeployed"` array (pre-deploy it lists em-consolidate files — non-empty is the expected RED, proving the check bites; record observed) |
| 1.5b | `tools/deploy-audit.mjs` | **EDIT** | (GLM r1 W1 split.) ANCHOR: `  for (const k of findings.extra) console.log(\`  EXTRA    ${k}  (orphan — TRACE consumers before pruning)\`)` (unique, line 132) → REPLACE: same line + newline + `  for (const k of findings.undeployed) console.log(\`  UNDEPLOYED  ${k}  (repo file a clean install does not produce — installer gap)\`)` | `grep -c "UNDEPLOYED" tools/deploy-audit.mjs` → 2 (print loop + summary after 1.5c; interim 1) |
| 1.5c | `tools/deploy-audit.mjs` | **EDIT** | (GLM r1 W1 split.) ANCHOR: `  console.log(\`\nMISSING=${findings.missing.length}  DIFFER=${findings.differ.length}  EXTRA=${findings.extra.length}\` +` → REPLACE: `  console.log(\`\nMISSING=${findings.missing.length}  DIFFER=${findings.differ.length}  EXTRA=${findings.extra.length}  UNDEPLOYED=${findings.undeployed.length}\` +` | `grep -c "UNDEPLOYED=" tools/deploy-audit.mjs` → 1 |
| 1.6a | `tests/lib/activation-scoping-harness.mjs` | **EDIT** | (Planner Gap 2a.) ANCHOR: `export function runInstall({ home, project, callerCwd, flags = [], tool = 'claude-code', extraEnv = {} }) {` → REPLACE: `export function runInstall({ home, project, callerCwd, flags = [], tool = 'claude-code', extraEnv = {}, installerRepo = REPO_ROOT }) {`; and ANCHOR: `    path.join(REPO_ROOT, 'install.mjs'),` → REPLACE: `    path.join(installerRepo, 'install.mjs'),`. Two anchored spans, nothing else; default preserves every existing caller | `grep -c "installerRepo = REPO_ROOT" tests/lib/activation-scoping-harness.mjs` → 1 |
| 1.6 | `tests/test-install-scripts-subtrees.mjs` | **CREATE** | Full file: import `node:fs/path/os`, `mkMock, runInstall` from `./lib/activation-scoping-harness.mjs`, `classifyScriptSubtree, repoCompletenessFindings, GLOBAL_SCRIPT_SUBTREES` from `../scripts/lib/install-manifest.mjs`. Implement the 9 §14 tests. `testUnclassifiedSubtreeFailsClosed`: `fs.cpSync(REPO_ROOT, tmpRepo, { recursive: true, verbatimSymlinks: true, filter: (src) => !/\/(\.git|\.episodic-memory|\.review-store|\.worktrees|node_modules)(\/|$)/.test(src) })` (planner Gap 2b: `verbatimSymlinks` preserves the two tracked relative symlinks under `plugins/claude-code/hooks/lib/`); `fs.mkdirSync(path.join(tmpRepo,'scripts','aaa-unclassified-531'))`; write `x.txt`; polarity (i): `runInstall({ …mkMock fields, installerRepo: tmpRepo })`; assert `status !== 0`, combined stdout+stderr matches `/not classified in install-manifest\.mjs/` AND `/aaa-unclassified-531/`, `fs.existsSync(path.join(mockHome,'.episodic-memory','scripts','em-store.mjs')) === false`, and `fs.existsSync(path.join(mockHome,'.episodic-memory','scripts','second-opinion')) === false`; polarity (ii): second `mkMock` + `runInstall({ …, installerRepo: tmpRepo, flags: ['--install-second-opinion'] })`; assert `status !== 0`, output matches `/not classified in install-manifest\.mjs/` and does NOT match `/quarantining snapshot/` (GLM r1 B3.3). `testRepoCompletenessRed`: fresh mock install → `fs.rmSync(path.join(mock,'…','em-consolidate','prompts','clerk.md'))` → findings contains that path. `testCompletenessSkipsSymlinks`: synthetic fixture repo dir under `os.tmpdir()` with `scripts/em-consolidate/a.md` (content `SENTINEL_531a`) + `fs.symlinkSync('a.md', …/link.md)`; installed dir contains only `em-consolidate/a.md` same bytes; assert `repoCompletenessFindings(fixtureRepo, installedDir)` deep-equals `[]`. Byte-identity assertions use `fs.readFileSync(a).equals(fs.readFileSync(b))` against the REAL repo file (sentinel = live content, never a typed constant). Simple runner `main()` printing `N/N pass`, exit 1 on failure | `node tests/test-install-scripts-subtrees.mjs` → `9/9 pass` |
| 1.7 | — | — | Regressions (mandatory after the 1.6a harness edit) | `node tests/test-install-second-opinion-e2e.mjs` → all pass |
| 1.8 | — | — | Regressions (mandatory after the 1.6a harness edit) | `node tests/test-p12-global-clean.mjs` → all pass |

## A.8 Definition of done

```bash
node tests/test-install-scripts-subtrees.mjs      # 9/9 pass
node tests/test-install-second-opinion-e2e.mjs    # all pass
node tests/test-p12-global-clean.mjs              # all pass
grep -c "531 fail-closed" install.mjs             # 1 (invariant grep)
node tools/deploy-audit.mjs                       # post-merge only: CLEAN after re-deploy
```
