# NAPMEM-C Topic Tracks Plan

## §1 Status

Plan review round 2 accepted the original contract. S2 core implementation exposed a frozen-plan omission plus engine, CLI, and output-schema defects that shallow smoke checks did not cover. Amendment review round 3 returned HOLD; round 4 accepted the folded current-state repair contract. The sequenced build is complete. The first frozen-diff review findings were folded and locally green. Final frozen review then returned HOLD on four bounded same-class defects recorded in §19.3. Those repairs are complete with a green local ledger, final GLM ACCEPT, and an 8/8 independent fallback probe. Current stage: **ready to file the three deferred issues, commit the exact slice, and open a draft PR**.

| Field | Value |
|---|---|
| RFC | `RFC-001 Phase 4`, with later constraints from `RFC-012 R2a/R2d` |
| Parent requirements | `RFC-001 Phase 4`, `RFC-012 B-2/B-3/B-5, R2a, R2d` |
| Workplan episode | `20260723-022429-workplan-v239-issue-546-closed-napmem-c--84eb` |
| Target branch | `feat/napmem-c-topic-tracks` |
| Executor altitude (§0.1) | `low` |

### 1.1 S2 resync boundary

S1 and the first S2 core pass already changed the working tree. The resync builder must not replay original CREATE anchors. It executes the current-state repair rows 2.1 and 2.2, verifies the already-applied row 2.3, then executes rows 2.3a through 2.5 in order. Each repair row names current bytes that must exist before editing; a missing current anchor uses the A.3 STOP protocol.

## §2 Episode Search Summary

Commands run 2026-07-23:

```bash
node scripts/em-search.mjs --tag workplan --category decision --limit 1 --scope all --full --no-score --no-track
node ~/.episodic-memory/scripts/em-search.mjs --read 20260714-081618-napmem-assessment-arxiv-2607-05794-routi-68d9 --full --scope all --no-track --no-score
node ~/.episodic-memory/scripts/em-recall.mjs --project episodic-memory --task-type implementation --scope all --limit 5 --no-track
```

Key active memories:

- `20260723-022429-workplan-v239-issue-546-closed-napmem-c--84eb`: NAPMEM-C is queue head after RFC-012 P2 and issue #546.
- `20260714-081618-napmem-assessment-arxiv-2607-05794-routi-68d9`: the approved coding item is derived per-topic episodes with provenance, entered through RFC-001 Phase 4 and reusing typed `promotion_sources` from RFC-012 R2a.
- `20260723-000645-multi-agent-approach-playbook-v5-adds-fr-f806`: freeze this file before builder dispatch, use it as reviewer ground truth, and resync every builder after a spec edit.
- `20260722-133545-consolidated-tiered-multi-agent-orchestr-99bf`: PR workflow is scout, plan, sequenced build, frozen-diff review, fold, independent verify, commit, draft PR, CI.

The recalled file and flag claims were checked on disk. `scripts/lib/promotion-sources.mjs`, `scripts/lib/registered-stores.mjs`, `scripts/lib/store-write-lock.mjs`, `scripts/em-store.mjs --promotion-sources-json`, the `learning` registry slot, and the learning descriptor validator all exist on the target branch.

## §3 Objective

Ship an on-demand `em-topic-tracks` learning-strategy command that deterministically groups related active source episodes from the global store and registered project stores, previews one global lesson candidate per topic, and writes only explicitly confirmed candidates. Every written lesson carries typed, content-bound `promotion_sources`; source episodes remain byte-identical and active. The feature is proven by an isolated-HOME gauntlet, runtime schema validation, a real-install deployment test, plugin-registry validation, documentation parity, and the existing regression suites.

## §4 Requirements (Ground Truth)

| ID | Requirement | Parent R | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | `scripts/em-topic-tracks.mjs` is a new on-demand `learning` member. It scans the global store plus every consumer-registry project store, and it writes derived episodes only to the global store. | RFC-001 Phase 4; RFC-012 B-3 | `testScansGlobalAndRegisteredStores`, `testWritesGlobalOnly`, `testLearningRegistryEntry` | MUST | A new command preserves the charter boundary: `em-consolidate` remains curation and does not derive new knowledge. |
| REQ-2 | Defaults live in `scripts/topic-tracks/config.json`, validate against `schemas/topic-tracks-config.schema.json`, and load fail-closed through `loadTopicTracksConfig()`. The values are tag Jaccard `0.3`, summary-word Jaccard `0.2`, minimum cluster `3`, warning count `1000`, hard cap `2000`, common-tag support `0.5`, and source categories `decision`, `lesson`, `research`. | RFC-001 Phase 4; RFC-012 B-5; Principle 2 | `testCommittedConfigValid`, `testConfigDefaults`, `testMalformedConfigFailsClosed`, `testConfigBoundaryRejects` | MUST | `EM_TOPIC_TRACKS_CONFIG_PATH` is the test and break-input override. |
| REQ-3 | Eligible rows are active, non-superseded source episodes in the configured categories. Rows already carrying `promotion_sources`, rows tagged `topic-track`, malformed rows, missing episode files, and local stores without a resolvable `store_id` are excluded and surfaced in schema-valid `warnings` or `missing_sources`; they never become fabricated provenance. A missing unreadable file cannot claim a content hash, so its `missing_sources` row contains only `store_id` and `episode_id`. | RFC-001 Phase 4; RFC-012 R2a | `testEligibilityFilters`, `testDerivedRowsDoNotFeedBack`, `testMissingFileSurfaces`, `testMissingStoreIdentitySurfaces` | MUST | Global sources use reserved store id `global`. |
| REQ-4 | Member identity is `{store_id, episode_id, content_sha256}`. Content hashes use `computeContentSha256()`. Byte-identical replicas are counted once, while same-id different-content episodes in distinct stores remain distinct. | RFC-012 R2a | `testReplicaCollapses`, `testSameIdDifferentContentStaysDistinct`, `testCrlfLfHashContract` | MUST | Prevents clone stores from manufacturing cluster size. |
| REQ-5 | Pair matching is deterministic: normalized tag Jaccard at or above `0.3` OR summary-token Jaccard at or above `0.2`; connected components form clusters; only clusters with at least three distinct content identities survive. Candidate and member order is lexical and stable. | RFC-001 Phase 4 | `testTagThresholdCluster`, `testSummaryThresholdCluster`, `testBelowBothThresholdsExcluded`, `testMinCluster`, `testDeterministicOrdering` | MUST | Summary tokens use the existing zero-dependency relevance tokenizer. |
| REQ-6 | Each candidate contains a deterministic summary, chronological body, majority-supported common tags, sorted typed `promotion_sources`, sorted member metadata, and a 64-hex fingerprint computed from canonical promotion sources. | RFC-001 Phase 4; RFC-012 R2a/R2d | `testCandidateShape`, `testChronologicalBody`, `testFingerprintStable`, runtime IO schema validation | MUST | The body lists source summaries and source references; it does not invent claims beyond source text. |
| REQ-7 | Dry-run is the default and performs no directory, episode, index, tags, config, registry, or lock-file write. `--auto` is rejected with exit 2 and `auto-write-withdrawn`; unknown flags, positional arguments, and unsupported `--flag=value` spellings are rejected with exit 2 and `unknown-flag`. The later RFC-012 B-2 confirmation rule replaces RFC-001's old automatic write proposal. | RFC-001 Phase 4; RFC-012 B-2 | `testDryRunWritesNothing`, `testAutoRejected`, `testUnknownFlagRejected` | MUST | Reading existing files is permitted; an absent global store is treated as an empty read source until apply. |
| REQ-8 | `--apply` requires one or more repeated `--confirm <fingerprint>` values. Unknown, stale, duplicate, or malformed confirmations fail closed. A confirmed candidate is rescanned and rehashed while the global and source-store `clerk-apply.lock` locks are held, immediately before its write. | RFC-012 R2d | `testApplyRequiresConfirm`, `testUnknownConfirmRejected`, `testStaleFingerprintRejected`, `testDuplicateConfirmRejected`, `testRevalidationUnderLock` | MUST | Use `acquireStoreWriteLocksSync()` and release in `finally`; create no new lock class. |
| REQ-9 | Each confirmed fresh candidate writes one category `lesson` global episode through the real `em-store.mjs --promotion-sources-json` path. Tags are `topic-track` plus candidate common tags, project is the lexical winner among the most frequent real source projects, and the write output returns `episode_id` plus fingerprint. | RFC-001 Phase 4; RFC-012 R2a/B-3 | `testConfirmedWriteShape`, `testTypedProvenanceRoundTrip`, `testProjectIsRealSourceProject` | MUST | No direct episode or index writer is added. |
| REQ-10 | Source episode bytes, source index bytes, and source tags bytes are unchanged after apply. Exact typed source sets already present on an active global `topic-track` lesson are reported as `already-derived` and are not written again. | RFC-001 Phase 4; Principle 7 | `testSourcesUntouched`, `testExactIdempotency` | MUST | Growing or overlapping non-identical source sets produce a new snapshot in this slice; revision chaining is a tracked follow-up. |
| REQ-11 | Candidate count and input size are bounded. More than `1000` eligible members adds a warning. More than `2000`, or more than a lower `--max-episodes N`, exits 2 before clustering or locking. CLI overrides may only tighten the committed hard cap. | RFC-001 Phase 4; RFC-012 B-4 | `testWarningThreshold`, `testHardCap`, `testOverrideCannotRaiseCap` | MUST | O(n²) is bounded before pair construction. |
| REQ-12 | A dedicated runtime IO schema covers help-independent dry-run, successful apply, and structured error outputs. `learning/em-topic-tracks.json` points at that schema and a dedicated gauntlet; the generic learning descriptor accepts capability-owned runtime schema paths while retaining repo-contained path validation. | CAPABILITIES complete-contract rule; RFC-008 R8 | `testRuntimeIoSchema`, `testDescriptorSchema`, `testLearningRegistryEntry`, `node scripts/validate-plugin-registry.mjs --project "$PWD" --json` | MUST | Registry schema version remains `1.2.0`; adding an instance does not change the existing learning slot. |
| REQ-13 | The top-level script and its `scripts/topic-tracks/` subtree deploy globally. A real isolated-HOME `install.mjs` run proves the entry, engine, and config are byte-identical and runnable from the deployed tree. No copy lands under tool-specific enforcement directories. | Principles 3, 11, 12 | `testTopicTracksRealInstall` | MUST | Add `topic-tracks` to `GLOBAL_SCRIPT_SUBTREES`; no direct `install.mjs` branch is added. |
| REQ-14 | Agent guidance and user docs say topic-track derivation is shipped, on-demand, global-write, confirm-gated, and searchable as ordinary lesson episodes. They do not claim a new ranking algorithm or autonomous/session-end hook. | Principle 5; RFC-001 instructions | `testTopicTrackDocsParity` | MUST | Five instruction surfaces plus guide/manual must agree. |
| REQ-15 | RFC-001 Phase 4 records the vocabulary migration from `source_episodes` to `promotion_sources`, withdrawal of `--auto` writes, global-only learning classification, and mapped shipped evidence without rewriting or checking the obsolete historical boxes. CAPABILITIES lists `em-topic-tracks` as a learning member and corrects stale em-promote provenance prose. `learning/em-promote.json` truthfully declares the confirmation that shipped in #559. | RFC-001 Phase 4; RFC-012 R2a/R2d confirmation invariant | `testSpecAndCapabilityParity`, `testLearningDescriptorHonesty`, `node scripts/em-rfc-validate.mjs` | MUST | Historical boxes remain unchecked and are explicitly superseded by a dated resolution block. |
| REQ-16 | All new test suites are first-class CI steps and pass `test-ci-suite-registration`. Existing consolidation, promotion, provenance, lock, plugin registry, schema, install, and RFC validators stay green. | Rule 18 | `test-ci-suite-registration`, §15 ledger | MUST | No test is silently omitted from CI. |

