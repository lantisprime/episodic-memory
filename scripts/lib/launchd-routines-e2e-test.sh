#!/usr/bin/env bash
# launchd-routines-e2e-test.sh — end-to-end test suite for the wrapper-fix.
# Covers 14 cases from the codex-approved R7 plan (...a48b ACCEPT).
#
# Assumes installer has already been run. Tests 4/5/6/7/8/12 invoke the
# wrapper directly (light side effects: candidate markdown under
# .claude/scratch/), tests 11/10 use launchctl on the installed jobs,
# test 13 exercises uninstall+reinstall.

set -u  # not -e: we want to count failures, not exit on first
PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()

PROJECT_DIR="/Users/charltond.ho/Developer/projects/episodic-memory"
SCHEDULED_TASKS_DIR="$HOME/.claude/scheduled-tasks"
WRAPPER="$SCHEDULED_TASKS_DIR/em-skill-wrapper.sh"
LA_DIR="$HOME/Library/LaunchAgents"
UID_GUI=$(id -u)
EXPECTED_CLAUDE="$(command -v claude)"

run_test() {
  local name="$1"; shift
  echo ""
  echo "===== $name ====="
  if "$@"; then
    PASS=$((PASS + 1))
    echo "  PASS: $name"
  else
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
    echo "  FAIL: $name"
  fi
}

skip_test() {
  local name="$1" reason="$2"
  echo ""
  echo "===== $name ====="
  echo "  SKIP: $reason"
  SKIP=$((SKIP + 1))
}

# ---------------- Test 1: dry-run, no persistent writes ----------------
test_1_dry_run() {
  bash "$PROJECT_DIR/install-launchd-routines.sh" --dry-run >/dev/null 2>&1 \
    || { echo "    dry-run exited non-zero"; return 1; }
  local p
  for p in com.charltonho.em-daily-mining com.charltonho.em-weekly-digest \
           com.charltonho.instruction-hygiene com.charltonho.em-backup-sync; do
    if [ -f "$LA_DIR/$p.plist.tmp" ]; then
      echo "    FAIL: leaked $LA_DIR/$p.plist.tmp"
      return 1
    fi
  done
  # Note: $WRAPPER was already rendered by the prior install; dry-run does
  # not overwrite it, so we don't assert "$WRAPPER absent" — that would fail
  # against the legitimate post-install state.
  return 0
}

# ---------------- Test 2: uninstall fail-open with stubbed binaries ----
test_2_uninstall_fail_open() {
  local stubdir=/tmp/em-test-stubs
  rm -rf "$stubdir" /tmp/em-test-stub-called-*
  mkdir -p "$stubdir"
  local b
  for b in node claude; do
    printf '#!/bin/bash\ntouch /tmp/em-test-stub-called-%s\nexit 1\n' "$b" > "$stubdir/$b"
    chmod +x "$stubdir/$b"
  done
  # Run uninstall on a freshly installed system; should succeed without
  # invoking the stub node/claude. /bin is required for launchctl.
  PATH="$stubdir:/bin:/usr/bin" bash "$PROJECT_DIR/install-launchd-routines.sh" --uninstall >/dev/null 2>&1 \
    || { echo "    uninstall exited non-zero"; return 1; }
  if compgen -G "/tmp/em-test-stub-called-*" >/dev/null; then
    echo "    FAIL: stub binaries were invoked during uninstall"
    return 1
  fi
  rm -rf "$stubdir" /tmp/em-test-stub-called-*
  # Re-install for subsequent tests.
  bash "$PROJECT_DIR/install-launchd-routines.sh" >/dev/null 2>&1 \
    || { echo "    re-install after uninstall failed"; return 1; }
  return 0
}

# ---------------- Test 3: install + content verification ---------------
test_3_install_content() {
  [ -f "$WRAPPER" ] || { echo "    wrapper missing"; return 1; }
  [ -x "$WRAPPER" ] || { echo "    wrapper not executable"; return 1; }
  if ! grep -qF "$EXPECTED_CLAUDE" "$WRAPPER"; then
    echo "    expected claude path not baked in: $EXPECTED_CLAUDE"
    return 1
  fi
  if grep -q '@CLAUDE_BIN@\|@PROJECT_DIR@' "$WRAPPER"; then
    echo "    unsubstituted placeholders in wrapper"
    return 1
  fi
  return 0
}

