#!/usr/bin/env bash
# test-layer-active-bridge.sh — RFC-008 P4c.
#
# Drives the REAL preflight-gate.sh + second-opinion-gate.mjs against a STUB
# `--layer-active` resolver to prove the layer-wide kill switch's fail-closed
# bridge contract on BOTH non-bp-001 surfaces — independent of the resolver's own
# logic (covered by test-layer-active.mjs):
#
#   preflight-gate.sh (bash, set -e):
#     - inactive  → bp-010 codex-review-handoff enforcement SILENCED (allow);
#     - active    → DENY (base behavior, non-vacuous control);
#     - consult ENOENT (degraded install) → still DENY (reviewer F1: set -e must
#       NOT abort the gate into a non-blocking exit 1 = un-gated tool);
#     - marker-write to the preflight marker is DENIED even when inactive
#       (planner G4: R4 marker_write is NON-overridable, survives the switch).
#
#   second-opinion-gate.mjs (node spawnSync):
#     - inactive  → whole gate OFF (allow);
#     - active    → block (base behavior);
#     - consult ENOENT → block (reviewer G1: spawn failure is fail-closed, NOT allow).
#
# The stub at $HOME/.episodic-memory/scripts/enforce-contract.mjs honors STUB_TOKEN
# (stdout) + STUB_EXIT (exit), inherited through each hook's `node` spawn.

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFLIGHT_SRC="$REPO/plugins/claude-code/hooks/preflight-gate.sh"
SECOND_OPINION="$REPO/plugins/claude-code/hooks/second-opinion-gate.mjs"
SID="11111111-2222-3333-4444-555555555555"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ✓ $1"; }
bad() { fail=$((fail+1)); echo "  ✗ $1: $2"; }
decision_of() { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || echo ""; }

# Isolated HOME carrying the stub resolver at the canonical global path.
mk_stub_home() {
  local h; h="$(mktemp -d "${TMPDIR:-/tmp}/layerbridge-home-XXXXXX")"
  mkdir -p "$h/.episodic-memory/scripts"
  cat > "$h/.episodic-memory/scripts/enforce-contract.mjs" <<'STUB'
const t = process.env.STUB_TOKEN || ''
if (t.length) process.stdout.write(t + '\n')
process.exit(Number(process.env.STUB_EXIT || '0'))
STUB
  printf '%s' "$h"
}

# stage_fixture <tmp-root> — minimal project hosting the gate + its libs (mirrors
# test-preflight-gate.sh so the staged preflight-gate.sh resolves CANON_LIB etc.).
stage_fixture() {
  local tmp="$1"
  mkdir -p "$tmp/scripts/lib" "$tmp/hooks/lib" "$tmp/.checkpoints" "$tmp/bundles"
  (cd "$tmp" && git init -q 2>/dev/null) || true
  cp "$REPO/scripts/preflight-marker-write.mjs" "$tmp/scripts/"
  cp "$REPO/scripts/lib/canonicalize-path-tolerant.mjs" "$tmp/scripts/lib/"
  cp "$REPO/scripts/lib/local-dir.mjs" "$tmp/scripts/lib/"
  cp "$REPO/scripts/lib/marker-paths.mjs" "$tmp/scripts/lib/"
  cp "$REPO/scripts/lib/session-id.mjs" "$tmp/scripts/lib/"
  cp "$REPO/scripts/lib/marker-root-validation.mjs" "$tmp/scripts/lib/"
  cp "$PREFLIGHT_SRC" "$tmp/hooks/"
  cp "$REPO/plugins/claude-code/hooks/lib/command-classifier.sh" "$tmp/hooks/lib/"
  cp "$REPO/plugins/claude-code/hooks/lib/repo-root.sh" "$tmp/hooks/lib/"
  cp "$REPO/plugins/claude-code/hooks/lib/marker-paths.sh" "$tmp/hooks/lib/"
  cp "$REPO/bundles/codex-review-channel-current.md" "$tmp/bundles/"
}

STUB_HOME="$(mk_stub_home)"
EMPTY_HOME="$(mktemp -d "${TMPDIR:-/tmp}/layerbridge-empty-XXXXXX")"  # no stub → consult ENOENT
PF="$(mktemp -d "${TMPDIR:-/tmp}/layerbridge-pf-XXXXXX")"
stage_fixture "$PF"
PF_GATE="$PF/hooks/preflight-gate.sh"
PF_INPUT='{"tool_name":"Bash","cwd":"'"$PF"'","session_id":"'"$SID"'","tool_input":{"command":"codex exec foo"}}'

echo "=== preflight-gate.sh — layer kill switch (codex-review-handoff, no marker) ==="

# 1. active (empty token) → DENY (base behavior; non-vacuous control).
out="$(STUB_TOKEN='' STUB_EXIT=0 HOME="$STUB_HOME" bash "$PF_GATE" <<<"$PF_INPUT" 2>/dev/null)"
if [ "$(decision_of "$out")" = "deny" ]; then ok "active → codex-review-handoff DENIED (base behavior)"; else bad "active → deny" "got [$out]"; fi

