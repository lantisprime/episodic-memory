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

Empirical driver: the tiered-orchestration playbook v15 (`20260722-133545-consolidated-tiered-multi-agent-orchestr-99bf`) was created by consolidation on 2026-07-22 and was invisible to session-start activation until 2026-07-26. Re-diagnosis (round-1 review, probe-confirmed): this was an **authoring gap** — the tiered chain was never declared in the project's `playbooks.json` at all (Problems 1 and 3) — not a resolution failure; a declared predecessor would have resolved forward to the digest (`terminalOf`, `em-trigger-index.mjs:157`, follows `superseded_by` edges). The operator-visible symptom was "Claude Code fails to recall the playbook even though activation works." Every mechanism below contributed:

1. **Authoring-time invisibility.** `em-store`'s success payload is `{ status, id, file, scope }` (`scripts/em-store.mjs:404`) and `em-revise`'s adds only `supersedes` (`scripts/em-revise.mjs:558-561`). Neither carries any registration signal, and the two existing advisories (trigger collision, contradiction) are stderr-only (`em-store.mjs:414-428`, `:434-447`). An operator storing a playbook episode gets zero indication that no project declares it.
2. **Consolidation silently substitutes content and unevenly protects.** Consolidating a declared chain does **not** strand the registration — `terminalOf` (`em-trigger-index.mjs:157`) walks `superseded_by` forward edges, so the declaration resolves to the digest and renders it (probe-confirmed on fixtures in both topologies and on the real store, where the old tiered id resolves to v15 today). The real defects are three: **(a) content substitution** — resolution silently re-points the operator's curated declaration to an auto-generated digest ("Consolidated: … (+N related)" machine summary), with no notice at consolidation time and no provenance at render time; **(b) uneven protection** — the `--fold-superseded` paths consult `resolvePlaybookProtection` (`em-consolidate.mjs:331-337`, `:392-398`), but the legacy digest-apply transaction (`:1057-1179`, range approximate) performs no playbook-protection check at all, and the clerk-apply path hardcodes `playbookIds = []` (`:1863`), so class-e protection (`scripts/lib/protection.mjs:245-267`) never fires there — a declared member folds without protest (probe-confirmed); **(c) total silence** — neither apply path emits any advisory. Digest nodes carry `supersedes: null` (`:1120`; clerk `:1503-1517`), which matters for provenance, not resolution.
3. **No detection predicate exists.** Nothing marks an episode as a playbook — no flag, no frontmatter field, no tag convention (`grep -i playbook scripts/em-store.mjs` = zero matches). Real drift has already occurred: the v5 approach-playbook chain carries the tag `playbook`; the v15 orchestration playbook does not. Any heuristic detector would have missed the exact episode this RFC exists because of.
4. **Scope confusion around "global playbooks."** Playbook episodes typically live in the global store, but registration is per-project by contract — RFC-011 R1: "no global variant exists," enforced at `scripts/em-trigger-index.mjs:605-614` (non-local builds skip the parse). A hand-authored `~/.episodic-memory/playbooks.json` is therefore silently ignored, and no surface reports which projects (if any) declare a given global playbook episode.
5. **Registration is necessary but not sufficient — pointer follow-through is invisible.** Registration only gets a pointer rendered; nothing surfaces whether the READ ever happens, and injection stops escalating. Live evidence, 2026-07-26 (the same session that produced this RFC): the a6c2 lesson's `access_count` sat frozen at 73 across seven consecutive injections (activation-log `access_count_at_inject: 73` at 13:34Z, 13:40Z, 13:46Z, 21:38Z, 21:49Z, 21:51Z, 23:29Z on 2026-07-25) — seven deliveries, zero reads; and v15, registered mid-session, was read by the orchestrator only after two operator prompts, because a `session_start`-mode playbook registered mid-session surfaces nowhere until the next session start (RFC-011 R3 renders playbooks at session start only). RFC-011 R6 already tracks the read side (`--read` bumps `access_count`/`last_accessed`); the inject side is logged (RFC-009 R6 telemetry). The conversion join exists in the data and is surfaced to no one.
6. **Consolidated digests degrade the read they point at.** The v15 digest body contains the identical playbook edition five times — once per consolidated member — because digest assembly concatenates member bodies with no content dedup. The registered pointer works, but every follow-through read pays ~5x the tokens, directly taxing the exact behavior Problems 1-5 are trying to increase.

