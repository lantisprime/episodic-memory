#!/usr/bin/env bash
#
# tests/test-preflight-prompt-helper.sh — UserPromptSubmit hook test suite.
#
# Plan-v2 §I1, I3, I5, I6 coverage:
#   I1  Hook writes .last-user-prompt.<sid>.json atomically with canonical sha
#   I2  Hook writes .preflight-done.<sid> for the same prompt/session
#   I3  Fail-safe: any internal error → exit 0 + stderr log; never block
#   I5  Idempotent for same prompt+session: byte-identical file content
#   I6  External-contract documentation — UserPromptSubmit ordering verified
#       indirectly via "hook runs to completion before any tool call" semantic
#
# Audit findings landed by C3: F3 (canon import), F4 (--session-id), F5
# (no hooks/lib coupling beyond repo-root.sh), F6 (ordering documented).

set -u

REPO_ROOT="$(cd -P "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/plugins/claude-code/hooks/preflight-prompt-helper.sh"

passed=0
failed=0

mktmp() {
  # macOS mktemp -d returns /var/folders/...; realpath via cd -P to dereference.
  local d
  d="$(mktemp -d)"
  ( cd -P "$d" && pwd )
}

write_review_components() {
  local target="$1"
  mkdir -p "$target"
  for f in \
    reference_codex_review_flow.md \
    feedback_codex_cli_episode_messaging.md \
    feedback_subagent_cli_episode_messaging.md \
    feedback_canonical_agent_dispatch_trigger.md \
    feedback_codex_review_request_preamble.md \
    feedback_second_opinion_harness_runbook.md \
    reference_second_opinion_harness.md
  do
    printf 'stub content for %s\n' "$f" > "$target/$f"
  done
}

stage_repo() {
  # Stage a minimal repo fixture so resolve_repo_root finds a root and the
  # in-repo scripts/lib path resolves.
  local target="$1"
  mkdir -p "$target/.checkpoints"
  mkdir -p "$target/bundles"
  mkdir -p "$target/scripts/lib"
  mkdir -p "$target/hooks/lib"
  mkdir -p "$target/.episodic-memory/memory"
  cp "$REPO_ROOT/scripts/preflight-marker-write.mjs" "$target/scripts/"
  cp "$REPO_ROOT/scripts/lib/preflight-prompt-canon.mjs" "$target/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/canonicalize-path-tolerant.mjs" "$target/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/marker-paths.mjs" "$target/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/session-id.mjs" "$target/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/marker-root-validation.mjs" "$target/scripts/lib/"
  cp "$REPO_ROOT/plugins/claude-code/hooks/preflight-gate.sh" "$target/hooks/"
  cp "$REPO_ROOT/plugins/claude-code/hooks/lib/command-classifier.sh" "$target/hooks/lib/"
  cp "$REPO_ROOT/plugins/claude-code/hooks/lib/marker-paths.sh" "$target/hooks/lib/"
  cp "$REPO_ROOT/plugins/claude-code/hooks/lib/repo-root.sh" "$target/hooks/lib/"
  cp "$REPO_ROOT/bundles/codex-review-channel-current.md" "$target/bundles/"
  # Stage the 7 review-channel components at the local memory_root +
  # a config.json that points the hook there. Stub content per file —
  # the gate validates loaded sha against disk, not against bundle-recorded.
  write_review_components "$target/.episodic-memory/memory"
  jq -nc --arg p "$target/.episodic-memory/memory" '{claude_memory_root: $p}' > "$target/.episodic-memory/config.json"
  # Make it git-detectable so resolve_repo_root returns this dir, not /.
  ( cd "$target" && git init -q && git config user.email t@t && git config user.name t )
}

