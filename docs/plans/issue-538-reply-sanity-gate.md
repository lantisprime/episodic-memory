# ISSUE-538 Reply-sanity gate for the second-opinion harness

## §1 Status

Current stage: **approved** — round-1 second-opinion review returned ACCEPT with
0 blockers (§19); its findings are folded. This document is FROZEN as the seat
contract: any mid-build scope change requires editing this file and re-briefing
the seat explicitly.

| Field | Value |
|---|---|
| RFC | `n/a` (bug fix against the shipped harness) |
| Parent requirements | `n/a` — requirements are anchored to issue #538 bullets |
| Workplan episode | `20260723-135404-workplan-v243-pr-572-merged-and-deployed-ea4a` |
| Target branch | `fix/538-reply-sanity-gate` |
| Executor altitude (§0.1) | `low` — pi/MiniMax-M3 builder seat; Appendix A is the build path |

## §2 Episode Search Summary

```bash
node scripts/em-search.mjs --tag session-handoff --scope local --limit 1 --full --no-track --no-score
```

Key active memories:

- `20260723-135445-handoff-71-537-shipped-and-deployed-via--960e`: #538 is the queue head,
  scoped and scouted, not started. Carries the scout anchor list re-verified in §9 below.
  Constrains this plan: **no codex as second-opinion provider**, no built-in subagents,
  no OpenRouter; reviewer seat is pi/GLM-5.2 on neuralwatt.
- `20260723-000645-multi-agent-approach-playbook-v5-adds-fr-f806`: this document IS the
  frozen seat contract. The builder brief points at it; the reviewer grounds verdicts in it.

Verification of memory claims: every file:line in §9 was re-read from disk during planning,
not taken from the handoff.

## §3 Objective

The second-opinion harness persists whatever a provider writes to stdout as a review reply
whenever the provider exits 0, with no inspection of the reply body. Issue #538 reports the
concrete consequence: a codex seat answered its own SessionStart bootstrap prompt, exited 0,
and the harness persisted `Load session_handoff.md from 2026-07-14 16:32? (y/n)` as a
`status: ok` review reply.

After this change, a provider reply that is empty, whitespace-only, or short enough to be a
prompt fragment while carrying no `json:second-opinion-summary` block is rejected before any
storage write, with the raw stdout preserved to a forensics file, provable by
`node tests/test-so-reply-sanity-e2e.mjs` observing `code: "provider-reply-invalid"`, zero
reply records on disk, and a non-empty forensics file.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | `checkReplySanity` returns `{ok:false, reason:'reply-empty'}` for `''`, `'   '`, `'\n\t '` | #538 bullet 4b | `testEmptyRejected` | MUST | whitespace-only is the empty class |
| REQ-2 | `checkReplySanity` returns `{ok:false, reason:'reply-too-short-no-summary'}` for the verbatim bootstrap string `Load session_handoff.md from 2026-07-14 16:32? (y/n)` | #538 bullet 1 | `testBootstrapRejected` | MUST | the exact reported failure |
| REQ-3 | `checkReplySanity` returns `{ok:true}` for ANY body containing a `json:second-opinion-summary` fence, regardless of length | #538 bullet 4b | `testShortWithFenceAccepted` | MUST | false-positive control: the fence is the compliance signal, so length never rejects a compliant reply |
| REQ-4 | `checkReplySanity` returns `{ok:true}` for a fence-less body at or above the floor | #538 bullet 4b | `testLongNoFenceAccepted` | MUST | no regression for substantive free-form replies |
| REQ-5 | `checkReplySanity` returns `{ok:false, reason:'reply-not-string'}` for `null`, `undefined`, `42`, `{}` | defensive | `testNonStringRejected` | MUST | gate is called on provider-controlled data |
| REQ-6 | The floor is `200` chars by default and is overridable per call via `{minChars}` | #538 bullet 4b | `testFloorOverridden` | MUST | harness exposes it as `--min-reply-chars` |
| REQ-7 | Single dispatch (`--dispatch`, no `--consensus`) with a bootstrap-shaped reply exits non-zero with `status:"error"`, `code:"provider-reply-invalid"` | #538 bullet 3 | `testSingleDispatchRejects` | MUST | single-dispatch path never ran `parseVerdict`, so it was fully unguarded |
| REQ-8 | On rejection, **zero** reply records exist under `<project>/.review-store/replies/` | #538 bullet 4b | `testNoReplyPersisted` | MUST | "not persisted as ok" is the issue's literal ask |
| REQ-9 | On rejection, `<project>/.review-store/forensics/<requestId>.round<N>.invalid-reply.txt` exists and contains the raw stdout verbatim | precedent: timeout path | `testForensicsWritten` | MUST | mirrors `provider-timeout` forensics; evidence is not destroyed |
| REQ-10 | `--consensus` with a bootstrap-shaped reply exits non-zero and reports **no** completed round | #538 bullet 3 | `testConsensusRoundNotCounted` | MUST | the silent-garbage-counts-as-a-round failure |
| REQ-11 | A normal stub dispatch still succeeds unchanged (`status:"ok"`, reply persisted) | regression | `testHappyPathUnchanged` | MUST | positive control |
| REQ-12 | `--min-reply-chars` with a non-integer or negative value exits `invalid-min-reply-chars` before any storage write | EC6 | `testInvalidFlagRejected` | MUST | validate-then-write ordering |
| REQ-13 | Both new suites are step-wired in `.github/workflows/tests.yml` and `test-ci-suite-registration.mjs` passes | repo lint | `manual: node tests/test-ci-suite-registration.mjs` | MUST | KNOWN_UNWIRED is shrink-only, so a new suite must be wired |
| REQ-14 | A body the gate accepts as fenced also parses via `parseVerdict`, so the duplicated `FENCE_RE` cannot drift silently | review F-7 | `testFenceRegexInSyncWithConsensus` | MUST | added after round-1 review; see §13 EC10 |

## §5 Non-Goals

- Changing the codex adapter to suppress or pre-answer the SessionStart hook (issue #538
  direction (a)). Direction (b) closes the class for every provider; (a) closes one spelling.
- Requiring the `json:second-opinion-summary` fence on every reply. That would reject
  substantive free-form replies from non-compliant providers and is a behavior change beyond
  the reported bug.
