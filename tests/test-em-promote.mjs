#!/usr/bin/env node
// test-em-promote.mjs — APC-S5 (plan §14 Group 4). Drives the REAL em-promote
// (and em-store for seeding/writing) under isolated HOME. Covers: cross-store
// recurrence detection, single-store/replica exclusions (planner M4), the
// coincident-id-different-content class (codex CX2), global-only writes with
// source byte-parity, identity-hash idempotency (planner B2), superset
// back-refs, drift warnings, experimental labeling, and substrate-class
// auto-distribution.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { isSubstrateScript } from '../scripts/lib/install-manifest.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PROMOTE = path.join(REPO, 'scripts', 'em-promote.mjs')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')

const SENTINEL = 'SENTINEL_ap37c1'

function sha(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }

function mkWorld(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `em-promote-${name}-`))
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
      fs.mkdirSync(p, { recursive: true })
      world.register(p)
      return p
    },
    lesson(project, summary, body) {
      const r = spawnSync(process.execPath, [STORE, '--project', path.basename(project), '--category', 'lesson',
        '--summary', summary, '--body', body, '--scope', 'local'],
        { cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
      const out = JSON.parse(r.stdout)
      if (out.status !== 'ok') throw new Error(`seed lesson failed: ${r.stdout}${r.stderr}`)
      return out.id
    },
    promote(args = []) {
      return spawnSync(process.execPath, [PROMOTE, ...args],
        { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
    },
    globalIndexRows() {
      const p = path.join(home, '.episodic-memory', 'index.jsonl')
      if (!fs.existsSync(p)) return []
      return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    },
  }
  return world
}

const RECUR_BODY = `always quote hook command paths in settings json ${SENTINEL} because unquoted node paths split on spaces and the gate never fires`

const tests = []
const t = (name, fn) => tests.push([name, fn])
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function parse(r) {
  try { return JSON.parse(r.stdout) } catch { throw new Error(`non-JSON stdout: ${r.stdout}\n${r.stderr}`) }
}

t('testPromoteFindsCrossStoreRecurrence', () => {
  const w = mkWorld('finds')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  w.lesson(a, 'unrelated widget observation', 'widgets rotate freely on the flange axis nothing shared here')
  const out = parse(w.promote())
  assert(out.dry_run === true, 'dry-run must be the default')
  assert(out.candidates.length === 1, `want 1 candidate, got ${out.candidates.length}: ${JSON.stringify(out.candidates)}`)
  assert(out.candidates[0].stores.length === 2, `candidate must span 2 stores: ${JSON.stringify(out.candidates[0].stores)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteIgnoresSingleStoreCluster', () => {
  const w = mkWorld('single')
  const a = w.project('projA')
  w.project('projB') // registered but empty — >=2 stores so the scan runs
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(a, 'always quote hook command paths again', RECUR_BODY + ' repeated in the same project store')
  const out = parse(w.promote())
  assert(out.candidates.length === 0, `single-store cluster must not promote: ${JSON.stringify(out.candidates)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteSkipsReplicaMembers', () => {
  // Clone-store class (planner M4): the SAME episode (id + summary) copied
  // into two stores is a replica, not a recurrence.
  const w = mkWorld('replica')
  const a = w.project('projA')
  const b = w.project('projB')
  const id = w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  fs.cpSync(path.join(a, '.episodic-memory'), path.join(b, '.episodic-memory'), { recursive: true })
  const out = parse(w.promote())
  assert(out.candidates.length === 0, `replica must not count as recurrence: ${JSON.stringify(out.candidates)}`)
  assert(id, 'seed id must exist')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteSameIdDifferentContentStaysDistinct', () => {
  // codex CX2: a coincident id with DIFFERENT content across independent
  // stores is two members, never silently collapsed — and (being similar
  // bodies in two stores) it IS a legitimate recurrence candidate.
  const w = mkWorld('sameid')
  const a = w.project('projA')
  const b = w.project('projB')
  const id = w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  fs.cpSync(path.join(a, '.episodic-memory'), path.join(b, '.episodic-memory'), { recursive: true })
  // Hand-edit projB's copy to a DIFFERENT summary (same id) — index row + file.
  const idxPath = path.join(b, '.episodic-memory', 'index.jsonl')
  const rows = fs.readFileSync(idxPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  rows[0].summary = 'always quote hook command paths differently worded'
  fs.writeFileSync(idxPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const out = parse(w.promote())
  assert(out.candidates.length === 1, `distinct-content same-id must form a candidate: ${JSON.stringify(out)}`)
  const memberIds = out.candidates[0].members.map(m => m.id)
  assert(memberIds.length === 2 && memberIds[0] === id && memberIds[1] === id,
    `both same-id members must be listed distinctly: ${JSON.stringify(out.candidates[0].members)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteApplyWritesGlobalEpisode', () => {
  const w = mkWorld('apply')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const r = w.promote(['--apply'])
  const out = parse(r)
  assert(r.status === 0 && out.promoted.length === 1 && out.promoted[0].digest_id, `apply failed: ${r.stdout}${r.stderr}`)
  const globals = w.globalIndexRows()
  assert(globals.length === 1, `global index rows ${globals.length}, want 1`)
  const tags = globals[0].tags.map(String)
  assert(tags.includes('promoted-lesson'), `promoted-lesson tag missing: ${JSON.stringify(tags)}`)
  assert(tags.some(t2 => /^promoted:[0-9a-f]{8}$/.test(t2)), `promoted:<sha8> tag missing: ${JSON.stringify(tags)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteApplyBodyCarriesSources', () => {
  const w = mkWorld('sources')
  const a = w.project('projA')
  const b = w.project('projB')
  const idA = w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  const idB = w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const out = parse(w.promote(['--apply']))
  const digest = out.promoted[0].digest_id
  const content = fs.readFileSync(path.join(w.home, '.episodic-memory', 'episodes', `${digest}.md`), 'utf8')
  assert(content.includes('## Sources'), 'Sources section missing from written episode')
  for (const id of [idA, idB]) {
    assert(content.includes(id), `member id ${id} missing from digest body`)
  }
  assert(content.includes(SENTINEL), 'member body sentinel missing from digest excerpt')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteNeverWritesSourceStores', () => {
  const w = mkWorld('parity')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const idxA = path.join(a, '.episodic-memory', 'index.jsonl')
  const idxB = path.join(b, '.episodic-memory', 'index.jsonl')
  assert(fs.readFileSync(idxA, 'utf8').length > 0, 'fixture index must be non-empty before parity check')
  const beforeA = sha(idxA)
  const beforeB = sha(idxB)
  const r = w.promote(['--apply'])
  assert(r.status === 0, `apply failed: ${r.stdout}${r.stderr}`)
  assert(sha(idxA) === beforeA && sha(idxB) === beforeB, 'a source store index changed — promote must write global only')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteApplyIdempotent', () => {
  const w = mkWorld('idem')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const first = parse(w.promote(['--apply']))
  assert(first.promoted.length === 1, `first apply: ${JSON.stringify(first)}`)
  const epsDir = path.join(w.home, '.episodic-memory', 'episodes')
  const filesAfterFirst = fs.readdirSync(epsDir).length
  const second = parse(w.promote(['--apply']))
  assert(second.promoted.length === 0, `second apply must promote nothing: ${JSON.stringify(second.promoted)}`)
  assert(second.skipped.some(s => s.reason === 'already-promoted' && s.existing === first.promoted[0].digest_id),
    `skip must name the existing digest: ${JSON.stringify(second.skipped)}`)
  assert(fs.readdirSync(epsDir).length === filesAfterFirst, 'second apply added episode files')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteSupersetClusterPromotesWithBackref', () => {
  const w = mkWorld('superset')
  const a = w.project('projA')
  const b = w.project('projB')
  const c = w.project('projC')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const first = parse(w.promote(['--apply']))
  const priorId = first.promoted[0].digest_id
  // Cluster grows: a third store gains the same recurring lesson.
  w.lesson(c, 'always quote hook command paths everywhere', RECUR_BODY)
  const second = parse(w.promote(['--apply']))
  assert(second.promoted.length === 1, `grown cluster must promote under its new hash: ${JSON.stringify(second)}`)
  assert(second.promoted[0].supersedes_promotion === priorId,
    `back-ref missing: ${JSON.stringify(second.promoted[0])}, want ${priorId}`)
  const content = fs.readFileSync(path.join(w.home, '.episodic-memory', 'episodes', `${second.promoted[0].digest_id}.md`), 'utf8')
  assert(content.includes(`Supersedes-promotion: ${priorId}`), 'Supersedes-promotion line missing from Sources')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteWarnsOnMalformedPromotedEpisode', () => {
  const w = mkWorld('warn')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const first = parse(w.promote(['--apply']))
  const digest = first.promoted[0].digest_id
  // Hand-break the written episode: strip the Sources section.
  const p = path.join(w.home, '.episodic-memory', 'episodes', `${digest}.md`)
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^## Sources$[\s\S]*$/m, ''))
  const r = w.promote()
  const out = parse(r)
  assert(r.status === 0, `warnings must never block: exit ${r.status}`)
  assert(out.warnings.some(x => x.episode === digest && /Sources/.test(x.problem)),
    `missing-Sources warning absent: ${JSON.stringify(out.warnings)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteHelpCarriesExperimental', () => {
  const r = spawnSync(process.execPath, [PROMOTE, '--help'], { encoding: 'utf8' })
  const out = JSON.parse(r.stdout)
  assert(out.tier === 'EXPERIMENTAL', `help tier: ${out.tier}`)
  assert(out.decision_date === '2026-10-08', `decision_date: ${out.decision_date}`)
  assert(/EXPERIMENTAL/.test(out.usage), 'usage text must carry EXPERIMENTAL')
})

t('testPromoteIsSubstrateScript', () => {
  assert(isSubstrateScript('em-promote.mjs') === true, 'em-promote.mjs must auto-classify as substrate (global deploy, em dispatch)')
})

let pass = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); pass++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
console.log(`${pass}/${tests.length} pass`)
process.exit(pass === tests.length ? 0 : 1)
