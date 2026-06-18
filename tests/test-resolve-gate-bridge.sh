#!/usr/bin/env bash
# test-resolve-gate-bridge.sh — RFC-008 P4a.
#
# Drives the REAL plan-gate.sh against a STUB enforce-contract resolver to prove the
# bash bridge's fail-closed matching contract (F5), independent of the resolver's
# own logic (covered by test-resolve-gate.mjs) and of the classifier (plan-gate
# invokes the classifier only for Bash; this test uses the Write tool, which reaches
# the consult with no classifier dependency).
#
# F5 obligations under test:
#   - a safe token is matched by EXACT STRING EQUALITY (a substring that merely
#     CONTAINS "silence"/"clamp-off" must still BLOCK);
#   - the `RESULT="$(node …)" || RESULT=""` envelope fails CLOSED on a non-zero
#     exit even when the stub prints a safe token on stdout (the `local`-mask trap);
#   - `silence` and `clamp-off` both ALLOW; anything else BLOCKS.
#
# The stub at $HOME/.episodic-memory/scripts/enforce-contract.mjs honors STUB_TOKEN
# (stdout) + STUB_EXIT (exit code), inherited from this script's env through the
# hook's `node` spawn.

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_GATE="$REPO/plugins/claude-code/hooks/plan-gate.sh"
SID="11111111-2222-3333-4444-555555555555"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ✓ $1"; }
bad() { fail=$((fail+1)); echo "  ✗ $1: $2"; }

# Isolated HOME carrying the stub resolver at the canonical global path.
HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rgbridge-home-XXXXXX")"
mkdir -p "$HOME_DIR/.episodic-memory/scripts"
cat > "$HOME_DIR/.episodic-memory/scripts/enforce-contract.mjs" <<'STUB'
const t = process.env.STUB_TOKEN || ''
if (t.length) process.stdout.write(t + '\n')
process.exit(Number(process.env.STUB_EXIT || '0'))
STUB

# Marker-root: a git repo with an armed OWN-session plan-approval marker so
# plan-gate reaches the consult + (absent a safe token) the block path.
REPO_MR="$(mktemp -d "${TMPDIR:-/tmp}/rgbridge-mr-XXXXXX")"
git -C "$REPO_MR" init -q
mkdir -p "$REPO_MR/.checkpoints"
: > "$REPO_MR/.checkpoints/.plan-approval-pending.$SID"

INPUT='{"tool_name":"Write","cwd":"'"$REPO_MR"'","session_id":"'"$SID"'","tool_input":{"file_path":"'"$REPO_MR"'/src.txt"}}'

# run_plan_gate <stub_token> <stub_exit> → echoes hook stdout; sets RC.
run_plan_gate() {
  STUB_TOKEN="$1" STUB_EXIT="$2" HOME="$HOME_DIR" \
    bash "$PLAN_GATE" <<<"$INPUT"
}

echo "=== plan-gate.sh bridge — F5 fail-closed matching ==="

# 1. Exact "silence" → allow (empty stdout, no block decision).
out="$(run_plan_gate silence 0)"
if [ -z "$out" ]; then ok "silence → allow (no block)"; else bad "silence → allow" "got [$out]"; fi

# 2. Exact "clamp-off" → allow.
out="$(run_plan_gate clamp-off 0)"
if [ -z "$out" ]; then ok "clamp-off → allow (no block)"; else bad "clamp-off → allow" "got [$out]"; fi

# 3. No token (enforce) → BLOCK.
out="$(run_plan_gate '' 0)"
if echo "$out" | grep -qE '"decision": ?"block"'; then ok "empty token → block (enforce)"; else bad "empty → block" "got [$out]"; fi

# 4. SUBSTRING containing "silence" → BLOCK (exact-equality, not substring).
out="$(run_plan_gate 'please-silence-this-gate' 0)"
if echo "$out" | grep -qE '"decision": ?"block"'; then ok "substring 'silence' → block (exact-equality)"; else bad "substring → block" "got [$out]"; fi

# 5. Multi-line stdout whose FIRST line is a safe token → BLOCK (command
#    substitution yields a multi-line value != "silence").
out="$(run_plan_gate 'silence
extra-diagnostic-line' 0)"
if echo "$out" | grep -qE '"decision": ?"block"'; then ok "multi-line 'silence\\n…' → block"; else bad "multi-line → block" "got [$out]"; fi

# 6. ||-envelope: stub prints "silence" but EXITS NON-ZERO → cleared → BLOCK.
#    (The `local`-mask trap: a `local X=$(…)` would swallow this exit and wrongly allow.)
out="$(run_plan_gate silence 1)"
if echo "$out" | grep -qE '"decision": ?"block"'; then ok "silence + non-zero exit → block (||-envelope fail-closed)"; else bad "non-zero exit → block" "got [$out]"; fi

