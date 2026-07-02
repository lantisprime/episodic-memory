# PT-FIX PLAN_TEMPLATE.md consistency + cross-language Appendix A Plan (v3)

## §1 Status

`Planning only.` Current stage: **findings-open → review complete, awaiting user approval** (codex r1 HOLD 7 findings → fixed; r2 HOLD 3 → fixed; r3 HOLD 2 bookkeeping → fixed; r4 = **ACCEPT, zero findings**).

| Field | Value |
|---|---|
| RFC | n/a (docs/template maintenance) |
| Parent requirements | n/a; findings F1..F10 in §4 are the ground truth |
| Workplan episode | n/a (user-directed one-off) |
| Target branch | `docs/plan-template-consistency` (created by step 1.0b; checkout is on `main` at handoff) |
| Executor altitude (§0.1) | low |

**Execution root (binding for every command in this plan):** all commands, greps, and relative
paths run from the repo root, pinned by pre-flight rows 1 and 2: `pwd -P` must print
`/Users/charltondho/Developer/projects/episodic-memory` (this rejects nested cwd, which
`git rev-parse --show-toplevel` alone does not, codex r2 finding 3) and
`git rev-parse --show-toplevel` must print the same path. If either does not, STOP (§A.3).

## §2 Episode Search Summary

Session-start lesson recall ran (10 lessons, 2026-07-01 and earlier). Constraints that bind this plan:

- `feedback_plan_template_first`: default altitude LOW; full mechanical appendix. Applied below.
- Standing directive 2026-06-28 (`feedback_use_claude_subagent_not_codex`, reversed): adversarial review default provider is codex; claude-subagent is fallback. Drives F4.
- `feedback_cross_platform_always`: no POSIX-only assumptions in portable instructions. Drives F9.
- `feedback_avoid_compound_bash`: one command per verify. Drives F5.
- codex r1 lesson class (cwd-authority): relative paths bind to caller cwd; pin the root explicitly. Applied in §1 and §A.4.

## §3 Objective

