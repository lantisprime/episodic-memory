#!/usr/bin/env bash
# test-command-classifier.sh — Tests for hooks/lib/command-classifier.sh
#
# Usage: bash tests/test-command-classifier.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$REPO_ROOT/hooks/lib/command-classifier.sh"

if [ ! -f "$LIB" ]; then
  echo "FAIL: $LIB not found"
  exit 1
fi

# shellcheck disable=SC1090
source "$LIB"

passed=0
failed=0

# Mock repo root for marker resolution
TEST_ROOT="/tmp/test-classifier-root"

assert_label() {
  local desc="$1"
  local cmd="$2"
  local expected_label="$3"
  local expected_target="${4:-}"

  local result label target reason
  result="$(classify_command "$cmd" "$TEST_ROOT")"
  label="${result%%	*}"
  local rest="${result#*	}"
  target="${rest%%	*}"
  reason="${rest#*	}"

  local ok=1
  if [ "$label" != "$expected_label" ]; then ok=0; fi
  if [ -n "$expected_target" ] && [ "$target" != "$expected_target" ]; then ok=0; fi

  if [ $ok -eq 1 ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc"
    echo "    cmd:      $cmd"
    echo "    expected: $expected_label" "${expected_target:+(target=$expected_target)}"
    echo "    got:      $label (target=$target, reason=$reason)"
    failed=$((failed+1))
  fi
}

echo ""
echo "--- Read-only ---"
assert_label "T01 ls" "ls -la" "read_only"
assert_label "T02 cat" "cat /etc/hosts" "read_only"
assert_label "T03 grep" "grep -r foo ." "read_only"
assert_label "T04 git status" "git status" "read_only"
assert_label "T05 git log" "git log --oneline" "read_only"
assert_label "T06 git -C path log" "git -C /tmp log" "read_only"
assert_label "T07 git --no-pager show" "git --no-pager show HEAD" "read_only"
assert_label "T08 gh pr view" "gh pr view 123" "read_only"
assert_label "T09 gh pr list" "gh pr list" "read_only"
assert_label "T10 gh issue list" "gh issue list" "read_only"
assert_label "T11 gh api default GET" "gh api /repos/foo/bar" "read_only"
assert_label "T12 echo with no redirect" "echo hello" "read_only"
assert_label "T13 empty" "" "read_only"
assert_label "T14 colon noop" ":" "read_only"
assert_label "T15 true" "true" "read_only"
assert_label "T16 node em-search" "node scripts/em-search.mjs --project x" "read_only"
assert_label "T17 wc -l" "wc -l file.txt" "read_only"

echo ""
echo "--- Push or PR-create ---"
assert_label "T20 git push" "git push origin main" "push_or_pr_create"
assert_label "T21 git -C path push" "git -C /tmp push" "push_or_pr_create"
assert_label "T22 git --no-pager push" "git --no-pager push" "push_or_pr_create"
assert_label "T23 gh pr create" "gh pr create --title foo --body bar" "push_or_pr_create"
assert_label "T24 gh pr merge" "gh pr merge 123" "push_or_pr_create"
assert_label "T25 gh issue create" "gh issue create --title foo" "push_or_pr_create"
assert_label "T26 gh issue close" "gh issue close 5" "push_or_pr_create"
assert_label "T27 gh release create" "gh release create v1.0" "push_or_pr_create"
assert_label "T28 gh api -X POST" "gh api -X POST /repos/foo/bar/merges" "push_or_pr_create"
assert_label "T29 gh api -XPOST" "gh api -XPOST /repos/foo/bar/issues" "push_or_pr_create"
assert_label "T30 gh api --method POST" "gh api --method POST /repos/foo/bar/comments" "push_or_pr_create"
assert_label "T31 gh api method-after-path" "gh api /repos/foo/bar/labels -X POST" "push_or_pr_create"
assert_label "T32 gh api lowercase" "gh api -X post /repos/foo/bar/issues" "push_or_pr_create"
assert_label "T33 env before git push" "GIT_SSH=foo git push" "push_or_pr_create"
assert_label "T34 gh pr review --approve" "gh pr review 5 --approve" "push_or_pr_create"

echo ""
echo "--- False-positive guards (push detection should NOT fire) ---"
assert_label "T40 git stash push" "git stash push -m wip" "shared_write"
assert_label "T41 git commit -m push" "git commit -m push" "shared_write"
assert_label "T42 quoted gh pr create in echo" "echo 'gh pr create'" "read_only"
assert_label "T43 quoted git push in echo" "echo \"git push origin\"" "read_only"
assert_label "T44 git branch (read shape)" "git branch" "read_only"

echo ""
echo "--- Marker write detection ---"
assert_label "T50 echo redirect to .pre-checkpoint-done" \
  "echo hello > .pre-checkpoint-done" "marker_write" "$TEST_ROOT/.pre-checkpoint-done"
assert_label "T51 echo redirect to .post-checkpoint-done" \
  "echo done > .post-checkpoint-done" "marker_write" "$TEST_ROOT/.post-checkpoint-done"
assert_label "T52 cat heredoc to marker" \
  "cat > .pre-checkpoint-done <<EOF
body
EOF" "marker_write" "$TEST_ROOT/.pre-checkpoint-done"
assert_label "T53 rm plan-approval-pending" \
  "rm .claude/.plan-approval-pending" "marker_write" "$TEST_ROOT/.claude/.plan-approval-pending"
assert_label "T54 rm -f marker" \
  "rm -f .pre-checkpoint-done" "marker_write" "$TEST_ROOT/.pre-checkpoint-done"
assert_label "T55 quoted body containing marker name" \
  "echo 'this is .pre-checkpoint-done text'" "read_only"

echo ""
echo "--- Unsafe complex ---"
assert_label "T60 bash -c" "bash -c 'rm -rf /'" "unsafe_complex"
assert_label "T61 sh -c" "sh -c 'echo'" "unsafe_complex"
assert_label "T62 eval" "eval echo foo" "unsafe_complex"
assert_label "T63 source file" "source ./script.sh" "unsafe_complex"
assert_label "T64 command substitution" 'echo $(date)' "unsafe_complex"
assert_label "T65 backtick" 'echo `date`' "unsafe_complex"
assert_label "T66 unbalanced single quote" "echo 'oops" "unsafe_complex"
assert_label "T67 unbalanced double quote" 'echo "oops' "unsafe_complex"
assert_label "T68 process substitution" "diff <(ls) <(ls -la)" "unsafe_complex"
assert_label "T69 gh api graphql" "gh api graphql -f query='mutation { x }'" "unsafe_complex"

echo ""
echo "--- Control-operator chain reduction ---"
# Most-restrictive wins. unsafe > push > shared > marker > read_only.
assert_label "T70 marker rm then push" "rm .plan-approval-pending && git push" "push_or_pr_create"
assert_label "T71 ls then rm marker" "ls && rm .plan-approval-pending" "marker_write"
assert_label "T72 ls then commit" "ls && git commit -m foo" "shared_write"
assert_label "T73 ls then bash -c" "ls && bash -c 'foo'" "unsafe_complex"
assert_label "T74 chained pipe" "ls | grep foo" "read_only"
assert_label "T75 chained pipe with write" "ls | tee output.txt" "shared_write"
assert_label "T76 quoted control op" "echo 'a && b'" "read_only"
assert_label "T77 quoted semicolon" "echo 'foo;bar'" "read_only"

echo ""
echo "--- shared_write defaults ---"
assert_label "T80 git commit" "git commit -m wip" "shared_write"
assert_label "T81 npm install" "npm install" "shared_write"
assert_label "T82 mkdir" "mkdir -p foo" "shared_write"
assert_label "T83 node em-store" "node scripts/em-store.mjs --project x" "shared_write"

echo ""
echo "--- Audit P1 (subagent finding 1): shell-keyword / group bypass ---"
# Without these, ( git push ), { git push; }, while/for/if-bodies all
# classified as shared_write because the first token wasn't 'git'/'gh'.
assert_label "T90 ( git push )" "( git push )" "unsafe_complex"
assert_label "T91 { git push; }" "{ git push; }" "unsafe_complex"
assert_label "T92 if then git push fi" "if true; then git push; fi" "unsafe_complex"
assert_label "T93 while do git push done" "while true; do git push; done" "unsafe_complex"
assert_label "T94 for do git push done" "for x in a b; do git push; done" "unsafe_complex"

echo ""
echo "--- Audit P1 (subagent finding 2): wrapper-utility bypass ---"
# env / command / sudo / xargs / nohup / time / timeout all execute the
# next argument. Pre-fix these were on the read_only allowlist (env,
# command, type) and let trailing git push slip through.
assert_label "T96 env git push" "env GIT_DIR=/tmp git push" "unsafe_complex"
assert_label "T97 command git push" "command git push" "unsafe_complex"
assert_label "T98 sudo git push" "sudo git push" "unsafe_complex"
assert_label "T99 xargs git push" "echo origin | xargs git push" "unsafe_complex"
assert_label "T100 nohup gh pr create" "nohup gh pr create --title x" "unsafe_complex"
assert_label "T101 timeout gh api" "timeout 30 gh api -X POST /foo" "unsafe_complex"

echo ""
echo "--- Codex PR-113 review finding 1: git management subcommands ---"
# branch/tag/remote/worktree/config: list forms read_only, write forms shared_write.
assert_label "T110 git branch (list)" "git branch" "read_only"
assert_label "T111 git branch -a (list)" "git branch -a" "read_only"
assert_label "T112 git branch foo (create)" "git branch new-topic" "shared_write"
assert_label "T113 git branch -D foo (delete)" "git branch -D old-topic" "shared_write"
assert_label "T114 git tag (list)" "git tag" "read_only"
assert_label "T115 git tag v1 (create)" "git tag v1.0" "shared_write"
assert_label "T116 git remote (list)" "git remote" "read_only"
assert_label "T117 git remote -v (list)" "git remote -v" "read_only"
assert_label "T118 git remote add (write)" "git remote add origin https://x" "shared_write"
assert_label "T119 git worktree list" "git worktree list" "read_only"
assert_label "T120 git worktree add (write)" "git worktree add /tmp/wt foo" "shared_write"
assert_label "T121 git config user.name (read)" "git config user.name" "read_only"
assert_label "T122 git config user.name x (write)" "git config user.name foo" "shared_write"
assert_label "T123 git config --unset (write)" "git config --unset user.name" "shared_write"

echo ""
echo "--- Codex PR-113 review finding 2: gh pr review ---"
# All gh pr review forms write a review state — even --comment posts a review.
assert_label "T130 gh pr review --approve" "gh pr review 5 --approve" "push_or_pr_create"
assert_label "T131 gh pr review --comment" "gh pr review 5 --comment --body x" "push_or_pr_create"
assert_label "T132 gh pr review --request-changes" "gh pr review 5 --request-changes" "push_or_pr_create"
assert_label "T133 gh pr review (no flags)" "gh pr review 5" "push_or_pr_create"

echo ""
echo "--- Commit 7 (#116): inverted-default git mgmt classifier ---"
# Read forms with positionals — previously misclassified shared_write.
assert_label "T140 git remote get-url" "git remote get-url origin" "read_only"
assert_label "T141 git remote show" "git remote show origin" "read_only"
assert_label "T142 git remote -v" "git remote -v" "read_only"
assert_label "T143 git tag -l pattern" "git tag -l 'v*'" "read_only"
assert_label "T144 git tag --list" "git tag --list" "read_only"
assert_label "T145 git tag --contains" "git tag --contains HEAD" "read_only"
assert_label "T146 git tag --merged" "git tag --merged main" "read_only"
assert_label "T147 git tag --sort= equals form" "git tag --sort=-version:refname" "read_only"
assert_label "T148 git tag -n5 glued count" "git tag -n5" "read_only"
assert_label "T149 git branch -a" "git branch -a" "read_only"
assert_label "T150 git branch -r" "git branch -r" "read_only"
assert_label "T151 git branch --contains" "git branch --contains HEAD" "read_only"
assert_label "T152 git branch --merged" "git branch --merged main" "read_only"
assert_label "T153 git branch --no-merged" "git branch --no-merged" "read_only"
assert_label "T154 git branch --points-at" "git branch --points-at HEAD" "read_only"
assert_label "T155 git branch --list pattern" "git branch --list 'feat/*'" "read_only"
assert_label "T156 git branch -l pattern" "git branch -l 'feat/*'" "read_only"
assert_label "T157 git branch --show-current" "git branch --show-current" "read_only"
assert_label "T158 git branch --column" "git branch --column" "read_only"
assert_label "T159 git branch --sort=" "git branch --sort=committerdate" "read_only"
assert_label "T160 git branch --format=" "git branch --format='%(refname)'" "read_only"
assert_label "T161 git config --list" "git config --list" "read_only"
assert_label "T162 git config --get-regexp" "git config --get-regexp '^user'" "read_only"
assert_label "T163 git config --global user.name read" "git config --global user.name" "read_only"
assert_label "T164 git config --file path key" "git config --file /tmp/c user.name" "read_only"
assert_label "T165 git worktree list" "git worktree list" "read_only"
assert_label "T166 git worktree --help" "git worktree --help" "read_only"

# Write forms still detected (regression).
assert_label "T170 git branch new-name (create)" "git branch new-topic" "shared_write"
assert_label "T171 git branch -D delete" "git branch -D old" "shared_write"
assert_label "T172 git branch --edit-description" "git branch --edit-description" "shared_write"
assert_label "T173 git branch --edit-description=foo" "git branch --edit-description=foo" "shared_write"
assert_label "T174 git branch --set-upstream-to=" "git branch --set-upstream-to=origin/main" "shared_write"
assert_label "T175 git branch --track" "git branch --track main origin" "shared_write"
assert_label "T176 git tag v1" "git tag v1.0" "shared_write"
assert_label "T177 git tag -d" "git tag -d v1.0" "shared_write"
assert_label "T178 git tag -f" "git tag -f v1.0" "shared_write"
assert_label "T179 git tag -s" "git tag -s v1.0" "shared_write"
assert_label "T180 git remote add" "git remote add origin https://x" "shared_write"
assert_label "T181 git remote rename" "git remote rename old new" "shared_write"
assert_label "T182 git remote set-url" "git remote set-url origin https://y" "shared_write"
assert_label "T183 git remote prune" "git remote prune origin" "shared_write"
assert_label "T184 git config user.name foo" "git config user.name foo" "shared_write"
assert_label "T185 git config --global user.name foo" "git config --global user.name foo" "shared_write"
assert_label "T186 git config --unset" "git config --unset user.name" "shared_write"
assert_label "T187 git config --add" "git config --add user.name foo" "shared_write"
assert_label "T188 git worktree add" "git worktree add /tmp/wt foo" "shared_write"
assert_label "T189 git worktree remove" "git worktree remove /tmp/wt" "shared_write"

# Reverse-flag-order (Plan-agent [P3] fuzz)
assert_label "T190 reversed: pattern then --list" "git branch 'feat/*' --list" "read_only"

# Subagent code review fixes for commit 7
# git config read-flags suppress positional-count rule
assert_label "T191 git config --get-color (3 positionals, read flag)" \
  "git config --get-color color.diff red" "read_only"
assert_label "T192 git config --get-colorbool" \
  "git config --get-colorbool color.ui true" "read_only"
assert_label "T193 git config --get-urlmatch" \
  "git config --get-urlmatch http http://example.com" "read_only"
# git config write-only flags previously missed
assert_label "T194 git config --remove-section" \
  "git config --remove-section section.name" "shared_write"
assert_label "T195 git config --rename-section" \
  "git config --rename-section old new" "shared_write"
# git worktree lock/unlock/prune restored as writes
assert_label "T196 git worktree lock" "git worktree lock /tmp/wt" "shared_write"
assert_label "T197 git worktree unlock" "git worktree unlock /tmp/wt" "shared_write"
assert_label "T198 git worktree prune" "git worktree prune" "shared_write"

# Codex PR #113 F2 (`...9796`/`...9cdd`): gh pr checkout/lock/unlock were
# wrongly bucketed read_only. checkout mutates local working tree;
# lock/unlock mutate shared GitHub PR state.
assert_label "T199 gh pr checkout" "gh pr checkout 113" "shared_write"
assert_label "T200 gh pr lock" "gh pr lock 113" "push_or_pr_create"
assert_label "T201 gh pr unlock" "gh pr unlock 113" "push_or_pr_create"
# Negative coverage — read-only PR commands must remain read_only after the
# above split, otherwise the fix would over-block legitimate inspection.
assert_label "T202 gh pr view (still read_only)" "gh pr view 113" "read_only"
assert_label "T203 gh pr list (still read_only)" "gh pr list" "read_only"
assert_label "T204 gh pr status (still read_only)" "gh pr status" "read_only"
assert_label "T205 gh pr diff (still read_only)" "gh pr diff 113" "read_only"
assert_label "T206 gh pr checks (still read_only)" "gh pr checks 113" "read_only"
# Subagent review on commit 8: same F2 pathology — gh pr update-branch
# updates the PR head on the remote, must be push_or_pr_create.
assert_label "T207 gh pr update-branch" "gh pr update-branch 113" "push_or_pr_create"
# Codex review on commit 8 (`...9fc4`): gh pr revert creates a revert PR —
# same shared-mutation class as gh pr create.
assert_label "T208 gh pr revert" "gh pr revert 113" "push_or_pr_create"

echo ""
echo "--- /dev/null sink (issue: 2>/dev/null false-positive) ---"
# Bug: any output redirect to a non-marker forced shared_write, even when
# the redirect target was /dev/null (the universal sink). This made every
# defensive `cmd 2>/dev/null` block under plan-gate, which was the dominant
# false-positive trigger for permission prompts during planning sessions.
# Fix: /dev/null targets bypass the has_nonmarker_redirect upgrade.
assert_label "T220 ls 2>/dev/null" "ls /tmp 2>/dev/null" "read_only"
assert_label "T221 ls >/dev/null" "ls /tmp >/dev/null" "read_only"
assert_label "T222 ls &>/dev/null" "ls /tmp &>/dev/null" "read_only"
assert_label "T223 cat 2>/dev/null" "cat /etc/hosts 2>/dev/null" "read_only"
assert_label "T224 git status 2>/dev/null" "git status 2>/dev/null" "read_only"
assert_label "T225 grep with stderr sink" "grep -r foo . 2>/dev/null" "read_only"
# Compound: each segment classified independently, /dev/null exception applies.
assert_label "T226 compound /dev/null" \
  "ls /tmp 2>/dev/null; ls /var 2>/dev/null" "read_only"
assert_label "T227 compound mixed sinks" \
  "git status 2>/dev/null; ls /tmp 2>/dev/null" "read_only"
# Negative: real writes (non-/dev/null targets) still upgrade to shared_write.
assert_label "T228 echo to real file" "echo hello > /tmp/foo" "shared_write"
assert_label "T229 ls to real file" "ls > /tmp/listing.txt" "shared_write"
# Most-restrictive: /dev/null segment + real-write segment → shared_write.
assert_label "T230 dev-null then write" \
  "git status > /dev/null; echo x > /tmp/foo" "shared_write"
# Most-restrictive: /dev/null read + push still pushes.
assert_label "T231 dev-null then push" \
  "git status 2>/dev/null && git push" "push_or_pr_create"
# Marker-write redirect not masked by a sibling /dev/null redirect on the
# same command. The marker check fires regardless of redirect order.
assert_label "T232 write to marker + dev-null" \
  "echo ok > .plan-approval-pending 2>/dev/null" "marker_write"
assert_label "T233 dev-null + write to marker" \
  "echo ok 2>/dev/null > .plan-approval-pending" "marker_write"
# unsafe_complex still wins when a sink redirect is present.
assert_label "T234 unsafe + dev-null" "eval foo 2>/dev/null" "unsafe_complex"
assert_label "T235 backticks + dev-null" "echo \`whoami\` 2>/dev/null" "unsafe_complex"
# Other benign device sinks — same exemption applies to read-only commands.
assert_label "T236 ls >/dev/stdout" "ls /tmp >/dev/stdout" "read_only"
assert_label "T237 ls 2>/dev/stderr" "ls /tmp 2>/dev/stderr" "read_only"
assert_label "T238 cat >/dev/tty" "cat /etc/hosts >/dev/tty" "read_only"
assert_label "T239 ls >/dev/zero" "ls /tmp >/dev/zero" "read_only"
# Negative: /dev/null with similar but different path is still a real write.
assert_label "T240 dev-null look-alike" "ls /tmp >/dev/null2" "shared_write"
assert_label "T241 dev-not-null" "ls /tmp >/devnull" "shared_write"

echo ""
echo "--- classify_path ---"
assert_path() {
  local desc="$1"
  local path="$2"
  local expected="$3"
  local result label
  result="$(classify_path "$path" "$TEST_ROOT")"
  label="${result%%	*}"
  if [ "$label" = "$expected" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc — got $label, expected $expected"
    failed=$((failed+1))
  fi
}
assert_path "P01 marker path" ".pre-checkpoint-done" "marker_write"
assert_path "P02 plan-approval-pending" ".claude/.plan-approval-pending" "marker_write"
assert_path "P03 ordinary file" "src/foo.mjs" "shared_write"
assert_path "P04 absolute marker" "$TEST_ROOT/.claude/.post-checkpoint-done" "marker_write"

# ---------------------------------------------------------------------------
# Layer D pre-flight classifier siblings — Q-series tests.
# Codex consensus chain: r1 ACCEPT-with-FU `...ed24` → r5 ACCEPT `...dbf6`.
# ---------------------------------------------------------------------------
echo ""
echo "--- classify_preflight_command ---"
assert_preflight_cmd() {
  local desc="$1"
  local cmd="$2"
  local expected_class="$3"
  local result class
  result="$(classify_preflight_command "$cmd" "$TEST_ROOT")"
  class="${result%%	*}"
  if [ "$class" = "$expected_class" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc — got $class, expected $expected_class"
    failed=$((failed+1))
  fi
}
assert_preflight_cmd "Q01 codex exec" 'codex exec "review"' "codex-review-handoff"
assert_preflight_cmd "Q02 codex review" 'codex review --plan' "codex-review-handoff"
assert_preflight_cmd "Q03 sudo wrap codex" 'sudo codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q04 env wrap codex" 'env A=1 codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q05 timeout wrap codex" 'timeout 60s codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q06 nohup wrap codex" 'nohup codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q07 multi-wrap" 'env X=y timeout 30s sudo codex review' "codex-review-handoff"
assert_preflight_cmd "Q08 quoted-string echo no-fp" 'echo "codex exec foo"' "none"
assert_preflight_cmd "Q09 bash -c codex" 'bash -c "codex exec foo"' "codex-review-handoff"
assert_preflight_cmd "Q10 sh -c codex" 'sh -c "codex review --bar"' "codex-review-handoff"
assert_preflight_cmd "Q11 zsh -c em-store" 'zsh -c "em-store --tag codex-review --body x"' "codex-review-handoff"
assert_preflight_cmd "Q11a bash -lc codex" 'bash -lc "codex exec foo"' "codex-review-handoff"
assert_preflight_cmd "Q11b bash -il then -c" 'bash -il -c "codex review"' "codex-review-handoff"
assert_preflight_cmd "Q11c bash -ci codex" 'bash -ci "codex exec"' "codex-review-handoff"
assert_preflight_cmd "Q11d bash --color" 'bash --color=auto -c "ls"' "none"
assert_preflight_cmd "Q12 node em-store w/codex tag" \
  'node scripts/em-store.mjs --tag codex-review --summary x' "codex-review-handoff"
assert_preflight_cmd "Q13 node em-store no review tag" \
  'node scripts/em-store.mjs --tag random --summary x' "none"
assert_preflight_cmd "Q14 node em-revise w/code-review tag" \
  'node scripts/em-revise.mjs --tag code-review-round-2 --body y' "codex-review-handoff"
assert_preflight_cmd "Q15 node em-violation w/review-bp tag" \
  'node scripts/em-violation.mjs --tags codex,review-pattern' "codex-review-handoff"
assert_preflight_cmd "Q16 second-opinion harness" \
  'node scripts/second-opinion.mjs request --provider codex --dispatch' "codex-review-handoff"
assert_preflight_cmd "Q17 bare em-store w/review tag" \
  'em-store --tag plan-review --body z' "codex-review-handoff"
assert_preflight_cmd "Q18 bare em-store no review tag" \
  'em-store --tag random --body z' "none"
assert_preflight_cmd "Q19 ls" 'ls -la' "none"
assert_preflight_cmd "Q20 git status" 'git status' "none"
assert_preflight_cmd "Q21 npx em-store w/codex tag" \
  'npx em-store --tag codex-review --body x' "codex-review-handoff"
assert_preflight_cmd "Q22 absolute path em-store" \
  'node /abs/repo/scripts/em-store.mjs --summary "codex review request"' "codex-review-handoff"
assert_preflight_cmd "Q23 unsafe + codex literal" \
  'eval $(cat /etc/x); codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q24 unsafe no codex literal" \
  'eval $(cat /etc/x); ls -la' "none"
assert_preflight_cmd "Q25 --tags=codex equals form" \
  'em-store --tags=codex-reply,round-3 --body z' "codex-review-handoff"
# Q26-Q30: bash chain bypass class (codex PR-level review 2026-05-12 finding)
assert_preflight_cmd "Q26 ; chain after benign verb" \
  'echo ok; codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q27 && chain" \
  'true && codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q28 || chain" \
  'false || codex review --plan' "codex-review-handoff"
assert_preflight_cmd "Q29 subshell parens" \
  '( codex exec foo )' "codex-review-handoff"
assert_preflight_cmd "Q30 chain with em-store" \
  'cd /tmp && node scripts/em-store.mjs --tag codex-review --body x' "codex-review-handoff"
assert_preflight_cmd "Q31 multi-segment with chain at end" \
  'ls; echo ok && codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q32 benign chain — no codex" \
  'echo ok; ls; pwd' "none"
# Q33-Q40: wrapper option-argument bypass class (codex round 2 finding `...cbc2`)
assert_preflight_cmd "Q33 sudo -u root" \
  'sudo -u root codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q34 sudo -g group" \
  'sudo -g admin codex review' "codex-review-handoff"
assert_preflight_cmd "Q35 timeout -k 5s 30s" \
  'timeout -k 5s 30s codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q36 timeout -s SIGTERM 30s" \
  'timeout -s SIGTERM 30s codex review' "codex-review-handoff"
assert_preflight_cmd "Q37 nice -n 10" \
  'nice -n 10 codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q38 ionice -c 3" \
  'ionice -c 3 codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q39 env -u VAR" \
  'env -u BAD codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q40 stdbuf -o L" \
  'stdbuf -o L codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q41 stacked wrappers" \
  'sudo -u root timeout -k 5s 30s nice -n 10 codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q42 sudo --user=root long-opt-equals" \
  'sudo --user=root codex exec foo' "codex-review-handoff"

echo ""
echo "--- classify_preflight_path ---"
assert_preflight_path() {
  local desc="$1"
  local p="$2"
  local expected_class="$3"
  local result class
  result="$(classify_preflight_path "$p" "$TEST_ROOT")"
  class="${result%%	*}"
  if [ "$class" = "$expected_class" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc — got $class, expected $expected_class"
    failed=$((failed+1))
  fi
}
assert_preflight_path "QP01 MEMORY.md" "/abs/repo/MEMORY.md" "rule-bearing-file-edit"
assert_preflight_path "QP02 feedback_*.md" "/abs/repo/feedback_x.md" "rule-bearing-file-edit"
assert_preflight_path "QP03 reference_*.md" "/abs/repo/reference_y.md" "rule-bearing-file-edit"
assert_preflight_path "QP04 bundles" "/abs/repo/bundles/codex-channel.md" "rule-bearing-file-edit"
assert_preflight_path "QP05 hooks" "/abs/repo/.claude/hooks/foo.sh" "rule-bearing-file-edit"
assert_preflight_path "QP06 settings.json" "/abs/repo/.claude/settings.json" "rule-bearing-file-edit"
assert_preflight_path "QP07 settings.local.json" "/abs/repo/.claude/settings.local.json" "rule-bearing-file-edit"
assert_preflight_path "QP08 RFC dir" "/abs/repo/docs/rfcs/RFC-007-foo.md" "rule-bearing-file-edit"
assert_preflight_path "QP09 episode file" "/abs/repo/.episodic-memory/episodes/x.md" "rule-bearing-file-edit"
assert_preflight_path "QP10 random script" "/abs/repo/scripts/em-search.mjs" "none"
assert_preflight_path "QP11 random source" "/abs/repo/src/foo.mjs" "none"
assert_preflight_path "QP12 README" "/abs/repo/README.md" "none"

echo ""
echo "--- classify_preflight_tool ---"
assert_preflight_tool() {
  local desc="$1"
  local tool_name="$2"
  local tool_input_json="$3"
  local expected_class="$4"
  local result class
  result="$(classify_preflight_tool "$tool_name" "$tool_input_json" "$TEST_ROOT")"
  class="${result%%	*}"
  if [ "$class" = "$expected_class" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc — got $class, expected $expected_class"
    failed=$((failed+1))
  fi
}
assert_preflight_tool "QT01 Bash codex" "Bash" '{"command":"codex exec foo"}' "codex-review-handoff"
assert_preflight_tool "QT02 Bash ls" "Bash" '{"command":"ls -la"}' "none"
assert_preflight_tool "QT03 Bash empty" "Bash" '{"command":""}' "none"
assert_preflight_tool "QT04 Agent codex-rescue" "Agent" '{"subagent_type":"codex:codex-rescue"}' "codex-review-handoff"
assert_preflight_tool "QT05 Agent neg-scenario" "Agent" '{"subagent_type":"negative-scenario-reviewer"}' "codex-review-handoff"
assert_preflight_tool "QT06 Agent generic" "Agent" '{"subagent_type":"general-purpose"}' "none"
assert_preflight_tool "QT07 Task variant" "Task" '{"subagent_type":"codex:something"}' "codex-review-handoff"
assert_preflight_tool "QT08 Write feedback" "Write" '{"file_path":"/abs/repo/feedback_x.md"}' "rule-bearing-file-edit"
assert_preflight_tool "QT09 Edit MEMORY.md" "Edit" '{"file_path":"/abs/repo/MEMORY.md"}' "rule-bearing-file-edit"
assert_preflight_tool "QT10 MultiEdit hook" "MultiEdit" '{"file_path":"/abs/repo/.claude/hooks/foo.sh"}' "rule-bearing-file-edit"
assert_preflight_tool "QT11 Write src file" "Write" '{"file_path":"/abs/repo/src/foo.mjs"}' "none"
assert_preflight_tool "QT12 Read ungated" "Read" '{"file_path":"/anything"}' "none"
assert_preflight_tool "QT13 Grep ungated" "Grep" '{"pattern":"foo"}' "none"

echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="

exit $((failed > 0 ? 1 : 0))
