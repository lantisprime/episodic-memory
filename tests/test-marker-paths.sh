#!/usr/bin/env bash
# test-marker-paths.sh — Tests for hooks/lib/marker-paths.sh shared helpers.
#
# Layer-1 unit tests over the helpers used by checkpoint-gate / plan-gate
# during the .checkpoints/ migration. Pairs with tests/test-marker-paths.mjs
# for the node-side mirror.
#
# Defensive ordering per feedback_test_resource_existence_check.md: every
# state assertion is paired with an existence check on the artifact at
# check time.

set -e

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/plugins/claude-code/hooks/lib/marker-paths.sh"

if [ ! -f "$LIB" ]; then
  echo "FAIL: $LIB not found"
  exit 1
fi

# shellcheck disable=SC1091
source "$LIB"

PASS=0
FAIL=0
FAILURES=()

pass() {
  PASS=$((PASS + 1))
  echo "  ✓ $1"
}

fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1: $2")
  echo "  ✗ $1: $2"
}

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$name"
  else
    fail "$name" "expected '$expected', got '$actual'"
  fi
}

# Build a temp dir for filesystem tests.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Constants:"
assert_eq "PRIMARY_MARKER_DIR is .checkpoints" ".checkpoints" "$PRIMARY_MARKER_DIR"
assert_eq "LEGACY_MARKER_DIR is .claude" ".claude" "$LEGACY_MARKER_DIR"
assert_eq "BASELINE_NAME is .session-baseline" ".session-baseline" "$BASELINE_NAME"
assert_eq "TASK_SIGNAL_MARKERS count is 3 (em-recall carve-out class)" "3" "${#TASK_SIGNAL_MARKERS[@]}"
assert_eq "CHECKPOINT_CLEANUP_MARKERS count is 4 (push-gate cleanup class)" "4" "${#CHECKPOINT_CLEANUP_MARKERS[@]}"
assert_eq "ALL_MIGRATED_MARKERS count is 7 (full migration scope)" "7" "${#ALL_MIGRATED_MARKERS[@]}"

# Spot-check membership of each set.
case " ${TASK_SIGNAL_MARKERS[*]} " in
  *" .checkpoint-required "*) pass "TASK_SIGNAL_MARKERS contains .checkpoint-required" ;;
  *) fail "TASK_SIGNAL_MARKERS contains .checkpoint-required" "missing" ;;
esac
case " ${TASK_SIGNAL_MARKERS[*]} " in
  *" .pre-checkpoint-done "*)
    fail "TASK_SIGNAL_MARKERS does NOT contain .pre-checkpoint-done" "leaked into carve-out class" ;;
  *) pass "TASK_SIGNAL_MARKERS does NOT contain .pre-checkpoint-done" ;;
esac
case " ${CHECKPOINT_CLEANUP_MARKERS[*]} " in
  *" .pre-checkpoint-done "*) pass "CHECKPOINT_CLEANUP_MARKERS contains .pre-checkpoint-done" ;;
  *) fail "CHECKPOINT_CLEANUP_MARKERS contains .pre-checkpoint-done" "missing" ;;
esac
case " ${CHECKPOINT_CLEANUP_MARKERS[*]} " in
  *" .plan-approval-pending "*)
    fail "CHECKPOINT_CLEANUP_MARKERS does NOT contain .plan-approval-pending" "leaked into push cleanup" ;;
  *) pass "CHECKPOINT_CLEANUP_MARKERS does NOT contain .plan-approval-pending" ;;
esac
case " ${ALL_MIGRATED_MARKERS[*]} " in
  *" .session-baseline "*) pass "ALL_MIGRATED_MARKERS contains .session-baseline" ;;
  *) fail "ALL_MIGRATED_MARKERS contains .session-baseline" "missing" ;;
esac
# planapproval redesign — .plan-approved approval token membership.
# Review F1: EXCLUDED from CHECKPOINT_CLEANUP (no cross-session push-sweep).
case " ${CHECKPOINT_CLEANUP_MARKERS[*]} " in
  *" .plan-approved "*) fail "CHECKPOINT_CLEANUP_MARKERS does NOT contain .plan-approved" "leaked into push cleanup" ;;
  *) pass "CHECKPOINT_CLEANUP_MARKERS does NOT contain .plan-approved (F1: no cross-session push-sweep)" ;;