run_hook() {
  # run_hook <repo_dir> <prompt> <session_id> → echoes stderr, returns exit code
  local repo="$1" prompt="$2" sid="$3" tp="${4:-/tmp/transcript.jsonl}"
  local input
  input="$(jq -nc --arg p "$prompt" --arg s "$sid" --arg c "$repo" --arg tp "$tp" \
    '{prompt: $p, session_id: $s, cwd: $c, transcript_path: $tp, hook_event_name: "UserPromptSubmit"}')"
  # The hook resolves repo from cwd via git -C; we cd into the repo so the
  # resolution matches the cwd field exactly.
  ( cd "$repo" && printf '%s' "$input" | bash "$HOOK" )
}

run_gate() {
  local repo="$1" sid="$2" cmd="${3:-codex exec foo}"
  local payload
  payload="$(jq -nc --arg c "$repo" --arg s "$sid" --arg cmd "$cmd" \
    '{tool_name:"Bash", tool_input:{command:$cmd}, cwd:$c, session_id:$s, transcript_path:"/tmp/transcript.jsonl"}')"
  ( cd "$repo" && printf '%s' "$payload" | bash "$repo/hooks/preflight-gate.sh" )
}

# ---------- I1: hook writes namespaced file with correct sha ----------

echo "--- I1: hook writes namespaced last-user-prompt file ---"

TF="$(mktmp)"; stage_repo "$TF"
SID="i1-test-session"
PROMPT="hello world"
run_hook "$TF" "$PROMPT" "$SID" 2>/dev/null
EC=$?

if [ $EC -ne 0 ]; then
  echo "  ✗ I1 hook exit $EC (expected 0)"
  failed=$((failed+1))
elif [ ! -f "$TF/.checkpoints/.last-user-prompt.${SID}.json" ]; then
  echo "  ✗ I1 file not written"
  failed=$((failed+1))
else
  echo "  ✓ I1 hook wrote namespaced file"
  passed=$((passed+1))
fi

# Verify sha matches the well-known sha256("hello world")
EXPECTED_SHA="b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
ACTUAL_SHA="$(jq -r '.prompt_sha256' "$TF/.checkpoints/.last-user-prompt.${SID}.json")"
if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
  echo "  ✓ I1 sha matches canonical sha256(prompt)"
  passed=$((passed+1))
else
  echo "  ✗ I1 sha mismatch: got $ACTUAL_SHA, expected $EXPECTED_SHA"
  failed=$((failed+1))
fi

# Schema fields present
if jq -e '.session_id and .transcript_path and .cwd and .repo_root and .wrote_at_ms' \
    "$TF/.checkpoints/.last-user-prompt.${SID}.json" >/dev/null; then
  echo "  ✓ I1 file has all required fields"
  passed=$((passed+1))
else
  echo "  ✗ I1 file missing required fields"
  failed=$((failed+1))
fi

rm -rf "$TF"

# ---------- I2: hook writes prompt-bound preflight marker ----------

echo "--- I2: hook writes namespaced preflight marker ---"

TF="$(mktmp)"; stage_repo "$TF"
SID="i2-test-session"
PROMPT="review handoff prompt"
run_hook "$TF" "$PROMPT" "$SID" 2>/dev/null
EC=$?

if [ $EC -ne 0 ]; then
  echo "  ✗ I2 hook exit $EC (expected 0)"
  failed=$((failed+1))
elif [ ! -f "$TF/.checkpoints/.preflight-done.${SID}" ]; then
  echo "  ✗ I2 preflight marker not written"
  failed=$((failed+1))
else
  echo "  ✓ I2 hook wrote namespaced preflight marker"
  passed=$((passed+1))
fi

LAST_SHA="$(jq -r '.prompt_sha256' "$TF/.checkpoints/.last-user-prompt.${SID}.json")"
PREFLIGHT_SHA="$(jq -r '.prompt_sha256' "$TF/.checkpoints/.preflight-done.${SID}")"
PREFLIGHT_CLAIM="$(jq -r '.claim_class' "$TF/.checkpoints/.preflight-done.${SID}")"
if [ "$LAST_SHA" = "$PREFLIGHT_SHA" ] && [ "$PREFLIGHT_CLAIM" = "codex-review-handoff" ]; then
  echo "  ✓ I2 preflight marker is bound to same prompt and claim class"
  passed=$((passed+1))