- Wiring the other nine `test-second-opinion-*.mjs` suites into CI (issue #541 territory).
- Any change to `parseVerdict` or the consensus stop-condition table.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `scripts/second-opinion.mjs` | 570 | ~2.9k | ~0.3k | 3 anchored EDITs only |
| `scripts/second-opinion/providers/stub.mjs` | 119 | ~0.6k | ~0.1k | 1 anchored EDIT |
| `scripts/second-opinion/lib/reply-sanity.mjs` | 0 (new) | — | ~0.4k | CREATE |
| `tests/test-second-opinion-reply-sanity.mjs` | 0 (new) | — | ~0.9k | CREATE |
| `tests/test-so-reply-sanity-e2e.mjs` | 0 (new) | — | ~1.3k | CREATE |
| `.github/workflows/tests.yml` | 466 | ~0.2k (anchored region only) | ~0.1k | 1 anchored EDIT |

**Baseline (single session):** ~7k tokens of file traffic.
**Optimized:** unchanged — the slice is small enough for one builder session.

## §7 Safety / Security

This is a validator on provider-controlled input placed on a trust boundary (child-process
stdout entering persistent storage). Negative controls are mandatory per §A.9.

| Concern | Severity | Attack/abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| Fail-open gate | High | Gate added but predicate always returns `{ok:true}`; garbage still persists and reads as reviewed | Predicate is pure and unit-tested; the suite runs a break-mode that swaps in an always-ok predicate and MUST go red | `testBootstrapRejected`, `negative: node tests/test-second-opinion-reply-sanity.mjs --break-sanity` → non-zero |
| False positive on a legitimate terse review | Med | A compliant reviewer replies briefly with a valid fence; gate rejects it and blocks real review work | Fence presence short-circuits to `ok` **before** the length test | `testShortWithFenceAccepted` |
| Evidence destroyed on rejection | Med | Operator cannot diagnose why the seat misbehaved because the body was discarded | Raw stdout written to `.review-store/forensics/` before `emitErr`, mirroring the timeout path | `testForensicsWritten` |
| Write-before-validate on the new flag | Med | `--min-reply-chars garbage` writes a request episode, then fails | Flag validated inside the EC6 pre-write validation block alongside `--timeout` | `testInvalidFlagRejected` |
| Path handling for the forensics file | Low | `requestId` is harness-generated, never provider-controlled; the write is wrapped in try/catch and degrades to `forensicsPath = null` | Reuse the exact existing timeout-path idiom, no new path logic | covered by `testForensicsWritten` |

**Path-authority predicates:** none introduced. The change adds no `realpath` / `lstat` /
isMain / repo-class predicate, so the 8-axis symlink matrix does not apply. The one new
filesystem write reuses `path.join(projectRoot, '.review-store', 'forensics')` verbatim from
`scripts/second-opinion.mjs:388`, whose path authority is unchanged by this slice.

**Canonical planner note:** `negative-scenario-planner` is a built-in subagent, and built-in
subagents are disallowed this session (operator, 2026-07-23). The adversarial matrix is
therefore delegated to the pi/GLM-5.2 reviewer seat under §19, which reviews this plan before
any build step runs.

## §8 Design

### 8.1 Key types

```js
/**
 * @typedef {Object} ReplySanityResult
 * @property {boolean} ok — true when the reply may be persisted
 * @property {string} [reason] — 'reply-not-string' | 'reply-empty' | 'reply-too-short-no-summary'
 * @property {string} [detail] — human-readable explanation, embedded in the error envelope
 */
```

### 8.2 Key invariants

- The gate runs inside `runDispatch`, after the `!r.ok` check and before `return r`. That is
  the single choke point both the consensus path (`:413`) and the single-dispatch path
  (`:502`) pass through, so one edit closes both.
- Rejection is fail-closed: `emitErr` writes an error envelope and exits non-zero. No reply
  record is created, so no consensus round can be counted.
- Fence presence is checked before length, so a compliant reply is never rejected for brevity.
- **Cross-platform:** no new shell invocation, no GNU-only flag; paths via `path.join`; the
  negative control is an argv flag (`--break-sanity`), never an env prefix.
- **Atomicity:** unchanged. The forensics write is a plain `writeFileSync` inside try/catch,
  identical to the existing timeout-forensics write; it is diagnostic, not shared state.

### 8.3 Resolution / flow

```text
provider.dispatch() -> r
  r.timedOut          -> forensics + emitErr('provider-timeout')          [existing]
  !r.ok               -> emitErr('provider-dispatch-nonzero')             [existing]
  !sane(r.stdout)     -> forensics + emitErr('provider-reply-invalid')    [NEW]
  otherwise           -> return r -> writeReplyRound(...) -> persisted
```

## §9 Existing Hook Points

Every line number below was re-read from disk on 2026-07-24 at `main` = `00ad5e4`.

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `scripts/second-opinion.mjs` | 37-38 | imports `parseVerdict, applyStopCondition, summarizeFindings` from `lib/consensus.mjs` | add one import line after it |
| `scripts/second-opinion.mjs` | 52 | `--help` usage string | append `[--min-reply-chars <n>]` |
| `scripts/second-opinion.mjs` | 219-223 | EC6 pre-write validation of `--timeout` | add `--min-reply-chars` validation after it |
| `scripts/second-opinion.mjs` | 398-403 | `if (!r.ok) { emitErr(...) }` then `return r` | insert the sanity gate between them |
| `scripts/second-opinion.mjs` | 384-397 | timeout forensics idiom | copied verbatim as the shape for the new forensics write |
| `scripts/second-opinion.mjs` | 415 | `writeReplyRound(...)` — consensus persistence | now unreachable for an insane reply |
| `scripts/second-opinion.mjs` | 502-503 | single-dispatch persistence, never parsed | now guarded |
| `scripts/second-opinion/providers/stub.mjs` | 67 | `const idMatch = prompt.match(...)` | insert `SO_STUB_RAW_BODY` short-circuit before it |
| `.github/workflows/tests.yml` | 188-189 | second-opinion install E2E step | append two steps after it |

## §10 Slice Ladder

One PR, four ordered slices inside it.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `538-S1` | Pure predicate + unit suite | `scripts/second-opinion/lib/reply-sanity.mjs`, `tests/test-second-opinion-reply-sanity.mjs` | `checkReplySanity` | REQ-1..REQ-6 | do NOT touch `second-opinion.mjs` |
| `538-S2` | Wire the gate into the harness | `scripts/second-opinion.mjs` | import, flag, gate + forensics | REQ-7, REQ-9, REQ-12 | do NOT change `parseVerdict` or the consensus table |
| `538-S3` | Stub raw-body knob | `scripts/second-opinion/providers/stub.mjs` | `SO_STUB_RAW_BODY` | enables REQ-7..REQ-11 | do NOT change the default template path |
| `538-S4` | E2E suite + CI wiring | `tests/test-so-reply-sanity-e2e.mjs`, `.github/workflows/tests.yml` | E2E coverage, both suites wired | REQ-7..REQ-11, REQ-13 | do NOT add anything to `KNOWN_UNWIRED` |

### 10.1 Dependency graph

```text
S1 ── S2 ── S4
       S3 ──┘
```

Hard deps: S2 needs S1's module; S4 needs S2 and S3.

## §11 Cut Order

1. `--min-reply-chars` flag (hardcode the 200 constant instead).
2. The consensus-path E2E case (REQ-10), keeping the single-dispatch case.

Do **not** cut:

- The forensics write (REQ-9) — without it a rejection destroys the evidence.
- The false-positive control (REQ-3) — without it the gate can silently over-reject.
- The `--break-sanity` negative control — a guard never observed failing guards nothing.

## §12 Contracts

### `checkReplySanity(body, opts) → ReplySanityResult`

**Input contract:** `body` is provider-controlled and may be any type. `opts` is optional;
`opts.minChars` is a non-negative integer, default `DEFAULT_MIN_REPLY_CHARS` (200).
**Output contract:** always an object. `{ok:true}` exactly, or
`{ok:false, reason, detail}` with both strings non-empty. Never throws, never returns null.

**State table (exhaustive):**

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. non-string | `typeof body !== 'string'` | `{ok:false, reason:'reply-not-string', detail:'typeof body is <t>'}` | none |
| B. empty | string, `body.trim().length === 0` | `{ok:false, reason:'reply-empty', detail:'reply body is empty or whitespace-only'}` | none |
| C. fenced | non-empty, `FENCE_RE.test(body)` true | `{ok:true}` | none |
| D. short unfenced | non-empty, no fence, `body.trim().length < minChars` | `{ok:false, reason:'reply-too-short-no-summary', detail:'reply is <n> chars with no fenced json:second-opinion-summary block (floor <minChars>)'}` | none |
| E. long unfenced | non-empty, no fence, `body.trim().length >= minChars` | `{ok:true}` | none |

Order of evaluation is A → B → C → D → E. C strictly precedes D: that ordering is REQ-3.

**Error codes (harness envelope):**

| Code | Field | Trigger | Fail mode |
|---|---|---|---|
| `provider-reply-invalid` | `code` | `checkReplySanity(...).ok === false` in `runDispatch` | **closed** — exit non-zero, nothing persisted |
| `invalid-min-reply-chars` | `code` | `--min-reply-chars` not a non-negative integer | **closed** — exit before any storage write |

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | empty / whitespace-only stdout | reject, fail-closed | `testEmptyRejected` |
| EC2 | non-string stdout (`null`, `42`) | reject, no throw | `testNonStringRejected` |
| EC3 | short body that DOES carry the fence | accept (fence wins over length) | `testShortWithFenceAccepted` |
| EC4 | rejection mid-consensus | no reply record, no counted round, non-zero exit | `testConsensusRoundNotCounted` |
| EC5 | forensics directory does not exist yet | created with `recursive: true`; failure degrades to `forensics: null`, never crashes | `testForensicsWritten` |
| EC6 | `--min-reply-chars abc` | validated before any storage write; nothing on disk | `testInvalidFlagRejected` |
| EC7 | `--min-reply-chars 0` | valid; disables the length arm, empty/non-string arms still fire | `testFloorOverridden` |
| EC8 | a legitimate terse **unfenced** reply (`Looks good to me, ship it.`) | rejected by design — this is the accepted false-positive class of §5; the operator's escape hatch is `--min-reply-chars 0`, which disables only the length arm | `testFloorOverridden` (proves the escape hatch works) |
| EC9 | a rejected reply after the request record was already written | the **request** record stays on disk; only the reply is withheld. Identical to the pre-existing `provider-timeout` path. REQ-8 is about reply records, not about leaving zero artifacts | `testNoReplyPersisted` |
| EC10 | `FENCE_RE` in `reply-sanity.mjs` drifts from `consensus.mjs:36` | a body the gate accepts as fenced must still parse as a verdict; drift is caught by an explicit cross-module assertion | `testFenceRegexInSyncWithConsensus` |

## §14 Test Case Catalog

```text
Group 1: predicate unit (tests/test-second-opinion-reply-sanity.mjs) (8 tests)
  testEmptyRejected           — '', '   ', '\n\t ' → ok:false, reason 'reply-empty'
  testNonStringRejected       — null, undefined, 42, {} → ok:false, reason 'reply-not-string'
  testBootstrapRejected       — the verbatim #538 bootstrap string → 'reply-too-short-no-summary'
  testShortWithFenceAccepted  — 'ok\n```json:second-opinion-summary\n{"final_verdict":"ACCEPT"}\n```' → ok:true
  testLongNoFenceAccepted     — 300 chars of prose, no fence → ok:true
  testFloorOverridden         — bootstrap string with {minChars:0} → ok:true; 'x' with {minChars:5000} → ok:false
  testDetailMentionsFloor     — rejection detail contains the observed char count and the floor
  testFenceRegexInSyncWithConsensus — a body the gate calls fenced also parses via parseVerdict

Group 2: harness E2E (tests/test-so-reply-sanity-e2e.mjs) (6 tests)
  testSingleDispatchRejects     — --dispatch + SO_STUB_RAW_BODY=<bootstrap> → status error, code provider-reply-invalid
  testNoReplyPersisted          — same run: .review-store/replies contains 0 entries
  testForensicsWritten          — same run: forensics file exists and equals the raw body
  testConsensusRoundNotCounted  — --consensus + raw body → status error, parsed.rounds is undefined or length 0
  testHappyPathUnchanged        — plain stub --dispatch → status ok, reply.bodyPath exists
  testInvalidFlagRejected       — --min-reply-chars abc → code invalid-min-reply-chars, no .review-store written
```

Total: 14 tests. Runners:
`node tests/test-second-opinion-reply-sanity.mjs`, `node tests/test-so-reply-sanity-e2e.mjs`.

## §15 Verification Ledger (verify by artifact)

| Claim | Command (the strong-layer one) | Observed artifact |
|---|---|---|
| Predicate suite passes | `node tests/test-second-opinion-reply-sanity.mjs` | `<fill at build time>` |
| Predicate guard is falsifiable | `node tests/test-second-opinion-reply-sanity.mjs --break-sanity` | `<must be non-zero exit>` |
| E2E suite passes | `node tests/test-so-reply-sanity-e2e.mjs` | `<fill>` |
| No regression in consensus E2E | `node tests/test-second-opinion-consensus-e2e.mjs` | `<fill>` |
| No regression in dispatch suite | `node tests/test-second-opinion-dispatch.mjs` | `<fill>` |
| No regression in storage suite | `node tests/test-second-opinion-storage.mjs` | `<fill>` |
| CI registration lint green | `node tests/test-ci-suite-registration.mjs` | `<fill>` |
| Deploys clean | `node tools/deploy-audit.mjs` | `<fill>` |
| Merged | `gh pr view <n> --json state,mergeCommit` | `<fill>` |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Floor of 200 rejects a real terse reply | Med | Low | fence short-circuit (REQ-3) + `--min-reply-chars` escape hatch |
| Gate placed in only one of the two dispatch paths | High | Low | placed inside `runDispatch`, the shared choke point; E2E covers both paths |
| Builder rewrites `runDispatch` wholesale | Med | Med | §A.7 EDIT step quotes the exact anchor and forbids whole-function rewrites |
| New suites fail CI for regex-strictness reasons | Low | Med | §A.7 step quotes the exact `run:` spelling the lint accepts |

## §17 Open Decisions

- **Requiring the fence on every reply** → deferred; rationale: it is a behavior change for
  every provider, beyond issue #538's scope. If the reviewer or a later incident shows
  fence-less long garbage in practice, file it then with the 5 fields. Not deferred as a
  known-failing case: no such instance is on record, so field 1 (run the scenario) cannot be
  discharged today, which is itself the reason this stays out of scope rather than becoming a
  filed DEFER.

## §18 Done Criteria

- [ ] All MUST requirements in §4 pass with output pasted into §15.
- [ ] `--break-sanity` observed non-zero (guard proven red).
- [ ] The four listed regression suites green.
- [ ] `node tests/test-ci-suite-registration.mjs` green with zero KNOWN_UNWIRED additions.
- [ ] Reviewer verdict ACCEPT recorded in §19 with the reply artifact path.
- [ ] Every deferred finding has an issue/comment/violation artifact (Rule 18 step 9).

## §19 Review Consensus (Rule 18)

Provider override for this session: **codex is disallowed** (operator, 2026-07-23). The
reviewer is a pi/GLM-5.2 seat on neuralwatt, driven under playbook v5, reviewing this
document before build and the frozen diff after build.

| Pass | Reviewer | Provider/Model | Blocker count | Verdict | Reply artifact |
|---|---|---|---|---|---|
| 1 (plan) | GLM seat | pi / GLM-5.2 (neuralwatt) | 0 | **ACCEPT** | `scratchpad/review-plan-r1.md` (441 lines, runtime-evidenced) |
| 2 (diff) | GLM seat | pi / GLM-5.2 (neuralwatt) | `<fill>` | `<fill>` | `<fill>` |

Round 1 was behavior-simulated, not read-only: the reviewer reproduced the #538
bug on a pristine copy (`status: ok` + persisted bootstrap body), then applied
this plan's verbatim patches to a temp copy and drove the real harness. Every
anchor in §A.7 matched exactly once against current `main`.

### 19.1 Resolved blockers

No P1 blockers. Round-1 findings and their dispositions:

| # | Finding | Sev | Verdict | Resolution + evidence |
|---|---|---|---|---|
| F-3 | terse legitimate **unfenced** replies (<200 chars) are rejected | P2 | ACCEPT-WITH-MOD | Deliberate per §5. Documented as §13 EC8 naming `--min-reply-chars 0` as the operator escape hatch. |
| F-5 | §A.7 step 2.2 verify was eyeball-only; a no-op passed it (proven: probe b returned `status:ok`, exit 0) | P2 | ACCEPT-WITH-MOD | Step 2.2 verify replaced with a single `node -e` assertion that exits 1 on a no-op. The reviewer's suggested `\| grep -c` form was **not** taken: §A.6b bans pipes in a verify. |
| F-7 | duplicated `FENCE_RE` can drift from `consensus.mjs:36` with no sync test | P3 | ACCEPT-WITH-MOD | Added `testFenceRegexInSyncWithConsensus` (§A.7.2) + §13 EC10. Import path corrected to `../scripts/...` (the reviewer's snippet used `../../`). |
| F-8 | a rejected reply leaves the request record on disk | P3 | ACCEPT | Documented as §13 EC9; identical to the pre-existing timeout path, so no code change. |
| F-2a | `reply-not-string` arm unreachable for codex (always returns a string) | P3 | REJECT (no change) | Correct defensive code per REQ-5; other providers are not bound by codex's implementation. |
| F-4 | long garbage and fence-with-bad-content still pass | P3 | DEFER | Out of scope per §5 and §17; §17 already records why it is not a filed DEFER (field 1 cannot be discharged — no such instance is on record). |
| F-6 | `SO_STUB_RAW_BODY` is test-only by convention, not enforced | P3 | REJECT (no change) | Pre-existing for every `SO_STUB_*` knob; this plan adds no new production exposure. |

## §20 Lessons Encoded

| Lesson | One-line rule | Enforced in |
|---|---|---|
| verify-the-strong-claim | E2E drives the real harness CLI, not the predicate alone | §14 Group 2, §15 |
| red-then-green | `--break-sanity` proves the guard can fail | §7, §A.7 step 1.3b |
| discriminating sentinel | assertions inspect the exact reason string, never "non-empty" | §14 |
| validate-then-write | the new flag is validated in the EC6 pre-write block | §13 EC6, §A.7 step 2.2 |
| one-file-per-step | every §A.7 step names exactly one file | §A.7 |
| bp1 step-9 5-field DEFER | §17 states why nothing is deferred rather than hand-waving | §17 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value for this plan |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero external deps |
| Runtime check | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-<feature>.mjs` |
| New-function phrasing | `export function fnName(args)` |
| Portable break-input override | argv flag `--break-sanity` (never an env prefix) |
| Search tool for verifies | `grep -c` / `grep -n` from the repo root |
| Repo-specific done-commands | `node tools/deploy-audit.mjs` |

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/issue-538-reply-sanity-gate.md
```

Acceptance: matches are permitted only outside §A.5 blocks and §A.7 step rows. Record the
match list beside the lint run.

## A.2 Executor contract (copy verbatim into the handoff)

1. Do the steps in numeric order. Do not skip, reorder, or batch.
2. Each step names exactly which file, the exact change, and how to verify it.
3. Make no design decisions. If a step is ambiguous, or the anchor text is not found
   verbatim, STOP and ask (§A.3). Do not guess or pick the closest match.
4. Run the verify command after each step. If it fails, fix only that step.
5. Edit exactly ONE file per step. Read-only references (look, never edit):
   `scripts/second-opinion/lib/consensus.mjs`, `tests/test-second-opinion-consensus-e2e.mjs`,
   `tests/test-ci-suite-registration.mjs`.
6. Run no command outside the per-step verify commands. Each verify is a SINGLE command —
   no `;`, `&&`, `||`, pipes, or subshells.
7. Do not commit. Do not push. Do not open a PR. Do not run `git stash`. Do not write
   episodes or touch the workplan. The orchestrator does all of that.
8. No aspirational output: every printed line describing a check is backed by an assertion.

## A.3 STOP-and-ask protocol

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous instruction | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <actual surrounding text, ±3 lines>
Question: <the single decision the plan owner must make>
```

## A.4 Pre-flight environment check (step 0)

| Check | Command | Expected |
|---|---|---|
| On the right branch | `git branch --show-current` | `fix/538-reply-sanity-gate` |
| Clean tree | `git status --porcelain` | empty |
| Baseline suite green | `node tests/test-second-opinion-consensus-e2e.mjs` | ends `7 passed, 0 failed` |
| Runtime available | `node --version` | `v20` or higher |

## A.5 Shared constants

```js
// scripts/second-opinion/lib/reply-sanity.mjs
export const DEFAULT_MIN_REPLY_CHARS = 200
const FENCE_RE = /```json:second-opinion-summary\s*\n([\s\S]*?)\n```/
```

The `FENCE_RE` value is byte-identical to `scripts/second-opinion/lib/consensus.mjs:36`.
It is duplicated rather than imported so the sanity module stays dependency-free; if the two
ever diverge, `consensus.mjs` remains authoritative for verdict parsing.

## A.6 Anchor format

- **ANCHOR** is a verbatim, unique substring already present in the file. Not unique or not
  present → STOP.
- **CREATE** — whole-file write of a new file. The only place a whole-file write is allowed.
- **EDIT** — anchored replace on existing content; change only that span; never rewrite a
  whole function; never reformat untouched lines.

## A.7 Per-slice step tables

**Files this PR may touch:** `scripts/second-opinion/lib/reply-sanity.mjs`,
`scripts/second-opinion.mjs`, `scripts/second-opinion/providers/stub.mjs`,
`tests/test-second-opinion-reply-sanity.mjs`, `tests/test-so-reply-sanity-e2e.mjs`,
`.github/workflows/tests.yml`. Nothing else.

### `538-S1` — pure predicate + unit suite (REQ-1..REQ-6)

| Step | File | Kind | Exact action | Verify (observed → expected) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4 | every row passes |
| 1.1 | `scripts/second-opinion/lib/reply-sanity.mjs` | **CREATE** | Full verbatim contents given in §A.7.1 below. | `node -e "import('./scripts/second-opinion/lib/reply-sanity.mjs').then(m=>{const r=m.checkReplySanity('Load session_handoff.md from 2026-07-14 16:32? (y/n)');if(r.reason!=='reply-too-short-no-summary')process.exit(1);console.log(r.reason)})"` → prints `reply-too-short-no-summary`, exits 0 |
| 1.2 | `tests/test-second-opinion-reply-sanity.mjs` | **CREATE** | Full verbatim contents given in §A.7.2 below. | `node tests/test-second-opinion-reply-sanity.mjs` → ends `8 passed, 0 failed` |
| 1.3b | — | — | Negative control: run the same suite in break mode. | `node tests/test-second-opinion-reply-sanity.mjs --break-sanity` → exits non-zero |

#### §A.7.1 verbatim contents of `scripts/second-opinion/lib/reply-sanity.mjs`

```js
/**
 * reply-sanity.mjs — Pre-persistence sanity gate for provider replies.
 *
 * Issue #538: a provider that exits 0 while emitting its own interactive
 * bootstrap prompt (e.g. "Load session_handoff.md from ...? (y/n)") had its
 * output persisted verbatim as a review reply with status ok. The harness
 * inspected only exit-status-shaped fields, never the body.
 *
 * This module is a pure predicate: no I/O, no throwing, no dependencies.
 * The harness calls it in runDispatch before any storage write.
 *
 * Ordering rule (REQ-3): a body carrying the fenced
 * json:second-opinion-summary block is ALWAYS sane, regardless of length —
 * the fence is the compliance signal, so a valid terse review is never
 * rejected for brevity.
 */

export const DEFAULT_MIN_REPLY_CHARS = 200

// Byte-identical to consensus.mjs FENCE_RE; duplicated to keep this module
// dependency-free. consensus.mjs stays authoritative for verdict parsing.
const FENCE_RE = /```json:second-opinion-summary\s*\n([\s\S]*?)\n```/

/**
 * @param {*} body — provider stdout, untrusted, any type
 * @param {{minChars?: number}} [opts]
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}}
 */
export function checkReplySanity(body, opts = {}) {
  const minChars = opts.minChars === undefined ? DEFAULT_MIN_REPLY_CHARS : opts.minChars

  if (typeof body !== 'string') {
    return {
      ok: false,
      reason: 'reply-not-string',
      detail: `typeof body is ${typeof body}`,
    }
  }

  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: 'reply-empty',
      detail: 'reply body is empty or whitespace-only',
    }
  }

  if (FENCE_RE.test(body)) {
    return { ok: true }
  }

  if (trimmed.length < minChars) {
    return {
      ok: false,
      reason: 'reply-too-short-no-summary',
      detail: `reply is ${trimmed.length} chars with no fenced json:second-opinion-summary block (floor ${minChars})`,
    }
  }

  return { ok: true }
}
```

#### §A.7.2 verbatim contents of `tests/test-second-opinion-reply-sanity.mjs`

```js
#!/usr/bin/env node
/**
 * test-second-opinion-reply-sanity.mjs — unit suite for the #538 reply-sanity
 * predicate.
 *
 * Coverage: REQ-1 (empty), REQ-2 (bootstrap string), REQ-3 (fence beats
 * length), REQ-4 (long unfenced accepted), REQ-5 (non-string), REQ-6 (floor
 * override), plus the rejection-detail contract.
 *
 * Negative control (§A.9 red-then-green): run with --break-sanity to swap in
 * an always-ok predicate. Every rejection assertion MUST then fail, so the
 * suite exits non-zero. A guard never observed failing guards nothing.
 */

