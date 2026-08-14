#!/usr/bin/env node
/**
 * test-bp1-episode-verify.mjs — Parent-verify lib tests (slice 2c CR2-2).
 *
 * Coverage:
 *   - happy path: signed parent verifies
 *   - missing file → parent-missing
 *   - unreadable file → parent-unreadable (skipped; mode test is OS-dependent)
 *   - parse fail (corrupt frontmatter) → parent-parse-failed
 *   - id mismatch (file renamed to different episode-id) → parent-id-mismatch
 *   - type mismatch → parent-type-mismatch
 *   - state mismatch → parent-state-mismatch
 *   - run_id mismatch → parent-run-id-mismatch
 *   - missing hmac_signature → parent-missing-hmac-signature
 *   - tampered body → parent-hmac-invalid (HMAC fails)
 *   - tampered canonical field → parent-hmac-invalid
 *   - wrong run.key → parent-hmac-invalid
 *   - input validation: bad projectRoot / bad episodeId / bad key / bad type
 *   - failure-type parent (expectedState=null) verifies
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const writerMod = await import(new URL('../scripts/lib/bp1-episode-writer.mjs', import.meta.url).href)
const { writeBp1Episode } = writerMod

const verifyMod = await import(new URL('../scripts/lib/bp1-episode-verify.mjs', import.meta.url).href)
const { verifyEpisodeOnDisk } = verifyMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-verify-test-'))
  return fs.realpathSync(dir)
}

const KEY = crypto.randomBytes(32)
const RUN_ID = 'bp1-run-1730000000000-rfc-004-aabbcc'

function writeParent(projectRoot, customFm = {}, opts = {}) {
  return writeBp1Episode({
    projectRoot,
    runId: opts.runId ?? RUN_ID,
    runKey32B: opts.runKey32B ?? KEY,
    type: opts.type ?? 'state-transition',
    state: opts.state ?? 'rfc-detected',
    summary: 'parent',
    parentEpisode: null,
    expectedPostEpisodeId: null,
    customFm: {
      rfc_id: 'RFC-004',
      frontmatter_sha256: 'a'.repeat(64),
      ...customFm,
    },
    tags: ['bp1-rfc-detected'],
    body: '# parent\n',
    filenameSuffix: 'rfc-detected',
  })
}

// =============================================================================
// V1: happy path
// =============================================================================
tap('V1 happy path — signed parent verifies', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.deepEqual(r, { ok: true })
})

// =============================================================================
// V2: parent-missing — file doesn't exist
// =============================================================================
tap('V2 parent-missing when file absent', () => {
  const root = mkTmpProject()
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: `${RUN_ID}-rfc-detected-zzzz`, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.startsWith('parent-missing')))
})

// =============================================================================
// V3: corrupt frontmatter → parent-parse-failed
// =============================================================================
tap('V3 parent-parse-failed on corrupt frontmatter', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  // Corrupt: remove closing --- fence by truncating mid-frontmatter.
  const text = fs.readFileSync(p.episodePath, 'utf8')
  const truncated = text.slice(0, text.indexOf('summary:') + 10)
  fs.writeFileSync(p.episodePath, truncated)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.startsWith('parent-parse-failed')))
})

// =============================================================================
// V4: id mismatch — file renamed but in-file id stays original
// =============================================================================
tap('V4 parent-id-mismatch when filename diverges from in-file id', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const fakeId = `${RUN_ID}-rfc-detected-9999`
  const newPath = path.join(path.dirname(p.episodePath), `${fakeId}.md`)
  fs.renameSync(p.episodePath, newPath)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: fakeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.startsWith('parent-id-mismatch')))
})

// =============================================================================
// V5: type mismatch
// =============================================================================
tap('V5 parent-type-mismatch', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'evidence',   // wrong
    expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.startsWith('parent-type-mismatch')))
})

// =============================================================================
// V6: state mismatch
// =============================================================================
tap('V6 parent-state-mismatch', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition',
    expectedState: 'classifier-dispatch-pending',   // wrong
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.startsWith('parent-state-mismatch')))
})

// =============================================================================
// V7: run_id mismatch
// =============================================================================
tap('V7 parent-run-id-mismatch', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: 'bp1-run-different-run-ffff',   // wrong
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.startsWith('parent-run-id-mismatch')))
})

// =============================================================================
// V8: tampered body → HMAC fails
// =============================================================================
tap('V8 tampered body → parent-hmac-invalid', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const text = fs.readFileSync(p.episodePath, 'utf8')
  // Append to body (after closing fence).
  fs.writeFileSync(p.episodePath, text + '\ntampered body extension\n')
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('parent-hmac-invalid'))
})

// =============================================================================
// V9: tampered canonical field (rfc_id) → HMAC fails
// =============================================================================
tap('V9 tampered canonical field rfc_id → parent-hmac-invalid', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const text = fs.readFileSync(p.episodePath, 'utf8')
  fs.writeFileSync(p.episodePath, text.replace('rfc_id: "RFC-004"', 'rfc_id: "RFC-005"'))
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('parent-hmac-invalid'))
})

// =============================================================================
// V10: wrong run.key → HMAC fails
// =============================================================================
tap('V10 wrong run.key → parent-hmac-invalid', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: crypto.randomBytes(32),
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('parent-hmac-invalid'))
})

// =============================================================================
// V11: missing hmac_signature in frontmatter
// =============================================================================
tap('V11 missing hmac_signature → parent-missing-hmac-signature', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const text = fs.readFileSync(p.episodePath, 'utf8')
  const stripped = text.replace(/^hmac_signature: .*$/m, 'hmac_signature: ""')
  fs.writeFileSync(p.episodePath, stripped)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('parent-missing-hmac-signature'))
})

// =============================================================================
// V12: input validation — bad projectRoot
// =============================================================================
tap('V12 reject relative projectRoot', () => {
  const r = verifyEpisodeOnDisk({
    projectRoot: 'relative/path', episodeId: 'x', runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected', expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('absolute path')))
})

// =============================================================================
// V13: input validation — bad episodeId shape
// =============================================================================
tap('V13 reject episodeId with traversal chars', () => {
  const root = mkTmpProject()
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: '../escape', runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected', expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('episodeId shape invalid')))
})

// =============================================================================
// V14: failure-type parent (expectedState=null) verifies
// =============================================================================
tap('V14 failure-type parent verifies with expectedState=null', () => {
  const root = mkTmpProject()
  const failureParent = writeBp1Episode({
    projectRoot: root, runId: RUN_ID, runKey32B: KEY,
    type: 'failure', state: null,
    summary: 'classifier schema violation',
    parentEpisode: null, expectedPostEpisodeId: null,
    customFm: {
      failure_kind: 'classifier-schema-violation',
      field_name: 'confidence',
      observed_value: '"1.5"',
      violation_reason: 'value above maximum 1',
    },
    body: '# failure\n', filenameSuffix: 'classifier-schema-violation',
  })
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: failureParent.episodeId, runKey32B: KEY,
    expectedType: 'failure', expectedState: null, expectedRunId: RUN_ID,
  })
  assert.deepEqual(r, { ok: true })
})

// =============================================================================
// V15: signed-by-different-key file with right shape still fails
// (sister to V10; demonstrates the swap-attack defense)
// =============================================================================
tap('V15 parent signed by foreign key + claimed under our run → parent-hmac-invalid', () => {
  const root = mkTmpProject()
  const FOREIGN = crypto.randomBytes(32)
  const p = writeParent(root, {}, { runKey32B: FOREIGN })
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.includes('parent-hmac-invalid'))
})

// =============================================================================
// V16: FIFO-shaped parent episode file → ok:false + parent-unreadable: entry,
// no hang (issue #670). Spawned into a CHILD process with a hard timeout — a
// same-process call against unfixed code (raw fs.readFileSync on a FIFO)
// blocks forever with no external alarm.
// =============================================================================
tap('V16 FIFO-shaped parent file → parent-unreadable, no hang (spawned, alarm-wrapped)', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  fs.unlinkSync(p.episodePath)
  const mk = spawnSync('mkfifo', [p.episodePath])
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`)
  const VERIFY_PATH = new URL('../scripts/lib/bp1-episode-verify.mjs', import.meta.url).href
  const childPath = path.join(root, 'child-probe.mjs')
  fs.writeFileSync(childPath, [
    `import { verifyEpisodeOnDisk } from ${JSON.stringify(VERIFY_PATH)}`,
    `const r = verifyEpisodeOnDisk({`,
    `  projectRoot: ${JSON.stringify(root)}, episodeId: ${JSON.stringify(p.episodeId)}, runKey32B: Buffer.from(${JSON.stringify(KEY.toString('hex'))}, 'hex'),`,
    `  expectedType: 'state-transition', expectedState: 'rfc-detected', expectedRunId: ${JSON.stringify(RUN_ID)},`,
    `})`,
    `console.log(JSON.stringify(r))`,
  ].join('\n'))
  const r = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' })
  fs.rmSync(childPath, { force: true })
  fs.unlinkSync(p.episodePath)
  assert.ok(r.signal === null, `V16: no signal (timeout/kill) — got ${r.signal} (fail-not-freeze regression signature)`)
  assert.equal(r.status, 0, `V16: child exit 0, got ${r.status}: stderr=${(r.stderr || '').slice(0, 300)}`)
  const j = JSON.parse((r.stdout || '').trim())
  assert.equal(j.ok, false, JSON.stringify(j))
  assert.ok(j.errors.some(e => e.startsWith('parent-unreadable:')), JSON.stringify(j))
})

// =============================================================================
// V17: strict-decode regression leg (round-1 MINOR-3) — invalid UTF-8 bytes
// in the parent file must still die in STRICT_UTF8_DECODER -> parent-parse-
// failed. Guards that the #670 refactor to readBodyBufferOrSkip keeps
// passing RAW BYTES into parseBp1Frontmatter (not a pre-decoded string,
// which would silently normalize invalid UTF-8 to U+FFFD).
// =============================================================================
tap('V17 invalid-UTF-8 bytes in parent file → parent-parse-failed (Buffer passthrough survives the #670 refactor)', () => {
  const root = mkTmpProject()
  const p = writeParent(root)
  const text = fs.readFileSync(p.episodePath, 'utf8')
  const bytes = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0xff])])
  fs.writeFileSync(p.episodePath, bytes)
  const r = verifyEpisodeOnDisk({
    projectRoot: root, episodeId: p.episodeId, runKey32B: KEY,
    expectedType: 'state-transition', expectedState: 'rfc-detected',
    expectedRunId: RUN_ID,
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.startsWith('parent-parse-failed')))
})

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
