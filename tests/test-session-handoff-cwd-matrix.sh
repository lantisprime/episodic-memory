#!/usr/bin/env bash
# test-session-handoff-cwd-matrix.sh
#
# Tests for hooks/session-handoff-prompt.sh — discipline #20 cwd-binding matrix
# from rank-10 plan v5 (codex consensus r1-r5). Each case varies stdin.cwd (the
# contract input), not caller cwd (codex F12 fix).
#
# Cases (per plan v5 round-5 fold):
#   C1  stdin.cwd=<main>           caller=/private/tmp     → resolved=<main>
#   C2  stdin.cwd=<main>/scripts   caller=/private/tmp     → resolved=<main>
#   C3  stdin.cwd=<worktree>       caller=/private/tmp     → resolved=<main> (via common-dir)
#   C3a stdin.cwd=<worktree>/nested caller=/private/tmp    → resolved=<main>
#   C4  stdin.cwd=<main>           caller=<main>           → resolved=<main>
#   C5  stdin.cwd missing/empty    caller=any              → exit 0 + stderr + NO directive
#   C6  stdin.cwd=<other-repo>     caller=<main>           → resolved=<other-repo> (stdin is contract)
#   C7  stdin.cwd=<nonexistent>    caller=any              → exit 0 + stderr + NO directive
#   C8  stdin.cwd=<main>, malformed config.json:claude_memory_root → fall back to canonical resolver
#
# Plus:
#   T7  bounded resolver: pick non-empty variant, reject wrong sibling project
#   T7a bounded resolver: deterministic tie-break (canonical first)
#   T9  installed runtime sha matches committed source
#
# Foreign-project generalization (#440):
#   T440-1 foreign repo + substrate em-search → global substrate path emitted,
#          cd stays repo-bound, only existing memory files listed
#   T440-2 in-repo scripts/em-search.mjs wins over substrate (probe order)
#   T440-3 no em-search anywhere → directive omits the em-search step
#   T440-4 nothing to load (no handoff/files/em-search) → NO directive + stderr
#   T440-5 handoff only → Q1-only directive, no Q2
#   T440-6 handoff + files, no em-search → two-question, files-only Q2
#   T440-7 HOME unset → fail-safe exit 0 + stderr, no set -u crash

set -u

