#!/usr/bin/env bash
# RFC-009 P2 activation adapter — SessionStart hook (R4, P2-S5).
#
# Thin bash wrapper, byte-identical in shape to activation-prompt.sh /
# activation-tool.sh (§8.2 SYMMETRY — one shared runner, three thin
# registered entry points): drain stdin, exec the co-located Node runner
# with the event name, and ALWAYS exit 0 regardless of the runner's own
# exit code. A runner crash, a missing runner file, or a non-zero node exit
# all still yield exit 0 here with no output, never a decision/block/
# permissionDecision field.
#
# The runner's stderr is NOT discarded (mirrors activation-prompt.sh): the
# REQ-21 single fail-open note for a missing/malformed `session_start`
# section, and the REQ-13 lesson-suppress note, must both stay observable.
# Only stdout carries the additionalContext JSON the harness consumes.
INPUT="$(cat)"
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
RUNNER="$HOOK_DIR/activation-hook-run.mjs"
if [ -n "$HOOK_DIR" ] && [ -f "$RUNNER" ]; then
  printf '%s' "$INPUT" | node "$RUNNER" SessionStart || true
fi
exit 0
