# Issue 558 Workflow Event Classification Plan

## §1 Status

Planning and review precede product edits. Current stage: approved for build.

| Field | Value |
|---|---|
| RFC | RFC-002 Phase 3b-H1 PR-C |
| Parent requirements | RFC-002:274-327; docs/specs/workflow-lifecycle.md Storage |
| Workplan episode | 20260722-061917-workplan-v225-records-envmgr-trigger-ind-56f1 |
| Target branch | fix/issue-558 |
| Executor altitude | low |

## §2 Episode Search Summary

The active workplan names issue 558 as the queue head. The terminal handoff
requires an isolated-store reproduction before planning. The first reproduction
used the real em-store writer and current validator:

    node scripts/em-workflow-validate.mjs --task unrelated-task --gate pre-checkpoint --scope local

Observed on current main: exit 1 with an error naming
20260722-065228-bp1-deadline-tick-repro-ccae and
No json fenced block found.

That first reproduction establishes the strict unfenced-record failure but is
not the producer-specific proof. The regression suite must run the real
check-deadlines producer, confirm its plain type: evidence frontmatter, rebuild
the local index because the producer writes only the episode file, and capture
the same red result before the validator edit.

Relevant active memories:

- 20260722-062219-handoff-54-stable-correction-removes-lit-308d: reproduce the
  record-type-absent deadline tick before planning.
- 20260722-133545-consolidated-tiered-multi-agent-orchestr-99bf: Herdr scouts
  first, sequenced builder, frozen-diff review, independent verification.
- 20260713-133606-multi-agent-approach-playbook-v4-adds-ma-5438: report seat
  token, cost, elapsed, and context telemetry.

## §3 Objective

Make em-workflow-validate classify typed BP-1 operational records as
non-workflow events before lifecycle payload parsing. A real scheduled
bp1-deadline-tick record with type: evidence must no longer create a false
fenced-block error or migrated warning beside an otherwise valid unrelated
task chain, while an untyped or unknown-typed workflow.lifecycle record without
the required JSON fence must still fail.

## §4 Requirements

| ID | Requirement | Parent | Tests | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | Known BP-1 frontmatter types evidence, failure, and state-transition bypass lifecycle payload parsing. | RFC-002:274-327; P2; P7 | real producer test; typed sibling test | MUST | Typed scalar, never tag selection. |
| REQ-2 | Existing record_type exclusions clerk-run and promote-run remain unchanged. | RFC-009 R9; RFC-012 R2d | test-promote-apply | MUST | No second run-record vocabulary. |
| REQ-3 | Missing or unknown frontmatter type plus an unfenced body remains a fatal validator error. | workflow-lifecycle Storage; P5 | untyped negative; unknown-type negative; existing T14 | MUST | Gate remains fail-closed. |
| REQ-4 | A valid plan-approved to pre-checkpoint chain passes without a tick parse warning in an isolated store containing a real deadline tick from bp1-orchestrator. | RFC-002:274-327 | real producer integration test | MUST | Includes real writer, rebuild, validator, and warning oracle. |
| REQ-5 | The new regression suite and the existing workflow-validator regression suite run in GitHub Actions; the new suite is absent from the unwired baseline. | P4; verify-by-artifact | test-ci-suite-registration | MUST | Direct workflow registration. |
| REQ-6 | Output JSON and exit-code contracts remain unchanged. | P5; P11 | targeted suites | MUST | No new output field. |

## §5 Non-Goals

- Changing workflow.lifecycle category semantics.
- Rewriting, deleting, or revising the historical deadline-tick episode.
- Weakening the JSON-fence requirement for genuine lifecycle events.
- Adding tags as a correctness or routing input.
- Changing bp1-orchestrator, em-store, em-rebuild-index, or run-record writers.

## §6 Token Budget

| File | Lines | Read estimate | Write estimate | Notes |
|---|---:|---:|---:|---|
| scripts/em-workflow-validate.mjs | 953 | 4.8k | 35 lines | Classification helper and loop branch. |
| tests/test-workflow-non-event-classification.mjs | 0 | 0 | about 180 lines | New isolated integration suite. |
| .github/workflows/tests.yml | 449 | 2.2k | 6 lines | New and existing validator CI registration. |
| tests/test-ci-suite-registration.mjs | 560 | 2.8k | delete 1 line | Shrink KNOWN_UNWIRED after wiring the existing suite. |

Baseline: about 45k tokens. Optimized: about 30k tokens with one builder and
one frozen-diff reviewer.

## §7 Safety and Security

