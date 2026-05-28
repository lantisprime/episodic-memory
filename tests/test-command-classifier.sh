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
assert_label "T16b node em-rebuild-index" "node scripts/em-rebuild-index.mjs --scope all" "read_only"
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
assert_label "T41 git commit -m push" "git commit -m push" "nonsrc_write"
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
# Plan-v2 I10 (audit F1 same-class). PR #240 omitted .preflight-done from the
# rm-marker class; plan-v2 adds it + the new session-namespaced last-prompt
# files. Without these, `rm .checkpoints/.preflight-done` bypasses the gate.
assert_label "T54a rm preflight-done (PR240 same-class gap)" \
  "rm .checkpoints/.preflight-done" "marker_write" "$TEST_ROOT/.checkpoints/.preflight-done"
assert_label "T54b rm last-user-prompt session-namespaced" \
  "rm .checkpoints/.last-user-prompt.abc-123.json" "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.abc-123.json"
assert_label "T54c rm -rf last-user-prompt UUID-form" \
  "rm -rf .checkpoints/.last-user-prompt.1d6761c2-eaa2-43f7-a287-9dc2f301c9db.json" \
  "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.1d6761c2-eaa2-43f7-a287-9dc2f301c9db.json"
# P2-2 (code-review FU): legacy non-namespaced .last-user-prompt.json also
# in rm-marker class. Previously omitted from the C4 fix — Bash rm of the
# legacy basename would have classified as shared_write, leaving the gate's
# direct-Write deny (which DOES cover legacy) inconsistent with Bash rm.
assert_label "T54c2 rm legacy non-namespaced last-user-prompt.json" \
  "rm .checkpoints/.last-user-prompt.json" "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.json"
assert_label "T54c3 tee legacy non-namespaced last-user-prompt.json" \
  "tee .checkpoints/.last-user-prompt.json" "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.json"
# Codex round-1 F1 on PR #246: the `> redirect` handler was missing 4 of 6
# checkpoint markers AND the entire last-user-prompt family. Without these,
# `printf x > .checkpoints/.last-user-prompt.<sid>.json` bypasses the
# marker_write class entirely.
assert_label "T54d > redirect to .preflight-done → marker_write" \
  "printf x > .checkpoints/.preflight-done" "marker_write" "$TEST_ROOT/.checkpoints/.preflight-done"
assert_label "T54e > redirect to .last-user-prompt session-namespaced → marker_write" \
  "printf x > .checkpoints/.last-user-prompt.spoof.json" "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.spoof.json"
assert_label "T54f >> append redirect to .last-user-prompt namespaced → marker_write" \
  "echo x >> .checkpoints/.last-user-prompt.uuid-1234.json" "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.uuid-1234.json"
assert_label "T54g > redirect to legacy .last-user-prompt.json → marker_write" \
  "printf x > .checkpoints/.last-user-prompt.json" "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.json"
assert_label "T54h > redirect to .checkpoint-required → marker_write" \
  "printf x > .checkpoints/.checkpoint-required" "marker_write" "$TEST_ROOT/.checkpoints/.checkpoint-required"
assert_label "T54i > redirect to .post-checkpoint-required → marker_write" \
  "printf x > .checkpoints/.post-checkpoint-required" "marker_write" "$TEST_ROOT/.checkpoints/.post-checkpoint-required"
# Codex round-2 FU on PR #246: tee was missing checkpoint-required +
# post-checkpoint-required (latent pre-existing gap parallel to the
# C4 rm-class fix); regression test the closure.
assert_label "T54j tee .checkpoint-required → marker_write" \
  "tee .checkpoints/.checkpoint-required" "marker_write" "$TEST_ROOT/.checkpoints/.checkpoint-required"
assert_label "T54k tee .post-checkpoint-required → marker_write" \
  "tee .checkpoints/.post-checkpoint-required" "marker_write" "$TEST_ROOT/.checkpoints/.post-checkpoint-required"
assert_label "T54d tee writing to preflight-done" \
  "tee .checkpoints/.preflight-done" "marker_write" "$TEST_ROOT/.checkpoints/.preflight-done"
assert_label "T54e tee writing to last-user-prompt" \
  "tee .checkpoints/.last-user-prompt.sess.json" "marker_write" "$TEST_ROOT/.checkpoints/.last-user-prompt.sess.json"
# Negative: rm of a similarly-named file that's NOT in the class should NOT trip.
assert_label "T54f rm last-user-prompt without .json suffix → not marker" \
  "rm .checkpoints/.last-user-prompt.notjson" "shared_write"
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
assert_label "T72 ls then commit" "ls && git commit -m foo" "nonsrc_write"
assert_label "T73 ls then bash -c" "ls && bash -c 'foo'" "unsafe_complex"
assert_label "T74 chained pipe" "ls | grep foo" "read_only"
assert_label "T75 chained pipe with write" "ls | tee output.txt" "shared_write"
assert_label "T76 quoted control op" "echo 'a && b'" "read_only"
assert_label "T77 quoted semicolon" "echo 'foo;bar'" "read_only"

