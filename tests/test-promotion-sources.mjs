#!/usr/bin/env node
// RFC-012 P2 S2: typed promotion provenance and content-bound identity.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { computeContentSha256, resolveSourceRefs, serializePromotionSources } from '../scripts/lib/promotion-sources.mjs'
import { mintStoreIdentity, resolveStoreIdentity } from '../scripts/lib/store-identity.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const REVISE = path.join(REPO, 'scripts', 'em-revise.mjs')
const REBUILD = path.join(REPO, 'scripts', 'em-rebuild-index.mjs')
const PROMOTE = path.join(REPO, 'scripts', 'em-promote.mjs')
const HASH_A = 'a'.repeat(64)
const ONLY_FLAG = process.argv.indexOf('--only')
const ONLY = ONLY_FLAG >= 0 ? process.argv[ONLY_FLAG + 1] : null

function assert(value, message) { if (!value) throw new Error(message) }
function json(result) {
  try { return JSON.parse(result.stdout) } catch { throw new Error(`non-JSON stdout: ${result.stdout}\n${result.stderr}`) }
}
function run(script, args, cwd, home) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
}
function treeDigest(dir) {
  if (!fs.existsSync(dir)) return 'absent'
  const h = crypto.createHash('sha256')
  function walk(p, rel = '') {
    for (const name of fs.readdirSync(p).sort()) {
      const full = path.join(p, name); const child = path.join(rel, name); const st = fs.statSync(full)
      h.update(child + (st.isDirectory() ? '/' : '\0'))
      if (st.isDirectory()) walk(full, child); else h.update(fs.readFileSync(full))
    }
  }
  walk(dir)
  return h.digest('hex')
}
function world(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `promotion-sources-${name}-`))
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true })
  const entries = []
  function project(label) {
    const dir = path.join(root, label); const data = path.join(dir, '.episodic-memory')
    fs.mkdirSync(data, { recursive: true }); mintStoreIdentity(data)
    const idn = resolveStoreIdentity(data)
    entries.push({ project_path: dir, tool: 'claude-code', version: 'v1', enforcement_installed: false, last_install_ts: '2026-07-19T00:00:00Z', store_id: idn.active_id, store_aliases: idn.aliases })
    fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'), JSON.stringify({ schema_version: 2, entries }, null, 2))
    return { dir, data, store_id: idn.active_id }
  }
  function store(p, extra = []) {
    return run(STORE, ['--project', path.basename(p.dir), '--category', 'lesson', '--summary', 'typed provenance lesson', '--body', 'quote hook paths consistently across tools', '--scope', 'local', ...extra], p.dir, home)
  }
  function lesson(p, summary, body) {
    return run(STORE, ['--project', path.basename(p.dir), '--category', 'lesson', '--summary', summary, '--body', body, '--scope', 'local'], p.dir, home)
  }
  function rows(data) {
    const f = path.join(data, 'index.jsonl'); if (!fs.existsSync(f)) return []
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  }
  return { root, home, project, store, lesson, rows, cleanup() { fs.rmSync(root, { recursive: true, force: true }) } }
}
function source(storeId, episodeId = 'episode,with,punctuation', hash = HASH_A) {
  return { store_id: storeId, episode_id: episodeId, content_sha256: hash }
}
function rejectedCase(name, value, category = 'lesson') {
  const w = world(name); const p = w.project('p'); const before = treeDigest(p.data)
  const r = run(STORE, ['--project', 'p', '--category', category, '--summary', 'reject me', '--body', 'no mutation', '--scope', 'local', '--promotion-sources-json', JSON.stringify(value)], p.dir, w.home)
  const after = treeDigest(p.data); w.cleanup()
  return { r, out: json(r), before, after }
}

const tests = []
function t(name, fn) { if (!ONLY || name.includes(ONLY)) tests.push([name, fn]) }

