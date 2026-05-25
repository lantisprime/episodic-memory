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
#
# ---------------------------------------------------------------------------
# Planning-passive redesign (2026-05-25) + F1 RESIDUAL
# ---------------------------------------------------------------------------
# The pre-checkpoint gate no longer arms at SessionStart (em-recall emits an
# advisory instead). Nothing is armed during planning / discovery / exploration
# / code review. The pre-checkpoint requirement materializes at the
# IMPLEMENTATION boundary: the first repo-source Edit/Write/MultiEdit/
# NotebookEdit lazily arms .checkpoint-required and blocks. Bash is intentionally
# NOT pre-checkpoint-gated — reviews/inspections/dispatch never block.
#
# F1 RESIDUAL (documented + user-accepted): because Bash is ungated by the
# pre-checkpoint gate, a PURE-Bash implementation (`sed -i`, `cat > file`,
# `git commit`, `node script-that-writes.mjs`) can mutate repo source WITHOUT
# ever arming .checkpoint-required, bypassing the Rule 18 pre-checkpoint. This
# is a deliberate trade: gating all shared_write Bash reintroduced the exact
# planning-time friction this redesign removes (read-only `node`/inspection
# commands mis-blocked). Clean closure DEPENDS on a PR-B2 agent-classifier
# verdict (`nonsrc_write`) so only repo-source writes arm — enumeration of writer
# binaries proved unboundedly leaky (codex PR-level R1/R2). Tracked as #351
# (PR-B2 agent-classifier dependency). The push-gate + post-checkpoint +
# stop-gate lifecycle remain fully enforced.

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
MY_SID="$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)"
# Smart-arming PR R7/P1 fix: empty OR relative .cwd falls back to hook
# process cwd. Codex R7 found relative .cwd would otherwise propagate
# through resolve_repo_root → wrong REPO_ROOT → smart-arming predicate
# evaluates against bogus root and allows in-repo writes. Both empty AND
# non-absolute trigger the fallback to ensure REPO_ROOT downstream is
# always anchored to a valid absolute path.
case "$CWD" in
  /*) ;;  # absolute → use as-is
  *)  CWD="$(pwd)" ;;  # empty OR relative → fallback to hook process cwd
esac

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
    # Rank-2 (closes #341): per-session checkpoint quartet basenames.
    # Same parity as plan-marker/preflight-marker. Needed for the
    # wrong-root detection path (_command_first_absolute_noncanonical_marker)
    # to fire `_block_wrong_root_marker` on `mv`/`cp`/`install`/`dd of=`
    # to a non-canonical absolute path with suffixed quartet basename.
    # Reviewer: rank-2 negative-scenario-reviewer F1.
    .pre-checkpoint-done.*|.post-checkpoint-done.*|.checkpoint-required.*|.post-checkpoint-required.*) return 0 ;;
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
  printf '%s' "$cmd_stripped" | grep -qE '(^|[^/])(\./)*\.(checkpoints|claude)/(\.pre-checkpoint-done(\.[A-Za-z0-9_-]{1,128})?|\.post-checkpoint-done(\.[A-Za-z0-9_-]{1,128})?|\.plan-approval-pending(\.[A-Za-z0-9_-]{1,128})?|\.checkpoint-required(\.[A-Za-z0-9_-]{1,128})?|\.post-checkpoint-required(\.[A-Za-z0-9_-]{1,128})?|\.preflight-done(\.[A-Za-z0-9_-]{1,128})?|\.last-user-prompt(\.[A-Za-z0-9_-]+)?\.json|\.so-runbook-shown\.[A-Za-z0-9_-]+)'
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
# Env-prefix wrapper-escape block (codex review FU, 2026-05-25). The classifier
# flags `<NAME>=value node ... classifier-marker.mjs ...` as
# unsafe_complex/classifier_marker_env_override (the helper-invocation grammar
# refuses ANY env-prefix on the carve-out helper). The planning-passive redesign
# ungates Bash, so without this the form would be allowed — blessing an
# env-prefix wrapper escape that can poison the classifier-marker cache the gate
# itself trusts. Reject the FORM (not the var name), independent of the
# pre-checkpoint gate.
_block_env_prefix_marker() {
  jq -nc '{decision: "block", reason: "Env-prefix wrapper escape rejected. An environment-variable assignment before a classifier-marker.mjs invocation (e.g. BYPASS=1 node ... classifier-marker.mjs --write) is refused: env-prefix wrappers can carry gate-bypass payloads and poison the classifier cache. Re-invoke the helper with NO leading VAR=value prefix. Hook: checkpoint-gate.sh."}'
  exit 0
}

# ---------------------------------------------------------------------------
# Lazy-arm .checkpoint-required (planning-passive redesign, 2026-05-25).
#
# Replaces session-start arming (em-recall.mjs no longer arms; a recent bp-001
# violation is now an advisory warning, never a gate-arm). NOTHING is armed
# during planning / discovering / exploring / code review. The pre-checkpoint
# requirement materializes only at the IMPLEMENTATION boundary — the first
# repo-source file write OR the pre-checkpoint-done write, whichever comes
# first. Arming here (rather than at session start) keeps the downstream
# post-checkpoint + stop-gate + push-gate lifecycle intact: those key off
# .checkpoint-required to know a task is active this session.
#
# Idempotent: no-op if the marker already exists (own-session or legacy).
# Best-effort: never aborts the hook under set -e.
# ---------------------------------------------------------------------------
_arm_checkpoint_required_if_missing() {
  if checkpoint_marker_exists_for_session .checkpoint-required "$MY_SID"; then
    return 0
  fi
  ensure_primary_dir "$REPO_ROOT" 2>/dev/null || true
  if validate_session_id "$MY_SID"; then
    local helper="$HOME/.episodic-memory/scripts/checkpoint-marker.mjs"
    if [ -f "$helper" ]; then
      CLAUDE_CODE_SESSION_ID="$MY_SID" node "$helper" \
        --target .checkpoint-required \
        --action arm-if-missing \
        --root "$REPO_ROOT" >/dev/null 2>&1 || true
    else
      touch "$(write_marker_path "$REPO_ROOT" "$(namespaced_marker_basename_for_session .checkpoint-required "$MY_SID")")" 2>/dev/null || true
    fi
  else
    touch "$(write_marker_path "$REPO_ROOT" .checkpoint-required)" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# Smart-arming helpers (PR fix/checkpoint-gate-smart-arming, 2026-05-24)
#
# Purpose: stop checkpoint-gate from firing on off-repo tool calls (memory
# writes under ~/.claude/projects/**, skill writes under ~/.claude/skills/**,
# settings edits at ~/.claude/settings*.json, etc.) while preserving Rule 18
# enforcement for actual project source edits.
#
# Bash branch unchanged in scope (codex R1 6b): ALL non-marker_write Bash
# blocks while armed. Smart-arming relieves Edit/Write/MultiEdit/NotebookEdit
# whose FILE_PATH is outside REPO_ROOT.
#
# Codex round trace: R1 HOLD (path/Bash/stop-gate/MultiEdit/empirical),
# R2 HOLD (symlink axis 2), R3 ACCEPT-with-FU (symlink axis 1 + cwd-binding),
# R4 HOLD (cwd-binding sub-case), R5 HOLD (fix not landed), R6 ACCEPT-with-FU
# (methodology negotiation, recommended land-then-review per shape (b)).
# ---------------------------------------------------------------------------

# Canonicalize a path that may not exist, may be a broken symlink, or may
# have symlinked ancestors. macOS- and Linux-safe.
#
# Codex R2/P1: existing file/symlink-file targets must canonicalize via
# parent-pwd-P + readlink loop, not walk-up-only.
# Codex R3/P1: broken symlink leaves [ -e ] false, so we also accept [ -L ]
# as "existing surface to resolve."
_canonicalize_possibly_nonexistent() {
  local p="$1"
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac

  if [ -e "$p" ] || [ -L "$p" ]; then
    if [ -d "$p" ]; then
      (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"
      return
    fi
    local parent leaf parent_canon resolved hops=0
    parent="$(dirname "$p")"
    leaf="$(basename "$p")"
    parent_canon="$( (cd "$parent" 2>/dev/null && pwd -P) || printf '%s' "$parent" )"
    resolved="$parent_canon/$leaf"
    while [ -L "$resolved" ] && [ $hops -lt 32 ]; do
      local target rp_parent rp_leaf rp_parent_canon
      target="$(readlink "$resolved")" || break
      case "$target" in
        /*) resolved="$target" ;;
        *) resolved="$(dirname "$resolved")/$target" ;;
      esac
      hops=$((hops+1))
      rp_parent="$(dirname "$resolved")"
      rp_leaf="$(basename "$resolved")"
      rp_parent_canon="$( (cd "$rp_parent" 2>/dev/null && pwd -P) || printf '%s' "$rp_parent" )"
      resolved="$rp_parent_canon/$rp_leaf"
    done
    printf '%s' "$resolved"
    return
  fi

  # Nonexistent and not a symlink: walk up to nearest existing ancestor.
  local tail="" cur="$p"
  while [ -n "$cur" ] && [ ! -e "$cur" ] && [ ! -L "$cur" ]; do
    tail="/$(basename "$cur")${tail}"
    local up
    up="$(dirname "$cur")"
    [ "$up" = "$cur" ] && break
    cur="$up"
  done
  if [ -e "$cur" ] || [ -L "$cur" ]; then
    if [ -d "$cur" ]; then
      local cur_canon
      cur_canon="$( (cd "$cur" 2>/dev/null && pwd -P) || printf '%s' "$cur" )"
      printf '%s%s' "$cur_canon" "$tail"
    else
      # Non-directory ancestor (file or broken symlink) — recurse on $cur.
      # Bounded: recursive call hits the first branch immediately (depth ≤ 1).
      local cur_canon
      cur_canon="$(_canonicalize_possibly_nonexistent "$cur")"
      printf '%s%s' "$cur_canon" "$tail"
    fi
  else
    printf '%s' "$p"
  fi
}

# Decide whether the current tool call targets project source. Returns 0
# (yes, repo-touching, block as normal) or 1 (no, off-repo, allow).
#
# Bash (codex R1 6b): all non-marker_write Bash returns 0. Smart-arming
# does NOT relieve Bash friction — that's a separate classifier PR.
# Edit/Write/MultiEdit/NotebookEdit: compare FILE_PATH against REPO_ROOT
# via both raw-prefix (catches symlink-out author intent) AND canonical-
# prefix (catches symlink-in / traversal / nonexistent paths).
_tool_call_targets_repo_source() {
  local repo_root="$1" tool="$2" file_path="$3" label="$4"

  if [ "$tool" = "Bash" ]; then
    # Legitimate marker_write allowances exit 0 in the upstream Bash branch
    # BEFORE reaching the pre-block site, so any Bash that falls through to
    # the predicate is by construction "needs the pre-block." Including
    # marker_write that wasn't approved upstream (e.g. POST_DONE write when
    # POST_REQ not armed — test 17 regression class).
    case "$label" in
      read_only) return 1 ;;
      *)         return 0 ;;
    esac
  fi

  # Edit/Write/MultiEdit/NotebookEdit branch.
  # Empty path = defensive conservative-block (per R4/P1 fix: relative path
  # with no absolute cwd authority sets FILE_PATH="" upstream).
  if [ -z "$file_path" ]; then
    return 0
  fi

  local repo_canon
  repo_canon="$( (cd "$repo_root" 2>/dev/null && pwd -P) || printf '%s' "$repo_root" )"

  # Raw-prefix match (codex R1 attack class 3 — symlink-out author intent).
  case "$file_path" in
    "$repo_root"/*|"$repo_root") return 0 ;;
  esac

  # Canonical-prefix match (handles symlink-in, traversal, nonexistent leaf).
  local fp_canon
  fp_canon="$(_canonicalize_possibly_nonexistent "$file_path")"
  case "$fp_canon" in
    "$repo_canon"/*|"$repo_canon") return 0 ;;
  esac

  return 1
}

# PR-A P1.2: validate that `node <path>/classifier-marker.mjs ...` resolves
# to a known canonical location. Defense against shimmed binaries
# (`node /tmp/evil-classifier-marker.mjs --write ...` would otherwise be
# labeled marker_write/interpreter_classifier_marker by the classifier
# since the case-arm only matches on basename).
#
# Returns 0 if script path resolves to:
#   - ~/.episodic-memory/scripts/classifier-marker.mjs (installed runtime)
#   - <repo>/scripts/classifier-marker.mjs (repo-source)
# Returns 1 otherwise. Caller falls through to normal gate flow (which
# will typically block under armed checkpoint).
#
# Security: requires absolute path (relative paths would resolve via PATH/cwd
# to who-knows-where). Uses _canonicalize_possibly_nonexistent which handles
# symlinks (32-hop chain), macOS /var → /private/var, and nonexistent
# ancestors via existence-walk. Env-prefix attack class is already rejected
# at classifier-tier (command-classifier.sh:1730 returns unsafe_complex);
# this helper only sees the LABEL=marker_write/REASON=interpreter_classifier_marker
# case where env-prefix has been filtered upstream.
_validate_classifier_marker_helper() {
  local cmd="$1"
  local repo_root="$2"
  # Extract script path: first token after node|python|python3|ruby|perl.
  # #349 fix: use the shared _tokenize tokenizer (de-quotes single/double
  # quotes) instead of whitespace-splitting awk, so a quoted helper path with
  # spaces — `node '/My Scripts/classifier-marker.mjs' --write …` — round-trips
  # to the de-quoted `/My Scripts/classifier-marker.mjs` rather than the broken
  # `'/My` fragment. Extraction is positional — node CLI flags before the
  # script (e.g. `node --inspect-brk script.mjs`) are NOT supported. This is
  # symmetric with the upstream classifier dispatch (command-classifier.sh
  # ~1641) which takes `${TOKS[$((idx+1))]}` directly, so any node-flag-prefixed
  # form misses both the classifier case-arm AND this validator (benign
  # consistent miss). Interpreter match stays exact (bare name, not /usr/bin/node)
  # and basename `classifier-marker.mjs` stays exact-match. An unparseable
  # command (unbalanced quote / command substitution → `E` line) refuses.
  #
  # SIGPIPE-safe: capture _tokenize output into a var BEFORE the read loop and
  # feed via `<<<`, so an early `return` never closes a live producer pipe
  # (feedback_shell_sigpipe_done_pipe; same idiom as command-classifier.sh:698).
  local script_path="" _tok_stream _tok_line
  local -a _mk_toks=()
  _tok_stream="$(_tokenize "$cmd")"
  while IFS= read -r _tok_line; do
    case "$_tok_line" in
      "T "*) _mk_toks+=("${_tok_line:2}") ;;
      "E "*) return 1 ;;
    esac
  done <<< "$_tok_stream"
  local _i _next
  for _i in "${!_mk_toks[@]}"; do
    case "${_mk_toks[$_i]}" in
      node|python|python3|ruby|perl)
        _next=$(( _i + 1 ))
        if [ "$_next" -lt "${#_mk_toks[@]}" ]; then
          script_path="${_mk_toks[$_next]}"
        fi
        break
        ;;
    esac
  done
  [ -z "$script_path" ] && return 1
  # Require absolute path. Bare basename / ./relative could resolve to
  # anywhere; refuse rather than disambiguate.
  case "$script_path" in
    /*) ;;
    *) return 1 ;;
  esac
  local script_canon
  script_canon="$(_canonicalize_possibly_nonexistent "$script_path")"
  [ -z "$script_canon" ] && return 1
  local allowed_global allowed_repo
  allowed_global="$(_canonicalize_possibly_nonexistent "$HOME/.episodic-memory/scripts/classifier-marker.mjs")"
  allowed_repo="$(_canonicalize_possibly_nonexistent "$repo_root/scripts/classifier-marker.mjs")"
  if [ -n "$allowed_global" ] && [ "$script_canon" = "$allowed_global" ]; then
    return 0
  fi
  if [ -n "$allowed_repo" ] && [ "$script_canon" = "$allowed_repo" ]; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Bash classification — compute label up front for downstream gates.
# ---------------------------------------------------------------------------
LABEL=""
TARGET=""
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  # PR-A P1.1: thread parsed .cwd as authoritative caller cwd. $CWD is
  # already absolute-normalized at top of file (relative/empty → $(pwd)
  # fallback per PR #347 R7/P1). Without threading, classify_command's
  # Tier 0 + Tier 2/3 dispatch use hook process $PWD which diverges from
  # tool .cwd — codex R1 P1 reproduced marker miss.
  RESULT="$(classify_command "$COMMAND" "$REPO_ROOT" "$CWD")"
  LABEL="${RESULT%%	*}"
  REST="${RESULT#*	}"
  TARGET="${REST%%	*}"
  # PR-A P1.2: extract REASON (3rd field) for bootstrap carve-out routing.
  # classifier-marker.mjs invocations emit `marker_write\t\tinterpreter_classifier_marker`
  # — empty TARGET but distinguishable REASON.
  REASON="${REST#*	}"
  # Belt-and-suspenders trailing-newline strip. `RESULT="$(classify_command ...)"`
  # already strips trailing newlines via bash command substitution semantics
  # so this is a no-op on well-formed classifier output (all classifier
  # printf calls use \n only — no CR source). Per negative-scenario-reviewer
  # C1 audit: kept as defense against future classifier output drift.
  REASON="${REASON%$'\n'}"

  # Read-only Bash → allow immediately (closes #89).
  if [ "$LABEL" = "read_only" ]; then
    exit 0
  fi

  # Env-prefix wrapper escape on the classifier-marker helper. The classifier
  # returns unsafe_complex/classifier_marker_env_override for any env-prefixed
  # helper invocation. Block it DIRECTLY here — independent of the (removed)
  # Bash pre-checkpoint gate — so the planning-passive Bash allowance can't
  # bless an env-prefix wrapper escape against the classifier cache. (Codex
  # review FU, 2026-05-25.)
  if [ "$REASON" = "classifier_marker_env_override" ]; then
    _block_env_prefix_marker
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
        # Planning-passive redesign (2026-05-25): allow the pre-checkpoint
        # block write whenever it isn't already satisfied, and arm
        # .checkpoint-required at that moment if missing (the implementation
        # boundary). No longer depends on a session-start arm.
        if ! checkpoint_marker_nonempty_for_session .pre-checkpoint-done "$MY_SID"; then
          _arm_checkpoint_required_if_missing
          exit 0
        fi
        ;;
      .post-checkpoint-done|.post-checkpoint-done.*)
        if checkpoint_marker_exists_for_session .post-checkpoint-required "$MY_SID"; then
          # POST_REQ armed → post-checkpoint phase; allow the write (first
          # write OR idempotent re-write of an already-satisfied marker).
          exit 0
        fi
        # POST_REQ NOT armed → writing the post-checkpoint before the
        # lifecycle has armed it. The planning-passive redesign (2026-05-25)
        # removed Bash from the pre-gate, so a premature marker_write no
        # longer falls through to a block. Block DIRECTLY here so this branch
        # is self-contained (tests 17/49/50/56).
        _block_pre
        ;;
      .plan-approval-pending|.plan-approval-pending.*)
        exit 0
        ;;
    esac

    # PR-A P1.2: classifier-marker.mjs bootstrap carve-out. The classifier
    # labels `node <path>/classifier-marker.mjs --write ...` as
    # marker_write/interpreter_classifier_marker, but the command has empty
    # TARGET (it's not a path-writing shell verb), so the quartet checks
    # above can't match. Without this carve-out, the deny-with-hint
    # mechanism in PR-B would direct the agent to run classifier-marker.mjs,
    # which would then be blocked by the pre-gate when .checkpoint-required
    # is armed — making the hint unactionable. Codex R1 P1 reproduced this
    # empirically (pasted marker command blocked with "Checkpoint required").
    #
    # Security layering:
    #   - Env-prefix already rejected upstream (command-classifier.sh:1730
    #     returns unsafe_complex for env-prefixed classifier-marker forms).
    #   - Plan-pending invariant still applies (above this branch); plan-
    #     pending blocks classifier-marker just like any other marker_write.
    #   - Helper-identity validation here (_validate_classifier_marker_helper)
    #     requires absolute script path resolving to canonical installed
    #     runtime or repo-source location; shimmed `node /tmp/evil...` rejected.
    if [ "$REASON" = "interpreter_classifier_marker" ]; then
      if _validate_classifier_marker_helper "$COMMAND" "$REPO_ROOT"; then
        exit 0
      fi
    fi

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
    # Smart-arming PR negative-scenario-reviewer F1 fix: NotebookEdit
    # puts the path in tool_input.notebook_path, not file_path. Without
    # this fallback, real off-repo NotebookEdit would still block
    # (conservative direction — no data loss — but the smart-arming
    # intent is violated). Per hooks/lib/command-classifier.sh:2790
    # NotebookEdit's canonical field is notebook_path.
    FILE_PATH="$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')"

    # ── R4/P1 cwd-binding defense (smart-arming PR) ──
    # _resolve_marker_path in command-classifier.sh:2106 unconditionally joins
    # relative paths under $repo_root — which can fabricate a marker_write
    # classification from a non-absolute input. Defense: ensure FILE_PATH is
    # absolute before classify_path runs.
    #   - Absolute → use as-is.
    #   - Relative + absolute tool_input.cwd → join (narrower authority preferred).
    #   - Relative + absolute top-level .cwd → join (broader authority fallback).
    #   - Relative + neither absolute → empty FILE_PATH, forcing predicate's
    #     defensive empty-path branch (conservative-block).
    if [ -n "$FILE_PATH" ]; then
      case "$FILE_PATH" in
        /*) ;;  # absolute → no-op
        *)
          _ti_cwd="$(echo "$INPUT" | jq -r '.tool_input.cwd // ""')"
          _top_cwd="$(echo "$INPUT" | jq -r '.cwd // ""')"
          _resolved=""
          case "$_ti_cwd"  in /*) _resolved="$_ti_cwd" ;; esac
          if [ -z "$_resolved" ]; then
            case "$_top_cwd" in /*) _resolved="$_top_cwd" ;; esac
          fi
          if [ -n "$_resolved" ]; then
            FILE_PATH="$_resolved/$FILE_PATH"
          else
            FILE_PATH=""
          fi
          ;;
      esac
    fi

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
            # Planning-passive redesign (2026-05-25): allow + lazy-arm (see
            # the Bash-branch counterpart above for rationale).
            if ! checkpoint_marker_nonempty_for_session .pre-checkpoint-done "$MY_SID"; then
              _arm_checkpoint_required_if_missing
              exit 0
            fi
            ;;
          .post-checkpoint-done|.post-checkpoint-done.*)
            if checkpoint_marker_exists_for_session .post-checkpoint-required "$MY_SID"; then
              # POST_REQ armed → post-checkpoint phase; allow the write.
              exit 0
            fi
            # POST_REQ NOT armed → premature post-checkpoint write. marker_write
            # skips the pre-gate (the `LABEL != marker_write` guard below), so
            # block DIRECTLY here (planning-passive redesign self-containment).
            _block_pre
            ;;
          .plan-approval-pending|.plan-approval-pending.*)
            exit 0
            ;;
        esac
      fi
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# Pre-checkpoint gate — planning-passive + lazy-armed (2026-05-25 redesign).
#
# OLD: em-recall armed .checkpoint-required at SESSION START whenever a bp-001
# violation existed within 30 days, blocking ALL non-read Bash + repo
# Edit/Write before any implementation — planning, recall, exploration, and
# code reviews (codex CLI / second-opinion.mjs) all tripped it. That blocked
# legitimate pre-implementation work, the core friction users hit.
#
# NEW: nothing armed at session start. The pre-checkpoint requirement attaches
# to the IMPLEMENTATION boundary — the first repo-source file write. Bash is
# intentionally NOT pre-checkpoint-gated (its safety is the classifier +
# push-gate + agent-classifier deny-hint), so reviews / inspections /
# exploration never block and never create a marker.
#
# The first repo-source Edit/Write/MultiEdit/NotebookEdit with no
# .pre-checkpoint-done lazily arms .checkpoint-required (so the post-checkpoint
# + stop-gate + push-gate lifecycle still tracks the task), then blocks.
# Off-repo Edit/Write (memory under ~/.claude/projects/**, skills, settings)
# is silently allowed via _tool_call_targets_repo_source. marker_write writes
# are handled earlier and skipped here.
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit)
    if [ "$LABEL" != "marker_write" ] \
       && ! checkpoint_marker_nonempty_for_session .pre-checkpoint-done "$MY_SID" \
       && _tool_call_targets_repo_source "$REPO_ROOT" "$TOOL_NAME" "$FILE_PATH" "$LABEL"; then
      # Lazy-arm ONLY when we have a concrete in-repo FILE_PATH. The empty-
      # FILE_PATH conservative-block path (relative path with no absolute cwd
      # authority — _tool_call_targets_repo_source returns 0 defensively) must
      # NOT write a marker: REPO_ROOT there falls back to the hook process cwd
      # (off-project invocation), so arming would leak .checkpoint-required
      # into an unrelated repo. Regression: SA-cwd-strict caller-leak. The
      # block still fires (Rule 18 conservative direction); only the arm is
      # withheld until a real in-repo write is seen.
      if [ -n "$FILE_PATH" ]; then
        _arm_checkpoint_required_if_missing
      fi
      _block_pre
    fi
    ;;
esac

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
