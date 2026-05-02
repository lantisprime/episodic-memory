#!/usr/bin/env node
/**
 * test-rfc002-phase3.mjs — Tests for RFC-002 Phase 3: Actionable Recall
 *
 * Usage: node tests/test-rfc002-phase3.mjs
 *
 * Covers acceptance tests T1-T7 for Phase 3:
 *   T1: Recall includes preflight_warnings when violations exist for task-relevant patterns
 *   T2: Pre-flight surfaces violation count and last violation date
 *   T3: No pre-flight when no violations exist or task type unclear (clean output)
 *   T4: --task-type flag for explicit task context
 *   T5: Keyword inference from git branch name as fallback
 *   T6: SessionEnd hook prompts user for violation flagging — verifies both the
 *       script prompt content and that install.mjs --install-hooks registers
 *       the script as a SessionEnd hook (not instruction-only)
 *   T7: em-recall.mjs touches .claude/.checkpoint-required when bp-001 violations
 *       are surfaced via task-type-driven pre-flight; em-session-end-prompt.mjs
 *       sweeps the marker at session end (best-effort pre-Phase-3b cleanup).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const RECALL = path.join(SCRIPTS, 'em-recall.mjs')
const VIOLATION = path.join(SCRIPTS, 'em-violation.mjs')
const REBUILD = path.join(SCRIPTS, 'em-rebuild-index.mjs')
const SESSION_END = path.join(SCRIPTS, 'em-session-end-prompt.mjs')
const INSTALL = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'install.mjs')
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
// Setup: isolated temp project with patterns/_index.json + a fresh HOME.
// Mirrors test-rfc002-phase2.mjs convention.
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-rfc002-p3-'))
const tmpProject = path.join(tmpHome, 'project')
fs.mkdirSync(tmpProject, { recursive: true })

// Initialize as a git repo so context inference doesn't fail
execSync('git init -q', { cwd: tmpProject })
execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: tmpProject })

const patternsDir = path.join(tmpProject, 'patterns')
fs.mkdirSync(patternsDir, { recursive: true })
const srcIndex = path.join(REPO_ROOT, 'patterns', '_index.json')
fs.copyFileSync(srcIndex, path.join(patternsDir, '_index.json'))

const env = { ...process.env, HOME: tmpHome }

function recall(args = '', cwd = tmpProject) {
  const result = execSync(`node "${RECALL}" ${args}`, { encoding: 'utf8', cwd, env })
  return JSON.parse(result.trim())
}

function recallExit(args = '', cwd = tmpProject) {
  try {
    const stdout = execSync(`node "${RECALL}" ${args}`, { encoding: 'utf8', cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
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
  const r = violation(`--pattern ${patternId} --summary "seeded ${patternId} ${daysAgo}d" --body "test" --scope ${scope}`)
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

function setBranch(name) {
  execSync(`git checkout -q -B ${name}`, { cwd: tmpProject })
}

const markerPath = path.join(tmpProject, '.claude', '.checkpoint-required')

const ALL_PHASE3B_MARKERS = [
  '.checkpoint-required',
  '.pre-checkpoint-done',
  '.post-checkpoint-required',
  '.post-checkpoint-done'
]

function clearMarker() {
  try { fs.unlinkSync(markerPath) } catch {}
}

// Clear all 4 Phase 3b markers — used by tests that exercise the full
// state machine, so subsequent tests start from a known-clean .claude/
// regardless of what state the previous test left behind.
function clearAllMarkers() {
  for (const m of ALL_PHASE3B_MARKERS) {
    try { fs.unlinkSync(path.join(tmpProject, '.claude', m)) } catch {}
  }
}

function sessionEnd() {
  return execSync(`node "${SESSION_END}"`, { encoding: 'utf8', cwd: tmpProject, env })
}

// ===========================================================================
console.log('\n--- RFC-002 Phase 3 Acceptance Tests ---')
// ===========================================================================

test('T1. preflight_warnings populated when violations exist for task-relevant patterns', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  const r = recall('--task-type implementation --no-track')
  assert.strictEqual(r.status, 'ok')
  const violations = r.preflight_warnings.filter(w => w && w.type === 'violation')
  assert.strictEqual(violations.length, 1, `expected 1 violation warning, got ${violations.length}`)
  assert.strictEqual(violations[0].pattern_id, 'bp-001-implementation-workflow')
})

test('T2. Pre-flight surfaces violation count and last violation date', () => {
  clearStore()
  for (let d = 1; d <= 5; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  const r = recall('--task-type implementation --no-track')
  const w = r.preflight_warnings.find(w => w.type === 'violation' && w.pattern_id === 'bp-001-implementation-workflow')
  assert.ok(w, 'violation warning missing')
  assert.strictEqual(w.violations_last_30d, 5)
  // Most recent is 1 day ago
  const expectedLast = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10)
  assert.strictEqual(w.last_violation, expectedLast)
  assert.ok(w.message && w.message.includes('bp-001'))
  assert.ok(w.message.includes(expectedLast))
})

test('T3a. No violation pre-flight when task type unclear (no flag, no inference)', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  setBranch('main')
  const r = recall('--no-track')
  assert.strictEqual(r.context.task_type, null, `expected task_type null, got ${r.context.task_type}`)
  const violations = r.preflight_warnings.filter(w => w && w.type === 'violation')
  assert.strictEqual(violations.length, 0, 'no violation warnings when task type unknown')
})

test('T3b. No violation pre-flight when no violations exist (clean output)', () => {
  clearStore()
  rebuild()
  const r = recall('--task-type implementation --no-track')
  const violations = r.preflight_warnings.filter(w => w && w.type === 'violation')
  assert.strictEqual(violations.length, 0)
})

test('T3c. Violations older than 30 days are excluded', () => {
  clearStore()
  seedViolation('bp-001-implementation-workflow', 5) // in window
  seedViolation('bp-001-implementation-workflow', 60) // outside window
  rebuild()
  const r = recall('--task-type implementation --no-track')
  const w = r.preflight_warnings.find(w => w.type === 'violation' && w.pattern_id === 'bp-001-implementation-workflow')
  assert.ok(w)
  assert.strictEqual(w.violations_last_30d, 1, '60d-old violation must be excluded')
})

test('T4a. --task-type implementation surfaces bp-001 + bp-006', () => {
  clearStore()
  seedViolation('bp-001-implementation-workflow', 2)
  seedViolation('bp-006-push-after-verify', 3)
  rebuild()
  const r = recall('--task-type implementation --no-track')
  const ids = r.preflight_warnings.filter(w => w.type === 'violation').map(w => w.pattern_id).sort()
  assert.deepStrictEqual(ids, ['bp-001-implementation-workflow', 'bp-006-push-after-verify'])
})

test('T4b. --task-type push surfaces only bp-006 (not bp-001)', () => {
  clearStore()
  seedViolation('bp-001-implementation-workflow', 2)
  seedViolation('bp-006-push-after-verify', 3)
  rebuild()
  const r = recall('--task-type push --no-track')
  const ids = r.preflight_warnings.filter(w => w.type === 'violation').map(w => w.pattern_id)
  assert.deepStrictEqual(ids, ['bp-006-push-after-verify'])
})

test('T4c. --task-type rule surfaces only bp-010', () => {
  clearStore()
  seedViolation('bp-001-implementation-workflow', 2)
  seedViolation('bp-010-habits-override-knowledge', 3)
  rebuild()
  const r = recall('--task-type rule --no-track')
  const ids = r.preflight_warnings.filter(w => w.type === 'violation').map(w => w.pattern_id)
  assert.deepStrictEqual(ids, ['bp-010-habits-override-knowledge'])
})

test('T4d. --task-type general surfaces nothing', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  const r = recall('--task-type general --no-track')
  const violations = r.preflight_warnings.filter(w => w.type === 'violation')
  assert.strictEqual(violations.length, 0)
})

test('T4e. Invalid --task-type rejected', () => {
  const r = recallExit('--task-type bogus --no-track')
  assert.strictEqual(r.code, 1)
  assert.ok(r.json && r.json.status === 'error' && r.json.message.includes('Invalid --task-type'))
})

test('T5a. Branch keyword inference: feature/foo-implement-bar → implementation', () => {
  clearStore()
  seedViolation('bp-001-implementation-workflow', 2)
  rebuild()
  setBranch('feature/foo-implement-bar')
  const r = recall('--no-track')
  assert.strictEqual(r.context.task_type, 'implementation')
  const ids = r.preflight_warnings.filter(w => w.type === 'violation').map(w => w.pattern_id)
  assert.ok(ids.includes('bp-001-implementation-workflow'))
})

test('T5b. Branch keyword inference: release/v1-push → push', () => {
  clearStore()
  seedViolation('bp-006-push-after-verify', 2)
  rebuild()
  setBranch('release/v1-push')
  const r = recall('--no-track')
  assert.strictEqual(r.context.task_type, 'push')
})

test('T5c. Branch with no recognizable keyword → null task_type, no warnings', () => {
  clearStore()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  setBranch('main')
  const r = recall('--no-track')
  assert.strictEqual(r.context.task_type, null)
})

test('T5d. Explicit --task-type overrides branch inference', () => {
  clearStore()
  seedViolation('bp-006-push-after-verify', 2)
  rebuild()
  setBranch('feature/foo-implement-bar') // would infer implementation
  const r = recall('--task-type push --no-track')
  assert.strictEqual(r.context.task_type, 'push')
  const ids = r.preflight_warnings.filter(w => w.type === 'violation').map(w => w.pattern_id)
  assert.deepStrictEqual(ids, ['bp-006-push-after-verify'])
})

test('T7a. Recall touches .claude/.checkpoint-required when bp-001 violation surfaces', () => {
  clearStore()
  clearMarker()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  recall('--task-type implementation --no-track')
  assert.ok(fs.existsSync(markerPath), '.checkpoint-required should exist after bp-001 surfaces')
})

test('T7b. No marker when only non-bp-001 violations surface', () => {
  clearStore()
  clearMarker()
  // Only bp-006 violations; --task-type push only surfaces bp-006, not bp-001
  for (let d = 1; d <= 3; d++) seedViolation('bp-006-push-after-verify', d)
  rebuild()
  recall('--task-type push --no-track')
  assert.ok(!fs.existsSync(markerPath), '.checkpoint-required must not exist when bp-001 is not surfaced')
})

test('T7c. No marker when task type is unclear (no pre-flight runs)', () => {
  clearStore()
  clearMarker()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  setBranch('main') // no keyword match
  recall('--no-track')
  assert.ok(!fs.existsSync(markerPath), '.checkpoint-required must not exist when task type unknown')
})

test('T7d. Marker creation is idempotent (re-recall does not error)', () => {
  clearStore()
  clearMarker()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  recall('--task-type implementation --no-track')
  assert.ok(fs.existsSync(markerPath))
  // Second recall should not throw
  recall('--task-type implementation --no-track')
  assert.ok(fs.existsSync(markerPath))
})

test('T7e. em-session-end-prompt.mjs sweeps the marker at session end', () => {
  clearStore()
  clearMarker()
  for (let d = 1; d <= 3; d++) seedViolation('bp-001-implementation-workflow', d)
  rebuild()
  recall('--task-type implementation --no-track')
  assert.ok(fs.existsSync(markerPath), 'precondition: marker should exist')
  sessionEnd()
  assert.ok(!fs.existsSync(markerPath), 'marker should be removed by session-end script')
})

test('T7f. SessionEnd cleanup is silent when marker does not exist', () => {
  clearStore()
  clearMarker()
  // Should not throw even with no marker present
  sessionEnd()
  assert.ok(!fs.existsSync(markerPath))
})

test('T7g. SessionEnd sweeps all four Phase 3b markers (full state machine)', () => {
  // Phase 3b spec line 210: SessionEnd removes all four checkpoint markers
  // so they don't persist into the next session.
  clearAllMarkers()
  const claudeDir = path.join(tmpProject, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  const markers = ALL_PHASE3B_MARKERS.map(m => path.join(claudeDir, m))
  for (const m of markers) fs.writeFileSync(m, 'sentinel')
  for (const m of markers) assert.ok(fs.existsSync(m), `precondition: ${path.basename(m)} should exist`)
  sessionEnd()
  for (const m of markers) {
    assert.ok(!fs.existsSync(m), `${path.basename(m)} should be removed by SessionEnd`)
  }
})

test('T7h. SessionEnd cleans orphaned markers (e.g. post-required without checkpoint-required)', () => {
  // Spec line 207: orphaned states cleaned by SessionEnd sweep.
  clearAllMarkers()
  const claudeDir = path.join(tmpProject, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  const orphan = path.join(claudeDir, '.post-checkpoint-required')
  fs.writeFileSync(orphan, '')
  sessionEnd()
  assert.ok(!fs.existsSync(orphan), 'orphaned post-checkpoint-required should be cleaned')
})

test('T7i. clearAllMarkers helper produces clean state for subsequent tests', () => {
  // Defensive guard for the helper itself — A4 audit finding.
  // Seed all 4 markers, call helper, verify all gone.
  const claudeDir = path.join(tmpProject, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  for (const m of ALL_PHASE3B_MARKERS) {
    fs.writeFileSync(path.join(claudeDir, m), 'sentinel')
  }
  clearAllMarkers()
  for (const m of ALL_PHASE3B_MARKERS) {
    assert.ok(!fs.existsSync(path.join(claudeDir, m)),
      `${m} should be cleared by clearAllMarkers helper`)
  }
})

test('T6a. em-session-end-prompt.mjs outputs a violation-flagging prompt with known patterns', () => {
  const out = sessionEnd()
  const data = JSON.parse(out)
  assert.ok(data.prompt && /violated|behavioral pattern/i.test(data.prompt), `prompt should ask about violations; got: ${data.prompt}`)
  assert.ok(Array.isArray(data.known_patterns), 'known_patterns must be present')
  assert.ok(data.known_patterns.length > 0, 'known_patterns must be populated from patterns/_index.json')
  assert.ok(data.known_patterns.every(p => p.pattern_id && p.name), 'each pattern must have pattern_id + name')
  assert.ok(data.store_command && data.store_command.includes('em-violation.mjs'), 'store_command must reference em-violation.mjs')
})

test('T6b. install.mjs --install-hooks registers em-session-end-prompt.mjs as a SessionEnd hook (not instruction-only)', () => {
  // Isolated HOME so we don't touch the real user settings
  const installHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-rfc002-p3-install-'))
  const installEnv = { ...process.env, HOME: installHome }
  const installProject = path.join(installHome, 'target')
  fs.mkdirSync(installProject, { recursive: true })

  try {
    execSync(`node "${INSTALL}" --tool claude-code --project "${installProject}" --install-hooks`, {
      encoding: 'utf8', env: installEnv, stdio: ['pipe', 'pipe', 'pipe']
    })
    const settingsPath = path.join(installHome, '.claude', 'settings.json')
    assert.ok(fs.existsSync(settingsPath), '~/.claude/settings.json must exist after --install-hooks')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    assert.ok(settings.hooks && Array.isArray(settings.hooks.SessionEnd), 'SessionEnd hooks array must exist')
    // Per Codex review (PR-B): assert canonical nested hook entry shape.
    // Earlier flat-only check `entry.command.includes(...)` passed against
    // the malformed `{command, description}` shape that Claude Code never
    // executed; left a false-passing assertion in the suite. This now
    // requires entry.hooks[] with type=command and a command containing
    // em-session-end-prompt — the shape Claude Code actually runs.
    const registered = settings.hooks.SessionEnd.some(entry =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some(h => h && h.type === 'command' && typeof h.command === 'string' && h.command.includes('em-session-end-prompt'))
    )
    assert.ok(registered, 'em-session-end-prompt must be registered as a nested SessionEnd hook entry { hooks: [{ type: "command", command, ... }] }')
  } finally {
    fs.rmSync(installHome, { recursive: true, force: true })
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

fs.rmSync(tmpHome, { recursive: true, force: true })

process.exit(failed > 0 ? 1 : 0)
