#!/usr/bin/env bash
#
# tests/test-preflight-gate-sid-parser.sh — #279 Stream 2 grammar tests.
#
# Tests the structural command-form grammar enforced at the preflight-gate's
# helper-invocation branch:
#
#   <command> := <env-prefix>* <executable> <helper-script-path> <helper-flags>*
#   <env-prefix> name ∈ _ROUTINE_ENV_ALLOWLIST  (NODE_ENV, DEBUG, CI, PYTHONPATH, LOG_LEVEL)
#   <executable> basename ∈ _NODE_BINARY_BASENAME_ALLOWLIST  (node)
#
# Class A (8 accept) proves the allow combinatorial.
# Class B (19 deny) proves each rule branch fires across variant classes.
# Class C (sid-form: --session-id A vs --session-id=A vs duplicate vs missing
#   etc.) lives in test-preflight-gate.sh M/N-series — not re-tested here.
#
# Codex r9 plan-tier ACCEPT-with-FU; B19 added per the inline FU.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE_INPUT_TMPL='{"tool_name":"Bash","tool_input":{"command":"%s"},"cwd":"%s","session_id":"%s","transcript_path":"/tmp/x"}'

passed=0
failed=0
SESSION_ID="test-session-$$"

# Stage a minimal tmp project. Mirrors test-preflight-gate.sh stage_fixture.
mktmp() { mktemp -d -t emt279.XXXXXX; }

stage_fixture() {
  local tmp="$1"
  mkdir -p "$tmp/scripts/lib" "$tmp/hooks/lib" "$tmp/.checkpoints" "$tmp/bundles"
  (cd "$tmp" && git init -q 2>/dev/null) || true
  cp "$REPO_ROOT/scripts/preflight-marker-write.mjs" "$tmp/scripts/"
  cp "$REPO_ROOT/scripts/lib/canonicalize-path-tolerant.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/local-dir.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/marker-paths.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/session-id.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/marker-root-validation.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/hooks/preflight-gate.sh" "$tmp/hooks/"
  cp "$REPO_ROOT/hooks/lib/command-classifier.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/hooks/lib/repo-root.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/hooks/lib/marker-paths.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/bundles/codex-review-channel-current.md" "$tmp/bundles/"
}

cleanup_dirs=()
on_exit() { local d; for d in "${cleanup_dirs[@]+${cleanup_dirs[@]}}"; do [ -n "$d" ] && rm -rf "$d"; done; }
trap on_exit EXIT
_track() { cleanup_dirs+=("$1"); }

# run_gate_grammar <tmp> <cmd> <expect:allow|deny> <reason_grep> <desc>
# Runs the helper-invocation portion of the gate. <cmd> should contain the
# helper basename so the helper-invocation branch fires.
run_gate_grammar() {
  local tmp="$1" cmd="$2" expect="$3" reason_grep="$4" desc="$5"
  local cmd_escaped
  cmd_escaped="$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  local payload
  payload="$(printf "$GATE_INPUT_TMPL" "$cmd_escaped" "$tmp" "$SESSION_ID")"
  local out
  out="$(printf '%s' "$payload" | bash "$tmp/hooks/preflight-gate.sh" 2>&1 || true)"

  if [ "$expect" = "allow" ]; then
    # Allow path: gate emits no JSON OR emits non-deny.
    local decision
    decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || echo "")"
    if [ -z "$out" ] || [ "$decision" != "deny" ]; then
      echo "  ✓ $desc"
      passed=$((passed+1))
    else
      echo "  ✗ $desc — expected allow but denied: $out"
      failed=$((failed+1))
    fi
  else
    local decision reason
    decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || echo "")"
    reason="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null || echo "")"
    if [ "$decision" = "deny" ] && printf '%s' "$reason" | grep -qE "$reason_grep"; then
      echo "  ✓ $desc"
      passed=$((passed+1))
    else
      echo "  ✗ $desc — got decision='$decision' reason='$reason' (expected deny matching /$reason_grep/)"
      failed=$((failed+1))
    fi
  fi
}

TF="$(mktmp)"; _track "$TF"; stage_fixture "$TF"
HELPER="$TF/scripts/preflight-marker-write.mjs"
COMMON_FLAGS="--root $TF --target preflight --session-id $SESSION_ID"

echo "--- Class A: ACCEPT (proves the allow combinatorial) ---"

# A1: bare node invocation, no env-prefix
run_gate_grammar "$TF" "node $HELPER $COMMON_FLAGS" "allow" "" \
  "A1 bare node invocation, no env-prefix"

# A2: path-spelled node
run_gate_grammar "$TF" "/usr/bin/node $HELPER $COMMON_FLAGS" "allow" "" \
  "A2 /usr/bin/node path-spelled"

# A3: different node install path
run_gate_grammar "$TF" "/usr/local/bin/node $HELPER $COMMON_FLAGS" "allow" "" \
  "A3 /usr/local/bin/node path"

# A4: relative path node
run_gate_grammar "$TF" "./node_modules/.bin/node $HELPER $COMMON_FLAGS" "allow" "" \
  "A4 ./node_modules/.bin/node relative path"

# A5: single allowlist env-prefix
run_gate_grammar "$TF" "NODE_ENV=production node $HELPER $COMMON_FLAGS" "allow" "" \
  "A5 NODE_ENV=production allowlist env-prefix"

