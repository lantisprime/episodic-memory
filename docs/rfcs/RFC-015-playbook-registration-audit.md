---
rfc_id: RFC-015
slug: playbook-registration-audit
title: "Playbook Registration: Store-Time Detection, Registration Audit, and Scope Rules"
status: draft
champion: Charlton Ho
created: 2026-07-26
last_modified: 2026-07-26
supersedes: ~
superseded_by: ~
---

# RFC-015 — Playbook Registration: Store-Time Detection, Registration Audit, and Scope Rules

## AI context

> RFC-011 made playbook activation a per-project, operator-authored declaration (`<project>/.episodic-memory/playbooks.json`), but left the whole registration lifecycle invisible: nothing marks an episode as a playbook, nothing tells an author at store time that a playbook is (or is not) declared anywhere, consolidation silently moves live content out of every declared chain (digest nodes carry `supersedes: null`, so RFC-011 R2.1 terminal resolution can never reach them), and a hand-authored global `playbooks.json` is silently ignored. This RFC adds an explicit `playbook` frontmatter marker (detection predicate as data, never heuristics), advisory registration output on `em-store`/`em-revise`/`em-consolidate` (detect and suggest — a write still requires an explicit per-invocation flag, preserving RFC-011 R1's consent model), a consent-carrying `--register-playbook` flag, four read-only `em-doctor` registration-audit checks, and closure of two paths where RFC-011 R5 playbook protection is not enforced today. Everything stays substrate-side, enforcement-free, and per-project; the activation adapter is untouched.

## Problem

Empirical driver: the tiered-orchestration playbook v15 (`20260722-133545-consolidated-tiered-multi-agent-orchestr-99bf`) was created by consolidation on 2026-07-22 and remained unregistered until 2026-07-26. Three sessions received session-start activation without the binding playbook while its predecessor chain kept rendering — the operator-visible symptom was "Claude Code fails to recall the playbook even though activation works." Every mechanism below contributed:

1. **Authoring-time invisibility.** `em-store`'s success payload is `{ status, id, file, scope }` (`scripts/em-store.mjs:404`) and `em-revise`'s adds only `supersedes` (`scripts/em-revise.mjs:558-561`). Neither carries any registration signal, and the two existing advisories (trigger collision, contradiction) are stderr-only (`em-store.mjs:414-428`, `:434-447`). An operator storing a playbook episode gets zero indication that no project declares it.
2. **Consolidation orphans registrations silently.** A digest node is written with `supersedes: null` (`scripts/em-consolidate.mjs:1120`; clerk path `:1503-1517` emits no `supersedes` key), while RFC-011 R2.1 terminal resolution walks supersedes chains only — so consolidating a declared chain strands every registration at an archived-or-stale terminal with no route forward. No warning of any kind is emitted (verified ABSENT). Worse, RFC-011 R5's protection is unevenly enforced: the `--fold-superseded` paths consult `resolvePlaybookProtection` (`em-consolidate.mjs:331-337`, `:392-398`), but the legacy digest-apply transaction (`:1057-1179`) performs no playbook-protection check at all, and the clerk-apply path hardcodes `playbookIds = []` (`:1863`), so class-e playbook protection (`scripts/lib/protection.mjs:245-267`) never fires there.
3. **No detection predicate exists.** Nothing marks an episode as a playbook — no flag, no frontmatter field, no tag convention (`grep -i playbook scripts/em-store.mjs` = zero matches). Real drift has already occurred: the v5 approach-playbook chain carries the tag `playbook`; the v15 orchestration playbook does not. Any heuristic detector would have missed the exact episode this RFC exists because of.
4. **Scope confusion around "global playbooks."** Playbook episodes typically live in the global store, but registration is per-project by contract — RFC-011 R1: "no global variant exists," enforced at `scripts/em-trigger-index.mjs:605-614` (non-local builds skip the parse). A hand-authored `~/.episodic-memory/playbooks.json` is therefore silently ignored, and no surface reports which projects (if any) declare a given global playbook episode.
5. **Registration is necessary but not sufficient — pointer follow-through is invisible.** Registration only gets a pointer rendered; nothing surfaces whether the READ ever happens, and injection stops escalating. Live evidence, 2026-07-26 (the same session that produced this RFC): the a6c2 lesson's `access_count` sat frozen at 73 across seven consecutive injections (activation-log `access_count_at_inject: 73` at 13:34Z, 13:40Z, 13:46Z, 21:38Z, 21:49Z, 21:51Z, 23:29Z on 2026-07-25) — seven deliveries, zero reads; and v15, registered mid-session, was read by the orchestrator only after two operator prompts, because a `session_start`-mode playbook registered mid-session surfaces nowhere until the next session start (RFC-011 R3 renders playbooks at session start only). RFC-011 R6 already tracks the read side (`--read` bumps `access_count`/`last_accessed`); the inject side is logged (RFC-009 R6 telemetry). The conversion join exists in the data and is surfaced to no one.
6. **Consolidated digests degrade the read they point at.** The v15 digest body contains the identical playbook edition five times — once per consolidated member — because digest assembly concatenates member bodies with no content dedup. The registered pointer works, but every follow-through read pays ~5x the tokens, directly taxing the exact behavior Problems 1-5 are trying to increase.

## Proposal

### Boundary invariants (bind every requirement below)

- **B-1 Enforcement-free substrate, partitioned enforcement tier.** Every **substrate** mechanism (R1-R8) is advisory data or a read-only audit; nothing in any `em-*` script or the activation adapter gates, blocks, or decides (RFC-008 R1; CAPABILITIES.md criterion 4, and its boundary test: "if it gates workflow, it is an adjacent layer"). The one gating mechanism in this RFC (R9) lives entirely in that adjacent enforcement layer — `bp-XXX` pattern + project-registered hook under the `enforcement` plugin type (RFC-008 R8) — and the substrate plus R7 advisory tier behave byte-identically with it absent (P12 I-4; asserted by T13's final leg).
- **B-2 Consent-preserving.** No code path writes `playbooks.json` without an explicit per-invocation operator flag. Detection and suggestion are automatic; the write is intentional (Principle 3; RFC-011 R1 "writing it is the activation consent" — this RFC gives the operator a pen, not an autopilot).
- **B-3 Per-project scope.** Registration stays local-store-only (RFC-011 R1/R2 reaffirmed). No global variant is introduced.
- **B-4 Marker is authoring-time data.** The `playbook` marker is frontmatter written when the episode is created or revised; episode ids and existing bodies are never mutated (Principle 7).

### R1 — Explicit playbook marker (detection predicate as data)

`em-store` gains `--playbook`: writes `playbook: true` into episode frontmatter (alongside the present-only activation fields, `em-store.mjs:328-361`) and onto the index row. `em-revise` inherits the marker from the original (clearable with `--no-playbook`). The detection predicate everywhere in this RFC is *marker present* — never tags, summary text, or any heuristic (Principle 2: definitions are data; Problem 3 is the counterexample that buries heuristics).

### R2 — Store-time registration advisory (detect and suggest, never write)

When the stored/revised episode carries the marker, `em-store` and `em-revise` append a `playbook_advisory` object to their stdout success JSON (`em-store.mjs:404`, `em-revise.mjs:558-561`):

```json
"playbook_advisory": {
  "registered": false,
  "project_store": "<project>/.episodic-memory",
  "suggested_entry": { "id": "<episode-id>", "mode": "session_start" },
  "note": "playbook episode not declared in this project's playbooks.json; add the entry or re-run with --register-playbook"
}
```

Registration state is computed by reading the current project's `playbooks.json` through `parsePlaybooksConfig` (`em-trigger-index.mjs:278-310` — the shared single source of truth; no second parser) and resolving declared chains far enough to know whether any declared entry reaches this episode's chain. The advisory rides stdout JSON, not stderr, because stderr-only advisories are precisely the invisibility Problem 1 documents. A revision of an already-declared chain reports `registered: true` and suggests nothing — R2.1 terminal resolution makes re-pointing unnecessary. Absent marker, the field is absent; output is byte-identical to today (zero cost for non-playbook stores, Principle 6).

### R3 — Consent-carrying registration flag

`em-store --register-playbook [session_start|on_demand]` (likewise on `em-revise`) upserts the entry into the **current project's** `playbooks.json`, schema-validated against `schemas/playbooks.schema.json` before write, honoring bounds by refusal with a clear error — never by clamping (matching the schema's own posture, `playbooks.schema.json:29-33`). The flag is the consent act: the file remains operator-authored (RFC-011 R1 intact), the flag is simply a first-class way to author it. `--register-playbook` implies `--playbook`. On a full `playbooks` array (32) or a `max_playbooks` already saturated at build, the write still succeeds if schema-valid (the cap is a build/render bound, not a file bound — RFC-011 R1), and the advisory notes the cap.

### R4 — Consolidation closure (RFC-011 R5 intent, evenly enforced; folds #610)

- **(a) Marker inheritance.** A digest whose members include a marker-bearing episode is itself written with `playbook: true`.
- **(b) Protection parity.** The legacy digest-apply transaction (`em-consolidate.mjs:1057-1179`) gains the same `resolvePlaybookProtection` consultation the fold paths already have; the clerk-apply call site (`:1863`) passes real resolved playbook ids instead of the hardcoded `[]`, so class-e protection (`protection.mjs:245-267`) fires on every archival path.
- **(c) Dangling-registration advisory.** When an apply consolidates members belonging to a declared chain, the apply's output carries a `playbook_advisory` listing each registration that will dangle and the suggested replacement entry (the digest id). Advisory only — consolidation is never blocked (B-1); the operator learns at the moment the dangling is created, not sessions later (Problem 2, the v15 class).

### R5 — Registration audit (curation, `em-doctor`)

Four read-only checks in the existing `report(id, scope, level, message, extra)` shape (`scripts/em-doctor.mjs:96-98`); per-store checks ride `checkStore` and `--all-projects` registry discovery (`em-doctor.mjs:601-605`), one-shot checks the standalone block (`:608-612`):

| Check id | Fires when | Level |
|---|---|---|
| `playbook-unregistered` | a marker-bearing, active, chain-terminal episode reachable from the scanned store is declared in no scanned project's `playbooks.json` | warn |
| `playbook-registration-health` | a declared entry is excluded by the build — surfaces `build_report.playbooks.excluded` reasons (`unresolvable`, `inactive`, `chain_collision`, ...) as operator-visible findings instead of an unread build report | warn |
| `playbook-dangling-chain` | a declared id's chain terminal was consolidated away (terminal superseded/archived with a digest naming it in `consolidates` while the digest itself is undeclared) — the v15 class | warn |
| `playbook-global-file` | `~/.episodic-memory/playbooks.json` exists — uncontracted and silently ignored (Problem 4) | warn |

No `--fix` wiring in this RFC (the only routed fix target today is `em-rebuild-index`, `em-doctor.mjs:627-628`; registration repair is a consent decision, B-2).

### R6 — Scope rule (the global-playbooks answer)

Registration remains per-project-local; the global variant stays rejected (Alternatives). Advisories and `--register-playbook` name exactly one write target: the current project's store. Cross-project visibility ("which projects declare this chain?") is read-only doctor territory via the consumer registry (CAPABILITIES.md cross-store rule) — never a global declaration file.

### R7 — Unread-pointer re-surfacing and conversion visibility (Problem 5)

A registered `session_start` playbook that remains **unread** does not fall silent after one render:

- **(a) Re-surfacing.** The activation adapter re-renders an unread `session_start` playbook pointer on subsequent `UserPromptSubmit` events — bounded to at most one playbook line per prompt event and suppressed the moment the read lands. *Unread* is computed from data the substrate already maintains: the episode's `last_accessed` (bumped by the R7/RFC-011 tracked read) versus the latest `session_start` inject event for that episode id in the activation log. This also closes the mid-session registration gap by construction: a playbook registered mid-session is unread by definition and surfaces on the very next prompt, not at the next session start.
- **(b) Read-boundary amendment, stated explicitly.** RFC-009 REQ-19 confines event-time reads to the trigger index plus `lesson-suppress.json`; R7a adds the activation log tail (`.episodic-memory/activation-log.jsonl`, already written by this same adapter under RFC-009 R6) as a third sanctioned event-time read. Same store, append-only, stat-then-tail bounded; fail-open — an absent or unparseable log disables re-surfacing, never injection.
- **(c) Doctor check `playbook-unread`** (joins the R5 table): warns when a declared playbook's inject count since its last read exceeds a threshold (default 3) — the a6c2 signature (seven injects, zero reads) becomes an operator-visible finding instead of a frozen counter nobody joins.
- **(d) Enforcement is layered, not smuggled.** R7a-c stay advisory (B-1). The blocking tier the operator directed (2026-07-26, "use hooks to solve this") is specced as **R9** — an enforcement-layer requirement, cleanly outside the substrate boundary.

### R8 — Digest body dedup in consolidation (Problem 6)

`em-consolidate` digest assembly dedups member bodies by content before concatenation: byte-identical member bodies collapse to one copy, with the member provenance list (`(id: ..., date)` headers) preserved for every member. Applies to both digest-write paths (legacy `em-consolidate.mjs:1081-1095`, clerk `:1503-1517`). The v15 digest class (five identical editions, ~5x read cost) becomes one edition with five provenance headers. Near-identical bodies (revision chains consolidated together) are out of scope for P1 — only byte-identical dedup, the conservative half that cannot lose content.

### R9 — Playbook-read gate (enforcement layer; operator-directed 2026-07-26)

A behavior pattern (`patterns/bp-XXX.json`) plus a PreToolUse gate hook, living entirely in the enforcement layer (RFC-008 R1/R2: depends on the substrate, never the reverse; B-1 untouched because this is not substrate code):

- **Trigger condition.** A `session_start`-mode playbook pointer was injected this session and the episode has no tracked read at or after that inject (same unread-join as R7a, computed from the activation log plus the index row).
- **Gate behavior.** While the condition holds, the gate blocks the session's first **non-read-only** tool call (write/edit/commit-class, per the existing command classifier) with a message naming the exact pending `read_command`(s). Read-only calls — including the read command itself — always pass, so the gate can never deadlock the action that clears it (the `never_make_user_run_marker_commands` class).
- **Consent and scope (Principle 12, all four invariants).** Registered only in `<project>/.claude/settings.json`, per-project opt-in, honors `enforce-config.json` `active` (currently `false` in this repo — the gate ships dormant until the operator arms it), removable by the per-project enforcement uninstall. The substrate and the R7 advisory tier function identically with the gate absent (I-4).
- **Mute surface.** `lesson-suppress.json` muting a playbook id also clears it from the gate condition — one sanctioned mute surface, no second suppression path (RFC-011 R1 posture).

**Why both tiers:** the advisory tier (R7) is cross-tool and always-on; the gate is the Rule-18 answer for harnesses with PreToolUse support, because this RFC's own origin evidence (seven injections, zero reads, and the orchestrator authoring this document skipping the pointer until operator intervention) shows advisory pointers lose to task momentum.

### Data-artifact contracts

| Artifact | Change |
|---|---|
| `schemas/playbooks.schema.json` | UNCHANGED |
| Episode frontmatter / index row | optional `playbook: boolean` (absent = false) |
| `em-store` / `em-revise` / `em-consolidate` stdout | optional `playbook_advisory` object (shape in R2/R4c; absent when no marker involved) |
| `em-doctor` output | five new check ids (R5 four + R7c `playbook-unread`), existing result shape |
| Activation adapter event-time reads | `+ activation-log.jsonl` tail (R7b — explicit RFC-009 REQ-19 amendment; fail-open) |
| Digest episode bodies | byte-identical member bodies collapse to one copy + full provenance headers (R8) |

### Per-tool tier (Principle 5)

R1-R6, R8: substrate-CLI-side — every tool that shells the `em-*` scripts gets identical behavior, STRONG across claude-code / codex / cursor / windsurf by construction. R7a-b touch the activation adapter's per-prompt surface and therefore inherit RFC-009/RFC-011's adapter tiers: claude-code STRONG; tools without a per-prompt hook surface degrade to session-start-only rendering (no re-surfacing) — honest WEAK, with R7c's doctor check as their fallback visibility. R9 requires a blocking PreToolUse surface: claude-code STRONG; every tool without one has **no gate at all** — an honest absence per Principle 5, never emulated by a weaker mechanism, with R7 as the universal advisory floor.

### Substrate script coverage (disposition per em-* script)

- **CHANGED:** `em-store.mjs` (R1/R2/R3), `em-revise.mjs` (R1/R2/R3), `em-consolidate.mjs` (R4/R8), `em-doctor.mjs` (R5/R7c). Adapter-side (not em-*): the activation runner + matcher gain the R7a re-surfacing leg.
- **INTERACTS, UNCHANGED:** `em-trigger-index.mjs` (its `parsePlaybooksConfig` is reused as the single parser; build contract untouched), `lib/protection.mjs` (class list unchanged; R4b only feeds it real inputs), `em-prune.mjs` (protection stays declaration-based — the marker alone protects nothing, see Non-goals), `em-search.mjs` (`--read` untouched).
- **UNCHANGED:** all remaining `em-*` scripts.

### Scope

**In scope:** the marker; advisories on store/revise/consolidate; `--register-playbook`; four doctor checks; R4b protection parity.

**Non-goals:** auto-registration without a flag (B-2); a global `playbooks.json` contract; marker-based prune protection (protection remains declaration-driven per RFC-011 R5 — an undeclared marker-bearing episode is exactly what `playbook-unregistered` surfaces); any activation-adapter change; any gating (B-1).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Silent auto-registration at store time | Collapses RFC-011 R1's consent boundary; its stated threat model (an agent-writable store minting itself recurring session-start pointers) becomes the designed behavior. Principle 3: activation must be intentional. |
| Heuristic detection (tag / summary / pinned) | Principle 2 requires the predicate as data; the v15 episode (untagged `playbook`) is the live counterexample a heuristic misses (Problem 3). |
| A global `playbooks.json` contract | RFC-011 R1 states "no global variant exists" and the build enforces it (`em-trigger-index.mjs:605-614`); a global declaration file re-introduces exactly the cross-project injection surface R1's threat model bounds, and conflicts with per-project consent (Principle 12's spirit). Doctor warns on the file instead (R5). |
| Registering from within the trigger-index build | The build is a read-only derivation over declared inputs (RFC-011 R2.8 read boundary); making it write its own input file inverts the dataflow. |
| Blocking consolidation of declared chains | Enforcement in the substrate violates RFC-008 R1 (B-1). Advisory + protection parity (R4) achieves the outcome without a gate. |