## §5 Non-Goals

- No change to the existing near-duplicate, clerk, enrichment, or fold modes in `scripts/em-consolidate.mjs`.
- No change to `scripts/em-promote.mjs`, its fingerprint contract, or its graduation date. The already-shipped confirmation truth is corrected in its descriptor only.
- No automatic, session-end, hook, or background invocation.
- No new recall scoring, index type, graph traversal, transcript route, or `em-search` flag.
- No source supersession, archival move, body edit, or local-store derived write.
- No LLM summarization, embeddings, network request, or external dependency.
- No topic-track revision chain in this slice. Exact source-set idempotency ships now; growing-track revision semantics are deferred in §17.
- No deploy to the live `~/.episodic-memory` tree before merge. This PR tests an isolated install only.

## §6 Token Budget (Rule 12)

`wc -l` was run before planning. New files are shown as zero-line baselines.

| File group | Baseline lines | Planned write size | Notes |
|---|---:|---:|---|
| `scripts/em-topic-tracks.mjs`, `scripts/topic-tracks/{engine.mjs,config.json}` | 0 | ~650 | Thin CLI, pure engine, data defaults |
| `schemas/topic-tracks-config.schema.json`, `schemas/runtime/topic-tracks-io.schema.json` | 0 | ~230 | Closed JSON Schemas |
| `learning/em-topic-tracks.json`, `learning/em-promote.json`, `plugins/_index.json`, `plugins/learning-descriptor.schema.json` | 155 existing | ~48 | Learning registration plus the pre-existing em-promote label correction |
| `scripts/lib/install-manifest.mjs`, `tests/test-install-scripts-subtrees.mjs` | 850 | ~2 | Global subtree classification and its exact-list regression |
| `tests/test-topic-tracks.mjs`, `tests/test-install-topic-tracks.mjs` | 0 | ~850 | Runtime and real-install gauntlets |
| `.github/workflows/tests.yml`, `tests/test-ci-suite-registration.mjs` | 1,017 | ~6 | CI registration; registration test changes only if its current discovery contract requires it |
| `CAPABILITIES.md`, RFC, guide, manual, five instruction files | 3,319 | ~120 | Contract and honest-label parity |
| `docs/PLAN.md` | 0 | planning artifact | Orchestrator-owned |

Baseline single-seat context is approximately 105k tokens. Optimized execution uses three sequenced stages with narrow file sets, approximately 45k, 65k, and 45k seat tokens before review. A stage stops before autocompaction if its status bar exceeds 80% context.

## §7 Safety / Security

| Concern | Severity | Failure scenario | Mitigation | Test(s), including negative |
|---|---|---|---|---|
| Forged provenance | High | An index row names an episode or store whose bytes cannot be read. | Resolve real store identities, hash the episode file, skip and surface every unresolved member. | `testMissingFileSurfaces`, `testMissingStoreIdentitySurfaces`; negative malformed store fixture |
| TOCTOU | High | A user confirms preview A, then source bytes change before write. | Reacquire all involved store locks, rebuild the candidate, and require the same fingerprint immediately before `em-store`. | `testStaleFingerprintRejected`, `testRevalidationUnderLock`; break flag mutates one source after preview |
| Concurrent writers | High | Two applies or an apply and ordinary store write tear global indexes. | Reuse canonical `clerk-apply.lock` through `acquireStoreWriteLocksSync`; child `em-store` inherits the parent lock. | `testConcurrentApplySerializes`, existing `test-store-write-concurrency.mjs` |
| Path escape | High | A registered project path or config override crosses the intended authority boundary. | Registered-store resolver supplies canonical store dirs; config override must be a regular JSON file, and no caller-provided output path exists. | registered-store existing gauntlet; `testConfigSymlinkRejected` |
| Replica inflation | Medium | A copied episode appears in several stores and manufactures the minimum cluster size. | Collapse byte-identical `{episode_id, content_sha256}` replicas before clustering. | `testReplicaCollapses` and distinct-content positive control |
| Autonomous writes | High | Legacy `--auto` silently creates lessons. | Reject `--auto`; require `--apply` plus per-candidate fingerprints. | `testAutoRejected`, `testApplyRequiresConfirm` |
| Derived feedback loop | Medium | Topic-track lessons become new members and recursively amplify themselves. | Exclude rows with typed provenance and the `topic-track` tag. | `testDerivedRowsDoNotFeedBack` |
| Quadratic denial of service | Medium | An unbounded registry creates an O(n²) pair matrix. | Enforce the hard cap before pair iteration; CLI can only lower it. | `testHardCap`, `testOverrideCannotRaiseCap` |