# 7. Missing resolver binary (stub absent) → node errors non-zero → BLOCK.
out="$(STUB_TOKEN=silence STUB_EXIT=0 HOME="$(mktemp -d)" bash "$PLAN_GATE" <<<"$INPUT")"
if echo "$out" | grep -qE '"decision": ?"block"'; then ok "missing enforce-contract.mjs → block (fail-closed)"; else bad "missing binary → block" "got [$out]"; fi

# 8. No plan marker at all → allow WITHOUT spawning the resolver (no marker → no gate).
REPO_NM="$(mktemp -d "${TMPDIR:-/tmp}/rgbridge-nm-XXXXXX")"
git -C "$REPO_NM" init -q
INPUT_NM='{"tool_name":"Write","cwd":"'"$REPO_NM"'","session_id":"'"$SID"'","tool_input":{"file_path":"'"$REPO_NM"'/src.txt"}}'
out="$(STUB_TOKEN='' STUB_EXIT=0 HOME="$HOME_DIR" bash "$PLAN_GATE" <<<"$INPUT_NM")"
if [ -z "$out" ]; then ok "no plan marker → allow (consult not reached)"; else bad "no marker → allow" "got [$out]"; fi

echo ""
echo "=== checkpoint-gate.sh bridge — F10 (post_checkpoint silence runs cleanup) + pre_checkpoint ==="
CKPT_GATE="$REPO/plugins/claude-code/hooks/checkpoint-gate.sh"

# F10 deadlock guard: under a post_checkpoint clamp (POST_SILENCED), a `git push`
# must (a) NOT block and (b) sweep .checkpoint-required so the subsequent stop gate
# cannot deadlock — NOT a bare exit 0 that strands the marker.
mk_armed_repo() {
  local r; r="$(mktemp -d "${TMPDIR:-/tmp}/rgbridge-ck-XXXXXX")"
  git -C "$r" init -q
  mkdir -p "$r/.checkpoints"
  : > "$r/.checkpoints/.checkpoint-required.$SID"   # armed, no post-done
  printf '%s' "$r"
}
push_input() { printf '{"tool_name":"Bash","cwd":"%s","session_id":"%s","tool_input":{"command":"git push"}}' "$1" "$SID"; }

# Case 9 — post_checkpoint clamp-off → push allowed AND .checkpoint-required swept.
R9="$(mk_armed_repo)"
out="$(STUB_TOKEN=clamp-off STUB_EXIT=0 HOME="$HOME_DIR" bash "$CKPT_GATE" <<<"$(push_input "$R9")")"
if [ -z "$out" ] && [ ! -e "$R9/.checkpoints/.checkpoint-required.$SID" ]; then
  ok "F10: post_checkpoint clamp → push allowed + .checkpoint-required swept (no deadlock)"
else
  bad "F10: silence runs cleanup" "stdout=[$out] marker_present=[$([ -e "$R9/.checkpoints/.checkpoint-required.$SID" ] && echo yes || echo no)]"
fi

# Case 10 — NON-vacuous control: no clamp → push BLOCKS + .checkpoint-required RETAINED.
R10="$(mk_armed_repo)"
out="$(STUB_TOKEN='' STUB_EXIT=0 HOME="$HOME_DIR" bash "$CKPT_GATE" <<<"$(push_input "$R10")")"
if echo "$out" | grep -qE '"decision": ?"block"' && [ -e "$R10/.checkpoints/.checkpoint-required.$SID" ]; then
  ok "F10 control: no clamp → push blocks + .checkpoint-required retained (clamp genuinely flips behavior)"
else
  bad "F10 control: no clamp blocks + retains" "stdout=[$out] marker_present=[$([ -e "$R10/.checkpoints/.checkpoint-required.$SID" ] && echo yes || echo no)]"
fi

# Case 11 — pre_checkpoint silence → repo-source Write allowed (consult exits 0).
R11="$(mk_armed_repo)"
write_input() { printf '{"tool_name":"Write","cwd":"%s","session_id":"%s","tool_input":{"file_path":"%s/src.txt"}}' "$1" "$SID" "$1"; }
out="$(STUB_TOKEN=silence STUB_EXIT=0 HOME="$HOME_DIR" bash "$CKPT_GATE" <<<"$(write_input "$R11")")"
if [ -z "$out" ]; then ok "pre_checkpoint silence → repo Write allowed"; else bad "pre_checkpoint silence → allow" "got [$out]"; fi

# Case 12 — pre_checkpoint control: no token → repo-source Write BLOCKS (_block_pre*).
R12="$(mk_armed_repo)"
out="$(STUB_TOKEN='' STUB_EXIT=0 HOME="$HOME_DIR" bash "$CKPT_GATE" <<<"$(write_input "$R12")")"
if echo "$out" | grep -qE '"decision": ?"block"'; then ok "pre_checkpoint control: no token → repo Write blocks"; else bad "pre_checkpoint control → block" "got [$out]"; fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "PASS — $pass checks"
  exit 0
else
  echo "FAIL — $fail of $((pass+fail)) checks"
  exit 1
fi
