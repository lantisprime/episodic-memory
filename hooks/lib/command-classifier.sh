#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-08.1
# command-classifier.sh — Quote/heredoc-aware Bash command classifier.
#
# Closes #86 PR-B + #89 + #101 via a shared helper. Replaces ad-hoc regex
# command detection in plan-gate.sh and checkpoint-gate.sh.
#
# Source this file and call:
#   classify_command "$cmd"  → echoes "LABEL\tTARGET\tREASON"
#   classify_path    "$path" → echoes "LABEL\tTARGET\tREASON" (for Write/Edit)
#
# Six labels (per Codex review `...cad2`/`...3503`):
#   read_only           pure observation (ls, cat, git status, gh pr view, …)
#   shared_write        local side-effect (git commit, npm install, mkdir, …)
#   push_or_pr_create   publishes/mutates shared state
#                         (git push, gh pr create/merge/close/…, gh issue …,
#                          gh release, gh api -X POST/PUT/PATCH/DELETE, …)
#   marker_write        gate-control deadlock-prevention (writes/removes a
#                         repo-root .claude/.* marker). TARGET = absolute path.
#   unsafe_complex      can't safely tokenize (bash -c, eval, $(...), backticks,
#                         unbalanced quotes, ambiguous heredoc, …)
#   unknown             parsed cleanly but doesn't match a known shape
#
# Tokenization strategy (Codex `...3503` P1):
#   Quote/heredoc-aware lexical scan FIRST, then split on UNQUOTED control
#   operators only. Never raw-split text on `&&`/`||`/`;`/`|`/newline before
#   tokenization — that recreates the false-positive class #101/#89 are
#   meant to eliminate.
#
# Output format (forward-compat for #80 H1 lifecycle records):
#   LABEL<TAB>TARGET<TAB>REASON
#   TARGET is empty for non-marker labels.
#   REASON is a short identifier of the rule that fired.

# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------
# _tokenize "$cmd" emits records to stdout, one per line:
#   T <text>      a token (word or quoted string concatenation)
#   O <op>        unquoted control operator: && || ; | & NL
#   R <text>      a redirection operator + filename pair: e.g. ">file"
#                 (recognized only at unquoted segment boundaries)
#   E <reason>    irrecoverable: unbalanced quote, command substitution, etc.
#                 callers MUST treat any E as unsafe_complex.
#
# Recognized constructs:
#   - single quotes: literal, no escapes
#   - double quotes: \" \\ \$ \` recognized; everything else literal
#   - $'…' ANSI-C: treated as token but NOT scanned for command substitution
#                  (still safe — it's a string literal)
#   - $"…" gettext: treated as a double-quoted string
#   - backslash escape outside quotes
#   - heredoc: <<TERM, <<-TERM, <<'TERM', <<"TERM", <<\TERM — body skipped
#              everything AFTER the heredoc terminator continues normal scan
#   - command substitution $(…) and `…` → emit E (unsafe_complex)
#   - process substitution <(…) >(…) → emit E (unsafe_complex)
#   - control operators: && || ; | & newline (only when unquoted)
#   - comments: # to end-of-line (only when at token boundary, unquoted)
#   - redirects: > >> < << <<< 2> 2>> &> >& with filename token

_tokenize() {
  local cmd="$1"
  local i=0 n=${#cmd}
  local c
  local cur=""        # current token being assembled
  local has_token=0   # 1 if cur represents a real token (vs empty)

  _flush() {
    if [ "$has_token" = "1" ]; then
      printf 'T %s\n' "$cur"
      cur=""
      has_token=0
    fi
  }

  while [ $i -lt $n ]; do
    c="${cmd:$i:1}"

    case "$c" in
      "'")
        # Single-quoted: literal until next '
        i=$((i+1))
        local sq=""
        while [ $i -lt $n ]; do
          local sc="${cmd:$i:1}"
          if [ "$sc" = "'" ]; then
            i=$((i+1))
            break
          fi
          sq="$sq$sc"
          i=$((i+1))
        done
        if [ $i -gt $n ]; then
          printf 'E unbalanced_single_quote\n'
          return 0
        fi
        # Was the closing quote actually consumed?
        # If we reached end without finding ', i==n and last char was not '.
        if [ $i -eq $n ] && [ "${cmd:$((n-1)):1}" != "'" ]; then
          printf 'E unbalanced_single_quote\n'
          return 0
        fi
        cur="$cur$sq"
        has_token=1
        ;;
      '"')
        # Double-quoted: \" \\ \$ \` honored; everything else literal.
        # $(…) and `…` inside double quotes still expand → unsafe.
        i=$((i+1))
        local dq=""
        local closed=0
        while [ $i -lt $n ]; do
          local dc="${cmd:$i:1}"
          if [ "$dc" = '"' ]; then
            i=$((i+1))
            closed=1
            break
          fi
          if [ "$dc" = '\' ] && [ $((i+1)) -lt $n ]; then
            local nx="${cmd:$((i+1)):1}"
            case "$nx" in
              '"'|'\'|'$'|'`'|'\n')
                dq="$dq$nx"
                i=$((i+2))
                continue
                ;;
            esac
            dq="$dq$dc"
            i=$((i+1))
            continue
          fi
          if [ "$dc" = '$' ] && [ $((i+1)) -lt $n ] && [ "${cmd:$((i+1)):1}" = '(' ]; then
            printf 'E command_substitution_in_double_quote\n'
            return 0
          fi
          if [ "$dc" = '`' ]; then
            printf 'E backtick_in_double_quote\n'
            return 0
          fi
          dq="$dq$dc"
          i=$((i+1))
        done
        if [ $closed -eq 0 ]; then
          printf 'E unbalanced_double_quote\n'
          return 0
        fi
        cur="$cur$dq"
        has_token=1
        ;;
      '$')
        # $'…' ANSI-C string, $"…" gettext, $(…) cmd-sub, ${…} param expansion
        local nx="${cmd:$((i+1)):1}"
        if [ "$nx" = "'" ]; then
          # ANSI-C: literal until next ' (with backslash escapes — for safety
          # treat content as literal text but consume escapes)
          i=$((i+2))
          local ac=""
          local aclosed=0
          while [ $i -lt $n ]; do
            local ach="${cmd:$i:1}"
            if [ "$ach" = "'" ]; then
              i=$((i+1))
              aclosed=1
              break
            fi
            if [ "$ach" = '\' ] && [ $((i+1)) -lt $n ]; then
              ac="$ac${cmd:$((i+1)):1}"
              i=$((i+2))
              continue
            fi
            ac="$ac$ach"
            i=$((i+1))
          done
          if [ $aclosed -eq 0 ]; then
            printf 'E unbalanced_ansic_quote\n'
            return 0
          fi
          cur="$cur$ac"
          has_token=1
        elif [ "$nx" = '"' ]; then
          # $"…" — treat as double-quoted (re-enter loop with dquote handler).
          # Easier: leave cur as-is, increment past $, fall through to next
          # iteration which will see " and handle it.
          i=$((i+1))
        elif [ "$nx" = '(' ]; then
          printf 'E command_substitution\n'
          return 0
        elif [ "$nx" = '{' ]; then
          # ${var} — accept as token char; we don't track variable values.
          cur="$cur\$"
          has_token=1
          i=$((i+1))
        else
          cur="$cur\$"
          has_token=1
          i=$((i+1))
        fi
        ;;
      '`')
        printf 'E backtick_substitution\n'
        return 0
        ;;
      '\')
        # Backslash escape outside quotes
        if [ $((i+1)) -lt $n ]; then
          local en="${cmd:$((i+1)):1}"
          if [ "$en" = $'\n' ]; then
            # Line continuation — skip both
            i=$((i+2))
            continue
          fi
          cur="$cur$en"
          has_token=1
          i=$((i+2))
        else
          # Trailing backslash
          i=$((i+1))
        fi
        ;;
      '#')
        # Comment only at token boundary
        if [ "$has_token" = "0" ]; then
          # Skip to end-of-line
          while [ $i -lt $n ] && [ "${cmd:$i:1}" != $'\n' ]; do
            i=$((i+1))
          done
        else
          cur="$cur$c"
          has_token=1
          i=$((i+1))
        fi
        ;;
      ' '|$'\t')
        _flush
        i=$((i+1))
        ;;
      $'\n')
        _flush
        printf 'O NL\n'
        i=$((i+1))
        ;;
      ';')
        _flush
        # ;; and ;& and ;;& are case-statement terminators; treat all as ;
        if [ "${cmd:$((i+1)):1}" = ";" ]; then
          printf 'O ;;\n'
          i=$((i+2))
        else
          printf 'O ;\n'
          i=$((i+1))
        fi
        ;;
      '&')
        _flush
        if [ "${cmd:$((i+1)):1}" = "&" ]; then
          printf 'O &&\n'
          i=$((i+2))
        elif [ "${cmd:$((i+1)):1}" = ">" ]; then
          # &> redirect — emit as redirect op
          printf 'O &>\n'
          i=$((i+2))
        else
          printf 'O &\n'
          i=$((i+1))
        fi
        ;;
      '|')
        _flush
        if [ "${cmd:$((i+1)):1}" = "|" ]; then
          printf 'O ||\n'
          i=$((i+2))
        else
          printf 'O |\n'
          i=$((i+1))
        fi
        ;;
      '>')
        _flush
        if [ "${cmd:$((i+1)):1}" = ">" ]; then
          printf 'O >>\n'
          i=$((i+2))
        elif [ "${cmd:$((i+1)):1}" = "(" ]; then
          printf 'E process_substitution\n'
          return 0
        else
          printf 'O >\n'
          i=$((i+1))
        fi
        ;;
      '<')
        # Heredoc / here-string / redirect / process-sub
        if [ "${cmd:$((i+1)):1}" = "<" ]; then
          # << or <<< or <<-
          if [ "${cmd:$((i+2)):1}" = "<" ]; then
            # <<< here-string — skip, then continue. Body is the next token.
            _flush
            printf 'O <<<\n'
            i=$((i+3))
          else
            # Heredoc <<TERM or <<-TERM (with optional ' " \ around TERM)
            _flush
            i=$((i+2))
            local strip_tabs=0
            if [ "${cmd:$i:1}" = "-" ]; then
              strip_tabs=1
              i=$((i+1))
            fi
            # Skip whitespace before TERM
            while [ $i -lt $n ]; do
              local hc="${cmd:$i:1}"
              if [ "$hc" = " " ] || [ "$hc" = $'\t' ]; then
                i=$((i+1))
              else
                break
              fi
            done
            # Read TERM (can be quoted)
            local term=""
            local first="${cmd:$i:1}"
            case "$first" in
              "'")
                i=$((i+1))
                while [ $i -lt $n ] && [ "${cmd:$i:1}" != "'" ]; do
                  term="$term${cmd:$i:1}"
                  i=$((i+1))
                done
                [ $i -lt $n ] && i=$((i+1))
                ;;
              '"')
                i=$((i+1))
                while [ $i -lt $n ] && [ "${cmd:$i:1}" != '"' ]; do
                  term="$term${cmd:$i:1}"
                  i=$((i+1))
                done
                [ $i -lt $n ] && i=$((i+1))
                ;;
              '\')
                i=$((i+1))
                while [ $i -lt $n ]; do
                  local tc="${cmd:$i:1}"
                  case "$tc" in
                    [[:space:]\<\>\|\&\;\'\"]) break ;;
                  esac
                  term="$term$tc"
                  i=$((i+1))
                done
                ;;
              *)
                while [ $i -lt $n ]; do
                  local tc="${cmd:$i:1}"
                  case "$tc" in
                    [[:space:]\<\>\|\&\;\'\"]) break ;;
                  esac
                  term="$term$tc"
                  i=$((i+1))
                done
                ;;
            esac
            if [ -z "$term" ]; then
              printf 'E heredoc_no_terminator\n'
              return 0
            fi
            printf 'O HEREDOC\n'
            printf 'T %s\n' "$term"
            # Skip to end of current line
            while [ $i -lt $n ] && [ "${cmd:$i:1}" != $'\n' ]; do
              i=$((i+1))
            done
            [ $i -lt $n ] && i=$((i+1))
            # Skip heredoc body until line that equals TERM (with optional
            # leading tabs if strip_tabs)
            local found_terminator=0
            while [ $i -lt $n ]; do
              # Read one line
              local line=""
              while [ $i -lt $n ] && [ "${cmd:$i:1}" != $'\n' ]; do
                line="$line${cmd:$i:1}"
                i=$((i+1))
              done
              [ $i -lt $n ] && i=$((i+1))
              local ckline="$line"
              if [ "$strip_tabs" = "1" ]; then
                # Strip leading tabs
                while [ "${ckline:0:1}" = $'\t' ]; do
                  ckline="${ckline:1}"
                done
              fi
              if [ "$ckline" = "$term" ]; then
                found_terminator=1
                break
              fi
            done
            if [ $found_terminator -eq 0 ]; then
              printf 'E heredoc_unterminated\n'
              return 0
            fi
            # After heredoc body ends, force a segment break. Anything after
            # the heredoc terminator is a NEW command; without this break,
            # `cat > .pre-checkpoint-done <<EOF\n...\nEOF\nrm -rf /` would
            # pass through as a single segment and the classifier would only
            # see the marker_write, missing the chained rm.
            printf 'O NL\n'
          fi
        elif [ "${cmd:$((i+1)):1}" = "(" ]; then
          printf 'E process_substitution\n'
          return 0
        else
          _flush
          printf 'O <\n'
          i=$((i+1))
        fi
        ;;
      *)
        cur="$cur$c"
        has_token=1
        i=$((i+1))
        ;;
    esac
  done

  _flush
  return 0
}

