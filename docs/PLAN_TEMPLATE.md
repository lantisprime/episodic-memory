# PLAN_TEMPLATE.md

Copy this template when starting a new feature, RFC slice, or non-trivial implementation
plan. Delete sections that don't apply — but read **§0 How to use** first to decide which
sections are mandatory for your executor.

> **The Requirements table (§4) is the ground truth.** Every requirement SHALL map to at
> least one test or validation check. A plan is not "complete" until the Requirements table
> is fully populated, every row has a test mapping, and (for RFC work) every row cites its
> parent R-number. If a requirement cannot be tested, it is not a requirement — move it to
> Non-Goals or Design notes.

This template adapts the upstream `pi-extensions/agents/PLAN_TEMPLATE.md` to this repo's
conventions: `.mjs` (zero-dep Node ESM) instead of `.ts`, RFC R-number grounding, Rule 12
token budgeting, the Rule 18 review workflow, marker/gate discipline, and a hardened
mechanical-executor appendix — with a **falsifiable-verify** core (§A.6b) and **blast-radius
patterns** (§A.9) re-adopted from upstream's evolved Appendix B. The appendix is the build path
when a **lower-capability LLM** implements the plan: it removes every design decision and makes
every verify fail on a stub.

---

## §0 How to use (read before copying)

### 0.1 Pick the executor altitude

The plan's required detail depends on **who implements it**. Decide this first.

| Executor | Who | Required sections | Appendix B (mechanical spec)? |
|---|---|---|---|
| **High-capability** | Opus/Sonnet-class model that shares this context, or you | §1–§14 | Optional — may delete |
| **Low-capability** | Cheaper/low-effort sub-agent, fresh context, weak reasoning | §1–§14 **and** Appendix B | **Mandatory** — it is the build path |
| **Human contributor** | New maintainer unfamiliar with the code | §1–§14 + §11 Existing Hook Points | Recommended |

When in doubt, **write Appendix B**. The cost of an over-specified plan is tokens; the cost
of an under-specified plan handed to a weak executor is silent wrong implementation.

### 0.2 The ambiguity tripwire (applies to every section)

If any sentence in the plan contains the words **"decide", "choose", "figure out",
"as appropriate", "if needed", "handle accordingly", "etc.", "and so on", or "TBD"**, the
plan is not executor-ready. Resolve the decision in the plan body and restate the sentence as
a concrete action with a named artifact. This rule is enforced by the §A.1 forbidden-phrase
lint before any plan is marked ready.

### 0.3 This repo's planning rules (do not skip)

- **Rule 8 / plan-gate:** non-trivial work requires an approved plan before implementation.
  The plan-approval marker fires on the **final** plan (after second-opinion review under
  Rule 18), not the first draft.
- **Rule 12 / token budget:** `wc -l` the target files and fill §6 before presenting.
- **Rule 18 / implementation workflow:** plan → second-opinion review on the plan → fix
  findings → final plan + approval → implement with tests alongside → code review → fix →
  E2E → disposition every finding. Tests are written **during** implementation, never deferred.
- **Cross-platform always:** `os.tmpdir()` / `path` module; no GNU-only flags, `sed -i`,
  or `readlink -f` assumptions. State the cross-platform check in §8 Design invariants.
- **Verify by artifact:** every "done" claim in §15 names a command + its output, not prose.

---

# <FEATURE_ID> <Feature Name> Plan

## §1 Status

`Planning only.` Do not implement until this plan, the plan review, and the adversarial
review are accepted (Rule 18). Current stage: **<draft | under-review | findings-open | approved>**.

| Field | Value |
|---|---|
| RFC | `<RFC-NNN>` (or `n/a`) |
| Parent requirements | `<R1, R5, …>` (or `n/a`) |
| Workplan episode | `<episode-id>` |
| Target branch | `<feature/branch-name>` |
| Executor altitude (§0.1) | `<high / low / human>` |

## §2 Episode Search Summary

Run the recall and paste the result — do not summarize from memory.

```bash
node scripts/em-search.mjs --tag <relevant-tag> --scope all --limit 10 --full --no-track
```

Key active memories:

- `<episode-id>`: <one-line summary — and how it constrains this plan>
- ...

If a recalled memory names a file/function/flag, **verify it still exists** before relying on
it (memories are point-in-time). Use the `em_*` scripts for all episode operations (search /
read / store / revise); for any non-trivial body pass `--body-file` (lessons `…04a7`, `…07e1`).

## §3 Objective

