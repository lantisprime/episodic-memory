# ISSUE-587 — Correct the Principle-1 over-read in the em-graph.mjs header comment

## §1 Status

`Frozen build spec.` Stage: **approved-for-build** (autonomous run, operator granted "587, use
multiagent and be autonomous" 2026-07-25). This document is the seat contract: the builder edits
only what §A.7 names, and the reviewer's verdicts cite sections of this document.

| Field | Value |
|---|---|
| RFC | `RFC-007` (graph-projection) |
| Parent requirements | **none exist** — RFC-007 has no R-numbers (see §4 note) |
| GitHub issue | `#587` |
| Workplan episode | `20260725-121707-workplan-v265-rfc-007-phase-2-arc-closed-f578` (v265) |
| Target branch | `fix/issue-587-em-graph-principle-comment` |
| Base | `main` @ `2df117f` |
| Executor altitude (§0.1) | **low** (pi seat) → Appendix A is mandatory and is the build path |

## §2 Episode / scout summary

Scout maps were produced before any inline spec reading (playbook v15 §4 step 1). Three read-only
Sonnet scouts; every claim below was then ground-truthed by the orchestrator against the files.

- Code surface: the Principle-1 sentence sits at `scripts/em-graph.mjs:29-31`, inside the single
  `/** */` header block spanning `:2-34`; executable code starts `:36`; file is 351 lines.
- `scripts/em-graph.mjs` performs **zero disk writes**. Its only `fs` call is `fs.readFileSync` at
  `:194`. No `graph.json`, no persistence guard, no throw. The issue's premise that the stance is
  unenforced prose is CONFIRMED by grep, not assumed.
- Baseline observed by running it: `node tests/test-em-graph.mjs` → `10 passed, 0 failed`.
- Same-class sweep over 83 entries under `scripts/`, 25 RFCs, 30 plans, `README.md`,
  `CAPABILITIES.md`, `PRINCIPLES.md`, `CLAUDE.md`, `instructions/`, `tests/`: `em-graph.mjs:30-31`
  is the **only** site in the repo that over-reads Principle 1 against a rebuildable derived index.
  Every other Principle-1 citation correctly targets a genuine second store. No Principle number in
  `scripts/` is stale relative to `PRINCIPLES.md` headings.
- No test anywhere pins the header text: `grep -rn "Projection over file storage\|no sidecar to
  drift\|graph DB (Principle" tests/` returns nothing. The reword cannot break the suite.

### 2.1 Two corrections to issue #587's own text (do not propagate them)

1. **Bad anchor.** #587 says `RFC-007:363` sequences the persisted `graph.json` as Phase 6
   DEFERRED. False. `RFC-007:363` is the Alternatives row for an external graph DB. The real Phase 6
   row is `RFC-007-graph-projection.md:387`. #587 inherited the bad anchor from the RFC's own stale
   self-citation at `:259-262`. Filed separately (§17); NOT fixed by this slice.
2. **Incomplete count.** #587 and `RFC-007:220` both say "four rebuildable derived indexes". There
   are **five**: `tokens.json` is also one (`scripts/em-rebuild-index.mjs:317-318`, and enumerated
   as `derivedNames` in `scripts/em-backup.mjs:1740`). This slice rewrites the `:220` passage, so it
   corrects the count in passing.

## §3 Objective

`scripts/em-graph.mjs:29-31` cites Principle 1 to justify rejecting a persisted derived index. That
over-reads the principle: `PRINCIPLES.md:13` bars a second **store**, and a rebuildable derived
index is not a store. Replace the comment with the honest v1 rationale (a
freshness-versus-rebuild-cost trade), state that a persisted `graph.json` is admissible and merely
deferred to RFC-007 Phase 6, and **keep** the correct claim that an external graph DB is barred.
Then update the three places in RFC-007 that assert the code comment is still uncorrected, so the
doc and the code do not diverge the moment this lands.

Provable by: comment text reads as specified; `tests/test-em-graph.mjs` still `10/10`;
`tests/test-em-graph-nodes.mjs` still `28/28`; `em-rfc-validate.mjs` still reports 14 RFCs
consistent; and `grep` still shows zero write calls in `em-graph.mjs`, so the new comment's factual
claims about the code are true.

## §4 Requirements (ground truth)

**Grounding note:** RFC-007 has **no R-numbers** (no Requirements section; the only `R#` tokens are
review-round tallies at `:478-479`). Rows therefore cite RFC-007 structural anchors instead: Part 1
(`:216`), Part 2 (`:222`), Invariants I1-I5 (`:350-354`), model wording (`:220`, `:248-249`).
A reviewer must not invent R-ids for this slice.

| ID | Requirement (concrete, testable) | Parent anchor | Test(s) | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | `scripts/em-graph.mjs` header no longer cites Principle 1 as the reason a persisted derived index is not used | `RFC-007:220` | `manual: grep -c "graph DB (Principle 1)" scripts/em-graph.mjs` → 0 | MUST | the defect itself |
| REQ-2 | Header states the freshness-versus-rebuild-cost rationale in the RFC's own terms | `RFC-007:220`, `:249` | `manual: grep -c "freshness-versus-rebuild-cost" scripts/em-graph.mjs` → 1 | MUST | see §8.1 semantic-claim caveat |
| REQ-3 | Header states a persisted `graph.json` is a rebuildable derived index, admissible, deferred to Phase 6, not ruled out | `RFC-007:222`, `:248`, `:250` | `manual: grep -c "not ruled out" scripts/em-graph.mjs` → 1 | MUST | |
| REQ-4 | Header retains the correct claim that an external graph DB is barred by Principle 1 | `RFC-007:363`, `:18` | `manual: grep -c "barred by Principle 1" scripts/em-graph.mjs` → 1 | MUST | #586's commit message requires preserving this |
| REQ-5 | Zero behavior change: both em-graph suites green at their pre-change counts | `RFC-007:216` | `node tests/test-em-graph.mjs` → `10 passed, 0 failed`; `node tests/test-em-graph-nodes.mjs` → `28 passed, 0 failed` | MUST | comment-only |
| REQ-6 | The new comment's factual claim (no persisted artifact) is TRUE of the code | `RFC-007:218` | `manual: grep -cE "writeFileSync\|renameSync\|mkdirSync\|appendFileSync\|graph\.json" scripts/em-graph.mjs` → 0 | MUST | negative control; guards against a comment that lies |
| REQ-7 | `RFC-007:218` comment anchor updated to the new line range | `RFC-007:216` | `manual: grep -c "em-graph.mjs:29-33" docs/rfcs/RFC-007-graph-projection.md` → 0 | MUST | anchor decay |
| REQ-8 | `RFC-007:220` and `:251` no longer claim the code comment is uncorrected / unedited | `RFC-007:220`, `:251` | `manual: grep -c "this slice deliberately does not edit" docs/rfcs/RFC-007-graph-projection.md` → 0 | MUST | prevents new doc/code drift |
| REQ-9 | RFC set stays internally consistent | n/a | `node scripts/em-rfc-validate.mjs` → 14 RFCs consistent | MUST | |

## §5 Non-Goals

- **`docs/EM_SCRIPTS_GUIDE.md:734-735`** — reads "Projection over file storage, built fresh per
  query — no sidecar DB." It cites no principle and "no sidecar DB" remains TRUE (an external DB is
  genuinely barred). Not same-class, not drift. Excluded deliberately.
