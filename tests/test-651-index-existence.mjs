#!/usr/bin/env node
// test-651-index-existence.mjs — issue #651 lstat-based index existence-semantics
// contract (see docs/plans/issue-651-index-existence-contract.md §8). Harness
// pattern mirrors tests/test-628-sibling-init-guard.mjs: mkdtemp + real em-store
// seed + spawnSync with explicit cwd + pinned HOME/USERPROFILE; lastJson(); no
// raw-stack assert. Every spawnSync call carries timeout: 10000 so a FIFO
// regression FAILS the assertion (status:null/signal) instead of hanging the
// suite.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  classifyIndexFile, assertReadableIndex, readIndexFileOrThrow, openReadableIndex, IndexUnreadableError,
  readBodyOrSkip, openReadableBody, BodyUnreadableError,
} from '../scripts/lib/index-state.mjs'

// EM651_TEST_REPO_OVERRIDE: points spawned scripts at an alternate repo root
// (used ONLY to re-run this suite against a pre-fix snapshot for the §8
// falsifiability gate — see docs/plans/issue-651-index-existence-contract.md
// build order step 2). Unset in normal use; T1 always imports the CURRENT
// working tree's scripts/lib/index-state.mjs via the static import above,
// regardless of this override.
const REPO = process.env.EM651_TEST_REPO_OVERRIDE
  ? path.resolve(process.env.EM651_TEST_REPO_OVERRIDE)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = path.join(REPO, 'scripts')
const PLUGIN_SCRIPTS = path.join(REPO, 'plugins', 'episodic-memory', 'scripts')

let pass = 0, fail = 0, skipped = 0
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function t(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`) }
  catch (e) { fail++; console.log(`not ok - ${name}: ${e.message}`) }
}
function skip(name, reason) { skipped++; console.log(`ok - ${name} # SKIP ${reason}`) }

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const IS_WIN = process.platform === 'win32'

// ---------------------------------------------------------------------------
// spawn helper — real script, explicit cwd, pinned HOME/USERPROFILE, bounded
// timeout so a FIFO regression fails loud instead of hanging the suite.
// ---------------------------------------------------------------------------
function run(scriptPath, args, { cwd, home }) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
}

// sleepSync(ms) / waitForFileSync(path, timeoutMs) — issue #653 S7 lock-
// release leg needs a synchronous wait (the whole suite is spawnSync-based,
// no async/await): Atomics.wait on a throwaway SharedArrayBuffer blocks the
// calling thread without special worker setup on Node's main thread.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
function waitForFileSync(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(p)) {
    if (Date.now() > deadline) return false
    sleepSync(20)
  }
  return true
}

// Most scripts print one compact JSON line; em-restore.mjs pretty-prints
// (JSON.stringify(o, null, 2)) so the LAST line alone ("}") is not valid JSON
// on its own — try the whole trimmed stdout first, fall back to the last
// non-empty line for the compact-single-line scripts.
function lastJson(stdout) {
  const trimmed = (stdout || '').trim()
  try { return JSON.parse(trimmed) } catch {}
  try { return JSON.parse(trimmed.split('\n').filter(Boolean).pop()) } catch { return null }
}

// Generic typed-abort assertion (REQ-3/REQ-4): exit 1, last stdout line is a
// {status:'error'} JSON object, message names the defect + the file, and
// stderr carries no raw stack frames (a FIFO regression instead reports
// status:null/signal via the timeout).
function checkTyped(r, who) {
  assert(r.signal === null, `${who}: no signal (timeout/kill) — got ${r.signal}`)
  assert(r.status === 1, `${who}: exit 1, got status=${r.status} signal=${r.signal} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`)
  const j = lastJson(r.stdout)
  assert(j && j.status === 'error', `${who}: typed envelope on stdout, got: ${(r.stdout || '').slice(0, 200)}`)
  const raw = r.stdout
  assert(/episode index unreadable/.test(raw), `${who}: message names 'episode index unreadable', got: ${raw.slice(0, 300)}`)
  assert(/index\.jsonl/.test(raw), `${who}: message names index.jsonl, got: ${raw.slice(0, 300)}`)
  assert(!/at .*\.mjs/.test(r.stderr || ''), `${who}: no raw stack frames on stderr, got: ${(r.stderr || '').slice(0, 300)}`)
  return j
}

// ---------------------------------------------------------------------------
// Fixture shapes (§8): symloop, dangling, eaccess, fifo, file000, parent-dangling.
// Applied to an already-seeded store's LOCAL index.jsonl (or, for
// parent-dangling, the store dir itself).
// ---------------------------------------------------------------------------
const ALL_SHAPES = ['symloop', 'dangling', 'eaccess', 'fifo', 'file000', 'parent-dangling']

function shapeSkipReason(shape) {
  if (shape === 'eaccess' && IS_ROOT) return 'root bypasses permission checks'
  if (shape === 'fifo' && IS_WIN) return 'mkfifo unavailable on win32'
  return null
}

// file000's fixture content — named so callers that need to assert
// "index.jsonl unchanged after an aborted run" can compare against the
// POST-corruption content directly instead of racing a chmod-000 read.
const FILE000_FIXTURE_CONTENT = JSON.stringify({ id: 'x', date: '2020-01-01', time: '00:00', project: 'p', category: 'decision', status: 'active', supersedes: null, tags: [], summary: 'x' }) + '\n'

// indexPath = <storeDir>/index.jsonl. storeDir must already exist (with
// episodes/ etc) except for 'parent-dangling', which replaces storeDir itself.
function applyShape(shape, indexPath, storeDir) {
  const dir = path.dirname(indexPath)
  switch (shape) {
    case 'symloop': {
      fs.rmSync(indexPath, { force: true })
      const loopB = path.join(dir, 'loop-b')
      fs.rmSync(loopB, { force: true })
      fs.symlinkSync('loop-b', indexPath)
      fs.symlinkSync('index.jsonl', loopB)
      return
    }
    case 'dangling': {
      fs.rmSync(indexPath, { force: true })
      fs.symlinkSync('does-not-exist-target', indexPath)
      return
    }
    case 'eaccess': {
      fs.chmodSync(storeDir, 0o000)
      return
    }
    case 'fifo': {
      fs.rmSync(indexPath, { force: true })
      const r = spawnSync('mkfifo', [indexPath])
      if (r.status !== 0) throw new Error(`mkfifo failed: ${r.stderr}`)
      return
    }
    case 'file000': {
      fs.writeFileSync(indexPath, FILE000_FIXTURE_CONTENT)
      fs.chmodSync(indexPath, 0o000)
      return
    }
    case 'parent-dangling': {
      fs.rmSync(storeDir, { recursive: true, force: true })
      fs.symlinkSync('does-not-exist-parent-target', storeDir)
      return
    }
    default:
      throw new Error(`unknown shape ${shape}`)
  }
}

// Best-effort restore so a chmod-000 fixture doesn't break cleanup / later
// shape comparison.
function restoreShape(shape, indexPath, storeDir) {
  if (shape === 'eaccess') { try { fs.chmodSync(storeDir, 0o755) } catch {} }
  if (shape === 'file000') { try { fs.chmodSync(indexPath, 0o644) } catch {} }
}

// ---------------------------------------------------------------------------
// Store fixtures
// ---------------------------------------------------------------------------
function mkStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(proj)
  const seed = spawnSync(process.execPath, [
    path.join(SCRIPTS, 'em-store.mjs'), '--project', 'p651', '--category', 'decision',
    '--summary', 'seed', '--body', 'seed body', '--scope', 'local',
  ], { cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } })
  assert(seed.status === 0, `seed store failed: ${seed.stderr}`)
  const seedId = (lastJson(seed.stdout) || {}).id
  const localDir = path.join(proj, '.episodic-memory')
  const globalDir = path.join(root, '.episodic-memory')
  // Valid (empty) global store so cross-store abort attribution is unambiguous.
  fs.mkdirSync(path.join(globalDir, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(globalDir, 'index.jsonl'), '')
  // em-pattern-health refuses before it ever reaches the episode index unless
  // a patterns/_index.json is reachable (CWD or ~/.episodic-memory) — an
  // empty registry is sufficient to clear that precondition.
  fs.mkdirSync(path.join(proj, 'patterns'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'patterns', '_index.json'), JSON.stringify({ patterns: [] }))
  return { root, proj, localDir, globalDir, seedId }
}

function mkEmptyWorld() {
  // Genuinely-missing index, clean parent all the way up: no .episodic-memory
  // anywhere reachable (fresh proj, fresh HOME).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-empty-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(proj)
  return { root, proj }
}

function cleanup(world) {
  try {
    if (world.localDir) restoreShape('eaccess', path.join(world.localDir, 'index.jsonl'), world.localDir)
    if (world.localDir) restoreShape('file000', path.join(world.localDir, 'index.jsonl'), world.localDir)
  } catch {}
  try { fs.rmSync(world.root, { recursive: true, force: true }) } catch {}
}

// =============================================================================
// T1 — unit: classifyIndexFile direct assertions against the §2 table.
// =============================================================================
;(function T1() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-t1-'))

  t('T1 absent — ENOENT + clean parent', () => {
    const p = path.join(dir, 'sub1', 'index.jsonl')
    fs.mkdirSync(path.dirname(p))
    const r = classifyIndexFile(fs, p)
    assert(r.state === 'absent', JSON.stringify(r))
  })

  t('T1 absent — parent also ENOENT (no store dir at all)', () => {
    const p = path.join(dir, 'does-not-exist-at-all', 'index.jsonl')
    const r = classifyIndexFile(fs, p)
    assert(r.state === 'absent', JSON.stringify(r))
  })

  t('T1 unreadable — parent-dangling symlink (broken parent)', () => {
    const parent = path.join(dir, 'sub2')
    fs.symlinkSync('nope', parent)
    const p = path.join(parent, 'index.jsonl')
    const r = classifyIndexFile(fs, p)
    assert(r.state === 'unreadable', JSON.stringify(r))
    fs.unlinkSync(parent)
  })

  t('T1 unreadable — symlink, dangling target', () => {
    const p = path.join(dir, 'dangling.jsonl')
    fs.symlinkSync('does-not-exist', p)
    const r = classifyIndexFile(fs, p)
    assert(r.state === 'unreadable' && r.code === 'ENOENT', JSON.stringify(r))
    fs.unlinkSync(p)
  })

  t('T1 unreadable — symlink loop (ELOOP)', () => {
    const a = path.join(dir, 'loopa.jsonl')
    const b = path.join(dir, 'loopb.jsonl')
    fs.symlinkSync('loopb.jsonl', a)
    fs.symlinkSync('loopa.jsonl', b)
    const r = classifyIndexFile(fs, a)
    assert(r.state === 'unreadable', JSON.stringify(r))
    fs.unlinkSync(a); fs.unlinkSync(b)
  })

  t('T1 ok — healthy symlink to a regular file', () => {
    const real = path.join(dir, 'real.jsonl')
    fs.writeFileSync(real, '')
    const link = path.join(dir, 'link.jsonl')
    fs.symlinkSync('real.jsonl', link)
    const r = classifyIndexFile(fs, link)
    assert(r.state === 'ok', JSON.stringify(r))
    fs.unlinkSync(link); fs.unlinkSync(real)
  })

  t('T1 unreadable — resolves to a directory (EISDIR)', () => {
    const p = path.join(dir, 'isadir.jsonl')
    fs.mkdirSync(p)
    const r = classifyIndexFile(fs, p)
    assert(r.state === 'unreadable' && r.code === 'EISDIR', JSON.stringify(r))
    fs.rmdirSync(p)
  })

  if (!IS_WIN) {
    t('T1 unreadable — FIFO (ENOTREG), classified without opening', () => {
      const p = path.join(dir, 'fifo.jsonl')
      const mk = spawnSync('mkfifo', [p])
      assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
      const r = classifyIndexFile(fs, p)
      assert(r.state === 'unreadable' && r.code === 'ENOTREG', JSON.stringify(r))
      fs.unlinkSync(p)
    })

    t('T1 unreadable — symlink to /dev/null (ENOTREG, DEFER D2 cheap leg)', () => {
      if (!fs.existsSync('/dev/null')) { skip('T1 unreadable — symlink to /dev/null', 'no /dev/null on this platform'); return }
      const p = path.join(dir, 'devnull.jsonl')
      fs.symlinkSync('/dev/null', p)
      const r = classifyIndexFile(fs, p)
      assert(r.state === 'unreadable' && r.code === 'ENOTREG', JSON.stringify(r))
      fs.unlinkSync(p)
    })
  } else {
    skip('T1 unreadable — FIFO (ENOTREG)', 'mkfifo unavailable on win32')
    skip('T1 unreadable — symlink to /dev/null', 'no /dev/null on win32')
  }

  if (!IS_ROOT) {
    t('T1 unreadable — EACCES parent (direct lstat failure)', () => {
      const parent = path.join(dir, 'sub3')
      fs.mkdirSync(parent)
      const p = path.join(parent, 'index.jsonl')
      fs.writeFileSync(p, '')
      fs.chmodSync(parent, 0o000)
      const r = classifyIndexFile(fs, p)
      fs.chmodSync(parent, 0o755)
      assert(r.state === 'unreadable', JSON.stringify(r))
      fs.rmSync(parent, { recursive: true, force: true })
    })
  } else {
    skip('T1 unreadable — EACCES parent', 'root bypasses permission checks')
  }

  t('assertReadableIndex — absent returns "absent", ok returns "ok", unreadable throws', () => {
    const absentPath = path.join(dir, 'sub4', 'index.jsonl')
    assert(assertReadableIndex(fs, absentPath) === 'absent', 'absent case')
    const okPath = path.join(dir, 'ok.jsonl')
    fs.writeFileSync(okPath, '')
    assert(assertReadableIndex(fs, okPath) === 'ok', 'ok case')
    fs.mkdirSync(path.join(dir, 'baddir.jsonl'))
    let threw = false
    try { assertReadableIndex(fs, path.join(dir, 'baddir.jsonl')) } catch (e) { threw = e instanceof IndexUnreadableError }
    assert(threw, 'unreadable case must throw IndexUnreadableError')
    fs.unlinkSync(okPath); fs.rmdirSync(path.join(dir, 'baddir.jsonl'))
  })

  t('readIndexFileOrThrow — absent null, ok returns content, read failure wraps', () => {
    const absentPath = path.join(dir, 'sub5', 'index.jsonl')
    assert(readIndexFileOrThrow(fs, absentPath) === null, 'absent -> null')
    const okPath = path.join(dir, 'ok2.jsonl')
    fs.writeFileSync(okPath, 'hello\n')
    assert(readIndexFileOrThrow(fs, okPath) === 'hello\n', 'ok -> content')
    fs.unlinkSync(okPath)
  })

  fs.rmSync(dir, { recursive: true, force: true })
})()