`docs/PLAN_TEMPLATE.md` contains stale internal cross-references, one directive contradicting a
standing user rule, two places where Appendix A violates its own rules, and Node/POSIX-specific
wording that prevents Appendix A from being instantiated for a repo in another language. After
this change: every internal reference resolves, Appendix A obeys its own §A.6b/§A.2 rules, and
Appendix A is instantiable for any target language via a new fill-once §A.0 toolchain table,
provable by the §15 grep ledger run from the repo root.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Finding | Test(s) | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | §0.1 references "Appendix A" in all 3 places (table header, low-capability row, when-in-doubt sentence). The line-17 upstream-origin mention of upstream's Appendix B stays. | F1 | `manual: grep -c "Appendix B" docs/PLAN_TEMPLATE.md` → `1` | MUST | lines 29, 32, 35 today |
| REQ-2 | §0.1 required-sections column says `§1–§20` in all three executor rows; no `§1–§14` remains. | F2 | `manual: grep -c "§1–§14" docs/PLAN_TEMPLATE.md` → `0` | MUST | §15/§18/§19 are load-bearing for every executor |
| REQ-3 | §0.1 human-contributor row cites `§9 Existing Hook Points` (today: §11, which is Cut Order). | F3 | `manual: grep -c "§11 Existing" docs/PLAN_TEMPLATE.md` → `0` | MUST | |
| REQ-4 | §19 names codex as default second-opinion provider with claude-subagent as in-session-flake fallback; the example command uses `--provider codex` with an absolute `--project` root; the example table row says codex. | F4 | `manual: grep -c "request --provider codex" docs/PLAN_TEMPLATE.md` → `1`; `manual: grep -c "provider claude-subagent" docs/PLAN_TEMPLATE.md` → `0` | MUST | aligns with standing directive 2026-06-28 |
| REQ-5 | §A.7 example table shows the negative control as its own numbered row with its own single-command Verify; no Verify cell chains two checks with "; **and**". | F5 | `manual: grep -c "the broken-input row exits non-zero" docs/PLAN_TEMPLATE.md` → `0`; `manual: grep -c "n.3b" docs/PLAN_TEMPLATE.md` → `1` | MUST | template must obey its own §A.6b caveat |
| REQ-6 | §A.1's acceptance rule is mechanically auditable by a low-capability executor: it states matches WILL occur in template prose and requires a listed line-number disposition per match, scoped to §A.5 blocks and §A.7 step-table rows. (v1 overstated this as "undischargeable"; the current text already scopes to step tables but gives no mechanical discharge procedure.) | F6 | `manual: grep -c "no matches inside Appendix A" docs/PLAN_TEMPLATE.md` → `0` | MUST | codex r1 finding 7 applied |
| REQ-7 | `em_*` is spelled `em-*` in §2 and §20 (actual script names: `em-search.mjs` etc.). | F7 | `manual: grep -c 'em_\*' docs/PLAN_TEMPLATE.md` → `0` | SHOULD | |
| REQ-8 | §0.1 altitude table: high-capability = Opus/Fable-class explicitly named by the user; Sonnet/Haiku-class and below = low-capability; a "Default = low." sentence exists in §0.1. | F8 | `manual: grep -c "Default = low" docs/PLAN_TEMPLATE.md` → `1`; `manual: grep -c "Opus/Sonnet-class" docs/PLAN_TEMPLATE.md` → `0` | MUST | encodes the locked user rule into the template |
| REQ-9 | Appendix A is target-language-parameterized: new §A.0 toolchain table (runtime check, test-runner shape, new-function phrasing, portable break-input override, search tool, repo-specific done-commands); §A.4 runtime row, §A.5 heading + comment, §A.6 Add-fn wording, §A.6b env-prefix caveat, §A.9 red-then-green example, and §A.8 deploy-audit line all reference §A.0; §A.0 explicitly marks §14/§15 example commands as this-repo instantiations; the pseudocode rule is stated verbatim. | F9 | `manual: grep -c "Pseudocode is NOT sufficient" docs/PLAN_TEMPLATE.md` → `1`; `manual: grep -c "§A.0" docs/PLAN_TEMPLATE.md` → `≥7`; `manual: grep -c "| Node available |" docs/PLAN_TEMPLATE.md` → `0` | MUST | scope extended per codex r1 finding 4 |
| REQ-10 | §A.6b no longer asserts a nonexistent lint; the sentence states a by-hand author obligation. | F10 | `manual: grep -c "This is greppable" docs/PLAN_TEMPLATE.md` → `0` | SHOULD | |

All tests are static greps on a deterministic text file run from the repo root; grep is the
strongest available verification layer for a docs-only change, so `manual:` here is not a
CI-skippable proxy hiding a stronger layer.

## §5 Non-Goals

- No change to upstream `pi-extensions/agents/PLAN_TEMPLATE.md`.
- No change to hooks, scripts, or the enforcement layer.
- No retro-editing of existing plan documents in `docs/plans/`.
- No new CI check in this slice (§17 defers a phrase-list-sync lint with an issue).
- §14/§15 example commands stay as this-repo Node examples, explicitly labeled as §A.0 instantiations (justified: the ledger examples are illustrations of the artifact discipline, not executor instructions; relabeling is sufficient, rewriting them language-neutral would strip the working examples).

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `docs/PLAN_TEMPLATE.md` | 655 | ~3.3k | ~5k (anchored edits + §A.0 block) | single file touched |

**Baseline (single session):** ~38k overhead + 3.3k read + 5k writes + 2 review rounds ~30k + verify greps ~2k ≈ **78k tokens.** One session, one PR.

## §7 Safety / Security

Deleted: no trust boundary, data flow, or path-resolution logic (docs-only). No `negative-scenario-planner` dispatch: no schema/validator/security/multi-actor surface.

## §8 Design

Single-file docs edit. One design decision, resolved here so the appendix carries none:

**Cross-language mechanism = parameterization, not pseudocode.** A low-capability executor may
make no design decisions (§A.2 item 3). Translating pseudocode into a concrete language IS a
design decision (naming, error types, idiom). Therefore three layers:

