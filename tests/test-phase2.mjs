#!/usr/bin/env node
/**
 * test-phase2.mjs — Tests for RFC-001 Phase 2: Relevance Decay + Access Tracking
 *
 * Usage: node tests/test-phase2.mjs
 *
 * Tests scoring, access tracking, pruning, and rebuild metadata preservation.
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
const REBUILD = path.join(SCRIPTS, 'em-rebuild-index.mjs')
const PRUNE = path.join(SCRIPTS, 'em-prune.mjs')

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
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-phase2-'))
const tmpProject = path.join(tmpHome, 'project')
fs.mkdirSync(tmpProject, { recursive: true })

const globalDir = path.join(tmpHome, '.episodic-memory')
const localDir = path.join(tmpProject, '.episodic-memory')

const env = { ...process.env, HOME: tmpHome }

function store(args) {
  const result = execSync(`node "${STORE}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

function search(args) {
  const result = execSync(`node "${SEARCH}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

function rebuild(args = '') {
  const result = execSync(`node "${REBUILD}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env })
  return JSON.parse(result.trim())
}

function prune(args = '') {
  const result = execSync(`node "${PRUNE}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env, stdio: ['pipe', 'pipe', 'pipe'] })
  return JSON.parse(result.trim())
}

function pruneExitCode(args = '') {
  try {
    execSync(`node "${PRUNE}" ${args}`, { encoding: 'utf8', cwd: tmpProject, env, stdio: ['pipe', 'pipe', 'pipe'] })
    return 0
  } catch (e) {
    return e.status
  }
}

function readIndex(dataDir) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

function writeOldEpisode(dataDir, id, date, summary, tags = 'test', accessCount = 0) {
  const episodesDir = path.join(dataDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const content = `---
id: ${id}
date: ${date}
time: "12:00"
project: test
category: decision
status: active
tags: [${tags}]
summary: ${summary}
---

# ${summary}

Test body content for ${summary}.
`
  fs.writeFileSync(path.join(episodesDir, `${id}.md`), content, 'utf8')
  const indexFile = path.join(dataDir, 'index.jsonl')
  const entry = JSON.stringify({ id, date, time: '12:00', project: 'test', category: 'decision', status: 'active', supersedes: null, tags: tags.split(',').map(t => t.trim()), summary, access_count: accessCount, last_accessed: null })
  fs.appendFileSync(indexFile, entry + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Seed test data
// ---------------------------------------------------------------------------
console.log('\nPhase 2: Relevance Decay + Access Tracking')
console.log('='.repeat(50))

// Store some episodes for scoring tests
const ep1 = store('--project test --category decision --tags "auth,security" --summary "Chose JWT for auth" --body "JWT simplifies stateless API"')
const ep2 = store('--project test --category decision --tags "framework" --summary "Chose Express framework" --body "Express is mature and well-supported"')
const ep3 = store('--project test --category discovery --tags "performance" --summary "Found N+1 query bug" --body "Database queries were not batched"')

// ---------------------------------------------------------------------------
// Scoring tests
// ---------------------------------------------------------------------------
console.log('\n--- Scoring ---')

test('1. Search returns score field by default', () => {
  const r = search('--project test --no-track')
  assert.ok(r.episodes.length > 0, 'should have results')
  assert.ok(r.episodes[0].score !== undefined, 'should have score field')
  assert.ok(typeof r.episodes[0].score === 'number', 'score should be a number')
})

test('2. Score with 0 access_count — pure time decay', () => {
  const r = search('--project test --no-track')
  // Fresh episodes (0 days old) should score near 1.0
  for (const ep of r.episodes) {
    assert.ok(ep.score > 0.9, `score ${ep.score} should be > 0.9 for fresh episode`)
  }
})

test('3. --no-score suppresses score field', () => {
  const r = search('--project test --no-score --no-track')
  assert.ok(r.episodes.length > 0)
  assert.strictEqual(r.episodes[0].score, undefined, 'should not have score field')
})

test('4. text_match: exact summary scores higher than substring', () => {
  const exact = search('--project test --query "Chose JWT for auth" --no-track')
  const substring = search('--project test --query "JWT" --no-track')
  assert.ok(exact.episodes.length > 0 && substring.episodes.length > 0)
  // Exact match (1.0) vs substring (0.7) — exact should score higher
  const exactScore = exact.episodes.find(e => e.id === ep1.id)?.score
  const subScore = substring.episodes.find(e => e.id === ep1.id)?.score
  assert.ok(exactScore > subScore, `exact ${exactScore} should be > substring ${subScore}`)
})

test('5. text_match: body-only match scores lower than summary match', () => {
  const summaryMatch = search('--project test --query "Express" --no-track')
  const bodyOnly = search('--project test --query "stateless" --no-track')
  assert.ok(summaryMatch.episodes.length > 0 && bodyOnly.episodes.length > 0)
  const sumScore = summaryMatch.episodes[0].score
  const bodyScore = bodyOnly.episodes[0].score
  assert.ok(sumScore > bodyScore, `summary ${sumScore} should be > body ${bodyScore}`)
})

test('6. Results sorted by score descending', () => {
  const r = search('--project test --no-track')
  for (let i = 1; i < r.episodes.length; i++) {
    assert.ok(r.episodes[i - 1].score >= r.episodes[i].score,
      `score[${i-1}]=${r.episodes[i-1].score} should be >= score[${i}]=${r.episodes[i].score}`)
  }
})

test('7. Time decay at 365 days — score at floor (0.1)', () => {
  const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  writeOldEpisode(globalDir, 'old-365-test', oldDate, 'Old episode 365 days')
  const r = search('--query "Old episode 365" --no-track')
  assert.ok(r.episodes.length > 0)
  // text_match=0.7 (substring) * time=0.1 * access=1.0 = 0.07
  assert.ok(r.episodes[0].score < 0.15, `365-day score ${r.episodes[0].score} should be < 0.15`)
})

test('8. Time decay at 730 days — score still at floor (not negative)', () => {
  const oldDate = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  writeOldEpisode(globalDir, 'old-730-test', oldDate, 'Old episode 730 days')
  const r = search('--query "Old episode 730" --no-track')
  assert.ok(r.episodes.length > 0)
  assert.ok(r.episodes[0].score > 0, `730-day score ${r.episodes[0].score} should be > 0`)
  assert.ok(r.episodes[0].score < 0.15, `730-day score ${r.episodes[0].score} should be < 0.15`)
})

test('9. Scoring with missing access_count field — backwards compat', () => {
  // The old-365-test episode was written without access_count in frontmatter
  // computeScore should default to 0
  const r = search('--query "Old episode 365" --no-track')
  assert.ok(r.episodes.length > 0, 'should find episode without access_count')
})

// ---------------------------------------------------------------------------
// Access tracking tests
// ---------------------------------------------------------------------------
console.log('\n--- Access Tracking ---')

test('10. Access tracking increments access_count', () => {
  // Search without --no-track
  search('--project test --query "JWT"')
  const entries = readIndex(globalDir)
  const ep = entries.find(e => e.id === ep1.id)
  assert.ok(ep, 'should find episode in index')
  assert.ok(ep.access_count >= 1, `access_count ${ep.access_count} should be >= 1`)
  assert.ok(ep.last_accessed, 'last_accessed should be set')
})

test('11. --no-track does not modify index', () => {
  const before = readIndex(globalDir).find(e => e.id === ep2.id)
  const beforeCount = before?.access_count || 0
  search('--project test --query "Express" --no-track')
  const after = readIndex(globalDir).find(e => e.id === ep2.id)
  const afterCount = after?.access_count || 0
  assert.strictEqual(afterCount, beforeCount, 'access_count should not change with --no-track')
})

test('12. --history does not trigger access tracking', () => {
  const before = readIndex(globalDir).find(e => e.id === ep1.id)
  const beforeCount = before?.access_count || 0
  search(`--history ${ep1.id}`)
  const after = readIndex(globalDir).find(e => e.id === ep1.id)
  const afterCount = after?.access_count || 0
  assert.strictEqual(afterCount, beforeCount, 'access_count should not change for --history')
})

test('13. --include-superseded does not trigger access tracking', () => {
  const before = readIndex(globalDir).find(e => e.id === ep1.id)
  const beforeCount = before?.access_count || 0
  search('--project test --include-superseded')
  const after = readIndex(globalDir).find(e => e.id === ep1.id)
  const afterCount = after?.access_count || 0
  assert.strictEqual(afterCount, beforeCount, 'access_count should not change for --include-superseded')
})

// ---------------------------------------------------------------------------
// Limit after scoring tests
// ---------------------------------------------------------------------------
console.log('\n--- Result Ordering ---')

test('14. Limit applied after scoring — top-N by score, not date', () => {
  // With --no-track to avoid side effects
  const all = search('--project test --limit 100 --no-track')
  const limited = search('--project test --limit 1 --no-track')
  assert.strictEqual(limited.episodes.length, 1)
  // The top-1 by score should be the same as the first from all
  assert.strictEqual(limited.episodes[0].id, all.episodes[0].id)
})

// ---------------------------------------------------------------------------
// Performance warning tests
// ---------------------------------------------------------------------------
console.log('\n--- Performance Warnings ---')

test('15. Warning emitted when episode count exceeds threshold', () => {
  const r = search('--project test --warn-count 1 --no-track')
  assert.ok(r.warning, 'should have warning field')
  assert.ok(r.warning.includes('episodes in index'), 'warning should mention episode count')
})

// ---------------------------------------------------------------------------
// Rebuild tests
// ---------------------------------------------------------------------------
console.log('\n--- Rebuild ---')

test('16. Rebuild preserves access_count and last_accessed', () => {
  // Get current values
  const before = readIndex(globalDir).find(e => e.id === ep1.id)
  assert.ok(before.access_count >= 1, 'should have access_count before rebuild')

  rebuild('--scope global')

  const after = readIndex(globalDir).find(e => e.id === ep1.id)
  assert.strictEqual(after.access_count, before.access_count, 'access_count should be preserved')
  assert.strictEqual(after.last_accessed, before.last_accessed, 'last_accessed should be preserved')
})

test('17. Rebuild defaults missing metadata to 0/null', () => {
  // old-365-test was created without access_count in the index
  rebuild('--scope global')
  const entry = readIndex(globalDir).find(e => e.id === 'old-365-test')
  assert.ok(entry, 'should find old episode after rebuild')
  assert.strictEqual(entry.access_count, 0, 'should default access_count to 0')
  assert.strictEqual(entry.last_accessed, null, 'should default last_accessed to null')
})

// ---------------------------------------------------------------------------
// Prune tests
// ---------------------------------------------------------------------------
console.log('\n--- Pruning ---')

test('18. Prune --dry-run reports scores, moves no files', () => {
  // old-365-test and old-730-test should be prunable
  const r = prune('--scope global --dry-run')
  const globalResult = r.results.find(x => x.scope === 'global')
  assert.ok(globalResult.prunable >= 1, 'should find prunable episodes')
  assert.ok(globalResult.episodes, 'dry-run should list episodes')
  // Verify files still exist
  assert.ok(fs.existsSync(path.join(globalDir, 'episodes', 'old-365-test.md')), 'file should still exist after dry-run')
})

test('19. Prune --check exits 1 when prunable episodes exist', () => {
  const code = pruneExitCode('--scope global --check')
  assert.strictEqual(code, 1, 'should exit 1 when prunable episodes exist')
})

test('20. Prune moves files to archived/, updates indexes', () => {
  const beforeCount = readIndex(globalDir).length
  const r = prune('--scope global')
  const globalResult = r.results.find(x => x.scope === 'global')
  assert.ok(globalResult.pruned >= 1, 'should prune at least 1 episode')
  assert.ok(globalResult.freed_bytes > 0, 'should free bytes')

  // Verify file moved
  assert.ok(!fs.existsSync(path.join(globalDir, 'episodes', 'old-365-test.md')), 'should be removed from episodes/')
  assert.ok(fs.existsSync(path.join(globalDir, 'archived', 'old-365-test.md')), 'should be in archived/')

  // Verify index updated
  const afterCount = readIndex(globalDir).length
  assert.ok(afterCount < beforeCount, 'index should have fewer entries')

  // Verify archived-index.jsonl exists
  assert.ok(fs.existsSync(path.join(globalDir, 'archived-index.jsonl')), 'archived-index.jsonl should exist')
})

test('21. Prune appends to archived-index.jsonl on second run', () => {
  // Add another old episode and prune again
  const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  writeOldEpisode(globalDir, 'old-400-test', oldDate, 'Old episode 400 days')
  const beforeLines = fs.readFileSync(path.join(globalDir, 'archived-index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length

  prune('--scope global')

  const afterLines = fs.readFileSync(path.join(globalDir, 'archived-index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
  assert.ok(afterLines > beforeLines, `archived-index should grow: ${beforeLines} -> ${afterLines}`)
})

test('22. Prune --check exits 0 when no prunable episodes', () => {
  // After pruning all old episodes, nothing should be prunable
  const code = pruneExitCode('--scope global --check')
  assert.strictEqual(code, 0, 'should exit 0 when nothing to prune')
})

// ---------------------------------------------------------------------------
// Dual-scope write-back test
// ---------------------------------------------------------------------------
console.log('\n--- Dual-Scope ---')

test('23. Dual-scope write-back updates both local and global indexes', () => {
  // Store an episode locally
  const localEp = store('--project test --category decision --tags "local-test" --summary "Local episode for dual scope" --body "test" --scope local')
  // Search across both scopes (default) without --no-track
  search('--project test --query "Local episode"')
  // Both indexes should have been updated
  const globalEntries = readIndex(globalDir)
  const localEntries = readIndex(localDir)
  const globalHit = globalEntries.find(e => e.id === ep1.id)
  const localHit = localEntries.find(e => e.id === localEp.id)
  assert.ok(globalHit?.access_count >= 1, 'global episode should have access_count >= 1')
  assert.ok(localHit?.access_count >= 1, 'local episode should have access_count >= 1')
})

test('24. High-score old episode ranks above low-score recent with access boost', () => {
  // Create an old episode with many accesses
  const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  writeOldEpisode(globalDir, 'old-popular-test', oldDate, 'Popular old episode', 'test', 50)
  // Create a fresh episode with 0 accesses (already done — ep3)
  const r = search('--project test --no-track')
  const oldEp = r.episodes.find(e => e.id === 'old-popular-test')
  const freshEp = r.episodes.find(e => e.id === ep3.id)
  assert.ok(oldEp && freshEp, 'should find both episodes')
  // Old episode with 50 accesses should have access boost: (1 + log1p(50)*0.1) ≈ 1.39
  // Time decay at 100 days: max(0.1, 1 - 100/365) ≈ 0.726
  // Score ≈ 1.0 * 0.726 * 1.39 ≈ 1.01
  // Fresh episode: 1.0 * 1.0 * 1.0 = 1.0
  // So old popular should rank >= fresh
  assert.ok(oldEp.score >= freshEp.score * 0.95, `old popular ${oldEp.score} should be competitive with fresh ${freshEp.score}`)
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
