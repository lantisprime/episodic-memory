#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-25.1
# agent-classifier-deny-reason.sh — compose the deny-with-hint message shown
# when a Bash command is conservatively classified shared_write with NO
# agent-classifier verdict on file (REASON=interpreter_other). Closes #333.
#
# Contract: the hint is a ready-to-paste `cd <repo> && node <helper> --write …`
# line. The `cd <repo>` prefix is MANDATORY — classifier-marker.mjs --write
# refuses when resolveRepoRoot(process.cwd()) != --project-root
# (scripts/classifier-marker.mjs ~L491), so a bare invocation fails from any
# nested / linked-worktree / off-project cwd (codex R1 P2). Helper resolution is
# hard-bound to installed-runtime OR repo-source — NO env-var override seam
# (PR #271 attack class: an ambient path could point the agent at a stub).
#
# Sourced lazily by checkpoint-gate.sh's _block_pre_with_hint. Provides:
#   agent_classifier_deny_hint <command> <repo_root> <caller_cwd> <session_id>
#       echoes the multi-line hint on stdout (the gate embeds it via jq --arg).

# Hard-bound helper resolution: installed runtime first, repo-source fallback,
# bare basename last (agent resolves via its own runtime PATH). Mirrors
# __agent_classifier_resolve_marker_helper in agent-classifier.sh.
__agent_classifier_deny_resolve_helper() {
  local global="$HOME/.episodic-memory/scripts/classifier-marker.mjs"
  if [ -f "$global" ]; then printf '%s' "$global"; return 0; fi
  local self_dir
  self_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  local repo="$self_dir/../../scripts/classifier-marker.mjs"
  if [ -f "$repo" ]; then printf '%s' "$repo"; return 0; fi
  printf '%s' "classifier-marker.mjs"
  return 0
}

# Single-quote-escape a string for safe inclusion inside '…' in the hint:
# each ' becomes the 4-char sequence '\'' (close-quote, backslash-escaped quote,
# reopen-quote). Char-by-char to avoid bash ${//} replacement backslash
# ambiguity (which varies by bash version and mangled the escape).
__agent_classifier_sq() {
  local s="$1" out="" ch i
  for (( i=0; i<${#s}; i++ )); do
    ch="${s:i:1}"
    if [ "$ch" = "'" ]; then
      out="$out'\\''"
    else
      out="$out$ch"
    fi
  done
  printf '%s' "$out"
}

agent_classifier_deny_hint() {
  local command="$1" repo_root="$2" caller_cwd="$3" session_id="$4"
  local helper cmd_q repo_q cwd_q helper_q sid_q
  helper="$(__agent_classifier_deny_resolve_helper)"
  cmd_q="$(__agent_classifier_sq "$command")"
  repo_q="$(__agent_classifier_sq "$repo_root")"
  cwd_q="$(__agent_classifier_sq "$caller_cwd")"
  helper_q="$(__agent_classifier_sq "$helper")"
  sid_q="$(__agent_classifier_sq "$session_id")"
  cat <<EOF
This command writes file content (classified shared_write). If it is part of your
implementation, the pre-implementation checkpoint above IS the required action — write it, then retry.
ONLY if this command does NOT write repo source (it writes solely to /tmp, /dev/null, or
outside the repo, or is genuinely read-only) classify it and retry instead:
  cd '$repo_q' && node '$helper_q' --write \\
    --project-root '$repo_q' --caller-cwd '$cwd_q' \\
    --command '$cmd_q' \\
    --label read_only --confidence 0.9 --reason 'non-repo-source write' --session-id '$sid_q'
  (Too awkward to single-quote? Write the command verbatim to
   '$repo_q/.checkpoints/classify/pending-<sha>.cmd' and pass --command-file <that path> instead of --command.)
Do NOT classify a real repo-source write as read_only — it persists a permanent pre-checkpoint bypass.
EOF
}
