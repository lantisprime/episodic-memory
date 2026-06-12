#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-12.rank10-slice
# session-handoff-prompt.sh — SessionStart hook: two-phase blocking directive
# with always-tier discipline load (rank-10 slice, codex consensus r1-r5).
#
# v2 changes vs prior installed runtime (per rank-10 plan v5):
#   - Parses stdin.cwd (never inherited process cwd) for canonical resolution.
#     Empirically: codex r3 reproduced inherited-cwd bug from /private/tmp.
#   - Resolves repo_root via git common-dir, normalizing linked-worktree → MAIN.
#   - Resolves memory_root with BOUNDED candidate set (sanitization variants of
#     resolved repo_root ONLY — no ~/.claude/projects/* scan; codex F9).
#   - Emits explicit absolute paths for the always-tier discipline files
#     (codex F11; replaces "batch-Read the feedback files under MEMORY.md's …
#     anchors" prose which loaded 34+ files / ~47k tokens / ~10% of context).
#   - Emits mechanical `cd <repo_root> && node <repo_root>/scripts/em-search.mjs …`
#     for lessons (codex F11; cwd bound at command-string level, not prose).
#   - Fail-safe (codex F13): missing/empty/invalid stdin.cwd → stderr log +
#     exit 0 + NO directive emitted. Never binds to inherited process cwd
#     under any degraded branch.
#
# Codex consensus chain (5 rounds, 2026-05-12):
#   r1 …ef14→…e24d HOLD (F1-F5)
#   r2 …ccfb→…975c HOLD (F6 cwd-binding, F7 bundle-integrity)
#   r3 …1553→…77e5 HOLD (F8 matrix coverage, F9 resolver ambiguity,
#                          F10 source/install sync, F11 em-search mechanical)
#   r4 …68d0→…87ac HOLD (F12 matrix vary stdin.cwd, F13 fail-safe tightening)
#   r5 …5c73→…0355 ACCEPT-with-FU (no new architectural class; #19 trigger)
#
# 2026-06-12 (checkpoint-hygiene C2/F3): backported the installed runtime —
# 6-file always-tier list (2026-05-16 demotions) + condensed Q1/Q2 directive —
# which had drifted ahead of this source; file is now tracked in HOOK_SPECS /
# the freshness manifest so future drift is reported at SessionStart.
#
# Composes with:
#   - hooks/lib/repo-root.sh (sourced for resolve_repo_root canonical helper)
#   - feedback_project_root_binding_audit.md discipline #20

set -u

# Skip non-interactive routines (scheduled tasks, em-* launchd jobs).
# See issue #224 for env-propagation gap.
if [ -n "${CLAUDE_SCHEDULED_TASK:-}" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Fail-safe helper: stderr log + exit 0, no directive emission.
# Per codex F13: never bind to inherited process cwd on degraded paths.
# ---------------------------------------------------------------------------
_log_and_exit_safe() {
  printf 'session-handoff-prompt: %s\n' "$1" >&2
  exit 0
}

# ---------------------------------------------------------------------------
# Read stdin (Claude Code SessionStart payload):
#   { cwd, session_id, hook_event_name, transcript_path, ... }
# ---------------------------------------------------------------------------
INPUT="$(cat 2>/dev/null || true)"
if [ -z "$INPUT" ]; then
  _log_and_exit_safe "empty stdin; skipping"
fi

if ! printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1; then
  _log_and_exit_safe "stdin is not a JSON object; skipping"
fi

STDIN_CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)"
if [ -z "$STDIN_CWD" ]; then
  _log_and_exit_safe "stdin missing cwd; would bind to inherited process cwd otherwise"
fi

if [ ! -d "$STDIN_CWD" ]; then
  _log_and_exit_safe "stdin.cwd '$STDIN_CWD' does not exist on disk"
fi

