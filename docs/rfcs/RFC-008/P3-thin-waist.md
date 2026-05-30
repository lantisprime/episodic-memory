# P3 — Thin waist + classifier runtime-sourcing + em-recall purification

> Part of [RFC-008](../RFC-008-decouple-enforcement-from-substrate.md). Index:
> [RFC-008/README.md](README.md).

**Status:** queued.
**Serves:** R1, R2, R3, R4, R5, R9 (+ F38).
**Depends on:** P0 (met), P2.
**Estimate:** ~55K (the load-bearing phase).

## What P3 is

P3 is the **real decoupling**: it introduces `enforce-contract.mjs` (the thin waist that
owns the block/allow/warn/inject decision), gives the enforcement layer its own marker-state
reader, and — the negative-LOC payoff — **strips all gate logic out of `em-recall.mjs`**,
restoring the substrate to pure recall. After P3, `em-recall.mjs` is never on the
enforcement path.

## Architecture

```mermaid
graph TB
    subgraph CONTRACT["Contract (P0 + P2)"]
        BP["patterns/bp-XXX.json"]
        TAX["patterns/taxonomy.json"]
        EVS["patterns/events.json"]
        IDX["plugins/_index.json"]
    end

    subgraph WAIST["P3 - enforcement thin waist (NEW)"]
        EC["scripts/enforce-contract.mjs<br/>- validates contracts<br/>- effective_tier = min(harness, contract, config) (R3)<br/>- R9 impl-boundary (lazy-arm on first repo write)<br/>- classifier dispatch (R4/R5)<br/>- out-of-vocab -> HARD-REJECT + structured alert (F3)"]
        MS["scripts/lib/marker-state.mjs<br/>(marker reads - owned by enforcement)"]
        CC["command-classifier.sh<br/>(refactored: source 7 labels from<br/>taxonomy.json at runtime, OQ-2)"]
    end

    subgraph SUBSTRATE["Substrate - PURIFIED (F38/F60)"]
        ER["em-recall.mjs<br/>DROP --gate flag + handler<br/>DROP stop-gate-helpers.mjs import<br/>DROP all marker reads<br/>DROP .checkpoints/ migration<br/>= pure recall"]
        ES["em-store.mjs / em-search.mjs<br/>(zero gate-vocabulary tokens)"]
    end

    BP --> EC
    TAX --> EC
    TAX -. runtime label source .-> CC
    EVS --> EC
    IDX -->|plugin lookup R8| EC
    EC --> MS
    EC --> CC
    EC -. structured alert via em-store .-> ES
    EC -. NEVER calls .-> ER
```

## Ships

- `scripts/enforce-contract.mjs` — the thin waist. Validates contracts; computes the ternary
  `min()` effective tier (R3); R9 implementation-boundary detection (lazy-arm on first
  repo-source write, silent during exploration/planning); classifier dispatch (R4/R5); reads
  gate action from taxonomy + per-tier semantics from `events.json`; reads marker state via
  `marker-state.mjs`. **Two invocation modes** — in-process import for STRONG harnesses + CLI
  spawn for degrade. Out-of-vocab labels HARD-REJECTED with a structured alert via `em-store`
  (F3).
- `scripts/lib/marker-state.mjs` — marker reads, owned by the enforcement layer.
- **Classifier runtime-sourcing** (legacy "Phase 4", folded here): refactor
  `command-classifier.sh` to source the 7-label set from `taxonomy.json` at runtime (OQ-2
  closed); plugin classifier-override interface; override registration in `_index.json`;
  non-overridable labels enforced at scaffold + CI + runtime.
- **em-recall purification — STRICT DELETION (F38, F60):** remove from `em-recall.mjs` the
  `--gate` flag + handler, the `stop-gate-helpers.mjs` import, all marker reads, and the
  `.checkpoints/` migration code. *Net diff is negative LOC.*
- `install.mjs` deploys `lib/marker-state.mjs` + verifies em-recall is v11-purified (F45);
  `tests/test-install-em-recall-purified.mjs`.

## Done when ✓

`enforce-contract.mjs` passes contract validation + the **full 9-step gauntlet** against the
P1 plugins (this is where gauntlet steps 5/6 finally run); `em-recall.mjs` (and
`em-store.mjs` / `em-search.mjs`) contain **zero gate-vocabulary tokens** (F60 CI grep guard
green); the install-purification sentinel test passes.

## Maps to

R1, R2, R3, R4, R5, R9. Principle anchors: P4, P6.
