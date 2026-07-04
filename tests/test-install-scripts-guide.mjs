#!/usr/bin/env node
/**
 * test-install-scripts-guide.mjs — Regression test that install.mjs deploys the
 * agent-facing EM_SCRIPTS_GUIDE.md to ~/.episodic-memory/ on every install.
 *
 * Context: foreign coding harnesses kept mis-using the em-* scripts (and one Pi
 * Agent session hand-wrote an episode + a raw index.jsonl row that crashed em-list
 * for later sessions). The fix ships an agent-facing per-script guide and has the
 * installer copy it to the global root so any tool can read it before first use.
 * This test pins that copy step: it runs the REAL installer with an isolated HOME
 * into a mkdtemp target project and asserts the guide lands, is non-empty, and
 * carries a distinctive heading from the source guide.
 *
 * Usage: node tests/test-install-scripts-guide.mjs
 * Zero deps — Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import assert from 'assert'
import { fileURLToPath } from 'url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = path.join(REPO, 'install.mjs')
const SOURCE_GUIDE = path.join(REPO, 'docs', 'EM_SCRIPTS_GUIDE.md')

// A distinctive heading string that must survive the copy. Read it from the
// SOURCE file so the assertion is not a self-fulfilling literal — the test proves
// the deployed copy matches the real source heading.
const DISTINCTIVE_HEADING = '# EM Scripts Guide (agent-facing)'

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

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-scripts-guide-test-')))
  const home = path.join(root, 'home')
  const proj = path.join(root, 'proj')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(proj, { recursive: true })
  return {
    root, home, proj,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function runInstall(sandbox, tool) {
  return spawnSync('node', [INSTALL, '--tool', tool, '--project', sandbox.proj], {
    cwd: sandbox.root,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
  })
}

console.log('install.mjs EM_SCRIPTS_GUIDE.md deployment:')

test('source guide exists and carries the distinctive heading', () => {
  assert.ok(fs.existsSync(SOURCE_GUIDE), `missing source guide at ${SOURCE_GUIDE}`)
  const src = fs.readFileSync(SOURCE_GUIDE, 'utf8')
  assert.ok(src.includes(DISTINCTIVE_HEADING), 'source guide is missing its own heading')
})

test('install exits 0 and reports the guide copy', () => {
  const s = makeSandbox()
  try {
    const r = runInstall(s, 'cursor')
    assert.strictEqual(r.status, 0, `install failed (exit ${r.status}): ${r.stderr}`)
    assert.ok(
      r.stdout.includes('Installed EM_SCRIPTS_GUIDE.md'),
      `installer stdout did not report the guide copy:\n${r.stdout}`
    )
  } finally { s.cleanup() }
})

test('guide is deployed non-empty with the distinctive heading', () => {
  const s = makeSandbox()
  try {
    const r = runInstall(s, 'cursor')
    assert.strictEqual(r.status, 0, `install failed (exit ${r.status}): ${r.stderr}`)
    const deployed = path.join(s.home, '.episodic-memory', 'EM_SCRIPTS_GUIDE.md')
    assert.ok(fs.existsSync(deployed), `guide not deployed at ${deployed}`)
    const body = fs.readFileSync(deployed, 'utf8')
    assert.ok(body.length > 0, 'deployed guide is empty')
    assert.ok(
      body.includes(DISTINCTIVE_HEADING),
      'deployed guide is missing the distinctive heading from the source'
    )
    // Byte-for-byte match with the source is the strongest form of "correct copy".
    assert.strictEqual(
      body,
      fs.readFileSync(SOURCE_GUIDE, 'utf8'),
      'deployed guide differs from the source guide'
    )
  } finally { s.cleanup() }
})

test('guide is deployed for a non-Claude tool too (windsurf)', () => {
  const s = makeSandbox()
  try {
    const r = runInstall(s, 'windsurf')
    assert.strictEqual(r.status, 0, `install failed (exit ${r.status}): ${r.stderr}`)
    const deployed = path.join(s.home, '.episodic-memory', 'EM_SCRIPTS_GUIDE.md')
    assert.ok(fs.existsSync(deployed), `guide not deployed for windsurf at ${deployed}`)
  } finally { s.cleanup() }
})

console.log()
console.log(`Tests: ${passed + failed}  passed: ${passed}  failed: ${failed}`)
if (failed > 0) {
  console.log()
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}\n    ${f.error}`)
  process.exit(1)
}
