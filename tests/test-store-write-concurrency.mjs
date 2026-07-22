#!/usr/bin/env node
/**
 * test-store-write-concurrency.mjs — Issue 546 concurrent store-write suite.
 *
 * Slice 546-S1 contract (docs/plans/issue-546-concurrent-store-writes.md):
 *   - helper: acquire/release/inheritance/malformed-timeout/lexical-order/
 *     symlink-dedupe/symlinked-parent-dedupe/partial-cleanup/unique-tmp/
 *     atomic-success/atomic-failure/deterministic-EEXIST/cross-dir-reject/
 *     no-litter
 *   - end-to-end: a real external child holding <store>/clerk-apply.lock
 *     while the real `em-store` runs against an isolated local fixture.
 *     The PARENT owns the release timing so writerExitedBeforeRelease is
 *     observed from the actual ordering, not a hidden timer. On
 *     unmodified main the writer exits before the parent sends release
 *     (writerExitedBeforeRelease = true). After the fix, the writer waits
 *     for the parent's release (writerExitedBeforeRelease = false).
 *
 * Usage:
 *   node tests/test-store-write-concurrency.mjs --helper-only
 *   node tests/test-store-write-concurrency.mjs --expect-main-red   # red on current main
 *   node tests/test-store-write-concurrency.mjs                    # both halves (needs fix)
 *
 * F1 (S1 review): tests use the required public names
 * (STORE_WRITE_LOCK_BASENAME, storeWriteLockPath, uniqueStoreTmpPath).
 * F6 (S1 review): every mkTmp() root is tracked in tmpRoots and removed
 * in main()'s finally, including failure paths. Unused imports and
 * variables are gone.
 *
 * Zero deps. Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const SELF = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SELF), '..')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const REVISE = path.join(REPO, 'scripts', 'em-revise.mjs')
const FEEDBACK = path.join(REPO, 'scripts', 'em-feedback.mjs')
const PIN = path.join(REPO, 'scripts', 'em-pin.mjs')
const REBUILD = path.join(REPO, 'scripts', 'em-rebuild-index.mjs')
const SEARCH = path.join(REPO, 'scripts', 'em-search.mjs')
const PRUNE = path.join(REPO, 'scripts', 'em-prune.mjs')
const MOVE = path.join(REPO, 'scripts', 'em-move.mjs')
const SEED_PATTERNS = path.join(REPO, 'scripts', 'em-seed-patterns.mjs')
const REVIEW_REQUEST = path.join(REPO, 'scripts', 'em-review-request.mjs')
// Issue 546 (S3b): restore + consolidate paths under test.
const RESTORE = path.join(REPO, 'scripts', 'em-restore.mjs')
const CONSOLIDATE = path.join(REPO, 'scripts', 'em-consolidate.mjs')
const HELPER_URL = new URL('../scripts/lib/store-write-lock.mjs', import.meta.url).href

const ARGV = process.argv.slice(2)
const HELPER_ONLY = ARGV.includes('--helper-only')
const EXPECT_MAIN_RED = ARGV.includes('--expect-main-red')

let pass = 0
let fail = 0

// F6: every mkTmp() root is registered here. main()'s finally removes all
// of them, including failure paths. No more leaked /tmp fixtures.
const tmpRoots = []

// Every live-holder child spawned via spawnLiveHolder is tracked here so
// main()'s finally can release/await any orphans after a test throws.
const liveChildren = new Set()
const commandChildren = new Set()
const telemetry = Object.create(null)

function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// F7: asyncTap mirrors tap but for tests that need to await async helpers
// (live-holder children, etc.). Synchronous throw inside fn() still counts.
async function asyncTap(name, fn) {
  try {
    await fn()
    pass++
    console.log(`ok ${pass + fail} - ${name}`)
  } catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function mkTmp(prefix) {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpRoots.push(p)
  return p
}

function mkStoreFixture(prefix) {
  const root = mkTmp(prefix)
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  return {
    root,
    home,
    cwd,
    localDir: path.join(cwd, '.episodic-memory'),
    globalDir: path.join(home, '.episodic-memory'),
    env: { ...process.env, HOME: home },
  }
}

function runJsonSync(script, args, fixture, envExtra = {}) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: fixture.cwd,
    env: { ...fixture.env, ...envExtra },
    encoding: 'utf8',
  })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim()) } catch { /* asserted by caller */ }
  return { code: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', json, elapsedMs: Date.now() - started }
}

function spawnJson(script, args, fixture, envExtra = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: fixture.cwd,
    env: { ...fixture.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  commandChildren.add(child)
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += d.toString() })
  child.stderr.on('data', d => { stderr += d.toString() })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      commandChildren.delete(child)
      let json = null
      try { json = JSON.parse(stdout.trim()) } catch { /* asserted by caller */ }
      resolve({ child, code, signal, stdout, stderr, json, elapsedMs: Date.now() - started })
    })
  })
  completion.child = child
  return completion
}

async function stopChildren(children) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM') } catch { /* best effort */ }
    }
  }
  await Promise.all(children.map(child => awaitChild(child)))
}

function byteSnapshot(root) {
  if (!fs.existsSync(root)) return []
  const entries = []
  function visit(dir, rel) {
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    if (rel) entries.push([`${rel}/`, 'directory'])
    for (const ent of names) {
      const abs = path.join(dir, ent.name)
      const childRel = rel ? path.join(rel, ent.name) : ent.name
      if (ent.isDirectory()) visit(abs, childRel)
      else if (ent.isSymbolicLink()) entries.push([childRel, `symlink:${fs.readlinkSync(abs)}`])
      else entries.push([childRel, fs.readFileSync(abs).toString('base64')])
    }
  }
  visit(root, '')
  return entries
}

function readIndexRows(storeDir) {
  const text = fs.readFileSync(path.join(storeDir, 'index.jsonl'), 'utf8')
  return text.split('\n').filter(Boolean).map(JSON.parse)
}

function readJson(storeDir, name) {
  return JSON.parse(fs.readFileSync(path.join(storeDir, name), 'utf8'))
}

function episodeIds(storeDir) {
  const dir = path.join(storeDir, 'episodes')
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort()
}

function episodeStatus(storeDir, id) {
  const text = fs.readFileSync(path.join(storeDir, 'episodes', `${id}.md`), 'utf8')
  const match = text.match(/^status:\s*(\S+)$/m)
  return match ? match[1] : null
}

function assertIds(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label)
}

function assertPosting(index, key, expectedIds, label) {
  assert.ok(Array.isArray(index[key]), `${label}: missing posting ${key}`)
  assertIds(index[key], expectedIds, `${label}: posting ${key}`)
}

function tmpLitter(storeDir) {
  if (!fs.existsSync(storeDir)) return []
  const found = []
  function visit(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) visit(abs)
      else if (/\.tmp(?:\.|$)/.test(ent.name)) found.push(path.relative(storeDir, abs))
    }
  }
  visit(storeDir)
  return found.sort()
}