## Proposal

### Playbooks are runbooks, not behavior patterns (taxonomy boundary, operator-set 2026-07-26)

The two artifact classes this repo keeps conflating get a sharp line, and every requirement in this RFC binds to it:

| Axis | **Playbook** | **Behavior pattern (`bp-XXX`)** |
|---|---|---|
| What it is | Operator-authored **technical runbook** — procedures, launch flags, seat recipes, pipelines (RFC-011: "operational guides stored as lesson episodes") | **Workflow-discipline contract** — a rule about how the agent must work (plan gates, checkpoints, filing duties) |
| Stored as | `category: lesson` episode in the substrate | `patterns/bp-XXX.json` definition in the enforcement registry |
| Activated by | Declaration (`playbooks.json`) + advisory READ pointers (RFC-011 R3/R4) | Per-project enforcement install + gate hooks (RFC-008) |
| Consumed by | **Reading** — the agent loads the body and applies judgment | **Execution** — the layer blocks/allows tool calls mechanically |
| May enforce? | **Never.** Advisory is the ceiling (B-1, operator lock) | Yes — gating is its entire job, in its own layer |
| Authority | Advice with provenance; deviation is a judgment call the operator reviews | Rule; deviation is a violation episode |

Litmus test for any future artifact: *if it tells you **how to do** a task, it is a playbook and may only ever be surfaced advisorily; if it constrains **whether you may proceed**, it is a behavior pattern and belongs to the enforcement layer, never to playbook or episode surfaces.* An artifact needing both halves is two artifacts. The R1 marker asserts the left column: marker-bearing episodes are runbook content by declaration, and nothing marker-bearing may ever acquire gate semantics (T13).

### Boundary invariants (bind every requirement below)

- **B-1 Advisory-only, everywhere, flat.** Every mechanism in this RFC is advisory data or a read-only audit; nothing gates, blocks, or decides (RFC-008 R1; CAPABILITIES.md criterion 4). **Playbooks and episodes are advisory-only surfaces by operator decision (2026-07-26, locked): any design that introduces enforcement through the playbook mechanism or episode surfaces is rejected outright** — including in future review rounds and slices of this RFC.
- **B-2 Consent-preserving.** No code path writes `playbooks.json` without an explicit per-invocation operator flag. Detection and suggestion are automatic; the write is intentional (Principle 3; RFC-011 R1 "writing it is the activation consent" — this RFC gives the operator a pen, not an autopilot).
- **B-3 Per-project scope.** Registration stays local-store-only (RFC-011 R1/R2 reaffirmed). No global variant is introduced.
- **B-4 Marker is authoring-time data.** The `playbook` marker is frontmatter written when the episode is created or revised; episode ids and existing bodies are never mutated (Principle 7).

### R1 — Explicit playbook marker (detection predicate as data)

`em-store` gains `--playbook`: writes `playbook: true` into episode frontmatter (alongside the present-only activation fields, `em-store.mjs:339-350`) and onto the index row. `em-revise` inherits the marker from the original (clearable with `--no-playbook`). The detection predicate everywhere in this RFC is *marker present* — never tags, summary text, or any heuristic (Principle 2: definitions are data; Problem 3 is the counterexample that buries heuristics).

**Round-trip lockstep (round-1 F2):** `em-rebuild-index.mjs` builds index rows from an explicit frontmatter whitelist (`em-rebuild-index.mjs:225-260`, marked LOCKSTEP-load-bearing at `:235-237`/`:248-251`). The `playbook` field joins that whitelist in the same slice as the marker — otherwise any rebuild silently strips the marker from index rows while episode files keep it, desyncing the detection predicate by consumer. A rebuild round-trip acceptance leg (T14) pins it.

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

