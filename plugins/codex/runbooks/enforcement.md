# codex — enforcement runbook

> RFC-008 P6 enforcement plugin. Manifest: `plugins/codex/manifest.json`;
> registry entry: `plugins/_index.json`. This runbook is the human + agent
> contract for how the Codex enforcement plugin classifies commands and gates
> repo-source writes via a project-local Codex `PreToolUse` command hook. It is
> validated structurally by `scripts/validate-plugin-registry.mjs` (M7/M7a +
> M7c–M7f content derivation).

## ⚠️ Self-trigger checklist

Before acting under this plugin, confirm each of the following — this is the
fail-closed self-check the agent runs at the moment a gated tool call forms:

- The manifest validates against `plugins/manifest.schema.json` (M2).
- The command classifies to a taxonomy label in `patterns/taxonomy.json` (M5).
- The non-overridable labels (`marker_write`, `unsafe_complex`) are never remapped (§3).

## §1 — Capability summary

The codex plugin **declares** `pre_tool_use` at **MEDIUM** (honest tier ceiling).
The harness-agnostic event → action semantics are the COMMON rows shared by every
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

The declared tier is **MEDIUM** because the delivered capability includes Bash,
whose write-target lexing has a known statically-unlexable residual (§3, §16 R8):
`eval`, `$VAR`-expanded paths, command-substitution, `sh -c '… > src/x'`, and
similar forms escape the frozen extractor and are ALLOWED. The empirical probe
(KB `memory/knowledge_base/codex-hooks.md`) confirmed the Codex hook **mechanism**
is STRONG — it hard-blocks every form the hook denies — but the honest delivered
tier is MEDIUM (mechanism STRONG, extractor residual MEDIUM).

## §2 — Event tiers (codex)

`pre_tool_use` is the only event this plugin handles. It is **declared MEDIUM**
in the manifest/registry/`bypass_known` (the honest residual ceiling), but the
adapter passes a **runtime mechanism cap of `STRONG`** to `gateDisposition` for
covered repo-source writes (RFC-008 P6 §8.2/§19.4 tier/cap split): the manifest
MEDIUM would otherwise map to `warn` (`events.json` `pre_tool_use@MEDIUM` →
clamp-off → no block), so a covered write would not be enforced. With the runtime
STRONG cap, a covered repo-source write is hard-blocked (Codex hook exits 2 with
a `permissionDecision:"deny"` payload). Unlexable Bash forms are not extracted →
ALLOWED (the declared MEDIUM residual). All other Codex events are out of scope
for P6.

## §3 — Classifier mode & emitted labels

Mode is `override`: the Codex plugin ships its own harness-native classifier
(`codex-adapter.mjs`, declared via `classifier.override_path`) that maps Codex
tool calls to a subset of the canonical taxonomy — `read_only`, `shared_write`,
and `push_or_pr_create` — and treats any unrecognized tool as `shared_write`. The
label is telemetry / deny-reason only; it does NOT gate (gating is per-path
`isRepoSource`, §5). The two non-overridable labels — `marker_write` and
`unsafe_complex` — are safety/deadlock-critical: they are DECLARED in the
manifest `emits_labels` vocabulary (required by M5a) so the substrate keeps
routing them and no override classifier can remap or drop them. `classifyLabel`
does not itself emit `marker_write` or `unsafe_complex` yet — marker writes under
`.checkpoints/` are handled by the repo-source carve-out (§4), not by label
routing — so the declaration is a static safety floor, not a claim of runtime
emission (same pattern as the opencode plugin).

## §4 — Repo-source gate scope

The codex plugin gates ONLY repo-source writes (R1-R3). Carve-outs are defined in
`patterns/repo-source-carveouts.json` (Rule 14 single source, shared via
`scripts/lib/repo-source.mjs`). Non-repo writes (e.g. `/tmp`, `/dev/null`), the
episode store, plan files under `docs/plans/`, marker writes under `.checkpoints/`,
and git-ignored paths are always allowed. Every extracted target — including
relative paths — is normalized via `path.resolve(stdinCwd, target)` against the
hook's `cwd` BEFORE the repo-source check, so a divergent adapter process cwd
cannot resolve `src/x.mjs` to the wrong root (codex r7 F1).

