# BP-1 Activation Map — `~/.episodic-memory/config.json`

The activation map is a per-project safety envelope for [RFC-004 BP-1 Auto-Pilot](../rfcs/RFC-004-bp1-auto-pilot.md). It lives at `~/.episodic-memory/config.json` and is shared across all projects on a machine. Each entry binds an M5 dry-run proof to a canonical project root.

## Schema

```json
{
  "bp1": {
    "schema_version": 1,
    "activations": {
      "<canonical_project_root>": {
        "enabled": true,
        "artifact_version_hash": "sha256:<hex>",
        "enabled_at": "<ISO-8601 UTC>",
        "enabled_via": "<dry-run-run_id>",
        "verify_key_id": "<16-char hex fingerprint>"
      }
    }
  }
}
```

| Field | Type | Source |
|---|---|---|
| `<canonical_project_root>` | string (key) | `git rev-parse --show-toplevel` then `realpath` (resolves symlinks) |
| `enabled` | bool | `false` until M5's dry run flips it |
| `artifact_version_hash` | string `sha256:<64hex>` | Output of `node scripts/bp1-build-artifact-manifest.mjs --project <root>` at activation time |
| `enabled_at` | ISO-8601 UTC | M5 wall-clock timestamp |
| `enabled_via` | string | `bp1-run-<ts>-<rfc-slug>-<rand6>` — the M5 dry-run run_id |
| `verify_key_id` | string (16 hex) | First 16 chars of `HMAC-SHA256(key, "verify-key-fingerprint-v1")` over `~/.episodic-memory/.verify-key` |

## Lifecycle

1. **First install** — `install.mjs` creates `~/.episodic-memory/.verify-key` (32 random bytes, mode 0600) if missing, and writes the config skeleton `{"bp1":{"schema_version":1,"activations":{}}}` if missing. No project entries.
2. **Per-project install** — `install.mjs` runs again per project to sync scripts/hooks/etc. Activation entry is **not** auto-created here.
3. **M5 dry run** — `bp1-flag-flip.mjs` (M5 deliverable, future PR) takes the global config lock, completes the dry-run safety proof, then writes the project's activation entry with `enabled: true`.
4. **Live use** — every gated artifact reads via `bp1-flag-check.mjs --project <root>`. The check passes iff:
   - Map entry exists for the canonical project root
   - `enabled === true`
   - `artifact_version_hash` matches a fresh recomputation by `bp1-build-artifact-manifest.mjs`
   - `verify_key_id` matches a fresh fingerprint of `~/.episodic-memory/.verify-key`
5. **Disable** — `bp1-flag-flip.mjs --disable <project>` (M5 deliverable) removes the named project's entry. Other projects' entries are untouched.

## Failure modes (RFC-004 §11.5 rows 25-29)

| Row | Code | Trigger |
|---|---|---|
| 25 | `bp1-disabled-refusal` | Entry missing, or `enabled: false` |
| 26 | `bp1-flag-version-drift` | Recomputed `artifact_version_hash` ≠ stored value (install drift since activation) |
| 27 | `bp1-flag-key-drift` | Live verify-key fingerprint ≠ stored `verify_key_id` (key rotated without re-running M5) |
| 28 | `bp1-flag-config-corrupt` | `config.json` parse error or schema mismatch |
| 29 | `bp1-hmac-keyfile-fail` | `~/.episodic-memory/.verify-key` missing, mode ≠ 0600, or wrong size |

Any of these → `bp1-flag-check.mjs` exits non-zero and (when invoked by a gated caller) emits a local-scope violation episode.

## Concurrency

The map is read/written through a `flock`-protected helper. Concurrent activations across projects serialize on the global config lock; each writer mutates only its own key.

## File-mode invariants

- `~/.episodic-memory/.verify-key` — `0600`. Asserted on every read by `bp1-flag-check.mjs` and orchestrator startup. `install.mjs` `chmod`s it on every run (defends against umask + manual touch drift).
- `~/.episodic-memory/config.json` — default user mode (typically `0644`); contents are integrity-protected by `verify_key_id` cross-checks, not by file mode.

## Related

- [RFC-004 §83-210](../rfcs/RFC-004-bp1-auto-pilot.md) — full activation flag spec.
- [RFC-004 §660-668](../rfcs/RFC-004-bp1-auto-pilot.md) — long-lived verify-key spec + rotation procedure (M5 `bp1-rotate-verify-key.mjs`).
- `scripts/bp1-flag-check.mjs` — the gate.
- `scripts/bp1-build-artifact-manifest.mjs` — manifest hash recomputation (single source of truth).
- `scripts/lib/bp1-manifest.mjs` — shared library used by both.
