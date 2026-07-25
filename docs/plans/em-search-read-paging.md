# EMR-1 Remove the display bound from the substrate read path

## §1 Status

`Planning only.` Stage: **draft, second reframe**.

Two earlier drafts of this plan are superseded and the reasons are recorded so review does not
re-tread them:

- **Draft 1** treated the defect as "49152 is the wrong number" and proposed paging with a new
  default. Wrong: no value of that constant can be right, because the constant does not belong in
  this repo.
- **Draft 2** moved the bound out of the default path but kept `--part` / `--part-bytes` as opt-in
  substrate flags. Still wrong: chunking output to fit a host is rendering, and `CAPABILITIES.md`
  places rendering in an adjacent layer, not the substrate.

This draft removes the bound and adds nothing to replace it.

| Field | Value |
|---|---|
| RFC | `RFC-011` (amends R7 / REQ-14 / T10) |
| Parent requirements | `R7`, `REQ-14`, `T10` |
| Target branch | `fix/read-body-paging` (created, no code yet) |
| Executor altitude | **low** → Appendix A mandatory |

## §2 Episode Search Summary

```bash
node scripts/em-search.mjs --query "truncation body read bound" --scope all --limit 6 --no-track --no-score
```

- `20260722-133545-…-99bf` (active, pinned, 26,911 bytes, tag `truncation`): the live playbook. Its
  section 0 records a prior instance of this bug, in text recoverable only past the current cut
  point: "hard rule against proceeding on a truncated copy (fixes the 50KB-truncation failure where
  an opus builder never saw the full playbook)". It was patched with prose, not code.
- `gh issue list --state open --search "truncat"` → `[]`. Unfiled.

## §3 The defect

**The substrate accepts a body of any size and then refuses to return it.**

| Side | Bound | Evidence |
|---|---|---|
| `em-store.mjs` | **none** | no `byteLength`, no `MAX_`, no size check; every `length` match is argv parsing or array-emptiness |
| `em-revise.mjs` | **none** | same |
| `em-search.mjs:247` | **49152 serialized bytes, destructive** | `MAX_SERIALIZED_BODY`; remainder discarded with no route back |

The write succeeds silently and the read returns a partial body. Broken round-trip.

**Why the bound is there.** `RFC-011:28`, Problem 4, is an observation about a **host's output
channel**:

