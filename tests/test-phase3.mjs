#!/usr/bin/env node
/**
 * test-phase3.mjs — Tests for RFC-001 Phase 3: Proactive Recall
 *
 * Usage: node tests/test-phase3.mjs
 *
 * Tests context inference, multi-pass retrieval, deduplication, access tracking,
 * prune suggestions, and inlined function drift detection.
 * Zero dependencies — uses Node.js assert + fs + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const STORE = path.join(SCRIPTS, 'em-store.mjs')
const RECALL = path.join(SCRIPTS, 'em-recall.mjs')
const SEARCH = path.join(SCRIPTS, 'em-search.mjs')

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
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-phase3-'))
const tmpProject = path.join(tmpHome, 'project')
fs.mkdirSync(tmpProject, { recursive: true })

const globalDir = path.join(tmpHome, '.episodic-memory')
const localDir = path.join(tmpProject, '.episodic-memory')

const env = { ...process.env, HOME: tmpHome }

function store(args, opts = {}) {
  const cwd = opts.cwd || tmpProject
  const result = execSync(`node "${STORE}" ${args}`, { encoding: 'utf8', cwd, env })
  return JSON.parse(result.trim())
}

function recall(args = '', opts = {}) {
  const cwd = opts.cwd || tmpProject
  const result = execSync(`node "${RECALL}" ${args}`, { encoding: 'utf8', cwd, env })
  return JSON.parse(result.trim())
}

// Helper: write an old episode directly (bypasses em-store to control dates)
function writeOldEpisode(dataDir, { id, date, project, category, tags, summary, accessCount, status }) {
  const episodesDir = path.join(dataDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const normTags = (tags || []).map(t => t.toLowerCase().trim()).sort()
  const entry = {
    id, date, time: '12:00', project, category: category || 'decision',
    status: status || 'active', supersedes: null, tags: normTags, summary,
    access_count: accessCount || 0, last_accessed: null
  }
  fs.appendFileSync(path.join(dataDir, 'index.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
  const fm = `---\nid: ${id}\ndate: ${date}\ntime: "12:00"\nproject: ${project}\ncategory: ${category || 'decision'}\nstatus: ${status || 'active'}\ntags: [${normTags.join(', ')}]\nsummary: ${summary}\n---\n\n# ${summary}\n\nBody for ${id}.\n`
  fs.writeFileSync(path.join(episodesDir, `${id}.md`), fm, 'utf8')

  // Update tags.json
  const tagsFile = path.join(dataDir, 'tags.json')
  let tagsIndex = {}
  try { tagsIndex = JSON.parse(fs.readFileSync(tagsFile, 'utf8')) } catch {}
  for (const tag of normTags) {
    if (!tagsIndex[tag]) tagsIndex[tag] = []
    if (!tagsIndex[tag].includes(id)) tagsIndex[tag].push(id)
  }
  fs.writeFileSync(tagsFile, JSON.stringify(tagsIndex, null, 2), 'utf8')
  return entry
}

function readIndex(dataDir) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

// ---------------------------------------------------------------------------
// Seed test data
// ---------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10)
const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)
const oldDate = new Date(Date.now() - 330 * 86400000).toISOString().slice(0, 10)

// Global episodes
writeOldEpisode(globalDir, { id: 'proj-match-1', date: today, project: 'project', category: 'decision', tags: ['architecture'], summary: 'Project-specific decision' })
writeOldEpisode(globalDir, { id: 'proj-match-2', date: threeDaysAgo, project: 'project', category: 'discovery', tags: ['debugging'], summary: 'Project discovery' })
writeOldEpisode(globalDir, { id: 'tag-match-1', date: today, project: 'other-proj', category: 'decision', tags: ['architecture', 'rfc001'], summary: 'Tagged with rfc001' })
writeOldEpisode(globalDir, { id: 'recent-cross-1', date: threeDaysAgo, project: 'cross-proj', category: 'milestone', tags: ['shipping'], summary: 'Recent cross-project milestone' })
writeOldEpisode(globalDir, { id: 'old-episode-1', date: tenDaysAgo, project: 'old-proj', category: 'context', tags: ['legacy'], summary: 'Older than 7 days' })
writeOldEpisode(globalDir, { id: 'very-old-1', date: oldDate, project: 'ancient', category: 'decision', tags: ['forgotten'], summary: 'Very old episode', accessCount: 0 })

// Write a package.json in the project dir for context inference
fs.writeFileSync(path.join(tmpProject, 'package.json'), JSON.stringify({ name: 'project', keywords: ['architecture', 'memory'] }), 'utf8')

// ===========================================================================
console.log('\n--- RFC Acceptance Tests ---')
// ===========================================================================

test('1. Project-field matches rank above incidental tag matches', () => {
  // proj-match-1 (project=project, weight=1.0) should rank above tag-match-1 (tag overlap, weight=0.7)
  const r = recall('--project project --limit 10')
  assert.strictEqual(r.status, 'ok')
  const projIdx = r.episodes.findIndex(e => e.id === 'proj-match-1')
  const tagIdx = r.episodes.findIndex(e => e.id === 'tag-match-1')
  // tag-match-1 might appear via pass 3 (recent) but proj-match should rank higher
  assert.ok(projIdx >= 0, 'proj-match-1 should appear')
  if (tagIdx >= 0) {
    assert.ok(projIdx < tagIdx, `proj-match-1 (idx=${projIdx}) should rank above tag-match-1 (idx=${tagIdx})`)
  }
})

test('2. Short/generic tokens excluded from tag matching', () => {
  const r = recall('--project project --limit 10')
  // Stopwords like "fix", "feat", "bug" should not appear in effective_tokens
  for (const t of r.context.effective_tokens) {
    assert.ok(t.length >= 4, `Token "${t}" should be >= 4 chars`)
  }
})

test('3. Graceful fallback when package.json/git unavailable', () => {
  // Create a bare directory with no package.json, no .git
  const bareDir = path.join(tmpHome, 'bare-project')
  fs.mkdirSync(bareDir, { recursive: true })
  const r = recall('--scope global', { cwd: bareDir })
  assert.strictEqual(r.status, 'ok')
  // Project should fall back to basename
  assert.strictEqual(r.context.project, 'bare-project')
  assert.deepStrictEqual(r.context.branch_tokens, [])
})

test('4. Access tracking updated for surfaced episodes', () => {
  // Read index before recall
  const before = readIndex(globalDir)
  const projBefore = before.find(e => e.id === 'proj-match-1')
  const accessBefore = projBefore ? (projBefore.access_count || 0) : 0

  recall('--project project --limit 10')

  const after = readIndex(globalDir)
  const projAfter = after.find(e => e.id === 'proj-match-1')
  assert.ok(projAfter.access_count > accessBefore, 'access_count should increment')
  assert.ok(projAfter.last_accessed, 'last_accessed should be set')
})

// ===========================================================================
console.log('\n--- Additional Test Cases ---')
// ===========================================================================

test('5. Empty store returns ok with 0 episodes', () => {
  const emptyDir = path.join(tmpHome, 'empty-project')
  fs.mkdirSync(emptyDir, { recursive: true })
  const r = recall('--scope local', { cwd: emptyDir })
  assert.strictEqual(r.status, 'ok')
  assert.strictEqual(r.count, 0)
  assert.deepStrictEqual(r.episodes, [])
})

test('6. --no-track suppresses access tracking', () => {
  const before = readIndex(globalDir)
  const ep = before.find(e => e.id === 'proj-match-2')
  const accessBefore = ep ? (ep.access_count || 0) : 0

  recall('--project project --no-track')

  const after = readIndex(globalDir)
  const epAfter = after.find(e => e.id === 'proj-match-2')
  assert.strictEqual(epAfter.access_count || 0, accessBefore, 'access_count should not change with --no-track')
})

test('7. --project override bypasses auto-inference', () => {
  const r = recall('--project cross-proj --no-track')
  assert.strictEqual(r.context.project, 'cross-proj')
  const hasCrossProj = r.episodes.some(e => e.project === 'cross-proj')
  assert.ok(hasCrossProj, 'Should find cross-proj episodes')
})

test('8. Pass 3 respects --days window', () => {
  // With --days 5, threeDaysAgo is included, tenDaysAgo is excluded
  const r = recall('--project nonexistent --days 5 --no-track --limit 20')
  const hasRecent = r.episodes.some(e => e.id === 'recent-cross-1')
  const hasOld = r.episodes.some(e => e.id === 'old-episode-1')
  assert.ok(hasRecent, 'recent-cross-1 (3 days old) should appear')
  assert.ok(!hasOld, 'old-episode-1 (10 days old) should not appear with --days 5')
})

test('9. Stopword tokens filtered from branch tokens', () => {
  // We can't control git branch in test, but we can verify the stopword list works
  // via the context output — effective_tokens should exclude stopwords
  const r = recall('--project project --no-track')
  const stopwords = ['fix', 'feat', 'feature', 'bug', 'test', 'main', 'merge', 'phase', 'wip']
  for (const t of r.context.effective_tokens) {
    assert.ok(!stopwords.includes(t), `Stopword "${t}" should not be in effective_tokens`)
  }
})

test('10. Prune suggestion for low-score episodes', () => {
  // very-old-1 is 330 days old with 0 accesses — score ~0.096, below 0.15
  const r = recall('--project project --no-track')
  assert.ok(r.prune_suggestion, 'Should have prune suggestion for very old episode')
  assert.ok(r.prune_suggestion.includes('em-prune.mjs --dry-run'), 'Should mention em-prune.mjs')
})

test('11. Performance warnings with low thresholds', () => {
  const r = recall('--project project --no-track --warn-count 1')
  // RFC-002 Phase 3: preflight_warnings entries are objects { type, message, ... }
  const hasCountWarning = r.preflight_warnings.some(w => w && w.type === 'system' && w.message && w.message.includes('episodes in index'))
  assert.ok(hasCountWarning, 'Should warn about episode count')
})

test('12. Scope validation rejects invalid values', () => {
  try {
    recall('--scope invalid --no-track')
    assert.fail('Should have thrown')
  } catch (e) {
    if (e.message === 'Should have thrown') throw e
    // execSync throws on non-zero exit — verify error message
    const output = (e.stdout || '') + (e.stderr || '') + (e.message || '')
    assert.ok(output.includes('Invalid --scope'), 'Error should mention invalid scope')
  }
})

test('13. Deduplication: episode in multiple passes appears once with highest score', () => {
  // proj-match-1 matches pass 1 (project=project, weight=1.0) and could match pass 3 (recent, weight=0.5)
  // It should appear only once with the higher score
  const r = recall('--project project --no-track --limit 20')
  const matches = r.episodes.filter(e => e.id === 'proj-match-1')
  assert.strictEqual(matches.length, 1, 'Should appear exactly once')
  // Score should reflect weight=1.0 (pass 1), not 0.5 (pass 3)
  assert.ok(matches[0].score > 0.5, 'Score should use highest pass weight')
})

test('14. --limit applied after merge and dedup', () => {
  // With limit=2, should get top 2 from merged results
  const r = recall('--project project --no-track --limit 2')
  assert.strictEqual(r.count, 2)
  assert.strictEqual(r.episodes.length, 2)
  // Verify they are sorted by score descending
  assert.ok(r.episodes[0].score >= r.episodes[1].score, 'Should be sorted by score desc')
})

test('15. --days 0 returns no cross-project results', () => {
  // With --days 0 and a nonexistent project, only tag match (pass 2) could contribute
  const r = recall('--project nonexistent-xyz --days 0 --no-track --limit 20')
  // No project match (nonexistent), no pass 3 (days=0)
  // Only pass 2 (tag match) should contribute if any tokens match
  // recent-cross-1 should NOT appear since pass 3 is disabled
  const hasCross = r.episodes.some(e => e.id === 'recent-cross-1')
  assert.ok(!hasCross, 'With --days 0, no cross-project results should appear')
})

test('16. Detached HEAD / no git — empty branch tokens', () => {
  // bare-project has no .git
  const bareDir = path.join(tmpHome, 'bare-project')
  const r = recall('--scope global --no-track', { cwd: bareDir })
  assert.deepStrictEqual(r.context.branch_tokens, [])
})

test('17. No .git directory — context still works from package.json/cwd', () => {
  // Create project with package.json but no git
  const noGitDir = path.join(tmpHome, 'no-git-project')
  fs.mkdirSync(noGitDir, { recursive: true })
  fs.writeFileSync(path.join(noGitDir, 'package.json'), JSON.stringify({ name: 'my-special-project' }), 'utf8')
  const r = recall('--scope global --no-track', { cwd: noGitDir })
  assert.strictEqual(r.context.project, 'my-special-project')
})

test('18. package.json with no name — falls back to basename', () => {
  const noNameDir = path.join(tmpHome, 'fallback-dir')
  fs.mkdirSync(noNameDir, { recursive: true })
  fs.writeFileSync(path.join(noNameDir, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8')
  const r = recall('--scope global --no-track', { cwd: noNameDir })
  assert.strictEqual(r.context.project, 'fallback-dir')
})

test('19. package.json keywords fed into effective tokens', () => {
  // tmpProject has package.json with keywords: ['architecture', 'memory']
  const r = recall('--project project --no-track')
  // 'architecture' (10 chars, not a stopword) should be in effective_tokens
  assert.ok(r.context.effective_tokens.includes('architecture'), 'keyword "architecture" should be in effective_tokens')
  assert.ok(r.context.effective_tokens.includes('memory'), 'keyword "memory" should be in effective_tokens')
})

// ===========================================================================
console.log('\n--- Drift Detection ---')
// ===========================================================================

test('20. Retrieval primitives come from the shared lib, not inlined copies', () => {
  // The formerly SYNC-duplicated functions live in lib/relevance.mjs. Drift is
  // structurally impossible as long as BOTH scripts import them from the lib
  // and NEITHER redeclares a local copy.
  const recallSrc = fs.readFileSync(path.join(SCRIPTS, 'em-recall.mjs'), 'utf8')
  const searchSrc = fs.readFileSync(path.join(SCRIPTS, 'em-search.mjs'), 'utf8')
  const libSrc = fs.readFileSync(path.join(SCRIPTS, 'lib', 'relevance.mjs'), 'utf8')

  const sharedFunctions = ['normalizeTags', 'loadTagsIndex', 'computeScore', 'writeBackAccessTracking', 'loadIndex']

  assert.ok(recallSrc.includes("from './lib/relevance.mjs'"), 'em-recall.mjs must import from lib/relevance.mjs')
  assert.ok(searchSrc.includes("from './lib/relevance.mjs'"), 'em-search.mjs must import from lib/relevance.mjs')

  for (const fnName of sharedFunctions) {
    const declRegex = new RegExp(`function ${fnName}\\(`)
    assert.ok(!declRegex.test(recallSrc), `${fnName} redeclared locally in em-recall.mjs — must come from lib/relevance.mjs`)
    assert.ok(!declRegex.test(searchSrc), `${fnName} redeclared locally in em-search.mjs — must come from lib/relevance.mjs`)
    assert.ok(new RegExp(`export function ${fnName}\\(`).test(libSrc), `${fnName} not exported by lib/relevance.mjs`)
    // Both scripts must actually reference the shared name (import list / call site).
    assert.ok(recallSrc.includes(fnName), `${fnName} unreferenced in em-recall.mjs`)
    assert.ok(searchSrc.includes(fnName), `${fnName} unreferenced in em-search.mjs`)
  }
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
