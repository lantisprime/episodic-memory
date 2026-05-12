#!/usr/bin/env bash
#
# tests/test-preflight-non-worsening.sh — assert that adding the new
# `.checkpoints/.preflight-done` and `.checkpoints/.last-user-prompt.json`
# marker files does NOT change the decision behavior of the existing four
# sibling gates (checkpoint-gate, plan-gate, stop-gate, second-opinion-gate).
#
# Closes lesson `20260512-053535-...-d20c` (out-of-scope ≠ doesn't break;
# plans must assert non-worsening) and FU-2 of codex r1.
#
# For each sibling gate: pick one deterministic input, run gate against
# the fixture in two states:
#   (a) fixture has NONE of the new preflight files
#   (b) fixture has BOTH preflight files seeded with arbitrary content
# Assert the gate's stdout + exit are byte-for-byte identical.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
passed=0
failed=0
SESSION_ID="non-worsening-$$"

cleanup_dirs=()
on_exit() { for d in "${cleanup_dirs[@]}"; do rm -rf "$d" 2>/dev/null || true; done; }
trap on_exit EXIT

mktmp() {
  local d
  d="$(mktemp -d)"
  d="$(cd "$d" && pwd -P)"
  cleanup_dirs+=("$d")
  echo "$d"
}

# Stage a minimal repo with all 5 hooks + their lib deps + git init.
stage_full_fixture() {
  local tmp="$1"
  mkdir -p "$tmp/scripts/lib" "$tmp/hooks/lib" "$tmp/.checkpoints"
  (cd "$tmp" && git init -q 2>/dev/null) || true
  cp "$REPO_ROOT/scripts/lib/canonicalize-path-tolerant.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/local-dir.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/marker-paths.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/hooks/lib/command-classifier.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/hooks/lib/repo-root.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/hooks/lib/marker-paths.sh" "$tmp/hooks/lib/"
  for h in checkpoint-gate.sh plan-gate.sh stop-gate.sh; do
    cp "$REPO_ROOT/hooks/$h" "$tmp/hooks/"
  done
  # second-opinion-gate.mjs depends on its lib; copy whole dir.
  if [ -d "$REPO_ROOT/hooks/second-opinion-gate.mjs" ] || [ -f "$REPO_ROOT/hooks/second-opinion-gate.mjs" ]; then
    cp "$REPO_ROOT/hooks/second-opinion-gate.mjs" "$tmp/hooks/"
  fi
}

# Add the two preflight files with arbitrary content.
add_preflight_files() {
  local tmp="$1"
  echo '{"placeholder":true}' > "$tmp/.checkpoints/.preflight-done"
  echo '{"placeholder":true}' > "$tmp/.checkpoints/.last-user-prompt.json"
}

# run_and_capture <gate-cmd> <input>  → echo "$exit\n$stdout"
run_and_capture() {
  local gate="$1" input="$2"
  local out ec
  set +e
  out="$(printf '%s' "$input" | bash -c "$gate" 2>&1)"
  ec=$?
  set -e
  printf '%d\n%s' "$ec" "$out"
}

# Compare two captures; both must be identical.
assert_unchanged() {
  local desc="$1" before="$2" after="$3"
  if [ "$before" = "$after" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc"
    echo "    BEFORE: $before"
    echo "    AFTER:  $after"
    failed=$((failed+1))
  fi
}

echo ""
echo "--- N1: checkpoint-gate.sh — benign read-only Bash unchanged ---"
TMP="$(mktmp)"; stage_full_fixture "$TMP"
INPUT="$(printf '{"tool_name":"Bash","tool_input":{"command":"ls -la"},"cwd":"%s","session_id":"%s","transcript_path":"/tmp/x"}' "$TMP" "$SESSION_ID")"
GATE="bash $TMP/hooks/checkpoint-gate.sh"
BEFORE="$(run_and_capture "$GATE" "$INPUT")"
add_preflight_files "$TMP"
AFTER="$(run_and_capture "$GATE" "$INPUT")"
assert_unchanged "N1 checkpoint-gate ls Bash" "$BEFORE" "$AFTER"

echo ""
echo "--- N2: checkpoint-gate.sh — with .checkpoint-required (block) unchanged ---"
TMP="$(mktmp)"; stage_full_fixture "$TMP"
touch "$TMP/.checkpoints/.checkpoint-required"
INPUT="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s/foo.txt","content":"x"},"cwd":"%s","session_id":"%s","transcript_path":"/tmp/x"}' "$TMP" "$TMP" "$SESSION_ID")"
GATE="bash $TMP/hooks/checkpoint-gate.sh"
BEFORE="$(run_and_capture "$GATE" "$INPUT")"
add_preflight_files "$TMP"
AFTER="$(run_and_capture "$GATE" "$INPUT")"
assert_unchanged "N2 checkpoint-gate blocked Write w/.checkpoint-required" "$BEFORE" "$AFTER"

