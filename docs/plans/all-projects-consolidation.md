# APC — All-Projects Central Consolidation Layer Plan

## §1 Status

Current stage: **approved** — planner round 1 (HOLD, folded) + codex round 1 (HOLD, folded);
operator pre-approved implementation and waived further plan rounds (2026-07-08, in-session).
Implementation deviation under the same grant: ONE branch/PR (`feat/all-projects-layer`)
instead of the 3-PR split.

| Field | Value |
|---|---|
| RFC | `n/a` (capability charter work — CAPABILITIES.md cross-store clause + experimental tier) |
| Parent requirements | CAPABILITIES.md "unifying invariant" cross-store clause; PRINCIPLES P1/P3/P6/P7/P9/P10/P12 |
| Workplan episode | `20260706-143551-workplan-v165-rfc-009-p1b-plan-authored--8edf` (queue re-ordered by handoff `20260708-073204-…-3ce6`: all-projects layer is NEXT) |
| Target branch | `feat/all-projects-layer` (PR-A); `feat/all-projects-fold` (PR-B); `feat/em-promote` (PR-C) |
| Executor altitude (§0.1) | **low** (default; Appendix A is the build path) |

## §2 Episode Search Summary

Commands run (2026-07-08, this session):

```bash
node scripts/em-search.mjs --tag workplan --category decision --limit 1 --scope all --full --no-score --no-track
node scripts/em-search.mjs --query "consolidate curation cross-project registry all projects" --scope all --limit 8 --no-track
```

Key active memories (verified against current main `5cdc45c` this session):

- `20260708-073204-…-3ce6` (handoff): all-projects layer = "em-stats/em-doctor/em-consolidate over
  the consumer registry; cross-project recurring-lesson promotion to global"; plan-worthy; read the
  just-amended PRINCIPLES/CAPABILITIES first. This plan's scope statement.
- `20260706-143551-…-8edf` (workplan v165): P1b awaits approval on a separate track; `--evidence`
  linkage (typed provenance) is NOT yet implemented → em-promote v1 cannot use it (→ §17-A DEFER).
- `20260705-090618-…-97a5` (violation, fourth-catch): a new data artifact needs its COMPLETE
  contract — shape, drift handling, derived-index behavior — at design time. Applied to the
  promoted-lesson episode artifact in §8.4.
- `20260509-061106-…-3260` (lesson, fixture-transitive-import drift): hermetic fixtures that stage
  real .mjs files must mirror transitive imports. Applied in §14: tests spawn the REAL repo scripts
  with explicit `cwd` + isolated `HOME`, never staged copies.
- `20260705-064947-…-9ac4` (lesson, three-legs design discipline): PRINCIPLES + CAPABILITIES read
  this session (see §3 P-citations); disposition sweep of ALL em-* scripts in §9b.
- `20260708-035412-…-8ff2` (lesson, wave-6): real-store probing found what fixtures could not →
  §15 includes a real-store dry-run smoke on top of hermetic tests.

## §3 Objective

Give the substrate a central, registry-driven view and maintenance path over EVERY registered
project store, not just cwd-local + global. Concretely: `em-stats --all-projects` and
`em-doctor --all-projects` report per-registered-store analytics/health from any cwd;
`em-consolidate --fold-superseded --all-projects` archives long superseded chains across all
registered stores with per-store R6 protection; a new EXPERIMENTAL `em-promote` detects lessons
recurring across ≥2 project stores and (on `--apply`) writes ONE derived global lesson episode per
recurrence, sources untouched. Provable by the §14 hermetic multi-store suites + §15 ledger.

**Charter grounding (three legs, run this session):**

- **CAPABILITIES.md** sanctions the scope: "A capability may operate over a single store or across
  many registered stores (discovery via the consumer registry at `~/.episodic-memory/installs.json`)"
  (unifying-invariant section). Stats/doctor/consolidate = **curation** family; em-promote =
  **learning** family ("derives new knowledge from episodes … writes it back as global episodes",
  default "none (opt-in)") shipped under the **experimental tier** (explicit opt-in, declared side
  effects, EXPERIMENTAL label, smoke test, decision date).
- **PRINCIPLES.md**: P1 (episodes stay the only data layer — the registry is an existing
  distribution-layer artifact, read-only here; no new store), P3/P10 (cross-project WRITES are
  consent-gated + reversible: fold is an archival move, `--confirm` required for multi-store real
  runs), P6 (manual opt-in commands, no background work, small JSON), P7 (promotion writes NEW
  episodes referencing sources; nothing mutated in place), P9 (core imports core lib only; no
  adapter knowledge), P12 (zero hooks, zero registrations; substrate stays hook-free — guarded by
  the existing `test-p12-global-clean.mjs`).

