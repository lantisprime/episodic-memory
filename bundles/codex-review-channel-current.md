# Codex review channel — current canonical bundle

**Bundle version:** 1
**Generated:** 2026-05-12 (manual; regenerate when component sha256 drifts)
**Claim class:** `codex-review-handoff`
**Gated by:** `hooks/preflight-gate.sh`

This bundle declares the canonical reading list an agent MUST load before
issuing any codex review handoff (em-store / em-revise / em-violation with
codex-review tags, `codex exec|review`, second-opinion harness, or
Agent dispatch with `codex:*|negative-scenario-*` subagent_type).

The pre-flight gate requires the agent's `.checkpoints/.preflight-done`
marker to:

1. List THIS bundle file in `required_files`.
2. Include each component listed below in `loaded_files` with the current
   sha256 + mtime_ms from disk.
3. Declare `claim_class = "codex-review-handoff"`.
4. Bind to the current `session_id` + `prompt_sha256`.

## Per-user settings allowlist

The helper script `scripts/preflight-marker-write.mjs` is invoked via `Bash`.
To avoid Claude Code's permission prompt on each invocation, add this to
`.claude/settings.json` or `.claude/settings.local.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(node */scripts/preflight-marker-write.mjs --root *)",
      "Bash(node */preflight-marker-write.mjs --root *)"
    ]
  }
}
```

Note: `.claude/settings.json` is gitignored in this repo (per-user file with
machine-specific paths). Each developer adds the allowlist locally. The
gate enforces helper-only writes regardless of allowlist state — the
allowlist only controls Claude Code's prompt UI.

## How to load (agent recipe)

```bash
# 1. Resolve memory_root (Cause 7 — see Plan §"Memory-root validation"):
#    Either read .episodic-memory/config.json:claude_memory_root OR compute
#    ~/.claude/projects/<sanitized-cwd>/memory.

# 2. For each component below, Read the file from <memory_root>/<basename>.

# 3. Compute current sha256 + mtime_ms for each loaded file.

# 4. Construct marker JSON (see schema below) and write atomically:
echo '<JSON>' | node $REPO_ROOT/scripts/preflight-marker-write.mjs \
  --root $REPO_ROOT --target preflight
```

## Components (7 files)

The basenames + the **bundle-recorded** sha256 are listed below. The pre-flight
gate validates against ACTUAL disk sha256 at gate time, not these recorded
values — a recorded-vs-disk mismatch here is a bundle-staleness issue
(regenerate this file), not a security issue.

| # | Basename | Role | Recorded sha256 (2026-05-12) |
|---|---|---|---|
| 1 | `reference_codex_review_flow.md` | Canonical 5-step flow (manual fallback) | `341cd798d4646a146beb7e06e50c2cc3f6b68e9fb4168fe74b0330bcaa895eeb` |
| 2 | `feedback_codex_cli_episode_messaging.md` | Foreground-only rule + auto-background mitigation | `e39f9117c14c8264aba5c6c7e44622eec82a6a32c590bcb0e5f3df7b9beb800d` |
| 3 | `feedback_subagent_cli_episode_messaging.md` | Both halves go through episodes | `8830b3e6245c4a32cffd1e907ee922fba44e7f919376e0ef5e586e77fcdb3b1f` |
| 4 | `feedback_canonical_agent_dispatch_trigger.md` | Trigger-phrase set | `a5f40e8f218b074fc8dd37551e998a0e0e7340076f3ff2bc77296db62bc60ec4` |
| 5 | `feedback_codex_review_request_preamble.md` | Canonical 7-section preamble (review-ladder) | `cf41fef47178932c299ab4cc30cb6342867cdaed1a4a055f32d5b433e9ec98b3` |
| 6 | `feedback_second_opinion_harness_runbook.md` | Operator runbook (timeout, HOLD discipline) | `a33a5ea246a712f4ccf37590a6a0e911495b4a1d10b4b5b8b793c87dd2acff1c` |
| 7 | `reference_second_opinion_harness.md` | Harness design reference (canonical channel) | `860372ea1f92cc6cb434c0a419a93913b76ad4d53a0084db53a02dd7ccbc08b5` |

