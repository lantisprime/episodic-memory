#!/usr/bin/env bash
# tests/test-plan-marker-classifier.sh — Classifier coverage for #268 fix.
#
# Verifies hooks/lib/command-classifier.sh handles:
#   - E1-E5: per-session plan-marker case-arms in 4 verb handlers + classify_path
#   - E5b: node */plan-marker.mjs --touch|--rm --root <abs> → marker_write
#         with TARGET = canonical per-session marker path
#   - F17/F18: leading POSIX-name env assignment on helper invocation →
#             unsafe_complex (prevents command-local CLAUDE_CODE_SESSION_ID
#             override cross-session attack)
#   - F-3 architectural invariant: classifier reads CLAUDE_CODE_SESSION_ID
#     from its own process env (the same env Claude Code injects into the
#     spawned helper subprocess). Coverage requested by code-review F-3
#     (negative-scenario-reviewer).
#
# Run: bash tests/test-plan-marker-classifier.sh

set -u

REPO="$(cd -P "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO/hooks/lib/command-classifier.sh"
# shellcheck disable=SC1091
source "$REPO/hooks/lib/marker-paths.sh"
# shellcheck disable=SC1091
source "$REPO/hooks/lib/session-id.sh"

export CLAUDE_CODE_SESSION_ID="test-sid-abc"

passed=0
failed=0

run() {
  local cmd="$1" expected_label="$2" expected_reason_grep="${3:-}" label_desc="$4"
  local r
  r="$(classify_command "$cmd" "$REPO" 2>&1)"
  local label="${r%%	*}"
  local rest="${r#*	}"
  local reason="${rest#*	}"
  if [ "$label" = "$expected_label" ]; then
    if [ -z "$expected_reason_grep" ] || printf '%s' "$reason" | grep -qE "$expected_reason_grep"; then
      echo "  ✓ $label_desc"
      passed=$((passed+1))
    else
      echo "  ✗ $label_desc — label=$label OK but reason=$reason does not match /$expected_reason_grep/"
      failed=$((failed+1))
    fi
  else
    echo "  ✗ $label_desc — expected $expected_label, got $label ($reason)"
    failed=$((failed+1))
  fi
}

run_target_match() {
  local cmd="$1" expected_target_grep="$2" label_desc="$3"
  local r
  r="$(classify_command "$cmd" "$REPO" 2>&1)"
  local rest="${r#*	}"
  local target="${rest%%	*}"
  if printf '%s' "$target" | grep -qE "$expected_target_grep"; then
    echo "  ✓ $label_desc (target=$target)"
    passed=$((passed+1))
  else
    echo "  ✗ $label_desc — target=$target does not match /$expected_target_grep/"
    failed=$((failed+1))
  fi
}

echo "--- E1-E5: case-arm extensions for suffixed form ---"
run "rm /repo/.checkpoints/.plan-approval-pending.SID-abc" "marker_write" "rm_marker" "E2 rm suffixed"
run "touch /repo/.checkpoints/.plan-approval-pending.SID-abc" "marker_write" "touch_marker" "E4 touch suffixed"
run "echo x > /repo/.checkpoints/.plan-approval-pending.SID-abc" "marker_write" "redirect_to_marker" "E1 redirect suffixed"
run "tee /repo/.checkpoints/.plan-approval-pending.SID-abc" "marker_write" "tee_marker" "E3 tee suffixed"

echo ""
echo "--- E5b: plan-marker.mjs helper invocation (F13) ---"
run "node /Users/x/.episodic-memory/scripts/plan-marker.mjs --touch --root /repo" "marker_write" "plan_marker_touch" "E5b helper --touch"
run "node /Users/x/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo" "marker_write" "plan_marker_rm" "E5b helper --rm"

echo ""
echo "--- F-3: classifier reads CLAUDE_CODE_SESSION_ID from env (target encodes sid) ---"
# Classifier must compute TARGET = <root>/.checkpoints/.plan-approval-pending.<env_sid>.
# This pins the architectural invariant that the classifier and the helper
# read sid from the SAME source (process.env / inherited bash env).
run_target_match \
  "node /Users/x/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo" \
  "/repo/\\.checkpoints/\\.plan-approval-pending\\.test-sid-abc" \
  "F-3 TARGET encodes process.env CLAUDE_CODE_SESSION_ID"

echo ""
echo "--- F17/F18: env-prefix rejection ---"
run "CLAUDE_CODE_SESSION_ID=B node /Users/x/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo" "unsafe_complex" "plan_marker_env_override" "F17 uppercase env-prefix"
run "foo=bar node /Users/x/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo" "unsafe_complex" "plan_marker_env_override" "F18 lowercase env-prefix"
run "Foo123=x node /Users/x/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo" "unsafe_complex" "plan_marker_env_override" "F18 mixed-case env-prefix"
run "_x=y node /Users/x/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo" "unsafe_complex" "plan_marker_env_override" "F18 underscore env-prefix"
run "ENV1=x ENV2=y node /Users/x/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo" "unsafe_complex" "plan_marker_env_override" "F17 multi env-prefix"

echo ""
echo "--- Mutex / missing action ---"
run "node /scripts/plan-marker.mjs --touch --rm --root /repo" "unsafe_complex" "plan_marker_mutex" "mutex violation"
run "node /scripts/plan-marker.mjs --root /repo" "unsafe_complex" "plan_marker_missing" "missing action"

echo ""
echo "--- Negative: non-marker node invocations classify normally ---"
run "node /scripts/some-other.mjs --foo" "shared_write" "" "unrelated node script"

echo ""
echo "Results: $passed passed, $failed failed"
[ $failed -eq 0 ]
