#!/usr/bin/env bash
#
# tests/test-preflight-gate-foreign-project.sh — regression for issue #441.
#
# BUG (#441): preflight-gate.sh resolved CANON_LIB / HELPER_PATH SOLELY from
# $REPO_ROOT/scripts/... . That path exists only inside the episodic-memory repo,
# so in ANY foreign project the canon lib was missing → _canonicalize_one returned
# 99 → the marker-write block hard-DENIED every Write|Edit|MultiEdit|NotebookEdit,
# before any target/active check, with no in-session self-recovery (the fix itself
# is an Edit). See plugins/claude-code/hooks/preflight-gate.sh.
#
# FIX: resolve both constants CO-LOCATED first ($HOOK_DIR / $LIB_DIR), which the
# installer deploys into <project>/.claude/hooks{,/lib}/ for every project.
#
# This test deliberately does NOT stage a fake scripts/ tree under the target (the
# pattern in tests/test-preflight-gate.sh masks the foreign layout — codex review
# 2026-07-04). It drives the REAL installer into an isolated foreign project and
# exercises the INSTALLED gate against the INSTALLED layout, then asserts the
# co-located deps are what makes it pass (bidirectional: present→allow, removed→deny).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/install.mjs"

passed=0
failed=0
TEST_HOME=""
TEST_PROJECT=""
SESSION_ID="foreign-441-$$"

cleanup() { [ -n "$TEST_HOME" ] && rm -rf "$TEST_HOME"; [ -n "$TEST_PROJECT" ] && rm -rf "$TEST_PROJECT"; }
trap cleanup EXIT

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $name"
    passed=$((passed+1))
  else
    echo "  ✗ $name (expected '$expected', got '$actual')"
    failed=$((failed+1))
  fi
}

# Pipe a Write payload (foreign cwd) at the installed gate; echo "allow" (empty
# output) or "deny:<reason-substring-match>".
run_gate() {
  local cwd="$1" file_path="$2"
  local payload
  payload="$(jq -nc --arg fp "$file_path" --arg cwd "$cwd" --arg sid "$SESSION_ID" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:"x"}, cwd:$cwd, session_id:$sid, transcript_path:"/tmp/x"}')"
  printf '%s' "$payload" | bash "$TEST_PROJECT/.claude/hooks/preflight-gate.sh" 2>&1 || true
}

echo "[T1] Real install into an isolated FOREIGN project (no scripts/ tree)"
TEST_HOME=$(mktemp -d)
TEST_PROJECT=$(mktemp -d)
# A foreign project is a git repo (so resolve_repo_root works) with NO scripts/.
( cd "$TEST_PROJECT" && git init -q 2>/dev/null ) || true
HOME="$TEST_HOME" node "$INSTALLER" --tool claude-code --project "$TEST_PROJECT" --install-enforcement >/dev/null 2>&1

[ -x "$TEST_PROJECT/.claude/hooks/preflight-gate.sh" ] && r=true || r=false
assert_eq "T1a preflight-gate.sh installed + executable" "true" "$r"

# The defining property of a foreign project: it has NO repo scripts/ dir. This is
# exactly the condition the old code assumed away. (codex F4: assert it explicitly.)
[ -e "$TEST_PROJECT/scripts" ] && r=true || r=false
assert_eq "T1b foreign project has NO scripts/ tree" "false" "$r"

# Co-located deps the fix relies on must be present in the installed layout.
[ -f "$TEST_PROJECT/.claude/hooks/lib/canonicalize-path-tolerant.mjs" ] && r=true || r=false
assert_eq "T1c canonicalize-path-tolerant.mjs deployed co-located (hooks/lib/)" "true" "$r"
[ -f "$TEST_PROJECT/.claude/hooks/preflight-marker-write.mjs" ] && r=true || r=false
assert_eq "T1d preflight-marker-write.mjs deployed co-located (hooks/)" "true" "$r"

echo "[T2] The #441 blocking bug is gone: a Write is ALLOWED in the foreign project"
out="$(run_gate "$TEST_PROJECT" "$TEST_PROJECT/src/foo.txt")"
assert_eq "T2a Write allowed (gate emits no deny)" "" "$out"
# Belt-and-suspenders: the specific old failure reason must not appear.
if printf '%s' "$out" | grep -q "canonicalize-path-tolerant lib missing"; then r=true; else r=false; fi
assert_eq "T2b old canon-lib-missing deny reason absent" "false" "$r"

echo "[T3] Non-vacuity: removing the co-located canon lib re-introduces the deny"
# Prove the gate genuinely depends on the resolved lib (so the test would catch a
# regression). Remove ALL three resolution candidates: co-located (present), the
# repo fallback (absent — no scripts/), and the global fallback (remove if present).
rm -f "$TEST_PROJECT/.claude/hooks/lib/canonicalize-path-tolerant.mjs"
rm -f "$TEST_HOME/.episodic-memory/scripts/lib/canonicalize-path-tolerant.mjs" 2>/dev/null || true
out="$(run_gate "$TEST_PROJECT" "$TEST_PROJECT/src/foo.txt")"
if printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then r=true; else r=false; fi
assert_eq "T3a with all canon-lib candidates removed, gate denies (fail-closed)" "true" "$r"
if printf '%s' "$out" | grep -q "canonicalize-path-tolerant lib missing"; then r=true; else r=false; fi
assert_eq "T3b deny reason names the missing canon lib" "true" "$r"

echo "[T4] Path-quoting: an apostrophe in the project path still ALLOWS edits (#441 code-review)"
# codex 2026-07-04: _canonicalize_one must pass CANON_LIB as an argv value, not
# interpolate it into node -e JS source. A project dir named with an apostrophe would
# otherwise SyntaxError the import string → hard-deny every write (the #441 symptom via
# a quoting vector). Uses a fresh isolated install so the co-located CANON_LIB inherits
# the apostrophe-bearing path.
Q_HOME=$(mktemp -d)
Q_BASE=$(mktemp -d)
Q_PROJECT="$Q_BASE/proj-with-'quote"
mkdir -p "$Q_PROJECT"
( cd "$Q_PROJECT" && git init -q 2>/dev/null ) || true
HOME="$Q_HOME" node "$INSTALLER" --tool claude-code --project "$Q_PROJECT" --install-enforcement >/dev/null 2>&1
q_payload="$(jq -nc --arg fp "$Q_PROJECT/src/foo.txt" --arg cwd "$Q_PROJECT" --arg sid "$SESSION_ID" \
  '{tool_name:"Write", tool_input:{file_path:$fp, content:"x"}, cwd:$cwd, session_id:$sid, transcript_path:"/tmp/x"}')"
q_out="$(printf '%s' "$q_payload" | bash "$Q_PROJECT/.claude/hooks/preflight-gate.sh" 2>&1 || true)"
assert_eq "T4a Write allowed despite apostrophe in project path" "" "$q_out"
if printf '%s' "$q_out" | grep -qi "SyntaxError"; then r=true; else r=false; fi
assert_eq "T4b no JS SyntaxError leaked from the canon-lib import" "false" "$r"
rm -rf "$Q_HOME" "$Q_BASE"

echo ""
echo "Passed: $passed"
echo "Failed: $failed"
[ $failed -eq 0 ]
