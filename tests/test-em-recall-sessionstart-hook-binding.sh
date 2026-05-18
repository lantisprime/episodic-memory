#!/usr/bin/env bash
# test-em-recall-sessionstart-hook-binding.sh — Integration test exercising
# hooks/em-recall-sessionstart.sh end-to-end with constructed stdin JSON.
#
# Validates codex R3 P1 (hook wrapper coverage), R4 P1.1 (fake HOME),
# R5 P1.1 (silent soft-noop when em-recall.mjs missing).
#
# Scenarios:
#   H1  caller cwd != target; valid sid; legacy + suffixed pre-existing
#   H2  nested cwd inside target
#   H3  linked worktree cwd
#   H4  stdin .session_id omitted (empty)
#   H5  stdin .session_id malformed
#   H6  fake HOME containing installed-runtime em-recall.mjs
#   H6b fake HOME WITHOUT em-recall.mjs → silent soft-noop (exit 0, no
#       stdout, no mutation) — codex R5 P1.1 corrected from R4 v4 expectation

set -u

REPO="$(cd -P "$(dirname "$0")/.." && pwd)"
HOOK="$REPO/hooks/em-recall-sessionstart.sh"

passed=0
failed=0
cleanup_dirs=()
trap 'for d in "${cleanup_dirs[@]}"; do rm -rf "$d" 2>/dev/null || true; done' EXIT

# All scenarios run with HOME pointed at a fake home containing this
# worktree's em-recall.mjs + lib/. Without this, tests would run against the
# user's installed em-recall (which may be the pre-fix version) and pass for
# the wrong reasons or fail confusingly. H6 keeps the fake-HOME assertion
# explicit, but every scenario benefits from a stable runtime fixture.
SHARED_FAKE_HOME="$(mktemp -d -t em-hook-sharedhome-XXXXXX)"
SHARED_FAKE_HOME="$(cd "$SHARED_FAKE_HOME" && pwd -P)"
mkdir -p "$SHARED_FAKE_HOME/.episodic-memory/scripts/lib"
cp "$REPO/scripts/em-recall.mjs" "$SHARED_FAKE_HOME/.episodic-memory/scripts/"
cp "$REPO/scripts/lib/"*.mjs "$SHARED_FAKE_HOME/.episodic-memory/scripts/lib/"
cleanup_dirs+=("$SHARED_FAKE_HOME")
export HOME="$SHARED_FAKE_HOME"

check() {
  local cond="$1" msg="$2"
  if [ "$cond" = "1" ]; then
    passed=$((passed + 1))
    echo "  PASS  $msg"
  else
    failed=$((failed + 1))
    echo "  FAIL  $msg"
  fi
}

mk_git_target() {
  local d
  d="$(mktemp -d -t em-hook-XXXXXX)"
  d="$(cd "$d" && pwd -P)"
  mkdir -p "$d/.checkpoints" "$d/.claude"
  ( cd "$d" && git init -q )
  cleanup_dirs+=("$d")
  printf '%s' "$d"
}

mk_caller_dir() {
  local d
  d="$(mktemp -d -t em-hook-caller-XXXXXX)"
  d="$(cd "$d" && pwd -P)"
  cleanup_dirs+=("$d")
  printf '%s' "$d"
}

mk_fake_home() {
  local d
  d="$(mktemp -d -t em-hook-fakehome-XXXXXX)"
  d="$(cd "$d" && pwd -P)"
  mkdir -p "$d/.episodic-memory/scripts/lib"
  # Copy em-recall.mjs + its lib/ deps for a working installed-runtime fixture.
  cp "$REPO/scripts/em-recall.mjs" "$d/.episodic-memory/scripts/"
  cp "$REPO/scripts/lib/"*.mjs "$d/.episodic-memory/scripts/lib/"
  cleanup_dirs+=("$d")
  printf '%s' "$d"
}

mk_empty_fake_home() {
  local d
  d="$(mktemp -d -t em-hook-emptyhome-XXXXXX)"
  d="$(cd "$d" && pwd -P)"
  # NO em-recall.mjs installed at $d/.episodic-memory/scripts/
  cleanup_dirs+=("$d")
  printf '%s' "$d"
}

stdin_json() {
  local cwd="$1" sid="${2:-}"
  if [ -n "$sid" ]; then
    printf '{"cwd":"%s","session_id":"%s"}' "$cwd" "$sid"
  else
    printf '{"cwd":"%s"}' "$cwd"
  fi
}

