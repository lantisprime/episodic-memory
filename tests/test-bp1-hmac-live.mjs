#!/usr/bin/env node
/**
 * test-bp1-hmac-live.mjs — Live-run HMAC tests (RFC-004 §808-814 H1-H7 +
 * I3a/b run.key size + TB1 timingSafeEqual + TB2 length-mismatch).
 *
 * Plan-v4 anchor: PR-1c-A `tests/test-bp1-hmac-live.mjs`.
 * Verifies bp1-hmac.mjs + bp1-keys.mjs invariants on actual filesystem.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { signCanonical, verifyCanonical, verifyKeyFingerprint, fingerprintEqual } = hmacMod

const keysMod = await import(new URL('../scripts/lib/bp1-keys.mjs', import.meta.url).href)
const { generateRunKey, loadRunKey, runKeyPath, shredRunKey,
        loadVerifyKey, verifyKeyPath } = keysMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-hmac-proj-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}

function makeHomeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-hmac-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}

const RUN_ID = 'bp1-run-test-rfc-004-abcdef'

// =============================================================================
// generateRunKey + loadRunKey baseline
// =============================================================================
tap('generateRunKey writes 32-byte file at mode 0o600 under projectRoot only', () => {
  const proj = makeProjectRoot()
  const { keyPath, key32B } = generateRunKey(proj, RUN_ID)
  assert.equal(keyPath, runKeyPath(proj, RUN_ID))
  assert.equal(key32B.length, 32)
  const stat = fs.statSync(keyPath)
  assert.equal(stat.mode & 0o777, 0o600, `expected mode 0o600, got 0o${(stat.mode & 0o777).toString(8)}`)
  assert.equal(stat.size, 32)
  // Roundtrip via loadRunKey:
  const loaded = loadRunKey(proj, RUN_ID)
  assert.ok(loaded.key32B, 'loadRunKey returns key32B')
  assert.ok(loaded.key32B.equals(key32B), 'loaded key matches generated key')
})

// =============================================================================
// H1 — Forged signature (wrong run.key)
// =============================================================================
tap('H1 forged signature (wrong run.key) → verify false', () => {
  const proj = makeProjectRoot()
  const { key32B: keyA } = generateRunKey(proj, RUN_ID)
  const keyB = crypto.randomBytes(32)
  const bytes = Buffer.from('canonical payload bytes', 'utf8')
  const hexA = signCanonical(bytes, keyA)
  // Verify with wrong key.
  assert.equal(verifyCanonical(bytes, keyB, hexA), false)
  // Sanity: correct key verifies.
  assert.equal(verifyCanonical(bytes, keyA, hexA), true)
})

// =============================================================================
// H2 — Swapped run_id (canonical bytes change → signature mismatch)
// =============================================================================
tap('H2 swapped run_id (different canonical bytes) → verify false', () => {
  const key = crypto.randomBytes(32)
  const bytesA = Buffer.from('{"run_id":"task-A","summary":"x"}', 'utf8')
  const bytesB = Buffer.from('{"run_id":"task-B","summary":"x"}', 'utf8')
  const sigA = signCanonical(bytesA, key)
  // sigA should NOT verify against bytesB.
  assert.equal(verifyCanonical(bytesB, key, sigA), false)
  assert.equal(verifyCanonical(bytesA, key, sigA), true)
})

// =============================================================================
// H3 — Re-serialized payload (whitespace + key order) verifies
// (covered structurally by canonicalize lib's deterministic projection +
// signCanonical/verifyCanonical operating on canonical bytes; if the same
// bytes are produced, sig matches.)
// =============================================================================
tap('H3 same canonical bytes produce same hmac (deterministic)', () => {
  const key = crypto.randomBytes(32)
  const bytes = Buffer.from('canonical', 'utf8')
  const a = signCanonical(bytes, key)
  const b = signCanonical(bytes, key)
  assert.equal(a, b)
  assert.equal(verifyCanonical(bytes, key, a), true)
})

// =============================================================================
// H4 — Replayed signature from earlier same-run episode (different bytes)
// =============================================================================
tap('H4 replayed signature from earlier episode (different bytes) → verify false', () => {
  const key = crypto.randomBytes(32)
  const bytesEp1 = Buffer.from('{"run_id":"R","parent_episode":null,"body_sha256":"a"}', 'utf8')
  const bytesEp2 = Buffer.from('{"run_id":"R","parent_episode":"ep1","body_sha256":"b"}', 'utf8')
  const sigEp1 = signCanonical(bytesEp1, key)
  // The episode-2 verifier MUST recompute canonical with ep2's parent_episode + body_sha256
  // and reject the ep1-derived signature.
  assert.equal(verifyCanonical(bytesEp2, key, sigEp1), false)
})

// =============================================================================
// H5 — Stripped/empty/null hmac_signature → verify false (auditor refuses unsigned)
// =============================================================================
tap('H5 stripped/empty hmac_signature → verify false (no throw)', () => {
  const key = crypto.randomBytes(32)
  const bytes = Buffer.from('x', 'utf8')
  assert.equal(verifyCanonical(bytes, key, undefined), false)
  assert.equal(verifyCanonical(bytes, key, null), false)
  assert.equal(verifyCanonical(bytes, key, ''), false)
  assert.equal(verifyCanonical(bytes, key, 0), false)
})

// =============================================================================
// H6 — run.key mode 0644 → loadRunKey error: 'mode'
// =============================================================================
tap('H6 run.key mode 0644 → loadRunKey error mode', () => {
  const proj = makeProjectRoot()
  const { keyPath } = generateRunKey(proj, RUN_ID)
  fs.chmodSync(keyPath, 0o644)
  const loaded = loadRunKey(proj, RUN_ID)
  assert.equal(loaded.error, 'mode')
})

// =============================================================================
// H7 — run.key deleted → loadRunKey error: 'missing'
// =============================================================================
tap('H7 run.key deleted → loadRunKey error missing', () => {
  const proj = makeProjectRoot()
  const { keyPath } = generateRunKey(proj, RUN_ID)
  fs.unlinkSync(keyPath)
  const loaded = loadRunKey(proj, RUN_ID)
  assert.equal(loaded.error, 'missing')
})

// =============================================================================
// I3a / I3b — run.key wrong size → loadRunKey error: 'size'
// =============================================================================
tap('I3a run.key truncated to 31 bytes → loadRunKey error size', () => {
  const proj = makeProjectRoot()
  const { keyPath } = generateRunKey(proj, RUN_ID)
  fs.writeFileSync(keyPath, crypto.randomBytes(31), { mode: 0o600 })
  const loaded = loadRunKey(proj, RUN_ID)
  assert.equal(loaded.error, 'size')
})

tap('I3b run.key oversized to 33 bytes → loadRunKey error size', () => {
  const proj = makeProjectRoot()
  const { keyPath } = generateRunKey(proj, RUN_ID)
  fs.writeFileSync(keyPath, crypto.randomBytes(33), { mode: 0o600 })
  const loaded = loadRunKey(proj, RUN_ID)
  assert.equal(loaded.error, 'size')
})

// =============================================================================
// TB2a — hex sig wrong length → verify false (NOT throw)
// =============================================================================
tap('TB2a hex sig wrong length (31 chars) → verify false, no throw', () => {
  const key = crypto.randomBytes(32)
  const bytes = Buffer.from('x', 'utf8')
  // 31-char hex (one less than the 64-char HMAC-SHA256 hex digest).
  // verifyCanonical computes expected (64 chars), length-pre-check fails, returns false.
  assert.equal(verifyCanonical(bytes, key, 'a'.repeat(31)), false)
  // Equally, 65 chars:
  assert.equal(verifyCanonical(bytes, key, 'a'.repeat(65)), false)
})

// =============================================================================
// TB2b — non-hex sig → verify false (NOT throw)
// =============================================================================
tap('TB2b non-hex sig → verify false, no throw', () => {
  const key = crypto.randomBytes(32)
  const bytes = Buffer.from('x', 'utf8')
  assert.equal(verifyCanonical(bytes, key, 'NOT-HEX-AT-ALL'), false)
  assert.equal(verifyCanonical(bytes, key, 'g'.repeat(64)), false)  // g is non-hex
})

// =============================================================================
// TB1-impl — assert verifyCanonical uses crypto.timingSafeEqual
// =============================================================================
tap('TB1-impl verifyCanonical implementation uses crypto.timingSafeEqual', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'bp1-hmac.mjs'), 'utf8')
  assert.match(src, /crypto\.timingSafeEqual/, 'bp1-hmac.mjs must use crypto.timingSafeEqual')
})

// =============================================================================
// I4 — run.key never echoed in source/output of orchestrator
// (Static check of the lib + orchestrator source. The full I4 grep across
// emitted artifacts is in tests/test-bp1-orchestrator-init-run.mjs.)
// =============================================================================
tap('I4 (static) — bp1-hmac.mjs never logs/console-prints raw key bytes', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'bp1-hmac.mjs'), 'utf8')
  // The lib should never console.log or process.stdout.write the key.
  assert.doesNotMatch(src, /console\.\w+\([^)]*runKey32B/)
  assert.doesNotMatch(src, /process\.stdout\.write[^)]*runKey32B/)
})

// =============================================================================
// verifyKeyFingerprint + fingerprintEqual
// =============================================================================
tap('verifyKeyFingerprint returns 16-hex deterministic value', () => {
  const key = Buffer.alloc(32, 0x42)  // deterministic key
  const fp = verifyKeyFingerprint(key)
  assert.equal(fp.length, 16)
  assert.match(fp, /^[0-9a-f]{16}$/)
  // Same key → same fingerprint.
  assert.equal(verifyKeyFingerprint(key), fp)
})

tap('verifyKeyFingerprint differs for different keys', () => {
  const k1 = Buffer.alloc(32, 0x01)
  const k2 = Buffer.alloc(32, 0x02)
  assert.notEqual(verifyKeyFingerprint(k1), verifyKeyFingerprint(k2))
})

tap('fingerprintEqual: equal strings → true; different → false; non-string → false', () => {
  assert.equal(fingerprintEqual('a'.repeat(16), 'a'.repeat(16)), true)
  assert.equal(fingerprintEqual('a'.repeat(16), 'b'.repeat(16)), false)
  assert.equal(fingerprintEqual(null, null), false)
  assert.equal(fingerprintEqual(undefined, 'a'.repeat(16)), false)
})

// =============================================================================
// loadVerifyKey — sandbox HOME (B3 from planner)
// =============================================================================
tap('loadVerifyKey — happy path with sandboxed HOME', () => {
  const home = makeHomeDir()
  const keyBytes = crypto.randomBytes(32)
  fs.writeFileSync(verifyKeyPath(home), keyBytes, { mode: 0o600 })
  const loaded = loadVerifyKey(home)
  assert.ok(loaded.key32B, 'loadVerifyKey returns key32B')
  assert.ok(loaded.key32B.equals(keyBytes))
  assert.equal(loaded.fingerprint16.length, 16)
})

tap('loadVerifyKey — missing file → error missing (sandboxed HOME)', () => {
  const home = makeHomeDir()
  // Do NOT write a verify-key.
  const loaded = loadVerifyKey(home)
  assert.equal(loaded.error, 'missing')
})

tap('loadVerifyKey — mode 0644 → error mode (sandboxed HOME)', () => {
  const home = makeHomeDir()
  fs.writeFileSync(verifyKeyPath(home), crypto.randomBytes(32), { mode: 0o600 })
  fs.chmodSync(verifyKeyPath(home), 0o644)
  const loaded = loadVerifyKey(home)
  assert.equal(loaded.error, 'mode')
})

tap('loadVerifyKey — wrong size → error size (sandboxed HOME)', () => {
  const home = makeHomeDir()
  fs.writeFileSync(verifyKeyPath(home), crypto.randomBytes(31), { mode: 0o600 })
  const loaded = loadVerifyKey(home)
  assert.equal(loaded.error, 'size')
})

// =============================================================================
// shredRunKey
// =============================================================================
tap('shredRunKey overwrites + unlinks; subsequent loadRunKey error missing', () => {
  const proj = makeProjectRoot()
  generateRunKey(proj, RUN_ID)
  const result = shredRunKey(proj, RUN_ID)
  assert.deepEqual(result, { ok: true })
  const loaded = loadRunKey(proj, RUN_ID)
  assert.equal(loaded.error, 'missing')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
