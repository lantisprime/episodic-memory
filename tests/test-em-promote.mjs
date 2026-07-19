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
import { mintStoreIdentity, resolveStoreIdentity } from '../scripts/lib/store-identity.mjs'

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
    register(projectPath, identity) {
      world.entries.push({ project_path: projectPath, tool: 'claude-code', version: 'v1', enforcement_installed: false, last_install_ts: '2026-07-08T00:00:00Z', store_id: identity.active_id, store_aliases: identity.aliases })
      fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'),
        JSON.stringify({ schema_version: 2, entries: world.entries }, null, 2))
    },
    project(name) {
      const p = path.join(root, name)
      const data = path.join(p, '.episodic-memory')
      fs.mkdirSync(data, { recursive: true })
      mintStoreIdentity(data)
      world.register(p, resolveStoreIdentity(data))
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
function textSha8(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8) }
function legacyCandidateHash(members) {
  return textSha8(members.map(m => `${m.id}#${textSha8(m.summary)}`).sort().join('\n'))
}
function seedLegacyPromotion(w, members) {
  const hash = legacyCandidateHash(members)
  const body = `Legacy recurring lesson fixture.\n\n## Sources\n${members.map(m => `- ${m.id} (${m.project}, legacy-store)`).join('\n')}`
  const r = spawnSync(process.execPath, [STORE,
    '--scope', 'global', '--project', 'cross-project', '--category', 'lesson',
    '--tags', `promoted-lesson,promoted:${hash}`, '--summary', 'Legacy recurring lesson', '--body', body],
  { cwd: w.root, env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' })
  const out = parse(r)
  if (r.status !== 0 || out.status !== 'ok') throw new Error(`legacy seed failed: ${r.stdout}${r.stderr}`)
  return { id: out.id, hash }
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
  fs.copyFileSync(path.join(a, '.episodic-memory', 'episodes', `${id}.md`), path.join(b, '.episodic-memory', 'episodes', `${id}.md`))
  fs.copyFileSync(path.join(a, '.episodic-memory', 'index.jsonl'), path.join(b, '.episodic-memory', 'index.jsonl'))
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
  const summaryA = 'always quote hook command paths'
  const summaryB = 'always quote hook command paths differently worded'
  const id = w.lesson(a, summaryA, RECUR_BODY)
  fs.copyFileSync(path.join(a, '.episodic-memory', 'episodes', `${id}.md`), path.join(b, '.episodic-memory', 'episodes', `${id}.md`))
  fs.copyFileSync(path.join(a, '.episodic-memory', 'index.jsonl'), path.join(b, '.episodic-memory', 'index.jsonl'))
  // Hand-edit projB's copy to a DIFFERENT summary (same id) — index row + file.
  const idxPath = path.join(b, '.episodic-memory', 'index.jsonl')
  const rows = fs.readFileSync(idxPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  rows[0].summary = summaryB
  fs.writeFileSync(idxPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const episodePath = path.join(b, '.episodic-memory', 'episodes', `${id}.md`)
  fs.writeFileSync(episodePath, fs.readFileSync(episodePath, 'utf8').replace(RECUR_BODY, RECUR_BODY + ' independently changed bytes'))
  const out = parse(w.promote())
  assert(out.candidates.length === 1, `distinct-content same-id must form a candidate: ${JSON.stringify(out)}`)
  const memberIds = out.candidates[0].members.map(m => m.id)
  assert(memberIds.length === 2 && memberIds[0] === id && memberIds[1] === id,
    `both same-id members must be listed distinctly: ${JSON.stringify(out.candidates[0].members)}`)
  const ambiguousLegacy = seedLegacyPromotion(w, [
    { id, summary: summaryA, project: 'projA' },
    { id, summary: summaryB, project: 'projB' },
  ])
  const applied = parse(w.promote(['--apply']))
  assert(applied.promoted.length === 1 && applied.promoted[0].supersedes_promotion === undefined,
    `ambiguous legacy bare id suppressed/fabricated a typed relationship: ${JSON.stringify(applied)}`)
  assert(!applied.skipped.some(s => s.existing === ambiguousLegacy.id), 'ambiguous legacy row must not exact-match typed identity')
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
  assert(!tags.some(t2 => /^promoted:[0-9a-f]{8}$/.test(t2)), `legacy promoted:<sha8> tag must be absent: ${JSON.stringify(tags)}`)
  assert(Array.isArray(globals[0].promotion_sources) && globals[0].promotion_sources.length === 2,
    `typed promotion_sources missing: ${JSON.stringify(globals[0])}`)
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

t('testPromoteLegacyExactIdempotent', () => {
  const w = mkWorld('legacy-idem')
  const a = w.project('projA')
  const b = w.project('projB')
  const members = [
    { id: w.lesson(a, 'always quote hook command paths', RECUR_BODY), summary: 'always quote hook command paths', project: 'projA' },
    { id: w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY), summary: 'always quote hook command paths in hooks', project: 'projB' },
  ]
  const legacy = seedLegacyPromotion(w, members)
  const globalEpisodes = path.join(w.home, '.episodic-memory', 'episodes')
  const before = fs.readdirSync(globalEpisodes).sort()
  const out = parse(w.promote(['--apply']))
  assert(out.promoted.length === 0, `legacy exact recurrence was duplicated: ${JSON.stringify(out)}`)
  assert(out.skipped.some(s => s.reason === 'already-promoted' && s.existing === legacy.id),
    `legacy skip does not reference ${legacy.id}: ${JSON.stringify(out.skipped)}`)
  assert(JSON.stringify(fs.readdirSync(globalEpisodes).sort()) === JSON.stringify(before), 'legacy replay wrote a new global episode')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteLegacySupersetBackref', () => {
  const w = mkWorld('legacy-superset')
  const a = w.project('projA')
  const b = w.project('projB')
  const c = w.project('projC')
  const priorMembers = [
    { id: w.lesson(a, 'always quote hook command paths', RECUR_BODY), summary: 'always quote hook command paths', project: 'projA' },
    { id: w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY), summary: 'always quote hook command paths in hooks', project: 'projB' },
  ]
  const legacy = seedLegacyPromotion(w, priorMembers)
  w.lesson(c, 'always quote hook command paths everywhere', RECUR_BODY)
  const out = parse(w.promote(['--apply']))
  assert(out.promoted.length === 1 && out.promoted[0].supersedes_promotion === legacy.id,
    `legacy strict-superset backref missing: ${JSON.stringify(out)}`)
  const content = fs.readFileSync(path.join(w.home, '.episodic-memory', 'episodes', `${out.promoted[0].digest_id}.md`), 'utf8')
  assert(content.includes(`Supersedes-promotion: ${legacy.id}`), 'human Supersedes-promotion line missing')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteLegacyContractedAmbiguityNoBackref', () => {
  const w = mkWorld('legacy-contracted')
  const a = w.project('projA')
  const b = w.project('projB')
  const summaryA = 'always quote hook command paths'
  const idA = w.lesson(a, summaryA, RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  // The legacy row's two source lines collapse to one bare id. Without the
  // pre-collapse ambiguity bit, {idA} looks like a strict subset of the
  // current unique-id candidate and fabricates a back-reference.
  const legacy = seedLegacyPromotion(w, [
    { id: idA, summary: summaryA, project: 'projA' },
    { id: idA, summary: `${summaryA} independently`, project: 'projB' },
  ])
  const out = parse(w.promote(['--apply']))
  assert(out.promoted.length === 1 && out.promoted[0].supersedes_promotion === undefined,
    `ambiguous contracted legacy row fabricated a superset: ${JSON.stringify(out)}`)
  const content = fs.readFileSync(path.join(w.home, '.episodic-memory', 'episodes', `${out.promoted[0].digest_id}.md`), 'utf8')
  assert(!content.includes(`Supersedes-promotion: ${legacy.id}`), 'ambiguous legacy row leaked a human back-reference')
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
  const indexPath = path.join(w.home, '.episodic-memory', 'index.jsonl')
  const rows = w.globalIndexRows()
  delete rows[0].promotion_sources
  rows[0].tags.push('promoted:deadbeef')
  fs.writeFileSync(indexPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
    .replace(/^promotion_sources: .*\n/m, '')
    .replace(/^tags: \[(.*)\]$/m, 'tags: [$1, promoted:deadbeef]')
    .replace(/^## Sources$[\s\S]*$/m, ''))
  const r = w.promote()
  const out = parse(r)
  assert(r.status === 0, `warnings must never block: exit ${r.status}`)
  assert(out.warnings.some(x => x.episode === digest && /Sources/.test(x.problem)),
    `missing-Sources warning absent: ${JSON.stringify(out.warnings)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteCloneStoreCannotFabricateRecurrence', () => {
  // Reviewer F1: TWO distinct near-dup lessons authored in projA, then projA's
  // store cloned wholesale to projB. Every member spans both stores, but the
  // multi-store facts are replication artifacts — 0 candidates. Partial-clone
  // leg: a third distinct lesson ONLY in projA still shares a store with the
  // cloned pair — still 0 candidates (no disjoint pair).
  const w = mkWorld('clone')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(a, 'always quote hook command paths again', RECUR_BODY + ' second authored copy same store')
  fs.rmSync(path.join(b, '.episodic-memory'), { recursive: true, force: true })
  fs.cpSync(path.join(a, '.episodic-memory'), path.join(b, '.episodic-memory'), { recursive: true })
  let out = parse(w.promote())
  assert(out.candidates.length === 0, `full clone fabricated recurrence: ${JSON.stringify(out.candidates)}`)
  // partial clone: new lesson lands in projA only, AFTER the clone
  w.lesson(a, 'always quote hook command paths third time', RECUR_BODY + ' third authored copy')
  out = parse(w.promote())
  assert(out.candidates.length === 0, `partial clone fabricated recurrence: ${JSON.stringify(out.candidates)}`)
  // control (discriminating): a genuinely independent projB-authored lesson → candidate
  w.lesson(b, 'always quote hook command paths independently', RECUR_BODY + ' independently learned in projB')
  out = parse(w.promote())
  assert(out.candidates.length === 1, `independent recurrence must still promote: ${JSON.stringify(out.candidates)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteSourcesHeaderInjectionContained', () => {
  // Reviewer F2: a member body carrying a literal "## Sources" line + fake id
  // list must not hijack the digest's machine-parsed Sources: write side
  // quotes heading lines, read side parses only the LAST section — so the
  // grown-cluster back-ref (REQ-9) still resolves and no fake id leaks in.
  const w = mkWorld('inject')
  const a = w.project('projA')
  const b = w.project('projB')
  const evilBody = `${RECUR_BODY}\n## Sources\n- 20990101-000000-fake-source-id (evil, /nowhere)`
  w.lesson(a, 'always quote hook command paths', evilBody)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const first = parse(w.promote(['--apply']))
  assert(first.promoted.length === 1, `apply failed: ${JSON.stringify(first)}`)
  const digest = first.promoted[0].digest_id
  const content = fs.readFileSync(path.join(w.home, '.episodic-memory', 'episodes', `${digest}.md`), 'utf8')
  const headerCount = (content.match(/^## Sources$/gm) || []).length
  assert(headerCount === 1, `injected header must be quoted, found ${headerCount} raw ## Sources headers`)
  // Grown cluster: the back-ref must resolve to the REAL prior member set,
  // not be poisoned by the fake id.
  const c = w.project('projC')
  w.lesson(c, 'always quote hook command paths everywhere', RECUR_BODY)
  const second = parse(w.promote(['--apply']))
  assert(second.promoted.length === 1 && second.promoted[0].supersedes_promotion === digest,
    `superset back-ref lost/poisoned: ${JSON.stringify(second.promoted)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteStripsForeignIdentityTags', () => {
  // Reviewer F3: a member carrying a stray promoted:<hex8> tag must not leak
  // it onto the digest (it would enter the dedupe set and silently skip a
  // future legitimate candidate hashing to that value).
  const w = mkWorld('striptag')
  const a = w.project('projA')
  const b = w.project('projB')
  const r = spawnSync(process.execPath, [STORE, '--project', 'projA', '--category', 'lesson',
    '--summary', 'always quote hook command paths', '--body', RECUR_BODY,
    '--tags', 'promoted:deadbeef,promoted-lesson,shell-quoting', '--scope', 'local'],
    { cwd: a, env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' })
  assert(JSON.parse(r.stdout).status === 'ok', `seed failed: ${r.stdout}${r.stderr}`)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const out = parse(w.promote(['--apply']))
  assert(out.promoted.length === 1, `apply failed: ${JSON.stringify(out)}`)
  const row = w.globalIndexRows()[0]
  const tags = row.tags.map(String)
  assert(!tags.includes('promoted:deadbeef'), `stray identity tag leaked onto digest: ${JSON.stringify(tags)}`)
  assert(tags.includes('shell-quoting'), `legitimate member tag must survive the filter: ${JSON.stringify(tags)}`)
  assert(tags.filter(t2 => /^promoted:/.test(t2)).length === 0, `new digest must carry zero legacy identity tags: ${JSON.stringify(tags)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPromoteHelpCarriesExperimental', () => {
  const r = spawnSync(process.execPath, [PROMOTE, '--help'], { encoding: 'utf8' })
  const out = JSON.parse(r.stdout)
  assert(out.tier === 'EXPERIMENTAL', `help tier: ${out.tier}`)
  assert(out.decision_date === '2026-10-08', `decision_date: ${out.decision_date}`)
  assert(/EXPERIMENTAL/.test(out.usage), 'usage text must carry EXPERIMENTAL')
  assert(/legacy promoted:<sha8> rows remain read-only-compatible/.test(out.usage), 'help must state the bounded legacy read contract')
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