echo ""
echo "--- nonsrc_write (PR-B2 #351: reclassified from shared_write — non-source writes) ---"
assert_label "T80 git commit" "git commit -m wip" "nonsrc_write"
assert_label "T81 npm install" "npm install" "nonsrc_write"
assert_label "T82 mkdir" "mkdir -p foo" "nonsrc_write"
assert_label "T83 node em-store" "node scripts/em-store.mjs --project x" "nonsrc_write"
# install.mjs deploy tool → nonsrc_write (writes ~/.claude, ~/.episodic-memory, installed
# artifacts; never repo source). Prevents a first-run misclassification auto-persisting a
# stale shared_write Tier-0 override (2026-05-26).
assert_label "T83b node install.mjs --install-hooks" "node install.mjs --tool claude-code --install-hooks --install-hooks-force" "nonsrc_write"

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
# branch/tag/remote/worktree/config: list forms read_only. PR-B2 (#351): write
# forms are .git ref/config metadata → nonsrc_write (were shared_write).
assert_label "T110 git branch (list)" "git branch" "read_only"
assert_label "T111 git branch -a (list)" "git branch -a" "read_only"
assert_label "T112 git branch foo (create)" "git branch new-topic" "nonsrc_write"
assert_label "T113 git branch -D foo (delete)" "git branch -D old-topic" "nonsrc_write"
assert_label "T114 git tag (list)" "git tag" "read_only"
assert_label "T115 git tag v1 (create)" "git tag v1.0" "nonsrc_write"
assert_label "T116 git remote (list)" "git remote" "read_only"
assert_label "T117 git remote -v (list)" "git remote -v" "read_only"
assert_label "T118 git remote add (write)" "git remote add origin https://x" "nonsrc_write"
assert_label "T119 git worktree list" "git worktree list" "read_only"
assert_label "T120 git worktree add (write)" "git worktree add /tmp/wt foo" "nonsrc_write"
assert_label "T121 git config user.name (read)" "git config user.name" "read_only"
assert_label "T122 git config user.name x (write)" "git config user.name foo" "nonsrc_write"
assert_label "T123 git config --unset (write)" "git config --unset user.name" "nonsrc_write"

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

# Write forms still DETECTED as writes (regression). PR-B2 (#351): these are
# .git ref/config/worktree metadata, not working-tree source → nonsrc_write
# (were shared_write). The detection (not read_only) is what the regression
# guards; the write CLASS changed from arming to free.
assert_label "T170 git branch new-name (create)" "git branch new-topic" "nonsrc_write"
assert_label "T171 git branch -D delete" "git branch -D old" "nonsrc_write"
assert_label "T172 git branch --edit-description" "git branch --edit-description" "nonsrc_write"
assert_label "T173 git branch --edit-description=foo" "git branch --edit-description=foo" "nonsrc_write"
assert_label "T174 git branch --set-upstream-to=" "git branch --set-upstream-to=origin/main" "nonsrc_write"
assert_label "T175 git branch --track" "git branch --track main origin" "nonsrc_write"
assert_label "T176 git tag v1" "git tag v1.0" "nonsrc_write"
assert_label "T177 git tag -d" "git tag -d v1.0" "nonsrc_write"
assert_label "T178 git tag -f" "git tag -f v1.0" "nonsrc_write"
assert_label "T179 git tag -s" "git tag -s v1.0" "nonsrc_write"
assert_label "T180 git remote add" "git remote add origin https://x" "nonsrc_write"
assert_label "T181 git remote rename" "git remote rename old new" "nonsrc_write"
assert_label "T182 git remote set-url" "git remote set-url origin https://y" "nonsrc_write"
assert_label "T183 git remote prune" "git remote prune origin" "nonsrc_write"
assert_label "T184 git config user.name foo" "git config user.name foo" "nonsrc_write"
assert_label "T185 git config --global user.name foo" "git config --global user.name foo" "nonsrc_write"
assert_label "T186 git config --unset" "git config --unset user.name" "nonsrc_write"
assert_label "T187 git config --add" "git config --add user.name foo" "nonsrc_write"
assert_label "T188 git worktree add" "git worktree add /tmp/wt foo" "nonsrc_write"
assert_label "T189 git worktree remove" "git worktree remove /tmp/wt" "nonsrc_write"

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
  "git config --remove-section section.name" "nonsrc_write"
assert_label "T195 git config --rename-section" \
  "git config --rename-section old new" "nonsrc_write"
# git worktree lock/unlock/prune still detected as writes (PR-B2: .git metadata → nonsrc_write).
assert_label "T196 git worktree lock" "git worktree lock /tmp/wt" "nonsrc_write"
assert_label "T197 git worktree unlock" "git worktree unlock /tmp/wt" "nonsrc_write"
assert_label "T198 git worktree prune" "git worktree prune" "nonsrc_write"

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
echo "--- fd-redirect tokenizer (operand-completeness rule) ---"
# Bug: tokenizer split `cmd 2>&1` into `T cmd, T 2, O >, O &, T 1`. The
# stray `O &` triggered a segment break in classify_command (the `&`
# control op set), and the bare `T 1` second segment classified as
# `shared_write`. So every read-only command with a stderr→stdout merge
# (the standard `2>&1 | head` idiom) was misclassified as a write and
# blocked under checkpoint-gate / plan-gate. R5 fix: digit-fd prefix
# consumption + `_parse_redirect_spec` operand-completeness rule —
# fd-dup only when the complete operand word is exactly `-` or exactly
# `[0-9]+`. `>&2foo` etc. correctly stay as file redirects.
#
# Reference: codex review chain R1-R5, accepted at R5 with FU on
# `&>`/`&>>` parser routing (this implementation).

