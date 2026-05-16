#!/usr/bin/env bash
set -e

# episodic-memory-hook-version: 2026-05-16.1
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
# #279 fix: prefer per-session marker, fall back to legacy during burn-in.
# Resolution happens AFTER SESSION_ID is validated (below); the actual marker
# path used by claim-class validation is set as PREFLIGHT_MARKER_RESOLVED.
PREFLIGHT_MARKER_LEGACY="$PRIMARY_DIR/.preflight-done"
PREFLIGHT_MARKER_SID=""   # set after SESSION_ID validation if present
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

# P2-1 (code-review FU): validate SESSION_ID shape immediately after
# _emit_deny is defined and BEFORE any downstream path-construction or
# marker comparison. Every other layer (hook, helper, install bootstrap)
# enforces ^[A-Za-z0-9_-]{1,128}$; the gate must match so a malicious
# stdin payload can't cause path-traversal via LAST_PROMPT_SID_PATH
# interpolation. Empty SESSION_ID is allowed (Claude Code may omit it;
# downstream branches already test `-n "$SESSION_ID"`).
if [ -n "$SESSION_ID" ]; then
  case "$SESSION_ID" in
    *[!A-Za-z0-9_-]*) _emit_deny "preflight-gate.sh: session_id from stdin contains invalid chars; cannot evaluate prompt-binding." ;;
  esac
  if [ ${#SESSION_ID} -gt 128 ]; then
    _emit_deny "preflight-gate.sh: session_id from stdin exceeds 128 chars; cannot evaluate prompt-binding."
  fi
  # #279 fix: SESSION_ID has been validated, safe to interpolate into path.
  PREFLIGHT_MARKER_SID="$PRIMARY_DIR/.preflight-done.${SESSION_ID}"
fi

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
      CANON_PREFLIGHT="$(_canonicalize_one "$PREFLIGHT_MARKER_LEGACY" "$REPO_ROOT")"
      ec_pf=$?
      CANON_LAST_PROMPT="$(_canonicalize_one "$LAST_PROMPT_MARKER" "$REPO_ROOT")"
      ec_lp=$?
      CANON_PRIMARY_DIR="$(_canonicalize_one "$PRIMARY_DIR" "$REPO_ROOT")"
      ec_pd=$?
      set -e
      if [ $ec_tool -eq 99 ]; then
        _emit_deny "preflight-gate.sh: canonicalize-path-tolerant lib missing at $CANON_LIB. Re-run install.mjs --install-hooks."
      fi
      if [ $ec_tool -ne 0 ]; then
        _emit_deny "preflight-gate.sh: path canonicalization failed for '$TOOL_PATH': $CANON_TOOL — refusing to evaluate $TOOL_NAME. Use: node $HELPER_PATH --root $REPO_ROOT --target preflight"
      fi
      # Marker-path canonicalization should never fail (paths are simple,
      # no symlinks expected). If it does → conservative deny.
      if [ $ec_pf -ne 0 ] || [ $ec_lp -ne 0 ] || [ $ec_pd -ne 0 ]; then
        _emit_deny "preflight-gate.sh: failed to canonicalize marker paths; gate cannot evaluate. Re-run install.mjs --install-hooks."
      fi
      # Direct equality covers .preflight-done and the legacy non-namespaced
      # .last-user-prompt.json. Plan-v2 C5: also deny any
      # .last-user-prompt.<sid>.json under .checkpoints/ (the session-
      # namespaced files written by the helper via the UserPromptSubmit
      # hook — agents must never write these directly).
      # #279 fix: also deny .preflight-done.<sid> (the new per-session
      # marker form) regardless of which session — helper-only contract.
      _tool_basename="$(basename "$CANON_TOOL")"
      _tool_parent="$(dirname "$CANON_TOOL")"
      _last_prompt_namespaced=0
      _preflight_namespaced=0
      if [ "$_tool_parent" = "$CANON_PRIMARY_DIR" ]; then
        case "$_tool_basename" in
          .last-user-prompt.*.json) _last_prompt_namespaced=1 ;;
          .preflight-done.*)
            # Validate suffix shape ([A-Za-z0-9_-]{1,128}) so .preflight-done.bak
            # / .preflight-done. / .preflight-done./traversal don't slip.
            _suffix="${_tool_basename#.preflight-done.}"
            if [ -n "$_suffix" ] && [ ${#_suffix} -le 128 ]; then
              case "$_suffix" in
                *[!A-Za-z0-9_-]*) : ;;
                *) _preflight_namespaced=1 ;;
              esac
            fi
            ;;
        esac
      fi
      if [ "$CANON_TOOL" = "$CANON_PREFLIGHT" ] || [ "$CANON_TOOL" = "$CANON_LAST_PROMPT" ] || [ $_last_prompt_namespaced -eq 1 ] || [ $_preflight_namespaced -eq 1 ]; then
        _emit_deny "Direct $TOOL_NAME to preflight marker is forbidden. Use the atomic helper: echo '<JSON>' | node $HELPER_PATH --root $REPO_ROOT --target preflight --session-id $SESSION_ID (or --target last-prompt). Resolved tool path: $CANON_TOOL."
      fi
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# Helper-invocation enforcement (FU-3 + #279 Stream 2): Bash invoking the
# helper must satisfy the v7 structural command-form grammar:
#   <command> := <env-prefix>* <executable> <helper-script-path> <helper-flags>*
# where:
#   <env-prefix> name ∈ _ROUTINE_ENV_ALLOWLIST (NODE_ENV, DEBUG, CI, ...)
#   <executable> basename ∈ _NODE_BINARY_BASENAME_ALLOWLIST (node)
#
# Replaces the prior regex-based detection of env wrappers / sudo wrappers /
# path-spelled variants with two structural whitelists. Catches the entire
# wrapper class (env, sudo, npx, nohup, time, bash, python, ...) via the
# single executable-basename check.
#
# Defense layers BEYOND this gate:
#   - Bash allowlist (settings.json) — first line of defense
#   - command-classifier.sh wrapper_utility list — classify_command rejects
#   - file-system permissions on /usr/bin/env etc.
# This gate is one of many; not the only defense.
# ---------------------------------------------------------------------------
if [ "$TOOL_NAME" = "Bash" ]; then
  CMD="$(printf '%s' "$TOOL_INPUT_JSON" | jq -r '.command // ""')"
  if [ -n "$CMD" ]; then
    # Normalize whitespace (tabs / multi-space / line continuations) so
    # variants like `node\t/abs/.../preflight-marker-write.mjs` or
    # `node \\` + newline + path slip through to the same matcher (A3).
    NORMALIZED_CMD="$(printf '%s' "$CMD" | tr '\t\n' '  ' | sed 's/\\ / /g; s/  */ /g')"
    # Match the helper basename when it's a real invocation: must be
    # preceded by start-of-string, space, or slash (i.e. it IS the basename
    # of a path or a bare invocation), AND followed by space or end. The
    # previous regex used `\b...\b` which matched ANY word-boundary,
    # producing false-positives on `test-preflight-marker-write.mjs`.
    HELPER_BASENAME_RE='(^|[ /])preflight-marker-write\.mjs( |$)'
    if printf '%s' "$NORMALIZED_CMD" | grep -qE "$HELPER_BASENAME_RE"; then
      # #279 Stream 2: structural command-form check.
      # _check_helper_invocation_grammar is sourced from command-classifier.sh.
      GRAMMAR_RESULT="$(_check_helper_invocation_grammar "$CMD")"
      GRAMMAR_VERDICT="${GRAMMAR_RESULT%%	*}"
      if [ "$GRAMMAR_VERDICT" = "DENY" ]; then
        GRAMMAR_REST="${GRAMMAR_RESULT#*	}"
        GRAMMAR_KIND="${GRAMMAR_REST%%	*}"
        GRAMMAR_DETAIL="${GRAMMAR_REST#*	}"
        case "$GRAMMAR_KIND" in
          env-prefix)
            _emit_deny "Helper invocation env-prefix wrapper ($GRAMMAR_DETAIL=...) not in routine allowlist. Only routine framework env vars permitted before helper: NODE_ENV, DEBUG, CI, PYTHONPATH, LOG_LEVEL. Per env-prefix-discipline-v1.md. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>."
            ;;
          env-prefix-invalid)
            _emit_deny "Helper invocation env-prefix token has invalid POSIX-name shape: $GRAMMAR_DETAIL. Names must match [A-Za-z_][A-Za-z0-9_]*. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>."
            ;;
          wrapper)
            _emit_deny "Helper must be invoked via a token whose basename is 'node'. Got basename '$GRAMMAR_DETAIL'. Wrappers (env, sudo, npx, nohup, time, exec, bash, python, etc.) not permitted at executable position. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>."
            ;;
          tokenize)
            _emit_deny "Helper invocation could not be safely tokenized ($GRAMMAR_DETAIL). Use a simple form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>."
            ;;
          no-exec)
            _emit_deny "Helper invocation has no executable token after env-prefix walk. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>."
            ;;
          no-helper)
            _emit_deny "Helper invocation: executable token (node) present but no helper-script-path token follows. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>."
            ;;
          wrong-helper)
            _emit_deny "Helper invocation: token after 'node' has basename '$GRAMMAR_DETAIL'; expected 'preflight-marker-write.mjs'. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>."
            ;;
          *)
            _emit_deny "Helper invocation grammar denied ($GRAMMAR_KIND): $GRAMMAR_DETAIL"
            ;;
        esac
      fi
      # Grammar passed (T[idx]=node). Still enforce existing --root and
      # --target last-prompt rules on the helper flags.
      if ! printf '%s' "$NORMALIZED_CMD" | grep -qE '\-\-root[[:space:]]+[^[:space:]]'; then
        _emit_deny "preflight-marker-write.mjs invoked without explicit --root. Required form: node $HELPER_PATH --root $REPO_ROOT --target <preflight|last-prompt> --session-id <sid>. No cwd fallback (ROOT_REQUIRED)."
      fi
      # I7 (plan-v2 audit F2): UserPromptSubmit hook is the ONLY sanctioned
      # writer of `.last-user-prompt.<sid>.json`. PreToolUse-time invocation
      # of the helper with `--target last-prompt` is an agent attempt to
      # spoof the prompt-binding.
      if printf '%s' "$NORMALIZED_CMD" | grep -qE '\-\-target[[:space:]]+last-prompt([[:space:]]|$)'; then
        _emit_deny "preflight-marker-write.mjs --target last-prompt is reserved for the UserPromptSubmit hook. Agent invocation at PreToolUse is forbidden — the hook writes this file on every real user prompt automatically. If the file is missing, the install may be incomplete: re-run install.mjs --install-hooks."
      fi
      # PR #291 codex r2 P1: --target preflight is now also reserved for the
      # UserPromptSubmit hook. Otherwise an agent can forge the preflight
      # marker by re-using the current .last-user-prompt.<sid>.json sha plus
      # disk-hashed components, defeating the hook-owned design from #285.
      # The hook's own subprocess call doesn't fire PreToolUse — only agent
      # Bash tool calls hit this gate.
      if printf '%s' "$NORMALIZED_CMD" | grep -qE '\-\-target[[:space:]]+preflight([[:space:]]|$)'; then
        _emit_deny "preflight-marker-write.mjs --target preflight is reserved for the UserPromptSubmit hook (PR #291 / #285). Agent invocation at PreToolUse is forbidden — the hook writes the preflight marker on every real user prompt with the bundle + 7 components hashed. If the marker is missing or stale, the install may be incomplete: re-run install.mjs --install-hooks."
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