// =============================================================================
// S1 — body-read helper unit legs (issues #666/#667): readBodyOrSkip /
// openReadableBody against FIFO/dir/absent shapes.
//
// Review fix-round item 1 (both lenses, mutation-proven): the FIFO legs are
// spawned into a CHILD process with a hard timeout, NOT called in-process.
// A same-process call is safe TODAY because O_NONBLOCK makes open() return
// immediately — but that is exactly the property a regression could break
// (e.g. a mutant that drops O_NONBLOCK or swaps in a blocking read). Called
// in-process, that mutant would FREEZE this entire suite forever (no
// external alarm to kill it), violating spec §5's fail-not-freeze
// requirement — the suite must observe the regression as a FAILURE, not
// hang until an operator notices. Dir/absent shapes stay in-process: no
// blocking-read mutant can hang an lstat/fstat-only path, so a spawn there
// buys nothing and only adds process overhead.
// =============================================================================
;(function S1_bodyHelpers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em666-s1-'))
  const INDEX_STATE_PATH = path.join(SCRIPTS, 'lib', 'index-state.mjs')

  // spawnBodyHelperChild(childSrcLines) — writes a throwaway .mjs file that
  // imports index-state.mjs fresh (same pattern as the D1 interleave child
  // below) and spawns it with timeout:10000 + SIGKILL. A regression that
  // reintroduces a blocking read is killed and reported as a signal, not a
  // frozen suite.
  function spawnBodyHelperChild(name, childSrcLines) {
    const childPath = path.join(dir, `child-${name}.mjs`)
    fs.writeFileSync(childPath, childSrcLines.join('\n'))
    const r = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' })
    fs.rmSync(childPath, { force: true })
    return r
  }

  t('S1 readBodyOrSkip — absent (ENOENT), never throws', () => {
    const p = path.join(dir, 'absent.md')
    const r = readBodyOrSkip(fs, p)
    assert(r.ok === false && r.code === 'ENOENT', JSON.stringify(r))
  })

  t('S1 readBodyOrSkip — directory (EISDIR)', () => {
    const p = path.join(dir, 'adir.md')
    fs.mkdirSync(p)
    const r = readBodyOrSkip(fs, p)
    assert(r.ok === false && r.code === 'EISDIR', JSON.stringify(r))
    fs.rmdirSync(p)
  })

  t('S1 readBodyOrSkip — ok on a regular file, returns raw content', () => {
    const p = path.join(dir, 'ok.md')
    fs.writeFileSync(p, 'hello body\n')
    const r = readBodyOrSkip(fs, p)
    assert(r.ok === true && r.raw === 'hello body\n', JSON.stringify(r))
    fs.unlinkSync(p)
  })

  if (!IS_WIN) {
    t('S1 readBodyOrSkip — FIFO (ENOTREG), no hang (spawned, alarm-wrapped)', () => {
      const p = path.join(dir, 'fifo.md')
      const mk = spawnSync('mkfifo', [p])
      assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
      const r = spawnBodyHelperChild('readBodyOrSkip-fifo', [
        `import fs from 'node:fs'`,
        `import { readBodyOrSkip } from ${JSON.stringify(INDEX_STATE_PATH)}`,
        `const r = readBodyOrSkip(fs, ${JSON.stringify(p)})`,
        `console.log(JSON.stringify(r))`,
      ])
      fs.unlinkSync(p)
      assert(r.signal === null, `S1 readBodyOrSkip FIFO: no signal (timeout/kill) — got ${r.signal} (this is the fail-not-freeze regression signature)`)
      assert(r.status === 0, `S1 readBodyOrSkip FIFO: child exit 0, got ${r.status}: stderr=${(r.stderr || '').slice(0, 300)}`)
      const j = JSON.parse((r.stdout || '').trim())
      assert(j.ok === false && j.code === 'ENOTREG', JSON.stringify(j))
    })
  } else {
    skip('S1 readBodyOrSkip — FIFO (ENOTREG)', 'mkfifo unavailable on win32')
  }

  t('S1 openReadableBody — absent returns null', () => {
    const p = path.join(dir, 'absent2.md')
    assert(openReadableBody(fs, p) === null, 'absent -> null')
  })

  t('S1 openReadableBody — ok returns content', () => {
    const p = path.join(dir, 'ok2.md')
    fs.writeFileSync(p, 'content\n')
    assert(openReadableBody(fs, p) === 'content\n', 'ok -> content')
    fs.unlinkSync(p)
  })

  t('S1 openReadableBody — directory throws BodyUnreadableError(EISDIR)', () => {
    const p = path.join(dir, 'adir2.md')
    fs.mkdirSync(p)
    let threw = null
    try { openReadableBody(fs, p) } catch (e) { threw = e }
    assert(threw instanceof BodyUnreadableError && threw.code === 'EISDIR', JSON.stringify(threw))
    assert(/episode body unreadable \(EISDIR\)/.test(threw.message), threw.message)
    fs.rmdirSync(p)
  })

  if (!IS_WIN) {
    t('S1 openReadableBody — FIFO throws BodyUnreadableError(ENOTREG), no hang (spawned, alarm-wrapped)', () => {
      const p = path.join(dir, 'fifo2.md')
      const mk = spawnSync('mkfifo', [p])
      assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
      const r = spawnBodyHelperChild('openReadableBody-fifo', [
        `import fs from 'node:fs'`,
        `import { openReadableBody, BodyUnreadableError } from ${JSON.stringify(INDEX_STATE_PATH)}`,
        `try {`,
        `  const raw = openReadableBody(fs, ${JSON.stringify(p)})`,
        `  console.log(JSON.stringify({ step: 'unexpected-ok', raw }))`,
        `} catch (e) {`,
        `  console.log(JSON.stringify({ step: 'typed-abort', isBodyUnreadable: e instanceof BodyUnreadableError, code: e.code, message: e.message }))`,
        `}`,
      ])
      fs.unlinkSync(p)
      assert(r.signal === null, `S1 openReadableBody FIFO: no signal (timeout/kill) — got ${r.signal} (this is the fail-not-freeze regression signature)`)
      assert(r.status === 0, `S1 openReadableBody FIFO: child exit 0, got ${r.status}: stderr=${(r.stderr || '').slice(0, 300)}`)
      const j = JSON.parse((r.stdout || '').trim())
      assert(j.step === 'typed-abort' && j.isBodyUnreadable && j.code === 'ENOTREG', JSON.stringify(j))
    })
  } else {
    skip('S1 openReadableBody — FIFO (ENOTREG)', 'mkfifo unavailable on win32')
  }

  fs.rmSync(dir, { recursive: true, force: true })
})()

// =============================================================================
// T3 — matrix: fixture shapes x scripts -> typed abort.
//
// Falsifiability note (build order step 2): (shape=file000, script=em-prune)
// and its T5 twin PASS pre-fix — em-prune's #628 loadIndexRowsOrAbort already
// wraps ANY exception from a raw fs.readFileSync (not just EISDIR) into the
// "episode index unreadable" envelope, so a chmod-000 index.jsonl was already
// typed-aborted before this plan existed. Not falsifiable evidence of #651
// for THIS (shape, script) pair specifically — verified in pre-fix.txt — but
// still kept as valid regression coverage post-fix.
// =============================================================================
const T3_SCRIPTS = [
  { name: 'em-list', script: 'em-list.mjs', args: ['--scope', 'local'] },
  { name: 'em-search', script: 'em-search.mjs', args: ['--project', 'p651', '--no-track', '--scope', 'local'] },
  { name: 'em-recall', script: 'em-recall.mjs', args: ['--scope', 'local', '--no-track'] },
  { name: 'em-check-stale', script: 'em-check-stale.mjs', args: ['--scope', 'local'] },
  { name: 'em-prune', script: 'em-prune.mjs', args: ['--scope', 'local', '--dry-run'] },
  { name: 'em-pattern-health', script: 'em-pattern-health.mjs', args: ['--scope', 'local'] },
  { name: 'em-rebuild-index', script: 'em-rebuild-index.mjs', args: ['--scope', 'local'] },
  { name: 'em-watch-codex', script: 'em-watch-codex.mjs', args: [] },
  {
    name: 'em-feedback', script: 'em-feedback.mjs', args: ['--id', 'does-not-exist-651', '--useful'],
    // Step-23 scope note: em-feedback's #651 fix covers the STORE-SELECTION
    // filter only (existsSync's false-negative silently dropping a broken
    // store from the lock/write set — plan §7 step 23, lines :138/:208). A
    // regular file that classifies 'ok' but fails to OPEN (file000) is not
    // one of those two named sites: it is still caught, but by the
    // pre-existing generic write-path catch (a different, also-typed
    // "Feedback write failed: ..." envelope, exit 1, no raw stack) rather
    // than the shared "episode index unreadable" wording. Out of this step's
    // literal scope, not a #651 gap.
    skipShapes: { file000: 'outside step-23 scope: caught by the pre-existing generic write-path catch, different envelope wording' },
  },
]

for (const shape of ALL_SHAPES) {
  const skipReason = shapeSkipReason(shape)
  for (const s of T3_SCRIPTS) {
    const name = `T3 ${shape} x ${s.name} -> typed abort`
    const perScriptSkip = s.skipShapes && s.skipShapes[shape]
    if (skipReason) { skip(name, skipReason); continue }
    if (perScriptSkip) { skip(name, perScriptSkip); continue }
    t(name, () => {
      const world = mkStore()
      try {
        const indexPath = path.join(world.localDir, 'index.jsonl')
        applyShape(shape, indexPath, world.localDir)
        const r = run(path.join(SCRIPTS, s.script), s.args, { cwd: world.proj, home: world.root })
        restoreShape(shape, indexPath, world.localDir)
        checkTyped(r, s.name)
      } finally {
        cleanup(world)
      }
    })
  }
}

// =============================================================================
// T3 (em-consolidate --fold-superseded --dry-run) — revision 2, §7 step 7b.
//
// Reachability finding (verified empirically with a throwaway probe against
// BOTH the current tree and a scratch copy with the step-7b hunk reverted,
// via explicit-cwd/env spawnSync — never shell cd/HOME juggling): for EVERY
// one of these shapes, the single-store fold path's typed abort comes from
// resolveProtectionOrAbort's PRE-EXISTING protection scan (SCOPE-INDEPENDENT:
// SINGLE_SCOPE_PROTECTION_STORES always reads BOTH LOCAL_DIR and GLOBAL_DIR
// via loadProtectionRows, i.e. exactly the two values DATA_DIR can ever be),
// which intercepts BEFORE foldStore is ever called — identically with and
// without the step-7b foldStore try/catch. The step-7b catch is real and
// correctly implemented (mirrors loadIndexOrAbort's shape) but is reachable
// ONLY via a TOCTOU race between the protection scan's read and foldStore's
// own read (same class as em-promote's DEFER-1 TOCTOU sites, §4) — not via
// any static, deterministic fixture. These legs are therefore NOT
// falsifiable evidence of the step-7b change specifically (verified: they
// pass identically pre- and post-7b) but ARE valid end-to-end regression
// coverage that `--fold-superseded --dry-run` aborts typed (archives
// nothing) on a corrupted store, which is the externally-observable
// guarantee that matters.
//
// Message-wording note: resolveProtectionOrAbort's own catch (pre-existing,
// scripts/em-consolidate.mjs indexUnreadableAbort/emitProtectionAbort family)
// produces "protection index unreadable (<CODE>) (<path>)", not "episode
// index unreadable" — a deliberately distinct reason string for a
// protection-scan failure vs. a primary-index read failure. Asserting the
// generic project-wide "episode index unreadable" wording here would be
// asserting something that has never been true for this code path; the
// checks below match the ACTUAL (correct) wording instead.
// =============================================================================
const CONSOLIDATE_SHAPES = ['symloop', 'dangling', 'eaccess', 'fifo']
for (const shape of CONSOLIDATE_SHAPES) {
  const skipReason = shapeSkipReason(shape)
  const name = `T3 ${shape} x em-consolidate --fold-superseded --dry-run -> typed abort`
  if (skipReason) { skip(name, skipReason); continue }
  t(name, () => {
    const world = mkStore()
    try {
      const indexPath = path.join(world.localDir, 'index.jsonl')
      applyShape(shape, indexPath, world.localDir)
      const r = run(path.join(SCRIPTS, 'em-consolidate.mjs'), ['--fold-superseded', '--dry-run', '--scope', 'local'], { cwd: world.proj, home: world.root })
      restoreShape(shape, indexPath, world.localDir)
      assert(r.signal === null, `em-consolidate: no signal (timeout/kill), got ${r.signal}`)
      assert(r.status === 1, `em-consolidate: exit 1, got status=${r.status} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`)
      const j = lastJson(r.stdout)
      assert(j && j.status === 'error' && j.mode === 'fold-superseded', `em-consolidate: typed envelope, got ${r.stdout}`)
      assert(/index unreadable/.test(r.stdout), `em-consolidate: names an index-unreadable defect, got ${r.stdout.slice(0, 300)}`)
      assert(/index\.jsonl/.test(r.stdout), `em-consolidate: names index.jsonl, got ${r.stdout.slice(0, 300)}`)
      assert(!/at .*\.mjs/.test(r.stderr || ''), `em-consolidate: no raw stack frames on stderr, got ${(r.stderr || '').slice(0, 300)}`)
    } finally { cleanup(world) }
  })
}

// =============================================================================
// T4 — controls: genuinely-missing index stays byte-compatible; healthy
// symlink keeps loading rows.
// =============================================================================
t('T4 control — genuinely-missing index: em-list exit 0 ok', () => {
  const world = mkEmptyWorld()
  try {
    const r = run(path.join(SCRIPTS, 'em-list.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'ok' && j.count === 0, `expected status:ok count:0, got ${r.stdout}`)
  } finally { fs.rmSync(world.root, { recursive: true, force: true }) }
})

t('T4 control — genuinely-missing index: em-search exit 0 ok', () => {
  const world = mkEmptyWorld()
  try {
    const r = run(path.join(SCRIPTS, 'em-search.mjs'), ['--scope', 'local', '--no-track'], { cwd: world.proj, home: world.root })
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'ok', `expected status:ok, got ${r.stdout}`)
  } finally { fs.rmSync(world.root, { recursive: true, force: true }) }
})

t('T4 control — genuinely-missing index: em-prune --dry-run exit 0 ok', () => {
  const world = mkEmptyWorld()
  try {
    const r = run(path.join(SCRIPTS, 'em-prune.mjs'), ['--scope', 'local', '--dry-run'], { cwd: world.proj, home: world.root })
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'ok', `expected status:ok, got ${r.stdout}`)
  } finally { fs.rmSync(world.root, { recursive: true, force: true }) }
})

