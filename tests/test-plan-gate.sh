#!/usr/bin/env bash
# test-plan-gate.sh — Automated tests for the plan-gate PreToolUse hook.
#
# Usage: bash tests/test-plan-gate.sh
#
# Tests the repo source at $REPO/hooks/plan-gate.sh (issue #86 PR-A:
# canonicalized into the repo). Fails fast if absent — CI must verify the
# checked-in hook content, not whatever a maintainer happened to install
# locally.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/hooks/plan-gate.sh"

if [ ! -f "$HOOK" ]; then
  echo "FAIL: $HOOK not found in repo. Issue #86 PR-A canonicalizes plan-gate.sh into hooks/."
  exit 1
fi

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

# Issue #86 PR-A: NotebookRead and ToolSearch added to read-only allowlist.
assert_allowed "1d. NotebookRead allowed with marker (#86 PR-A)" \
  "$(mock_json 'NotebookRead')"

assert_allowed "1e. ToolSearch allowed with marker (#86 PR-A)" \
  "$(mock_json 'ToolSearch')"

assert_allowed "1f. Skill allowed with marker" \
  "$(mock_json 'Skill')"

assert_allowed "1g. WebFetch allowed with marker" \
  "$(mock_json 'WebFetch')"

assert_allowed "1h. mcp__ prefix allowed with marker" \
  "$(mock_json 'mcp__some_server__some_tool')"

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

# Issue #86 PR-B (deferred): plan-gate still blocks all read-only Bash. PR-A
# does NOT introduce a Bash command-level allowlist. This guard ensures PR-B's
# scope stays scoped — if PR-A inadvertently lets ls through, the test fails.
assert_blocked "7b. Bash read-only command also blocked with marker (PR-B owns this)" \
  "$(mock_json 'Bash' 'ls -la')"

# Issue #86 PR-A regression guard: BashOutput / KillBash deliberately NOT on
# the allowlist (Codex review feedback — KillBash mutates process state; both
# pending follow-up evaluation).
assert_blocked "7c. BashOutput blocked with marker (deferred per Codex review)" \
  "$(mock_json 'BashOutput')"

assert_blocked "7d. KillBash blocked with marker (mutates process state)" \
  "$(mock_json 'KillBash')"

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
