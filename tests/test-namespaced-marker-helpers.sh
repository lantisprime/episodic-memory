#!/usr/bin/env bash
# Shell-parity smoke tests for the namespaced-marker helpers added in
# rank-2 (PR for checkpoint-quartet). Mirrors test-namespaced-marker-helpers.mjs.
#
# Coverage:
#   - namespaced_marker_basename_matches   (G1-G10)
#   - namespaced_marker_basename_for_session  (C1-C2)
#   - any_namespaced_marker_exists  (E1-E5) — uses /tmp fixture
#   - is_checkpoint_quartet_basename + CHECKPOINT_QUARTET  (Q1-Q5)
#
# Run from repo root: bash tests/test-namespaced-marker-helpers.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/hooks/lib/marker-paths.sh"

pass=0
fail=0
failures=()

assert() {
  local label="$1" cond="$2"
  if [ "$cond" = "true" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failures+=("$label")
  fi
}

# G1-G10 — strict matcher
namespaced_marker_basename_matches .checkpoint-required .checkpoint-required && r=true || r=false
assert "G1 legacy literal matches" "$r"

namespaced_marker_basename_matches .checkpoint-required .checkpoint-required.abc123 && r=true || r=false
assert "G2 simple sid matches" "$r"

namespaced_marker_basename_matches .checkpoint-required .checkpoint-required.eff2d836-5d8e-4750-908a-f2ae14852d57 && r=true || r=false
assert "G3 uuid sid matches" "$r"

namespaced_marker_basename_matches .checkpoint-required .post-checkpoint-required && r=true || r=false
assert "G4 wrong legacy rejects" "$([ "$r" = "false" ] && echo true || echo false)"

namespaced_marker_basename_matches .checkpoint-required .checkpoint-required-extra && r=true || r=false
assert "G5 suffix without dot rejects" "$([ "$r" = "false" ] && echo true || echo false)"

namespaced_marker_basename_matches .checkpoint-required .checkpoint-required. && r=true || r=false
assert "G6 empty suffix rejects" "$([ "$r" = "false" ] && echo true || echo false)"

namespaced_marker_basename_matches .checkpoint-required ".checkpoint-required.foo bar" && r=true || r=false
assert "G7 space in suffix rejects" "$([ "$r" = "false" ] && echo true || echo false)"

namespaced_marker_basename_matches .checkpoint-required ".checkpoint-required..ext" && r=true || r=false
assert "G8 dot in suffix rejects" "$([ "$r" = "false" ] && echo true || echo false)"

oversize_sid="$(printf 'a%.0s' $(seq 1 129))"
namespaced_marker_basename_matches .checkpoint-required ".checkpoint-required.${oversize_sid}" && r=true || r=false
assert "G9 oversize suffix (129) rejects" "$([ "$r" = "false" ] && echo true || echo false)"

maxlen_sid="$(printf 'a%.0s' $(seq 1 128))"
namespaced_marker_basename_matches .checkpoint-required ".checkpoint-required.${maxlen_sid}" && r=true || r=false
assert "G10 exact maxlen suffix accepts" "$r"

# C1-C2 — composer
out="$(namespaced_marker_basename_for_session .checkpoint-required abc)"
assert "C1 compose simple" "$([ "$out" = ".checkpoint-required.abc" ] && echo true || echo false)"

out="$(namespaced_marker_basename_for_session .post-checkpoint-done eff2d836)"
assert "C2 compose preserves dot-separator" "$([ "$out" = ".post-checkpoint-done.eff2d836" ] && echo true || echo false)"

# E1-E5 — fs fixture
FIXTURE="$(mktemp -d -t rank2-marker-test-XXXXXX)"
mkdir -p "$FIXTURE/.checkpoints" "$FIXTURE/.claude"

any_namespaced_marker_exists "$FIXTURE" .checkpoint-required && r=true || r=false
assert "E1 missing returns false" "$([ "$r" = "false" ] && echo true || echo false)"

: > "$FIXTURE/.checkpoints/.checkpoint-required"
any_namespaced_marker_exists "$FIXTURE" .checkpoint-required && r=true || r=false
assert "E2 legacy at primary detected" "$r"

rm -f "$FIXTURE/.checkpoints/.checkpoint-required"
: > "$FIXTURE/.claude/.checkpoint-required"
any_namespaced_marker_exists "$FIXTURE" .checkpoint-required && r=true || r=false
assert "E3 legacy at legacy detected" "$r"

rm -f "$FIXTURE/.claude/.checkpoint-required"
: > "$FIXTURE/.checkpoints/.checkpoint-required.sid123"
any_namespaced_marker_exists "$FIXTURE" .checkpoint-required && r=true || r=false
assert "E4 suffixed at primary detected" "$r"

rm -f "$FIXTURE/.checkpoints/.checkpoint-required.sid123"
: > "$FIXTURE/.checkpoints/.checkpoint-required-extra"
any_namespaced_marker_exists "$FIXTURE" .checkpoint-required && r=true || r=false
assert "E5 hyphen-suffix non-strict basename does NOT match" "$([ "$r" = "false" ] && echo true || echo false)"

rm -rf "$FIXTURE"

# Q1-Q5 — quartet array + matcher
assert "Q1 quartet has 4 members" "$([ "${#CHECKPOINT_QUARTET[@]}" -eq 4 ] && echo true || echo false)"

is_checkpoint_quartet_basename .checkpoint-required && r=true || r=false
assert "Q2 legacy member matches" "$r"

is_checkpoint_quartet_basename .post-checkpoint-done.eff2d836 && r=true || r=false
assert "Q3 suffixed member matches" "$r"

is_checkpoint_quartet_basename .plan-approval-pending && r=true || r=false
assert "Q4 plan-marker rejects" "$([ "$r" = "false" ] && echo true || echo false)"

is_checkpoint_quartet_basename .checkpoint-required-extra && r=true || r=false
assert "Q5 non-strict-suffix rejects" "$([ "$r" = "false" ] && echo true || echo false)"

# Summary
printf '{"pass":%d,"fail":%d,"total":%d,"failures":[' "$pass" "$fail" $((pass + fail))
for i in "${!failures[@]}"; do
  [ "$i" -gt 0 ] && printf ','
  printf '"%s"' "${failures[$i]}"
done
printf ']}\n'

exit "$fail"
