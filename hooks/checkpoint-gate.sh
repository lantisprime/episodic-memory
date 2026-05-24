#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-09.1
# checkpoint-gate.sh — RFC-002 Phase 3b PreToolUse hook.
#
# Session 1 rewrite (#86 PR-B / #89 / #101): replaces the regex-based
# marker-write allowlist (lines ~46-117 in the prior version) and the
# git-push / gh-pr-create regex (lines ~125-141) with the shared classifier
# from hooks/lib/command-classifier.sh.
#
# 2026-05-09 .checkpoints/ migration: marker WRITES now go to
# <repo-root>/.checkpoints/ via hooks/lib/marker-paths.sh, while READS check
# .checkpoints/ first then fall back to .claude/ (until the legacy branch is
# removed in a follow-up commit). CLEANUP sweeps BOTH roots. Closes the
# Claude Code sensitive-file-guard prompt class for marker writes.
#
# Two gates with shared marker state:
#
#   pre-checkpoint:
#     Blocks Edit/Write/MultiEdit/Bash/NotebookEdit when .checkpoint-required
#     exists (either root) AND .pre-checkpoint-done is missing/empty (both
#     roots). Activator: em-recall.mjs touches .checkpoint-required when
#     bp-001 violations surface in pre-flight.
#
#   push-gate:
#     Blocks Bash classified as push_or_pr_create OR shared_write that mutates
#     external GitHub state when .post-checkpoint-required exists (either
#     root) AND .post-checkpoint-done is missing/empty (both roots). Allowed
#     pushes clean all task-signal markers across BOTH roots.
#
# .post-checkpoint-required is armed (always at PRIMARY) on every allowed
# write that passed the pre-gate (idempotent touch).
#
# Marker-write allowlist (deadlock prevention) is classifier-driven:
# Bash classified as marker_write whose TARGET is one of the repo-root
# checkpoint markers AT EITHER ROOT passes the pre-gate iff:
#   - .pre-checkpoint-done write: requires .checkpoint-required exists
#     (either root) AND .pre-checkpoint-done is missing/empty (both roots).
#   - .post-checkpoint-done write: requires .post-checkpoint-required exists
#     AND .post-checkpoint-done is missing/empty.
# Cross-gate invariant (Codex ...3503 P1): checkpoint marker writes are
# blocked while .plan-approval-pending exists (either root). Both gates
# independently enforce.

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
MY_SID="$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)"
[ -z "$CWD" ] && CWD="$(pwd)"

# Source classifier + repo-root resolver + shared marker paths + session-id.
# Use BASH_SOURCE for symlink safety.
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ] || [ ! -f "$LIB_DIR/marker-paths.sh" ] || [ ! -f "$LIB_DIR/session-id.sh" ]; then
  echo '{"decision": "block", "reason": "checkpoint-gate.sh: hooks/lib/ not found alongside hook (need command-classifier.sh, repo-root.sh, marker-paths.sh, session-id.sh). Re-run install.mjs --install-hooks."}'
  exit 0
fi
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/marker-paths.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/session-id.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"

# Canonical WRITE paths. Used in block-message paths so the agent knows
# where to write the checkpoint block.
#
# Rank-2 C6 (atomic with classifier extensions): when MY_SID is valid,
# emit suffixed paths `.X.<sid>` so each session writes to its own marker.
# The classifier now recognizes `.pre-checkpoint-done.*` and
# `.post-checkpoint-done.*` as marker_write in redirect/rm/tee/touch/
# classify_path case-arms — atomic-slice contract satisfied.
#
# When sid is invalid/empty, fall back to legacy literal (graceful
# degrade — preserves pre-rank-2 behavior for old hook installs).
if validate_session_id "$MY_SID"; then
  PRE_DONE_W="$(write_marker_path "$REPO_ROOT" "$(namespaced_marker_basename_for_session .pre-checkpoint-done "$MY_SID")")"
  POST_DONE_W="$(write_marker_path "$REPO_ROOT" "$(namespaced_marker_basename_for_session .post-checkpoint-done "$MY_SID")")"
else
  PRE_DONE_W="$(write_marker_path "$REPO_ROOT" .pre-checkpoint-done)"
  POST_DONE_W="$(write_marker_path "$REPO_ROOT" .post-checkpoint-done)"
fi
PLAN_PENDING_W="$(write_marker_path "$REPO_ROOT" .plan-approval-pending)"

PRIMARY_DIR="$REPO_ROOT/$PRIMARY_MARKER_DIR"
LEGACY_DIR="$REPO_ROOT/$LEGACY_MARKER_DIR"

# ---------------------------------------------------------------------------
# Dual-root marker helpers (burn-in only; collapse to primary-only when the
# fallback branch is removed).
# ---------------------------------------------------------------------------
# marker_exists <basename> — true if the marker exists at either root.
marker_exists() {
  [ -e "$PRIMARY_DIR/$1" ] || [ -e "$LEGACY_DIR/$1" ]
}
# marker_nonempty <basename> — true if either root's copy is non-empty.
marker_nonempty() {
  [ -s "$PRIMARY_DIR/$1" ] || [ -s "$LEGACY_DIR/$1" ]
}

