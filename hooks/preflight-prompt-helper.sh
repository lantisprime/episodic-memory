#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-12.2
# preflight-prompt-helper.sh — UserPromptSubmit hook for true prompt-binding.
#
# Maintains `<repo>/.checkpoints/.last-user-prompt.<session_id>.json` with the
# canonical sha256 of the current real user prompt. The preflight-gate
# (hooks/preflight-gate.sh) cross-checks that file's `prompt_sha256` against
# any codex-review-handoff pre-flight marker — closing the trust-based hole
# left open by PR #240 (which took the FALLBACK path of trusting agent-supplied
# sha values without comparison to ground truth).
#
# Plan provenance: scratch/238-plan-v2.md C3 (workplan v49 rank 0). Closes
# #238 PR1 FU-C2. Audit findings folded in: F3 (pin canonicalization),
# F4 (session-namespaced file), F5 (no hooks/lib dependency — keep tight),
# F6 (UserPromptSubmit ordering documented as external contract).
#
# Behavior:
#   1) Read stdin (Claude Code UserPromptSubmit payload):
#        { prompt, session_id, transcript_path, cwd, hook_event_name, ... }
#   2) Resolve repo root from cwd.
#   3) Compute canonical sha256 via scripts/lib/preflight-prompt-canon.mjs
#      (binding contract: sha256(utf8_bytes(JSON.parse(stdin).prompt))).
#   4) Compose marker JSON (sha + session_id + transcript_path + cwd + wrote_at_ms).
#   5) Pipe to scripts/preflight-marker-write.mjs --target last-prompt
#      --session-id <sid>, which atomically temp+renames the file into place.
#
# Fail-safe (audit F3 I3): on ANY internal error (malformed stdin, helper
# missing, session_id invalid, jq failure, repo-root unresolvable), exit 0
# + log to stderr. NEVER block a real user prompt; degraded enforcement
# is strictly better than hard-stop-on-bug.

set -u
# Deliberately NOT `set -e`: every step is wrapped to fail-safe via the
# `_log_and_exit_safe` helper. errexit could fire on transient pipe
# failures (e.g. jq early exit) and silently block the prompt.

# ---------------------------------------------------------------------------
# Read input
# ---------------------------------------------------------------------------
INPUT="$(cat 2>/dev/null || true)"

_log_and_exit_safe() {
  # Fail-safe: log to stderr, then exit 0. The hook framework captures
  # stderr to the debug log per Claude Code hooks reference, but the
  # user's prompt flow is not blocked.
  printf 'preflight-prompt-helper: %s\n' "$1" >&2
  exit 0
}

if [ -z "$INPUT" ]; then
  _log_and_exit_safe "empty stdin; skipping"
fi

# Validate JSON shape minimally. Full validation lives in canon lib.
if ! printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1; then
  _log_and_exit_safe "stdin is not a JSON object; skipping"
fi

SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)"
TRANSCRIPT_PATH="$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)"

[ -z "$CWD" ] && CWD="$(pwd)"

if [ -z "$SESSION_ID" ]; then
  _log_and_exit_safe "stdin missing session_id; skipping"
fi

# Validate session_id format (same regex as helper rejects). Done here
# too so we don't bother shelling out to node for an invalid value.
case "$SESSION_ID" in
  *[!A-Za-z0-9_-]*) _log_and_exit_safe "session_id has invalid chars; skipping" ;;
esac
if [ ${#SESSION_ID} -gt 128 ] || [ ${#SESSION_ID} -lt 1 ]; then
  _log_and_exit_safe "session_id length out of bounds; skipping"
fi

# ---------------------------------------------------------------------------
# Resolve repo root + dependent paths
# ---------------------------------------------------------------------------
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
if [ ! -f "$LIB_DIR/repo-root.sh" ]; then
  _log_and_exit_safe "hooks/lib/repo-root.sh missing; skipping (re-run install.mjs --install-hooks)"
fi
# shellcheck disable=SC1091
. "$LIB_DIR/repo-root.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  _log_and_exit_safe "repo root unresolved from cwd=$CWD; skipping"
fi

# Locate the canon lib + marker-write helper. Prefer in-repo paths
# (development), fall back to the global install (~/.episodic-memory/).
CANON_LIB=""
HELPER=""
for cand in \
  "$REPO_ROOT/scripts/lib/preflight-prompt-canon.mjs" \
  "${HOME:-/}/.episodic-memory/scripts/lib/preflight-prompt-canon.mjs"
do
  if [ -f "$cand" ]; then CANON_LIB="$cand"; break; fi
done
for cand in \
  "$REPO_ROOT/scripts/preflight-marker-write.mjs" \
  "${HOME:-/}/.episodic-memory/scripts/preflight-marker-write.mjs"
do
  if [ -f "$cand" ]; then HELPER="$cand"; break; fi
done
[ -z "$CANON_LIB" ] && _log_and_exit_safe "canonicalize lib not found in repo or ~/.episodic-memory/; skipping"
[ -z "$HELPER" ] && _log_and_exit_safe "marker-write helper not found in repo or ~/.episodic-memory/; skipping"

# ---------------------------------------------------------------------------
# Compute canonical sha via canon lib
# ---------------------------------------------------------------------------
# We hand the lib the entire stdin so it does the JSON.parse + .prompt
# extract + utf-8 byte encode itself — keeping the binding logic in one
# place. The lib exits non-zero on bad input; treat that as fail-safe.
PROMPT_SHA="$(printf '%s' "$INPUT" | node -e \
  "import('$CANON_LIB').then(m => { let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => s+=d); process.stdin.on('end', () => { try { process.stdout.write(m.canonicalPromptSha256(s)) } catch (e) { process.stderr.write(e.message); process.exit(2) } }) })" \
  2>/dev/null)"
if [ -z "$PROMPT_SHA" ] || [ "${#PROMPT_SHA}" -ne 64 ]; then
  _log_and_exit_safe "canonical sha computation returned empty or wrong length; skipping"
fi

# ---------------------------------------------------------------------------
# Compose marker JSON via jq (safe argument-passing, no heredoc escape risk)
# ---------------------------------------------------------------------------
WROTE_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0)"

MARKER_JSON="$(jq -nc \
  --arg sha "$PROMPT_SHA" \
  --arg sid "$SESSION_ID" \
  --arg tp "$TRANSCRIPT_PATH" \
  --arg cwd "$CWD" \
  --arg root "$REPO_ROOT" \
  --argjson ms "$WROTE_AT_MS" \
  '{prompt_sha256: $sha, session_id: $sid, transcript_path: $tp, cwd: $cwd, repo_root: $root, wrote_at_ms: $ms}')"
if [ -z "$MARKER_JSON" ]; then
  _log_and_exit_safe "jq composition of marker JSON failed; skipping"
fi

# ---------------------------------------------------------------------------
# Pipe to marker-write helper
# ---------------------------------------------------------------------------
HELPER_OUT="$(printf '%s' "$MARKER_JSON" | node "$HELPER" --root "$REPO_ROOT" --target last-prompt --session-id "$SESSION_ID" 2>&1)"
HELPER_EC=$?
if [ $HELPER_EC -ne 0 ]; then
  _log_and_exit_safe "marker-write helper exit $HELPER_EC: $HELPER_OUT"
fi

# Success — exit 0 with no stdout. Claude Code's hooks framework treats
# empty stdout on UserPromptSubmit as no-op (per ref:230); no decision
# emitted, no additional context injected. The file is the side effect.
exit 0
