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

## Proposal

### Boundary invariants (bind every requirement below)

- **B-1 Enforcement-free.** Every mechanism here is advisory data or a read-only audit; nothing gates, blocks, or decides (RFC-008 R1; CAPABILITIES.md criterion 4).
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

### R4 — Consolidation closure (RFC-011 R5 intent, evenly enforced)

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

### Data-artifact contracts

| Artifact | Change |
|---|---|
| `schemas/playbooks.schema.json` | UNCHANGED |
| Episode frontmatter / index row | optional `playbook: boolean` (absent = false) |
| `em-store` / `em-revise` / `em-consolidate` stdout | optional `playbook_advisory` object (shape in R2/R4c; absent when no marker involved) |
| `em-doctor` output | four new check ids (R5), existing result shape |

### Per-tool tier (Principle 5)

Entirely substrate-CLI-side: every tool that shells the `em-*` scripts gets identical behavior — STRONG across claude-code / codex / cursor / windsurf by construction. The activation adapter and its per-tool tiers (RFC-011) are untouched.

### Substrate script coverage (disposition per em-* script)

- **CHANGED:** `em-store.mjs` (R1/R2/R3), `em-revise.mjs` (R1/R2/R3), `em-consolidate.mjs` (R4), `em-doctor.mjs` (R5).
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

Single phase. P1: R1 marker + R2 advisories + R3 flag + R4 consolidation closure + R5 doctor checks, with the acceptance fixtures below; docs (CLAUDE.md testing block, script `--help`) in the same PR.

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