# 2. inactive → ALLOW (kill switch silences bp-010 enforcement).
out="$(STUB_TOKEN=inactive STUB_EXIT=0 HOME="$STUB_HOME" bash "$PF_GATE" <<<"$PF_INPUT" 2>/dev/null)"
if [ -z "$out" ]; then ok "inactive → codex-review-handoff ALLOWED (silenced)"; else bad "inactive → allow" "got [$out]"; fi

# 3. F1 — consult ENOENT (stub absent) under set -e → still DENY (degraded install
#    cannot disable the gate; the set +e capture must not abort into exit 1).
out="$(STUB_TOKEN=inactive STUB_EXIT=0 HOME="$EMPTY_HOME" bash "$PF_GATE" <<<"$PF_INPUT" 2>/dev/null)"
if [ "$(decision_of "$out")" = "deny" ]; then ok "F1: consult ENOENT → DENY (fail-closed under set -e)"; else bad "F1 ENOENT → deny" "got [$out]"; fi

# 4. inactive + stub EXITS NON-ZERO but prints "inactive" → still DENY? No: the
#    consult discards stderr only; a non-zero exit with stdout "inactive" is the
#    real CLI's allow shape too (it exit(0)s). The genuine fail-closed lever is a
#    NON-inactive stdout. Assert a stub printing a DIFFERENT token → DENY.
out="$(STUB_TOKEN='please-inactivate' STUB_EXIT=0 HOME="$STUB_HOME" bash "$PF_GATE" <<<"$PF_INPUT" 2>/dev/null)"
if [ "$(decision_of "$out")" = "deny" ]; then ok "non-'inactive' token → DENY (exact-match, not substring)"; else bad "substring token → deny" "got [$out]"; fi

# 5. G4 — direct Write to the preflight marker is DENIED even when inactive
#    (R4 marker_write NON-overridable; the consult sits AFTER this guard).
G4_INPUT='{"tool_name":"Write","cwd":"'"$PF"'","session_id":"'"$SID"'","tool_input":{"file_path":"'"$PF"'/.checkpoints/.preflight-done","content":"x"}}'
out="$(STUB_TOKEN=inactive STUB_EXIT=0 HOME="$STUB_HOME" bash "$PF_GATE" <<<"$G4_INPUT" 2>/dev/null)"
reason="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""' 2>/dev/null)"
if [ "$(decision_of "$out")" = "deny" ] && printf '%s' "$reason" | grep -qE 'forbidden|helper'; then
  ok "G4: direct marker Write DENIED even when inactive (R4 non-overridable, survives switch)"
else
  bad "G4 marker-write survives" "got [$out]"
fi

echo ""
echo "=== second-opinion-gate.mjs — layer kill switch (direct provider Bash) ==="
SO_REPO="$(mktemp -d "${TMPDIR:-/tmp}/layerbridge-so-XXXXXX")"
git -C "$SO_REPO" init -q
SO_INPUT='{"tool_name":"Bash","cwd":"'"$SO_REPO"'","session_id":"'"$SID"'","tool_input":{"command":"codex exec foo"}}'

# 6. active (empty token) → block (no install snapshot under STUB_HOME → snapshot error).
out="$(STUB_TOKEN='' STUB_EXIT=0 HOME="$STUB_HOME" node "$SECOND_OPINION" <<<"$SO_INPUT" 2>/dev/null)"
if printf '%s' "$out" | grep -qE '"decision": ?"block"'; then ok "active → second-opinion BLOCK (base behavior)"; else bad "active → block" "got [$out]"; fi

# 7. inactive → ALLOW (whole gate off; consult precedes runbook/snapshot work).
out="$(STUB_TOKEN=inactive STUB_EXIT=0 HOME="$STUB_HOME" node "$SECOND_OPINION" <<<"$SO_INPUT" 2>/dev/null)"
if [ -z "$out" ]; then ok "inactive → second-opinion ALLOWED (gate off)"; else bad "inactive → allow" "got [$out]"; fi

# 8. G1 — consult ENOENT (stub absent) → fall through → BLOCK (spawn failure is
#    fail-closed, NOT allow).
out="$(STUB_TOKEN=inactive STUB_EXIT=0 HOME="$EMPTY_HOME" node "$SECOND_OPINION" <<<"$SO_INPUT" 2>/dev/null)"
if printf '%s' "$out" | grep -qE '"decision": ?"block"'; then ok "G1: consult ENOENT → BLOCK (spawn failure fail-closed)"; else bad "G1 ENOENT → block" "got [$out]"; fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "PASS — $pass checks"
  exit 0
else
  echo "FAIL — $fail of $((pass+fail)) checks"
  exit 1
fi
