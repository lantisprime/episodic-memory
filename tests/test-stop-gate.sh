#!/usr/bin/env bash
# test-stop-gate.sh — Tests for #128 hooks/stop-gate.sh + em-recall --gate stop
#
# Three layers per feedback_bp1_step9_filing_trigger.md sister lesson
# `20260504-113349-...-3ef1` (Layer-3 explicit failure-scenario tests):
#   Layer 1 — em-recall --gate stop unit cases (subprocess; controlled fixtures)
#   Layer 2 — stop-gate.sh integration (simulated hook input piped through shell)
#   Layer 3 — explicit failure scenarios (corrupt marker, missing .claude,
#             worktree-cwd resolution, SubagentStop conversion, hook-script
#             missing, stop_hook_active short-circuit, malformed JSON input)
#
# Defensive ordering per feedback_test_resource_existence_check.md: every
# state assertion is paired with an existence check on the artifact at
# check time, so a misordered cleanup doesn't make the test pass for the
# wrong reason.

set -e

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/hooks/stop-gate.sh"
EM_RECALL="$REPO_ROOT/scripts/em-recall.mjs"

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

# Build a pristine temp git repo for each test that needs one.
mk_repo() {
  local d="$1"
  rm -rf "$d"
  mkdir -p "$d"
  ( cd "$d" && \
    git init -q -b main && \
    git config user.email test@example.com && \
    git config user.name test && \
    echo x > README.md && \
    git add . && \
    git commit -q -m init )
}

# Run em-recall --gate stop with REPO_ROOT-pinned cwd; returns stdout.
gate_stop() {
  local cwd="$1"
  ( cd "$cwd" && node "$EM_RECALL" --gate stop 2>/dev/null )
}

# Pipe a synthetic hook input JSON through the hook script. Mocks
# HOME so the hook resolves the canonical em-recall to our repo's copy.
run_hook() {
  local input_json="$1"
  local fake_home="$2"
  echo "$input_json" | HOME="$fake_home" bash "$HOOK" 2>/dev/null
}

# Build a fake HOME with em-recall.mjs at the canonical install path so
# the hook's lookup at "$HOME/.episodic-memory/scripts/em-recall.mjs"
# resolves correctly. The fake HOME also gets a copy of the resolver lib
# so em-recall.mjs's import works.
mk_fake_home() {
  local fake_home="$1"
  rm -rf "$fake_home"
  mkdir -p "$fake_home/.episodic-memory/scripts/lib"
  cp "$REPO_ROOT/scripts/em-recall.mjs" "$fake_home/.episodic-memory/scripts/em-recall.mjs"
  cp "$REPO_ROOT/scripts/lib/local-dir.mjs" "$fake_home/.episodic-memory/scripts/lib/local-dir.mjs"
}

TMP_ROOT="$(mktemp -d -t em-stopgate-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ============================================================================
# Layer 1 — em-recall --gate stop unit cases
# ============================================================================
echo ""
echo "=== Layer 1: em-recall --gate stop unit cases ==="

L1_REPO="$TMP_ROOT/L1"
mk_repo "$L1_REPO"
mkdir -p "$L1_REPO/.claude"

# 1.1 No marker → empty stdout → allow
out="$(gate_stop "$L1_REPO")"
if [ -z "$out" ]; then pass "L1.1: no marker → empty stdout (allow)"
else fail "L1.1: no marker → empty stdout" "got: $out"
fi

# 1.2 Marker armed, post-done empty → block JSON
touch "$L1_REPO/.claude/.checkpoint-required"
out="$(gate_stop "$L1_REPO")"
if echo "$out" | grep -q '"decision":"block"'; then pass "L1.2: armed + post-empty → block"
else fail "L1.2: armed + post-empty → block" "got: $out"
fi

# Defensive existence check: the marker we set still exists at this point.
if [ -f "$L1_REPO/.claude/.checkpoint-required" ]; then pass "L1.2 (defensive): marker still present at check time"
else fail "L1.2 defensive existence" "marker disappeared between setup and assertion"
fi

# 1.3 Marker armed, post-done non-empty → empty stdout (allow)
echo "post-checkpoint content" > "$L1_REPO/.claude/.post-checkpoint-done"
out="$(gate_stop "$L1_REPO")"
if [ -z "$out" ]; then pass "L1.3: armed + post-non-empty → empty stdout (allow)"
else fail "L1.3: armed + post-non-empty" "got: $out"
fi

# 1.4 Marker armed, post-done exists but EMPTY (size 0) → block (size matters, not presence)
rm "$L1_REPO/.claude/.post-checkpoint-done"
touch "$L1_REPO/.claude/.post-checkpoint-done"
out="$(gate_stop "$L1_REPO")"
if echo "$out" | grep -q '"decision":"block"'; then pass "L1.4: armed + post-zero-bytes → block"
else fail "L1.4: armed + post-zero-bytes → block" "got: $out"
fi

