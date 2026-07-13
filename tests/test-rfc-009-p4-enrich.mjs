#!/usr/bin/env node
/**
 * test-rfc-009-p4-enrich.mjs — RFC-009 P4-S6 (R9c enrichment backfill, REQ-14).
 *
 * Proves the clerk enrich mode of scripts/em-consolidate.mjs:
 *   - lexical candidate finder: proposes triggers (from summary + tag
 *     lexemes), applies_to_project/applies_to_tool (from the episode's OWN
 *     project and tool provenance fields ONLY — never widened, REQ-14
 *     hard stop);
 *   - per-item confirmation gating: --confirm or --reject-member <id>;
 *   - APPLY writes via em-revise AS-IS as a subprocess (spawnSync idiom at
 *     scripts/em-capture.mjs:453) and the target episode is actually
 *     revised on disk (supersedes chain + activation fields present);
 *   - run-record written under the SAME CLERK_LOCK_FILE the S4 apply
 *     path uses (one lock, one writer — reuse, never a second lock).
 *
 * Every assertion inspects real captured runtime state (parsed JSON,
 * on-disk frontmatter, index rows, spawn stdout/exit) with a discriminating
 * sentinel — never a typed constant. The clerk is spawned via the REAL
 * scripts/em-consolidate.mjs with cwd into isolated fixture stores under
 * /tmp and an isolated HOME (so the GLOBAL store is contained).
 *
 * Negative control (§A.9, portable --break-* argv flag, NOT env var — the
 * clerk + tests must run under Windows `cmd`):
 *   --break-scope        → widen candidate scope beyond provenance
 *                           → enrich::scopeFromProvenanceOnly FAILS
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tryAcquire, release } from '../scripts/lib/lock.mjs'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'em-consolidate.mjs')
const REVISE = path.join(REPO_ROOT, 'scripts', 'em-revise.mjs')

// Suite-level --break-* passthrough: forward ONLY the S6-documented break flags
// (--break-scope for scopeFromProvenanceOnly; --break-confirm for the
// noConfirmNoWrite red control — mirrors S4's --break-confirm).
const PASS_THROUGH_BREAK_FLAGS = new Set()
for (const flag of ['--break-scope', '--break-confirm']) {
  if (process.argv.includes(flag)) PASS_THROUGH_BREAK_FLAGS.add(flag)
}

let pass = 0, fail = 0
const failures = []
const ONLY_FLAG = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null })()
function t(name, fn) {
  if (ONLY_FLAG && !name.includes(ONLY_FLAG)) return
  try { fn(); pass++ }
  catch (e) { fail++; failures.push(`${name} - ${e && e.message}`) }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
}
function ok(cond, label) { if (!cond) throw new Error(label) }

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
function mkTmp(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p4s6-${label}-`)))
  _tmpDirs.push(base)
  return base
}

// Build a minimal but valid local store under <root>/.episodic-memory/ + an
// isolated fixture HOME so the GLOBAL store is contained. em-consolidate's
// loadCategories() guard fails closed at startup without a reachable
// categories.json — copy the real one into the fixture data dir.
function mkStore(label) {
  const root = mkTmp(`store-${label}`)
  const dataDir = path.join(root, '.episodic-memory')
  const episodesDir = path.join(dataDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const fixtureHome = mkTmp(`home-${label}`)
  fs.mkdirSync(path.join(fixtureHome, '.episodic-memory'), { recursive: true })
  const realCats = path.join(REPO_ROOT, 'categories.json')
  if (fs.existsSync(realCats)) {
    fs.copyFileSync(realCats, path.join(dataDir, 'categories.json'))
  }
  return { root, dataDir, episodesDir, home: fixtureHome }
}

// Seed one lesson: writes <id>.md AND appends a JSON row to index.jsonl.
function seedLesson(S, o) {
  const {
    id, date = '2026-01-01', time = '00:00', project = 'acme', category = 'lesson',
    status = 'active', tags = [], summary, body = 'body text', triggers = [],
    appliesToProjects = [], appliesToTools = [],
  } = o
  const fm = ['---', `id: ${id}`, `date: ${date}`, `time: "${time}"`, `project: ${project}`, `category: ${category}`, `status: ${status}`]
  fm.push(`tags: [${tags.join(', ')}]`)
  fm.push(`summary: ${summary}`)
  if (triggers.length) fm.push(`triggers: [${triggers.map(x => `"${x}"`).join(', ')}]`)
  if (appliesToProjects.length) fm.push(`applies_to_projects: [${appliesToProjects.map(x => `"${x}"`).join(', ')}]`)
  if (appliesToTools.length) fm.push(`applies_to_tools: [${appliesToTools.map(x => `"${x}"`).join(', ')}]`)
  fm.push('---')
  fs.writeFileSync(path.join(S.episodesDir, `${id}.md`), `${fm.join('\n')}\n\n# ${summary}\n\n${body}\n`, 'utf8')
  const row = {
    id, date, time, project, category, status,
    supersedes: null, consolidates: null,
    tags: tags.slice(), summary,
    ...(triggers.length ? { triggers: triggers.slice() } : {}),
    ...(appliesToProjects.length ? { applies_to_projects: appliesToProjects.slice() } : {}),
    ...(appliesToTools.length ? { applies_to_tools: appliesToTools.slice() } : {}),
  }
  fs.appendFileSync(path.join(S.dataDir, 'index.jsonl'), JSON.stringify(row) + '\n', 'utf8')
}

// Spawn the real em-consolidate.mjs in the fixture. mode: 'apply' adds --apply.
function runClerk(S, { mode = 'report', extraArgs = [], home, lockTimeout } = {}) {
  // mode: 'report' | 'apply' (with --confirm) | 'apply-no-confirm' (no --confirm,
  // used by enrich::noConfirmNoWrite). The 'apply-no-confirm' mode asserts
  // the fail-closed gate fires before any write.
  const confirmFlag = mode === 'apply'
  const applyFlag = mode === 'apply' || mode === 'apply-no-confirm'
  const args = [SCRIPT, '--clerk', '--enrich', ...(applyFlag ? ['--apply'] : []), ...(confirmFlag ? ['--confirm'] : []), '--scope', 'local', ...(lockTimeout ? ['--lock-timeout', String(lockTimeout)] : []), ...extraArgs, ...PASS_THROUGH_BREAK_FLAGS]
  const env = { ...process.env, HOME: home || S.home }
  const r = spawnSync('node', args, { cwd: S.root, encoding: 'utf8', timeout: 120000, env })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, signal: r.signal, errorCode: r.error?.code ?? null, json: parseLastJson(r.stdout) }
}
function parseLastJson(stdout) {
  if (!stdout) return null
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) } catch {}
  }
  return null
}
function indexRows(S) {
  const p = path.join(S.dataDir, 'index.jsonl')
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return { __unparsed: l } } })
}
function runRecordRows(S) { return indexRows(S).filter(r => r.record_type === 'clerk-run') }

// Read the frontmatter of an episode file as a plain object. Handles
// quoted strings, unquoted inline arrays (YAML style: [foo, bar] without
// quotes), plain scalars, and JSON-quoted inline arrays.
function readEpisodeFm(S, id) {
  const content = fs.readFileSync(path.join(S.episodesDir, `${id}.md`), 'utf8')
  const parts = content.split('---')
  if (parts.length < 3) return {}
  const fm = {}
  for (const line of parts[1].split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const raw = m[2].trim()
    if (raw.startsWith('[') && raw.endsWith(']')) {
      // Try JSON first; fall back to unquoted YAML inline-array.
      try { fm[key] = JSON.parse(raw) } catch { fm[key] = raw.slice(1, -1).split(',').map(s => s.trim()) }
    } else if (raw.startsWith('"') && raw.endsWith('"')) {
      fm[key] = raw.slice(1, -1)
    } else {
      const n = Number(raw)
      fm[key] = Number.isFinite(n) && String(n) === raw ? n : raw
    }
  }
  return fm
}

function main() {
  // -- Section 14: R9c-enrich test group (S6) --

  // enrich::lexicalCandidates — the lexical candidate finder proposes
  // triggers extracted from the lesson's summary + tag lexemes. The test
  // seeds a lesson with a unique summary token + tags, runs --clerk --enrich
  // (no --apply, report mode), and asserts the proposal carries the
  // expected lexical triggers.
  t('enrich::lexicalCandidates', () => {
    const S = mkStore('lexcand')
    const SENTINEL = 'lexcandsentinelxyz'
    seedLesson(S, {
      id: '20260101-000000-lc-aaaa',
      project: 'acme',
      summary: `${SENTINEL} lexical candidate fixture summary tokens`,
      tags: ['alpha', 'beta', 'gamma'],
    })
    const r = runClerk(S, { mode: 'report' })
    eq(r.status, 0, `clerk enrich exit 0 (stderr=${r.stderr})`)
    eq(r.json.status, 'ok', 'clerk enrich report ok')
    eq(r.json.mode, 'clerk-enrich', 'mode = clerk-enrich')
    const proposal = r.json.proposals.find(p => p.id === '20260101-000000-lc-aaaa')
    ok(proposal, `proposal present for the seeded lesson (got ${JSON.stringify(r.json.proposals.map(p => p.id))})`)
    const triggers = proposal.candidates.triggers
    ok(triggers.includes(SENTINEL), `sentinel token from summary is a trigger (got ${JSON.stringify(triggers)})`)
    ok(triggers.includes('alpha') && triggers.includes('beta') && triggers.includes('gamma'), `tag lexemes are triggers (got ${JSON.stringify(triggers)})`)
  })

  // enrich::scopeFromProvenanceOnly — applies_to_project carries ONLY the
  // episode's OWN project (NEVER widened, REQ-14). --break-scope widens the
  // scope → the green assertion below fails (the red control).
  t('enrich::scopeFromProvenanceOnly', () => {
    const S = mkStore('scopeonly')
    seedLesson(S, {
      id: '20260101-000000-scope-aaaa',
      project: 'scopeprovenanceonly',
      summary: 'scope provenance only fixture',
      tags: ['scope'],
    })
    const r = runClerk(S, { mode: 'report' })
    eq(r.status, 0, `clerk enrich exit 0 (stderr=${r.stderr})`)
    const proposal = r.json.proposals.find(p => p.id === '20260101-000000-scope-aaaa')
    ok(proposal, 'proposal present')
    const apps = proposal.candidates.applies_to_project
    eq(apps.length, 1, `applies_to_project has exactly 1 entry (the episode's own project; got ${JSON.stringify(apps)})`)
    eq(apps[0], 'scopeprovenanceonly', 'applies_to_project[0] = episode own project')
    const tools = proposal.candidates.applies_to_tool
    eq(tools.length, 0, `applies_to_tool is empty (no tool provenance on the episode; got ${JSON.stringify(tools)})`)
    // RED: --break-scope widens → applies_to_project has more than 1 entry.
    const Sr = runClerk(S, { mode: 'report', extraArgs: ['--break-scope'] })
    eq(Sr.status, 0, 'red: --break-scope still exits 0')
    const proposalR = Sr.json.proposals.find(p => p.id === '20260101-000000-scope-aaaa')
    ok(proposalR.candidates.applies_to_project.length > 1, `red: --break-scope widened scope (applies_to_project has >1 entry, got ${JSON.stringify(proposalR.candidates.applies_to_project)})`)
  })

  // enrich::appliesViaRevise — the em-revise subprocess actually runs and
  // the target episode is revised on disk: a NEW episode with
  // supersedes:<original_id> + the candidate triggers + applies_to_*
  // fields. The original is flipped to status:superseded (em-revise
  // behavior). Discriminating sentinel in the summary makes the
  // revision's provenance verifiable.
  t('enrich::appliesViaRevise', () => {
    const S = mkStore('applyviarevise')
    const ORIGINAL_ID = '20260101-000000-avr-original-aaaa'
    const SENTINEL_TOKEN = 'avrdiscriminatingsentinelxyz'
    seedLesson(S, {
      id: ORIGINAL_ID,
      project: 'avrproject',
      summary: `${SENTINEL_TOKEN} applies via revise fixture summary tokens`,
      tags: ['avr', 'delta', 'epsilon'],
    })
    const r = runClerk(S, { mode: 'apply' })
    eq(r.status, 0, `clerk enrich apply exit 0 (stderr=${r.stderr})`)
    eq(r.json.status, 'ok', 'apply ok')
    eq(r.json.applied.length, 1, `1 lesson enriched (got ${r.json.applied.length})`)
    const revisedId = r.json.applied[0].revised_id
    ok(revisedId && revisedId !== ORIGINAL_ID, `a new revision episode id was created (got ${revisedId})`)
    // The original is now superseded (em-revise behavior).
    const origRow = indexRows(S).find(r => r.id === ORIGINAL_ID)
    ok(origRow, 'original index row still present')
    eq(origRow.status, 'superseded', `original flipped to superseded (em-revise; got ${JSON.stringify(origRow)})`)
    // The revision is on disk with the candidate fields.
    const revisedFm = readEpisodeFm(S, revisedId)
    eq(revisedFm.supersedes, ORIGINAL_ID, 'new revision carries supersedes:<original_id>')
    ok(Array.isArray(revisedFm.triggers) && revisedFm.triggers.includes(SENTINEL_TOKEN), `revision carries the sentinel token as a trigger (got ${JSON.stringify(revisedFm.triggers)})`)
    ok(Array.isArray(revisedFm.triggers) && revisedFm.triggers.includes('avr') && revisedFm.triggers.includes('delta') && revisedFm.triggers.includes('epsilon'), 'revision carries tag lexemes as triggers')
    ok(Array.isArray(revisedFm.applies_to_projects) && revisedFm.applies_to_projects.includes('avrproject'), `revision carries applies_to_projects=[avrproject] (got ${JSON.stringify(revisedFm.applies_to_projects)})`)
    // The revision is also in index.jsonl.
    const revisedRow = indexRows(S).find(r => r.id === revisedId)
    ok(revisedRow, 'revision index row present')
    eq(revisedRow.supersedes, ORIGINAL_ID, 'revision index row carries supersedes')
  })

  // enrich::runRecordUnderLock — the SAME CLERK_LOCK_FILE the S4 apply
  // path uses serializes the enrich apply (one lock, one writer — reuse,
  // never a second lock). The test holds the lock via tryAcquire
  // (imported from scripts/lib/lock.mjs, same as the S4 apply test) and
  // asserts the enrich apply either blocks (returns locked:true) or the
  // run-record is written under the held lock (succeeds after release).
  t('enrich::runRecordUnderLock', () => {
    const S = mkStore('underlock')
    seedLesson(S, {
      id: '20260101-000000-ul-aaaa',
      project: 'ulproject',
      summary: 'run record under lock fixture',
      tags: ['ul'],
    })
    const lockFile = path.join(S.dataDir, 'clerk-apply.lock')
    const h = tryAcquire(lockFile) // this test process (alive) holds it
    ok(h.ok, 'test acquired the clerk lock')
    try {
      // GREEN: enrich apply is blocked by the held lock → returns locked:true.
      const r = runClerk(S, { mode: 'apply', lockTimeout: 1 })
      eq(r.json.locked, true, 'enrich apply reports locked:true under a held lock')
      eq(r.json.code, 'lock-held', 'lock-held error code')
      eq(runRecordRows(S).length, 0, 'no run-record written while lock held')
      // GREEN: after release, the next run succeeds AND writes the run-record.
      release(h.handle)
      const r2 = runClerk(S, { mode: 'apply' })
      eq(r2.status, 0, `green after release: exit 0 (stderr=${r2.stderr})`)
      eq(r2.json.applied.length, 1, 'after release: 1 lesson enriched')
      const rrRows = runRecordRows(S)
      ok(rrRows.length >= 1, `after release: 1 run-record written (got ${rrRows.length})`)
      ok(rrRows[0].record_type === 'clerk-run', 'run-record has record_type:clerk-run')
    } finally {
      // Make sure the lock is released even if the assertions above throw.
      try { release(h.handle) } catch {}
    }
  })

  // enrich::noConfirmNoWrite (GLM review F2) — the enrich apply
  // !confirm fail-closed gate fires BEFORE any write. Mirrors
  // apply::noConfirmNoWrite. --break-confirm bypasses the gate (red
  // control for parity with S4).
  t('enrich::noConfirmNoWrite', () => {
    const SENTINEL_ID = '20260101-000000-encw-aaaa'
    function sha256FileLocal(p) { return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'ABSENT' }
    const S = mkStore('noconfirm-enrich')
    seedLesson(S, {
      id: SENTINEL_ID,
      project: 'encwproject',
      summary: 'enrich no-confirm sentinel fixture',
      tags: ['encw'],
    })
    const indexPre = sha256FileLocal(path.join(S.dataDir, 'index.jsonl'))
    const epCountPre = fs.readdirSync(S.episodesDir).length
    // GREEN: --clerk --enrich --apply WITHOUT --confirm → fail-closed
    // (exit nonzero, code:'unconfirmed', store manifest unchanged).
    const r = runClerk(S, { mode: 'apply-no-confirm' })
    ok(r.status !== 0, `green: enrich apply without --confirm exits non-zero (got ${r.status})`)
    eq(r.json.code, 'unconfirmed', 'green: code === unconfirmed')
    eq(r.json.mode, 'clerk-enrich', 'green: mode === clerk-enrich')
    eq(sha256FileLocal(path.join(S.dataDir, 'index.jsonl')), indexPre, 'green: index.jsonl byte-unchanged (fail-closed before write)')
    eq(fs.readdirSync(S.episodesDir).length, epCountPre, 'green: episodes/ count unchanged (no new revision episode)')
    eq(runRecordRows(S).length, 0, 'green: no run-record written')
    // RED: --break-confirm bypasses the gate → the run proceeds and writes.
    const S2 = mkStore('noconfirm-enrich-red')
    seedLesson(S2, {
      id: SENTINEL_ID,
      project: 'encwproject',
      summary: 'enrich no-confirm sentinel fixture red',
      tags: ['encw'],
    })
    const rRed = runClerk(S2, { mode: 'apply-no-confirm', extraArgs: ['--break-confirm'] })
    eq(rRed.status, 0, 'red: --break-confirm bypasses the gate → exit 0')
    ok(fs.readdirSync(S2.episodesDir).length > epCountPre, 'red: --break-confirm wrote a revision episode')
    ok(runRecordRows(S2).length >= 1, 'red: --break-confirm wrote a run-record')
  })
}

main()
console.log(`test-rfc-009-p4-enrich: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map((f) => `FAIL ${f}`).join('\n')); process.exit(1) }
