#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-12.1
# preflight-gate.sh — Layer D narrow PreToolUse gate.
#
# Closes the bp-010 cluster: codex/Agent/em-store review handoffs (and
# rule-bearing-file edits) must produce a structured memory pre-flight
# marker BEFORE the tool call lands.
#
# Architecture (codex consensus chain `...ed24` → `...dbf6`, 5 rounds):
#   1) classify_preflight_tool returns claim-class for the proposed call.
#      `none` → exit 0 (allow).
#   2) Else: validate `<repo>/.checkpoints/.preflight-done` exists, is JSON,
#      matches current session/prompt, declares this claim-class, lists
#      required_files, hashes match disk, artifact_steps_done present.
#   3) Marker-write enforcement: deny direct Write/Edit/MultiEdit to the
#      final preflight marker path (helper-only contract). Path matching
#      uses canonicalize-path-tolerant for symlink-safety (F2h-n).
#   4) Helper-invocation enforcement: deny `Bash node *preflight-marker-write.mjs`
#      missing `--root` (defense-in-depth even if allowlist permits).
#
# Output: hookSpecificOutput.permissionDecision per Claude Code spec.
# Reason strings are ACTIONABLE: name marker path + bundle + missing field.
#
# Read/Grep/Test/Agent are exempt at the tool-name level (same carve-out as
# checkpoint-gate.sh). Agent dispatches with codex/negative-scenario subtype
# are gated by classify_preflight_tool emitting codex-review-handoff.
#
# Composes with:
#   - hooks/lib/command-classifier.sh   classify_preflight_tool
#   - hooks/lib/marker-paths.sh         primary/legacy paths
#   - hooks/lib/repo-root.sh            resolve_repo_root
#   - scripts/lib/canonicalize-path-tolerant.mjs  symlink-safe match (via node -e)

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
TOOL_INPUT_JSON="$(echo "$INPUT" | jq -c '.tool_input // {}')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"
SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // ""')"
TRANSCRIPT_PATH="$(echo "$INPUT" | jq -r '.transcript_path // ""')"

# Source helpers. Same pattern as checkpoint-gate.sh; symlink-safe via BASH_SOURCE.
HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
LIB_DIR="$HOOK_DIR/lib"
for f in command-classifier.sh repo-root.sh marker-paths.sh; do
  if [ ! -f "$LIB_DIR/$f" ]; then
    jq -nc --arg f "$f" \
      '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ("preflight-gate.sh: hooks/lib/" + $f + " not found. Re-run install.mjs --install-hooks.")}}'
    exit 0
  fi
done
# shellcheck disable=SC1091
source "$LIB_DIR/repo-root.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/command-classifier.sh"
# shellcheck disable=SC1091
source "$LIB_DIR/marker-paths.sh"

REPO_ROOT="$(resolve_repo_root "$CWD")"
PRIMARY_DIR="$REPO_ROOT/$PRIMARY_MARKER_DIR"
PREFLIGHT_MARKER="$PRIMARY_DIR/.preflight-done"
LAST_PROMPT_MARKER="$PRIMARY_DIR/.last-user-prompt.json"
HELPER_PATH="$REPO_ROOT/scripts/preflight-marker-write.mjs"
CANON_LIB="$REPO_ROOT/scripts/lib/canonicalize-path-tolerant.mjs"
BUNDLE_PATH="$REPO_ROOT/bundles/codex-review-channel-current.md"

# ---------------------------------------------------------------------------
# Tool-level read-only carve-out (mirror checkpoint-gate.sh).
# Note: Agent IS gated here because classify_preflight_tool inspects
# subagent_type for codex:* / negative-scenario-* patterns. Pure read tools
# stay exempt.
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Read|Glob|Grep|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|NotebookRead|ToolSearch|mcp__*)
    exit 0
    ;;
esac

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_emit_deny() {
  local reason="$1"
  jq -nc --arg r "$reason" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
}

# _canonicalize_one <input-path> <hook-cwd>
# Echoes canonical path on stdout; returns 0 on success, non-zero on
# canonicalization failure (SYMLOOP_MAX, EACCES, lib-missing). CALLER must
# check exit status and call _emit_deny — never call _emit_deny from inside
# this function because it runs inside a $() subshell and exit would only
# kill the subshell, not the gate process.
_canonicalize_one() {
  local input="$1" hookcwd="$2"
  if [ ! -f "$CANON_LIB" ]; then
    return 99   # signals "lib missing"
  fi
  # Use top-level await via async IIFE so import-rejection propagates as
  # a non-zero exit deterministically.
  node -e "(async () => { try { const m = await import('$CANON_LIB'); process.stdout.write(m.canonicalizePathTolerant(process.argv[1], process.argv[2])) } catch (e) { process.stderr.write(e.message || String(e)); process.exit(2) } })()" "$input" "$hookcwd" 2>&1
  return $?
}

