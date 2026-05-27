#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-23.2
# agent-classifier.sh — Tier 2/3 marker-cache wrapper for command-classifier.sh.
# (Historically llm-classifier.sh; renamed in PR-B — the mechanism is the
# active agent self-classifying its own Bash commands, not a live LLM API.)
#
# REPLACES PR #326's direct-Anthropic-API fetch. The active Claude Code
# session classifies its own Bash commands using its own reasoning (already
# paid for via the user's subscription tokens) and records the verdict via
# `scripts/classifier-marker.mjs --write`. This wrapper just READS the marker.
#
# Cost: ZERO new LLM calls in the hot path. Zero new API keys. Zero new
# billing meters. The marker file IS the cache.
#
# Sourced from hooks/lib/command-classifier.sh. Provides one function:
#
#   agent_classify_command <command> <repo_root> <caller_cwd>
#       echoes "<label>\t<source>" on success (exit 0)
#       echoes "" and returns 1 on no-decision (caller falls back to Tier 1
#       conservative default OR the hook returns deny-with-hint via the
#       caller's own emit path)
#
# On marker miss, this wrapper does NOT directly emit a deny structure.
# The caller (command-classifier.sh) gets no-decision and falls through to
# its conservative default. A deny-with-hint UX that translates the
# conservative default into an actionable "classify this command" reason is a
# PR-B2 follow-up (#333), coupled to the F1 Bash pre-checkpoint arm (#351).
#
# Legacy direct-API dispatch path is retained behind the
# classifier-config.json transport=direct-fetch config field (file-based,
# NOT env-prefix per PR #271 attack-class lesson). Default: marker-only.

# Resolution: hooks/lib/ sits next to scripts/. Installed scripts live at
# ~/.episodic-memory/scripts/. Detect both layouts.
#
# Codex CR R2 BLOCKER fix: NO env-var override seam. An ambient
# `CLASSIFIER_MARKER_PATH` pointing at a stub helper could fabricate a
# `{"status":"hit","label":"read_only",...}` JSON response and bypass the
# marker artifact entirely. Helper resolution is hard-bound to
# installed-runtime OR repo-source paths — both authoritative.
__agent_classifier_resolve_marker_helper() {
  local global="$HOME/.episodic-memory/scripts/classifier-marker.mjs"
  if [ -f "$global" ]; then
    printf '%s' "$global"
    return 0
  fi
  # Repo-source fallback (dev / pre-install).
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repo="$self_dir/../../scripts/classifier-marker.mjs"
  if [ -f "$repo" ]; then
    printf '%s' "$repo"
    return 0
  fi
  return 1
}

# PR #336 — Tier 0 auto-persist helper resolution. Resolves to installed
# runtime first, repo-source fallback. NO env-var override seam (PR #271
# attack class — ambient env paths can be hijacked).
__agent_classifier_resolve_persist_helper() {
  local global="$HOME/.episodic-memory/scripts/classifier-override-persist.mjs"
  if [ -f "$global" ]; then
    printf '%s' "$global"
    return 0
  fi
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repo="$self_dir/../../scripts/classifier-override-persist.mjs"
  if [ -f "$repo" ]; then
    printf '%s' "$repo"
    return 0
  fi
  return 1
}

# PR #336 — Fire-and-forget auto-persist invocation. Backgrounds the
# persist helper with redirected I/O so it never pollutes the hook's
# classification stream. Silent on success (helper enforces); silent on
# any failure (the redirect swallows stderr).
#
# Why fire-and-forget: the hook returns the label immediately; the
# next-time-this-command-runs benefit of Tier 0 doesn't gate the current
# classification. Backgrounding the persist write keeps the hot path
# latency unchanged from pre-#336.
#
# Why subshell `cd "$repo_root"`: persist helper's
# `realpath(resolveRepoRoot(process.cwd())) === --project-root` cross-repo
# check requires its process.cwd() to canonicalize to $repo_root.
__agent_classifier_autopersist() {
  local repo_root="$1" caller_cwd="$2" command="$3" label="$4" confidence="$5" source_tag="$6"
  if [ -z "$repo_root" ] || [ -z "$caller_cwd" ] || [ -z "$command" ] || \
     [ -z "$label" ] || [ -z "$confidence" ] || [ -z "$source_tag" ]; then
    return 1
  fi
  local persist_helper
  if ! persist_helper="$(__agent_classifier_resolve_persist_helper)"; then
    return 1
  fi
  # Background subshell: cd binds cwd, helper writes silently. Disown via
  # `&` so the parent shell does not block on the child.
  #
  # F-4 (negative-scenario-reviewer ACCEPT-with-FU): silent cd-failure is
  # ACCEPTABLE here. If `cd "$repo_root"` fails (parent moved, FS removed
  # mid-Bash-invocation), the `&&` short-circuits and node never runs.
  # No persist happens; the classification was already emitted; the next
  # Bash invocation will simply hit the marker cache again and fire
  # another autopersist attempt. Fire-and-forget contract is "best effort,
  # no guarantee" — silent failure preserves that. The redirect to
  # /dev/null is the contract that swallows stderr; surfacing a warning
  # would require a separate log file, out of scope.
  ( cd "$repo_root" 2>/dev/null && node "$persist_helper" \
      --project-root "$repo_root" \
      --caller-cwd "$caller_cwd" \
      --command "$command" \
      --label "$label" \
      --confidence "$confidence" \
      --source-tag "$source_tag" >/dev/null 2>&1 ) &
  return 0
}

