#!/usr/bin/env bash
# test-install-hooks.sh — Tests for install.mjs --install-hooks (PR-B per #59)
#
# Verifies the realistic upgrade path observed locally on 2026-05-02:
#   - Pre-existing settings.json with unrelated PreToolUse / SessionStart hooks
#   - Pre-existing flat-shaped SessionEnd entry that Claude Code can't execute
#     (regression guard for the malformed `{command, description}` bug shipped
#     in earlier installer versions)
#   - Phase 3b hook files (checkpoint-gate.sh, em-recall-sessionstart.sh) absent
#
# Per Codex review: divergent local hook files are skipped AND new settings
# registration is withheld unless --install-hooks-force; new-registration
# idempotence keys on exact canonical command path, not basename substring;
# settings.json writes are atomic (temp + rename).
#
# Runs install.mjs against a temp HOME and --project, never touches the user's
# real ~/.claude or ~/.episodic-memory.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/install.mjs"

if [ ! -f "$INSTALLER" ]; then
  echo "FAIL: $INSTALLER not found"
  exit 1
fi

passed=0
failed=0
TEST_HOME=""
TEST_PROJECT=""

cleanup() { [ -n "$TEST_HOME" ] && rm -rf "$TEST_HOME"; [ -n "$TEST_PROJECT" ] && rm -rf "$TEST_PROJECT"; }
trap cleanup EXIT

reset_state() {
  cleanup
  TEST_HOME=$(mktemp -d)
  TEST_PROJECT=$(mktemp -d)
}

run_installer() {
  HOME="$TEST_HOME" node "$INSTALLER" --tool claude-code --project "$TEST_PROJECT" "$@" >/dev/null 2>&1
}

run_installer_capture() {
  HOME="$TEST_HOME" node "$INSTALLER" --tool claude-code --project "$TEST_PROJECT" "$@" 2>&1
}

assert_eq() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $test_name"
    ((passed++))
  else
    echo "  ✗ $test_name (expected '$expected', got '$actual')"
    ((failed++))
  fi
}

# ---------------------------------------------------------------------------
echo "[T1] Fresh install: hook files copied, settings.json populated"
# ---------------------------------------------------------------------------
reset_state
run_installer --install-hooks

[ -x "$TEST_HOME/.claude/hooks/checkpoint-gate.sh" ] && r=true || r=false
assert_eq "T1a checkpoint-gate.sh installed and executable" "true" "$r"

[ -x "$TEST_HOME/.claude/hooks/em-recall-sessionstart.sh" ] && r=true || r=false
assert_eq "T1b em-recall-sessionstart.sh installed and executable" "true" "$r"

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T1c PreToolUse contains exactly one checkpoint-gate entry" "1" "$cg_count"