// F4/F5: raw live-holder child utility. Acquires `lockFile` exclusively,
// writes its PID + ISO timestamp + 0 (no ppid inheritance), and waits for
// "release" on stdin before unlinking and exiting. The PARENT owns the
// release timing. A 15-second safety ceiling unlinks the lockfile and
// exits with code 2 if the parent dies before sending release.
function spawnLiveHolder(lockFile) {
  const script = `
    import fs from 'node:fs'
    const lockFile = ${JSON.stringify(lockFile)}
    let fd
    try {
      fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644)
    } catch (e) {
      process.stdout.write(JSON.stringify({ held: false, err: String(e) }))
      process.exit(0)
    }
    const pid = process.pid
    const iso = new Date().toISOString()
    fs.writeSync(fd, pid + '\\n' + iso + '\\n0\\n')
    fs.closeSync(fd)
    process.stdout.write(JSON.stringify({ held: true, pid, lockFile }))
    process.stdin.setEncoding('utf8')
    let buf = ''
    process.stdin.on('data', (chunk) => {
      buf += chunk
      if (buf.includes('release')) {
        try { fs.unlinkSync(lockFile) } catch {}
        process.stdout.write(JSON.stringify({ released: true }))
        process.exit(0)
      }
    })
    process.stdin.on('end', () => { try { fs.unlinkSync(lockFile) } catch {}; process.exit(0) })
    setTimeout(() => { try { fs.unlinkSync(lockFile) } catch {}; process.exit(2) }, 15000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  liveChildren.add(child)
  child.once('exit', () => liveChildren.delete(child))
  return child
}


// safe to call multiple times, safe to call after the child has already
// exited (the writes throw EINVAL/EPIPE which we silently swallow).
function releaseChild(child) {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return
  // A second release can race the holder's own process.exit and otherwise
  // emits ERR_STREAM_WRITE_AFTER_END asynchronously, outside the test body.
  child.stdin.once('error', () => {})
  try { child.stdin.write('release\n') } catch { /* best effort */ }
  try { child.stdin.end() } catch { /* best effort */ }
}

// F7: Resolves when the child has exited. Safe to call before or after
// the child has already exited (in which case it resolves immediately).
function awaitChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
  })
}

// F7: Drive a spawnLiveHolder end-to-end for a single test body. Waits
// for the child to print "{held:true,...}" on stdout (with a 5-second
// ceiling), clears the ceiling timer after readiness regardless of which
// side won, parses the child PID, then runs `body({child, childPid, buf})`.
// The finally block clears any still-pending ceiling timer and releases
// + awaits the child, even if body throws.
async function withLiveHolder(lockFile, body) {
  const child = spawnLiveHolder(lockFile)
  let ceiling = null
  try {
    const buf = await Promise.race([
      waitForMarker(child, '"held":true', 5000),
      new Promise((resolve) => { ceiling = setTimeout(() => resolve(''), 5000) }),
    ])
    if (ceiling) { clearTimeout(ceiling); ceiling = null }
    if (!/"held":true/.test(buf)) {
      const stderr = child.stderr ? (child.stderr.read ? child.stderr.read() : '') : ''
      throw new Error(`holder did not acquire ${lockFile}; stdout=${buf}; stderr=${stderr}`)
    }
    const m = buf.match(/"pid":\s*(\d+)/)
    if (!m) throw new Error(`holder output missing pid: ${buf}`)
    const childPid = parseInt(m[1], 10)
    return await body({ child, childPid, buf })
  } finally {
    // F7: clear any still-pending readiness-ceiling timer and release/
    // await the holder child even when body threw.
    if (ceiling) { clearTimeout(ceiling); ceiling = null }
    if (child.exitCode === null && child.signalCode === null) {
      releaseChild(child)
      await awaitChild(child)
    }
  }
}

// --- helper dynamic loader (allows --expect-main-red before helper exists) ---
async function tryLoadHelper() {
  try {
    return await import(HELPER_URL)
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(e.message)) return null
    throw e
  }
}

// ---------------------------------------------------------------------------
// Helper-only unit tests (Slice 546-S1)
// ---------------------------------------------------------------------------
async function runHelperTests() {
  console.log('# store-write-lock.mjs unit tests')
  const helper = await tryLoadHelper()
  if (!helper) {
    console.log(`not ok 1 - helper missing (scripts/lib/store-write-lock.mjs)\n  Run from a tree where the helper has been created.`)
    fail++
    return
  }

  // --- F1: required public API surface. Every name below is required.
  tap('helper: F1 public API exports the six required names', () => {
    for (const name of [
      'STORE_WRITE_LOCK_BASENAME',
      'storeWriteLockPath',
      'acquireStoreWriteLocksSync',
      'releaseStoreWriteLocks',
      'uniqueStoreTmpPath',
      'atomicReplaceFileSync',
    ]) {
      assert.notEqual(helper[name], undefined,
        `helper.${name} must be exported (got ${typeof helper[name]})`)
    }
    // STORE_WRITE_LOCK_BASENAME is a string; the rest are functions.
    assert.equal(typeof helper.STORE_WRITE_LOCK_BASENAME, 'string',
      `helper.STORE_WRITE_LOCK_BASENAME must be a string`)
    assert.equal(helper.STORE_WRITE_LOCK_BASENAME, 'clerk-apply.lock',
      `helper.STORE_WRITE_LOCK_BASENAME must equal 'clerk-apply.lock'`)
    for (const name of [
      'storeWriteLockPath',
      'acquireStoreWriteLocksSync',
      'releaseStoreWriteLocks',
      'uniqueStoreTmpPath',
      'atomicReplaceFileSync',
    ]) {
      assert.equal(typeof helper[name], 'function',
        `helper.${name} must be a function`)
    }
  })

  tap('helper: storeWriteLockPath — pure path.join, no FS access, never-created path remains absent', () => {
    // The dir passed in has NEVER existed (we did NOT call mkTmp for it).
    // storeWriteLockPath is pure path.join — it must NOT create the dir,
    // and the dir must remain absent on disk after the call.
    const phantom = path.join(
      os.tmpdir(),
      'store-write-lock-path-phantom-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
    assert.equal(fs.existsSync(phantom), false, 'phantom must not exist pre-call')
    const lockPath = helper.storeWriteLockPath(phantom)
    assert.equal(lockPath, path.join(phantom, helper.STORE_WRITE_LOCK_BASENAME))
    assert.equal(path.basename(lockPath), helper.STORE_WRITE_LOCK_BASENAME)
    assert.equal(fs.existsSync(phantom), false, 'storeWriteLockPath must not create the phantom dir')
    assert.equal(fs.existsSync(lockPath), false, 'lockfile must not exist after pure path computation')
    // Type validation: rejects empty / non-string inputs.
    assert.throws(() => helper.storeWriteLockPath(''), /non-empty string/)
    assert.throws(() => helper.storeWriteLockPath(null), /non-empty string/)
    assert.throws(() => helper.storeWriteLockPath(42), /non-empty string/)
  })

  // --- F2 type validation: rejects empty / non-string path before filesystem
  tap('helper: invalid input — non-string / empty / non-array rejects (no FS touch)', () => {
    assert.throws(() => helper.acquireStoreWriteLocksSync(null), /non-empty string/)
    assert.throws(() => helper.acquireStoreWriteLocksSync(''), /non-empty string/)
    assert.throws(() => helper.acquireStoreWriteLocksSync(42), /non-empty string/)
    assert.throws(() => helper.acquireStoreWriteLocksSync([], {}), /at least one/)
  })

  // --- testHelperAcquireRelease: basic acquire + release path
  tap('helper: acquire + release — owned handle returns ok; release clears lockfile', () => {
    const dir = mkTmp('store-write-lock-h1-')
    const res = helper.acquireStoreWriteLocksSync([dir])
    assert.equal(res.ok, true, `expected ok; got ${JSON.stringify(res)}`)
    assert.equal(res.dirs.length, 1)
    assert.equal(path.dirname(res.handles[0].lockFile), dir)
    assert.equal(res.handles[0].inherited, false)
    assert.ok(fs.existsSync(res.handles[0].lockFile), 'lockfile present while held')
    helper.releaseStoreWriteLocks(res.handles)
    assert.equal(fs.existsSync(res.handles[0].lockFile), false, 'lockfile removed after release')
  })

  // --- testSameProcessInheritance: same-process inheritance
  tap('helper: same-process inheritance — re-acquire when caller pid is the live heldBy returns inherited', () => {
    const dir = mkTmp('store-write-lock-spi-')
    const first = helper.acquireStoreWriteLocksSync([dir])
    assert.equal(first.ok, true)
    const second = helper.acquireStoreWriteLocksSync([dir])
    assert.equal(second.ok, true)
    assert.equal(second.handles[0].inherited, true)
    assert.equal(second.handles[0].pid, process.pid)
    helper.releaseStoreWriteLocks(second.handles)
    assert.ok(fs.existsSync(first.handles[0].lockFile), 'original lockfile preserved after inherited release')
    helper.releaseStoreWriteLocks(first.handles)
    assert.equal(fs.existsSync(first.handles[0].lockFile), false)
  })

  // --- F5: real direct-child test. Parent acquires, spawnSync child which
  //     imports the helper and acquires the SAME store. The child MUST
  //     report inherited=true (its process.ppid === our process.pid).
  //     The child's release is a no-op for the inherited handle. The
  //     parent lockfile MUST survive the child's exit.
  tap('helper: F5 direct-child — parent acquires; spawnSync child inherits and no-op releases; parent lock survives', () => {
    const dir = mkTmp('store-write-lock-dchild-')
    const parent = helper.acquireStoreWriteLocksSync([dir])
    assert.equal(parent.ok, true)
    assert.equal(parent.handles[0].inherited, false)
    const parentLockFile = parent.handles[0].lockFile
    const parentPid = process.pid

    // The child's process.ppid equals our process.pid. The helper's
    // heldBy === process.ppid check fires and the child returns an
    // inherited handle. Child's release is a no-op because inherited=true.
    const childScript = `
      const helper = await import(${JSON.stringify(HELPER_URL)})
      const dir = process.env.EM_DIR
      const res = helper.acquireStoreWriteLocksSync([dir])
      const h0 = res && res.handles && res.handles[0]
      helper.releaseStoreWriteLocks(res && res.handles)
      process.stdout.write(JSON.stringify({
        ok: !!(res && res.ok),
        inherited: !!(h0 && h0.inherited),
        pid: h0 ? h0.pid : null,
        expectedPpid: process.ppid,
      }))
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      env: { ...process.env, EM_DIR: dir },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, `child must exit 0; got status=${r.status}; stderr=${r.stderr || ''}`)
    const trimmed = (r.stdout || '').trim()
    assert.ok(trimmed.length > 0, `child stdout must contain JSON; got '${r.stdout}'`)
    const childRes = JSON.parse(trimmed)
    assert.equal(childRes.ok, true, `child acquire must succeed; stdout='${r.stdout}'; stderr='${r.stderr || ''}'`)
    assert.equal(childRes.inherited, true,
      `child must report inherited=true (ppid=${childRes.expectedPpid} === parent=${parentPid}); got '${r.stdout}'`)
    assert.equal(childRes.pid, parentPid,
      `child's inherited pid must equal parent pid ${parentPid}; got '${r.stdout}'`)

    // Parent's lockfile survives the child's no-op inherited release.
    assert.ok(fs.existsSync(parentLockFile),
      'parent lockfile must survive the inherited-release from the child')
    helper.releaseStoreWriteLocks(parent.handles)
    assert.equal(fs.existsSync(parentLockFile), false,
      'parent lockfile removed after parent release')
  })

  // --- testMalformedLockTimesOut: heldBy=null OR garbage owner times out
  tap('helper: malformed lock (heldBy=null) — times out with code store-write-lock-timeout', () => {
    const dir = mkTmp('store-write-lock-mal-')
    const lockFile = helper.storeWriteLockPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(lockFile, `not-a-pid\n${new Date().toISOString()}\n0\n`)
    const res = helper.acquireStoreWriteLocksSync([dir], { timeoutMs: 200, pollMs: 25 })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'store-write-lock-timeout')
    assert.equal(res.heldBy, null)
    fs.unlinkSync(lockFile)
  })

  tap('helper: malformed lock (alive non-parent pid) — times out, no inheritance', () => {
    const dir = mkTmp('store-write-lock-mal2-')
    const lockFile = helper.storeWriteLockPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(lockFile, `0\n${new Date().toISOString()}\n0\n`)
    const res = helper.acquireStoreWriteLocksSync([dir], { timeoutMs: 150, pollMs: 25 })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'store-write-lock-timeout')
    assert.equal(res.heldBy, null)
    fs.unlinkSync(lockFile)
  })

  // --- testMultiStoreOrder: ordered acquisition + reverse release.
  //     F3 ordered handles array: dirs are listed in the order returned
  //     by canonicalizeAndSort (lexical-sorted, deduped canonical).
  tap('helper: multi-store order — canonicalize, dedupe, lexical acquisition; reverse release', () => {
    const base = mkTmp('store-write-lock-multi-')
    const b = path.join(base, 'b')
    const a = path.join(base, 'a')
    const c = path.join(base, 'c')
    fs.mkdirSync(b); fs.mkdirSync(a); fs.mkdirSync(c)
    const res = helper.acquireStoreWriteLocksSync([c, a, b, a])
    assert.equal(res.ok, true)
    assert.deepEqual(res.dirs, [a, b, c],
      `dirs should be lexically-sorted unique canonicalized; got ${JSON.stringify(res.dirs)}`)
    // F3: handles array preserves acquisition order. With no inheritance
    // every handle is owned; reverse-release removes them c, b, a.
    assert.equal(res.handles.length, 3)
    for (let i = 0; i < res.handles.length; i++) {
      assert.equal(res.handles[i].inherited, false)
    }
    for (const d of [a, b, c]) {
      assert.ok(fs.existsSync(helper.storeWriteLockPath(d)),
        `lockfile for ${d} should exist while held`)
    }
    helper.releaseStoreWriteLocks(res.handles)
    for (const d of [a, b, c]) {
      assert.equal(fs.existsSync(helper.storeWriteLockPath(d)), false,
        `lockfile for ${d} should be removed after release`)
    }
  })

  // --- testSymlinkAliasDedup: two spellings of one canonical directory.
  tap('helper: symlink alias dedup — two paths to one existing store produce one lock', () => {
    const base = mkTmp('store-write-lock-sym-')
    const target = path.join(base, 'canonical')
    const link = path.join(base, 'alias')
    fs.mkdirSync(target)
    try { fs.symlinkSync(target, link) } catch (e) {
      console.log(`  # SKIP symlink not permitted: ${e.message}`)
      return
    }
    const res = helper.acquireStoreWriteLocksSync([target, link])
    assert.equal(res.ok, true)
    assert.equal(res.dirs.length, 1, `expected 1 canonical dir; got ${res.dirs.length}: ${res.dirs.join(',')}`)
    helper.releaseStoreWriteLocks(res.handles)
    assert.equal(fs.existsSync(helper.storeWriteLockPath(target)), false)
  })

  // --- F2 NEW: symlinked-parent dedupe — a missing store reached through
  //     a symlinked parent dedupes with its real parent spelling. After
  //     the F2 redesign (validate → mkdir → realpath → dedupe → sort),
  //     mkdirSync creates the once-missing entry, both realpaths land on
  //     the same canonical path, and the helper owns ONE lock.
  tap('helper: F2 symlinked-parent dedupe — missing store through symlinked parent dedupes with real parent spelling', () => {
    const base = mkTmp('store-write-lock-symparent-')
    const aliasHolder = mkTmp('store-write-lock-symparent-alias-')
    const aliasParent = path.join(aliasHolder, 'alias-parent')
    try {
      fs.symlinkSync(base, aliasParent)
    } catch (e) {
      console.log(`  # SKIP symlink not permitted: ${e.message}`)
      return
    }
    const realSpelling = path.join(base, 'real-store')
    const symSpelling = path.join(aliasParent, 'real-store')
    // Sanity: neither the real dir nor the symlinked alias exists yet.
    assert.equal(fs.existsSync(realSpelling), false, 'real spelling must not exist pre-call')
    assert.equal(fs.existsSync(symSpelling), false, 'sym spelling must not exist pre-call')

    const res = helper.acquireStoreWriteLocksSync([realSpelling, symSpelling])
    assert.equal(res.ok, true, `expected ok; got ${JSON.stringify(res)}`)
    assert.equal(res.dirs.length, 1,
      `expected ONE canonical dir (symlinked-parent dedupe); got ${res.dirs.length}: ${JSON.stringify(res.dirs)}`)
    // The single canonical dir is the realpath of base/real-store — i.e.,
    // the real (non-symlinked) spelling. Both inputs collapse to it.
    assert.equal(res.dirs[0], fs.realpathSync(base) + path.sep + 'real-store')
    // One lockfile exists, owned.
    assert.equal(res.handles.length, 1)
    assert.equal(fs.existsSync(res.handles[0].lockFile), true)
    helper.releaseStoreWriteLocks(res.handles)
    assert.equal(fs.existsSync(res.handles[0].lockFile), false)
  })

  // --- testPartialAcquireCleanup: failure on second store releases the first
  //     using a REAL live foreign holder on canonical store B (not malformed
  //     PID 0). The helper acquires A, times out on B, releases A, and
  //     preserves B until the child is told to release.
  await asyncTap('helper: partial acquire cleanup — live foreign holder on B; A released; B preserved until child releases', async () => {
    const base = mkTmp('store-write-lock-partial-')
    const a = path.join(base, 'a')
    const b = path.join(base, 'b')
    fs.mkdirSync(a); fs.mkdirSync(b)
    const bLock = helper.storeWriteLockPath(b)
    await withLiveHolder(bLock, async ({ child, childPid }) => {
      const res = helper.acquireStoreWriteLocksSync([a, b], { timeoutMs: 200, pollMs: 25 })
      assert.equal(res.ok, false, 'helper must time out while child holds B')
      assert.equal(res.code, 'store-write-lock-timeout')
      assert.equal(res.heldBy, childPid, `heldBy must equal child PID ${childPid}; got ${res.heldBy}`)
      // F3: the FIRST acquired (owned) lock on store A MUST be released even
      // though the second acquire failed. The B lock is the child's, not ours,
      // so it remains in place until the child is told to release.
      assert.equal(fs.existsSync(helper.storeWriteLockPath(a)), false,
        'first acquired lockfile must be released on second-acquire timeout')
      assert.ok(fs.existsSync(bLock),
        'live foreign holder lockfile must be preserved while child still owns it')
    })
    // After withLiveHolder's finally released the child, B's lockfile is gone.
    assert.equal(fs.existsSync(bLock), false, 'B lockfile removed after child released')
  })

  // --- F4 NEW: foreign positive live PID — helper returns heldBy equal to
  //     the child's PID and leaves the holder lock untouched until release.
  await asyncTap('helper: foreign positive live PID — times out with heldBy equal to child PID; holder lock untouched until release', async () => {
    const dir = mkTmp('store-write-lock-foreign-')
    const lockFile = helper.storeWriteLockPath(dir)
    await withLiveHolder(lockFile, async ({ childPid }) => {
      const res = helper.acquireStoreWriteLocksSync([dir], { timeoutMs: 200, pollMs: 25 })
      assert.equal(res.ok, false, 'helper must time out while foreign child holds the lock')
      assert.equal(res.code, 'store-write-lock-timeout')
      assert.equal(res.heldBy, childPid,
        `heldBy must equal child PID ${childPid}; got ${res.heldBy}`)
      assert.ok(fs.existsSync(lockFile),
        'holder lockfile must remain untouched while child holds it')
    })
    assert.equal(fs.existsSync(lockFile), false,
      'holder lockfile removed after child released')
  })

  // --- F6 NEW: mixed-order nested acquire. Parent owns A. Nested acquire
  //     of [A, B] must return handles in canonical order [A inherited, B
  //     owned]. Releasing the nested handles removes only B's owned
  //     handle; A's inherited handle is skipped so the outer A lock
  //     survives. Releasing the outer handles then removes A.
  tap('helper: mixed-order nested — parent owns A; nested [A,B] returns [A inherited, B owned]; release nested keeps A', () => {
    const base = mkTmp('store-write-lock-mixed-')
    const a = path.join(base, 'a')
    const b = path.join(base, 'b')
    fs.mkdirSync(a); fs.mkdirSync(b)
    const aLock = helper.storeWriteLockPath(a)
    const bLock = helper.storeWriteLockPath(b)
    // Outer: acquire A only.
    const outer = helper.acquireStoreWriteLocksSync([a])
    assert.equal(outer.ok, true)
    assert.equal(outer.handles.length, 1)
    assert.equal(outer.handles[0].inherited, false)
    assert.equal(outer.handles[0].pid, process.pid)
    assert.ok(fs.existsSync(aLock), 'A lockfile present while outer holds it')

    // Nested: [A, B]. A is held by the parent (pid match → inherited).
    // B is a new canonical store → owned.
    const nested = helper.acquireStoreWriteLocksSync([a, b])
    assert.equal(nested.ok, true)
    assert.equal(nested.handles.length, 2)
    // Canonical order is lexical: 'a' < 'b'.
    assert.equal(nested.handles[0].lockFile, aLock)
    assert.equal(nested.handles[0].inherited, true,
      'A must be inherited — parent already holds it')
    assert.equal(nested.handles[0].pid, process.pid,
      'A inherited pid must equal the parent pid (process.pid)')
    assert.equal(nested.handles[1].lockFile, bLock)
    assert.equal(nested.handles[1].inherited, false,
      'B must be owned — no one else holds it')
    assert.equal(nested.handles[1].pid, process.pid)
    assert.ok(fs.existsSync(bLock), 'B lockfile present while nested holds it')

    // Release nested: only the OWNED B handle is released. A's inherited
    // handle is skipped, so the outer A lockfile survives.
    helper.releaseStoreWriteLocks(nested.handles)
    assert.equal(fs.existsSync(bLock), false,
      'B lockfile removed after releasing nested (owned)')
    assert.ok(fs.existsSync(aLock),
      'A lockfile preserved because nested handle was inherited (no release)')

    // Release outer: A's owned handle is released.
    helper.releaseStoreWriteLocks(outer.handles)
    assert.equal(fs.existsSync(aLock), false, 'A lockfile removed after releasing outer')
  })

  // --- testUniqueTmpPaths: tmp paths are unique per call (F1: rename).
  tap('helper: unique tmp paths — same finalPath produces different tmp paths across calls', () => {
    const finalPath = path.join(mkTmp('store-write-lock-uniq-'), 'index.json')
    const seen = new Set()
    for (let i = 0; i < 25; i++) seen.add(helper.uniqueStoreTmpPath(finalPath))
    assert.equal(seen.size, 25, 'each call must yield a distinct tmp path')
    for (const p of seen) assert.equal(path.dirname(p), path.dirname(finalPath))
    // Required public name: rejects empty finalPath.
    assert.throws(() => helper.uniqueStoreTmpPath(''), /non-empty string/)
  })

  // --- testAtomicReplace: success path replaces final + cleans tmp
  tap('helper: atomic replace — writes final, no tmp left', () => {
    const dir = mkTmp('store-write-lock-atomic-ok-')
    const finalPath = path.join(dir, 'index.json')
    helper.atomicReplaceFileSync(finalPath, '{"ok":1}\n')
    assert.ok(fs.existsSync(finalPath))
    const text = fs.readFileSync(finalPath, 'utf8')
    assert.equal(text, '{"ok":1}\n')
    const tmps = fs.readdirSync(dir).filter(f => /\.tmp\./.test(f))
    assert.equal(tmps.length, 0, `tmp litter: ${tmps.join(',')}`)
  })

  // --- testAtomicReplaceCleanup: failure before rename cleans own tmp,
  //     prior final file survives. F4's full-write loop surfaces partial
  //     failures here just as well.
  tap('helper: atomic replace failure — own tmp cleaned, prior final preserved', () => {
    const dir = mkTmp('store-write-lock-atomic-fail-')
    const finalPath = path.join(dir, 'tags.json')
    fs.writeFileSync(finalPath, '{"prior":"keep"}\n')
    const origFsync = fs.fsyncSync
    fs.fsyncSync = function patchedFsync() {
      throw new Error('injected fsync failure')
    }
    try {
      let threw = false
      try { helper.atomicReplaceFileSync(finalPath, '{"new":"data"}') }
      catch (e) { threw = true }
      assert.ok(threw, 'helper must propagate the failure')
      assert.equal(fs.readFileSync(finalPath, 'utf8'), '{"prior":"keep"}\n',
        'pre-existing final file must survive a failed replace')
      const tmps = fs.readdirSync(dir).filter(f => /\.tmp\./.test(f))
      assert.equal(tmps.length, 0, `tmp litter after failure: ${tmps.join(',')}`)
    } finally {
      fs.fsyncSync = origFsync
    }
  })

  // --- F4 NEW: cross-directory tmpPath rejection. The check happens
  //     BEFORE any open/write, so neither tmpPath nor finalPath is
  //     created; both dirs are unchanged.
  tap('helper: F4 atomic replace cross-dir tmpPath — rejects before opening, no files changed', () => {
    const dirA = mkTmp('store-write-lock-xdir-a-')
    const dirB = mkTmp('store-write-lock-xdir-b-')
    const finalPath = path.join(dirA, 'final.json')
    const crossTmp = path.join(dirB, 'final.json.tmp.x')
    let threw = false
    let caughtErr = null
    try {
      helper.atomicReplaceFileSync(finalPath, '{"x":1}', { tmpPath: crossTmp })
    } catch (e) { threw = true; caughtErr = e }
    assert.ok(threw, 'cross-directory tmpPath must throw')
    assert.match((caughtErr && caughtErr.message) || String(caughtErr), /same directory/i,
      'error must call out the directory invariant')
    // No tmp file ever materialized in either directory; finalPath was
    // never created either. Both dirs are unchanged.
    assert.equal(fs.existsSync(crossTmp), false, 'cross-dir tmpPath must not be created')
    assert.equal(fs.existsSync(finalPath), false, 'finalPath must not be created on rejection')
    // Empty/non-string tmpPath is its own TypeError.
    assert.throws(() => helper.atomicReplaceFileSync(finalPath, 'x', { tmpPath: '' }), /non-empty string/)
    assert.throws(() => helper.atomicReplaceFileSync(finalPath, 'x', { tmpPath: 99 }), /non-empty string/)
  })

  // --- testDeterministicEexistPreserves: pre-existing tmpPath → EEXIST
  //     propagates WITHOUT deleting the collision or the final file.
  tap('helper: deterministic EEXIST — pre-existing tmpPath raises, preserves both files', () => {
    const dir = mkTmp('store-write-lock-eexist-')
    const finalPath = path.join(dir, 'category-index.json')
    fs.writeFileSync(finalPath, '{"prior":"keep"}')
    const collision = path.join(dir, 'collision.tmp')
    fs.writeFileSync(collision, '{"collider":"keep"}')
    let threw = false
    let caughtErr = null
    try {
      helper.atomicReplaceFileSync(finalPath, '{"new":"data"}', { tmpPath: collision })
    } catch (e) { threw = true; caughtErr = e }
    assert.ok(threw, 'EEXIST must propagate')
    assert.match(caughtErr.message || String(caughtErr), /EEXIST|exists/i)
    assert.equal(fs.readFileSync(finalPath, 'utf8'), '{"prior":"keep"}')
    assert.equal(fs.readFileSync(collision, 'utf8'), '{"collider":"keep"}')
  })

  // --- testNoTmpLitter: full helper cycle leaves no tmp litter
  tap('helper: no tmp litter across a full lifecycle', () => {
    const dir = mkTmp('store-write-lock-nolitter-')
    const res = helper.acquireStoreWriteLocksSync([dir])
    assert.equal(res.ok, true)
    const finals = ['index.json', 'tags.json', 'category-index.json', 'tokens.json', 'x.json']
    for (const name of finals) {
      helper.atomicReplaceFileSync(path.join(dir, name), `{"name":"${name}"}`)
    }
    helper.releaseStoreWriteLocks(res.handles)
    const litter = fs.readdirSync(dir).filter(f => /\.tmp\./.test(f))
    assert.equal(litter.length, 0, `tmp litter in lifecycle: ${litter.join(',')}`)
  })

  // --- testIndependentStoresProceed
  tap('helper: independent stores proceed in parallel (acquire A does not block acquire B)', () => {
    const base = mkTmp('store-write-lock-indep-')
    const a = path.join(base, 'A'); const b = path.join(base, 'B')
    fs.mkdirSync(a); fs.mkdirSync(b)
    const ra = helper.acquireStoreWriteLocksSync([a])
    assert.equal(ra.ok, true)
    const rb = helper.acquireStoreWriteLocksSync([b])
    assert.equal(rb.ok, true, 'store B must proceed while store A is held')
    helper.releaseStoreWriteLocks(ra.handles)
    helper.releaseStoreWriteLocks(rb.handles)
  })

  // --- testReleaseIdempotent
  tap('helper: releaseStoreWriteLocks is idempotent — repeated calls are no-ops', () => {
    const dir = mkTmp('store-write-lock-idem-')
    const res = helper.acquireStoreWriteLocksSync([dir])
    assert.equal(res.ok, true)
    helper.releaseStoreWriteLocks(res.handles)
    helper.releaseStoreWriteLocks(res.handles)
    assert.equal(fs.existsSync(res.handles[0].lockFile), false)
  })
}

