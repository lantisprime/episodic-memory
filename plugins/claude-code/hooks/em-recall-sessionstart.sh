#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-06-18.1
# em-recall-sessionstart.sh — RFC-002 Phase 3b SessionStart hook
#
# RFC-008 P3d (F38/F60): the SessionStart enforcement side-effects (the
# .session-baseline write, the legacy-plan-marker + preflight-orphan sweeps, and
# the bp-001 advisory) RELOCATED out of the memory substrate (em-recall.mjs) into
# the enforcement layer (enforce-contract.mjs --session-start). This hook now
# invokes enforce-contract directly — exactly parallel to P3b-1's stop-gate.sh
# repoint. em-recall is pure recall and is no longer called here: its recall body
# was already discarded to /dev/null (#61, not yet surfaced as SessionStart
# additionalContext), so the only observable output of the former call was the
# advisory, which enforce-contract now emits.
#
# Per Codex review: parse cwd from stdin, cd to it, then run enforce-contract
# with no project arg so cwd/git inference owns project resolution. This keeps
# the enforcement layer's marker root and checkpoint-gate.sh's marker root
# aligned (resolveRepoRoot() from the same cwd, byte-faithful with the former
# em-recall resolution).
#
# Idempotent: enforce-contract --session-start is best-effort and re-runnable
# (multiple SessionStart firings, --resume, etc.) — the force-monotonic baseline
# write tolerates re-invocation.
#
# .session-baseline is the stop-gate's reference point: any task-signal marker
# (.checkpoint-required, .post-checkpoint-required, .plan-approval-pending) with
# mtime > baseline was created mid-session and prevents the no-task-signal
# carve-out. Stale .plan-approval-pending predating the prior baseline is cleared
# here (orphan from a crashed prior session).

INPUT="$(cat)"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

# RFC-008 P4d / Principle 12: enforce-contract.mjs is the enforcement ENGINE,
# installed CO-LOCATED with this hook under <project>/.claude/hooks/, never in the
# global substrate. Resolve via BASH_SOURCE (symlink-safe).
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
ENFORCE="$HOOK_DIR/enforce-contract.mjs"

_em_join_list() {
  local out=""
  local item
  for item in "$@"; do
    [ -n "$out" ] && out="$out, "
    out="$out$item"
  done
  printf '%s' "$out"
}

warn_hook_freshness() {
  local manifest="$HOME/.episodic-memory/hook-install.json"
  [ -f "$manifest" ] || return 0

  local source_repo
  if ! source_repo="$(jq -r '.source_repo // empty' "$manifest" 2>/dev/null)"; then
    echo "episodic-memory: hook freshness warning: could not parse $manifest"
    return 0
  fi
  [ -n "$source_repo" ] || return 0

  # Probe only the repo root, not a fixed subdirectory layout. The old
  # `$source_repo/hooks` probe broke when PR #373 moved hooks to
  # plugins/claude-code/hooks/ — every SessionStart printed a false
  # "source repo unavailable" warning. The per-file loop below already
  # classifies missing/relocated sources (missing_source bucket).
  if [ ! -d "$source_repo" ]; then
    echo "episodic-memory: hook freshness warning: source repo unavailable: $source_repo"
    echo "episodic-memory: installed Claude hooks may be stale; re-run install.mjs --install-hooks from the current episodic-memory repo."
    return 0
  fi

  local rows
  if ! rows="$(jq -r '.files[]? | select((.relative_path // "") != "" and (.installed_path // "") != "") | [.relative_path, .installed_path] | @tsv' "$manifest" 2>/dev/null)"; then
    echo "episodic-memory: hook freshness warning: could not read file list from $manifest"
    return 0
  fi
  [ -n "$rows" ] || return 0

  local stale=()
  local missing_installed=()
  local missing_source=()
  local rel installed src
  while IFS=$'\t' read -r rel installed; do
    [ -n "$rel" ] || continue
    src="$source_repo/$rel"
    if [ ! -f "$src" ]; then
      missing_source+=("$rel")
    elif [ ! -f "$installed" ]; then
      missing_installed+=("$rel")
    elif ! cmp -s "$src" "$installed"; then
      stale+=("$rel")
    fi
  done <<< "$rows"

  if [ "${#stale[@]}" -eq 0 ] \
    && [ "${#missing_installed[@]}" -eq 0 ] \
    && [ "${#missing_source[@]}" -eq 0 ]; then
    return 0
  fi

  if [ "${#stale[@]}" -gt 0 ]; then
    echo "episodic-memory: installed Claude hooks differ from source repo: $(_em_join_list "${stale[@]}")"
  fi
  if [ "${#missing_installed[@]}" -gt 0 ]; then
    echo "episodic-memory: installed Claude hooks are missing: $(_em_join_list "${missing_installed[@]}")"
  fi
  if [ "${#missing_source[@]}" -gt 0 ]; then
    echo "episodic-memory: hook freshness manifest references missing source files: $(_em_join_list "${missing_source[@]}")"
  fi
  echo "episodic-memory: no files were overwritten. Inspect the diff or opt in with:"
  echo "episodic-memory: node \"$source_repo/install.mjs\" --tool claude-code --project \"$CWD\" --install-hooks --install-hooks-force"
}

