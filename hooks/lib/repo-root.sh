#!/usr/bin/env bash
# repo-root.sh — Resolve the canonical repo root for marker-path resolution.
#
# Mirrors scripts/lib/local-dir.mjs (PR #105 / #85 algorithm). Source from a
# hook and call resolve_repo_root [cwd]. Echoes the resolved repo-root path
# (no trailing newline). Falls back to cwd when resolution fails.
#
# Algorithm (see local-dir.mjs comments for full rationale):
#   1. git -C <cwd> rev-parse --git-common-dir → if basename is .git, use parent.
#   2. Otherwise (submodule, --separate-git-dir, GIT_DIR=…) fall back to
#      git rev-parse --show-toplevel (returns this git context's working tree).
#   3. Otherwise (non-git, bare repo, git unavailable) fall back to cwd.
#
# Decoupled from local-dir.mjs: shell hooks must not depend on Node.js runtime.

resolve_repo_root() {
  local cwd="${1:-$(pwd)}"
  local common_dir abs base top

  if common_dir="$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null)"; then
    case "$common_dir" in
      /*) abs="$common_dir" ;;
      *)  abs="$cwd/$common_dir" ;;
    esac
    # Normalize. cd -P resolves symlinks; if it fails (path missing) keep raw.
    if abs="$(cd -P "$abs" 2>/dev/null && pwd)"; then :; else abs="${abs%/}"; fi
    base="$(basename "$abs")"
    if [ "$base" = ".git" ]; then
      printf '%s' "$(dirname "$abs")"
      return 0
    fi
    if top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"; then
      if [ -n "$top" ]; then
        printf '%s' "$top"
        return 0
      fi
    fi
  fi
  printf '%s' "$cwd"
}
