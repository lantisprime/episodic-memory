#!/usr/bin/env bash
#
# tests/test-preflight-gate.sh — Layer D pre-flight gate test suite.
#
# Codex consensus chain: r1 ACCEPT-with-FU `...ed24` → r5 ACCEPT `...dbf6`.
# All 9 locally-verifiable invariants per discipline #18:
#
#   I1  Helper produces atomic marker writes              (F4a-c)
#   I2  No partial-write observation                      (F4f-g)
#   I3  Direct Write/Edit/MultiEdit to marker denied      (F2a-n + F4d-e)
#   I4  Marker artifacts land under --root, not caller    (F3b-c, F5)
#   I5  Sibling-gate behavior unchanged                   (separate file)
#   I6  Bundle component drift triggers reject            (M-series)
#   I7  Stale prompt rejection                            (M-series)
#   I8  Helper requires explicit --root                   (F3a, F3f-g)
#   I9  Helper imports resolve from staged tmp project    (F1)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO_ROOT/hooks/preflight-gate.sh"
HELPER="$REPO_ROOT/scripts/preflight-marker-write.mjs"
GATE_INPUT_TMPL='{"tool_name":"%s","tool_input":%s,"cwd":"%s","session_id":"%s","transcript_path":"/tmp/x"}'

passed=0
failed=0
SESSION_ID="test-session-$$"

# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------

# stage_fixture <tmp-root>
# Creates a minimal tmp project that can host the gate + helper.
# Stages: scripts/{preflight-marker-write.mjs,lib/{canonicalize-path-tolerant,local-dir,marker-paths}.mjs}
# Stages: hooks/{preflight-gate.sh,lib/{command-classifier,repo-root,marker-paths}.sh}
# Creates: .git (so resolveRepoRoot works), .checkpoints/, bundles/ (empty or seeded).
stage_fixture() {
  local tmp="$1"
  mkdir -p "$tmp/scripts/lib" "$tmp/hooks/lib" "$tmp/.checkpoints" "$tmp/bundles"
  # Real git init so resolve_repo_root walks up correctly from nested cwds.
  # A fake `.git` dir doesn't satisfy `git rev-parse --git-common-dir`.
  (cd "$tmp" && git init -q 2>/dev/null) || true
  cp "$REPO_ROOT/scripts/preflight-marker-write.mjs" "$tmp/scripts/"
  cp "$REPO_ROOT/scripts/lib/canonicalize-path-tolerant.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/local-dir.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/marker-paths.mjs" "$tmp/scripts/lib/"
  cp "$REPO_ROOT/hooks/preflight-gate.sh" "$tmp/hooks/"
  cp "$REPO_ROOT/hooks/lib/command-classifier.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/hooks/lib/repo-root.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/hooks/lib/marker-paths.sh" "$tmp/hooks/lib/"
  cp "$REPO_ROOT/bundles/codex-review-channel-current.md" "$tmp/bundles/"
}

# run_gate <tmp-root> <tool-name> <tool-input-json> <expect-class: allow|deny> [reason-grep]
run_gate() {
  local tmp="$1" tool="$2" input="$3" expect="$4" reason_grep="${5:-}"
  local desc="$6"
  local payload
  payload="$(printf "$GATE_INPUT_TMPL" "$tool" "$input" "$tmp" "$SESSION_ID")"
  local out
  out="$(printf '%s' "$payload" | bash "$tmp/hooks/preflight-gate.sh" 2>&1 || true)"

  if [ "$expect" = "allow" ]; then
    if [ -z "$out" ]; then
      echo "  ✓ $desc"
      passed=$((passed+1))
    else
      echo "  ✗ $desc — expected allow (no output) but got: $out"
      failed=$((failed+1))
    fi
  elif [ "$expect" = "deny" ]; then
    local decision
    decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || echo "")"
    if [ "$decision" = "deny" ]; then
      if [ -n "$reason_grep" ]; then
        local reason
        reason="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""')"
        if printf '%s' "$reason" | grep -qE "$reason_grep"; then
          echo "  ✓ $desc"
          passed=$((passed+1))
        else
          echo "  ✗ $desc — denied but reason missing /$reason_grep/: $reason"
          failed=$((failed+1))
        fi
      else
        echo "  ✓ $desc"
        passed=$((passed+1))
      fi
    else
      echo "  ✗ $desc — expected deny but got: $out"
      failed=$((failed+1))
    fi
  fi
}

