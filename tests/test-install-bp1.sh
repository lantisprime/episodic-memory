#!/usr/bin/env bash
# test-install-bp1.sh — Idempotence + correctness tests for install.mjs's
# BP-1 deltas (PR-1a / RFC-004 M0).
#
# Verifies:
#   - First install creates ~/.episodic-memory/.verify-key (mode 0600, 32 bytes)
#   - First install creates ~/.episodic-memory/config.json with bp1 skeleton
#   - Re-install does not regenerate the verify-key
#   - Re-install fixes 0644 → 0600 drift
#   - .gitignore append for .episodic-memory/ is line-anchored
#     (a comment mentioning .episodic-memory does NOT silently suppress the append)
#   - .gitignore append is idempotent across two consecutive runs
#   - .gitignore append for run.key pattern is line-anchored too

set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

PASS=0
FAIL=0
SKIP_GIT=0

# Cross-platform file mode reader. macOS BSD stat uses -f; GNU stat uses -c.
# Selecting on `uname` is more reliable than `stat -f x || stat -c x` because
# Linux `stat -f` is filesystem-stat (returns info, no error) — the || would
# never fall through.
if [ "$(uname)" = "Darwin" ]; then
  stat_mode() { stat -f '%Lp' "$1"; }
else
  stat_mode() { stat -c '%a' "$1"; }
fi

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "ok ${label}"
  else
    FAIL=$((FAIL + 1))
    echo "not ok ${label}: expected '${expected}', got '${actual}'"
  fi
}

# ---------------------------------------------------------------------------
# Test 1: clean-slate install
# ---------------------------------------------------------------------------
HOME1="$TMP_ROOT/home1"
PROJ1="$TMP_ROOT/proj1"
mkdir -p "$HOME1" "$PROJ1"
echo "" > "$PROJ1/.gitignore"

HOME="$HOME1" node "$REPO_DIR/install.mjs" --tool claude-code --project "$PROJ1" >/dev/null 2>&1

check "verify-key exists" "1" "$([ -f "$HOME1/.episodic-memory/.verify-key" ] && echo 1)"
check "config.json exists" "1" "$([ -f "$HOME1/.episodic-memory/config.json" ] && echo 1)"

# Mode 0600 — stat -f on macOS, stat -c on linux. Try macOS first.
MODE=$(stat_mode "$HOME1/.episodic-memory/.verify-key")
check "verify-key mode 0600" "600" "$MODE"

SIZE=$(wc -c < "$HOME1/.episodic-memory/.verify-key" | tr -d ' ')
check "verify-key 32 bytes" "32" "$SIZE"

# config.json shape — minimal grep
grep -q '"bp1"' "$HOME1/.episodic-memory/config.json" && BP1_KEY=1 || BP1_KEY=0
check "config.json has bp1 key" "1" "$BP1_KEY"

# .gitignore appends both patterns
grep -qx '.episodic-memory/' "$PROJ1/.gitignore" && APP1=1 || APP1=0
check ".gitignore: .episodic-memory/ appended" "1" "$APP1"
grep -qx '\*\*/.episodic-memory/runs/\*/run\.key' "$PROJ1/.gitignore" && APP2=1 || APP2=0
check ".gitignore: run.key pattern appended" "1" "$APP2"

# ---------------------------------------------------------------------------
# Test 2: re-install is idempotent (no double-append, no key regen)
# ---------------------------------------------------------------------------
KEY1=$(shasum -a 256 "$HOME1/.episodic-memory/.verify-key" | awk '{print $1}')
LINES_BEFORE=$(wc -l < "$PROJ1/.gitignore")

HOME="$HOME1" node "$REPO_DIR/install.mjs" --tool claude-code --project "$PROJ1" >/dev/null 2>&1

KEY2=$(shasum -a 256 "$HOME1/.episodic-memory/.verify-key" | awk '{print $1}')
LINES_AFTER=$(wc -l < "$PROJ1/.gitignore")
check "verify-key not regenerated" "$KEY1" "$KEY2"
check ".gitignore line count stable across re-install" "$LINES_BEFORE" "$LINES_AFTER"

# ---------------------------------------------------------------------------
# Test 3: chmod drift heals on re-install
# ---------------------------------------------------------------------------
chmod 0644 "$HOME1/.episodic-memory/.verify-key"
HOME="$HOME1" node "$REPO_DIR/install.mjs" --tool claude-code --project "$PROJ1" >/dev/null 2>&1
MODE_AFTER=$(stat_mode "$HOME1/.episodic-memory/.verify-key")
check "verify-key mode healed back to 0600" "600" "$MODE_AFTER"

# ---------------------------------------------------------------------------
# Test 4: line-anchored gitignore guard — comment mentioning .episodic-memory
# does NOT suppress the real append. Finding 2, MAJOR, code-review.
# ---------------------------------------------------------------------------
HOME2="$TMP_ROOT/home2"
PROJ2="$TMP_ROOT/proj2"
mkdir -p "$HOME2" "$PROJ2"
cat > "$PROJ2/.gitignore" <<'EOF'
node_modules/
# my notes about .episodic-memory data location
EOF

HOME="$HOME2" node "$REPO_DIR/install.mjs" --tool claude-code --project "$PROJ2" >/dev/null 2>&1

grep -qx '.episodic-memory/' "$PROJ2/.gitignore" && C1=1 || C1=0
check "comment mention does NOT suppress .episodic-memory/ append" "1" "$C1"

# ---------------------------------------------------------------------------
# Test 5: existing real entry is respected (no duplicate append)
# ---------------------------------------------------------------------------
HOME3="$TMP_ROOT/home3"
PROJ3="$TMP_ROOT/proj3"
mkdir -p "$HOME3" "$PROJ3"
cat > "$PROJ3/.gitignore" <<'EOF'
node_modules/
.episodic-memory/
EOF
LINES_BEFORE3=$(wc -l < "$PROJ3/.gitignore")

HOME="$HOME3" node "$REPO_DIR/install.mjs" --tool claude-code --project "$PROJ3" >/dev/null 2>&1

# .episodic-memory/ count must not double, but run.key pattern is added once
EM_COUNT=$(grep -cx '.episodic-memory/' "$PROJ3/.gitignore")
check "no duplicate .episodic-memory/ entry" "1" "$EM_COUNT"

# ---------------------------------------------------------------------------
TOTAL=$((PASS + FAIL))
echo ""
echo "1..$TOTAL"
if [ "$FAIL" -gt 0 ]; then
  echo "# FAILED $FAIL of $TOTAL"
  exit 1
else
  echo "# PASSED $PASS"
fi
