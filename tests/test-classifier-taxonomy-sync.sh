#!/usr/bin/env bash
# test-classifier-taxonomy-sync.sh — RFC-008 P3c runtime taxonomy-sourcing tests
# for hooks/lib/command-classifier.sh (maps to R4 / F4 / F6).
#
# Usage: bash tests/test-classifier-taxonomy-sync.sh
#
# Each case runs the classifier in a FRESH bash process (the _ensure_taxonomy_
# synced guard caches per-process via a NON-exported var) with a controlled
# HOME and a chosen classifier copy, so we can drive every resolution branch:
#   - installed-layout copy: candidate-2 repo-proof predicate FAILS (no repo
#     sentinels above ~/.claude/hooks/lib), so candidate 1 ($HOME/.episodic-
#     memory/patterns/taxonomy.json) is the only source — full control.
#   - real in-repo classifier: candidate 2 (proven climb) resolves.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$REPO_ROOT/plugins/claude-code/hooks/lib/command-classifier.sh"
GOOD_TAX="$REPO_ROOT/patterns/taxonomy.json"
TAB=$'\t'

if [ ! -f "$LIB" ]; then echo "FAIL: $LIB not found"; exit 1; fi
if [ ! -f "$GOOD_TAX" ]; then echo "FAIL: $GOOD_TAX not found"; exit 1; fi

passed=0
failed=0

# --- fixtures -------------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/p3c-taxsync.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Installed-layout classifier copy: $TMP/home/.claude/hooks/lib/...
INST_HOME="$TMP/home"
INST_LIB_DIR="$INST_HOME/.claude/hooks/lib"
mkdir -p "$INST_LIB_DIR"
cp "$LIB" "$INST_LIB_DIR/command-classifier.sh"
INST_LIB="$INST_LIB_DIR/command-classifier.sh"

# Helper: write a candidate-1 taxonomy under a given HOME dir.
plant_global_tax() {  # home_dir  src_json
  local home="$1" src="$2"
  mkdir -p "$home/.episodic-memory/patterns"
  cp "$src" "$home/.episodic-memory/patterns/taxonomy.json"
}

# Drift taxonomy: good labels + one EXTRA id (set != _priority arms).
DRIFT_TAX="$TMP/drift.json"
node -e 'const fs=require("fs");const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));t.labels.push({id:"extra_label",meaning:"x",overridable:true,gates:{plan_approval:"block",pre_checkpoint:"block",post_checkpoint:"block"}});fs.writeFileSync(process.argv[2],JSON.stringify(t))' "$GOOD_TAX" "$DRIFT_TAX"

# Malformed taxonomy: labels is not an array.
MALFORMED_TAX="$TMP/malformed.json"
printf '%s' '{"labels":"nope"}' > "$MALFORMED_TAX"

# Empty taxonomy: labels is an empty array.
EMPTY_TAX="$TMP/empty.json"
printf '%s' '{"labels":[]}' > "$EMPTY_TAX"

# --- run helpers (fresh process per call) ---------------------------------
cc() {  # home  lib  cmd   -> "label<TAB>target<TAB>reason"
  HOME="$1" bash -c 'source "$1"; classify_command "$2" "/tmp/p3c-rr"' _ "$2" "$3" 2>/dev/null
}
cp_() {  # home  lib  path  -> classify_path
  HOME="$1" bash -c 'source "$1"; classify_path "$2" "/tmp/p3c-rr"' _ "$2" "$3" 2>/dev/null
}
label_of() { printf '%s' "${1%%"$TAB"*}"; }
reason_of() { local r="${1#*"$TAB"}"; printf '%s' "${r#*"$TAB"}"; }

assert_eq() {  # desc  actual  expected
  if [ "$2" = "$3" ]; then
    echo "  ✓ $1"; passed=$((passed+1))
  else
    echo "  ✗ $1"; echo "    expected: $3"; echo "    got:      $2"; failed=$((failed+1))
  fi
}

echo ""
echo "--- candidate 1 (installed layout): in-sync ---"
plant_global_tax "$INST_HOME" "$GOOD_TAX"
out="$(cc "$INST_HOME" "$INST_LIB" "ls -la")"
assert_eq "S01 in-sync: ls stays read_only" "$(label_of "$out")" "read_only"
out="$(cc "$INST_HOME" "$INST_LIB" "git push")"
assert_eq "S02 in-sync: git push stays push_or_pr_create" "$(label_of "$out")" "push_or_pr_create"

echo ""
echo "--- drift → fail-closed (taxonomy_drift) ---"
plant_global_tax "$INST_HOME" "$DRIFT_TAX"
out="$(cc "$INST_HOME" "$INST_LIB" "ls -la")"
assert_eq "S10 drift: ls → unsafe_complex" "$(label_of "$out")" "unsafe_complex"
assert_eq "S11 drift: reason=taxonomy_drift" "$(reason_of "$out")" "taxonomy_drift"

echo ""
echo "--- marker_write is NEVER fail-closed (deadlock escape) ---"
# drift still planted
out="$(cc "$INST_HOME" "$INST_LIB" "rm $INST_HOME/.checkpoints/.plan-approval-pending")"
assert_eq "S12 drift: marker rm stays marker_write" "$(label_of "$out")" "marker_write"
out="$(cp_ "$INST_HOME" "$INST_LIB" ".pre-checkpoint-done")"
assert_eq "S13 drift: classify_path marker stays marker_write" "$(label_of "$out")" "marker_write"