else
  echo "  ✗ I2 marker mismatch: last_sha=$LAST_SHA preflight_sha=$PREFLIGHT_SHA claim=$PREFLIGHT_CLAIM"
  failed=$((failed+1))
fi

if jq -e --arg b "$TF/bundles/codex-review-channel-current.md" \
    '(.required_files // []) | index($b) != null' \
    "$TF/.checkpoints/.preflight-done.${SID}" >/dev/null; then
  echo "  ✓ I2 preflight marker lists canonical bundle"
  passed=$((passed+1))
else
  echo "  ✗ I2 preflight marker missing canonical bundle"
  failed=$((failed+1))
fi

# I2-A (codex round-1 finding #1): marker must list all 7 components + the
# bundle in required_files, and loaded_files must have a matching entry per
# required_files entry with sha256 that matches disk.
REQ_COUNT="$(jq -r '.required_files // [] | length' "$TF/.checkpoints/.preflight-done.${SID}")"
LOADED_COUNT="$(jq -r '.loaded_files // [] | length' "$TF/.checkpoints/.preflight-done.${SID}")"
if [ "$REQ_COUNT" = "8" ] && [ "$LOADED_COUNT" = "8" ]; then
  echo "  ✓ I2 marker has 8 required_files + 8 loaded_files (bundle + 7 components)"
  passed=$((passed+1))
else
  echo "  ✗ I2 marker has req=$REQ_COUNT loaded=$LOADED_COUNT (expected 8/8)"
  failed=$((failed+1))
fi

# Cross-check: every loaded_files[i].sha256 matches disk shasum at .path
SHA_DRIFT="$(jq -r '.loaded_files // [] | map([.path, .sha256] | @tsv) | .[]' "$TF/.checkpoints/.preflight-done.${SID}" | while IFS=$'\t' read -r p s; do
  actual="$(shasum -a 256 "$p" 2>/dev/null | awk '{print $1}')"
  if [ "$actual" != "$s" ]; then printf '%s ' "$p"; fi
done)"
if [ -z "$SHA_DRIFT" ]; then
  echo "  ✓ I2 every loaded_files[i].sha256 matches disk"
  passed=$((passed+1))
else
  echo "  ✗ I2 sha drift on: $SHA_DRIFT"
  failed=$((failed+1))
fi

GATE_OUT="$(run_gate "$TF" "$SID" 2>&1 || true)"
if [ -z "$GATE_OUT" ]; then
  echo "  ✓ I2 hook-owned marker lets preflight-gate allow codex handoff"
  passed=$((passed+1))
else
  echo "  ✗ I2 gate denied after hook-owned marker: $GATE_OUT"
  failed=$((failed+1))
fi

# I2-B (codex round-1 finding #2): gate must ACCEPT the actual harness
# command shape `node scripts/second-opinion.mjs request --provider codex
# --dispatch ...` once the hook-owned marker is in place.
HARNESS_CMD="node $TF/scripts/second-opinion.mjs request --provider codex --dispatch --summary 'test' --body 'test'"
GATE_OUT="$(run_gate "$TF" "$SID" "$HARNESS_CMD" 2>&1 || true)"
if [ -z "$GATE_OUT" ]; then
  echo "  ✓ I2 gate accepts actual second-opinion.mjs --provider codex --dispatch shape"
  passed=$((passed+1))
else
  echo "  ✗ I2 gate denied harness command: $GATE_OUT"
  failed=$((failed+1))
fi

rm -rf "$TF"

# ---------- I2c: memory_root fallback handles observed Claude path variant ----------

echo "--- I2c: memory_root fallback chooses non-empty bounded variant ---"

