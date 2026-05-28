# Second-opinion harness — adding a provider (maintainer runbook)

How to add a new review provider (LLM/agent CLI or API) to the second-opinion
harness. This is the *maintainer* counterpart to `second-opinion-harness.md`
(which is the *operator* runbook for invoking reviews). Worked reference case:
the `opencode` provider (DeepSeek v4-pro), added 2026-05-27.

Unlike the operator runbook, this file is NOT injected by the gate hook — it's a
procedure you read when extending the harness, not a per-invocation reminder.

## The provider contract

Each provider is a module at `scripts/second-opinion/providers/<id>.mjs` exporting:

| Export | Type | Contract |
|---|---|---|
| `id` | string | must equal the filename stem and the registry `id` |
| `binary` | string | the CLI binary name (for `available()` PATH probe) |
| `available()` | fn → `{ ok: boolean, reason?: string }` | probe binary on PATH + a `--help` signature; never throw |
| `dispatch({ prompt, projectRoot, timeout })` | fn → `{ ok, exitCode, stdout, stderr, timedOut }` | `spawnSync`, `shell: false`, explicit `cwd: projectRoot`, `stdin: 'ignore'` |

Reference modules: `providers/codex.mjs`, `providers/gemini.mjs` (CLI-shaped).
`providers/stub.mjs` is the no-CLI fixture.

## The 6 touchpoints (in order)

1. **Provider module** — `providers/<id>.mjs`. Clone `gemini.mjs` (simplest
   CLI provider). Set `binary`, the `--help` signature regex, and the dispatch
   argv. Writing the reply episode is the *harness's* job — `dispatch()` only
   returns raw stdout/stderr.

2. **Provider registry** — add an entry to `providers/index.json`. Validated by
   `lib/registry-validator.mjs` at install/read/gate time, so every field is
   mandatory and shape-checked:
   - `id` — non-empty, unique
   - `binary` — non-empty string
   - `cli_match` — non-empty string, **compilable as a RegExp** (see scoping below)
   - `prompt_max_chars` — non-negative integer
   - `agent_block_patterns` / `agent_allow_patterns` — arrays of strings (`[]` ok)

3. **Preamble defaults** — `preambles/index.json`: add `default_per_provider.<id>`
   (a fragment-id list) and any new fragment to the `fragments[]` map. A CLI LLM
   with no agent loader ships the full review ladder inline as a fragment (see
   `fragments/gemini-ladder-v1.md`, `fragments/opencode-ladder-v1.md`); a tool
   with a loader can use a loader-ref fragment (`claude-subagent-loader-ref.md`).

4. **Tests** — extend the 5 suites:
   - `test-second-opinion-providers.mjs` — add `<id>` to the `PROVIDERS` array
     (drives the contract/available/dispatch-arg loops).
   - `test-second-opinion-preamble.mjs` — assert the default preamble composes.
   - `test-second-opinion-gate.mjs` — add `<id>` to `buildLiveSnapshot`'s
     providers, then assert the gated invocation blocks AND a non-review
     invocation is allowed (cli_match scoping).
   - `test-second-opinion-dispatch.mjs` — `available()` shape smoke test.
   - `test-install-second-opinion-e2e.mjs` — **REQUIRED**: add `<id>` to
     `makeAllProvidersUnavailable`'s list (Case 4 must neutralize *every*
     installed provider or Gate 2 won't fire on a host where `<id>` is present).
     Optionally assert the snapshot carries `<id>` in Case 1.

5. **Reinstall the snapshot** — `node install.mjs --tool claude-code
   --install-second-opinion`. Writes `~/.claude/hooks/second-opinion-providers.json`.
   Watch the output: `Registered provider: <id>` means `available()` passed;
   `Skip provider <id>: available() returned <reason>` means it failed — fix
   `available()` before proceeding. The harness fails closed on a stale snapshot,
   so this step is mandatory, not optional.

6. **Live probe (E2E)** — dispatch a real review through the harness:
   `node scripts/second-opinion.mjs request --provider <id> --project <abs>
   --storage files --body "..." --summary "..." --dispatch`. Confirms the CLI is
   authed and the model responds. If the model isn't authed, surface the auth
   step to the user (e.g. `opencode auth`) — never stub it silently.

## cli_match scoping — the rule that bites

`cli_match` is what the **gate** (`second-opinion-gate.mjs`) uses to *block
direct Bash calls* to the provider, forcing them through the harness. Scope it
to the **review invocation subcommand**, never the bare binary:

- ✅ codex: `^codex\s+exec\b`  ✅ opencode: `^opencode\s+run\b`
- ❌ `^opencode\b` — would also block the interactive TUI and every other
  subcommand (`opencode models`, `opencode auth`, …), which has nothing to do
  with reviews.

This `cli_match` is NOT an allowlist and is unrelated to the checkpoint-gate's
read-only classifier. Do **not** add provider commands to the checkpoint-gate
allowlist — the harness spawns the provider via `spawnSync` inside Node, so the
checkpoint-gate never sees `<id> run`; it only sees the provider-agnostic outer
`node second-opinion.mjs` call. Adding an agentic command to a read-only
allowlist would punch a pre-checkpoint bypass.

## CLI-shaped vs API-only providers

- **CLI-shaped** (codex, gemini, opencode): `available()` probes a binary on
  PATH; `dispatch()` spawns it. This is the common case — clone `gemini.mjs`.
- **API-only** (HTTPS + key, no CLI): `available()` checks the API-key env var
  instead of PATH; `dispatch()` does a `fetch` instead of `spawnSync`. There's
  no Bash call for the gate to catch, so give `cli_match` a never-matching
  regex (the validator still requires a non-empty compilable string).

## Cross-platform note (open same-class gap)

All current CLI providers use `which <binary>` in `available()`, which is
POSIX-only — Windows uses `where`. This is a pre-existing same-class gap across
every provider, not specific to any one. When you touch `available()`, prefer a
cross-platform probe (`where` on win32, `which` elsewhere) and fix the class.

## Gotchas (learned the hard way)

- **`--help` may print to stderr.** `opencode --help` writes usage to **stderr**,
  not stdout (`opencode --help 2>/dev/null` is empty). An `available()` that
  captures stdout only (`stdio: ['ignore', 'pipe', 'ignore']`) will see an empty
  string and return `cli-help-signature-mismatch`. Capture **both** streams
  (`['ignore', 'pipe', 'pipe']`) and test the signature against their
  concatenation. The unit tests won't catch this — they don't assert `ok=true`
  (CI hosts may lack the binary). The **install step's** `Registered`/`Skip`
  line is what surfaces it.
- **Agentic CLIs can edit files.** A `run`-style agent invoked for a review may
  try to use file-editing tools. Put a "you are reviewing, NOT implementing; do
  not edit files" instruction in the provider's ladder fragment.
- **Model pinning lives in the provider module.** The harness calls
  `dispatch({ prompt, projectRoot })` and does NOT pass a model. Set the model
  in the module (e.g. `const model = process.env.<TOOL>_MODEL || DEFAULT`).

## Composes with

- `second-opinion-harness.md` — operator runbook (how to *invoke* reviews).
- `reference_second_opinion_harness.md` — design reference (what the harness IS).
- `feedback_cross_platform_always.md` — the cross-platform design lens.
