#!/usr/bin/env bash
# RFC-009 P2 activation adapter — PreToolUse hook (R3, P2-S4).
#
# Thin bash wrapper mirroring em-recall-sessionstart.sh's bash-orchestrates /
# co-located-.mjs-does-the-work split: drain stdin, exec the co-located Node
# runner with the event name, and ALWAYS exit 0. The advisory invariant is a
# property of THIS wrapper too, not just the runner (§8.2 SYMMETRY) — a
# runner crash, a missing runner file, or a non-zero node exit all still
# yield exit 0 here with no output, never a decision/block/permissionDecision
# field. Never blocks a tool call on any branch.
#
# The runner's stderr is NOT discarded (codex F2b): the spec-required single
# fail-open note for a malformed lesson-suppress.json must be observable. Only
# stdout carries the additionalContext JSON the harness consumes; the runner
# writes its note to stderr, so leaving stderr alone keeps stdout clean while
# surfacing the note. `|| true` still forces exit 0 regardless of node's exit.
INPUT="$(cat)"
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
RUNNER="$HOOK_DIR/activation-hook-run.mjs"
if [ -n "$HOOK_DIR" ] && [ -f "$RUNNER" ]; then
  printf '%s' "$INPUT" | node "$RUNNER" PreToolUse || true
fi
exit 0