# ---------------------------------------------------------------------------
# Per-segment classifier
# ---------------------------------------------------------------------------
# Reads tokens (T-records and redirect O-records) from stdin for ONE segment,
# echoes "LABEL\tTARGET\tREASON".
#
# Algorithm:
#   1. Strip leading env-assignment tokens (VAR=value).
#   2. If no tokens left → unknown / empty.
#   3. Detect `bash -c`, `sh -c`, `eval`, `source <file>` → unsafe_complex.
#   4. Detect redirect-into-marker (any token > or >> or &> followed by a
#      target token whose basename is .pre-checkpoint-done /
#      .post-checkpoint-done / .plan-approval-pending) → marker_write.
#   5. Detect rm-of-marker: `rm [flags] <path-with-marker-basename>`.
#   6. Detect tee/cat-redirect into marker.
#   7. First non-flag token is `git` → classify by subcommand.
#   8. First non-flag token is `gh` → classify by subcommand.
#   9. First non-flag token is in read-only allowlist → read_only.
#  10. Otherwise → shared_write (default for write-side commands we don't
#      explicitly recognize).

_classify_segment() {
  local target_root="$1"  # repo root for marker resolution
  shift

  # Read all token + redirect records into arrays
  local -a TOKS=()
  local -a REDIRS=()  # each: "OP\tTARGET" pair for redirection
  local pending_redir=""
  while IFS= read -r line; do
    case "$line" in
      "T "*)
        local txt="${line:2}"
        if [ -n "$pending_redir" ]; then
          REDIRS+=("$pending_redir"$'\t'"$txt")
          pending_redir=""
        else
          TOKS+=("$txt")
        fi
        ;;
      "O >")
        pending_redir=">"
        ;;
      "O >>")
        pending_redir=">>"
        ;;
      "O &>")
        pending_redir="&>"
        ;;
      "O <"|"O <<<"|"O HEREDOC")
        # Inputs / heredocs don't matter for write classification
        ;;
      *)
        # Other operators shouldn't appear (segments are pre-split)
        ;;
    esac
  done

  # ---- Check redirects for marker writes ----
  # If any output redirect targets a marker → marker_write.
  # If any output redirect targets a non-marker → has_nonmarker_redirect, which
  # forces shared_write later (overrides read-only command classification —
  # `echo hello > file.txt` is a write even though `echo` is read-only).
  #
  # Exception: device pseudo-files in /dev/ that are non-persistent sinks/sources
  # (/dev/null, /dev/stdout, /dev/stderr, /dev/tty, /dev/zero) never affect
  # shared state, so they must NOT upgrade the redirect-source command. A
  # read-only command such as `ls >/dev/null` remains read_only; other commands
  # keep their normal classification (e.g. `git push >/dev/null` still
  # classifies as push_or_pr_create via its own command rule). Exact-string
  # match — symlinks to /dev/null fall through to the conservative shared_write
  # default.
  local r
  local has_nonmarker_redirect=0
  for r in ${REDIRS[@]+"${REDIRS[@]}"}; do
    local rop="${r%%	*}"
    local rtarget="${r#*	}"
    local rbase="$(basename "$rtarget")"
    case "$rtarget" in
      /dev/null|/dev/stdout|/dev/stderr|/dev/tty|/dev/zero)
        # Benign device sink — skip the has_nonmarker_redirect upgrade.
        continue
        ;;
    esac
    # Same-class scope mirrors the rm/tee handlers below. Codex round-1 F1
    # on PR #246 (HOLD): the redirect handler covered only 3 of 6 checkpoint
    # markers and was missing both `.preflight-done` AND the new last-user-
    # prompt family — so `printf x > .checkpoints/.last-user-prompt.<sid>.json`
    # classified as `shared_write` and bypassed the entire prompt-binding
    # layered enforcement.
    case "$rbase" in
      .pre-checkpoint-done|.post-checkpoint-done|.plan-approval-pending|.checkpoint-required|.post-checkpoint-required|.preflight-done|.last-user-prompt.json)
        local abs_target
        abs_target="$(_resolve_marker_path "$rtarget" "$target_root")"
        printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "redirect_to_marker"
        return 0
        ;;
      .last-user-prompt.*.json)
        local abs_target
        abs_target="$(_resolve_marker_path "$rtarget" "$target_root")"
        printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "redirect_to_marker"
        return 0
        ;;
      # #268 fix E1: per-session plan-marker via redirect. Same shape as
      # the legacy literal case-arm above. Loose glob here; strict validation
      # via plan_marker_basename_matches happens in checkpoint-gate.sh.
      .plan-approval-pending.*)
        local abs_target
        abs_target="$(_resolve_marker_path "$rtarget" "$target_root")"
        printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "redirect_to_marker"
        return 0
        ;;
      .so-runbook-shown.*)
        # Runbook UX-marker (second-opinion-gate). Same-class with the
        # other marker write surfaces; classifies as marker_write so the
        # touch/rm/tee/redirect paths share the wrong-root detection +
        # exemption flow in checkpoint-gate.sh.
        local abs_target
        abs_target="$(_resolve_marker_path "$rtarget" "$target_root")"
        printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "redirect_to_marker"
        return 0
        ;;
      *)
        has_nonmarker_redirect=1
        ;;
    esac
  done

  # ---- Strip leading env-assignment tokens (VAR=value) ----
  # #268 fix F17/F18: also count how many env-prefix tokens were stripped
  # so plan-marker helper detection (below) can reject command-local env
  # override attacks (`CLAUDE_CODE_SESSION_ID=B node plan-marker.mjs --rm …`).
  # Pattern is POSIX `name = [A-Za-z_][A-Za-z0-9_]*` (lowercase + digits + _).
  #
  # #272 F-4: walk only recognizes the LEADING `VAR=value` form. Sequential
  # env mutation via `unset CLAUDE_CODE_SESSION_ID; node plan-marker.mjs …`
  # OR `export CLAUDE_CODE_SESSION_ID=B; node plan-marker.mjs …` is not
  # detected here — but both shapes hit `shell_keyword_or_group` /
  # multi-command-segment paths upstream and the plan-marker helper itself
  # fails closed (exit 8) when the resolved sid doesn't match its own
  # session-id env var. Honest-agent threat: low (the helper is the
  # authoritative defense, not the classifier). FU candidate: extend the
  # tokenizer to track env-state across segments if a future repro shows
  # a classifier-only bypass path.
  local idx=0
  local env_prefix_count=0
  while [ $idx -lt ${#TOKS[@]} ]; do
    case "${TOKS[$idx]}" in
      [A-Za-z_]*=*)
        env_prefix_count=$((env_prefix_count+1))
        idx=$((idx+1))
        ;;
      *)
        break
        ;;
    esac
  done
  if [ $idx -ge ${#TOKS[@]} ]; then
    printf '%s\t\t%s\n' "read_only" "empty_or_env_only"
    return 0
  fi

  local first="${TOKS[$idx]}"

  # ---- Empty / no-op shells ----
  case "$first" in
    :|true|false)
      printf '%s\t\t%s\n' "read_only" "no_op_builtin"
      return 0
      ;;
  esac

  # ---- Unsafe shell forms (Audit P1: control-flow + wrappers) ----
  # Any control-flow keyword or shell-group token AT ANY POSITION in the
  # segment makes structural classification unreliable: `while true; do
  # git push; done` and `( git push )` would otherwise classify by their
  # first token (`while`, `(`) and never reach _classify_git. Conservative
  # block-by-default — these are rare in normal Bash tool calls.
  local _ti
  for _ti in "${TOKS[@]+${TOKS[@]}}"; do
    case "$_ti" in
      "if"|"then"|"else"|"elif"|"fi"|"for"|"while"|"until"|"do"|"done"|"case"|"esac"|"select"|"function"|"{"|"}"|"("|")"|"[["|"]]")
        printf '%s\t\t%s\n' "unsafe_complex" "shell_keyword_or_group"
        return 0
        ;;
    esac
  done

  # Wrapper utilities that execute their argument (env, command, sudo,
  # nohup, nice, ionice, time, timeout, xargs, watch). Treat as
  # unsafe_complex so the structural escape `env GIT_DIR=… git push`
  # cannot bypass push detection by classifying as read_only.
  case "$first" in
    env|command|sudo|nohup|nice|ionice|time|timeout|xargs|watch|stdbuf|chronic)
      printf '%s\t\t%s\n' "unsafe_complex" "wrapper_utility_${first}"
      return 0
      ;;
  esac

  # ---- #268 fix E5b: plan-marker.mjs helper invocation ----
  # Recognize `node */plan-marker.mjs --touch|--rm --root <abs>` and emit
  # marker_write with TARGET = canonical per-session marker path. This is
  # the canonical Rule 8 approval invocation; plan-gate.sh must allow it
  # while a plan-pending marker exists for this session.
  #
  # F17/F18 reject: any leading POSIX-name env assignment (env_prefix_count
  # > 0) → emit unsafe_complex. Otherwise session A could write
  #   CLAUDE_CODE_SESSION_ID=B node ~/.episodic-memory/scripts/plan-marker.mjs --rm --root /repo
  # and remove session B's marker while the classifier computes TARGET for
  # session A. The shell command-local env assignment overrides
  # process.env for the spawned `node` process; classifier and helper
  # would target different markers (split-brain bypass).
  if [ "$first" = "node" ]; then
    local _next_idx=$((idx+1))
    local _script_arg=""
    if [ $_next_idx -lt ${#TOKS[@]} ]; then
      _script_arg="${TOKS[$_next_idx]}"
    fi
    case "$_script_arg" in
      */plan-marker.mjs)
        # F17/F18: reject any leading env assignment.
        if [ $env_prefix_count -gt 0 ]; then
          printf '%s\t\t%s\n' "unsafe_complex" "plan_marker_env_override"
          return 0
        fi
        # Parse --root <ARG> from remaining tokens
        local _helper_root="" _has_touch=0 _has_rm=0
        local _k=$((_next_idx+1))
        while [ $_k -lt ${#TOKS[@]} ]; do
          case "${TOKS[$_k]}" in
            --root)
              _k=$((_k+1))
              if [ $_k -lt ${#TOKS[@]} ]; then
                _helper_root="${TOKS[$_k]}"
              fi
              ;;
            --touch) _has_touch=1 ;;
            --rm)    _has_rm=1 ;;
          esac
          _k=$((_k+1))
        done
        # Resolve session-id from env (same source the helper will read).
        local _env_sid="${CLAUDE_CODE_SESSION_ID:-}"
        # Compose target. If --root or sid is missing, emit marker_write
        # with empty TARGET; gate's existing equality check will fail and
        # block — helper would also fail-closed anyway.
        local _target=""
        if [ -n "$_helper_root" ] && [ -n "$_env_sid" ]; then
          _target="${_helper_root}/.checkpoints/.plan-approval-pending.${_env_sid}"
        fi
        local _reason="plan_marker_helper"
        if [ $_has_touch -eq 1 ] && [ $_has_rm -eq 1 ]; then
          # Mutex violation in args — helper will exit 6 anyway. Classify as
          # unsafe_complex; gate blocks.
          printf '%s\t\t%s\n' "unsafe_complex" "plan_marker_mutex_violation"
          return 0
        elif [ $_has_touch -eq 1 ]; then
          _reason="plan_marker_touch"
        elif [ $_has_rm -eq 1 ]; then
          _reason="plan_marker_rm"
        else
          # Missing action — helper will exit 6. Classify as unsafe_complex.
          printf '%s\t\t%s\n' "unsafe_complex" "plan_marker_missing_action"
          return 0
        fi
        printf '%s\t%s\t%s\n' "marker_write" "$_target" "$_reason"
        return 0
        ;;
    esac
  fi

  case "$first" in
    bash|sh|zsh|dash|ksh)
      # Is there a -c flag?
      local j=$((idx+1))
      while [ $j -lt ${#TOKS[@]} ]; do
        if [ "${TOKS[$j]}" = "-c" ]; then
          printf '%s\t\t%s\n' "unsafe_complex" "shell_dash_c"
          return 0
        fi
        j=$((j+1))
      done
      ;;
    eval)
      printf '%s\t\t%s\n' "unsafe_complex" "eval"
      return 0
      ;;
    source|.)
      printf '%s\t\t%s\n' "unsafe_complex" "source_or_dot"
      return 0
      ;;
    exec)
      printf '%s\t\t%s\n' "unsafe_complex" "exec"
      return 0
      ;;
  esac

  # ---- rm-of-marker ----
  if [ "$first" = "rm" ]; then
    local j=$((idx+1))
    while [ $j -lt ${#TOKS[@]} ]; do
      local t="${TOKS[$j]}"
      case "$t" in
        -*) j=$((j+1)); continue ;;
      esac
      local tbase="$(basename "$t")"
      # Preflight markers added per plan-v2 I10 (audit F1 same-class):
      # the rm-marker class was missing `.preflight-done` (PR #240 oversight)
      # and the new session-namespaced `.last-user-prompt.<sid>.json` files.
      # Without these, `rm .checkpoints/.preflight-done` (or the per-session
      # last-prompt file) from Bash bypasses the gate's direct-Write deny
      # and re-opens the trust-based hole the gate exists to close.
      case "$tbase" in
        .plan-approval-pending|.pre-checkpoint-done|.post-checkpoint-done|.checkpoint-required|.post-checkpoint-required|.preflight-done|.last-user-prompt.json)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "rm_marker"
          return 0
          ;;
        # #268 fix E2: per-session plan-marker via rm. Loose glob; strict
        # validation happens at checkpoint-gate.sh marker_basename_for_target.
        .plan-approval-pending.*)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "rm_marker"
          return 0
          ;;
        .last-user-prompt.*.json)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "rm_marker"
          return 0
          ;;
        .so-runbook-shown.*)
          # Runbook UX-marker (second-opinion-gate). Same-class with other
          # marker rm surfaces. SessionStart cleanup uses rm at canonical
          # root; this classification keeps the touch/rm pair symmetric.
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "rm_marker"
          return 0
          ;;
      esac
      j=$((j+1))
    done
    # Plain rm of non-marker → shared_write
    printf '%s\t\t%s\n' "shared_write" "rm_non_marker"
    return 0
  fi

  # ---- tee with marker ----
  if [ "$first" = "tee" ]; then
    local j=$((idx+1))
    while [ $j -lt ${#TOKS[@]} ]; do
      local t="${TOKS[$j]}"
      case "$t" in
        -*) j=$((j+1)); continue ;;
      esac
      local tbase="$(basename "$t")"
      # Same-class extension per plan-v2 I10 — see rm-of-marker comment above.
      # Codex round-2 FU on PR #246: tee was still missing
      # `.checkpoint-required` and `.post-checkpoint-required` (latent
      # pre-existing gap, parallel shape to the rm-class C4 fix); closing
      # for class-completeness so the same-class lens is tight across all
      # write surfaces.
      case "$tbase" in
        .pre-checkpoint-done|.post-checkpoint-done|.plan-approval-pending|.checkpoint-required|.post-checkpoint-required|.preflight-done|.last-user-prompt.json)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "tee_marker"
          return 0
          ;;
        # #268 fix E3: per-session plan-marker via tee.
        .plan-approval-pending.*)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "tee_marker"
          return 0
          ;;
        .last-user-prompt.*.json)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "tee_marker"
          return 0
          ;;
        .so-runbook-shown.*)
          # Runbook UX-marker (second-opinion-gate). Same-class with other
          # marker tee surfaces. Kept symmetric with rm/touch/redirect.
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "tee_marker"
          return 0
          ;;
      esac
      break
    done
  fi

  # ---- touch with marker ----
  # Same-class with rm/tee/redirect handlers. Recognizes the full closed
  # marker set so touch becomes a first-class marker_write path, not a
  # silent fall-through to shared_write (which would block the touch under
  # an active .checkpoint-required pre-gate). Codex r1 P1: hooks/runbooks
  # touch must classify as marker_write so the exemption case fires.
  if [ "$first" = "touch" ]; then
    local j=$((idx+1))
    while [ $j -lt ${#TOKS[@]} ]; do
      local t="${TOKS[$j]}"
      case "$t" in
        -*) j=$((j+1)); continue ;;
      esac
      local tbase="$(basename "$t")"
      case "$tbase" in
        .pre-checkpoint-done|.post-checkpoint-done|.plan-approval-pending|.checkpoint-required|.post-checkpoint-required|.preflight-done|.last-user-prompt.json)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "touch_marker"
          return 0
          ;;
        # #268 fix E4: per-session plan-marker via touch.
        .plan-approval-pending.*)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "touch_marker"
          return 0
          ;;
        .last-user-prompt.*.json)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "touch_marker"
          return 0
          ;;
        .so-runbook-shown.*)
          # Runbook UX-marker (second-opinion-gate). Model writes this
          # marker after Read of the runbook contents; classification as
          # marker_write routes the write through checkpoint-gate's
          # exemption case (canonical-root check + plan-pending bypass).
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "touch_marker"
          return 0
          ;;
      esac
      j=$((j+1))
    done
    # touch of non-marker → shared_write (matches rm semantics)
    printf '%s\t\t%s\n' "shared_write" "touch_non_marker"
    return 0
  fi

  # ---- git ----
  if [ "$first" = "git" ]; then
    _classify_git "$idx" "${TOKS[@]}"
    return 0
  fi

  # ---- gh ----
  if [ "$first" = "gh" ]; then
    _classify_gh "$idx" "${TOKS[@]}"
    return 0
  fi

  # ---- Read-only command allowlist ----
  case "$first" in
    ls|cat|head|tail|grep|egrep|fgrep|rg|find|wc|awk|sed|tr|cut|sort|uniq|file|stat|du|df|pwd|whoami|hostname|date|printenv|which|tree|less|more|jq|yq|cmp|diff|column)
      # Audit P1: env / command / type / sudo / xargs / nohup / nice / ionice
      # / time / timeout deliberately NOT here. They are wrapper utilities
      # that execute the next argument — `env GIT_DIR=… git push` would
      # bypass push detection if env classified as read_only. tee likewise:
      # always writes. Err safe and let those fall through to default
      # shared_write or, where structural risk warrants, unsafe_complex below.
      if [ "$has_nonmarker_redirect" = "1" ]; then
        printf '%s\t\t%s\n' "shared_write" "readonly_cmd_redirected"
        return 0
      fi
      printf '%s\t\t%s\n' "read_only" "readonly_cmd"
      return 0
      ;;
    echo|printf|true|false)
      # echo/printf with output redirect → shared_write; without → read_only.
      if [ "$has_nonmarker_redirect" = "1" ]; then
        printf '%s\t\t%s\n' "shared_write" "echo_redirected"
        return 0
      fi
      printf '%s\t\t%s\n' "read_only" "echo_or_printf"
      return 0
      ;;
    node|python|python3|ruby|perl)
      # Interpreters: classify by script name if it's a known em-* read script
      local script="${TOKS[$((idx+1))]:-}"
      case "$(basename "$script" 2>/dev/null)" in
        em-search.mjs|em-list.mjs|em-watch-codex.mjs|em-pattern-health.mjs|em-check-stale.mjs|em-rebuild-index.mjs)
          # em-rebuild-index touches index.jsonl — treat as shared_write
          if [ "$(basename "$script")" = "em-rebuild-index.mjs" ]; then
            printf '%s\t\t%s\n' "shared_write" "interpreter_em_rebuild"
            return 0
          fi
          printf '%s\t\t%s\n' "read_only" "interpreter_em_read"
          return 0
          ;;
        em-store.mjs|em-revise.mjs|em-prune.mjs|em-violation.mjs|em-recall.mjs|em-workflow-validate.mjs)
          printf '%s\t\t%s\n' "shared_write" "interpreter_em_write"
          return 0
          ;;
      esac
      printf '%s\t\t%s\n' "shared_write" "interpreter_other"
      return 0
      ;;
  esac

  # ---- Default ----
  printf '%s\t\t%s\n' "shared_write" "default_write"
  return 0
}