// ---------------------------------------------------------------------------
// End-to-end: external live holder against real `em-store`
// ---------------------------------------------------------------------------
//
// External-holder protocol (parallelize the §15 negative-control artifact):
//   - holder acquires the lock, then WAITS for a "release" message on its
//     stdin. The PARENT owns the release timing (no fixed holdMs).
//   - parent spawns holder, confirms "{held:true}", then spawns the writer
//     and races writer.exit against a bounded 3-second window.
//   - writerExitedBeforeRelease is the actual race outcome:
//       * true  → writer exited before the 3s window expired. Current-main
//                 observable: writer raced past the held lock.
//       * false → window expired first; the writer is still alive waiting
//                 for the lock. Post-fix observable.
//   - parent sends "release\n" to the holder's stdin AFTER the race, then
//     awaits both children cleanly.
//   - The §15 assertion requires writerExitedBeforeRelease === false. On
//     current main this fails (exit non-zero) and prints
//     writerExitedBeforeRelease=true. After the fix it passes.
async function runExternalHolderTest() {
  console.log('# external live holder vs real em-store')
  const fixture = mkTmp('store-write-e2e-')
  const storeCwd = path.join(fixture, 'store-cwd')
  fs.mkdirSync(storeCwd, { recursive: true })
  const storeDir = path.join(storeCwd, '.episodic-memory')
  fs.mkdirSync(storeDir, { recursive: true })
  const lockFile = path.join(storeDir, 'clerk-apply.lock')
  const env = { ...process.env, HOME: fixture }

  const holderScript = `
    import fs from 'node:fs'
    import path from 'node:path'
    const lockFile = ${JSON.stringify(lockFile)}
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    let fd
    try {
      fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644)
    } catch (e) {
      process.stdout.write(JSON.stringify({ held: false, code: 'eexist', err: String(e) }))
      process.exit(0)
    }
    const pid = process.pid
    const ppid = process.ppid
    const iso = new Date().toISOString()
    fs.writeSync(fd, pid + '\\n' + iso + '\\n' + ppid + '\\n')
    fs.closeSync(fd)
    process.stdout.write(JSON.stringify({ held: true, pid, lockFile }))
    process.stdin.setEncoding('utf8')
    let buf = ''
    process.stdin.on('data', (chunk) => {
      buf += chunk
      if (buf.includes('release')) {
        try { fs.unlinkSync(lockFile) } catch {}
        process.stdout.write(JSON.stringify({ released: true }))
        process.exit(0)
      }
    })
    process.stdin.on('end', () => { try { fs.unlinkSync(lockFile) } catch {}; process.exit(0) })
    // Safety ceiling: the parent owns the release decision, but if the
    // parent dies we exit and unlink so the lockfile is not orphaned.
    setTimeout(() => { try { fs.unlinkSync(lockFile) } catch {}; process.exit(2) }, 15_000)
  `
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  })
  liveChildren.add(holder)
  holder.once('exit', () => liveChildren.delete(holder))
  // Wait for holder to confirm acquisition before spawning the writer.
  const holderBuf = await waitForMarker(holder, '"held":true', 5000)
  if (!/"held":true/.test(holderBuf)) {
    throw new Error(
      `holder did not acquire clerk-apply.lock; stdout=${holderBuf}; ` +
      `stderr=${holder.stderr.read() || ''}`,
    )
  }

  const writerStart = Date.now()
  const writer = spawn(process.execPath, [
    STORE,
    '--project', 'issue-546',
    '--category', 'decision',
    '--tags', 'issue-546-fixture',
    '--summary', 'concurrency fixture',
    '--body', 'body',
    '--scope', 'local',
  ], { cwd: storeCwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  commandChildren.add(writer)
  writer.once('exit', () => commandChildren.delete(writer))
  let writerErr = ''
  writer.stderr.on('data', (d) => writerErr += d.toString())

  // Bounded 3-second window: the parent owns whether the writer raced
  // past the held lock (current main) or actually waited for it (fix).
  const WINDOW_MS = 3000
  const exitPromise = new Promise((resolve) => {
    writer.once('exit', (code) => resolve({ kind: 'exit', code }))
  })
  const windowPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ kind: 'window' }), WINDOW_MS)
  })
  const winner = await Promise.race([exitPromise, windowPromise])
  const writerExitedBeforeRelease = winner.kind === 'exit'
  console.log(`writerExitedBeforeRelease=${writerExitedBeforeRelease}`)

  // Send release; the holder's stdin parser unlinks the lockfile.
  try { holder.stdin.write('release\n') } catch {}
  try { holder.stdin.end() } catch {}

  // Await both children. `exitPromise` is a single listener; if writer
  // exited during the race it has already resolved, else it resolves now.
  const finalWriterCode = (await exitPromise).code
  const writerExitAt = Date.now() - writerStart
  await waitForExit(holder)

  tap(EXPECT_MAIN_RED
    ? 'E2E (--expect-main-red): writer must WAIT for live external holder (issue 546 fix)'
    : 'E2E: writer must WAIT for live external holder (issue 546 fix)', () => {
    assert.equal(writerExitedBeforeRelease, false,
      `writerExitedBeforeRelease must be false (writer waited for the holder); got ${writerExitedBeforeRelease} (exit=${finalWriterCode}, ms=${writerExitAt}, stderr=${writerErr}). On current main this proves the bug: writer raced past the live lock.`)
    assert.equal(finalWriterCode, 0,
      `writer must exit 0 after fix; got ${finalWriterCode}; stderr=${writerErr}`)
  })
}

// ---------------------------------------------------------------------------
// Slice 546-S2a integration coverage: real store/revise processes only,
// always against mkTmp fixture stores with explicit cwd and isolated HOME.
// ---------------------------------------------------------------------------
function storeArgs(i, scope = 'local') {
  return [
    '--project', 'issue-546-fixture',
    '--category', 'decision',
    '--tag', `writer-${i}-sentinel`,
    '--summary', `concurrent writer ${i}`,
    '--body', `unique body uniquetoken${i}`,
    '--scope', scope,
  ]
}

function seedLocalOriginal(fixture, suffix) {
  const r = runJsonSync(STORE, [
    '--project', 'issue-546-fixture',
    '--category', 'decision',
    '--tag', `original-${suffix}`,
    '--summary', `original ${suffix}`,
    '--body', `original body originaltoken${suffix}`,
    '--scope', 'local',
  ], fixture)
  assert.equal(r.code, 0, `seed store failed: stdout=${r.stdout} stderr=${r.stderr}`)
  assert.equal(r.json?.status, 'ok', `seed store returned invalid JSON: ${r.stdout}`)
  return r.json
}

async function testConcurrentStoreParity() {
  const fixture = mkStoreFixture('store-write-concurrent-')
  const completions = []
  const children = []
  const started = Date.now()
  try {
    for (let i = 0; i < 16; i++) {
      const completion = spawnJson(STORE, storeArgs(i), fixture)
      completions.push(completion)
      children.push(completion.child)
    }
    const results = await Promise.all(completions)
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      assert.equal(r.code, 0, `store ${i} failed: stdout=${r.stdout} stderr=${r.stderr}`)
      assert.equal(r.json?.status, 'ok', `store ${i} returned invalid JSON: ${r.stdout}`)
    }

    const ids = results.map(r => r.json.id)
    assert.equal(new Set(ids).size, 16, 'all concurrent stores must return unique ids')
    assertIds(episodeIds(fixture.localDir), ids, 'episode files and successful ids diverged')
    const rows = readIndexRows(fixture.localDir)
    assert.equal(rows.length, 16, 'index must contain exactly 16 rows')
    assertIds(rows.map(row => row.id), ids, 'index rows and episode files diverged')
    assert.ok(rows.every(row => row.category === 'decision' && row.status === 'active'),
      'all concurrent rows must be active decisions')

    const tags = readJson(fixture.localDir, 'tags.json')
    const categories = readJson(fixture.localDir, 'category-index.json')
    const tokens = readJson(fixture.localDir, 'tokens.json')
    assertPosting(categories, 'decision', ids, 'category parity')
    for (let i = 0; i < 16; i++) {
      assertPosting(tags, `writer-${i}-sentinel`, [results[i].json.id], `tag parity writer ${i}`)
      assertPosting(tokens, `uniquetoken${i}`, [results[i].json.id], `token parity writer ${i}`)
    }
    const litter = tmpLitter(fixture.localDir)
    assert.deepEqual(litter, [], `temporary-file litter: ${litter.join(', ')}`)
    assert.equal(fs.existsSync(path.join(fixture.localDir, 'clerk-apply.lock')), false,
      'store lock must be released after all writers')
    telemetry.concurrentStoreParity = {
      writers: 16,
      elapsedMs: Date.now() - started,
      episodes: episodeIds(fixture.localDir).length,
      indexRows: rows.length,
      categoryIds: categories.decision.length,
      tmpLitter: litter.length,
    }
  } finally {
    await stopChildren(children)
  }
}

