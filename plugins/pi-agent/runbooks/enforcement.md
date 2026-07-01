# pi-agent — enforcement runbook

> RFC-008 P7 enforcement plugin. Manifest: `plugins/pi-agent/manifest.json`;
> registry entry: `plugins/_index.json`. This runbook is the human + agent
> contract for how the Pi enforcement plugin classifies commands and gates
> repo-source writes via an in-process Pi `tool_call` extension. It is validated
> structurally by `scripts/validate-plugin-registry.mjs` (M7/M7a + M7c–M7f
> content derivation).

## ⚠️ Self-trigger checklist

Before acting under this plugin, confirm each of the following — this is the
fail-closed self-check the agent runs at the moment a gated tool call forms:

- The manifest validates against `plugins/manifest.schema.json` (M2).
- The command classifies to a taxonomy label in `patterns/taxonomy.json` (M5).
- The non-overridable labels (`marker_write`, `unsafe_complex`) are never remapped (§3).

## §1 — Capability summary

The pi-agent plugin **declares** `pre_tool_use` at **MEDIUM** (honest tier ceiling).
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
(KB `memory/knowledge_base/pi-agent-extensions.md`) confirmed the Pi `tool_call`
**mechanism** is STRONG — the handler returns `{block:true,reason}` to deny the
tool synchronously before it runs — but the honest delivered tier is MEDIUM
(mechanism STRONG, extractor residual MEDIUM).

## §2 — Event tiers (pi-agent)

`pre_tool_use` is the only event this plugin handles. It is **declared MEDIUM**
in the manifest/registry/`bypass_known` (the honest residual ceiling), but the
adapter passes a **runtime mechanism cap of `STRONG`** to `gateDisposition` for
covered repo-source writes (RFC-008 P7 §8.2/§19.4 tier/cap split): the manifest
MEDIUM would otherwise map to `warn` (`events.json` `pre_tool_use@MEDIUM` →
clamp-off → no block), so a covered write would not be enforced. With the runtime
STRONG cap, a covered repo-source write is hard-blocked (the `tool_call` handler
returns `{block:true,reason}`, denying the tool pre-execution). Unlexable Bash
forms are not extracted → ALLOWED (the declared MEDIUM residual). Pi's other
lifecycle events (`session_start`/`session_shutdown`/`turn_end`) are observe-only
and out of scope for P7 (S3 deferred).

## §3 — Classifier mode & emitted labels

Mode is `override`: the manifest declares `classifier.override_path` =
`enforcement.js`. Unlike a label-emitting classifier, the Pi adapter gates by PATH
directly (`isRepoSource`, §5) — it does NOT implement a `classifyLabel` function and
does NOT emit taxonomy labels at runtime: a covered repo-source write returns
`{block:true,reason}`, everything else returns `undefined`. The 5-label vocabulary
(`read_only`, `shared_write`, `push_or_pr_create`, and the two non-overridable
`marker_write` / `unsafe_complex`) is DECLARED in the manifest `emits_labels` (required
by M5a) as a static safety FLOOR — the substrate keeps routing the non-overridable
labels and no override may remap or drop them — NOT a claim of runtime emission. Marker
writes under `.checkpoints/` are allowed by the repo-source carve-out (§4), not by label
routing. (Same static-floor posture as the codex/opencode plugins, whose adapters map
labels for telemetry; the Pi adapter does not.)

## §4 — Repo-source gate scope

The pi-agent plugin gates ONLY repo-source writes (R1-R3). Carve-outs are defined
in `patterns/repo-source-carveouts.json` (Rule 14 single source, shared via
`scripts/lib/repo-source.mjs`). Non-repo writes (e.g. `/tmp`, `/dev/null`), the
episode store, plan files under `docs/plans/`, marker writes under `.checkpoints/`,
and git-ignored paths are always allowed. Every extracted target — including
relative paths — is normalized via `path.resolve(baseCwd, target)` against the
extension's `ctx.cwd` BEFORE the repo-source check, and `repoRoot` is resolved
INDEPENDENTLY as the git toplevel of `baseCwd` (Pi exposes no `ctx.projectRoot`),
so a nested `ctx.cwd` cannot resolve `src/x.mjs` to the wrong root (BLOCKER 3).

## §5 — Gate lifecycle

The gate decision is a two-layer AND on the resolved write target(s):
1. `isRepoSource(root, p).isRepoSource` from `scripts/lib/repo-source.mjs` — called
   DIRECTLY per normalized path (NOT `toolTargetsRepoSource(...,"Bash",...,label)`,
   whose label branch short-circuits `read_only`/`nonsrc_write` to ALLOW before the
   path check).
