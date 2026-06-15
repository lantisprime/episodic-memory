#!/usr/bin/env node
// test-marker-state.mjs — unit tests for scripts/lib/marker-state.mjs
// (RFC-008 P3a). These carve-out helpers were previously module-private inside
// em-recall.mjs (the relaxed _maxMtimeAcrossRoots* helpers, resolveOwnSessionMarkerRead,
// stopGateCarveOutApplies) or lived in stop-gate-helpers.mjs (the 3 strict
// helpers, covered additionally by test-em-strict-lstat.mjs). The move into the
// enforcement-owned marker-state module is a PURE EXTRACTION; these tests pin the
// semantics so any future behavior drift is caught directly at the lib boundary.
//
// Coverage includes the negative-scenario-planner's P3a-required cases:
//   - symlink-fail-closed (carve-out returns false on a symlinked baseline/marker)
//   - dual-root active-legacy (active .claude/ marker + absent primary → detected)
//   - null-sid parity (resolveOwnSessionMarkerRead degrades to legacy literal)

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  _maxMtimeAcrossRoots,
  _maxMtimeAcrossRootsForPlanMarker,
  _maxMtimeAcrossRootsForPlanMarkerStrict,
  _maxMtimeAcrossRootsForCheckpointMarkerOwnSessionStrict,
  resolveOwnSessionMarkerRead,
  stopGateCarveOutApplies,
} from '../scripts/lib/marker-state.mjs'
import {
  PRIMARY_MARKER_DIR,
  LEGACY_MARKER_DIR,
  BASELINE_NAME,
  PLAN_MARKER_LEGACY_BASENAME,
  primaryMarkerPath,
  legacyMarkerPath,
} from '../scripts/lib/marker-paths.mjs'

let pass = 0
let fail = 0
const failures = []

function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) {
  fail++; failures.push(`${name}: ${detail}`)
  console.log(`  ✗ ${name}: ${detail}`)
}
function eq(name, actual, expected) {
  if (actual === expected) ok(name)
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// Fresh isolated repo root per test, with both marker roots present.
function mkRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-state-'))
  fs.mkdirSync(path.join(repo, PRIMARY_MARKER_DIR), { recursive: true })
  fs.mkdirSync(path.join(repo, LEGACY_MARKER_DIR), { recursive: true })
  return repo
}
// Write a marker file with an explicit mtime (epoch seconds).
function writeMarker(p, mtimeSec) {
  fs.writeFileSync(p, '')
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec)
}

const SID = 'abc-123'

// ---------------------------------------------------------------------------
// _maxMtimeAcrossRoots (relaxed)
// ---------------------------------------------------------------------------
{
  const repo = mkRepo()
  const r = _maxMtimeAcrossRoots(repo, BASELINE_NAME)
  eq('relaxed: absent both roots → anyExisted=false', r.anyExisted, false)
  eq('relaxed: absent both roots → hadSymlink=false', r.hadSymlink, false)
}
{
  const repo = mkRepo()
  // Primary older (100), legacy newer (200) → mtime is the MAX (200s = 200000ms).
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 100)
  writeMarker(legacyMarkerPath(repo, BASELINE_NAME), 200)
  const r = _maxMtimeAcrossRoots(repo, BASELINE_NAME)
  eq('relaxed: max across roots → anyExisted=true', r.anyExisted, true)
  eq('relaxed: max across roots → mtime = newer (legacy 200)', Math.round(r.mtime), 200000)
}
{
  const repo = mkRepo()
  const target = primaryMarkerPath(repo, BASELINE_NAME)
  fs.symlinkSync('/nonexistent-target', target)
  const r = _maxMtimeAcrossRoots(repo, BASELINE_NAME)
  eq('relaxed: symlink primary → hadSymlink=true', r.hadSymlink, true)
  eq('relaxed: symlink primary → anyExisted=false', r.anyExisted, false)
}

// ---------------------------------------------------------------------------
// _maxMtimeAcrossRootsForPlanMarker (relaxed glob of legacy + suffixed)
// ---------------------------------------------------------------------------
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME), 100)            // legacy literal
  writeMarker(primaryMarkerPath(repo, `${PLAN_MARKER_LEGACY_BASENAME}.${SID}`), 300) // suffixed, newer
  const r = _maxMtimeAcrossRootsForPlanMarker(repo)
  eq('plan-marker glob: anyExisted=true', r.anyExisted, true)
  eq('plan-marker glob: mtime = newest suffixed (300)', Math.round(r.mtime), 300000)
}
{
  const repo = mkRepo()
  fs.symlinkSync('/nonexistent', primaryMarkerPath(repo, `${PLAN_MARKER_LEGACY_BASENAME}.${SID}`))
  const r = _maxMtimeAcrossRootsForPlanMarker(repo)
  eq('plan-marker glob: symlinked suffixed form → hadSymlink=true', r.hadSymlink, true)
}

