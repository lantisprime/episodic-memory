#!/usr/bin/env bash
# test-em-recall-sessionstart.sh — smoke tests for hooks/em-recall-sessionstart.sh
#
# Activator behavior (touching .checkpoint-required when bp-001 surfaces) is
# covered by tests/test-rfc002-phase3.mjs. This script tests the hook glue:
# stdin parsing, cwd handling, and soft-fail when em-recall is absent.
#
# Usage: bash tests/test-em-recall-sessionstart.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/hooks/em-recall-sessionstart.sh"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK is not executable"
  exit 1
fi

TEST_DIR=$(mktemp -d)
TEST_HOME=$(mktemp -d)
passed=0
failed=0

cleanup() { rm -rf "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

run_hook() {
  local cwd="${1:-$TEST_DIR}"
  HOME="$TEST_HOME" bash -c "echo '{\"cwd\": \"$cwd\"}' | bash '$HOOK'" 2>/dev/null
}

assert_exit_zero() {
  local test_name="$1"
  local cwd="${2:-$TEST_DIR}"
  if run_hook "$cwd"; then
    echo "  ✓ $test_name"
    ((passed++))
  else
    echo "  ✗ $test_name (non-zero exit)"
    ((failed++))
  fi
}

# ============================================================================
echo ""
echo "--- Soft-fail when em-recall not installed ---"
# ============================================================================
# TEST_HOME has no .episodic-memory/scripts/em-recall.mjs
assert_exit_zero "1. Hook exits 0 when em-recall absent"

# ============================================================================
echo ""
echo "--- Mock em-recall present ---"
# ============================================================================
mkdir -p "$TEST_HOME/.episodic-memory/scripts"
cat > "$TEST_HOME/.episodic-memory/scripts/em-recall.mjs" <<'EOF'
#!/usr/bin/env node
// mock em-recall — touches a sentinel so we know it ran
import fs from 'fs'
import path from 'path'
const sentinel = path.join(process.cwd(), '.em-recall-ran')
fs.writeFileSync(sentinel, 'ran')
console.log(JSON.stringify({ status: 'ok', count: 0, episodes: [] }))
EOF

assert_exit_zero "2. Hook exits 0 with mock em-recall"

if [ -f "$TEST_DIR/.em-recall-ran" ]; then
  echo "  ✓ 3. em-recall ran in cwd from stdin (sentinel created in TEST_DIR)"
  ((passed++))
else
  echo "  ✗ 3. em-recall did NOT run in cwd (sentinel missing in TEST_DIR)"
  ((failed++))
fi

# ============================================================================
echo ""
echo "--- Idempotent: second run doesn't fail ---"
# ============================================================================
rm -f "$TEST_DIR/.em-recall-ran"
assert_exit_zero "4. Re-running hook still exits 0"
if [ -f "$TEST_DIR/.em-recall-ran" ]; then
  echo "  ✓ 5. Re-run still invokes em-recall"
  ((passed++))
else
  echo "  ✗ 5. Re-run did not invoke em-recall"
  ((failed++))
fi

# ============================================================================
echo ""
echo "--- Missing cwd in stdin: hook soft-falls back to pwd ---"
# ============================================================================
# Run from inside TEST_DIR so the hook's `[ -z "$CWD" ] && CWD="$(pwd)"`
# fallback resolves to TEST_DIR (which the EXIT trap cleans up), not the
# test runner's working directory. Without the cd, mock em-recall would
# write its .em-recall-ran sentinel into wherever bash was invoked from.
exit_code=0
(cd "$TEST_DIR" && HOME="$TEST_HOME" bash -c "echo '{}' | bash '$HOOK'") 2>/dev/null || exit_code=$?
if [ $exit_code -eq 0 ]; then
  echo "  ✓ 6. Hook exits 0 when cwd missing from stdin"
  ((passed++))
else
  echo "  ✗ 6. Hook failed when cwd missing from stdin"
  ((failed++))
fi

# ============================================================================
echo ""
echo "--- Regression guard for #63 (no pollution outside TEST_DIR/TEST_HOME) ---"
# ============================================================================
REPO_ROOT_BEFORE=$(ls -A "$REPO_ROOT" | sort)
# Re-run the full hook one more time inside TEST_DIR with empty stdin
(cd "$TEST_DIR" && HOME="$TEST_HOME" bash -c "echo '{}' | bash '$HOOK'") 2>/dev/null || true
REPO_ROOT_AFTER=$(ls -A "$REPO_ROOT" | sort)
if [ "$REPO_ROOT_BEFORE" = "$REPO_ROOT_AFTER" ]; then
  echo "  ✓ 7. Hook does not create files outside TEST_DIR (#63 regression guard)"
  ((passed++))
else
  echo "  ✗ 7. Hook polluted REPO_ROOT (regression of #63):"
  echo "    diff: $(diff <(echo "$REPO_ROOT_BEFORE") <(echo "$REPO_ROOT_AFTER"))"
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
