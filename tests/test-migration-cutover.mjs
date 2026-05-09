#!/usr/bin/env node
/**
 * test-migration-cutover.mjs — Tests for tools/migration-cutover.mjs and
 * scripts/lib/install-manifest.mjs.
 *
 * Verifies the install parity check correctly distinguishes OK / DIFF /
 * MISSING / SOURCE_GONE per file in the manifest. Closes Codex round-1 F1
 * (runtime install parity) by ensuring the cutover tool catches stale
 * installed copies before push.
 *
 * Layered:
 *   Layer 1 — install-manifest unit tests (manifest contents from a tmp repo)
 *   Layer 2 — migration-cutover integration tests (run subprocess against
 *             a synthetic repo + home pair, parse JSON output, assert state
 *             counts and per-file statuses)
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { buildInstallManifest, HOOK_SPECS } from '../scripts/lib/install-manifest.mjs'

const TESTS_DIR = path.dirname(new URL(import.meta.url).pathname)
const REPO_ROOT = path.resolve(TESTS_DIR, '..')
const CUTOVER = path.join(REPO_ROOT, 'tools', 'migration-cutover.mjs')

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cutover-'))
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// Synthetic repo + home setup
// ---------------------------------------------------------------------------
// We mirror the repo's hooks/ + scripts/ + patterns/ structure but with
// minimal placeholder content. The cutover tool walks the manifest, so we
// only need files at the expected relative paths.
const synthRepo = path.join(tmpRoot, 'repo')
const synthHome = path.join(tmpRoot, 'home')

function mkfile(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// Mirror real hook + lib + script + script-lib + pattern files.
mkfile(path.join(synthRepo, 'hooks/checkpoint-gate.sh'), 'cp\n')
mkfile(path.join(synthRepo, 'hooks/plan-gate.sh'), 'plan\n')
mkfile(path.join(synthRepo, 'hooks/stop-gate.sh'), 'stop\n')
mkfile(path.join(synthRepo, 'hooks/em-recall-sessionstart.sh'), 'sess\n')
mkfile(path.join(synthRepo, 'hooks/lib/marker-paths.sh'), 'mp\n')
mkfile(path.join(synthRepo, 'hooks/lib/repo-root.sh'), 'rr\n')
mkfile(path.join(synthRepo, 'hooks/lib/command-classifier.sh'), 'cc\n')
mkfile(path.join(synthRepo, 'scripts/em-recall.mjs'), 'er\n')
mkfile(path.join(synthRepo, 'scripts/em-store.mjs'), 'es\n')
mkfile(path.join(synthRepo, 'scripts/lib/local-dir.mjs'), 'ld\n')
mkfile(path.join(synthRepo, 'scripts/lib/marker-paths.mjs'), 'mp-mjs\n')
mkfile(path.join(synthRepo, 'patterns/_index.json'), '{}\n')

console.log('Layer 1 — install-manifest:')

test('HOOK_SPECS contains the 5 canonical hooks (incl. stop-gate twice)', () => {
  // 5 entries (stop-gate registered for Stop AND SubagentStop).
  eq(HOOK_SPECS.length, 5)
  const files = HOOK_SPECS.map(s => s.file)
  for (const f of ['checkpoint-gate.sh', 'plan-gate.sh', 'em-recall-sessionstart.sh', 'stop-gate.sh']) {
    if (!files.includes(f)) throw new Error(`missing hook file: ${f}`)
  }
})

test('buildInstallManifest enumerates hooks + libs + scripts + script-libs + patterns', () => {
  const m = buildInstallManifest(synthRepo, synthHome)
  // Expected count: 4 unique hooks + 3 hook libs + 2 scripts + 2 script libs + 1 pattern = 12
  eq(m.length, 12)
  const byKind = m.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] || 0) + 1
    return acc
  }, {})
  eq(byKind.hook, 4)        // dedup stop-gate (registered twice)
  eq(byKind['hook-lib'], 3)
  eq(byKind.script, 2)
  eq(byKind['script-lib'], 2)
  eq(byKind.pattern, 1)
})

test('buildInstallManifest sorts entries by relativePath', () => {
  const m = buildInstallManifest(synthRepo, synthHome)
  for (let i = 1; i < m.length; i++) {
    if (m[i].relativePath < m[i - 1].relativePath) {
      throw new Error(`unsorted at index ${i}: ${m[i - 1].relativePath} > ${m[i].relativePath}`)
    }
  }
})

test('buildInstallManifest installedPath uses HOME_DIR for hook + script roots', () => {
  const m = buildInstallManifest(synthRepo, synthHome)
  const checkpoint = m.find(e => e.relativePath === 'hooks/checkpoint-gate.sh')
  eq(checkpoint.installedPath, path.join(synthHome, '.claude', 'hooks', 'checkpoint-gate.sh'))
  const recall = m.find(e => e.relativePath === 'scripts/em-recall.mjs')
  eq(recall.installedPath, path.join(synthHome, '.episodic-memory', 'scripts', 'em-recall.mjs'))
})

console.log('\nLayer 2 — migration-cutover:')

function runCutover(repoDir, homeDir) {
  const out = execSync(`node ${CUTOVER} --repo ${repoDir} --home ${homeDir} --json`, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000
  }).toString()
  return JSON.parse(out)
}

function runCutoverExpectFail(repoDir, homeDir) {
  try {
    execSync(`node ${CUTOVER} --repo ${repoDir} --home ${homeDir} --json`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    })
    throw new Error('cutover unexpectedly exited 0')
  } catch (e) {
    if (e.message === 'cutover unexpectedly exited 0') throw e
    if (e.status !== 1) throw new Error(`expected exit 1, got ${e.status}`)
    return JSON.parse(e.stdout.toString())
  }
}

test('all-MISSING (empty home) → exit 1, all entries MISSING', () => {
  // Fresh home — nothing installed.
  const result = runCutoverExpectFail(synthRepo, synthHome)
  eq(result.allOk, false)
  eq(result.counts.MISSING, 12)
  if (result.counts.OK) throw new Error(`unexpected OK count: ${result.counts.OK}`)
})

test('all-OK (home installed identically) → exit 0', () => {
  // Mirror every manifest entry into the home.
  const m = buildInstallManifest(synthRepo, synthHome)
  for (const entry of m) {
    fs.mkdirSync(path.dirname(entry.installedPath), { recursive: true })
    fs.copyFileSync(entry.repoPath, entry.installedPath)
  }
  const result = runCutover(synthRepo, synthHome)
  eq(result.allOk, true)
  eq(result.counts.OK, 12)
})

test('one DIFF surfaces correctly → exit 1', () => {
  // Mutate the installed em-recall to differ from the repo source.
  const installedRecall = path.join(synthHome, '.episodic-memory', 'scripts', 'em-recall.mjs')
  fs.writeFileSync(installedRecall, 'DRIFTED CONTENT\n')
  const result = runCutoverExpectFail(synthRepo, synthHome)
  eq(result.counts.DIFF, 1)
  const recallEntry = result.results.find(r => r.relativePath === 'scripts/em-recall.mjs')
  if (!recallEntry || recallEntry.status !== 'DIFF') {
    throw new Error(`expected DIFF for em-recall, got ${JSON.stringify(recallEntry)}`)
  }
  // Restore for next test.
  fs.copyFileSync(path.join(synthRepo, 'scripts/em-recall.mjs'), installedRecall)
})

test('one MISSING surfaces correctly → exit 1', () => {
  const installedClassifier = path.join(synthHome, '.claude', 'hooks', 'lib', 'command-classifier.sh')
  fs.unlinkSync(installedClassifier)
  const result = runCutoverExpectFail(synthRepo, synthHome)
  eq(result.counts.MISSING, 1)
  const cc = result.results.find(r => r.relativePath === 'hooks/lib/command-classifier.sh')
  if (!cc || cc.status !== 'MISSING') {
    throw new Error(`expected MISSING for command-classifier, got ${JSON.stringify(cc)}`)
  }
  // Restore.
  fs.copyFileSync(path.join(synthRepo, 'hooks/lib/command-classifier.sh'), installedClassifier)
})

console.log()
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
