#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-09.1
# marker-paths.sh — Shared marker-path constants and helpers.
#
# Mirrors scripts/lib/marker-paths.mjs (single source of truth split for
# shell/node parity). Source from a hook and call the helpers below.
#
# Background: Claude Code's built-in sensitive-file guard prompts on Write
# to any basename matching `.X` inside a `.claude/` segment, regardless of
# allowlist. To escape the prompt, marker writes go to a sibling
# `.checkpoints/` directory. Reads honor both during burn-in (primary
# `.checkpoints/` first, fallback `.claude/` second) until the legacy
# branch is removed in a follow-up commit.
#
# Six markers in migration scope:
#
#   Marker name                    | Set membership
#   ---                            | ---
#   .checkpoint-required           | TASK_SIGNAL + CHECKPOINT_CLEANUP
#   .post-checkpoint-required      | TASK_SIGNAL + CHECKPOINT_CLEANUP
#   .plan-approval-pending         | TASK_SIGNAL only (not cleared by push)
#   .pre-checkpoint-done           | CHECKPOINT_CLEANUP only
#   .post-checkpoint-done          | CHECKPOINT_CLEANUP only
#   .session-baseline              | BASELINE only
#
# Adjacent UX-marker classes (NOT in any of the above sets):
#
#   .so-runbook-shown.<sha8>       | UX-marker only — tracks "model has been
#                                    shown the second-opinion harness runbook
#                                    this session." Excluded from TASK_SIGNAL
#                                    (would break stop-gate carve-out per
#                                    20260512-...d4fc) AND from CHECKPOINT_CLEANUP
#                                    (push-gate shouldn't clear it; session
#                                    lifecycle via SessionStart glob is the
#                                    only cleanup path). Recognized by the
#                                    classifier marker_write handlers (touch/
#                                    rm/tee/redirect) and by checkpoint-gate's
#                                    runbook exemption case.
#
# Set semantics:
#   TASK_SIGNAL_MARKERS         3 markers — em-recall stop-gate carve-out
#                               class (mid-session mtime > baseline = task
#                               work in progress). Mirrors em-recall.mjs:97.
#   CHECKPOINT_CLEANUP_MARKERS  4 markers — push-gate clears on successful
#                               push (Codex round-1 F2: must sweep BOTH
#                               .checkpoints/ AND .claude/ during burn-in).
#                               Mirrors prior checkpoint-gate.sh:200.
#   ALL_MIGRATED_MARKERS        6 names — full migration scope used by
#                               tests, sweep tools, and SessionEnd cleanup.
#
# Codex round-2 ACCEPT (episode 20260509-044331-...-bc1c) per plan v3 §B.

PRIMARY_MARKER_DIR=".checkpoints"
LEGACY_MARKER_DIR=".claude"
BASELINE_NAME=".session-baseline"

# Task-signal markers — em-recall stop-gate carve-out class. Mirrors
# em-recall.mjs:97-101 (TASK_SIGNAL_MARKERS in JS). Bash 3.2 indexed array
# (no associative arrays per macOS portability lesson 20260508-021131).
TASK_SIGNAL_MARKERS=(
  ".checkpoint-required"
  ".post-checkpoint-required"
  ".plan-approval-pending"
)

# Push-gate cleanup class — markers cleared on a successful push that has
# satisfied the post-checkpoint. .plan-approval-pending is intentionally
# NOT here (its lifecycle is plan-gate's marker_write allowance, not
# checkpoint cleanup). Mirrors the prior checkpoint-gate.sh:200 list.
CHECKPOINT_CLEANUP_MARKERS=(
  ".checkpoint-required"
  ".pre-checkpoint-done"
  ".post-checkpoint-required"
  ".post-checkpoint-done"
)

# Full migration scope = task-signal + done markers + baseline = 6 names.
# Used by sweep tools and tests to validate completeness.
ALL_MIGRATED_MARKERS=(
  ".checkpoint-required"
  ".post-checkpoint-required"
  ".plan-approval-pending"
  ".pre-checkpoint-done"
  ".post-checkpoint-done"
  ".session-baseline"
)

# primary_marker_path <repo-root> <basename> → echoes <root>/.checkpoints/<basename>
primary_marker_path() {
  printf '%s/%s/%s' "$1" "$PRIMARY_MARKER_DIR" "$2"
}

