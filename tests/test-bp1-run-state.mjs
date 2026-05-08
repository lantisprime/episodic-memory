#!/usr/bin/env node
/**
 * test-bp1-run-state.mjs — Run-state index + lockdir mutex tests.
 *
 * Coverage (plan v4):
 *   - RS1/RS2: append baseline.
 *   - RC-LOCK1: real concurrent N=4 writers, barrier-synchronized.
 *   - RC-LOCK2: stale-lock detection via tier-1 PID timestamp.
 *   - RC-LOCK3: lock-timeout when held by live process.
 *   - RC-LOCK4: stale-lock detection via tier-2 mtime fallback (no PID file —
 *     simulates acquisition-window crash).
 *   - RC-LOCK4b: stale-lock detection via tier-2 mtime fallback (malformed PID).
 *   - RS4: loadIndex on missing file.
 *   - RS5: markTerminal sanity.
 *   - RC3: corrupt JSON in _index.json.
 *   - RS-collision: duplicate run_id.
 *   - RS-tmp-uniqueness: per-process temp filenames differ.
 *
 * Note: RS6 (kill mid-write under lock) is covered indirectly by RC-LOCK4.
 * A no-pid + old-mtime lockdir IS what an immediate-after-mkdirSync kill
 * would leave. Adding a deterministic SIGKILL fixture would require a
 * test-only env-var hook in production code; we don't ship that.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const rs = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { indexPath, loadIndex, appendRun, markTerminal, getRunState } = rs

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

async function tapAsync(name, fn) {
  try { await fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-rs-proj-'))
  return fs.realpathSync(dir)
}

function lockDir(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'runs', '_index.lock')
}

function runsDir(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'runs')
}

const RUN_A = 'bp1-run-test-rs-A-aabbcc'
const RUN_B = 'bp1-run-test-rs-B-ddeeff'
const RUN_C = 'bp1-run-test-rs-C-112233'

// =============================================================================
// RS1 — first appendRun creates index + releases lockdir
// =============================================================================
tap('RS1 first appendRun creates index + releases lockdir cleanly', () => {
  const proj = makeProjectRoot()
  const r = appendRun(proj, RUN_A, proj)
  assert.deepEqual({ ok: true }, { ok: r.ok }, 'appendRun returns ok:true')
  assert.equal(r.run.state, 'active')
  assert.equal(r.run.project_root, proj)
  // Index file exists.
  assert.ok(fs.existsSync(indexPath(proj)))
  // Lockdir released.
  assert.ok(!fs.existsSync(lockDir(proj)), 'lockdir must be released after appendRun')
  // No orphan tmp.
  const entries = fs.readdirSync(runsDir(proj))
  for (const e of entries) {
    assert.ok(!e.startsWith('_index.json.tmp.'), `orphan tmp found: ${e}`)
  }
})

// =============================================================================
// RS2 — second appendRun adds key
// =============================================================================
tap('RS2 second appendRun adds key (both runs in index)', () => {
  const proj = makeProjectRoot()
  appendRun(proj, RUN_A, proj)
  appendRun(proj, RUN_B, proj)
  const idx = loadIndex(proj)
  assert.ok(RUN_A in idx.runs)
  assert.ok(RUN_B in idx.runs)
})

// =============================================================================
// RS-collision — duplicate run_id
// =============================================================================
tap('RS-collision appendRun for existing run_id → error collision; lockdir released', () => {
  const proj = makeProjectRoot()
  appendRun(proj, RUN_A, proj)
  const r2 = appendRun(proj, RUN_A, proj)
  assert.equal(r2.error, 'collision')
  assert.ok(!fs.existsSync(lockDir(proj)), 'lockdir released on collision branch')
})

// =============================================================================
// RS4 — loadIndex on missing file
// =============================================================================
tap('RS4 loadIndex on missing file → empty default', () => {
  const proj = makeProjectRoot()
  const idx = loadIndex(proj)
  assert.deepEqual(idx, { schema_version: 1, runs: {} })
})

// =============================================================================
// RC3 — corrupt JSON in _index.json → loadIndex throws
// =============================================================================
tap('RC3 corrupt JSON in _index.json → loadIndex throws (does not silently reset)', () => {
  const proj = makeProjectRoot()
  // Pre-create runs dir + write garbage.
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.writeFileSync(indexPath(proj), '{ this is not valid JSON')
  let threw = false
  try {
    loadIndex(proj)
  } catch (e) {
    threw = true
    assert.equal(e.code, 'corrupt')
  }
  assert.ok(threw, 'loadIndex must throw on corrupt JSON')
})

// =============================================================================
// RS5 — markTerminal sanity
// =============================================================================
tap('RS5 markTerminal updates state + terminal_at; rejects already-terminal', () => {
  const proj = makeProjectRoot()
  appendRun(proj, RUN_A, proj)
  const r = markTerminal(proj, RUN_A, 'complete')
  assert.deepEqual({ ok: true }, r)
  const state = getRunState(proj, RUN_A)
  assert.equal(state.state, 'complete')
  assert.ok(state.terminal_at, 'terminal_at populated')
  // Re-mark → already-terminal.
  const r2 = markTerminal(proj, RUN_A, 'aborted')
  assert.equal(r2.error, 'already-terminal')
})

tap('markTerminal rejects unknown run_id with error missing', () => {
  const proj = makeProjectRoot()
  const r = markTerminal(proj, 'unknown-run-id', 'complete')
  assert.equal(r.error, 'missing')
})

tap('markTerminal rejects invalid terminal state', () => {
  const proj = makeProjectRoot()
  appendRun(proj, RUN_A, proj)
  const r = markTerminal(proj, RUN_A, 'not-a-state')
  assert.equal(r.error, 'invalid-state')
})

// =============================================================================
// RC-LOCK2 — stale-lock detection via tier-1 PID timestamp
// =============================================================================
tap('RC-LOCK2 stale lockdir (PID + 60s-old timestamp) → tier-1 detects + breaks', () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  // Write PID with timestamp 60s in the past.
  const oldTs = Date.now() - 60_000
  fs.writeFileSync(path.join(lockDir(proj), 'pid'), `${process.pid}\n${oldTs}\n`, { mode: 0o600 })
  // appendRun should detect stale + break + succeed.
  const r = appendRun(proj, RUN_A, proj)
  assert.equal(r.ok, true)
  assert.ok(!fs.existsSync(lockDir(proj)), 'stale lockdir broken; new lock released cleanly')
})

// =============================================================================
// RC-LOCK4 — stale via tier-2 mtime fallback (no PID file)
// =============================================================================
tap('RC-LOCK4 stale lockdir (no PID file + old mtime) → tier-2 mtime fallback breaks', () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  // Force lockdir mtime to 60s ago (simulates acquisition-window crash where
  // mkdirSync succeeded but pid-file write never happened).
  const oldEpoch = (Date.now() - 60_000) / 1000
  fs.utimesSync(lockDir(proj), oldEpoch, oldEpoch)
  // No pid file inside.
  assert.ok(!fs.existsSync(path.join(lockDir(proj), 'pid')))
  // appendRun must detect stale via tier-2 + break + succeed.
  const r = appendRun(proj, RUN_A, proj)
  assert.equal(r.ok, true, `appendRun should succeed; got ${JSON.stringify(r)}`)
  assert.ok(!fs.existsSync(lockDir(proj)), 'stale lockdir broken; new lock released')
})

// =============================================================================
// RC-LOCK4b — stale via tier-2 mtime fallback (malformed PID file)
// =============================================================================
tap('RC-LOCK4b stale lockdir (malformed PID + old mtime) → tier-2 fallback breaks', () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  // Per codex round-3 implementation note: create malformed pid first, then
  // force the lockdir mtime old.
  fs.writeFileSync(path.join(lockDir(proj), 'pid'), Buffer.from([0x00, 0x01, 0x02, 0x03]), { mode: 0o600 })
  const oldEpoch = (Date.now() - 60_000) / 1000
  fs.utimesSync(lockDir(proj), oldEpoch, oldEpoch)
  // appendRun: tier-1 parse fails → tier-2 mtime → stale → break + succeed.
  const r = appendRun(proj, RUN_A, proj)
  assert.equal(r.ok, true, `appendRun should succeed; got ${JSON.stringify(r)}`)
  assert.ok(!fs.existsSync(lockDir(proj)))
})

// =============================================================================
// RC-LOCK3 — live lock held by long-running child → lock-timeout
// =============================================================================
await tapAsync('RC-LOCK3 live lockdir (held by child process) → appendRun returns lock-timeout', async () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  // Write fresh PID + timestamp; tier-1 sees live.
  fs.writeFileSync(path.join(lockDir(proj), 'pid'), `99999\n${Date.now()}\n`, { mode: 0o600 })
  // Don't actually need a child; just ensure the lockdir has fresh mtime AND
  // valid PID with current timestamp. tier-1 returns "live"; tier-2 also
  // returns "live" because mtime was set to "now" by mkdirSync.
  // appendRun should return lock-timeout after LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS
  // (200 * 50ms = 10s). To keep the test fast, we modify the lock helpers'
  // constants? No — those are private. Just await ~10s; or accept the test
  // is slow. Compromise: keep timeout default, expect ~10s wall.
  // Document: this test takes ~10s.
  const start = Date.now()
  const r = appendRun(proj, RUN_A, proj)
  const elapsed = Date.now() - start
  assert.equal(r.error, 'lock-timeout', `expected lock-timeout, got ${JSON.stringify(r)}`)
  assert.ok(elapsed >= 5000, `lock-timeout should take >=5s; got ${elapsed}ms`)
  // Lockdir must NOT have been broken — it's a live lock.
  assert.ok(fs.existsSync(lockDir(proj)),
    'live lockdir must not be broken when timestamp is fresh')
  // Cleanup so subsequent tests don't see the leftover.
  fs.rmSync(lockDir(proj), { recursive: true, force: true })
})

// =============================================================================
// RC-LOCK1 — N=4 concurrent writers, barrier-synchronized via sentinel file
// (Codex round-2 ESM fix: --input-type=module + dynamic import.)
// =============================================================================
await tapAsync('RC-LOCK1 N=4 concurrent writers (real children, barrier-synchronized)', async () => {
  const proj = makeProjectRoot()
  const sentinel = path.join(proj, '.barrier')
  const runStateMjs = path.join(REPO, 'scripts', 'lib', 'bp1-run-state.mjs')
  const N = 4

  // Spawn N child writers. Each waits for the sentinel file to appear, then
  // calls appendRun with its own runId.
  const childScript = `
    import fs from 'node:fs'
    const sentinelPath = ${JSON.stringify(sentinel)}
    while (!fs.existsSync(sentinelPath)) {
      // Tight-loop spin (sub-millisecond intervals) until sentinel appears.
      // Atomics.wait would be ideal but harder to coordinate across processes;
      // a brief spin is fine for fixture purposes.
    }
    const m = await import(${JSON.stringify(runStateMjs)})
    const projectRoot = ${JSON.stringify(proj)}
    const myRunId = process.argv[1]
    const r = m.appendRun(projectRoot, myRunId, projectRoot)
    process.stdout.write(JSON.stringify(r))
    process.exit(r.ok ? 0 : 1)
  `

  const writers = []
  for (let i = 0; i < N; i++) {
    const myRunId = `bp1-run-rclock1-${i}-aabbcc`
    const child = spawn('node', ['--input-type=module', '-e', childScript, '--', myRunId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    writers.push({ child, myRunId, exitCode: null, stdout: '', stderr: '' })
    child.stdout.on('data', d => writers[i].stdout += d.toString())
    child.stderr.on('data', d => writers[i].stderr += d.toString())
  }

  // Brief wait so all writers reach the spin-wait state before sentinel.
  await new Promise(r => setTimeout(r, 200))

  // Release the barrier.
  fs.writeFileSync(sentinel, '')

  // Await all exits.
  await Promise.all(writers.map(w => new Promise(resolve => {
    w.child.on('exit', code => { w.exitCode = code; resolve() })
  })))

  // Each writer should have succeeded.
  for (const w of writers) {
    assert.equal(w.exitCode, 0,
      `writer ${w.myRunId} failed: stdout=${w.stdout} stderr=${w.stderr}`)
  }

  // Final index has all 4 keys.
  const idx = loadIndex(proj)
  assert.equal(Object.keys(idx.runs).length, N,
    `expected ${N} runs, got ${Object.keys(idx.runs).length}`)
  for (let i = 0; i < N; i++) {
    assert.ok(`bp1-run-rclock1-${i}-aabbcc` in idx.runs,
      `missing run bp1-run-rclock1-${i}-aabbcc`)
  }

  // No orphan lockdir.
  assert.ok(!fs.existsSync(lockDir(proj)), 'no orphan lockdir')

  // No orphan tmp files.
  const entries = fs.readdirSync(runsDir(proj))
  for (const e of entries) {
    assert.ok(!e.startsWith('_index.json.tmp.'), `orphan tmp: ${e}`)
  }
})

// =============================================================================
// RS-tmp-uniqueness — temp filenames are per-process unique
// =============================================================================
tap('RS-tmp-uniqueness — temp filename includes pid + random suffix', () => {
  // Static check: source includes process.pid + crypto.randomBytes for tmp path.
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'bp1-run-state.mjs'), 'utf8')
  assert.match(src, /\.tmp\.\$\{process\.pid\}/, 'tmp path must include process.pid')
  assert.match(src, /crypto\.randomBytes/, 'tmp path must include random suffix')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
