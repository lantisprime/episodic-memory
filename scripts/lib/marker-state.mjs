/**
 * marker-state.mjs — Enforcement-layer marker-state reader (RFC-008 P3, R1).
 *
 * Owns ALL gate/marker reads for the enforcement layer. The memory substrate
 * (em-store / em-recall / em-search) MUST NOT read markers — that is the R1
 * strong-form invariant (RFC-008:83,85). This module is imported by the
 * enforcement thin waist (enforce-contract.mjs, P3b) and, during the P3a→P3d
 * transition, by em-recall.mjs's surviving `--gate stop` dispatch handler
 * (which itself moves to enforce-contract.mjs in P3b, then is deleted from
 * em-recall in P3d).
 *
 * P3a is a pure extraction: every function here is relocated VERBATIM (same
 * semantics, same fail-closed behavior) from its prior home —
 *   - the 3 strict-lstat helpers from scripts/lib/stop-gate-helpers.mjs
 *     (now deleted; its sole importer was em-recall.mjs);
 *   - the relaxed helpers + carve-out predicate + own-session resolver from
 *     scripts/em-recall.mjs:175-295.
 * No behavior change: em-recall `--gate stop` output is byte-identical.
 *
 * Path layer stays in marker-paths.mjs (primary/legacy roots, suffixed-marker
 * matchers, the marker-name constants); this module imports from it.
 *
 * Strict vs relaxed semantic:
 *   - *Strict helpers distinguish ENOENT (marker absent at a root → skip) from
 *     other lstat errors (EACCES, ENOTDIR, EIO, ELOOP → hadOtherError → caller
 *     fails closed). Use for NEW fail-closed paths.
 *   - The non-`Strict` helpers use relaxed semantics (lstat errors silently
 *     skipped) — carve-out callers (NON-fail-closed).
 * ANY symlink at EITHER root sets hadSymlink=true so the caller fails closed
 * (symlink-defense, same-class symmetry per feedback_same_class_completeness).
 *
 * Codex review trail (strict helpers): rounds 1-7 of rank-1 hook-deadlock plan,
 * episodes `...bd6c` → `...afd2` → `...3ad6` → `...5697` → `...fb05` → `...acdc`
 * → `...e19a` (ACCEPT-with-FU). Carve-out symlink defense: codex round-1 P2
 * (episode 20260505-124511-...-845f).
 */

import fs from 'fs'
import path from 'path'
import {
  TASK_SIGNAL_MARKERS,
  BASELINE_NAME,
  PRIMARY_MARKER_DIR,
  LEGACY_MARKER_DIR,
  PLAN_MARKER_LEGACY_BASENAME,
  CHECKPOINT_QUARTET,
  primaryMarkerPath,
  legacyMarkerPath,
  namespacedMarkerBasenameForSession,
} from './marker-paths.mjs'

// ---------------------------------------------------------------------------
// Strict-lstat helpers (relocated from stop-gate-helpers.mjs).
//
// `_maxMtimeAcrossRootsStrict` — distinguishes ENOENT (marker absent at a root
// → fine to skip) from other lstat errors (EACCES, ENOTDIR, EIO, ELOOP —
// inspection failed → caller must fail closed). For fail-closed paths.
// ---------------------------------------------------------------------------
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