# #279 fix: prefer per-session marker `.preflight-done.<SESSION_ID>`, fall
# back to legacy `.preflight-done` during burn-in. Resolution is purely a
# local file existence check; the cross-session-stomp bug occurs only on
# the legacy filename, so reading the suffixed form deterministically
# returns THIS session's marker even when sibling sessions ran.
PREFLIGHT_MARKER_RESOLVED=""
if [ -n "$PREFLIGHT_MARKER_SID" ] && [ -f "$PREFLIGHT_MARKER_SID" ]; then
  PREFLIGHT_MARKER_RESOLVED="$PREFLIGHT_MARKER_SID"
elif [ -f "$PREFLIGHT_MARKER_LEGACY" ]; then
  PREFLIGHT_MARKER_RESOLVED="$PREFLIGHT_MARKER_LEGACY"
fi

# Marker existence — name both candidate paths so callers know where to write.
if [ -z "$PREFLIGHT_MARKER_RESOLVED" ]; then
  if [ -n "$PREFLIGHT_MARKER_SID" ]; then
    _emit_deny "Pre-flight marker required for codex-review-handoff at $PREFLIGHT_MARKER_SID. The UserPromptSubmit hook should write this prompt-bound marker automatically for session $SESSION_ID. If it is missing, send a new prompt once; if it stays missing, re-run install.mjs --install-hooks so preflight-prompt-helper.sh is wired. Required marker fields: session_id, transcript_path, prompt_sha256, prompt_index, cwd, repo_root, memory_root, claim_class=\"codex-review-handoff\", matched_triggers, required_files (must include $BUNDLE_PATH), loaded_files (with sha256+mtime_ms per file), artifact_steps_done. Bundle: $BUNDLE_PATH."
  else
    _emit_deny "Pre-flight marker required for codex-review-handoff, but stdin missing session_id so the gate cannot derive the per-session path. The UserPromptSubmit hook should write .preflight-done.<sid> automatically; re-run install.mjs --install-hooks if hook stdin omits session_id. Legacy fallback path checked: $PREFLIGHT_MARKER_LEGACY. Required marker fields: session_id, transcript_path, prompt_sha256, prompt_index, cwd, repo_root, memory_root, claim_class=\"codex-review-handoff\", matched_triggers, required_files (must include $BUNDLE_PATH), loaded_files (with sha256+mtime_ms per file), artifact_steps_done. Bundle: $BUNDLE_PATH."
  fi
