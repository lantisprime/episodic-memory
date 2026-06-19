#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-16.1
# preflight-prompt-helper.sh — UserPromptSubmit hook for true prompt-binding.
#
# Maintains prompt-bound preflight state for the current session:
#   - `<repo>/.checkpoints/.last-user-prompt.<session_id>.json`
#   - `<repo>/.checkpoints/.preflight-done.<session_id>`
#
# The preflight-gate (hooks/preflight-gate.sh) cross-checks the latter marker's
# `prompt_sha256` against the former. Keeping both writes in UserPromptSubmit
# means marker ownership follows the hook that actually sees the prompt; the
# agent no longer has to bootstrap prompt-bound gate state mid-session.
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
#   6) Compose + atomically write a codex-review-handoff preflight marker for
#      the same sid/prompt hash. This is intentionally hook-owned (#285).
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

_log_and_exit_safe_post_lp() {
  # PR #291 A1: used on skip paths that fire AFTER the last-prompt marker
  # has already been written. Unlinks it so the next UserPromptSubmit
  # cycle starts clean instead of leaving fresh last-prompt + stale
  # preflight markers (which would cause the gate to deny on a generic
  # sha-mismatch rather than the actual cause).
  rm -f "$REPO_ROOT/.checkpoints/.last-user-prompt.${SESSION_ID}.json" 2>/dev/null || true
  _log_and_exit_safe "$1"
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

# Locate the canon lib + marker-write helper. RFC-008 P4d / Principle 12: prefer
# the CO-LOCATED per-project copies ($HOOK_DIR — enforcement installs together,
# never global); then in-repo (development); then legacy global install.
CANON_LIB=""
HELPER=""
for cand in \
  "$HOOK_DIR/lib/preflight-prompt-canon.mjs" \
  "$REPO_ROOT/scripts/lib/preflight-prompt-canon.mjs" \
  "${HOME:-/}/.episodic-memory/scripts/lib/preflight-prompt-canon.mjs"
do
  if [ -f "$cand" ]; then CANON_LIB="$cand"; break; fi
done
for cand in \
  "$HOOK_DIR/preflight-marker-write.mjs" \
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

# ---------------------------------------------------------------------------
# Compose the hook-owned preflight marker (#285)
# ---------------------------------------------------------------------------
# The gate currently requires the canonical bundle itself in required_files and
# validates all required_files against loaded_files. Keep this marker small and
# deterministic: it proves hook ownership + prompt binding, while avoiding a
# brittle duplicate parser for the bundle's prose manifest.
BUNDLE_PATH="$REPO_ROOT/bundles/codex-review-channel-current.md"
if [ ! -f "$BUNDLE_PATH" ]; then
  _log_and_exit_safe_post_lp "codex review bundle missing at $BUNDLE_PATH; rolling back last-prompt marker so gate denies cleanly"
fi

BUNDLE_SHA="$(shasum -a 256 "$BUNDLE_PATH" 2>/dev/null | awk '{print $1}')"
BUNDLE_MTIME="$(node -e "process.stdout.write(String(require('fs').statSync(process.argv[1]).mtimeMs))" "$BUNDLE_PATH" 2>/dev/null || true)"
if [ -z "$BUNDLE_SHA" ] || [ -z "$BUNDLE_MTIME" ]; then
  _log_and_exit_safe_post_lp "could not stat/hash codex review bundle; rolling back last-prompt marker so gate denies cleanly"
fi

# ---------------------------------------------------------------------------
# Resolve memory_root + parse bundle manifest for the 7 review-channel
# components (PR #291 codex round-1 finding #1: marker must hash all
# components, not just the bundle, to preserve the gate's review-channel
# invariant).
# ---------------------------------------------------------------------------
MEMORY_ROOT=""
CONFIG_FILE="$REPO_ROOT/.episodic-memory/config.json"
if [ -f "$CONFIG_FILE" ]; then
  MEMORY_ROOT="$(jq -r '.claude_memory_root // ""' "$CONFIG_FILE" 2>/dev/null)"
  if [ -n "$MEMORY_ROOT" ] && [ ! -d "$MEMORY_ROOT" ]; then
    MEMORY_ROOT=""
  fi
fi
if [ -z "$MEMORY_ROOT" ]; then
  # Keep this bounded and deterministic: derive candidates only from the
  # resolved repo root, mirroring session-handoff-prompt.sh. The observed
  # Claude project path on this machine has existed in both canonical
  # `charltondho` and drifted `charltond-ho` forms; pick the first candidate
  # that actually contains memory markdown, not merely an empty directory.
  SANITIZED="$(printf '%s' "$REPO_ROOT" | sed 's|/|-|g; s|\.|-|g')"
  CANONICAL_MEM="${HOME:-/}/.claude/projects/${SANITIZED}/memory"
  VARIANT_SANITIZED="$(printf '%s' "$SANITIZED" | sed 's|charltondho|charltond-ho|')"
  VARIANT_MEM="${HOME:-/}/.claude/projects/${VARIANT_SANITIZED}/memory"
  for cand in "$CANONICAL_MEM" "$VARIANT_MEM"; do
    if [ -d "$cand" ] && ls "$cand"/*.md >/dev/null 2>&1; then
      MEMORY_ROOT="$cand"
      break
    fi
  done
fi
if [ -z "$MEMORY_ROOT" ] || [ ! -d "$MEMORY_ROOT" ]; then
  _log_and_exit_safe_post_lp "memory_root not resolvable from config or bounded HOME candidates; rolling back last-prompt marker so gate denies cleanly"
fi

# Extract component basenames from the bundle's json:bundle-manifest block.
COMPONENT_BASENAMES="$(node -e "
const fs = require('fs');
const md = fs.readFileSync(process.argv[1], 'utf8');
const m = md.match(/\`\`\`json:bundle-manifest\n([\s\S]*?)\n\`\`\`/);
if (!m) { process.stderr.write('bundle-manifest fence not found'); process.exit(1); }
const data = JSON.parse(m[1]);
if (!Array.isArray(data.components)) { process.stderr.write('components is not an array'); process.exit(2); }
process.stdout.write(data.components.map(c => c.basename).join('\n'));
" "$BUNDLE_PATH" 2>/dev/null)"
if [ -z "$COMPONENT_BASENAMES" ]; then
  _log_and_exit_safe_post_lp "could not parse bundle manifest for components; rolling back last-prompt marker so gate denies cleanly"
fi

# Seed required_files / loaded_files with the bundle itself, then append
# every component listed in the manifest (resolved under memory_root).
REQUIRED_PATHS_JSON="$(jq -nc --arg p "$BUNDLE_PATH" '[$p]')"
LOADED_ENTRIES_JSON="$(jq -nc --arg p "$BUNDLE_PATH" --arg s "$BUNDLE_SHA" --argjson mt "$BUNDLE_MTIME" '[{path: $p, mtime_ms: $mt, sha256: $s}]')"

while IFS= read -r BASENAME; do
  [ -z "$BASENAME" ] && continue
  COMP_PATH="$MEMORY_ROOT/$BASENAME"
  if [ ! -f "$COMP_PATH" ]; then
    _log_and_exit_safe_post_lp "bundle component $BASENAME not at $COMP_PATH; rolling back last-prompt marker so gate denies cleanly"
  fi
  COMP_SHA="$(shasum -a 256 "$COMP_PATH" 2>/dev/null | awk '{print $1}')"
  COMP_MTIME="$(node -e "process.stdout.write(String(require('fs').statSync(process.argv[1]).mtimeMs))" "$COMP_PATH" 2>/dev/null || true)"
  if [ -z "$COMP_SHA" ] || [ -z "$COMP_MTIME" ]; then
    _log_and_exit_safe_post_lp "could not hash/stat bundle component $BASENAME at $COMP_PATH; rolling back last-prompt marker so gate denies cleanly"
  fi
  REQUIRED_PATHS_JSON="$(printf '%s' "$REQUIRED_PATHS_JSON" | jq -c --arg p "$COMP_PATH" '. + [$p]')"
  LOADED_ENTRIES_JSON="$(printf '%s' "$LOADED_ENTRIES_JSON" | jq -c --arg p "$COMP_PATH" --arg s "$COMP_SHA" --argjson mt "$COMP_MTIME" '. + [{path: $p, mtime_ms: $mt, sha256: $s}]')"
done <<< "$COMPONENT_BASENAMES"

PREFLIGHT_JSON="$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg tp "$TRANSCRIPT_PATH" \
  --arg sha "$PROMPT_SHA" \
  --arg cwd "$CWD" \
  --arg root "$REPO_ROOT" \
  --arg memory_root "$MEMORY_ROOT" \
  --argjson required "$REQUIRED_PATHS_JSON" \
  --argjson loaded "$LOADED_ENTRIES_JSON" \
  --argjson ms "$WROTE_AT_MS" \
  '{
    session_id: $sid,
    transcript_path: $tp,
    prompt_sha256: $sha,
    prompt_index: 0,
    cwd: $cwd,
    repo_root: $root,
    memory_root: $memory_root,
    claim_class: "codex-review-handoff",
    matched_triggers: {hook: ["UserPromptSubmit:codex-review-handoff"]},
    required_files: $required,
    loaded_files: $loaded,
    artifact_steps_done: ["user-prompt-submit-hook", "codex-review-bundle-hash", "codex-review-components-hash"],
    created_at_ms: $ms
  }')"
if [ -z "$PREFLIGHT_JSON" ]; then
  _log_and_exit_safe_post_lp "jq composition of preflight marker JSON failed; rolling back last-prompt marker so gate denies cleanly"
fi

PREFLIGHT_OUT="$(printf '%s' "$PREFLIGHT_JSON" | node "$HELPER" --root "$REPO_ROOT" --target preflight --session-id "$SESSION_ID" 2>&1)"
PREFLIGHT_EC=$?
if [ $PREFLIGHT_EC -ne 0 ]; then
  _log_and_exit_safe_post_lp "preflight marker-write helper exit $PREFLIGHT_EC: $PREFLIGHT_OUT"
fi

# Success — exit 0 with no stdout. Claude Code's hooks framework treats
# empty stdout on UserPromptSubmit as no-op (per ref:230); no decision
# emitted, no additional context injected. The file is the side effect.
exit 0