2. `gateDisposition({...})` from `scripts/enforce-contract.mjs` — with
   `harnessCap:"STRONG"` (runtime mechanism cap, §2), returns a token; the adapter
   blocks on `enforce`/`block`.

Only when a path is repo-source AND the disposition is `enforce`/`block` does the
handler deny (`{block:true,reason}`). A malformed `write`/`edit` (missing/empty
`input.path`) denies unconditionally (fail-closed State C2). No extractable
repo-source target (e.g. `git commit`, `mkdir`, an unlexable Bash form, State C1)
allows, so normal use is never bricked. Pi has no `apply_patch` tool — writes go
through `write`/`edit` (`input.path`) and `bash` (`input.command`).

**Operator clamp (cross-harness note).** The adapter resolves the per-gate
operator clamp `configTier` from `enforce-config.json` key
`bp-001.pre_checkpoint`. The single Pi `tool_call` handler models the
**pre-implementation checkpoint** gate (block repo-source writes), so it clamps on
the same key the native bash `checkpoint-gate.sh` uses for that gate. Unlike the
Claude bash layer — which resolves `plan_approval`, `pre_checkpoint`, and
`post_checkpoint` as three distinct `pre_tool_use` gate moments — the stateless
single Pi handler does NOT separately model `plan_approval` or `post_checkpoint`;
setting `bp-001.pre_checkpoint` clamps every covered Pi repo-source write.
(opencode leaves `configTier` null — no per-gate clamp; codex and pi-agent honor
the pre_checkpoint clamp.)

## §6 — Extension event protocol

`plugins/pi-agent/capabilities/enforcement.js` is an in-process Pi extension (NOT
a spawned command hook). Its default export `function(pi)` registers
`pi.on("tool_call", handler)`; Pi calls `handler(event, ctx)` synchronously before
each tool runs, where `event` is `{toolName, input}` and `ctx` carries `cwd`. The
handler:
- returns `{block:true, reason}` to DENY the tool before it runs;
- returns `undefined` to ALLOW.

It fail-closes (returns `{block:true}`) on: a non-object `event`/`input`, a
missing/non-absolute or unrealpathable `ctx.cwd` (State B), a `repoRoot`
unresolvable for an under-`baseCwd` target (State B2), a malformed `write`/`edit`
path (State C2), a dynamic thin-waist import failure (State D — the waist is
imported DYNAMICALLY inside a try, so a missing module denies), or any uncaught
throw (State H). A known read-only tool (`read`/`grep`/`find`/`ls`) allows
(State A).

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

**Invocation modality:** agent

The adapter is an in-process Pi extension (NOT a command hook). It is registered by
placing the file at `<project>/.pi/extensions/episodic-memory/index.js`, which Pi
auto-discovers and loads in a TRUSTED project (`--approve` / interactive project
trust). Pi calls the exported `tool_call` handler per gated tool call. M7d asserts
this line byte-equals `manifest.invocation_modality`.

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
  "command_shapes": [["pi", "-e", "{plugin_dir}/index.js"]],
  "required_args": [],
  "optional_args": [],
  "expected_outputs": { "shape": "in-process-decision" },
  "env_requirements": [],
  "return_codes": {
    "0": "allow — handler returns undefined (non-repo / carve-out / gitignored / no-target / read tool)",
    "1": "deny — handler returns {block:true,reason} (repo-source write, or fail-closed malformed/import/throw)"
  },
  "dispatch_examples": [
    {
      "description": "tool_call repo-source write → handler returns {block:true} (auto-loaded from .pi/extensions/episodic-memory/index.js in a trusted project)",
      "argv": ["pi", "-e", "{plugin_dir}/index.js"]
    }
  ]
}
```

## §10 — Config / taxonomy cross-binding

Auto-derived from `manifest.json` + the per-project `enforce-config.json` schema
(`patterns/enforce-config.schema.json`). M7f byte-diffs the block below against the
derived source-of-truth. NOTE: the single Pi `pre_tool_use` handler honors the
`bp-001.pre_checkpoint` clamp only (§5 cross-harness note).

S5 deploy layout (concrete, per-project): `install.mjs --install-enforcement --tool
pi-agent` copies the adapter + engine under
`<project>/.pi/extensions/episodic-memory/` — NEVER `~/.pi/` (Principle 12);
activation is Pi project trust (`--approve` / interactive). The generic
`install_time_config` line below states the substrate rule; for Pi the `.claude/`
slot is `.pi/extensions/episodic-memory/`.

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
  - `pre_tool_use`: `pi-tool-call`
<!-- CONFIG:END -->
