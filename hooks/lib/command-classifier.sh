#!/usr/bin/env bash
# episodic-memory-hook-version: 2026-05-16.1
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

  # Read one shell token starting at position $i in $cmd. Skips leading
  # horizontal whitespace (spaces/tabs only — newline terminates the
  # redirect operand). Honors single quotes, double quotes (same rules as
  # main loop), and backslash escapes. Stops at unquoted whitespace,
  # control operator, redirect operator, or EOF.
  #
  # Outputs (globals): OPERAND_TEXT, OPERAND_PRESENT (1 if a token was
  # read, 0 if EOF/control-op was hit first), OPERAND_ERROR (non-empty
  # on tokenizer-level error). Advances $i past the token.
  _read_one_token() {
    OPERAND_TEXT=""
    OPERAND_PRESENT=0
    OPERAND_ERROR=""

    # Skip leading spaces/tabs (but not newline — newline terminates the
    # redirect-spec without an operand)
    while [ $i -lt $n ]; do
      local rc="${cmd:$i:1}"
      case "$rc" in
        ' '|$'\t') i=$((i+1)) ;;
        *) break ;;
      esac
    done

    [ $i -ge $n ] && return 0

    local rc="${cmd:$i:1}"
    case "$rc" in
      $'\n'|';'|'&'|'|'|'<'|'>') return 0 ;;
    esac

    local tok=""
    while [ $i -lt $n ]; do
      rc="${cmd:$i:1}"
      case "$rc" in
        ' '|$'\t'|$'\n'|';'|'&'|'|'|'<'|'>')
          break
          ;;
        "'")
          i=$((i+1))
          local sq=""
          local sclosed=0
          while [ $i -lt $n ]; do
            local sc="${cmd:$i:1}"
            if [ "$sc" = "'" ]; then
              i=$((i+1))
              sclosed=1
              break
            fi
            sq="$sq$sc"
            i=$((i+1))
          done
          if [ $sclosed -eq 0 ]; then
            OPERAND_ERROR="unbalanced_single_quote"
            return 0
          fi
          tok="$tok$sq"
          ;;
        '"')
          i=$((i+1))
          local dq=""
          local dclosed=0
          while [ $i -lt $n ]; do
            local dc="${cmd:$i:1}"
            if [ "$dc" = '"' ]; then
              i=$((i+1))
              dclosed=1
              break
            fi
            if [ "$dc" = '\' ] && [ $((i+1)) -lt $n ]; then
              local nx="${cmd:$((i+1)):1}"
              case "$nx" in
                '"'|'\'|'$'|'`')
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
              OPERAND_ERROR="command_substitution_in_double_quote"
              return 0
            fi
            if [ "$dc" = '`' ]; then
              OPERAND_ERROR="backtick_in_double_quote"
              return 0
            fi
            dq="$dq$dc"
            i=$((i+1))
          done
          if [ $dclosed -eq 0 ]; then
            OPERAND_ERROR="unbalanced_double_quote"
            return 0
          fi
          tok="$tok$dq"
          ;;
        '\')
          if [ $((i+1)) -lt $n ]; then
            tok="$tok${cmd:$((i+1)):1}"
            i=$((i+2))
          else
            i=$((i+1))
          fi
          ;;
        *)
          tok="$tok$rc"
          i=$((i+1))
          ;;
      esac
    done

    OPERAND_TEXT="$tok"
    OPERAND_PRESENT=1
    return 0
  }

  # Emit a redirect record for `>&` / `<&` based on operand-completeness:
  #   fd-dup if operand is exactly `-` OR exactly `[0-9]+`
  #   file redirect otherwise (operand is a path token)
  # Per Bash grammar (Codex R4 finding): `>&2foo` is a file redirect to
  # `./2foo`, NOT fd-dup. Decision happens on the COMPLETE operand word.
  _emit_redir_or_fddup() {
    local op="$1"
    local has_operand="$2"
    local operand="$3"
    if [ "$has_operand" = "1" ]; then
      if [ "$operand" = "-" ]; then
        printf 'O FDDUP\n'
        return 0
      fi
      case "$operand" in
        *[!0-9]*|"")
          # Non-digit char present (or empty) — file redirect
          printf 'O %s\n' "$op"
          printf 'T %s\n' "$operand"
          return 0
          ;;
        *)
          # All digits → fd-dup
          printf 'O FDDUP\n'
          return 0
          ;;
      esac
    fi
    # No operand at all (EOF/control-op immediately after `>&`) — emit op
    # as bare redirect; downstream classifier will see no target and
    # leave it as no-op (defensive fallback for malformed input).
    printf 'O %s\n' "$op"
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
          # &> or &>> redirect — both fds to file (truncate vs append).
          if [ "${cmd:$((i+2)):1}" = ">" ]; then
            printf 'O &>>\n'
            i=$((i+3))
          else
            printf 'O &>\n'
            i=$((i+2))
          fi
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
        # fd-prefix detection: if cur is exactly [0-9]+ (collected with no
        # whitespace before this `>`), it's a numeric fd prefix — suppress
        # its flush as a token. Otherwise flush as normal.
        if [ "$has_token" = "1" ]; then
          case "$cur" in
            *[!0-9]*|"") ;;  # has non-digit (or empty) → normal token
            *) cur=""; has_token=0 ;;  # all digits → fd prefix, drop
          esac
        fi
        _flush
        if [ "${cmd:$((i+1)):1}" = ">" ]; then
          printf 'O >>\n'
          i=$((i+2))
        elif [ "${cmd:$((i+1)):1}" = "(" ]; then
          printf 'E process_substitution\n'
          return 0
        elif [ "${cmd:$((i+1)):1}" = "&" ]; then
          # `>&` — fd-dup (`>&2`, `>&-`) OR file redirect (`>&foo`,
          # `>&2foo`, `>& "out.txt"`). Decided on the COMPLETE operand.
          i=$((i+2))
          _read_one_token
          if [ -n "$OPERAND_ERROR" ]; then
            printf 'E %s\n' "$OPERAND_ERROR"
            return 0
          fi
          _emit_redir_or_fddup ">&" "$OPERAND_PRESENT" "$OPERAND_TEXT"
        else
          printf 'O >\n'
          i=$((i+1))
        fi
        ;;
      '<')
        # fd-prefix detection (mirror of '>'): if cur is exactly [0-9]+,
        # treat as numeric fd prefix and drop.
        if [ "$has_token" = "1" ]; then
          case "$cur" in
            *[!0-9]*|"") ;;
            *) cur=""; has_token=0 ;;
          esac
        fi
        # Heredoc / here-string / redirect / process-sub / fd-dup
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
        elif [ "${cmd:$((i+1)):1}" = "&" ]; then
          # `<&` — fd-dup input (`<&5`, `<&-`) OR input from file
          # (`<&foo`). Symmetric with `>&`. Operand-completeness rule.
          _flush
          i=$((i+2))
          _read_one_token
          if [ -n "$OPERAND_ERROR" ]; then
            printf 'E %s\n' "$OPERAND_ERROR"
            return 0
          fi
          _emit_redir_or_fddup "<&" "$OPERAND_PRESENT" "$OPERAND_TEXT"
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
# #279 Stream 2: env-prefix wrapper defense — structural grammar for
# preflight-marker-write.mjs helper invocations.
#
# Replaces regex-based helper-invocation detection (preflight-gate.sh) with
# two whitelists that collectively eliminate the entire env-wrapper,
# sudo-wrapper, npx-wrapper, path-spelled-anything class.
#
# _ROUTINE_ENV_ALLOWLIST — env-prefix names permitted before the helper.
#   Sourced from env-prefix-discipline-v1.md "What's NOT this rule" section
#   (routine framework / runtime env vars on their normal commands).
#   Drift-validated by validate-plan-marker-sites.mjs.
#
# _NODE_BINARY_BASENAME_ALLOWLIST — token basenames permitted at the
#   executable position. The gate enforces TOKEN-FORM identity (basename
#   match), not RUNTIME identity. A binary literally named `node` that is
#   actually a shell wrapper WILL pass this check — that class is out of
#   scope for this gate (mitigated by file-system permissions + the Bash
#   allowlist, not by this hook). Same-command shell shadowing (function
#   defs, aliases, source, eval) is also out of scope (deep shell-injection;
#   honest-agent threat model PR #271).
# ---------------------------------------------------------------------------

