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
  PLAN_MARKER="$TEST_DIR/.claude/.plan-approval-pending"
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
B1_EXPECTED="$TEST_DIR/.claude/.pre-checkpoint-done"
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
# Plan-pending block reason also gets absolute path
reset_state
touch "$PRE_REQ"
PLAN_MARKER="$TEST_DIR/.claude/.plan-approval-pending"
touch "$PLAN_MARKER"
# A Bash command targeting the pre-checkpoint marker fires the
# plan-pending block (cross-gate invariant). Reason should embed
# absolute plan-pending path.
plan_block_json=$(jq -nc \
  --arg cmd "echo block > $TEST_DIR/.claude/.pre-checkpoint-done" \
  --arg cwd "$TEST_DIR" \
  '{tool_name: "Bash", cwd: $cwd, tool_input: {command: $cmd}}')
plan_out=$(echo "$plan_block_json" | HOME="$TEST_HOME" bash "$HOOK" 2>/dev/null || true)
if echo "$plan_out" | grep -qF "$PLAN_MARKER"; then
  echo "  ✓ B1.plan. _block_plan_pending reason embeds absolute plan-pending path"
  ((passed++))
else
  echo "  ✗ B1.plan. expected absolute path '$PLAN_MARKER' in: $plan_out"
  ((failed++))
fi
rm -f "$PLAN_MARKER"

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
echo "--- Result ---"
# ============================================================================
echo ""
echo "Passed: $passed"
echo "Failed: $failed"

if [ $failed -gt 0 ]; then
  exit 1
fi
exit 0
