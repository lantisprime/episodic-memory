#!/usr/bin/env node
/**
 * test-seed-patterns.mjs — Unit tests for em-seed-patterns.mjs
 *
 * Usage: node tests/test-seed-patterns.mjs
 *
 * Tests the seed script against a temporary data directory.
 * Zero dependencies — uses Node.js assert + fs + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'em-seed-patterns.mjs')

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

function run(args = '') {
  const result = execSync(`node "${SCRIPT}" ${args}`, { encoding: 'utf8', env: { ...process.env, HOME: tmpHome } })
  return JSON.parse(result.trim())
}

// ---------------------------------------------------------------------------
// Setup: temp home dir with isolated .episodic-memory
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-test-'))
const tmpGlobalDir = path.join(tmpHome, '.episodic-memory')
const tmpEpisodesDir = path.join(tmpGlobalDir, 'episodes')
fs.mkdirSync(tmpEpisodesDir, { recursive: true })

// Create a test patterns directory
const tmpPatternsDir = path.join(tmpHome, 'patterns')
fs.mkdirSync(tmpPatternsDir, { recursive: true })

// Write test pattern files
fs.writeFileSync(path.join(tmpPatternsDir, '_index.json'), JSON.stringify({
  patterns: [
    { pattern_id: 'test-bp-001', file: 'test-pattern-1.md', name: 'Test Pattern 1', tags: ['behavioral-pattern', 'test-bp-001'], scope: 'global', version: '1.0.0' },
    { pattern_id: 'test-bp-002', file: 'test-pattern-2.md', name: 'Test Pattern 2', tags: ['behavioral-pattern', 'test-bp-002'], scope: 'global', version: '1.0.0' }
  ]
}, null, 2))

fs.writeFileSync(path.join(tmpPatternsDir, 'test-pattern-1.md'), `---
pattern_id: test-bp-001
name: "Test Pattern 1"
category: decision
tags: [behavioral-pattern, test-bp-001, testing]
scope: global
version: 1.0.0
---

# Test Pattern 1

This is a test behavioral pattern.
`)

fs.writeFileSync(path.join(tmpPatternsDir, 'test-pattern-2.md'), `---
pattern_id: test-bp-002
name: "Test Pattern 2"
category: discovery
tags: [behavioral-pattern, test-bp-002, testing]
scope: global
version: 1.0.0
---

# Test Pattern 2

This is another test behavioral pattern.
`)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('\n=== em-seed-patterns.mjs unit tests ===\n')

console.log('Dry-run mode:')

test('dry-run seeds nothing, reports count', () => {
  const result = run(`--dir "${tmpPatternsDir}" --dry-run`)
  assert.strictEqual(result.status, 'ok')
  assert.strictEqual(result.seeded, 2)
  assert.strictEqual(result.skipped, 0)
  assert.strictEqual(result.total, 2)
  assert.strictEqual(result.dry_run, true)
})

test('dry-run creates no episode files', () => {
  const files = fs.readdirSync(tmpEpisodesDir)
  assert.strictEqual(files.length, 0, `Expected 0 files, got ${files.length}`)
})

console.log('\nFirst seed:')

test('seeds 2 patterns on first run', () => {
  const result = run(`--dir "${tmpPatternsDir}"`)
  assert.strictEqual(result.status, 'ok')
  assert.strictEqual(result.seeded, 2)
  assert.strictEqual(result.skipped, 0)
  assert.strictEqual(result.total, 2)
})

test('creates 2 episode files', () => {
  const files = fs.readdirSync(tmpEpisodesDir).filter(f => f.endsWith('.md'))
  assert.strictEqual(files.length, 2, `Expected 2 files, got ${files.length}`)
})

test('creates index.jsonl with 2 entries', () => {
  const indexFile = path.join(tmpGlobalDir, 'index.jsonl')
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 2)
})

test('creates tags.json with pattern_id tags', () => {
  const tagsFile = path.join(tmpGlobalDir, 'tags.json')
  const tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  assert.ok(tags['test-bp-001'], 'test-bp-001 tag missing')
  assert.ok(tags['test-bp-002'], 'test-bp-002 tag missing')
  assert.ok(tags['behavioral-pattern'], 'behavioral-pattern tag missing')
  assert.strictEqual(tags['behavioral-pattern'].length, 2)
})

test('episode frontmatter has correct fields', () => {
  const files = fs.readdirSync(tmpEpisodesDir).filter(f => f.endsWith('.md'))
  const content = fs.readFileSync(path.join(tmpEpisodesDir, files[0]), 'utf8')
  assert.ok(content.includes('category: decision') || content.includes('category: discovery'), 'Missing category')
  assert.ok(content.includes('status: active'), 'Missing status')
  assert.ok(content.includes('project: global'), 'Missing project')
  assert.ok(content.includes('behavioral-pattern'), 'Missing behavioral-pattern tag')
})

test('episode body contains pattern content', () => {
  const files = fs.readdirSync(tmpEpisodesDir).filter(f => f.endsWith('.md'))
  const content = fs.readFileSync(path.join(tmpEpisodesDir, files[0]), 'utf8')
  assert.ok(content.includes('test behavioral pattern'), 'Body content missing')
})

console.log('\nIdempotency:')

test('second run skips all patterns', () => {
  const result = run(`--dir "${tmpPatternsDir}"`)
  assert.strictEqual(result.seeded, 0)
  assert.strictEqual(result.skipped, 2)
  assert.strictEqual(result.total, 2)
})

test('no duplicate episode files after second run', () => {
  const files = fs.readdirSync(tmpEpisodesDir).filter(f => f.endsWith('.md'))
  assert.strictEqual(files.length, 2)
})

test('no duplicate index.jsonl entries after second run', () => {
  const indexFile = path.join(tmpGlobalDir, 'index.jsonl')
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 2)
})

console.log('\nError handling:')

test('missing _index.json returns error', () => {
  try {
    run(`--dir /tmp/nonexistent-${Date.now()}`)
    assert.fail('Should have thrown')
  } catch (e) {
    assert.ok(e.message.includes('status') || e.status === 1, 'Should exit with error')
  }
})

test('missing pattern file is skipped gracefully', () => {
  const tmpDir2 = path.join(tmpHome, 'patterns-missing')
  fs.mkdirSync(tmpDir2, { recursive: true })
  fs.writeFileSync(path.join(tmpDir2, '_index.json'), JSON.stringify({
    patterns: [{ pattern_id: 'bp-missing', file: 'does-not-exist.md', name: 'Missing', tags: ['behavioral-pattern'], scope: 'global', version: '1.0.0' }]
  }))
  const result = run(`--dir "${tmpDir2}"`)
  assert.strictEqual(result.seeded, 0)
  assert.strictEqual(result.skipped, 1)
})

test('invalid frontmatter is skipped gracefully', () => {
  const tmpDir3 = path.join(tmpHome, 'patterns-bad-fm')
  fs.mkdirSync(tmpDir3, { recursive: true })
  fs.writeFileSync(path.join(tmpDir3, '_index.json'), JSON.stringify({
    patterns: [{ pattern_id: 'bp-bad', file: 'bad.md', name: 'Bad', tags: ['behavioral-pattern'], scope: 'global', version: '1.0.0' }]
  }))
  fs.writeFileSync(path.join(tmpDir3, 'bad.md'), 'no frontmatter here, just text')
  const result = run(`--dir "${tmpDir3}"`)
  assert.strictEqual(result.seeded, 0)
  assert.strictEqual(result.skipped, 1)
})

console.log('\nTag normalization:')

test('tags are normalized (lowercase, sorted, deduped)', () => {
  const tagsFile = path.join(tmpGlobalDir, 'tags.json')
  const tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  const allKeys = Object.keys(tags)
  const hasUpperCase = allKeys.some(k => k !== k.toLowerCase())
  assert.ok(!hasUpperCase, `Found uppercase tags: ${allKeys.filter(k => k !== k.toLowerCase())}`)
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(tmpHome, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