Eight-axis path and multi-actor matrix:

| Axis | Negative shape | Expected disposition |
|---|---|---|
| A. config authority | missing, malformed, directory, symlink | fail closed before scan; no write |
| B. registry authority | absent, malformed, vanished project, missing identity | degrade with warnings for reads; never fabricate provenance |
| C. source bytes | missing, unreadable, CRLF, changed after preview | surface/normalize/reject stale fingerprint |
| D. identity | clone replica, same id different body, alias, global | collapse only true replicas; preserve distinct content; resolve aliases; reserve global |
| E. confirmation | none, unknown, malformed, duplicate, stale, subset | refuse invalid values; write exactly the fresh confirmed subset |
| F. concurrency | same candidate, different candidates, ordinary store writer | serialize through canonical store locks; no torn index |
| G. bounds | 0, 2, 3, 1000, 1001, 2000, 2001 members | deterministic empty/minimum/warn/hard-stop behavior |
| H. deployment | repo run, isolated installed run, missing subtree artifact | both real paths work; missing artifact fails real-install test |

## §8 Design

### 8.1 Key types

```js
/** @typedef {{store_id:string, episode_id:string, content_sha256:string}} PromotionSource */
/** @typedef {{source:PromotionSource, store_dir:string, project:string, category:string, date:string, summary:string, tags:string[], body:string}} TopicMember */
/** @typedef {{fingerprint:string, common_tags:string[], summary:string, body:string, promotion_sources:PromotionSource[], members:Array<{store_id:string,episode_id:string,project:string,category:string,date:string,summary:string}>}} TopicCandidate */
/** @typedef {{version:string,tag_jaccard_min:number,summary_jaccard_min:number,min_cluster:number,warn_episodes:number,max_episodes:number,common_tag_support:number,source_categories:string[]}} TopicTracksConfig */
```

### 8.2 Key invariants

- The learning command writes only global category `lesson` episodes through `em-store`.
- `promotion_sources` is the provenance identity. Tags are recall aids, never provenance identity.
- Source files, indexes, and tags are read-only.
- A fingerprint is `sha256(serializePromotionSources(promotion_sources))`.
- Candidate ordering and every array ordering are deterministic.
- Every apply revalidates under canonical locks; every release occurs in `finally`.
- Cross-platform: use `os.tmpdir()`, `path`, `spawnSync(process.execPath, args)`, and Node file APIs; tests use argv break flags, not POSIX env-prefix commands.
- Atomicity: the new feature owns no direct writer. Existing locked `em-store` atomic/index behavior is the only write path.

### 8.3 Resolution and flow

```text
load closed config
  -> resolve global + registered stores
  -> load eligible active rows and source bytes
  -> normalize/collapse replicas
  -> bounded pair comparison and union-find
  -> deterministic candidates + fingerprints
  -> dry-run JSON
  -> for each confirmed candidate: acquire all involved locks
       -> rescan and recompute candidate
       -> compare fingerprint
       -> spawn em-store with typed promotion_sources
       -> release locks
  -> apply JSON
```

## §9 Existing Hook Points

| File | Current anchor | What it does today | Impact |
|---|---|---|---|
| `scripts/lib/registered-stores.mjs` | `export function resolveRegisteredStores` | Resolves canonical project stores and typed store ids. | Read-only import. |
| `scripts/lib/promotion-sources.mjs` | `serializePromotionSources`, `computeContentSha256` | Validates, sorts, serializes, hashes typed provenance. | Read-only import. |
| `scripts/lib/store-write-lock.mjs` | `acquireStoreWriteLocksSync`, `releaseStoreWriteLocks` | Owns canonical `clerk-apply.lock`. | Read-only import. |
| `scripts/lib/relevance.mjs` | `normalizeTags`, `tokenizeQuery` | Supplies the existing normalized tag and summary-token vocabulary. | Read-only imports from `../lib/relevance.mjs`; the engine owns a local three-line set-Jaccard helper. |
| `scripts/lib/categories.mjs` | `loadCategories`, `canonicalCategory` | Loads and canonicalizes the closed category vocabulary. | Read-only imports from `../lib/categories.mjs`; config categories validate before scanning. |
| `scripts/em-store.mjs` | `--promotion-sources-json` and global scope | Writes typed lesson provenance and indexes. | Spawned child writer; no edit. |
| `plugins/_index.json` | existing `learning` entry for `em-promote` | Registers learning members. | Append second learning entry. |
| `learning/em-promote.json` | `confirm_gated:false` and future-tense P2-S4 summary | Carries a stale label although confirmed apply shipped in #559. | Set `confirm_gated:true` and make the summary present tense; no em-promote runtime change. |
| `plugins/learning-descriptor.schema.json` | `io_schema` const | Restricts every member to the em-promote-specific schema path. | Replace with contained runtime-schema path pattern. |
| `scripts/lib/install-manifest.mjs` | `GLOBAL_SCRIPT_SUBTREES` | Classifies recursively deployed script subtrees. | Add `topic-tracks`. |
| `.github/workflows/tests.yml` | em-promote and consolidation suite steps | Runs capability gauntlets. | Add topic-track runtime and install steps. |

## §10 Slice Ladder

| Slice | Objective | Primary files | Deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| NAPMEM-C-S1 | Contracts and definitions | config, two schemas, two descriptors, plugin index, learning descriptor schema | Closed data/config/IO contracts, registered member, and honest shipped confirmation label | schema + plugin registry checks | No runtime edits |
| NAPMEM-C-S2 | Runtime and distribution | entry, engine, install manifest | Deterministic dry-run, confirm-gated apply, global deployment | runtime gauntlet + real-install gauntlet | No docs or RFC edits |
| NAPMEM-C-S3 | Documentation and CI parity | workflow, RFC, CAPABILITIES, guide, manual, five instruction files | CI registration and honest shipped labels | docs parity, RFC validator, CI registration | No runtime behavior edits |

Dependency graph: `S1 -> S2 -> S3`. Each stage is built and verified in order on one branch. Builders do not commit.

## §11 Cut Order

If the slice grows beyond one reviewable PR, cut in this order:

1. CAPABILITIES prose cleanup unrelated to the new member's honest label.
2. Growing-topic revision semantics, already deferred in §17.
3. User-manual examples beyond one dry-run and one confirmed apply.

Do not cut typed provenance, per-item confirmation, stale-fingerprint rejection, source immutability, hard bounds, runtime schema, plugin registration, real-install coverage, or CI registration.

## §12 Contracts

### `loadTopicTracksConfig(pathOverride) -> TopicTracksConfig`

| State | Condition | Output | Side effects |
|---|---|---|---|
| valid | regular parseable JSON, exact required keys, every bound valid | frozen normalized object | read only |
| missing | file absent/unreadable | throw `topic-tracks-config-unloadable` | none |
| malformed | parse or shape invalid | throw `topic-tracks-config-invalid` | none |
| symlink | `lstat` reports symbolic link | throw `topic-tracks-config-symlink` | none |

Bounds: both Jaccard values and common support are `(0,1]`; `min_cluster >= 3`; `warn_episodes >= min_cluster`; `max_episodes >= warn_episodes`; category strings are unique and non-empty.

### `collectTopicMembers({globalDir, registeredStores, config}) -> {members,warnings,missing_sources}`