# Rank-2 (PR for checkpoint-quartet) — session-aware sibling of marker_exists.
# Returns 0 (true) if the marker exists at any of:
#   <root>/.checkpoints/<legacy>.<sid>          (own session, primary)
#   <root>/.claude/<legacy>.<sid>               (own session, legacy)
#   <root>/.checkpoints/<legacy>                (legacy literal, primary)
#   <root>/.claude/<legacy>                     (legacy literal, legacy root)
# Cross-session suffixed markers (`<legacy>.<OTHER_SID>`) are IGNORED.
# Invalid/empty sid → only legacy literal forms are checked.
#
# Pair with marker_nonempty_for_session() for `.X-done` size-based checks.
checkpoint_marker_exists_for_session() {
  local legacy="$1" sid="$2"
  [ -e "$PRIMARY_DIR/$legacy" ] && return 0
  [ -e "$LEGACY_DIR/$legacy" ] && return 0
  if validate_session_id "$sid"; then
    local basename
    basename="$(namespaced_marker_basename_for_session "$legacy" "$sid")"
    [ -e "$PRIMARY_DIR/$basename" ] && return 0
    [ -e "$LEGACY_DIR/$basename" ] && return 0
  fi
  return 1
}

# Rank-2 — session-aware sibling of marker_nonempty. Tests own-session-or-
# legacy-literal forms for non-empty size. Other sessions' suffixed
# markers IGNORED.
checkpoint_marker_nonempty_for_session() {
  local legacy="$1" sid="$2"
  [ -s "$PRIMARY_DIR/$legacy" ] && return 0
  [ -s "$LEGACY_DIR/$legacy" ] && return 0
  if validate_session_id "$sid"; then
    local basename
    basename="$(namespaced_marker_basename_for_session "$legacy" "$sid")"
    [ -s "$PRIMARY_DIR/$basename" ] && return 0
    [ -s "$LEGACY_DIR/$basename" ] && return 0
  fi
  return 1
}
# marker_basename_for_target <abs-path> — echoes the basename if the TARGET
# matches an EXACT authoritative marker path at either root (primary or
# legacy). Echoes nothing for descendants like
# `<root>/.checkpoints/sub/.pre-checkpoint-done` so the marker_write
# allowlist can't be bypassed via path-traversal-shaped names. Codex
# round-1 F1 (path: hooks/checkpoint-gate.sh:91-95): the prior prefix
# match accepted any descendant with a marker basename, mirroring the
# pre-fix #146 deadlock class.
marker_basename_for_target() {
  local target="$1" m
  for m in .pre-checkpoint-done .post-checkpoint-done .plan-approval-pending; do
    if [ "$target" = "$PRIMARY_DIR/$m" ] || [ "$target" = "$LEGACY_DIR/$m" ]; then
      printf '%s' "$m"
      return 0
    fi
  done
  # #268 fix E13: also accept any per-session plan-marker basename
  # `.plan-approval-pending.<sid>` at either root. Strict validation via
  # plan_marker_basename_matches (rejects path traversal / oversize / invalid chars).
  local target_basename="${target##*/}"
  local target_dir="${target%/*}"
  case "$target_basename" in
    .plan-approval-pending.*)
      if plan_marker_basename_matches "$target_basename"; then
        if [ "$target_dir" = "$PRIMARY_DIR" ] || [ "$target_dir" = "$LEGACY_DIR" ]; then
          printf '%s' "$target_basename"
          return 0
        fi
      fi
      ;;
    # Rank-2: per-session checkpoint quartet basenames at either root.
    # Strict-validate via namespaced_marker_basename_matches per quartet
    # member (rejects path traversal / oversize / invalid chars). The
    # narrower allow-target set here is intentionally limited to
    # .pre/.post-checkpoint-done (the two CONTENT-bearing markers an
    # agent writes); .checkpoint-required / .post-checkpoint-required are
    # gate-armed only, not agent-written.
    .pre-checkpoint-done.*|.post-checkpoint-done.*)
      local legacy_basename
      case "$target_basename" in
        .pre-checkpoint-done.*)  legacy_basename=.pre-checkpoint-done ;;
        .post-checkpoint-done.*) legacy_basename=.post-checkpoint-done ;;
      esac
      if namespaced_marker_basename_matches "$legacy_basename" "$target_basename"; then
        if [ "$target_dir" = "$PRIMARY_DIR" ] || [ "$target_dir" = "$LEGACY_DIR" ]; then
          printf '%s' "$target_basename"
          return 0
        fi
      fi
      ;;
  esac
  printf ''
}

