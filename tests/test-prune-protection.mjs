#!/usr/bin/env node
// test-prune-protection.mjs — RFC-009 P0 R6 prune-protection acceptance (plan §14 group R6).
// Each test builds a FRESH isolated store (real prune mutates), spawns the REAL
// script with explicit cwd + controlled HOME, and asserts on captured JSON + disk.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(REPO, 'scripts', 'em-prune.mjs')
const AGED = '2025-05-01'          // score 0.1 < default threshold 0.15
const RECENT = new Date().toISOString().slice(0, 10)
const PAST = '2025-01-01'          // expired review_by

function row(id, extra = {}) {
  return { id, date: AGED, time: '00:00', project: 'fx', category: 'violation', status: 'active', supersedes: null, tags: [], summary: `fixture ${id}`, access_count: 0, last_accessed: null, ...extra }
}
function mkWorld(localRows, globalRows = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-p0-prune-'))
  const proj = path.join(root, 'proj')
  const home = path.join(root, 'home')
  const write = (dir, rows) => {
    fs.mkdirSync(path.join(dir, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    for (const r of rows) fs.writeFileSync(path.join(dir, 'episodes', `${r.id}.md`), `# ${r.id}\n`)
  }
  write(path.join(proj, '.episodic-memory'), localRows)
  fs.mkdirSync(home, { recursive: true })
  if (globalRows.length) write(path.join(home, '.episodic-memory'), globalRows)
  return { proj, home }
}
function prune(world, args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--scope', 'local', ...args], { cwd: world.proj, env: { ...process.env, HOME: world.home, USERPROFILE: world.home }, encoding: 'utf8' })
  return { status: r.status, out: JSON.parse(r.stdout).results[0], raw: r.stdout }
}
function survives(world, id) {
  return fs.existsSync(path.join(world.proj, '.episodic-memory', 'episodes', `${id}.md`)) &&
    fs.readFileSync(path.join(world.proj, '.episodic-memory', 'index.jsonl'), 'utf8').includes(`"${id}"`)
}

const tests = []
const t = (name, fn) => tests.push([name, fn])
function assert(cond, msg) { if (!cond) throw new Error(msg) }

t('testEvidenceLinkedViolationSurvives', () => {
  const w = mkWorld([row('v1'), row('l1', { category: 'lesson', date: RECENT, evidence: ['v1'] })])
  const dry = prune(w, ['--dry-run']).out
  assert(dry.protected === 1 && dry.protected_episodes[0].id === 'v1' && dry.protected_episodes[0].reason === 'evidence-linked-violation' && dry.protected_episodes[0].via === 'l1', `dry-run: ${JSON.stringify(dry)}`)
  prune(w, [])
  assert(survives(w, 'v1'), 'v1 archived despite active evidence link')
})

t('testViolationLessonsBacklinkSurvives', () => {
  const w = mkWorld([row('v2', { lessons: ['l2'] }), row('l2', { category: 'lesson', date: RECENT })])
  prune(w, [])
  assert(survives(w, 'v2'), 'v2 archived despite lessons back-link to active lesson')
})

t('testTriggerBearingLessonSurvives', () => {
  const w = mkWorld([row('l3', { category: 'lesson', triggers: ['second opinion'] })])
  const dry = prune(w, ['--dry-run']).out
  assert(dry.protected_episodes[0].reason === 'trigger-bearing-lesson' && dry.protected_episodes[0].via === 'l3', JSON.stringify(dry))
  prune(w, [])
  assert(survives(w, 'l3'), 'aged active trigger-bearing lesson archived')
})

t('testConsolidatesMemberSurvives', () => {
  const w = mkWorld([row('m4', { category: 'lesson', status: 'superseded' }), row('c4', { category: 'lesson', date: RECENT, consolidates: ['m4'] })])
  prune(w, [])
  assert(survives(w, 'm4'), 'consolidates member archived while consolidated lesson active')
  // class-c lapse leg (codex r2 F2): a superseded consolidating referencer stops protecting
  const w2 = mkWorld([row('m4b', { category: 'lesson', status: 'superseded' }), row('c4b', { category: 'lesson', date: RECENT, status: 'superseded', consolidates: ['m4b'] })])
  prune(w2, [])
  assert(!survives(w2, 'm4b'), 'member survived though its consolidating referencer is superseded — class-c lapse broken')
})

t('testMissingStatusReferencerProtects', () => {
  const noStatus = row('l5', { category: 'lesson', date: RECENT, evidence: ['v5'] })
  delete noStatus.status
  const w = mkWorld([row('v5'), noStatus])
  prune(w, [])
  assert(survives(w, 'v5'), 'missing-status referencer failed to protect (planner F2 class)')
})

t('testProtectionLapseOnSupersede', () => {
  const w = mkWorld([row('v6'), row('l6', { category: 'lesson', date: RECENT, evidence: ['v6'], status: 'superseded' })])
  prune(w, [])
  assert(!survives(w, 'v6'), 'v6 survived though its only referencer is superseded — protection cannot lapse (guard never RED)')
})

t('testExpiredTriggerLessonPrunable', () => {
  const w = mkWorld([row('l7', { category: 'lesson', triggers: ['x'], review_by: PAST })])
  prune(w, [])
  assert(!survives(w, 'l7'), 'expired trigger-bearing lesson survived — review_by lapse broken')
})

t('testExpiredReferencerLapsesEvidence', () => {
  const w = mkWorld([row('v8'), row('l8', { category: 'lesson', date: RECENT, evidence: ['v8'], review_by: PAST })])
  prune(w, [])
  assert(!survives(w, 'v8'), 'evidence of an EXPIRED lesson survived — planner F12 lapse not applied to class a')
})

t('testLatestRunRecordSurvives', () => {
  const w = mkWorld([
    row('20250501-000001-run-old', { category: 'workflow.lifecycle', record_type: 'clerk-run' }),
    row('20250502-000001-run-new', { category: 'workflow.lifecycle', record_type: 'clerk-run' }),
  ])
  prune(w, [])
  assert(survives(w, '20250502-000001-run-new'), 'latest clerk-run archived')
  assert(!survives(w, '20250501-000001-run-old'), 'older clerk-run survived — aging out broken')
})

t('testChainMembersProtected', () => {
  // v10a: chain root (superseded, NO superseded_by field anywhere — forward edge
  // must come from INVERTING v10b.supersedes; planner F1). Both aged.
  const w = mkWorld([
    row('v10a', { status: 'superseded' }),
    row('v10b', { supersedes: 'v10a' }),
    row('l10', { category: 'lesson', date: RECENT, evidence: ['v10a'] }),
    // cycle fixture: mutually superseding aged rows anchored by l11 (EC4)
    row('c1', { supersedes: 'c2' }),
    row('c2', { supersedes: 'c1' }),
    row('l11', { category: 'lesson', date: RECENT, evidence: ['c1'] }),
  ])
  const dry = prune(w, ['--dry-run']).out
  const v10b = dry.protected_episodes.find(p => p.id === 'v10b')
  assert(v10b && v10b.reason === 'chain-member' && v10b.via === 'v10a', `v10b: ${JSON.stringify(dry.protected_episodes)}`)
  prune(w, [])
  for (const id of ['v10a', 'v10b', 'c1', 'c2']) assert(survives(w, id), `${id} archived — chain closure broken`)
})

t('testCrossStoreProtection', () => {
  // global active lesson protects a local violation; a STALE local superseded copy
  // of the same lesson id must not shadow it (union semantics, planner F3)
  const w = mkWorld(
    [row('vl'), row('lg', { category: 'lesson', status: 'superseded' })],
    [row('lg', { category: 'lesson', date: RECENT, evidence: ['vl'] })]
  )
  prune(w, [])
  assert(survives(w, 'vl'), 'cross-store protection failed (or stale local copy shadowed the active global referencer)')
  // missing-global leg: no home store at all → clean run
  const w2 = mkWorld([row('u1')])
  const r = prune(w2, [])
  assert(r.status === 0 && !survives(w2, 'u1'), 'missing global index broke prune')
})

t('testMalformedFieldsTolerated', () => {
  const nan = row('nan1', { date: 'not-a-date' })
  const w = mkWorld([
    row('vm'),
    row('lm1', { category: 'lesson', date: RECENT, evidence: 'vm' }),      // non-array: must NOT protect
    row('lm2', { category: 'lesson', date: RECENT, triggers: 42 }),        // non-array: no crash
    nan,                                                                    // NaN score: survives (EC11, pinned)
  ])
  const r = prune(w, [])
  assert(r.status === 0, `malformed fields crashed prune: ${r.raw}`)
  assert(!survives(w, 'vm'), 'string evidence field protected vm — malformed must not protect')
  assert(survives(w, 'nan1'), 'NaN-date row was archived — EC11 contract broken')
})

t('testProtectedCountInOutput', () => {
  const mk = () => mkWorld([row('vp'), row('lp', { category: 'lesson', date: RECENT, evidence: ['vp'] }), row('u2'), row('k1', { date: RECENT })])
  // 4 rows: vp protected-aged, u2 unprotected-aged, lp + k1 recent
  const chk = prune(mk(), ['--check'])
  assert(chk.out.prunable === 1 && chk.out.remaining === 3 && chk.out.protected === 1, `check: ${JSON.stringify(chk.out)}`)
  assert(chk.status === 1, `check exit ${chk.status}, want 1 (u2 prunable)`)
  const dry = prune(mk(), ['--dry-run']).out
  assert(dry.prunable === 1 && dry.remaining === 3 && dry.protected === 1, `dry: ${JSON.stringify(dry)}`)
  assert(dry.episodes.length === 1 && dry.episodes[0].id === 'u2', `dry preview: ${JSON.stringify(dry.episodes)}`)
  assert(dry.protected_episodes.length === 1 && dry.protected_episodes[0].via === 'lp', `dry protected: ${JSON.stringify(dry.protected_episodes)}`)
  const real = prune(mk(), []).out
  assert(real.pruned === 1 && real.remaining === 3 && real.protected === 1, `real: ${JSON.stringify(real)}`)
  // partition invariant, all three modes: 4 = remaining + prunable/pruned
})

let pass = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); pass++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
console.log(`${pass}/${tests.length} pass`)
process.exit(pass === tests.length ? 0 : 1)
