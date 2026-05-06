#!/usr/bin/env node
/**
 * test-workflow-validate.mjs — Tests for em-workflow-validate.mjs
 *
 * RFC-002 Phase 3b-H1 PR-C. Validates the workflow.lifecycle episode chain
 * validator. Uses an isolated $HOME so episodes don't leak into the real
 * memory store.
 *
 * Usage: node tests/test-workflow-validate.mjs
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const VALIDATE = path.join(SCRIPTS, 'em-workflow-validate.mjs')

// Isolated HOME for the test session
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-validate-test-'))
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'em-validate-cwd-'))
const dataDir = path.join(tmpHome, '.episodic-memory')           // global ($HOME)
const episodesDir = path.join(dataDir, 'episodes')
const indexFile = path.join(dataDir, 'index.jsonl')
// Local store under tmpCwd for tests that need to verify the scope/resolver
// split — a local lifecycle chain citing a global witness must resolve
// regardless of --scope.
const localDataDir = path.join(tmpCwd, '.episodic-memory')
const localEpisodesDir = path.join(localDataDir, 'episodes')
const localIndexFile = path.join(localDataDir, 'index.jsonl')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    // Reset between tests
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(localDataDir, { recursive: true, force: true })
    fs.mkdirSync(episodesDir, { recursive: true })
    fs.writeFileSync(indexFile, '')
    fs.mkdirSync(localEpisodesDir, { recursive: true })
    fs.writeFileSync(localIndexFile, '')
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures.push({ name, error: e.message, stack: e.stack })
    failed++
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers — write episode .md + index entry directly. Avoids the
// em-store dependency so tests are independent and faster.
// ---------------------------------------------------------------------------
let counter = 0
function mkEpisode({ event, task = 'TEST', patternId = 'bp-001-implementation-workflow', branch = 'main', head = 'abc1234', extra = {} }) {
  counter++
  const id = `20260502-1200${String(counter).padStart(2, '0')}-${event}-${counter.toString(16).padStart(4, '0')}`
  const payload = {
    event,
    pattern_id: patternId,
    task,
    context: { worktree: tmpCwd, branch, head },
    ...extra
  }
  const body = `# ${event}\n\nTest fixture.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
  const fm = [
    '---',
    `id: ${id}`,
    'date: 2026-05-02',
    'time: "12:00"',
    'project: test',
    'category: workflow.lifecycle',
    'status: active',
    'tags: []',
    `summary: ${event}`,
    '---',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(episodesDir, `${id}.md`), fm + '\n' + body)
  fs.appendFileSync(indexFile, JSON.stringify({
    id, date: '2026-05-02', time: '12:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: event
  }) + '\n')
  return id
}

// Seed a non-lifecycle witness episode (e.g. test log, code review reply).
// Used for evidence refs (log_ref, reply_ref) that must resolve against the
// index per #98 finding 2. Date/time are 11:00 so they precede the 12:00
// lifecycle fixtures (resolver requires ref timestamp <= citing timestamp).
function mkWitness({ category = 'discovery', summary = 'witness', status = 'active', date = '2026-05-02', time = '11:00' } = {}) {
  counter++
  const id = `20260502-1100${String(counter).padStart(2, '0')}-witness-${counter.toString(16).padStart(4, '0')}`
  const fm = [
    '---',
    `id: ${id}`,
    `date: ${date}`,
    `time: "${time}"`,
    'project: test',
    `category: ${category}`,
    `status: ${status}`,
    'tags: []',
    `summary: ${summary}`,
    '---',
    ''
  ].join('\n')
  const body = `# witness\n\nplain witness episode for evidence refs.\n`
  fs.writeFileSync(path.join(episodesDir, `${id}.md`), fm + '\n' + body)
  fs.appendFileSync(indexFile, JSON.stringify({
    id, date, time, project: 'test', category, status,
    supersedes: null, tags: [], summary
  }) + '\n')
  return id
}

function runValidate(args) {
  try {
    const out = execFileSync('node', [VALIDATE, ...args], {
      env: { ...process.env, HOME: tmpHome },
      cwd: tmpCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { exit: 0, json: JSON.parse(out) }
  } catch (e) {
    if (e.stdout) {
      try { return { exit: e.status, json: JSON.parse(e.stdout) } } catch {}
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('em-workflow-validate.mjs tests')
console.log('================================')

test('T1 happy: pre-checkpoint gate passes with plan-approved + pre-checkpoint', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'docs/plan.md', classification: 'full' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'docs/plan.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.exit, 0, `expected exit 0, got ${r.exit}: ${JSON.stringify(r.json)}`)
  assert.strictEqual(r.json.valid, true)
  assert.strictEqual(r.json.missing.length, 0)
  assert.strictEqual(r.json.errors.length, 0)
})

test('T2 missing: pre-checkpoint gate fails when no episodes exist', () => {
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.exit, 1)
  assert.strictEqual(r.json.valid, false)
  assert.deepStrictEqual(r.json.missing, ['plan-approved', 'pre-checkpoint'])
})

test('T3 partial: pre-checkpoint missing plan-approved fails', () => {
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'docs/plan.md', approval_ref: 'episode:nonexistent-id' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.missing.includes('plan-approved'))
  // Also: the orphaned approval_ref should produce an error
  assert.ok(r.json.errors.some(e => e.includes('approval_ref episode:nonexistent-id not found')))
})

test('T4 placeholder: empty plan_ref is rejected', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: '' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'docs/plan.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('plan-approved.plan_ref')))
})

test('T5 placeholder: TBD literal is rejected', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'TBD' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'docs/plan.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('plan_ref')))
})

test('T6 placeholder: bare "episode:" prefix in pre-checkpoint approval_ref rejected', () => {
  mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'docs/plan.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'docs/plan.md', approval_ref: 'episode:' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref')))
})

test('T6b placeholder: episode:self in pre-checkpoint approval_ref rejected (self-witness)', () => {
  mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'docs/plan.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'docs/plan.md', approval_ref: 'episode:self' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref')))
})

test('T7 task isolation: different task is filtered out', () => {
  const planA = mkEpisode({ event: 'plan-approved', task: 'TASK-A', extra: { plan_ref: 'a.md' } })
  mkEpisode({ event: 'pre-checkpoint', task: 'TASK-A', extra: { plan_ref: 'a.md', approval_ref: `episode:${planA}` } })
  // Validator queried for TASK-B should see no matching events
  const r = runValidate(['--task', 'TASK-B', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.deepStrictEqual(r.json.missing, ['plan-approved', 'pre-checkpoint'])
})

test('T8 happy: post-checkpoint gate with full evidence (real witness episodes)', () => {
  const logId = mkWitness({ summary: 'test log' })
  const reviewId = mkWitness({ summary: 'code review' })
  const e2eId = mkWitness({ summary: 'e2e log' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'node tests/test-x.mjs', status: 'passed', log_ref: `episode:${logId}` }],
        code_review: { status: 'done', reply_ref: `episode:${reviewId}` },
        e2e: { status: 'passed', log_ref: `episode:${e2eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)} missing: ${JSON.stringify(r.json.missing)}`)
})

test('T9 evidence: empty tests array is rejected', () => {
  const r2 = mkWitness({ summary: 'review' })
  const e2 = mkWitness({ summary: 'e2e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [],
        code_review: { status: 'done', reply_ref: `episode:${r2}` },
        e2e: { status: 'passed', log_ref: `episode:${e2}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('evidence.tests must be a non-empty array')))
})

test('T10 evidence: code_review.status=done without reply_ref is rejected', () => {
  const lId = mkWitness({ summary: 'log' })
  const eId = mkWitness({ summary: 'e2e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: '' },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('code_review.reply_ref')))
})

test('T11 push-allowed: requires post_checkpoint_ref pointing to actual episode', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'review' })
  const eId = mkWitness({ summary: 'e2e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const postId = mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T12 push-allowed: orphaned post_checkpoint_ref is rejected', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'review' })
  const eId = mkWitness({ summary: 'e2e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: 'episode:bogus-id-12345' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('post_checkpoint_ref')))
})

test('T13 schema: missing context.head rejected', () => {
  const id = `20260502-malformed-${Date.now()}`
  const payload = {
    event: 'plan-approved',
    pattern_id: 'bp-001-implementation-workflow',
    task: 'TEST',
    context: { worktree: tmpCwd, branch: 'main' }, // no head
    plan_ref: 'p.md'
  }
  const fm = `---\nid: ${id}\ndate: 2026-05-02\ntime: "12:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: malformed\n---\n`
  const body = `# x\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`
  fs.writeFileSync(path.join(episodesDir, `${id}.md`), fm + '\n' + body)
  fs.appendFileSync(indexFile, JSON.stringify({ id, date: '2026-05-02', time: '12:00', project: 'test', category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'x' }) + '\n')
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('context.head')))
})

test('T14 missing fenced block produces parse error', () => {
  const id = `20260502-noblock-${Date.now()}`
  const fm = `---\nid: ${id}\ndate: 2026-05-02\ntime: "12:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: x\n---\n`
  const body = `# no json block here\n\nplain text only.\n`
  fs.writeFileSync(path.join(episodesDir, `${id}.md`), fm + '\n' + body)
  fs.appendFileSync(indexFile, JSON.stringify({ id, date: '2026-05-02', time: '12:00', project: 'test', category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'x' }) + '\n')
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('No `\`\`\`json` fenced block') || e.includes('json fenced block')))
})

test('T15 superseded episodes are skipped', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  // Mark plan-approved as superseded by editing the index
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').map(l => {
    const e = JSON.parse(l)
    if (e.id === planId) e.status = 'superseded'
    return JSON.stringify(e)
  })
  fs.writeFileSync(indexFile, lines.join('\n') + '\n')
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.missing.includes('plan-approved'))
})

test('T16 invalid gate rejected with exit 2', () => {
  const r = runValidate(['--task', 'TEST', '--gate', 'bogus'])
  assert.strictEqual(r.exit, 2, `expected exit 2, got ${r.exit}`)
  assert.strictEqual(r.json.status, 'error')
})

test('T17 branch mismatch with --branch flag is an error', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', branch: 'old-branch', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--branch', 'main'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('context.branch')))
})

test('T18 worktree mismatch is an error (RFC-002:327)', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  // Pass a different worktree than tmpCwd (which is what fixtures use)
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--worktree', '/some/other/path'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('context.worktree')))
})

test('T19 head mismatch with --head flag is an error', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', head: 'oldsha1', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'newsha2'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('context.head')))
})

// ---------------------------------------------------------------------------
// #98 finding 2 — episode reference resolution & forge-resistance.
// ---------------------------------------------------------------------------

test('T20 evidence ref must resolve: bogus log_ref id is rejected', () => {
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: 'episode:does-not-exist-9999' }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('evidence.tests[0].log_ref') && e.includes('not found')),
    `expected log_ref not-found error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T21 evidence ref to superseded episode is rejected', () => {
  const supersededId = mkWitness({ summary: 'old log', status: 'superseded' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${supersededId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('superseded')),
    `expected superseded error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T22 evidence ref to future-dated episode is rejected (chain temporal order)', () => {
  // citing episode is at 12:00; a witness at 13:00 is "after" the chain.
  const futureId = mkWitness({ summary: 'future log', time: '13:00' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${futureId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('temporally ordered') || e.includes('after citing')),
    `expected timestamp ordering error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T23 chain-link ref to non-lifecycle category is rejected', () => {
  // approval_ref pointing to a discovery episode (not workflow.lifecycle)
  // should fail the expectedCategory check.
  const fakePlanId = mkWitness({ summary: 'fake plan', category: 'discovery' })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${fakePlanId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref') && (e.includes('category') || e.includes('not a plan-approved'))),
    `expected category mismatch, got: ${JSON.stringify(r.json.errors)}`)
})

test('T24 bug_logging.issues[]: free-form string rejected', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: ['fix this thing later'] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('bug_logging.issues[0]')),
    `expected issue shape error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T25 bug_logging.issues[]: gh:owner/repo#n short form accepted', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: ['gh:lantisprime/episodic-memory#42'] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T26 bug_logging.issues[]: GitHub URL accepted', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: ['https://github.com/lantisprime/episodic-memory/issues/98'] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

// ---------------------------------------------------------------------------
// #98 finding 1 — per-gate head/branch rules + chain selection via refs.
// ---------------------------------------------------------------------------

test('T28 per-gate head: non-terminal link with old head passes when git unavailable (no ancestor check)', () => {
  // pre-checkpoint at old head, validating post-checkpoint gate at new head.
  // pre-checkpoint is non-terminal here, so its old head is acceptable.
  // git is unavailable in the test env (tmpCwd is not a repo) so the
  // ancestor check is skipped silently.
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', head: 'oldsha111', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', head: 'oldsha111', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    head: 'newsha222',
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint', '--head', 'newsha222'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T29 per-gate head: terminal link with mismatched head fails', () => {
  // pre-checkpoint at oldsha; --head is newsha; pre-checkpoint IS terminal
  // for pre-checkpoint gate, so it must equal --head.
  const planId = mkEpisode({ event: 'plan-approved', head: 'oldsha111', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', head: 'oldsha111', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'newsha222'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('terminal pre-checkpoint must be at current HEAD')),
    `expected terminal head error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T30 branch switch between plan-approved and post-checkpoint fails', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', branch: 'feature-a', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', branch: 'feature-a', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    branch: 'feature-b', // switched mid-chain
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint', '--branch', 'feature-b'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('chain links must share branch')),
    `expected branch-switch error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T31 push-allowed: post-checkpoint at older head than --head fails (extra commits)', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', head: 'sha1', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', head: 'sha1', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const postId = mkEpisode({
    event: 'post-checkpoint',
    head: 'sha2', // evidence recorded at sha2
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  // push-allowed at sha3 — but post-checkpoint was at sha2. Extra commits
  // landed since evidence; must re-run post-checkpoint.
  mkEpisode({ event: 'push-allowed', head: 'sha3', extra: { post_checkpoint_ref: `episode:${postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'sha3'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('Code may have changed since evidence')),
    `expected post-checkpoint head exact-equal error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T32 pre_checkpoint_ref missing in post-checkpoint is rejected', () => {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      // pre_checkpoint_ref intentionally omitted
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('pre_checkpoint_ref missing')),
    `expected pre_checkpoint_ref missing error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T33 pre_checkpoint_ref splicing: refs different chain pre-checkpoint fails', () => {
  // Two parallel chains for same task — task-A pre-checkpoint and task-B
  // pre-checkpoint (different tasks). post-checkpoint for TASK-A but
  // pre_checkpoint_ref points to TASK-B's pre-checkpoint. Validator queries
  // for TASK-A: TASK-B episodes are filtered out, so the pre_checkpoint_ref
  // resolves to a workflow.lifecycle episode (passes category check) but
  // is not in the loaded events[] for TASK-A — the chain-link check rejects.
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planA = mkEpisode({ event: 'plan-approved', task: 'TASK-A', extra: { plan_ref: 'a.md' } })
  mkEpisode({ event: 'pre-checkpoint', task: 'TASK-A', extra: { plan_ref: 'a.md', approval_ref: `episode:${planA}` } })
  // TASK-B's pre-checkpoint — splice target
  const planB = mkEpisode({ event: 'plan-approved', task: 'TASK-B', extra: { plan_ref: 'b.md' } })
  const preB = mkEpisode({ event: 'pre-checkpoint', task: 'TASK-B', extra: { plan_ref: 'b.md', approval_ref: `episode:${planB}` } })
  mkEpisode({
    event: 'post-checkpoint',
    task: 'TASK-A',
    extra: {
      pre_checkpoint_ref: `episode:${preB}`, // splice from TASK-B
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TASK-A', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('chain splicing rejected') || e.includes('pre_checkpoint_ref')),
    `expected splicing rejection, got: ${JSON.stringify(r.json.errors)}`)
})

test('T36 cross-scope resolution: local chain citing global witness resolves under --scope local', () => {
  // Codex re-review P2: indexById was built from --scope-filtered entries,
  // so a local chain citing a global witness failed with "not found (checked
  // local + global)" — contradicting docs/comments. Fix: build resolver index
  // from BOTH scopes regardless of --scope.
  // Witness lives in global ($HOME .episodic-memory).
  counter++
  const witnessId = `20260502-1100${String(counter).padStart(2, '0')}-global-witness-${counter.toString(16).padStart(4, '0')}`
  const witnessFm = `---\nid: ${witnessId}\ndate: 2026-05-02\ntime: "11:00"\nproject: test\ncategory: discovery\nstatus: active\ntags: []\nsummary: global witness\n---\n`
  fs.writeFileSync(path.join(episodesDir, `${witnessId}.md`), witnessFm + '\n# global witness\n')
  fs.appendFileSync(indexFile, JSON.stringify({
    id: witnessId, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'discovery', status: 'active', supersedes: null, tags: [], summary: 'global witness'
  }) + '\n')
  // Lifecycle chain lives in local (tmpCwd .episodic-memory).
  const writeLocalLifecycle = (event, extra) => {
    counter++
    const id = `20260502-1200${String(counter).padStart(2, '0')}-${event}-${counter.toString(16).padStart(4, '0')}`
    const payload = {
      event, pattern_id: 'bp-001-implementation-workflow', task: 'TEST',
      context: { worktree: tmpCwd, branch: 'main', head: 'abc1234' },
      ...extra
    }
    const fm = `---\nid: ${id}\ndate: 2026-05-02\ntime: "12:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: ${event}\n---\n`
    const body = `# ${event}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
    fs.writeFileSync(path.join(localEpisodesDir, `${id}.md`), fm + '\n' + body)
    fs.appendFileSync(localIndexFile, JSON.stringify({
      id, date: '2026-05-02', time: '12:00', project: 'test',
      category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: event
    }) + '\n')
    return id
  }
  const planId = writeLocalLifecycle('plan-approved', { plan_ref: 'p.md' })
  const preId = writeLocalLifecycle('pre-checkpoint', { plan_ref: 'p.md', approval_ref: `episode:${planId}` })
  writeLocalLifecycle('post-checkpoint', {
    pre_checkpoint_ref: `episode:${preId}`,
    evidence: {
      tests: [{ command: 'x', status: 'passed', log_ref: `episode:${witnessId}` }],
      code_review: { status: 'done', reply_ref: `episode:${witnessId}` },
      e2e: { status: 'passed', log_ref: `episode:${witnessId}` },
      bug_logging: { status: 'done', issues: [] }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint', '--scope', 'local'])
  assert.strictEqual(r.json.valid, true,
    `expected valid with cross-scope resolution; errors: ${JSON.stringify(r.json.errors)}`)
})

test('T34 push-allowed gate without --head is rejected as usage error', () => {
  // BLOCKER 2: post-checkpoint head check is silently skipped without --head.
  // Validator now refuses push-allowed gate when --head is absent.
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed'])
  assert.strictEqual(r.exit, 2, `expected exit 2, got ${r.exit}`)
  assert.strictEqual(r.json.status, 'error')
  assert.ok(r.json.message.includes('--head is required'),
    `expected --head required error, got: ${r.json.message}`)
})

test('T35 branch switch on plan-approved (vs pre-checkpoint) is also caught', () => {
  // MAJOR 4: confirm branch enforcement covers plan-approved, not just
  // post-checkpoint. plan-approved at feature-a, pre-checkpoint at feature-b.
  const planId = mkEpisode({ event: 'plan-approved', branch: 'feature-a', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', branch: 'feature-b', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--branch', 'feature-b'])
  assert.strictEqual(r.json.valid, false)
  // plan-approved is on feature-a, --branch is feature-b → mismatch
  assert.ok(r.json.errors.some(e => e.includes('chain links must share branch')),
    `expected branch-switch error on plan-approved, got: ${JSON.stringify(r.json.errors)}`)
})

test('T27 self-witness: real id pointing to citing episode is rejected', () => {
  // Build a post-checkpoint whose log_ref points to itself. To do this we
  // need to know the next id mkEpisode will assign. Counter is shared, so we
  // peek ahead by computing it.
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'r' })
  const eId = mkWitness({ summary: 'e' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  // Predict the next id format used by mkEpisode (counter+1 suffix and event=post-checkpoint)
  // Easier: pass log_ref to a known prior id (lId is fine for non-self) — we test
  // self-witness by having post-checkpoint cite its OWN id. Since mkEpisode uses
  // a deterministic counter, we just resolve via filesystem after creation.
  // Workaround: write the post-checkpoint via direct fixture so we control the id.
  const selfId = `20260502-120099-self-witness-test-9999`
  const payload = {
    event: 'post-checkpoint',
    pattern_id: 'bp-001-implementation-workflow',
    task: 'TEST',
    context: { worktree: tmpCwd, branch: 'main', head: 'abc1234' },
    evidence: {
      tests: [{ command: 'x', status: 'passed', log_ref: `episode:${selfId}` }],
      code_review: { status: 'done', reply_ref: `episode:${rId}` },
      e2e: { status: 'passed', log_ref: `episode:${eId}` },
      bug_logging: { status: 'done', issues: [] }
    }
  }
  const fm = `---\nid: ${selfId}\ndate: 2026-05-02\ntime: "12:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: post-checkpoint\n---\n`
  const body = `# x\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`
  fs.writeFileSync(path.join(episodesDir, `${selfId}.md`), fm + '\n' + body)
  fs.appendFileSync(indexFile, JSON.stringify({
    id: selfId, date: '2026-05-02', time: '12:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'self'
  }) + '\n')
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('self-witness')),
    `expected self-witness error, got: ${JSON.stringify(r.json.errors)}`)
})

// ===========================================================================
// review-request gate tests (#118 PR-D)
// ===========================================================================

const REVIEW_REQUEST_SCRIPT = path.join(SCRIPTS, 'em-review-request.mjs')

// Build a full chain (plan-approved + pre-checkpoint + post-checkpoint) so the
// review-request gate can run against a complete predecessor chain. Returns
// { planId, preId, postId } for callers to wire into the review-request body.
function mkBaseChainForReview({ task = 'TEST', branch = 'main', head = 'abc1234' } = {}) {
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'review' })
  const eId = mkWitness({ summary: 'e2e' })
  const planId = mkEpisode({ event: 'plan-approved', task, branch, head, extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', task, branch, head, extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const postId = mkEpisode({
    event: 'post-checkpoint', task, branch, head,
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  return { planId, preId, postId, logId: lId, reviewId: rId, e2eId: eId }
}

// Build a review-request fixture pointing at a base chain. `extra` lets tests
// override any payload field for negative scenarios.
function mkReviewRequest({ chain, task = 'TEST', branch = 'main', head = 'abc1234', extra = {} } = {}) {
  const baseEvidence = {
    tests_ref: `episode:${chain.logId}`,
    code_review_ref: `episode:${chain.reviewId}`,
    bug_logging: { status: 'no-new-bugs' },
  }
  const basePayload = {
    plan_ref: 'p.md',
    approval_ref: `episode:${chain.planId}`,
    pre_checkpoint_ref: `episode:${chain.preId}`,
    post_checkpoint_ref: `episode:${chain.postId}`,
    evidence: baseEvidence,
  }
  // Merge with extras: shallow merge for top-level, deep for evidence.
  const evidence = { ...baseEvidence, ...(extra.evidence || {}) }
  if (extra.evidence && extra.evidence.bug_logging != null) {
    evidence.bug_logging = extra.evidence.bug_logging
  }
  const merged = { ...basePayload, ...extra, evidence }
  return mkEpisode({ event: 'review-request', task, branch, head, extra: merged })
}

function runReviewWrapper(args, opts = {}) {
  try {
    const out = execFileSync('node', [REVIEW_REQUEST_SCRIPT, ...args], {
      env: { ...process.env, HOME: tmpHome, ...(opts.env || {}) },
      cwd: opts.cwd || tmpCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { exit: 0, json: JSON.parse(out) }
  } catch (e) {
    if (e.stdout) {
      try { return { exit: e.status, json: JSON.parse(e.stdout) } } catch {}
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Validator: review-request schema + chain rules
// ---------------------------------------------------------------------------

test('T37 happy: review-request gate passes with full chain + valid review-request', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.exit, 0, `expected exit 0, got ${r.exit}: ${JSON.stringify(r.json)}`)
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T38 review-request without --head is usage error (exit 2)', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request'])
  assert.strictEqual(r.exit, 2)
  assert.ok(r.json.message.includes('--head is required'))
})

test('T39 review-request: missing plan_ref is rejected', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { plan_ref: '' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('review-request.plan_ref')))
})

test('T40 review-request: missing post_checkpoint_ref is rejected', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { post_checkpoint_ref: '' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('review-request.post_checkpoint_ref missing')))
})

test('T41 review-request: post_checkpoint_ref to non-lifecycle category is rejected', () => {
  const chain = mkBaseChainForReview()
  const witnessId = mkWitness({ category: 'discovery', summary: 'not lifecycle' })
  mkReviewRequest({ chain, extra: { post_checkpoint_ref: `episode:${witnessId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('post_checkpoint_ref') && e.includes('category')),
    `expected category-mismatch error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T42 review-request: post_checkpoint_ref splice (different task) rejected', () => {
  // Two parallel chains. review-request for TASK-A but post_checkpoint_ref
  // points to TASK-B's post-checkpoint.
  const chainA = mkBaseChainForReview({ task: 'TASK-A' })
  const chainB = mkBaseChainForReview({ task: 'TASK-B' })
  mkReviewRequest({ chain: { ...chainA, postId: chainB.postId }, task: 'TASK-A' })
  const r = runValidate(['--task', 'TASK-A', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('post_checkpoint_ref') && (e.includes('chain link') || e.includes('post-checkpoint episode for this task'))),
    `expected splicing rejection, got: ${JSON.stringify(r.json.errors)}`)
})

test('T43 review-request: post_checkpoint head mismatch with --head is rejected', () => {
  // post-checkpoint at head sha1; review-request claims --head sha2.
  const lId = mkWitness({ summary: 'log' })
  const rId = mkWitness({ summary: 'review' })
  const eId = mkWitness({ summary: 'e2e' })
  const planId = mkEpisode({ event: 'plan-approved', head: 'sha1', extra: { plan_ref: 'p.md' } })
  const preId = mkEpisode({ event: 'pre-checkpoint', head: 'sha1', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const postId = mkEpisode({
    event: 'post-checkpoint', head: 'sha1',
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  mkReviewRequest({
    chain: { planId, preId, postId, logId: lId, reviewId: rId, e2eId: eId },
    head: 'sha2'
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'sha2'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('Code may have changed since evidence')),
    `expected head-mismatch error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T44 review-request: branch mismatch across chain rejected', () => {
  const chain = mkBaseChainForReview({ branch: 'feature-a' })
  mkReviewRequest({ chain, branch: 'feature-b' })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234', '--branch', 'feature-b'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('chain links must share branch')))
})

test('T45 review-request: bug_logging.status="done" with empty issues[] accepted (mirrors post-checkpoint per review M2)', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { bug_logging: { status: 'done', issues: [] } } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T46 review-request: bug_logging.status="done" with malformed issue URL rejected', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { bug_logging: { status: 'done', issues: ['not-a-url'] } } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('bug_logging.issues[0]')))
})

test('T47 review-request: bug_logging.status="no-new-bugs" accepted', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { bug_logging: { status: 'no-new-bugs' } } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T48 review-request: verifications=null accepted', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { verifications: null } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T49 review-request: verifications=[] accepted', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { verifications: [] } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true)
})

test('T50 review-request: verifications kind=evidence missing both excerpt+output rejected', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { verifications: [{ kind: 'evidence', claim: 'X' }] } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('verifications[0]') && e.includes("'excerpt' or 'output'")),
    `expected excerpt/output error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T51 review-request: verifications kind=evidence with output OK', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { verifications: [{ kind: 'evidence', claim: 'X', output: 'cmd output line' }] } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true)
})

test('T52 review-request: verifications kind=narrative without excerpt OK', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { verifications: [{ kind: 'narrative', claim: 'unfalsifiable' }] } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true)
})

test('T53 review-request: unknown kind "evidance" rejected with schema v1 in error', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { verifications: [{ kind: 'evidance', claim: 'X', excerpt: 'foo' }] } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes("kind 'evidance'") && e.includes('schema v1')),
    `expected schema-v1 versioned error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T54 review-request: triggered_by resolves OK with null target task (provenance-only)', () => {
  const chain = mkBaseChainForReview()
  // Witness has no task field in body → null task → provenance-only.
  const triggerId = mkWitness({ category: 'lesson', summary: 'codex feedback' })
  mkReviewRequest({ chain, extra: { triggered_by: `episode:${triggerId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T55 review-request: triggered_by to nonexistent episode rejected', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { triggered_by: 'episode:bogus-trigger-id' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('triggered_by') && e.includes('not found')))
})

test('T56 review-request: triggered_by cross-task pollution rejected', () => {
  const chain = mkBaseChainForReview({ task: 'TASK-A' })
  // Another lifecycle episode with task=TASK-B.
  const otherPlan = mkEpisode({ event: 'plan-approved', task: 'TASK-B', extra: { plan_ref: 'b.md' } })
  mkReviewRequest({ chain, task: 'TASK-A', extra: { triggered_by: `episode:${otherPlan}` } })
  const r = runValidate(['--task', 'TASK-A', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('triggered_by') && e.includes('cross-task')),
    `expected cross-task error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T57 review-request: triggered_by to episode with task=undefined treated as provenance-only', () => {
  // Build a workflow.lifecycle episode whose body has a JSON block but with
  // no task field set. Validator's task-binding skips → provenance-only.
  const chain = mkBaseChainForReview()
  counter++
  const trigId = `20260502-1100${String(counter).padStart(2, '0')}-trigger-undef-${counter.toString(16).padStart(4, '0')}`
  const trigPayload = {
    event: 'classified',
    pattern_id: 'bp-001-implementation-workflow',
    // task: explicitly undefined → omitted from JSON
    context: { worktree: tmpCwd, branch: 'main', head: 'abc1234' }
  }
  const trigFm = `---\nid: ${trigId}\ndate: 2026-05-02\ntime: "11:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: trig undef\n---\n`
  const trigBody = `# x\n\n\`\`\`json\n${JSON.stringify(trigPayload)}\n\`\`\`\n`
  fs.writeFileSync(path.join(episodesDir, `${trigId}.md`), trigFm + '\n' + trigBody)
  fs.appendFileSync(indexFile, JSON.stringify({
    id: trigId, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'trig'
  }) + '\n')
  mkReviewRequest({ chain, extra: { triggered_by: `episode:${trigId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `provenance-only should pass; errors: ${JSON.stringify(r.json.errors)}`)
})

test('T58 multi-review-request: latest-by-timestamp wins, older becomes warning', () => {
  const chain = mkBaseChainForReview()
  // Two review-request episodes; the second has a stale post_checkpoint_ref
  // that would error, but it's older — so it should be downgraded to warning.
  // mkEpisode counter assigns ids sequentially: ids that come later have
  // larger counters but same date/time. We need explicit time differences.
  // mkEpisode uses fixed date/time '12:00'. Use direct fixture for the older one.
  counter++
  const olderId = `20260502-1100${String(counter).padStart(2, '0')}-rr-older-${counter.toString(16).padStart(4, '0')}`
  const olderPayload = {
    event: 'review-request',
    pattern_id: 'bp-001-implementation-workflow',
    task: 'TEST',
    context: { worktree: tmpCwd, branch: 'main', head: 'abc1234' },
    plan_ref: 'p.md',
    approval_ref: `episode:${chain.planId}`,
    pre_checkpoint_ref: `episode:${chain.preId}`,
    post_checkpoint_ref: 'episode:bogus-stale-ref',
    evidence: {
      tests_ref: `episode:${chain.logId}`,
      code_review_ref: `episode:${chain.reviewId}`,
      bug_logging: { status: 'no-new-bugs' }
    }
  }
  const olderFm = `---\nid: ${olderId}\ndate: 2026-05-02\ntime: "11:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: rr older\n---\n`
  const olderBody = `# x\n\n\`\`\`json\n${JSON.stringify(olderPayload)}\n\`\`\`\n`
  fs.writeFileSync(path.join(episodesDir, `${olderId}.md`), olderFm + '\n' + olderBody)
  fs.appendFileSync(indexFile, JSON.stringify({
    id: olderId, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'older'
  }) + '\n')
  // Newer review-request with valid refs (uses default 12:00 timestamp via mkEpisode).
  mkReviewRequest({ chain })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `terminal review-request is valid; errors: ${JSON.stringify(r.json.errors)}`)
  // Post-#102: terminal-anchored chain selection. Older review-request is
  // out-of-chain; supersedes warning + its errors are migrated.
  assert.ok(r.json.warnings.some(w => w.includes(olderId) && w.includes('superseded by terminal review-request')),
    `expected supersedes warning, got: ${JSON.stringify(r.json.warnings)}`)
  assert.ok(r.json.warnings.some(w => w.includes('(out-of-chain)') && w.includes(olderId)),
    `expected out-of-chain migrated warning, got: ${JSON.stringify(r.json.warnings)}`)
})

test('T59 push-allowed regression: still works WITHOUT review-request in chain', () => {
  // Plan-agent Q3 REJECT: do NOT add review-request to push-allowed required.
  // T11 already covers this; this test is the explicit regression-guard.
  const chain = mkBaseChainForReview()
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${chain.postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `push-allowed without review-request must still pass; errors: ${JSON.stringify(r.json.errors)}`)
})

// ---------------------------------------------------------------------------
// Folded mod 2a: superseded-collision in scope merge (drift surface)
// ---------------------------------------------------------------------------
test('T60 cross-scope: superseded local entry vs active global entry — local wins, but is rejected as superseded', () => {
  // Same id in both scopes: local has status=superseded, global has active.
  // resolveEpisodeRef builds index with local-wins precedence, so the
  // superseded entry wins → ref rejected. Both wrapper and validator must
  // agree (drift test).
  counter++
  const collisionId = `20260502-1100${String(counter).padStart(2, '0')}-collision-${counter.toString(16).padStart(4, '0')}`
  const stub = {
    id: collisionId, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'discovery', supersedes: null, tags: [], summary: 'collision'
  }
  fs.appendFileSync(indexFile, JSON.stringify({ ...stub, status: 'active' }) + '\n')
  fs.appendFileSync(localIndexFile, JSON.stringify({ ...stub, status: 'superseded' }) + '\n')
  // Need the collision episode file in both scopes too.
  const fmActive = `---\nid: ${collisionId}\ndate: 2026-05-02\ntime: "11:00"\nproject: test\ncategory: discovery\nstatus: active\ntags: []\nsummary: collision\n---\n# x\n`
  const fmSuper = fmActive.replace('status: active', 'status: superseded')
  fs.writeFileSync(path.join(episodesDir, `${collisionId}.md`), fmActive)
  fs.writeFileSync(path.join(localEpisodesDir, `${collisionId}.md`), fmSuper)
  // Build a chain in default global scope, then a review-request whose
  // tests_ref cites the collision id.
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { tests_ref: `episode:${collisionId}`, code_review_ref: `episode:${chain.reviewId}`, bug_logging: { status: 'no-new-bugs' } } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes(`episode:${collisionId} is superseded`)),
    `expected superseded error from local-wins precedence, got: ${JSON.stringify(r.json.errors)}`)
})

// ---------------------------------------------------------------------------
// Drift test (folded gap #8): wrapper's resolver vs validator's resolver
// must produce byte-equal output for identical input.
// ---------------------------------------------------------------------------
// Drift test (folded gap #8 + review m1 strengthening): wrapper's
// resolveEpisodeRef and validator's resolveEpisodeRef must agree on every
// rejection class. Each class produces an error containing a class-anchor
// substring; assert the substring appears in BOTH outputs for the same
// fixture. Cosmetic message changes don't break this; semantic divergence does.
function runWrapperWithApprovalRef(chain, approvalRefValue) {
  return runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', approvalRefValue,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
    '--worktree', tmpCwd, '--scope', 'global',
  ])
}

test('T61 drift: wrapper + validator agree on rejection class — placeholder', () => {
  const chain = mkBaseChainForReview()
  const wr = runWrapperWithApprovalRef(chain, 'episode:')
  assert.strictEqual(wr.exit, 1, `wrapper json: ${JSON.stringify(wr.json)}`)
  assert.ok(wr.json.errors.some(e => e.includes('placeholder')),
    `wrapper placeholder error; got: ${JSON.stringify(wr.json.errors)}`)
  mkReviewRequest({ chain, extra: { approval_ref: 'episode:' } })
  const vr = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(vr.json.valid, false)
  assert.ok(vr.json.errors.some(e => e.includes('placeholder')),
    `validator placeholder error; got: ${JSON.stringify(vr.json.errors)}`)
})

test('T61b drift: wrapper + validator agree on rejection class — not found', () => {
  const chain = mkBaseChainForReview()
  const wr = runWrapperWithApprovalRef(chain, 'episode:bogus-not-in-index-xyz')
  assert.ok(wr.json.errors.some(e => e.includes('not found')),
    `wrapper not-found error; got: ${JSON.stringify(wr.json.errors)}`)
  mkReviewRequest({ chain, extra: { approval_ref: 'episode:bogus-not-in-index-xyz' } })
  const vr = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(vr.json.valid, false)
  assert.ok(vr.json.errors.some(e => e.includes('not found')),
    `validator not-found error; got: ${JSON.stringify(vr.json.errors)}`)
})

test('T61c drift: wrapper + validator agree on rejection class — superseded', () => {
  const chain = mkBaseChainForReview()
  // Mark planId as superseded.
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').map(l => {
    const e = JSON.parse(l)
    if (e.id === chain.planId) e.status = 'superseded'
    return JSON.stringify(e)
  })
  fs.writeFileSync(indexFile, lines.join('\n') + '\n')
  const wr = runWrapperWithApprovalRef(chain, `episode:${chain.planId}`)
  assert.ok(wr.json.errors.some(e => e.includes('is superseded')),
    `wrapper superseded error; got: ${JSON.stringify(wr.json.errors)}`)
  mkReviewRequest({ chain })
  const vr = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(vr.json.valid, false)
  assert.ok(vr.json.errors.some(e => e.includes('is superseded')),
    `validator superseded error; got: ${JSON.stringify(vr.json.errors)}`)
})

test('T61d drift: wrapper + validator agree on rejection class — category mismatch', () => {
  const chain = mkBaseChainForReview()
  // Approval ref points to a non-lifecycle witness. Both should reject.
  const witnessId = mkWitness({ category: 'discovery', summary: 'not lifecycle' })
  const wr = runWrapperWithApprovalRef(chain, `episode:${witnessId}`)
  assert.ok(wr.json.errors.some(e => e.includes('category')),
    `wrapper category error; got: ${JSON.stringify(wr.json.errors)}`)
  mkReviewRequest({ chain, extra: { approval_ref: `episode:${witnessId}` } })
  const vr = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(vr.json.valid, false)
  assert.ok(vr.json.errors.some(e => e.includes('category')),
    `validator category error; got: ${JSON.stringify(vr.json.errors)}`)
})

test('T61e drift: wrapper + validator agree on rejection class — timestamp after citing', () => {
  const chain = mkBaseChainForReview()
  // Witness with date FAR in the future → resolver rejects "is after citing".
  // Wrapper's currentEpisode is built from now() — for the test to be
  // deterministic, we use a 2099-dated witness which is comfortably after
  // any plausible "now". Both copies use the same comparator (string
  // compare on `date time`), so both must reject.
  counter++
  const futureId = `20990101-120000-future-${counter.toString(16).padStart(4, '0')}`
  const futFm = `---\nid: ${futureId}\ndate: 2099-01-01\ntime: "12:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: future\n---\n`
  fs.writeFileSync(path.join(episodesDir, `${futureId}.md`), futFm + '\n# future\n')
  fs.appendFileSync(indexFile, JSON.stringify({
    id: futureId, date: '2099-01-01', time: '12:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'future'
  }) + '\n')
  const wr = runWrapperWithApprovalRef(chain, `episode:${futureId}`)
  assert.ok(wr.json.errors.some(e => e.includes('after citing episode')),
    `wrapper timestamp error; got: ${JSON.stringify(wr.json.errors)}`)
  // Validator side: write the review-request fixture using mkEpisode (which
  // dates 2026-05-02). The future ref's timestamp > citing's → rejected.
  mkReviewRequest({ chain, extra: { approval_ref: `episode:${futureId}` } })
  const vr = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(vr.json.valid, false)
  assert.ok(vr.json.errors.some(e => e.includes('after citing episode')),
    `validator timestamp error; got: ${JSON.stringify(vr.json.errors)}`)
})

// ---------------------------------------------------------------------------
// Wrapper E2E
// ---------------------------------------------------------------------------
test('T62 wrapper E2E: full ref set succeeds (writes review-request episode)', () => {
  const chain = mkBaseChainForReview()
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${chain.planId}`,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs',
    '--branch', 'main',
    '--head', 'abc1234',
    '--worktree', tmpCwd,
    '--scope', 'global',
  ])
  assert.strictEqual(wr.exit, 0, `expected exit 0, got ${wr.exit}: ${JSON.stringify(wr.json)}`)
  assert.strictEqual(wr.json.status, 'ok')
  assert.ok(wr.json.id && wr.json.file)
  assert.ok(fs.existsSync(wr.json.file), `episode file should exist: ${wr.json.file}`)
  // Now validator should accept the chain.
  const vr = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(vr.json.valid, true, `validator errors: ${JSON.stringify(vr.json.errors)}`)
})

test('T63 wrapper exit code: missing required flag → exit 2 (usage error)', () => {
  const wr = runReviewWrapper(['--task', 'TEST'])
  assert.strictEqual(wr.exit, 2)
  assert.strictEqual(wr.json.status, 'error')
  assert.ok(wr.json.message.includes('Missing required flags'))
})

test('T64 wrapper exit code: nonexistent ref → exit 1 (validation failure)', () => {
  const chain = mkBaseChainForReview()
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', 'episode:bogus-approval-id',
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
  ])
  assert.strictEqual(wr.exit, 1, `expected exit 1, got ${wr.exit}: ${JSON.stringify(wr.json)}`)
  assert.strictEqual(wr.json.status, 'error')
  assert.ok(wr.json.errors.some(e => e.includes('--approval-ref') && e.includes('not found')))
})

test('T65 wrapper: malformed --bug-log-ref → exit 2', () => {
  const chain = mkBaseChainForReview()
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${chain.planId}`,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--bug-log-ref', 'not-a-url',
    '--branch', 'main', '--head', 'abc1234',
  ])
  assert.strictEqual(wr.exit, 2)
  assert.ok(wr.json.message.includes('Malformed --bug-log-ref'))
})

test('T66 wrapper: --bug-log-ref + --no-new-bugs is mutex error (exit 2)', () => {
  const chain = mkBaseChainForReview()
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${chain.planId}`,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--bug-log-ref', 'https://github.com/owner/repo/issues/1',
    '--no-new-bugs',
    '--branch', 'main', '--head', 'abc1234',
  ])
  assert.strictEqual(wr.exit, 2)
  assert.ok(wr.json.message.includes('mutually exclusive'))
})

test('T58b multi-review-request reverse: older valid + newer invalid → gate fails (locks contract direction)', () => {
  // Locks the "latest wins" contract: older review-request's success cannot
  // rescue an invalid newer terminal review-request. Per review m3.
  const chain = mkBaseChainForReview()
  // Older review-request (11:00) — VALID (full ref set).
  counter++
  const olderId = `20260502-1100${String(counter).padStart(2, '0')}-rr-older-valid-${counter.toString(16).padStart(4, '0')}`
  const olderPayload = {
    event: 'review-request',
    pattern_id: 'bp-001-implementation-workflow',
    task: 'TEST',
    context: { worktree: tmpCwd, branch: 'main', head: 'abc1234' },
    plan_ref: 'p.md',
    approval_ref: `episode:${chain.planId}`,
    pre_checkpoint_ref: `episode:${chain.preId}`,
    post_checkpoint_ref: `episode:${chain.postId}`,
    evidence: {
      tests_ref: `episode:${chain.logId}`,
      code_review_ref: `episode:${chain.reviewId}`,
      bug_logging: { status: 'no-new-bugs' }
    }
  }
  const olderFm = `---\nid: ${olderId}\ndate: 2026-05-02\ntime: "11:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: rr older valid\n---\n`
  const olderBody = `# x\n\n\`\`\`json\n${JSON.stringify(olderPayload)}\n\`\`\`\n`
  fs.writeFileSync(path.join(episodesDir, `${olderId}.md`), olderFm + '\n' + olderBody)
  fs.appendFileSync(indexFile, JSON.stringify({
    id: olderId, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'older'
  }) + '\n')
  // Newer review-request (12:00, default mkEpisode time) — INVALID (bogus
  // post_checkpoint_ref). This is the terminal one; its error must NOT be
  // migrated to a warning.
  mkReviewRequest({ chain, extra: { post_checkpoint_ref: 'episode:bogus-newer-stale' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false, `terminal invalid → gate must fail; warnings: ${JSON.stringify(r.json.warnings)}`)
  assert.ok(r.json.errors.some(e => e.includes('post_checkpoint_ref') && e.includes('not found')),
    `expected post_checkpoint_ref error to remain (not migrated), got: ${JSON.stringify(r.json.errors)}`)
})

test('T68 wrapper: detached HEAD without --branch → exit 2 (review M3)', () => {
  // Run wrapper from a freshly-init'd repo with no commits. git symbolic-ref
  // -q HEAD fails on detached / no-commits state. Wrapper must exit 2 with
  // actionable error.
  const detachedTmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'em-validate-detached-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: detachedTmpCwd })
    // Brand new repo: HEAD points at refs/heads/main (or master) but no
    // commits exist yet. symbolic-ref --short -q HEAD will succeed and
    // return "main" — so we go a step further to actually detach.
    // To force a real detached state: create a commit, then checkout the SHA.
    fs.writeFileSync(path.join(detachedTmpCwd, 'README.md'), 'x')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md'], { cwd: detachedTmpCwd })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: detachedTmpCwd })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: detachedTmpCwd, encoding: 'utf8' }).trim()
    execFileSync('git', ['checkout', '-q', sha], { cwd: detachedTmpCwd })
    const wr = runReviewWrapper([
      '--task', 'TEST',
      '--plan-ref', 'docs/plan.md',
      '--approval-ref', 'episode:nope',
      '--pre-checkpoint-ref', 'episode:nope',
      '--post-checkpoint-ref', 'episode:nope',
      '--tests-ref', 'docs/test.log',
      '--code-review-ref', 'episode:nope',
      '--no-new-bugs',
      // No --branch → wrapper detects detached HEAD.
    ], { cwd: detachedTmpCwd })
    assert.strictEqual(wr.exit, 2, `expected exit 2 on detached HEAD, got ${wr.exit}: ${JSON.stringify(wr.json)}`)
    assert.ok(wr.json.message.toLowerCase().includes('detached') || wr.json.message.toLowerCase().includes('symbolic ref'),
      `expected detached/symbolic-ref message, got: ${wr.json.message}`)
  } finally {
    fs.rmSync(detachedTmpCwd, { recursive: true, force: true })
  }
})

test('T69 triggered_by to superseded episode is rejected', () => {
  const chain = mkBaseChainForReview()
  const supId = mkWitness({ category: 'lesson', summary: 'feedback' })
  // Mark supId as superseded in index.
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').map(l => {
    const e = JSON.parse(l)
    if (e.id === supId) e.status = 'superseded'
    return JSON.stringify(e)
  })
  fs.writeFileSync(indexFile, lines.join('\n') + '\n')
  mkReviewRequest({ chain, extra: { triggered_by: `episode:${supId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('triggered_by') && e.includes('superseded')),
    `expected triggered_by superseded error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T70 verifications array with mixed valid + invalid entries: per-entry errors emitted', () => {
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { evidence: { verifications: [
    { kind: 'evidence', claim: 'good', output: 'ok' },        // valid
    { kind: 'evidence', claim: 'bad' },                        // missing excerpt+output
    { kind: 'narrative', claim: 'ok narrative' },              // valid
    { kind: 'evidance', claim: 'typo', excerpt: 'foo' },       // unknown kind
  ] } } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  // Should see one error for index 1 (missing excerpt/output) and one for index 3 (unknown kind).
  assert.ok(r.json.errors.some(e => e.includes('verifications[1]') && e.includes("'excerpt' or 'output'")),
    `expected verifications[1] error, got: ${JSON.stringify(r.json.errors)}`)
  assert.ok(r.json.errors.some(e => e.includes('verifications[3]') && e.includes("kind 'evidance'") && e.includes('schema v1')),
    `expected verifications[3] versioned error, got: ${JSON.stringify(r.json.errors)}`)
})

test('T71 wrapper --scope inherit: chain in local → review-request lands in local', () => {
  // Build the full base chain in LOCAL (tmpCwd .episodic-memory).
  const writeLocalLifecycle = (event, head, extra) => {
    counter++
    const id = `20260502-1200${String(counter).padStart(2, '0')}-${event}-${counter.toString(16).padStart(4, '0')}`
    const payload = {
      event, pattern_id: 'bp-001-implementation-workflow', task: 'TEST',
      context: { worktree: tmpCwd, branch: 'main', head },
      ...extra
    }
    const fm = `---\nid: ${id}\ndate: 2026-05-02\ntime: "12:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: ${event}\n---\n`
    const body = `# ${event}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
    fs.writeFileSync(path.join(localEpisodesDir, `${id}.md`), fm + '\n' + body)
    fs.appendFileSync(localIndexFile, JSON.stringify({
      id, date: '2026-05-02', time: '12:00', project: 'test',
      category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: event
    }) + '\n')
    return id
  }
  // Witness in local for evidence refs.
  counter++
  const wid = `20260502-110000-witness-local-${counter.toString(16).padStart(4, '0')}`
  const witFm = `---\nid: ${wid}\ndate: 2026-05-02\ntime: "11:00"\nproject: test\ncategory: discovery\nstatus: active\ntags: []\nsummary: w\n---\n# w\n`
  fs.writeFileSync(path.join(localEpisodesDir, `${wid}.md`), witFm)
  fs.appendFileSync(localIndexFile, JSON.stringify({
    id: wid, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'discovery', status: 'active', supersedes: null, tags: [], summary: 'w'
  }) + '\n')
  const planId = writeLocalLifecycle('plan-approved', 'abc1234', { plan_ref: 'p.md' })
  const preId = writeLocalLifecycle('pre-checkpoint', 'abc1234', { plan_ref: 'p.md', approval_ref: `episode:${planId}` })
  const postId = writeLocalLifecycle('post-checkpoint', 'abc1234', {
    pre_checkpoint_ref: `episode:${preId}`,
    evidence: {
      tests: [{ command: 'x', status: 'passed', log_ref: `episode:${wid}` }],
      code_review: { status: 'done', reply_ref: `episode:${wid}` },
      e2e: { status: 'passed', log_ref: `episode:${wid}` },
      bug_logging: { status: 'done', issues: [] }
    }
  })
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${planId}`,
    '--pre-checkpoint-ref', `episode:${preId}`,
    '--post-checkpoint-ref', `episode:${postId}`,
    '--tests-ref', `episode:${wid}`,
    '--code-review-ref', `episode:${wid}`,
    '--no-new-bugs',
    '--branch', 'main',
    '--head', 'abc1234',
    '--worktree', tmpCwd,
    // No --scope → defaults to inherit → should resolve to LOCAL because
    // post-checkpoint-ref is in local.
  ])
  assert.strictEqual(wr.exit, 0, `expected exit 0; got: ${JSON.stringify(wr.json)}`)
  assert.strictEqual(wr.json.scope, 'local', `expected scope=local from inherit, got: ${wr.json.scope}`)
  // Verify episode landed in local.
  assert.ok(fs.existsSync(path.join(localEpisodesDir, `${wr.json.id}.md`)),
    `episode should be in local episodesDir: ${wr.json.file}`)
})

// ---------------------------------------------------------------------------
// Codex PR #156 review F1: splice-resistance for ALL three chain refs
// (approval_ref + pre_checkpoint_ref + post_checkpoint_ref).
// Codex's exact repro reproduced as T72; T73-T77 cover related shapes.
// ---------------------------------------------------------------------------

test('T72 Codex F1 repro: review-request with cross-task approval_ref + pre_checkpoint_ref rejected', () => {
  // Codex repro verbatim (PR #156 review F1, episode `...921a`):
  // - TASK-A full chain (plan/pre/post)
  // - TASK-B plan-approved + pre-checkpoint
  // - TASK-A review-request citing TASK-B's approval_ref + pre_checkpoint_ref
  //   (and TASK-A's post_checkpoint_ref).
  // Pre-fix: validator returned exit 0, valid=true. Post-fix: must reject.
  const chainA = mkBaseChainForReview({ task: 'TASK-A' })
  const planB = mkEpisode({ event: 'plan-approved', task: 'TASK-B', extra: { plan_ref: 'b.md' } })
  const preB = mkEpisode({ event: 'pre-checkpoint', task: 'TASK-B', extra: { plan_ref: 'b.md', approval_ref: `episode:${planB}` } })
  // Build review-request manually with the cross-task approval/pre refs.
  mkReviewRequest({
    chain: { ...chainA, planId: planB, preId: preB }, // splice approval/pre
    task: 'TASK-A'
  })
  const r = runValidate(['--task', 'TASK-A', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false, `pre-fix exit=0 valid=true was the bug; post-fix MUST reject. errors: ${JSON.stringify(r.json.errors)}`)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref') && (e.includes('plan-approved episode for this task') || e.includes('chain link'))),
    `expected approval_ref splice rejection, got: ${JSON.stringify(r.json.errors)}`)
  assert.ok(r.json.errors.some(e => e.includes('pre_checkpoint_ref') && (e.includes('pre-checkpoint episode for this task') || e.includes('chain link'))),
    `expected pre_checkpoint_ref splice rejection, got: ${JSON.stringify(r.json.errors)}`)
})

test('T73 review-request: approval_ref to non-existent plan-approved episode rejected', () => {
  const chain = mkBaseChainForReview()
  // approval_ref to a different-category episode (lifecycle category check
  // alone wouldn't catch this — needs plan-approved event check).
  const witnessId = mkWitness({ category: 'workflow.lifecycle', summary: 'fake lifecycle' })
  mkReviewRequest({ chain, extra: { approval_ref: `episode:${witnessId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  // Either the wrapper-side body-parse catches it (wrong event), OR the
  // validateChain check catches "not a plan-approved for this task".
  assert.ok(r.json.errors.some(e => e.includes('approval_ref')),
    `expected approval_ref rejection, got: ${JSON.stringify(r.json.errors)}`)
})

test('T74 review-request: pre_checkpoint_ref pointing to plan-approved (wrong event type) rejected', () => {
  // Even within same task, refs must point to the CORRECT event type.
  const chain = mkBaseChainForReview()
  // pre_checkpoint_ref points to plan-approved id (wrong event).
  mkReviewRequest({ chain, extra: { pre_checkpoint_ref: `episode:${chain.planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('pre_checkpoint_ref') && (e.includes('not a pre-checkpoint episode') || e.includes('chain link'))),
    `expected pre_checkpoint_ref event-type rejection, got: ${JSON.stringify(r.json.errors)}`)
})

test('T75 review-request: non-episode chain ref (file:path) rejected', () => {
  const chain = mkBaseChainForReview()
  // approval_ref is file:path — not episode-shaped. Must be rejected.
  mkReviewRequest({ chain, extra: { approval_ref: 'file:docs/plan-approved.md' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref') && e.includes('episode reference')),
    `expected non-episode chain-ref rejection, got: ${JSON.stringify(r.json.errors)}`)
})

test('T76 wrapper: --approval-ref splice (different-task plan-approved) rejected (Codex F1 wrapper-side)', () => {
  const chainA = mkBaseChainForReview({ task: 'TASK-A' })
  const planB = mkEpisode({ event: 'plan-approved', task: 'TASK-B', extra: { plan_ref: 'b.md' } })
  const wr = runReviewWrapper([
    '--task', 'TASK-A',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${planB}`, // splice from TASK-B
    '--pre-checkpoint-ref', `episode:${chainA.preId}`,
    '--post-checkpoint-ref', `episode:${chainA.postId}`,
    '--tests-ref', `episode:${chainA.logId}`,
    '--code-review-ref', `episode:${chainA.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
    '--worktree', tmpCwd, '--scope', 'global',
  ])
  assert.strictEqual(wr.exit, 1, `expected exit 1 (validation failure), got ${wr.exit}: ${JSON.stringify(wr.json)}`)
  assert.ok(wr.json.errors.some(e => e.includes('--approval-ref') && (e.includes('cross-task') || e.includes('expected "TASK-A"'))),
    `expected wrapper cross-task error, got: ${JSON.stringify(wr.json.errors)}`)
})

test('T77 wrapper: --pre-checkpoint-ref pointing to plan-approved (wrong event) rejected', () => {
  const chain = mkBaseChainForReview()
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${chain.planId}`,
    '--pre-checkpoint-ref', `episode:${chain.planId}`, // wrong event type
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
    '--worktree', tmpCwd, '--scope', 'global',
  ])
  assert.strictEqual(wr.exit, 1)
  assert.ok(wr.json.errors.some(e => e.includes('--pre-checkpoint-ref') && e.includes('event "plan-approved"')),
    `expected wrapper event-type error, got: ${JSON.stringify(wr.json.errors)}`)
})

test('T78 wrapper: non-episode chain ref (file:path) rejected', () => {
  const chain = mkBaseChainForReview()
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', 'file:docs/plan-approved.md', // non-episode shape
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
    '--worktree', tmpCwd, '--scope', 'global',
  ])
  assert.strictEqual(wr.exit, 1)
  assert.ok(wr.json.errors.some(e => e.includes('--approval-ref') && e.includes('episode reference')),
    `expected non-episode rejection, got: ${JSON.stringify(wr.json.errors)}`)
})

// ---------------------------------------------------------------------------
// Codex PR #156 round-2 P2: wrapper checkChainRef must require task strict
// equality (no null-as-provenance) and reject orphaned index entries (file
// missing on disk).
// ---------------------------------------------------------------------------

test('T79 Codex round-2 repro: wrapper rejects chain ref to lifecycle episode with no task field', () => {
  // Codex repro verbatim: workflow.lifecycle plan-approved episode whose body
  // has event=plan-approved and correct context but NO task field. Pre-fix
  // wrapper accepted (treated as provenance-only); post-fix MUST reject.
  const chain = mkBaseChainForReview()
  counter++
  const taskedlessId = `20260502-1100${String(counter).padStart(2, '0')}-no-task-plan-${counter.toString(16).padStart(4, '0')}`
  const taskedlessPayload = {
    event: 'plan-approved',
    pattern_id: 'bp-001-implementation-workflow',
    // task: deliberately omitted
    context: { worktree: tmpCwd, branch: 'main', head: 'abc1234' },
    plan_ref: 'p.md'
  }
  const fm = `---\nid: ${taskedlessId}\ndate: 2026-05-02\ntime: "11:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: no task\n---\n`
  const body = `# x\n\n\`\`\`json\n${JSON.stringify(taskedlessPayload, null, 2)}\n\`\`\`\n`
  fs.writeFileSync(path.join(episodesDir, `${taskedlessId}.md`), fm + '\n' + body)
  fs.appendFileSync(indexFile, JSON.stringify({
    id: taskedlessId, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'no task'
  }) + '\n')
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${taskedlessId}`,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
    '--worktree', tmpCwd, '--scope', 'global',
    '--dry-run',
  ])
  assert.strictEqual(wr.exit, 1, `expected exit 1 (validation failure), got ${wr.exit}: ${JSON.stringify(wr.json)}`)
  assert.ok(wr.json.errors.some(e => e.includes('--approval-ref') && (e.includes('<undefined>') || e.includes('missing-task'))),
    `expected wrapper missing-task rejection, got: ${JSON.stringify(wr.json.errors)}`)
})

test('T80 wrapper rejects chain ref to indexed-but-file-missing episode (orphan)', () => {
  // Index has an entry for episode-X, but episodes/episode-X.md was deleted.
  // checkChainRef cannot verify event/task without the body → reject.
  const chain = mkBaseChainForReview()
  counter++
  const orphanId = `20260502-1100${String(counter).padStart(2, '0')}-orphan-plan-${counter.toString(16).padStart(4, '0')}`
  // Add to index but DON'T write the .md file.
  fs.appendFileSync(indexFile, JSON.stringify({
    id: orphanId, date: '2026-05-02', time: '11:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'orphan'
  }) + '\n')
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${orphanId}`,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
    '--worktree', tmpCwd, '--scope', 'global',
    '--dry-run',
  ])
  assert.strictEqual(wr.exit, 1, `expected exit 1 (validation failure), got ${wr.exit}: ${JSON.stringify(wr.json)}`)
  assert.ok(wr.json.errors.some(e => e.includes('--approval-ref') && (e.includes('file missing') || e.includes('cannot verify'))),
    `expected wrapper orphan-file rejection, got: ${JSON.stringify(wr.json.errors)}`)
})

test('T81 triggered_by retains provenance-only semantics (NOT tightened by P2 fix)', () => {
  // Sanity check: triggered_by should KEEP its null-task-allowed behavior.
  // The P2 fix only tightens checkChainRef (chain refs); triggered_by uses a
  // separate code path with intentional provenance-only handling.
  const chain = mkBaseChainForReview()
  // Witness has no task field → triggered_by should accept it.
  const triggerId = mkWitness({ category: 'lesson', summary: 'codex feedback' })
  mkReviewRequest({ chain, extra: { triggered_by: `episode:${triggerId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `triggered_by null task is provenance-only, must remain valid; errors: ${JSON.stringify(r.json.errors)}`)
})

test('T67 wrapper: --dry-run prints payload without writing', () => {
  const chain = mkBaseChainForReview()
  const beforeFiles = fs.readdirSync(episodesDir).length
  const wr = runReviewWrapper([
    '--task', 'TEST',
    '--plan-ref', 'docs/plan.md',
    '--approval-ref', `episode:${chain.planId}`,
    '--pre-checkpoint-ref', `episode:${chain.preId}`,
    '--post-checkpoint-ref', `episode:${chain.postId}`,
    '--tests-ref', `episode:${chain.logId}`,
    '--code-review-ref', `episode:${chain.reviewId}`,
    '--no-new-bugs', '--branch', 'main', '--head', 'abc1234',
    '--dry-run',
  ])
  assert.strictEqual(wr.exit, 0)
  assert.strictEqual(wr.json.dry_run, true)
  assert.ok(wr.json.payload)
  assert.strictEqual(wr.json.payload.event, 'review-request')
  // No new episode file written.
  const afterFiles = fs.readdirSync(episodesDir).length
  assert.strictEqual(afterFiles, beforeFiles, 'dry-run should not write episode file')
})

// ===========================================================================
// #102 — terminal-anchored chain selection
// ===========================================================================

// Helper: build a parallel post-checkpoint episode in the same task that is
// NOT chain-linked from any terminal. Used to verify the new contract that
// out-of-chain post-checkpoints don't satisfy required-event presence.
function mkParallelPostCheckpoint({ chain }) {
  const lId = mkWitness({ summary: 'log-parallel' })
  const rId = mkWitness({ summary: 'review-parallel' })
  const eId = mkWitness({ summary: 'e2e-parallel' })
  return mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${chain.preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] },
      },
    },
  })
}

test('T102-1 selectChain: two post-checkpoints, only one chain-linked from push-allowed', () => {
  const chain = mkBaseChainForReview()
  const parallelPostId = mkParallelPostCheckpoint({ chain })
  // push-allowed references the canonical post-checkpoint, not the parallel.
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${chain.postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `gate should pass; errors: ${JSON.stringify(r.json.errors)}`)
  // Parallel post-ckpt is in episodes[] but in_chain: false.
  const parallel = r.json.episodes.find(e => e.id === parallelPostId)
  assert.ok(parallel, `parallel post should appear in episodes[]`)
  assert.strictEqual(parallel.in_chain, false, `parallel post must NOT be in selectedChain`)
  // Canonical post is in_chain: true.
  const canon = r.json.episodes.find(e => e.id === chain.postId)
  assert.strictEqual(canon.in_chain, true)
})

test('T102-2 selectChain: in_chain set includes plan/pre/post for push-allowed walk', () => {
  const chain = mkBaseChainForReview()
  const paId = mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${chain.postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true)
  const inChainIds = new Set(r.json.episodes.filter(e => e.in_chain).map(e => e.id))
  assert.ok(inChainIds.has(chain.planId), 'plan-approved should be in chain')
  assert.ok(inChainIds.has(chain.preId), 'pre-checkpoint should be in chain')
  assert.ok(inChainIds.has(chain.postId), 'post-checkpoint should be in chain')
  assert.ok(inChainIds.has(paId), 'push-allowed terminal should be in chain')
})

test('T102-3 selectChain: multiple plan-approved revisions, only chain-linked one in selectedChain', () => {
  const chain = mkBaseChainForReview()
  // Build a parallel plan-approved that's NOT referenced.
  const parallelPlanId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p2.md' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
  const parallel = r.json.episodes.find(e => e.id === parallelPlanId)
  assert.ok(parallel)
  assert.strictEqual(parallel.in_chain, false, `unreferenced plan-approved must NOT be in selectedChain`)
  const canon = r.json.episodes.find(e => e.id === chain.planId)
  assert.strictEqual(canon.in_chain, true)
})

test('T102-4 review-request gate: chain-walk picks coherent chain, parallel chain warned', () => {
  // Two complete chains for same task; only chain1 has a review-request.
  const chain1 = mkBaseChainForReview()
  const lId2 = mkWitness({ summary: 'log2' })
  const rId2 = mkWitness({ summary: 'review2' })
  const eId2 = mkWitness({ summary: 'e2e2' })
  const planId2 = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p2.md' } })
  const preId2 = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p2.md', approval_ref: `episode:${planId2}` } })
  const postId2 = mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${preId2}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId2}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId2}` },
        e2e: { status: 'passed', log_ref: `episode:${eId2}` },
        bug_logging: { status: 'done', issues: [] },
      },
    },
  })
  mkReviewRequest({ chain: chain1 })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `gate should pass; errors: ${JSON.stringify(r.json.errors)}`)
  const inChain = new Set(r.json.episodes.filter(e => e.in_chain).map(e => e.id))
  assert.ok(inChain.has(chain1.planId) && inChain.has(chain1.preId) && inChain.has(chain1.postId),
    'chain1 entirely in selectedChain')
  assert.ok(!inChain.has(planId2) && !inChain.has(preId2) && !inChain.has(postId2),
    'chain2 entirely out-of-chain')
})

test('T102-5 out-of-chain post-checkpoint with branch mismatch: error migrated to warning', () => {
  // A parallel post-ckpt with mismatched branch produces a branch-mismatch
  // error pre-fix; post-fix it's out-of-chain so the error becomes a warning
  // and gate still passes against the canonical chain. Branch mismatch is
  // enforced unconditionally in validatePayload (no git dependency, unlike
  // the head ancestor check).
  const chain = mkBaseChainForReview()
  const lId = mkWitness({ summary: 'log-x' })
  const rId = mkWitness({ summary: 'review-x' })
  const eId = mkWitness({ summary: 'e2e-x' })
  const parallelPostId = mkEpisode({
    event: 'post-checkpoint',
    branch: 'feature-other',
    extra: {
      pre_checkpoint_ref: `episode:${chain.preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] },
      },
    },
  })
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${chain.postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234', '--branch', 'main'])
  assert.strictEqual(r.json.valid, true, `gate must pass; errors: ${JSON.stringify(r.json.errors)}`)
  // The branch-mismatch text is now in warnings, prefixed (out-of-chain).
  assert.ok(r.json.warnings.some(w => w.includes('(out-of-chain)') && w.includes(parallelPostId) && w.includes('branch')),
    `expected migrated branch-mismatch warning, got: ${JSON.stringify(r.json.warnings)}`)
})

test('T102-6 broken ref mid-chain: terminal references missing post-checkpoint id', () => {
  // selectChain walker tolerates missing refs (validatePayload already errored
  // upstream). Walk halts; selectedChain only contains terminal. presentEvents
  // missing post-checkpoint → gate fails with missing[].
  const chain = mkBaseChainForReview()
  // push-allowed cites a non-existent post-checkpoint id.
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: 'episode:does-not-exist-xyz' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  // The original "not found" error is preserved (precise error string, not
  // synthesized "chain unselectable").
  assert.ok(r.json.errors.some(e => e.includes('does-not-exist-xyz')),
    `expected precise not-found error preserved, got: ${JSON.stringify(r.json.errors)}`)
})

test('T102-7 triggered_by NOT walked into selectedChain', () => {
  const chain = mkBaseChainForReview()
  const trigId = mkWitness({ category: 'lesson', summary: 'trigger lesson' })
  mkReviewRequest({ chain, extra: { triggered_by: `episode:${trigId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true)
  const trig = r.json.episodes.find(e => e.id === trigId)
  // Witness episodes (lesson category) aren't in workflow.lifecycle pre-filter
  // so they don't appear in episodes[] at all. selectChain must not pull them.
  assert.strictEqual(trig, undefined, 'triggered_by witness should not be in episodes[]')
})

test('T102-8 second_opinion.reply_ref NOT in selectedChain', () => {
  // pre-checkpoint with second_opinion.reply_ref to a non-lifecycle witness.
  // selectedChain walks approval_ref only; reply_ref is a witness, not a chain link.
  const lId = mkWitness({ summary: 'so-reply' })
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({
    event: 'pre-checkpoint',
    extra: {
      plan_ref: 'p.md',
      approval_ref: `episode:${planId}`,
      second_opinion: { status: 'done', recipient: 'codex', reply_ref: `episode:${lId}` },
    },
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
  // Witness lId is non-lifecycle; not in episodes[]. Confirms it didn't sneak in.
  const witnessInEpisodes = r.json.episodes.find(e => e.id === lId)
  assert.strictEqual(witnessInEpisodes, undefined)
})

test('T102-9 walk hits cross-category ref: error preserved, missing populated', () => {
  // pre-checkpoint approval_ref points to non-lifecycle category (caught by
  // expectedCategory check upstream). selectChain walks anyway but the error
  // is raised by validatePayload + checkEpisodeRefs.
  const witnessId = mkWitness({ category: 'discovery', summary: 'fake plan' })
  mkEpisode({
    event: 'pre-checkpoint',
    extra: { plan_ref: 'p.md', approval_ref: `episode:${witnessId}` },
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref') && e.includes('category')),
    `expected category-mismatch error preserved, got: ${JSON.stringify(r.json.errors)}`)
})

test('T102-10 no-terminal: gate=post-checkpoint with only plan+pre → missing[] populated, no crash', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.missing.includes('post-checkpoint'),
    `expected missing post-checkpoint, got: ${JSON.stringify(r.json.missing)}`)
})

test('T102-11 placeholder approval_ref in terminal: walk halts, plan-approved missing', () => {
  // pre-checkpoint with placeholder approval_ref. validatePayload errors;
  // selectChain walk halts at terminal; plan-approved not in selectedChain.
  // Even if a plan-approved exists for the task, it's not in selectedChain.
  mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: 'episode:' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  // missing reflects out-of-chain plan-approved.
  assert.ok(r.json.missing.includes('plan-approved'),
    `expected missing plan-approved (not in selectedChain), got: ${JSON.stringify(r.json.missing)}`)
  // Schema error still surfaces.
  assert.ok(r.json.errors.some(e => e.includes('approval_ref') && e.includes('placeholder')),
    `expected placeholder error preserved, got: ${JSON.stringify(r.json.errors)}`)
})

test('T102-12 wrong-shape approval_ref: walk halts, error preserved', () => {
  mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: 'file:plans/foo.md' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref') && e.includes('episode reference')),
    `expected non-episode error preserved, got: ${JSON.stringify(r.json.errors)}`)
})

test('T102-13 wrong-semantic: post_checkpoint_ref points to pre-checkpoint id', () => {
  const chain = mkBaseChainForReview()
  // push-allowed.post_checkpoint_ref points at preId (wrong event type).
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${chain.preId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false)
  // Original "not a post-checkpoint" error preserved.
  assert.ok(r.json.errors.some(e => e.includes('post_checkpoint_ref') && e.includes('not a post-checkpoint')),
    `expected wrong-event-type error preserved, got: ${JSON.stringify(r.json.errors)}`)
})

test('T102-14 tiebreak: multiple terminals at identical timestamp, id-lex desc wins (deterministic)', () => {
  // Two pre-checkpoints with same timestamp (same date/time fields). selectChain
  // tiebreak: lex desc on entry.id. Counter-suffixed ids are monotonic so
  // the LATER-CREATED one (higher counter → lex larger) wins deterministically.
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  const pre1 = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const pre2 = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'pre-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
  // pre2 has higher counter → lex larger → terminal.
  const terminal = r.json.episodes.find(e => e.id === pre2)
  assert.strictEqual(terminal.in_chain, true, 'pre2 (lex-larger id) should be terminal')
  const other = r.json.episodes.find(e => e.id === pre1)
  assert.strictEqual(other.in_chain, false, 'pre1 (lex-smaller) should be out-of-chain')
})

test('T102-15 head disambiguation: multiple terminals, --head selects matching one', () => {
  // Two post-checkpoints at different heads. push-allowed --head selects the
  // matching post via head-equality (mediated by post_checkpoint_ref + the
  // existing head-equality enforcement at validateChain). Test that both ARE
  // referenced via separate push-alloweds and selectChain picks the head-match.
  // Simplification: build chain with one post at abc1234 (chain.postId) and one
  // parallel push-allowed referencing a parallel post at differenthead.
  const chain = mkBaseChainForReview()
  const lId = mkWitness({ summary: 'log-h' })
  const rId = mkWitness({ summary: 'review-h' })
  const eId = mkWitness({ summary: 'e2e-h' })
  const altPostId = mkEpisode({
    event: 'post-checkpoint',
    head: 'differenthead',
    extra: {
      pre_checkpoint_ref: `episode:${chain.preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] },
      },
    },
  })
  // Two push-allowed terminals at different heads. selectChain prefers
  // ctx.head === --head exact match.
  const paAlt = mkEpisode({ event: 'push-allowed', head: 'differenthead', extra: { post_checkpoint_ref: `episode:${altPostId}` } })
  const paGood = mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${chain.postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
  // paGood has matching head → terminal.
  const goodIn = r.json.episodes.find(e => e.id === paGood).in_chain
  const altIn = r.json.episodes.find(e => e.id === paAlt).in_chain
  assert.strictEqual(goodIn, true)
  assert.strictEqual(altIn, false)
})

test('T102-16 review-request coalescence: rr.pre_checkpoint_ref diverges from post.pre_checkpoint_ref', () => {
  // Build two complete chains, then create a review-request whose
  // post_checkpoint_ref points at chain1.postId BUT pre_checkpoint_ref points
  // at chain2.preId. Both refs are individually same-task / right event-type
  // — but they don't coalesce. Pre-#102 + Gap#1 fix would silently accept;
  // post-fix coalescence assertion must reject.
  const chain1 = mkBaseChainForReview()
  const planId2 = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p2.md' } })
  const preId2 = mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p2.md', approval_ref: `episode:${planId2}` } })
  const lId2 = mkWitness({ summary: 'log2' })
  const rId2 = mkWitness({ summary: 'review2' })
  const eId2 = mkWitness({ summary: 'e2e2' })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${preId2}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId2}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId2}` },
        e2e: { status: 'passed', log_ref: `episode:${eId2}` },
        bug_logging: { status: 'done', issues: [] },
      },
    },
  })
  // rr: post points to chain1.postId, but pre points to chain2's preId2.
  mkReviewRequest({
    chain: { ...chain1, preId: preId2 }, // splice pre, keep post=chain1.postId, approval=chain1.planId
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false, `coalescence violation must reject; errors: ${JSON.stringify(r.json.errors)}`)
  assert.ok(r.json.errors.some(e => e.includes('pre_checkpoint_ref') && e.includes('coalesce')),
    `expected coalescence error on pre_checkpoint_ref, got: ${JSON.stringify(r.json.errors)}`)
})

test('T102-17 review-request coalescence: rr.approval_ref diverges from pre.approval_ref', () => {
  // Two plan-approveds for same task, both same task. rr.approval_ref points
  // at planId2 while the walked path (rr → post → pre → approval) lands at
  // planId1. Coalescence assertion must reject.
  const chain = mkBaseChainForReview()
  const planId2 = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p2.md' } })
  // rr.approval_ref points at planId2 (NOT chain.planId).
  mkReviewRequest({
    chain,
    extra: { approval_ref: `episode:${planId2}` },
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, false, `coalescence violation must reject; errors: ${JSON.stringify(r.json.errors)}`)
  assert.ok(r.json.errors.some(e => e.includes('approval_ref') && e.includes('coalesce')),
    `expected coalescence error on approval_ref, got: ${JSON.stringify(r.json.errors)}`)
})

test('T102-18 review-request coalescence: all three refs coherent → passes', () => {
  // Regression guard: a properly-formed review-request with all three chain
  // refs converging on the same chain must still pass post-#102.
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `coherent chain must pass; errors: ${JSON.stringify(r.json.errors)}`)
})

test('T102-19 in_chain flag: classified episode not in chain (not required for any gate)', () => {
  const chain = mkBaseChainForReview()
  // classified is not a chain-link event for any gate per workflow-lifecycle.md:407.
  const classifiedId = mkEpisode({ event: 'classified', extra: { classification: 'full' } })
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${chain.postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
  // classified appears in episodes[] (backward-compat) with in_chain: false.
  const classified = r.json.episodes.find(e => e.id === classifiedId)
  assert.ok(classified, 'classified should appear in episodes[]')
  assert.strictEqual(classified.in_chain, false)
})

test('T102-20 single coherent chain: regression — gate passes, all events in_chain', () => {
  // The simplest case: one chain, one terminal, no parallels. Must continue
  // passing post-refactor.
  const chain = mkBaseChainForReview()
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
  const inChainEvents = r.json.episodes.filter(e => e.in_chain).map(e => e.event).sort()
  assert.deepStrictEqual(inChainEvents.sort(), ['plan-approved', 'post-checkpoint', 'pre-checkpoint'].sort())
})

test('T102-22 review-request: legitimate episode-shaped plan_ref (plan-doc episode) PASSES', () => {
  // Codex PR #171 review repro: rr.plan_ref points at a separate non-lifecycle
  // plan-document episode (which the plan-approved + pre-checkpoint also
  // reference as their plan_ref). This is a legitimate pattern per spec
  // workflow-lifecycle.md:151. plan_ref is the plan artifact, NOT the
  // plan-approved lifecycle episode. An earlier (incorrect) coalescence
  // assertion conflated these and false-rejected this shape; this test locks
  // the correct semantics.
  //
  // Build chain manually (mkBaseChainForReview hardcodes plan_ref='p.md').
  const planDocId = mkWitness({ category: 'discovery', summary: 'plan doc as episode' })
  const lId = mkWitness({ summary: 'log-pd' })
  const rId = mkWitness({ summary: 'review-pd' })
  const eId = mkWitness({ summary: 'e2e-pd' })
  const planId = mkEpisode({
    event: 'plan-approved',
    extra: { plan_ref: `episode:${planDocId}` },
  })
  const preId = mkEpisode({
    event: 'pre-checkpoint',
    extra: { plan_ref: `episode:${planDocId}`, approval_ref: `episode:${planId}` },
  })
  const postId = mkEpisode({
    event: 'post-checkpoint',
    extra: {
      pre_checkpoint_ref: `episode:${preId}`,
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: `episode:${lId}` }],
        code_review: { status: 'done', reply_ref: `episode:${rId}` },
        e2e: { status: 'passed', log_ref: `episode:${eId}` },
        bug_logging: { status: 'done', issues: [] },
      },
    },
  })
  // rr with all chain refs coherent + episode-shaped plan_ref to the doc.
  const chain = { planId, preId, postId, logId: lId, reviewId: rId, e2eId: eId }
  mkReviewRequest({ chain, extra: { plan_ref: `episode:${planDocId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `legitimate episode-shaped plan_ref must pass; errors: ${JSON.stringify(r.json.errors)}`)
})

test('T102-23 review-request: rr.plan_ref as file/URL (free-form) PASSES', () => {
  // Regression guard: free-form plan_ref (file path or URL) is the most common
  // case per spec.
  const chain = mkBaseChainForReview()
  mkReviewRequest({ chain, extra: { plan_ref: 'docs/plan-with-different-text.md' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `free-form plan_ref must pass; errors: ${JSON.stringify(r.json.errors)}`)
})

test('T102-21 semantic-flip vs T58: chain-walk picks DIFFERENT rr than latest-by-timestamp would', () => {
  // Pre-#102 latest-by-timestamp would always pick the newest rr. Post-#102
  // chain-walk picks the rr identified as the gate's terminal. To exercise
  // the difference: build two rr's where the OLDER rr has valid refs and the
  // NEWER rr has invalid refs. T58b already locks "newer (terminal) wins" as
  // contract; this test confirms that under multi-rr selection, the terminal-
  // anchor identity is what gates, not "any chain that happens to validate."
  //
  // Setup: chain has plan/pre/post. Older rr is valid. Newer rr has bogus
  // post_checkpoint_ref. With pre-#102 latest-by-timestamp on multi-rr, newer
  // rr is terminal → fail. With post-#102 chain-walk, terminal = pickTerminal
  // (latest by timestamp under same conditions) → newer rr → fail. Both pass
  // the same test; behavior unchanged for this specific axis.
  //
  // The genuine semantic-flip happens when --head differentiates: build two
  // rr's at different heads, --head matching the OLDER one. Pre-#102 latest-
  // by-timestamp ignored --head for terminal selection. Post-#102 head-match
  // wins, so the older rr is terminal.
  const chain = mkBaseChainForReview()
  // Older rr at head=abc1234 (matches --head). Newer rr at differenthead.
  // Use mkReviewRequest to build the older one with default ctx.head abc1234.
  // Then build a newer rr at differenthead via direct mkEpisode.
  mkReviewRequest({ chain }) // older rr at default 12:00
  // Newer rr at later time, different head. Built directly to control time.
  counter++
  const newerId = `20260502-1300${String(counter).padStart(2, '0')}-rr-newer-${counter.toString(16).padStart(4, '0')}`
  const newerPayload = {
    event: 'review-request',
    pattern_id: 'bp-001-implementation-workflow',
    task: 'TEST',
    context: { worktree: tmpCwd, branch: 'main', head: 'differenthead' },
    plan_ref: 'p.md',
    approval_ref: `episode:${chain.planId}`,
    pre_checkpoint_ref: `episode:${chain.preId}`,
    post_checkpoint_ref: `episode:${chain.postId}`,
    evidence: {
      tests_ref: `episode:${chain.logId}`,
      code_review_ref: `episode:${chain.reviewId}`,
      bug_logging: { status: 'no-new-bugs' },
    },
  }
  const newerFm = `---\nid: ${newerId}\ndate: 2026-05-02\ntime: "13:00"\nproject: test\ncategory: workflow.lifecycle\nstatus: active\ntags: []\nsummary: rr newer differenthead\n---\n`
  const newerBody = `# x\n\n\`\`\`json\n${JSON.stringify(newerPayload)}\n\`\`\`\n`
  fs.writeFileSync(path.join(episodesDir, `${newerId}.md`), newerFm + '\n' + newerBody)
  fs.appendFileSync(indexFile, JSON.stringify({
    id: newerId, date: '2026-05-02', time: '13:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'newer rr',
  }) + '\n')
  // Run with --head abc1234. Post-#102 chain-walk picks the older rr (head match).
  const r = runValidate(['--task', 'TEST', '--gate', 'review-request', '--head', 'abc1234'])
  assert.strictEqual(r.json.valid, true, `older rr at matching --head must be terminal; errors: ${JSON.stringify(r.json.errors)}`)
  // The newer rr (differenthead) is out-of-chain.
  const newer = r.json.episodes.find(e => e.id === newerId)
  assert.strictEqual(newer.in_chain, false, 'newer rr at differenthead should NOT be terminal under --head=abc1234')
})

// ---------------------------------------------------------------------------
console.log('================================')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  failures.forEach(f => console.log(`  ✗ ${f.name}: ${f.error}`))
}

// Cleanup
fs.rmSync(tmpHome, { recursive: true, force: true })
fs.rmSync(tmpCwd, { recursive: true, force: true })

process.exit(failed === 0 ? 0 : 1)
