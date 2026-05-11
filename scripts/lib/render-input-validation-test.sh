#!/usr/bin/env bash
# Unit tests for validate_render_inputs.
# Covers: 1 safe case × 2 vars + 4 unsafe characters × 2 vars = 9 cases.

set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/render-input-validation.sh"

# --- Positive case ---
CLAUDE_BIN="/usr/local/bin/claude" PROJECT_DIR="/Users/foo/episodic-memory" \
  validate_render_inputs || { echo "FAIL: rejected safe input"; exit 1; }
echo "  ok  safe inputs accepted"

# --- Negative fan-out: each unsafe char × each input var ---
UNSAFE_VALUES=( '/bin/has|pipe' '/bin/has\backslash' '/bin/has&amp' $'/bin/has\nnewline' )
neg_count=0
for unsafe in "${UNSAFE_VALUES[@]}"; do
  if CLAUDE_BIN="$unsafe" PROJECT_DIR=/ok validate_render_inputs 2>/dev/null; then
    echo "FAIL: accepted unsafe CLAUDE_BIN=$(printf '%q' "$unsafe")"; exit 1
  fi
  neg_count=$((neg_count + 1))
  if CLAUDE_BIN=/ok PROJECT_DIR="$unsafe" validate_render_inputs 2>/dev/null; then
    echo "FAIL: accepted unsafe PROJECT_DIR=$(printf '%q' "$unsafe")"; exit 1
  fi
  neg_count=$((neg_count + 1))
done
echo "  ok  $neg_count negative cases (2 vars × 4 unsafe chars) all rejected"

echo "PASS"
