#!/usr/bin/env node
/**
 * test-em-store-tag-flags.mjs — Regression tests for --tag / --tags flag forms
 * on em-store.mjs and em-revise.mjs.
 *
 * Bug context (workplan v62, #272 follow-up): the CLI's flag() helper returns
 * the *first* occurrence of a repeated flag and silently drops subsequent
 * `--tag X --tag Y` invocations. Users (and global lessons emitted via shell
 * scripts) frequently expect repeated `--tag` to accumulate. Fix adds a
 * flagAll() helper that collects every occurrence; this test pins the
 * behavior.
 *
 * Cases:
 *   - --tags a,b               → [a, b]
 *   - --tag a --tag b          → [a, b]
 *   - --tags a,b --tag c       → [a, b, c]
 *   - --tag a --tag a          → [a]                (dedup)
 *   - --tag A --tag b          → [a, b]             (lowercase normalization)
 *   - --tag c --tag a --tag b  → [a, b, c]          (sorted output)
 *   - em-revise --tag x --tag y inherits original tags + merges with repeats
 *
 * Usage: node tests/test-em-store-tag-flags.mjs
 * Zero deps — Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const REVISE = path.join(REPO, 'scripts', 'em-revise.mjs')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-tag-flags-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  return {
    root, home, cwd,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function runJSON(script, args, sandbox) {
  const r = spawnSync('node', [script, ...args], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
  })
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout.trim()) : null, stderr: r.stderr }
}

function readTags(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const m = raw.match(/^tags: \[(.*)\]$/m)
  if (!m) throw new Error(`no tags frontmatter in ${filePath}`)
  return m[1].split(',').map(s => s.trim()).filter(Boolean)
}

function storeAndReadTags(sandbox, tagArgs) {
  const result = runJSON(STORE, [
    '--project', 'test-tag-flags',
    '--category', 'decision',
    ...tagArgs,
    '--summary', 'tag flag test',
    '--body', 'body',
    '--scope', 'global',
  ], sandbox)
  assert.strictEqual(result.code, 0, `em-store failed: ${result.stderr}\n${JSON.stringify(result.json)}`)
  return readTags(result.json.file)
}

// ---------------------------------------------------------------------------
// em-store cases
// ---------------------------------------------------------------------------

console.log('em-store --tag / --tags cases:')

test('--tags comma form unchanged', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, ['--tags', 'a,b']), ['a', 'b'])
  } finally { s.cleanup() }
})

test('--tag repeated form accumulates', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, ['--tag', 'a', '--tag', 'b']), ['a', 'b'])
  } finally { s.cleanup() }
})

test('mixed --tags + --tag merges', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, ['--tags', 'a,b', '--tag', 'c']), ['a', 'b', 'c'])
  } finally { s.cleanup() }
})

test('repeated --tag dedups identical values', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, ['--tag', 'a', '--tag', 'a']), ['a'])
  } finally { s.cleanup() }
})

test('--tag lowercase-normalizes', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, ['--tag', 'A', '--tag', 'b']), ['a', 'b'])
  } finally { s.cleanup() }
})

test('--tag output is sorted', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, ['--tag', 'c', '--tag', 'a', '--tag', 'b']), ['a', 'b', 'c'])
  } finally { s.cleanup() }
})

test('no tag flags → empty tag set', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, []), [])
  } finally { s.cleanup() }
})

test('trailing --tag with no value is ignored (no crash)', () => {
  const s = makeSandbox()
  try {
    assert.deepStrictEqual(storeAndReadTags(s, ['--tag', 'a', '--tag']), ['a'])
  } finally { s.cleanup() }
})

test('tags.json updated with all repeated tags', () => {
  const s = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'test-tag-flags',
      '--category', 'decision',
      '--tag', 'alpha', '--tag', 'beta', '--tag', 'gamma',
      '--summary', 'tag-index test',
      '--body', 'body',
      '--scope', 'global',
    ], s)
    assert.strictEqual(r.code, 0)
    const tagsIndex = JSON.parse(fs.readFileSync(path.join(s.home, '.episodic-memory', 'tags.json'), 'utf8'))
    assert.ok(tagsIndex.alpha?.includes(r.json.id), 'alpha tag missing from index')
    assert.ok(tagsIndex.beta?.includes(r.json.id), 'beta tag missing from index')
    assert.ok(tagsIndex.gamma?.includes(r.json.id), 'gamma tag missing from index')
  } finally { s.cleanup() }
})

// ---------------------------------------------------------------------------
// em-revise cases (same-class completeness)
// ---------------------------------------------------------------------------

console.log('em-revise --tag / --tags cases:')

function seedOriginal(sandbox, tags) {
  const r = runJSON(STORE, [
    '--project', 'test-tag-flags',
    '--category', 'decision',
    ...tags.flatMap(t => ['--tag', t]),
    '--summary', 'original',
    '--body', 'original body',
    '--scope', 'global',
  ], sandbox)
  assert.strictEqual(r.code, 0, `seed failed: ${r.stderr}`)
  return r.json
}

test('em-revise --tag repeated merges with original tags', () => {
  const s = makeSandbox()
  try {
    const orig = seedOriginal(s, ['x', 'y'])
    const r = runJSON(REVISE, [
      '--original', orig.id,
      '--project', 'test-tag-flags',
      '--tag', 'z', '--tag', 'w',
      '--summary', 'revised',
      '--body', 'revised body',
      '--scope', 'global',
    ], s)
    assert.strictEqual(r.code, 0, `em-revise failed: ${r.stderr}`)
    assert.deepStrictEqual(readTags(r.json.file), ['w', 'x', 'y', 'z'])
  } finally { s.cleanup() }
})

test('em-revise mixed --tags + --tag merges with original tags', () => {
  const s = makeSandbox()
  try {
    const orig = seedOriginal(s, ['x'])
    const r = runJSON(REVISE, [
      '--original', orig.id,
      '--project', 'test-tag-flags',
      '--tags', 'y,z', '--tag', 'q',
      '--summary', 'revised',
      '--body', 'revised body',
      '--scope', 'global',
    ], s)
    assert.strictEqual(r.code, 0)
    assert.deepStrictEqual(readTags(r.json.file), ['q', 'x', 'y', 'z'])
  } finally { s.cleanup() }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log()
console.log(`Tests: ${passed + failed}  passed: ${passed}  failed: ${failed}`)
if (failed > 0) {
  console.log()
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}\n    ${f.error}`)
  process.exit(1)
}
