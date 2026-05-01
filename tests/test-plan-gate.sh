#!/usr/bin/env bash
# test-plan-gate.sh — Automated tests for the plan-gate PreToolUse hook.
#
# Usage: bash tests/test-plan-gate.sh
#
# Tests the hook by piping mock JSON and checking exit codes + output.

set -uo pipefail

HOOK="$HOME/.claude/hooks/plan-gate.sh"
TEST_DIR=$(mktemp -d)
MARKER="$TEST_DIR/.claude/.plan-approval-pending"
passed=0
failed=0

cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

# Helper: build mock JSON
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

assert_allowed() {
  local test_name="$1"
  local json="$2"
  local output
  local exit_code=0
  output=$(echo "$json" | bash "$HOOK" 2>/dev/null) || exit_code=$?
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
  local output
  local exit_code=0
  output=$(echo "$json" | bash "$HOOK" 2>/dev/null) || exit_code=$?
  if echo "$output" | grep -q '"decision".*"block"'; then
    echo "  ✓ $test_name"
    ((passed++))
  else
    echo "  ✗ $test_name (expected block, got exit=$exit_code, output=$output)"
    ((failed++))
  fi
}

# ===========================================================================
echo ""
echo "--- With marker present ---"
# ===========================================================================
mkdir -p "$(dirname "$MARKER")"
touch "$MARKER"

assert_allowed "1. Read tool allowed with marker" \
  "$(mock_json 'Read')"

assert_allowed "1b. Glob tool allowed with marker" \
  "$(mock_json 'Glob')"

assert_allowed "1c. Agent tool allowed with marker" \
  "$(mock_json 'Agent')"

assert_blocked "2. Edit blocked with marker" \
  "$(mock_json 'Edit')"

assert_blocked "3. Bash with write command blocked with marker" \
  "$(mock_json 'Bash' 'echo hello > file.txt')"

assert_allowed "4. rm ...plan-approval-pending allowed through" \
  "$(mock_json 'Bash' "rm $MARKER")"

assert_allowed "5. Adversarial rm with marker name (documents current regex)" \
  "$(mock_json 'Bash' "rm -rf /tmp/foo .plan-approval-pending")"

assert_blocked "6. rm without marker name blocked" \
  "$(mock_json 'Bash' 'rm somefile.txt')"

assert_blocked "7. Write tool blocked with marker" \
  "$(mock_json 'Write')"

assert_blocked "7b. Bash read-only command also blocked with marker (hook blocks all Bash)" \
  "$(mock_json 'Bash' 'ls -la')"

# ===========================================================================
echo ""
echo "--- Without marker ---"
# ===========================================================================
rm "$MARKER"

assert_allowed "8. Bash allowed without marker" \
  "$(mock_json 'Bash' 'echo hello')"

assert_allowed "9. Edit allowed without marker" \
  "$(mock_json 'Edit')"

assert_allowed "10. Write allowed without marker" \
  "$(mock_json 'Write')"

# ===========================================================================
echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="

exit $((failed > 0 ? 1 : 0))