<2–4 sentence statement of what this feature proves or delivers. Concrete and verifiable —
not "improve X" but "X now does Y, provable by Z".>

## §4 Requirements (Ground Truth)

Every requirement SHALL be testable and SHALL map to ≥1 test or validation check. Number them
`REQ-1, REQ-2, …`. For RFC work, every REQ cites its parent R-number(s) — a finding or design
statement with no R-anchor has no disposition anchor in review.

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | <statement> | `R<n>` | `<testName>`, `manual: <cmd>` | MUST / SHOULD / MAY | <rationale> |
| REQ-2 | ... | ... | ... | ... | ... |

**Priority legend:**
- **MUST** — required for the first slice merge. Failing test = merge blocker.
- **SHOULD** — required before the feature is complete; one slice may defer (file an issue).
- **MAY** — nice-to-have, blocks no merge.

The `Test(s)` column accepts: named automated tests (`testFoo`), manual smoke checks
(`manual: node scripts/em-list.mjs`), or static analysis (`grep`, `git diff --stat`). List
**all** verification methods that prove the row.

**A MUST maps to an automated, falsifiable test — not a manual or CI-skippable smoke.** A smoke
that can `command -v … || exit 2`-skip is **not coverage**: it stays green on a machine that never
ran the check. If the *only* possible verification of a MUST is a manual/skippable smoke (an
OS-level behavior CI can't reproduce), tag the row **`UNGUARDED-IN-CI`** and name the exact manual
step in Notes — so the gap is a tracked, visible residual, never a hollow green. The falsifiability
bar itself is §A.6b.

## §5 Non-Goals

Explicitly out of scope (prevents scope creep mid-implementation):

- <item 1>
- <item 2>

## §6 Token Budget (Rule 12)

`wc -l` every target file before estimating. Show baseline (one PR/session) and optimized.

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `<path>` | <n> | <n× 5> | <est> | |

**Baseline (single session):** ~<N>k tokens.
**Optimized (min sessions):** ~<N>k, grouped by dependency layer (see §12).
Claude Code reference: ~38k overhead, 60–130k sweet spot, >130k → autocompact risk.

## §7 Safety / Security

Include if the feature carries a trust boundary, privilege/escalation vector, new data flow,
child-process isolation, prompt-injection surface, or symlink/path-resolution logic. Otherwise
delete and fold any safety requirements into §4 as MUST rows.

Each mitigation's `Test(s)` is held to the **same falsifiable bar as a MUST** (§A.6b) and includes
**≥1 negative control** — the guard shown going red on the very failure it mitigates (§A.9
red-then-green). A mitigation whose only test is the happy path is not proven. A mitigation guarded
only by a skippable smoke is tagged **`UNGUARDED-IN-CI`** with the covering manual step named.

| Concern | Severity | Attack/abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| <concern> | Low/Med/High | <how it fails> | <mitigation> | `<testName>`, `negative: <cmd>` |

**Dispatch the canonical planner first (do not self-walk).** For any schema / validator /
security / multi-actor change, dispatch `negative-scenario-planner` on the design **before**
writing this section — it walks the 8-axis attack matrix and reliably surfaces the level-2
(one-branch-only) gaps a solo walk misses. Self-walk is the fallback when no agent matches.

**Path-authority predicates** (`realpath`, `pwd -P`, `resolveRepoRoot`, `lstat`,
`O_NOFOLLOW`, `import.meta.url`/isMain, "is this repo/safe-class"): enumerate the **8-axis
symlink matrix** here before review. Known fail-open traps to put in the matrix:
- `import.meta.url === pathToFileURL(argv[1])` is **fail-OPEN under symlinks** — `import.meta.url`
  is realpath-canonical, `argv[1]` is not; **realpath both sides** (lesson `…16c4`).
- Consume/validate an argv path by **`lstat` before `realpath`** so a symlinked marker can't
  redirect the authority decision (lesson `…937a`).
- `/var`→`/private/var` (macOS) makes shell `$var` ≠ Node-realpath JSON field; use `pwd -P`.
- Carve `.git/` out of any "is this a repo-source write" detector — agent scratch/PR-body
  writes there over-fire path heuristics (model-scratch-I/O lesson).

## §8 Design

<Resolution rules, precedence, edge cases. Prefer a Mermaid sequence/component diagram for
multi-actor or multi-step flows (never ASCII/PlantUML).>

### 8.1 Key types

```js
/**
 * @typedef {Object} <TypeName>
 * @property {string} field — <meaning, allowed values>
 */
// Zero-dep Node ESM. Document discriminated unions and invariants in JSDoc.
```

### 8.2 Key invariants

- <invariant 1 — what must always hold>
- <invariant 2>
- **Cross-platform:** <the one-line cross-OS check — tmpdir/path/no-GNU-flags>.
- **Atomicity:** <if writing shared state — temp + rename; never partial write>.

### 8.3 Resolution / flow

```text
Input → Step 1 → Step 2 → Output
```

## §9 Existing Hook Points

Where this feature integrates with existing code. **Verify line numbers now** (they drift).

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `scripts/<file>.mjs` | L42 | `functionName` does X | Add Y here |

## §10 Slice Ladder

If implemented in multiple slices (the default for RFC work). One slice = one concern = one PR.

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops (do NOT do in this slice) |
|---|---|---|---|---|---|
| `<ID>-S1` | ... | ... | ... | ... | ... |
| `<ID>-S2` | ... | ... | ... | ... | ... |

### 10.1 Dependency graph

```text
S1 ── S2 ── S3
        └── S4
```

Mark hard deps (must land first) vs soft deps (can interleave).

## §11 Cut Order

If context or scope grows, cut in this order (preserves a shippable slice):

1. <first thing to cut>
2. <second thing to cut>

Do **not** cut:

- <non-negotiable 1 — usually a MUST requirement or a security invariant>
- <non-negotiable 2>

## §12 Contracts

For each new/changed function with non-trivial behavior, specify an **exhaustive** state table.
"Exhaustive" means every input-condition combination has a row — gaps are where bugs hide.

### `<functionName>(input) → output`

**Input contract:** <accepted types, structural requirements, what is rejected>
**Output contract:** <return shape — discriminated union, invariants, never-null guarantees>

**State table (exhaustive):**

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. <name> | <exact condition> | <exact output> | <fs/process/none> |
| B. <name> | ... | ... | ... |

**Error codes:**

| Code | Field | Trigger | Fail mode (open/closed) |
|---|---|---|---|
| `<code>` | `<field>` | `<condition>` | **closed** (default for gates) |

For any enforcement/gate logic, state the **fail direction** explicitly: gates fail **closed**
(block on uncertainty). A fail-open path in a gate is a bug, not a default.

## §13 Edge Cases

Seed these rows whenever the listed shape applies — each is a hard-won false-pass class:

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | <empty/missing input> | reject, fail-closed | `<testName>` |
| EC2 | <symlinked path / `/var`→`/private/var` / isMain under symlink> | realpath both sides; gate still fires | `<testName>` |
| EC3 | <concurrent invocation> | atomic (temp+rename); no torn read | `<testName>` |
| EC4 | <partial-write / abort mid-operation> | no state leftovers; recoverable | `<testName>` |
| EC5 | **empty/whitespace identity in a verification diff** | reject — an empty identity compares **equal to itself** across pre/post and silently passes a "nothing else changed" check as verified (lesson `…7c11`); require non-empty post-strip, else degrade to `unverifiable` | `<testName>` |
| EC6 | <validate-then-write ordering> | validation fires **before** the side effect, not after | `negative: <cmd>` |

## §14 Test Case Catalog

Grouped by concern. **Every test name here SHALL appear in the §4 Requirements table** (and
vice-versa — the mapping is bijective for MUST rows).

```text
Group 1: <concern> (<N> tests)
  testName1 — <one-line assertion>
  testName2 — <one-line assertion>

Group 2: <concern> (<N> tests)
  ...
```

Total: <N> tests. Test runner: `<exact command, e.g. node tests/test-<feature>.mjs>`.

> **No aspirational output (§A.2 item 9):** a test/smoke that *prints* "checking X" must *assert* X
> — a descriptive line with no backing assertion is a stub that reads as coverage. Every assertion
> operates on real captured output (return / stdout / exit / written file), never on a constant or a
> string the author typed into a comment/echo (self-fulfilling).

> **Install / hook / gate behavior is proven by a mock-project E2E, never by mental-trace
> (mock-project lesson).** For any "is this registration stale / global-vs-project / would
> the gate block" question, the test is an **isolated-`HOME` mock project + the REAL
> `install.mjs`**, then read the actual `settings.json` it writes and drive the real deployed
> hook. Do not reason from reading `install.mjs`. Idealized two-step sims drop what live E2E
> catches (model-scratch-I/O lesson).

## §15 Verification Ledger (verify by artifact)

Every claim of completeness is backed by a command + its observed output. Fill the right
column with the **actual** output at implementation time, not the expected output.

**Two hard rules (lessons `…7918`, verify-before-conclude):**
1. **Order rule.** The conclusion comes *after* the artifact. The tool call that produces the
   evidence runs immediately before the claim — never claim first and verify on cue.
2. **Verify the strong claim, not the proxy layer one short of it.** Name the strongest form
   of the claim and confirm you hit *that* layer:
   - "E2E" = drive the **real deployed gate/hook** (e.g. `runHook stop-gate.sh` against a
     mock project), **not** the engine CLI token that the hook happens to call.
   - "deploys clean" = an **unfiltered clean-install audit** (`tools/deploy-audit.mjs`),
     **never** `diff | grep differ` — a filtered/manifest check is structurally blind to
     stale orphans and non-`.mjs` classes (lesson `…540d`).
   - "reviewed" = per-artifact **and** cross-file **and** PR-level (see §19), not diff-only.

| Claim | Command (the strong-layer one) | Observed artifact |
|---|---|---|
| All tests pass | `node tests/test-<feature>.mjs` | `<N>/<N> pass` |
| Gate/hook behaves (E2E) | mock-project `runHook <gate>.sh` (real deployed hook) | `<BLOCK/ALLOW as expected>` |
| Deploys clean (if hooks/scripts/patterns touched) | `node tools/deploy-audit.mjs` (unfiltered) | `<clean / drift list>` |
| Invariant holds | `<broad-token grep proving the boundary>` | `<result>` |
| Merged | `gh pr view <n> --json state,mergeCommit` | `<commit>` |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| <risk> | Low/Med/High | Low/Med/High | <mitigation> |

## §17 Open Decisions

Decisions deferred to a later slice. Each entry: decision, deferral slice, rationale, and the
tracking issue (deferred items get a GitHub issue — Rule 18 / step 9).

- **<decision>** → deferred to `<slice>`; rationale: <…>; tracked in `#<issue>`.

**Every DEFER carries all 5 fields** (a one-line "impact = minimal" does NOT satisfy step 9):

| Field | Question | Artifact required |
|---|---|---|
| 1. Run the scenario | Does the failure actually happen as described? | repro transcript / exit code / test name |
| 2. Spec check | Does the spec/RFC require this be enforced? If yes — **no defer**. | cite spec:line / R-number |
| 3. History check | Has a reviewer caught this axis before? | episode IDs |
| 4. Same-class check | Defer for member M of class C → are siblings deferred too, and left vulnerable? | class enumeration + per-member decision |
| 5. Residual-risk | If the deferred case fires, what fails — graceful or silent corruption? Recovery path? | 1–2 sentences |

## §18 Done Criteria

All MUST requirements passing = done. List any completion conditions beyond the §4 table:

- [ ] <condition 1 — verifiable>
- [ ] <condition 2>
- [ ] Every deferred finding has an issue/comment/violation artifact (Rule 18 step 9).

## §19 Review Consensus (Rule 18)

Second-opinion review via the harness (provider = `claude-subagent`, **not** codex):

```bash
node scripts/second-opinion.mjs request --provider claude-subagent --project . \
  --storage episodic --body-file <plan.md> --summary "<plan title> review" --dispatch
```

| Pass | Reviewer | Provider/Model | Blocker count | Verdict (ACCEPT/HOLD/REJECT) | Reply episode |
|---|---|---|---|---|---|
| 1 | <agent> | claude-subagent | <N> | <verdict> | `<episode-id>` |
| 2 | ... | ... | ... | ... | ... |

### 19.1 Resolved blockers

| # | Blocker (cite R-number) | Verdict (ACCEPT/MODIFY/REJECT/DEFER) | Resolution + evidence |
|---|---|---|---|
| 1 | <description> | <verdict> | <resolution; cite artifact> |

**Review in three layers — they catch different bug classes (lesson `…7918`, compound-review):**
per-artifact (each file) → cross-file (interactions) → **PR-level** (whole-diff coherence,
cross-doc drift). Diff-only review is the proxy layer; do not stop there.

**Hand off the complete bug-class, not one bypass spelling** (handoff-complete-bug-class):
the review body gives the reviewer the invariant + the input matrix + false-positive controls
+ the refactor boundary — not a single failing example.

**Stopping rule (lesson `…a2aa`).** Cap at 2 review rounds. A 3rd HOLD on the **same class** =
the patch boundary is wrong → change the enforcement boundary / design, don't iterate the
patch spelling. If a residual class boundary genuinely needs a tool you don't have (e.g. a
real lexer to mirror bash lexing rather than spellings), **accept + document the residual**
explicitly here and stop — don't chase narrower regexes that each produce a new false-pass.

