# claude-code — enforcement runbook

> RFC-008 enforcement plugin. Manifest: `plugins/claude-code/manifest.json`;
> registry entry: `plugins/_index.json`. This runbook is the human + agent
> contract for how the claude-code enforcement plugin classifies commands and
> gates the agent lifecycle. It is validated structurally by
> `scripts/validate-plugin-registry.mjs` (M7/M7a/M7b in P1b; M7c–M7f content
> derivation in P1c).

## ⚠️ Self-trigger checklist

Before acting under this plugin, confirm each of the following — this is the
fail-closed self-check the agent runs at the moment a gated tool call forms:

- The manifest validates against `plugins/manifest.schema.json` (M2).
- The command classifies to a taxonomy label in `patterns/taxonomy.json` (M5).
- A marker write targets only `<repo>/.checkpoints/.*` canonical paths (§4).
- The non-overridable labels (`marker_write`, `unsafe_complex`) are never remapped (§3).

## §1 — Capability summary

The claude-code plugin declares **STRONG** enforcement on four lifecycle events:
`pre_tool_use`, `stop`, `session_start`, and `session_end`. The harness-agnostic
event → action semantics are the COMMON rows shared by every enforcement plugin
(byte-sourced from `scripts/scaffold-plugin/templates/common-rows.md`, M7a):

<!-- COMMON:BEGIN -->
| Event | STRONG | MEDIUM | WEAK |
|---|---|---|---|
| `pre_tool_use` | block | warn (marker) | inject |
| `tool_result` | modify | observe | unsupported |
| `stop` | refuse_stop | warn | unsupported |
| `session_start` | inject_context | inject_context (best-effort) | inject_static |
| `session_end` | write_artifact | write_artifact (best-effort) | unsupported |
<!-- COMMON:END -->

claude-code does not declare `tool_result` (no result-mutation hook surface).

## §2 — Event tiers (claude-code)

All four declared events are STRONG: the Claude Code hook layer returns a
non-zero exit (exit 2) to block a `pre_tool_use`, re-enters the agent loop to
refuse a `stop`, deterministically injects context at `session_start`, and
writes final-state artifacts at `session_end`. There is no MEDIUM/WEAK
degradation for claude-code — the hook substrate fires deterministically.

## §3 — Classifier mode & emitted labels

Mode is `default`: the plugin emits the full canonical taxonomy vocabulary and
performs no override remapping. The seven labels are `read_only`,
`nonsrc_write`, `shared_write`, `push_or_pr_create`, `marker_write`,
`unsafe_complex`, and `unknown`. The two non-overridable labels — `marker_write`
and `unsafe_complex` — are safety/deadlock-critical and may never be remapped by
an override classifier (M5a).

## §4 — Marker substrate & canonical paths

All gate-control markers are written under `<repo>/.checkpoints/.*` only:
`.plan-approval-pending.<sid>`, `.plan-approved.<sid>`, `.pre-checkpoint-done.<sid>`,
`.post-checkpoint-done.<sid>`. Reads also honor the legacy `<repo>/.claude/.*`
location during burn-in. A `marker_write` is the deadlock escape hatch and is
classified non-overridable.

## §5 — Gate lifecycle

The plan-approval → pre-checkpoint → post-checkpoint → push lifecycle is
anchored on per-session marker tokens. `plan-marker.mjs --approve` creates the
approval token that the pre-checkpoint arm transactionally consumes; the push
gate self-arms and blocks an unverified push. The COMMON event-tier table in §1
defines what each event does at each enforcement tier.

## §6 — Deadlock classes & escapes

Deadlock class 1 (marker write misclassified as `shared_write`) is prevented by
the non-overridable `marker_write` label. Deadlock class 2 (unsafe command
unparsed) is prevented by the non-overridable `unsafe_complex` fail-closed.
Every marker mutation is an escape hatch that must classify to `marker_write`.

## §7 — Resolution matrix

Auto-derived from `manifest.capabilities` × `patterns/taxonomy.json` × the R3
`effective_tier` ternary. M7c regenerates the two tables below and byte-diffs the
embedded markdown; drift = fail (same enforcement boundary as the §1 COMMON rows).

