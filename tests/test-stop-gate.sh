#!/usr/bin/env bash
# test-stop-gate.sh — Tests for #128 hooks/stop-gate.sh + enforce-contract --gate stop
#
# RFC-008 P3d (F38/F60): the stop decision relocated em-recall.mjs →
# enforce-contract.mjs (--gate stop). The former Layer-1 `em-recall --gate stop`
# subprocess unit cases were RETIRED here — that decision logic is now owned by
# enforce-contract and unit-tested directly in test-enforce-contract.mjs (suite A,
# incl. A9 migrated from the old L1.4 zero-byte edge). This file keeps the hook
# integration + failure-scenario layers, which exercise the real stop-gate.sh →
# enforce-contract path.
#
# Layers per feedback_bp1_step9_filing_trigger.md sister lesson
# `20260504-113349-...-3ef1` (Layer-3 explicit failure-scenario tests):
#   Layer 2 — stop-gate.sh integration (simulated hook input piped through shell)
#   Layer 3 — explicit failure scenarios (corrupt marker, missing .claude,
#             worktree-cwd resolution, SubagentStop conversion, hook-script
#             missing, stop_hook_active short-circuit, malformed JSON input)
#   Layer 4 — M5 retime-and-rearm contract (enforce-contract --session-start)
#
# Defensive ordering per feedback_test_resource_existence_check.md: every
# state assertion is paired with an existence check on the artifact at
# check time, so a misordered cleanup doesn't make the test pass for the
# wrong reason.

set -e

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/plugins/claude-code/hooks/stop-gate.sh"
ENFORCE="$REPO_ROOT/scripts/enforce-contract.mjs"

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

# Pipe a synthetic hook input JSON through the hook script. Mocks
# HOME so the hook resolves the canonical enforce-contract to our repo's copy.
run_hook() {
  local input_json="$1"
  local fake_home="$2"
  echo "$input_json" | HOME="$fake_home" bash "$HOOK" 2>/dev/null
}

# Build a fake HOME with enforce-contract.mjs at the canonical install path so
# the hook's lookup at "$HOME/.episodic-memory/scripts/enforce-contract.mjs"
# resolves correctly. The fake HOME also gets a copy of the import closure so
# enforce-contract.mjs loads. RFC-008 P3d: em-recall.mjs is no longer staged —
# stop-gate.sh + em-recall-sessionstart.sh both invoke enforce-contract now.
mk_fake_home() {
  local fake_home="$1"
  rm -rf "$fake_home"
  mkdir -p "$fake_home/.episodic-memory/scripts/lib"
  # RFC-008 P3b-1 (2026-06-15): stop-gate.sh invokes enforce-contract.mjs
  # (the stop decision relocated OUT of em-recall into the enforcement layer,
  # byte-identical). Stage it + its full import closure (marker-state,
  # marker-paths, local-dir, session-id — all copied below) so the hook's
  # canonical-path lookup resolves; a missing transitive dep would make the
  # module fail to load and the hook fall back to the loud-fail envelope,
  # passing the test for the wrong reason.
  cp "$REPO_ROOT/scripts/enforce-contract.mjs" "$fake_home/.episodic-memory/scripts/enforce-contract.mjs"
  cp "$REPO_ROOT/scripts/lib/local-dir.mjs" "$fake_home/.episodic-memory/scripts/lib/local-dir.mjs"
  # 2026-05-09 .checkpoints/ migration: enforce-contract imports
  # marker-paths.mjs; without it the module fails to load and the hook
  # falls back to the loud-fail block envelope.
  cp "$REPO_ROOT/scripts/lib/marker-paths.mjs" "$fake_home/.episodic-memory/scripts/lib/marker-paths.mjs"
  # RFC-008 P3a (2026-06-15): enforce-contract imports marker-state.mjs (relocated
  # from stop-gate-helpers.mjs) for the active-plan exemption
  # (_maxMtimeAcrossRootsStrict). marker-state imports the already-copied
  # marker-paths.mjs.
  cp "$REPO_ROOT/scripts/lib/marker-state.mjs" "$fake_home/.episodic-memory/scripts/lib/marker-state.mjs"
  # 2026-05-18 concurrent-session fix: enforce-contract imports session-id.mjs for
  # the --session-id flag (codex R1 P1.2; logging-only in v6 sweep).
  cp "$REPO_ROOT/scripts/lib/session-id.mjs" "$fake_home/.episodic-memory/scripts/lib/session-id.mjs"
  # RFC-008 P3b-2 (2026-06-17): enforce-contract.mjs gained the effective-tier
  # layer, importing effective-tier.mjs (the min() algebra) + json-instance-
  # validate.mjs (enforce-config.json schema validation in loadEnforceConfig).
  # Both are zero-further-dep; the real install copies ALL scripts/lib/*.mjs, but
  # this hand-staged fake HOME must list each transitive dep or the module fails
  # to load and the hook falls back to the loud-fail envelope (false pass).
  cp "$REPO_ROOT/scripts/lib/effective-tier.mjs" "$fake_home/.episodic-memory/scripts/lib/effective-tier.mjs"
  cp "$REPO_ROOT/scripts/lib/json-instance-validate.mjs" "$fake_home/.episodic-memory/scripts/lib/json-instance-validate.mjs"
  # RFC-008 P3d (2026-06-18): enforce-contract.mjs imports bp001-advisory.mjs
  # (the relocated --session-start bp-001 advisory). Load-time dep regardless of
  # whether the stop gate calls it; omit it and the module fails to load.
  cp "$REPO_ROOT/scripts/lib/bp001-advisory.mjs" "$fake_home/.episodic-memory/scripts/lib/bp001-advisory.mjs"
}