# fd-dup forms (no file write, segment is read-only base command)
assert_label "FD01 cmd 2>&1" "ls -la 2>&1" "read_only"
assert_label "FD02 cmd 2>&1 | pipe" "ls -la 2>&1 | head -40" "read_only"
assert_label "FD03 cmd >&2" "echo hi >&2" "read_only"
assert_label "FD04 cmd 1>&2" "ls 1>&2" "read_only"
assert_label "FD05 cmd 3>&4" "ls 3>&4" "read_only"
assert_label "FD06 cmd 2>&-" "ls 2>&-" "read_only"
assert_label "FD07 cmd >&-" "ls >&-" "read_only"
assert_label "FD08 cmd >& 2 (ws)" "ls >& 2" "read_only"
assert_label "FD09 cmd 2>& 1 (ws)" "ls 2>& 1" "read_only"
assert_label "FD10 cmd >& - (ws)" "ls >& -" "read_only"
# Original bug repro from session 2026-05-18
assert_label "FD11 em-search 2>&1 piped" \
  "node scripts/em-search.mjs --tag x 2>&1 | head" "read_only"
assert_label "FD12 find ... 2>&1" \
  "find .checkpoints -maxdepth 2 -type f 2>&1" "read_only"

# File-redirect forms via `>&` (operand-completeness: not all-digits, not `-`)
# Codex R4 finding: `>&2foo` is `./2foo`, not fd-dup to 2.
assert_label "FD20 >&2foo (digit-prefixed file)" "echo hi >&2foo" "shared_write"
assert_label "FD21 >&foo (non-digit file)" "ls >&foo" "shared_write"
assert_label "FD22 >& foo (ws + non-digit)" "ls >& foo" "shared_write"
assert_label "FD23 >& \"out.txt\" (quoted)" "ls >& \"out.txt\"" "shared_write"
assert_label "FD24 >& 'out.txt' (single-quoted)" "ls >& 'out.txt'" "shared_write"
assert_label "FD25 >&1- (digits+dash)" "ls >&1-" "shared_write"
assert_label "FD26 >&-1 (dash+digits)" "ls >&-1" "shared_write"
# Codex PR #320 R1 P2: leading-dash redirect operands MUST NOT leak
# `basename: illegal option` to stderr. Hook caller (checkpoint-gate.sh)
# emits the block JSON on stdout; any classifier stderr pollutes the
# hook output. Use `--` separator on basename calls for redirect targets.
_assert_stderr_empty() {
  local desc="$1" cmd="$2"
  local err
  err="$(classify_command "$cmd" "$TEST_ROOT" 2>&1 >/dev/null)"
  if [ -z "$err" ]; then
    echo "  ✓ $desc"
    passed=$((passed+1))
  else
    echo "  ✗ $desc — stderr leaked: $err"
    failed=$((failed+1))
  fi
}
_assert_stderr_empty "FD26a >&-1 emits no stderr" "ls >&-1"
_assert_stderr_empty "FD26b >& -1 (ws) emits no stderr" "ls >& -1"
_assert_stderr_empty "FD26c >&-foo emits no stderr" "ls >&-foo"
_assert_stderr_empty "FD26d 2>-flagy (leading dash file) emits no stderr" \
  "ls 2>-flagy"

# Plain file redirects with explicit fd-prefix
assert_label "FD30 cmd 2>file" "ls 2>file" "shared_write"
assert_label "FD31 cmd 2>>file (append)" "ls 2>>file" "shared_write"
assert_label "FD32 cmd 1>file" "ls 1>file" "shared_write"
assert_label "FD33 cmd 3>file" "ls 3>file" "shared_write"

# Both-fds-to-file
assert_label "FD40 &>out" "ls &>out" "shared_write"
assert_label "FD41 &>>out (append)" "ls &>>out" "shared_write"
# /dev/null sink with both-fds-append
assert_label "FD42 &>>/dev/null" "ls &>>/dev/null" "read_only"

# `<&` symmetric (input fd-dup vs input-from-file — neither writes)
assert_label "FD50 cmd <&5" "cat <&5" "read_only"
assert_label "FD51 cmd <&-" "cat <&-" "read_only"
assert_label "FD52 cmd <&file" "cat <&file" "read_only"
assert_label "FD53 cmd <&5foo" "cat <&5foo" "read_only"

# Marker-write detection still fires through `>&` parser when target is marker
assert_label "FD60 >& marker (no space)" \
  "echo hi >&.plan-approval-pending" "marker_write"
assert_label "FD61 &>>marker" "echo hi &>>.plan-approval-pending" "marker_write"

