#!/usr/bin/env bash
# repo-source.sh — shared "is this a gated repo-source write?" predicate.
# Sourced by checkpoint-gate.sh AND plan-gate.sh (Rule 14: ONE definition, no drift).
# Pure path/label logic. NO agent self-verdict here (that stays checkpoint-gate-local).

_canonicalize_possibly_nonexistent() {
  local p="$1"
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  if [ -e "$p" ] || [ -L "$p" ]; then
    if [ -d "$p" ]; then
      (cd "$p" 2>/dev/null && pwd -P) || printf '%s' "$p"
      return
    fi
    local parent leaf parent_canon resolved hops=0
    parent="$(dirname "$p")"; leaf="$(basename "$p")"
    parent_canon="$( (cd "$parent" 2>/dev/null && pwd -P) || printf '%s' "$parent" )"
    resolved="$parent_canon/$leaf"
    while [ -L "$resolved" ] && [ $hops -lt 32 ]; do
      local target
      target="$(readlink "$resolved")" || break
      case "$target" in
        /*) resolved="$target" ;;
        *)  resolved="$(dirname "$resolved")/$target" ;;
      esac
      hops=$((hops+1))
      local rp_parent rp_leaf rp_parent_canon
      rp_parent="$(dirname "$resolved")"; rp_leaf="$(basename "$resolved")"
      rp_parent_canon="$( (cd "$rp_parent" 2>/dev/null && pwd -P) || printf '%s' "$rp_parent" )"
      resolved="$rp_parent_canon/$rp_leaf"
    done
    printf '%s' "$resolved"; return
  fi
  local tail="" cur="$p"
  while [ -n "$cur" ] && [ ! -e "$cur" ] && [ ! -L "$cur" ]; do
    tail="/$(basename "$cur")${tail}"
    local up; up="$(dirname "$cur")"
    [ "$up" = "$cur" ] && break
    cur="$up"
  done
  if [ -e "$cur" ] || [ -L "$cur" ]; then
    if [ -d "$cur" ]; then
      local cur_canon; cur_canon="$( (cd "$cur" 2>/dev/null && pwd -P) || printf '%s' "$cur" )"
      printf '%s%s' "$cur_canon" "$tail"
    else
      local cur_canon; cur_canon="$(_canonicalize_possibly_nonexistent "$cur")"
      printf '%s%s' "$cur_canon" "$tail"
    fi
  else
    printf '%s' "$p"
  fi
}

# §12.1 contract. 0 = gated repo source, 1 = ALLOW. Fail-closed: empty path → 0.
_path_is_repo_source() {
  local repo_root="$1" file_path="$2"
  [ -n "$file_path" ] || return 0
  local repo_canon fp_canon
  repo_canon="$( (cd "$repo_root" 2>/dev/null && pwd -P) || printf '%s' "$repo_root" )"
  fp_canon="$(_canonicalize_possibly_nonexistent "$file_path")"
  # Raw-prefix catches symlink-OUT author intent (a real path literally under the
  # repo root that a symlink would resolve outside) → treat as in-repo. BUT a `..`
  # traversal segment makes a raw path spuriously match "$repo_root"/* while
  # resolving off-repo, so skip the raw short-circuit for those and let
  # canonicalization decide (R3: off-repo `..`-relative writes must be permitted,
  # not over-blocked; the absolute-collapsed form must give the same verdict).
  local in_repo=1
  case "$file_path" in
    ../*|*/../*|*/..|..) ;;                       # has .. traversal → canonical-only
    "$repo_root"/*|"$repo_root") in_repo=0 ;;
  esac
  if [ "$in_repo" != 0 ]; then
    case "$fp_canon" in "$repo_canon"/*|"$repo_canon") in_repo=0 ;; esac
  fi
  [ "$in_repo" = 0 ] || return 1
  # Load carve-out dirs from the shared JSON (Rule 14 single source).
  # Resolution order (NEW-R3-1): (1) deployed canonical path used by the live
  # ~/.claude/hooks/ copy; (2) in-repo dev/test relative path; (3) inline
  # literals if both are unreadable (fail-safe — a deploy-lag never opens gate).
  # Matching is EXACT SEGMENT: "<repo>/<dir>" or "<repo>/<dir>/*" only.
  # Never substring — .github/ and .gitignore must NOT be carved.
  local _co_json="" _co_json1 _co_json2
  _co_json1="$HOME/.episodic-memory/patterns/repo-source-carveouts.json"
  _co_json2="${BASH_SOURCE[0]%/*}/../../../../patterns/repo-source-carveouts.json"
  if [ -f "$_co_json1" ] && _co_dirs="$(node -e "try{const c=require(process.argv[1]);process.stdout.write(c.exact_segment_dirs.join('\n'))}catch(e){process.exit(1)}" "$_co_json1" 2>/dev/null)"; then
    _co_json="$_co_json1"
  elif [ -f "$_co_json2" ] && _co_dirs="$(node -e "try{const c=require(process.argv[1]);process.stdout.write(c.exact_segment_dirs.join('\n'))}catch(e){process.exit(1)}" "$_co_json2" 2>/dev/null)"; then
    _co_json="$_co_json2"
  fi
  if [ -n "$_co_json" ]; then
    local _d
    while IFS= read -r _d; do
      [ -z "$_d" ] && continue
      case "$fp_canon" in
        "$repo_canon/$_d"|"$repo_canon/$_d"/*) return 1 ;;
      esac
    done <<< "$_co_dirs"
  else
    # Inline fallback — exact-segment match, never substring.
    case "$fp_canon" in
      "$repo_canon"/.episodic-memory|"$repo_canon"/.episodic-memory/*) return 1 ;;
      "$repo_canon"/.checkpoints|"$repo_canon"/.checkpoints/*)         return 1 ;;
      "$repo_canon"/.review-store|"$repo_canon"/.review-store/*)       return 1 ;;
      "$repo_canon"/.git|"$repo_canon"/.git/*)                         return 1 ;;
      "$repo_canon"/docs/plans|"$repo_canon"/docs/plans/*)             return 1 ;;
    esac
  fi
  if command -v git >/dev/null 2>&1 \
     && git -C "$repo_canon" check-ignore -q -- "$fp_canon" 2>/dev/null; then
    return 1
  fi
  return 0
}

# §12.2 contract. 0 = gated repo-source write, 1 = ALLOW.
_tool_targets_repo_source_shared() {
  local repo_root="$1" tool="$2" path="$3" label="$4"
  if [ "$tool" = "Bash" ]; then
    case "$label" in
      read_only|nonsrc_write) return 1 ;;
      shared_write|unsafe_complex|push_or_pr_create)
        if [ -n "$path" ]; then
          _path_is_repo_source "$repo_root" "$path"; return $?
        fi
        return 0 ;;
      *) return 0 ;;
    esac
  fi
  _path_is_repo_source "$repo_root" "$path"
}
