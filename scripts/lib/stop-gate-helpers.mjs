/**
 * stop-gate-helpers.mjs — Pure helpers for em-recall.mjs --gate stop.
 *
 * Extracted so tests/test-em-strict-lstat.mjs can import the strict-lstat
 * helper directly and assert internal state (hadOtherError reached vs.
 * tautological BLOCK). Codex round-6 F17.
 *
 * `_maxMtimeAcrossRootsStrict` — distinguishes ENOENT (marker absent at
 * a root → fine to skip) from other lstat errors (EACCES, ENOTDIR, EIO,
 * ELOOP — inspection failed → caller must fail closed). For NEW
 * fail-closed paths only; the existing `_maxMtimeAcrossRoots` in
 * em-recall.mjs retains its relaxed semantic (carve-out callers; FU to
 * migrate per scratch/rank1-plan-v7.md FU list).
 *
 * Codex review trail: rounds 1-7 of rank-1 hook-deadlock plan, episodes
 * `...bd6c` → `...afd2` → `...3ad6` → `...5697` → `...fb05` → `...acdc` →
 * `...e19a` (ACCEPT-with-FU).
 */

import fs from 'fs'
import { primaryMarkerPath, legacyMarkerPath } from './marker-paths.mjs'

export function _maxMtimeAcrossRootsStrict(repoRoot, basename) {
  let mtime = -Infinity
  let hadSymlink = false
  let anyExisted = false
  let hadOtherError = false
  for (const p of [primaryMarkerPath(repoRoot, basename), legacyMarkerPath(repoRoot, basename)]) {
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) { hadSymlink = true; continue }
      anyExisted = true
      if (st.mtimeMs > mtime) mtime = st.mtimeMs
    } catch (e) {
      if (e && e.code !== 'ENOENT') hadOtherError = true
    }
  }
  return { mtime, hadSymlink, anyExisted, hadOtherError }
}