# fd-dup doesn't downgrade a real write on the same command
assert_label "FD70 write + fd-dup" "echo hi > /tmp/out 2>&1" "shared_write"
# Most-restrictive across segments: push wins over fd-dup-read
assert_label "FD71 fd-dup then push" "git status 2>&1 && git push" "push_or_pr_create"
# Compound with fd-dup on each segment
assert_label "FD72 compound 2>&1 both" \
  "ls 2>&1; cat /etc/hosts 2>&1" "read_only"

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
assert_preflight_cmd "Q22 absolute path em-store free-text summary no-fp (#285)" \
  'node /abs/repo/scripts/em-store.mjs --summary "codex review request"' "none"
assert_preflight_cmd "Q22a absolute path em-store explicit review tag" \
  'node /abs/repo/scripts/em-store.mjs --tags codex-review --summary "codex review request"' "codex-review-handoff"
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
# Q43-Q50: long-opt --key value form (codex round 3 finding `...bd73`)
assert_preflight_cmd "Q43 sudo --user root space" \
  'sudo --user root codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q44 timeout --kill-after 5s 30s" \
  'timeout --kill-after 5s 30s codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q45 stdbuf --output L" \
  'stdbuf --output L codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q46 env --unset BAD" \
  'env --unset BAD codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q47 nice --adjustment 10" \
  'nice --adjustment 10 codex exec foo' "codex-review-handoff"
# Q48-Q55: modern command runners (codex round 3 finding `...bd73`)
assert_preflight_cmd "Q48 systemd-run --user --scope" \
  'systemd-run --user --scope codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q49 systemd-run -u name" \
  'systemd-run -u myunit codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q50 flatpak-spawn --host" \
  'flatpak-spawn --host codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q51 uv run" \
  'uv run codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q52 poetry run" \
  'poetry run codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q53 pixi run" \
  'pixi run codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q54 nix develop -c" \
  'nix develop -c codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q55 nix shell -c" \
  'nix shell -c codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q56 direnv exec ." \
  'direnv exec . codex exec foo' "codex-review-handoff"
# Q57: stacked runner + classic wrapper
assert_preflight_cmd "Q57 sudo + uv run codex" \
  'sudo -u root uv run codex exec foo' "codex-review-handoff"
# Q58-Q62: systemd-run boolean flags (codex round 4 finding `...fa74`)
assert_preflight_cmd "Q58 systemd-run --user only" \
  'systemd-run --user codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q59 systemd-run --scope --user" \
  'systemd-run --scope --user codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q60 systemd-run --pty --user" \
  'systemd-run --pty --user codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q61 systemd-run with arg-taking" \
  'systemd-run --unit myapp --user codex exec foo' "codex-review-handoff"
assert_preflight_cmd "Q62 systemd-run -G boolean" \
  'systemd-run -G codex exec foo' "codex-review-handoff"
# Q63-Q65: env -S/--split-string command-vector recursion (codex r5 finding `...729a`)
assert_preflight_cmd "Q63 env -S codex" \
  'env -S "codex exec foo"' "codex-review-handoff"
assert_preflight_cmd "Q64 env --split-string codex" \
  'env --split-string "codex review --plan"' "codex-review-handoff"
assert_preflight_cmd "Q65 env -vS codex" \
  'env -vS "codex exec foo"' "codex-review-handoff"
assert_preflight_cmd "Q66 env -S non-codex" \
  'env -S "ls -la"' "none"
assert_preflight_cmd "Q67 env --split-string=codex equals" \
  'env --split-string=codex\ exec\ foo true' "codex-review-handoff"

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
assert_preflight_tool "QT05 Agent neg-scenario-reviewer (gated)" "Agent" '{"subagent_type":"negative-scenario-reviewer"}' "codex-review-handoff"
# Plan-v2 I11 (audit F7): the planner subagent is the bootstrap workaround
# for plan-time review when the harness channel is blocked (workplan v49).
# It must NOT be gated — it runs BEFORE plans exist, so requiring a
# post-plan marker creates an interlock (#243). Reviewer-class subagents
# remain gated.
assert_preflight_tool "QT05a Agent neg-scenario-planner (bootstrap exempt)" "Agent" '{"subagent_type":"negative-scenario-planner"}' "none"
assert_preflight_tool "QT05b Task neg-scenario-planner (bootstrap exempt)" "Task" '{"subagent_type":"negative-scenario-planner"}' "none"
assert_preflight_tool "QT06 Agent generic" "Agent" '{"subagent_type":"general-purpose"}' "none"
assert_preflight_tool "QT07 Task variant" "Task" '{"subagent_type":"codex:something"}' "codex-review-handoff"
assert_preflight_tool "QT08 Write feedback" "Write" '{"file_path":"/abs/repo/feedback_x.md"}' "rule-bearing-file-edit"
assert_preflight_tool "QT09 Edit MEMORY.md" "Edit" '{"file_path":"/abs/repo/MEMORY.md"}' "rule-bearing-file-edit"
assert_preflight_tool "QT10 MultiEdit hook" "MultiEdit" '{"file_path":"/abs/repo/.claude/hooks/foo.sh"}' "rule-bearing-file-edit"
assert_preflight_tool "QT11 Write src file" "Write" '{"file_path":"/abs/repo/src/foo.mjs"}' "none"
assert_preflight_tool "QT12 Read ungated" "Read" '{"file_path":"/anything"}' "none"
assert_preflight_tool "QT13 Grep ungated" "Grep" '{"pattern":"foo"}' "none"

