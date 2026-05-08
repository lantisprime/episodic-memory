#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-08.1
# checkpoint-gate.sh — RFC-002 Phase 3b PreToolUse hook.
#
# Session 1 rewrite (#86 PR-B / #89 / #101): replaces the regex-based
# marker-write allowlist (lines ~46-117 in the prior version) and the
# git-push / gh-pr-create regex (lines ~125-141) with the shared classifier
# from hooks/lib/command-classifier.sh.
#
# Two gates with shared marker state in <repo-root>/.claude/:
#
#   pre-checkpoint:
#     Blocks Edit/Write/MultiEdit/Bash/NotebookEdit when .checkpoint-required
#     exists AND .pre-checkpoint-done is missing/empty. Activator:
#     em-recall.mjs touches .checkpoint-required when bp-001 violations
#     surface in pre-flight (Phase 3, em-recall.mjs:347-369).
#
#   push-gate:
#     Blocks Bash classified as push_or_pr_create OR shared_write that mutates
#     external GitHub state when .post-checkpoint-required exists AND
#     .post-checkpoint-done is missing/empty. Allowed pushes clean all 4
#     markers (task complete).
#
# .post-checkpoint-required is armed on every allowed write that passed the
# pre-gate (idempotent touch).
#
# Marker-write allowlist (deadlock prevention) is now classifier-driven:
# Bash classified as marker_write whose TARGET is one of the repo-root
# checkpoint markers passes the pre-gate iff:
#   - .pre-checkpoint-done write: requires .checkpoint-required exists AND
#     .pre-checkpoint-done is missing/empty (writing into the gate's expected
#     state, not bypassing it).
#   - .post-checkpoint-done write: requires .post-checkpoint-required exists
#     AND .post-checkpoint-done is missing/empty.
# Cross-gate invariant (Codex ...3503 P1): checkpoint marker writes are
# blocked while the repo-root .plan-approval-pending marker exists. Both
# gates independently enforce the invariant; do not rely on Claude hook
# order.

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

# Source classifier + repo-root resolver. Use BASH_SOURCE for symlink safety.
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ]; then
  echo '{"decision": "block", "reason": "checkpoint-gate.sh: hooks/lib/ not found alongside hook. Re-run install.mjs --install-hooks."}'
  exit 0
fi
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"
MARKER_DIR="$REPO_ROOT/.claude"
PRE_REQ="$MARKER_DIR/.checkpoint-required"
PRE_DONE="$MARKER_DIR/.pre-checkpoint-done"
POST_REQ="$MARKER_DIR/.post-checkpoint-required"
POST_DONE="$MARKER_DIR/.post-checkpoint-done"
PLAN_PENDING="$MARKER_DIR/.plan-approval-pending"

# Read-only tools — always allowed
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# Helper: emit a block decision.
# Reason strings include the ABSOLUTE marker path (#146 B1). Worktree-cwd
# sessions resolve relative paths against the worktree, but markers live at
# the main-repo .claude/. Without the absolute path the agent guesses wrong
# and deadlocks (issue #146 live reproducer comment 4378971459).
_block_pre() {
  jq -nc --arg path "$PRE_DONE" \
    '{decision: "block", reason: ("Checkpoint required. Write the Rule 18 pre-implementation checkpoint block to " + $path + " (must be non-empty) before write tools are unblocked. Hook: checkpoint-gate.sh.")}'
  exit 0
}
_block_post() {
  jq -nc --arg path "$POST_DONE" \
    '{decision: "block", reason: ("Post-implementation checkpoint required. Complete E2E testing and bug logging, then write the Rule 18 post-implementation checkpoint block to " + $path + " (must be non-empty) before pushing. Hook: checkpoint-gate.sh.")}'
  exit 0
}
_block_plan_pending() {
  jq -nc --arg path "$PLAN_PENDING" \
    '{decision: "block", reason: ("Plan approval pending. Checkpoint marker writes are blocked while " + $path + " exists. Approve the plan first. Hook: checkpoint-gate.sh.")}'
  exit 0
}

