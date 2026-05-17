#!/usr/bin/env node
/**
 * test-bp1-orchestrator-record-awaiting-approval.mjs — Slice 2d-W E2E tests.
 *
 * Coverage (codex r3 ACCEPT requirements):
 *   - happy path: classified (trivial) → awaiting_approval + marker on disk
 *   - state transitions persist awaiting_approval_at + deadline_at deterministically
 *   - Phase B retry produces byte-identical marker (M1 determinism, codex r3)
 *   - non-trivial decided_class rejected (state-violation)
 *   - state != classified rejected (state-violation)
 *   - --classified-episode-id mismatch rejected
 *   - parent classified episode tamper → parent-tamper failure episode emitted
 *   - argv validation: --run-id shape, --classified-episode-id shape, --project resolution
 *   - axis-9 / discipline #20: caller cwd ≠ --project (artifacts land under target;
 *     caller has no .checkpoints/.episodic-memory pollution)
 *   - nested --project <target/subdir> resolves via git rev-parse (B3)
 *   - finalize cleanup: terminal transition removes marker (M2 cleanup wiring)
 *
 * NOTE (slice 2d-R FU-1, 2026-05-17): a stale header line previously claimed a
 * "linked worktree: marker writes under main-root .checkpoints/" case. No such
 * test was implemented here (only RAA-15 nested-subdir), AND the claim is
 * factually wrong per RFC §646 — `git rev-parse --show-toplevel` from a linked
 * worktree returns the WORKTREE root, not the main-checkout root, so markers
 * land under `<worktree_root>/.checkpoints/`. Reader/writer symmetry is
 * exercised by `tests/test-bp1-approval-check-hook.mjs` AC-12.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ORCHESTRATOR = path.join(REPO, 'scripts', 'bp1-orchestrator.mjs')
const ARTIFACT_BUILDER = path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs')

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyKeyFingerprint, verifyCanonical } = hmacMod
const rsmod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { loadIndex } = rsmod
const markerMod = await import(new URL('../scripts/lib/bp1-marker.mjs', import.meta.url).href)
const { markerPath, canonicalizeMarkerPayload } = markerMod
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

// =============================================================================
// Sandbox setup: project with one classified (trivial) run ready for
// record-awaiting-approval invocation.
// =============================================================================

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-raa-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-raa-home-'))
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

/**
 * Set up a project with one classified-trivial run. Returns
 * { project, home, runId, runKey, classifiedEpisodeId, preEpisodeId }.
 */
function setupClassifiedTrivial() {
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  writeRfc(project, 'RFC-RAA')
  writeConfig(home, project, fp)
  // detect-rfcs → state=rfc-detected
  const detR = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  if (detR.status !== 0) throw new Error(`detect-rfcs failed: ${detR.stderr}`)
  const det = JSON.parse(detR.stdout).detected[0]
  const runId = det.run_id
  const runKey = fs.readFileSync(path.join(project, '.episodic-memory/runs', runId, 'run.key'))
  // record-classifier-dispatch-pre → state=classifier-dispatch-pending
  const sha = crypto.randomBytes(32).toString('hex')
  const preR = runOrch([
    'record-classifier-dispatch-pre', '--project', project, '--run-id', runId,
    '--input-sha256', sha,
  ], { project, homeDir: home })
  if (preR.status !== 0) throw new Error(`pre-dispatch failed: ${preR.stderr}`)
  const preEpisodeId = JSON.parse(preR.stdout).pre_episode_id
  // record-classification trivial → state=classified (slice 2d-W Option A)
  const resultFile = path.join(project, 'classifier-result.json')
  fs.writeFileSync(resultFile, JSON.stringify({
    class: 'trivial', confidence: 0.9, rationale: 'r', classified_fields: ['x'],
  }))
  const clsR = runOrch([
    'record-classification', '--project', project, '--run-id', runId,
    '--pre-episode-id', preEpisodeId, '--result-file', resultFile,
  ], { project, homeDir: home })
  if (clsR.status !== 0) throw new Error(`classification failed: ${clsR.stderr}`)
  const cls = JSON.parse(clsR.stdout)
  return {
    project, home, runId, runKey,
    classifiedEpisodeId: cls.classified_episode_id,
    preEpisodeId,
  }
}

