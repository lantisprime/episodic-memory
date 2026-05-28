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
# Seven markers in migration scope:
#
#   Marker name                    | Set membership
#   ---                            | ---
#   .checkpoint-required           | TASK_SIGNAL + CHECKPOINT_CLEANUP
#   .post-checkpoint-required      | TASK_SIGNAL + CHECKPOINT_CLEANUP
#   .plan-approval-pending         | TASK_SIGNAL only (not cleared by push)
#   .plan-approved                 | ALL_MIGRATED only — own-session cleanup
#                                    (approval token; consumed at arm, one-shot).
#                                    Deliberately NOT in CHECKPOINT_CLEANUP: the
#                                    push sweep globs all sessions' suffixed
#                                    forms, which would delete a CONCURRENT
#                                    session's live token and skip its
#                                    pre-checkpoint (review F1).
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
#                               Mirrors prior checkpoint-gate.sh:200. (.plan-approved
#                               intentionally excluded — see review F1.)
#   ALL_MIGRATED_MARKERS        7 names — full migration scope used by
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
# satisfied the post-checkpoint. The push sweep glob-deletes ALL sessions'
# suffixed forms — convergence semantics for the quartet. .plan-approval-pending
# is NOT here (plan-gate owns it). .plan-approved is NOT here either (review F1):
# it is the per-session authorization-to-arm token, so cross-session glob-
# deletion would skip a concurrent session's pre-checkpoint. It is consumed at
# arm in the normal flow; own-session orphans are cleaned at SessionEnd.
CHECKPOINT_CLEANUP_MARKERS=(
  ".checkpoint-required"
  ".pre-checkpoint-done"
  ".post-checkpoint-required"
  ".post-checkpoint-done"
)

# Full migration scope = task-signal + approval token + done markers +
# baseline = 7 names. Used by sweep tools and tests to validate completeness.
ALL_MIGRATED_MARKERS=(
  ".checkpoint-required"
  ".post-checkpoint-required"
  ".plan-approval-pending"
  ".plan-approved"
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
#
# Parent-dir symlink rejection (codex round 4 P1, #364): the primary marker
# directory MUST be a real directory, never a symlink. Pattern matches the
# Node-side ensurePrimaryDir + the existing classifier-marker.mjs
# validateMarkerStoreDir precedent. If `.checkpoints/` is already a symlink,
# every subsequent marker write would physically land outside the substrate
# while the gate reports paths inside it.
#
# Returns 0 (idempotent success) when dir is a real directory or was just
# created. Returns 1 (refusal) when dir is a symlink — caller's downstream
# touch will then fail closed under set -e (best-effort `|| true` patterns
# at call sites also limit blast radius).
ensure_primary_dir() {
  local dir="$1/$PRIMARY_MARKER_DIR"
  if [ -L "$dir" ]; then
    # Symlink at marker-dir path — substrate tamper. Unlink the symlink
    # entry (NOT its target; `rm -f` on a symlink path removes the link,
    # not the target file/dir) and recreate as a real directory. Self-
    # healing matches the leaf-symlink handling in
    # _arm_marker_via_touch_safely (checkpoint-gate.sh) and the Node-side
    # ensurePrimaryDir.
    rm -f "$dir" 2>/dev/null
  fi
  mkdir -p "$dir" 2>/dev/null
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

# ---------------------------------------------------------------------------
# Checkpoint-planapproval redesign — `.plan-approved` approval token (shell
# parity for scripts/lib/marker-paths.mjs PLAN_APPROVED_LEGACY_BASENAME).
#
# Per-session form `.plan-approved.<sid>` uses the generic namespaced-marker
# helpers below (namespaced_marker_basename_for_session /
# namespaced_marker_basename_matches / any_namespaced_marker_exists).
# Created by plan-marker.mjs --approve; consumed (one-shot) by
# checkpoint-gate.sh's _arm_checkpoint_required_if_missing. A forged/wrong-root
# `.plan-approved` is INERT (see .mjs note) — not plumbed into wrong-root
# detectors.
# ---------------------------------------------------------------------------
readonly PLAN_APPROVED_LEGACY_BASENAME='.plan-approved'

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

# ---------------------------------------------------------------------------
# Rank-2 (PR for checkpoint-quartet) — generic per-session marker contract
# (shell parity for scripts/lib/marker-paths.mjs namespaced* helpers).
#
# Generic shape: given a `legacyBasename` (e.g. .checkpoint-required), the
# per-session form is `<legacyBasename>.<sid>` where sid matches the
# shared SUFFIX_CHARCLASS + SUFFIX_MAXLEN.
#
# PLAN_MARKER_* and PREFLIGHT_MARKER_* shell constants retained verbatim.
# ---------------------------------------------------------------------------

readonly NAMESPACED_MARKER_SUFFIX_CHARCLASS='A-Za-z0-9_-'
readonly NAMESPACED_MARKER_SUFFIX_MAXLEN=128

# namespaced_marker_basename_matches <legacy-basename> <candidate-basename>
# Strict match — accepts <legacy>, <legacy>.<sid> only. Same rules as
# plan_marker_basename_matches / preflight_marker_basename_matches but
# parameterized over the legacy basename.
namespaced_marker_basename_matches() {
  local legacy="$1" basename="$2"
  [ "$basename" = "$legacy" ] && return 0
  case "$basename" in
    "$legacy".*)
      local suffix="${basename#"$legacy".}"
      [ -z "$suffix" ] && return 1
      [ "${#suffix}" -gt "$NAMESPACED_MARKER_SUFFIX_MAXLEN" ] && return 1
      case "$suffix" in
        *[!A-Za-z0-9_-]*) return 1 ;;
      esac
      return 0
      ;;
    *) return 1 ;;
  esac
}

