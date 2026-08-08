#!/usr/bin/env node
/**
 * test-opencode-env-propagation.mjs — Issue #516 regression test.
 *
 * Mirrors tests/test-codex-env-propagation.mjs (#636) for the opencode
 * provider. opencode.mjs was one of the unfixed same-class siblings
 * identified in #516: it spawned with NO `env:` key, so it silently
 * inherited process.env without the CLAUDE_SCHEDULED_TASK marker — a
 * headless `opencode run` seat spawned that way obeys a project's blocking
 * session-start hook and replies with the first y/n question instead of a
 * review.
 *
 * Invariants:
 *   I-516a: dispatch() forces CLAUDE_SCHEDULED_TASK=1 into child env
 *           regardless of parent state.
 *   I-516b: dispatch() preserves inherited env (PATH/HOME/auth).
 *   I-516c: child runs with PWD === projectRoot even when caller cwd
 *           differs; no side-effect dirs leak under caller cwd.
 *
 * Strategy: install an `opencode` shim in a test-controlled PATH dir, point
 * dispatch at a different `projectRoot`, run it from a third `callerDir`,
 * and verify the shim's stdout matches the invariants. The shim ignores its
 * argv (`run -m <model> <prompt>`), same as the codex twin ignores
 * `exec --skip-git-repo-check <prompt>`.
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
const PROVIDER_PATH = path.join(REPO_ROOT, 'scripts', 'second-opinion', 'providers', 'opencode.mjs')

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

console.log('# test-opencode-env-propagation (issue #516)')

await asyncTest('dispatch propagates CLAUDE_SCHEDULED_TASK=1 + cwd binding + no side-effect leaks', async () => {
  // mkdtemp three dirs; realpath each immediately (macOS /var ↔ /private/var).
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-516-opencode-bin-')))
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-516-opencode-proj-')))
  const callerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'so-516-opencode-caller-')))

  const originalPath = process.env.PATH
  const originalScheduled = process.env.CLAUDE_SCHEDULED_TASK
  const originalCwd = process.cwd()

  try {
    // Narrow shim: 3 echoes only — no full `env` dump (avoids secret leak in
    // CI failure logs, same rule as the #636/#232 tests). Ignores its argv
    // (`run -m <model> <prompt>`).
    const shimPath = path.join(binDir, 'opencode')
    fs.writeFileSync(
      shimPath,
      '#!/bin/sh\n' +
      'echo "CLAUDE_SCHEDULED_TASK=${CLAUDE_SCHEDULED_TASK}"\n' +
      'echo "PWD=$(pwd)"\n' +
      'echo "PATH=${PATH}"\n',
      { mode: 0o755 }
    )

    // Caller cwd ≠ projectRoot.
    process.chdir(callerDir)

    // Regression-state parent env: shim on PATH, marker explicitly unset so
    // the test starts from the bug's actual parent-env shape.
    process.env.PATH = binDir + path.delimiter + originalPath
    delete process.env.CLAUDE_SCHEDULED_TASK

    // Pre-condition negative spawn: direct shim spawn (no dispatch) must show
    // the marker empty in the parent env — guards a vacuous pass.
    const preCheck = spawnSync('opencode', [], {
      env: process.env,
      cwd: callerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.strictEqual(preCheck.status, 0,
      `pre-check shim failed: ${preCheck.stderr?.toString()}`)
    assert.match(preCheck.stdout.toString(), /^CLAUDE_SCHEDULED_TASK=\s*$/m,
      `pre-condition vacuous-pass guard: expected empty CLAUDE_SCHEDULED_TASK in parent env, ` +
      `got stdout=${JSON.stringify(preCheck.stdout.toString())}`)

    // Import provider + dispatch.
    const mod = await import(`${pathToFileURL(PROVIDER_PATH).href}?cb=${Date.now()}`)
    const result = mod.dispatch({ prompt: 'x', projectRoot: projectDir })
    assert.strictEqual(result.exitCode, 0,
      `dispatch exit code: expected 0, got ${result.exitCode} stderr=${result.stderr}`)

    // I-516a — env override.
    assert.match(result.stdout, /^CLAUDE_SCHEDULED_TASK=1$/m,
      `I-516a: expected CLAUDE_SCHEDULED_TASK=1 in child env, ` +
      `got stdout=${JSON.stringify(result.stdout)}`)

    // I-516c — cwd binding via realpath comparison.
    const pwdMatch = result.stdout.match(/^PWD=(.+)$/m)
    assert.ok(pwdMatch, `I-516c: expected PWD=<value> line in stdout`)
    const childPwdReal = fs.realpathSync(pwdMatch[1])
    const projectDirReal = fs.realpathSync(projectDir)
    assert.strictEqual(childPwdReal, projectDirReal,
      `I-516c: child PWD must equal projectRoot (realpath). ` +
      `child=${childPwdReal} expected=${projectDirReal}`)

    // I-516b — PATH propagation.
    assert.match(result.stdout, new RegExp(`^PATH=.*${escapeRegex(binDir)}`, 'm'),
      `I-516b: expected binDir on child PATH, ` +
      `got stdout=${JSON.stringify(result.stdout)}`)

    // Side-effect leak: no artifact dirs under callerDir.
    const leakNames = ['.review-store', '.episodic-memory', '.checkpoints']
    const callerContents = fs.readdirSync(callerDir)
    const leaked = callerContents.filter((n) => leakNames.includes(n))
    assert.deepStrictEqual(leaked, [],
      `I-516c: expected no side-effect dirs under callerDir, found ${JSON.stringify(leaked)}`)
  } finally {
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
