# RFC-015-P1-S3a Unread-pointer re-surfacing + read-boundary amendment package

## §1 Status

`Planning only.` Do not implement until this plan, the plan review, and the adversarial
review are accepted (Rule 18). Current stage: **draft**.

| Field | Value |
|---|---|
| RFC | `RFC-015` (amends `RFC-009`) |
| Parent requirements | `R7a`, `R7b`, `R7d` (R7c deferred to S3b) |
| Workplan episode | `20260728-000543-workplan-v281-625-and-629-626-fix-both-m-ecda` |
| Target branch | `feat/rfc-015-p1-s3a` |
| Executor altitude (§0.1) | **low** (fresh-context Sonnet subagent) — Appendix A is the build path |
| Base ref | `838b224` |

**Slice split (operator decision, this session).** RFC-015:167 defines P1-S3 as one slice
carrying R7a + R7b + R7c. The operator split it: **S3a** (this plan) ships R7a + the full
R7b amendment package; **S3b** ships the R7c `playbook-unread` doctor check + scoped T13.
R7b's atomicity is preserved — the boundary loosening and the code that consumes it ship
together here. The RFC slice table needs the corresponding amendment (step 1.1).

## §2 Episode Search Summary

```bash
node scripts/em-search.mjs --tag workplan --category decision --limit 1 --scope all --full --no-score --no-track
node scripts/em-search.mjs --tag session-handoff --scope local --limit 1 --full --no-track --no-score
```

Key active memories:

- `…-ecda` (workplan v281): queue head clear; P1-S3 is the next RFC-015 slice. Constrains
  this plan to be the head item, no competing in-flight work.
- `…-e0e7` (handoff 104): `main` was `97a4309`; now `838b224` after PR #630 merged.
  #630's global deploy is pending and folds into this slice's deploy pass.
- `…-5824` (seat-brief hard rules): seats never invoke `em-*` at all; the test harness is
  the only permitted runner. Binds §A.2 rule 9 below.

Every file/line this plan cites was re-verified on disk at `838b224` (§9, §A.6 anchors).

## §3 Objective

A registered `session_start` playbook that is injected but never read currently falls
silent after one render — the a6c2 signature (nine injections, `access_count` frozen at 73,
zero reads) is invisible. This slice makes the activation adapter re-render an unread
playbook pointer on subsequent `UserPromptSubmit` events, bounded to one line per event and
round-robin across unread playbooks, suppressed once the read lands. Doing so requires a
third sanctioned event-time read (the activation-log tail), so the slice also ships the full
RFC-009 read-boundary amendment package that makes any *future* quiet loosening CI-red.

Provable by: `tests/test-rfc-015-p1-s3a-resurfacing.mjs` (T10, T11) green; the contract-mirror
validator exiting 1 on a planted read-boundary drift; the advisory invariant holding on every
new leg.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority | Notes / edge cases |
|---|---|---|---|---|---|
| REQ-1 | `loadInjectState(dataDir)` — **exported from `scripts/lib/activation-log.mjs`, NOT defined in the hook** — reads a bounded tail (≤64 KiB) of `<root>/.episodic-memory/activation-log.jsonl` and builds `injectState: {episode_id → {access_count_at_inject:int, ts:string}}` from the LAST row that has `v === LOG_FORMAT_VERSION`, `event:"inject"`, and `surface ∈ {session_start, per_prompt}` and names that id. The hook calls it on `prompt` events only | R7b | `t1_tail_parse`, `t1b_tail_bound`, `t1b2_tail_exact_boundary`, `t1b3_tail_single_huge_line`, `t1c_surface_filter`, `t1d_version_skip` | MUST | Tail, never whole file (§7 C2). Surface filter is RFC-015:114's literal wording — NSP gap 6. **Location is load-bearing (R1-F2 blocker):** the hook has zero exports and its top level runs `main()` then `process.exit(0)` (`:637-639`), so importing it from a test kills the test process before any assertion runs. The lib is side-effect-free and already imported by the hook |
| REQ-1b | A malformed entry INSIDE a well-formed inject row (missing / null / non-numeric `access_count_at_inject`) is SKIPPED, never coerced into `injectState` | R7b | `t1e_entry_malformed_skipped` | MUST | NSP MUST-2. Coercing `undefined` would make `73 === undefined` false ⇒ "read" ⇒ **wrongly suppress a genuinely unread playbook**, inverting the fail-open posture of REQ-10/I-2 |
| REQ-1c | `loadInjectState` lives in `scripts/lib/activation-log.mjs` and consumes the module's own `LOG_FORMAT_VERSION` constant, so the version dimension cannot drift from the writer or from the clerk's reader | R7b | `t1d_version_skip` (behavioral), plus the import itself (structural) | SHOULD | **Reworked under R1-F2, and this is an ACCEPT-WITH-MOD of the reviewer's proposed fix.** The reviewer suggested exporting `_parseLogForConversion` and testing runtime parity. I am not doing that: `em-consolidate.mjs` has zero exports today, and adding one drags this slice into that module's init surface, which is exactly what #628 tracks. A **shared constant is a stronger guarantee than a parity test** for the version dimension — it makes drift impossible rather than detected. The other differences are deliberate, not drift: the clerk applies no `event`/`surface` filter (it aggregates all rows) and coerces `access_count_at_inject \|\| 0` at `:1932`, which REQ-1b deliberately does not. Recorded in §17 DEFER-4 rather than papered over |
| REQ-2 | The hook reads the log on `prompt` events ONLY — `SessionStart` and `PreToolUse` paths perform zero log reads | R7a | `t2_no_read_off_prompt` | MUST | Keeps R4/R3-tool byte-identical (§8.2 I-3) |
| REQ-3 | `matchActivation` accepts an optional 6th param `injectState`; omitting it reproduces pre-slice behavior byte-for-byte | R7a | `t3_arity_backcompat` | MUST | Zero-I/O invariant preserved (P9) |
| REQ-4 | A declared `session_start` playbook is UNREAD iff its trigger-index `access_count` is **≤** the `access_count_at_inject` of its latest qualifying inject row; **no inject row at all also means unread** | R7a | `t4_unread_join`, `t4b_no_row_is_unread`, `t4e_backward_count` | MUST | RFC-015:114 says "equals"; this plan widens to `≤` so a backward-moved counter (index rollback) stays on the fail-open side instead of suppressing the pointer permanently (NSP gap 5). On every non-anomalous input `≤` and `===` agree, so RFC conformance is preserved. Flagged for the reviewer as a deliberate widening of the RFC's literal wording |
| REQ-5 | At most ONE re-surfaced playbook line per `prompt` event | R7a | `t5_one_line_max` | MUST | |
| REQ-6 | With ≥2 unread playbooks, successive prompt events alternate round-robin by least-recently-surfaced (`ts` ascending, `episode_id` tie-break) | R7a | `t6_round_robin` | MUST | No starvation |
| REQ-7 | The re-surfaced line consumes ONLY the shared `max_tokens` budget, never a `max_matches` slot — mirroring the session-start playbook band | R7a | `t7_token_budget_only` | MUST | Parity with `activation-match.mjs:527` |
| REQ-8 | A re-surfaced render appends its own inject row: `result.entries` gains one member in lock-step with `result.lines` | R7a | `t8_entry_lockstep` | MUST | So S3b's R7c can count it |
| REQ-8b | The re-surfaced entry's `access_count_at_inject` is sourced from the candidate playbook row's OWN `access_count` field — **never** re-derived from `injectState` | R7a | `t8b_aci_source`, `t9b_three_events_no_read` | MUST | NSP SHOULD-4, promoted to MUST: the C1 loop invariant depends on this and nothing else. Mirrors the proven pattern at `activation-match.mjs:557` |
| REQ-9 | Once a read lands and the trigger index rebuilds, re-surfacing stops for that playbook | R7a | `t9_read_suppresses` | MUST | One extra render in the pre-rebuild window is accepted (RFC-015:114) |
| REQ-10 | Absent / unreadable / truncated / unparseable / torn log → re-surfacing silently disabled, normal injection unaffected, exit 0, no `decision` field | R7b | `t10_fail_open` (5 legs) | MUST | Fail-open, RFC-015:115 |
| REQ-11 | A suppressed id (`lesson-suppress.json`) is never re-surfaced | R7a | `t11_suppress_wins` | MUST | |
| REQ-12 | A playbook already rendered in this same event is not re-surfaced again | R7a | `t12_no_double_render` | MUST | |
| REQ-13 | `RFC-009-lesson-activation.md:47` names `activation-log.jsonl` as the third sanctioned event-time read, with the tail bound and the fail-open rule | R7b | `manual: grep -n 'activation-log' docs/rfcs/RFC-009-lesson-activation.md` | MUST | Text revision, not a quiet patch |
| REQ-14 | The contract mirror gains an `event_time_reads` key with TWO members: `files` (the sanctioned basenames) and `read_call_sites` (a pinned per-file COUNT). The validator (a) extracts the `EVENT_TIME_READS` array literal from `activation-hook-run.mjs` source by anchored parse and `diffBoth`s it against `files`, and (b) counts `fs.readFileSync\|openSync\|readSync` occurrences in BOTH `activation-hook-run.mjs` and `scripts/lib/activation-log.mjs` and compares each to `read_call_sites` | R7b | `t14_mirror_boundary_ok` | MUST | **R1-F1 (blocker).** My first design scanned call sites for literal path arguments; every real site passes a variable (`fs.readFileSync(triggerIndexPath, 'utf8')`), so the scan extracted **nothing** and the shipped contract would fail its own validator on run 1. The declared-constant half is readable; the **count pin** is what makes an undeclared new read fail CI even if the contributor never touches the constant |
| REQ-14b | `read_call_sites` keys are **repo-relative paths**, not basenames (R2-G10 — Listing L3 is authoritative): `{"plugins/claude-code-activation/hooks/activation-hook-run.mjs": 6, "scripts/lib/activation-log.mjs": 3}` | R7b | `t14_mirror_boundary_ok` | MUST | Counted at `838b224`: hook has 6 today (`:119`, `:178`, `:264`, `:469`, `:502`, `:540`) and gains 0 because the reader lands in the lib (R1-F2); the lib has 0 today and gains exactly 3 (`openSync` + `readSync` ×2). Covering BOTH files closes the hole where a new read is added to the lib instead of the hook |
| REQ-15 | Planted drift makes the validator exit 1 naming the drift, across THREE sub-cases: (a) entry added to `contract.json` `files`, (b) entry dropped from `files`, (c) **a genuinely new `fs.readFileSync` call added to a throwaway copy of the hook SOURCE with `contract.json` left untouched** | R7b | `t15_mirror_boundary_drift` (3 sub-cases) | MUST | Sub-case (c) is the only one that exercises the real failure mode `RFC-009:47` forbids. It now works because (c) bumps the occurrence count past the pin. Under the original design (c) was undetectable — the whole point of R1-F1 |
| REQ-16 | `env_independence` and `payload_schema` legs still pass with the new read wired in | R7b | `test-activation-sessionstart.mjs`, `test-activation-hook-e2e.mjs` | MUST | See §13 EC7 for the prompt-path determinism question |
| REQ-17 | No new path emits `decision`/`block`/`permissionDecision`, and no event-plane leg exits non-zero | R7d | `t17_advisory_ceiling` | MUST | B-1 operator lock |
| REQ-18 | RFC-015 records the S3a/S3b split in BOTH the slice bullet (`:167`) and the ledger (`:200`), the corrected rotation anchor, and the `≤` amendment at `:114` | R7b | `manual: git diff docs/rfcs/RFC-015-playbook-registration-audit.md` | SHOULD | Anchor `:1568-1606` is stale; real is **`:1806-2045`** — `clerkComputeConversion` closes at 2045 (R1-F16 corrected my earlier `:2049`, which disagreed with Listing L2a in the same document) |

## §5 Non-Goals

- The R7c `playbook-unread` doctor check — S3b.
- R8 digest dedup — P1-S4.
- Stamping `source_scope` on the playbooks trio (`activation-hook-run.mjs:436-440`). RFC-015:116
  states the resulting per-episode-id-only join as an accepted limitation, not a defect this
  slice fixes.
- Configurable unread threshold (RFC-015:116 fixes it at 3 for P1; that threshold belongs to
  R7c/S3b anyway).
- Similarity-based digest dedup (OQ-4).
- Re-surfacing on `PreToolUse`. R7a says `UserPromptSubmit`; tool events stay untouched.
- **Raising or bypassing the build-time playbook cap (R1-F19).** Re-surface candidacy is drawn
  from `session_start.playbooks`, which the build pre-caps to `max_playbooks` (default 2, max 4 —
  `em-trigger-index.mjs:456-457`). A declaration beyond the cap never re-surfaces, because it
  never renders at all; session start already emits a capped-note for it. This slice does not
  change that.
- **Stamping `source_scope` on re-surfaced telemetry entries (R1-F20).** They will always carry
  `source_scope: null`, because Listing L5c reads the raw LOCAL playbooks trio and `tagScope` is
  never applied to that trio (`activation-hook-run.mjs:436-440`). This is consistent with today's
  session-start playbook entries and with RFC-015:116's explicit per-episode-id-only join.
  Deliberate, not an oversight.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads (lines × ~5) | Writes | Notes |
|---|---|---|---|---|
| `plugins/claude-code-activation/hooks/activation-hook-run.mjs` | 639 | ~3.2k | ~0.6k | 3 anchored EDITs + 1 APPEND |
| `scripts/lib/activation-match.mjs` | 751 | ~3.8k | ~0.8k | 2 anchored EDITs + 1 APPEND |
| `scripts/validate-rfc-009-contract-mirror.mjs` | 183 | ~0.9k | ~0.3k | 1 APPEND + 1 EDIT |
| `docs/rfcs/RFC-009-lesson-activation.contract.json` | 94 | ~0.5k | ~0.2k | 1 EDIT (new key) |
| `docs/rfcs/RFC-009-lesson-activation.md` | 566 | ~2.8k | ~0.2k | 1 EDIT (line 47) |
| `docs/rfcs/RFC-015-playbook-registration-audit.md` | 228 | ~1.1k | ~0.3k | slice bullet + ledger + anchor fix + `≤` amendment (4 edits) |
| `tests/test-contract-mirror-009.mjs` | 106 | ~0.5k | ~0.4k | 2 drift sub-cases |
| `scripts/lib/activation-log.mjs` | 96 | ~0.5k | ~0.7k | APPEND the reader (R1-F2 relocation) |
| `tests/test-rfc-015-p1-s3a-resurfacing.mjs` | new | — | ~3.5k | CREATE, 29 legs |
| `tests/test-activation-sessionstart.mjs` | 876 | ~4.4k | ~0.2k | fixture touch only if §13 EC7 requires |
| `.github/workflows/tests.yml` | 520 | ~2.6k | ~0.1k | 1 step |