# A6: multiple allowlist env-prefixes
run_gate_grammar "$TF" "NODE_ENV=production DEBUG=1 node $HELPER $COMMON_FLAGS" "allow" "" \
  "A6 NODE_ENV + DEBUG (multiple allowlist)"

# A7: three allowlist env-prefixes
run_gate_grammar "$TF" "CI=true PYTHONPATH=. LOG_LEVEL=debug node $HELPER $COMMON_FLAGS" "allow" "" \
  "A7 CI + PYTHONPATH + LOG_LEVEL (full multi)"

# A8: allowlist env-prefix + path-spelled node
run_gate_grammar "$TF" "DEBUG=1 /usr/bin/node $HELPER $COMMON_FLAGS" "allow" "" \
  "A8 DEBUG=1 + /usr/bin/node (combined)"

echo ""
echo "--- Class B: DENY (one row per rule branch, not per variant) ---"

# B1-B4: env wrapper (all variants collapse to basename=env)
run_gate_grammar "$TF" "env node $HELPER $COMMON_FLAGS" "deny" "basename 'env'" \
  "B1 env wrapper → basename=env deny"
run_gate_grammar "$TF" "/usr/bin/env node $HELPER $COMMON_FLAGS" "deny" "basename 'env'" \
  "B2 /usr/bin/env path-spelled → same rule"
run_gate_grammar "$TF" "/bin/env -i node $HELPER $COMMON_FLAGS" "deny" "basename 'env'" \
  "B3 /bin/env -i variant → same rule"
run_gate_grammar "$TF" "./env node $HELPER $COMMON_FLAGS" "deny" "basename 'env'" \
  "B4 ./env relative-path → same rule"

# B5-B10: non-env wrappers (all collapse to wrapper deny)
run_gate_grammar "$TF" "sudo node $HELPER $COMMON_FLAGS" "deny" "basename 'sudo'" \
  "B5 sudo wrapper"
run_gate_grammar "$TF" "npx node $HELPER $COMMON_FLAGS" "deny" "basename 'npx'" \
  "B6 npx shim wrapper"
run_gate_grammar "$TF" "nohup node $HELPER $COMMON_FLAGS" "deny" "basename 'nohup'" \
  "B7 nohup wrapper"
run_gate_grammar "$TF" "time node $HELPER $COMMON_FLAGS" "deny" "basename 'time'" \
  "B8 time wrapper"
run_gate_grammar "$TF" "python $HELPER $COMMON_FLAGS" "deny" "basename 'python'" \
  "B9 wrong interpreter (python)"
run_gate_grammar "$TF" "bash $HELPER $COMMON_FLAGS" "deny" "basename 'bash'" \
  "B10 shell wrapper (bash)"

# B11-B13: non-allowlist env-prefix
run_gate_grammar "$TF" "SKIP_PREFLIGHT=1 node $HELPER $COMMON_FLAGS" "deny" "SKIP_PREFLIGHT" \
  "B11 SKIP_PREFLIGHT=1 non-allowlist"
run_gate_grammar "$TF" "BYPASS_GATE=1 node $HELPER $COMMON_FLAGS" "deny" "BYPASS_GATE" \
  "B12 BYPASS_GATE=1 non-allowlist"
run_gate_grammar "$TF" "SESSION_ID=A node $HELPER $COMMON_FLAGS" "deny" "SESSION_ID" \
  "B13 SESSION_ID=A non-allowlist (form-rejection)"

# B14-B16: benign-prefix walk → then non-allow at next position
run_gate_grammar "$TF" "NODE_ENV=production env SKIP_PREFLIGHT=1 node $HELPER $COMMON_FLAGS" "deny" "basename 'env'" \
  "B14 benign-prefix walk → T[p]=env (NOT step 2)"
run_gate_grammar "$TF" "NODE_ENV=production /usr/bin/env node $HELPER $COMMON_FLAGS" "deny" "basename 'env'" \
  "B15 benign-prefix walk → path-env"
run_gate_grammar "$TF" "NODE_ENV=production sudo node $HELPER $COMMON_FLAGS" "deny" "basename 'sudo'" \
  "B16 benign-prefix walk → non-env wrapper"

# B17: benign-prefix walk → suspicious-prefix
run_gate_grammar "$TF" "NODE_ENV=production SKIP_PREFLIGHT=1 node $HELPER $COMMON_FLAGS" "deny" "SKIP_PREFLIGHT" \
  "B17 benign-prefix walk → suspicious-prefix (step 2 deny)"

# B18: T[p] is a flag, not an executable
# In practice the grammar walk would see `--session-id` as T[idx] and treat
# basename as `--session-id` which is not 'node'. The helper-basename regex
# also fires here. Reasonable verdict: wrapper deny on the flag's basename.
run_gate_grammar "$TF" "--session-id A $HELPER --root $TF --target preflight" "deny" "basename '--session-id'|invalid POSIX-name" \
  "B18 T[p]=--session-id (flag at exec position)"

# B19: trailing-slash token (per codex r9 P3 FU). _tokenize emits the path
# as-is; `${path##*/}` yields empty string for trailing slash → not in
# allowlist → deny.
run_gate_grammar "$TF" "/usr/bin/node/ $HELPER $COMMON_FLAGS" "deny" "basename ''" \
  "B19 trailing-slash token → empty basename → deny (codex r9 FU)"

echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="
exit $((failed > 0 ? 1 : 0))