echo ""
echo "--- N3: plan-gate.sh — benign Bash unchanged ---"
TMP="$(mktmp)"; stage_full_fixture "$TMP"
INPUT="$(printf '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"%s","session_id":"%s","transcript_path":"/tmp/x"}' "$TMP" "$SESSION_ID")"
GATE="bash $TMP/hooks/plan-gate.sh"
BEFORE="$(run_and_capture "$GATE" "$INPUT")"
add_preflight_files "$TMP"
AFTER="$(run_and_capture "$GATE" "$INPUT")"
assert_unchanged "N3 plan-gate ls Bash" "$BEFORE" "$AFTER"

echo ""
echo "--- N4: plan-gate.sh — with .plan-approval-pending (block) unchanged ---"
TMP="$(mktmp)"; stage_full_fixture "$TMP"
touch "$TMP/.checkpoints/.plan-approval-pending"
INPUT="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s/foo.txt","content":"x"},"cwd":"%s","session_id":"%s","transcript_path":"/tmp/x"}' "$TMP" "$TMP" "$SESSION_ID")"
GATE="bash $TMP/hooks/plan-gate.sh"
BEFORE="$(run_and_capture "$GATE" "$INPUT")"
add_preflight_files "$TMP"
AFTER="$(run_and_capture "$GATE" "$INPUT")"
assert_unchanged "N4 plan-gate blocked Write w/.plan-approval-pending" "$BEFORE" "$AFTER"

echo ""
echo "--- N5: stop-gate.sh — without checkpoint-required unchanged ---"
TMP="$(mktmp)"; stage_full_fixture "$TMP"
INPUT="$(printf '{"hook_event_name":"Stop","cwd":"%s","session_id":"%s","transcript_path":"/tmp/x","stop_hook_active":false}' "$TMP" "$SESSION_ID")"
GATE="bash $TMP/hooks/stop-gate.sh"
BEFORE="$(run_and_capture "$GATE" "$INPUT")"
add_preflight_files "$TMP"
AFTER="$(run_and_capture "$GATE" "$INPUT")"
assert_unchanged "N5 stop-gate clean state" "$BEFORE" "$AFTER"

echo ""
echo "--- N6: second-opinion-gate.mjs — benign Bash unchanged ---"
TMP="$(mktmp)"; stage_full_fixture "$TMP"
if [ -f "$TMP/hooks/second-opinion-gate.mjs" ]; then
  INPUT="$(printf '{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"%s","session_id":"%s","transcript_path":"/tmp/x"}' "$TMP" "$SESSION_ID")"
  GATE="node $TMP/hooks/second-opinion-gate.mjs"
  BEFORE="$(run_and_capture "$GATE" "$INPUT")"
  add_preflight_files "$TMP"
  AFTER="$(run_and_capture "$GATE" "$INPUT")"
  assert_unchanged "N6 second-opinion-gate ls Bash" "$BEFORE" "$AFTER"
else
  echo "  (skip) N6 — second-opinion-gate.mjs not present in fixture"
fi

echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="
exit $((failed > 0 ? 1 : 0))
