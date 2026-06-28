# codex enforcement — quickref

Declared **MEDIUM** on `pre_tool_use` (honest residual ceiling); runtime passes a
STRONG mechanism cap so covered repo-source writes hard-block (Codex hook exit 2 +
`permissionDecision:"deny"`). Mechanism STRONG, Bash-extractor residual MEDIUM
(`eval`/`$VAR`/command-subst/`sh -c` ALLOW). Classifier mode `override`
(`codex-adapter.mjs`); declares the 5-label safety-floor vocabulary, emits 3
(`read_only`, `shared_write`, `push_or_pr_create`); label is telemetry, not gating.
Gate scope: repo-source writes only (R1-R3); carve-outs via
`patterns/repo-source-carveouts.json`. Gating = per-path `isRepoSource` DIRECT +
`gateDisposition(harnessCap:"STRONG")`. Operator clamp: `bp-001.pre_checkpoint`
only. Hook: `node {plugin_dir}/capabilities/codex-adapter.mjs` (Codex
`.codex/hooks.json` PreToolUse command hook). Full contract:
`plugins/codex/runbooks/enforcement.md`.
