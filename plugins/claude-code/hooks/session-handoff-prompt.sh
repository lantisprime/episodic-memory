#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-07-04.foreign-project-440
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
# 2026-07-04 (#440): generalized for foreign projects. em-search.mjs resolves
# in-repo dev copy first, then ~/.episodic-memory/scripts/ (global substrate);
# always-tier list emits only files that exist at MEM_ROOT; directive degrades
# to Q1-only / Q2-only / no emission when parts are absent. Previously the
# emitted command hard-referenced <repo>/scripts/em-search.mjs (MODULE_NOT_FOUND
# outside this repo) and 5 feedback files foreign memory dirs never have.
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

# Fail-safe under set -u: HOME feeds memory-root candidates and the substrate
# em-search probe; unset HOME must degrade cleanly, not crash mid-script.
if [ -z "${HOME:-}" ]; then
  _log_and_exit_safe "HOME unset; cannot resolve memory root or substrate scripts"
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

# Emit explicit absolute paths (codex F11), filtered to files that exist at
# hook runtime (#440): foreign projects typically have MEMORY.md but none of
# the feedback files; emitting absent paths made the agent issue 5 failing
# Reads every session. Skip missing entries silently.
_paths=""
_n_files=0
for f in "${ALWAYS_TIER[@]}"; do
  if [ -f "${MEM_ROOT}/${f}" ]; then
    _paths="${_paths}     - ${MEM_ROOT}/${f}"$'\n'
    _n_files=$((_n_files+1))
  fi
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

# Mechanical em-trigger-index command (cd-bound; codex F11 pattern preserved).
#
# REQ-26 (RFC-009 P2-S5): the lesson load switches from a live, recency-only
# `em-search --no-score` invocation to the precomputed `session_start` STATIC
# BLEND (RFC-009 R2/R4) — the SAME artifact the R4 SessionStart activation
# hook reads (plugins/claude-code-activation/hooks/activation-hook-run.mjs).
# `--merged` prints the local+global dedup-by-id merged view
# (scripts/em-trigger-index.mjs loadMergedTriggerIndex); the jq filter below
# renders tier 1 (critical_entries, imperative) then tier 2 (entries, plain,
# cross-tier deduped — tier 1 wins) with the same two-tier contract the R4
# hook applies, so this hook and R4 never drift into two different
# lesson-loading rules. Still advisory/mechanical: this composes a shell
# command string for the agent to RUN, this hook itself performs no
# additional read beyond resolving the script path.
#
# em-trigger-index.mjs resolution (mirrors the #440 em-search resolution):
# probe the in-repo dev copy first (resolves only inside the episodic-memory
# repo itself), then the global substrate. REPO_ROOT stays as both the cd
# target and the --project binding so the local store is this project's,
# never inherited cwd. If no candidate resolves, EM_SEARCH_CMD stays empty
# and the directive omits the lesson-load step instead of emitting a
# MODULE_NOT_FOUND command.
TRIGGER_INDEX_SCRIPT=""
for cand in \
  "${REPO_ROOT}/scripts/em-trigger-index.mjs" \
  "${HOME}/.episodic-memory/scripts/em-trigger-index.mjs"
do
  if [ -f "$cand" ]; then TRIGGER_INDEX_SCRIPT="$cand"; break; fi
done
JQ_SESSION_START_FILTER='.session_start as $s | ($s.critical_entries | map(.episode_id)) as $crit | ($s.critical_entries[] | "READ " + .episode_id + " (band " + (.effective_priority|tostring) + "): " + .summary), ($s.entries[] | select(.episode_id as $id | ($crit | index($id)) | not) | "lesson " + .episode_id + ": " + .summary)'
EM_SEARCH_CMD=""
if [ -n "$TRIGGER_INDEX_SCRIPT" ]; then
  _quoted_root="$(_shell_quote "${REPO_ROOT}")"
  _quoted_trigger="$(_shell_quote "${TRIGGER_INDEX_SCRIPT}")"
  EM_SEARCH_CMD="cd ${_quoted_root} && node ${_quoted_trigger} --project ${_quoted_root} --merged | jq -r '${JQ_SESSION_START_FILTER}'"
fi

# Q2 payload (#440): compose from whichever parts resolved. Empty when there
# is nothing to load — the directive then degrades to Q1-only or no emission.
Q2_BODY=""
_pathword="paths"
[ "$_n_files" -eq 1 ] && _pathword="path"
if [ "$_n_files" -gt 0 ] && [ -n "$EM_SEARCH_CMD" ]; then
  Q2_BODY="batch-Read these ${_n_files} absolute ${_pathword}, then run the em-search command:
${_paths}     ${EM_SEARCH_CMD}"
elif [ "$_n_files" -gt 0 ]; then
  Q2_BODY="batch-Read these ${_n_files} absolute ${_pathword}:
${_paths%$'\n'}"
elif [ -n "$EM_SEARCH_CMD" ]; then
  Q2_BODY="run the em-search command:
     ${EM_SEARCH_CMD}"
fi

# ---------------------------------------------------------------------------
# Handoff (phase 1) — only if session_handoff.md exists at resolved memory_root.
# ---------------------------------------------------------------------------
HANDOFF="${MEM_ROOT}/session_handoff.md"

if [ -f "${HANDOFF}" ] && [ -n "$Q2_BODY" ]; then
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
  2. If Q2=y: ${Q2_BODY}
  3. Then address the user's prompt."
elif [ -f "${HANDOFF}" ]; then
  MTIME="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "${HANDOFF}" 2>/dev/null \
         || stat -c '%y' "${HANDOFF}" 2>/dev/null | cut -c1-16 \
         || echo unknown)"

  DIRECTIVE="BLOCKING: Ask this y/n question (verbatim) before responding, no preamble or tool calls:
  Load session_handoff.md from ${MTIME}? (y/n)

If y: Read ${HANDOFF}
Then address the user's prompt."
elif [ -n "$Q2_BODY" ]; then
  DIRECTIVE="BLOCKING: Ask this y/n question (verbatim) before responding, no preamble or tool calls:
  Load discipline + toolkit + recent lessons? (y/n)

If y: ${Q2_BODY}
Then address the user's prompt."
else
  # Nothing to load at this project (#440): no handoff, no memory files, no
  # resolvable em-search. Emit no directive rather than a no-op Q2.
  _log_and_exit_safe "no handoff, no always-tier files, no em-search candidate at MEM_ROOT=${MEM_ROOT}; skipping directive"
fi

jq -n --arg ctx "${DIRECTIVE}" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