# #268 fix E13: plan_marker_exists_for_session — is there a plan-approval
# marker blocking THIS session? Returns 0 (true) on any of:
#   - <root>/.checkpoints/.plan-approval-pending.<sid>          (own session, primary)
#   - <root>/.claude/.plan-approval-pending.<sid>               (own session, legacy)
#   - <root>/.checkpoints/.plan-approval-pending                (legacy suffix-less)
#   - <root>/.claude/.plan-approval-pending                     (legacy suffix-less)
# Cross-session suffixed markers (.plan-approval-pending.OTHER_SID) are
# IGNORED — that's the #268 fix.
plan_marker_exists_for_session() {
  local sid="$1"
  [ -e "$PRIMARY_DIR/$PLAN_MARKER_LEGACY_BASENAME" ] && return 0
  [ -e "$LEGACY_DIR/$PLAN_MARKER_LEGACY_BASENAME" ] && return 0
  if validate_session_id "$sid"; then
    local basename
    basename="$(plan_marker_basename_for_session "$sid")"
    [ -e "$PRIMARY_DIR/$basename" ] && return 0
    [ -e "$LEGACY_DIR/$basename" ] && return 0
  fi
  return 1
}

# any_plan_marker_exists is sourced from hooks/lib/marker-paths.sh. Local
# wrapper threads REPO_ROOT through so call-sites read the same way. Rule 14
# drift fix — single definition shared with plan-gate.sh.
_any_plan_marker_exists_local() {
  any_plan_marker_exists "$REPO_ROOT"
}

# #268 fix: composite predicate combining E13 + F14. Returns 0 (true) if
# THIS session is plan-blocked by either:
#   (a) invalid/empty/missing sid AND any plan marker exists (F14
#       fail-closed for probe-drift threat — per plan v6 §2)
#   (b) valid sid AND plan_marker_exists_for_session true
# Returns 1 (false) otherwise.
plan_pending_blocks_this_session() {
  local sid="$1"
  if ! validate_session_id "$sid"; then
    _any_plan_marker_exists_local && return 0
    return 1
  fi
  plan_marker_exists_for_session "$sid" && return 0
  return 1
}

# ---------------------------------------------------------------------------
# Wrong-root marker write detection (#191 B2 / #202 / #178 cluster).
# Hook-deadlock cluster plan v7 — codex 7-round review, ACCEPT-with-FU.
# ---------------------------------------------------------------------------
#
# Closed marker set (8 basenames) — mirrors classifier emit-site cases at
# command-classifier.sh lines 516, 522, 630, 636, 666, 672. Used for
# wrong-root detection only; NOT for marker_basename_for_target's narrower
# 3-marker allowlist (intentionally narrower — only 3 markers are valid
# gate-action targets here; the other 5 are handled by other gates/hooks).
_marker_basename_in_set() {
  case "${1##*/}" in
    .pre-checkpoint-done|.post-checkpoint-done|.plan-approval-pending| \
    .checkpoint-required|.post-checkpoint-required|.preflight-done| \
    .last-user-prompt.json) return 0 ;;
    .last-user-prompt.*.json) return 0 ;;
    .so-runbook-shown.*) return 0 ;;
    # #268 fix E7: per-session plan-marker `.plan-approval-pending.<sid>`.
    # Loose glob here for set-membership routing; strict validation via
    # plan_marker_basename_matches happens at marker_basename_for_target.
    .plan-approval-pending.*) return 0 ;;
    # #279 fix: per-session preflight-marker `.preflight-done.<sid>`.
    # Sibling of plan-approval-pending; loose glob, strict validation
    # via preflight_marker_basename_matches happens at gate layer.
    .preflight-done.*) return 0 ;;
  esac
  return 1
}

# Codex round-4 F13: lexical `./` segment normalization (pure string manip;
# no symlink resolution — kept lexical for defense in depth + simplicity).
# Strips leading `./`, mid-path `/./`. `../` lexical normalization is FU
# (see scratch/rank1-plan-v7.md FU list F13b); if a TARGET contains `../`,
# this helper passes it through and the equality check fails closed (block).
_normalize_path_lexical() {
  local p="$1"
  while [ "${p#*/./}" != "$p" ]; do
    p="${p%%/./*}/${p#*/./}"
  done
  case "$p" in
    ./*) p="${p#./}" ;;
  esac
  printf '%s' "$p"
}

# Returns 0 iff (lexically-normalized) target equals canonical PRIMARY or
# LEGACY path for its own basename. Decoupled from marker_basename_for_target's
# narrower 3-marker scope (codex round-2 F7).
_is_canonical_marker_path() {
  local target basename norm
  norm="$(_normalize_path_lexical "$1")"
  basename="${norm##*/}"
  [ "$norm" = "$PRIMARY_DIR/$basename" ] && return 0
  [ "$norm" = "$LEGACY_DIR/$basename" ] && return 0
  return 1
}