## §20 Lessons Encoded (traceability — do not re-learn)

Each row is a hard-won lesson from this project's episodic memory, mapped to the section that
enforces it. When updating this template, keep this table in sync — a lesson with no enforcing
section is documentation that rots; a section is the durable form.

| Lesson (episode / memory) | One-line rule | Enforced in |
|---|---|---|
| `…7918` verify-the-strong-claim | E2E drives the real deployed hook; review is PR-level; not the proxy layer | §15, §19 |
| `…540d` unfiltered deploy audit | `deploy-audit.mjs`, never `diff \| grep differ`; investigate live consumers before pruning | §15, §A.8 |
| `…2f5d` grep misses wrapped | line-`grep` blind to wrapped occurrences → broad-token grep + reading pass | §A.1 |
| `…16c4` isMain fail-open | `import.meta.url` vs `argv[1]` under symlink → realpath both sides | §7, §13 |
| `…937a` lstat before realpath | `lstat` the argv path before `realpath` so a symlink can't redirect authority | §7 |
| `…7c11` empty-identity diff | empty identity compares equal to itself → reject / degrade to unverifiable | §13 EC5 |
| `…a2aa` mirror lexing not spellings | accept + document residual class boundary; stop iterating narrower regexes | §19 |
| `…04a7`/`…07e1` em-scripts + body-file | use `em_*` for episode ops; `--body-file` for non-trivial bodies | §2 |
| verify-before-conclude | artifact-producing tool call precedes the conclusion (order rule) | §15 |
| canonical-agent dispatch | dispatch `negative-scenario-planner` before self-walking | §7 |
| bp1 step-9 5-field DEFER | every DEFER carries all 5 fields + an issue/comment/violation | §17, §18 |
| handoff complete bug-class | hand off invariant + matrix + FP controls + boundary, not one spelling | §19 |
| mock-project not mental-trace | install/hook/gate behavior proven by isolated-`HOME` mock + real `install.mjs` | §14 |
| model-scratch-I/O | live E2E over idealized sims; carve `.git/` out of repo-source detectors | §13, §7 |
| compound-bash gate | one command per verify; no `;`/`&&`/pipes/subshells | §A.2, §A.6 |
| Rule 12 token budget | `wc -l` targets, baseline + optimized before presenting | §6 |
| plan symlink-matrix preflight | enumerate the 8-axis symlink matrix in-plan before review | §7 |
| upstream falsifiable-verify | every Verify names observed+expected value and fails on a stub; deny tolerant `test $?` / self-fulfilling grep / happy-path-only | §A.6b, §A.7 |
| `UNGUARDED-IN-CI` tag | a MUST / Safety row whose only cover is a skippable smoke is tagged + names the manual step (no hollow green) | §4, §7 |
| no-aspirational-output | a printed "checking X" is backed by an assertion that performs X; assertions use real captured output | §A.2, §14 |
| one-file-per-step + CREATE/EDIT/APPEND | one editable file per step; anchored smallest-diff EDIT; whole-file Write only for CREATE | §A.2, §A.6, §A.7 |
| red-then-green / blast-radius | guard proven RED on broken input; pure-extraction first; thin-wrapper; fixture-change ledger; discriminating sentinel | §A.9 |

