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

*Derived content (Table A/B) authored in P1c (F5 split, M7c).* The resolution
matrix maps `{capability tier} × {taxonomy label gate}` to the effective action
via the R3 ternary; P1b validates only that this section header is present.

## §8 — Invocation modality

`invocation_modality` is `agent`: the classifier is dispatched as an in-repo
agent/subprocess. *Byte-equality of this line to the manifest field is M7d (P1c).*

## §9 — Agent manifest

*Agent-manifest sentinel + fenced JSON (validated vs
`schemas/runbook-agent-manifest.schema.json`) authored in P1c (M7e).* P1b
validates only that this section header is present, not its content.

## §10 — Config / taxonomy cross-binding

*Config/taxonomy cross-binding values (taxonomy_ref, taxonomy_version,
emits_labels, consumes_events) byte-equal their derived source-of-truth — M7f,
authored in P1c.* P1b validates only that this section header is present.