t('testPromotionSourcesWrite', () => {
  const w = world('write'); const p = w.project('p'); const refs = [source(p.store_id)]
  const r = w.store(p, ['--promotion-sources-json', JSON.stringify(refs)]); const out = json(r)
  assert(r.status === 0, r.stdout + r.stderr)
  const content = fs.readFileSync(out.file, 'utf8')
  assert(content.includes(`promotion_sources: ${serializePromotionSources(refs)}`), 'canonical frontmatter missing')
  assert(JSON.stringify(w.rows(p.data).find(row => row.id === out.id)?.promotion_sources) === serializePromotionSources(refs), 'index field missing')
  w.cleanup()
})

t('testPromotionSourcesRoundTrip', () => {
  const w = world('roundtrip'); const p = w.project('p'); const refs = [source(p.store_id)]
  w.store(p, ['--promotion-sources-json', JSON.stringify(refs)])
  const before = w.rows(p.data)[1]?.promotion_sources || w.rows(p.data)[0].promotion_sources
  const r = run(REBUILD, ['--scope', 'local'], p.dir, w.home)
  assert(r.status === 0, r.stdout + r.stderr)
  const row = w.rows(p.data).find(x => x.promotion_sources)
  assert(JSON.stringify(row.promotion_sources) === JSON.stringify(before), 'rebuild changed typed sources')
  const indexPath = path.join(p.data, 'index.jsonl')
  const indexBeforeMalformed = fs.readFileSync(indexPath)
  const episodePath = fs.readdirSync(path.join(p.data, 'episodes')).map(name => path.join(p.data, 'episodes', name))
    .find(file => fs.readFileSync(file, 'utf8').includes('promotion_sources:'))
  fs.writeFileSync(episodePath, fs.readFileSync(episodePath, 'utf8').replace(/^promotion_sources: .*$/m, 'promotion_sources: [{'))
  const malformed = run(REBUILD, ['--scope', 'local'], p.dir, w.home)
  assert(malformed.status === 1 && json(malformed).error === 'structured-frontmatter-invalid', malformed.stdout + malformed.stderr)
  assert(fs.readFileSync(indexPath).equals(indexBeforeMalformed), 'malformed rebuild mutated index')
  w.cleanup()
})

t('testReviseInherit', () => {
  const w = world('revise'); const p = w.project('p'); const refs = [source(p.store_id)]
  const first = json(w.store(p, ['--promotion-sources-json', JSON.stringify(refs)]))
  const r = run(REVISE, ['--original', first.id, '--summary', 'revised typed provenance', '--body', 'correction', '--scope', 'inherit'], p.dir, w.home)
  assert(r.status === 0, r.stdout + r.stderr)
  const revisionId = json(r).id
  assert(JSON.stringify(w.rows(p.data).find(x => x.id === revisionId).promotion_sources) === serializePromotionSources(refs), 'revision lost provenance')
  const beforeReject = treeDigest(p.data)
  const rejected = run(REVISE, ['--original', revisionId, '--summary', 'must reject empty provenance', '--body', 'no mutation', '--scope', 'inherit', '--promotion-sources-json', '[]'], p.dir, w.home)
  assert(rejected.status === 1 && json(rejected).error === 'promotion-sources-empty', rejected.stdout + rejected.stderr)
  assert(treeDigest(p.data) === beforeReject, 'bad revise override mutated store')
  w.cleanup()
})

t('testCommaValueByteRoundTrip', () => {
  const w = world('comma'); const p = w.project('p'); const refs = [source(p.store_id, 'id,with,[json]-safe punctuation')]
  const out = json(w.store(p, ['--promotion-sources-json', JSON.stringify(refs)]))
  const before = fs.readFileSync(out.file, 'utf8').match(/^promotion_sources: (.*)$/m)[1]
  run(REBUILD, ['--scope', 'local'], p.dir, w.home)
  const after = serializePromotionSources(w.rows(p.data).find(x => x.id === out.id).promotion_sources)
  assert(after === before, `${before} != ${after}`); w.cleanup()
})