cleanup_dirs=()
on_exit() {
  for d in "${cleanup_dirs[@]}"; do
    rm -rf "$d" 2>/dev/null || true
  done
}
trap on_exit EXIT

mktmp() {
  local d
  d="$(mktemp -d)"
  d="$(cd "$d" && pwd -P)"  # macOS /var → /private/var
  cleanup_dirs+=("$d")
  echo "$d"
}

# ---------------------------------------------------------------------------
# A-series: allow cases (read-only tools / ungated commands)
# ---------------------------------------------------------------------------
echo ""
echo "--- A-series: allow cases ---"
TMP="$(mktmp)"; stage_fixture "$TMP"

run_gate "$TMP" "Bash" '{"command":"ls -la"}' "allow" "" "A01 Bash ls"
run_gate "$TMP" "Bash" '{"command":"git status"}' "allow" "" "A02 Bash git status"
run_gate "$TMP" "Read" '{"file_path":"/anything"}' "allow" "" "A03 Read tool"
run_gate "$TMP" "Grep" '{"pattern":"foo"}' "allow" "" "A04 Grep tool"
run_gate "$TMP" "Glob" '{"pattern":"*.mjs"}' "allow" "" "A05 Glob tool"
run_gate "$TMP" "Bash" '{"command":"echo \"codex exec foo\""}' "allow" "" "A06 echo with codex string (no FP)"
run_gate "$TMP" "Bash" '{"command":"node scripts/em-store.mjs --tag random --body x"}' "allow" "" "A07 em-store no review tag"
run_gate "$TMP" "Agent" '{"subagent_type":"general-purpose","description":"x","prompt":"y"}' "allow" "" "A08 Agent generic"

# ---------------------------------------------------------------------------
# M-series: marker-required (codex-review-handoff without marker → DENY)
# ---------------------------------------------------------------------------
echo ""
echo "--- M-series: marker-required ---"

run_gate "$TMP" "Bash" '{"command":"codex exec foo"}' "deny" "Pre-flight marker required" "M01 codex exec no marker"
run_gate "$TMP" "Bash" '{"command":"codex review --plan"}' "deny" "Pre-flight marker required" "M02 codex review no marker"
run_gate "$TMP" "Bash" '{"command":"sudo codex exec foo"}' "deny" "Pre-flight marker required" "M03 sudo codex no marker"
run_gate "$TMP" "Bash" '{"command":"env A=1 timeout 30s codex exec foo"}' "deny" "Pre-flight marker required" "M04 env+timeout codex no marker"
run_gate "$TMP" "Bash" '{"command":"bash -c \"codex exec foo\""}' "deny" "Pre-flight marker required" "M05 bash -c codex no marker"
run_gate "$TMP" "Bash" '{"command":"node scripts/em-store.mjs --tag codex-review --body x"}' "deny" "Pre-flight marker required" "M06 em-store codex-review tag no marker"
run_gate "$TMP" "Bash" '{"command":"node scripts/second-opinion.mjs request --provider codex --dispatch"}' "deny" "Pre-flight marker required" "M07 harness no marker"
run_gate "$TMP" "Agent" '{"subagent_type":"codex:codex-rescue","description":"x","prompt":"y"}' "deny" "Pre-flight marker required" "M08 Agent codex no marker"
run_gate "$TMP" "Agent" '{"subagent_type":"negative-scenario-reviewer","description":"x","prompt":"y"}' "deny" "Pre-flight marker required" "M09 Agent neg-scenario no marker"

# ---------------------------------------------------------------------------
# Marker validation — write a valid marker, then mutate fields
# ---------------------------------------------------------------------------
echo ""
echo "--- M-series: marker field validation ---"