t('T4 control — healthy symlink to real index.jsonl: em-list shows the seeded episode', () => {
  const world = mkStore()
  try {
    const indexPath = path.join(world.localDir, 'index.jsonl')
    const realPath = path.join(world.localDir, 'index.real.jsonl')
    fs.renameSync(indexPath, realPath)
    fs.symlinkSync('index.real.jsonl', indexPath)
    const r = run(path.join(SCRIPTS, 'em-list.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'ok' && j.count === 1, `expected one episode via the healthy symlink, got ${r.stdout}`)
  } finally { cleanup(world) }
})

// =============================================================================
// T5 — protection: em-prune --scope local (REAL, not dry-run) exits 1 and the
// seeded episode file is untouched, for every silent-pre-fix shape.
//
// 'parent-dangling' is excluded: constructing it requires rmSync'ing the
// WHOLE .episodic-memory dir (episodes/ included) and replacing it with a
// dangling symlink — the fixture setup itself destroys the seeded episode
// file before em-prune ever runs, so "file still exists" cannot be asserted
// meaningfully here. Its typed-abort behavior is already covered by T3.
// =============================================================================
for (const shape of ALL_SHAPES) {
  const skipReason = shapeSkipReason(shape) || (shape === 'parent-dangling' ? 'fixture setup itself removes episodes/ (see comment above); typed-abort already covered by T3' : null)
  const name = `T5 ${shape} — em-prune real run aborts, episode file untouched`
  if (skipReason) { skip(name, skipReason); continue }
  t(name, () => {
    const world = mkStore()
    try {
      const indexPath = path.join(world.localDir, 'index.jsonl')
      const episodePath = path.join(world.localDir, 'episodes', `${world.seedId}.md`)
      assert(fs.existsSync(episodePath), 'precondition: seeded episode file exists')
      applyShape(shape, indexPath, world.localDir)
      const r = run(path.join(SCRIPTS, 'em-prune.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
      restoreShape(shape, indexPath, world.localDir)
      checkTyped(r, 'em-prune')
      assert(fs.existsSync(episodePath), 'episode file must still exist after aborted prune')
      const archivedDir = path.join(world.localDir, 'archived')
      const archivedCount = fs.existsSync(archivedDir) ? fs.readdirSync(archivedDir).filter(f => f.endsWith('.md')).length : 0
      assert(archivedCount === 0, `nothing archived, got ${archivedCount}`)
    } finally { cleanup(world) }
  })
}

// =============================================================================
// T6 — rebuild guard: em-rebuild-index exits 1 typed (envelope incl.
// remediation hint) AND index.jsonl's shape is unchanged.
// =============================================================================
const T6_SHAPES = ['eaccess', 'symloop', 'file000']
for (const shape of T6_SHAPES) {
  const skipReason = shapeSkipReason(shape)
  const name = `T6 ${shape} — em-rebuild-index aborts before any write, index.jsonl unchanged`
  if (skipReason) { skip(name, skipReason); continue }
  t(name, () => {
    const world = mkStore()
    try {
      const indexPath = path.join(world.localDir, 'index.jsonl')
      const before = fs.readFileSync(indexPath, 'utf8')
      applyShape(shape, indexPath, world.localDir)
      const r = run(path.join(SCRIPTS, 'em-rebuild-index.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
      const j = checkTyped(r, 'em-rebuild-index')
      assert(typeof j.remediation === 'string' && /em-rebuild-index/.test(j.remediation), `remediation hint present, got ${JSON.stringify(j)}`)
      restoreShape(shape, indexPath, world.localDir)
      // Shape-unchanged: for eaccess (whole store dir chmod, file content
      // never touched) compare against the pre-corruption snapshot; for
      // file000 the corruption itself REPLACES content before chmod, so
      // compare against that fixed fixture content instead.
      if (shape === 'eaccess') {
        const after = fs.readFileSync(indexPath, 'utf8')
        assert(after === before, 'index.jsonl content unchanged after aborted rebuild')
      } else if (shape === 'file000') {
        const after = fs.readFileSync(indexPath, 'utf8')
        assert(after === FILE000_FIXTURE_CONTENT, 'index.jsonl content unchanged (still the file000 fixture) after aborted rebuild')
      } else {
        // symloop's index.jsonl is a symlink pointing at loop-b; confirm it is
        // still the same loop, not replaced by a regular file.
        const st = fs.lstatSync(indexPath)
        assert(st.isSymbolicLink(), 'index.jsonl symlink shape unchanged after aborted rebuild')
      }
    } finally { cleanup(world) }
  })
}

// =============================================================================
// T7 — vendored plugin copies: same absent/unreadable behavior as T3's
// em-search/em-list/em-check-stale, via the inlined classifier.
// =============================================================================
const T7_SCRIPTS = [
  { name: 'plugin em-list', script: 'em-list.mjs', args: ['--scope', 'local'] },
  { name: 'plugin em-search', script: 'em-search.mjs', args: ['--scope', 'local'] },
  { name: 'plugin em-check-stale', script: 'em-check-stale.mjs', args: ['--scope', 'local'] },
]
for (const shape of ALL_SHAPES) {
  const skipReason = shapeSkipReason(shape)
  for (const s of T7_SCRIPTS) {
    const name = `T7 ${shape} x ${s.name} -> typed abort`
    if (skipReason) { skip(name, skipReason); continue }
    t(name, () => {
      const world = mkStore()
      try {
        const indexPath = path.join(world.localDir, 'index.jsonl')
        applyShape(shape, indexPath, world.localDir)
        // The vendored copies resolve LOCAL_DIR from process.cwd() directly
        // (no resolveLocalDir walk), so cwd must equal proj exactly.
        const r = run(path.join(PLUGIN_SCRIPTS, s.script), s.args, { cwd: world.proj, home: world.root })
        restoreShape(shape, indexPath, world.localDir)
        checkTyped(r, s.name.replace('plugin ', ''))
      } finally { cleanup(world) }
    })
  }
}

// =============================================================================
// T8 — DEFER-3 write-ordering contract (issue #628 follow-up,
// docs/plans/issue-628-sibling-init-guard.md §17 DEFER-3).
//
// em-store's pre-fix write sequence committed the episode .md FIRST,
// then the index.jsonl append (legacy line :455). Any failure between
// those two writes — EISDIR swap after the assertReadableIndex check,
// ENOSPC mid-rename, EACCES on the index dir mid-tx — left an orphan
// .md on disk with no index row. Orphans are invisible to search/recall
// and accumulated until the next em-rebuild-index run reconciled via
// FS scan (the inverse-fail-shape rebuild heal is non-deterministic
// across crashes — the user-visible contract was "wait for a sweep").
//
// The fix reorders: atomic index commit FIRST, then atomic episode
// commit. A failure between the two writes now leaves a DANGLING index
// row (present in index.jsonl, no .md on disk). em-rebuild-index drops
// dangling rows on the next run (filesystem-scanned rebuild — REQ-1,
// I3), so the new fail shape is decaying-by-construction, not
// accumulating. Verified below by:
//
//   T8a (control) — healthy store: index and episode are both
//     present, IDs match. Regression that the reorder did not break
//     the happy path.
//
//   T8b (deterministic failure) — episodes/ replaced with a regular
//     file. fs.mkdirSync(episodesDir, {recursive:true}) throws EEXIST
//     AFTER the index commit and BEFORE the episode write. The test
//     asserts: (i) exit non-zero, (ii) NO episode .md was created
//     (no orphan), (iii) index.jsonl gained exactly one row (the
//     dangling entry), (iv) the dangling row references the summary
//     the caller asked for. This is the verbatim scenario that
//     pre-fix would have produced an orphan under.
//
//   T8c (self-healing) — once T8b's state is on disk (episodes/ as a
//     file, index has a dangling row), restore episodes/ as an empty
//     directory. em-rebuild-index scans the filesystem, finds no .md
//     matching the dangling id, and drops the dangling row — the
//     healed index has only the original seed row. Verifies the
//     "self-healing" half of the contract: the fail shape decays
//     deterministically on the next maintenance pass.
// =============================================================================

// Helper for T8: count index lines that parse as JSON entries, returning
// the parsed objects. Used to detect both "row added" and "row dropped"
// without depending on a specific format of index.jsonl beyond a JSONL
// line with a string 'id' field (already enforced by em-store writes).
function readIndexEntries(indexPath) {
  const raw = fs.readFileSync(indexPath, 'utf8')
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.id === 'string') out.push(e)
    } catch {}
  }
  return out
}

t('T8a control — em-store healthy store: index row + episode .md both present, IDs match', () => {
  const world = mkStore()
  try {
    const indexPath = path.join(world.localDir, 'index.jsonl')
    const beforeIds = new Set(readIndexEntries(indexPath).map(e => e.id))
    const episodesDir = path.join(world.localDir, 'episodes')
    const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
      '--project', 'p651', '--category', 'decision',
      '--summary', 'write-order-control', '--body', 'control body',
      '--scope', 'local',
    ], { cwd: world.proj, home: world.root })
    assert(r.signal === null, `em-store (T8a): no signal, got ${r.signal}: ${r.stderr}`)
    assert(r.status === 0, `em-store (T8a): exit 0, got ${r.status} stdout=${r.stdout} stderr=${r.stderr}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'ok' && typeof j.id === 'string', `em-store (T8a): ok envelope with id, got ${r.stdout}`)
    const afterEntries = readIndexEntries(indexPath)
    assert(afterEntries.length === beforeIds.size + 1, `em-store (T8a): index grew by exactly one row, got before=${beforeIds.size} after=${afterEntries.length}`)
    assert(afterEntries.some(e => e.id === j.id), `em-store (T8a): new index row carries id from stdout, got ids=${afterEntries.map(e => e.id).join(',')}`)
    const episodePath = path.join(episodesDir, `${j.id}.md`)
    assert(fs.existsSync(episodePath), `em-store (T8a): episode .md present, missing ${episodePath}`)
    const epContent = fs.readFileSync(episodePath, 'utf8')
    assert(epContent.includes('write-order-control'), `em-store (T8a): episode content includes summary, got first 200 chars: ${epContent.slice(0, 200)}`)
  } finally { cleanup(world) }
})

t('T8b — em-store with episodes/ as a regular file: index commits first, no orphan .md', () => {
  const world = mkStore()
  try {
    const indexPath = path.join(world.localDir, 'index.jsonl')
    const episodesDir = path.join(world.localDir, 'episodes')
    const beforeEntries = readIndexEntries(indexPath)
    const beforeMdFiles = fs.existsSync(episodesDir)
      ? fs.readdirSync(episodesDir).filter(f => f.endsWith('.md'))
      : []
    const beforeMdSet = new Set(beforeMdFiles)

    // Capture pre-run snapshots of every derived-index file so we can
    // assert each is byte-identical after the abort (the abort path
    // must NOT touch tags/category/tokens — those are written AFTER
    // the episode commit which never runs).
    const tagsFile = path.join(world.localDir, 'tags.json')
    const catFile = path.join(world.localDir, 'category-index.json')
    const tokensFile = path.join(world.localDir, 'tokens.json')
    const beforeTags = fs.existsSync(tagsFile) ? fs.readFileSync(tagsFile, 'utf8') : null
    const beforeCat = fs.existsSync(catFile) ? fs.readFileSync(catFile, 'utf8') : null
    const beforeTokens = fs.existsSync(tokensFile) ? fs.readFileSync(tokensFile, 'utf8') : null
    const beforeIndex = fs.readFileSync(indexPath, 'utf8')

    // Replace episodes/ with a regular file. fs.mkdirSync(recursive:true)
    // throws EEXIST when the leaf exists as a non-directory, so the
    // episode commit aborts AFTER the index commit and BEFORE any .md
    // is written.
    fs.rmSync(episodesDir, { recursive: true, force: true })
    fs.writeFileSync(episodesDir, '')

    const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
      '--project', 'p651', '--category', 'decision',
      '--summary', 'write-order-defer3', '--body', 'defer3 body',
      '--scope', 'local',
    ], { cwd: world.proj, home: world.root })
    assert(r.signal === null, `em-store (T8b): no signal (no hang/timeout), got ${r.signal}: ${r.stderr}`)
    assert(r.status !== 0, `em-store (T8b): non-zero exit, got status=${r.status} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`)

    // (i) episodes/ is still a regular file (mkdirSync did not promote
    //     it to a directory) — proves no successful mkdirSync episode-
    //     write happened.
    const st = fs.lstatSync(episodesDir)
    assert(st.isFile(), `em-store (T8b): episodes/ is a regular file (mkdirSync did NOT promote), got mode=${st.mode}`)
    // (ii) Derived JSON files unchanged — verifies the abort happened
    //      BEFORE any updateTagsIndex/updateCategoryIndex/updateTokensIndex.
    if (beforeTags !== null) {
      const afterTags = fs.readFileSync(tagsFile, 'utf8')
      assert(afterTags === beforeTags, `em-store (T8b): tags.json unchanged after abort`)
    } else {
      assert(!fs.existsSync(tagsFile), `em-store (T8b): tags.json absent (was absent before)`)
    }
    if (beforeCat !== null) {
      const afterCat = fs.readFileSync(catFile, 'utf8')
      assert(afterCat === beforeCat, `em-store (T8b): category-index.json unchanged after abort`)
    } else {
      assert(!fs.existsSync(catFile), `em-store (T8b): category-index.json absent (was absent before)`)
    }
    if (beforeTokens !== null) {
      const afterTokens = fs.readFileSync(tokensFile, 'utf8')
      assert(afterTokens === beforeTokens, `em-store (T8b): tokens.json unchanged after abort`)
    } else {
      assert(!fs.existsSync(tokensFile), `em-store (T8b): tokens.json absent (was absent before)`)
    }
    // (iii) Index GROWTH: structurally required for the write-ordering
    //      fix to make sense — the index commit must succeed BEFORE the
    //      episode write, otherwise this whole DEFER-3 contract is
    //      vacuous. We don't pin exact bytes (timestamps vary); we
    //      pin row count + caller-supplied fields.
    const afterEntries = readIndexEntries(indexPath)
    assert(afterEntries.length === beforeEntries.length + 1, `em-store (T8b): index.jsonl gained exactly one row (the dangling entry), got before=${beforeEntries.length} after=${afterEntries.length}`)
    const dangling = afterEntries.find(e => !beforeEntries.some(b => b.id === e.id))
    assert(dangling, 'em-store (T8b): dangling row id present in post-fix state')
    assert(dangling.summary === 'write-order-defer3', `em-store (T8b): dangling row summary matches the caller's --summary, got ${dangling.summary}`)
    assert(dangling.project === 'p651', `em-store (T8b): dangling row project intact, got ${dangling.project}`)
    assert(dangling.category === 'decision', `em-store (T8b): dangling row category intact, got ${dangling.category}`)
    // (iv) No orphan .md created anywhere under the store. Walking the
    //      tree (which now has episodes/ as a regular file) catches the
    //      pre-fix orphan shape: a stray .md would appear at
    //      <dataDir>/episodes/<id>.md IF the pre-fix order ran; here
    //      episodes/ is a regular file so no .md can exist there, but
    //      the assertion covers the .md-anywhere invariant generally.
    function walk(dir) {
      if (!fs.existsSync(dir)) return []
      const stDir = fs.lstatSync(dir)
      if (stDir.isFile()) return [dir]
      const out = []
      for (const name of fs.readdirSync(dir)) out.push(...walk(path.join(dir, name)))
      return out
    }
    const newMdFiles = walk(world.localDir).filter(p => p.endsWith('.md')).filter(p => {
      const base = path.basename(p)
      // Exclude seeded pre-existing files: anything in the original
      // beforeMdFiles set is expected. The dangling row's id is NOT in
      // beforeMdFiles (it was never written) — but that id has no .md
      // either, because mkdirSync failed. So no orphan.
      return !beforeMdSet.has(base)
    })
    // Filename-only dedup (beforeMdSet may have substrings in paths) —
    // collapse to unique .md filenames.
    const newMdFileNames = new Set(newMdFiles.map(p => path.basename(p)))
    assert(newMdFileNames.size === 0, `em-store (T8b): no orphan .md anywhere under store, got ${[...newMdFileNames].join(', ')}`)
    // (v) Reference: the prior index.jsonl bytes ARE a prefix of the
    //     after bytes (atomicReplaceFileSync composed priorIndexContent +
    //     indexEntry + '\n'). Pin that exact invariant — the index was
    //     APPENDED to, not replaced wholesale.
    const afterIndex = fs.readFileSync(indexPath, 'utf8')
    assert(afterIndex.startsWith(beforeIndex), `em-store (T8b): post-fix index.jsonl begins with the exact pre-run bytes (atomic append), first diff at byte ${beforeIndex.length}`)
  } finally { cleanup(world) }
})

t('T8c — em-rebuild-index heals dangling index row left by aborted em-store (self-healing contract)', () => {
  const world = mkStore()
  try {
    const indexPath = path.join(world.localDir, 'index.jsonl')
    const episodesDir = path.join(world.localDir, 'episodes')

    // Establish the dangling-row state via T8b's same construct. The
    // store starts with a seeded episode and one index row; we run
    // em-store against the regular-file episodes/, producing one
    // dangling entry.
    const seedIds = new Set(readIndexEntries(indexPath).map(e => e.id))
    fs.rmSync(episodesDir, { recursive: true, force: true })
    fs.writeFileSync(episodesDir, '')
    const abort = run(path.join(SCRIPTS, 'em-store.mjs'), [
      '--project', 'p651', '--category', 'decision',
      '--summary', 'write-order-defer3-c', '--body', 'defer3c body',
      '--scope', 'local',
    ], { cwd: world.proj, home: world.root })
    assert(abort.status !== 0, `em-store (T8c): non-zero exit, got ${abort.status}`)
    const afterAbort = readIndexEntries(indexPath)
    assert(afterAbort.length === seedIds.size + 1, `em-store (T8c): one dangling row, got before=${seedIds.size} after=${afterAbort.length}`)
    const dangling = afterAbort.find(e => !seedIds.has(e.id))
    assert(dangling, 'em-store (T8c): dangling row id present in post-fix state')

    // Restore episodes/ as an EMPTY directory (the seed's .md is gone
    // — we deleted episodes/ wholesale). em-rebuild-index scans the
    // FS; with no .md matching the seed id OR the dangling id, both
    // rows are dropped from the rebuilt index.
    fs.rmSync(episodesDir, { force: true })
    fs.mkdirSync(episodesDir, { recursive: true })

    const heal = run(path.join(SCRIPTS, 'em-rebuild-index.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
    assert(heal.signal === null, `em-rebuild-index (T8c): no signal, got ${heal.signal}: ${heal.stderr}`)
    assert(heal.status === 0, `em-rebuild-index (T8c): exit 0, got status=${heal.status} stderr=${heal.stderr.slice(0, 500)}`)

    const afterHeal = readIndexEntries(indexPath)
    const remainingDangling = afterHeal.find(e => e.id === dangling.id)
    assert(!remainingDangling, `em-rebuild-index (T8c): dangling row DROPPED after heal, still present: ${JSON.stringify(remainingDangling)}`)
    // The seed's .md is gone (we deleted episodes/), so it should
    // also be dropped — the index is rebuilt FROM the filesystem.
    const seedStill = afterHeal.find(e => seedIds.has(e.id))
    assert(!seedStill, `em-rebuild-index (T8c): seed row also dropped (filesystem-scanned rebuild), still present: ${JSON.stringify(seedStill)}`)
    // Both rows gone -> index file is now empty (or just whitespace).
    const rawAfterHeal = fs.readFileSync(indexPath, 'utf8')
    assert(rawAfterHeal.trim() === '' || afterHeal.length === 0, `em-rebuild-index (T8c): empty index (no FS-backed rows), got raw=${JSON.stringify(rawAfterHeal.slice(0, 200))} entries=${afterHeal.length}`)
  } finally { cleanup(world) }
})

// =============================================================================
// T8d/T8e/T8f (issues #666/#667 S5, audit Q6): em-store's write-block
// envelope class. T8d/T8e reuse T8b's fixture shapes (episodes/ as a regular
// file / chmod 0000) but assert the NEW typed episode-write-failed envelope
// on top of T8b's untouched side-effect invariants. T8f exercises the
// lock-acquire branch (store-lock-failed) via a chmod 0555 data dir.
// =============================================================================

t('T8d — em-store with episodes/ as a regular file: typed episode-write-failed:EEXIST envelope, T8b invariants hold', () => {
  const world = mkStore()
  try {
    const indexPath = path.join(world.localDir, 'index.jsonl')
    const episodesDir = path.join(world.localDir, 'episodes')
    const beforeEntries = readIndexEntries(indexPath)
    const tagsFile = path.join(world.localDir, 'tags.json')
    const beforeTags = fs.existsSync(tagsFile) ? fs.readFileSync(tagsFile, 'utf8') : null
    fs.rmSync(episodesDir, { recursive: true, force: true })
    fs.writeFileSync(episodesDir, '')

    const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
      '--project', 'p651', '--category', 'decision',
      '--summary', 'write-order-t8d', '--body', 'defer3 t8d body',
      '--scope', 'local',
    ], { cwd: world.proj, home: world.root })

    assert(r.signal === null, `em-store (T8d): no signal, got ${r.signal}: ${r.stderr}`)
    // Q6 (audit): explicit non-zero-status assert kills the "envelope + exit 0" mutation (T8b precedent).
    assert(r.status !== 0, `em-store (T8d): non-zero exit, got status=${r.status} stdout=${(r.stdout || '').slice(0, 200)}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'error', `em-store (T8d): typed envelope, got ${r.stdout}`)
    assert(j.code === 'episode-write-failed:EEXIST', `em-store (T8d): code episode-write-failed:EEXIST, got ${JSON.stringify(j)}`)
    assert(/episodes-dir/.test(r.stdout), `em-store (T8d): leg name in message, got ${r.stdout.slice(0, 300)}`)
    assert(/EEXIST/.test(r.stdout), `em-store (T8d): CODE in message, got ${r.stdout.slice(0, 300)}`)

    // T8b invariants, re-checked: episodes/ still the regular file (no
    // promotion), dangling row (exactly one new row), no orphan .md, derived
    // JSONs untouched.
    const st = fs.lstatSync(episodesDir)
    assert(st.isFile(), 'em-store (T8d): episodes/ still a regular file (mkdirSync did NOT promote)')
    const afterEntries = readIndexEntries(indexPath)
    assert(afterEntries.length === beforeEntries.length + 1, `em-store (T8d): index gained exactly one dangling row, before=${beforeEntries.length} after=${afterEntries.length}`)
    const dangling = afterEntries.find(e => !beforeEntries.some(b => b.id === e.id))
    assert(dangling && dangling.summary === 'write-order-t8d', `em-store (T8d): dangling row summary matches, got ${JSON.stringify(dangling)}`)
    const afterTags = fs.existsSync(tagsFile) ? fs.readFileSync(tagsFile, 'utf8') : null
    assert(afterTags === beforeTags, `em-store (T8d): tags.json unchanged (derived indexes never reached), before=${beforeTags} after=${afterTags}`)
  } finally { cleanup(world) }
})

{
  const name = 'T8e — em-store with episodes/ chmod 0000: typed episode-write-failed:EACCES envelope'
  if (IS_ROOT) { skip(name, 'root bypasses permission checks') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const indexPath = path.join(world.localDir, 'index.jsonl')
        const episodesDir = path.join(world.localDir, 'episodes')
        const beforeEntries = readIndexEntries(indexPath)
        fs.chmodSync(episodesDir, 0o000)
        const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
          '--project', 'p651', '--category', 'decision',
          '--summary', 'write-order-t8e', '--body', 'defer3 t8e body',
          '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        fs.chmodSync(episodesDir, 0o755)
        assert(r.signal === null, `em-store (T8e): no signal, got ${r.signal}: ${r.stderr}`)
        assert(r.status !== 0, `em-store (T8e): non-zero exit, got status=${r.status} stdout=${(r.stdout || '').slice(0, 200)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-store (T8e): typed envelope, got ${r.stdout}`)
        assert(j.code === 'episode-write-failed:EACCES', `em-store (T8e): code episode-write-failed:EACCES, got ${JSON.stringify(j)}`)
        assert(/episode-file/.test(r.stdout), `em-store (T8e): leg name in message, got ${r.stdout.slice(0, 300)}`)
        const afterEntries = readIndexEntries(indexPath)
        assert(afterEntries.length === beforeEntries.length + 1, `em-store (T8e): index gained exactly one dangling row, before=${beforeEntries.length} after=${afterEntries.length}`)
      } finally { cleanup(world) }
    })
  }
}

{
  const name = 'T8f — em-store with data dir chmod 0555: typed store-lock-failed:EACCES envelope, index byte-unchanged'
  if (IS_ROOT) { skip(name, 'root bypasses permission checks') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const indexPath = path.join(world.localDir, 'index.jsonl')
        const beforeIndex = fs.readFileSync(indexPath, 'utf8')
        fs.chmodSync(world.localDir, 0o555)
        const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
          '--project', 'p651', '--category', 'decision',
          '--summary', 'write-order-t8f', '--body', 'defer3 t8f body',
          '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        fs.chmodSync(world.localDir, 0o755)
        assert(r.signal === null, `em-store (T8f): no signal, got ${r.signal}: ${r.stderr}`)
        assert(r.status !== 0, `em-store (T8f): non-zero exit, got status=${r.status} stdout=${(r.stdout || '').slice(0, 200)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-store (T8f): typed envelope, got ${r.stdout}`)
        assert(j.code === 'store-lock-failed:EACCES', `em-store (T8f): code store-lock-failed:EACCES, got ${JSON.stringify(j)}`)
        const afterIndex = fs.readFileSync(indexPath, 'utf8')
        assert(afterIndex === beforeIndex, 'em-store (T8f): index.jsonl byte-unchanged (aborted before lock/any write)')
      } finally { cleanup(world) }
    })
  }
}

// --- em-revise typed-abort leg (FIFO original body) ---
{
  const name = 'em-revise x FIFO original body -> typed episode-unreadable abort, no supersede written, follow-up revise succeeds'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const episodePath = path.join(world.localDir, 'episodes', `${world.seedId}.md`)
        const indexPath = path.join(world.localDir, 'index.jsonl')
        const beforeIndex = fs.readFileSync(indexPath, 'utf8')
        fs.renameSync(episodePath, `${episodePath}.bak`)
        const mk = spawnSync('mkfifo', [episodePath])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-revise.mjs'), [
          '--original', world.seedId, '--project', 'p651', '--summary', 'fifo-original-revise', '--body', 'body', '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        fs.unlinkSync(episodePath)
        fs.renameSync(`${episodePath}.bak`, episodePath)
        assert(r.signal === null, `em-revise: no signal, got ${r.signal}: ${r.stderr}`)
        assert(r.status === 1, `em-revise: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-revise: typed envelope, got ${r.stdout}`)
        assert(/^episode-unreadable:/.test(j.code || ''), `em-revise: code episode-unreadable:<CODE>, got ${JSON.stringify(j)}`)
        const afterIndex = fs.readFileSync(indexPath, 'utf8')
        assert(afterIndex === beforeIndex, 'em-revise: index.jsonl byte-unchanged (no supersede written)')
        // Follow-up healthy revise succeeds — no lock leak, no lingering damage.
        const retry = run(path.join(SCRIPTS, 'em-revise.mjs'), [
          '--original', world.seedId, '--project', 'p651', '--summary', 'follow-up-revise', '--body', 'body', '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        assert(retry.status === 0, `em-revise retry: exit 0, got ${retry.status}: stdout=${(retry.stdout || '').slice(0, 300)}`)
        const rj = lastJson(retry.stdout)
        assert(rj && rj.status === 'ok', `em-revise retry: status ok, got ${retry.stdout}`)
      } finally { cleanup(world) }
    })
  }
}

// --- em-rebuild-index --check warnings leg (P3-iii) ---
{
  const name = 'em-rebuild-index --check x FIFO episode -> warnings entry present, drift semantics unchanged'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const fifoEpisode = path.join(world.localDir, 'episodes', 'fifo-check-episode.md')
        const mk = spawnSync('mkfifo', [fifoEpisode])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-rebuild-index.mjs'), ['--check', '--scope', 'local'], { cwd: world.proj, home: world.root })
        fs.rmSync(fifoEpisode, { force: true })
        assert(r.signal === null, `em-rebuild-index --check: no signal, got ${r.signal}`)
        assert(r.status === 0, `em-rebuild-index --check: exit 0 (seed episode has no drift), got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'ok', `em-rebuild-index --check: status ok, got ${r.stdout}`)
        assert(Array.isArray(j.drift) && j.drift.length === 0, `em-rebuild-index --check: drift semantics unchanged (empty), got ${JSON.stringify(j.drift)}`)
        // Exactly one warning (the FIFO episode) — kills a warn-on-every-file
        // mutation; the fixture's ONLY other file is the healthy seed episode.
        assert(Array.isArray(j.warnings) && j.warnings.length === 1, `em-rebuild-index --check: exactly one warning, got ${JSON.stringify(j.warnings)}`)
        assert(j.warnings.some(w => w.includes('fifo-check-episode.md')), `em-rebuild-index --check: warnings names the skipped FIFO episode, got ${JSON.stringify(j.warnings)}`)
      } finally { cleanup(world) }
    })
  }
}

// --- em-restore stack-field regression leg (review fix-round item 6) ---
// Cheap construction: a nonexistent --from backup dir fails preflight()
// (plain Error, not IndexUnreadableError) BEFORE any store touch — dry-run
// is the default mode, no --apply/fixture backup needed.
t('em-restore error envelope: nonexistent --from backup dir -> message present, no stack key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-restore-nostack-'))
  try {
    const r = run(path.join(SCRIPTS, 'em-restore.mjs'), ['--from', path.join(root, 'does-not-exist')], { cwd: root, home: root })
    assert(r.signal === null, `em-restore: no signal, got ${r.signal}`)
    assert(r.status === 1, `em-restore: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'error', `em-restore: typed envelope, got ${r.stdout}`)
    assert(typeof j.message === 'string' && j.message.length > 0, `em-restore: message present, got ${JSON.stringify(j)}`)
    assert(!('stack' in j), `em-restore: no stack key on the error payload (S6 Family A), got keys=${JSON.stringify(Object.keys(j))}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// =============================================================================
// em-restore leg: dry-run never reads the target's index.jsonl (mergeIndexes
// only runs on --apply), so a "dry/list mode" leg would be vacuous (identical
// pre-fix/post-fix — nothing to falsify). Substituting an --apply leg against
// a pre-existing, corrupted TARGET index.jsonl, which is the only path that
// reaches loadIndexJsonl. Only shapes that corrupt index.jsonl ITSELF (not the
// whole target dir) are usable: em-restore's preflight independently refuses
// a symlinked target dir (unrelated "is a symlink; refusing" error) and a
// whole-dir-eaccess target still passes preflight's existsSync/isDirectory
// check, then fails later on episode-write EACCES — neither exercises this
// contract, so 'eaccess' and 'parent-dangling' are skipped here with reason.
// =============================================================================
function mkRestoreBackup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-restore-'))
  const backupDir = path.join(root, 'backup')
  fs.mkdirSync(backupDir, { recursive: true })
  const git = (args) => spawnSync('git', args, { cwd: backupDir, encoding: 'utf8' })
  assert(git(['init', '-b', 'main']).status === 0, 'git init failed')
  assert(git(['config', 'user.email', 'test@example.com']).status === 0, 'git config email failed')
  assert(git(['config', 'user.name', 'test']).status === 0, 'git config name failed')
  fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
  const fm = ['---', 'id: id-651-1', 'date: 2026-05-01', 'time: "10:00"', 'project: t', 'category: decision',
    'status: active', 'supersedes: null', 'tags: [x]', 'summary: one', '---', '', '# one', '', 'body\n'].join('\n')
  fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-651-1.md'), fm)
  assert(git(['add', '-A']).status === 0, 'git add failed')
  assert(git(['commit', '-m', 'test']).status === 0, 'git commit failed')
  return { root, backupDir }
}

const RESTORE_SHAPES = ['symloop', 'dangling', 'fifo', 'file000']
for (const shape of ALL_SHAPES) {
  const restoreOk = RESTORE_SHAPES.includes(shape)
  const name = `T3 ${shape} x em-restore --apply -> typed abort`
  const skipReason = shapeSkipReason(shape) || (!restoreOk ? 'target-dir-level shape does not exercise the index.jsonl contract (em-restore preflight refuses/mis-attributes it independently)' : null)
  if (skipReason) { skip(name, skipReason); continue }
  t(name, () => {
    const { root, backupDir } = mkRestoreBackup()
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    const indexPath = path.join(target, 'index.jsonl')
    fs.writeFileSync(indexPath, '')
    try {
      applyShape(shape, indexPath, target)
      const r = run(path.join(SCRIPTS, 'em-restore.mjs'),
        ['--from', backupDir, '--source-map', `lab=${target}`, '--apply'],
        { cwd: root, home: root })
      restoreShape(shape, indexPath, target)
      assert(r.signal === null, `em-restore: no signal, got ${r.signal}`)
      assert(r.status === 1, `em-restore: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 200)}`)
      const j = lastJson(r.stdout)
      assert(j && j.status === 'error', `em-restore: typed envelope, got ${r.stdout}`)
      assert(/episode index unreadable/.test(r.stdout), `em-restore: names the defect, got ${r.stdout.slice(0, 300)}`)
      assert(/index\.jsonl/.test(r.stdout), `em-restore: names index.jsonl, got ${r.stdout.slice(0, 300)}`)
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
}

// =============================================================================
// Second-opinion review round 1 (2026-08-03, verdict REQUEST-CHANGES) —
// revision 3, §7 steps 7c-7f.
// =============================================================================

// --- F1 (step 7d, BLOCKER): em-feedback --scan-text --dry-run raw-read hang ---
{
  const name = 'F1 em-feedback --scan-text --dry-run x fifo -> typed abort (not a hang)'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const indexPath = path.join(world.localDir, 'index.jsonl')
        applyShape('fifo', indexPath, world.localDir)
        const scanFile = path.join(world.root, 'scan.txt')
        fs.writeFileSync(scanFile, `handoff mentions ${world.seedId} in passing\n`)
        const r = run(path.join(SCRIPTS, 'em-feedback.mjs'), ['--scan-text', scanFile, '--scope', 'local', '--dry-run'], { cwd: world.proj, home: world.root })
        restoreShape('fifo', indexPath, world.localDir)
        checkTyped(r, 'em-feedback')
      } finally { cleanup(world) }
    })
  }
}

// --- F2 (step 7c, MAJOR): FIFO archived-index.jsonl hangs mid-transaction ---
function mkPrunableStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-prunable-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(proj)
  const localDir = path.join(proj, '.episodic-memory')
  fs.mkdirSync(path.join(localDir, 'episodes'), { recursive: true })
  // Score = max(0.1, 1 - daysSince/365); daysSince > ~311 days puts score
  // below the default 0.15 prune threshold with access_count 0. A fixed
  // 2025-01-01 date is comfortably past that (roughly 19 months before the
  // 2026-08-03 fixture date this suite otherwise assumes).
  const id = '20250101-000000-prunable-fixture-a1b1'
  const row = { id, date: '2025-01-01', time: '00:00', project: 'p651', category: 'decision', status: 'active', supersedes: null, tags: [], summary: 'prunable fixture', access_count: 0, last_accessed: null }
  fs.writeFileSync(path.join(localDir, 'index.jsonl'), JSON.stringify(row) + '\n')
  fs.writeFileSync(path.join(localDir, 'episodes', `${id}.md`), [
    '---', `id: ${id}`, 'date: 2025-01-01', 'time: "00:00"', 'project: p651', 'category: decision',
    'status: active', 'supersedes: null', 'tags: []', 'summary: prunable fixture', '---', '',
    '# prunable fixture', '', 'body', '',
  ].join('\n'))
  const globalDir = path.join(root, '.episodic-memory')
  fs.mkdirSync(path.join(globalDir, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(globalDir, 'index.jsonl'), '')
  return { root, proj, localDir, globalDir, id }
}

{
  const name = 'F2 em-prune real run: FIFO archived-index.jsonl aborts before any file move'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkPrunableStore()
      try {
        const archivedIndexFile = path.join(world.localDir, 'archived-index.jsonl')
        const mk = spawnSync('mkfifo', [archivedIndexFile])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const episodePath = path.join(world.localDir, 'episodes', `${world.id}.md`)
        assert(fs.existsSync(episodePath), 'precondition: prunable episode file exists')
        const r = run(path.join(SCRIPTS, 'em-prune.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
        assert(r.signal === null, `em-prune: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 1, `em-prune: exit 1, got status=${r.status} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-prune: typed envelope, got ${r.stdout}`)
        assert(/episode index unreadable/.test(r.stdout), `em-prune: names the defect, got ${r.stdout.slice(0, 300)}`)
        assert(/archived-index\.jsonl/.test(r.stdout), `em-prune: names archived-index.jsonl, got ${r.stdout.slice(0, 300)}`)
        assert(!/at .*\.mjs/.test(r.stderr || ''), `em-prune: no raw stack frames on stderr, got ${(r.stderr || '').slice(0, 300)}`)
        assert(fs.existsSync(episodePath), 'episode file must still exist — nothing moved before the abort')
        const archivedDir = path.join(world.localDir, 'archived')
        const archivedCount = fs.existsSync(archivedDir) ? fs.readdirSync(archivedDir).filter(f => f.endsWith('.md')).length : 0
        assert(archivedCount === 0, `archived/ must be empty, got ${archivedCount}`)
      } finally {
        try { fs.rmSync(world.root, { recursive: true, force: true }) } catch {}
      }
    })
  }
}

// --- F4 (step 7e, MINOR): em-topic-tracks misattributes unreadable index ---
{
  const name = 'F4 em-topic-tracks: corrupt GLOBAL index maps to episode-index-unreadable'
  t(name, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-topictracks-'))
    const proj = path.join(root, 'proj')
    fs.mkdirSync(proj)
    const globalDir = path.join(root, '.episodic-memory')
    fs.mkdirSync(globalDir, { recursive: true })
    const indexPath = path.join(globalDir, 'index.jsonl')
    // symloop — the engine's loadIndexRows classifies before reading, same
    // as every other #651 site; any unreadable shape reaches the same catch.
    applyShape('symloop', indexPath, globalDir)
    const configPath = path.join(root, 'topic-tracks-config.json')
    fs.writeFileSync(configPath, JSON.stringify({
      version: '1.0.0', tag_jaccard_min: 0.3, summary_jaccard_min: 0.2, min_cluster: 3,
      warn_episodes: 1000, max_episodes: 2000, common_tag_support: 0.5,
      source_categories: ['decision', 'lesson', 'research'],
    }))
    try {
      // engine only scans global + registered stores (no cwd-local store is
      // registered here), so a corrupt cwd-local index would be unreachable —
      // the corruption must be on GLOBAL_DIR specifically.
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'em-topic-tracks.mjs')], {
        cwd: proj, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HOME: root, USERPROFILE: root, EM_TOPIC_TRACKS_CONFIG_PATH: configPath },
      })
      restoreShape('symloop', indexPath, globalDir)
      assert(r.signal === null, `em-topic-tracks: no signal, got ${r.signal}`)
      assert(r.status === 1, `em-topic-tracks: exit 1, got ${r.status}: stdout=${r.stdout} stderr=${r.stderr}`)
      const j = lastJson(r.stdout)
      assert(j && j.status === 'error', `typed envelope, got ${r.stdout}`)
      assert(j.error === 'episode-index-unreadable', `expected error code "episode-index-unreadable", got ${JSON.stringify(j)}`)
      assert(typeof j.detail === 'string' && /episode index unreadable/.test(j.detail), `detail names the defect, got ${JSON.stringify(j)}`)
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
}

// =============================================================================
// Second-opinion review round 2 (2026-08-03, verdict REQUEST-CHANGES ->
// ACCEPT after fix) — revision 4, §11 F2b.
// =============================================================================

// --- F2b: em-consolidate archived-index abort misnamed index.jsonl ---
function mkChainStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em651-chain-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(proj)
  const localDir = path.join(proj, '.episodic-memory')
  fs.mkdirSync(path.join(localDir, 'episodes'), { recursive: true })
  // Linear 2-member supersedes chain (min-chain 2): idOld is superseded by
  // idNew, which is the chain terminal (no successor) — foldStore folds
  // idOld (status:superseded, unprotected) and keeps idNew.
  const idOld = '20250101-000000-chain-old-a1a1'
  const idNew = '20250102-000000-chain-new-b2b2'
  const rowOld = { id: idOld, date: '2025-01-01', time: '00:00', project: 'p651', category: 'decision', status: 'superseded', supersedes: null, superseded_by: idNew, tags: [], summary: 'chain old' }
  const rowNew = { id: idNew, date: '2025-01-02', time: '00:00', project: 'p651', category: 'decision', status: 'active', supersedes: idOld, tags: [], summary: 'chain new' }
  fs.writeFileSync(path.join(localDir, 'index.jsonl'), JSON.stringify(rowOld) + '\n' + JSON.stringify(rowNew) + '\n')
  for (const [id, fm] of [[idOld, rowOld], [idNew, rowNew]]) {
    fs.writeFileSync(path.join(localDir, 'episodes', `${id}.md`), [
      '---', `id: ${id}`, `date: ${fm.date}`, `time: "${fm.time}"`, `project: ${fm.project}`, `category: ${fm.category}`,
      `status: ${fm.status}`, `supersedes: ${fm.supersedes || 'null'}`,
      ...(fm.superseded_by ? [`superseded_by: ${fm.superseded_by}`] : []),
      'tags: []', `summary: ${fm.summary}`, '---', '', `# ${fm.summary}`, '', 'body', '',
    ].join('\n'))
  }
  const globalDir = path.join(root, '.episodic-memory')
  fs.mkdirSync(path.join(globalDir, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(globalDir, 'index.jsonl'), '')
  return { root, proj, localDir, globalDir, idOld, idNew }
}

{
  const name = 'F2b em-consolidate --fold-superseded real run: FIFO archived-index.jsonl abort names archived-index.jsonl, not index.jsonl'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkChainStore()
      try {
        const archivedIndexFile = path.join(world.localDir, 'archived-index.jsonl')
        const primaryIndexFile = path.join(world.localDir, 'index.jsonl')
        const mk = spawnSync('mkfifo', [archivedIndexFile])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const oldEpisodePath = path.join(world.localDir, 'episodes', `${world.idOld}.md`)
        assert(fs.existsSync(oldEpisodePath), 'precondition: chain-old episode file exists')
        const r = run(path.join(SCRIPTS, 'em-consolidate.mjs'), ['--fold-superseded', '--min-chain', '2', '--scope', 'local'], { cwd: world.proj, home: world.root })
        assert(r.signal === null, `em-consolidate: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 1, `em-consolidate: exit 1, got status=${r.status} stdout=${(r.stdout || '').slice(0, 200)} stderr=${(r.stderr || '').slice(0, 200)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-consolidate: typed envelope, got ${r.stdout}`)
        assert(/archived-index\.jsonl/.test(r.stdout), `em-consolidate: names archived-index.jsonl, got ${r.stdout.slice(0, 300)}`)
        assert(!r.stdout.includes(primaryIndexFile), `em-consolidate: must NOT name the primary index.jsonl as the broken file, got ${r.stdout.slice(0, 300)}`)
        assert(r.stdout.includes(archivedIndexFile), `em-consolidate: must name archived-index.jsonl by full path, got ${r.stdout.slice(0, 300)}`)
        assert(!/at .*\.mjs/.test(r.stderr || ''), `em-consolidate: no raw stack frames on stderr, got ${(r.stderr || '').slice(0, 300)}`)
        assert(fs.existsSync(oldEpisodePath), 'chain-old episode file must still exist — nothing moved before the abort')
        const archivedDir = path.join(world.localDir, 'archived')
        assert(!fs.existsSync(archivedDir), `archived/ must not exist (abort precedes its creation), got present: ${fs.existsSync(archivedDir)}`)
      } finally {
        try { fs.rmSync(world.root, { recursive: true, force: true }) } catch {}
      }
    })
  }
}

// =============================================================================
// Issue #649/#653 additions (docs/plans/fix-649-653.md §7 S7). Reuses the
// fixtures/helpers above (mkStore, applyShape, run, lastJson, checkTyped).
// =============================================================================

// -----------------------------------------------------------------------
// D1 interleave (§7 S7 bullet 1): classify-ok -> swap-to-FIFO -> the NEW
// fd-based reader must still typed-abort ENOTREG, never hang. Mirrors the
// toctou-child.mjs harness used to prove D1 pre-fix: a throwaway child
// process imports the CURRENT working tree's index-state.mjs, classifies
// while the file is REGULAR (sanity precondition), swaps it to a FIFO, then
// calls openReadableIndex — under a spawnSync hard-kill timeout so a
// regression fails as a timeout-kill, never a stuck test run. Because
// openReadableIndex does ONE open()+fstat() on a single fd (no separate
// classify-then-path-read pair), this is strictly harder than the pre-fix
// race: the swap is already complete before the reader is even called, yet
// it still resolves instantly.
// -----------------------------------------------------------------------
{
  const name = 'D1 interleave: classify-ok -> swap-FIFO -> openReadableIndex -> typed ENOTREG (not a hang)'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em653-d1-'))
      const indexPath = path.join(dir, 'index.jsonl')
      fs.writeFileSync(indexPath, '{"id":"x"}\n')
      const indexStatePath = path.join(SCRIPTS, 'lib', 'index-state.mjs')
      const childPath = path.join(dir, 'child.mjs')
      fs.writeFileSync(childPath, [
        `import fs from 'node:fs'`,
        `import { spawnSync } from 'node:child_process'`,
        `import { classifyIndexFile, openReadableIndex } from ${JSON.stringify(indexStatePath)}`,
        `const p = ${JSON.stringify(indexPath)}`,
        `const cls = classifyIndexFile(fs, p)`,
        `if (cls.state !== 'ok') { console.log(JSON.stringify({ step: 'abort', reason: 'precondition failed', cls })); process.exit(2) }`,
        `fs.rmSync(p, { force: true })`,
        `const mk = spawnSync('mkfifo', [p])`,
        `if (mk.status !== 0) { console.log(JSON.stringify({ step: 'abort', reason: 'mkfifo failed' })); process.exit(2) }`,
        `try {`,
        `  const raw = openReadableIndex(fs, p)`,
        `  console.log(JSON.stringify({ step: 'unexpected-ok', raw }))`,
        `} catch (e) {`,
        `  console.log(JSON.stringify({ step: 'typed-abort', code: e.code, message: e.message }))`,
        `}`,
      ].join('\n'))
      const r = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' })
      fs.rmSync(dir, { recursive: true, force: true })
      assert(r.signal === null, `D1 interleave: no signal (timeout/kill) — got ${r.signal} (this is the falsifiability failure mode against an unfixed two-step classify-then-read)`)
      assert(r.status === 0, `D1 interleave: child exit 0, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)} stderr=${(r.stderr || '').slice(0, 300)}`)
      const j = JSON.parse((r.stdout || '').trim().split('\n').pop())
      assert(j.step === 'typed-abort', `D1 interleave: expected typed-abort, got ${JSON.stringify(j)}`)
      assert(j.code === 'ENOTREG', `D1 interleave: expected code ENOTREG, got ${JSON.stringify(j)}`)
    })
  }
}

// -----------------------------------------------------------------------
// Static-FIFO legs (§7 S7 bullet 2 / §5 V2). No race needed — these hang
// (or misbehave) on unpatched HEAD because the read sites were either fully
// unguarded (em-store/em-revise's sidecar writers, em-rebuild-index's
// episode-file reads, em-semantic's embeddings loader) or had the D1
// classify-then-separately-read gap (relevance.mjs's advisory loaders).
// -----------------------------------------------------------------------

// em-search x FIFO tags.json/tokens.json/category-index.json -> ok+warning,
// no hang (advisory degrade surface; #653 S2).
{
  const cases = [
    { file: 'tags.json', args: ['--tag', 'x'] },
    { file: 'category-index.json', args: ['--category', 'decision'] },
    { file: 'tokens.json', args: ['--query', 'seed'] },
  ]
  for (const { file, args } of cases) {
    const name = `em-search x FIFO ${file} -> ok+warning, no hang`
    if (IS_WIN) { skip(name, 'mkfifo unavailable on win32'); continue }
    t(name, () => {
      const world = mkStore()
      try {
        const sidecarPath = path.join(world.localDir, file)
        fs.rmSync(sidecarPath, { force: true })
        const mk = spawnSync('mkfifo', [sidecarPath])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-search.mjs'), ['--scope', 'local', '--no-track', ...args], { cwd: world.proj, home: world.root })
        assert(r.signal === null, `em-search: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 0, `em-search: exit 0, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)} stderr=${(r.stderr || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'ok', `em-search: status ok, got ${r.stdout}`)
        assert(typeof j.warning === 'string' && j.warning.length > 0, `em-search: degrade warning present, got ${r.stdout}`)
      } finally { cleanup(world) }
    })
  }
}

// em-store x FIFO tags.json -> typed abort, episode count unchanged (zero
// partial state — #653 S3 preflight, before lock/any write).
{
  const name = 'em-store x FIFO tags.json -> typed abort, zero partial state'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const tagsFile = path.join(world.localDir, 'tags.json')
        const indexPath = path.join(world.localDir, 'index.jsonl')
        const beforeIndex = fs.readFileSync(indexPath, 'utf8')
        const beforeEpisodeCount = fs.readdirSync(path.join(world.localDir, 'episodes')).length
        fs.rmSync(tagsFile, { force: true })
        const mk = spawnSync('mkfifo', [tagsFile])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
          '--project', 'p651', '--category', 'decision', '--summary', 'fifo-tags', '--body', 'body', '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        fs.rmSync(tagsFile, { force: true })
        assert(r.signal === null, `em-store: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 1, `em-store: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-store: typed envelope, got ${r.stdout}`)
        assert(/tags index unreadable/.test(r.stdout), `em-store: names tags index, got ${r.stdout.slice(0, 300)}`)
        assert(j.code === 'index-unreadable:ENOTREG', `em-store: code index-unreadable:ENOTREG, got ${JSON.stringify(j)}`)
        const afterEpisodeCount = fs.readdirSync(path.join(world.localDir, 'episodes')).length
        assert(afterEpisodeCount === beforeEpisodeCount, `em-store: no episode file written, before=${beforeEpisodeCount} after=${afterEpisodeCount}`)
        const afterIndex = fs.readFileSync(indexPath, 'utf8')
        assert(afterIndex === beforeIndex, 'em-store: index.jsonl byte-unchanged (preflight aborted before lock/any write)')
      } finally { cleanup(world) }
    })
  }
}