t('testEmptySourcesReject', () => { const x = rejectedCase('empty', []); assert(x.r.status === 1 && x.out.error === 'promotion-sources-empty', JSON.stringify(x.out)); assert(x.before === x.after, 'store mutated') })
t('testShapeReject', () => { const x = rejectedCase('shape', [{ store_id: 'bad', episode_id: 'x', content_sha256: HASH_A }]); assert(x.r.status === 1 && x.out.error === 'promotion-sources-shape', JSON.stringify(x.out)); assert(x.before === x.after, 'store mutated') })
t('testHashReject', () => { const w = world('hash'); const p = w.project('p'); const before = treeDigest(p.data); const r = w.store(p, ['--promotion-sources-json', JSON.stringify([source(p.store_id, 'x', 'A'.repeat(64))])]); assert(r.status === 1 && json(r).error === 'promotion-sources-hash', r.stdout); assert(before === treeDigest(p.data), 'store mutated'); w.cleanup() })
t('testCharsReject', () => { const w = world('chars'); const p = w.project('p'); const before = treeDigest(p.data); const r = w.store(p, ['--promotion-sources-json', JSON.stringify([source(p.store_id, 'bad\u0001id')])]); assert(r.status === 1 && json(r).error === 'promotion-sources-chars', r.stdout); assert(before === treeDigest(p.data), 'store mutated'); w.cleanup() })
t('testLessonOnly', () => { const w = world('lessononly'); const p = w.project('p'); const before = treeDigest(p.data); const r = run(STORE, ['--project', 'p', '--category', 'decision', '--summary', 'wrong category', '--body', 'no', '--scope', 'local', '--promotion-sources-json', JSON.stringify([source(p.store_id)])], p.dir, w.home); assert(r.status === 1 && json(r).error === 'lesson-only', r.stdout); assert(before === treeDigest(p.data), 'store mutated'); w.cleanup() })

t('testNoEarnedPriorityForge', () => {
  const w = world('priority'); const p = w.project('p'); w.store(p, ['--priority', '4', '--promotion-sources-json', JSON.stringify([source(p.store_id, 'violation-looking-id')])])
  const row = w.rows(p.data).find(x => x.category === 'lesson')
  assert(row.priority === 4 && row.evidence === undefined, JSON.stringify(row)); w.cleanup()
})

t('testEvidenceGateUnchanged', () => {
  const w = world('evidence'); const p = w.project('p'); const d = json(run(STORE, ['--project', 'p', '--category', 'decision', '--summary', 'not violation', '--body', 'x', '--scope', 'local'], p.dir, w.home))
  const before = treeDigest(p.data); const r = w.store(p, ['--evidence', d.id])
  assert(r.status === 1 && json(r).wrong_category.includes(d.id), r.stdout); assert(before === treeDigest(p.data), 'store mutated'); w.cleanup()
})