| State | Condition | Output | Side effects |
|---|---|---|---|
| eligible | row and file satisfy REQ-3 | one content-bound member | reads file |
| replica | same episode id and content hash already present | no second member, warning `replica-collapsed` | none |
| no identity | local store has no `store_id` | no member, warning `store-identity-unavailable` | none |
| missing file | index row has no readable episode file | no member, `missing_sources` row | none |
| derived | row carries `promotion_sources` or tag `topic-track` | no member | none |
| ineligible | wrong category/status/superseded | no member | none |

Replica identity for collapse is exactly `{episode_id,content_sha256}` across stores. `store_id` remains part of each retained member's provenance but is deliberately absent from the replica-collapse key.

### `buildTopicCandidates(members, config) -> TopicCandidate[]`

| State | Condition | Output | Side effects |
|---|---|---|---|
| below minimum | component has fewer than `min_cluster` distinct content identities | absent | none |
| matched | tag threshold OR summary threshold passes through connected components | one deterministic candidate | none |
| over hard cap | member count exceeds effective cap | throw `topic-tracks-max-episodes` before pair loop | none |
| exact prior | global active track has exactly the same canonical sources | skipped record `already-derived` | none |

### `applyTopicCandidate(candidate, confirmed, context) -> result`

| State | Condition | Output | Side effects |
|---|---|---|---|
| unconfirmed | fingerprint absent from confirmed set | `confirm-required` | none |
| unknown/malformed/duplicate | confirmation does not map one-to-one to preview | error, exit class 2 | none |
| stale | under-lock rescan differs | `stale-fingerprint` | locks only, released |
| lock timeout | any involved store lock unavailable | `store-write-lock-timeout` | no episode write |
| exact prior | same canonical sources now exist | `already-derived` | no episode write |
| fresh | same fingerprint under lock | `{fingerprint,episode_id}` | one global em-store write |
| child failure | em-store nonzero or malformed output | `store-write-failed` | no claimed success; existing writer recovery contract applies |

CLI exit classes: `0` successful help/dry-run/apply; `1` runtime/config/lock/write error; `2` invalid flags or positional arguments, bounds, confirmation, `--auto`, or hard-cap refusal. Every structured CLI output validates against `schemas/runtime/topic-tracks-io.schema.json`; the usage error for an unrecognized argument is `unknown-flag`.

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | Empty registry and empty global store | dry-run returns zero candidates | `testEmptyWorld` |
| EC2 | Config override is symlink | fail closed before store read | `testConfigSymlinkRejected` |
| EC3 | Two concurrent applies | canonical locks serialize and exact idempotency leaves one lesson | `testConcurrentApplySerializes` |
| EC4 | em-store child fails | structured error, no success row, lock released | `testChildFailureReleasesLock` |
| EC5 | Empty source identity | member is skipped and warning is non-empty | `testMissingStoreIdentitySurfaces` |
| EC6 | Validate then write ordering | stale source is rejected before em-store spawn | `testRevalidationUnderLock` |
| EC7 | Same id and same bytes in cloned stores | one member | `testReplicaCollapses` |
| EC8 | Same id but distinct bytes | two members | `testSameIdDifferentContentStaysDistinct` |
| EC9 | Exact threshold values | included; one epsilon below both excluded | threshold tests |
| EC10 | Cluster chain A-B, B-C, A not C | one deterministic connected component | `testTransitiveCluster` |
| EC11 | Existing exact derived track | skipped with no write | `testExactIdempotency` |
| EC12 | `--apply` plus a subset of candidate confirmations | only that subset writes; unconfirmed candidates report `confirm-required` | `testConfirmedSubsetOnly` |

## §14 Test Case Catalog

`tests/test-topic-tracks.mjs`:

- Configuration and CLI: committed config/schema validity, defaults, malformed input, extra-key/version rejection, bound rejection, symlink rejection, unknown flag/positional/equals rejection, and exit-class mapping.
- Collection: empty world with no directory creation, global and registered stores, eligibility filters, derived exclusion, schema-valid missing file, missing identity, cross-store replica collapse, same-id distinct bytes, CRLF/LF hash equality.
- Clustering: tag threshold, summary threshold, below both, minimum size, transitivity, deterministic ordering, warning threshold, hard cap, override tightening.
- Candidate: exact shape, majority tags, chronological body, stable fingerprint, runtime schema validation.
- Apply: confirm required, unknown/malformed/duplicate/stale confirmation, confirmed subset, real project choice, typed round-trip, sources untouched, exact idempotency, both global and represented source locks observed during revalidation, local-source mutation rejected, concurrent serialization, child failure lock release.
- Registration/docs: descriptor schema, escaping runtime-schema path rejection, registry entry, em-promote descriptor honesty, spec/capability parity, and all instruction/manual/guide surfaces.

`tests/test-install-topic-tracks.mjs`:

- Real isolated-HOME install copies entry, engine, and config byte-for-byte.
- Deployed `em-topic-tracks.mjs --help` returns status `help`.
- Deployed empty-world dry-run returns status `ok`, `dry_run:true`, and zero candidates.
- No topic-track artifact exists beneath isolated tool-specific enforcement roots.

The runtime test supports `--break-stale-revalidation`, `--break-source-immutability`, and `--break-hard-cap` argv controls. These controls exist only in the test runner. After capturing the real engine result, the selected control negates only its corresponding observed boolean immediately before the unchanged positive assertion, so that named assertion fails. Product runtime files contain no break-control branch.

## §15 Verification Ledger

Baseline evidence captured before edits:

| Claim | Command | Observed artifact |
|---|---|---|
| Existing consolidate suite green | `node tests/test-em-consolidate.mjs` | `8 passed, 0 failed` |
| Typed provenance suite green | `node tests/test-promotion-sources.mjs` | `20/20` pass |

Implementation ledger, to fill from real output:

| Claim | Command | Observed artifact |
|---|---|---|
| Topic runtime contract | `node tests/test-topic-tracks.mjs` | `passed=65 failed=0`, exit 0 |
| Falsifiable stale guard | `node tests/test-topic-tracks.mjs --break-stale-revalidation` | exit 1 only at the named locked-revalidation assertion; `64/65` |
| Falsifiable immutability guard | `node tests/test-topic-tracks.mjs --break-source-immutability` | exit 1 only at the named source-byte assertion; `64/65` |
| Falsifiable cap guard | `node tests/test-topic-tracks.mjs --break-hard-cap` | exit 1 only at the named hard-cap assertion; `64/65` |
| Real install | `node tests/test-install-topic-tracks.mjs` | `7/7 pass`, exit 0 |
| Existing subtree regression | `node tests/test-install-scripts-subtrees.mjs` | `9/9 pass`, exit 0 |
| Registry | `node scripts/validate-plugin-registry.mjs --project "$PWD" --json` | `status: ok`, 8 checks, zero violations |
| Schemas | `node scripts/validate-schemas.mjs --project "$PWD" --json` | `status: ok`, 52 checks, zero violations |
| RFC | `node scripts/em-rfc-validate.mjs` | registry consistent: 14 RFCs, exit 0 |
| Existing consolidation | `node tests/test-em-consolidate.mjs` | `8 passed, 0 failed` |
| Existing promotion | `node tests/test-em-promote.mjs` | `31 pass, 0 fail, 0 skipped` |
| Apply | `node tests/test-promote-apply.mjs` | all 29 named checks passed, exit 0 |
| Provenance | `node tests/test-promotion-sources.mjs` | `20/20 pass` |
| Store concurrency | `node tests/test-store-write-concurrency.mjs` | `46 pass, 0 fail` |
| Plugin registry suite | `node tests/test-plugin-registry.mjs` | `205 passed, 0 failed, 0 skipped` |
| CI closure | `node tests/test-ci-suite-registration.mjs` | `16 passed, 0 failed`; `PASS` |
| Diff scope | `git diff --cached --check` | empty output, exit 0 on the staged slice |
| Frozen diff reviewed | GLM-5.2 three-layer review | `ACCEPT` on frozen tree `770550272e08858b27b0605f8af8d7219ff08775`; zero blockers |
| Independent verify | fresh MiniMax-M3 verify seat, with playbook fallback when unavailable | native MiniMax returned token-plan 429 before a model turn; orchestrator-owned scratch harness then drove 8 independent observable probes, `ACCEPT`, 8/8; harness and fixtures removed |
| Draft PR CI | `gh pr checks <pr>` | pending green |

