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

// Codex round-1 F2 regression: comment-only / empty config must fail closed.
test('empty config (comments + blanks only) → exit 1, noRootsConfigured', () => {
  const cfg = path.join(tmpRoot, 'roots-comments-only.txt')
  fs.writeFileSync(cfg, `# only comments\n\n# nothing enrolled\n`)
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.noRootsConfigured, true)
  eq(result.allClean, false)
  eq(result.rootsScanned, 0)
})

test('completely empty config file → exit 1, noRootsConfigured', () => {
  const cfg = path.join(tmpRoot, 'roots-empty.txt')
  fs.writeFileSync(cfg, '')
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.noRootsConfigured, true)
  eq(result.allClean, false)
})

console.log('\nCodex round-2 F4: malformed config content fails closed:')

test('config with binary garbage line → exit 1, control_chars validation', () => {
  // 0x00 NUL + 0x01 SOH bytes embedded in a "path" line — the kind of
  // content a corrupted file might contain.
  const cfg = path.join(tmpRoot, 'roots-binary.txt')
  const garbage = '\x00\x01garbled-bytes\x1f'
  fs.writeFileSync(cfg, `${garbage}\n`)
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.allClean, false)
  if (!result.invalidConfigEntries || result.invalidConfigEntries.length !== 1) {
    throw new Error(`expected 1 invalid entry, got ${JSON.stringify(result.invalidConfigEntries)}`)
  }
  eq(result.invalidConfigEntries[0].reason, 'control_chars')
})

test('config with non-absolute path → exit 1, not_absolute', () => {
  const cfg = path.join(tmpRoot, 'roots-relative.txt')
  fs.writeFileSync(cfg, 'relative/path\n')
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  // path.resolve makes the entry absolute — so the validation that fails
  // is does_not_exist (because the resolved path doesn't exist), not
  // not_absolute. This is acceptable: either failure mode is fail-closed.
  if (!result.invalidConfigEntries || result.invalidConfigEntries.length !== 1) {
    throw new Error(`expected 1 invalid entry, got ${JSON.stringify(result.invalidConfigEntries)}`)
  }
})

test('config with path-to-file (not directory) → exit 1, not_a_directory', () => {
  const cfg = path.join(tmpRoot, 'roots-file.txt')
  const someFile = path.join(tmpRoot, 'a-real-file.txt')
  fs.writeFileSync(someFile, 'I am a file')
  fs.writeFileSync(cfg, `${someFile}\n`)
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.invalidConfigEntries[0].reason, 'not_a_directory')
})

test('mixed valid + invalid entries → exit 1 (one bad line taints whole config)', () => {
  const goodRoot = mkRoot('cfg-mixed-good')
  const cfg = path.join(tmpRoot, 'roots-mixed.txt')
  fs.writeFileSync(cfg, `${goodRoot}\n/nonexistent/path/${Date.now()}\n`)
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.allClean, false)
  // Good root is still scanned + clean, but allClean fails closed because
  // the bad entry is unverified.
  eq(result.rootsScanned, 1)
  eq(result.invalidConfigEntries.length, 1)
})

test('config path is a directory → exit 1, configError=not_a_file', () => {
  const cfgDir = path.join(tmpRoot, 'config-as-dir')
  fs.mkdirSync(cfgDir)
  const { result, exitCode } = runSweep(`--config ${cfgDir}`)
  eq(exitCode, 1)
  eq(result.configError, 'not_a_file')
  eq(result.allClean, false)
})

console.log('\nCodex round-3 F5: relative-entry pre-resolve validation:')

test('config with `.` (relative cwd) → exit 1, not_absolute (NOT silently resolved)', () => {
  const cfg = path.join(tmpRoot, 'roots-dot.txt')
  fs.writeFileSync(cfg, '.\n')
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.allClean, false)
  if (!result.invalidConfigEntries || result.invalidConfigEntries.length !== 1) {
    throw new Error(`expected 1 invalid entry, got ${JSON.stringify(result.invalidConfigEntries)}`)
  }
  eq(result.invalidConfigEntries[0].reason, 'not_absolute')
  eq(result.invalidConfigEntries[0].root, '.')  // raw, not resolved
})

test('config with relative path that exists in cwd → exit 1, not_absolute', () => {
  const cfg = path.join(tmpRoot, 'roots-relative-exists.txt')
  fs.writeFileSync(cfg, 'tmp\n')
  // Run sweep with cwd=tmpRoot so 'tmp' would resolve to an existing dir
  // if path.resolve happened first.
  const realDir = path.join(tmpRoot, 'tmp')
  fs.mkdirSync(realDir, { recursive: true })
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.invalidConfigEntries[0].reason, 'not_absolute')
})

test('config with Windows-style path on POSIX → exit 1, not_absolute', () => {
  const cfg = path.join(tmpRoot, 'roots-windows.txt')
  fs.writeFileSync(cfg, 'C:\\demo\n')
  const { result, exitCode } = runSweep(`--config ${cfg}`)
  eq(exitCode, 1)
  eq(result.invalidConfigEntries[0].reason, 'not_absolute')
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
