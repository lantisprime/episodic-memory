# RFC-007-P3 — `wiki-link` + `composes-with` edges Plan

## §1 Status

`Planning only.` Do not implement until this plan and its review are accepted (Rule 18).
Current stage: **round-1 review folded, awaiting final approval**. Round 1 returned HOLD with
7 findings; all 7 are dispositioned in §19.1 and the 6 actionable ones are applied.

| Field | Value |
|---|---|
| RFC | `RFC-007` (graph projection) |
| Parent requirements | Phase 3 row `RFC-007-graph-projection.md:384`; test plan `:421-425` |
| Workplan episode | `20260725-143851-workplan-v268-587-merged-at-8e6e699-with-687e` (v268) |
| Target branch | `feat/rfc-007-p3-wiki-link-composes-with` |
| Executor altitude (§0.1) | **low** — Appendix A is the build path |
| GitHub issue | #589 |

## §2 Episode Search Summary

```bash
node scripts/em-search.mjs --tag rfc-007 --scope all --limit 12 --no-track --no-score
```

Returned 3 rows, none carrying design constraints beyond the workplan/handoff pair:

- `20260725-143851-…-687e` (workplan v268): queue head is #589; `main` = `8e6e699`; no open PRs.
- `20260725-143935-…-7a63` (handoff 93): Phase 2 and #587 both touched `em-graph.mjs`; the
  surface is warm. Carries "never accept a seat's verify summary" — the builder seat on the
  #587 arc reported 9 verifies matched spec and silently omitted the one that failed.
- `20260722-133545-…-99bf` (playbook v15, pinned, `authoritative`): pipeline order and role lock.

Verified-still-present (memories are point-in-time): `slugify()` at `scripts/lib/rule-nodes.mjs:30-38`
and `scanRuleNodes` imported at `scripts/em-graph.mjs:48` — both confirmed by direct read, not recall.

## §3 Objective

`em-graph.mjs` projects two new rule-to-rule edge types from rule-file bodies — `wiki-link`
(`[[name]]`) and `composes-with` (top-level bullets under `## Composes with`) — resolved to rule
slugs through the existing `slugify()`, with unresolved targets recorded in per-edge-type dangling
buckets. Provable by: a new suite whose 15+ shape-variant fixture asserts
`(resolved | dangling | ignored)` per row, and by `--from <rule-slug>` returning a multi-node
traversal where today it returns exactly one node.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent | Test(s) | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | `slugify` is imported from `scripts/lib/rule-nodes.mjs`; `em-graph.mjs` defines no second slug function | P2 `PRINCIPLES.md:27`; RFC `:129-143` | `manual: grep -c 'function slugify' scripts/em-graph.mjs` → 0 | MUST | Fork = principle violation |
| REQ-2 | `wiki-link` and `composes-with` appear in `EDGE_TYPES` and NOT in `DEFAULT_EDGES` | RFC `:669`, `:681` | `t_edge_types_registered`, `t_default_edges_unchanged` | MUST | Opt-in keeps default output byte-identical |
| REQ-3 | wiki-link parser classifies all 15 fixture shapes as `resolved`/`dangling`/`ignored` | RFC `:150`, `:422` | `t_wikilink_shape_matrix` (15 rows) | MUST | The ten RFC-named shapes + 5 extension rows |
| REQ-4 | Fenced code blocks and inline backticks are excluded from wiki-link extraction | RFC `:149`, `:423` | `t_wikilink_fence_exclusion`, `t_wikilink_inline_backtick_exclusion` | MUST | Mirrors the shipped `cites` behavior at `em-graph.mjs:207` |
| REQ-5 | `composes-with` reads top-level bullets only until the next `## ` or EOF; nested bullets ignored; `- [text](path.md)` resolved by basename | RFC `:151`, `:424` | `t_composes_toplevel_only`, `t_composes_nested_ignored`, `t_composes_markdown_link_basename` | MUST | |
| REQ-6 | An empty `## Composes with` section yields 0 edges AND 0 dangling entries | RFC `:152`, `:518` | `t_composes_empty_section_no_dangling` | MUST | Explicit false-pass trap in the RFC |
| REQ-7 | Unresolved targets land in `dangling[]` with `kind` = the edge type; dangling is distinct from orphans | RFC `:237`, `:242`, `:425` | `t_dangling_distinct_from_orphans`, `t_dangling_kind_values` | MUST | Bucket names per Decision 2 |
| REQ-8 | With no `--nodes` and no `--edges` flag, output is byte-identical to `8e6e699` and no rule file is read | Phase 2 REQ-8 (`em-graph.mjs:144-145`) | `t_default_output_byte_identical`, `t_default_mode_does_not_read_bodies` | MUST | Regression guard on the live 135-file corpus |
| REQ-9 | `--from <rule-slug>` traverses wiki-link/composes-with adjacency instead of early-returning a single node | `em-graph.mjs:290-292` (the comment promises this) | `t_from_rule_slug_traverses` | MUST | Requires editing the `:288-304` branch |
| REQ-10 | A rule node with ≥1 edge is NOT reported by `--orphans` | `em-graph.mjs:272-276` | `t_linked_rule_not_orphan`, `t_unlinked_rule_still_orphan` | MUST | Current code pushes every rule id unconditionally |
| REQ-11 | Rule nodes participate in `--hubs` degree ranking | `em-graph.mjs:262`, `:279` | `t_rule_node_can_be_hub` | MUST | `degree` map is episode-only today |
| REQ-12 | RFC-007 status rows, both contradictions, the stale Mermaid label, and `_shipped_use` are corrected in the same PR | #589 Acceptance | `manual: git diff docs/rfcs/RFC-007-graph-projection.md` | MUST | See §9 for the exact six sites |
| REQ-13 | The new suite is step-wired in `.github/workflows/tests.yml` | `tests.yml:401-405`; `test-ci-suite-registration.mjs` | `node tests/test-ci-suite-registration.mjs` → pass | MUST | Unwired suite fails CI by design |
| REQ-14 | An Implementation-ledger row for Phase 3 whose SHA comes from `git log --follow` | #589 Acceptance; lesson: #582 class | `manual: git log --follow --oneline scripts/em-graph.mjs` | MUST | Never copy a SHA from an adjacent row |
| REQ-15 | Target resolution tries the name-derived id first, then a filename-basename alias index; unresolvable targets dangle. Node ids are unchanged | Operator decision 2026-07-26; RFC `:151` basename clause | `t_alias_resolves_filename_style_link`, `t_name_id_wins_over_alias`, `t_ambiguous_alias_dangles` | MUST | Raises live-corpus resolution from 13/132 to 122/132 (wiki) and 0/76 to 51/76 (composes) |
| REQ-16 | `composes-with` extraction strips fenced blocks but NOT inline backticks | RFC `:149` scopes the exclusion to `wiki-link` + `cites` only | `t_composes_backticked_target_resolves` | MUST | Real bullets are `` - `file.md` — text ``; stripping inline code deletes every target |
| REQ-17 | RFC-007 gains a target-resolution subsection defining the alias index and reconciling `:142` with `:151` | Operator decision | `manual: git diff docs/rfcs/RFC-007-graph-projection.md` | MUST | The `:142` node-id rule stays untouched |

