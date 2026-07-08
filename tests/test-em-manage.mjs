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
import { spawnSync } from 'child_process'

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