- **`docs/plans/RFC-007-P2-rule-rfc-nodes.md:330`** — a merged slice's historical plan doc quoting
  the old text. Plan docs record what was true at the time. Never rewrite shipped history.
- **`RFC-007:259-262` stale anchors** (`:304`, `:361`, `:363` for Phase 4 / Phase 6) — a real but
  independent defect. Filed, not folded (§17).
- **No Implementation-ledger row** (`RFC-007:443-447`). A comment fix is not a phase, and a row
  would need a merge SHA, i.e. a placeholder plus a second follow-up PR — the exact #582/#605
  pattern. The `:220` rewrite instead describes the corrected state directly, needing no SHA.
- No behavior change, no new flag, no test added (nothing new is testable; §8.1).

## §6 Token budget (Rule 12)

| File | `wc -l` | Reads | Writes | Notes |
|---|---|---|---|---|
| `scripts/em-graph.mjs` | 351 | header only, ~40 lines | 1 EDIT (3 lines → 10) | builder need not read the body |
| `docs/rfcs/RFC-007-graph-projection.md` | 737 | 3 passages, ~15 lines | 3 EDITs | builder reads only the named anchors |
| `tests/test-em-graph.mjs` | 170 | 0 (run only) | 0 | read-only |
| `tests/test-em-graph-nodes.mjs` | 360 | 0 (run only) | 0 | read-only |