**Baseline (single session):** ~25k tokens of file traffic plus review rounds.
**Optimized:** builder sees only Appendix A listings + the named files, not this whole plan.

## §7 Safety / Security

This slice opens a new event-time read (a trust boundary) on a file the same process writes.
`negative-scenario-planner` was dispatched on the design before this section was authored;
its matrix is folded in below and its full report is attached as Appendix B at review time.

| Concern | Severity | Attack/abuse scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| C1 self-referential loop | Med | The hook writes an inject row carrying the CURRENT `access_count`, then reads it back next event. A row written by a re-surface could make its own pointer look read. | The join compares `access_count` (read counter) to `access_count_at_inject` (snapshot). A re-surface appends a row with the SAME `access_count`, so the pair stays equal and the pointer stays unread until a real read bumps `access_count`. Persistent re-surfacing until read is the specified intent (RFC-015:117 "persistent, bounded"). | `t4_unread_join`, `t9_read_suppresses`, `negative: t9b_three_events_no_read` asserts 3 consecutive prompt events all re-surface |
| C2 unbounded parse cost | Med | The log grows to the 1 MiB `ACTIVATION_LOG_MAX_BYTES` bound and is parsed on EVERY prompt event. | Read at most the last 64 KiB (`RESURFACE_TAIL_MAX_BYTES`), never the whole file; discard the first partial line only when the window actually starts mid-line. Bound is stated, not best-effort. | `t1b_tail_bound` writes a >64 KiB log and asserts only tail rows are seen |
| C2b tail-window semantic loss | Med | **R1-F12, the cost of C2's mitigation.** The 64 KiB tail is up to 16× narrower than the 1 MiB rotation window RFC-015:114 assumes, so a busy project can push a playbook's newest inject row out of view. A scrolled-out id looks like "no inject row" ⇒ UNREAD (REQ-4), and because a re-surface then appends a row carrying the CURRENT post-read count (REQ-8b), the join reads `current ≤ snapshot` from then on: an already-read pointer re-surfaces on every prompt indefinitely. Writer-side drops at the 1 MiB cap push the same way. | Stated, not silently absorbed — this narrows RFC-015:116's "within-rotation-window lower bounds" caveat further, and R7a is **degraded, not broken**: RFC-015:114 already declares a rotated log "unread by definition". **Wrongful suppression remains impossible in every case**, because suppression requires `current > snapshot`, i.e. a real read after the newest in-window inject. Recorded in §17 DEFER-5 with the option to raise the tail on measured parse cost. | `t12c_scrollout_treated_unread` asserts the degraded-but-safe direction explicitly |
| C3 torn / concurrent write | Med | Two sessions append concurrently; the clerk `renameSync`s the log mid-read (`em-consolidate.mjs:2023`). Reader can see a partial final line, a missing file, or a `.processing` file. | Per-line `JSON.parse` in try/catch, skip unparseable; missing file → `null`; never read `.processing`. All roads lead to fail-open. **NSP runtime probe (POSIX/darwin) established a stronger guarantee than this row originally claimed:** an fd opened before the rename keeps reading the original inode's full content even after the path is renamed AND the target unlinked, so an already-open reader is immune entirely. Windows rename-while-open is NOT verified — see §17 DEFER-2. | `t10_fail_open` legs: absent, truncated-mid-line, garbage line, empty file, directory-in-place-of-file |
| C4 injection via log content | Med | A crafted `episode_id` or `summary` reaching `additionalContext` could carry instructions. | The re-surfaced line is rendered by the EXISTING `renderPlaybookLine` from the trigger-index row (id + summary + read_command), never from log content. The log supplies only two numbers/strings used for the comparison and ordering — no log-sourced text enters the rendered line. | `t4c_log_text_never_rendered` plants a sentinel in a log row's fields and asserts it is absent from stdout |
| C5 read-boundary regression | High | A future contributor adds a fourth read; nothing catches it, because the contract mirror has no read-boundary concept today. | REQ-14: `event_time_reads` contract key whose CODE side is derived by scanning real `fs.*` call sites, diffed bidirectionally with `diffBoth` — **not** the one-directional `checkActivationFlags` grep pattern, which cannot see an added undeclared read. REQ-15 sub-case (c) plants the drift in hook source, not in the contract. | `t15_mirror_boundary_drift` (3 sub-cases: add-to-contract, drop-from-contract, **add-read-to-source**), all asserted exit 1 |
| C8 join-key role elevation | Med | `access_count_at_inject` is today a descriptive telemetry field the clerk reports but never uses for a correctness decision (`em-consolidate.mjs:1932`). This slice promotes it to a live, correctness-critical join key without renaming it or documenting the elevation. | Named explicitly here and in §8.1. The fail-open direction contains the blast radius: a dropped or malformed write biases toward MORE re-surfacing (REQ-4's "no row ⇒ unread"), never toward wrongful suppression — provided REQ-1b skips malformed entries rather than coercing them. | `t1e_entry_malformed_skipped`, `t4b_no_row_is_unread` |
| C6 advisory-ceiling breach | High | A new error path exits non-zero or emits a decision field. | Every new path is inside try/catch returning `null`/empty; `main()` already terminates with `.then(exit 0).catch(exit 0)` (`activation-hook-run.mjs:637-639`). | `t17_advisory_ceiling` sweeps stdout for the three forbidden fields on every fail-open leg and asserts exit 0 |
| C7 symlink / path authority | Low | `.episodic-memory` or the log file is a symlink redirecting the read outside the project. | The path is derived from manifest-only `identity.root` (never stdin cwd/env, `activation-hook-run.mjs:30-36`) and joined with two fixed literals. The read is content-only with no authority decision attached to it, so no `lstat`-before-`realpath` predicate exists to subvert — the file's contents cannot escalate anything, they can only be discarded. | `t7b_symlinked_log_still_fail_open` |

**Path-authority note.** This slice adds no `realpath`/`isMain`/repo-class predicate, so the
8-axis symlink matrix does not apply beyond C7. Recorded explicitly so its absence is a
decision, not an omission.

## §8 Design

### 8.1 Key types

```js
/**
 * @typedef {Object} InjectStateRow
 * @property {number} access_count_at_inject — the read-counter snapshot at that injection
 * @property {string} ts — ISO8601 timestamp of that inject row; ordering key for round-robin
 */
/**
 * @typedef {Object.<string, InjectStateRow>} InjectState
 * Keyed by episode_id. Built ONLY from the last inject row naming each id.
 * `null` means "log unavailable" — semantically distinct from `{}` ("log readable, no rows").
 */
```

### 8.2 Key invariants

- **I-1 zero-I/O matcher.** `activation-match.mjs` performs no file I/O. `injectState` is
  computed hook-side and passed in, exactly as `suppress` already is (P9: core never imports
  adapters; the pure matcher never learns about the filesystem).
- **I-2 fail-open everywhere.** Any failure in the new path yields `null`, which disables
  re-surfacing and changes nothing else. There is no failure mode that suppresses normal
  injection.
- **I-3 off-prompt symmetry.** `SessionStart` and `PreToolUse` perform zero log reads and
  produce byte-identical output to pre-slice. This preserves the invariant asserted in the
  comment at `activation-hook-run.mjs:566-568`, which this slice must NOT falsify.
- **I-4 no log text is ever rendered.** The rendered line comes from the trigger-index row via
  the existing `renderPlaybookLine`. The log contributes only the comparison number and the
  ordering timestamp.
- **Cross-platform:** the tail read uses `fs.openSync`/`fs.readSync`/`fs.fstatSync` with a
  byte offset and `path.join` — no `tail`, no shell, no GNU flags. Byte offsets are computed
  from `stat.size`, valid on Windows.
- **Atomicity:** read-only path; no shared-state write is added. The existing telemetry append
  is untouched.

### 8.3 Resolution / flow

```text
UserPromptSubmit
  → resolveIdentity (manifest only)
  → loadStoreIndex local+global → mergeIndexes
  → [NEW] if event.kind === 'prompt':
        merged.resurface_playbooks = local.session_start.playbooks (LOCAL-only, validated)
        injectState = loadInjectState(<root>/.episodic-memory)   ← bounded tail, fail-open
  → loadSuppressSet
  → matchActivation(merged, event, identity, suppress, bounds, injectState)
        → selectAndBound(...)                     (unchanged lesson selection)
        → [NEW] pickResurfacePlaybook(...)        (pure; ≤1 line, token budget only)
  → telemetry append (existing path; now also logs the re-surfaced entry)
  → stdout hookSpecificOutput
```

**Why `resurface_playbooks` and not `merged.session_start`.** `merged.session_start` is
computed only on the `SessionStart` branch (`activation-hook-run.mjs:565`), under an explicit
comment that the R3 hooks' merged shape stays byte-identical. Populating it on the prompt path
would falsify that invariant and change the shape every R3 test pins. A narrow, separately
named field carries exactly the array R7a needs and leaves `session_start` alone. The playbooks
trio is LOCAL-only by contract (`activation-hook-run.mjs:431-440` threads it unchanged; global
never produces one), so no merge is required.

## §9 Existing Hook Points

Verified at `838b224`.

| File | Line(s) | What it does today | Impact of this change |
|---|---|---|---|
| `plugins/claude-code-activation/hooks/activation-hook-run.mjs` | 19-28 | READ BOUNDARY (REQ-19) header comment naming two sanctioned reads | EDIT: name the third read + its bound + fail-open rule |
| same | 565-576 | `merged.session_start` computed on the SessionStart branch only | EDIT: add a prompt-branch that sets `merged.resurface_playbooks` + `injectState` |
| same | 592 | `matchActivation(merged, event, identity, suppress, {max_matches:3, max_tokens:500})` | EDIT: pass `injectState` as the 6th arg |
| same | 609-627 | R6 telemetry append; maps `result.entries` | unchanged — re-surfaced entries flow through as-is |
| same | end of file | — | APPEND the `EVENT_TIME_READS` constant (parsed from source by the validator; the hook cannot export) |
| `scripts/lib/activation-log.mjs` | end of file (96 lines) | writer + constants only, no reader | APPEND `loadInjectState` + `RESURFACE_TAIL_MAX_BYTES`. **This is where the reader lives** (R1-F2) — side-effect-free and importable, unlike the hook |
| `plugins/claude-code-activation/manifest.json` | 19 | pins a sha256 for every owned support file (Principle 10) | **Checksum MUST be updated whenever the hook changes.** Missed by the original plan and by all three review rounds; caught only by CI. See the note below |

> **Owned-artifact checksums are invisible to diff review (CI-caught defect, 2026-07-29).**
> `plugins/claude-code-activation/manifest.json:19` pins the hook's sha256. Editing the hook
> without updating it fails three suites at once — `test-plugin-registry`,
> `test-activation-manifest`, and the `test-em-promote` gauntlet leg — all on the same
> `A-support-checksum` violation. Nothing local caught it: the manifest appears in neither the
> plan nor the diff, so a diff reviewer has no reason to open it, and none of the five suites run
> during the build exercises the registry. **Any future slice touching a file listed in a plugin
> manifest must carry an explicit checksum step.** Audited repo-wide at the time: the codex
> manifests (`plugins/codex-activation/manifest.json`, `.codex/episodic-memory-activation/manifest.json`)
> pin their own separate hook and matcher copies, both verified unchanged, and no manifest pins
> `scripts/lib/activation-log.mjs` at all.
| `scripts/lib/activation-match.mjs` | 367-428 | `selectAndBound` returns `{lines, overflowNote, entries}` | EDIT: also return `totalTokens` (additive; no existing caller reads it) |
| same | 729-742 | `matchActivation` prompt/tool path, early-returns when `entries.length === 0` | EDIT: restructure so the re-surface leg runs even with zero lesson entries |
| same | end of file | — | APPEND `pickResurfacePlaybook` |
| `scripts/validate-rfc-009-contract-mirror.mjs` | 183 lines | validates flags/classes/fields against code | APPEND an `event_time_reads` comparison |
| `docs/rfcs/RFC-009-lesson-activation.md` | 47 | strict read boundary + forbids quiet loosening | EDIT: add the third sanctioned read |
| `docs/rfcs/RFC-015-…md` | 115, 167, 200 | R7b stale anchor; slice list; ledger | EDIT: fix anchor, record the S3a/S3b split |

## §10 Slice Ladder

| Slice | Objective | Primary files | Key deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `S3a` | R7a re-surfacing + R7b amendment package | hook, matcher, activation-log lib, contract mirror, RFC-009, RFC-015 | this plan | T10, T11 (**29 legs**, R2-G8) | Do NOT add the doctor check; do NOT stamp `source_scope`; do NOT touch R8 |
| `S3b` | R7c `playbook-unread` doctor check | `scripts/em-doctor.mjs` | separate plan | T13 scoped | Do NOT revisit the read boundary |

### 10.1 Dependency graph

```text
S3a ── S3b     (hard dep: S3b's check counts inject rows that only S3a's re-surface produces)
```

## §11 Cut Order

1. `t6_round_robin` reduced to a 2-playbook determinism assertion (keep the behavior, shrink the fixture).
2. The RFC-015 slice-table amendment (REQ-18, SHOULD) — can follow in S3b's PR.
3. The `t7b_symlinked_log` leg (C7 is Low).

Do **not** cut:

- REQ-14/REQ-15 (the contract-mirror boundary surface). Without it this slice loosens a
  documented strict boundary with nothing guarding the next loosening — the precise thing
  `RFC-009:47` forbids.
- REQ-10 fail-open legs, or REQ-17 advisory ceiling.
- REQ-2 (off-prompt zero-read), which is what keeps the R4/R3-tool surfaces unchanged.

## §12 Contracts

### `loadInjectState(dataDir) → InjectState | null`

**Input contract:** `dataDir` is an absolute path string. No other input.
**Output contract:** a plain object keyed by episode id, or `null`. Never throws.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. absent | log file does not exist | `null` | none |
| A2. absent (steady state) | the clerk consumed every line and `openWindowLines` was empty, so **no fresh log was recreated** (`em-consolidate.mjs:1993-2001, 2029-2037`) | `null` | none |
| B. empty | file exists, zero bytes | `{}` | none |
| C. small | size ≤ 64 KiB | map over all qualifying rows | none |
| D. large | size > 64 KiB, tail offset lands MID-line | map over the last 64 KiB with the leading partial line discarded | none |
| D2. large, aligned | size > 64 KiB and the byte immediately BEFORE the tail window is `\n` (or offset is 0) | **do NOT discard** the first line — it is whole | none |
| D3. one huge line | no `\n` anywhere in the tail window | `{}` (nothing usable) | none |
| E. torn | final line is truncated JSON | that line skipped, rest mapped | none |
| F. garbage | a line is non-JSON | that line skipped, rest mapped | none |
| G. wrong shape | row lacks `entries[]`, or `event !== 'inject'` | row skipped | none |
| G2. wrong version | `row.v !== LOG_FORMAT_VERSION` | row skipped (parity with `em-consolidate.mjs:1868`) | none |
| G3. wrong surface | `row.surface ∉ {session_start, per_prompt}` | row skipped (RFC-015:114) | none |
| G4. entry malformed | row is fine but an ENTRY has missing / null / non-numeric `access_count_at_inject` | **that entry skipped, never coerced** (REQ-1b) | none |
| H. unreadable | open/read throws (EACCES, EISDIR) | `null` | none |
| I. duplicate id across rows | id appears in several rows | LAST occurrence wins (append order is chronological) | none |
| I2. duplicate id within one row | id appears twice in one row's `entries[]` | LAST occurrence within that row wins (same rule, applied in array order) | none |

**Error codes:** none. This is an advisory read; it fails **open** by returning `null`.
Stated explicitly because §12's default for gates is fail-closed — this is not a gate.

### `pickResurfacePlaybook(playbooks, injectState, suppress, excludeIds) → object | null`

**Input contract:** `playbooks` an array of trigger-index playbook rows; `injectState` the map
or `null`; `suppress` a Set; `excludeIds` a Set of ids already rendered this event.
**Output contract:** one playbook row, or `null`. Pure; never throws.

| State | Condition | Output | Side effects |
|---|---|---|---|
| A. no data | `playbooks` empty or not an array | `null` | none |
| B. log unavailable | `injectState === null` | `null` (re-surfacing disabled) | none |
| C. none unread | every candidate has `access_count > access_count_at_inject` | `null` | none |
| D. one unread | exactly one candidate unread | that row | none |
| E. many unread | ≥2 unread | smallest `ts`; tie-break smallest `episode_id` | none |
| F. never injected | candidate absent from `injectState` | treated as unread, sorts FIRST (`ts` = `''`) | none |
| G. suppressed | id ∈ `suppress` | excluded from candidacy | none |
| H. already rendered | id ∈ `excludeIds` | excluded from candidacy | none |
| I. malformed row | not an object / no string `episode_id` | excluded | none |
| J. count moved backward | current `access_count` < stored `access_count_at_inject` (index rollback / corruption) | **treated as UNREAD** — the predicate is `current <= snapshot`, not `===` | none |

**Caller MUST clause (REQ-8b, load-bearing for C1).** The caller appends the re-surfaced
telemetry entry with `access_count_at_inject` taken from the returned row's own `access_count`
field — never re-derived from `injectState`. Sourcing it from `injectState` would echo the
previous snapshot forward and break the equality invariant that makes re-surfacing terminate
on a real read. This mirrors the proven session-start pattern at `activation-match.mjs:557`.

**Why `<=` and not `===` (state J).** NSP gap 5: pure equality sends a backward-moved counter
to "not equal ⇒ read ⇒ suppressed forever," which is the wrong direction for an anomaly. `<=`
keeps every anomaly on the fail-open side (extra advisory line) rather than the silent-loss
side (pointer never surfaces again).

## §13 Edge Cases

| # | Scenario | Expected behavior | Test |
|---|---|---|---|
| EC1 | log absent (fresh project) | `null`; no re-surface; normal injection unaffected | `t10_fail_open_absent` |
| EC2 | `.episodic-memory/activation-log.jsonl` is a symlink | content read only, no authority derived; still fail-open on error | `t7b_symlinked_log_still_fail_open` |
| EC3 | clerk rotates mid-read | `null` if the file is gone before `openSync`; otherwise the read completes correctly, because `openSync` precedes `fstatSync(fd)` and the fd pins the inode — a rename or unlink after the open cannot corrupt it (POSIX probe, plan-time audit; independently re-derived in round 3) | `t10_fail_open` absent sub-leg. **R3-H2:** an earlier draft cited a `t10_fail_open_race` leg. No such leg exists or should: the race is not deterministically reproducible in-process, and the observable outcomes it could produce are already covered by t10's five sub-legs |
| EC3b | clerk consumed every line with no open-window carry-forward, so no fresh log exists at all | `null`. This is **not** a narrow mid-operation window — it is a steady state that persists until the next telemetry append, so it is the common case on a quiet project, not a rare race | `t10_fail_open_absent` |
| EC4 | log > 64 KiB, first tail line partial | partial line discarded, remainder parsed | `t1b_tail_bound` |
| EC4b | tail offset lands EXACTLY on a line boundary | the first line is whole and MUST NOT be discarded; disambiguate by testing whether the byte before the window is `\n` (or offset === 0) | `t1b2_tail_exact_boundary` |
| EC4c | a single line exceeds 64 KiB (no `\n` in the window) | `{}`; no crash, no partial-JSON parse attempt | `t1b3_tail_single_huge_line` |
| EC5 | a playbook row's `access_count` is absent or non-numeric (`"x"`) | `Number.isFinite` test, falling back to `0` ⇒ treated UNREAD. **Not** `?? 0`, which catches only null/undefined and lets `"x"` through to `NaN` | `t4d_missing_access_count` |
| EC5b | an inject row's `access_count_at_inject` survives `loadInjectState` but is non-finite at compare time | treated as "no snapshot" ⇒ UNREAD, sorts first (defense in depth; `loadInjectState` already skips these) | `t4d_missing_access_count` |
| EC6 | zero lesson entries but one unread playbook | re-surface STILL fires (the `entries.length === 0` early return at `activation-match.mjs:730` must not swallow it) | `t12b_zero_lessons_still_resurfaces` |
| EC7 | `env_independence` runs several hook invocations that each append an inject row | **Resolved, verified by NSP against the fixture source, not assumed.** SessionStart performs no log read (REQ-2) so `test-activation-sessionstart.mjs:388-418` is unaffected. The prompt-path fixture `r3_env_independence` (`test-activation-hook-e2e.mjs:469-505`) seeds only plain trigger-phrase lessons via `storeEpisode` and registers **no** `session_start` playbook, so `pickResurfacePlaybook([], …)` returns `null` at state A before `injectState` is ever consulted. Output cannot vary. **No fixed-log seeding and no assertion change are required.** | `t16_env_independence_prompt` (regression pin only) |
| EC8 | `injectState` is `{}` (log readable, no inject rows yet) | every declared playbook is unread by REQ-4's "no row" clause → one re-surfaces | `t4b_no_row_is_unread` |
| EC9 | 6th arg omitted by an old caller | identical output to pre-slice | `t3_arity_backcompat` |

## §14 Test Case Catalog

```text
Group 1: tail read + bound (REQ-1, REQ-1b, REQ-1c, REQ-2) — 9 tests
  t1_tail_parse                     — a 3-row log yields the 3 expected map members
  t1b_tail_bound                    — a >64 KiB log yields ONLY tail ids; an early id is absent
  t1b2_tail_exact_boundary          — offset lands on '\n' ⇒ first line NOT discarded (EC4b)
  t1b3_tail_single_huge_line        — one >64 KiB line ⇒ {} , no crash (EC4c)
  t1c_surface_filter                — a 'tool' surface row is ignored by the join (RFC-015:114)
  t1d_version_skip                  — a row with v=2 is skipped (parity with the clerk reader)
  t1e_entry_malformed_skipped       — entry with access_count_at_inject:null ⇒ entry skipped,
                                      playbook still treated UNREAD (REQ-1b; the inversion guard)
  t2_no_read_off_prompt             — SessionStart + PreToolUse: stdout byte-identical with a
                                      behavior-changing log present vs deleted (R1-F13)
  t3_arity_backcompat               — matchActivation without the 6th arg === pre-slice output

Group 2: the unread join (REQ-4, REQ-8b, REQ-9) — 8 tests
  t4_unread_join                    — equal counts ⇒ unread ⇒ re-surfaced
  t4b_no_row_is_unread              — id absent from injectState ⇒ re-surfaced
  t4c_log_text_never_rendered       — sentinel planted in log fields is absent from stdout
  t4d_missing_access_count          — non-finite access_count on the ROW ⇒ coerced to 0, no NaN
  t4e_backward_count                — current < snapshot ⇒ still UNREAD, not suppressed (state J)
  t8b_aci_source                    — the appended entry's access_count_at_inject equals the
                                      playbook ROW's access_count, not the injectState snapshot
  t9_read_suppresses                — access_count bumped + rebuilt ⇒ no re-surface
  t9b_three_events_no_read          — 3 consecutive prompts with no read ⇒ 3 re-surfaces (C1)

Group 3: bounds + ordering (REQ-5, REQ-6, REQ-7, REQ-8, REQ-11, REQ-12) — 9 tests
  t5_one_line_max                   — 3 unread playbooks ⇒ exactly 1 playbook line
  t6_round_robin                    — 2 unread alternate across successive events
  t7_token_budget_only              — re-surface fires with max_matches already full
  t7b_symlinked_log_still_fail_open — symlinked log errors ⇒ fail-open
  t8_entry_lockstep                 — result.entries.length === result.lines.length
  t11_suppress_wins                 — suppressed id never re-surfaces
  t12_no_double_render              — id rendered by the lesson path is not re-surfaced
  t12b_zero_lessons_still_resurfaces— EC6
  t12c_scrollout_treated_unread     — an id whose only inject row is pushed out of the 64 KiB
                                      window is treated UNREAD, never suppressed (C2b)

Group 4: fail-open + advisory ceiling + regression pins (REQ-10, REQ-16, REQ-17) — 3 tests
  t10_fail_open                     — 5 sub-legs: absent / empty / truncated / garbage / EISDIR
  t16_env_independence_prompt       — 4 prompt variants byte-identical (EC7 regression pin)
  t17_advisory_ceiling              — no decision|block|permissionDecision on ANY leg; exit 0

Group 5: contract-mirror boundary (REQ-14, REQ-15) — 2 tests (in test-contract-mirror-009.mjs)
  t14_mirror_boundary_ok            — shipped contract's event_time_reads.files matches the
                                      EVENT_TIME_READS constant DECLARED in the hook, and each
                                      read_call_sites count matches the file's actual occurrence
                                      count; exit 0. (R3-H2: "SCANNED out of the call sites" was
                                      pre-R1-F1 wording for a mechanism that never shipped)
  t15_mirror_boundary_drift         — 3 sub-cases ⇒ exit 1 naming the drift:
                                        (a) entry ADDED to contract.json
                                        (b) entry DROPPED from contract.json
                                        (c) a new fs.readFileSync added to a THROWAWAY COPY of
                                            the hook source, contract.json untouched
                                            (the only sub-case that tests the real failure mode)
```

Total: **29 legs** (9 + 8 + 9 + 3) in `tests/test-rfc-015-p1-s3a-resurfacing.mjs`, plus **2**
added to `tests/test-contract-mirror-009.mjs` (the second carrying 3 sub-cases).
Test runner: `node tests/test-rfc-015-p1-s3a-resurfacing.mjs` → `29/29 pass`.

**R1-F8:** the group headers, the total, the L7 table, and step 1.15's verify must all agree on
29. An earlier draft had headers of 7 and 6 over lists of 8, a total of 28, an L7 table of 29,
and a verify demanding `28/28` — a builder would have observed `29/29` and stopped.

## §15 Verification Ledger (verify by artifact)

| Claim | Command (the strong-layer one) | Observed artifact |
|---|---|---|
| New suite passes | `node tests/test-rfc-015-p1-s3a-resurfacing.mjs` | `<fill at build>` |
| Contract mirror still green | `node tests/test-contract-mirror-009.mjs` | `<fill>` |
| Boundary drift is caught (negative) | `node tests/test-contract-mirror-009.mjs` — sub-case (c) IS the negative control and runs inside the suite | the (c) leg reports the validator exiting 1. **R1-F7:** an earlier draft cited `BREAK_BOUNDARY=1` and `--break-boundary`; neither exists in that file, which has no argv or env handling at all, and no listing added one. The planted-source sub-case needs no break flag — it plants real drift |
| SessionStart unchanged | `node tests/test-activation-sessionstart.mjs` | `<fill>` |
| Prompt/tool e2e unchanged | `node tests/test-activation-hook-e2e.mjs` | `<fill>` |
| Advisory ceiling, strongest existing layer | `node tests/test-activation-hook-e2e.mjs` (R2-G6: that suite has no argv handling, so `--only` was inert — run the whole suite) | `<fill>` — this pre-existing sweep (`:283-368`) already drives the prompt path through no-manifest, missing-index, corrupt-index (recoverable + unrecoverable), suppressed and malformed-suppress branches, checking every one for decision fields and non-zero exit. Once `loadInjectState` runs on every prompt event it exercises the new code across all of those states for free (NSP gap 9) |
| Adjacent suites | `node tests/test-rfc-015-registration.mjs` | `20/20` |
| Adjacent suites | `node tests/test-rfc-015-p1-s2-consolidation.mjs` | `34/34` |
| CI registration guard | `node tests/test-ci-suite-registration.mjs` | `<fill>` |
| CI green | `gh run list --branch feat/rfc-015-p1-s3a` | `<fill>` |
| Deploys clean | `node tools/deploy-audit.mjs` | `<fill>` (hook file touched ⇒ required) |

## §16 Risk Analysis

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Builder edits `.claude/hooks/activation-hook-run.mjs` (untracked) instead of the plugins/ copy → green locally, empty PR diff | High | **High** | §A.2 rule 10 names the single writable hook path; step 1.0 pre-flight asserts the untracked copy is unmodified |
| Prompt-path e2e fixture becomes non-deterministic | Med | Med | EC7 + REQ-2; seed a fixed log rather than relax an assertion |
| Contract-mirror check is self-fulfilling (two hand-maintained lists diffed against each other) | **High** | Med | NSP MUST-1 folded: REQ-14 pins `diffBoth` against a scan of real `fs.*` call sites; REQ-15 sub-case (c) plants the drift in source. Still the first reviewer question |
| Windows `renameSync` while the log is open behaves unlike POSIX | Med | Low | §17 DEFER-2; POSIX verified by probe, Windows explicitly unverified rather than assumed |
| Re-surfacing is noisier than the operator wants (fires every prompt until read) | Low | High | This is the specified intent (RFC-015:117); recorded in §17 as a knob for S3b if disliked |

## §17 Open Decisions

- **Unread threshold for re-surfacing (not the doctor check).** R7a re-surfaces on every
  prompt while unread; R7c's `warn` threshold of 3 governs only the doctor. Whether re-surfacing
  should also honor a threshold is deferred to S3b. **5-field DEFER:** (1) *Run the scenario* —
  `t9b_three_events_no_read` will show 3 renders in 3 events, which is the RFC-specified
  behavior, not a failure. (2) *Spec check* — RFC-015:114/117 mandate persistent re-surfacing
  until read; adding a threshold here would contradict the spec, so no defer-to-fix is owed.
  (3) *History check* — the a6c2 signature (`RFC-015:27`, nine injects zero reads) is the
  motivating evidence FOR persistence. (4) *Same-class check* — the only sibling is the
  doctor threshold, which ships in S3b with the fixed value 3. (5) *Residual risk* — if the
  operator finds it noisy, the failure is cosmetic (an extra advisory line per prompt), not
  corruption; reversible by a one-line bound. Tracked in the S3b plan, not a new issue.

- **DEFER-2: Windows `renameSync`-while-open semantics are unverified.** The NSP probe
  established POSIX behavior by running it (an fd opened before the rename keeps reading the
  original inode after both rename and unlink). Windows was not verifiable from this machine.
  **5-field DEFER:** (1) *Run the scenario* — probe run on darwin only; observed JSON recorded
  in the NSP report; the Windows equivalent could not be executed, so this is NEEDS-EVIDENCE,
  not a claim. (2) *Spec check* — no RFC requires a specific cross-platform rotation guarantee;
  the repo's standing cross-platform rule governs the byte-offset arithmetic (satisfied: `stat.size`
  + `fs.readSync`, no shell, no GNU flags) but not this OS interaction. No enforcement obligation,
  so a defer is permitted. (3) *History check* — no prior finding in this repo on Windows
  rename-while-open. (4) *Same-class check* — the sibling is the clerk's own reader
  (`_parseLogForConversion`), which has carried the identical exposure since RFC-009 P4 shipped
  and is not guarded either; deferring here leaves the pair consistent rather than fixing one of
  two. (5) *Residual risk* — worst case on Windows is an `EBUSY`/`EPERM` from the read, which
  `loadInjectState` catches and returns `null` for: re-surfacing silently disables, injection is
  unaffected. Graceful, not silent corruption. **To be filed as a GitHub issue at step 9** naming
  both members of the class.

