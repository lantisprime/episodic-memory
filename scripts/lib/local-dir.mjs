/**
 * local-dir.mjs — resolve canonical project paths for the episodic-memory store
 * AND for `.claude/` marker files.
 *
 * Two exports:
 *   - resolveRepoRoot(cwd)  — the primitive. Returns the main repo's working tree.
 *   - resolveLocalDir(cwd)  — `<repo-root>/.episodic-memory/` (PR #105 / #85).
 *
 * resolveLocalDir is `path.join(resolveRepoRoot(cwd), '.episodic-memory')` —
 * a one-line postfix on the primitive. Single source of truth for the
 * git-resolution heuristic; do not duplicate it.
 *
 * Walks to the main repository root via `git rev-parse --git-common-dir` so
 * invocations from a linked worktree converge on the SAME root as the main
 * checkout. resolveRepoRoot is also used by armCheckpointMarker (em-recall)
 * and the SessionEnd cleanup loop (em-session-end-prompt) so bp-001 marker
 * writes land where the hook readers (hooks/lib/repo-root.sh) look for them.
 * Closes #106 (sibling to #85).
 *
 * Resolution captured at module-load time by callers (e.g. `const LOCAL_DIR =
 * resolveLocalDir()` at the top of em-*.mjs). Do not chdir before importing.
 *
 * Edge-case handling:
 *   - Linked worktree of main:  common-dir basename is `.git` -> parent. (This
 *     is the case #85/#106 are about: the linked worktree's common-dir is the
 *     SHARED main `.git`, so we resolve to the main repo root.)
 *   - Submodule:                common-dir is `<super>/.git/modules/<name>`,
 *     basename ≠ `.git` -> use `git rev-parse --show-toplevel`, which returns
 *     the SUBMODULE's working tree (its own local memory, not the superproject's).
 *   - --separate-git-dir / GIT_DIR=...: common-dir is the gitdir target,
 *     basename ≠ `.git` -> --show-toplevel returns the linked work tree.
 *   - Bare repo:                --show-toplevel errors -> cwd fallback.
 *   - Non-git cwd:              first git call throws -> cwd fallback.
 *
 * NOTE: A worktree of a submodule degrades to the submodule's worktree root via
 *       --show-toplevel (consistent with how a worktree of main is handled, just
 *       one level deeper). Out of scope for #85 — file an issue if it bites.
 */

import path from 'path'
import { execSync } from 'child_process'

export function resolveRepoRoot(cwd = process.cwd()) {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    const absCommon = path.resolve(cwd, commonDir)
    // Canonical case (linked worktree of main, or main itself): <repo>/.git.
    if (path.basename(absCommon) === '.git') {
      return path.dirname(absCommon)
    }
    // Submodule, --separate-git-dir, GIT_DIR=..., etc. The common-dir parent is
    // NOT the working tree (e.g. for a submodule it's the superproject's
    // .git/modules/, not the submodule's checkout). Use --show-toplevel to get
    // the actual working tree of THIS git context.
    const top = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (top) return top
  } catch {
    // not a git repo, bare repo, or git unavailable
  }
  return cwd
}

export function resolveLocalDir(cwd = process.cwd()) {
  return path.join(resolveRepoRoot(cwd), '.episodic-memory')
}
