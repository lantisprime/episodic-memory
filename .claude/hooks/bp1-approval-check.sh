#!/usr/bin/env bash
set -e

# bp1-approval-check.sh — RFC-004 H1 SessionStart hook (slice 2d-R / PR-2d-R).
#
# Companion to H2 (bp1-sweep-on-session.sh). Fires FIRST in SessionStart order
# (§559 H-cfg ordering invariant: approval-check before sweep) so that any
# expired/auto-approve-eligible markers transition the run BEFORE the
# deadline-sweep liveness pass runs.
#
# Responsibility: scan `<canonical_project_root>/.checkpoints/` for
# `bp1-approval-<run_id>.json` markers. For each marker:
#   (1) Derive run_id from filename via deterministic regex (§566).
#   (2) Call `bp1-marker-validate.mjs --project ... --run-id ...`.
#   (3) Branch on stdout `status` field:
#       - "missing"  → no-op (raced loss; not an error).
#       - "invalid"  → call `bp1-emit-marker-invalid-evidence.mjs` to emit
#         signed (Case A: key present) OR unsigned-stderr (Case B: key
#         missing) failure evidence. Marker stays on disk.
#       - "ok" + expired=true  → call orchestrator `confirm-approval
#         --outcome auto_approved`. Idempotent.
#       - "ok" + expired=false → no-op (deadline not yet).
#   (4) Filename unparseable (cannot derive run_id) → Case C: stderr-log
#       structured JSON from this hook directly (no helper invocation).
#
# §178 four-mode silent-exit contract (always exit 0):
#   - bp1 inert (flag-check refuses)          → silent no-op
#   - marker missing (race vs concurrent rm)  → silent no-op
#   - marker invalid Case A                    → signed episode + exit 0
#   - marker invalid Case B                    → stderr-only + exit 0
#   - marker invalid Case C unparseable name   → hook-stderr + exit 0
#   - marker invalid Case C unknown status     → hook-stderr + exit 0
#   - marker invalid Case C malformed validator→ hook-stderr + exit 0 (added
#     PR-level audit r1 P1 closure 2026-05-17)
#   - marker valid + not expired               → silent no-op
#   - marker valid + expired                   → confirm-approval + exit 0
#   - confirm-approval transient failure       → stderr-log + exit 0 (next
#     session retries; markTerminal is idempotent)
#
# Hook NEVER fails the Claude session. Even bp1-side bugs exit 0.
#
# cwd-binding (mirrors em-recall-sessionstart.sh:34-54 and
# bp1-sweep-on-session.sh:33-43):
#   - Reads SessionStart stdin JSON; parses `.cwd` field; falls back to `pwd`.
#   - cd "$CWD" BEFORE any node invocation. cd-fail → exit 0 silently.
#   - Computes $TOPLEVEL := realpath(git -C $CWD rev-parse --show-toplevel)
#     BEFORE flag-check (activation map keys on canonical toplevel).
#   - Passes `--project "$TOPLEVEL"` (NOT $CWD) explicitly to every subprocess
#     so the canonical-root contract holds even when SessionStart fires from
#     a subdir or linked worktree. codex r3 FU-2 closure 2026-05-17.
#
# Linked-worktree handling (RFC §646):
#   - The marker writer (record-awaiting-approval) canonicalizes via
#     `git rev-parse --show-toplevel`. In a linked worktree, that returns the
#     WORKTREE root (not the main checkout). This hook follows the same
#     resolution — see the $TOPLEVEL computation below.
#
# Script resolution (RFC-008 P4d / Principle 12 — relocated per-project 2026-06-19):
#   bp1 scripts install CO-LOCATED with this hook under <project>/.claude/hooks/,
#   resolved via $HOOK_DIR. NOT global. See bp1-sweep-on-session.sh:23-29.

INPUT="$(cat)"
# Guard stdin .cwd parse: malformed SessionStart JSON would otherwise propagate
# jq's exit code through the assignment statement (under `set -e`, the
# assignment's exit status IS the pipeline's last-command status). The
# `|| CWD=""` fallback makes the whole compound statement succeed under set -e
# regardless of jq's exit, and the empty-string fallback below kicks in.
# PR-level audit P1 closure 2026-05-17: codex reproduced hook exit 5 by feeding
# `not-json` to validator stdout; same vulnerability shape exists for stdin parse.
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)" || CWD=""
[ -z "$CWD" ] && CWD="$(pwd)"

