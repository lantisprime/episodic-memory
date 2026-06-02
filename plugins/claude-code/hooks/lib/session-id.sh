#!/usr/bin/env bash
# session-id.sh — Shared session-id validation (shell parity with
# scripts/lib/session-id.mjs).
#
# Extracted for #268 fix. Sourced by hooks/plan-gate.sh,
# hooks/checkpoint-gate.sh, and any future hook reading
# .session_id from PreToolUse / SessionEnd / SessionStart stdin.
#
# Char-class: [A-Za-z0-9_-], length 1..128. No dots, no slashes.
# Drift between this and session-id.mjs caught by
# scripts/validate-plan-marker-sites.mjs Direction 0.

readonly SESSION_ID_CHARCLASS='A-Za-z0-9_-'
readonly SESSION_ID_MIN_LEN=1
readonly SESSION_ID_MAX_LEN=128

# validate_session_id <sid>
# Returns 0 (true) iff sid matches /^[A-Za-z0-9_-]{1,128}$/.
# Use BEFORE constructing per-session marker paths in any hook.
validate_session_id() {
  local sid="$1"
  [ -z "$sid" ] && return 1
  [ "${#sid}" -lt "$SESSION_ID_MIN_LEN" ] && return 1
  [ "${#sid}" -gt "$SESSION_ID_MAX_LEN" ] && return 1
  case "$sid" in
    *[!A-Za-z0-9_-]*) return 1 ;;
  esac
  return 0
}
