#!/usr/bin/env bash
set -e

# plan-gate.sh — PreToolUse hook
# Blocks write tools while .claude/.plan-approval-pending exists in the project.
# Read-only tools are always allowed (needed for planning).

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

MARKER="$CWD/.claude/.plan-approval-pending"

# Read-only tools — always allowed.
# NotebookRead and ToolSearch added per issue #86 (PR-A): both are read-only /
# planning traffic and were empirically blocked while a plan-approval marker
# was set. BashOutput / KillBash are intentionally NOT on this list pending a
# follow-up evaluation — KillBash mutates process state.
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# If no marker, allow everything
[ ! -f "$MARKER" ] && exit 0

# Allow the specific command that removes the marker (unblock after approval)
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  if echo "$COMMAND" | grep -qE '^rm\s+.*\.plan-approval-pending'; then
    exit 0
  fi
fi

# Marker exists — block write tools
echo '{"decision": "block", "reason": "Plan approval pending. Review the plan above and approve before implementation. To approve, say \"go\" or \"approved\". The .claude/.plan-approval-pending marker will be removed and implementation will proceed."}'