# 1.5 Invalid --gate value → error JSON, exit 1
set +e
out="$(node "$EM_RECALL" --gate prewrite 2>&1)"
rc=$?
set -e
if [ "$rc" = "1" ] && echo "$out" | grep -q "Invalid --gate"; then pass "L1.5: invalid --gate → error + exit 1"
else fail "L1.5: invalid --gate" "rc=$rc out=$out"
fi

# ============================================================================
# Layer 2 — stop-gate.sh integration via piped JSON
# ============================================================================
echo ""
echo "=== Layer 2: stop-gate.sh integration ==="

L2_REPO="$TMP_ROOT/L2"
mk_repo "$L2_REPO"
mkdir -p "$L2_REPO/.claude"
L2_HOME="$TMP_ROOT/L2_home"
mk_fake_home "$L2_HOME"

# 2.1 No marker, hook input minimal → empty/no decision → allow
input='{"session_id":"test","stop_hook_active":false}'
out="$(cd "$L2_REPO" && run_hook "$input" "$L2_HOME")"
if [ -z "$out" ]; then pass "L2.1: no marker → hook emits nothing (allow)"
else fail "L2.1: no marker → empty" "got: $out"
fi

# 2.2 Marker armed, post-done empty → hook emits block JSON
touch "$L2_REPO/.claude/.checkpoint-required"
out="$(cd "$L2_REPO" && run_hook "$input" "$L2_HOME")"
if echo "$out" | grep -q '"decision":"block"'; then pass "L2.2: armed + post-empty → hook block"
else fail "L2.2: armed + post-empty → hook block" "got: $out"
fi
# Defensive: marker still present
if [ -f "$L2_REPO/.claude/.checkpoint-required" ]; then pass "L2.2 (defensive): marker still present"
else fail "L2.2 defensive" "marker missing at check time"
fi

# 2.3 Marker armed, post-done non-empty → hook emits nothing
echo "post block" > "$L2_REPO/.claude/.post-checkpoint-done"
out="$(cd "$L2_REPO" && run_hook "$input" "$L2_HOME")"
if [ -z "$out" ]; then pass "L2.3: armed + post-non-empty → hook allow"
else fail "L2.3: armed + post-non-empty → hook allow" "got: $out"
fi
rm "$L2_REPO/.claude/.post-checkpoint-done"

# 2.4 stop_hook_active=true → hook short-circuits BEFORE invoking node
# (verify by removing em-recall from the fake home; if the hook still
# exits 0 with no output, we know it never tried to call it)
rm "$L2_HOME/.episodic-memory/scripts/em-recall.mjs"
input_active='{"session_id":"test","stop_hook_active":true}'
out="$(cd "$L2_REPO" && run_hook "$input_active" "$L2_HOME")"
if [ -z "$out" ]; then pass "L2.4: stop_hook_active=true → short-circuit (no node call)"
else fail "L2.4: stop_hook_active short-circuit" "got: $out (expected empty; em-recall was deliberately removed)"
fi
# Restore em-recall for subsequent tests
mk_fake_home "$L2_HOME"

# ============================================================================
# Layer 3 — explicit failure-scenario tests
# ============================================================================
echo ""
echo "=== Layer 3: explicit failure scenarios ==="

# 3.1 Worktree-cwd resolution: hook fires from a linked worktree, marker
# is at MAIN repo .claude/, hook must resolve and read MAIN's marker
# (post-#106 invariant). NOT the worktree's empty .claude/.
L3_MAIN="$TMP_ROOT/L3_main"
L3_WT="$TMP_ROOT/L3_wt"
mk_repo "$L3_MAIN"
( cd "$L3_MAIN" && git worktree add -q -b wt-branch "$L3_WT" )

mkdir -p "$L3_MAIN/.claude"
touch "$L3_MAIN/.claude/.checkpoint-required"
# Worktree's .claude/ does NOT exist — would falsely allow if resolver
# walked to wrong root.

L3_HOME="$TMP_ROOT/L3_home"
mk_fake_home "$L3_HOME"

input_min='{"session_id":"test"}'
# Run from the worktree cwd
out="$(cd "$L3_WT" && run_hook "$input_min" "$L3_HOME")"
if echo "$out" | grep -q '"decision":"block"'; then pass "L3.1: hook from worktree resolves to MAIN .claude/ + blocks"
else fail "L3.1: worktree resolution" "got: $out (expected block; main has armed marker)"
fi
# Defensive: confirm marker still at main, NOT at worktree
if [ -f "$L3_MAIN/.claude/.checkpoint-required" ] && [ ! -f "$L3_WT/.claude/.checkpoint-required" ]; then
  pass "L3.1 (defensive): marker at main, NOT worktree at check time"
