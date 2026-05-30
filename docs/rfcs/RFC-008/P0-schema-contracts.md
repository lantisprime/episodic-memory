# P0 — Locked schema + data contracts

> Part of [RFC-008](../RFC-008-decouple-enforcement-from-substrate.md). Index:
> [RFC-008/README.md](README.md).

**Status:** **DONE** — PR #367 (`d078fdc`, 2026-05-29). Verified green on merged main:
`node tests/test-p0-schemas.mjs` → 89/0; `em-rfc-validate` consistent. Docs + schema only —
nothing deployed.
**Serves:** R3, R4 (+ closes findings F11–F51).
**Depends on:** — (cheapest, no deps).

## What P0 is

P0 is the **locked contract layer**: every JSON-Schema document and data file the later
phases validate against, shipped *before* any code so the validators (P1/P2/P3) have a
fixed target. No shipped `.mjs` runtime/CI validators (T17) — those land in P1+. Test-only
`.mjs` under `tests/` is permitted and required (Rule-18 ships tests alongside).

## Architecture

```mermaid
graph TB
    subgraph DATA["Data (the source of truth)"]
        TAX["patterns/taxonomy.json<br/>(7 labels + non_overridable)"]
        EVS["patterns/events.json<br/>(5 events + action semantics)"]
        BYP["plugins/bypass_known.json<br/>(Codex pre_tool_use: MEDIUM ceiling)"]
    end

    subgraph SCH["Schemas (shape contracts, additionalProperties:false)"]
        TAXS["patterns/taxonomy.schema.json"]
        EVSS["patterns/events.schema.json"]
        META["patterns/schema.json<br/>(bp-XXX contract meta-schema)"]
        PLUG["plugins/manifest, _index,<br/>installed-state, bypass_known .schema.json"]
        RUNB["schemas/runbook-agent-manifest.schema.json"]
        RT["schemas/runtime/<br/>classifier-output, adapter-call,<br/>adapter-response, structured-alert"]
        EVT["schemas/events/<br/>event-{pre-tool-use,tool-result,<br/>stop,session-start,session-end}"]
    end

    subgraph GATE["Test-only validity gate (tests/)"]
        LINT["tests/lib/mini-jsonschema.mjs<br/>(2020-12 keyword-grammar linter;<br/>self-asserting SUBSCHEMA_KEYWORDS;<br/>ALLOWLIST=57)"]
        VH["tests/lib/version-hash.mjs"]
        T["tests/test-p0-schemas.mjs = 89/0"]
        FIX["tests/fixtures/plugins/* (>=16 golden)<br/>tests/fixtures/harness-events/claude-code/*"]
    end

    LINT --> T
    VH --> T
    SCH --> T
    FIX --> T
    TAX -. taxonomy_version sha256:7ea41ed8... .-> VH
    EVS -. events_version sha256:13f01e5a... .-> VH
```

## Ships — 20 files (17 schemas + 3 data)

- `patterns/taxonomy.json` *(data)* · `patterns/taxonomy.schema.json`
- `patterns/events.json` *(data)* · `patterns/events.schema.json`
- `patterns/schema.json` *(bp-XXX contract meta-schema)*
- `plugins/manifest.schema.json` · `plugins/_index.schema.json` ·
  `plugins/installed-state.schema.json` · `plugins/bypass_known.schema.json`
- `plugins/bypass_known.json` *(data; pre-populated with Codex `pre_tool_use: { ceiling: "MEDIUM" }`)*
- `schemas/runtime/`: `classifier-output` · `adapter-call` · `adapter-response` ·
  `structured-alert` *(`.schema.json`)*
- `schemas/events/`: `event-pre-tool-use` · `event-tool-result` · `event-stop` ·
  `event-session-start` · `event-session-end` *(`.schema.json`)*
- `schemas/runbook-agent-manifest.schema.json` *(F49)*

Test-only (T17-permitted): `tests/lib/mini-jsonschema.mjs`, `tests/lib/version-hash.mjs`,
`tests/test-p0-schemas.mjs`, `tests/fixtures/plugins/*`, `tests/fixtures/harness-events/claude-code/*`.

## Implementation notes (as shipped)

- **The validity gate is a keyword-grammar linter, not a meta-schema interpreter.**
  Replicating 2020-12 `$dynamicRef`/`$dynamicAnchor` machinery is the wrong patch class. The
  linter (a) allowlists the 2020-12 keyword set and **fails on any unknown keyword**, (b)
  grammar-checks each keyword recursing into every subschema-bearing position, (c) derives
  its recurse-set from a single `SUBSCHEMA_KEYWORDS` table and **self-asserts**
  `keys(SUBSCHEMA_KEYWORDS) ∪ value-grammar-keywords == allowlist` — so a future
  subschema-bearing keyword cannot be added without classifying it. This closes the R0b-R3
  fail-open class (e.g. `{"propertyNames":{"items":[]}}` would otherwise pass).