# ---------------------------------------------------------------------------
# Marker-write enforcement (FU-4 + F2 canonicalization).
# Deny direct Write/Edit/MultiEdit/NotebookEdit to .preflight-done /
# .last-user-prompt.json regardless of marker state — helper is the only
# sanctioned writer.
# ---------------------------------------------------------------------------
case "$TOOL_NAME" in
  Write|Edit|MultiEdit|NotebookEdit)
    TOOL_PATH="$(printf '%s' "$TOOL_INPUT_JSON" | jq -r '.file_path // .path // .notebook_path // ""')"
    if [ -n "$TOOL_PATH" ]; then
      # Disable errexit around command-substitution exit-code capture; bash
      # 3.2's errexit can fire on assignment when the subshell exits non-zero.
      set +e
      CANON_TOOL="$(_canonicalize_one "$TOOL_PATH" "$CWD")"
      ec_tool=$?
      CANON_PREFLIGHT="$(_canonicalize_one "$PREFLIGHT_MARKER" "$REPO_ROOT")"
      ec_pf=$?
      CANON_LAST_PROMPT="$(_canonicalize_one "$LAST_PROMPT_MARKER" "$REPO_ROOT")"
      ec_lp=$?
      set -e
      if [ $ec_tool -eq 99 ]; then
        _emit_deny "preflight-gate.sh: canonicalize-path-tolerant lib missing at $CANON_LIB. Re-run install.mjs --install-hooks."
      fi
      if [ $ec_tool -ne 0 ]; then
        _emit_deny "preflight-gate.sh: path canonicalization failed for '$TOOL_PATH': $CANON_TOOL — refusing to evaluate $TOOL_NAME. Use: node $HELPER_PATH --root $REPO_ROOT --target preflight"
      fi
      # Marker-path canonicalization should never fail (paths are simple,
      # no symlinks expected). If it does → conservative deny.
      if [ $ec_pf -ne 0 ] || [ $ec_lp -ne 0 ]; then
        _emit_deny "preflight-gate.sh: failed to canonicalize marker paths; gate cannot evaluate. Re-run install.mjs --install-hooks."
      fi
      if [ "$CANON_TOOL" = "$CANON_PREFLIGHT" ] || [ "$CANON_TOOL" = "$CANON_LAST_PROMPT" ]; then
        _emit_deny "Direct $TOOL_NAME to preflight marker is forbidden. Use the atomic helper: echo '<JSON>' | node $HELPER_PATH --root $REPO_ROOT --target preflight (or --target last-prompt). Resolved tool path: $CANON_TOOL."
      fi
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# Helper-invocation enforcement (FU-3): Bash invoking the helper without
# explicit --root is denied at gate layer (defense in depth even when the
# settings.json allowlist permits).
# ---------------------------------------------------------------------------
if [ "$TOOL_NAME" = "Bash" ]; then
  CMD="$(printf '%s' "$TOOL_INPUT_JSON" | jq -r '.command // ""')"
  if [ -n "$CMD" ]; then
    # Normalize whitespace (tabs / multi-space / line continuations) so
    # variants like `node\t/abs/.../preflight-marker-write.mjs` or
    # `node \\` + newline + path slip through to the same matcher (A3).
    NORMALIZED_CMD="$(printf '%s' "$CMD" | tr '\t\n' '  ' | sed 's/\\ / /g; s/  */ /g')"
    # Match any helper invocation: node|npx|bash, bare basename `preflight-
    # marker-write.mjs`, or any path ending in that basename. Closes A1
    # asymmetry with the codex/em-* classifier in command-classifier.sh
    # which already handles bare/npx/script-shebang invocations.
    if printf '%s' "$NORMALIZED_CMD" | grep -qE '(\bnode |\bnpx |\bbash )?[^[:space:]]*\bpreflight-marker-write\.mjs\b'; then
      if ! printf '%s' "$NORMALIZED_CMD" | grep -qE '\-\-root[[:space:]]+[^[:space:]]'; then
        _emit_deny "preflight-marker-write.mjs invoked without explicit --root. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt>. No cwd fallback (ROOT_REQUIRED)."
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Claim-class classification + marker validation.
# ---------------------------------------------------------------------------
CLASS_RESULT="$(classify_preflight_tool "$TOOL_NAME" "$TOOL_INPUT_JSON" "$REPO_ROOT")"
CLAIM_CLASS="${CLASS_RESULT%%	*}"

# v1 enforcement: only codex-review-handoff is enforced. Other classes
# (rule-bearing-file-edit, plan-time-matrix, scratch-files,
# wrap-up-discipline, adversarial-code-review) registered for shape but
# allowed pass-through in PR1. PR2+ will enable them.
if [ "$CLAIM_CLASS" != "codex-review-handoff" ]; then
  exit 0
fi

# Marker existence
if [ ! -f "$PREFLIGHT_MARKER" ]; then
  _emit_deny "Pre-flight marker required for codex-review-handoff. Write to $PREFLIGHT_MARKER via: echo '<JSON>' | node $HELPER_PATH --root $REPO_ROOT --target preflight. Required JSON fields: session_id, transcript_path, prompt_sha256, prompt_index, cwd, repo_root, memory_root, claim_class=\"codex-review-handoff\", matched_triggers, required_files (must include $BUNDLE_PATH), loaded_files (with sha256+mtime_ms per file), artifact_steps_done. Bundle: $BUNDLE_PATH."
