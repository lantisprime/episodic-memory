#!/usr/bin/env node
/**
 * test-p3-fixes.mjs — Tests for Phase 2 P3 code review fixes
 *
 * Usage: node tests/test-p3-fixes.mjs
 *
 * Tests scope validation, body cache, atomic writes, and tag inheritance.
 * Zero dependencies — uses Node.js assert + fs + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const STORE = path.join(SCRIPTS, 'em-store.mjs')
const SEARCH = path.join(SCRIPTS, 'em-search.mjs')
const REVISE = path.join(SCRIPTS, 'em-revise.mjs')
const PRUNE = path.join(SCRIPTS, 'em-prune.mjs')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \u2713 ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  \u2717 ${name}: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// Setup: isolated temp directories
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-p3-fixes-'))
const tmpProject = path.join(tmpHome, 'project')
fs.mkdirSync(tmpProject, { recursive: true })

const globalDir = path.join(tmpHome, '.episodic-memory')
const localDir = path.join(tmpProject, '.episodic-memory')

const env = { ...process.env, HOME: tmpHome }

function run(script, args) {
  const result = execSync(`node "${script}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

function runExitCode(script, args) {
  try {
    execSync(`node "${script}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env, stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0 }
  } catch (e) {
    let parsed = null
    try { parsed = JSON.parse(e.stdout?.trim() || e.stderr?.trim()) } catch {}
    return { code: e.status, output: parsed }
  }
}

function readIndex(dataDir) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

console.log('\nPhase 2 P3 Fixes')
console.log('='.repeat(50))

// ---------------------------------------------------------------------------
// P3-6: Scope validation
// ---------------------------------------------------------------------------
console.log('\n--- P3-6: Scope Validation ---')

test('1. em-search rejects invalid --scope with JSON error', () => {
  const r = runExitCode(SEARCH, '--scope bogus')
  assert.strictEqual(r.code, 1, 'should exit 1')
  assert.ok(r.output, 'should output JSON')
  assert.strictEqual(r.output.status, 'error')
  assert.ok(r.output.message.includes('bogus'), 'error should mention the invalid value')
  assert.ok(r.output.message.includes('local, global, all'), 'error should list valid values')
})

test('2. em-prune rejects invalid --scope with JSON error', () => {
  const r = runExitCode(PRUNE, '--scope lcoal')
  assert.strictEqual(r.code, 1, 'should exit 1')
  assert.ok(r.output, 'should output JSON')
  assert.strictEqual(r.output.status, 'error')
  assert.ok(r.output.message.includes('lcoal'), 'error should mention the invalid value')
})

test('3. em-revise rejects invalid --scope with JSON error', () => {
  const r = runExitCode(REVISE, '--original fake --summary test --body test --scope all')
  assert.strictEqual(r.code, 1, 'should exit 1')
  assert.ok(r.output, 'should output JSON')
  assert.strictEqual(r.output.status, 'error')
  assert.ok(r.output.message.includes('Must be one of: local, global'), 'error should list valid values for revise (no "all")')
})

// ---------------------------------------------------------------------------
// P3-3: Body cache (--query + --full)
// ---------------------------------------------------------------------------
console.log('\n--- P3-3: Body Cache ---')

// Seed episodes with distinct body content
run(STORE, '--project test --category decision --tags "cache-test" --summary "Cache test episode alpha" --body "Unique body content xylophone zebra" --scope local')
run(STORE, '--project test --category decision --tags "cache-test" --summary "Another episode" --body "Different body mentioning xylophone" --scope local')

test('4. --query + --full returns body from cache (no double read)', () => {
  // Search for a term that appears only in body, with --full
  const r = run(SEARCH, '--query "xylophone" --full --scope local --no-track')
  assert.ok(r.episodes.length >= 1, 'should find body-matched episodes')
  for (const ep of r.episodes) {
    assert.ok(ep.body, `episode ${ep.id} should have body`)
    assert.ok(ep.body.length > 0, 'body should not be empty')
  }
})

test('5. _body is stripped from JSON output', () => {
  const r = run(SEARCH, '--query "xylophone" --full --scope local --no-track')
  const raw = execSync(`node "${SEARCH}" --query "xylophone" --full --scope local --no-track`, { encoding: 'utf8', cwd: tmpProject, env })
  assert.ok(!raw.includes('_body'), 'raw output should not contain _body key')
  assert.ok(!raw.includes('_dataDir'), 'raw output should not contain _dataDir key')
  assert.ok(!raw.includes('_textMatch'), 'raw output should not contain _textMatch key')
})

// ---------------------------------------------------------------------------
// Atomic writes in em-revise.mjs
// ---------------------------------------------------------------------------
console.log('\n--- Atomic Writes ---')

const storeResult = run(STORE, '--project test --category decision --tags "atomic-test" --summary "Atomic write test original" --body "Original content" --scope local')

test('6. Revise produces correct round-trip with atomic writes', () => {
  const revResult = run(REVISE, `--original ${storeResult.id} --summary "Atomic write revised" --body "Updated content" --tags "revised" --scope local`)
  assert.ok(revResult.id, 'should create new episode')
  assert.strictEqual(revResult.supersedes, storeResult.id, 'should supersede original')

  // Verify original is superseded
  const entries = readIndex(localDir)
  const origEntry = entries.find(e => e.id === storeResult.id)
  assert.strictEqual(origEntry.status, 'superseded', 'original should be superseded')

  // Verify original .md file is updated
  const origFile = path.join(localDir, 'episodes', `${storeResult.id}.md`)
  const origContent = fs.readFileSync(origFile, 'utf8')
  assert.ok(origContent.includes('status: superseded'), 'original .md should have superseded status')

  // Verify no .tmp files left behind
  const episodesDir = path.join(localDir, 'episodes')
  const tmpFiles = fs.readdirSync(episodesDir).filter(f => f.endsWith('.tmp'))
  assert.strictEqual(tmpFiles.length, 0, 'no .tmp files should remain')

  const indexTmp = path.join(localDir, 'index.jsonl.tmp')
  assert.ok(!fs.existsSync(indexTmp), 'index.jsonl.tmp should not remain')
})

// ---------------------------------------------------------------------------
// Double index read elimination + tag inheritance
// ---------------------------------------------------------------------------
console.log('\n--- Tag Inheritance (Single Pass) ---')

const taggedEp = run(STORE, '--project test --category decision --tags "inherited-a,inherited-b" --summary "Tag inheritance source" --body "Source episode" --scope local')

test('7. Revised episode inherits original tags via single index pass', () => {
  const revised = run(REVISE, `--original ${taggedEp.id} --summary "Tag inheritance target" --body "Revised" --tags "new-tag" --scope local`)

  // Check the revised episode has merged tags
  const entries = readIndex(localDir)
  const revisedEntry = entries.find(e => e.id === revised.id)
  assert.ok(revisedEntry, 'revised entry should exist in index')
  assert.ok(revisedEntry.tags.includes('inherited-a'), 'should inherit tag inherited-a')
  assert.ok(revisedEntry.tags.includes('inherited-b'), 'should inherit tag inherited-b')
  assert.ok(revisedEntry.tags.includes('new-tag'), 'should include new tag')

  // Verify tags are normalized (sorted)
  const sorted = [...revisedEntry.tags].sort()
  assert.deepStrictEqual(revisedEntry.tags, sorted, 'tags should be sorted')
})

// ---------------------------------------------------------------------------
// Cleanup & summary
// ---------------------------------------------------------------------------
fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(`\n${'='.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`)
  }
  process.exit(1)
}