# namespaced_marker_basename_for_session <legacy-basename> <sid>
# Compose <legacy>.<sid>. Caller MUST validate_session_id before calling.
namespaced_marker_basename_for_session() {
  printf '%s.%s' "$1" "$2"
}

# any_namespaced_marker_exists <repo-root> <legacy-basename>
# True if <legacy> OR any <legacy>.<sid> exists at either primary or
# legacy root. Mirrors any_plan_marker_exists / any_preflight_marker_exists.
any_namespaced_marker_exists() {
  local root="$1" legacy="$2"
  [ -e "$root/$PRIMARY_MARKER_DIR/$legacy" ] && return 0
  [ -e "$root/$LEGACY_MARKER_DIR/$legacy" ] && return 0
  local p
  for p in "$root/$PRIMARY_MARKER_DIR"/"$legacy".*; do
    [ -e "$p" ] || continue
    local bn="${p##*/}"
    namespaced_marker_basename_matches "$legacy" "$bn" && return 0
  done
  for p in "$root/$LEGACY_MARKER_DIR"/"$legacy".*; do
    [ -e "$p" ] || continue
    local bn="${p##*/}"
    namespaced_marker_basename_matches "$legacy" "$bn" && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# Rank-2 — checkpoint quartet constants (shell parity).
#
# The 4 markers whose cross-session bleed motivated this PR.
# Diagnosis: 20260523-080453-diagnosis-multi-session-checkpoint-marke-08ec
# ---------------------------------------------------------------------------

CHECKPOINT_QUARTET=(
  ".checkpoint-required"
  ".post-checkpoint-required"
  ".pre-checkpoint-done"
  ".post-checkpoint-done"
)

# is_checkpoint_quartet_basename <basename>
# True iff $basename is one of the 4 quartet markers in legacy or
# per-session form. O(N) over the 4-member array (cheap).
is_checkpoint_quartet_basename() {
  local basename="$1" m
  for m in "${CHECKPOINT_QUARTET[@]}"; do
    namespaced_marker_basename_matches "$m" "$basename" && return 0
  done
  return 1
}