| Concern | Severity | Failure scenario | Mitigation | Test |
|---|---|---|---|---|
| Gate bypass | High | A malformed genuine lifecycle event is mislabeled as a non-event. | Closed allowlist of three existing BP-1 producer types. Missing and unknown values still parse and fail. The real em-store negative asserts genuine lifecycle episodes have no type scalar. | real em-store untyped and unknown negative tests |
| Sentinel collision | Medium | JSON null is confused with the non-event branch. | Return a discriminated object with kind event or non-event, never null as a sentinel. | valid chain and malformed payload suites |
| Tag forgery | Medium | A descriptive BP-1 tag bypasses validation. | Classification reads only the typed frontmatter scalar. | real producer test has tag but relies on type |
| Broad category suppression | High | All workflow.lifecycle evidence is skipped. | Existing record_type guard stays narrow; the new type allowlist is explicit. | T14 and unknown-type negative |

No path-authority predicate changes. No new file writes, child processes, or
network flow are added to production code.

## §8 Design

### 8.1 Key types

~~~js
// extractPayload(filePath)
// returns { kind: 'event', payload: unknown }
//      or { kind: 'non-event', payload: null }
// throws on missing or malformed JSON for every entry outside the closed
// BP-1 non-event type allowlist.
~~~

### 8.2 Invariants

- Category alone does not establish that an episode is an RFC-002 event.
- record_type clerk-run and promote-run are excluded before file reads.
- Frontmatter type evidence, failure, and state-transition are BP-1
  operational records and are excluded before body parsing.
- Genuine lifecycle episodes written by em-store carry no type frontmatter and
  therefore always follow the strict fence path.
- Missing or unknown type is not trusted and follows the existing strict
  fence and JSON parsing path.
- Tags and summaries never affect the branch.
- Cross-platform: Node path, fs, regex, and execFileSync only; no shell-only
  flags or GNU assumptions.
- Atomicity: production writes are unchanged.

### 8.3 Flow

Index row -> active workflow.lifecycle and record_type filter -> episode file
exists -> read file -> inspect exact frontmatter type -> known BP-1 non-event
returns non-event -> otherwise require and parse JSON fence -> task and pattern
filter -> schema and chain validation.

## §9 Existing Hook Points

| File | Current location | Current behavior | Change |
|---|---|---|---|
| scripts/em-workflow-validate.mjs | RUN_RECORD_TYPES near line 64 | Excludes clerk-run and promote-run index rows. | Add separate BP-1 type allowlist. |
| scripts/em-workflow-validate.mjs | extractPayload near line 136 | Reads file and immediately requires a JSON fence. | Inspect frontmatter type first and return a discriminated result. |
| scripts/em-workflow-validate.mjs | loop near line 891 | Treats every extraction result as a payload. | Continue on kind non-event. |
| scripts/bp1-orchestrator.mjs | writeUnsignedDeadlineTick near line 2778 | Writes type: evidence and plain text. | Read-only reference, no edit. |
| tests.yml substrate job | near promote-apply step | Runs substrate suites. | Add the existing validator suite and the new issue 558 suite. |
| tests/test-ci-suite-registration.mjs | KNOWN_UNWIRED near line 154 | Baselines test-workflow-validate.mjs as unwired. | Delete that one stale entry after direct workflow registration. |

## §10 Slice Ladder

One slice:

| Slice | Objective | Files | Tests | Hard stops |
|---|---|---|---|---|
| 558-S1 | Typed non-event classification | validator, new test, workflow, CI baseline lint | new suite, existing validator and promote suites, CI lint | no producer, category, episode, deploy, or merge change |

## §11 Cut Order

If scope grows, cut broader historical-producer enumeration first, then
documentation expansion. Do not cut the real-producer test, the untyped
negative control, the unknown-type negative control, or CI registration.

## §12 Contracts

### frontmatterScalar(text, key)

The implementation is mechanical: split with /\r?\n/, require line zero to be
exactly ---, locate the next line exactly equal to ---, and inspect only the
lines between those delimiters. Match a field only when the line starts with
the exact prefix `${key}:`, then return the remainder after that prefix with
trim() applied. This does not match record_type:, subtype:, or a type: string in
the body. Quoted values retain their quote characters and therefore do not
match the plain producer allowlist; they follow the strict path.

| State | Condition | Output | Side effects |
|---|---|---|---|
| no frontmatter | delimiters absent | null | none |
| key absent | frontmatter exists without exact key | null | none |
| exact plain scalar | exact key prefix inside the first block | trimmed scalar | none |
| quoted or other scalar | exact key prefix with non-plain value | trimmed value, including quote characters | none |

### extractPayload(filePath)