## Implementation plan

One phase, two slices:

- **P1-S1** — R1 marker + R2 advisories + R3 flag + R5 doctor checks, with their acceptance fixtures; docs (CLAUDE.md testing block, script `--help`) in the same PR.
- **P1-S2** — R4 consolidation closure (protection parity on both apply paths, marker inheritance, dangling-registration advisory). This slice **folds GitHub issue #610** (the standalone protection-gap defect report); #610 is closed against this RFC and tracked here, not as an issue.
- **P1-S3** — R7 unread-pointer re-surfacing: adapter re-render leg + REQ-19 read-boundary amendment + `playbook-unread` doctor check (folds the 2026-07-26 follow-through finding: seven injections, zero reads).
- **P1-S4** — R8 digest body dedup in both `em-consolidate` digest-write paths (folds the 2026-07-26 v15 5x-duplicate-digest finding).
- **P1-S5** — R9 playbook-read gate: `bp-XXX` pattern + PreToolUse gate hook, per-project install path, dormant behind `enforce-config.json` (enforcement layer; separate PR from the substrate slices so the RFC-008 R1 boundary stays reviewable).

**Finding-folding rule (operator directive, 2026-07-26):** defects and gaps surfaced by review rounds on this RFC are folded in as new slices (P1-S5, ...) or amendments — no standalone issues are filed for them.

