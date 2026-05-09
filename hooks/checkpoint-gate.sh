#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-09.1
# checkpoint-gate.sh — RFC-002 Phase 3b PreToolUse hook.
#
# Session 1 rewrite (#86 PR-B / #89 / #101): replaces the regex-based
# marker-write allowlist (lines ~46-117 in the prior version) and the
# git-push / gh-pr-create regex (lines ~125-141) with the shared classifier
# from hooks/lib/command-classifier.sh.
#
# 2026-05-09 .checkpoints/ migration: marker WRITES now go to
# <repo-root>/.checkpoints/ via hooks/lib/marker-paths.sh, while READS check
# .checkpoints/ first then fall back to .claude/ (until the legacy branch is
# removed in a follow-up commit). CLEANUP sweeps BOTH roots. Closes the
# Claude Code sensitive-file-guard prompt class for marker writes.
#
# Two gates with shared marker state:
#
#   pre-checkpoint:
#     Blocks Edit/Write/MultiEdit/Bash/NotebookEdit when .checkpoint-required
#     exists (either root) AND .pre-checkpoint-done is missing/empty (both
#     roots). Activator: em-recall.mjs touches .checkpoint-required when
#     bp-001 violations surface in pre-flight.
#
#   push-gate:
#     Blocks Bash classified as push_or_pr_create OR shared_write that mutates
#     external GitHub state when .post-checkpoint-required exists (either
#     root) AND .post-checkpoint-done is missing/empty (both roots). Allowed
#     pushes clean all task-signal markers across BOTH roots.
#
# .post-checkpoint-required is armed (always at PRIMARY) on every allowed
# write that passed the pre-gate (idempotent touch).
#
# Marker-write allowlist (deadlock prevention) is classifier-driven:
# Bash classified as marker_write whose TARGET is one of the repo-root
# checkpoint markers AT EITHER ROOT passes the pre-gate iff:
#   - .pre-checkpoint-done write: requires .checkpoint-required exists
#     (either root) AND .pre-checkpoint-done is missing/empty (both roots).
#   - .post-checkpoint-done write: requires .post-checkpoint-required exists
#     AND .post-checkpoint-done is missing/empty.
# Cross-gate invariant (Codex ...3503 P1): checkpoint marker writes are
# blocked while .plan-approval-pending exists (either root). Both gates
# independently enforce.

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

# Source classifier + repo-root resolver + shared marker paths. Use
# BASH_SOURCE for symlink safety.
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ] || [ ! -f "$LIB_DIR/marker-paths.sh" ]; then
  echo '{"decision": "block", "reason": "checkpoint-gate.sh: hooks/lib/ not found alongside hook (need command-classifier.sh, repo-root.sh, marker-paths.sh). Re-run install.mjs --install-hooks."}'
  exit 0
fi
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/marker-paths.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"

# Canonical WRITE paths (always primary). Used in block-message paths so the
# agent knows where to write the checkpoint block.
PRE_DONE_W="$(write_marker_path "$REPO_ROOT" .pre-checkpoint-done)"
POST_DONE_W="$(write_marker_path "$REPO_ROOT" .post-checkpoint-done)"
PLAN_PENDING_W="$(write_marker_path "$REPO_ROOT" .plan-approval-pending)"

PRIMARY_DIR="$REPO_ROOT/$PRIMARY_MARKER_DIR"
LEGACY_DIR="$REPO_ROOT/$LEGACY_MARKER_DIR"

