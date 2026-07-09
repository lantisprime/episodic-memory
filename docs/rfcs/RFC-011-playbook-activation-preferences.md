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

> This RFC lets each project that consumes episodic-memory declare its own preferences for loading playbooks (operator-authored operational guides stored as episodes, e.g. the tiered multi-agent orchestration playbook) either at session start or on demand at the moment of relevance. It adds one per-project data artifact (`<project>/.episodic-memory/playbooks.json`, schema-backed), one derived-index section (`playbooks` in the local store's `trigger-index.json`, built by the substrate with supersedes-chain terminal resolution), and rendering rules for the existing RFC-009 advisory activation adapter. The design deliberately mirrors the metadata-first model of the pi `tool-context-loader` extension: session start injects imperative READ pointers naming the tracked read command, never bodies; on-demand injection fires through the existing RFC-009 R3 matcher. The hard boundary is restated and unchanged: the substrate gains only enforcement-free data and build logic (RFC-008 R1); all event-time rendering lives in the per-project, opt-in, contractually advisory activation adapter (`blocking: false`, exit 0, no decision field on every path); nothing in this RFC gates, blocks, or decides, and the em-* memory tools stay hook-free (Principle 12 I-4).

---

## Problem

Playbooks exist and work, but their loading mechanism is prose in a single operator's per-tool memory, not a substrate capability. Evidence gathered 2026-07-10 by runtime probes against the real stores:

1. **The de facto mechanism is hand-maintained prose.** The tiered multi-agent orchestration playbook is a global lesson episode (terminal `20260709-230355-tiered-multi-agent-orchestration-playboo-e6bb`, observed via `em-search --tag authoritative --limit 2 --no-track`). The only thing that loads it is a standing instruction in the operator's Claude Code auto-memory MEMORY.md telling the agent to run `em-search --tag authoritative --full`. That surface is single-tool, single-operator, per-machine, and invisible to the other consumer projects registered in `~/.episodic-memory/installs.json` (9 entries across 8 projects as of 2026-07-09).
2. **Episode-id pinning in prose fails under revision churn.** The playbook's supersedes chain moved v6 → v9 between 2026-07-09 and 2026-07-10 (three revisions in two days, observed in the chain: `…-1174` superseded by `…-e6bb`). Any prose that pins an id goes stale within days; the operator's MEMORY.md explicitly warns "never pin the episode id, revisions change it." Chain-terminal resolution is machinery the substrate already has (the RFC-009 R2 build resolves supersedes chains); the prose mechanism cannot use it.
3. **No per-project preference surface exists.** The RFC-009 trigger index's `session_start` section carries exactly three keys today — `critical_entries`, `entries`, `preflight` (observed 2026-07-10 via `em-trigger-index.mjs --merged` piped through `jq`: `policy_keys: ["critical_entries","entries","preflight"]`). There is no way for one consumer project to say "load this playbook at session start here" while another project opts out. The critical band is earned via validated violation linkage (RFC-009 R1/R2) and is deliberately not an operator-preference surface; declared preferences need their own artifact.
4. **Oversized loads are a real failure mode.** The playbook's own load recipe exists because broad `--full` query searches truncate at the ~50KB tool-output cap; the working recipe is a narrow tag search of a single ~18KB episode. A loading mechanism must emit pointers plus the exact safe read command, not attempt inline injection of bodies.

The pi ecosystem already validates the shape of the fix: `pi-extensions/tool-context-loader` gives each project a config declaring which runbooks preload at session start (metadata index only, never bodies) and which inject just-in-time on tool-moment evidence of relevance, under hard byte budgets (its README.md:9-16, 66-73). This RFC is the episodic-memory equivalent, expressed over episodes instead of loose files.

## Proposal

Same two-plane architecture as RFC-009, unchanged: the substrate owns data and derived indexes (enforcement-free, RFC-008 R1, CAPABILITIES.md); the per-project opt-in activation adapter owns event-time rendering (advisory only). The RFC-009 two-plane contract — hooks read ONLY purpose-built derived artifacts at event time, builds may read `index.jsonl` as build input under the refresh carve-out — is inherited without modification. This RFC adds no new plane, no new hook registration, no new adapter, and no gating of any kind: enforcement stays decoupled from the memory substrate, and every path this RFC touches exits 0 with no decision field.

### R1 — Per-project playbook preference file (substrate data, enforcement-free)

A new optional per-project data artifact: `<project>/.episodic-memory/playbooks.json`, schema-backed (`schemas/playbooks.schema.json`, Principle 2; unknown keys rejected, matching the derived-index schema discipline of #487/#492).

Shape:

```json
{
  "$schema_version": "1.0.0",
  "playbooks": [
    { "id": "20260709-225127-tiered-multi-agent-orchestration-playboo-1174", "mode": "session_start" },
    { "id": "<episode-id>", "mode": "on_demand", "triggers": ["multi-agent", "review panel", "activity:review"] }
  ]
}
```

- **Selection is by episode id only.** The id may be ANY member of a supersedes chain; the build resolves it to the terminal active revision (R2). Tag-based selectors are rejected: RFC-009 R10 made tags purely descriptive and never load-bearing, and a tag selector would recreate exactly the conflation R10 corrected (see Alternatives).
- **`mode`** is a closed enum: `session_start` (surface at every session start) or `on_demand` (surface when the RFC-009 R3 matcher fires). One entry per chain; a chain listed twice is a schema violation.
- **`triggers`** (optional, `on_demand` only): RFC-009 R1 trigger grammar (`phrase`, `tool:`, `activity:` — same closed grammars, same escaping). When absent, the playbook episode's own `triggers` field is the fallback. An `on_demand` entry whose effective trigger set resolves empty is excluded at build time and counted in the build report (it could never fire; silent inclusion would be dead config).
- **Consent and reversibility (Principles 3, 10, 12):** the file is operator-authored in-project; writing it IS the activation consent, deleting it is the clean uninstall. Absent file = feature entirely off (nothing loads, no defaults). No installer involvement is required in Phase 1; the file changes behavior only in projects that both wrote it AND opted into the RFC-009 activation adapter. No global variant exists — per-project preference is the feature.
- **Failure containment:** a malformed or schema-invalid file is skipped with a build-report note and a stderr line, never fatal, and degrades to no playbooks loaded (advisory surface; consistent with the RFC-009 malformed-trigger rule).

### R2 — Derived `playbooks` section in the local trigger index (substrate build)

`em-trigger-index.mjs` gains a `playbooks` section, derived at build time and persisted ONLY in the LOCAL store's `trigger-index.json` (the preference file is per-project, so the derived section is per-project; the global store's index never carries one). The merged view (`--merged`) passes it through unchanged.

Per entry, the build:

1. Resolves the configured id through the supersedes chain to the terminal revision, consulting both the local and global store indexes as build input (the selected episode usually lives in the global store; reading `index.jsonl` at build time is the sanctioned carve-out, and nothing read here reaches hook output except through the built artifact).
2. Excludes and counts (build report, the RFC-009 drift surface): ids that resolve to no episode, to a non-`active` terminal, or to an expired lesson; `on_demand` entries with an empty effective trigger set; duplicate chain references.
3. Emits `{ episode_id, summary, mode, effective_triggers, read_command }` where `read_command` is the exact tracked read invocation: `node <scripts>/em-search.mjs --history <terminal-id> --full`. The command is precomputed at build time so the hook renders without deciding anything. It is the TRACKED form deliberately: direct file reads and `--no-track` searches are invisible to access tracking, and the RFC-009 R6 conversion metric must see playbook reads (same reasoning as the R3 imperative rendering contract).
4. Never copies body content into the section — summaries and metadata only. The RFC-009 body-sentinel fixture extends to playbook bodies (Acceptance tests).

Freshness: the section participates in the existing R2 lazy-freshness contract unchanged — a stale index rebuilds under the event-plane carve-out; `playbooks.json` joins the build's freshness inputs (a preference edit invalidates the cache the same way a store write does).

### R3 — Session-start rendering (advisory adapter, pointer-only)

For `mode: session_start` entries, the RFC-009 R4 session-start hook renders one imperative line per playbook, immediately after `critical_entries` and before the tier-2 static blend:

```
READ <terminal-id> before proceeding (node <scripts>/em-search.mjs --history <terminal-id> --full): <summary>
```

- Same rendering contract as the critical band (imperative form, tracked command named), same shared `max_tokens` budget, same overflow note semantics: entries load in file order; when the budget drops one, the final line names the count (never silent truncation).
- Ordering rationale: the critical band is EARNED (validated violation linkage, RFC-009 R1) and stays first; playbook entries are DECLARED but carry the strongest available consent signal (explicit per-project operator config), so they precede the statistically-blended tier 2.
- Dedup: if a playbook's terminal id already appears in `critical_entries`, the critical rendering wins and the playbook line is skipped (one entry per episode id per event, the RFC-009 R3 dedup rule, unchanged).
- Advisory invariant unchanged and conformance-asserted: exit 0 on every path, additionalContext only, no decision field. A missing or malformed `playbooks` section renders nothing with a stderr note (exactly the RFC-009 R4 failure mode).

### R4 — On-demand rendering (advisory adapter, existing matcher)

For `mode: on_demand` entries, the existing RFC-009 R3 matcher (UserPromptSubmit + PreToolUse, phrase/tool/activity grammars, word-boundary semantics, case folding) matches against `effective_triggers` and renders the SAME imperative READ pointer as R3, counted inside the existing `max_matches` / `max_tokens` bounds with the existing suppression (`lesson-suppress.json`) honored by episode id. No new matching semantics are introduced; playbook entries are additional match candidates with a distinct rendered form. This is the pi `tool_result`-JIT analogue at pointer strength: relevance evidence first, then a pointer, never an unrequested body.

### R5 — Retention safety for referenced playbooks

A playbook referenced by a project's preference file is load-bearing for that project, but injection reads only the derived index and never bumps `access_count` (the same invisibility RFC-009 R6 documents for trigger-bearing lessons). Two mechanical protections (Principle 4):

- **(a) Build warning:** the R2 build report flags any selected playbook whose terminal episode is unpinned, recommending `em-pin` (pinned episodes already floor scoring decay and are never pruned).
- **(b) Prune protection:** `em-prune` extends its protection set — never archive an episode referenced by the local project's `playbooks.json` (direct read, exact); for the global store, enumerate preference files across registered consumer projects via `~/.episodic-memory/installs.json`, with the registry's known undercount stated honestly (Principle 5): the registry only tracks post-registry installs, so (b) is best-effort for global episodes and (a) plus `em-pin` remains the reliable protection. The protection reason string is `playbook-referenced`.

### R6 — Telemetry and the body-injection deferral

Playbook injections append the same RFC-009 R6 `activation-log.jsonl` telemetry line, with the rendered-form field extended by one value (`playbook`) so conversion is measurable per mode. The R6 conversion metric applies unchanged: the read command is the tracked surface, conversion is a stated lower bound.

**Explicit deferral (the pi body-excerpt analogue):** injecting bounded playbook BODY excerpts (session-start or JIT) is deliberately NOT in this RFC. It would amend the RFC-009 R3/R4 payload contract and its body-sentinel acceptance fixture — a contract this RFC inherits as-is. The gate for reopening it is evidence, not appetite: R6 conversion data showing session-start/on-demand playbook pointers systematically not followed. If that evidence arrives, the change lands as a revision of this RFC with the amended fixtures named, never a quiet patch. Note that pi's own preload mode ships metadata-only for the same token-hygiene reason (Principle 6).

### Per-tool tier (Principle 5)

The derived `playbooks` section is harness-agnostic data. Rendering ships where the RFC-009 activation adapter ships: claude-code STRONG (this RFC's Phase 1). codex / pi-agent / cursor / opencode inherit the section when their RFC-009 MEDIUM-tier adapter phases land (each renders playbook pointers through its mapped session-start and prompt/tool channels, per the RFC-009 per-harness event mapping table); windsurf WEAK (session-start file surfacing only). No tier is claimed beyond its shipped adapter.

### Substrate script coverage (disposition per em-* script)

| Script | Disposition |
|---|---|
| `em-trigger-index.mjs` | CHANGED — R2 `playbooks` section, preference-file freshness input, build-report exclusions |
| `scripts/lib/activation-match.mjs`, `scripts/lib/activation.mjs` | CHANGED — R3/R4 rendering + match candidates, dedup |
| `plugins/claude-code-activation/*` | CHANGED — consume the section; manifest checksums bump |
| `em-prune.mjs` | CHANGED — R5(b) `playbook-referenced` protection |
| `validate-schemas.mjs` + `schemas/` | CHANGED — `playbooks.schema.json`, trigger-index schema gains the section |
| `em-store.mjs` / `em-revise.mjs` | INTERACTS — playbooks stored/revised as normal episodes; chain resolution covers revision churn; no code change |
| `em-search.mjs` | INTERACTS — target of the tracked `read_command`; unchanged |
| `em-pin.mjs` | INTERACTS — recommended protection for selected playbooks; unchanged |
| `em-consolidate.mjs` | INTERACTS — chain folding preserves terminals the build resolves to (existing invariant); unchanged |
| `em-recall.mjs` | INTERACTS — stays out of all hook paths (RFC-009 R4 ruling); unchanged |
| `em-doctor.mjs` | INTERACTS — MAY surface unpinned-selected-playbook warnings in a later phase; unchanged in Phase 1 |
| `second-opinion.mjs` | INTERACTS — the R7 dispatcher could inject playbook pointers into review dispatches; out of scope, noted |
| All other `em-*`, `bp1-*`, `classifier-*`, `validate-*`, `enforce-*` scripts | UNCHANGED |

### Scope

**In scope (Phase 1):** R1 schema + file contract; R2 build derivation; R3/R4 claude-code rendering; R5 protections; R6 telemetry form value; acceptance fixtures; docs.

**Non-goals:** body-excerpt injection (deferred, R6); non-claude-code adapter rendering (inherits RFC-009 adapter phases); installer seeding flags; a global preference file; any enforcement, gating, or blocking behavior anywhere; changes to `em-recall`, the enforcement layer, or any RFC-008 contract.

## Alternatives considered

| Alternative | Verdict | Rationale |
|---|---|---|
| Tag-based selection (`{"tag": "authoritative"}`, auto-enrolling matching episodes) | REJECTED | Load-bearing tags are exactly what RFC-009 R10 abolished; auto-enrollment also fires content the project never explicitly consented to (Principle 3) |
| pi-style loose markdown playbook files under project roots | REJECTED | A second content store (Principle 1); episodes already carry playbooks with revision chains, scopes, and access tracking — the churn machinery this feature needs |
| Hook-time preference read (the `lesson-suppress.json` pattern) | REJECTED | Chain-terminal resolution requires `index.jsonl` reads, which are banned as event-time input by the RFC-009 strict boundary; the suppress precedent is an id-set membership check with no store reads — a different class. Build-time derivation keeps the hook mechanical |
| Session-start body injection (pi `preload: body` analogue) | REJECTED / DEFERRED | Violates the inherited R4 body-sentinel payload contract; pi itself ships preload as metadata-only; R6 makes pointer conversion measurable before any contract change (see R6 deferral) |
| New `playbook` category | REJECTED (revisit-able) | The R10 category vocabulary is closed and lifecycle-bearing; the real playbook already lives as `category: lesson` and id-selection needs no routing axis. Revisit only if playbooks develop lifecycle distinct from lessons |
| Extending the earned critical band to carry playbooks | REJECTED | The band is earned via validated violation linkage and audited demotion; mixing declared preferences into it would break the earned/declared distinction RFC-009 R4 is built on |

## Implementation plan

Single implementation phase (P1), one PR, slice ladder in the phase plan document (`docs/plans/rfc-011-p1.md`, PLAN_TEMPLATE §1-20 + Appendix A). Deferred P2 (body excerpts) is intentionally unscheduled pending R6 evidence.

## Acceptance tests (Phase 1 gate)

| # | Fixture | Asserts |
|---|---|---|
| T1 | schema validation | valid file passes; unknown keys, bad mode, duplicate chain ids fail |
| T2 | build resolution | preference names a superseded id in chain a→b→c; section carries terminal c with its summary and `read_command`; unresolvable / inactive / expired ids excluded AND counted in the build report |
| T3 | session-start render | `session_start` playbook renders one imperative READ line naming the tracked command, positioned after `critical_entries`; absent file = no section, no render; malformed file = stderr note, exit 0, nothing rendered |
| T4 | on-demand match | prompt matching an `effective_triggers` phrase renders the pointer inside existing bounds; empty effective trigger set lands in the build report, never in the index |
| T5 | body sentinel | a distinctive string planted in the playbook episode BODY never appears in any hook output (extends the RFC-009 R4 fixture) |
| T6 | dedup | playbook terminal id also present in `critical_entries` renders exactly once (critical form) |
| T7 | retention | `em-prune --dry-run` on a fixture store protects a locally-referenced playbook with reason `playbook-referenced`; build report flags the unpinned selection |
| T8 | advisory invariant | every new path exits 0 with no decision field (conformance gauntlet extension); suppression by episode id still honored |
| T9 | environment independence | hook output byte-identical with `playbooks.json` present-and-consumed vs the derived section alone (proving the hook reads only the built artifact, never the preference file) |

## Related RFCs

- **RFC-009 (accepted)** — supplies every mechanism this RFC composes: R1 trigger grammar, R2 derived index + freshness + build report, R3 matcher + rendering + bounds + suppression, R4 session-start surface + strict read boundary, R6 telemetry. This RFC adds a declared-preference surface beside R4's earned band and changes none of RFC-009's contracts.
- **RFC-008 (accepted)** — the enforcement/substrate decoupling this RFC preserves: everything substrate-side here is data + build (R1), everything event-side is the advisory adapter, and no gate logic is introduced anywhere.
- **RFC-007 (draft)** — structural playbook-to-lesson edges remain graph territory; this RFC keeps relations as prose.

## Second opinion

| Round | Provider | Verdict | Blockers | Reply artifact |
|---|---|---|---|---|
| 1 | codex | pending | — | — |

## Open questions

- **OQ-1** — Should `em-doctor` gain a `playbooks` health check (unresolvable ids, unpinned selections) beyond the build report? Leaning yes, later phase; the build report covers Phase 1.
- **OQ-2** — When MEDIUM-tier adapters (pi-agent, codex) land, should the `read_command` be harness-parameterized (pi seats read a FILE copy per the playbook's own load recipe, not an em-search invocation)? Deferred to those adapter phases; the section's data shape (`episode_id` + `summary` + mode) is already sufficient for them to render their own recipe.