---

# Appendix A: Mechanical Execution Spec (for a low-capability executor)

Include this appendix whenever the plan **may** be implemented by a lower-capability model with
limited reasoning (a cheaper sub-agent), a fresh-context executor, or a human unfamiliar with
the code. Its job is to **remove every design decision from the build path**: exact signatures,
exact edit anchors, exact literal changes, and a verify command per step. If the plan will only
ever be implemented by a high-capability model that shares this context, you MAY delete this
appendix — but prefer keeping it.

## A.1 Forbidden-phrase lint (run before marking the plan ready)

The plan is **not** executor-ready if any step contains: `decide`, `choose`, `figure out`,
`as appropriate`, `if needed`, `handle accordingly`, `etc.`, `and so on`, `TBD`, `should
probably`, `something like`, `or similar`. Resolve each into a concrete action.

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" <this-plan>.md
```

Expected result for a ready plan: **no matches inside Appendix A step tables.**

> **Caveat (lesson `…2f5d`):** line-based `grep -n` structurally **misses line-wrapped
> occurrences** in prose/markdown — "as\nappropriate" split across two lines won't match.
> The grep is a first pass, not a proof. For a clean bill, also do a **reading pass** over
> Appendix A, or run the grep on a reflowed copy (`fmt -w 9999` / unwrap). Treat the same
> blind spot for any grep-based completeness check elsewhere in this plan (§A.6 anchor greps,
> §15 invariant greps): single-token broad greps and a reading pass, not phrase-anchored
> line greps.

## A.2 Executor contract (copy verbatim into the handoff)

1. Do the steps **in numeric order**. Do not skip, reorder, or batch.
2. Each step names exactly which file, the exact change, and how to verify it.
3. **Make no design decisions.** If a step is ambiguous, or the anchor text is not found
   **verbatim**, **STOP and ask** (§A.3) — do not guess, invent, or pick "the closest match".
4. Run the verify command after each step. If it fails, fix **only that step**; do not proceed
   until it is green.
5. **Edit exactly ONE file per step** — the single file named in that step's `File` column. If a
   change spans two files (e.g. a function *and* its test), split it into two consecutive numbered
   steps, one file each. Read-only references (look, never edit): `<list>`.
6. Run no command outside the per-step verify commands and the slice test command. **Each
   verify command is a single command** — no `;`, `&&`, `||`, pipes, or subshells (this
   repo's `compound-bash-gate` hard-blocks them; limit output with Read/Grep, not `cmd | head`).
7. One slice = one commit, message `<ID>-<n>: <slice title>`, ending with the required
   `Co-Authored-By` trailer for the active tool.
8. Do not commit, push, or open a PR unless the plan's §18 Done Criteria for the slice are
   green **and** the human has approved.
9. **No aspirational output.** Every human-readable string a step emits that *describes a check*
   (an `echo`/`log` line, a comment, a heredoc banner) MUST be backed by an assertion that actually
   performs that check. A descriptive line with no backing assertion is a bug — it makes a stub read
   as coverage. If you cannot assert it, do not announce it.

## A.3 STOP-and-ask protocol

When a step is ambiguous or an anchor is missing, emit exactly this and halt:

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous instruction | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <actual surrounding text, ±3 lines>
Question: <the single decision the plan owner must make>
```

