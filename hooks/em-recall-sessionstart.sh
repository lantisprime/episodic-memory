#!/usr/bin/env bash
set -e

# em-recall-sessionstart.sh — RFC-002 Phase 3b SessionStart hook
#
# Mechanically invokes em-recall at session start so its pre-flight pass runs
# before any user interaction. Two side effects matter:
#   1. Violation warnings surface to the AI at session start (preflight_warnings)
#   2. If bp-001 surfaces, em-recall.mjs:347-369 touches
#      $CWD/.claude/.checkpoint-required, which arms checkpoint-gate.sh.
#
# Per Codex review: parse cwd from stdin, cd to it, then run em-recall with
# no project arg so cwd/git inference owns project resolution. This keeps
# em-recall's marker root and checkpoint-gate.sh's marker root aligned.
#
# Idempotent: em-recall.mjs:364 only writes the marker if it doesn't already
# exist, so re-runs (multiple SessionStart firings, --resume, etc.) won't
# clobber state.

INPUT="$(cat)"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

EM_RECALL="$HOME/.episodic-memory/scripts/em-recall.mjs"

# Soft-fail if em-recall isn't installed — sessions without episodic-memory
# should still start cleanly.
if [ ! -f "$EM_RECALL" ]; then
  exit 0
fi

cd "$CWD" 2>/dev/null || true
node "$EM_RECALL" --limit 5 >/dev/null 2>&1 || true

exit 0
