#!/usr/bin/env bash
set -e

# checkpoint-gate.sh — RFC-002 Phase 3b PreToolUse hook
#
# Dependencies: bash, jq, grep. Same as plan-gate.sh — if any are missing
# the hook will fail under set -e; behavior in that case is whatever Claude
# Code does with a hook exit code != 0 (not redocumented here).
#
# Two gates with shared marker state in $CWD/.claude/:
#
#   pre-checkpoint:
#     Blocks Edit/Write/MultiEdit/Bash/NotebookEdit when
#     .checkpoint-required exists AND .pre-checkpoint-done is missing/empty.
#     Activator: em-recall.mjs touches .checkpoint-required when bp-001
#     violations surface in pre-flight (Phase 3, em-recall.mjs:347-369).
#
#   push-gate:
#     Blocks Bash containing `git push` or `gh pr create` when
#     .post-checkpoint-required exists AND .post-checkpoint-done missing/empty.
#     Allowed pushes clean all 4 markers (task complete).
#
# .post-checkpoint-required is armed on every allowed write that passed the
# pre-gate (idempotent touch). Allowlist: Bash commands referencing
# .pre-checkpoint-done or .post-checkpoint-done pass through (deadlock
# prevention — same pattern as plan-gate.sh's rm allowlist).

INPUT="$(cat)"
TOOL_NAME="$(echo "$INPUT" | jq -r '.tool_name // ""')"
CWD="$(echo "$INPUT" | jq -r '.cwd // ""')"
[ -z "$CWD" ] && CWD="$(pwd)"

MARKER_DIR="$CWD/.claude"
PRE_REQ="$MARKER_DIR/.checkpoint-required"
PRE_DONE="$MARKER_DIR/.pre-checkpoint-done"
POST_REQ="$MARKER_DIR/.post-checkpoint-required"
POST_DONE="$MARKER_DIR/.post-checkpoint-done"

# Read-only tools — always allowed
case "$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch|AskUserQuestion|EnterPlanMode|ExitPlanMode|ListMcpResourcesTool|ReadMcpResourceTool|Skill|mcp__*)
    exit 0
    ;;
esac