// ---------------------------------------------------------------------------
// _maxMtimeAcrossRootsForPlanMarkerStrict (fail-closed)
// ---------------------------------------------------------------------------
{
  const repo = mkRepo()
  fs.symlinkSync('/nonexistent', primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME))
  const r = _maxMtimeAcrossRootsForPlanMarkerStrict(repo)
  eq('plan-marker strict: symlink → hadSymlink=true', r.hadSymlink, true)
  eq('plan-marker strict: symlink → hadOtherError=false', r.hadOtherError, false)
}

// ---------------------------------------------------------------------------
// _maxMtimeAcrossRootsForCheckpointMarkerOwnSessionStrict
// ---------------------------------------------------------------------------
{
  // ENOTDIR: make the PRIMARY marker root a regular file (not a dir) so lstat of
  // any marker path under it errs non-ENOENT (ENOTDIR) → strict helper fails closed.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-state-'))
  fs.writeFileSync(path.join(repo, PRIMARY_MARKER_DIR), '') // .checkpoints is a FILE
  fs.mkdirSync(path.join(repo, LEGACY_MARKER_DIR), { recursive: true })
  const r = _maxMtimeAcrossRootsForCheckpointMarkerOwnSessionStrict(repo, '.checkpoint-required', SID)
  eq('quartet strict: ENOTDIR under non-dir primary root → hadOtherError=true', r.hadOtherError, true)
}

// ---------------------------------------------------------------------------
// resolveOwnSessionMarkerRead
// ---------------------------------------------------------------------------
{
  const repo = mkRepo()
  const own = primaryMarkerPath(repo, `.checkpoint-required.${SID}`)
  writeMarker(own, 100)
  eq('resolve: own-session primary preferred', resolveOwnSessionMarkerRead(repo, '.checkpoint-required', SID), own)
}
{
  const repo = mkRepo()
  const lit = primaryMarkerPath(repo, '.checkpoint-required')
  writeMarker(lit, 100)
  eq('resolve: falls back to legacy literal when own absent', resolveOwnSessionMarkerRead(repo, '.checkpoint-required', SID), lit)
}
{
  const repo = mkRepo()
  const lit = primaryMarkerPath(repo, '.checkpoint-required')
  writeMarker(lit, 100)
  // null sid → own-session steps skipped → returns literal (planner null-sid parity)
  eq('resolve: null sid degrades to legacy literal', resolveOwnSessionMarkerRead(repo, '.checkpoint-required', null), lit)
}
{
  const repo = mkRepo()
  eq('resolve: nothing exists → null', resolveOwnSessionMarkerRead(repo, '.checkpoint-required', SID), null)
}

// ---------------------------------------------------------------------------
// stopGateCarveOutApplies
// ---------------------------------------------------------------------------
{
  const repo = mkRepo()
  // No baseline → conservative false.
  eq('carve-out: no baseline → false', stopGateCarveOutApplies(repo, SID), false)
}
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 1000)
  // All task-signal markers absent → carve-out applies.
  eq('carve-out: baseline present, no markers → true', stopGateCarveOutApplies(repo, SID), true)
}
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 1000)
  // Quartet marker (own-session) NEWER than baseline → mid-session signal → false.
  writeMarker(primaryMarkerPath(repo, `.checkpoint-required.${SID}`), 2000)
  eq('carve-out: own-session quartet newer than baseline → false', stopGateCarveOutApplies(repo, SID), false)
}
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 1000)
  // Marker OLDER than baseline → stale → carve-out still applies.
  writeMarker(primaryMarkerPath(repo, `.checkpoint-required.${SID}`), 500)
  eq('carve-out: marker older than baseline → true', stopGateCarveOutApplies(repo, SID), true)
}
{
  // Planner dual-root case: baseline in PRIMARY, active marker only in LEGACY
  // (.claude/), absent in primary → must still be detected as mid-session.
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 1000)
  writeMarker(legacyMarkerPath(repo, `.checkpoint-required.${SID}`), 2000)
  eq('carve-out: dual-root active-legacy quartet newer → false', stopGateCarveOutApplies(repo, SID), false)
}
{
  // Symlink-fail-closed: symlinked baseline → carve-out false.
  const repo = mkRepo()
  fs.symlinkSync('/nonexistent', primaryMarkerPath(repo, BASELINE_NAME))
  eq('carve-out: symlinked baseline → false (fail-closed)', stopGateCarveOutApplies(repo, SID), false)
}
{
  // Symlink-fail-closed on a task-signal marker (plan-marker) → false.
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 1000)
  fs.symlinkSync('/nonexistent', primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME))
  eq('carve-out: symlinked plan-marker → false (fail-closed)', stopGateCarveOutApplies(repo, SID), false)
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
