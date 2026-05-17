#!/usr/bin/env node
/**
 * test-bp1-orchestrator-confirm-approval.mjs — Slice 2d-R E2E tests for the
 * `confirm-approval` subcommand (RFC-004 §178, §540 row 8).
 *
 * Coverage (10 cases, contract-driven from contract.json subcommand_contracts):
 *   CA-1  happy path: awaiting_approval (expired) → auto_approved + signed
 *         state-transition episode + marker unlink + run.state=auto_approved
 *   CA-2  idempotent re-invocation: state already terminal → exit 0
 *         already_terminal=true, episode_id reused, no double-emit
 *   CA-3  deadline-not-expired → exit 5
 *   CA-4  state=classified (not awaiting_approval) → exit 5 state-violation
 *   CA-5  run-missing → exit 5
 *   CA-6  invalid --outcome=approved → exit 2
 *   CA-7  missing --run-id → exit 2
 *   CA-8  missing --outcome → exit 2
 *   CA-9  marker already absent (operator pre-removed) → exit 0 + marker_already_absent=true
 *   CA-10 signed episode canonical fields {state, auto_approved_at, deadline_at,
 *         decided_class} + parent_episode = awaiting_approval episode id
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
const { loadIndex, updateRunState } = rsmod
const markerMod = await import(new URL('../scripts/lib/bp1-marker.mjs', import.meta.url).href)
const { markerPath, writeMarker } = markerMod
const fmMod = await import(new URL('../scripts/lib/bp1-frontmatter.mjs', import.meta.url).href)
const { parseBp1Frontmatter } = fmMod
const keysMod = await import(new URL('../scripts/lib/bp1-keys.mjs', import.meta.url).href)
const { loadRunKey } = keysMod
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
// Sandbox setup (mirrors test-bp1-orchestrator-record-awaiting-approval.mjs)
// ---------------------------------------------------------------------------

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ca-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ca-home-'))
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
function runOrch(args, { project, homeDir, callerCwd }) {
  return spawnSync('node', [ORCHESTRATOR, ...args], {
    cwd: callerCwd ?? project, encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  })
}

/** Drive an isolated project from detect-rfcs through record-awaiting-approval. */
function setupAwaitingApproval() {
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  writeRfc(project, 'RFC-CA')
  writeConfig(home, project, fp)
  const detR = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  if (detR.status !== 0) throw new Error(`detect-rfcs failed: ${detR.stderr}`)
  const runId = JSON.parse(detR.stdout).detected[0].run_id
  const sha = crypto.randomBytes(32).toString('hex')
  const preR = runOrch([
    'record-classifier-dispatch-pre', '--project', project, '--run-id', runId,
    '--input-sha256', sha,
  ], { project, homeDir: home })
  if (preR.status !== 0) throw new Error(`pre-dispatch failed: ${preR.stderr}`)
  const preEpisodeId = JSON.parse(preR.stdout).pre_episode_id
  const resultFile = path.join(project, 'classifier-result.json')
  fs.writeFileSync(resultFile, JSON.stringify({
    class: 'trivial', confidence: 0.9, rationale: 'r', classified_fields: ['x'],
  }))
  const clsR = runOrch([
    'record-classification', '--project', project, '--run-id', runId,
    '--pre-episode-id', preEpisodeId, '--result-file', resultFile,
  ], { project, homeDir: home })
  if (clsR.status !== 0) throw new Error(`classification failed: ${clsR.stderr}`)
  const classifiedEpisodeId = JSON.parse(clsR.stdout).classified_episode_id
  const raaR = runOrch([
    'record-awaiting-approval', '--project', project, '--run-id', runId,
    '--classified-episode-id', classifiedEpisodeId,
  ], { project, homeDir: home })
  if (raaR.status !== 0) throw new Error(`record-awaiting-approval failed: ${raaR.stderr}`)
  const raa = JSON.parse(raaR.stdout)
  return {
    project, home, runId, classifiedEpisodeId,
    awaitingApprovalEpisodeId: raa.awaiting_approval_episode_id,
    awaitingApprovalAt: raa.awaiting_approval_at,
    deadlineAt: raa.deadline_at,
  }
}