# ---------------- Test 4a: positive cwd-binding via stub Claude -------
# Codex impl-review P2 follow-up (...c30f): negative-only assertion isn't
# sufficient proof of cwd-binding. Renders a test wrapper with a stub claude
# that writes a sentinel file using `pwd`. Asserts the sentinel lands under
# PROJECT_DIR (proves `cd "@PROJECT_DIR@"` actually executed) AND that the
# caller cwd has no leak.
test_4a_positive_cwd_binding_stub() {
  local stub test_wrapper
  stub=$(mktemp)
  chmod +x "$stub"
  cat > "$stub" <<'STUB_EOF'
#!/bin/bash
pwd > /tmp/em-cwd-sentinel
STUB_EOF
  test_wrapper=$(mktemp)
  sed -e "s|@CLAUDE_BIN@|$stub|g" \
      -e "s|@PROJECT_DIR@|$PROJECT_DIR|g" \
      "$PROJECT_DIR/scripts/em-skill-wrapper.sh.tmpl" > "$test_wrapper"
  chmod +x "$test_wrapper"
  rm -f /tmp/em-cwd-sentinel
  rm -rf /tmp/.claude
  (cd /tmp && "$test_wrapper" episodic-memory-daily-mining >/dev/null 2>&1)
  rm -f "$stub" "$test_wrapper"
  if [ ! -f /tmp/em-cwd-sentinel ]; then
    echo "    stub claude was not invoked"
    return 1
  fi
  local recorded_pwd
  recorded_pwd=$(cat /tmp/em-cwd-sentinel)
  rm -f /tmp/em-cwd-sentinel
  if [ "$recorded_pwd" != "$PROJECT_DIR" ]; then
    echo "    cwd at claude-launch was '$recorded_pwd', expected '$PROJECT_DIR'"
    return 1
  fi
  if [ -d /tmp/.claude ]; then
    echo "    FAIL: /tmp/.claude leaked despite cd-binding"
    return 1
  fi
  return 0
}

# ---------------- Test 4: artifact-location, /tmp caller ---------------
# Verifies the cd "@PROJECT_DIR@" in the wrapper holds against a caller cwd
# in /tmp. We assert the negative (no .claude/scratch/ created under /tmp)
# rather than positive file existence, because the mining script itself may
# legitimately produce no candidate file (e.g. if today's transcripts can't
# be read). The wrapper-mechanism contract is "don't create artifacts in
# caller cwd"; whether the SKILL emits anything at all is the SKILL's
# concern, not the wrapper's.
test_4_artifact_location_tmp() {
  rm -rf /tmp/.claude
  (cd /tmp && "$WRAPPER" episodic-memory-daily-mining >/dev/null 2>&1) || {
    echo "    wrapper exited non-zero from /tmp"
    return 1
  }
  if [ -d /tmp/.claude/scratch ] || [ -d /tmp/.claude ]; then
    echo "    FAIL: /tmp/.claude exists (artifact leaked to caller cwd)"
    return 1
  fi
  return 0
}

# ---------------- Test 5: detached-worktree caller ---------------------
# Negative-only artifact-location check (same rationale as T4).
test_5_worktree_caller() {
  local wt_dir
  wt_dir=$(mktemp -d)
  rmdir "$wt_dir"
  trap "git -C \"$PROJECT_DIR\" worktree remove --force \"$wt_dir\" 2>/dev/null; rm -rf \"$wt_dir\"" RETURN
  git -C "$PROJECT_DIR" worktree add --detach "$wt_dir" HEAD >/dev/null 2>&1 || {
    echo "    worktree add failed"
    return 1
  }
  (cd "$wt_dir" && "$WRAPPER" episodic-memory-daily-mining >/dev/null 2>&1) || {
    echo "    wrapper exited non-zero from worktree"
    return 1
  }
  if [ -d "$wt_dir/.claude/scratch" ]; then
    echo "    FAIL: $wt_dir/.claude/scratch/ exists (artifact leaked to worktree)"
    return 1
  fi
  return 0
}

# ---------------- Test 6: HOME-elsewhere ------------------------------
test_6_home_elsewhere() {
  local fakehome=/tmp/em-fakehome
  rm -rf "$fakehome"
  mkdir -p "$fakehome"
  local out rc
  out=$(HOME="$fakehome" "$WRAPPER" episodic-memory-daily-mining 2>&1)
  rc=$?
  rm -rf "$fakehome"
  [ "$rc" = "3" ] || { echo "    exit code $rc, expected 3"; echo "$out"; return 1; }
  if ! printf '%s' "$out" | grep -qF "SKILL.md not found"; then
    echo "    stderr did not contain 'SKILL.md not found'"
    echo "$out"
    return 1
  fi
  return 0
}

