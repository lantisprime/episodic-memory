# Frozen build spec: #516 + #512 residuals (env-marker class completion + timeout message accuracy)

Status: FROZEN at dispatch (2026-08-08). Scope changes require updating this doc AND restart-or-resync of the builder seat.

## Evidence base (scouted + orchestrator-ground-truthed)

- **#516 core is already fixed**: `scripts/second-opinion/providers/codex.mjs:89` sets `env: { ...process.env, CLAUDE_SCHEDULED_TASK: '1' }` (commit `6e82fee`, "fixes #636", merged 2026-07-30; #636 CLOSED, #516 left open). `claude-subagent.mjs:72` has the same fix (#232). Regression suite `tests/test-codex-env-propagation.mjs` passes locally (1/1, run 2026-08-08).
- **Unfixed same-class siblings**: `scripts/second-opinion/providers/gemini.mjs:54-60` and `scripts/second-opinion/providers/opencode.mjs:84-90` spawn with NO `env:` key — they inherit `process.env` without the marker, so a hook-bearing repo breaks their dispatches identically.
- **#512 core is already fixed**: `--timeout` parsing (`scripts/second-opinion.mjs:220-224`), dispatch plumbing (`:388`), typed `provider-timeout` envelope + forensics (`:393-406`) shipped in `766ed3c` (PR #520). Runtime-verified this session on an isolated fixture: stub + `--timeout 1500` + `SO_STUB_SLEEP_MS=3000` → `{"code":"provider-timeout","message":"Provider stub timed out after 1500ms (round 1)",...}` with forensics file; fast path clean.
- **#512 residual defect**: when `--timeout` is omitted, `timeoutMs` is `undefined`; the provider's internal 600000 default fires but the error message at `scripts/second-opinion.mjs:404` renders "timed out after undefinedms" and the envelope carries `timeoutMs: undefined`.

## In scope (writable file set — exhaustive)

1. `scripts/second-opinion/providers/gemini.mjs` — add the one-line env override to the `dispatch()` spawnSync options, mirroring `codex.mjs:89` exactly, including a short comment citing #516/#636 class.
2. `scripts/second-opinion/providers/opencode.mjs` — same one-line env override + comment.
3. `scripts/second-opinion.mjs` — timeout message accuracy: introduce `const DEFAULT_DISPATCH_TIMEOUT_MS = 600000` near the top of the request path; always pass `timeout: timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS` to `providerModule.dispatch(...)` (replacing the conditional spread at `:388`); use the same effective value in the `provider-timeout` message and envelope (`:403-405`). No behavior change when `--timeout` is passed; when omitted, behavior is identical (600000) but the error now names the real number.
4. `tests/test-gemini-env-propagation.mjs` — NEW. Copy `tests/test-codex-env-propagation.mjs`, retarget the provider path and shim binary name (`gemini`, argv shape `[prompt]`); assert the marker, cwd binding, no side-effect leaks (I-516a/b/c naming).
5. `tests/test-opencode-env-propagation.mjs` — NEW. Same twin, retargeted (`opencode`, argv shape `['run','-m',<model>,prompt]`).
6. `.github/workflows/tests.yml` — wire BOTH new suites as explicit bare `run:` steps next to the codex entry (lines 224-225). Do NOT add them to `KNOWN_UNWIRED` in `tests/test-ci-suite-registration.mjs`.
7. `.claude-plugin/plugin.json` — version `0.2.5` → `0.2.6` (CI gate #644; this manifest, NOT `plugins/episodic-memory/.claude-plugin/plugin.json`).

## Explicitly OUT of scope (do not touch)

- NO CLI-side floor-clamp of `--timeout` to 600000 (issue #512's "floor-clamped" clause): DEFERRED — the floor is enforced at the outer layer by the so-gate hook (`plugins/claude-code/hooks/lib/so-timeout-floor.mjs`, `TIMEOUT_FLOOR_MS`, stub carve-out); a CLI clamp would break `tests/test-so-timeout.mjs` (stub + `--timeout 1500`) and duplicate gate logic. Rationale goes in the PR body, not code.
- NO request-record failure annotation for orphaned requests: DEFERRED to #649-class envelope work (forensics capture already persists evidence).
- NO changes to `session-handoff-prompt.sh`, no `EM_NONINTERACTIVE` marker (zero repo precedent; `CLAUDE_SCHEDULED_TASK` is the established convention used by launchd callers).
- NO edits to `codex.mjs` / `claude-subagent.mjs` / `stub.mjs`, no shared spawn-helper refactor (per-provider option objects are the established pattern).
- NO commits, pushes, memory writes, or edits outside the writable set.

## Per-step verification (builder runs each; orchestrator re-runs independently)

- V1: `node tests/test-gemini-env-propagation.mjs` → all pass.
- V2: `node tests/test-opencode-env-propagation.mjs` → all pass.
- V3: `node tests/test-codex-env-propagation.mjs` → still 1/1 (no regression).
- V4: `node tests/test-so-timeout.mjs` → all pass (message fix must not disturb explicit-timeout paths).
- V5: `node tests/test-second-opinion-providers.mjs` → provider contract intact.
- V6: `node tests/test-ci-suite-registration.mjs` → new suites detected as wired.
- V7: `node scripts/check-plugin-version-bump.mjs` semantics honored (bump present; CI validates on PR).
- V8: `node tests/test-second-opinion-dispatch.mjs` and `node tests/test-second-opinion-consensus.mjs` → dispatch-path suites green after the `:388` change.

## Builder hard rules

Implement ONLY what this spec lists. No commits. No `git add`. Report a per-file diff summary + verbatim verification outputs. Style anchors: `codex.mjs:82-89` (env override + comment), `tests/test-codex-env-propagation.mjs` (twin test), `tests.yml:224-225` (CI step shape).
