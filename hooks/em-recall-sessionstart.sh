#!/usr/bin/env bash
set -e

# em-recall-sessionstart.sh — RFC-002 Phase 3b SessionStart hook
#
# Mechanically invokes em-recall at session start. The effective side effect
# is the marker activation: em-recall.mjs's shouldArmBp001Checkpoint
# predicate runs unconditionally on session start (decoupled from
# --task-type), and arms $CWD/.claude/.checkpoint-required whenever a recent
# bp-001-implementation-workflow violation exists, which in turn arms
# checkpoint-gate.sh.
#
# Known limitation (#61): em-recall stdout is redirected to /dev/null, so
# violation warnings do NOT surface to the AI yet. Spec line 220 calls for
# surfacing via SessionStart additionalContext JSON; the protocol work is
# tracked under #61.
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

# If $CWD is invalid (nonexistent / unreadable), fail soft instead of running
# em-recall in whatever directory the hook process inherited from. Per #70:
# without this guard, em-recall.mjs:347-369 could touch .checkpoint-required
# in an unrelated project, causing checkpoint-gate.sh to fire spuriously
# in the next session of that wrong project.
if ! cd "$CWD" 2>/dev/null; then
  exit 0
fi
node "$EM_RECALL" --limit 5 >/dev/null 2>&1 || true

exit 0
