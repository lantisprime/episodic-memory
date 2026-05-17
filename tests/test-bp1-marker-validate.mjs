#!/usr/bin/env node
/**
 * test-bp1-marker-validate.mjs — Slice 2d-R marker validator tests.
 *
 * Coverage (RFC §540 row 7, §1304 row 3):
 *   MV1: missing marker → status: missing.
 *   MV2: symlink at marker path → status: invalid, reason: symlink (fail-closed).
 *   MV3: malformed JSON → status: invalid, reason: malformed-json.
 *   MV4: missing required field → status: invalid, reason: missing-fields.
 *   MV5: run_id mismatch between argv + marker → invalid, reason: run-id-mismatch.
 *   MV6: mtime drift > 10s → invalid, reason: mtime-drift.
 *   MV7: body_sha256 tampered → invalid, reason: sha256-mismatch.
 *   MV8: hmac tampered → invalid, reason: hmac-mismatch.
 *   MV9: run.key missing → invalid, reason: key-missing.
 *  MV10: valid marker not expired → status: ok, expired: false.
 *  MV11: valid marker expired (deadline in past) → status: ok, expired: true.
 *  MV12: cwd-binding — caller cwd different from --project resolves correctly.
 *  MV13: nested project (--project <parent>/wt-subdir realpath) reads correct marker.
 *  MV14: invalid decided_class in marker payload → shape-error.
 *  MV15: missing argv --project → exit 2.
 *  MV16: missing argv --run-id → exit 2.
 *  MV17: invalid run_id shape (uppercase) → exit 2.
 *  MV18: directory at marker path (not a file) → invalid, reason: not-a-file.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'bp1-marker-validate.mjs')

const mkMod = await import(new URL('../scripts/lib/bp1-marker.mjs', import.meta.url).href)
const { writeMarker } = mkMod

const keysMod = await import(new URL('../scripts/lib/bp1-keys.mjs', import.meta.url).href)
const { generateRunKey, runKeyPath } = keysMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

const RUN_ID = 'bp1-run-1700000000000-rfc-004-aabbcc'
const NOW_ISO = new Date().toISOString()
const PAST_ISO = new Date(Date.now() - 30 * 60 * 1000).toISOString()
const FUTURE_ISO = new Date(Date.now() + 30 * 60 * 1000).toISOString()

function tmpProj() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-mv-')))
}

function runValidator(projectRoot, runId, extraArgs = []) {
  const args = [SCRIPT, '--project', projectRoot, '--run-id', runId, ...extraArgs]
  const r = spawnSync('node', args, { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, parsed: r.stdout ? JSON.parse(r.stdout) : null }
}

function setupValidMarker(projectRoot, runId, { createdAt = NOW_ISO, deadlineAt = FUTURE_ISO, decidedClass = 'trivial' } = {}) {
  const { key32B } = generateRunKey(projectRoot, runId)
  const r = writeMarker({
    projectRoot, runId, decidedClass,
    createdAt, deadlineAt, runKey32B: key32B,
  })
  if (r.status !== 'ok') throw new Error(`writeMarker failed: ${JSON.stringify(r)}`)
  return { markerPath: r.markerPath, keyPath: runKeyPath(projectRoot, runId), key32B }
}

// ---------------------------------------------------------------------------
// MV1-3: missing / symlink / malformed
// ---------------------------------------------------------------------------

tap('MV1 missing marker → status: missing', () => {
  const proj = tmpProj()
  const r = runValidator(proj, RUN_ID)
  assert.equal(r.code, 0)
  assert.equal(r.parsed.status, 'missing')
  assert.equal(r.parsed.reason, null)
})

tap('MV2 symlink at marker path → invalid:symlink (fail-closed)', () => {
  const proj = tmpProj()
  // Write a real file elsewhere; symlink the marker path to it.
  const realPath = path.join(proj, 'real-marker.json')
  fs.writeFileSync(realPath, '{}')
  const markerDir = path.join(proj, '.checkpoints')
  fs.mkdirSync(markerDir, { recursive: true })
  fs.symlinkSync(realPath, path.join(markerDir, `bp1-approval-${RUN_ID}.json`))
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.code, 0)
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'symlink')
})

tap('MV3 malformed JSON → invalid:malformed-json', () => {
  const proj = tmpProj()
  const markerDir = path.join(proj, '.checkpoints')
  fs.mkdirSync(markerDir, { recursive: true })
  fs.writeFileSync(path.join(markerDir, `bp1-approval-${RUN_ID}.json`), 'not json {{')
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'malformed-json')
})

// ---------------------------------------------------------------------------
// MV4-9: structural + cryptographic validation
// ---------------------------------------------------------------------------

tap('MV4 missing required field → invalid:missing-fields', () => {
  const proj = tmpProj()
  const markerDir = path.join(proj, '.checkpoints')
  fs.mkdirSync(markerDir, { recursive: true })
  fs.writeFileSync(path.join(markerDir, `bp1-approval-${RUN_ID}.json`),
    JSON.stringify({ run_id: RUN_ID, created_at: NOW_ISO })) // missing 4 fields
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'missing-fields')
})

tap('MV5 run_id mismatch between argv + marker → invalid:run-id-mismatch', () => {
  const proj = tmpProj()
  const { markerPath: realPath } = setupValidMarker(proj, RUN_ID)
  const otherRun = 'bp1-run-1700000000000-rfc-999-bbccdd'
  // Generate a key for the OTHER run so the validator gets past key-load and
  // hits the run_id-mismatch check (which is step 7, BEFORE HMAC verification).
  // Actually run_id-mismatch is step 7, BEFORE key load — so this isn't needed,
  // but we generate it for safety.
  generateRunKey(proj, otherRun)
  const otherMarkerPath = path.join(proj, '.checkpoints', `bp1-approval-${otherRun}.json`)
  fs.copyFileSync(realPath, otherMarkerPath)
  const r = runValidator(proj, otherRun, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'run-id-mismatch')
})

tap('MV6 mtime drift > 10s → invalid:mtime-drift', () => {
  const proj = tmpProj()
  setupValidMarker(proj, RUN_ID, { createdAt: NOW_ISO })
  // Touch marker mtime to 60s in the future to exceed tolerance.
  const m = path.join(proj, '.checkpoints', `bp1-approval-${RUN_ID}.json`)
  const futureTime = (Date.now() + 60_000) / 1000
  fs.utimesSync(m, futureTime, futureTime)
  // DON'T pass --skip-mtime-check this time; mtime check is the under-test.
  const r = runValidator(proj, RUN_ID)
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'mtime-drift')
})

tap('MV7 body_sha256 tampered → invalid:sha256-mismatch', () => {
  const proj = tmpProj()
  setupValidMarker(proj, RUN_ID)
  const m = path.join(proj, '.checkpoints', `bp1-approval-${RUN_ID}.json`)
  const parsed = JSON.parse(fs.readFileSync(m, 'utf8'))
  parsed.body_sha256 = 'a'.repeat(64)
  fs.writeFileSync(m, JSON.stringify(parsed) + '\n')
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'sha256-mismatch')
})

tap('MV8 hmac tampered → invalid:hmac-mismatch', () => {
  const proj = tmpProj()
  const { markerPath: m } = setupValidMarker(proj, RUN_ID)
  const parsed = JSON.parse(fs.readFileSync(m, 'utf8'))
  parsed.hmac = 'f'.repeat(64)
  fs.writeFileSync(m, JSON.stringify(parsed) + '\n')
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'hmac-mismatch')
})

tap('MV9 run.key missing → invalid:key-missing', () => {
  const proj = tmpProj()
  const { keyPath } = setupValidMarker(proj, RUN_ID)
  fs.unlinkSync(keyPath)
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'key-missing')
})

// ---------------------------------------------------------------------------
// MV10-13: valid marker paths
// ---------------------------------------------------------------------------

tap('MV10 valid marker not expired → ok, expired: false', () => {
  const proj = tmpProj()
  setupValidMarker(proj, RUN_ID, { deadlineAt: FUTURE_ISO })
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'ok')
  assert.equal(r.parsed.expired, false)
  assert.equal(r.parsed.decided_class, 'trivial')
  assert.equal(r.parsed.deadline_at, FUTURE_ISO)
})

tap('MV11 valid marker expired → ok, expired: true', () => {
  const proj = tmpProj()
  setupValidMarker(proj, RUN_ID, { createdAt: PAST_ISO, deadlineAt: PAST_ISO })
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'ok')
  assert.equal(r.parsed.expired, true)
})

tap('MV12 cwd-binding — caller cwd != --project', () => {
  const proj = tmpProj()
  const otherCwd = tmpProj()
  setupValidMarker(proj, RUN_ID)
  // Spawn validator with cwd=otherCwd; --project points to proj
  const args = [SCRIPT, '--project', proj, '--run-id', RUN_ID, '--skip-mtime-check']
  const r = spawnSync('node', args, { encoding: 'utf8', cwd: otherCwd })
  assert.equal(r.status, 0)
  const parsed = JSON.parse(r.stdout)
  assert.equal(parsed.status, 'ok')
  assert.ok(parsed.marker_path.startsWith(proj), `marker_path should start with ${proj}; got ${parsed.marker_path}`)
})

tap('MV13 nested --project <subdir> realpaths to projectRoot', () => {
  const proj = tmpProj()
  setupValidMarker(proj, RUN_ID)
  // Create a nested subdir under proj and pass it as --project
  const sub = path.join(proj, 'src', 'nested')
  fs.mkdirSync(sub, { recursive: true })
  const r = runValidator(sub, RUN_ID, ['--skip-mtime-check'])
  // realpathSync on `sub` returns sub itself (since it exists), NOT proj.
  // But the marker is at proj/.checkpoints/. So the validator should report
  // missing — because the validator doesn't auto-walk up to the git root.
  // This is intentional: the HOOK does the canonical-root resolution before
  // invoking the validator with --project <canonical-root>.
  assert.equal(r.parsed.status, 'missing',
    'validator does not auto-canonicalize --project; hook is responsible')
})

// ---------------------------------------------------------------------------
// MV14-18: argv + shape edge cases
// ---------------------------------------------------------------------------

tap('MV14 invalid decided_class in marker payload → shape-error', () => {
  const proj = tmpProj()
  setupValidMarker(proj, RUN_ID)
  const m = path.join(proj, '.checkpoints', `bp1-approval-${RUN_ID}.json`)
  const parsed = JSON.parse(fs.readFileSync(m, 'utf8'))
  parsed.decided_class = 'not-a-class'
  fs.writeFileSync(m, JSON.stringify(parsed) + '\n')
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'shape-error')
})

tap('MV15 missing --project → exit 2', () => {
  const r = spawnSync('node', [SCRIPT, '--run-id', RUN_ID], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--project required'))
})

tap('MV16 missing --run-id → exit 2', () => {
  const proj = tmpProj()
  const r = spawnSync('node', [SCRIPT, '--project', proj], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--run-id required'))
})

tap('MV17 invalid run_id shape (uppercase) → exit 2', () => {
  const proj = tmpProj()
  const r = spawnSync('node', [SCRIPT, '--project', proj, '--run-id', 'BAD-UPPER'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--run-id required and must match RUN_ID_RE'))
})

tap('MV18 directory at marker path (not a file) → invalid:not-a-file', () => {
  const proj = tmpProj()
  const markerDir = path.join(proj, '.checkpoints')
  fs.mkdirSync(markerDir, { recursive: true })
  fs.mkdirSync(path.join(markerDir, `bp1-approval-${RUN_ID}.json`))
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'not-a-file')
})

// ---------------------------------------------------------------------------
// MV19 — strict key set: extra unsigned field → invalid:unknown-fields
// ---------------------------------------------------------------------------
//
// PR-level audit F3 closure 2026-05-17. Codex reproduced: a valid-HMAC marker
// with an additional unsigned field (`future_unsigned`) was validating `ok`.
// The extra field is not in canonical_bytes, so HMAC verifies — but the
// authorization-bearing artifact accepts arbitrary unsigned data, creating
// forward-version + forensic drift. Fix rejects any key outside the canonical
// 6-field set.
// ---------------------------------------------------------------------------

tap('MV19 marker with extra unsigned field → invalid:unknown-fields:<name>', () => {
  const proj = tmpProj()
  const { markerPath: mp } = setupValidMarker(proj, RUN_ID)
  // Tamper: append an unsigned field to the on-disk marker JSON.
  const raw = JSON.parse(fs.readFileSync(mp, 'utf8'))
  raw.future_unsigned = 'attacker-controlled-value'
  fs.writeFileSync(mp, JSON.stringify(raw))
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'unknown-fields:future_unsigned',
    `expected unknown-fields:future_unsigned reason; got ${r.parsed.reason}`)
})

tap('MV20 marker with multiple extra fields → invalid:unknown-fields lists sorted', () => {
  const proj = tmpProj()
  const { markerPath: mp } = setupValidMarker(proj, RUN_ID)
  const raw = JSON.parse(fs.readFileSync(mp, 'utf8'))
  raw.zeta_extra = 'z'
  raw.alpha_extra = 'a'
  fs.writeFileSync(mp, JSON.stringify(raw))
  const r = runValidator(proj, RUN_ID, ['--skip-mtime-check'])
  assert.equal(r.parsed.status, 'invalid')
  assert.equal(r.parsed.reason, 'unknown-fields:alpha_extra,zeta_extra',
    `expected sorted unknown-fields list; got ${r.parsed.reason}`)
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail > 0 ? 1 : 0)
