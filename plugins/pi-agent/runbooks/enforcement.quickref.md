# pi-agent enforcement — quickref

Declared **MEDIUM** on `pre_tool_use` (honest residual ceiling); the extension passes a
STRONG mechanism cap so covered repo-source writes hard-block (the `tool_call` handler
returns `{block:true,reason}`, denying the tool before it runs). Mechanism STRONG,
Bash-extractor residual MEDIUM (`eval`/`$VAR`/command-subst/`sh -c` ALLOW). Classifier mode
`override` (`enforcement.js`); declares the 5-label safety-floor vocabulary; label is
telemetry, not gating. Gate scope: repo-source writes only (R1-R3); carve-outs via
`patterns/repo-source-carveouts.json`. Gating = per-path `isRepoSource` DIRECT +
`gateDisposition(harnessCap:"STRONG")`. Operator clamp: `bp-001.pre_checkpoint` only. Load:
in-process Pi extension auto-discovered from `<project>/.pi/extensions/episodic-memory/index.js`
in a TRUSTED project (`--approve`). Full contract: `plugins/pi-agent/runbooks/enforcement.md`.