warn_hook_freshness

# ─── second-opinion runbook UX-marker cleanup ────────────────────────────
# Glob-clear all `.checkpoints/.so-runbook-shown.*` files at canonical repo
# root so the next session re-injects the runbook on the first harness
# invocation. Bound to canonical root (not $CWD) via repo-root.sh so
# linked-worktree session starts converge on the same place the gate writes.
#
# Codex r4 Q1: contained-subshell sourcing so any internal failure in
# repo-root.sh (or missing lib on partial install) falls back to $CWD
# without aborting SessionStart under `set -e`.
CANONICAL_ROOT="$(
  bash -c '
    LIB_DIR="$1/lib"
    LIB="$LIB_DIR/repo-root.sh"
    [ -f "$LIB" ] || { printf "%s" "$2"; exit 0; }
    # shellcheck disable=SC1090
    . "$LIB" 2>/dev/null || { printf "%s" "$2"; exit 0; }
    resolve_repo_root "$2" 2>/dev/null || printf "%s" "$2"
  ' _ "$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" "$CWD"
)"
[ -z "$CANONICAL_ROOT" ] && CANONICAL_ROOT="$CWD"
if [ -d "$CANONICAL_ROOT/.checkpoints" ]; then
  # shellcheck disable=SC2086
  rm -f "$CANONICAL_ROOT"/.checkpoints/.so-runbook-shown.* 2>/dev/null || true
fi

# Soft-fail if enforce-contract isn't installed — sessions without
# episodic-memory should still start cleanly.
if [ ! -f "$ENFORCE" ]; then
  exit 0
fi

# If $CWD is invalid (nonexistent / unreadable), fail soft instead of running
# enforce-contract in whatever directory the hook process inherited from. Per
# #70: without this guard, the --session-start baseline write could land in an
# unrelated project, causing checkpoint-gate.sh to fire spuriously in the next
# session of that wrong project.
if ! cd "$CWD" 2>/dev/null; then
  exit 0
fi

# Planning-passive redesign (2026-05-25): the pre-checkpoint marker is NOT armed
# at session start. When a recent bp-001 violation exists, enforce-contract
# --session-start emits an ADVISORY on a dedicated `__BP1_ADVISORY__` stderr
# sentinel (warning, not a block). Capture stderr (stdout → /dev/null: the
# side-effect mode emits no recall JSON) and surface just the advisory line as
# SessionStart context — matching the plain-stdout pattern warn_hook_freshness
# already uses.
EM_ERR="$(node "$ENFORCE" --session-start 2>&1 >/dev/null || true)"

BP1_ADVISORY="$(printf '%s\n' "$EM_ERR" | grep '^__BP1_ADVISORY__ ' | head -n1 | sed 's/^__BP1_ADVISORY__ //')"
if [ -n "$BP1_ADVISORY" ]; then
  echo "episodic-memory: $BP1_ADVISORY"
fi

exit 0
