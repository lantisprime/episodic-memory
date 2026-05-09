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
# Six markers in scope (5 task-signal + 1 baseline):
#   .checkpoint-required          (activator, armed by em-recall.mjs)
#   .post-checkpoint-required     (activator, armed by checkpoint-gate.sh)
#   .plan-approval-pending        (Rule 8 plan-approval gate)
#   .pre-checkpoint-done          (Rule 18 pre-impl checkpoint)
#   .post-checkpoint-done         (Rule 18 post-impl checkpoint)
#   .session-baseline             (stop-gate carve-out reference mtime)
#
# Codex round-2 ACCEPT (episode 20260509-044331-...-bc1c) per plan v3 §B.

PRIMARY_MARKER_DIR=".checkpoints"
LEGACY_MARKER_DIR=".claude"
BASELINE_NAME=".session-baseline"

# Task-signal markers (per em-recall.mjs:97-101 + the two -done markers).
# Used by stop-gate carve-out, push cleanup, SessionStart orphan-clear.
# Bash 3.2 indexed array (no associative arrays per macOS portability lesson
# 20260508-021131).
TASK_SIGNAL_MARKERS=(
  ".checkpoint-required"
  ".post-checkpoint-required"
  ".plan-approval-pending"
  ".pre-checkpoint-done"
  ".post-checkpoint-done"
)

# All migrated markers = task-signal + baseline.
ALL_MARKERS=(
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