async function testStoreTimeoutNoWrite() {
  const fixture = mkStoreFixture('store-write-timeout-')
  fs.mkdirSync(fixture.localDir, { recursive: true })
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')
  await withLiveHolder(lockFile, async ({ childPid }) => {
    const before = byteSnapshot(fixture.localDir)
    const r = runJsonSync(STORE, storeArgs('timeout'), fixture, {
      EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS: '200',
    })
    const after = byteSnapshot(fixture.localDir)
    assert.notEqual(r.code, 0, 'store must fail while a foreign live holder owns the lock')
    assert.equal(r.json?.status, 'error', `store timeout JSON missing: ${r.stdout}`)
    assert.equal(r.json?.code, 'store-write-lock-timeout', `wrong timeout code: ${r.stdout}`)
    assert.equal(r.json?.heldBy, childPid, 'timeout must report the live holder pid')
    assert.deepEqual(after, before, 'store timeout changed fixture bytes before returning')
    assert.deepEqual(tmpLitter(fixture.localDir), [], 'store timeout left temporary litter')
    telemetry.storeTimeoutNoWrite = {
      elapsedMs: r.elapsedMs,
      exitCode: r.code,
      heldByMatched: r.json?.heldBy === childPid,
      unchanged: true,
    }
  })
}

async function testCrossStoreReviseParity() {
  const fixture = mkStoreFixture('store-write-cross-revise-')
  const original = seedLocalOriginal(fixture, 'cross')
  const r = runJsonSync(REVISE, [
    '--original', original.id,
    '--project', 'issue-546-fixture',
    '--tag', 'cross-new',
    '--summary', 'cross scope successor',
    '--body', 'cross scope body crossrevisiontoken',
    '--scope', 'global',
  ], fixture)
  assert.equal(r.code, 0, `cross-store revise failed: stdout=${r.stdout} stderr=${r.stderr}`)
  assert.equal(r.json?.status, 'ok', `cross-store revise returned invalid JSON: ${r.stdout}`)
  assert.equal(r.json?.scope, 'global')
  const successor = r.json.id

  assertIds(episodeIds(fixture.localDir), [original.id], 'source episode set')
  assert.equal(episodeStatus(fixture.localDir, original.id), 'superseded')
  const localRows = readIndexRows(fixture.localDir)
  assert.equal(localRows.length, 1)
  assert.equal(localRows[0].id, original.id)
  assert.equal(localRows[0].status, 'superseded')

  assertIds(episodeIds(fixture.globalDir), [successor], 'destination episode set')
  assert.equal(episodeStatus(fixture.globalDir, successor), 'active')
  const globalRows = readIndexRows(fixture.globalDir)
  assert.equal(globalRows.length, 1)
  assert.equal(globalRows[0].id, successor)
  assert.equal(globalRows[0].supersedes, original.id)
  assert.equal(globalRows[0].status, 'active')

  const localTags = readJson(fixture.localDir, 'tags.json')
  const localCategories = readJson(fixture.localDir, 'category-index.json')
  const localTokens = readJson(fixture.localDir, 'tokens.json')
  assertPosting(localTags, 'original-cross', [original.id, successor], 'source inherited tag parity')
  assertPosting(localTags, 'cross-new', [successor], 'source new tag parity')
  assertPosting(localCategories, 'decision', [original.id, successor], 'source category parity')
  assertPosting(localTokens, 'crossrevisiontoken', [successor], 'source token parity')

  const globalTags = readJson(fixture.globalDir, 'tags.json')
  const globalCategories = readJson(fixture.globalDir, 'category-index.json')
  const globalTokens = readJson(fixture.globalDir, 'tokens.json')
  assertPosting(globalTags, 'original-cross', [successor], 'destination inherited tag parity')
  assertPosting(globalTags, 'cross-new', [successor], 'destination new tag parity')
  assertPosting(globalCategories, 'decision', [successor], 'destination category parity')
  assertPosting(globalTokens, 'crossrevisiontoken', [successor], 'destination token parity')
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'source temporary litter')
  assert.deepEqual(tmpLitter(fixture.globalDir), [], 'destination temporary litter')
  assert.equal(fs.existsSync(path.join(fixture.localDir, 'clerk-apply.lock')), false)
  assert.equal(fs.existsSync(path.join(fixture.globalDir, 'clerk-apply.lock')), false)
  telemetry.crossStoreReviseParity = {
    elapsedMs: r.elapsedMs,
    sourceEpisodes: 1,
    sourceIndexRows: localRows.length,
    destinationEpisodes: 1,
    destinationIndexRows: globalRows.length,
    tmpLitter: 0,
  }
}

async function testReviseTimeoutNoWrite() {
  const fixture = mkStoreFixture('store-write-revise-timeout-')
  const original = seedLocalOriginal(fixture, 'timeout')
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')
  await withLiveHolder(lockFile, async ({ childPid }) => {
    const before = byteSnapshot(fixture.localDir)
    const r = runJsonSync(REVISE, [
      '--original', original.id,
      '--project', 'issue-546-fixture',
      '--summary', 'must not be written',
      '--body', 'must not be written',
      '--scope', 'inherit',
    ], fixture, { EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS: '200' })
    const after = byteSnapshot(fixture.localDir)
    assert.notEqual(r.code, 0, 'revise must fail while a foreign live holder owns the lock')
    assert.equal(r.json?.status, 'error', `revise timeout JSON missing: ${r.stdout}`)
    assert.equal(r.json?.code, 'store-write-lock-timeout', `wrong revise timeout code: ${r.stdout}`)
    assert.equal(r.json?.heldBy, childPid, 'revise timeout must report the live holder pid')
    assert.deepEqual(after, before, 'revise timeout changed fixture bytes before returning')
    assert.equal(episodeStatus(fixture.localDir, original.id), 'active')
    assert.deepEqual(tmpLitter(fixture.localDir), [], 'revise timeout left temporary litter')
    telemetry.reviseTimeoutNoWrite = {
      elapsedMs: r.elapsedMs,
      exitCode: r.code,
      heldByMatched: r.json?.heldBy === childPid,
      unchanged: true,
    }
  })
}

async function testSameStoreReviseParity() {
  const fixture = mkStoreFixture('store-write-same-revise-')
  const original = seedLocalOriginal(fixture, 'same')
  const r = runJsonSync(REVISE, [
    '--original', original.id,
    '--project', 'issue-546-fixture',
    '--tag', 'same-new',
    '--summary', 'same store successor',
    '--body', 'same store body samerevisiontoken',
    '--scope', 'inherit',
  ], fixture)
  assert.equal(r.code, 0, `same-store revise failed (lock inputs must dedupe): stdout=${r.stdout} stderr=${r.stderr}`)
  assert.equal(r.json?.status, 'ok')
  assert.equal(r.json?.scope, 'local')
  const successor = r.json.id
  const ids = [original.id, successor]
  assertIds(episodeIds(fixture.localDir), ids, 'same-store episode parity')
  assert.equal(episodeStatus(fixture.localDir, original.id), 'superseded')
  assert.equal(episodeStatus(fixture.localDir, successor), 'active')
  const rows = readIndexRows(fixture.localDir)
  assertIds(rows.map(row => row.id), ids, 'same-store index parity')
  assert.equal(rows.find(row => row.id === original.id)?.status, 'superseded')
  assert.equal(rows.find(row => row.id === successor)?.status, 'active')
  assert.equal(rows.find(row => row.id === successor)?.supersedes, original.id)
  const tags = readJson(fixture.localDir, 'tags.json')
  const categories = readJson(fixture.localDir, 'category-index.json')
  const tokens = readJson(fixture.localDir, 'tokens.json')
  assertPosting(tags, 'original-same', ids, 'same-store inherited tag parity')
  assertPosting(tags, 'same-new', [successor], 'same-store new tag parity')
  assertPosting(categories, 'decision', ids, 'same-store category parity')
  assertPosting(tokens, 'originaltokensame', [original.id], 'same-store original token parity')
  assertPosting(tokens, 'samerevisiontoken', [successor], 'same-store successor token parity')
  const litter = tmpLitter(fixture.localDir)
  assert.deepEqual(litter, [], `same-store temporary litter: ${litter.join(', ')}`)
  assert.equal(fs.existsSync(path.join(fixture.localDir, 'clerk-apply.lock')), false,
    'deduped same-store lock must be fully released')
  telemetry.sameStoreReviseParity = {
    elapsedMs: r.elapsedMs,
    episodes: 2,
    indexRows: rows.length,
    categoryIds: categories.decision.length,
    tmpLitter: litter.length,
  }
}

async function testMissingOriginalIndexRowNoWrite() {
  const fixture = mkStoreFixture('store-write-stale-revise-')
  const original = seedLocalOriginal(fixture, 'stale')
  fs.writeFileSync(path.join(fixture.localDir, 'index.jsonl'), '', 'utf8')
  const before = byteSnapshot(fixture.localDir)
  const r = runJsonSync(REVISE, [
    '--original', original.id,
    '--project', 'issue-546-fixture',
    '--summary', 'stale successor must not exist',
    '--body', 'stale successor must not exist',
    '--scope', 'inherit',
  ], fixture)
  const after = byteSnapshot(fixture.localDir)
  assert.notEqual(r.code, 0, 'missing original index row must fail as stale')
  assert.equal(r.json?.status, 'error', `missing-row stale JSON missing: ${r.stdout}`)
  assert.equal(r.json?.code, 'stale-original', `missing-row error must be stale-original: ${r.stdout}`)
  assert.match(r.json?.message || '', /index row status: missing/)
  assert.deepEqual(after, before, 'missing original index row caused a write')
  assert.equal(episodeStatus(fixture.localDir, original.id), 'active')
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'missing-row stale path left temporary litter')
  telemetry.missingOriginalIndexRow = {
    elapsedMs: r.elapsedMs,
    exitCode: r.code,
    unchanged: true,
  }
}

async function runS2aIntegrationTests() {
  console.log('# S2a real-process store/revise integration tests')
  await asyncTap('S2a: 16 concurrent stores preserve episode/index/tag/category/token parity with no temp litter', testConcurrentStoreParity)
  await asyncTap('S2a: store lock timeout is a byte-for-byte no-write', testStoreTimeoutNoWrite)
  await asyncTap('S2a: cross-store revise preserves source/destination derived-index parity', testCrossStoreReviseParity)
  await asyncTap('S2a: revise lock timeout is a byte-for-byte no-write', testReviseTimeoutNoWrite)
  await asyncTap('S2a: same-store lock inputs dedupe and revise preserves full parity', testSameStoreReviseParity)
  await asyncTap('S2a: missing original index row is stale and writes nothing', testMissingOriginalIndexRowNoWrite)
}

function rowById(storeDir, id) {
  return readIndexRows(storeDir).find(row => row.id === id) || null
}

function pinnedInEpisode(storeDir, id) {
  return /^pinned: true$/m.test(fs.readFileSync(path.join(storeDir, 'episodes', `${id}.md`), 'utf8'))
}

async function testS2bExternalHolderWriters() {
  const fixture = mkStoreFixture('store-write-s2b-holder-')
  const original = seedLocalOriginal(fixture, 's2b-holder')
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')

  await assertWaitsForExternalHolder(
    'feedback single-id', FEEDBACK,
    ['--id', original.id, '--useful'], fixture, lockFile,
  )

  const handoff = path.join(fixture.cwd, 's2b-handoff.md')
  fs.writeFileSync(handoff, `cited episode ${original.id}\n`)
  await assertWaitsForExternalHolder(
    'feedback scan-text', FEEDBACK,
    ['--scan-text', handoff, '--scope', 'local'], fixture, lockFile,
  )

  await assertWaitsForExternalHolder(
    'pin', PIN,
    ['--id', original.id], fixture, lockFile,
  )
  await assertWaitsForExternalHolder(
    'rebuild', REBUILD,
    ['--scope', 'local'], fixture, lockFile,
  )

  assert.equal(rowById(fixture.localDir, original.id)?.feedback, 2,
    'both feedback modes must retain their increments through rebuild')
  assert.equal(rowById(fixture.localDir, original.id)?.pinned, true,
    'pin index row must survive rebuild')
  assert.equal(pinnedInEpisode(fixture.localDir, original.id), true,
    'pin frontmatter must survive rebuild')
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'S2b holder tests left temporary litter')
  telemetry.s2bExternalHolders = {
    writers: ['feedback-id', 'feedback-scan-text', 'pin', 'rebuild'],
    feedback: 2,
    pinned: true,
    tmpLitter: 0,
  }
}

async function testFeedbackConcurrentParity() {
  const fixture = mkStoreFixture('store-write-feedback-parity-')
  const single = seedLocalOriginal(fixture, 'feedback-single')
  const scan = seedLocalOriginal(fixture, 'feedback-scan')
  const handoff = path.join(fixture.cwd, 'feedback-parity.md')
  fs.writeFileSync(handoff, `reference ${scan.id}\n`)

  const singleCompletions = []
  for (let i = 0; i < 12; i++) {
    singleCompletions.push(spawnJson(FEEDBACK, ['--id', single.id, '--useful'], fixture))
  }
  const singleResults = await Promise.all(singleCompletions)
  for (const result of singleResults) {
    assert.equal(result.code, 0, `single feedback failed: ${result.stdout} ${result.stderr}`)
    assert.deepEqual(result.json && Object.keys(result.json).sort(), ['feedback', 'id', 'scope', 'status'])
  }

  const scanCompletions = []
  for (let i = 0; i < 12; i++) {
    scanCompletions.push(spawnJson(FEEDBACK, ['--scan-text', handoff, '--scope', 'local'], fixture))
  }
  const scanResults = await Promise.all(scanCompletions)
  for (const result of scanResults) {
    assert.equal(result.code, 0, `scan feedback failed: ${result.stdout} ${result.stderr}`)
    assert.equal(result.json?.status, 'ok')
    assert.equal(result.json?.recorded, 1)
  }

  assert.equal(rowById(fixture.localDir, single.id)?.feedback, 10,
    'concurrent single-id feedback must serialize and clamp at +10')
  assert.equal(rowById(fixture.localDir, scan.id)?.feedback, 10,
    'concurrent scan-text feedback must serialize and clamp at +10')
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'feedback parity left temporary litter')
  telemetry.feedbackConcurrentParity = {
    singleWriters: singleCompletions.length,
    scanWriters: scanCompletions.length,
    singleFeedback: rowById(fixture.localDir, single.id)?.feedback,
    scanFeedback: rowById(fixture.localDir, scan.id)?.feedback,
    tmpLitter: 0,
  }
}

