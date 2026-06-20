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
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ] || [ ! -f "$LIB_DIR/marker-paths.sh" ] || [ ! -f "$LIB_DIR/session-id.sh" ] || [ ! -f "$LIB_DIR/repo-source.sh" ]; then
  echo '{"decision": "block", "reason": "plan-gate.sh: hooks/lib/ not found alongside hook (need command-classifier.sh, repo-root.sh, marker-paths.sh, session-id.sh, repo-source.sh). Re-run install.mjs --install-hooks."}'
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
# shellcheck disable=SC1091
source "$LIB_DIR/repo-source.sh"

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

# RFC-008 P4a (R3/R5): per-project enforce-config consult — ONE site, placed after
# the read-only allow and BEFORE every plan block path (the F14 fail-closed block
# AND the main block), so active:false silences even the probe-drift defense (there
# is no enforcement to protect when the operator turned plan_approval off).
#
# Spawn the resolver ONLY when a plan marker actually exists — the no-plan common
# path stays pure-bash with zero node spawn. A safe token is matched by EXACT
# STRING EQUALITY (never substring): a diagnostic line that merely CONTAINS
# "silence"/"clamp-off" must NOT unblock. ANY other resolver output — empty,
# non-zero exit (caught by `|| GATE_DISP=""`), garbage, multi-line — leaves
# GATE_DISP unmatched and falls through to the existing block paths (fail-closed,
# B1). A missing enforce-contract.mjs makes `node` exit non-zero → "" → block.
# RFC-008 P4d / Principle 12: the engine installs CO-LOCATED with this gate
# (<project>/.claude/hooks/), never in the global substrate. HOOK_DIR resolved above.
# Global path is a legacy fallback only (fresh P4d installs ship no global engine).
ENFORCE_CONTRACT="$HOOK_DIR/enforce-contract.mjs"
[ -f "$ENFORCE_CONTRACT" ] || ENFORCE_CONTRACT="$HOME/.episodic-memory/scripts/enforce-contract.mjs"
if _any_plan_marker_exists_local; then
  GATE_DISP="$(node "$ENFORCE_CONTRACT" --resolve-gate plan_approval --marker-root "$REPO_ROOT" 2>/dev/null)" || GATE_DISP=""
  if [ "$GATE_DISP" = "silence" ] || [ "$GATE_DISP" = "clamp-off" ]; then
    exit 0
  fi
fi

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

# Classifier-driven gating — gate ONLY a repo-source write (R1/R2/R3).
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  # PR-A P1.1: thread parsed .cwd (absolute-normalized above) as authoritative
  # caller cwd. See checkpoint-gate.sh cwd-binding rationale + codex R1 P1 evidence.
  RESULT="$(classify_command "$COMMAND" "$REPO_ROOT" "$CWD")"
  LABEL="${RESULT%%	*}"
  REST="${RESULT#*	}"
  TARGET="${REST%%	*}"

  # read_only → always allowed (R2 / REQ-6)
  [ "$LABEL" = "read_only" ] && exit 0

  # own-session plan-marker rm/touch → allow (deadlock prevention; unchanged
  # BLOCKER-B1 narrowing — other-session suffixed markers are NOT allowed).
  if [ "$LABEL" = "marker_write" ]; then
    target_basename="${TARGET##*/}"
    target_dir="${TARGET%/*}"
    own_session_basename="$(plan_marker_basename_for_session "$MY_SID")"
    if [ "$target_basename" = "$PLAN_MARKER_LEGACY_BASENAME" ] || [ "$target_basename" = "$own_session_basename" ]; then
      if [ "$target_dir" = "$REPO_ROOT/$PRIMARY_MARKER_DIR" ] || [ "$target_dir" = "$REPO_ROOT/$LEGACY_MARKER_DIR" ]; then
        exit 0
      fi
    fi
  fi

  # Absolute-normalize a relative redirect TARGET against the caller cwd so the
  # predicate localizes it correctly (R3 off-repo redirects).
  case "$TARGET" in /*|"") ;; *) TARGET="$CWD/$TARGET" ;; esac

  # Gate ONLY a repo-source Bash write; nonsrc_write/off-repo/carve-out → allow.
  if ! _tool_targets_repo_source_shared "$REPO_ROOT" "Bash" "$TARGET" "$LABEL"; then
    exit 0
  fi
else
  # Edit/Write/MultiEdit/NotebookEdit
  FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"
  case "$FILE_PATH" in /*|"") ;; *) FILE_PATH="$CWD/$FILE_PATH" ;; esac
  if ! _path_is_repo_source "$REPO_ROOT" "$FILE_PATH"; then
    exit 0
  fi
fi

# Repo-source write while plan approval pending → block (R2). Episodes, non-repo,
# plan files, and reads are not blocked BY THIS gating step. (NF-1: the F14
# invalid-session fail-closed path at plan-gate.sh above is an orthogonal
# security block that does gate Bash em-* under a missing/forged session_id — an
# accepted fail-closed exception; Claude Code always supplies a valid session_id.)
jq -nc --arg path "$PLAN_PENDING_W" \
  '{decision: "block", reason: ("Plan approval pending. Repo-source write blocked until the plan above is approved (say \"go\" or \"approved\"). Non-repo writes, episodes, plan files, and reads are NOT blocked. Marker: " + $path)}'
