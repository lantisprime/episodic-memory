#!/usr/bin/env bash
set -e

# plan-gate.sh — PreToolUse hook
#
# Blocks write tools while .claude/.plan-approval-pending exists in the
# repo root. Read-only tools are always allowed (planning needs them).
#
# Bash classification uses hooks/lib/command-classifier.sh (Session 1,
# closes #86 PR-B). Replaces the prior regex-based marker-rm allowlist
# with a quote/heredoc-aware classifier so quoted body text containing
# `gh pr create` or `.plan-approval-pending` does not false-positive
# (the `...a1e0` shape).
#
# Allowlist:
#   - Read-only tools (always)
#   - Bash with classifier label `read_only` (#89: ls, cat, git status, etc.)
#   - Bash that classifies as `marker_write` whose TARGET is exactly
#     repo-root .claude/.plan-approval-pending (deadlock prevention).
#     Codex review ...3503: plan marker REMOVAL is the only plan-gate marker
#     action allowed; checkpoint pre/post writes are NOT allowed by plan-gate.
#
# All other tool calls block while the marker exists.

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

# Source classifier + repo-root resolver. Use BASH_SOURCE so symlinked hook
# invocations resolve correctly (Codex ...3503: $(dirname "$0") breaks under
# macOS without coreutils readlink -f).
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ]; then
  # Lib missing — fail loud rather than silently allowing
  echo '{"decision": "block", "reason": "plan-gate.sh: hooks/lib/ not found alongside hook. Re-run install.mjs --install-hooks."}'
  exit 0
fi
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"
MARKER="$REPO_ROOT/.claude/.plan-approval-pending"
EXPECTED_MARKER_ABS="$MARKER"

# Read-only tools — always allowed.
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# If no marker, allow everything
[ ! -f "$MARKER" ] && exit 0

# Classifier-driven Bash gating
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  RESULT="$(classify_command "$COMMAND" "$REPO_ROOT")"
  LABEL="${RESULT%%	*}"
  REST="${RESULT#*	}"
  TARGET="${REST%%	*}"

  case "$LABEL" in
    read_only)
      # #89 fix: read-only Bash should not be blocked while planning.
      exit 0
      ;;
    marker_write)
      # Only allow exact removal of the plan-approval marker.
      # Codex ...3503 P1: target must equal repo-root .plan-approval-pending,
      # not any other marker. Path traversal / symlink / cwd≠repo blocked
      # by the equality check against the resolved repo-root path.
      if [ "$TARGET" = "$EXPECTED_MARKER_ABS" ]; then
        exit 0
      fi
      ;;
  esac
fi

# Marker exists — block
echo '{"decision": "block", "reason": "Plan approval pending. Review the plan above and approve before implementation. To approve, say \"go\" or \"approved\". The .claude/.plan-approval-pending marker will be removed and implementation will proceed."}'