async function testPinAndRebuildConcurrentParity() {
  const fixture = mkStoreFixture('store-write-pin-rebuild-parity-')
  const first = seedLocalOriginal(fixture, 'pin-parity-one')
  const second = seedLocalOriginal(fixture, 'pin-parity-two')

  const pinCompletions = []
  for (let i = 0; i < 10; i++) {
    pinCompletions.push(spawnJson(PIN, ['--id', first.id], fixture))
  }
  const pinResults = await Promise.all(pinCompletions)
  for (const result of pinResults) {
    assert.equal(result.code, 0, `concurrent pin failed: ${result.stdout} ${result.stderr}`)
    assert.deepEqual(result.json && Object.keys(result.json).sort(), ['id', 'pinned', 'scope', 'status'])
  }
  assert.equal(pinnedInEpisode(fixture.localDir, first.id), true)
  assert.equal(rowById(fixture.localDir, first.id)?.pinned, true)

  const rebuildCompletions = []
  for (let i = 0; i < 8; i++) {
    rebuildCompletions.push(spawnJson(REBUILD, ['--scope', 'local'], fixture))
  }
  const rebuildResults = await Promise.all(rebuildCompletions)
  for (const result of rebuildResults) {
    assert.equal(result.code, 0, `concurrent rebuild failed: ${result.stdout} ${result.stderr}`)
    assert.equal(result.json?.status, 'ok')
  }

  const ids = [first.id, second.id]
  const rows = readIndexRows(fixture.localDir)
  assertIds(episodeIds(fixture.localDir), ids, 'pin/rebuild episode parity')
  assertIds(rows.map(row => row.id), ids, 'pin/rebuild index parity')
  assert.equal(rowById(fixture.localDir, first.id)?.pinned, true,
    'rebuild must carry pinned metadata from frontmatter')
  assert.equal(rowById(fixture.localDir, second.id)?.pinned, undefined)
  assertPosting(readJson(fixture.localDir, 'category-index.json'), 'decision', ids,
    'pin/rebuild category parity')
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'pin/rebuild parity left temporary litter')
  telemetry.pinRebuildConcurrentParity = {
    pinWriters: pinCompletions.length,
    rebuildWriters: rebuildCompletions.length,
    episodes: ids.length,
    indexRows: rows.length,
    tmpLitter: 0,
  }
}

async function testSearchWritebackRetainsConcurrentAppend() {
  const fixture = mkStoreFixture('store-write-search-race-')
  const original = seedLocalOriginal(fixture, 'search-race-original')
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')

  await withLiveHolder(lockFile, async ({ child }) => {
    const search = spawnJson(SEARCH, ['--query', 'original', '--scope', 'local'], fixture)
    const append = spawnJson(STORE, [
      '--project', 'issue-546-fixture', '--category', 'decision',
      '--tag', 'search-race-append', '--summary', 'search race append',
      '--body', 'append body searchracetoken', '--scope', 'local',
    ], fixture)
    await waitMs(300)
    assert.equal(search.child.exitCode, null,
      'search should still be waiting on the externally held store lock')
    assert.equal(append.child.exitCode, null,
      'append should still be waiting on the externally held store lock')
    releaseChild(child)
    const [searchResult, appendResult] = await Promise.all([search, append])
    assert.equal(searchResult.code, 0, `search failed: ${searchResult.stdout} ${searchResult.stderr}`)
    assert.equal(searchResult.json?.status, 'ok')
    assert.equal(appendResult.code, 0, `append failed: ${appendResult.stdout} ${appendResult.stderr}`)
    assert.equal(appendResult.json?.status, 'ok')
    const appendedId = appendResult.json.id
    const rows = readIndexRows(fixture.localDir)
    assertIds(rows.map(row => row.id), [original.id, appendedId],
      'search writeback must retain a concurrent append')
    assert.equal(rowById(fixture.localDir, original.id)?.access_count, 1,
      'search result must still receive access tracking')
    telemetry.searchWritebackRace = {
      originalId: original.id,
      appendedId,
      indexRows: rows.length,
      appendRetained: rows.some(row => row.id === appendedId),
    }
  })
}

async function testSearchWritebackSkipsOnlyContendedStore() {
  const fixture = mkStoreFixture('store-write-search-contended-')
  const local = seedLocalOriginal(fixture, 'contended-local')
  const global = runJsonSync(STORE, [
    '--project', 'issue-546-fixture', '--category', 'decision',
    '--tag', 'contended-global', '--summary', 'contended shared result',
    '--body', 'global body', '--scope', 'global',
  ], fixture)
  assert.equal(global.code, 0, `global seed failed: ${global.stdout} ${global.stderr}`)
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')

  await withLiveHolder(lockFile, async ({ childPid, child }) => {
    const result = await spawnJson(SEARCH, ['--query', 'contended', '--scope', 'all'], fixture)
    assert.equal(result.code, 0, `contended search failed: ${result.stdout} ${result.stderr}`)
    assert.equal(result.json?.status, 'ok')
    assert.equal(result.json?.count, 2, `search should still return both stores: ${result.stdout}`)
    assert.ok(result.elapsedMs >= 200, `search should spend the built-in bounded timeout on local: ${result.elapsedMs}ms`)
    assert.ok(result.elapsedMs < 1500, `search writeback must remain interactive: ${result.elapsedMs}ms`)
    assert.equal(rowById(fixture.localDir, local.id)?.access_count || 0, 0,
      'contended local store write must be skipped')
    assert.equal(rowById(fixture.globalDir, global.json.id)?.access_count, 1,
      'uncontended global store write must succeed')
    assert.ok(fs.existsSync(path.join(fixture.localDir, 'clerk-apply.lock')),
      `holder ${childPid} must remain owner until the test releases it`)
    telemetry.searchWritebackPerStore = {
      contendedScope: 'local',
      successfulScope: 'global',
      localAccess: rowById(fixture.localDir, local.id)?.access_count || 0,
      globalAccess: rowById(fixture.globalDir, global.json.id)?.access_count,
      searchExitCode: result.code,
      elapsedMs: result.elapsedMs,
    }
    releaseChild(child)
  })
}

async function runS2bIntegrationTests() {
  console.log('# S2b real-process feedback/pin/rebuild/relevance integration tests')
  await asyncTap('S2b: feedback, pin, and rebuild wait for deterministic external holders', testS2bExternalHolderWriters)
  await asyncTap('S2b: concurrent feedback modes preserve exact counter parity', testFeedbackConcurrentParity)
  await asyncTap('S2b: concurrent pin and rebuild preserve episode/index parity', testPinAndRebuildConcurrentParity)
  await asyncTap('S2b: search writeback retains an append serialized through the store lock', testSearchWritebackRetainsConcurrentAppend)
  await asyncTap('S2b: contended search store is skipped while another store writes back', testSearchWritebackSkipsOnlyContendedStore)
}

function waitForMarker(child, marker, timeoutMs) {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    let timer = null
    const finish = () => {
      if (done) return
      done = true
      if (timer !== null) clearTimeout(timer)
      resolve(buf)
    }
    child.stdout.on('data', (d) => {
      buf += d.toString()
      if (buf.includes(marker)) finish()
    })
    child.on('exit', finish)
    timer = setTimeout(finish, timeoutMs)
  })
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Deterministic external-holder assertion used by every S2b writer. The
// holder child owns release timing; a command that exits before the window
// proves it raced past the canonical lock rather than waiting for it.
async function assertWaitsForExternalHolder(name, script, args, fixture, lockFile, envExtra = {}) {
  await withLiveHolder(lockFile, async ({ child }) => {
    const completion = spawnJson(script, args, fixture, envExtra)
    const winner = await Promise.race([
      completion.then(() => 'exit'),
      waitMs(300).then(() => 'window'),
    ])
    assert.equal(winner, 'window', `${name} exited before external holder release`)
    releaseChild(child)
    const result = await completion
    assert.equal(result.code, 0, `${name} failed after lock release: stdout=${result.stdout} stderr=${result.stderr}`)
    assert.equal(result.json?.status, 'ok', `${name} returned invalid JSON: ${result.stdout}`)
  })
}

function storeDataSnapshot(storeDir) {
  return byteSnapshot(storeDir).filter(([name]) => !name.endsWith('clerk-apply.lock'))
}

async function assertTimeoutLeavesStoresUnchanged(name, script, args, fixture, lockFile, storeDirs) {
  await withLiveHolder(lockFile, async ({ childPid }) => {
    const before = storeDirs.map(storeDataSnapshot)
    const result = runJsonSync(script, args, fixture, {
      EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS: '200',
    })
    const after = storeDirs.map(storeDataSnapshot)
    assert.notEqual(result.code, 0, `${name} must fail while the external holder owns the lock`)
    assert.equal(result.json?.status, 'error', `${name} timeout envelope missing: ${result.stdout}`)
    const reportedCode = result.json?.code || result.json?.errors?.[0]?.code
    assert.equal(reportedCode, 'store-write-lock-timeout', `${name} timeout code missing: ${result.stdout}`)
    const heldBy = result.json?.heldBy ?? result.json?.errors?.[0]?.heldBy
    assert.equal(heldBy, childPid, `${name} timeout must report holder pid`)
    assert.deepEqual(after, before, `${name} timeout changed store data`)
    for (const dir of storeDirs) assert.deepEqual(tmpLitter(dir), [], `${name} timeout left temp litter in ${dir}`)
  })
}

async function assertLockFreeControl(name, script, args, fixture, lockFile, expectedCodes = [0]) {
  await withLiveHolder(lockFile, async () => {
    const before = storeDataSnapshot(path.dirname(lockFile))
    const completion = spawnJson(script, args, fixture, {
      EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS: '5000',
    })
    const winner = await Promise.race([
      completion.then(() => 'exit'),
      waitMs(350).then(() => 'window'),
    ])
    assert.equal(winner, 'exit', `${name} waited on a store lock despite being non-writing`)
    const result = await completion
    assert.ok(expectedCodes.includes(result.code), `${name} exit=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`)
    assert.ok(result.json && typeof result.json.status === 'string', `${name} must preserve a JSON envelope`)
    assert.deepEqual(storeDataSnapshot(path.dirname(lockFile)), before, `${name} changed store data`)
  })
}

function makePatternsDir(fixture, patternId, token = 'seedfixturetoken') {
  const dir = path.join(fixture.root, `patterns-${patternId}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify({
    patterns: [{ pattern_id: patternId, file: `${patternId}.md`, name: `Pattern ${patternId}` }],
  }))
  fs.writeFileSync(path.join(dir, `${patternId}.md`), [
    '---',
    `pattern_id: ${patternId}`,
    `name: Pattern ${patternId}`,
    'category: decision',
    `tags: [${patternId}, behavioral-pattern]`,
    '---',
    '',
    `Pattern body ${token}.`,
    '',
  ].join('\n'))
  return dir
}

function seedWorkflowEvent(fixture, task, event, tag) {
  const body = `workflow fixture\n\n\`\`\`json\n${JSON.stringify({ event, task })}\n\`\`\``
  const result = runJsonSync(STORE, [
    '--project', 'issue-546-fixture',
    '--category', 'workflow.lifecycle',
    '--tag', tag,
    '--summary', `${event} ${task}`,
    '--body', body,
    '--scope', 'local',
  ], fixture)
  assert.equal(result.code, 0, `workflow seed failed: ${result.stdout} ${result.stderr}`)
  return result.json.id
}

function makeReviewFixture(prefix, task = 'S3A-REVIEW') {
  const fixture = mkStoreFixture(prefix)
  const plan = path.join(fixture.cwd, 'plan.md')
  const tests = path.join(fixture.cwd, 'tests.md')
  fs.writeFileSync(plan, 'approved plan\n')
  fs.writeFileSync(tests, 'passing tests\n')
  const approval = seedWorkflowEvent(fixture, task, 'plan-approved', 'review-approval')
  const pre = seedWorkflowEvent(fixture, task, 'pre-checkpoint', 'review-pre')
  const post = seedWorkflowEvent(fixture, task, 'post-checkpoint', 'review-post')
  const args = [
    '--task', task,
    '--plan-ref', `file:${plan}`,
    '--approval-ref', `episode:${approval}`,
    '--pre-checkpoint-ref', `episode:${pre}`,
    '--post-checkpoint-ref', `episode:${post}`,
    '--tests-ref', `file:${tests}`,
    '--code-review-ref', `episode:${post}`,
    '--no-new-bugs',
    '--head', 'abcdef1234567890',
    '--branch', 'fixture-branch',
    '--worktree', fixture.cwd,
    '--project', 'issue-546-fixture',
    '--scope', 'local',
  ]
  return { fixture, args }
}

function assertInvertedExcludes(storeDir, fileName, id, label) {
  const index = readJson(storeDir, fileName)
  for (const [key, ids] of Object.entries(index)) {
    if (Array.isArray(ids)) assert.equal(ids.includes(id), false, `${label}: ${fileName}[${key}] still contains ${id}`)
  }
}

// ---------------------------------------------------------------------------
// S3b helpers: restore fixture (fake em-backup repo) + consolidate fixture
// (already-seeded near-duplicate cluster) — zero-dep, isolated under mkTmp
// with explicit HOME so neither the real local store nor ~/.episodic-memory
// is touched.
// ---------------------------------------------------------------------------
function makeRestoreFixture(prefix) {
  const root = mkTmp(prefix)
  const backupDir = path.join(root, 'backup')
  fs.mkdirSync(backupDir, { recursive: true })
  // em-restore requires the backup to be a clean git repo.
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: backupDir })
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: backupDir })
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: backupDir })
  // HOME isolation — the spawn JSON env passes the root's home override.
  const env = { ...process.env, HOME: root }
  return { root, backupDir, env }
}

function makeRestoreEpisode(id, opts = {}) {
  const fm = {
    id,
    date: opts.date || '2026-05-01',
    time: opts.time || '"10:00"',
    project: opts.project || 'issue-546-fixture',
    category: opts.category || 'decision',
    status: 'active',
    tags: opts.tags || [],
    summary: opts.summary || `summary for ${id}`,
  }
  const fmLines = ['---']
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) fmLines.push(`${k}: [${v.join(', ')}]`)
    else fmLines.push(`${k}: ${v}`)
  }
  fmLines.push('---')
  return fmLines.join('\n') + `\n\n# ${fm.summary}\n\nbody ${opts.token || 'restorefixturetoken'}${id}\n`
}