/**
 * Backdate deadline_at to make the run eligible for auto_approved.
 *
 * PR-level audit F2 closure 2026-05-17: confirm-approval now enforces that
 * run-state's awaiting_approval_at + deadline_at + decided_class match the
 * signed awaiting_approval episode's fields. The fixture must keep all three
 * (run-state, signed episode, marker) in sync — backdating run-state in
 * isolation would trip the new recoverable-canonical-drift exit.
 */
function expireDeadline(ctx, msAgo = 1) {
  const expired = new Date(Date.now() - msAgo).toISOString()
  // 1. Update run-state.
  const r = updateRunState(ctx.project, ctx.runId, { deadline_at: expired })
  if (r.error) throw new Error(`updateRunState failed: ${r.error}`)
  // 2. Rewrite the signed awaiting_approval episode with backdated deadline_at.
  const keyResult = loadRunKey(ctx.project, ctx.runId)
  if (keyResult.error) throw new Error(`loadRunKey: ${keyResult.error}`)
  const episodesDir = path.join(ctx.project, '.episodic-memory/episodes')
  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith('.md'))
  let parentEpisodeFile = null
  let priorParent = null
  let decidedClass = null
  let awaitingApprovalAt = null
  // Frontmatter strings are JSON-quoted via serializeFmValue; state and null
  // parent_episode are unquoted bare tokens.
  const stripQuotes = s => s.replace(/^"|"$/g, '').replace(/\\"/g, '"')
  for (const f of files) {
    const txt = fs.readFileSync(path.join(episodesDir, f), 'utf8')
    if (!txt.includes(`run_id: ${JSON.stringify(ctx.runId)}`)) continue
    if (!txt.includes('state: awaiting_approval')) continue
    parentEpisodeFile = path.join(episodesDir, f)
    const mAwaiting = txt.match(/^awaiting_approval_at: (.+)$/m)
    const mClass = txt.match(/^decided_class: (.+)$/m)
    const mParent = txt.match(/^parent_episode: (.+)$/m)
    if (mAwaiting) awaitingApprovalAt = stripQuotes(mAwaiting[1].trim())
    if (mClass) decidedClass = stripQuotes(mClass[1].trim())
    if (mParent) priorParent = stripQuotes(mParent[1].trim())
    break
  }
  if (!parentEpisodeFile) throw new Error(`no awaiting_approval episode found for ${ctx.runId}`)
  fs.unlinkSync(parentEpisodeFile)
  const newParent = writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: keyResult.key32B,
    type: 'state-transition', state: 'awaiting_approval',
    summary: `BP-1 awaiting_approval (deadline ${expired}): ${ctx.runId}`,
    parentEpisode: priorParent, expectedPostEpisodeId: null,
    customFm: {
      awaiting_approval_at: awaitingApprovalAt,
      deadline_at: expired,
      decided_class: decidedClass,
    },
    tags: ['bp1-awaiting-approval'],
    body: `# bp1-awaiting-approval — ${ctx.runId}\n\n(time fast-forwarded by test fixture)\n`,
    filenameSuffix: 'awaiting-approval',
  })
  // Re-emission changes the parent episode id; expose it so tests asserting
  // parent_episode linkage compare against the surviving (re-emitted) parent.
  ctx.awaitingApprovalEpisodeId = newParent.episodeId
  // 3. Rewrite the marker with backdated deadline_at.
  const existing = JSON.parse(fs.readFileSync(markerPath(ctx.project, ctx.runId), 'utf8'))
  const now = new Date().toISOString()
  fs.unlinkSync(markerPath(ctx.project, ctx.runId))
  const w = writeMarker({
    projectRoot: ctx.project, runId: ctx.runId,
    decidedClass: existing.decided_class,
    createdAt: now,
    deadlineAt: expired,
    runKey32B: keyResult.key32B,
  })
  if (w.status !== 'ok') throw new Error(`writeMarker (rewrite): ${w.code} ${w.message}`)
  // Mutate ctx so callers that captured the original deadline see the update.
  ctx.deadlineAt = expired
  return expired
}

function runConfirm(ctx, overrides = {}) {
  const argv = ['confirm-approval']
  if (overrides.project !== null) argv.push('--project', overrides.project ?? ctx.project)
  if (overrides.runId !== null) argv.push('--run-id', overrides.runId ?? ctx.runId)
  if (overrides.outcome !== null) argv.push('--outcome', overrides.outcome ?? 'auto_approved')
  return runOrch(argv, { project: ctx.project, homeDir: ctx.home })
}

