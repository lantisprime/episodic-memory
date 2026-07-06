# RFC009-P1a Memory Taxonomy: categories.json + category index + validation matrix Plan

## §1 Status

`Implemented + reviewed.` Current stage: **operator-approved (2026-07-06) and IMPLEMENTED on
`feat/rfc-009-p1a` (S1-S7, commits c9d1f6e..a83e9e9); 55 P1a tests green + em-restore self-test 120/0
+ prune-protection 17/17; §15 four-surface E2E shows the matrix now consistent; post-impl code review
(negative-scenario-reviewer, §19.4) returned ACCEPT with 0 findings across all 9 attack axes + I1-I5 +
EC1-EC10, all runtime-probed. Deferred issues filed (Rule 18 step 9): #457 (§17-A T6→P1b),
#458 (§17-E fork-loss), #459 (multi-scope index fallback). Pending: PR + CI + operator merge + global
deploy.** Prior planning stage: reviews converged — planner HOLD (§19.1) + codex R1 HOLD (§19.2) +
codex R2 HOLD (§19.3) all folded; design validated; altitude LOW.

| Field | Value |
|---|---|
| RFC | `RFC-009` |
| Parent requirements | `R10 (a–f); R2/R9 cited for the em-search `--history` walk rationale` |
| Workplan episode | `20260705-125419-workplan-v162-pr-452-merged-eb6ac0a-rfc--c94c` |
| Target branch | `feat/rfc-009-p1a` |
| Executor altitude (§0.1) | `low` (default; no high-capability implementer named) |

