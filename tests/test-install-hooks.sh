#!/usr/bin/env bash
# test-install-hooks.sh — Tests for install.mjs --install-enforcement (PR-B per #59)
#
# RFC-008 P4d / Principle 12: enforcement hooks + the enforcement runtime moved
# from GLOBAL to PER-PROJECT install. Enforcement now installs under the flag
# --install-enforcement (NOT --install-hooks) to per-project locations:
#   - hook .sh + .mjs files → <project>/.claude/hooks/
#   - hook libs (.sh + .mjs) → <project>/.claude/hooks/lib/
#   - registrations → <project>/.claude/settings.json (NOT global)
#   - contract config (taxonomy/bp-001/events/enforce-config.schema.json) →
#     <project>/.claude/hooks/patterns/
#   - plugins/_index.json → <project>/.claude/hooks/plugins/_index.json
# The global hook-freshness manifest ($HOME/.episodic-memory/hook-install.json)
# is NO LONGER WRITTEN. --install-hooks-force still controls force-overwrite of
# divergent files, alongside --install-enforcement.
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
run_installer --install-enforcement

[ -x "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh" ] && r=true || r=false
assert_eq "T1a checkpoint-gate.sh installed and executable" "true" "$r"

[ -x "$TEST_PROJECT/.claude/hooks/em-recall-sessionstart.sh" ] && r=true || r=false
assert_eq "T1b em-recall-sessionstart.sh installed and executable" "true" "$r"

# Issue #86 PR-A: plan-gate.sh canonicalized into repo + deployed by installer.
[ -x "$TEST_PROJECT/.claude/hooks/plan-gate.sh" ] && r=true || r=false
assert_eq "T1b2 plan-gate.sh installed and executable (#86 PR-A)" "true" "$r"

# Session 1 (#86 PR-B / #89 / #101): hooks/lib/ deployed alongside hooks/
# (per-project: <project>/.claude/hooks/lib/).
[ -f "$TEST_PROJECT/.claude/hooks/lib/command-classifier.sh" ] && r=true || r=false
assert_eq "T1b3 hooks/lib/command-classifier.sh installed (Session 1)" "true" "$r"
[ -f "$TEST_PROJECT/.claude/hooks/lib/repo-root.sh" ] && r=true || r=false
assert_eq "T1b4 hooks/lib/repo-root.sh installed (Session 1)" "true" "$r"
# Hooks should be able to source the lib (smoke test).
HOME="$TEST_HOME" bash -c "source $TEST_PROJECT/.claude/hooks/lib/command-classifier.sh && type classify_command >/dev/null 2>&1" && r=true || r=false
assert_eq "T1b5 installed lib sources successfully and exports classify_command" "true" "$r"

# (RFC-008 P4d) hook-freshness manifest removed — enforcement installs per-project; see test-p12-global-clean.mjs

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1c PreToolUse contains exactly one checkpoint-gate entry" "1" "$cg_count"