- **Canonical hashes baked:** `taxonomy_version = sha256:7ea41ed8…`,
  `events_version = sha256:13f01e5a…` (computed over the sorted `labels` array only — editorial
  fields change without invalidating classification behavior).
- Full official-meta-schema validation is owned by **P2**'s `scripts/validate-schemas.mjs`,
  which re-validates these P0 schemas when it lands.

## Done when ✓

All 20 files exist; each schema is a valid JSON-Schema 2020-12 doc (proven by the test-only
linter); the golden-corpus fixtures are staged. Cross-file validation (vocabulary closure,
hash equality, realpath/symlink containment, regex try-compile, adapter-write observation)
runs once the P1/P2/P3 validators land — P0 only **stages** the fixtures that exercise them.

## R0b′ amendment — typed + versioned registry (R8)

After P0 merged, R8 grew two v11.9 clauses (RFC-008 L116 typed-registry, L118
versioned-contract). R0b′ amends the P0 contracts — **schema / fixtures / test only, no
validator** (per-type dispatch + `schema_version` range enforcement remain P1):

- `plugins/_index.schema.json`: closed `$defs.pluginType` enum
  `[enforcement, recall-strategy, store-strategy, learning]`; top-level **required**
  `schema_version` (`$defs.semver` **pattern**, *not* a pinned const — pinning would break
  backward-compat); per-type descriptor `$defs` (`enforcementDescriptor`,
  `recallStrategyDescriptor`) each with a required `type` const. Top-level
  `additionalProperties:false` is **kept** as the static fail-closed for unknown future
  top-level keys. No `store_strategies` / `learning_strategies` slots yet — each is an
  additive-MINOR superset bump when R11/R12 land.
- `plugins/manifest.schema.json`: required `type` const `enforcement` + required
  `schema_version` (the *contract* version; distinct from the plugin's own `version`).
- `_corpus-index.json`: single `current_schema_version` oracle (`1.0.0`).
- `tests/test-p0-schemas.mjs` §7: asserts the schema shapes + a **non-vacuous** Rule-14
  drift guard (every expect-pass instance's `schema_version` byte-equals the oracle; ≥1
  such instance). 89 → 107 checks, 0 fail.

**Versioning semantics (forward-superset):** backward = newer superset schema/validator
reads older same-major registries; forward = a registry whose version exceeds the validator
max (MAJOR **or** MINOR) **fails closed**; top-level closure is the static enforcement (R8-118).

**Deferred to each type's own home** — every not-yet-contracted type must define its (a)
registry sub-schema, (b) descriptor schema, (c) runtime-IO schema, (d) conformance gauntlet
as additive-MINOR bumps ("supported" = schema-validated AND test-covered, CAPABILITIES.md):
`recall-strategy` validator/IO/gauntlet → P9 + RFC-001/007; `store-strategy` → R11 / RFC-007;
`learning` → R12 / RFC-001.

**P1 carry-forwards (from the codex review):** (a) backfill `type` + `schema_version` into
the existing manifest-shaped negative fixtures so each isolates its single failure once the
P1 validator instance-validates them; (b) add a **registry-instance** non-vacuous
`schema_version` assertion once `plugins/_index.json` exists; (c) promote
`CURRENT_SCHEMA_VERSION` to a production constant (validator `MAX_SUPPORTED`) byte-equal'd
against the corpus oracle; (d) bind `cwd: projectRoot` on every P1 subprocess spawn.

Plan reviewed cross-tool (codex, 3 rounds → ACCEPT): request `…044435…2fe8`; replies
`…044705…43a9` (HOLD, 2 findings) → `…045236…7fc8` (ACCEPT-with-FU) → `…045704…a56a` (ACCEPT).

## Follow-up

**Issue [#368](https://github.com/lantisprime/episodic-memory/issues/368)** — P2 must share
ONE negative corpus between the P0 linter (`tests/lib/mini-jsonschema.mjs`) and P2's
`scripts/validate-schemas.mjs` (RFC line 1188; drift guard, Rule 14). Blocked by P2.

## Maps to

R3 (capability mapping contract), R4 (default classifier + plugin override), **R8**
(typed-registry `type` discriminator + versioned-contract `schema_version` — added in the
R0b′ amendment above). Principle anchors: P2, P11.