# ---------------- Test 7: PATH-poison (binary pinning) ----------------
test_7_path_poison() {
  local bogus=/tmp/bogus-bin
  rm -rf "$bogus"
  mkdir -p "$bogus"
  printf '#!/bin/bash\necho WRONG-BINARY\nexit 0\n' > "$bogus/claude"
  chmod +x "$bogus/claude"
  local out
  out=$(PATH="$bogus:$PATH" "$WRAPPER" episodic-memory-daily-mining 2>&1) || {
    # Wrapper exits non-zero only if the real claude fails; we just check
    # the stub was NOT invoked.
    :
  }
  rm -rf "$bogus"
  if printf '%s' "$out" | grep -qF "WRONG-BINARY"; then
    echo "    FAIL: stub claude was invoked (output contained WRONG-BINARY)"
    return 1
  fi
  return 0
}

# ---------------- Test 8: stub-Claude argv contract -------------------
test_8_stub_argv() {
  local stub test_wrapper sentinel
  stub=$(mktemp)
  chmod +x "$stub"
  cat > "$stub" <<'STUB_EOF'
#!/bin/bash
{
  printf 'argc=%d\n' "$#"
  for i in $(seq 1 "$#"); do
    eval "printf 'argv%d=%s\\n' $i \"\${$i}\""
  done
} > /tmp/em-argv-sentinel
STUB_EOF
  test_wrapper=$(mktemp)
  sed -e "s|@CLAUDE_BIN@|$stub|g" \
      -e "s|@PROJECT_DIR@|$PROJECT_DIR|g" \
      "$PROJECT_DIR/scripts/em-skill-wrapper.sh.tmpl" > "$test_wrapper"
  chmod +x "$test_wrapper"
  sentinel=/tmp/em-argv-sentinel
  rm -f "$sentinel"
  "$test_wrapper" episodic-memory-daily-mining >/dev/null 2>&1
  if [ ! -f "$sentinel" ]; then
    echo "    sentinel file not created by stub"
    rm -f "$stub" "$test_wrapper"
    return 1
  fi
  local argc argv8_head
  # 9 args now: -p, --permission-mode, bypassPermissions, --setting-sources,
  # project,local, --settings, {"hooks":{}}, --, <prompt>
  argc=$(grep '^argc=' "$sentinel" | sed 's/argc=//')
  local argv8_val argv9_head
  argv8_val=$(grep '^argv8=' "$sentinel" | sed 's/argv8=//')
  argv9_head=$(grep '^argv9=' "$sentinel" | head -c 12)
  rm -f "$stub" "$test_wrapper" "$sentinel"
  [ "$argc" = "9" ] || { echo "    argc=$argc, expected 9"; return 1; }
  [ "$argv8_val" = "--" ] || { echo "    argv8=$argv8_val, expected --"; return 1; }
  case "$argv9_head" in
    "argv9=---"*) ;;
    *) echo "    argv9 head was '$argv9_head', expected to start with 'argv9=---'"; return 1 ;;
  esac
  return 0
}

# ---------------- Test 9: validation-lib unit test (delegate) ---------
test_9_validation_unit() {
  bash "$PROJECT_DIR/scripts/lib/render-input-validation-test.sh" >/dev/null
}

# ---------------- Test 10: launchctl print all 3 wrapped ----------------
test_10_launchctl_print() {
  local label out
  for label in com.charltonho.em-daily-mining com.charltonho.em-weekly-digest com.charltonho.instruction-hygiene; do
    out=$(launchctl print "gui/$UID_GUI/$label" 2>&1) || {
      echo "    launchctl print failed for $label"
      return 1
    }
    if ! printf '%s' "$out" | grep -qF "em-skill-wrapper.sh"; then
      echo "    $label loaded-state argv missing wrapper"
      return 1
    fi
    if ! printf '%s' "$out" | grep -q "CLAUDE_SCHEDULED_TASK"; then
      echo "    $label loaded-state env missing CLAUDE_SCHEDULED_TASK"
      return 1
    fi
  done
  return 0
}

