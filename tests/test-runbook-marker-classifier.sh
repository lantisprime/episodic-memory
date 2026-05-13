#!/usr/bin/env bash
# test-runbook-marker-classifier.sh — classifier integration for .so-runbook-shown.*
#
# Verifies:
#   - touch/rm/tee/redirect of .so-runbook-shown.<sha> → marker_write classification
#   - kind suffix matches the operation (touch_marker, rm_marker, tee_marker, redirect_to_marker)
#   - touch of non-marker → shared_write (regression — touch handler must
#     not over-promote)
#   - non-runbook markers continue to classify correctly (no regression on
#     the existing same-class set)

set -euo pipefail

LIB_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../hooks/lib" && pwd)"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"

PASS=0
FAIL=0
FAILED=()

# assert_classify <cmd> <expected-label> <expected-kind-substring>
assert_classify() {
  local cmd="$1" expected_label="$2" expected_kind="$3" name="$4"
  local result label rest kind
  result="$(classify_command "$cmd" "/tmp/fake-repo")"
  label="${result%%	*}"
  rest="${result#*	}"
  kind="${rest##*	}"
  if [ "$label" = "$expected_label" ] && [[ "$kind" == *"$expected_kind"* ]]; then
    PASS=$((PASS+1))
    printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAILED+=("$name: expected=$expected_label/$expected_kind got=$label/$kind")
    printf '  ✗ %s (expected %s/%s, got %s/%s)\n' \
      "$name" "$expected_label" "$expected_kind" "$label" "$kind"
  fi
}

echo "# Runbook marker classification"

# touch handler — new in plan v4.1
assert_classify \
  "touch /tmp/fake-repo/.checkpoints/.so-runbook-shown.deadbeef" \
  "marker_write" "touch_marker" \
  "touch runbook marker → marker_write touch_marker"

assert_classify \
  "touch /tmp/fake-repo/.checkpoints/.so-runbook-shown.abc12345" \
  "marker_write" "touch_marker" \
  "touch runbook marker (different sha) → marker_write touch_marker"

# touch of non-marker — regression guard
assert_classify \
  "touch /tmp/some/other/file.txt" \
  "shared_write" "touch_non_marker" \
  "touch non-marker → shared_write touch_non_marker"

# Same-class additions to existing handlers
assert_classify \
  "rm /tmp/fake-repo/.checkpoints/.so-runbook-shown.deadbeef" \
  "marker_write" "rm_marker" \
  "rm runbook marker → marker_write rm_marker"

assert_classify \
  ": > /tmp/fake-repo/.checkpoints/.so-runbook-shown.deadbeef" \
  "marker_write" "redirect_to_marker" \
  "redirect to runbook marker → marker_write redirect_to_marker"

assert_classify \
  "tee /tmp/fake-repo/.checkpoints/.so-runbook-shown.deadbeef" \
  "marker_write" "tee_marker" \
  "tee runbook marker → marker_write tee_marker"

# Regression — existing markers still classify as marker_write
assert_classify \
  "touch /tmp/fake-repo/.checkpoints/.pre-checkpoint-done" \
  "marker_write" "touch_marker" \
  "touch .pre-checkpoint-done → marker_write touch_marker (existing marker)"

assert_classify \
  "rm /tmp/fake-repo/.checkpoints/.plan-approval-pending" \
  "marker_write" "rm_marker" \
  "rm .plan-approval-pending → marker_write rm_marker (existing marker)"

echo ""
echo "$PASS/$((PASS+FAIL)) pass"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for f in "${FAILED[@]}"; do
    echo "  ✗ $f"
  done
  exit 1
fi
