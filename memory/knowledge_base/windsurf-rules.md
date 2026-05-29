---
name: windsurf-rules
metadata:
  node_type: memory
  url: https://docs.windsurf.com/windsurf/cascade/memories
  fetched: 2026-05-28
  summary: "Windsurf exposes NO programmatic event hooks. Only file-based customization (Rules .md with frontmatter activation modes, Memories auto-context, AGENTS.md, Workflows, Skills). Confirms WEAK tier per RFC-008 §Capability-degradable enforcement."
  originSessionId: 020a9125-8340-41d2-84ee-49d0f493e71a
---

# Windsurf rules / memories — 2026-05-28 snapshot

> Committed into the repo for RFC-008 F43/F59 auditability. Source of truth for the Windsurf WEAK-tier confirmation in `docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` §Capability-degradable enforcement.

## RFC-008 conclusion

Windsurf is WEAK across all events. The 2026-05-28 docs confirm: no programmatic hooks, no PreToolUse / Stop / SessionStart / SessionEnd / ToolResult equivalents, no way to BLOCK a tool call or inject dynamic per-session context via executable code.

## What Windsurf DOES expose

| Surface | Mechanism | Maps to RFC-008 event | Tier | Action semantics |
|---|---|---|---|---|
| **Rules** | Markdown files with frontmatter (`always_on`, `model_decision`, `glob`, `manual` activation modes) | `session_start` only | **WEAK** | `inject_static` (rules deployed at install; presence verifiable via file existence; no per-session dynamic content) |
| **Memories** | Auto-generated context stored locally | (no map; substrate-internal) | — | Cursor-internal Cascade behavior; not a plugin surface |
| **AGENTS.md** | Directory-scoped rule files | `session_start` (subset of Rules) | WEAK | Same `inject_static` semantics |
| **Workflows** | Task templates | (no map; user-invoked) | — | Not an event-based surface |
| **Skills** | Multi-step procedures | (no map; user-invoked) | — | Not an event-based surface |

## Capability matrix for Windsurf

| Event | Tier | Mechanism | Action semantics |
|---|---|---|---|
| `pre_tool_use` | **N/A** | none | unsupported |
| `tool_result` | **N/A** | none | unsupported |
| `stop` | **N/A** | none | unsupported |
| `session_start` | **WEAK** | Rules .md / AGENTS.md | `inject_static` (deploy file at install; Cascade reads it per activation mode) |
| `session_end` | **N/A** | none | unsupported |

## OQ-3 implication (RFC-008)

Windsurf needs a `plugins/windsurf/` directory, but its adapter scope is much smaller than Cursor's. Only `session_start` event is supported, only at WEAK tier with `inject_static` action. The plugin ships:
- `manifest.json` declaring `capabilities.session_start: WEAK`
- `event_translations.session_start: { source_format: "windsurf-rules-deploy", field_bindings: { … } }`
- `installer/` deploys an `.windsurf/rules/episodic-memory-enforcement.md` file at install time
- `runbooks/enforcement.md` (still required per R10) explaining the WEAK-tier limitations and what enforcement the user gives up by choosing Windsurf

NO `capabilities/enforcement.{mjs,ts,py}` runtime adapter needed for Windsurf — there are no events to intercept. The "plugin" is essentially an installer + a static rules file + a runbook.

## What's NOT yet researched (open follow-ups before P8 Windsurf plugin lands)

- The actual rule-file frontmatter spec (full `activation_mode` enum, glob syntax)
- Whether Cascade respects multiple rule files or only one (precedence rules)
- How Windsurf-Wave or other newer products diverge from base Windsurf (capability deltas)
- Whether `.windsurfrules` (legacy?) still works alongside `.windsurf/rules/`