t('testContentShaVector', () => {
  assert(computeContentSha256(Buffer.from('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'fixed vector mismatch')
  const ordered = JSON.parse(serializePromotionSources([source('global', 'é'), source('global', 'z')]))
  assert(ordered[0].episode_id === 'z' && ordered[1].episode_id === 'é', `canonical order is not code-unit lexical: ${JSON.stringify(ordered)}`)
})
t('testCrlfLfIdentical', () => { assert(computeContentSha256(Buffer.from('a\r\nb\r\n')) === computeContentSha256(Buffer.from('a\nb\n')), 'CRLF normalization mismatch') })
t('testResolveSourceRefs', () => { const ref = source('1111111111111111'); const row = { store_id: '0123456789abcdef', store_aliases: ['1111111111111111'] }; const x = resolveSourceRefs([ref], [row]); assert(x.resolved.length === 1 && x.resolved[0].store === row && x.missing.length === 0, JSON.stringify(x)) })
t('testUnresolvedAliasSurfaces', () => { const ref = source('ffffffffffffffff'); const x = resolveSourceRefs([ref], []); assert(x.missing.length === 1 && x.missing[0] === ref, JSON.stringify(x)) })
t('testMissingNeverSilent', () => { const refs = [source('ffffffffffffffff'), source('eeeeeeeeeeeeeeee')]; const x = resolveSourceRefs(refs, []); assert(x.resolved.length === 0 && x.missing.length === refs.length, JSON.stringify(x)) })

function handLesson(p, id, summary, body) {
  const episodes = path.join(p.data, 'episodes'); fs.mkdirSync(episodes, { recursive: true })
  const content = `---\nid: ${id}\ndate: 2026-07-19\ntime: "00:00"\nproject: ${path.basename(p.dir)}\ncategory: lesson\nstatus: active\ntags: []\nsummary: ${summary}\n---\n\n# ${summary}\n\n${body}\n`
  fs.writeFileSync(path.join(episodes, `${id}.md`), content)
  fs.appendFileSync(path.join(p.data, 'index.jsonl'), JSON.stringify({ id, date: '2026-07-19', time: '00:00', project: path.basename(p.dir), category: 'lesson', status: 'active', supersedes: null, tags: [], summary }) + '\n')
}

t('testSameIdSummaryDiffBodyDistinct', () => {
  const w = world('sameid'); const a = w.project('a'); const b = w.project('b'); const id = '20260719-000000-colliding-id'
  handLesson(a, id, 'quote paths in hook commands', 'quote paths in hook commands because spaces split commands alpha')
  handLesson(b, id, 'quote paths in hook commands', 'quote paths in hook commands because spaces split commands beta')
  const out = json(run(PROMOTE, [], w.root, w.home)); assert(out.candidates.length === 1 && out.candidates[0].members.length === 2, JSON.stringify(out)); w.cleanup()
})

t('testReplicaCollapseOnHashMatch', () => {
  const w = world('replica'); const a = w.project('a'); const b = w.project('b'); const id = '20260719-000000-replica-id'; const body = 'same immutable episode body'
  handLesson(a, id, 'same immutable lesson', body)
  fs.copyFileSync(path.join(a.data, 'episodes', `${id}.md`), path.join(b.data, 'episodes', `${id}.md`))
  fs.appendFileSync(path.join(b.data, 'index.jsonl'), JSON.stringify(w.rows(a.data).find(row => row.id === id)) + '\n')
  const out = json(run(PROMOTE, [], w.root, w.home)); assert(out.candidates.length === 0, JSON.stringify(out)); w.cleanup()
})

t('testNewPromotionTyped', () => {
  const w = world('typed'); const a = w.project('a'); const b = w.project('b'); const body = 'always quote hook command paths because paths with spaces split execution'
  w.lesson(a, 'always quote hook command paths', body); w.lesson(b, 'always quote hook paths in commands', body)
  const r = run(PROMOTE, ['--apply'], w.root, w.home); const out = json(r); assert(r.status === 0 && out.promoted.length === 1, r.stdout + r.stderr)
  const row = w.rows(path.join(w.home, '.episodic-memory'))[0]
  assert(Array.isArray(row.promotion_sources) && row.promotion_sources.length === 2, JSON.stringify(row)); w.cleanup()
})

t('testNoSentinelOnNewWrites', () => {
  const w = world('sentinel'); const a = w.project('a'); const b = w.project('b'); const body = 'always quote hook command paths because paths with spaces split execution'
  w.lesson(a, 'always quote hook command paths', body); w.lesson(b, 'always quote hook paths in commands', body)
  json(run(PROMOTE, ['--apply'], w.root, w.home)); const row = w.rows(path.join(w.home, '.episodic-memory'))[0]
  assert(row.project !== 'cross-project', JSON.stringify(row)); assert(!row.tags.some(x => /^promoted:[0-9a-f]{8}$/.test(x)), JSON.stringify(row.tags)); w.cleanup()
})

let passed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); passed++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
console.log(`${passed}/${tests.length} pass`)
process.exit(passed === tests.length ? 0 : 1)