// em-revise x FIFO tags.json AND x FIFO index.jsonl -> typed abort, original
// episode + index untouched (#653 S3R preflight, before lock/any write).
{
  const reviseCases = [
    { label: 'tags.json', file: 'tags.json', roleRe: /tags index unreadable/ },
    { label: 'index.jsonl', file: 'index.jsonl', roleRe: /episode index unreadable/ },
  ]
  for (const { label, file, roleRe } of reviseCases) {
    const name = `em-revise x FIFO ${label} -> typed abort, original untouched`
    if (IS_WIN) { skip(name, 'mkfifo unavailable on win32'); continue }
    t(name, () => {
      const world = mkStore()
      try {
        const target = path.join(world.localDir, file)
        const episodePath = path.join(world.localDir, 'episodes', `${world.seedId}.md`)
        const indexPath = path.join(world.localDir, 'index.jsonl')
        const beforeEpisode = fs.readFileSync(episodePath, 'utf8')
        const beforeIndex = fs.readFileSync(indexPath, 'utf8')
        fs.rmSync(target, { force: true })
        const mk = spawnSync('mkfifo', [target])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-revise.mjs'), [
          '--original', world.seedId, '--project', 'p651', '--summary', 'fifo-revise', '--body', 'body', '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        fs.rmSync(target, { force: true })
        assert(r.signal === null, `em-revise: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 1, `em-revise: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-revise: typed envelope, got ${r.stdout}`)
        assert(roleRe.test(r.stdout), `em-revise: names ${label}, got ${r.stdout.slice(0, 300)}`)
        assert(j.code === 'index-unreadable:ENOTREG', `em-revise: code index-unreadable:ENOTREG, got ${JSON.stringify(j)}`)
        const afterEpisode = fs.readFileSync(episodePath, 'utf8')
        assert(afterEpisode === beforeEpisode, `em-revise (${label}): original episode file byte-unchanged`)
        const afterIndex = file === 'index.jsonl' ? null : fs.readFileSync(indexPath, 'utf8')
        if (afterIndex !== null) assert(afterIndex === beforeIndex, `em-revise (${label}): index.jsonl byte-unchanged`)
      } finally { cleanup(world) }
    })
  }
}

// em-rebuild-index x FIFO episodes/*.md -> completes with a warning, never
// hangs (#653 S4: the remediation tool must never hang on the disease it
// repairs).
{
  const name = 'em-rebuild-index x FIFO episodes/*.md -> completes with warning, no hang'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const fifoEpisode = path.join(world.localDir, 'episodes', 'fifo-episode.md')
        const mk = spawnSync('mkfifo', [fifoEpisode])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-rebuild-index.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
        assert(r.signal === null, `em-rebuild-index: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 0, `em-rebuild-index: exit 0, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)} stderr=${(r.stderr || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'ok', `em-rebuild-index: status ok, got ${r.stdout}`)
        const localScope = j.rebuilt.find(x => x.scope === 'local')
        assert(localScope && Array.isArray(localScope.warnings) && localScope.warnings.some(w => w.includes('fifo-episode.md')), `em-rebuild-index: warnings names the skipped FIFO episode, got ${JSON.stringify(localScope)}`)
        assert(localScope.count === 1, `em-rebuild-index: the FIFO episode is excluded from count (only the seed episode), got ${JSON.stringify(localScope)}`)
      } finally { cleanup(world) }
    })
  }
}

// em-semantic x FIFO embeddings.jsonl -> degrade (advisory sidecar, #653
// S2), no hang, no index-unreadable envelope — loadEmbeddings treats a
// non-regular sidecar exactly like an absent one.
{
  const name = 'em-semantic x FIFO embeddings.jsonl -> degrade (no sidecar), no hang'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const embed = run(path.join(SCRIPTS, 'em-embed.mjs'), ['--scope', 'local', '--provider', 'hash'], { cwd: world.proj, home: world.root })
        assert(embed.status === 0, `em-embed seed failed: ${embed.stderr}`)
        const sidecar = path.join(world.localDir, 'embeddings.jsonl')
        assert(fs.existsSync(sidecar), 'precondition: embeddings sidecar exists')
        fs.rmSync(sidecar, { force: true })
        const mk = spawnSync('mkfifo', [sidecar])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-semantic.mjs'), ['--query', 'seed', '--scope', 'local', '--no-track'], { cwd: world.proj, home: world.root })
        fs.rmSync(sidecar, { force: true })
        assert(r.signal === null, `em-semantic: no signal (timeout/kill), got ${r.signal}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-semantic: typed JSON, got ${r.stdout}`)
        assert(/No embeddings sidecar found/.test(j.message || ''), `em-semantic: degrades to "no sidecar", NOT an index-unreadable abort, got ${r.stdout}`)
      } finally { cleanup(world) }
    })
  }
}

// em-doctor x FIFO installs.json (fake HOME) -> report row, exit != hang
// (#653 S2: registry readers classify before read; em-doctor never aborts).
// #649/#653 review FIX-D (P2-1): tightened past "no hang, no crash" — the
// installs-drift row must be a WARN carrying a typed code, not indistinguishable
// from a genuinely absent/empty registry ("ok" — the pre-fix defect).
{
  const name = 'em-doctor x FIFO installs.json -> warn row with code (not "ok")'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em653-doctor-'))
      const proj = path.join(root, 'proj')
      fs.mkdirSync(proj)
      const globalDir = path.join(root, '.episodic-memory')
      fs.mkdirSync(globalDir, { recursive: true })
      const installsFile = path.join(globalDir, 'installs.json')
      const mk = spawnSync('mkfifo', [installsFile])
      assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
      try {
        // --scope global (not local): checkInstallsDrift, which reads
        // installs.json, only runs for scope global|all — a local-scope
        // run would never touch the FIFO at all and pass trivially.
        const r = run(path.join(SCRIPTS, 'em-doctor.mjs'), ['--scope', 'global'], { cwd: proj, home: root })
        assert(r.signal === null, `em-doctor: no signal (timeout/kill), got ${r.signal}`)
        assert([0, 1, 2].includes(r.status), `em-doctor: a real exit code (no crash), got ${r.status}: stderr=${(r.stderr || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && Array.isArray(j.checks) && j.summary, `em-doctor: report shape present (never aborts), got ${(r.stdout || '').slice(0, 300)}`)
        assert(!/at .*\.mjs/.test(r.stderr || ''), `em-doctor: no raw stack frames on stderr, got ${(r.stderr || '').slice(0, 300)}`)
        const row = j.checks.find(c => c.id === 'installs-drift')
        assert(row, `em-doctor: installs-drift row present, got ${JSON.stringify(j.checks.map(c => c.id))}`)
        assert(row.level === 'warn', `em-doctor: installs-drift is warn (a defect, not indistinguishable from an absent/empty registry), got ${JSON.stringify(row)}`)
        assert(row.code === 'index-unreadable:ENOTREG', `em-doctor: installs-drift carries code index-unreadable:ENOTREG, got ${JSON.stringify(row)}`)
      } finally {
        try { fs.rmSync(installsFile, { force: true }) } catch {}
        try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
      }
    })
  }
}

// -----------------------------------------------------------------------
// PARITY leg (§7 S7 bullet 3, audit F3 — end-to-end, not classify-vs-open):
// for every shape, the OLD contract's outcome (assertReadableIndex classify,
// then a separate read) and the NEW contract's outcome (openReadableIndex,
// one fd) agree — both degrade the same way, and both type the same .code.
// file000 is the probe-pinned case: classify alone says 'ok' there (chmod
// doesn't change st.isFile()), but BOTH the old separate-read and the new
// fd-based read must surface EACCES end-to-end.
// -----------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em653-parity-'))

  function oldStyleRead(filePath) {
    // Reference "old" contract: classify (lstat-only), then a SEPARATE
    // path-based read — exactly index-state.mjs's pre-#653 shape.
    const state = assertReadableIndex(fs, filePath) // throws IndexUnreadableError on 'unreadable'
    if (state === 'absent') return null
    try { return fs.readFileSync(filePath, 'utf8') } catch (e) {
      throw new IndexUnreadableError(filePath, (e && e.code) || 'UNKNOWN', 'read failed')
    }
  }

  function outcomeOf(fn, filePath) {
    try { return { ok: true, value: fn(filePath) } } catch (e) {
      if (e instanceof IndexUnreadableError) return { ok: false, code: e.code }
      throw e
    }
  }

  const PARITY_SHAPES = [...ALL_SHAPES, 'symlink-to-fifo', 'symlink-to-dir']
  for (const shape of PARITY_SHAPES) {
    const skipReason = (shape === 'eaccess' || shape === 'symlink-to-fifo') && IS_ROOT ? 'root bypasses permission checks'
      : (shape === 'fifo' || shape === 'symlink-to-fifo') && IS_WIN ? 'mkfifo unavailable on win32'
      : null
    const name = `PARITY ${shape}: old classify+read outcome === new fd-based outcome`
    if (skipReason) { skip(name, skipReason); continue }
    t(name, () => {
      // Each shape gets its OWN isolated subdirectory — 'parent-dangling'
      // rmSync's + replaces storeDir itself, which must never be the shared
      // parity root (that would corrupt every other shape sharing it).
      const shapeDir = path.join(dir, shape)
      fs.rmSync(shapeDir, { recursive: true, force: true })
      fs.mkdirSync(shapeDir, { recursive: true })
      const p = path.join(shapeDir, 'index.jsonl')
      const targetDir = path.join(shapeDir, 'target-dir')
      try {
        if (shape === 'symlink-to-fifo') {
          const fifoTarget = path.join(shapeDir, 'fifo-target')
          const mk = spawnSync('mkfifo', [fifoTarget])
          assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
          fs.symlinkSync(fifoTarget, p)
        } else if (shape === 'symlink-to-dir') {
          fs.mkdirSync(targetDir)
          fs.symlinkSync(targetDir, p)
        } else {
          applyShape(shape, p, shapeDir)
        }
        const oldOutcome = outcomeOf(oldStyleRead, p)
        const newOutcome = outcomeOf((fp) => openReadableIndex(fs, fp), p)
        assert(oldOutcome.ok === newOutcome.ok, `PARITY ${shape}: ok-ness matches, old=${JSON.stringify(oldOutcome)} new=${JSON.stringify(newOutcome)}`)
        if (!oldOutcome.ok) {
          assert(oldOutcome.code === newOutcome.code, `PARITY ${shape}: .code matches, old=${oldOutcome.code} new=${newOutcome.code}`)
        } else {
          assert(oldOutcome.value === newOutcome.value, `PARITY ${shape}: content matches`)
        }
      } finally {
        try { restoreShape(shape, p, shapeDir) } catch {}
        try { fs.chmodSync(p, 0o644) } catch {}
        try { fs.rmSync(shapeDir, { recursive: true, force: true }) } catch {}
      }
    })
  }

  // file000 probe-pin: classify ALONE says 'ok' (chmod doesn't change
  // st.isFile()); both end-to-end paths must surface EACCES.
  t('PARITY file000: classify alone says ok; both end-to-end paths yield EACCES', () => {
    if (IS_ROOT) { skip('PARITY file000 probe-pin', 'root bypasses permission checks'); return }
    const p = path.join(dir, 'parity-file000-probe.jsonl')
    fs.writeFileSync(p, FILE000_FIXTURE_CONTENT)
    fs.chmodSync(p, 0o000)
    try {
      const cls = classifyIndexFile(fs, p)
      assert(cls.state === 'ok', `classify alone says ok (permission bits are invisible to lstat type checks), got ${JSON.stringify(cls)}`)
      const oldOutcome = outcomeOf(oldStyleRead, p)
      const newOutcome = outcomeOf((fp) => openReadableIndex(fs, fp), p)
      assert(!oldOutcome.ok && oldOutcome.code === 'EACCES', `old end-to-end: EACCES, got ${JSON.stringify(oldOutcome)}`)
      assert(!newOutcome.ok && newOutcome.code === 'EACCES', `new end-to-end: EACCES, got ${JSON.stringify(newOutcome)}`)
    } finally {
      try { fs.chmodSync(p, 0o644) } catch {}
      try { fs.rmSync(p, { force: true }) } catch {}
    }
  })

  fs.rmSync(dir, { recursive: true, force: true })
}

// -----------------------------------------------------------------------
// Envelope sweep (§7 S7 bullet 4, audit F9): runtime legs — a directory-
// shaped index.jsonl -> code === 'index-unreadable:EISDIR' + message regex
// + exit 1, for every reader plus the two writers plus em-rebuild-index.
// Static grep-pin: every known Family-A emission site's source carries the
// `code` field.
// -----------------------------------------------------------------------
const ENVELOPE_SWEEP_TOOLS = [
  { name: 'em-search', script: 'em-search.mjs', args: ['--scope', 'local', '--no-track'] },
  { name: 'em-recall', script: 'em-recall.mjs', args: ['--scope', 'local', '--no-track'] },
  { name: 'em-list', script: 'em-list.mjs', args: ['--scope', 'local'] },
  { name: 'em-check-stale', script: 'em-check-stale.mjs', args: ['--scope', 'local'] },
  { name: 'em-graph', script: 'em-graph.mjs', args: ['--orphans', '--scope', 'local'] },
  { name: 'em-stats', script: 'em-stats.mjs', args: ['--scope', 'local'] },
  { name: 'em-rebuild-index', script: 'em-rebuild-index.mjs', args: ['--scope', 'local'] },
]
for (const { name, script, args } of ENVELOPE_SWEEP_TOOLS) {
  t(`envelope sweep: ${name} x EISDIR index -> code index-unreadable:EISDIR`, () => {
    const world = mkStore()
    try {
      const indexPath = path.join(world.localDir, 'index.jsonl')
      fs.rmSync(indexPath, { force: true })
      fs.mkdirSync(indexPath)
      const r = run(path.join(SCRIPTS, script), args, { cwd: world.proj, home: world.root })
      fs.rmdirSync(indexPath)
      assert(r.signal === null, `${name}: no signal, got ${r.signal}`)
      assert(r.status === 1, `${name}: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
      const j = lastJson(r.stdout)
      assert(j && j.status === 'error', `${name}: typed envelope, got ${r.stdout}`)
      assert(/unreadable \(EISDIR\)/.test(r.stdout), `${name}: message names EISDIR, got ${r.stdout.slice(0, 300)}`)
      assert(j.code === 'index-unreadable:EISDIR', `${name}: code index-unreadable:EISDIR, got ${JSON.stringify(j)}`)
    } finally { cleanup(world) }
  })
}
// em-semantic needs a query + sidecar to reach the index read at all.
t('envelope sweep: em-semantic x EISDIR index -> code index-unreadable:EISDIR', () => {
  const world = mkStore()
  try {
    const embed = run(path.join(SCRIPTS, 'em-embed.mjs'), ['--scope', 'local', '--provider', 'hash'], { cwd: world.proj, home: world.root })
    assert(embed.status === 0, `em-embed seed failed: ${embed.stderr}`)
    const indexPath = path.join(world.localDir, 'index.jsonl')
    fs.rmSync(indexPath, { force: true })
    fs.mkdirSync(indexPath)
    const r = run(path.join(SCRIPTS, 'em-semantic.mjs'), ['--query', 'seed', '--scope', 'local', '--no-track'], { cwd: world.proj, home: world.root })
    fs.rmdirSync(indexPath)
    assert(r.signal === null, `em-semantic: no signal, got ${r.signal}`)
    assert(r.status === 1, `em-semantic: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
    const j = lastJson(r.stdout)
    assert(j && j.status === 'error' && j.code === 'index-unreadable:EISDIR', `em-semantic: code index-unreadable:EISDIR, got ${JSON.stringify(j)}`)
  } finally { cleanup(world) }
})
// em-store / em-revise: EISDIR index -> preflight abort, code carried.
t('envelope sweep: em-store x EISDIR index -> code index-unreadable:EISDIR', () => {
  const world = mkStore()
  try {
    const indexPath = path.join(world.localDir, 'index.jsonl')
    fs.rmSync(indexPath, { force: true })
    fs.mkdirSync(indexPath)
    const r = run(path.join(SCRIPTS, 'em-store.mjs'), ['--project', 'p651', '--category', 'decision', '--summary', 'x', '--body', 'x', '--scope', 'local'], { cwd: world.proj, home: world.root })
    fs.rmdirSync(indexPath)
    assert(r.status === 1 && r.signal === null, `em-store: exit 1 no signal, got status=${r.status} signal=${r.signal}`)
    const j = lastJson(r.stdout)
    assert(j && j.code === 'index-unreadable:EISDIR', `em-store: code index-unreadable:EISDIR, got ${JSON.stringify(j)}`)
  } finally { cleanup(world) }
})
t('envelope sweep: em-revise x EISDIR index -> code index-unreadable:EISDIR', () => {
  const world = mkStore()
  try {
    const indexPath = path.join(world.localDir, 'index.jsonl')
    fs.rmSync(indexPath, { force: true })
    fs.mkdirSync(indexPath)
    const r = run(path.join(SCRIPTS, 'em-revise.mjs'), ['--original', world.seedId, '--project', 'p651', '--summary', 'x', '--body', 'x', '--scope', 'local'], { cwd: world.proj, home: world.root })
    fs.rmdirSync(indexPath)
    assert(r.status === 1 && r.signal === null, `em-revise: exit 1 no signal, got status=${r.status} signal=${r.signal}`)
    const j = lastJson(r.stdout)
    assert(j && j.code === 'index-unreadable:EISDIR', `em-revise: code index-unreadable:EISDIR, got ${JSON.stringify(j)}`)
  } finally { cleanup(world) }
})

// Static grep-pin: every known Family-A emission site's source carries the
// `code` field (regression guard against a future edit silently dropping
// it). One occurrence of the literal marker per file is sufficient — this
// pins the KNOWN S5 sweep set, not a live re-discovery of new sites.
t('static grep-pin: every known Family-A emission site carries `code`', () => {
  const CODE_BEARING_FILES = [
    'em-search.mjs', 'em-recall.mjs', 'em-list.mjs', 'em-check-stale.mjs', 'em-graph.mjs',
    'em-semantic.mjs', 'em-stats.mjs', 'em-store.mjs', 'em-revise.mjs', 'em-promote.mjs',
    'em-topic-tracks.mjs', 'em-rebuild-index.mjs', 'em-prune.mjs', 'em-restore.mjs',
    'em-seed-patterns.mjs', 'em-watch-codex.mjs', 'em-workflow-validate.mjs',
    'em-review-request.mjs', 'em-pattern-health.mjs', 'em-move.mjs', 'em-feedback.mjs', 'em-doctor.mjs',
    'em-pin.mjs', 'em-violation.mjs', // FIX-E/FIX-A (fix round 2)
  ]
  const missing = []
  for (const f of CODE_BEARING_FILES) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8')
    if (!/code:?\s*[=]?\s*`index-unreadable:/.test(src)) missing.push(f)
  }
  assert(missing.length === 0, `every Family-A site carries code, missing from: ${missing.join(', ')}`)
  for (const f of ['em-search.mjs', 'em-list.mjs', 'em-check-stale.mjs']) {
    const src = fs.readFileSync(path.join(PLUGIN_SCRIPTS, f), 'utf8')
    assert(/code:\s*`index-unreadable:/.test(src), `vendored ${f} carries code`)
  }
})

// -----------------------------------------------------------------------
// Lock-release leg (§7 S7 bullet 5, audit F6): a TOCTOU swap DURING the
// held lock (not caught by the preflight, which already passed while the
// file was still regular) still emits the typed envelope, releases the
// lock (no stale lock file left behind), and an immediate retry succeeds.
// Deterministic construction (no real race): a background holder process
// owns the lock first; em-store is spawned WHILE tags.json is still regular
// (so its preflight passes and it blocks waiting for the held lock) — ONLY
// THEN does the test swap tags.json to a FIFO and release the holder, so the
// swap lands strictly after preflight and strictly before the in-lock read
// (#649/#653 review FIX-B: the original leg swapped BEFORE spawning em-store,
// which only re-exercised the pre-lock preflight — a mutation deleting the
// in-lock catch's explicit lock release survived the whole suite under that
// ordering; this leg is the fix, see the mutation-kill proof in the report).
// -----------------------------------------------------------------------
{
  const name = 'F6 lock-release: TOCTOU swap of tags.json mid-lock (post-spawn) aborts typed; lock released; immediate retry succeeds'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const dataDir = world.localDir
        const tagsFile = path.join(dataDir, 'tags.json')
        fs.writeFileSync(tagsFile, JSON.stringify({}))
        // store-write-lock.mjs realpaths dataDir before placing the lock
        // file (canonicalizeAndSort) — macOS's os.tmpdir() is itself a
        // symlink (/tmp -> /private/tmp), so the lock's actual location can
        // differ from the literal world.localDir spelling.
        const lockPath = path.join(fs.realpathSync(dataDir), 'clerk-apply.lock')

        const holderPath = path.join(world.root, 'lock-holder.mjs')
        const lockLibPath = path.join(SCRIPTS, 'lib', 'store-write-lock.mjs')
        const readySignal = path.join(world.root, 'ready.signal')
        const releaseSignal = path.join(world.root, 'release.signal')
        fs.writeFileSync(holderPath, [
          `import fs from 'node:fs'`,
          `import { acquireStoreWriteLocksSync, releaseStoreWriteLocks } from ${JSON.stringify(lockLibPath)}`,
          `const dataDir = ${JSON.stringify(dataDir)}`,
          `const r = acquireStoreWriteLocksSync(dataDir)`,
          `if (!r.ok) { fs.writeFileSync(${JSON.stringify(readySignal)}, 'FAILED'); process.exit(1) }`,
          `fs.writeFileSync(${JSON.stringify(readySignal)}, 'HELD')`,
          `const deadline = Date.now() + 10000`,
          `while (!fs.existsSync(${JSON.stringify(releaseSignal)}) && Date.now() < deadline) {`,
          `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`,
          `}`,
          `releaseStoreWriteLocks(r.handles)`,
          `process.exit(0)`,
        ].join('\n'))

        const holder = spawn(process.execPath, [holderPath], { stdio: 'ignore' })
        holder.unref()
        const gotLock = waitForFileSync(readySignal, 5000)
        assert(gotLock, 'lock holder signaled within 5s')
        assert(fs.readFileSync(readySignal, 'utf8') === 'HELD', 'lock holder actually acquired the lock (not FAILED)')
        assert(fs.existsSync(lockPath), 'lock file present while held')

        // Spawn em-store NOW, while tags.json is STILL a regular file — its
        // preflight (classify index+tags+category+tokens, all still
        // healthy) passes, and it then blocks inside
        // acquireStoreWriteLocksSync waiting for the holder above to
        // release. Run via a shell wrapper that redirects stdout/stderr to
        // FILES and writes the exit code to a marker file — progress is
        // polled via fs.existsSync, NOT via 'exit'/'data' event listeners:
        // sleepSync's Atomics.wait blocks this thread's event loop
        // synchronously, so an event-driven wait would deadlock (the 'exit'
        // callback could never fire while we are inside the busy loop
        // waiting for it).
        const outPath = path.join(world.root, 'em-store.stdout')
        const errPath = path.join(world.root, 'em-store.stderr')
        const exitPath = path.join(world.root, 'em-store.exitcode')
        const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
        const emStoreArgs = [
          path.join(SCRIPTS, 'em-store.mjs'), '--project', 'p651', '--category', 'decision',
          '--summary', 'f6-lock-release', '--body', 'body', '--scope', 'local',
        ]
        const shellCmd = `${shQuote(process.execPath)} ${emStoreArgs.map(shQuote).join(' ')} > ${shQuote(outPath)} 2> ${shQuote(errPath)}; echo $? > ${shQuote(exitPath)}`
        const storeProc = spawn('/bin/sh', ['-c', shellCmd], {
          cwd: world.proj, env: { ...process.env, HOME: world.root, USERPROFILE: world.root }, stdio: 'ignore',
        })
        storeProc.unref()

        // Give em-store a moment to run its (fast, lstat-only) preflight and
        // reach the lock-wait poll loop — well before the holder's own 10s
        // deadline, and well before we release it below. Poll-verify it is
        // actually still alive (still blocked) rather than trusting a fixed
        // sleep: if it already exited, the ordering assumption failed and
        // the leg must not silently pass on the WRONG code path.
        sleepSync(300)
        function isAlive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
        assert(isAlive(storeProc.pid), 'em-store is still blocked on the held lock 300ms after spawn (preflight passed, has not aborted yet)')
        assert(!fs.existsSync(exitPath), 'em-store has not exited yet — still waiting on the lock, not already aborted at the preflight')

        // NOW swap tags.json -> FIFO. This lands strictly after em-store's
        // preflight (already passed, or it would have exited above) and
        // strictly before the in-lock read (blocked on the lock, has not
        // acquired it yet) — the exact interleave F6 exists to cover.
        fs.rmSync(tagsFile, { force: true })
        const mk = spawnSync('mkfifo', [tagsFile])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)

        // Release the holder — em-store acquires the lock immediately after
        // and hits the FIFO on its in-lock updateTagsIndex read.
        fs.writeFileSync(releaseSignal, '1')

        const finished = waitForFileSync(exitPath, 10000)
        assert(finished, `em-store exited within 10s (no signal/timeout-kill)`)
        const exitCode = Number(fs.readFileSync(exitPath, 'utf8').trim())
        const stdout = fs.readFileSync(outPath, 'utf8')
        const stderr = fs.readFileSync(errPath, 'utf8')
        assert(exitCode === 1, `em-store: exit 1, got ${exitCode}: stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`)
        const j = lastJson(stdout)
        // Post-FIX-C: the in-lock catch derives the role from e.file's
        // basename, so this now correctly says "tags index unreadable" (not
        // the byte-frozen-for-index.jsonl "episode index unreadable").
        assert(j && j.status === 'error' && /tags index unreadable/.test(stdout), `em-store: typed tags-index envelope (in-lock F6 path, role-correct wording), got stdout=${stdout} stderr=${stderr.slice(0, 300)}`)
        assert(j.code === 'index-unreadable:ENOTREG', `em-store: code index-unreadable:ENOTREG, got ${JSON.stringify(j)}`)

        // The lock must be released — no stale lock file left behind.
        // Polled (not a single immediate check): em-store's own acquisition
        // can briefly show a just-recreated lock file at the moment its
        // process is tearing down; the assertion that matters is "not
        // leaked forever", not "vanished within the same microsecond".
        let lockGone = !fs.existsSync(lockPath)
        const lockDeadline = Date.now() + 2000
        while (!lockGone && Date.now() < lockDeadline) {
          sleepSync(20)
          lockGone = !fs.existsSync(lockPath)
        }
        assert(lockGone, 'lock file absent within 2s of the abort (finally/explicit release ran, not leaked)')

        // Restore tags.json (remove the FIFO — a fresh index-write recreates
        // it) and confirm an immediate retry succeeds.
        fs.rmSync(tagsFile, { force: true })
        const retry = run(path.join(SCRIPTS, 'em-store.mjs'), [
          '--project', 'p651', '--category', 'decision', '--summary', 'f6-retry', '--body', 'body', '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        assert(retry.status === 0, `retry em-store: exit 0, got ${retry.status}: stdout=${(retry.stdout || '').slice(0, 300)} stderr=${(retry.stderr || '').slice(0, 300)}`)
        const rj = lastJson(retry.stdout)
        assert(rj && rj.status === 'ok', `retry em-store: status ok, got ${retry.stdout}`)
      } finally {
        try { fs.rmSync(path.join(world.localDir, 'tags.json'), { force: true }) } catch {}
        cleanup(world)
      }
    })
  }
}

