# Knowledge base index

Distilled web-research cache (per global Rule 7). Each entry has frontmatter `url` / `fetched` / `summary`.

| Topic | File | Fetched | Summary |
|---|---|---|---|
| Cursor hooks | [cursor-hooks.md](cursor-hooks.md) | 2026-05-28 | Cursor exposes 16+ programmatic hooks (blocking + observational) — STRONG-capable, NOT WEAK. Source for RFC-008 F43 capability-matrix correction. |
| OpenCode plugin API | [opencode-plugin-api.md](opencode-plugin-api.md) | 2026-06-23 | OpenCode hook API from installed @opencode-ai/plugin@1.14.50 types (web docs wrong on tool.execute.after — it IS mutable). pre_tool_use/tool_result STRONG, session_start/stop MEDIUM. Source for RFC-008 P5. |
| Windsurf rules/memories | [windsurf-rules.md](windsurf-rules.md) | 2026-05-28 | Windsurf exposes no programmatic hooks — file-based rules only. Confirms WEAK tier. Source for RFC-008 F43. |
