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
# macOS /var → /private/var symlink: classifier resolves with cd -P, so the
# test must use the resolved path for marker-target equality checks.
TEST_DIR="$(cd -P "$TEST_DIR" && pwd)"
TEST_HOME="$(cd -P "$TEST_HOME" && pwd)"
# Session 1 (#86 PR-B): checkpoint-gate sources hooks/lib/command-classifier.sh
# and resolves repo-root via git-common-dir. Initialize TEST_DIR as a git repo.
git -C "$TEST_DIR" init -q 2>/dev/null
# 2026-05-09 .checkpoints/ migration: hook now writes/arms at PRIMARY
# (.checkpoints/) and reads at PRIMARY-then-LEGACY. Tests target the
# primary path for write-side assertions and arming-state setup. Legacy
# paths are still exercised by tests/test-checkpoints-migration.mjs.
MARKER_DIR="$TEST_DIR/.checkpoints"
LEGACY_MARKER_DIR="$TEST_DIR/.claude"
PRE_REQ="$MARKER_DIR/.checkpoint-required"
PRE_DONE="$MARKER_DIR/.pre-checkpoint-done"
POST_REQ="$MARKER_DIR/.post-checkpoint-required"
POST_DONE="$MARKER_DIR/.post-checkpoint-done"

passed=0
failed=0