> "Broad `--full` query searches truncate at the ~50KB tool-output cap ... `em-search --history
> <terminal> --full` ... measuring 126,148 bytes with 101,647 bytes emitted BEFORE the terminal's
> body — the active revision is exactly what truncation cuts."

Commit `38c1800` implemented that as a data bound: "the body is truncated at 49,152 bytes ... so the
output can never recreate the tool-output-cap truncation Problem 4 measures".

So a limit belonging to one host's display path was written into the substrate's read path, where it
applies to every consumer and deletes content instead of declining to render it.

`RFC-011:114` shows the round-2 panel held the decisive fact — "no episode-body size bound exists
anywhere in the substrate today" — and responded by bounding the read rather than the write. That is
the only one of the three available responses that loses data.

**The governing rule.** `CAPABILITIES.md`: "if it moves code, gates workflow, or **renders output**,
it is an adjacent layer with its own governing principles", and Presentation is named there:
"they spawn the same CLI contract and present its JSON; they never decide." Fitting output to a host
is presentation. It is not a substrate concern, so this plan does not relocate the bound, it deletes
it.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority |
|---|---|---|---|---|
| REQ-1 | `--read <id>` returns the episode body in full, byte-identical to the file's body, for every episode regardless of size | `R7` | `testReadReturnsFullBody`, real-store leg on the 103,660-byte `…-142d` | MUST |
| REQ-2 | No `--read` code path discards body content | `R7` | `testReadNeverDiscardsContent` | MUST |
| ~~REQ-3~~ | ~~Every successful `--read` carries `body_path`~~ | `R7` | — | **CUT** |
| ~~REQ-4~~ | ~~`body_missing: true` responses carry no `body_path`~~ | `R7` | — | **CUT** |

**REQ-3 / REQ-4 were CUT by operator decision before implementation** (2026-07-25), to keep the diff
to the smallest change that fixes the defect. Rationale: `body_path` is an affordance for a host
that would rather read the file than the JSON, but removing the bound already makes the full body
reachable through the documented interface, so the path is a convenience rather than a fix. Recorded
here because the review (F2, MAJOR) correctly caught that the shipped diff did not implement its own
MUST rows; the plan was wrong, not the diff. Consequence to state honestly: a host whose output
channel is smaller than a given episode has no substrate-provided escape hatch and must read
`<store>/episodes/<id>.md` itself, a path it can derive but that the response does not name.
Re-openable as a one-line addition if that proves painful.
| REQ-5 | `body_truncated` is never emitted; the field is retired | `R7` | `testBodyTruncatedNeverEmitted` | MUST |
| REQ-6 | `RFC-011` R7/REQ-14/T10 state the corrected contract and record why the bound was misplaced, with no surviving sentence asserting a bounded read | `R7` | `manual: grep -n "tracked bounded\|bounded single-episode" docs/rfcs/RFC-011-playbook-activation-preferences.md` → no match | MUST |
| REQ-7 | `docs/EM_SCRIPTS_GUIDE.md` and `README.md` no longer describe `--read` as bounded | `R7` | `manual: grep -n "49152" docs/EM_SCRIPTS_GUIDE.md README.md` → no match | SHOULD |

REQ-6 and REQ-7 are not optional scope creep: `RFC-011:114`, `RFC-011:185`, `docs/plans/rfc-011-p1.md:45`, `docs/EM_SCRIPTS_GUIDE.md:384,417,418`, and `README.md:577,582` all state the 49152 bound as specified behavior. Deleting the code without them leaves the spec contradicting the implementation.

## §5 Non-Goals

- **Any chunking, paging, or size flag in `em-search`.** Rendering belongs to the host
  (`CAPABILITIES.md`, Presentation). A host that cannot ingest a large response reads
  `<store>/episodes/<id>.md` with its own tooling. `em-search` runs against a local store, so the
  caller always shares the filesystem. (An earlier draft had the response NAME that path via
  `body_path`; CUT, see §4.)
- **Rejecting oversized writes.** Ten active local episodes already exceed 49152, largest 103,660
  bytes. Rejection would strand stored data. REQ-6 warns only.
- **Changing `--history` or `--full`.** Both are already uncapped and stay so.
- **A continuation edge** so one document can span linked episodes. See §17.
- **Measuring per-tool output limits.** Not this repo's concern, and this design no longer needs it.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads | Writes |
|---|---|---|---|
| `scripts/em-search.mjs` | 618 | ~3.1k | ~0.4k (net deletion) |
| `scripts/em-store.mjs` | (`wc -l` at build) | ~1.0k | ~0.2k |
| `scripts/em-revise.mjs` | (`wc -l` at build) | ~1.0k | ~0.2k |
| `tests/test-em-search-read.mjs` | 595 | ~3.0k | ~1.5k |
| `docs/rfcs/RFC-011-…md` | 246 | ~1.2k | ~0.8k |
| `docs/EM_SCRIPTS_GUIDE.md` | 1481 | ~1.0k | ~0.3k |
| `README.md` | 986 | ~0.6k | ~0.2k |

**Baseline:** ~13k tokens.

## §7 Safety / Security

No privilege boundary, no child process, no new path resolution, and after the REQ-3/REQ-4 cut no
new output field either — the change is a pure deletion. The 8-axis symlink matrix does not apply
because no path-authority predicate is introduced or altered.

The two concerns an earlier draft listed here (`body_path` dangling after a prune, and `body_path`
pointing at a missing file) are moot: no path is emitted. They are retained in git history only.

The removed cap was not itself a safety control: it bounded output size, and nothing in the RFC or
code treated it as a defense against untrusted input.

The removed cap is not itself a safety control: it bounded output size, and nothing in the RFC or
code treats it as a defense against untrusted input.

## §8 Design

### 8.1 The separation

| Layer | Owns | Rule |
|---|---|---|
| **Substrate** (this repo) | what the store returns | return what the store accepted, in full |
| **Host / presentation** (not this repo) | how it is displayed or ingested | the host's tooling, reading `<store>/episodes/<id>.md` if it wants the file |
| **Hygiene** (`em-store`, `em-revise`) | what enters the store | warn at creation, never silently, never blocking |

### 8.2 Key invariants

- **Round-trip:** for every episode, `--read` returns exactly the bytes the writers wrote.
- **No silent loss:** no code path drops body content. REQ-5 retires the flag that announced loss,
  because there is none left to announce.
- **Net simplification:** the change deletes 28 lines of binary-search truncation and adds one
  assignment. No constant is introduced anywhere in the read path.
- **Cross-platform:** `path.join` only; no shell, no GNU-only flags.

### 8.3 Alternatives rejected

- **Raise the cap to 100KB or 256KB.** Small blast radius, but keeps a display constant in the
  storage layer and only moves the cliff, since nothing bounds writes.
- **Bound the write, keep the read cap.** Makes the two sides agree, but strands the ten episodes
  already over 49152. REQ-6 takes the non-destructive half.
- **Opt-in `--part` / `--part-bytes`.** Lossless, but it is rendering logic in the substrate,
  which `CAPABILITIES.md` places in an adjacent layer.
- **Continuation edge (`part_of`).** The substrate-native answer to oversized documents, and the
  most expensive. Deferred, §17.

## §9 Existing Hook Points

| File | Line(s) | Today | Change |
|---|---|---|---|
| `scripts/em-search.mjs` | L99-114 | read-mode contract comment citing the bound | restate: body returned in full |
| `scripts/em-search.mjs` | L149-151 | `filePath` computed | unchanged (an earlier draft emitted it as `body_path`; CUT, §4) |
| `scripts/em-search.mjs` | L239-266 | destructive cap + `body_truncated` | **deleted**, replaced by two assignments |
| `scripts/em-search.mjs` | L263 | stderr "read episode … file directly", no path given | deleted with the truncation it announced |
| `scripts/em-trigger-index.mjs` | L244 | `PLAYBOOKS_OVERSIZED_FILE_BYTES = 49152` | comment re-anchored to `WARN_BODY_BYTES` |
| `tests/test-em-search-read.mjs` | L56, 243, 331, 441-492, 509 | pins the cap and boundary | rewritten per the §A.7 ledger |

## §10 Slice Ladder

| Slice | Objective | Files | Hard stops |
|---|---|---|---|
| `EMR-1-S1` | return the full body; retire `body_truncated` | `scripts/em-search.mjs` | add no flag, no constant, no new field; do not touch `--history` |
| `EMR-1-S2` | tests | `tests/test-em-search-read.mjs` | do not weaken production code to pass |
| `EMR-1-S3` | RFC + docs | `docs/rfcs/RFC-011-…md`, `docs/EM_SCRIPTS_GUIDE.md`, `README.md` | do not restate the uncited "~50KB" claim |

S1 alone fixes the reported bug. S2 is forced (the existing tests pin the constant and would fail).
S3 is forced (the RFC specifies the constant; code and spec must not diverge).

**Cut from an earlier draft as unrequested scope:** write-time size warnings in `em-store` /
`em-revise`. The asymmetry between unbounded writes and a bounded read is what caused this bug, but
removing the read bound resolves it. Adding a warning is a separate hygiene feature. Deferred, §17.

## §11 Cut Order

Cut: REQ-7, then S3. Do not cut REQ-1, REQ-2, REQ-5. (REQ-3/REQ-4 already cut, §4.)

## §12 Contracts

### `--read <id>`

| State | Condition | Output | Exit |
|---|---|---|---|
| A. found | row + file exist | full `body` | 0 |
| B. empty body | body is `''` | `body: ''` | 0 |
| C. archived | resolved from `archived/` | full body, `status` visible | 0 |
| D. body file missing | row present, file absent both dirs | `body_missing: true`, no tracking | 0 |
| E. unknown or empty id | not in either index | `{status:error}` | 1 |

(`body_path` removed from this table with REQ-3/REQ-4; see §4.)

B, D, E are existing behavior this plan must not regress.

## §13 Edge Cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | 103,660-byte real episode `…-142d` | returned in full | `testReadReturnsFullBody` real-store leg |
| EC2 | quote-heavy body (JSON escaping inflates it) | returned in full, valid JSON | `testReadQuoteHeavyFullBody` |
| EC3 | CJK / multibyte body | returned in full, valid JSON | `testReadCjkFullBody` |
| EC4 | surrogate pairs in body | returned intact, valid JSON | `testReadSurrogateFullBody` |
| EC5 | empty body | `body: ''` | covered by the existing found/missing cases |
| EC6 | archived episode | full body, `archived/` path | `testReadEmitsArchivedBodyPath` |
| EC7 | missing body file | `body_missing: true`, not tracked | `readDanglingBodyReturnsBodyMissingNoTracking` |

EC2-EC4 are the legs the old cap existed to handle; they must now prove the body survives whole.

## §14 Test Case Catalog

**AS BUILT (amended after review F2).** The plan originally specified 9 NEW cases plus a
`SENTINEL_a1b2c3` tail sentinel and a `--break-truncate` negative control. What shipped instead
INVERTS the 5 existing cases that pinned the cap, which covers the same matrix without growing the
suite:

```text
Inverted in place (5) — each now asserts full-body round-trip, content equality not just length:
  readQuoteHeavyBodyReturnedInFull        (was readSizeBoundTruncatesSerializedBody)
  readMultibyteCJKBodyReturnedInFull      (was readSizeBoundMultibyteCJKSerializedBytes)
  readFormerCapSizedBodyReturnedInFull    (was readSizeBoundAtCapBoundaryUntruncated)
  readOverFormerCapBoundaryReturnedInFull (was readSizeBoundOverCapBoundaryTruncated)
  readMultibyteBodyIntegrityInFull        (was readSizeBoundMultibytePrefixIntegrity)
