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

run_hook_capture() {
  local cwd="${1:-$TEST_DIR}"
  HOME="$TEST_HOME" bash -c "echo '{\"cwd\": \"$cwd\"}' | bash '$HOOK'" 2>&1
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
echo "--- #70 F3: invalid cwd → exit 0 without invoking em-recall ---"
# ============================================================================
# Pre-fix: `cd "$CWD" 2>/dev/null || true` silently fell back to whatever
# directory the hook process started in if $CWD was invalid. em-recall would
# then run in that wrong dir and could touch .checkpoint-required in an
# unrelated project. Post-fix: invalid cwd → exit 0 cleanly without
# invoking em-recall at all.
# Clear sentinels in any dir the mock might write to. If F3 fix is broken,
# the mock em-recall would write `.em-recall-ran` at its `process.cwd()` —
# which is the inherited cwd of the hook subprocess (typically REPO_ROOT).
# Checking only TEST_DIR misses that case; check the three likely targets.
rm -f "$TEST_DIR/.em-recall-ran" "$TEST_HOME/.em-recall-ran" "$REPO_ROOT/.em-recall-ran"

exit_code=0
HOME="$TEST_HOME" bash -c "echo '{\"cwd\":\"/nonexistent/path/that/does/not/exist\"}' | bash '$HOOK'" 2>/dev/null || exit_code=$?

if [ $exit_code -eq 0 ]; then
  echo "  ✓ 8. Hook exits 0 with invalid cwd"
  ((passed++))
else
  echo "  ✗ 8. Hook failed with non-zero exit ($exit_code) on invalid cwd"
  ((failed++))
fi

# em-recall must NOT have run anywhere. Check the three plausible targets:
# the inherited cwd (REPO_ROOT), the test dir, and the test HOME.
if [ ! -f "$TEST_DIR/.em-recall-ran" ] \
  && [ ! -f "$TEST_HOME/.em-recall-ran" ] \
  && [ ! -f "$REPO_ROOT/.em-recall-ran" ]; then
  echo "  ✓ 9. em-recall NOT invoked when cwd invalid (no sentinel anywhere)"
  ((passed++))
else
  echo "  ✗ 9. mock em-recall sentinel found — invocation proceeded with invalid cwd"
  echo "    TEST_DIR: $([ -f "$TEST_DIR/.em-recall-ran" ] && echo present || echo absent)"
  echo "    TEST_HOME: $([ -f "$TEST_HOME/.em-recall-ran" ] && echo present || echo absent)"
  echo "    REPO_ROOT: $([ -f "$REPO_ROOT/.em-recall-ran" ] && echo present || echo absent)"
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
echo "--- #103 hook freshness warnings ---"
# ============================================================================
FRESH_SRC="$TEST_DIR/fresh-source-repo"
FRESH_INSTALLED="$TEST_HOME/.claude/hooks"
mkdir -p "$FRESH_SRC/hooks/lib" "$FRESH_INSTALLED/lib" "$TEST_HOME/.episodic-memory"
cp "$REPO_ROOT/hooks/plan-gate.sh" "$FRESH_SRC/hooks/plan-gate.sh"
cp "$REPO_ROOT/hooks/em-recall-sessionstart.sh" "$FRESH_SRC/hooks/em-recall-sessionstart.sh"
cp "$REPO_ROOT/hooks/lib/command-classifier.sh" "$FRESH_SRC/hooks/lib/command-classifier.sh"
cp "$FRESH_SRC/hooks/plan-gate.sh" "$FRESH_INSTALLED/plan-gate.sh"
cp "$FRESH_SRC/hooks/em-recall-sessionstart.sh" "$FRESH_INSTALLED/em-recall-sessionstart.sh"
cp "$FRESH_SRC/hooks/lib/command-classifier.sh" "$FRESH_INSTALLED/lib/command-classifier.sh"

cat > "$TEST_HOME/.episodic-memory/hook-install.json" <<EOF
{
  "schema_version": 1,
  "source_repo": "$FRESH_SRC",
  "hooks_dir": "$FRESH_INSTALLED",
  "files": [
    {
      "relative_path": "hooks/plan-gate.sh",
      "installed_path": "$FRESH_INSTALLED/plan-gate.sh",
      "source_sha256": "unused-in-runtime",
      "source_version": "2026-05-08.1"
    },
    {
      "relative_path": "hooks/em-recall-sessionstart.sh",
      "installed_path": "$FRESH_INSTALLED/em-recall-sessionstart.sh",
      "source_sha256": "unused-in-runtime",
      "source_version": "2026-05-08.1"
    },
    {
      "relative_path": "hooks/lib/command-classifier.sh",
      "installed_path": "$FRESH_INSTALLED/lib/command-classifier.sh",
      "source_sha256": "unused-in-runtime",
      "source_version": "2026-05-08.1"
    }
  ]
}
EOF

output="$(run_hook_capture)"
if ! echo "$output" | grep -q "hook freshness warning" \
  && ! echo "$output" | grep -q "installed Claude hooks differ"; then
  echo "  ✓ 10. Current installed hooks are quiet"
  ((passed++))
else
  echo "  ✗ 10. Current installed hooks produced a freshness warning"
  echo "    output: $output"
  ((failed++))
fi

printf '\n# local edit without version bump\n' >> "$FRESH_INSTALLED/plan-gate.sh"
output="$(run_hook_capture)"
if echo "$output" | grep -q "hooks/plan-gate.sh" \
  && echo "$output" | grep -q -- "--install-hooks-force"; then
  echo "  ✓ 11. Manual installed hook edit is reported without overwrite"
  ((passed++))
else
  echo "  ✗ 11. Manual installed hook edit was not reported clearly"
  echo "    output: $output"
  ((failed++))
fi

cp "$FRESH_SRC/hooks/plan-gate.sh" "$FRESH_INSTALLED/plan-gate.sh"
printf '\n# local lib edit without version bump\n' >> "$FRESH_INSTALLED/lib/command-classifier.sh"
output="$(run_hook_capture)"
if echo "$output" | grep -q "hooks/lib/command-classifier.sh"; then
  echo "  ✓ 12. Managed hook lib drift is reported"
  ((passed++))
else
  echo "  ✗ 12. Managed hook lib drift was not reported"
  echo "    output: $output"
  ((failed++))
fi

mv "$FRESH_SRC" "$FRESH_SRC.moved"
output="$(run_hook_capture)"
if echo "$output" | grep -q "source repo unavailable"; then
  echo "  ✓ 13. Missing source repo is reported"
  ((passed++))
else
  echo "  ✗ 13. Missing source repo was not reported"
  echo "    output: $output"
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