echo ""
echo "--- classify_path non-marker fail-closes under drift (codex R1-P1) ---"
out="$(cp_ "$INST_HOME" "$INST_LIB" "scripts/em-store.mjs")"
assert_eq "S14 drift: classify_path src → unsafe_complex" "$(label_of "$out")" "unsafe_complex"
assert_eq "S15 drift: classify_path reason=taxonomy_drift" "$(reason_of "$out")" "taxonomy_drift"

echo ""
echo "--- empty labels array → fail-closed ---"
plant_global_tax "$INST_HOME" "$EMPTY_TAX"
out="$(cc "$INST_HOME" "$INST_LIB" "ls -la")"
assert_eq "S20 empty labels: ls → unsafe_complex" "$(label_of "$out")" "unsafe_complex"

echo ""
echo "--- malformed (labels non-array) → taxonomy_unresolved via node exit!=0 ---"
plant_global_tax "$INST_HOME" "$MALFORMED_TAX"
out="$(cc "$INST_HOME" "$INST_LIB" "ls -la")"
assert_eq "S30 malformed: ls → unsafe_complex" "$(label_of "$out")" "unsafe_complex"
assert_eq "S31 malformed: reason=taxonomy_unresolved" "$(reason_of "$out")" "taxonomy_unresolved"

echo ""
echo "--- unresolved (no taxonomy anywhere, installed layout) ---"
EMPTY_HOME="$TMP/emptyhome"
mkdir -p "$EMPTY_HOME/.claude/hooks/lib"
cp "$LIB" "$EMPTY_HOME/.claude/hooks/lib/command-classifier.sh"
out="$(cc "$EMPTY_HOME" "$EMPTY_HOME/.claude/hooks/lib/command-classifier.sh" "ls -la")"
assert_eq "S40 unresolved: ls → unsafe_complex" "$(label_of "$out")" "unsafe_complex"
assert_eq "S41 unresolved: reason=taxonomy_unresolved" "$(reason_of "$out")" "taxonomy_unresolved"

echo ""
echo "--- installed-layout ambient fallback REJECTED (codex R2-P1) ---"
# climbed root = $AMB_HOME/.. (4 up from .claude/hooks/lib). Plant an ambient
# patterns/taxonomy.json at the climbed root WITHOUT repo sentinels → predicate
# must fail → taxonomy_unresolved, NOT a successful ambient read.
AMB_BASE="$TMP/amb"
AMB_HOME="$AMB_BASE/a/b/home"   # climb from home/.claude/hooks/lib goes up 4 → $AMB_BASE/a/b/home? no:
# .claude/hooks/lib -> hooks -> .claude -> home -> b  (4 levels up from lib dir's parent chain)
mkdir -p "$AMB_HOME/.claude/hooks/lib"
cp "$LIB" "$AMB_HOME/.claude/hooks/lib/command-classifier.sh"
# climbed = realpath("$AMB_HOME/.claude/hooks/lib/../../../..") = "$AMB_BASE/a/b"
AMB_CLIMB="$AMB_BASE/a/b"
mkdir -p "$AMB_CLIMB/patterns"
cp "$GOOD_TAX" "$AMB_CLIMB/patterns/taxonomy.json"   # ambient taxonomy, no sentinels
out="$(cc "$AMB_HOME" "$AMB_HOME/.claude/hooks/lib/command-classifier.sh" "ls -la")"
assert_eq "S50 ambient: predicate rejects → unsafe_complex" "$(label_of "$out")" "unsafe_complex"
assert_eq "S51 ambient: reason=taxonomy_unresolved (not ambient read)" "$(reason_of "$out")" "taxonomy_unresolved"

echo ""
echo "--- in-repo candidate-2 proof (real classifier, empty HOME) ---"
NO_GLOBAL_HOME="$TMP/noglobal"
mkdir -p "$NO_GLOBAL_HOME"
out="$(cc "$NO_GLOBAL_HOME" "$LIB" "ls -la")"
assert_eq "S60 candidate-2 in-repo resolves: ls read_only" "$(label_of "$out")" "read_only"

echo ""
echo "--- symlinked HOME path still resolves (/var→/private/var class) ---"
SYM_REAL="$TMP/symreal"
mkdir -p "$SYM_REAL/.claude/hooks/lib"
cp "$LIB" "$SYM_REAL/.claude/hooks/lib/command-classifier.sh"
plant_global_tax "$SYM_REAL" "$GOOD_TAX"
SYM_LINK="$TMP/symlink-home"
ln -s "$SYM_REAL" "$SYM_LINK"
out="$(cc "$SYM_LINK" "$SYM_LINK/.claude/hooks/lib/command-classifier.sh" "git push")"
assert_eq "S70 symlinked home: in-sync resolves, push stays push" "$(label_of "$out")" "push_or_pr_create"

echo ""
echo "--- non-exported guard: child re-validates ---"
# Source under in-sync, run once (sets guard), then a child bash must NOT see
# _TAXONOMY_SYNC_DONE inherited (it is non-exported).
plant_global_tax "$INST_HOME" "$GOOD_TAX"
inherited="$(HOME="$INST_HOME" bash -c 'source "$1"; classify_command "ls" "/tmp/rr" >/dev/null; bash -c "printf %s \"\${_TAXONOMY_SYNC_DONE:-UNSET}\""' _ "$INST_LIB" 2>/dev/null)"
assert_eq "S80 guard var not exported to child" "$inherited" "UNSET"

echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="
[ "$failed" -eq 0 ]