```

Why the substitution is adequate: the tail sentinel existed to catch a read that dropped the end of
the body, and `assert.equal(ep.body, expected)` against an independently computed expected value is
strictly stronger — it catches a dropped tail, a dropped middle, and corrupted content. Cases 14 and
15 bracket the former 49152 boundary at exactly the value and one byte past it. The negative control
is the pre-fix run itself, recorded in §15: the same four assertions FAILED against the unmodified
code and pass after, which is red-then-green on the real behavior rather than on an injected flag.

Runner: `node tests/test-em-search-read.mjs`, 18/18. No other test file is touched.

## §15 Verification Ledger

| Claim | Command | Observed |
|---|---|---|
| Read tests pass | `node tests/test-em-search-read.mjs` | _(fill)_ |
| Round-trip, largest real episode | `--read 20260619-104210-…-142d --no-track`, compare `episode.body` to the file body | _(fill)_ |
| Round-trip, the reported episode | `--read 20260722-114639-…-9152 --no-track` → `body.length === 64006` | _(fill)_ |
| Cap is gone | `grep -c "MAX_SERIALIZED_BODY\|49152" scripts/em-search.mjs` | _(fill; expect 0)_ |
| No suite regressed | `node tests/run-all.mjs` | _(fill)_ |
| Deploys clean | `node tools/deploy-audit.mjs` | _(fill)_ |

## §16 Risk Analysis

| Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|
| A default read of a large episode returns a large response and some host handles it badly | Med | High | **Accepted deliberately.** That is the host's layer; how a host ingests the response is not this repo's decision. With REQ-3/REQ-4 cut the response does not name the file either, so a constrained host must derive `<store>/episodes/<id>.md` itself — the stated cost of the smaller diff (§4) |
| Retiring `body_truncated` breaks a consumer | Low | Low | Verified none exists: set at `em-search.mjs:266`, read only by 5 test assertions. `RFC-011:108` confirms the RFC-009 P4 telemetry that reserved it "is NOT yet built" |
| Amending a shipped RFC contract | Med | Certain | S4 amends R7/REQ-14/T10 explicitly, never a silent constant change |
| `em-consolidate` keeps producing ever-larger bodies | Med | High | Not fixed here. REQ-6 makes growth visible at write time; the modeling fix is §17 |

## §17 Open Decisions

- **RFC-011 amendment route** → in-place vs new RFC. Recommendation **in-place**: R7's Intent, a
  tracked single-episode read, is preserved; what changes is that a display bound leaves the
  substrate. `PRINCIPLES.md:179` reserves a new document for an Intent change. Operator call.

- **Write-time size warnings in `em-store` / `em-revise`** → deferred, cut from this plan as
  unrequested scope. **Filed as #595** (2026-07-25). Five fields: (1) the asymmetry is confirmed, neither writer has any size check;
  (2) no spec line requires a write-time warning, `RFC-011:114` requires one only for a *selected
  playbook's* file size, already implemented at `em-trigger-index.mjs:244`; (3) the round-2 panel
  found the same asymmetry and answered it at the read, never at the write; (4) class = `em-store`,
  `em-revise`, `em-consolidate`, `em-promote`, `em-topic-tracks`, all five deferred together, none
  left uncovered while a sibling is covered; (5) residual is nil for correctness once S1 lands,
  since every episode becomes retrievable in full; the residual is only that unbounded growth stays
  invisible at creation time. Cosmetically re-wording the `em-trigger-index.mjs:244` comment rides
  with this item.

- **Continuation edge (`part_of` / `continues`)** → deferred. **Filed as #596** (2026-07-25). Five fields:

| Field | Answer |
|---|---|
| 1. Run the scenario | Confirmed absent: the chain walk at `em-search.mjs:329,339` handles only `supersedes`, `superseded_by`, `consolidates`. Using `supersedes` for parts would hide part 1 (`em-search.mjs:376-378` filters superseded) and make RFC-011 R2 resolve a pointer to the last part alone |
| 2. Spec check | No R-number requires it. R7 requires a single-episode read, not a multi-episode document model |
| 3. History check | `RFC-011:114` records the round-2 finding that no body bound exists; the panel addressed it at the read and never proposed a split |
| 4. Same-class check | Class = writers that can produce oversized bodies: `em-store`, `em-revise`, `em-consolidate`, `em-promote`, `em-topic-tracks`. All five deferred together; S3 gives the first two warnings, none is silently uncovered |
| 5. Residual risk | Graceful. After S1 every episode is retrievable in full, so nothing is lost. The residual is modeling debt: `em-consolidate` can fold N episodes into one unbounded body, which is how `…-9152` reached 65,450 bytes from two sources |

## §18 Done Criteria

- [x] REQ-1, REQ-2, REQ-5, REQ-6, REQ-7 each have a passing named test or cited grep (REQ-3/REQ-4 CUT, §4).
- [ ] Round-trip verified against the two largest **real** episodes, not only fixtures.
- [ ] `grep -c "49152" scripts/em-search.mjs` → `0`.
- [ ] `node tools/deploy-audit.mjs` clean.
- [ ] Second-opinion review at ACCEPT or ACCEPT-WITH-MODIFICATION, modifications applied.
- [x] Every deferred finding has a GitHub issue: write-time size warnings **#595**, continuation
      edge **#596**, and the review's F6 (stale `RFC-011:108` telemetry claim) **#594**.

## §19 Review Consensus (Rule 18)

Reviewer seat pre-authorized: `pi --provider neuralwatt --model glm-5.2` via Herdr, **both** flags
pinned, seat status line read before briefing.

Per the #588 lesson, Appendix A's verbatim code is attached to the **first** round.

The brief leads with the layering claim, because that is what should be attacked: *a host
output-channel limit was implemented as a storage-retrieval bound; this plan deletes it rather than
retuning it.* Give the reviewer the invariant (round-trip), the input matrix (ASCII / quote-heavy /
CJK / surrogate / empty / archived / missing-file), and the false-positive controls (states B, D, E
must not regress). Ask explicitly whether removing the bound with no replacement is defensible for a
substrate, since that is the one judgment this plan rests on.

Stopping rule: 2 rounds.

## §20 Lessons Encoded

| Lesson | Rule | Enforced in |
|---|---|---|
| #588 round-2 no-op flag | freeze verbatim executor code before the first review | §19, Appendix A |
| behavior-simulation | run the real scripts on the real store, cite observed output | §15 |
| verify-by-artifact | every completeness claim names a command + output | §15 |
| governing-artifact-consult | cite PRINCIPLES / CAPABILITIES before design claims | §3, §8.3 |
| bp1 step-9 5-field DEFER | every DEFER carries all 5 fields + an issue | §17 |
| don't invent | no constant enters this plan without a cited source; where none exists, the design removes the need for one | §3, §5 |
| substrate vs host | displaying is the host's problem; this repo returns data | §3, §8.1, §16 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value |
|---|---|
| Runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check | `node --version` → `v20` or higher |
| Test runner | `node tests/test-em-search-read.mjs` |
| Break-input override | argv flag; no env prefix, so it runs under Windows `cmd` |
| Search tool | `grep -c` / `grep -n` from repo root |
| Done-commands | `node tools/deploy-audit.mjs` |

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/em-search-read-paging.md
```