fi

# JSON parse
MARKER_JSON="$(cat "$PREFLIGHT_MARKER" 2>/dev/null || true)"
if [ -z "$MARKER_JSON" ]; then
  _emit_deny "Pre-flight marker $PREFLIGHT_MARKER is empty. Write a valid JSON marker via the helper. May indicate a write-in-progress race; retry."
fi
if ! printf '%s' "$MARKER_JSON" | jq empty 2>/dev/null; then
  _emit_deny "Pre-flight marker $PREFLIGHT_MARKER is not valid JSON. Re-write via $HELPER_PATH (which validates JSON.parse before writing)."
fi

# Field-by-field validation
M_CLAIM="$(printf '%s' "$MARKER_JSON" | jq -r '.claim_class // ""')"
M_SESSION="$(printf '%s' "$MARKER_JSON" | jq -r '.session_id // ""')"
M_REPO_ROOT="$(printf '%s' "$MARKER_JSON" | jq -r '.repo_root // ""')"
M_PROMPT_SHA="$(printf '%s' "$MARKER_JSON" | jq -r '.prompt_sha256 // ""')"
M_REQUIRED="$(printf '%s' "$MARKER_JSON" | jq -r '.required_files // [] | join(",")')"
M_LOADED_COUNT="$(printf '%s' "$MARKER_JSON" | jq -r '.loaded_files // [] | length')"
M_STEPS="$(printf '%s' "$MARKER_JSON" | jq -r '.artifact_steps_done // [] | join(",")')"

if [ "$M_CLAIM" != "codex-review-handoff" ]; then
  _emit_deny "Pre-flight marker claim_class is '$M_CLAIM'; required: 'codex-review-handoff'. Re-write the marker."
fi
if [ "$M_REPO_ROOT" != "$REPO_ROOT" ]; then
  _emit_deny "Pre-flight marker repo_root is '$M_REPO_ROOT'; gate-resolved repo_root is '$REPO_ROOT'. Re-write with the correct repo_root."
fi
if [ -n "$SESSION_ID" ] && [ "$M_SESSION" != "$SESSION_ID" ]; then
  _emit_deny "Pre-flight marker session_id '$M_SESSION' does not match current session '$SESSION_ID'. Stale-session marker; re-write."
fi
if [ -z "$M_PROMPT_SHA" ]; then
  _emit_deny "Pre-flight marker missing prompt_sha256. Re-write with the current user prompt's sha256."
fi
if [ -z "$M_REQUIRED" ]; then
  _emit_deny "Pre-flight marker required_files is empty. Must include the bundle path: $BUNDLE_PATH."
fi
# Exact-match via jq (not grep) — `.md` regex metachars in BUNDLE_PATH
# could otherwise match unintended substrings. C1 fix.
if ! printf '%s' "$MARKER_JSON" | jq -e --arg b "$BUNDLE_PATH" '(.required_files // []) | index($b) != null' >/dev/null 2>&1; then
  _emit_deny "Pre-flight marker required_files does not list bundle: $BUNDLE_PATH. Re-write with bundle in required_files."
fi
if [ "$M_LOADED_COUNT" = "0" ]; then
  _emit_deny "Pre-flight marker loaded_files is empty. Must list each required_file with its current sha256 + mtime_ms."
fi
if [ -z "$M_STEPS" ]; then
  _emit_deny "Pre-flight marker artifact_steps_done is empty. Must include at least: memory-pre-pass, channel-discipline-note, work-area-tags."
fi

# Cross-check: every required_file must appear in loaded_files with
# sha256 matching disk, and disk file must exist.
MISMATCH="$(printf '%s' "$MARKER_JSON" | jq -r '
  (.required_files // []) as $req |
  (.loaded_files // []) as $loaded |
  $req | map(. as $rf |
    ($loaded[] | select(.path == $rf)) // {missing: $rf}
  ) | map(select(.missing != null) | "missing-loaded:" + .missing) | join("\n")
')"
if [ -n "$MISMATCH" ]; then
  _emit_deny "Pre-flight marker required_files have no loaded_files entries: $MISMATCH. Re-load and re-write."
fi

# Hash-match each loaded_file vs disk.
HASH_MISMATCH="$(printf '%s' "$MARKER_JSON" | jq -r '.loaded_files // [] | map([.path, .sha256] | @tsv) | .[]' | while IFS=$'\t' read -r path expected_sha; do
  if [ ! -f "$path" ]; then
    printf 'missing-on-disk:%s\n' "$path"
    continue
  fi
  actual_sha="$(shasum -a 256 "$path" 2>/dev/null | awk '{print $1}')"
  if [ "$actual_sha" != "$expected_sha" ]; then
    printf 'sha-drift:%s\n' "$path"
  fi
done)"
if [ -n "$HASH_MISMATCH" ]; then
  _emit_deny "Pre-flight marker bundle component hash drift detected: $HASH_MISMATCH. Re-read each component, recompute sha256, re-write the marker."
fi

# All validations passed — allow.
exit 0