# ---------------- Test 11: kickstart smoke, daily-mining only ----------
# Verifies the launchd-mediated path. The "Unknown command" failure mode
# was the original bug; we assert it's gone. We do NOT require the SKILL
# to fully succeed (it may emit candidates=0 today due to root-owned
# transcript files — separate bug, not in scope for this fix), only that
# the wrapper-mechanism reaches claude execution.
test_11_kickstart_daily() {
  local logfile="$HOME/Library/Logs/episodic-memory/em-daily-mining.log"
  : > "$logfile"
  launchctl kickstart -k "gui/$UID_GUI/com.charltonho.em-daily-mining" >/dev/null 2>&1
  # Wait for completion signal: either "Unknown command" (FAIL), or claude
  # exits and writes a final newline / claude-shaped output, or 180s timeout.
  local i=0
  while [ "$i" -lt 180 ]; do
    # If the original failure signature appears, bail early.
    if grep -qF "Unknown command" "$logfile" 2>/dev/null; then
      break
    fi
    # If the log has non-trivial content AND no further bytes for 5s, run
    # has likely completed. Simpler: check if launchctl job is still active.
    if ! launchctl print "gui/$UID_GUI/com.charltonho.em-daily-mining" 2>/dev/null \
         | grep -q 'state = running'; then
      # Not in 'running' state — and we kicked it. So it ran and exited.
      if [ "$i" -gt 2 ]; then  # debounce: give launchctl a moment to register
        break
      fi
    fi
    sleep 1
    i=$((i + 1))
  done
  if grep -qF "Unknown command" "$logfile"; then
    echo "    FAIL: 'Unknown command' in log after wrapper-fix"
    tail -10 "$logfile"
    return 1
  fi
  # Job must have produced SOME output (proves wrapper reached claude).
  if [ ! -s "$logfile" ]; then
    echo "    FAIL: log empty after kickstart (wrapper never reached claude)"
    return 1
  fi
  return 0
}

# ---------------- Test 12: nested-cwd from <project>/scripts ------------
# Negative-only artifact-location check (same rationale as T4/T5).
test_12_nested_cwd() {
  rm -rf "$PROJECT_DIR/scripts/.claude"
  (cd "$PROJECT_DIR/scripts" && "$WRAPPER" episodic-memory-daily-mining >/dev/null 2>&1) || {
    echo "    wrapper exited non-zero from nested cwd"
    return 1
  }
  if [ -d "$PROJECT_DIR/scripts/.claude" ]; then
    echo "    FAIL: $PROJECT_DIR/scripts/.claude exists (artifact leaked to nested cwd)"
    return 1
  fi
  return 0
}

# ---------------- Test 13: rollback ------------------------------------
test_13_rollback() {
  bash "$PROJECT_DIR/install-launchd-routines.sh" --uninstall >/dev/null 2>&1 \
    || { echo "    uninstall exited non-zero"; return 1; }
  [ ! -f "$WRAPPER" ] || { echo "    wrapper survived uninstall"; return 1; }
  local p
  for p in com.charltonho.em-daily-mining com.charltonho.em-weekly-digest \
           com.charltonho.instruction-hygiene com.charltonho.em-backup-sync; do
    if launchctl print "gui/$UID_GUI/$p" >/dev/null 2>&1; then
      echo "    $p still loaded after uninstall"
      return 1
    fi
    if [ -f "$LA_DIR/$p.plist" ]; then
      echo "    $LA_DIR/$p.plist survived uninstall"
      return 1
    fi
  done
  [ -f "$PROJECT_DIR/scripts/em-skill-wrapper.sh.tmpl" ] || {
    echo "    repo template was removed (should be untouched)"
    return 1
  }
  # Re-install so we leave the system in working state.
  bash "$PROJECT_DIR/install-launchd-routines.sh" >/dev/null 2>&1 \
    || { echo "    re-install after rollback failed"; return 1; }
  return 0
}

