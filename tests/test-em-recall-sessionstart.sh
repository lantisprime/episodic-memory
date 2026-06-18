#!/usr/bin/env bash
# test-em-recall-sessionstart.sh — smoke tests for hooks/em-recall-sessionstart.sh
#
# RFC-008 P3d (F38/F60): the hook's SessionStart side-effects (baseline write +
# sweeps + bp-001 advisory) relocated em-recall.mjs → enforce-contract.mjs
# --session-start. The hook now resolves + invokes enforce-contract at the
# canonical install path; em-recall is no longer called here. This script tests
# the hook glue: stdin parsing, cwd handling, soft-fail when enforce-contract is
# absent, and a live-E2E that the relocated baseline IS written (F2/F5
# anti-orphan).
#
# Usage: bash tests/test-em-recall-sessionstart.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/plugins/claude-code/hooks/em-recall-sessionstart.sh"

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
echo "--- Soft-fail when enforce-contract not installed ---"
# ============================================================================
# TEST_HOME has no .episodic-memory/scripts/enforce-contract.mjs
assert_exit_zero "1. Hook exits 0 when enforce-contract absent"

# ============================================================================
echo ""
echo "--- Mock enforce-contract present ---"
# ============================================================================
# The hook now resolves + invokes enforce-contract.mjs --session-start at the
# canonical install path. Mock it with a sentinel writer to prove the hook
# invokes it in the cwd parsed from stdin.
mkdir -p "$TEST_HOME/.episodic-memory/scripts"
cat > "$TEST_HOME/.episodic-memory/scripts/enforce-contract.mjs" <<'EOF'
#!/usr/bin/env node
// mock enforce-contract — touches a sentinel so we know the hook invoked it
import fs from 'fs'
import path from 'path'
const sentinel = path.join(process.cwd(), '.enforce-contract-ran')
fs.writeFileSync(sentinel, 'ran')
EOF

assert_exit_zero "2. Hook exits 0 with mock enforce-contract"

if [ -f "$TEST_DIR/.enforce-contract-ran" ]; then
  echo "  ✓ 3. enforce-contract ran in cwd from stdin (sentinel created in TEST_DIR)"
  ((passed++))
else
  echo "  ✗ 3. enforce-contract did NOT run in cwd (sentinel missing in TEST_DIR)"
  ((failed++))
fi

# ============================================================================
echo ""
echo "--- Idempotent: second run doesn't fail ---"
# ============================================================================
rm -f "$TEST_DIR/.enforce-contract-ran"
assert_exit_zero "4. Re-running hook still exits 0"
if [ -f "$TEST_DIR/.enforce-contract-ran" ]; then
  echo "  ✓ 5. Re-run still invokes enforce-contract"
  ((passed++))
else
  echo "  ✗ 5. Re-run did not invoke enforce-contract"
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
echo "--- #70 F3: invalid cwd → exit 0 without invoking enforce-contract ---"
# ============================================================================
# Pre-fix: `cd "$CWD" 2>/dev/null || true` silently fell back to whatever
# directory the hook process started in if $CWD was invalid. enforce-contract
# would then run in that wrong dir and could write .session-baseline in an
# unrelated project. Post-fix: invalid cwd → exit 0 cleanly without
# invoking enforce-contract at all.
# Clear sentinels in any dir the mock might write to. If F3 fix is broken,
# the mock enforce-contract would write `.enforce-contract-ran` at its
# `process.cwd()` — which is the inherited cwd of the hook subprocess (typically
# REPO_ROOT). Checking only TEST_DIR misses that case; check the three targets.
rm -f "$TEST_DIR/.enforce-contract-ran" "$TEST_HOME/.enforce-contract-ran" "$REPO_ROOT/.enforce-contract-ran"

exit_code=0
HOME="$TEST_HOME" bash -c "echo '{\"cwd\":\"/nonexistent/path/that/does/not/exist\"}' | bash '$HOOK'" 2>/dev/null || exit_code=$?

if [ $exit_code -eq 0 ]; then
  echo "  ✓ 8. Hook exits 0 with invalid cwd"
  ((passed++))
else
  echo "  ✗ 8. Hook failed with non-zero exit ($exit_code) on invalid cwd"
  ((failed++))
fi