TMP_ROOT="$(mktemp -d -t em-stopgate-XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ============================================================================
# Layer 1 — RETIRED (RFC-008 P3d). The `em-recall --gate stop` subprocess unit
# cases (no-marker→allow, armed→block, post-done size semantics, invalid-gate
# error) moved to test-enforce-contract.mjs suite A (A1/A2/A3 + A9 for the
# zero-byte post-done edge; C1/C2 for the invalid-gate error). enforce-contract
# is the sole owner of the stop decision; Layer 2 below exercises the hook path.
# ============================================================================

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
# (verify by removing enforce-contract from the fake home; if the hook still
# exits 0 with no output, we know it never tried to call it)
rm "$L2_HOME/.episodic-memory/scripts/enforce-contract.mjs"
input_active='{"session_id":"test","stop_hook_active":true}'
out="$(cd "$L2_REPO" && run_hook "$input_active" "$L2_HOME")"
if [ -z "$out" ]; then pass "L2.4: stop_hook_active=true → short-circuit (no node call)"
else fail "L2.4: stop_hook_active short-circuit" "got: $out (expected empty; enforce-contract was deliberately removed)"
fi
# Restore enforce-contract for subsequent tests
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

# 3.4 enforce-contract.mjs missing entirely → fail-loud block envelope
# (RFC-008 P3b-1: the hook now resolves enforce-contract.mjs at the canonical
# path; CLASS-C(c) requires a missing binary to block LOUD, never allow-always.)
L3_NOSCRIPT_HOME="$TMP_ROOT/L3_noscript_home"
mkdir -p "$L3_NOSCRIPT_HOME/.episodic-memory/scripts"
# Deliberately do NOT copy enforce-contract.mjs
out="$(cd "$L3_MAIN" && echo "$input_min" | HOME="$L3_NOSCRIPT_HOME" bash "$HOOK" 2>/dev/null)"
# JSON style varies between node (no spaces) and shell echo (with spaces);
# match either via the field name regex.
if echo "$out" | grep -qE '"decision":[[:space:]]*"block"' && echo "$out" | grep -q "enforce-contract.mjs not found"; then
  pass "L3.4: missing enforce-contract.mjs → fail-loud block envelope"
else
  fail "L3.4: missing enforce-contract fail-loud" "got: $out"
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