# Code-review A1: strip shell quote/escape characters before regex match.
# Bash quoting that breaks the contiguous `.checkpoints/<marker>` substring
# (e.g. `touch ".checkpoints"/.pre-checkpoint-done`) evades the raw regex
# while the actual tool still writes to the unquoted path. Quote-stripping
# preserves the path's effective shape for detection purposes; it's a
# defense-in-depth lexer, not a full bash parser (eval/$() expansion is
# out of scope — classify_command labels those `unsafe_complex`).
_strip_shell_quotes() {
  local s="$1"
  s="${s//\"/}"
  s="${s//\'/}"
  s="${s//\\/}"
  printf '%s' "$s"
}

# PR-review round-2 P1 (codex episode ...5b9e): `${var//pattern/}` in
# bash is pattern substitution, NOT literal substitution. Glob meta chars
# (`*`, `?`, `[`) in the pattern are active. When the extracted absolute
# path `$p` contains a literal `*` (e.g. `/tmp/emglob*/.checkpoints/X`),
# `${cmd//\.${p}/}` over-matches and the occurrence-scoped check is
# defeated. Escape glob meta chars in `$p` before using it as a pattern.
# Backslash escape is not required because _strip_shell_quotes already
# removed backslashes from the input.
_escape_bash_glob() {
  local s="$1"
  s="${s//\*/\\*}"
  s="${s//\?/\\?}"
  s="${s//\[/\\[}"
  printf '%s' "$s"
}

# Codex round-4 F12 + round-5 F15 + code-review A1: relative-marker-reference
# detection. Matches `.checkpoints/<marker>` or `.claude/<marker>` as a
# RELATIVE path (no leading `/`). (^|[^/])(\./)* handles bare, ./, ././, ../.
# Runs on the quote-stripped command so quote-broken bypasses are caught.
# Returns 0 iff a relative marker path is referenced.
_command_has_relative_marker_path() {
  local cmd_stripped
  cmd_stripped="$(_strip_shell_quotes "$1")"
  printf '%s' "$cmd_stripped" | grep -qE '(^|[^/])(\./)*\.(checkpoints|claude)/(\.pre-checkpoint-done|\.post-checkpoint-done|\.plan-approval-pending(\.[A-Za-z0-9_-]{1,128})?|\.checkpoint-required|\.post-checkpoint-required|\.preflight-done(\.[A-Za-z0-9_-]{1,128})?|\.last-user-prompt(\.[A-Za-z0-9_-]+)?\.json|\.so-runbook-shown\.[A-Za-z0-9_-]+)'
}