// Rank-2 (PR for checkpoint-quartet) — own-session strict helper for the
// 4 checkpoint quartet markers. Per codex plan-tier R2 P1-B + R4 ACCEPT:
// the quartet carve-out is OWN-SESSION-ONLY, NOT cross-session glob like
// the plan-marker. Cross-session safety for the quartet is delegated to
// SessionStart's force-monotonic baseline probe (em-recall.mjs); the
// stop-gate carve-out at turn-end reads only this session's own marker
// (plus legacy literal during burn-in).
//
// Strict catch (R2 P2): non-ENOENT lstat errors → hadOtherError → caller
// fails closed. Sibling of _maxMtimeAcrossRootsStrict.
//
// @param {string} repoRoot
// @param {string} legacyBasename — one of CHECKPOINT_QUARTET members
// @param {string|null} sid — own session id, or null/empty → legacy-only mode
// @returns {{mtime, hadSymlink, anyExisted, hadOtherError}}
export function _maxMtimeAcrossRootsForCheckpointMarkerOwnSessionStrict(
  repoRoot, legacyBasename, sid
) {
  let mtime = -Infinity
  let hadSymlink = false
  let anyExisted = false
  let hadOtherError = false

  // Build paths to probe — own-session suffixed AND legacy literal, each
  // at both roots. Other sessions' suffixed markers NOT included —
  // that's the point of the rank-2 fix.
  const paths = [
    primaryMarkerPath(repoRoot, legacyBasename),
    legacyMarkerPath(repoRoot, legacyBasename),
  ]
  if (sid) {
    const ownBasename = `${legacyBasename}.${sid}`
    paths.push(primaryMarkerPath(repoRoot, ownBasename))
    paths.push(legacyMarkerPath(repoRoot, ownBasename))
  }

  for (const p of paths) {
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

// ---------------------------------------------------------------------------
// Relaxed helpers + carve-out predicate (relocated from em-recall.mjs:175-295).
//
// Stop-gate carve-out (#146 A2). Pure function — testable in isolation.
//
// Returns true iff the stop-gate should treat the current turn as having no
// real task signal (e.g. session-start handoff y/n + workplan display) and
// allow stop despite an armed .checkpoint-required.
//
// Invariant: every TASK_SIGNAL_MARKERS member at EITHER root (primary or
// legacy) must be either absent or have mtime <= .session-baseline mtime.
// A signal mtime > baseline means it was created/touched mid-session,
// which is the case the gate must catch.
//
// Dual-root semantics (.checkpoints/ migration): baselineMtime is the MAX
// of primary and legacy baseline mtimes (whichever is most recent).
// Per-marker mtime is the MAX across both roots.
//
// .session-baseline is written/touched by enforce-contract --session-start
// (called from hooks/em-recall-sessionstart.sh; relocated from em-recall in
// RFC-008 P3d). If missing at both roots, the carve-out does not apply
// (conservative — pre-existing sessions before this fix shipped).
//
// SubagentStop semantics (P1-1): the same predicate runs for SubagentStop.
// A subagent that wrote files would have caused checkpoint-gate to arm
// .post-checkpoint-required (mtime > baseline), denying the carve-out. A
// subagent that did read-only work satisfies the carve-out — same semantics
// as the parent's no-task-signal turn, which is the desired behavior.
//
// Symlink defense (P2-2): uses lstatSync so a symlink to an old file cannot
// trick the carve-out into firing. ANY symlink — baseline or marker, at
// EITHER root — causes the carve-out to FAIL CLOSED. Same-class symmetry
// per feedback_same_class_completeness.md. Codex round-1 P2 finding
// (episode 20260505-124511-...-845f) reproduced the asymmetry.
// ---------------------------------------------------------------------------
export function _maxMtimeAcrossRoots(repoRoot, basename) {
  // Returns { mtime, hadSymlink, anyExisted }. mtime is the max across both
  // roots. If either side is a symlink, hadSymlink=true (caller fails closed).
  let mtime = -Infinity
  let hadSymlink = false
  let anyExisted = false
  for (const p of [primaryMarkerPath(repoRoot, basename), legacyMarkerPath(repoRoot, basename)]) {
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) { hadSymlink = true; continue }
      anyExisted = true
      if (st.mtimeMs > mtime) mtime = st.mtimeMs
    } catch {}
  }
  return { mtime, hadSymlink, anyExisted }
}