# 3.8 BYPASS REGRESSION (Codex round-1 finding 1, P1):
# Hook PROCESS cwd is /private/tmp (outside any project) but hook INPUT JSON
# has cwd pointing at the armed repo. Pre-fix: stop-gate.sh ignored input
# cwd → enforce-contract resolveRepoRoot resolved from /private/tmp → silently
# allowed Stop on the armed project. Post-fix: hook parses input cwd,
# cd's to it, enforce-contract reads main repo's .claude/ correctly → blocks.
mkdir -p "$L3_MAIN/.claude"
touch "$L3_MAIN/.claude/.checkpoint-required"
rm -f "$L3_MAIN/.claude/.post-checkpoint-done"
input_with_cwd="$(printf '{"cwd":"%s","stop_hook_active":false}' "$L3_MAIN")"
# Use a platform-agnostic temp dir for "outside any project" cwd. `/private/tmp`
# was macOS-specific; on Linux it doesn't exist and `cd` failed under set -e
# (bash 5 errexit extends to assignment-with-cmdsubst). PR #271 CI catch.
OUTSIDE_DIR="$(mktemp -d)"
out="$(cd "$OUTSIDE_DIR" 2>/dev/null && echo "$input_with_cwd" | HOME="$L3_HOME" bash "$HOOK" 2>/dev/null)"
rmdir "$OUTSIDE_DIR" 2>/dev/null || true
if echo "$out" | grep -qE '"decision":[[:space:]]*"block"'; then
  pass "L3.8: hook from /private/tmp + input cwd→armed repo → blocks (Codex finding 1 regression)"
else
  fail "L3.8: bypass regression (Codex P1 finding)" "got: $out (expected block; armed marker at $L3_MAIN/.claude/.checkpoint-required)"
fi
# Defensive: confirm the marker we set still exists at this point
if [ -f "$L3_MAIN/.claude/.checkpoint-required" ]; then pass "L3.8 (defensive): marker still present at check time"
else fail "L3.8 defensive existence" "marker disappeared between setup and assertion"
fi

# 3.9 INVALID .cwd graceful-fail: input cwd points at non-existent dir.
# Per #70 wrong-project class, we must NOT run enforce-contract in whatever cwd
# the hook process inherited. Hook should fail-soft (empty stdout = allow).
input_bad_cwd='{"cwd":"/nonexistent-path-for-test","stop_hook_active":false}'
out="$(cd "$L3_MAIN" && echo "$input_bad_cwd" | HOME="$L3_HOME" bash "$HOOK" 2>/dev/null)"
# Note: even though we cd'd to L3_MAIN (which has armed marker), the bad
# input .cwd takes precedence. The hook tries to cd to the bad path, fails,
# and exits 0 with no decision (graceful — don't run enforce-contract in
# inherited cwd to avoid #70 wrong-project bug).
if [ -z "$out" ]; then
  pass "L3.9: invalid input .cwd → fail-soft, no decision (#70 wrong-project guard)"
else
  fail "L3.9: invalid cwd graceful-fail" "got: $out (expected empty; should not run enforce-contract in inherited cwd)"
fi

# 3.10 Empty .cwd in input falls back to pwd (canonical pattern).
# When .cwd is "" or missing, hook uses pwd. Process cwd here is L3_MAIN
# (armed); should block.
input_no_cwd='{"stop_hook_active":false}'
out="$(cd "$L3_MAIN" && echo "$input_no_cwd" | HOME="$L3_HOME" bash "$HOOK" 2>/dev/null)"
if echo "$out" | grep -qE '"decision":[[:space:]]*"block"'; then
  pass "L3.10: missing input .cwd → falls back to pwd → blocks correctly"
else
  fail "L3.10: cwd fallback to pwd" "got: $out"
fi