# Helper: write a valid marker for $TMP given current fixture's bundle.
write_valid_marker() {
  local tmp="$1"
  local bundle="$tmp/bundles/codex-review-channel-current.md"
  local bundle_sha
  bundle_sha="$(shasum -a 256 "$bundle" | awk '{print $1}')"
  local bundle_mtime
  bundle_mtime="$(node -e "process.stdout.write(String(require('fs').statSync(process.argv[1]).mtimeMs))" "$bundle")"
  cat > "$tmp/.checkpoints/.preflight-done" <<EOF
{
  "session_id": "$SESSION_ID",
  "transcript_path": "/tmp/x",
  "prompt_sha256": "abc123",
  "prompt_index": 1,
  "cwd": "$tmp",
  "repo_root": "$tmp",
  "memory_root": "$tmp/memory",
  "claim_class": "codex-review-handoff",
  "matched_triggers": {"tool_target": ["Bash:codex exec"]},
  "required_files": ["$bundle"],
  "loaded_files": [{"path": "$bundle", "mtime_ms": $bundle_mtime, "sha256": "$bundle_sha"}],
  "artifact_steps_done": ["memory-pre-pass"],
  "created_at_ms": 1747022400000
}
EOF
}

# DIRECT-WRITE PATH: marker-write enforcement fires BEFORE marker validation.
# So a Write to the marker path is denied even when a valid marker exists.
# To test marker-validation paths, use a Bash claim-class trigger instead.
write_valid_marker "$TMP"
run_gate "$TMP" "Bash" '{"command":"codex exec foo"}' "allow" "" "M10 valid marker → allow codex"

# Wrong claim_class
TMP2="$(mktmp)"; stage_fixture "$TMP2"
write_valid_marker "$TMP2"
sed -i.bak 's/"codex-review-handoff"/"plan-time-matrix"/' "$TMP2/.checkpoints/.preflight-done"
rm "$TMP2/.checkpoints/.preflight-done.bak"
run_gate "$TMP2" "Bash" '{"command":"codex exec foo"}' "deny" "claim_class is" "M11 wrong claim_class"

# Wrong session_id
TMP3="$(mktmp)"; stage_fixture "$TMP3"
write_valid_marker "$TMP3"
sed -i.bak "s/$SESSION_ID/different-session/" "$TMP3/.checkpoints/.preflight-done"
rm "$TMP3/.checkpoints/.preflight-done.bak"
run_gate "$TMP3" "Bash" '{"command":"codex exec foo"}' "deny" "session_id" "M12 wrong session_id"

# Wrong repo_root
TMP4="$(mktmp)"; stage_fixture "$TMP4"
write_valid_marker "$TMP4"
sed -i.bak "s|\"repo_root\": \"$TMP4\"|\"repo_root\": \"/totally/different\"|" "$TMP4/.checkpoints/.preflight-done"
rm "$TMP4/.checkpoints/.preflight-done.bak"
run_gate "$TMP4" "Bash" '{"command":"codex exec foo"}' "deny" "repo_root" "M13 wrong repo_root"

# Bundle hash drift (modify bundle after marker written)
TMP5="$(mktmp)"; stage_fixture "$TMP5"
write_valid_marker "$TMP5"
echo "DRIFT" >> "$TMP5/bundles/codex-review-channel-current.md"
run_gate "$TMP5" "Bash" '{"command":"codex exec foo"}' "deny" "hash drift|sha-drift" "M14 bundle hash drift"

# Empty marker
TMP6="$(mktmp)"; stage_fixture "$TMP6"
: > "$TMP6/.checkpoints/.preflight-done"
run_gate "$TMP6" "Bash" '{"command":"codex exec foo"}' "deny" "empty|valid JSON|required" "M15 empty marker"

# Invalid JSON
TMP7="$(mktmp)"; stage_fixture "$TMP7"
echo "{ malformed" > "$TMP7/.checkpoints/.preflight-done"
run_gate "$TMP7" "Bash" '{"command":"codex exec foo"}' "deny" "valid JSON" "M16 malformed JSON marker"

