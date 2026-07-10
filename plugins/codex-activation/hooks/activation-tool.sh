#!/usr/bin/env bash
# Codex RFC-009 advisory activation — PreToolUse. Never blocks.
INPUT="$(cat)"
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
RUNNER="$HOOK_DIR/activation-hook-run.mjs"
if [ -n "$HOOK_DIR" ] && [ -f "$RUNNER" ]; then
  printf '%s' "$INPUT" | node "$RUNNER" PreToolUse || true
fi
exit 0
