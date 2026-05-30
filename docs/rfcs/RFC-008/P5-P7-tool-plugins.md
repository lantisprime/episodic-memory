# P5–P7 — Per-tool plugins (OpenCode · Codex · Pi Agent)

> Part of [RFC-008](../RFC-008-decouple-enforcement-from-substrate.md). Index:
> [RFC-008/README.md](README.md).

**Status:** queued. *(Legacy "Phase 6 / 7 / 8".)*
**Serves:** R6 (plugin-to-harness binding), R10 (enforcement runbooks).
**Depends on:** P3.
**Estimate:** P5 ~45K · P6 ~40K · P7 ~35K.

> These three phases are grouped here because they are the **same template instantiated
> three times** — each is a plugin directory built from the P1 scaffold + gauntlet at its
> own declared capability tiers. If a phase grows enough bespoke detail to warrant its own
> file, split it out then.

## What P5–P7 are

Each phase ships one harness plugin: `manifest.json` +
`capabilities/enforcement.{mjs,ts,py}` adapter + `runbooks/enforcement.md` (the 10 required
sections, R10) + harness-event fixtures. The universal `test-plugin.mjs` gauntlet (P1) is
the quality bar — no bespoke per-plugin test scripts.

## Architecture (shared shape)

```mermaid
graph TB
    subgraph PLUGIN["plugins/[harness]/ (one per phase)"]
        MAN["manifest.json<br/>(invocation_modality, capabilities tiers,<br/>taxonomy_version, emits_labels)"]
        ADP["capabilities/enforcement.{ts,py,mjs}<br/>(adapter: raw harness event to canonical payload)"]
        RB["runbooks/enforcement.md<br/>(S1-S10, COMMON + harness-specific + auto-gen)"]
        FX["harness-event fixtures"]
    end

    EC["enforce-contract.mjs (P3 thin waist)"]
    IDX["plugins/_index.json (registry)"]
    TP["test-plugin.mjs (9-step gauntlet)"]

    ADP -->|canonical payload| EC
    MAN -->|register| IDX
    TP -. validates all 9 steps .-> PLUGIN
```

## Ships (per phase)

| Phase | Dir | Language | Declared capabilities |
|-------|-----|----------|-----------------------|
| **P5** | `plugins/opencode/` | TypeScript | `pre_tool_use: STRONG, tool_result: STRONG, session_start: MEDIUM, stop: MEDIUM` |
| **P6** | `plugins/codex/` | Python hooks | `pre_tool_use: MEDIUM` *(multi-edit bypass documented)*, `stop: STRONG, session_start: STRONG` |
| **P7** | `plugins/pi-agent/` | `tool_call` + `session_shutdown`/`turn_end` | `pre_tool_use: STRONG, stop: MEDIUM, session_start: STRONG` |

**Honesty note (P5 principle):** Codex `pre_tool_use` is declared **MEDIUM**, not STRONG —
its PreToolUse has a known multi-edit bypass. Push-gate + stop-gate are the hard enforcement
for Codex.

## Done when ✓

Each plugin passes the `test-plugin.mjs` 9-step gauntlet at its declared tiers.

## Maps to

R6, R10. Principle anchors: P9, P11 (binding); P4 (runbooks).
