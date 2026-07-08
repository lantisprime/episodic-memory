#!/usr/bin/env node
/**
 * test-llm-hold-classify.mjs — E2 (gate-classifier UX): LLM auto-classify on
 * hold, via a LOCAL Anthropic-shaped HTTP stub (never the live API).
 *
 * The fixture repo's .episodic-memory/classifier-config.json points api_base
 * at a local node http server; ANTHROPIC_API_KEY is a dummy value. Both
 * polarities are exercised through the REAL checkpoint-gate.sh:
 *
 *   §L  llm-classify.mjs --three-way rubric (label allowlist)
 *   §P  success path: high-confidence read_only → command allowed AND verdict
 *       persisted into .checkpoints/classify/ with source:"llm"; retry served
 *       from the marker cache (no second API call)
 *   §W  shared_write verdict → falls through to the existing arm/block branch
 *       (blocked when a plan-approval token sanctions implementation;
 *       persisted marker carries the verdict)
 *   §F  failure polarities on the SAME command shape: no API key; unreachable
 *       api_base; low confidence; malformed output; hard-timeout kill —
 *       ALL fall through to the existing agent hold (fail-closed)
 *
 * Usage: node tests/test-llm-hold-classify.mjs   (prints "N/N pass")
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import assert from 'assert'
import { execFileSync, spawn } from 'child_process'

// ASYNC spawn — the Anthropic stub server lives in THIS process, so a
// spawnSync would block the event loop and the stub could never respond
// (every request would time out). All child runs must keep the loop free.
function run(cmd, args, { input, env, cwd, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeout)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ status: code, signal, stdout, stderr })
    })
    if (input) child.stdin.write(input)
    child.stdin.end()
  })
}

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const GATE = path.join(REPO, 'plugins', 'claude-code', 'hooks', 'checkpoint-gate.sh')
const CONSULT = path.join(REPO, 'scripts', 'classifier-hold-consult.mjs')
const LLM = path.join(REPO, 'scripts', 'llm-classify.mjs')

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

function mkrepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `llmhold-${name}-`))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return fs.realpathSync(dir)
}

function writeConfig(repo, apiBase, extra = {}) {
  const dir = path.join(repo, '.episodic-memory')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'classifier-config.json'), JSON.stringify({
    api_base: apiBase,
    timeout_ms: 3000,
    ...extra
  }, null, 2))
}

// Anthropic-shaped stub. `responder` returns {label, confidence, reason} |
// a raw body string | 'hang'. Counts requests.
function startStub(responder) {
  const state = { requests: 0 }
  const server = http.createServer((req, res) => {
    state.requests++
    const behavior = responder()
    if (behavior === 'hang') return // never respond — timeout polarity
    let text
    if (typeof behavior === 'string') {
      text = behavior
    } else {
      text = JSON.stringify(behavior)
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: [{ type: 'text', text }] }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

function stopStub(s) {
  return new Promise((resolve) => { s.server.closeAllConnections?.(); s.server.close(() => resolve()) })
}

function runGate(repo, testHome, sid, command, env = {}) {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: repo,
    session_id: sid
  })
  return run('bash', [GATE], {
    input,
    timeout: 60000,
    env: {
      ...process.env,
      HOME: testHome,
      CLAUDE_CODE_SESSION_ID: sid,
      ANTHROPIC_API_KEY: 'test-key-never-live',
      ...env
    }
  })
}

function readMarkers(repo) {
  const dir = path.join(repo, '.checkpoints', 'classify')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

console.log('# test-llm-hold-classify (E2 — LLM auto-classify on hold)')

// ===== §L: --three-way rubric ==============================================

await test('§L1 llm-classify --three-way rejects labels outside the 3-way set', async () => {
  const repo = mkrepo('l1')
  const stub = await startStub(() => ({ label: 'marker_write', confidence: 0.99, reason: 'x' }))
  writeConfig(repo, stub.url)
  const r = await run(process.execPath, [LLM,
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'frobtool --scan', '--three-way'
  ], {
    cwd: repo, timeout: 20000,
    env: { ...process.env, ANTHROPIC_API_KEY: 'test-key-never-live' }
  })
  await stopStub(stub)
  assert.strictEqual(r.status, 3, `expected tier-3 failure exit, got ${r.status}: ${r.stdout}`)
  const out = JSON.parse((r.stdout || '').trim().split('\n').pop())
  assert.strictEqual(out.label, null, 'no label may be consumed')
  assert.ok(/LABEL/.test(out.reason), `reason should carry LABEL code: ${out.reason}`)
})

await test('§L2 llm-classify --three-way accepts a 3-way label', async () => {
  const repo = mkrepo('l2')
  const stub = await startStub(() => ({ label: 'read_only', confidence: 0.95, reason: 'reads only' }))
  writeConfig(repo, stub.url)
  const r = await run(process.execPath, [LLM,
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'frobtool --scan', '--three-way'
  ], {
    cwd: repo, timeout: 20000,
    env: { ...process.env, ANTHROPIC_API_KEY: 'test-key-never-live' }
  })
  await stopStub(stub)
  assert.strictEqual(r.status, 0, `expected success: ${r.stdout} ${r.stderr}`)
  const out = JSON.parse((r.stdout || '').trim().split('\n').pop())
  assert.strictEqual(out.label, 'read_only')
})

// ===== §P: success path through the REAL gate ==============================

await test('§P1 gate E2E: high-confidence read_only → allowed + persisted with source:"llm"', async () => {
  const repo = mkrepo('p1')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const sid = 's_p1'
  const stub = await startStub(() => ({ label: 'read_only', confidence: 0.95, reason: 'inspector' }))
  writeConfig(repo, stub.url)
  const r = await runGate(repo, testHome, sid, 'frobtool --scan target')
  await stopStub(stub)
  assert.strictEqual(r.status, 0, `gate errored: ${r.stderr}`)
  assert.ok(!(r.stdout || '').includes('"block"'), `expected allow, got: ${r.stdout}`)
  assert.strictEqual(stub.state.requests, 1, `expected exactly 1 API call, got ${stub.state.requests}`)
  const markers = readMarkers(repo)
  assert.strictEqual(markers.length, 1, `expected 1 persisted verdict, got ${markers.length}`)
  assert.strictEqual(markers[0].label, 'read_only')
  assert.strictEqual(markers[0].source, 'llm')
  assert.strictEqual(markers[0].classified_by, 'llm')
  assert.strictEqual(markers[0].command_raw, 'frobtool --scan target')
})

await test('§P2 gate E2E retry: persisted LLM verdict serves from cache, no second API call', async () => {
  const repo = mkrepo('p2')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const sid = 's_p2'
  const stub = await startStub(() => ({ label: 'read_only', confidence: 0.95, reason: 'inspector' }))
  writeConfig(repo, stub.url)
  const first = await runGate(repo, testHome, sid, 'frobtool --scan target')
  assert.ok(!(first.stdout || '').includes('"block"'), `first run must allow: ${first.stdout}`)
  const callsAfterFirst = stub.state.requests
  // Canonical-key generalization (E3 x E2): the flag-VALUE variant also hits.
  const second = await runGate(repo, testHome, sid, 'frobtool --scan other-target')
  await stopStub(stub)
  assert.ok(!(second.stdout || '').includes('"block"'), `retry must allow: ${second.stdout}`)
  assert.strictEqual(stub.state.requests, callsAfterFirst,
    'retry must be served from the marker cache, not a second API call')
})

// ===== §W: shared_write verdict falls through to the arm/block branch ======

await test('§W1 gate E2E: shared_write verdict + approved plan → existing arm/block branch fires', async () => {
  const repo = mkrepo('w1')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const sid = 's_w1'
  const stub = await startStub(() => ({ label: 'shared_write', confidence: 0.9, reason: 'writes source' }))
  writeConfig(repo, stub.url)
  // Plan-approval token sanctions implementation → the arm/block branch blocks.
  fs.mkdirSync(path.join(repo, '.checkpoints'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.checkpoints', `.plan-approved.${sid}`), '')
  const r = await runGate(repo, testHome, sid, 'frobtool --commit changes')
  await stopStub(stub)
  assert.ok((r.stdout || '').includes('"block"'), `expected pre-checkpoint block: ${r.stdout}`)
  assert.ok((r.stdout || '').includes('Checkpoint required'),
    `block must be the checkpoint arm, not the classification hold: ${r.stdout}`)
  const markers = readMarkers(repo)
  assert.strictEqual(markers.length, 1, 'shared_write verdict must be persisted too')
  assert.strictEqual(markers[0].label, 'shared_write')
  assert.strictEqual(markers[0].source, 'llm')
})

// ===== §F: failure polarities — all fall through to the hold ===============

await test('§F1 no API key → hold (fail-closed), no API call, nothing persisted', async () => {
  const repo = mkrepo('f1')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const stub = await startStub(() => ({ label: 'read_only', confidence: 0.95, reason: 'x' }))
  writeConfig(repo, stub.url)
  const r = await runGate(repo, testHome, 's_f1', 'frobtool --scan target', { ANTHROPIC_API_KEY: '' })
  await stopStub(stub)
  assert.ok((r.stdout || '').includes('"block"'), `expected hold: ${r.stdout}`)
  assert.strictEqual(stub.state.requests, 0, 'no key → no API call')
  assert.strictEqual(readMarkers(repo).length, 0)
})

await test('§F2 unreachable api_base → hold (fail-closed)', async () => {
  const repo = mkrepo('f2')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  writeConfig(repo, 'http://127.0.0.1:9') // discard port — connection refused
  const r = await runGate(repo, testHome, 's_f2', 'frobtool --scan target')
  assert.ok((r.stdout || '').includes('"block"'), `expected hold: ${r.stdout}`)
  assert.strictEqual(readMarkers(repo).length, 0)
})

await test('§F3 low confidence (< 0.8) → hold, nothing persisted', async () => {
  const repo = mkrepo('f3')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const stub = await startStub(() => ({ label: 'read_only', confidence: 0.5, reason: 'unsure' }))
  writeConfig(repo, stub.url)
  const r = await runGate(repo, testHome, 's_f3', 'frobtool --scan target')
  await stopStub(stub)
  assert.ok((r.stdout || '').includes('"block"'), `expected hold: ${r.stdout}`)
  assert.strictEqual(readMarkers(repo).length, 0)
})

await test('§F4 malformed model output → hold (fail-closed)', async () => {
  const repo = mkrepo('f4')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const stub = await startStub(() => 'the command looks safe to me!')
  writeConfig(repo, stub.url)
  const r = await runGate(repo, testHome, 's_f4', 'frobtool --scan target')
  await stopStub(stub)
  assert.ok((r.stdout || '').includes('"block"'), `expected hold: ${r.stdout}`)
  assert.strictEqual(readMarkers(repo).length, 0)
})

await test('§F5 hung API (no response) → hard 10s kill → hold; gate never exceeds ~15s', async () => {
  const repo = mkrepo('f5')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const stub = await startStub(() => 'hang')
  // Internal timeout raised ABOVE the consult's 10s hard kill so this test
  // proves the hard kill, not llm-classify's own AbortController.
  writeConfig(repo, stub.url, { timeout_ms: 30000 })
  const t0 = Date.now()
  const r = await runGate(repo, testHome, 's_f5', 'frobtool --scan target')
  const elapsed = Date.now() - t0
  await stopStub(stub)
  assert.ok((r.stdout || '').includes('"block"'), `expected hold: ${r.stdout}`)
  assert.ok(elapsed >= 9000, `hard kill should take ~10s, took ${elapsed}ms`)
  assert.ok(elapsed < 20000, `must not exceed the hard timeout window, took ${elapsed}ms`)
  assert.strictEqual(readMarkers(repo).length, 0)
})

await test('§F6 config enabled:false disables the LLM stage → hold, no API call', async () => {
  const repo = mkrepo('f6')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmhold-home-'))
  const stub = await startStub(() => ({ label: 'read_only', confidence: 0.95, reason: 'x' }))
  writeConfig(repo, stub.url, { enabled: false })
  const r = await runGate(repo, testHome, 's_f6', 'frobtool --scan target')
  await stopStub(stub)
  assert.ok((r.stdout || '').includes('"block"'), `expected hold: ${r.stdout}`)
  assert.strictEqual(stub.state.requests, 0, 'enabled:false → no API call')
  assert.strictEqual(readMarkers(repo).length, 0)
})

console.log(`\n${passed}/${passed + failed} pass`)
if (failed > 0) {
  for (const f of failures) console.error(`FAIL: ${f.name}: ${f.error}`)
  process.exit(1)
}