pg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("plan-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1c2 PreToolUse contains exactly one plan-gate entry (#86 PR-A)" "1" "$pg_count"

# plan-gate.sh registers with NO matcher (per design — must run on every
# PreToolUse so the tool-name allowlist is the sole filter).
pg_matcher=$(jq -r '.hooks.PreToolUse[] | select(.hooks[]?.command|test("plan-gate")) | .matcher // "<none>"' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1c3 plan-gate registered with no matcher (runs on every PreToolUse)" "<none>" "$pg_matcher"

ss_count=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("em-recall-sessionstart"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1d SessionStart contains exactly one em-recall-sessionstart entry" "1" "$ss_count"

# session-handoff-prompt.sh tracking (checkpoint-hygiene F3): copied,
# registered exactly once with timeout 5, and ordered AFTER
# em-recall-sessionstart (matches the pre-existing manual registration).
[ -f "$TEST_PROJECT/.claude/hooks/session-handoff-prompt.sh" ] && r=true || r=false
assert_eq "T1d2 session-handoff-prompt.sh copied to <project>/.claude/hooks/ (F3)" "true" "$r"

shp_count=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("session-handoff-prompt"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1d3 SessionStart contains exactly one session-handoff-prompt entry (F3)" "1" "$shp_count"

shp_timeout=$(jq -r '.hooks.SessionStart[]?.hooks[]? | select(.command|test("session-handoff-prompt")) | .timeout' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1d4 session-handoff-prompt entry timeout=5s (F3)" "5" "$shp_timeout"

shp_order=$(jq '[.hooks.SessionStart[].hooks[0].command] as $c | ($c | map(test("em-recall-sessionstart")) | index(true)) < ($c | map(test("session-handoff-prompt")) | index(true))' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1d6 em-recall-sessionstart registered before session-handoff-prompt (F3)" "true" "$shp_order"

se_count=$(jq '[.hooks.SessionEnd[]?.hooks[]? | select(.command|test("em-session-end-prompt"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1e SessionEnd contains exactly one em-session-end-prompt entry (nested shape)" "1" "$se_count"

cg_matcher=$(jq -r '.hooks.PreToolUse[] | select(.hooks[]?.command|test("checkpoint-gate")) | .matcher' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1f checkpoint-gate matcher is canonical PreToolUse pattern" "Edit|Write|MultiEdit|Bash|NotebookEdit" "$cg_matcher"

cg_type=$(jq -r '.hooks.PreToolUse[] | select(.hooks[]?.command|test("checkpoint-gate")) | .hooks[0].type' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T1g checkpoint-gate hook entry has type=command" "command" "$cg_type"

# ---------------------------------------------------------------------------
echo "[T2] Re-run idempotence: no duplicate entries, no diff in hook files"
# ---------------------------------------------------------------------------
sha_before=$(shasum "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
run_installer --install-enforcement
sha_after=$(shasum "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
assert_eq "T2a checkpoint-gate.sh unchanged after re-run" "$sha_before" "$sha_after"

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T2b still exactly one checkpoint-gate entry after re-run" "1" "$cg_count"

pg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("plan-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T2b2 still exactly one plan-gate entry after re-run (#86 PR-A)" "1" "$pg_count"

ss_count=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("em-recall-sessionstart"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T2c still exactly one em-recall-sessionstart entry after re-run" "1" "$ss_count"

shp_count=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("session-handoff-prompt"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T2c2 still exactly one session-handoff-prompt entry after re-run (F3)" "1" "$shp_count"

se_count=$(jq '[.hooks.SessionEnd[]?.hooks[]? | select(.command|test("em-session-end-prompt"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T2d still exactly one em-session-end-prompt entry after re-run" "1" "$se_count"

# ---------------------------------------------------------------------------
echo "[T3] Migration: pre-existing flat-shape SessionEnd entry rewritten"
# Regression guard for the bug shipped before PR-B (Rule 15).
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude"
cat > "$TEST_PROJECT/.claude/settings.json" <<'JSON'
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
run_installer --install-enforcement

flat_count=$(jq '[.hooks.SessionEnd[] | select(.command and (.hooks|not))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T3a no flat-shape SessionEnd entries remain after migration" "0" "$flat_count"

# Migration preserves the original command verbatim — does NOT replace the
# /old/path/ pointer. The new canonical em-session-end-prompt at the per-project
# hooks dir is then registered as a separate entry (different path, different
# command, exact-path idempotence treats them distinctly).
old_path_preserved=$(jq -r '[.hooks.SessionEnd[]?.hooks[]? | select(.command|test("/old/path/"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T3b migrated entry preserves /old/path/ command verbatim" "1" "$old_path_preserved"

old_path_type=$(jq -r '.hooks.SessionEnd[]?.hooks[]? | select(.command|test("/old/path/")) | .type' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T3c migrated entry has type=command" "command" "$old_path_type"

# ---------------------------------------------------------------------------
echo "[T4] Pre-existing unrelated hooks: appended, not replaced"
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude"
cat > "$TEST_PROJECT/.claude/settings.json" <<'JSON'
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
output=$(run_installer_capture --install-enforcement)

pre_total=$(jq '.hooks.PreToolUse | length' "$TEST_PROJECT/.claude/settings.json")
# Post #86 PR-A: existing /some/user/plan-gate.sh + canonical checkpoint-gate
# + canonical plan-gate + canonical preflight-gate = 4 entries. The stale
# /some/user/plan-gate.sh is preserved verbatim (T4b) and the canonical is
# registered separately (T4b3).
assert_eq "T4a PreToolUse now has 4 entries (existing plan-gate + canonical checkpoint-gate + canonical plan-gate + canonical preflight-gate)" "4" "$pre_total"

plan_gate_existing=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command == "/some/user/plan-gate.sh")] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T4b existing /some/user/plan-gate.sh entry preserved verbatim" "1" "$plan_gate_existing"

plan_gate_canonical_path="$TEST_PROJECT/.claude/hooks/plan-gate.sh"
plan_gate_canonical=$(jq --arg p "$plan_gate_canonical_path" '[.hooks.PreToolUse[]?.hooks[]? | select(.command == $p)] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T4b2 canonical plan-gate.sh registered at exact installed path (#86 PR-A)" "1" "$plan_gate_canonical"

# Stale-canonical warning surfaced by detectStaleCanonicalEntries.
if echo "$output" | grep -q "stale PreToolUse entry for plan-gate.sh"; then r=true; else r=false; fi
assert_eq "T4b3 stale-canonical warning printed for non-canonical /some/user/plan-gate.sh" "true" "$r"

ss_total=$(jq '.hooks.SessionStart | length' "$TEST_PROJECT/.claude/settings.json")
# RFC-008 P4d: the always-on BP-1 activation layer (H1 approval-check + H2
# sweep-on-session) registers 2 SessionStart entries on EVERY install,
# independent of --install-enforcement. So: existing rules-check + bp1-H1 +
# bp1-H2 + em-recall-sessionstart + session-handoff-prompt = 5.
assert_eq "T4c SessionStart now has 5 entries (existing + bp1-H1 + bp1-H2 + em-recall-sessionstart + session-handoff-prompt)" "5" "$ss_total"

rules_check_intact=$(jq '[.hooks.SessionStart[]?.hooks[]? | select(.command|test("rules-check"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T4d existing rules-check.sh entry preserved" "1" "$rules_check_intact"

# ---------------------------------------------------------------------------
echo "[T5] Divergent local hook file: skipped + new settings registration WITHHELD"
# Codex review fix: install.mjs must not point Claude at unreviewed custom
# content. New registration only happens when the canonical file is in place.
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks"
echo "#!/bin/bash" > "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
echo "# user-customized" >> "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
chmod +x "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
sha_before=$(shasum "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')

output=$(run_installer_capture --install-enforcement)
sha_after=$(shasum "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
assert_eq "T5a divergent checkpoint-gate.sh not overwritten" "$sha_before" "$sha_after"

if echo "$output" | grep -q "Skipped (divergent local edit)"; then r=true; else r=false; fi
assert_eq "T5b warning printed for divergent hook" "true" "$r"

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T5c new checkpoint-gate registration WITHHELD when file install skipped" "0" "$cg_count"

if echo "$output" | grep -q "registration withheld (file install skipped)"; then r=true; else r=false; fi
assert_eq "T5d explicit 'registration withheld' message printed" "true" "$r"

# T5e: divergent + prior registration exists → registration preserved, no duplicate.
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks"
echo "#!/bin/bash" > "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
echo "# user-customized" >> "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
chmod +x "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
canon_path="$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
cat > "$TEST_PROJECT/.claude/settings.json" <<JSON
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
output=$(run_installer_capture --install-enforcement)
cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T5e prior registration preserved when file install skipped" "1" "$cg_count"

if echo "$output" | grep -q "existing registration preserved"; then r=true; else r=false; fi
assert_eq "T5f explicit 'existing registration preserved' message printed" "true" "$r"

# ---------------------------------------------------------------------------
echo "[T6] --install-hooks-force overrides divergent file AND registers"
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks"
echo "#!/bin/bash" > "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
echo "# user-customized" >> "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
chmod +x "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
run_installer --install-enforcement --install-hooks-force

sha_repo=$(shasum "$REPO_ROOT/plugins/claude-code/hooks/checkpoint-gate.sh" | awk '{print $1}')
sha_dest=$(shasum "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh" | awk '{print $1}')
assert_eq "T6a --install-hooks-force overwrites divergent hook with repo version" "$sha_repo" "$sha_dest"

cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T6b --install-hooks-force registers checkpoint-gate after overwrite" "1" "$cg_count"

# ---------------------------------------------------------------------------
echo "[T7] Identical existing hook: 'unchanged' status, registration proceeds"
# ---------------------------------------------------------------------------
output=$(run_installer_capture --install-enforcement)
if echo "$output" | grep -q "Hook already current.*checkpoint-gate"; then r=true; else r=false; fi
assert_eq "T7 identical hook reports 'already current'" "true" "$r"

# ---------------------------------------------------------------------------
echo "[T8] Missing settings.json: created with correct shape"
# ---------------------------------------------------------------------------
reset_state
[ -f "$TEST_PROJECT/.claude/settings.json" ] && r=true || r=false
assert_eq "T8a settings.json absent before install" "false" "$r"

run_installer --install-enforcement
[ -f "$TEST_PROJECT/.claude/settings.json" ] && r=true || r=false
assert_eq "T8b settings.json created" "true" "$r"

hooks_present=$(jq 'has("hooks")' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T8c created settings.json has hooks key" "true" "$hooks_present"

# ---------------------------------------------------------------------------
echo "[T9] Atomic settings.json write: orphan .tmp does not corrupt original"
# Codex review fix: writeJSONAtomic uses temp + rename so a partial-write
# scenario leaves the existing settings.json intact.
# ---------------------------------------------------------------------------
reset_state
run_installer --install-enforcement
sha_settings_before=$(shasum "$TEST_PROJECT/.claude/settings.json" | awk '{print $1}')

# Plant an orphan .tmp from a notional crashed prior run. The installer's next
# atomic write must overwrite the .tmp via fs.writeFileSync (truncate semantics)
# then rename atomically — leaving no .tmp behind and the real settings.json
# valid JSON post-run.
echo "{ partial garbage" > "$TEST_PROJECT/.claude/settings.json.tmp"
run_installer --install-enforcement

if [ -f "$TEST_PROJECT/.claude/settings.json.tmp" ]; then r=true; else r=false; fi
assert_eq "T9a orphan .tmp cleared after atomic write (renamed away)" "false" "$r"

if jq empty "$TEST_PROJECT/.claude/settings.json" 2>/dev/null; then r=true; else r=false; fi
assert_eq "T9b settings.json is valid JSON after atomic write" "true" "$r"

# Re-running without changes should be byte-identical (atomic determinism).
sha_settings_after=$(shasum "$TEST_PROJECT/.claude/settings.json" | awk '{print $1}')
assert_eq "T9c second atomic write yields byte-identical settings.json" "$sha_settings_before" "$sha_settings_after"

# ---------------------------------------------------------------------------
echo "[T10] Exact-path idempotence: same basename at different path is NOT a dup"
# Codex review fix: registrations key on exact canonical command, not
# basename substring. A user-installed file at a different path must not
# false-positive and skip the canonical registration.
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude"
cat > "$TEST_PROJECT/.claude/settings.json" <<'JSON'
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
run_installer --install-enforcement

cg_total=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T10a both checkpoint-gate registrations coexist (different paths)" "2" "$cg_total"

# Non-canonical entry preserved verbatim.
nc=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command == "/somewhere/else/checkpoint-gate.sh")] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T10b non-canonical /somewhere/else/checkpoint-gate.sh entry preserved" "1" "$nc"

canonical_path="$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
canon_count=$(jq --arg p "$canonical_path" '[.hooks.PreToolUse[]?.hooks[]? | select(.command == $p)] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T10c canonical checkpoint-gate.sh registered at exact installed path" "1" "$canon_count"

# ---------------------------------------------------------------------------
echo "[T11] Code-review P2: --install-hooks-force without --install-hooks/--install-enforcement warns + no enforcement install"
# ---------------------------------------------------------------------------
reset_state
output=$(run_installer_capture --install-hooks-force)
if echo "$output" | grep -q "Warning: --install-hooks-force has no effect without --install-hooks"; then r=true; else r=false; fi
assert_eq "T11a warning printed when force flag passed alone" "true" "$r"

# RFC-008 P4d: the enforcement block is gated on --install-enforcement, so a
# bare --install-hooks-force installs NO enforcement gate. (The always-on BP-1
# activation layer still creates settings.json with its 2 SessionStart hooks —
# that is the substrate activation layer, not enforcement.) Assert no
# enforcement hook (checkpoint-gate) was registered.
cg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json" 2>/dev/null || echo 0)
assert_eq "T11b no enforcement hook registered (enforcement block correctly skipped)" "0" "$cg_count"

[ -f "$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh" ] && r=true || r=false
assert_eq "T11c no enforcement hook file installed (enforcement block correctly skipped)" "false" "$r"

# ---------------------------------------------------------------------------
echo "[T12] Code-review P2: stale-canonical detection after migration"
# A pre-existing flat-shape entry pointing at a non-canonical em-session-end-
# prompt.mjs path is migrated verbatim. The canonical SCRIPTS_DIR registration
# is added separately. Installer must warn about the resulting stale entry.
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude"
cat > "$TEST_PROJECT/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionEnd": [
      {
        "command": "node /old/bogus/path/em-session-end-prompt.mjs",
        "description": "stale"
      }
    ]
  }
}
JSON
output=$(run_installer_capture --install-enforcement)
if echo "$output" | grep -q "stale SessionEnd entry for em-session-end-prompt.mjs"; then r=true; else r=false; fi
assert_eq "T12a stale-canonical warning printed for migrated /old/bogus/path/" "true" "$r"

# Both entries coexist: canonical (newly registered) + stale (migrated, preserved verbatim).
sec=$(jq '[.hooks.SessionEnd[]?.hooks[]? | select(.command|test("em-session-end-prompt"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T12b both em-session-end-prompt entries coexist (canonical + stale)" "2" "$sec"

# ---------------------------------------------------------------------------
echo "[T13] Codex post-PR review: HOME with spaces — registered commands must be shell-safe"
# Reproduces the failure Codex demonstrated against PR-B v1: HOME containing
# spaces produced unquoted command strings that the shell split at the first
# space, silently failing to invoke the hook. Fixed by shellQuote() helper.
# ---------------------------------------------------------------------------
cleanup
TEST_HOME=$(mktemp -d -t "em hooks ")
TEST_PROJECT=$(mktemp -d -t "em proj ")
if [[ "$TEST_HOME" != *" "* ]]; then
  echo "  ⚠ T13/T14 skipped: mktemp template did not yield space-bearing path on this platform (no counter bumped)"
fi

if [[ "$TEST_HOME" == *" "* ]]; then
  run_installer --install-enforcement

  cg_cmd=$(jq -r '.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate")) | .command' "$TEST_PROJECT/.claude/settings.json")
  case "$cg_cmd" in
    "'"*"'") r=true ;;
    *) r=false ;;
  esac
  assert_eq "T13a checkpoint-gate command is shell-quoted (single quotes)" "true" "$r"

  # Each registered hook command must execute under sh -c without
  # 'no such file or directory' (this is the failure mode Codex reproduced).
  cg_err=$(sh -c "$cg_cmd </dev/null 2>&1" || true)
  if echo "$cg_err" | grep -q "No such file"; then r=true; else r=false; fi
  assert_eq "T13b checkpoint-gate command resolves under sh -c (no 'No such file')" "false" "$r"

  ss_cmd=$(jq -r '.hooks.SessionStart[]?.hooks[]? | select(.command|test("em-recall-sessionstart")) | .command' "$TEST_PROJECT/.claude/settings.json")
  ss_err=$(sh -c "$ss_cmd </dev/null 2>&1" || true)
  if echo "$ss_err" | grep -q "No such file"; then r=true; else r=false; fi
  assert_eq "T13c sessionstart command resolves under sh -c" "false" "$r"

  se_cmd=$(jq -r '.hooks.SessionEnd[]?.hooks[]? | select(.command|test("em-session-end-prompt")) | .command' "$TEST_PROJECT/.claude/settings.json")
  # Extract the quoted path arg (everything after `node `) and verify the file exists.
  se_path=$(echo "$se_cmd" | sed -E "s/^node //; s/^'(.*)'\$/\1/")
  [ -f "$se_path" ] && r=true || r=false
  assert_eq "T13d sessionend node-arg path actually exists at the resolved location" "true" "$r"
fi

# ---------------------------------------------------------------------------
echo "[T14] Codex post-PR review: v1→v2 upgrade idempotence on spaced paths"
# A user who installed PR-B v1 has an UNQUOTED command in settings.json. PR-B
# v2 produces a QUOTED command for the same canonical path. normalizeCommand()
# treats them as the same; re-install must NOT add a duplicate.
# ---------------------------------------------------------------------------
if [[ "$TEST_HOME" == *" "* ]]; then
  # Hand-craft a v1-style unquoted entry.
  cleanup
  TEST_HOME=$(mktemp -d -t "em hooks ")
  TEST_PROJECT=$(mktemp -d -t "em proj ")
  legacy_cmd="$TEST_PROJECT/.claude/hooks/checkpoint-gate.sh"
  mkdir -p "$TEST_PROJECT/.claude/hooks"
  # First place a copy of the canonical hook so installHookFile reports
  # 'unchanged' (file install eligibility succeeds) — so addHookEntry's
  # idempotence check is what determines whether we duplicate.
  cp "$REPO_ROOT/plugins/claude-code/hooks/checkpoint-gate.sh" "$legacy_cmd"
  chmod +x "$legacy_cmd"
  cat > "$TEST_PROJECT/.claude/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|Bash|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "$legacy_cmd", "timeout": 5 }
        ]
      }
    ]
  }
}
JSON
  run_installer --install-enforcement

  cg_total=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("checkpoint-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
  assert_eq "T14 v1 unquoted entry is recognized as canonical; no duplicate added" "1" "$cg_total"
fi

# ---------------------------------------------------------------------------
echo "[T15] Issue #86 PR-A: divergent local plan-gate.sh — skipped + reg withheld"
# Mirrors T5/T5a-T5d for checkpoint-gate. plan-gate.sh canonicalized into the
# repo per #86 PR-A; the same conservative install behavior applies — we must
# not point Claude at unreviewed custom content.
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks"
echo "#!/bin/bash" > "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
echo "# user-customized plan-gate" >> "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
chmod +x "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
sha_before=$(shasum "$TEST_PROJECT/.claude/hooks/plan-gate.sh" | awk '{print $1}')

output=$(run_installer_capture --install-enforcement)
sha_after=$(shasum "$TEST_PROJECT/.claude/hooks/plan-gate.sh" | awk '{print $1}')
assert_eq "T15a divergent plan-gate.sh not overwritten" "$sha_before" "$sha_after"

if echo "$output" | grep -q "Skipped (divergent local edit).*plan-gate.sh"; then r=true; else r=false; fi
assert_eq "T15b warning printed for divergent plan-gate" "true" "$r"

pg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("plan-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T15c new plan-gate registration WITHHELD when file install skipped" "0" "$pg_count"

# T15d: divergent plan-gate + prior canonical registration → preserved.
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks"
echo "#!/bin/bash" > "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
echo "# user-customized" >> "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
chmod +x "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
canon_pg_path="$TEST_PROJECT/.claude/hooks/plan-gate.sh"
cat > "$TEST_PROJECT/.claude/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "$canon_pg_path", "timeout": 5 }
        ]
      }
    ]
  }
}
JSON
output=$(run_installer_capture --install-enforcement)
pg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("plan-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T15d prior plan-gate registration preserved when file install skipped" "1" "$pg_count"

# P2 (code review): assert the user-visible "existing registration preserved"
# message actually printed for plan-gate. Without this, a branch flip in
# install.mjs:installHooks (eligibleForReg → preserved/withheld) could regress
# silently while the count assertion still passes.
if echo "$output" | grep -q "PreToolUse plan-gate.sh: existing registration preserved"; then r=true; else r=false; fi
assert_eq "T15e explicit 'existing registration preserved' message printed for plan-gate" "true" "$r"

# ---------------------------------------------------------------------------
echo "[T16] Issue #86 PR-A: --install-hooks-force overwrites divergent plan-gate AND registers"
# ---------------------------------------------------------------------------
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks"
echo "#!/bin/bash" > "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
echo "# user-customized" >> "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
chmod +x "$TEST_PROJECT/.claude/hooks/plan-gate.sh"
run_installer --install-enforcement --install-hooks-force

sha_repo=$(shasum "$REPO_ROOT/plugins/claude-code/hooks/plan-gate.sh" | awk '{print $1}')
sha_dest=$(shasum "$TEST_PROJECT/.claude/hooks/plan-gate.sh" | awk '{print $1}')
assert_eq "T16a --install-hooks-force overwrites divergent plan-gate with repo version" "$sha_repo" "$sha_dest"

pg_count=$(jq '[.hooks.PreToolUse[]?.hooks[]? | select(.command|test("plan-gate"))] | length' "$TEST_PROJECT/.claude/settings.json")
assert_eq "T16b --install-hooks-force registers plan-gate after overwrite" "1" "$pg_count"

# ---------------------------------------------------------------------------
# T17: #238 plan-v2 C6 — preflight-prompt-helper.sh wired on UserPromptSubmit
# ---------------------------------------------------------------------------
echo ""
echo "--- T17: UserPromptSubmit hook wiring (#238 C6) ---"
reset_state
run_installer --install-enforcement

# Hook file copied
if [ -f "$TEST_PROJECT/.claude/hooks/preflight-prompt-helper.sh" ]; then
  echo "  ✓ T17a preflight-prompt-helper.sh copied to <project>/.claude/hooks/"
  ((passed++))
else
  echo "  ✗ T17a preflight-prompt-helper.sh missing"
  ((failed++))
fi

# Registered under UserPromptSubmit (event-agnostic addHookEntry path)
ups_count=$(jq '[.hooks.UserPromptSubmit[]?.hooks[]? | select(.command|test("preflight-prompt-helper"))] | length' "$TEST_PROJECT/.claude/settings.json" 2>/dev/null || echo 0)
assert_eq "T17b preflight-prompt-helper registered on UserPromptSubmit" "1" "$ups_count"

# No matcher on the entry (UserPromptSubmit always fires per hooks ref:85)
ups_matcher=$(jq -r '.hooks.UserPromptSubmit[]? | select(.hooks[].command | test("preflight-prompt-helper")) | .matcher // "absent"' "$TEST_PROJECT/.claude/settings.json" 2>/dev/null)
assert_eq "T17c UserPromptSubmit entry has no matcher" "absent" "$ups_matcher"

# Timeout from HOOK_SPECS (5s)
ups_timeout=$(jq -r '.hooks.UserPromptSubmit[]?.hooks[]? | select(.command|test("preflight-prompt-helper")) | .timeout' "$TEST_PROJECT/.claude/settings.json" 2>/dev/null)
assert_eq "T17d UserPromptSubmit entry timeout=5s" "5" "$ups_timeout"

# T17e (#442): preflight-prompt-helper.sh dynamically imports preflight-prompt-canon.mjs
# from $HOOK_DIR/lib via `node -e import(...)`. That shell-only load is invisible to the
# JS import-closure, so the lib must be deployed co-located via SHELL_LOADED_HOOK_LIBS
# in install-manifest.mjs — otherwise the helper falls back to $REPO_ROOT/scripts (absent
# in foreign projects). Regression guard for that manifest entry.
[ -f "$TEST_PROJECT/.claude/hooks/lib/preflight-prompt-canon.mjs" ] && r=true || r=false
assert_eq "T17e preflight-prompt-canon.mjs deployed co-located (shell-loaded hook lib)" "true" "$r"

# ---------------------------------------------------------------------------
# T18: #238 plan-v2 C6 — --bootstrap-last-prompt sentinel write
# ---------------------------------------------------------------------------
echo ""
echo "--- T18: --bootstrap-last-prompt (#238 C6) ---"
reset_state

# Bootstrap with --session-id flag (no env)
HOME="$TEST_HOME" node "$INSTALLER" --bootstrap-last-prompt --project "$TEST_PROJECT" --session-id "boot-test-1" >/dev/null 2>&1
EC=$?
if [ $EC -eq 0 ] && [ -f "$TEST_PROJECT/.checkpoints/.last-user-prompt.boot-test-1.json" ]; then
  echo "  ✓ T18a --session-id flag writes sentinel"
  ((passed++))
else
  echo "  ✗ T18a sentinel not written (ec=$EC)"
  ((failed++))
fi

# Sentinel has bootstrap=true + recent wrote_at_ms
boot_flag=$(jq -r '.bootstrap' "$TEST_PROJECT/.checkpoints/.last-user-prompt.boot-test-1.json" 2>/dev/null)
assert_eq "T18b sentinel bootstrap=true" "true" "$boot_flag"

# Bootstrap with env CLAUDE_SESSION_ID
reset_state
HOME="$TEST_HOME" CLAUDE_SESSION_ID="env-sid-2" node "$INSTALLER" --bootstrap-last-prompt --project "$TEST_PROJECT" >/dev/null 2>&1
if [ -f "$TEST_PROJECT/.checkpoints/.last-user-prompt.env-sid-2.json" ]; then
  echo "  ✓ T18c CLAUDE_SESSION_ID env var works"
  ((passed++))
else
  echo "  ✗ T18c env-var path failed"
  ((failed++))
fi

# Missing session_id → error
reset_state
out=$(HOME="$TEST_HOME" node "$INSTALLER" --bootstrap-last-prompt --project "$TEST_PROJECT" 2>&1)
EC=$?
if [ $EC -ne 0 ] && echo "$out" | grep -q "no session_id"; then
  echo "  ✓ T18d missing session_id → exit 1 + clear error"
  ((passed++))
else
  echo "  ✗ T18d no-session_id behavior wrong (ec=$EC): $out"
  ((failed++))
fi

# Invalid session_id format → error
reset_state
out=$(HOME="$TEST_HOME" node "$INSTALLER" --bootstrap-last-prompt --project "$TEST_PROJECT" --session-id "bad/sid" 2>&1)
EC=$?
if [ $EC -ne 0 ] && echo "$out" | grep -qE "does not match"; then
  echo "  ✓ T18e bad session_id format → exit 1"
  ((passed++))
else
  echo "  ✗ T18e bad-sid behavior wrong (ec=$EC): $out"
  ((failed++))
fi

# Standalone (no --tool) succeeds
reset_state
out=$(HOME="$TEST_HOME" node "$INSTALLER" --bootstrap-last-prompt --project "$TEST_PROJECT" --session-id "standalone" 2>&1)
EC=$?
if [ $EC -eq 0 ] && [ -f "$TEST_PROJECT/.checkpoints/.last-user-prompt.standalone.json" ]; then
  echo "  ✓ T18f standalone (no --tool) succeeds"
  ((passed++))
else
  echo "  ✗ T18f standalone path failed (ec=$EC): $out"
  ((failed++))
fi

# ---------------------------------------------------------------------------
echo "[T19] PR-B orphan sweep: renamed llm-classifier.* deleted when new files current"
# ---------------------------------------------------------------------------
reset_state
# Pre-seed stale installed copies of the OLD names (as if upgrading from a
# pre-PR-B install). The repo no longer ships these basenames, so the glob copy
# won't touch them; the conditional sweep must delete them. RFC-008 P4d: the
# lib .sh orphan now lives per-project at <project>/.claude/hooks/lib/; the
# .mjs dispatch orphan stays at the GLOBAL $HOME/.episodic-memory/scripts/
# (SCRIPTS_DIR in install.mjs RENAMED_REMOVED).
mkdir -p "$TEST_PROJECT/.claude/hooks/lib" "$TEST_HOME/.episodic-memory/scripts"
echo "# stale old wrapper" > "$TEST_PROJECT/.claude/hooks/lib/llm-classifier.sh"
echo "// stale old dispatcher" > "$TEST_HOME/.episodic-memory/scripts/llm-classifier-dispatch.mjs"
output=$(run_installer_capture --install-enforcement)

[ -f "$TEST_PROJECT/.claude/hooks/lib/agent-classifier.sh" ] && r=true || r=false
assert_eq "T19a new agent-classifier.sh installed" "true" "$r"
[ -e "$TEST_PROJECT/.claude/hooks/lib/llm-classifier.sh" ] && r=true || r=false
assert_eq "T19b stale llm-classifier.sh swept (deleted)" "false" "$r"
[ -e "$TEST_HOME/.episodic-memory/scripts/llm-classifier-dispatch.mjs" ] && r=true || r=false
assert_eq "T19c stale llm-classifier-dispatch.mjs swept (deleted)" "false" "$r"
if echo "$output" | grep -q "Removed stale renamed file.*llm-classifier.sh"; then r=true; else r=false; fi
assert_eq "T19d sweep logged the removal" "true" "$r"

# T19e: sweep WITHHELD when command-classifier.sh is divergent (skipped) — must
# not delete an orphan a still-divergent command-classifier.sh might source.
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks/lib"
echo "#!/bin/bash" > "$TEST_PROJECT/.claude/hooks/lib/command-classifier.sh"
echo "# user-customized divergent classifier" >> "$TEST_PROJECT/.claude/hooks/lib/command-classifier.sh"
echo "# stale old wrapper" > "$TEST_PROJECT/.claude/hooks/lib/llm-classifier.sh"
output=$(run_installer_capture --install-enforcement)

[ -e "$TEST_PROJECT/.claude/hooks/lib/llm-classifier.sh" ] && r=true || r=false
assert_eq "T19e stale llm-classifier.sh NOT swept while command-classifier.sh divergent" "true" "$r"
if echo "$output" | grep -q "Skipped orphan sweep"; then r=true; else r=false; fi
assert_eq "T19f sweep-withheld message printed on divergent command-classifier" "true" "$r"

# ---------------------------------------------------------------------------
# T20: RFC-008 P4d / P3c — taxonomy.json + contract-set PER-PROJECT co-deploy + divergent WARN
# ---------------------------------------------------------------------------
# RFC-008 P4d / Principle 12: the enforce-contract runtime config (taxonomy.json,
# bp-001/events/enforce-config.schema.json, plugins/_index.json) is ENFORCEMENT,
# not substrate — it now deploys PER-PROJECT under <project>/.claude/hooks/patterns/
# (co-located with the engine), NOT to the global $HOME/.episodic-memory/patterns/.
# T20a: an --install-enforcement install deploys patterns/taxonomy.json to the
# per-project root the classifier reads at runtime, byte-equal to the repo.
reset_state
run_installer --install-enforcement >/dev/null 2>&1
PROJ_TAX="$TEST_PROJECT/.claude/hooks/patterns/taxonomy.json"
[ -f "$PROJ_TAX" ] && r=true || r=false
assert_eq "T20a taxonomy.json deployed to per-project patterns dir (--install-enforcement)" "true" "$r"
if cmp -s "$REPO_ROOT/patterns/taxonomy.json" "$PROJ_TAX"; then r=true; else r=false; fi
assert_eq "T20b deployed taxonomy.json is byte-equal to repo" "true" "$r"

# T20b2: the contract set (bp-001/events/enforce-config.schema) + plugins/_index.json
# co-deploy per-project alongside taxonomy.
[ -f "$TEST_PROJECT/.claude/hooks/patterns/bp-001.json" ] && \
  [ -f "$TEST_PROJECT/.claude/hooks/patterns/events.json" ] && \
  [ -f "$TEST_PROJECT/.claude/hooks/patterns/enforce-config.schema.json" ] && \
  [ -f "$TEST_PROJECT/.claude/hooks/plugins/_index.json" ] && r=true || r=false
assert_eq "T20b3 contract set + plugins/_index.json co-deployed per-project" "true" "$r"

# T20b4: the global $HOME/.episodic-memory/patterns/ holds NO enforcement contract
# config — ONLY the substrate behavioral-pattern registry (_index.json) stays global.
[ -f "$TEST_HOME/.episodic-memory/patterns/taxonomy.json" ] && r=true || r=false
assert_eq "T20b4 taxonomy.json ABSENT from global patterns dir (per-project only)" "false" "$r"
[ -f "$TEST_HOME/.episodic-memory/patterns/bp-001.json" ] && r=true || r=false
assert_eq "T20b5 contract set ABSENT from global patterns dir (per-project only)" "false" "$r"
[ -f "$TEST_HOME/.episodic-memory/patterns/_index.json" ] && r=true || r=false
assert_eq "T20b6 substrate _index.json STILL deployed to global patterns dir (unchanged)" "true" "$r"

# T20a2 (PR-level codex BLOCKER regression): a NO-enforcement install must NOT
# deploy taxonomy anywhere — neither per-project nor global. Taxonomy is gated
# on --install-enforcement (it is enforcement config, not substrate).
reset_state
run_installer >/dev/null 2>&1
[ -f "$TEST_PROJECT/.claude/hooks/patterns/taxonomy.json" ] && r=true || r=false
assert_eq "T20a2 no-enforcement install does NOT deploy per-project taxonomy (coupling)" "false" "$r"
[ -f "$TEST_HOME/.episodic-memory/patterns/taxonomy.json" ] && r=true || r=false
assert_eq "T20a3 no-enforcement install does NOT deploy global taxonomy" "false" "$r"

# T20c: pre-P3c divergent classifier (no _ensure_taxonomy_synced helper) kept +
# taxonomy redeployed → WARN that the gate is NOT taxonomy-synced (codex R1-P1b).
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks/lib"
printf '#!/bin/bash\n# user-customized divergent classifier (pre-P3c, no helper)\n' \
  > "$TEST_PROJECT/.claude/hooks/lib/command-classifier.sh"
output=$(run_installer_capture --install-enforcement)
if echo "$output" | grep -q "pre-P3c"; then r=true; else r=false; fi
assert_eq "T20c pre-P3c divergent classifier emits 'not taxonomy-synced' WARN" "true" "$r"

# T20d: post-P3c divergent classifier (HAS the helper) kept + taxonomy redeployed
# → WARN that it will FAIL CLOSED on drift (the other split branch).
reset_state
mkdir -p "$TEST_PROJECT/.claude/hooks/lib"
printf '#!/bin/bash\n_ensure_taxonomy_synced() { :; }\n# divergent local edit, post-P3c\n' \
  > "$TEST_PROJECT/.claude/hooks/lib/command-classifier.sh"
output=$(run_installer_capture --install-enforcement)
if echo "$output" | grep -q "FAIL CLOSED"; then r=true; else r=false; fi
assert_eq "T20d post-P3c divergent classifier emits 'FAIL CLOSED' WARN" "true" "$r"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Passed: $passed"
echo "Failed: $failed"
[ $failed -eq 0 ]