# Soft-fail on cd failure (mirrors em-recall-sessionstart.sh:51).
if ! cd "$CWD" 2>/dev/null; then
  exit 0
fi

# RFC-008 P4d / Principle 12: the bp1 scripts install CO-LOCATED with this hook
# under <project>/.claude/hooks/, NOT in the global substrate. BASH_SOURCE is
# absolute (Claude Code registers hooks by absolute path), so this is cd-safe.
EM_SCRIPTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
FLAG_CHECK="$EM_SCRIPTS_DIR/bp1-flag-check.mjs"
VALIDATE="$EM_SCRIPTS_DIR/bp1-marker-validate.mjs"
EMIT_INVALID="$EM_SCRIPTS_DIR/bp1-emit-marker-invalid-evidence.mjs"
ORCHESTRATOR="$EM_SCRIPTS_DIR/bp1-orchestrator.mjs"

# Soft-fail if bp1 scripts aren't installed (project never ran install.mjs).
for s in "$FLAG_CHECK" "$VALIDATE" "$EMIT_INVALID" "$ORCHESTRATOR"; do
  if [ ! -f "$s" ]; then
    exit 0
  fi
done

# Resolve canonical project root via git toplevel BEFORE flag-check. $CWD may
# be a subdir / linked worktree path; the activation map in
# ~/.episodic-memory/config.json keys by the canonical toplevel (realpath of
# `git rev-parse --show-toplevel`), so flag-check must receive that path.
TOPLEVEL=""
if TOPLEVEL_RAW="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)"; then
  if TOPLEVEL_REAL="$(cd "$TOPLEVEL_RAW" 2>/dev/null && pwd -P)"; then
    TOPLEVEL="$TOPLEVEL_REAL"
  fi
fi
if [ -z "$TOPLEVEL" ]; then
  # Not a git repo (or git unavailable). Cannot locate markers safely. §178
  # silent-no-op — this hook is best-effort liveness.
  exit 0
fi

# Activation gate — silent on refusal per §178. --no-emit suppresses the
# per-call bp1-flag-check audit episode (would fire once per session start
# for every project; same rationale as bp1-sweep-on-session.sh:49-57).
if ! node "$FLAG_CHECK" --project "$TOPLEVEL" --no-emit >/dev/null 2>&1; then
  exit 0
fi

CHECKPOINTS_DIR="$TOPLEVEL/.checkpoints"
if [ ! -d "$CHECKPOINTS_DIR" ]; then
  exit 0
fi

# Marker filename regex (must match marker.mjs markerPath construction):
#   bp1-approval-<run_id>.json
#   where run_id matches /^bp1-run-[a-z0-9-]+$/
# Use `find` for predictable enumeration; `read -d` avoids splitting issues
# on filenames with spaces (markers never have spaces but defensive).
RUN_ID_RE='^bp1-run-[a-z0-9-]+$'

# Collect matches into a tempfile so we can iterate without spawning a
# subshell that loses our exit semantics (process-substitution `done < <(...)`
# is intentionally avoided per `feedback_shell_sigpipe_done_pipe.md` — early
# returns inside `done < <(producer)` leak SIGPIPE on Linux CI).
MARKER_LIST="$(mktemp)"
trap 'rm -f "$MARKER_LIST"' EXIT
find "$CHECKPOINTS_DIR" -maxdepth 1 -type f -name 'bp1-approval-*.json' \
  >"$MARKER_LIST" 2>/dev/null || true