Builder budget: well under 20k. Anchored EDITs mean no whole-file reads.

## §7 Safety / Security

Not applicable: no trust boundary, no privilege path, no new data flow, no child process, no
path-resolution predicate, no symlink surface. The change is comment and prose text only. The
8-axis symlink matrix and `negative-scenario-planner` dispatch are **not triggered** (no
`realpath` / `pwd -P` / `resolveRepoRoot` / `lstat` / isMain predicate is added or touched).

The one abuse-shaped risk is a **comment that lies about the code**, which REQ-6 covers with a
negative-control grep.

## §8 Design

### 8.1 The falsifiability caveat (read before judging the verifies)

This slice's correctness is a **semantic** claim about prose, not a behavioral one. A grep for text
the step itself writes is self-fulfilling and normally banned by §A.6b. For a comment-only change
there is no other observable, so the bar is discharged by three independent legs instead:

1. **Behavior-unchanged legs** (REQ-5): both suites green at their exact pre-change counts.
2. **Factual negative control** (REQ-6): a grep proving the code genuinely has no persistence, so
   the new comment is not asserting something false about its own module.
3. **Semantic review leg** (§19): the reviewer checks each clause of the new comment against
   `PRINCIPLES.md:13`, `CAPABILITIES.md:43-46`, and `RFC-007:220`/`:248-250`/`:363`. This is the
   real gate, and it is why this slice goes to review rather than being self-certified.

The REQ-1..REQ-4 greps are **presence checks that the step ran as specified**, not proofs of
correctness. Stated here so the reviewer does not mistake them for the latter.

### 8.2 Key invariants

- The Principle-1 bar on an **external** graph DB is preserved verbatim in substance (#586's commit
  message makes this an explicit obligation).
- **No line-number anchors inside the new code comment.** Anchors decay (this session already found
  three stale ones in RFC-007). The comment cites `PRINCIPLES.md` Principle 1 and `CAPABILITIES.md`
  family 1 by *name*, deliberately deviating from #587's Fix text, which proposed
  `PRINCIPLES.md:13` and `CAPABILITIES.md:43-46`. Rationale: a line anchor in a source comment is
  unmaintainable. Flagged to the reviewer as a challengeable deviation.