# Missing required_files
TMP8="$(mktmp)"; stage_fixture "$TMP8"
echo '{"session_id":"'"$SESSION_ID"'","transcript_path":"/tmp/x","prompt_sha256":"abc","prompt_index":1,"cwd":"'"$TMP8"'","repo_root":"'"$TMP8"'","memory_root":"x","claim_class":"codex-review-handoff","matched_triggers":{},"required_files":[],"loaded_files":[{"path":"x","mtime_ms":1,"sha256":"y"}],"artifact_steps_done":["x"],"created_at_ms":1}' > "$TMP8/.checkpoints/.preflight-done"
run_gate "$TMP8" "Bash" '{"command":"codex exec foo"}' "deny" "required_files is empty|does not list bundle" "M17 empty required_files"

# Required_files lacks bundle
TMP9="$(mktmp)"; stage_fixture "$TMP9"
echo '{"session_id":"'"$SESSION_ID"'","transcript_path":"/tmp/x","prompt_sha256":"abc","prompt_index":1,"cwd":"'"$TMP9"'","repo_root":"'"$TMP9"'","memory_root":"x","claim_class":"codex-review-handoff","matched_triggers":{},"required_files":["/some/other/file.md"],"loaded_files":[{"path":"/some/other/file.md","mtime_ms":1,"sha256":"y"}],"artifact_steps_done":["x"],"created_at_ms":1}' > "$TMP9/.checkpoints/.preflight-done"
run_gate "$TMP9" "Bash" '{"command":"codex exec foo"}' "deny" "does not list bundle" "M18 required_files missing bundle"

# ---------------------------------------------------------------------------
# F2-series: marker-write canonicalization
# ---------------------------------------------------------------------------
echo ""
echo "--- F2-series: direct marker-write enforcement ---"

# F2a: absolute path Write to .preflight-done → DENY
TF="$(mktmp)"; stage_fixture "$TF"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/.checkpoints/.preflight-done\",\"content\":\"x\"}" "deny" "forbidden|helper" "F2a abs path Write marker"

# F2b: repo-relative — gate input cwd = repo, path is repo-relative
TF="$(mktmp)"; stage_fixture "$TF"
payload="$(printf "$GATE_INPUT_TMPL" "Write" '{"file_path":".checkpoints/.preflight-done","content":"x"}' "$TF" "$SESSION_ID")"
out="$(printf '%s' "$payload" | bash "$TF/hooks/preflight-gate.sh" 2>&1 || true)"
decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || echo "")"
if [ "$decision" = "deny" ]; then echo "  ✓ F2b repo-relative Write marker"; passed=$((passed+1)); else echo "  ✗ F2b — got: $out"; failed=$((failed+1)); fi

# F2c: nested cwd, ../.checkpoints/.preflight-done
TF="$(mktmp)"; stage_fixture "$TF"
mkdir -p "$TF/scripts"
payload="$(printf "$GATE_INPUT_TMPL" "Write" '{"file_path":"../.checkpoints/.preflight-done","content":"x"}' "$TF/scripts" "$SESSION_ID")"
out="$(printf '%s' "$payload" | bash "$TF/hooks/preflight-gate.sh" 2>&1 || true)"
decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || echo "")"
if [ "$decision" = "deny" ]; then echo "  ✓ F2c nested-cwd Write marker"; passed=$((passed+1)); else echo "  ✗ F2c — got: $out"; failed=$((failed+1)); fi

# F2d: ./ form
TF="$(mktmp)"; stage_fixture "$TF"
payload="$(printf "$GATE_INPUT_TMPL" "Write" '{"file_path":"./.checkpoints/.preflight-done","content":"x"}' "$TF" "$SESSION_ID")"
out="$(printf '%s' "$payload" | bash "$TF/hooks/preflight-gate.sh" 2>&1 || true)"
decision="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // ""' 2>/dev/null || echo "")"
if [ "$decision" = "deny" ]; then echo "  ✓ F2d ./ form Write marker"; passed=$((passed+1)); else echo "  ✗ F2d — got: $out"; failed=$((failed+1)); fi

# F2e: symlink to marker
TF="$(mktmp)"; stage_fixture "$TF"
ln -s "$TF/.checkpoints/.preflight-done" "$TF/sym"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/sym\",\"content\":\"x\"}" "deny" "forbidden|helper" "F2e symlink Write marker"