ss_count=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("em-recall-sessionstart"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T1d SessionStart contains exactly one em-recall-sessionstart entry" "1" "$ss_count"

se_count=$(jq '[.hooks.SessionEnd[]?.hooks[]? | select(.command|test("em-session-end-prompt"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T1e SessionEnd contains exactly one em-session-end-prompt entry (nested shape)" "1" "$se_count"

cg_matcher=$(jq -r '.hooks.PreToolUse[] | select(.hooks[]?.command|test("checkpoint-gate")) | .matcher' "$TEST_HOME/.claude/settings.json")
assert_eq "T1f checkpoint-gate matcher is canonical PreToolUse pattern" "Edit|Write|MultiEdit|Bash|NotebookEdit" "$cg_matcher"

cg_type=$(jq -r '.hooks.PreToolUse[] | select(.hooks[]?.command|test("checkpoint-gate")) | .hooks[0].type' "$TEST_HOME/.claude/settings.json")
assert_eq "T1g checkpoint-gate hook entry has type=command" "command" "$cg_type"

# ---------------------------------------------------------------------------
echo "[T2] Re-run idempotence: no duplicate entries, no diff in hook files"
# ---------------------------------------------------------------------------
sha_before=$(shasum "$TEST_HOME/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
run_installer --install-hooks
sha_after=$(shasum "$TEST_HOME/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
assert_eq "T2a checkpoint-gate.sh unchanged after re-run" "$sha_before" "$sha_after"

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T2b still exactly one checkpoint-gate entry after re-run" "1" "$cg_count"

ss_count=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("em-recall-sessionstart"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T2c still exactly one em-recall-sessionstart entry after re-run" "1" "$ss_count"

se_count=$(jq '[.hooks.SessionEnd[]?.hooks[]? | select(.command|test("em-session-end-prompt"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T2d still exactly one em-session-end-prompt entry after re-run" "1" "$se_count"

# ---------------------------------------------------------------------------
echo "[T3] Migration: pre-existing flat-shape SessionEnd entry rewritten"
# Regression guard for the bug shipped before PR-B (Rule 15).
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_HOME/.claude"
cat > "$TEST_HOME/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionEnd": [
      {
        "command": "node /old/path/em-session-end-prompt.mjs",
        "description": "Prompt for behavioral pattern violations at session end"
      }
    ]
  }
}
JSON
run_installer --install-hooks

flat_count=$(jq '[.hooks.SessionEnd[] | select(.command and (.hooks|not))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T3a no flat-shape SessionEnd entries remain after migration" "0" "$flat_count"

# Migration preserves the original command verbatim — does NOT replace the
# /old/path/ pointer. The new canonical em-session-end-prompt at SCRIPTS_DIR
# is then registered as a separate entry (different path, different command,
# exact-path idempotence treats them distinctly).
old_path_preserved=$(jq -r '[.hooks.SessionEnd[]?.hooks[]? | select(.command|test("/old/path/"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T3b migrated entry preserves /old/path/ command verbatim" "1" "$old_path_preserved"

old_path_type=$(jq -r '.hooks.SessionEnd[]?.hooks[]? | select(.command|test("/old/path/")) | .type' "$TEST_HOME/.claude/settings.json")
assert_eq "T3c migrated entry has type=command" "command" "$old_path_type"

# ---------------------------------------------------------------------------
echo "[T4] Pre-existing unrelated hooks: appended, not replaced"
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_HOME/.claude"
cat > "$TEST_HOME/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "/some/user/plan-gate.sh", "timeout": 5 }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "/some/user/rules-check.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
JSON
run_installer --install-hooks

pre_total=$(jq '.hooks.PreToolUse | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T4a PreToolUse now has 2 entries (existing + checkpoint-gate)" "2" "$pre_total"

plan_gate_intact=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("plan-gate"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T4b existing plan-gate.sh entry preserved" "1" "$plan_gate_intact"

ss_total=$(jq '.hooks.SessionStart | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T4c SessionStart now has 2 entries (existing + em-recall-sessionstart)" "2" "$ss_total"

rules_check_intact=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("rules-check"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T4d existing rules-check.sh entry preserved" "1" "$rules_check_intact"

# ---------------------------------------------------------------------------
echo "[T5] Divergent local hook file: skipped + new settings registration WITHHELD"
# Codex review fix: install.mjs must not point Claude at unreviewed custom
# content. New registration only happens when the canonical file is in place.
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_HOME/.claude/hooks"
echo "#!/bin/bash" > "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
echo "# user-customized" >> "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
chmod +x "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
sha_before=$(shasum "$TEST_HOME/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')

output=$(run_installer_capture --install-hooks)
sha_after=$(shasum "$TEST_HOME/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
assert_eq "T5a divergent checkpoint-gate.sh not overwritten" "$sha_before" "$sha_after"

if echo "$output" | grep -q "Skipped (divergent local edit)"; then r=true; else r=false; fi
assert_eq "T5b warning printed for divergent hook" "true" "$r"

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T5c new checkpoint-gate registration WITHHELD when file install skipped" "0" "$cg_count"

if echo "$output" | grep -q "registration withheld (file install skipped)"; then r=true; else r=false; fi
assert_eq "T5d explicit 'registration withheld' message printed" "true" "$r"

# T5e: divergent + prior registration exists → registration preserved, no duplicate.
reset_state
mkdir -p "$TEST_HOME/.claude/hooks"
echo "#!/bin/bash" > "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
echo "# user-customized" >> "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
chmod +x "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
canon_path="$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
cat > "$TEST_HOME/.claude/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|Bash|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "$canon_path", "timeout": 5 }
        ]
      }
    ]
  }
}
JSON
output=$(run_installer_capture --install-hooks)
cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T5e prior registration preserved when file install skipped" "1" "$cg_count"

if echo "$output" | grep -q "existing registration preserved"; then r=true; else r=false; fi
assert_eq "T5f explicit 'existing registration preserved' message printed" "true" "$r"

# ---------------------------------------------------------------------------
echo "[T6] --install-hooks-force overrides divergent file AND registers"
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_HOME/.claude/hooks"
echo "#!/bin/bash" > "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
echo "# user-customized" >> "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
chmod +x "$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
run_installer --install-hooks --install-hooks-force

sha_repo=$(shasum "$REPO_ROOT/hooks/checkpoint-gate.sh" | awk '{print $1}')
sha_dest=$(shasum "$TEST_HOME/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
assert_eq "T6a --install-hooks-force overwrites divergent hook with repo version" "$sha_repo" "$sha_dest"

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T6b --install-hooks-force registers checkpoint-gate after overwrite" "1" "$cg_count"

# ---------------------------------------------------------------------------
echo "[T7] Identical existing hook: 'unchanged' status, registration proceeds"
# ---------------------------------------------------------------------------
output=$(run_installer_capture --install-hooks)
if echo "$output" | grep -q "Hook already current.*checkpoint-gate"; then r=true; else r=false; fi
assert_eq "T7 identical hook reports 'already current'" "true" "$r"

# ---------------------------------------------------------------------------
echo "[T8] Missing settings.json: created with correct shape"
# ---------------------------------------------------------------------------
reset_state
[ -f "$TEST_HOME/.claude/settings.json" ] && r=true || r=false
assert_eq "T8a settings.json absent before install" "false" "$r"

run_installer --install-hooks
[ -f "$TEST_HOME/.claude/settings.json" ] && r=true || r=false
assert_eq "T8b settings.json created" "true" "$r"

hooks_present=$(jq 'has("hooks")' "$TEST_HOME/.claude/settings.json")
assert_eq "T8c created settings.json has hooks key" "true" "$hooks_present"

# ---------------------------------------------------------------------------
echo "[T9] Atomic settings.json write: orphan .tmp does not corrupt original"
# Codex review fix: writeJSONAtomic uses temp + rename so a partial-write
# scenario leaves the existing settings.json intact.
# ---------------------------------------------------------------------------
reset_state
run_installer --install-hooks
sha_settings_before=$(shasum "$TEST_HOME/.claude/settings.json" | awk '{print $1}')

# Plant an orphan .tmp from a notional crashed prior run. The installer's next
# atomic write must overwrite the .tmp via fs.writeFileSync (truncate semantics)
# then rename atomically — leaving no .tmp behind and the real settings.json
# valid JSON post-run.
echo "{ partial garbage" > "$TEST_HOME/.claude/settings.json.tmp"
run_installer --install-hooks

if [ -f "$TEST_HOME/.claude/settings.json.tmp" ]; then r=true; else r=false; fi
assert_eq "T9a orphan .tmp cleared after atomic write (renamed away)" "false" "$r"

if jq empty "$TEST_HOME/.claude/settings.json" 2>/dev/null; then r=true; else r=false; fi
assert_eq "T9b settings.json is valid JSON after atomic write" "true" "$r"

# Re-running without changes should be byte-identical (atomic determinism).
sha_settings_after=$(shasum "$TEST_HOME/.claude/settings.json" | awk '{print $1}')
assert_eq "T9c second atomic write yields byte-identical settings.json" "$sha_settings_before" "$sha_settings_after"

# ---------------------------------------------------------------------------
echo "[T10] Exact-path idempotence: same basename at different path is NOT a dup"
# Codex review fix: registrations key on exact canonical command, not
# basename substring. A user-installed file at a different path must not
# false-positive and skip the canonical registration.
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_HOME/.claude"
cat > "$TEST_HOME/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "/somewhere/else/checkpoint-gate.sh", "timeout": 5 }
        ]
      }
    ]
  }
}
JSON
run_installer --install-hooks

cg_total=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T10a both checkpoint-gate registrations coexist (different paths)" "2" "$cg_total"

# Non-canonical entry preserved verbatim.
nc=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command == "/somewhere/else/checkpoint-gate.sh")] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T10b non-canonical /somewhere/else/checkpoint-gate.sh entry preserved" "1" "$nc"

canonical_path="$TEST_HOME/.claude/hooks/checkpoint-gate.sh"
canon_count=$(jq --arg p "$canonical_path" '[.hooks.PreToolUse[]?.hooks[]? | select(.command == $p)] | length' "$TEST_HOME/.claude/settings.json")
assert_eq "T10c canonical checkpoint-gate.sh registered at exact installed path" "1" "$canon_count"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Passed: $passed"
echo "Failed: $failed"
[ $failed -eq 0 ]
