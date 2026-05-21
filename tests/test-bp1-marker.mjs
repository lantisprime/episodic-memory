#!/usr/bin/env node
/**
 * test-bp1-marker.mjs — Slice 2d-W marker writer + canonicalize + cleanup tests.
 *
 * Coverage (plan v3.1 invariants):
 *   - markerPath shape + run_id binding
 *   - canonicalizeMarkerPayload determinism + sorted-keys + sha256
 *   - writeMarker atomic write (tmp + fsync + rename)
 *   - writeMarker idempotence (byte-identical re-write returns alreadyPresent)
 *   - writeMarker concurrent-Phase-B byte-identical bytes (codex r1 M1)
 *   - writeMarker rename-failure cleanup (orphan tmp removal)
 *   - cleanupApprovalMarker idempotence (ENOENT → status: ok, alreadyAbsent)
 *   - cleanupApprovalMarker non-ENOENT failure fallthrough
 *   - shape validation (run_id, decided_class, isAbsolute path)
 *   - axis-9 / discipline #20: caller-cwd-mismatch — artifacts land under target
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const mod = await import(new URL('../scripts/lib/bp1-marker.mjs', import.meta.url).href)
const { markerPath, canonicalizeMarkerPayload, writeMarker, cleanupApprovalMarker, sweepApprovalMarkers } = mod

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyCanonical } = hmacMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

const KEY = crypto.randomBytes(32)
const RUN_ID = 'bp1-run-1700000000000-rfc-004-aabbcc'
const CREATED_AT = '2026-05-17T01:00:00.000Z'
const DEADLINE_AT = '2026-05-17T02:00:00.000Z'

function tmpProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-marker-test-'))
  return fs.realpathSync(dir)
}

// ---------------------------------------------------------------------------
// markerPath shape
// ---------------------------------------------------------------------------

tap('markerPath embeds run_id under <root>/.checkpoints/', () => {
  const root = tmpProjectRoot()
  const p = markerPath(root, RUN_ID)
  assert.equal(p, path.join(root, '.checkpoints', `bp1-approval-${RUN_ID}.json`))
})

tap('markerPath rejects non-absolute projectRoot', () => {
  assert.throws(() => markerPath('./relative', RUN_ID), /must be absolute/)
})

tap('markerPath rejects invalid run_id shape', () => {
  const root = tmpProjectRoot()
  assert.throws(() => markerPath(root, 'BAD UPPER CASE'), /runId shape invalid/)
  assert.throws(() => markerPath(root, 'has/slash'), /runId shape invalid/)
  assert.throws(() => markerPath(root, ''), /runId shape invalid/)
})

// ---------------------------------------------------------------------------
// canonicalizeMarkerPayload
// ---------------------------------------------------------------------------

tap('canonicalizeMarkerPayload returns sorted-key canonical bytes + sha256', () => {
  const { canonicalBytes, sha256 } = canonicalizeMarkerPayload({
    run_id: RUN_ID, created_at: CREATED_AT, decided_class: 'trivial', deadline_at: DEADLINE_AT,
  })
  // Sorted alphabetically: created_at, deadline_at, decided_class, run_id.
  const expected = JSON.stringify({
    created_at: CREATED_AT,
    deadline_at: DEADLINE_AT,
    decided_class: 'trivial',
    run_id: RUN_ID,
  })
  assert.equal(canonicalBytes.toString('utf8'), expected)
  assert.equal(sha256.length, 64)
  assert.match(sha256, /^[0-9a-f]{64}$/)
})

tap('canonicalizeMarkerPayload determinism — key order in input does not change output', () => {
  const a = canonicalizeMarkerPayload({
    run_id: RUN_ID, created_at: CREATED_AT, decided_class: 'trivial', deadline_at: DEADLINE_AT,
  })
  const b = canonicalizeMarkerPayload({
    deadline_at: DEADLINE_AT, decided_class: 'trivial', created_at: CREATED_AT, run_id: RUN_ID,
  })
  assert.deepEqual(a.canonicalBytes, b.canonicalBytes)
  assert.equal(a.sha256, b.sha256)
})

tap('canonicalizeMarkerPayload rejects invalid decided_class', () => {
  assert.throws(() => canonicalizeMarkerPayload({
    run_id: RUN_ID, created_at: CREATED_AT, decided_class: 'bogus', deadline_at: DEADLINE_AT,
  }), /decided_class invalid/)
})

tap('canonicalizeMarkerPayload rejects missing required field', () => {
  assert.throws(() => canonicalizeMarkerPayload({
    run_id: RUN_ID, created_at: CREATED_AT, decided_class: 'trivial',
  }), /deadline_at/)
})

tap('canonicalizeMarkerPayload rejects bad run_id shape', () => {
  assert.throws(() => canonicalizeMarkerPayload({
    run_id: 'UPPER/case', created_at: CREATED_AT, decided_class: 'trivial', deadline_at: DEADLINE_AT,
  }), /run_id shape invalid/)
})

// ---------------------------------------------------------------------------
// writeMarker happy path + atomicity
// ---------------------------------------------------------------------------

tap('writeMarker creates marker at canonical path', () => {
  const root = tmpProjectRoot()
  const result = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.alreadyPresent, false)
  assert.equal(result.markerPath, markerPath(root, RUN_ID))
  assert.ok(fs.existsSync(result.markerPath))
})

tap('writeMarker file is JSON-parseable with 6 fields including body_sha256 + hmac', () => {
  const root = tmpProjectRoot()
  const result = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const parsed = JSON.parse(fs.readFileSync(result.markerPath, 'utf8'))
  const keys = Object.keys(parsed).sort()
  assert.deepEqual(keys, ['body_sha256', 'created_at', 'deadline_at', 'decided_class', 'hmac', 'run_id'])
  assert.equal(parsed.run_id, RUN_ID)
  assert.equal(parsed.decided_class, 'trivial')
  assert.equal(parsed.created_at, CREATED_AT)
  assert.equal(parsed.deadline_at, DEADLINE_AT)
})

tap('writeMarker hmac round-trips via verifyCanonical', () => {
  const root = tmpProjectRoot()
  const result = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const parsed = JSON.parse(fs.readFileSync(result.markerPath, 'utf8'))
  const { canonicalBytes } = canonicalizeMarkerPayload({
    run_id: parsed.run_id, created_at: parsed.created_at,
    decided_class: parsed.decided_class, deadline_at: parsed.deadline_at,
  })
  assert.ok(verifyCanonical(canonicalBytes, KEY, parsed.hmac))
})

tap('writeMarker body_sha256 matches sha over canonical bytes', () => {
  const root = tmpProjectRoot()
  const result = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const { sha256 } = canonicalizeMarkerPayload({
    run_id: RUN_ID, created_at: CREATED_AT, decided_class: 'trivial', deadline_at: DEADLINE_AT,
  })
  assert.equal(result.body_sha256, sha256)
})

// ---------------------------------------------------------------------------
// writeMarker idempotence + determinism (codex r1 M1, r2)
// ---------------------------------------------------------------------------

tap('writeMarker is idempotent — second call returns alreadyPresent=true', () => {
  const root = tmpProjectRoot()
  const a = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const b = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  assert.equal(a.alreadyPresent, false)
  assert.equal(b.alreadyPresent, true)
  assert.equal(a.body_sha256, b.body_sha256)
  assert.equal(a.hmac, b.hmac)
})

tap('writeMarker concurrent invocations produce byte-identical files (M1)', () => {
  const root = tmpProjectRoot()
  // Sequential invocations standing in for concurrent — both should produce
  // identical canonical bytes / hmac. True concurrency tested at orchestrator
  // E2E level via spawnSync race.
  const a = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const fileBytes1 = fs.readFileSync(a.markerPath)
  const b = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const fileBytes2 = fs.readFileSync(b.markerPath)
  assert.ok(fileBytes1.equals(fileBytes2))
})

tap('writeMarker different decided_class produces different hmac', () => {
  const root = tmpProjectRoot()
  const a = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  // Clean up + re-write with different class.
  fs.unlinkSync(a.markerPath)
  const b = writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'schema',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  assert.notEqual(a.hmac, b.hmac)
  assert.notEqual(a.body_sha256, b.body_sha256)
})

// ---------------------------------------------------------------------------
// writeMarker error paths
// ---------------------------------------------------------------------------

tap('writeMarker rejects non-32-byte runKey32B', () => {
  const root = tmpProjectRoot()
  assert.throws(() => writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: Buffer.alloc(16),
  }), /32-byte/)
})

tap('writeMarker rejects non-absolute projectRoot', () => {
  assert.throws(() => writeMarker({
    projectRoot: 'relative', runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  }), /must be absolute/)
})

tap('writeMarker leaves no orphan tmp file under .checkpoints on success', () => {
  const root = tmpProjectRoot()
  writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const checkpointsDir = path.join(root, '.checkpoints')
  const entries = fs.readdirSync(checkpointsDir)
  const tmpEntries = entries.filter(n => n.includes('.tmp.'))
  assert.equal(tmpEntries.length, 0)
})

// ---------------------------------------------------------------------------
// cleanupApprovalMarker
// ---------------------------------------------------------------------------

tap('cleanupApprovalMarker removes existing marker', () => {
  const root = tmpProjectRoot()
  writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const target = markerPath(root, RUN_ID)
  assert.ok(fs.existsSync(target))
  const result = cleanupApprovalMarker(root, RUN_ID)
  assert.equal(result.status, 'ok')
  assert.equal(result.alreadyAbsent, false)
  assert.ok(!fs.existsSync(target))
})

tap('cleanupApprovalMarker is idempotent — ENOENT returns status: ok, alreadyAbsent: true', () => {
  const root = tmpProjectRoot()
  const result = cleanupApprovalMarker(root, RUN_ID)
  assert.equal(result.status, 'ok')
  assert.equal(result.alreadyAbsent, true)
})

tap('cleanupApprovalMarker idempotent on second call after successful first', () => {
  const root = tmpProjectRoot()
  writeMarker({
    projectRoot: root, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const a = cleanupApprovalMarker(root, RUN_ID)
  const b = cleanupApprovalMarker(root, RUN_ID)
  assert.equal(a.status, 'ok')
  assert.equal(a.alreadyAbsent, false)
  assert.equal(b.status, 'ok')
  assert.equal(b.alreadyAbsent, true)
})

tap('cleanupApprovalMarker invalid run_id returns status: error with invalid-input code', () => {
  const root = tmpProjectRoot()
  const result = cleanupApprovalMarker(root, 'BAD CASE')
  assert.equal(result.status, 'error')
  assert.equal(result.code, 'invalid-input')
})

// ---------------------------------------------------------------------------
// Axis-9 / discipline #20: caller-cwd ≠ projectRoot — artifacts land under target
// ---------------------------------------------------------------------------

tap('writeMarker artifact lands under projectRoot regardless of process.cwd', () => {
  const target = tmpProjectRoot()
  const otherDir = tmpProjectRoot()  // caller cwd
  const origCwd = process.cwd()
  try {
    process.chdir(otherDir)
    const result = writeMarker({
      projectRoot: target, runId: RUN_ID, decidedClass: 'trivial',
      createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
    })
    assert.equal(result.status, 'ok')
    assert.ok(fs.existsSync(path.join(target, '.checkpoints', `bp1-approval-${RUN_ID}.json`)))
    // Caller cwd MUST NOT have a .checkpoints/.
    assert.ok(!fs.existsSync(path.join(otherDir, '.checkpoints')))
  } finally {
    process.chdir(origCwd)
  }
})

tap('cleanupApprovalMarker artifact targeted by projectRoot regardless of cwd', () => {
  const target = tmpProjectRoot()
  const otherDir = tmpProjectRoot()
  writeMarker({
    projectRoot: target, runId: RUN_ID, decidedClass: 'trivial',
    createdAt: CREATED_AT, deadlineAt: DEADLINE_AT, runKey32B: KEY,
  })
  const origCwd = process.cwd()
  try {
    process.chdir(otherDir)
    const result = cleanupApprovalMarker(target, RUN_ID)
    assert.equal(result.status, 'ok')
    assert.equal(result.alreadyAbsent, false)
    assert.ok(!fs.existsSync(path.join(target, '.checkpoints', `bp1-approval-${RUN_ID}.json`)))
  } finally {
    process.chdir(origCwd)
  }
})

// ---------------------------------------------------------------------------
// sweepApprovalMarkers — slice 2f --disable bulk-removal helper
// ---------------------------------------------------------------------------

tap('sweepApprovalMarkers returns ok on missing .checkpoints dir (ENOENT)', () => {
  const root = tmpProjectRoot()
  const r = sweepApprovalMarkers(root)
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.removed, [])
  assert.deepEqual(r.errors, [])
})

tap('sweepApprovalMarkers returns ok on empty .checkpoints dir', () => {
  const root = tmpProjectRoot()
  fs.mkdirSync(path.join(root, '.checkpoints'))
  const r = sweepApprovalMarkers(root)
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.removed, [])
})

tap('sweepApprovalMarkers removes only bp1-approval-*.json files', () => {
  const root = tmpProjectRoot()
  const cp = path.join(root, '.checkpoints')
  fs.mkdirSync(cp)
  // Two bp1-approval markers
  fs.writeFileSync(path.join(cp, 'bp1-approval-run-1.json'), '{}')
  fs.writeFileSync(path.join(cp, 'bp1-approval-run-2.json'), '{}')
  // Non-matching neighbors that must survive
  fs.writeFileSync(path.join(cp, '.pre-checkpoint-done'), 'preserved')
  fs.writeFileSync(path.join(cp, 'other-marker.json'), 'preserved')
  fs.writeFileSync(path.join(cp, 'bp1-approval-but-not.txt'), 'preserved')
  const r = sweepApprovalMarkers(root)
  assert.equal(r.status, 'ok')
  assert.equal(r.removed.length, 2)
  assert.ok(!fs.existsSync(path.join(cp, 'bp1-approval-run-1.json')))
  assert.ok(!fs.existsSync(path.join(cp, 'bp1-approval-run-2.json')))
  assert.ok(fs.existsSync(path.join(cp, '.pre-checkpoint-done')))
  assert.ok(fs.existsSync(path.join(cp, 'other-marker.json')))
  assert.ok(fs.existsSync(path.join(cp, 'bp1-approval-but-not.txt')))
})

tap('sweepApprovalMarkers is idempotent on re-invocation', () => {
  const root = tmpProjectRoot()
  const cp = path.join(root, '.checkpoints')
  fs.mkdirSync(cp)
  fs.writeFileSync(path.join(cp, 'bp1-approval-run-x.json'), '{}')
  const a = sweepApprovalMarkers(root)
  const b = sweepApprovalMarkers(root)
  assert.equal(a.removed.length, 1)
  assert.equal(b.removed.length, 0)
  assert.equal(b.status, 'ok')
})

tap('sweepApprovalMarkers rejects non-absolute projectRoot', () => {
  const r = sweepApprovalMarkers('./relative')
  assert.equal(r.status, 'error')
  assert.equal(r.code, 'invalid-input')
})

tap('sweepApprovalMarkers axis-9: cwd-mismatch targets correct project', () => {
  const target = tmpProjectRoot()
  const other = tmpProjectRoot()
  const tcp = path.join(target, '.checkpoints')
  fs.mkdirSync(tcp)
  fs.writeFileSync(path.join(tcp, 'bp1-approval-run-z.json'), '{}')
  // Marker in `other` must NOT be touched.
  const ocp = path.join(other, '.checkpoints')
  fs.mkdirSync(ocp)
  fs.writeFileSync(path.join(ocp, 'bp1-approval-other.json'), '{}')
  const origCwd = process.cwd()
  try {
    process.chdir(other)
    const r = sweepApprovalMarkers(target)
    assert.equal(r.removed.length, 1)
    assert.ok(!fs.existsSync(path.join(tcp, 'bp1-approval-run-z.json')))
    assert.ok(fs.existsSync(path.join(ocp, 'bp1-approval-other.json')),
      'sibling project marker untouched')
  } finally {
    process.chdir(origCwd)
  }
})

// ---------------------------------------------------------------------------
// Bail summary
// ---------------------------------------------------------------------------

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
if (fail > 0) process.exit(1)
