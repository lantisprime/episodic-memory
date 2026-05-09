#!/usr/bin/env node
/**
 * test-marker-paths.mjs — Tests for scripts/lib/marker-paths.mjs shared helpers.
 *
 * Layer-1 unit tests over the helpers used by em-recall / em-session-end-prompt
 * during the .checkpoints/ migration. Pairs with tests/test-marker-paths.sh
 * for the bash-side mirror.
 *
 * Defensive ordering per feedback_test_resource_existence_check.md: every
 * state assertion is paired with an existence check on the artifact at
 * check time.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  PRIMARY_MARKER_DIR,
  LEGACY_MARKER_DIR,
  BASELINE_NAME,
  TASK_SIGNAL_MARKERS,
  ALL_MARKERS,
  primaryMarkerPath,
  legacyMarkerPath,
  resolveMarkerRead,
  writeMarkerPath,
  bothMarkerPaths,
  ensurePrimaryDir
} from '../scripts/lib/marker-paths.mjs'

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

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-marker-paths-'))
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }))

console.log('Constants:')
test('PRIMARY_MARKER_DIR is .checkpoints', () => eq(PRIMARY_MARKER_DIR, '.checkpoints'))
test('LEGACY_MARKER_DIR is .claude', () => eq(LEGACY_MARKER_DIR, '.claude'))
test('BASELINE_NAME is .session-baseline', () => eq(BASELINE_NAME, '.session-baseline'))
test('TASK_SIGNAL_MARKERS length is 5', () => eq(TASK_SIGNAL_MARKERS.length, 5))
test('ALL_MARKERS length is 6', () => eq(ALL_MARKERS.length, 6))
test('TASK_SIGNAL_MARKERS contains .checkpoint-required', () => {
  if (!TASK_SIGNAL_MARKERS.includes('.checkpoint-required')) throw new Error('missing')
})
test('ALL_MARKERS contains .session-baseline', () => {
  if (!ALL_MARKERS.includes('.session-baseline')) throw new Error('missing')
})

console.log('\nPath helpers:')
test('primaryMarkerPath returns .checkpoints/<basename>', () => {
  eq(primaryMarkerPath('/repo', '.X'), path.join('/repo', '.checkpoints', '.X'))
})
test('legacyMarkerPath returns .claude/<basename>', () => {
  eq(legacyMarkerPath('/repo', '.X'), path.join('/repo', '.claude', '.X'))
})
test('writeMarkerPath === primaryMarkerPath', () => {
  eq(writeMarkerPath('/repo', '.X'), primaryMarkerPath('/repo', '.X'))
})
test('bothMarkerPaths returns [primary, legacy]', () => {
  const [p, l] = bothMarkerPaths('/repo', '.X')
  eq(p, path.join('/repo', '.checkpoints', '.X'))
  eq(l, path.join('/repo', '.claude', '.X'))
})

console.log('\nresolveMarkerRead fallback chain:')

test('neither marker present → null', () => {
  const root = path.join(tmpRoot, 'none')
  fs.mkdirSync(root, { recursive: true })
  if (resolveMarkerRead(root, '.pre-checkpoint-done') !== null) {
    throw new Error('expected null')
  }
})

test('legacy only → returns legacy path', () => {
  const root = path.join(tmpRoot, 'legacy')
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude', '.pre-checkpoint-done'), 'body')
  const out = resolveMarkerRead(root, '.pre-checkpoint-done')
  eq(out, path.join(root, '.claude', '.pre-checkpoint-done'))
  if (!fs.existsSync(out)) throw new Error('result file does not exist')
})

test('primary only → returns primary path', () => {
  const root = path.join(tmpRoot, 'primary')
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  fs.writeFileSync(path.join(root, '.checkpoints', '.pre-checkpoint-done'), 'body')
  const out = resolveMarkerRead(root, '.pre-checkpoint-done')
  eq(out, path.join(root, '.checkpoints', '.pre-checkpoint-done'))
  if (!fs.existsSync(out)) throw new Error('result file does not exist')
})

test('both present → primary wins', () => {
  const root = path.join(tmpRoot, 'both')
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(root, '.checkpoints', '.pre-checkpoint-done'), 'p')
  fs.writeFileSync(path.join(root, '.claude', '.pre-checkpoint-done'), 'l')
  const out = resolveMarkerRead(root, '.pre-checkpoint-done')
  eq(out, path.join(root, '.checkpoints', '.pre-checkpoint-done'))
})

console.log('\nensurePrimaryDir:')

test('creates .checkpoints/ when absent', () => {
  const root = path.join(tmpRoot, 'ensure-1')
  fs.mkdirSync(root, { recursive: true })
  ensurePrimaryDir(root)
  if (!fs.statSync(path.join(root, '.checkpoints')).isDirectory()) {
    throw new Error('directory not created')
  }
})

test('idempotent on second call', () => {
  const root = path.join(tmpRoot, 'ensure-2')
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  ensurePrimaryDir(root)
  ensurePrimaryDir(root)
  if (!fs.statSync(path.join(root, '.checkpoints')).isDirectory()) {
    throw new Error('directory removed by second call')
  }
})

console.log()
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