function seedRestoreBackup(fixture, label, episodes) {
  const epDir = path.join(fixture.backupDir, label, 'episodes')
  fs.mkdirSync(epDir, { recursive: true })
  for (const e of episodes) {
    fs.writeFileSync(path.join(epDir, `${e.id}.md`), e.content)
  }
  spawnSync('git', ['add', '-A'], { cwd: fixture.backupDir })
  spawnSync('git', ['commit', '-q', '-m', 'test', '--allow-empty'], { cwd: fixture.backupDir })
}

function makeConsolidateFixture(prefix, nearDupes) {
  const fixture = mkStoreFixture(prefix)
  const ids = []
  for (const e of nearDupes) {
    const r = runJsonSync(STORE, [
      '--project', e.project || 'issue-546-fixture',
      '--category', e.category || 'lesson',
      '--summary', e.summary,
      '--body', e.body,
      '--tag', ...(e.tags || ['issue-546-fixture']),
      '--scope', 'local',
    ], fixture)
    assert.equal(r.code, 0, `consolidate seed failed: ${r.stdout} ${r.stderr}`)
    ids.push(r.json.id)
  }
  return { fixture, ids }
}

async function testPruneLockingParityAndControls() {
  const fixture = mkStoreFixture('store-write-prune-holder-')
  const seeded = seedLocalOriginal(fixture, 'prune-holder')
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')
  await assertWaitsForExternalHolder(
    'prune', PRUNE, ['--scope', 'local', '--threshold', '2'], fixture, lockFile,
  )
  assert.equal(fs.existsSync(path.join(fixture.localDir, 'episodes', `${seeded.id}.md`)), false)
  assert.equal(fs.existsSync(path.join(fixture.localDir, 'archived', `${seeded.id}.md`)), true)
  assert.equal(readIndexRows(fixture.localDir).some(row => row.id === seeded.id), false)
  const archivedRows = fs.readFileSync(path.join(fixture.localDir, 'archived-index.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(archivedRows.some(row => row.id === seeded.id), true)
  for (const name of ['tags.json', 'category-index.json', 'tokens.json']) {
    assertInvertedExcludes(fixture.localDir, name, seeded.id, 'prune parity')
  }
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'prune left temporary litter')

  const timeoutFixture = mkStoreFixture('store-write-prune-timeout-')
  seedLocalOriginal(timeoutFixture, 'prune-timeout')
  const timeoutLock = path.join(timeoutFixture.localDir, 'clerk-apply.lock')
  await assertTimeoutLeavesStoresUnchanged(
    'prune', PRUNE, ['--scope', 'local', '--threshold', '2'], timeoutFixture,
    timeoutLock, [timeoutFixture.localDir],
  )
  await assertLockFreeControl('prune help', PRUNE, ['--help'], timeoutFixture, timeoutLock)
  await assertLockFreeControl('prune dry-run', PRUNE, ['--scope', 'local', '--threshold', '2', '--dry-run'], timeoutFixture, timeoutLock)
  await assertLockFreeControl('prune check', PRUNE, ['--scope', 'local', '--threshold', '2', '--check'], timeoutFixture, timeoutLock, [1])
  await assertLockFreeControl('prune no-op', PRUNE, ['--scope', 'local', '--threshold', '0'], timeoutFixture, timeoutLock)
  telemetry.s3Prune = { blocked: true, timeoutNoWrite: true, archived: 1, parity: true, tmpLitter: 0, lockFreeControls: 4 }
}

async function testMoveAllLocksParityAndControls() {
  const fixture = mkStoreFixture('store-write-move-holder-')
  const seeded = seedLocalOriginal(fixture, 'move-holder')
  fs.mkdirSync(fixture.globalDir, { recursive: true })
  const destinationLock = path.join(fixture.globalDir, 'clerk-apply.lock')

  await withLiveHolder(destinationLock, async ({ child }) => {
    const before = [storeDataSnapshot(fixture.localDir), storeDataSnapshot(fixture.globalDir)]
    const completion = spawnJson(MOVE, ['--id', seeded.id, '--to', 'global', '--no-audit'], fixture)
    const winner = await Promise.race([completion.then(() => 'exit'), waitMs(350).then(() => 'window')])
    assert.equal(winner, 'window', 'move exited before destination holder released')
    assert.deepEqual(
      [storeDataSnapshot(fixture.localDir), storeDataSnapshot(fixture.globalDir)], before,
      'move wrote source or destination data before every lock was acquired',
    )
    releaseChild(child)
    const result = await completion
    assert.equal(result.code, 0, `move failed after release: ${result.stdout} ${result.stderr}`)
    assert.equal(result.json?.status, 'ok')
  })

  assert.equal(fs.existsSync(path.join(fixture.localDir, 'episodes', `${seeded.id}.md`)), false)
  assert.equal(fs.existsSync(path.join(fixture.globalDir, 'episodes', `${seeded.id}.md`)), true)
  assert.equal(readIndexRows(fixture.localDir).some(row => row.id === seeded.id), false)
  assert.equal(readIndexRows(fixture.globalDir).some(row => row.id === seeded.id), true)
  for (const name of ['tags.json', 'category-index.json', 'tokens.json']) {
    assertInvertedExcludes(fixture.localDir, name, seeded.id, 'move source parity')
    const destination = readJson(fixture.globalDir, name)
    assert.ok(Object.values(destination).some(ids => Array.isArray(ids) && ids.includes(seeded.id)),
      `move destination ${name} does not contain ${seeded.id}`)
  }
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'move source temp litter')
  assert.deepEqual(tmpLitter(fixture.globalDir), [], 'move destination temp litter')

  const timeoutFixture = mkStoreFixture('store-write-move-timeout-')
  const timeoutSeed = seedLocalOriginal(timeoutFixture, 'move-timeout')
  fs.mkdirSync(timeoutFixture.globalDir, { recursive: true })
  const timeoutLock = path.join(timeoutFixture.globalDir, 'clerk-apply.lock')
  await assertTimeoutLeavesStoresUnchanged(
    'move', MOVE, ['--id', timeoutSeed.id, '--to', 'global', '--no-audit'], timeoutFixture,
    timeoutLock, [timeoutFixture.localDir, timeoutFixture.globalDir],
  )

  const globalSeed = runJsonSync(STORE, storeArgs('move-noop', 'global'), timeoutFixture)
  assert.equal(globalSeed.code, 0, `move no-op seed failed: ${globalSeed.stdout}`)
  await assertLockFreeControl('move help', MOVE, ['--help'], timeoutFixture, timeoutLock)
  await assertLockFreeControl('move invalid', MOVE, ['--id', timeoutSeed.id, '--to', 'nowhere'], timeoutFixture, timeoutLock, [2])
  await assertLockFreeControl('move dry-run', MOVE, ['--id', timeoutSeed.id, '--to', 'global', '--dry-run'], timeoutFixture, timeoutLock)
  await assertLockFreeControl('move no-op', MOVE, ['--id', globalSeed.json.id, '--to', 'global'], timeoutFixture, timeoutLock)
  telemetry.s3Move = { blocked: true, allLocksBeforeWrite: true, timeoutNoWrite: true, parity: true, tmpLitter: 0, lockFreeControls: 4 }
}

async function testSeedLockingParityAndControls() {
  const fixture = mkStoreFixture('store-write-seed-holder-')
  const patterns = makePatternsDir(fixture, 'bp-546-seed', 'seedfixturetoken')
  fs.mkdirSync(fixture.globalDir, { recursive: true })
  const lockFile = path.join(fixture.globalDir, 'clerk-apply.lock')
  await assertWaitsForExternalHolder('seed-patterns', SEED_PATTERNS, ['--dir', patterns], fixture, lockFile)
  const rows = readIndexRows(fixture.globalDir)
  assert.equal(rows.length, 1)
  const id = rows[0].id
  assertIds(episodeIds(fixture.globalDir), [id], 'seed episode/index parity')
  assertPosting(readJson(fixture.globalDir, 'tags.json'), 'bp-546-seed', [id], 'seed tag parity')
  assertPosting(readJson(fixture.globalDir, 'category-index.json'), 'decision', [id], 'seed category parity')
  assertPosting(readJson(fixture.globalDir, 'tokens.json'), 'seedfixturetoken', [id], 'seed token parity')
  assert.deepEqual(tmpLitter(fixture.globalDir), [], 'seed left temporary litter')

  const timeoutFixture = mkStoreFixture('store-write-seed-timeout-')
  const timeoutPatterns = makePatternsDir(timeoutFixture, 'bp-546-timeout', 'seedtimeouttoken')
  fs.mkdirSync(timeoutFixture.globalDir, { recursive: true })
  const timeoutLock = path.join(timeoutFixture.globalDir, 'clerk-apply.lock')
  await assertTimeoutLeavesStoresUnchanged(
    'seed-patterns', SEED_PATTERNS, ['--dir', timeoutPatterns], timeoutFixture,
    timeoutLock, [timeoutFixture.globalDir],
  )
  await assertLockFreeControl('seed help', SEED_PATTERNS, ['--help'], fixture, lockFile)
  await assertLockFreeControl('seed invalid', SEED_PATTERNS, ['--dir', path.join(fixture.root, 'missing-patterns')], fixture, lockFile, [1])
  const dryPatterns = makePatternsDir(fixture, 'bp-546-dry', 'seeddrytoken')
  await assertLockFreeControl('seed dry-run', SEED_PATTERNS, ['--dir', dryPatterns, '--dry-run'], fixture, lockFile)
  await assertLockFreeControl('seed no-op', SEED_PATTERNS, ['--dir', patterns], fixture, lockFile)
  telemetry.s3Seed = { blocked: true, timeoutNoWrite: true, episodes: 1, parity: true, tmpLitter: 0, lockFreeControls: 4 }
}

async function testReviewRequestLockingParityAndControls() {
  const { fixture, args } = makeReviewFixture('store-write-review-holder-')
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')
  await assertWaitsForExternalHolder('review-request', REVIEW_REQUEST, args, fixture, lockFile)
  const reviewRows = readIndexRows(fixture.localDir).filter(row => row.category === 'workflow.lifecycle' && row.tags?.includes('review-request'))
  assert.equal(reviewRows.length, 1, 'exactly one review-request row expected')
  const id = reviewRows[0].id
  assert.equal(fs.existsSync(path.join(fixture.localDir, 'episodes', `${id}.md`)), true)
  assertPosting(readJson(fixture.localDir, 'tags.json'), 'review-request', [id], 'review tag parity')
  const categories = readJson(fixture.localDir, 'category-index.json')
  assert.ok(categories['workflow.lifecycle'].includes(id), 'review category parity')
  const tokens = readJson(fixture.localDir, 'tokens.json')
  assert.ok(Object.values(tokens).some(ids => Array.isArray(ids) && ids.includes(id)), 'review token parity')
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'review-request left temporary litter')

  const timeout = makeReviewFixture('store-write-review-timeout-', 'S3A-TIMEOUT')
  const timeoutLock = path.join(timeout.fixture.localDir, 'clerk-apply.lock')
  await assertTimeoutLeavesStoresUnchanged(
    'review-request', REVIEW_REQUEST, timeout.args, timeout.fixture,
    timeoutLock, [timeout.fixture.localDir],
  )
  await assertLockFreeControl('review help', REVIEW_REQUEST, ['--help'], timeout.fixture, timeoutLock)
  await assertLockFreeControl('review invalid', REVIEW_REQUEST, ['--task', 'missing-rest'], timeout.fixture, timeoutLock, [2])
  await assertLockFreeControl('review dry-run', REVIEW_REQUEST, [...timeout.args, '--dry-run'], timeout.fixture, timeoutLock)
  telemetry.s3ReviewRequest = { blocked: true, timeoutNoWrite: true, episodes: 1, parity: true, tmpLitter: 0, lockFreeControls: 3 }
}

async function runS3aIntegrationTests() {
  console.log('# S3a real-process prune/move/seed/review-request integration tests')
  await asyncTap('S3a: prune blocks, times out without writes, preserves parity, and keeps controls lock-free', testPruneLockingParityAndControls)
  await asyncTap('S3a: move acquires all locks before writes and preserves two-store parity', testMoveAllLocksParityAndControls)
  await asyncTap('S3a: seed-patterns serializes its batch with full derived-index parity', testSeedLockingParityAndControls)
  await asyncTap('S3a: review-request serializes collision check and full store persistence', testReviewRequestLockingParityAndControls)
}

