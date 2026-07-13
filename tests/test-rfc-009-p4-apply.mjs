#!/usr/bin/env node
/**
 * test-rfc-009-p4-apply.mjs — RFC-009 P4-S4 (R9b clerk APPLY, REQ-6..13).
 *
 * Proves the clerk apply mode of scripts/em-consolidate.mjs:
 *   - refuses without --confirm (fail-closed, no write) — REQ-6;
 *   - holds ONE em-lock across the whole apply, serializing apply-vs-apply — REQ-7;
 *   - REQ-8 write order (store digest → supersede members → run-record), with
 *     crash-window detection via the clerk_cutover stamp;
 *   - REQ-9 merge field contract built DIRECTLY (never the legacy field-blind
 *     writer), members flipped via index-flip (valid JSONL) not em-revise;
 *   - exactly one run-record per apply (REQ-11), validated on the direct write path;
 *   - rejected clusters not re-proposed on an unchanged store (REQ-12/13);
 *   - reversibility via the P7 revision chain (em-revise re-activates a member);
 *   - run-record survives em-rebuild-index (record_type + clerk_cutover carried).
 *
 * Every assertion inspects real captured runtime state (parsed JSON, on-disk
 * index rows/files, spawn stdout/exit) with a discriminating sentinel — never a
 * typed constant or "non-empty". The clerk is spawned via the REAL
 * scripts/em-consolidate.mjs with cwd into isolated fixture stores under /tmp and
 * an isolated HOME (so the GLOBAL store is contained).
 *
 * Negative controls (§A.9, portable --break-* / --sim-* argv flags), each run as
 * its own row immediately before/after the green run:
 *   --break-validate            → runrecord::categoryValidatedOnDirectWrite FAILS
 *   --break-index-flip-json     → apply::indexFlipYieldsValidJsonl FAILS
 *   --break-confirm             → apply::noConfirmNoWrite / failClosedBeforeWrite FAIL
 *   --break-writeorder          → apply::writeOrderStoreFirst / crashDuringSupersedeDetected FAIL
 *   --break-lock                → apply::applyVsApplySerialized FAILS
 *   --break-rejected            → apply::rejectedNotReproposed FAILS
 *   --break-oldwriter           → apply::mergeFieldContract FAILS
 *   --break-rebuild-whitelist   → runrecord::survivesRebuild FAILS
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tryAcquire, release } from '../scripts/lib/lock.mjs'
import { loadProtectionRows, computeProtectedIds } from '../scripts/lib/protection.mjs'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'em-consolidate.mjs')
const REVISE = path.join(REPO_ROOT, 'scripts', 'em-revise.mjs')
const REBUILD = path.join(REPO_ROOT, 'scripts', 'em-rebuild-index.mjs')
const SEARCH = path.join(REPO_ROOT, 'scripts', 'em-search.mjs')

let pass = 0, fail = 0
const failures = []
const asyncTests = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
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
function tAsync(name, fn) {
  if (ONLY_FLAG && !name.includes(ONLY_FLAG)) return
  asyncTests.push({ name, fn })
}
async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    try { await fn(); pass++ }
    catch (e) { fail++; failures.push(`${name} - ${e && e.message}`) }
  }
}

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
function mkTmp(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p4s4-${label}-`)))
  _tmpDirs.push(base)
  return base
}

// Build a minimal but valid local store under <root>/.episodic-memory/. The real
// categories.json is resolved by em-consolidate relative to its own module, so we
// only need the episodes/ dir + a fixture HOME for global-store isolation.
function mkStore(label) {
  const root = mkTmp(`store-${label}`)
  const dataDir = path.join(root, '.episodic-memory')
  const episodesDir = path.join(dataDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const fixtureHome = mkTmp(`home-${label}`)
  fs.mkdirSync(path.join(fixtureHome, '.episodic-memory'), { recursive: true })
  return { root, dataDir, episodesDir, home: fixtureHome }
}

// Seed one lesson (or arbitrary episode): writes <id>.md AND appends a JSON row
// to index.jsonl. Row is built with JSON.stringify (never string interpolation).
function seedLesson(S, o) {
  const {
    id, date = '2026-01-01', time = '00:00', project = 'acme', category = 'lesson',
    status = 'active', tags = [], summary, body = 'body text', triggers = [],
    appliesToProjects = [], appliesToTools = [], priority, evidence = [], reviewBy,
    supersedes, supersededBy, pinned,
  } = o
  const fm = ['---', `id: ${id}`, `date: ${date}`, `time: "${time}"`, `project: ${project}`, `category: ${category}`, `status: ${status}`]
  if (supersedes) fm.push(`supersedes: ${supersedes}`)
  if (supersededBy) fm.push(`superseded_by: ${supersededBy}`)
  if (pinned) fm.push('pinned: true')
  fm.push(`tags: [${tags.join(', ')}]`)
  if (typeof priority === 'number') fm.push(`priority: ${priority}`)
  fm.push(`summary: ${summary}`)
  if (triggers.length) fm.push(`triggers: [${triggers.map(x => `"${x}"`).join(', ')}]`)
  if (appliesToProjects.length) fm.push(`applies_to_projects: [${appliesToProjects.map(x => `"${x}"`).join(', ')}]`)
  if (appliesToTools.length) fm.push(`applies_to_tools: [${appliesToTools.map(x => `"${x}"`).join(', ')}]`)
  if (evidence.length) fm.push(`evidence: [${evidence.map(x => `"${x}"`).join(', ')}]`)
  if (reviewBy) fm.push(`review_by: ${reviewBy}`)
  fm.push('---')
  fs.writeFileSync(path.join(S.episodesDir, `${id}.md`), `${fm.join('\n')}\n\n# ${summary}\n\n${body}\n`, 'utf8')
  const row = {
    id, date, time, project, category, status,
    supersedes: supersedes || null, consolidates: null,
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    tags: tags.slice(), summary,
    ...(triggers.length ? { triggers: triggers.slice() } : {}),
    ...(appliesToProjects.length ? { applies_to_projects: appliesToProjects.slice() } : {}),
    ...(appliesToTools.length ? { applies_to_tools: appliesToTools.slice() } : {}),
    ...(evidence.length ? { evidence: evidence.slice() } : {}),
    ...(typeof priority === 'number' ? { priority } : {}),
    ...(reviewBy ? { review_by: reviewBy } : {}),
    ...(pinned ? { pinned: true } : {}),
  }
  fs.appendFileSync(path.join(S.dataDir, 'index.jsonl'), JSON.stringify(row) + '\n', 'utf8')
}

// Spawn the real em-consolidate.mjs in the fixture. mode: 'apply' adds --apply.
function runClerk(S, { extraArgs = [], confirm = false, apply = true, cwd, home } = {}) {
  const args = [SCRIPT, '--clerk', ...(apply ? ['--apply'] : []), '--scope', 'local', ...(confirm ? ['--confirm'] : []), ...extraArgs]
  const env = { ...process.env, HOME: home || S.home }
  const r = spawnSync('node', args, { cwd: cwd || S.root, encoding: 'utf8', timeout: 120000, env })
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
function rowById(S, id) { return indexRows(S).find(r => r.id === id) }
function digestRows(S) { return indexRows(S).filter(r => Array.isArray(r.consolidates)) }
function runRecordRows(S) { return indexRows(S).filter(r => r.record_type === 'clerk-run') }
function sha256File(p) { return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'ABSENT' }

// A canonical mergeable PAIR (state B: tag-Jaccard 0.6 ≥ 0.5, divergent summaries,
// no triggers → not protected). Returns [idA, idB].
function seedMergePair(S, prefix) {
  const a = `20260101-000000-${prefix}-aaaa`
  const b = `20260101-000000-${prefix}-bbbb`
  seedLesson(S, { id: a, tags: ['alpha', 'beta', 'gamma', 'delta'], summary: `${prefix} zebra apple mango one` })
  seedLesson(S, { id: b, tags: ['alpha', 'beta', 'gamma', 'epsilon'], summary: `${prefix} yak plover quince two` })
  return [a, b]
}

// Spawn the real em-consolidate.mjs apply ASYNC (for the concurrent-lock TOCTOU
// test). Resolves { code, stdout, stderr, json } on child close.
function spawnClerkApplyAsync(S, extraArgs = []) {
  return new Promise((resolve) => {
    const args = [SCRIPT, '--clerk', '--apply', '--scope', 'local', '--confirm', ...extraArgs]
    const child = spawn('node', args, { cwd: S.root, env: { ...process.env, HOME: S.home } })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err, json: parseLastJson(out) }))
  })
}

// Replicate the clerk's fingerprint algorithm EXACTLY (clerkStoreFingerprint +
// clerkClusterFingerprint) so a test can pre-compute the fingerprint the clerk
// will derive for a cluster given the active candidate id set.
function computeClusterFingerprint(memberIds, candidateIds) {
  const storeFp = crypto.createHash('sha256').update(candidateIds.slice().sort().join('\n')).digest('hex').slice(0, 16)
  return crypto.createHash('sha256').update(memberIds.slice().sort().join(',') + '\u0000' + storeFp).digest('hex').slice(0, 24)
}

// Append a synthetic clerk-run run-record (index row + episode file with the JSON
// payload body) whose cumulative rejected set carries the given fingerprints. Its
// id sorts as the LATEST (2099) so clerkLoadLatestRunRecord picks it. category is
// workflow.lifecycle → fingerprint-excluded, so this append does not change storeFp.
function seedSyntheticRunRecord(S, id, rejected) {
  const payload = { mode: 'clerk-apply', ts: '2099-12-31T23:59:59Z', written_ids: [], superseded_ids: [], rejected }
  const fm = ['---', `id: ${id}`, 'date: 2099-12-31', 'time: "23:59"', 'project: clerk', 'category: workflow.lifecycle', 'status: active', 'tags: []', 'summary: synthetic clerk run record', 'record_type: clerk-run', 'clerk_cutover: rfc-009-p4', '---']
  fs.writeFileSync(path.join(S.episodesDir, `${id}.md`), `${fm.join('\n')}\n\n# synthetic clerk run record\n\n${JSON.stringify(payload)}\n`, 'utf8')
  const row = { id, date: '2099-12-31', time: '23:59', project: 'clerk', category: 'workflow.lifecycle', status: 'active', supersedes: null, tags: [], summary: 'synthetic clerk run record', record_type: 'clerk-run', clerk_cutover: 'rfc-009-p4' }
  fs.appendFileSync(path.join(S.dataDir, 'index.jsonl'), JSON.stringify(row) + '\n', 'utf8')
}

function main() {
  // ---- Step 4.3: clerkWrite direct-write contract ----

  // apply::mergeCreatesDigest — a confirmed merge writes a digest carrying
  // consolidates:[members] + clerk_cutover; the pair members are superseded.
  t('apply::mergeCreatesDigest', () => {
    const S = mkStore('mergedigest')
    const [a, b] = seedMergePair(S, 'mcd')
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, `exit 0 (stderr=${r.stderr})`)
    eq(r.json.status, 'ok', 'status ok')
    eq(r.json.applied.length, 1, 'one cluster applied')
    eq(r.json.applied[0].action, 'merge', 'action merge')
    const digest = digestRows(S)
    eq(digest.length, 1, 'exactly one digest row written')
    const d = digest[0]
    ok(d.consolidates.includes(a) && d.consolidates.includes(b), `digest consolidates both members (got ${JSON.stringify(d.consolidates)})`)
    eq(d.clerk_cutover, 'rfc-009-p4', 'digest carries clerk_cutover stamp')
    eq(rowById(S, a).status, 'superseded', 'member a superseded')
    eq(rowById(S, b).status, 'superseded', 'member b superseded')
  })

  // apply::supersedeIsIndexFlipNotRevise — members are flipped in place (status
  // superseded + superseded_by), NOT via a new em-revise revision episode (no
  // index row carries supersedes:<member>).
  t('apply::supersedeIsIndexFlipNotRevise', () => {
    const S = mkStore('flipnotrevise')
    const [a, b] = seedMergePair(S, 'snr')
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, 'exit 0')
    const digestId = r.json.applied[0].digest_id
    eq(rowById(S, a).status, 'superseded', 'member a status superseded (index-flip)')
    eq(rowById(S, a).superseded_by, digestId, 'member a superseded_by digest')
    // an em-revise would have created a NEW episode row with supersedes:<member>.
    const revisionRows = indexRows(S).filter(row => row.supersedes === a || row.supersedes === b)
    eq(revisionRows.length, 0, `no em-revise revision episode created (got ${JSON.stringify(revisionRows.map(x => x.id))})`)
  })

  // apply::indexFlipYieldsValidJsonl — after a merge, every index.jsonl line
  // JSON.parses AND each member row carries status:superseded. --break-index-flip-json
  // (writes a JSON OBJECT like updateInverted) corrupts the JSONL → member rows gone → RED.
  t('apply::indexFlipYieldsValidJsonl', () => {
    const S = mkStore('validjsonl')
    const [a, b] = seedMergePair(S, 'vjl')
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, 'green exit 0')
    const raw = fs.readFileSync(path.join(S.dataDir, 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    for (const line of raw) { JSON.parse(line) } // throws if any line is not valid JSON
    eq(rowById(S, a).status, 'superseded', 'member a superseded in valid JSONL')
    eq(rowById(S, b).status, 'superseded', 'member b superseded in valid JSONL')
    // RED: --break-index-flip-json corrupts the JSONL; the member rows vanish.
    const S2 = mkStore('validjsonl-red')
    const [a2] = seedMergePair(S2, 'vjlr')
    runClerk(S2, { confirm: true, extraArgs: ['--break-index-flip-json'] })
    ok(rowById(S2, a2) === undefined || rowById(S2, a2).status !== 'superseded', 'RED: broken flip loses the member superseded row')
  })

  // runrecord::categoryValidatedOnDirectWrite — the run-record's category is
  // validated on the direct write path: an invalid category is REJECTED before
  // any write. --break-validate skips the validator → the invalid row is written → RED.
  t('runrecord::categoryValidatedOnDirectWrite', () => {
    const S = mkStore('catvalid')
    // empty store → apply writes only a run-record; sim an invalid category.
    const r = runClerk(S, { confirm: true, extraArgs: ['--sim-bad-runrecord-category'] })
    ok(r.status !== 0, `green: invalid-category run-record write fails closed (exit ${r.status})`)
    eq(r.json && r.json.code, 'run-record-write-failed', 'green: reports run-record write failure')
    const badRows = indexRows(S).filter(row => row.category === 'zzinvalidcatsentinel')
    eq(badRows.length, 0, 'green: no invalid-category row written')
    // RED: --break-validate skips the validator → the invalid-category row lands.
    const S2 = mkStore('catvalid-red')
    runClerk(S2, { confirm: true, extraArgs: ['--sim-bad-runrecord-category', '--break-validate'] })
    const badRows2 = indexRows(S2).filter(row => row.category === 'zzinvalidcatsentinel')
    ok(badRows2.length >= 1, 'RED: skipping validation writes the invalid-category run-record')
  })

  // ---- Step 4.4: confirm gate, lock, write order, field contract, run-record ----

  // apply::noConfirmNoWrite — apply WITHOUT --confirm makes no store mutation.
  // --break-confirm bypasses the gate → it writes → RED.
  t('apply::noConfirmNoWrite', () => {
    const S = mkStore('noconfirm')
    seedMergePair(S, 'ncw')
    const before = sha256File(path.join(S.dataDir, 'index.jsonl'))
    const r = runClerk(S, { confirm: false })
    eq(r.json.code, 'unconfirmed', 'unconfirmed error code')
    eq(digestRows(S).length, 0, 'no digest written without --confirm')
    eq(sha256File(path.join(S.dataDir, 'index.jsonl')), before, 'index.jsonl byte-unchanged')
    // RED: --break-confirm bypasses the gate.
    const S2 = mkStore('noconfirm-red')
    seedMergePair(S2, 'ncwr')
    runClerk(S2, { confirm: false, extraArgs: ['--break-confirm'] })
    ok(digestRows(S2).length >= 1, 'RED: --break-confirm writes without --confirm')
  })

  // apply::failClosedBeforeWrite (EC6) — the unconfirmed gate fires BEFORE any
  // mutation (store byte-unchanged, exit non-zero). --break-confirm → RED.
  t('apply::failClosedBeforeWrite', () => {
    const S = mkStore('failclosed')
    seedMergePair(S, 'fcb')
    const before = sha256File(path.join(S.dataDir, 'index.jsonl'))
    const r = runClerk(S, { confirm: false })
    ok(r.status !== 0, `exit non-zero (got ${r.status})`)
    eq(sha256File(path.join(S.dataDir, 'index.jsonl')), before, 'store byte-unchanged (fail-closed before write)')
  })

  // apply::perClusterConfirm — rejecting ONE cluster (--reject-member) while
  // applying another proves per-cluster granularity (REQ-6).
  t('apply::perClusterConfirm', () => {
    const S = mkStore('percluster')
    const [a1] = seedMergePair(S, 'pc1')       // cluster 1
    // cluster 2 uses a disjoint tag namespace so it is a SEPARATE cluster.
    seedLesson(S, { id: '20260101-000000-pc2-aaaa', tags: ['zeta', 'eta', 'theta', 'iota'], summary: 'pc2 orange lemon lime one' })
    seedLesson(S, { id: '20260101-000000-pc2-bbbb', tags: ['zeta', 'eta', 'theta', 'kappa'], summary: 'pc2 grape cherry berry two' })
    const r = runClerk(S, { confirm: true, extraArgs: ['--reject-member', a1] })
    eq(r.status, 0, 'exit 0')
    eq(r.json.applied.length, 1, 'exactly one cluster applied (the non-rejected one)')
    ok(r.json.applied.every(x => !x.members.includes(a1)), 'the rejected cluster (containing a1) was NOT applied')
    eq(rowById(S, a1).status, 'active', 'rejected cluster member stays active')
  })

  // apply::underEmLock — the apply gates on the clerk lock: with the lock held
  // by a LIVE holder, the apply returns {locked:true} + writes nothing.
  t('apply::underEmLock', () => {
    const S = mkStore('underlock')
    seedMergePair(S, 'uel')
    const lockFile = path.join(S.dataDir, 'clerk-apply.lock')
    const h = tryAcquire(lockFile) // this test process (alive) holds it
    ok(h.ok, 'test acquired the clerk lock')
    try {
      const r = runClerk(S, { confirm: true, extraArgs: ['--lock-timeout', '1'] })
      eq(r.json.locked, true, 'apply reports locked:true under a held lock')
      eq(digestRows(S).length, 0, 'apply wrote nothing while lock held')
    } finally { release(h.handle) }
  })

  // apply::applyVsApplySerialized (EC3) — a concurrent lock-holder blocks the
  // apply (returns locked:true, no write). --break-lock skips acquire → it writes
  // despite the held lock → RED.
  t('apply::applyVsApplySerialized', () => {
    const S = mkStore('serialized')
    seedMergePair(S, 'ava')
    const lockFile = path.join(S.dataDir, 'clerk-apply.lock')
    const h = tryAcquire(lockFile)
    ok(h.ok, 'holder acquired lock')
    try {
      const r = runClerk(S, { confirm: true, extraArgs: ['--lock-timeout', '1'] })
      eq(r.json.locked, true, 'green: 2nd apply serialized behind the held lock')
      eq(digestRows(S).length, 0, 'green: 2nd apply wrote nothing')
      // RED: --break-lock ignores the held lock and writes anyway.
      const rRed = runClerk(S, { confirm: true, extraArgs: ['--break-lock'] })
      ok(rRed.json.locked !== true && digestRows(S).length >= 1, 'RED: --break-lock writes despite the held lock')
    } finally { release(h.handle) }
  })

  // apply::writeOrderStoreFirst (REQ-8) — crash after step (1) leaves the digest
  // on disk with members STILL ACTIVE (store-first). --break-writeorder supersedes
  // first → members superseded at the same crash point → RED.
  t('apply::writeOrderStoreFirst', () => {
    const S = mkStore('writeorder')
    const [a] = seedMergePair(S, 'wof')
    runClerk(S, { confirm: true, extraArgs: ['--sim-crash-after-store'] })
    ok(digestRows(S).length >= 1, 'green: digest stored first (present after crash)')
    eq(rowById(S, a).status, 'active', 'green: members still ACTIVE after crash-after-store')
    // RED: reversed order supersedes before the digest lands.
    const S2 = mkStore('writeorder-red')
    const [a2] = seedMergePair(S2, 'wofr')
    runClerk(S2, { confirm: true, extraArgs: ['--break-writeorder', '--sim-crash-after-store'] })
    eq(rowById(S2, a2).status, 'superseded', 'RED: reversed order supersedes members before the store write')
  })

  // apply::crashAfterStoreBenign (EC4) — crash after (1): the orphan digest is
  // BENIGN (no members superseded); next start detects it, members survive active.
  t('apply::crashAfterStoreBenign', () => {
    const S = mkStore('crashbenign')
    const [a, b] = seedMergePair(S, 'cab')
    runClerk(S, { confirm: true, extraArgs: ['--sim-crash-after-store'] })
    eq(rowById(S, a).status, 'active', 'member a survives active')
    eq(rowById(S, b).status, 'active', 'member b survives active')
    const detect = runClerk(S, { confirm: false }) // detection-only (no re-apply)
    const benign = (detect.json.orphans || []).filter(o => o.benign)
    ok(benign.length >= 1, `benign orphan detected (got ${JSON.stringify(detect.json.orphans)})`)
    eq(benign[0].superseded_member_ids.length, 0, 'benign orphan has no superseded members')
  })

  // apply::crashDuringSupersedeDetected (EC4 / §7.2 axis-3) — crash after the
  // supersede loop (members superseded, run-record absent) is detected next start
  // as a DANGEROUS orphan. --break-writeorder leaves the digest absent → no
  // dangerous orphan detected → RED.
  t('apply::crashDuringSupersedeDetected', () => {
    const S = mkStore('crashsupersede')
    const [a, b] = seedMergePair(S, 'cds')
    runClerk(S, { confirm: true, extraArgs: ['--sim-crash-after-supersede'] })
    eq(rowById(S, a).status, 'superseded', 'member superseded at crash point')
    const detect = runClerk(S, { confirm: false })
    const dangerous = (detect.json.orphans || []).filter(o => !o.benign)
    ok(dangerous.length >= 1, `dangerous orphan detected (got ${JSON.stringify(detect.json.orphans)})`)
    ok(dangerous[0].superseded_member_ids.includes(a) && dangerous[0].superseded_member_ids.includes(b), 'dangerous orphan names the superseded members')
    // RED: --break-writeorder crashes before the digest lands → undetectable.
    const S2 = mkStore('crashsupersede-red')
    seedMergePair(S2, 'cdsr')
    runClerk(S2, { confirm: true, extraArgs: ['--break-writeorder', '--sim-crash-after-supersede'] })
    const detect2 = runClerk(S2, { confirm: false })
    eq((detect2.json.orphans || []).filter(o => !o.benign).length, 0, 'RED: broken write order → no dangerous orphan detectable')
  })

  // apply::cutoverIsStampedField — the digest AND run-record carry the stamped
  // clerk_cutover frontmatter field (clock-independent crash discriminator).
  t('apply::cutoverIsStampedField', () => {
    const S = mkStore('cutover')
    seedMergePair(S, 'cut')
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, 'exit 0')
    eq(digestRows(S)[0].clerk_cutover, 'rfc-009-p4', 'digest clerk_cutover stamped')
    eq(runRecordRows(S)[0].clerk_cutover, 'rfc-009-p4', 'run-record clerk_cutover stamped')
  })

  // apply::mergeFieldContract (REQ-9) — the direct-write digest unions
  // triggers/applies_to_*/evidence, takes max of DEFINED priorities, latest
  // review_by. --break-oldwriter routes through the legacy field-blind writer
  // (drops these fields) → RED.
  t('apply::mergeFieldContract', () => {
    const S = mkStore('fieldcontract')
    // review_by in the PAST so the trigger-bearing lessons are NOT class-b
    // protected (isValidReferencer false) and thus mergeable.
    seedLesson(S, { id: '20260101-000000-mfc-aaaa', tags: ['alpha', 'beta', 'gamma', 'delta'], summary: 'mfc zebra apple mango one', triggers: ['mfctrigone'], appliesToProjects: ['projA'], appliesToTools: ['toolX'], priority: 5, evidence: [], reviewBy: '2020-01-01' })
    seedLesson(S, { id: '20260101-000000-mfc-bbbb', tags: ['alpha', 'beta', 'gamma', 'epsilon'], summary: 'mfc yak plover quince two', triggers: ['mfctrigtwo'], appliesToProjects: ['projB'], appliesToTools: ['toolY'], reviewBy: '2020-06-01' })
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, `exit 0 (stderr=${r.stderr})`)
    eq(r.json.applied.length, 1, 'merged (not blocked)')
    const d = digestRows(S)[0]
    ok(d.triggers.includes('mfctrigone') && d.triggers.includes('mfctrigtwo'), `triggers unioned (got ${JSON.stringify(d.triggers)})`)
    ok(d.applies_to_projects.includes('projA') && d.applies_to_projects.includes('projB'), 'applies_to_projects unioned')
    ok(d.applies_to_tools.includes('toolX') && d.applies_to_tools.includes('toolY'), 'applies_to_tools unioned')
    eq(d.priority, 5, 'priority = max of DEFINED values (missing stays out of the max)')
    eq(d.review_by, '2020-06-01', 'review_by = latest')
    // RED: legacy field-blind writer drops the union activation fields.
    const S2 = mkStore('fieldcontract-red')
    seedLesson(S2, { id: '20260101-000000-mfcr-aaaa', tags: ['alpha', 'beta', 'gamma', 'delta'], summary: 'mfcr zebra apple mango one', triggers: ['mfcrtrigone'], reviewBy: '2020-01-01' })
    seedLesson(S2, { id: '20260101-000000-mfcr-bbbb', tags: ['alpha', 'beta', 'gamma', 'epsilon'], summary: 'mfcr yak plover quince two', triggers: ['mfcrtrigtwo'], reviewBy: '2020-01-01' })
    runClerk(S2, { confirm: true, extraArgs: ['--break-oldwriter'] })
    const d2 = digestRows(S2)[0]
    ok(!d2 || d2.triggers === undefined, 'RED: legacy writer drops the triggers union')
  })

  // apply::oneRunRecordPerApply (REQ-11) — exactly one run-record per apply.
  t('apply::oneRunRecordPerApply', () => {
    const S = mkStore('onerunrec')
    seedMergePair(S, 'orr')
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, 'exit 0')
    eq(runRecordRows(S).length, 1, `exactly one run-record (got ${runRecordRows(S).length})`)
    eq(r.json.run_record, runRecordRows(S)[0].id, 'output run_record id matches the written record')
  })

  // apply::reportNoRunRecord — report mode (no --apply) writes NO run-record.
  t('apply::reportNoRunRecord', () => {
    const S = mkStore('reportnorr')
    seedMergePair(S, 'rnr')
    const r = runClerk(S, { apply: false })
    eq(r.status, 0, 'report exit 0')
    eq(r.json.mode, 'clerk-report', 'report mode')
    eq(runRecordRows(S).length, 0, 'report writes no run-record')
  })

  // runrecord::typedRecordTypeScalar — the run-record carries record_type as a
  // typed scalar (never a tag) with the pinned value.
  t('runrecord::typedRecordTypeScalar', () => {
    const S = mkStore('typedscalar')
    seedMergePair(S, 'trs')
    runClerk(S, { confirm: true })
    const rr = runRecordRows(S)[0]
    eq(rr.record_type, 'clerk-run', 'record_type scalar value')
    eq(rr.category, 'workflow.lifecycle', 'run-record category')
    ok(!Array.isArray(rr.tags) || !rr.tags.includes('clerk-run'), 'record_type is NOT a tag')
  })

  // apply::dedupeIntoCanonical — state A dedupe keeps the canonical (oldest) and
  // supersedes the rest INTO it; NO digest is created (dedupe has no store step 1).
  t('apply::dedupeIntoCanonical', () => {
    const S = mkStore('dedupe')
    const a = '20260101-000000-ddp-aaaa', b = '20260101-000000-ddp-bbbb'
    seedLesson(S, { id: a, tags: ['alpha', 'beta', 'gamma'], summary: 'dedupe canonical shared alpha beta gamma delta one' })
    seedLesson(S, { id: b, tags: ['alpha', 'beta', 'gamma'], summary: 'dedupe canonical shared alpha beta gamma delta two' })
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, `exit 0 (stderr=${r.stderr})`)
    eq(r.json.applied.length, 1, 'one cluster applied')
    eq(r.json.applied[0].action, 'dedupe', 'action dedupe')
    eq(digestRows(S).length, 0, 'dedupe creates NO digest')
    eq(rowById(S, a).status, 'active', 'canonical (oldest) stays active')
    eq(rowById(S, b).status, 'superseded', 'non-canonical superseded')
    eq(rowById(S, b).superseded_by, a, 'non-canonical superseded_by canonical')
  })

  // apply::keepDistinctNoWrite — a state-C pair (summary overlap only, no tag/
  // trigger corroboration) never clusters → no merge/dedupe, members stay active.
  t('apply::keepDistinctNoWrite', () => {
    const S = mkStore('keepdistinct')
    const a = '20260101-000000-kd-aaaa', b = '20260101-000000-kd-bbbb'
    seedLesson(S, { id: a, tags: ['kdalpha'], summary: 'keepdistinct summary overlap alpha beta gamma delta one' })
    seedLesson(S, { id: b, tags: ['kdbeta'], summary: 'keepdistinct summary overlap alpha beta gamma delta two' })
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, 'exit 0')
    eq(r.json.applied.length, 0, 'nothing applied (keep-distinct)')
    eq(digestRows(S).length, 0, 'no digest')
    eq(rowById(S, a).status, 'active', 'member a stays active')
    eq(rowById(S, b).status, 'active', 'member b stays active')
  })

  // apply::consolidatesReachable — after a merge, em-search --history <digest>
  // walks consolidates and surfaces the member ids.
  t('apply::consolidatesReachable', () => {
    const S = mkStore('reachable')
    const [a, b] = seedMergePair(S, 'rch')
    const r = runClerk(S, { confirm: true })
    const digestId = r.json.applied[0].digest_id
    const search = spawnSync('node', [SEARCH, '--history', digestId, '--full', '--scope', 'local'], { cwd: S.root, encoding: 'utf8', env: { ...process.env, HOME: S.home } })
    ok((search.stdout || '').includes(a) && (search.stdout || '').includes(b), `history walk of the digest reaches both members (a=${(search.stdout||'').includes(a)} b=${(search.stdout||'').includes(b)})`)
  })

  // apply::cwdBindingSubprocs — the clerk binds to its spawn cwd: the digest
  // lands in THAT store (S.dataDir), not the harness's own store.
  t('apply::cwdBindingSubprocs', () => {
    const S = mkStore('cwdbind')
    seedMergePair(S, 'cwd')
    const r = runClerk(S, { confirm: true, cwd: S.root })
    const digestId = r.json.applied[0].digest_id
    ok(fs.existsSync(path.join(S.episodesDir, `${digestId}.md`)), 'digest lands in the cwd-bound store')
  })

  // apply::linkedWorktreeLocation (EC2) — run with cwd = a SYMLINK to the store
  // root; the digest still lands in the (real) target store.
  t('apply::linkedWorktreeLocation', () => {
    const S = mkStore('worktree')
    seedMergePair(S, 'wt')
    const linkRoot = path.join(mkTmp('wt-link'), 'link')
    fs.symlinkSync(S.root, linkRoot)
    const r = runClerk(S, { confirm: true, cwd: linkRoot })
    eq(r.status, 0, 'exit 0 via symlinked cwd')
    const digestId = r.json.applied[0].digest_id
    ok(fs.existsSync(path.join(S.episodesDir, `${digestId}.md`)), 'digest lands in the real target store')
  })

  // apply::mergeReversibleViaRevive (F5 / §8.2 P7 undo) — a superseded member is
  // RE-ACTIVATED by driving em-revise --original <member>, which creates a new
  // ACTIVE revision episode (supersedes:<member>). NOT merely file-survives-on-disk.
  t('apply::mergeReversibleViaRevive', () => {
    const S = mkStore('revive')
    const [a] = seedMergePair(S, 'rev')
    runClerk(S, { confirm: true })
    eq(rowById(S, a).status, 'superseded', 'member superseded by the merge')
    const rv = spawnSync('node', [REVISE, '--original', a, '--project', 'acme', '--summary', 'revived member re-activated', '--body', 'reactivation body sentinel'], { cwd: S.root, encoding: 'utf8', env: { ...process.env, HOME: S.home } })
    const rvJson = parseLastJson(rv.stdout)
    eq(rvJson && rvJson.status, 'ok', `em-revise ok (stderr=${rv.stderr})`)
    const revived = rowById(S, rvJson.id)
    ok(revived && revived.status === 'active', 'revision episode is ACTIVE (knowledge re-activated)')
    eq(revived.supersedes, a, 'revision supersedes the merged member (P7 chain undo)')
  })

  // apply::rejectedNotReproposed (REQ-12) — a rejected cluster is not re-proposed
  // against an UNCHANGED store. --break-rejected skips suppression → re-proposed → RED.
  t('apply::rejectedNotReproposed', () => {
    const S = mkStore('rejected')
    seedMergePair(S, 'rej')
    const run1 = runClerk(S, { confirm: true, extraArgs: ['--reject-all'] })
    eq(run1.json.applied.length, 0, 'run1: rejected cluster not applied')
    eq(digestRows(S).length, 0, 'run1: no digest')
    const run2 = runClerk(S, { confirm: true })
    eq(run2.json.applied.length, 0, 'run2: rejected cluster suppressed (not re-applied)')
    eq(run2.json.proposals.length, 0, 'run2: cluster not re-proposed on unchanged store')
    eq(digestRows(S).length, 0, 'run2: still no digest')
    // RED: --break-rejected skips suppression → the cluster is re-proposed & applied.
    const SR = mkStore('rejected-red')
    seedMergePair(SR, 'rejr')
    runClerk(SR, { confirm: true, extraArgs: ['--reject-all'] })
    const red = runClerk(SR, { confirm: true, extraArgs: ['--break-rejected'] })
    ok(red.json.applied.length >= 1, 'RED: --break-rejected re-proposes & applies the rejected cluster')
  })

  // apply::rejectedReproposedOnChangedStore (F3 / §7.2 axis-2) — after a store
  // mutation (new episode) the rejected cluster's fingerprint invalidates → it IS
  // re-proposed. Proves the fingerprint bakes in the source-index state.
  t('apply::rejectedReproposedOnChangedStore', () => {
    const S = mkStore('reproposed')
    seedMergePair(S, 'rep')
    runClerk(S, { confirm: true, extraArgs: ['--reject-all'] })
    // mutate the store: append an unrelated NEW active lesson.
    seedLesson(S, { id: '20260101-000000-rep-cccc', tags: ['unrelatedtag'], summary: 'rep unrelated new lesson sentinel changed store' })
    const run2 = runClerk(S, { confirm: true })
    ok(run2.json.applied.length >= 1, `changed store re-proposes & applies the cluster (applied=${run2.json.applied.length})`)
  })

  // apply::dedupeCanonicalSupersededGuard (F4) — if the canonical is itself
  // already superseded (a concurrent race), refuse — no dedupe of the rest.
  t('apply::dedupeCanonicalSupersededGuard', () => {
    const S = mkStore('canonguard')
    const a = '20260101-000000-cg-aaaa', b = '20260101-000000-cg-bbbb'
    seedLesson(S, { id: a, tags: ['alpha', 'beta', 'gamma'], summary: 'canonguard shared alpha beta gamma delta one' })
    seedLesson(S, { id: b, tags: ['alpha', 'beta', 'gamma'], summary: 'canonguard shared alpha beta gamma delta two' })
    const r = runClerk(S, { confirm: true, extraArgs: ['--sim-race-supersede-canonical'] })
    eq(r.status, 0, 'exit 0')
    ok((r.json.skipped_guard || []).some(g => g.reason === 'canonical-superseded'), `guard fired (got ${JSON.stringify(r.json.skipped_guard)})`)
    eq(rowById(S, b).status, 'active', 'non-canonical NOT superseded into a dead canonical')
  })

  // apply::mergeProtectedMemberGuard (F4) — a cluster containing a protection.mjs
  // -protected (non-pinned) member is refused (a valid trigger-bearing lesson).
  t('apply::mergeProtectedMemberGuard', () => {
    const S = mkStore('protguard')
    const a = '20260101-000000-pg-aaaa', b = '20260101-000000-pg-bbbb'
    // member a is a VALID trigger-bearing lesson (no review_by) → class-b protected.
    seedLesson(S, { id: a, tags: ['alpha', 'beta', 'gamma', 'delta'], summary: 'protguard zebra apple mango one', triggers: ['pgtrig'] })
    seedLesson(S, { id: b, tags: ['alpha', 'beta', 'gamma', 'epsilon'], summary: 'protguard yak plover quince two' })
    const r = runClerk(S, { confirm: true })
    eq(r.status, 0, 'exit 0')
    ok((r.json.skipped_guard || []).some(g => /^protected:/.test(g.reason)), `protected-member guard fired (got ${JSON.stringify(r.json.skipped_guard)})`)
    eq(digestRows(S).length, 0, 'no merge of a protected member')
    eq(rowById(S, a).status, 'active', 'protected member stays active')
  })

  // ---- Step 4.5: run-record survives em-rebuild-index (round-2 N2) ----
  // runrecord::survivesRebuild — after em-rebuild-index the run-record row still
  // carries record_type:'clerk-run' AND protection.mjs class-d reserves it.
  // --break-rebuild-whitelist omits record_type → RED.
  t('runrecord::survivesRebuild', () => {
    const S = mkStore('rebuild')
    seedMergePair(S, 'rbld')
    runClerk(S, { confirm: true })
    const rrId = runRecordRows(S)[0].id
    const rb = spawnSync('node', [REBUILD, '--scope', 'local'], { cwd: S.root, encoding: 'utf8', env: { ...process.env, HOME: S.home } })
    eq(rb.status, 0, `rebuild exit 0 (stderr=${rb.stderr})`)
    const rebuilt = rowById(S, rrId)
    eq(rebuilt && rebuilt.record_type, 'clerk-run', 'record_type survives rebuild')
    const rows = [...loadProtectionRows(fs, path, S.dataDir, 'local')]
    const prot = computeProtectedIds(rows, new Date().toISOString().slice(0, 10), [])
    ok(prot.has(rrId) && prot.get(rrId).reason === 'latest-run-record', `class-d reserves the run-record (got ${JSON.stringify(prot.get(rrId))})`)
    // RED: --break-rebuild-whitelist drops record_type.
    const SR = mkStore('rebuild-red')
    seedMergePair(SR, 'rbldr')
    runClerk(SR, { confirm: true })
    const rrId2 = runRecordRows(SR)[0].id
    spawnSync('node', [REBUILD, '--scope', 'local', '--break-rebuild-whitelist'], { cwd: SR.root, encoding: 'utf8', env: { ...process.env, HOME: SR.home } })
    ok(rowById(SR, rrId2).record_type === undefined, 'RED: broken whitelist drops record_type on rebuild')
  })

  // ---- FOLD ROUND F1: rejected-set read is UNDER the lock (REQ-12/REQ-6 TOCTOU) ----
  // apply::rejectedVisibleUnderLock — a rejection run-record that lands WHILE a
  // concurrent apply B is blocked on the lock is visible to B once it acquires
  // (B re-reads the rejected set under the lock) → B suppresses the cluster.
  // --break-locked-reread keeps the racy pre-lock snapshot → B applies → RED.
  tAsync('apply::rejectedVisibleUnderLock', async () => {
    // GREEN: read-under-lock suppresses the just-rejected cluster.
    const S = mkStore('lockedreread')
    const [a, b] = seedMergePair(S, 'lrr')
    const fp = computeClusterFingerprint([a, b], [a, b])
    const h = tryAcquire(path.join(S.dataDir, 'clerk-apply.lock'))
    ok(h.ok, 'test holds the clerk lock')
    const bp = spawnClerkApplyAsync(S, ['--lock-timeout', '10'])
    await sleep(1500) // B finishes its pre-lock phase and blocks on the lock
    seedSyntheticRunRecord(S, '20991231-235959-clerk-run-synth', [fp])
    release(h.handle)
    const r = await bp
    eq(r.json && r.json.status, 'ok', `B completed ok (stderr=${r.stderr})`)
    eq(r.json.applied.length, 0, 'GREEN: B suppressed the cluster rejected under the lock')
    eq(r.json.proposals.length, 0, 'GREEN: B did not re-propose the rejected cluster')
    eq(digestRows(S).length, 0, 'GREEN: B wrote no digest')
    // RED: --break-locked-reread reads the rejected set PRE-lock (stale) → B applies.
    const SR = mkStore('lockedreread-red')
    const [a2, b2] = seedMergePair(SR, 'lrrr')
    const fp2 = computeClusterFingerprint([a2, b2], [a2, b2])
    const h2 = tryAcquire(path.join(SR.dataDir, 'clerk-apply.lock'))
    ok(h2.ok, 'test holds the clerk lock (red)')
    const bpRed = spawnClerkApplyAsync(SR, ['--lock-timeout', '10', '--break-locked-reread'])
    await sleep(1500)
    seedSyntheticRunRecord(SR, '20991231-235959-clerk-run-synth', [fp2])
    release(h2.handle)
    const rRed = await bpRed
    eq(rRed.json && rRed.json.status, 'ok', `B(red) completed ok (stderr=${rRed.stderr})`)
    ok(rRed.json.applied.length >= 1 && digestRows(SR).length >= 1, 'RED: racy pre-lock read → B applies a cluster rejected under the lock')
  })
}

main()
await runAsyncTests()
console.log(`test-rfc-009-p4-apply: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map((f) => `FAIL ${f}`).join('\n')); process.exit(1) }
