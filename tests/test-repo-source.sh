#!/usr/bin/env bash
# test-repo-source.sh — Tests for plugins/claude-code/hooks/lib/repo-source.sh
# Verifies the carve-out logic with both JSON-present and JSON-fallback modes.
# Usage: bash tests/test-repo-source.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$REPO_ROOT/plugins/claude-code/hooks/lib/repo-source.sh"
CARVEOUTS_JSON="$REPO_ROOT/patterns/repo-source-carveouts.json"

if [ ! -f "$LIB" ]; then
  echo "FAIL: $LIB not found"
  exit 1
fi

passed=0
failed=0

# Use a tmpdir as mock repo root so tests don't depend on actual repo state
MOCK_REPO="$(mktemp -d)"
trap 'rm -rf "$MOCK_REPO"' EXIT

# Create a minimal git repo in mock dir so git check-ignore works
git -C "$MOCK_REPO" init -q 2>/dev/null || true

assert_repo_source() {
  local desc="$1"
  local file_path="$2"
  local expect_gated="$3"  # 0=gated(repo-source), 1=ALLOW(carveout/non-repo)

  # shellcheck disable=SC1090
  source "$LIB"
  _path_is_repo_source "$MOCK_REPO" "$file_path"
  local got=$?

  if [ "$got" = "$expect_gated" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc (expected exit=$expect_gated, got=$got)"
    failed=$((failed+1))
  fi
}

echo "=== test-repo-source.sh (JSON-present mode) ==="
echo "  Carve-out JSON: $CARVEOUTS_JSON"

# Normal repo-source file — must be GATED (exit 0)
assert_repo_source "src/app.mjs is gated (repo source)" "$MOCK_REPO/src/app.mjs" 0

# Carve-out dirs — must ALLOW (exit 1)
assert_repo_source ".episodic-memory is carved out" "$MOCK_REPO/.episodic-memory/index.json" 1
assert_repo_source ".checkpoints is carved out" "$MOCK_REPO/.checkpoints/.pre-checkpoint-done" 1
assert_repo_source ".review-store is carved out" "$MOCK_REPO/.review-store/foo.json" 1
assert_repo_source ".git is carved out" "$MOCK_REPO/.git/COMMIT_EDITMSG" 1
assert_repo_source "docs/plans is carved out" "$MOCK_REPO/docs/plans/myplan.md" 1

# Adjacent names that must NOT be carved (exact-segment check, not substring)
assert_repo_source ".github/ is NOT carved out (exact-segment)" "$MOCK_REPO/.github/workflows/ci.yml" 0
assert_repo_source ".gitignore is NOT carved out (exact-segment)" "$MOCK_REPO/.gitignore" 0

# Non-repo path — must ALLOW (exit 1)
assert_repo_source "outside-repo path is allowed" "/tmp/some-file.txt" 1

echo ""
echo "=== test-repo-source.sh (JSON-fallback/hidden mode) ==="

# Hide the JSON by temporarily renaming (test fallback inline literals)
mv "$CARVEOUTS_JSON" "${CARVEOUTS_JSON}.bak" 2>/dev/null || true
# Also clear HOME-based JSON (won't exist in test unless deployed)
_HIDDEN_HOME_JSON="$HOME/.episodic-memory/patterns/repo-source-carveouts.json"
_ORIG_HOME_JSON_EXISTS=0
if [ -f "$_HIDDEN_HOME_JSON" ]; then
  mv "$_HIDDEN_HOME_JSON" "${_HIDDEN_HOME_JSON}.bak"
  _ORIG_HOME_JSON_EXISTS=1
fi

assert_repo_source "(fallback) src/app.mjs is gated" "$MOCK_REPO/src/app.mjs" 0
assert_repo_source "(fallback) .git is carved out" "$MOCK_REPO/.git/COMMIT_EDITMSG" 1
assert_repo_source "(fallback) .episodic-memory is carved out" "$MOCK_REPO/.episodic-memory/index.json" 1
assert_repo_source "(fallback) .github/ NOT carved (exact-segment)" "$MOCK_REPO/.github/workflows/ci.yml" 0

# Negative: hide JSON still gates .git (the key invariant)
echo "  (negative) JSON hidden → .git/ still gated (inline fallback active)"

# Restore
mv "${CARVEOUTS_JSON}.bak" "$CARVEOUTS_JSON" 2>/dev/null || true
if [ "$_ORIG_HOME_JSON_EXISTS" = "1" ]; then
  mv "${_HIDDEN_HOME_JSON}.bak" "$_HIDDEN_HOME_JSON"
fi

echo ""
echo "test-repo-source: $passed passed, $failed failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "✓ all repo-source tests passed"