P1a is the first of the two PRs the operator sequenced inside RFC-009 Phase 1 ("R10 first,
then R1/R2/R9a", session handoff 2026-07-06). P0 (`--hermetic` + prune protection set) merged
and deployed as `e3e1f05`; it is the hard dep and is done. P1a delivers the **category axis** of
R10 (the schema-backed closed vocabulary, its derived index, the per-surface validation matrix,
the temporary lifecycle, and drift detection) plus the `em-search --history` multi-parent walk
that R9 (P4) will depend on. P1b (next PR) delivers R1 activation flags + R2 trigger index +
R9a collision report + the RFC-009 contract.json mirror.

## §2 Episode Search Summary

Recall run (2026-07-06): `node scripts/em-search.mjs --tag rfc-009 --scope all --limit 10 --no-track --no-score --full` (abbreviated):

- `20260705-125419-…-c94c` — workplan v162; P1 picked, sequenced R10-first. Constrains this PR to the R10 category axis only.
- `20260705-084023-…-f5e3` — violation: taxonomy conflation (category-vs-tag) caught by the user, not the planner. This PR is the fix; the T2 invariant (a tag is never load-bearing) is honored — nothing new in P1a branches on a tag value, and run-record location stays a typed scalar, never a tag.
- `20260705-102842-…-eaa1` / `…-a945` — PR #451 strict event-plane boundary + behavior-simulation convention. Constrains this PR: every claim about store/restore/prune/index behavior is runtime-probed against an isolated fixture store (§15), not asserted from source reading.
- P0 milestone `…9f34` — `em-prune` now carries the R6 protection set (lines 85-99+). P1a ADDS the R10e per-category lifecycle on top; the protection set is untouched.

Verified against current code before relying on recalled facts (2026-07-06):
- `em-store.mjs:81` — `VALID_CATEGORIES` hardcoded array (8 members). `em-restore.mjs:40` — duplicate of the same array, kept in sync by the self-test `valid_categories_match_em_store` (em-restore.mjs:1242-1260) which greps `em-store.mjs` for the literal.
- `em-restore` write path (apply) writes ANY episode category through without validation (runtime-verified asymmetry, RFC evidence appendix item 4); its `--category` FILTER validates against the duplicated list (em-restore.mjs:978-980).
- `em-revise.mjs:159-166,227` — inherits the original episode's `category` verbatim; performs NO vocabulary validation.
- `em-rebuild-index.mjs` — builds `index.jsonl` + `tags.json`; the index entry object (lines 118-131) is an EXPLICIT allow-list of fields (no category-index; `consolidates`/`superseded_by` not carried).
- `em-search.mjs:175-203` — `--history` walks the SINGLE-valued `supersedes` edge only (backward to root, forward via a one-parent `bySupersedes` map).
- `install.mjs:389-413` — deploys `patterns/_index.json` globally (§1b) but DELIBERATELY NOT `patterns/taxonomy.json` (it is an enforcement artifact, P12). `categories.json` is substrate → must deploy globally.

## §3 Objective

The episode category vocabulary stops being hardcoded twice in script source and becomes a
single schema-backed data artifact `categories.json`, read by every substrate script through one
lib. Four write/read/index/prune surfaces stop behaving four different ways about an unknown
category and instead obey the R10c matrix exactly (store/revise strict; restore strict-including-
deprecated + skip-and-surface on apply; search/list/recall tolerant; index build tolerant + counting).
Category earns a derived index `category-index.json` (built by `em-rebuild-index`, incrementally
maintained by `em-store`/`em-revise`) so `em-search --category` is index-backed like `--tag`.
`temporary` and `workplan` join the vocabulary; deprecated members retire via `deprecated_for`
mapping (never deletion). `em-prune` reads a per-category `lifecycle` policy from the vocabulary
(`aggregate-then-prune` bites only once a consolidated successor exists). `em-search --history`
walks the many-to-one `consolidates`/`superseded_by` edges R9 (P4) will write. All provable by
runtime probes on an isolated fixture store (§15) where today the four surfaces diverge.

Runtime evidence (2026-07-06 probes to be captured at build time — §15 lists the exact commands;
the RFC evidence appendix already recorded the divergence on 2026-07-05):
- `em-store --category workplan` → exit 1 (closed vocab). `em-restore --apply` of a `workplan`
  episode → written through silently. `em-restore --category workplan` (filter) → refused. `em-search`/`em-list` render `workplan` fine. Four surfaces, four behaviors.

## §4 Requirements (Ground Truth)

Every requirement is testable and maps to ≥1 test. Parent R-numbers cited (R10 sub-clauses).

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | `categories.json` exists at repo root with 10 members — the existing 8 (`decision`, `discovery`, `milestone`, `context`, `research`, `lesson`, `violation`, `workflow.lifecycle`) plus `workplan` and `temporary` — each `{name, description, lifecycle}` with `lifecycle ∈ {standard, aggregate-then-prune}`; `temporary` is `aggregate-then-prune`, all others `standard`. Optional `deprecated_for: <successor-name>`. `version` is semver. | R10b | `testCategoriesJsonValidates`, `manual: node scripts/validate-schemas.mjs` | MUST | Launch has zero deprecated members; a deprecated fixture is planted in tests |
| REQ-2 | `schemas/categories.schema.json` is a valid JSON-Schema 2020-12 doc, **auto-discovered and lint-validated by `validate-schemas.mjs`** (it walks `schemas/` for `*.schema.json` — NO edit to that validator; C3). `additionalProperties:false`; closed `lifecycle` enum; optional `deprecated_for` string. The `categories.json` INSTANCE-validation against the schema + the `deprecated_for`-must-resolve-to-a-non-deprecated-member check live in `testCategoriesJsonValidates`/`testDeprecatedForMustResolve` using **`validateInstance` from `scripts/lib/json-instance-validate.mjs`** (that is where `validateInstance` is exported, L513 — C6; `mini-jsonschema.mjs` exports only `lintSchema`, which is for linting a schema DOC, not instance-validating data against one). Bump `MIN_SCHEMA_DOCS` 17→18 to pin the new doc. | R10b | `testCategoriesJsonValidates`, `testCategoriesSchema`, `testDeprecatedForMustResolve`, `manual: node scripts/validate-schemas.mjs --project <abs>` (discovers 18 docs) | MUST | Mirrors `patterns/taxonomy.schema.json`; instance-validation is a test (via `json-instance-validate.mjs`), not a validate-schemas responsibility |
| REQ-3 | `scripts/lib/categories.mjs` is the ONLY source of the vocabulary: exports `loadCategories()`, `validateCategory(name,{allowDeprecated})→{ok,reason,successor}`, `canonicalCategory(name)→name` (deprecated→successor, unknown→itself), `categoryLifecycle(name)→lifecycle|null`. Resolves `categories.json` via `import.meta.url` `../../categories.json` (repo root in-repo, `~/.episodic-memory/` deployed). A grep asserts no hardcoded category-name list survives in any `scripts/*.mjs`. | R10b, R10c | `testCategoriesLibResolution`, `testNoHardcodedCategoryList` (grep gate) | MUST | Single home kills the em-store/em-restore duplication + drift-test pair |
| REQ-4 | `em-store --category <c>` and `em-revise` of an episode whose (inherited) category is `<c>`: **strict** — a member in the vocabulary and NOT deprecated is accepted; a deprecated member is rejected naming the successor; an unknown member is rejected naming the vocabulary. No partial write on rejection. | R10c row 1 | `testStoreStrictAccept`, `testStoreRejectsDeprecated`, `testStoreRejectsUnknown`, `testReviseValidatesInheritedCategory` | MUST | em-revise today inherits unvalidated (em-revise.mjs:159-166); a revise of a hand-planted deprecated-category episode now rejects |
| REQ-5 | `em-restore --category <c>` (FILTER flag): strict **including deprecated** names (older-vocab backups filter correctly); unknown → the existing invalid-category error. | R10c row 2 | `testRestoreFilterAcceptsDeprecated`, `testRestoreFilterRejectsUnknown` | MUST | Replaces the duplicated hardcoded list at em-restore.mjs:40,978 |
| REQ-6 | `em-restore --apply` WRITE path: an episode whose category is unknown-to-any-version gets the existing **skip-and-surface** treatment (not written, surfaced in the report), inverting today's silent write-through; an episode whose category is a **deprecated** member restores successfully (written verbatim; readers map it). | R10c row 2 | `testRestoreApplySkipsUnknownCategory`, `testRestoreApplyWritesDeprecated` | MUST | Runtime-probe inversion of RFC evidence item 4; validation runs BEFORE any write (EC6 ordering) |
| REQ-7 | `em-search` / `em-list` / **`em-recall`** read path stays **tolerant**: an episode with an unknown category (hand-planted, the #447 class) never breaks listing, filtering, ranking, or output (C1 — RFC R10c:231 + P1 gate row 476 name em-recall explicitly; em-recall is otherwise scoped to P1b for the T6 preflight retarget, but its unknown-category read-tolerance is a P1a matrix row and gets a regression pin here). | R10c row 3 | `testSearchTolerantUnknownCategory`, `testListTolerantUnknownCategory`, `testRecallTolerantUnknownCategory` | MUST | Kept deliberately (runtime-verified current behavior); the em-recall test is a no-code-change regression pin |
| REQ-8 | `em-rebuild-index` builds `category-index.json` per store: `{ "<canonical category>": ["<id>", …] }` — deprecated names mapped to successor keys, unknown names indexed under their **literal** key AND counted. Atomic temp+rename. The build report gains `category_drift: {unknown: {<name>: N}, deprecated: {<name>: N}}`. | R10d, R10f | `testCategoryIndexBuilt`, `testCategoryIndexDeprecatedMapped`, `testCategoryIndexUnknownCountedLiteral` | MUST | Same atomic + append-only-between-rebuilds contract as `tags.json` |
| REQ-9 | `em-store` and `em-revise` incrementally update `category-index.json` under the episode's canonical category key (temp+rename), mirroring `updateTagsIndex`. | R10d | `testStoreUpdatesCategoryIndex`, `testReviseUpdatesCategoryIndex` | MUST | New episode → new/extended key; missing index file created |
| REQ-10 | `em-search --category <c>` **already exists** as an exact-match linear filter (`em-search.mjs:262-263`, `results.filter(e => e.category === c)`). This PR INDEX-BACKS it: canonicalize `<c>` first, read `category-index.json`, intersect ids; **linear-scan fallback + stderr rebuild warning** when the index is missing/corrupt (symmetric with tags.json); an active-name query returns byte-identical results to today. Filtering an unknown `<c>` returns literal-key matches (tolerant). | R10d, M1 | `testSearchCategoryExactMatchUnchanged` (regression pin — byte-identical for an active-name query, symmetric with `testHistorySingleSupersedesUnchanged`), `testSearchCategoryUsesIndex`, `testSearchCategoryFallbackOnMissingIndex`, `testSearchCategoryCanonicalizesDeprecated` | MUST | NOT a new flag — the change is index-backing + deprecated canonicalization + degrade path (B1); planner M1 corrected the baseline |
| REQ-11 | `em-restore --apply` merges the restored ids into `category-index.json` (or triggers a rebuild); a test pins whichever path is implemented. | R10d | `testRestoreMergesCategoryIndex` | MUST | Implementation's choice, pinned by the test (RFC R10d) |
| REQ-12 | `em-rebuild-index --check` exits non-zero and lists each drifted episode `{id, category, kind: unknown|deprecated, successor?}` when any episode's stored category is unknown or deprecated; exits 0 with an empty list otherwise. Does not modify any file. | R10f | `testRebuildCheckListsDrift`, `testRebuildCheckCleanExitsZero` | MUST | Detection only; correction is the R9 clerk (P4), explicitly deferred |
| REQ-13 | `em-prune` reads per-category `lifecycle` from `categories.json`: an `aggregate-then-prune` episode (`temporary`) is aggressively prunable ONLY if it carries `superseded_by` (a confirmed R9 apply exists); without a successor it ages under the standard score. `standard`-lifecycle episodes are unaffected. **R6×R10e interaction (surfaced in review):** a consumed temporary sits in its successor's `consolidates` array, which R6 class-c (P0) would protect — R10e's aggressive-prune OVERRIDES class-c for `aggregate-then-prune` lifecycle (RFC R10e "the consumed members are not [protected]"); a `standard`-category consolidates-member stays class-c protected. The R6 protection set CODE (P0) is otherwise untouched. | R10e; R6 (class-c override) | `testTemporaryWithSuccessorPrunable`, `testTemporaryWithSuccessorOverridesClassC`, `testTemporaryWithoutSuccessorSurvives`, `testStandardLifecycleUnaffected`, `testStandardConsolidatesMemberStillProtected` | MUST | Never hardcode category names in prune — read `categoryLifecycle()`; the lifecycle override is checked before the protection lookup |
| REQ-14 | `em-search --history <id>` walks the many-to-one edges: forward via `superseded_by` (in addition to inverting `supersedes`) AND surfaces a `consolidates` successor for any id named in another active episode's `consolidates` array; existing single-`supersedes` chains are byte-unchanged. A `supersedes` FORK (one root, two children — lossy today, `em-search.mjs:195-203` Map last-writer-wins keeps only one child, m1) is CHARACTERIZED by a fixture so the multi-parent walk provably does not change which children surface; fixing the pre-existing fork-loss is a §17-E deferred issue. `em-rebuild-index` carries `consolidates` (inline array) and `superseded_by` (scalar) through into `index.jsonl` when present. | R9 (walk shipped early per handoff), R2, m1 | `testHistoryFollowsSupersededBy`, `testHistorySurfacesConsolidatesSuccessor`, `testHistorySingleSupersedesUnchanged`, `testHistorySupersedesForkCharacterized`, `testHistoryCycleSafe`, `testRebuildCarriesNewFields` | MUST | No P1a writer emits these fields; tested via hand-planted episodes. Rationale: R9 acceptance is unimplementable without the walk (RFC) |
| REQ-15 | `install.mjs` deploys `categories.json` to `~/.episodic-memory/categories.json` (substrate, global — mirroring the §1b `patterns/_index.json` deploy); it lands NOWHERE under `~/.claude/` (P12). **The E2E EXERCISES the resolution (M3):** after the isolated-HOME install, invoke the DEPLOYED `~/.episodic-memory/scripts/em-store.mjs --category bogus` (cwd in the fake project) and assert it loads the DEPLOYED vocab (exit 1 with the vocab-list message) — proving `../../categories.json` resolves in the deployed tree, not just that the file was stat-able. | R10b, P12, M3 | `testInstallDeploysCategoriesJson`, `testCategoriesJsonNotInClaudeHome`, `testInstallDeployedStoreLoadsVocab` | MUST | Mock-project isolated-HOME E2E; verify-the-strong-claim (run the deployed script, don't stat the file) |
| REQ-16 | Docs ship in the same PR: `categories.json`, `category-index.json`, the R10 category/tags semantics, `em-search --category`, `em-rebuild-index --check`, and the temporary lifecycle documented in `docs/EM_SCRIPTS_GUIDE.md` (grep-gated); README script table updated. | RFC "Documentation deliverable (every phase)" | `testDocsGrepGate` | MUST | Docs drift CI-caught |
| REQ-17 | The em-restore self-test `valid_categories_match_em_store` (em-restore.mjs:1242-1260) is REPLACED (fixture-change ledger, §A.9): it no longer greps em-store for a literal array; it asserts both scripts import `lib/categories.mjs` and that `loadCategories()` returns the launch vocabulary. | R10b | `test_categories_from_shared_lib` (renamed) | MUST | Enumerated edit, not "existing tests stay green" |

**UNGUARDED-IN-CI:** none. Every MUST maps to an automated Node test.

## §5 Non-Goals

Explicitly deferred — each with a one-line rationale; the deferred items that need tracking get
a §17 entry with the 5 DEFER fields.

- **T6 `violated_pattern` typed-field migration** (em-violation writes `violated_pattern`, em-recall preflight + em-pattern-health strike counting retarget off the `violated:bp-*` tag) → **P1b**. Rationale: those three scripts are NOT category-axis surfaces, and em-violation is already opened in P1b for the R1 `--lesson` flag; bundling keeps one concern per PR (§17-A).
- **Workplan-discovery recipe FLIP** (CLAUDE.md `--tag workplan --category decision` → `--category workplan`) → post-burn-in. Precise dual-read semantics (m2): the current recipe is an AND (`--tag workplan` AND `--category decision`), so during burn-in workplans keep being stored as `category: decision` + tag `workplan` and the old recipe finds them; a workplan stored under the NEW `category: workplan` is invisible to the old recipe. P1a only ADMITS `workplan` to the vocabulary (so `--category workplan` stops erroring); it does not restore any workplan under the new category and does not flip the recipe. The flip (store new workplans as `category: workplan`, change the recipe) is a separate post-burn-in change (§17-B).
- **Full T2 tag-value-branching conformance grep** (`no tags.includes(<literal>)` outside burn-in shims) → **P1b/T6**. P1a introduces no new tag-value branching (a lighter grep asserts that), but the burn-in-shim + sunset-marker machinery only becomes meaningful once T6 lands (§17-C).
- **R1 activation fields, R2 trigger index, R9a collision report, RFC-009 contract.json mirror** → P1b (the RFC Phase-1 second half).
- **The R9 consolidation clerk itself** (`em-consolidate.mjs`, run records, telemetry) → P4. P1a only ships the `em-search --history` walk R9 will consume.
- Any change to the prune SCORE formula (RFC: "Prune SCORING stays unchanged"); R10e gates WHICH episodes the score may reach, not the score.
- Any semantic/embedding category inference; drift CORRECTION (agentic, R9 clerk, P4). P1a is mechanical detection only.

## §6 Token Budget (Rule 12)

`wc -l` on the target files (2026-07-06):

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `scripts/em-store.mjs` | 193 | ~1.0k | ~1.0k | lib swap + category-index update |
| `scripts/em-revise.mjs` | 259 | ~1.3k | ~1.0k | validate inherited category + category-index update |
| `scripts/em-restore.mjs` | 2470 | ~3.0k (category + apply sections only) | ~2.0k | lib swap, apply validation, index merge, self-test rewrite |
| `scripts/em-rebuild-index.mjs` | 154 | ~0.8k | ~2.0k | category-index build + `--check` + carry new fields |
| `scripts/em-search.mjs` | 359 | ~1.8k | ~1.5k | `--category` via index + `--history` multi-parent walk |
| `scripts/em-prune.mjs` | 329 | ~1.6k | ~0.6k | per-category lifecycle gate |
| `install.mjs` | ~2700 | ~1.0k (deploy section only) | ~0.3k | one deploy step |
| `scripts/lib/categories.mjs` | new | — | ~1.2k | the shared vocab lib |
| `categories.json` + `schemas/categories.schema.json` | new | — | ~1.0k | data + meta-schema |
| `scripts/validate-schemas.mjs` + CI yml | — | ~0.5k | ~0.4k | wire categories.json |
| test files (5 new) | new | — | ~10k | ~35 tests |
| `docs/EM_SCRIPTS_GUIDE.md` + `README.md` | 436 / 631 | ~0.8k (sections) | ~0.6k | |
| this plan + RFC re-reads | — | ~6k | — | |

**Baseline (single session):** ~38k overhead + ~30k above + test iteration slack ≈ **95-115k** —
inside the 60-130k sweet spot but toward the top; this is the larger of the two P1 PRs, matching
the RFC sizing ("2 sessions: R10 first, then R1/R2/R9a").
**Optimized:** if the session approaches autocompact, the cut order (§11) sheds the `em-search
--history` walk (REQ-14) into P1b first — it is the only deliverable with no P1a-internal consumer.

## §7 Safety / Security

No trust boundary, privilege vector, or path-authority predicate is added: no `realpath`/`lstat`/
`isMain`/symlink logic, so the 8-axis symlink matrix is not re-enumerated (store resolution stays
`resolveLocalDir`, already worktree-tested). `categories.json` resolution uses `import.meta.url`
relative pathing (`../../categories.json`), which is realpath-canonical on the `import.meta.url`
side by construction and reads a fixed repo/deployed data file, not an argv-supplied path — no
authority decision rides on it. Boundary check (RFC-008 R1, P12, CAPABILITIES): every deliverable
is DATA-plane substrate — vocabulary read, category validated, derived index built, lifecycle read.
No gate, marker, or decision surface is added. `em-prune`'s lifecycle gate REPORTS eligibility; it
does not enforce a workflow. **Dispatch `negative-scenario-planner` on this design before §19**
(schema + validator + multi-surface-validation change = its trigger); self-walk is the fallback.

| Concern | Severity | Attack/abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| Validation-timing (write-before-validate) | Med | `em-restore --apply` writes an unknown-category episode to disk THEN validates → the silent-write-through this PR exists to kill persists | Validate each episode's canonical category BEFORE the write in the apply loop; skip-and-surface on failure | `testRestoreApplySkipsUnknownCategory`; negative: a run whose only episode is unknown-category leaves the target dir with zero new files |
| Vocabulary fail-open at a WRITER (lib can't load categories.json) | High | Deployed script can't resolve `categories.json` → falls back to "accept anything" → the closed vocab is silently open | `loadCategories()` THROWS on missing/malformed vocab; `validateCategory` propagates; store/revise/restore-apply catch and fail-CLOSED (reject the write with a clear error) | `testStoreFailsClosedOnMissingVocab` (EM_CATEGORIES_PATH=/nope → `em-store` exits non-zero, writes nothing) |
| Vocabulary fail-CLOSED at a READER (B1 regression) | High | A reader/index/prune surface calls the vocab and THROWS on a missing/malformed `categories.json` → `em-search --category` crashes (violates R10c row 3 "never fatal"), or the core `em-rebuild-index` — today vocab-independent — is taken down entirely | Readers call `canonicalCategory`/`categoryLifecycle` which DEGRADE (§12): search→today's exact-match, rebuild→build index.jsonl+tags.json + skip category-index + stderr warn, prune→standard score | `testSearchDegradesOnMissingVocab`, `testRebuildDegradesOnMissingVocab`, `testPruneDegradesOnMissingVocab` (each sets EM_CATEGORIES_PATH=/nope, asserts exit 0 + the pre-R10 behavior) |
| Drift false-negative | Med | An unknown category slips past `--check` (e.g. only counted in the build, not listed) → drift accrues invisibly | `--check` lists every drifted id, not just a count; the build report counts; two independent surfaces | `testRebuildCheckListsDrift` with a planted unknown AND a planted deprecated in the same store |
| Deprecated-map cycle / self-reference | Low | `deprecated_for` points to another deprecated member, or to itself → `canonicalCategory` loops | `canonicalCategory` follows at most one hop and the validator rejects a `deprecated_for` chain (successor must be a NON-deprecated member) at CI time | `testDeprecatedForMustResolve` (successor deprecated → validator fails) |

## §8 Design

### 8.1 Key types

```js
/**
 * @typedef {Object} CategoryDef
 * @property {string} name        — canonical category id (e.g. "lesson", "temporary")
 * @property {string} description — human-readable meaning
 * @property {"standard"|"aggregate-then-prune"} lifecycle
 * @property {string} [deprecated_for] — successor canonical name; when set the member is retired
 */
/**
 * @typedef {Object} CategoriesDoc
 * @property {string} version                 — editorial semver
 * @property {CategoryDef[]} categories
 */
/**
 * validateCategory(name, {allowDeprecated}) → { ok:boolean, reason?:string, successor?:string }
 *   - unknown           → {ok:false, reason:"unknown"}
 *   - deprecated, allowDeprecated=false → {ok:false, reason:"deprecated", successor}
 *   - deprecated, allowDeprecated=true  → {ok:true, successor}
 *   - active member     → {ok:true}
 */
```

### 8.2 Key invariants

- **I1 — one vocabulary source.** Every SUBSTRATE script reads the vocabulary through `lib/categories.mjs`; no `scripts/*.mjs` contains a category-name **array literal** (grep-enforced, REQ-3). Single-value constants in the event-writer family are dispositioned separately (I2b).
- **I2 — the R10c matrix is total over SUBSTRATE write surfaces.** Every substrate category-touching surface (`em-store`, `em-revise`, `em-restore`, index build, `em-search`, `em-prune`) maps to exactly one matrix row; the per-surface behavior is a single call into the lib (`validateCategory` with the row's `allowDeprecated` for writers, `canonicalCategory` for index keys, `categoryLifecycle` for prune, or nothing for tolerant list). No substrate surface invents a fourth behavior.
- **I2b — event-writer family is out-of-scope-but-safe (M2 disposition).** `em-review-request.mjs:454-473`, `bp1-orchestrator.mjs`, `bp1-deadline-sweep.mjs`, `bp1-flag-flip.mjs`, and `lib/bp1-episode-writer.mjs:263` construct frontmatter directly (bypassing `em-store`) and emit the **constant** `workflow.lifecycle`. They neither call `validateCategory` nor update `category-index.json`. This is SAFE and in-scope-UNCHANGED per the RFC coverage table (em-review-request UNCHANGED, bp1-* are enforcement-layer, not substrate): the constant is always a valid active member, and the category-index staleness self-heals on the next rebuild exactly as `tags.json` does for the same writers today. The REQ-3 grep targets array literals, so it does not false-positive on these constants; §A.8's broad-token grep carries an allow-list note for the `workflow.lifecycle` constant.
- **I3 — derived, self-healing, never fatal.** `category-index.json` is derived: staleness between rebuilds is tolerated exactly like `tags.json`; missing/corrupt → linear-scan fallback + rebuild warning, never fatal. **AND** (B1) a missing/malformed `categories.json` never takes down a reader/index/prune surface: those call `canonicalCategory`/`categoryLifecycle`, which degrade (§12) rather than throw. Only WRITE surfaces fail-closed on an unloadable vocab.
- **I4 — validate before write.** In every write path (store, revise, restore-apply) category validation precedes the file/index write; a rejection leaves the store byte-unchanged (EC6).
- **I5 — stored bytes are never rewritten for taxonomy.** Deprecated categories are mapped at READ/INDEX time (`canonicalCategory`); episode `.md` files keep their stored category forever (the vocabulary-level mirror of P7 revision chains).
- **Cross-platform:** pure `path`/`fs`/`import.meta.url`; no GNU-only flags, no `sed -i`, no `readlink -f`. `categories.json` resolution uses `new URL('../../categories.json', import.meta.url)`.
- **Atomicity:** `category-index.json` writes are temp+rename (repo convention), same as `tags.json`.

### 8.3 Resolution / flow

```text
categories.json (repo root ─ deployed to ~/.episodic-memory/)
        │  loadCategories() via ../../categories.json from scripts/lib/
        ▼
  lib/categories.mjs ── validateCategory / canonicalCategory / categoryLifecycle
        │
  ┌─────┼───────────────┬───────────────┬────────────────┬─────────────┐
  ▼     ▼               ▼               ▼                ▼             ▼
em-store  em-revise   em-restore     em-rebuild-index  em-search    em-prune
(strict)  (strict)    (filter:strict  (tolerant+count;  (--category  (lifecycle
+cat-idx  +cat-idx    +deprecated;    builds           via cat-idx; policy gate)
update)   update)     apply:skip-     category-index;   --history
                      surface+merge)  --check lists)    multi-parent)
```

The `em-search --history` multi-parent walk is orthogonal to the vocabulary (it reads
`supersedes`/`superseded_by`/`consolidates` edges from index rows) but ships here per the handoff.

## §9 Existing Hook Points

Line numbers verified 2026-07-06; re-verify at build time (they drift).

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `scripts/em-store.mjs` | 81 | `const VALID_CATEGORIES = [...]` | Delete; import lib; strict `validateCategory` (105-111 rewritten) |
| `scripts/em-store.mjs` | 139-152, 191 | `updateTagsIndex` + call | APPEND sibling `updateCategoryIndex`; call after tags |
| `scripts/em-revise.mjs` | 159-166, 227 | inherits `origCategory`, no validation | Validate `origCategory` strict before write; APPEND + call `updateCategoryIndex` |
| `scripts/em-restore.mjs` | 40 | duplicate `VALID_CATEGORIES` | Delete; import lib |
| `scripts/em-restore.mjs` | 978-980 | `--category` filter validation | Route through `validateCategory({allowDeprecated:true})` |
| `scripts/em-restore.mjs` | apply loop (~1100-1130) | writes episode category unchecked | Validate canonical category before write; skip-and-surface unknown |
| `scripts/em-restore.mjs` | 1242-1260 | `valid_categories_match_em_store` self-test | Replace per REQ-17 |
| `scripts/em-rebuild-index.mjs` | 118-136 | writes index entry + `tags.json` | Carry `consolidates`/`superseded_by`; build `category-index.json`; add `--check` + drift counts |
| `scripts/em-search.mjs` | 175-203 | `--history` single-`supersedes` walk | Multi-parent walk (`superseded_by` + `consolidates`) |
| `scripts/em-search.mjs` | 262-263 | `--category` exact-match linear filter (ALREADY EXISTS, M1) | Index-back it via `category-index.json` + canonicalize + degrade fallback; preserve byte-identical active-name output |
| `scripts/em-prune.mjs` | 55-62 | `computePruneScore` | Add lifecycle gate reading `categoryLifecycle()` (score untouched) |
| `install.mjs` | 389-396 (§1b) | deploys `patterns/_index.json` globally | APPEND a sibling step deploying `categories.json` |
| `scripts/validate-schemas.mjs` | — | validates repo schemas | Add `categories.json` × `categories.schema.json` + `deprecated_for` resolution check |

## §10 Slice Ladder

One PR, implemented as ordered slices (each a green checkpoint; commit per slice).

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| P1a-S1 | Vocabulary as data | `categories.json`, `schemas/categories.schema.json`, `scripts/lib/categories.mjs`, `validate-schemas.mjs` | REQ-1,2,3 + safety fail-closed | `test-categories-lib.mjs` | No script edits yet |
| P1a-S2 | Strict write surfaces | `em-store.mjs`, `em-revise.mjs` | REQ-4, REQ-9 (store/revise index update) | `test-category-write.mjs` | No restore/search/prune yet |
| P1a-S3 | Restore matrix + self-test rewrite | `em-restore.mjs` | REQ-5,6,11,17 | in `test-category-write.mjs` + restore self-test | Don't touch em-search |
| P1a-S4 | Index + drift + new-field carry | `em-rebuild-index.mjs` | REQ-8,12,14 (rebuild half) | `test-category-index.mjs` | — |
| P1a-S5 | Read surfaces | `em-search.mjs` | REQ-7,10,14 (history walk) | `test-category-search.mjs`, `test-history-walk.mjs` | — |
| P1a-S6 | Prune lifecycle | `em-prune.mjs` | REQ-13 | `test-prune-lifecycle.mjs` | Protection set untouched |
| P1a-S7 | Deploy + docs + CI | `install.mjs`, guide, README, CI yml | REQ-15,16 | `test-install-categories.mjs` (mock E2E), docs grep | — |

### 10.1 Dependency graph

```text
S1 ── S2 ── S3
 │     └──── S4 ── S5
 └──────────────── S6
S1..S6 ─────────── S7
```

S1 is the hard dep for all (the lib). S4 (index) depends on S1 only. S5 `--category` depends on
S4 (needs `category-index.json`). S6 depends on S1 (lifecycle read). S7 last (deploy + docs).

## §11 Cut Order

If context/scope grows, cut in this order (preserves a shippable category axis):

1. REQ-14 `em-search --history` multi-parent walk → move to P1b (no P1a-internal consumer; R9 is P4).
2. REQ-11 restore category-index MERGE → fall back to "restore triggers a full rebuild" (simpler, pinned by the same test).

Do **not** cut:
- REQ-3 the shared lib + no-hardcoded-list grep (the whole point of R10b).
- REQ-4/5/6 the write/restore validation matrix (the conflation fix).
- REQ-15 global deployment of `categories.json` (deployed-script fail-open otherwise).

## §12 Contracts

### `validateCategory(name, {allowDeprecated=false}) → {ok, reason?, successor?}`

**Input contract:** `name` any string (possibly unknown); `allowDeprecated` boolean.
**Output contract:** discriminated on `ok`. `successor` present iff the member is deprecated.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. active | name is a member, no `deprecated_for` | `{ok:true}` | none |
| B. deprecated, disallowed | member has `deprecated_for`, `allowDeprecated=false` | `{ok:false, reason:"deprecated", successor}` | none |
| C. deprecated, allowed | member has `deprecated_for`, `allowDeprecated=true` | `{ok:true, successor}` | none |
| D. unknown | not a member | `{ok:false, reason:"unknown"}` | none |
| E. vocab unloadable | `categories.json` missing/malformed | THROWS `vocab-unloadable` | none — **only writers call this**; they catch and fail-closed (reject write) |

### `canonicalCategory(name) → name` and `categoryLifecycle(name) → lifecycle|null` (READER path — degrade, never throw, B1)

These two are the READER/index/prune entry points. They wrap `loadCategories()` in try/catch: on
`vocab-unloadable` they **degrade** rather than throw, so no reader surface is ever taken down by a
missing/malformed vocab (R10c row 3 "never fatal"; I3). Design decision (B1 fix): the fail direction
is a property of the CALLER's needs, encoded in WHICH lib function it calls — writers call
`validateCategory` (fail-closed), readers call `canonicalCategory`/`categoryLifecycle` (fail-open-degrade).

| Function | State | Condition | Output |
|---|---|---|---|
| `canonicalCategory` | A | active member | `name` |
| `canonicalCategory` | B | deprecated member | `deprecated_for` successor (one hop) |
| `canonicalCategory` | C | unknown | `name` (literal — the drift key) |
| `canonicalCategory` | D | **vocab unloadable** | `name` (literal — degrade; caller behaves as pre-R10) |
| `categoryLifecycle` | A | member | its `lifecycle` |
| `categoryLifecycle` | B | unknown / vocab unloadable | `null` (caller falls back to standard score) |

**Error codes / fail direction:**

| Code | Field | Trigger | Fail mode |
|---|---|---|---|
| `unknown-category` | `category` | write of a non-member | **closed** (reject write) |
| `deprecated-category` | `category` | write of a deprecated member | **closed** (reject, name successor) |
| `vocab-unloadable` (writer) | — | `categories.json` unreadable at a WRITE surface | **closed** — `validateCategory` throws; store/revise/restore-apply catch and reject the write |
| `vocab-unloadable` (reader) | — | `categories.json` unreadable at a READ/index/prune surface | **open-degrade** — `canonicalCategory`→literal, `categoryLifecycle`→null; `em-search --category` degrades to today's exact-match, `em-rebuild-index` builds index.jsonl+tags.json as before and skips category-index with a stderr warning, `em-prune` uses the standard score (B1) |

### `em-rebuild-index --check` → exit + JSON

**Output:** `{status, drift:[{id, category, kind:"unknown"|"deprecated", successor?}]}`; exit 1 iff `drift` non-empty. Reads only; writes nothing.

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | missing `categories.json` at a writer | writer fails closed (exit non-zero, no write) | `testCategoriesLibThrowsOnMissing` |
| EC2 | (symlink/isMain) — N/A | no path-authority predicate added | — |
| EC3 | concurrent `em-store` + `em-rebuild-index` on category-index (C4) | temp+rename → last-writer-wins, self-healing on next rebuild (same as tags.json; RFC:297 "no lock, racing builds self-heal") | `testCategoryIndexAtomicRename` (rename is atomic) AND `testCategoryIndexConcurrentStoreRebuild` (loop N stores while a rebuild runs; assert `category-index.json` is parseable at every read, then force a final rebuild and assert every id appears — the real concurrent probe, not just the rename primitive) |
| EC4 | `em-restore --apply` aborts mid-run on an unknown-category episode | that episode skipped + surfaced; VALID episodes already written stay; no torn category-index | `testRestoreApplySkipsUnknownCategory` |
| EC5 | empty/whitespace category string | treated as unknown → reject (writer) / literal drift key (index) | `testStoreRejectsUnknown` (empty leg) |
| EC6 | validate-then-write ordering in restore-apply | validation fires BEFORE the episode write, not after | `testRestoreApplySkipsUnknownCategory` (asserts zero files written) |
| EC7 | `em-search --history` on a cyclic `consolidates`/`superseded_by` fixture | cycle-safe via visited set; terminates | `testHistoryCycleSafe` |
| EC8 | index entry for a `workflow.lifecycle` category (dotted value) | parses fine (value, not key; rebuild regex `^(\w+):` keys only) | `testRebuildCarriesNewFields` (dotted-category leg) |
| EC9 | episode with a MISSING `category` field (undefined) at index build / search / prune (m3) | `canonicalCategory(undefined)`/`categoryLifecycle(undefined)` return a stable key (`"undefined"` literal or a guarded `unknown` bucket) / `null`; no crash; counted as drift | `testCategoryIndexUndefinedCategory` |
| EC10 | episode with a NON-SCALAR `category` (array/object, hand-planted) (m3) | reader coerces to a string key (never a live `[object Object]` collision); writers reject (unknown); counted as drift | `testCategoryNonScalarTolerated` |

## §14 Test Case Catalog

Runner per file: `node tests/test-<name>.mjs`.

```text
Group 1: categories lib + schema (test-categories-lib.mjs, ~8)
  testCategoriesJsonValidates        — categories.json instance-validates vs schema
  testCategoriesSchema               — schema rejects a bad lifecycle enum / extra prop
  testDeprecatedForMustResolve       — deprecated_for → deprecated successor fails validator
  testCategoriesLibResolution        — loadCategories() finds the file via import.meta.url
  testCategoriesLibThrowsOnMissing   — unloadable vocab throws (fail-closed)
  testValidateCategoryStates         — states A-D of §12 table
  testCanonicalCategory              — active/deprecated/unknown mapping
  testNoHardcodedCategoryList        — grep: no category-name array literal in scripts/*.mjs

Group 2: write surfaces (test-category-write.mjs, ~10)
  testStoreStrictAccept / testStoreRejectsDeprecated / testStoreRejectsUnknown
  testReviseValidatesInheritedCategory
  testStoreUpdatesCategoryIndex / testReviseUpdatesCategoryIndex
  testRestoreFilterAcceptsDeprecated / testRestoreFilterRejectsUnknown
  testRestoreApplySkipsUnknownCategory (zero-files negative control)
  testRestoreApplyWritesDeprecated

Group 3: index + drift (test-category-index.mjs, ~7)
  testCategoryIndexBuilt / testCategoryIndexDeprecatedMapped / testCategoryIndexUnknownCountedLiteral
  testCategoryIndexAtomicRename
  testRebuildCheckListsDrift / testRebuildCheckCleanExitsZero
  testRebuildCarriesNewFields (dotted-category + consolidates/superseded_by leg)

Group 4: read surfaces (test-category-search.mjs + test-history-walk.mjs, ~8)
  testSearchTolerantUnknownCategory / testListTolerantUnknownCategory
  testSearchCategoryUsesIndex / testSearchCategoryFallbackOnMissingIndex / testSearchCategoryCanonicalizesDeprecated
  testRestoreMergesCategoryIndex
  testHistoryFollowsSupersededBy / testHistorySurfacesConsolidatesSuccessor
  testHistorySingleSupersedesUnchanged / testHistoryCycleSafe

Group 5: prune lifecycle (test-prune-lifecycle.mjs, ~3)
  testTemporaryWithSuccessorPrunable / testTemporaryWithoutSuccessorSurvives / testStandardLifecycleUnaffected

Group 6: deploy + docs (test-install-categories.mjs, ~2)
  testInstallDeploysCategoriesJson (mock-project isolated-HOME E2E)
  testCategoriesJsonNotInClaudeHome
  testDocsGrepGate (grep EM_SCRIPTS_GUIDE for the new surfaces)
```

Planner-driven additions (§19.1), slotted into the groups above:
- Group 1/2: `testStoreFailsClosedOnMissingVocab` (B1 writer fail-closed).
- Group 3: `testRebuildDegradesOnMissingVocab` (B1), `testCategoryIndexUndefinedCategory` (m3/EC9), `testCategoryNonScalarTolerated` (m3/EC10).
- Group 4: `testSearchCategoryExactMatchUnchanged` (M1 regression pin), `testSearchDegradesOnMissingVocab` (B1), `testHistorySupersedesForkCharacterized` (m1).
- Group 5: `testPruneDegradesOnMissingVocab` (B1).
- Group 6: `testInstallDeployedStoreLoadsVocab` (M3 — invokes the deployed script).

Codex-driven additions (§19.2):
- Group 4: `testRecallTolerantUnknownCategory` (C1 — em-recall read tolerance, no-code-change pin).
- Group 3: `testCategoryIndexConcurrentStoreRebuild` (C4 — real concurrent store+rebuild probe).

Total: ~48 tests across 6 files. Every test name appears in §4 or is a §13 EC. The three
`*DegradesOnMissingVocab` tests each set `EM_CATEGORIES_PATH=/nonexistent` and assert exit 0 +
pre-R10 behavior (the B1 negative controls).

> No aspirational output: every test asserts real captured output (stdout JSON / exit code /
> written file contents / on-disk file location), never a constant or an echoed string. The
> install E2E asserts the on-disk path of the deployed file, not a log line.

> Install/deploy behavior (REQ-15) is proven by an isolated-`HOME` mock project + the REAL
> `install.mjs`, then reading the actual deployed tree — never mental-trace.

## §15 Verification Ledger (verify by artifact)

Filled with ACTUAL output at implementation time. Order rule: the evidence command runs
immediately before the claim.

| Claim | Command (strong-layer) | Observed artifact |
|---|---|---|
| Four-surface divergence exists TODAY (baseline) | fixture-store probes: `em-store --category workplan`; `em-restore --apply` of a workplan episode; `em-restore --category workplan`; `em-search`/`em-list` | _pending — exit codes + JSON_ |
| Matrix now consistent | same four probes post-impl | _pending — store rejects, restore skip-surfaces, search tolerant_ |
| All tests pass | `node tests/test-categories-lib.mjs` (+ the other 5) | _pending N/N pass each_ |
| No hardcoded category list | `grep -rnE "'(decision|discovery|milestone|lesson|violation)'" scripts/*.mjs` (broad-token) + reading pass | _pending — only lib references_ |
| category-index built | `em-rebuild-index --scope local` then read `category-index.json` | _pending — canonical keys_ |
| Deploys clean + P12 | mock `install.mjs`, then `ls ~/.episodic-memory/categories.json` AND `find ~/.claude -name categories.json` | _pending — present in EM, absent in .claude_ |
| CI green | `gh pr checks <PR>` | _pending — schema + test steps green_ |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Deployed scripts can't find `categories.json` (resolution wrong) | High | Med | `testInstallDeployedStoreLoadsVocab` (REQ-15) INVOKES the deployed `em-store` and asserts the vocab-list error — the resolution is exercised, not stat-ed (M3) |
| em-restore's 2470-line file hides an untested category-write path | Med | Med | grep every `category` reference (done, §9); apply-loop validation is the single choke point |
| `--history` walk regresses existing single-`supersedes` chains | Med | Low | `testHistorySingleSupersedesUnchanged` pins byte-identical output for the common case |
| Scope creep into T6/em-violation | Med | Med | §5 Non-Goals + §17 explicit defer; reviewer asked to hold the boundary |

## §17 Open Decisions

- **§17-A — Defer T6 `violated_pattern` migration to P1b.** Deferred to P1b; tracked as a GitHub issue at build time (Rule 18 step 9). 5 fields: (1) *Scenario:* em-pattern-health strike counting + em-recall preflight still read the `violated:bp-*` tag — works today, no failure. (2) *Spec:* RFC R10 T6 requires the typed field EVENTUALLY; it does not require it in the R10-category PR. (3) *History:* the tag-based read is the shipped status quo; no reviewer has flagged it broken. (4) *Same-class:* the entire T6 tag→typed-field class defers together (em-violation write + both readers) — no sibling left half-migrated. (5) *Residual:* if unaddressed, the `violated:bp-*` tag stays load-bearing (a T2 violation) until P1b — a known, bounded, documented gap, not silent corruption.
- **§17-B — Workplan recipe flip post-burn-in.** P1a enables `--category workplan` (dual-read); the CLAUDE.md recipe flip is a follow-up doc change. Tracked via §17-B note; no issue needed (doc-only, operator-owned).
- **§17-C — Full T2 grep guard with T6.** The `no tags.includes(<literal>)` conformance gate lands with the burn-in-shim machinery in P1b; P1a ships a lighter "no NEW tag branching introduced" check.
- **§17-D — `categories.json` location.** Decided: repo root (`categories.json`), schema under `schemas/`. Rationale: substrate artifact, must deploy globally like `patterns/_index.json`; repo-root + `../../` from `scripts/lib/` gives symmetric repo/deployed resolution (planner verified deployable: `install.mjs:294-303` copies `scripts/lib/*.mjs`, categories.mjs rides along, not in `relocatedOnlyLibs`). Not an OQ — recorded so the reviewer sees the reasoning.
- **§17-E — Pre-existing `em-search --history` supersedes-fork loss (m1).** A root superseded by two children keeps only one in the chain (`em-search.mjs:195-203` Map last-writer-wins). This is PRE-EXISTING, not introduced by P1a; `testHistorySupersedesForkCharacterized` pins current behavior so the multi-parent walk provably doesn't regress it. Fixing the fork-loss → deferred to a GitHub issue (Rule 18 step 9). 5 fields: (1) *Scenario:* history of a forked root drops a branch — runtime-probed `{"count":2,"chain":[root,childC]}`. (2) *Spec:* R2/R9 need the walk to follow `superseded_by`/`consolidates` (delivered); neither requires fixing legacy `supersedes` forks. (3) *History:* pre-existing since the walk shipped; unflagged until this audit. (4) *Same-class:* the fork-loss is a distinct edge from the many-to-one consolidation walk this PR adds; no sibling left half-done. (5) *Residual:* a forked revision chain under-reports one branch in `--history` output — a display gap, not data loss (both episodes still exist and index independently).

## §18 Done Criteria

- **RFC P1 R10 gate accounting (C5):** P1a discharges RFC acceptance rows **474-478 only** (categories.json/schema/lib + no-hardcoded-list; the write matrix; read tolerance; category index; temporary lifecycle). Rows **479-480 are P1b hard gates**, NOT satisfied here — row 479 (T6 `violated_pattern` migration + `em-recall`/`em-pattern-health` retarget) and row 480 (the T2 `tags.includes(<literal>)` conformance grep + burn-in-shim sunset markers) ship with the T6 work in P1b (§17-A, §17-C). P1a must not be described as fully satisfying the RFC's P1 R10 gate; the deferred rows carry issue links.
- [ ] All MUST requirements (REQ-1..17) passing (§4 tests green).
- [ ] The four-surface probe (§15) shows consistency where the baseline showed divergence.
- [ ] `grep` proves no hardcoded category list survives in any script.
- [ ] Mock-project E2E: `categories.json` in `~/.episodic-memory/`, absent from `~/.claude/`.
- [ ] Docs grep gate green; README table updated.
- [ ] Every deferred item (§17-A, §17-C) has a GitHub issue (Rule 18 step 9).
- [ ] `negative-scenario-planner` + codex review findings dispositioned (§19).

## §19 Review Consensus (Rule 18)

Second-opinion review after this draft. Per the canonical-agent dispatch rule, dispatch
`negative-scenario-planner` FIRST (schema/validator/multi-surface change), THEN codex via cmux
(default provider; standing directive). Hand off the complete bug-class: the R10c matrix as an
invariant table + the four surfaces + the fail-open controls + the "no fourth behavior" boundary.

```bash
node scripts/second-opinion.mjs request --provider codex --project <abs-repo-root> \
  --storage episodic --body-file docs/plans/rfc-009-p1a.md --summary "RFC-009 P1a R10 taxonomy plan review" --dispatch
```

| Pass | Reviewer | Provider/Model | Blocker count | Verdict | Reply episode |
|---|---|---|---|---|---|
| 1 | negative-scenario-planner | (subagent) | 4 (B1 + M1/M2/M3) | HOLD → folded §19.1 | — |
| 2 | codex | codex gpt-5.5 high (cmux) | 5 (3 blocker + 2 major) | HOLD → folded §19.2 | (cmux session, 2m37s) |
| 3 | codex | codex gpt-5.5 high (cmux) | 3 (2 blocker + 1 major, executability) | HOLD → folded §19.3; design validated | (cmux session, 1m57s) — converged at cap |

Review in three layers: per-file (each script's matrix row) → cross-file (the lib is the single
source; the four surfaces agree) → PR-level (docs + deploy + CI coherence). Cap at 2 codex rounds;
a 3rd same-class HOLD means the matrix boundary is wrong, not the patch.

### 19.1 Resolved blockers (negative-scenario-planner pass 1, 2026-07-06 — HOLD)

Planner ran real fixture probes; every finding accepted. Format: Finding / Verdict / Evidence / Required action.

| # | Finding (R-anchor) | Verdict | Evidence | Required action (folded) |
|---|---|---|---|---|
| B1 | Vocab-unloadable is fatal on reader/index/prune surfaces — contradicts §7 "readers tolerant" + R10c row 3 "never fatal"; makes core rebuild vocab-dependent (R10c/R10d/I3) | ACCEPT | Probe: `em-rebuild-index` has zero vocab dependency today; REQ-8/10/13 add `canonicalCategory`/`categoryLifecycle` calls that would throw | §12 split fail-direction by function (writers `validateCategory`→closed; readers `canonicalCategory`/`categoryLifecycle`→degrade); I3 rewritten; §7 gains the reader-regression row; 3 degrade tests added |
| M1 | `em-search --category` already exists (exact-match, `em-search.mjs:262-263`); mis-catalogued NEW → no regression pin (R10d) | ACCEPT | Probe `em-search --category workplan` → `count:1` today | REQ-10 + §9 baseline corrected; `testSearchCategoryExactMatchUnchanged` regression pin added |
| M2 | Event-writer family bypasses the lib (I2 over-claimed) — `em-review-request`, `bp1-*`, `lib/bp1-episode-writer` emit constant `workflow.lifecycle` (R10c write rows, T2) | ACCEPT w/ mod | Repo grep: only 2 `VALID_CATEGORIES` arrays; event-writers hardcode a single constant | I2 weakened to substrate write surfaces; I2b disposition row added (safe, self-heals); §A.8 grep allow-list note |
| M3 | REQ-15 mitigation/test mismatch — §16 claims deployed-script exercise, test only stats file (verify-the-strong-claim) | ACCEPT | Step 7.2 asserted locations only | REQ-15 + §16 + step 7.2 now INVOKE deployed `em-store --category bogus`, assert vocab-list error (`testInstallDeployedStoreLoadsVocab`) |
| m1 | `--history` supersedes-fork lossy today (`em-search.mjs:195-203`) | ACCEPT | Probe fork `[A,C]` drops B | `testHistorySupersedesForkCharacterized` pins behavior; §17-E defers the fix with an issue |
| m2 | "dual-read both work" imprecise — recipe is an AND (R10b/T6) | ACCEPT | Recipe `--tag workplan --category decision` | §5 dual-read semantics stated precisely |
| m3 | Category edge shapes — undefined / non-scalar `category` uncovered (R10c/R10d) | ACCEPT | `canonicalCategory` returns non-string key | EC9/EC10 added |
| m4 | §A.8 grep omits `workflow.lifecycle`/`workplan`/`temporary` (REQ-3) | ACCEPT | Alternation incomplete | §A.8 alternation broadened + reading-pass backstop |
| DEFER | T6 `violated_pattern` migration deferred to P1b — SAFE slice boundary (5 fields) | ACCEPT | em-prune R6 uses episode-id links (`em-prune.mjs:113-116`), not the tag; nothing in P1a reads `violated:bp-*` | §17-A kept; issue filed at build time |

### 19.2 Resolved blockers (codex round 1, 2026-07-06 — HOLD, gpt-5.5 high, cmux)

Codex ran real probes (workplan recall, source reads of em-rebuild/em-search/install/validate-schemas/em-prune/em-recall). All accepted.

| # | Finding (R-anchor) | Verdict | Evidence | Required action (folded) |
|---|---|---|---|---|
| C1 | REQ-7 read-tolerance names only em-search/em-list; RFC R10c:231 + gate row 476 require em-recall too | ACCEPT | no `testRecallTolerant` in §14 | REQ-7 gains em-recall + `testRecallTolerantUnknownCategory` (S5 step 5.3); no code change, regression pin |
| C2 | A.7 step 7.2 not updated to match the REQ-15/§19.1 M3 fix — still stats the file | ACCEPT | step 7.2 asserted locations only | step 7.2 rewritten to INVOKE the deployed `em-store --category bogus` and assert the vocab-list error (`testInstallDeployedStoreLoadsVocab`) |
| C3 | A.7 anchors non-verbatim + grep-stub verifies (e.g. step 1.4 "schema-list array" — validate-schemas uses discovery) | ACCEPT | `validate-schemas.mjs:14-17,49` is discovery | user chose LOW altitude → every A.7 EDIT anchor rewritten to a verbatim-unique substring from current source; verifies made falsifiable (semantic asserts / named tests, not grep-existence); step 1.4 corrected (auto-discovery + MIN_SCHEMA_DOCS 17→18) |
| C4 | EC3 concurrency maps only to `testCategoryIndexAtomicRename` — no concurrent probe (RFC:297) | ACCEPT | §14 listed only the rename primitive | EC3 + `testCategoryIndexConcurrentStoreRebuild` (S4 step 4.5): loop stores during a rebuild, assert always-parseable, then rebuild asserts all ids |
| C5 | §18 implied P1a satisfies the full P1 R10 gate; rows 479-480 (T6 + tag-branch guard) are P1b | ACCEPT | gate rows 474-480 | §18 gate-accounting bullet: P1a discharges rows 474-478 only; 479-480 are P1b with issue links |

Also surfaced while hardening C3: the **R6×R10e interaction** (a consumed `temporary` in a `consolidates` array — R10e aggressive-prune must override R6 class-c) — folded into REQ-13 + step 6.1 + `testTemporaryWithSuccessorOverridesClassC`.

### 19.3 Resolved blockers (codex round 2, 2026-07-06 — HOLD → converged, gpt-5.5 high, cmux)

Round 2 attacked the round-1 fixes (not a rubber-stamp) and validated the DESIGN ("problems are in exact executability, not the high-level matrix"; "the R6/R10e override is directionally coherent"). Three residual executability bugs, each with an exact remedy — all folded. Two substantive codex rounds is the cap (MEMORY `…a2aa`); the residuals are mechanical spec-precision with codex's dictated fix, not a same-class boundary dispute, so the review is CONVERGED without a round 3.

| # | Finding (R-anchor) | Verdict | Evidence | Required action (folded) |
|---|---|---|---|---|
| C6 | step 1.5/REQ-2 used `validateInstance` from `lib/mini-jsonschema.mjs`, which exports only `lintSchema` | ACCEPT | `validateInstance` is in `lib/json-instance-validate.mjs:513` | REQ-2 + step 1.5 now use `validateInstance` from `json-instance-validate.mjs` |
| C7 | step 3.3 set `category_skips` on the summary, but `buildWritePlan` (em-restore.mjs:777) never returns `categorySkips` — out of scope | ACCEPT | return object at L777 lists only 6 fields | step 3.3 now adds `categorySkips` to the `buildWritePlan` return AND sets `category_skips: plan.categorySkips` |
| C8 | step 2.1 deleted `VALID_CATEGORIES` (USAGE:83 depends on it) without importing `loadCategories` | ACCEPT | USAGE interpolates the member list | step 2.1 imports `loadCategories`; USAGE derives names in a try/catch fallback (`'see categories.json'` when unloadable) so `--help` never crashes; the write path still fails closed |

**Review outcome:** planner HOLD + codex R1 HOLD + codex R2 HOLD, all folded; design validated across both codex rounds; converged at the 2-round cap. Ready for Rule 18 step 4 (final plan + operator approval).

### 19.4 Post-implementation code review (negative-scenario-reviewer, 2026-07-06 — ACCEPT)

Dispatched on `git diff main..HEAD` (S1-S7) per the canonical-agent dispatch rule, with mandatory
behavior-simulation (real scripts against isolated fixture stores, `EM_CATEGORIES_PATH` to plant
vocabularies / force unloadable). Walked all 9 attack axes + I1-I5 + EC1-EC10.

| Axis | Runtime result |
|---|---|
| 1 fail-direction (B1) | 3 writers exit 1 no-write; 3 readers/index/prune exit 0 degrade |
| 2 validate-before-write (I4) | revise reject → original md5 unchanged, status active |
| 3 restore skip-and-surface | unknown skipped+surfaced zero-write; deprecated written verbatim |
| 4 category-index (EC8/9/10) | dotted/undefined/non-scalar keys stable; no [object Object]; atomic |
| 5 --history (EC7) | superseded_by + consolidates followed; fork LWW; cycle terminates |
| 6 --check (R10f) | lists all drift, exit 1, index.jsonl mtime unchanged |
| 7 prune R10e | override beats class-c; P0 set byte-untouched (17/17) |
| 8 deploy (M3) | deployed em-store resolves ../../categories.json; none under .claude/ |
| 9 no-hardcoded (I1) | no VALID_CATEGORIES array; only I2b constants/comparisons |

**Verdict: ACCEPT — 0 BLOCKER/MAJOR/MINOR/NIT.** One inherited-by-design class note (multi-scope
partial-index under-report, mirrors the pre-existing `--tag` block) dispositioned out-of-scope and
filed as #459. No step-7 fixes required. Deferred issues #457/#458/#459 filed (step 9).

## §20 Lessons Encoded (traceability)

| Lesson | One-line rule | Enforced in |
|---|---|---|
| behavior-simulation-not-static-analysis | runtime-probe the four surfaces; cite JSON | §3, §15 |
| verify-the-strong-claim | deploy = mock E2E reading the deployed tree, not repo copy | §15, REQ-15 |
| mock-project-not-mental-trace | install behavior via isolated-HOME + real install.mjs | §14, REQ-15 |
| canonical-agent dispatch | negative-scenario-planner before self-walk | §7, §19 |
| fixture-change ledger | the em-restore self-test edit is enumerated, not "stays green" | REQ-17, §A.9 |
| enforcement-gate-only-repo-src | this plan file write is not gated; deliverables are data-plane | §1, §7 |
| bp1 step-9 5-field DEFER | §17-A carries all 5 fields + gets an issue | §17, §18 |
| Rule 12 token budget | wc -l done, baseline + optimized | §6 |
| no-hardcoded-drift-pair | one lib kills the em-store/em-restore duplicate + its drift test | REQ-3, REQ-17 |

---

# Appendix A: Mechanical Execution Spec (low-capability executor)

## A.0 Target-toolchain instantiation

| Key | Value for this plan |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check (§A.4) | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-<name>.mjs` → `<N>/<N> pass` |
| New-function phrasing (§A.6) | `export function fnName(args) { … }` |
| Portable break-input override | argv flag / env `EM_CATEGORIES_PATH=<bad-path>` (POSIX); tests set it via `process.env` in-proc |
| Search tool for verifies | `grep -n` / `grep -c` / `grep -rnE` from repo root |
| Repo-specific done-commands | `node scripts/validate-schemas.mjs`; mock-project `install.mjs` E2E |

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/rfc-009-p1a.md
```
Expected: matches only §0.2/§A.1 template quotes + §17 "Decided" prose. Acceptance: no match falls
inside an §A.7 step-table row. Record the match list beside the lint run. Also do a reading pass
over Appendix A (line-grep misses wrapped occurrences, lesson `…2f5d`).

## A.2 Executor contract

1. Steps in numeric order; no skip/reorder/batch.
2. Each step names one file, the exact change, and its verify.
3. Make no design decisions; missing verbatim anchor → STOP (§A.3).
4. Run the verify after each step; fix only that step until green.
5. Edit exactly ONE file per step. Read-only refs: `docs/rfcs/RFC-009-lesson-activation.md`, `patterns/taxonomy.schema.json`.
6. One command per verify — no `;`/`&&`/`||`/pipes/subshells (compound-bash gate).
7. One slice = one commit `P1a-Sn: <title>` + the `Co-Authored-By` trailer.
8. No commit/push/PR until §18 green AND operator approval (Rule 18 step 4 marker fires on the FINAL plan).
9. No aspirational output — every emitted "checking X" line is backed by an assertion doing X.

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
| Branch | `git branch --show-current` | `feat/rfc-009-p1a` |
| Clean tree | `git status --porcelain` | empty |
| Baseline tests | `node tests/test-em-restore.mjs` | current N/N pass |
| Runtime | `node --version` | `v20`+ |

## A.5 Shared constants / types

```js
// scripts/lib/categories.mjs (created in S1). No placeholders — exact values:
//   export const CATEGORIES_PATH = new URL('../../categories.json', import.meta.url)
//   export function loadCategories() { /* read+parse CATEGORIES_PATH or EM_CATEGORIES_PATH; THROW on fail */ }
//   export function validateCategory(name, { allowDeprecated = false } = {}) { /* §12 table */ }
//   export function canonicalCategory(name) { /* §12 table */ }
//   export function categoryLifecycle(name) { /* member.lifecycle || null (canonicalized) */ }
// Launch vocabulary (categories.json), lifecycle: temporary=aggregate-then-prune, rest=standard:
//   decision, discovery, milestone, context, research, lesson, violation, workflow.lifecycle, workplan, temporary
```

## A.6 Anchor format

Standard (§A.6 of PLAN_TEMPLATE): `ANCHOR` = verbatim unique substring; label each step CREATE /
EDIT / APPEND. Literal strings/regexes spelled verbatim.

## A.6b Falsifiable Verify

Every verify names the observed value + expected concrete value and fails on a stub. Negative
controls run as their own row (single command, env/argv break-input), never `;`-chained.

## A.7 Per-slice step tables

### `P1a-S1` — Vocabulary as data

**Files:** `categories.json`, `schemas/categories.schema.json`, `scripts/lib/categories.mjs`, `scripts/validate-schemas.mjs`, `tests/test-categories-lib.mjs`. **Read-only:** `patterns/taxonomy.schema.json`.

| Step | File | Kind | Exact action | Verify (observed → expected) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4. | rows pass |
| 1.1 | `categories.json` | CREATE | Full verbatim contents: `{ "version": "1.0.0", "categories": [ {"name":"decision","description":"…","lifecycle":"standard"}, …8 standard members…, {"name":"workplan","description":"…","lifecycle":"standard"}, {"name":"temporary","description":"transient working episodes: review threads, scratch context","lifecycle":"aggregate-then-prune"} ] }` — exactly the 10 §A.5 members; no `deprecated_for` at launch. | `node -e "const c=JSON.parse(require('fs').readFileSync('categories.json','utf8')); if(c.categories.length!==10) process.exit(1); if(!c.categories.find(m=>m.name==='temporary'&&m.lifecycle==='aggregate-then-prune')) process.exit(1)"` → exit 0 (observed: 10 members, temporary is aggregate-then-prune; a wrong count or missing member exits 1) |
| 1.2 | `schemas/categories.schema.json` | CREATE | Meta-schema mirroring `patterns/taxonomy.schema.json`: `$schema` 2020-12, `required:["version","categories"]`, `additionalProperties:false`, `categories` items `required:["name","description","lifecycle"]` + `additionalProperties:false`, `lifecycle` `enum:["standard","aggregate-then-prune"]`, optional `deprecated_for` string, `name` pattern `^[a-z][a-z0-9.]*$`. | `node scripts/validate-schemas.mjs --project "$PWD" --json` → JSON `.docs` array INCLUDES `schemas/categories.schema.json` AND `.status==="ok"` (observed: the new doc is auto-discovered by the `schemas/` walk and lints clean; a malformed schema doc makes `.status==="violations"`) |
| 1.3 | `scripts/lib/categories.mjs` | CREATE | Exports per §A.5. `loadCategories` reads `process.env.EM_CATEGORIES_PATH || new URL('../../categories.json', import.meta.url)`; THROWS `new Error('categories.json unloadable: '+e.message)` on read/parse fail. `validateCategory` per §12 states A-E (throws on unloadable). `canonicalCategory`/`categoryLifecycle` wrap load in try/catch and DEGRADE per §12 (literal / null), never throw. | `node -e "import('./scripts/lib/categories.mjs').then(m=>{if(m.validateCategory('lesson').ok!==true)process.exit(1); if(m.validateCategory('bogus').reason!=='unknown')process.exit(1); if(m.canonicalCategory('bogus')!=='bogus')process.exit(1)})"` → exit 0 (observed: active→ok, unknown→reason unknown, canonical of unknown→literal) |
| 1.4 | `scripts/validate-schemas.mjs` | EDIT | ANCHOR: `const MIN_SCHEMA_DOCS = 17; // the P0 contract floor (17 schema docs shipped in P0)` → REPLACE `17`→`18` and update the comment to `// P0 floor 17 + categories.schema.json (P1a) = 18`. (NO other edit — `categories.schema.json` is auto-discovered by the existing `schemas/` walk, L49/L124; instance-validation of `categories.json` is a TEST, step 1.5, not this validator's job.) | `node scripts/validate-schemas.mjs --project "$PWD" --json` → `.docs_checked` ≥ 18 AND `.status==="ok"` (observed: floor bumped, new doc counted; reverting categories.schema.json to malformed flips status) |
| 1.5 | `tests/test-categories-lib.mjs` | CREATE | Full verbatim Group-1 tests (§14) — each asserts a captured return value, no `assert(true)`: `testCategoriesJsonValidates` (instance-validate `categories.json` against `schemas/categories.schema.json` via `validateInstance` from `lib/json-instance-validate.mjs` (L513); assert `valid===true` — C6: `validateInstance` is NOT in mini-jsonschema.mjs), `testDeprecatedForMustResolve` (plant a temp vocab whose `deprecated_for` names a deprecated member; assert the validator reports it), `testValidateCategoryStates` (states A-D of §12), `testCanonicalCategory`, `testCategoriesLibThrowsOnMissing` (set `EM_CATEGORIES_PATH` to a nonexistent path; assert `validateCategory` THROWS but `canonicalCategory('x')==='x'` does NOT), `testNoHardcodedCategoryList` (grep `scripts/*.mjs` for a category-name ARRAY literal; assert only `lib/categories.mjs` matches). Register in `main()`. | `node tests/test-categories-lib.mjs` → `<N>/<N> pass` (observed count printed) |
| 1.6 | — | — | Negative control (B1 asymmetric fail direction, lib-level): with vocab unloadable, `validateCategory` (writer path) throws but `canonicalCategory` (reader path) degrades. | `EM_CATEGORIES_PATH=/nonexistent/categories.json node -e "import('./scripts/lib/categories.mjs').then(m=>{let threw=false; try{m.validateCategory('lesson')}catch{threw=true}; if(!threw)process.exit(1); if(m.canonicalCategory('lesson')!=='lesson')process.exit(1)})"` → exit 0 (observed: validateCategory throws, canonicalCategory returns literal — the two sides of §12). The WRITER-refuses E2E is step 2.x. |
| 1.7 | — | — | Commit `P1a-S1: categories.json + schema + lib` + trailer. | `git log -1 --oneline` → contains `P1a-S1` |

### `P1a-S2` — Strict write surfaces (em-store, em-revise)

**Files:** `scripts/em-store.mjs`, `scripts/em-revise.mjs`, `tests/test-category-write.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 2.1 | `scripts/em-store.mjs` | EDIT | ANCHOR: `const VALID_CATEGORIES = ['decision', 'discovery', 'milestone', 'context', 'research', 'lesson', 'violation', 'workflow.lifecycle']` (L81) → delete it; add `import { loadCategories, validateCategory, canonicalCategory } from './lib/categories.mjs'` near the other lib imports (L29-30) — **include `loadCategories` (C8): the USAGE string depends on the member list**. Then ANCHOR: `const USAGE = \`--project <name> --category <${VALID_CATEGORIES.join('|')}> ...` (L83) → REPLACE the interpolation to derive names fail-safely: `let catNames; try { catNames = loadCategories().categories.map(c=>c.name).join('|') } catch { catNames = 'see categories.json' }` and use `${catNames}` (so `--help`/USAGE never crashes when the vocab is unloadable — the WRITE path still fails closed via `validateCategory`). Then ANCHOR: `if (!VALID_CATEGORIES.includes(category)) {` (L105) → REPLACE the whole `if` block (L105-111) with `let catV; try { catV = validateCategory(category) } catch (e) { console.log(JSON.stringify({status:'error', message: e.message})); process.exit(1) } if (!catV.ok) { console.log(JSON.stringify({status:'error', message: catV.reason==='deprecated' ? \`Category "${category}" is deprecated; use "${catV.successor}"\` : \`Invalid category "${category}"\`})); process.exit(1) }`. | `node scripts/em-store.mjs --project t --category bogus --summary s --body b --scope local` → stdout `{"status":"error"…Invalid category "bogus"…}` exit 1 (observed message names the offending value) |
| 2.2 | `scripts/em-store.mjs` | APPEND | Add `export function updateCategoryIndex(dataDir, episodeId, category)` at end of file, structurally mirroring `updateTagsIndex` (L139-152): read `category-index.json` (default `{}`), `const key = canonicalCategory(category)`, push `episodeId` to `index[key]` if absent, write temp+rename. | (behavior, not existence) `node scripts/em-store.mjs --project t --category lesson --summary s2 --body b --scope local` then `node -e "const i=require('<local>/category-index.json'); if(!(i.lesson||[]).length) process.exit(1)"` → exit 0 (observed: the stored id appears under key `lesson`; a stub that writes nothing exits 1) |
| 2.3 | `scripts/em-store.mjs` | EDIT | ANCHOR: `updateTagsIndex(dataDir, id, tags)` (L191) → add on the next line `updateCategoryIndex(dataDir, id, category)`. | covered by 2.2's behavior verify (the index only populates because the call fires) |
| 2.4 | `scripts/em-revise.mjs` | EDIT | ANCHOR: `if (m[1] === 'category') origCategory = m[2]` (L166) → after the frontmatter parse, before the write, add `import`+`const rv = validateCategory(origCategory); if(!rv.ok){ error naming reason+successor; exit 1 }`. Separately ANCHOR: `updateTagsIndex(dataDir, id, mergedTags)` (L250) → add `updateCategoryIndex(dataDir, id, origCategory)` after (import from em-store or lib). | revise of a hand-planted `category: <deprecated>` episode → exit 1 naming the successor (observed error string); revise of an active-category episode → exit 0 and its id appears under the canonical key in `category-index.json` |
| 2.5 | `tests/test-category-write.mjs` | CREATE | Full verbatim Group-2 store/revise tests + `testStoreFailsClosedOnMissingVocab` (B1: `EM_CATEGORIES_PATH=/nonexistent`, spawn em-store, assert exit≠0 + no episode file). Each asserts captured stdout JSON + on-disk `category-index.json` contents. Register `main()`. | `node tests/test-category-write.mjs` → `<N>/<N> pass` |
| 2.6 | — | — | Commit `P1a-S2: strict store/revise + category-index update` + trailer. | `git log -1 --oneline` → contains `P1a-S2` |

### `P1a-S3` — Restore matrix + self-test rewrite

**Files:** `scripts/em-restore.mjs`, `tests/test-category-write.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 3.1 | `scripts/em-restore.mjs` | EDIT | ANCHOR: `const VALID_CATEGORIES = ['decision', 'discovery', 'milestone', 'context', 'research', 'lesson', 'violation', 'workflow.lifecycle']` (L40) → delete it + its two mirror-sync comment lines (L37-39); add `import { validateCategory, canonicalCategory } from './lib/categories.mjs'`. | `grep -c "VALID_CATEGORIES = \[" scripts/em-restore.mjs` → 0 (observed: array literal gone) |
| 3.2 | `scripts/em-restore.mjs` | EDIT | ANCHOR: `if (!VALID_CATEGORIES.includes(c)) {` (L979) → REPLACE the guard body with `const fv = validateCategory(c, {allowDeprecated:true}); if (!fv.ok) { throw new Error(\`Invalid --category "${c}". Must be in the vocabulary.\`) }`. | in-proc: filter `['workflow.lifecycle']` accepted; `['bogus']` throws `/Invalid --category/` (observed: deprecated names pass, unknown throws) |
| 3.3 | `scripts/em-restore.mjs` | EDIT | ANCHOR: `let action = decideAction(conflict, conflictMode)` (L682) → immediately after, add `const cv = validateCategory(canonicalCategory(entry.fm.category), {allowDeprecated:true}); if (!cv.ok) { categorySkips.push({ targetPath, id: entry.fm.id, category: entry.fm.category, reason: 'unknown category not in vocabulary' }); action = 'skip' }`. Declare `const categorySkips = []` beside `const duplicateSkips = []` (L665); **add `categorySkips` to `buildWritePlan`'s return object** (L777, which today returns `{ episodeWrites, docWrites, refusedClaudeMd, sidecarConflicts, symlinkSkips, duplicateSkips }` — without this the var is out of scope in the summary, C7); then set `category_skips: plan.categorySkips` in the summary object (L1089, beside `duplicate_skips: plan.duplicateSkips`). Validation precedes the write (EC6). | in-proc apply of a backup whose only episode is `category: bogus` → target `episodes/` has 0 new `.md` AND `summary.category_skips.length===1` (observed: skip+surface, the inversion of RFC evidence item 4) |
| 3.4 | `scripts/em-restore.mjs` | EDIT | ANCHOR: `mergeIndexes(targetDir, restoredEntries, force ? 'force' : conflictMode)` (L1129) → after it, update `category-index.json` for `restoredEntries` (push each id under `canonicalCategory(fm.category)`, temp+rename) OR call the rebuild; pin whichever in `testRestoreMergesCategoryIndex`. | `testRestoreMergesCategoryIndex`: after apply, the target `category-index.json` holds the restored id under its canonical key (observed on disk) |
| 3.5 | `scripts/em-restore.mjs` | EDIT | ANCHOR: `skip('valid_categories_match_em_store', 'em-store.mjs not present alongside (likely installed copy); drift check skipped')` (inside the T1 block, L1242-1260) → REPLACE the whole T1 block with `test_categories_from_shared_lib`: grep-assert both `em-store.mjs` and `em-restore.mjs` source contain `from './lib/categories.mjs'`, and assert `loadCategories().length===10`. (Fixture-change ledger, §A.9: the old grep-for-array test is obsolete once the array is deleted in 3.1.) | `node scripts/em-restore.mjs --self-test` → results list contains passing `test_categories_from_shared_lib` and NO `valid_categories_match_em_store` (observed) |
| 3.6 | `tests/test-category-write.mjs` | EDIT | ANCHOR: the `main()` test-registration list → add `testRestoreFilterAcceptsDeprecated`, `testRestoreFilterRejectsUnknown`, `testRestoreApplySkipsUnknownCategory`, `testRestoreApplyWritesDeprecated`, `testRestoreMergesCategoryIndex` (REQ-5,6,11). | `node tests/test-category-write.mjs` → `<N>/<N> pass` |
| 3.7 | — | — | Commit `P1a-S3: restore validation matrix + self-test`. | `git log -1` shows `P1a-S3` |

### `P1a-S4` — Index + drift + new-field carry

**Files:** `scripts/em-rebuild-index.mjs`, `tests/test-category-index.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 4.1 | `scripts/em-rebuild-index.mjs` | EDIT | ANCHOR: `supersedes: fm.supersedes || null,` (inside the `entries.push(JSON.stringify({…}))` object, L126) → add on following lines `...(Array.isArray(fm.consolidates) ? { consolidates: fm.consolidates } : {}),` and `...(typeof fm.superseded_by === 'string' ? { superseded_by: fm.superseded_by } : {}),`. | plant an episode with `consolidates: [x]` + `superseded_by: y`; `em-rebuild-index --scope local` then `node -e "const r=require('fs').readFileSync('<local>/index.jsonl','utf8'); const row=r.trim().split('\n').map(JSON.parse).find(e=>e.superseded_by==='y'); if(!row||row.consolidates[0]!=='x')process.exit(1)"` → exit 0 (observed: both fields carried; a no-op edit drops them → exit 1) |
| 4.2 | `scripts/em-rebuild-index.mjs` | EDIT | ANCHOR: `for (const tag of normalizedTags) {` (L132, the tagsIndex build in `rebuildDir`) → alongside it build `const catKey = canonicalCategory(fm.category); (categoryIndex[catKey] ||= []).push(fm.id)` and increment `driftUnknown`/`driftDeprecated` when `validateCategory(fm.category)` reports unknown/deprecated. Declare `const categoryIndex = {}` beside `const tagsIndex = {}` (L105). ANCHOR: `fs.renameSync(tagsTmp, tagsFile)` (L145) → after it, write `category-index.json` via temp+rename the same way. Import lib. | `em-rebuild-index --scope local` then `node -e "const i=require('<local>/category-index.json'); if(!Object.keys(i).length)process.exit(1)"` → exit 0 (observed: canonical keys present) |
| 4.3 | `scripts/em-rebuild-index.mjs` | EDIT | ANCHOR: `return { scope: label, count: entries.length }` (L147) → extend to `return { scope: label, count: entries.length, category_drift: { unknown: driftUnknown, deprecated: driftDeprecated } }`. | rebuild over a store with 1 hand-planted unknown-category episode → JSON `.rebuilt[].category_drift.unknown` includes that category with count 1 (observed) |
| 4.4 | `scripts/em-rebuild-index.mjs` | EDIT | ANCHOR: `const scope = flag('--scope') || 'all'` (L34) → after arg parse add a `--check` branch: scan episode frontmatter, collect `{id, category, kind, successor?}` for every unknown/deprecated category, print `{status:'ok', drift:[…]}`, `process.exit(drift.length ? 1 : 0)`, write NOTHING. Update the `--help` usage line to mention `--check`. | `em-rebuild-index --check --scope local` on a clean store → exit 0, `drift:[]`; on a store with a planted unknown category → exit 1, `drift[0].id` names it, and `index.jsonl` mtime unchanged (observed: read-only) |
| 4.5 | `tests/test-category-index.mjs` | CREATE | Full verbatim Group-3 tests: `testCategoryIndexBuilt`, `testCategoryIndexDeprecatedMapped`, `testCategoryIndexUnknownCountedLiteral`, `testCategoryIndexAtomicRename`, `testCategoryIndexConcurrentStoreRebuild` (C4: spawn N `em-store` while a rebuild runs; assert `category-index.json` parses at every read, then force a rebuild and assert all ids present), `testRebuildCheckListsDrift`, `testRebuildCheckCleanExitsZero`, `testRebuildCarriesNewFields` (dotted-category + consolidates/superseded_by, EC8), `testCategoryIndexUndefinedCategory` (EC9), `testCategoryNonScalarTolerated` (EC10), `testRebuildDegradesOnMissingVocab` (B1: `EM_CATEGORIES_PATH=/nonexistent`, assert rebuild still writes index.jsonl+tags.json + exit 0 + stderr warn + no category-index). Register `main()`. | `node tests/test-category-index.mjs` → `<N>/<N> pass` |
| 4.6 | — | — | Commit `P1a-S4: category-index + --check drift` + trailer. | `git log -1 --oneline` → contains `P1a-S4` |

### `P1a-S5` — Read surfaces (em-search)

**Files:** `scripts/em-search.mjs`, `tests/test-category-search.mjs`, `tests/test-history-walk.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 5.1 | `scripts/em-search.mjs` | EDIT | ANCHOR: `results = results.filter(e => e.category === category)` (L263 — the EXISTING exact-match filter, M1) → REPLACE its INTERNALS to index-back: canonicalize `category`, read `category-index.json` for each active scope, intersect ids; on missing/corrupt index set `searchWarning` and fall back to the current linear `e.category === category` scan. Import lib (`canonicalCategory`). An active-name query must return the SAME set as today. | `em-search --category lesson --scope local` → same rows as pre-change (regression); corrupt `category-index.json` → same rows + stderr rebuild warning (observed) |
| 5.2 | `scripts/em-search.mjs` | EDIT | ANCHOR: `bySupersedes.set(e.supersedes, e)` (L197, inside the `--history` forward-walk) → extend the forward map to also honor `e.superseded_by` edges, and for the queried id surface any active episode whose `consolidates` array names it; guard with a `visited` Set (cycle-safe). The single-`supersedes` walk output is unchanged. | history of a `superseded_by`-planted episode → chain includes the successor; a `supersedes`-fork fixture → behavior matches `testHistorySupersedesForkCharacterized`; a plain single-`supersedes` fixture → byte-identical chain to pre-change (observed) |
| 5.3 | `tests/test-category-search.mjs` | CREATE | Full verbatim tests: `testSearchTolerantUnknownCategory`, `testListTolerantUnknownCategory`, `testRecallTolerantUnknownCategory` (C1 — hand-plant an unknown-category row, run `em-recall`, assert it ranks/returns without crash), `testSearchCategoryExactMatchUnchanged` (M1 regression pin), `testSearchCategoryUsesIndex`, `testSearchCategoryFallbackOnMissingIndex`, `testSearchCategoryCanonicalizesDeprecated`, `testSearchDegradesOnMissingVocab` (B1), `testRestoreMergesCategoryIndex`. Register `main()`. | `node tests/test-category-search.mjs` → `<N>/<N> pass` |
| 5.4 | `tests/test-history-walk.mjs` | CREATE | Full verbatim REQ-14 tests: `testHistoryFollowsSupersededBy`, `testHistorySurfacesConsolidatesSuccessor`, `testHistorySingleSupersedesUnchanged`, `testHistorySupersedesForkCharacterized` (m1), `testHistoryCycleSafe` (EC7). Register `main()`. | `node tests/test-history-walk.mjs` → `<N>/<N> pass` |
| 5.5 | — | — | Commit `P1a-S5: em-search --category index-backing + multi-parent history` + trailer. | `git log -1 --oneline` → contains `P1a-S5` |

### `P1a-S6` — Prune lifecycle

**Files:** `scripts/em-prune.mjs`, `tests/test-prune-lifecycle.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 6.1 | `scripts/em-prune.mjs` | EDIT | ANCHOR: `const score = computePruneScore(entry)` (L228, inside `pruneDir`'s selection loop) → immediately BEFORE it insert the aggregate-then-prune override: `if (categoryLifecycle(canonicalCategory(entry.category)) === 'aggregate-then-prune' && typeof entry.superseded_by === 'string') { toPrune.push({ ...entry, _pruneScore: 0 }); continue }`. This OVERRIDES the R6 protection set for consumed temporary members (a consumed temporary sits in its successor's `consolidates` array → R6 class-c would protect it, but R10e makes the consumed member prunable — the member's own aggregate-then-prune lifecycle wins; RFC R10e "the consumed members are not [protected]"). Import `{ categoryLifecycle, canonicalCategory }`. `computePruneScore` untouched. | aged `temporary` row WITH `superseded_by` → in `toPrune` even when ALSO named in a `consolidates` array (override); aged `temporary` row WITHOUT `superseded_by` → survives at standard score; aged `standard`-category row in a `consolidates` array → still protected (class-c unchanged) (observed via `--dry-run` JSON) |
| 6.2 | `tests/test-prune-lifecycle.mjs` | CREATE | Full verbatim Group-5 tests with aged fixtures: `testTemporaryWithSuccessorPrunable`, `testTemporaryWithSuccessorOverridesClassC` (the R6×R10e interaction — temporary member in a consolidates array still prunable), `testTemporaryWithoutSuccessorSurvives`, `testStandardLifecycleUnaffected`, `testStandardConsolidatesMemberStillProtected`, `testPruneDegradesOnMissingVocab` (B1: `EM_CATEGORIES_PATH=/nonexistent` → standard score, no crash). Register `main()`. | `node tests/test-prune-lifecycle.mjs` → `<N>/<N> pass` |
| 6.3 | — | — | Commit `P1a-S6: per-category prune lifecycle` + trailer. | `git log -1 --oneline` → contains `P1a-S6` |

### `P1a-S7` — Deploy + docs + CI

**Files:** `install.mjs`, `docs/EM_SCRIPTS_GUIDE.md`, `README.md`, `.github/workflows/<ci>.yml`, `tests/test-install-categories.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 7.1 | `install.mjs` | EDIT | ANCHOR: `// 1b. Copy patterns/_index.json for global pattern validation` (L389, through its `if` block L392-396) → APPEND immediately after (before the `// 1c.` comment L398) a sibling step: `const repoCategories = path.join(REPO_DIR, 'categories.json'); if (fs.existsSync(repoCategories)) { fs.mkdirSync(GLOBAL_DIR, { recursive: true }); fs.copyFileSync(repoCategories, path.join(GLOBAL_DIR, 'categories.json')); console.log(\`Installed categories.json to ${GLOBAL_DIR}\`) }`. | after a mock install (step 7.2), the deployed file exists at `<fakeHOME>/.episodic-memory/categories.json` |
| 7.2 | `tests/test-install-categories.mjs` | CREATE | Mock-project isolated-HOME E2E (verify-the-strong-claim, M3/C2): set `HOME`+`USERPROFILE` to a fresh temp dir, run REAL `install.mjs --tool claude-code`, then: (a) `testInstallDeploysCategoriesJson` — assert `<fakeHOME>/.episodic-memory/categories.json` exists; (b) `testCategoriesJsonNotInClaudeHome` — assert NO `categories.json` anywhere under `<fakeHOME>/.claude/` (P12); (c) `testInstallDeployedStoreLoadsVocab` — INVOKE the DEPLOYED `<fakeHOME>/.episodic-memory/scripts/em-store.mjs --category bogus …` with cwd in a fake project, assert exit≠0 + the vocab-list invalid-category message (proves `../../categories.json` resolves from the deployed `scripts/lib/`, not the repo copy). Register `main()`. | `node tests/test-install-categories.mjs` → `<N>/<N> pass` (the deployed-store leg is the M3 fix — it RUNS the script, not stats the file) |
| 7.3 | `docs/EM_SCRIPTS_GUIDE.md` | EDIT | ANCHOR: the `em-search` section heading → document `--category` (index-backed), `--check` (em-rebuild-index), `category-index.json`, `categories.json`, the R10 category-vs-tags semantics, and the temporary lifecycle in the relevant script sections. | `grep -c 'category-index.json' docs/EM_SCRIPTS_GUIDE.md` → ≥1 AND `grep -c 'categories.json' docs/EM_SCRIPTS_GUIDE.md` → ≥1 |
| 7.4 | `README.md` | EDIT | ANCHOR: the script/data table → add rows/notes for `categories.json`, `--category`, `category-index.json`. | `grep -c 'categories.json' README.md` → ≥1 |
| 7.5 | `.github/workflows/plan-marker-validate.yml` | EDIT | ANCHOR: the existing test-run step block (the workflow that runs on every PR with no paths filter) → add explicit `node tests/test-*.mjs` steps for the 6 new files + a `node scripts/validate-schemas.mjs --project "$PWD"` step. (Curated-list workflow: an unwired test never runs — the check-actual-CI lesson.) | `grep -c "test-categories-lib" .github/workflows/plan-marker-validate.yml` → ≥1; post-PR `gh pr checks <PR>` shows the steps green |
| 7.6 | `tests/test-install-categories.mjs` | EDIT | ANCHOR: the `main()` registration → add `testDocsGrepGate` (grep `docs/EM_SCRIPTS_GUIDE.md` for each new surface: `categories.json`, `category-index.json`, `--category`, `--check`). | `node tests/test-install-categories.mjs` → passes incl. docs gate |
| 7.7 | — | — | Commit `P1a-S7: deploy categories.json + docs + CI` + trailer. | `git log -1 --oneline` → contains `P1a-S7` |

## A.8 Definition of done (mechanical)

```bash
node tests/test-categories-lib.mjs      # → N/N pass
node tests/test-category-write.mjs      # → N/N pass
node tests/test-category-index.mjs      # → N/N pass
node tests/test-category-search.mjs     # → N/N pass
node tests/test-history-walk.mjs        # → N/N pass
node tests/test-prune-lifecycle.mjs     # → N/N pass
node tests/test-install-categories.mjs  # → N/N pass (mock E2E)
node scripts/validate-schemas.mjs       # → exit 0, categories.json validated
grep -rnE "'(decision|discovery|milestone|lesson|violation|context|research|workplan|temporary|workflow\.lifecycle)'" scripts/*.mjs  # → only lib/categories.mjs (m4: full vocab alternation). Reading-pass backstop for wrapped/multi-line lists. NOTE: single-value 'workflow.lifecycle' constants in the event-writer family (I2b) are an expected allow-list, not an array literal.
```

## A.9 Blast-radius patterns

- **Red-then-green:** the lib-level control (1.6) proves the asymmetric fail direction (writer
  `validateCategory` throws, reader `canonicalCategory` degrades); `testStoreFailsClosedOnMissingVocab`
  (2.5) proves the WRITER refuses to write with an unreachable vocab; the three `*DegradesOnMissingVocab`
  tests prove the readers survive it — a guard never observed failing guards nothing.
- **Pure-extraction first:** S1 ships the lib with ZERO script edits (existing tests stay green)
  before S2 rewires the writers — the P3a/P3b-1 pattern.
- **Fixture-change ledger (REQ-17):** the em-restore `valid_categories_match_em_store` self-test
  is a behavior change to an existing test; step 3.5 enumerates the exact replacement (name +
  new assertion), never "existing tests stay green."
- **Discriminating fixture:** the restore-apply negative control asserts ZERO new files on disk
  (not "exit 0"), so a write-then-validate regression is observable.
- **Mock-project E2E for deploy (REQ-15):** the REAL `install.mjs` against an isolated HOME, then
  read the deployed tree — never mental-trace.
- **Flag high-blast-radius:** S3 (em-restore, 2470 lines) and S5 (em-search `--history`) are marked
  "focused review before build" — the spec removes ambiguity, not the need for a human look.
