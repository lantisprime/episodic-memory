/**
 * marker-root-validation.mjs — Shared --root flag validation for marker
 * helper scripts.
 *
 * Extracted from scripts/preflight-marker-write.mjs validateRoot() for
 * reuse by scripts/plan-marker.mjs (#268 fix). Same semantics:
 *
 *   1. --root MUST be provided (no implicit cwd fallback)
 *   2. --root MUST be absolute
 *   3. canonicalize via canonicalize-path-tolerant.mjs (symlink-aware)
 *   4. canonical path MUST exist as a directory
 *   5. canonical path MUST have a repo signal (.git OR .checkpoints
 *      OR .episodic-memory) — refusing without a signal prevents
 *      writing markers into arbitrary user directories
 *
 * Throws RootValidationError on any failure with .code ∈ {4, 5}.
 * Callers map .code to process.exit(code).
 */

import fs from 'fs'
import path from 'path'
import { canonicalizePathTolerant } from './canonicalize-path-tolerant.mjs'

export const REPO_SIGNALS = ['.git', '.checkpoints', '.episodic-memory']

export class RootValidationError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = 'RootValidationError'
  }
}

/**
 * Validate --root argument. Returns canonical absolute path on success.
 * Throws RootValidationError on failure.
 *
 * @param {string|null|undefined} rootArg — the --root flag value
 * @returns {string} canonical absolute directory path
 * @throws {RootValidationError} with .code 4 (missing) or 5 (invalid)
 */
export function validateRoot(rootArg) {
  if (!rootArg) {
    throw new RootValidationError(4, 'ROOT_REQUIRED: --root <abs> is mandatory; no cwd fallback')
  }
  if (!path.isAbsolute(rootArg)) {
    throw new RootValidationError(5, `ROOT_INVALID: --root must be absolute, got: ${rootArg}`)
  }

  let canonical
  try {
    canonical = canonicalizePathTolerant(rootArg, process.cwd())
  } catch (e) {
    throw new RootValidationError(5, `ROOT_INVALID: canonicalization failed: ${e.message}`)
  }

  let stat
  try {
    stat = fs.statSync(canonical)
  } catch (e) {
    throw new RootValidationError(5, `ROOT_INVALID: ${canonical} does not exist (${e.code})`)
  }
  if (!stat.isDirectory()) {
    throw new RootValidationError(5, `ROOT_INVALID: ${canonical} is not a directory`)
  }

  const hasSignal = REPO_SIGNALS.some((s) => fs.existsSync(path.join(canonical, s)))
  if (!hasSignal) {
    throw new RootValidationError(5, `ROOT_NOT_REPO: ${canonical} has none of [${REPO_SIGNALS.join(', ')}]`)
  }

  return canonical
}
