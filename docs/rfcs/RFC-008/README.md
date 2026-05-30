# RFC-008 — per-phase architecture + implementation plans

This directory holds the **per-phase detail** for [RFC-008 — Decoupling the Enforcement
Layer from the Memory Substrate](../RFC-008-decouple-enforcement-from-substrate.md). The
RFC body keeps the at-a-glance summary table, the Phase-to-P crosswalk, the requirement
traceability matrix, and the live implementation ledger. Each phase's **architecture
diagram, file manifest, build steps, hazards, and done-when boundary** live here, one file
per phase, so the RFC body stays navigable.

Every design element still maps to a requirement (R1–R12); no element exists without a
requirement parent. Each phase file carries its own R-anchors and back-links to the RFC.

## Phases

| Phase | File | Serves | Depends on | Status |
|-------|------|--------|-----------|--------|
| **P0** | [P0-schema-contracts.md](P0-schema-contracts.md) | R3, R4 | — | **DONE** — PR #367 (`d078fdc`) |
| **P1** | [P1-plugin-registry.md](P1-plugin-registry.md) | R1, R6, R8 | P0 | **NEXT** |
| **P2** | [P2-bp-contracts.md](P2-bp-contracts.md) | R2, R3, R4 | P0 | queued |
| **P3** | [P3-thin-waist.md](P3-thin-waist.md) | R1, R2, R3, R4, R5, R9 | P0, P2 | queued |
| **P4** | [P4-enforce-config.md](P4-enforce-config.md) | R3, R5 | P3 | queued |
| **P5–P7** | [P5-P7-tool-plugins.md](P5-P7-tool-plugins.md) | R6, R10 | P3 | queued |
| **P8** | [P8-cursor-windsurf.md](P8-cursor-windsurf.md) | R6, R10 | P3 | queued |
| **P9** | [P9-recall-strategies.md](P9-recall-strategies.md) | R7 | — | **DEFERRED** — own RFC |

## Non-phase items

- **Bug fix (any time):** `plan-gate.sh:108–115` ordering — F14 early-exit blocks the
  `marker_write` escape hatch (deadlock class 2, R4). See the RFC
  [Deadlock analysis](../RFC-008-decouple-enforcement-from-substrate.md#deadlock-analysis-maps-to-taxonomy-r3-r4-r9).
- **Follow-up (post-P1):** migrate `hooks/runbooks/` → `plugins/second-opinion/runbooks/`
  (R10). Tracked in [P1-plugin-registry.md](P1-plugin-registry.md#the-runbooks-fork).

## Build order

```
P0 ─┬─> P2 ─> P3 ─┬─> P4
P1 ─┘             ├─> P5 / P6 / P7
                  └─> P8
P9 — carved to its own RFC (no deps in this RFC)
```

Canonical ordering is **P0 → P9**. The older "Phase 1–9" prose labels are retired; the
crosswalk in the RFC body maps legacy labels to P-numbers.
