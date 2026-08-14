#!/usr/bin/env node
/**
 * test-em-review-request-body-read.mjs — issue #669 net-new suite.
 *
 * em-review-request.mjs:324 (checkChainRef) and :371 (--triggered-by
 * cross-task check) read a referenced episode's body with a raw
 * fs.readFileSync AFTER an fs.existsSync gate. Plan §1 R-D: these are
 * validation-gate sites — a planted FIFO must not dodge a cross-task/
 * provenance check by hanging or silently passing. Fix: readBodyOrSkip;
 * non-ENOENT unreadable is now a GATE FAILURE via the existing errors[]
 * channel (never a silent skip). ENOENT keeps each site's PRE-EXISTING
 * absent semantics: :324's existsSync branch already errored on absence
 * (so ENOENT there stays an error too); :371 had no `else` branch at all
 * (silent, provenance-only) — that stays silent.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const SCRIPTS = path.join(REPO, 'scripts')

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emrr-')))
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emrr-home-')))
  return { cwd, home, env: { ...process.env, HOME: home } }
}

function run(script, args, fx, timeout = 10000) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], { cwd: fx.cwd, encoding: 'utf8', timeout, env: fx.env })
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  return { code: r.status, signal: r.signal, json, stdout: r.stdout }
}

function cleanup(fx) {
  fs.rmSync(fx.cwd, { recursive: true, force: true })
  fs.rmSync(fx.home, { recursive: true, force: true })
}

function storeLifecycle(fx, { summary, body }) {
  const r = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'workflow.lifecycle', '--summary', summary, '--body', body], fx)
  assert.equal(r.json.status, 'ok', r.stdout)
  return r.json.id
}

// Minimal full chain (plan-approved → pre-checkpoint → post-checkpoint) so
// em-review-request's chain-ref resolution reaches the body-inspection step
// (event/task match) for each of --approval-ref/--pre-checkpoint-ref/
// --post-checkpoint-ref — that inspection is exactly where :324 reads.
function mkChain(fx, task = 'TEST') {
  const planId = storeLifecycle(fx, {
    summary: 'plan approved',
    body: '```json\n' + JSON.stringify({ event: 'plan-approved', task, pattern_id: 'bp-001-implementation-workflow', context: { worktree: fx.cwd, branch: 'main', head: 'abc1234' }, plan_ref: 'p.md' }) + '\n```',
  })
  const preId = storeLifecycle(fx, {
    summary: 'pre checkpoint',
    body: '```json\n' + JSON.stringify({ event: 'pre-checkpoint', task, pattern_id: 'bp-001-implementation-workflow', context: { worktree: fx.cwd, branch: 'main', head: 'abc1234' }, plan_ref: 'p.md', approval_ref: `episode:${planId}` }) + '\n```',
  })
  const postId = storeLifecycle(fx, {
    summary: 'post checkpoint',
    body: '```json\n' + JSON.stringify({
      event: 'post-checkpoint', task, pattern_id: 'bp-001-implementation-workflow', context: { worktree: fx.cwd, branch: 'main', head: 'abc1234' },
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: { tests: [], code_review: { status: 'done' }, e2e: { status: 'passed' }, bug_logging: { status: 'no-new-bugs' } },
    }) + '\n```',
  })
  return { planId, preId, postId }
}

function baseArgs(fx, chain, task = 'TEST') {
  return [
    '--task', task,
    '--plan-ref', 'p.md',
    '--approval-ref', `episode:${chain.planId}`,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', 'file:x',
    '--code-review-ref', `episode:${chain.postId}`,
    '--no-new-bugs',
    '--branch', 'main', '--head', 'abc1234', '--worktree', fx.cwd,
  ]
}

function epPath(fx, id) {
  return path.join(fx.cwd, '.episodic-memory', 'episodes', `${id}.md`)
}

function toFifo(fx, id) {
  const p = epPath(fx, id)
  fs.unlinkSync(p)
  const mk = spawnSync('mkfifo', [p])
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`)
}

t('healthy control: full valid chain writes the review-request episode (exit 0)', () => {
  const fx = mkFixture()
  const chain = mkChain(fx)
  const r = run('em-review-request.mjs', baseArgs(fx, chain), fx)
  assert.equal(r.code, 0, r.stdout)
  assert.equal(r.json.status, 'ok', r.stdout)
  cleanup(fx)
})

t(':324 checkChainRef — --approval-ref FIFO-shaped body: gate failure (exit 1), errors[] names unreadable, no hang', () => {
  const fx = mkFixture()
  const chain = mkChain(fx)
  toFifo(fx, chain.planId)
  const r = run('em-review-request.mjs', baseArgs(fx, chain), fx, 5000)
  assert.equal(r.signal, null, `no signal (hang), got ${r.signal}`)
  assert.equal(r.code, 1, `exit 1 (gate failure, not usage error), got ${r.code}: ${r.stdout}`)
  assert.equal(r.json.status, 'error', r.stdout)
  assert.ok(Array.isArray(r.json.errors) && r.json.errors.some(e => /unreadable/.test(e)),
    `errors[] must name the unreadable body, got ${JSON.stringify(r.json.errors)}`)
  fs.unlinkSync(epPath(fx, chain.planId))
  cleanup(fx)
})

t(':324 checkChainRef — --pre-checkpoint-ref FIFO-shaped body: gate failure, no hang', () => {
  const fx = mkFixture()
  const chain = mkChain(fx)
  toFifo(fx, chain.preId)
  const r = run('em-review-request.mjs', baseArgs(fx, chain), fx, 5000)
  assert.equal(r.signal, null, `no signal (hang), got ${r.signal}`)
  assert.equal(r.code, 1, r.stdout)
  assert.ok(r.json.errors.some(e => /unreadable/.test(e)), JSON.stringify(r.json.errors))
  fs.unlinkSync(epPath(fx, chain.preId))
  cleanup(fx)
})

t(':371 --triggered-by FIFO-shaped body: gate failure via errors[] (cross-task provenance check must not be dodged)', () => {
  const fx = mkFixture()
  const chain = mkChain(fx)
  const trig = storeLifecycle(fx, { summary: 'trigger source', body: '```json\n' + JSON.stringify({ event: 'plan-approved', task: 'OTHER-TASK', pattern_id: 'bp-001-implementation-workflow' }) + '\n```' })
  toFifo(fx, trig)
  const r = run('em-review-request.mjs', [...baseArgs(fx, chain), '--triggered-by', `episode:${trig}`], fx, 5000)
  assert.equal(r.signal, null, `no signal (hang), got ${r.signal}`)
  assert.equal(r.code, 1, `exit 1, got ${r.code}: ${r.stdout}`)
  assert.ok(r.json.errors.some(e => /--triggered-by/.test(e) && /unreadable/.test(e)),
    `errors[] must name the unreadable triggered-by body, got ${JSON.stringify(r.json.errors)}`)
  fs.unlinkSync(epPath(fx, trig))
  cleanup(fx)
})

t(':371 F5 control — --triggered-by pointing at a vanished (ENOENT) body: stays silent (provenance-only), no error, no hang', () => {
  const fx = mkFixture()
  const chain = mkChain(fx)
  const trig = storeLifecycle(fx, { summary: 'trigger source vanished', body: '```json\n' + JSON.stringify({ event: 'plan-approved', task: 'OTHER-TASK', pattern_id: 'bp-001-implementation-workflow' }) + '\n```' })
  fs.unlinkSync(epPath(fx, trig)) // absent, not a FIFO — F5 stays silent at this site
  const r = run('em-review-request.mjs', [...baseArgs(fx, chain), '--triggered-by', `episode:${trig}`], fx, 5000)
  assert.equal(r.signal, null, `no signal (hang), got ${r.signal}`)
  assert.equal(r.code, 0, `absent triggered-by body must stay provenance-only (no gate failure), got ${r.code}: ${r.stdout}`)
  assert.equal(r.json.status, 'ok', r.stdout)
  cleanup(fx)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