| State | Condition | Output | Side effects |
|---|---|---|---|
| indexed run record | filtered before call | no call | none |
| known BP-1 type | evidence, failure, or state-transition | kind non-event | one file read |
| missing or unknown type with valid fence | JSON parses | kind event plus payload | one file read |
| missing or unknown type without fence | no JSON fence | throws existing error | one file read |
| missing or unknown type with malformed JSON | JSON parse fails | throws existing parse error | one file read |

Fail direction: closed for every unrecognized shape.

## §13 Edge Cases

| ID | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | empty store | missing required events, no parse errors | existing T2 |
| EC2 | valid chain plus real unfenced typed tick | valid true | real producer test |
| EC3 | known type with plain text | skipped | typed sibling test |
| EC4 | no type with plain text | fenced-block error | untyped negative |
| EC5 | unknown type with plain text | fenced-block error | unknown negative |
| EC6 | fenced JSON null | existing validator path, never non-event sentinel | existing validator suite |
| EC7 | orphaned index row | warning unchanged | existing validator suite |

## §14 Test Catalog

Group 1, real producer:

- realDeadlineTickDoesNotPoisonValidChain: run check-deadlines with isolated
  HOME, verify type: evidence and no fence, rebuild local index, author a valid
  chain through em-store, then require validator exit 0, valid true, and no
  warning naming the tick. Before the fix, the out-of-chain migration downgrades
  the tick parse error into a warning, so this named test is red.

Group 2, same-class typed records:

- knownBp1TypesAreNonEvents: evidence, failure, and state-transition plain-text
  records do not poison a valid chain.

Group 3, fail-closed controls:

- untypedUnfencedRecordRemainsFatal: write the record through real em-store,
  assert its frontmatter has no type: field, and require the fenced-block error.
- unknownTypedUnfencedRecordRemainsFatal.

Runner:

    node tests/test-workflow-non-event-classification.mjs

Negative mutation:

    node tests/test-workflow-non-event-classification.mjs --break-bp1-classification

The mutation replaces the real producer type with unknown. Expected: non-zero
test exit.

## §15 Verification Ledger

| Claim | Command | Required artifact |
|---|---|---|
| Red reproduced | current-main validator against isolated unfenced store | exit 1 and named fenced-block error |
| Real-producer red captured | new suite before the validator edit | suite exits non-zero naming realDeadlineTickDoesNotPoisonValidChain because the tick leaks into warnings |
| New guard is load-bearing | node tests/test-workflow-non-event-classification.mjs --break-bp1-classification | non-zero with real producer test failure |
| Target behavior passes | node tests/test-workflow-non-event-classification.mjs | 4 passed, 0 failed |
| Existing lifecycle behavior passes | node tests/test-workflow-validate.mjs | zero failed |
| Existing run-record behavior passes | node tests/test-promote-apply.mjs | zero failed |
| CI registration closes | node tests/test-ci-suite-registration.mjs | pass |
| P12 remains intact | node tests/test-p12-invariant-suite.mjs | pass |
| Diff is scoped | git diff --check and git diff --stat | only four product files plus this plan |
| GitHub CI passes | gh pr checks after draft PR | every required check pass |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Known type hides malformed RFC-002 event | High | Low | RFC-002 writers do not set these BP-1 types; tests keep missing and unknown fatal. |
| Frontmatter parsing drift | Medium | Low | Split on CRLF or LF, require exact delimiters, bound the scan to the first block, and match the exact key prefix. Quoted values remain strict. |
| Validator suites are not executed | High | Low | Direct workflow lines for both suites plus registration lint. |
| Main-tree user changes are touched | High | Low | Dedicated clean worktree and slice-only staging. |

## §17 Open Decisions

None. Broader workflow.lifecycle vocabulary cleanup is outside this fix and
remains unnecessary if the typed producer boundary stays stable.

## §18 Done Criteria

- [x] Red reproduction captured.
- [x] Plan review accepted.
- [x] Negative mutation fails.
- [x] New suite passes 4 of 4.
- [x] Existing validator and promote suites pass.
- [x] CI registration and P12 checks pass.
- [x] Frozen-diff reviewer accepts or every finding is dispositioned.
- [ ] Draft PR checks are green.
- [x] Deferred-finding sweep has an issue, comment, or violation for every item.

## §19 Review Consensus

The active workplan forbids reliance on the Codex second-opinion provider until
issue 538 is fixed. Plan and frozen-diff review use private Herdr Pi sessions
with neuralwatt GLM-5.2, bare --no-extensions, no shared Prompt Shield writes,
and no OpenRouter.

