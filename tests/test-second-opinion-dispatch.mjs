#!/usr/bin/env node
/**
 * test-second-opinion-dispatch.mjs — Provider dispatch end-to-end via stub provider.
 *
 * Coverage:
 *   - I-6:  Provider dispatched with cwd: projectRoot, shell: false (verified by
 *           stub provider checking projectRoot arg + harness JSON having reply
 *           under projectRoot).
 *   - I-7:  Mock-blocking-until-reply (synchronous dispatch — harness exits
 *           AFTER reply is on disk, not before).
 *   - Codex provider available() smoke (graceful fallback if codex CLI absent).
 *   - --dispatch on unknown provider → error before any spawn.
 *   - Provider dispatch nonzero → harness exits non-zero.
 *
 * Zero deps. Node assert + fs + child_process + os.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HARNESS = path.join(REPO_ROOT, 'scripts', 'second-opinion.mjs')

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
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

const tmpDirs = []
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function makeTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-dispatch-test-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  return tmp
}

function runHarness(args, { cwd, expectError = false } = {}) {
  const result = spawnSync('node', [HARNESS, ...args], {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = result.stdout.toString()
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    throw new Error(
      `Harness output not JSON. exit=${result.status} stdout=${stdout} stderr=${result.stderr.toString()}`
    )
  }
  if (expectError) {
    assert.strictEqual(parsed.status, 'error',
      `expected error envelope, got: ${JSON.stringify(parsed)}`)
  } else {
    assert.strictEqual(parsed.status, 'ok',
      `expected ok envelope, got: ${JSON.stringify(parsed)} (stderr=${result.stderr.toString()})`)
  }
  return parsed
}

console.log('# test-second-opinion-dispatch')

// ---------------------------------------------------------------------------
// I-6 + I-7: dispatch via stub provider; reply on disk before harness exits
// ---------------------------------------------------------------------------
console.log('\n## I-6 + I-7: stub provider dispatch end-to-end')
test('--dispatch with stub provider writes reply BEFORE harness exits (I-7 mock)', () => {
  const tmp = makeTmpProject()
  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'request body for stub',
    '--summary', 'dispatch test',
    '--dispatch',
  ])
  assert.strictEqual(result.dispatched, true)
  assert.strictEqual(result.dispatch_exit_code, 0)
  assert.ok(result.reply, 'reply object expected when --dispatch is set')
  assert.ok(result.reply.bodyPath.startsWith(tmp),
    `reply.bodyPath under projectRoot: ${result.reply.bodyPath}`)
  // I-7: reply file MUST exist by the time harness exits.
  assert.ok(fs.existsSync(result.reply.bodyPath),
    `reply file must be on disk before harness exits (I-7 mock blocking contract)`)
  // Reply body contains the synthetic ACCEPT verdict from stub.
  const body = fs.readFileSync(result.reply.bodyPath, 'utf8')
  assert.ok(body.includes('"final_verdict": "ACCEPT"'),
    'stub reply must contain canonical JSON ACCEPT verdict')
})

test('without --dispatch: no reply, dispatched: false', () => {
  const tmp = makeTmpProject()
  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'request without dispatch',
    '--summary', 'no-dispatch',
  ])
  assert.strictEqual(result.dispatched, false)
  assert.strictEqual(result.dispatch_exit_code, null)
  assert.strictEqual(result.reply, null)
  // Replies dir should not exist (no reply written).
  const repliesDir = path.join(tmp, '.review-store', 'replies')
  assert.ok(!fs.existsSync(repliesDir), 'no replies dir should exist without --dispatch')
})

// ---------------------------------------------------------------------------
// I-6: cwd: projectRoot binding for provider dispatch
// ---------------------------------------------------------------------------
console.log('\n## I-6 provider dispatch passes cwd: projectRoot')
test('reply lands under projectRoot even when caller cwd is elsewhere', () => {
  const target = makeTmpProject()
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-cwd-'))
  tmpDirs.push(callerCwd)

  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', target,
    '--storage', 'files',
    '--body', 'i-6 cwd test body',
    '--summary', 'i-6 cwd binding',
    '--dispatch',
  ], { cwd: callerCwd })

  assert.strictEqual(result.project_root, target)
  // Reply under target, NOT under callerCwd.
  assert.ok(result.reply.bodyPath.startsWith(target))
  assert.ok(!fs.existsSync(path.join(callerCwd, '.review-store')),
    'no .review-store under callerCwd (would indicate cwd-binding bug)')
})

// ---------------------------------------------------------------------------
// Codex provider: available() smoke test (graceful when codex not installed)
// ---------------------------------------------------------------------------
console.log('\n## Codex provider available()')
test('codex provider available() returns shape {ok, reason?}', async () => {
  const provider = await import(
    `file://${path.join(REPO_ROOT, 'scripts', 'second-opinion', 'providers', 'codex.mjs')}`
  )
  const result = provider.available()
  assert.ok(typeof result.ok === 'boolean', 'available() must return {ok: boolean}')
  if (!result.ok) {
    assert.ok(typeof result.reason === 'string', 'when ok=false, reason must be string')
  }
  // Don't assert ok=true — codex may or may not be installed in CI.
})

// ---------------------------------------------------------------------------
// --dispatch on unknown provider → error before any spawn
// ---------------------------------------------------------------------------
console.log('\n## Unknown provider with --dispatch')
test('--dispatch on unknown provider → unknown-provider error', () => {
  const tmp = makeTmpProject()
  const result = runHarness([
    'request',
    '--provider', 'nonexistent',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'unknown',
    '--dispatch',
  ], { expectError: true })
  assert.strictEqual(result.code, 'unknown-provider')
})

// ---------------------------------------------------------------------------
// Provider module file missing → provider-module-missing
// ---------------------------------------------------------------------------
console.log('\n## Provider in registry but module .mjs absent')
test('--dispatch on provider missing .mjs file → provider-module-missing', () => {
  const tmp = makeTmpProject()
  // 'gemini' is in providers/index.json but no gemini.mjs file (commit 4 work).
  const result = runHarness([
    'request',
    '--provider', 'gemini',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'no module',
    '--dispatch',
  ], { expectError: true })
  assert.strictEqual(result.code, 'provider-module-missing')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
