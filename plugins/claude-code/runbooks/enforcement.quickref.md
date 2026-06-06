# claude-code enforcement — quickref

STRONG on `pre_tool_use` / `stop` / `session_start` / `session_end`. Classifier
mode `default`, emits the 7 canonical taxonomy labels. Non-overridable:
`marker_write`, `unsafe_complex`. Markers live under `<repo>/.checkpoints/.*`
only. Full contract: `plugins/claude-code/runbooks/enforcement.md`.
