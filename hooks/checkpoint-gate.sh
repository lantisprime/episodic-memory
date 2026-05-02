#!/usr/bin/env bash
set -e

# checkpoint-gate.sh — RFC-002 Phase 3b PreToolUse hook
#
# Two gates with shared marker state in $CWD/.claude/:
#
#   pre-checkpoint:
#     Blocks Edit/Write/MultiEdit/Bash/NotebookEdit when
#     .checkpoint-required exists AND .pre-checkpoint-done is missing/empty.
#     Activator: em-recall.mjs touches .checkpoint-required when bp-001
#     violations surface in pre-flight (Phase 3, em-recall.mjs:347-369).
#
#   push-gate:
#     Blocks Bash containing `git push` or `gh pr create` when
#     .post-checkpoint-required exists AND .post-checkpoint-done missing/empty.
#     Allowed pushes clean all 4 markers (task complete).
#
# .post-checkpoint-required is armed on every allowed write that passed the
# pre-gate (idempotent touch). Allowlist: Bash commands referencing
# .pre-checkpoint-done or .post-checkpoint-done pass through (deadlock
# prevention — same pattern as plan-gate.sh's rm allowlist).

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

MARKER_DIR="$CWD/.claude"
PRE_REQ="$MARKER_DIR/.checkpoint-required"
PRE_DONE="$MARKER_DIR/.pre-checkpoint-done"
POST_REQ="$MARKER_DIR/.post-checkpoint-required"
POST_DONE="$MARKER_DIR/.post-checkpoint-done"

# Read-only tools — always allowed
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|mcp__*)
    exit 0
    ;;
esac

# Allowlist: Bash referencing checkpoint-done markers (deadlock prevention).
# AI must be able to write Rule 18 checkpoint text into these markers.
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  if echo "$COMMAND" | grep -qE '\.(pre|post)-checkpoint-done'; then
    exit 0
  fi
fi

# Pre-checkpoint gate
if [ -f "$PRE_REQ" ] && [ ! -s "$PRE_DONE" ]; then
  echo '{"decision": "block", "reason": "Checkpoint required. Write the Rule 18 pre-implementation checkpoint block to .claude/.pre-checkpoint-done (must be non-empty) before write tools are unblocked. Hook: checkpoint-gate.sh."}'
  exit 0
fi

# Push gate
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  if echo "$COMMAND" | grep -qE '(^|[[:space:]&;|()])(git[[:space:]]+([^&;|]*[[:space:]])?push|gh[[:space:]]+pr[[:space:]]+create)([[:space:]&;|()]|$)'; then
    if [ -f "$POST_REQ" ] && [ ! -s "$POST_DONE" ]; then
      echo '{"decision": "block", "reason": "Post-implementation checkpoint required. Complete E2E testing and bug logging, then write the Rule 18 post-implementation checkpoint block to .claude/.post-checkpoint-done (must be non-empty) before pushing. Hook: checkpoint-gate.sh."}'
      exit 0
    fi
    rm -f "$PRE_REQ" "$PRE_DONE" "$POST_REQ" "$POST_DONE" 2>/dev/null || true
    exit 0
  fi
fi

# Allowed write — arm post-tracking if pre-checkpoint was satisfied
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|Bash|NotebookEdit)
    if [ -f "$PRE_REQ" ] && [ -s "$PRE_DONE" ]; then
      mkdir -p "$MARKER_DIR" 2>/dev/null || true
      touch "$POST_REQ" 2>/dev/null || true
    fi
    ;;
esac

exit 0
