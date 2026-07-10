# Codex activation adapter

RFC-009 advisory activation for Codex. It installs project-local command hooks
for `UserPromptSubmit`, `PreToolUse`, and `SessionStart` under `.codex/`.

The adapter is recall-side and advisory only. Every path exits zero and emits
no blocking or decision field. It reads the purpose-built trigger indexes and
injects bounded lesson context through `hookSpecificOutput.additionalContext`.

After installation, run `/hooks` inside Codex from the project and trust the
three new hook definitions. Codex skips new or changed project hooks until their
exact definitions are trusted.