# enforce-contract must NOT have run anywhere. Check the three plausible targets:
# the inherited cwd (REPO_ROOT), the test dir, and the test HOME.
if [ ! -f "$TEST_DIR/.enforce-contract-ran" ] \
  && [ ! -f "$TEST_HOME/.enforce-contract-ran" ] \
  && [ ! -f "$REPO_ROOT/.enforce-contract-ran" ]; then
  echo "  ✓ 9. enforce-contract NOT invoked when cwd invalid (no sentinel anywhere)"
  ((passed++))
else
  echo "  ✗ 9. mock enforce-contract sentinel found — invocation proceeded with invalid cwd"
  echo "    TEST_DIR: $([ -f "$TEST_DIR/.enforce-contract-ran" ] && echo present || echo absent)"
  echo "    TEST_HOME: $([ -f "$TEST_HOME/.enforce-contract-ran" ] && echo present || echo absent)"
  echo "    REPO_ROOT: $([ -f "$REPO_ROOT/.enforce-contract-ran" ] && echo present || echo absent)"
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
# F1 regression (diagnosis 20260611-234742): the fixture mirrors the REAL
# post-PR-373 repo layout — sources under plugins/claude-code/hooks/, NO
# top-level hooks/ directory. The old line-62 probe `[ ! -d "$source_repo/hooks" ]`
# emitted a false "source repo unavailable" every SessionStart against this
# layout; test 10 fails if that probe regresses.
FRESH_SRC="$TEST_DIR/fresh-source-repo"
FRESH_SRC_HOOKS="$FRESH_SRC/plugins/claude-code/hooks"
FRESH_INSTALLED="$TEST_HOME/.claude/hooks"
mkdir -p "$FRESH_SRC_HOOKS/lib" "$FRESH_INSTALLED/lib" "$TEST_HOME/.episodic-memory"
cp "$REPO_ROOT/plugins/claude-code/hooks/plan-gate.sh" "$FRESH_SRC_HOOKS/plan-gate.sh"
cp "$REPO_ROOT/plugins/claude-code/hooks/em-recall-sessionstart.sh" "$FRESH_SRC_HOOKS/em-recall-sessionstart.sh"
cp "$REPO_ROOT/plugins/claude-code/hooks/lib/command-classifier.sh" "$FRESH_SRC_HOOKS/lib/command-classifier.sh"
cp "$FRESH_SRC_HOOKS/plan-gate.sh" "$FRESH_INSTALLED/plan-gate.sh"
cp "$FRESH_SRC_HOOKS/em-recall-sessionstart.sh" "$FRESH_INSTALLED/em-recall-sessionstart.sh"
cp "$FRESH_SRC_HOOKS/lib/command-classifier.sh" "$FRESH_INSTALLED/lib/command-classifier.sh"

cat > "$TEST_HOME/.episodic-memory/hook-install.json" <<EOF
{
  "schema_version": 1,
  "source_repo": "$FRESH_SRC",
  "hooks_dir": "$FRESH_INSTALLED",
  "files": [
    {
      "relative_path": "plugins/claude-code/hooks/plan-gate.sh",
      "installed_path": "$FRESH_INSTALLED/plan-gate.sh",
      "source_sha256": "unused-in-runtime",
      "source_version": "2026-05-08.1"
    },
    {
      "relative_path": "plugins/claude-code/hooks/em-recall-sessionstart.sh",
      "installed_path": "$FRESH_INSTALLED/em-recall-sessionstart.sh",
      "source_sha256": "unused-in-runtime",
      "source_version": "2026-05-08.1"
    },
    {
      "relative_path": "plugins/claude-code/hooks/lib/command-classifier.sh",
      "installed_path": "$FRESH_INSTALLED/lib/command-classifier.sh",
      "source_sha256": "unused-in-runtime",
      "source_version": "2026-05-08.1"
    }
  ]
}
EOF

# Reject EVERY freshness output class, not just the two historical greps —
# the missing_source line ("manifest references missing source files")
# previously matched neither grep, so a broken fixture passed vacuously.
output="$(run_hook_capture)"
if ! echo "$output" | grep -q "hook freshness warning" \
  && ! echo "$output" | grep -q "installed Claude hooks differ" \
  && ! echo "$output" | grep -q "installed Claude hooks are missing" \
  && ! echo "$output" | grep -q "missing source files" \
  && ! echo "$output" | grep -q "source repo unavailable"; then
  echo "  ✓ 10. Current installed hooks are quiet (no top-level hooks/ in source repo)"
  ((passed++))