import assert from 'node:assert'
import { checkReplySanity, DEFAULT_MIN_REPLY_CHARS } from '../scripts/second-opinion/lib/reply-sanity.mjs'
import { parseVerdict } from '../scripts/second-opinion/lib/consensus.mjs'

const BREAK = process.argv.includes('--break-sanity')
const check = BREAK ? () => ({ ok: true }) : checkReplySanity

// The verbatim body issue #538 observed persisted as a review reply.
const BOOTSTRAP = 'Load session_handoff.md from 2026-07-14 16:32? (y/n)'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

console.log('# test-second-opinion-reply-sanity')

test('testEmptyRejected: empty and whitespace-only bodies are rejected', () => {
  for (const body of ['', '   ', '\n\t ']) {
    const r = check(body)
    assert.strictEqual(r.ok, false, `expected rejection for ${JSON.stringify(body)}`)
    assert.strictEqual(r.reason, 'reply-empty', `expected reply-empty, got ${r.reason}`)
  }
})

test('testNonStringRejected: non-string bodies are rejected without throwing', () => {
  for (const body of [null, undefined, 42, {}]) {
    const r = check(body)
    assert.strictEqual(r.ok, false, `expected rejection for ${String(body)}`)
    assert.strictEqual(r.reason, 'reply-not-string', `expected reply-not-string, got ${r.reason}`)
  }
})

