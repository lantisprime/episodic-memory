#!/bin/bash
# install-launchd-routines.sh — single-action bootstrap for episodic-memory
# scheduled tasks. User-run trust boundary (sidesteps Claude auto-mode classifier).
#
# Writes 4 LaunchAgent plists, lints with plutil, bootstraps via launchctl,
# kickstarts a smoke run for the daily-mining job, tails its log briefly.
#
# Usage:
#   bash install-launchd-routines.sh --dry-run        # preview, no writes
#   bash install-launchd-routines.sh                  # install (no smoke)
#   bash install-launchd-routines.sh --smoke          # install + kickstart daily-mining
#   bash install-launchd-routines.sh --uninstall      # bootout + delete plists
#
# Reversible: --uninstall undoes everything this script created.

set -e

DRY_RUN=0
SMOKE=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --smoke) SMOKE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

UID_GUI=$(id -u)
LA_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/episodic-memory"
PROJECT_DIR="$HOME/Developer/projects/episodic-memory"
SCHEDULED_TASKS_DIR="$HOME/.claude/scheduled-tasks"

# Pin absolute binaries at install time (round-3 fix: don't rely on PATH lookup at runtime)
NODE_BIN=$(command -v node)
GH_BIN=$(command -v gh)
CLAUDE_BIN=$(command -v claude)

if [ -z "$NODE_BIN" ] || [ -z "$CLAUDE_BIN" ]; then
  echo "ERROR: node and claude must be on PATH at install time. Found: node=$NODE_BIN claude=$CLAUDE_BIN" >&2
  exit 3
fi

# Plist labels
LABELS=(
  "com.charltonho.em-daily-mining"
  "com.charltonho.em-weekly-digest"
  "com.charltonho.instruction-hygiene"
  "com.charltonho.em-backup-sync"
)

if [ "$UNINSTALL" -eq 1 ]; then
  echo "=== Uninstalling ==="
  for label in "${LABELS[@]}"; do
    plist="$LA_DIR/$label.plist"
    if launchctl print "gui/$UID_GUI/$label" >/dev/null 2>&1; then
      [ "$DRY_RUN" -eq 1 ] && echo "[dry-run] launchctl bootout gui/$UID_GUI $plist" \
                          || launchctl bootout "gui/$UID_GUI" "$plist" || true
    fi
    if [ -f "$plist" ]; then
      [ "$DRY_RUN" -eq 1 ] && echo "[dry-run] rm $plist" \
                          || rm -f "$plist"
    fi
    echo "  - $label removed"
  done
  echo "Uninstall complete. Logs preserved in $LOG_DIR."
  exit 0
fi

echo "=== Pre-flight ==="
echo "  UID:           $UID_GUI"
echo "  LaunchAgents:  $LA_DIR"
echo "  Logs:          $LOG_DIR"
echo "  Project:       $PROJECT_DIR"
echo "  node:          $NODE_BIN"
echo "  gh:            ${GH_BIN:-not found (weekly-digest depends on this)}"
echo "  claude:        $CLAUDE_BIN"

# Verify scheduled-task SKILL.md files exist
for skill in episodic-memory-daily-mining episodic-memory-weekly-digest instruction-hygiene-maintenance; do
  if [ ! -f "$SCHEDULED_TASKS_DIR/$skill/SKILL.md" ]; then
    echo "ERROR: missing $SCHEDULED_TASKS_DIR/$skill/SKILL.md" >&2
    exit 4
  fi
done

# Verify wrapper exists for em-backup-sync
if [ ! -x "$SCHEDULED_TASKS_DIR/em-backup-sync-wrapper.sh" ]; then
  echo "ERROR: missing or non-executable $SCHEDULED_TASKS_DIR/em-backup-sync-wrapper.sh" >&2
  exit 4
fi

# Verify em-lock.mjs is in place (round-3 FU-2)
if [ ! -f "$PROJECT_DIR/scripts/em-lock.mjs" ]; then
  echo "ERROR: missing $PROJECT_DIR/scripts/em-lock.mjs (needed by auto-promote and backup-sync wrapper)" >&2
  exit 4
fi

mkdir -p "$LOG_DIR"

# Per-plist invocation builders --------------------------------------------------