else
  echo "  ✗ 10. Current installed hooks produced a freshness warning"
  echo "    output: $output"
  ((failed++))
fi

printf '\n# local edit without version bump\n' >> "$FRESH_INSTALLED/plan-gate.sh"
output="$(run_hook_capture)"
if echo "$output" | grep -q "plugins/claude-code/hooks/plan-gate.sh" \
  && echo "$output" | grep -q -- "--install-hooks-force"; then
  echo "  ✓ 11. Manual installed hook edit is reported without overwrite"
  ((passed++))
else
  echo "  ✗ 11. Manual installed hook edit was not reported clearly"
  echo "    output: $output"
  ((failed++))
fi

cp "$FRESH_SRC_HOOKS/plan-gate.sh" "$FRESH_INSTALLED/plan-gate.sh"
printf '\n# local lib edit without version bump\n' >> "$FRESH_INSTALLED/lib/command-classifier.sh"
output="$(run_hook_capture)"
if echo "$output" | grep -q "plugins/claude-code/hooks/lib/command-classifier.sh"; then
  echo "  ✓ 12. Managed hook lib drift is reported"
  ((passed++))
else
  echo "  ✗ 12. Managed hook lib drift was not reported"
  echo "    output: $output"
  ((failed++))
fi

# Individual source file gone under an EXISTING repo → per-file loop
# classifies it missing_source (the loop, not the root probe, owns
# file-level classification post-F1).
cp "$FRESH_SRC_HOOKS/lib/command-classifier.sh" "$FRESH_INSTALLED/lib/command-classifier.sh"
rm "$FRESH_SRC_HOOKS/plan-gate.sh"
output="$(run_hook_capture)"
if echo "$output" | grep -q "missing source files" \
  && echo "$output" | grep -q "plugins/claude-code/hooks/plan-gate.sh"; then
  echo "  ✓ 13. Missing individual source file is classified by the per-file loop"
  ((passed++))
else
  echo "  ✗ 13. Missing individual source file was not reported"
  echo "    output: $output"
  ((failed++))
fi
cp "$REPO_ROOT/plugins/claude-code/hooks/plan-gate.sh" "$FRESH_SRC_HOOKS/plan-gate.sh"

mv "$FRESH_SRC" "$FRESH_SRC.moved"
output="$(run_hook_capture)"
if echo "$output" | grep -q "source repo unavailable"; then
  echo "  ✓ 14. Missing source repo is reported"
  ((passed++))
else
  echo "  ✗ 14. Missing source repo was not reported"
  echo "    output: $output"
  ((failed++))
fi

# ============================================================================
echo ""
echo "--- F5 live-E2E: real enforce-contract writes .session-baseline ---"
# ============================================================================
# Stage the REAL enforce-contract.mjs + its full import closure at the canonical
# install path, fire the hook against a git temp repo, and assert the relocated
# SessionStart side-effect (.session-baseline) actually lands at the repo's
# .checkpoints/ (F2/F5 anti-orphan: the baseline the stop-gate carve-out depends
# on MUST be written post-relocation, else every Stop would fail-closed block).
E2E_HOME=$(mktemp -d)
E2E_REPO=$(mktemp -d)
mkdir -p "$E2E_HOME/.episodic-memory/scripts/lib"
cp "$REPO_ROOT/scripts/enforce-contract.mjs" "$E2E_HOME/.episodic-memory/scripts/enforce-contract.mjs"
for lib in local-dir marker-paths marker-state session-id bp001-advisory json-instance-validate effective-tier; do
  cp "$REPO_ROOT/scripts/lib/$lib.mjs" "$E2E_HOME/.episodic-memory/scripts/lib/$lib.mjs"
done
( cd "$E2E_REPO" && git init -q -b main && git config user.email t@t && git config user.name t && echo x > README.md && git add . && git commit -q -m init ) >/dev/null 2>&1
HOME="$E2E_HOME" bash -c "echo '{\"cwd\": \"$E2E_REPO\"}' | bash '$HOOK'" >/dev/null 2>&1
if [ -f "$E2E_REPO/.checkpoints/.session-baseline" ]; then
  echo "  ✓ 15. real enforce-contract --session-start writes .session-baseline (F5 anti-orphan)"
  ((passed++))
else
  echo "  ✗ 15. .session-baseline NOT written by real hook E2E"
  ((failed++))
fi
rm -rf "$E2E_HOME" "$E2E_REPO"

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