**Runtime evidence of the gap (fixture probe, this session, isolated HOME + 2 registered mock
projects):** from projA, `em-stats --scope all` returned only projA-local (2 episodes) + global
(0); projB's 2 episodes were invisible. `em-doctor --scope all` ran store checks only on
projA-local + global while its `installs-drift` check simultaneously saw "2 consumer project(s)"
— the registry is readable but store health/analytics do not follow it. From a neutral cwd,
totals were 0. Fixture driver: scratchpad `allproj-fixture.mjs`, output captured in-session.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | `resolveRegisteredStores({globalDir})` returns `[{project_path, data_dir, label, store_matches_project}]` for registry entries whose `project_path` exists; `data_dir` = `resolveLocalDir(project_path)` (the SAME resolution the substrate's spawned scripts use — planner B1), realpath'd when it exists; `store_matches_project` = (resolveLocalDir result equals the plain `join(project_path,'.episodic-memory')` AND realpath(data_dir) is contained under realpath(project_path)); deduped by realpath of `data_dir` (realpath BOTH sides — planner B5); entries whose `data_dir` realpath equals the global store dir are dropped; malformed/absent registry → `[]`; never throws | P1, CAPABILITIES cross-store clause; planner B1/B5 | `testResolveRegisteredStoresBasic`, `testResolveDedupesByRealpath`, `testResolveExcludesGlobalStore`, `testResolveMalformedRegistryEmpty`, `testResolveVanishedPathDropped`, `testResolveNonRootStoreFlagged` (git-nested + linked-worktree entries → `store_matches_project:false`), `testResolveSymlinkAliasDedupe` | MUST | realpath via `fs.realpathSync` with `path.resolve` fallback (mirrors `normalizeProjectPath`); resolution logic lives ONLY in this lib — consumers never re-derive (planner B1 refactor boundary) |
| REQ-2 | `em-stats --all-projects` appends one scope block per registered store (label `project:<basename>`, existing `dir` field disambiguates same-basename projects) after the `--scope`-selected blocks, skipping stores whose realpath equals the realpath of an already-included block's dir (realpath BOTH operands — planner B5: the `dir` field is observed to carry the UNRESOLVED path); totals include appended blocks; writes nothing anywhere | P6, curation family; planner B5 | `testStatsAllProjectsSeesForeignStore`, `testStatsAllProjectsSkipsDuplicateOfLocal` (same-spelling AND symlink-alias spelling: cwd store symlinked to a registered store), `testStatsAllProjectsReadOnly` (byte parity of foreign store before/after) | MUST | absent foreign store dir → block renders with zero counts (statsFor handles missing dir) |
| REQ-3 | `em-doctor --all-projects` runs the store-class checks (`checkStore`) once per registered store with scope `project:<basename>` AND a `data_dir` field on every such check row (codex CX1: the label is display-only and non-unique; `data_dir` is the identity downstream consumers key on); exit-code semantics unchanged (errors → 1); non-store checks (gate-friction, installs-drift, installed-scripts, backup, drafts) run exactly once | curation family; codex CX1 | `testDoctorAllProjectsChecksForeignStore`, `testDoctorAllProjectsForeignCorruptIndexExits1`, `testDoctorAllProjectsSingletonChecks` | MUST | foreign store with malformed index.jsonl must surface as `error` + exit 1 |
| REQ-4 | `em-doctor --all-projects --fix` repairs a foreign store by spawning `em-rebuild-index.mjs --scope local` with `cwd = <that project_path>` ONLY for entries with `store_matches_project:true`; fix routing is keyed by the check row's `data_dir` (realpath identity), NEVER by the `project:<basename>` scope label (codex CX1: the current fix loop at `em-doctor.mjs:561-581` keys `rebuildScopes` by scope name — two same-basename projects with rebuildable findings would collide/merge under a label key); mismatched entries (git-nested, linked-worktree — planner B1 runtime evidence) are reported `skipped: non-root-store` and never spawned; re-verify re-runs `checkStore` on the resolved dir and the test asserts ON DISK which store's index changed | curation family; planner B1; codex CX1 | `testDoctorAllProjectsFixRebuildsForeignIndex` (disk-location assertion), `testDoctorFixSkipsNonRootStore`, `testDoctorFixSameBasenameProjects` (two registered projects named `app`, both with rebuildable corruption → BOTH stores rebuilt, disk-asserted) | MUST | non-git fixture project resolves its own local store (local-dir cwd fallback — probe-confirmed) |
| REQ-5 | `em-consolidate --fold-superseded --all-projects` iterates registered stores with `store_matches_project:true` (others `skipped: non-root-store`); the R6 protection scan loads rows ONCE as the UNION of cwd-local + global + ALL registered stores (planner B3: a valid referencer in a third store must protect — probe confirmed cross-store protection is live behavior), passing realpath(data_dir) as each `storeLabel` (planner B4: `computeProtectedIds` class-d keys `latestByStore` by `_store`; basename labels merge colliding stores and silently unprotect); a protected chain member in any iterated store is never archived | P10, RFC-009 R6 protection invariant; planner B3/B4 | `testFoldAllProjectsArchivesForeignChain`, `negative: testFoldAllProjectsHonorsForeignProtection` (referencer in a THIRD store; asserts FULL chain-closure keep — member count + both `r6-protected:*` and `chain-member` reasons, planner M1: one anchor kept while 10 closure members archived must FAIL the test), `testFoldProtectionLabelIsRealpath` (basename-colliding fixture) | MUST | this is the §7-C1 trust-boundary row; single-store fold behavior unchanged (existing `test-fold-superseded.mjs` stays green) |
| REQ-6 | `--all-projects` without `--fold-superseded` on em-consolidate, or combined with `--scope`, exits 2 with a JSON usage error; a real (non-`--dry-run`) `--all-projects` fold requires `--confirm` (absent → exit 2, nothing written) | P3, P10 | `testFoldAllProjectsRequiresFoldMode`, `testFoldAllProjectsScopeConflict`, `negative: testFoldAllProjectsRealRunNeedsConfirm` | MUST | fail-closed: the guard fires BEFORE any archive move |
| REQ-7 | `em-promote` (dry-run default) lists candidate clusters: active canonical-`lesson` episodes with token-set Jaccard ≥ `--min-sim` (default 0.35) spanning ≥2 DISTINCT registered project stores; replica collapse BEFORE clustering requires id AND summary equality (codex CX2: episode ids are not proven globally unique across independent stores — a coincident id with DIFFERENT content stays two distinct members, never silently collapsed); single-store clusters never listed | learning family; planner M4; codex CX2 | `testPromoteFindsCrossStoreRecurrence`, `testPromoteIgnoresSingleStoreCluster`, `testPromoteSkipsReplicaMembers` (id+summary match collapses), `testPromoteSameIdDifferentContentStaysDistinct` | MUST | tokens via `episodeTokens` (summary+tags+body), same vocabulary as em-consolidate |
| REQ-8 | `em-promote --apply` writes ONE global episode per candidate by spawning the sibling `em-store.mjs` with `--scope global --category lesson --tags <union>,promoted-lesson,promoted:<sha8> --body-file <tmp>` where `<sha8>` = first 8 hex of sha256 over the newline-joined SORTED list of member keys `<id>#<sha8(summary)>` (codex CX2: content-qualified so a coincident-id forgery cannot alias another cluster's identity; stable across store relocation because the summary travels with the immutable episode — episode files are never edited, revisions mint NEW ids); body carries a `## Sources` section listing each member `id`, `project`, and store dir; source stores byte-identical before/after | P7, learning family; codex CX2 | `testPromoteApplyWritesGlobalEpisode`, `testPromoteApplyBodyCarriesSources` (sentinel id asserted in written episode file), `negative: testPromoteNeverWritesSourceStores` (foreign index.jsonl byte-parity) | MUST | spawn `process.execPath` + sibling script path; `--body-file` per body-file lesson |
| REQ-9 | `em-promote` idempotency keys on SOURCE IDENTITY, never similarity (planner B2: runtime probe measured Jaccard(member, minimal 2-member digest) = 0.255 — the digest is a token superset and similarity DILUTES with cluster size, so a similarity threshold re-promotes unboundedly): a candidate whose `promoted:<sha8>` tag matches any ACTIVE global episode's tag is skipped, reported `skipped: already-promoted`; re-running `--apply` twice writes zero new episodes on the second run; a candidate whose member set strictly contains an already-promoted set has a DEFINED disposition: promote (new hash) with the prior digest id named in `## Sources` under `Supersedes-promotion:` | P6, §8.4 drift contract; planner B2 | `testPromoteApplyIdempotent` (hash-keyed; runs twice, asserts 0 new episodes AND 0 new files in global episodes/), `testPromoteSupersetClusterPromotesWithBackref` | MUST | no `--dedupe-sim` flag ships (similarity dedupe removed from the contract entirely) |
| REQ-10 | `em-promote --help` and its file header carry `EXPERIMENTAL` + promote-or-remove decision date `2026-10-08`; dry-run is the default; `--apply` is the only write path | P5, CAPABILITIES experimental tier | `testPromoteHelpCarriesExperimental`, `manual: node scripts/em-promote.mjs --help` | MUST | tier honesty is a charter criterion, hence MUST |
| REQ-11 | New script + flags deploy with ZERO installer/dispatcher edits: `em-promote.mjs` appears in `globalEntryScripts()` output and `em promote --help` dispatches | P9, distribution layer | `testPromoteIsSubstrateScript` (imports `isSubstrateScript`, asserts true), `manual: node scripts/em.mjs promote --help` | SHOULD | auto-enumeration verified at `install-manifest.mjs:202-205` this session |
| REQ-12 | All multi-store behavior is proven under isolated `HOME` (fixtures never touch the operator's real stores); every new suite registers in `.github/workflows/plan-marker-validate.yml` | repo test conventions | suite files themselves + `grep -c "test-registered-stores\|test-all-projects-observability\|test-fold-all-projects\|test-em-promote" .github/workflows/plan-marker-validate.yml` → 4 (codex CX3: the proof grep must name ALL FOUR suites — the earlier spelling omitted the fold suite, the riskiest write path) | MUST | registration is the check-actual-CI lesson (`gh pr checks` verifies at PR time) |
| REQ-13 | Governing MD files reflect the shipped capability: CAPABILITIES.md learning-strategy row names `em-promote (experimental)`; curation-family text names the `--all-projects` cross-store operation; EM_SCRIPTS_GUIDE.md documents the new flags + script | user instruction 2026-07-08; Rule 10/11 | `grep -n "em-promote" CAPABILITIES.md docs/EM_SCRIPTS_GUIDE.md` → ≥1 match each; docs index files checked per Rule 10 at build time | MUST | user instruction this session: "ensure new capabilities reflect in the MD files" |
| REQ-14 | Cross-platform: no shell string interpolation for paths; spawns use `process.execPath` + argv arrays; all path math via `path`; fixtures via `os.tmpdir()`-safe scratch or test-owned dirs | cross-platform rule | code review + `grep -n "execSync(" <new files>` → 0 matches | MUST | registry paths may contain spaces |

## §5 Non-Goals

- Cluster-mode (similarity digest) consolidation across foreign stores — fold-superseded only.
  Digest writing into another project's store changes that store's semantics beyond a reversible
  archival move; revisit after fold burn-in.
- Typed provenance field (`promoted_from` / `--evidence`) on promoted episodes — deferred to
  RFC-009 P1b's linkage flags (§17-A).
- Scheduling (`em-routines` integration for a periodic all-projects doctor) — §17-B.
- Any enforcement/hook surface. This layer is substrate + one adjacent-layer read (registry).
- Registry schema changes. `installs.json` is read as-is.
- `em-prune`/`em-search`/`em-recall` cross-store variants — out of scope; fold + stats + doctor +
  promote are the charter-named set for this layer.

## §6 Token Budget (Rule 12)

`wc -l` run this session (main @ `5cdc45c`):

| File | `wc -l` | Reads (×~5) | Writes (est) | Notes |
|---|---|---|---|---|
| `scripts/em-stats.mjs` | 180 | 900 | ~30 lines | flag + loop |
| `scripts/em-doctor.mjs` | 598 | 3,000 | ~50 lines | flag + loop + fix map |
| `scripts/em-consolidate.mjs` | 521 | 2,600 | ~80 lines | fold-mode iteration + guards |
| `scripts/lib/install-version.mjs` | 614 | partial ~1,200 | 0 | import surface only |
| `scripts/lib/relevance.mjs` | 418 | partial ~1,000 | 0 | episodeTokens/loadIndex |
| `scripts/lib/protection.mjs` | 149 | 750 | 0 | read-only |
| `scripts/lib/local-dir.mjs` | 72 | 360 | 0 | read-only |
| `scripts/em-capture.mjs` | 481 | partial ~800 | 0 | spawn-em-store precedent |
| NEW `scripts/lib/registered-stores.mjs` | — | — | ~70 lines | |
| NEW `scripts/em-promote.mjs` | — | — | ~240 lines | |
| NEW tests (4 suites) | — | — | ~750 lines | hermetic HOME fixtures |
| `.github/workflows/plan-marker-validate.yml` | ~290 | 400 | ~12 lines | 4 run steps |
| `CAPABILITIES.md` | 163 | 815 | ~10 lines | |
| `docs/EM_SCRIPTS_GUIDE.md` | 945 | partial ~600 | ~60 lines | |

**Baseline (single session, all three PRs):** ~38k overhead + ~13k reads + ~35k writes/iteration +
review cycles ≈ **~110–130k** — autocompact-risk band.
**Optimized (3 sessions, one PR each):** PR-A ~60k, PR-B ~50k, PR-C ~60k. **DEFAULT = 3 sessions**;
a single session is acceptable only if context stays under 110k at PR-A completion.

## §7 Safety / Security

Canonical planner note: `negative-scenario-planner` dispatch happens as Rule 18 step 2 leg 1
(§19); the matrix below is the plan-author pass it will audit.

| Concern | Severity | Attack/abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| C1: fold archives protected episodes in a foreign store | High | fold runs from repo X against project Y; protection scan reads X-local + global (current code `em-consolidate.mjs:148-152`), missing Y's — or a THIRD registered store's (planner B3) — evidence-linked rows → protected episode archived | protection rows loaded ONCE as the union of cwd-local + global + ALL registered stores, `storeLabel` = realpath(data_dir) (planner B4) | `negative: testFoldAllProjectsHonorsForeignProtection` — third-store referencer; full chain-closure keep asserted (planner M1) |
| C2: poisoned registry path drives writes outside a store | Med | hand-edited `installs.json` entry `project_path: "/"`, a path whose `.episodic-memory` is a symlink into unrelated data, or a git-nested/worktree path whose substrate-resolved store is a DIFFERENT directory than the plain join (planner B1: spawned scripts resolve via git, observed writing the git root's store) | write ops run only for `store_matches_project:true` entries (resolveLocalDir result == plain join AND realpath(data_dir) contained under realpath(project_path)); mismatches → `skipped: non-root-store`; a `data_dir` without `index.jsonl` is skipped for WRITE operations (read ops render empty blocks) | `negative: testFoldSkipsSymlinkEscapeStore` — symlinked store dir pointing at a victim dir: victim byte-identical after real fold run; `testDoctorFixSkipsNonRootStore`, `testResolveNonRootStoreFlagged` |
| C3: multi-store real fold fires unconfirmed | Med | operator habit-runs the single-store fold spelling with `--all-projects`; N stores archived at once | `--all-projects` fold real run requires `--confirm` (exit 2 before any move otherwise); dry-run needs no confirm | `negative: testFoldAllProjectsRealRunNeedsConfirm` — asserts exit 2 AND all stores byte-identical |
| C4: promote writes into source project stores | Med | a bug routes the em-store spawn at local scope of an iterated project | spawn args pin `--scope global`; spawn `cwd` = a neutral dir (the global dir), so even a scope regression cannot resolve a project-local store | `negative: testPromoteNeverWritesSourceStores` — byte-parity on every fixture project store after `--apply` |
| C5: concurrent invocations tear a foreign index | Low | two fold runs hit the same store | same exposure as the existing single-store fold (temp+rename per file; no cross-file transaction). Not worsened by this plan; residual documented in §16 | existing atomic-write pattern; `testFoldAllProjectsArchivesForeignChain` asserts index parses post-run |
| C6: registry read makes substrate depend on distribution layer | Low | import cycle / adapter knowledge leaking into core (P9) | `registered-stores.mjs` imports only `install-version.mjs` (scripts/lib, core) + node stdlib; behavior with NO registry present = today's behavior (flags simply find zero stores) | `testResolveMalformedRegistryEmpty`; `grep -n "adapters/" scripts/lib/registered-stores.mjs scripts/em-promote.mjs` → 0 |

Path-authority note (8-axis pre-enumeration for C2): the only new path predicate is "is
`data_dir` inside `project_path`". Axes: (1) `project_path` symlink → realpath'd by
`normalizeProjectPath`; (2) `data_dir` symlink → realpath'd before containment; (3) macOS
`/var`→`/private/var` → both sides realpath'd, comparison on canonical forms; (4) case-insensitive
FS → containment via `path.relative` not string prefix; (5) trailing separators → `path.resolve`;
(6) `project_path` vanished → dropped by REQ-1; (7) `data_dir` is a file not a dir → skipped;
(8) UNC/Windows drive split → `path.relative` returns non-`..` only for same-root. No
`import.meta.url`/isMain authority decisions are added (new lib has no main mode; em-promote's
CLI entry is unconditional like every sibling em-* script).

## §8 Design

### 8.1 Key types

```js
/**
 * @typedef {Object} RegisteredStore
 * @property {string} project_path — realpath of the registry entry's project
 * @property {string} data_dir — resolveLocalDir(project_path), realpath'd when it exists —
 *   the store the substrate's OWN scripts resolve for that project (planner B1), not a naive join
 * @property {string} label — "project:<basename(project_path)>" (DISPLAY only; identity is
 *   realpath(data_dir) everywhere a key/bucket/comparison is needed — planner B4/B5)
 * @property {boolean} store_matches_project — resolveLocalDir == plain join AND realpath(data_dir)
 *   contained under realpath(project_path); false for git-nested and linked-worktree entries;
 *   WRITE consumers (fold, doctor --fix) require true, READ consumers include either way
 */

/**
 * @typedef {Object} PromoteCandidate
 * @property {Array<{id: string, project: string, store: string, summary: string}>} members
 * @property {string[]} store_dirs — distinct data_dirs spanned (length >= 2 by construction)
 * @property {number} linked_pair_similarity_avg
 * @property {"candidate"|"already-promoted"} disposition
 */
```

### 8.2 Key invariants

- **Read/write asymmetry:** stats/doctor(no fix)/promote read foreign stores; ONLY fold and
  doctor `--fix` write them, and both are reversible-class (archive move / index rebuild).
- **Identity is `data_dir` realpath**, never label or registry order; dedupe happens once in the lib.
- **Global store is never an iterated "project" store** (REQ-1 exclusion) — prevents double
  counting and prevents fold treating global as a foreign project.
- **Promote writes global-only, via the em-store subprocess contract** (em-capture precedent:
  never hand-written episode files) — derived indexes (tags.json, category-index, tokens.json)
  stay consistent because em-store owns them.
- **Cross-platform:** `path` module everywhere; spawns are `spawnSync(process.execPath, [script,
  ...args], {cwd, env})`; no shell.
- **Atomicity:** unchanged mechanisms — fold reuses the existing per-store temp+rename writes;
  promote's only write is em-store's own atomic append.

### 8.3 Resolution / flow

```text
registry (installs.json)
  → readRegistry (existing, degrade-not-throw)
  → resolveRegisteredStores: filter existing → realpath → dedupe → exclude global dir
  → per consumer:
      em-stats:        statsFor(data_dir, "project:<base>")          [read]
      em-doctor:       checkStore(data_dir, "project:<base>")        [read; --fix spawns rebuild cwd=project]
      em-consolidate:  fold(data_dir) with protection(store+global)  [write, --confirm-gated]
      em-promote:      loadIndex(data_dir) → cross-store clusters → em-store --scope global [read; --apply writes global]
```

### 8.4 Promoted-lesson data-artifact contract (fourth-catch lesson `…97a5`; #22 rows per planner M2)

- **Shape:** a normal global `lesson` episode. Tags = union of member tags + `promoted-lesson` +
  `promoted:<sha8>` (identity hash over sorted member ids, REQ-8). Project field = `cross-project`.
  Summary = `Recurring lesson: <terminal member's summary>`. Body = generated header line, one
  `## <summary>` section per member (id, project, store dir, body excerpt ≤ 40 lines), closing
  `## Sources` list (per-member `id`, `project`, store dir; optional `Supersedes-promotion:` line).
- **Schema + validator (#22 row 1):** frontmatter validated by em-store (the only sanctioned
  writer); the body convention is validated by em-promote itself at read time (see drift row).
- **Versioning/deprecation (#22 row 2):** the `promoted-lesson`/`promoted:<sha8>` tag convention
  and the `cross-project` sentinel are EXPERIMENTAL-tier surface with the same decision date
  (2026-10-08): P1b typed provenance retires them (migration = one re-tag sweep, tracked in the
  §17-A issue). Waived beyond that under the experimental clause — explicitly, not silently.
- **All writers + validation symmetry (#22 row 3):** em-promote-via-em-store is the sanctioned
  writer. Hand-written episodes carrying `promoted-lesson` are tolerated inputs (recall surfaces
  them like any lesson) but CANNOT collide with idempotency: dedupe keys on `promoted:<sha8>`,
  which hand-written rows lack unless deliberately forged — a forged hash tag is an operator
  self-inflicted skip, reported in dry-run output (`skipped: already-promoted` names the episode).
- **Drift detection (#22 row 4):** `em-promote` (dry-run and `--apply`) scans existing active
  `promoted-lesson` global episodes and reports a `warnings` array for any with absent/malformed
  `## Sources` or a `promoted:` tag that fails the sha8 shape — mechanical detection; correction
  flows through em-revise (P7). Sources later archived/superseded do NOT invalidate the episode
  (derived knowledge); identity-hash dedupe (REQ-9) makes source drift unable to duplicate
  promotions.
- **Derived lookup (#22 row 5):** tags.json serves both tags (probe-observed em-search hit); no
  new index.
- **Size/retention (#22 row 6):** member excerpts ≤ 40 lines; digest count bounded by REQ-9
  identity dedupe; promoted episodes are prunable/consolidatable like any global episode
  (curation family owns retention).
- **Conformance (#22 row 7):** §14 Group 4 (now 11 tests) covers every row above.

## §9 Existing Hook Points

Verified this session at main `5cdc45c`:

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `scripts/lib/install-version.mjs` | 58, 67-69, 326-342 | `REGISTRY_BASENAME`, `registryPath()`, `readRegistry()` degrade-not-throw | imported by new lib; untouched |
| `scripts/em-stats.mjs` | 76, 168-170 | `statsFor(dataDir, label)`; scope loop | append registered-store blocks after existing loop |
| `scripts/em-doctor.mjs` | 111, 549-555 | `checkStore(dataDir, scopeName)`; run sequence | add registered-store loop beside existing calls |
| `scripts/em-doctor.mjs` | 561-581 | `--fix` maps scope→dir for `local`/`global` only | extend map: `project:*` scopes → spawn rebuild with `cwd = project_path` |
| `scripts/em-consolidate.mjs` | 107, 128-285 | fold mode fixed to one `DATA_DIR`; protection rows read LOCAL_DIR + GLOBAL_DIR (148-152) | extract fold body into a per-store function; per-store protection rows |
| `scripts/em-consolidate.mjs` | 98-101 | scope validation | add `--all-projects` mutual-exclusion + `--confirm` guard |
| `scripts/lib/install-manifest.mjs` | 202-205 | `isSubstrateScript` auto-classifies `em-*.mjs` | zero change; REQ-11 asserts it |
| `scripts/em.mjs` | 19-21, 71-72, 127 | directory-driven dispatch | zero change |
| `.github/workflows/plan-marker-validate.yml` | 226, 238, 259 area | substrate suite block | add 4 run steps |
| `CAPABILITIES.md` | 39 (learning row), 70-83 (invariant) | learning default "none (opt-in)" | name `em-promote (experimental)`; note shipped cross-store ops |
| `docs/EM_SCRIPTS_GUIDE.md` | (per-script sections) | documents each em-* script | add flags + em-promote section |

## §9b Disposition sweep — ALL em-* scripts (current main `5cdc45c`)

**CHANGED:** `em-stats.mjs` (flag), `em-doctor.mjs` (flag + fix map), `em-consolidate.mjs`
(fold iteration + guards), NEW `em-promote.mjs`, NEW `scripts/lib/registered-stores.mjs`.

**INTERACTS (verified, no edits):**

| Script | Interaction | Disposition |
|---|---|---|
| `em-store.mjs` | promote's write path (subprocess, `--scope global`, `--body-file`) | UNCHANGED — existing flags suffice (verified: no provenance flag exists; §17-A) |
| `em-rebuild-index.mjs` | doctor `--fix` spawns it per foreign store with explicit cwd | UNCHANGED |
| `em-prune.mjs` | shares `protection.mjs` + archive mechanism with fold | UNCHANGED — protection lib reused read-only |
| `em-restore.mjs` | reversibility path for fold archives (per store) | UNCHANGED — operates per store dir already |
| `em-search.mjs` / `em-list.mjs` / `em-recall.mjs` | surface promoted global lessons via normal recall; `--history` unaffected (fold semantics unchanged) | UNCHANGED |
| `em-capture.mjs` | precedent: draft-then-em-store spawn pattern; promote copies the spawn contract, not the draft store | UNCHANGED |
| `em-move.mjs` | scope-relocation sibling; NOT used by promote (promotion derives, never moves) | UNCHANGED |
| `em-sync-install.mjs` | registry co-reader (same `readRegistry`) | UNCHANGED |
| `em-routines.mjs` | future scheduling host for all-projects doctor (§17-B) | UNCHANGED |
| `em-revise.mjs` | correction path for promoted episodes (P7) | UNCHANGED |
| `em.mjs` | auto-dispatches `em promote` | UNCHANGED (REQ-11 asserts) |

**UNCHANGED (no interaction beyond shared libs):** `em-audit-compliance`, `em-backup`,
`em-check-stale`, `em-embed`, `em-feedback`, `em-graph`, `em-lock`, `em-mine-transcripts`,
`em-pattern-health`, `em-pin`, `em-review-request`, `em-rfc-validate`, `em-seed-patterns`,
`em-semantic`, `em-session-end-prompt`, `em-violation`, `em-watch-codex`,
`em-workflow-validate`.

## §10 Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops (do NOT do in this slice) |
|---|---|---|---|---|---|
| APC-S1 | registered-stores lib | `scripts/lib/registered-stores.mjs`, `tests/test-registered-stores.mjs` | REQ-1 lib + 7 tests | 7 | no consumer edits |
| APC-S2 | stats flag | `scripts/em-stats.mjs`, `tests/test-all-projects-observability.mjs` | REQ-2 | 3 | no doctor edits |
| APC-S3 | doctor flag + fix | `scripts/em-doctor.mjs`, `tests/test-all-projects-observability.mjs` | REQ-3, REQ-4 | 7 | no consolidate edits |
| APC-S4 | fold cross-store | `scripts/em-consolidate.mjs`, `tests/test-fold-all-projects.mjs` | REQ-5, REQ-6 + C1-C3 negatives | 8 | no cluster-mode changes |
| APC-S5 | em-promote (experimental) | `scripts/em-promote.mjs`, `tests/test-em-promote.mjs` | REQ-7–REQ-11 + C4 negative | 12 | no schema/frontmatter additions |
| APC-S6 | MD reflection + CI registration | `CAPABILITIES.md`, `docs/EM_SCRIPTS_GUIDE.md`, `.github/workflows/plan-marker-validate.yml` | REQ-12, REQ-13 | grep checks | no principle-text rewrites (clarification tier only if needed) |

### 10.1 Dependency graph

```text
S1 ── S2 ── S3          (PR-A: read-only observability; S6 doc rows for these ride PR-A)
 └─── S4                (PR-B: fold; hard dep on S1)
 └─── S5 ── S6          (PR-C: promote + charter reflection; S5 hard-deps S1)
```

Hard deps: S1 before everything; S6's CAPABILITIES row lands with S5 (a charter naming an
unshipped script would be dishonest, P5). Each PR registers its own CI steps in the same PR.

## §11 Cut Order

1. S5/S6 promote (PR-C) — observability + fold still ship whole.
2. S4 fold (PR-B) — observability alone still closes the "no central view" gap.
3. Doctor `--fix` for foreign stores (REQ-4) — report-only doctor still lands.

Do **not** cut:

- REQ-5 per-store protection scan (shipping fold without it archives protected episodes).
- REQ-6 confirm gate.
- REQ-13 MD reflection for whatever DID ship (user instruction).

## §12 Contracts

### `resolveRegisteredStores({ globalDir }) → RegisteredStore[]`

**Input contract:** `globalDir` = absolute path of the global data dir (default
`path.join(os.homedir(), '.episodic-memory')`).
**Output contract:** array (possibly empty), never null, never throws; order = registry sort
(project_path asc); every `data_dir` exists→realpath'd or is the plain join when the dir does not
exist yet (read consumers render empty stores; write consumers skip via their own guards).

**State table (exhaustive):**

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. no registry file | `installs.json` absent | `[]` | none |
| B. malformed registry | unparseable / non-object / no `entries[]` | `[]` (readRegistry's stderr note fires) | stderr note only |
| C. entry path vanished | `!fs.existsSync(project_path)` | entry dropped | none |
| D. duplicate project, two tools | same realpath twice | one RegisteredStore | none |
| E. entry resolves to global store | realpath(data_dir) === realpath(globalDir) | entry dropped | none |
| F. store dir absent under live project | project exists, resolved store dir absent | included, `data_dir` = resolveLocalDir result (unrealpath'd), `store_matches_project` per definition | none |
| G. happy path (git root or plain dir) | live project + store, resolution == plain join, contained | included, realpath'd, `store_matches_project:true` | none |
| H. git-nested / linked-worktree entry | resolveLocalDir(project_path) ≠ plain join | included, `store_matches_project:false` (write consumers skip + report `non-root-store`) | none |
| I. symlinked `.episodic-memory` escaping project | realpath(data_dir) not under realpath(project_path) | included, `store_matches_project:false` | none |

**Error codes:** none — the lib never exits; consumers own exit codes.

### `em-consolidate --fold-superseded --all-projects` (CLI contract additions)

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. `--all-projects` without `--fold-superseded` | cluster mode | `{status:"error"}` exit 2 | none |
| B. `--all-projects` + `--scope` | both flags | `{status:"error"}` exit 2 | none |
| C. `--all-projects --dry-run` | any registry state | `{status:"ok", mode:"fold-superseded", all_projects:true, stores:[{project_path, chains, folded_total, …}]}` exit 0 | none |
| D. `--all-projects` real run, no `--confirm` | would-fold ≥ 0 | `{status:"error"}` naming `--confirm` exit 2 | **none — guard precedes any move** |
| E. `--all-projects --confirm` real run | per-store fold over `store_matches_project:true` entries | per-store report blocks; skips (`non-root-store`, no index.jsonl) reported per store | archive moves per store |
| F. zero registered stores | empty lib result | `{status:"ok", stores:[], folded_total:0}` exit 0 | none |

Fail direction: every guard (A, B, D, C2 symlink escape) fails **closed** — error/skip before write.

### `em-promote [--min-sim <f>] [--apply]`

(codex CX5: no `--limit` flag ships — it was advertised without ordering/apply semantics; removed
rather than specified. Candidate output order is deterministic: sorted by promoted-hash asc.)

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. <2 registered stores | lib returns 0–1 stores | `{status:"ok", candidates:[], note:"needs >=2 registered stores"}` exit 0 | none |
| B. dry-run (default) | candidates found | `{status:"ok", dry_run:true, candidates:[…], warnings:[…]}` exit 0 | none |
| C. `--apply`, fresh candidates | ≥1 candidate with unseen `promoted:<sha8>` | per-candidate em-store spawn; `{status:"ok", promoted:[{digest_id, members}]}` exit 0 | global episodes written |
| D. `--apply`, all deduped | every candidate's hash tag already on an active global episode | `{status:"ok", promoted:[], skipped:[{reason:"already-promoted", existing:<id>}]}` exit 0 | none |
| E. em-store spawn fails | non-zero child exit | candidate reported `{error}`; remaining candidates continue; final exit 1 | partial (each write atomic via em-store) |
| F. invalid `--min-sim` | outside (0,1] | `{status:"error"}` exit 2 | none |
| G. replica members (planner M4 + codex CX2) | same episode id AND same summary present in ≥2 stores | replicas collapse to one member pre-clustering; a cluster left spanning <2 stores drops; same id with DIFFERENT summary stays two members | none |
| H. superset cluster (planner B2 boundary) | member set strictly contains an already-promoted set | promoted (new hash), `Supersedes-promotion:` back-ref in Sources | global episode written |
| I. malformed existing promoted episode | absent/malformed `## Sources` or bad hash-tag shape | listed in `warnings`; never blocks | none |

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | empty/absent registry | all flags degrade to today's behavior; promote exits 0 with note | `testResolveMalformedRegistryEmpty`, promote state A |
| EC2 | symlinked `data_dir` escaping `project_path`; macOS `/var`→`/private/var` | realpath both sides; escape → write ops skip + report, read ops still realpath-dedupe | `testFoldSkipsSymlinkEscapeStore` |
| EC3 | two registry entries, same store, different tools | one iteration (realpath dedupe) | `testResolveDedupesByRealpath` |
| EC4 | registered store == cwd-local store | stats/doctor skip the duplicate block | `testStatsAllProjectsSkipsDuplicateOfLocal` |
| EC5 | registered project_path == `$HOME` (data_dir == global store) | dropped by REQ-1 exclusion | `testResolveExcludesGlobalStore` |
| EC6 | foreign store corrupt (malformed index.jsonl) | doctor errors + exit 1; stats renders what parses (loadIndex behavior); fold skips store with report | `testDoctorAllProjectsForeignCorruptIndexExits1` |
| EC7 | promote candidate where all members share ONE store | not a candidate (cross-store means ≥2 distinct data_dirs) | `testPromoteIgnoresSingleStoreCluster` |
| EC8 | `--apply` re-run after success | zero new episodes (identity-hash dedupe, planner B2) | `testPromoteApplyIdempotent` |
| EC11 | registered project_path is git-nested or a linked worktree | `store_matches_project:false`; reads render the RESOLVED store; writes skip + report | `testResolveNonRootStoreFlagged`, `testDoctorFixSkipsNonRootStore` |
| EC12 | two registered projects share a basename | protection buckets keyed by realpath, not label (planner B4) | `testFoldProtectionLabelIsRealpath` |
| EC13 | cwd-local store is a symlink alias of a registered store | one block, not two (realpath both sides, planner B5) | `testStatsAllProjectsSkipsDuplicateOfLocal` (alias spelling) |
| EC14 | clone/fork stores carrying identical episode ids | replicas are one member; not a recurrence by themselves (planner M4) | `testPromoteSkipsReplicaMembers` |
| EC9 | validate-then-write ordering (confirm gate, symlink guard) | guard exits BEFORE first archive rename | `negative: testFoldAllProjectsRealRunNeedsConfirm` |
| EC10 | foreign store locked/mid-write `.tmp` present | fold unaffected (reads index.jsonl as-is); doctor's tmp-litter check reports it per store | covered by `testDoctorAllProjectsChecksForeignStore` fixture |

(EC5-template row from PLAN_TEMPLATE — empty/whitespace identity diff — instantiates here as the
byte-parity negatives: parity is computed over non-empty captured file bytes, and each parity test
asserts the fixture file is non-empty before comparing.)

## §14 Test Case Catalog

```text
Group 1: registered-stores lib (7) — tests/test-registered-stores.mjs
  testResolveRegisteredStoresBasic — 2 live entries → 2 stores, realpath'd, labeled
  testResolveDedupesByRealpath — same project via symlink + plain path → 1 store
  testResolveExcludesGlobalStore — entry at $HOME → dropped
  testResolveMalformedRegistryEmpty — garbage installs.json → []
  testResolveVanishedPathDropped — nonexistent project_path → dropped
  testResolveNonRootStoreFlagged — git-nested + linked-worktree entries → store_matches_project:false, resolved data_dir = git root's store (planner B1)
  testResolveSymlinkAliasDedupe — /tmp vs /private/tmp spellings + symlinked project_path → 1 store

Group 2: observability (10) — tests/test-all-projects-observability.mjs
  testStatsAllProjectsSeesForeignStore — projB block present, totals include it
  testStatsAllProjectsSkipsDuplicateOfLocal — (a) cwd=projA: one projA block; (b) cwd store SYMLINKED to projA's: still one block (planner B5)
  testStatsAllProjectsReadOnly — foreign index.jsonl bytes identical pre/post
  testDoctorAllProjectsChecksForeignStore — project:projB rows present
  testDoctorAllProjectsForeignCorruptIndexExits1 — malformed projB index → error row + exit 1
  testDoctorAllProjectsSingletonChecks — exactly one installs-drift row with the flag
  testDoctorAllProjectsFixRebuildsForeignIndex — --fix repairs projB; ON-DISK assertion: projB's index.jsonl changed, sibling git-root store byte-identical (planner B1)
  testDoctorFixSkipsNonRootStore — git-nested entry: no rebuild spawned, skipped: non-root-store reported
  testDoctorFixSameBasenameProjects — two projects named "app", both corrupt → BOTH rebuilt (fix keyed by data_dir, codex CX1)
  testDoctorAllProjectsForeignStoreAbsentOk — registered project without a store → ok row

Group 3: fold cross-store (8) — tests/test-fold-all-projects.mjs
  testFoldSingleStoreUnchanged — existing test-fold-superseded.mjs green (no regression)
  testFoldAllProjectsArchivesForeignChain — 12-chain in projB archived; terminal intact; index parses
  testFoldAllProjectsHonorsForeignProtection — referencer in a THIRD store; FULL chain-closure keep: kept count + reasons r6-protected:* AND chain-member all present (planner B3+M1)
  testFoldProtectionLabelIsRealpath — two registered projects with colliding basenames: both stores' class-d latest records stay protected (planner B4)
  testFoldAllProjectsRequiresFoldMode — cluster+--all-projects → exit 2
  testFoldAllProjectsScopeConflict — --all-projects + --scope → exit 2
  testFoldAllProjectsRealRunNeedsConfirm — no --confirm → exit 2, all stores byte-identical
  testFoldSkipsSymlinkEscapeStore — symlinked store dir → skipped + victim untouched

Group 4: promote (12) — tests/test-em-promote.mjs
  testPromoteFindsCrossStoreRecurrence — same lesson in projA+projB → 1 candidate
  testPromoteIgnoresSingleStoreCluster — near-dupes inside projA only → 0 candidates
  testPromoteSkipsReplicaMembers — identical episode id+summary in projA+projB → replica collapsed, 0 candidates (planner M4)
  testPromoteSameIdDifferentContentStaysDistinct — same id, different summary across stores → two members, no silent collapse (codex CX2)
  testPromoteApplyWritesGlobalEpisode — global index gains 1 row, tags promoted-lesson + promoted:<sha8>
  testPromoteApplyBodyCarriesSources — member id sentinel appears in written episode body
  testPromoteNeverWritesSourceStores — projA/projB store bytes identical after --apply
  testPromoteApplyIdempotent — second --apply run: 0 new episodes AND 0 new files in global episodes/ (hash-keyed, planner B2)
  testPromoteSupersetClusterPromotesWithBackref — grown cluster promotes; Sources carries Supersedes-promotion: <prior digest id>
  testPromoteWarnsOnMalformedPromotedEpisode — hand-broken Sources section → warnings entry, exit 0
  testPromoteHelpCarriesExperimental — --help JSON contains "EXPERIMENTAL"
  testPromoteIsSubstrateScript — isSubstrateScript('em-promote.mjs') === true

Total: 40 tests (Group 4 grew to 15 with the reviewer F1-F3 regressions; + existing suites stay green).
Runners: node tests/test-registered-stores.mjs · node tests/test-all-projects-observability.mjs ·
node tests/test-fold-all-projects.mjs · node tests/test-em-promote.mjs
```

All four suites: isolated `HOME` (mkdtemp under the test's own scratch), REAL repo scripts spawned
with explicit `cwd` and `env.HOME` — never staged copies (lesson `…3260`), never mental-trace.
Byte-parity assertions capture real file bytes (sha256) pre/post and assert the pre-hash is
non-empty-input-derived (EC-empty-identity guard).

## §15 Verification Ledger (verify by artifact)

Filled with observed output at implementation time:

| Claim | Command (strong layer) | Observed artifact (2026-07-08 build session) |
|---|---|---|
| All new tests pass | `node tests/test-<each>.mjs` (4 commands) | 7/7, 10/10, 8/8, 15/15 pass |
| Existing fold suite unregressed | `node tests/test-fold-superseded.mjs` | 11/11 pass (also test-em-consolidate 8/8, test-em-doctor 13/13, test-em-stats-semantic 13/13) |
| P12 untouched | `node tests/test-p12-invariant-suite.mjs` | `P12 INVARIANT GATE: PASS` (7 members) |
| Repo-wide guards | control-bytes, install-manifest, lib-closure, em-cli, readonly-manifest suites | 552 files clean; 57/57; 6/6; 9/9; 16/16 |
| Real-store smoke (read-only) | `node scripts/em-stats.mjs --all-projects --scope global` | `project:episodic-memory` block present, 1816 episodes, totals 2299 |
| Real-store fold dry-run only | `node scripts/em-consolidate.mjs --fold-superseded --all-projects --dry-run` | real 49-member workplan chain found (folded_total 48 preview, terminal kept, forked chain skipped non-linear), zero writes |
| em dispatch + experimental label | `node scripts/em.mjs promote --help` | `tier:"EXPERIMENTAL", decision_date:"2026-10-08"` |
| Promote degrade (1 store) | `node scripts/em-promote.mjs` | `note:"needs >=2 registered stores (consumer registry lists 1)"` |
| REQ-12 CI registration | 4-suite grep of plan-marker-validate.yml | `4` |
| Step-9 issues | `gh issue create` ×3 | #478 (§17-A/D/E), #479 (§17-B), #480 (§17-C) |
| CI green per workflow | `gh pr checks <PR>` then `gh run list` per workflow (lesson `…8ff2`) | (at PR time) |
| Deployed after merge | `install.mjs` + shasum repo vs `~/.episodic-memory/scripts/<file>` | (post-merge) |
| MD reflection | `grep -c "em-promote" CAPABILITIES.md docs/EM_SCRIPTS_GUIDE.md` | 3 + 3 matches |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Foreign-store write races (no cross-process lock) | Med | Low | same exposure class as existing single-store ops; per-file temp+rename; documented residual — locking is `em-lock` integration, out of scope |
| Concurrent `em-promote --apply` double-writes a digest (planner M5, axis-7 DEFER) | Low | Low | duplication only, never corruption (em-store appends are per-write atomic); identity-hash dedupe shrinks the window; correctable via em-revise/em-prune; 5-field DEFER in §17-D |
| Registry grows stale (vanished projects) | Low | Med | REQ-1 drops vanished paths; doctor's installs-drift already reports; update sweep prunes |
| Promote false positives (unrelated lessons cluster) | Med | Med | dry-run default + explicit `--apply`; calibrated 0.35 body-token threshold (same as em-consolidate); experimental tier makes removal cheap |
| Basename label collisions confuse readers | Low | Med | `dir` field in every block is the identity; label is display-only (stated in help text) |
| Single-session context blowout | Med | Med | 3-PR split is the default (§6) |

## §17 Open Decisions

- **§17-A Typed provenance on promoted episodes** → deferred to RFC-009 P1b `--evidence`/`--lesson`
  linkage; tracked in **#478** (also carries §17-D and §17-E). 5 fields: (1) scenario: body-only
  sources cannot be machine-joined — reproduced by grepping a promoted fixture episode for a typed
  field (absent); (2) spec: no accepted RFC requires typed provenance today (RFC-009 P1b ships it;
  P1b is approved-pending, not merged); (3) history: codex R1/R2 on P1b validated the linkage design
  (workplan v165 §19.2-3); (4) same-class: em-capture drafts share the body-carried-context shape and
  are similarly untyped in v1 — class-consistent; (5) residual: promoted episodes can't be
  automatically re-verified against sources until P1b lands; failure mode is graceful (stale derived
  lesson, correctable via em-revise).
- **§17-B em-routines scheduling of all-projects doctor** → deferred; tracked in **#479**. 5 fields:
  (1) scenario: nothing breaks — absence just means manual invocation; (2) spec: P6 requires opt-in
  triggers for recurring work — deferral is the conservative side; (3) history: em-routines launchd
  work (v116-era) shipped separately from the capabilities it schedules; (4) same-class: em-doctor
  single-store is likewise unscheduled by default; (5) residual: operators run it by hand; no
  corruption path.
- **§17-C Cluster-mode consolidate across projects** → non-goal (§5), revisit after fold burn-in;
  tracked in **#480** with the 5-field discipline.
- **§17-D Concurrent `--apply` TOCTOU (planner M5)** → deferred; folded into the §17-A issue.
  5 fields: (1) scenario: two concurrent applies both pass the hash-dedupe read then both write →
  duplicate digest content, no corruption (em-store appends atomic per write; not reproduced — same
  exposure class as existing fold C5); (2) spec: P6/P10 mandate no locking; em-lock integration out
  of scope per §16; (3) history: planner reply `20260708-080241-…-afc8` axis-7 row documents the
  class; (4) same-class: fold C5 shares the shape and is likewise documented-residual; (5) residual:
  duplicate promoted episode, graceful, correctable via em-revise/em-prune.
- **§17-E Axis-conflation carried by v1 promote surface (planner M3)** → the `cross-project`
  sentinel inside the open `project` field and the `promoted-lesson`/`promoted:<sha8>` routing
  tags are the same class the R10 taxonomy work retired for categories; both are named
  EXPERIMENTAL surface (§8.4 row 2) and are retired by RFC-009 P1b typed provenance — added to the
  §17-A issue so P1b's implementer sees them.

## §18 Done Criteria

- [ ] All 40 §14 tests pass + all pre-existing suites green (per workflow, `gh run list`).
- [ ] §15 ledger fully populated with observed output.
- [ ] Real-store read-only smoke run (stats + fold dry-run) pasted into PR body.
- [ ] CAPABILITIES.md + EM_SCRIPTS_GUIDE.md reflect shipped capabilities (REQ-13).
- [ ] Deferred items §17-A/B/C each have a GitHub issue (Rule 18 step 9, 5-field).
- [ ] Post-merge deploy: install.mjs run, deployed hashes equal repo, real `--all-projects` smoke.

## §19 Review Consensus (Rule 18)

Leg 1: `negative-scenario-planner` dispatch on this plan (§7 audit). Leg 2+: codex via
interactive cmux (standing directive 2026-06-28), 2-round cap, iterate HOLDs without asking.

| Pass | Reviewer | Provider/Model | Blocker count | Verdict | Reply episode |
|---|---|---|---|---|---|
| 1 | negative-scenario-planner (v6.7) | claude subagent | 5 (+3 MAJOR, 2 MINOR) | HOLD | `20260708-080241-hold-apc-plan-round-1-afc8` |
| 2 | codex R1 | codex gpt-5.5 high (cmux, interactive) | 5 | HOLD — all folded (CX1-CX5 below); operator waived further rounds and pre-approved implementation (2026-07-08) | cmux transcript, session `apc-review` |
| 3 | negative-scenario-reviewer (v4.8, impl diff) | claude subagent | 2 MAJOR + 1 MINOR (all em-promote.mjs) | HOLD — all fixed same cycle (F1-F3 below) | `20260708-084913-hold-apc-impl-round-1-2-major-em-promote-09f3` |

### 19.1 Resolved blockers — planner round 1 (all folded, this revision)

| # | Blocker | Verdict | Resolution + evidence |
|---|---|---|---|
| B1 | store-identity resolution divergence (join ≠ substrate resolution; runtime-observed on git-nested fixture) | ACCEPT | REQ-1 re-specified: `data_dir` = `resolveLocalDir(project_path)` + `store_matches_project` flag; write ops skip mismatches (`non-root-store`); REQ-4 on-disk assertions; §12 states H/I; tests `testResolveNonRootStoreFlagged`, `testDoctorFixSkipsNonRootStore` |
| B2 | similarity dedupe falsified (J=0.255 on minimal digest; dilutes with cluster size) | ACCEPT | REQ-9 re-keyed on `promoted:<sha8-of-sorted-member-ids>` identity tag; `--dedupe-sim` removed from contract; superset disposition defined (state H, back-ref); `testPromoteApplyIdempotent` hash-keyed |
| B3 | protection referencer in a THIRD store unprotected under {store, global} scan | ACCEPT | REQ-5: protection rows = union of cwd-local + global + ALL registered stores, loaded once; negative test moved to third-store shape |
| B4 | label-as-identity leak into protection class-d `latestByStore` bucket | ACCEPT | REQ-5/§8.1: `storeLabel` = realpath(data_dir), label is display-only; `testFoldProtectionLabelIsRealpath` with colliding basenames |
| B5 | realpath asymmetry in duplicate-skip (observed unresolved `dir` field) | ACCEPT | REQ-2: realpath both operands; symlink-alias + `/tmp`↔`/private/tmp` fixtures added (EC13) |
| M1 | protection negative must assert full chain-closure keep | ACCEPT | folded into `testFoldAllProjectsHonorsForeignProtection` (count + both reasons) |
| M2 | missing #22 rows on promoted-lesson artifact | ACCEPT | §8.4 now carries all 7 rows (versioning waiver under experimental tier, writer asymmetry, malformed-Sources `warnings` detection) |
| M3 | `cross-project` sentinel + routing tags = axis conflation | ACCEPT WITH MODIFICATION | kept for v1 as named EXPERIMENTAL surface; §17-E added so P1b retires them — removal now would leave promote without any provenance surface |
| M4 | clone-store replica false recurrence | ACCEPT | REQ-7 id-dedup pre-clustering; `testPromoteSkipsReplicaMembers` |
| M5 | concurrent `--apply` TOCTOU | DEFER | §17-D 5-field block + §16 row |

Codex round 1 (gpt-5.5 high, static review; planner round carried the runtime probes):

| # | Blocker | Verdict | Resolution + evidence |
|---|---|---|---|
| CX1 | doctor `--fix` routing keyed by `check.scope` label; same-basename projects collide (`em-doctor.mjs:561`) | ACCEPT | REQ-3 adds `data_dir` to every per-store check row; REQ-4 keys fix routing by `data_dir`; `testDoctorFixSameBasenameProjects` |
| CX2 | episode ids not proven globally unique across stores — replica collapse + id-only hash can mis-collapse/mis-dedupe | ACCEPT | REQ-7 replica collapse requires id+summary equality; REQ-8 member key = `<id>#<sha8(summary)>` (stable: episodes immutable); `testPromoteSameIdDifferentContentStaysDistinct` |
| CX3 | REQ-12 CI grep proof omitted the fold suite | ACCEPT | grep names all four suites, expects 4 |
| CX4 | LOW altitude with deferred A.7 tables; stale 5/5 count symptom | ACCEPT WITH MODIFICATION | §A.7 staged mechanical-spec gate (per-slice table + lint BEFORE first edit, recorded in PR); 5/5→7/7 fixed |
| CX5 | `--limit` advertised but unspecified | ACCEPT | flag removed; deterministic hash-asc candidate ordering stated |

Implementation review round (negative-scenario-reviewer v4.8 on `git diff main...HEAD`; fold/gate/protection/doctor/cwd-binding all held under its runtime probes):

| # | Finding | Verdict | Resolution + evidence |
|---|---|---|---|
| F1 | recurrence predicate satisfiable by store replication alone (full clone → observed `candidates=1`) | ACCEPT | predicate re-specified: a candidate requires a pair of DISTINCT members with DISJOINT store-sets (fail-safe: partial-clone shapes excluded); `testPromoteCloneStoreCannotFabricateRecurrence` (full + partial clone + independent control) |
| F2 | `## Sources` first-match parse hijackable by untrusted member excerpts (observed doubled header + `supersedes_promotion:null`) | ACCEPT | write side quotes heading lines in excerpts + `## Member:` prefix; read side parses the LAST section + warns on multiple headers; `testPromoteSourcesHeaderInjectionContained` |
| F3 | member tag union leaks stray `promoted:*` tags into the dedupe identity set | ACCEPT | identity-prefixed tags stripped from the union (exactly one hash tag per digest); `testPromoteStripsForeignIdentityTags` |
| N1/N2 | scope-label dual role; identity on the tag axis | DEFER | documented P1b retirements, #478 |

## §20 Lessons Encoded

| Lesson | One-line rule | Enforced in |
|---|---|---|
| `…97a5` fourth-catch data-artifact contract | new artifact ships shape + drift + index contract | §8.4 |
| `…3260` fixture transitive imports | spawn real scripts, never staged copies | §14 |
| `…8ff2` gh pr checks collapses jobs | verify per workflow via `gh run list` | §15, §18 |
| `…9ac4` three legs | P/C citations + full script disposition sweep | §3, §9b |
| C1 discovery (this session) | protection scan must follow the store being folded | §7-C1, REQ-5 |
| behavior-simulation rule | design claims cite fixture probe output | §3 runtime evidence |
| planner B1 (`…afc8`) | store identity = the substrate's OWN resolution, never a naive join | REQ-1, §8.1, §12 H/I |
| planner B2 (`…afc8`) | similarity cannot prove identity on derived supersets — key idempotency on source-id sets | REQ-9, §8.4 |
| planner B4 (`…afc8`) | display labels never feed identity keys/buckets | §8.1, REQ-5 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value for this plan |
|---|---|
| Language / runtime | Node.js 18+ (repo floor), `.mjs` ESM, zero deps |
| Runtime check (§A.4 row) | `node --version` → `v18` or higher |
| Test-runner shape | `node tests/test-<suite>.mjs` |
| New-function phrasing | `export function fnName(args)` |
| Portable break-input override | argv flag on the test file, e.g. `node tests/test-fold-all-projects.mjs --break-protection` (POSIX + Windows safe) |
| Search tool for verifies | `grep -c` / `grep -n` from repo root |
| Repo-specific done-commands | `node tests/test-p12-invariant-suite.mjs`; per-suite runners |

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/all-projects-consolidation.md
```

Disposition rule per template §A.1: matches inside template-quoting prose and §19 TBD cells
(review results not yet produced) are acceptable; matches inside §A.5/§A.7 step rows are bugs.
Run + record at finalization.

## A.2–A.3 Executor contract & STOP protocol

Per PLAN_TEMPLATE §A.2/§A.3 verbatim (copy into handoff). Read-only references for all slices:
`scripts/lib/install-version.mjs`, `scripts/lib/relevance.mjs`, `scripts/lib/protection.mjs`,
`scripts/lib/local-dir.mjs`, `scripts/em-capture.mjs`.

## A.4 Pre-flight (every slice)

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | slice's PR branch (§1) |
| Clean tree | `git status --porcelain` | empty |
| Baseline suites green | `node tests/test-fold-superseded.mjs` (and slice-relevant existing suites) | all pass |
| Runtime | `node --version` | ≥ v18 |

## A.5 Shared constants

```js
// scripts/lib/registered-stores.mjs (APC-S1) exports these; later slices import them.
export const STORE_DIR_BASENAME = '.episodic-memory'
export const PROJECT_SCOPE_PREFIX = 'project:'
// em-promote.mjs (APC-S5) constants:
export const PROMOTED_TAG = 'promoted-lesson'
export const PROMOTED_HASH_TAG_PREFIX = 'promoted:' // + first 8 hex of sha256 over newline-joined sorted member keys `<id>#<sha8(summary)>` (codex CX2)
export const PROMOTE_MIN_SIM_DEFAULT = 0.35
export const PROMOTE_DECISION_DATE = '2026-10-08'
```

## A.6–A.6b Anchor + falsifiable-verify rules

Per PLAN_TEMPLATE verbatim. Every Verify below names observed → expected and fails on a stub;
negative controls are their own rows via argv break flags.

## A.7 Per-slice step tables

**Staged mechanical-spec gate (codex CX4, ACCEPT WITH MODIFICATION).** The altitude stays LOW,
and the full verbatim step tables (exact anchors, exact code payloads, exact assertions) are
authored per-slice at slice start against the THEN-current file state — because anchors authored
now WILL drift before build (workplan v165 key lesson: line numbers and constants drift; every
§A.7 anchor gets re-verified against the actual file). To keep that deferral honest instead of a
hole in the Rule 18 gate, it is itself gated: **before a slice's first edit, its `A.7-S<n>` table
MUST be appended to this plan, pass the §A.1 forbidden-phrase lint and the §A.7 executor-ready
gate (one file per step, verbatim anchors, falsifiable verifies), and the passing lint output is
recorded in that slice's PR body.** Operator approval of this plan covers §1–§20 plus this staging
contract; an A.7 table that fails its gate blocks that slice exactly as a failed plan review
would. The slice-level file/kind/verify skeleton is fixed NOW:

### APC-S1 skeleton
| Step | File | Kind | Action | Verify |
|---|---|---|---|---|
| 1.1 | `scripts/lib/registered-stores.mjs` | CREATE | lib per §12 contract, §A.5 constants, `resolveRegisteredStores` state table A–G | `grep -c "export function resolveRegisteredStores" scripts/lib/registered-stores.mjs` → 1 |
| 1.2 | `tests/test-registered-stores.mjs` | CREATE | 7 Group-1 tests, isolated HOME, real lib import; sentinel project paths | `node tests/test-registered-stores.mjs` → `7/7 pass` |
| 1.3 | — | — | negative control: `--break-registry` flag corrupts fixture registry mid-test → expects `[]` path exercised | `node tests/test-registered-stores.mjs --break-registry` → non-zero exit |
| 1.4 | — | — | commit `APC-1: registered-stores lib` + trailer | `git log -1 --oneline` shows `APC-1` |

### APC-S2/S3/S4/S5 skeletons
Same shape: one CREATE/EDIT step per file listed in §10, one test-suite CREATE with the §14
group's named tests, one argv-flag negative-control row per §7 mitigation touching that slice,
one CI-registration EDIT (`.github/workflows/plan-marker-validate.yml`, APPEND run step after the
`test-fold-superseded.mjs` step at current line 259), one commit row.

### APC-S6 skeleton
| Step | File | Kind | Action | Verify |
|---|---|---|---|---|
| 6.1 | `CAPABILITIES.md` | EDIT | learning-row default cell: `none (opt-in)` → `em-promote (EXPERIMENTAL, decision 2026-10-08); otherwise none (opt-in)`; curation family paragraph gains one sentence naming shipped `--all-projects` ops | `grep -c "em-promote" CAPABILITIES.md` → ≥1 |
| 6.2 | `docs/EM_SCRIPTS_GUIDE.md` | EDIT | new em-promote section + `--all-projects` rows for stats/doctor/consolidate | `grep -c "all-projects" docs/EM_SCRIPTS_GUIDE.md` → ≥3 |
| 6.3 | — | — | Rule 10/11 index check: `docs/README.md` + `docs/_index.json` updated iff EM_SCRIPTS_GUIDE has registered triggers there (verify at build) | grep of `_index.json` for the guide's entry |
| 6.4 | — | — | commit `APC-6: charter + guide reflection` + trailer | `git log -1 --oneline` |

## A.8 Definition of done (mechanical)

```bash
node tests/test-registered-stores.mjs         # 7/7
node tests/test-all-projects-observability.mjs # 10/10
node tests/test-fold-all-projects.mjs          # 8/8
node tests/test-em-promote.mjs                 # 15/15
node tests/test-fold-superseded.mjs            # unregressed
node tests/test-p12-invariant-suite.mjs        # pass
node scripts/em-stats.mjs --all-projects       # real-store JSON, >=1 project block
```

## A.9 Blast-radius notes

- S4 extracts the fold body into a per-store function — **pure extraction first** (fold body
  behavior-identical for the single-store path, existing suite green) THEN the iteration caller.
- Protection-scan change is the **high-blast-radius** edit → "focused review before build" mark.
- Red-then-green: every §7 negative control runs as its own argv-flag row before the green run.
