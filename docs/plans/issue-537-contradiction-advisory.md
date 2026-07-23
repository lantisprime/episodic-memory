# ISSUE-537 Contradiction / near-duplicate advisory Plan

> **FROZEN BUILD SPEC (playbook v5).** This document is the seat contract. The builder
> brief points here and adds nothing. The reviewer's ground truth is this same document:
> every ACCEPT / HOLD finding cites a section of it. The spec is frozen at dispatch —
> a mid-build scope change requires the orchestrator to edit this file AND re-brief the
> seat explicitly.

## §1 Status

`Approved — build.` Executor altitude **LOW** (§0.1): the implementer is a pi/MiniMax-M3
builder seat with fresh context. **Appendix A is the build path.**

| Field | Value |
|---|---|
| RFC | `RFC-001` (scoring contract — constraint only, not modified) |
| Parent requirements | RFC-001 Phase 2 lines 75-79 / 81-88 (constraint); `CAPABILITIES.md:85-92` curation family; `PRINCIPLES.md` P1, P6 |
| GitHub issue | `#537` |
| Target branch | `feat/issue-537-contradiction-advisory` |
| Executor altitude (§0.1) | **low** |
| Worktree | `/Users/charltondho/Developer/projects/episodic-memory-537` |

## §2 Episode / scout search summary

Scout maps produced 2026-07-23 by four parallel pi/MiniMax-M3 read-only seats; every
file:line below was re-verified by the orchestrator against the worktree before freezing.

Load-bearing facts (all orchestrator-verified, not scout-asserted):

- `scripts/em-store.mjs:408-427` — an existing **stderr-only, best-effort, post-lock,
  informational advisory** (the R9a trigger-collision report). This is the **style anchor**
  for the new advisory: same channel, same placement, same `try {} catch {}` posture.
  Verified by reading `em-store.mjs:396-430`.
- `scripts/em-store.mjs:429` — `console.log(JSON.stringify(successPayload))`, the single
  success-stdout call. Its contract is exactly `{ status, id, file, scope }`
  (`em-store.mjs:403`). **The advisory must not change it.**
- `scripts/em-doctor.mjs:123-305` — `checkStore(dataDir, scopeName)`; index rows are loaded
  once at `:168` into `entriesForShape` (aliased `entries` at `:183`). Verified by reading
  `em-doctor.mjs:123-222` and `:222-316`.
- `scripts/em-doctor.mjs:257` — `// --- tmp-litter ---...` is the insertion anchor: the new
  check goes between `supersedes-links` (ends `:255`) and `tmp-litter`.
- `scripts/em-doctor.mjs:60` — `loadIndex` is already imported from `./lib/relevance.mjs`.
- `scripts/em-doctor.mjs:563-567` — `checkStoreWithDir` stamps `data_dir` onto every row a
  store-class check emits, which is why the new check belongs **inside `checkStore`**, not
  in the bottom run-block.
- `scripts/em-doctor.mjs:646-656` — summary tally, `healthy = summary.error === 0 && (!strict
  || summary.warn === 0)`, exit `healthy ? 0 : 1`. A `warn` alone keeps exit 0; `--strict`
  turns it into exit 1.
- `scripts/lib/relevance.mjs:213-218` — `tokenizeQuery(text)`: lowercased, split on
  `[^a-z0-9]+`, length ≥ 2, deduped, order preserved. Verified by reading the function.
- `scripts/topic-tracks/config.json:3-4` — existing Jaccard precedent in this repo
  (`tag_jaccard_min` 0.3, `summary_jaccard_min` 0.2, used **OR**-combined for clustering).
  This plan deliberately uses a **much higher** 0.6, because clustering wants recall and an
  advisory wants precision.
- `docs/rfcs/RFC-001-memory-improvements.md:75-79` — the scoring formula. **Constraint:
  untouched by this slice.**

## §3 Objective

