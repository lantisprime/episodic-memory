#!/usr/bin/env node
/**
 * test-rfc002-phase2.mjs — Tests for RFC-002 Phase 2: Pattern Refinement
 *
 * Usage: node tests/test-rfc002-phase2.mjs
 *
 * Tests em-pattern-health.mjs: violation counting in rolling window,
 * needs-attention/needs-enforcement classification, enforcement detection
 * across hook + workflow files, CLI flag behavior, and tags.json fallback.
 * Zero dependencies — uses Node.js assert + fs + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const HEALTH = path.join(SCRIPTS, 'em-pattern-health.mjs')
const VIOLATION = path.join(SCRIPTS, 'em-violation.mjs')
const REBUILD = path.join(SCRIPTS, 'em-rebuild-index.mjs')
const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..')

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
// Setup: isolated temp project with patterns/_index.json + a fresh HOME
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-rfc002-p2-'))
const tmpProject = path.join(tmpHome, 'project')
fs.mkdirSync(tmpProject, { recursive: true })

const patternsDir = path.join(tmpProject, 'patterns')
fs.mkdirSync(patternsDir, { recursive: true })
const srcIndex = path.join(REPO_ROOT, 'patterns', '_index.json')
fs.copyFileSync(srcIndex, path.join(patternsDir, '_index.json'))

const env = { ...process.env, HOME: tmpHome }

function health(args = '', cwd = tmpProject) {
  const result = execSync(`node "${HEALTH}" ${args}`, { encoding: 'utf8', cwd, env })
  return { json: result.trim() ? safeParse(result.trim()) : null, raw: result }
}

function healthExit(args = '', cwd = tmpProject) {
  try {
    const stdout = execSync(`node "${HEALTH}" ${args}`, { encoding: 'utf8', cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    return { code: 0, stdout, json: safeParse(stdout.trim()) }
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', json: safeParse((e.stdout || '').trim()) }
  }
}

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

function violation(args, cwd = tmpProject) {
  const result = execSync(`node "${VIOLATION}" ${args}`, { encoding: 'utf8', cwd, env })
  return JSON.parse(result.trim())
}

function rebuild(cwd = tmpProject) {
  return execSync(`node "${REBUILD}" --scope all`, { encoding: 'utf8', cwd, env })
}

function seedViolation(patternId, daysAgo, scope = 'global') {
  // Stores a violation, then rewrites its index entry + frontmatter date to
  // simulate a violation that occurred `daysAgo` days ago.
  const r = violation(`--pattern ${patternId} --summary "seeded violation ${patternId} ${daysAgo}d ago" --body "seeded for test" --scope ${scope}`)
  assert.strictEqual(r.status, 'ok', `seedViolation failed: ${JSON.stringify(r)}`)
  const dataDir = scope === 'global' ? path.join(tmpHome, '.episodic-memory') : path.join(tmpProject, '.episodic-memory')
  const fakeDate = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
  const indexFile = path.join(dataDir, 'index.jsonl')
  const lines = fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean)
  const updated = lines.map(line => {
    const e = JSON.parse(line)
    if (e.id === r.id) e.date = fakeDate
    return JSON.stringify(e)
  })
  fs.writeFileSync(indexFile, updated.join('\n') + '\n', 'utf8')
  // Rewrite frontmatter for completeness
  const epFile = r.file
  const content = fs.readFileSync(epFile, 'utf8').replace(/^date: .+$/m, `date: ${fakeDate}`)
  fs.writeFileSync(epFile, content, 'utf8')
  return r.id
}

function clearStore() {
  for (const dir of [path.join(tmpHome, '.episodic-memory'), path.join(tmpProject, '.episodic-memory')]) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function clearEnforcement() {
  for (const dir of [path.join(tmpHome, '.claude', 'hooks'), path.join(tmpProject, '.claude', 'hooks'), path.join(tmpProject, '.git', 'hooks'), path.join(tmpProject, '.github', 'workflows')]) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeHook(relPath, content) {
  const full = path.join(tmpProject, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

function writeGlobalHook(relPath, content) {
  const full = path.join(tmpHome, '.claude', 'hooks', relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

// ===========================================================================
console.log('\n--- RFC Acceptance Tests (Phase 2) ---')
// ===========================================================================

test('1. Counts violations per pattern within rolling time window', () => {
  clearStore()
  seedViolation('bp-001-implementation-workflow', 5)
  seedViolation('bp-001-implementation-workflow', 10)
  seedViolation('bp-001-implementation-workflow', 100) // outside 30d window
  rebuild()
  const r = health('--pattern bp-001-implementation-workflow').json
  const p = r.patterns[0]
  assert.strictEqual(p.violations, 2, `expected 2 violations in window, got ${p.violations}`)
  assert.ok(p.last_violated, 'should have last_violated date')
})

test('2. Flags patterns with 3+ violations in last 30 days as needs-attention or needs-enforcement', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  const r = health('--pattern bp-006-push-after-verify').json
  const p = r.patterns[0]
  assert.strictEqual(p.violations, 3)
  assert.ok(['needs-attention', 'needs-enforcement'].includes(p.recommendation), `expected attention/enforcement, got ${p.recommendation}`)
})

test('3. Enforcement detection skips comment lines starting with #', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  // Hook references pattern only inside a shell comment — should NOT count as enforcement
  writeGlobalHook('comment-only.sh', '#!/usr/bin/env bash\n# bp-006-push-after-verify is mentioned in this comment\necho ok\n')
  const r = health('--pattern bp-006-push-after-verify').json
  const p = r.patterns[0]
  assert.strictEqual(p.has_enforcement, false, 'comment-only mention should not register as enforcement')
  assert.strictEqual(p.recommendation, 'needs-enforcement')
})

test('4. --check exits 1 when patterns need attention', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  const r = healthExit('--check')
  assert.strictEqual(r.code, 1, `expected exit 1, got ${r.code}`)
})

test('4b. --check exits 0 when all healthy', () => {
  clearStore()
  clearEnforcement()
  rebuild()
  const r = healthExit('--check')
  assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}`)
})

test('5. --pattern <id> reports on single pattern', () => {
  clearStore()
  rebuild()
  const r = health('--pattern bp-001-implementation-workflow').json
  assert.strictEqual(r.patterns.length, 1)
  assert.strictEqual(r.patterns[0].pattern_id, 'bp-001-implementation-workflow')
})

test('6. --window-days and --min-violations override defaults', () => {
  clearStore()
  for (let d = 1; d <= 4; d++) seedViolation('bp-008-redo-over-patch', d)
  rebuild()
  // Default min=3 → would be flagged. Override min-violations=5 → healthy.
  const r1 = health('--pattern bp-008-redo-over-patch --min-violations 5').json
  assert.strictEqual(r1.patterns[0].recommendation, 'healthy', 'override min-violations should flip to healthy')
  // Window of 2 days → only 2 of 4 violations counted
  const r2 = health('--pattern bp-008-redo-over-patch --window-days 2').json
  assert.strictEqual(r2.patterns[0].violations, 2, 'window-days should narrow count')
})

test('7. --summary outputs one-line summary', () => {
  clearStore()
  rebuild()
  const r = health('--summary').raw
  assert.ok(/^patterns: \d+ \| healthy: \d+ \| needs-attention: \d+ \| needs-enforcement: \d+/.test(r.trim()), `summary format wrong: ${r.trim()}`)
})

test('8. --has-enforcement <id> override marks pattern as enforced', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  // Without override: needs-enforcement
  const before = health('--pattern bp-006-push-after-verify').json
  assert.strictEqual(before.patterns[0].recommendation, 'needs-enforcement')
  // With override: needs-attention (still violated, but now enforced)
  const after = health('--pattern bp-006-push-after-verify --has-enforcement bp-006-push-after-verify').json
  assert.strictEqual(after.patterns[0].has_enforcement, true)
  assert.strictEqual(after.patterns[0].recommendation, 'needs-attention')
})

test('9. needs-attention vs needs-enforcement distinction (attention requires enforcement)', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  // No enforcement → needs-enforcement
  const noEnf = health('--pattern bp-006-push-after-verify').json
  assert.strictEqual(noEnf.patterns[0].recommendation, 'needs-enforcement')
  // With enforcement (real hook file) → needs-attention
  writeGlobalHook('bp-006-gate.sh', '#!/usr/bin/env bash\nset -e\nif grep -q bp-006-push-after-verify "$@"; then echo blocked; fi\n')
  const withEnf = health('--pattern bp-006-push-after-verify').json
  assert.strictEqual(withEnf.patterns[0].has_enforcement, true)
  assert.strictEqual(withEnf.patterns[0].recommendation, 'needs-attention')
})

// ===========================================================================
console.log('\n--- Edge cases & regression tests ---')
// ===========================================================================

test('10. tags.json missing → linear-scan fallback with warning', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-008-redo-over-patch', d)
  // Delete tags.json from both stores to force fallback
  for (const dir of [path.join(tmpHome, '.episodic-memory'), path.join(tmpProject, '.episodic-memory')]) {
    const tf = path.join(dir, 'tags.json')
    if (fs.existsSync(tf)) fs.unlinkSync(tf)
  }
  const r = health('--pattern bp-008-redo-over-patch').json
  assert.strictEqual(r.patterns[0].violations, 3, 'fallback should still count violations')
  assert.ok(r.warning && r.warning.includes('tags.json'), `expected tags.json warning, got ${r.warning}`)
})

test('11. --has-enforcement override marks pattern as enforced regardless of detection', () => {
  // Override should flip even when grep would have found nothing
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-008-redo-over-patch', d)
  rebuild()
  const r = health('--pattern bp-008-redo-over-patch --has-enforcement bp-008-redo-over-patch').json
  assert.strictEqual(r.patterns[0].has_enforcement, true, 'override should set has_enforcement=true')
})

test('12. --check --pattern <healthy_id> exits 0', () => {
  clearStore()
  clearEnforcement()
  rebuild()
  const r = healthExit('--check --pattern bp-002-proactive-milestone-storage')
  assert.strictEqual(r.code, 0)
})

test('13. Global-only fallback: runs from dir with no local patterns/', () => {
  // Set up a directory with no `patterns/` but populate ~/.episodic-memory/patterns
  const noLocalDir = path.join(tmpHome, 'no-local-patterns')
  fs.mkdirSync(noLocalDir, { recursive: true })
  const globalPatternsDir = path.join(tmpHome, '.episodic-memory', 'patterns')
  fs.mkdirSync(globalPatternsDir, { recursive: true })
  fs.copyFileSync(srcIndex, path.join(globalPatternsDir, '_index.json'))
  const r = health('', noLocalDir).json
  assert.strictEqual(r.status, 'ok')
  assert.ok(r.patterns.length > 0, 'should load patterns from global fallback')
})

test('14. Enforcement detected across hook AND workflow files in one run', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  // bp-001 enforced by global hook; bp-006 enforced by workflow
  writeGlobalHook('bp-001.sh', '#!/usr/bin/env bash\necho bp-001-implementation-workflow check\n')
  writeHook('.github/workflows/ci.yml', 'name: ci\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bp-006-push-after-verify\n')
  const r1 = health('--pattern bp-001-implementation-workflow').json
  const r2 = health('--pattern bp-006-push-after-verify').json
  assert.strictEqual(r1.patterns[0].has_enforcement, true, 'bp-001 should be detected via global hook')
  assert.strictEqual(r2.patterns[0].has_enforcement, true, 'bp-006 should be detected via workflow')
})

test('15. Project-local .claude/hooks/ detection (Item 9 expansion)', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-010-habits-override-knowledge', d)
  rebuild()
  writeHook('.claude/hooks/local.sh', '#!/usr/bin/env bash\nset -e\necho bp-010-habits-override-knowledge\n')
  const r = health('--pattern bp-010-habits-override-knowledge').json
  assert.strictEqual(r.patterns[0].has_enforcement, true, 'project-local .claude/hooks should be searched')
})

test('16. .git/hooks/* detection; .sample files skipped (Item 9 expansion)', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-011-local-before-git', d)
  rebuild()
  // Real hook (no extension) — should detect
  writeHook('.git/hooks/pre-commit', '#!/usr/bin/env bash\necho bp-011-local-before-git\n')
  const r1 = health('--pattern bp-011-local-before-git').json
  assert.strictEqual(r1.patterns[0].has_enforcement, true, '.git/hooks/pre-commit should register')
  // Reset, only `.sample` present — should NOT detect
  fs.rmSync(path.join(tmpProject, '.git', 'hooks', 'pre-commit'))
  writeHook('.git/hooks/pre-commit.sample', '#!/usr/bin/env bash\necho bp-011-local-before-git\n')
  const r2 = health('--pattern bp-011-local-before-git').json
  assert.strictEqual(r2.patterns[0].has_enforcement, false, '.sample files should be skipped')
})

test('17. Word-boundary match avoids prefix false-positive', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  // Hook contains a longer ID that includes bp-001-implementation-workflow as prefix
  writeGlobalHook('lookalike.sh', '#!/usr/bin/env bash\necho bp-001-implementation-workflow-v999-fake\n')
  const r = health('--pattern bp-001-implementation-workflow').json
  // Word boundary at the trailing dash means -v999-fake breaks it; expect false
  assert.strictEqual(r.patterns[0].has_enforcement, false, 'prefix-only mention should not register (word boundary)')
})

test('18. --json and --summary mutually exclusive', () => {
  const r = healthExit('--json --summary')
  assert.strictEqual(r.code, 1)
  assert.ok(r.json && r.json.status === 'error' && r.json.message.includes('mutually exclusive'))
})

test('19. Invalid --scope rejected', () => {
  const r = healthExit('--scope invalid')
  assert.strictEqual(r.code, 1)
  assert.ok(r.json && r.json.status === 'error' && r.json.message.includes('Invalid --scope'))
})

test('20. Unknown --pattern rejected with helpful error', () => {
  const r = healthExit('--pattern bp-999-nonexistent')
  assert.strictEqual(r.code, 1)
  assert.ok(r.json && r.json.status === 'error' && r.json.message.includes('Unknown pattern'))
})

test('21. Stale tags.json (key removed, index intact) triggers fallback warning', () => {
  // Realistic staleness scenario: violation exists in index.jsonl with the
  // `violated:<id>` tag, but tags.json was not regenerated so the key is
  // missing. Linear scan finds the violation; warning must fire because the
  // fast path silently disagreed with the truth.
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-008-redo-over-patch', d)
  rebuild()
  for (const dir of [path.join(tmpHome, '.episodic-memory'), path.join(tmpProject, '.episodic-memory')]) {
    const tf = path.join(dir, 'tags.json')
    if (!fs.existsSync(tf)) continue
    const idx = JSON.parse(fs.readFileSync(tf, 'utf8'))
    delete idx['violated:bp-008-redo-over-patch']
    fs.writeFileSync(tf, JSON.stringify(idx, null, 2), 'utf8')
  }
  // index.jsonl entries are unchanged — linear scan must compensate
  const r = health('--pattern bp-008-redo-over-patch').json
  assert.strictEqual(r.patterns[0].violations, 3, 'fallback should still find violations via linear scan')
  assert.ok(r.warning && r.warning.includes('tags.json'), `warning must fire when fallback compensates for stale tags.json; got: ${JSON.stringify(r.warning)}`)
})

test('21b. Pattern with zero violations and absent key does NOT trigger warning', () => {
  // The key `violated:<id>` is legitimately absent for any pattern that has
  // no violations. That must not be misclassified as staleness — otherwise
  // the warning fires for almost every healthy pattern.
  clearStore()
  // Seed a violation for bp-001 only — bp-008 has zero violations
  seedViolation('bp-001-implementation-workflow', 1)
  rebuild()
  const r = health('--pattern bp-008-redo-over-patch').json
  assert.strictEqual(r.patterns[0].violations, 0)
  assert.ok(!r.warning, `no warning expected for genuinely-zero pattern; got: ${JSON.stringify(r.warning)}`)
})

test('22. Malformed index.jsonl lines are skipped silently', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  // Append garbage lines to index.jsonl
  const ix = path.join(tmpHome, '.episodic-memory', 'index.jsonl')
  fs.appendFileSync(ix, 'this is not json\n{broken json\n\n', 'utf8')
  const r = health('--pattern bp-001-implementation-workflow').json
  assert.strictEqual(r.status, 'ok')
  assert.strictEqual(r.patterns[0].violations, 3, 'malformed lines must not break the count')
})

test('23. Superseded violations are excluded from counts', () => {
  clearStore()
  const ids = []
  for (let d = 1; d <= 3; d++) ids.push(seedViolation('bp-006-push-after-verify', d))
  rebuild()
  for (const dir of [path.join(tmpHome, '.episodic-memory'), path.join(tmpProject, '.episodic-memory')]) {
    const ix = path.join(dir, 'index.jsonl')
    if (!fs.existsSync(ix)) continue
    const lines = fs.readFileSync(ix, 'utf8').split('\n').filter(Boolean).map(line => {
      const e = JSON.parse(line)
      if (e.id === ids[0]) e.status = 'superseded'
      return JSON.stringify(e)
    })
    fs.writeFileSync(ix, lines.join('\n') + '\n', 'utf8')
  }
  const r = health('--pattern bp-006-push-after-verify').json
  assert.strictEqual(r.patterns[0].violations, 2, 'superseded violation should not count')
})

test('24. Episodes with malformed dates are skipped (B1 regression)', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-008-redo-over-patch', d)
  rebuild()
  const ix = path.join(tmpHome, '.episodic-memory', 'index.jsonl')
  const lines = fs.readFileSync(ix, 'utf8').split('\n').filter(Boolean).map(line => {
    const e = JSON.parse(line)
    if (e.tags && e.tags.includes('violated:bp-008-redo-over-patch')) {
      e.date = 'not-a-date'
    }
    return JSON.stringify(e)
  })
  fs.writeFileSync(ix, lines.join('\n') + '\n', 'utf8')
  const r = health('--pattern bp-008-redo-over-patch').json
  assert.strictEqual(r.patterns[0].violations, 0, 'malformed dates must not be counted')
})

test('25. .git/hooks/pre-commit.local (non-.sample with extension) is included', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-011-local-before-git', d)
  rebuild()
  writeHook('.git/hooks/pre-commit.local', '#!/usr/bin/env bash\necho bp-011-local-before-git\n')
  const r = health('--pattern bp-011-local-before-git').json
  assert.strictEqual(r.patterns[0].has_enforcement, true, 'non-.sample git hooks with custom extensions should be searched')
})

test('26. CLI value validation: --has-enforcement followed by --next-flag does not consume it (S-NEW-1)', () => {
  clearStore()
  clearEnforcement()
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  // `--has-enforcement` has no value; should NOT silently grab `--check`
  const r = healthExit('--has-enforcement --check')
  // Without a real override, bp-006 still has no enforcement → exit 1
  assert.strictEqual(r.code, 1, 'should still treat bp-006 as needs-enforcement (no real override consumed)')
  assert.strictEqual(r.json.patterns.find(p => p.pattern_id === 'bp-006-push-after-verify').has_enforcement, false)
})

test('27. CLI value validation: --pattern followed by --json does not silently lookup "--json" (S-NEW-1)', () => {
  // --pattern with no value should be treated as missing, not consume --json
  // Result: full report (no narrowing), --json behaves as default (JSON output)
  const r = healthExit('--pattern --json')
  assert.strictEqual(r.code, 0, 'no error when --pattern is value-less; full report runs')
  assert.ok(r.json && r.json.status === 'ok')
  assert.ok(r.json.patterns.length > 1, 'should not have narrowed to a single pattern')
})

test('28. parseDateMs rejects garbage tail: 2026-05-01-draft does not parse (S-NEW-2)', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-008-redo-over-patch', d)
  rebuild()
  // Corrupt entries with date-prefix-plus-tail; previous regex would silently parse
  const ix = path.join(tmpHome, '.episodic-memory', 'index.jsonl')
  const lines = fs.readFileSync(ix, 'utf8').split('\n').filter(Boolean).map(line => {
    const e = JSON.parse(line)
    if (e.tags && e.tags.includes('violated:bp-008-redo-over-patch')) {
      e.date = '2026-05-01-draft'
    }
    return JSON.stringify(e)
  })
  fs.writeFileSync(ix, lines.join('\n') + '\n', 'utf8')
  const r = health('--pattern bp-008-redo-over-patch').json
  assert.strictEqual(r.patterns[0].violations, 0, 'date with garbage tail must be rejected')
})

test('29. parseDateMs accepts full ISO timestamp YYYY-MM-DDTHH:MM:SSZ', () => {
  clearStore()
  seedViolation('bp-001-implementation-workflow', 1)
  rebuild()
  // Replace YYYY-MM-DD with full ISO — Date contract should still parse
  const today = new Date().toISOString().slice(0, 10)
  const ix = path.join(tmpHome, '.episodic-memory', 'index.jsonl')
  const lines = fs.readFileSync(ix, 'utf8').split('\n').filter(Boolean).map(line => {
    const e = JSON.parse(line)
    if (e.tags && e.tags.includes('violated:bp-001-implementation-workflow')) {
      e.date = today + 'T12:00:00Z'
    }
    return JSON.stringify(e)
  })
  fs.writeFileSync(ix, lines.join('\n') + '\n', 'utf8')
  const r = health('--pattern bp-001-implementation-workflow').json
  assert.strictEqual(r.patterns[0].violations, 1, 'full ISO timestamp must be accepted')
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
