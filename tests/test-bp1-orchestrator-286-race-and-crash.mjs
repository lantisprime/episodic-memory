#!/usr/bin/env node
/**
 * test-bp1-orchestrator-286-race-and-crash.mjs —
 *   record-classifier-dispatch-pre concurrency + crash recovery
 *   for cluster #286/#287/#288 fix.
 *
 * Plan v5 (codex round-5 ACCEPT 20260516-102831-...-b657) matrix:
 *   286-1 race same-sha → both succeed (attach), no duplicate
 *   286-2 race different-sha → first wins, second state-violation, no duplicate
 *   286-3 retry with stale input_sha256 on pending → recoverable-canonical-drift
 *   286-4 crash mid-rename → tmp present, no final, retry succeeds
 *   286-5 crash after emit before writeIndex → orphan signed, retry attaches
 *   286-6 caller cwd != target → all artifacts under target
 *   286-7 different runIds concurrent → no cross-run attach
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, spawn } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ORCHESTRATOR = path.join(REPO, 'scripts', 'bp1-orchestrator.mjs')
const ARTIFACT_BUILDER = path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs')

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyKeyFingerprint } = hmacMod
const rsmod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { loadIndex, withRunStateLockExclusive, loadIndexLocked, writeIndex } = rsmod
const writerMod = await import(new URL('../scripts/lib/bp1-episode-writer.mjs', import.meta.url).href)
const { writeBp1Episode } = writerMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// ---------------------------------------------------------------------------
// Sandbox helpers (mirror classifier-fence test style)
// ---------------------------------------------------------------------------

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-286-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-286-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}
function writeKey(homeDir) {
  const key = crypto.randomBytes(32)
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/.verify-key'), key, { mode: 0o600 })
  return verifyKeyFingerprint(key)
}
function buildHash(projectRoot, homeDir) {
  return JSON.parse(execFileSync('node', [ARTIFACT_BUILDER, '--project', projectRoot, '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: homeDir } })).sha256
}
function writeConfig(homeDir, projectRoot, fingerprint) {
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/config.json'),
    JSON.stringify({
      bp1: {
        schema_version: 1,
        activations: {
          [projectRoot]: {
            enabled: true,
            artifact_version_hash: 'sha256:' + buildHash(projectRoot, homeDir),
            enabled_at: new Date().toISOString(),
            enabled_via: 'test-fixture',
            verify_key_id: fingerprint,
          },
        },
      },
    }, null, 2))
}
function writeRfc(projectRoot, name, status = 'accepted') {
  fs.writeFileSync(path.join(projectRoot, 'docs', 'rfcs', `${name}.md`),
    `---\nrfc_id: ${name}\nstatus: ${JSON.stringify(status)}\ntitle: ${JSON.stringify('T')}\n---\n\nbody.\n`)
}
function runOrch(args, { project, homeDir, callerCwd }) {
  return spawnSync('node', [ORCHESTRATOR, ...args], {
    cwd: callerCwd ?? project, encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  })
}

function setupRfcDetected({ rfcs = ['RFC-CF'] } = {}) {
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  for (const r of rfcs) writeRfc(project, r)
  writeConfig(home, project, fp)
  const r = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  if (r.status !== 0) throw new Error(`detect-rfcs failed: ${r.stderr}`)
  const detected = JSON.parse(r.stdout).detected
  // Map rfcId → { run_id, run.key, rfc_detected_episode_id }
  const byRfc = {}
  for (const d of detected) {
    const runKey = fs.readFileSync(path.join(project, '.episodic-memory/runs', d.run_id, 'run.key'))
    byRfc[d.rfc_id] = { runId: d.run_id, runKey, rfcDetectedEpisodeId: d.rfc_detected_episode_id }
  }
  return { project, home, byRfc, firstRfc: detected[0] }
}

function preDispatch(ctx, runId, inputSha256, opts = {}) {
  return runOrch([
    'record-classifier-dispatch-pre',
    '--project', ctx.project,
    '--run-id', runId,
    '--input-sha256', inputSha256,
  ], { project: ctx.project, homeDir: ctx.home, callerCwd: opts.callerCwd })
}

function preDispatchAsync(ctx, runId, inputSha256) {
  return new Promise((resolve) => {
    const child = spawn('node', [
      ORCHESTRATOR,
      'record-classifier-dispatch-pre',
      '--project', ctx.project,
      '--run-id', runId,
      '--input-sha256', inputSha256,
    ], {
      cwd: ctx.project,
      env: { ...process.env, HOME: ctx.home },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => stdout += d)
    child.stderr.on('data', (d) => stderr += d)
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

// ===========================================================================
// 286-1: race same-sha → both succeed (one attaches), no duplicate
// ===========================================================================
tap('286-1 race same-sha → both succeed (one attaches), no duplicate pre-episode', async () => {
  const ctx = setupRfcDetected()
  const { runId } = ctx.byRfc['RFC-CF']
  const [r1, r2] = await Promise.all([
    preDispatchAsync(ctx, runId, SHA_A),
    preDispatchAsync(ctx, runId, SHA_A),
  ])
  // Both must succeed.
  assert.equal(r1.status, 0, `r1 stderr=${r1.stderr}`)
  assert.equal(r2.status, 0, `r2 stderr=${r2.stderr}`)
  // Both report the same pre_episode_id (one emitted, one attached).
  const id1 = JSON.parse(r1.stdout).pre_episode_id
  const id2 = JSON.parse(r2.stdout).pre_episode_id
  assert.equal(id1, id2, 'concurrent retries with same sha must report the same pre_episode_id')
  // Exactly one signed pre-episode on disk for runId.
  const epDir = path.join(ctx.project, '.episodic-memory', 'episodes')
  const matching = fs.readdirSync(epDir).filter(n => n.startsWith(runId) && n.endsWith('.md') && n.includes('-pre-'))
  assert.equal(matching.length, 1, `expected 1 pre-episode; got ${matching.length}: ${matching.join(', ')}`)
})

// ===========================================================================
// 286-2: race different-sha → first wins; second exits 5 with drift
// ===========================================================================
tap('286-2 race different-sha → first wins; second exits 5; no duplicate emit', async () => {
  const ctx = setupRfcDetected()
  const { runId } = ctx.byRfc['RFC-CF']
  const [r1, r2] = await Promise.all([
    preDispatchAsync(ctx, runId, SHA_A),
    preDispatchAsync(ctx, runId, SHA_B),
  ])
  // Exactly one success, one failure.
  const succ = [r1, r2].filter(r => r.status === 0)
  const fails = [r1, r2].filter(r => r.status === 5)
  assert.equal(succ.length, 1, `expected 1 success; got ${succ.length}`)
  assert.equal(fails.length, 1, `expected 1 exit-5; got ${fails.length}`)
  // The failure carries recoverable-canonical-drift or state-violation language.
  const failStderr = fails[0].stderr
  assert.match(failStderr, /recoverable-canonical-drift|state-violation/,
    `unexpected fail stderr: ${failStderr}`)
  // Exactly one signed pre-episode on disk for runId.
  const epDir = path.join(ctx.project, '.episodic-memory', 'episodes')
  const matching = fs.readdirSync(epDir).filter(n => n.startsWith(runId) && n.includes('-pre-'))
  assert.equal(matching.length, 1, `expected 1 pre-episode; got ${matching.length}`)
})

// ===========================================================================
// 286-3: retry with stale input_sha256 on pending → recoverable-canonical-drift
// ===========================================================================
tap('286-3 retry with stale input_sha256 on pending → recoverable-canonical-drift', () => {
  const ctx = setupRfcDetected()
  const { runId } = ctx.byRfc['RFC-CF']
  const r1 = preDispatch(ctx, runId, SHA_A)
  assert.equal(r1.status, 0)
  // Same run, advanced to classifier-dispatch-pending. Now retry with a different sha.
  const r2 = preDispatch(ctx, runId, SHA_B)
  assert.equal(r2.status, 5, `expected exit 5; got ${r2.status}; stderr=${r2.stderr}`)
  assert.match(r2.stderr, /recoverable-canonical-drift/)
})

// ===========================================================================
// 286-4: crash mid-rename — tmp present, no final; retry succeeds.
// In-process invocation so we can stub fs.renameSync.
// ===========================================================================
tap('286-4 crash mid-rename → tmp present, no final, retry succeeds', () => {
  const ctx = setupRfcDetected()
  const { runId } = ctx.byRfc['RFC-CF']
  // Force renameSync to throw on the first writeBp1Episode call from this
  // test process. Subsequent (post-restore) calls behave normally. The
  // orchestrator subprocess uses its OWN fs, so we have to do this part
  // in-process with the writer directly: emit a tmp via stubbed rename,
  // then verify the orchestrator subprocess's retry succeeds.
  const original = fs.renameSync
  const projectRoot = ctx.project
  let tmpSeen = null
  fs.renameSync = (src, _dst) => { tmpSeen = src; throw new Error('simulated power-loss') }
  try {
    let threw = false
    try {
      writeBp1Episode({
        projectRoot, runId, runKey32B: ctx.byRfc['RFC-CF'].runKey,
        type: 'state-transition', state: 'classifier-dispatch-pending',
        summary: 'pre-mid-rename-crash',
        parentEpisode: ctx.byRfc['RFC-CF'].rfcDetectedEpisodeId,
        expectedPostEpisodeId: null,
        customFm: { input_sha256: SHA_A },
        tags: ['bp1-classifier-dispatch-pre'],
        body: '# pre crash test\n',
        filenameSuffix: 'pre',
      })
    } catch (_e) { threw = true }
    assert.ok(threw)
    assert.ok(tmpSeen, 'tmp path was generated')
    // No final PRE-DISPATCH episode (the rfc-detected episode from setup is fine).
    const epDir = path.join(projectRoot, '.episodic-memory', 'episodes')
    const preFinals = fs.readdirSync(epDir).filter(n => n.startsWith(runId) && n.includes('-pre-') && !n.includes('.tmp.'))
    assert.equal(preFinals.length, 0, `unexpected pre-final files: ${preFinals.join(', ')}`)
  } finally {
    fs.renameSync = original
  }
  // Retry via orchestrator subprocess — should succeed (fresh emit; no orphan match).
  const r = preDispatch(ctx, runId, SHA_A)
  assert.equal(r.status, 0, `retry failed: ${r.stderr}`)
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[runId].state, 'classifier-dispatch-pending')
  assert.ok(idx.runs[runId].pre_episode_id)
})

// ===========================================================================
// 286-5: crash after atomic-write before writeIndex — orphan signed,
// retry attaches the orphan. Simulate by emitting the episode directly,
// leaving idx unchanged (state still 'rfc-detected'), then run subprocess.
// ===========================================================================
tap('286-5 crash after rename before writeIndex → orphan signed, retry attaches', () => {
  const ctx = setupRfcDetected()
  const { runId, rfcDetectedEpisodeId, runKey } = ctx.byRfc['RFC-CF']
  // Emit pre-episode directly (atomic via refactored writer). Do NOT update idx.
  const orphan = writeBp1Episode({
    projectRoot: ctx.project, runId, runKey32B: runKey,
    type: 'state-transition', state: 'classifier-dispatch-pending',
    summary: 'orphan pre',
    parentEpisode: rfcDetectedEpisodeId,
    expectedPostEpisodeId: null,
    customFm: { input_sha256: SHA_A },
    tags: ['bp1-classifier-dispatch-pre'],
    body: '# orphan\n',
    filenameSuffix: 'pre',
  })
  // Idx unchanged: state still 'rfc-detected', pre_episode_id null.
  const idxBefore = loadIndex(ctx.project)
  assert.equal(idxBefore.runs[runId].state, 'rfc-detected')
  assert.equal(idxBefore.runs[runId].pre_episode_id, null)
  // Retry via orchestrator with matching input_sha256 → orphan attach.
  const r = preDispatch(ctx, runId, SHA_A)
  assert.equal(r.status, 0, `attach retry failed: ${r.stderr}`)
  const idxAfter = loadIndex(ctx.project)
  assert.equal(idxAfter.runs[runId].state, 'classifier-dispatch-pending')
  assert.equal(idxAfter.runs[runId].pre_episode_id, orphan.episodeId,
    'retry should attach the orphan, not emit a new pre-episode')
  // Confirm: still only 1 signed pre-episode on disk.
  const epDir = path.join(ctx.project, '.episodic-memory', 'episodes')
  const matching = fs.readdirSync(epDir).filter(n => n.startsWith(runId) && n.includes('-pre-') && !n.includes('.tmp.'))
  assert.equal(matching.length, 1, `expected exactly 1 final pre-episode; got ${matching.length}`)
})

// ===========================================================================
// 286-6: caller cwd != target → all artifacts under target
// ===========================================================================
tap('286-6 caller cwd != target → all artifacts under target', () => {
  const ctx = setupRfcDetected()
  const { runId } = ctx.byRfc['RFC-CF']
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-286-caller-'))
  const r = preDispatch(ctx, runId, SHA_A, { callerCwd })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  // No .episodic-memory directory should have been created under callerCwd.
  assert.ok(!fs.existsSync(path.join(callerCwd, '.episodic-memory')),
    'caller cwd must not host .episodic-memory artifacts')
  // The pre-episode lives under the target.
  const epDir = path.join(ctx.project, '.episodic-memory', 'episodes')
  const matching = fs.readdirSync(epDir).filter(n => n.startsWith(runId) && n.includes('-pre-'))
  assert.equal(matching.length, 1)
})

// ===========================================================================
// 286-7: different runIds concurrent → no cross-run attach
// ===========================================================================
tap('286-7 different runIds concurrent → no cross-run attach', async () => {
  const ctx = setupRfcDetected({ rfcs: ['RFC-CF-A', 'RFC-CF-B'] })
  const a = ctx.byRfc['RFC-CF-A']
  const b = ctx.byRfc['RFC-CF-B']
  const [r1, r2] = await Promise.all([
    preDispatchAsync(ctx, a.runId, SHA_A),
    preDispatchAsync(ctx, b.runId, SHA_B),
  ])
  assert.equal(r1.status, 0, `r1 stderr=${r1.stderr}`)
  assert.equal(r2.status, 0, `r2 stderr=${r2.stderr}`)
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[a.runId].state, 'classifier-dispatch-pending')
  assert.equal(idx.runs[b.runId].state, 'classifier-dispatch-pending')
  const idA = JSON.parse(r1.stdout).pre_episode_id
  const idB = JSON.parse(r2.stdout).pre_episode_id
  assert.notEqual(idA, idB, 'distinct runIds must mint distinct pre-episodes')
  assert.ok(idA.startsWith(a.runId), `idA should start with runId-A: ${idA}`)
  assert.ok(idB.startsWith(b.runId), `idB should start with runId-B: ${idB}`)
})

if (fail > 0) {
  console.log(`\n# FAIL ${pass}/${pass + fail} passed`)
  process.exit(1)
}
console.log(`\n# OK ${pass}/${pass + fail} passed`)