# ---------------------------------------------------------------------------
# Resolve repo_root via git common-dir (linked-worktree → MAIN repo).
# Mirrors hooks/lib/repo-root.sh:resolve_repo_root algorithm.
# ---------------------------------------------------------------------------
REPO_ROOT=""
COMMON="$(git -C "$STDIN_CWD" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "${COMMON}" ]; then
  case "${COMMON}" in
    /*) _abs="${COMMON}" ;;
    *)  _abs="${STDIN_CWD}/${COMMON}" ;;
  esac
  if _abs="$(cd -P "$_abs" 2>/dev/null && pwd)"; then :; else _abs="${_abs%/}"; fi
  _base="$(basename "$_abs")"
  if [ "$_base" = ".git" ]; then
    REPO_ROOT="$(dirname "$_abs")"
  else
    REPO_ROOT="$(git -C "$STDIN_CWD" rev-parse --show-toplevel 2>/dev/null || true)"
  fi
fi
if [ -z "${REPO_ROOT}" ] || [ ! -d "$REPO_ROOT" ]; then
  _log_and_exit_safe "could not resolve repo_root from stdin.cwd=$STDIN_CWD (non-git or unresolvable)"
fi

# ---------------------------------------------------------------------------
# Resolve memory_root with BOUNDED candidate set (codex F9).
# Candidate set derived ONLY from resolved REPO_ROOT — no ~/.claude/projects/*
# scan that could pick a wrong sibling project.
#
# Precedence:
#   1. .episodic-memory/config.json:claude_memory_root (if present and valid)
#   2. First non-empty path in {canonical, variant1, ...}
#   3. Canonical (even if empty; reads will ENOENT cleanly)
# ---------------------------------------------------------------------------

# Canonical sanitization (matches Claude Code's project-dir encoder: '/',
# '.', and ' ' → '-'). Spaces were previously dropped, sending projects
# with spaces in their path (e.g. "Home Network Improvement") to an empty
# memory dir → always-tier batch-Read silently no-ops.
_canonical="$(printf '%s' "${REPO_ROOT}" | sed 's|/|-|g; s|\.|-|g; s| |-|g')"
CANONICAL_MEM="${HOME}/.claude/projects/${_canonical}/memory"

# Sanitization variants observed on this machine. If new variants surface,
# extend this list (NOT a directory scan). FU-6 tracks reconciling the drift.
_variant1="$(printf '%s' "$_canonical" | sed 's|charltondho|charltond-ho|')"
VARIANT1_MEM="${HOME}/.claude/projects/${_variant1}/memory"

# Config override (highest precedence if valid path).
CONFIG_FILE="${REPO_ROOT}/.episodic-memory/config.json"
CONFIG_MEM=""
if [ -f "${CONFIG_FILE}" ]; then
  CONFIG_MEM="$(jq -r '.claude_memory_root // ""' "${CONFIG_FILE}" 2>/dev/null || true)"
  if [ -n "$CONFIG_MEM" ] && [ ! -d "$CONFIG_MEM" ]; then
    CONFIG_MEM=""
  fi
fi

_pick_nonempty() {
  for cand in "$@"; do
    if [ -d "$cand" ] && ls "$cand"/*.md >/dev/null 2>&1; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 1
}

if [ -n "$CONFIG_MEM" ]; then
  MEM_ROOT="$CONFIG_MEM"
elif MEM_ROOT="$(_pick_nonempty "$CANONICAL_MEM" "$VARIANT1_MEM")"; then
  :
else
  MEM_ROOT="$CANONICAL_MEM"
fi

# ---------------------------------------------------------------------------
# Always-tier list (6 files; demotions 2026-05-16):
#   - feedback_send_grep_artifact.md → lazy-tier (content trigger: PII /
#     sanitization keywords via MEMORY.md Trigger-phrase index)
#   - feedback_three_state_review_verdict.md → lazy-tier (loads when
#     "verdict" / "ACCEPT" / "HOLD" / "REJECT" / "approving" keywords fire)
# These rules fire on EVERY claim OR on short/no-keyword prompts; lazy-loading
# them would defeat their self-trigger contract (catch-22 from plan v1).
# ---------------------------------------------------------------------------
ALWAYS_TIER=(
  "MEMORY.md"
  "feedback_verify_by_artifact.md"
  "feedback_self_trigger_artifact_mode.md"
  "feedback_per_prompt_rule_preflight.md"
  "feedback_bp1_step9_filing_trigger.md"
  "feedback_canonical_agent_dispatch_trigger.md"
)

# Emit explicit absolute paths (codex F11).
_paths=""
for f in "${ALWAYS_TIER[@]}"; do
  _paths="${_paths}     - ${MEM_ROOT}/${f}"$'\n'
done

# Shell-quote a path for safe inclusion in a command string. Mirrors
# install.mjs:shellQuote (codex post-impl P1, 2026-05-12): paths with
# spaces or shell metacharacters break the em-search command otherwise.
_shell_quote() {
  local s="$1"
  case "$s" in
    *[!A-Za-z0-9_./:=,-]*)
      # Has unsafe chars; single-quote and escape any internal single quotes.
      printf "'"
      printf '%s' "$s" | sed "s/'/'\\\\''/g"
      printf "'"
      ;;
    *)
      printf '%s' "$s"
      ;;
  esac
}

# Mechanical em-search command (cd-bound; codex F11). Both REPO_ROOT uses
# are shell-quoted for path-with-spaces / shell-metachar safety.
_quoted_root="$(_shell_quote "${REPO_ROOT}")"
_quoted_emsearch="$(_shell_quote "${REPO_ROOT}/scripts/em-search.mjs")"
EM_SEARCH_CMD="cd ${_quoted_root} && node ${_quoted_emsearch} --category lesson --scope all --limit 10 --no-track --no-score"

# ---------------------------------------------------------------------------
# Handoff (phase 1) — only if session_handoff.md exists at resolved memory_root.
# ---------------------------------------------------------------------------
HANDOFF="${MEM_ROOT}/session_handoff.md"

if [ -f "${HANDOFF}" ]; then
  MTIME="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "${HANDOFF}" 2>/dev/null \
         || stat -c '%y' "${HANDOFF}" 2>/dev/null | cut -c1-16 \
         || echo unknown)"

  DIRECTIVE="BLOCKING: Ask both y/n questions before responding. No preamble or tool calls between them.

Q1 (verbatim):
  Load session_handoff.md from ${MTIME}? (y/n)

Q2 (verbatim, after Q1 is answered):
  Load discipline + toolkit + recent lessons? (y/n)

Remember Q1's answer across Q2; do NOT drop it.

After both answers, process in order:
  1. If Q1=y: Read ${HANDOFF}
  2. If Q2=y: batch-Read these 6 absolute paths, then run the em-search command:
${_paths}     ${EM_SEARCH_CMD}
  3. Then address the user's prompt."
else
  DIRECTIVE="BLOCKING: Ask this y/n question (verbatim) before responding, no preamble or tool calls:
  Load discipline + toolkit + recent lessons? (y/n)

If y: batch-Read these 6 absolute paths, then run the em-search command:
${_paths}     ${EM_SEARCH_CMD}
Then address the user's prompt."
fi

jq -n --arg ctx "${DIRECTIVE}" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
