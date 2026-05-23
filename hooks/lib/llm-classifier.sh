#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-23.1
# llm-classifier.sh — Tier 2/3 classifier wrapper for command-classifier.sh.
#
# Sourced from hooks/lib/command-classifier.sh. Provides one function:
#
#   llm_classify_command <command> <repo_root> <caller_cwd>
#       echoes "<label>\t<source>" on success (exit 0)
#       echoes "" and returns 1 on no-decision (caller falls back to Tier 1)
#
# The dispatcher (scripts/llm-classifier-dispatch.mjs) handles:
#   - cache tuple build + sha256 key
#   - project-local override > global cache > Tier 3 dispatch
#   - project_root_used echo verification
#   - cache write under lock
#
# Cwd binding: dispatcher is invoked inside a (cd "$REPO_ROOT" && ...) subshell
# so its process.cwd() matches --project-root. The dispatcher re-verifies and
# rejects mismatches. Defense in depth: shell forces cwd; dispatcher checks.

# Resolution: hooks/lib/llm-classifier.sh sits next to command-classifier.sh.
# Installed scripts live at ~/.episodic-memory/scripts/. Detect both layouts.
__llm_classifier_resolve_dispatcher() {
  if [ -n "${LLM_CLASSIFIER_DISPATCH_PATH:-}" ] && [ -f "$LLM_CLASSIFIER_DISPATCH_PATH" ]; then
    printf '%s' "$LLM_CLASSIFIER_DISPATCH_PATH"
    return 0
  fi
  local global="$HOME/.episodic-memory/scripts/llm-classifier-dispatch.mjs"
  if [ -f "$global" ]; then
    printf '%s' "$global"
    return 0
  fi
  # Repo-source fallback (dev / pre-install).
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repo="$self_dir/../../scripts/llm-classifier-dispatch.mjs"
  if [ -f "$repo" ]; then
    printf '%s' "$repo"
    return 0
  fi
  return 1
}

llm_classify_command() {
  local command="$1"
  local repo_root="$2"
  local caller_cwd="$3"

  if [ -z "$command" ] || [ -z "$repo_root" ] || [ -z "$caller_cwd" ]; then
    return 1
  fi

  local dispatcher
  if ! dispatcher="$(__llm_classifier_resolve_dispatcher)"; then
    # No dispatcher available — caller falls back to Tier 1.
    return 1
  fi

  local out
  # Subshell cd forces dispatcher's cwd to repo_root regardless of caller cwd.
  # 2>/dev/null suppresses warnings (e.g. ANTHROPIC_API_KEY missing) from
  # interfering with hook stdout — they're recorded inside the dispatcher's
  # reason field instead.
  out="$(cd "$repo_root" 2>/dev/null && node "$dispatcher" \
    --project-root "$repo_root" \
    --caller-cwd "$caller_cwd" \
    --command "$command" 2>/dev/null)"
  local rc=$?

  if [ -z "$out" ]; then
    return 1
  fi

  # Parse JSON without jq — extract label, source, and project_root_used via
  # a small inline node one-liner (fast; same runtime already loaded).
  # F9-fix: validate label against allowlist inside the parser so a label
  # carrying tabs / newlines / unknown values can never reach awk's field
  # split. Unknown label → empty (caller treats as no-decision).
  local parsed
  parsed="$(printf '%s' "$out" | node -e '
    const ALLOWED = new Set(["read_only","shared_write","marker_write","push_or_pr_create","unsafe_complex"])
    let buf = ""
    process.stdin.on("data", c => buf += c)
    process.stdin.on("end", () => {
      try {
        const last = buf.trim().split("\n").pop()
        const j = JSON.parse(last)
        let label = j.label || ""
        if (label && !ALLOWED.has(label)) label = ""
        const source = String(j.source || "").replace(/[\t\n\r]/g, "_")
        const root = String(j.project_root_used || "").replace(/[\t\n\r]/g, "_")
        process.stdout.write(`${label}\t${source}\t${root}`)
      } catch { process.stdout.write("") }
    })
  ' 2>/dev/null)"

  if [ -z "$parsed" ]; then
    return 1
  fi

  local label source root
  label="$(printf '%s' "$parsed" | awk -F'\t' '{print $1}')"
  source="$(printf '%s' "$parsed" | awk -F'\t' '{print $2}')"
  root="$(printf '%s' "$parsed" | awk -F'\t' '{print $3}')"

  # FU-4 shell-side defense: re-verify project_root_used echo before applying.
  if [ "$root" != "$repo_root" ]; then
    return 1
  fi

  # No-label outcome (Tier 3 fallback heuristic, env-prefix, etc.) → caller
  # falls back to its own Tier 1.
  if [ -z "$label" ]; then
    return 1
  fi

  printf '%s\t%s\n' "$label" "interpreter_llm_${source}"
  return 0
}