Components 6 and 7 added in this PR1 bundle (codex r1 FU-3) — without them,
stale "manual 5-step recipe" knowledge could pass the gate while bypassing
the harness, which is now the canonical channel.

## Marker schema

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "prompt_sha256": "...",
  "prompt_index": 42,
  "cwd": "...",
  "repo_root": "...",
  "memory_root": "...",
  "claim_class": "codex-review-handoff",
  "matched_triggers": {
    "tool_target": ["Bash:em-store --tags codex-review", "Bash:codex exec"],
    "prompt_phrase": ["second opinion"]
  },
  "required_files": [
    "<repo>/bundles/codex-review-channel-current.md",
    "<memory_root>/reference_codex_review_flow.md",
    "<memory_root>/feedback_codex_cli_episode_messaging.md",
    "<memory_root>/feedback_subagent_cli_episode_messaging.md",
    "<memory_root>/feedback_canonical_agent_dispatch_trigger.md",
    "<memory_root>/feedback_codex_review_request_preamble.md",
    "<memory_root>/feedback_second_opinion_harness_runbook.md",
    "<memory_root>/reference_second_opinion_harness.md"
  ],
  "loaded_files": [
    {"path": "<abs-path>", "mtime_ms": 1746735000000, "sha256": "..."}
  ],
  "artifact_steps_done": ["memory-pre-pass", "channel-discipline-note", "work-area-tags"],
  "created_at_ms": 1746735000000
}
```

## Machine-readable component manifest

The block below is the source of truth for bundle composition. Tooling MAY
parse this JSON to enumerate components programmatically. Keep prose table
above in sync.

```json:bundle-manifest
{
  "version": 1,
  "generated_at_ms": 1747022400000,
  "components": [
    {
      "basename": "reference_codex_review_flow.md",
      "sha256": "341cd798d4646a146beb7e06e50c2cc3f6b68e9fb4168fe74b0330bcaa895eeb",
      "role": "canonical-5-step-flow"
    },
    {
      "basename": "feedback_codex_cli_episode_messaging.md",
      "sha256": "e39f9117c14c8264aba5c6c7e44622eec82a6a32c590bcb0e5f3df7b9beb800d",
      "role": "foreground-only-rule"
    },
    {
      "basename": "feedback_subagent_cli_episode_messaging.md",
      "sha256": "8830b3e6245c4a32cffd1e907ee922fba44e7f919376e0ef5e586e77fcdb3b1f",
      "role": "episode-messaging-contract"
    },
    {
      "basename": "feedback_canonical_agent_dispatch_trigger.md",
      "sha256": "a5f40e8f218b074fc8dd37551e998a0e0e7340076f3ff2bc77296db62bc60ec4",
      "role": "trigger-phrase-set"
    },
    {
      "basename": "feedback_codex_review_request_preamble.md",
      "sha256": "cf41fef47178932c299ab4cc30cb6342867cdaed1a4a055f32d5b433e9ec98b3",
      "role": "canonical-preamble"
    },
    {
      "basename": "feedback_second_opinion_harness_runbook.md",
      "sha256": "a33a5ea246a712f4ccf37590a6a0e911495b4a1d10b4b5b8b793c87dd2acff1c",
      "role": "operator-runbook"
    },
    {
      "basename": "reference_second_opinion_harness.md",
      "sha256": "860372ea1f92cc6cb434c0a419a93913b76ad4d53a0084db53a02dd7ccbc08b5",
      "role": "harness-design-reference"
    }
  ]
}
```

## Codex consensus chain (provenance)

This bundle composition was negotiated across 5 codex review rounds 2026-05-12:

- r1 ACCEPT-with-FU `20260512-070738-...-ed24` — codex caught that runbook + harness ref were missing (FU-3).
- r2-r4 HOLD chain on canonicalization + atomicity contracts.
- r5 ACCEPT `20260512-072545-...-dbf6` — bundle composition + helper-only contract converged.