Do not continue to step `<n.(m+1)>` until answered.

## A.4 Pre-flight environment check (step 0 of every slice)

Before the first edit, confirm the executor is in the right state. All must pass or STOP.

| Check | Command | Expected |
|---|---|---|
| On the right branch | `git branch --show-current` | `<feature/branch>` |
| Clean tree | `git status --porcelain` | empty |
| Tests green at baseline | `<slice test command>` | `<N>/<N> pass` |
| Node available | `node --version` | `v<x>` or higher |

## A.5 Shared constants / types (add once, before per-slice steps)

```js
// Exact constants/types the steps below reference, with real values — no placeholders.
// Example:
//   export const ENFORCE_CONFIG_NAME = 'enforce-config.json';
//   export const SEED_FLAG = 'wx'; // create-if-absent, never overwrite
```

## A.6 Anchor format (how to read the "Exact action" column)

- **Add fn** — `Add exported fnName(args): RetType to <file> after the line matching ANCHOR.`
- **ANCHOR:** a verbatim, unique substring already present in the file. If it is not unique or
  not present, STOP (§A.3). Never anchor on a line number alone — line numbers drift.
- **Literal change** — spell out exact error strings, field names, numeric bounds, and regex.
  `"throw new Error('enforce-config.json: malformed JSON')"`, not `"throw an error"`.