Two active `decision` episodes in the same project that say nearly the same thing are stored
today with **no signal of any kind** (issue #537 §Observed behavior). This slice adds an
advisory safety net in two places, sharing one pure comparator:

1. **Write time** — `em-store` prints an informational stderr line naming each similar active
   decision already in the same store, and a `em-revise` hint. Exit code, stdout JSON, and
   the write itself are unchanged.
2. **Audit time** — `em-doctor` gains a `contradiction-candidates` store-class check that
   reports `warn` when such pairs exist and `ok` when they do not.

Provable by: `node tests/test-contradiction.mjs` → `18/18 pass`, whose runtime layer drives
the real `em-store` / `em-revise` / `em-doctor` against isolated fixture stores and asserts
observed stdout / stderr / exit in **both** polarities.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | `summaryJaccard(a,b)` returns intersection/union over summary token sets; returns `0` when **either** set is empty | EC5 lesson `…7c11` | `testEmptySummaryNeverMatches` | MUST | an empty summary must never compare equal to itself |
| REQ-2 | Two active same-project `decision` rows whose summary-token Jaccard ≥ `SUMMARY_JACCARD_MIN` (0.6) are reported as a candidate pair | #537 Ask | `testIdenticalSummariesMatch`, `testJsonVsYamlMatches` | MUST | the canonical repro scores exactly `0.667` |
| REQ-3 | Rows below the threshold, in different projects, of a different category, or with `status !== 'active'` are **not** candidates | #537 constraints | `testUnrelatedSummariesDoNotMatch`, `testCrossProjectIgnored`, `testNonDecisionCategoryIgnored`, `testSupersededStatusIgnored` | MUST | four independent exclusion axes |
| REQ-4 | A pair linked (transitively, either direction) by `supersedes` is **never** a candidate | #537 "sanctioned correction" | `testSupersedesChainLinkedPairExcluded`, `testReviseChainNotFlagged` | MUST | `em-revise` output must not self-report |
| REQ-5 | A project group larger than `MAX_GROUP` is skipped and **named** in `skipped`, never silently truncated | playbook "no silent caps" | `testLargeGroupSkippedNotTruncated` | MUST | O(n²) blast guard |
| REQ-6 | `em-store` writing a `decision` prints `similar active decision: <id> (summary-token similarity <n>): <summary>` to **stderr** for each candidate, plus one `hint:` line | #537 Ask (store-time advisory) | `testStoreEmitsAdvisoryOnContradiction` | MUST | stderr only — never stdout |
| REQ-7 | The advisory never changes `em-store` stdout (exactly `{status,id,file,scope}`) or its exit code (`0`) | `PRINCIPLES.md` P1; RFC-008 R1 | `testStoreStdoutContractUnchanged` | MUST | advisory, never a gate |
| REQ-8 | `em-store` emits **no** advisory line for an unrelated decision or for a non-`decision` category | precision | `testStoreSilentOnUnrelatedDecision`, `testStoreSilentOnNonDecisionCategory` | MUST | negative controls |
| REQ-9 | `em-doctor` emits a `contradiction-candidates` row at level `warn` when candidates exist in a store | #537 Ask (audit-time check) | `testDoctorWarnsOnContradiction` | MUST | row carries `data_dir` via `checkStoreWithDir` |
| REQ-10 | `em-doctor` emits `contradiction-candidates` at level `ok` on a clean store | precision | `testDoctorOkOnCleanStore` | MUST | negative control |
| REQ-11 | With `--strict`, a `contradiction-candidates` warn drives exit `1`; without it, exit stays `0` | `em-doctor.mjs:649-656` | `testDoctorStrictExitsNonZero` | MUST | pre-existing contract, must keep holding |
| REQ-12 | The RFC-001 scoring formula and access-tracking write-back are byte-unchanged | #537 "Must not touch the RFC-001 scoring contract" | `manual: git diff --stat` shows no `lib/relevance.mjs` change | MUST | detection is a separate pass, never a re-ranking change |
| REQ-13 | `tests/test-contradiction.mjs` is wired into CI | `tests/test-ci-suite-registration.mjs` class-closure lint | `manual: node tests/test-ci-suite-registration.mjs` | MUST | an unwired suite silently never runs |

## §5 Non-Goals

- **Any change to relevance scoring, `access_count`, or the `accessFactor` boost.** Issue
  #537's third bullet ("whether access_count boost should apply when a newer active episode
  … has near-identical summary tokens") is explicitly **deferred** — see §17. The issue's own
  constraint section forbids a re-ranking change in this slice.
- Blocking, gating, or refusing a write. The substrate stays enforcement-free.
- Reading episode bodies. `em-doctor` is deliberately index-only (`em-doctor.mjs` never opens
  `episodes/*.md`); this slice keeps that property.
- Embeddings / semantic similarity. Lexical summary-token Jaccard only, zero new deps.
- A new plugin type or registry entry. `em-doctor` is already a shipped member of the
  `curation` family (`CAPABILITIES.md:40`); adding a check to an existing member is not a new
  capability, so criterion 2 of the forward rule is not triggered.
- Any change to `em-revise`.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `scripts/lib/contradiction.mjs` | 0 → ~95 | — | ~1.5k | CREATE |
| `scripts/em-doctor.mjs` | 656 | targeted ranges only (~150 lines ≈ 0.8k) | ~0.3k | 2 anchored EDITs |
| `scripts/em-store.mjs` | 446 | targeted ranges only (~80 lines ≈ 0.4k) | ~0.3k | 2 anchored EDITs |
| `tests/test-contradiction.mjs` | 0 → ~300 | — | ~4.5k | CREATE |
| `.github/workflows/tests.yml` | 461 | ~40 lines ≈ 0.2k | ~0.1k | 1 anchored EDIT |

**Baseline (single session):** ~40k tokens. **Optimized:** ~12k — the builder never reads a
whole script; every step names an anchor and a range.

## §7 Safety / Security

This slice adds no trust boundary, no privilege vector, no child process, no path-authority
predicate, and no network flow. It reads index rows already loaded by the caller and writes
only to stderr. The one real hazard is **algorithmic**, not security:

| Concern | Severity | Abuse/failure scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| O(n²) pairwise blowup in `em-doctor` on a large store | Med | A project with 20k active decisions → 2×10⁸ comparisons; `em-doctor` appears to hang | `MAX_GROUP` (2000); oversized groups are skipped and **named** in `skipped` | `testLargeGroupSkippedNotTruncated` (**negative**: asserts `pairs` is empty AND `skipped` names the project — a silent truncation would leave both empty) |
| Empty-identity false positive | Med | Two rows with `summary: ""` compare equal to each other and to themselves, manufacturing candidates (lesson `…7c11`) | `summaryJaccard` returns `0` when either set is empty; both entry points skip empty-token rows before comparing | `testEmptySummaryNeverMatches` (**negative**: two empty summaries → 0 candidates) |
| Advisory turning into a gate | High | A future edit makes the stderr path throw and abort the write, silently breaking `em-store` | The whole block is `try { … } catch {}` **after** the write and **after** lock release, mirroring `em-store.mjs:408-427` | `testStoreStdoutContractUnchanged` (**negative-adjacent**: asserts exit 0 + exact 4-key stdout even while the advisory fires) |

No path-authority predicate is introduced, so the 8-axis symlink matrix does not apply to
this slice. No `realpath` / `lstat` / `isMain` / `resolveRepoRoot` logic is added or changed.

## §8 Design

### 8.1 Key types

```js
/**
 * @typedef {Object} IndexRow            — an index.jsonl row as loadIndex() returns it
 * @property {string} id
 * @property {string} project
 * @property {string} category
 * @property {string} status             — 'active' | 'superseded' | …
 * @property {string|null} supersedes
 * @property {string} summary
 */

/**
 * @typedef {Object} NearMatch           — findContradictionsFor() element
 * @property {string} id
 * @property {string} summary
 * @property {number} similarity         — 0..1, rounded to 3dp
 */

/**
 * @typedef {Object} CandidatePair       — findContradictionCandidates().pairs element
 * @property {string} project
 * @property {string} a                  — lexicographically smaller id
 * @property {string} b
 * @property {number} similarity
 * @property {string} summary_a
 * @property {string} summary_b
 */

/**
 * @typedef {Object} SkippedGroup
 * @property {string} project
 * @property {number} active_decisions
 */
```

### 8.2 Key invariants

- **Advisory-only.** Neither entry point writes, blocks, gates, mutates an index, or changes
  an exit code. `PRINCIPLES.md` P1 + `CAPABILITIES.md` criterion 4 + RFC-008 R1.
- **Index-only.** No episode body is ever read; `summary` comes from the index row.
- **Empty is never similar.** `summaryJaccard` returns `0` if either set is empty.
- **Deterministic output.** Pairs sort by `similarity` desc, then `a` asc, then `b` asc; ids
  within a pair are ordered lexicographically. Two runs on the same store produce byte-equal
  output.
- **No silent caps.** An oversized group is named in `skipped`, never dropped quietly.
- **Cross-platform:** pure JS `Set` / `Map` / string ops; no path handling, no shell, no
  GNU-only flag, no `os.tmpdir()` assumption inside the lib. Tests use
  `fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), …)))` per the repo idiom
  (`tests/test-relevance.mjs:127-138`), which is the existing cross-OS-safe form.
- **Atomicity:** not applicable — this slice writes no file.

### 8.3 Resolution / flow

```text
em-store (write path, unchanged) → lock released → stdout JSON pending
                                        │
                                        ├─ category === 'decision'?
                                        │      └─ loadIndex(dataDir)
                                        │           └─ findContradictionsFor(justWritten, rows)
                                        │                └─ for each → process.stderr.write(...)
                                        │                └─ if any → one `hint:` line
                                        └─ console.log(stdout JSON)   ← UNCHANGED

em-doctor checkStore(dataDir, scope) → entries (already loaded at :168)
                                        └─ findContradictionCandidates(entries)
                                             ├─ pairs.length → report(warn)
                                             └─ else         → report(ok)
```

## §9 Existing Hook Points

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `scripts/em-store.mjs` | 37 | imports `episodeTokens, updateTokensIndex, nullProtoIndex` from `./lib/relevance.mjs` | add `loadIndex` to the list; add a `./lib/contradiction.mjs` import line |
| `scripts/em-store.mjs` | 408-427 | R9a trigger-collision advisory (stderr, best-effort, post-lock) | the **style anchor**; new block is inserted directly after it |
| `scripts/em-store.mjs` | 429 | `console.log(JSON.stringify(successPayload))` | unchanged; the new block is inserted immediately **before** it |
| `scripts/em-doctor.mjs` | 60 | imports `loadIndex, TOKENS_DROPPED_KEY` from `./lib/relevance.mjs` | add a `./lib/contradiction.mjs` import line after it |
| `scripts/em-doctor.mjs` | 247-255 | `supersedes-links` check inside `checkStore` | new check inserted directly after it |
| `scripts/em-doctor.mjs` | 257 | `// --- tmp-litter ---…` | the verbatim anchor; unchanged, re-emitted after the new block |
| `scripts/em-doctor.mjs` | 563-567 | `checkStoreWithDir` stamps `data_dir` | new row inherits `data_dir` for free (no edit needed) |
| `.github/workflows/tests.yml` | `substrate` shard | runs `node tests/test-relevance.mjs` etc. | add one step for the new suite |

## §10 Slice Ladder

One slice, one PR — the lib, its two callers, and the tests are a single concern and share a
single comparator. Splitting would ship a lib with no caller (dead code) or a caller with no
guard.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `537-S1` | Advisory contradiction detection at write time and audit time | `scripts/lib/contradiction.mjs`, `scripts/em-doctor.mjs`, `scripts/em-store.mjs`, `tests/test-contradiction.mjs`, `.github/workflows/tests.yml` | comparator lib + 2 call sites + 18 tests + CI wiring | `node tests/test-contradiction.mjs` | do NOT touch `lib/relevance.mjs`; do NOT touch `em-revise.mjs`; do NOT change any exit code; do NOT commit |

## §11 Cut Order

If context or scope grows, cut in this order:

1. The `MAX_GROUP` skip reporting (fall back to a hard `continue`) — REQ-5 drops to SHOULD.
2. The `hint:` line in the `em-store` advisory (keep the per-candidate lines).

Do **not** cut:

- `summaryJaccard`'s empty-set rule (REQ-1) — it is the EC5 false-pass class.
- The supersedes-chain exclusion (REQ-4) — without it, every `em-revise` output self-reports
  and the advisory becomes noise users learn to ignore.
- Either negative control pair (REQ-8, REQ-10) — a detector never observed staying silent
  detects nothing.

## §12 Contracts

### `summaryJaccard(a: Set<string>, b: Set<string>) → number`

**Input contract:** two `Set` instances of lowercase token strings.
**Output contract:** a number in `[0, 1]`. Never `NaN`, never `null`.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. both empty | `a.size === 0 && b.size === 0` | `0` | none |
| B. one empty | exactly one of `a.size`, `b.size` is `0` | `0` | none |
| C. disjoint | no shared token | `0` | none |
| D. partial | `k` shared tokens | `k / (a.size + b.size - k)` | none |
| E. identical | `a` and `b` have the same members | `1` | none |

### `findContradictionsFor(episode: IndexRow, rows: IndexRow[], opts?) → NearMatch[]`

**Input contract:** `episode` is the just-written row (may or may not already appear in
`rows`); `rows` is any array (non-array → treated as empty). `opts.threshold` overrides
`SUMMARY_JACCARD_MIN`.
**Output contract:** array (possibly empty), sorted by `similarity` desc then `id` asc. Never
contains `episode.id`.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. episode not a candidate | `status !== 'active'` or `category !== 'decision'` or non-string `id`/`summary` | `[]` | none |
| B. episode summary empty | `summaryTokenSet(episode.summary).size === 0` | `[]` | none |
| C. rows empty / not an array | `rows` is `[]`, `null`, `undefined` | `[]` | none |
| D. only self in rows | the sole match is `row.id === episode.id` | `[]` | none |
| E. different project | every row has `project !== episode.project` | `[]` | none |
| F. chain-linked | the only similar row is on the same supersedes chain | `[]` | none |
| G. match | ≥1 active same-project decision at/above threshold | those rows, sorted | none |

### `findContradictionCandidates(rows: IndexRow[], opts?) → { pairs: CandidatePair[], skipped: SkippedGroup[] }`

**Input contract:** any array (non-array → treated as empty). `opts.threshold`,
`opts.maxGroup` override the module constants.
**Output contract:** always an object with both keys, both arrays, both deterministically
sorted. Never `null`.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. no candidate rows | no active `decision` rows | `{ pairs: [], skipped: [] }` | none |
| B. group oversized | a project has `> maxGroup` active decisions | that project omitted from `pairs`, named in `skipped` | none |
| C. all below threshold | every pair scores `< threshold` | `{ pairs: [], skipped: [] }` | none |
| D. matches | ≥1 pair at/above threshold | those pairs, sorted | none |

**Error codes:** none. Neither function throws; neither has a fail-open/fail-closed axis
because neither gates anything. The `em-store` call site wraps its use in `try {} catch {}`
so even a future throw degrades to "no advisory", never to a failed write.

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | `rows` is `null` / `undefined` / not an array | treated as empty; return `[]` / `{pairs:[],skipped:[]}` | `testFindForSelfExcluded` (passes `[]`) |
| EC2 | both summaries empty or whitespace-only | `0` similarity, **no** candidate (lesson `…7c11`) | `testEmptySummaryNeverMatches` |
| EC3 | the just-written episode is already in `rows` (it is — `em-store.mjs:395` appends before the advisory runs) | excluded by `row.id === episode.id` | `testFindForSelfExcluded`, `testStoreEmitsAdvisoryOnContradiction` |
| EC4 | `em-revise` produced the second episode | original is `superseded` **and** the pair is chain-linked → excluded twice over | `testSupersedesChainLinkedPairExcluded`, `testReviseChainNotFlagged` |
| EC5 | a supersedes pointer forms a cycle (corrupt store) | chain walk terminates via the `seen` set, no infinite loop | `testSupersedesChainLinkedPairExcluded` (covers the walk); cycle safety is structural |
| EC6 | validate-then-write ordering | not applicable — the advisory runs strictly **after** the write and after lock release, exactly like `em-store.mjs:408-427`; it can never affect what was written | `testStoreStdoutContractUnchanged` |
| EC7 | store with a single decision | no pair possible; `ok` row, not a crash | `testDoctorOkOnCleanStore` |

## §14 Test Case Catalog

```text
Group 1: pure comparator (10 tests)
  testIdenticalSummariesMatch          — identical summaries → similarity 1, 1 pair
  testJsonVsYamlMatches                — the #537 repro → similarity exactly 0.667, 1 pair
  testUnrelatedSummariesDoNotMatch     — disjoint summaries → 0 pairs
  testCrossProjectIgnored              — identical summaries, different project → 0 pairs
  testNonDecisionCategoryIgnored       — identical summaries, category 'lesson' → 0 pairs
  testSupersededStatusIgnored          — identical summaries, one superseded → 0 pairs
  testSupersedesChainLinkedPairExcluded— identical summaries, b.supersedes === a.id → 0 pairs
  testEmptySummaryNeverMatches         — two empty summaries → 0 pairs (EC2)
  testLargeGroupSkippedNotTruncated    — group > maxGroup → 0 pairs AND skipped names it
  testFindForSelfExcluded              — one-vs-many with self in rows → self not returned

Group 2: em-store runtime probes (4 tests)
  testStoreEmitsAdvisoryOnContradiction— real em-store ×2 → stderr names the first id
  testStoreStdoutContractUnchanged     — stdout is exactly {status,id,file,scope}; exit 0
  testStoreSilentOnUnrelatedDecision   — negative control: no advisory line
  testStoreSilentOnNonDecisionCategory — negative control: no advisory line

Group 3: em-doctor runtime probes (4 tests)
  testDoctorWarnsOnContradiction       — real em-doctor → contradiction-candidates level warn
  testDoctorOkOnCleanStore             — negative control → level ok
  testDoctorStrictExitsNonZero         — --strict on the dirty store → exit 1
  testReviseChainNotFlagged            — real em-revise chain → level ok (REQ-4 end-to-end)
```

Total: **18 tests**. Runner: `node tests/test-contradiction.mjs`.
Negative control for the guard itself: `node tests/test-contradiction.mjs --break-detector`
raises the pure-layer threshold to `1.1` (unreachable), so every Group-1 positive assertion
must go RED → the process must exit non-zero. A detector never observed failing guards
nothing (§A.9).

## §15 Verification Ledger (verify by artifact)

Filled with **observed** output at implementation time, by the orchestrator, not the builder.

| Claim | Command (the strong-layer one) | Observed artifact |
|---|---|---|
| All tests pass | `node tests/test-contradiction.mjs` | _(fill: `18/18 pass`)_ |
| Guard is falsifiable (RED) | `node tests/test-contradiction.mjs --break-detector` | _(fill: non-zero exit)_ |
| Pre-existing doctor suite still green | `node tests/test-em-doctor.mjs` | _(fill)_ |
| Pre-existing relevance suite still green | `node tests/test-relevance.mjs` | _(fill)_ |
| Store-write concurrency unaffected | `node tests/test-store-write-concurrency.mjs` | _(fill)_ |
| CI class-closure lint passes | `node tests/test-ci-suite-registration.mjs` | _(fill)_ |
| Scoring contract untouched (REQ-12) | `git diff --stat main -- scripts/lib/relevance.mjs` | _(fill: empty)_ |
| E2E advisory fires on a real store | the Group-2/3 runtime probes above (real scripts, isolated fixture stores) | _(fill)_ |
| CI green | `gh pr checks <PR>` | _(fill)_ |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| False positives train users to ignore the advisory | Med | Med | threshold 0.6 (3× the repo's clustering precedent), four exclusion axes, and two negative-control tests per call site |
| `em-doctor` slows on large stores | Med | Low | `MAX_GROUP` guard; comparison is summary-token only, no body reads |
| A future edit turns the advisory into a gate | High | Low | `try{}catch{}` after the write; REQ-7 test asserts the exact stdout contract and exit 0 |
| Threshold 0.6 is wrong for real corpora | Low | Med | `opts.threshold` is a parameter; retuning is a one-constant change with no call-site edits |

## §17 Open Decisions

- **Should the `access_count` boost be suppressed when a newer active same-project episode
  has near-identical summary tokens?** → deferred out of this slice; tracked as a new issue
  filed at PR time (§18 checklist).

  | Field | Disposition |
  |---|---|
  | 1. Run the scenario | Yes — issue #537 §Observed behavior step 4 records the repro: after `em-revise` on A, the unlinked duplicate B ranked **first** at 0.71 vs 0.664 purely because a prior read bumped its `access_count`. |
  | 2. Spec check | The spec **forbids** fixing it here: issue #537 §Constraints says "Must not touch the RFC-001 scoring contract (RFC-001:131-134, passes merged by score); detection is a separate advisory pass, never a re-ranking change." Deferring is the specified behavior, not an omission. |
  | 3. History check | The scoring formula is `scripts/lib/relevance.mjs:148-158`, contract at `docs/rfcs/RFC-001-memory-improvements.md:75-79`; scout-b §2.5 records three already-shipped undocumented drifts from that contract (feedback term, pinned floor, 0.665 tier). A fourth change to the same formula without an RFC amendment would compound existing drift. |
  | 4. Same-class check | The class is "relevance-formula inputs that can entrench a stale copy": `access_count` (this defer), `feedback`, and `pinned` floor. **All three siblings are deferred together** — none is changed by this slice — so the defer leaves no sibling half-guarded and no inconsistent state. The advisory shipped here covers the whole class at the *detection* layer, which is the layer the issue asks for. |
  | 5. Residual-risk | If the deferred case fires, a stale unlinked decision can outrank its correction in `em-search` output. Failure is **graceful and visible**, not silent corruption: both episodes remain intact and active, and after this slice `em-doctor` reports the pair as `contradiction-candidates` `warn`. Recovery path: `em-revise --original <stale-id>`, which supersedes the stale copy and drops it from default search. |

## §18 Done Criteria

- [ ] All 13 MUST requirements have a passing test in §15.
- [ ] `node tests/test-contradiction.mjs --break-detector` exits non-zero (guard proven RED).
- [ ] The four pre-existing suites in §15 are still green.
- [ ] `git diff --stat` touches exactly the five files in §10 plus this plan doc.
- [ ] Reviewer verdict recorded in §19 with a reply artifact.
- [ ] The §17 DEFER is filed as a GitHub issue and cited here (Rule 18 step 9).
- [ ] CI green on the PR (`gh pr checks`).

## §19 Review Consensus (Rule 18)

**Provider for this arc: `pi/GLM-5.2` on neuralwatt (interactive seat).** The user directed
in-session on 2026-07-23: *"don use codex as second opinion."* The template's default
(`--provider codex`) is therefore **overridden for this arc**; the codex path is additionally
known-broken (issue #538, fixed in the next arc).

| Pass | Reviewer | Provider/Model | Blocker count | Verdict | Reply artifact |
|---|---|---|---|---|---|
| 1 | frozen-diff reviewer | pi/GLM-5.2 (neuralwatt) | _(fill)_ | _(fill)_ | _(fill)_ |

Review in three layers: per-artifact → cross-file → PR-level. The reviewer receives this
document as ground truth and cites REQ / §-numbers in every finding.

## §20 Lessons Encoded

| Lesson | One-line rule | Enforced in |
|---|---|---|
| `…7c11` empty-identity diff | an empty identity compares equal to itself → reject | REQ-1, EC2, §12 state A/B |
| red-then-green / blast-radius | a guard must be observed RED | §14 `--break-detector`, §18 |
| no silent caps | a bounded sweep names what it dropped | REQ-5, §7 |
| verify-before-conclude | artifact precedes the conclusion | §15 (orchestrator fills after running) |
| bp1 step-9 5-field DEFER | every DEFER carries all 5 fields + an issue | §17 |
| behavior-simulation not static analysis | run the real scripts on isolated fixtures | §14 Groups 2-3 |
| compound-bash gate | one command per verify | Appendix A verifies |
| canonical-agent dispatch | dispatch a reviewer, do not self-walk | §19 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value for this plan |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` zero-dep ESM |
| Runtime check | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-contradiction.mjs` |
| New-function phrasing | `export function fnName(args)` |
| Portable break-input override | argv flag: `node tests/test-contradiction.mjs --break-detector` (NOT an env prefix — portable to Windows `cmd`) |
| Search tool for verifies | `grep -c` / `grep -n` from the repo root |
| Repo-specific done-commands | `node tests/test-em-doctor.mjs`, `node tests/test-relevance.mjs`, `node tests/test-ci-suite-registration.mjs` |

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/issue-537-contradiction-advisory.md
```

Acceptance rule: matches are permitted only outside §A.5 blocks and §A.7 rows. The expected
matches in this document are in §0-quoting prose only; no §A.7 step row contains one.

## A.2 Executor contract (the seat's hard rules)

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step names exactly one file, the exact change, and how to verify it.
3. **Make no design decisions.** If an anchor is not found **verbatim**, STOP (§A.3).
4. Run the verify after each step; fix only that step until it is green.
5. **Edit exactly ONE file per step.** Read-only references (look, never edit):
   `scripts/lib/relevance.mjs`, `scripts/em-revise.mjs`, `docs/rfcs/`, `CAPABILITIES.md`,
   `PRINCIPLES.md`.
6. Run no command outside the per-step verifies and the slice test command. **Each verify is
   a single command** — no `;`, `&&`, `||`, pipes, or subshells.
7. **Do NOT commit. Do NOT `git stash`. Do NOT `git checkout`. Do NOT push. Do NOT open a
   PR.** The orchestrator commits.
8. **Do NOT write episodes, memory files, or the workplan.**
9. **Do NOT edit any file outside the five listed in §A.7's "Files this slice may touch".**
10. **No aspirational output** — every printed "checking X" is backed by an assertion that
    performs X.

## A.3 STOP-and-ask protocol

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous instruction | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <actual surrounding text, ±3 lines>
Question: <the single decision the plan owner must make>
```

Halt. Do not continue to the next step.

## A.4 Pre-flight environment check (step 1.0)

| Check | Command | Expected |
|---|---|---|
| On the right branch | `git branch --show-current` | `feat/issue-537-contradiction-advisory` |
| Clean tree apart from the plan doc | `git status --porcelain` | only `docs/plans/issue-537-contradiction-advisory.md` |
| Doctor suite green at baseline | `node tests/test-em-doctor.mjs` | all pass |
| Runtime available | `node --version` | `v20` or higher |

## A.5 Shared constants

```js
// scripts/lib/contradiction.mjs — exact values, no placeholders
export const SUMMARY_JACCARD_MIN = 0.6
export const MAX_GROUP = 2000
```

## A.6 Anchor format

- **ANCHOR** — a verbatim, unique substring already present in the file. Not unique or not
  present → STOP (§A.3). Never anchor on a line number.
- **CREATE** — whole-file `Write` of a brand-new file. The only place a whole-file write is
  allowed.
- **EDIT** — anchored `ANCHOR → REPLACE`, smallest diff, no reformatting of untouched lines.
- **APPEND** — add a new block at end of file.

## A.7 Per-slice step table

### `537-S1` — Advisory contradiction detection (REQ-1 … REQ-13)

**Files this slice may touch (the complete writable set — anything else is out of scope):**

1. `scripts/lib/contradiction.mjs`
2. `scripts/em-doctor.mjs`
3. `scripts/em-store.mjs`
4. `tests/test-contradiction.mjs`
5. `.github/workflows/tests.yml`

**Read-only:** `scripts/lib/relevance.mjs`, `scripts/em-revise.mjs`, everything else.

---

**Step 1.0 — Pre-flight.** File: — . Kind: — .
Action: run every §A.4 row.
Verify: every row matches its Expected column.

---

**Step 1.1 — CREATE the comparator lib.**
File: `scripts/lib/contradiction.mjs`. Kind: **CREATE**.
Action: write this file verbatim.

```js
// ---------------------------------------------------------------------------
// contradiction.mjs — advisory near-duplicate / contradiction detection over
// index rows (#537).
//
// Two active `decision` episodes in the same project whose SUMMARIES share most
// of their tokens are very likely the same decision stored twice: the second one
// written with em-store instead of em-revise, so nothing links them and both
// stay active and searchable. This module finds those pairs.
//
// ADVISORY ONLY. It derives no knowledge, writes nothing, changes no ranking,
// and gates nothing (PRINCIPLES.md P1; CAPABILITIES.md criterion 4; RFC-008 R1).
// Callers surface its output and carry on.
//
// Index rows only: `summary` is present on every index row, so no episode body
// is read — em-doctor is deliberately index-only and stays that way.
// ---------------------------------------------------------------------------

import { tokenizeQuery } from './relevance.mjs'

// Summary-token Jaccard at or above this is reported. 0.6 is deliberately high:
// "Config files use JSON format" vs "Config files use YAML format" scores
// 4/6 = 0.667, while two genuinely different decisions in one project score far
// below it. Compare topic-tracks/config.json summary_jaccard_min = 0.2, which is
// tuned for clustering RECALL; an advisory needs PRECISION.
export const SUMMARY_JACCARD_MIN = 0.6

// Pairwise comparison is O(n^2) inside a project group. A group above this many
// active decisions is SKIPPED and named in the result — never silently dropped.
export const MAX_GROUP = 2000

export function summaryTokenSet(summary) {
  return new Set(tokenizeQuery(typeof summary === 'string' ? summary : ''))
}

// Jaccard over two token sets. An EMPTY set matches NOTHING, including another
// empty set: an empty summary would otherwise compare equal to itself and to
// every other empty summary, manufacturing candidates out of nothing.
export function summaryJaccard(a, b) {
  if (!a || !b || !a.size || !b.size) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

// Only ACTIVE DECISION rows are candidates. A superseded row is already linked
// by its revision chain and drops out of default search, so it is not a silent
// contradiction.
function isCandidateRow(row) {
  return !!row &&
    row.status === 'active' &&
    row.category === 'decision' &&
    typeof row.id === 'string' &&
    typeof row.summary === 'string'
}

// True when `from` reaches `to` by following supersedes pointers, in either
// direction, transitively. A sanctioned correction is linked, so it is never a
// contradiction candidate. The `seen` set makes a corrupt cyclic chain
// terminate instead of hanging.
function chainLinked(a, b, byId) {
  for (const [from, to] of [[a, b], [b, a]]) {
    let cur = from
    const seen = new Set()
    while (cur && typeof cur.supersedes === 'string' && !seen.has(cur.supersedes)) {
      if (cur.supersedes === to.id) return true
      seen.add(cur.supersedes)
      cur = byId.get(cur.supersedes)
    }
  }
  return false
}

// findContradictionsFor(episode, rows, opts) — ONE vs MANY.
// Used by em-store at write time: the episode just written against everything
// already in the index. O(n).
export function findContradictionsFor(episode, rows, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : SUMMARY_JACCARD_MIN
  if (!isCandidateRow(episode)) return []
  const all = Array.isArray(rows) ? rows : []
  const byId = new Map()
  for (const r of all) if (r && typeof r.id === 'string') byId.set(r.id, r)
  byId.set(episode.id, episode)
  const mine = summaryTokenSet(episode.summary)
  if (!mine.size) return []
  const out = []
  for (const row of all) {
    if (!isCandidateRow(row)) continue
    if (row.id === episode.id) continue
    if (row.project !== episode.project) continue
    const theirs = summaryTokenSet(row.summary)
    if (!theirs.size) continue
    if (chainLinked(episode, row, byId)) continue
    const sim = summaryJaccard(mine, theirs)
    if (sim < threshold) continue
    out.push({ id: row.id, summary: row.summary, similarity: round3(sim) })
  }
  out.sort((x, y) => y.similarity - x.similarity || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  return out
}

// findContradictionCandidates(rows, opts) — ALL PAIRS, grouped by project.
// Used by em-doctor at audit time. O(n^2) inside each group, capped by maxGroup.
export function findContradictionCandidates(rows, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : SUMMARY_JACCARD_MIN
  const maxGroup = typeof opts.maxGroup === 'number' ? opts.maxGroup : MAX_GROUP
  const all = Array.isArray(rows) ? rows : []
  const byId = new Map()
  for (const r of all) if (r && typeof r.id === 'string') byId.set(r.id, r)
  const groups = new Map()
  for (const row of all) {
    if (!isCandidateRow(row)) continue
    const key = typeof row.project === 'string' ? row.project : ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const pairs = []
  const skipped = []
  for (const [project, members] of groups) {
    if (members.length > maxGroup) {
      skipped.push({ project, active_decisions: members.length })
      continue
    }
    const tokens = members.map(m => summaryTokenSet(m.summary))
    for (let i = 0; i < members.length; i++) {
      if (!tokens[i].size) continue
      for (let j = i + 1; j < members.length; j++) {
        if (!tokens[j].size) continue
        if (chainLinked(members[i], members[j], byId)) continue
        const sim = summaryJaccard(tokens[i], tokens[j])
        if (sim < threshold) continue
        const ordered = members[i].id < members[j].id ? [members[i], members[j]] : [members[j], members[i]]
        pairs.push({
          project,
          a: ordered[0].id,
          b: ordered[1].id,
          similarity: round3(sim),
          summary_a: ordered[0].summary,
          summary_b: ordered[1].summary
        })
      }
    }
  }
  pairs.sort((x, y) =>
    y.similarity - x.similarity ||
    (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
    (x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
  skipped.sort((x, y) => (x.project < y.project ? -1 : x.project > y.project ? 1 : 0))
  return { pairs, skipped }
}
```

Verify (observed → expected): `grep -c "^export " scripts/lib/contradiction.mjs` → `6`
(two constants + four functions; corrected from `5` after review finding F9.)

---

**Step 1.2 — EDIT the em-doctor import block.**
File: `scripts/em-doctor.mjs`. Kind: **EDIT**.

`ANCHOR:`
```
import { loadIndex, TOKENS_DROPPED_KEY } from './lib/relevance.mjs'
```
`REPLACE:`
```
import { loadIndex, TOKENS_DROPPED_KEY } from './lib/relevance.mjs'
import { findContradictionCandidates, SUMMARY_JACCARD_MIN } from './lib/contradiction.mjs'
```

Verify: `grep -c "findContradictionCandidates" scripts/em-doctor.mjs` → `1` at this step
(it becomes `2` after step 1.3).

---

**Step 1.3 — EDIT: add the `contradiction-candidates` check inside `checkStore`.**
File: `scripts/em-doctor.mjs`. Kind: **EDIT**.

`ANCHOR:` (verbatim, unique — the tmp-litter banner line)
```
  // --- tmp-litter -----------------------------------------------------------
```
`REPLACE:`
```
  // --- contradiction-candidates (#537) --------------------------------------
  // Two ACTIVE decision episodes in one project with near-identical summaries
  // are very likely the same decision stored twice — the correction written
  // with em-store instead of em-revise, so nothing links them and both stay
  // searchable. Advisory only: warn, no fix hint (the repair is human judgment,
  // em-rebuild-index cannot do it), and never an error.
  const contradiction = findContradictionCandidates(entries)
  if (contradiction.pairs.length) {
    report('contradiction-candidates', scopeName, 'warn',
      `${contradiction.pairs.length} pair(s) of active decision episodes share >= ${SUMMARY_JACCARD_MIN} summary-token similarity — one may be an unlinked correction; link them with em-revise --original <id>`,
      {
        ...(verbose ? { pairs: contradiction.pairs } : {}),
        ...(contradiction.skipped.length ? { skipped_projects: contradiction.skipped } : {})
      })
  } else if (contradiction.skipped.length) {
    report('contradiction-candidates', scopeName, 'warn',
      `${contradiction.skipped.length} project group(s) above the pairwise scan cap were not checked for contradictions`,
      { skipped_projects: contradiction.skipped })
  } else {
    report('contradiction-candidates', scopeName, 'ok', 'no active decision episodes with near-identical summaries')
  }

  // --- tmp-litter -----------------------------------------------------------
```

Verify: `grep -c "contradiction-candidates" scripts/em-doctor.mjs` → `4`

---

**Step 1.4 — EDIT the em-store import block.**
File: `scripts/em-store.mjs`. Kind: **EDIT**.

`ANCHOR:`
```
import { episodeTokens, updateTokensIndex, nullProtoIndex } from './lib/relevance.mjs'
```
`REPLACE:`
```
import { episodeTokens, updateTokensIndex, nullProtoIndex, loadIndex } from './lib/relevance.mjs'
import { findContradictionsFor } from './lib/contradiction.mjs'
```

Verify: `grep -c "findContradictionsFor" scripts/em-store.mjs` → `1` at this step (it
becomes `2` after step 1.5).

---

**Step 1.5 — EDIT: add the write-time advisory before the stdout print.**
File: `scripts/em-store.mjs`. Kind: **EDIT**.

`ANCHOR:` (verbatim, unique)
```
console.log(JSON.stringify(successPayload))
```
`REPLACE:`
```
// #537 contradiction advisory — INFORMATIONAL, stderr-only, best-effort, and
// runs AFTER the write and AFTER the store-write lock is released, exactly like
// the R9a collision report above. Any failure means NO advisory, never a
// blocked or altered write; the stdout JSON below is untouched.
if (category === 'decision') {
  try {
    const near = findContradictionsFor(
      { id: storedId, project, category: 'decision', status: 'active', supersedes: null, summary },
      loadIndex(dataDir, scope)
    )
    for (const c of near) {
      process.stderr.write(`similar active decision: ${c.id} (summary-token similarity ${c.similarity}): ${c.summary}\n`)
    }
    if (near.length) {
      process.stderr.write(`hint: if this corrects an earlier decision, store it with em-revise --original <id> so the chain links them\n`)
    }
  } catch {}
}

console.log(JSON.stringify(successPayload))
```

Verify: `grep -c "similar active decision" scripts/em-store.mjs` → `1`

---

**Step 1.6 — CREATE the test suite.**
File: `tests/test-contradiction.mjs`. Kind: **CREATE**.
Action: write this file verbatim.

```js
#!/usr/bin/env node
// ---------------------------------------------------------------------------
// test-contradiction.mjs — #537 contradiction / near-duplicate advisory.
//
// Two layers:
//   Group 1  pure comparator table over scripts/lib/contradiction.mjs
//   Group 2  em-store runtime probes   — REAL script, isolated fixture store
//   Group 3  em-doctor runtime probes  — REAL script, isolated fixture store
//
// Every runtime assertion inspects OBSERVED output (captured stdout, stderr, or
// exit code) of the real script, never a constant.
//
// Usage:  node tests/test-contradiction.mjs
// Guard negative control (must exit non-zero):
//         node tests/test-contradiction.mjs --break-detector
// ---------------------------------------------------------------------------

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  summaryJaccard, summaryTokenSet,
  findContradictionsFor, findContradictionCandidates
} from '../scripts/lib/contradiction.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.join(HERE, '..', 'scripts')
const EM_STORE = path.join(SCRIPTS, 'em-store.mjs')
const EM_REVISE = path.join(SCRIPTS, 'em-revise.mjs')
const EM_DOCTOR = path.join(SCRIPTS, 'em-doctor.mjs')

// Negative control: an unreachable threshold makes every Group-1 positive
// assertion go RED. A guard never observed failing guards nothing.
const BREAK = process.argv.includes('--break-detector')
const OPTS = BREAK ? { threshold: 1.1 } : {}

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`ok   ${name}`) }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

function row(over) {
  return { id: 'x', project: 'p', category: 'decision', status: 'active', supersedes: null, summary: 's', ...over }
}

// --- fixture helpers --------------------------------------------------------
function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contradiction-')))
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contradiction-home-')))
  return { cwd, home, env: { ...process.env, HOME: home } }
}
function cleanup(fx) {
  fs.rmSync(fx.cwd, { recursive: true, force: true })
  fs.rmSync(fx.home, { recursive: true, force: true })
}
function run(script, args, fx) {
  const r = spawnSync('node', [script, ...args], { cwd: fx.cwd, encoding: 'utf8', env: fx.env })
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}
function store(fx, summary, body, category) {
  return run(EM_STORE, ['--project', 'fx', '--category', category || 'decision',
    '--summary', summary, '--body', body, '--scope', 'local'], fx)
}

// ===========================================================================
// Group 1 — pure comparator
// ===========================================================================

function testIdenticalSummariesMatch() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testIdenticalSummariesMatch', out.pairs.length === 1 && out.pairs[0].similarity === 1,
    `pairs=${out.pairs.length} sim=${out.pairs[0] && out.pairs[0].similarity}`)
}

function testJsonVsYamlMatches() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Config files use YAML format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testJsonVsYamlMatches',
    out.pairs.length === 1 && out.pairs[0].similarity === 0.667 && out.pairs[0].a === 'a' && out.pairs[0].b === 'b',
    `pairs=${out.pairs.length} sim=${out.pairs[0] && out.pairs[0].similarity}`)
}

function testUnrelatedSummariesDoNotMatch() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Retry the upload queue with exponential backoff' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testUnrelatedSummariesDoNotMatch', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testCrossProjectIgnored() {
  const rows = [
    row({ id: 'a', project: 'one', summary: 'Config files use JSON format' }),
    row({ id: 'b', project: 'two', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testCrossProjectIgnored', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testNonDecisionCategoryIgnored() {
  const rows = [
    row({ id: 'a', category: 'lesson', summary: 'Config files use JSON format' }),
    row({ id: 'b', category: 'lesson', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testNonDecisionCategoryIgnored', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testSupersededStatusIgnored() {
  const rows = [
    row({ id: 'a', status: 'superseded', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testSupersededStatusIgnored', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testSupersedesChainLinkedPairExcluded() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'mid', supersedes: 'a', summary: 'Totally unrelated middle link' }),
    row({ id: 'b', supersedes: 'mid', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testSupersedesChainLinkedPairExcluded', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testEmptySummaryNeverMatches() {
  const rows = [row({ id: 'a', summary: '' }), row({ id: 'b', summary: '   ' })]
  const out = findContradictionCandidates(rows, OPTS)
  const j = summaryJaccard(summaryTokenSet(''), summaryTokenSet(''))
  check('testEmptySummaryNeverMatches', out.pairs.length === 0 && j === 0,
    `pairs=${out.pairs.length} jaccard=${j}`)
}

function testLargeGroupSkippedNotTruncated() {
  const rows = []
  for (let i = 0; i < 6; i++) rows.push(row({ id: `id${i}`, summary: 'Config files use JSON format' }))
  const out = findContradictionCandidates(rows, { ...OPTS, maxGroup: 5 })
  check('testLargeGroupSkippedNotTruncated',
    out.pairs.length === 0 && out.skipped.length === 1 && out.skipped[0].project === 'p' && out.skipped[0].active_decisions === 6,
    `pairs=${out.pairs.length} skipped=${JSON.stringify(out.skipped)}`)
}

function testFindForSelfExcluded() {
  const me = row({ id: 'a', summary: 'Config files use JSON format' })
  const rows = [me, row({ id: 'b', summary: 'Config files use YAML format' })]
  const out = findContradictionsFor(me, rows, OPTS)
  check('testFindForSelfExcluded',
    out.length === 1 && out[0].id === 'b' && findContradictionsFor(me, [], OPTS).length === 0,
    `out=${JSON.stringify(out)}`)
}

// ===========================================================================
// Group 2 — em-store runtime probes (real script, isolated fixture store)
// ===========================================================================

function testStoreEmitsAdvisoryOnContradiction(fx) {
  const first = store(fx, 'Config files use JSON format', 'We standardise on JSON.')
  const second = store(fx, 'Config files use YAML format', 'We standardise on YAML.')
  const firstId = first.json && first.json.id
  check('testStoreEmitsAdvisoryOnContradiction',
    !!firstId && second.stderr.includes(`similar active decision: ${firstId}`) && second.stderr.includes('hint:'),
    `firstId=${firstId} stderr=${JSON.stringify(second.stderr)}`)
  return second
}

function testStoreStdoutContractUnchanged(second) {
  const j = second.json
  const keys = j ? Object.keys(j).sort().join(',') : ''
  check('testStoreStdoutContractUnchanged',
    second.code === 0 && keys === 'file,id,scope,status' && j.status === 'ok' && j.scope === 'local',
    `code=${second.code} keys=${keys} stdout=${JSON.stringify(second.stdout)}`)
}

function testStoreSilentOnUnrelatedDecision(fx) {
  const r = store(fx, 'Retry the upload queue with exponential backoff', 'Unrelated decision.')
  check('testStoreSilentOnUnrelatedDecision',
    r.code === 0 && !r.stderr.includes('similar active decision'),
    `code=${r.code} stderr=${JSON.stringify(r.stderr)}`)
}

function testStoreSilentOnNonDecisionCategory(fx) {
  const r = store(fx, 'Config files use JSON format', 'Same words, lesson category.', 'lesson')
  check('testStoreSilentOnNonDecisionCategory',
    r.code === 0 && !r.stderr.includes('similar active decision'),
    `code=${r.code} stderr=${JSON.stringify(r.stderr)}`)
}

// ===========================================================================
// Group 3 — em-doctor runtime probes (real script, isolated fixture store)
// ===========================================================================

function doctorRow(fx, extraArgs) {
  const r = run(EM_DOCTOR, ['--scope', 'local', ...(extraArgs || [])], fx)
  const rows = (r.json && Array.isArray(r.json.checks) ? r.json.checks : [])
    .filter(c => c.id === 'contradiction-candidates')
  return { r, rows }
}

function testDoctorWarnsOnContradiction(fx) {
  const { r, rows } = doctorRow(fx)
  check('testDoctorWarnsOnContradiction',
    rows.length === 1 && rows[0].level === 'warn' && r.code === 0,
    `code=${r.code} rows=${JSON.stringify(rows)}`)
}

function testDoctorStrictExitsNonZero(fx) {
  const { r, rows } = doctorRow(fx, ['--strict'])
  check('testDoctorStrictExitsNonZero',
    r.code === 1 && rows.length === 1 && rows[0].level === 'warn',
    `code=${r.code} rows=${JSON.stringify(rows)}`)
}

function testDoctorOkOnCleanStore() {
  const fx = mkFixture()
  try {
    store(fx, 'Config files use JSON format', 'Only decision in the store.')
    store(fx, 'Retry the upload queue with exponential backoff', 'Unrelated decision.')
    const { r, rows } = doctorRow(fx)
    check('testDoctorOkOnCleanStore',
      rows.length === 1 && rows[0].level === 'ok' && r.code === 0,
      `code=${r.code} rows=${JSON.stringify(rows)}`)
  } finally { cleanup(fx) }
}

function testReviseChainNotFlagged() {
  const fx = mkFixture()
  try {
    const first = store(fx, 'Config files use JSON format', 'We standardise on JSON.')
    const originalId = first.json && first.json.id
    const rev = run(EM_REVISE, ['--original', originalId, '--project', 'fx',
      '--summary', 'Config files use YAML format', '--body', 'Corrected: YAML.', '--scope', 'local'], fx)
    const { r, rows } = doctorRow(fx)
    check('testReviseChainNotFlagged',
      !!originalId && rev.code === 0 && rows.length === 1 && rows[0].level === 'ok',
      `reviseCode=${rev.code} reviseOut=${JSON.stringify(rev.stdout)} rows=${JSON.stringify(rows)}`)
  } finally { cleanup(fx) }
}

// ===========================================================================
// main
// ===========================================================================

console.log('# test-contradiction')

testIdenticalSummariesMatch()
testJsonVsYamlMatches()
testUnrelatedSummariesDoNotMatch()
testCrossProjectIgnored()
testNonDecisionCategoryIgnored()
testSupersededStatusIgnored()
testSupersedesChainLinkedPairExcluded()
testEmptySummaryNeverMatches()
testLargeGroupSkippedNotTruncated()
testFindForSelfExcluded()

const dirty = mkFixture()
try {
  const second = testStoreEmitsAdvisoryOnContradiction(dirty)
  testStoreStdoutContractUnchanged(second)
  testStoreSilentOnUnrelatedDecision(dirty)
  testStoreSilentOnNonDecisionCategory(dirty)
  testDoctorWarnsOnContradiction(dirty)
  testDoctorStrictExitsNonZero(dirty)
} finally { cleanup(dirty) }

testDoctorOkOnCleanStore()
testReviseChainNotFlagged()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

Verify (observed → expected): `node tests/test-contradiction.mjs` → `18 passed, 0 failed`

---

**Step 1.7 — Negative control (guard proven RED).**
File: — . Kind: — .
Action: run the break-input override. This must FAIL — it proves the Group-1 assertions bind
to real detection rather than passing vacuously.
Verify (observed → expected): `node tests/test-contradiction.mjs --break-detector` → exits
non-zero and prints `FAIL testJsonVsYamlMatches`

---

**Step 1.8 — EDIT: wire the suite into CI.**
File: `.github/workflows/tests.yml`. Kind: **EDIT**.

`ANCHOR:` (verbatim, unique — the relevance-suite step; `- name:` is indented 6 spaces and
`run:` is indented 8 spaces, verified against `.github/workflows/tests.yml:344-345`)
```
      - name: Run relevance suite (wave 1)
        run: node tests/test-relevance.mjs
```
`REPLACE:`
```
      - name: Run relevance suite (wave 1)
        run: node tests/test-relevance.mjs

      - name: Run contradiction advisory suite (#537)
        run: node tests/test-contradiction.mjs
```

If the anchor's leading whitespace does not match the file verbatim, STOP (§A.3) and report
the exact indentation found — do not guess the YAML indent.

Verify: `grep -c "test-contradiction.mjs" .github/workflows/tests.yml` → `1`

---

**Step 1.9 — Regression sweep (no edits).**
File: — . Kind: — .
Action: run each pre-existing suite, one command per row. Any failure → STOP (§A.3).

| Verify (observed → expected) |
|---|
| `node tests/test-em-doctor.mjs` → all pass, exit 0 |
| `node tests/test-relevance.mjs` → all pass, exit 0 |
| `node tests/test-store-write-concurrency.mjs` → all pass, exit 0 |
| `node tests/test-ci-suite-registration.mjs` → all pass, exit 0 |

---

**Step 1.10 — Report and STOP.**
File: — . Kind: — .
Action: print the observed output of every verify in steps 1.1-1.9 and STOP. **Do not
commit. Do not push.** The orchestrator takes it from here.

## A.8 Definition of done (mechanical)

```bash
node tests/test-contradiction.mjs                  # → 18 passed, 0 failed
node tests/test-contradiction.mjs --break-detector # → non-zero exit (guard RED)
node tests/test-em-doctor.mjs                      # → all pass
node tests/test-relevance.mjs                      # → all pass
node tests/test-store-write-concurrency.mjs        # → all pass
node tests/test-ci-suite-registration.mjs          # → all pass
grep -c "similar active decision" scripts/em-store.mjs   # → 1
git diff --stat main -- scripts/lib/relevance.mjs        # → empty (REQ-12)
```

No step is done by inspection. Each line above produces an artifact pasted into §15.

## A.9 Blast-radius notes for this slice

- **Red-then-green:** step 1.7 is the mandatory negative control; the Group-2/3 "silent"
  tests are the runtime-layer discriminating controls (real unrelated input → no advisory).
- **Thin addition, no refactor:** `lib/relevance.mjs` is imported, never modified. The two
  call sites are pure insertions; no existing function is restructured.
- **Discriminating fixture:** every positive fixture uses the literal summaries
  `Config files use JSON format` / `Config files use YAML format`, and the assertions inspect
  the specific similarity value `0.667` and the specific episode id — not "non-empty".
- **Fixture-change ledger:** this slice edits **no** existing test assertion. If any
  pre-existing suite goes red in step 1.9, that is a real regression → STOP, do not edit the
  other suite.
- **High blast radius flag:** `em-store.mjs` is on every write path in the substrate. The
  advisory is therefore placed after the write, after lock release, inside `try{}catch{}`,
  and REQ-7 asserts the exact stdout contract and exit code still hold.

---

# §21 Fold round 1 — disposition of review `review-537-r1`

Reviewer: pi/GLM-5.2 (neuralwatt), read-only frozen-diff seat, three layers plus ten
behavior-simulation probes. **Verdict: ACCEPT, 0 blocking findings.**

| # | Finding | Severity | Disposition | Resolution |
|---|---|---|---|---|
| F1 | Negation false-positive: "Do not deploy" vs "Do deploy" = 0.667 → flagged | Med | **DEFER** | Inherent to the lexical mechanism this slice scopes itself to (§5 non-goal 4); REQ-2 specifies that ≥0.6 pairs ARE reported and REQ-3's exclusion axes are exhaustive and all satisfied. Filed as a follow-up issue with F3. |
| F2 | Non-ASCII / pure-CJK false-negative: `tokenizeQuery` strips non-ASCII, so two identical pure-CJK decisions score 0 | Med | **DEFER** | Fixing it means changing `tokenizeQuery` in `lib/relevance.mjs`, which REQ-12 forbids in this slice. Filed as a follow-up issue. |
| F3 | Short-subset false-positive: "Deploy v2" vs "Deploy v2 rollback" = 0.667 | Low | **DEFER** | Same class as F1; folded into the same follow-up issue. |
| F4 | Cycle safety is correct but `testSupersedesChainLinkedPairExcluded` uses a linear chain, so the `seen` guard is never the cause of termination — §13 EC5's coverage claim is overstated | Low | **ACCEPT-WITH-MOD** | Step 1.11: add `testChainCycleTerminates`, a genuine cyclic chain that only terminates via the `seen` guard. |
| F5 | Cross-scope chain false-positive: `byId` is built from a single scope, so a pair linked only through an absent cross-scope intermediary is flagged | Low | **DEFER** | Narrow; partially mitigated by the pre-existing `supersedes-links` warn. Filed as a follow-up issue. |
| F6 | `MAX_GROUP` default (2000) is not pinned — the test passes `{maxGroup: 5}`, so a regression to `Infinity` would pass unchanged | Low | **ACCEPT-WITH-MOD** | Step 1.12: assert the exported constant equals 2000 and exercise the DEFAULT cap with no override. |
| F7 | `contradiction.mjs` uses strict `category === 'decision'` while the substrate canonicalizes elsewhere | Low | **DEFER** | Verified unreachable today: `grep -c deprecated categories.json` → `0`, and `em-store.mjs:159` rejects deprecated aliases. Filed as a follow-up issue for defense-in-depth. |
| F8 | REQ-9's `data_dir` carriage is confirmed present by simulation but not asserted by any test | Low | **ACCEPT-WITH-MOD** | Step 1.13: assert `data_dir` on the `contradiction-candidates` row. |
| F9 | §A.7 Step 1.1 verify says `5` exports; the file has `6` | Low | **ACCEPT** | Spec corrected in place; `grep -c "^export "` → `6` verified. |

## §21 step table (fold round 1)

**Files this round may touch:** `tests/test-contradiction.mjs` **only.**

**Step 1.11 — F4: pin the cycle guard.**
File: `tests/test-contradiction.mjs`. Kind: **EDIT**.
`ANCHOR:`
```
function testEmptySummaryNeverMatches() {
```
`REPLACE:`
```
function testChainCycleTerminates() {
  // A genuine CYCLE: a → b → a. Without the `seen` guard in chainLinked the
  // walk never terminates, so this test hangs rather than fails. It also
  // asserts the cyclic pair IS excluded (they are chain-linked).
  const rows = [
    row({ id: 'a', supersedes: 'b', summary: 'Config files use JSON format' }),
    row({ id: 'b', supersedes: 'a', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  // A self-referencing row must also terminate, and must NOT be excluded from
  // comparison against an unrelated third row.
  const selfRef = [
    row({ id: 's', supersedes: 's', summary: 'Config files use JSON format' }),
    row({ id: 't', summary: 'Config files use JSON format' })
  ]
  const out2 = findContradictionCandidates(selfRef, OPTS)
  check('testChainCycleTerminates',
    out.pairs.length === 0 && out2.pairs.length === 1 && out2.pairs[0].a === 's' && out2.pairs[0].b === 't',
    `cyclePairs=${out.pairs.length} selfRefPairs=${JSON.stringify(out2.pairs)}`)
}

function testEmptySummaryNeverMatches() {
```

**Step 1.12 — F6: pin the DEFAULT cap.**
File: `tests/test-contradiction.mjs`. Kind: **EDIT**.
`ANCHOR:`
```
function testFindForSelfExcluded() {
```
`REPLACE:`
```
function testDefaultMaxGroupIsPinned() {
  // F6: the skip mechanism is proven with an override elsewhere; this pins the
  // shipped DEFAULT. A regression setting MAX_GROUP to Infinity or 0 fails here.
  const rows = []
  for (let i = 0; i < MAX_GROUP + 1; i++) {
    rows.push(row({ id: `big${i}`, summary: 'Config files use JSON format' }))
  }
  const out = findContradictionCandidates(rows, OPTS)
  check('testDefaultMaxGroupIsPinned',
    MAX_GROUP === 2000 && out.pairs.length === 0 &&
    out.skipped.length === 1 && out.skipped[0].active_decisions === MAX_GROUP + 1,
    `MAX_GROUP=${MAX_GROUP} pairs=${out.pairs.length} skipped=${JSON.stringify(out.skipped)}`)
}

function testFindForSelfExcluded() {
```

**Step 1.12b — F6: import the constant.**
File: `tests/test-contradiction.mjs`. Kind: **EDIT**.
`ANCHOR:`
```
  summaryJaccard, summaryTokenSet,
```
`REPLACE:`
```
  summaryJaccard, summaryTokenSet, MAX_GROUP,
```

**Step 1.13 — F8: assert `data_dir` carriage.**
File: `tests/test-contradiction.mjs`. Kind: **EDIT**.
`ANCHOR:`
```
  check('testDoctorWarnsOnContradiction',
    rows.length === 1 && rows[0].level === 'warn' && r.code === 0,
    `code=${r.code} rows=${JSON.stringify(rows)}`)
```
`REPLACE:`
```
  check('testDoctorWarnsOnContradiction',
    rows.length === 1 && rows[0].level === 'warn' && r.code === 0 &&
    typeof rows[0].data_dir === 'string' && rows[0].data_dir.length > 0,
    `code=${r.code} rows=${JSON.stringify(rows)}`)
```

**Step 1.14 — register the two new tests.**
File: `tests/test-contradiction.mjs`. Kind: **EDIT**.
`ANCHOR:`
```
testEmptySummaryNeverMatches()
testLargeGroupSkippedNotTruncated()
testFindForSelfExcluded()
```
`REPLACE:`
```
testChainCycleTerminates()
testEmptySummaryNeverMatches()
testLargeGroupSkippedNotTruncated()
testDefaultMaxGroupIsPinned()
testFindForSelfExcluded()
```

**Step 1.15 — verify the fold.**
| Verify (observed → expected) |
|---|
| `node tests/test-contradiction.mjs` → `20 passed, 0 failed` |
| `node tests/test-contradiction.mjs --break-detector` → non-zero exit |
| `node tests/test-em-doctor.mjs` → all pass |

Then print every observed output and STOP. Do not commit.
