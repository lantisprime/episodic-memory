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
const EM_CONSOLIDATE = path.join(REPO, 'scripts', 'em-consolidate.mjs')
const EM_TRIGGER = path.join(REPO, 'scripts', 'em-trigger-index.mjs')
const AGED = '2025-05-01'          // score 0.1 < default threshold 0.15
const RECENT = new Date().toISOString().slice(0, 10)
const PAST = '2025-01-01'          // expired review_by

// RFC-011 R5(b) playbook-referenced fixtures use the revision-chain shape the
// substrate actually writes (the successor carries `supersedes`); a referenced
// any-chain-member resolves to the terminal and the chain-closure BFS walks it.
const PB = (id, extra = {}) => ({
  id, date: AGED, time: '00:00', project: 'fx', category: 'lesson', status: 'active',
  supersedes: null, tags: [], summary: `fixture ${id}`, access_count: 0, last_accessed: null, ...extra,
})
function localEpisodes(world) { return path.join(world.proj, '.episodic-memory', 'episodes') }
function archivedCount(world) { const ad = path.join(world.proj, '.episodic-memory', 'archived'); let n = 0; try { for (const f of fs.readdirSync(ad)) if (f.endsWith('.md')) n++ } catch {} return n }
function consolidate(world, args, scope = 'local') {
  const r = spawnSync(process.execPath, [EM_CONSOLIDATE, '--fold-superseded', '--scope', scope, ...args], { cwd: world.proj, env: { ...process.env, HOME: world.home, USERPROFILE: world.home }, encoding: 'utf8' })
  let parsed = null; try { parsed = JSON.parse(r.stdout) } catch {}
  return { status: r.status, out: parsed, raw: r.stdout }
}
function consolidateAllProjects(world, args = []) {
  // --all-projects is mutually exclusive with --scope; --dry-run avoids --confirm.
  const r = spawnSync(process.execPath, [EM_CONSOLIDATE, '--fold-superseded', '--all-projects', ...args], { cwd: world.proj, env: { ...process.env, HOME: world.home, USERPROFILE: world.home }, encoding: 'utf8' })
  let parsed = null; try { parsed = JSON.parse(r.stdout) } catch {}
  return { status: r.status, out: parsed, raw: r.stdout }
}
function buildTrigger(world, extra = []) {
  fs.rmSync(path.join(world.proj, '.episodic-memory', 'trigger-index.json'), { force: true })
  const r = spawnSync(process.execPath, [EM_TRIGGER, '--scope', 'local', ...extra], { cwd: world.proj, env: { ...process.env, HOME: world.home, USERPROFILE: world.home }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`em-trigger-index build failed: ${r.stdout}\n${r.stderr}`)
  return JSON.parse(fs.readFileSync(path.join(world.proj, '.episodic-memory', 'trigger-index.json'), 'utf8'))
}

function row(id, extra = {}) {
  return { id, date: AGED, time: '00:00', project: 'fx', category: 'violation', status: 'active', supersedes: null, tags: [], summary: `fixture ${id}`, access_count: 0, last_accessed: null, ...extra }
}
function mkWorld(localRows, globalRows = [], opts = {}) {
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
  // RFC-011 R5(b) fixtures: a local playbooks.json, a fake installs.json registry,
  // and an optional sibling project (its own store + playbooks.json) enumerated
  // by the registry. Only ever written under the controlled fake HOME / tmp root.
  if (opts.localPlaybooks !== undefined) fs.writeFileSync(path.join(proj, '.episodic-memory', 'playbooks.json'), opts.localPlaybooks)
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true })
  if (opts.sibling) {
    // a registry-enumerated sibling project, isolated under THIS tmp root (never a
    // shared /tmp path); installs.json is synthesized to enumerate it by path.
    const sib = path.join(root, 'sibling')
    fs.mkdirSync(path.join(sib, '.episodic-memory', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(sib, '.episodic-memory', 'index.jsonl'), opts.sibling.index || '\n')
    if (opts.sibling.playbooks !== undefined) fs.writeFileSync(path.join(sib, '.episodic-memory', 'playbooks.json'), opts.sibling.playbooks)
    if (opts.installs === undefined) {
      fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'), JSON.stringify({ schema_version: 1, entries: [{ project_path: sib, tool: 'claude-code' }] }))
    }
  }
  if (opts.installs !== undefined) fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'), opts.installs)
  return { proj, home, root, sibling: opts.sibling ? path.join(root, 'sibling') : null }
}
function prune(world, args, scope = 'local') {
  const r = spawnSync(process.execPath, [SCRIPT, '--scope', scope, ...args], { cwd: world.proj, env: { ...process.env, HOME: world.home, USERPROFILE: world.home }, encoding: 'utf8' })
  // Success: {status:'ok', results:[...]}; R5(b) abort: {status:'error', message}.
  let parsed = null
  try { parsed = JSON.parse(r.stdout) } catch {}
  return { status: r.status, out: parsed && Array.isArray(parsed.results) ? parsed.results[0] : parsed, raw: r.stdout }
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

t('testIdlessReferencerProtectsBothClasses', () => {
  // reviewer F1/F2: an idless valid referencer protects via evidence AND consolidates
  // symmetrically; via renders as null, never dropped from the JSON
  const noIdA = row('x', { category: 'lesson', date: RECENT, evidence: ['va'] })
  delete noIdA.id
  const noIdC = row('y', { category: 'lesson', date: RECENT, consolidates: ['ma'] })
  delete noIdC.id
  const w = mkWorld([row('va'), row('ma', { category: 'lesson', status: 'superseded' }), noIdA, noIdC])
  const dry = prune(w, ['--dry-run']).out
  const va = dry.protected_episodes.find(p => p.id === 'va')
  const ma = dry.protected_episodes.find(p => p.id === 'ma')
  assert(va && va.reason === 'evidence-linked-violation' && va.via === null, `va: ${JSON.stringify(dry.protected_episodes)}`)
  assert(ma && ma.reason === 'consolidates-member' && ma.via === null, `ma: ${JSON.stringify(dry.protected_episodes)}`)
  prune(w, [])
  assert(survives(w, 'va') && survives(w, 'ma'), 'idless-referencer protection asymmetric across classes')
})

t('testNumericIdRowProtected', () => {
  // reviewer F3: a numeric-id row named by a valid lesson's evidence is protected
  // (string-keyed map, String() lookup)
  const w = mkWorld([row(20250101), row('ln', { category: 'lesson', date: RECENT, evidence: ['20250101'] })])
  const r = prune(w, [])
  assert(r.out.protected === 1, `numeric-id row not protected: ${JSON.stringify(r.out)}`)
  const idx = fs.readFileSync(path.join(w.proj, '.episodic-memory', 'index.jsonl'), 'utf8')
  assert(idx.includes('20250101'), 'numeric-id row archived — String() lookup missing')
})

t('testJunkRunRecordIdDoesNotShadow', () => {
  // reviewer F4: a hand-written non-canonical clerk-run id must not shadow the
  // canonical latest run record
  const w = mkWorld([
    row('zzz-handwritten', { category: 'workflow.lifecycle', record_type: 'clerk-run' }),
    row('20250502-000001-run-new', { category: 'workflow.lifecycle', record_type: 'clerk-run' }),
  ])
  prune(w, [])
  assert(survives(w, '20250502-000001-run-new'), 'canonical latest run record archived — junk id shadowed it')
  assert(!survives(w, 'zzz-handwritten'), 'junk clerk-run row survived — should age out under normal score')
})

t('testDocsGrepGate', () => {
  const guide = fs.readFileSync(path.join(REPO, 'docs', 'EM_SCRIPTS_GUIDE.md'), 'utf8')
  assert(guide.includes('--hermetic'), 'EM_SCRIPTS_GUIDE.md missing --hermetic (RFC-009 P0 docs gate)')
  assert(guide.includes('protected_episodes'), 'EM_SCRIPTS_GUIDE.md missing protected_episodes (RFC-009 P0 docs gate)')
  assert(guide.includes('playbook-referenced'), 'EM_SCRIPTS_GUIDE.md missing playbook-referenced (RFC-011 R5b docs gate)')
  assert(guide.includes('fail-closed') || guide.includes('FAILS CLOSED'), 'EM_SCRIPTS_GUIDE.md missing the R5b fail-closed abort wording')
})

// ---------------------------------------------------------------------------
// RFC-011 R5(b) — playbook-referenced chain protection + SCOPED fail-closed abort.
// Plan §14 T7 extension (+6 legs + absent-file + R5a unpinned warning + docs gate).
// Each leg asserts captured JSON AND on-disk evidence; the fail-closed legs assert
// ZERO files moved (archived-on-disk count), not just the exit code.
// ---------------------------------------------------------------------------

t('testPlaybookReferencedChainSurvivesLocal', () => {
  // chain: pb-0 <- pb-1 <- pb-2(active terminal). playbooks.json refs the
  // INTERMEDIATE pb-1. All aged -> prunable without protection; the resolved chain
  // (terminal + members) survives with reason playbook-referenced / chain-member.
  const chain = [
    PB('pb-0', { status: 'superseded' }),
    PB('pb-1', { status: 'superseded', supersedes: 'pb-0' }),
    PB('pb-2', { supersedes: 'pb-1' }),
  ]
  const w = mkWorld(chain, [], { localPlaybooks: JSON.stringify({ schema_version: 1, playbooks: [{ id: 'pb-1', mode: 'session_start' }] }) })
  const dry = prune(w, ['--dry-run']).out
  const via = dry.protected_episodes.find(p => p.id === 'pb-1')
  const term = dry.protected_episodes.find(p => p.id === 'pb-2')
  assert(via && via.reason === 'playbook-referenced' && via.via === 'pb-1', `pb-1 not playbook-referenced: ${JSON.stringify(dry.protected_episodes)}`)
  assert(term && term.reason === 'playbook-referenced', `terminal pb-2 not playbook-referenced: ${JSON.stringify(dry.protected_episodes)}`)
  assert(dry.protected_episodes.find(p => p.id === 'pb-0' && p.reason === 'chain-member'), `pb-0 not chain-member: ${JSON.stringify(dry.protected_episodes)}`)
  prune(w, [])
  for (const id of ['pb-0', 'pb-1', 'pb-2']) assert(survives(w, id), `${id} archived — playbook-referenced chain broken`)
})

t('testPlaybookReferencedRegistryGlobal', () => {
  // a SECOND mock project (registry-enumerated) declares a playbook referencing a
  // GLOBAL episode; the global leg must protect it (--scope global).
  const gid = '20260708-000000-global-pb-registry'
  const w = mkWorld(
    [row('u-local')],
    [PB(gid, { project: 'g', source: 'global' })],
    {
      sibling: { index: '', playbooks: JSON.stringify({ schema_version: 1, playbooks: [{ id: gid, mode: 'session_start' }] }) },
    },
  )
  // global prune: gid is aged + active (prunable without protection) but is
  // referenced via the registry-enumerated sibling's playbooks.json -> survives.
  const r = prune(w, ['--dry-run'], 'global')
  assert(r.status === 0, `global prune failed: ${r.raw}`)
  const dry = r.out
  const gidProt = dry.protected_episodes.find(p => p.id === gid)
  assert(gidProt && gidProt.reason === 'playbook-referenced', `global gid not playbook-referenced: ${JSON.stringify(dry.protected_episodes)}`)
})

t('testCorruptLocalPlaybooksAbortsZeroArchives', () => {
  // present-but-unparseable (torn-write) LOCAL playbooks.json aborts LOCAL
  // archival: exit 1, message names the file, and NOTHING is moved on disk.
  const w = mkWorld([row('u1'), row('keep1', { date: RECENT })], [], { localPlaybooks: '{"schema_version":1,"playbooks":' /* torn mid-write */ })
  const before = fs.readdirSync(localEpisodes(w)).length
  const r = prune(w, [])
  assert(r.status === 1, `abort exit ${r.status}, want 1 (local corrupt must abort)`)
  assert(r.out && r.out.message && r.out.message.includes('playbooks.json'), `message must name playbooks.json: ${r.raw}`)
  // fail-closed on-disk evidence: nothing archived, every episode still present
  assert(archivedCount(w) === 0, 'archives written despite abort — fail-closed broken')
  assert(fs.readdirSync(localEpisodes(w)).length === before, 'episode files moved during abort')
  assert(survives(w, 'u1'), 'u1 archived despite abort — fail-closed on-disk broken')
})

t('testDegradedRegistryAbortsGlobal', () => {
  // installs.json present-but-unparseable -> readRegistry {rebuilt:true} -> the
  // GLOBAL leg aborts (surface the silent degradation, never accept it as empty).
  const w = mkWorld([row('u-local')], [row('u-global', { project: 'g' })], { installs: '{corrupt not json' })
  const before = fs.readdirSync(path.join(w.home, '.episodic-memory', 'episodes')).length
  const r = prune(w, ['--dry-run'], 'global')
  assert(r.status === 1, `abort exit ${r.status}, want 1 (degraded registry must abort global)`)
  assert(r.out && r.out.message && r.out.message.includes('installs.json'), `message must name installs.json: ${r.raw}`)
  // nothing archived in the global store (fail-closed)
  assert(fs.readdirSync(path.join(w.home, '.episodic-memory', 'episodes')).length === before, 'global episodes moved during abort')
})

t('testLocalUnaffectedBySiblingCorrupt', () => {
  // a SIBLING project's corrupt playbooks.json must NOT abort ANOTHER project's
  // LOCAL archival: --scope local never consults the registry (scoped blast radius).
  const w = mkWorld(
    [row('ua'), row('keepA', { date: RECENT })],
    [],
    {
      sibling: { index: '', playbooks: '{corrupt sibling playbooks' },
    },
  )
  const r = prune(w, [])
  assert(r.status === 0, `local prune aborted by sibling corruption: ${r.raw} (scoped blast radius broken)`)
  assert(r.out && r.out.status !== 'error', `local prune errored on sibling: ${r.raw}`)
  assert(!survives(w, 'ua'), 'ua not pruned — local run disrupted by sibling')
  assert(survives(w, 'keepA'), 'keepA archived — local run disrupted by sibling')
})

t('testConsolidateFoldSupersededAbortsCorruptLocal', () => {
  // em-consolidate --fold-superseded binds to the IDENTICAL abort: a corrupt
  // local playbooks.json aborts the fold (exit 1, folds NOTHING).
  const chain = [
    PB('c1', { status: 'superseded' }),
    PB('c2', { status: 'superseded', supersedes: 'c1' }),
    PB('c3', { date: RECENT, supersedes: 'c2' }),
  ]
  const w = mkWorld(chain, [], { localPlaybooks: '{not valid json' })
  const before = fs.readdirSync(localEpisodes(w)).length
  const r = consolidate(w, ['--min-chain', '2'])
  assert(r.status === 1, `consolidate abort exit ${r.status}, want 1 (corrupt local must abort fold)`)
  assert(r.out && r.out.message && r.out.message.includes('playbooks.json'), `message must name playbooks.json: ${r.raw}`)
  assert(fs.readdirSync(localEpisodes(w)).length === before, 'episodes folded during abort — fail-closed broken')
  assert(archivedCount(w) === 0, 'archives written during consolidate abort')
})

t('testAbsentPlaybooksFileNormalOperation', () => {
  // an ABSENT playbooks.json is normal: no abort, no spurious protection, prunable
  // episodes archive as usual (the fail-closed abort is present-but-unparseable only).
  const w = mkWorld([row('u1'), row('keep1', { date: RECENT })])
  assert(!fs.existsSync(path.join(w.proj, '.episodic-memory', 'playbooks.json')), 'fixture precondition: no playbooks.json')
  const r = prune(w, [])
  assert(r.status === 0, `absent-file prune failed: ${r.raw}`)
  assert(!survives(w, 'u1'), 'u1 not pruned on absent playbooks.json')
  assert(survives(w, 'keep1'), 'keep1 archived on absent playbooks.json')
})

t('testConsolidateFoldsUnreferencedButKeepsPlaybookReferencedMember', () => {
  // a playbook-referenced chain is KEPT from the fold (r6-protected, every member);
  // a SEPARATE unreferenced chain folds normally. Proves the protection is scoped to
  // the referenced chain, not a blanket fold-blocker.
  const chainA = [
    PB('a1', { status: 'superseded' }),
    PB('a2', { status: 'superseded', supersedes: 'a1' }),
    PB('a3', { date: RECENT, supersedes: 'a2' }), // terminal
  ]
  const chainB = [
    PB('b1', { status: 'superseded' }),
    PB('b2', { status: 'superseded', supersedes: 'b1' }),
    PB('b3', { date: RECENT, supersedes: 'b2' }), // terminal
  ]
  const w = mkWorld([...chainA, ...chainB], [], { localPlaybooks: JSON.stringify({ schema_version: 1, playbooks: [{ id: 'a2', mode: 'session_start' }] }) })
  const r = consolidate(w, ['--min-chain', '2', '--dry-run'])
  assert(r.status === 0, `dry-run fold failed: ${r.raw}`)
  const byTerminal = new Map(r.out.chains.map(c => [c.terminal, c]))
  const aCh = byTerminal.get('a3'); const bCh = byTerminal.get('b3')
  assert(bCh && bCh.folded.includes('b1') && bCh.folded.includes('b2'), `unreferenced chain B not folded: ${JSON.stringify(bCh)}`)
  assert(aCh, `referenced chain A missing: ${JSON.stringify(r.out.chains)}`)
  assert(aCh.folded.length === 0, `referenced chain A folded members (should be all kept): ${JSON.stringify(aCh)}`)
  assert(aCh.kept.find(k => k.id === 'a2' && k.reason === 'r6-protected:playbook-referenced'), `a2 not kept as playbook-referenced: ${JSON.stringify(aCh.kept)}`)
  assert(aCh.kept.find(k => k.id === 'a1' && k.reason === 'r6-protected:chain-member'), `a1 not kept as chain-member: ${JSON.stringify(aCh.kept)}`)
})

t('testR5aUnpinnedWarningInBuildReport', () => {
  // R5(a): the build report flags an unpinned selected terminal (recommend em-pin).
  // The referenced terminal has no `pinned` field -> warnings.unpinned names it.
  const gid = '20260708-000000-global-pb-unpinned'
  const w = mkWorld(
    [],
    [PB(gid, { project: 'g', source: 'global', summary: 'flagship playbook' })],
    { localPlaybooks: JSON.stringify({ schema_version: 1, playbooks: [{ id: gid, mode: 'session_start' }] }) },
  )
  const ti = buildTrigger(w)
  const warned = ti.build_report.playbooks.warnings && ti.build_report.playbooks.warnings.unpinned
  assert(Array.isArray(warned) && warned.includes(gid), `R5a unpinned warning missing for ${gid}: ${JSON.stringify(ti.build_report.playbooks.warnings)}`)
})

// ---------------------------------------------------------------------------
// R2 fix round (F1/F2/F3): forward-only superseded_by chain survival + --all-projects
// sibling-corrupt abort. The F1 legs assert ON-DISK survival after a REAL prune.
// ---------------------------------------------------------------------------

t('testForwardOnlyChainReferencedTerminalSurvivesOnDisk', () => {
  // F1: chain linked ONLY by superseded_by (no supersedes back-pointers), referencing
  // the TERMINAL f3. Without predecessorsOf, f1+f2 are ARCHIVED on disk. Asserts
  // every member survives a REAL (non-dry) prune.
  const chain = [
    PB('f1', { status: 'superseded', superseded_by: 'f2' }),
    PB('f2', { status: 'superseded', superseded_by: 'f3' }),
    PB('f3', { supersedes: null }), // active terminal
  ]
  const w = mkWorld(chain, [], { localPlaybooks: JSON.stringify({ schema_version: 1, playbooks: [{ id: 'f3', mode: 'session_start' }] }) })
  const r = prune(w, [])
  assert(r.status === 0, `real prune failed: ${r.raw}`)
  assert(r.out.pruned === 0, `forward-only terminal ref pruned ${r.out.pruned} (want 0): ${r.raw}`)
  for (const id of ['f1', 'f2', 'f3']) assert(survives(w, id), `${id} archived — forward-only terminal chain member lost (F1 breach)`)
  assert(archivedCount(w) === 0, `archives written despite forward-only chain protection: ${archivedCount(w)}`)
})

t('testForwardOnlyChainReferencedMiddleSurvivesOnDisk', () => {
  // F1 variant: reference the MIDDLE member f2. terminalOf resolves f2->f3;
  // predecessorsOf must walk f3->f2->f1 backward so f1 survives too.
  const chain = [
    PB('f1', { status: 'superseded', superseded_by: 'f2' }),
    PB('f2', { status: 'superseded', superseded_by: 'f3' }),
    PB('f3', { supersedes: null }),
  ]
  const w = mkWorld(chain, [], { localPlaybooks: JSON.stringify({ schema_version: 1, playbooks: [{ id: 'f2', mode: 'session_start' }] }) })
  const r = prune(w, [])
  assert(r.status === 0, `real prune failed: ${r.raw}`)
  assert(r.out.pruned === 0, `forward-only middle ref pruned ${r.out.pruned} (want 0): ${r.raw}`)
  for (const id of ['f1', 'f2', 'f3']) assert(survives(w, id), `${id} archived — forward-only middle chain member lost (F1 breach)`)
  assert(archivedCount(w) === 0, `archives written despite forward-only chain protection: ${archivedCount(w)}`)
})

t('testConsolidateAllProjectsSiblingCorruptAborts', () => {
  // F2/F3: em-consolidate --fold-superseded --all-projects with a registered sibling
  // whose playbooks.json is present-but-corrupt. The --all-projects pbAbort block
  // (em-consolidate.mjs:322) must abort GLOBAL archival: exit 1, message names the
  // sibling file, ZERO files moved in any store. (Discharges F3: the
  // registered-project-corrupt branch at protection.mjs:157 is the code path exercised.)
  const chain = [
    PB('a1', { status: 'superseded' }),
    PB('a2', { status: 'superseded', supersedes: 'a1' }),
    PB('a3', { date: RECENT, supersedes: 'a2' }),
  ]
  const w = mkWorld(chain, [], {
    sibling: { index: chain.map(r => JSON.stringify(r)).join('\n') + '\n', playbooks: '{corrupt sibling' },
  })
  const localBefore = fs.readdirSync(localEpisodes(w)).length
  const sibBefore = w.sibling ? fs.readdirSync(path.join(w.sibling, '.episodic-memory', 'episodes')).length : -1
  const r = consolidateAllProjects(w, ['--min-chain', '2', '--dry-run'])
  assert(r.status === 1, `--all-projects abort exit ${r.status}, want 1 (sibling corrupt must abort): ${r.raw}`)
  assert(r.out && r.out.message && r.out.message.includes('playbooks.json'), `message must name playbooks.json: ${r.raw}`)
  // F2 on-disk: ZERO files moved in ANY store
  assert(fs.readdirSync(localEpisodes(w)).length === localBefore, 'local episodes moved during --all-projects abort')
  assert(w.sibling && fs.readdirSync(path.join(w.sibling, '.episodic-memory', 'episodes')).length === sibBefore, 'sibling episodes moved during --all-projects abort')
})

let pass = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); pass++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
console.log(`${pass}/${tests.length} pass`)
process.exit(pass === tests.length ? 0 : 1)