// ---------------------------------------------------------------------------
// Slice 546-S3b: restore + legacy non-clerk consolidate coverage.
// ---------------------------------------------------------------------------
async function testRestoreAllLocksBeforeWrite() {
  // Two target stores (local + global). An external holder owns the
  // destination store's clerk-apply.lock. Restore must NOT write to the
  // SOURCE store either, even though it is unheld, until BOTH locks are
  // acquired. The fixture isolates HOME so the real ~/.episodic-memory is
  // untouched.
  const restoreFx = makeRestoreFixture('store-write-restore-alllocks-')
  const idA = 'restore-al-1'
  const idB = 'restore-al-2'
  seedRestoreBackup(restoreFx, 'proj-a', [{ id: idA, content: makeRestoreEpisode(idA, { tags: ['alpha'], token: 'restorealtokena' }) }])
  seedRestoreBackup(restoreFx, 'proj-b', [{ id: idB, content: makeRestoreEpisode(idB, { tags: ['bravo'], token: 'restorealtokenb' }) }])
  // Create the source-map targets. These are STANDALONE non-cwd stores
  // (the restore honors --source-map, not scope); we drive them through
  // absolute paths and HOME override so nothing in the real env writes.
  const cwd = path.join(restoreFx.root, 'cwd')
  fs.mkdirSync(cwd, { recursive: true })
  const targetA = path.join(restoreFx.root, 'store-a')
  const targetB = path.join(restoreFx.root, 'store-b')
  fs.mkdirSync(targetA, { recursive: true })
  fs.mkdirSync(targetB, { recursive: true })
  const lockB = path.join(targetB, 'clerk-apply.lock')

  const args = [
    '--from', restoreFx.backupDir,
    '--source-map', `proj-a=${targetA}`,
    '--source-map', `proj-b=${targetB}`,
    '--apply',
    '--rebuild-index',
  ]

  await withLiveHolder(lockB, async ({ child }) => {
    const before = [storeDataSnapshot(targetA), storeDataSnapshot(targetB)]
    const completion = spawnJson(RESTORE, args, { cwd, env: restoreFx.env })
    const winner = await Promise.race([completion.then(() => 'exit'), waitMs(450).then(() => 'window')])
    assert.equal(winner, 'window',
      'restore exited before BOTH target locks were acquired (must wait on the held target)')
    // CRITICAL: targetA is UNheld but its bytes must not have changed
    // either, because restore acquires ALL locks before ANY write.
    assert.deepEqual([storeDataSnapshot(targetA), storeDataSnapshot(targetB)], before,
      'restore wrote a target before every lock was acquired')
    releaseChild(child)
    const result = await completion
    assert.equal(result.code, 0, `restore failed after release: stdout=${result.stdout}; stderr=${result.stderr}`)
    assert.equal(result.json?.status, 'ok', `restore envelope status: ${result.stdout}`)
  })

  // After release: both targets have the episode + index + tags + category
  // parity preserved.
  assert.equal(fs.existsSync(path.join(targetA, 'episodes', `${idA}.md`)), true, 'target A episode missing')
  assert.equal(fs.existsSync(path.join(targetB, 'episodes', `${idB}.md`)), true, 'target B episode missing')
  assertIds(episodeIds(targetA), [idA], 'target A episode parity')
  assertIds(episodeIds(targetB), [idB], 'target B episode parity')
  assertIds(readIndexRows(targetA).map(r => r.id), [idA], 'target A index parity')
  assertIds(readIndexRows(targetB).map(r => r.id), [idB], 'target B index parity')
  assertPosting(readJson(targetA, 'tags.json'), 'alpha', [idA], 'target A tag parity')
  assertPosting(readJson(targetB, 'tags.json'), 'bravo', [idB], 'target B tag parity')
  assertPosting(readJson(targetA, 'category-index.json'), 'decision', [idA], 'target A category parity')
  assertPosting(readJson(targetB, 'category-index.json'), 'decision', [idB], 'target B category parity')
  // tokens.json is rebuilt by em-rebuild-index, not by em-restore itself.
  assert.equal(fs.existsSync(path.join(targetA, 'tokens.json')), false, 'restore does not write tokens.json')
  assert.equal(fs.existsSync(path.join(targetB, 'tokens.json')), false, 'restore does not write tokens.json')
  assert.deepEqual(tmpLitter(targetA), [], 'restore left temp litter in target A')
  assert.deepEqual(tmpLitter(targetB), [], 'restore left temp litter in target B')
  telemetry.s3bRestoreAllLocks = { sources: 2, blocked: true, allLocksBeforeWrite: true, tmpLitter: 0 }
}

async function testRestoreTimeoutNoWrite() {
  const restoreFx = makeRestoreFixture('store-write-restore-timeout-')
  const id = 'restore-to-1'
  seedRestoreBackup(restoreFx, 'proj', [{ id, content: makeRestoreEpisode(id, { tags: ['tm'], token: 'restoretimetoken' }) }])
  const cwd = path.join(restoreFx.root, 'cwd')
  fs.mkdirSync(cwd, { recursive: true })
  const target = path.join(restoreFx.root, 'store')
  fs.mkdirSync(target, { recursive: true })
  const lockFile = path.join(target, 'clerk-apply.lock')

  await assertTimeoutLeavesStoresUnchanged(
    'restore', RESTORE, [
      '--from', restoreFx.backupDir,
      '--source-map', `proj=${target}`,
      '--apply', '--rebuild-index',
    ], { cwd, env: { ...restoreFx.env, EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS: '200' } },
    lockFile, [target],
  )
  assert.equal(fs.existsSync(path.join(target, 'episodes', `${id}.md`)), false, 'restore wrote episode after timeout')
  assert.equal(fs.existsSync(path.join(target, 'index.jsonl')), false, 'restore wrote index.jsonl after timeout')
  assert.deepEqual(tmpLitter(target), [], 'restore timeout left temp litter')
  telemetry.s3bRestoreTimeout = { blocked: true, timeoutNoWrite: true, tmpLitter: 0 }
}

async function testRestoreParityAndLockFreeControls() {
  // Single-target parity: restore writes episode + index + tags + category,
  // no temp litter, no leftover staging dir, no leftover lockfile.
  const restoreFx = makeRestoreFixture('store-write-restore-parity-')
  const id1 = 'restore-par-1'
  const id2 = 'restore-par-2'
  seedRestoreBackup(restoreFx, 'proj', [
    { id: id1, content: makeRestoreEpisode(id1, { tags: ['parity-1'], token: 'restorepartoken1', date: '2026-04-01' }) },
    { id: id2, content: makeRestoreEpisode(id2, { tags: ['parity-2'], token: 'restorepartoken2', date: '2026-04-15' }) },
  ])
  const cwd = path.join(restoreFx.root, 'cwd')
  fs.mkdirSync(cwd, { recursive: true })
  const target = path.join(restoreFx.root, 'store')
  fs.mkdirSync(target, { recursive: true })
  const lockFile = path.join(target, 'clerk-apply.lock')

  const applyArgs = [
    '--from', restoreFx.backupDir,
    '--source-map', `proj=${target}`,
    '--apply', '--rebuild-index',
  ]
  const r = runJsonSync(RESTORE, applyArgs, { cwd, env: restoreFx.env })
  assert.equal(r.code, 0, `restore parity apply failed: ${r.stdout} ${r.stderr}`)
  assert.equal(r.json?.status, 'ok')
  assertIds(episodeIds(target), [id1, id2], 'restore parity episode ids')
  assertIds(readIndexRows(target).map(row => row.id), [id1, id2], 'restore parity index rows')
  const tags = readJson(target, 'tags.json')
  assertPosting(tags, 'parity-1', [id1], 'restore parity tag-1')
  assertPosting(tags, 'parity-2', [id2], 'restore parity tag-2')
  const categories = readJson(target, 'category-index.json')
  assertPosting(categories, 'decision', [id1, id2], 'restore parity category')
  // tokens.json is rebuilt by em-rebuild-index, not by em-restore itself.
  assert.equal(fs.existsSync(path.join(target, 'tokens.json')), false, 'restore does not write tokens.json')
  assert.deepEqual(tmpLitter(target), [], 'restore parity left temp litter')
  // Staging dir must be cleaned up (preserved by mkdtempSync + try/finally
  // regardless of fixture-write success).
  const stagingLeftover = fs.readdirSync(target)
    .filter(n => n.startsWith('.em-restore-staging-') && !fs.lstatSync(path.join(target, n)).isSymbolicLink())
  assert.equal(stagingLeftover.length, 0, `staging leftover: ${stagingLeftover.join(',')}`)
  assert.equal(fs.existsSync(lockFile), false, 'restore parity released the store lock')

  // Lock-free controls: help, dry-run, invalid input must NOT wait on the
  // store lock and must NOT change the target.
  await assertLockFreeControl('restore help', RESTORE, ['--help'], { cwd, env: restoreFx.env }, lockFile)
  await assertLockFreeControl('restore dry-run', RESTORE, [
    '--from', restoreFx.backupDir, '--source-map', `proj=${target}`,
  ], { cwd, env: restoreFx.env }, lockFile)
  await assertLockFreeControl('restore invalid category', RESTORE, [
    '--from', restoreFx.backupDir, '--source-map', `proj=${target}`,
    '--category', 'BOGUS_CATEGORY', '--apply',
  ], { cwd, env: restoreFx.env }, lockFile, [1])
  await assertLockFreeControl('restore missing --from', RESTORE, [
    '--source-map', `proj=${target}`, '--apply',
  ], { cwd, env: restoreFx.env }, lockFile, [2])
  telemetry.s3bRestoreParity = {
    episodes: 2, indexRows: 2, parity: true, tmpLitter: 0, lockFreeControls: 4,
  }
}

async function testConsolidateBlocksAndTimeoutNoWrite() {
  // External holder blocks the legacy non-clerk --apply path until release.
  // Timeout path: a second external holder that never releases MUST
  // surface a store-write-lock-timeout envelope and leave the store byte-
  // identical. Single-fixture: the helper provides a fresh fixture per
  // test, both below.
  const fixture = makeConsolidateFixture('store-write-consolidate-holder-', [
    { summary: 'Atomic rename prevents torn index reads', body: 'We hit a torn read; the fix is temp file plus atomic rename for every index write.', tags: ['issue-546-fixture', 'storage'] },
    { summary: 'Use temp file plus rename for index writes', body: 'Torn index reads again — atomic rename via temp file is mandatory for index writes.', tags: ['issue-546-fixture', 'index'] },
  ])
  const lockFile = path.join(fixture.fixture.localDir, 'clerk-apply.lock')

  // 1. Blocking path: holder owns the lock; consolidate waits; release →
  // apply succeeds and produces a digest.
  await withLiveHolder(lockFile, async ({ child }) => {
    const completion = spawnJson(CONSOLIDATE, [
      '--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm',
    ], fixture.fixture)
    const winner = await Promise.race([completion.then(() => 'exit'), waitMs(450).then(() => 'window')])
    assert.equal(winner, 'window', 'consolidate exited before lock release')
    releaseChild(child)
    const result = await completion
    assert.equal(result.code, 0, `consolidate failed after release: ${result.stdout} ${result.stderr}`)
    assert.equal(result.json?.status, 'ok', `consolidate envelope: ${result.stdout}`)
    assert.equal(result.json?.applied, 1, `expected exactly one applied cluster; got ${result.stdout}`)
    assert.equal(typeof result.json?.clusters?.[0]?.digest_id, 'string',
      `digest_id missing: ${result.stdout}`)
    const digestId = result.json.clusters[0].digest_id
    assert.ok(fs.existsSync(path.join(fixture.fixture.localDir, 'episodes', `${digestId}.md`)),
      'digest episode file missing after consolidate apply')
    assertIds(readIndexRows(fixture.fixture.localDir).map(r => r.id), [...fixture.ids, digestId].sort(),
      'consolidate apply parity: index.jsonl contains every member (superseded) plus the digest')
    for (const mid of fixture.ids) {
      const row = readIndexRows(fixture.fixture.localDir).find(r => r.id === mid)
      assert.equal(row?.status, 'superseded',
        `member ${mid} not marked superseded; rows=${JSON.stringify(readIndexRows(fixture.fixture.localDir))}`)
    }
    assert.deepEqual(tmpLitter(fixture.fixture.localDir), [],
      'consolidate apply left temp litter in the store')
    assert.equal(fs.existsSync(lockFile), false,
      'consolidate apply released the store lock')
  })

  // 2. Timeout path: a separate fixture + an external holder that does NOT
  // release before consolidate's deadline. Verify byte-identical snapshot.
  const timeoutFx = makeConsolidateFixture('store-write-consolidate-timeout-', [
    { summary: 'Timeout body lesson alpha', body: 'Timeout alpha duplicate body for the timeout test case.', tags: ['issue-546-fixture'] },
    { summary: 'Timeout body lesson beta', body: 'Timeout alpha duplicate body for the timeout test case.', tags: ['issue-546-fixture'] },
  ])
  const timeoutLock = path.join(timeoutFx.fixture.localDir, 'clerk-apply.lock')
  await assertTimeoutLeavesStoresUnchanged(
    'consolidate legacy', CONSOLIDATE, [
      '--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm',
    ], { ...timeoutFx.fixture, env: { ...timeoutFx.fixture.env, EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS: '200' } },
    timeoutLock, [timeoutFx.fixture.localDir],
  )
  assert.equal(fs.existsSync(path.join(timeoutFx.fixture.localDir, 'index.jsonl')), true,
    'timeout fixture still has its seeded index.jsonl (no apply write)')
  assert.equal(readIndexRows(timeoutFx.fixture.localDir).length, 2,
    'timeout fixture still has its 2 seeded rows (no apply write)')
  assert.deepEqual(tmpLitter(timeoutFx.fixture.localDir), [],
    'consolidate timeout left temp litter')
  telemetry.s3bConsolidate = {
    blocked: true,
    timeoutNoWrite: true,
    applied: 1,
    parity: true,
    tmpLitter: 0,
  }
}

async function testConsolidateLockFreeControls() {
  // Help, dry-run, --scope validation, and the >5-cluster confirm gate
  // must NOT acquire the store lock. Even with a live holder holding
  // <DATA_DIR>/clerk-apply.lock, these paths exit promptly without
  // modifying the store.
  const fixture = mkStoreFixture('store-write-consolidate-controls-')
  // Holder needs the parent dir to exist before O_CREAT can succeed.
  fs.mkdirSync(fixture.localDir, { recursive: true })
  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')
  await assertLockFreeControl('consolidate help', CONSOLIDATE, ['--help'], fixture, lockFile)
  await assertLockFreeControl('consolidate dry-run', CONSOLIDATE, ['--scope', 'local', '--min-sim', '0.3'], fixture, lockFile)
  await assertLockFreeControl('consolidate invalid scope', CONSOLIDATE, ['--scope', 'nope'], fixture, lockFile, [2])
  await assertLockFreeControl('consolidate invalid min-sim', CONSOLIDATE, ['--min-sim', '0'], fixture, lockFile, [2])
  // The >5 cluster confirm gate runs BEFORE the lock; with an empty store
  // there are no clusters so the gate trivially exits 0 (dry-run-by-default
  // branch). Verify the gate is lock-free in isolation too.
  await assertLockFreeControl('consolidate apply no-clusters', CONSOLIDATE, ['--scope', 'local', '--apply', '--confirm'], fixture, lockFile)
  telemetry.s3bConsolidateControls = { lockFreeControls: 5 }
}

async function runS3bIntegrationTests() {
  console.log('# S3b real-process restore + legacy consolidate integration tests')
  await asyncTap('S3b: restore acquires every target lock before any write (two-target parity)', testRestoreAllLocksBeforeWrite)
  await asyncTap('S3b: restore lock timeout is a byte-for-byte no-write across the target', testRestoreTimeoutNoWrite)
  await asyncTap('S3b: restore parity + lock-free controls preserve all self-tests', testRestoreParityAndLockFreeControls)
  await asyncTap('S3b: consolidate legacy --apply blocks, applies under lock, and times out without writes', testConsolidateBlocksAndTimeoutNoWrite)
  await asyncTap('S3b: consolidate help/dry-run/invalid inputs are lock-free controls', testConsolidateLockFreeControls)
}

// ---------------------------------------------------------------------------
// Slice 546-S3c: ID-collision retry (em-store) + legacy consolidate fresh-
// reread (em-consolidate). Both tests are isolated, deterministic, and do
// NOT add any production hook.
// ---------------------------------------------------------------------------