# Legacy dispatch (for --legacy-direct-fetch tests / rollback only).
__agent_classifier_resolve_legacy_dispatcher() {
  # Env alias (PR-B): AGENT_CLASSIFIER_DISPATCH_PATH preferred; LLM_CLASSIFIER_DISPATCH_PATH
  # retained as backward-compat alias (new name wins if both set).
  local _dispatch_path="${AGENT_CLASSIFIER_DISPATCH_PATH:-${LLM_CLASSIFIER_DISPATCH_PATH:-}}"
  if [ -n "$_dispatch_path" ] && [ -f "$_dispatch_path" ]; then
    printf '%s' "$_dispatch_path"
    return 0
  fi
  local global="$HOME/.episodic-memory/scripts/agent-classifier-dispatch.mjs"
  if [ -f "$global" ]; then
    printf '%s' "$global"
    return 0
  fi
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repo="$self_dir/../../scripts/agent-classifier-dispatch.mjs"
  if [ -f "$repo" ]; then
    printf '%s' "$repo"
    return 0
  fi
  return 1
}

# Read session_id from $CLAUDE_CODE_SESSION_ID (canonical env var name in
# this repo, set by Claude Code when spawning hook subprocesses; mirrors
# what scripts/plan-marker.mjs already depends on).
#
# Fall back to "unknown" so cache hits still work in test/CI contexts where
# the session_id env var isn't injected. session_id="unknown" markers can
# only match other invocations under the same fallback, so test isolation
# is preserved without breaking unit tests. In production runs under Claude
# Code, CLAUDE_CODE_SESSION_ID is always set; the fallback never triggers.
__agent_classifier_session_id() {
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
    printf '%s' "$CLAUDE_CODE_SESSION_ID"
    return 0
  fi
  printf '%s' "unknown"
}

