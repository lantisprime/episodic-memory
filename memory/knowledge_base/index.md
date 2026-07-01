# Knowledge base index

Distilled web-research cache (per global Rule 7). Each entry has frontmatter `url` / `fetched` / `summary`.

| Topic | File | Fetched | Summary |
|---|---|---|---|
| Codex CLI hooks | [codex-hooks.md](codex-hooks.md) | 2026-06-28 | Codex hooks use Claude-Code-style events; block via exit 2 / `permissionDecision:deny` (NOT `{block:true}`); any-language command hooks (NOT Python-only). **EMPIRICAL (v0.142.3): the blanket-deny probe BLOCKS apply_patch + every shell form (6 bypass attempts) → MECHANISM is STRONG; the RFC's multi-edit-bypass justification is refuted. But the delivered {codex,pre_tool_use} capability is MEDIUM — the adapter's Bash extractor cannot lex unlexable writes (eval/sh -c/$VAR/command-subst), so those escape (bypass_known MEDIUM ceiling).** Real apply_patch stdin captured. Corrects 4 RFC-008 Codex assumptions. Source for RFC-008 P6. |
| Cursor hooks | [cursor-hooks.md](cursor-hooks.md) | 2026-05-28 | Cursor exposes 16+ programmatic hooks (blocking + observational) — STRONG-capable, NOT WEAK. Source for RFC-008 F43 capability-matrix correction. |
| OpenCode plugin API | [opencode-plugin-api.md](opencode-plugin-api.md) | 2026-06-23 | OpenCode hook API from installed @opencode-ai/plugin@1.14.50 types (web docs wrong on tool.execute.after — it IS mutable). pre_tool_use/tool_result STRONG, session_start/stop MEDIUM. Source for RFC-008 P5. |
| Windsurf rules/memories | [windsurf-rules.md](windsurf-rules.md) | 2026-05-28 | Windsurf exposes no programmatic hooks — file-based rules only. Confirms WEAK tier. Source for RFC-008 F43. |
| cmux CLI | [cmux-cli.md](cmux-cli.md) | 2026-06-28 | Native macOS terminal app; CLI drives it over a Unix socket. `send`/`send-key <enter>`/`read-screen` (tmux-compat `capture-pane`) = the send-keys/capture-pane equivalents; refs are `workspace:N`/`surface:N`; `new-workspace --command` auto-newlines; native `codex-teams`/`claude-teams`. Smoke-tested: send+enter+read-screen round-trips executed output. Candidate replacement for the tmux codex-drive.sh review driver. |