BASE="$(mktmp)"
TF="$BASE/Users/charltondho/Developer/projects/episodic-memory"
mkdir -p "$TF"
stage_repo "$TF"
rm -rf "$TF/.episodic-memory"

HOME_FIXTURE="$BASE/home"
SANITIZED="$(printf '%s' "$TF" | sed 's|/|-|g; s|\.|-|g')"
VARIANT_SANITIZED="$(printf '%s' "$SANITIZED" | sed 's|charltondho|charltond-ho|')"
CANONICAL_MEM="$HOME_FIXTURE/.claude/projects/$SANITIZED/memory"
VARIANT_MEM="$HOME_FIXTURE/.claude/projects/$VARIANT_SANITIZED/memory"
mkdir -p "$CANONICAL_MEM/session_summaries"
write_review_components "$VARIANT_MEM"

SID="i2c-test-session"
PROMPT="review handoff prompt from variant memory root"
INPUT="$(jq -nc --arg p "$PROMPT" --arg s "$SID" --arg c "$TF" \
  '{prompt: $p, session_id: $s, cwd: $c, transcript_path: "/tmp/transcript.jsonl", hook_event_name: "UserPromptSubmit"}')"
( cd "$TF" && printf '%s' "$INPUT" | HOME="$HOME_FIXTURE" bash "$HOOK" ) 2>/dev/null
EC=$?

if [ $EC -ne 0 ]; then
  echo "  ✗ I2c hook exit $EC (expected 0)"
  failed=$((failed+1))
elif [ ! -f "$TF/.checkpoints/.preflight-done.${SID}" ]; then
  echo "  ✗ I2c preflight marker not written via variant memory root"
  failed=$((failed+1))
else
  echo "  ✓ I2c hook wrote preflight marker via variant memory root"
  passed=$((passed+1))
fi

MARKER_MEM="$(jq -r '.memory_root // ""' "$TF/.checkpoints/.preflight-done.${SID}" 2>/dev/null || true)"
if [ "$MARKER_MEM" = "$VARIANT_MEM" ]; then
  echo "  ✓ I2c marker records the non-empty variant memory root"
  passed=$((passed+1))
else
  echo "  ✗ I2c memory_root=$MARKER_MEM (expected $VARIANT_MEM)"
  failed=$((failed+1))
fi

GATE_OUT="$(HOME="$HOME_FIXTURE" run_gate "$TF" "$SID" 2>&1 || true)"
if [ -z "$GATE_OUT" ]; then
  echo "  ✓ I2c gate accepts marker built from variant memory root"
  passed=$((passed+1))
else
  echo "  ✗ I2c gate denied variant-root marker: $GATE_OUT"
  failed=$((failed+1))
fi

rm -rf "$BASE"

# ---------- I2b (PR #291 A1): bundle missing → roll back last-prompt ----------

echo "--- I2b: bundle missing → roll back last-prompt marker for clean re-attempt ---"

TF="$(mktmp)"; stage_repo "$TF"
rm -f "$TF/bundles/codex-review-channel-current.md"
SID="i2b-test-session"
run_hook "$TF" "review handoff prompt" "$SID" 2>/dev/null
EC=$?

if [ $EC -eq 0 ]; then
  echo "  ✓ I2b hook fail-safe (exit 0) when bundle missing"
  passed=$((passed+1))
else
  echo "  ✗ I2b hook exit $EC (expected 0)"
  failed=$((failed+1))
fi

if [ ! -f "$TF/.checkpoints/.last-user-prompt.${SID}.json" ] && [ ! -f "$TF/.checkpoints/.preflight-done.${SID}" ]; then
  echo "  ✓ I2b both markers absent → next-prompt cycle starts clean"
  passed=$((passed+1))
else
  echo "  ✗ I2b stale markers leaked: last=$(test -f "$TF/.checkpoints/.last-user-prompt.${SID}.json" && echo Y || echo N) preflight=$(test -f "$TF/.checkpoints/.preflight-done.${SID}" && echo Y || echo N)"
  failed=$((failed+1))
