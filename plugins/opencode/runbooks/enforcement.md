# opencode — enforcement runbook

> RFC-008 enforcement plugin. Manifest: `plugins/opencode/manifest.json`;
> registry entry: `plugins/_index.json`. This runbook is the human + agent
> contract for how the opencode enforcement plugin classifies commands and
> gates the agent lifecycle. It is validated structurally by
> `scripts/validate-plugin-registry.mjs` (M7/M7a/M7b in P1b; M7c–M7f content
> derivation in P1c).

## ⚠️ Self-trigger checklist

Before acting under this plugin, confirm each of the following — this is the
fail-closed self-check the agent runs at the moment a gated tool call forms:

- The manifest validates against `plugins/manifest.schema.json` (M2).
- The command classifies to a taxonomy label in `patterns/taxonomy.json` (M5).
- The non-overridable labels (`marker_write`, `unsafe_complex`) are never remapped (§3).

## §1 — Capability summary

The opencode plugin declares **STRONG** enforcement on `pre_tool_use` and
**MEDIUM** (observe) on `tool_result`, `session_start`, and `stop`. The
harness-agnostic event → action semantics are the COMMON rows shared by every
enforcement plugin (byte-sourced from `scripts/scaffold-plugin/templates/common-rows.md`, M7a):

<!-- COMMON:BEGIN -->
| Event | STRONG | MEDIUM | WEAK |
|---|---|---|---|
| `pre_tool_use` | block | warn (marker) | inject |
| `tool_result` | modify | observe | unsupported |
| `stop` | refuse_stop | warn | unsupported |
| `session_start` | inject_context | inject_context (best-effort) | inject_static |
| `session_end` | write_artifact | write_artifact (best-effort) | unsupported |
<!-- COMMON:END -->

opencode declares `tool_result` at MEDIUM (observe) because `tool.execute.after`
returns void — no result-mutation contract exists. The `pre_tool_use` hook
(`tool.execute.before`) is STRONG: the adapter throws to block the call.

## §2 — Event tiers (opencode)

`pre_tool_use` is STRONG: the TypeScript adapter throws from `tool.execute.before`
to refuse a gated write, and OpenCode surfaces this as a tool refusal to the user.
`tool_result`, `session_start`, and `stop` are MEDIUM (observe): the adapter
logs/records these events but does not block or modify the response.

## §3 — Classifier mode & emitted labels

Mode is `default`: the plugin emits the full canonical taxonomy vocabulary and
performs no override remapping. The seven labels are `read_only`,
`nonsrc_write`, `shared_write`, `push_or_pr_create`, `marker_write`,
`unsafe_complex`, and `unknown`. The two non-overridable labels — `marker_write`
and `unsafe_complex` — are safety/deadlock-critical and may never be remapped by
an override classifier (M5a).

## §4 — Repo-source gate scope

The opencode plugin gates ONLY repo-source writes (R1-R3). Carve-outs are defined
in `patterns/repo-source-carveouts.json` (Rule 14 single source, shared with
`plugins/claude-code/hooks/lib/repo-source.sh` via `scripts/lib/repo-source.mjs`).
Non-repo writes, episode store writes, and git-ignored paths are always allowed.

## §5 — Gate lifecycle

The gate decision is a two-layer AND:
1. `toolTargetsRepoSource(repoRoot, tool, path, label)` from `scripts/lib/repo-source.mjs` — returns `"GATED"` or `"ALLOW"`.
2. `gateDisposition({...})` from `scripts/enforce-contract.mjs` — returns a disposition with `token ∈ {enforce, block, allow}`.

Only when BOTH layers return block/enforce AND the write is repo-source does the
adapter throw. The COMMON event-tier table in §1 defines what each event does at
each enforcement tier.

## §6 — Bridge protocol

The `plugins/opencode/capabilities/enforce-bridge.mjs` node bridge reads a JSON
envelope from stdin (`{harness, event, normalized}`) and writes a decision JSON
object to stdout (`{action, effective_tier, reason, label}`). The TypeScript
adapter (`enforcement.ts`) spawns the bridge via `node`, captures stdout, and acts
on the `action` field. Bridge exit codes: 0 = ok, 2 = invalid input (schema
error), 3 = engine error (threw during decision). Any non-zero exit or malformed
JSON from the bridge causes the adapter to throw fail-closed.