test('testBootstrapRejected: the #538 SessionStart bootstrap body is rejected', () => {
  const r = check(BOOTSTRAP)
  assert.strictEqual(r.ok, false, 'bootstrap prompt must not be persistable')
  assert.strictEqual(r.reason, 'reply-too-short-no-summary',
    `expected reply-too-short-no-summary, got ${r.reason}`)
})

test('testShortWithFenceAccepted: a short body carrying the fence is accepted', () => {
  const body = 'ok\n```json:second-opinion-summary\n{"final_verdict":"ACCEPT"}\n```'
  assert.ok(body.length < DEFAULT_MIN_REPLY_CHARS,
    `fixture must be below the floor to discriminate, got ${body.length}`)
  const r = check(body)
  assert.strictEqual(r.ok, true, `fence must short-circuit the floor, got ${JSON.stringify(r)}`)
})

test('testLongNoFenceAccepted: a long fence-less body is accepted', () => {
  const body = 'x'.repeat(DEFAULT_MIN_REPLY_CHARS + 100)
  const r = check(body)
  assert.strictEqual(r.ok, true, `long prose must not be rejected, got ${JSON.stringify(r)}`)
})

test('testFloorOverridden: minChars controls the length arm', () => {
  assert.strictEqual(check(BOOTSTRAP, { minChars: 0 }).ok, true,
    'minChars 0 disables the length arm')
  const r = check('x', { minChars: 5000 })
  assert.strictEqual(r.ok, false, 'a raised floor rejects a short body')
  assert.strictEqual(r.reason, 'reply-too-short-no-summary')
})