# Absolute-non-canonical detection: for Bash commands where the classifier
# returns shared_write (touch/mv/cp/install/dd of=) on an ABSOLUTE marker path
# NOT under canonical PRIMARY/LEGACY. The marker_write-branch check covers
# absolute paths classified AS marker_write (redirect/rm/tee); this catches
# the shared_write-classified-but-targets-marker case.
#
# Three-pass per-token scan (codex review rounds R1–R8, 2026-05-23):
#
#   Pass A   — T token IS itself an absolute marker path. Handles paths
#              containing spaces because `_tokenize` preserves quoted
#              whitespace inside a single T value (closes the original bug
#              class — Home Network Improvement style repos).
#   Pass A'  — T token has `key=path` prefix (e.g. `of=/path with sp/X`,
#              `--output=/path with sp/X`). Walks `=`-delimited tails;
#              re-runs Pass A on each `/`-prefixed candidate. Preserves
#              spaces in the path portion.
#   Pass B   — T token CONTAINS an absolute marker-path substring (handles
#              `bash -c "touch /tmp/.checkpoints/.X"` payloads where the
#              path arrives inside a multi-word T token, no leading `/`).
#              Inner paths-with-spaces under this shape remain unhandled —
#              same as pre-fix behavior; not a new regression.
#
# Canonical short-circuit: if Pass A or A' recognizes a canonical full marker
# candidate, the per-token `continue` skips Pass B for that token. Without
# this, Pass B's regex would truncate a spacey canonical path at the first
# space and false-positive against the equality check.
#
# Echoes the first offending path on match. Returns 0 always so `x="$(...)"`
# under `set -e` never triggers script exit on the no-match case.
_command_first_absolute_noncanonical_marker() {
  local cmd="$1"
  local stream line type val
  # SIGPIPE-safe capture (feedback_shell_sigpipe_done_pipe.md): capture the
  # tokenizer output BEFORE iterating so an early `return` inside the loop
  # doesn't close the pipe while _tokenize is still writing on Linux.
  stream="$(_tokenize "$cmd")"
  while IFS= read -r line; do
    type="${line:0:1}"
    val="${line:2}"
    [ "$type" = "T" ] || continue

    local recognized_marker=0

    # ---- Pass A: token IS an absolute marker path.
    case "$val" in
      /*)
        if _marker_basename_in_set "$val"; then
          if _is_canonical_marker_path "$val"; then
            recognized_marker=1
          else
            printf '%s' "$val"
            return 0
          fi
        fi
        ;;
    esac

    # ---- Pass A': `key=path` prefix walk.
    local rest="$val" candidate
    while [ "${rest#*=}" != "$rest" ]; do
      rest="${rest#*=}"
      case "$rest" in
        /*)
          candidate="$rest"
          if _marker_basename_in_set "$candidate"; then
            if _is_canonical_marker_path "$candidate"; then
              recognized_marker=1
            else
              printf '%s' "$candidate"
              return 0
            fi
          fi
          ;;
      esac
    done

    # Canonical short-circuit: if Pass A or A' already identified a
    # canonical full candidate for this token, skip Pass B (which would
    # truncate a spacey canonical path and false-positive).
    [ "$recognized_marker" = "1" ] && continue

    # ---- Pass B: token CONTAINS an absolute marker-path substring.
    local tok_matches p basename p_escaped tok_filtered
    tok_matches=$(printf '%s' "$val" | grep -oE '/[^[:space:]]*\.(checkpoints|claude)/(\.pre-checkpoint-done|\.post-checkpoint-done|\.plan-approval-pending(\.[A-Za-z0-9_-]{1,128})?|\.checkpoint-required|\.post-checkpoint-required|\.preflight-done(\.[A-Za-z0-9_-]{1,128})?|\.last-user-prompt(\.[A-Za-z0-9_-]+)?\.json|\.so-runbook-shown\.[A-Za-z0-9_-]+)' 2>/dev/null || true)
    [ -z "$tok_matches" ] && continue
    while IFS= read -r p; do
      [ -z "$p" ] && continue

      # Per-token occurrence-scoped relative-vs-absolute disambiguation
      # (preserved from prior code, scoped to the current T value). Strip
      # literal `.${p}` occurrences from the token; if `$p` no longer
      # appears, the match was a relative reference (e.g. `./tmp/.X`);
      # skip. `_escape_bash_glob` handles `*`/`?`/`[` in `$p` so the
      # substitution stays literal.
      p_escaped="$(_escape_bash_glob "$p")"
      tok_filtered="${val//\.${p_escaped}/}"
      if [[ "$tok_filtered" != *"$p"* ]]; then
        continue
      fi

      basename="${p##*/}"
      if [ "$p" != "$PRIMARY_DIR/$basename" ] && [ "$p" != "$LEGACY_DIR/$basename" ]; then
        printf '%s' "$p"
        return 0
      fi
    done <<< "$tok_matches"
  done <<< "$stream"
  return 0
}

# Emit wrong-root BLOCK decision for absolute-path attempts (Write/Edit or
# Bash with absolute paths). Reason names BOTH the attempted path AND the
# canonical path the agent should use.
_block_wrong_root_marker() {
  local attempted="$1" basename="${1##*/}"
  local canonical="$PRIMARY_DIR/$basename"
  jq -nc --arg attempted "$attempted" --arg canonical "$canonical" --arg basename "$basename" \
    '{decision: "block", reason: ("Marker write to non-canonical path. You wrote " + $attempted + " but " + $basename + " must live under the main repo at " + $canonical + ". In a git worktree, hooks resolve markers against the main repo root via git-common-dir — write the marker at the canonical absolute path instead. Hook: checkpoint-gate.sh.")}'
  exit 0
}

# Emit wrong-root BLOCK decision for Bash relative-marker attempts from
# non-canonical cwd. Reason includes the verbatim command excerpt and the
# canonical primary marker dir.
_block_relative_marker_in_worktree() {
  local cmd_excerpt="$1"
  jq -nc --arg cmd "$cmd_excerpt" --arg primary "$PRIMARY_DIR" \
    '{decision: "block", reason: ("Relative marker reference from worktree cwd. The classifier resolves relative paths against the main repo root, but the shell executes them under the worktree cwd. Command was: " + $cmd + ". Re-issue with an absolute path under " + $primary + " (or cd to the main repo first). Hook: checkpoint-gate.sh.")}'
  exit 0
}

# Composite predicate: wrong-root iff (basename in closed set) AND (NOT
# canonical primary/legacy path). Decoupled from marker_basename_for_target's
# narrower allowlist (codex round-2 F7).
_is_wrong_root_marker_write() {
  local target="$1"
  _marker_basename_in_set "$target" || return 1
  _is_canonical_marker_path "$target" && return 1
  return 0
}

