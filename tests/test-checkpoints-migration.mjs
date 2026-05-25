#!/usr/bin/env node
/**
 * test-checkpoints-migration.mjs — Regression tests for the dual-root
 * marker behaviour introduced by the .checkpoints/ migration.
 *
 * Codex round-1 F2 (split-brain marker state during burn-in): cleanup,
 * orphan-clear, baseline reads, and carve-out evaluation must all
 * iterate BOTH roots until the legacy fallback is removed. These tests
 * exercise that contract end-to-end via em-recall and em-session-end-prompt.
 *
 * Defensive ordering per feedback_test_resource_existence_check.md: each
 * assertion of "marker removed" pairs with an explicit positive check
 * that the file did exist before the action.
 *
 * Layer-2 integration tests over em-recall.mjs (subprocess) and
 * em-session-end-prompt.mjs (subprocess). Layer-1 lib unit tests are
 * in tests/test-marker-paths.{sh,mjs}; this file does not retest
 * primaryMarkerPath / legacyMarkerPath / etc.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, spawnSync } from 'child_process'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const RECALL = path.join(SCRIPTS, 'em-recall.mjs')
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

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function assertExists(p, msg) {
  if (!fs.existsSync(p)) throw new Error(`${msg || 'expected to exist'}: ${p}`)
}
function assertMissing(p, msg) {
  if (fs.existsSync(p)) throw new Error(`${msg || 'expected to be missing'}: ${p}`)
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy')
}

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cp-mig-'))
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))
  git(root, 'init -q -b main')
  git(root, 'config user.email test@example.com')
  git(root, 'config user.name test')
  fs.writeFileSync(path.join(root, 'README.md'), '# t\n')
  // Pin project name to 'test' so resolveProjectName(root, {ignoreOverride:true})
  // matches the seeded violations (which use project: 'test'). Without this,
  // post-Option-E arming binds to basename(root) which is the random mkdtemp
  // suffix → no project match → no arm → tests that rely on arming fail.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test' }, null, 2))
  git(root, 'add README.md package.json')
  git(root, 'commit -q -m init')
  return root
}

function runRecall(cwd, args = [], extraEnv = {}) {
  // HOME isolation: em-recall reads GLOBAL_DIR = $HOME/.episodic-memory which
  // in the host environment has real bp-001 violations and would re-arm
  // .checkpoint-required mid-test. Point HOME at the test's repo to give
  // em-recall an empty global store.
  return execSync(`node ${RECALL} ${args.join(' ')}`, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, HOME: cwd, ...extraEnv }
  }).toString()
}

function gateStop(cwd) {
  return runRecall(cwd, ['--gate', 'stop'])
}

function sessionStart(cwd) {
  // --session-start writes the .session-baseline. Planning-passive (2026-05-25):
  // em-recall no longer arms .checkpoint-required; a bp-001 violation now emits
  // the __BP1_ADVISORY__ stderr signal instead.
  return runRecall(cwd, ['--session-start'])
}

// stderr-capturing variant — the bp-001 signal is now an advisory on stderr.
function sessionStartStderr(cwd, extraEnv = {}) {
  const r = spawnSync('node', [RECALL, '--session-start'], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, ...extraEnv }
  })
  return r.stderr || ''
}

console.log('SessionStart writes baseline at PRIMARY (.checkpoints/):')
test('baseline lands at .checkpoints/.session-baseline, NOT .claude/', () => {
  const root = setupRepo()
  sessionStart(root)
  assertExists(path.join(root, '.checkpoints', '.session-baseline'), 'primary baseline')
  assertMissing(path.join(root, '.claude', '.session-baseline'), 'legacy baseline must not be created')
})

console.log('\nbp-001 signal is an advisory; em-recall never arms a marker (planning-passive):')
test('em-recall emits __BP1_ADVISORY__ and arms NO .checkpoint-required at either root', () => {
  const root = setupRepo()
  // Force activation by seeding a recent bp-001 violation in local store.
  const localEpisodes = path.join(root, '.episodic-memory', 'episodes')
  fs.mkdirSync(localEpisodes, { recursive: true })
  const violationId = '20260509-000000-test-bp001-violation-aaaa'
  fs.writeFileSync(
    path.join(localEpisodes, `${violationId}.md`),
    `---
id: ${violationId}
date: 2026-05-09
project: test
category: violation
status: active
tags: [violated:bp-001-implementation-workflow]
summary: test
---
test
`
  )
  // Build a minimal index.jsonl so loadIndex picks it up.
  const indexLine = JSON.stringify({
    id: violationId,
    date: '2026-05-09',
    project: 'test',
    category: 'violation',
    status: 'active',
    tags: ['violated:bp-001-implementation-workflow'],
    summary: 'test'
  })
  fs.writeFileSync(path.join(root, '.episodic-memory', 'index.jsonl'), indexLine + '\n')

  // Planning-passive: em-recall surfaces the advisory (proving the violation was
  // seen) but arms NO marker. The migration write-path contract (.checkpoints/,
  // never .claude/) for .checkpoint-required is now exercised by the gate's
  // lazy-arm — see test-checkpoint-gate.sh PP-6 / PP-15.
  const stderr = sessionStartStderr(root)
  assertTrue(/__BP1_ADVISORY__/.test(stderr), `expected advisory on stderr; got: ${stderr}`)
  assertMissing(path.join(root, '.checkpoints', '.checkpoint-required'), 'em-recall must not arm primary marker')
  assertMissing(path.join(root, '.claude', '.checkpoint-required'), 'em-recall must not arm legacy marker')
})

console.log('\nstop-gate carve-out reads BOTH roots:')

test('legacy-only marker with mtime > baseline → fail closed (block)', () => {
  const root = setupRepo()
  sessionStart(root)
  const baselineP = path.join(root, '.checkpoints', '.session-baseline')
  assertExists(baselineP, 'primary baseline written')

  // Prime PRE_REQ + force POST_DONE empty (default). Then create a LEGACY
  // task signal marker with mtime AFTER the baseline. Carve-out should
  // fail closed → gate block.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  // PRE_REQ at legacy — gate condition fires.
  fs.writeFileSync(path.join(root, '.claude', '.checkpoint-required'), '')
  const future = (Date.now() + 5000) / 1000
  fs.utimesSync(path.join(root, '.claude', '.checkpoint-required'), future, future)
  // POST_REQ at legacy with newer mtime → carve-out should deny.
  fs.writeFileSync(path.join(root, '.claude', '.post-checkpoint-required'), '')
  fs.utimesSync(path.join(root, '.claude', '.post-checkpoint-required'), future, future)

  const out = gateStop(root)
  if (!out.includes('Post-implementation checkpoint required')) {
    throw new Error(`expected block decision, got: ${out || '(empty)'}`)
  }
})

test('primary baseline newer than legacy markers → carve-out applies (no block)', () => {
  const root = setupRepo()
  // Pre-existing legacy markers from a PRIOR session, with older mtime.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude', '.checkpoint-required'), '')
  const past = (Date.now() - 60000) / 1000  // 60s ago
  fs.utimesSync(path.join(root, '.claude', '.checkpoint-required'), past, past)

  // Now SessionStart writes a fresh primary baseline (mtime ~now).
  sessionStart(root)
  // POST_DONE empty by default → if PRE_REQ exists at legacy, gate would
  // block UNLESS carve-out applies. Carve-out should apply because the
  // legacy marker mtime <= primary baseline mtime.
  const out = gateStop(root)
  if (out.length > 0 && out.includes('"decision":"block"')) {
    throw new Error(`expected carve-out to allow stop (no block), got: ${out}`)
  }
})

console.log('\nSessionStart sweep policy (post-2026-05-18 orphan-deadlock fix):')

test('legacy plan-marker swept; checkpoint markers PRESERVED (M5 retime contract)', () => {
  // Post-2026-05-18 contract (codex R3 P1): SessionStart sweeps ONLY the
  // unconditional legacy-suffix-less `.plan-approval-pending`. Checkpoint
  // markers (.checkpoint-required, .post-checkpoint-required) are PRESERVED
  // — the M5 retime-and-rearm contract advances the baseline so Stop is
  // unblocked while the writer-gate stays armed for concurrent live sessions.
  const root = setupRepo()
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  const baseline = path.join(root, '.checkpoints', '.session-baseline')
  fs.writeFileSync(baseline, '')
  const past = (Date.now() - 60000) / 1000
  fs.utimesSync(baseline, past, past)

  for (const dir of ['.checkpoints', '.claude']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    for (const name of ['.checkpoint-required', '.post-checkpoint-required', '.plan-approval-pending']) {
      const p = path.join(root, dir, name)
      fs.writeFileSync(p, '')
      const older = past - 10
      fs.utimesSync(p, older, older)
      assertExists(p, 'pre-condition: stale marker exists')
    }
  }

  sessionStart(root)

  // Legacy plan-marker: swept at BOTH roots (PR #314 contract).
  for (const dir of ['.checkpoints', '.claude']) {
    assertMissing(path.join(root, dir, '.plan-approval-pending'),
      `legacy plan-marker at ${dir}/ should be swept`)
  }
  // Checkpoint markers: PRESERVED at BOTH roots (M5 retime contract).
  for (const dir of ['.checkpoints', '.claude']) {
    for (const name of ['.checkpoint-required', '.post-checkpoint-required']) {
      assertExists(path.join(root, dir, name),
        `${dir}/${name} should be PRESERVED (M5 retime — no rm)`)
    }
  }
  // Carve-out invariant: new baseline.mtime > all preserved-marker mtimes.
  const newBaselineMs = fs.lstatSync(baseline).mtimeMs
  for (const dir of ['.checkpoints', '.claude']) {
    for (const name of ['.checkpoint-required', '.post-checkpoint-required']) {
      const mt = fs.lstatSync(path.join(root, dir, name)).mtimeMs
      if (newBaselineMs < mt) {
        throw new Error(`baseline.mtime (${newBaselineMs}) must dominate ${dir}/${name}.mtime (${mt})`)
      }
    }
  }
})

console.log('\nSessionEnd cleanup sweeps BOTH roots for ALL_MIGRATED_MARKERS:')

test('em-session-end-prompt removes non-plan markers; F12 preserves legacy + removes own-session plan-marker', () => {
  // #268 fix F12 (codex r1 F1): SessionEnd no longer unconditionally removes
  // .plan-approval-pending. Legacy is read-only-during-burn-in; only
  // .plan-approval-pending.<own-sid> (provided via stdin .session_id) gets
  // removed. Cross-session safety: B's SessionEnd does not delete A's marker.
  const root = setupRepo()
  const sid = 'session-test-A'

  // Seed 5 non-plan migrated markers at BOTH roots.
  const nonPlanMarkers = [
    '.checkpoint-required',
    '.post-checkpoint-required',
    '.pre-checkpoint-done',
    '.post-checkpoint-done',
    '.session-baseline'
  ]
  for (const dir of ['.checkpoints', '.claude']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    for (const name of nonPlanMarkers) {
      const p = path.join(root, dir, name)
      fs.writeFileSync(p, 'x')
      assertExists(p, `pre-condition: ${dir}/${name}`)
    }
    // Also seed legacy plan-marker and own-session suffixed plan-marker.
    for (const name of ['.plan-approval-pending', `.plan-approval-pending.${sid}`]) {
      const p = path.join(root, dir, name)
      fs.writeFileSync(p, 'x')
      assertExists(p, `pre-condition: ${dir}/${name}`)
    }
  }

  // Run SessionEnd with stdin {session_id: <sid>} — F12 reads stdin.
  execSync(`node ${SESSION_END}`, {
    cwd: root,
    input: JSON.stringify({ session_id: sid, hook_event_name: 'SessionEnd' }),
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, HOME: root }
  })

  // 5 non-plan markers: removed at BOTH roots (unchanged behavior).
  for (const dir of ['.checkpoints', '.claude']) {
    for (const name of nonPlanMarkers) {
      assertMissing(path.join(root, dir, name), `${dir}/${name} should be removed by SessionEnd sweep`)
    }
  }
  // F12: legacy plan-marker PRESERVED at BOTH roots (never removed by SessionEnd).
  for (const dir of ['.checkpoints', '.claude']) {
    assertExists(path.join(root, dir, '.plan-approval-pending'),
      `F12: ${dir}/.plan-approval-pending must be PRESERVED (read-only-during-burn-in)`)
  }
  // F12: own-session suffixed plan-marker REMOVED at BOTH roots.
  for (const dir of ['.checkpoints', '.claude']) {
    assertMissing(path.join(root, dir, `.plan-approval-pending.${sid}`),
      `F12: ${dir}/.plan-approval-pending.${sid} should be removed (own-session cleanup)`)
  }
})

test('SessionEnd with invalid session_id leaves all plan-markers untouched', () => {
  // F12: invalid sid → skip plan-marker cleanup entirely. Non-plan markers
  // continue to clean up normally.
  const root = setupRepo()
  for (const dir of ['.checkpoints', '.claude']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    fs.writeFileSync(path.join(root, dir, '.plan-approval-pending'), 'x')
    fs.writeFileSync(path.join(root, dir, '.plan-approval-pending.session-A'), 'x')
    fs.writeFileSync(path.join(root, dir, '.checkpoint-required'), 'x')
  }
  execSync(`node ${SESSION_END}`, {
    cwd: root,
    input: JSON.stringify({ session_id: '../evil', hook_event_name: 'SessionEnd' }),
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, HOME: root }
  })
  for (const dir of ['.checkpoints', '.claude']) {
    assertExists(path.join(root, dir, '.plan-approval-pending'),
      `invalid sid: ${dir}/.plan-approval-pending preserved`)
    assertExists(path.join(root, dir, '.plan-approval-pending.session-A'),
      `invalid sid: ${dir}/.plan-approval-pending.session-A preserved (cross-session safety)`)
    assertMissing(path.join(root, dir, '.checkpoint-required'),
      `invalid sid: ${dir}/.checkpoint-required still removed (non-plan unchanged)`)
  }
})

console.log()
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