# F2f: unrelated file matching basename → ALLOW
TF="$(mktmp)"; stage_fixture "$TF"
run_gate "$TF" "Write" '{"file_path":"/tmp/.preflight-done","content":"x"}' "allow" "" "F2f unrelated /tmp file"

# F2g: same basename in unrelated subdir → ALLOW
TF="$(mktmp)"; stage_fixture "$TF"
mkdir -p "$TF/scratch"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/scratch/.preflight-done\",\"content\":\"x\"}" "allow" "" "F2g same basename diff parent"

# F2h: dangling symlink to absent marker (the codex r4 bypass)
TF="$(mktmp)"; stage_fixture "$TF"
rm -f "$TF/.checkpoints/.preflight-done"
ln -s ".checkpoints/.preflight-done" "$TF/dangling"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/dangling\",\"content\":\"x\"}" "deny" "forbidden|helper" "F2h dangling symlink → DENY"

# F2i: multi-hop chain
TF="$(mktmp)"; stage_fixture "$TF"
ln -s "b" "$TF/a"
ln -s ".checkpoints/.preflight-done" "$TF/b"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/a\",\"content\":\"x\"}" "deny" "forbidden|helper" "F2i multi-hop symlink"

# F2j: symlink in middle of path
TF="$(mktmp)"; stage_fixture "$TF"
rm -rf "$TF/.checkpoints"; mkdir -p "$TF/.checkpoints"
ln -s ".checkpoints" "$TF/cp_alias"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/cp_alias/.preflight-done\",\"content\":\"x\"}" "deny" "forbidden|helper" "F2j middle-path symlink"

# F2k: symlink loop
TF="$(mktmp)"; stage_fixture "$TF"
ln -s "loop2" "$TF/loop1"
ln -s "loop1" "$TF/loop2"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/loop1\",\"content\":\"x\"}" "deny" "canonicalization failed|SYMLOOP" "F2k symlink loop conservative-deny"

# F2l: relative-target symlink in .checkpoints
TF="$(mktmp)"; stage_fixture "$TF"
mkdir -p "$TF/.checkpoints"
ln -s "./.preflight-done" "$TF/.checkpoints/dangle"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/.checkpoints/dangle\",\"content\":\"x\"}" "deny" "forbidden|helper" "F2l relative-target symlink"

# F2m: absolute-target symlink
TF="$(mktmp)"; stage_fixture "$TF"
ln -s "$TF/.checkpoints/.preflight-done" "$TF/abs_sym"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/abs_sym\",\"content\":\"x\"}" "deny" "forbidden|helper" "F2m absolute-target symlink"

# F2n: symlink to unrelated path → ALLOW
TF="$(mktmp)"; stage_fixture "$TF"
OTHER="$(mktmp)"
echo '' > "$OTHER/scratch.txt"
ln -s "$OTHER/scratch.txt" "$TF/scratch_sym"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/scratch_sym\",\"content\":\"x\"}" "allow" "" "F2n symlink to unrelated"

# Edit + MultiEdit equivalents
TF="$(mktmp)"; stage_fixture "$TF"
run_gate "$TF" "Edit" "{\"file_path\":\"$TF/.checkpoints/.preflight-done\",\"old_string\":\"a\",\"new_string\":\"b\"}" "deny" "forbidden|helper" "F4d Edit marker → DENY"
run_gate "$TF" "MultiEdit" "{\"file_path\":\"$TF/.checkpoints/.preflight-done\",\"edits\":[]}" "deny" "forbidden|helper" "F4e MultiEdit marker → DENY"

# Same for .last-user-prompt.json
TF="$(mktmp)"; stage_fixture "$TF"
run_gate "$TF" "Write" "{\"file_path\":\"$TF/.checkpoints/.last-user-prompt.json\",\"content\":\"x\"}" "deny" "forbidden|helper" "F4d2 Write last-prompt → DENY"

# ---------------------------------------------------------------------------
# F3-series: helper-invocation enforcement
# ---------------------------------------------------------------------------
echo ""
echo "--- F3-series: helper invocation enforcement ---"