readonly _ROUTINE_ENV_ALLOWLIST="NODE_ENV DEBUG CI PYTHONPATH LOG_LEVEL"
readonly _NODE_BINARY_BASENAME_ALLOWLIST="node"

# Helper basename for tokenized invocation detection (codex PR #291 r4).
readonly _HELPER_BASENAME="preflight-marker-write.mjs"

# Real wrappers: target executable is the first non-flag positional arg.
# Distinct from data-taking commands (printf/echo/grep/cat) where a
# token like the helper basename is data, not exec position.
_HELPER_REAL_WRAPPER_RE='^(env|command|sudo|doas|nohup|timeout|stdbuf|nice|chrt|ionice|setsid|exec|systemd-run|flatpak-spawn|uv|poetry|pixi|direnv|nix|npx|bash|sh|zsh|dash|ksh|fish|python|python3|ruby|perl|time|xargs)$'

# _is_in_space_list <needle> <space-separated-list>
# True iff <needle> appears as a whole token in <space-separated-list>.
_is_in_space_list() {
  local needle="$1" list="$2" t
  for t in $list; do
    [ "$t" = "$needle" ] && return 0
  done
  return 1
}

# _check_helper_invocation_grammar <cmd>
#
# Walks the tokenized command checking the v7 plan command-form grammar:
#   <command> := <env-prefix>* <executable> <helper-script-path> <helper-flags>*
#
# Echoes one of:
#   OK\t<idx>\t<basename>             — grammar satisfied (env-prefix walk +
#                                       executable + helper-script-path
#                                       basename all verified); idx is the
#                                       index of the executable token in TOKS
#   DENY\tenv-prefix\t<name>          — non-allowlist env-prefix at position
#   DENY\twrapper\t<basename>         — non-node basename at exec position
#   DENY\tenv-prefix-invalid\t<tok>   — token shape rejected (POSIX-name re)
#   DENY\ttokenize\t<reason>          — tokenizer emitted E or O (control op)
#   DENY\tno-exec\t                   — no executable token after env-prefix
#                                       walk (env-only command)
#   DENY\tno-helper\t                 — executable present but no helper-script
#                                       token follows
#   DENY\twrong-helper\t<basename>    — T[idx+1] basename is not
#                                       preflight-marker-write.mjs (codex PR-r1 P3)
#
# Caller (preflight-gate.sh) parses the result, formats user-facing reason.
# Returns 0 always; failure expressed in echoed verdict.
_check_helper_invocation_grammar() {
  local cmd="$1"
  local -a TOKS=()
  local line tok_text stream
  # Capture _tokenize output BEFORE iterating, so an early `return` inside
  # the loop does not close the pipe while _tokenize is still writing — on
  # Linux that triggers SIGPIPE and emits `printf: write error: Broken
  # pipe` to stderr, which pollutes the gate's JSON output. macOS hides
  # SIGPIPE by default; CI Linux does not. (Same idiom used at lines ~1654
  # and ~2015.)
  stream="$(_tokenize "$cmd")"
  while IFS= read -r line; do
    case "$line" in
      "T "*)
        TOKS+=("${line:2}")
        ;;
      "E "*)
        printf 'DENY\ttokenize\t%s\n' "${line:2}"
        return 0
        ;;
      "O "*)
        # Control operator at top level — multi-command segment, not a
        # simple helper invocation. Fail-closed deny: structural rule
        # requires single-segment command.
        printf 'DENY\ttokenize\t%s\n' "control_operator_${line:2}"
        return 0
        ;;
      *) ;;
    esac
  done <<< "$stream"

  local idx=0
  # Step 2: walk env-prefix tokens
  while [ $idx -lt ${#TOKS[@]} ]; do
    local t="${TOKS[$idx]}"
    case "$t" in
      [A-Za-z_]*=*)
        # POSIX env-prefix shape. Extract name (before first =) and validate.
        local ename="${t%%=*}"
        case "$ename" in
          *[!A-Za-z0-9_]*)
            # Should not happen (case-glob requires [A-Za-z_] prefix),
            # but be defensive.
            printf 'DENY\tenv-prefix-invalid\t%s\n' "$t"
            return 0
            ;;
        esac
        if ! _is_in_space_list "$ename" "$_ROUTINE_ENV_ALLOWLIST"; then
          printf 'DENY\tenv-prefix\t%s\n' "$ename"
          return 0
        fi
        idx=$((idx+1))
        ;;
      *)
        break
        ;;
    esac
  done

  if [ $idx -ge ${#TOKS[@]} ]; then
    printf 'DENY\tno-exec\t\n'
    return 0
  fi

  # Step 3: executable token basename whitelist
  local exec_tok="${TOKS[$idx]}"
  local exec_base="${exec_tok##*/}"
  if ! _is_in_space_list "$exec_base" "$_NODE_BINARY_BASENAME_ALLOWLIST"; then
    printf 'DENY\twrapper\t%s\n' "$exec_base"
    return 0
  fi

  # Step 4 (codex PR-r1 P3): verify T[idx+1] is the preflight-marker-write
  # helper. The outer gate regex already matched the helper basename in the
  # command string; this is defense in depth that ALSO catches injected
  # alternate scripts like `node /tmp/other.mjs ; node helper.mjs ...` (the
  # tokenizer emits an O control operator for `;` and we deny earlier; but
  # for `node /tmp/other.mjs preflight-marker-write.mjs ...` no operator
  # fires and the outer regex still matches). Tightens grammar claim.
  local helper_idx=$((idx+1))
  if [ $helper_idx -ge ${#TOKS[@]} ]; then
    printf 'DENY\tno-helper\t\n'
    return 0
  fi
  local helper_tok="${TOKS[$helper_idx]}"
  local helper_base="${helper_tok##*/}"
  if [ "$helper_base" != "preflight-marker-write.mjs" ]; then
    printf 'DENY\twrong-helper\t%s\n' "$helper_base"
    return 0
  fi

  printf 'OK\t%d\t%s\n' "$idx" "$exec_base"
  return 0
}

# _detect_tokens_contain_helper <cmd>
# Returns 0 iff any tokenized T-record has basename == _HELPER_BASENAME.
# Used by _detect_helper_invocation to distinguish helper-invocation
# attempts (with disallowed shape) from false-positives where the
# basename appears only as a data argument.
_detect_tokens_contain_helper() {
  local cmd="$1"
  local line tok_text base stream
  # Same SIGPIPE-avoidance as _check_helper_invocation_grammar: capture
  # _tokenize output first, then iterate via here-string. The early
  # `return 0` below would otherwise close the pipe mid-write on Linux
  # CI, leaking `printf: write error: Broken pipe` to stderr and breaking
  # the gate's JSON output parse in tests A1b / R4-B5.
  stream="$(_tokenize "$cmd")"
  while IFS= read -r line; do
    case "$line" in
      "T "*)
        tok_text="${line:2}"
        base="${tok_text##*/}"
        if [ "$base" = "$_HELPER_BASENAME" ]; then
          return 0
        fi
        ;;
    esac
  done <<< "$stream"
  return 1
}

# _detect_helper_invocation <cmd>
#
# Tokenized helper-invocation detector (codex PR #291 r4 P1). Replaces
# the prior HELPER_BASENAME_RE/NORMALIZED_CMD raw-text prefilter in the
# gate, which was bypassed by quoted/escaped helper paths
# (`node "scripts/preflight-marker-write.mjs" ...`, `node
# scripts/preflight-marker-write\.mjs ...`) because _tokenize normalized
# both to `scripts/preflight-marker-write.mjs` at helper runtime while
# the regex saw raw shell text.
#
# Returns exactly one of (printed to stdout):
#   NO_MATCH
#       This command is not a helper invocation attempt. Allow to fall
#       through to the rest of the gate.
#   OK\t<idx>\t<exec_basename>
#       Clean agent-side `node <path>/preflight-marker-write.mjs`.
#       Caller (gate) should emit class-wide deny (with --root diagnostic
#       if missing).
#   DENY\t<kind>\t<detail>
#       Helper invocation attempt with disallowed shape. Kinds:
#         env-prefix         non-allowlist env-prefix wraps helper call
#         env-prefix-invalid env-prefix token has invalid POSIX shape
#         wrapper            non-node exec wrapper (npx/sudo/env/...)
#                            with helper basename in argv
#         bare-helper        ./preflight-marker-write.mjs (helper as exec)
#         tokenize           compound/unsafe command containing helper
#
# Always returns 0; verdict expressed in echoed string.
#
# Algorithm:
#   1. Run _check_helper_invocation_grammar (env-prefix walk + exec
#      basename check + T[idx+1] helper basename check).
#   2. Re-categorize the grammar verdict:
#      - OK preserved as-is.
#      - DENY wrong-helper/no-helper/no-exec → NO_MATCH (T[idx+1] isn't
#        the helper, or there's no exec — false-positive class includes
#        `node --test tests/test-preflight-marker-write.mjs` (different
#        basename) and `node some-other.mjs preflight-marker-write.mjs`
#        (basename as data arg to another script). Codex r4 handoff
#        flagged both as required false-positive controls.
#      - DENY tokenize → scan tokens; if helper basename present, DENY
#        (defense-in-depth against `... ; node helper ...` smuggling),
#        else NO_MATCH.
#      - DENY env-prefix / env-prefix-invalid → scan tokens; if helper
#        basename present, DENY env-prefix, else NO_MATCH (env-only
#        command on unrelated target).
#      - DENY wrapper <exec_base>:
#          * exec_base == helper basename → DENY bare-helper
#          * exec_base in real-wrapper list AND helper basename in tokens
#            → DENY wrapper
#          * otherwise → NO_MATCH (random data-cmd like printf/grep with
#            helper basename as a data argument — false-positive class).
_detect_helper_invocation() {
  local cmd="$1"
  local result
  result="$(_check_helper_invocation_grammar "$cmd")"
  local verdict="${result%%	*}"

  case "$verdict" in
    OK)
      printf '%s\n' "$result"
      return 0
      ;;
    DENY)
      local rest="${result#*	}"
      local kind="${rest%%	*}"
      local detail="${rest#*	}"

      case "$kind" in
        wrong-helper|no-helper|no-exec)
          # Grammar: exec=node but next token isn't helper, or no exec at
          # all. Per codex r4 handoff, these are false-positive controls
          # (`node --test test-preflight-marker-write.mjs`, `node
          # other.mjs preflight-marker-write.mjs`, `node` alone).
          echo "NO_MATCH"
          return 0
          ;;
        tokenize)
          if _detect_tokens_contain_helper "$cmd"; then
            printf 'DENY\ttokenize\t%s\n' "$detail"
          else
            echo "NO_MATCH"
          fi
          return 0
          ;;
        env-prefix|env-prefix-invalid)
          if _detect_tokens_contain_helper "$cmd"; then
            printf 'DENY\t%s\t%s\n' "$kind" "$detail"
          else
            echo "NO_MATCH"
          fi
          return 0
          ;;
        wrapper)
          if [ "$detail" = "$_HELPER_BASENAME" ]; then
            printf 'DENY\tbare-helper\t%s\n' "$detail"
            return 0
          fi
          if [[ "$detail" =~ $_HELPER_REAL_WRAPPER_RE ]]; then
            if _detect_tokens_contain_helper "$cmd"; then
              printf 'DENY\twrapper\t%s\n' "$detail"
              return 0
            fi
          fi
          echo "NO_MATCH"
          return 0
          ;;
        *)
          # Unknown DENY kind: pass through unchanged. Should not occur.
          printf '%s\n' "$result"
          return 0
          ;;
      esac
      ;;
    *)
      # Shouldn't reach. Conservative NO_MATCH.
      echo "NO_MATCH"
      return 0
      ;;
  esac
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
  # PR-A P1.1: authoritative caller cwd threaded from classify_command. The
  # hook's authoritative cwd is parsed JSON .cwd in checkpoint-gate.sh:48 /
  # plan-gate.sh:37, NOT the hook process $PWD. Tier 0 dispatch (line ~1547)
  # and Tier 2/3 LLM dispatch (line ~1762) previously used $PWD as
  # caller_cwd — codex R1 P1 reproduced a marker miss when the .cwd differs
  # from the hook process cwd (subprocess/process $PWD divergence). Fall
  # back to $PWD only when caller doesn't thread (tests, CLI use).
  local caller_cwd_authoritative="${2:-$PWD}"
  shift 2

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
      "O &>>")
        # Append-both-fds: same write effect as `&>` for classification.
        pending_redir="&>"
        ;;
      "O >&")
        # `>&file` file-redirect form (both fds to file). Tokenizer only
        # emits this when the operand failed the fd-dup completeness rule
        # (operand is not exactly `-` or `[0-9]+`).
        pending_redir="&>"
        ;;
      "O <&")
        # `<&file` input-from-file form. Same as plain `<`: input, not a
        # write. The following T-record is the source path — letting it
        # fall through to TOKS (as the existing `O <` case does) keeps
        # this in lockstep with input-redirect behavior.
        ;;
      "O FDDUP")
        # fd-dup (n>&m, n<&m, n>&-, n<&-): in-process file-descriptor
        # plumbing, no file write, no segment break.
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
    # `--` separator: redirect operands may legitimately begin with `-`
    # (e.g. `>&-1` is a file `./-1`); raw `basename "-1"` exits non-zero
    # with `illegal option -- 1` on stderr, leaking through the hook
    # JSON-on-stdout contract. Codex PR #320 R1 P2 finding.
    local rbase="$(basename -- "$rtarget")"
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
      # #279 fix: per-session preflight-marker via redirect. Sibling of the
      # .plan-approval-pending.* arm. Loose glob; strict validation via
      # preflight_marker_basename_matches at gate layer.
      .preflight-done.*)
        local abs_target
        abs_target="$(_resolve_marker_path "$rtarget" "$target_root")"
        printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "redirect_to_marker"
        return 0
        ;;
      # Rank-2: per-session checkpoint-done markers via redirect. Siblings
      # of the .plan-approval-pending.* / .preflight-done.* arms above.
      # Loose glob; strict validation via namespaced_marker_basename_matches
      # at gate layer (checkpoint-gate.sh marker_basename_for_target).
      .pre-checkpoint-done.*|.post-checkpoint-done.*)
        local abs_target
        abs_target="$(_resolve_marker_path "$rtarget" "$target_root")"
        printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "redirect_to_marker"
        return 0
        ;;
      # Rank-2: per-session checkpoint-required markers via redirect (hook
      # arming surface; agents do not write these directly under normal
      # flow, but classifying as marker_write lets the helper-invocation
      # path go through the same gate validation).
      .checkpoint-required.*|.post-checkpoint-required.*)
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
        # #279 fix: per-session preflight-marker via rm. Sibling shape.
        .preflight-done.*)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "rm_marker"
          return 0
          ;;
        # Rank-2: per-session checkpoint quartet markers via rm. SessionEnd
        # cleanup + push-gate sweep use rm at canonical root for these.
        .pre-checkpoint-done.*|.post-checkpoint-done.*|.checkpoint-required.*|.post-checkpoint-required.*)
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
        # #279 fix: per-session preflight-marker via tee.
        .preflight-done.*)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "tee_marker"
          return 0
          ;;
        # Rank-2: per-session checkpoint quartet markers via tee.
        .pre-checkpoint-done.*|.post-checkpoint-done.*|.checkpoint-required.*|.post-checkpoint-required.*)
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
        # #279 fix: per-session preflight-marker via touch.
        .preflight-done.*)
          local abs_target
          abs_target="$(_resolve_marker_path "$t" "$target_root")"
          printf '%s\t%s\t%s\n' "marker_write" "$abs_target" "touch_marker"
          return 0
          ;;
        # Rank-2: per-session checkpoint quartet markers via touch.
        .pre-checkpoint-done.*|.post-checkpoint-done.*|.checkpoint-required.*|.post-checkpoint-required.*)
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

  # ---- Tier 0: project-local override (PR #336) ----
  # Placement: AFTER all structural fail-closed lanes (shell keywords,
  # wrappers, plan-marker helper, bash/sh/zsh -c, eval/source/exec,
  # rm/tee/touch of markers, git, gh), BEFORE the read-only allowlist +
  # interpreter case-arm. By construction, Tier 0 cannot demote safety-
  # critical structural lanes.
  #
  # Helper-level defense-in-depth carve-out enforced in
  # scripts/classifier-override-lookup.mjs (codex R4 ACCEPT-with-FU on plan
  # review; codex R2 ACCEPT-with-FU on file 4/8): refuses override for
  # known hardcoded mutators (em-store/em-revise/em-prune/em-violation/
  # em-recall), helpers with own env-prefix discipline (classifier-marker,
  # classify-correction, plan-marker), and flag-prefixed interpreter
  # invocations (interpreter-flag-present — closes the
  # `node --require ./x scripts/em-store.mjs` bypass class).
  #
  # Shell-level gates: env_prefix_count == 0 (env-prefix is a cross-session
  # attack vector — never serve overrides for that shape) AND the
  # overrides file must exist (fast no-op when no project has staged any
  # overrides — zero cost in the common path).
  if [ $env_prefix_count -eq 0 ] && [ -f "$target_root/.episodic-memory/classifier-overrides.jsonl" ]; then
    # Resolve helper path (installed-runtime preferred, repo-source fallback).
    local __t0_helper=""
    local __t0_global="$HOME/.episodic-memory/scripts/classifier-override-lookup.mjs"
    if [ -f "$__t0_global" ]; then
      __t0_helper="$__t0_global"
    else
      local __t0_self_dir
      __t0_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
      local __t0_repo="$__t0_self_dir/../../scripts/classifier-override-lookup.mjs"
      if [ -f "$__t0_repo" ]; then
        __t0_helper="$__t0_repo"
      fi
    fi
    if [ -n "$__t0_helper" ]; then
      # Reconstruct command text from tokens (same shape Tier 2/3 dispatch uses).
      local __t0_cmd_text=""
      local __t0_ti
      for __t0_ti in ${TOKS[@]+"${TOKS[@]}"}; do
        if [ -z "$__t0_cmd_text" ]; then
          __t0_cmd_text="$__t0_ti"
        else
          __t0_cmd_text="$__t0_cmd_text $__t0_ti"
        fi
      done
      # Subshell `cd "$target_root"` forces helper's process.cwd() to the
      # target so the helper's `resolveRepoRoot(process.cwd()) ===
      # --project-root` cross-repo refusal succeeds. 2>/dev/null swallows
      # helper diagnostics — they don't belong in the hook's stdout JSON.
      #
      # Codex P1 (file 6/8 R1 REJECT): capture caller cwd BEFORE the subshell.
      # Inside the `cd "$target_root" && ...` command substitution, $PWD
      # is the target root, NOT the original caller cwd — passing $PWD
      # there would compute the tuple under the wrong caller_cwd and miss
      # any override staged for the actual caller cwd. Tuple symmetry
      # with classify-correction's write requires the un-subshelled cwd.
      #
      # PR-A P1.1: use threaded caller_cwd_authoritative (parsed .cwd from
      # hook stdin) instead of $PWD. Hook process $PWD ≠ tool .cwd in
      # general; codex R1 P1 reproduced marker miss for that divergence.
      local __t0_caller_cwd="$caller_cwd_authoritative"
      local __t0_out
      __t0_out="$(cd "$target_root" 2>/dev/null && node "$__t0_helper" \
        --project-root "$target_root" \
        --caller-cwd "$__t0_caller_cwd" \
        --command "$__t0_cmd_text" 2>/dev/null)"
      local __t0_rc=$?
      if [ $__t0_rc -eq 0 ] && [ -n "$__t0_out" ]; then
        # Parse helper's hit JSON via inline node parser. Same label
        # allowlist defense as llm-classifier.sh's marker-hit parser
        # (PR #271/#272 class) — unknown labels are rejected before the
        # awk extraction stage.
        local __t0_parsed
        __t0_parsed="$(printf '%s' "$__t0_out" | node -e '
          const ALLOWED = new Set(["read_only","shared_write","marker_write","push_or_pr_create","unsafe_complex"])
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
        if [ -n "$__t0_parsed" ]; then
          local __t0_label __t0_root
          __t0_label="$(printf '%s' "$__t0_parsed" | awk -F'\t' '{print $1}')"
          __t0_root="$(printf '%s' "$__t0_parsed" | awk -F'\t' '{print $2}')"
          # Defense in depth: re-verify project_root_used echo before
          # applying. The helper canonicalizes via realpathOrSame, so the
          # echo MAY include macOS /var → /private/var resolution that
          # target_root doesn't have. Compare against `pwd -P` of
          # target_root (canonical physical dir) for stable equality.
          local __t0_target_canon
          __t0_target_canon="$(cd "$target_root" 2>/dev/null && pwd -P)"
          if [ -n "$__t0_label" ] && [ "$__t0_root" = "$__t0_target_canon" ]; then
            printf '%s\t\t%s\n' "$__t0_label" "tier0_project_override"
            return 0
          fi
        fi
      fi
    fi
    # Tier 0 miss / not-overridable / helper absent → fall through to
    # existing classification flow (read-only allowlist, interpreter case-
    # arm, LLM dispatch, Tier 1 default).
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
      local script_base
      script_base="$(basename "$script" 2>/dev/null)"

      # ── --help / --version carve-out (smart-arming PR bundle) ──
      # If the interpreter+script invocation has ONLY -h/--help/-V/--version
      # as trailing args (no other operations, no redirects), classify as
      # read_only. CLI convention: help/version flags are universally
      # side-effect-free; any script violating this convention is broken.
      #
      # Placement BEFORE the script-name dispatch: even known em-* writes
      # (em-store.mjs --help, etc.) classify as read_only when only help/
      # version flags are present. Justified by CLI convention.
      #
      # Defense-in-depth:
      #   - has_nonmarker_redirect demotes to fallthrough (read-only allowlist
      #     pattern, command-classifier.sh:1608).
      #   - At least one help/version flag must be present (bare `node X.mjs`
      #     stays subject to normal classification).
      #   - env_prefix_count > 0 demotes (cross-session attack class per
      #     PR #271 — env-prefix on ANY allowlist lane is suspect).
      #   - Loop scans all args, not just trailing; mixed `--help foo` →
      #     foo isn't help/version → carve-out doesn't fire → falls through.
      if [ "$has_nonmarker_redirect" != "1" ] && [ $env_prefix_count -eq 0 ]; then
        local _hv_all=1 _hv_any=0 _hv_i=$((idx+2)) _hv_n=${#TOKS[@]}
        while [ $_hv_i -lt $_hv_n ]; do
          case "${TOKS[$_hv_i]}" in
            --help|--version|-h|-V|--help=*|--version=*)
              _hv_any=1
              ;;
            *)
              _hv_all=0
              break
              ;;
          esac
          _hv_i=$((_hv_i+1))
        done
        if [ $_hv_all -eq 1 ] && [ $_hv_any -eq 1 ]; then
          printf '%s\t\t%s\n' "read_only" "interpreter_help_or_version_flag"
          return 0
        fi
      fi

      case "$script_base" in
        em-search.mjs|em-list.mjs|em-watch-codex.mjs|em-pattern-health.mjs|em-check-stale.mjs|em-rebuild-index.mjs|em-workflow-validate.mjs)
          # em-rebuild-index writes index.jsonl but the operation is metadata
          # sync derived deterministically from episode files (idempotent,
          # atomic-rename, no partial-corruption window). Same gate-class as
          # em-search (which also writes — access_count). Treating as
          # read_only so the gate stops false-positive-blocking metadata sync.
          #
          # PR #336 bundled relabel: em-workflow-validate.mjs moved from the
          # shared_write basket (was below at "interpreter_em_write") to
          # here. Self-documented as a pure validator: "does NOT modify
          # episodes, write markers, or call hooks." Was wrongly grouped with
          # em-store/em-revise/etc. mutators.
          printf '%s\t\t%s\n' "read_only" "interpreter_em_read"
          return 0
          ;;
        em-store.mjs|em-revise.mjs|em-prune.mjs|em-violation.mjs|em-recall.mjs)
          printf '%s\t\t%s\n' "shared_write" "interpreter_em_write"
          return 0
          ;;
        classify-correction.mjs)
          # FU-6: LLM-classifier correction helper. Writes only inside
          # <project>/.episodic-memory/classifier-overrides.jsonl AFTER the
          # helper validates --project-root == resolveRepoRoot(process.cwd()).
          # Same gate-treatment as em-search (label=read_only, reason carries
          # the helper-write nature).
          #
          # Same-class env-prefix defense as plan-marker.mjs (PR #272 F-4):
          # `FOO=bar node classify-correction.mjs --project-root ...` MUST NOT
          # ride the allowlist lane. Reject any leading POSIX env assignment.
          if [ $env_prefix_count -gt 0 ]; then
            printf '%s\t\t%s\n' "unsafe_complex" "classify_correction_env_override"
            return 0
          fi
          printf '%s\t\t%s\n' "read_only" "interpreter_classify_correction"
          return 0
          ;;
        classifier-marker.mjs)
          # Agent-self-classify helper (replaces direct-API Tier 3). Writes
          # only to <project>/.checkpoints/classify/<sha>.json after the
          # helper validates --project-root == resolveRepoRoot(process.cwd())
          # and refuses cross-repo writes / symlinked ancestors / wrong cwd.
          #
          # Same-class env-prefix defense as plan-marker.mjs and
          # classify-correction.mjs: leading env assignment is a
          # cross-session attack vector (PR #271 / PR #272 F-4). The
          # command-local env override can desync the classifier's view of
          # session_id from the helper's view, planting a marker for the
          # wrong session. Reject any env-prefix invocation form.
          if [ $env_prefix_count -gt 0 ]; then
            printf '%s\t\t%s\n' "unsafe_complex" "classifier_marker_env_override"
            return 0
          fi
          # Marker-write label: gate-treatment matches preflight-marker-write
          # / plan-marker (writes only to .checkpoints/ + helper validates
          # its own authority). Read invocations are also marker_write —
          # the read mode never writes anything but the gate doesn't need
          # to distinguish; helper enforces.
          printf '%s\t\t%s\n' "marker_write" "interpreter_classifier_marker"
          return 0
          ;;
      esac

      # Tier 2/3 LLM classifier dispatch (replaces the "interpreter_other"
      # blanket shared_write fallback). Cache-hit path is fast; cache-miss
      # dispatches Tier 3 (Anthropic API) when ANTHROPIC_API_KEY is set and
      # LLM_CLASSIFIER_ENABLED != false. No-decision (no key, dispatcher
      # absent, low-confidence, project_root_used mismatch) falls through to
      # the Tier 1 default below.
      if [ -z "${__LLM_CLASSIFIER_SOURCED:-}" ]; then
        local __llm_lib_path
        __llm_lib_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/llm-classifier.sh"
        if [ -f "$__llm_lib_path" ]; then
          # shellcheck disable=SC1091
          source "$__llm_lib_path"
          __LLM_CLASSIFIER_SOURCED=1
        else
          __LLM_CLASSIFIER_SOURCED=0
        fi
      fi
      if [ "${__LLM_CLASSIFIER_SOURCED:-0}" = "1" ]; then
        # Reconstruct command text from tokens (already shell-unquoted; the
        # dispatcher collapses whitespace and re-normalizes anyway).
        local __cmd_text=""
        local __ti
        for __ti in ${TOKS[@]+"${TOKS[@]}"}; do
          if [ -z "$__cmd_text" ]; then
            __cmd_text="$__ti"
          else
            __cmd_text="$__cmd_text $__ti"
          fi
        done
        local __llm_out __llm_label __llm_reason
        # PR-A P1.1: pass caller_cwd_authoritative (parsed .cwd from hook
        # stdin) instead of hook process $PWD. Codex R1 P1: marker written
        # under nested cwd was a miss when classify_command subprocess
        # $PWD differs from the .cwd authority.
        if __llm_out="$(llm_classify_command "$__cmd_text" "$target_root" "$caller_cwd_authoritative" 2>/dev/null)"; then
          __llm_label="${__llm_out%%	*}"
          __llm_reason="${__llm_out#*	}"
          __llm_reason="${__llm_reason%$'\n'}"
          if [ -n "$__llm_label" ]; then
            printf '%s\t\t%s\n' "$__llm_label" "$__llm_reason"
            return 0
          fi
        fi
      fi

      # Tier 1 fallback (no LLM available, no decision, or dispatcher absent).
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
#   $3  caller cwd authoritative (PR-A P1.1); optional, defaults to $PWD.
#       Production callers (checkpoint-gate.sh:662, plan-gate.sh:129) thread
#       the parsed JSON .cwd from hook stdin (the tool-caller's actual cwd).
#       Tier 0 + Tier 2/3 dispatch previously used hook process $PWD which
#       diverges from .cwd when the agent invokes a Bash tool from a nested
#       cwd or a worktree. Codex R1 P1 reproduced marker miss for that
#       divergence.
#
# Output: LABEL\tTARGET\tREASON
classify_command() {
  local cmd="$1"
  local repo_root="${2:-$(pwd)}"
  local caller_cwd_authoritative="${3:-$PWD}"

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
          result="$(printf '%s\n' "$seg_lines" | _classify_segment "$repo_root" "$caller_cwd_authoritative")"
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
    result="$(printf '%s\n' "$seg_lines" | _classify_segment "$repo_root" "$caller_cwd_authoritative")"
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
    # Rank-2: per-session checkpoint-done markers via classify_path. Narrow
    # to .pre/.post-checkpoint-done (content-bearing agent-writable markers
    # only — .checkpoint-required / .post-checkpoint-required are gate-armed
    # via Bash touch, not Write/Edit, so they don't need classify_path
    # recognition).
    .pre-checkpoint-done.*|.post-checkpoint-done.*)
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

# Tag-name fragments that, when found in --tag/--tags args, mark an em-*
# invocation as a codex-review handoff.
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
# signals in explicit routing tags; 1 otherwise.
#
# #285: do not inspect free-text fields such as --summary or --body. Those
# fields often describe review/preflight concepts as lesson content, which is
# not the same intent as routing a review handoff.
# Args: $1 = start_index; $2..$N = tokens.
_preflight_scan_em_args() {
  local i=$1
  shift
  local -a T=("$@")
  local n=${#T[@]}
  while [ $i -lt $n ]; do
    local t="${T[$i]}"
    case "$t" in
      --tag|--tags)
        local v="${T[$((i+1))]:-}"
        if [[ "$v" =~ $_PREFLIGHT_REVIEW_TAG_RE ]]; then
          return 0
        fi
        i=$((i+2))
        ;;
      --tag=*|--tags=*)
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
