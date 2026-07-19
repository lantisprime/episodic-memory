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
import { mintStoreIdentity, resolveStoreIdentity, rebindStoreIdentity, detachStoreIdentity } from '../scripts/lib/store-identity.mjs'
import { validateRegistry } from '../scripts/validate-plugin-registry.mjs'
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs'
import { resolveSourceRefs } from '../scripts/lib/promotion-sources.mjs'

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

// S3 (RFC-012 P2): ONLY_FLAG filtering — verbatim idiom from
// tests/test-rfc-009-p4-apply.mjs:53-58 (the S1 idiom). Every `--only` verify
// below depends on it. The bare for-loop runner can't filter, so `t()` runs
// the test body inline. pass/fail counts are tracked inside `t()`; the
// trailing for-loop now only iterates the empty `tests` array (kept for
// backward-compat with the pre-S3 file shape — see runner below).
const ONLY_FLAG = (() => { const i = process.argv.indexOf('--only'); if (i < 0) return []; const raw = process.argv[i + 1]; return raw ? raw.split(',') : [] })()
const onlyMatches = (name) => ONLY_FLAG.length === 0 || ONLY_FLAG.some(flag => name.includes(flag))
let pass = 0, fail = 0, skipped = 0
const tests = []
function skip(name, reason) {
  if (!onlyMatches(name)) return
  console.log(`ok ${name} # SKIP ${reason}`)
  skipped++
}
const t = (name, fn) => {
  if (!onlyMatches(name)) return
  try { fn(); console.log(`ok ${name}`); pass++ }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); fail++ }
}
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

// ===========================================================================
// S3 gauntlet (RFC-012 P2 REQ-13/REQ-14, §14 Group 5): the registry slot,
// descriptor schema, runtime IO schema, and conformance gauntlet for the
// `learning` plugin type. Identity-fixture tests may already pass (S1/S2
// behavior); the slot/descriptor/validator tests are RED until steps 3.5/3.6
// install the new sub-schemas and entries.
// ===========================================================================

// Context files for `mkRegistryRoot` — copied verbatim from the descriptor's
// L-path existence target set per §A.5-S3 / step 3.5(e).
const CONTEXT_FILES = [
  'plugins/_index.schema.json', 'plugins/manifest.schema.json', 'plugins/bypass_known.schema.json',
  'plugins/installed-state.schema.json', 'schemas/runtime/structured-alert.schema.json',
  'schemas/runbook-agent-manifest.schema.json', 'plugins/activation-manifest.schema.json',
  'plugins/learning-descriptor.schema.json', 'learning/em-promote.json',
  'patterns/taxonomy.json', 'patterns/events.json', 'plugins/bypass_known.json',
  'plugins/_index.json', 'schemas/runtime/learning-io.schema.json',
  'scripts/em-promote.mjs', 'tests/test-em-promote.mjs',
]