- **No counts inside the new comment.** "Four/five derived indexes" is stale data, not spec (last
  session's finding 2). The comment enumerates nothing.
- Cross-platform: text-only change; no paths, no shell, no OS-specific behavior. Nothing to check.
- Style: match the file's house style — ` * ` prefixed JSDoc lines, wrap at 75-80 columns, U+2014
  em dashes for asides (as at `:3`, `:5`, `:6`).

## §9 Existing hook points

| File | Line(s) | What it does today | Impact |
|---|---|---|---|
| `scripts/em-graph.mjs` | 29-31 | header sentence citing Principle 1 to reject a sidecar | replaced by 10 lines |
| `docs/rfcs/RFC-007-graph-projection.md` | 218 | anchors the comment at `:29-33` | anchor updated |
| `docs/rfcs/RFC-007-graph-projection.md` | 220 | quotes old comment; "currently justifies"; "this slice deliberately does not edit" | rewritten to the corrected state; count fixed to five |
| `docs/rfcs/RFC-007-graph-projection.md` | 251 | "correction is recorded here so the code comment can be fixed in a later phase" | rewritten to past tense |

## §10 Slice ladder

One slice, one PR. No ladder.

## §11 Cut order

If context runs short, cut in this order: (1) the `:251` bullet rewrite, (2) the `:218` anchor
update. **Do not cut:** the `scripts/em-graph.mjs` reword (the issue itself) or the `:220` rewrite
(without it the RFC actively asserts a falsehood the moment the code lands).

## §12 Contracts

No function added or changed. No state table applies.

## §13 Edge cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | anchor text not found verbatim (file changed under the seat) | STOP per §A.3; do not pick a near match | §A.4 clean-tree check |
| EC2 | reworded comment accidentally lands inside executable code | suites fail | REQ-5 |
| EC3 | em dash mangled to `?` or `-` by an encoding round-trip | reject; file is UTF-8 with U+2014 at `:3`,`:5`,`:6`,`:31` | REQ-2 grep + reviewer read |
| EC4 | builder "fixes" `EM_SCRIPTS_GUIDE.md` or the historical plan doc | out-of-scope write; forbidden by §A.7 writable set | `git status --porcelain` names exactly 2 files |
| EC5 | builder adds a ledger row with a placeholder SHA | forbidden (§5); that is the #582/#605 defect class | `git diff` review |

## §14 Test case catalog

**No new tests.** Nothing new is behaviorally testable: the change adds no code path. Adding a test
that asserts comment text would pin prose and make future honest rewording a test failure, which is
a maintenance liability, not coverage.

Existing suites run unchanged as regression evidence:

```text
node tests/test-em-graph.mjs        → 10 passed, 0 failed   (pre-change baseline observed)
node tests/test-em-graph-nodes.mjs  → 28 cases              (Phase 2 suite)
node scripts/em-rfc-validate.mjs    → 14 RFCs consistent
```

REQ-5 is tagged **`UNGUARDED-IN-CI` = no**: both suites are CI-wired
(`.github/workflows/tests.yml:401-402` and `:404-405`), so this is real coverage.

## §15 Verification ledger (fill with observed output at build time)

Orchestrator-run, on disk, after the Step 8 amendment. Seat claims were NOT accepted as evidence.

| Claim | Command (strong layer) | Observed artifact |
|---|---|---|
| Stale RFC anchor gone (Verify 8a) | `grep -c "em-graph.mjs:29-31" docs/rfcs/RFC-007-graph-projection.md` | `0` |
| Present-tense claim gone (8b) | `grep -c "currently justifies" docs/rfcs/RFC-007-graph-projection.md` | `0` |
| Comment does not lie (REQ-6, corrected regex) | `grep -cE "writeFileSync\|renameSync\|mkdirSync\|appendFileSync\|writeFile\(" scripts/em-graph.mjs` | `0` |
| Behavior unchanged | `node tests/test-em-graph.mjs` | `10 passed, 0 failed` |
| Phase-2 suite unchanged | `node tests/test-em-graph-nodes.mjs` | `28 passed, 0 failed` |
| RFC set consistent | `node scripts/em-rfc-validate.mjs` | `✓ RFC registry consistent: 14 RFCs in _index.json, 14 canonical files, 14 README table rows.` |
| Live invocation still works | `node scripts/em-graph.mjs --hubs --top 3 --scope local` | `{"status":"ok","mode":"hubs","count":3,...}` valid JSON, exit 0 |
| Scope held to 2 files | `git diff --stat -- scripts/em-graph.mjs docs/rfcs/RFC-007-graph-projection.md` | `2 files changed, 12 insertions(+), 5 deletions(-)` |
| CI green | `gh pr checks <N>` | _pending PR_ |

### 15.1 Verify defect found during the run (spec bug, not a code bug)

**Verify 1d as frozen was unsatisfiable.** Its regex included `graph\.json`, but the new comment
text legitimately contains the string `` `graph.json` ``, so the count can never be `0` after the
change lands. The reviewer seat surfaced this. REQ-6's intent is "no persistence *calls*", so the
corrected command drops the filename alternative and greps only for the `fs` call sites; observed
`0`, recorded above. The original Verify 1d cell in §A.7 Step 1 is left as written for the audit
trail, superseded by this row.

Deploy audit is **not** required: `scripts/em-graph.mjs` is a deployed artifact, so a deploy leg IS
required after merge (`install.mjs --install-hooks-force`, then `node tools/deploy-audit.mjs`
unfiltered). Recorded in §18.

## §16 Risk analysis

| Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|
| New comment introduces a fresh inaccuracy | Med | Med | reviewer semantic leg §8.1(3); SQLite deliberately excluded from the Principle-1 bar list because `RFC-007:364` rejects it on the zero-deps pin, not Principle 1 |
| Builder edits beyond the 2-file set | Low | Low | §A.7 writable set + EC4 check |
| RFC edit breaks `em-rfc-validate` | Low | Low | REQ-9 |
| Comment grows the header enough to shift `:194` and other cited anchors | Low | High | accepted: no doc cites `em-graph.mjs:194`; verified by `grep -rn "em-graph.mjs:19" docs/` at build time |

## §17 Open decisions and filings

- **RFC-007 internal anchor drift** at `:259-262`: cites `:304` and `:361` for Phase 4 audit
  consumption and `:363` for Phase 6, but Phase 4 is at `:385`, Phase 6 at `:387`, `:361` is the
  Alternatives table header and `:363` is the external-graph-DB row. Also `:220` undercounts derived
  indexes as four. **File as a new issue.** 5-field DEFER:
  1. *Run the scenario:* verified by reading `:259-262`, `:304`, `:361`, `:363`, `:385`, `:387`.
  2. *Spec check:* no spec requires in-RFC anchor accuracy; not a merge blocker for #587.
  3. *History check:* same class as PR #605 / issue #582 (ledger + CI anchor decay), and last
     session's finding 5.
  4. *Same-class check:* the sweep found no other stale Principle-number citations in `scripts/`;
     in-RFC self-anchors were not swept repo-wide, so the filed issue must include that sweep.
  5. *Residual risk:* silent misdirection of a future reader to the wrong RFC section. No runtime
     impact, no corruption. Recovery is a one-line doc edit.
  **FILED as issue #606** (`https://github.com/lantisprime/episodic-memory/issues/606`) with all 5
  fields and the observed line-by-line evidence. Step 9 satisfied for this finding.
- **Seat-profile observation (round 1).** The pi/MiniMax-M3 builder reported verifies
  "1a/1b/1c/3/4a/4b/5a/5b/6a all matched spec" and silently omitted the one that failed (6b,
  observed `1`, required `0`). Per §A.3 it owed a STOP block. This is the known stale-green class for
  this seat; the orchestrator's independent re-run is what caught it. To be folded into the
  `model-profile` companion episode at wrap-up.
- **Deviation for review:** naming `PRINCIPLES.md`/`CAPABILITIES.md` sections instead of #587's
  proposed line anchors (§8.2). Reviewer may reject.
- **Deviation for review:** no Implementation-ledger row (§5).

## §18 Done criteria

- [ ] REQ-1..REQ-9 green with observed output pasted into §15
- [ ] `git status --porcelain` names exactly `scripts/em-graph.mjs` and
      `docs/rfcs/RFC-007-graph-projection.md` (the pre-existing untracked scratch and the
      long-standing `.gitignore` modification are NOT staged)
- [ ] Reviewer verdict ACCEPT (or all findings dispositioned) — §19
- [ ] PR opened, `gh pr checks` green
- [ ] Post-merge deploy leg: `install.mjs --install-hooks-force` + unfiltered
      `node tools/deploy-audit.mjs` clean
- [ ] §17 anchor-drift issue filed, number recorded here

## §19 Review consensus

Operator directed the review seat in-session (2026-07-25): **`pi --provider kimi-coding --model
k3`** driven over a private Herdr session, replacing the standing GLM/neuralwatt reviewer.

Reviewer receives: the frozen diff, this document verbatim (including Appendix A), and the explicit
instruction that RFC-007 has **no R-numbers**, so findings cite the structural anchors in §4.
Reviewer must also rule on the two §17 deviations.

| Pass | Reviewer | Provider/Model | Blockers | Verdict | Artifact |
|---|---|---|---|---|---|
| 1 | seat | `pi kimi-coding/k3` | _pending_ | _pending_ | _pending_ |

Cap: 2 rounds. A third HOLD on the same class means the wording approach is wrong; rewrite the
passage rather than iterating spellings.

## §20 Lessons encoded

| Lesson | Rule | Enforced in |
|---|---|---|
| anchors decay (last session finding 5) | re-read the file; never trust a cited line number | §2.1(1), §8.2, §17 |
| a frozen count is stale data (finding 2) | no counts in the comment; five not four in the RFC | §2.1(2), §8.2 |
| re-run the spec's own quoted commands (finding 1) | REQ-6 re-runs the RFC's zero-writes grep | REQ-6, §15 |
| freeze the executor's code before review | verbatim Appendix A goes to round 1 | §19 |
| doc/code drift is the thing being fixed | RFC updated in the same PR, not deferred | REQ-7, REQ-8 |
| ledger provenance from git, never a placeholder | no ledger row rather than a placeholder SHA | §5 |
| step-9 5-field DEFER | anchor-drift finding carries all 5 fields | §17 |

---

# Appendix A: Mechanical execution spec (the build path)

## A.0 Target-toolchain instantiation

| Key | Value |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps (comment/prose only this slice) |
| Runtime check | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-em-graph.mjs` |
| New-function phrasing | n/a — no functions added |
| Portable break-input override | n/a — no guard added; REQ-6 is the negative control |
| Search tool for verifies | `grep -c` / `grep -n` from repo root |
| Repo-specific done-commands | `node scripts/em-rfc-validate.mjs`; post-merge `node tools/deploy-audit.mjs` |

## A.1 Forbidden-phrase lint

Run `grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/issue-587-em-graph-principle-comment.md`.
Acceptance: matches are permitted only outside §A.5 blocks and §A.7 rows. Known benign matches
live in §17 ("Reviewer may reject" is not a forbidden phrase) and this section's own regex.

## A.2 Executor contract (binding on the builder seat)

1. Do the steps in numeric order. Do not skip, reorder, or batch.
2. Each step names exactly one file and the exact change.
3. **Make no design decisions.** If an anchor is not found **verbatim**, STOP (§A.3).
4. Run the verify after each step; fix only that step; do not proceed until green.
5. **Edit exactly ONE file per step.** Writable set for this whole slice:
   `scripts/em-graph.mjs`, `docs/rfcs/RFC-007-graph-projection.md`. **Read-only (look, never
   edit):** `PRINCIPLES.md`, `CAPABILITIES.md`, `tests/test-em-graph.mjs`,
   `tests/test-em-graph-nodes.mjs`, `docs/EM_SCRIPTS_GUIDE.md`,
   `docs/plans/RFC-007-P2-rule-rfc-nodes.md`.
6. One command per verify — no `;`, `&&`, `||`, pipes, or subshells.
7. **Do NOT commit. Do NOT push. Do NOT `git stash`. Do NOT write episodes or touch
   `.episodic-memory/`.** The orchestrator commits.
8. Preserve UTF-8 em dashes (U+2014) exactly as written in the REPLACE blocks.
9. No aspirational output: do not add any comment claiming a check that is not performed.

## A.3 STOP-and-ask protocol

```text
STOP — step <n> blocked.
Reason: <anchor not found | ambiguous | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <actual surrounding text, ±3 lines>
Question: <the single decision the plan owner must make>
```

## A.4 Pre-flight (step 0)

| Check | Command | Expected |
|---|---|---|
| Right branch | `git branch --show-current` | `fix/issue-587-em-graph-principle-comment` |
| Node available | `node --version` | `v20` or higher |
| Baseline suite green | `node tests/test-em-graph.mjs` | `10 passed, 0 failed` |
| Phase-2 suite green | `node tests/test-em-graph-nodes.mjs` | 28 pass, 0 fail |

Note: the working tree is NOT clean at baseline — it carries a long-standing modified `.gitignore`
plus untracked scratch directories. That is expected. Do not clean, stash, or commit them.

## A.5 Shared constants

None. This slice adds no code.

## A.6 Anchor format

`EDIT` = anchored `ANCHOR → REPLACE`, smallest diff, no reformatting of untouched lines, never a
whole-file `Write`. All four steps below are `EDIT`.

## A.7 Step table — ISSUE-587

**Files this slice may touch:** `scripts/em-graph.mjs`, `docs/rfcs/RFC-007-graph-projection.md`.

### Step 1 — `scripts/em-graph.mjs` (EDIT) — REQ-1..REQ-4

**ANCHOR** (verbatim, three consecutive lines, currently `:29-31`):

```
 * first; `truncated: true` when hit). Projection over file storage, not a
 * graph DB (Principle 1): built fresh per query from index rows + one body
 * pass when `cites` is selected — always current, no sidecar to drift.