TF="$(mktmp)"; stage_fixture "$TF"
# F3-gate: Bash invoking helper without --root → DENY at gate
run_gate "$TF" "Bash" "{\"command\":\"node $TF/scripts/preflight-marker-write.mjs --target preflight\"}" "deny" "ROOT_REQUIRED|--root" "F3-gate helper sans --root → DENY"
# F3-gate: Bash invoking helper WITH --root → not blocked by gate (helper itself runs)
run_gate "$TF" "Bash" "{\"command\":\"node $TF/scripts/preflight-marker-write.mjs --root $TF --target preflight\"}" "allow" "" "F3-gate helper with --root → allowed by gate"
# A1: bare/npx/script-shebang invocation also denied without --root
run_gate "$TF" "Bash" '{"command":"./scripts/preflight-marker-write.mjs --target preflight"}' "deny" "ROOT_REQUIRED|--root" "A1a bare script invocation sans --root → DENY"
run_gate "$TF" "Bash" '{"command":"npx preflight-marker-write.mjs --target preflight"}' "deny" "ROOT_REQUIRED|--root" "A1b npx invocation sans --root → DENY"
# A3: tab/multi-space variants
run_gate "$TF" "Bash" "{\"command\":\"node\\tscripts/preflight-marker-write.mjs   --target preflight\"}" "deny" "ROOT_REQUIRED|--root" "A3 tab+multi-space sans --root → DENY"

# F3a: helper directly (out of gate) without --root → exit 4
set +e
out="$(echo '{}' | node "$TF/scripts/preflight-marker-write.mjs" --target preflight 2>&1)"
ec=$?
set -e
if printf '%s' "$out" | grep -qE "ROOT_REQUIRED" && [ "$ec" = "4" ]; then
  echo "  ✓ F3a helper without --root → exit 4 ROOT_REQUIRED"
  passed=$((passed+1))
else
  echo "  ✗ F3a — got exit $ec, output: $out"
  failed=$((failed+1))
fi

# F3b: helper from caller cwd != target → marker lands under target
TF="$(mktmp)"; stage_fixture "$TF"
CALLER="$(mktmp)"
out="$(cd "$CALLER" && echo '{"x":1}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
if [ -f "$TF/.checkpoints/.preflight-done" ] && [ ! -f "$CALLER/.checkpoints/.preflight-done" ]; then
  echo "  ✓ F3b caller-cwd != target — marker lands under target"
  passed=$((passed+1))
else
  echo "  ✗ F3b — TF marker exists: $([ -f "$TF/.checkpoints/.preflight-done" ] && echo yes || echo no), CALLER marker exists: $([ -f "$CALLER/.checkpoints/.preflight-done" ] && echo yes || echo no)"
  failed=$((failed+1))
fi

# F3d: --root non-existent → exit 5
set +e
out="$(echo '{}' | node "$REPO_ROOT/scripts/preflight-marker-write.mjs" --root /nonexistent/path --target preflight 2>&1)"
ec=$?
set -e
if printf '%s' "$out" | grep -qE "ROOT_INVALID" && [ "$ec" = "5" ]; then
  echo "  ✓ F3d --root nonexistent → exit 5"
  passed=$((passed+1))
else
  echo "  ✗ F3d — got exit $ec output: $out"
  failed=$((failed+1))
fi

# F3e: --root without repo signals → exit 5
set +e
out="$(echo '{}' | node "$REPO_ROOT/scripts/preflight-marker-write.mjs" --root /tmp --target preflight 2>&1)"
ec=$?
set -e
if printf '%s' "$out" | grep -qE "ROOT_NOT_REPO" && [ "$ec" = "5" ]; then
  echo "  ✓ F3e --root without repo signal → exit 5 ROOT_NOT_REPO"
  passed=$((passed+1))
else
  echo "  ✗ F3e — got exit $ec output: $out"
  failed=$((failed+1))
fi

# ---------------------------------------------------------------------------
# F4-series: atomicity + race
# ---------------------------------------------------------------------------
echo ""
echo "--- F4-series: helper atomicity ---"