# ============================ H1 ============================
echo "H1: caller cwd != target; valid sid; legacy + suffixed pre-existing"
{
  TARGET="$(mk_git_target)"
  CALLER="$(mk_caller_dir)"
  touch -t 202605180100 "$TARGET/.checkpoints/.session-baseline"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending.foreign-B"
  STDIN_JSON="$(stdin_json "$TARGET" "35522aab-5f44-4b84-b1cc-035cca7b9305")"
  (
    cd "$CALLER"
    bash "$HOOK" <<< "$STDIN_JSON" >/dev/null 2>&1
  )
  rc=$?
  [ "$rc" = "0" ] && check 1 "H1 hook exit 0" || check 0 "H1 hook exit 0 (got $rc)"
  [ ! -e "$TARGET/.checkpoints/.plan-approval-pending" ] && check 1 "H1 legacy swept under target" || check 0 "H1 legacy swept"
  [ -e "$TARGET/.checkpoints/.plan-approval-pending.foreign-B" ] && check 1 "H1 suffixed preserved" || check 0 "H1 suffixed preserved"
  # No artifacts under caller
  [ ! -e "$CALLER/.checkpoints" ] && check 1 "H1 no .checkpoints/ under caller cwd" || check 0 "H1 caller untouched"
}

# ============================ H2 — nested cwd ============================
echo "H2: nested cwd inside target (cd to target/subdir)"
{
  TARGET="$(mk_git_target)"
  mkdir -p "$TARGET/subdir"
  touch -t 202605180100 "$TARGET/.checkpoints/.session-baseline"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending"
  # Pass nested dir as stdin .cwd — hook will cd to it; resolveRepoRoot
  # walks up to target via .git
  STDIN_JSON="$(stdin_json "$TARGET/subdir" "35522aab-5f44-4b84-b1cc-035cca7b9305")"
  bash "$HOOK" <<< "$STDIN_JSON" >/dev/null 2>&1
  rc=$?
  [ "$rc" = "0" ] && check 1 "H2 exit 0" || check 0 "H2 exit 0 (got $rc)"
  [ ! -e "$TARGET/.checkpoints/.plan-approval-pending" ] && check 1 "H2 legacy swept at TARGET (not subdir)" || check 0 "H2 swept at target"
  [ ! -d "$TARGET/subdir/.checkpoints" ] && check 1 "H2 no .checkpoints/ at subdir" || check 0 "H2 subdir untouched"
}

# ============================ H3 — linked worktree ============================
echo "H3: linked worktree cwd"
{
  TARGET="$(mk_git_target)"
  # Make an initial commit so worktree add works
  ( cd "$TARGET" && git -c user.email=test@example.com -c user.name=test commit --allow-empty -q -m init )
  WT="$(mktemp -d -t em-hook-wt-XXXXXX)"
  WT="$(cd "$WT" && pwd -P)"
  rm -rf "$WT"  # git worktree wants empty path
  ( cd "$TARGET" && git worktree add -q -b wt-test "$WT" )
  cleanup_dirs+=("$WT")
  touch -t 202605180100 "$TARGET/.checkpoints/.session-baseline"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending"
  STDIN_JSON="$(stdin_json "$WT" "35522aab-5f44-4b84-b1cc-035cca7b9305")"
  bash "$HOOK" <<< "$STDIN_JSON" >/dev/null 2>&1
  rc=$?
  [ "$rc" = "0" ] && check 1 "H3 exit 0" || check 0 "H3 exit 0 (got $rc)"
  [ ! -e "$TARGET/.checkpoints/.plan-approval-pending" ] && check 1 "H3 swept at MAIN repo (via git-common-dir)" || check 0 "H3 swept at main"
  # Cleanup
  ( cd "$TARGET" && git worktree remove --force "$WT" 2>/dev/null ) || true
  ( cd "$TARGET" && git branch -D wt-test 2>/dev/null ) || true
}

# ============================ H4 — empty session_id in stdin ============================
echo "H4: stdin .session_id omitted"
{
  TARGET="$(mk_git_target)"
  touch -t 202605180100 "$TARGET/.checkpoints/.session-baseline"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending"
  STDIN_JSON='{"cwd":"'"$TARGET"'"}'  # no .session_id key
  bash "$HOOK" <<< "$STDIN_JSON" >/dev/null 2>&1
  rc=$?
  [ "$rc" = "0" ] && check 1 "H4 exit 0" || check 0 "H4 exit 0 (got $rc)"
  [ ! -e "$TARGET/.checkpoints/.plan-approval-pending" ] && check 1 "H4 legacy swept" || check 0 "H4 swept"
}

