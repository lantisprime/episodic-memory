# claude-code activation adapter — runbook

RFC-009 R3: the advisory activation adapter. Registers `UserPromptSubmit`,
`PreToolUse`, and `SessionStart` hooks that surface lesson-activation context
to the assistant. It is advisory-ONLY — it never blocks, never emits a
`decision`/`block`/`permissionDecision` field, and every hook path exits 0.

Installed per-project (Principle 12), never into `~/.claude/`. It reads
ONLY the persisted per-store `trigger-index.json` built by
`em-trigger-index.mjs` — it never recomputes triggers or writes state of its
own. `plugins/claude-code-activation/manifest.json` is the source of truth
for its registrations; `scripts/lib/install-manifest.mjs`'s
`ACTIVATION_HOOK_SPECS` mirrors it (checksum-verified by
`tests/test-activation-manifest.mjs`).

Full hook matcher/inject logic lands in P2-S4 (UserPromptSubmit/PreToolUse)
and P2-S5 (SessionStart); this runbook and the manifest ship first as the
declared contract those slices implement against.