esac
case " ${ALL_MIGRATED_MARKERS[*]} " in
  *" .plan-approved "*) pass "ALL_MIGRATED_MARKERS contains .plan-approved" ;;
  *) fail "ALL_MIGRATED_MARKERS contains .plan-approved" "missing" ;;
esac
case " ${TASK_SIGNAL_MARKERS[*]} " in
  *" .plan-approved "*)
    fail "TASK_SIGNAL_MARKERS does NOT contain .plan-approved" "leaked into carve-out class" ;;
  *) pass "TASK_SIGNAL_MARKERS does NOT contain .plan-approved" ;;
esac
assert_eq "PLAN_APPROVED_LEGACY_BASENAME is .plan-approved" ".plan-approved" "$PLAN_APPROVED_LEGACY_BASENAME"

echo
echo "Path helpers:"
assert_eq "primary_marker_path /repo .X" \
  "/repo/.checkpoints/.X" \
  "$(primary_marker_path /repo .X)"
assert_eq "legacy_marker_path /repo .X" \
  "/repo/.claude/.X" \
  "$(legacy_marker_path /repo .X)"
assert_eq "write_marker_path === primary_marker_path" \
  "/repo/.checkpoints/.X" \
  "$(write_marker_path /repo .X)"

# both_marker_paths emits two lines; capture into array per Bash 3.2 (no
# mapfile per macOS portability lesson 20260508-021131).
both_out="$(both_marker_paths /repo .X)"
expected_both=$'/repo/.checkpoints/.X\n/repo/.claude/.X'
assert_eq "both_marker_paths emits primary then legacy" "$expected_both" "$both_out"

echo
echo "resolve_marker_read fallback chain:"

# Case 1: neither exists → return code 1, empty stdout.
ROOT_NONE="$TMP/root-none"
mkdir -p "$ROOT_NONE"
out="$(resolve_marker_read "$ROOT_NONE" .pre-checkpoint-done 2>/dev/null || echo "MISS")"
assert_eq "neither marker present → MISS sentinel" "MISS" "$out"

# Case 2: legacy only → returns legacy path.
ROOT_LEG="$TMP/root-legacy"
mkdir -p "$ROOT_LEG/.claude"
echo body > "$ROOT_LEG/.claude/.pre-checkpoint-done"
out="$(resolve_marker_read "$ROOT_LEG" .pre-checkpoint-done)"
assert_eq "legacy only → returns legacy path" \
  "$ROOT_LEG/.claude/.pre-checkpoint-done" \
  "$out"
[ -f "$out" ] && pass "legacy-only result file exists" || fail "legacy-only result file exists" "missing"

# Case 3: primary only → returns primary path.
ROOT_PRI="$TMP/root-primary"
mkdir -p "$ROOT_PRI/.checkpoints"
echo body > "$ROOT_PRI/.checkpoints/.pre-checkpoint-done"
out="$(resolve_marker_read "$ROOT_PRI" .pre-checkpoint-done)"
assert_eq "primary only → returns primary path" \
  "$ROOT_PRI/.checkpoints/.pre-checkpoint-done" \
  "$out"
[ -f "$out" ] && pass "primary-only result file exists" || fail "primary-only result file exists" "missing"

# Case 4: both exist → primary wins.
ROOT_BOTH="$TMP/root-both"
mkdir -p "$ROOT_BOTH/.checkpoints" "$ROOT_BOTH/.claude"
echo primary > "$ROOT_BOTH/.checkpoints/.pre-checkpoint-done"
echo legacy > "$ROOT_BOTH/.claude/.pre-checkpoint-done"
out="$(resolve_marker_read "$ROOT_BOTH" .pre-checkpoint-done)"
assert_eq "both present → primary wins" \
  "$ROOT_BOTH/.checkpoints/.pre-checkpoint-done" \
  "$out"

echo
echo "ensure_primary_dir:"
ROOT_ENS="$TMP/root-ensure"
mkdir -p "$ROOT_ENS"
ensure_primary_dir "$ROOT_ENS"
[ -d "$ROOT_ENS/.checkpoints" ] && pass "ensure_primary_dir creates .checkpoints/" \
  || fail "ensure_primary_dir creates .checkpoints/" "directory missing"

# Idempotent re-call.
ensure_primary_dir "$ROOT_ENS"
[ -d "$ROOT_ENS/.checkpoints" ] && pass "ensure_primary_dir is idempotent" \
  || fail "ensure_primary_dir is idempotent" "directory missing after second call"

echo
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "Failures:"
  for f in "${FAILURES[@]}"; do echo "  $f"; done
  exit 1
fi
