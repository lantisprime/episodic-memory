#!/usr/bin/env node
/**
 * test-em-manage.mjs — behavioral tests for the em-manage day-2 wizard.
 *
 * Drives the real wizard over piped stdin against an isolated HOME + non-git
 * cwd fixture store:
 *   - --help contract short-circuit (no store created)
 *   - immediate quit exits 0
 *   - EOF starvation (empty stdin) exits cleanly, never hangs
 *   - status flow runs doctor + stats and renders their summaries
 *   - hygiene rebuild-index runs against the fixture store
 *   - fold dry-run with declined apply leaves the store untouched
 *   - unknown menu choice is rejected and the loop continues
 *
 * Zero deps — Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import assert from 'assert'
import { spawn, spawnSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const MANAGE = path.join(REPO, 'scripts', 'em-manage.mjs')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-manage-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  return { root, home, cwd, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

function runWizard(sandbox, input) {
  return spawnSync(process.execPath, [MANAGE], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    input,
    encoding: 'utf8',
    timeout: 60000,
  })
}

function seedEpisodes(sandbox, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'em-store.mjs'),
      '--project', 'manage-fixture', '--category', 'decision', '--scope', 'local',
      '--summary', `fixture decision ${i}`, '--body', `fixture body ${i}`], {
      cwd: sandbox.cwd, env: { ...process.env, HOME: sandbox.home }, encoding: 'utf8',
    })
    ids.push(JSON.parse(r.stdout.trim()).id)
  }
  return ids
}

function episodeFiles(sandbox) {
  const dir = path.join(sandbox.cwd, '.episodic-memory', 'episodes')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort()
}

console.log('--help contract:')
test('em-manage.mjs --help short-circuits, exit 0, no store', () => {
  const s = makeSandbox()
  try {
    const h = spawnSync(process.execPath, [MANAGE, '--help'], {
      cwd: s.cwd, env: { ...process.env, HOME: s.home }, encoding: 'utf8',
    })
    assert.strictEqual(h.status, 0)
    const json = JSON.parse(h.stdout.trim())
    assert.deepStrictEqual(Object.keys(json).sort(), ['script', 'status', 'usage'])
    assert.strictEqual(json.status, 'help')
    assert.strictEqual(json.script, 'em-manage.mjs')
    assert.strictEqual(fs.existsSync(path.join(s.cwd, '.episodic-memory')), false, 'help created a store')
  } finally { s.cleanup() }
})

console.log('menu loop:')
test('immediate quit exits 0', () => {
  const s = makeSandbox()
  try {
    const r = runWizard(s, 'q\n')
    assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`)
    assert.ok(r.stdout.includes('episodic-memory manager'), 'banner missing')
  } finally { s.cleanup() }
})

test('EOF starvation (empty stdin) exits cleanly, never hangs', () => {
  const s = makeSandbox()
  try {
    const r = runWizard(s, '')
    assert.notStrictEqual(r.status, null, 'wizard timed out on empty stdin')
    assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`)
  } finally { s.cleanup() }
})

test('unknown menu choice is rejected and the loop continues to quit', () => {
  const s = makeSandbox()
  try {
    const r = runWizard(s, 'zz\nq\n')
    assert.strictEqual(r.status, 0)
    assert.ok(r.stdout.includes('unknown choice'), 'no rejection message')
  } finally { s.cleanup() }
})

console.log('status flow:')
test('status runs doctor + stats and renders summaries', () => {
  const s = makeSandbox()
  try {
    seedEpisodes(s, 1)
    // 1 = status, n = not all-projects, n = no raw JSON, q = quit
    const r = runWizard(s, '1\nn\nn\nq\n')
    assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`)
    assert.ok(/doctor: /.test(r.stdout), `doctor summary missing:\n${r.stdout}`)
    assert.ok(/stats:/.test(r.stdout), 'stats summary missing')
    assert.ok(/active=\d/.test(r.stdout), `scope lines missing real counts:\n${r.stdout}`)
  } finally { s.cleanup() }
})

console.log('hygiene flows:')
test('rebuild-index runs against the fixture store', () => {
  const s = makeSandbox()
  try {
    seedEpisodes(s, 1)
    // 2 = hygiene, 1 = rebuild-index, q = quit
    const r = runWizard(s, '2\n1\nq\n')
    assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`)
    assert.ok(/rebuild-index: ok/.test(r.stdout), `rebuild result missing:\n${r.stdout}`)
  } finally { s.cleanup() }
})

test('fold dry-run with declined apply leaves the store untouched', () => {
  const s = makeSandbox()
  try {
    seedEpisodes(s, 2)
    const before = episodeFiles(s)
    // 2 = hygiene, 2 = fold, local scope (default), n = decline apply, q = quit
    const r = runWizard(s, '2\n2\n\nn\nq\n')
    assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`)
    assert.ok(/dry-run/.test(r.stdout), 'no dry-run output')
    assert.deepStrictEqual(episodeFiles(s), before, 'store changed on declined apply')
  } finally { s.cleanup() }
})

console.log('TOCTOU guard:')
await (async function toctouTest() {
  const name = 'store mutation between fold preview and apply forces re-confirmation (codex R1-3)'
  const s = makeSandbox()
  const wiz = spawn(process.execPath, [MANAGE], {
    cwd: s.cwd, env: { ...process.env, HOME: s.home }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    // Build a long supersedes chain so the fold dry-run has something to say.
    const first = seedEpisodes(s, 1)[0]
    let prev = first
    for (let i = 0; i < 11; i++) {
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'em-revise.mjs'),
        '--original', prev, '--project', 'manage-fixture',
        '--summary', `rev ${i}`, '--body', `rev body ${i}`], {
        cwd: s.cwd, env: { ...process.env, HOME: s.home }, encoding: 'utf8',
      })
      prev = JSON.parse(r.stdout.trim()).id
    }

    let out = ''
    wiz.stdout.on('data', (c) => { out += c })
    // Occurrence-count waits: prompts can arrive in the same chunk as the
    // message before them, so position markers race — counts don't.
    const countOf = (re) => (out.match(re) || []).length
    const waitForCount = (re, n) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${n}x ${re}; output:\n${out}`)), 30000)
      const check = () => {
        if (countOf(re) >= n) { clearTimeout(t); resolve() }
        else setTimeout(check, 100)
      }
      check()
    })
    const APPLY_RE = /Apply fold-superseded\? \[y\/N\]/g

    wiz.stdin.write('2\n2\n\n') // hygiene → fold → scope local (default)
    await waitForCount(APPLY_RE, 1)
    // Mutate the store BETWEEN preview and consent: a second long chain.
    const second = seedEpisodes(s, 1)[0]
    let p2 = second
    for (let i = 0; i < 11; i++) {
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'em-revise.mjs'),
        '--original', p2, '--project', 'manage-fixture',
        '--summary', `b rev ${i}`, '--body', `b rev body ${i}`], {
        cwd: s.cwd, env: { ...process.env, HOME: s.home }, encoding: 'utf8',
      })
      p2 = JSON.parse(r.stdout.trim()).id
    }
    const filesAfterMutation = episodeFiles(s)
    wiz.stdin.write('y\n') // consent to the STALE preview
    await waitForCount(/store changed since the preview/g, 1)
    await waitForCount(APPLY_RE, 2) // the refreshed preview must re-ask
    wiz.stdin.write('n\nq\n') // decline the refreshed preview, quit
    const code = await new Promise((r) => wiz.on('exit', r))
    assert.strictEqual(code, 0, `exit ${code}; output:\n${out}`)
    assert.deepStrictEqual(episodeFiles(s), filesAfterMutation, 'stale consent applied a fold')
    passed++
    console.log(`  ok ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  FAIL ${name}: ${e.message}`)
  } finally {
    wiz.kill()
    s.cleanup()
  }
})()

console.log('console launcher:')
test('option 6 under piped stdin refuses instead of blocking (F3 regression)', () => {
  const s = makeSandbox()
  try {
    const r = runWizard(s, '6\nq\n')
    assert.notStrictEqual(r.status, null, 'wizard hung on console launch under piped stdin')
    assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`)
    assert.ok(/interactive terminal/.test(r.stdout), `no refusal message:\n${r.stdout}`)
  } finally { s.cleanup() }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