# git subcommand classifier
_classify_git() {
  local start=$1
  shift
  local -a T=("$@")
  local n=${#T[@]}

  # Skip global flags after `git`. Per current checkpoint-gate.sh push regex:
  # only allow flag tokens between git and subcommand. Long --opt[=val] and
  # -X arg pairs both possible.
  local i=$((start+1))
  local sub=""
  while [ $i -lt $n ]; do
    local t="${T[$i]}"
    case "$t" in
      --*=*) i=$((i+1)); continue ;;
      --no-pager|--bare|--paginate|--git-dir|--work-tree|--namespace|--exec-path|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--super-prefix|--config-env|-C|-c)
        # -C and -c take an argument
        case "$t" in
          -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)
            i=$((i+2))
            ;;
          *)
            i=$((i+1))
            ;;
        esac
        continue
        ;;
      -*) i=$((i+1)); continue ;;
      *) sub="$t"; break ;;
    esac
  done

  if [ -z "$sub" ]; then
    printf '%s\t\t%s\n' "shared_write" "git_no_subcommand"
    return 0
  fi

  case "$sub" in
    push)
      printf '%s\t\t%s\n' "push_or_pr_create" "git_push"
      return 0
      ;;
    status|log|diff|show|rev-parse|rev-list|reflog|blame|grep|describe|ls-files|ls-tree|ls-remote|fetch|cat-file|var|help|version|shortlog|whatchanged|name-rev|check-ignore|check-mailmap|check-attr|annotate|count-objects)
      # Pure reads. fetch is a network op with no remote mutation.
      printf '%s\t\t%s\n' "read_only" "git_read_subcommand"
      return 0
      ;;
    branch|tag)
      # Issue #116 [P1]: read forms with positionals were misclassified.
      # Inverted default per Plan-agent recommendation: detect write flags
      # explicitly; read flags + free positionals = read; bare positional
      # (no flags) = create (write).
      local _gj=$((i+1))
      local _has_write_flag=0 _has_read_flag=0 _free_positional=0
      while [ $_gj -lt ${#T[@]} ]; do
        local _gt="${T[$_gj]}"
        case "$_gt" in
          # Write flags (delete / rename / copy / move / track / sign / edit)
          -d|-D|-m|-M|-c|-C|--delete|--rename|--copy|--move|-u|--track|--no-track|--unset-upstream|-f|--force|-s|--sign|--edit-description|--set-upstream-to|--cleanup)
            _has_write_flag=1 ;;
          --edit-description=*|--set-upstream-to=*|--cleanup=*)
            _has_write_flag=1 ;;
          # Read flags (list / filter / sort / format / verbose)
          --list|-l|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|-a|-r|-v|-vv|--all|--remotes|--show-current|-q|--quiet|--no-color|--ignore-case|-i)
            _has_read_flag=1 ;;
          --list=*|--contains=*|--no-contains=*|--merged=*|--no-merged=*|--points-at=*|--sort=*|--format=*|--column=*)
            _has_read_flag=1 ;;
          -n*) _has_read_flag=1 ;;  # tag -n[N]
          --*=*) ;;                  # unknown equals-form
          -*) ;;                     # unknown flag — neutral
          *)  _free_positional=1 ;;
        esac
        _gj=$((_gj+1))
      done
      if [ $_has_write_flag -eq 1 ]; then
        printf '%s\t\t%s\n' "shared_write" "git_${sub}_write_flag"
        return 0
      fi
      if [ $_free_positional -eq 1 ] && [ $_has_read_flag -eq 0 ]; then
        # Bare `git branch new-name` or `git tag v1.0` creates.
        printf '%s\t\t%s\n' "shared_write" "git_${sub}_create"
        return 0
      fi
      printf '%s\t\t%s\n' "read_only" "git_${sub}_read"
      return 0
      ;;
    remote)
      # Inverted default: known write subcommands explicitly listed.
      # Anything else (incl. get-url, show, show-url, get-all, -v, -vv) → read.
      local _gj=$((i+1))
      while [ $_gj -lt ${#T[@]} ]; do
        case "${T[$_gj]}" in
          -*) _gj=$((_gj+1));;
          *)  break ;;
        esac
      done
      if [ $_gj -lt ${#T[@]} ]; then
        case "${T[$_gj]}" in
          add|remove|rm|rename|set-url|set-head|set-branches|prune|update)
            printf '%s\t\t%s\n' "shared_write" "git_remote_${T[$_gj]}"
            return 0 ;;
        esac
      fi
      printf '%s\t\t%s\n' "read_only" "git_remote_read"
      return 0
      ;;
    worktree)
      local _gj=$((i+1))
      while [ $_gj -lt ${#T[@]} ]; do
        case "${T[$_gj]}" in
          -*) _gj=$((_gj+1));;
          *)  break ;;
        esac
      done
      if [ $_gj -lt ${#T[@]} ]; then
        # Subagent code review: lock/unlock/prune mutate state too (locks
        # touch metadata; prune removes stale entries). Previous version had
        # them as writes; the inverted-default revision dropped them. Restore.
        case "${T[$_gj]}" in
          add|remove|move|repair|lock|unlock|prune)
            printf '%s\t\t%s\n' "shared_write" "git_worktree_${T[$_gj]}"
            return 0 ;;
        esac
      fi
      printf '%s\t\t%s\n' "read_only" "git_worktree_read"
      return 0
      ;;
    config)
      # Write detection: explicit write flag OR (2+ free positionals AND no
      # explicit read flag). Scope flags (--global/--system/--local/
      # --worktree) and value-taking option flags (--file/--blob/-f/--type/
      # --default) consumed without counting as positionals.
      #
      # Subagent code review fixes:
      # - --remove-section / --rename-section are writes (was missed).
      # - --get / --get-all / --get-regexp / --get-urlmatch / --get-color /
      #   --get-colorbool / --list / -l are explicit READ flags. They take
      #   one or more positional args but those args are NOT a key/value
      #   set-form pair. Suppress the _np>=2 rule when any read flag is
      #   present (e.g. `git config --get-color color.diff red` is read).
      local _gj=$((i+1))
      local _has_write_flag=0 _has_read_flag=0 _np=0
      while [ $_gj -lt ${#T[@]} ]; do
        local _gt="${T[$_gj]}"
        case "$_gt" in
          --unset|--unset-all|--add|--replace-all|--edit|-e|--remove-section|--rename-section)
            _has_write_flag=1 ;;
          --get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l|--show-scope|--show-origin|--name-only|--includes|--no-includes|-z|--null)
            _has_read_flag=1 ;;
          --file|--blob|-f|--type|--default)
            _gj=$((_gj+1)) ;;
          --file=*|--blob=*|--type=*|--default=*) ;;
          --*=*) ;;
          -*) ;;
          *) _np=$((_np+1)) ;;
        esac
        _gj=$((_gj+1))
      done
      if [ $_has_write_flag -eq 1 ]; then
        printf '%s\t\t%s\n' "shared_write" "git_config_write_flag"
        return 0
      fi
      if [ $_np -ge 2 ] && [ $_has_read_flag -eq 0 ]; then
        printf '%s\t\t%s\n' "shared_write" "git_config_set"
        return 0
      fi
      printf '%s\t\t%s\n' "read_only" "git_config_read"
      return 0
      ;;
    commit|add|rm|mv|reset|restore|checkout|switch|merge|rebase|cherry-pick|revert|stash|clean|pull|clone|init|gc|prune|notes|submodule|apply|am|format-patch|bisect|update-index|update-ref|symbolic-ref|hash-object|mktree|read-tree|write-tree|commit-tree|fsck|repack|pack-refs|pack-objects|unpack-objects|prune-packed|rerere|filter-branch|replay|sparse-checkout|maintenance)
      printf '%s\t\t%s\n' "shared_write" "git_local_write"
      return 0
      ;;
    *)
      printf '%s\t\t%s\n' "shared_write" "git_unknown_subcommand"
      return 0
      ;;
  esac
}