## §5 — Gate lifecycle

The gate decision is a two-layer AND on the resolved write target(s):
1. `isRepoSource(root, p).isRepoSource` from `scripts/lib/repo-source.mjs` — called
   DIRECTLY per normalized path (NOT `toolTargetsRepoSource(...,"Bash",...,label)`,
   whose label branch short-circuits `read_only`/`nonsrc_write` to ALLOW before the
   path check — codex r7 F1).
2. `gateDisposition({...})` from `scripts/enforce-contract.mjs` — with
   `harnessCap:"STRONG"` (runtime mechanism cap, §2), returns a token; the adapter
   blocks on `enforce`/`block`.

Only when a path is repo-source AND the disposition is `enforce`/`block` does the
adapter deny (exit 2). `apply_patch` with an unparseable/empty patch denies
unconditionally (fail-closed State C). No extractable repo-source target (e.g.
`git commit`, `mkdir`, an unlexable Bash form) allows (State D), so normal use is
never bricked.

**Operator clamp (cross-harness note).** The adapter resolves the per-gate
operator clamp `configTier` from `enforce-config.json` key
`bp-001.pre_checkpoint`. The single Codex `PreToolUse` hook models the
**pre-implementation checkpoint** gate (block repo-source writes), so it clamps on
the same key the native bash `checkpoint-gate.sh` uses for that gate. Unlike the
Claude bash layer — which resolves `plan_approval`, `pre_checkpoint`, and
`post_checkpoint` as three distinct `pre_tool_use` gate moments — the stateless
single Codex hook does NOT separately model `plan_approval` or `post_checkpoint`;
setting `bp-001.pre_checkpoint` clamps every covered Codex repo-source write.
(opencode leaves `configTier` null — no per-gate clamp; codex honors the
pre_checkpoint clamp.)

## §6 — Hook protocol

`plugins/codex/capabilities/codex-adapter.mjs` is a Codex `type:"command"`
`PreToolUse` hook (NOT an in-process bridge). It reads the Codex PreToolUse stdin
JSON (`{hook_event_name, tool_name, tool_input, cwd, session_id, ...}`) and:
- emits a deny JSON object to stdout
  (`{hookSpecificOutput:{hookEventName,permissionDecision:"deny",permissionDecisionReason}}`)
  and exits **2** to BLOCK;
- exits **0** with no output to ALLOW.

It fail-closes (deny + exit 2) on: unparseable stdin, non-object stdin, missing
`hook_event_name`, non-absolute `cwd`, an unparseable `apply_patch`, or any
internal throw — including a thin-waist import failure (the waist is imported
DYNAMICALLY inside the top-level try, so a missing module denies rather than
exiting 1). A non-`PreToolUse` event exits 0 (pass-through).

## §7 — Resolution matrix

Auto-derived from `manifest.capabilities` × `patterns/taxonomy.json` × the R3
`effective_tier` ternary (this reflects the DECLARED MEDIUM tier; the runtime
STRONG mechanism cap of §2/§5 is the enforcement override). M7c regenerates the
two tables below and byte-diffs the embedded markdown; drift = fail.

<!-- RESOLUTION:BEGIN -->
**Table A — Per-event capability declaration.**

| `pre_tool_use` | `tool_result` | `stop` | `session_start` | `session_end` |
|---|---|---|---|---|
| MEDIUM | — | — | — | — |

**Table B — Resolved gate × label action grid** (cell = taxonomy policy degraded by `effective_tier`).

| Label | plan_approval | pre_checkpoint | post_checkpoint | stop |
|---|---|---|---|---|
| `read_only` | allow | allow | allow | — |
| `shared_write` | warn | warn | allow | — |
| `push_or_pr_create` | warn | allow | warn | — |
| `marker_write` † | allow | allow | allow | — |
| `unsafe_complex` † | warn | warn | warn | — |

