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
import { execSync } from 'child_process'

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

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cp-mig-'))
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))
  git(root, 'init -q -b main')
  git(root, 'config user.email test@example.com')
  git(root, 'config user.name test')
  fs.writeFileSync(path.join(root, 'README.md'), '# t\n')
  git(root, 'add README.md')
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
  // --session-start writes baseline + arms checkpoint marker if
  // bp-001 violation activation predicate fires. For these tests we don't
  // care about violations — we just want the SessionStart side effects.
  return runRecall(cwd, ['--session-start'])
}

console.log('SessionStart writes baseline at PRIMARY (.checkpoints/):')
test('baseline lands at .checkpoints/.session-baseline, NOT .claude/', () => {
  const root = setupRepo()
  sessionStart(root)
  assertExists(path.join(root, '.checkpoints', '.session-baseline'), 'primary baseline')
  assertMissing(path.join(root, '.claude', '.session-baseline'), 'legacy baseline must not be created')
})

console.log('\narmCheckpointMarker writes to PRIMARY only:')
test('writes .checkpoints/.checkpoint-required, never touches .claude/', () => {
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

  sessionStart(root)
  assertExists(path.join(root, '.checkpoints', '.checkpoint-required'), 'primary marker')
  assertMissing(path.join(root, '.claude', '.checkpoint-required'), 'legacy marker must not be created')
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

console.log('\nSessionStart orphan-clear sweeps BOTH roots:')

test('removes stale legacy + primary markers below prior baseline', () => {
  const root = setupRepo()
  // Seed an OLD baseline at primary (sets priorBaselineMtime).
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  const baseline = path.join(root, '.checkpoints', '.session-baseline')
  fs.writeFileSync(baseline, '')
  const past = (Date.now() - 60000) / 1000
  fs.utimesSync(baseline, past, past)

  // Stale markers at BOTH roots, mtime older than baseline → should be cleared.
  for (const dir of ['.checkpoints', '.claude']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    for (const name of ['.checkpoint-required', '.post-checkpoint-required', '.plan-approval-pending']) {
      const p = path.join(root, dir, name)
      fs.writeFileSync(p, '')
      const older = past - 10  // 10s older than baseline
      fs.utimesSync(p, older, older)
      assertExists(p, 'pre-condition: stale marker exists')
    }
  }

  sessionStart(root)

  // After SessionStart: orphan-clear should have removed all stale markers
  // at BOTH roots (em-recall.mjs SessionStart orphan-clear uses
  // bothMarkerPaths). Then a NEW baseline + possibly a fresh
  // .checkpoint-required at primary may be re-armed if violations exist —
  // for this test there are no seeded violations, so neither marker is re-armed.
  for (const dir of ['.checkpoints', '.claude']) {
    for (const name of ['.checkpoint-required', '.post-checkpoint-required', '.plan-approval-pending']) {
      assertMissing(path.join(root, dir, name), `stale ${dir}/${name} should be cleared`)
    }
  }
})

console.log('\nSessionEnd cleanup sweeps BOTH roots for ALL_MIGRATED_MARKERS:')

test('em-session-end-prompt removes 6 markers across both roots', () => {
  const root = setupRepo()
  // Seed all 6 markers at BOTH roots.
  const markers = [
    '.checkpoint-required',
    '.post-checkpoint-required',
    '.plan-approval-pending',
    '.pre-checkpoint-done',
    '.post-checkpoint-done',
    '.session-baseline'
  ]
  for (const dir of ['.checkpoints', '.claude']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    for (const name of markers) {
      const p = path.join(root, dir, name)
      fs.writeFileSync(p, 'x')
      assertExists(p, `pre-condition: ${dir}/${name}`)
    }
  }

  // em-session-end-prompt resolves the repo root via resolveRepoRoot —
  // running from within the test repo's cwd resolves to that repo. HOME
  // isolation matches runRecall.
  execSync(`node ${SESSION_END}`, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, HOME: root }
  })

  for (const dir of ['.checkpoints', '.claude']) {
    for (const name of markers) {
      assertMissing(path.join(root, dir, name), `${dir}/${name} should be removed by SessionEnd sweep`)
    }
  }
})

console.log()
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
