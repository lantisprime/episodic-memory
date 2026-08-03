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
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  classifyIndexFile, assertReadableIndex, readIndexFileOrThrow, IndexUnreadableError,
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

console.log(`${pass}/${pass + fail} pass (${skipped} skipped)`)
process.exit(fail ? 1 : 0)
