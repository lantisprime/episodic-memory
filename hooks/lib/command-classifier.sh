#!/usr/bin/env bash
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
  local r
  local has_nonmarker_redirect=0
  for r in ${REDIRS[@]+"${REDIRS[@]}"}; do
    local rop="${r%%	*}"
    local rtarget="${r#*	}"
    local rbase="$(basename "$rtarget")"
    case "$rbase" in
      .pre-checkpoint-done|.post-checkpoint-done|.plan-approval-pending)
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
  local idx=0
  while [ $idx -lt ${#TOKS[@]} ]; do
    case "${TOKS[$idx]}" in
      [A-Za-z_]*=*)
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
      case "$tbase" in
        .plan-approval-pending|.pre-checkpoint-done|.post-checkpoint-done|.checkpoint-required|.post-checkpoint-required)
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
      case "$tbase" in
        .pre-checkpoint-done|.post-checkpoint-done|.plan-approval-pending)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "tee_marker"
          return 0
          ;;
      esac
      break
    done
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
    status|log|diff|show|rev-parse|rev-list|reflog|blame|grep|describe|ls-files|ls-tree|ls-remote|fetch|cat-file|config|remote|branch|tag|worktree|var|help|version|shortlog|whatchanged|name-rev|check-ignore|check-mailmap|check-attr|annotate|count-objects)
      # These are mostly read-only when used without write subcommands.
      # branch/tag/remote/worktree/config CAN write — but by default invocation
      # they list. We err on the side of read_only for these and let the
      # specific write forms (push, commit, etc) catch the actual writes.
      # Note: `git fetch` is technically a network op but produces no remote
      # mutation; classify as read_only for our purposes.
      printf '%s\t\t%s\n' "read_only" "git_read_subcommand"
      return 0
      ;;
    commit|add|rm|mv|reset|restore|checkout|switch|merge|rebase|cherry-pick|revert|stash|clean|pull|fetch|clone|init|gc|prune|notes|submodule|apply|am|format-patch|bisect|update-index|update-ref|symbolic-ref|hash-object|mktree|read-tree|write-tree|commit-tree|fsck|repack|pack-refs|pack-objects|unpack-objects|prune-packed|rerere|filter-branch|replay|sparse-checkout|maintenance)
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
        create|merge|close|reopen|edit|comment|ready)
          printf '%s\t\t%s\n' "push_or_pr_create" "gh_pr_${sub}"
          return 0
          ;;
        review)
          # gh pr review --approve mutates; --comment is informational.
          local j=$((i+2))
          while [ $j -lt $n ]; do
            case "${T[$j]}" in
              --approve|--request-changes)
                printf '%s\t\t%s\n' "push_or_pr_create" "gh_pr_review_approve"
                return 0
                ;;
            esac
            j=$((j+1))
          done
          printf '%s\t\t%s\n' "shared_write" "gh_pr_review_comment"
          return 0
          ;;
        list|view|status|diff|checks|checkout|lock|unlock)
          printf '%s\t\t%s\n' "read_only" "gh_pr_${sub}"
          return 0
          ;;
        *)
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
  esac
  printf '%s\t\t%s\n' "shared_write" "path_default"
  return 0
}
