#!/usr/bin/env node
/**
 * test-so-gate-timeout-floor-integration.mjs — black-box integration tests
 * against the installed-gate runtime tree.
 *
 * Each test sets up a tempHome with a copy of hooks/second-opinion-gate.mjs
 * (and selectively hooks/lib/so-timeout-floor.mjs) so it exercises the
 * dynamic-import path from import.meta.url that the production hook actually
 * uses. This mirrors plan-v5 R3/P2.2 + R4/P1.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REPO_GATE = path.join(REPO_ROOT, 'plugins', 'claude-code', 'hooks', 'second-opinion-gate.mjs')
const REPO_LIB_DIR = path.join(REPO_ROOT, 'plugins', 'claude-code', 'hooks', 'lib')
const REPO_TIMEOUT_FLOOR = path.join(REPO_LIB_DIR, 'so-timeout-floor.mjs')
const REPO_LOCAL_DIR = path.join(REPO_ROOT, 'scripts', 'lib', 'local-dir.mjs')
const REPO_VALIDATOR = path.join(REPO_ROOT, 'scripts', 'second-opinion', 'lib', 'registry-validator.mjs')

const tmpDirs = []
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}: ${e.message}`)
    if (process.env.DEBUG) console.error(e.stack)
  }
}

function makeTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-tf-proj-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  fs.mkdirSync(path.join(tmp, '.checkpoints'), { recursive: true })
  return tmp
}

function makeTmpHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-tf-home-'))
  tmpDirs.push(tmp)
  fs.mkdirSync(path.join(tmp, 'hooks', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'hooks', 'runbooks'), { recursive: true })
  return tmp
}

function validRunbookContent() {
  return [
    '# Test runbook',
    '',
    '## ⚠️ Self-trigger checklist — fixture',
    '',
    'Padding: ' + 'x'.repeat(300),
    '',
    '## Other section',
    'lorem',
  ].join('\n')
}

function validQuickrefContent() {
  return '## Self-trigger checklist (quickref fixture)\n' + 'x'.repeat(80)
}

function computeSha8(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8)
}

/**
 * setupGateInstall — copy gate + selected libs to a tempHome and write
 * runbook + quickref. Returns paths the caller needs.
 *
 * opts:
 *   includeLib: copy hooks/lib/so-timeout-floor.mjs (default true)
 *   includeLocalDir: copy hooks/lib/local-dir.mjs (default true)
 *   includeValidator: copy hooks/lib/registry-validator.mjs (default true)
 *   runbookContent: full runbook body (default validRunbookContent())
 *   quickrefContent: quickref body (default validQuickrefContent())
 */
function setupGateInstall(opts = {}) {
  const {
    includeLib = true,
    includeLocalDir = true,
    includeValidator = true,
    runbookContent = validRunbookContent(),
    quickrefContent = validQuickrefContent(),
  } = opts
  const home = makeTmpHome()
  const hooksDir = path.join(home, 'hooks')
  const libDir = path.join(hooksDir, 'lib')
  const runbooksDir = path.join(hooksDir, 'runbooks')

  const gateDst = path.join(hooksDir, 'second-opinion-gate.mjs')
  fs.copyFileSync(REPO_GATE, gateDst)

  if (includeLib) {
    fs.copyFileSync(REPO_TIMEOUT_FLOOR, path.join(libDir, 'so-timeout-floor.mjs'))
  }
  if (includeLocalDir) {
    fs.copyFileSync(REPO_LOCAL_DIR, path.join(libDir, 'local-dir.mjs'))
  }
  if (includeValidator) {
    fs.copyFileSync(REPO_VALIDATOR, path.join(libDir, 'registry-validator.mjs'))
  }

  const runbookPath = path.join(runbooksDir, 'second-opinion-harness.md')
  const quickrefPath = path.join(runbooksDir, 'second-opinion-harness.quickref.md')
  fs.writeFileSync(runbookPath, runbookContent)
  fs.writeFileSync(quickrefPath, quickrefContent)

  return {
    home,
    gateDst,
    runbookPath,
    quickrefPath,
    sha8: computeSha8(runbookContent),
  }
}

function armRunbookMarker(projectRoot, sha8) {
  const markerPath = path.join(projectRoot, '.checkpoints', `.so-runbook-shown.${sha8}`)
  fs.writeFileSync(markerPath, '')
  return markerPath
}

