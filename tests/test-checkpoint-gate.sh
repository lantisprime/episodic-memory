#!/usr/bin/env bash
# test-checkpoint-gate.sh — Tests for hooks/checkpoint-gate.sh (Phase 3b)
#
# Per Codex review: runs the REPO source against a temp cwd + HOME, not an
# installed copy. PRs verify the actual checked-in hook content.
#
# Usage: bash tests/test-checkpoint-gate.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/hooks/checkpoint-gate.sh"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK is not executable"
  exit 1
fi

TEST_DIR=$(mktemp -d)
TEST_HOME=$(mktemp -d)
MARKER_DIR="$TEST_DIR/.claude"
PRE_REQ="$MARKER_DIR/.checkpoint-required"
PRE_DONE="$MARKER_DIR/.pre-checkpoint-done"
POST_REQ="$MARKER_DIR/.post-checkpoint-required"
POST_DONE="$MARKER_DIR/.post-checkpoint-done"

passed=0
failed=0

cleanup() { rm -rf "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

reset_state() {
  rm -rf "$MARKER_DIR"
  mkdir -p "$MARKER_DIR"
}

mock_json() {
  local tool_name="$1"
  local command="${2:-}"
  if [ -n "$command" ]; then
    jq -n --arg tn "$tool_name" --arg cmd "$command" --arg cwd "$TEST_DIR" \
      '{tool_name: $tn, tool_input: {command: $cmd}, cwd: $cwd}'
  else
    jq -n --arg tn "$tool_name" --arg cwd "$TEST_DIR" \
      '{tool_name: $tn, tool_input: {}, cwd: $cwd}'
  fi
}

run_hook() {
  HOME="$TEST_HOME" bash "$HOOK"
}

assert_allowed() {
  local test_name="$1"
  local json="$2"
  local output
  local exit_code=0
  output=$(echo "$json" | run_hook 2>/dev/null) || exit_code=$?
  if [ $exit_code -eq 0 ] && [ -z "$output" ]; then
    echo "  ✓ $test_name"
    ((passed++))
  else
    echo "  ✗ $test_name (exit=$exit_code, output=$output)"
    ((failed++))
  fi
}

assert_blocked() {
  local test_name="$1"
  local json="$2"
  local expected_substring="${3:-}"
  local output
  local exit_code=0
  output=$(echo "$json" | run_hook 2>/dev/null) || exit_code=$?
  if echo "$output" | grep -q '"decision".*"block"'; then
    if [ -n "$expected_substring" ] && ! echo "$output" | grep -q "$expected_substring"; then
      echo "  ✗ $test_name (blocked but message missing '$expected_substring'): $output"
      ((failed++))
    else
      echo "  ✓ $test_name"
      ((passed++))
    fi
  else
    echo "  ✗ $test_name (expected block, got exit=$exit_code, output=$output)"
    ((failed++))
  fi
}

assert_marker_exists() {
  local test_name="$1"
  local marker="$2"
  if [ -f "$marker" ]; then
    echo "  ✓ $test_name"
    ((passed++))
  else
    echo "  ✗ $test_name (marker missing: $marker)"
    ((failed++))
  fi
}

assert_marker_absent() {
  local test_name="$1"
  local marker="$2"
  if [ ! -e "$marker" ]; then
    echo "  ✓ $test_name"
    ((passed++))
  else
    echo "  ✗ $test_name (marker still exists: $marker)"
    ((failed++))
  fi
}

# ============================================================================
echo ""
echo "--- No markers (idle state) ---"
# ============================================================================
reset_state

assert_allowed "1.  Read allowed in idle" "$(mock_json 'Read')"
assert_allowed "2.  Edit allowed in idle" "$(mock_json 'Edit')"
assert_allowed "3.  Write allowed in idle" "$(mock_json 'Write')"
assert_allowed "4.  MultiEdit allowed in idle" "$(mock_json 'MultiEdit')"
assert_allowed "5.  Bash allowed in idle" "$(mock_json 'Bash' 'ls')"
assert_allowed "6.  git push allowed in idle" "$(mock_json 'Bash' 'git push origin main')"
assert_marker_absent "7.  post-required NOT armed in idle" "$POST_REQ"

# ============================================================================
echo ""
echo "--- Pre-checkpoint gate (.checkpoint-required present, .pre-checkpoint-done missing) ---"
# ============================================================================
reset_state
touch "$PRE_REQ"

assert_allowed "8.  Read allowed (always)" "$(mock_json 'Read')"
assert_allowed "9.  Glob allowed (always)" "$(mock_json 'Glob')"
assert_allowed "10. Grep allowed (always)" "$(mock_json 'Grep')"
assert_blocked "11. Edit blocked by pre-gate" "$(mock_json 'Edit')" "Checkpoint required"
assert_blocked "12. Write blocked by pre-gate" "$(mock_json 'Write')" "Checkpoint required"
assert_blocked "13. MultiEdit blocked by pre-gate" "$(mock_json 'MultiEdit')" "Checkpoint required"
assert_blocked "14. Bash blocked by pre-gate" "$(mock_json 'Bash' 'echo hello')" "Checkpoint required"
assert_blocked "15. NotebookEdit blocked by pre-gate" "$(mock_json 'NotebookEdit')" "Checkpoint required"

# Marker-write allowlist (deadlock prevention)
assert_allowed "16. Bash writing pre-checkpoint-done allowed (no deadlock)" \
  "$(mock_json 'Bash' "echo 'checkpoint text' > $PRE_DONE")"
assert_allowed "17. Bash writing post-checkpoint-done allowed" \
  "$(mock_json 'Bash' "echo 'post text' > $POST_DONE")"
assert_allowed "18. Bash heredoc to pre-checkpoint-done allowed" \
  "$(mock_json 'Bash' "cat > $PRE_DONE <<EOF\ncheckpoint\nEOF")"

# ============================================================================
echo ""
echo "--- Empty pre-checkpoint-done does NOT unblock ---"
# ============================================================================
reset_state
touch "$PRE_REQ"
touch "$PRE_DONE"  # empty file

assert_blocked "19. Empty pre-checkpoint-done still blocks Edit" \
  "$(mock_json 'Edit')" "Checkpoint required"

# ============================================================================
echo ""
echo "--- Non-empty pre-checkpoint-done unblocks ---"
# ============================================================================
reset_state
touch "$PRE_REQ"
echo "## Rule 18 checkpoint" > "$PRE_DONE"

assert_allowed "20. Non-empty pre-checkpoint-done unblocks Edit" "$(mock_json 'Edit')"
assert_marker_exists "21. post-checkpoint-required armed after allowed Edit" "$POST_REQ"

# Idempotent: second write doesn't error
rm -f "$POST_REQ"
assert_allowed "22. Second allowed write also arms post-required" "$(mock_json 'Write')"
assert_marker_exists "23. post-required present after second write" "$POST_REQ"

# ============================================================================
echo ""
echo "--- Push gate (post-required present, post-done missing/empty) ---"
# ============================================================================
reset_state
touch "$PRE_REQ"
echo "pre done" > "$PRE_DONE"
touch "$POST_REQ"

assert_blocked "24. git push blocked by push-gate" \
  "$(mock_json 'Bash' 'git push origin main')" "Post-implementation checkpoint required"
assert_blocked "25. gh pr create blocked by push-gate" \
  "$(mock_json 'Bash' 'gh pr create --title foo --body bar')" "Post-implementation checkpoint required"
assert_blocked "26. git -C path push blocked by push-gate" \
  "$(mock_json 'Bash' 'git -C /tmp/repo push origin main')" "Post-implementation checkpoint required"
assert_blocked "27. cd && git push blocked by push-gate" \
  "$(mock_json 'Bash' 'cd /tmp && git push')" "Post-implementation checkpoint required"
assert_blocked "28. git push -f blocked by push-gate" \
  "$(mock_json 'Bash' 'git push -f origin main')" "Post-implementation checkpoint required"

# Empty post-done does NOT unblock
touch "$POST_DONE"
assert_blocked "29. Empty post-checkpoint-done still blocks push" \
  "$(mock_json 'Bash' 'git push origin main')" "Post-implementation checkpoint required"

# Non-push commands NOT affected by push-gate
assert_allowed "30. git status NOT blocked by push-gate" "$(mock_json 'Bash' 'git status')"
assert_allowed "31. git pushtags-like word NOT blocked" "$(mock_json 'Bash' 'echo gitpush')"

# Marker-write allowlist still works under push-gate state
assert_allowed "32. Bash writing post-checkpoint-done allowed under push-gate" \
  "$(mock_json 'Bash' "echo 'post text' > $POST_DONE")"

# ============================================================================
echo ""
echo "--- Push allowed cleans all 4 markers ---"
# ============================================================================
reset_state
touch "$PRE_REQ"
echo "pre done" > "$PRE_DONE"
touch "$POST_REQ"
echo "post done" > "$POST_DONE"

assert_allowed "33. git push allowed when post-done non-empty" \
  "$(mock_json 'Bash' 'git push origin main')"
assert_marker_absent "34. checkpoint-required cleaned after push" "$PRE_REQ"
assert_marker_absent "35. pre-checkpoint-done cleaned after push" "$PRE_DONE"
assert_marker_absent "36. post-checkpoint-required cleaned after push" "$POST_REQ"
assert_marker_absent "37. post-checkpoint-done cleaned after push" "$POST_DONE"

# gh pr create also cleans
reset_state
touch "$PRE_REQ"
echo "pre" > "$PRE_DONE"
touch "$POST_REQ"
echo "post" > "$POST_DONE"
assert_allowed "38. gh pr create allowed cleans all markers" \
  "$(mock_json 'Bash' 'gh pr create --title x --body y')"
assert_marker_absent "39. all markers cleaned after gh pr create" "$POST_REQ"

# ============================================================================
echo ""
echo "--- Edge: idle state push (no gate active) ---"
# ============================================================================
reset_state

assert_allowed "40. git push allowed when no markers exist" \
  "$(mock_json 'Bash' 'git push origin main')"
assert_marker_absent "41. push in idle does not create markers" "$POST_REQ"

# ============================================================================
echo ""
echo "--- Edge: post-tracking only arms after pre-checkpoint satisfied ---"
# ============================================================================
reset_state
# .checkpoint-required absent — no pre-checkpoint was ever required
echo "stale done" > "$PRE_DONE"  # orphan PRE_DONE without PRE_REQ

assert_allowed "42. Edit allowed when no PRE_REQ" "$(mock_json 'Edit')"
assert_marker_absent "43. post-required NOT armed when PRE_REQ absent" "$POST_REQ"

# ============================================================================
echo ""
echo "--- Edge: missing .claude dir (mkdir -p safety) ---"
# ============================================================================
rm -rf "$MARKER_DIR"
assert_allowed "44. Hook does not crash when .claude/ missing" "$(mock_json 'Edit')"

# ============================================================================
echo ""
echo "--- Result ---"
# ============================================================================
echo ""
echo "Passed: $passed"
echo "Failed: $failed"

if [ $failed -gt 0 ]; then
  exit 1
fi
exit 0