- **Delete/replace** — quote the exact `old_string` and exact `new_string`.

**Three action kinds — label every §A.7 step with its kind:**
- **CREATE** — whole-file `Write` of a brand-new file (its own step). The **only** place a whole-file
  write is allowed.
- **EDIT** — anchored `ANCHOR → REPLACE` on existing content: change only that span. Never rewrite a
  whole function, never reflow/reformat untouched lines, never `Write`-overwrite an existing file. If
  the `ANCHOR` is not found verbatim, STOP (§A.3) — do not pick a "close enough" location.
- **APPEND** — add a new export/block at end of a file (surgical: adds, changes nothing existing) —
  for new functions/types, including additions to a file you `CREATE`-d earlier in the same slice.

## A.6b Falsifiable Verify (the rule that makes every step's Verify bite)

A low-capability executor reliably produces the **weakest artifact its Verify command will
accept.** So every step's Verify MUST **fail if the step's intent is absent or stubbed** — and that
property must be visible *in the command itself*, not asserted in prose. Every other rule here (the
§A.7 verify cells, the §A.9 red-then-green pattern, the §A.2 no-aspirational-output item, the §4/§7
falsifiable-test bar) is an instance of this one rule. Satisfy the parent, not just the cheapest child.

**Verify deny-list — any of these in a Verify cell is a planning bug:**
- tests only the exit code with a tolerant comparison (`test $? -ne 1`, `|| true`, `&& echo ok`) —
  a no-op passes it;