# F4a: helper writes valid JSON → success
TF="$(mktmp)"; stage_fixture "$TF"
out="$(echo '{"key":"value"}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
ec=$?
if [ "$ec" = "0" ] && [ -f "$TF/.checkpoints/.preflight-done" ]; then
  parsed_key="$(jq -r '.key' "$TF/.checkpoints/.preflight-done")"
  if [ "$parsed_key" = "value" ]; then
    echo "  ✓ F4a helper writes valid JSON"
    passed=$((passed+1))
  else
    echo "  ✗ F4a — file content wrong"
    failed=$((failed+1))
  fi
else
  echo "  ✗ F4a — exit $ec output: $out"
  failed=$((failed+1))
fi

# B1: non-object JSON (null / array / scalar) → exit 2, no marker
TF="$(mktmp)"; stage_fixture "$TF"
set +e
out="$(echo 'null' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
ec=$?
set -e
if [ "$ec" = "2" ] && [ ! -f "$TF/.checkpoints/.preflight-done" ]; then
  echo "  ✓ B1a JSON null rejected → exit 2, no marker"
  passed=$((passed+1))
else
  echo "  ✗ B1a — exit $ec output: $out"
  failed=$((failed+1))
fi
TF="$(mktmp)"; stage_fixture "$TF"
set +e
out="$(echo '[]' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
ec=$?
set -e
if [ "$ec" = "2" ] && [ ! -f "$TF/.checkpoints/.preflight-done" ]; then
  echo "  ✓ B1b JSON array rejected → exit 2, no marker"
  passed=$((passed+1))
else
  echo "  ✗ B1b — exit $ec output: $out"
  failed=$((failed+1))
fi
TF="$(mktmp)"; stage_fixture "$TF"
set +e
out="$(echo '42' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
ec=$?
set -e
if [ "$ec" = "2" ] && [ ! -f "$TF/.checkpoints/.preflight-done" ]; then
  echo "  ✓ B1c JSON scalar rejected → exit 2, no marker"
  passed=$((passed+1))
else
  echo "  ✗ B1c — exit $ec output: $out"
  failed=$((failed+1))
fi

# F4b: malformed JSON → exit 2, no marker file written
TF="$(mktmp)"; stage_fixture "$TF"
set +e
out="$(echo '{ bad' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
ec=$?
set -e
if [ "$ec" = "2" ] && [ ! -f "$TF/.checkpoints/.preflight-done" ]; then
  echo "  ✓ F4b malformed JSON → exit 2, no marker"
  passed=$((passed+1))
else
  echo "  ✗ F4b — exit $ec, marker exists: $([ -f "$TF/.checkpoints/.preflight-done" ] && echo yes || echo no)"
  failed=$((failed+1))
fi

# F4c: overwrite → file replaced atomically (different inode)
TF="$(mktmp)"; stage_fixture "$TF"
echo '{"v":1}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight >/dev/null
ino1="$(stat -f '%i' "$TF/.checkpoints/.preflight-done")"
echo '{"v":2}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight >/dev/null
ino2="$(stat -f '%i' "$TF/.checkpoints/.preflight-done")"
v2="$(jq -r '.v' "$TF/.checkpoints/.preflight-done")"
if [ "$ino1" != "$ino2" ] && [ "$v2" = "2" ]; then
  echo "  ✓ F4c overwrite is atomic (different inode after rename)"
  passed=$((passed+1))
else
  echo "  ✗ F4c — ino1=$ino1 ino2=$ino2 v2=$v2"
  failed=$((failed+1))
fi

# F4f: concurrent writers — last-writer-wins, no partial files leftover
TF="$(mktmp)"; stage_fixture "$TF"
for i in 1 2 3 4 5; do
  echo "{\"writer\":$i}" | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight >/dev/null &
done
wait
final_writer="$(jq -r '.writer' "$TF/.checkpoints/.preflight-done" 2>/dev/null)"
temp_count="$(ls "$TF/.checkpoints/" | grep -c '\.tmp$' || true)"
if [ -n "$final_writer" ] && [ "$temp_count" = "0" ]; then
  echo "  ✓ F4f concurrent writers — winner=$final_writer, no temps leftover"
  passed=$((passed+1))
else
  echo "  ✗ F4f — final_writer=$final_writer temp_count=$temp_count"
  failed=$((failed+1))
fi