// ---------------------------------------------------------------------------
// CA-1 — happy path
// ---------------------------------------------------------------------------

tap('CA-1 happy path: awaiting_approval (expired) → auto_approved + marker removed', () => {
  const ctx = setupAwaitingApproval()
  // marker must exist post-record-awaiting-approval
  const mp = markerPath(ctx.project, ctx.runId)
  assert.ok(fs.existsSync(mp), 'marker present before confirm-approval')
  expireDeadline(ctx)
  const r = runConfirm(ctx)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'auto_approved')
  assert.equal(out.run_id, ctx.runId)
  assert.ok(out.outcome_episode_id, 'outcome_episode_id returned')
  assert.ok(out.auto_approved_at, 'auto_approved_at returned')
  assert.equal(out.decided_class, 'trivial')
  assert.equal(out.already_terminal, false)
  // run-state advanced to auto_approved + terminal_at set.
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'auto_approved')
  assert.equal(idx.runs[ctx.runId].terminal_at, out.auto_approved_at)
  // marker unlinked
  assert.equal(fs.existsSync(mp), false, 'marker file removed')
  assert.equal(out.marker_already_absent, false)
})

// ---------------------------------------------------------------------------
// CA-2 — idempotent re-invocation
// ---------------------------------------------------------------------------

tap('CA-2 idempotent re-invocation: already-terminal returns same episode_id', () => {
  const ctx = setupAwaitingApproval()
  expireDeadline(ctx)
  const r1 = runConfirm(ctx)
  assert.equal(r1.status, 0)
  const out1 = JSON.parse(r1.stdout)
  const r2 = runConfirm(ctx)
  assert.equal(r2.status, 0, `stderr=${r2.stderr}`)
  const out2 = JSON.parse(r2.stdout)
  assert.equal(out2.state, 'auto_approved')
  assert.equal(out2.already_terminal, true, 'second invocation reports already_terminal')
  assert.equal(out2.outcome_episode_id, out1.outcome_episode_id, 'same episode id reused')
  // run-state unchanged.
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'auto_approved')
})

// ---------------------------------------------------------------------------
// CA-3 — deadline-not-expired
// ---------------------------------------------------------------------------

tap('CA-3 deadline-not-expired → exit 5', () => {
  const ctx = setupAwaitingApproval()
  // Do NOT expire the deadline — it's 1hr in the future.
  const r = runConfirm(ctx)
  assert.equal(r.status, 5)
  assert.ok(r.stderr.includes('deadline-not-expired'), `stderr=${r.stderr}`)
  // run-state still awaiting_approval
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'awaiting_approval')
  // marker still present.
  assert.ok(fs.existsSync(markerPath(ctx.project, ctx.runId)))
})

// ---------------------------------------------------------------------------
// CA-4 — state=classified (not awaiting_approval) → state-violation
// ---------------------------------------------------------------------------

tap('CA-4 state=classified rejected (state-violation) → exit 5', () => {
  const ctx = setupAwaitingApproval()
  // Force run-state back to classified (synthetic — bypasses normal flow).
  const r0 = updateRunState(ctx.project, ctx.runId, { state: 'classified' })
  assert.equal(r0.ok, true)
  expireDeadline(ctx)
  const r = runConfirm(ctx)
  assert.equal(r.status, 5)
  assert.ok(r.stderr.includes('state-violation'), `stderr=${r.stderr}`)
  assert.ok(r.stderr.includes('expected=awaiting_approval'))
})

// ---------------------------------------------------------------------------
// CA-5 — run-missing
// ---------------------------------------------------------------------------

tap('CA-5 run-missing → exit 5', () => {
  const ctx = setupAwaitingApproval()
  // Use a syntactically-valid run-id that doesn't exist in the index.
  const ghostRunId = 'bp1-run-1700000000000-rfc-ghost-deadbe'
  // Create a key for the ghost run so loadRunKey succeeds and we reach the
  // run-missing branch (rather than failing on key load first).
  const ghostKeyDir = path.join(ctx.project, '.episodic-memory/runs', ghostRunId)
  fs.mkdirSync(ghostKeyDir, { recursive: true })
  fs.writeFileSync(path.join(ghostKeyDir, 'run.key'), crypto.randomBytes(32), { mode: 0o600 })
  const r = runConfirm(ctx, { runId: ghostRunId })
  assert.equal(r.status, 5)
  assert.ok(r.stderr.includes('run-missing'), `stderr=${r.stderr}`)
})