## §7 — Resolution matrix

Auto-derived from `manifest.capabilities` × `patterns/taxonomy.json` × the R3
`effective_tier` ternary. M7c regenerates the two tables below and byte-diffs the
embedded markdown; drift = fail (same enforcement boundary as the §1 COMMON rows).

<!-- RESOLUTION:BEGIN -->
**Table A — Per-event capability declaration.**

| `pre_tool_use` | `tool_result` | `stop` | `session_start` | `session_end` |
|---|---|---|---|---|
| STRONG | MEDIUM | MEDIUM | MEDIUM | — |

**Table B — Resolved gate × label action grid** (cell = taxonomy policy degraded by `effective_tier`).

| Label | plan_approval | pre_checkpoint | post_checkpoint | stop |
|---|---|---|---|---|
| `read_only` | allow | allow | allow | warn |
| `nonsrc_write` | block | allow | allow | warn |
| `shared_write` | block | block | allow | warn |
| `push_or_pr_create` | block | allow | block | warn |
| `marker_write` † | allow | allow | allow | warn |
| `unsafe_complex` † | block | block | block | warn |
| `unknown` | block | block | block | warn |

`†` non-overridable label — cells immutable regardless of plugin (`taxonomy.non_overridable`).
`stop` is label-independent: `effective_tier(stop) = min(harness_cap.stop, …)` reads marker state, not the command label (F10).
<!-- RESOLUTION:END -->

## §8 — Invocation modality

**Invocation modality:** agent

The TypeScript adapter is registered as an OpenCode plugin
(`plugins/opencode/capabilities/enforcement.ts`). OpenCode loads it via
`plugin` config in the project's `opencode.json`. The adapter spawns the
node bridge (`enforce-bridge.mjs`) as a subprocess for each `tool.execute.before`
event. M7d asserts this line byte-equals `manifest.invocation_modality`.

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
    ["node", "{plugin_dir}/capabilities/enforce-bridge.mjs"]
  ],
  "required_args": [],
  "optional_args": [],
  "expected_outputs": { "shape": "json-object" },
  "env_requirements": [],
  "return_codes": {
    "0": "ok — decision emitted to stdout",
    "2": "invalid — malformed input (schema error)",
    "3": "engine-error — threw during decision"
  },
  "dispatch_examples": [
    {
      "description": "pre_tool_use repo-source write resolves to block (exit 0, action:block in stdout)",
      "argv": ["node", "{plugin_dir}/capabilities/enforce-bridge.mjs"]
    }
  ]
}
```

## §10 — Config / taxonomy cross-binding

Auto-derived from `manifest.json` + the per-project `enforce-config.json` schema
(`patterns/enforce-config.schema.json`). M7f byte-diffs the block below against the
derived source-of-truth.

<!-- CONFIG:BEGIN -->
**10a — Configuration.**

- `enforce_config_keys`: `active` (R5 project switch) + `bp-001.{plan_approval,post_checkpoint,pre_checkpoint,stop}` per-bp tier clamps (RFC-008 P4; schema `patterns/enforce-config.schema.json`; clamp-DOWN only; resolved by `enforce-contract --gate stop` / `--resolve-gate <gate>`).
- `install_time_config`: hooks deployed under `~/.claude/hooks/` by `install.mjs --install-hooks`.

**10b — Taxonomies.**

- `taxonomy_ref`: `patterns/taxonomy.json`
- `taxonomy_version`: `sha256:7ea41ed82edef968baee6880f040008080afd962fec9120336ee336796013cc4`
- `emits_labels`: `read_only`, `nonsrc_write`, `shared_write`, `push_or_pr_create`, `marker_write`, `unsafe_complex`, `unknown`
- `consumes_events`: `pre_tool_use`, `tool_result`, `session_start`, `stop`
- `event_translations_summary`:
  - `pre_tool_use`: `opencode-tool-execute-before-normalized`
  - `tool_result`: `opencode-tool-execute-after-normalized`
  - `session_start`: `opencode-system-transform-normalized`
  - `stop`: `opencode-session-idle-normalized`
<!-- CONFIG:END -->
