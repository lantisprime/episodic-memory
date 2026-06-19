#!/usr/bin/env node
/**
 * test-migration-cutover.mjs — Tests for tools/migration-cutover.mjs and
 * scripts/lib/install-manifest.mjs.
 *
 * Verifies the install parity check correctly distinguishes OK / DIFF /
 * MISSING / SOURCE_GONE per file, and that RFC-008 P4d / Principle 12
 * scope:'project' entries (enforcement hooks + engine + classifier + markers +
 * bp1 + their relocated-only libs) are EXCLUDED from the GLOBAL cutover (they
 * install per-project; their integrity is covered by test-p12-global-clean +
 * the activation-scoping E2E suite).
 *
 * Layered:
 *   Layer 1 — install-manifest scope tagging (against the REAL repo, so the
 *             enforcement-vs-substrate classification + import closure are real).
 *   Layer 2 — migration-cutover integration over a synthetic GLOBAL-only repo
 *             (the cutover's view after the scope:'project' filter).
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

const FAKE_HOME = path.join(tmpRoot, 'real-manifest-home')

console.log('Layer 1 — install-manifest scope tagging (real repo):')

test('every HOOK_SPECS hook entry is scope:project (P4d — per-project install)', () => {
  const m = buildInstallManifest(REPO_ROOT, FAKE_HOME)
  const hooks = m.filter(e => e.kind === 'hook')
  if (hooks.length === 0) throw new Error('no hook entries')
  for (const h of hooks) {
    if (h.scope !== 'project') throw new Error(`hook ${h.relativePath} not scope:project`)
  }
  // dedup: stop-gate registered twice (Stop + SubagentStop) → one file entry.
  const uniqueHookFiles = new Set(HOOK_SPECS.map(s => s.file))
  eq(hooks.length, uniqueHookFiles.size, 'unique hook file count')
})

test('enforcement ENGINE/classifier/marker/bp1 scripts are scope:project; substrate em-* are not', () => {
  const m = buildInstallManifest(REPO_ROOT, FAKE_HOME)
  const find = (rel) => m.find(e => e.relativePath === rel)
  // Enforcement entry scripts → scope:'project'.
  for (const f of ['enforce-contract.mjs', 'classifier-marker.mjs', 'plan-marker.mjs', 'bp1-orchestrator.mjs']) {
    const e = find(`scripts/${f}`)
    if (!e) throw new Error(`missing manifest entry scripts/${f}`)
    eq(e.scope, 'project', `scripts/${f} scope`)
  }
  // Substrate scripts → NO project scope (stay global).
  for (const f of ['em-store.mjs', 'em-recall.mjs', 'em-search.mjs']) {
    const e = find(`scripts/${f}`)
    if (!e) throw new Error(`missing manifest entry scripts/${f}`)
    if (e.scope === 'project') throw new Error(`substrate scripts/${f} must NOT be scope:project`)
  }
})

test('relocated-only libs are scope:project; shared substrate libs (local-dir) are not', () => {
  const m = buildInstallManifest(REPO_ROOT, FAKE_HOME)
  const find = (rel) => m.find(e => e.relativePath === rel)
  // marker-state is enforcement-only (in the enforcement closure, not any
  // retained-global script's closure) → scope:'project'.
  const ms = find('scripts/lib/marker-state.mjs')
  if (ms) eq(ms.scope, 'project', 'marker-state lib scope')
  // local-dir is shared with the em-* substrate → stays global (no project scope).
  const ld = find('scripts/lib/local-dir.mjs')
  if (!ld) throw new Error('missing scripts/lib/local-dir.mjs')
  if (ld.scope === 'project') throw new Error('local-dir.mjs (shared substrate) must NOT be scope:project')
})

test('buildInstallManifest sorts entries by relativePath', () => {
  const m = buildInstallManifest(REPO_ROOT, FAKE_HOME)
  for (let i = 1; i < m.length; i++) {
    if (m[i].relativePath < m[i - 1].relativePath) {
      throw new Error(`unsorted at index ${i}: ${m[i - 1].relativePath} > ${m[i].relativePath}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Layer 2 — migration-cutover over a synthetic GLOBAL-only repo.
// The cutover filters scope:'project', so it only verifies global substrate +
// dev/CI tooling + global libs + patterns/_index.json. We mirror a minimal
// global-scoped tree and exercise OK / DIFF / MISSING.
// ---------------------------------------------------------------------------
const synthRepo = path.join(tmpRoot, 'repo')
const synthHome = path.join(tmpRoot, 'home')

function mkfile(p, content = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// Global-scoped sources only (substrate scripts + a shared lib + pattern index).
// NOTE: no enforce-contract / bp1 / marker scripts here — they'd be scope:'project'
// and filtered by the cutover, so their absence is irrelevant to this layer.
mkfile(path.join(synthRepo, 'scripts/em-recall.mjs'), 'er\n')
mkfile(path.join(synthRepo, 'scripts/em-store.mjs'), 'es\n')
mkfile(path.join(synthRepo, 'scripts/lib/local-dir.mjs'), 'ld\n')
mkfile(path.join(synthRepo, 'patterns/_index.json'), '{}\n')

// The global-scoped subset the cutover actually verifies for this synth repo.
function globalManifest() {
  return buildInstallManifest(synthRepo, synthHome).filter(e => e.scope !== 'project')
}

console.log('\nLayer 2 — migration-cutover (global-scoped only):')

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

test('cutover excludes scope:project (no hook / engine / bp1 entries in results)', () => {
  // Install the global subset so the run is all-OK, then assert NO project-scoped
  // path appears in the cutover results.
  for (const entry of globalManifest()) {
    fs.mkdirSync(path.dirname(entry.installedPath), { recursive: true })
    fs.copyFileSync(entry.repoPath, entry.installedPath)
  }
  const result = runCutover(synthRepo, synthHome)
  const projectish = result.results.filter(r =>
    r.relativePath.startsWith('plugins/claude-code/hooks/') ||
    /scripts\/(enforce-contract|classifier-|classify-|bp1-|checkpoint-marker|plan-marker|preflight-marker)/.test(r.relativePath)
  )
  if (projectish.length > 0) {
    throw new Error(`cutover included scope:project entries: ${projectish.map(r => r.relativePath).join(', ')}`)
  }
})

test('all-OK (global subset installed identically) → exit 0', () => {
  const result = runCutover(synthRepo, synthHome)
  eq(result.allOk, true)
  eq(result.counts.OK, globalManifest().length)
})

test('one DIFF surfaces correctly → exit 1', () => {
  const installedRecall = path.join(synthHome, '.episodic-memory', 'scripts', 'em-recall.mjs')
  fs.writeFileSync(installedRecall, 'DRIFTED CONTENT\n')
  const result = runCutoverExpectFail(synthRepo, synthHome)
  eq(result.counts.DIFF, 1)
  const recallEntry = result.results.find(r => r.relativePath === 'scripts/em-recall.mjs')
  if (!recallEntry || recallEntry.status !== 'DIFF') {
    throw new Error(`expected DIFF for em-recall, got ${JSON.stringify(recallEntry)}`)
  }
  fs.copyFileSync(path.join(synthRepo, 'scripts/em-recall.mjs'), installedRecall)
})

test('one MISSING surfaces correctly → exit 1', () => {
  const installedLib = path.join(synthHome, '.episodic-memory', 'scripts', 'lib', 'local-dir.mjs')
  fs.unlinkSync(installedLib)
  const result = runCutoverExpectFail(synthRepo, synthHome)
  eq(result.counts.MISSING, 1)
  const lib = result.results.find(r => r.relativePath === 'scripts/lib/local-dir.mjs')
  if (!lib || lib.status !== 'MISSING') {
    throw new Error(`expected MISSING for local-dir, got ${JSON.stringify(lib)}`)
  }
  fs.copyFileSync(path.join(synthRepo, 'scripts/lib/local-dir.mjs'), installedLib)
})

test('all-MISSING (empty home) → exit 1, no OK', () => {
  const freshHome = path.join(tmpRoot, 'fresh-home')
  const result = runCutoverExpectFail(synthRepo, freshHome)
  eq(result.allOk, false)
  if (result.counts.OK) throw new Error(`unexpected OK count: ${result.counts.OK}`)
})

console.log()
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
