#!/usr/bin/env bash
# test-worktree-marker-write.sh — E2E for rank-1 hook-deadlock plan v7.
#
# Exercises checkpoint-gate.sh via real piped JSON against a real main
# repo + linked git worktree + nested cwd. Verifies the wrong-root
# detection BOTH blocks AND prevents the artifact from landing where the
# agent attempted (codex round-4 F12 + round-6 F18 disk assertions).
#
# Closes BP-1 step 8 for this slice: subprocess unit tests in
# test-checkpoint-gate.sh don't prove the on-disk authority preservation;
# this file does.
#
# Codex review trail: 7 rounds, final ACCEPT-with-FU at episode ...e19a.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/hooks/checkpoint-gate.sh"

passed=0
failed=0

MAIN_DIR=$(mktemp -d)
MAIN_DIR="$(cd -P "$MAIN_DIR" && pwd)"

WT_DIR=$(mktemp -d)
WT_DIR="$(cd -P "$WT_DIR" && pwd)"
# Need empty for git worktree add
rmdir "$WT_DIR"

cleanup() {
  if [ -d "$WT_DIR" ]; then
    git -C "$MAIN_DIR" worktree remove --force "$WT_DIR" 2>/dev/null || true
  fi
  rm -rf "$MAIN_DIR" "$WT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Initialize main repo
git -C "$MAIN_DIR" init -q
git -C "$MAIN_DIR" config user.email t@t
git -C "$MAIN_DIR" config user.name t
echo x > "$MAIN_DIR/README.md"
git -C "$MAIN_DIR" add .
git -C "$MAIN_DIR" commit -q -m init

# Create linked worktree
git -C "$MAIN_DIR" worktree add -q -b wt-branch "$WT_DIR"
WT_DIR="$(cd -P "$WT_DIR" && pwd)"

# Arm checkpoint-required at main (canonical authority root)
MAIN_CKDIR="$MAIN_DIR/.checkpoints"
mkdir -p "$MAIN_CKDIR"
touch "$MAIN_CKDIR/.checkpoint-required"

# Nested cwd inside main repo (codex F18)
NESTED_DIR="$MAIN_DIR/subdir"
mkdir -p "$NESTED_DIR"

run_hook() {
  HOME="$MAIN_DIR" bash "$HOOK"
}

mock_write() {
  local file_path="$1" cwd="$2"
  jq -n --arg fp "$file_path" --arg cwd "$cwd" \
    '{tool_name: "Write", tool_input: {file_path: $fp, content: "x"}, cwd: $cwd}'
}

mock_bash() {
  local cmd="$1" cwd="$2"
  jq -n --arg cmd "$cmd" --arg cwd "$cwd" \
    '{tool_name: "Bash", tool_input: {command: $cmd}, cwd: $cwd}'
}

assert_blocked_with_canonical() {
  local label="$1" json="$2" expected_substring="$3"
  local output
  output=$(echo "$json" | run_hook 2>/dev/null)
  if echo "$output" | grep -q '"decision".*"block"' && echo "$output" | grep -q "$expected_substring"; then
    echo "  ✓ $label"
    ((passed++))
  else
    echo "  ✗ $label — output: $output"
    ((failed++))
  fi
}

assert_file_absent() {
  local label="$1" path="$2"
  if [ ! -e "$path" ]; then
    echo "  ✓ $label (file absent at $path)"
    ((passed++))
  else
    echo "  ✗ $label — file unexpectedly exists at $path"
    ((failed++))
  fi
}

echo ""
echo "=== rank-1 plan v7 E2E — wrong-root marker write detection ==="
echo ""

# Case 1 — Worktree Write to worktree-absolute marker → BLOCK, canonical hint, canonical absent
WT_PRE="$WT_DIR/.checkpoints/.pre-checkpoint-done"
MAIN_PRE="$MAIN_DIR/.checkpoints/.pre-checkpoint-done"
rm -f "$WT_PRE" "$MAIN_PRE"
mkdir -p "$WT_DIR/.checkpoints"
assert_blocked_with_canonical "1. Worktree Write absolute → block + canonical hint" \
  "$(mock_write "$WT_PRE" "$WT_DIR")" \
  "non-canonical path"
assert_file_absent "1a. canonical main marker NOT created by blocked Write" "$MAIN_PRE"

# Case 2 — Worktree Bash redirect → BLOCK, neither location written
assert_blocked_with_canonical "2. Worktree Bash redirect → block + canonical hint" \
  "$(mock_bash "echo x > $WT_DIR/.checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "non-canonical path"
assert_file_absent "2a. canonical main marker NOT created by blocked Bash redirect" "$MAIN_PRE"

# Case 3 — Worktree Bash touch → BLOCK
assert_blocked_with_canonical "3. Worktree Bash touch absolute → block + canonical hint" \
  "$(mock_bash "touch $WT_DIR/.checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "non-canonical path"
assert_file_absent "3a. canonical main marker NOT created" "$MAIN_PRE"

# Case 4 — Worktree Bash mv to absolute worktree path
rm -f "$WT_PRE" "$MAIN_PRE"
assert_blocked_with_canonical "4. Worktree Bash mv absolute → block" \
  "$(mock_bash "mv /tmp/x $WT_DIR/.checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "non-canonical path"

# Case 5 — Worktree Bash cp to absolute worktree path
assert_blocked_with_canonical "5. Worktree Bash cp absolute → block" \
  "$(mock_bash "cp /tmp/x $WT_DIR/.checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "non-canonical path"

# Case 6 — Worktree Bash dd to absolute worktree path
assert_blocked_with_canonical "6. Worktree Bash dd of= absolute → block" \
  "$(mock_bash "dd if=/tmp/x of=$WT_DIR/.checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "non-canonical path"

# Case 7 — Main cwd relative '> ./.checkpoints/<marker>' → no wrong-root block
# (the pre-gate may still fire because PRE_DONE is empty, but the wrong-root
# reason should NOT appear)
output=$(echo "$(mock_bash "echo x > ./.checkpoints/.pre-checkpoint-done" "$MAIN_DIR")" | run_hook 2>/dev/null)
if echo "$output" | grep -qE 'non-canonical path|Relative marker reference'; then
  echo "  ✗ 7. Main cwd './.checkpoints/<marker>' — wrong-root FALSELY fired"
  ((failed++))
else
  echo "  ✓ 7. Main cwd './.checkpoints/<marker>' → no wrong-root false-positive"
  ((passed++))
fi

# Case 8 — Worktree relative './.checkpoints/<marker>' → BLOCK
assert_blocked_with_canonical "8. Worktree './.checkpoints/<marker>' redirect → block" \
  "$(mock_bash "echo x > ./.checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "Relative marker reference"
assert_file_absent "8a. canonical main marker NOT created" "$MAIN_PRE"
assert_file_absent "8b. worktree marker NOT created (shell didn't run)" "$WT_PRE"

# Case 9 — Worktree './.checkpoints/<marker>' touch → BLOCK
assert_blocked_with_canonical "9. Worktree './.checkpoints/<marker>' touch → block" \
  "$(mock_bash "touch ./.checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "Relative marker reference"

# Case 10 — Worktree install to relative marker → BLOCK
assert_blocked_with_canonical "10. Worktree install to relative marker → block" \
  "$(mock_bash "install /tmp/x .checkpoints/.pre-checkpoint-done" "$WT_DIR")" \
  "Relative marker reference"

# Case 11 — Worktree heredoc DEFERRED — classifier mis-labels as read_only
# (filed as FU; precheck doesn't fire for read_only-classified commands).

# Case 12 — Nested cwd inside main repo + relative marker write → BLOCK (codex F18)
assert_blocked_with_canonical "12. Nested cwd inside main repo + relative marker → block" \
  "$(mock_bash "echo x > .checkpoints/.pre-checkpoint-done" "$NESTED_DIR")" \
  "Relative marker reference"
assert_file_absent "12a. nested marker NOT created by blocked Bash" "$NESTED_DIR/.checkpoints/.pre-checkpoint-done"
assert_file_absent "12b. canonical main marker NOT created" "$MAIN_PRE"

echo ""
echo "=== Result ==="
echo "Passed: $passed"
echo "Failed: $failed"

if [ $failed -gt 0 ]; then
  exit 1
fi
exit 0