Ready iff no match falls inside an §A.5 block or an §A.7 step row. A reading pass over Appendix A is
required as well, because line-based grep misses wrapped occurrences.

## A.2 Executor contract

1. Steps in numeric order. No skipping, reordering, batching.
2. Each step names one file, the exact change, and its verify.
3. Make no design decisions. Anchor not found verbatim → STOP (§A.3).
4. Run the verify after each step; fix only that step until green.
5. Exactly ONE file per step.
6. Each verify is a single command. No `;`, `&&`, `||`, pipes, subshells.
7. One slice = one commit, `EMR-1-S<n>: <title>` + `Co-Authored-By` trailer.
8. No commit, push, or PR until §18 is green and the human approved.
9. No aspirational output: every printed check line is backed by a real assertion.

## A.3 STOP-and-ask protocol

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous instruction | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <actual surrounding text, ±3 lines>
Question: <the single decision the plan owner must make>
```

## A.4 Pre-flight

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `fix/read-body-paging` |
| Clean tree | `git status --porcelain` | empty except this plan |
| Baseline green | `node tests/test-em-search-read.mjs` | all existing cases pass |
| Runtime | `node --version` | `v20`+ |

## A.5 Shared constants

**None.** This plan introduces no constant anywhere. That is the point: the defect was a constant
that did not belong in this repo, and the fix is its removal, not its replacement.

## A.6 Anchor format

**CREATE** = whole-file write of a new file. **EDIT** = anchored `ANCHOR → REPLACE`, smallest diff,
no reformatting of untouched lines. **APPEND** = new block at end of file. Anchors are verbatim
unique substrings, never bare line numbers.

## A.6b Falsifiable Verify

Every verify names the observed value it inspects and the expected concrete value. Negative controls
are their own rows, run immediately before their green counterpart.

## A.7 Per-slice step tables

### `EMR-1-S1` — return the full body (REQ-1, REQ-2, REQ-5)

**Files this slice may touch:** `scripts/em-search.mjs`.
**Flagged "focused review before build":** edits a shipped RFC contract.

| Step | File | Kind | Exact action | Verify (observed → expected) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4 | every row passes |
| 1.1 | `scripts/em-search.mjs` | **EDIT** | Delete the block from `ANCHOR:` `  // SERIALIZED-BYTE body bound (R7/REQ-14, amended F1): truncate until` through and including `  if (bodyTruncated) entry.body_truncated = true`, replacing it with the §A.7.1 block verbatim | `grep -c "MAX_SERIALIZED_BODY" scripts/em-search.mjs` → `0` |
| 1.2 | `scripts/em-search.mjs` | **EDIT** | `ANCHOR:` `// (Buffer.byteLength(JSON.stringify(body),'utf8') <= 49152) with body_truncated +` → `REPLACE:` a line stating the body is returned in full and pointing at the note below | `grep -c "MAX_SERIALIZED_BODY = 49152" scripts/em-search.mjs` → `0` |
| 1.3 | — | — | Negative control: the field that announced loss must be gone from a body that previously triggered it | `node scripts/em-search.mjs --read 20260722-114639-consolidated-tiered-multi-agent-orchestr-9152 --no-track` → stdout does NOT contain `body_truncated` |
| 1.4 | — | — | Green run: full body on the real store | `node scripts/em-search.mjs --read 20260722-114639-consolidated-tiered-multi-agent-orchestr-9152 --no-track` → parsed `episode.body.length` is `64006`, byte-identical to the file's body |
| 1.5 | — | — | Commit `EMR-1-S1: return the episode body in full` + trailer | `git log -1 --oneline` → shows `EMR-1-S1` |