<!-- RESOLUTION:BEGIN -->
**Table A — Per-event capability declaration.**

| `pre_tool_use` | `tool_result` | `stop` | `session_start` | `session_end` |
|---|---|---|---|---|
| STRONG | — | STRONG | STRONG | STRONG |

**Table B — Resolved gate × label action grid** (cell = taxonomy policy degraded by `effective_tier`).

| Label | plan_approval | pre_checkpoint | post_checkpoint | stop |
|---|---|---|---|---|
| `read_only` | allow | allow | allow | refuse_stop |
| `nonsrc_write` | block | allow | allow | refuse_stop |
| `shared_write` | block | block | allow | refuse_stop |
| `push_or_pr_create` | block | allow | block | refuse_stop |
| `marker_write` † | allow | allow | allow | refuse_stop |
| `unsafe_complex` † | block | block | block | refuse_stop |
| `unknown` | block | block | block | refuse_stop |

`†` non-overridable label — cells immutable regardless of plugin (`taxonomy.non_overridable`).
`stop` is label-independent: `effective_tier(stop) = min(harness_cap.stop, …)` reads marker state, not the command label (F10).
<!-- RESOLUTION:END -->

## §8 — Invocation modality

**Invocation modality:** agent

The classifier is dispatched via the in-process Claude Code hook API
(PreToolUse / Stop / SessionStart / SessionEnd). M7d asserts this line
byte-equals `manifest.invocation_modality`.

## §9 — Agent manifest

A harness agent reads the machine-parseable block below — sentinel
`## 🤖 Agent invocation manifest` (column 1) followed by one fenced JSON block —
and learns how to invoke the plugin without a `--help` round-trip. M7e parses it,
schema-validates against `schemas/runbook-agent-manifest.schema.json`, and
cross-checks `invocation_modality` against §8 and the manifest.

## 🤖 Agent invocation manifest

```json
{
  "invocation_modality": "agent",
  "command_shapes": [
    ["bash", "{plugin_dir}/hooks/checkpoint-gate.sh"]
  ],
  "required_args": [],
  "optional_args": [],
  "expected_outputs": { "shape": "exit-code-only" },
  "env_requirements": [
    { "name": "CLAUDE_CODE_SESSION_ID", "required": true }
  ],
  "return_codes": {
    "0": "allow — the tool call / stop proceeds",
    "2": "block — pre_tool_use refused or stop refused (STRONG)"
  },
  "dispatch_examples": [
    {
      "description": "pre_tool_use read_only command resolves to allow (exit 0)",
      "argv": ["bash", "{plugin_dir}/hooks/checkpoint-gate.sh"]
    }
  ]
}
```

## §10 — Config / taxonomy cross-binding

Auto-derived from `manifest.json` (the per-project `enforce-config.json` schema
lands in P4 — until then M7f 10a is present-and-parses only). M7f byte-diffs the
block below against the derived source-of-truth.

<!-- CONFIG:BEGIN -->
**10a — Configuration.**

- `enforce_config_keys`: none yet — the per-project `enforce-config.json` schema lands in P4; M7f 10a is present-and-parses until then.
- `install_time_config`: hooks deployed under `~/.claude/hooks/` by `install.mjs --install-hooks`.

**10b — Taxonomies.**

- `taxonomy_ref`: `patterns/taxonomy.json`
- `taxonomy_version`: `sha256:7ea41ed82edef968baee6880f040008080afd962fec9120336ee336796013cc4`
- `emits_labels`: `read_only`, `nonsrc_write`, `shared_write`, `push_or_pr_create`, `marker_write`, `unsafe_complex`, `unknown`
- `consumes_events`: `pre_tool_use`, `stop`, `session_start`, `session_end`
- `event_translations_summary`:
  - `pre_tool_use`: `claude-code-pre-tool-use-stdin-json`
  - `stop`: `claude-code-stop-stdin-json`
  - `session_start`: `claude-code-session-start-stdin-json`
  - `session_end`: `claude-code-session-end-stdin-json`
<!-- CONFIG:END -->