cleanup() { rm -rf "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

reset_state() {
  rm -rf "$MARKER_DIR" "$LEGACY_MARKER_DIR"
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
# #89 (Session 1): read-only Bash is now allowed during pre-gate. The shape
# of test 14 changes from "echo hello" (now read_only / allowed) to a real
# write that should block.
assert_blocked "14. Bash write command blocked by pre-gate" \
  "$(mock_json 'Bash' 'echo hello > /tmp/somefile')" "Checkpoint required"
assert_allowed "14b. Bash read-only echo allowed (#89)" \
  "$(mock_json 'Bash' 'echo hello')"
# Codex PR #113 F2 (`...9796`/`...9cdd`): gh pr checkout mutates local
# working tree (shared_write), so pre-gate must block it.
assert_blocked "14c. gh pr checkout blocked by pre-gate (F2 shared_write)" \
  "$(mock_json 'Bash' 'gh pr checkout 113')" "Checkpoint required"
# Negative: read-only PR commands must still pass during pre-gate.
assert_allowed "14d. gh pr view allowed by pre-gate (read_only)" \
  "$(mock_json 'Bash' 'gh pr view 113')"
assert_blocked "15. NotebookEdit blocked by pre-gate" "$(mock_json 'NotebookEdit')" "Checkpoint required"

# Marker-write allowlist (deadlock prevention)
assert_allowed "16. Bash writing pre-checkpoint-done allowed (no deadlock)" \
  "$(mock_json 'Bash' "echo 'checkpoint text' > $PRE_DONE")"
# Session 1 (Codex ...3503 P1): per-marker prerequisites. Writing POST_DONE
# requires .post-checkpoint-required; with only PRE_REQ armed, this blocks.
assert_blocked "17. Bash writing post-checkpoint-done BLOCKED (POST_REQ not armed)" \
  "$(mock_json 'Bash' "echo 'post text' > $POST_DONE")" "Checkpoint required"
assert_allowed "18. Bash heredoc to pre-checkpoint-done allowed" \
  "$(mock_json 'Bash' "$(printf 'cat > %s <<EOF\ncheckpoint\nEOF' "$PRE_DONE")")"

# ============================================================================
echo ""
echo "--- fd-redirect tokenizer (T3 empirical repros) ---"
# ============================================================================
# Bug repro (2026-05-18): with CR armed + pre-done absent, read-only
# commands using the `2>&1` stderr-merge idiom were misclassified as
# `shared_write` and BLOCKED by pre-gate, defeating routine inspection
# during the very state the gate exists to enforce a single checkpoint
# write. Codex R1-R5 chain (ACCEPT-with-FU at R5) drove the
# operand-completeness fix.
reset_state
touch "$PRE_REQ"

# Read-only base commands with fd-dup stderr merge → ALLOW (the bug fix)
assert_allowed "18a. ls 2>&1 allowed during pre-gate" \
  "$(mock_json 'Bash' 'ls -la /tmp 2>&1')"
assert_allowed "18b. ls 2>&1 | head allowed during pre-gate" \
  "$(mock_json 'Bash' 'ls -la /tmp 2>&1 | head -40')"
assert_allowed "18c. em-search 2>&1 piped allowed during pre-gate" \
  "$(mock_json 'Bash' 'node scripts/em-search.mjs --tag x 2>&1 | head')"
assert_allowed "18d. find ... 2>&1 allowed" \
  "$(mock_json 'Bash' 'find .checkpoints -maxdepth 2 -type f 2>&1')"
assert_allowed "18e. echo hi >&2 allowed (fd-dup, not file)" \
  "$(mock_json 'Bash' 'echo hi >&2')"
assert_allowed "18f. >& 2 whitespace-fd-dup allowed" \
  "$(mock_json 'Bash' 'ls >& 2')"
assert_allowed "18g. 2>& 1 whitespace-fd-dup allowed" \
  "$(mock_json 'Bash' 'ls 2>& 1')"
assert_allowed "18h. cat <&5 input-fd-dup allowed" \
  "$(mock_json 'Bash' 'cat <&5')"
assert_allowed "18i. &>>/dev/null allowed" \
  "$(mock_json 'Bash' 'ls &>>/dev/null')"

# Negative: real file writes via `>&word` MUST still block (codex R4 finding)
assert_blocked "18j. >&2foo blocks (file redirect, not fd-dup)" \
  "$(mock_json 'Bash' 'echo hi >&2foo')" "Checkpoint required"
assert_blocked "18k. >& foo (ws non-digit) blocks" \
  "$(mock_json 'Bash' 'ls >& foo')" "Checkpoint required"
assert_blocked "18l. >& \"out.txt\" (quoted file) blocks" \
  "$(mock_json 'Bash' 'ls >& "/tmp/out.txt"')" "Checkpoint required"
assert_blocked "18m. 2>file (real file redirect) blocks" \
  "$(mock_json 'Bash' 'ls 2>/tmp/err.log')" "Checkpoint required"
assert_blocked "18n. &>>real-file blocks" \
  "$(mock_json 'Bash' 'ls &>>/tmp/all.log')" "Checkpoint required"

# Most-restrictive across segments: fd-dup-read then push → push wins (blocked)
assert_blocked "18o. fd-dup then push (compound) blocked by pre-gate" \
  "$(mock_json 'Bash' 'git status 2>&1 && git push')" "Checkpoint required"

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

# Codex PR #113 F2 (`...9796`/`...9cdd`): gh pr lock/unlock are shared
# GitHub mutations (push_or_pr_create) and must be blocked by the push-gate.
assert_blocked "28b. gh pr lock blocked by push-gate (F2 push_or_pr_create)" \
  "$(mock_json 'Bash' 'gh pr lock 113')" "Post-implementation checkpoint required"
assert_blocked "28c. gh pr unlock blocked by push-gate (F2 push_or_pr_create)" \
  "$(mock_json 'Bash' 'gh pr unlock 113')" "Post-implementation checkpoint required"
# Subagent review on commit 8: gh pr update-branch is push_or_pr_create.
assert_blocked "28d. gh pr update-branch blocked by push-gate" \
  "$(mock_json 'Bash' 'gh pr update-branch 113')" "Post-implementation checkpoint required"
# Codex review on commit 8 (`...9fc4`): gh pr revert is push_or_pr_create.
assert_blocked "28e. gh pr revert blocked by push-gate" \
  "$(mock_json 'Bash' 'gh pr revert 113')" "Post-implementation checkpoint required"

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
echo "--- #65 R1: tightened allowlist — mention without write does NOT bypass ---"
# ============================================================================
reset_state
touch "$PRE_REQ"

# Pathological cases: command mentions marker name but doesn't write to it.
# Pre-tightening these would have bypassed the gate; post-tightening they block.
# #89 (Session 1): read-only commands that merely MENTION marker names
# (without writing to them) are now allowed. The classifier distinguishes
# string-content from actual redirects.
assert_allowed "45. Bash 'cat etc; echo .pre-checkpoint-done' allowed (no write)" \
  "$(mock_json 'Bash' "cat /etc/passwd; echo .pre-checkpoint-done")"
assert_allowed "46. Bash echo of marker name without redirect allowed (#89)" \
  "$(mock_json 'Bash' "echo .post-checkpoint-done")"
# Heredoc body without redirect still blocks (it's a write — `cat <<EOF` writes
# to stdout but classifier sees `cat` as read_only when no redirect target).
# Actually under #89: cat without redirect is read_only. Allow.
assert_allowed "47. Bash 'cat <<EOF' (heredoc as input, no redirect) allowed" \
  "$(mock_json 'Bash' "$(printf 'cat <<EOF\n.pre-checkpoint-done\nEOF')")"

# Legitimate writes still pass the tightened allowlist
assert_allowed "48. Bash '> .pre-checkpoint-done' allowed (redirect)" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE")"
# Session 1 (Codex ...3503 P1): writing POST_DONE without POST_REQ armed blocks.
assert_blocked "49. Bash '>> .post-checkpoint-done' BLOCKED (POST_REQ not armed)" \
  "$(mock_json 'Bash' "echo content >> $POST_DONE")" "Checkpoint required"
assert_blocked "50. Bash 'tee .post-checkpoint-done' BLOCKED (POST_REQ not armed)" \
  "$(mock_json 'Bash' "echo content | tee $POST_DONE")" "Checkpoint required"

# Codex round-1 F1 regression: nested marker-like paths under .checkpoints/
# or .claude/ must NOT pass the marker_write allowlist. Pre-fix the
# allowlist matched any descendant by basename; post-fix it requires an
# EXACT match against the canonical primary or legacy marker path.
#
# Rank-1 plan v7 update: descendants are now blocked by the new wrong-root
# helper (_is_wrong_root_marker_write) with a more specific reason that
# names the canonical path, NOT the generic "Checkpoint required" pre-gate
# reason. Behavior is strictly better (block reason is actionable). Assert
# the new reason substring.
mkdir -p "$MARKER_DIR/sub" "$LEGACY_MARKER_DIR/sub"
assert_blocked "50a. nested .checkpoints/sub/.pre-checkpoint-done — NOT allowed (F1)" \
  "$(mock_json 'Bash' "echo content > $MARKER_DIR/sub/.pre-checkpoint-done")" "non-canonical path"
assert_blocked "50b. nested .claude/sub/.pre-checkpoint-done — NOT allowed (F1)" \
  "$(mock_json 'Bash' "echo content > $LEGACY_MARKER_DIR/sub/.pre-checkpoint-done")" "non-canonical path"
# Edit tool path-equivalent of 50a
edit_nested_json=$(jq -nc --arg fp "$MARKER_DIR/sub/.pre-checkpoint-done" --arg cwd "$TEST_DIR" \
  '{tool_name: "Edit", tool_input: {file_path: $fp}, cwd: $cwd}')
assert_blocked "50c. Edit nested .checkpoints/sub/.pre-checkpoint-done — NOT allowed (F1)" \
  "$edit_nested_json" "non-canonical path"

# ============================================================================
echo ""
echo "--- #66: heredoc-body bypass blocked (pre-<< check) ---"
# ============================================================================
reset_state
touch "$PRE_REQ"

# Bypass attempt: command writes to readme.md, but heredoc body mentions
# `> .pre-checkpoint-done`. Pre-fix this would bypass the gate.
# Post-fix: only the pre-<< portion is checked → no marker redirect → block.
heredoc_bypass='cat > readme.md <<EOF
echo > .pre-checkpoint-done
EOF'
assert_blocked "54. Heredoc body mentioning marker redirect does NOT bypass" \
  "$(mock_json 'Bash' "$heredoc_bypass")" "Checkpoint required"

# Legitimate heredoc TO the marker: redirect target is in pre-<< portion → allow.
heredoc_legit='cat > '"$PRE_DONE"' <<EOF
Rule 18 checkpoint
EOF'
assert_allowed "55. Heredoc TO marker still allowed (redirect in pre-<< portion)" \
  "$(mock_json 'Bash' "$heredoc_legit")"

# Here-string to POST_DONE: per-marker prereq requires POST_REQ which isn't
# set in this test section (only PRE_REQ active) → blocks (Session 1 tightening).
herestring_legit='tee '"$POST_DONE"' <<<"checkpoint text"'
assert_blocked "56. Here-string to POST_DONE BLOCKED (POST_REQ not armed)" \
  "$(mock_json 'Bash' "$herestring_legit")" "Checkpoint required"

# Bypass attempt with here-string: < but no redirect to marker in pre-<<<
herestring_bypass='cat > readme.md <<<"echo > .pre-checkpoint-done"'
assert_blocked "57. Here-string body mentioning marker does NOT bypass" \
  "$(mock_json 'Bash' "$herestring_bypass")" "Checkpoint required"

# ============================================================================
echo ""
echo "--- #65 R2: push-gate boundary characters — quoted strings do NOT trigger ---"
# ============================================================================
reset_state
touch "$PRE_REQ"
echo "pre done" > "$PRE_DONE"
touch "$POST_REQ"

# The push-gate regex requires a boundary character ([[:space:]&;|()]) before
# `git push` / `gh pr create`. Quote characters are NOT in the boundary set,
# so `echo "git push"` and similar quoted mentions are NOT blocked. This is
# correct behavior — original R2 concern was unfounded; documenting the
# actual semantics with a regression guard.
assert_allowed "51. Bash echo of quoted 'git push' to other file NOT blocked" \
  "$(mock_json 'Bash' 'echo "git push origin main" > /tmp/note')"
assert_allowed "52. Bash printf with quoted 'gh pr create' NOT blocked" \
  "$(mock_json 'Bash' "printf 'gh pr create\\n' > /tmp/note")"

# But unquoted shell-tokenized git push IS blocked (correct)
assert_blocked "53. Bash with unquoted 'git push' (separate token) IS blocked" \
  "$(mock_json 'Bash' "git status && git push origin main")" "Post-implementation checkpoint required"

# ============================================================================
echo ""
echo "--- #68 F1: chained marker-write does NOT bypass gate ---"
# ============================================================================
# Pre-fix: `echo X > .pre-checkpoint-done; rm -rf /` passed the allowlist
# because the regex matched the redirect to the marker without anchoring
# end-of-HEAD. Post-fix: any control operator after the marker filename
# means no allowlist match → falls through to pre-gate block.
reset_state
touch "$PRE_REQ"

assert_blocked "64. marker-write THEN ; chained command — blocks (no bypass)" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE; rm -rf /tmp/IMPORTANT")" "Checkpoint required"
assert_blocked "65. marker-write THEN && chained command — blocks" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE && rm -rf /tmp/IMPORTANT")" "Checkpoint required"
assert_blocked "66. marker-write THEN || chained command — blocks" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE || rm -rf /tmp/IMPORTANT")" "Checkpoint required"
assert_blocked "67. marker-write THEN | piped command — blocks" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE | tee /tmp/log")" "Checkpoint required"
# Newline-chained variant (#72): grep -E line-by-line evaluation would
# otherwise let line 1 (the marker write) match alone.
assert_blocked "67b. marker-write THEN newline + ; chained — blocks (#72)" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE
; rm -rf /tmp/IMPORTANT")" "Checkpoint required"

# Push-gate variant: chained post-marker-write THEN git push must block
echo "pre done" > "$PRE_DONE"
touch "$POST_REQ"
assert_blocked "68. post-marker-write THEN ; git push — blocks (no bypass)" \
  "$(mock_json 'Bash' "echo post > $POST_DONE; git push origin main")" "Post-implementation checkpoint required"

# Legitimate single-statement marker-writes still pass (regression check)
reset_state
touch "$PRE_REQ"
assert_allowed "69. Pure echo > marker still allowed (regression)" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE")"
assert_allowed "70. Pure cat > marker <<EOF still allowed (regression)" \
  "$(mock_json 'Bash' "$(printf 'cat > %s <<EOF\nRule 18\nEOF' "$PRE_DONE")")"
assert_allowed "71. Pure tee marker <<<text still allowed (regression)" \
  "$(mock_json 'Bash' "tee $PRE_DONE <<<\"checkpoint\"")"
# Trailing whitespace after marker should still pass (legitimate noise)
assert_allowed "72. echo > marker followed only by whitespace still allowed" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE   ")"

# ============================================================================
echo ""
echo "--- #69 F2: push regex no longer matches non-push git subcommands ---"
# ============================================================================
# Pre-fix: `git[[:space:]]+([^&;|]*[[:space:]])?push` allowed any tokens
# between `git` and `push`, so `git commit -m push` and `git branch push`
# were false-positive blocked. Post-fix: only -X / --long / -X arg flag
# patterns allowed between git and push.
reset_state
touch "$PRE_REQ"
echo "pre done" > "$PRE_DONE"
touch "$POST_REQ"

# False positives that should now be allowed (no real git push)
assert_allowed "73. 'git commit -m push' NOT blocked (commit message contains 'push')" \
  "$(mock_json 'Bash' "git commit -m push")"
assert_allowed "74. 'git branch push' NOT blocked (branch named push)" \
  "$(mock_json 'Bash' "git branch push")"
assert_allowed "75. 'git stash push' NOT blocked (stash subcommand takes 'push')" \
  "$(mock_json 'Bash' "git stash push")"
assert_allowed "76. 'git tag push' NOT blocked (tag named push)" \
  "$(mock_json 'Bash' "git tag push")"

# Real git push commands STILL blocked (regression check)
assert_blocked "77. 'git push' IS blocked (regression)" \
  "$(mock_json 'Bash' "git push origin main")" "Post-implementation checkpoint required"
assert_blocked "78. 'git -C /path push' IS blocked (global flag with arg)" \
  "$(mock_json 'Bash' "git -C /tmp/repo push")" "Post-implementation checkpoint required"
assert_blocked "79. 'git --no-pager push' IS blocked (long flag)" \
  "$(mock_json 'Bash' "git --no-pager push")" "Post-implementation checkpoint required"
assert_blocked "80. 'gh pr create' IS blocked (regression)" \
  "$(mock_json 'Bash' "gh pr create --title x --body y")" "Post-implementation checkpoint required"

# ============================================================================
echo ""
echo "--- #73: heredoc + post-EOF chained command does NOT bypass ---"
# ============================================================================
# Pre-fix: cat > marker <<EOF\n...\nEOF\nrm -rf / had pre-<< portion that
# matched allowlist (`cat > marker `), and the post-EOF chained command
# (rm) ran unchecked. Post-fix: scan for non-whitespace content after the
# heredoc terminator line; if found, the allowlist won't match.
reset_state
touch "$PRE_REQ"

# Bypass attempts that should now block
heredoc_chain1="cat > $PRE_DONE <<EOF
rule18
EOF
rm -rf /tmp/IMPORTANT"
assert_blocked "81. heredoc + post-EOF ; chain — blocks (#73)" \
  "$(mock_json 'Bash' "$heredoc_chain1")" "Checkpoint required"

heredoc_chain2="cat > $PRE_DONE <<EOF
rule18
EOF
&& git push origin main"
assert_blocked "82. heredoc + post-EOF && chain — blocks" \
  "$(mock_json 'Bash' "$heredoc_chain2")" "Checkpoint required"

# <<- form (leading tabs allowed on terminator) with post content
# Session 1: classifier distinguishes chained-command intent. A chained
# read_only `echo leak` after a marker write is no longer treated as a
# bypass attempt — read_only chains cannot escalate the marker write to
# something dangerous. Adversarial chains that ARE writes (rm, git push,
# etc.) still escalate to shared_write/push_or_pr_create which block.
# These tests now assert the read-only-chain case allows.
heredoc_dash=$(printf 'cat > %s <<-EOF\n\tcontent\n\tEOF\necho leak' "$PRE_DONE")
assert_allowed "83. <<-EOF + read-only echo chain — allowed (read_only chain)" \
  "$(mock_json 'Bash' "$heredoc_dash")"

# Adversarial dash-EOF with rm chain still blocks (rm is shared_write).
heredoc_dash_evil=$(printf 'cat > %s <<-EOF\n\tcontent\n\tEOF\nrm -rf /tmp/IMPORTANT' "$PRE_DONE")
assert_blocked "83b. <<-EOF + rm chain — blocks (shared_write chain)" \
  "$(mock_json 'Bash' "$heredoc_dash_evil")" "Checkpoint required"

heredoc_quoted="cat > $PRE_DONE <<'EOF'
literal text
EOF
echo leak"
assert_allowed "84. <<'EOF' + read-only echo chain — allowed (read_only chain)" \
  "$(mock_json 'Bash' "$heredoc_quoted")"

heredoc_quoted_evil="cat > $PRE_DONE <<'EOF'
literal text
EOF
rm -rf /tmp/IMPORTANT"
assert_blocked "84b. <<'EOF' + rm chain — blocks (shared_write chain)" \
  "$(mock_json 'Bash' "$heredoc_quoted_evil")" "Checkpoint required"

# Pure heredoc (regression): no post-EOF content → still allowed
pure_heredoc="cat > $PRE_DONE <<EOF
rule18 checkpoint
EOF"
assert_allowed "85. Pure heredoc to marker (regression) — still allowed" \
  "$(mock_json 'Bash' "$pure_heredoc")"

# Pure heredoc with trailing whitespace/newline after EOF — still allowed
pure_heredoc_ws="cat > $PRE_DONE <<EOF
rule18
EOF

"
assert_allowed "86. Pure heredoc + trailing whitespace — still allowed" \
  "$(mock_json 'Bash' "$pure_heredoc_ws")"

# ============================================================================
echo ""
echo "--- #75: extended terminator forms also caught ---"
# ============================================================================
# Per Step-6 adversarial probe of #73 fix: <<\EOF (backslash-escaped) and
# <<123 (digit-start) terminators were valid bash forms my initial sed regex
# didn't extract, leaving the bypass open. Fix: more permissive terminator
# class allowing any non-whitespace non-special chars + optional leading \.

# <<\EOF (backslash-escaped) with post-EOF chain — should block
heredoc_backslash='cat > '"$PRE_DONE"' <<\EOF
rule18
EOF
rm -rf /tmp/IMPORTANT'
assert_blocked "87. <<\\EOF backslash-escaped terminator + chain — blocks (#75)" \
  "$(mock_json 'Bash' "$heredoc_backslash")" "Checkpoint required"

# <<123 (numeric-only terminator) with post chain
heredoc_numeric='cat > '"$PRE_DONE"' <<123
rule18
123
rm -rf /tmp/IMPORTANT'
assert_blocked "88. <<123 numeric-only terminator + chain — blocks (#75)" \
  "$(mock_json 'Bash' "$heredoc_numeric")" "Checkpoint required"

# <<==EOF== (special chars in terminator) — bash valid
heredoc_special='cat > '"$PRE_DONE"' <<==EOF==
rule18
==EOF==
rm -rf /tmp/IMPORTANT'
assert_blocked "89. <<==EOF== special-char terminator + chain — blocks (#75)" \
  "$(mock_json 'Bash' "$heredoc_special")" "Checkpoint required"

# Regression: <<\EOF without post-EOF content still allowed
heredoc_backslash_pure='cat > '"$PRE_DONE"' <<\EOF
literal $stuff
EOF'
assert_allowed "90. <<\\EOF without chain — still allowed (regression)" \
  "$(mock_json 'Bash' "$heredoc_backslash_pure")"

# ============================================================================
echo ""
echo "--- Hook composition with plan-gate.sh (RFC-002:215) ---"
# ============================================================================
# Spec requires both hooks compose correctly when registered together as
# PreToolUse hooks: each runs independently, blocks independently, and
# does not interfere with the other's marker state.
#
# This test exercises both hooks sequentially against a shared cwd to
# verify no cross-hook marker contamination and that error messages are
# distinguishable.
PLAN_GATE_REPO="$REPO_ROOT/hooks/plan-gate.sh"
PLAN_GATE_USER="$HOME/.claude/hooks/plan-gate.sh"
# Prefer a repo-staged copy if one ever lands at hooks/plan-gate.sh; otherwise
# fall back to the user-installed hook (same convention as tests/test-plan-gate.sh:10).
# Pre-fix this path was $REPO_ROOT/../plan-gate.sh — pointing at the
# worktrees parent dir, not the repo's hooks/ — never finding a future
# repo-staged copy. Latent until the user-installed copy is removed.
if [ -x "$PLAN_GATE_REPO" ]; then
  PLAN_GATE="$PLAN_GATE_REPO"
elif [ -x "$PLAN_GATE_USER" ]; then
  PLAN_GATE="$PLAN_GATE_USER"
else
  PLAN_GATE=""
fi

if [ -z "$PLAN_GATE" ]; then
  echo "  ⊘ Skipping composition tests — plan-gate.sh not found at $PLAN_GATE_REPO or $PLAN_GATE_USER"
else
  reset_state
  # .checkpoints/ migration: setup writes plan-marker at LEGACY (.claude/) to
  # exercise the dual-root fallback read; checkpoint-gate's reset_state no
  # longer mkdirs the legacy dir, so create it here.
  PLAN_MARKER="$TEST_DIR/.claude/.plan-approval-pending"
  mkdir -p "$TEST_DIR/.claude"
  touch "$PRE_REQ"
  touch "$PLAN_MARKER"

  # Both gates active: each fires its own block reason
  json=$(mock_json 'Edit')
  plan_out=$(echo "$json" | HOME="$TEST_HOME" bash "$PLAN_GATE" 2>/dev/null || true)
  if echo "$plan_out" | grep -q "Plan approval pending"; then
    echo "  ✓ 58. plan-gate blocks Edit when .plan-approval-pending exists"
    ((passed++))
  else
    echo "  ✗ 58. plan-gate did not block (output=$plan_out)"
    ((failed++))
  fi

  cp_out=$(echo "$json" | HOME="$TEST_HOME" bash "$HOOK" 2>/dev/null || true)
  if echo "$cp_out" | grep -q "Checkpoint required"; then
    echo "  ✓ 59. checkpoint-gate blocks Edit when .checkpoint-required exists"
    ((passed++))
  else
    echo "  ✗ 59. checkpoint-gate did not block (output=$cp_out)"
    ((failed++))
  fi

  # Distinct error messages — block reasons must be distinguishable
  if [ "$plan_out" != "$cp_out" ]; then
    echo "  ✓ 60. plan-gate and checkpoint-gate produce distinct block messages"
    ((passed++))
  else
    echo "  ✗ 60. block messages are identical"
    ((failed++))
  fi

  # No marker contamination — neither hook touched the other's marker
  if [ -f "$PLAN_MARKER" ] && [ -f "$PRE_REQ" ]; then
    echo "  ✓ 61. Both markers preserved after both hooks run (no cross-contamination)"
    ((passed++))
  else
    echo "  ✗ 61. Marker missing after composition (plan=$([ -f "$PLAN_MARKER" ] && echo Y || echo N) cp=$([ -f "$PRE_REQ" ] && echo Y || echo N))"
    ((failed++))
  fi

  # Clear plan marker — checkpoint-gate still blocks independently
  rm -f "$PLAN_MARKER"
  plan_out2=$(echo "$json" | HOME="$TEST_HOME" bash "$PLAN_GATE" 2>/dev/null || true)
  cp_out2=$(echo "$json" | HOME="$TEST_HOME" bash "$HOOK" 2>/dev/null || true)
  if [ -z "$plan_out2" ] && echo "$cp_out2" | grep -q "Checkpoint required"; then
    echo "  ✓ 62. checkpoint-gate continues to block after plan-gate marker cleared"
    ((passed++))
  else
    echo "  ✗ 62. independent operation broke (plan_out2=$plan_out2 cp_out2=$cp_out2)"
    ((failed++))
  fi
fi

# ============================================================================
echo ""
echo "--- #146 B1: block-reason includes ABSOLUTE marker path ---"
# ============================================================================
# Pre-fix (issue #146 live reproducer): block reason said
# ".claude/.pre-checkpoint-done" (relative). Agent in worktree cwd resolved
# the relative path against the worktree, which mismatched the gate's
# main-repo expectation, deadlocking. Fix: emit absolute marker path so
# the agent writes to the correct location regardless of cwd.
reset_state
touch "$PRE_REQ"
b1_out=$(echo "$(mock_json 'Edit')" | HOME="$TEST_HOME" bash "$HOOK" 2>/dev/null || true)
# .checkpoints/ migration: block reason embeds the PRIMARY write path so
# the agent writes to the new location.
B1_EXPECTED="$TEST_DIR/.checkpoints/.pre-checkpoint-done"
if echo "$b1_out" | grep -qF "$B1_EXPECTED"; then
  echo "  ✓ B1.pre. _block_pre reason embeds absolute pre-checkpoint path"
  ((passed++))
else
  echo "  ✗ B1.pre. expected absolute path '$B1_EXPECTED' in: $b1_out"
  ((failed++))
fi
# Defensive: the trigger marker .checkpoint-required still exists AND the
# asserted path string equals the gate's resolved $PRE_DONE constant.
if [ -f "$PRE_REQ" ] && [ "$PRE_DONE" = "$B1_EXPECTED" ]; then
  echo "  ✓ B1.pre (defensive): trigger marker present + path string matches \$PRE_DONE"
  ((passed++))
else
  echo "  ✗ B1.pre defensive: trigger=$([ -f "$PRE_REQ" ] && echo Y || echo N) PRE_DONE=$PRE_DONE expected=$B1_EXPECTED"
  ((failed++))
fi
# Plan-pending block reason also gets absolute path. Setup writes the
# legacy-path marker (exercises fallback read); block message references
# the PRIMARY write path (where the agent should put any new marker).
reset_state
touch "$PRE_REQ"
PLAN_MARKER_LEGACY="$TEST_DIR/.claude/.plan-approval-pending"
PLAN_MARKER_PRIMARY="$TEST_DIR/.checkpoints/.plan-approval-pending"
mkdir -p "$TEST_DIR/.claude"
touch "$PLAN_MARKER_LEGACY"
# A Bash command targeting the pre-checkpoint marker fires the
# plan-pending block (cross-gate invariant). Reason should embed
# the absolute PRIMARY plan-pending path.
plan_block_json=$(jq -nc \
  --arg cmd "echo block > $PRE_DONE" \
  --arg cwd "$TEST_DIR" \
  '{tool_name: "Bash", cwd: $cwd, tool_input: {command: $cmd}}')
plan_out=$(echo "$plan_block_json" | HOME="$TEST_HOME" bash "$HOOK" 2>/dev/null || true)
if echo "$plan_out" | grep -qF "$PLAN_MARKER_PRIMARY"; then
  echo "  ✓ B1.plan. _block_plan_pending reason embeds absolute plan-pending path (primary)"
  ((passed++))
else
  echo "  ✗ B1.plan. expected absolute path '$PLAN_MARKER_PRIMARY' in: $plan_out"
  ((failed++))
fi
rm -f "$PLAN_MARKER_LEGACY"

# ============================================================================
echo ""
echo "--- A8: hook does not pollute REPO_ROOT outside TEST_DIR ---"
# ============================================================================
# Regression guard mirroring test-em-recall-sessionstart.sh test 7. Snapshot
# REPO_ROOT contents before/after a hook invocation; assert no new entries.
REPO_ROOT_BEFORE=$(ls -A "$REPO_ROOT" | sort)
echo "$(mock_json 'Edit')" | HOME="$TEST_HOME" bash "$HOOK" >/dev/null 2>&1 || true
REPO_ROOT_AFTER=$(ls -A "$REPO_ROOT" | sort)
if [ "$REPO_ROOT_BEFORE" = "$REPO_ROOT_AFTER" ]; then
  echo "  ✓ 63. checkpoint-gate.sh does not pollute REPO_ROOT"
  ((passed++))
else
  echo "  ✗ 63. checkpoint-gate.sh polluted REPO_ROOT:"
  diff <(echo "$REPO_ROOT_BEFORE") <(echo "$REPO_ROOT_AFTER")
  ((failed++))
fi

# ============================================================================
echo ""
echo "--- B: Wrong-root marker write detection (rank-1 plan v7) ---"
# ============================================================================
# Codex-reviewed 7 rounds; final ACCEPT-with-FU at episode ...e19a.
# Tests the new helpers in checkpoint-gate.sh:
#   _marker_basename_in_set, _normalize_path_lexical, _is_canonical_marker_path,
#   _command_has_relative_marker_path, _block_wrong_root_marker,
#   _block_relative_marker_in_worktree, _is_wrong_root_marker_write.

reset_state

# B-tests need a SECOND cwd that is NOT the main repo root, to simulate
# worktree-cwd OR nested-cwd within main. Create both shapes.
WORKTREE_DIR="$(mktemp -d)"
WORKTREE_DIR="$(cd -P "$WORKTREE_DIR" && pwd)"
# Make WORKTREE_DIR a linked worktree of TEST_DIR (so resolve_repo_root from
# WORKTREE_DIR returns TEST_DIR via git-common-dir).
git -C "$TEST_DIR" config user.email t@t 2>/dev/null
git -C "$TEST_DIR" config user.name t 2>/dev/null
echo x > "$TEST_DIR/README.md"
git -C "$TEST_DIR" add . >/dev/null 2>&1
git -C "$TEST_DIR" commit -q -m init 2>/dev/null
rmdir "$WORKTREE_DIR"
git -C "$TEST_DIR" worktree add -q -b test-wt-branch "$WORKTREE_DIR" 2>/dev/null
WORKTREE_DIR="$(cd -P "$WORKTREE_DIR" && pwd)"

# Nested cwd inside main repo (codex F18)
NESTED_DIR="$TEST_DIR/subdir"
mkdir -p "$NESTED_DIR"

# Arm the gate (checkpoint-required), but DON'T pre-create pre-done — so
# the gate's pre-gate would block any allowed write. The B-tests assert
# the EARLIER wrong-root checks fire BEFORE the pre-gate, with their
# specific reason strings.
touch "$PRE_REQ"

mock_json_cwd() {
  local tool_name="$1" command="$2" cwd="$3"
  jq -n --arg tn "$tool_name" --arg cmd "$command" --arg cwd "$cwd" \
    '{tool_name: $tn, tool_input: {command: $cmd}, cwd: $cwd}'
}

mock_json_write() {
  local file_path="$1" cwd="$2"
  jq -n --arg fp "$file_path" --arg cwd "$cwd" \
    '{tool_name: "Write", tool_input: {file_path: $fp, content: "x"}, cwd: $cwd}'
}

# ---- Absolute-path wrong-root (codex F1/F7) ----

assert_blocked "B-1. Bash: rm worktree-absolute marker → wrong-root block" \
  "$(mock_json_cwd 'Bash' "rm $WORKTREE_DIR/.checkpoints/.pre-checkpoint-done" "$WORKTREE_DIR")" \
  "non-canonical path"

assert_blocked "B-2. Write: worktree-absolute marker → wrong-root block" \
  "$(mock_json_write "$WORKTREE_DIR/.checkpoints/.post-checkpoint-done" "$WORKTREE_DIR")" \
  "non-canonical path"

assert_blocked "B-3. Bash: outside-repo absolute marker → wrong-root block" \
  "$(mock_json_cwd 'Bash' "echo x > /tmp/.checkpoints/.pre-checkpoint-done" "$WORKTREE_DIR")" \
  "non-canonical path"

assert_blocked "B-4. Write: worktree legacy .claude/ absolute → wrong-root block" \
  "$(mock_json_write "$WORKTREE_DIR/.claude/.plan-approval-pending" "$WORKTREE_DIR")" \
  "non-canonical path"

# ---- No false-positive on canonical paths of markers outside the 3-marker
# allowlist (codex F7 — Bash redirects to canonical .checkpoint-required /
# .preflight-done / .last-user-prompt.*.json should NOT trigger wrong-root) ----
# Setup: satisfy pre-gate (PRE_DONE non-empty) so we test the WRONG-ROOT
# branch only, not the orthogonal pre-checkpoint pre-gate.
echo "pre-block" > "$PRE_DONE"

# Asserts that the SPECIFIC wrong-root block does NOT fire. Other blocks
# (push-gate, plan-gate) may still fire — we check the reason substring.
assert_no_wrong_root_block() {
  local test_name="$1"
  local json="$2"
  local output
  output=$(echo "$json" | run_hook 2>/dev/null)
  if echo "$output" | grep -qE 'non-canonical path|Relative marker reference'; then
    echo "  ✗ $test_name (wrong-root falsely fired): $output"
    ((failed++))
  else
    echo "  ✓ $test_name"
    ((passed++))
  fi
}

assert_no_wrong_root_block "B-5. Bash: canonical main .checkpoint-required (no FP)" \
  "$(mock_json_cwd 'Bash' "echo x > $MARKER_DIR/.checkpoint-required" "$TEST_DIR")"

assert_no_wrong_root_block "B-6. Bash: canonical main .preflight-done (no FP)" \
  "$(mock_json_cwd 'Bash' "echo x > $MARKER_DIR/.preflight-done" "$TEST_DIR")"

assert_no_wrong_root_block "B-7. Bash: canonical main .last-user-prompt (no FP)" \
  "$(mock_json_cwd 'Bash' "echo x > $MARKER_DIR/.last-user-prompt.json" "$TEST_DIR")"

# Restore pre-done empty for remaining tests (pre-gate state)
: > "$PRE_DONE"
rm -f "$PRE_DONE"

# ---- Relative-marker precheck from worktree cwd (codex F10, F12, F15) ----

assert_blocked "B-8. Bash: relative '> .checkpoints/<marker>' from worktree" \
  "$(mock_json_cwd 'Bash' 'echo x > .checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_allowed "B-9. Bash: relative '> .checkpoints/<marker>' from MAIN" \
  "$(mock_json_cwd 'Bash' "echo x > .checkpoints/.pre-checkpoint-done" "$TEST_DIR")"

assert_blocked "B-10. Bash: 'touch .checkpoints/<marker>' from worktree (F12 verb-agnostic)" \
  "$(mock_json_cwd 'Bash' 'touch .checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-11. Bash: 'mv /tmp/x .checkpoints/<marker>' from worktree" \
  "$(mock_json_cwd 'Bash' 'mv /tmp/x .checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-12. Bash: 'cp /tmp/x .checkpoints/<marker>' from worktree" \
  "$(mock_json_cwd 'Bash' 'cp /tmp/x .checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-13. Bash: 'dd of=.checkpoints/<marker>' from worktree" \
  "$(mock_json_cwd 'Bash' 'dd if=/tmp/x of=.checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-14. Bash: '> ./.checkpoints/<marker>' from worktree → block" \
  "$(mock_json_cwd 'Bash' 'echo x > ./.checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

# B-14b sanity: same shape from MAIN cwd → wrong-root block does NOT fire
# (CWD == REPO_ROOT means precheck skips; the pre-gate may still fire — we
# only assert the wrong-root reason is absent).
assert_no_wrong_root_block "B-14b. Bash: './.checkpoints/<marker>' from MAIN cwd → no wrong-root FP" \
  "$(mock_json_cwd 'Bash' 'echo x > ./.checkpoints/.pre-checkpoint-done' "$TEST_DIR")"

assert_blocked "B-15. Bash: 'rm .checkpoints/<marker>' from worktree" \
  "$(mock_json_cwd 'Bash' 'rm .checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

# ---- Codex F16 — verb fan-out: install, cat >>, heredoc ----

assert_blocked "B-16. Bash: 'install /tmp/x .checkpoints/<marker>' from worktree" \
  "$(mock_json_cwd 'Bash' 'install /tmp/x .checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-17. Bash: 'cat /tmp/x >> .checkpoints/<marker>' from worktree" \
  "$(mock_json_cwd 'Bash' 'cat /tmp/x >> .checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

# B-18 (codex F16 heredoc): DEFERRED — classifier mis-labels
# `cat <<EOF > .checkpoints/<marker>\nx\nEOF` as read_only, so the precheck
# (which only runs for non-read_only) doesn't fire. This is a classifier
# bug separate from the wrong-root cluster. Tracked as FU: "classifier
# heredoc-with-redirect mis-classification" (see PR description).
# The 7 other verbs (touch, mv, cp, install, dd, redirect, rm, tee, cat>>)
# are covered by B-8/B-10/B-11/B-12/B-13/B-14/B-15/B-16/B-17.

# ---- Codex F15 — `./` and `././` prefix chains ----

assert_blocked "B-19. Bash: '> ./.checkpoints/<marker>' worktree" \
  "$(mock_json_cwd 'Bash' 'echo x > ./.checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

# B-20 is the canonical-main same shape allowed; B-14b above covers it. Skip duplicate.

assert_blocked "B-21. Bash: '> ././.checkpoints/<marker>' worktree (chained ./)" \
  "$(mock_json_cwd 'Bash' 'echo x > ././.checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-22. Bash: 'touch ./.checkpoints/<marker>' worktree (./ + touch)" \
  "$(mock_json_cwd 'Bash' 'touch ./.checkpoints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

# ---- Codex F18 — nested-cwd (not a worktree, just inside main repo) ----

assert_blocked "B-23. Bash: relative marker from nested cwd inside main repo" \
  "$(mock_json_cwd 'Bash' 'echo x > .checkpoints/.pre-checkpoint-done' "$NESTED_DIR")" \
  "Relative marker reference"

# Disk assertions (B-23a/b/c): block didn't write either nested or canonical
assert_marker_absent "B-23a. After B-23: nested marker NOT created" \
  "$NESTED_DIR/.checkpoints/.pre-checkpoint-done"
assert_marker_absent "B-23b. After B-23: canonical marker NOT created (no PRE_DONE write)" \
  "$PRE_DONE"
assert_marker_exists "B-23c. After B-23: trigger marker (PRE_REQ) preserved" \
  "$PRE_REQ"

# ---- Code-review A1 — quote-broken bypasses ----
# Bash quoting that breaks the contiguous `.checkpoints/<marker>` substring
# must still be detected because the shell evaluates the quotes before
# the actual write occurs.

assert_blocked "B-24 (A1). Bash: touch with double-quoted .checkpoints from worktree" \
  "$(mock_json_cwd 'Bash' 'touch ".checkpoints"/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-25 (A1). Bash: touch with single-quoted .checkpoints from worktree" \
  "$(mock_json_cwd 'Bash' "touch '.checkpoints'/.pre-checkpoint-done" "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-26 (A1). Bash: echo with single-quoted marker basename from worktree" \
  "$(mock_json_cwd 'Bash' "echo x > .checkpoints/'.pre-checkpoint-done'" "$WORKTREE_DIR")" \
  "Relative marker reference"

assert_blocked "B-27 (A1). Bash: backslash-broken marker from worktree" \
  "$(mock_json_cwd 'Bash' 'touch .checkpo\ints/.pre-checkpoint-done' "$WORKTREE_DIR")" \
  "Relative marker reference"

# ---- Code-review A2 — absolute non-canonical from MAIN cwd (shared_write verbs) ----
# Pre-fix the absolute-noncanonical detection was gated on CWD != REPO_ROOT,
# so `touch /tmp/.checkpoints/<marker>` from main cwd fell through to
# shared_write -> pre-gate. Now it must block as wrong-root.

assert_blocked "B-28 (A2). Bash: touch /tmp/.checkpoints/<marker> from MAIN cwd" \
  "$(mock_json_cwd 'Bash' "touch /tmp/.checkpoints/.pre-checkpoint-done" "$TEST_DIR")" \
  "non-canonical path"

assert_blocked "B-29 (A2). Bash: mv to /tmp/.checkpoints/<marker> from MAIN cwd" \
  "$(mock_json_cwd 'Bash' "mv /tmp/x /tmp/.checkpoints/.pre-checkpoint-done" "$TEST_DIR")" \
  "non-canonical path"

assert_blocked "B-30 (A2). Bash: cp to /tmp/.checkpoints/<marker> from MAIN cwd" \
  "$(mock_json_cwd 'Bash' "cp /tmp/x /tmp/.checkpoints/.pre-checkpoint-done" "$TEST_DIR")" \
  "non-canonical path"

assert_blocked "B-31 (A2). Bash: install to /tmp/.checkpoints/<marker> from MAIN cwd" \
  "$(mock_json_cwd 'Bash' "install /tmp/x /tmp/.checkpoints/.pre-checkpoint-done" "$TEST_DIR")" \
  "non-canonical path"

assert_blocked "B-32 (A2). Bash: dd of=/tmp/.checkpoints/<marker> from MAIN cwd" \
  "$(mock_json_cwd 'Bash' "dd if=/tmp/x of=/tmp/.checkpoints/.pre-checkpoint-done" "$TEST_DIR")" \
  "non-canonical path"

# A2 no-FP: canonical absolute marker from MAIN cwd should still NOT
# trigger the wrong-root block (predicate filters canonical paths).
assert_no_wrong_root_block "B-33 (A2 no-FP). Bash: touch on canonical $MARKER_DIR/<marker> from MAIN cwd" \
  "$(mock_json_cwd 'Bash' "touch $MARKER_DIR/.checkpoint-required" "$TEST_DIR")"

# ---- PR-level review P1 regression — occurrence-scoped relative-vs-absolute ----
# Codex caught: a benign mention of `./<absolute-path>` in part of the command
# was making the global filter skip the absolute-write check for the WHOLE
# command, allowing a separate real wrong-root write elsewhere.

assert_blocked "B-34 (codex PR P1). benign mention + real wrong-root write → still blocks" \
  "$(mock_json_cwd 'Bash' "echo ./tmp/.checkpoints/.pre-checkpoint-done >/dev/null; touch /tmp/.checkpoints/.pre-checkpoint-done" "$TEST_DIR")" \
  "non-canonical path"

# Defensive: pure benign mention (no real write) should still NOT block
# (avoid over-correction — we want occurrence-scoped, not blunt always-block)
assert_no_wrong_root_block "B-35 (codex PR P1 no-FP). pure relative mention without absolute write → no block" \
  "$(mock_json_cwd 'Bash' "echo x > ./.checkpoints/.pre-checkpoint-done" "$TEST_DIR")"

# B-36 (codex PR round-2 P1): bash pattern substitution glob bypass.
# Pre-fix: `${cmd//\.${p}/}` interpreted `*` in $p as glob, over-matching
# both the relative mention AND the absolute write occurrences, defeating
# the occurrence-scoped check. With glob-escape, `$p` is treated literally.
assert_blocked "B-36 (codex PR round-2 P1). glob-metachar bypass → still blocks" \
  "$(mock_json_cwd 'Bash' "echo ./tmp/emglob*/.checkpoints/.pre-checkpoint-done >/dev/null; touch /tmp/emglob*/.checkpoints/.pre-checkpoint-done" "$TEST_DIR")" \
  "non-canonical path"

# B-37 (codex PR round-2 P1 no-FP): pure relative glob-metachar mention
# from main cwd should still NOT block (pattern literal in residual check).
assert_no_wrong_root_block "B-37 (codex PR round-2 P1 no-FP). pure relative glob mention → no block" \
  "$(mock_json_cwd 'Bash' "echo x > ./.checkpoints/.pre-checkpoint-done; echo also ./tmp/glob?/.checkpoints/.checkpoint-required" "$TEST_DIR")"

# Cleanup B-test worktree
git -C "$TEST_DIR" worktree remove --force "$WORKTREE_DIR" 2>/dev/null
git -C "$TEST_DIR" branch -D test-wt-branch 2>/dev/null

# ============================================================================
# B-S: paths-with-spaces wrong-root detector (codex R1-R8 / PR #<TBD>)
#
# Covers the bug class where `_command_first_absolute_noncanonical_marker`
# truncated absolute marker paths at the first whitespace, breaking marker
# operations in any repo whose absolute path contains a space (e.g.
# "Home Network Improvement").
#
# Implementation: three-pass per-token scan (whole-token equality, key=path
# walk, substring-regex with canonical short-circuit + relative disambig).
# ============================================================================

# ---- B-S helpers ----

# Run hook from an explicit caller process cwd (different from JSON .cwd) so
# B-S9 / B-S13 / B-S26 actually exercise the caller-cwd ≠ JSON-cwd axis.
run_hook_from_cwd() {
  local caller_cwd="$1"
  (cd "$caller_cwd" && HOME="$TEST_HOME" bash "$HOOK")
}

# Assert hook blocks AND reason JSON contains BOTH expected-attempted and
# expected-canonical path literals (substring match via grep -qF / jq -r).
assert_blocked_with_reason() {
  local test_name="$1" json="$2" expected_attempted="$3" expected_canonical="$4"
  local output reason exit_code=0
  output=$(echo "$json" | run_hook 2>/dev/null) || exit_code=$?
  if ! echo "$output" | grep -q '"decision".*"block"'; then
    echo "  ✗ $test_name (expected block; exit=$exit_code output=$output)"
    ((failed++))
    return
  fi
  reason=$(echo "$output" | jq -r '.reason // ""' 2>/dev/null)
  if [ -z "$reason" ] || ! printf '%s' "$reason" | grep -qF -- "$expected_attempted"; then
    echo "  ✗ $test_name (reason missing attempted='$expected_attempted'): $reason"
    ((failed++))
    return
  fi
  if ! printf '%s' "$reason" | grep -qF -- "$expected_canonical"; then
    echo "  ✗ $test_name (reason missing canonical='$expected_canonical'): $reason"
    ((failed++))
    return
  fi
  echo "  ✓ $test_name"
  ((passed++))
}

# Paired disk assertion (B-S26): target marker exists (fixture-seeded);
# caller cwd has no leaked .checkpoints/ dir.
assert_disk_artifacts() {
  local test_name="$1" target_marker_path="$2" caller_cwd="$3"
  if [ ! -e "$target_marker_path" ]; then
    echo "  ✗ $test_name (target marker missing: $target_marker_path)"
    ((failed++))
    return
  fi
  if [ -e "$caller_cwd/.checkpoints" ]; then
    echo "  ✗ $test_name (caller-cwd leak: $(ls -la "$caller_cwd/.checkpoints" 2>&1))"
    ((failed++))
    return
  fi
  echo "  ✓ $test_name (disk artifacts: target=$target_marker_path, caller no-leak)"
  ((passed++))
}

# ---- B-S fixture: spacey main repo + spacey linked worktree ----

SPACE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/em-space test.XXXXXX")"
SPACE_DIR="$(cd -P "$SPACE_DIR" && pwd)"
git -C "$SPACE_DIR" init -q 2>/dev/null
mkdir -p "$SPACE_DIR/.checkpoints"
touch "$SPACE_DIR/.checkpoints/.checkpoint-required"
git -C "$SPACE_DIR" -c user.email=t@t.test -c user.name=test commit --allow-empty -m init -q

SPACE_DIR_WT="$(mktemp -d "${TMPDIR:-/tmp}/em-space wt.XXXXXX")"
SPACE_DIR_WT="$(cd -P "$SPACE_DIR_WT" && pwd)"
rmdir "$SPACE_DIR_WT"

# R6 P1.1: explicit -b avoids invalid-ref-name from spacey basename
# (git would otherwise infer the branch as `em-space wt.xxxx` and fail).
if ! git -C "$SPACE_DIR" worktree add -b test-spacey-wt-branch "$SPACE_DIR_WT" -q; then
  echo "FAIL: B-S fixture: git worktree add failed (spacey basename branch-inference bug?)"
  exit 1
fi

# Fixture precondition: worktree's git-common-dir resolves to main repo.
B_S_EXPECTED_COMMON_DIR="$SPACE_DIR/.git"
B_S_ACTUAL_COMMON_DIR="$(git -C "$SPACE_DIR_WT" rev-parse --git-common-dir)"
case "$B_S_ACTUAL_COMMON_DIR" in
  /*) ;;
  *) B_S_ACTUAL_COMMON_DIR="$SPACE_DIR_WT/$B_S_ACTUAL_COMMON_DIR" ;;
esac
B_S_ACTUAL_COMMON_DIR="$(cd -P "$B_S_ACTUAL_COMMON_DIR" 2>/dev/null && pwd)" || true
if [ "$B_S_ACTUAL_COMMON_DIR" != "$B_S_EXPECTED_COMMON_DIR" ]; then
  echo "FAIL: B-S fixture: common-dir resolved to '$B_S_ACTUAL_COMMON_DIR'; expected '$B_S_EXPECTED_COMMON_DIR'"
  exit 1
fi

# Nested subdir under spacey repo (for B-S11).
SPACE_DIR_NESTED="$SPACE_DIR/sub dir"
mkdir -p "$SPACE_DIR_NESTED"

# Clean-name canonical repo (for B-S16): canonical bash -c without spaces.
CLEAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/em-clean.XXXXXX")"
CLEAN_DIR="$(cd -P "$CLEAN_DIR" && pwd)"
git -C "$CLEAN_DIR" init -q 2>/dev/null
mkdir -p "$CLEAN_DIR/.checkpoints"

# ---- B-S cases ----

# B-S1: quoted canonical absolute path-with-space → no wrong-root block
assert_no_wrong_root_block "B-S1. Quoted canonical path-with-space" \
  "$(mock_json_cwd 'Bash' "rm \"$SPACE_DIR/.checkpoints/.plan-approval-pending\"" "$SPACE_DIR")"

# B-S2: quoted non-canonical absolute path-with-space (different repo) → BLOCK
assert_blocked_with_reason "B-S2. Quoted non-canonical path-with-space" \
  "$(mock_json_cwd 'Bash' "rm \"/tmp/some other repo/.checkpoints/.pre-checkpoint-done\"" "$SPACE_DIR")" \
  "/tmp/some other repo/.checkpoints/.pre-checkpoint-done" \
  "$SPACE_DIR/.checkpoints/.pre-checkpoint-done"

# B-S3: touch quoted canonical with space → allow
assert_no_wrong_root_block "B-S3. touch quoted canonical with space" \
  "$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR")"

# B-S4: redirect to quoted canonical with space → allow
assert_no_wrong_root_block "B-S4. Redirect to quoted canonical with space" \
  "$(mock_json_cwd 'Bash' "echo done > \"$SPACE_DIR/.checkpoints/.pre-checkpoint-done\"" "$SPACE_DIR")"

# B-S5: cp to quoted non-canonical /tmp marker path-with-space → BLOCK
assert_blocked_with_reason "B-S5. cp to non-canonical /tmp path-with-space" \
  "$(mock_json_cwd 'Bash' "cp /etc/hosts \"/tmp/wrong dir/.checkpoints/.plan-approval-pending\"" "$SPACE_DIR")" \
  "/tmp/wrong dir/.checkpoints/.plan-approval-pending" \
  "$SPACE_DIR/.checkpoints/.plan-approval-pending"

# B-S6: single-quoted non-canonical absolute path-with-space → BLOCK
assert_blocked_with_reason "B-S6. Single-quoted non-canonical path-with-space" \
  "$(mock_json_cwd 'Bash' "rm '/tmp/another dir/.checkpoints/.post-checkpoint-done'" "$SPACE_DIR")" \
  "/tmp/another dir/.checkpoints/.post-checkpoint-done" \
  "$SPACE_DIR/.checkpoints/.post-checkpoint-done"

# B-S7: multiple markers; first is non-canonical → BLOCK
assert_blocked_with_reason "B-S7. Multiple markers, first non-canonical" \
  "$(mock_json_cwd 'Bash' "rm '/tmp/wrong/.checkpoints/.pre-checkpoint-done' \"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR")" \
  "/tmp/wrong/.checkpoints/.pre-checkpoint-done" \
  "$SPACE_DIR/.checkpoints/.pre-checkpoint-done"

# B-S8: regression — unquoted absolute non-canonical (no spaces) → still BLOCK
assert_blocked_with_reason "B-S8. Regression: unquoted absolute non-canonical (no spaces)" \
  "$(mock_json_cwd 'Bash' "rm /tmp/nospaces/.checkpoints/.plan-approval-pending" "$SPACE_DIR")" \
  "/tmp/nospaces/.checkpoints/.plan-approval-pending" \
  "$SPACE_DIR/.checkpoints/.plan-approval-pending"

# B-S9: caller process cwd ≠ JSON cwd; canonical-with-spaces target → allow + no leak
B_S9_JSON="$(mock_json_cwd 'Bash' "rm \"$SPACE_DIR/.checkpoints/.plan-approval-pending\"" "$SPACE_DIR")"
B_S9_OUT=$(echo "$B_S9_JSON" | run_hook_from_cwd "/tmp" 2>/dev/null)
if echo "$B_S9_OUT" | grep -qE 'non-canonical path|Relative marker reference'; then
  echo "  ✗ B-S9. Caller cwd=/tmp, JSON cwd=spacey (wrong-root falsely fired): $B_S9_OUT"
  ((failed++))
else
  echo "  ✓ B-S9. Caller cwd=/tmp, JSON cwd=spacey (no wrong-root block)"
  ((passed++))
fi
if [ -e "/tmp/.checkpoints" ]; then
  echo "  ✗ B-S9 (leak: /tmp/.checkpoints exists)"
  ((failed++))
else
  echo "  ✓ B-S9 (no caller-cwd leak)"
  ((passed++))
fi

# B-S10: linked worktree (both spacey, no-space marker in path) → allow
assert_no_wrong_root_block "B-S10. Linked worktree (spacey), main canonical marker" \
  "$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR_WT")"

# B-S11: nested cwd under spacey repo → allow
assert_no_wrong_root_block "B-S11. Nested cwd under spacey repo" \
  "$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR_NESTED")"

# B-S12: non-git JSON cwd, target=non-canonical with spaces → BLOCK
assert_blocked_with_reason "B-S12. Non-git JSON cwd, target non-canonical" \
  "$(mock_json_cwd 'Bash' "rm \"/tmp/no-repo/.checkpoints/.pre-checkpoint-done\"" "/tmp")" \
  "/tmp/no-repo/.checkpoints/.pre-checkpoint-done" \
  "/tmp/.checkpoints/.pre-checkpoint-done"

# B-S13: subprocess wrong-cwd inheritance — binds to JSON cwd, not process cwd
B_S13_JSON="$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR")"
B_S13_OUT=$(echo "$B_S13_JSON" | run_hook_from_cwd "/tmp" 2>/dev/null)
if echo "$B_S13_OUT" | grep -qE 'non-canonical path|Relative marker reference'; then
  echo "  ✗ B-S13. Subprocess wrong-cwd inheritance (wrong-root falsely fired): $B_S13_OUT"
  ((failed++))
else
  echo "  ✓ B-S13. Subprocess wrong-cwd inheritance (binds to JSON cwd)"
  ((passed++))
fi

# B-S14: bash -c "touch /no-space/.checkpoints/.X" non-canonical → BLOCK (Pass B)
assert_blocked_with_reason "B-S14. bash -c non-canonical no-space" \
  "$(mock_json_cwd 'Bash' 'bash -c "touch /tmp/no-space/.checkpoints/.pre-checkpoint-done"' "$SPACE_DIR")" \
  "/tmp/no-space/.checkpoints/.pre-checkpoint-done" \
  "$SPACE_DIR/.checkpoints/.pre-checkpoint-done"

# B-S15: sh -c "rm /no-space/.checkpoints/.X" → BLOCK
assert_blocked_with_reason "B-S15. sh -c non-canonical no-space" \
  "$(mock_json_cwd 'Bash' 'sh -c "rm /tmp/other-non-canon/.checkpoints/.post-checkpoint-done"' "$SPACE_DIR")" \
  "/tmp/other-non-canon/.checkpoints/.post-checkpoint-done" \
  "$SPACE_DIR/.checkpoints/.post-checkpoint-done"

# B-S16: bash -c canonical (no-space cwd) → allow (Pass B canonical equality)
assert_no_wrong_root_block "B-S16. bash -c canonical no-space" \
  "$(mock_json_cwd 'Bash' "bash -c \"touch $CLEAN_DIR/.checkpoints/.pre-checkpoint-done\"" "$CLEAN_DIR")"

# B-S17: dd of="<canonical spacey>" → allow (Pass A')
assert_no_wrong_root_block "B-S17. dd of= canonical spacey" \
  "$(mock_json_cwd 'Bash' "dd if=/dev/null of=\"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR")"

# B-S18: dd of="/tmp/wrong path/.X" non-canonical with spaces → BLOCK with full attempted
assert_blocked_with_reason "B-S18. dd of= non-canonical spacey" \
  "$(mock_json_cwd 'Bash' "dd if=/dev/null of=\"/tmp/wrong path/.checkpoints/.pre-checkpoint-done\"" "$SPACE_DIR")" \
  "/tmp/wrong path/.checkpoints/.pre-checkpoint-done" \
  "$SPACE_DIR/.checkpoints/.pre-checkpoint-done"

# B-S19: --output= non-canonical spacey → BLOCK
assert_blocked_with_reason "B-S19. --output= non-canonical spacey" \
  "$(mock_json_cwd 'Bash' "tool --output=\"/sp path/.checkpoints/.plan-approval-pending\"" "$SPACE_DIR")" \
  "/sp path/.checkpoints/.plan-approval-pending" \
  "$SPACE_DIR/.checkpoints/.plan-approval-pending"

# B-S20: --output= canonical spacey → allow
assert_no_wrong_root_block "B-S20. --output= canonical spacey" \
  "$(mock_json_cwd 'Bash' "tool --output=\"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR")"

# B-S21: P2 relative-token disambiguation inside bash -c payload from main cwd
assert_no_wrong_root_block "B-S21. P2 relative-token disambiguation" \
  "$(mock_json_cwd 'Bash' "bash -c \"echo ./tmp/.checkpoints/.pre-checkpoint-done >/dev/null\"" "$SPACE_DIR")"

# B-S22: P1 canonical short-circuit (whole-token Pass A) — verifies that
# Pass B does NOT then false-positive on the same token by truncating spaces.
assert_no_wrong_root_block "B-S22. P1 canonical short-circuit Pass A" \
  "$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR/.checkpoints/.plan-approval-pending\"" "$SPACE_DIR")"

# B-S23: P1 canonical short-circuit (Pass A' key=path) — same invariant
assert_no_wrong_root_block "B-S23. P1 canonical short-circuit Pass A'" \
  "$(mock_json_cwd 'Bash' "dd if=/dev/null of=\"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR")"

# B-S24: main repo spacey + linked worktree spacey; write MAIN canonical → allow
assert_no_wrong_root_block "B-S24. Worktree spacey, MAIN canonical target" \
  "$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR_WT")"

# B-S25: write WORKTREE-LOCAL absolute marker → BLOCK with full attempted+canonical
assert_blocked_with_reason "B-S25. Worktree spacey, WORKTREE-LOCAL target" \
  "$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR_WT/.checkpoints/.checkpoint-required\"" "$SPACE_DIR_WT")" \
  "$SPACE_DIR_WT/.checkpoints/.checkpoint-required" \
  "$SPACE_DIR/.checkpoints/.checkpoint-required"

# B-S26: paired target + caller disk assertion
B_S26_CALLER_CWD="$(mktemp -d "${TMPDIR:-/tmp}/em-caller.XXXXXX")"
B_S26_CALLER_CWD="$(cd -P "$B_S26_CALLER_CWD" && pwd)"
B_S26_JSON="$(mock_json_cwd 'Bash' "touch \"$SPACE_DIR/.checkpoints/.checkpoint-required\"" "$SPACE_DIR_WT")"
B_S26_OUT=$(echo "$B_S26_JSON" | run_hook_from_cwd "$B_S26_CALLER_CWD" 2>/dev/null)
if echo "$B_S26_OUT" | grep -qE 'non-canonical path|Relative marker reference'; then
  echo "  ✗ B-S26. Disk-paired allow (wrong-root falsely fired): $B_S26_OUT"
  ((failed++))
else
  echo "  ✓ B-S26. Disk-paired allow (no wrong-root block from caller cwd)"
  ((passed++))
fi
assert_disk_artifacts "B-S26. Paired disk artifacts" \
  "$SPACE_DIR/.checkpoints/.checkpoint-required" \
  "$B_S26_CALLER_CWD"
rm -rf "$B_S26_CALLER_CWD"

# ---- B-S cleanup ----
git -C "$SPACE_DIR" worktree remove --force "$SPACE_DIR_WT" 2>/dev/null
git -C "$SPACE_DIR" branch -D test-spacey-wt-branch 2>/dev/null
rm -rf "$SPACE_DIR" "$CLEAN_DIR"

# ============================================================================
echo ""
echo "--- Result ---"
# ============================================================================
# ============================================================================
echo ""
echo "--- Smart-arming (off-repo Edit/Write allow, codex R1-R6 consensus) ---"
# ============================================================================
# PR fix/checkpoint-gate-smart-arming. Stops checkpoint-gate from firing on
# off-repo Edit/Write/MultiEdit/NotebookEdit while preserving Rule 18
# enforcement for in-repo edits. Bash side stays strict (codex R1 6b).

# Helper: emit mock JSON for Edit/Write with explicit file_path and optional
# cwd variations. Existing mock_json hardcodes .cwd=TEST_DIR — for cwd-binding
# tests we need cwd permutations.
mock_path_json() {
  local tool_name="$1" file_path="$2" top_cwd="${3:-$TEST_DIR}" ti_cwd="${4:-}"
  if [ -n "$ti_cwd" ]; then
    jq -n --arg tn "$tool_name" --arg fp "$file_path" --arg c "$top_cwd" --arg tic "$ti_cwd" \
      '{tool_name: $tn, tool_input: {file_path: $fp, cwd: $tic}, cwd: $c}'
  else
    jq -n --arg tn "$tool_name" --arg fp "$file_path" --arg c "$top_cwd" \
      '{tool_name: $tn, tool_input: {file_path: $fp}, cwd: $c}'
  fi
}

# Smart-arming test scratch dirs (off-repo paths that mimic the user's
# real-world ~/.claude/projects/** and ~/.claude/skills/** layout).
OFFREPO_DIR="$(mktemp -d)"
OFFREPO_DIR="$(cd -P "$OFFREPO_DIR" && pwd)"

reset_state
touch "$PRE_REQ"  # arm — pre-block fires unless predicate allows

# ── In-repo edits still block ──
assert_blocked "SA-1. Edit IN-REPO existing file BLOCKED (smart-arming preserves Rule 18)" \
  "$(mock_path_json 'Edit' "$TEST_DIR/scripts-test.mjs")" "Checkpoint required"
assert_blocked "SA-2. Write IN-REPO NONEXISTENT new file BLOCKED (R2/P1 nonexistent-path)" \
  "$(mock_path_json 'Write' "$TEST_DIR/new-scripts/new.mjs")" "Checkpoint required"
assert_blocked "SA-3. Write IN-REPO deep nonexistent ancestor chain BLOCKED" \
  "$(mock_path_json 'Write' "$TEST_DIR/new-dir/sub/deep.mjs")" "Checkpoint required"
assert_blocked "SA-4. MultiEdit IN-REPO file BLOCKED (single file_path, R1/P2 shape)" \
  "$(mock_path_json 'MultiEdit' "$TEST_DIR/existing.txt")" "Checkpoint required"

# ── Off-repo edits now allowed ──
assert_allowed "SA-5. Edit OFF-REPO memory-style path allowed (.claude/projects)" \
  "$(mock_path_json 'Edit' "$OFFREPO_DIR/memory/foo.md")"
assert_allowed "SA-6. Write OFF-REPO skill-style path allowed (.claude/skills)" \
  "$(mock_path_json 'Write' "$OFFREPO_DIR/skills/foo/SKILL.md")"
assert_allowed "SA-7. Edit OFF-REPO settings-style path allowed (.claude/settings.local.json)" \
  "$(mock_path_json 'Edit' "$OFFREPO_DIR/settings.local.json")"
assert_allowed "SA-8. MultiEdit OFF-REPO single file allowed" \
  "$(mock_path_json 'MultiEdit' "$OFFREPO_DIR/memory/bar.md")"
assert_allowed "SA-9. NotebookEdit OFF-REPO ipynb allowed (uses notebook_path field per F1 fix)" \
  "$(jq -n --arg tn 'NotebookEdit' --arg np "$OFFREPO_DIR/notebook.ipynb" --arg c "$TEST_DIR" \
    '{tool_name: $tn, tool_input: {notebook_path: $np}, cwd: $c}')"
assert_blocked "SA-9b. NotebookEdit IN-REPO ipynb BLOCKED (notebook_path field reaches predicate)" \
  "$(jq -n --arg tn 'NotebookEdit' --arg np "$TEST_DIR/in-repo.ipynb" --arg c "$TEST_DIR" \
    '{tool_name: $tn, tool_input: {notebook_path: $np}, cwd: $c}')" "Checkpoint required"

# ── Path-traversal attack: traversal that lands back in repo blocks ──
TRAVERSAL_PATH="$TEST_DIR/../$(basename "$TEST_DIR")/traversal.mjs"
assert_blocked "SA-10. Edit via traversal back into repo BLOCKED (canonicalize handles)" \
  "$(mock_path_json 'Edit' "$TRAVERSAL_PATH")" "Checkpoint required"

# ── Symlink axis tests (codex R1-R6 driven) ──
# Axis 2 (R2/P1): external symlink FILE → existing repo file
echo "in-repo content" > "$TEST_DIR/existing.txt"
SYM_FILE_TO_REPO="$OFFREPO_DIR/link-to-repo-file"
ln -sf "$TEST_DIR/existing.txt" "$SYM_FILE_TO_REPO"
assert_blocked "SA-sym2. External symlink FILE → existing repo file BLOCKED (axis 2)" \
  "$(mock_path_json 'Edit' "$SYM_FILE_TO_REPO")" "Checkpoint required"

# Axis 3: external symlink DIR → existing repo child
mkdir -p "$TEST_DIR/scripts-test-dir"
echo "child content" > "$TEST_DIR/scripts-test-dir/child.mjs"
SYM_DIR_TO_REPO="$OFFREPO_DIR/link-to-repo-dir"
ln -sfn "$TEST_DIR/scripts-test-dir" "$SYM_DIR_TO_REPO"
assert_blocked "SA-sym3. External symlink DIR → existing repo child BLOCKED (axis 3)" \
  "$(mock_path_json 'Edit' "$SYM_DIR_TO_REPO/child.mjs")" "Checkpoint required"

# Axis 1 (R3/P1): external BROKEN symlink → nonexistent repo target
SYM_BROKEN_TO_REPO="$OFFREPO_DIR/broken-link-to-repo"
ln -sf "$TEST_DIR/nonexistent-future.mjs" "$SYM_BROKEN_TO_REPO"
assert_blocked "SA-sym1. External broken symlink → nonexistent repo target BLOCKED (axis 1, R3/P1)" \
  "$(mock_path_json 'Edit' "$SYM_BROKEN_TO_REPO")" "Checkpoint required"

# Axis 4: internal symlink → outside repo (symlink-out, raw-path-prefix match)
SYM_REPO_OUT="$TEST_DIR/link-pointing-out.mjs"
ln -sf "$OFFREPO_DIR/external-target.mjs" "$SYM_REPO_OUT"
assert_blocked "SA-sym4. Internal symlink-out: raw repo path BLOCKED (author intent, axis 4)" \
  "$(mock_path_json 'Edit' "$SYM_REPO_OUT")" "Checkpoint required"

# Axis 5: symlinked ancestor → outside repo with nonexistent leaf → ALLOW
# (codex R3: "Allow is correct if smart-arming is based on actual artifact
# location. A raw path under repo that resolves through a symlinked ancestor
# to outside the repo should not arm repo-source checkpoint state." — but
# raw-prefix match catches this first because the path starts with TEST_DIR.
# So actually for this axis to allow, the path must NOT start with raw repo
# root literally. The axis applies when caller types something that resolves
# out via a symlinked ancestor. We construct such a path explicitly.)
mkdir -p "$TEST_DIR/external-target-dir"
SYM_REPO_LINK_DIR="$TEST_DIR/link-dir-to-external"
ln -sfn "$OFFREPO_DIR/external-target-dir" "$SYM_REPO_LINK_DIR"
# This still starts with $TEST_DIR/ so raw-prefix matches → block. Document
# that axis 5 with raw-path-under-repo is dominated by raw-prefix block,
# which is the SAFE direction (block on author intent). Test it:
assert_blocked "SA-sym5. Repo-relative path through symlinked ancestor BLOCKED (raw-prefix wins)" \
  "$(mock_path_json 'Edit' "$SYM_REPO_LINK_DIR/foo.mjs")" "Checkpoint required"

# ── Cwd-binding tests (R4/P1 + R5 fallback) ──
# T_cwd1: relative FILE_PATH + absolute tool_input.cwd → resolved + block
assert_blocked "SA-cwd1. Relative FILE_PATH + absolute tool_input.cwd → resolved + block" \
  "$(mock_path_json 'Edit' 'scripts-test.mjs' "$TEST_DIR" "$TEST_DIR")" "Checkpoint required"

# T_cwd2: relative FILE_PATH + empty tool_input.cwd + absolute top-level .cwd → resolved + block
assert_blocked "SA-cwd2. Relative FILE_PATH + absolute top-level .cwd → resolved + block" \
  "$(mock_path_json 'Edit' 'scripts-test.mjs' "$TEST_DIR" "")" "Checkpoint required"

# T_cwd3: relative FILE_PATH + RELATIVE .cwd + RELATIVE tool_input.cwd → ALLOW
#
# PR-level codex review (REJECT R1 → fix landed here) caught the bug in this
# test's prior expectation. The R7/P1 documented behavior is: relative .cwd
# falls back to hook process pwd. If hook process pwd is NOT the same as the
# armed test target (i.e. when test runner is invoked from outside $TEST_DIR),
# the gate checks for `.checkpoint-required` at hook-pwd → finds none → exits
# 0 → allows. This is the SAME wrong-root-hook = allow behavior that
# SA-cwd-strict asserts intentionally.
#
# Prior version asserted "block" which was wrong: it depended on hook-pwd
# happening to equal $TEST_DIR (only true when test runner is invoked from
# inside the fixture's temp dir — fragile). The correct assertion is ALLOW.
# Codex PR-level R1 caught this via running the suite from a fresh cwd.
assert_allowed "SA-cwd3. Relative FILE_PATH + relative .cwd + relative tool_input.cwd → wrong-root = allow (same shape as SA-cwd-strict)" \
  "$(jq -n --arg tn 'Edit' --arg fp 'scripts-test.mjs' --arg c './relative' --arg tic './relative-dir' \
    '{tool_name: $tn, tool_input: {file_path: $fp, cwd: $tic}, cwd: $c}')"

# T_cwd3-strict: codex R7/P1 ACCEPT criterion — caller cwd != target with
# relative/empty cwds. Run hook from a separate temp caller cwd. With the
# R7/P1 CWD fix, an empty top-level .cwd falls back to hook process pwd =
# caller cwd, which is NOT the target. Predicate then evaluates against the
# wrong root, and FILE_PATH stays relative-resolved against THAT wrong root.
# Since target's PRE_REQ is what we armed but hook resolves to caller cwd,
# the gate doesn't see PRE_REQ at all → allow (gate doesn't fire because
# wrong-root REPO_ROOT). This is the correct behavior: gate is bound to
# the input cwd's project; off-project hook invocations don't trigger
# someone else's gate state. Test asserts the allow.
CALLER_TMP="$(mktemp -d)"
CALLER_TMP="$(cd -P "$CALLER_TMP" && pwd)"
SA_CWD_STRICT_JSON="$(jq -n --arg tn 'Edit' --arg fp 'scripts/x.mjs' \
  '{tool_name: $tn, tool_input: {file_path: $fp}, cwd: ""}')"
SA_CWD_STRICT_OUT="$(cd "$CALLER_TMP" && echo "$SA_CWD_STRICT_JSON" | HOME="$TEST_HOME" bash "$HOOK" 2>/dev/null)"
SA_CWD_STRICT_EXIT=$?
if [ $SA_CWD_STRICT_EXIT -eq 0 ] && [ -z "$SA_CWD_STRICT_OUT" ] \
   && [ ! -e "$CALLER_TMP/.checkpoints" ] && [ ! -e "$CALLER_TMP/.claude" ]; then
  echo "  ✓ SA-cwd-strict. Caller cwd != target + empty cwd → wrong-root hook = allow + no caller marker leak (R7/P1)"
  ((passed++))
else
  echo "  ✗ SA-cwd-strict. exit=$SA_CWD_STRICT_EXIT out=$SA_CWD_STRICT_OUT caller_leak=$([ -e "$CALLER_TMP/.checkpoints" ] || [ -e "$CALLER_TMP/.claude" ] && echo yes || echo no)"
  ((failed++))
fi
rm -rf "$CALLER_TMP"

# T_cwd5: absolute FILE_PATH → no-op fallback → normal predicate behavior (in-repo absolute → block)
assert_blocked "SA-cwd5. Absolute in-repo FILE_PATH → normal predicate (regression-only)" \
  "$(mock_path_json 'Edit' "$TEST_DIR/foo.mjs")" "Checkpoint required"

# ── Artifact-location check (codex R6 R7 ACCEPT criteria) ──
# When smart-arming allows off-repo Edit, confirm NO pre-checkpoint marker
# was written under TEST_DIR. The off-repo allow path returns silently and
# does NOT touch markers. (Note: the hook itself doesn't write markers in
# the off-repo case; only the agent's own Write/Edit follow-up does. We
# verify the hook's null side-effect.)
reset_state
touch "$PRE_REQ"
PRE_REQ_MTIME_BEFORE="$(stat -f %m "$PRE_REQ" 2>/dev/null || stat -c %Y "$PRE_REQ" 2>/dev/null)"
echo "$(mock_path_json 'Edit' "$OFFREPO_DIR/memory/x.md")" | run_hook >/dev/null 2>&1
PRE_REQ_MTIME_AFTER="$(stat -f %m "$PRE_REQ" 2>/dev/null || stat -c %Y "$PRE_REQ" 2>/dev/null)"
if [ "$PRE_REQ_MTIME_BEFORE" = "$PRE_REQ_MTIME_AFTER" ] \
   && [ ! -e "$PRE_DONE" ] && [ ! -e "$POST_REQ" ] && [ ! -e "$POST_DONE" ]; then
  echo "  ✓ SA-disk. Off-repo Edit while armed: no marker artifacts touched (R6 R7 criterion)"
  ((passed++))
else
  echo "  ✗ SA-disk. Off-repo Edit while armed: marker artifacts changed unexpectedly"
  ((failed++))
fi

# Cleanup off-repo scratch.
rm -rf "$OFFREPO_DIR"

echo ""
echo "Passed: $passed"
echo "Failed: $failed"

if [ $failed -gt 0 ]; then
  exit 1
fi
exit 0
