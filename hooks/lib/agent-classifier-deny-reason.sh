#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-26.1
# agent-classifier-deny-reason.sh — compose the deny-with-hint message shown
# when a Bash command arms the Rule 18 pre-implementation checkpoint
# (LABEL ∈ {shared_write, unsafe_complex, unknown}) and no agent-classifier
# verdict is on file. Closes #333; supports the #351 nonsrc_write inversion.
#
# 3-WAY hint (PR-B2): the message leads checkpoint-first, then offers the agent
# a per-instance escape it classifies ONCE:
#   1. read_only      — the command genuinely writes nothing (outside /tmp/stdout).
#   2. nonsrc_write    — it writes, but NOT repo source (git internals, package
#                        installs, mkdir/rmdir, redirect to /tmp, episode store).
#   3. (repo-source write) — it IS implementation: write the pre-checkpoint above.
#
# Cross-platform contract (§15, codex R2/R4 REINFORCED): the escape is emitted
# as a COMMAND-FILE flow, NOT a shell-shaped `cd '<repo>' && node …` one-liner.
# Receiving harnesses (Cursor/Codex/Windsurf) may run Windows cmd/PowerShell
# where `&&`, single-quote escaping, and `cd`-chaining are not portable. The
# helper instead instructs: (a) write the command verbatim to a .cmd file under
# the repo, (b) from the repo root, run classifier-marker.mjs with
# --command-file. classifier-marker.mjs refuses when
# resolveRepoRoot(process.cwd()) != --project-root, so "from the repo root" is
# load-bearing — but it is expressed as a precondition, not a bash cd-chain.
#
# Helper resolution is hard-bound to installed-runtime OR repo-source — NO
# env-var override seam (PR #271 attack class: an ambient path could point the
# agent at a stub that fabricates a {"status":"hit"} response).
#
# Sourced lazily by checkpoint-gate.sh's _block_pre_with_hint. Provides:
#   agent_classifier_deny_hint <command> <repo_root> <caller_cwd> <session_id>
#       echoes the multi-line hint on stdout (the gate embeds it via jq --arg).

# Hard-bound helper resolution: installed runtime first, repo-source fallback,
# bare basename last (agent resolves via its own runtime). Mirrors
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

# Short stable digest of the command for the .cmd filename. Falls back to a
# fixed token if no hashing utility is available (the filename is cosmetic; the
# agent may name the file anything).
__agent_classifier_deny_digest() {
  local s="$1"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$s" | shasum 2>/dev/null | awk '{print substr($1,1,12)}'
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$s" | sha1sum 2>/dev/null | awk '{print substr($1,1,12)}'
  else
    printf '%s' "cmd"
  fi
}

agent_classifier_deny_hint() {
  local command="$1" repo_root="$2" caller_cwd="$3" session_id="$4"
  local helper digest cmd_file
  helper="$(__agent_classifier_deny_resolve_helper)"
  digest="$(__agent_classifier_deny_digest "$command")"
  cmd_file="$repo_root/.checkpoints/classify/pending-$digest.cmd"
  cat <<EOF
This Bash command arms the Rule 18 pre-implementation checkpoint (it writes file
content, or its target can't be determined). If this command is part of your
IMPLEMENTATION, the pre-implementation checkpoint above IS the required action —
write it, then retry.

ONLY if this command is NOT a repo-source write, classify it ONCE and retry; the
verdict is cached for this session (and auto-persists), so you are asked at most
once per command shape:
  - read_only    — it genuinely writes nothing (output only to stdout/stderr/tmp).
  - nonsrc_write — it writes, but NOT repo source: .git internals, package
                   installs, mkdir/rmdir, a redirect to /tmp or outside the repo,
                   or the episodic-memory episode store.

To classify (OS-neutral, no shell chaining required):
  1. Write the command verbatim to:
       $cmd_file
  2. From the repository root ($repo_root) run classifier-marker.mjs
     (process.cwd() MUST canonicalize to the repo root — the helper refuses
     otherwise; this is a precondition, not a 'cd &&' you must paste):
       node "$helper" --write \\
         --project-root "$repo_root" --caller-cwd "$caller_cwd" \\
         --command-file "$cmd_file" \\
         --label <read_only|nonsrc_write> --confidence 0.9 \\
         --reason "<why this is not a repo-source write>" \\
         --session-id "$session_id"
  3. Retry the original command.

Do NOT classify a real repo-source write as read_only or nonsrc_write — it
persists a permanent pre-checkpoint bypass for that command shape. The push-gate
still blocks an unverified push regardless of this verdict.
EOF
}

# agent_classifier_path_deny_hint <file_path> <repo_root> <caller_cwd> <session_id>
#   echoes the 2-way hint shown when a Write/Edit targets an in-repo path with
#   no fresh path verdict on file (PR-B2 §11). Symmetric with the Bash 3-way
#   hint above, but for a TARGET PATH and 2-way: the only downgrade for a write
#   is nonsrc_write (the file is a plan/scratch/doc/generated artifact, not repo
#   source); otherwise the write IS implementation and the pre-checkpoint is the
#   required action. The invocation uses --target-path (a single argument — no
#   command-file or shell quoting needed), still expressed as an OS-neutral
#   precondition ("from the repository root") rather than a `cd '<repo>' && …`
#   chain, for cross-tool/cross-OS harnesses (§12/§15).
agent_classifier_path_deny_hint() {
  local file_path="$1" repo_root="$2" caller_cwd="$3" session_id="$4"
  local helper
  helper="$(__agent_classifier_deny_resolve_helper)"
  cat <<EOF
This Write/Edit targets a file under the repository:
  $file_path
so it arms the Rule 18 pre-implementation checkpoint. If this write is part of
your IMPLEMENTATION, the pre-implementation checkpoint above IS the required
action — write it, then retry.

ONLY if this file is NOT repo source — a plan / scratch / notes / generated /
doc file (the kind cross-tool harnesses stage in-project) — classify the TARGET
PATH once and retry; the verdict is cached for this session, so you are asked at
most once per path:
  - nonsrc_write — the target is not repo source.

To classify (OS-neutral, no shell chaining required):
  From the repository root ($repo_root) run classifier-marker.mjs (process.cwd()
  MUST canonicalize to the repo root — the helper refuses otherwise; this is a
  precondition, not a 'cd &&' you must paste):
    node "$helper" --write \\
      --project-root "$repo_root" --caller-cwd "$caller_cwd" \\
      --target-path "$file_path" \\
      --label nonsrc_write --confidence 0.9 \\
      --reason "<why this file is not repo source>" \\
      --session-id "$session_id"
  Then retry the write.

Do NOT classify a real repo-source write as nonsrc_write — it persists a
permanent pre-checkpoint bypass for that path. The push-gate still blocks an
unverified push regardless of this verdict.
EOF
}