# ============================================================================
# Layer 4 — M5 retime-and-rearm contract (2026-05-18 orphan-deadlock fix)
#
# After SessionStart force-monotonic baseline, the stop-gate carve-out
# invariant `marker.mtime <= baseline.mtime` holds for ANY pre-existing
# checkpoint marker:
#   E1  Stop is ALLOWED (carve-out fires).
#   E2  The writer-gate (checkpoint-gate.sh) still BLOCKS writes because
#       the marker file is still present on disk — preserving safety for
#       concurrent live sessions while unblocking Stop for crashed-session
#       orphans.
#
# Together E1+E2 prove the M5 trade-off: Stop unblocked, writer-gate intact.
# ============================================================================
echo ""
echo "=== Layer 4: M5 retime-and-rearm contract ==="

L4_HOME="$TMP_ROOT/L4_HOME"
L4_REPO="$TMP_ROOT/L4_REPO"
mk_fake_home "$L4_HOME"
mk_repo "$L4_REPO"
mkdir -p "$L4_REPO/.checkpoints" "$L4_REPO/.claude"

# Plant an orphan .checkpoint-required from a notional prior crashed session.
touch "$L4_REPO/.checkpoints/.checkpoint-required"
# Force its mtime to 1 hour in the past so it's clearly "stale".
PAST_TS=$(($(date +%s) - 3600))
touch -t "$(date -r $PAST_TS '+%Y%m%d%H%M.%S')" "$L4_REPO/.checkpoints/.checkpoint-required" 2>/dev/null || \
  touch -d "@$PAST_TS" "$L4_REPO/.checkpoints/.checkpoint-required"

# Fire SessionStart on the repo (force-monotonic baseline writes).
( cd "$L4_REPO" && HOME="$L4_HOME" node "$ENFORCE" --session-start >/dev/null 2>&1 ) || true

# Marker MUST be preserved (M5 contract: no rm of CR/PostR).
if [ -e "$L4_REPO/.checkpoints/.checkpoint-required" ]; then
  pass "L4 setup: pre-existing CR preserved across SessionStart (M5 retime)"
else
  fail "L4 setup: pre-existing CR was swept" "expected M5 retime contract"
fi

# E1: Stop is ALLOWED — carve-out fires because baseline.mtime > marker.mtime.
input_e1="{\"stop_hook_active\":false,\"cwd\":\"$L4_REPO\"}"
out_e1="$(echo "$input_e1" | HOME="$L4_HOME" bash "$HOOK" 2>/dev/null)"
if [ -z "$out_e1" ]; then
  pass "E1: Stop ALLOWED after force-monotonic baseline (carve-out invariant)"
else
  fail "E1: Stop should be allowed" "got: $out_e1 (expected empty)"
fi

# E2: Writer-gate BLOCKS various tool surfaces — marker is on disk.
CHECKPOINT_HOOK="$REPO_ROOT/plugins/claude-code/hooks/checkpoint-gate.sh"
if [ ! -x "$CHECKPOINT_HOOK" ]; then
  echo "  (skip E2: checkpoint-gate.sh not executable)"
else
  for tool in Write Edit MultiEdit NotebookEdit; do
    input_e2="{\"cwd\":\"$L4_REPO\",\"tool_name\":\"$tool\",\"tool_input\":{\"file_path\":\"$L4_REPO/x.txt\",\"content\":\"x\"}}"
    out_e2="$(echo "$input_e2" | HOME="$L4_HOME" bash "$CHECKPOINT_HOOK" 2>/dev/null || true)"
    if echo "$out_e2" | grep -qiE 'block|checkpoint required|pre-checkpoint'; then
      pass "E2 ($tool): writer-gate BLOCKS — marker still on disk"
    else
      fail "E2 ($tool): writer-gate should block" "got: $out_e2"
    fi
  done

  # Bash write-class (e.g., redirect via tee). The checkpoint-gate may also gate
  # Bash; treat block-or-allow as acceptable but not silently broken — the key
  # invariant is the marker is on disk.
  if [ -e "$L4_REPO/.checkpoints/.checkpoint-required" ]; then
    pass "E2 (disk-state): .checkpoint-required present after gate dispatches"
  else
    fail "E2 (disk-state): .checkpoint-required vanished mid-test" "M5 contract broken"
  fi
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
