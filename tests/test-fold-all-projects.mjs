#!/usr/bin/env node
// test-fold-all-projects.mjs — APC-S4 (plan §14 Group 3). Drives the REAL
// em-consolidate --fold-superseded --all-projects against isolated-HOME
// fixture registries. Covers: no single-store regression, foreign-chain
// archive, THIRD-store protection referencer with FULL chain-closure keep
// (planner B3+M1), realpath store labels for class-d protection (planner B4),
// mode/scope/confirm guards (fail-closed, byte-parity), and symlink-escape
// store skip (plan §7-C2).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CONSOLIDATE = path.join(REPO, 'scripts', 'em-consolidate.mjs')

function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }

function mkWorld(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `em-fold-ap-${name}-`))
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true })
  const world = {
    root, home, entries: [],
    register(projectPath) {
      world.entries.push({ project_path: projectPath, tool: 'claude-code', version: 'v1', enforcement_installed: false, last_install_ts: '2026-07-08T00:00:00Z' })
      fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'),
        JSON.stringify({ schema_version: 1, entries: world.entries }, null, 2))
    },
    project(name) {
      const p = path.join(root, name)
      fs.mkdirSync(path.join(p, '.episodic-memory', 'episodes'), { recursive: true })
      return p
    },
    run(args, cwd) {
      return spawnSync(process.execPath, [CONSOLIDATE, ...args],
        { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
    },
  }
  return world
}

// Writes a LINEAR supersedes chain of n members into a project store. Member
// ids sort chronologically; only the terminal is active. Returns the id list.
function seedChain(project, tag, n, { rowPatch = {} } = {}) {
  const dir = path.join(project, '.episodic-memory')
  const ids = []
  const rows = []
  for (let i = 1; i <= n; i++) {
    const id = `20260601-${String(100000 + i).slice(1)}-${tag}-${String(i).padStart(2, '0')}`
    ids.push(id)
    const row = {
      id, date: '2026-06-01', time: '00:00', project: path.basename(project),
      category: 'decision', status: i === n ? 'active' : 'superseded',
      supersedes: i === 1 ? null : ids[i - 2], tags: [tag], summary: `${tag} rev ${i}`,
      ...(rowPatch[i] || {}),
    }
    rows.push(row)
    fs.writeFileSync(path.join(dir, 'episodes', `${id}.md`),
      `---\nid: ${id}\nstatus: ${row.status}\n---\n\n# ${row.summary}\n`)
  }
  fs.appendFileSync(path.join(dir, 'index.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return ids
}

function appendRow(project, row) {
  fs.appendFileSync(path.join(project, '.episodic-memory', 'index.jsonl'), JSON.stringify(row) + '\n')
}

function storeSnapshot(project) {
  const dir = path.join(project, '.episodic-memory')
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else files.push(`${path.relative(dir, p)}:${sha(p)}`)
    }
  }
  walk(dir)
  return files.sort().join('\n')
}

const tests = []
const t = (name, fn) => tests.push([name, fn])
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function parse(r) {
  try { return JSON.parse(r.stdout) } catch { throw new Error(`non-JSON stdout: ${r.stdout}\n${r.stderr}`) }
}

t('testFoldSingleStoreUnchanged', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tests', 'test-fold-superseded.mjs')], { encoding: 'utf8' })
  assert(r.status === 0, `existing single-store fold suite regressed:\n${r.stdout}\n${r.stderr}`)
})