/**
 * Run record-awaiting-approval on a setupClassifiedTrivial context.
 */
function runRecordAwaiting(ctx, { project, classifiedEpisodeId, runId, callerCwd } = {}) {
  return runOrch([
    'record-awaiting-approval',
    '--project', project ?? ctx.project,
    '--run-id', runId ?? ctx.runId,
    '--classified-episode-id', classifiedEpisodeId ?? ctx.classifiedEpisodeId,
  ], { project: ctx.project, homeDir: ctx.home, callerCwd: callerCwd ?? ctx.project })
}

// =============================================================================
// Happy path
// =============================================================================

tap('RAA-1 happy path: classified (trivial) → awaiting_approval + marker on disk', () => {
  const ctx = setupClassifiedTrivial()
  const r = runRecordAwaiting(ctx)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'awaiting_approval')
  assert.ok(out.awaiting_approval_episode_id)
  assert.ok(out.awaiting_approval_at)
  assert.ok(out.deadline_at)
  assert.equal(out.marker_already_present, false)
  // run-state advanced + new fields persisted.
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'awaiting_approval')
  assert.equal(idx.runs[ctx.runId].awaiting_approval_at, out.awaiting_approval_at)
  assert.equal(idx.runs[ctx.runId].deadline_at, out.deadline_at)
  // marker exists at canonical path.
  assert.equal(out.marker_path, markerPath(ctx.project, ctx.runId))
  assert.ok(fs.existsSync(out.marker_path))
  // marker payload verifiable.
  const marker = JSON.parse(fs.readFileSync(out.marker_path, 'utf8'))
  assert.equal(marker.run_id, ctx.runId)
  assert.equal(marker.decided_class, 'trivial')
  assert.equal(marker.created_at, out.awaiting_approval_at)
  assert.equal(marker.deadline_at, out.deadline_at)
  // HMAC round-trips with the run key.
  const { canonicalBytes } = canonicalizeMarkerPayload({
    run_id: marker.run_id, created_at: marker.created_at,
    decided_class: marker.decided_class, deadline_at: marker.deadline_at,
  })
  assert.ok(verifyCanonical(canonicalBytes, ctx.runKey, marker.hmac))
})

tap('RAA-2 deadline_at == awaiting_approval_at + 1hr per RFC §954', () => {
  const ctx = setupClassifiedTrivial()
  const r = runRecordAwaiting(ctx)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  const a = new Date(out.awaiting_approval_at).getTime()
  const d = new Date(out.deadline_at).getTime()
  assert.equal(d - a, 60 * 60 * 1000)
})

tap('RAA-3 idempotent re-invocation: byte-identical marker, alreadyPresent=true (M1 determinism)', () => {
  const ctx = setupClassifiedTrivial()
  const r1 = runRecordAwaiting(ctx)
  assert.equal(r1.status, 0)
  const out1 = JSON.parse(r1.stdout)
  const bytes1 = fs.readFileSync(out1.marker_path)
  const r2 = runRecordAwaiting(ctx)
  assert.equal(r2.status, 0)
  const out2 = JSON.parse(r2.stdout)
  assert.equal(out2.marker_already_present, true)
  assert.equal(out1.awaiting_approval_at, out2.awaiting_approval_at)
  assert.equal(out1.deadline_at, out2.deadline_at)
  assert.equal(out1.awaiting_approval_episode_id, out2.awaiting_approval_episode_id)
  const bytes2 = fs.readFileSync(out2.marker_path)
  assert.ok(bytes1.equals(bytes2), 'byte-identical marker on retry')
})

// =============================================================================
// Argv validation
// =============================================================================

