#!/usr/bin/env node
/**
 * test-migration-sweep.mjs — Tests for tools/migration-sweep.mjs.
 *
 * Closes Codex round-1 F4 verification: the state-based exit gate must
 * correctly distinguish clean vs dirty enrolled roots and fail closed
 * when the config is missing.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'

const TESTS_DIR = path.dirname(new URL(import.meta.url).pathname)
const REPO_ROOT = path.resolve(TESTS_DIR, '..')
const SWEEP = path.join(REPO_ROOT, 'tools', 'migration-sweep.mjs')

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sweep-'))
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }))

function runSweep(args) {
  // --json always; convert exit-1 from execSync exception to {result, exitCode}.
  try {
    const out = execSync(`node ${SWEEP} ${args} --json`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000
    }).toString()
    return { result: JSON.parse(out), exitCode: 0 }
  } catch (e) {
    if (typeof e.status !== 'number') throw e
    return { result: JSON.parse(e.stdout.toString()), exitCode: e.status }
  }
}

function mkRoot(name) {
  const d = path.join(tmpRoot, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function seedLegacyMarker(root, name) {
  const dir = path.join(root, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), 'x')
}

console.log('Single-root mode (--root):')

test('clean root → exit 0, allClean true, totalLegacy 0', () => {
  const root = mkRoot('clean')
  const { result, exitCode } = runSweep(`--root ${root}`)
  eq(exitCode, 0)
  eq(result.allClean, true)
  eq(result.totalLegacy, 0)
})

test('one legacy marker → exit 1, allClean false, totalLegacy 1', () => {
  const root = mkRoot('one-legacy')
  seedLegacyMarker(root, '.checkpoint-required')
  const { result, exitCode } = runSweep(`--root ${root}`)
  eq(exitCode, 1)
  eq(result.allClean, false)
  eq(result.totalLegacy, 1)
  const scan = result.scans[0]
  eq(scan.count, 1)
  eq(scan.markers[0].name, '.checkpoint-required')
})

test('all 6 legacy markers seeded → totalLegacy 6', () => {
  const root = mkRoot('all-legacy')
  for (const name of [
    '.checkpoint-required',
    '.post-checkpoint-required',
    '.plan-approval-pending',
    '.pre-checkpoint-done',
    '.post-checkpoint-done',
    '.session-baseline'
  ]) {
    seedLegacyMarker(root, name)
  }
  const { result, exitCode } = runSweep(`--root ${root}`)
  eq(exitCode, 1)
  eq(result.totalLegacy, 6)
})

console.log('\nConfig file mode:')

test('config with one clean root + one dirty root → exit 1, totalLegacy 1', () => {
  const cleanRoot = mkRoot('cfg-clean')
  const dirtyRoot = mkRoot('cfg-dirty')
  seedLegacyMarker(dirtyRoot, '.plan-approval-pending')
  const cfg = path.join(tmpRoot, 'roots-1.txt')
  fs.writeFileSync(cfg, `${cleanRoot}\n${dirtyRoot}\n`)
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.rootsScanned, 2)
  eq(result.totalLegacy, 1)
})

test('config with comments and blank lines parsed correctly', () => {
  const root = mkRoot('cfg-comments')
  const cfg = path.join(tmpRoot, 'roots-comments.txt')
  fs.writeFileSync(cfg, `# enrolled roots\n${root}\n\n# end\n`)
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 0)
  eq(result.rootsScanned, 1)
  eq(result.allClean, true)
})

test('all enrolled roots clean → exit 0', () => {
  const a = mkRoot('cfg-clean-a')
  const b = mkRoot('cfg-clean-b')
  const cfg = path.join(tmpRoot, 'roots-clean.txt')
  fs.writeFileSync(cfg, `${a}\n${b}\n`)
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 0)
  eq(result.totalLegacy, 0)
  eq(result.allClean, true)
})

console.log('\nMissing-config fail-closed:')

test('missing config + no --root → exit 1 with configMissing flag', () => {
  // Default config path inside the repo doesn't exist for tests.
  // Pass a non-existent path explicitly so we don't depend on cwd state.
  const cfg = path.join(tmpRoot, 'does-not-exist.txt')
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.configMissing, true)
  // Defaults to cwd scan (which is the test dir). allClean false because
  // config-missing fails closed even if cwd happens to be clean.
  eq(result.allClean, false)
})

console.log()
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
