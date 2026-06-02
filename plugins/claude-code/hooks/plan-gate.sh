#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-13.1
# plan-gate.sh — PreToolUse hook
#
# Blocks write tools while a plan-approval marker exists for the current
# session (per-session basename `.plan-approval-pending.<session_id>`) OR
# while the legacy suffix-less `.plan-approval-pending` exists (burn-in
# carry-forward). Read-only tools are always allowed.
#
# 2026-05-13 #268 fix: per-session namespaced markers.
#   - Each session's plan-approval state lives at
#       <root>/.checkpoints/.plan-approval-pending.<own-session-id>
#   - One session's orphan no longer blocks unrelated sessions
#   - Legacy suffix-less form still recognized for burn-in compat
#   - F14 fail-CLOSED on missing/empty/invalid session_id IF any plan
#     marker exists (runtime probe-drift threat is distinct from
#     honest-agent forgery threat — see plan v6 §2)
#
# 2026-05-09 .checkpoints/ migration: marker WRITES go to
# <repo-root>/.checkpoints/ via hooks/lib/marker-paths.sh; READS check
# .checkpoints/ first then fall back to .claude/ until burn-in completes.
# Marker REMOVAL is allowed at EITHER path during burn-in.
#
# Bash classification uses hooks/lib/command-classifier.sh.
#
# Allowlist (while a plan-marker exists):
#   - Read-only tools (always)
#   - Bash with classifier label `read_only`
#   - Bash that classifies as `marker_write` whose TARGET basename
#     matches plan_marker_basename_matches AND lives at primary or
#     legacy marker dir (deadlock prevention — plan marker rm/touch).

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
MY_SID="$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)"
# PR-A P1.1: empty OR relative .cwd falls back to hook process cwd. Parity
# with checkpoint-gate.sh:56-59 PR #347 R7/P1 cwd-binding defense — relative
# .cwd would otherwise propagate through resolve_repo_root → wrong REPO_ROOT,
# and downstream classify_command's caller-cwd-authoritative would be
# non-absolute (breaking marker-cache lookups). Both empty AND non-absolute
# trigger the fallback.
case "$CWD" in
  /*) ;;
  *)  CWD="$(pwd)" ;;
esac

# Source classifier + repo-root resolver + marker paths + session-id.
# Use BASH_SOURCE so symlinked hook invocations resolve correctly.
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ] || [ ! -f "$LIB_DIR/marker-paths.sh" ] || [ ! -f "$LIB_DIR/session-id.sh" ]; then
  echo '{"decision": "block", "reason": "plan-gate.sh: hooks/lib/ not found alongside hook (need command-classifier.sh, repo-root.sh, marker-paths.sh, session-id.sh). Re-run install.mjs --install-hooks."}'
  exit 0
fi
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/marker-paths.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/session-id.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"

# Path resolution for marker variants:
#   LEGACY_PRIMARY: <root>/.checkpoints/.plan-approval-pending      (no sid)
#   LEGACY_LEGACY:  <root>/.claude/.plan-approval-pending           (no sid, fallback root)
#   SUFFIXED_PRIMARY (when sid valid): <root>/.checkpoints/.plan-approval-pending.<sid>
#   SUFFIXED_LEGACY  (when sid valid): <root>/.claude/.plan-approval-pending.<sid>
PLAN_PENDING_W="$(write_marker_path "$REPO_ROOT" "$PLAN_MARKER_LEGACY_BASENAME")"
LEGACY_PRIMARY="$REPO_ROOT/$PRIMARY_MARKER_DIR/$PLAN_MARKER_LEGACY_BASENAME"
LEGACY_LEGACY="$REPO_ROOT/$LEGACY_MARKER_DIR/$PLAN_MARKER_LEGACY_BASENAME"

SID_VALID=false
SUFFIXED_PRIMARY=""
SUFFIXED_LEGACY=""
if validate_session_id "$MY_SID"; then
  SID_VALID=true
  SUFFIXED_PRIMARY="$REPO_ROOT/$PRIMARY_MARKER_DIR/$(plan_marker_basename_for_session "$MY_SID")"
  SUFFIXED_LEGACY="$REPO_ROOT/$LEGACY_MARKER_DIR/$(plan_marker_basename_for_session "$MY_SID")"
fi

# any_plan_marker_exists is sourced from hooks/lib/marker-paths.sh. It takes
# <repo-root> as a positional arg (was previously inlined here with implicit
# REPO_ROOT capture). Rule 14 drift fix — single definition shared with
# checkpoint-gate.sh. Local wrapper retained so existing call-sites read the
# same way and don't need to thread REPO_ROOT each time.
_any_plan_marker_exists_local() {
  any_plan_marker_exists "$REPO_ROOT"
}

# Read-only tools — always allowed (planning needs them).
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# F14 fail-closed: invalid/missing/empty session_id is a probe-drift threat
# distinct from honest-agent forgery. If ANY plan marker exists, BLOCK with
# a clear reason — the agent must either provide a valid session_id in
# stdin (Claude Code does this by default) or clear the marker via
# plan-marker.mjs --rm.
if ! $SID_VALID; then
  if _any_plan_marker_exists_local; then
    jq -nc --arg path "$PLAN_PENDING_W" \
      '{decision: "block", reason: ("Plan approval pending; session_id missing/invalid in PreToolUse stdin — failing closed. Provide a valid session_id (PreToolUse JSON .session_id field) or clear the marker at " + $path + ". Hook: plan-gate.sh.")}'
    exit 0
  fi
  # No plan marker exists → no plan to gate. Allow as today.
  exit 0
fi

# SID_VALID: check own-session OR legacy.
OWN_MARKER_EXISTS=false
if [ -e "$SUFFIXED_PRIMARY" ] || [ -e "$SUFFIXED_LEGACY" ]; then
  OWN_MARKER_EXISTS=true
fi
LEGACY_MARKER_EXISTS=false
if [ -e "$LEGACY_PRIMARY" ] || [ -e "$LEGACY_LEGACY" ]; then
  LEGACY_MARKER_EXISTS=true
fi

# No own marker AND no legacy marker → allow.
# (Other sessions' suffixed markers `.plan-approval-pending.OTHER_SID`
#  are intentionally ignored — that's the #268 fix.)
if ! $OWN_MARKER_EXISTS && ! $LEGACY_MARKER_EXISTS; then
  exit 0
fi

# Classifier-driven Bash gating
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  # PR-A P1.1: thread parsed .cwd (absolute-normalized above) as authoritative
  # caller cwd. See checkpoint-gate.sh:662 for rationale + codex R1 P1 evidence.
  RESULT="$(classify_command "$COMMAND" "$REPO_ROOT" "$CWD")"
  LABEL="${RESULT%%	*}"
  REST="${RESULT#*	}"
  TARGET="${REST%%	*}"

  case "$LABEL" in
    read_only)
      exit 0
      ;;
    marker_write)
      # Allow plan-marker rm/touch under primary or legacy marker dir, but
      # ONLY for THIS session's basename (legacy suffix-less OR
      # `.plan-approval-pending.<MY_SID>`). Other-session suffixed forms
      # are NOT allowed — that's the codex r1 BLOCKER-B1 fix: without this
      # narrowing, session A could `rm` session B's marker via direct Bash.
      target_basename="${TARGET##*/}"
      target_dir="${TARGET%/*}"
      own_session_basename="$(plan_marker_basename_for_session "$MY_SID")"
      if [ "$target_basename" = "$PLAN_MARKER_LEGACY_BASENAME" ] || [ "$target_basename" = "$own_session_basename" ]; then
        if [ "$target_dir" = "$REPO_ROOT/$PRIMARY_MARKER_DIR" ] || [ "$target_dir" = "$REPO_ROOT/$LEGACY_MARKER_DIR" ]; then
          exit 0
        fi
      fi
      ;;
  esac
fi

# Marker exists (own session or legacy) — block.
jq -nc --arg path "$PLAN_PENDING_W" \
  '{decision: "block", reason: ("Plan approval pending. Review the plan above and approve before implementation. To approve, say \"go\" or \"approved\". The " + $path + " marker will be removed and implementation will proceed.")}'