function mkRegistryRoot(mutators = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-promote-gauntlet-'))
  for (const rel of CONTEXT_FILES) {
    const src = path.join(REPO, rel)
    const dst = path.join(root, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (rel.endsWith('.json')) {
      let json = JSON.parse(fs.readFileSync(src, 'utf8'))
      if (mutators.descriptor && rel === 'learning/em-promote.json') {
        json = { ...json, ...mutators.descriptor }
      }
      if (rel === 'plugins/_index.json') {
        if (mutators.indexSlim) {
          // Slim: keep schema_version + ON-disk reserved-only entries, drop the
          // production entries whose manifests/runbooks we never copy into the
          // temp root — keeps the gauntlet harness focused on the targeted
          // L-* violation rather than masking it under M2/A2/M8 noise.
          json = { schema_version: json.schema_version, plugins: mutators.indexSlim }
        } else if (mutators.index) {
          json = { ...json, ...mutators.index }
        }
      }
      fs.writeFileSync(dst, JSON.stringify(json, null, 2))
    } else {
      fs.copyFileSync(src, dst)
    }
  }
  // M8 on-disk discipline (mirror of tests/test-plugin-registry.mjs buildLiveProject):
  // the validator's checkBidirectionalDirs emits reserved_absent for every
  // on-disk reserved dir that is missing, and entry_dir_missing for every
  // entry-declared `directory` field that is missing. Create the reserved dirs
  // unconditionally and every entry-declared directory from the slim index.
  // Without this scaffolding the no-crash tests' "no M8 violation" assertion
  // is masked by scaffolding-noise.
  fs.mkdirSync(path.join(root, 'plugins/episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(root, 'plugins/second-opinion/runbooks'), { recursive: true })
  const slimEntries = (mutators.indexSlim || [])
  for (const entry of slimEntries) {
    if (typeof entry.directory === 'string') fs.mkdirSync(path.join(root, entry.directory), { recursive: true })
  }
  return root
}

t('gauntlet::testLearningSlotSchema', () => {
  // Synthesize an index with a learning entry + a control activation entry.
  // Validate against the LIVE _index.schema.json (RED until 3.5 installs
  // learningDescriptor). All four negative variants likewise RED until the
  // sub-schema exists; the "valid" variant is a structural probe.
  // Labeled 1.2.0 (the schema where the learning slot ships) — per-type
  // version floors are a registry-roadmap question deferred past S3 (§19.3e).
  const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins/_index.schema.json'), 'utf8'))
  const base = { schema_version: '1.2.0', plugins: [{
    type: 'learning', id: 'em-promote', version: '1.0.0',
    module: 'scripts/em-promote.mjs', descriptor: 'learning/em-promote.json', status: 'active',
  }] }
  const ok = validateInstance(base, SCHEMA)
  assert(ok.valid, `valid learning entry must validate (RED until 3.5): ${JSON.stringify(ok.errors)}`)
  const noModule = validateInstance({ ...base, plugins: [{ ...base.plugins[0], module: undefined }] }, SCHEMA)
  assert(!noModule.valid, 'missing module must invalidate')
  const extra = validateInstance({ ...base, plugins: [{ ...base.plugins[0], extraField: 'x' }] }, SCHEMA)
  assert(!extra.valid, 'extra key must invalidate')
  const badDesc = validateInstance({ ...base, plugins: [{ ...base.plugins[0], descriptor: 'BAD' }] }, SCHEMA)
  assert(!badDesc.valid, 'bad descriptor pattern must invalidate')
  const wrongType = validateInstance({ ...base, plugins: [{ ...base.plugins[0], type: 'learningx' }] }, SCHEMA)
  assert(!wrongType.valid, 'bad type enum must invalidate')
})

t('gauntlet::testRegistryValidates', () => {
  const r = validateRegistry({ projectRoot: REPO })
  assert(r.status === 'ok' && r.violations.length === 0, `live registry must validate (status ok, 0 violations): ${JSON.stringify(r.violations.slice(0, 4))}`)
  const cli = spawnSync(process.execPath,
    [path.join(REPO, 'scripts/validate-plugin-registry.mjs'), '--project', REPO, '--json'],
    { encoding: 'utf8' })
  assert(cli.status === 0, `CLI exit ${cli.status}: ${cli.stderr}`)
})

t('gauntlet::testLearningDescriptorNegative', () => {
  // Variants: descriptor missing module / entry missing module / version drift
  // / confirm_gated wrong type. RED until step 3.5+3.7 installs the
  // sub-schema and the L-* checks. Slim index (only the learning entry) so
  // M2/A2/M8 noise from missing production manifests doesn't mask the
  // targeted L-* violation.
  const slimLearning = [{
    type: 'learning', id: 'em-promote', version: '1.0.0',
    module: 'scripts/em-promote.mjs', descriptor: 'learning/em-promote.json', status: 'active',
  }]
  const rootMissingMod = mkRegistryRoot({ indexSlim: slimLearning, descriptor: { module: undefined } })
  const r1 = validateRegistry({ projectRoot: rootMissingMod })
  assert(r1.status === 'fail' && r1.violations.some(v => v.check === 'L-schema'),
    `descriptor missing module must emit L-schema: status=${r1.status} violations=${JSON.stringify(r1.violations)}`)
  const entryNoMod = slimLearning.map(e => ({ ...e, module: undefined }))
  const rootEntryMissingMod = mkRegistryRoot({ indexSlim: entryNoMod })
  const r2 = validateRegistry({ projectRoot: rootEntryMissingMod })
  assert(r2.status === 'fail' && r2.violations.some(v => v.check === 'M1'),
    `entry missing module must emit M1: status=${r2.status} violations=${JSON.stringify(r2.violations)}`)
  const rootVersionDrift = mkRegistryRoot({
    indexSlim: [{ ...slimLearning[0], version: '9.9.9' }],
    descriptor: { version: '9.9.8' },
  })
  const r3 = validateRegistry({ projectRoot: rootVersionDrift })
  assert(r3.status === 'fail' && r3.violations.some(v => v.check === 'L-cross'),
    `version drift between entry + descriptor must emit L-cross: ${JSON.stringify(r3.violations)}`)
  const rootBadType = mkRegistryRoot({
    indexSlim: slimLearning,
    descriptor: { side_effects: { writes: ['global-episodes'], confirm_gated: 'not-a-boolean' } },
  })
  const r4 = validateRegistry({ projectRoot: rootBadType })
  assert(r4.status === 'fail' && r4.violations.some(v => v.check === 'L-schema'),
    `confirm_gated wrong type must emit L-schema: ${JSON.stringify(r4.violations)}`)
  for (const r of [rootMissingMod, rootEntryMissingMod, rootVersionDrift, rootBadType]) {
    fs.rmSync(r, { recursive: true, force: true })
  }
})

t('gauntlet::testLearningIoConformance', () => {
  const w = mkWorld('io')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const out = parse(w.promote())
  assert(out.dry_run === true, 'dry_run must be true')
  const ioSchema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/runtime/learning-io.schema.json'), 'utf8'))
  const ok = validateInstance(out, ioSchema)
  assert(ok.valid, `dry-run output must conform to learning-io schema (RED until 3.2): ${JSON.stringify(ok.errors)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('gauntlet::testPreRebindRefsResolve', () => {
  // §19.3d: the gauntlet originally asserted post-rebind `skipped: already-promoted`;
  // ground-truthed by the orchestrator, em-promote.mjs exact-skip keys on
  // canonicalized promotion_sources INCLUDING store_id (line 282), so an ordinary
  // rebind legitimately changes the key (no skip), and strict-superset requires
  // a strictly-smaller member set, so equal members post-rebind go FRESH. The
  // RFC-012:59 fixture's true contract is RESOLUTION (REQ-3/REQ-10 alias-aware
  // keep-resolving). Alias-aware dedupe is a graduation question deferred to
  // S4 (Rule 18 step 9 artifact: §19.3d). REQ-16 per-candidate confirm is the
  // human backstop until that decision.
  //
  // OBSERVED DISPOSITION (2026-07-19, verified in-worktree): after rebind A,
  // dry-run's `candidates` shows the post-rebind cluster as FRESH (hash differs
  // because A's store_id differs); `skipped` is `[]`; `missing_sources` is `[]`
  // because the existing promoted episode's pre-rebind refs (with A's old
  // store_id) still resolve through A's aliases. Lib-level resolveSourceRefs
  // on a `{store_id: <preRebindStoreId>}` ref resolves to A's row.
  const w = mkWorld('prerebind')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const aDir = path.join(a, '.episodic-memory')
  const aIdnBefore = resolveStoreIdentity(aDir)
  const preRebindStoreId = aIdnBefore.active_id // becomes an alias after rebind
  const first = parse(w.promote(['--apply']))
  assert(first.promoted.length === 1, `initial apply: ${JSON.stringify(first)}`)
  rebindStoreIdentity(aDir)
  const aIdnAfter = resolveStoreIdentity(aDir)
  const second = parse(w.promote())
  assert(second.dry_run === true, 'dry-run must remain default after rebind')
  // (1) pre-rebind ref MUST NOT appear in dry-run's missing_sources — alias
  //     resolution holds through the promotion path (REQ-3 / REQ-10).
  assert(Array.isArray(second.missing_sources), 'missing_sources must be an array')
  assert(!second.missing_sources.some(s => s.store_id === preRebindStoreId),
    `pre-rebind ref must NOT be missing (alias resolution holds): ${JSON.stringify(second.missing_sources)}`)
  // (2) lib-level resolveSourceRefs on the pre-rebind ref resolves to store A.
  //     Registry is built FRESH post-rebind so the alias path is actually
  //     exercised (not the stale-w.entries-direct path).
  const registry = [a, b].map(p => {
    const idn = resolveStoreIdentity(path.join(p, '.episodic-memory'))
    return { store_id: idn.active_id, store_aliases: idn.aliases }
  })
  const preRebindRef = [{ store_id: preRebindStoreId, episode_id: 'probe', content_sha256: '0'.repeat(64) }]
  const resolution = resolveSourceRefs(preRebindRef, registry)
  assert(resolution.missing.length === 0,
    `pre-rebind ref must resolve via lib-level resolveSourceRefs (no missing): ${JSON.stringify(resolution)}`)
  assert(resolution.resolved.length === 1 && resolution.resolved[0].store.store_id === aIdnAfter.active_id,
    `lib-level resolution must hit A's CURRENT active_id (alias hop): got ${JSON.stringify(resolution.resolved)}`)
  // (3) NO already-promoted skip assertion (em-promote-internal, S3-frozen).
  //     Comment records the observed disposition per §19.3d.
  //     Observed: candidates=[{hash: <new>, ...}], skipped=[], missing_sources=[].
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('gauntlet::testCloneRebindSingleActiveChain', () => {
  // REQ-14 (full §A.7-S3 clause + §19.3e B1): clone B → C, detach on C,
  // rebuild C, re-register C, then probe identity and source-resolution.
  // resolveStoreIdentity(C) → one active chain, aliases empty.
  // resolveSourceRefs on B's pre-clone id resolves to B's row ONLY (never C).
  const w = mkWorld('clone')
  const a = w.project('projA')
  const b = w.project('projB')
  const bIdnBefore = resolveStoreIdentity(path.join(b, '.episodic-memory'))
  const aCurrent = resolveStoreIdentity(path.join(a, '.episodic-memory'))
  const c = path.join(w.root, 'projC')
  fs.cpSync(path.join(b, '.episodic-memory'), path.join(c, '.episodic-memory'), { recursive: true })
  detachStoreIdentity(path.join(c, '.episodic-memory'))
  // (1) spawn a real rebuild of C (S1-suite shape: scratch HOME, cwd=project).
  const rb = spawnSync(process.execPath,
    [path.join(REPO, 'scripts/em-rebuild-index.mjs'), '--scope', 'local'],
    { cwd: c, env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' })
  assert(rb.status === 0, `rebuild of C must exit 0: exit=${rb.status} stderr=${rb.stderr} stdout=${rb.stdout}`)
  // (2) re-register C in the mock registry via the mkWorld harness path.
  const cIdnForReg = resolveStoreIdentity(path.join(c, '.episodic-memory'))
  w.register(c, cIdnForReg)
  // (3) one active chain, aliases empty.
  const cIdn = resolveStoreIdentity(path.join(c, '.episodic-memory'))
  assert(!cIdn.error, `C must have a healthy chain: ${JSON.stringify(cIdn)}`)
  assert(Array.isArray(cIdn.aliases) && cIdn.aliases.length === 0,
    `detached chain must have zero aliases: ${JSON.stringify(cIdn)}`)
  // (4) resolveSourceRefs on B's pre-clone store_id resolves to B's row ONLY.
  // The detached chain is INERT: its root carries detaches_identity_root
  // pointing at B's root, and cIdn.aliases is empty by construction. B keeps
  // its own chain intact, so B's pre-clone store_id is B's CURRENT active id.
  const bIdn = resolveStoreIdentity(path.join(b, '.episodic-memory'))
  assert(bIdn.active_id === bIdnBefore.active_id, `B's chain must NOT be affected by detach on C: got ${bIdn.active_id}, want ${bIdnBefore.active_id}`)
  const registry = [
    { store_id: aCurrent.active_id, store_aliases: aCurrent.aliases },
    { store_id: bIdn.active_id, store_aliases: bIdn.aliases },
    { store_id: cIdn.active_id, store_aliases: cIdn.aliases },
  ]
  const preCloneRef = [{ store_id: bIdnBefore.active_id, episode_id: 'probe', content_sha256: '0'.repeat(64) }]
  const res = resolveSourceRefs(preCloneRef, registry)
  assert(res.missing.length === 0, `B's pre-clone store_id must resolve in the registry: ${JSON.stringify(res)}`)
  assert(res.resolved.length === 1 && res.resolved[0].store.store_id === bIdn.active_id,
    `B's pre-clone store_id must resolve to B's row ONLY (not C's): got ${JSON.stringify(res.resolved)}`)
  // (5) zero inherited aliases for the detached chain (asserted at (3)).
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('gauntlet::testCrashBeforeRebindCopyUnrebound', () => {
  // S1 childMint shape (positional BEFORE the flag so argv reaches the script;
  // `node -e <code> --flag` is rejected as `bad option` and the code never
  // runs — §19.3e B3 fix). The child's stdout JSON MUST parse to
  // {"error":"break-identity-write"} to prove the break path actually executed;
  // the file-system invariant (no new .md in C, inherited chain intact) is
  // the negative-control side.
  const w = mkWorld('crashrebind')
  const b = w.project('projB')
  const c = path.join(w.root, 'projC')
  fs.cpSync(path.join(b, '.episodic-memory'), path.join(c, '.episodic-memory'), { recursive: true })
  const inherited = resolveStoreIdentity(path.join(b, '.episodic-memory'))
  const cDir = path.join(c, '.episodic-memory')
  const child = spawnSync(process.execPath,
    ['--input-type=module', '-e',
     `import('./scripts/lib/store-identity.mjs').then(m => { const r = m.detachStoreIdentity(${JSON.stringify(cDir)}, {}); console.log(JSON.stringify(r)); })`,
     cDir,
     '--break-identity-write'],
    { cwd: REPO, env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' })
  // Prove the break path actually executed.
  const childOut = JSON.parse(child.stdout)
  assert(childOut && childOut.error === 'break-identity-write',
    `child must run the break path (positional argv shape): got ${child.stdout}\n${child.stderr}`)
  const episodes = fs.readdirSync(path.join(cDir, 'episodes')).filter(f => f.endsWith('.md') && !f.endsWith('.tmp-identity'))
  const initial = fs.readdirSync(path.join(b, '.episodic-memory', 'episodes')).filter(f => f.endsWith('.md')).length
  assert(episodes.length === initial, `no new identity .md lands in C: initial=${initial} after=${episodes.length}`)
  const cIdn = resolveStoreIdentity(cDir)
  assert(cIdn.active_id === inherited.active_id, `inherited chain still resolves: got ${cIdn.active_id}, want ${inherited.active_id}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('gauntlet::testDuplicateChainFailsLoudPromotionSurface', () => {
  // Two hand roots in store A; promote dry-run must exit 0 with a `warnings`
  // entry for A matching `store identity unavailable`.
  const w = mkWorld('dupchain')
  const a = w.project('projA')
  const aDir = path.join(a, '.episodic-memory')
  const id0 = crypto.randomBytes(8).toString('hex')
  const id1 = crypto.randomBytes(8).toString('hex')
  for (const [suffix, id] of [['aaaa', id0], ['bbbb', id1]]) {
    const epDir = path.join(aDir, 'episodes')
    fs.mkdirSync(epDir, { recursive: true })
    fs.writeFileSync(path.join(epDir, `19990101-000000-store-identity-${suffix}.md`),
      `---\nid: 19990101-000000-store-identity-${suffix}\ndate: 1999-01-01\ntime: "00:00:00"\nproject: duptest\ncategory: context\nstatus: active\ntags: [store-identity]\nsummary: Dup root ${suffix}\nrecord_type: store-identity\nstore_id: ${id}\n---\n\n# Dup root ${suffix}\nDup.\n`)
  }
  // Rebuild the index so the duplicate chain is detectable.
  spawnSync(process.execPath, [path.join(REPO, 'scripts/em-rebuild-index.mjs'), '--scope', 'local'],
    { cwd: a, env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' })
  w.project('projB') // second registered store so the scan runs
  const r = w.promote()
  const out = parse(r)
  assert(r.status === 0, `dry-run must not block on duplicate chains (exit ${r.status}, stderr=${r.stderr})`)
  assert(Array.isArray(out.warnings) && out.warnings.some(x => /projA$/.test(String(x.store)) && /store identity/i.test(x.problem)),
    `warnings must surface duplicate-chain for projA: ${JSON.stringify(out.warnings)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('gauntlet::testUnresolvedAliasSurfacesMissing', () => {
  // Hand-authored global promotion whose promotion_sources names an unowned
  // 16-hex id; dry-run → missing_sources contains that ref. S2's
  // --promotion-sources-json flag is the only writer that lets us plant a
  // bogus store_id in the registered-set-backed resolved/missing lookup.
  const w = mkWorld('unres')
  const a = w.project('projA')
  const b = w.project('projB')
  w.lesson(a, 'always quote hook command paths', RECUR_BODY)
  w.lesson(b, 'always quote hook command paths in hooks', RECUR_BODY)
  const first = parse(w.promote(['--apply']))
  assert(first.promoted.length === 1, `seed promote: ${JSON.stringify(first)}`)
  const bogus = crypto.randomBytes(8).toString('hex')
  const bogusEp = '20990101-bogus-source-id'
  const bogusSha = 'a'.repeat(64)
  const srcJson = JSON.stringify([{ store_id: bogus, episode_id: bogusEp, content_sha256: bogusSha }])
  const seeded = spawnSync(process.execPath, [STORE,
    '--scope', 'global', '--project', 'cross-project', '--category', 'lesson',
    '--tags', 'promoted-lesson,bogus-source-test',
    '--summary', 'Bogus-source-test promotion',
    '--body', 'Plant a bogus promotion_sources ref.',
    '--promotion-sources-json', srcJson],
  { cwd: w.root, env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' })
  const seededOut = JSON.parse(seeded.stdout)
  assert(seeded.status === 0 && seededOut.status === 'ok', `seed bogus promotion: ${seeded.stdout}${seeded.stderr}`)
  const out = parse(w.promote())
  assert(Array.isArray(out.missing_sources), 'missing_sources must be an array')
  assert(out.missing_sources.some(s => s.store_id === bogus),
    `bogus alias must surface in missing_sources: ${JSON.stringify(out.missing_sources)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// REQ-16/S4 fingerprint revalidation: registered ONLY as `skip` (phase-end
// criterion per §14 Group 5 note).
skip('gauntlet::testFingerprintRevalidation', 'REQ-16/S4 — post-preview source substitution fails fingerprint revalidation; enabled in S4 per §14 Group 5 note')

// §19.3e B2 regression tests: the three crash-class guards (entry-side and
// descriptor-side) added to validate-plugin-registry.mjs in this round must
// not throw on malformed inputs — they must emit typed M1/L-schema violations
// instead. Negative controls; a silent success masks the real bug.

// B2a: a learning entry missing `descriptor` must fail with M1, not TypeError.
// Batch-3 fold: assert EXACT violation set (target check present, no M8 noise
// from missing reserved dirs / entry directories, no TypeError).
t('gauntlet::testMalformedLearningEntryNoCrash', () => {
  const slim = [{
    type: 'learning', id: 'em-promote', version: '1.0.0',
    module: 'scripts/em-promote.mjs', status: 'active', // descriptor intentionally omitted
  }]
  const tmp = mkRegistryRoot({ indexSlim: slim })
  try {
    const r = validateRegistry({ projectRoot: tmp })
    assert(r.status === 'fail', `must return fail, not throw: ${JSON.stringify(r)}`)
    assert(r.violations.some(v => v.check === 'M1'),
      `target check M1 must be present: ${JSON.stringify(r.violations)}`)
    assert(!r.violations.some(v => v.check === 'M8'),
      `zero M8 violations expected (mkRegistryRoot scaffolds reserved + entry dirs): ${JSON.stringify(r.violations)}`)
    assert(!r.violations.some(v => /TypeError/.test(v.detail || '')),
      `no TypeError: ${JSON.stringify(r.violations)}`)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

// B2b: a JSON-`null` descriptor must emit L-schema, not crash the validator.
// Asserted in BOTH registry mode AND single-manifest `--manifest` mode.
// Batch-3 fold: tighten with zero-M8 + no-TypeError contracts (the EXACT set).
t('gauntlet::testNullDescriptorNoCrash', () => {
  const slim = [{
    type: 'learning', id: 'em-promote', version: '1.0.0',
    module: 'scripts/em-promote.mjs', descriptor: 'learning/em-promote.json', status: 'active',
  }]
  const tmp = mkRegistryRoot({ indexSlim: slim })
  try {
    // Overwrite the copied descriptor file with JSON `null`.
    fs.writeFileSync(path.join(tmp, 'learning/em-promote.json'), 'null')
    const r = validateRegistry({ projectRoot: tmp })
    assert(r.status === 'fail', `must return fail, not throw: ${JSON.stringify(r)}`)
    assert(r.violations.some(v => v.check === 'L-schema'),
      `target check L-schema must be present: ${JSON.stringify(r.violations)}`)
    assert(!r.violations.some(v => v.check === 'M8'),
      `zero M8 violations expected: ${JSON.stringify(r.violations)}`)
    assert(!r.violations.some(v => /TypeError/.test(v.detail || '')),
      `no TypeError: ${JSON.stringify(r.violations)}`)
    // Single-manifest mode: same descriptor, fresh validator path.
    const CLI = spawnSync(process.execPath,
      [path.join(REPO, 'scripts/validate-plugin-registry.mjs'),
       '--project', tmp, '--manifest', 'learning/em-promote.json', '--json'],
      { encoding: 'utf8' })
    assert(CLI.status === 1, `CLI must exit 1 on null descriptor: exit=${CLI.status} stderr=${CLI.stderr}`)
    const cliJson = parseJsonOrNull(CLI.stdout)
    assert(cliJson && cliJson.violations && cliJson.violations.some(v => v.check === 'L-schema'),
      `CLI target check L-schema must be present: ${CLI.stdout}`)
    assert(!cliJson.violations.some(v => /TypeError/.test(v.detail || '')),
      `CLI no TypeError: ${CLI.stdout}`)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

// B2c (parity): an activation entry missing `manifest` must emit M1, not crash.
// Batch-3 fold: tighten with zero-M8 + no-TypeError contracts (the EXACT set).
t('gauntlet::testActivationManifestParityNoCrash', () => {
  // Slim activation entry: manifest deliberately omitted to exercise the guard.
  const slimAct = [{
    type: 'activation', id: 'claude-code', harness: 'claude-code',
    directory: 'plugins/claude-code-activation', blocking: false,
    capabilities: { pre_tool_use: 'STRONG' },
    // manifest omitted
    status: 'active',
  }]
  const tmp = mkRegistryRoot({ indexSlim: slimAct })
  try {
    const r = validateRegistry({ projectRoot: tmp })
    assert(r.status === 'fail', `must return fail, not throw: ${JSON.stringify(r)}`)
    assert(r.violations.some(v => v.check === 'M1'),
      `target check M1 must be present: ${JSON.stringify(r.violations)}`)
    assert(!r.violations.some(v => v.check === 'M8'),
      `zero M8 violations expected (mkRegistryRoot scaffolds reserved + entry dirs): ${JSON.stringify(r.violations)}`)
    assert(!r.violations.some(v => /TypeError/.test(v.detail || '')),
      `no TypeError: ${JSON.stringify(r.violations)}`)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

function parseJsonOrNull(s) { try { return JSON.parse(s) } catch { return null } }

console.log(`${pass} pass, ${fail} fail, ${skipped} skipped`)
process.exit(fail > 0 ? 1 : 0)