- greps for a literal string the step *itself* writes into a comment, `echo`, or heredoc
  (self-fulfilling — it proves only that the author can type);
- runs the unit on the happy path **only**, with no negative control proving it can fail
  (see §A.9 red-then-green);
- for a **MUST** requirement or a **§7 Safety** mitigation, is a manual or `command -v …`-skippable
  smoke with no `UNGUARDED-IN-CI` tag (see §4 / §7).

**Positive obligation:** every Verify names (a) the **observed value** it inspects — captured
stdout / exit code / written-file contents / imported-function return — and (b) the **expected
concrete value** it compares against. "Exits 0" / "script runs" names no value and fails the gate.
This is greppable: a lint over the plan's Verify cells that finds no capture-and-compare flags the
row as not-executor-ready.

> **Compound-bash caveat (this repo):** a Verify is **one command** — no `;`/`&&`/`||`/pipes/subshells
> (`compound-bash-gate` hard-blocks them). Express a negative control as a single command the broken
> input drives to non-zero (e.g. `BREAK_REPO_SOURCE=1 node tests/test-x.mjs`), run as its **own row**
> immediately before the green run — never chained with `;`.

## A.7 Per-slice step tables

Repeat one sub-table per slice. Every step MUST have: (a) **exactly one** named editable file,
(b) its **action kind** (`CREATE` / `EDIT` / `APPEND`, §A.6), (c) an exact signature or verbatim
`ANCHOR`, (d) the exact change (error strings, field names, bounds spelled out), and (e) a runnable
**falsifiable** verify command (§A.6b) that fails on a stubbed/broken implementation.

**Test steps get the same rigor as code steps.** A step that `CREATE`s a test/smoke MUST give its
**full verbatim contents including every literal assertion** — "assert (a)/(b)/(c)" prose is a hidden
"how?" decision and fails the gate. Each assertion's operands must include the **actual observed
output** of the unit under test (captured stdout/stderr, exit code, written-file contents, or an
imported return) — never a constant, and never a string the step author wrote into a comment/echo
(self-fulfilling). `assert(true)`, or `assert(x)` where `x` is a hardcoded literal, does not satisfy this.

**Executor-ready gate (the plan author MUST pass this before handoff):** every step's `File` column
names exactly one file; every `EDIT` quotes a verbatim `ANCHOR` + exact `REPLACE` (smallest diff, no
reformatting of untouched lines); whole-file `Write` appears only in `CREATE` steps; no step text
contains a §0.2 forbidden phrase or — as a *description of intent* — "assert that", "verify that",
"check that", or "ensure"; every constant, error string, regex, and signature appears verbatim (here
or in §A.5); every Verify passes §A.6b. A step that would touch a second file, rewrite a whole
function, `Write`-overwrite an existing file, or ship a Verify a no-op would pass is a planning bug —
split, re-anchor, or strengthen it.

### `<SLICE-ID>` — `<slice title>` (REQ-x / REQ-y)

**Files this slice may touch:** `<path1>`, `<path2-test>`. **Read-only:** `<path3>`.

| Step | File | Kind | Exact action (anchor + literal change) | Verify (observed → expected; falsifiable, §A.6b) |
|---|---|---|---|---|
| n.0 | — | — | Pre-flight §A.4. | every row passes |
| n.1 | `scripts/<file>.mjs` | **APPEND** | Add exported `fnName(args): RetType` at end of file. Body: `<exact behavior incl. exact error strings + return shape>`. (Adds only; changes nothing existing.) | `grep -n 'export function fnName' scripts/<file>.mjs` → 1 match |
| n.2 | `scripts/<other>.mjs` | **EDIT** | `ANCHOR:` `<verbatim current line>` → `REPLACE:` `<exact new line(s)>`. Smallest diff; touch nothing else. | `<grep/test naming the observed + expected value>` |
| n.3 | `tests/test-<feature>.mjs` | **CREATE** | Full verbatim contents. `testName`: arrange `<exact input, with a unique sentinel where a value must flow through>`, act `<call the REAL entry>`, assert the captured return/stdout/exit **carries that sentinel** (never "non-empty"); include the §A.9 negative control. Register in `main()`. | `node tests/test-<feature>.mjs` → `<N>/<N> pass`; **and** the broken-input row exits non-zero |
| n.4 | — | — | Commit: `<ID>-n: <title>` + `Co-Authored-By` trailer. | `git log -1 --oneline` → shows `<ID>-n` |