echo ""
echo "--- --help / --version carve-out (smart-arming companion) ---"
# CLI convention: help/version flags are universally side-effect-free.
# Carve-out at command-classifier.sh interpreter case-arm classifies
# any `node|python|...` invocation with ONLY help/version flags as read_only,
# regardless of which script is being invoked.

# Allowed (read_only): interpreter + script + only help/version flags
assert_label "HV01 node --help" "node /tmp/foo.mjs --help" "read_only"
assert_label "HV02 node --version" "node /tmp/foo.mjs --version" "read_only"
assert_label "HV03 node -h" "node /tmp/foo.mjs -h" "read_only"
assert_label "HV04 node -V" "node /tmp/foo.mjs -V" "read_only"
assert_label "HV05 python3 --help" "python3 /tmp/script.py --help" "read_only"
assert_label "HV06 python script --version" "python /tmp/x.py --version" "read_only"
assert_label "HV07 ruby --help" "ruby /tmp/x.rb --help" "read_only"
assert_label "HV08 perl -V" "perl /tmp/x.pl -V" "read_only"
assert_label "HV09 --help=topic" "node /tmp/foo.mjs --help=usage" "read_only"
assert_label "HV10 multiple help flags" "node /tmp/foo.mjs --help -h" "read_only"

# Carve-out wins over em-* write case-arms (user's exact frustration case)
assert_label "HV11 node em-store.mjs --help" "node em-store.mjs --help" "read_only"
assert_label "HV12 node em-revise.mjs --version" "node em-revise.mjs --version" "read_only"
assert_label "HV13 node second-opinion.mjs --help" "node /Users/me/scripts/second-opinion.mjs --help" "read_only"

# NOT allowed: missing help/version (bare invocation)
assert_label "HV20 bare node script (no flags)" "node /tmp/foo.mjs" "shared_write"
assert_label "HV21 node script with non-help arg" "node /tmp/foo.mjs --do-stuff" "shared_write"
assert_label "HV22 mixed --help + other arg" "node /tmp/foo.mjs --help foo" "shared_write"
assert_label "HV23 -h with arg" "node /tmp/foo.mjs -h some-topic" "shared_write"

# NOT allowed: redirect demotes to fallthrough (existing has_nonmarker_redirect rule)
assert_label "HV30 node --help with redirect" "node /tmp/foo.mjs --help > /tmp/out.txt" "shared_write"
assert_label "HV31 node --version | head (pipe is not a redirect)" "node /tmp/foo.mjs --version | head" "read_only"

# Env-prefix demotes: carve-out's env_prefix_count check ensures
# `FOO=bar node X --help` does NOT ride the read_only carve-out.
# Falls through to interpreter classifier → LLM dispatch (no decision in
# tests; no marker, no direct-fetch transport) → Tier 1 default
# `interpreter_other` (shared_write). Net: env-prefix attempts to bypass
# via --help still get gated. The security invariant holds: env-prefix
# never rides the read_only allowlist (PR #271 attack class).
assert_label "HV40 env-prefix node --help (carve-out skipped, falls to shared_write)" \
  "FOO=bar node /tmp/foo.mjs --help" "shared_write"

echo ""
echo "--- PR-B2 (#351): git total-function split (§14-F1) ---"
# nonsrc_write side: .git / index / object / ref ops (FREE — never arm).
assert_label "B2-G01 git commit" "git commit -m x" "nonsrc_write"
assert_label "B2-G02 git add" "git add ." "nonsrc_write"
assert_label "B2-G03 git notes add" "git notes add -m n" "nonsrc_write"
assert_label "B2-G04 git update-ref" "git update-ref refs/heads/x HEAD" "nonsrc_write"
assert_label "B2-G05 git gc" "git gc" "nonsrc_write"
assert_label "B2-G06 git hash-object" "git hash-object -w f" "nonsrc_write"
assert_label "B2-G07 git init" "git init" "nonsrc_write"
# shared_write side: working-tree-mutating (ARM). Negative-control pairs —
# same `git` first token, the SUBCOMMAND (the predicate's contract) flips the
# label (lesson dc94: vary the field IN the predicate, not adjacent).
assert_label "B2-G10 git checkout (vs add)" "git checkout main" "shared_write"
assert_label "B2-G11 git switch" "git switch feature" "shared_write"
assert_label "B2-G12 git restore" "git restore scripts/x.mjs" "shared_write"
assert_label "B2-G13 git rm (vs commit)" "git rm scripts/x.mjs" "shared_write"
assert_label "B2-G14 git mv" "git mv a b" "shared_write"
assert_label "B2-G15 git reset" "git reset --hard HEAD" "shared_write"
assert_label "B2-G16 git stash" "git stash" "shared_write"
assert_label "B2-G17 git merge" "git merge feature" "shared_write"
assert_label "B2-G18 git rebase" "git rebase main" "shared_write"
assert_label "B2-G19 git pull" "git pull" "shared_write"
assert_label "B2-G20 git read-tree" "git read-tree HEAD" "shared_write"
# Total-function completeness: any UNLISTED subcommand arms.
assert_label "B2-G30 git frobnicate (unlisted → arm)" "git frobnicate" "shared_write"
assert_label "B2-G31 git submodule" "git submodule update" "shared_write"
# git_local_write `--cached` is NOT distinguished (no arg parsing) → arms.
assert_label "B2-G32 git rm --cached still arms" "git rm --cached f" "shared_write"