fi

# JSON parse
MARKER_JSON="$(cat "$PREFLIGHT_MARKER_RESOLVED" 2>/dev/null || true)"
if [ -z "$MARKER_JSON" ]; then
  _emit_deny "Pre-flight marker $PREFLIGHT_MARKER_RESOLVED is empty. Write a valid JSON marker via the helper. May indicate a write-in-progress race; retry."
fi
if ! printf '%s' "$MARKER_JSON" | jq empty 2>/dev/null; then
  _emit_deny "Pre-flight marker $PREFLIGHT_MARKER_RESOLVED is not valid JSON. Re-write via $HELPER_PATH (which validates JSON.parse before writing)."
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
  _emit_deny "Pre-flight marker session_id '$M_SESSION' does not match current session '$SESSION_ID'. Stale-session marker; the UserPromptSubmit hook should replace it on the next prompt. If it persists, re-run install.mjs --install-hooks."
fi
if [ -z "$M_PROMPT_SHA" ]; then
  _emit_deny "Pre-flight marker missing prompt_sha256. Re-write with the current user prompt's sha256."
fi

# ---------------------------------------------------------------------------
# I2 cross-check (plan-v2 audit F3 closure): compare marker prompt_sha256
# against the ground-truth file written by the UserPromptSubmit hook
# (.checkpoints/.last-user-prompt.<SESSION_ID>.json).
#
# I8 fail-closed with bootstrap window: if the ground-truth file is absent
# for the current session, deny by default. Exception: install.mjs may
# write a sentinel file with `bootstrap=true` and a recent wrote_at_ms;
# accept that for 60 seconds so the first prompt of a fresh install can
# land before the real UserPromptSubmit fires on prompt #2.
#
# Locally verifiable: the file path is constructed from REPO_ROOT (gate-
# resolved) and SESSION_ID (passed by Claude Code in stdin), canonicalized
# via the same tolerant lib used for write-side paths (I9).
# ---------------------------------------------------------------------------
if [ -n "$SESSION_ID" ]; then
  LAST_PROMPT_SID_PATH="$PRIMARY_DIR/.last-user-prompt.${SESSION_ID}.json"
  set +e
  CANON_LAST_PROMPT_SID="$(_canonicalize_one "$LAST_PROMPT_SID_PATH" "$REPO_ROOT")"
  ec_lps=$?
  set -e
  if [ $ec_lps -eq 99 ]; then
    _emit_deny "preflight-gate.sh: canonicalize lib missing; cannot evaluate prompt-binding. Re-run install.mjs --install-hooks."
  fi
  if [ $ec_lps -ne 0 ]; then
    # Canonicalization failed (e.g. symlink loop). Conservative deny.
    _emit_deny "preflight-gate.sh: failed to canonicalize $LAST_PROMPT_SID_PATH ($CANON_LAST_PROMPT_SID); cannot verify prompt-binding."
  fi
  if [ ! -f "$CANON_LAST_PROMPT_SID" ]; then
    _emit_deny "Pre-flight marker cannot be cross-checked against ground truth: $CANON_LAST_PROMPT_SID does not exist for session $SESSION_ID. The UserPromptSubmit hook should write this file on every real prompt. If this is the first prompt after a fresh install, run: node install.mjs --tool claude-code --install-hooks --bootstrap-last-prompt. Otherwise re-run install to wire the UserPromptSubmit hook."
  fi
  FILE_JSON="$(cat "$CANON_LAST_PROMPT_SID" 2>/dev/null || true)"
  if [ -z "$FILE_JSON" ] || ! printf '%s' "$FILE_JSON" | jq empty 2>/dev/null; then
    _emit_deny "Ground-truth file $CANON_LAST_PROMPT_SID is empty or not valid JSON. Re-run install.mjs --install-hooks to restore the UserPromptSubmit hook."
  fi
  FILE_BOOTSTRAP="$(printf '%s' "$FILE_JSON" | jq -r '.bootstrap // false')"
  FILE_WROTE_AT_MS="$(printf '%s' "$FILE_JSON" | jq -r '.wrote_at_ms // 0')"
  FILE_PROMPT_SHA="$(printf '%s' "$FILE_JSON" | jq -r '.prompt_sha256 // ""')"
  if [ "$FILE_BOOTSTRAP" = "true" ]; then
    # I8 60s bootstrap window. After 60s, the bootstrap sentinel is stale
    # — fail-closed. Use node for portable ms-precision arithmetic.
    NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0)"
    # Codex round-1 F2 on PR #246 (HOLD): validate FILE_WROTE_AT_MS is
    # numeric BEFORE arithmetic. Without this, a sentinel containing
    # `"wrote_at_ms": "123abc"` triggers a bash arithmetic error; the
    # gate exits non-zero with no `permissionDecision:"deny"` JSON,
    # making behavior depend on Claude Code's hook-error fallback rather
    # than the gate's local fail-closed contract.
    case "$FILE_WROTE_AT_MS" in
      ''|*[!0-9]*) _emit_deny "Bootstrap sentinel at $CANON_LAST_PROMPT_SID has non-numeric wrote_at_ms ($FILE_WROTE_AT_MS); cannot evaluate age. Re-run install.mjs --install-hooks --bootstrap-last-prompt." ;;
    esac
    AGE_MS=$((NOW_MS - FILE_WROTE_AT_MS))
    if [ "$AGE_MS" -gt 60000 ] || [ "$AGE_MS" -lt 0 ]; then
      _emit_deny "Bootstrap sentinel at $CANON_LAST_PROMPT_SID is stale (age ${AGE_MS}ms > 60000ms). The UserPromptSubmit hook should have replaced it by now. Re-run install.mjs --install-hooks to wire the hook."
    fi
    # Within bootstrap window: allow without sha cross-check. The marker
    # still has to satisfy all other gate checks below.
  else
    # Normal case: real UserPromptSubmit-written file. Compare shas.
    if [ -z "$FILE_PROMPT_SHA" ]; then
      _emit_deny "Ground-truth file $CANON_LAST_PROMPT_SID missing prompt_sha256 field. Re-run install.mjs --install-hooks."
    fi
    if [ "$M_PROMPT_SHA" != "$FILE_PROMPT_SHA" ]; then
      # Truncate the shas for readability (full hashes are 64 chars).
      _emit_deny "Pre-flight marker prompt_sha256 does not match the current real user prompt. Marker sha: ${M_PROMPT_SHA:0:16}…; ground-truth sha: ${FILE_PROMPT_SHA:0:16}… (from $CANON_LAST_PROMPT_SID). The marker is bound to a prior prompt. Re-run the pre-flight steps for the current prompt before retrying."
    fi
  fi
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
