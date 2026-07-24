#!/usr/bin/env node
/**
 * test-so-reply-sanity-e2e.mjs — end-to-end coverage for the #538 reply-sanity
 * gate, driving the REAL harness CLI with the stub provider.
 *
 * Coverage: REQ-7 (single dispatch rejects), REQ-8 (nothing persisted),
 * REQ-9 (forensics written), REQ-10 (no consensus round counted),
 * REQ-11 (happy path unchanged), REQ-12 (invalid flag rejected pre-write).
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HARNESS = path.join(REPO_ROOT, 'scripts', 'second-opinion.mjs')

// The verbatim body issue #538 observed persisted as a review reply.
const BOOTSTRAP = 'Load session_handoff.md from 2026-07-14 16:32? (y/n)'

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-reply-sanity-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  return tmp
}

function makeRebuttalCb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-reply-sanity-cb-'))
  tmpDirs.push(tmp)
  const cbPath = path.join(tmp, 'rebuttal.mjs')
  fs.writeFileSync(cbPath, "#!/usr/bin/env node\nprocess.stdout.write('rebuttal body\\n')\n", 'utf8')
  fs.chmodSync(cbPath, 0o755)
  return cbPath
}

function runHarness(args, { extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv }
  if (env.SO_INSTALL_SNAPSHOT_PATH === undefined) {
    env.SO_INSTALL_SNAPSHOT_PATH = '/nonexistent/snapshot-for-reply-sanity-dev-mode.json'
  }
  const result = spawnSync('node', [HARNESS, ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
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
  return { parsed, exitCode: result.status }
}

function baseArgs(tmp) {
  return [
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'reply sanity body',
    '--summary', 'reply sanity',
    '--dispatch',
  ]
}

console.log('# test-so-reply-sanity-e2e')

test('testSingleDispatchRejects: bootstrap-shaped reply → provider-reply-invalid', () => {
  const tmp = makeTmpProject()
  const r = runHarness(baseArgs(tmp), { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  assert.strictEqual(r.parsed.status, 'error',
    `expected error envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.strictEqual(r.parsed.code, 'provider-reply-invalid',
    `expected provider-reply-invalid, got: ${r.parsed.code}`)
  assert.strictEqual(r.parsed.reason, 'reply-too-short-no-summary',
    `expected reply-too-short-no-summary, got: ${r.parsed.reason}`)
  assert.notStrictEqual(r.exitCode, 0, 'harness must exit non-zero')
})

test('testNoReplyPersisted: rejected reply writes zero reply records', () => {
  const tmp = makeTmpProject()
  runHarness(baseArgs(tmp), { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  const repliesDir = path.join(tmp, '.review-store', 'replies')
  const entries = fs.existsSync(repliesDir) ? fs.readdirSync(repliesDir) : []
  assert.deepStrictEqual(entries, [],
    `no reply record may exist after rejection, found: ${entries.join(', ')}`)
})

test('testForensicsWritten: raw stdout is preserved verbatim to forensics', () => {
  const tmp = makeTmpProject()
  const r = runHarness(baseArgs(tmp), { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  const forensics = r.parsed.forensics
  assert.ok(typeof forensics === 'string' && forensics.length > 0,
    `envelope must name the forensics path, got: ${JSON.stringify(r.parsed)}`)
  assert.ok(fs.existsSync(forensics), `forensics file must exist at ${forensics}`)
  assert.strictEqual(fs.readFileSync(forensics, 'utf8'), BOOTSTRAP,
    'forensics content must be the raw provider stdout, byte for byte')
})

test('testConsensusRoundNotCounted: rejected reply completes no consensus round', () => {
  const tmp = makeTmpProject()
  const cb = makeRebuttalCb()
  const r = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'reply sanity body',
    '--summary', 'reply sanity consensus',
    '--consensus',
    '--max-rounds', '3',
    '--rebuttal-cb', cb,
  ], { extraEnv: { SO_STUB_RAW_BODY: BOOTSTRAP } })
  assert.strictEqual(r.parsed.status, 'error',
    `expected error envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.strictEqual(r.parsed.code, 'provider-reply-invalid',
    `expected provider-reply-invalid, got: ${r.parsed.code}`)
  const rounds = r.parsed.rounds || []
  assert.strictEqual(rounds.length, 0,
    `no round may be counted for a rejected reply, got ${rounds.length}`)
})

test('testHappyPathUnchanged: a normal stub reply still persists with status ok', () => {
  const tmp = makeTmpProject()
  const r = runHarness(baseArgs(tmp))
  assert.strictEqual(r.parsed.status, 'ok',
    `expected ok envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.ok(r.parsed.reply && r.parsed.reply.bodyPath,
    'reply record expected on the happy path')
  assert.ok(fs.existsSync(r.parsed.reply.bodyPath),
    `reply body must be on disk at ${r.parsed.reply && r.parsed.reply.bodyPath}`)
})

test('testInvalidFlagRejected: --min-reply-chars abc fails before any storage write', () => {
  const tmp = makeTmpProject()
  const r = runHarness([...baseArgs(tmp), '--min-reply-chars', 'abc'])
  assert.strictEqual(r.parsed.status, 'error',
    `expected error envelope, got: ${JSON.stringify(r.parsed)}`)
  assert.strictEqual(r.parsed.code, 'invalid-min-reply-chars',
    `expected invalid-min-reply-chars, got: ${r.parsed.code}`)
  assert.ok(!fs.existsSync(path.join(tmp, '.review-store')),
    'no .review-store may be created when a rejecting flag is invalid')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