// ---------------------------------------------------------------------------
// CA-6 — invalid --outcome
// ---------------------------------------------------------------------------

tap('CA-6 invalid --outcome=approved → exit 2 invalid-outcome', () => {
  const ctx = setupAwaitingApproval()
  expireDeadline(ctx)
  const r = runConfirm(ctx, { outcome: 'approved' })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--outcome'))
  assert.ok(r.stderr.includes('auto_approved'))
})

// ---------------------------------------------------------------------------
// CA-7 — missing --run-id
// ---------------------------------------------------------------------------

tap('CA-7 missing --run-id → exit 2', () => {
  const ctx = setupAwaitingApproval()
  const r = runConfirm(ctx, { runId: null })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--run-id'))
})

// ---------------------------------------------------------------------------
// CA-8 — missing --outcome
// ---------------------------------------------------------------------------

tap('CA-8 missing --outcome → exit 2', () => {
  const ctx = setupAwaitingApproval()
  const r = runConfirm(ctx, { outcome: null })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--outcome'))
})

// ---------------------------------------------------------------------------
// CA-9 — marker already absent
// ---------------------------------------------------------------------------

tap('CA-9 marker already absent → exit 0 + marker_already_absent=true', () => {
  const ctx = setupAwaitingApproval()
  expireDeadline(ctx)
  // Operator removed marker before confirm-approval ran.
  fs.unlinkSync(markerPath(ctx.project, ctx.runId))
  const r = runConfirm(ctx)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'auto_approved')
  assert.equal(out.marker_already_absent, true, 'reports marker_already_absent')
})

// ---------------------------------------------------------------------------
// CA-10 — signed episode canonical fields + parent_episode linkage
// ---------------------------------------------------------------------------

tap('CA-10 signed episode has canonical fields + parent_episode = awaiting_approval episode', () => {
  const ctx = setupAwaitingApproval()
  expireDeadline(ctx)
  const r = runConfirm(ctx)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  const episodeDir = path.join(ctx.project, '.episodic-memory/episodes')
  const files = fs.readdirSync(episodeDir).filter(f => f.endsWith('.md'))
  const autoFile = files.find(f => f.includes('auto-approved') && f.includes(ctx.runId))
  assert.ok(autoFile, `auto-approved episode file present in ${files.join(', ')}`)
  const content = fs.readFileSync(path.join(episodeDir, autoFile), 'utf8')
  const { frontmatter } = parseBp1Frontmatter(content)
  // Canonical fields per contract.json state-transition:auto_approved
  assert.equal(frontmatter.state, 'auto_approved')
  assert.equal(frontmatter.auto_approved_at, out.auto_approved_at)
  assert.equal(frontmatter.deadline_at, out.deadline_at)
  assert.equal(frontmatter.decided_class, 'trivial')
  // Parent linkage
  assert.equal(frontmatter.parent_episode, ctx.awaitingApprovalEpisodeId,
    'parent_episode == awaiting_approval episode id')
  // HMAC signature present
  assert.ok(frontmatter.hmac_signature, 'episode HMAC-signed')
})

// ---------------------------------------------------------------------------
// CA-11 — non-trivial run.decided_class rejected at confirm boundary
// ---------------------------------------------------------------------------
//
// PR-level audit F2 closure 2026-05-17. The classifier never emits
// awaiting_approval for non-trivial today, but the confirm-approval boundary
// must independently enforce `decided_class === "trivial"`. Catches the case
// where a future classifier regression (or a manual run-state edit) attempts
// to drive auto_approved on a non-trivial run.
// ---------------------------------------------------------------------------

tap('CA-11 non-trivial run.decided_class → state-violation exit 5', () => {
  const ctx = setupAwaitingApproval()
  // Forcibly rewrite run.decided_class to a non-trivial value (synthetic
  // attack — the classifier would never emit this combination).
  const r0 = updateRunState(ctx.project, ctx.runId, { decided_class: 'schema' })
  assert.equal(r0.ok, true)
  expireDeadline(ctx)
  const r = runConfirm(ctx)
  assert.equal(r.status, 5, `expected exit 5; stderr=${r.stderr}`)
  assert.ok(r.stderr.includes('state-violation'), `stderr=${r.stderr}`)
  assert.ok(r.stderr.includes('decided_class'), `stderr=${r.stderr}`)
  assert.ok(r.stderr.includes('trivial'), `stderr=${r.stderr}`)
  // State must NOT have transitioned.
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'awaiting_approval')
})