# Read-only tools — always allowed
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# Helper: emit a block decision.
# Reason strings include the canonical WRITE path (always primary —
# .checkpoints/) so the agent writes to the new location.
_block_pre() {
  jq -nc --arg path "$PRE_DONE_W" \
    '{decision: "block", reason: ("Checkpoint required. Write the Rule 18 pre-implementation checkpoint block to " + $path + " (must be non-empty) before write tools are unblocked. Hook: checkpoint-gate.sh.")}'
  exit 0
}
_block_post() {
  jq -nc --arg path "$POST_DONE_W" \
    '{decision: "block", reason: ("Post-implementation checkpoint required. Complete E2E testing and bug logging, then write the Rule 18 post-implementation checkpoint block to " + $path + " (must be non-empty) before pushing. Hook: checkpoint-gate.sh.")}'
  exit 0
}
_block_plan_pending() {
  jq -nc --arg path "$PLAN_PENDING_W" \
    '{decision: "block", reason: ("Plan approval pending. Checkpoint marker writes are blocked while " + $path + " exists. Approve the plan first. Hook: checkpoint-gate.sh.")}'
  exit 0
}

# ---------------------------------------------------------------------------
# Bash classification — compute label up front for downstream gates.
# ---------------------------------------------------------------------------
LABEL=""
TARGET=""
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  RESULT="$(classify_command "$COMMAND" "$REPO_ROOT")"
  LABEL="${RESULT%%	*}"
  REST="${RESULT#*	}"
  TARGET="${REST%%	*}"

  # Read-only Bash → allow immediately (closes #89).
  if [ "$LABEL" = "read_only" ]; then
    exit 0
  fi

  # Codex round-4 F12 + round-5 F15 + round-6 F18: verb-agnostic relative-
  # marker precheck. Runs for ALL non-read_only Bash when CWD != REPO_ROOT
  # (linked worktree OR nested cwd inside main repo). Catches touch/mv/cp/
  # install/dd-of/cat>>/heredoc-> + redirect/rm/tee. Classifier resolves
  # relative redirect targets against REPO_ROOT, but shell executes under
  # tool cwd — without this precheck, the gate "allows" a write whose
  # artifact lands at the wrong root.
  if [ "$CWD" != "$REPO_ROOT" ] && _command_has_relative_marker_path "$COMMAND"; then
    _block_relative_marker_in_worktree "$COMMAND"
  fi

  # Code-review A2: drop the `CWD != REPO_ROOT` guard so this check ALSO
  # fires from MAIN cwd. The predicate itself filters non-canonical paths
  # by exact-equality vs $PRIMARY_DIR/$basename / $LEGACY_DIR/$basename,
  # so it cannot false-positive on canonical absolute paths.
  #
  # Catches: ABSOLUTE non-canonical marker paths in Bash commands from
  # any cwd, e.g. `touch /tmp/.checkpoints/X` from main cwd OR
  # `touch $WT_DIR/.checkpoints/X` from worktree cwd. Classifier returns
  # shared_write for touch/mv/cp/install/dd-of with empty TARGET, so the
  # marker_write branch can't see them; this precheck fills that gap.
  NONCANON_ABS="$(_command_first_absolute_noncanonical_marker "$COMMAND")"
  if [ -n "$NONCANON_ABS" ]; then
    _block_wrong_root_marker "$NONCANON_ABS"
  fi

  # marker_write deadlock-prevention allowlist. Only allow when the gate's
  # state expects that specific marker write. All other marker_write Bash
  # falls through to the pre-gate as a normal write.
  #
  # Dual-root acceptance: TARGET is an absolute path that may point at
  # either .checkpoints/.X (new canonical) or .claude/.X (legacy fallback,
  # tolerated during burn-in for backward compat).
  if [ "$LABEL" = "marker_write" ]; then
    # Codex round-1 F1 + round-2 F7: absolute-path wrong-root BLOCK before
    # marker_basename_for_target's narrower allowlist evaluation. Catches
    # `Bash echo x > <wt>/.checkpoints/.pre-checkpoint-done` shape where
    # classifier-reported TARGET ≠ shell-resolved artifact location.
    if _is_wrong_root_marker_write "$TARGET"; then
      _block_wrong_root_marker "$TARGET"
    fi

    # Runbook UX-marker exemption (second-opinion-gate). EXACT-BASENAME
    # scoped via case, evaluated AFTER wrong-root check (canonical-root
    # binding already verified above) and BEFORE cross-gate plan-pending
    # invariant. The runbook UX-marker has no gate-lifecycle dependency
    # (it tracks "model has seen the runbook this session" — orthogonal
    # to checkpoint/plan lifecycle), so it must work under
    # .plan-approval-pending AND .checkpoint-required.
    case "${TARGET##*/}" in
      .so-runbook-shown.*)
        exit 0
        ;;
    esac

    TARGET_BN="$(marker_basename_for_target "$TARGET")"

    # Cross-gate invariant: checkpoint marker writes are blocked while
    # the current session's plan-approval-pending exists (Codex ...3503 P1).
    # #268 fix E14: session-aware via plan_pending_blocks_this_session.
    # Codex code-tier r1 BLOCKER-B1: narrow plan-marker allowance to
    # OWN-SESSION basename only (legacy literal OR own suffixed). Other-
    # session suffixed markers MUST NOT be writable via direct Bash —
    # without this narrowing, session A could `rm .plan-approval-pending.B`
    # while plan-blocked on its own marker.
    if plan_pending_blocks_this_session "$MY_SID"; then
      own_session_basename="$(plan_marker_basename_for_session "$MY_SID")"
      if [ "$TARGET_BN" = "$PLAN_MARKER_LEGACY_BASENAME" ] || [ "$TARGET_BN" = "$own_session_basename" ]; then
        # Allow plan-marker removal/touch — plan-gate.sh decides.
        exit 0
      fi
      _block_plan_pending
    fi
    # Rank-2: quartet pre-requisite checks are session-aware. Marker
    # existence/non-empty for the 4 quartet members uses own-session-or-
    # legacy reads — other sessions' suffixed markers don't satisfy this
    # session's prerequisite. (Plan-marker case unchanged — uses its own
    # session-aware predicate plan_pending_blocks_this_session above.)
    #
    # The strict-suffix recognition in marker_basename_for_target maps
    # `.X.<sid>` to its legacy form for case routing here; the existence
    # check then re-uses checkpoint_marker_exists_for_session which
    # handles both own-suffixed AND legacy literal forms.
    case "$TARGET_BN" in
      .pre-checkpoint-done|.pre-checkpoint-done.*)
        if checkpoint_marker_exists_for_session .checkpoint-required "$MY_SID" \
           && ! checkpoint_marker_nonempty_for_session .pre-checkpoint-done "$MY_SID"; then
          exit 0
        fi
        ;;
      .post-checkpoint-done|.post-checkpoint-done.*)
        if checkpoint_marker_exists_for_session .post-checkpoint-required "$MY_SID" \
           && ! checkpoint_marker_nonempty_for_session .post-checkpoint-done "$MY_SID"; then
          exit 0
        fi
        ;;
      .plan-approval-pending|.plan-approval-pending.*)
        exit 0
        ;;
    esac
    # Did not satisfy a prerequisite — fall through to pre-gate as a normal
    # write. Pre-gate will block if PRE_REQ armed and PRE_DONE empty.
  fi