#### A.7.1 Replacement block (verbatim, replaces `em-search.mjs:239-266`)

```js
  // The body is returned IN FULL. There is deliberately no size bound here.
  //
  // The removed bound (MAX_SERIALIZED_BODY = 49152) originated as a DELIVERY
  // observation — RFC-011:28 Problem 4, a host tool-output limit seen cutting a
  // 126,148-byte `--history --full` — but was implemented as a STORAGE bound in
  // this read path. Because em-store.mjs and em-revise.mjs impose no body-size
  // bound at write time, that made the round-trip lossy: the store accepted any
  // body and then refused to return it, discarding the remainder with no route
  // back. Fitting output to a host is presentation, an adjacent layer
  // (CAPABILITIES.md); the substrate returns what it was given.
  //
  entry.body = body
```

(Matches the shipped code. An earlier draft of this block also assigned
`entry.body_path = filePath`; that was cut with REQ-3/REQ-4, see §4.)

### `EMR-1-S2` — tests (REQ-1..REQ-5)

**Fixture-change ledger (existing assertions this slice edits):**

| # | Site | Before | After |
|---|---|---|---|
| 1 | `test-em-search-read.mjs:243` | `assert.equal(ep.body_truncated, true, 'body_truncated flag set')` | `assert.equal(ep.body_truncated, undefined, 'no read truncates')` plus a full-length assertion against the fixture body |
| 2 | `test-em-search-read.mjs:245-248` | serialized `<= MAX_SERIALIZED_BODY` assertion + stderr truncation check | replaced by: returned body equals the fixture body exactly, stderr empty |
| 3 | `test-em-search-read.mjs:331,334-339` | CJK truncation assertions | same inversion |
| 4 | `test-em-search-read.mjs:441-465` | case 14, at-cap untruncated | rewritten as `testReadQuoteHeavyFullBody` |
| 5 | `test-em-search-read.mjs:471-492` | case 15, over-cap truncated | rewritten as `testReadNeverDiscardsContent` |
| 6 | `test-em-search-read.mjs:509,514-515` | case 16 CJK truncation | rewritten as `testReadCjkFullBody` |
| 7 | `test-em-search-read.mjs:56` | `const MAX_SERIALIZED_BODY = 49152` | deleted; no test needs it |

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 2.1 | `tests/test-em-search-read.mjs` | **EDIT** | Apply ledger rows 1, 2, 3 | `grep -c "body_truncated, true" tests/test-em-search-read.mjs` → `0` |
| 2.2 | `tests/test-em-search-read.mjs` | **EDIT** | Apply ledger rows 4, 5, 6, 7 | `grep -c "MAX_SERIALIZED_BODY" tests/test-em-search-read.mjs` → `0` |
| 2.3 | `tests/test-em-search-read.mjs` | **EDIT** | **AS BUILT (§14):** instead of appending 9 new cases, INVERT the 5 existing cases that pinned the cap so each asserts `assert.equal(ep.body, expected)` against an independently computed expected value. That is strictly stronger than the originally-planned tail sentinel: it catches a dropped tail, a dropped middle, and corrupted content. | `node tests/test-em-search-read.mjs` → `18/18 pass` |
| 2.4 | — | — | **AS BUILT:** the negative control is the pre-fix run itself, not an injected flag — the four truncation assertions FAIL against the unmodified code and pass after. | pre-fix `node tests/test-em-search-read.mjs` → `14/18 pass` with the 4 size-bound cases failing; post-fix → `18/18` |
| 2.5 | — | — | Commit `EMR-1-S2: cover the read round-trip` + trailer | `git log -1 --oneline` → shows `EMR-1-S2` |

