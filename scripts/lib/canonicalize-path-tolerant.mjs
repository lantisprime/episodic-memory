/**
 * canonicalize-path-tolerant.mjs — POSIX-style path canonicalization that
 * dereferences symlinks for components that exist and tolerates a missing
 * leaf (or any component past the first ENOENT).
 *
 * Why exist:
 *   `fs.realpathSync(p)` is all-or-nothing — throws ENOENT if any component
 *   is missing. Falling back to `path.resolve(p)` is INCORRECT for security-
 *   sensitive comparisons because `path.resolve` does NOT follow symlinks,
 *   so a Write to `<repo>/sym` (where `sym -> .checkpoints/.preflight-done`,
 *   target absent) would canonicalize to `<repo>/sym` and miss the marker
 *   match. The Write would then create the marker at the symlink target,
 *   bypassing the gate's helper-only contract.
 *
 *   This lib walks path components left-to-right, calls `fs.lstatSync` on
 *   each, dereferences symlinks via `fs.readlinkSync`, and stops resolution
 *   at the first ENOENT — appending the literal remainder. That matches
 *   POSIX `realpath -m` semantics ("missing tolerant") which Node lacks.
 *
 * Used by:
 *   - hooks/preflight-gate.sh — via `node -e` invocation for marker-write
 *     denial path canonicalization.
 *   - scripts/preflight-marker-write.mjs — for `--root` validation (rejects
 *     if `--root` resolves to anywhere outside the declared project).
 *
 * Discovered: codex r4 reply `20260512-072212-...-0fc1` (dangling-symlink
 *   bypass). Closed: codex r5 ACCEPT `20260512-072545-...-dbf6`.
 *
 * Threat model:
 *   - Single symlink to absent marker → DENY (F2h)
 *   - Multi-hop chain → DENY (F2i)
 *   - Symlink in middle of path → DENY (F2j)
 *   - Symlink loop → throw, gate emits conservative DENY (F2k)
 *   - Relative-target symlink → resolved against symlink's parent dir (F2l)
 *   - Absolute-target symlink → resolved verbatim (F2m)
 *   - Symlink to unrelated path → ALLOW (F2n)
 *
 * Bound:
 *   MAX_HOPS=40 (POSIX SYMLOOP_MAX is typically 40 on Linux/macOS).
 *
 * NOT in scope: Windows path semantics. POSIX-only by project convention.
 */

import fs from 'fs'
import path from 'path'

export const MAX_HOPS = 40

/**
 * Canonicalize an input path with symlink dereference + missing-leaf tolerance.
 *
 * @param {string} inputPath - the path to canonicalize (absolute or relative)
 * @param {string} hookCwd - the cwd to resolve relative inputs against
 * @returns {string} - canonical absolute path with symlinks resolved as far as
 *                     possible; literal remainder past first ENOENT
 * @throws {Error} - on SYMLOOP_MAX exceeded; gate should emit conservative DENY
 */
export function canonicalizePathTolerant(inputPath, hookCwd) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error('canonicalizePathTolerant: inputPath must be non-empty string')
  }
  if (typeof hookCwd !== 'string' || !path.isAbsolute(hookCwd)) {
    throw new Error('canonicalizePathTolerant: hookCwd must be absolute path')
  }
  return resolveInner(inputPath, hookCwd, 0)
}

function resolveInner(inputPath, hookCwd, hopsSoFar) {
  let abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(hookCwd, inputPath)
  abs = path.normalize(abs)

  // POSIX-only; root is '/'. Split, drop empties from leading '/'.
  const parts = abs.split(path.sep).filter(Boolean)
  let resolved = path.sep
  let hops = hopsSoFar

  for (let i = 0; i < parts.length; i++) {
    const candidate = path.join(resolved, parts[i])
    let stat
    try {
      stat = fs.lstatSync(candidate)
    } catch (e) {
      if (e.code === 'ENOENT') {
        // First missing component — append literal remainder. POSIX
        // `realpath -m` semantics: nonexistent components are kept verbatim,
        // no further resolution attempted.
        const remainder = parts.slice(i)
        return path.normalize(path.join(resolved, ...remainder))
      }
      // Other errors (EACCES, ENOTDIR mid-path, etc.) propagate. Gate
      // should treat as conservative DENY.
      throw e
    }

    if (stat.isSymbolicLink()) {
      hops++
      if (hops > MAX_HOPS) {
        throw new Error(
          `canonicalizePathTolerant: SYMLOOP_MAX (${MAX_HOPS}) exceeded resolving ${inputPath}`
        )
      }
      const target = fs.readlinkSync(candidate)
      // Relative target resolves against symlink's parent dir; absolute
      // target replaces the path-so-far entirely.
      const targetAbs = path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(candidate), target)
      // Replace [0..i] with target, keep [i+1..] as remainder, recurse.
      const remainder = parts.slice(i + 1)
      const newAbs = path.normalize(path.join(targetAbs, ...remainder))
      return resolveInner(newAbs, hookCwd, hops)
    }

    // Regular file or dir component — extend resolved.
    resolved = candidate
  }

  return path.normalize(resolved)
}