The live unfiltered `tools/deploy-audit.mjs` is not a pre-merge success criterion because this branch intentionally differs from the deployed main copy. Post-merge deployment must run the standing install and unfiltered audit workflow.

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| New command duplicates em-promote | Medium | Medium | Distinct contract: topic tracks cluster any three related primary episodes, including one-store topics; em-promote requires recurrence across at least two stores. Tests pin both. |
| Deterministic template is too shallow | Medium | Medium | Body is explicitly a chronological track, not an inferred narrative; honest WEAK tier in descriptor. |
| Plugin schema generalization weakens containment | High | Low | Keep the exact step 1.5 JSON-source pattern `^schemas/runtime/[a-z][a-z0-9-]*-io\\.schema\\.json$` and the existing realpath containment validator. |
| Source lock set is large | Medium | Low | Acquire only stores represented by one confirmed candidate, canonical sorted order, and release after one write. |
| Documentation implies new retrieval ranking | Medium | Medium | Docs parity test requires the phrase `ordinary lesson search` and rejects `new ranking`. |
| Exact idempotency misses growing-track evolution | Medium | High | Explicitly report snapshot behavior and file follow-up; no silent claim of revision semantics. |

## §17 Open Decisions

- **Growing topic-track revision chains** -> tracked in [#566](https://github.com/lantisprime/episodic-memory/issues/566) after this first shipped snapshot implementation. Scenario: a fourth source joins an existing three-source topic and the exact source set changes. Spec check: RFC-001 requires sources remain untouched and a derived lesson, but does not require revision chaining. History check: no recalled review required topic-track chain semantics; em-promote has a related superset back-reference pattern. Same-class check: exact matches are handled now; every non-exact overlap class remains snapshot-only. Residual risk: multiple snapshots may appear in search, but each is content-bound, independently searchable, and safe to revise later without corrupting sources.
- **Hardcoded relevance stopword vocabulary** -> tracked in [#564](https://github.com/lantisprime/episodic-memory/issues/564) as a separate Principle 2 audit. Scenario: the existing tokenizer changes independently of topic-track thresholds. Spec check: this slice consumes the existing tokenizer and introduces no new vocabulary. History check: the negative planner surfaced this adjacent class. Same-class check: em-search, embeddings, consolidate, and promote already share the same code vocabulary. Residual risk: clusters may shift after a tokenizer change, but fingerprints remain content-bound and confirmed.
- **Topic-track apply run records** -> tracked in [#565](https://github.com/lantisprime/episodic-memory/issues/565) rather than copied from em-promote in this first slice. Scenario: a confirmed topic-track write is visible in the command output and resulting lesson but has no separate `topic-tracks-run` operational episode. Spec check: RFC-012 R2d requires `promote-run` for the em-promote graduation and its later cadence advisory; RFC-001 Phase 4 requires derived lessons and source preservation but no run record. History check: GLM plan review round 1 finding B4 caught the over-broad R2d citation. Same-class check: em-promote retains `promote-run`; topic tracks is the only new learning member and no other missing learning-member run-record class exists. Residual risk: later cadence analytics cannot reconstruct an apply invocation from an operational record, but content provenance, confirmation, output JSON, idempotency, and source safety remain intact. In this plan, R2d is cited only for the per-candidate fingerprint confirmation and under-lock revalidation invariant.

## §18 Done Criteria

- [ ] Every MUST row in §4 has a passing automated test.
- [ ] All §15 commands produce the recorded artifacts.
- [ ] Dry-run and invalid input leave every store byte-identical.
- [ ] Apply writes only confirmed global lessons and leaves source stores byte-identical.
- [ ] Plan review is ACCEPT and every blocker is dispositioned.
- [ ] Frozen-diff GLM review is ACCEPT after folded fixes.
- [ ] Fresh independent verification is ACCEPT.
- [ ] The orchestrator inspects and commits only the planned file set.
- [ ] A draft PR is open and required CI is green.
- [x] Every deferred item has a GitHub issue with the §17 five-field evidence.
- [ ] No merge is performed; merge remains the operator's decision.

## §19 Review Consensus (Rule 18)

The Codex provider path is not used because issue #538 records a current provider-bootstrap defect. Plan review uses a private native GLM-5.2 Herdr seat against this exact file. The same file is frozen for the builder and the frozen-diff reviewer.

| Pass | Reviewer | Provider/Model | Blockers | Verdict | Artifact |
|---|---|---|---:|---|---|
| 1 | `napmem_c_plan_reviewer` | `neuralwatt/GLM-5.2` | 4 blockers, 3 precision findings | HOLD | private Herdr transcript; 91k input, 55k output, $0.863 |
| 2 | `napmem_c_plan_reviewer_r2` | `neuralwatt/GLM-5.2` | 0 blockers, 2 optional precision notes | ACCEPT | private Herdr transcript; 55k input, 21k output, $0.255 |
| 3 | `napmem_c_plan_amend_reviewer` | `neuralwatt/GLM-5.2` | 5 blockers, 1 falsifiability precision finding | HOLD | private Herdr transcript; reviewer was stopped after repeated convergence; 50k input, 20k output, $0.266 |
| 4 | `napmem_c_plan_amend_reviewer_r2` | `neuralwatt/GLM-5.2` | 0 blockers, 3 precision notes | ACCEPT | private Herdr transcript; 42k input, 18k output, $0.242 |
| 5 | `em-nc-review-2342` | `neuralwatt/GLM-5.2` | 0 blockers, 2 required modifications | ACCEPT | full frozen staged diff; frontmatter/H1 leakage and CLI double-scan findings; approximately 76k input, 41k output, $1.176 |
| 6 | `em-nc-review-2342` focused follow-up | `neuralwatt/GLM-5.2` | 1 blocker | HOLD | REQ-8 membership-drift gap: a new represented-store member could leave the confirmed source snapshot stale; approximately 73k input, 9k output, $0.244 |
| 7 | `em-nc-final-glm-0823` | `neuralwatt/GLM-5.2` | 4 blockers | HOLD | corrected frozen tree `f86e6bf5db3e6c71c98e3ea1b0bcad9595ca35ef`; approximately 225k input, 57k output; cost not visible in the 80-column status line |
| 8 | `em-nc-final2-glm-1705` | `neuralwatt/GLM-5.2` | 0 blockers, 1 negligible redundancy note | ACCEPT | final frozen tree `770550272e08858b27b0605f8af8d7219ff08775`; approximately 58k input, 24k output; cost not visible in the 80-column status line |

### 19.1 Resolved blockers

| # | Blocker | Disposition | Resolution and evidence |
|---|---|---|---|
| 1 | B1: stale `learning/em-promote.json` confirmation label | ACCEPT-WITH-MOD | Add descriptor to S1; set `confirm_gated:true`; change future-tense summary to shipped typed confirmation. Runtime stays read-only. |
| 2 | B2: obsolete RFC checkboxes could be checked dishonestly | ACCEPT-WITH-MOD | Step 3.3 now forbids checking historical `--auto`/`source_episodes` boxes and requires a dated mapped-evidence block. |
| 3 | B3: over-escaped IO-schema pattern | ACCEPT-WITH-MOD | Risk table and step 1.5 now carry the same exact JSON-source pattern with two backslashes before each literal dot. |
| 4 | B4: R2d run-record requirement over-applied | ACCEPT-WITH-MOD | Narrow R2d use to confirmation/revalidation; add the five-field topic-run-record defer in §17. |
| 5 | M3: helper imports unnamed | ACCEPT-WITH-MOD | §9 and step 2.1 name exact relevance/category imports; unused `episodeTokens` is intentionally not imported. |
| 6 | M4: instruction anchors differ | ACCEPT-WITH-MOD | Steps 3.6 through 3.10 now quote each file's exact current anchor. |
| 7 | M5: CI anchors unnamed | ACCEPT-WITH-MOD | Step 3.1 now names the `substrate` job and its exact neighboring steps. |
| 8 | B5: schema-only missing-source repair still rejects current engine output | ACCEPT | REQ-3 and resync row 2.1 now explicitly remove `content_sha256:''`; row 2.3b supplies the separate closed two-field schema; runtime instance validation names the shape. |
| 9 | B6: dry-run creates a missing global directory | ACCEPT | REQ-7 and resync row 2.1 require a non-creating read path; row 2.4 hashes directory existence and contents before/after dry-run. |
| 10 | B7: apply treats the array returned by `resolveRegisteredStores` as an object with `.stores` | ACCEPT | Resync row 2.1 names the actual array API and requires the same canonical store array from scan through apply. |
| 11 | B8: basename-derived source lookup defeats typed store identity and source locks | ACCEPT | Resync row 2.1 requires an explicit `store_id -> data_dir` map; §14 and row 2.4 require observing both global and represented source locks plus a stale local-source rejection. |
| 12 | B9: original CREATE/EDIT rows and the old two-element manifest anchor are stale after S2 core | ACCEPT | §1.1 defines the resync boundary; rows 2.1 and 2.2 are current-state repairs and row 2.3 is a verify-only three-element anchor. |
| 13 | P1: product `BREAK_*` branches do not falsify the corresponding assertion | ACCEPT | Resync row 2.1 removes product break behavior; row 2.4 and §14 keep break controls in the test runner and negate only the named observed assertion. |

### 19.2 Implementation-review fold

All three first-pass implementation findings were accepted and repaired. `bodyOf()` now removes standard `em-store` frontmatter and the immediate generated H1 while preserving real body separators. The CLI passes its exact preview into apply, eliminating the second pre-lock scan and the disappearing-confirmation silent no-op. Under the held global and represented-store locks, apply rebuilds the full candidate set and requires the exact confirmed fingerprint before writing. Three regression tests cover those classes, including a fourth matching member added after preview. The corrected runtime suite reported `62/62`; pass 7 independently verified those repairs before returning HOLD on the four additional cases below.

### 19.3 Final-review B1-B4 repair contract

| Finding | Disposition | Exact repair | Regression evidence required |
|---|---|---|---|
| B1: deployed command fails when its installed path contains a space because URL pathnames stay percent-encoded | ACCEPT | In `scripts/topic-tracks/engine.mjs`, import `fileURLToPath` from `node:url`; convert both the default config URL and `import.meta.url` before filesystem/path use. Keep `TOPIC_TRACKS_CONFIG_PATH` itself as the frozen URL constant. Change the real-install fixture label so its base, HOME, project, and deployed script paths contain a literal space. | `tests/test-install-topic-tracks.mjs` remains 7/7 and its deployed empty-world dry-run succeeds from the spaced path. |
| B2: early help short-circuit swallows unknown flags, `--auto`, and positionals | ACCEPT | In `scripts/em-topic-tracks.mjs`, perform strict pairwise parsing before help output. Reject `--auto` with its dedicated error before help. Help succeeds only when `--help` or `-h` is the sole argument; mixed help input fails closed without reading config/store. Remove the duplicate top-level CLI docblock while touching this file. | Add one table-driven runtime test covering `--help --bogus` -> exit 2 `unknown-flag`, `--help --auto` -> exit 2 `auto-write-withdrawn`, and `--help extra-positional` -> exit 2 `unknown-flag`; all outputs validate against the runtime schema. |
| B3: apply passes preview-derived common tags although other write fields use the fresh under-lock candidate | ACCEPT | Remove the preview `tags` calculation and parameter. Inside `applyOneCandidate`, after exact fresh-candidate matching, derive sorted deduplicated tags from `TOPIC_TRACK_TAG` plus `freshCandidate.common_tags` and pass those to `em-store`. | Add a regression that changes only index-row tags after preview, leaves episode bytes and fingerprint unchanged, applies successfully, and proves the written lesson uses the fresh majority tag while source bytes remain unchanged and locks are released. |
| B4: an under-lock `topic-tracks-max-episodes` throw maps to CLI exit 1 instead of 2 | ACCEPT | In the CLI apply catch, map `topic-tracks-max-episodes` to exit 2 exactly as the scan catch does; retain exit 1 for runtime/lock/write failures. | Add a direct apply regression that crosses the cap after preview, observes `topic-tracks-max-episodes`, zero writes, and released locks. Retain the existing CLI hard-cap exit-2 assertion; final review must inspect the matching apply catch branch. |

The repair builder may edit only `scripts/topic-tracks/engine.mjs`, `scripts/em-topic-tracks.mjs`, `tests/test-topic-tracks.mjs`, and `tests/test-install-topic-tracks.mjs`. It must not change schemas, docs other than this orchestrator-owned plan, shared helpers, descriptors, or public flags. After the four repairs, run syntax checks, the normal runtime suite, all three break controls, the real-install suite, `git diff --check`, and report exact counts without staging or committing.

Execution evidence: the bounded builder changed only those four files. The runtime suite is `65/65`; each break control is `64/65` with only its named failure; the real spaced-path install is `7/7`; syntax and diff checks are clean. The complete §15 validator and regression ledger was rerun after the repairs and is green.

Final disposition: pass 8 verified B1-B4, rechecked all three earlier folded defects, reran the broad regression and validation set, and returned `ACCEPT` with no blocker. Because native MiniMax remained unavailable with a token-plan 429 before any model turn, the playbook fallback was used: an orchestrator-owned throwaway harness independently drove absent-store purity, real-format body parsing, source-byte drift, fourth-member drift, index-only tag drift, apply-time cap crossing, strict mixed-help precedence, and real spaced-path deployment. All 8 probes passed; the scratch harness and fixtures were removed.

Review layers are per-artifact, cross-file, and whole-PR. Review stops after two plan rounds. A repeated third HOLD in one class changes the design boundary rather than patching another spelling.

## §20 Lessons Encoded

| Lesson | Rule | Enforced in |
|---|---|---|
| verify strong claim | Real installed script and real typed write path, not proxy greps | §14, §15 |
| unfiltered deploy audit | Live audit is post-merge and unfiltered | §15 |
| body-file discipline | Memory writes use em scripts and body files | §2, handoff |
| canonical negative planner | Eight-axis planner ran before safety plan | §7 |
| complete bug class | Provenance, identity, path, confirmation, concurrency, bounds, deployment all covered | §7 |
| five-field defer | Every defer gets scenario, spec, history, class, residual, and issue | §17, §18 |
| no aspirational output | Tests assert captured JSON, bytes, exit status, and files | §14 |
| one-file-per-step | Builder stages use exact writable sets and surgical edits | Appendix A |
| red then green | Three argv break controls prove critical tests fail | §14, Appendix A |
| source immutability | Before/after byte hashes cover every source artifact | §4 REQ-10 |

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value |
|---|---|
| Language/runtime | Node.js 20+, zero-dependency `.mjs` ESM |
| Runtime check | `node --version`, major >= 20 |
| Test runner | `node tests/test-<name>.mjs` |
| New function form | named `export function` or `export async function` |
| Portable break input | argv flags `--break-stale-revalidation`, `--break-source-immutability`, `--break-hard-cap` |
| Search tool | `rg` |
| Done commands | §15 commands; no live deploy audit before merge |

## A.1 Forbidden-phrase lint

Run `rg -n -i "decide|choose|figure out|as appropriate|if needed|handle accordingly|TBD|should probably|something like|or similar" docs/PLAN.md`. Matches in quoted template-rule prose are absent; any match inside A.7 blocks the handoff. Read A.7 once after the command to catch wrapped phrases.

## A.2 Executor contract

1. Execute stages and numbered steps in order.
2. Edit only the file named by the step and only within the stage's writable set.
3. Stop on a missing anchor or contract conflict. Do not improvise a new public flag, field, lock, writer, schema location, or store scope.
4. Run the named verify after each file edit; fix only that step until green.
5. Do not commit, stash, push, open a PR, write episodic memory, use network tools, or touch the primary worktree.
6. Do not edit `scripts/em-consolidate.mjs`, `scripts/em-promote.mjs`, `scripts/em-store.mjs`, `scripts/em-revise.mjs`, or any file outside §A.7.
7. Use `apply_patch` for edits. Tests may create and remove their own `os.tmpdir()` fixtures.
8. Builders do not commit. The orchestrator owns diff inspection, commit, push, and draft PR.

## A.3 STOP protocol

```text
STOP - step <n> blocked.
Reason: <anchor not found | contract conflict | verify failed after local fix>.
File: <path>
Expected anchor: <literal>
Observed: <actual surrounding text>
Question: <one required plan-owner decision>
```

## A.4 Pre-flight

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `feat/napmem-c-topic-tracks` |
| Stage-start tree | `git status --short` | only earlier planned-stage files, or empty for S1 |
| Baseline consolidate | `node tests/test-em-consolidate.mjs` | `8 passed, 0 failed` |
| Baseline provenance | `node tests/test-promotion-sources.mjs` | `20/20` pass |
| Runtime | `node --version` | major >= 20 |

## A.5 Exact constants and public surface

```js
export const TOPIC_TRACK_TAG = 'topic-track'
export const TOPIC_TRACKS_CONFIG_PATH = new URL('./config.json', import.meta.url)
export const TOPIC_TRACKS_CONFIG_ENV = 'EM_TOPIC_TRACKS_CONFIG_PATH'
export const TOPIC_TRACKS_CONFIG_VERSION = '1.0.0'
```

Public CLI:

```text
node em-topic-tracks.mjs [--max-episodes <n>] [--apply] [--confirm <64-hex>]...
node em-topic-tracks.mjs --help
```

Exact usage errors are `unknown-flag`, `auto-write-withdrawn`, `invalid-max-episodes`, `confirm-required`, `confirm-malformed`, `confirm-duplicate`, and `confirm-unknown`. Runtime errors are `topic-tracks-config-unloadable`, `topic-tracks-config-invalid`, `topic-tracks-config-symlink`, `topic-tracks-max-episodes`, `stale-fingerprint`, `store-write-lock-timeout`, and `store-write-failed`. Hard-cap refusal maps the runtime code `topic-tracks-max-episodes` to exit class 2.

## A.6 Anchors and verification rule

- CREATE writes a new file named in that step.
- EDIT changes the smallest span around the literal anchor named in that step.
- APPEND adds one block without reformatting existing text.
- Every verify reads an observed return, JSON field, exit status, byte hash, or deployed file and compares it with the concrete value in §4 or §12.
- The three break-input runs must exit nonzero. A no-op implementation must fail at least one positive assertion and every named break run.

## A.7 Per-stage steps

### NAPMEM-C-S1: contracts and definitions

Writable files: `scripts/topic-tracks/config.json`, `schemas/topic-tracks-config.schema.json`, `schemas/runtime/topic-tracks-io.schema.json`, `learning/em-topic-tracks.json`, `learning/em-promote.json`, `plugins/learning-descriptor.schema.json`, `plugins/_index.json`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 1.1 | `scripts/topic-tracks/config.json` | CREATE | Write exactly the REQ-2 keys and values; no extra keys. | `node tests/test-topic-tracks.mjs --only testCommittedConfigValid` once S2 test exists; until then `node -e` JSON parse with exact values is permitted by the stage brief. |
| 1.2 | `schemas/topic-tracks-config.schema.json` | CREATE | Closed draft-2020-12 schema for the REQ-2 object and bounds. | `node scripts/validate-schemas.mjs --project "$PWD" --json` observes status `ok`. |
| 1.3 | `schemas/runtime/topic-tracks-io.schema.json` | CREATE | Closed `oneOf` schema for dry-run, apply, and error outputs; reuse the exact promotion-source field shapes from `learning-io.schema.json`. | schema validator status `ok`, then runtime instance tests in S2. |
| 1.4 | `learning/em-topic-tracks.json` | CREATE | Descriptor: type `learning`, id `em-topic-tracks`, version `1.0.0`, module `scripts/em-topic-tracks.mjs`, IO schema from step 1.3, gauntlet `tests/test-topic-tracks.mjs`, tier `WEAK`, experimental `false`, decision date `2026-07-23`, activation on-demand, global-episode writes, confirm gated true, and a summary naming deterministic topic-track lessons. | plugin registry reports no `L-schema`, `L-path`, or `L-cross` violation after S2 files exist. |
| 1.5 | `plugins/learning-descriptor.schema.json` | EDIT | Anchor `"io_schema": { "const": "schemas/runtime/learning-io.schema.json" }`; replace it with these exact JSON-source bytes: `"io_schema": { "type": "string", "pattern": "^schemas/runtime/[a-z][a-z0-9-]*-io\\.schema\\.json$" }`. The file contains exactly two backslash characters before each literal dot. | `node tests/test-em-promote.mjs --only testLearningDescriptor` stays green, and S2 rejects an escaping path. |
| 1.6 | `plugins/_index.json` | EDIT | Append an active learning entry mirroring step 1.4 after the em-promote entry; retain schema version `1.2.0`. | live plugin registry status `ok` after S2 files exist. |
| 1.7 | `learning/em-promote.json` | EDIT | Anchor `\"confirm_gated\": false`; replace with `\"confirm_gated\": true`. In the same file, replace the future-tense summary clause `per-candidate fingerprint confirm ships in P2-S4, REQ-16` with `per-candidate fingerprint confirmation and under-lock revalidation shipped in RFC-012 P2-S4`. Change no other descriptor field. | `node tests/test-em-promote.mjs --only testLearningDescriptor` observes a valid descriptor, and `node scripts/validate-plugin-registry.mjs --project \"$PWD\" --json` observes status `ok`. |

### NAPMEM-C-S2: runtime and distribution

Writable files: `scripts/topic-tracks/engine.mjs`, `scripts/em-topic-tracks.mjs`, `scripts/lib/install-manifest.mjs`, `schemas/runtime/topic-tracks-io.schema.json`, `tests/test-topic-tracks.mjs`, `tests/test-install-topic-tracks.mjs`, `tests/test-install-scripts-subtrees.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 2.1 | `scripts/topic-tracks/engine.mjs` | EDIT, resync repair | Preserve the six required exports and existing helper imports. Against current S2-core bytes, make these exact repairs: reject extra config keys and any version other than `TOPIC_TRACKS_CONFIG_VERSION`; change replica identity from `` `${storeId}#${row.id}#${sha}` `` to episode id plus normalized hash; change missing-file output to exactly `{store_id,episode_id}`; keep the Jaccard token set to `tokenizeQuery(row.summary)` only; remove all product-runtime `BREAK_*` constants and branches; replace mutating `resolveGlobalDir` use on scan with a non-creating canonical read path and treat an absent global directory as an empty source; honor `context.registeredStores` when supplied and otherwise use the array returned directly by `resolveRegisteredStores`; replace `.stores` API misuse and `path.basename(d) === src.store_id` derivation with one explicit `store_id -> canonical data_dir` map retained from scan through lock acquisition and under-lock source reads; keep global plus every represented source store locked; append an under-lock exact-prior result to `skipped`; propagate schema-valid warning metadata. Spawn only `em-store.mjs`; never write an episode/index/tag file directly. | Runtime tests observe exact config closure, summary-only matching, cross-store replica collapse, schema-valid missing-source output, zero dry-run filesystem changes when the global directory is absent, source-store lock acquisition, stale local-source rejection, exact-prior skip reporting, and every §14 invariant. |
| 2.2 | `scripts/em-topic-tracks.mjs` | EDIT, resync repair | Preserve the thin wrapper and current public usage. Remove the unused `node:fs` import. Replace the permissive argv scan with exact pairwise parsing: reject every unknown flag, positional argument, missing value, and `--flag=value` spelling; retain `--auto` as the dedicated `auto-write-withdrawn` error; emit `unknown-flag` for other unrecognized input. Map `topic-tracks-max-episodes` to exit 2. Print exactly one schema-valid JSON object on every path; `--help` reads no config/store. | Help contains `script:"em-topic-tracks.mjs"`; auto exits 2 with `auto-write-withdrawn`; unknown/positional/equals/missing-value cases exit 2 with their specified usage errors; hard-cap refusal exits 2; empty dry-run exits 0 with `dry_run:true`. |
| 2.3 | `scripts/lib/install-manifest.mjs` | VERIFY, already applied | Current anchor must be exactly `export const GLOBAL_SCRIPT_SUBTREES = ['em-consolidate', 'second-opinion', 'topic-tracks']`; do not edit if present. | install test observes byte-identical deployed entry/engine/config; existing install-manifest tests stay green after row 2.3a. |
| 2.3a | `tests/test-install-scripts-subtrees.mjs` | EDIT | Anchor the final `GLOBAL_SCRIPT_SUBTREES` deep equality and append `'topic-tracks'` to the exact expected list; change no functional test body. | `node tests/test-install-scripts-subtrees.mjs` reports `9/9 pass` and exits 0. |
| 2.3b | `schemas/runtime/topic-tracks-io.schema.json` | EDIT | Add `unknown-flag` to the closed error enum. Add a closed `missingSource` definition requiring only `store_id` and `episode_id`, and use it for both `missing_sources` arrays. Permit the observed optional warning metadata `count`, `fingerprint`, and `detail` while keeping warnings closed. | schema lint stays `ok`; runtime instance tests validate every help-independent success/error/warning/missing-source shape. |
| 2.4 | `tests/test-topic-tracks.mjs` | CREATE | Implement every named runtime test in §14 against isolated HOME stores and the real CLI/engine. Each fixture mints real store identities and registers real project paths. Hash every global and source directory entry plus episode/index/tags bytes before and after dry-run, and hash all source episode/index/tags bytes before and after apply. During confirmed apply, instrument the fixture so assertions observe both global and represented source-store locks held during revalidation. Add `--only` substring filtering and keep the three break argv controls entirely in the test runner: each control negates only its corresponding observed positive assertion after the real engine result is captured; product runtime code contains no `BREAK_*` behavior. | Normal run reports zero failures; each break run exits nonzero at the named stale, immutability, or hard-cap assertion rather than an unrelated failure. |
| 2.5 | `tests/test-install-topic-tracks.mjs` | CREATE | Use an isolated HOME and the real `install.mjs --tool codex`. Compare repo/deployed entry, engine, and config bytes; run deployed help and empty dry-run; walk isolated enforcement roots and assert no topic-track artifacts. | test reports all assertions passed with no skip. |

### NAPMEM-C-S3: documentation and CI parity

Writable files: `.github/workflows/tests.yml`, `CAPABILITIES.md`, `docs/rfcs/RFC-001-memory-improvements.md`, `docs/EM_SCRIPTS_GUIDE.md`, `docs/USER_MANUAL.md`, `instructions/SKILL.md`, `instructions/codex-skill.md`, `instructions/AGENTS.md`, `instructions/cursor.mdc`, `instructions/windsurf.md`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 3.1 | `.github/workflows/tests.yml` | EDIT | In job `substrate`, insert `node tests/test-topic-tracks.mjs` immediately after the step anchored by `run: node tests/test-em-promote.mjs`. Insert `node tests/test-install-topic-tracks.mjs` immediately before the step anchored by `run: node tests/test-install-manifest.mjs`. Use separate named, unconditional steps. | CI registration test reports PASS and discovers both exact suite paths as fully wired. |
| 3.2 | `CAPABILITIES.md` | EDIT | Add `em-topic-tracks` to Learning Strategy as a non-experimental WEAK on-demand member; state any three related primary episodes may qualify, output is global and confirm-gated, sources untouched. Replace em-promote's stale `pending ... typed linkage` wording with its shipped typed provenance wording. | docs parity test observes all required phrases and no stale pending claim. |
| 3.3 | `docs/rfcs/RFC-001-memory-improvements.md` | EDIT | Keep the historical Phase 4 proposal and its unchecked `em-consolidate --auto`/`source_episodes` acceptance boxes byte-for-byte. Append a dated implementation-resolution block that explicitly marks those historical boxes superseded, not satisfied. Map shipped evidence to `em-topic-tracks`: deterministic dry-run; confirm-gated global lesson writes through em-store with typed `promotion_sources`; `--auto` rejected; sources untouched; hard `--max-episodes` cap; rebuild already preserves `promotion_sources`. Mark Phase 4 shipped only in the new resolution block after all runtime tests pass. | RFC validator status `ok`; spec parity test asserts the resolution block and asserts the obsolete historical boxes remain unchecked. |
| 3.4 | `docs/EM_SCRIPTS_GUIDE.md` | EDIT | Add a complete `em-topic-tracks` section with when/when-not, dry-run, confirm workflow, output shapes, bounds, global-only side effect, and source immutability. Add intent-router row. | docs parity test finds required contract phrases. |
| 3.5 | `docs/USER_MANUAL.md` | EDIT | Replace the unshipped topic-track statement with an on-demand workflow and explain that derived tracks are ordinary lessons searched by tag/query, not a new ranking layer. | docs parity test passes. |
| 3.6 | `instructions/SKILL.md` | EDIT | Anchor `topic tracks are not implemented`; replace the containing sentence with the exact shipped routing and confirmation guidance; retain transcript route as unshipped. | docs parity test passes. |
| 3.7 | `instructions/codex-skill.md` | EDIT | Anchor `topic tracks are not implemented`; replace the containing sentence with the same contract in this file's compact style; retain transcript route as unshipped. | docs parity test passes. |
| 3.8 | `instructions/AGENTS.md` | EDIT | Anchor `Transcript-level and topic-track routes are not shipped; do not invent them.`; replace that sentence only with the same shipped topic-track contract and the still-unshipped transcript route. | docs parity test passes. |
| 3.9 | `instructions/cursor.mdc` | EDIT | Anchor `Transcript-level and topic-track routes are not shipped; do not invent them.`; replace that sentence only with the same shipped topic-track contract and the still-unshipped transcript route. | docs parity test passes. |
| 3.10 | `instructions/windsurf.md` | EDIT | Anchor `Transcript-level and topic-track routes are not shipped; do not invent them.`; replace that sentence only with the same shipped topic-track contract and the still-unshipped transcript route. | docs parity test passes. |

Read-only for every stage: `PRINCIPLES.md`, `scripts/em-promote.mjs`, `scripts/em-consolidate.mjs`, `scripts/em-store.mjs`, `scripts/em-revise.mjs`, `scripts/em-rebuild-index.mjs`, `scripts/lib/promotion-sources.mjs`, `scripts/lib/registered-stores.mjs`, `scripts/lib/store-write-lock.mjs`, `scripts/lib/relevance.mjs`, `scripts/lib/categories.mjs`, and existing tests except when a stage lists one explicitly.

## A.8 Mechanical done commands

Run every command in §15 separately. Required concrete results are zero test failures, registry/schema/RFC status `ok`, CI registration `PASS`, empty `git diff --check`, GLM frozen-diff `ACCEPT`, fresh verifier `ACCEPT`, and green draft-PR checks.

## A.9 Blast-radius controls

- Run the three break controls immediately before their normal green test.
- Do not refactor shared helpers. Import their public exports.
- The CLI is a thin wrapper; the engine owns behavior; `em-store` owns writes.
- Source fixtures contain unique sentinel tags and summaries so tag-threshold, summary-threshold, replica, and distinct-content assertions inspect different observed dimensions.
- Real-install coverage uses the committed installer, not a hand-copied mock tree.
- Any necessary change outside A.7 is a plan change. Stop, update this file, rerun plan review, and explicitly resync the builder.