agent_classify_command() {
  local command="$1"
  local repo_root="$2"
  local caller_cwd="$3"

  if [ -z "$command" ] || [ -z "$repo_root" ] || [ -z "$caller_cwd" ]; then
    return 1
  fi

  local session_id
  session_id="$(__agent_classifier_session_id)"

  # --- Marker-cache read (primary path) ---
  local marker_helper marker_hit=0
  if marker_helper="$(__agent_classifier_resolve_marker_helper)"; then
    local out
    # Subshell cd forces helper's process.cwd() to repo_root regardless of
    # caller cwd. Helper re-verifies. 2>/dev/null suppresses helper
    # diagnostics from polluting hook stdout — they're captured in the
    # helper's JSON reason field when needed.
    out="$(cd "$repo_root" 2>/dev/null && node "$marker_helper" --read \
      --project-root "$repo_root" \
      --caller-cwd "$caller_cwd" \
      --command "$command" \
      --session-id "$session_id" 2>/dev/null)"
    local rc=$?
    if [ $rc -eq 0 ] && [ -n "$out" ]; then
      # Parse JSON without jq using a small inline node one-liner. Same
      # label-allowlist defense as before — unknown labels reach awk only
      # if they passed the allowlist filter.
      # PR #336: extend parser to capture confidence. The marker JSON
      # includes a `confidence` field (number in [0,1]) emitted by
      # classifier-marker.mjs. Confidence is needed by the auto-persist
      # helper's threshold gate (default 0.7).
      local parsed
      parsed="$(printf '%s' "$out" | node -e '
        const ALLOWED = new Set(["read_only","nonsrc_write","shared_write","marker_write","push_or_pr_create","unsafe_complex"])
        let buf = ""
        process.stdin.on("data", c => buf += c)
        process.stdin.on("end", () => {
          try {
            const last = buf.trim().split("\n").pop()
            const j = JSON.parse(last)
            if (j.status !== "hit") { process.stdout.write(""); return }
            let label = j.label || ""
            if (label && !ALLOWED.has(label)) label = ""
            const root = String(j.project_root_used || "").replace(/[\t\n\r]/g, "_")
            // Confidence — number in [0,1] or "" if absent/invalid.
            let conf = ""
            if (typeof j.confidence === "number" && Number.isFinite(j.confidence) && j.confidence >= 0 && j.confidence <= 1) {
              conf = String(j.confidence)
            }
            process.stdout.write(`${label}\t${root}\t${conf}`)
          } catch { process.stdout.write("") }
        })
      ' 2>/dev/null)"

      if [ -n "$parsed" ]; then
        local label root confidence
        label="$(printf '%s' "$parsed" | awk -F'\t' '{print $1}')"
        root="$(printf '%s' "$parsed" | awk -F'\t' '{print $2}')"
        confidence="$(printf '%s' "$parsed" | awk -F'\t' '{print $3}')"
        # Re-verify project_root_used echo before applying. PR #336 (carried
        # over from file 6/8 R1 lesson): the helper canonicalizes via
        # realpathOrSame; macOS /var → /private/var would otherwise mismatch.
        # Use `pwd -P` of repo_root for canonical physical-dir equality.
        local _repo_root_canon
        _repo_root_canon="$(cd "$repo_root" 2>/dev/null && pwd -P)"
        if [ -n "$label" ] && [ "$root" = "$_repo_root_canon" ]; then
          # PR #336: auto-persist this verdict as a Tier 0 override (fire-
          # and-forget; helper applies confidence + carve-out + dedup gates
          # and is silent on success). Skip if confidence is missing
          # (older marker schema without the field).
          if [ -n "$confidence" ]; then
            __agent_classifier_autopersist "$repo_root" "$caller_cwd" "$command" \
              "$label" "$confidence" "agent-marker-autopersist"
          fi
          printf '%s\t%s\n' "$label" "interpreter_marker_cache_hit"
          return 0
        fi
      fi
    fi
    # Marker miss → fall through to legacy check (per codex code-review
    # MAJOR #3: returning rc=1 here made the rollback path unreachable;
    # legacy direct-fetch must get a chance to fire even when the marker
    # helper exists and the marker lookup misses).
  fi

  # --- Legacy direct-fetch fallback (rollback / offline CI only) ---
  # Activated by config field, NOT env-prefix (PR #271 attack class).
  # Config lives at <project>/.episodic-memory/classifier-config.json or
  # ~/.episodic-memory/classifier-config.json with field:
  #   { "transport": "direct-fetch" }
  if __agent_classifier_legacy_enabled "$repo_root"; then
    local dispatcher
    if dispatcher="$(__agent_classifier_resolve_legacy_dispatcher)"; then
      __agent_classifier_legacy_log "$repo_root"
      local out
      out="$(cd "$repo_root" 2>/dev/null && node "$dispatcher" \
        --project-root "$repo_root" \
        --caller-cwd "$caller_cwd" \
        --command "$command" 2>/dev/null)"
      if [ -n "$out" ]; then
        # PR #336: extend parser to capture confidence (same rationale as
        # marker-cache parser above).
        local parsed
        parsed="$(printf '%s' "$out" | node -e '
          const ALLOWED = new Set(["read_only","nonsrc_write","shared_write","marker_write","push_or_pr_create","unsafe_complex"])
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
              let conf = ""
              if (typeof j.confidence === "number" && Number.isFinite(j.confidence) && j.confidence >= 0 && j.confidence <= 1) {
                conf = String(j.confidence)
              }
              process.stdout.write(`${label}\t${source}\t${root}\t${conf}`)
            } catch { process.stdout.write("") }
          })
        ' 2>/dev/null)"
        if [ -n "$parsed" ]; then
          local label source root confidence
          label="$(printf '%s' "$parsed" | awk -F'\t' '{print $1}')"
          source="$(printf '%s' "$parsed" | awk -F'\t' '{print $2}')"
          root="$(printf '%s' "$parsed" | awk -F'\t' '{print $3}')"
          confidence="$(printf '%s' "$parsed" | awk -F'\t' '{print $4}')"
          # Same canonicalization as marker-cache hit (PR #336 file 6/8 lesson).
          local _legacy_root_canon
          _legacy_root_canon="$(cd "$repo_root" 2>/dev/null && pwd -P)"
          if [ -n "$label" ] && [ "$root" = "$_legacy_root_canon" ]; then
            # PR #336: auto-persist after legacy-dispatcher hit (same
            # fire-and-forget pattern as marker-cache hit).
            if [ -n "$confidence" ]; then
              __agent_classifier_autopersist "$repo_root" "$caller_cwd" "$command" \
                "$label" "$confidence" "agent-legacy-autopersist"
            fi
            printf '%s\tinterpreter_llm_legacy_%s\n' "$label" "$source"
            return 0
          fi
        fi
      fi
    fi
  fi

  return 1
}

