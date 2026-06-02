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
HOOK="$REPO_ROOT/plugins/claude-code/hooks/plan-gate.sh"

if [ ! -f "$HOOK" ]; then
  echo "FAIL: $HOOK not found in repo. Issue #86 PR-A canonicalizes plan-gate.sh into hooks/."
  exit 1
fi

TEST_DIR=$(mktemp -d)
# macOS: /var is a symlink to /private/var. plan-gate's resolve_repo_root uses
# `cd -P` which resolves symlinks; the test's MARKER path must use the same
# resolved form so target-equality checks succeed.
TEST_DIR="$(cd -P "$TEST_DIR" && pwd)"
# Session 1 (#86 PR-B): plan-gate sources hooks/lib/command-classifier.sh and
# resolves repo-root via git-common-dir (PR #105 algorithm). Initialize
# TEST_DIR as a git repo so resolve_repo_root returns TEST_DIR.
git -C "$TEST_DIR" init -q 2>/dev/null
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

# Issue #86 PR-B: classifier-driven detection. The old regex matched any rm
# whose token list mentioned `.plan-approval-pending`; the new classifier
# returns marker_write only for the exact resolved marker path. A multi-arg
# rm targeting a different .plan-approval-pending elsewhere in the FS is
# still classified as marker_write but the TARGET won't equal repo-root, so
# plan-gate now blocks it.
assert_blocked "5. Adversarial rm with /tmp marker name BLOCKED (PR-B classifier)" \
  "$(mock_json 'Bash' "rm -rf /tmp/foo /tmp/.plan-approval-pending")"

assert_blocked "6. rm without marker name blocked" \
  "$(mock_json 'Bash' 'rm somefile.txt')"

assert_blocked "7. Write tool blocked with marker" \
  "$(mock_json 'Write')"

# Issue #86 PR-B + #89: plan-gate now allows read-only Bash via classifier.
assert_allowed "7b. Bash read-only ls allowed with marker (#86 PR-B + #89)" \
  "$(mock_json 'Bash' 'ls -la')"
assert_allowed "7b2. Bash git status allowed with marker" \
  "$(mock_json 'Bash' 'git status')"
assert_allowed "7b3. Bash gh pr view allowed with marker" \
  "$(mock_json 'Bash' 'gh pr view 123')"
assert_allowed "7b4. Bash node em-search allowed with marker" \
  "$(mock_json 'Bash' 'node scripts/em-search.mjs --project x')"

# #101: gh write methods must remain blocked while plan-gate is armed.
assert_blocked "7b5. gh pr create blocked with marker (write)" \
  "$(mock_json 'Bash' 'gh pr create --title foo')"
assert_blocked "7b6. gh api -X POST blocked with marker" \
  "$(mock_json 'Bash' 'gh api -X POST /repos/foo/bar/issues')"
assert_blocked "7b7. git push blocked with marker" \
  "$(mock_json 'Bash' 'git push origin main')"

# Codex PR #113 F2 (`...9796`/`...9cdd`): gh pr checkout mutates local
# working tree (shared_write). Plan-gate must block writes while marker
# armed. lock/unlock are push_or_pr_create — also blocked here.
assert_blocked "7b10. gh pr checkout blocked with marker (F2 shared_write)" \
  "$(mock_json 'Bash' 'gh pr checkout 113')"
assert_blocked "7b11. gh pr lock blocked with marker (F2 push_or_pr_create)" \
  "$(mock_json 'Bash' 'gh pr lock 113')"
assert_blocked "7b12. gh pr unlock blocked with marker (F2 push_or_pr_create)" \
  "$(mock_json 'Bash' 'gh pr unlock 113')"
# Codex review on commit 8 (`...9fc4`): gh pr revert is push_or_pr_create.
assert_blocked "7b12b. gh pr revert blocked with marker" \
  "$(mock_json 'Bash' 'gh pr revert 113')"
# Negative: read-only PR commands must still be allowed under marker.
assert_allowed "7b13. gh pr list still allowed with marker (read_only)" \
  "$(mock_json 'Bash' 'gh pr list')"
assert_allowed "7b14. gh pr diff still allowed with marker (read_only)" \
  "$(mock_json 'Bash' 'gh pr diff 113')"

# #86 ...a1e0: quoted body containing 'gh pr create' must NOT bypass.
# Plan-gate blocks because echo with quoted body classifies as read_only,
# which is allowed — but the marker was being incorrectly removed by the
# old regex if the body matched `^rm.*\.plan-approval-pending`. New
# classifier doesn't have that bypass.
assert_allowed "7b8. echo with quoted 'gh pr create' allowed (read_only)" \
  "$(mock_json 'Bash' "echo 'gh pr create'")"

# #86 ...a1e0 specifically: an rm whose body string mentions
# .plan-approval-pending but doesn't actually target the real path must block.
# The old regex `^rm\s+.*\.plan-approval-pending` matched any rm with the
# substring; the new classifier resolves the target path and refuses if it
# doesn't equal the repo-root marker.
assert_blocked "7b9. rm of unrelated file with marker-name in body BLOCKS (PR-B)" \
  "$(mock_json 'Bash' "rm /tmp/some-file-mentioning-.plan-approval-pending-in-name")"

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
