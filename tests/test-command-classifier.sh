#!/usr/bin/env bash
# test-command-classifier.sh — Tests for hooks/lib/command-classifier.sh
#
# Usage: bash tests/test-command-classifier.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$REPO_ROOT/hooks/lib/command-classifier.sh"

if [ ! -f "$LIB" ]; then
  echo "FAIL: $LIB not found"
  exit 1
fi

# shellcheck disable=SC1090
source "$LIB"

passed=0
failed=0

# Mock repo root for marker resolution
TEST_ROOT="/tmp/test-classifier-root"

assert_label() {
  local desc="$1"
  local cmd="$2"
  local expected_label="$3"
  local expected_target="${4:-}"

  local result label target reason
  result="$(classify_command "$cmd" "$TEST_ROOT")"
  label="${result%%	*}"
  local rest="${result#*	}"
  target="${rest%%	*}"
  reason="${rest#*	}"

  local ok=1
  if [ "$label" != "$expected_label" ]; then ok=0; fi
  if [ -n "$expected_target" ] && [ "$target" != "$expected_target" ]; then ok=0; fi

  if [ $ok -eq 1 ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc"
    echo "    cmd:      $cmd"
    echo "    expected: $expected_label" "${expected_target:+(target=$expected_target)}"
    echo "    got:      $label (target=$target, reason=$reason)"
    failed=$((failed+1))
  fi
}

echo ""
echo "--- Read-only ---"
assert_label "T01 ls" "ls -la" "read_only"
assert_label "T02 cat" "cat /etc/hosts" "read_only"
assert_label "T03 grep" "grep -r foo ." "read_only"
assert_label "T04 git status" "git status" "read_only"
assert_label "T05 git log" "git log --oneline" "read_only"
assert_label "T06 git -C path log" "git -C /tmp log" "read_only"
assert_label "T07 git --no-pager show" "git --no-pager show HEAD" "read_only"
assert_label "T08 gh pr view" "gh pr view 123" "read_only"
assert_label "T09 gh pr list" "gh pr list" "read_only"
assert_label "T10 gh issue list" "gh issue list" "read_only"
assert_label "T11 gh api default GET" "gh api /repos/foo/bar" "read_only"
assert_label "T12 echo with no redirect" "echo hello" "read_only"
assert_label "T13 empty" "" "read_only"
assert_label "T14 colon noop" ":" "read_only"
assert_label "T15 true" "true" "read_only"
assert_label "T16 node em-search" "node scripts/em-search.mjs --project x" "read_only"
assert_label "T17 wc -l" "wc -l file.txt" "read_only"

echo ""
echo "--- Push or PR-create ---"
assert_label "T20 git push" "git push origin main" "push_or_pr_create"
assert_label "T21 git -C path push" "git -C /tmp push" "push_or_pr_create"
assert_label "T22 git --no-pager push" "git --no-pager push" "push_or_pr_create"
assert_label "T23 gh pr create" "gh pr create --title foo --body bar" "push_or_pr_create"
assert_label "T24 gh pr merge" "gh pr merge 123" "push_or_pr_create"
assert_label "T25 gh issue create" "gh issue create --title foo" "push_or_pr_create"
assert_label "T26 gh issue close" "gh issue close 5" "push_or_pr_create"
assert_label "T27 gh release create" "gh release create v1.0" "push_or_pr_create"
assert_label "T28 gh api -X POST" "gh api -X POST /repos/foo/bar/merges" "push_or_pr_create"
assert_label "T29 gh api -XPOST" "gh api -XPOST /repos/foo/bar/issues" "push_or_pr_create"
assert_label "T30 gh api --method POST" "gh api --method POST /repos/foo/bar/comments" "push_or_pr_create"
assert_label "T31 gh api method-after-path" "gh api /repos/foo/bar/labels -X POST" "push_or_pr_create"
assert_label "T32 gh api lowercase" "gh api -X post /repos/foo/bar/issues" "push_or_pr_create"
assert_label "T33 env before git push" "GIT_SSH=foo git push" "push_or_pr_create"
assert_label "T34 gh pr review --approve" "gh pr review 5 --approve" "push_or_pr_create"

echo ""
echo "--- False-positive guards (push detection should NOT fire) ---"
assert_label "T40 git stash push" "git stash push -m wip" "shared_write"
assert_label "T41 git commit -m push" "git commit -m push" "shared_write"
assert_label "T42 quoted gh pr create in echo" "echo 'gh pr create'" "read_only"
assert_label "T43 quoted git push in echo" "echo \"git push origin\"" "read_only"
assert_label "T44 git branch (read shape)" "git branch" "read_only"

echo ""
echo "--- Marker write detection ---"
assert_label "T50 echo redirect to .pre-checkpoint-done" \
  "echo hello > .pre-checkpoint-done" "marker_write" "$TEST_ROOT/.pre-checkpoint-done"
assert_label "T51 echo redirect to .post-checkpoint-done" \
  "echo done > .post-checkpoint-done" "marker_write" "$TEST_ROOT/.post-checkpoint-done"
assert_label "T52 cat heredoc to marker" \
  "cat > .pre-checkpoint-done <<EOF
body
EOF" "marker_write" "$TEST_ROOT/.pre-checkpoint-done"
assert_label "T53 rm plan-approval-pending" \
  "rm .claude/.plan-approval-pending" "marker_write" "$TEST_ROOT/.claude/.plan-approval-pending"
assert_label "T54 rm -f marker" \
  "rm -f .pre-checkpoint-done" "marker_write" "$TEST_ROOT/.pre-checkpoint-done"
assert_label "T55 quoted body containing marker name" \
  "echo 'this is .pre-checkpoint-done text'" "read_only"

echo ""
echo "--- Unsafe complex ---"
assert_label "T60 bash -c" "bash -c 'rm -rf /'" "unsafe_complex"
assert_label "T61 sh -c" "sh -c 'echo'" "unsafe_complex"
assert_label "T62 eval" "eval echo foo" "unsafe_complex"
assert_label "T63 source file" "source ./script.sh" "unsafe_complex"
assert_label "T64 command substitution" 'echo $(date)' "unsafe_complex"
assert_label "T65 backtick" 'echo `date`' "unsafe_complex"
assert_label "T66 unbalanced single quote" "echo 'oops" "unsafe_complex"
assert_label "T67 unbalanced double quote" 'echo "oops' "unsafe_complex"
assert_label "T68 process substitution" "diff <(ls) <(ls -la)" "unsafe_complex"
assert_label "T69 gh api graphql" "gh api graphql -f query='mutation { x }'" "unsafe_complex"

echo ""
echo "--- Control-operator chain reduction ---"
# Most-restrictive wins. unsafe > push > shared > marker > read_only.
assert_label "T70 marker rm then push" "rm .plan-approval-pending && git push" "push_or_pr_create"
assert_label "T71 ls then rm marker" "ls && rm .plan-approval-pending" "marker_write"
assert_label "T72 ls then commit" "ls && git commit -m foo" "shared_write"
assert_label "T73 ls then bash -c" "ls && bash -c 'foo'" "unsafe_complex"
assert_label "T74 chained pipe" "ls | grep foo" "read_only"
assert_label "T75 chained pipe with write" "ls | tee output.txt" "shared_write"
assert_label "T76 quoted control op" "echo 'a && b'" "read_only"
assert_label "T77 quoted semicolon" "echo 'foo;bar'" "read_only"

echo ""
echo "--- shared_write defaults ---"
assert_label "T80 git commit" "git commit -m wip" "shared_write"
assert_label "T81 npm install" "npm install" "shared_write"
assert_label "T82 mkdir" "mkdir -p foo" "shared_write"
assert_label "T83 node em-store" "node scripts/em-store.mjs --project x" "shared_write"

echo ""
echo "--- classify_path ---"
assert_path() {
  local desc="$1"
  local path="$2"
  local expected="$3"
  local result label
  result="$(classify_path "$path" "$TEST_ROOT")"
  label="${result%%	*}"
  if [ "$label" = "$expected" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc — got $label, expected $expected"
    failed=$((failed+1))
  fi
}
assert_path "P01 marker path" ".pre-checkpoint-done" "marker_write"
assert_path "P02 plan-approval-pending" ".claude/.plan-approval-pending" "marker_write"
assert_path "P03 ordinary file" "src/foo.mjs" "shared_write"
assert_path "P04 absolute marker" "$TEST_ROOT/.claude/.post-checkpoint-done" "marker_write"

echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="

exit $((failed > 0 ? 1 : 0))