// Build a CommonJS preload that:
//   (a) fixes Date.now and the no-arg constructor to a deterministic instant
//   (b) sequences crypto.randomBytes(2) (the only size the ID loop uses);
//       size-8 calls (atomicReplaceFileSync uniqueStoreTmpPath) fall through
//       to the original function so the temp-name randomness is unaffected
//   (c) calls module.syncBuiltinESMExports() so an ESM `import crypto from
//       'crypto'` sees the patched randomBytes (ESM caches the namespace
//       snapshot at first load; syncBuiltinESMExports pushes the CJS
//       mutation into the ESM namespace)
// No production hook: the preload lives only inside the test fixture's
// mkTmp directory and is removed by main()'s tmpRoots sweep.
function writeIdCollisionPreload(fixtureRoot, suffixSequence, fixedIso) {
  const preloadPath = path.join(fixtureRoot, 'id-collision-preload.cjs')
  const seqLiteral = JSON.stringify(suffixSequence)
  fs.writeFileSync(preloadPath, `
    const crypto = require('crypto');
    const moduleObj = require('module');
    const OrigRandomBytes = crypto.randomBytes;
    const sequence = ${seqLiteral}.map(s => Buffer.from(s, 'hex'));
    let idx = 0;
    crypto.randomBytes = function patched(n) {
      if (n === 2 && idx < sequence.length) {
        const out = sequence[idx++];
        return Buffer.from(out);
      }
      return OrigRandomBytes.call(crypto, n);
    };
    moduleObj.syncBuiltinESMExports();
    const FIXED_ISO = ${JSON.stringify(fixedIso)};
    const FIXED_TS = new Date(FIXED_ISO).getTime();
    const OrigDate = Date;
    class FixedDate extends OrigDate {
      constructor(...args) {
        if (args.length === 0) {
          super(FIXED_TS);
        } else {
          super(...args);
        }
      }
      static now() { return FIXED_TS; }
      static parse(s) { return OrigDate.parse(s); }
      static UTC(...args) { return OrigDate.UTC(...args); }
    }
    globalThis.Date = FixedDate;
  `)
  return preloadPath
}

async function testStoreIdCollisionRetry() {
  // Pre-seed the store with an episode whose id matches the FIRST candidate
  // the loader will generate. The preload pins Date and sequences
  // crypto.randomBytes(2) so the first candidate collides with the seed
  // and the second candidate is fresh. The test proves the loader retries
  // inside the lock, the second id is used, the pre-seeded file bytes are
  // untouched, and the resulting index.jsonl has unique ids.
  const fixture = mkStoreFixture('store-write-id-collision-')
  const fixedIso = '2026-07-15T12:00:00.000Z'
  const ts = '20260715-120000'
  const slug = 'collision-retry-fixture'
  const collidingId = `${ts}-${slug}-aaaa`
  const retryId = `${ts}-${slug}-bbbb`

  // Pre-seed the colliding episode (file + index row).
  const episodesDir = path.join(fixture.localDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const collidingFile = path.join(episodesDir, `${collidingId}.md`)
  const collidingContent = [
    '---',
    `id: ${collidingId}`,
    'date: 2026-07-15',
    'time: "12:00"',
    'project: issue-546-fixture',
    'category: decision',
    'status: active',
    'tags: [collision-collider]',
    'summary: original collider',
    '---',
    '',
    '# original collider',
    '',
    'original body collisionsentinel\n',
  ].join('\n')
  fs.writeFileSync(collidingFile, collidingContent)
  fs.writeFileSync(path.join(fixture.localDir, 'index.jsonl'),
    JSON.stringify({ id: collidingId, date: '2026-07-15', time: '12:00', project: 'issue-546-fixture', category: 'decision', status: 'active', tags: ['collision-collider'], summary: 'original collider' }) + '\n',
    'utf8',
  )
  const originalBytes = fs.readFileSync(collidingFile)

  // Sequence: first randomBytes(2) call returns 'aaaa' (collision), second
  // returns 'bbbb' (fresh). Any subsequent size-2 calls fall through to
  // the original function but the retry loop needs at most 2 attempts.
  const preloadPath = writeIdCollisionPreload(fixture.root, ['aaaa', 'bbbb'], fixedIso)

  // Spawn em-store with the preload. --require must come before the script
  // path; we use spawnSync directly so the flag order is preserved.
  const started = Date.now()
  const r = spawnSync(process.execPath, [
    '--require', preloadPath,
    STORE,
    '--project', 'issue-546-fixture',
    '--category', 'decision',
    '--summary', 'collision retry fixture',
    '--body', 'retry body collisionsuccesstoken',
    '--scope', 'local',
  ], {
    cwd: fixture.cwd,
    env: { ...fixture.env },
    encoding: 'utf8',
  })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim()) } catch { /* asserted below */ }
  assert.equal(r.status, 0, `em-store failed: stdout=${r.stdout} stderr=${r.stderr}`)
  assert.equal(json && json.status, 'ok', `em-store returned invalid JSON: ${r.stdout}`)
  assert.equal(json.id, retryId, `expected retry id ${retryId}, got ${json.id} (stdout=${r.stdout})`)

  // Old bytes survive — the pre-seeded file is byte-for-byte identical.
  const originalAfter = fs.readFileSync(collidingFile)
  assert.equal(Buffer.compare(originalBytes, originalAfter), 0,
    'pre-seeded collider bytes must survive the retry path')

  // Index IDs are unique and both present.
  const rows = readIndexRows(fixture.localDir)
  const ids = rows.map(row => row.id)
  assert.ok(ids.includes(collidingId), 'pre-seeded collider id must remain in index')
  assert.ok(ids.includes(retryId), 'retry id must be in index')
  assert.equal(new Set(ids).size, ids.length, 'index ids must be unique (no collision survived)')

  // The retry episode file exists and is different from the collider.
  const retryFile = path.join(episodesDir, `${retryId}.md`)
  assert.ok(fs.existsSync(retryFile), 'retry episode file must exist')
  const retryContent = fs.readFileSync(retryFile, 'utf8')
  assert.ok(retryContent.includes('collisionsuccesstoken'),
    'retry episode body must contain the new sentinel (proves it was actually written)')
  // The two files have different content.
  assert.notEqual(retryContent, collidingContent,
    'retry file must differ from the collider file')

  // No temp litter.
  assert.deepEqual(tmpLitter(fixture.localDir), [], 'id-collision retry left temp litter')
  // Lockfile was released.
  assert.equal(fs.existsSync(path.join(fixture.localDir, 'clerk-apply.lock')), false,
    'id-collision retry released the store lock')
  telemetry.s3cIdCollisionRetry = {
    collidingId,
    retryId,
    oldBytesSurvived: Buffer.compare(originalBytes, originalAfter) === 0,
    uniqueIndexIds: new Set(ids).size,
    episodes: ids.length,
    elapsedMs: Date.now() - started,
  }
}

async function testConsolidateFreshRereadInheritsPin() {
  // Race scenario: pre-seed two near-duplicate lessons (NEITHER pinned).
  // An external holder takes the store lock and waits. Spawn em-consolidate
  // --apply --confirm; it performs its pre-lock scan, then blocks on the
  // lock. The holder-owned update rewrites one member's file body (adds a
  // unique token) AND sets pinned: true on that member's index row.
  // Release the holder; em-consolidate acquires the lock and reads FRESH
  // rows + fresh contents. The test asserts: the digest body contains the
  // unique token (proves fresh contents), the digest frontmatter has
  // pinned: true (proves fresh rows), and the digest index row has
  // pinned: true (proves fresh pin survived).
  const fixture = mkStoreFixture('store-write-consolidate-reread-')
  const seeded = []
  for (const e of [
    { summary: 'Atomic rename prevents torn index reads', body: 'We hit a torn read; the fix is temp file plus atomic rename for every index write.' },
    { summary: 'Use temp file plus rename for index writes', body: 'Torn index reads again — atomic rename via temp file is mandatory for index writes.' },
  ]) {
    const r = runJsonSync(STORE, [
      '--project', 'issue-546-fixture',
      '--category', 'lesson',
      '--summary', e.summary,
      '--body', e.body,
      '--tag', 'issue-546-fixture',
      '--scope', 'local',
    ], fixture)
    assert.equal(r.code, 0, `seed failed: ${r.stdout} ${r.stderr}`)
    assert.equal(r.json?.status, 'ok', `seed JSON: ${r.stdout}`)
    seeded.push(r.json.id)
  }
  // Pre-condition: neither seeded row is pinned.
  for (const id of seeded) {
    const row = rowById(fixture.localDir, id)
    assert.equal(row?.pinned, undefined, `seeded ${id} must not be pinned pre-race`)
  }

  const lockFile = path.join(fixture.localDir, 'clerk-apply.lock')
  const uniqueToken = `holderinjectedtoken${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  const memberId = seeded[0]
  const memberFile = path.join(fixture.localDir, 'episodes', `${memberId}.md`)
  const preRaceBefore = fs.readFileSync(memberFile, 'utf8')

  await withLiveHolder(lockFile, async ({ child }) => {
    // Spawn em-consolidate --apply --confirm. It will block on the lock
    // (long timeout so the holder update has time to land).
    const completion = spawnJson(CONSOLIDATE, [
      '--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm',
    ], fixture, { EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS: '5000' })
    // Wait until em-consolidate is blocked on the lock acquisition. The
    // pre-lock scan is fast; the lock poll is 50ms. 300ms is enough.
    await waitMs(300)
    assert.equal(completion.child.exitCode, null,
      'em-consolidate must still be waiting on the lock before the holder-owned update')

    // Holder-owned update (1): rewrite the member file to add a unique
    // token in the body AND pin it via the frontmatter. This is the
    // FRESH content the in-lock reread must observe (body + frontmatter).
    const pinnedFrontmatter = preRaceBefore.replace(/^---\n/, `---\npinned: true\n`)
    const updatedContent = pinnedFrontmatter + `\n\n${uniqueToken}\n`
    fs.writeFileSync(memberFile, updatedContent)

    // Holder-owned update (2): rewrite index.jsonl so the member is
    // pinned: true. The in-lock fresh row map must carry this pin.
    const indexFile = path.join(fixture.localDir, 'index.jsonl')
    const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
    const rewritten = lines.map(line => {
      try {
        const entry = JSON.parse(line)
        if (entry.id === memberId) entry.pinned = true
        return JSON.stringify(entry)
      } catch { return line }
    })
    fs.writeFileSync(indexFile, rewritten.join('\n') + '\n', 'utf8')

    // Release the holder; em-consolidate acquires the lock and reads
    // fresh rows + fresh contents.
    releaseChild(child)
    const result = await completion
    assert.equal(result.code, 0, `em-consolidate failed: stdout=${result.stdout} stderr=${result.stderr}`)
    assert.equal(result.json?.status, 'ok', `em-consolidate envelope: ${result.stdout}`)
    assert.equal(result.json?.applied, 1, `expected 1 applied cluster; got ${result.stdout}`)
    const digestId = result.json.clusters[0]?.digest_id
    assert.equal(typeof digestId, 'string', `digest_id missing: ${result.stdout}`)

    // Digest body contains the unique token (proves fresh contents).
    const digestFile = path.join(fixture.localDir, 'episodes', `${digestId}.md`)
    const digestContent = fs.readFileSync(digestFile, 'utf8')
    assert.ok(digestContent.includes(uniqueToken),
      `digest body must contain holder-injected token '${uniqueToken}' (proves fresh contents; digest=${digestContent.slice(0, 400)})`)

    // Digest frontmatter has pinned: true (proves fresh rows).
    assert.ok(/^pinned: true$/m.test(digestContent),
      `digest frontmatter must have pinned: true (proves fresh rows); content=${digestContent.slice(0, 400)}`)

    // Digest index row has pinned: true (proves fresh pin survived the
    // atomically rewritten index.jsonl).
    const postRows = readIndexRows(fixture.localDir)
    const digestRow = postRows.find(r => r.id === digestId)
    assert.ok(digestRow, 'digest row must exist in index.jsonl')
    assert.equal(digestRow.pinned, true,
      'digest index row must have pinned: true (proves fresh pin survived)')

    // Member row is marked superseded, pinned still true post-rewrite.
    const memberRow = postRows.find(r => r.id === memberId)
    assert.equal(memberRow?.status, 'superseded', 'member row must be superseded')
    assert.equal(memberRow?.pinned, true, 'member row pin must survive the supersede rewrite')

    // Member file: frontmatter carries superseded_by + pinned: true.
    const memberAfter = fs.readFileSync(memberFile, 'utf8')
    assert.ok(/^superseded_by: /m.test(memberAfter),
      'member file must have superseded_by frontmatter')
    assert.ok(/^pinned: true$/m.test(memberAfter),
      'member file must retain pinned: true after the supersede rewrite')

    // No temp litter; lock released.
    assert.deepEqual(tmpLitter(fixture.localDir), [], 'consolidate fresh-reread left temp litter')
    assert.equal(fs.existsSync(lockFile), false, 'consolidate fresh-reread released the lock')

    telemetry.s3cConsolidateFreshReread = {
      memberId,
      digestId,
      pinInheritedFrontmatter: /^pinned: true$/m.test(digestContent),
      pinInheritedIndexRow: digestRow.pinned === true,
      tokenInherited: digestContent.includes(uniqueToken),
      memberPinSurvived: /^pinned: true$/m.test(memberAfter),
    }
  })
}

async function runS3cIntegrationTests() {
  console.log('# S3c ID-collision retry + consolidate fresh-reread race')
  await asyncTap('S3c: em-store ID-collision retry — preload fixes Date and sequences randomBytes(2); old bytes survive; index ids unique', testStoreIdCollisionRetry)
  await asyncTap('S3c: consolidate legacy --apply fresh-reread — holder-owned update survives; digest inherits content and pin', testConsolidateFreshRereadInheritsPin)
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function main() {
  let exitCode = 0
  try {
    if (HELPER_ONLY) {
      await runHelperTests()
    } else if (EXPECT_MAIN_RED) {
      await runExternalHolderTest()
    } else {
      await runHelperTests()
      await runExternalHolderTest()
      await runS2aIntegrationTests()
      await runS2bIntegrationTests()
      await runS3aIntegrationTests()
      await runS3bIntegrationTests()
      await runS3cIntegrationTests()
    }
  } catch (e) {
    console.error('FATAL', e)
    exitCode = 1
  } finally {
    // F7: release and await any orphan live-holder children that escaped
    // a test throw before withLiveHolder's own finally could clean them
    // up. liveChildren is mutated by the child's 'exit' listener, so we
    // snapshot first to avoid mutating during iteration.
    for (const child of Array.from(liveChildren)) {
      releaseChild(child)
      try { await awaitChild(child) } catch { /* best effort */ }
    }
    await stopChildren(Array.from(commandChildren))
    // F6: every mkTmp() root is removed here, including failure paths.
    // No more leaked /tmp fixtures from this suite.
    for (const root of tmpRoots) {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
    }
    console.log(`\n# tests ${pass + fail}`)
    console.log(`# pass  ${pass}`)
    console.log(`# fail  ${fail}`)
    if (Object.keys(telemetry).length) console.log(`# telemetry ${JSON.stringify(telemetry)}`)
    if (fail > 0) exitCode = 1
  }
  process.exit(exitCode)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