fi

rm -rf "$TF"

# ---------- I3: fail-safe on malformed inputs ----------

echo "--- I3: fail-safe — never block on internal errors ---"

# Empty stdin
TF="$(mktmp)"; stage_repo "$TF"
( cd "$TF" && printf '' | bash "$HOOK" )
EC=$?
if [ $EC -eq 0 ]; then
  echo "  ✓ I3a empty stdin → exit 0"
  passed=$((passed+1))
else
  echo "  ✗ I3a empty stdin → exit $EC (expected 0)"
  failed=$((failed+1))
fi
rm -rf "$TF"

# Non-JSON stdin
TF="$(mktmp)"; stage_repo "$TF"
( cd "$TF" && printf 'not json' | bash "$HOOK" )
EC=$?
if [ $EC -eq 0 ]; then
  echo "  ✓ I3b non-JSON stdin → exit 0"
  passed=$((passed+1))
else
  echo "  ✗ I3b non-JSON → exit $EC (expected 0)"
  failed=$((failed+1))
fi
rm -rf "$TF"

# JSON but not an object
TF="$(mktmp)"; stage_repo "$TF"
( cd "$TF" && printf '[1,2,3]' | bash "$HOOK" )
EC=$?
if [ $EC -eq 0 ]; then
  echo "  ✓ I3c JSON non-object → exit 0"
  passed=$((passed+1))
else
  echo "  ✗ I3c non-object → exit $EC (expected 0)"
  failed=$((failed+1))
fi
rm -rf "$TF"

# Missing session_id
TF="$(mktmp)"; stage_repo "$TF"
( cd "$TF" && printf '{"prompt":"x","cwd":"%s"}' "$TF" | bash "$HOOK" )
EC=$?
if [ $EC -eq 0 ]; then
  echo "  ✓ I3d missing session_id → exit 0"
  passed=$((passed+1))
else
  echo "  ✗ I3d missing session_id → exit $EC"
  failed=$((failed+1))
fi
rm -rf "$TF"

# Invalid session_id (path traversal)
TF="$(mktmp)"; stage_repo "$TF"
( cd "$TF" && jq -nc --arg c "$TF" '{prompt:"x", session_id:"../etc/passwd", cwd:$c}' | bash "$HOOK" )
EC=$?
if [ $EC -eq 0 ] && [ ! -f "$TF/.checkpoints/.last-user-prompt.../etc/passwd.json" ]; then
  echo "  ✓ I3e invalid session_id → exit 0 + no file written"
  passed=$((passed+1))
else
  echo "  ✗ I3e invalid session_id → exit $EC"
  failed=$((failed+1))
fi
rm -rf "$TF"

# ---------- I5: idempotent on identical input ----------

echo "--- I5: load-bearing fields stable across calls ---"

# Note: wrote_at_ms WILL differ across calls (timestamp), so the file is NOT
# byte-identical across calls. The load-bearing fields are prompt_sha256 +
# session_id + cwd + repo_root — those MUST be identical. M-5 tightening:
# explicitly compare each load-bearing field's before/after value, not just
# the final value against a canon recompute.
TF="$(mktmp)"; stage_repo "$TF"
SID="i5-test"
run_hook "$TF" "stable prompt text" "$SID" 2>/dev/null
SHA_BEFORE="$(jq -r '.prompt_sha256' "$TF/.checkpoints/.last-user-prompt.${SID}.json")"
SID_BEFORE="$(jq -r '.session_id'    "$TF/.checkpoints/.last-user-prompt.${SID}.json")"
CWD_BEFORE="$(jq -r '.cwd'           "$TF/.checkpoints/.last-user-prompt.${SID}.json")"
sleep 0.05  # mtime would tick if anything fluctuated
run_hook "$TF" "stable prompt text" "$SID" 2>/dev/null
SHA_AFTER="$(jq -r '.prompt_sha256'  "$TF/.checkpoints/.last-user-prompt.${SID}.json")"
SID_AFTER="$(jq -r '.session_id'     "$TF/.checkpoints/.last-user-prompt.${SID}.json")"
CWD_AFTER="$(jq -r '.cwd'            "$TF/.checkpoints/.last-user-prompt.${SID}.json")"