Registration state is computed by reading the current project's `playbooks.json` through `parsePlaybooksConfig` (`em-trigger-index.mjs:278-310` — the shared single source of truth; no second parser) and resolving declared chains through **one exported resolution helper** (round-1 F7): the existing terminal-resolution logic (`em-trigger-index.mjs` `terminalOf`/`buildChainMaps`, currently module-private; or `protection.mjs` `terminalOfChain`/`chainSuccessorMap` at `:81`/`:92`, currently unexported) is exported rather than reimplemented — a second chain-walker would drift exactly the way second parsers do. This amends `em-trigger-index.mjs` (or `lib/protection.mjs`) to CHANGED, exports only, behavior identical. The advisory rides stdout JSON, not stderr, because stderr-only advisories are precisely the invisibility Problem 1 documents. A revision of an already-declared chain reports `registered: true` and suggests nothing — R2.1 terminal resolution makes re-pointing unnecessary. Absent marker, the field is absent; output is byte-identical to today (zero cost for non-playbook stores, Principle 6).

### R3 — Consent-carrying registration flag

`em-store --register-playbook [session_start|on_demand]` (likewise on `em-revise`) upserts the entry into the **current project's** `playbooks.json`. The flag is the consent act: the file remains operator-authored (RFC-011 R1 intact), the flag is simply a first-class way to author it. `--register-playbook` implies `--playbook`. Contract details:

- **Flag grammar.** Bare `--register-playbook` defaults to `session_start`; `--no-playbook` combined with `--register-playbook` is a contradiction and is refused.
- **Write mechanics.** Absent file → created from the skeleton (`schema_version: 1` is required). Write is atomic temp+rename (project convention) — a torn consent file is a fail-closed abort for every retention consumer (R4d), so it must never be producible. Validation covers the **whole resulting document** against `schemas/playbooks.schema.json`, not just the new entry.
- **Two caps, two behaviors (they are different bounds).** The 32-entry `maxItems` is a **file** bound (`playbooks.schema.json:23`; over-bound = malformed per RFC-011): a **new** id against a full array is refused; an idempotent upsert of an already-declared id succeeds (array size unchanged). `max_playbooks` (1..4) is a **build/render** bound: registration beyond it succeeds and the advisory notes the entry will be build-capped. Refusal always, clamping never (`playbooks.schema.json:29-33` posture).
- **Corrupt existing file → fail-closed refusal** naming the parse error (mirrors RFC-011 R5(b)). Overwriting would destroy operator-authored declarations; silent repair would be a second writer. Neither is permitted (B-2).
- **Empty-trigger warning.** `--register-playbook on_demand` for an episode whose effective trigger set is empty produces a registration the build excludes as `empty_triggers` — the advisory says so at write time instead of letting it fail silently at build time.
- **Threat surface (RFC-011 R1).** The flag mints no new surface: `playbooks.json` was always agent-writable under RFC-011's stated threat model; this path is strictly more constrained (whole-document schema validation, bounds refusal, single-entry upsert).

### R4 — Consolidation closure (RFC-011 R5 intent, evenly enforced; folds #610)

- **(a) Marker inheritance.** A digest whose members include a marker-bearing episode is itself written with `playbook: true`.
- **(b) Protection parity.** The legacy digest-apply transaction (`em-consolidate.mjs:1057-1179`) gains the same `resolvePlaybookProtection` consultation the fold paths already have; the clerk-apply call site (`:1863`) passes real resolved playbook ids instead of the hardcoded `[]`, so class-e protection (`protection.mjs:245-267`) fires on every archival path.
- **(c) Substitution advisory.** When an apply consolidates members belonging to a declared chain, the apply's output carries a `playbook_advisory` naming each affected declaration, the digest id its rendering will now resolve to, and the fact that the rendered content becomes the auto-generated digest rather than the curated episode — with the suggested actions (re-curate the digest body, or update the declaration). Advisory only — consolidation is never blocked (B-1); the operator learns about the substitution at the moment it is created, not sessions later (Problem 2a).
- **(d) Fail-closed on corrupt declarations (both apply paths).** Binding to RFC-011 R5(b)'s retention posture: a corrupt or schema-invalid `playbooks.json` in any consulted store **aborts the apply** (exit 1, naming the file) — protection is never silently disabled. The clerk path's current `try{}catch{}` around protection (`em-consolidate.mjs:1858-1864`) is the named anti-pattern this clause forbids preserving.

### R5 — Registration audit (curation, `em-doctor`)

Four read-only checks in the existing `report(id, scope, level, message, extra)` shape (`scripts/em-doctor.mjs:96-98`); per-store checks ride `checkStore` (`:124`) via `checkStoreWithDir` (`:586`; `--all-projects` registry loop `:601-605`), one-shot checks the standalone block (`:608-612`):