## §5 Non-Goals

- `--graph-health`, `entry_points[]`, the CI validator, `rfc-graph-contract-validate.mjs` — Phase 4 (#590), still blocked on #585.
- Persisted `graph.json` / `envelope_version` — Phase 6 (#592, DEFERRED).
- `cites-pr`, `trigger-phrase`, the MEMORY.md machine-readable trigger block — Phase 5 (#591).
- Absolute-path disclosure on rule/rfc nodes — #602, untouched.
- `em-console.mjs:114` flag passthrough — the new edges stay invisible through the console; not in scope, called out in §17.
- Folding `em-graph` modes into `em-search` — #593, an architecture call that should precede Phase 5.
- `em-restore.mjs`'s independent dangling-link mechanism (`:495`, `:963`) — different syntax, different corpus role; not unified here.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `scripts/em-graph.mjs` | 358 | ~1.8k | ~1.2k | 5 edit sites |
| `scripts/lib/rule-nodes.mjs` | 194 | ~1.0k | 0 | read-only; import source |
| `docs/rfcs/RFC-007-graph-projection.md` | 737 | ~3.7k | ~0.8k | 6 edit sites |
| `tests/test-em-graph-links.mjs` | 0 (new) | 0 | ~2.5k | ~22 cases |
| `.github/workflows/tests.yml` | 405+ | ~0.3k | ~0.1k | 1 step |

**Baseline (single session):** ~12k tokens of file I/O plus reasoning.
**Optimized:** two slices, S1 (wiki-link) then S2 (composes-with), sharing the extraction scaffold.

## §7 Safety / Security

No new trust boundary, no privilege vector, no child process, no path-authority predicate. The
feature reads files the script already reads and writes nothing (`t_no_writes` already exists in the
Phase 2 suite and must stay green).

Two input-handling concerns worth rows, both regex-shaped rather than security-shaped:

| Concern | Severity | Abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| Catastrophic backtracking on a hostile rule body | Low | A rule file with thousands of unclosed `[[` runs the parser super-linearly | Both regexes are bounded by negated character classes (`[^\]|#]+`, `[^\]]*`) with no nested quantifier over an alternation — linear | `t_wikilink_pathological_input_bounded` (10k unclosed `[[`, asserts completion) |
| Prototype-key rule slug | Low | A rule named `constructor` / `__proto__` corrupts the edge map | Slug maps are `new Map()`, not object literals — already the Phase 1 fix for `#469` | `t_proto_key_wiki_target` (negative: asserts no prototype pollution) |

No `negative-scenario-planner` dispatch: this is not a schema / validator / security / multi-actor
change. It is a parser addition behind an opt-in flag with no write path. Recorded here as a
deliberate call, not an omission.

**Cross-platform:** no new path handling. Fixtures use `os.tmpdir()` + `path.join`, matching
`test-em-graph-nodes.mjs:27-29`. No GNU-only flags, no `sed -i`, no `readlink -f`.

## §8 Design

### 8.1 Two decisions this PR must settle (both are RFC self-contradictions)

**Decision 1 — the wiki-link regex.** The RFC states it twice, non-equivalently:

| Site | Form |
|---|---|
| Prose, `:150` | `\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]` |
| Contract, `:674` | `\[\[([^\]|#]+)([|#][^\]]*)?\]\]` |

Both produce the **same capture group 1**, so target resolution is identical either way; the
difference is that the prose form keeps `#anchor` and `|alias` as two distinct non-capturing groups
while the contract form merges them into one capturing blob. **Recommendation: adopt the prose form
at `:150` as canonical and rewrite `:674` to match.** Rationale: it is the form documented alongside
the ten named shapes, and separating anchor from alias is what shape 6 (`[[name#anchor|alias]]` →
anchor stripped, alias dropped) actually describes. No behavioral difference either way, so this is
a documentation-coherence call, not a functional one.

**Decision 2 — the dangling bucket name.** Three sites, two spellings:

| Site | Value |
|---|---|
| Prose `:103` | `wiki-link-dangling` |
| Contract `:677` | `wiki-link` |
| Persisted-index `kind` enum `:237` | `wiki-link` |

**Recommendation: `wiki-link`, and rewrite the prose at `:103`.** Two of three sites already say it;
it is consistent with `composes-with` at `:689` (which is not `composes-with-dangling`); and the
string `wiki-link-dangling` appears nowhere else in the 737-line file.

### 8.2 Key types

```js
/**
 * @typedef {Object} DanglingEntry
 * @property {string} source — rule slug the unresolved link was found in
 * @property {string} ref    — the slugified target that did not resolve
 * @property {string} kind   — 'wiki-link' | 'composes-with'
 */
```

### 8.3 Key invariants

- **Opt-in.** Rule bodies are read only when `--nodes` includes `rule` AND `--edges` includes at
  least one of the two new types. Default invocation performs zero extra I/O (REQ-8).
- **One slug function.** `slugify` is imported, never redefined (REQ-1, P2).
- **Dangling ≠ orphan.** `dangling` = an edge whose target does not resolve. `orphan` = a node with
  degree 0. A rule can be both, neither, or either (RFC `:242`).
- **Rule-node edges are rule→rule only.** Neither edge type ever points at an episode or a tag.

### 8.4 Resolution flow

```text
rule file body
  → strip fenced blocks + inline backticks   (same treatment as cites, em-graph.mjs:207)
  → wiki-link regex  |  ## Composes with section scan
  → strip .md extension, strip #anchor, drop |alias
  → slugify(name)
  → ruleById.has(slug) ?  addEdge(source, slug, type)  :  dangling.push({source, ref, kind})
```

## §9 Existing Hook Points

Line numbers verified against `8e6e699` at plan time.

| File | Line(s) | What it does today | Impact |
|---|---|---|---|
| `scripts/em-graph.mjs` | 102-103 | `EDGE_TYPES` (5) / `DEFAULT_EDGES` (4) | Add 2 to `EDGE_TYPES` only |
| `scripts/em-graph.mjs` | 150-158 | `scanRuleNodes` + collision exit 2 | Body extraction hooks in after this |
| `scripts/em-graph.mjs` | 212-230 | Edge-building loop over episode `rows` | New rule-edge loop added after it |
| `scripts/em-graph.mjs` | 262 | `degree` map built from `rows` only | Rule ids must be seeded (REQ-11) |
| `scripts/em-graph.mjs` | 272-276 | Pushes **every** rule id as an orphan | Must become degree-aware (REQ-10) |
| `scripts/em-graph.mjs` | 288-304 | `--from <rule-slug>` early-returns 1 node | Must fall through to BFS (REQ-9) |
| `scripts/lib/rule-nodes.mjs` | 30-38 | `slugify()` | Imported, unchanged |

**RFC-007 edit sites (six), all corrected for drift:**

| # | Line | Change |
|---|---|---|
| 1 | 84, 85 | `UNBUILT — Phase 3` → `SHIPPED` + `em-graph.mjs:<line>` anchors |
| 2 | 103 | `wiki-link-dangling` → `wiki-link` (Decision 2) |
| 3 | 384 | Phase 3 row → **SHIPPED** |
| 4 | 394 | `P2[Phase 2 UNBUILT: …]` → `SHIPPED` (pre-existing stale label, contradicts `:383`) |
| 5 | 588 | `_shipped_use` rewritten — the "not used by the shipped script" claim is already false at `8e6e699` |
| 6 | 674, 669, 681 | Regex per Decision 1; both `status` fields flip |

Plus REQ-14's ledger row after `:447`.

## §10 Slice Ladder

| Slice | Objective | Primary files | Tests | Hard stops |
|---|---|---|---|---|
| `P3-S1` | wiki-link edge + dangling scaffold + mode integration (REQ-9/10/11) | `em-graph.mjs`, `tests/test-em-graph-links.mjs` | shape matrix, fence exclusion, dangling, mode tests | Do NOT touch `composes-with`; do NOT edit the RFC |
| `P3-S2` | `composes-with` edge reusing S1's scaffold | `em-graph.mjs`, `tests/test-em-graph-links.mjs` | section parsing, nested-ignored, empty-section | Do NOT touch S1 assertions |
| `P3-S3` | RFC coherence + ledger + CI wiring | `RFC-007-graph-projection.md`, `tests.yml` | `test-ci-suite-registration.mjs` | Do NOT touch `em-graph.mjs` |

```text
S1 ── S2 ── S3
```
All three are hard deps in order. One commit each, one PR.

## §11 Cut Order

Cut in this order if scope grows:

1. REQ-11 (rule nodes in `--hubs`) — file as a follow-up issue; orphans correctness matters more.
2. The 5 extension fixture rows beyond the RFC's ten named shapes (keep 15 total only if cheap).
3. S2 `composes-with` entirely — ship wiki-link alone, re-file Phase 3b.

Do **not** cut:

- REQ-8 (default output byte-identical) — this is the regression guard on a live 135-file corpus.
- REQ-1 (single `slugify`) — a forked slug function is a P2 violation.
- REQ-6 (empty section yields no dangling) — the RFC names it a non-negotiable false-pass trap.
- REQ-10 (linked rule is not an orphan) — shipping S1 without it makes `--orphans` actively wrong.

## §12 Contracts

### `extractWikiLinks(body) → { targets: string[], danglingRefs: string[] }`

**Input contract:** `body` is the full rule-file text including frontmatter. Non-string input
returns empty arrays rather than throwing.
**Output contract:** `targets` are slugs present in `ruleById`. `danglingRefs` are slugs that
resolved to a non-empty string but are absent from `ruleById`. Neither array contains duplicates or
empty strings. Never null.

**State table (exhaustive):**

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. resolved | `[[X]]`, `slugify(X)` in `ruleById` | `targets:[slug]` | none |
| B. dangling | `[[X]]`, slug non-empty, not in `ruleById` | `danglingRefs:[slug]` | none |
| C. ignored-empty | `[[]]` or `[[   ]]` | both empty | none |
| D. ignored-fenced | inside ` ``` ` or `~~~` | both empty | none |
| E. ignored-inline | inside single backticks | both empty | none |
| F. ignored-not-wiki | `[link](path.md)` | both empty | none |
| G. nested | `[[[[x]]]]` | outermost only, one entry | none |
| H. self-link | `slugify(X)` equals the source rule's own slug | both empty (self-loop guard, `em-graph.mjs:183`) | none |

**Error codes:** none — the extractor never exits. Malformed input degrades to "no edges", matching
`bodyCitations`'s `catch { return [] }` at `em-graph.mjs:209`.

## §13 Edge Cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | Rule file with no `name:` frontmatter contains `[[x]]` | file is not a node at all (`rule-nodes.mjs:118-121`), so it is not an edge source | `t_no_name_rule_emits_no_edges` |
| EC2 | `[[Name]]` vs `[[name]]` in two files | both slugify to `name`, one deduped edge | `t_case_folded_targets_dedupe` |
| EC3 | Slug collision already exits 2 at `:152-155` before any body scan | Phase 3 never runs on a colliding corpus | `t_collision_still_exits_2_before_extraction` |
| EC4 | `## Composes with` present, section empty | 0 edges AND 0 dangling (REQ-6) | `t_composes_empty_section_no_dangling` |
| EC5 | Unclosed fence — ` ``` ` opened and never closed | **remainder is NOT treated as fenced**; a wiki-link after it IS extracted. `stripFenced` is non-greedy and requires a closing fence, which is exactly what shipped `cites` does at `em-graph.mjs:207`. Parity with `cites` is the requirement (REQ-4), so this is the correct behavior, not a gap | `t_unclosed_fence_does_not_swallow_remainder` |
| EC6 | `## Composes with` followed immediately by `## Other` | section is empty, next heading terminates it | `t_composes_terminated_by_next_heading` |
| EC7 | Live corpus run — 68 files carry `[[…]]`, 21 carry the heading | real run completes, emits both edges and dangling entries | `manual:` §15 row |

## §14 Test Case Catalog

Runner: `node tests/test-em-graph-links.mjs`. Harness shape copies
`tests/test-em-graph-nodes.mjs:22-48` (local `t()`, `node:assert/strict`, `spawnSync`, temp
`HOME`, `writeRule()` helper, `process.exit(fail ? 1 : 0)`).

```text
Group 1: wiki-link shape matrix (15)
  t_wikilink_shape_matrix — 15 rows, each asserting resolved | dangling | ignored

Group 2: exclusion (3)
  t_wikilink_fence_exclusion
  t_wikilink_inline_backtick_exclusion
  t_unclosed_fence_does_not_swallow_remainder   (EC5, corrected: parity with cites)

Group 3: composes-with (8)
  t_composes_toplevel_only
  t_composes_nested_ignored
  t_composes_markdown_link_basename
  t_composes_empty_section_no_dangling
  t_composes_terminated_by_next_heading
  t_composes_backticked_target_resolves    (REQ-16 — the zero-edge trap)
  t_composes_prose_bullet_skipped          (review r1 finding 5)
  t_composes_first_backtick_run_wins       (review r1 finding 6)

Group 3b: target resolution (3)
  t_alias_resolves_filename_style_link
  t_name_id_wins_over_alias
  t_ambiguous_alias_dangles

Group 4: dangling (2)
  t_dangling_distinct_from_orphans
  t_dangling_kind_values

Group 5: mode integration (4)
  t_from_rule_slug_traverses
  t_linked_rule_not_orphan
  t_unlinked_rule_still_orphan
  t_rule_node_can_be_hub

Group 6: regression + robustness (6)
  t_default_output_byte_identical
  t_default_mode_does_not_read_bodies
  t_edge_types_registered
  t_default_edges_unchanged
  t_edges_all_emits_empty_dangling
  t_collision_still_exits_2_before_extraction

Group 7: hostile input (2)
  t_wikilink_pathological_input_bounded
  t_proto_key_wiki_target
```

Total: **29 named cases** — 21 in S1 (groups 1, 2, 3b, 4, 5, 6, 7), 8 added by S2 (group 3).
The count of individual assertions is fixed at build time and recorded in
§15; the suite prints `N passed, 0 failed` where N is the case count, matching both sibling suites.

Every fixture uses a unique sentinel slug (`sentinel-a1b2c3`) so a passing assertion cannot be
satisfied by an unrelated corpus entry (§A.9 discriminating-sentinel).

## §15 Verification Ledger

| Claim | Command | Observed |
|---|---|---|
| New suite passes | `node tests/test-em-graph-links.mjs` | _fill at build time_ |
| Phase 1 suite still green | `node tests/test-em-graph.mjs` | baseline `10 passed, 0 failed` |
| Phase 2 suite still green | `node tests/test-em-graph-nodes.mjs` | baseline `28 passed, 0 failed` |
| Suite is CI-wired | `node tests/test-ci-suite-registration.mjs` | _fill_ |
| Default output unchanged | `node scripts/em-graph.mjs --hubs --top 5` | must equal the `8e6e699` bytes |
| Live corpus behaves | `node scripts/em-graph.mjs --nodes rule --edges wiki-link --from <slug>` | _fill: real edges + dangling_ |
| No second slugify | `grep -c 'function slugify' scripts/em-graph.mjs` | `0` |
| CI green | `gh pr checks <PR>` | _fill — never claim from a local run_ |

## §16 Risk Analysis

| Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|
| REQ-9/10/11 mode changes regress Phase 2's 28 cases | Med | Med | Both prior suites are §15 rows; S1 runs them before S2 starts |
| Live corpus produces a flood of dangling entries (many `[[…]]` targets may not be rule nodes — 8 of 135 files lack `name:`) | Low | **High** | Expected, not a failure; §15 row records the real count. Thresholding is OQ-2 / Phase 4 |
| The 15-shape fixture is written to match the implementation rather than the spec | Med | Med | Fixture rows are transcribed from RFC `:150` before any parser code is written (S1 step order) |
| Builder seat reports success on unrun verifies | Med | Med | Handoff 93's lesson: re-run every verify myself; never accept the seat's summary |

## §17 Open Decisions

- **Decision 1 (regex form)** and **Decision 2 (bucket name)** — resolved in §8.1 as recommendations; both need operator sign-off before S3.
- **`--hubs` omits `skipped_nodes` (#603)** → the hubs branch at `em-graph.mjs:282` is already being
  edited for REQ-11, so adding `...nodeDiag()` would close #603 in one token. Deferred by default
  under the surgical-changes rule; **flagged for an explicit fold/no-fold call.** 5-field DEFER:
  (1) reproduced live — scout confirmed 8 real skips silently dropped on `--nodes rule --hubs`;
  (2) no RFC requirement mandates it; (3) filed as #603, no prior reviewer round; (4) same class is
  `--orphans`/`--from`, both of which already emit it, so hubs is the lone sibling left out;
  (5) residual: a diagnostic is silently absent — graceful, no corruption.
- **`em-console.mjs:114` passthrough** → new edges unreachable via the console. Not in Phase 3's
  primary-files row. Needs its own issue if we want console parity.
- **Suite filename** → `test-em-graph-links.mjs`, following the `-nodes` feature-slice precedent.
  No repo doc commits to a Phase 3 filename.

## §18 Done Criteria

- [ ] All 14 MUST requirements passing.
- [ ] Both existing em-graph suites still green.
- [ ] RFC-007's six edit sites corrected; `grep -c 'wiki-link-dangling'` → 0.
- [ ] Ledger row present with a `git log --follow`-derived SHA.
- [ ] Every deferred finding has an issue/comment/violation artifact (Rule 18 step 9).

## §19 Review Consensus (Rule 18)

Plan review before implementation, then a frozen-diff review after. Reviewer seat per the standing
directive: `pi --provider neuralwatt --model glm-5.2` (pre-authorized).

| Pass | Reviewer | Provider/Model | Blockers | Verdict | Artifact |
|---|---|---|---|---|---|
| 1 (plan) | pi seat, Herdr `drv-rfc007p3-20260726` | neuralwatt / glm-5.2, thinking high | 1 BLOCKER, 2 MAJOR, 4 MINOR | **HOLD** → folded | §19.1 below; seat spend $0.418 |
| 2 (diff) | _pending, post-implementation_ | neuralwatt / glm-5.2 | | | |

Cap at 2 rounds. A third HOLD on the same class means the patch boundary is wrong.

### 19.1 Resolved blockers (round 1)

| # | Finding | Disposition | Resolution + evidence |
|---|---|---|---|
| 1 | **BLOCKER** — §A.5.4 (step 1.8) calls `danglingOut()`, which step 1.9 defines. Verbatim application gives `ReferenceError`, dropping Phase 2 from 28 to 27 with no clean in-step fix | **ACCEPT** | Independently confirmed: `grep -n danglingOut <plan>` returned line 492 (definition, step 1.9) and 633 (use, §A.5.4). Removed the stray `...danglingOut(),` from §A.5.4; step 1.9 adds all three call sites |
| 2 | **MAJOR** — step 1.4's verify asserts the output carries a `dangling` key, but nothing surfaces that array until step 1.9. Unsatisfiable in-step | **ACCEPT** | Verify rewritten to a loop-presence grep, with an explicit note that the output-shape check belongs to step 1.9 |
| 3 | **MAJOR** — step 1.9's verify expected `grep -c 'danglingOut()'` → 4 "one definition + three call sites", but the definition reads `danglingOut = ()`, so that substring never matches it | **ACCEPT** | Corrected to `3`, with the reason stated inline so a future editor does not re-inflate it |
| 4 | **MINOR** — step 3.5's verify said "drops by exactly 5 from the pre-edit value", ambiguous because step 3.2 already removed 2 | **ACCEPT** | Confirmed `grep -c UNBUILT` = **17** at `8e6e699`. Restated as absolute counts (15 before → 10 after) naming the five sites |
| 5 | **MINOR** — `composesTargets`'s fallback slugified an entire prose bullet, manufacturing garbage dangling refs like `rule-17-claude-md-global-bot-reviews` | **ACCEPT** | A bullet that is neither a markdown link nor backtick-led now yields no target. New test `t_composes_prose_bullet_skipped` |
| 6 | **MINOR** — a bullet with two backticked spans silently keeps only the first | **ACCEPT-WITH-MOD** | Behavior kept (one bullet names one target) but made explicit in a code comment. New test `t_composes_first_backtick_run_wins` |
| 7 | **MINOR** — several step verifies are presence-only greps that a stub would pass | **NOTED, no change** | Reviewer's own assessment: each is back-stopped by the functional suites at 1.10 / 2.3 and by REQ-1. Recorded here for the §A.6b ledger rather than fixed |

**Verified sound by the reviewer, with commands actually run** (not reasoned about): REQ-8's
byte-identical default output traced through every payload at module scope; the §A.5.4 control flow
on all three paths; the wiki-link regex against all ten RFC shapes plus four adversarial extras
(shape 10 `[[[[x]]]]` → capture group 1 `[[x` → `x`, confirming the plan's claim); the alias index's
shadow-prevention and ambiguity handling; and REQ-16's backtick preservation.

## §20 Lessons Encoded

| Lesson | Rule | Enforced in |
|---|---|---|
| #606 / #582 stale-anchor class | Every RFC anchor re-verified against the file, never trusted from an issue body | §9, and the §9 drift table |
| Handoff 93 seat-summary lesson | Re-run every verify personally; a seat's "all matched" is a claim | §16, §15 |
| `…4a52` three-leg deploy | Post-merge deploy is global + consumer `shasum` sweep + marketplace pull | post-merge, not in this plan's scope |
| ledger provenance (#582) | Ledger SHA from `git log --follow`, never an adjacent row | REQ-14 |
| P2 single-adapter-contract | One `slugify`, imported | REQ-1 |
| discriminating sentinel | Fixtures carry a unique token; assertions inspect that token | §14 |
| verify-before-conclude | Artifact precedes the claim | §15 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-em-graph-links.mjs` |
| New-function phrasing | `function fnName(args)` (module-local; `em-graph.mjs` is a CLI, not a module — it exports nothing) |
| Portable break-input override | argv flag `--break-<x>` (cross-platform; no `VAR=x cmd` prefix) |
| Search tool for verifies | `grep -c` / `grep -n` from repo root |
| Repo-specific done-commands | `node tests/test-ci-suite-registration.mjs` |

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/RFC-007-P3-wiki-link-composes-with.md
```

Acceptance: matches are permitted only outside §A.5 blocks and §A.7 step rows. Record the match list
and per-match disposition beside the lint run. A reading pass over Appendix A is required in addition
to the grep, because line-based grep misses wrapped occurrences.

## A.2 Executor contract (copy verbatim into the handoff)

1. Do the steps in numeric order. Do not skip, reorder, or batch.
2. Each step names exactly one file, the exact change, and how to verify it.
3. Make no design decisions. If a step is ambiguous or an anchor is not found verbatim, STOP (§A.3).
4. Run the verify after each step. If it fails, fix only that step before proceeding.
5. Edit exactly ONE file per step. Read-only references (look, never edit): `scripts/lib/rule-nodes.mjs`, `tests/test-em-graph.mjs`, `tests/test-em-graph-nodes.mjs`.
6. Each verify is a single command — no `;`, `&&`, `||`, pipes, or subshells.
7. One slice = one commit, message `RFC-007-P3-S<n>: <slice title>`.
8. Do not commit, push, or open a PR until §18 is green and the human has approved.
9. No aspirational output: every printed line describing a check is backed by an assertion performing it.

## A.3 STOP-and-ask protocol

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous instruction | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <actual surrounding text, ±3 lines>
Question: <the single decision the plan owner must make>
```

## A.4 Pre-flight (step 0 of every slice)

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `feat/rfc-007-p3-wiki-link-composes-with` |
| Clean tree | `git status --porcelain` | empty except the known `.gitignore` carry |
| Phase 1 green | `node tests/test-em-graph.mjs` | `10 passed, 0 failed` |
| Phase 2 green | `node tests/test-em-graph-nodes.mjs` | `28 passed, 0 failed` |
| Runtime | `node --version` | `v20` or higher |

## A.5 Shared constants

```js
// Added to scripts/em-graph.mjs. Exact values — no placeholders.
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const COMPOSES_HEADING_RE = /^##[ \t]+Composes with[ \t]*$/im
const RULE_EDGE_TYPES = ['wiki-link', 'composes-with']
```

`WIKI_LINK_RE` is Decision 1's prose form verbatim from `RFC-007-graph-projection.md:150`, with the
global flag added for iteration.

## A.6 Anchor format

- **ANCHOR** is a verbatim unique substring already in the file. Not unique or not present → STOP.
- **CREATE** = whole-file `Write` of a new file, its own step, the only place a whole-file write is allowed.
- **EDIT** = anchored `ANCHOR → REPLACE`, smallest diff, no reformatting of untouched lines.
- **APPEND** = add a new block at end of file.

## A.7 Per-slice step tables

Decisions signed off by the operator: **Decision 1 = prose form at `:150`**, **Decision 2 =
`wiki-link`**, **#603 = do not fold**. Every literal below is instantiated from those three answers.

### `P3-S1` — wiki-link edge, dangling scaffold, mode integration (REQ-1/2/3/4/7/8/9/10/11)

**Files this slice may touch:** `scripts/em-graph.mjs`, `tests/test-em-graph-links.mjs`.
**Read-only:** `scripts/lib/rule-nodes.mjs`, `tests/test-em-graph.mjs`, `tests/test-em-graph-nodes.mjs`.

**Marked "focused review before build"** — steps 1.6 through 1.9 edit three mode branches that all
three suites exercise.

| Step | File | Kind | Exact action | Verify (observed → expected) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4. | every row passes |
| 1.1 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` `import { resolveRuleDir, scanRuleNodes, scanRfcNodes } from './lib/rule-nodes.mjs'` → `REPLACE:` `import { resolveRuleDir, scanRuleNodes, scanRfcNodes, slugify } from './lib/rule-nodes.mjs'` | `grep -c "scanRfcNodes, slugify" scripts/em-graph.mjs` → `1` |
| 1.2 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` `const EDGE_TYPES = ['supersedes', 'consolidates', 'evidence', 'cites', 'tags']` → `REPLACE:` `const EDGE_TYPES = ['supersedes', 'consolidates', 'evidence', 'cites', 'tags', 'wiki-link', 'composes-with']`. Do NOT touch the `DEFAULT_EDGES` line below it. | `node scripts/em-graph.mjs --edges wiki-link --orphans --scope local` → exit `0` (before this step the same command exits `2` with `Unknown edge type "wiki-link"`) |
| 1.3 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` the three lines ending `bodyCitations`, verbatim:<br>`    return [...new Set(cleaned.match(ID_RE) \|\| [])].filter(id => id !== row.id && byId.has(id))`<br>`  } catch { return [] }`<br>`}`<br>`REPLACE:` those three lines unchanged, then a blank line, then the §A.5 constants block plus `ruleBody(file)`, `targetSlug(raw)` and `linkTargets(cleaned)` exactly as spelled in §A.5.1 below. | `node -e "import('./scripts/lib/rule-nodes.mjs').then(m=>console.log(m.slugify('Alpha Rule')))"` → `alpha-rule` |
| 1.4 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` `  if (edgeTypes.includes('tags')) {`<br>`    for (const tag of strings(r.tags)) addEdge(r.id, \`tag:${tag.toLowerCase().trim()}\`, 'tags')`<br>`  }`<br>`}`<br>`REPLACE:` those four lines unchanged, then the wiki-link edge loop in §A.5.2. | `grep -c "edgeTypes.includes('wiki-link')" scripts/em-graph.mjs` → `1`. (The `dangling` array is populated here but is NOT yet in the output: `danglingOut()` is added at step 1.9, so an output-shape verify is unsatisfiable at this step.) |
| 1.5 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` `  const degree = new Map(rows.map(r => [r.id, 0]))` → `REPLACE:` that line, then `  for (const id of ruleById.keys()) degree.set(id, 0)` | `grep -c 'for (const id of ruleById.keys()) degree.set' scripts/em-graph.mjs` → `1` |
| 1.6 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` `  const reportable = r => includeSuperseded \|\| r.status !== 'superseded'` → `REPLACE:` `  const reportable = r => includeSuperseded \|\| r?.status !== 'superseded'`. **Reason (do not skip):** step 1.5 puts rule ids into `degree`, and the hubs filter calls `reportable(byId.get(id))`, which is `undefined` for a rule id. Without the optional chain this throws `TypeError: Cannot read properties of undefined`. | `node scripts/em-graph.mjs --nodes rule --edges wiki-link --hubs --scope local` → exit `0`, not a stack trace |
| 1.7 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` the five lines from `    // Phase 2 gives rule/rfc nodes no edges, so every one is degree 0 and is an orphan` through `    for (const id of rfcById.keys()) out.push(nodeOut(id, 0))` → `REPLACE:` the block in §A.5.3 (rule ids filtered to degree 0; rfc ids unchanged). | `node tests/test-em-graph-nodes.mjs` → `28 passed, 0 failed` |
| 1.8 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` the whole `--from` root-resolution branch, lines beginning `if (!byId.has(from)) {` through `  process.exit(1)`<br>`}` → `REPLACE:` the restructured branch in §A.5.4. A rule/rfc node **with** adjacency now falls through to the BFS; one **without** keeps the existing single-node reply; an unknown id still exits 1. | `node tests/test-em-graph-nodes.mjs` → `28 passed, 0 failed` (covers `t_from_rule_id_returns_single_node` and `t_from_unknown_id_still_exits_1`) |
| 1.9 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` `const nodeDiag = () => (nodesRaw === undefined ? {} : { skipped_nodes: skippedNodes })` → `REPLACE:` that line, then `const danglingOut = () => (edgeTypes.some(e => RULE_EDGE_TYPES.includes(e)) ? { dangling } : {})`. Then add `...danglingOut(),` immediately after each existing `...nodeDiag()` occurrence — there are exactly three (orphans output, from-single output, final BFS output). Do NOT add it to the hubs branch (#603 stays out of scope per the operator's fold decision). | `grep -c 'danglingOut()' scripts/em-graph.mjs` → `3`. The definition reads `danglingOut = ()`, so the substring `danglingOut()` matches call sites ONLY, never the definition line. |
| 1.10 | `tests/test-em-graph-links.mjs` | **CREATE** | Whole-file write. Harness copied from `tests/test-em-graph-nodes.mjs:22-48` (`t()` helper, `node:assert/strict`, `spawnSync`, temp `HOME` via `fs.mkdtempSync`, `resetRuleDir()`/`writeRule()`, `process.exit(fail ? 1 : 0)`). Contains Groups 1, 2, 3b, 4, 5, 6, 7 from §14 — **not** Group 3, which is S2. Every fixture rule slug carries the token `sentinel-a1b2c3`; every assertion inspects that token, never "non-empty". Full verbatim contents authored at build time under the §A.7 executor-ready gate. | `node tests/test-em-graph-links.mjs` → `21 passed, 0 failed` |
| 1.11 | — | — | Negative control (§A.9): run the suite with the break-input override, which forces `linkTargets()` to return `[]`. | `node tests/test-em-graph-links.mjs --break-wikilink` → non-zero exit |
| 1.12 | — | — | Commit `RFC-007-P3-S1: wiki-link edge, dangling scaffold, rule-node mode integration`. | `git log -1 --oneline` → shows `RFC-007-P3-S1` |

### `P3-S2` — `composes-with` (REQ-5/6)

**Files this slice may touch:** `scripts/em-graph.mjs`, `tests/test-em-graph-links.mjs`.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 2.0 | — | — | Pre-flight §A.4 plus `node tests/test-em-graph-links.mjs` → `21 passed, 0 failed`. | every row passes |
| 2.1 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` `function linkTargets(cleaned) {` → `REPLACE:` `composesTargets(cleaned)` from §A.5.5 inserted immediately above it, then `function linkTargets(cleaned) {` unchanged. Section runs from the `## Composes with` heading to the next line matching `^## ` or EOF; only lines matching `^-[ \t]+` are read; `^[ \t]+-` (nested) are skipped; `- [text](path.md)` resolves by basename via `path.basename(p, '.md')`. | `grep -c 'function composesTargets' scripts/em-graph.mjs` → `1` |
| 2.2 | `scripts/em-graph.mjs` | **EDIT** | `ANCHOR:` the closing brace of the wiki-link loop added in 1.4, verbatim from §A.5.2 → `REPLACE:` that brace, then the `composes-with` loop in §A.5.6, which reuses `ruleBody()` and pushes into the same `dangling` array with `kind: 'composes-with'`. | `node scripts/em-graph.mjs --nodes rule --edges composes-with --orphans --scope local` → exit `0`, JSON has `dangling` |
| 2.3 | `tests/test-em-graph-links.mjs` | **EDIT** | `ANCHOR:` the `main()` registration list added in 1.10 → `REPLACE:` same list plus Group 3's eight cases. Do NOT alter any S1 assertion. | `node tests/test-em-graph-links.mjs` → `29 passed, 0 failed` |
| 2.4 | — | — | Commit `RFC-007-P3-S2: composes-with edge`. | `git log -1 --oneline` → shows `RFC-007-P3-S2` |

### `P3-S3` — RFC coherence, ledger, CI wiring (REQ-12/13/14)

**Files this slice may touch:** `docs/rfcs/RFC-007-graph-projection.md`, `.github/workflows/tests.yml`.
**Hard stop:** do not touch `scripts/em-graph.mjs` or any test file in this slice.

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 3.0 | — | — | Pre-flight §A.4 plus all three suites green. | every row passes |
| 3.1 | `.github/workflows/tests.yml` | **EDIT** | `ANCHOR:` `      - name: Run em-graph node-projection suite (RFC-007 Phase 2)`<br>`        run: node tests/test-em-graph-nodes.mjs` → `REPLACE:` those two lines, then a blank line, then:<br>`      - name: Run em-graph link-edge suite (RFC-007 Phase 3)`<br>`        run: node tests/test-em-graph-links.mjs` | `node tests/test-ci-suite-registration.mjs` → pass |
| 3.2 | `docs/rfcs/RFC-007-graph-projection.md` | **EDIT** | Line 84 `ANCHOR:` `| \`wiki-link\` | UNBUILT — Phase 3 |` → `REPLACE:` `| \`wiki-link\` | SHIPPED — \`em-graph.mjs:<line>\` |` with `<line>` the real line of the wiki-link loop. Line 85 same treatment for `composes-with`. | `grep -c 'UNBUILT — Phase 3' docs/rfcs/RFC-007-graph-projection.md` → `0` |
| 3.3 | `docs/rfcs/RFC-007-graph-projection.md` | **EDIT** | Line 103 `ANCHOR:` `dangling links recorded as \`wiki-link-dangling\`` → `REPLACE:` `dangling links recorded in the \`wiki-link\` bucket` (Decision 2). | `grep -c 'wiki-link-dangling' docs/rfcs/RFC-007-graph-projection.md` → `0` |
| 3.4 | `docs/rfcs/RFC-007-graph-projection.md` | **EDIT** | Line 674 `ANCHOR:` `"parser": "regex:\\\\[\\\\[([^\\\\]\|#]+)([\|#][^\\\\]]*)?\\\\]\\\\]",` → `REPLACE:` the JSON-escaped form of Decision 1's prose regex, so the contract matches `:150` character for character after unescaping. | `node -e "const s=require('fs').readFileSync('docs/rfcs/RFC-007-graph-projection.md','utf8');console.log(s.includes('(?:#[^\\\\]\|]*)?'))"` → `true` |
| 3.5 | `docs/rfcs/RFC-007-graph-projection.md` | **EDIT** | Line 384 Phase 3 row `UNBUILT` → `**SHIPPED**`. Line 395 `P3[Phase 3 UNBUILT: wiki-link + composes-with]` → `SHIPPED`. Line 394 `P2[Phase 2 UNBUILT: rule + rfc node types]` → `SHIPPED` (pre-existing staleness; contradicts `:383` and ledger `:447`). Lines 669 and 681 `"status": "UNBUILT (Phase 3)"` → `"SHIPPED"`. | `grep -c 'UNBUILT' docs/rfcs/RFC-007-graph-projection.md` → **15 before this step, 10 after**. (Absolute, not relative: the file holds **17** at `8e6e699`; step 3.2 already removed 2 at lines 84-85. The five this step removes are lines **384, 394, 395, 670, 682**.) |
| 3.6 | `docs/rfcs/RFC-007-graph-projection.md` | **EDIT** | Line 588 `ANCHOR:` `"_shipped_use": "not used by the shipped script` … → `REPLACE:` a statement of actual use: slugify is called by `scanRuleNodes` (`lib/rule-nodes.mjs:117`) for rule-node ids since Phase 2, and by the Phase 3 link parsers for edge-target resolution. Tag ids still lowercase inline and do NOT use it. Correct the stale `em-graph.mjs:185` anchor to the real current line. | `grep -c 'not used by the shipped script' docs/rfcs/RFC-007-graph-projection.md` → `0` |
| 3.7 | `docs/rfcs/RFC-007-graph-projection.md` | **EDIT** | `ANCHOR:` the last ledger row (the Phase 2 row beginning `| Phase 2 — PR #604`) → `REPLACE:` that row, then a Phase 3 row. **The SHA comes from `git log --follow --oneline scripts/em-graph.mjs` on the merge commit — never copied from an adjacent row (#582 class).** | `git log --follow --oneline scripts/em-graph.mjs` → the SHA written into the row appears in this output |
| 3.9 | `docs/rfcs/RFC-007-graph-projection.md` | **EDIT** | `ANCHOR:` `Rule-file slugs derive from frontmatter \`name:\`. Filename-derived slugs are NOT used` … (the full `:143` paragraph) → `REPLACE:` that paragraph unchanged, then the §A.5.7 "Target resolution" subsection. Do NOT alter the `:142` node-id rule itself. | `grep -c '### Target resolution' docs/rfcs/RFC-007-graph-projection.md` → `1` |
| 3.10 | — | — | Commit `RFC-007-P3-S3: RFC coherence, target resolution, ledger row, CI wiring`. | `git log -1 --oneline` → shows `RFC-007-P3-S3` |

### A.5.1 – A.5.6 — verbatim code blocks referenced above

Copy-paste payloads. Plain Node ESM, zero deps, matching the surrounding file's style: no
semicolons, two-space indent, single quotes, `const` arrow helpers.

#### A.5.1 — extraction helpers + alias index (step 1.3)

```js
// --- Phase 3: rule-body edge extraction (RFC-007 wiki-link + composes-with) ---
// Fenced blocks are stripped for both edge types. Inline backticks are stripped
// for wiki-link ONLY (RFC-007:149 scopes that rule to wiki-link and cites): real
// "## Composes with" bullets write their target inside backticks, so stripping
// inline code there would delete every target and silently emit zero edges.
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const RULE_EDGE_TYPES = ['wiki-link', 'composes-with']
const dangling = []

const stripFenced = s => s.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
const stripInline = s => s.replace(/`[^`\n]*`/g, '')

function ruleBody(file) {
  try {
    const content = fs.readFileSync(file, 'utf8')
    const parts = content.split('---')
    return parts.length >= 3 ? parts.slice(2).join('---') : content
  } catch { return '' }
}

// Secondary index for TARGET resolution only. Node ids stay frontmatter-name
// derived (RFC-007:142 is untouched); authors nonetheless link by filename, so a
// slugified basename maps back to the owning node id. An ambiguous basename (two
// files slugifying alike) is dropped rather than guessed — the link dangles.
const ruleAlias = new Map()
for (const [slug, node] of ruleById) {
  const base = slugify(path.basename(node.file, '.md'))
  if (!base || ruleById.has(base)) continue
  if (ruleAlias.has(base)) ruleAlias.set(base, null)
  else ruleAlias.set(base, slug)
}

function resolveTarget(slug) {
  if (ruleById.has(slug)) return slug
  return ruleAlias.get(slug) || null
}

function targetSlug(raw) {
  return slugify(String(raw).trim().replace(/\.md$/i, ''))
}

function linkTargets(cleaned) {
  const out = []
  for (const m of cleaned.matchAll(WIKI_LINK_RE)) {
    const slug = targetSlug(m[1])
    if (slug) out.push(slug)
  }
  return [...new Set(out)]
}
```

#### A.5.2 — wiki-link edge loop (step 1.4)

```js

// Rule-to-rule edges. Rule bodies are read ONLY when a rule-edge type was
// requested, so a default invocation still performs zero rule I/O (REQ-8).
if (edgeTypes.includes('wiki-link')) {
  for (const [slug, node] of ruleById) {
    for (const raw of linkTargets(stripInline(stripFenced(ruleBody(node.file))))) {
      const target = resolveTarget(raw)
      if (target === slug) continue
      if (target) addEdge(slug, target, 'wiki-link')
      else dangling.push({ source: slug, ref: raw, kind: 'wiki-link' })
    }
  }
}
```

#### A.5.3 — orphans block (step 1.7)

```js
    // Phase 3 gives rule nodes real edges, so a rule is an orphan only at degree 0.
    // rfc nodes still have no edge type of their own, so every one stays degree 0 by
    // definition. Appended only when --nodes opted them in; both maps are empty
    // otherwise, so the default result set is unchanged (REQ-8).
    for (const id of ruleById.keys()) if ((degree.get(id) || 0) === 0) out.push(nodeOut(id, 0))
    for (const id of rfcById.keys()) out.push(nodeOut(id, 0))
```

#### A.5.4 — restructured `--from` root branch (step 1.8)

```js
if (!byId.has(from)) {
  if (ruleById.has(from) || rfcById.has(from)) {
    // A projected rule/rfc node is a legitimate traversal root. With no adjacency
    // (no rule-edge type requested, or a genuinely unlinked node) the result is the
    // node itself at depth 0. With adjacency it falls through to the BFS below.
    if (!adjacency.has(from)) {
      console.log(JSON.stringify({
        status: 'ok',
        root: from,
        depth,
        edge_types: edgeTypes,
        count: 1,
        nodes: [nodeOut(from, 0)],
        edges: [],
        ...nodeDiag(),
      }))
      process.exit(0)
    }
  } else {
    console.log(JSON.stringify({ status: 'error', message: `Episode "${from}" not found in the selected scope.` }))
    process.exit(1)
  }
}
```

#### A.5.5 — `composesTargets` (step 2.1)

```js
// Section runs from the "## Composes with" heading to the next "## " or EOF.
// Top-level bullets only: a leading-whitespace bullet is nested and ignored
// (RFC-007:151). Markdown-link form resolves by basename; the common real form
// wraps the target in backticks, which is why the caller does NOT strip inline
// code for this edge type (REQ-16).
const COMPOSES_HEADING_RE = /^##[ \t]+Composes with[ \t]*$/i
const MD_LINK_RE = /^\[[^\]]*\]\(([^)]+)\)/

function composesTargets(cleaned) {
  const out = []
  let inSection = false
  for (const line of cleaned.split('\n')) {
    if (COMPOSES_HEADING_RE.test(line.trim())) { inSection = true; continue }
    if (!inSection) continue
    if (/^##[ \t]/.test(line)) break
    if (/^[ \t]+-[ \t]/.test(line)) continue
    const bullet = /^-[ \t]+(.*)$/.exec(line)
    if (!bullet) continue
    const item = bullet[1].trim()
    const link = MD_LINK_RE.exec(item)
    const tick = /^`([^`]+)`/.exec(item)
    // One bullet names at most one target: a markdown link, or the FIRST
    // backtick run (a second backticked span on the same bullet is ignored).
    // A bullet that is neither — plain prose such as
    // "- Rule 17 (CLAUDE.md global) — bot reviews" — names no target and is
    // skipped. Slugifying the whole line instead would manufacture a garbage
    // dangling entry like "rule-17-claude-md-global-bot-reviews".
    if (!link && !tick) continue
    const raw = link ? path.basename(link[1], '.md') : tick[1]
    const slug = targetSlug(raw)
    if (slug) out.push(slug)
  }
  return [...new Set(out)]
}
```

#### A.5.6 — `composes-with` edge loop (step 2.2)

```js

// Fenced blocks stripped, inline backticks deliberately NOT (REQ-16).
if (edgeTypes.includes('composes-with')) {
  for (const [slug, node] of ruleById) {
    for (const raw of composesTargets(stripFenced(ruleBody(node.file)))) {
      const target = resolveTarget(raw)
      if (target === slug) continue
      if (target) addEdge(slug, target, 'composes-with')
      else dangling.push({ source: slug, ref: raw, kind: 'composes-with' })
    }
  }
}
```

#### A.5.7 — RFC-007 target-resolution subsection (step 3.9, REQ-17)

Inserted immediately after the `slugify()` block at `:143`:

```markdown
### Target resolution

Node ids are `slugify(frontmatter name)` and nothing else — the rule above is unchanged. Link
*targets* resolve in two steps, because authors write links by filename:

1. `slugify(target)` matched against the node-id index.
2. Failing that, matched against a filename-alias index: `slugify(basename)` of each rule file,
   mapped to that file's node id. A basename shared by two files is ambiguous and is dropped, so
   the link dangles rather than resolving to a guess.
3. Failing both, the link is recorded in the edge type's dangling bucket.

This is what the `composes-with` "resolved by file basename" clause below already requires, and it
does not reintroduce filename-derived node *ids*. Measured against the reference corpus at adoption
(135 rule files, 127 with `name:`): wiki-link resolution 13 → 122 of 132, composes-with 0 → 51 of 76.
```

## A.8 Definition of done

```bash
node tests/test-em-graph-links.mjs        # → 29 passed, 0 failed
node tests/test-em-graph.mjs              # → 10 passed, 0 failed
node tests/test-em-graph-nodes.mjs        # → 28 passed, 0 failed
node tests/test-ci-suite-registration.mjs # → pass
grep -c 'function slugify' scripts/em-graph.mjs   # → 0
grep -c 'wiki-link-dangling' docs/rfcs/RFC-007-graph-projection.md  # → 0
```

`deploy-audit.mjs` is NOT in this list: `scripts/em-graph.mjs` is a deployed script, so the audit
belongs to the post-merge deploy legs, not the slice gate.

## A.9 Blast-radius patterns applied

- **Red-then-green:** `t_default_output_byte_identical` must be shown failing under a deliberately
  broken build before it counts as a guard. Break input reaches the test via `--break-default-output`.
- **Pure-extraction first:** S1 lands the extraction scaffold and dangling plumbing; S2 adds a second
  caller. No shared core is carved out of existing functions.
- **Thin wrapper:** `slugify` is imported and called directly — `rule-nodes.mjs` is not restructured.
- **Fixture-change ledger:** checked, and **no existing assertion changes contract.** Verified rather
  than assumed:
  - Phase 2's `t_orphans_surfaces_rule_nodes` (`test-em-graph-nodes.mjs:232-242`) writes one rule file
    whose body is the literal `body` with no `[[…]]`, and invokes `--orphans --nodes rule` **without**
    any `--edges` flag. The rule-edge loop is gated on a rule-edge type being requested, so it never
    runs; the rule stays degree 0 and stays an orphan. Assertion holds unchanged.
  - Phase 1 uses `--edges all` twice (`test-em-graph.mjs:129`, `:131`). Neither passes `--nodes`, so
    `ruleById` is empty and no rule body is read. Both assert on `nodes`, not on the key set, so the
    added `dangling` key does not break them.
  - **Known output-shape change:** `--edges all` now implies the two new types, so orphans/from output
    gains `"dangling": []` on that path. Guarded by `t_edges_all_emits_empty_dangling`.
  No before → after assertion edits are required. If the executor finds one, that is a STOP (§A.3).
- **Discriminating sentinel:** every fixture rule carries `sentinel-a1b2c3` in its slug.
- **High blast radius:** S1 is marked **focused review before build** — it edits three mode branches
  (`:262`, `:272-276`, `:288-304`) that all three existing suites exercise.
