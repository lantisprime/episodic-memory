#!/usr/bin/env bash
# render-input-validation.sh — sourceable validator for installer render inputs.
#
# This is a DENY-LIST validator (not a strict allowlist). It rejects the four
# characters that would break sed `s|@…@|…|g` substitution with `|` delimiter:
#   |  (delimiter collision)
#   \  (escape sequence)
#   &  (sed back-reference)
#   \n (sed pattern-space terminator)
#
# Other shell-sensitive characters (`"`, `$`, backtick, `;`, etc.) are NOT
# rejected. The current production inputs (paths under /Users/.../) cannot
# contain them, but a hostile caller controlling CLAUDE_BIN or PROJECT_DIR
# could in principle inject shell metacharacters into the rendered wrapper.
# That's an out-of-scope threat model for a user-run installer; callers who
# need defense against it should switch to a generated wrapper that uses
# `printf '%q'` quoting rather than raw sed substitution.
#
# Usage:
#   source scripts/lib/render-input-validation.sh
#   CLAUDE_BIN=... PROJECT_DIR=... validate_render_inputs
#   # returns 0 on safe input, 9 on rejection (prints reason to stderr)

validate_render_inputs() {
  local var val
  for var in CLAUDE_BIN PROJECT_DIR; do
    val="${!var}"
    case "$val" in
      *'|'*|*'\'*|*'&'*|*$'\n'*)
        echo "ERROR: $var contains sed-unsafe character (|, \\, &, or newline): $val" >&2
        echo "       Refusing to render wrapper template with unsafe substitution." >&2
        return 9
        ;;
    esac
  done
  return 0
}