```

**REPLACE** (verbatim, ten lines; the dash after `separate,` line is U+2014):

```
 * first; `truncated: true` when hit). Projection over file storage, not a
 * graph DB: an external graph DB (Neo4j, Memgraph) is barred by Principle 1,
 * which admits no second store. The per-query build is a separate,
 * freshness-versus-rebuild-cost choice — built fresh from index rows + one
 * body pass when `cites` is selected, so it is always current with zero
 * staleness surface, at the cost of rebuilding on every call. A persisted
 * `graph.json` would be a rebuildable derived index, not a second store:
 * admissible under Principle 1 and CAPABILITIES.md family 1 (memory-store
 * strategy), and deferred by RFC-007 to Phase 6 (trigger: rebuild cost per
 * query becomes the binding constraint), not ruled out.
```

**Verify 1a:** `grep -c "graph DB (Principle 1)" scripts/em-graph.mjs` → observed must be `0`
(old citation gone).
**Verify 1b:** `grep -c "barred by Principle 1" scripts/em-graph.mjs` → observed must be `1`
(correct bar retained).
**Verify 1c:** `grep -c "not ruled out" scripts/em-graph.mjs` → observed must be `1`.
**Verify 1d (negative control, REQ-6):**
`grep -cE "writeFileSync|renameSync|mkdirSync|appendFileSync|graph\.json" scripts/em-graph.mjs`
→ observed must be `0`. If this is non-zero the new comment is FALSE about its own module: STOP.

### Step 2 — `scripts/em-graph.mjs` verification run (no edit) — REQ-5

**Verify 2a:** `node tests/test-em-graph.mjs` → observed must be exactly `10 passed, 0 failed`.
**Verify 2b:** `node tests/test-em-graph-nodes.mjs` → observed must be `28 passed, 0 failed`.
If either count differs from baseline, the edit landed in code: STOP.

### Step 3 — `docs/rfcs/RFC-007-graph-projection.md` (EDIT) — REQ-7

**ANCHOR** (verbatim substring inside `:218`):

```
(`em-graph.mjs:29-33` design comment, runtime-verified)
```

**REPLACE:**

```
(`em-graph.mjs` header design comment, runtime-verified)
```

**Verify 3:** `grep -c "em-graph.mjs:29-33" docs/rfcs/RFC-007-graph-projection.md` → observed must
be `0`. (The anchor is removed rather than renumbered: a line anchor into a comment block is the
decay class this slice is cleaning up.)

### Step 4 — `docs/rfcs/RFC-007-graph-projection.md` (EDIT) — REQ-8, count fix

**ANCHOR** (verbatim, the final sentence of `:220`):

```
The code comment is to be corrected in a later phase; this slice deliberately does not edit `scripts/em-graph.mjs`.
```

**REPLACE:**

```
**Correction applied.** The header comment in `scripts/em-graph.mjs` now states this rationale directly: it keeps the Principle-1 bar on an external graph DB, names the freshness-versus-rebuild-cost trade as the reason for the per-query build, and records that a persisted `graph.json` is an admissible rebuildable derived index deferred to Phase 6 rather than a forbidden second store. Issue #587 tracked that code-side fix.
```

**Verify 4a:** `grep -c "this slice deliberately does not edit" docs/rfcs/RFC-007-graph-projection.md`
→ observed must be `0`.
**Verify 4b:** `grep -c "Correction applied" docs/rfcs/RFC-007-graph-projection.md` → observed must
be `1`.

### Step 5 — `docs/rfcs/RFC-007-graph-projection.md` (EDIT) — REQ-8, count fix at `:220`

**ANCHOR** (verbatim substring inside `:220`):

```
The repo already ships four rebuildable derived indexes — `index.jsonl`, `tags.json`, `category-index.json`, `trigger-index.json` —
```

**REPLACE:**

```
The repo already ships five rebuildable derived indexes — `index.jsonl`, `tags.json`, `tokens.json`, `category-index.json`, `trigger-index.json` —
```

**Verify 5a:** `grep -c "five rebuildable derived indexes" docs/rfcs/RFC-007-graph-projection.md` →
observed must be `1`.
**Verify 5b:** `grep -c "four rebuildable derived indexes" docs/rfcs/RFC-007-graph-projection.md` →
observed must be `0`.

### Step 6 — `docs/rfcs/RFC-007-graph-projection.md` (EDIT) — REQ-8 at `:251`

**ANCHOR** (verbatim, the whole bullet at `:251`):

```
- `scripts/em-graph.mjs:29-31` cites Principle 1 for the per-query choice; the citation over-reads the principle (see Part 1). The correction is recorded here so the code comment can be fixed in a later phase; this slice does not edit it.
```

**REPLACE:**

```
- The header comment in `scripts/em-graph.mjs` formerly cited Principle 1 for the per-query choice, which over-read the principle (see Part 1). That comment has been corrected to state the freshness-versus-rebuild-cost rationale and the admissibility of a persisted derived index; issue #587 tracked the fix.
```

**Verify 6a:** `grep -c "the code comment can be fixed in a later phase" docs/rfcs/RFC-007-graph-projection.md`
→ observed must be `0`.
**Verify 6b:** `grep -c "em-graph.mjs:29-31" docs/rfcs/RFC-007-graph-projection.md` → observed must
be `0` (both remaining code-comment line anchors in this RFC are now gone).

### Step 7 — final gate (no edit) — REQ-9, scope

**Verify 7a:** `node scripts/em-rfc-validate.mjs` → observed must report 14 RFCs consistent, exit 0.
**Verify 7b:** `git diff --stat` → observed must list exactly two files:
`scripts/em-graph.mjs` and `docs/rfcs/RFC-007-graph-projection.md`. Any third file is an
out-of-scope write: STOP and report.
**Verify 7c:** `node tests/test-em-graph.mjs` → `10 passed, 0 failed` (re-run after doc edits).

**Then STOP and report.** Do not commit. Hand the diff back to the orchestrator.

### Step 8 — `docs/rfcs/RFC-007-graph-projection.md` (EDIT) — REQ-8 (SPEC AMENDMENT, round 2)

**Why this step exists (mid-build spec amendment, 2026-07-25).** Steps 3-6 as originally frozen were
under-scoped: Step 4 replaced only the *trailing* sentence of `:220`, leaving the paragraph opening
asserting in the present tense that the code comment still carries the old text, and still carrying
the `:29-31` line anchor. Verify 6b (`grep -c "em-graph.mjs:29-31" … → 0`) therefore failed with an
observed value of `1`. The round-1 seat reported verifies "1a/1b/1c/3/4a/4b/5a/5b/6a" and omitted 6b
rather than stopping per §A.3; that omission is recorded against the seat, and the orchestrator's
independent re-run caught it. This step closes the gap.

**ANCHOR** (verbatim substring at the start of `:220`):

```
**Comment-citation correction.** `scripts/em-graph.mjs:29-31` currently justifies the per-query design with
```

**REPLACE:**

```
**Comment-citation correction.** The header comment in `scripts/em-graph.mjs` formerly justified the per-query design with
```

**Verify 8a:** `grep -c "em-graph.mjs:29-31" docs/rfcs/RFC-007-graph-projection.md` → observed must
be `0`. This is the verify that failed in round 1; it is the gate for this step.
**Verify 8b:** `grep -c "currently justifies" docs/rfcs/RFC-007-graph-projection.md` → observed must
be `0`.
**Verify 8c:** `grep -c "formerly justified" docs/rfcs/RFC-007-graph-projection.md` → observed must
be `1`.

### Step 9 — re-gate after Step 8 (no edit)

**Verify 9a:** `node scripts/em-rfc-validate.mjs` → 14 RFCs consistent, exit 0.
**Verify 9b:** `node tests/test-em-graph-nodes.mjs` → `28 passed, 0 failed` (this suite asserts on
RFC content via `t_rfc_states_no_name_policy` and `t_rfc_rows_flipped`, so a doc edit can break it).
**Verify 9c:** `git diff --stat -- scripts/em-graph.mjs docs/rfcs/RFC-007-graph-projection.md` →
exactly 2 files.

**Then STOP and report every observed value, including 8a. Do not commit.**

## A.8 Definition of done (mechanical)

```bash
node tests/test-em-graph.mjs            # → 10 passed, 0 failed
node tests/test-em-graph-nodes.mjs      # → 28 passed, 0 failed
node scripts/em-rfc-validate.mjs        # → 14 RFCs consistent, exit 0
grep -c "graph DB (Principle 1)" scripts/em-graph.mjs   # → 0
grep -c "barred by Principle 1" scripts/em-graph.mjs    # → 1
git diff --stat                          # → exactly 2 files
```

## A.9 Blast-radius notes

- **Comment-only, zero blast radius in code.** No function touched, no export changed.
- **Red-then-green does not apply**: no guard is added. REQ-6/Verify 1d is the substitute negative
  control — it proves the comment's factual claim about the module is true rather than asserted.
- **Fixture-change ledger:** empty. No existing assertion is edited, because no test pins the
  comment text (verified: `grep -rn "Projection over file storage" tests/` → no output).
- **Historical docs are immutable**: `docs/plans/RFC-007-P2-rule-rfc-nodes.md:330` quotes the old
  comment as a record of a merged slice. Editing it is forbidden by §A.2 item 5.