// -----------------------------------------------------------------------
// Vendored-writer legs (§7 S7 bullet 6, audit F2): vendored em-store/
// em-revise/em-rebuild-index x FIFO index.jsonl -> typed abort, no hang
// (T7 pattern, spawn timeout). New behavior — these had NO guard at all
// pre-#653 (em-store's vendored copy hangs on a FIFO index today).
// -----------------------------------------------------------------------
{
  const vendoredWriterCases = [
    {
      name: 'plugin em-store', script: 'em-store.mjs',
      args: ['--project', 'p651', '--category', 'decision', '--tags', 'x', '--summary', 'v', '--body', 'v', '--scope', 'local'],
    },
    {
      name: 'plugin em-rebuild-index', script: 'em-rebuild-index.mjs', args: ['--scope', 'local'],
    },
  ]
  for (const { name: caseName, script, args } of vendoredWriterCases) {
    const name = `T7 vendored ${caseName} x FIFO index.jsonl -> typed abort, no hang`
    if (IS_WIN) { skip(name, 'mkfifo unavailable on win32'); continue }
    t(name, () => {
      const world = mkStore()
      try {
        const indexPath = path.join(world.localDir, 'index.jsonl')
        fs.rmSync(indexPath, { force: true })
        const mk = spawnSync('mkfifo', [indexPath])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(PLUGIN_SCRIPTS, script), args, { cwd: world.proj, home: world.root })
        fs.rmSync(indexPath, { force: true })
        checkTyped(r, caseName)
      } finally { cleanup(world) }
    })
  }

  // plugin em-revise needs an existing episode to revise; mkStore's seed
  // already provides one via the VENDORED em-list contract (id shape is
  // identical — the vendored writer just wrote it with the real em-store
  // above in other legs, but here we seed via the real em-store for a
  // deterministic id and then FIFO the vendored copy's index target).
  {
    const name = 'T7 vendored plugin em-revise x FIFO index.jsonl -> typed abort, no hang'
    if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
      t(name, () => {
        const world = mkStore()
        try {
          const indexPath = path.join(world.localDir, 'index.jsonl')
          fs.rmSync(indexPath, { force: true })
          const mk = spawnSync('mkfifo', [indexPath])
          assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
          const r = run(path.join(PLUGIN_SCRIPTS, 'em-revise.mjs'), [
            '--original', world.seedId, '--project', 'p651', '--tags', 'x', '--summary', 'v', '--body', 'v', '--scope', 'local',
          ], { cwd: world.proj, home: world.root })
          fs.rmSync(indexPath, { force: true })
          checkTyped(r, 'plugin em-revise')
        } finally { cleanup(world) }
      })
    }
  }
}

