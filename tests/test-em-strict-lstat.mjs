#!/usr/bin/env node
// test-em-strict-lstat.mjs — Level-2 in-process unit tests for
// _maxMtimeAcrossRootsStrict (scripts/lib/marker-state.mjs — relocated from
// stop-gate-helpers.mjs in RFC-008 P3a).
//
// Codex round-6 F17: prove the strict-error PATH is reached (not just
// a tautological BLOCK from a downstream effect). Imports the helper
// directly and asserts internal state: hadOtherError === true when a
// non-ENOENT lstat error occurs at either root.
//
// Coverage:
//   U1  absent at both roots          → anyExisted=false, hadSymlink=false, hadOtherError=false
//   U2  ENOENT primary + active legacy → anyExisted=true,  hadSymlink=false, hadOtherError=false
//   U3  symlink primary + absent legacy → anyExisted=false, hadSymlink=true,  hadOtherError=false
//   U4  ENOTDIR primary + active legacy → anyExisted=true,  hadSymlink=false, hadOtherError=true   ← F17 proof
//   U5  active primary + active legacy  → anyExisted=true,  hadSymlink=false, hadOtherError=false

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { _maxMtimeAcrossRootsStrict } from '../scripts/lib/marker-state.mjs'

let pass = 0
let fail = 0
const failures = []

function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) {
  fail++; failures.push(`${name}: ${detail}`)
  console.log(`  ✗ ${name}: ${detail}`)
}

function mkRepo(label) {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), `em-strict-${label}-`))
  const d = fs.realpathSync(raw)
  execSync(`git init -q -b main "${d}"`)
  return d
}

function setMtime(p, ms) {
  const t = ms / 1000
  fs.utimesSync(p, t, t)
}

const cleanupDirs = []
process.on('exit', () => {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

console.log('\n=== U1-U5 — _maxMtimeAcrossRootsStrict in-process semantics ===')

// U1 — absent at both roots
{
  const d = mkRepo('u1'); cleanupDirs.push(d)
  fs.mkdirSync(path.join(d, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
  const r = _maxMtimeAcrossRootsStrict(d, '.plan-approval-pending')
  if (r.anyExisted === false && r.hadSymlink === false && r.hadOtherError === false && r.mtime === -Infinity) {
    ok('U1: absent at both roots → anyExisted=false, hadOtherError=false')
  } else {
    bad('U1', `got: ${JSON.stringify(r)}`)
  }
}

// U2 — ENOENT primary + active legacy
{
  const d = mkRepo('u2'); cleanupDirs.push(d)
  fs.mkdirSync(path.join(d, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
  const legacy = path.join(d, '.claude', '.plan-approval-pending')
  fs.writeFileSync(legacy, '')
  setMtime(legacy, Date.now())
  const r = _maxMtimeAcrossRootsStrict(d, '.plan-approval-pending')
  if (r.anyExisted === true && r.hadSymlink === false && r.hadOtherError === false && r.mtime > 0) {
    ok('U2: ENOENT primary + active legacy → anyExisted=true, hadOtherError=false')
  } else {
    bad('U2', `got: ${JSON.stringify(r)}`)
  }
}

// U3 — symlink primary + absent legacy
{
  const d = mkRepo('u3'); cleanupDirs.push(d)
  fs.mkdirSync(path.join(d, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
  // Real file + symlink to it
  const real = path.join(d, '.checkpoints', 'real-target')
  fs.writeFileSync(real, '')
  fs.symlinkSync(real, path.join(d, '.checkpoints', '.plan-approval-pending'))
  const r = _maxMtimeAcrossRootsStrict(d, '.plan-approval-pending')
  if (r.anyExisted === false && r.hadSymlink === true && r.hadOtherError === false) {
    ok('U3: symlink primary + absent legacy → hadSymlink=true, hadOtherError=false')
  } else {
    bad('U3', `got: ${JSON.stringify(r)}`)
  }
}

// U4 — ENOTDIR primary + active legacy  ← F17 proof
// Setup: primary `.checkpoints` is a REGULAR FILE, not a directory.
// lstat(<repo>/.checkpoints/.plan-approval-pending) fails with ENOTDIR
// (because `.checkpoints` is not a directory). The helper must set
// hadOtherError=true (not skip silently as ENOENT).
{
  const d = mkRepo('u4'); cleanupDirs.push(d)
  // PRIMARY: regular file at .checkpoints (NOT a directory) → ENOTDIR on child
  fs.writeFileSync(path.join(d, '.checkpoints'), 'not-a-dir')
  // LEGACY: active plan-pending
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
  const legacy = path.join(d, '.claude', '.plan-approval-pending')
  fs.writeFileSync(legacy, '')
  setMtime(legacy, Date.now())
  const r = _maxMtimeAcrossRootsStrict(d, '.plan-approval-pending')
  // Defensive: confirm setup — primary `.checkpoints` IS a regular file at check time
  const st = fs.lstatSync(path.join(d, '.checkpoints'))
  if (!st.isFile()) {
    bad('U4 setup', `expected .checkpoints to be a regular file, got mode ${st.mode.toString(8)}`)
  } else {
    if (r.hadOtherError === true && r.anyExisted === true && r.hadSymlink === false) {
      ok('U4 (F17): ENOTDIR primary + active legacy → hadOtherError=true (PROVES strict-error path reached)')
    } else {
      bad('U4', `expected hadOtherError=true, got: ${JSON.stringify(r)}`)
    }
  }
}

// U5 — both roots active
{
  const d = mkRepo('u5'); cleanupDirs.push(d)
  fs.mkdirSync(path.join(d, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
  const primary = path.join(d, '.checkpoints', '.plan-approval-pending')
  const legacy = path.join(d, '.claude', '.plan-approval-pending')
  fs.writeFileSync(primary, '')
  fs.writeFileSync(legacy, '')
  const earlier = Date.now() - 60_000
  const later = Date.now()
  setMtime(primary, earlier)
  setMtime(legacy, later)
  const r = _maxMtimeAcrossRootsStrict(d, '.plan-approval-pending')
  if (r.anyExisted === true && r.hadSymlink === false && r.hadOtherError === false) {
    // mtime should be max of the two — take the later one
    const expected = fs.lstatSync(legacy).mtimeMs
    if (Math.abs(r.mtime - expected) < 100) {
      ok('U5: both roots active → mtime = max(primary, legacy)')
    } else {
      bad('U5', `expected mtime≈${expected}, got ${r.mtime}`)
    }
  } else {
    bad('U5', `got: ${JSON.stringify(r)}`)
  }
}

console.log('\n==================================================')
console.log(`Results: ${pass} passed, ${fail} failed`)
console.log('==================================================')
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
process.exit(0)
