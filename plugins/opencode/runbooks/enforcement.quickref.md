# opencode enforcement — quickref

STRONG on `pre_tool_use` (block on repo-source write). MEDIUM (observe) on
`tool_result`, `session_start`, `stop`. Classifier mode `default`, emits the 7
canonical taxonomy labels. Non-overridable: `marker_write`, `unsafe_complex`.
Gate scope: repo-source writes only (R1-R3); carve-outs via
`patterns/repo-source-carveouts.json`. Bridge: `node {plugin_dir}/capabilities/enforce-bridge.mjs`.
Full contract: `plugins/opencode/runbooks/enforcement.md`.
