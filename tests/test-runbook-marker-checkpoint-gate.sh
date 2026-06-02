#!/usr/bin/env bash
# test-runbook-marker-checkpoint-gate.sh — checkpoint-gate integration
# for .so-runbook-shown.* exemption (plan v4.1 #3, codex r2 P1).
#
# Verifies:
#   - touch of runbook marker at canonical root passes the marker_write
#     branch (exit 0) even with .plan-approval-pending active
#   - touch of runbook marker passes with .checkpoint-required active
#   - wrong-root touch (absolute non-canonical) → block via
#     _block_wrong_root_marker (wrong-root check fires BEFORE exemption)
#   - registry assertion: .so-runbook-shown.* basename NOT in
#     TASK_SIGNAL_MARKERS or CHECKPOINT_CLEANUP_MARKERS

set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/plugins/claude-code/hooks/checkpoint-gate.sh"

PASS=0
FAIL=0
FAILED=()

# run_gate <tool_name> <command-json-value> <cwd> → returns: exit_code, stdout
run_gate() {
  local tool_name="$1" command="$2" cwd="$3"
  printf '{"tool_name":"%s","tool_input":{"command":%s},"cwd":"%s","session_id":"test"}' \
    "$tool_name" "$(printf '%s' "$command" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$cwd" | \
    bash "$HOOK" 2>&1
}

assert_allow() {
  local name="$1" cwd="$2" cmd="$3"
  local out
  out="$(run_gate Bash "$cmd" "$cwd" 2>&1)" || true
  if [ -z "$out" ]; then
    PASS=$((PASS+1))
    printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAILED+=("$name: expected empty stdout (allow), got: $out")
    printf '  ✗ %s — got: %s\n' "$name" "$out"
  fi
}

assert_block() {
  local name="$1" cwd="$2" cmd="$3" expected_substring="$4"
  local out
  out="$(run_gate Bash "$cmd" "$cwd" 2>&1)" || true
  if [[ "$out" == *"$expected_substring"* ]]; then
    PASS=$((PASS+1))
    printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL+1))
    FAILED+=("$name: expected substring=$expected_substring got=$out")
    printf '  ✗ %s — expected "%s", got: %s\n' "$name" "$expected_substring" "$out"
  fi
}

# Fixture: tmp git repo with .checkpoints/
# realpath on TMP because macOS mktemp returns /var/folders/... which is a
# symlink to /private/var/folders/...; the hook canonicalizes via cd -P so
# tests must use the resolved form to avoid wrong-root false-positives.
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
git init -q "$TMP"
mkdir -p "$TMP/.checkpoints"

echo "# Checkpoint-gate × runbook marker"

# Baseline — no markers armed: touch runbook marker → allow
assert_allow \
  "no markers armed: touch runbook marker → allow" \
  "$TMP" \
  "touch $TMP/.checkpoints/.so-runbook-shown.deadbeef"

# Arm .plan-approval-pending, then touch runbook marker — exemption should fire
echo "plan pending" > "$TMP/.checkpoints/.plan-approval-pending"
assert_allow \
  "plan-pending armed: touch runbook marker → allow (exemption)" \
  "$TMP" \
  "touch $TMP/.checkpoints/.so-runbook-shown.deadbeef"

# Same scenario — touch a non-runbook marker should be blocked by plan-pending
assert_block \
  "plan-pending armed: touch .pre-checkpoint-done → block (cross-gate)" \
  "$TMP" \
  "touch $TMP/.checkpoints/.pre-checkpoint-done" \
  "plan-approval-pending"

rm -f "$TMP/.checkpoints/.plan-approval-pending"

# Arm .checkpoint-required, touch runbook marker → allow (exemption)
echo "ckpt required" > "$TMP/.checkpoints/.checkpoint-required"
assert_allow \
  "checkpoint-required armed: touch runbook marker → allow (exemption)" \
  "$TMP" \
  "touch $TMP/.checkpoints/.so-runbook-shown.deadbeef"
rm -f "$TMP/.checkpoints/.checkpoint-required"

# Wrong-root: touch runbook marker at non-canonical absolute path → block
assert_block \
  "wrong-root absolute path: touch runbook marker at /tmp/elsewhere → block" \
  "$TMP" \
  "touch /tmp/elsewhere/.checkpoints/.so-runbook-shown.deadbeef" \
  "non-canonical"

# Marker registry classification — assert .so-runbook-shown.* NOT in TASK_SIGNAL
echo ""
echo "# Marker registry classification"

REGISTRY_CHECK="$(node -e "
import('$REPO_ROOT/scripts/lib/marker-paths.mjs').then(m => {
  const isTaskSignal = m.TASK_SIGNAL_MARKERS.some(n => n.includes('so-runbook-shown'))
  const isCheckpointCleanup = m.CHECKPOINT_CLEANUP_MARKERS.some(n => n.includes('so-runbook-shown'))
  if (isTaskSignal) { console.log('FAIL_TASK_SIGNAL'); process.exit(1) }
  if (isCheckpointCleanup) { console.log('FAIL_CLEANUP'); process.exit(1) }
  console.log('OK')
}).catch(e => { console.log('ERR:' + e.message); process.exit(1) })
")"

if [ "$REGISTRY_CHECK" = "OK" ]; then
  PASS=$((PASS+1))
  printf '  ✓ .so-runbook-shown.* NOT in TASK_SIGNAL_MARKERS or CHECKPOINT_CLEANUP_MARKERS\n'
else
  FAIL=$((FAIL+1))
  FAILED+=("registry classification: $REGISTRY_CHECK")
  printf '  ✗ registry classification failed: %s\n' "$REGISTRY_CHECK"
fi

echo ""
echo "$PASS/$((PASS+FAIL)) pass"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for f in "${FAILED[@]}"; do
    echo "  ✗ $f"
  done
  exit 1
fi