# agent_classify_path <file_path> <repo_root> <caller_cwd>
#   echoes "<label>" (read_only|nonsrc_write|…) on a per-session marker hit
#   (exit 0); echoes "" and returns 1 on miss / helper-absent / root drift.
#
# PR-B2 S3 (§11/§14-F4): the Write/Edit pre-checkpoint arm was a pure path
# heuristic — any in-repo target armed — which over-arms on plan/scratch/doc
# files cross-tool harnesses stage in-project. This is the READ side of the
# path-verdict escape: the agent classifies a TARGET path once via
# `classifier-marker.mjs --write --target-path`, and the gate consults the
# verdict here. Mirrors agent_classify_command but with --target-path instead
# of --command. NO auto-persist: path verdicts have no Tier-0 analog
# (classify_path is path-shaped, not command-shaped), so they live only as
# per-session markers — re-classified each session, like cross-session command
# markers before Tier-0 promotion. NO legacy direct-fetch fallback (paths were
# never an LLM-dispatch subject).
agent_classify_path() {
  local file_path="$1"
  local repo_root="$2"
  local caller_cwd="$3"

  if [ -z "$file_path" ] || [ -z "$repo_root" ] || [ -z "$caller_cwd" ]; then
    return 1
  fi

  local session_id
  session_id="$(__agent_classifier_session_id)"

  local marker_helper
  if ! marker_helper="$(__agent_classifier_resolve_marker_helper)"; then
    return 1
  fi

  local out
  # Subshell cd forces helper's process.cwd() to repo_root (the helper's
  # canonicalization binds the target to --project-root). 2>/dev/null keeps
  # helper diagnostics out of the hook stream.
  out="$(cd "$repo_root" 2>/dev/null && node "$marker_helper" --read \
    --project-root "$repo_root" \
    --caller-cwd "$caller_cwd" \
    --target-path "$file_path" \
    --session-id "$session_id" 2>/dev/null)"
  local rc=$?
  if [ $rc -ne 0 ] || [ -z "$out" ]; then
    return 1
  fi

  local parsed
  parsed="$(printf '%s' "$out" | node -e '
    const ALLOWED = new Set(["read_only","nonsrc_write","shared_write","marker_write","push_or_pr_create","unsafe_complex"])
    let buf = ""
    process.stdin.on("data", c => buf += c)
    process.stdin.on("end", () => {
      try {
        const last = buf.trim().split("\n").pop()
        const j = JSON.parse(last)
        if (j.status !== "hit") { process.stdout.write(""); return }
        let label = j.label || ""
        if (label && !ALLOWED.has(label)) label = ""
        const root = String(j.project_root_used || "").replace(/[\t\n\r]/g, "_")
        process.stdout.write(`${label}\t${root}`)
      } catch { process.stdout.write("") }
    })
  ' 2>/dev/null)"

  if [ -n "$parsed" ]; then
    local label root
    label="$(printf '%s' "$parsed" | awk -F'\t' '{print $1}')"
    root="$(printf '%s' "$parsed" | awk -F'\t' '{print $2}')"
    # Re-verify project_root_used echo (macOS /var → /private/var; PR #336
    # file 6/8 lesson) before trusting the verdict.
    local _repo_root_canon
    _repo_root_canon="$(cd "$repo_root" 2>/dev/null && pwd -P)"
    if [ -n "$label" ] && [ "$root" = "$_repo_root_canon" ]; then
      printf '%s\n' "$label"
      return 0
    fi
  fi
  return 1
}

# Check classifier-config.json transport field. Default: marker-only.
__agent_classifier_legacy_enabled() {
  local repo_root="$1"
  local cfg_project="$repo_root/.episodic-memory/classifier-config.json"
  local cfg_global="$HOME/.episodic-memory/classifier-config.json"
  local cfg=""
  if [ -f "$cfg_project" ]; then cfg="$cfg_project"
  elif [ -f "$cfg_global" ]; then cfg="$cfg_global"
  fi
  if [ -z "$cfg" ]; then return 1; fi
  # node -e places user positional args at argv[1+] (no synthetic [eval] entry).
  node -e '
    try {
      const fs = require("fs")
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      process.exit(j && j.transport === "direct-fetch" ? 0 : 1)
    } catch { process.exit(1) }
  ' "$cfg" 2>/dev/null
}

# One-line telemetry log of legacy use. Burn-in surface — if no legacy log
# entries accumulate over a release, the legacy path can be removed.
__agent_classifier_legacy_log() {
  local repo_root="$1"
  local log_dir="$HOME/.episodic-memory"
  local log_file="$log_dir/legacy-fetch.log.jsonl"
  if [ ! -d "$log_dir" ]; then mkdir -p "$log_dir" 2>/dev/null || return 0; fi
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"ts":"%s","project_root":"%s","reason":"legacy_direct_fetch_used"}\n' \
    "$ts" "$repo_root" >> "$log_file" 2>/dev/null || return 0
}