- **Procedural** (executor contract, STOP protocol, anchor semantics, falsifiable-verify rule, blast-radius patterns): language-agnostic prose rules, unchanged in kind.
- **Toolchain** (runtime check, test command shape, function-declaration phrasing, portable break-input spelling): moves into a fill-once §A.0 table that §A.4/§A.5/§A.6/§A.6b/§A.8/§A.9 reference.
- **Payload** (§A.7 Exact-action cells, §A.5 constants): verbatim code in the repo's language, always.

Verdict on "is pseudocode style enough": **no for §A.7 step tables; yes only for §8-level design
narrative.** This ruling is written into the template (REQ-9 blockquote).

### 8.2 Key invariants

- Every §20 lessons-table row keeps an enforcing section (A.0 is additive; A.1–A.9 keep their numbers).
- **Cross-platform:** §A.0 marks `VAR=x cmd` as POSIX-shell-only and requires an argv-flag or language-native alternative when the repo targets Windows.
- All internal §-references resolve to real headings (REQ-2/REQ-3 greps + reading pass).
- All plan commands run from the pinned repo root (§1 execution root).

## §9 Existing Hook Points

Line numbers verified 2026-07-02 against the current file.

| File | Line(s) | What it is today | Finding |
|---|---|---|---|
| `docs/PLAN_TEMPLATE.md` | 29, 32, 35 | "Appendix B" refs | F1 |
| `docs/PLAN_TEMPLATE.md` | 31–33 | altitude table: `§1–§14`, `§11 Existing`, Sonnet-as-high | F2, F3, F8 |
| `docs/PLAN_TEMPLATE.md` | 90, 413 | `em_*` | F7 |
| `docs/PLAN_TEMPLATE.md` | 366–375 | claude-subagent-not-codex directive + command + table cell | F4 |
| `docs/PLAN_TEMPLATE.md` | 450 | A.1 expected-result line | F6 |
| `docs/PLAN_TEMPLATE.md` | 507 (§A.4), 509–511 (§A.5), 519 (§A.6), 560–563 (§A.6b caveat) | Node/POSIX-hardcoded | F9 |
| `docs/PLAN_TEMPLATE.md` | 555–557 | "This is greppable: a lint…" | F10 |
| `docs/PLAN_TEMPLATE.md` | 597 | §A.7 example n.3 chained Verify | F5 |
| `docs/PLAN_TEMPLATE.md` | 608 | `node tools/deploy-audit.mjs` in §A.8 | F9 (r1 finding 4) |
| `docs/PLAN_TEMPLATE.md` | 619–620 | `BREAK_REPO_SOURCE=1 node tests/test-x.mjs` in §A.9 | F9 (r1 finding 4) |

Note: the string `BREAK_REPO_SOURCE=1 node tests/test-x.mjs` appears twice (§A.6b line 562, §A.9
line 620); §A.7 anchors for those steps therefore include surrounding text to be unique.

## §10 Slice Ladder

One slice, one PR (docs-only, one concern: template self-consistency + cross-language appendix).

| Slice | Objective | Primary files | Deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| PT-FIX-S1 | Fix F1–F10 in one pass | `docs/PLAN_TEMPLATE.md` | edited template | §15 grep ledger | Do NOT touch any other doc, hook, or script |

## §11 Cut Order

1. F10 (SHOULD, cosmetic). 2. F7 (SHOULD, naming).

