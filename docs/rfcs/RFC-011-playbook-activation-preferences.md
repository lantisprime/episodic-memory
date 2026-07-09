---
rfc_id: RFC-011
slug: playbook-activation-preferences
title: "Playbook Activation Preferences: Per-Project Session-Start and On-Demand Playbook Loading"
status: draft
champion: Charlton Ho
created: 2026-07-10
last_modified: 2026-07-10
supersedes: ~
superseded_by: ~
---

# RFC-011 — Playbook Activation Preferences: Per-Project Session-Start and On-Demand Playbook Loading

## AI context

> This RFC lets each project that consumes episodic-memory declare its own preferences for loading playbooks (operator-authored operational guides stored as lesson episodes, e.g. the tiered multi-agent orchestration playbook) either at session start or on demand at the moment of relevance. It adds one per-project data artifact (`<project>/.episodic-memory/playbooks.json`, schema-backed, bounded), a derived `session_start.playbooks` array plus `entry_class: "playbook"` trigger-entry rows in the local store's `trigger-index.json` (built by the substrate with cross-store supersedes-chain terminal resolution), one new substrate read surface (`em-search --read <id>`: tracked, bounded, single-episode), and rendering rules for the existing RFC-009 advisory activation adapter. The design mirrors the metadata-first model of the pi `tool-context-loader` extension: session start injects imperative READ pointers naming a tracked bounded read command, never bodies; on-demand injection fires through the existing RFC-009 R3 matcher over build-time-expanded standard entry rows. The hard boundary is restated and unchanged: the substrate gains only enforcement-free data, build logic, and a read flag (RFC-008 R1); all event-time rendering lives in the per-project, opt-in, contractually advisory activation adapter (`blocking: false`, exit 0, no decision field on every path); nothing in this RFC gates, blocks, or decides, and the em-* memory tools stay hook-free (Principle 12 I-4). Round-1 panel review (codex, pi GLM-5.2, pi kimi-k2.7-code, negative-scenario-planner; 4x HOLD) reshaped R2's resolution/freshness contracts, replaced the read command, and added the R7 read surface; see `## Second opinion`.

---

## Problem

Playbooks exist and work, but their loading mechanism is prose in a single operator's per-tool memory, not a substrate capability. Evidence gathered 2026-07-10 by runtime probes against the real stores (round-1 panel probes incorporated):

1. **The de facto mechanism is hand-maintained prose.** The tiered multi-agent orchestration playbook is a global lesson episode (terminal `20260709-230355-tiered-multi-agent-orchestration-playboo-e6bb`, observed via `em-search --tag authoritative --limit 2 --no-track`). The only thing that loads it is a standing instruction in the operator's Claude Code auto-memory MEMORY.md telling the agent to run `em-search --tag authoritative --full`. That surface is single-tool, single-operator, per-machine, and invisible to the other consumer projects registered in `~/.episodic-memory/installs.json` (9 entries across 8 projects as of 2026-07-09).
2. **Episode-id pinning in prose fails under revision churn.** The playbook's supersedes chain moved v6 → v9 between 2026-07-09 and 2026-07-10 (three revisions in two days; the chain now has 10 members). Any prose that pins an id goes stale within days; the operator's MEMORY.md explicitly warns "never pin the episode id, revisions change it." Chain-terminal resolution is machinery the substrate already has (`em-trigger-index.mjs` `terminalOf`/`buildChainMaps`, cycle-safe); the prose mechanism cannot use it.
3. **No per-project preference surface exists.** The RFC-009 trigger index's `session_start` section carries exactly three keys today — `critical_entries`, `entries`, `preflight` (observed 2026-07-10 via `em-trigger-index.mjs --merged`). There is no way for one consumer project to say "load this playbook at session start here" while another project opts out. The critical band is earned via validated violation linkage (RFC-009 R1/R2) and is deliberately not an operator-preference surface; declared preferences need their own artifact.
4. **No safe read command exists for a chain-terminal episode.** Broad `--full` query searches truncate at the ~50KB tool-output cap, and the obvious by-id command is worse: `em-search --history <terminal> --full` on the real playbook chain returns ALL 10 members' bodies root-first, measuring 126,148 bytes with 101,647 bytes emitted BEFORE the terminal's body (round-1 probe, three seats converged) — the active revision is exactly what truncation cuts. The same command is also explicitly untracked (`em-search.mjs:179`, "No access tracking for history queries"). A loading mechanism needs a pointer plus a tracked, bounded, single-episode read command; none exists today (R7 adds it).

