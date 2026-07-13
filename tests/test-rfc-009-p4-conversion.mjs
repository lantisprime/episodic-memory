#!/usr/bin/env node
/**
 * test-rfc-009-p4-conversion.mjs — RFC-009 P4-S5 (R6 conversion metric,
 * REQ-18/19/20 + REQ-21 zero-conversion candidate surfacing).
 *
 * Proves the conversion half of the clerk (scripts/em-consolidate.mjs):
 *   - rotate-and-consume: the activation log is renamed to a .processing name
 *     atomically, then parsed (REQ-18, never read-then-truncate-in-place);
 *   - REQ-18 crash recovery: a leftover activation-log.jsonl.processing
 *     from a prior CRASHED rotation is consumed FIRST (folded into the same
 *     report) so the next atomic rename does not silently overwrite it;
 *   - open-window lines (ts within now-window) are carried forward (re-appended
 *     to a fresh log) so a later in-window access is not lost (REQ-18);
 *   - torn / unknown-v lines are skipped and counted in the run-record
 *     (EC8, REQ-18);
 *   - per-band + per-lesson conversion is a binary lower bound: an injection of
 *     id X at time T is converted iff X's last_accessed (read from the store
 *     named by the line's source_scope) falls in (T, T+window] (half-open,
 *     REQ-19);
 *   - an unreadable source_scope store counts as UNCONVERTED (lower bound,
 *     never inflated, REQ-20);
 *   - the conversion report carries lower_bound:true;
 *   - a lesson with N consecutive zero-conversion runs surfaces in the report
 *     as a reword/demote/suppress candidate (REQ-21).
 *
 * Every assertion inspects real captured runtime state (parsed JSON,
 * statSync sizes, on-disk log content, spawn stdout/exit) with a discriminating
 * sentinel — never a typed constant. The clerk is spawned via the REAL
 * scripts/em-consolidate.mjs with cwd into isolated fixture stores under /tmp
 * and an isolated HOME (so the GLOBAL store is contained).
 *
 * Negative controls (§A.9, portable --break-* argv flags, NOT env vars — the
 * activation hook and tests must run under Windows `cmd`):
 *   --break-rotate       → broken read+unlink rotate + SKIP leftover recovery
 *                           → conversion::appendDuringRotateNotLost FAILS
 *                             (leftover .processing is NOT consumed → sentinel
 *                              absent from per_lesson + .processing still on
 *                              disk with the sentinel inside; deterministic,
 *                              race-free, sequential assertion proves recovery
 *                              is wired and the broken path is provably
 *                              non-discriminating)
 *   --break-window       → inclusive lower bound (last_accessed >= ts)
 *                           → conversion::windowBoundary FAILS
 *   --break-sourcescope  → ignore line.source_scope, always read local
 *                           → conversion::crossStoreSourceScope FAILS
 *   --break-tornskip     → throw on torn line instead of skipping+counting
 *                           → conversion::tornLineSkippedCounted FAILS
 *   --break-openwindow   → drop open-window lines instead of carrying forward
 *                           → conversion::openWindowCarriedForward FAILS
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'em-consolidate.mjs')
const SEARCH = path.join(REPO_ROOT, 'scripts', 'em-search.mjs')

// Suite-level --break-* passthrough: a test runner argv flag MUST NOT propagate
// blindly (otherwise --break-X from the suite runner shadows other suites). Forward
// ONLY the five S5-documented break flags (mirrors tests/test-rfc-009-p4-report.mjs
// lines 45-48).
const PASS_THROUGH_BREAK_FLAGS = new Set()
for (const flag of ['--break-rotate', '--break-window', '--break-sourcescope', '--break-tornskip', '--break-openwindow']) {
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
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p4s5-${label}-`)))
  _tmpDirs.push(base)
  return base
}

// Build a minimal but valid local store under <root>/.episodic-memory/ + an
// isolated fixture HOME so the GLOBAL store is contained. em-consolidate's
// loadCategories() guard fails closed at startup without a reachable
// categories.json — copy the real one into the fixture data dir (per the
// report-test pattern).
function mkStore(label) {
  const root = mkTmp(`store-${label}`)
  const dataDir = path.join(root, '.episodic-memory')
  const episodesDir = path.join(dataDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const fixtureHome = mkTmp(`home-${label}`)
  fs.mkdirSync(path.join(fixtureHome, '.episodic-memory'), { recursive: true })
  const realCats = path.join(REPO_ROOT, 'scripts', 'categories.json')
  if (fs.existsSync(realCats)) {
    fs.copyFileSync(realCats, path.join(dataDir, 'categories.json'))
  }
  return { root, dataDir, episodesDir, home: fixtureHome }
}

// Seed one lesson: writes <id>.md AND appends a JSON row to index.jsonl.
// `sentinel` is a per-test discriminating token.
function seedLesson(S, o) {
  const {
    id, date = '2026-01-01', time = '00:00', project = 'acme', category = 'lesson',
    status = 'active', tags = [], summary, body = 'body text', triggers = [],
    appliesToProjects = [], appliesToTools = [], priority, reviewBy,
    lastAccessed, accessCount = 0,
  } = o
  const fm = ['---', `id: ${id}`, `date: ${date}`, `time: "${time}"`, `project: ${project}`, `category: ${category}`, `status: ${status}`]
  fm.push(`tags: [${tags.join(', ')}]`)
  if (typeof priority === 'number') fm.push(`priority: ${priority}`)
  if (triggers.length) fm.push(`triggers: [${triggers.map(x => `"${x}"`).join(', ')}]`)
  if (appliesToProjects.length) fm.push(`applies_to_projects: [${appliesToProjects.map(x => `"${x}"`).join(', ')}]`)
  if (appliesToTools.length) fm.push(`applies_to_tools: [${appliesToTools.map(x => `"${x}"`).join(', ')}]`)
  if (reviewBy) fm.push(`review_by: ${reviewBy}`)
  fm.push(`summary: ${summary}`)
  fm.push('---')
  fs.writeFileSync(path.join(S.episodesDir, `${id}.md`), `${fm.join('\n')}\n\n# ${summary}\n\n${body}\n`, 'utf8')
  const row = {
    id, date, time, project, category, status,
    supersedes: null, consolidates: null,
    tags: tags.slice(), summary,
    ...(triggers.length ? { triggers: triggers.slice() } : {}),
    ...(appliesToProjects.length ? { applies_to_projects: appliesToProjects.slice() } : {}),
    ...(appliesToTools.length ? { applies_to_tools: appliesToTools.slice() } : {}),
    ...(typeof priority === 'number' ? { priority } : {}),
    ...(reviewBy ? { review_by: reviewBy } : {}),
    ...(lastAccessed ? { last_accessed: lastAccessed } : {}),
    ...(accessCount ? { access_count: accessCount } : {}),
  }
  fs.appendFileSync(path.join(S.dataDir, 'index.jsonl'), JSON.stringify(row) + '\n', 'utf8')
}

// Write an activation-log line directly to <dataDir>/activation-log.jsonl.
// Each entry produces ONE line per the S1 schema: { v, ts, project, event,
// surface, entries: [{ id, effective_priority, rendered, source_scope,
// access_count_at_inject }] }. The test always writes a single-entry line.
function seedActivationLine(S, { id, ts, rendered = 'imperative', sourceScope = 'local', accessCountAtInject = 0 }) {
  const line = JSON.stringify({
    v: 1, ts, project: 'p4s5', event: 'inject', surface: 'per_prompt',
    entries: [{ id, effective_priority: 8, rendered, source_scope: sourceScope, access_count_at_inject: accessCountAtInject }],
  })
  fs.appendFileSync(path.join(S.dataDir, 'activation-log.jsonl'), line + '\n', 'utf8')
}

// Spawn the real em-consolidate.mjs --clerk into the fixture root. `mode: 'apply'`
// adds --apply --confirm. `extraArgs` forwarded to the script.
function runClerk(S, { mode = 'report', extraArgs = [], home, windowMs } = {}) {
  const args = [SCRIPT, '--clerk', '--scope', 'local', ...(mode === 'apply' ? ['--apply', '--confirm'] : []), ...(windowMs ? ['--window-ms', String(windowMs)] : []), ...extraArgs, ...PASS_THROUGH_BREAK_FLAGS]
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

// Write a synthetic clerk-run run-record (index row + episode file with the
// conversion report body) so the report::zeroConversionCandidate scan has
// historical context. Its id sorts as the LATEST (2099) so the scan picks it
// as the most-recent run-record. The conversion report's per_lesson names the
// sentinel lesson with n=0/d>0 (a "zero conversion" hit).
function seedSyntheticRunRecord(S, { id, conversionPerLesson = [] }) {
  const payload = {
    mode: 'clerk-apply', ts: '2099-12-31T23:59:59Z',
    source_index_fingerprint: '0000000000000000',
    written_ids: [], superseded_ids: [], proposals: [], applied: [], rejected: [],
    skipped_guard: [], rejected_cumulative: [], orphans: [],
    conversion: {
      per_band: { imperative: { n: 0, d: 0 }, plain: { n: 0, d: 0 } },
      per_lesson: conversionPerLesson,
      torn_skipped: 0, carried_forward: 0, lower_bound: true,
    },
  }
  const fm = ['---', `id: ${id}`, 'date: 2099-12-31', 'time: "23:59"', 'project: clerk', 'category: workflow.lifecycle', 'status: active', 'tags: []', 'summary: synthetic clerk run record', 'record_type: clerk-run', 'clerk_cutover: rfc-009-p4', '---']
  fs.writeFileSync(path.join(S.episodesDir, `${id}.md`), `${fm.join('\n')}\n\n# synthetic clerk run record\n\n${JSON.stringify(payload)}\n`, 'utf8')
  const row = { id, date: '2099-12-31', time: '23:59', project: 'clerk', category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'synthetic clerk run record', record_type: 'clerk-run', clerk_cutover: 'rfc-009-p4' }
  fs.appendFileSync(path.join(S.dataDir, 'index.jsonl'), JSON.stringify(row) + '\n', 'utf8')
}

function main() {
  // -- Section 14: R6-conversion test group (S5) --

  // conversion::rotateConsumeAtomic — the activation log is ATOMICALLY renamed
  // to a .processing name (renameSync). The fresh log after consume either has
  // the carried-forward lines OR is absent (fully consumed). --break-rotate
  // uses a read+unlink (non-atomic) and a concurrent O_APPEND during the
  // window would be lost. The red sub-assertion verifies --break-rotate still
  // produces a report (the break is a CONTROL, not a fault — the test asserts
  // the green rename differs from the red non-atomic rotate by also NOT
  // leaving a .processing file).
  t('conversion::rotateConsumeAtomic', () => {
    const S = mkStore('rotateatomic')
    seedActivationLine(S, { id: '20260101-000000-ra-zzzz', ts: '2026-07-12T10:00:00Z' })
    const logPath = path.join(S.dataDir, 'activation-log.jsonl')
    const procPath = logPath + '.processing'
    const r = runClerk(S)
    eq(r.status, 0, `green exit 0 (stderr=${r.stderr})`)
    eq(r.json.status, 'ok', 'green report ok')
    ok(!fs.existsSync(procPath), 'green: .processing file is gone (consumed) — atomic rotate, no leftover')
    // RED: --break-rotate (read-then-unlink) — still no .processing leftover
    // (the break path also unlinks), but the conversion semantics differ.
    const S2 = mkStore('rotateatomic-red')
    seedActivationLine(S2, { id: '20260101-000000-ra2-zzzz', ts: '2026-07-12T10:00:00Z' })
    const r2 = runClerk(S2, { extraArgs: ['--break-rotate'] })
    eq(r2.status, 0, 'red: --break-rotate still exits 0 (the control is structural, not a fault)')
    ok(!fs.existsSync(path.join(S2.dataDir, 'activation-log.jsonl.processing')), 'red: --break-rotate path also cleans up .processing')
    // The MEANINGFUL differ: the green path uses renameSync (atomic); the red
    // path uses a read+unlink (non-atomic). We can't easily prove atomicity
    // from outside, so the next test (appendDuringRotateNotLost) proves the
    // atomic guarantee end-to-end. Here we just assert both paths consume.
  })

  // conversion::appendDuringRotateNotLost — REQ-18 crash recovery: a
  // leftover activation-log.jsonl.processing from a prior CRASHED rotation
  // must be consumed FIRST (folded into the same report); the next atomic
  // rename would otherwise overwrite the leftover and silently lose those
  // telemetry lines. The test seeds a leftover .processing containing one
  // valid closed-window line with a unique sentinel id PLUS a normal log,
  // and asserts the GREEN behavior (sentinel in per_lesson, .processing
  // absent). The RED control: with --break-rotate forwarded (or explicitly
  // passed), the broken path does NOT recover the leftover → the sentinel
  // is absent from per_lesson AND .processing still exists with the
  // sentinel inside. The test's green assertions FAIL on the red run,
  // proving the recovery is wired. The test additionally seeds a second
  // fixture and asserts the explicit red behavior for documentation.
  t('conversion::appendDuringRotateNotLost', () => {
    const S = mkStore('appendnotlost')
    const SENTINEL_ID = '20260101-000000-anl-sentinel-zzzz'
    const logPath = path.join(S.dataDir, 'activation-log.jsonl')
    const procPath = logPath + '.processing'
    // Seed the leftover .processing FIRST (simulating a prior crashed rotation).
    // The leftover carries a single closed-window line with a unique sentinel
    // id (no last_accessed → counts as UNCONVERTED in the lower bound).
    const leftoverLine = JSON.stringify({
      v: 1, ts: '2026-07-12T10:00:00Z', project: 'p4s5', event: 'inject', surface: 'per_prompt',
      entries: [{ id: SENTINEL_ID, effective_priority: 8, rendered: 'imperative', source_scope: 'local', access_count_at_inject: 0 }],
    })
    fs.writeFileSync(procPath, leftoverLine + '\n', 'utf8')
    // Seed the NORMAL log with a different line (so the rotation also has work).
    seedActivationLine(S, { id: '20260101-000000-anl-normal-aaaa', ts: '2026-07-12T10:00:00Z' })
    // GREEN: the atomic-rotate + leftover-recovery path consumes the leftover
    // BEFORE renaming the current log on top of it. The sentinel id is folded
    // into per_lesson; the .processing file is gone.
    const r = runClerk(S)
    eq(r.status, 0, `green exit 0 (stderr=${r.stderr})`)
    const sentinelRow = r.json.conversion.per_lesson.find(l => l.id === SENTINEL_ID)
    ok(sentinelRow, `green: sentinel id from leftover .processing appears in per_lesson (got ${JSON.stringify(r.json.conversion.per_lesson.map(l => l.id))})`)
    ok(!fs.existsSync(procPath), 'green: leftover .processing is consumed (absent after run)')
    // RED: --break-rotate (the broken read+unlink path) NEVER touches a
    // leftover .processing — it leaves both the leftover and the current
    // log intact. Re-run against a fresh fixture; the explicit red
    // assertions document the red behavior (sentinel absent from
    // per_lesson, .processing still on disk with the sentinel inside).
    // The green assertions in the green run above FAIL when --break-rotate
    // is forwarded (the broken path doesn't recover the leftover), which
    // is the test's red control.
    const S2 = mkStore('appendnotlost-red')
    const procPath2 = path.join(S2.dataDir, 'activation-log.jsonl.processing')
    fs.writeFileSync(procPath2, leftoverLine + '\n', 'utf8')
    seedActivationLine(S2, { id: '20260101-000000-anl-normal-bbbb', ts: '2026-07-12T10:00:00Z' })
    const r2 = runClerk(S2, { extraArgs: ['--break-rotate'] })
    eq(r2.status, 0, 'red: --break-rotate exits 0 (the control does not crash)')
    // Red assertions: sentinel NOT in per_lesson, .processing still on disk.
    const sentinelRow2 = r2.json.conversion.per_lesson.find(l => l.id === SENTINEL_ID)
    ok(!sentinelRow2, `red: --break-rotate did NOT consume the leftover → sentinel absent from per_lesson (got ${JSON.stringify(r2.json.conversion.per_lesson.map(l => l.id))})`)
    ok(fs.existsSync(procPath2), 'red: --break-rotate leaves the leftover .processing intact (still on disk)')
    const leftoverContents = fs.readFileSync(procPath2, 'utf8')
    ok(leftoverContents.includes(SENTINEL_ID), 'red: leftover .processing still contains the sentinel id (untouched)')
  })

  // conversion::openWindowCarriedForward — a line with ts in (now-window, now]
  // is re-appended to a fresh log (REQ-18, NSP F5). --break-openwindow DROPS
  // the open-window line instead of carrying it forward → carried_forward=0
  // and the fresh log is empty / absent.
  t('conversion::openWindowCarriedForward', () => {
    const S = mkStore('openwindow')
    // Inject NOW (open-window) — anything with ts in (now-window, now] is open.
    // Use ISO 1 minute in the past to guarantee OPEN.
    const now = new Date()
    now.setMinutes(now.getMinutes() - 1)
    seedActivationLine(S, { id: '20260101-000000-ow-zzzz', ts: now.toISOString() })
    const r = runClerk(S)
    eq(r.status, 0, `green exit 0 (stderr=${r.stderr})`)
    const conv = r.json.conversion
    ok(conv, 'green: conversion present in report')
    eq(conv.lower_bound, true, 'green: lower_bound:true stamped')
    eq(conv.carried_forward, 1, 'green: carried_forward=1 (open-window line re-appended)')
    const logPath = path.join(S.dataDir, 'activation-log.jsonl')
    ok(fs.existsSync(logPath), 'green: fresh log exists with the carried-forward line')
    const logContents = fs.readFileSync(logPath, 'utf8')
    ok(logContents.includes('20260101-000000-ow-zzzz'), 'green: carried-forward line is back in the log')
    // RED: --break-openwindow drops the open-window line.
    const S2 = mkStore('openwindow-red')
    seedActivationLine(S2, { id: '20260101-000000-owr-zzzz', ts: now.toISOString() })
    const r2 = runClerk(S2, { extraArgs: ['--break-openwindow'] })
    eq(r2.status, 0, 'red: --break-openwindow still exits 0 (control semantics)')
    const conv2 = r2.json.conversion
    eq(conv2.carried_forward, 0, 'red: --break-openwindow drops the line → carried_forward=0')
  })

  // conversion::tornLineSkippedCounted — a non-JSON / unknown-v line is
  // skipped AND counted in torn_skipped (EC8). --break-tornskip throws
  // instead of skipping+counting, exiting non-zero with no valid report.
  t('conversion::tornLineSkippedCounted', () => {
    const S = mkStore('tornskip')
    seedActivationLine(S, { id: '20260101-000000-ts-zzzz', ts: '2026-07-12T10:00:00Z' })
    // Append a torn line (not valid JSON) + an unknown-v line.
    fs.appendFileSync(path.join(S.dataDir, 'activation-log.jsonl'), 'this-is-torn-not-json\n')
    fs.appendFileSync(path.join(S.dataDir, 'activation-log.jsonl'), JSON.stringify({ v: 99, ts: '2026-07-12T10:00:00Z', id: 'x' }) + '\n')
    const r = runClerk(S)
    eq(r.status, 0, `green exit 0 (stderr=${r.stderr})`)
    const conv = r.json.conversion
    eq(conv.torn_skipped, 2, 'green: 2 torn lines skipped+counted (1 not-JSON + 1 unknown-v)')
    // RED: --break-tornskip throws → exit 1, no valid report JSON.
    const S2 = mkStore('tornskip-red')
    seedActivationLine(S2, { id: '20260101-000000-tsr-zzzz', ts: '2026-07-12T10:00:00Z' })
    fs.appendFileSync(path.join(S2.dataDir, 'activation-log.jsonl'), 'this-is-torn-not-json\n')
    const r2 = runClerk(S2, { extraArgs: ['--break-tornskip'] })
    ok(r2.status !== 0, `red: --break-tornskip throws → exit non-zero (got ${r2.status})`)
  })

  // conversion::perBandFromFixture — REAL fixture: 3 lessons injected, 1
  // accessed (pre-bumped in the index — em-search --read bumps access to
  // NOW, which the 4h window math can't reconcile with a closed-window
  // injectTs; the test still drives a real access via the index writer, the
  // REQ-19 access-bump crux is proven by the conversion::crossStoreSourceScope
  // + windowBoundary + a separate em-search --read E2E in the report suite).
  // Expected: per_band imperative.n=1, d=3 AND lower_bound:true.
  t('conversion::perBandFromFixture', () => {
    const S = mkStore('perband')
    const aId = '20260101-000000-pb-aaaa'
    const bId = '20260101-000000-pb-bbbb'
    const cId = '20260101-000000-pb-cccc'
    // injectTs = 5 hours ago (in CLOSED window, so the line is consumed);
    // access at injectTs + 30min (within (T, T+4h] half-open window).
    const injectTsDate = new Date(Date.now() - 5 * 60 * 60 * 1000)
    const accessTsDate = new Date(injectTsDate.getTime() + 30 * 60 * 1000)
    const injectTs = injectTsDate.toISOString()
    const accessTs = accessTsDate.toISOString()
    // Seed 3 lessons — aId has a pre-bumped last_accessed in the window;
    // bId and cId stay un-accessed (no last_accessed → unconverted).
    seedLesson(S, { id: aId, tags: ['pb', 'alpha', 'beta', 'gamma'], summary: `${aId} perband fixture first`, lastAccessed: accessTs, accessCount: 1 })
    seedLesson(S, { id: bId, tags: ['pb', 'alpha', 'beta', 'gamma'], summary: `${bId} perband fixture second` })
    seedLesson(S, { id: cId, tags: ['pb', 'alpha', 'beta', 'gamma'], summary: `${cId} perband fixture third` })
    // Activation log: 3 entries (one per lesson), all at the same T.
    seedActivationLine(S, { id: aId, ts: injectTs, rendered: 'imperative' })
    seedActivationLine(S, { id: bId, ts: injectTs, rendered: 'imperative' })
    seedActivationLine(S, { id: cId, ts: injectTs, rendered: 'imperative' })
    // Run the clerk report — reads the activation log, computes conversion.
    const r = runClerk(S)
    eq(r.status, 0, `clerk exit 0 (stderr=${r.stderr})`)
    const conv = r.json.conversion
    eq(conv.lower_bound, true, 'per-band: lower_bound:true labeled')
    // 1 of 3 converted: imperative.n=1, d=3.
    eq(conv.per_band.imperative.n, 1, 'per-band: 1 imperative converted (the accessed one)')
    eq(conv.per_band.imperative.d, 3, 'per-band: 3 imperative denominator (all 3 injected)')
    eq(conv.per_band.plain.n, 0, 'per-band: 0 plain converted')
    eq(conv.per_band.plain.d, 0, 'per-band: 0 plain denominator')
    // per_lesson: 3 lessons, only aId is converted.
    const aRow = conv.per_lesson.find(l => l.id === aId)
    const bRow = conv.per_lesson.find(l => l.id === bId)
    const cRow = conv.per_lesson.find(l => l.id === cId)
    ok(aRow, 'per-lesson: aId row present')
    ok(bRow, 'per-lesson: bId row present')
    ok(cRow, 'per-lesson: cId row present')
    eq(aRow.n, 1, 'per-lesson: aId converted (1/1)')
    eq(bRow.n, 0, 'per-lesson: bId NOT converted (0/1 — accessed never)')
    eq(cRow.n, 0, 'per-lesson: cId NOT converted (0/1 — accessed never)')
  })

  // conversion::windowBoundary — boundary: last_accessed == injectTs is NOT
  // converted (half-open (T, T+window] excludes equality, REQ-19). A clearly-
  // in-window access (+1h) IS converted; a clearly-past access (+5h) is NOT.
  // --break-window uses an inclusive lower bound (>= ts) and would convert
  // the boundary case; the boundary assertion below catches the red control.
  t('conversion::windowBoundary', () => {
    const S = mkStore('windowbound')
    // Three lessons: boundary (last_accessed == ts), inside (+1h), outside (+5h).
    const boundaryId = '20260101-000000-wb-boundary'
    const insideId = '20260101-000000-wb-inside'
    const outsideId = '20260101-000000-wb-outside'
    const injectTs = '2026-07-12T10:00:00Z'
    seedLesson(S, { id: boundaryId, tags: ['wb'], summary: `${boundaryId} window boundary exact ts`, lastAccessed: injectTs })
    seedLesson(S, { id: insideId, tags: ['wb'], summary: `${insideId} window boundary inside`, lastAccessed: '2026-07-12T11:00:00Z' })
    seedLesson(S, { id: outsideId, tags: ['wb'], summary: `${outsideId} window boundary outside`, lastAccessed: '2026-07-12T15:00:00Z' })
    seedActivationLine(S, { id: boundaryId, ts: injectTs })
    seedActivationLine(S, { id: insideId, ts: injectTs })
    seedActivationLine(S, { id: outsideId, ts: injectTs })
    const r = runClerk(S)
    eq(r.status, 0, `clerk exit 0 (stderr=${r.stderr})`)
    const boundaryRow = r.json.conversion.per_lesson.find(l => l.id === boundaryId)
    const insideRow = r.json.conversion.per_lesson.find(l => l.id === insideId)
    const outsideRow = r.json.conversion.per_lesson.find(l => l.id === outsideId)
    ok(boundaryRow, 'boundary: boundary row present')
    ok(insideRow, 'boundary: inside row present')
    ok(outsideRow, 'boundary: outside row present')
    eq(boundaryRow.n, 0, 'boundary: last_accessed == ts is NOT converted (half-open excludes equality)')
    eq(insideRow.n, 1, 'boundary: +1h access is CONVERTED (1/1, strictly > ts)')
    eq(outsideRow.n, 0, 'boundary: +5h access is NOT converted (0/1, past 4h window)')
    // RED: --break-window (inclusive lower bound) → boundary IS converted.
    const S2 = mkStore('windowbound-red')
    seedLesson(S2, { id: boundaryId, tags: ['wb'], summary: `${boundaryId} window boundary exact ts red`, lastAccessed: injectTs })
    seedActivationLine(S2, { id: boundaryId, ts: injectTs })
    const r2 = runClerk(S2, { extraArgs: ['--break-window'] })
    eq(r2.status, 0, 'red: --break-window still exits 0')
    const boundaryRow2 = r2.json.conversion.per_lesson.find(l => l.id === boundaryId)
    eq(boundaryRow2.n, 1, 'red: --break-window (inclusive) CONVERTS the boundary case (1/1)')
  })

  // conversion::crossStoreSourceScope — a line with source_scope:'global' is
  // read from the GLOBAL store; a line with source_scope:'local' is read from
  // the LOCAL store. --break-sourcescope forces BOTH to be read from local,
  // which would mis-attribute a global-injected lesson. We prove cross-store
  // by seeding last_accessed DIFFERENTLY in each store for the same id, and
  // asserting the conversion picks the right one per source_scope.
  t('conversion::crossStoreSourceScope', () => {
    const S = mkStore('crossscope')
    const lessonId = '20260101-000000-cs-shared'
    // Same id in BOTH stores — local last_accessed = "in window" (10:30),
    // global last_accessed = "past window" (15:00). source_scope:local reads
    // local → converted; source_scope:global reads global → NOT converted.
    const injectTs = '2026-07-12T10:00:00Z'
    seedLesson(S, { id: lessonId, tags: ['cs'], summary: `${lessonId} cross-store shared id`, lastAccessed: '2026-07-12T10:30:00Z' })
    // The global store: same id, past-window last_accessed.
    const globalIdx = path.join(S.home, '.episodic-memory', 'index.jsonl')
    fs.mkdirSync(path.dirname(globalIdx), { recursive: true })
    fs.writeFileSync(globalIdx, JSON.stringify({
      id: lessonId, date: '2026-01-01', time: '00:00', project: 'global', category: 'lesson', status: 'active',
      supersedes: null, tags: ['cs'], summary: 'global cross-store shared', last_accessed: '2026-07-12T15:00:00Z', access_count: 5,
    }) + '\n', 'utf8')
    // Two injection lines: one local, one global, same id.
    seedActivationLine(S, { id: lessonId, ts: injectTs, sourceScope: 'local' })
    seedActivationLine(S, { id: lessonId, ts: injectTs, sourceScope: 'global' })
    const r = runClerk(S)
    eq(r.status, 0, `clerk exit 0 (stderr=${r.stderr})`)
    // Two entries, same id → 2 denominator events; conversion differs by
    // source_scope. per_lesson aggregates by id → 1/2 (local converted,
    // global not).
    const row = r.json.conversion.per_lesson.find(l => l.id === lessonId)
    ok(row, 'cross-store: row present')
    eq(row.d, 2, 'cross-store: 2 denominator events (one per source_scope)')
    eq(row.n, 1, 'cross-store: 1 converted (local reads local store, +30min in window; global reads global store, +5h past window)')
    // RED: --break-sourcescope forces both to be read from local → 2/2.
    const S2 = mkStore('crossscope-red')
    seedLesson(S2, { id: lessonId, tags: ['cs'], summary: `${lessonId} cross-store shared id`, lastAccessed: '2026-07-12T10:30:00Z' })
    seedActivationLine(S2, { id: lessonId, ts: injectTs, sourceScope: 'global' })
    const r2 = runClerk(S2, { extraArgs: ['--break-sourcescope'] })
    eq(r2.status, 0, 'red: --break-sourcescope still exits 0')
    const row2 = r2.json.conversion.per_lesson.find(l => l.id === lessonId)
    eq(row2.d, 1, 'red: 1 denominator (one source_scope line, but ignored)')
    eq(row2.n, 1, 'red: --break-sourcescope reads from local regardless of source_scope → still converted (same fixture data)')
    // GLM review F3: a third entry with source_scope:'bogus' (unknown /
    // missing) is treated as UNCONVERTED for that entry — counts toward d,
    // never n (REQ-20 lower bound, never inflated). The lesson is
    // last_accessed = T+30min (in window) so the bogus entry's failure to
    // convert is attributable to the source_scope guard, not the window.
    // Use a FRESH fixture because the previous runClerk(S) above consumed
    // the activation log (rotate-and-consume is destructive).
    const S3 = mkStore('crossscope-bogus')
    const lessonId3 = '20260101-000000-cs-bogus'
    seedLesson(S3, { id: lessonId3, tags: ['cs'], summary: `${lessonId3} cross-store bogus-source_scope fixture`, lastAccessed: '2026-07-12T10:30:00Z' })
    seedActivationLine(S3, { id: lessonId3, ts: injectTs, sourceScope: 'bogus' })
    const r3 = runClerk(S3)
    eq(r3.status, 0, `F3: clerk exit 0 (stderr=${r3.stderr})`)
    const row3 = r3.json.conversion.per_lesson.find(l => l.id === lessonId3)
    ok(row3, 'F3: row present after bogus source_scope entry')
    eq(row3.d, 1, 'F3: bogus source_scope entry contributes 1 denominator event')
    eq(row3.n, 0, 'F3: bogus source_scope entry is UNCONVERTED (n=0, never inflated; REQ-20)')
  })

  // conversion::lowerBoundLabeled — the conversion report carries
  // lower_bound:true (REQ-20 honesty: the metric is a labeled lower bound).
  t('conversion::lowerBoundLabeled', () => {
    const S = mkStore('lowerbound')
    seedActivationLine(S, { id: '20260101-000000-lb-zzzz', ts: '2026-07-12T10:00:00Z' })
    const r = runClerk(S)
    eq(r.status, 0, `clerk exit 0 (stderr=${r.stderr})`)
    const conv = r.json.conversion
    ok(conv, 'lower-bound: conversion field present')
    eq(conv.lower_bound, true, 'lower-bound: lower_bound:true labeled (REQ-20)')
    // Empty fixture: an empty store still produces a labeled lower-bound report.
    const S2 = mkStore('lowerbound-empty')
    const r2 = runClerk(S2)
    eq(r2.status, 0, 'lower-bound: empty store still exits 0')
    const conv2 = r2.json.conversion
    ok(conv2, 'lower-bound: empty conversion field present')
    eq(conv2.lower_bound, true, 'lower-bound: empty report is still labeled lower_bound:true')
    eq(conv2.torn_skipped, 0, 'lower-bound: empty torn_skipped=0')
    eq(conv2.carried_forward, 0, 'lower-bound: empty carried_forward=0')
  })

  // conversion::duplicateIdRowOrderIndependent (GLM review F4) — the
  // last_accessed lookup now scans ALL rows matching the id and takes the
  // MINIMUM (conservative, provably lower-bound, row-order independent).
  // The test seeds 2 rows of the same id: one with last_accessed IN the
  // half-open window (T+1h) and one with last_accessed BEFORE the injection
  // (T-1h — out of the half-open window because the strict `> ts` check
  // fails). In BOTH row orders, the minimum is the out-of-window value
  // and the verdict is n=0. (If the lookup were FIRST-match / row-order
  // dependent, the verdict would flip when the rows are reordered.)
  t('conversion::duplicateIdRowOrderIndependent', () => {
    const lessonId = '20260101-000000-duprow-aaaa'
    // Closed-window injection ts: now - 5h. Half-open window: (T, T+4h].
    const injectTsDate = new Date(Date.now() - 5 * 60 * 60 * 1000)
    const injectTs = injectTsDate.toISOString()
    const inWindowTs = new Date(injectTsDate.getTime() + 60 * 60 * 1000).toISOString() // T+1h: in window
    const outWindowTs = new Date(injectTsDate.getTime() - 60 * 60 * 1000).toISOString() // T-1h: BEFORE injection → fails `> ts` → out of window
    function fixtureWithRows(rowATs, rowBTs) {
      const S = mkStore(`duprow-${rowATs.slice(0,4)}-${rowBTs.slice(0,4)}`)
      // Seed 2 rows of the same id with the given last_accessed values.
      const rows = [
        JSON.stringify({ id: lessonId, date: '2026-01-01', time: '00:00', project: 'duprow', category: 'lesson', status: 'active', supersedes: null, tags: ['duprow'], summary: 'duprow fixture', last_accessed: rowATs, access_count: 1 }),
        JSON.stringify({ id: lessonId, date: '2026-01-01', time: '00:00', project: 'duprow', category: 'lesson', status: 'active', supersedes: null, tags: ['duprow'], summary: 'duprow fixture', last_accessed: rowBTs, access_count: 1 }),
      ]
      fs.writeFileSync(path.join(S.dataDir, 'index.jsonl'), rows.join('\n') + '\n', 'utf8')
      // Closed-window activation log line.
      seedActivationLine(S, { id: lessonId, ts: injectTs })
      return S
    }
    // Order A: in-window row first, out-of-window row second.
    const SA = fixtureWithRows(inWindowTs, outWindowTs)
    const rA = runClerk(SA)
    eq(rA.status, 0, `duprow A exit 0 (stderr=${rA.stderr})`)
    const rowA = rA.json.conversion.per_lesson.find(l => l.id === lessonId)
    ok(rowA, 'duprow A: row present')
    eq(rowA.n, 0, `duprow A: n=0 (min is out-of-window T-1h; got n=${rowA.n})`)
    eq(rowA.d, 1, 'duprow A: d=1 (one closed-window entry)')
    // Order B: out-of-window row first, in-window row second.
    const SB = fixtureWithRows(outWindowTs, inWindowTs)
    const rB = runClerk(SB)
    eq(rB.status, 0, `duprow B exit 0 (stderr=${rB.stderr})`)
    const rowB = rB.json.conversion.per_lesson.find(l => l.id === lessonId)
    ok(rowB, 'duprow B: row present')
    eq(rowB.n, 0, `duprow B: n=0 (min is out-of-window T-1h, regardless of row order; got n=${rowB.n})`)
    eq(rowB.d, 1, 'duprow B: d=1')
    // The two verdicts are identical (row-order independent).
    eq(rowA.n, rowB.n, 'duprow: n is row-order independent (A === B)')
    eq(rowA.d, rowB.d, 'duprow: d is row-order independent (A === B)')
  })

  // report::zeroConversionCandidate (REQ-21) — seed N=3 consecutive
  // zero-conversion run-records naming the sentinel lesson (n=0/d=1 each),
  // then run a clerk REPORT and assert the report surfaces that lesson as a
  // reword/demote/suppress candidate. The clerk scans prior run-records
  // under the held CLERK_LOCK_FILE lock; the candidate is the lesson whose
  // last N run-records all show n=0.
  t('report::zeroConversionCandidate', () => {
    const S = mkStore('zerocand')
    const sentinel = '20260101-000000-zc-sentinel-zzzz'
    // The lesson must be present in the active index for the candidate scan
    // to find a corresponding active lesson to surface.
    seedLesson(S, { id: sentinel, tags: ['zc'], summary: `${sentinel} zero-conversion sentinel fixture` })
    // Seed N=3 run-records, each with the sentinel showing n=0/d=1.
    for (let i = 0; i < 3; i++) {
      seedSyntheticRunRecord(S, {
        id: `20991231-23595${i}-clerk-run-synth-zc`,
        conversionPerLesson: [{ id: sentinel, n: 0, d: 1, last_ts: '2099-12-31T23:59:59Z', last_access_count_at_inject: 0, band: 'imperative' }],
      })
    }
    // Run a clerk REPORT (no --apply); the report scans the seeded
    // run-records and surfaces the sentinel as a zero-conversion candidate.
    const r = runClerk(S, { mode: 'report' })
    eq(r.status, 0, `clerk report exit 0 (stderr=${r.stderr})`)
    const candidates = r.json.zero_conversion_candidates
    ok(Array.isArray(candidates), 'zero-cand: zero_conversion_candidates array present')
    const hit = candidates.find(c => c.id === sentinel)
    ok(hit, `zero-cand: sentinel surfaced as a candidate (got ${JSON.stringify(candidates)})`)
    eq(hit.consecutive_zero_runs, 3, 'zero-cand: 3 consecutive zero-conversion runs')
    ok(hit.suggestion, 'zero-cand: suggestion field (reword/demote/suppress)')
    // RED: only N=2 run-records → sentinel is NOT a candidate (not enough
    // consecutive runs).
    const S2 = mkStore('zerocand-red')
    seedLesson(S2, { id: sentinel, tags: ['zc'], summary: `${sentinel} zero-conversion sentinel fixture (red)` })
    for (let i = 0; i < 2; i++) {
      seedSyntheticRunRecord(S2, {
        id: `20991231-23595${i}-clerk-run-synth-zcr`,
        conversionPerLesson: [{ id: sentinel, n: 0, d: 1, last_ts: '2099-12-31T23:59:59Z', last_access_count_at_inject: 0, band: 'imperative' }],
      })
    }
    const r2 = runClerk(S2, { mode: 'report' })
    eq(r2.status, 0, 'red: clerk report exit 0')
    const candidates2 = r2.json.zero_conversion_candidates || []
    ok(!candidates2.find(c => c.id === sentinel), 'red: only 2 runs → not yet a candidate')
  })
}

main()
console.log(`test-rfc-009-p4-conversion: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map((f) => `FAIL ${f}`).join('\n')); process.exit(1) }
