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
const dataDir = path.join(tmpHome, '.episodic-memory')
const episodesDir = path.join(dataDir, 'episodes')
const indexFile = path.join(dataDir, 'index.jsonl')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    // Reset between tests
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(episodesDir, { recursive: true })
    fs.writeFileSync(indexFile, '')
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
