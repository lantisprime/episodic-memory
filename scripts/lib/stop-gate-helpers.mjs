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
import path from 'path'
import {
  PRIMARY_MARKER_DIR,
  LEGACY_MARKER_DIR,
  PLAN_MARKER_LEGACY_BASENAME,
  primaryMarkerPath,
  legacyMarkerPath,
} from './marker-paths.mjs'

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

// #268 fix E19/E20: strict-lstat helper for plan-marker that scans BOTH
// legacy `.plan-approval-pending` AND any `.plan-approval-pending.<sid>`
// at primary + legacy roots. Mtime is the MAX across the entire set —
// stop-gate's plan-pending deferral fires if ANY plan-marker (own session
// or other) is active mid-session.
//
// Same fail-closed semantics as the base strict helper:
//   - hadSymlink on any matched symlink (caller fails closed)
//   - hadOtherError on any non-ENOENT lstat / readdir error
export function _maxMtimeAcrossRootsForPlanMarkerStrict(repoRoot) {
  let mtime = -Infinity
  let hadSymlink = false
  let anyExisted = false
  let hadOtherError = false

  // Legacy literal at both roots (same as _maxMtimeAcrossRootsStrict for
  // PLAN_MARKER_LEGACY_BASENAME).
  for (const p of [
    primaryMarkerPath(repoRoot, PLAN_MARKER_LEGACY_BASENAME),
    legacyMarkerPath(repoRoot, PLAN_MARKER_LEGACY_BASENAME),
  ]) {
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) { hadSymlink = true; continue }
      anyExisted = true
      if (st.mtimeMs > mtime) mtime = st.mtimeMs
    } catch (e) {
      if (e && e.code !== 'ENOENT') hadOtherError = true
    }
  }

  // Glob-expand `.plan-approval-pending.<*>` at both roots.
  const prefix = `${PLAN_MARKER_LEGACY_BASENAME}.`
  for (const dir of [path.join(repoRoot, PRIMARY_MARKER_DIR), path.join(repoRoot, LEGACY_MARKER_DIR)]) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch (e) {
      // ENOENT on the dir itself is fine (no markers); other → fail-closed.
      if (e && e.code !== 'ENOENT') hadOtherError = true
      continue
    }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      const p = path.join(dir, name)
      try {
        const st = fs.lstatSync(p)
        if (st.isSymbolicLink()) { hadSymlink = true; continue }
        anyExisted = true
        if (st.mtimeMs > mtime) mtime = st.mtimeMs
      } catch (e) {
        if (e && e.code !== 'ENOENT') hadOtherError = true
      }
    }
  }

  return { mtime, hadSymlink, anyExisted, hadOtherError }
}
