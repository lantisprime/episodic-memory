#!/usr/bin/env bash
set -e

# bp1-sweep-on-session.sh — RFC-004 H2 SessionStart hook (PR-1b-B / M0 part 2).
#
# Best-effort liveness for T1 (Path A request-issued timeout) and T1b (Path B
# naked-entry recovery) when `mcp__scheduled-tasks` is unavailable. Calls the
# unified fallback `bp1-deadline-sweep.mjs --once` per Claude session start.
#
# Activation gate (RFC §178 silent-refusal contract):
#   - Calls bp1-flag-check.mjs FIRST. On refusal, exits 0 SILENTLY — no stdout,
#     no stderr, no episode emission. Distinct from `--once` which DOES emit a
#     `bp1-disabled-sweep` evidence episode (RFC §191) — H2 must NOT replicate
#     that emission, so flag-check is checked separately here before invoking
#     the sweep.
#
# cwd-binding (discipline #20, mirrors hooks/em-recall-sessionstart.sh:34-54):
#   - Reads SessionStart stdin JSON, parses `.cwd` field, falls back to `pwd`.
#   - cd "$CWD" BEFORE any node invocation. cd-fail → exit 0 silently.
#   - Passes `--project "$CWD"` explicitly to BOTH subprocesses; does NOT rely
#     on subprocess `process.cwd()` defaulting.
#
# Script resolution (RFC-008 P4d / Principle 12 — relocated per-project 2026-06-19;
# was codex code-review A1, 2026-05-07):
#   bp1 scripts install CO-LOCATED with this hook under <project>/.claude/hooks/
#   (the BP-1 behavior pattern is per-project, never in the global substrate).
#   They are resolved via $HOOK_DIR (this script's own dir, BASH_SOURCE-derived),
#   NOT via $CWD/scripts and NOT via the global $HOME/.episodic-memory/scripts/.
#
# Idempotent: re-firing on the same project is harmless. Sweep is stateless.

INPUT="$(cat)"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

# If $CWD is invalid (nonexistent / unreadable / permission-denied), fail soft.
# Mirrors em-recall-sessionstart.sh:51 — never fall back to the hook process's
# inherited cwd; that could route bp1 artifacts to an unrelated project.
if ! cd "$CWD" 2>/dev/null; then
  exit 0
fi

# RFC-008 P4d / Principle 12: bp1 scripts install CO-LOCATED with this hook under
# <project>/.claude/hooks/, NOT in the global substrate. BASH_SOURCE is absolute
# (Claude Code registers hooks by absolute path), so this is cd-safe.
EM_SCRIPTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# Co-located install (P4d) first; legacy global fallback if the bp1 scripts are
# not beside this hook (fresh installs co-locate; the fallback is inert there).
[ -f "$EM_SCRIPTS_DIR/bp1-flag-check.mjs" ] || EM_SCRIPTS_DIR="$HOME/.episodic-memory/scripts"
FLAG_CHECK="$EM_SCRIPTS_DIR/bp1-flag-check.mjs"
SWEEP="$EM_SCRIPTS_DIR/bp1-deadline-sweep.mjs"

# Soft-fail if bp1 scripts aren't installed globally yet (project never ran
# install.mjs --tool claude-code, or running in a stale activation state).
if [ ! -f "$FLAG_CHECK" ] || [ ! -f "$SWEEP" ]; then
  exit 0
fi

# Activation gate first. Silent on refusal per §178.
#   --no-emit: H2 fires on EVERY Claude session start; default flag-check
#   audit-emits a bp1-flag-check episode per call. Suppress here to:
#     (1) preserve the §178 "no episodes on refusal" contract literally;
#     (2) avoid filling .episodic-memory/episodes/ with one
#         bp1-flag-check episode per session for inactive projects.
#   The sweep itself emits its own bp1-sweep-tick / bp1-disabled-sweep
#   episode for the audit trail when active or refused-via-sweep.
if ! node "$FLAG_CHECK" --project "$CWD" --no-emit >/dev/null 2>&1; then
  exit 0
fi

# Project is active and capability == fallback (M0: probe stub always returns
# fallback). Run the sweep. The sweep itself is activation-gated AND emits its
# own bp1-sweep-tick evidence episode under the project root.
node "$SWEEP" --once --project "$CWD" >/dev/null 2>&1 || true

exit 0
