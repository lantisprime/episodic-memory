#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-08.1
# stop-gate.sh — Stop / SubagentStop hook for bp-001 wrap-up enforcement.
#
# Closes shape-4 docs-only-summarize-as-done hole (issue #128). When the
# bp-001 checkpoint marker is armed AND the post-implementation checkpoint
# block has not been written, blocks Claude's turn-end so the user must
# complete step 8/9 before the cycle is "done."
#
# Architecture (RFC-003 Phase 3b primitive; Phase 2 will subsume into
# adapters/claude-code/capabilities/enforcement.mjs — see RFC-003
# §Considerations — #128 stop-gate alignment):
#   - Decision logic lives in the enforcement layer:
#     `node enforce-contract.mjs --gate stop` (RFC-008 P3b-1 — relocated from
#     the substrate's `em-recall.mjs --gate stop`, byte-identical; em-recall's
#     --gate handler is deleted in P3d).
#   - This shell script is a thin runtime adapter:
#     1. Reads stdin (Claude Code hook input JSON).
#     2. Honors `stop_hook_active` early-exit (mandatory infinite-loop
#        guard per knowledge_base/claude-code-hooks-guide.md:421-431).
#     3. Invokes core decision script.
#     4. Passes core's JSON through, or emits fail-loud envelope on script
#        absence / non-zero exit.
#
# Registered on both Stop AND SubagentStop events (see install.mjs hookSpecs).
# SubagentStop is the conversion of Stop for subagent contexts per
# claude-code-hooks-reference.md:409.
#
# Note: multiple Stop hooks with `decision: block` are OR-combined (any
# blocker wins) — no ordering dependency vs other registered Stop hooks.

INPUT="$(cat)"

# stop_hook_active short-circuit (BEFORE any node spawn — keeps the recursive
# Stop fire-and-exit path cheap, no node startup cost).
#
# Fail-soft on malformed JSON: if jq can't parse INPUT, treat stop_hook_active
# as false and let the gate proceed. set -e would otherwise propagate jq's
# non-zero exit code and crash the hook on garbage input (Layer 3 negative
# scenario).
STOP_HOOK_ACTIVE="$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Parse .cwd from hook input. The hook PROCESS cwd is whatever Claude Code
# launched the hook from — NOT necessarily the project. Codex round-1 caught
# this bypass: without honoring input .cwd, em-recall's resolveRepoRoot at
# module load resolves from /private/tmp (or wherever) instead of the
# project, silently allowing Stop on an armed project.
#
# Same pattern as em-recall-sessionstart.sh:27-28 + checkpoint-gate.sh:43-44 +
# plan-gate.sh:27-28: parse .cwd, fall back to pwd if missing.
CWD="$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")"
[ -z "$CWD" ] && CWD="$(pwd)"

# Resolve enforce-contract.mjs at canonical global install path. The hook does
# not attempt to use the in-repo script — production hooks invoke globally
# installed copies, which is what install.mjs --install-hooks deploys.
#
# RFC-008 P3b-1: the stop decision moved OUT of the memory substrate
# (em-recall.mjs --gate stop) INTO the enforcement layer (enforce-contract.mjs),
# byte-identical. CLASS-C(c): this loud-fail-if-missing is PRESERVED on the
# repoint — a missing/erroring binary MUST block loud, never degrade to
# allow-always.
ENFORCE="$HOME/.episodic-memory/scripts/enforce-contract.mjs"
if [ ! -f "$ENFORCE" ]; then
  echo '{"decision": "block", "reason": "stop-gate.sh: enforce-contract.mjs not found at canonical global path. Re-run install.mjs."}'
  exit 0
fi

# Invalid .cwd guard: if CWD doesn't exist or isn't readable, fail-soft (no
# decision). Mirrors em-recall-sessionstart.sh:43-45 + #70 wrong-project
# class (don't run em-recall in whatever cwd the hook process inherited).
# Fail-soft because Stop's "no decision" = allow, which is the conservative
# default when we can't be sure which project's marker to read.
if ! cd "$CWD" 2>/dev/null; then
  exit 0
fi

# Rank-2: parse stdin .session_id and pass --session-id to em-recall so
# the stop-gate carve-out can resolve own-session quartet markers. Without
# this plumbing, the carve-out falls back to legacy-literal-only mode
# (graceful degrade per em-recall codex R2 Q3 — pre-rank-2 behavior
# preserved for old hook installs).
#
# Validation: em-recall.mjs does the format check + warn-on-invalid. We
# do a basic empty/non-empty check here to avoid spamming with empty values.
MY_SID="$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")"

# Invoke core decision logic. Capture stdout; fail-loud envelope on error.
# Repo-root resolution in enforce-contract.mjs (resolveRepoRoot module-load) now
# resolves from the cwd we just cd'd to — i.e., the project the hook input
# named, not the hook process's inherited cwd.
if [ -n "$MY_SID" ]; then
  DECISION="$(node "$ENFORCE" --gate stop --session-id "$MY_SID" 2>/dev/null)" || {
    echo '{"decision": "block", "reason": "stop-gate.sh: enforce-contract --gate stop exited non-zero. Re-run install.mjs --install-hooks."}'
    exit 0
  }
else
  DECISION="$(node "$ENFORCE" --gate stop 2>/dev/null)" || {
    echo '{"decision": "block", "reason": "stop-gate.sh: enforce-contract --gate stop exited non-zero. Re-run install.mjs --install-hooks."}'
    exit 0
  }
fi

# Pass core's JSON through verbatim. Empty stdout = no decision = allow.
if [ -n "$DECISION" ]; then
  echo "$DECISION"
fi
exit 0
