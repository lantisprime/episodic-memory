#!/usr/bin/env node
/**
 * test-em-help-flags.mjs - Regression tests for the --help / -h short-circuit
 * on the installed substrate scripts.
 *
 * Bug context: most substrate scripts had no --help handler, so an unknown flag
 * was silently ignored and the script ran its DEFAULT behavior. Probing
 * `em-prune --help` actually executed a real prune pass; em-rebuild-index
 * rewrote the index; em-seed-patterns would seed. Every AI harness probes CLIs
 * with --help, so this was an agent footgun.
 *
 * Fix: each script short-circuits on --help / -h with a single JSON object
 * ({ status: 'help', script, usage }) on stdout, exit 0, BEFORE any filesystem,
 * store, or subprocess side effect. This test pins:
 *   1. --help returns exit 0, EXACTLY one JSON object on stdout with EXACTLY
 *      the keys {script, status, usage}, script matching the invoked basename,
 *      status 'help', non-empty usage string, and empty stderr (codex PR #449
 *      round-1 B1/B2: em-restore shipped without the script key and the loose
 *      assertions let it pass).
 *   2. No .episodic-memory store gets created under the sandbox HOME or cwd
 *      (proves the short-circuit fires before store creation).
 *   3. em-list also honors the -h alias.
 *   4. Negative control: em-store WITHOUT --help DOES create the store, so the
 *      step-2 assertion actually discriminates.
 *   5. Belt-and-braces: prune/seed/rebuild --help emit no work-result keys.
 *   6. Pinned token semantics (codex round-1 B3, invariant narrowed by design):
 *      a STANDALONE --help/-h argv token triggers help wherever it appears,
 *      INCLUDING in value position of another flag (em-store --summary --help
 *      prints help and stores nothing). Detecting value-position help tokens
 *      would require mirroring each script's parser; the pre-existing flag()
 *      parsers share the same token-collision class, and a literal '--help'
 *      value is the same argv token even when quoted. em-lock is the one
 *      deliberate exception: tokens after its -- separator belong to the
 *      wrapped command and never trigger help.
 *
 * Usage: node tests/test-em-help-flags.mjs
 * Zero deps - Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPTS = path.join(REPO, 'scripts')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-help-flags-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  return {
    root, home, cwd,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function run(script, args, sandbox) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function parseJSON(stdout) {
  return JSON.parse(stdout.trim())
}

// Exact help-contract assertion (codex PR #449 round-1 B1/B2): exactly one
// JSON object on stdout, exactly the keys {script, status, usage}, script
// matching the invoked basename, empty stderr.
function assertHelpContract(r, script, label) {
  assert.strictEqual(r.code, 0, `${label}: exit code ${r.code} (stderr: ${r.stderr})`)
  assert.strictEqual(r.stderr, '', `${label}: stderr not empty: ${r.stderr}`)
  // Exactly ONE JSON value on stdout: JSON.parse of the whole trimmed stream
  // throws on trailing content, so concatenated objects or extra prose fail.
  // (em-restore pretty-prints its object over multiple lines; that is fine.)
  let json
  try {
    json = JSON.parse(r.stdout.trim())
  } catch (e) {
    throw new Error(`${label}: stdout is not exactly one JSON value: ${e.message}\n${r.stdout}`)
  }
  assert.deepStrictEqual(
    Object.keys(json).sort(), ['script', 'status', 'usage'],
    `${label}: keys were ${JSON.stringify(Object.keys(json).sort())}`)
  assert.strictEqual(json.status, 'help', `${label}: status was ${JSON.stringify(json.status)}`)
  assert.strictEqual(json.script, script, `${label}: script was ${JSON.stringify(json.script)}`)
  assert.ok(typeof json.usage === 'string' && json.usage.length > 0, `${label}: usage missing/empty`)
  return json
}

// Recursively test whether any file named `name` exists anywhere under `dir`.
function existsAnywhere(dir, name) {
  let found = false
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch { continue }
    for (const ent of entries) {
      const full = path.join(cur, ent.name)
      if (ent.name === name) { found = true; return found }
      if (ent.isDirectory()) stack.push(full)
    }
  }
  return found
}

// Assert no .episodic-memory store leaked into the sandbox after a --help run.
function assertNoStore(sandbox, label) {
  assert.strictEqual(
    fs.existsSync(path.join(sandbox.home, '.episodic-memory')), false,
    `${label}: .episodic-memory created under sandbox HOME (short-circuit fired too late)`)
  assert.strictEqual(
    fs.existsSync(path.join(sandbox.cwd, '.episodic-memory')), false,
    `${label}: .episodic-memory created under sandbox cwd (short-circuit fired too late)`)
}

// ---------------------------------------------------------------------------
// The installed substrate set: every script that got a --help handler.
// ---------------------------------------------------------------------------
const SUBSTRATE = [
  'em-audit-compliance.mjs', 'em-backup.mjs', 'em-check-stale.mjs', 'em-list.mjs',
  'em-lock.mjs', 'em-mine-transcripts.mjs', 'em-pattern-health.mjs', 'em-prune.mjs',
  'em-rebuild-index.mjs', 'em-recall.mjs', 'em-restore.mjs', 'em-review-request.mjs',
  'em-revise.mjs', 'em-rfc-validate.mjs', 'em-search.mjs', 'em-seed-patterns.mjs',
  'em-store.mjs', 'em-violation.mjs', 'em-watch-codex.mjs', 'em-workflow-validate.mjs',
  'second-opinion.mjs',
]

console.log('--help contract (every substrate script):')

for (const script of SUBSTRATE) {
  test(`${script} --help -> exact help contract, exit 0, no store`, () => {
    const s = makeSandbox()
    try {
      const r = run(script, ['--help'], s)
      assertHelpContract(r, script, `${script} --help`)
      assertNoStore(s, `${script} --help`)
    } finally { s.cleanup() }
  })
}

// ---------------------------------------------------------------------------
// -h short alias (covered at least once via em-list)
// ---------------------------------------------------------------------------
console.log('-h short alias:')

test('em-list.mjs -h -> exact help contract, exit 0, no store', () => {
  const s = makeSandbox()
  try {
    const r = run('em-list.mjs', ['-h'], s)
    assertHelpContract(r, 'em-list.mjs', 'em-list.mjs -h')
    assertNoStore(s, 'em-list.mjs -h')
  } finally { s.cleanup() }
})

// ---------------------------------------------------------------------------
// Pinned token semantics (codex round-1 B3, narrowed invariant): a standalone
// --help token triggers help even in value position of another flag. Chosen by
// design over parser-mirroring; see header comment item 6.
// ---------------------------------------------------------------------------
console.log('pinned token semantics (value-position --help):')

test('em-store.mjs --summary --help -> help output, nothing stored', () => {
  const s = makeSandbox()
  try {
    const r = run('em-store.mjs', [
      '--project', 't', '--category', 'decision',
      '--summary', '--help', '--body', 'b', '--scope', 'global',
    ], s)
    assertHelpContract(r, 'em-store.mjs', 'em-store.mjs --summary --help')
    assertNoStore(s, 'em-store.mjs --summary --help')
  } finally { s.cleanup() }
})

test('em-lock.mjs wrapped command owns --help after the -- separator', () => {
  const s = makeSandbox()
  try {
    const lockFile = path.join(s.root, 'lockfile')
    // node's own `--` ends node's option parsing, so the trailing --help lands
    // in the wrapped script's process.argv instead of triggering node's help
    // (codex PR #449 round-2 P2: the previous spelling made node print its own
    // help and the assertion passed vacuously).
    const r = run('em-lock.mjs', [
      '--file', lockFile, '--timeout', '2', '--',
      process.execPath, '-e', 'console.log("wrapped-ran " + process.argv.slice(1).join(" "))', '--', '--help',
    ], s)
    assert.strictEqual(r.code, 0, `exit code ${r.code} (stderr: ${r.stderr})`)
    assert.ok(r.stdout.includes('wrapped-ran'), `wrapped command did not run: ${r.stdout}`)
    assert.ok(r.stdout.includes('wrapped-ran --help'), `wrapped command did not receive its --help arg: ${r.stdout}`)
    assert.ok(!r.stdout.includes('"status":"help"'), `em-lock intercepted the wrapped command's --help: ${r.stdout}`)
  } finally { s.cleanup() }
})

// ---------------------------------------------------------------------------
// Negative control: proves the no-store assertion discriminates.
// ---------------------------------------------------------------------------
console.log('negative controls (discrimination):')

test('em-list.mjs WITHOUT --help -> status ok, exit 0', () => {
  const s = makeSandbox()
  try {
    const r = run('em-list.mjs', [], s)
    assert.strictEqual(r.code, 0, `exit code ${r.code} (stderr: ${r.stderr})`)
    const json = parseJSON(r.stdout)
    assert.strictEqual(json.status, 'ok', `status was ${JSON.stringify(json.status)}`)
  } finally { s.cleanup() }
})

test('em-store.mjs WITHOUT --help DOES create the store under HOME', () => {
  const s = makeSandbox()
  try {
    const r = run('em-store.mjs', [
      '--project', 't', '--category', 'decision',
      '--summary', 's', '--body', 'b', '--scope', 'global',
    ], s)
    assert.strictEqual(r.code, 0, `exit code ${r.code} (stderr: ${r.stderr})`)
    const json = parseJSON(r.stdout)
    assert.strictEqual(json.status, 'ok', `status was ${JSON.stringify(json.status)}`)
    assert.strictEqual(
      fs.existsSync(path.join(s.home, '.episodic-memory')), true,
      'em-store did NOT create .episodic-memory under HOME; the step-2 assertion would not discriminate')
  } finally { s.cleanup() }
})

// ---------------------------------------------------------------------------
// Belt-and-braces: destructive/mutating scripts must emit no work-result keys.
// ---------------------------------------------------------------------------
console.log('belt-and-braces (no work performed on --help):')

test('em-prune.mjs --help emits no pruned/results key', () => {
  const s = makeSandbox()
  try {
    const json = parseJSON(run('em-prune.mjs', ['--help'], s).stdout)
    assert.strictEqual(json.status, 'help')
    assert.ok(!('results' in json), 'unexpected results key')
    assert.ok(!('pruned' in json), 'unexpected pruned key')
  } finally { s.cleanup() }
})

test('em-seed-patterns.mjs --help emits no seeded key', () => {
  const s = makeSandbox()
  try {
    const json = parseJSON(run('em-seed-patterns.mjs', ['--help'], s).stdout)
    assert.strictEqual(json.status, 'help')
    assert.ok(!('seeded' in json), 'unexpected seeded key')
  } finally { s.cleanup() }
})

test('em-rebuild-index.mjs --help emits no rebuilt key and writes no index.jsonl', () => {
  const s = makeSandbox()
  try {
    const json = parseJSON(run('em-rebuild-index.mjs', ['--help'], s).stdout)
    assert.strictEqual(json.status, 'help')
    assert.ok(!('rebuilt' in json), 'unexpected rebuilt key')
    assert.strictEqual(existsAnywhere(s.root, 'index.jsonl'), false, 'index.jsonl was written under sandbox')
  } finally { s.cleanup() }
})

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
