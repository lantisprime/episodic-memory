# LLM Classifier Config Schema

Tier 2/3 LLM classifier configuration. Documented as **operational config**,
not a source contract — model IDs may change without bumping the project
version; sites that hard-code one are responsible for keeping their pin
fresh.

## Locations and precedence

Highest precedence wins. Higher tiers override individual fields; missing
fields fall through.

| Tier | Source | Path |
|---|---|---|
| 1 | environment | `LLM_CLASSIFIER_*` env vars |
| 2 | project | `<project-root>/.episodic-memory/classifier-config.json` |
| 3 | global | `~/.episodic-memory/classifier-config.json` |
| 4 | defaults | hardcoded in `scripts/classifier-config-loader.mjs` |

## Fields

| Key | Type | Default | Notes |
|---|---|---|---|
| `model` | string | `claude-haiku-4-5-20251001` | Anthropic model ID for Tier 3 dispatch. **Selectable, not hardcoded.** Use `claude-sonnet-4-6` or any newer ID without code changes. |
| `enabled` | boolean | `true` | When `false`, Tier 3 is skipped entirely (no API call, no cache write). Tier 1 + Tier 2 still run. |
| `fail_mode` | enum | `heuristic` | One of `{heuristic, block}`. **`allow` is explicitly rejected** — fail-open is unsafe for a security gate. |
| `timeout_ms` | number | `5000` | Tier 3 HTTP timeout in ms. Clamped to `[100, 60000]`. |
| `max_tokens` | number | `200` | Response token cap. Clamped to `[1, 4096]`. |
| `temperature` | number | `0` | Sampling temperature. `0` for deterministic classification; clamped to `[0, 2]`. |
| `confidence_threshold` | number | `0.7` | Tier 3 emits a label only if confidence ≥ threshold. Below threshold → `fail_mode` applies. Clamped to `[0, 1]`. |
| `api_base` | string | `https://api.anthropic.com` | API base URL. |
| `api_version` | string | `2023-06-01` | `anthropic-version` header value. |

## Environment variable overrides

Each field has a matching env var with `LLM_CLASSIFIER_` prefix and SCREAMING_SNAKE_CASE:

- `LLM_CLASSIFIER_MODEL`
- `LLM_CLASSIFIER_ENABLED` (accepts `true|false|1|0|yes|no|on|off`)
- `LLM_CLASSIFIER_FAIL_MODE`
- `LLM_CLASSIFIER_TIMEOUT_MS`
- `LLM_CLASSIFIER_MAX_TOKENS`
- `LLM_CLASSIFIER_TEMPERATURE`
- `LLM_CLASSIFIER_CONFIDENCE_THRESHOLD`
- `LLM_CLASSIFIER_API_BASE`
- `LLM_CLASSIFIER_API_VERSION`

## Project config example

`<project-root>/.episodic-memory/classifier-config.json`:

```json
{
  "model": "claude-sonnet-4-6",
  "confidence_threshold": 0.85,
  "fail_mode": "block"
}
```

A blocking failure mode is the right choice when you would rather see a
denial than risk a misclassified write being allowed through.

## API key

The classifier reads `ANTHROPIC_API_KEY` from the environment. If the key is
missing, the dispatcher emits a stderr warning and falls back to Tier 1
without a network call. **No silent fall-through.**

## `fail_mode: block` semantics — what "block" actually means

`fail_mode: block` returns `unsafe_complex` when Tier 3 fails. That label is
treated as a hard block by **active gates during their enforcement windows**
(pre-checkpoint, post-checkpoint, plan-approval-pending). Outside those
windows, `unsafe_complex` follows the same path as `shared_write` — the
hook lets the command run, because checkpoint-gate.sh only stops writes
during a marker-armed lifecycle.

In other words: `fail_mode: block` means **"block during gate windows"**, not
**"always block"**. If you need always-block on Tier 3 failure, hold the
classifier offline (`enabled: false`) — the Tier 1 heuristic's `shared_write`
default for unknown interpreters is the strictest available label without
extending checkpoint-gate.sh itself.

## Why classify-correction.mjs carries the `read_only` label

`classify-correction.mjs` writes ONLY to
`<project-root>/.episodic-memory/classifier-overrides.jsonl` and validates
its `--project-root` matches `resolveRepoRoot(process.cwd())` before
writing. The plan called for a new `helper_write` label, but adding one
would require changes across `checkpoint-gate.sh`, `plan-gate.sh`, and
`stop-gate.sh` for a single helper. The implementation uses
`read_only / interpreter_classify_correction` instead — same convention as
`em-search.mjs` (also `read_only` despite touching `tracking.jsonl`). The
gate-bypass semantics are identical; the reason field carries the
helper-write nature for any downstream code that wants the distinction.

## Validation behavior

Invalid values do not error — the loader logs a warning to stderr and uses
the default. Specifically:

- Unknown `fail_mode` → defaults to `heuristic` with warning.
- Out-of-range numeric → default with warning.
- Non-string `model` → default with warning.

This is intentional: the classifier must remain available even with a
broken config; a hard error would break the Bash gate entirely.

## Per-command overrides

For per-command overrides, use the correction helper instead of editing
config:

```bash
node ~/.episodic-memory/scripts/classify-correction.mjs \
  --project-root "$(git rev-parse --show-toplevel)" \
  --caller-cwd  "$(pwd)" \
  --command     "python3 src/inspect.py" \
  --label       read_only
```

See `skills/classify-correction/SKILL.md` for the full helper interface.