# ---------------------------------------------------------------------------
# Bash classification — compute label up front for downstream gates.
# ---------------------------------------------------------------------------
LABEL=""
TARGET=""
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  RESULT="$(classify_command "$COMMAND" "$REPO_ROOT")"
  LABEL="${RESULT%%	*}"
  REST="${RESULT#*	}"
  TARGET="${REST%%	*}"

  # Read-only Bash → allow immediately (closes #89).
  if [ "$LABEL" = "read_only" ]; then
    exit 0
  fi

  # marker_write deadlock-prevention allowlist. Only allow when the gate's
  # state expects that specific marker write. All other marker_write Bash
  # falls through to the pre-gate as a normal write.
  if [ "$LABEL" = "marker_write" ]; then
    # Cross-gate invariant: checkpoint marker writes are blocked while
    # .plan-approval-pending exists (Codex ...3503 P1).
    if [ -f "$PLAN_PENDING" ]; then
      if [ "$TARGET" = "$PLAN_PENDING" ]; then
        # Allow plan-marker removal — plan-gate.sh is what cares about this.
        exit 0
      fi
      _block_plan_pending
    fi
    case "$TARGET" in
      "$PRE_DONE")
        if [ -f "$PRE_REQ" ] && [ ! -s "$PRE_DONE" ]; then
          exit 0
        fi
        ;;
      "$POST_DONE")
        if [ -f "$POST_REQ" ] && [ ! -s "$POST_DONE" ]; then
          exit 0
        fi
        ;;
      "$PLAN_PENDING")
        exit 0
        ;;
    esac
    # Did not satisfy a prerequisite — fall through to pre-gate as a normal
    # write. Pre-gate will block if PRE_REQ armed and PRE_DONE empty.
  fi
fi

# ---------------------------------------------------------------------------
# Pre-checkpoint gate
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit)
    # classify_path for Write/Edit/MultiEdit/NotebookEdit
    FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')"
    if [ -n "$FILE_PATH" ]; then
      RESULT="$(classify_path "$FILE_PATH" "$REPO_ROOT")"
      LABEL="${RESULT%%	*}"
      REST="${RESULT#*	}"
      TARGET="${REST%%	*}"
      if [ "$LABEL" = "marker_write" ]; then
        # Cross-gate invariant
        if [ -f "$PLAN_PENDING" ] && [ "$TARGET" != "$PLAN_PENDING" ]; then
          _block_plan_pending
        fi
        case "$TARGET" in
          "$PRE_DONE")
            if [ -f "$PRE_REQ" ] && [ ! -s "$PRE_DONE" ]; then
              exit 0
            fi
            ;;
          "$POST_DONE")
            if [ -f "$POST_REQ" ] && [ ! -s "$POST_DONE" ]; then
              exit 0
            fi
            ;;
          "$PLAN_PENDING")
            exit 0
            ;;
        esac
      fi
    fi
    ;;
esac

if [ -f "$PRE_REQ" ] && [ ! -s "$PRE_DONE" ]; then
  _block_pre
fi

# ---------------------------------------------------------------------------
# Push-gate: only fires for Bash classified as push_or_pr_create.
# ---------------------------------------------------------------------------
if [ "$TOOL_NAME" = "Bash" ] && [ "$LABEL" = "push_or_pr_create" ]; then
  if [ -f "$POST_REQ" ] && [ ! -s "$POST_DONE" ]; then
    _block_post
  fi
  # Audit P1: marker cleanup is gated on plan-gate not pending. PreToolUse
  # hooks run independently; if plan-gate or another PreToolUse hook ALSO
  # blocks this call, we must not have already removed the markers (the
  # tool will not actually run). Cleanup only when plan-gate is clear —
  # in that case, push_or_pr_create has reached the user's intended
  # task-complete moment.
  if [ ! -f "$PLAN_PENDING" ]; then
    rm -f "$PRE_REQ" "$PRE_DONE" "$POST_REQ" "$POST_DONE" 2>/dev/null || true
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Allowed write — arm post-tracking if pre-checkpoint was satisfied
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|Bash|NotebookEdit)
    if [ -f "$PRE_REQ" ] && [ -s "$PRE_DONE" ]; then
      mkdir -p "$MARKER_DIR" 2>/dev/null || true
      touch "$POST_REQ" 2>/dev/null || true
    fi
    ;;
esac

exit 0