| Pass | Reviewer | Provider | Blockers | Verdict | Artifact |
|---|---|---|---:|---|---|
| 1 | plan-review | neuralwatt GLM-5.2 | 2 | HOLD-2 | Herdr session drv-em-558-plan-review-0658; 76k input, 23k output, $0.337 |
| 2 | plan-review2 | neuralwatt GLM-5.2 | 1 | HOLD-1 | Herdr session drv-em-558-plan-review2-0712; 30k input, 27k output, $0.212 |
| 3 | frozen-diff-review | neuralwatt GLM-5.2 | 1 | HOLD-1 | Herdr session drv-em-558-diff-review-0810; 63k input, 38k output, $0.431 |
| 4 | final-verify | MiniMax-M3 | 0 | ACCEPT | Herdr session drv-em-558-verify-0920; 55k input, 4.8k output, $0.040 |

Round 1 dispositions:

- F3 parser ambiguity: ACCEPT-WITH-MOD. The plan now specifies an exact,
  first-block-only, CRLF-tolerant line algorithm and preserves quoted values as
  strict rather than adding unneeded decoding branches.
- F5 bypass invariant: ACCEPT-WITH-MOD. The existing untyped negative now uses
  real em-store and asserts that genuine lifecycle frontmatter has no type key.
- F6 fenced JSON null: DEFER. This is a pre-existing fail-closed crash outside
  issue 558 and must be filed before the cycle is declared done.
- F7 quoted and CRLF parsing: ACCEPT-WITH-MOD. CRLF is explicit; quoted forms
  remain unmatched and strict, which removes defensive untested branches.
- F9 reproduction rebuild note: ACCEPT-WITH-MOD. Section 2 now distinguishes
  the first strict-path reproduction from the real-producer red and requires
  rebuild after check-deadlines.
- F10 CI wiring: ACCEPT-WITH-MOD. The workflow step now registers both the
  historical validator suite and the new issue 558 suite.
- Optional skip warning: REJECT. Silent exclusion preserves the existing JSON
  output shape and avoids adding noise for expected BP-1 records.

Round 2 disposition:

- F2-1 stale CI baseline: ACCEPT-WITH-MOD. Wiring the historical validator
  suite makes its KNOWN_UNWIRED entry invalid under the shrink-only ratchet.
  Step 4 now deletes that exact entry, and the token budget, slice map, diff
  boundary, hook-point map, and blast-radius statement all name the fourth
  product file.

Round 2 concluded that this single mechanical amendment was the only blocker
and that the plan is ACCEPT once amended. The exact required deletion and every
named boundary reconciliation are now present. Under the two-round review cap,
the plan is accepted for build without a third review round.

Frozen-diff dispositions:

- F16 inaccurate test-helper comment: ACCEPT. The fold builder corrected the
  comment and the nearby mutation narrative without changing executable code.
- F6 fenced JSON null crash: DEFER. The reviewer confirmed this is pre-existing,
  fail-closed, and outside issue 558. It is tracked as GitHub issue 560.
- Optional explicit tag-forgery test: REJECT. Existing missing-type,
  unknown-type, quoted-value, and CRLF cases cover the classification boundary
  required by issue 558 without enlarging the slice.

The final artifact SHA-256 is
`1d20960445a0b5c62198dadca62ffcd6b6b4b1d7c6a7fe11f1d9374cee0c1910`.
Independent verification confirmed that the applied diff was byte-identical to
that artifact, the normal suite passed 4 of 4, the mutation failed at the
no-warning oracle, the validator suite passed 110 of 110, promote-apply passed,
CI registration passed 16 of 16, P12 passed 14 of 14, and `git diff --check`
was clean. The verifier returned ACCEPT with no blocking findings.

Every finding is classified ACCEPT, ACCEPT-WITH-MOD, REJECT, DEFER, or
NEEDS-EVIDENCE before build handoff.

## §20 Lessons Encoded

- Reproduce before design.
- Tags are never load-bearing.
- A parser guard must remain red for unknown shapes.
- A known producer record and an unknown negative differ in the exact typed
  discriminator under test.
- New suites are wired into CI in the same slice.
- Orchestrator writes plans and commits; builders write product source.

# Appendix A: Mechanical Execution Spec

## A.0 Toolchain

| Key | Value |
|---|---|
| Runtime | Node.js 20+, zero-dependency ESM |
| Runtime check | node --version, v20 or higher |
| Test runner | node tests/test-workflow-non-event-classification.mjs |
| Negative control | argv flag --break-bp1-classification |
| Search | rg |
| Audit | git diff --check; tests; GitHub CI |

## A.1 Forbidden Phrase Lint

Run the template lint over this plan. Matches outside A.7 are dispositioned by
reading. No forbidden phrase may occur inside an A.7 action row.

