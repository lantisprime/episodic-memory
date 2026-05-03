/**
 * local-dir.mjs — resolve the canonical .episodic-memory/ directory for --scope local.
 *
 * Walks to the main repository root via `git rev-parse --git-common-dir` so that
 * invocations from a linked worktree write to the SAME store as the main checkout.
 * Closes #85.
 *
 * Resolution captured at module-load time by callers (e.g. `const LOCAL_DIR =
 * resolveLocalDir()` at the top of em-*.mjs). Do not chdir before importing.
 *
 * Edge-case handling:
 *   - Linked worktree:  common-dir basename is `.git`     -> parent.
 *   - Submodule:        common-dir is `<repo>/.git/modules/<name>`     -> strip from `/.git/`.
 *   - Worktree-of-sub:  common-dir is `<repo>/.git/modules/<name>/worktrees/<wt>` -> strip from `/.git/`.
 *   - --separate-git-dir / GIT_DIR: no `/.git/` segment in common-dir   -> cwd fallback.
 *   - Bare repo / non-git cwd:                                          -> cwd fallback.
 */

import path from 'path'
import { execSync } from 'child_process'

export function resolveLocalDir(cwd = process.cwd()) {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    const absCommon = path.resolve(cwd, commonDir)
    // Canonical worktree: <repo>/.git
    if (path.basename(absCommon) === '.git') {
      return path.join(path.dirname(absCommon), '.episodic-memory')
    }
    // Submodule / worktree-of-submodule: strip from `/.git/...`. Last occurrence
    // handles nested cases (worktree of a submodule).
    const sep = path.sep
    const marker = `${sep}.git${sep}`
    const idx = absCommon.lastIndexOf(marker)
    if (idx !== -1) {
      return path.join(absCommon.slice(0, idx), '.episodic-memory')
    }
    // No `.git` segment (--separate-git-dir / GIT_DIR / bare): no reliable
    // way to recover the main worktree. Fall through to cwd.
  } catch {
    // not a git repo, or git unavailable
  }
  return path.join(cwd, '.episodic-memory')
}
