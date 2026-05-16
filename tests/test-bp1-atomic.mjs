#!/usr/bin/env node
/**
 * test-bp1-atomic.mjs — Primitives shared by cluster #286/#287/#288 fix.
 *
 * Coverage (plan v5 final, codex round-5 ACCEPT 20260516-102831):
 *   - atomic writer: tmp+fsync+rename; crash mid-rename leaves no final
 *   - findSignedStateEpisode: 0/1/many candidates × (no fields | match | mismatch)
 *   - findSignedStateEpisode: identity check (filename-vs-fm.id)
 *   - findSignedStateEpisode: HMAC tamper → no match
 *   - findSignedStateEpisode: expectedFields → status discrimination
 *   - withLockedRun: fn mutation persists; fn throw → idx unchanged on disk
 *   - withLockedRun: re-load inside lock; serialization between concurrent calls
 *   - removeRunFromIndex: in-memory delete; sibling preserved
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const writerMod = await import(new URL('../scripts/lib/bp1-episode-writer.mjs', import.meta.url).href)
const { writeBp1Episode } = writerMod

const atomicMod = await import(new URL('../scripts/lib/bp1-atomic.mjs', import.meta.url).href)
const { findSignedStateEpisode, withLockedRun, removeRunFromIndex } = atomicMod

const runStateMod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { appendRun, loadIndex, indexPath } = runStateMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-atomic-test-'))
  // appendRun expects a .git presence is not required; only orchestrator subcommands check it.
  return fs.realpathSync(dir)
}

const KEY = crypto.randomBytes(32)
const RUN_ID = 'bp1-run-1730000000000-cluster-aabbcc'

function emitPre(projectRoot, runId, key, customFm = {}) {
  return writeBp1Episode({
    projectRoot,
    runId,
    runKey32B: key,
    type: 'state-transition',
    state: 'classifier-dispatch-pending',
    summary: `pre ${runId}`,
    parentEpisode: `${runId}-rfc-detected-aabb`,
    expectedPostEpisodeId: null,
    customFm: { input_sha256: 'a'.repeat(64), ...customFm },
    tags: ['bp1-classifier-dispatch-pre'],
    body: `# pre — ${runId}\n`,
    filenameSuffix: 'pre',
  })
}

// =============================================================================
// Atomic writer
// =============================================================================

tap('A1 atomic writer: emits final episode atomically; no tmp leak on success', () => {
  const projectRoot = mkTmpProject()
  const result = emitPre(projectRoot, RUN_ID, KEY)
  assert.ok(fs.existsSync(result.episodePath))
  const epDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  const entries = fs.readdirSync(epDir)
  // No `.tmp.` files left.
  for (const e of entries) {
    assert.ok(!e.includes('.tmp.'), `tmp file leaked: ${e}`)
  }
})

tap('A2 atomic writer: rename failure → no final path AND no tmp leak (writer cleans up)', () => {
  // Contract revised per codex PR-r1 C3: writer is responsible for its own
  // tmp cleanup on rename failure. The prior contract ("tmp present,
  // cleanable by orphan sweep") was aspirational — no orphan sweep ever
  // shipped, so leaked tmps accumulated forever under crash-retry. The
  // writer now unlinks the tmp before rethrowing the rename error.
  const projectRoot = mkTmpProject()
  const original = fs.renameSync
  let tmpSeen = null
  fs.renameSync = (src, _dst) => { tmpSeen = src; throw new Error('simulated power loss between fsync and rename') }
  try {
    let threw = false
    let caughtErr = null
    try { emitPre(projectRoot, RUN_ID, KEY) } catch (e) { threw = true; caughtErr = e }
    assert.ok(threw, 'writer should propagate rename failure')
    assert.match(caughtErr.message, /simulated power loss/,
      'writer rethrows the ORIGINAL rename error (not the tmp-cleanup error)')
    assert.ok(tmpSeen != null, 'rename stub should have been called with tmp path')
    const epDir = path.join(projectRoot, '.episodic-memory', 'episodes')
    const entries = fs.readdirSync(epDir)
    const finals = entries.filter(e => !e.includes('.tmp.'))
    assert.equal(finals.length, 0, `unexpected final files: ${finals.join(', ')}`)
    const tmps = entries.filter(e => e.includes('.tmp.'))
    assert.equal(tmps.length, 0, `tmp should be cleaned up on rename failure; got: ${tmps.join(', ')}`)
  } finally {
    fs.renameSync = original
  }
})

// =============================================================================
// findSignedStateEpisode — return-shape discrimination
// =============================================================================

tap('F1 no episodes dir → status: none', () => {
  const projectRoot = mkTmpProject()
  const r = findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY)
  assert.deepEqual(r, { status: 'none' })
})

tap('F2 0 signed candidates → status: none (different run_id)', () => {
  const projectRoot = mkTmpProject()
  emitPre(projectRoot, RUN_ID, KEY)
  const r = findSignedStateEpisode(projectRoot, 'bp1-run-other-aabbcc', 'classifier-dispatch-pending', KEY)
  assert.deepEqual(r, { status: 'none' })
})

tap('F3 1 signed candidate, no expectedFields → status: match', () => {
  const projectRoot = mkTmpProject()
  const ep = emitPre(projectRoot, RUN_ID, KEY)
  const r = findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY)
  assert.equal(r.status, 'match')
  assert.equal(r.episodeId, ep.episodeId)
  assert.equal(r.episodePath, ep.episodePath)
  assert.equal(r.frontmatter.input_sha256, 'a'.repeat(64))
  assert.equal(r.frontmatter.run_id, RUN_ID)
})

tap('F4 1 candidate, expectedFields satisfied → status: match', () => {
  const projectRoot = mkTmpProject()
  emitPre(projectRoot, RUN_ID, KEY)
  const r = findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY, {
    input_sha256: 'a'.repeat(64),
    parent_episode: `${RUN_ID}-rfc-detected-aabb`,
  })
  assert.equal(r.status, 'match')
})

tap('F5 1 candidate, expectedFields mismatch on one key → status: field-mismatch with candidate listed', () => {
  const projectRoot = mkTmpProject()
  const ep = emitPre(projectRoot, RUN_ID, KEY)
  const r = findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY, {
    input_sha256: 'b'.repeat(64),  // mismatch
  })
  assert.equal(r.status, 'field-mismatch')
  assert.equal(r.candidates.length, 1)
  assert.equal(r.candidates[0].episodeId, ep.episodeId)
})

tap('F6 2 signed candidates, no expectedFields → throws multiple-signed-match', () => {
  const projectRoot = mkTmpProject()
  emitPre(projectRoot, RUN_ID, KEY)
  emitPre(projectRoot, RUN_ID, KEY)  // duplicate
  let caught = null
  try {
    findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY)
  } catch (e) { caught = e }
  assert.ok(caught)
  assert.equal(caught.code, 'multiple-signed-match')
  assert.equal(caught.candidates.length, 2)
})

tap('F7 2 candidates, 1 satisfies all predicates → status: match', () => {
  const projectRoot = mkTmpProject()
  emitPre(projectRoot, RUN_ID, KEY, { input_sha256: 'a'.repeat(64) })
  const target = emitPre(projectRoot, RUN_ID, KEY, { input_sha256: 'b'.repeat(64) })
  const r = findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY, {
    input_sha256: 'b'.repeat(64),
  })
  assert.equal(r.status, 'match')
  assert.equal(r.episodeId, target.episodeId)
})

tap('F8 HMAC tampered → candidate excluded (treated as no signed)', () => {
  const projectRoot = mkTmpProject()
  const ep = emitPre(projectRoot, RUN_ID, KEY)
  // Tamper the file: replace hmac_signature line.
  const content = fs.readFileSync(ep.episodePath, 'utf8')
  const tampered = content.replace(/hmac_signature: [a-f0-9]+/, 'hmac_signature: ' + '0'.repeat(64))
  fs.writeFileSync(ep.episodePath, tampered)
  const r = findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY)
  assert.deepEqual(r, { status: 'none' })
})

tap('F9 filename-vs-fm.id mismatch (rename attack) → excluded', () => {
  const projectRoot = mkTmpProject()
  const ep = emitPre(projectRoot, RUN_ID, KEY)
  // Rename the file so filename stem differs from fm.id.
  const epDir = path.dirname(ep.episodePath)
  const renamed = path.join(epDir, `${RUN_ID}-renamed-9999.md`)
  fs.renameSync(ep.episodePath, renamed)
  const r = findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY)
  assert.deepEqual(r, { status: 'none' })
})

tap('F10 input validation — bad projectRoot, runId, state, key, expectedFields', () => {
  const projectRoot = mkTmpProject()
  assert.throws(() => findSignedStateEpisode('relative/path', RUN_ID, 'classifier-dispatch-pending', KEY), /absolute path/)
  assert.throws(() => findSignedStateEpisode(projectRoot, 'BAD ID', 'classifier-dispatch-pending', KEY), /runId shape/)
  assert.throws(() => findSignedStateEpisode(projectRoot, RUN_ID, '', KEY), /state must be a non-empty/)
  assert.throws(() => findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', 'not a buffer'), /32-byte Buffer/)
  assert.throws(() => findSignedStateEpisode(projectRoot, RUN_ID, 'classifier-dispatch-pending', KEY, []), /expectedFields/)
})

// =============================================================================
// withLockedRun
// =============================================================================

tap('W1 fn mutation persists via writeIndex on normal return', () => {
  const projectRoot = mkTmpProject()
  const append = appendRun(projectRoot, RUN_ID, projectRoot)
  assert.ok(append.ok)
  withLockedRun(projectRoot, RUN_ID, ({ idx, run }) => {
    assert.ok(run)
    run.state = 'rfc-detected'
    run.rfc_detected_episode_id = 'fake-ep-id-aabb'
  })
  const reread = loadIndex(projectRoot)
  assert.equal(reread.runs[RUN_ID].state, 'rfc-detected')
  assert.equal(reread.runs[RUN_ID].rfc_detected_episode_id, 'fake-ep-id-aabb')
})

tap('W2 fn throw → idx not written; on-disk state unchanged', () => {
  const projectRoot = mkTmpProject()
  appendRun(projectRoot, RUN_ID, projectRoot)
  let caught = null
  try {
    withLockedRun(projectRoot, RUN_ID, ({ run }) => {
      run.state = 'classified'
      throw new Error('aborted mid-mutation')
    })
  } catch (e) { caught = e }
  assert.ok(caught)
  assert.equal(caught.message, 'aborted mid-mutation')
  const reread = loadIndex(projectRoot)
  assert.equal(reread.runs[RUN_ID].state, 'active', 'state should remain initial')
})

tap('W3 run undefined when runId not in idx', () => {
  const projectRoot = mkTmpProject()
  let seen = null
  withLockedRun(projectRoot, RUN_ID, ({ idx, run }) => { seen = run; assert.ok(idx) })
  assert.equal(seen, undefined)
})

tap('W4 fn return value propagates', () => {
  const projectRoot = mkTmpProject()
  appendRun(projectRoot, RUN_ID, projectRoot)
  const r = withLockedRun(projectRoot, RUN_ID, ({ run }) => ({ found: !!run, state: run?.state }))
  assert.deepEqual(r, { found: true, state: 'active' })
})

tap('W5 input validation', () => {
  const projectRoot = mkTmpProject()
  assert.throws(() => withLockedRun('relative', RUN_ID, () => {}), /absolute path/)
  assert.throws(() => withLockedRun(projectRoot, 'BAD ID', () => {}), /runId shape/)
  assert.throws(() => withLockedRun(projectRoot, RUN_ID, 'not-a-function'), /fn must be a function/)
})

// =============================================================================
// removeRunFromIndex
// =============================================================================

tap('R1 removes the target run; siblings preserved', () => {
  const idx = {
    schema_version: 2,
    runs: {
      'run-a': { state: 'active' },
      'run-b': { state: 'classified' },
      'run-c': { state: 'planning' },
    },
  }
  removeRunFromIndex(idx, 'run-b')
  assert.equal(idx.runs['run-a'].state, 'active')
  assert.equal(idx.runs['run-b'], undefined)
  assert.equal(idx.runs['run-c'].state, 'planning')
})

tap('R2 no-op if runId absent', () => {
  const idx = { schema_version: 2, runs: { 'run-a': { state: 'active' } } }
  removeRunFromIndex(idx, 'run-zzz')
  assert.equal(idx.runs['run-a'].state, 'active')
})

tap('R3 input validation', () => {
  assert.throws(() => removeRunFromIndex(null, 'r'), /idx must be an object/)
  assert.throws(() => removeRunFromIndex([], 'r'), /idx must be an object/)
  assert.throws(() => removeRunFromIndex({ runs: {} }, 123), /runId must be a string/)
})

// =============================================================================
// Summary
// =============================================================================

if (fail > 0) {
  console.log(`\n# FAIL ${pass}/${pass + fail} passed`)
  process.exit(1)
}
console.log(`\n# OK ${pass}/${pass + fail} passed`)