fi

# ---------------------------------------------------------------------------
# Pre-checkpoint gate
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit)
    # classify_path for Write/Edit/MultiEdit/NotebookEdit
    FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')"
    if [ -n "$FILE_PATH" ]; then
      RESULT="$(classify_path "$FILE_PATH" "$REPO_ROOT")"
      LABEL="${RESULT%%	*}"
      REST="${RESULT#*	}"
      TARGET="${REST%%	*}"
      if [ "$LABEL" = "marker_write" ]; then
        # Codex round-1 F1 + round-2 F7: absolute-path wrong-root BLOCK
        # before marker_basename_for_target. Same predicate as Bash branch.
        # Note: classify_path at command-classifier.sh:1232 only emits
        # marker_write for 3 checkpoint markers — so this branch's effective
        # wrong-root surface is narrower than Bash's 8 markers. The other 5
        # markers (.checkpoint-required, .post-checkpoint-required,
        # .preflight-done, .last-user-prompt.*) reach Write/Edit via
        # preflight-gate.sh's helper-only enforcement at
        # preflight-gate.sh:170-209, not via this branch. classify_path
        # 3→8 marker expansion tracked as FU per scratch/rank1-plan-v7.md F9.
        #
        # Relative-marker precheck (Bash side) is NOT mirrored here:
        # Claude Code's Write/Edit tool requires absolute file_path, so the
        # worktree-relative attack surface doesn't apply.
        if _is_wrong_root_marker_write "$TARGET"; then
          _block_wrong_root_marker "$TARGET"
        fi

        TARGET_BN="$(marker_basename_for_target "$TARGET")"
        # Cross-gate invariant (#268 fix E15 + codex code-tier r1 B1 narrowing):
        # block Write/Edit unless target is THIS session's own plan-marker
        # basename (legacy literal OR own suffixed).
        own_session_basename="$(plan_marker_basename_for_session "$MY_SID")"
        if plan_pending_blocks_this_session "$MY_SID" \
           && [ "$TARGET_BN" != "$PLAN_MARKER_LEGACY_BASENAME" ] \
           && [ "$TARGET_BN" != "$own_session_basename" ]; then
          _block_plan_pending
        fi
        # Rank-2: session-aware quartet prerequisite check (Edit/Write
        # branch — same logic as the Bash branch above).
        case "$TARGET_BN" in
          .pre-checkpoint-done|.pre-checkpoint-done.*)
            if checkpoint_marker_exists_for_session .checkpoint-required "$MY_SID" \
               && ! checkpoint_marker_nonempty_for_session .pre-checkpoint-done "$MY_SID"; then
              exit 0
            fi
            ;;
          .post-checkpoint-done|.post-checkpoint-done.*)
            if checkpoint_marker_exists_for_session .post-checkpoint-required "$MY_SID" \
               && ! checkpoint_marker_nonempty_for_session .post-checkpoint-done "$MY_SID"; then
              exit 0
            fi
            ;;
          .plan-approval-pending|.plan-approval-pending.*)
            exit 0
            ;;
        esac
      fi
    fi
    ;;