## A.8 Definition of done (whole plan, mechanical)

The slice/plan is done **only** when all of these print the expected result:

```bash
<exact test command>        # → all <N> tests passing
<load/smoke command>        # → succeeds, exit 0
<invariant grep>            # → proves the security/contract boundary holds
node tools/deploy-audit.mjs # → clean (only if hooks/scripts/patterns were touched)
```

No step is "done by inspection". Each line above produces an artifact pasted into §15.

## A.9 Blast-radius patterns (apply when authoring §A.7 steps)

Keep the diff small and the existing suite green — these are hard-won from real slices in this repo.

- **Red-then-green guard (negative control).** A step that adds a guard/regression for behavior X
  MUST prove the guard goes **RED** when X is broken — *a guard never observed failing guards
  nothing.* Discharge it as a Verify row whose broken input is reachable from the command (env/arg),
  e.g. `BREAK_REPO_SOURCE=1 node tests/test-x.mjs` → exits non-zero, run immediately before the
  normal green run. The break is inline (env/arg), never a fixture file you add then remove (that
  fights one-file / one-commit). One command per row — never `;`-chained (§A.6b caveat).
- **Pure-extraction slice first.** When new wiring needs a function carved out of a gate / security
  path, do the **pure extraction as its own slice** (zero behavior change, existing tests green)
  *before* the slice that adds new callers — exactly how P3a / P3b-1 landed.
- **Thin wrapper over refactor.** To reuse a private function, **APPEND a thin exported wrapper**
  that calls it; do not restructure the original. `export function fooPublic(x){ return foo(x) }` is
  zero-blast; extracting a shared core out of `foo` is not.
- **Fixture-change ledger.** If a step *necessarily* changes behavior covered by existing tests, it
  MUST enumerate the exact assertions it edits (`file:line`, before → after) as its own anchored
  steps. Never write "existing tests stay green" for a step that changes their contract — enumerate
  the edits. (This is the unmask that bit the ESC cross-session harness: one stale lib-missing block
  masked X1/X12 fails **and** X2/X3 spurious-passes at the same time.)
- **Discriminating fixture / sentinel.** A guard's **positive** input must differ *observably* from
  its **negative** control in the exact dimension under test, and the assertion must inspect that
  dimension. Inject a unique sentinel (e.g. `SENTINEL_a1b2c3`) and assert the output carries **that
  token** — not "non-empty" or "exit 0". An empty / `/dev/null` / default fixture *for the value
  under test* makes the positive case indistinguishable from the negative, so even a perfect
  assertion proves nothing.
- **Flag high-blast-radius slices.** A slice that changes shared/broad behavior (a gate sourced by
  many callers, the classifier, an argv builder) is marked **"focused review before build"** in its
  §A.7 heading even when fully specified — the spec removes ambiguity, not the need for a human look.
- **Mock-project E2E for install/hook/gate behavior** (standing repo rule). Drive the REAL deployed
  hook via `runHook` against an isolated-`HOME` mock + real `install.mjs`; never mental-trace, never
  stub (cross-links §14).
- **Non-deterministic guard (rare).** If a guard's signal depends on non-deterministic behavior (an
  LLM reply via second-opinion, a race, wall-clock), a green run on one machine does not prove it.
  Assert at the most deterministic observable that **actually exists** — a structured event, an exit
  code, a log line emitted by the *code* (not the model); confirm the channel exists, don't presume
  it. If behavioral compliance is unavoidable: when the flaky signal is only the *read-out* of a
  deterministic property, **retry-to-observe** (pass if it appears ≥1 of N — a broken property never
  appears in any attempt); when the non-determinism **is** the property under test, **never
  retry-to-green** (that re-rolls the thing you measure) — run a fixed N and assert a rate (≥k of N),
  reporting the observed rate. Either way, if it still varies beyond threshold, tag `UNGUARDED-IN-CI`
  with the residual + the manual check.