# ---------------------------------------------------------------------------
# Dual-root marker helpers (burn-in only; collapse to primary-only when the
# fallback branch is removed).
# ---------------------------------------------------------------------------
# marker_exists <basename> — true if the marker exists at either root.
marker_exists() {
  [ -e "$PRIMARY_DIR/$1" ] || [ -e "$LEGACY_DIR/$1" ]
}
# marker_nonempty <basename> — true if either root's copy is non-empty.
marker_nonempty() {
  [ -s "$PRIMARY_DIR/$1" ] || [ -s "$LEGACY_DIR/$1" ]
}
# marker_basename_for_target <abs-path> — echoes the basename if the path
# is under either marker dir, else echoes nothing (caller branches on empty).
marker_basename_for_target() {
  local target="$1"
  case "$target" in
    "$PRIMARY_DIR"/*|"$LEGACY_DIR"/*) basename "$target" ;;
    *) printf '' ;;
  esac
}

# Read-only tools — always allowed
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# Helper: emit a block decision.
# Reason strings include the canonical WRITE path (always primary —
# .checkpoints/) so the agent writes to the new location.
_block_pre() {
  jq -nc --arg path "$PRE_DONE_W" \
    '{decision: "block", reason: ("Checkpoint required. Write the Rule 18 pre-implementation checkpoint block to " + $path + " (must be non-empty) before write tools are unblocked. Hook: checkpoint-gate.sh.")}'
  exit 0
}
_block_post() {
  jq -nc --arg path "$POST_DONE_W" \
    '{decision: "block", reason: ("Post-implementation checkpoint required. Complete E2E testing and bug logging, then write the Rule 18 post-implementation checkpoint block to " + $path + " (must be non-empty) before pushing. Hook: checkpoint-gate.sh.")}'
  exit 0
}
_block_plan_pending() {
  jq -nc --arg path "$PLAN_PENDING_W" \
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
  #
  # Dual-root acceptance: TARGET is an absolute path that may point at
  # either .checkpoints/.X (new canonical) or .claude/.X (legacy fallback,
  # tolerated during burn-in for backward compat).
  if [ "$LABEL" = "marker_write" ]; then
    TARGET_BN="$(marker_basename_for_target "$TARGET")"

    # Cross-gate invariant: checkpoint marker writes are blocked while
    # .plan-approval-pending exists (Codex ...3503 P1).
    if marker_exists .plan-approval-pending; then
      if [ "$TARGET_BN" = ".plan-approval-pending" ]; then
        # Allow plan-marker removal — plan-gate.sh is what cares about this.
        exit 0
      fi
      _block_plan_pending
    fi
    case "$TARGET_BN" in
      .pre-checkpoint-done)
        if marker_exists .checkpoint-required && ! marker_nonempty .pre-checkpoint-done; then
          exit 0
        fi
        ;;
      .post-checkpoint-done)
        if marker_exists .post-checkpoint-required && ! marker_nonempty .post-checkpoint-done; then
          exit 0
        fi
        ;;
      .plan-approval-pending)
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
        TARGET_BN="$(marker_basename_for_target "$TARGET")"
        # Cross-gate invariant
        if marker_exists .plan-approval-pending && [ "$TARGET_BN" != ".plan-approval-pending" ]; then
          _block_plan_pending
        fi
        case "$TARGET_BN" in
          .pre-checkpoint-done)
            if marker_exists .checkpoint-required && ! marker_nonempty .pre-checkpoint-done; then
              exit 0
            fi
            ;;
          .post-checkpoint-done)
            if marker_exists .post-checkpoint-required && ! marker_nonempty .post-checkpoint-done; then
              exit 0
            fi
            ;;
          .plan-approval-pending)
            exit 0
            ;;
        esac
      fi
    fi
    ;;
esac

if marker_exists .checkpoint-required && ! marker_nonempty .pre-checkpoint-done; then
  _block_pre
fi

# ---------------------------------------------------------------------------
# Push-gate: only fires for Bash classified as push_or_pr_create.
# ---------------------------------------------------------------------------
if [ "$TOOL_NAME" = "Bash" ] && [ "$LABEL" = "push_or_pr_create" ]; then
  if marker_exists .post-checkpoint-required && ! marker_nonempty .post-checkpoint-done; then
    _block_post
  fi
  # Audit P1: marker cleanup is gated on plan-gate not pending. PreToolUse
  # hooks run independently; if plan-gate or another PreToolUse hook ALSO
  # blocks this call, we must not have already removed the markers (the
  # tool will not actually run). Cleanup only when plan-gate is clear —
  # in that case, push_or_pr_create has reached the user's intended
  # task-complete moment.
  #
  # Dual-root sweep (Codex round-1 F2): rm at BOTH .checkpoints/ and
  # .claude/ until fallback is removed. Iteration over the shared
  # TASK_SIGNAL_MARKERS array keeps the cleanup set in lockstep with the
  # carve-out's marker set in em-recall.mjs.
  if ! marker_exists .plan-approval-pending; then
    for _m in "${CHECKPOINT_CLEANUP_MARKERS[@]}"; do
      rm -f "$PRIMARY_DIR/$_m" "$LEGACY_DIR/$_m" 2>/dev/null || true
    done
    unset _m
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Allowed write — arm post-tracking if pre-checkpoint was satisfied.
# Always armed at PRIMARY (write-side never touches legacy); dual-root
# cleanup later removes both.
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|Bash|NotebookEdit)
    if marker_exists .checkpoint-required && marker_nonempty .pre-checkpoint-done; then
      ensure_primary_dir "$REPO_ROOT" 2>/dev/null || true
      touch "$(write_marker_path "$REPO_ROOT" .post-checkpoint-required)" 2>/dev/null || true
    fi
    ;;
esac

exit 0