// ---------------------------------------------------------------------------
// CA-12 — run-state vs parent-episode decided_class drift → canonical-drift
// ---------------------------------------------------------------------------
//
// PR-level audit F2 closure 2026-05-17. Stale-marker-after-reclassification
// shape: the signed awaiting_approval episode on disk has decided_class="X"
// but run-state has been edited to decided_class="trivial". confirm-approval
// must NOT silently bind the terminal transition to a parent whose canonical
// fields disagree with run-state. expectedFields predicate drives the
// field-mismatch result.
// ---------------------------------------------------------------------------

tap('CA-12 parent episode decided_class drift → recoverable-canonical-drift exit 5', () => {
  const ctx = setupAwaitingApproval()
  // The signed awaiting_approval episode was written with decided_class=trivial.
  // Drift run-state's decided_class while leaving the on-disk episode intact.
  // (Synthetic — real cause would be a separate writer / index corruption.)
  // We can't rewrite to a non-trivial class without tripping CA-11; instead
  // drift the awaiting_approval_at field which is also a predicate.
  const driftedAt = new Date(Date.parse(ctx.awaitingApprovalAt) + 60000).toISOString()
  const r0 = updateRunState(ctx.project, ctx.runId, { awaiting_approval_at: driftedAt })
  assert.equal(r0.ok, true)
  expireDeadline(ctx)
  const r = runConfirm(ctx)
  assert.equal(r.status, 5, `expected exit 5; stderr=${r.stderr}`)
  assert.ok(r.stderr.includes('recoverable-canonical-drift'),
    `expected recoverable-canonical-drift; stderr=${r.stderr}`)
  assert.ok(r.stderr.includes('awaiting_approval'), `stderr=${r.stderr}`)
})

// ---------------------------------------------------------------------------
// CA-13 — orphan auto_approved with mismatched parent_episode → canonical-drift
// ---------------------------------------------------------------------------
//
// PR-level audit F2 closure 2026-05-17. A crashed prior invocation emitted a
// signed auto_approved episode pointing at a DIFFERENT parent_episode
// (manual splice / cross-context attachment). The orphan-adopt path must
// reject with recoverable-canonical-drift, not silently adopt the foreign
// timestamps. expectedFields={parent_episode, deadline_at, decided_class}
// drives the field-mismatch result.
// ---------------------------------------------------------------------------

tap('CA-13 orphan auto_approved with foreign parent_episode → canonical-drift exit 5', () => {
  const ctx = setupAwaitingApproval()
  expireDeadline(ctx)
  // Synthesize a signed auto_approved orphan with a DIFFERENT parent_episode.
  // Imports are at top-level (line ~40) so this runs synchronously.
  const keyResult = loadRunKey(ctx.project, ctx.runId)
  if (keyResult.error) throw new Error(`loadRunKey: ${keyResult.error}`)
  const at = new Date(Date.now() - 1000).toISOString()
  writeBp1Episode({
    projectRoot: ctx.project, runId: ctx.runId, runKey32B: keyResult.key32B,
    type: 'state-transition', state: 'auto_approved',
    summary: `synthetic orphan with foreign parent: ${ctx.runId}`,
    parentEpisode: 'foreign-parent-episode-id-not-the-real-one',
    expectedPostEpisodeId: null,
    customFm: {
      auto_approved_at: at,
      deadline_at: ctx.deadlineAt,
      decided_class: 'trivial',
    },
    tags: ['bp1-auto-approved'],
    body: `# synthetic orphan\n`,
    filenameSuffix: 'auto-approved-synth',
  })
  const r = runConfirm(ctx)
  assert.equal(r.status, 5, `expected exit 5; stderr=${r.stderr}`)
  assert.ok(r.stderr.includes('recoverable-canonical-drift'),
    `expected recoverable-canonical-drift; stderr=${r.stderr}`)
  assert.ok(r.stderr.includes(`orphan auto_approved`), `stderr=${r.stderr}`)
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail > 0 ? 1 : 0)
