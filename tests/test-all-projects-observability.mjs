#!/usr/bin/env node
// test-all-projects-observability.mjs — APC-S2/S3 (plan §14 Group 2).
// Drives the REAL em-stats / em-doctor against an isolated HOME with a
// consumer registry of mock projects. Covers: foreign-store visibility,
// realpath duplicate-skip (incl. symlink alias, planner B5), read-only parity,
// corrupt-foreign exit semantics, singleton non-store checks, --fix routed by
// data_dir (incl. same-basename collision, codex CX1) with ON-DISK assertions
// (planner B1), and non-root-store skip.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const STATS = path.join(REPO, 'scripts', 'em-stats.mjs')
const DOCTOR = path.join(REPO, 'scripts', 'em-doctor.mjs')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')

function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }
// The lib realpaths store identities (/var → /private/var on macOS); expected
// paths must be realpath'd the same way before comparing.
function storeDirOf(project) { return fs.realpathSync(path.join(project, '.episodic-memory')) }

function mkWorld(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `em-apc-${name}-`))
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true })
  const world = {
    root, home,
    entries: [],
    register(projectPath) {
      world.entries.push({ project_path: projectPath, tool: 'claude-code', version: 'v1', enforcement_installed: false, last_install_ts: '2026-07-08T00:00:00Z' })
      fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'),
        JSON.stringify({ schema_version: 1, entries: world.entries }, null, 2))
    },
    project(name, { seed = 0 } = {}) {
      const p = path.join(root, name)
      fs.mkdirSync(p, { recursive: true })
      for (let i = 0; i < seed; i++) {
        const r = spawnSync(process.execPath, [STORE, '--project', name, '--category', 'lesson',
          '--summary', `${name} lesson ${i}`, '--body', `${name} body ${i}`, '--scope', 'local'],
          { cwd: p, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`seed em-store failed: ${r.stdout}${r.stderr}`)
      }
      return p
    },
    run(script, args, cwd) {
      return spawnSync(process.execPath, [script, ...args],
        { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
    },
  }
  return world
}

const tests = []
const t = (name, fn) => tests.push([name, fn])
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function parse(r) {
  try { return JSON.parse(r.stdout) } catch { throw new Error(`non-JSON stdout: ${r.stdout}\n${r.stderr}`) }
}

t('testStatsAllProjectsSeesForeignStore', () => {
  const w = mkWorld('stats-sees')
  const a = w.project('projA', { seed: 2 })
  const b = w.project('projB', { seed: 3 })
  w.register(a); w.register(b)
  const out = parse(w.run(STATS, ['--scope', 'all', '--all-projects'], a))
  const bBlock = out.scopes.find(s => s.scope === 'project:projB')
  assert(bBlock, `projB block missing: ${JSON.stringify(out.scopes.map(s => s.scope))}`)
  assert(bBlock.episodes.total === 3, `projB total ${bBlock.episodes.total}, want 3`)
  assert(out.totals.episodes === 5, `grand total ${out.totals.episodes}, want 5 (2 local + 3 foreign; empty global)`)
  const noFlag = parse(w.run(STATS, ['--scope', 'all'], a))
  assert(!noFlag.scopes.some(s => s.scope === 'project:projB'), 'without the flag projB must stay invisible (discriminating control)')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testStatsAllProjectsSkipsDuplicateOfLocal', () => {
  const w = mkWorld('stats-dup')
  const a = w.project('projA', { seed: 2 })
  w.register(a)
  // (a) same-spelling: cwd IS the registered project
  let out = parse(w.run(STATS, ['--scope', 'all', '--all-projects'], a))
  const aBlocks = out.scopes.filter(s => s.dir.includes('projA') || s.scope === 'project:projA')
  assert(aBlocks.length === 1, `same-spelling: want exactly 1 projA block, got ${aBlocks.length}: ${JSON.stringify(out.scopes.map(s => [s.scope, s.dir]))}`)
  // (b) alias spelling: cwd whose .episodic-memory SYMLINKS projA's store (planner B5)
  const aliasProj = path.join(w.root, 'aliasProj')
  fs.mkdirSync(aliasProj, { recursive: true })
  fs.symlinkSync(path.join(a, '.episodic-memory'), path.join(aliasProj, '.episodic-memory'))
  out = parse(w.run(STATS, ['--scope', 'all', '--all-projects'], aliasProj))
  const totals = out.scopes.filter(s => s.episodes.total === 2)
  assert(totals.length === 1, `alias spelling: projA's 2 episodes counted ${totals.length} times, want 1: ${JSON.stringify(out.scopes.map(s => [s.scope, s.dir, s.episodes.total]))}`)
  assert(out.totals.episodes === 2, `alias grand total ${out.totals.episodes}, want 2 (no double count)`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testStatsAllProjectsReadOnly', () => {
  const w = mkWorld('stats-ro')
  const a = w.project('projA', { seed: 1 })
  const b = w.project('projB', { seed: 2 })
  w.register(a); w.register(b)
  const idx = path.join(b, '.episodic-memory', 'index.jsonl')
  assert(fs.readFileSync(idx, 'utf8').length > 0, 'fixture index must be non-empty before parity check')
  const before = sha(idx)
  const r = w.run(STATS, ['--scope', 'all', '--all-projects'], a)
  assert(r.status === 0, `stats exit ${r.status}`)
  assert(sha(idx) === before, 'foreign index.jsonl bytes changed — stats must be read-only')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDoctorAllProjectsChecksForeignStore', () => {
  const w = mkWorld('doc-sees')
  const a = w.project('projA', { seed: 1 })
  const b = w.project('projB', { seed: 1 })
  w.register(a); w.register(b)
  const out = parse(w.run(DOCTOR, ['--all-projects'], a))
  const bRows = out.checks.filter(c => c.scope === 'project:projB')
  assert(bRows.length > 0, `no project:projB rows: ${JSON.stringify(out.checks.map(c => c.scope))}`)
  assert(bRows.every(c => c.data_dir === storeDirOf(b)), `projB rows must carry data_dir: ${JSON.stringify(bRows[0])}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDoctorAllProjectsForeignCorruptIndexExits1', () => {
  const w = mkWorld('doc-corrupt')
  const a = w.project('projA', { seed: 1 })
  const b = w.project('projB', { seed: 1 })
  w.register(a); w.register(b)
  fs.appendFileSync(path.join(b, '.episodic-memory', 'index.jsonl'), 'NOT JSON\n')
  const r = w.run(DOCTOR, ['--all-projects'], a)
  const out = parse(r)
  assert(r.status === 1, `corrupt foreign store: exit ${r.status}, want 1`)
  assert(out.checks.some(c => c.scope === 'project:projB' && c.id === 'index-parse' && c.level === 'error'),
    `missing projB index-parse error row: ${JSON.stringify(out.checks.filter(c => c.scope === 'project:projB'))}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDoctorAllProjectsSingletonChecks', () => {
  const w = mkWorld('doc-singleton')
  const a = w.project('projA', { seed: 1 })
  const b = w.project('projB', { seed: 1 })
  w.register(a); w.register(b)
  const out = parse(w.run(DOCTOR, ['--all-projects'], a))
  for (const id of ['installs-drift', 'node-version', 'backup', 'drafts']) {
    const n = out.checks.filter(c => c.id === id).length
    assert(n === 1, `check ${id} ran ${n} times, want exactly 1`)
  }
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDoctorAllProjectsFixRebuildsForeignIndex', () => {
  const w = mkWorld('doc-fix')
  const a = w.project('projA', { seed: 1 })
  const b = w.project('projB', { seed: 2 })
  w.register(a); w.register(b)
  // Corrupt projB: delete tags.json so the doctor flags a rebuildable finding.
  fs.rmSync(path.join(b, '.episodic-memory', 'tags.json'))
  const aIdxBefore = sha(path.join(a, '.episodic-memory', 'index.jsonl'))
  const out = parse(w.run(DOCTOR, ['--all-projects', '--fix'], a))
  const fixRow = (out.fixes || []).find(f => f.action === 'rebuild-index' && f.dir === storeDirOf(b))
  assert(fixRow && fixRow.exit === 0, `projB rebuild fix row missing/failed: ${JSON.stringify(out.fixes)}`)
  // ON-DISK: projB's tags.json regenerated; projA's index untouched (planner B1 assertion shape).
  assert(fs.existsSync(path.join(b, '.episodic-memory', 'tags.json')), 'projB tags.json not regenerated on disk')
  assert(sha(path.join(a, '.episodic-memory', 'index.jsonl')) === aIdxBefore, 'projA index changed — fix repaired the wrong store')
  const bRows = out.checks.filter(c => c.scope === 'project:projB' && c.id === 'tags-index')
  assert(bRows.length === 1 && bRows[0].level === 'ok', `re-verify row not ok: ${JSON.stringify(bRows)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDoctorFixSkipsNonRootStore', () => {
  const w = mkWorld('doc-nonroot')
  // A git repo whose NESTED subdir is registered: substrate resolution walks to
  // the git root, so a --fix at the nested registration must be skipped.
  const gitRoot = path.join(w.root, 'gitroot')
  fs.mkdirSync(gitRoot, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: gitRoot })
  const nested = path.join(gitRoot, 'nested')
  fs.mkdirSync(nested, { recursive: true })
  // Seed the ROOT store via em-store from the nested cwd (proves the resolution class).
  const r0 = w.run(STORE, ['--project', 'gp', '--category', 'lesson', '--summary', 'root lesson', '--body', 'b', '--scope', 'local'], nested)
  assert(r0.status === 0, `seed failed: ${r0.stdout}${r0.stderr}`)
  assert(fs.existsSync(path.join(gitRoot, '.episodic-memory', 'index.jsonl')), 'seed must land at the git ROOT store')
  w.register(nested)
  fs.rmSync(path.join(gitRoot, '.episodic-memory', 'tags.json'))
  const out = parse(w.run(DOCTOR, ['--all-projects', '--fix'], w.home))
  const skip = (out.fixes || []).find(f => f.action === 'skipped' && f.reason === 'non-root-store')
  assert(skip, `non-root-store skip row missing: ${JSON.stringify(out.fixes)}`)
  assert(!(out.fixes || []).some(f => f.action === 'rebuild-index' && f.dir === path.join(gitRoot, '.episodic-memory')),
    'non-root registration must never spawn a rebuild')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDoctorFixSameBasenameProjects', () => {
  const w = mkWorld('doc-basename')
  // codex CX1: two registered projects both named "app"; both corrupt; BOTH rebuilt.
  const app1 = w.project(path.join('teamA', 'app'), { seed: 1 })
  const app2 = w.project(path.join('teamB', 'app'), { seed: 1 })
  w.register(app1); w.register(app2)
  fs.rmSync(path.join(app1, '.episodic-memory', 'tags.json'))
  fs.rmSync(path.join(app2, '.episodic-memory', 'tags.json'))
  const out = parse(w.run(DOCTOR, ['--all-projects', '--fix'], w.home))
  for (const app of [app1, app2]) {
    const dir = storeDirOf(app)
    assert((out.fixes || []).some(f => f.action === 'rebuild-index' && f.dir === dir && f.exit === 0),
      `rebuild missing for ${dir}: ${JSON.stringify(out.fixes)}`)
    assert(fs.existsSync(path.join(dir, 'tags.json')), `${dir}/tags.json not regenerated`)
  }
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDoctorAllProjectsForeignStoreAbsentOk', () => {
  const w = mkWorld('doc-absent')
  const a = w.project('projA', { seed: 1 })
  const bare = path.join(w.root, 'bareProj')
  fs.mkdirSync(bare, { recursive: true })
  w.register(a); w.register(bare)
  const r = w.run(DOCTOR, ['--all-projects'], a)
  const out = parse(r)
  assert(r.status === 0, `absent foreign store must not fail doctor: exit ${r.status}`)
  const row = out.checks.find(c => c.scope === 'project:bareProj' && c.id === 'store')
  assert(row && row.level === 'ok', `bareProj store row: ${JSON.stringify(row)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

let pass = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); pass++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
console.log(`${pass}/${tests.length} pass`)
process.exit(pass === tests.length ? 0 : 1)