# Allowlist: Bash redirecting (>, >>, or tee) into a checkpoint-done marker.
# Three-step tightening history:
#   #65: require redirect operator before marker name (no longer just a
#        substring match) — blocked `cat /etc/passwd; echo .pre-checkpoint-done`.
#   #66: only check the part of the command BEFORE the first `<<` (heredoc /
#        here-string introducer). Heredoc bodies are text, not commands; a
#        redirect mentioned inside a heredoc body must not bypass the gate.
#        Example bypass that this addresses:
#          cat > readme.md <<EOF
#          echo > .pre-checkpoint-done
#          EOF
#        Pre-<< portion is `cat > readme.md `; no marker redirect → blocks.
#   #68: anchor the pattern to end-of-COMMAND_HEAD ([[:space:]]*$) so a
#        chained command after the marker write doesn't ride through the
#        allowlist. Pre-fix: `echo X > .pre-checkpoint-done; rm -rf /tmp`
#        passed the allowlist and the rm ran. Post-fix: trailing `;` (or
#        `&&`/`||`/`|`/`&`) after the marker filename means no match —
#        falls through to the gates' normal block path.
#
# Legitimate single-statement marker-writes still pass:
#   echo "..." > .pre-checkpoint-done
#   cat > .pre-checkpoint-done <<EOF\n...\nEOF
#   tee .post-checkpoint-done <<<"text"
#   printf "..." > .pre-checkpoint-done
#
# Known residuals (accepted): quoted strings and command substitution can
# still embed the redirect-to-marker pattern as text (#67); heredoc body
# followed by a chained command after EOF still bypasses (because the `<<`
# truncation drops everything from the heredoc onward).
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  COMMAND_HEAD="${COMMAND%%<<*}"
  # Flatten newlines to spaces (#72): grep -E evaluates line-by-line and `$`
  # matches end-of-line, so without flattening, `echo > marker\n; rm` would
  # match line 1 and bypass the allowlist. Flattening makes the whole
  # COMMAND_HEAD a single line so `$` matches end-of-string.
  COMMAND_HEAD_FLAT="${COMMAND_HEAD//$'\n'/ }"

  # #73 / #75: detect post-heredoc-EOF chained commands. If COMMAND has
  # `<<TERM`, find the terminator line and check for non-whitespace content
  # after it. If found, the allowlist must NOT match — heredoc body
  # legitimately writes the marker, but a chained command after EOF runs
  # unchecked.
  POST_HEREDOC_HAS_CONTENT=0
  if [ "$COMMAND_HEAD" != "$COMMAND" ]; then
    # Extract terminator from first <<. Handles bash heredoc forms:
    #   <<EOF, <<-EOF, <<'EOF', <<"EOF" (#73 initial coverage)
    #   <<\EOF (backslash-escaped, #75)
    #   <<123, <<==EOF==, etc. (any non-whitespace non-special term, #75)
    # Terminator class: non-whitespace, non-redirect, non-pipe-special,
    # non-quote chars. Optional leading `\` per bash quote-removal rules.
    TERM=$(printf '%s' "$COMMAND" | sed -nE "s/^[^<]*<<-?[[:space:]]*['\"]?\\\\?([^[:space:]<>|&;'\"]+).*/\1/p" | head -1)
    if [ -n "$TERM" ]; then
      # Find lines AFTER the first occurrence of the terminator-only line.
      # `<<-` form allows leading tabs on the terminator; awk strips them
      # before comparing.
      POST=$(printf '%s' "$COMMAND" | awk -v t="$TERM" '
        f { print; next }
        { line=$0; sub(/^\t+/, "", line); if (line==t) f=1 }
      ')
      if printf '%s' "$POST" | grep -qE '[^[:space:]]'; then
        POST_HEREDOC_HAS_CONTENT=1
      fi
    fi
  fi

  if [ "$POST_HEREDOC_HAS_CONTENT" = "0" ]; then
    if echo "$COMMAND_HEAD_FLAT" | grep -qE '(>|>>|tee[[:space:]]+)[^|&;<>]*\.(pre|post)-checkpoint-done[[:space:]]*$'; then
      exit 0
    fi
  fi
fi

# Pre-checkpoint gate
if [ -f "$PRE_REQ" ] && [ ! -s "$PRE_DONE" ]; then
  echo '{"decision": "block", "reason": "Checkpoint required. Write the Rule 18 pre-implementation checkpoint block to .claude/.pre-checkpoint-done (must be non-empty) before write tools are unblocked. Hook: checkpoint-gate.sh."}'
  exit 0
fi

# Push gate
# Match `git push` (with optional global flags between git and push) or
# `gh pr create`. Tightened from `git[[:space:]]+([^&;|]*[[:space:]])?push`
# per #69 — that allowed arbitrary tokens (including non-push subcommands
# like `commit -m push` or `branch push`) to ride between `git` and `push`,
# producing false positives that blocked legitimate non-push git commands.
# New form only allows global flag tokens: `-X`, `--long-flag`, `-X arg`.
if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND="$(echo "$INPUT" | jq -r '.tool_input.command // ""')"
  if echo "$COMMAND" | grep -qE '(^|[[:space:]&;|()])(git[[:space:]]+(-[^[:space:]]+[[:space:]]+([^-][^[:space:]]*[[:space:]]+)?)*push|gh[[:space:]]+pr[[:space:]]+create)([[:space:]&;|()]|$)'; then
    if [ -f "$POST_REQ" ] && [ ! -s "$POST_DONE" ]; then
      echo '{"decision": "block", "reason": "Post-implementation checkpoint required. Complete E2E testing and bug logging, then write the Rule 18 post-implementation checkpoint block to .claude/.post-checkpoint-done (must be non-empty) before pushing. Hook: checkpoint-gate.sh."}'
      exit 0
    fi
    rm -f "$PRE_REQ" "$PRE_DONE" "$POST_REQ" "$POST_DONE" 2>/dev/null || true
    exit 0
  fi
fi

# Allowed write — arm post-tracking if pre-checkpoint was satisfied
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|Bash|NotebookEdit)
    if [ -f "$PRE_REQ" ] && [ -s "$PRE_DONE" ]; then
      mkdir -p "$MARKER_DIR" 2>/dev/null || true
      touch "$POST_REQ" 2>/dev/null || true
    fi
    ;;
esac

exit 0