# gh subcommand classifier
_classify_gh() {
  local start=$1
  shift
  local -a T=("$@")
  local n=${#T[@]}

  local i=$((start+1))
  # Skip gh global flags
  while [ $i -lt $n ]; do
    case "${T[$i]}" in
      --help|-h|--version|--repo|-R)
        if [ "${T[$i]}" = "--repo" ] || [ "${T[$i]}" = "-R" ]; then
          i=$((i+2))
        else
          i=$((i+1))
        fi
        ;;
      -*) i=$((i+1)) ;;
      *) break ;;
    esac
  done

  local cmd="${T[$i]:-}"
  local sub="${T[$((i+1))]:-}"

  case "$cmd" in
    "")
      printf '%s\t\t%s\n' "read_only" "gh_no_command"
      return 0
      ;;
    pr)
      case "$sub" in
        create|merge|close|reopen|edit|comment|ready|update-branch|revert)
          # update-branch added during commit 8 subagent review (same F2
          # pathology: a write verb that updates the PR head on the remote).
          # revert added during commit 9 per Codex `...9fc4` (creates a
          # revert PR — same shared-mutation class as create).
          printf '%s\t\t%s\n' "push_or_pr_create" "gh_pr_${sub}"
          return 0
          ;;
        review)
          # Codex PR #113 review finding 2 [P1]: gh pr review --comment was
          # shared_write, but checkpoint-gate push-gate only blocks
          # push_or_pr_create — bypass. ALL gh pr review forms write a review
          # state to the PR (the --comment flag still posts a review record,
          # not a side-comment). Treat all as push_or_pr_create.
          printf '%s\t\t%s\n' "push_or_pr_create" "gh_pr_review"
          return 0
          ;;
        list|view|status|diff|checks)
          printf '%s\t\t%s\n' "read_only" "gh_pr_${sub}"
          return 0
          ;;
        checkout)
          # Codex PR #113 F2 [P1] (`...9796`/`...9cdd`): gh pr checkout
          # mutates the local working tree (fetches the PR ref, switches/
          # creates a branch, may stomp uncommitted changes). It is not a
          # read of GitHub state. Classify shared_write so plan-gate and
          # checkpoint pre-gate block it; not push_or_pr_create because
          # nothing is published to the remote.
          printf '%s\t\t%s\n' "shared_write" "gh_pr_checkout"
          return 0
          ;;
        lock|unlock)
          # Codex PR #113 F2 [P1] (`...9796`/`...9cdd`): gh pr lock|unlock
          # mutate shared GitHub state (PR comment-locking is observable to
          # everyone with repo access). Mirror gh issue lock|unlock which
          # was already correctly classified. push_or_pr_create routes
          # through the checkpoint post-gate (visible-to-others bucket).
          printf '%s\t\t%s\n' "push_or_pr_create" "gh_pr_${sub}"
          return 0
          ;;
        *)
          # All known `gh pr` write verbs are enumerated above. Default
          # is shared_write so unknown future subcommands fail safe (block
          # plan-gate / pre-gate) without bypassing the push-gate's
          # narrower bucket. If a new shared/remote-mutating verb lands,
          # add it explicitly above.
          printf '%s\t\t%s\n' "shared_write" "gh_pr_unknown"
          return 0
          ;;
      esac
      ;;
    issue)
      case "$sub" in
        create|close|reopen|edit|comment|delete|develop|lock|unlock|pin|unpin|transfer)
          printf '%s\t\t%s\n' "push_or_pr_create" "gh_issue_${sub}"
          return 0
          ;;
        list|view|status)
          printf '%s\t\t%s\n' "read_only" "gh_issue_${sub}"
          return 0
          ;;
        *)
          printf '%s\t\t%s\n' "shared_write" "gh_issue_unknown"
          return 0
          ;;
      esac
      ;;
    release|repo|gist|label|workflow|run|secret|variable|ssh-key|gpg-key)
      case "$sub" in
        list|view|status|download)
          printf '%s\t\t%s\n' "read_only" "gh_${cmd}_${sub}"
          return 0
          ;;
        "")
          printf '%s\t\t%s\n' "read_only" "gh_${cmd}_no_sub"
          return 0
          ;;
        *)
          printf '%s\t\t%s\n' "push_or_pr_create" "gh_${cmd}_${sub}"
          return 0
          ;;
      esac
      ;;
    api)
      # gh api: detect method.
      # Default GET → read_only.
      # -X / -XPOST / -X=POST / --method POST/PUT/PATCH/DELETE → push_or_pr_create.
      # gh api graphql → unsafe_complex (mutation detection in body too brittle).
      local j=$((i+1))
      local saw_graphql=0
      local method="GET"
      while [ $j -lt $n ]; do
        local t="${T[$j]}"
        case "$t" in
          graphql) saw_graphql=1; j=$((j+1)) ;;
          -X|--method)
            method="${T[$((j+1))]:-GET}"
            j=$((j+2))
            ;;
          -X=*|--method=*)
            method="${t#*=}"
            j=$((j+1))
            ;;
          -X*)
            # -XPOST glued
            method="${t:2}"
            j=$((j+1))
            ;;
          *)
            j=$((j+1))
            ;;
        esac
      done
      if [ $saw_graphql -eq 1 ]; then
        printf '%s\t\t%s\n' "unsafe_complex" "gh_api_graphql"
        return 0
      fi
      # Normalize method
      method="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
      case "$method" in
        POST|PUT|PATCH|DELETE)
          printf '%s\t\t%s\n' "push_or_pr_create" "gh_api_${method}"
          return 0
          ;;
        GET|HEAD|"")
          printf '%s\t\t%s\n' "read_only" "gh_api_${method}"
          return 0
          ;;
        *)
          printf '%s\t\t%s\n' "shared_write" "gh_api_${method}"
          return 0
          ;;
      esac
      ;;
    auth|status|alias|completion|config|extension|browse|search)
      printf '%s\t\t%s\n' "read_only" "gh_${cmd}"
      return 0
      ;;
    *)
      printf '%s\t\t%s\n' "shared_write" "gh_unknown_command"
      return 0
      ;;
  esac
}