echo ""
echo "--- PR-B2 (#351): git metadata reasons → nonsrc_write ---"
assert_label "B2-M01 git remote add" "git remote add o https://x" "nonsrc_write"
assert_label "B2-M02 git config set" "git config user.name x" "nonsrc_write"
assert_label "B2-M03 git config --unset (write flag)" "git config --unset user.name" "nonsrc_write"
assert_label "B2-M04 git branch create" "git branch newbranch" "nonsrc_write"
assert_label "B2-M05 git branch -d (write flag)" "git branch -d old" "nonsrc_write"
assert_label "B2-M06 git tag create" "git tag v1.0" "nonsrc_write"
assert_label "B2-M07 git worktree add (lean-accept)" "git worktree add ../wt" "nonsrc_write"
assert_label "B2-M08 bare git (help)" "git" "nonsrc_write"
# Negative controls: git reads stay read_only (not downgraded to nonsrc).
assert_label "B2-M20 git config --get is read" "git config --get user.name" "read_only"
assert_label "B2-M21 git remote -v is read" "git remote -v" "read_only"
assert_label "B2-M22 git branch --list is read" "git branch --list" "read_only"
# Negative control: push stays push (most-restrictive, unaffected by split).
assert_label "B2-M30 git push unaffected" "git push origin main" "push_or_pr_create"

echo ""
echo "--- PR-B2 (#351, M4): package install + dir ops → nonsrc_write ---"
assert_label "B2-P01 npm install" "npm install" "nonsrc_write"
assert_label "B2-P02 npm i" "npm i" "nonsrc_write"
assert_label "B2-P03 npm ci" "npm ci" "nonsrc_write"
assert_label "B2-P04 pnpm install" "pnpm install" "nonsrc_write"
assert_label "B2-P05 yarn add" "yarn add lodash" "nonsrc_write"
assert_label "B2-P06 mkdir" "mkdir scripts/newdir" "nonsrc_write"
assert_label "B2-P07 rmdir" "rmdir scripts/olddir" "nonsrc_write"
# Negative controls: arbitrary-code-exec package ops stay shared_write (M4).
assert_label "B2-P20 npm run (vs install)" "npm run build" "shared_write"
assert_label "B2-P21 npx (separate binary)" "npx create-foo" "shared_write"
assert_label "B2-P22 npm publish" "npm publish" "shared_write"
# Redirect demotes the install allowlist (target may be repo source).
assert_label "B2-P23 npm install > scripts/x" "npm install > scripts/x.mjs" "shared_write"

echo ""
echo "--- PR-B2 (#351): em-store → nonsrc_write; conservative emits stay shared ---"
assert_label "B2-E01 node em-store" "node em-store.mjs --project x" "nonsrc_write"
assert_label "B2-E02 node em-revise" "node em-revise.mjs --original i" "nonsrc_write"
# Conservative-by-construction: no marker on disk → escapable emits stay armed.
assert_label "B2-E10 echo > src stays shared (no marker)" "echo x > scripts/x.mjs" "shared_write"
assert_label "B2-E11 cp default_write stays shared" "cp a scripts/b" "shared_write"
assert_label "B2-E12 readonly redirect stays shared" "ls > out.txt" "shared_write"
# rm/touch stay shared_write (§15-C1 — conservative, no reclassification).
assert_label "B2-E20 rm non-marker stays shared" "rm scripts/x.mjs" "shared_write"
assert_label "B2-E21 touch non-marker stays shared" "touch scripts/new.mjs" "shared_write"

echo ""
echo "--- PR-B2 (#351, §14-F3): _priority ladder + nonsrc_write precedence ---"
# nonsrc_write ranks above read_only (chain stays nonsrc, not downgraded to the
# gate-allow read_only) and below shared_write (chain upgrades to arm).
assert_label "B2-PR01 nonsrc && read_only stays nonsrc" "git add . && ls" "nonsrc_write"
assert_label "B2-PR02 nonsrc && shared upgrades to shared" "git add . && cp a scripts/b" "shared_write"
assert_label "B2-PR03 nonsrc && push upgrades to push" "git add . && git push" "push_or_pr_create"
assert_label "B2-PR04 read_only && nonsrc stays nonsrc" "ls && git commit -m x" "nonsrc_write"

