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
const { markerPath } = markerMod
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

/** Backdate deadline_at to make the run eligible for auto_approved. */
function expireDeadline(ctx, msAgo = 1) {
  const expired = new Date(Date.now() - msAgo).toISOString()
  const r = updateRunState(ctx.project, ctx.runId, { deadline_at: expired })
  if (r.error) throw new Error(`updateRunState failed: ${r.error}`)
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

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail > 0 ? 1 : 0)
