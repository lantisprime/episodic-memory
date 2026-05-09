#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-09.1
# plan-gate.sh — PreToolUse hook
#
# Blocks write tools while .plan-approval-pending exists (at either root)
# in the repo root. Read-only tools are always allowed (planning needs them).
#
# 2026-05-09 .checkpoints/ migration: marker WRITES go to
# <repo-root>/.checkpoints/ via hooks/lib/marker-paths.sh; READS check
# .checkpoints/ first then fall back to .claude/ until burn-in completes.
# Marker REMOVAL is allowed at EITHER path during burn-in.
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
#   - Bash that classifies as `marker_write` whose TARGET basename is
#     .plan-approval-pending under either marker dir (deadlock prevention).
#     Codex review ...3503: plan marker REMOVAL is the only plan-gate marker
#     action allowed; checkpoint pre/post writes are NOT allowed by plan-gate.
#
# All other tool calls block while the marker exists.

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

# Source classifier + repo-root resolver + marker paths. Use BASH_SOURCE so
# symlinked hook invocations resolve correctly (Codex ...3503: $(dirname
# "$0") breaks under macOS without coreutils readlink -f).
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ] || [ ! -f "$LIB_DIR/marker-paths.sh" ]; then
  # Lib missing — fail loud rather than silently allowing
  echo '{"decision": "block", "reason": "plan-gate.sh: hooks/lib/ not found alongside hook (need command-classifier.sh, repo-root.sh, marker-paths.sh). Re-run install.mjs --install-hooks."}'
  exit 0
fi
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/marker-paths.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"

# Canonical write path (always primary). Used in the block-message reason
# so the agent knows where to put a fresh marker if needed.
PLAN_PENDING_W="$(write_marker_path "$REPO_ROOT" .plan-approval-pending)"
PRIMARY_PATH="$REPO_ROOT/$PRIMARY_MARKER_DIR/.plan-approval-pending"
LEGACY_PATH="$REPO_ROOT/$LEGACY_MARKER_DIR/.plan-approval-pending"

# Read-only tools — always allowed.
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# If no marker at either root, allow everything.
if [ ! -e "$PRIMARY_PATH" ] && [ ! -e "$LEGACY_PATH" ]; then
  exit 0
fi

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
      # Only allow exact removal/touch of the plan-approval marker at either
      # root. Codex ...3503 P1: TARGET must equal one of the two marker
      # paths, not any other marker. Path traversal / symlink / cwd≠repo
      # blocked by the equality check against the resolved repo-root paths.
      #
      # Dual-root acceptance during burn-in: legacy `.claude/` rm targets
      # are still allowed so cleanup of orphan markers works without flag
      # changes.
      if [ "$TARGET" = "$PRIMARY_PATH" ] || [ "$TARGET" = "$LEGACY_PATH" ]; then
        exit 0
      fi
      ;;
  esac
fi

# Marker exists — block.
jq -nc --arg path "$PLAN_PENDING_W" \
  '{decision: "block", reason: ("Plan approval pending. Review the plan above and approve before implementation. To approve, say \"go\" or \"approved\". The " + $path + " marker will be removed and implementation will proceed.")}'
