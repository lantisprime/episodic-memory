#!/usr/bin/env node
/**
 * test-claude-subagent-env-propagation.mjs — Issue #232 regression test.
 *
 * Invariants (from plan):
 *   I-232a: dispatch() forces CLAUDE_SCHEDULED_TASK=1 into child env
 *           regardless of parent state.
 *   I-232b: dispatch() preserves inherited env (PATH/HOME/auth).
 *   I-232c: child runs with PWD === projectRoot even when caller cwd
 *           differs; no side-effect dirs leak under caller cwd.
 *
 * Strategy: install a `claude` shim in a test-controlled PATH dir, point
 * dispatch at a different `projectRoot`, run it from a third `callerDir`,
 * and verify the shim's stdout matches the invariants.
 *
 * Zero deps. Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PROVIDER_PATH = path.join(REPO_ROOT, 'scripts', 'second-opinion', 'providers', 'claude-subagent.mjs')

let passed = 0
let failed = 0
const failures = []

async function asyncTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

console.log('# test-claude-subagent-env-propagation (issue #232)')

await asyncTest('dispatch propagates CLAUDE_SCHEDULED_TASK=1 + cwd binding + no side-effect leaks', async () => {
  // Step 1: mkdtemp three dirs; realpath each immediately (macOS /var ↔
  // /private/var neutralization).
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-232-bin-')))
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-232-proj-')))
  const callerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-232-caller-')))

  // Step 3: save originals so finally can restore.
  const originalPath = process.env.PATH
  const originalScheduled = process.env.CLAUDE_SCHEDULED_TASK
  const originalCwd = process.cwd()

  try {
    // Step 2: write narrow shim. 3 echoes only — no full `env` dump
    // (avoids secret leak in CI failure logs per codex round-1).
    const shimPath = path.join(binDir, 'claude')
    fs.writeFileSync(
      shimPath,
      '#!/bin/sh\n' +
      'echo "CLAUDE_SCHEDULED_TASK=${CLAUDE_SCHEDULED_TASK}"\n' +
      'echo "PWD=$(pwd)"\n' +
      'echo "PATH=${PATH}"\n',
      { mode: 0o755 }
    )

    // Step 1 (cont): chdir to callerDir so caller cwd ≠ projectRoot.
    process.chdir(callerDir)

    // Step 4: regression-state parent env. binDir on PATH so the child
    // `claude` resolves to the shim; CLAUDE_SCHEDULED_TASK explicitly
    // unset so the test starts from the bug's actual parent-env shape.
    process.env.PATH = binDir + path.delimiter + originalPath
    delete process.env.CLAUDE_SCHEDULED_TASK

    // Step 5: pre-condition negative spawn. Direct spawn of the shim
    // (no dispatch) must show CLAUDE_SCHEDULED_TASK is empty in the
    // parent env. Guards against any layer leaking the var and making
    // this test a vacuous pass.
    const preCheck = spawnSync('claude', [], {
      env: process.env,
      cwd: callerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.strictEqual(preCheck.status, 0,
      `pre-check shim failed: ${preCheck.stderr?.toString()}`)
    assert.match(preCheck.stdout.toString(), /^CLAUDE_SCHEDULED_TASK=\s*$/m,
      `pre-condition vacuous-pass guard: expected empty CLAUDE_SCHEDULED_TASK in parent env, ` +
      `got stdout=${JSON.stringify(preCheck.stdout.toString())}`)

    // Step 6: import provider + dispatch.
    const mod = await import(`${pathToFileURL(PROVIDER_PATH).href}?cb=${Date.now()}`)
    const result = mod.dispatch({ prompt: 'x', projectRoot: projectDir })
    assert.strictEqual(result.exitCode, 0,
      `dispatch exit code: expected 0, got ${result.exitCode} stderr=${result.stderr}`)

    // Step 7: I-232a — env override.
    assert.match(result.stdout, /^CLAUDE_SCHEDULED_TASK=1$/m,
      `I-232a: expected CLAUDE_SCHEDULED_TASK=1 in child env, ` +
      `got stdout=${JSON.stringify(result.stdout)}`)

    // Step 8: I-232c — cwd binding via realpath comparison (macOS
    // /var vs /private/var divergence per codex round 2).
    const pwdMatch = result.stdout.match(/^PWD=(.+)$/m)
    assert.ok(pwdMatch, `I-232c: expected PWD=<value> line in stdout`)
    const childPwdReal = fs.realpathSync(pwdMatch[1])
    const projectDirReal = fs.realpathSync(projectDir)
    assert.strictEqual(childPwdReal, projectDirReal,
      `I-232c: child PWD must equal projectRoot (realpath). ` +
      `child=${childPwdReal} expected=${projectDirReal}`)

    // Step 9: I-232b — PATH propagation.
    assert.match(result.stdout, new RegExp(`^PATH=.*${escapeRegex(binDir)}`, 'm'),
      `I-232b: expected binDir on child PATH, ` +
      `got stdout=${JSON.stringify(result.stdout)}`)

    // Step 10: side-effect leak. No artifact dirs under callerDir.
    const leakNames = ['.review-store', '.episodic-memory', '.checkpoints']
    const callerContents = fs.readdirSync(callerDir)
    const leaked = callerContents.filter((n) => leakNames.includes(n))
    assert.deepStrictEqual(leaked, [],
      `I-232c: expected no side-effect dirs under callerDir, found ${JSON.stringify(leaked)}`)
  } finally {
    // Step 11: restore env, cwd, fixtures.
    process.chdir(originalCwd)
    process.env.PATH = originalPath
    if (originalScheduled === undefined) {
      delete process.env.CLAUDE_SCHEDULED_TASK
    } else {
      process.env.CLAUDE_SCHEDULED_TASK = originalScheduled
    }
    try { fs.rmSync(binDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(projectDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(callerDir, { recursive: true, force: true }) } catch {}
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