claude_skill_invocation() {
  # $1 = skill name (e.g. episodic-memory-daily-mining)
  cat <<EOF
        <string>$CLAUDE_BIN</string>
        <string>-p</string>
        <string>--permission-mode</string>
        <string>bypassPermissions</string>
        <string>--setting-sources</string>
        <string>project,local</string>
        <string>--settings</string>
        <string>{"hooks":{}}</string>
        <string>/$1</string>
EOF
}

backup_invocation() {
  cat <<EOF
        <string>/bin/bash</string>
        <string>$SCHEDULED_TASKS_DIR/em-backup-sync-wrapper.sh</string>
EOF
}

write_plist() {
  # $1 = label, $2 = invocation block, $3 = StartCalendarInterval block, $4 = log basename
  local label="$1"
  local invocation="$2"
  local schedule="$3"
  local logname="$4"
  local plist="$LA_DIR/$label.plist"

  cat > "$plist.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
$invocation
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
$schedule
    <key>StandardOutPath</key>
    <string>$LOG_DIR/$logname.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/$logname.log</string>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
EOF

  # Lint
  if ! plutil -lint "$plist.tmp" >/dev/null; then
    echo "ERROR: plist lint failed for $label" >&2
    rm -f "$plist.tmp"
    exit 5
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] would write $plist:"
    sed 's/^/    /' "$plist.tmp"
    rm -f "$plist.tmp"
    return
  fi

  mv "$plist.tmp" "$plist"
  echo "  ✓ wrote $plist"
}

# Schedule blocks -------------------------------------------------------------

DAILY_19_30='    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>19</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>'

SUNDAY_09_00='    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>'

SUNDAY_11_00='    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>11</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>'

DAILY_23_00='    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>23</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>'

# Write plists ---------------------------------------------------------------

echo ""
echo "=== Writing plists ==="
write_plist com.charltonho.em-daily-mining "$(claude_skill_invocation episodic-memory-daily-mining)" "$DAILY_19_30" em-daily-mining
write_plist com.charltonho.em-weekly-digest "$(claude_skill_invocation episodic-memory-weekly-digest)" "$SUNDAY_09_00" em-weekly-digest
write_plist com.charltonho.instruction-hygiene "$(claude_skill_invocation instruction-hygiene-maintenance)" "$SUNDAY_11_00" instruction-hygiene
write_plist com.charltonho.em-backup-sync "$(backup_invocation)" "$DAILY_23_00" em-backup-sync

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "[dry-run complete] Re-run without --dry-run to install."
  exit 0
fi

# Bootstrap -----------------------------------------------------------------

echo ""
echo "=== Bootstrapping ==="
for label in "${LABELS[@]}"; do
  plist="$LA_DIR/$label.plist"
  # bootout existing instance if present (idempotent re-install)
  if launchctl print "gui/$UID_GUI/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID_GUI" "$plist" 2>/dev/null || true
  fi
  if launchctl bootstrap "gui/$UID_GUI" "$plist"; then
    echo "  ✓ bootstrap $label"
  else
    echo "  ✗ bootstrap $label FAILED" >&2
    exit 6
  fi
done

# Verify
echo ""
echo "=== Verification ==="
for label in "${LABELS[@]}"; do
  if launchctl print "gui/$UID_GUI/$label" >/dev/null 2>&1; then
    echo "  ✓ $label loaded"
  else
    echo "  ✗ $label NOT loaded" >&2
    exit 7
  fi
done

# Smoke test (optional)
if [ "$SMOKE" -eq 1 ]; then
  echo ""
  echo "=== Smoke: kickstart em-daily-mining ==="
  launchctl kickstart -kp "gui/$UID_GUI/com.charltonho.em-daily-mining"
  echo "Waiting 30s for output..."
  sleep 30
  echo ""
  echo "Last 30 lines of $LOG_DIR/em-daily-mining.log:"
  tail -30 "$LOG_DIR/em-daily-mining.log" 2>/dev/null || echo "(no log content yet)"
fi

echo ""
echo "=== Install complete ==="
echo "Logs:        $LOG_DIR/"
echo "Uninstall:   bash $0 --uninstall"
echo ""
echo "FU items to verify post-install:"
echo "  - Phase 0a: gh auth status (you should already have run 'gh auth login')"
echo "  - Phase 0b: hook-bypass + skill resolution under launchd env"
echo "  - Phase 0d: em-backup git push under launchd env"
echo "  - Phase 0d': gh auth status under launchd env"
echo "Manual probe commands are in the v3 plan episode 20260510-080404-codex-review-request-round-3-surgical-cl-40bb"
