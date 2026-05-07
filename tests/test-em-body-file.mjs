#!/usr/bin/env node
/**
 * test-em-body-file.mjs — Tests for `--body-file` flag on em-store, em-revise,
 * em-violation. Permission-prompt step 3 fix (workplan v25 rank-28).
 *
 * Verifies:
 *   - happy path: file body equals --body body
 *   - missing file → JSON error
 *   - directory target → JSON error
 *   - empty file → JSON error
 *   - both --body and --body-file → JSON error
 *   - leading BOM stripped
 *   - exactly one trailing \n stripped, \r\n stripped, no other whitespace touched
 *   - em-violation: --body-file feeds bodyText, structuredBody built around it,
 *     subprocess invocation uses --body (never forwards --body-file)
 *
 * Usage: node tests/test-em-body-file.mjs
 * Zero deps — Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, spawnSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const REVISE = path.join(REPO, 'scripts', 'em-revise.mjs')
const VIOLATION = path.join(REPO, 'scripts', 'em-violation.mjs')

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-body-file-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  // Seed a patterns/_index.json so em-violation pattern check passes.
  const patternsDir = path.join(home, '.episodic-memory', 'patterns')
  fs.mkdirSync(patternsDir, { recursive: true })
  fs.writeFileSync(path.join(patternsDir, '_index.json'), JSON.stringify({
    patterns: [{ pattern_id: 'bp-test', name: 'Test pattern' }]
  }))
  return {
    root,
    home,
    cwd,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function runJSON(cmd, args, sandbox) {
  const r = spawnSync('node', [cmd, ...args], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
  })
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout.trim()) : null, stderr: r.stderr }
}

function readEpisodeBody(filePath) {
  // Strip frontmatter + leading "# summary\n\n"
  const raw = fs.readFileSync(filePath, 'utf8')
  const m = raw.match(/^---\n[\s\S]*?\n---\n\n# [^\n]*\n\n([\s\S]*)\n$/)
  if (!m) throw new Error(`could not parse body from ${filePath}`)
  return m[1]
}

// ---------------------------------------------------------------------------
// em-store
// ---------------------------------------------------------------------------
console.log('\n--- em-store ---')

test('happy path: --body-file body equals --body body', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'body.md')
    const body = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.'
    fs.writeFileSync(bodyFile, body)
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0, 'expected exit 0')
    assert.strictEqual(r.json.status, 'ok')
    assert.strictEqual(readEpisodeBody(r.json.file), body)
  } finally { sb.cleanup() }
})

test('missing file → JSON error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '/nonexistent/path.md',
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /cannot stat/)
  } finally { sb.cleanup() }
})

test('directory target → JSON error', () => {
  const sb = makeSandbox()
  try {
    const dir = path.join(sb.cwd, 'somedir')
    fs.mkdirSync(dir)
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', dir,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /not a regular file/)
  } finally { sb.cleanup() }
})

test('empty file → JSON error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'empty.md')
    fs.writeFileSync(bodyFile, '')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /is empty/)
  } finally { sb.cleanup() }
})

test('file containing only trailing newline → empty after strip → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'just-newline.md')
    fs.writeFileSync(bodyFile, '\n')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /is empty/)
  } finally { sb.cleanup() }
})

test('--body-file "" (empty argv value) → JSON error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '',
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /empty path argument/)
  } finally { sb.cleanup() }
})

test('both --body and --body-file → JSON error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'b.md')
    fs.writeFileSync(bodyFile, 'content')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body', 'inline', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /mutually exclusive/)
  } finally { sb.cleanup() }
})

test('leading BOM stripped', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'bom.md')
    fs.writeFileSync(bodyFile, '﻿body after BOM')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(readEpisodeBody(r.json.file), 'body after BOM')
  } finally { sb.cleanup() }
})

test('exactly one trailing \\n stripped (others preserved)', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'trailing.md')
    fs.writeFileSync(bodyFile, 'line1\n\n\n')  // 3 trailing \n
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    // 1 stripped → 2 remain inside body; em-store appends 1 final \n on write
    assert.strictEqual(readEpisodeBody(r.json.file), 'line1\n\n')
  } finally { sb.cleanup() }
})

test('trailing \\r\\n stripped', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'crlf.md')
    fs.writeFileSync(bodyFile, 'win-line\r\n')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(readEpisodeBody(r.json.file), 'win-line')
  } finally { sb.cleanup() }
})

test('leading whitespace preserved', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'lead.md')
    fs.writeFileSync(bodyFile, '   indented\nnext line')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(readEpisodeBody(r.json.file), '   indented\nnext line')
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// em-revise
// ---------------------------------------------------------------------------
console.log('\n--- em-revise ---')

test('em-revise --body-file happy path', () => {
  const sb = makeSandbox()
  try {
    // First store an original
    const orig = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 'orig', '--body', 'original body', '--scope', 'local',
    ], sb)
    assert.strictEqual(orig.json.status, 'ok')

    // Then revise via --body-file
    const bodyFile = path.join(sb.cwd, 'revision.md')
    const revBody = 'revised body\nwith multiple lines'
    fs.writeFileSync(bodyFile, revBody)
    const r = runJSON(REVISE, [
      '--original', orig.json.id, '--project', 'p', '--tags', 't',
      '--summary', 'rev', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.json.status, 'ok')
    // em-revise prepends "Revises: `<id>`\n\n" before body — verify body present
    const written = fs.readFileSync(r.json.file, 'utf8')
    assert.ok(written.includes(revBody), 'revised body should appear in file')
  } finally { sb.cleanup() }
})

test('em-revise --body and --body-file together → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'b.md')
    fs.writeFileSync(bodyFile, 'content')
    const r = runJSON(REVISE, [
      '--original', 'fake-id', '--project', 'p', '--tags', 't',
      '--summary', 's', '--body', 'inline', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /mutually exclusive/)
  } finally { sb.cleanup() }
})

test('em-revise --body-file missing → error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(REVISE, [
      '--original', 'fake-id', '--project', 'p', '--tags', 't',
      '--summary', 's', '--body-file', '/nonexistent.md',
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /cannot stat/)
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// em-violation
// ---------------------------------------------------------------------------
console.log('\n--- em-violation ---')

test('em-violation --body-file feeds bodyText, structuredBody built around it', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'what.md')
    const what = 'I skipped step 8 because I was tired.\nNot a good reason.'
    fs.writeFileSync(bodyFile, what)
    const r = runJSON(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 'skipped step 8',
      '--body-file', bodyFile,
      '--sequence', 'a,b,c', '--correct', 'a,b,c,d',
      '--project', 'p', '--scope', 'local',
    ], sb)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
    const written = fs.readFileSync(r.json.file, 'utf8')
    // Body should contain "## What happened\n\n<file content>" + sequence + correct
    assert.ok(written.includes('## What happened'), 'must include What happened')
    assert.ok(written.includes(what), 'must include file body content')
    assert.ok(written.includes('## Violation sequence\n\na,b,c'), 'must include sequence')
    assert.ok(written.includes('## Correct sequence\n\na,b,c,d'), 'must include correct')
  } finally { sb.cleanup() }
})

test('em-violation --body and --body-file together → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'b.md')
    fs.writeFileSync(bodyFile, 'content')
    const r = runJSON(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 's',
      '--body', 'inline', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /mutually exclusive/)
  } finally { sb.cleanup() }
})

test('em-violation --body-file empty file → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'empty.md')
    fs.writeFileSync(bodyFile, '')
    const r = runJSON(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /is empty/)
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('')
console.log('==================================================')
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log('==================================================')

if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