echo ""
echo "--- PR-B2 (#351, §16/G1): general Bash marker-cache escape ---"
# Integration: plant a per-session agent marker, confirm classify_command
# returns the agent verdict for the escapable redirect / default_write emits
# (the interpreter branch already had this). Uses a real temp git repo + a
# clean HOME so the marker helper resolves to repo-source (policy v2), matching
# the write side. The KEY test is the REDIRECT case (the exact #351 class): a
# token-only reconstruction would drop `> foo` and miss — _seg_raw_command
# threading makes the read key match the write exactly.
g1_run() {
  local desc="$1" cmd="$2" expected="$3" plant="${4:-}" plant_label="${5:-nonsrc_write}"
  local saved_home="$HOME" tmp marker_helper
  tmp="$(mktemp -d)"; tmp="$(cd -P "$tmp" && pwd)"
  git -C "$tmp" init -q 2>/dev/null
  local g1home; g1home="$(mktemp -d)"; g1home="$(cd -P "$g1home" && pwd)"
  marker_helper="$REPO_ROOT/scripts/classifier-marker.mjs"
  if [ -n "$plant" ]; then
    ( cd "$tmp" && HOME="$g1home" CLAUDE_CODE_SESSION_ID=g1test node "$marker_helper" --write \
        --project-root "$tmp" --caller-cwd "$tmp" --command "$plant" \
        --label "$plant_label" --confidence 0.9 --reason g1test --session-id g1test ) >/dev/null 2>&1
  fi
  local result label
  result="$(HOME="$g1home" CLAUDE_CODE_SESSION_ID=g1test classify_command "$cmd" "$tmp" "$tmp")"
  label="${result%%	*}"
  rm -rf "$tmp" "$g1home"
  export HOME="$saved_home"
  if [ "$label" = "$expected" ]; then
    echo "  ✓ $desc"; passed=$((passed+1))
  else
    echo "  ✗ $desc (expected $expected, got $label / $result)"; failed=$((failed+1))
  fi
}
# Baseline: no marker → conservative arm.
g1_run "G1-01 redirect, no marker → shared_write" "echo hi > scripts/gen.mjs" "shared_write"
g1_run "G1-02 default_write, no marker → shared_write" "cp /etc/hosts scripts/c.txt" "shared_write"
# Escape: marker present → agent verdict honored (REDIRECT — the #351 class).
g1_run "G1-03 redirect + nonsrc marker → escapes" "echo hi > scripts/gen.mjs" "nonsrc_write" "echo hi > scripts/gen.mjs"
g1_run "G1-04 default_write + nonsrc marker → escapes" "cp /etc/hosts scripts/c.txt" "nonsrc_write" "cp /etc/hosts scripts/c.txt"
g1_run "G1-05 redirect + read_only marker → escapes" "echo hi > scripts/gen.mjs" "read_only" "echo hi > scripts/gen.mjs" "read_only"
# Hard-deny preserved: a marker on a push chain cannot downgrade the push
# segment (most-restrictive reduction wins).
g1_run "G1-06 push chain marker cannot downgrade push" "git push && echo hi > scripts/gen.mjs" "push_or_pr_create" "git push && echo hi > scripts/gen.mjs"
# Negative control: a marker for a DIFFERENT command does not escape this one.
g1_run "G1-07 mismatched marker does not escape" "echo hi > scripts/gen.mjs" "shared_write" "echo DIFFERENT > scripts/other.mjs"

echo ""
echo "--- #358 regression: quoted-arg + script-identity shell-pipeline parity ---"
# Reproduces the exact #358 failure scenario at the SHELL pipeline level
# (test-script-identity-key.mjs SI-M01 covers the script API; this exercises
# classify_command → _try_agent_marker_verdict / interpreter Tier-2/3, where
# the original bug lived). Both Site A (_try_agent_marker_verdict, line 1040)
# and Site B (interpreter dispatch, line 1956) now route through the shared
# _resolve_marker_cmd_text helper — the two sites cannot drift on quote
# handling — AND script-identity keying makes normalized_command moot in the
# cache_key for in-repo interpreter commands so per-request quoted args
# (`--summary "RFC-008 (thin-contracts concern)"`) no longer bust the cache.
i358_run() {
  local desc="$1" plant_cmd="$2" read_cmd="$3" expected="$4"
  local saved_home="$HOME" tmp marker_helper g1home
  tmp="$(mktemp -d)"; tmp="$(cd -P "$tmp" && pwd)"
  git -C "$tmp" init -q 2>/dev/null
  mkdir -p "$tmp/scripts"
  # In-repo interpreter target — non-null script_digest is required for the
  # isInterpreterScriptIdentity predicate to fire (this is the #358 shape:
  # `node scripts/second-opinion.mjs ...` against an in-repo file).
  printf '#!/usr/bin/env node\nconsole.log("hi")\n' > "$tmp/scripts/foo.mjs"
  g1home="$(mktemp -d)"; g1home="$(cd -P "$g1home" && pwd)"
  marker_helper="$REPO_ROOT/scripts/classifier-marker.mjs"
  ( cd "$tmp" && HOME="$g1home" CLAUDE_CODE_SESSION_ID=i358 node "$marker_helper" --write \
      --project-root "$tmp" --caller-cwd "$tmp" --command "$plant_cmd" \
      --label read_only --confidence 0.9 --reason i358 --session-id i358 ) >/dev/null 2>&1
  local result label
  result="$(HOME="$g1home" CLAUDE_CODE_SESSION_ID=i358 classify_command "$read_cmd" "$tmp" "$tmp")"
  label="${result%%	*}"
  rm -rf "$tmp" "$g1home"
  export HOME="$saved_home"
  if [ "$label" = "$expected" ]; then
    echo "  ✓ $desc"; passed=$((passed+1))
  else
    echo "  ✗ $desc (expected $expected, got $label / $result)"; failed=$((failed+1))
  fi
}
# Baseline: quoted-arg plant + identical lookup → HIT. The pre-#360 bug was
# that this could MISS because Site A keyed the raw quoted form and Site B
# keyed a de-quoted reconstruction; even the same command could drift.
i358_run "#358-01 quoted-arg plant + identical lookup → HIT" \
  'node scripts/foo.mjs --summary "RFC-008 (thin-contracts concern)"' \
  'node scripts/foo.mjs --summary "RFC-008 (thin-contracts concern)"' \
  "read_only"
