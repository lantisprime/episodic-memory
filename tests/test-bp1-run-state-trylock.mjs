#!/usr/bin/env node
/**
 * test-bp1-run-state-trylock.mjs — non-blocking `tryAcquireRunStateLock`
 * primitive (RFC-004 slice 2e B2 fix).
 *
 * Coverage (plan v2 — "tests/test-bp1-run-state-trylock.mjs"):
 *   - TL1: success path returns `{ acquired: true, release }`; release()
 *     removes the lockdir + is idempotent.
 *   - TL2: fresh live lockdir (PID + recent timestamp) → `acquired: false` with
 *     holder_pid + age_ms populated; lockdir NOT broken.
 *   - TL3: holder evidence — pid file with parsable PID and timestamp is
 *     surfaced verbatim in the return shape.
 *   - TL4: stale lockdir (old PID timestamp) → break + acquire on retry.
 *   - TL4b: stale lockdir via tier-2 mtime fallback (no pid file).
 *   - TL5: concurrent tryAcquire from N=4 children — exactly one wins.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const rs = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { tryAcquireRunStateLock } = rs

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-trylock-proj-'))
  return fs.realpathSync(dir)
}

function lockDir(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'runs', '_index.lock')
}

function runsDir(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'runs')
}

// =============================================================================
// TL1 — happy path + idempotent release
// =============================================================================
tap('TL1 tryAcquire on uncontended lock → acquired:true; release() removes lockdir', () => {
  const proj = makeProjectRoot()
  const r = tryAcquireRunStateLock(proj)
  assert.equal(r.acquired, true)
  assert.equal(typeof r.release, 'function')
  // While held, lockdir exists.
  assert.ok(fs.existsSync(lockDir(proj)), 'lockdir present while held')
  // pid metadata is recorded.
  const pidContent = fs.readFileSync(path.join(lockDir(proj), 'pid'), 'utf8').trim()
  assert.match(pidContent, new RegExp(`^${process.pid}\\n\\d+$`),
    `pid file should record current pid + timestamp; got ${JSON.stringify(pidContent)}`)
  // Release.
  r.release()
  assert.ok(!fs.existsSync(lockDir(proj)), 'lockdir removed after release()')
  // Idempotent: a second release is benign.
  r.release()
  assert.ok(!fs.existsSync(lockDir(proj)))
})

// =============================================================================
// TL2 — busy live lockdir → acquired:false, holder evidence populated,
//       lockdir NOT broken
// =============================================================================
tap('TL2 tryAcquire on fresh live lockdir → acquired:false + holder + lockdir preserved', () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  const fakeHolderPid = 99999
  const writeTs = Date.now()
  fs.writeFileSync(path.join(lockDir(proj), 'pid'),
    `${fakeHolderPid}\n${writeTs}\n`, { mode: 0o600 })

  const r = tryAcquireRunStateLock(proj)
  assert.equal(r.acquired, false)
  assert.equal(r.holder_pid, fakeHolderPid)
  assert.ok(typeof r.age_ms === 'number' && r.age_ms >= 0,
    `age_ms should be a non-negative number; got ${JSON.stringify(r.age_ms)}`)
  assert.ok(r.age_ms < 5_000, `age_ms should be small for fresh lock; got ${r.age_ms}`)
  // Lockdir preserved — live lock must not be broken.
  assert.ok(fs.existsSync(lockDir(proj)), 'live lockdir must NOT be broken')
  // Cleanup so subsequent tests don't see the leftover.
  fs.rmSync(lockDir(proj), { recursive: true, force: true })
})

// =============================================================================
// TL3 — holder evidence with no readable pid file → tier-2 age_ms fallback
//       (holder_pid stays null)
// =============================================================================
tap('TL3 tryAcquire on lockdir without pid file → acquired:false + holder_pid:null + age_ms via mtime', () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  // No pid file inside; lockdir mtime is "now" from the mkdirSync above.
  const r = tryAcquireRunStateLock(proj)
  assert.equal(r.acquired, false)
  assert.equal(r.holder_pid, null, 'holder_pid null when pid file absent')
  assert.ok(typeof r.age_ms === 'number' && r.age_ms >= 0,
    `age_ms should derive from lockdir mtime; got ${JSON.stringify(r.age_ms)}`)
  // Still a fresh lockdir — not stale, not broken.
  assert.ok(fs.existsSync(lockDir(proj)))
  fs.rmSync(lockDir(proj), { recursive: true, force: true })
})

// =============================================================================
// TL4 — stale lockdir (tier-1: old PID timestamp) → break + acquire on retry
// =============================================================================
tap('TL4 tryAcquire on stale lockdir (old PID timestamp) → break + acquire', () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  const oldTs = Date.now() - 60_000 // 60s ago — well past STALE_LOCK_MS=30s
  fs.writeFileSync(path.join(lockDir(proj), 'pid'),
    `${process.pid}\n${oldTs}\n`, { mode: 0o600 })

  const r = tryAcquireRunStateLock(proj)
  assert.equal(r.acquired, true, `expected acquired:true after stale-break; got ${JSON.stringify(r)}`)
  // After break + reacquire, the pid file should now record the current
  // process and a fresh timestamp.
  const pidContent = fs.readFileSync(path.join(lockDir(proj), 'pid'), 'utf8').trim()
  assert.match(pidContent, new RegExp(`^${process.pid}\\n\\d+$`),
    `pid file should be rewritten with current pid; got ${JSON.stringify(pidContent)}`)
  r.release()
  assert.ok(!fs.existsSync(lockDir(proj)))
})

// =============================================================================
// TL4b — stale lockdir (tier-2: missing pid file + old mtime) → break + acquire
// =============================================================================
tap('TL4b tryAcquire on stale lockdir (no pid + old mtime) → tier-2 break + acquire', () => {
  const proj = makeProjectRoot()
  fs.mkdirSync(runsDir(proj), { recursive: true })
  fs.mkdirSync(lockDir(proj))
  // No pid file; force mtime to 60s ago.
  const oldEpoch = (Date.now() - 60_000) / 1000
  fs.utimesSync(lockDir(proj), oldEpoch, oldEpoch)

  const r = tryAcquireRunStateLock(proj)
  assert.equal(r.acquired, true,
    `expected acquired:true after tier-2 stale-break; got ${JSON.stringify(r)}`)
  r.release()
  assert.ok(!fs.existsSync(lockDir(proj)))
})

// =============================================================================
// TL5 — N=4 concurrent tryAcquire from real children: exactly one wins
// =============================================================================
await tapAsync('TL5 N=4 concurrent tryAcquire → exactly one acquired:true, others acquired:false', async () => {
  const proj = makeProjectRoot()
  const sentinel = path.join(proj, '.barrier')
  const runStateMjs = path.join(REPO, 'scripts', 'lib', 'bp1-run-state.mjs')
  const N = 4

  // Each child waits for the sentinel, then calls tryAcquireRunStateLock,
  // prints the JSON result, and exits 0 (test classifies via stdout).
  // Winners hold the lock for ~150ms before releasing so losers reliably
  // observe contention rather than racing in on the release window.
  const childScript = `
    import fs from 'node:fs'
    const sentinelPath = ${JSON.stringify(sentinel)}
    while (!fs.existsSync(sentinelPath)) { /* spin until barrier */ }
    const m = await import(${JSON.stringify(runStateMjs)})
    const projectRoot = ${JSON.stringify(proj)}
    const r = m.tryAcquireRunStateLock(projectRoot)
    if (r.acquired) {
      // Hold long enough that any later attempters see contention.
      await new Promise(res => setTimeout(res, 150))
      process.stdout.write(JSON.stringify({ acquired: true }))
      r.release()
    } else {
      process.stdout.write(JSON.stringify({
        acquired: false,
        holder_pid: r.holder_pid,
        age_ms_is_number: typeof r.age_ms === 'number',
      }))
    }
    process.exit(0)
  `

  const children = []
  for (let i = 0; i < N; i++) {
    const child = spawn('node', ['--input-type=module', '-e', childScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push({ child, stdout: '', stderr: '', exitCode: null })
    child.stdout.on('data', d => children[i].stdout += d.toString())
    child.stderr.on('data', d => children[i].stderr += d.toString())
  }

  // Brief wait so all children reach the spin-wait state.
  await new Promise(r => setTimeout(r, 200))
  fs.writeFileSync(sentinel, '')

  await Promise.all(children.map(c => new Promise(resolve => {
    c.child.on('exit', code => { c.exitCode = code; resolve() })
  })))

  let winners = 0
  let losers = 0
  for (const c of children) {
    assert.equal(c.exitCode, 0,
      `child exited non-zero: stdout=${c.stdout} stderr=${c.stderr}`)
    const parsed = JSON.parse(c.stdout)
    if (parsed.acquired === true) winners++
    else if (parsed.acquired === false) {
      losers++
      // Each loser must surface number-typed age_ms (holder_pid may be null if
      // pid-file write was interrupted but the typical happy path records it).
      assert.equal(parsed.age_ms_is_number, true,
        `loser missing age_ms number: ${JSON.stringify(parsed)}`)
    }
  }
  assert.equal(winners, 1, `expected exactly one winner; got ${winners}`)
  assert.equal(losers, N - 1, `expected ${N - 1} losers; got ${losers}`)
  // Final lockdir should be cleaned up by winner's release().
  assert.ok(!fs.existsSync(lockDir(proj)), 'lockdir cleaned after winner release')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