function runHook({ gateDst, toolName = 'Bash', toolInput, cwd, env = {} }) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd })
  const result = spawnSync('node', [gateDst], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10000,
  })
  if (result.status !== 0) {
    throw new Error(`Hook exited non-zero (${result.status}); stderr: ${result.stderr}`)
  }
  const stdout = result.stdout.trim()
  if (!stdout) return { allow: true }
  return { allow: false, decision: JSON.parse(stdout) }
}

// ---------------------------------------------------------------------------
// Test cases (plan v5 §File 6)
// ---------------------------------------------------------------------------

console.log('# Timeout-floor integration')

test('happy path: timeout 600000 + runbook marker armed → allow', () => {
  const project = makeTmpProject()
  const setup = setupGateInstall()
  armRunbookMarker(project, setup.sha8)
  const r = runHook({
    gateDst: setup.gateDst,
    toolInput: {
      command: 'node scripts/second-opinion.mjs request --provider codex --dispatch --body x',
      timeout: 600000,
    },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: setup.runbookPath,
      SO_QUICKREF_PATH: setup.quickrefPath,
    },
  })
  assert.strictEqual(r.allow, true, `expected allow, got ${JSON.stringify(r.decision)}`)
})

test('below-floor block: timeout 120000 → so-timeout-below-floor', () => {
  const project = makeTmpProject()
  const setup = setupGateInstall()
  armRunbookMarker(project, setup.sha8)
  const r = runHook({
    gateDst: setup.gateDst,
    toolInput: {
      command: 'node scripts/second-opinion.mjs request --provider codex --dispatch --body x',
      timeout: 120000,
    },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: setup.runbookPath,
      SO_QUICKREF_PATH: setup.quickrefPath,
    },
  })
  assert.strictEqual(r.allow, false, 'expected block')
  assert.strictEqual(r.decision.decision, 'block')
  assert.strictEqual(r.decision.code, 'so-timeout-below-floor')
  assert.strictEqual(r.decision.gotMs, 120000)
  assert.strictEqual(r.decision.floorMs, 600000)
})

test('consensus below-floor: --consensus + timeout 120000 → block', () => {
  const project = makeTmpProject()
  const setup = setupGateInstall()
  armRunbookMarker(project, setup.sha8)
  const r = runHook({
    gateDst: setup.gateDst,
    toolInput: {
      command: 'node scripts/second-opinion.mjs request --provider codex --consensus --body x',
      timeout: 120000,
    },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: setup.runbookPath,
      SO_QUICKREF_PATH: setup.quickrefPath,
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'so-timeout-below-floor')
})

test('compound bypass: stub ; codex --dispatch → block (R3/P1.1 fix)', () => {
  const project = makeTmpProject()
  const setup = setupGateInstall()
  armRunbookMarker(project, setup.sha8)
  const r = runHook({
    gateDst: setup.gateDst,
    toolInput: {
      command:
        'node scripts/second-opinion.mjs request --provider stub --body x ; ' +
        'node scripts/second-opinion.mjs request --provider codex --dispatch --body y',
      timeout: 120000,
    },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: setup.runbookPath,
      SO_QUICKREF_PATH: setup.quickrefPath,
    },
  })
  assert.strictEqual(r.allow, false, `expected block, got ${JSON.stringify(r.decision)}`)
  assert.strictEqual(r.decision.code, 'so-timeout-below-floor')
})

test('fail-closed: missing lib/so-timeout-floor.mjs → so-timeout-floor-load-failed', () => {
  const project = makeTmpProject()
  const setup = setupGateInstall({ includeLib: false })
  const r = runHook({
    gateDst: setup.gateDst,
    toolInput: {
      command: 'node scripts/second-opinion.mjs request --provider codex --dispatch --body x',
      timeout: 600000,
    },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: setup.runbookPath,
      SO_QUICKREF_PATH: setup.quickrefPath,
    },
  })
  assert.strictEqual(r.allow, false, `expected block, got ${JSON.stringify(r.decision)}`)
  assert.strictEqual(r.decision.code, 'so-timeout-floor-load-failed')
  // Critical R4/P2 ordering check: this must fire BEFORE runbook validation.
  // Marker was NOT armed; if runbook gate ran first we'd get
  // runbook-injection-required instead.
})

console.log(`\n${passed} pass, ${failed} fail`)
if (failed > 0) process.exit(1)