`†` non-overridable label — cells immutable regardless of plugin (`taxonomy.non_overridable`).
`stop` is label-independent: `effective_tier(stop) = min(harness_cap.stop, …)` reads marker state, not the command label (F10).
<!-- RESOLUTION:END -->

## §8 — Invocation modality

**Invocation modality:** cli

The adapter is a Codex command hook registered in a project-local
`.codex/hooks.json` (or `config.toml`) `PreToolUse` entry as
`node {plugin_dir}/capabilities/codex-adapter.mjs`. Codex spawns it per gated tool
call, passing the event JSON on stdin. M7d asserts this line byte-equals
`manifest.invocation_modality`.

## §9 — Agent manifest

A harness agent reads the machine-parseable block below — sentinel
`## 🤖 Agent invocation manifest` (column 1) followed by one fenced JSON block —
and learns how to invoke the plugin without a `--help` round-trip. M7e parses it,
schema-validates against `schemas/runbook-agent-manifest.schema.json`, and
cross-checks `invocation_modality` against §8 and the manifest.

## 🤖 Agent invocation manifest

```json
{
  "invocation_modality": "cli",
  "command_shapes": [
    ["node", "{plugin_dir}/capabilities/codex-adapter.mjs"]
  ],
  "required_args": [],
  "optional_args": [],
  "expected_outputs": { "shape": "codex-native" },
  "env_requirements": [],
  "return_codes": {
    "0": "allow — no output (or non-PreToolUse pass-through)",
    "2": "deny — repo-source write blocked, or fail-closed (parse/import/throw)"
  },
  "dispatch_examples": [
    {
      "description": "pre_tool_use repo-source write → deny (exit 2 + permissionDecision:deny on stdout)",
      "argv": ["node", "{plugin_dir}/capabilities/codex-adapter.mjs"]
    }
  ]
}
```

## §10 — Config / taxonomy cross-binding

Auto-derived from `manifest.json` + the per-project `enforce-config.json` schema
(`patterns/enforce-config.schema.json`). M7f byte-diffs the block below against the
derived source-of-truth. NOTE: the single Codex `pre_tool_use` hook honors the
`bp-001.pre_checkpoint` clamp only (§5 cross-harness note).

S4 deploy layout (concrete, per-project): `install.mjs --install-enforcement --tool
codex` copies the adapter + engine under `<project>/.codex/episodic-memory/` and
registers the `PreToolUse` command hook in `<project>/.codex/hooks.json` — NEVER
`~/.codex/` (Principle 12). The generic `install_time_config` line below states the
substrate rule; for Codex the `.claude/` slot is `.codex/`.

<!-- CONFIG:BEGIN -->
**10a — Configuration.**

- `enforce_config_keys`: `active` (R5 project switch) + `bp-001.{plan_approval,post_checkpoint,pre_checkpoint,stop}` per-bp tier clamps (RFC-008 P4; schema `patterns/enforce-config.schema.json`; clamp-DOWN only; resolved by `enforce-contract --gate stop` / `--resolve-gate <gate>`).
- `install_time_config`: enforcement hooks deployed per-project under `<project>/.claude/` (or `<project>/.opencode/`), NEVER `~/.claude/` (Principle 12), by `install.mjs --install-hooks` / `--install-enforcement`.

**10b — Taxonomies.**

- `taxonomy_ref`: `patterns/taxonomy.json`
- `taxonomy_version`: `sha256:7ea41ed82edef968baee6880f040008080afd962fec9120336ee336796013cc4`
- `emits_labels`: `read_only`, `shared_write`, `push_or_pr_create`, `marker_write`, `unsafe_complex`
- `consumes_events`: `pre_tool_use`
- `event_translations_summary`:
  - `pre_tool_use`: `codex-pre-tool-use`
<!-- CONFIG:END -->