t('testFoldAllProjectsArchivesForeignChain', () => {
  const w = mkWorld('archive')
  const a = w.project('projA')
  const b = w.project('projB')
  w.register(a); w.register(b)
  const ids = seedChain(b, 'bchain', 12)
  const r = w.run(['--fold-superseded', '--all-projects', '--confirm'], a)
  const out = parse(r)
  assert(r.status === 0 && out.all_projects === true, `run failed: ${r.stdout}`)
  const bStore = out.stores.find(s => s.project_path.endsWith('projB'))
  assert(bStore && bStore.folded_total === 11, `projB folded_total ${bStore && bStore.folded_total}, want 11`)
  const archived = fs.readdirSync(path.join(b, '.episodic-memory', 'archived'))
  assert(archived.length === 11, `archived/ has ${archived.length} files, want 11`)
  const terminal = ids[11]
  assert(fs.existsSync(path.join(b, '.episodic-memory', 'episodes', `${terminal}.md`)), 'terminal episode file must stay')
  const idxLines = fs.readFileSync(path.join(b, '.episodic-memory', 'index.jsonl'), 'utf8').trim().split('\n')
  for (const line of idxLines) JSON.parse(line) // parses post-run
  assert(idxLines.length === 1 && JSON.parse(idxLines[0]).id === terminal, `index must keep only the terminal: ${idxLines.length} rows`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testFoldAllProjectsHonorsForeignProtection', () => {
  // planner B3 + M1: the referencer lives in a THIRD registered store, and one
  // evidence link must keep the ENTIRE chain via closure (an implementation
  // keeping only the anchor while archiving 10 closure members must FAIL).
  const w = mkWorld('protect')
  const a = w.project('projA')
  const b = w.project('projB')
  const c = w.project('projC')
  w.register(a); w.register(b); w.register(c)
  const ids = seedChain(b, 'protchain', 12)
  appendRow(c, {
    id: '20260701-000001-c-lesson', date: '2026-07-01', time: '00:00', project: 'projC',
    category: 'lesson', status: 'active', supersedes: null, tags: ['x'],
    summary: 'lesson naming a projB chain member', evidence: [ids[5]],
  })
  const before = storeSnapshot(b)
  const r = w.run(['--fold-superseded', '--all-projects', '--confirm'], a)
  const out = parse(r)
  const bStore = out.stores.find(s => s.project_path.endsWith('projB'))
  assert(bStore.folded_total === 0, `protected chain folded ${bStore.folded_total} members, want 0: ${JSON.stringify(bStore.chains)}`)
  const kept = bStore.chains[0].kept
  const reasons = kept.map(k => k.reason)
  assert(kept.length === 11, `kept ${kept.length} non-terminal members, want all 11 (M1 full-closure)`)
  assert(reasons.includes('r6-protected:evidence-linked-violation'), `anchor reason missing: ${JSON.stringify(reasons)}`)
  assert(reasons.includes('r6-protected:chain-member'), `closure reason missing: ${JSON.stringify(reasons)}`)
  assert(storeSnapshot(b) === before, 'projB store bytes changed despite full protection')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testFoldProtectionLabelIsRealpath', () => {
  // planner B4: two registered projects share the basename "app". Class-d
  // protection keys latestByStore by the storeLabel; if the DISPLAY label
  // (project:app) were used, both stores merge into one bucket and the store
  // whose clerk-run id sorts LOWER loses its latest-run protection.
  const w = mkWorld('basename')
  const a = w.project('projA')
  const app1 = w.project(path.join('teamA', 'app'))
  const app2 = w.project(path.join('teamB', 'app'))
  w.register(a); w.register(app1); w.register(app2)
  // Each store holds exactly one clerk-run member; under a merged bucket only
  // the id-max one survives (a1chain-06 < a2chain-06, so app1's would be
  // shadowed and archived), while per-realpath buckets protect BOTH.
  seedChain(app1, 'a1chain', 12, { rowPatch: { 6: { record_type: 'clerk-run' } } })
  seedChain(app2, 'a2chain', 12, { rowPatch: { 6: { record_type: 'clerk-run' } } })
  const r = w.run(['--fold-superseded', '--all-projects', '--confirm'], a)
  const out = parse(r)
  for (const base of ['teamA/app', 'teamB/app']) {
    const st = out.stores.find(s => s.project_path.endsWith(base))
    const kept = (st.chains[0] && st.chains[0].kept) || []
    assert(kept.some(k => k.reason === 'r6-protected:latest-run-record'),
      `${base}: latest clerk-run member not protected (label leaked into class-d bucket): ${JSON.stringify(st.chains)}`)
  }
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testFoldAllProjectsRequiresFoldMode', () => {
  const w = mkWorld('mode')
  const a = w.project('projA')
  w.register(a)
  const r = w.run(['--all-projects'], a)
  assert(r.status === 2, `cluster+--all-projects exit ${r.status}, want 2`)
  assert(parse(r).status === 'error', `want JSON error: ${r.stdout}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testFoldAllProjectsScopeConflict', () => {
  const w = mkWorld('scope')
  const a = w.project('projA')
  w.register(a)
  const r = w.run(['--fold-superseded', '--all-projects', '--scope', 'local'], a)
  assert(r.status === 2, `--all-projects+--scope exit ${r.status}, want 2`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testFoldAllProjectsRealRunNeedsConfirm', () => {
  const w = mkWorld('confirm')
  const a = w.project('projA')
  const b = w.project('projB')
  w.register(a); w.register(b)
  seedChain(b, 'cchain', 12)
  const before = storeSnapshot(b)
  assert(before.length > 0, 'fixture snapshot must be non-empty before the negative run')
  const r = w.run(['--fold-superseded', '--all-projects'], a)
  assert(r.status === 2, `unconfirmed real run exit ${r.status}, want 2`)
  assert(parse(r).message.includes('--confirm'), `error must name --confirm: ${r.stdout}`)
  assert(storeSnapshot(b) === before, 'unconfirmed run touched a store — guard must fire before any move')
  // dry-run needs no confirm and still writes nothing
  const dry = w.run(['--fold-superseded', '--all-projects', '--dry-run'], a)
  assert(dry.status === 0 && parse(dry).folded_total === 11, `dry-run: ${dry.stdout}`)
  assert(storeSnapshot(b) === before, 'dry-run wrote to a store')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testFoldSkipsSymlinkEscapeStore', () => {
  const w = mkWorld('symlink')
  const a = w.project('projA')
  const victim = w.project('victimProj') // NOT registered; holds a foldable chain
  seedChain(victim, 'vchain', 12)
  const evil = path.join(w.root, 'evilProj')
  fs.mkdirSync(evil, { recursive: true })
  fs.symlinkSync(path.join(victim, '.episodic-memory'), path.join(evil, '.episodic-memory'))
  w.register(a); w.register(evil)
  const before = storeSnapshot(victim)
  const r = w.run(['--fold-superseded', '--all-projects', '--confirm'], a)
  const out = parse(r)
  const evilStore = out.stores.find(s => s.project_path.endsWith('evilProj'))
  assert(evilStore && evilStore.skipped_store === 'non-root-store', `evil store must be skipped: ${JSON.stringify(out.stores)}`)
  assert(storeSnapshot(victim) === before, 'victim store bytes changed through the symlinked registration')
  fs.rmSync(w.root, { recursive: true, force: true })
})

let pass = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); pass++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
console.log(`${pass}/${tests.length} pass`)
process.exit(pass === tests.length ? 0 : 1)