## Acceptance tests (P1 gate)

| # | Fixture | Asserts |
|---|---|---|
| T1 | store with `--playbook` | frontmatter + index row carry `playbook: true`; stdout carries `playbook_advisory` with `registered: false` and a schema-valid `suggested_entry` |
| T2 | store without the flag | no marker; `playbook_advisory` ABSENT; stdout byte-identical to pre-RFC shape |
| T3 | `--register-playbook session_start` | `playbooks.json` gains the schema-valid entry; second invocation is idempotent (upsert, no duplicate); invalid mode string refused |
| T4 | revise of a declared chain with marker | marker inherited; advisory reports `registered: true`, suggests nothing; `playbooks.json` NOT rewritten |
| T5 | full 32-entry `playbooks` array + `--register-playbook` | write refused with clear error, file byte-identical (refusal, never clamp) |
| T6 | consolidate members of a declared chain (legacy apply AND clerk apply) | digest carries `playbook: true`; apply output lists the dangling registration + digest-id suggestion; class-e protection fires on both paths (member archival skipped where protection applies) |
| T7 | doctor: marker-bearing undeclared terminal / declared-but-excluded entry / consolidated-away terminal / global `playbooks.json` present | each of the four checks fires warn with the right id; all four silent on a clean fixture (both polarities) |
| T8 | no-flag negative sweep | grep-level + runtime assertion that no code path writes `playbooks.json` absent `--register-playbook` |
| T9 | non-local scope | `--register-playbook` with `--scope global` store target is refused (B-3); advisory on a global-store write still names only the current project's local store |
| T10 | unread re-surfacing | after a session_start inject with no subsequent read, the next prompt event re-renders the pointer (at most one playbook line per event); a tracked `--read` suppresses re-surfacing on the following event; registering a playbook mid-session surfaces it on the next prompt without a session restart |
| T11 | R7 fail-open | absent activation log / unparseable log / log naming an unknown episode → re-surfacing silently disabled, normal injection unaffected, exit 0, no decision field (RFC-009 advisory invariant preserved on every leg) |
| T12 | digest dedup | consolidating five byte-identical member bodies yields one body copy + five provenance headers (both digest paths); non-identical bodies remain fully concatenated; digest read round-trips byte-exact for the surviving content |
| T13 | read gate | mock-project E2E (real install, isolated HOME): with gate armed + unread session_start playbook, first write-class call blocks naming the pending read_command; the read command itself passes while blocked; after a tracked read the same call passes; `enforce-config.json` `active:false` → gate never fires on the same input (both polarities, nothing else changed); suppressed playbook id → gate clear; gate absent → substrate + R7 behavior byte-identical |

## Implementation

(unfilled — draft)

## Related RFCs

- **RFC-011 (accepted)** — supplies the declaration file, schema, build resolution, and R5 protection this RFC composes with; R4 discharges the uneven-enforcement gap against R5's stated intent without amending RFC-011's text.
- **RFC-009 (accepted)** — activation surfaces that render declared playbooks; untouched.
- **RFC-008 (accepted)** — the enforcement-free boundary (R1) that B-1 binds to.

## Second opinion

Pending — adversarial panel to be dispatched on this draft (provider per the project harness; findings must cite the R-number they serve).

## Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| OQ-1 | Backfill: should existing playbook chains (v5, v15) get the marker via `em-revise` inheritance runs, or is hand-edit of frontmatter acceptable for pinned episodes? | champion | open |
| OQ-2 | Should `em-capture` and other authoring surfaces also emit the R2 advisory in P1, or follow in a later phase? | champion | open |
| OQ-3 | Should `playbook-unregistered` under `--all-projects` consult every registered store's declarations before warning (a global playbook declared in *some* project is arguably not unregistered)? | champion | open |