# Script-identity: same in-repo script, completely different per-request args
# → HIT (normalized_command omitted from key, only script_digest + cwd +
# session + policy versions pin the verdict).
i358_run "#358-02 quoted-arg plant + different quoted-args lookup → HIT (script-identity)" \
  'node scripts/foo.mjs --summary "RFC-008 (thin-contracts concern)"' \
  'node scripts/foo.mjs --summary "different topic" --tag x --body-file /tmp/y' \
  "read_only"
# Cross-quote parity: unquoted plant + quoted lookup → HIT. Pre-#360 this
# would MISS via Site B's de-quoted reconstruction differing from Site A's
# raw form; the shared _resolve_marker_cmd_text + script-identity both
# foreclose the drift class.
i358_run "#358-03 unquoted plant + quoted-args lookup → HIT (no Site A/B drift)" \
  'node scripts/foo.mjs --some-flag value' \
  'node scripts/foo.mjs --summary "quoted text with (parens) and spaces"' \
  "read_only"
# Negative control: a DIFFERENT in-repo script must NOT reuse the marker
# (script_digest differs → key differs → no HIT). Confirms the fix is not
# over-broad.
i358_run "#358-04 different script does not reuse marker (digest pin)" \
  'node scripts/foo.mjs --summary "x"' \
  'node scripts/bar.mjs --summary "x"' \
  "shared_write"

# Non-script-identity slot: external interpreter script (digest null because
# the file lives OUTSIDE the project root). Here the predicate returns false
# and `normalized_command` IS in the cache key — this is the slot where Site A
# vs Site B drift on quote handling could have flipped the key pre-PR #360.
# The shared `_resolve_marker_cmd_text` helper is the load-bearing fix here
# (script-identity does not apply).
i358_run_external() {
  local desc="$1" plant_cmd="$2" read_cmd="$3" expected="$4"
  local saved_home="$HOME" tmp extdir g1home marker_helper
  tmp="$(mktemp -d)"; tmp="$(cd -P "$tmp" && pwd)"
  git -C "$tmp" init -q 2>/dev/null
  extdir="$(mktemp -d)"; extdir="$(cd -P "$extdir" && pwd)"
  printf '#!/usr/bin/env node\nconsole.log("ext")\n' > "$extdir/ext.mjs"
  g1home="$(mktemp -d)"; g1home="$(cd -P "$g1home" && pwd)"
  marker_helper="$REPO_ROOT/scripts/classifier-marker.mjs"
  # Substitute EXTDIR placeholder so per-run extdir path is testable.
  plant_cmd="${plant_cmd//EXTDIR/$extdir}"
  read_cmd="${read_cmd//EXTDIR/$extdir}"
  ( cd "$tmp" && HOME="$g1home" CLAUDE_CODE_SESSION_ID=i358ext node "$marker_helper" --write \
      --project-root "$tmp" --caller-cwd "$tmp" --command "$plant_cmd" \
      --label read_only --confidence 0.9 --reason i358ext --session-id i358ext ) >/dev/null 2>&1
  local result label
  result="$(HOME="$g1home" CLAUDE_CODE_SESSION_ID=i358ext classify_command "$read_cmd" "$tmp" "$tmp")"
  label="${result%%	*}"
  rm -rf "$tmp" "$g1home" "$extdir"
  export HOME="$saved_home"
  if [ "$label" = "$expected" ]; then
    echo "  ✓ $desc"; passed=$((passed+1))
  else
    echo "  ✗ $desc (expected $expected, got $label / $result)"; failed=$((failed+1))
  fi
}
# Identical quoted command across plant + lookup → HIT. The shared
# _resolve_marker_cmd_text helper guarantees both Site A and Site B see the
# same raw form (no de-quoted reconstruction), so the normalized_command keys
# match. Pre-PR-#360 this is the exact drift Site B introduced.
i358_run_external "#358-05 external script quoted-arg + identical lookup → HIT (Site A/B parity)" \
  'node EXTDIR/ext.mjs --summary "RFC-008 (thin-contracts concern)"' \
  'node EXTDIR/ext.mjs --summary "RFC-008 (thin-contracts concern)"' \
  "read_only"
# Negative control: different args MUST MISS for non-script-identity commands
# (arg-sensitivity preserved; the script-identity collapse does NOT extend to
# external scripts).
i358_run_external "#358-06 external script + different args → MISS (arg-sensitive)" \
  'node EXTDIR/ext.mjs --summary "RFC-008 (thin-contracts concern)"' \
  'node EXTDIR/ext.mjs --summary "completely different topic"' \
  "shared_write"

echo ""
echo "=================================================="
echo "Results: $passed passed, $failed failed"
echo "=================================================="

exit $((failed > 0 ? 1 : 0))