# F4g: reader-during-write race — every read parseable as JSON
TF="$(mktmp)"; stage_fixture "$TF"
echo '{"v":0}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight >/dev/null
# Spawn 20 writers and 50 readers concurrently
for i in $(seq 1 20); do
  echo "{\"v\":$i}" | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight >/dev/null &
done
read_failures=0
for i in $(seq 1 50); do
  if [ -f "$TF/.checkpoints/.preflight-done" ]; then
    if ! jq empty "$TF/.checkpoints/.preflight-done" 2>/dev/null; then
      read_failures=$((read_failures+1))
    fi
  fi
done
wait
if [ "$read_failures" = "0" ]; then
  echo "  ✓ F4g reader-during-write — 50 reads, 0 parse failures"
  passed=$((passed+1))
else
  echo "  ✗ F4g — $read_failures parse failures during race"
  failed=$((failed+1))
fi

# ---------------------------------------------------------------------------
# F5-series: project-root binding (per #20 axis 9)
# ---------------------------------------------------------------------------
echo ""
echo "--- F5-series: project-root binding ---"

# F5a: gate spawned from caller cwd != target → marker artifacts under target
# Updated for C2 plan-v2: last-prompt is now session-namespaced. Pass --session-id.
TF="$(mktmp)"; stage_fixture "$TF"
CALLER="$(mktmp)"
F5A_SID="f5a-fixture"
echo '{"x":1}' | (cd "$CALLER" && node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target last-prompt --session-id "$F5A_SID") >/dev/null
if [ -f "$TF/.checkpoints/.last-user-prompt.${F5A_SID}.json" ] && [ ! -f "$CALLER/.checkpoints/.last-user-prompt.${F5A_SID}.json" ]; then
  echo "  ✓ F5a artifacts land under --root, not caller cwd"
  passed=$((passed+1))
else
  echo "  ✗ F5a — TF: $([ -f "$TF/.checkpoints/.last-user-prompt.${F5A_SID}.json" ] && echo yes || echo no), CALLER: $([ -f "$CALLER/.checkpoints/.last-user-prompt.${F5A_SID}.json" ] && echo yes || echo no)"
  failed=$((failed+1))
fi

# F5b: helper output JSON's project_root field (well, helper outputs path) →
# ensure the path is under --root
TF="$(mktmp)"; stage_fixture "$TF"
out="$(echo '{}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight)"
out_path="$(printf '%s' "$out" | jq -r '.path')"
case "$out_path" in
  "$TF/"*)
    echo "  ✓ F5b helper output path under --root"
    passed=$((passed+1))
    ;;
  *)
    echo "  ✗ F5b — out_path=$out_path not under TF=$TF"
    failed=$((failed+1))
    ;;
esac

# ---------------------------------------------------------------------------
# F1: transitive-import drift (per lesson `...3260`)
# ---------------------------------------------------------------------------
echo ""
echo "--- F1: transitive-import staging ---"

# Staged tmp project must include all 3 lib files for helper to import
# without ERR_MODULE_NOT_FOUND
TF="$(mktmp)"; stage_fixture "$TF"
out="$(echo '{}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
ec=$?
if [ "$ec" = "0" ]; then
  echo "  ✓ F1 helper runs in staged tmp (transitive imports resolved)"
  passed=$((passed+1))
else
  echo "  ✗ F1 — exit $ec output: $out"
  failed=$((failed+1))
fi

# Negative: deliberately remove canonicalize-path-tolerant.mjs to confirm
# the test would catch drift.
rm "$TF/scripts/lib/canonicalize-path-tolerant.mjs"
set +e
out="$(echo '{}' | node "$TF/scripts/preflight-marker-write.mjs" --root "$TF" --target preflight 2>&1)"
ec=$?
set -e
if printf '%s' "$out" | grep -qE "ERR_MODULE_NOT_FOUND|Cannot find module"; then
  echo "  ✓ F1-neg removing lib triggers ERR_MODULE_NOT_FOUND (test would catch drift)"
  passed=$((passed+1))
else
  echo "  ✗ F1-neg — exit $ec output: $out"
  failed=$((failed+1))
fi

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="
exit $((failed > 0 ? 1 : 0))