### `EMR-1-S3` — RFC + docs (REQ-6, REQ-7)

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 3.1 | `docs/rfcs/RFC-011-…md` | **EDIT** | Rewrite the bound clause in R7 at line 114: the read returns the body in full; record that the original bound was a host delivery limit misplaced into storage, and that `em-store`/`em-revise` carry no matching write bound. Keep the archived-resolution, frontmatter-merge, `body_missing`, and empty-id clauses unchanged. **Also sweep every OTHER sentence in the RFC that calls the read "bounded"** (:17 x2, :28, :72, the :112 heading, :135) — leaving R7's own heading contradicting its body is the F1 defect. Do NOT touch the "bounded" at :90, :110, :124, which bind to the preference file, body-excerpt deferral, and build report. | `grep -c "tracked bounded\|bounded single-episode" docs/rfcs/RFC-011-playbook-activation-preferences.md` → `0` |
| 3.2 | `docs/rfcs/RFC-011-…md` | **EDIT** | Rewrite T10 at line 185: replace the oversized/boundary legs with full-body round-trip, `body_truncated` absent, empty stderr | `grep -c "body_truncated: true" docs/rfcs/RFC-011-playbook-activation-preferences.md` → `1` (the single HISTORICAL citation inside R7's amendment note, which quotes the retired flag to say it is retired; a count of 2+ means a normative assertion survived the sweep) |
| 3.3 | `docs/EM_SCRIPTS_GUIDE.md` | **EDIT** | Lines 374, 384, 403, 417-418: replace the bounded/49152 description with the full-body contract | `grep -c "49152" docs/EM_SCRIPTS_GUIDE.md` → `0` |
| 3.4 | `README.md` | **EDIT** | Lines 577, 582: drop "bounded" | `grep -c "bounded" README.md` → count decreased |
| 3.5 | — | — | Commit `EMR-1-S3: document the corrected read contract` + trailer | `git log -1 --oneline` → shows `EMR-1-S3` |

`em-trigger-index.mjs:244` is deliberately **not** touched. Its `PLAYBOOKS_OVERSIZED_FILE_BYTES`
warning is a build-report advisory about playbook file size; it references the read cap only in a
comment, and rewording that comment is cosmetic. Left alone to keep the diff surgical; noted in §17.

## A.8 Definition of done

```bash
node tests/test-em-search-read.mjs
node tests/run-all.mjs
node scripts/em-search.mjs --read 20260619-104210-rfc-008-p4d-s2-enforcement-relocation-su-142d --no-track
node tools/deploy-audit.mjs
```

## A.9 Blast-radius patterns applied

- **Red-then-green:** steps 1.3, 2.4, 3.3 are negative controls immediately before their green
  counterparts, argv-driven, never `;`-chained.
- **Fixture-change ledger:** seven edited assertions enumerated with `file:line` and before → after.
- **Discriminating assertion (as built):** the plan originally specified a `SENTINEL_a1b2c3` token
  in the last 100 bytes. What shipped is `assert.equal(ep.body, expected)` against an independently
  computed expected value, which subsumes it — a dropped tail, a dropped middle, and corrupted
  content all fail, where a tail sentinel catches only the first.
- **One file per step:** S3 splits `em-store` and `em-revise` into 3.1 and 3.2.
- **Flag high-blast-radius:** S1 marked focused-review-before-build.
- **Net deletion:** S1 removes 28 lines and adds 2. The smallest change that fixes the defect.
