#!/usr/bin/env bash
set -e

# em-recall-sessionstart.sh — RFC-002 Phase 3b SessionStart hook
#
# Mechanically invokes em-recall at session start. The only effective side
# effect today is the marker activation: if bp-001 surfaces in pre-flight,
# em-recall.mjs:347-369 touches $CWD/.claude/.checkpoint-required, which
# arms checkpoint-gate.sh.
#
# Known limitation (#65, #61): em-recall stdout is redirected to /dev/null,
# so violation warnings do NOT surface to the AI yet. Spec line 220 calls
# for surfacing via SessionStart additionalContext JSON; the protocol work
# was deferred so the runtime gate could land first.
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