## A.2 Executor Contract

1. Execute steps in numeric order.
2. Edit one named file per step.
3. Stop when an exact anchor is absent.
4. Run each verification as one command.
5. Do not commit, push, write memory, alter the plan, or touch another file.
6. Do not use shell compound commands.

## A.3 Stop Protocol

Emit the template STOP block with the missing anchor, actual surrounding text,
and one question, then halt.

## A.4 Preflight

| Check | Command | Expected |
|---|---|---|
| branch | git branch --show-current | fix/issue-558 |
| clean product tree | git status --short | only orchestrator-owned plan may be present |
| runtime | node --version | v20 or higher |
| baseline validator | node tests/test-workflow-validate.mjs | zero failed |
| baseline run records | node tests/test-promote-apply.mjs | zero failed |

## A.5 Exact Constants

~~~js
const NON_WORKFLOW_EVENT_TYPES = new Set(['evidence', 'failure', 'state-transition'])
~~~

## A.6 Anchors

- Validator constant anchor:
  const RUN_RECORD_TYPES = new Set(['clerk-run', 'promote-run'])
- Validator function anchor:
  function extractPayload(filePath) {
- Validator loop anchor:
  payload = extractPayload(filePath)
- Workflow anchor:
  Run promote-apply suite (RFC-012 P2 S4)

## A.7 Steps

### 558-S1

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 1 | tests/test-workflow-non-event-classification.mjs | CREATE | Create the isolated integration suite defined in §14. It invokes the real bp1-orchestrator, em-rebuild-index, em-store, and em-workflow-validate scripts. It runs four named cases and implements --break-bp1-classification by replacing only type: evidence with type: unknown in the real tick file before rebuild. The real-producer oracle requires no warning naming the tick. The untyped negative is written through em-store and asserts that the file contains no exact type: frontmatter field. Assertions inspect subprocess exit, parsed JSON, tick bytes, warning and error text. | node tests/test-workflow-non-event-classification.mjs on the unmodified validator produces a non-zero suite exit and names realDeadlineTickDoesNotPoisonValidChain because the tick leaks into warnings. |
| 2 | scripts/em-workflow-validate.mjs | EDIT | After the RUN_RECORD_TYPES anchor add the exact NON_WORKFLOW_EVENT_TYPES constant from A.5. Before extractPayload add frontmatterScalar(text, key) using the exact §12 algorithm: split on CRLF or LF, require exact first and closing delimiters, inspect only the first block, match only the exact `${key}:` prefix, and return the trimmed remainder without quote decoding. Replace extractPayload so it returns { kind: 'non-event', payload: null } for the closed allowlist and { kind: 'event', payload: JSON.parse(m[1]) } otherwise. Preserve the existing missing-fence error text. In the loop rename payload extraction to extracted, continue on non-event, then bind const payload = extracted.payload. | node tests/test-workflow-non-event-classification.mjs --break-bp1-classification exits non-zero; a separate node tests/test-workflow-non-event-classification.mjs run reports 4 passed and 0 failed. |
| 3 | .github/workflows/tests.yml | EDIT | Immediately after the promote-apply step add Run workflow validator suite with run value node tests/test-workflow-validate.mjs, followed by Run workflow non-event classification suite (issue 558) with run value node tests/test-workflow-non-event-classification.mjs. | rg finds each exact run value once in .github/workflows/tests.yml. |
| 4 | tests/test-ci-suite-registration.mjs | EDIT | Delete only the exact 'test-workflow-validate.mjs', entry from the shrink-only KNOWN_UNWIRED array. Do not add the new suite to that array. | node tests/test-ci-suite-registration.mjs passes and reports no wired-but-baselined or unwired suite. |

## A.8 Definition of Done

Run each command separately:

    node tests/test-workflow-non-event-classification.mjs --break-bp1-classification
    node tests/test-workflow-non-event-classification.mjs
    node tests/test-workflow-validate.mjs
    node tests/test-promote-apply.mjs
    node tests/test-ci-suite-registration.mjs
    node tests/test-p12-invariant-suite.mjs
    git diff --check

The first command must fail. Every later command must pass.

## A.9 Blast Radius

- Red then green uses the same real tick with only its typed discriminator
  changed.
- The existing T14 missing-fence case remains unchanged.
- RUN_RECORD_TYPES remains unchanged and test-promote-apply stays green.
- The existing validator suite and new test are directly wired; the new test is
  not added to KNOWN_UNWIRED.
- The existing validator suite is removed from KNOWN_UNWIRED after direct
  registration.
- Product edits are limited to the validator, one new test, one workflow
  registration, and the one-line shrink-only baseline deletion.