while IFS= read -r MARKER_PATH; do
  [ -z "$MARKER_PATH" ] && continue
  BASENAME="$(basename "$MARKER_PATH")"
  # Strip `bp1-approval-` prefix + `.json` suffix to derive run_id.
  RUN_ID="${BASENAME#bp1-approval-}"
  RUN_ID="${RUN_ID%.json}"
  # Validate shape. Filename unparseable → Case C: stderr-log + skip.
  if ! [[ "$RUN_ID" =~ $RUN_ID_RE ]]; then
    EMITTED_AT="$(date -u +%FT%TZ)"
    # JSON-escape via jq -nc (codex r2 P2 closure 2026-05-17). String
    # interpolation here lets adversarial filenames break the JSON shape:
    # a marker named `bp1-approval-bad"id.json` would produce unparsable
    # stderr, breaking the Case C contract. jq --arg handles all
    # JSON-special characters correctly.
    jq -nc \
      --arg marker_path "$MARKER_PATH" \
      --arg basename "$BASENAME" \
      --arg emitted_at "$EMITTED_AT" \
      '{kind:"failure:bp1-marker-invalid-unparseable",case:"C",marker_path:$marker_path,basename:$basename,hook:"bp1-approval-check.sh",emitted_at:$emitted_at}' \
      1>&2
    continue
  fi

  # Validate marker. validate-script always exits 0 (status field encodes
  # outcome); we capture stdout as JSON. Pass --project $TOPLEVEL (canonical
  # root) NOT $CWD — when the hook fires from a subdir of the project, $CWD
  # is the subdir but markers live under the canonical toplevel's .checkpoints/.
  VALIDATE_OUT="$(node "$VALIDATE" --project "$TOPLEVEL" --run-id "$RUN_ID" 2>/dev/null || true)"
  if [ -z "$VALIDATE_OUT" ]; then
    continue
  fi
  # Guard STATUS parse against malformed validator stdout. Under `set -e`, the
  # assignment `var="$(... | jq ...)"` propagates jq's exit code; with no
  # fallback, malformed validator output crashes the hook (PR-level audit P1,
  # codex reproduced exit 5 with stdout "not-json"). The `|| STATUS=""`
  # fallback makes the compound statement succeed regardless of jq's exit, then
  # the empty-string check below emits Case C malformed-validator and
  # continues. Note: jq's `// ""` default fires on `null`/missing-key but NOT
  # on parse failure — the `|| STATUS=""` handles parse failure separately.
  STATUS="$(printf '%s' "$VALIDATE_OUT" | jq -r '.status // ""' 2>/dev/null)" || STATUS=""
  if [ -z "$STATUS" ]; then
    EMITTED_AT="$(date -u +%FT%TZ)"
    jq -nc \
      --arg marker_path "$MARKER_PATH" \
      --arg validate_stdout "$VALIDATE_OUT" \
      --arg emitted_at "$EMITTED_AT" \
      '{kind:"failure:bp1-marker-invalid-malformed-validator",case:"C",marker_path:$marker_path,validate_stdout:$validate_stdout,hook:"bp1-approval-check.sh",emitted_at:$emitted_at}' \
      1>&2
    continue
  fi
  case "$STATUS" in
    missing)
      # Race with concurrent unlink. Silent no-op.
      continue
      ;;
    invalid)
      REASON="$(printf '%s' "$VALIDATE_OUT" | jq -r '.reason // "unknown"' 2>/dev/null)" || REASON="unknown"
      # Emit signed (Case A) or unsigned-stderr (Case B) evidence.
      # CRITICAL: do NOT `2>&1` here. Case B's only evidence channel is the
      # helper's stderr JSON (key shredded post-finalize → no signing key,
      # so the helper falls back to stderr-only emission per the
      # three-case contract in scripts/bp1-emit-marker-invalid-evidence.mjs).
      # Suppressing stderr would silently discard the entire forensic trail
      # for key-missing invalid markers (codex r1 P1 closure).
      node "$EMIT_INVALID" \
        --project "$TOPLEVEL" \
        --run-id "$RUN_ID" \
        --reason "$REASON" \
        --marker-path "$MARKER_PATH" \
        >/dev/null || true
      continue
      ;;
    ok)
      EXPIRED="$(printf '%s' "$VALIDATE_OUT" | jq -r '.expired // false' 2>/dev/null)" || EXPIRED="false"
      if [ "$EXPIRED" = "true" ]; then
        # Transition to auto_approved. Confirm-approval is idempotent; on
        # transient failure (exit 3 marker-cleanup, exit 5 race), the marker
        # remains and a later session retries.
        node "$ORCHESTRATOR" confirm-approval \
          --project "$TOPLEVEL" \
          --run-id "$RUN_ID" \
          --outcome auto_approved \
          >/dev/null 2>&1 || true
      fi
      # Not expired → silent no-op.
      continue
      ;;
    *)
      # Unknown status. Defensive: log + continue.
      EMITTED_AT="$(date -u +%FT%TZ)"
      # JSON-escape via jq -nc (codex r2 P2 closure 2026-05-17 — same
      # rationale as the unparseable branch above).
      jq -nc \
        --arg marker_path "$MARKER_PATH" \
        --arg validate_status "$STATUS" \
        --arg emitted_at "$EMITTED_AT" \
        '{kind:"failure:bp1-marker-invalid-unknown-status",case:"C",marker_path:$marker_path,validate_status:$validate_status,hook:"bp1-approval-check.sh",emitted_at:$emitted_at}' \
        1>&2
      continue
      ;;
  esac
done < "$MARKER_LIST"

exit 0