HOOK="$(cd "$(dirname "$0")/../plugins/claude-code/hooks" && pwd)/session-handoff-prompt.sh"
INSTALLED_HOOK="${HOME}/.claude/hooks/session-handoff-prompt.sh"
# Resolve to the MAIN repo via git common-dir, exactly as the hook does (#440):
# when this suite runs from a linked worktree, stdin.cwd=<worktree> resolves to
# MAIN, so repo-identity assertions must expect MAIN, not the worktree root.
SUITE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
_suite_common="$(git -C "${SUITE_ROOT}" rev-parse --git-common-dir 2>/dev/null)"
case "${_suite_common}" in
  /*) : ;;
  *)  _suite_common="${SUITE_ROOT}/${_suite_common}" ;;
esac
MAIN_REPO="$(dirname "$(cd -P "${_suite_common}" && pwd)")"

PASS=0
FAIL=0
FAILED_TESTS=()

_assert() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name: expected '$expected' got '$actual'")
  fi
}

_assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name: did not contain '$needle' in output (first 200 chars: $(printf '%s' "$haystack" | head -c 200))")
  fi
}

_assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    FAIL=$((FAIL+1))
    FAILED_TESTS+=("$name: unexpected presence of '$needle'")
  else
    PASS=$((PASS+1))
  fi
}

# Invoke hook from a given caller cwd with given stdin JSON.
_run_hook() {
  local caller_cwd="$1" stdin_json="$2"
  cd "$caller_cwd" 2>/dev/null || { printf "caller_cwd_missing"; return 1; }
  printf '%s' "$stdin_json" | "$HOOK" 2>/dev/null
}

_run_hook_stderr() {
  local caller_cwd="$1" stdin_json="$2"
  cd "$caller_cwd" 2>/dev/null || { printf "caller_cwd_missing"; return 1; }
  printf '%s' "$stdin_json" | "$HOOK" 2>&1 >/dev/null
}

# #440: invoke with an overridden HOME so substrate-resolution cases are
# hermetic (independent of whether this machine has ~/.episodic-memory).
_run_hook_home() {
  local fake_home="$1" caller_cwd="$2" stdin_json="$3"
  cd "$caller_cwd" 2>/dev/null || { printf "caller_cwd_missing"; return 1; }
  printf '%s' "$stdin_json" | HOME="$fake_home" "$HOOK" 2>/dev/null
}

_run_hook_home_stderr() {
  local fake_home="$1" caller_cwd="$2" stdin_json="$3"
  cd "$caller_cwd" 2>/dev/null || { printf "caller_cwd_missing"; return 1; }
  printf '%s' "$stdin_json" | HOME="$fake_home" "$HOOK" 2>&1 >/dev/null
}

# ---------------------------------------------------------------------------
# C1: stdin.cwd=<main>, caller=/private/tmp → resolved=<main>
# ---------------------------------------------------------------------------
_out=$(_run_hook /private/tmp "{\"cwd\":\"${MAIN_REPO}\"}")
_assert_contains "C1 emits main repo path" "${MAIN_REPO}" "$_out"
_assert_contains "C1 emits BLOCKING directive" "BLOCKING:" "$_out"

# ---------------------------------------------------------------------------
# C2: stdin.cwd=<main>/scripts (nested), caller=/private/tmp → resolved=<main>
# ---------------------------------------------------------------------------
_out=$(_run_hook /private/tmp "{\"cwd\":\"${MAIN_REPO}/scripts\"}")
_assert_contains "C2 nested stdin resolves to main" "${MAIN_REPO}" "$_out"
_assert_not_contains "C2 does NOT bind to /private/tmp" "/private/tmp" "$_out"

# ---------------------------------------------------------------------------
# C3 + C3a: linked worktree stdin → MAIN via common-dir
# Create a temp worktree to test.
# ---------------------------------------------------------------------------
TMP_WT="$(mktemp -d /tmp/em-rank10-wt.XXXXXX)"
WT_NAME="$(basename "$TMP_WT")"
WT_PATH="${MAIN_REPO}/.claude/worktrees/${WT_NAME}"
mkdir -p "${MAIN_REPO}/.claude/worktrees" 2>/dev/null

# Try to add worktree; skip C3/C3a if it fails (e.g. dirty tree). Not fatal.
if git -C "${MAIN_REPO}" worktree add --detach "${WT_PATH}" >/dev/null 2>&1; then
  _out=$(_run_hook /private/tmp "{\"cwd\":\"${WT_PATH}\"}")
  _assert_contains "C3 worktree stdin resolves to MAIN" "${MAIN_REPO}" "$_out"
  _assert_not_contains "C3 does NOT emit worktree path" "/worktrees/${WT_NAME}" "$_out"

  mkdir -p "${WT_PATH}/sub-dir-c3a" 2>/dev/null
  _out=$(_run_hook /private/tmp "{\"cwd\":\"${WT_PATH}/sub-dir-c3a\"}")
  _assert_contains "C3a nested worktree resolves to MAIN" "${MAIN_REPO}" "$_out"

  git -C "${MAIN_REPO}" worktree remove --force "${WT_PATH}" >/dev/null 2>&1 || true
  rm -rf "${TMP_WT}"
else
  printf "[skip] C3/C3a: could not add temp worktree (likely dirty tree)\n" >&2
fi

# ---------------------------------------------------------------------------
# C4: happy path
# ---------------------------------------------------------------------------
_out=$(_run_hook "${MAIN_REPO}" "{\"cwd\":\"${MAIN_REPO}\"}")
_assert_contains "C4 happy path emits main" "${MAIN_REPO}" "$_out"

# ---------------------------------------------------------------------------
# C5: stdin.cwd missing → exit 0 + stderr + NO directive
# ---------------------------------------------------------------------------
_out=$(_run_hook /private/tmp '{}')
_err=$(_run_hook_stderr /private/tmp '{}')
_assert "C5 missing stdin.cwd emits nothing on stdout" "" "$_out"
_assert_contains "C5 logs to stderr" "session-handoff-prompt" "$_err"
_assert_contains "C5 stderr says missing cwd" "stdin missing cwd" "$_err"

# C5 empty string variant
_out=$(_run_hook /private/tmp '{"cwd":""}')
_assert "C5 empty stdin.cwd emits nothing on stdout" "" "$_out"

# ---------------------------------------------------------------------------
# C6: different repo via stdin → respect stdin (stdin is contract)
# ---------------------------------------------------------------------------
OTHER_REPO=""
for cand in /tmp/episodic-memory-test-c6 "${HOME}/Developer/projects/user-preferences" "${HOME}/Documents/projects/episodic-memory"; do
  if [ -d "$cand" ] && git -C "$cand" rev-parse --git-common-dir >/dev/null 2>&1; then
    OTHER_REPO="$cand"
    break
  fi
done
if [ -n "$OTHER_REPO" ] && [ "$OTHER_REPO" != "$MAIN_REPO" ]; then
  _out=$(_run_hook "${MAIN_REPO}" "{\"cwd\":\"${OTHER_REPO}\"}")
  _assert_contains "C6 stdin's repo wins over caller's" "${OTHER_REPO}" "$_out"
else
  printf "[skip] C6: no second repo available for cross-repo test\n" >&2
fi

# ---------------------------------------------------------------------------
# C7: non-existent stdin.cwd → exit 0 + stderr + NO directive
# ---------------------------------------------------------------------------
_out=$(_run_hook /private/tmp '{"cwd":"/this/path/does/not/exist/anywhere"}')
_err=$(_run_hook_stderr /private/tmp '{"cwd":"/this/path/does/not/exist/anywhere"}')
_assert "C7 nonexistent stdin.cwd emits nothing on stdout" "" "$_out"
_assert_contains "C7 stderr says does not exist" "does not exist" "$_err"

# ---------------------------------------------------------------------------
# C8: malformed config.json:claude_memory_root → fall back to canonical
# Set up a temp config that points to non-existent path; expect graceful fall-back.
# ---------------------------------------------------------------------------
TMP_REPO="$(mktemp -d /tmp/em-rank10-c8.XXXXXX)"
git -C "${TMP_REPO}" init -q >/dev/null 2>&1
mkdir -p "${TMP_REPO}/.episodic-memory"
echo '{"claude_memory_root":"/this/path/does/not/exist"}' > "${TMP_REPO}/.episodic-memory/config.json"
# Plant an in-repo em-search so a directive is emitted regardless of whether
# this machine has the global substrate (#440 made emission conditional).
mkdir -p "${TMP_REPO}/scripts"
: > "${TMP_REPO}/scripts/em-search.mjs"
_out=$(_run_hook /private/tmp "{\"cwd\":\"${TMP_REPO}\"}")
_assert_contains "C8 malformed config falls back to canonical" "BLOCKING:" "$_out"
_assert_not_contains "C8 does NOT use the invalid config path" "/this/path/does/not/exist" "$_out"
rm -rf "${TMP_REPO}"

# ---------------------------------------------------------------------------
# T7: bounded resolver — does NOT scan ~/.claude/projects/*
# Construct a temp repo with no memory anywhere; hook should fall back to
# canonical empty path (graceful degradation), NOT find an unrelated sibling.
# ---------------------------------------------------------------------------
TMP_REPO_T7="$(mktemp -d /tmp/em-rank10-t7.XXXXXX)"
git -C "${TMP_REPO_T7}" init -q >/dev/null 2>&1
# Realpath-normalize like the hook does (on macOS /tmp → /private/tmp via cd -P).
TMP_REPO_T7_REAL="$(cd -P "${TMP_REPO_T7}" && pwd)"
# Plant an in-repo em-search so a directive is emitted (#440); the orphan repo
# has no memory files anywhere, so the always-tier list must be EMPTY — the
# hook must NOT surface any ~/.claude/projects path (no sibling-project scan).
mkdir -p "${TMP_REPO_T7_REAL}/scripts"
: > "${TMP_REPO_T7_REAL}/scripts/em-search.mjs"
_out=$(_run_hook /private/tmp "{\"cwd\":\"${TMP_REPO_T7_REAL}\"}")
_assert_contains "T7 bounded: cd stays bound to orphan repo" "cd ${TMP_REPO_T7_REAL} && node" "$_out"
_assert_not_contains "T7 bounded: no memory path leaks for orphan repo" "${HOME}/.claude/projects" "$_out"
rm -rf "${TMP_REPO_T7}"

# ---------------------------------------------------------------------------
# T14: path-with-spaces — em-search command must shell-quote REPO_ROOT
# (codex post-impl P1, 2026-05-12: unquoted ${REPO_ROOT} broke for paths
# with spaces or shell metacharacters).
# ---------------------------------------------------------------------------
TMP_REPO_T14_PARENT="$(mktemp -d /tmp/em-rank10-t14.XXXXXX)"
TMP_REPO_T14="${TMP_REPO_T14_PARENT}/repo with spaces"
mkdir -p "${TMP_REPO_T14}"
git -C "${TMP_REPO_T14}" init -q >/dev/null 2>&1
TMP_REPO_T14_REAL="$(cd -P "${TMP_REPO_T14}" && pwd)"
# Plant an in-repo em-search so the spaced path is the one emitted (#440
# made the in-repo copy a probe, not an assumption).
mkdir -p "${TMP_REPO_T14_REAL}/scripts"
: > "${TMP_REPO_T14_REAL}/scripts/em-search.mjs"
_out=$(_run_hook /private/tmp "{\"cwd\":\"${TMP_REPO_T14_REAL}\"}")
# Emitted cd should be single-quoted (path has spaces).
_assert_contains "T14 path-with-spaces: cd is single-quoted" "cd '${TMP_REPO_T14_REAL}'" "$_out"
_assert_contains "T14 path-with-spaces: em-search.mjs path single-quoted" "node '${TMP_REPO_T14_REAL}/scripts/em-search.mjs'" "$_out"
# Negative: no bare unquoted "cd /path with spaces" segment.
_assert_not_contains "T14 no unquoted space in cd" "cd ${TMP_REPO_T14_REAL} && node" "$_out"
rm -rf "${TMP_REPO_T14_PARENT}"

# ---------------------------------------------------------------------------
# T14a: clean path stays UNQUOTED (no churn on safe paths)
# ---------------------------------------------------------------------------
_out=$(_run_hook /private/tmp "{\"cwd\":\"${MAIN_REPO}\"}")
_assert_contains "T14a clean path stays unquoted" "cd ${MAIN_REPO} && node ${MAIN_REPO}/scripts/em-search.mjs" "$_out"

# ---------------------------------------------------------------------------
# T14b: path with internal apostrophe — single-quote escape (s/'/'\''/g)
# (codex impl-round-2 FU-IMPL-1; sub-3-LOC inline-FU per Rule 18 heuristic)
# ---------------------------------------------------------------------------
TMP_REPO_T14B_PARENT="$(mktemp -d /tmp/em-rank10-t14b.XXXXXX)"
# Path contains a literal apostrophe
TMP_REPO_T14B="${TMP_REPO_T14B_PARENT}/it's-mine"
mkdir -p "${TMP_REPO_T14B}"
git -C "${TMP_REPO_T14B}" init -q >/dev/null 2>&1
TMP_REPO_T14B_REAL="$(cd -P "${TMP_REPO_T14B}" && pwd)"
mkdir -p "${TMP_REPO_T14B_REAL}/scripts"
: > "${TMP_REPO_T14B_REAL}/scripts/em-search.mjs"
_out=$(_run_hook /private/tmp "{\"cwd\":\"${TMP_REPO_T14B_REAL}\"}")
# The POSIX escape sequence in the actual emitted command is `'\''` (4 chars:
# quote, backslash, quote, quote). The hook returns its directive as a JSON
# string via jq, where `\` is JSON-encoded to `\\`. So in the raw stdout the
# escape sequence appears as `'\\''` (5 chars: quote, backslash, backslash,
# quote, quote). Build needle as that 5-char literal.
_needle="'\\\\''"
_assert_contains "T14b apostrophe: emits POSIX escape sequence (JSON-encoded)" "$_needle" "$_out"
# Sanity: unquoted "cd <path-with-apostrophe> &&" must NOT appear.
_assert_not_contains "T14b apostrophe: no unquoted cd with raw apostrophe" "cd ${TMP_REPO_T14B_REAL} &&" "$_out"
rm -rf "${TMP_REPO_T14B_PARENT}"

# ---------------------------------------------------------------------------
# T9: installed runtime sha matches committed source
# ---------------------------------------------------------------------------
if [ -f "$INSTALLED_HOOK" ]; then
  SRC_SHA="$(shasum -a 256 "$HOOK" | awk '{print $1}')"
  INST_SHA="$(shasum -a 256 "$INSTALLED_HOOK" | awk '{print $1}')"
  _assert "T9 installed hook matches source" "$SRC_SHA" "$INST_SHA"
else
  printf "[skip] T9: installed hook missing at %s (run install or copy step)\n" "$INSTALLED_HOOK" >&2
fi

# ---------------------------------------------------------------------------
# Always-tier emission check: directive lists the 6-file set (2026-05-16
# demotions), NOT the demoted pair.
# ---------------------------------------------------------------------------
_out=$(_run_hook /private/tmp "{\"cwd\":\"${MAIN_REPO}\"}")
for f in MEMORY.md feedback_verify_by_artifact.md feedback_self_trigger_artifact_mode.md \
         feedback_per_prompt_rule_preflight.md feedback_bp1_step9_filing_trigger.md \
         feedback_canonical_agent_dispatch_trigger.md; do
  _assert_contains "always-tier emits $f" "$f" "$_out"
done
for f in feedback_send_grep_artifact.md feedback_three_state_review_verdict.md; do
  _assert_not_contains "demoted lazy-tier $f NOT emitted" "$f" "$_out"
done

# em-search emitted with mechanical cd-binding (in-repo dev copy wins at MAIN)
_assert_contains "em-search emitted with cd-binding" "cd ${MAIN_REPO} && node ${MAIN_REPO}/scripts/em-search.mjs" "$_out"

# ---------------------------------------------------------------------------
# T440-*: foreign-project generalization (issue #440). All hermetic via fake
# HOME + config.json:claude_memory_root override.
# ---------------------------------------------------------------------------
T440_HOME="$(mktemp -d /tmp/em-440-home.XXXXXX)"
T440_HOME_REAL="$(cd -P "${T440_HOME}" && pwd)"
mkdir -p "${T440_HOME_REAL}/.episodic-memory/scripts"
: > "${T440_HOME_REAL}/.episodic-memory/scripts/em-search.mjs"

T440_REPO_PARENT="$(mktemp -d /tmp/em-440-repo.XXXXXX)"
T440_REPO="${T440_REPO_PARENT}/foreign-project"
mkdir -p "${T440_REPO}"
git -C "${T440_REPO}" init -q >/dev/null 2>&1
T440_REPO_REAL="$(cd -P "${T440_REPO}" && pwd)"
T440_MEM="${T440_REPO_PARENT}/mem"
mkdir -p "${T440_MEM}"
T440_MEM_REAL="$(cd -P "${T440_MEM}" && pwd)"
printf '# mem\n' > "${T440_MEM_REAL}/MEMORY.md"
mkdir -p "${T440_REPO_REAL}/.episodic-memory"
printf '{"claude_memory_root":"%s"}' "${T440_MEM_REAL}" > "${T440_REPO_REAL}/.episodic-memory/config.json"

# T440-1: foreign repo (no in-repo em-search) → global substrate path, cd
# stays repo-bound, only MEMORY.md listed, no absent feedback files.
_out=$(_run_hook_home "${T440_HOME_REAL}" /private/tmp "{\"cwd\":\"${T440_REPO_REAL}\"}")
_assert_contains "T440-1 substrate em-search path emitted" \
  "node ${T440_HOME_REAL}/.episodic-memory/scripts/em-search.mjs" "$_out"
_assert_contains "T440-1 cd stays bound to foreign repo" "cd ${T440_REPO_REAL} && node" "$_out"
_assert_not_contains "T440-1 repo-relative em-search NOT emitted" \
  "${T440_REPO_REAL}/scripts/em-search.mjs" "$_out"
_assert_contains "T440-1 existing MEMORY.md listed" "- ${T440_MEM_REAL}/MEMORY.md" "$_out"
_assert_not_contains "T440-1 absent feedback file NOT listed" "feedback_verify_by_artifact.md" "$_out"
_assert_contains "T440-1 count reflects filtered list" "these 1 absolute path" "$_out"

# T440-2: in-repo copy wins over substrate (probe order).
mkdir -p "${T440_REPO_REAL}/scripts"
: > "${T440_REPO_REAL}/scripts/em-search.mjs"
_out=$(_run_hook_home "${T440_HOME_REAL}" /private/tmp "{\"cwd\":\"${T440_REPO_REAL}\"}")
_assert_contains "T440-2 in-repo em-search wins" \
  "node ${T440_REPO_REAL}/scripts/em-search.mjs" "$_out"
rm -rf "${T440_REPO_REAL}/scripts"

# T440-3: no em-search anywhere → directive still emitted, em-search omitted.
T440_HOME_EMPTY="$(mktemp -d /tmp/em-440-home-empty.XXXXXX)"
T440_HOME_EMPTY_REAL="$(cd -P "${T440_HOME_EMPTY}" && pwd)"
_out=$(_run_hook_home "${T440_HOME_EMPTY_REAL}" /private/tmp "{\"cwd\":\"${T440_REPO_REAL}\"}")
_assert_contains "T440-3 files still listed without em-search" "- ${T440_MEM_REAL}/MEMORY.md" "$_out"
_assert_not_contains "T440-3 no em-search command emitted" "em-search.mjs" "$_out"

# T440-5: handoff only (no always-tier files, no em-search) → Q1-only.
printf 'handoff\n' > "${T440_MEM_REAL}/session_handoff.md"
rm -f "${T440_MEM_REAL}/MEMORY.md"
_out=$(_run_hook_home "${T440_HOME_EMPTY_REAL}" /private/tmp "{\"cwd\":\"${T440_REPO_REAL}\"}")
_assert_contains "T440-5 Q1 handoff question emitted" "Load session_handoff.md" "$_out"
_assert_contains "T440-5 handoff read instruction emitted" "If y: Read ${T440_MEM_REAL}/session_handoff.md" "$_out"
_assert_not_contains "T440-5 no Q2 question emitted" "discipline + toolkit" "$_out"

# T440-6: handoff + files, no em-search → two-question directive, files-only
# Q2 (covers the handoff x files-only arm of the directive matrix).
printf '# mem\n' > "${T440_MEM_REAL}/MEMORY.md"
_out=$(_run_hook_home "${T440_HOME_EMPTY_REAL}" /private/tmp "{\"cwd\":\"${T440_REPO_REAL}\"}")
_assert_contains "T440-6 both questions emitted" "Q2 (verbatim, after Q1 is answered)" "$_out"
_assert_contains "T440-6 files-only Q2 lists MEMORY.md" "- ${T440_MEM_REAL}/MEMORY.md" "$_out"
_assert_not_contains "T440-6 no em-search command emitted" "em-search.mjs" "$_out"

# T440-4: nothing to load at all → exit 0, NO directive, stderr log.
rm -f "${T440_MEM_REAL}/session_handoff.md" "${T440_MEM_REAL}/MEMORY.md"
_out=$(_run_hook_home "${T440_HOME_EMPTY_REAL}" /private/tmp "{\"cwd\":\"${T440_REPO_REAL}\"}")
_rc=$?
_err=$(_run_hook_home_stderr "${T440_HOME_EMPTY_REAL}" /private/tmp "{\"cwd\":\"${T440_REPO_REAL}\"}")
_assert "T440-4 nothing-to-load emits nothing on stdout" "" "$_out"
_assert "T440-4 exits 0" "0" "$_rc"
_assert_contains "T440-4 stderr explains skip" "skipping directive" "$_err"

# T440-7: HOME unset → fail-safe (exit 0, stderr, no directive), not a
# set -u crash mid-script.
_out=$(cd /private/tmp && printf '%s' "{\"cwd\":\"${T440_REPO_REAL}\"}" | env -u HOME "$HOOK" 2>/dev/null)
_rc=$?
_err=$(cd /private/tmp && printf '%s' "{\"cwd\":\"${T440_REPO_REAL}\"}" | env -u HOME "$HOOK" 2>&1 >/dev/null)
_assert "T440-7 HOME-unset emits nothing on stdout" "" "$_out"
_assert "T440-7 HOME-unset exits 0" "0" "$_rc"
_assert_contains "T440-7 stderr explains HOME skip" "HOME unset" "$_err"

rm -rf "${T440_HOME}" "${T440_HOME_EMPTY}" "${T440_REPO_PARENT}"

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
printf '\n'
printf 'cwd-matrix tests: %d pass, %d fail\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\nFailures:\n'
  for f in "${FAILED_TESTS[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi
exit 0