esac

# Rank-2: pre-gate read is session-aware. Own-session marker OR legacy
# literal triggers the block; other sessions' suffixed markers do not.
if checkpoint_marker_exists_for_session .checkpoint-required "$MY_SID" \
   && ! checkpoint_marker_nonempty_for_session .pre-checkpoint-done "$MY_SID"; then
  _block_pre
fi

# ---------------------------------------------------------------------------
# Push-gate: only fires for Bash classified as push_or_pr_create.
# ---------------------------------------------------------------------------
if [ "$TOOL_NAME" = "Bash" ] && [ "$LABEL" = "push_or_pr_create" ]; then
  # Rank-2: session-aware post-checkpoint check.
  if checkpoint_marker_exists_for_session .post-checkpoint-required "$MY_SID" \
     && ! checkpoint_marker_nonempty_for_session .post-checkpoint-done "$MY_SID"; then
    _block_post
  fi
  # Audit P1: marker cleanup is gated on plan-gate not pending. PreToolUse
  # hooks run independently; if plan-gate or another PreToolUse hook ALSO
  # blocks this call, we must not have already removed the markers (the
  # tool will not actually run). Cleanup only when plan-gate is clear —
  # in that case, push_or_pr_create has reached the user's intended
  # task-complete moment.
  #
  # Dual-root sweep (Codex round-1 F2): rm at BOTH .checkpoints/ and
  # .claude/ until fallback is removed. Iteration over the shared
  # TASK_SIGNAL_MARKERS array keeps the cleanup set in lockstep with the
  # carve-out's marker set in em-recall.mjs.
  # #268 fix E17: session-aware check — only cleanup if THIS session has
  # no plan-pending. Other sessions' suffixed markers do not block cleanup.
  if ! plan_pending_blocks_this_session "$MY_SID"; then
    # Rank-2: sweep BOTH legacy literal AND ALL suffixed forms `<X>.<*>` at
    # both roots. push is the convergence moment — all sessions' progress
    # rolls up. Cross-session orphans from crashed sessions also get
    # cleared here.
    for _m in "${CHECKPOINT_CLEANUP_MARKERS[@]}"; do
      # Legacy literal at both roots.
      rm -f "$PRIMARY_DIR/$_m" "$LEGACY_DIR/$_m" 2>/dev/null || true
      # Suffixed forms `<X>.<*>` at both roots.
      # shellcheck disable=SC2086
      rm -f "$PRIMARY_DIR"/$_m.* 2>/dev/null || true
      # shellcheck disable=SC2086
      rm -f "$LEGACY_DIR"/$_m.* 2>/dev/null || true
    done
    unset _m
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Allowed write — arm post-tracking if pre-checkpoint was satisfied.
# Always armed at PRIMARY (write-side never touches legacy); dual-root
# cleanup later removes both.
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|Bash|NotebookEdit)
    # Rank-2: session-aware existence/nonempty checks for the post-write
    # arming. Per codex plan-tier R2 P2: helper invocation is best-effort
    # (|| true), pre-validated sid; non-zero exit must NOT abort the hook
    # under set -e. Falls back to legacy direct touch when sid is invalid
    # (graceful degrade — preserves pre-rank-2 behavior for back-compat).
    if checkpoint_marker_exists_for_session .checkpoint-required "$MY_SID" \
       && checkpoint_marker_nonempty_for_session .pre-checkpoint-done "$MY_SID"; then
      ensure_primary_dir "$REPO_ROOT" 2>/dev/null || true
      if validate_session_id "$MY_SID"; then
        # Prefer helper for unified marker_write classification + atomic write.
        # CLAUDE_CODE_SESSION_ID is exported to the helper subprocess via the
        # hook's inherited env (claude code sets it for all hooks).
        HELPER_CKM="$HOME/.episodic-memory/scripts/checkpoint-marker.mjs"
        if [ -f "$HELPER_CKM" ]; then
          CLAUDE_CODE_SESSION_ID="$MY_SID" node "$HELPER_CKM" \
            --target .post-checkpoint-required \
            --action arm-if-missing \
            --root "$REPO_ROOT" >/dev/null 2>&1 || true
        else
          # Fallback: direct write when helper not installed.
          touch "$(write_marker_path "$REPO_ROOT" "$(namespaced_marker_basename_for_session .post-checkpoint-required "$MY_SID")")" 2>/dev/null || true
        fi
      else
        # Invalid/empty sid: legacy direct touch (preserves pre-rank-2
        # behavior; gate inactive for own-session checks but legacy literal
        # still works for old hooks).
        touch "$(write_marker_path "$REPO_ROOT" .post-checkpoint-required)" 2>/dev/null || true
      fi
    fi
    ;;
esac

exit 0