# legacy_marker_path <repo-root> <basename> → echoes <root>/.claude/<basename>
legacy_marker_path() {
  printf '%s/%s/%s' "$1" "$LEGACY_MARKER_DIR" "$2"
}

# resolve_marker_read <repo-root> <basename> → echoes the primary path if it
# exists, otherwise the legacy path if it exists, otherwise nothing (exit 1).
# Used by readers that need a single-path semantic (e.g. `[ -s ]` checks).
# Symlink-aware via -e (test against the link target). Callers that need
# symlink-fail-closed semantics must re-check with lstat-equivalent (`[ -L ]`).
resolve_marker_read() {
  local primary legacy
  primary="$(primary_marker_path "$1" "$2")"
  legacy="$(legacy_marker_path "$1" "$2")"
  if [ -e "$primary" ]; then
    printf '%s' "$primary"
    return 0
  fi
  if [ -e "$legacy" ]; then
    printf '%s' "$legacy"
    return 0
  fi
  return 1
}

# write_marker_path <repo-root> <basename> → echoes the primary path (always).
# Use this for ALL writes. The legacy branch is read-only during burn-in.
write_marker_path() {
  primary_marker_path "$1" "$2"
}

# both_marker_paths <repo-root> <basename> → echoes primary then legacy on
# separate lines. Use for cleanup (rm both) and orphan-clear sweeps that must
# touch both roots until fallback removal.
both_marker_paths() {
  primary_marker_path "$1" "$2"
  printf '\n'
  legacy_marker_path "$1" "$2"
  printf '\n'
}

# ensure_primary_dir <repo-root> → mkdir -p the primary marker directory.
# Idempotent. Used before write_marker_path writes.
ensure_primary_dir() {
  mkdir -p "$1/$PRIMARY_MARKER_DIR" 2>/dev/null
}

# ---------------------------------------------------------------------------
# #268 fix — per-session .plan-approval-pending marker contract.
#
# Shell parity for scripts/lib/marker-paths.mjs PLAN_MARKER_*. Drift caught
# by scripts/validate-plan-marker-sites.mjs Direction 0.
# ---------------------------------------------------------------------------

readonly PLAN_MARKER_LEGACY_BASENAME='.plan-approval-pending'
readonly PLAN_MARKER_BASENAME_GLOB='.plan-approval-pending*'       # bash case glob (loose; for routing)
readonly PLAN_MARKER_SUFFIX_CHARCLASS='A-Za-z0-9_-'
readonly PLAN_MARKER_SUFFIX_MAXLEN=128
readonly PLAN_MARKER_BASENAME_GREP_PATTERN='\.plan-approval-pending(\.[A-Za-z0-9_-]{1,128})?'

# plan_marker_basename_matches <basename>
# Strict match. Accepts ONLY:
#   .plan-approval-pending                          (legacy suffix-less)
#   .plan-approval-pending.<sid>                    (sid matches char-class + length)
# Rejects:
#   .plan-approval-pending-extra                    (suffix without dot separator)
#   .plan-approval-pending.                         (empty suffix)
#   .plan-approval-pending./traversal               (slash in suffix)
#   .plan-approval-pending..                        (dot in suffix)
#   .plan-approval-pending.<129-char>               (oversize suffix)
#
# Used by checkpoint-gate's marker_basename_for_target equality refinement
# and plan-gate's existence check (defense in depth — shell-case sites use
# loose glob for routing, then this strict helper for validation).
plan_marker_basename_matches() {
  local basename="$1"
  case "$basename" in
    .plan-approval-pending) return 0 ;;
    .plan-approval-pending.*)
      local suffix="${basename#.plan-approval-pending.}"
      [ -z "$suffix" ] && return 1
      [ "${#suffix}" -gt "$PLAN_MARKER_SUFFIX_MAXLEN" ] && return 1
      case "$suffix" in
        *[!A-Za-z0-9_-]*) return 1 ;;
      esac
      return 0
      ;;
    *) return 1 ;;
  esac
}

# plan_marker_basename_for_session <sid>
# Compose the per-session marker basename. Caller MUST validate_session_id
# (from hooks/lib/session-id.sh) BEFORE calling this; not re-validated here.
plan_marker_basename_for_session() {
  printf '.plan-approval-pending.%s' "$1"
}