test('testDetailMentionsFloor: rejection detail carries observed and expected values', () => {
  const r = check(BOOTSTRAP)
  assert.strictEqual(r.ok, false)
  assert.ok(r.detail.includes(String(BOOTSTRAP.length)),
    `detail must carry the observed length ${BOOTSTRAP.length}, got: ${r.detail}`)
  assert.ok(r.detail.includes(String(DEFAULT_MIN_REPLY_CHARS)),
    `detail must carry the floor ${DEFAULT_MIN_REPLY_CHARS}, got: ${r.detail}`)
})

// EC10: the fence regex is duplicated from consensus.mjs to keep the predicate
// dependency-free. Nothing else stops the two copies drifting, so assert the
// invariant that matters: a body the gate calls fenced must still parse as a
// verdict. Uses the real predicate, never the --break-sanity substitute.
test('testFenceRegexInSyncWithConsensus: a gate-accepted fenced body still parses', () => {
  const body = '```json:second-opinion-summary\n{"final_verdict":"ACCEPT"}\n```'
  assert.strictEqual(checkReplySanity(body).ok, true,
    'gate must accept a canonical fenced body')
  assert.strictEqual(parseVerdict(body).final_verdict, 'ACCEPT',
    'consensus.mjs must parse the same body the gate accepted (FENCE_RE drift)')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
```

### `538-S2` — wire the gate into the harness (REQ-7, REQ-9, REQ-12)

| Step | File | Kind | Exact action | Verify (observed → expected) |
|---|---|---|---|---|
| 2.1 | `scripts/second-opinion.mjs` | **EDIT** | `ANCHOR:` `import { parseVerdict, applyStopCondition, summarizeFindings }`<br>`  from './second-opinion/lib/consensus.mjs'` → `REPLACE:` the same two lines followed by a new line `import { checkReplySanity, DEFAULT_MIN_REPLY_CHARS } from './second-opinion/lib/reply-sanity.mjs'` | `grep -c "checkReplySanity, DEFAULT_MIN_REPLY_CHARS" scripts/second-opinion.mjs` → `1` |
| 2.2 | `scripts/second-opinion.mjs` | **EDIT** | `ANCHOR:` the three lines starting `  if (timeoutRaw !== undefined && (!Number.isInteger(timeoutMs) \|\| timeoutMs < 1000)) {` through its closing `  }` → `REPLACE:` those same lines followed by the §A.7.3 block. | `node -e "const{spawnSync}=require('node:child_process');const r=spawnSync('node',['scripts/second-opinion.mjs','request','--provider','stub','--project','/tmp','--storage','files','--body','b','--summary','s','--min-reply-chars','abc'],{encoding:'utf8'});const d=JSON.parse(r.stdout);if(d.code!=='invalid-min-reply-chars')process.exit(1);console.log(d.code)"` → prints `invalid-min-reply-chars`, exits 0 (a no-op implementation exits 1) |
| 2.3 | `scripts/second-opinion.mjs` | **EDIT** | `ANCHOR:` the six lines from `    if (!r.ok) {` through `    return r` (inclusive) → `REPLACE:` the §A.7.4 block. Change nothing else in `runDispatch`. | `grep -c "provider-reply-invalid" scripts/second-opinion.mjs` → `1` |
| 2.4 | `scripts/second-opinion.mjs` | **EDIT** | `ANCHOR:` `[--consensus --max-rounds <n> --rebuttal-cb <script>] [--preamble <id>]` → `REPLACE:` `[--consensus --max-rounds <n> --rebuttal-cb <script>] [--preamble <id>] [--min-reply-chars <n>]` | `grep -c "min-reply-chars <n>" scripts/second-opinion.mjs` → `1` |
| 2.5 | — | — | Regression: consensus E2E still green. | `node tests/test-second-opinion-consensus-e2e.mjs` → ends `7 passed, 0 failed` |

#### §A.7.3 verbatim block appended by step 2.2

```js
  const minReplyRaw = flag('--min-reply-chars')
  const minReplyChars = minReplyRaw === undefined
    ? DEFAULT_MIN_REPLY_CHARS
    : parseInt(minReplyRaw, 10)
  if (minReplyRaw !== undefined && (!Number.isInteger(minReplyChars) || minReplyChars < 0)) {
    emitErr('invalid-min-reply-chars',
      `--min-reply-chars must be a non-negative integer, got "${minReplyRaw}"`)
  }
```

#### §A.7.4 verbatim replacement block for step 2.3

```js
    if (!r.ok) {
      emitErr('provider-dispatch-nonzero',
        `Provider ${provider} exited non-zero (${r.exitCode})`,
        { provider, dispatchResult: r })
    }
    // #538: a provider can exit 0 while emitting its own interactive bootstrap
    // prompt. Exit status alone is not evidence of a review, so gate the body
    // before it reaches storage — otherwise the garbage persists as status ok
    // and a --consensus run counts it as a completed round.
    const sanity = checkReplySanity(r.stdout, { minChars: minReplyChars })
    if (!sanity.ok) {
      let invalidForensicsPath = null
      if (requestId) {
        try {
          const fdir = path.join(projectRoot, '.review-store', 'forensics')
          fs.mkdirSync(fdir, { recursive: true })
          invalidForensicsPath = path.join(fdir, `${requestId}.round${roundN}.invalid-reply.txt`)
          fs.writeFileSync(invalidForensicsPath, typeof r.stdout === 'string' ? r.stdout : '', 'utf8')
        } catch { invalidForensicsPath = null }
      }
      emitErr('provider-reply-invalid',
        `Provider ${provider} returned an unusable reply (${sanity.reason}): ${sanity.detail}`,
        {
          provider, round: roundN, reason: sanity.reason,
          detail: sanity.detail, forensics: invalidForensicsPath,
        })
    }
    return r
```

### `538-S3` — stub raw-body knob

| Step | File | Kind | Exact action | Verify (observed → expected) |
|---|---|---|---|---|
| 3.1 | `scripts/second-opinion/providers/stub.mjs` | **EDIT** | `ANCHOR:` `  const idMatch = prompt.match(/(\d{8}-\d{6}-[a-z0-9-]+-[0-9a-f]{4})/)` → `REPLACE:` the §A.7.5 block followed by that same anchor line unchanged. | `SO_STUB_RAW_BODY=zz node -e "import('./scripts/second-opinion/providers/stub.mjs').then(m=>{const r=m.dispatch({prompt:'p',projectRoot:'/tmp'});if(r.stdout!=='zz')process.exit(1);console.log(r.stdout)})"` → prints `zz`, exits 0 |

#### §A.7.5 verbatim block inserted by step 3.1

```js
  // SO_STUB_RAW_BODY (#538): return an arbitrary body verbatim with ok:true so
  // tests can drive the reply-sanity gate with a bootstrap-shaped reply. When
  // unset, the deterministic template path below is unchanged.
  if (process.env.SO_STUB_RAW_BODY !== undefined) {
    return {
      ok: true,
      exitCode: 0,
      stdout: process.env.SO_STUB_RAW_BODY,
      stderr: '',
      timedOut: false,
    }
  }

```

### `538-S4` — E2E suite + CI wiring (REQ-7..REQ-11, REQ-13)

| Step | File | Kind | Exact action | Verify (observed → expected) |
|---|---|---|---|---|
| 4.1 | `tests/test-so-reply-sanity-e2e.mjs` | **CREATE** | Full verbatim contents given in §A.7.6 below. | `node tests/test-so-reply-sanity-e2e.mjs` → ends `6 passed, 0 failed` |
| 4.2 | `.github/workflows/tests.yml` | **EDIT** | `ANCHOR:` `      - name: Run second-opinion gate per-project install E2E (RFC-008 P4d — gate + libs + runbooks per-project; snapshot global)`<br>`        run: node tests/test-install-second-opinion-e2e.mjs` → `REPLACE:` those two lines followed by a blank line and the §A.7.7 block. | `node tests/test-ci-suite-registration.mjs` → ends `test-ci-suite-registration: PASS` |

#### §A.7.6 verbatim contents of `tests/test-so-reply-sanity-e2e.mjs`

```js
#!/usr/bin/env node
/**
 * test-so-reply-sanity-e2e.mjs — end-to-end coverage for the #538 reply-sanity
 * gate, driving the REAL harness CLI with the stub provider.
 *
 * Coverage: REQ-7 (single dispatch rejects), REQ-8 (nothing persisted),
 * REQ-9 (forensics written), REQ-10 (no consensus round counted),
 * REQ-11 (happy path unchanged), REQ-12 (invalid flag rejected pre-write).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HARNESS = path.join(REPO_ROOT, 'scripts', 'second-opinion.mjs')

// The verbatim body issue #538 observed persisted as a review reply.
const BOOTSTRAP = 'Load session_handoff.md from 2026-07-14 16:32? (y/n)'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

const tmpDirs = []
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function makeTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-reply-sanity-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  return tmp
}

function makeRebuttalCb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-reply-sanity-cb-'))
  tmpDirs.push(tmp)
  const cbPath = path.join(tmp, 'rebuttal.mjs')
  fs.writeFileSync(cbPath, "#!/usr/bin/env node\nprocess.stdout.write('rebuttal body\\n')\n", 'utf8')
  fs.chmodSync(cbPath, 0o755)
  return cbPath
}

function runHarness(args, { extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv }
  if (env.SO_INSTALL_SNAPSHOT_PATH === undefined) {
    env.SO_INSTALL_SNAPSHOT_PATH = '/nonexistent/snapshot-for-reply-sanity-dev-mode.json'
  }
  const result = spawnSync('node', [HARNESS, ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const stdout = result.stdout.toString()
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    throw new Error(
      `Harness output not JSON. exit=${result.status} stdout=${stdout} stderr=${result.stderr.toString()}`
    )
  }
  return { parsed, exitCode: result.status }
}

function baseArgs(tmp) {
  return [
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'reply sanity body',
    '--summary', 'reply sanity',
    '--dispatch',
  ]
}

console.log('# test-so-reply-sanity-e2e')

test('testSingleDispatchRejects: bootstrap-shaped reply → provider-reply-invalid', () => {
  const tmp = makeTmpProject()
  const r = runHarness(baseArgs(tmp), { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  assert.strictEqual(r.parsed.status, 'error',
    `expected error envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.strictEqual(r.parsed.code, 'provider-reply-invalid',
    `expected provider-reply-invalid, got: ${r.parsed.code}`)
  assert.strictEqual(r.parsed.reason, 'reply-too-short-no-summary',
    `expected reply-too-short-no-summary, got: ${r.parsed.reason}`)
  assert.notStrictEqual(r.exitCode, 0, 'harness must exit non-zero')
})

test('testNoReplyPersisted: rejected reply writes zero reply records', () => {
  const tmp = makeTmpProject()
  runHarness(baseArgs(tmp), { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  const repliesDir = path.join(tmp, '.review-store', 'replies')
  const entries = fs.existsSync(repliesDir) ? fs.readdirSync(repliesDir) : []
  assert.deepStrictEqual(entries, [],
    `no reply record may exist after rejection, found: ${entries.join(', ')}`)
})

test('testForensicsWritten: raw stdout is preserved verbatim to forensics', () => {
  const tmp = makeTmpProject()
  const r = runHarness(baseArgs(tmp), { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  const forensics = r.parsed.forensics
  assert.ok(typeof forensics === 'string' && forensics.length > 0,
    `envelope must name the forensics path, got: ${JSON.stringify(r.parsed)}`)
  assert.ok(fs.existsSync(forensics), `forensics file must exist at ${forensics}`)
  assert.strictEqual(fs.readFileSync(forensics, 'utf8'), BOOTSTRAP,
    'forensics content must be the raw provider stdout, byte for byte')
})

test('testConsensusRoundNotCounted: rejected reply completes no consensus round', () => {
  const tmp = makeTmpProject()
  const cb = makeRebuttalCb()
  const r = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'reply sanity body',
    '--summary', 'reply sanity consensus',
    '--consensus',
    '--max-rounds', '3',
    '--rebuttal-cb', cb,
  ], { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  assert.strictEqual(r.parsed.status, 'error',
    `expected error envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.strictEqual(r.parsed.code, 'provider-reply-invalid',
    `expected provider-reply-invalid, got: ${r.parsed.code}`)
  const rounds = r.parsed.rounds || []
  assert.strictEqual(rounds.length, 0,
    `no round may be counted for a rejected reply, got ${rounds.length}`)
})

test('testHappyPathUnchanged: a normal stub reply still persists with status ok', () => {
  const tmp = makeTmpProject()
  const r = runHarness(baseArgs(tmp))
  assert.strictEqual(r.parsed.status, 'ok',
    `expected ok envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.ok(r.parsed.reply && r.parsed.reply.bodyPath,
    'reply record expected on the happy path')
  assert.ok(fs.existsSync(r.parsed.reply.bodyPath),
    `reply body must be on disk at ${r.parsed.reply && r.parsed.reply.bodyPath}`)
})

test('testInvalidFlagRejected: --min-reply-chars abc fails before any storage write', () => {
  const tmp = makeTmpProject()
  const r = runHarness([...baseArgs(tmp), '--min-reply-chars', 'abc'])
  assert.strictEqual(r.parsed.status, 'error',
    `expected error envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.strictEqual(r.parsed.code, 'invalid-min-reply-chars',
    `expected invalid-min-reply-chars, got: ${r.parsed.code}`)
  assert.ok(!fs.existsSync(path.join(tmp, '.review-store')),
    'no .review-store may be created when a rejecting flag is invalid')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
```

#### §A.7.7 verbatim block appended by step 4.2

```yaml
      - name: Run reply-sanity predicate suite (#538 — pre-persistence gate on provider replies)
        run: node tests/test-second-opinion-reply-sanity.mjs

      - name: Run reply-sanity harness E2E (#538 — bootstrap-shaped reply rejected, nothing persisted)
        run: node tests/test-so-reply-sanity-e2e.mjs
```

## A.8 Definition of done (mechanical)

```bash
node tests/test-second-opinion-reply-sanity.mjs        # → 8 passed, 0 failed
node tests/test-second-opinion-reply-sanity.mjs --break-sanity   # → non-zero exit
node tests/test-so-reply-sanity-e2e.mjs                # → 6 passed, 0 failed
node tests/test-second-opinion-consensus-e2e.mjs       # → 7 passed, 0 failed
node tests/test-second-opinion-dispatch.mjs            # → all pass
node tests/test-second-opinion-storage.mjs             # → all pass
node tests/test-ci-suite-registration.mjs              # → test-ci-suite-registration: PASS
node tools/deploy-audit.mjs                            # → clean
```

## A.9 Blast-radius notes

- **Red-then-green:** step 1.3b is the negative control; it must be observed non-zero before
  the slice is called done.
- **Thin addition, no refactor:** `runDispatch` gains a block; no existing line inside it is
  rewritten. The predicate lives in its own module, so the harness diff stays small.
- **Discriminating fixture:** `testShortWithFenceAccepted` asserts its fixture is below the
  floor before asserting acceptance, so the test cannot pass vacuously.
- **Fixture-change ledger:** no existing test assertion is edited by this plan. If the builder
  finds one that must change, that is a STOP (§A.3), not a silent edit.