else
  fail "L3.1 defensive" "marker location wrong at check time"
fi

# 3.2 .claude/ dir entirely missing → no marker → allow (graceful)
L3_NO_CLAUDE="$TMP_ROOT/L3_noclaude"
mk_repo "$L3_NO_CLAUDE"
# Deliberately do NOT create .claude/
out="$(cd "$L3_NO_CLAUDE" && run_hook "$input_min" "$L3_HOME")"
if [ -z "$out" ]; then pass "L3.2: missing .claude dir → graceful allow"
else fail "L3.2: missing .claude" "got: $out"
fi

# 3.3 Marker armed, .post-checkpoint-done is a directory not a file (corrupt state)
# fs.statSync will succeed with non-zero blksize but our code uses .size
# (which is 0 for directories on most platforms but undefined in spec).
# Intent: even a weird state should not crash; hook should still emit
# something parseable.
L3_CORRUPT="$TMP_ROOT/L3_corrupt"
mk_repo "$L3_CORRUPT"
mkdir -p "$L3_CORRUPT/.claude/.post-checkpoint-done"  # dir, not file
touch "$L3_CORRUPT/.claude/.checkpoint-required"
set +e
out="$(cd "$L3_CORRUPT" && run_hook "$input_min" "$L3_HOME")"
rc=$?
set -e
if [ "$rc" = "0" ]; then pass "L3.3: corrupt state → hook exits 0 (no crash)"
else fail "L3.3: corrupt state crash" "rc=$rc out=$out"
fi

# 3.4 em-recall.mjs missing entirely → fail-loud block envelope
L3_NOSCRIPT_HOME="$TMP_ROOT/L3_noscript_home"
mkdir -p "$L3_NOSCRIPT_HOME/.episodic-memory/scripts"
# Deliberately do NOT copy em-recall.mjs
out="$(cd "$L3_MAIN" && echo "$input_min" | HOME="$L3_NOSCRIPT_HOME" bash "$HOOK" 2>/dev/null)"
# JSON style varies between em-recall (no spaces) and shell echo (with spaces);
# match either via the field name regex.
if echo "$out" | grep -qE '"decision":[[:space:]]*"block"' && echo "$out" | grep -q "em-recall.mjs not found"; then
  pass "L3.4: missing em-recall.mjs → fail-loud block envelope"
else
  fail "L3.4: missing em-recall fail-loud" "got: $out"
fi

# 3.5 SubagentStop variant — same shell, same JSON shape, same behavior
# (the hook is content-agnostic about which event registered it).
input_subagent='{"session_id":"test","stop_hook_active":false}'
mkdir -p "$L3_MAIN/.claude"
touch "$L3_MAIN/.claude/.checkpoint-required"
rm -f "$L3_MAIN/.claude/.post-checkpoint-done"
out="$(cd "$L3_MAIN" && run_hook "$input_subagent" "$L3_HOME")"
if echo "$out" | grep -q '"decision":"block"'; then pass "L3.5: SubagentStop event input → same block decision"
else fail "L3.5: SubagentStop" "got: $out"
fi

# 3.6 Malformed JSON input (jq receives garbage) → hook should not crash
# stop_hook_active extraction returns "false" on jq failure; gate runs.
input_bad='not valid json'
set +e
out="$(cd "$L3_MAIN" && echo "$input_bad" | HOME="$L3_HOME" bash "$HOOK" 2>/dev/null)"
rc=$?
set -e
if [ "$rc" = "0" ]; then pass "L3.6: malformed input JSON → hook exits 0 (no crash)"
else fail "L3.6: malformed JSON" "rc=$rc out=$out"
fi

# 3.7 stop_hook_active=true takes precedence over armed marker
# (proves the short-circuit fires before marker check)
input_active='{"session_id":"test","stop_hook_active":true}'
out="$(cd "$L3_MAIN" && run_hook "$input_active" "$L3_HOME")"
if [ -z "$out" ]; then pass "L3.7: stop_hook_active=true overrides armed marker (short-circuits)"
else fail "L3.7: stop_hook_active precedence" "got: $out (expected empty; armed marker should be ignored when active)"
fi
# Defensive: prove the marker is still armed (i.e., we DIDN'T disarm it
# accidentally; the short-circuit just bypassed the check)
if [ -f "$L3_MAIN/.claude/.checkpoint-required" ]; then pass "L3.7 (defensive): marker still present (short-circuit didn't mutate state)"
else fail "L3.7 defensive" "marker disappeared during short-circuit"
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "=================================================="
echo "Results: $PASS passed, $FAIL failed"
echo "=================================================="
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for f in "${FAILURES[@]}"; do echo "  $f"; done
  exit 1
fi
exit 0