- **DEFER-3: `activation-log.jsonl` has no JSON Schema.** NSP's #22 audit found the artifact has
  no `schemas/*activation-log*` file, unlike its siblings `lesson-suppress.json` and
  `playbooks.json`. **5-field DEFER:** (1) *Run the scenario* — confirmed absent by grep across
  `schemas/`. (2) *Spec check* — CAPABILITIES forward-rule 3 ("supported means schema-validated
  and test-covered") governs new **capabilities**; the log is an existing telemetry artifact
  shipped under RFC-009 R6 without one, so this slice inherits the gap rather than creating it.
  No rule requires S3a to close it. (3) *History check* — none. (4) *Same-class check* — the
  class is "R6 telemetry artifacts"; the log is its only member, so there is no unswept sibling.
  (5) *Residual risk* — the format is written by exactly one function and now read by two, and
  REQ-1c pins the two readers to identical malformed-line behavior, which is the practical
  guarantee a schema would buy. Residual is drift if a third writer ever appears.
  **To be filed as a GitHub issue at step 9.**

- **DEFER-4: the two log readers diverge below the version field, deliberately.** `loadInjectState`
  filters `event` and `surface` and skips entries with a malformed `access_count_at_inject`; the
  clerk's `_parseLogForConversion` does neither, and coerces with `|| 0` at `em-consolidate.mjs:1932`.
  **5-field DEFER:** (1) *Run the scenario* — read both at `838b224`; the divergence is in the
  source, not hypothetical. (2) *Spec check* — no requirement mandates identical parsing; they
  answer different questions (the clerk aggregates conversion over all rows, this reader answers
  "was this pointer read"). No enforcement obligation. (3) *History check* — RFC-015 R2 warns
  that "a second chain-walker would drift the way second parsers do", which is why the version
  field is shared structurally rather than tested. (4) *Same-class check* — the class is "readers
  of activation-log.jsonl", now exactly two, both enumerated here and both dispositioned. (5)
  *Residual risk* — a future format change that touches `entries[]` shape rather than `v` could
  land in one reader only. Detection would be a silently wrong re-surface decision, which is
  advisory-only and fails open. **To be filed as a GitHub issue at step 9.**

- **DEFER-6: the read-boundary count pin is evadable by departing from the local idiom.** It
  covers `fs.`-prefixed `readFileSync`/`openSync`/`readSync`/`readFile`/`createReadStream` in the
  two named event-plane files. It does not catch an `fs/promises` import, a destructured or
  aliased import, or a read added to a third file the hook imports. **5-field DEFER:** (1) *Run
  the scenario* — each evasion is constructible by hand; none appears in either file today
  (measured: zero `fs/promises`, zero `createReadStream`, zero destructured `fs` imports).
  (2) *Spec check* — `RFC-009:47` requires the mirror to make a quiet patch a CI failure. It does
  not specify the mechanism, and before this slice there was **no** mechanical check of the read
  set at all, so this advances compliance rather than falling short of a prior bar; but the claim
  must be scoped, which R2-G4 forced and Listing L4's comment now states. (3) *History check* —
  round 1 F1 killed the previous mechanism outright; round 2 G4 scoped this one. (4) *Same-class
  check* — the class is "mechanical guards over the event plane's I/O"; the only sibling is the
  `env_independence` fixture, which is behavioral and equally unable to see an unexercised code
  path. Both are dispositioned: keep, with stated ceilings. (5) *Residual risk* — a determined
  contributor can add an undeclared read that CI does not catch; a careless one cannot. Detection
  falls back to code review, which is where it sat before this slice. **To be filed as a GitHub
  issue at step 9**, proposing an AST-based or lint-based successor.

- **DEFER-5: the 64 KiB tail narrows the RFC's stated join window.** Full analysis in §7 C2b.
  **5-field DEFER:** (1) *Run the scenario* — `t12c_scrollout_treated_unread` reproduces it as a
  passing, pinned behavior rather than a bug. (2) *Spec check* — RFC-015:114 already declares a
  rotated log "unread by definition" and `:116` already accepts within-window lower bounds, so the
  spec sanctions this direction of degradation; it does not sanction leaving it undocumented,
  which is why C2b states it. (3) *History check* — none; this is the first read-side consumer of
  the log. (4) *Same-class check* — the sibling window-narrowing mechanism is the writer's 1 MiB
  drop-at-cap (`activation-log.mjs:7`), which pushes the same direction and is equally unfixed
  here. (5) *Residual risk* — an already-read pointer re-surfaces on every prompt until it is read
  again. Noisy, never silent, never a lost pointer; wrongful suppression is impossible by
  construction. Raising the tail is a one-constant change if measurement justifies it.
  **To be filed as a GitHub issue at step 9.**

## §18 Done Criteria

- [ ] All MUST rows in §4 green.
- [ ] The negative control (`t15_mirror_boundary_drift`) observed RED before green.
- [ ] `shasum -a 256 .claude/hooks/activation-hook-run.mjs` still equals
      `ec8ac617761fb4cbac3b20990e413d9800d9f74d1d212796b495517a0114e11c` — the deployed copy was
      never edited in place. (`git status` cannot prove this: the path is untracked and always
      reports `??`.)
- [ ] CI green on the real workflow run, verified by `gh run list`, not `gh pr checks`.
- [ ] Every deferred finding has an issue / comment / violation artifact (Rule 18 step 9).

## §19 Review Consensus (Rule 18)

Reviewer this slice: **pi / kimi-coding k3 on a private herdr seat** (operator-directed this
session), reviewing this plan plus the Appendix A listings BEFORE the build, then the frozen
diff after.

**Plan-time audit already run.** `negative-scenario-planner` (canonical prompt inlined by the
orchestrator — see §19.2) returned **HOLD** with 2 MUST and 4 SHOULD items. All six are folded
into this plan: REQ-14/REQ-15 (code-derived validator + source-drift sub-case), REQ-1b
(entry-level skip), EC4b/EC4c (boundary sub-cases), REQ-8b (`access_count_at_inject` sourcing),
REQ-1c + G2 (version parity), and §17 DEFER-2 (Windows). The audit independently **verified**
three things this plan had only asserted: the C1 loop invariant holds by construction, the
EC7 prompt-path fixture cannot vary (it registers no playbook), and POSIX rename-while-open is
safe (runtime probe). Those are settled and are not reviewer questions.

Open questions the round-1 reviewer must answer:

1. **(highest severity)** REQ-14 now requires the validator's code side to come from a regex
   scan of real `fs.readFileSync`/`openSync`/`readSync` call sites in `activation-hook-run.mjs`,
   diffed bidirectionally. Is a source scan actually sound, or does it merely move the
   self-fulfilling problem (a read reached through a helper, an aliased `fs`, or a dynamic path
   would evade the scan)? If it is not sound, what is — and is an exported
   `EVENT_TIME_READS` constant plus a lint forbidding bare `fs.*` in this file better?
2. Is `merged.resurface_playbooks` the right way to feed the prompt path, versus computing
   `merged.session_start` there and accepting the break of the symmetry invariant documented at
   `activation-hook-run.mjs:566-568`?
3. REQ-4 widens the RFC's literal "equals" to `≤` so a backward-moved counter fails open
   (§12 state J). Is widening the RFC's wording in the plan acceptable, or must the RFC text
   change too?
4. Is 64 KiB the right tail against a 1 MiB cap, given the clerk rotates on cadence rather than
   on size, so a busy project can sit near the cap with the newest playbook inject row pushed
   outside the window?

### 19.2 Plan-time audit record

| Pass | Auditor | Verdict | Blockers | Disposition |
|---|---|---|---|---|
| NSP | `negative-scenario-planner` (prompt inlined; disciplines #14-#20 not reconstructed, disclosed) | **HOLD** | 2 MUST, 4 SHOULD | all folded; see the REQ rows cited above |

| Pass | Reviewer | Provider/Model | Blocker count | Verdict | Artifact |
|---|---|---|---|---|---|
| 1 (plan + listings) | herdr `drv-rfc015-s3a` | pi / kimi-coding k3 | 4 (F1-F4) | **HOLD** | 20 findings, 1.2M read, $1.313 |
| 2 (revised plan) | herdr `drv-rfc015-s3a-r2` | pi / kimi-coding k3 | 3 (G1-G3) | **HOLD** | 10 findings, 2.3M read, $1.665 |
| 3 (frozen diff `a864ca6`) | herdr `drv-rfc015-s3a-r3` | pi / kimi-coding k3 | **0** | **ACCEPT** | 2 NITs, 1.0M read, $0.850 |

### 19.3 Round-3 disposition (frozen diff)

ACCEPT with zero blockers and zero P2/P3. The reviewer independently confirmed: the
`matchActivation` restructure is behavior-preserving for every non-prompt path; the tail
arithmetic is exact-boundary-correct with the boundary legs proving it; the self-loop terminates
only on a real read as RFC-015:117 specifies; the advisory ceiling holds on every new path
(`loadInjectState` totally wrapped, the hook's prompt block fully inside try/catch,
`sessionStartStatus` pure and total, `main().catch(exit 0)` unchanged); the 29 legs are genuinely
falsifiable, with the append, rotation and scroll-out mechanics pinned by t6, t8b and t12c
respectively; and **zero scope creep** — every hunk traces to a plan Listing.

| # | Sev | Resolution |
|---|---|---|
| H1 | NIT | **Taken.** `const out = {}` → `Object.create(null)` in `loadInjectState`. An episode id of literal `"__proto__"` would otherwise hit the prototype setter, so `hasOwnProperty` would never find it and that playbook would re-surface forever. Fail-open and unreachable with real date-prefixed ids, but the class is removable for free |
| H2 | NIT | **Taken (doc only).** §13 EC3 cited a `t10_fail_open_race` leg that does not and should not exist; §14's t14 description carried pre-R1-F1 "SCANNED out of the call sites" wording for a mechanism that never shipped. Both corrected |

**Reviewer observation carried forward, deliberately not "fixed":** `read_call_sites` counts
`fs.readFileSync(0, 'utf8')` at `activation-hook-run.mjs:543` — the stdin read — as a call site.
The pin is a blunt occurrence count by design and the contract `_doc` says so. Recorded here so a
future contributor does not "correct" the hook count to 5 and trip CI.

### 19.2 Round-2 disposition — and why there is no round 3 on the plan

Round 2 confirmed the round-1 fold is substantively faithful, in its own words: F2/F3/F4
genuinely fixed, the architecture endorsement standing, the counts 6/3 exactly right, the step
ordering now correct, and REQ-1c's ACCEPT-WITH-MOD well-reasoned. **What failed was the fold's
own verification apparatus.** All 10 findings folded:

| # | Sev | Resolution |
|---|---|---|
| G1 | P1 | Steps 1.4/1.9 moved out of table cells into fenced blocks. A `\|` escaped for markdown makes `grep -E` match a literal pipe and return 0. Both commands re-run and measured |
| G2 | P1 | Step 1.1 now greps an introduced sentinel (`Amended by RFC-015 R7b`, baseline 0 measured) instead of a raw count whose baseline was 4, not 0 |
| G3 | P1 | L8 sub-case (c) rebuilt: full `fs.cpSync` repo copy (a stub exits 2, not 1), and the assertion now matches the count-pin message `/has 7 fs read call site\(s\), contract pins 6/` instead of `tags.json`, which that message never contains |
| G4 | P2 | Counted regex widened to `readFile`/`createReadStream`; L4's overclaim replaced with a stated ceiling; §17 DEFER-6 added with the evasion set measured absent |
| G5 | P3 | `?? 0` wording corrected in EC5, `t4d`, and the §14 catalog |
| G6 | P3 | §A.0 break-input row marked N/A; §15's inert `--only` dropped |
| G7 | P3 | §A.1 lint note re-measured: two self-referential matches, not one |
| G8 | NIT | §10 "17 legs" → 29 |
| G9 | NIT | Build-order prose realigned to the table |
| G10 | NIT | REQ-14b restated with repo-relative paths, matching L3 |

**Stopping rule applied (§19, cap of 2 rounds).** Both rounds returned HOLD, but round 2's
blockers were a single class: verify commands whose expected values I asserted rather than ran.
The rule says a repeat on one class means fixing the boundary, not iterating the patch. So
instead of a third plan review I changed the method: **every verify in the step table now greps
a string this slice introduces, and every baseline it depends on was executed and recorded**
(measured at `838b224`: `Amended by RFC-015 R7b` 0; `P1-S3a` 0; `EVENT_TIME_READS`,
`resurface_playbooks`, `pickResurfacePlaybook`, `checkEventTimeReads`, `loadInjectState` all 0;
hook read sites 6; lib read sites 0; evasion set 0 in both files). The build itself is the
remaining check on this layer: each verify runs for real, and a wrong expected value halts the
builder under the §A.3 STOP protocol rather than passing silently. Review round 3 is reserved
for the frozen diff, where it catches a different class.

### 19.1 Round-1 disposition

All 20 findings ACCEPTED and folded except one ACCEPT-WITH-MOD. The reviewer endorsed the
architecture unchanged: `resurface_playbooks` over `session_start` (Q2), the fail-open posture,
the C1 construction, and REQ-8b sourcing.

| # | Sev | Verdict | Resolution |
|---|---|---|---|
| F1 | P1 | ACCEPT | REQ-14/14b/15 + L3 + L4 rewritten: declared `EVENT_TIME_READS` constant extracted from source, plus a per-file read-call-site count pin. The literal-path scan is gone; it extracted nothing |
| F2 | P1 | ACCEPT | `loadInjectState` relocated to `scripts/lib/activation-log.mjs`; hook reaches it by dynamic import. Unblocks 8 legs |
| F3 | P1 | ACCEPT | `t8b_aci_source` arrange inverted to aci 74 / row 73 |
| F4 | P1 | ACCEPT | L6d coerces non-finite to 0; EC5 reworded; EC5b added |
| F5 | P2 | ACCEPT | Listing L4b added with the exact `:110` wiring anchor and the void-and-push convention |
| F6 | P2 | ACCEPT | All three L8 sub-cases now assert stdout `json.status`/`json.errors` |
| F7 | P2 | ACCEPT | Phantom `BREAK_BOUNDARY` / `--only` removed from §15, §A.9 and the step table |
| F8 | P2 | ACCEPT | 29 everywhere: group headers, total, L7 table, step 1.15 verify |
| F9 | P2 | ACCEPT | Step 1.5 expects 1, step 1.6 expects 2 |
| F10 | P2 | ACCEPT | Listing L2c added, splitting the `:167` slice bullet |
| F11 | P2 | ACCEPT | Listing L2d added, amending `:114` to `≤` |
| F12 | P2 | ACCEPT | §7 C2b + §17 DEFER-5 + `t12c_scrollout_treated_unread` |
| F13 | P3 | ACCEPT | `t2` now asserts byte-identity against a behavior-changing log, not mtime |
| F14 | P3 | ACCEPT | Resolved free by F2: the reader uses the lib's own `LOG_FORMAT_VERSION` |
| F15 | P3 | ACCEPT | L6a note corrected — the anchor IS unique at `:427`; header now `EDIT ×3` |
| F16 | P3 | ACCEPT | §6 counts corrected (520, 228); REQ-18 anchor corrected to `:1806-2045` |
| F17 | P3 | ACCEPT | Step 1.11's command moved out of the table cell, no escape mangling |
| F18 | NIT | ACCEPT | `t5` parses `additionalContext` before counting |
| F19 | NIT | ACCEPT | Build cap recorded in §5 Non-Goals |
| F20 | NIT | ACCEPT | `source_scope: null` recorded in §5 as deliberate |
| REQ-1c | — | **ACCEPT-WITH-MOD** | Reviewer proposed exporting `_parseLogForConversion` for a runtime parity test. Declined: `em-consolidate.mjs` has zero exports and adding one pulls this slice into that module's init surface (#628 territory). Replaced with a **structural** guarantee — the reader lives in the lib that owns `LOG_FORMAT_VERSION`, so the version dimension cannot drift. Remaining divergence documented in §17 DEFER-4 |

**One ordering defect I found while folding, not reviewer-reported:** the original step table
wrote the contract and wired the validator before the step that adds the lib's read call sites,
so step 1.5 would have failed on correct work. The table is now in dependency order with two
non-editing count-check steps (1.4, 1.9) guarding the pinned numbers.

## §20 Lessons Encoded

| Lesson | One-line rule | Enforced in |
|---|---|---|
| deployed-vs-tracked copy | edit the git-tracked source, never the deployed copy | §16, §A.2 rule 10 |
| `…7918` verify-the-strong-claim | E2E drives the real hook; CI verified via `gh run list` | §15, §18 |
| red-then-green | the boundary validator is observed failing before it is trusted | §14 Group 5, §A.9 |
| bp1 step-9 5-field DEFER | every DEFER carries all 5 fields | §17 |
| canonical-agent dispatch | `negative-scenario-planner` ran before §7 was written | §7 |
| compound-bash gate | one command per verify | §A.2 rule 7 |
| seat-brief hard rules | seats never invoke `em-*` at all | §A.2 rule 9 |

---

# Appendix A: Mechanical Execution Spec

## A.0 Target-toolchain instantiation

| Key | Value for this plan |
|---|---|
| Language / runtime | Node.js 20+, `.mjs` ESM, zero deps |
| Runtime check | `node --version` → `v20` or higher |
| Test-runner shape | `node tests/test-rfc-015-p1-s3a-resurfacing.mjs` |
| New-function phrasing | `function fnName(args)` (module-local) / `export function fnName(args)` |
| Portable break-input override | **N/A for this slice (R2-G6).** No break flag exists or is added. The negative control is Listing L8 sub-case (c), which plants real drift into a throwaway repo copy rather than toggling a break input |
| Search tool for verifies | `grep -c` / `grep -n` from the repo root |
| Repo-specific done-commands | `node tools/deploy-audit.mjs` |

## A.1 Forbidden-phrase lint (run before marking the plan ready)

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/rfc-015-p1-s3a.md
```

**Observed at freeze (re-measured, R2-G7).** The first run returned one substantive match — the
word `choose` in Listing L6d's code comment — which was reworded to `select`. The current run
returns **two** matches, both self-referential: this section's own command line, and the prose
sentence immediately below it that quotes the phrase list. **No substantive match remains**, and
none falls inside a §A.5 block or a §A.7 step-table row. (An earlier draft of this note claimed
"exactly one match, line 525"; that was asserted from an earlier state of the file and was
false — the same asserted-not-measured class as R2-G1/G2.)

**Caveat (lesson `…2f5d`), stated rather than hidden:** line-based `grep -n` cannot see a
phrase wrapped across two lines, so this lint is a first pass, not a proof. A reading pass over
Appendix A was done by the plan author at freeze. The reviewer is asked to treat Appendix A's
prose as unlinted and read it directly.

## A.2 Executor contract (copy verbatim into the handoff)

1. Do the steps in numeric order. Do not skip, reorder, or batch.
2. Each step names exactly which file, the exact change, and how to verify it.
3. **Make no design decisions.** If a step is ambiguous, or the anchor text is not found
   verbatim, **STOP and ask** (§A.3) — do not guess or pick the closest match.
4. Run the verify command after each step. If it fails, fix only that step.
5. **Edit exactly ONE file per step.**
6. Run no command outside the per-step verifies and the slice test command.
7. **Each verify command is a single command** — no `;`, `&&`, `||`, pipes, or subshells.
8. Do not commit, push, or open a PR. The orchestrator commits.
9. **NEVER invoke any `em-*` script for any reason** — not `--help`, not `--dry-run`, not a
   diagnostic. The test harness, which spawns with BOTH an explicit `cwd` and `HOME` into a
   fixture, is the only permitted runner. Never write to `.episodic-memory/` or
   `~/.episodic-memory/`.
10. **The ONLY writable hook file is `plugins/claude-code-activation/hooks/activation-hook-run.mjs`.**
    `.claude/hooks/activation-hook-run.mjs` is a deployed, git-UNTRACKED copy. Editing it
    produces a green local run and an empty PR diff. Never touch it.
11. No aspirational output: every printed "checking X" is backed by an assertion performing X.

## A.3 STOP-and-ask protocol

```text
STOP — step <n.m> blocked.
Reason: <anchor not found | ambiguous instruction | verify failed after fix>.
File: <path>
Expected anchor (verbatim): <text>
What I found instead: <actual surrounding text, ±3 lines>
Question: <the single decision the plan owner must make>
```

## A.4 Pre-flight (step 1.0)

| Check | Command | Expected (measured at `838b224`) |
|---|---|---|
| On the right branch | `git branch --show-current` | `feat/rfc-015-p1-s3a` |
| Deployed hook copy checksum | `shasum -a 256 .claude/hooks/activation-hook-run.mjs` | `ec8ac617761fb4cbac3b20990e413d9800d9f74d1d212796b495517a0114e11c` |
| Baseline green | `node tests/test-activation-sessionstart.mjs` | `69 passed, 0 failed` |
| Baseline green | `node tests/test-contract-mirror-009.mjs` | `3/3 pass` |
| Runtime | `node --version` | `v20` or higher (observed `v26.0.0`) |

> **Why a checksum and not `git status` (build-round defect, 2026-07-29).** An earlier draft
> checked `git status --porcelain .claude/hooks/activation-hook-run.mjs` → empty. That is
> **unsatisfiable**: the whole `.claude/hooks/` tree is untracked and un-ignored, so the path
> always reports `??` regardless of content, and the check cannot tell a pristine deployed copy
> from a silently edited one — the two states it exists to separate. The builder correctly
> STOPped on it rather than working around it. A checksum detects the thing actually at risk
> (an edit to the deployed copy instead of the tracked source) and is re-run in §18.

## A.5 Shared constants

```js
// scripts/lib/activation-log.mjs — module scope, beside ACTIVATION_LOG_MAX_BYTES.
// NOT in the hook (R1-F2): the reader lives in the lib so tests can import it.
export const RESURFACE_TAIL_MAX_BYTES = 65536 // 64 KiB tail (§7 C2) against the 1 MiB log cap

// plugins/claude-code-activation/hooks/activation-hook-run.mjs — module scope.
// Unexported and unreferenced by runtime code; the validator parses it from source.
const EVENT_TIME_READS = ['trigger-index.json', 'lesson-suppress.json', 'lesson-suppress.schema.json', 'manifest.json', 'activation-log.jsonl']
```

## A.7 Per-slice step tables

**Files this slice may touch:** `plugins/claude-code-activation/hooks/activation-hook-run.mjs`,
`scripts/lib/activation-match.mjs`, `scripts/validate-rfc-009-contract-mirror.mjs`,
`docs/rfcs/RFC-009-lesson-activation.contract.json`, `docs/rfcs/RFC-009-lesson-activation.md`,
`docs/rfcs/RFC-015-playbook-registration-audit.md`, `tests/test-contract-mirror-009.mjs`,
`tests/test-rfc-015-p1-s3a-resurfacing.mjs`, `.github/workflows/tests.yml`.
**Read-only:** everything else, especially `.claude/hooks/**`.

> **Sequencing (standing rule, #626 arc 2026-07-25):** a low-executor plan attaches its
> verbatim Appendix A listings to the **FIRST** review round, not the second. The listings below
> were authored after the plan-time negative-scenario matrix was folded in (§7), and are frozen
> together with this plan before review round 1. The reviewer sees plan **and** listings in one
> pass. Nothing here waits on the reviewer's answers.

**Build order (R2-G9, aligned to the table).** Steps run in numeric order: **1.1-1.2**
documentation; **1.3-1.10** the code change (lib reader, hook, matcher), with **1.4** and **1.9**
as non-editing count checks; **1.11** the contract, which can only be written once the counts it
pins are real; **1.12-1.13** the validator; **1.14-1.16** tests and CI.

### Listing L1 — `docs/rfcs/RFC-009-lesson-activation.md` (step 1.1, EDIT ×3)

> **Scope correction (R2-G2 fallout).** An earlier draft asserted, on a scout's report, that
> `activation-log.jsonl` appeared **nowhere** in RFC-009 and that one edit at `:47` sufficed.
> Measured: it appears **4 times**. The scout claim was false and I propagated it without
> re-running the grep. None of the four sanction an event-time READ, so the amendment's substance
> stands — but two of them describe the log as having exactly ONE consumer (the clerk), and this
> slice adds a second. Leaving them untouched would make RFC-009 self-contradictory, so L1 is
> three edits, not one.

**L1b (`:147`)** — the telemetry paragraph's single-consumer framing. `ANCHOR`:

```text
This log is telemetry, not memory — working data the clerk consumes, not a second knowledge store (P1).
```

`REPLACE`:

```text
This log is telemetry, not memory — working data the clerk consumes, not a second knowledge store (P1). **Amended by RFC-015 R7b:** the event plane is a SECOND consumer, read-only and bounded to a 64 KiB tail, for the unread-pointer join alone (R7a). It derives no knowledge from the log and writes nothing back; the clerk remains the only consumer that rotates or deletes it. Telemetry-not-memory is unchanged: the event plane reads two numbers per row, never body content.
```

**L1c (`:252`)** — the data-artifact table row. `ANCHOR`:

```text
| `activation-log.jsonl` (R6) | telemetry, loss-OK; bound owner = hook (drop+stderr), compaction = clerk rotate-and-consume; torn lines skipped+counted |
```

`REPLACE`:

```text
| `activation-log.jsonl` (R6) | telemetry, loss-OK; bound owner = hook (drop+stderr), compaction = clerk rotate-and-consume; torn lines skipped+counted. Readers: clerk (rotate-and-consume) AND, per RFC-015 R7b, the event plane (read-only 64 KiB tail, fail-open, never rotates) |
```

**L1a (`:47`)** — the strict read boundary itself:

`ANCHOR` (verbatim substring on line 47):

```text
hooks read purpose-built artifacts only — not `index.jsonl`, not `tags.json`, not environment context — and anything event-time consumers need is precomputed into those artifacts at build time.
```

`REPLACE` with:

```text
hooks read purpose-built artifacts only — not `index.jsonl`, not `tags.json`, not environment context — and anything event-time consumers need is precomputed into those artifacts at build time. **Amended by RFC-015 R7b (2026-07-29):** the adapter's own append log (`.episodic-memory/activation-log.jsonl`, written by this same adapter under R6) is a THIRD sanctioned event-time read, bounded to a 64 KiB tail, fail-open (absent/unparseable disables re-surfacing and never affects injection). It is sanctioned because it is an artifact this adapter itself produces in the same store, carrying no substrate content — not a general loosening: `index.jsonl` and `tags.json` remain forbidden. The sanctioned set is mirrored as `event_time_reads` in the contract JSON and diffed against the hook source in CI.
```

### Listing L2 — `docs/rfcs/RFC-015-playbook-registration-audit.md` (step 1.2, EDIT ×2)

**L2a** — fix the stale rotation anchor. `ANCHOR`:

```text
the clerk rotates and consumes it (`em-consolidate.mjs:1568-1606`), so all R7 joins are per-rotation-window (see R7c)
```

`REPLACE`:

```text
the clerk rotates and consumes it (`em-consolidate.mjs:1806-2045`, `clerkComputeConversion` at `:1964`, atomic rename at `:2023`), so all R7 joins are per-rotation-window (see R7c)
```

**L2b** — record the split. `ANCHOR`:

```text
| P1-S3 | pending | — | — | |
```

`REPLACE`:

```text
| P1-S3a | pending | — | — | R7a re-surfacing + the full R7b amendment package. Split from P1-S3 by operator decision 2026-07-29; plan `docs/plans/rfc-015-p1-s3a.md`. |
| P1-S3b | pending | — | — | R7c `playbook-unread` doctor check + scoped T13. Hard dep on S3a (it counts inject rows only S3a produces). |
```

**L2c (R1-F10)** — split the slice bullet itself. Without this the RFC still defines P1-S3 as
one slice two sections above the ledger that records the split. `ANCHOR` (line 167, verbatim):

```text
- **P1-S3** — R7 unread-pointer re-surfacing: adapter re-render leg + the full read-boundary amendment package (RFC-009 text revision, `tests/test-contract-mirror-009.mjs`, environment-independence/payload-schema fixtures — round-2 N3) + `playbook-unread` doctor check (folds the 2026-07-26 follow-through finding: nine injections, zero reads).
```

`REPLACE`:

```text
- **P1-S3a** — R7a unread-pointer re-surfacing (adapter re-render leg) + the full read-boundary amendment package (RFC-009 text revision, the `event_time_reads` contract-mirror surface with its call-site count pin, environment-independence/payload-schema fixtures — round-2 N3). Split from P1-S3 by operator decision 2026-07-29.
- **P1-S3b** — R7c `playbook-unread` doctor check (folds the 2026-07-26 follow-through finding: nine injections, zero reads). Hard dep on S3a: it counts inject rows that only S3a's re-surface leg produces.
```

**L2d (R1-F11)** — record the `≤` widening in the RFC, not only in the plan. `ANCHOR`:

```text
the playbook's current `access_count` on its trigger-index row equals the `access_count_at_inject` snapshot of its latest `session_start`/`per_prompt` inject row in the activation log
```

`REPLACE`:

```text
the playbook's current `access_count` on its trigger-index row is less than or equal to the `access_count_at_inject` snapshot of its latest `session_start`/`per_prompt` inject row in the activation log (equality is the normal case; `<=` rather than `==` so a backward-moved counter — index rollback or corruption — fails OPEN to an extra advisory render rather than suppressing the pointer permanently)
```

### Listing L3 — `docs/rfcs/RFC-009-lesson-activation.contract.json` (step 1.11, EDIT)

`ANCHOR` (the closing of `activation_flags`, immediately before `"activation_fields"`):

```json
  "activation_fields": [
```

`REPLACE`:

```json
  "event_time_reads": {
    "_doc": "RFC-009 R4 read boundary as amended by RFC-015 R7b. `files` is the COMPLETE set of artifacts the event plane may read; it is diffed bidirectionally against the EVENT_TIME_READS constant declared in activation-hook-run.mjs. `read_call_sites` pins how many fs.readFileSync/openSync/readSync occurrences each event-plane file may contain: adding an undeclared read changes the count and fails CI even if the contributor never touches the constant. Validated by scripts/validate-rfc-009-contract-mirror.mjs.",
    "files": [
      "trigger-index.json",
      "lesson-suppress.json",
      "lesson-suppress.schema.json",
      "manifest.json",
      "activation-log.jsonl"
    ],
    "read_call_sites": {
      "plugins/claude-code-activation/hooks/activation-hook-run.mjs": 6,
      "scripts/lib/activation-log.mjs": 3
    }
  },
  "activation_fields": [
```

> **Builder note (corrected, R1-F1).** `manifest.json` and `lesson-suppress.schema.json` are
> pre-existing reads (`activation-hook-run.mjs:119`, `:469`) the prose boundary never
> enumerated; they are listed because the constant must describe reality. The counts come from
> `838b224`: the hook has 6 read call sites (`:119`, `:178`, `:264`, `:469`, `:502`, `:540`)
> and gains **zero** in this slice because the reader lands in the lib; the lib has 0 today and
> gains exactly 3 (one `openSync`, two `readSync`). An earlier draft of this plan claimed a
> regex could scan literal path arguments out of the call sites — it cannot, every real site
> passes a variable, so the scan returned nothing. The count pin replaces it.

### Listing L4 — `scripts/validate-rfc-009-contract-mirror.mjs` (step 1.4, APPEND)

Add at end of file, before any final export block. Uses the file's existing `diffBoth` helper:

```js
// RFC-015 R7b: the event-time read boundary is enforced in TWO halves, because
// neither half alone is sufficient.
//
//   (1) DECLARED SET — the EVENT_TIME_READS array literal in the hook source,
//       diffed bidirectionally against contract.event_time_reads.files. This is
//       readable and reviewable, but a contributor could add a read and simply
//       not update the constant.
//   (2) COUNT PIN — the number of read-API occurrences in each event-plane file,
//       compared against contract read_call_sites. This is what catches a new
//       read that the contributor did not declare in the constant.
//
// HONEST SCOPE (R2-G4). The pin covers `fs.`-prefixed readFileSync / openSync /
// readSync / readFile / createReadStream. It does NOT catch: an `fs/promises`
// import, a destructured or aliased import (`import {readFileSync}` / `const rf =
// fs.readFileSync`), or a read added to a THIRD file the hook imports. Those are
// stylistic departures from every existing call site in these two files and are
// review-visible, but they are NOT mechanically blocked. The claim this check
// supports is "a new read written in the local idiom fails CI", not "no
// undeclared read is possible". RFC-009:47 asks the mirror to make a quiet patch
// a CI failure; before this slice there was NO mechanical check of the read set
// at all, so this is a real gain with a stated ceiling — see §17 DEFER-6.
//
// Extracting the literal PATH from each call site is NOT possible — every real
// site passes a variable (fs.readFileSync(triggerIndexPath, 'utf8')), so a
// path-scanning regex returns the empty set. The count pin is the workable
// mechanical proxy. Convention note: like diffBoth, these push into the shared
// module-level `errors` array and return nothing.
function extractEventTimeReadsConstant(hookSource) {
  // Anchored on the exact declaration. Non-greedy to the first closing bracket;
  // the constant is a flat array of string literals by contract.
  const m = /const\s+EVENT_TIME_READS\s*=\s*\[([\s\S]*?)\]/.exec(hookSource)
  if (!m) return null
  const out = []
  const litRe = /['"]([^'"]+)['"]/g
  let lit
  while ((lit = litRe.exec(m[1])) !== null) out.push(lit[1])
  return out.sort()
}

function countReadCallSites(src) {
  // R2-G4: widened beyond the three original spellings to the read APIs a
  // contributor might realistically reach for in this codebase's idiom.
  const m = src.match(/fs\.(?:readFileSync|openSync|readSync|readFile|createReadStream)\s*\(/g)
  return m ? m.length : 0
}

function checkEventTimeReads(contract) {
  const etr = contract && contract.event_time_reads
  if (!etr || !Array.isArray(etr.files) || !etr.read_call_sites || typeof etr.read_call_sites !== 'object') {
    errors.push('event_time_reads: missing or malformed in contract.json (expected {files:[...], read_call_sites:{...}})')
    return
  }
  const hookRel = 'plugins/claude-code-activation/hooks/activation-hook-run.mjs'
  const hookPath = path.join(repoRoot, hookRel)
  if (!fs.existsSync(hookPath)) {
    errors.push(`event_time_reads: hook not found at ${hookPath}`)
    return
  }
  const hookSource = fs.readFileSync(hookPath, 'utf8')
  const declared = extractEventTimeReadsConstant(hookSource)
  if (declared === null) {
    errors.push(`event_time_reads: no EVENT_TIME_READS constant found in ${hookRel}`)
  } else {
    diffBoth('event_time_reads', [...etr.files].sort(), declared)
  }
  for (const [rel, expected] of Object.entries(etr.read_call_sites)) {
    const p = path.join(repoRoot, rel)
    if (!fs.existsSync(p)) {
      errors.push(`event_time_reads: read_call_sites names a missing file ${rel}`)
      continue
    }
    const actual = countReadCallSites(fs.readFileSync(p, 'utf8'))
    if (actual !== expected) {
      errors.push(`event_time_reads: ${rel} has ${actual} fs read call site(s), contract pins ${expected} — a read was added or removed without updating the boundary contract`)
    }
  }
}
```

> **STOP conditions.** (a) `diffBoth` must exist with signature
> `diffBoth(label, contractList, codeList)` and push into a module-level `errors` array
> (verified present at `validate-rfc-009-contract-mirror.mjs:78`). (b) `repoRoot`, `errors`,
> `fs`, and `path` must all already be in scope in this module (all verified in scope). If any
> is absent, STOP (§A.3) rather than introducing it.

### Listing L4b — wiring (step 1.5, EDIT `scripts/validate-rfc-009-contract-mirror.mjs`)

`ANCHOR` (unique, `:110`):

```js
  checkActivationFlags(contract)
```

`REPLACE`:

```js
  checkActivationFlags(contract)

  // RFC-015 R7b: event-time read boundary (declared set + call-site count pin).
  checkEventTimeReads(contract)
```

> Void-and-push, matching every sibling check in this function. Do **not** write
> `errors.push(...checkEventTimeReads(contract))` — the function returns `undefined` and
> spreading it throws.

### Listing L5 — `plugins/claude-code-activation/hooks/activation-hook-run.mjs` (steps 1.8-1.11)

**L5a (step 1.8, EDIT)** — the read-boundary header. `ANCHOR`:

```text
// (REQ-14) — never index.jsonl content, tags.json, activation-classes.json,
```

`REPLACE`:

```text
// (REQ-14), plus a bounded 64 KiB TAIL of this adapter's own append log
// activation-log.jsonl (RFC-015 R7b — read on `prompt` events ONLY, fail-open:
// absent/unparseable disables re-surfacing and never affects injection)
// — never index.jsonl content, tags.json, activation-classes.json,
```

**L5b (step 1.9, APPEND to `scripts/lib/activation-log.mjs` — NOT the hook)**

> **R1-F2 (blocker) relocation.** An earlier draft put this function in the hook. The hook has
> zero exports and its top level runs `main()` then `process.exit(0)` (`:637-639`), so a test
> importing it dies before asserting. This lib is side-effect-free, already imported by the
> hook, and owns `LOG_FORMAT_VERSION` — which also discharges REQ-1c structurally.

```js
// RFC-015 R7b: bounded tail of this adapter's own append log. 64 KiB against the
// writer's 1 MiB cap (ACTIVATION_LOG_MAX_BYTES) — the log is rotated on clerk
// cadence, not at size, so it can sit near the cap and the tail must stay cheap
// on EVERY prompt event.
export const RESURFACE_TAIL_MAX_BYTES = 65536

// loadInjectState(dataDir) -> {episode_id: {access_count_at_inject:int, ts:string}} | null
// null means "log unavailable" and disables re-surfacing. {} means "readable, no
// qualifying rows" and leaves every declared playbook UNREAD by REQ-4's no-row
// clause. Never throws. See plan §12 for the exhaustive state table.
export function loadInjectState(dataDir) {
  try {
    const p = path.join(dataDir, ACTIVATION_LOG_NAME)
    let fd
    try {
      fd = fs.openSync(p, 'r')
    } catch {
      return null // states A / A2: absent, incl. the post-rotation steady state
    }
    let text
    try {
      const size = fs.fstatSync(fd).size
      if (size === 0) return {} // state B
      const start = size > RESURFACE_TAIL_MAX_BYTES ? size - RESURFACE_TAIL_MAX_BYTES : 0
      const len = size - start
      const buf = Buffer.allocUnsafe(len)
      fs.readSync(fd, buf, 0, len, start)
      text = buf.toString('utf8')
      if (start > 0) {
        // State D vs D2: we may have started mid-line. Read the single byte
        // BEFORE the window; if it is a newline the first line is whole and must
        // be kept. Otherwise drop the leading partial line. State D3: no newline
        // anywhere means one oversized line and nothing usable.
        const prev = Buffer.allocUnsafe(1)
        fs.readSync(fd, prev, 0, 1, start - 1)
        if (prev.toString('utf8') !== '\n') {
          const nl = text.indexOf('\n')
          text = nl === -1 ? '' : text.slice(nl + 1)
        }
      }
    } finally {
      try { fs.closeSync(fd) } catch {}
    }
    const out = {}
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue // states E / F: torn or garbage line
      }
      if (!row || typeof row !== 'object') continue
      // State G2: the module's OWN constant — the version dimension cannot drift
      // from the writer above or from the clerk's reader (REQ-1c, structural).
      if (row.v !== LOG_FORMAT_VERSION) continue
      if (row.event !== 'inject') continue // state G
      if (row.surface !== 'session_start' && row.surface !== 'per_prompt') continue // state G3
      if (!Array.isArray(row.entries)) continue // state G
      const ts = typeof row.ts === 'string' ? row.ts : ''
      for (const e of row.entries) {
        if (!e || typeof e !== 'object') continue
        if (typeof e.id !== 'string' || !e.id) continue
        // State G4 (REQ-1b): a malformed count is SKIPPED, never coerced. Coercing
        // it would make the join read "already read" and wrongly suppress a
        // genuinely unread pointer — the one inversion of fail-open.
        if (typeof e.access_count_at_inject !== 'number') continue
        if (!Number.isFinite(e.access_count_at_inject)) continue
        out[e.id] = { access_count_at_inject: e.access_count_at_inject, ts }
      }
    }
    return out
  } catch {
    return null // state H
  }
}
```

> **STOP condition.** `scripts/lib/activation-log.mjs` must already import `fs` and `path` and
> declare `LOG_FORMAT_VERSION` and `ACTIVATION_LOG_NAME`. If it imports neither `fs` nor `path`,
> STOP (§A.3) — adding imports is a design decision.

**L5b-hook (step 1.9b, APPEND to the hook)** — the boundary constant the validator parses:

```js
// RFC-015 R7b: the COMPLETE set of artifacts this event plane may read. Mirrored
// as event_time_reads.files in RFC-009-lesson-activation.contract.json and diffed
// in CI. Adding a read here without updating the contract fails validation; so
// does adding one to the code without listing it here.
const EVENT_TIME_READS = [
  'trigger-index.json',
  'lesson-suppress.json',
  'lesson-suppress.schema.json',
  'manifest.json',
  'activation-log.jsonl',
]
```

> `EVENT_TIME_READS` is intentionally unexported and unreferenced by runtime code — the hook
> cannot export (§L5b rationale) and the validator reads it from source. A linter flagging it
> as unused is expected; do not delete it.

**L5c (step 1.10, EDIT)** — feed the prompt path. `ANCHOR`:

```js
  const suppress = await loadSuppressSet(identity.root)
```

`REPLACE`:

```js
  // RFC-015 R7a: the prompt path needs the DECLARED session_start playbooks to
  // re-surface unread pointers. merged.session_start is deliberately computed on
  // the SessionStart branch only (see the SYMMETRY note above), so we attach a
  // narrow, separately-named field instead of populating that section here — the
  // R3 merged shape stays byte-identical. The playbooks trio is LOCAL-only by
  // contract (mergeSessionStart threads it unchanged; global never produces one).
  let injectState = null
  if (event.kind === 'prompt') {
    const localSS = sessionStartStatus(local)
    const pb = localSS.ok && localSS.value && Array.isArray(localSS.value.playbooks)
      ? localSS.value.playbooks
      : []
    if (pb.length) merged.resurface_playbooks = pb
    // The reader lives in the activation-log lib (R1-F2), reached the same way
    // the telemetry writer already is. Fail-open: any import or read failure
    // leaves injectState null, which disables re-surfacing and nothing else.
    try {
      if (ACTIVATION_LOG_LIB_PATH) {
        const logMod = await import(pathToFileURL(ACTIVATION_LOG_LIB_PATH).href)
        if (typeof logMod.loadInjectState === 'function') {
          injectState = logMod.loadInjectState(path.join(identity.root, '.episodic-memory'))
        }
      }
    } catch {
      injectState = null
    }
  }

  const suppress = await loadSuppressSet(identity.root)
```

**L5d (step 1.11, EDIT)** — pass it through. `ANCHOR`:

```js
    result = matchActivation(merged, event, identity, suppress, { max_matches: 3, max_tokens: 500 })
```

`REPLACE`:

```js
    result = matchActivation(merged, event, identity, suppress, { max_matches: 3, max_tokens: 500 }, injectState)
```

### Listing L6 — `scripts/lib/activation-match.mjs` (step 1.10, EDIT ×3 + APPEND)

**L6a (EDIT)** — expose the running budget. `ANCHOR`:

```js
  return { lines, overflowNote, entries };
}
```

> **R1-F15:** an earlier draft warned this substring was non-unique. It is **unique**, at line
> 427, the last line of `selectAndBound` (verified). No disambiguation is needed; a builder told
> to expect ambiguity may stall unnecessarily.

`REPLACE`:

```js
  // totalTokens is returned additively for RFC-015 R7a: matchActivation appends at
  // most one re-surfaced playbook line and must respect the SAME shared budget.
  // No existing caller reads this field.
  return { lines, overflowNote, entries, totalTokens };
}
```

**L6b (EDIT)** — restructure the prompt path. `ANCHOR`:

```js
    const entries = sanitizeEntries(index);
    if (entries.length === 0) return { lines: [], overflowNote: null, entries: [] };

    if (kind !== "prompt" && kind !== "tool") {
      // any other/unknown kind: empty, advisory (fail open).
      return { lines: [], overflowNote: null, entries: [] };
    }

    const candidates = candidatesForEvent(entries, event, index, identity);
    const surviving = filterSuppressed(candidates, suppress);
    const deduped = dedupByEpisodePreferPlaybook(surviving); // RFC-011 R2.9(b) one-per-episode + playbook-wins
    if (deduped.length === 0) return { lines: [], overflowNote: null, entries: [] };

    return selectAndBound(deduped, bounds);
```

`REPLACE`:

```js
    if (kind !== "prompt" && kind !== "tool") {
      // any other/unknown kind: empty, advisory (fail open).
      return { lines: [], overflowNote: null, entries: [] };
    }

    const entries = sanitizeEntries(index);
    // RFC-015 R7a: a zero-lesson index must NOT short-circuit the re-surface leg —
    // a project with one declared playbook and no trigger-bearing lessons is the
    // exact case R7a's mid-session registration clause targets (plan EC6).
    const candidates = entries.length === 0 ? [] : candidatesForEvent(entries, event, index, identity);
    const surviving = filterSuppressed(candidates, suppress);
    const deduped = dedupByEpisodePreferPlaybook(surviving);
    const base = deduped.length === 0
      ? { lines: [], overflowNote: null, entries: [], totalTokens: 0 }
      : selectAndBound(deduped, bounds);

    if (kind !== "prompt") return { lines: base.lines, overflowNote: base.overflowNote, entries: base.entries };

    const maxTokens = Number.isInteger(bounds && bounds.max_tokens) && bounds.max_tokens > 0 ? bounds.max_tokens : 500;
    const rendered = new Set(base.entries.map((e) => e.id));
    const pick = pickResurfacePlaybook(index && index.resurface_playbooks, injectState, suppress, rendered);
    if (pick) {
      const line = renderPlaybookLine(pick);
      const t = estimateTokens(line);
      // Playbooks consume ONLY the shared token budget, never a max_matches slot —
      // parity with the session-start playbook band (see the R3 note above).
      if (t <= maxTokens && base.totalTokens + t <= maxTokens) {
        base.lines.push(line);
        base.entries.push({
          id: pick.episode_id,
          effective_priority: pick.effective_priority ?? 0,
          rendered: "imperative",
          source_scope: pick.source_scope ?? null,
          // REQ-8b: sourced from the ROW's own access_count, NEVER from injectState.
          // Echoing the injectState snapshot forward would break the equality
          // invariant that lets a real read terminate re-surfacing.
          access_count_at_inject: pick.access_count ?? 0,
        });
      }
    }
    return { lines: base.lines, overflowNote: base.overflowNote, entries: base.entries };
```

**L6c (EDIT)** — the signature. `ANCHOR`:

```js
export function matchActivation(index, event, identity, suppress, bounds) {
```

`REPLACE`:

```js
export function matchActivation(index, event, identity, suppress, bounds, injectState) {
```

**L6d (APPEND)** — the picker, at end of file:

```js
// pickResurfacePlaybook(playbooks, injectState, suppress, excludeIds) -> row | null
// Pure. RFC-015 R7a: select at most ONE unread declared session_start playbook,
// round-robin by least-recently-surfaced. See plan §12 for the state table.
function pickResurfacePlaybook(playbooks, injectState, suppress, excludeIds) {
  if (!Array.isArray(playbooks) || playbooks.length === 0) return null; // state A
  if (!injectState || typeof injectState !== "object") return null; // state B
  const s = suppress instanceof Set ? suppress : new Set();
  const ex = excludeIds instanceof Set ? excludeIds : new Set();
  const unread = [];
  for (const p of playbooks) {
    if (!p || typeof p !== "object") continue; // state I
    const id = p.episode_id;
    if (typeof id !== "string" || !id) continue; // state I
    if (s.has(id)) continue; // state G
    if (ex.has(id)) continue; // state H
    const st = Object.prototype.hasOwnProperty.call(injectState, id) ? injectState[id] : null;
    if (!st) {
      // state F: never injected (or rotated away) => unread by definition, and
      // sorts FIRST so a fresh mid-session registration surfaces immediately.
      unread.push({ row: p, ts: "" });
      continue;
    }
    // R1-F4: coerce a non-finite row count to 0 (=> unread) rather than skipping
    // the candidate. `?? 0` alone is NOT enough — it catches only null/undefined,
    // so a string like "x" survives it and Number("x") is NaN. Skipping on NaN
    // would SUPPRESS a pointer on malformed input, the one inversion of fail-open.
    const rawCurrent = Number(p.access_count);
    const current = Number.isFinite(rawCurrent) ? rawCurrent : 0;
    const rawSnapshot = Number(st.access_count_at_inject);
    if (!Number.isFinite(rawSnapshot)) {
      // No usable snapshot is equivalent to no inject row => unread, sorts first.
      unread.push({ row: p, ts: "" });
      continue;
    }
    // state J: `<=` not `===` — a backward-moved counter stays on the fail-open
    // side (extra advisory line) instead of suppressing the pointer forever.
    if (current <= rawSnapshot) unread.push({ row: p, ts: typeof st.ts === "string" ? st.ts : "" });
  }
  if (unread.length === 0) return null; // state C
  unread.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.row.episode_id < b.row.episode_id ? -1 : a.row.episode_id > b.row.episode_id ? 1 : 0;
  });
  return unread[0].row; // states D / E
}
```

### Listing L7 — test harness (step 1.13, CREATE `tests/test-rfc-015-p1-s3a-resurfacing.mjs`)

Harness copied from the P1-S2 suite's proven shape, with the P1-S1 suite's cross-platform
`USERPROFILE` handling (that divergence is real — see §9 of the scout record — and the
Windows-safe form is the one to carry forward):

```js
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const HOOK = path.join(REPO, 'plugins/claude-code-activation/hooks/activation-hook-run.mjs')
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

let pass = 0, fail = 0
async function t(name, fn) {
  if (ONLY && name !== ONLY) return
  try { await fn(); pass++; console.log(`ok   ${name}`) }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.stack || e.message}`) }
}

function mkFixture(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `em-s3a-h-${tag}-`))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), `em-s3a-p-${tag}-`))
  fs.mkdirSync(path.join(proj, '.episodic-memory'), { recursive: true })
  return { home, proj, store: path.join(proj, '.episodic-memory') }
}
```

> **Builder note.** Every leg that drives the hook spawns it with BOTH an explicit `cwd` and
> `HOME`/`USERPROFILE` pointed into the fixture. No leg may invoke any `em-*` script (§A.2 rule
> 9); trigger-index and log fixtures are hand-written JSON, exactly as the P1-S2 suite writes its
> index rows directly. Unit-level legs import `loadInjectState` and `matchActivation` from
> `scripts/lib/*` directly — **never** import the hook (R1-F2).

**Per-leg specification.** Each row gives the arrange/act/assert with concrete values. The
builder writes the assertion literally; no leg asserts "non-empty" or "exit 0" alone.

| Leg | Arrange | Act | Assert (observed → expected) |
|---|---|---|---|
| `t1_tail_parse` | log with 3 inject rows for ids `AAA`,`BBB`,`AAA` (aci 1,2,5) | `import { loadInjectState } from '../scripts/lib/activation-log.mjs'` — **the lib, never the hook** (R1-F2: importing the hook runs `main()` and `process.exit(0)`, killing the test process) | returned map has exactly keys `AAA`,`BBB`; `map.AAA.access_count_at_inject === 5` (last wins) |
| `t1b_tail_bound` | log where id `HEAD_SENTINEL` is in the first row and `TAIL_SENTINEL` in the last, padded past 64 KiB | same | `'TAIL_SENTINEL' in map === true`; `'HEAD_SENTINEL' in map === false` |
| `t1b2_tail_exact_boundary` | log padded so the 64 KiB offset lands exactly after a `\n`, first tail row id `EDGE_SENTINEL` | same | `'EDGE_SENTINEL' in map === true` (not discarded) |
| `t1b3_tail_single_huge_line` | one 70 KiB line, no `\n` | same | deep-equals `{}` |
| `t1c_surface_filter` | one row `surface:'tool'` for id `TOOLONLY` | same | `'TOOLONLY' in map === false` |
| `t1d_version_skip` | one row `v:2` for id `V2ONLY` | same | `'V2ONLY' in map === false` |
| `t1e_entry_malformed_skipped` | row whose entry has `access_count_at_inject: null` for id `NULLACI` | same | `'NULLACI' in map === false` |
| `t2_no_read_off_prompt` | a log whose CONTENT would change the outcome if it were read (one inject row making the declared playbook look read) | drive `SessionStart`, then `PreToolUse`, each twice: once with that log present, once with it deleted | both surfaces produce byte-identical stdout across present-vs-absent. **R1-F13:** the earlier mtime assertion was vacuous — reads never move mtime and atime is unreliable under relatime. Byte-identity against a log that WOULD change behavior is the assertion that actually falsifies "no read happened" |
| `t3_arity_backcompat` | any index | call `matchActivation(idx, ev, id, sup, bounds)` with 5 args | deep-equals the same call made before this slice (golden captured in-test from a fixture with no `resurface_playbooks`) |
| `t4_unread_join` | playbook `PB1` row `access_count: 73`; log row aci `73` | drive `prompt` | stdout contains `READ PB1 before proceeding` |
| `t4b_no_row_is_unread` | playbook `PB1`; empty log file | drive `prompt` | stdout contains `PB1` |
| `t4c_log_text_never_rendered` | log row carrying `"project":"INJECT_SENTINEL_9f2a"` | drive `prompt` | stdout does NOT contain `INJECT_SENTINEL_9f2a` |
| `t4d_missing_access_count` | playbook row with `access_count: "x"` | drive `prompt` | no throw; stdout contains `PB1`. Coercion is `Number.isFinite(Number(x)) ? … : 0` — **not** `?? 0`, which catches only null/undefined and would leave `NaN` (R2-G5) |
| `t4e_backward_count` | row `access_count: 70`; log aci `73` | drive `prompt` | stdout contains `PB1` (state J: `70 <= 73` ⇒ unread) |
| `t5_one_line_max` | 3 unread playbooks | drive `prompt` | **parse stdout as JSON, take `hookSpecificOutput.additionalContext`, split on `\n`**, then count lines matching `^playbook \(playbooks\.json\)` === 1. **R1-F18:** matching against raw stdout yields 0 — the hook emits a single-line JSON envelope with escaped newlines |
| `t6_round_robin` | `PB1` ts `2026-01-01T00:00:00Z`, `PB2` ts `2026-01-02T00:00:00Z`, both unread | drive `prompt` twice, appending the produced inject row between runs | run 1 renders `PB1`; run 2 renders `PB2` |
| `t7_token_budget_only` | 3 lessons already filling `max_matches: 3`, 1 unread playbook, generous `max_tokens` | call the matcher directly | `lines.length === 4`; the 4th is the playbook line |
| `t7b_symlinked_log_still_fail_open` | `activation-log.jsonl` symlinked to a directory | drive `prompt` | exit 0; stdout has no `decision` key |
| `t8_entry_lockstep` | 1 unread playbook | call the matcher directly | `result.entries.length === result.lines.length` |
| `t8b_aci_source` | playbook row `access_count: 73`; log aci **`74`** | call the matcher directly | the appended entry's `access_count_at_inject === 73` (the ROW value) and `!== 74` (the snapshot). **R1-F3:** the earlier arrangement (row 73, aci 70) meant `73 > 70` ⇒ read ⇒ nothing re-surfaced ⇒ no entry existed to assert on. Inverting it makes the leg both discriminating and an exercise of state J |
| `t9_read_suppresses` | playbook row rebuilt to `access_count: 74`; log aci `73` | drive `prompt` | stdout does NOT contain `PB1` |
| `t9b_three_events_no_read` | playbook aci `73`, count `73` | drive `prompt` 3× appending each produced inject row | all 3 stdouts contain `PB1` (C1 persistence) |
| `t10_fail_open` | 5 sub-legs: absent / empty / truncated-mid-JSON / garbage / log-path-is-a-directory | drive `prompt` each | every leg exit 0, no `decision`, and the normal lesson line still present |
| `t11_suppress_wins` | `PB1` unread + listed in `lesson-suppress.json` | drive `prompt` | stdout does NOT contain `PB1` |
| `t12_no_double_render` | `PB1` unread AND matching a trigger phrase this event | drive `prompt` | `PB1` appears exactly once in stdout |
| `t12b_zero_lessons_still_resurfaces` | index with `entries: []`, one unread playbook | drive `prompt` | stdout contains `PB1` (EC6) |
| `t12c_scrollout_treated_unread` | playbook `PB1` row `access_count: 74`; its ONLY inject row (aci `73`) padded out beyond the 64 KiB window | drive `prompt` | `PB1` re-surfaces. Pins C2b's degraded-but-safe direction: a scrolled-out read looks unread, and never the reverse |
| `t16_env_independence_prompt` | as `r3_env_independence`, plus a growing log across the 4 variants | drive `prompt` ×4 | all 4 stdouts byte-identical |
| `t17_advisory_ceiling` | every fail-open fixture above | drive each | no stdout contains `decision`, `block`, or `permissionDecision`; every exit code === 0 |

### Listing L8 — `tests/test-contract-mirror-009.mjs` (step 1.14, EDIT)

Add two legs following the file's existing planted-drift pattern. Sub-case (c) is the one that
matters and MUST plant the drift in a throwaway copy of the hook SOURCE:

| Leg | Arrange | Assert |
|---|---|---|
| `t14_mirror_boundary_ok` | shipped contract + real hook source | validator exits 0 |
| `t15_mirror_boundary_drift` (a) | contract copy with `"tags.json"` appended to `event_time_reads.files` | exit 1; parse STDOUT as JSON and assert `json.status === 'drift'` and that `json.errors` names `tags.json` |
| `t15_mirror_boundary_drift` (b) | contract copy with `"activation-log.jsonl"` removed | exit 1; parse STDOUT as JSON and assert `json.status === 'drift'` and that `json.errors` names `activation-log.jsonl` |
| `t15_mirror_boundary_drift` (c) | **A full throwaway repo, not a stub.** `fs.cpSync(REPO_ROOT, tmp, {recursive:true, filter: p => !p.includes('/.git') && !p.includes('/node_modules')})`, then append one line `fs.readFileSync(path.join(dataDir, 'tags.json'), 'utf8')` inside the hook copy at `tmp/plugins/claude-code-activation/hooks/activation-hook-run.mjs`, leaving `contract.json` untouched. Invoke `node scripts/validate-rfc-009-contract-mirror.mjs --repo <tmp>` | exit **1** (not 2 — a stub repo exits 2 because the validator imports `scripts/lib/activation.mjs`, `em-trigger-index.mjs`, `activation-classes.json` and greps `README.md`). Parse STDOUT as JSON; assert `json.status === 'drift'` and that some entry of `json.errors` matches `/has 7 fs read call site\(s\), contract pins 6/`. **R2-G3:** the earlier assertion looked for the string `tags.json`, which the count-pin message never contains — the proof leg of the F1 fix could not pass on correct work |

### Listing L9 — `.github/workflows/tests.yml` (step 1.15, EDIT)

`ANCHOR`:

```yaml
      - name: Run RFC-015 P1-S2 consolidation-closure suite
        run: node tests/test-rfc-015-p1-s2-consolidation.mjs
```

`REPLACE`:

```yaml
      - name: Run RFC-015 P1-S2 consolidation-closure suite
        run: node tests/test-rfc-015-p1-s2-consolidation.mjs

      - name: Run RFC-015 P1-S3a resurfacing suite
        run: node tests/test-rfc-015-p1-s3a-resurfacing.mjs
```

> **#614 hazard.** The step name carries no `:` — an unquoted colon inside a YAML `name:` value
> parses as a nested mapping and broke Tests on PR #613. Keep it colon-free.

### Step table

**Ordering is load-bearing (R1 fold).** The contract pins `scripts/lib/activation-log.mjs` at 3
read call sites, which only becomes true after step 1.4. An earlier draft wrote the contract and
wired the validator FIRST, so step 1.5 would have failed on correct work. Code before contract,
contract before validator, validator before tests.

**Every verify below greps for a string this slice INTRODUCES, so the expected value is `1`
independently of any baseline.** Round 2 (G1, G2) killed the previous table because two verifies
used raw occurrence counts whose baselines I had asserted instead of measured — `activation-log.jsonl`
already appears 4× in RFC-009, not 0. Measured baselines at `838b224`, all confirmed by running
the command: `Amended by RFC-015 R7b` → 0; `P1-S3a` in RFC-015 → 0; `EVENT_TIME_READS`,
`resurface_playbooks`, `pickResurfacePlaybook`, `checkEventTimeReads`, `loadInjectState` → 0.

| Step | File | Kind | Action | Verify (observed → expected) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4 | every row passes |
| 1.1 | `docs/rfcs/RFC-009-lesson-activation.md` | EDIT ×3 | Listings L1a + L1b + L1c | `grep -c 'Amended by RFC-015 R7b' docs/rfcs/RFC-009-lesson-activation.md` → **`2`** (baseline 0, measured; L1a and L1b each carry the marker, L1c says "per RFC-015 R7b" and does not match) |
| 1.2 | `docs/rfcs/RFC-015-playbook-registration-audit.md` | EDIT ×4 | Listings L2a + L2b + L2c + L2d | `grep -c 'P1-S3a' docs/rfcs/RFC-015-playbook-registration-audit.md` → `2` (baseline 0, measured: slice bullet + ledger row) |
| 1.3 | `scripts/lib/activation-log.mjs` | APPEND | Listing L5b (reader + `RESURFACE_TAIL_MAX_BYTES`) | `grep -c 'export function loadInjectState' scripts/lib/activation-log.mjs` → `1` |
| 1.4 | — | — | Confirm the count the contract will pin | see the fenced command below this table → `3` |
| 1.5 | `plugins/.../activation-hook-run.mjs` | EDIT | Listing L5a (header comment) | `grep -c 'RFC-015 R7b' plugins/claude-code-activation/hooks/activation-hook-run.mjs` → `1` |
| 1.6 | `plugins/.../activation-hook-run.mjs` | APPEND | Listing L5b-hook (`EVENT_TIME_READS`) | `grep -c 'EVENT_TIME_READS' plugins/claude-code-activation/hooks/activation-hook-run.mjs` → `1` |
| 1.7 | `plugins/.../activation-hook-run.mjs` | EDIT | Listing L5c (prompt branch) | `grep -c 'resurface_playbooks' plugins/claude-code-activation/hooks/activation-hook-run.mjs` → `1` |
| 1.8 | `plugins/.../activation-hook-run.mjs` | EDIT | Listing L5d (pass the 6th arg) | `grep -c 'max_tokens: 500 }, injectState' plugins/claude-code-activation/hooks/activation-hook-run.mjs` → `1` |
| 1.9 | — | — | Confirm the hook gained NO read call site | see the fenced command below this table → `6` |
| 1.10 | `scripts/lib/activation-match.mjs` | EDIT+APPEND | Listings L6a-L6d (three EDITs + one APPEND) | `grep -c 'function pickResurfacePlaybook' scripts/lib/activation-match.mjs` → `1`; then `node tests/test-activation-sessionstart.mjs` → same pass count as the 1.0 baseline |
| 1.10b | `plugins/claude-code-activation/manifest.json` | EDIT | Update the `support_files` sha256 for `activation-hook-run.mjs` to the post-edit value. **Compute it, never copy it from this plan** | `node tests/test-activation-manifest.mjs` → `35 passed, 0 failed`; `node tests/test-plugin-registry.mjs` → `205 passed, 0 failed` |
| 1.11 | `docs/rfcs/RFC-009-lesson-activation.contract.json` | EDIT | Listing L3 | see the fenced command below this table → exit 0 |
| 1.12 | `scripts/validate-rfc-009-contract-mirror.mjs` | APPEND | Listing L4 | `grep -c 'function checkEventTimeReads' scripts/validate-rfc-009-contract-mirror.mjs` → `1` |
| 1.13 | `scripts/validate-rfc-009-contract-mirror.mjs` | EDIT | Listing L4b (wiring) | `node scripts/validate-rfc-009-contract-mirror.mjs` → exit 0 and stdout `{"status":"ok",...}` |
| 1.14 | `tests/test-contract-mirror-009.mjs` | EDIT | Listing L8 legs (a)(b)(c) | `node tests/test-contract-mirror-009.mjs` → all pass, INCLUDING the (c) planted-source leg observing the validator exit 1 |
| 1.15 | `tests/test-rfc-015-p1-s3a-resurfacing.mjs` | CREATE | Listing L7 | `node tests/test-rfc-015-p1-s3a-resurfacing.mjs` → `29/29 pass` |
| 1.16 | `.github/workflows/tests.yml` | EDIT | Listing L9 | `node tests/test-ci-suite-registration.mjs` → all pass |

**Commands that cannot live in a table cell** (a `|` inside a cell is column syntax; escaping it
as `\|` makes `grep -E` match a LITERAL pipe and return 0 — that is exactly what broke steps 1.4
and 1.9 in the previous draft, R2-G1). Run these verbatim:

```bash
# step 1.4 — expect 3 (measured baseline before the append: 0)
grep -cE "fs\.(readFileSync|openSync|readSync|readFile|createReadStream)" scripts/lib/activation-log.mjs
```

```bash
# step 1.9 — expect 6, unchanged from the measured baseline
grep -cE "fs\.(readFileSync|openSync|readSync|readFile|createReadStream)" plugins/claude-code-activation/hooks/activation-hook-run.mjs
```

> **Semantics caveat.** `grep -c` counts matching LINES; the validator's
> `countReadCallSites` counts OCCURRENCES via `String.match(/…/g)`. They agree only while no
> single line carries two read calls. Measured at `838b224`: hook = 6 lines and 6 occurrences;
> Listing L5b adds 3 calls on 3 separate lines. **Keep one read call per line in these two
> files**, or the step verify and the validator will disagree and the mismatch will read as a
> boundary violation.

```bash
# step 1.11 — expect exit 0
node --input-type=module -e "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync('docs/rfcs/RFC-009-lesson-activation.contract.json','utf8')); if(c.event_time_reads.files.length!==5) process.exit(1)"
```

> Steps 1.4 and 1.9 edit nothing; they are count checks that must hold before the contract pins
> those numbers. If either disagrees, STOP (§A.3) — the contract in Listing L3 is wrong and the
> plan owner must re-derive it.
>
> Step 1.10 touches one file but carries four anchored changes; it is a single file so it
> satisfies the one-file-per-step rule. If any of its four anchors is not unique, STOP (§A.3).

## A.8 Definition of done

```bash
node tests/test-rfc-015-p1-s3a-resurfacing.mjs
node tests/test-contract-mirror-009.mjs
node tests/test-activation-sessionstart.mjs
node tests/test-activation-hook-e2e.mjs
node tests/test-ci-suite-registration.mjs
node tools/deploy-audit.mjs
```

## A.9 Blast-radius notes

- **Red-then-green:** `t15_mirror_boundary_drift` must be observed reporting the validator
  exiting 1 before the green run is trusted. Discharged by sub-case (c), which plants a real
  extra `fs.readFileSync` into a throwaway copy of the hook source — no break flag exists or is
  needed (R1-F7). Sub-cases (a) and (b) plant drift in a contract copy the same way the file's
  six existing drift cases already do.
- **Thin addition over refactor:** `selectAndBound` gains one additional returned field; its
  body is otherwise untouched. `pickResurfacePlaybook` is a new APPEND, not an extraction.
- **Fixture-change ledger:** if EC7 forces a change to `test-activation-hook-e2e.mjs`, the
  exact assertions edited are enumerated as their own anchored steps — never "existing tests
  stay green".
- **Discriminating sentinel:** `t4c_log_text_never_rendered` plants a unique token in the log
  and asserts stdout does NOT carry it. `t1b_tail_bound` plants distinct ids at the head and
  tail of a >64 KiB log and asserts the head id is absent and the tail id present.
- **Focused review before build:** this slice changes the event plane's read boundary. Marked
  focused-review even though fully specified.