# Resolve a marker path to absolute form under target_root.
# Strips relative components but does NOT resolve symlinks (we want to
# detect symlink shenanigans by basename mismatch — caller checks).
_resolve_marker_path() {
  local p="$1"
  local root="$2"
  case "$p" in
    /*) printf '%s' "$p" ;;
    *)  printf '%s/%s' "$root" "$p" ;;
  esac
}

# ---------------------------------------------------------------------------
# classify_command — public entry point
# ---------------------------------------------------------------------------
# Args:
#   $1  command string
#   $2  repo root (for marker resolution); optional, defaults to cwd
#
# Output: LABEL\tTARGET\tREASON
classify_command() {
  local cmd="$1"
  local repo_root="${2:-$(pwd)}"

  # Run tokenizer
  local stream
  stream="$(_tokenize "$cmd")"

  # Check for E records (unsafe)
  if printf '%s\n' "$stream" | grep -q '^E '; then
    local reason
    reason="$(printf '%s\n' "$stream" | grep '^E ' | head -1 | cut -c3-)"
    printf '%s\t\t%s\n' "unsafe_complex" "$reason"
    return 0
  fi

  # Split into segments by control operator
  # Each segment classified, final label = MOST RESTRICTIVE.
  # Restrictiveness order (most → least):
  #   unsafe_complex > push_or_pr_create > shared_write > marker_write > read_only > unknown
  # marker_write is intentionally NOT most-restrictive: a segment chained
  # AFTER a marker write doesn't downgrade the marker write, but a marker
  # write chained AFTER a push_or_pr_create still upgrades to push.

  local seg_buf=""
  local final_label=""
  local final_target=""
  local final_reason=""

  _consider() {
    local lbl="$1" tgt="$2" rsn="$3"
    local lp=$(_priority "$lbl")
    local fp=$(_priority "$final_label")
    if [ -z "$final_label" ] || [ "$lp" -gt "$fp" ]; then
      final_label="$lbl"
      final_target="$tgt"
      final_reason="$rsn"
    fi
  }

  local line
  local seg_lines=""
  while IFS= read -r line; do
    case "$line" in
      "O &&"|"O ||"|"O ;"|"O ;;"|"O |"|"O &"|"O NL")
        # End segment, classify
        if [ -n "$seg_lines" ]; then
          local result
          result="$(printf '%s\n' "$seg_lines" | _classify_segment "$repo_root")"
          local lbl="${result%%	*}"
          local rest="${result#*	}"
          local tgt="${rest%%	*}"
          local rsn="${rest#*	}"
          _consider "$lbl" "$tgt" "$rsn"
          seg_lines=""
        fi
        ;;
      *)
        if [ -n "$seg_lines" ]; then
          seg_lines="$seg_lines"$'\n'"$line"
        else
          seg_lines="$line"
        fi
        ;;
    esac
  done <<< "$stream"

  # Final segment
  if [ -n "$seg_lines" ]; then
    local result
    result="$(printf '%s\n' "$seg_lines" | _classify_segment "$repo_root")"
    local lbl="${result%%	*}"
    local rest="${result#*	}"
    local tgt="${rest%%	*}"
    local rsn="${rest#*	}"
    _consider "$lbl" "$tgt" "$rsn"
  fi

  if [ -z "$final_label" ]; then
    final_label="read_only"
    final_reason="empty_command"
  fi

  printf '%s\t%s\t%s\n' "$final_label" "$final_target" "$final_reason"
}

# Priority for "most restrictive wins" reduction.
_priority() {
  case "$1" in
    unsafe_complex)     printf '6' ;;
    push_or_pr_create)  printf '5' ;;
    shared_write)       printf '4' ;;
    marker_write)       printf '3' ;;
    unknown)            printf '2' ;;
    read_only)          printf '1' ;;
    *)                  printf '0' ;;
  esac
}

# ---------------------------------------------------------------------------
# classify_path — for Write/Edit/MultiEdit/NotebookEdit tool_input.file_path
# ---------------------------------------------------------------------------
# Args:
#   $1  file path
#   $2  repo root
classify_path() {
  local p="$1"
  local repo_root="${2:-$(pwd)}"
  local base
  base="$(basename "$p")"
  case "$base" in
    .plan-approval-pending|.pre-checkpoint-done|.post-checkpoint-done)
      local abs
      abs="$(_resolve_marker_path "$p" "$repo_root")"
      printf '%s\t%s\t%s\n' "marker_write" "$abs" "path_marker"
      return 0
      ;;
    # #268 fix E5: per-session plan-marker via classify_path (Write/Edit).
    .plan-approval-pending.*)
      local abs
      abs="$(_resolve_marker_path "$p" "$repo_root")"
      printf '%s\t%s\t%s\n' "marker_write" "$abs" "path_marker"
      return 0
      ;;
  esac
  printf '%s\t\t%s\n' "shared_write" "path_default"
  return 0
}

# ---------------------------------------------------------------------------
# Layer D pre-flight classifier siblings (PR1 enforces codex-review-handoff
# only; other claim classes registered for shape but not enforced).
#
# Output format: claim-class<TAB>trigger<TAB>match-detail
#   claim-class:   codex-review-handoff | rule-bearing-file-edit |
#                  adversarial-code-review | plan-time-matrix |
#                  scratch-files | wrap-up-discipline | none
#   trigger:       tool_target | prompt_phrase | (empty for none)
#   match-detail:  short identifier of the rule that fired
#
# Sibling to classify_command / classify_path; reuses _tokenize internally.
#
# Codex consensus chain: r1 ACCEPT-with-FU `...ed24` → r5 ACCEPT `...dbf6`.
# ---------------------------------------------------------------------------

# Wrapper-utility prefixes that may precede the real command verb. Same set
# the existing classifier handles for bash -c / env / sudo / nohup / timeout.
_PREFLIGHT_WRAPPERS_RE='^(env|command|sudo|doas|nohup|timeout|stdbuf|nice|chrt|ionice|setsid|exec|systemd-run|flatpak-spawn)$'

# Two-word command runners: verb + fixed subcommand consume index; rest of
# loop unwraps wrapper flags. Codex r3 finding `...bd73`. Patterns:
#   uv run CMD | poetry run CMD | pixi run CMD | direnv exec DIR CMD
#   nix develop -c CMD | nix shell -c CMD
_PREFLIGHT_RUNNERS_RE='^(uv|poetry|pixi|direnv|nix)$'

# Tag-name fragments that, when found in --tag/--tags/--summary args, mark
# an em-* invocation as a codex-review handoff.
_PREFLIGHT_REVIEW_TAG_RE='codex|review|second-opinion|plan-review|code-review|cross-tool-review|meta-review'

# em-* CLI verbs that route review traffic. Bare names AND `node */<name>.mjs`
# AND `npx <name>` AND plugin-script forms all classified.
_PREFLIGHT_EM_VERBS_RE='^(em-store|em-revise|em-violation)(\.mjs)?$'

# _preflight_unwrap_index — emit (to stdout) the index past wrapper-utility
# prefix tokens. Args: $1 = start_index; $2..$N = all tokens.
# Bash 3.2-compatible (no namerefs); same calling convention as existing
# _classify_git in this file.
_preflight_unwrap_index() {
  local i=$1
  shift
  local -a T=("$@")
  local n=${#T[@]}
  while [ $i -lt $n ]; do
    local t="${T[$i]}"
    local wrapper=""

    # Two-word runner detection (uv run, poetry run, pixi run, direnv exec,
    # nix develop -c, nix shell -c). Codex r3 finding `...bd73`.
    if [[ "$t" =~ $_PREFLIGHT_RUNNERS_RE ]] && [ $((i+1)) -lt $n ]; then
      local sub="${T[$((i+1))]}"
      case "$t" in
        uv|poetry|pixi)
          if [ "$sub" = "run" ]; then
            wrapper="$t-run"
            i=$((i+2))
          fi
          ;;
        direnv)
          if [ "$sub" = "exec" ]; then
            wrapper="direnv-exec"
            i=$((i+2))
            # direnv exec DIR CMD — consume DIR positional.
            if [ $i -lt $n ]; then i=$((i+1)); fi
          fi
          ;;
        nix)
          if [ "$sub" = "develop" ] || [ "$sub" = "shell" ]; then
            wrapper="nix-$sub"
            i=$((i+2))
            # nix develop|shell -c CMD — find -c, then advance past it
            # so CMD becomes the verb. If no -c found, this isn't the
            # bypass shape; let the outer loop break naturally.
            while [ $i -lt $n ]; do
              local nt="${T[$i]}"
              if [ "$nt" = "-c" ]; then
                i=$((i+1))
                break
              fi
              case "$nt" in
                -*) i=$((i+1)) ;;
                *)  break ;;
              esac
            done
          fi
          ;;
      esac
      if [ -n "$wrapper" ]; then
        # Skip remaining wrapper flags (rare but possible after the
        # subcommand).
        while [ $i -lt $n ]; do
          local w="${T[$i]}"
          case "$w" in
            *=*) i=$((i+1)) ;;
            -*)  i=$((i+1)) ;;
            *)   break ;;
          esac
        done
        continue
      fi
    fi

    if [[ "$t" =~ $_PREFLIGHT_WRAPPERS_RE ]]; then
      wrapper="$t"
      i=$((i+1))
      # Per-wrapper short-opt set that takes an ARGUMENT in the next token.
      # P1 fix from codex PR-level review round 2 (`...cbc2`).
      local arg_re=''
      # Per-wrapper LONG-opt set that takes an ARGUMENT in the next token
      # (when in `--key value` form, not `--key=value`). Codex r3 finding
      # `...bd73` rejected the deferral.
      local long_arg_re=''
      case "$wrapper" in
        sudo|doas)
          arg_re='^-[ugCDHRTpAB]$'
          long_arg_re='^--(user|group|close-from|host|prompt|runas-uid|runas-gid|chdir|chroot)$'
          ;;
        timeout)
          arg_re='^-[ks]$'
          long_arg_re='^--(kill-after|signal)$'
          ;;
        nice)
          arg_re='^-n$'
          long_arg_re='^--adjustment$'
          ;;
        ionice)
          arg_re='^-[cnpt]$'
          long_arg_re='^--(class|classdata|pid|pgrp|uid)$'
          ;;
        env)
          arg_re='^-[uS]$'
          long_arg_re='^--(unset|split-string|chdir)$'
          ;;
        stdbuf)
          arg_re='^-[ioe]$'
          long_arg_re='^--(input|output|error)$'
          ;;
        exec)
          arg_re='^-a$'
          long_arg_re='^--argv0$'
          ;;
        chrt)
          arg_re='^-[pP]$'
          long_arg_re='^--(pid|sched-runtime|sched-deadline|sched-period)$'
          ;;
        systemd-run)
          # Only short opts that ACTUALLY take an argument:
          #   -u (--unit), -M (--machine), -p (--property), -E (--setenv).
          # NOT: -G (--collect, boolean), -t (--pty, boolean), -S (--shell, boolean).
          arg_re='^-[uMpE]$'
          # Long opts that take an argument. Booleans intentionally excluded:
          # --user, --system, --scope, --pty, --tty, --quiet, --no-block,
          # --no-ask-password, --collect, --remain-after-exit, --send-sighup,
          # --pipe, --shell, --wait. Codex r4 finding `...fa74`.
          long_arg_re='^--(unit|machine|property|setenv|description|slice|on-active|on-boot|on-startup|on-unit-active|on-unit-inactive|on-calendar|service-type|exec-directory|state-directory|cache-directory|logs-directory|configuration-directory|working-directory|gid|uid|nice)$'
          ;;
        flatpak-spawn)
          arg_re=''
          long_arg_re='^--(env|directory|forward-fd)$'
          ;;
      esac
      while [ $i -lt $n ]; do
        local w="${T[$i]}"
        case "$w" in
          *=*) i=$((i+1)) ;;
          --*)
            if [ -n "$long_arg_re" ] && [[ "$w" =~ $long_arg_re ]]; then
              i=$((i+2))
            else
              i=$((i+1))
            fi
            ;;
          -*)
            if [ -n "$arg_re" ] && [[ "$w" =~ $arg_re ]]; then
              i=$((i+2))
            else
              i=$((i+1))
            fi
            ;;
          *)   break ;;
        esac
      done
      # Wrappers with a positional BEFORE the command to wrap.
      case "$wrapper" in
        timeout)
          # `timeout DURATION CMD` — DURATION is positional, distinct from
          # `-k DURATION` and `-s SIGNAL` (consumed via arg_re/long_arg_re).
          if [ $i -lt $n ]; then i=$((i+1)); fi
          ;;
      esac
    else
      break
    fi
  done
  printf '%d' "$i"
}

# _preflight_scan_em_args — return 0 if em-* invocation has review-handoff
# signals in --tag/--tags/--summary args; 1 otherwise.
# Args: $1 = start_index; $2..$N = tokens.
_preflight_scan_em_args() {
  local i=$1
  shift
  local -a T=("$@")
  local n=${#T[@]}
  while [ $i -lt $n ]; do
    local t="${T[$i]}"
    case "$t" in
      --tag|--tags|--summary)
        local v="${T[$((i+1))]:-}"
        if [[ "$v" =~ $_PREFLIGHT_REVIEW_TAG_RE ]]; then
          return 0
        fi
        i=$((i+2))
        ;;
      --tag=*|--tags=*|--summary=*)
        local v="${t#*=}"
        if [[ "$v" =~ $_PREFLIGHT_REVIEW_TAG_RE ]]; then
          return 0
        fi
        i=$((i+1))
        ;;
      *) i=$((i+1)) ;;
    esac
  done
  return 1
}

# classify_preflight_command "$cmd" "$repo_root"
classify_preflight_command() {
  local cmd="$1"
  # repo_root currently unused but kept for API parity + future trigger expansion.
  local _repo_root="${2:-$(pwd)}"
  local stream
  stream="$(_tokenize "$cmd")"

  # Unsafe (command substitution / unbalanced quotes) → conservatively
  # treat as codex-review-handoff if literal `codex exec` or em-store appears
  # anywhere in the raw command, otherwise none. The gate's policy is
  # "fail closed on ambiguity."
  if printf '%s\n' "$stream" | grep -q '^E '; then
    if printf '%s\n' "$cmd" | grep -qE '\b(codex[[:space:]]+(exec|review)|em-(store|revise|violation))\b'; then
      printf '%s\t%s\t%s\n' "codex-review-handoff" "tool_target" "unsafe_complex_with_review_literal"
      return 0
    fi
    printf '%s\t%s\t%s\n' "none" "" "unsafe_complex_no_review_literal"
    return 0
  fi

  # Walk segments separated by control operators (; && || | & NL). Per
  # segment, run the classifier inner; if ANY segment matches a preflight
  # claim class, the whole command does. P1 fix for bash-chain bypass
  # (`echo ok; codex exec foo`, `true && codex exec`, etc.) caught by codex
  # PR-level review 2026-05-12.
  local -a SEG=()
  local line
  local matched_class="" matched_trigger="" matched_detail=""
  _classify_seg_and_check() {
    if [ ${#SEG[@]} -eq 0 ]; then return 0; fi
    local seg_result
    seg_result="$(_classify_preflight_segment "$_repo_root" "${SEG[@]}")"
    local seg_class="${seg_result%%	*}"
    if [ "$seg_class" != "none" ] && [ -z "$matched_class" ]; then
      matched_class="$seg_class"
      local rest="${seg_result#*	}"
      matched_trigger="${rest%%	*}"
      matched_detail="${rest#*	}"
    fi
  }
  while IFS= read -r line; do
    case "$line" in
      "T "*) SEG+=("${line:2}") ;;
      "O &&"|"O ||"|"O ;"|"O ;;"|"O |"|"O |&"|"O &"|"O NL")
        _classify_seg_and_check
        SEG=()
        ;;
    esac
  done <<< "$stream"
  _classify_seg_and_check

  if [ -n "$matched_class" ]; then
    printf '%s\t%s\t%s\n' "$matched_class" "$matched_trigger" "$matched_detail"
    return 0
  fi
  printf '%s\t%s\t%s\n' "none" "" "no_match"
  return 0
}

# _classify_preflight_segment <repo-root> <token1> <token2> ...
# Per-segment classifier. Returns claim-class<TAB>trigger<TAB>detail.
# Extracted from classify_preflight_command's body so segments separated by
# control operators each get classified.
_classify_preflight_segment() {
  local _repo_root="$1"
  shift
  local -a T=("$@")
  local n=${#T[@]}
  if [ $n -eq 0 ]; then
    printf '%s\t%s\t%s\n' "none" "" "empty_segment"
    return 0
  fi

  # Special-case: env -S "<command-string>" or env --split-string "<cmd>"
  # treats the argument as a command vector to execute (GNU coreutils env
  # `-S/--split-string` semantics). Codex r5 finding `...729a`. Detect
  # before generic unwrap consumes -S as a regular arg-taking flag.
  if [ $n -ge 3 ] && [ "${T[0]}" = "env" ]; then
    local _envk=1
    while [ $_envk -lt $n ]; do
      local _envt="${T[$_envk]}"
      case "$_envt" in
        -S|--split-string)
          local _envinner="${T[$((_envk+1))]:-}"
          if [ -n "$_envinner" ]; then
            classify_preflight_command "$_envinner" "$_repo_root"
            return 0
          fi
          break
          ;;
        --split-string=*)
          local _envinner="${_envt#*=}"
          if [ -n "$_envinner" ]; then
            classify_preflight_command "$_envinner" "$_repo_root"
            return 0
          fi
          break
          ;;
        # `-S` may appear inside a short-opt cluster: -vS, -iS, etc.
        -*S*)
          case "$_envt" in
            --*) _envk=$((_envk+1)); continue ;;
          esac
          local _envinner="${T[$((_envk+1))]:-}"
          if [ -n "$_envinner" ]; then
            classify_preflight_command "$_envinner" "$_repo_root"
            return 0
          fi
          break
          ;;
        -*) _envk=$((_envk+1)) ;;
        *=*) _envk=$((_envk+1)) ;;
        *) break ;;
      esac
    done
  fi

  local i
  i="$(_preflight_unwrap_index 0 "${T[@]}")"
  if [ $i -ge $n ]; then
    printf '%s\t%s\t%s\n' "none" "" "empty_after_unwrap"
    return 0
  fi

  local verb="${T[$i]}"

  # Strip leading subshell-open / brace-group / parenthesis tokens. The
  # tokenizer emits `(` / `{` as standalone T tokens; we treat them as
  # transparent for verb detection. P1 fix for `( codex exec foo )` bypass.
  while [ $i -lt $n ]; do
    case "${T[$i]}" in
      '('|'{')
        i=$((i+1))
        # Re-run unwrap after stripping the open paren/brace.
        i="$(_preflight_unwrap_index $i "${T[@]}")"
        verb="${T[$i]:-}"
        ;;
      *) break ;;
    esac
  done
  if [ -z "$verb" ]; then
    printf '%s\t%s\t%s\n' "none" "" "empty_after_subshell_strip"
    return 0
  fi

  # Direct codex CLI
  if [ "$verb" = "codex" ]; then
    local sub="${T[$((i+1))]:-}"
    case "$sub" in
      exec|review)
        printf '%s\t%s\t%s\n' "codex-review-handoff" "tool_target" "codex_${sub}"
        return 0
        ;;
    esac
  fi

  # Shell wrapper with -c <cmd>: recurse into the inner command string.
  case "$verb" in
    bash|sh|zsh|dash|ash|ksh)
      local k=$((i+1))
      while [ $k -lt $n ]; do
        local kt="${T[$k]}"
        case "$kt" in
          -c|-*c*)
            case "$kt" in
              --*) k=$((k+1)); continue ;;
            esac
            local inner="${T[$((k+1))]:-}"
            if [ -n "$inner" ]; then
              classify_preflight_command "$inner" "$_repo_root"
              return 0
            fi
            break
            ;;
          -*) k=$((k+1)) ;;
          *)  break ;;
        esac
      done
      ;;
  esac

  # node|npx invocation of em-* or second-opinion script
  case "$verb" in
    node|npx)
      local j=$((i+1))
      while [ $j -lt $n ]; do
        local t="${T[$j]}"
        case "$t" in
          -*) j=$((j+1)) ;;
          *)  break ;;
        esac
      done
      if [ $j -lt $n ]; then
        local script_basename
        script_basename="$(basename "${T[$j]}")"
        if [[ "$script_basename" =~ $_PREFLIGHT_EM_VERBS_RE ]]; then
          if _preflight_scan_em_args $((j+1)) "${T[@]}"; then
            printf '%s\t%s\t%s\n' "codex-review-handoff" "tool_target" "em_via_node_${script_basename%.mjs}"
            return 0
          fi
        fi
        if [[ "$script_basename" == "second-opinion.mjs" ]]; then
          printf '%s\t%s\t%s\n' "codex-review-handoff" "tool_target" "second_opinion_harness"
          return 0
        fi
      fi
      ;;
  esac

  # Bare em-* verb (PATH-resolved)
  local verb_basename
  verb_basename="$(basename "$verb")"
  if [[ "$verb_basename" =~ $_PREFLIGHT_EM_VERBS_RE ]]; then
    if _preflight_scan_em_args $((i+1)) "${T[@]}"; then
      printf '%s\t%s\t%s\n' "codex-review-handoff" "tool_target" "em_bare_${verb_basename%.mjs}"
      return 0
    fi
  fi

  printf '%s\t%s\t%s\n' "none" "" "no_match"
  return 0
}

# Rule-bearing path patterns. Edits to these files trigger
# rule-bearing-file-edit claim class. PR1 registers shape only; enforcement
# requires pairing with codex-review-handoff (see plan §"Three material
# revisions"). Patterns are basename or path-suffix matches against the
# realpath of the target file.
_PREFLIGHT_RULE_BEARING_PATTERNS=(
  '/MEMORY.md$'
  '/feedback_[^/]*\.md$'
  '/reference_[^/]*\.md$'
  '/bundles/[^/]*\.md$'
  '/.claude/hooks/'
  '/.claude/settings(\.local)?\.json$'
  '/docs/rfcs/'
  '/.episodic-memory/episodes/'
)

# classify_preflight_path "$path" "$repo_root"
classify_preflight_path() {
  local p="$1"
  local _repo_root="${2:-$(pwd)}"
  local pat
  for pat in "${_PREFLIGHT_RULE_BEARING_PATTERNS[@]}"; do
    if [[ "$p" =~ $pat ]]; then
      printf '%s\t%s\t%s\n' "rule-bearing-file-edit" "tool_target" "path_${pat//[^a-zA-Z0-9]/_}"
      return 0
    fi
  done
  printf '%s\t%s\t%s\n' "none" "" "path_no_match"
  return 0
}

# classify_preflight_tool "$tool_name" "$tool_input_json" "$repo_root"
# Top-level dispatch. tool_input_json passed as a single JSON string.
classify_preflight_tool() {
  local tool_name="$1"
  local tool_input_json="$2"
  local repo_root="${3:-$(pwd)}"

  case "$tool_name" in
    Bash)
      local cmd
      cmd="$(printf '%s' "$tool_input_json" | jq -r '.command // ""' 2>/dev/null)"
      if [ -z "$cmd" ]; then
        printf '%s\t%s\t%s\n' "none" "" "bash_empty_command"
        return 0
      fi
      classify_preflight_command "$cmd" "$repo_root"
      ;;
    Agent|Task)
      local subagent
      subagent="$(printf '%s' "$tool_input_json" | jq -r '.subagent_type // ""' 2>/dev/null)"
      # Plan-v2 I11 (audit F7): `negative-scenario-planner` is the documented
      # bootstrap workaround for plan-time review when the harness channel is
      # blocked (workplan v49 §workaround). It runs BEFORE plans exist, so it
      # cannot itself be gated by a post-plan marker. Reviewer-class subagents
      # (`negative-scenario-reviewer`, future `negative-scenario-coder`, etc.)
      # remain gated — those run AFTER a plan exists and a marker is feasible.
      case "$subagent" in
        negative-scenario-planner)
          printf '%s\t%s\t%s\n' "none" "" "agent_planner_bootstrap_exempt"
          return 0
          ;;
        codex:*|codex-*|negative-scenario-*)
          printf '%s\t%s\t%s\n' "codex-review-handoff" "tool_target" "agent_${subagent//[^a-zA-Z0-9]/_}"
          return 0
          ;;
      esac
      printf '%s\t%s\t%s\n' "none" "" "agent_no_match"
      ;;
    Write|Edit|MultiEdit|NotebookEdit)
      local p
      p="$(printf '%s' "$tool_input_json" | jq -r '.file_path // .path // .notebook_path // ""' 2>/dev/null)"
      if [ -z "$p" ]; then
        printf '%s\t%s\t%s\n' "none" "" "write_empty_path"
        return 0
      fi
      classify_preflight_path "$p" "$repo_root"
      ;;
    *)
      printf '%s\t%s\t%s\n' "none" "" "tool_not_gated"
      ;;
  esac
}
