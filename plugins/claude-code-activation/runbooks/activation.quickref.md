# claude-code activation adapter — quickref

Advisory-only (RFC-009 R3): never blocks, never emits `decision`/`block`/
`permissionDecision`, always exits 0. Per-project install only. Reads the
persisted per-store `trigger-index.json` — no recomputation, no writes.
Full contract: `plugins/claude-code-activation/runbooks/activation.md`.