// #268 fix E19: non-strict plan-marker variant for carve-out. Scans BOTH
// legacy `.plan-approval-pending` AND any `.plan-approval-pending.<sid>`
// at primary + legacy roots; returns max mtime across the set.
//
// Symmetric with _maxMtimeAcrossRoots (relaxed: lstat errors silently
// skipped). Use this for carve-out (NON-fail-closed) sites; for stop-gate
// fail-closed sites use _maxMtimeAcrossRootsForPlanMarkerStrict above.
export function _maxMtimeAcrossRootsForPlanMarker(repoRoot) {
  let mtime = -Infinity
  let hadSymlink = false
  let anyExisted = false
  for (const p of [
    primaryMarkerPath(repoRoot, PLAN_MARKER_LEGACY_BASENAME),
    legacyMarkerPath(repoRoot, PLAN_MARKER_LEGACY_BASENAME),
  ]) {
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) { hadSymlink = true; continue }
      anyExisted = true
      if (st.mtimeMs > mtime) mtime = st.mtimeMs
    } catch {}
  }
  const prefix = `${PLAN_MARKER_LEGACY_BASENAME}.`
  for (const dir of [path.join(repoRoot, PRIMARY_MARKER_DIR), path.join(repoRoot, LEGACY_MARKER_DIR)]) {
    let entries
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      const p = path.join(dir, name)
      try {
        const st = fs.lstatSync(p)
        if (st.isSymbolicLink()) { hadSymlink = true; continue }
        anyExisted = true
        if (st.mtimeMs > mtime) mtime = st.mtimeMs
      } catch {}
    }
  }
  return { mtime, hadSymlink, anyExisted }
}

// Rank-2: resolve a session-aware marker read. Resolution order:
//   1. <root>/.checkpoints/<legacy>.<sid>     (own-session, primary)
//   2. <root>/.claude/<legacy>.<sid>          (own-session, legacy root)
//   3. <root>/.checkpoints/<legacy>           (legacy literal, primary)
//   4. <root>/.claude/<legacy>                (legacy literal, legacy root)
//
// Returns the first existing path or null. Other sessions' suffixed
// markers are intentionally NOT probed — own-session semantic per
// rank-2 plan §3 trust model.
//
// When sid is null/empty, only steps 3-4 are tried (legacy-literal-only
// fallback for invalid/missing sid). Symlink-aware via fs.existsSync
// (which follows links); callers needing symlink-fail-closed must
// re-check with lstatSync.
export function resolveOwnSessionMarkerRead(repoRoot, legacyBasename, sid) {
  if (sid) {
    const ownBasename = namespacedMarkerBasenameForSession(legacyBasename, sid)
    const ownPrimary = primaryMarkerPath(repoRoot, ownBasename)
    if (fs.existsSync(ownPrimary)) return ownPrimary
    const ownLegacy = legacyMarkerPath(repoRoot, ownBasename)
    if (fs.existsSync(ownLegacy)) return ownLegacy
  }
  const litPrimary = primaryMarkerPath(repoRoot, legacyBasename)
  if (fs.existsSync(litPrimary)) return litPrimary
  const litLegacy = legacyMarkerPath(repoRoot, legacyBasename)
  if (fs.existsSync(litLegacy)) return litLegacy
  return null
}

export function stopGateCarveOutApplies(repoRoot, sid) {
  const base = _maxMtimeAcrossRoots(repoRoot, BASELINE_NAME)
  if (base.hadSymlink) return false
  if (!base.anyExisted) return false
  const baselineMtime = base.mtime

  for (const name of TASK_SIGNAL_MARKERS) {
    let m
    if (name === PLAN_MARKER_LEGACY_BASENAME) {
      // #268 fix E19: plan-marker member glob-expands suffixed forms
      // (cross-session — plan-pending deferral is global-by-design).
      m = _maxMtimeAcrossRootsForPlanMarker(repoRoot)
    } else if (CHECKPOINT_QUARTET.includes(name)) {
      // Rank-2 (codex R2 P1-B + R4 ACCEPT): quartet carve-out is
      // OWN-SESSION-ONLY — read own `<name>.<sid>` + legacy literal,
      // NEVER other sessions' suffixed forms. Cross-session safety is
      // delegated to SessionStart's force-monotonic baseline probe.
      // Strict catch (R2 P2): non-ENOENT errors fail closed.
      const strict = _maxMtimeAcrossRootsForCheckpointMarkerOwnSessionStrict(
        repoRoot, name, sid)
      if (strict.hadOtherError) return false
      m = strict
    } else {
      m = _maxMtimeAcrossRoots(repoRoot, name)
    }
    // Symlink at either root → fail closed.
    if (m.hadSymlink) return false
    // Marker absent at both roots → no signal; skip.
    if (!m.anyExisted) continue
    // Mid-session signal → fail closed.
    if (m.mtime > baselineMtime) return false
  }
  return true
}