# ============================ H5 — malformed session_id ============================
echo "H5: stdin .session_id malformed"
{
  TARGET="$(mk_git_target)"
  touch -t 202605180100 "$TARGET/.checkpoints/.session-baseline"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending"
  STDIN_JSON="$(stdin_json "$TARGET" '../../etc/passwd')"
  # Capture stderr too for warning assertion
  STDERR_LOG="$(mktemp)"
  cleanup_dirs+=("$(dirname "$STDERR_LOG")")
  bash "$HOOK" <<< "$STDIN_JSON" >/dev/null 2>"$STDERR_LOG"
  rc=$?
  [ "$rc" = "0" ] && check 1 "H5 exit 0 (warn-on-invalid)" || check 0 "H5 exit 0 (got $rc)"
  [ ! -e "$TARGET/.checkpoints/.plan-approval-pending" ] && check 1 "H5 legacy still swept (independent of malformed sid)" || check 0 "H5 swept"
  # Note: hook swallows stderr via `2>&1 || true`, so warning won't propagate
  # to our captured stderr. The warning is verified by the
  # session-id-binding.mjs test (direct invocation, no swallow).
  rm -f "$STDERR_LOG"
}

# ============================ H6 — fake HOME with installed runtime ============================
echo "H6: fake HOME containing installed-runtime em-recall.mjs"
{
  TARGET="$(mk_git_target)"
  CALLER="$(mk_caller_dir)"
  FAKE_HOME="$(mk_fake_home)"
  touch -t 202605180100 "$TARGET/.checkpoints/.session-baseline"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending"
  STDIN_JSON="$(stdin_json "$TARGET" "35522aab-5f44-4b84-b1cc-035cca7b9305")"
  (
    cd "$CALLER"
    HOME="$FAKE_HOME" bash "$HOOK" <<< "$STDIN_JSON" >/dev/null 2>&1
  )
  rc=$?
  [ "$rc" = "0" ] && check 1 "H6 exit 0" || check 0 "H6 exit 0 (got $rc)"
  [ ! -e "$TARGET/.checkpoints/.plan-approval-pending" ] && check 1 "H6 swept under TARGET (using fake-HOME runtime)" || check 0 "H6 swept"
  [ ! -e "$CALLER/.checkpoints" ] && check 1 "H6 caller untouched" || check 0 "H6 caller untouched"
  [ ! -e "$FAKE_HOME/.checkpoints" ] && check 1 "H6 fake HOME untouched" || check 0 "H6 fake HOME untouched"
}

# ============================ H6b — fake HOME WITHOUT em-recall.mjs ============================
echo "H6b: fake HOME WITHOUT em-recall.mjs → silent soft-noop"
{
  TARGET="$(mk_git_target)"
  CALLER="$(mk_caller_dir)"
  EMPTY_HOME="$(mk_empty_fake_home)"
  touch -t 202605180100 "$TARGET/.checkpoints/.session-baseline"
  touch -t 202605180200 "$TARGET/.checkpoints/.plan-approval-pending"
  STDIN_JSON="$(stdin_json "$TARGET" "35522aab-5f44-4b84-b1cc-035cca7b9305")"
  STDOUT_LOG="$(mktemp)"
  (
    cd "$CALLER"
    HOME="$EMPTY_HOME" bash "$HOOK" <<< "$STDIN_JSON" >"$STDOUT_LOG" 2>&1
  )
  rc=$?
  [ "$rc" = "0" ] && check 1 "H6b exit 0 (silent soft-noop)" || check 0 "H6b exit 0 (got $rc)"
  # Marker UNCHANGED — em-recall never ran
  [ -e "$TARGET/.checkpoints/.plan-approval-pending" ] && check 1 "H6b legacy marker UNCHANGED (no mutation)" || check 0 "H6b marker mutated unexpectedly"
  # No stdout
  [ ! -s "$STDOUT_LOG" ] && check 1 "H6b stdout empty (no block-JSON; silent path)" || check 0 "H6b stdout non-empty: $(cat "$STDOUT_LOG")"
  rm -f "$STDOUT_LOG"
}

echo
echo "$passed passed, $failed failed"
[ "$failed" = "0" ] && exit 0 || exit 1