tap('RAA-4 missing --project → exit 2', () => {
  const ctx = setupClassifiedTrivial()
  const r = runOrch(['record-awaiting-approval', '--run-id', ctx.runId, '--classified-episode-id', ctx.classifiedEpisodeId],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('RAA-5 missing --run-id → exit 2', () => {
  const ctx = setupClassifiedTrivial()
  const r = runOrch(['record-awaiting-approval', '--project', ctx.project, '--classified-episode-id', ctx.classifiedEpisodeId],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('RAA-6 missing --classified-episode-id → exit 2', () => {
  const ctx = setupClassifiedTrivial()
  const r = runOrch(['record-awaiting-approval', '--project', ctx.project, '--run-id', ctx.runId],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('RAA-7 --classified-episode-id with traversal chars → exit 2', () => {
  const ctx = setupClassifiedTrivial()
  const r = runOrch(['record-awaiting-approval', '--project', ctx.project, '--run-id', ctx.runId,
    '--classified-episode-id', '../escape'],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('RAA-8 --project pointing to non-existent path → exit 2', () => {
  const ctx = setupClassifiedTrivial()
  const r = runOrch(['record-awaiting-approval', '--project', '/nonexistent/path/here',
    '--run-id', ctx.runId, '--classified-episode-id', ctx.classifiedEpisodeId],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('RAA-9 --project not a git repo → exit 2 (project-root-resolution-failed)', () => {
  const ctx = setupClassifiedTrivial()
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-raa-nogit-'))
  const r = runOrch(['record-awaiting-approval', '--project', nonGitDir,
    '--run-id', ctx.runId, '--classified-episode-id', ctx.classifiedEpisodeId],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /project-root-resolution-failed|not a git repo/)
})

// =============================================================================
// State invariants
// =============================================================================

tap('RAA-10 state != classified → exit 5 (state-violation)', () => {
  // Setup: classified-trivial-pending then advance state to active manually.
  const ctx = setupClassifiedTrivial()
  // Use a non-trivial class by tampering would change state; here we just
  // exercise the rejection on stale state. Use a fresh setup where we DON'T
  // run record-classification yet (state=classifier-dispatch-pending).
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  writeRfc(project, 'RFC-RAA-X')
  writeConfig(home, project, fp)
  const detR = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  const det = JSON.parse(detR.stdout).detected[0]
  const sha = crypto.randomBytes(32).toString('hex')
  runOrch(['record-classifier-dispatch-pre', '--project', project, '--run-id', det.run_id,
    '--input-sha256', sha], { project, homeDir: home })
  // state is now classifier-dispatch-pending; record-awaiting-approval needs classified.
  const fakeCls = `${det.run_id}-classified-aaaa`
  const r = runOrch(['record-awaiting-approval', '--project', project, '--run-id', det.run_id,
    '--classified-episode-id', fakeCls], { project, homeDir: home })
  assert.equal(r.status, 5)
  assert.match(r.stderr, /state-violation|expected=classified/)
})

tap('RAA-11 decided_class != trivial → exit 5 (class-restriction state-violation)', () => {
  // Setup classified-schema run; record-awaiting-approval must refuse.
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  writeRfc(project, 'RFC-RAA-RISKY')
  writeConfig(home, project, fp)
  const detR = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  const det = JSON.parse(detR.stdout).detected[0]
  const sha = crypto.randomBytes(32).toString('hex')
  const preR = runOrch(['record-classifier-dispatch-pre', '--project', project, '--run-id', det.run_id,
    '--input-sha256', sha], { project, homeDir: home })
  const preEpisodeId = JSON.parse(preR.stdout).pre_episode_id
  const resultFile = path.join(project, 'classifier-result.json')
  fs.writeFileSync(resultFile, JSON.stringify({
    class: 'schema', confidence: 0.9, rationale: 'r', classified_fields: ['x'],
  }))
  const clsR = runOrch([
    'record-classification', '--project', project, '--run-id', det.run_id,
    '--pre-episode-id', preEpisodeId, '--result-file', resultFile,
  ], { project, homeDir: home })
  assert.equal(clsR.status, 0)
  const cls = JSON.parse(clsR.stdout)
  // schema → needs-human; state is now needs-human, not classified.
  const r = runOrch(['record-awaiting-approval', '--project', project,
    '--run-id', det.run_id, '--classified-episode-id', cls.classified_episode_id],
    { project, homeDir: home })
  assert.equal(r.status, 5)
  // Could be either state-violation (state=needs-human) or class restriction;
  // either way exit 5 and stderr names the issue.
  assert.match(r.stderr, /state-violation/)
})

tap('RAA-12 --classified-episode-id mismatch → exit 5', () => {
  const ctx = setupClassifiedTrivial()
  const bogus = `${ctx.runId}-classified-9999`
  const r = runRecordAwaiting(ctx, { classifiedEpisodeId: bogus })
  assert.equal(r.status, 5)
  assert.match(r.stderr, /classified-episode-id.*!=|state-violation/)
})

tap('RAA-12b resume-branch --classified-episode-id mismatch → precise state-violation (parity with fresh-emit gate)', () => {
  // After a successful Phase A (state=awaiting_approval, classified_episode_id
  // persisted), re-invoking with a different --classified-episode-id should
  // surface the same precise state-violation error as the fresh-emit gate,
  // not the generic recoverable-canonical-drift from findSignedStateEpisode.
  const ctx = setupClassifiedTrivial()
  const r1 = runRecordAwaiting(ctx)
  assert.equal(r1.status, 0, `fresh emit setup: stderr=${r1.stderr}`)
  const bogus = `${ctx.runId}-classified-9999`
  const r2 = runRecordAwaiting(ctx, { classifiedEpisodeId: bogus })
  assert.equal(r2.status, 5)
  assert.match(r2.stderr, /state-violation: --classified-episode-id .* != run\.classified_episode_id/)
})

tap('RAA-3b Phase-A orphan window: signed awaiting_approval ep + state=classified → retry adopts orphan timestamps (codex PR-#305 r1 P1)', () => {
  // Simulate the crash-after-emit-before-writeIndex window: emit a signed
  // awaiting_approval episode directly (bypassing the orchestrator), leave
  // run-state at `classified`, then retry record-awaiting-approval.
  // Pre-fix: fresh path mints a new timestamp, findSignedStateEpisode with
  // expectedFields returns field-mismatch → recoverable-canonical-drift exit 5.
  // Post-fix: orphan-lookup-first WITHOUT expectedFields adopts orphan's
  // timestamps, transitions state, Phase B writes byte-identical marker.
  const ctx = setupClassifiedTrivial()
  const orphanAwaitingAt = '2026-01-02T03:04:05.678Z'
  const orphanDeadlineAt = new Date(new Date(orphanAwaitingAt).getTime() + 3600 * 1000).toISOString()
  const orphan = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'awaiting_approval',
    summary: `BP-1 awaiting_approval (deadline ${orphanDeadlineAt}): ${ctx.runId}`,
    parentEpisode: ctx.classifiedEpisodeId, expectedPostEpisodeId: null,
    customFm: {
      awaiting_approval_at: orphanAwaitingAt,
      deadline_at: orphanDeadlineAt,
      decided_class: 'trivial',
    },
    tags: ['bp1-awaiting-approval'],
    body: `# bp1-awaiting-approval orphan — ${ctx.runId}\n`,
    filenameSuffix: 'awaiting-approval',
  })
  // Run-state still at classified (the crash window).
  const idxBefore = loadIndex(ctx.project)
  assert.equal(idxBefore.runs[ctx.runId].state, 'classified')
  // awaiting_approval_at is `null` (explicit) on a v2 row before Phase A persists.
  assert.equal(idxBefore.runs[ctx.runId].awaiting_approval_at, null)
  // Retry record-awaiting-approval.
  const r = runRecordAwaiting(ctx)
  assert.equal(r.status, 0, `orphan-attach retry failed: ${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.awaiting_approval_episode_id, orphan.episodeId,
    'retry must attach the orphan, not emit a new awaiting_approval episode')
  assert.equal(out.awaiting_approval_at, orphanAwaitingAt,
    'retry must adopt orphan timestamp, not mint fresh wall-clock')
  assert.equal(out.deadline_at, orphanDeadlineAt)
  // Confirm: still only 1 signed awaiting_approval episode on disk.
  const epDir = path.join(ctx.project, '.episodic-memory', 'episodes')
  const matching = fs.readdirSync(epDir).filter(n => n.startsWith(ctx.runId) && n.includes('-awaiting-approval-') && !n.includes('.tmp.'))
  assert.equal(matching.length, 1, `expected exactly 1 signed awaiting_approval ep; got ${matching.length}: ${matching.join(',')}`)
  // Marker on disk uses orphan's timestamps.
  const mp = markerPath(ctx.project, ctx.runId)
  const marker = JSON.parse(fs.readFileSync(mp, 'utf8'))
  assert.equal(marker.created_at, orphanAwaitingAt)
  assert.equal(marker.deadline_at, orphanDeadlineAt)
})

tap('RAA-3c Phase-A orphan window: orphan parent_episode mismatch → recoverable-canonical-drift exit 5', () => {
  // Defense: if a signed orphan exists but its parent_episode does NOT match
  // --classified-episode-id, the orphan belongs to a different classification
  // context. Refuse to attach.
  const ctx = setupClassifiedTrivial()
  const wrongParent = `${ctx.runId}-classified-9999`
  writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'awaiting_approval',
    summary: `BP-1 awaiting_approval orphan with wrong parent: ${ctx.runId}`,
    parentEpisode: wrongParent, expectedPostEpisodeId: null,
    customFm: {
      awaiting_approval_at: '2026-01-02T03:04:05.678Z',
      deadline_at: '2026-01-02T04:04:05.678Z',
      decided_class: 'trivial',
    },
    tags: ['bp1-awaiting-approval'],
    body: `# orphan wrong-parent\n`,
    filenameSuffix: 'awaiting-approval',
  })
  const r = runRecordAwaiting(ctx)
  assert.equal(r.status, 5)
  assert.match(r.stderr, /recoverable-canonical-drift.*parent_episode.*!=.*--classified-episode-id/)
})

tap('RAA-13 parent classified episode tampered → exit 5 + parent-tamper failure ep', () => {
  const ctx = setupClassifiedTrivial()
  const epPath = path.join(ctx.project, '.episodic-memory/episodes', `${ctx.classifiedEpisodeId}.md`)
  fs.writeFileSync(epPath, fs.readFileSync(epPath, 'utf8') + '\nTAMPERED\n')
  const r = runRecordAwaiting(ctx)
  assert.equal(r.status, 5)
  const eps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(eps.some(f => f.includes('parent-tamper')), 'parent-tamper failure ep emitted')
})

// =============================================================================
// Axis-9 / discipline #20: caller cwd ≠ --project
// =============================================================================

tap('RAA-14 caller cwd ≠ --project → marker + episodes land under target only', () => {
  const ctx = setupClassifiedTrivial()
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-raa-caller-'))
  execFileSync('git', ['init', '-q'], { cwd: otherDir })
  const r = runRecordAwaiting(ctx, { callerCwd: otherDir })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  // Target has marker + signed episode.
  assert.ok(fs.existsSync(out.marker_path))
  const targetEps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(targetEps.some(f => f.includes('awaiting-approval')))
  // Caller cwd has NO .checkpoints/ nor .episodic-memory/ pollution.
  assert.ok(!fs.existsSync(path.join(otherDir, '.checkpoints')))
  assert.ok(!fs.existsSync(path.join(otherDir, '.episodic-memory', 'episodes')))
})

tap('RAA-15 nested --project <target/subdir> resolves to canonical root via git toplevel (B3)', () => {
  const ctx = setupClassifiedTrivial()
  const subdir = path.join(ctx.project, 'docs')   // exists from makeProj
  const r = runOrch(['record-awaiting-approval', '--project', subdir,
    '--run-id', ctx.runId, '--classified-episode-id', ctx.classifiedEpisodeId],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  // Marker MUST land under the canonical root, not under the subdir.
  assert.equal(out.marker_path, markerPath(ctx.project, ctx.runId))
  assert.ok(fs.existsSync(out.marker_path))
  assert.ok(!fs.existsSync(path.join(subdir, '.checkpoints')))
})

// =============================================================================
// Finalize cleanup (M2 cleanup wiring)
// =============================================================================

tap('RAA-16 finalize-run E2E removes marker via orchestrator callsite (codex r3 P2)', () => {
  // Codex r3 P2: RAA-16 previously tested cleanupApprovalMarker() directly.
  // Replace with an orchestrator-level finalize-run E2E so the actual callsite
  // wiring at scripts/bp1-orchestrator.mjs (post-markTerminal cleanup) is
  // exercised end-to-end.
  const ctx = setupClassifiedTrivial()
  // First write the marker via record-awaiting-approval.
  const raa = runRecordAwaiting(ctx)
  assert.equal(raa.status, 0)
  const raaOut = JSON.parse(raa.stdout)
  assert.ok(fs.existsSync(raaOut.marker_path), 'marker exists pre-finalize')
  // Now finalize the run. This exercises the orchestrator's markTerminal +
  // cleanupApprovalMarker callsite (the wiring under test).
  const fin = runOrch(['finalize-run', '--project', ctx.project, '--run-id', ctx.runId],
    { project: ctx.project, homeDir: ctx.home })
  assert.equal(fin.status, 0, `finalize-run failed: stderr=${fin.stderr}`)
  // Verify: terminal state + marker removed.
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'complete')
  assert.ok(!fs.existsSync(raaOut.marker_path), 'marker removed by orchestrator cleanup callsite')
})

tap('RAA-18 marker-write-failed evidence lands under target only (codex r3 P2)', () => {
  // Codex r3 P2: assert failure-episode disk location for marker-write-failed,
  // not just exit code. Inject a writeMarker failure by pre-creating the
  // target marker path as a DIRECTORY (so the atomic rename fails since you
  // can't rename a file over a directory).
  const ctx = setupClassifiedTrivial()
  // Pre-create the marker path as a directory.
  const target = markerPath(ctx.project, ctx.runId)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  // Run from a different cwd to verify caller-cwd isolation as well.
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-raa-callerm-'))
  execFileSync('git', ['init', '-q'], { cwd: otherDir })
  const r = runRecordAwaiting(ctx, { callerCwd: otherDir })
  // Exit 3 == marker-write-failed per contract.json subcommand_contracts.
  assert.equal(r.status, 3, `expected exit 3 (marker-write-failed); got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /marker-write-failed/)
  // Failure episode under target.
  const targetEps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(targetEps.some(f => f.includes('marker-write-failed')),
    `marker-write-failed episode emitted under target; got eps=${targetEps.join(',')}`)
  // Caller cwd has zero pollution.
  assert.ok(!fs.existsSync(path.join(otherDir, '.episodic-memory', 'episodes')),
    'caller cwd has no .episodic-memory/episodes')
  assert.ok(!fs.existsSync(path.join(otherDir, '.checkpoints')),
    'caller cwd has no .checkpoints')
  // Run-state stays at awaiting_approval (Phase A succeeded; Phase B failed).
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'awaiting_approval')
})

// =============================================================================
// Activation gate
// =============================================================================

tap('RAA-17 disabled project (flag-check refusal) → exit 1', () => {
  const ctx = setupClassifiedTrivial()
  // Disable the project in config.
  const configPath = path.join(ctx.home, '.episodic-memory/config.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.bp1.activations[ctx.project].enabled = false
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  const r = runRecordAwaiting(ctx)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /bp1 inert/)
})

// =============================================================================
// Bail summary
// =============================================================================

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
if (fail > 0) process.exit(1)
