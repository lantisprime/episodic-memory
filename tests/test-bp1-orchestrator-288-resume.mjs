#!/usr/bin/env node
/**
 * test-bp1-orchestrator-288-resume.mjs — record-classification Phase A/B
 * resume + crash recovery. Cluster #288 fix; plan v5 round-5 ACCEPT.
 *
 * Cases:
 *   288-1 crash between Phase A and Phase B → retry emits route
 *   288-2 idempotent past-Phase-B → no-op success (same JSON)
 *   288-3 backfill route_episode_id from signed route on disk
 *   288-4 drift: stored classified_episode_id mismatches current args → exit 5
 *   288-5 parent-drift: signed orphan route with wrong parent_episode → exit 5
 *   288-6 backfill missing parent: state=classified + no episode_id + no signed → exit 5
 *   288-7 trivial → planning happy path produces classified+route ids in idx
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
const { verifyKeyFingerprint } = hmacMod
const rsmod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { loadIndex, withRunStateLockExclusive, loadIndexLocked, writeIndex } = rsmod
const writerMod = await import(new URL('../scripts/lib/bp1-episode-writer.mjs', import.meta.url).href)
const { writeBp1Episode } = writerMod
const fmMod = await import(new URL('../scripts/lib/bp1-frontmatter.mjs', import.meta.url).href)
const { parseBp1Frontmatter } = fmMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-288-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-288-home-'))
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
function writeRfc(projectRoot, name) {
  fs.writeFileSync(path.join(projectRoot, 'docs', 'rfcs', `${name}.md`),
    `---\nrfc_id: ${name}\nstatus: ${JSON.stringify('accepted')}\ntitle: ${JSON.stringify('T')}\n---\n\nbody.\n`)
}
function runOrch(args, { project, homeDir }) {
  return spawnSync('node', [ORCHESTRATOR, ...args], {
    cwd: project, encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  })
}

// Build an active project that has progressed through detect-rfcs + pre-dispatch
// so the next valid action is record-classification.
function setupPreDispatched() {
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  writeRfc(project, 'RFC-A')
  writeConfig(home, project, fp)
  const dr = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  if (dr.status !== 0) throw new Error(`detect-rfcs failed: ${dr.stderr}`)
  const det = JSON.parse(dr.stdout).detected[0]
  const inputSha = crypto.randomBytes(32).toString('hex')
  const pd = runOrch([
    'record-classifier-dispatch-pre',
    '--project', project,
    '--run-id', det.run_id,
    '--input-sha256', inputSha,
  ], { project, homeDir: home })
  if (pd.status !== 0) throw new Error(`record-classifier-dispatch-pre failed: ${pd.stderr}`)
  const pdOut = JSON.parse(pd.stdout)
  const runKey = fs.readFileSync(path.join(project, '.episodic-memory/runs', det.run_id, 'run.key'))
  return {
    project, home,
    runId: det.run_id,
    preEpisodeId: pdOut.pre_episode_id,
    runKey,
  }
}

function writeResultFile(project, output = { class: 'trivial', confidence: 0.85, rationale: 'r', classified_fields: ['x'] }) {
  const p = path.join(project, 'classifier-result.json')
  fs.writeFileSync(p, JSON.stringify(output))
  return p
}

function runRecordClassification(ctx, resultFile, opts = {}) {
  return runOrch([
    'record-classification',
    '--project', ctx.project,
    '--run-id', ctx.runId,
    '--pre-episode-id', opts.preEpisodeId ?? ctx.preEpisodeId,
    '--result-file', resultFile,
  ], { project: ctx.project, homeDir: ctx.home })
}

// ===========================================================================
// 288-1 — crash between Phase A and Phase B → retry emits route
// ===========================================================================
tap('288-1 crash between Phase A and Phase B → retry emits route from classified', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project)

  // Simulate the post-Phase-A pre-Phase-B state directly: emit a signed
  // classified episode, then manually set idx { state: 'classified',
  // classified_episode_id, decided_class }. Do NOT emit a route episode.
  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: `test-induced classified`,
    parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'trivial', classifier_confidence: '0.85' },
    tags: ['bp1-classified'],
    body: '# classified\n',
    filenameSuffix: 'classified',
  })
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'classified'
    idx.runs[ctx.runId].decided_class = 'trivial'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    writeIndex(ctx.project, idx)
  })

  // Retry with same args → Phase A no-op verify-only, Phase B emits route.
  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'planning', `expected planning; got ${out.state}`)
  assert.equal(out.classified_episode_id, classifiedEp.episodeId, 'must reuse existing classified ep')
  assert.ok(out.route_episode_id, 'route episode id present')
  const idx = loadIndex(ctx.project)
  const run = idx.runs[ctx.runId]
  assert.equal(run.state, 'planning')
  assert.equal(run.classified_episode_id, classifiedEp.episodeId)
  assert.equal(run.route_episode_id, out.route_episode_id)
})

// ===========================================================================
// 288-2 — idempotent past-Phase-B: state advanced + pointers set → no-op
// ===========================================================================
tap('288-2 idempotent past-Phase-B → no-op success; same JSON', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'trivial', confidence: 0.91, rationale: 'r', classified_fields: ['x'] })
  // First call: emits classified + planning, idx fully advanced.
  const r1 = runRecordClassification(ctx, resultFile)
  assert.equal(r1.status, 0, `r1 stderr=${r1.stderr}`)
  const out1 = JSON.parse(r1.stdout)
  // Second call with same args → idempotent.
  const r2 = runRecordClassification(ctx, resultFile)
  assert.equal(r2.status, 0, `r2 stderr=${r2.stderr}`)
  const out2 = JSON.parse(r2.stdout)
  assert.equal(out1.classified_episode_id, out2.classified_episode_id, 'classified id stable')
  assert.equal(out1.route_episode_id, out2.route_episode_id, 'route id stable')
  assert.equal(out1.state, out2.state)
})

// ===========================================================================
// 288-3 — backfill route_episode_id: state advanced but pointer null + signed
// route episode on disk → attach pointer; no fresh emit
// ===========================================================================
tap('288-3 backfill route_episode_id from signed route episode on disk', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'schema', confidence: 0.7, rationale: 'r', classified_fields: ['x'] })

  // Set up the pre-bump state: emit classified + needs-human directly; idx
  // shows state=needs-human but route_episode_id=null (simulating a run
  // persisted before the schema addition landed).
  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'test classified', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'schema', classifier_confidence: '0.7' },
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  const routeEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'needs-human',
    summary: 'test needs-human', parentEpisode: classifiedEp.episodeId, expectedPostEpisodeId: null,
    customFm: { reason: 'risky-class', decided_class: 'schema' },
    tags: ['bp1-needs-human'], body: '# nh\n', filenameSuffix: 'needs-human',
  })
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'needs-human'
    idx.runs[ctx.runId].decided_class = 'schema'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    idx.runs[ctx.runId].route_episode_id = null   // pre-bump
    writeIndex(ctx.project, idx)
  })

  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'needs-human')
  assert.equal(out.route_episode_id, routeEp.episodeId, 'must attach existing route, not fresh-emit')
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].route_episode_id, routeEp.episodeId)
})

// ===========================================================================
// 288-4 — drift: stored classified_episode_id with different decided_class
// than args → recoverable-canonical-drift exit 5
// ===========================================================================
tap('288-4 drift: stored classified_episode_id with mismatched decided_class → exit 5', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'trivial', confidence: 0.85, rationale: 'r', classified_fields: ['x'] })

  // Emit a classified episode with a DIFFERENT decided_class than args will produce.
  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'mismatched', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'schema', classifier_confidence: '0.85' },   // schema ≠ trivial
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'classified'
    idx.runs[ctx.runId].decided_class = 'schema'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    writeIndex(ctx.project, idx)
  })

  // Retry with --result-file claiming trivial. Args.decided_class=trivial does
  // not match stored classified's decided_class=schema → drift error.
  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5, `expected exit 5; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /recoverable-canonical-drift/)
})

// ===========================================================================
// 288-5 — parent-drift: signed orphan route with wrong parent_episode → exit 5
// ===========================================================================
tap('288-5 Phase B orphan route with wrong parent_episode → exit 5', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'trivial', confidence: 0.85, rationale: 'r', classified_fields: ['x'] })

  // Emit a valid classified.
  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'classified', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'trivial', classifier_confidence: '0.85' },
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  // Emit a planning route with WRONG parent (points to some unrelated id).
  const fakeParent = `${ctx.runId}-fake-9999`
  writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'planning',
    summary: 'wrong-parent planning', parentEpisode: fakeParent, expectedPostEpisodeId: null,
    customFm: { source_class: 'trivial' },
    tags: ['bp1-planning'], body: '# p\n', filenameSuffix: 'planning',
  })
  // Idx: state=classified + classified_episode_id set, route null.
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'classified'
    idx.runs[ctx.runId].decided_class = 'trivial'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    writeIndex(ctx.project, idx)
  })

  // Phase B orphan-scan finds the planning episode but parent_episode
  // mismatches classified_episode_id → field-mismatch → drift.
  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5, `expected exit 5; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /recoverable-canonical-drift/)
})

// ===========================================================================
// 288-6 — backfill missing parent: state=classified + classified_episode_id null + no signed
// ===========================================================================
tap('288-6 state=classified + null classified_episode_id + no signed → recoverable-no-parent', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project)

  // Force idx to state=classified with no classified_episode_id and NO signed
  // classified episode on disk (simulating corrupt pre-bump migration).
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'classified'
    idx.runs[ctx.runId].decided_class = 'trivial'
    idx.runs[ctx.runId].classified_episode_id = null
    writeIndex(ctx.project, idx)
  })

  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5)
  assert.match(r.stderr, /recoverable-no-parent/)
})

// ===========================================================================
// 288-7 — happy path: trivial → planning; classified + route pointers in idx
// ===========================================================================
tap('288-7 trivial happy path: classified_episode_id + route_episode_id persisted in idx', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project)
  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'planning')
  const idx = loadIndex(ctx.project)
  const run = idx.runs[ctx.runId]
  assert.equal(run.state, 'planning')
  assert.equal(run.classified_episode_id, out.classified_episode_id, 'idx must persist classified_episode_id')
  assert.equal(run.route_episode_id, out.route_episode_id, 'idx must persist route_episode_id')
})

// ===========================================================================
// 288-8 — F1 planning: signed orphan planning with mismatched source_class
// must be rejected as field-mismatch (NOT silently attached).
// ===========================================================================
tap('288-8 F1: Phase B planning orphan with mismatched source_class → field-mismatch exit 5', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'trivial', confidence: 0.85, rationale: 'r', classified_fields: ['x'] })

  // Valid classified for decided_class=trivial.
  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'classified trivial', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'trivial', classifier_confidence: '0.85' },
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  // Signed planning episode with RIGHT parent but WRONG source_class.
  writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'planning',
    summary: 'tampered planning', parentEpisode: classifiedEp.episodeId, expectedPostEpisodeId: null,
    customFm: { source_class: 'tampered' },   // ≠ 'trivial'
    tags: ['bp1-planning'], body: '# p\n', filenameSuffix: 'planning',
  })
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'classified'
    idx.runs[ctx.runId].decided_class = 'trivial'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    writeIndex(ctx.project, idx)
  })

  // Phase B orphan-scan: parent matches but source_class doesn't → field-mismatch.
  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5, `expected exit 5; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /recoverable-canonical-drift/)
})

// ===========================================================================
// 288-9 — F1 needs-human: signed orphan with mismatched decided_class field
// must be rejected (NOT silently attached). Same fractal-shape sibling.
// ===========================================================================
tap('288-9 F1: Phase B needs-human orphan with mismatched decided_class → field-mismatch exit 5', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'security', confidence: 0.7, rationale: 'r', classified_fields: ['x'] })

  // Valid classified for decided_class=security.
  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'classified security', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'security', classifier_confidence: '0.7' },
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  // Signed needs-human with right parent but customFm.decided_class flipped.
  writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'needs-human',
    summary: 'tampered needs-human', parentEpisode: classifiedEp.episodeId, expectedPostEpisodeId: null,
    customFm: { reason: 'risky-class', decided_class: 'schema' },   // ≠ 'security'
    tags: ['bp1-needs-human'], body: '# nh\n', filenameSuffix: 'needs-human',
  })
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'classified'
    idx.runs[ctx.runId].decided_class = 'security'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    writeIndex(ctx.project, idx)
  })

  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5, `expected exit 5; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /recoverable-canonical-drift/)
})

// ===========================================================================
// 288-10 — F2 state=planning but decided_class implies needs-human → reject.
// ===========================================================================
tap('288-10 F2: run.state=planning but decided_class=schema (targetState mismatch) → state-violation exit 5', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'schema', confidence: 0.7, rationale: 'r', classified_fields: ['x'] })

  // Valid classified.
  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'classified schema', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'schema', classifier_confidence: '0.7' },
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  // Idx: state advanced to wrong target (planning), decided_class=schema implies needs-human.
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'planning'   // inconsistent with decided_class
    idx.runs[ctx.runId].decided_class = 'schema'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    writeIndex(ctx.project, idx)
  })

  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5, `expected exit 5; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /state-violation \(Phase B\)/)
  assert.match(r.stderr, /targetState=needs-human/)
})

// ===========================================================================
// 288-11 — F2 sibling: state=needs-human but decided_class=trivial → reject.
// ===========================================================================
tap('288-11 F2: run.state=needs-human but decided_class=trivial (targetState mismatch) → state-violation exit 5', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'trivial', confidence: 0.85, rationale: 'r', classified_fields: ['x'] })

  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'classified trivial', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'trivial', classifier_confidence: '0.85' },
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'needs-human'   // inconsistent
    idx.runs[ctx.runId].decided_class = 'trivial'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    writeIndex(ctx.project, idx)
  })

  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5, `expected exit 5; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /state-violation \(Phase B\)/)
  assert.match(r.stderr, /targetState=planning/)
})

// ===========================================================================
// 288-12 — happy path PARALLEL: non-trivial → needs-human (sibling of 288-7).
// Closes the "test trivial only" coverage gap the reviewer flagged.
// ===========================================================================
tap('288-12 needs-human happy path: classified + route ids persisted in idx + customFm round-trips', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'security', confidence: 0.92, rationale: 'r', classified_fields: ['x'] })
  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'needs-human')
  assert.equal(out.decided_class, 'security')
  const idx = loadIndex(ctx.project)
  const run = idx.runs[ctx.runId]
  assert.equal(run.state, 'needs-human')
  assert.equal(run.classified_episode_id, out.classified_episode_id)
  assert.equal(run.route_episode_id, out.route_episode_id)
  // N3: verify route episode frontmatter actually contains the customFm the
  // helper produces. Defense-in-depth: catches writer regression silently
  // dropping customFm fields. Writer's own unit tests check reserved-key
  // enforcement; this checks predicate↔persist round-trip end-to-end.
  const routeEpPath = path.join(ctx.project, '.episodic-memory', 'episodes', `${out.route_episode_id}.md`)
  const fm = parseBp1Frontmatter(fs.readFileSync(routeEpPath)).frontmatter
  assert.equal(fm.reason, 'risky-class', `route customFm.reason missing/wrong: ${JSON.stringify(fm.reason)}`)
  assert.equal(fm.decided_class, 'security', `route customFm.decided_class missing/wrong: ${JSON.stringify(fm.decided_class)}`)
  assert.equal(fm.parent_episode, out.classified_episode_id, 'route parent_episode = classified id')
})

// ===========================================================================
// 288-13 — F1 backfill: state=needs-human + route_episode_id null + signed
// needs-human on disk with WRONG reason field → field-mismatch (not attach).
// ===========================================================================
tap('288-13 F1: backfill rejects signed route with mismatched reason field', () => {
  const ctx = setupPreDispatched()
  const resultFile = writeResultFile(ctx.project, { class: 'security', confidence: 0.8, rationale: 'r', classified_fields: ['x'] })

  const classifiedEp = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'classified',
    summary: 'classified', parentEpisode: ctx.preEpisodeId, expectedPostEpisodeId: null,
    customFm: { decided_class: 'security', classifier_confidence: '0.8' },
    tags: ['bp1-classified'], body: '# c\n', filenameSuffix: 'classified',
  })
  // Signed needs-human with right parent, right decided_class, but WRONG reason.
  writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: ctx.runKey,
    type: 'state-transition', state: 'needs-human',
    summary: 'wrong-reason nh', parentEpisode: classifiedEp.episodeId, expectedPostEpisodeId: null,
    customFm: { reason: 'tampered-reason', decided_class: 'security' },   // reason ≠ 'risky-class'
    tags: ['bp1-needs-human'], body: '# nh\n', filenameSuffix: 'needs-human',
  })
  withRunStateLockExclusive(ctx.project, () => {
    const idx = loadIndexLocked(ctx.project)
    idx.runs[ctx.runId].state = 'needs-human'
    idx.runs[ctx.runId].decided_class = 'security'
    idx.runs[ctx.runId].classified_episode_id = classifiedEp.episodeId
    idx.runs[ctx.runId].route_episode_id = null   // pre-bump backfill path
    writeIndex(ctx.project, idx)
  })

  const r = runRecordClassification(ctx, resultFile)
  assert.equal(r.status, 5, `expected exit 5; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /recoverable-canonical-drift/)
})

if (fail > 0) {
  console.log(`\n# FAIL ${pass}/${pass + fail} passed`)
  process.exit(1)
}
console.log(`\n# OK ${pass}/${pass + fail} passed`)