| Check id | Fires when | Level |
|---|---|---|
| `playbook-unregistered` | a marker-bearing, active, chain-terminal episode reachable from the scanned store is not declared in the check's **declaration set** — under default scope, the cwd project's `playbooks.json` only, with that limitation named in the message; under `--all-projects`, the union of every registered project's declarations (closes OQ-3) | warn |
| `playbook-registration-health` | a declared entry fails resolution — **recomputed at check time** from `playbooks.json` + the current index via the shared resolution helper (never read from the possibly-stale cached `build_report`, whose global-store section is zero-state by design), reporting the same exclusion reasons (`unresolvable`, `inactive`, `chain_collision`, ...) | warn |
| `playbook-content-substitution` | a declared id resolves through its chain to a digest node (`consolidates` non-empty) other than the declared id itself — the declaration now renders auto-generated digest text the operator never curated (Problem 2a) | warn |
| `playbook-global-file` | `~/.episodic-memory/playbooks.json` exists — uncontracted and silently ignored (Problem 4) | warn |

No `--fix` wiring in this RFC (the only routed fix target today is `em-rebuild-index`, `em-doctor.mjs:627-628`; registration repair is a consent decision, B-2).

### R6 — Scope rule (the global-playbooks answer)

Registration remains per-project-local; the global variant stays rejected (Alternatives). Advisories and `--register-playbook` name exactly one write target: the current project's store. Cross-project visibility ("which projects declare this chain?") is read-only doctor territory via the consumer registry (CAPABILITIES.md cross-store rule) — never a global declaration file.

### R7 — Unread-pointer re-surfacing and conversion visibility (Problem 5)

A registered `session_start` playbook that remains **unread** does not fall silent after one render:

- **(a) Re-surfacing.** The activation adapter re-renders an unread `session_start` playbook pointer on subsequent `UserPromptSubmit` events — bounded to at most one playbook line per prompt event and suppressed the moment the read lands. *Unread* is computed from data the substrate already maintains: the episode's `last_accessed` (bumped by the R7/RFC-011 tracked read) versus the latest `session_start` inject event for that episode id in the activation log. This also closes the mid-session registration gap by construction: a playbook registered mid-session is unread by definition and surfaces on the very next prompt, not at the next session start.
- **(b) Read-boundary amendment, stated explicitly.** RFC-009 REQ-19 confines event-time reads to the trigger index plus `lesson-suppress.json`; R7a adds the activation log tail (`.episodic-memory/activation-log.jsonl`, already written by this same adapter under RFC-009 R6) as a third sanctioned event-time read. Same store, append-only, stat-then-tail bounded; fail-open — an absent or unparseable log disables re-surfacing, never injection.
- **(c) Doctor check `playbook-unread`** (joins the R5 table): warns when a declared playbook's inject count since its last read exceeds a threshold (default 3) — the a6c2 signature (seven injects, zero reads) becomes an operator-visible finding instead of a frozen counter nobody joins.
- **(d) Advisory is the ceiling.** R7a-c are the strongest tier this RFC ships: persistent, bounded re-surfacing plus operator visibility. No blocking tier exists or may be added through playbook/episode surfaces (B-1, operator-locked).

### R8 — Digest body dedup in consolidation (Problem 6)

`em-consolidate` digest assembly dedups member bodies by content before concatenation: byte-identical member bodies collapse to one copy, with the member provenance list (`(id: ..., date)` headers) preserved for every member. Applies to both digest-write paths (legacy `em-consolidate.mjs:1081-1095`, clerk `:1503-1517`). The v15 digest class (five identical editions, ~5x read cost) becomes one edition with five provenance headers. Near-identical bodies (revision chains consolidated together) are out of scope for P1 — only byte-identical dedup, the conservative half that cannot lose content.

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

R1-R6, R8: substrate-CLI-side — every tool that shells the `em-*` scripts gets identical behavior, STRONG across claude-code / codex / cursor / windsurf by construction. R7a-b touch the activation adapter's per-prompt surface and therefore inherit RFC-009/RFC-011's adapter tiers: claude-code STRONG; tools without a per-prompt hook surface degrade to session-start-only rendering (no re-surfacing) — honest WEAK, with R7c's doctor check as their fallback visibility.

