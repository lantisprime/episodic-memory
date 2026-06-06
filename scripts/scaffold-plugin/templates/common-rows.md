| Event | STRONG | MEDIUM | WEAK |
|---|---|---|---|
| `pre_tool_use` | block | warn (marker) | inject |
| `tool_result` | modify | observe | unsupported |
| `stop` | refuse_stop | warn | unsupported |
| `session_start` | inject_context | inject_context (best-effort) | inject_static |
| `session_end` | write_artifact | write_artifact (best-effort) | unsupported |