if [ "$SHA_BEFORE" = "$SHA_AFTER" ] && [ "$SID_BEFORE" = "$SID_AFTER" ] && [ "$CWD_BEFORE" = "$CWD_AFTER" ]; then
  echo "  ✓ I5 load-bearing fields (sha/session_id/cwd) stable across two calls"
  passed=$((passed+1))
else
  echo "  ✗ I5 field drift: sha=$SHA_BEFORE→$SHA_AFTER sid=$SID_BEFORE→$SID_AFTER cwd=$CWD_BEFORE→$CWD_AFTER"
  failed=$((failed+1))
fi

# Cross-check: the second-call sha matches what the canon lib computes
# directly. (Was the I5 test pre-tightening; keep it as a separate cross-check.)
EXP="$(node -e "import('$REPO_ROOT/scripts/lib/preflight-prompt-canon.mjs').then(m => process.stdout.write(m.canonicalPromptSha256FromString('stable prompt text')))")"
if [ "$SHA_AFTER" = "$EXP" ]; then
  echo "  ✓ I5 prompt_sha256 matches canon-lib direct computation"
  passed=$((passed+1))
else
  echo "  ✗ I5 sha drift vs canon: got $SHA_AFTER, expected $EXP"
  failed=$((failed+1))
fi

rm -rf "$TF"

# ---------- I6: cross-session distinct files (composes with C2 namespacing) ----------

echo "--- I6: two sessions in same repo write distinct files ---"

TF="$(mktmp)"; stage_repo "$TF"
run_hook "$TF" "promptA" "session-A" 2>/dev/null
run_hook "$TF" "promptB" "session-B" 2>/dev/null
if [ -f "$TF/.checkpoints/.last-user-prompt.session-A.json" ] && \
   [ -f "$TF/.checkpoints/.last-user-prompt.session-B.json" ] && \
   [ "$(jq -r '.prompt_sha256' "$TF/.checkpoints/.last-user-prompt.session-A.json")" != \
     "$(jq -r '.prompt_sha256' "$TF/.checkpoints/.last-user-prompt.session-B.json")" ]; then
  echo "  ✓ I6 two sessions wrote distinct namespaced files with distinct shas"
  passed=$((passed+1))
else
  echo "  ✗ I6 cross-session isolation broken"
  failed=$((failed+1))
fi
rm -rf "$TF"

# ---------- Multi-byte + emoji prompt round-trip ----------

echo "--- canon round-trip via hook ---"

TF="$(mktmp)"; stage_repo "$TF"
run_hook "$TF" "héllo 你好 🚀" "rt-test" 2>/dev/null
SHA_VIA_HOOK="$(jq -r '.prompt_sha256' "$TF/.checkpoints/.last-user-prompt.rt-test.json")"
SHA_VIA_CANON="$(node -e "import('$REPO_ROOT/scripts/lib/preflight-prompt-canon.mjs').then(m => process.stdout.write(m.canonicalPromptSha256FromString('héllo 你好 🚀')))")"
if [ "$SHA_VIA_HOOK" = "$SHA_VIA_CANON" ]; then
  echo "  ✓ multi-byte + emoji prompt hashes match canon lib direct"
  passed=$((passed+1))
else
  echo "  ✗ multi-byte sha mismatch: hook=$SHA_VIA_HOOK canon=$SHA_VIA_CANON"
  failed=$((failed+1))
fi
rm -rf "$TF"

# ---------- Results ----------

echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="
if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