### Substrate script coverage (disposition per em-* script)

- **CHANGED:** `em-store.mjs` (R1/R2/R3), `em-revise.mjs` (R1/R2/R3), `em-consolidate.mjs` (R4/R8), `em-doctor.mjs` (R5/R7c), `em-rebuild-index.mjs` (R1 marker joins the LOCKSTEP frontmatter whitelist, `:225-260` — round-1 F2), `em-trigger-index.mjs` (exports only: the shared chain-resolution helper, behavior identical — round-1 F7). Adapter-side (not em-*): the activation runner + matcher gain the R7a re-surfacing leg.
- **INTERACTS, UNCHANGED:** `lib/protection.mjs` (class list unchanged; R4b feeds it real inputs — unless F7's export lands here instead of em-trigger-index), `em-prune.mjs` (protection stays declaration-based — the marker alone protects nothing, see Non-goals), `em-search.mjs` (`--read` untouched).
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
| A playbook-read gate (PreToolUse hook blocking until the injected pointer is read) | **REJECTED, operator decision 2026-07-26, locked.** Playbooks and episodes are advisory-only surfaces; enforcement introduced through them is refused outright, including via the adjacent enforcement layer. Follow-through is served by R7 re-surfacing + R7c visibility only. Do not re-propose in review rounds. |

## Implementation plan

One phase, two slices:

- **P1-S1** — R1 marker + R2 advisories + R3 flag + R5 doctor checks, with their acceptance fixtures; docs (CLAUDE.md testing block, script `--help`) in the same PR.
- **P1-S2** — R4 consolidation closure (protection parity on both apply paths, marker inheritance, dangling-registration advisory). This slice **folds GitHub issue #610** (the standalone protection-gap defect report); #610 is closed against this RFC and tracked here, not as an issue.
- **P1-S3** — R7 unread-pointer re-surfacing: adapter re-render leg + REQ-19 read-boundary amendment + `playbook-unread` doctor check (folds the 2026-07-26 follow-through finding: seven injections, zero reads).
- **P1-S4** — R8 digest body dedup in both `em-consolidate` digest-write paths (folds the 2026-07-26 v15 5x-duplicate-digest finding).

**Finding-folding rule (operator directive, 2026-07-26):** defects and gaps surfaced by review rounds on this RFC are folded in as new slices (P1-S5, ...) or amendments — no standalone issues are filed for them.

## Acceptance tests (P1 gate)

| # | Fixture | Asserts |
|---|---|---|
| T1 | store with `--playbook` | frontmatter + index row carry `playbook: true`; stdout carries `playbook_advisory` with `registered: false` and a schema-valid `suggested_entry` |
| T2 | store without the flag | no marker; `playbook_advisory` ABSENT; stdout byte-identical to pre-RFC shape |
| T3 | `--register-playbook session_start` | `playbooks.json` gains the schema-valid entry; absent file → created from the `schema_version: 1` skeleton; bare flag defaults to `session_start`; second invocation is idempotent (upsert, no duplicate); invalid mode string refused; `--no-playbook --register-playbook` refused as contradictory |
| T4 | revise of a declared chain with marker | marker inherited; advisory reports `registered: true`, suggests nothing; `playbooks.json` NOT rewritten |
| T5 | full 32-entry `playbooks` array + `--register-playbook` | a **new** id is refused with a clear error, file byte-identical; an idempotent upsert of an already-declared id **succeeds** with the array still at 32 (the two caps behave per R3: `maxItems` = file bound, `max_playbooks` = build bound) |
| T6 | consolidate members of a declared chain (legacy apply AND clerk apply) | digest carries `playbook: true`; apply output carries the substitution advisory (declaration, digest id, content-substitution notice); class-e protection fires on both paths; a corrupt `playbooks.json` in a consulted store aborts either apply exit 1 naming the file (R4d, both polarities) |
| T7 | doctor: marker-bearing undeclared terminal / declared-entry failing check-time resolution / declared id resolving to an undeclared digest / global `playbooks.json` present | each of the four checks fires warn with the right id (substitution check on the digest topology, recomputed never from cached build_report); all four silent on a clean fixture (both polarities) |
| T8 | no-flag negative sweep | grep-level + runtime assertion that no code path writes `playbooks.json` absent `--register-playbook` |
| T9 | non-local scope | `--register-playbook` with `--scope global` store target is refused (B-3); advisory on a global-store write still names only the current project's local store |
| T10 | unread re-surfacing | after a session_start inject with no subsequent read, the next prompt event re-renders the pointer (at most one playbook line per event); a tracked `--read` suppresses re-surfacing on the following event; registering a playbook mid-session surfaces it on the next prompt without a session restart |
| T11 | R7 fail-open | absent activation log / unparseable log / log naming an unknown episode → re-surfacing silently disabled, normal injection unaffected, exit 0, no decision field (RFC-009 advisory invariant preserved on every leg) |
| T12 | digest dedup | consolidating five byte-identical member bodies yields one body copy + five provenance headers (both digest paths); non-identical bodies remain fully concatenated; digest read round-trips byte-exact for the surviving content |
| T13 | advisory-ceiling negative | grep-level + runtime sweep over every artifact this RFC ships: no `decision`/`block`/`permissionDecision` field, no non-zero exit on any **event-plane** leg, no hook registration outside the pre-existing advisory adapter (B-1 operator lock, both polarities on the R7 surfaces; the R3/R4d CLI refusals exit non-zero by design — they are input validation on explicit write commands, not gates) |
| T14 | rebuild round-trip | store with `--playbook`, run `em-rebuild-index`, re-read: index row still carries `playbook: true` (whitelist lockstep, F2); a marker-free episode stays marker-free through the same round-trip |
| T15 | corrupt consent file | `--register-playbook` against an unparseable / schema-invalid `playbooks.json` → fail-closed refusal naming the parse error, file byte-identical (no overwrite, no silent repair); registration advisory (R2) on the same fixture degrades to a note, never a write |
| T16 | empty-trigger on_demand | `--register-playbook on_demand` on an episode with no effective triggers → write succeeds with advisory warning that the build will exclude it as `empty_triggers`; the build then does exactly that (both halves observed) |

## Implementation

(unfilled — draft)

## Related RFCs

- **RFC-011 (accepted)** — supplies the declaration file, schema, build resolution, and R5 protection this RFC composes with; R4 discharges the uneven-enforcement gap against R5's stated intent without amending RFC-011's text.
- **RFC-009 (accepted)** — activation surfaces that render declared playbooks; untouched.
- **RFC-008 (accepted)** — the enforcement-free boundary (R1) that B-1 binds to.

## Second opinion

| Round | Reviewer | Verdict | Findings | Disposition |
|---|---|---|---|---|
| 1 | pi kimi-k3 (herdr seat, operator-directed; frozen `e8ff52d`) | HOLD-13 | F1 P1 premise falsification (declared ids resolve forward through `superseded_by` to the digest — probe-confirmed on fixtures + real store; real defect is content substitution), F2 P1 `em-rebuild-index` whitelist drops the marker, F3-F6 P2 (two-caps split; corrupt-file refusal; clerk-path abort semantics; unregistered-check scope), F7-F10 P3, F11-F13 NIT. All anchors verified against disk (2 loose ranges). | 13/13 ACCEPT, folded 2026-07-26: Problem 2 re-diagnosed on the substitution framing; R4c→substitution advisory, R4d fail-closed; R5 dangling check→`playbook-content-substitution`, health check recomputes; R3 full consent contract; R1 rebuild lockstep; F7 exported helper; T3/T5/T6/T7 rewritten, T14-T16 added; OQ-1/OQ-3 updated. Round 2 pending on the fold delta + R7/R8 + taxonomy/advisory-lock (unreviewed by round 1). |

## Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| OQ-1 | Backfill: existing playbook chains (v5, v15) need the marker. `em-revise` inheritance is the Principle-7-clean path (hand-editing frontmatter edits an immutable episode in place and desyncs the index row until a rebuild — round-1 F12); is a revision hop per chain acceptable, or is a sanctioned one-time migration needed? | champion | open |
| OQ-2 | Should `em-capture` and other authoring surfaces also emit the R2 advisory in P1, or follow in a later phase? | champion | open |
| OQ-3 | Should `playbook-unregistered` under `--all-projects` consult every registered store's declarations before warning (a global playbook declared in *some* project is arguably not unregistered)? | champion | open |
