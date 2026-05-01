#!/usr/bin/env node
/**
 * test-rfc002-phase1.mjs — Tests for RFC-002 Phase 1: Violation Tracking
 *
 * Usage: node tests/test-rfc002-phase1.mjs
 *
 * Tests violation storage, pattern validation, auto-tagging, structured body,
 * search round-trip, and session-end prompt.
 * Zero dependencies — uses Node.js assert + fs + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const STORE = path.join(SCRIPTS, 'em-store.mjs')
const VIOLATION = path.join(SCRIPTS, 'em-violation.mjs')
const SEARCH = path.join(SCRIPTS, 'em-search.mjs')
const REBUILD = path.join(SCRIPTS, 'em-rebuild-index.mjs')
const SESSION_END = path.join(SCRIPTS, 'em-session-end-prompt.mjs')

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

// ---------------------------------------------------------------------------
// Setup: isolated temp directories
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-rfc002-p1-'))
const tmpProject = path.join(tmpHome, 'project')
fs.mkdirSync(tmpProject, { recursive: true })

const globalDir = path.join(tmpHome, '.episodic-memory')
const localDir = path.join(tmpProject, '.episodic-memory')

const env = { ...process.env, HOME: tmpHome }

// Copy patterns/_index.json to project dir for validation
const patternsDir = path.join(tmpProject, 'patterns')
fs.mkdirSync(patternsDir, { recursive: true })
const srcIndex = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'patterns', '_index.json')
fs.copyFileSync(srcIndex, path.join(patternsDir, '_index.json'))

function store(args) {
  const result = execSync(`node "${STORE}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

function violation(args) {
  const result = execSync(`node "${VIOLATION}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

function violationFail(args) {
  try {
    execSync(`node "${VIOLATION}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env, stdio: ['pipe', 'pipe', 'pipe'] })
    return null // should have failed
  } catch (e) {
    return e.stdout ? JSON.parse(e.stdout.trim()) : null
  }
}

function search(args) {
  const result = execSync(`node "${SEARCH}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

function rebuild(args = '') {
  return execSync(`node "${REBUILD}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
}

function sessionEnd() {
  const result = execSync(`node "${SESSION_END}"`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

// ===========================================================================
console.log('\n--- RFC Acceptance Tests ---')
// ===========================================================================

test('1. violation category accepted by em-store.mjs', () => {
  const r = store('--project test --category violation --tags "test" --summary "test violation" --body "test body"')
  assert.strictEqual(r.status, 'ok')
  assert.ok(r.id)
})

test('2. em-violation.mjs stores structured violation with violated:<pattern_id> tag', () => {
  const r = violation('--pattern bp-001-implementation-workflow --summary "Skipped checkpoints" --body "Did not print pre-implementation checkpoint"')
  assert.strictEqual(r.status, 'ok')
  assert.strictEqual(r.violated_pattern, 'bp-001-implementation-workflow')
  assert.ok(r.id)
  assert.ok(r.file)
})

test('3. em-violation.mjs validates pattern exists in _index.json', () => {
  // Valid pattern should succeed (already tested in test 2)
  // This test verifies the validation mechanism itself
  const r = violation('--pattern bp-006-push-after-verify --summary "Pushed without tests" --body "Pushed before running test suite"')
  assert.strictEqual(r.status, 'ok')
  assert.strictEqual(r.violated_pattern, 'bp-006-push-after-verify')
})

test('4. em-violation.mjs rejects unknown pattern_id with error listing known patterns', () => {
  const r = violationFail('--pattern bp-999-nonexistent --summary "test" --body "test"')
  assert.ok(r, 'Should have returned error output')
  assert.strictEqual(r.status, 'error')
  assert.ok(r.message.includes('bp-999-nonexistent'), 'Error should mention the invalid pattern')
  assert.ok(r.known_patterns, 'Should include known_patterns array')
  assert.ok(r.known_patterns.includes('bp-001-implementation-workflow'), 'Should list bp-001')
})

test('5. em-violation.mjs auto-tags with violation, behavioral-pattern, violated:<pattern_id>', () => {
  // Search for the violation stored in test 2
  const r = search('--category violation --tag "violated:bp-001-implementation-workflow" --limit 10')
  assert.ok(r.count > 0, 'Should find at least one violation')
  const ep = r.episodes[0]
  assert.ok(ep.tags.includes('violation'), 'Should have violation tag')
  assert.ok(ep.tags.includes('behavioral-pattern'), 'Should have behavioral-pattern tag')
  assert.ok(ep.tags.some(t => t.startsWith('violated:')), 'Should have violated: tag')
})

test('6. Violation episodes searchable by --category violation', () => {
  const r = search('--category violation --limit 20')
  assert.ok(r.count >= 2, 'Should find violations stored in earlier tests')
  for (const ep of r.episodes) {
    assert.strictEqual(ep.category, 'violation')
  }
})

test('7. Violation episodes searchable by --tag violated:<pattern_id>', () => {
  const r = search('--tag "violated:bp-006-push-after-verify" --limit 10')
  assert.ok(r.count > 0, 'Should find bp-006 violation')
  assert.ok(r.episodes[0].tags.some(t => t.includes('bp-006')), 'Should match bp-006')
})

test('8. bp-009 updated to reference em-violation.mjs', () => {
  // This is a documentation test — verify the file references em-violation.mjs
  const bp009 = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'patterns', 'store-violations-as-evidence.md'), 'utf8')
  assert.ok(bp009.includes('em-violation.mjs'), 'bp-009 should reference em-violation.mjs')
})

test('9. em-session-end-prompt.mjs outputs valid JSON with prompt + known patterns', () => {
  const r = sessionEnd()
  assert.ok(r.prompt, 'Should have prompt field')
  assert.ok(r.prompt.includes('violated'), 'Prompt should ask about violations')
  assert.ok(Array.isArray(r.known_patterns), 'Should have known_patterns array')
  assert.ok(r.known_patterns.length > 0, 'Should list at least one pattern')
  assert.ok(r.known_patterns[0].pattern_id, 'Each pattern should have pattern_id')
  assert.ok(r.known_patterns[0].name, 'Each pattern should have name')
})

// ===========================================================================
console.log('\n--- Additional Tests (from 2nd opinion) ---')
// ===========================================================================

test('10. violated: tag round-trip through store → rebuild → search', () => {
  // Rebuild index to ensure tags.json is fresh
  rebuild('--scope all')
  // Search by the violated: tag
  const r = search('--tag "violated:bp-001-implementation-workflow" --limit 10')
  assert.ok(r.count > 0, 'Should find violation after rebuild')
  const ep = r.episodes[0]
  assert.ok(ep.tags.some(t => t === 'violated:bp-001-implementation-workflow'), 'Exact tag should survive round-trip')
})

test('11. Extra --tags appended to auto-tags', () => {
  const r = violation('--pattern bp-010-habits-override-knowledge --summary "Extra tags test" --body "Testing extra tags" --tags "session-3,urgent"')
  assert.strictEqual(r.status, 'ok')
  // Search and verify all tags present
  const s = search('--tag "urgent" --limit 5')
  assert.ok(s.count > 0, 'Should find by extra tag')
  const ep = s.episodes.find(e => e.id === r.id)
  assert.ok(ep, 'Should find the exact episode')
  assert.ok(ep.tags.includes('violation'), 'Should have auto-tag: violation')
  assert.ok(ep.tags.includes('session-3'), 'Should have extra tag: session-3')
  assert.ok(ep.tags.includes('urgent'), 'Should have extra tag: urgent')
})

test('12. --sequence and --correct appear in structured body', () => {
  const r = violation('--pattern bp-006-push-after-verify --summary "Sequence test" --body "Details here" --sequence "edit,push,test" --correct "edit,test,push"')
  assert.strictEqual(r.status, 'ok')
  // Read the episode file to verify body structure
  const content = fs.readFileSync(r.file, 'utf8')
  assert.ok(content.includes('## What happened'), 'Should have What happened section')
  assert.ok(content.includes('## Violation sequence'), 'Should have Violation sequence section')
  assert.ok(content.includes('edit,push,test'), 'Should contain the violation sequence')
  assert.ok(content.includes('## Correct sequence'), 'Should have Correct sequence section')
  assert.ok(content.includes('edit,test,push'), 'Should contain the correct sequence')
})

test('13. Missing --pattern rejected with usage error', () => {
  const r = violationFail('--summary "no pattern" --body "test"')
  assert.ok(r, 'Should have returned error output')
  assert.strictEqual(r.status, 'error')
  assert.ok(r.message.includes('Missing required'), 'Should mention missing args')
})

test('14. Missing --summary rejected with usage error', () => {
  const r = violationFail('--pattern bp-001-implementation-workflow --body "test"')
  assert.ok(r, 'Should have returned error output')
  assert.strictEqual(r.status, 'error')
})

test('15. Pattern validation falls back to ~/.episodic-memory/patterns/_index.json', () => {
  // Create a temp dir with no local patterns but global install
  const noLocalDir = path.join(tmpHome, 'no-local-patterns')
  fs.mkdirSync(noLocalDir, { recursive: true })
  // Copy _index.json to global location
  const globalPatternsDir = path.join(tmpHome, '.episodic-memory', 'patterns')
  fs.mkdirSync(globalPatternsDir, { recursive: true })
  fs.copyFileSync(srcIndex, path.join(globalPatternsDir, '_index.json'))

  // Run violation from dir with no local patterns — should find global
  const result = execSync(
    `node "${VIOLATION}" --pattern bp-001-implementation-workflow --summary "fallback test" --body "testing global fallback"`,
    { encoding: 'utf8', cwd: noLocalDir, env }
  )
  const r = JSON.parse(result.trim())
  assert.strictEqual(r.status, 'ok')
})

test('16. em-session-end-prompt.mjs includes store_command template', () => {
  const r = sessionEnd()
  assert.ok(r.store_command, 'Should have store_command field')
  assert.ok(r.store_command.includes('em-violation.mjs'), 'Command should reference em-violation.mjs')
  assert.ok(r.store_command.includes('--pattern'), 'Command should include --pattern flag')
})

test('17. Scope validation rejects invalid --scope values', () => {
  const r = violationFail('--pattern bp-001-implementation-workflow --summary "test" --body "test" --scope invalid')
  assert.ok(r, 'Should have returned error output')
  assert.strictEqual(r.status, 'error')
  assert.ok(r.message.includes('Invalid --scope'), 'Error should mention invalid scope')
})

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n' + '='.repeat(50))
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`)
  }
}
console.log('='.repeat(50))

// Cleanup
fs.rmSync(tmpHome, { recursive: true, force: true })

process.exit(failed > 0 ? 1 : 0)