# any_plan_marker_exists <repo-root>
# True if ANY plan-approval marker (legacy suffix-less OR any suffixed form)
# exists at either primary or legacy marker dir under <repo-root>. Used by:
#   - plan-gate.sh F14 fail-closed-on-invalid-sid decision
#   - checkpoint-gate.sh probe-drift defense + plan_pending_blocks_this_session
# Per-Rule-14 drift risk: previously duplicated across both gates with
# identical body; centralized here so future surface additions (new plan
# marker basenames, new root dirs) land in one place.
any_plan_marker_exists() {
  local root="$1"
  [ -e "$root/$PRIMARY_MARKER_DIR/$PLAN_MARKER_LEGACY_BASENAME" ] && return 0
  [ -e "$root/$LEGACY_MARKER_DIR/$PLAN_MARKER_LEGACY_BASENAME" ] && return 0
  local p
  for p in "$root/$PRIMARY_MARKER_DIR"/.plan-approval-pending.*; do
    [ -e "$p" ] && return 0
  done
  for p in "$root/$LEGACY_MARKER_DIR"/.plan-approval-pending.*; do
    [ -e "$p" ] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# #279 fix — per-session .preflight-done marker contract.
#
# Shell parity for scripts/lib/marker-paths.mjs PREFLIGHT_MARKER_*. Sibling
# of PLAN_MARKER_* (#268 / PR #271). Drift detection extension to
# scripts/validate-plan-marker-sites.mjs for PREFLIGHT_* constants is FU —
# see issue #283 (validator currently covers PLAN_MARKER_* only).
# ---------------------------------------------------------------------------

readonly PREFLIGHT_MARKER_LEGACY_BASENAME='.preflight-done'
readonly PREFLIGHT_MARKER_BASENAME_GLOB='.preflight-done*'             # bash case glob (loose; for routing)
readonly PREFLIGHT_MARKER_SUFFIX_CHARCLASS='A-Za-z0-9_-'
readonly PREFLIGHT_MARKER_SUFFIX_MAXLEN=128
readonly PREFLIGHT_MARKER_BASENAME_GREP_PATTERN='\.preflight-done(\.[A-Za-z0-9_-]{1,128})?'

# preflight_marker_basename_matches <basename>
# Strict match. Accepts ONLY:
#   .preflight-done                                 (legacy suffix-less)
#   .preflight-done.<sid>                           (sid matches char-class + length)
# Rejects:
#   .preflight-done-extra                           (suffix without dot separator)
#   .preflight-done.                                (empty suffix)
#   .preflight-done./traversal                      (slash in suffix)
#   .preflight-done..                               (dot in suffix)
#   .preflight-done.<129-char>                      (oversize suffix)
preflight_marker_basename_matches() {
  local basename="$1"
  case "$basename" in
    .preflight-done) return 0 ;;
    .preflight-done.*)
      local suffix="${basename#.preflight-done.}"
      [ -z "$suffix" ] && return 1
      [ "${#suffix}" -gt "$PREFLIGHT_MARKER_SUFFIX_MAXLEN" ] && return 1
      case "$suffix" in
        *[!A-Za-z0-9_-]*) return 1 ;;
      esac
      return 0
      ;;
    *) return 1 ;;
  esac
}

# preflight_marker_basename_for_session <sid>
# Compose the per-session marker basename. Caller MUST validate_session_id
# BEFORE calling this; not re-validated here.
preflight_marker_basename_for_session() {
  printf '.preflight-done.%s' "$1"
}

# any_preflight_marker_exists <repo-root>
# True if ANY preflight-done marker (legacy OR any suffixed form) exists at
# either primary or legacy marker dir under <repo-root>. Used by:
#   - preflight-gate.sh existence check (session-aware after #279 fix)
#   - SessionStart orphan-sweep
any_preflight_marker_exists() {
  local root="$1"
  [ -e "$root/$PRIMARY_MARKER_DIR/$PREFLIGHT_MARKER_LEGACY_BASENAME" ] && return 0
  [ -e "$root/$LEGACY_MARKER_DIR/$PREFLIGHT_MARKER_LEGACY_BASENAME" ] && return 0
  local p
  for p in "$root/$PRIMARY_MARKER_DIR"/.preflight-done.*; do
    [ -e "$p" ] && return 0
  done
  for p in "$root/$LEGACY_MARKER_DIR"/.preflight-done.*; do
    [ -e "$p" ] && return 0
  done
  return 1
}