# ---------------- Test 14: plist content verification ------------------
test_14_plist_content() {
  local line label skill exp_hour exp_min exp_wd plist arg1 wd sop
  # Format: label:skill:Hour:Minute:Weekday (Weekday empty = daily)
  for line in \
      "com.charltonho.em-daily-mining:episodic-memory-daily-mining:19:30:" \
      "com.charltonho.em-weekly-digest:episodic-memory-weekly-digest:9:0:0" \
      "com.charltonho.instruction-hygiene:instruction-hygiene-maintenance:11:0:0"; do
    IFS=: read -r label skill exp_hour exp_min exp_wd <<< "$line"
    plist="$LA_DIR/$label.plist"
    [ -f "$plist" ] || { echo "    $plist missing"; return 1; }
    # ProgramArguments exact indices
    [ "$(plutil -extract ProgramArguments.0 raw -o - "$plist")" = "/bin/bash" ] \
      || { echo "    $label argv[0] != /bin/bash"; return 1; }
    arg1=$(plutil -extract ProgramArguments.1 raw -o - "$plist")
    case "$arg1" in
      *"em-skill-wrapper.sh") ;;
      *) echo "    $label argv[1] = $arg1, expected to end with em-skill-wrapper.sh"; return 1 ;;
    esac
    [ "$(plutil -extract ProgramArguments.2 raw -o - "$plist")" = "$skill" ] \
      || { echo "    $label argv[2] != $skill"; return 1; }
    if plutil -extract ProgramArguments.3 raw -o - "$plist" >/dev/null 2>&1; then
      echo "    $label has unexpected ProgramArguments.3"
      return 1
    fi
    # Env
    [ "$(plutil -extract EnvironmentVariables.CLAUDE_SCHEDULED_TASK raw -o - "$plist")" = "1" ] \
      || { echo "    $label CLAUDE_SCHEDULED_TASK != 1"; return 1; }
    plutil -extract EnvironmentVariables.HOME raw -o - "$plist" >/dev/null \
      || { echo "    $label missing HOME env"; return 1; }
    plutil -extract EnvironmentVariables.PATH raw -o - "$plist" >/dev/null \
      || { echo "    $label missing PATH env"; return 1; }
    # WorkingDirectory
    wd=$(plutil -extract WorkingDirectory raw -o - "$plist")
    [ "$wd" = "$PROJECT_DIR" ] || { echo "    $label WD=$wd != $PROJECT_DIR"; return 1; }
    # Schedule
    [ "$(plutil -extract StartCalendarInterval.Hour raw -o - "$plist")" = "$exp_hour" ] \
      || { echo "    $label Hour mismatch"; return 1; }
    [ "$(plutil -extract StartCalendarInterval.Minute raw -o - "$plist")" = "$exp_min" ] \
      || { echo "    $label Minute mismatch"; return 1; }
    if [ -n "$exp_wd" ]; then
      [ "$(plutil -extract StartCalendarInterval.Weekday raw -o - "$plist")" = "$exp_wd" ] \
        || { echo "    $label Weekday mismatch"; return 1; }
    else
      if plutil -extract StartCalendarInterval.Weekday raw -o - "$plist" >/dev/null 2>&1; then
        echo "    $label has unexpected Weekday key"
        return 1
      fi
    fi
    # Log path
    sop=$(plutil -extract StandardOutPath raw -o - "$plist")
    case "$sop" in
      "$HOME/Library/Logs/episodic-memory/"*) ;;
      *) echo "    $label log path: $sop"; return 1 ;;
    esac
  done
  return 0
}

# ---------------- Run all -----------------
run_test "T1  dry-run / no persistent writes"           test_1_dry_run
run_test "T2  uninstall fail-open w/ stubbed bins"      test_2_uninstall_fail_open
run_test "T3  install + wrapper content"                test_3_install_content
run_test "T4a positive cwd-binding via stub Claude"     test_4a_positive_cwd_binding_stub
run_test "T4  artifact-location, /tmp caller"           test_4_artifact_location_tmp
run_test "T5  detached-worktree caller"                 test_5_worktree_caller
run_test "T6  HOME-elsewhere"                           test_6_home_elsewhere
run_test "T7  PATH-poison (binary pinning)"             test_7_path_poison
run_test "T8  stub-Claude argv contract"                test_8_stub_argv
run_test "T9  validation-lib unit"                      test_9_validation_unit
run_test "T10 launchctl print all 3 wrapped"            test_10_launchctl_print
run_test "T11 kickstart smoke, daily-mining"            test_11_kickstart_daily
run_test "T12 nested-cwd from <project>/scripts"        test_12_nested_cwd
run_test "T13 rollback (uninstall+reinstall)"           test_13_rollback
run_test "T14 plist content verification (3 plists)"    test_14_plist_content

echo ""
echo "=================================================="
echo "Results: $PASS pass / $FAIL fail / $SKIP skip"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - $t"
  done
  exit 1
fi
echo "All tests passed."