Do not cut: F1–F6, F8, F9 (MUST; F9 is the request's core).

## §12 Contracts

No functions changed. The documentary contract: after the edit, an executor reading Appendix A
plus a filled §A.0 table has zero language-specific gaps in the procedural layer. Verified by the
§15 reading-pass row.

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | "Appendix B" grep also matches the legitimate upstream-origin sentence (line 17) | ledger expects exactly `1`, not `0` | REQ-1 grep |
| EC2 | §20 lesson rows cite §A.x sections | A.0 is additive, A.1–A.9 unrenumbered; no §20 row breaks | reading pass |
| EC3 | `claude-subagent` must survive as the named FALLBACK in §19 prose | negative grep targets the exact stale spellings (`request --provider claude-subagent`, `\| claude-subagent \|`), not the bare word | REQ-4 greps |
| EC4 | duplicate `BREAK_REPO_SOURCE=1` string (§A.6b vs §A.9) | anchors include surrounding text; executor STOPs if an anchor matches ≠ 1 time | §A.7 steps 1.17/1.18 |
| EC5 | executor invoked outside the repo root | pre-flight row 1 fails → STOP before any edit | §A.4 |

## §14 Test Case Catalog

No automated test file (docs-only). The catalog is the §4 Test(s) column plus the §15 negative
greps, executed one command per Bash invocation (compound-bash gate) from the repo root and pasted
into §15 at implementation time.

## §15 Verification Ledger (fill at implementation time; all from repo root)

| Claim | Command | Expected |
|---|---|---|
| F1 fixed | `grep -c "Appendix B" docs/PLAN_TEMPLATE.md` | `1` |
| F2 fixed | `grep -c "§1–§14" docs/PLAN_TEMPLATE.md` | `0` |
| F3 fixed | `grep -c "§11 Existing" docs/PLAN_TEMPLATE.md` | `0` |
| F4 fixed (command) | `grep -c "request --provider codex" docs/PLAN_TEMPLATE.md` | `1` |
| F4 no stale command | `grep -c "request --provider claude-subagent" docs/PLAN_TEMPLATE.md` | `0` |
| F4 no stale table cell | `grep -c "| claude-subagent |" docs/PLAN_TEMPLATE.md` | `0` |
| F5 fixed | `grep -c "the broken-input row exits non-zero" docs/PLAN_TEMPLATE.md` | `0` |
| F5 new row present | `grep -c "n.3b" docs/PLAN_TEMPLATE.md` | `1` |
| F6 fixed | `grep -c "no matches inside Appendix A" docs/PLAN_TEMPLATE.md` | `0` |
| F7 fixed | `grep -c 'em_\*' docs/PLAN_TEMPLATE.md` | `0` |
| F8 default-low present | `grep -c "Default = low" docs/PLAN_TEMPLATE.md` | `1` |
| F8 Sonnet demoted | `grep -c "Opus/Sonnet-class" docs/PLAN_TEMPLATE.md` | `0` |
| F9 pseudocode rule | `grep -c "Pseudocode is NOT sufficient" docs/PLAN_TEMPLATE.md` | `1` |
| F9 A.4 row parameterized | `grep -c "| Node available |" docs/PLAN_TEMPLATE.md` | `0` |
| F9 A.6b/A.9/A.0 linked | `grep -ci "break-input override" docs/PLAN_TEMPLATE.md` | `≥4` (case-insensitive; §A.0 key row capitalized) |
| F9 A.8 labeled | `grep -ci "repo-specific done-commands" docs/PLAN_TEMPLATE.md` | `2` |
| F10 fixed | `grep -c "This is greppable" docs/PLAN_TEMPLATE.md` | `0` |
| No orphaned §-refs | reading pass over §0 and §20 tables | all refs resolve |

**Observed at implementation, 2026-07-02:** all 17 grep rows returned their expected values
verbatim (F1 `1`; F2 `0`; F3 `0`; F4 `1`/`0`/`0`; F5 `0`/`1`; F6 `0`; F7 `0`; F8 `1`/`0`;
F9 `1` / `§A.0`=`8` / `0` / ci `5` / ci `2`; F10 `0`). Reading pass: §0.1 rows now cite
`§1–§20`, `§9 Existing Hook Points` (heading confirmed at line 205), `Appendix A`; §20 rows all
cite surviving sections (A.0 additive, A.1–A.9 unrenumbered). `git diff --stat` =
`docs/PLAN_TEMPLATE.md | 78 +++/---` only.

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| §A.0 block bloats the appendix | Med | Med | one table + one blockquote + one caveat paragraph; other edits are wording-level |
| Renumbering breaks §20 anchors | Med | Low | A.0 additive; A.1–A.9 keep numbers (EC2) |
| Provider directive reverses again | Low | Med | §19 wording cites "standing directive" + fallback rule, not an absolute |
| Anchor collision on duplicate strings | Med | Low | EC4: anchors carry surrounding text; STOP on non-unique match |

## §17 Open Decisions

- **CI lint for §0.2/§A.1 phrase-list sync (Rule 13 candidate)** → deferred; GitHub issue filed at wrap-up with the 5 DEFER fields: (1) scenario: phrase lists drifted already (A.1 has 3 phrases §0.2 lacks) with zero runtime impact, repro = diff the two lists; (2) spec: no RFC requires it; (3) history: codex r1 did not flag it as a blocker; (4) same-class: the only other prose/machine dual list in this file is §20 lessons vs sections, same defer; (5) residual risk: future template edits drift the lists further, caught at next manual review; recovery = one-line doc fix.

## §18 Done Criteria

- [ ] All §15 ledger rows show the expected value (pasted outputs).
- [ ] Reading pass confirms no orphaned §-references.
- [ ] latest codex review round = ACCEPT (or the §19 stopping rule applied and the residual documented there).
- [ ] PR opened per Rule 17 (bot comment review; user approves in UI).
- [ ] §17 deferred item has an issue number.

## §19 Review Consensus (Rule 18)

Dispatch (from repo root): harness, `--provider codex`, `--storage episodic`,
`--project /Users/charltondho/Developer/projects/episodic-memory` (absolute per r1 finding 2),
body = review brief + this plan. claude-subagent only on in-session codex flake.

| Pass | Reviewer | Provider | Blockers | Verdict | Reply episode |
|---|---|---|---|---|---|
| 1 | codex | codex | 4 (+3 MAJOR) | HOLD | `20260701-234943-reply-codex-to-20260701-234613-pt-fix-pl-97ad` |
| 2 | codex | codex | 2 (+1 MAJOR) | HOLD | `20260701-235931-reply-codex-to-20260701-235423-pt-fix-pl-70b9` |
| 3 | codex | codex | 0 (2 bookkeeping: stale row count, stale §18 criterion; both fixed) | HOLD | `20260702-000552-reply-codex-to-20260702-000154-pt-fix-pl-5c31` |
| 4 | codex | codex | 0 | **ACCEPT** | `20260702-000815-reply-codex-to-20260702-000636-pt-fix-pl-9888` |

### 19.1 Resolved blockers (round 1)

| # | Blocker | Verdict | Resolution |
|---|---|---|---|
| 1 | anchors not verbatim / bundled / §A.0 not spelled out | ACCEPT | §A.7 v2: one anchor per row, §A.0 block verbatim in step 1.12 |
| 2 | cwd binding unstated | ACCEPT | §1 execution root + §A.4 row 1 `git rev-parse --show-toplevel`; §19 dispatch absolute `--project` |
| 3 | pre-flight unsatisfiable, no recovery | ACCEPT WITH MODIFICATION | step 1.0b creates the branch; clean-tree check scoped to `docs/PLAN_TEMPLATE.md` (repo carries unrelated standing untracked files) |
| 4 | F9 missed §A.8/§A.9/§14/§15 residue | ACCEPT WITH MODIFICATION | §A.9 + §A.8 parameterized (steps 1.17–1.19); §14/§15 covered by §A.0 this-repo-example sentence (§5 justification) |
| 5 | stub-passing verifies | ACCEPT | per-surface negative greps in §15 + per-step discriminating verifies |
| 6 | missing File column | ACCEPT | added in §A.7 |
| 7 | F6 overstated | ACCEPT WITH MODIFICATION | REQ-6 reworded: clarity/mechanical-auditability fix |

### 19.2 Resolved blockers (round 2)

| # | Blocker | Verdict | Resolution |
|---|---|---|---|
| 1 | step 1.21 anchor had added padding, matched 0 times | ACCEPT | anchor re-quoted as the verbatim cell tail, uniqueness via the `; **and**` clause |
| 2 | case-sensitive greps miss capitalized §A.0 keys (counts wrong) | ACCEPT | 1.17/1.18 verifies use phrases unique to their own replacement; 1.19 and §15 use `grep -ci` with recomputed counts |
| 3 | `git rev-parse --show-toplevel` passes from nested cwd | ACCEPT | new §A.4 first row `pwd -P` = repo root; §1 execution-root wording updated |

---

# Appendix A: Mechanical Execution Spec

Executor altitude: low. **One editable file:** `docs/PLAN_TEMPLATE.md`. Read-only: this plan.
Every command runs from the repo root (§1 execution root). Anchors below are verbatim substrings
of the current file; if an anchor is missing or matches more than once, STOP (§A.3).

Notation: in anchor/replace cells, `` ` `` characters inside quoted text are the file's own
backticks; quote the whole cell text exactly as printed.

## A.4 Pre-flight (step 1.0)

| Check | Command | Expected |
|---|---|---|
| Caller cwd IS the repo root | `pwd -P` | `/Users/charltondho/Developer/projects/episodic-memory` |
| Repo root pinned | `git rev-parse --show-toplevel` | `/Users/charltondho/Developer/projects/episodic-memory` |
| Starting branch | `git branch --show-current` | `main` |
| Target file untouched | `git status --porcelain docs/PLAN_TEMPLATE.md` | empty |
| Target file present, 655 lines | `wc -l docs/PLAN_TEMPLATE.md` | `655` |

## A.7 Step table — PT-FIX-S1

All EDIT steps target `docs/PLAN_TEMPLATE.md`. Replace the ANCHOR text with the REPLACE text,
smallest diff, touching nothing else on untouched lines.

| Step | File | Kind | Exact action | Verify (from repo root) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4 (5 rows). | every row prints its Expected value |
| 1.0b | — | — | `git checkout -b docs/plan-template-consistency` | `git branch --show-current` → `docs/plan-template-consistency` |
| 1.1 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `| Executor | Who | Required sections | Appendix B (mechanical spec)? |` REPLACE: `| Executor | Who | Required sections | Appendix A (mechanical spec)? |` | `grep -c "Appendix B (mechanical spec)" docs/PLAN_TEMPLATE.md` → `0` |
| 1.2 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `| **High-capability** | Opus/Sonnet-class model that shares this context, or you | §1–§14 | Optional — may delete |` REPLACE: `| **High-capability** | Opus/Fable-class model, explicitly named by the user as the implementer, sharing this context | §1–§20 | Optional — may delete |` | `grep -c "Opus/Sonnet-class" docs/PLAN_TEMPLATE.md` → `0` |
| 1.3 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `| **Low-capability** | Cheaper/low-effort sub-agent, fresh context, weak reasoning | §1–§14 **and** Appendix B | **Mandatory** — it is the build path |` REPLACE: `| **Low-capability** | Sonnet/Haiku-class or cheaper sub-agent, fresh context, limited reasoning | §1–§20 **and** Appendix A | **Mandatory** — it is the build path |` | `grep -c "§1–§14" docs/PLAN_TEMPLATE.md` → `1` |
| 1.4 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `| **Human contributor** | New maintainer unfamiliar with the code | §1–§14 + §11 Existing Hook Points | Recommended |` REPLACE: `| **Human contributor** | New maintainer unfamiliar with the code | §1–§20 + §9 Existing Hook Points | Recommended |` | `grep -c "§1–§14" docs/PLAN_TEMPLATE.md` → `0` |
| 1.5 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `When in doubt, **write Appendix B**. The cost of an over-specified plan is tokens; the cost` REPLACE: `**Default = low.** Unless the user explicitly names an Opus/Fable-class implementer, write the full appendix (A.0–A.9) with falsifiable verifies. When in doubt, **write Appendix A**. The cost of an over-specified plan is tokens; the cost` | `grep -c "Default = low" docs/PLAN_TEMPLATE.md` → `1` |
| 1.6 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``it (memories are point-in-time). Use the `em_*` scripts for all episode operations (search /`` REPLACE: ``it (memories are point-in-time). Use the `em-*` scripts for all episode operations (search /`` | `grep -c 'em_\*' docs/PLAN_TEMPLATE.md` → `1` |
| 1.7 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``| `…04a7`/`…07e1` em-scripts + body-file | use `em_*` for episode ops; `--body-file` for non-trivial bodies | §2 |`` REPLACE: ``| `…04a7`/`…07e1` em-scripts + body-file | use `em-*` for episode ops; `--body-file` for non-trivial bodies | §2 |`` | `grep -c 'em_\*' docs/PLAN_TEMPLATE.md` → `0` |
| 1.8 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``Second-opinion review via the harness (provider = `claude-subagent`, **not** codex):`` REPLACE: ``Second-opinion review via the harness. Default provider = `codex` (standing directive 2026-06-28: a genuinely different model catches blind spots same-model review shares); fall back to `claude-subagent` only when codex flakes in-session (backgrounds, hangs, null replies):`` | `grep -c "Default provider" docs/PLAN_TEMPLATE.md` → `1` |
| 1.9 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `node scripts/second-opinion.mjs request --provider claude-subagent --project . \` REPLACE: `node scripts/second-opinion.mjs request --provider codex --project <absolute-repo-root> \` | `grep -c "request --provider claude-subagent" docs/PLAN_TEMPLATE.md` → `0` |
| 1.10 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``| 1 | <agent> | claude-subagent | <N> | <verdict> | `<episode-id>` |`` REPLACE: ``| 1 | <agent> | codex | <N> | <verdict> | `<episode-id>` |`` | `grep -c "| claude-subagent |" docs/PLAN_TEMPLATE.md` → `0` |
| 1.11 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `Expected result for a ready plan: **no matches inside Appendix A step tables.**` REPLACE: `Expected result for a ready plan: the grep WILL match template prose (§0.2 and this section quote the phrases). Acceptance rule, mechanically dischargeable: list every match's line number; the plan is ready iff no match falls inside a §A.5 block or a §A.7 step-table row. Record the match list and per-match dispositions beside the lint run.` | `grep -c "no matches inside Appendix A" docs/PLAN_TEMPLATE.md` → `0` |
| 1.12 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `appendix — but prefer keeping it.` REPLACE: the same anchor text, followed by one blank line, followed by the verbatim §A.0 block given below this table. | `grep -c "Pseudocode is NOT sufficient" docs/PLAN_TEMPLATE.md` → `1` |
| 1.13 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``| Node available | `node --version` | `v<x>` or higher |`` REPLACE: ``| Runtime available | `<runtime check from §A.0>` | `<expected value from §A.0>` |`` | `grep -c "| Node available |" docs/PLAN_TEMPLATE.md` → `0` |
| 1.14 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `## A.5 Shared constants / types (add once, before per-slice steps)` REPLACE: `## A.5 Shared constants / types, in the §A.0 target language (add once, before per-slice steps)` | `grep -c "in the §A.0 target language" docs/PLAN_TEMPLATE.md` → `1` |
| 1.15 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `// Exact constants/types the steps below reference, with real values — no placeholders.` REPLACE: `// Written in the repo's language (§A.0). Exact constants/types the steps below reference, with real values — no placeholders. JS example:` | `grep -c "Written in the repo's language" docs/PLAN_TEMPLATE.md` → `1` |
| 1.16 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``- **Add fn** — `Add exported fnName(args): RetType to <file> after the line matching ANCHOR.` `` REPLACE: ``- **Add fn** — `Add a function with this exact signature (per the §A.0 new-function phrasing) to <file> after the line matching ANCHOR.` The name, signature, and visibility are spelled verbatim in the repo's language.`` | `grep -c "§A.0 new-function phrasing" docs/PLAN_TEMPLATE.md` → `1` |
| 1.17 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``> input drives to non-zero (e.g. `BREAK_REPO_SOURCE=1 node tests/test-x.mjs`), run as its **own row**`` REPLACE: ``> input drives to non-zero (the §A.0 portable break-input override; `BREAK_REPO_SOURCE=1 node tests/test-x.mjs` on POSIX, an argv flag where Windows matters), run as its **own row**`` | `grep -c "the §A.0 portable break-input override" docs/PLAN_TEMPLATE.md` → `1` |
| 1.18 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: ``  e.g. `BREAK_REPO_SOURCE=1 node tests/test-x.mjs` → exits non-zero, run immediately before the`` REPLACE: ``  e.g. the §A.0 break-input override (`BREAK_REPO_SOURCE=1 node tests/test-x.mjs` on POSIX) → exits non-zero, run immediately before the`` | `grep -c "e.g. the §A.0 break-input override" docs/PLAN_TEMPLATE.md` → `1` |
| 1.19 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `node tools/deploy-audit.mjs # → clean (only if hooks/scripts/patterns were touched)` REPLACE: `node tools/deploy-audit.mjs # → clean (this repo, per the §A.0 repo-specific done-commands row; only if hooks/scripts/patterns were touched)` | `grep -ci "repo-specific done-commands" docs/PLAN_TEMPLATE.md` → `2` (case-insensitive: §A.0 key row is capitalized, codex r2 finding 2) |
| 1.20 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR: `This is greppable: a lint over the plan's Verify cells that finds no capture-and-compare flags the` REPLACE: `Author obligation, discharged by hand until a lint exists: scan every Verify cell; any cell missing either the observed value or the expected value marks the` | `grep -c "This is greppable" docs/PLAN_TEMPLATE.md` → `0` |
| 1.21 | `docs/PLAN_TEMPLATE.md` | EDIT | ANCHOR (verbatim, no added surrounding whitespace; the tail of the n.3 row's Verify cell, unique via the `; **and**` clause): `` `node tests/test-<feature>.mjs` → `<N>/<N> pass`; **and** the broken-input row exits non-zero |`` REPLACE: `` `node tests/test-<feature>.mjs` → `<N>/<N> pass` |`` followed by a newline and the new table row: ``| n.3b | — | — | Negative control (§A.9): run the §A.0 break-input override against the new test. | `BREAK_<X>=1 node tests/test-<feature>.mjs` (or the §A.0 portable form) → non-zero exit |`` | `grep -c "n.3b" docs/PLAN_TEMPLATE.md` → `1` |
| 1.22 | — | — | Run every §15 ledger command, one per invocation; paste outputs into §15. Reading pass over §0 and §20 for orphaned refs. | every §15 row shows its Expected value |
| 1.23 | — | — | Commit: `PT-FIX-1: PLAN_TEMPLATE consistency + cross-language Appendix A` ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` | `git log -1 --oneline` shows `PT-FIX-1` |

### Verbatim §A.0 block inserted by step 1.12

```markdown
## A.0 Target-toolchain instantiation (fill once per plan)

The rest of this appendix is language-agnostic procedure. Every language- or platform-specific
detail lives in this table; §A.4, §A.5, §A.6, §A.6b, §A.8, and §A.9 reference it. Fill every row
with a concrete value for the repo this plan targets; a step that hardcodes a toolchain other than
the repo's is a planning bug. Example commands elsewhere in this template (§14 test runner, §15
ledger rows, §A.8 deploy-audit) are THIS repo's Node instantiation of these rows; replace them per
this table when the template is copied into a repo with a different toolchain.

| Key | Value for this plan | Example (this repo: Node zero-dep ESM) |
|---|---|---|
| Language / runtime | <fill> | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check (§A.4 row) | <command → expected> | `node --version` → `v20` or higher |
| Test-runner shape | <command shape> | `node tests/test-<feature>.mjs` |
| New-function phrasing (§A.6) | <how a function is declared and made public> | `export function fnName(args)` |
| Portable break-input override (§A.6b, §A.9) | <how a negative control reaches the code> | `BREAK_X=1 node tests/…` (POSIX only) or `node tests/… --break-x` (portable) |
| Search tool for verifies | <tool> | `grep -c` / `grep -n` from the repo root |
| Repo-specific done-commands (§A.8) | <audit/smoke commands, or `n/a`> | `node tools/deploy-audit.mjs` |

The `VAR=x cmd` env-prefix spelling is POSIX-shell-only; it does not run under Windows `cmd`.
When the repo targets Windows, the break-input override MUST be an argv flag or a language-native
env mechanism, never a shell prefix.

> **Pseudocode is NOT sufficient in §A.7.** Pseudocode may appear only in §8 Design (control
> flow, at design altitude). Every §A.7 "Exact action" cell contains **verbatim target-language
> code**: identifiers, strings, error messages, regexes, copy-pasteable into the named file.
> Translating pseudocode into the target language is a design decision, and §A.2 item 3 forbids
> the executor from making any. The *procedure* around the code (anchors, STOP protocol, verify
> discipline) is language-agnostic; the *payload* never is.
```

## A.8 Definition of done

Every §15 row pasted with observed = expected; reading pass done; codex round 2 verdict recorded
in §19; PR opened with bot comment review per Rule 17; §17 issue filed.