The pi ecosystem already validates the shape of the fix: `pi-extensions/tool-context-loader` gives each project a config declaring which runbooks preload at session start (metadata index only, never bodies) and which inject just-in-time on tool-moment evidence of relevance, under hard byte budgets (its README.md:9-16, 66-73). This RFC is the episodic-memory equivalent, expressed over episodes instead of loose files.

## Proposal

Same two-plane architecture as RFC-009, unchanged: the substrate owns data and derived indexes (enforcement-free, RFC-008 R1, CAPABILITIES.md); the per-project opt-in activation adapter owns event-time rendering (advisory only). The RFC-009 two-plane contract — hooks read ONLY purpose-built derived artifacts at event time, builds may read `index.jsonl` as build input under the refresh carve-out — is inherited with ONE explicit clarification (R2, freshness fingerprints) that codifies existing practice. This RFC adds no new plane, no new hook registration, no new adapter, and no gating of any kind: enforcement stays decoupled from the memory substrate, and every path this RFC touches exits 0 with no decision field.

### R1 — Per-project playbook preference file (substrate data, enforcement-free)

A new optional per-project data artifact: `<project>/.episodic-memory/playbooks.json`, schema-backed (`schemas/playbooks.schema.json`, Principle 2; unknown keys rejected, matching the derived-index schema discipline of #487/#492).

Shape:

```json
{
  "schema_version": 1,
  "playbooks": [
    { "id": "20260709-225127-tiered-multi-agent-orchestration-playboo-1174", "mode": "session_start" },
    { "id": "<episode-id>", "mode": "on_demand", "triggers": ["multi-agent", "review panel", "activity:review"] }
  ],
  "bounds": { "max_playbooks": 2 }
}
```

- **Selection is by episode id only.** The id may be ANY member of a supersedes chain; the build resolves it to the terminal active revision (R2). Tag-based selectors are rejected: RFC-009 R10 made tags purely descriptive and never load-bearing, and a tag selector would recreate exactly the conflation R10 corrected (see Alternatives).
- **`mode`** is a closed enum: `session_start` (surface at every session start) or `on_demand` (surface when the RFC-009 R3 matcher fires). **`triggers`** (optional, `on_demand` only) uses the RFC-009 R1 trigger grammar (`phrase`, `tool:`, `activity:` — same closed grammars, same escaping); when absent, the playbook episode's own `triggers` field is the fallback.
- **Duplicate rule, split by what each layer can see:** the JSON schema rejects duplicate LITERAL ids (all it can see). Entries whose ids resolve into the SAME supersedes chain (including one id per mode) are a BUILD-time collision: the build drops EVERY entry of that chain, counts the drop, and lists it in the build report (deterministic fail-to-nothing; no which-entry-wins ambiguity). One chain therefore has at most one entry and one mode.
- **Bounds (Principle 6):** at most 32 entries and 64 KiB of file. An over-bound file is handled as malformed (whole file skipped with a note); the build iterates nothing past the bound.
- **Consent, reversibility, and the threat model (Principles 3, 10, 12).** The file is operator-authored in-project; writing it is the activation consent, deleting it is the clean uninstall (made real by R2's fingerprint: deletion invalidates the cache and the derived section drops at the next event). The file changes behavior only in projects that both wrote it AND opted into the RFC-009 activation adapter; no global variant exists. **Threat model, stated plainly:** `<project>/.episodic-memory/` is agent-writable, so an errant or malicious subagent could write this file and mint itself a recurring session-start pointer. The design bounds that surface rather than pretending it away: injected content is pointer-only metadata from the project's own stores (never bodies); only `category: lesson` terminals render (R2), so arbitrary scratch episodes are not injectable; every rendered line carries file provenance (R3) so injection is visible, never ambient; the full active declaration set is listed in every build report (R2) as an audit surface, symmetric with RFC-009 R1's suppression-audit listing; `lesson-suppress.json` mutes any playbook id (R3/R4); and the 32-entry bound caps volume. Comparison with the two sibling per-project files: `lesson-suppress.json` can only MUTE (fail-open removes content — safe direction), while `enforce-config.json` only toggles hooks that P12 install ownership registered. `playbooks.json` is content-ADDING and therefore carries the audit surface those two do not need. Residual risk — a hostile writer pointing at a real, active, global lesson — is accepted and stated (Principle 5); installer-mediated consent hardening is OQ-3.
- **Failure containment (advisory surface):** a malformed, schema-invalid, or over-bound file is skipped with a build-report note and a stderr line, never fatal, and degrades to no playbooks loaded. The RETENTION consumer of this same file deliberately inverts this fail direction — see R5(b).

### R2 — Derived playbook data in the local trigger index (substrate build)

`em-trigger-index.mjs` derives playbook data at build time, persisted ONLY in the LOCAL store's `trigger-index.json` (the preference file is per-project; the global store's index never carries playbook data). Two derived forms, chosen so the RFC-009 event plane consumes them with its EXISTING code paths (round-1 kimi F3):

- **`session_start.playbooks`** — a new array inside the existing `session_start` section: `[{ episode_id, summary, read_command }]`, in preference-file order, for `mode: session_start` entries. It rides `session_start` precisely because that is the object both merge sites already thread (see merge contract below).
- **`entry_class: "playbook"` rows in `entries[]`** — each `mode: on_demand` entry expands into standard trigger-entry rows (one per effective trigger, same `trigger_kind`/`value` grammar), carrying `entry_class: "playbook"`, `summary`, and `read_command`. `matchActivation` then matches them with zero new matching semantics; only rendering branches on `entry_class` (R4).

Build contract:

1. **Cross-store chain resolution (round-1 GLM F3).** When a valid preference file exists, the local build reads BOTH stores' `index.jsonl` as BUILD INPUT for playbook resolution only (the selected episode usually lives in the global store — the flagship playbook does). Chain maps for playbook resolution span the union of both stores' rows; resolution follows `terminalOf` semantics verbatim (cycle-safe, `em-trigger-index.mjs:121-132`). Nothing read here reaches hook output except through the built artifact (the sanctioned carve-out). Non-playbook derivation is unchanged and stays single-store.
2. **Exclusions — every one counted in `build_report.playbooks.excluded` and none fatal:** id resolving to no episode in either store; supersedes cycle; terminal not `status: active`; terminal not `category: lesson` (keeps R10's category routing authority — decisions, violations, and scratch episodes never render as playbooks); expired (`review_by` past); same-chain collision (all entries of that chain dropped); `on_demand` entry whose effective trigger set is empty.
3. **Audit listing (round-1 consent findings).** `build_report.playbooks.declared` lists the full accepted declaration set (`episode_id` + `mode` per entry) on every build — the standing audit surface for what this project injects, symmetric with the RFC-009 clerk's suppression listing. The RFC-009 R9 clerk report SHOULD surface this set per project when it next touches this repo's stores (cross-reference, not a new clerk requirement).
4. **`read_command`** is the exact tracked bounded read invocation precomputed at build time: `node <scripts>/em-search.mjs --read <terminal-id>` (R7). It is precomputed so the hook renders without deciding anything, and it is the TRACKED surface deliberately: the RFC-009 R6 conversion metric can only see reads that flow through access tracking. The previously-considered `--history <id> --full` form is rejected with probe evidence (Problem 4; Alternatives).
5. **Freshness (round-1 codex F1, GLM F4, planner F2 — the fingerprint extension).** The persisted index's `source` fingerprint block is extended, when-and-only-when a preference file exists or existed: it additionally records the `playbooks.json` fingerprint (mtime/size/sha256; an ABSENT file records the zero-state, so both creating and DELETING the file invalidate the cache — deletion really is the clean uninstall) and the GLOBAL store's `index.jsonl` fingerprint (so a global playbook revision — the observed 3-revisions-in-2-days churn — invalidates the local section). The event-plane freshness check extends the same way: the hook STATS these files against the recorded fingerprints exactly as it stats `index.jsonl` today (`activation-hook-run.mjs:193-206`). **Boundary clarification, explicit:** fingerprint STATS are already the sanctioned freshness mechanism of the RFC-009 event plane (existing practice, cited above); the strict read boundary governs CONTENT reads flowing into hook output, and preference-file content is read only by the build. T9's two legs prove the distinction.
6. **Schema version bump (round-1 codex F5).** `TRIGGER_INDEX_SCHEMA_VERSION` 2 → 3 (additive bump per the schema's own versioned-contract clause; `schemas/trigger-index.schema.json` gains `session_start.playbooks`, the `entry_class`/`read_command` entry fields, `build_report.playbooks`, and the extended `source` block). The version check in the cache probe makes every existing cached index rebuild once on upgrade — intended.
7. **Merge contract, both sites named (round-1 GLM F6).** `session_start.playbooks` is local-store-only; the global store never produces one. The hook's `mergeSessionStart` (`activation-hook-run.mjs:333-346`) passes the local array through as `merged.session_start.playbooks`; the CLI merged view (`loadMergedTriggerIndex`, which REBUILDS `session_start` from merged rows at `em-trigger-index.mjs:462`) threads the local store's persisted `playbooks` array into its rebuilt `session_start` unchanged. Neither site recomputes it.
8. Never copies body content anywhere — summaries and metadata only. The RFC-009 body-sentinel fixture extends to playbook bodies (T5).

### R3 — Session-start rendering (advisory adapter, pointer-only)

For `session_start.playbooks` entries, the RFC-009 R4 session-start hook renders one imperative line per playbook, positioned after `critical_entries` and before the tier-2 static blend:

```
playbook (playbooks.json): READ <terminal-id> before proceeding (node <scripts>/em-search.mjs --read <terminal-id>): <summary>
```

- **Provenance prefix is load-bearing** (threat model, R1): a playbook line always names its source file, so declared injection is visible and auditable, never ambient.
- **Suppression applies (round-1 GLM F7):** `lesson-suppress.json` mutes playbook lines by episode id, applied before dedup — RFC-009 R1's "suppression applies to ALL bands" covers this band identically.
- **Count and ordering semantics (round-1 kimi F4):** playbooks have their OWN count cap — `bounds.max_playbooks` (default 2, hard ceiling 8) — consumed in preference-file order. They do not consume tier-1's or tier-2's count caps. The TOKEN budget is the session-start render's existing shared `max_tokens`; the earned critical band renders first and is never starved by declared playbooks.
- **Overflow is named, not counted away (round-1 planner F6, GLM F8):** when the count cap or token budget drops a playbook line, the render's final note names it — `+N more suppressed, incl. playbook <episode_id>` — the same one-bounded-line contract as RFC-009 R3's critical-drop note.
- **Dedup:** if a playbook's terminal id is already a tier-1 CANDIDATE, the critical rendering wins and the playbook line is skipped (the existing candidacy-based dedup rule, `activation-match.mjs:388-417`).
- **Advisory invariant unchanged and conformance-asserted:** exit 0 on every path, additionalContext only, no decision field. A missing or malformed `playbooks` array renders nothing with a stderr note (the RFC-009 R4 failure mode, unchanged).

### R4 — On-demand rendering (advisory adapter, existing matcher literally)

`entry_class: "playbook"` rows flow through the existing `matchActivation` untouched — same phrase/tool/activity matching, word-boundary semantics, case folding, suppression, dedup, `max_matches`/`max_tokens` bounds. The ONLY change is rendering: an entry with `entry_class: "playbook"` renders the R3 playbook form (provenance prefix + READ + `read_command`) instead of the lesson forms, regardless of priority fields. This is the pi `tool_result`-JIT analogue at pointer strength: relevance evidence first, then a pointer, never an unrequested body.

### R5 — Retention safety for referenced playbooks

A playbook referenced by a project's preference file is load-bearing for that project, but injection reads only the derived index and never bumps `access_count` — and with pointer-follows landing on R7's tracked read, a NEVER-followed playbook still scores as dead (zero-access episodes prunable at ~310 days, RFC-009 R6). Protections, both mechanical (Principle 4):

- **(a) Build warning:** the R2 build report flags any selected playbook whose terminal episode is unpinned, recommending `em-pin` (pinned episodes already floor scoring decay and are never pruned).
- **(b) Prune protection, chain-anchored and fail-closed (round-1 codex F3, planner F5, GLM F9):** `computeProtectedIds` (the shared protection module, `scripts/lib/protection.mjs`) gains reason `playbook-referenced`: the configured id is resolved and the protection anchors the RESOLVED CHAIN (the existing chain-closure pass extends it to every member including the terminal — never just the literal id in the file). Inputs: the local project's `playbooks.json` directly; for the global store, preference files enumerated across registered consumer projects via `~/.episodic-memory/installs.json` (the same registry pattern as the shipped cross-store members `em-promote`/`em-stats`/`em-doctor`; only episode IDS are read from sibling configs, never bodies, all same-user local disk). **Fail direction inverts the advisory rule:** a PRESENT-but-unparseable protection input (`playbooks.json` or `installs.json`, including torn mid-write reads) ABORTS archival — `em-prune` exits 1 and archives nothing — because prune is a manual curation command and silent unprotection is the failure that cannot be undone cheaply. An absent file contributes nothing and aborts nothing. The asymmetry is deliberate and stated: advisory surfaces fail open to silence; retention fails closed.
- **Honest residuals (Principle 5):** the registry undercounts (it tracks only post-registry installs), and a project removed from the registry lapses its global-store protection. `em-pin` plus the (a) warning are the durable guards; (b) is best-effort defense in depth for global episodes.

### R6 — Telemetry (conditional) and the body-injection deferral

RFC-009's R6 telemetry (`activation-log.jsonl`) is NOT yet built — it is deferred to RFC-009 P4 (`docs/plans/rfc-009-p2.md:398-401`). Phase 1 of this RFC therefore ships NO telemetry (explicit non-goal); when RFC-009 P4 lands the log, its rendered-form value set gains `playbook` under that log's own schema/versioning contract, and playbook conversion becomes measurable because R7's `--read` is a tracked surface.

**Explicit deferral (the pi body-excerpt analogue):** injecting bounded playbook BODY excerpts (session-start or JIT) is deliberately NOT in this RFC. It would amend the RFC-009 R3/R4 payload contract and its body-sentinel acceptance fixture. The reopening gate is evidence: R6 conversion data (which requires BOTH RFC-009 P4 telemetry AND R7 — both named dependencies, neither assumed) showing playbook pointers systematically not followed. If that evidence arrives, the change lands as a revision of this RFC with the amended fixtures named, never a quiet patch. Note that pi's own preload mode ships metadata-only for the same token-hygiene reason (Principle 6).

### R7 — Tracked bounded single-episode read (substrate, `em-search`)

`em-search.mjs` gains `--read <id>`: fetch exactly one episode by exact id (no chain walk), full frontmatter + body, output `{ status: "ok", episode: {...} }` — bounded at one episode (~18KB for the flagship playbook, safely under the ~50KB cap). The read WRITES access tracking (`access_count` + `last_accessed`) on that row, honoring `--no-track`; an unknown id returns an error status. This is the missing surface Problem 4 measures the absence of, and it is what makes "the tracked read command" a true claim instead of a false one.

Scope note: RFC-009 R3's imperative rendering names `em-search --history <id> --full` as its tracked command — the round-1 panel proved that claim false today (untracked at `em-search.mjs:179`, and oversized on real chains). This RFC does not amend RFC-009's text; a tracking issue is filed at implementation to migrate RFC-009's rendering to `--read` (same defect, same fix).

### Data-artifact contracts (completeness table)

| Artifact | Owner | Bound | Schema | Consumers |
|---|---|---|---|---|
| `<project>/.episodic-memory/playbooks.json` | operator (per-project) | 32 entries / 64 KiB; over-bound = malformed | `schemas/playbooks.schema.json` (`schema_version: 1`, int, matching the derived-index convention) | R2 build (content); event-plane freshness (stat only); `em-prune` protection (R5b, fail-closed) |
| `trigger-index.json` v3 additions (`session_start.playbooks`, `entry_class`/`read_command` entry fields, `build_report.playbooks`, extended `source`) | build (derived) | inherits R1 bounds + `max_playbooks` render cap | `schemas/trigger-index.schema.json` (bumped to 3) | activation hook (both event paths); `--merged` CLI |
| `build_report.playbooks` (`declared` list + `excluded` counters) | build (derived) | bounded by R1 | part of trigger-index v3 | operator audit; OQ-1 em-doctor check |

### Per-tool tier (Principle 5)

The derived playbook data is harness-agnostic. Rendering ships where the RFC-009 activation adapter ships: claude-code STRONG (this RFC's Phase 1). codex / pi-agent / cursor / opencode inherit the data when their RFC-009 MEDIUM-tier adapter phases land; windsurf WEAK (session-start file surfacing only). No tier is claimed beyond its shipped adapter.

### Substrate script coverage (disposition per em-* script)

| Script | Disposition |
|---|---|
| `em-trigger-index.mjs` | CHANGED — R2 in full: playbook derivation, cross-store resolution input, fingerprint extension, schema v3, build report, merged-view threading (`:462`) |
| `em-search.mjs` | CHANGED — R7 `--read <id>` tracked bounded single-episode read |
| `scripts/lib/activation-match.mjs` | CHANGED — R3 session-start playbook band (suppress, dedup, caps, note), R4 `entry_class` render branch |
| `plugins/claude-code-activation/hooks/activation-hook-run.mjs` | CHANGED — `mergeSessionStart` playbooks pass-through, freshness stat extension; manifest checksums hand-regenerated (no tooling exists) |
| `scripts/lib/protection.mjs` + `em-prune.mjs` | CHANGED — R5(b) `playbook-referenced` chain-anchored reason, registry enumeration (`registered-stores.mjs`), fail-closed rule |
| `em-consolidate.mjs` | CHANGED (light) — shares `computeProtectedIds`; the new protection inputs thread through both callers so prune and consolidate keep the identical guarantee |
| `validate-schemas.mjs` + `schemas/` | CHANGED — `playbooks.schema.json` (auto-discovered; `MIN_SCHEMA_DOCS` floor + comment bumped), trigger-index schema v3 |
| `em-store.mjs` / `em-revise.mjs` | INTERACTS — playbooks stored/revised as normal lesson episodes; their R9a lazy index rebuild picks up preference changes via the R2 fingerprint; no code change |
| `em-pin.mjs` | INTERACTS — recommended protection for selected playbooks; unchanged |
| `em-recall.mjs` | INTERACTS — stays out of all hook paths (RFC-009 R4 ruling); unchanged |
| `em-doctor.mjs` | INTERACTS — OQ-1 candidate for a playbooks health check; unchanged in Phase 1 |
| `second-opinion.mjs` | INTERACTS — the RFC-009 R7 dispatcher could inject playbook pointers into review dispatches; out of scope, noted |
| All other `em-*`, `bp1-*`, `classifier-*`, `validate-*`, `enforce-*` scripts | UNCHANGED |

### Scope

**In scope (Phase 1):** R1 schema + file contract; R2 build derivation (cross-store resolution, fingerprints, v3 bump, build report); R3/R4 claude-code rendering; R5 protections; R7 `--read`; acceptance fixtures; docs (README.md, docs/USER_MANUAL.md, docs/EM_SCRIPTS_GUIDE.md, instructions/SKILL.md — per-script helper sections; deployed copies refreshed via install, never hand-edited).

**Non-goals:** telemetry (conditional on RFC-009 P4 — R6); body-excerpt injection (deferred — R6); non-claude-code adapter rendering (inherits RFC-009 adapter phases); installer seeding flags; a global preference file; amending RFC-009's text (the `--history` defect is filed as an issue instead); any enforcement, gating, or blocking behavior anywhere.

## Alternatives considered

| Alternative | Verdict | Rationale |
|---|---|---|
| Tag-based selection (`{"tag": "authoritative"}`, auto-enrolling matching episodes) | REJECTED | Load-bearing tags are exactly what RFC-009 R10 abolished; auto-enrollment also fires content the project never explicitly consented to (Principle 3) |
| pi-style loose markdown playbook files under project roots | REJECTED | A second content store (Principle 1); episodes already carry playbooks with revision chains, scopes, and access tracking — the churn machinery this feature needs |
| Hook-time preference read (the `lesson-suppress.json` pattern) | REJECTED | Chain-terminal resolution requires `index.jsonl` reads, banned as event-time input by the RFC-009 strict boundary; build-time derivation keeps the hook mechanical. The suppress precedent is an id-set membership check with no store reads — a different class |
| `em-search --history <id> --full` as the read command | REJECTED (round 1) | Probe-measured 126,148 bytes on the real 10-member chain with the terminal LAST (101,647 bytes before it) — recreates the truncation failure this RFC exists to avoid; and the `--history` path is explicitly untracked (`em-search.mjs:179`), falsifying the conversion premise. Adding tracking to `--history` alone was also rejected: it leaves the truncation defect intact. R7's `--read` fixes both |
| A standalone top-level `playbooks` index section (outside `session_start`) | REJECTED (round 1) | The hook's `mergeSessionStart` and the CLI's merged rebuild thread `session_start` today; a new top-level key would need parallel plumbing at both sites for no benefit. Session-start payload belongs in the session-start object; on-demand candidates belong in `entries[]` where the matcher already looks |
| Session-start body injection (pi `preload: body` analogue) | REJECTED / DEFERRED | Violates the inherited R4 body-sentinel payload contract; pi itself ships preload as metadata-only; R6 names the evidence gate and its real dependencies |
| New `playbook` category | REJECTED (revisit-able) | The R10 category vocabulary is closed and lifecycle-bearing; the real playbook already lives as `category: lesson`, and R2's category guard enforces lesson-only rendering without a routing-axis change. Revisit only if playbooks develop lifecycle distinct from lessons |
| Extending the earned critical band to carry playbooks | REJECTED | The band is earned via validated violation linkage and audited demotion; mixing declared preferences into it would break the earned/declared distinction RFC-009 R4 is built on |
| Installer-gated consent for `playbooks.json` | REJECTED for Phase 1 (OQ-3) | Would make every preference edit an install action for a pointer-only advisory surface; the R1 threat model bounds the risk with visibility (provenance prefix), auditability (declaration listing), the category guard, suppression, and bounds instead. Revisit with field evidence |

## Implementation plan

Single implementation phase (P1), one PR, slice ladder in the phase plan document (`docs/plans/rfc-011-p1.md`, PLAN_TEMPLATE §1-20 + Appendix A). Deferred P2 (body excerpts) is intentionally unscheduled pending R6 evidence.

## Acceptance tests (Phase 1 gate)

| # | Fixture | Asserts |
|---|---|---|
| T1 | schema validation | valid file passes; unknown keys, bad mode, duplicate LITERAL ids, `triggers` on a `session_start` entry fail; empty `playbooks` array is VALID and renders nothing; over-bound (33 entries / >64 KiB) handled as malformed |
| T2 | build resolution, cross-store | preference names a superseded id whose chain lives in the GLOBAL store while the build runs on the LOCAL store; `session_start.playbooks` carries the terminal with its summary and `--read` command. Exclusion matrix each counted in `build_report.playbooks.excluded`: unresolvable id, cycle, non-active terminal, non-lesson terminal (`category: decision`), expired, same-chain collision (both entries dropped, both modes), empty effective triggers. `declared` lists the accepted set |
| T3 | freshness | editing `playbooks.json` invalidates the cache (section rebuilt); DELETING it invalidates (section gone — clean uninstall); revising the GLOBAL playbook invalidates the LOCAL section (fingerprint mismatch); untouched inputs = cache hit |
| T4 | session-start render | playbook line renders with provenance prefix + `--read` command, positioned after `critical_entries`; absent file = no render; malformed file = stderr note, exit 0, nothing rendered; suppressed id (lesson-suppress.json) never renders; id also tier-1 candidate renders once (critical form); `max_playbooks` drop emits the note NAMING the dropped playbook id |
| T5 | body sentinel | a distinctive string planted in the playbook episode BODY never appears in any hook output (extends the RFC-009 R4 fixture) |
| T6 | on-demand match | prompt matching an effective trigger renders the playbook form via the standard matcher inside existing bounds; `tool:` trigger playbook fires on the tool event; suppression honored; `entry_class` rows validate against schema v3 |
| T7 | retention | `em-prune --dry-run` protects the RESOLVED CHAIN (terminal + members) of a locally-referenced playbook with reason `playbook-referenced`; global leg protects via a fixture `installs.json` enumerating a second mock project; PRESENT-but-corrupt `playbooks.json` (including a torn-write fixture) aborts archival with exit 1; absent file archives normally; build report flags the unpinned selection |
| T8 | advisory invariant | every new path exits 0 with no decision field (conformance gauntlet extension) |
| T9 | strict-boundary, two discriminating legs | (a) contradicting-file: `playbooks.json` says X, derived section says Y — hook output follows Y; (b) unreadable-file: `playbooks.json` replaced by a directory — hook output byte-identical to the readable case, exit 0. Together: content never flows at event time, stats only |
| T10 | `--read` surface | `--read <id>` returns exactly one episode, output under the cap on the real-size fixture; `access_count`/`last_accessed` increment on the read row; `--no-track` leaves them untouched; unknown id = error status |
| T11 | target-store binding | the preference-file read binds to the `--project` store under `caller_cwd != target` (extends the RFC-009 R2 binding fixture to the new per-project input) |
| T12 | schema-version migration | a cached v2 `trigger-index.json` is treated as stale and rebuilt to v3; `test-trigger-index-schema.mjs` negatives updated (v2 rejected like v1) |

## Related RFCs

- **RFC-009 (accepted)** — supplies every mechanism this RFC composes: R1 trigger grammar, R2 derived index + freshness + build report, R3 matcher + rendering + bounds + suppression, R4 session-start surface + strict read boundary, R6 telemetry (pending P4), R10 taxonomy. This RFC adds a declared-preference surface beside R4's earned band, one boundary CLARIFICATION (fingerprint stats, R2.5), and changes none of RFC-009's contracts. One latent RFC-009 defect (untracked `--history` in the R3 rendering) is discharged via a filed issue + R7, not a text amendment.
- **RFC-008 (accepted)** — the enforcement/substrate decoupling this RFC preserves: everything substrate-side here is data + build + a read flag (R1), everything event-side is the advisory adapter, and no gate logic is introduced anywhere.
- **RFC-007 (draft)** — structural playbook-to-lesson edges remain graph territory; this RFC keeps relations as prose.

## Second opinion

| Round | Provider | Verdict | Blockers | Disposition |
|---|---|---|---|---|
| 1 | codex (gpt-5.5, tmux seat) | HOLD | 7 findings (2 P1) | all ACCEPTED (F6 with modification); resolutions in R1/R2/R5/R7 + T-rows |
| 1 | negative-scenario-planner (Claude agent) | HOLD | 9 findings (1 P1) | all ACCEPTED (F3 with modification); read-command redesign (R7), freshness extension, fail-closed prune, T9 two-leg fixture |
| 1 | pi GLM-5.2 (tmux seat) | HOLD | 9 findings (4 P2 blockers) | all ACCEPTED; cross-store resolution contract (R2.1), deletion-invalidates (R2.5), merge-site contract (R2.7), suppression (R3) |
| 1 | pi kimi-k2.7-code (tmux seat) | HOLD | 11 findings | all ACCEPTED (F1/F5/F9 with modification); entry-shape conversion layer (R2 derived forms), count-cap semantics (R3), bounds (R1) |
| 2 | (same panel) | pending | — | — |

Round-1 convergences (highest confidence): the read command (4 seats), freshness/fingerprint gap (4 seats), consent threat model (3 seats), non-lesson category guard (3 seats), T9 vacuity (2 seats). Triage ledger with per-finding dispositions: session artifact `rfc-011-triage-r1.md`.

## Open questions

- **OQ-1** — Should `em-doctor` gain a `playbooks` health check (unresolvable ids, unpinned selections, declaration-set report) beyond the build report? Leaning yes, later phase; the build report covers Phase 1.
- **OQ-2** — When MEDIUM-tier adapters (pi-agent, codex) land, should `read_command` be harness-parameterized (pi seats read a FILE copy per the playbook's own load recipe, not an em-search invocation)? Deferred to those adapter phases; the derived shape (`episode_id` + `summary` + `read_command`) already lets each adapter render its own recipe.
- **OQ-3** — Installer-mediated consent hardening for `playbooks.json` (ownership/checksum manifest row, explicit opt-in flag)? Rejected for Phase 1 with the R1 threat model as mitigation; revisit if the audit surface shows abuse in practice.
