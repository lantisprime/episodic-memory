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
[ -z "$CWD" ] && CWD="$(pwd)"

# Source classifier + repo-root resolver + shared marker paths. Use
# BASH_SOURCE for symlink safety.
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/command-classifier.sh" ] || [ ! -f "$LIB_DIR/repo-root.sh" ] || [ ! -f "$LIB_DIR/marker-paths.sh" ]; then
  echo '{"decision": "block", "reason": "checkpoint-gate.sh: hooks/lib/ not found alongside hook (need command-classifier.sh, repo-root.sh, marker-paths.sh). Re-run install.mjs --install-hooks."}'
  exit 0
fi
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/marker-paths.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"

# Canonical WRITE paths (always primary). Used in block-message paths so the
# agent knows where to write the checkpoint block.
PRE_DONE_W="$(write_marker_path "$REPO_ROOT" .pre-checkpoint-done)"
POST_DONE_W="$(write_marker_path "$REPO_ROOT" .post-checkpoint-done)"
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
  printf ''
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
  printf '%s' "$cmd_stripped" | grep -qE '(^|[^/])(\./)*\.(checkpoints|claude)/(\.pre-checkpoint-done|\.post-checkpoint-done|\.plan-approval-pending|\.checkpoint-required|\.post-checkpoint-required|\.preflight-done|\.last-user-prompt(\.[A-Za-z0-9_-]+)?\.json|\.so-runbook-shown\.[A-Za-z0-9_-]+)'
}

# E2E-discovered absolute-non-canonical detection: for Bash commands where
# the classifier returns shared_write (touch/mv/cp/install/dd of=) on an
# ABSOLUTE marker path NOT under canonical PRIMARY/LEGACY. The
# marker_write-branch check covers absolute paths classified AS marker_write
# (redirect/rm/tee); this catches the shared_write-classified-but-targets-
# marker case. Echoes the first offending path on match (exit 0); empty on
# no match (exit 1).
_command_first_absolute_noncanonical_marker() {
  # Empty output = no wrong-root marker found; non-empty = the offending
  # path. Function always returns 0 so `x="$(...)"` under `set -e` never
  # triggers script exit on the no-match case (caller uses `[ -n "$x" ]`).
  local cmd
  cmd="$(_strip_shell_quotes "$1")"
  local matches p basename
  matches=$(printf '%s' "$cmd" | grep -oE '/[^[:space:]]*\.(checkpoints|claude)/(\.pre-checkpoint-done|\.post-checkpoint-done|\.plan-approval-pending|\.checkpoint-required|\.post-checkpoint-required|\.preflight-done|\.last-user-prompt(\.[A-Za-z0-9_-]+)?\.json|\.so-runbook-shown\.[A-Za-z0-9_-]+)' 2>/dev/null || true)
  [ -z "$matches" ] && return 0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    # PR-review P1: occurrence-scoped relative-vs-absolute disambiguation.
    # Strip all literal `.${p}` occurrences from cmd, then check if $p
    # still appears. If it does, there's at least one NON-relative
    # occurrence (a genuine absolute reference). Avoids the global-filter
    # false-negative where `echo ./tmp/.checkpoints/X >/dev/null; touch
    # /tmp/.checkpoints/X` would have skipped the check because
    # `./tmp/.checkpoints/X` exists somewhere in the command.
    #
    # PR-review round-2 P1: `${var//pattern/}` interprets glob meta chars
    # in the pattern. Escape `*`/`?`/`[` in `$p` so the substitution is
    # truly literal-equivalent (codex episode ...5b9e).
    local p_escaped
    p_escaped="$(_escape_bash_glob "$p")"
    local cmd_filtered="${cmd//\.${p_escaped}/}"
    if [[ "$cmd_filtered" != *"$p"* ]]; then
      continue
    fi
    basename="${p##*/}"
    if [ "$p" != "$PRIMARY_DIR/$basename" ] && [ "$p" != "$LEGACY_DIR/$basename" ]; then
      printf '%s' "$p"
      return 0
    fi
  done <<< "$matches"
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
    # .plan-approval-pending exists (Codex ...3503 P1).
    if marker_exists .plan-approval-pending; then
      if [ "$TARGET_BN" = ".plan-approval-pending" ]; then
        # Allow plan-marker removal — plan-gate.sh is what cares about this.
        exit 0
      fi
      _block_plan_pending
    fi
    case "$TARGET_BN" in
      .pre-checkpoint-done)
        if marker_exists .checkpoint-required && ! marker_nonempty .pre-checkpoint-done; then
          exit 0
        fi
        ;;
      .post-checkpoint-done)
        if marker_exists .post-checkpoint-required && ! marker_nonempty .post-checkpoint-done; then
          exit 0
        fi
        ;;
      .plan-approval-pending)
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
        # Cross-gate invariant
        if marker_exists .plan-approval-pending && [ "$TARGET_BN" != ".plan-approval-pending" ]; then
          _block_plan_pending
        fi
        case "$TARGET_BN" in
          .pre-checkpoint-done)
            if marker_exists .checkpoint-required && ! marker_nonempty .pre-checkpoint-done; then
              exit 0
            fi
            ;;
          .post-checkpoint-done)
            if marker_exists .post-checkpoint-required && ! marker_nonempty .post-checkpoint-done; then
              exit 0
            fi
            ;;
          .plan-approval-pending)
            exit 0
            ;;
        esac
      fi
    fi
    ;;
esac

if marker_exists .checkpoint-required && ! marker_nonempty .pre-checkpoint-done; then
  _block_pre
fi

# ---------------------------------------------------------------------------
# Push-gate: only fires for Bash classified as push_or_pr_create.
# ---------------------------------------------------------------------------
if [ "$TOOL_NAME" = "Bash" ] && [ "$LABEL" = "push_or_pr_create" ]; then
  if marker_exists .post-checkpoint-required && ! marker_nonempty .post-checkpoint-done; then
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
  if ! marker_exists .plan-approval-pending; then
    for _m in "${CHECKPOINT_CLEANUP_MARKERS[@]}"; do
      rm -f "$PRIMARY_DIR/$_m" "$LEGACY_DIR/$_m" 2>/dev/null || true
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
    if marker_exists .checkpoint-required && marker_nonempty .pre-checkpoint-done; then
      ensure_primary_dir "$REPO_ROOT" 2>/dev/null || true
      touch "$(write_marker_path "$REPO_ROOT" .post-checkpoint-required)" 2>/dev/null || true
    fi
    ;;
esac

exit 0
