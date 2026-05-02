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

test('T8 happy: post-checkpoint gate with full evidence', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'node tests/test-x.mjs', status: 'passed', log_ref: 'episode:test-log-id' }],
        code_review: { status: 'done', reply_ref: 'episode:review-id' },
        e2e: { status: 'passed', log_ref: 'episode:e2e-id' },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)} missing: ${JSON.stringify(r.json.missing)}`)
})

test('T9 evidence: empty tests array is rejected', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [],
        code_review: { status: 'done', reply_ref: 'episode:review-id' },
        e2e: { status: 'passed', log_ref: 'episode:e2e-id' },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('evidence.tests must be a non-empty array')))
})

test('T10 evidence: code_review.status=done without reply_ref is rejected', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: 'episode:l' }],
        code_review: { status: 'done', reply_ref: '' },
        e2e: { status: 'passed', log_ref: 'episode:e' },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  const r = runValidate(['--task', 'TEST', '--gate', 'post-checkpoint'])
  assert.strictEqual(r.json.valid, false)
  assert.ok(r.json.errors.some(e => e.includes('code_review.reply_ref')))
})

test('T11 push-allowed: requires post_checkpoint_ref pointing to actual episode', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  const postId = mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: 'episode:l' }],
        code_review: { status: 'done', reply_ref: 'episode:r' },
        e2e: { status: 'passed', log_ref: 'episode:e' },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: `episode:${postId}` } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed'])
  assert.strictEqual(r.json.valid, true, `errors: ${JSON.stringify(r.json.errors)}`)
})

test('T12 push-allowed: orphaned post_checkpoint_ref is rejected', () => {
  const planId = mkEpisode({ event: 'plan-approved', extra: { plan_ref: 'p.md' } })
  mkEpisode({ event: 'pre-checkpoint', extra: { plan_ref: 'p.md', approval_ref: `episode:${planId}` } })
  mkEpisode({
    event: 'post-checkpoint',
    extra: {
      evidence: {
        tests: [{ command: 'x', status: 'passed', log_ref: 'episode:l' }],
        code_review: { status: 'done', reply_ref: 'episode:r' },
        e2e: { status: 'passed', log_ref: 'episode:e' },
        bug_logging: { status: 'done', issues: [] }
      }
    }
  })
  mkEpisode({ event: 'push-allowed', extra: { post_checkpoint_ref: 'episode:bogus-id-12345' } })
  const r = runValidate(['--task', 'TEST', '--gate', 'push-allowed'])
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