// -----------------------------------------------------------------------
// FD hygiene (§5 V7, audit F5): looping openReadableIndex over unreadable
// shapes must never leak a file descriptor — 1000 iterations over a FIFO
// and a directory shape, then confirm the process can still open ordinary
// files (no EMFILE).
// -----------------------------------------------------------------------
{
  const name = 'V7 FD hygiene: 1000x openReadableIndex over unreadable shapes leaks no fd'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em653-fdhygiene-'))
      const fifoPath = path.join(dir, 'fifo.jsonl')
      const dirPath = path.join(dir, 'adir.jsonl')
      const mk = spawnSync('mkfifo', [fifoPath])
      assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
      fs.mkdirSync(dirPath)
      try {
        for (let i = 0; i < 1000; i++) {
          try { openReadableIndex(fs, i % 2 === 0 ? fifoPath : dirPath) } catch (e) {
            assert(e instanceof IndexUnreadableError, `iteration ${i}: throws IndexUnreadableError, got ${e}`)
          }
        }
        // No EMFILE: confirm we can still open a batch of ordinary fds.
        const probeFiles = []
        for (let i = 0; i < 50; i++) {
          const p = path.join(dir, `probe-${i}.txt`)
          fs.writeFileSync(p, 'x')
          probeFiles.push(p)
        }
        for (const p of probeFiles) {
          const content = fs.readFileSync(p, 'utf8')
          assert(content === 'x', `probe file ${p} still readable (no fd exhaustion)`)
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}

// =============================================================================
// #649/#653 second-opinion fix round (2026-08-08) — new regression legs for
// FIX-A, FIX-E, FIX-F. (FIX-B/FIX-C/FIX-D/FIX-H are covered by tightening the
// existing legs above, in place; FIX-G is docs-only.)
// =============================================================================

// --- FIX-A: static FIFO hangs inside touched writers (activation.mjs
// loadMergedIndex, reached from em-store --lesson/--evidence PRE-write
// validation) now abort typed instead of hanging. ---
{
  const name = 'FIX-A: em-store --lesson x FIFO local index (PRE-write linkage validation) -> typed abort'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const seedViol = run(path.join(SCRIPTS, 'em-store.mjs'), [
          '--project', 'p651', '--category', 'violation', '--summary', 'seed-violation', '--body', 'body', '--scope', 'local',
        ], { cwd: world.proj, home: world.root })
        assert(seedViol.status === 0, `seed violation failed: ${seedViol.stderr}`)
        const violId = (lastJson(seedViol.stdout) || {}).id
        const indexPath = path.join(world.localDir, 'index.jsonl')
        fs.rmSync(indexPath, { force: true })
        const mk = spawnSync('mkfifo', [indexPath])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
          '--project', 'p651', '--category', 'violation', '--summary', 'x1', '--body', 'body', '--scope', 'local', '--lesson', violId,
        ], { cwd: world.proj, home: world.root })
        restoreShape('fifo', indexPath, world.localDir)
        assert(r.signal === null, `em-store: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 1, `em-store: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-store: typed envelope, got ${r.stdout}`)
        assert(j.code === 'index-unreadable:ENOTREG', `em-store: code index-unreadable:ENOTREG, got ${JSON.stringify(j)}`)
      } finally { cleanup(world) }
    })
  }
}

// --- FIX-A: POST-durable-write trigger-merge reads (em-trigger-index.mjs)
// degrade instead of hanging, and the already-successful write surfaces a
// warning instead of silently misreporting. ---
{
  const name = 'FIX-A: em-store --category lesson --trigger x FIFO GLOBAL index (POST-write collision merge) -> ok + warning, no hang, no double-store'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const globalIndexPath = path.join(world.globalDir, 'index.jsonl')
        fs.rmSync(globalIndexPath, { force: true })
        const mk = spawnSync('mkfifo', [globalIndexPath])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-store.mjs'), [
          '--project', 'p651', '--category', 'lesson', '--summary', 'x2', '--body', 'body', '--scope', 'local', '--trigger', 'a distinctive trigger phrase',
        ], { cwd: world.proj, home: world.root })
        restoreShape('fifo', globalIndexPath, world.globalDir)
        assert(r.signal === null, `em-store: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 0, `em-store: exit 0 (the write already succeeded — a degraded post-write check must never misreport it), got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'ok', `em-store: status ok, got ${r.stdout}`)
        assert(typeof j.warning === 'string' && /global index unreadable/.test(j.warning), `em-store: warning field names the degraded scope, got ${JSON.stringify(j)}`)
        const list = run(path.join(SCRIPTS, 'em-list.mjs'), ['--scope', 'local'], { cwd: world.proj, home: world.root })
        const lj = lastJson(list.stdout)
        assert(lj.count === 2, `em-store: episode committed exactly once (seed + x2), no double-store, got count=${lj.count}`)
      } finally { cleanup(world) }
    })
  }
}

// --- FIX-E: em-pin's primary-index read now aborts typed on a static FIFO
// instead of hanging. ---
{
  const name = 'FIX-E: em-pin x FIFO local index -> typed abort, no hang'
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkStore()
      try {
        const indexPath = path.join(world.localDir, 'index.jsonl')
        fs.rmSync(indexPath, { force: true })
        const mk = spawnSync('mkfifo', [indexPath])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-pin.mjs'), ['--id', world.seedId], { cwd: world.proj, home: world.root })
        restoreShape('fifo', indexPath, world.localDir)
        assert(r.signal === null, `em-pin: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 1, `em-pin: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error', `em-pin: typed envelope, got ${r.stdout}`)
        assert(/episode index unreadable/.test(r.stdout), `em-pin: names the defect, got ${r.stdout.slice(0, 300)}`)
        assert(j.code === 'index-unreadable:ENOTREG', `em-pin: code index-unreadable:ENOTREG, got ${JSON.stringify(j)}`)
      } finally { cleanup(world) }
    })
  }
}

// --- FIX-F: em-consolidate's clerk-apply-family digest write (tags.json /
// category-index.json) now fd-guards its sidecar reads instead of hanging.
// Needs a near-duplicate cluster to reach the digest-write path.
// -----------------------------------------------------------------------
function mkConsolidateClusterStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em653-consolidate-'))
  const proj = path.join(root, 'proj')
  fs.mkdirSync(proj)
  const summary = 'duplicate cluster candidate alpha beta gamma delta epsilon'
  const a = spawnSync(process.execPath, [
    path.join(SCRIPTS, 'em-store.mjs'), '--project', 'p651', '--category', 'decision',
    '--tags', 'foo', '--summary', summary, '--body', 'body one detail', '--scope', 'local',
  ], { cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } })
  assert(a.status === 0, `seed member A failed: ${a.stderr}`)
  const b = spawnSync(process.execPath, [
    path.join(SCRIPTS, 'em-store.mjs'), '--project', 'p651', '--category', 'decision',
    '--tags', 'bar', '--summary', summary, '--body', 'body two detail', '--scope', 'local',
  ], { cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root } })
  assert(b.status === 0, `seed member B failed: ${b.stderr}`)
  return { root, proj, localDir: path.join(proj, '.episodic-memory') }
}
for (const { name: fileLabel, file } of [{ name: 'tags.json', file: 'tags.json' }, { name: 'category-index.json', file: 'category-index.json' }]) {
  const name = `FIX-F: em-consolidate --apply x FIFO ${fileLabel} (digest write) -> typed protection-abort, no hang`
  if (IS_WIN) { skip(name, 'mkfifo unavailable on win32') } else {
    t(name, () => {
      const world = mkConsolidateClusterStore()
      try {
        const sidecarFile = path.join(world.localDir, file)
        fs.rmSync(sidecarFile, { force: true })
        const mk = spawnSync('mkfifo', [sidecarFile])
        assert(mk.status === 0, `mkfifo failed: ${mk.stderr}`)
        const r = run(path.join(SCRIPTS, 'em-consolidate.mjs'), ['--scope', 'local', '--min-cluster', '2', '--apply', '--confirm'], { cwd: world.proj, home: world.root })
        restoreShape('fifo', sidecarFile, world.localDir)
        assert(r.signal === null, `em-consolidate: no signal (timeout/kill), got ${r.signal}`)
        assert(r.status === 1, `em-consolidate: exit 1, got ${r.status}: stdout=${(r.stdout || '').slice(0, 300)}`)
        const j = lastJson(r.stdout)
        assert(j && j.status === 'error' && j.mode === 'consolidate-apply', `em-consolidate: typed protection-abort envelope, got ${r.stdout}`)
        assert(j.code === 'protection-abort:protection', `em-consolidate: code protection-abort:protection, got ${JSON.stringify(j)}`)
        assert(r.stdout.includes(sidecarFile), `em-consolidate: names ${fileLabel} by path, got ${r.stdout.slice(0, 300)}`)
      } finally {
        try { fs.rmSync(world.root, { recursive: true, force: true }) } catch {}
      }
    })
  }
}

console.log(`${pass}/${pass + fail} pass (${skipped} skipped)`)
process.exit(fail ? 1 : 0)
