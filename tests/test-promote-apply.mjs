#!/usr/bin/env node
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { computeProtectedIds } from '../scripts/lib/protection.mjs'
import { mintStoreIdentity, rebindStoreIdentity, detachStoreIdentity, resolveStoreIdentity } from '../scripts/lib/store-identity.mjs'
import { canonicalizePromotionSources, serializePromotionSources } from '../scripts/lib/promotion-sources.mjs'
import { tryAcquire, release } from '../scripts/lib/lock.mjs'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PROMOTE = path.join(REPO, 'scripts', 'em-promote.mjs')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const VALIDATE = path.join(REPO, 'scripts', 'em-workflow-validate.mjs')
const ONLY_FLAG = (() => { const i = process.argv.indexOf('--only'); const raw = i < 0 ? '' : process.argv[i + 1]; return raw ? raw.split(',') : [] })()
const onlyMatches = name => ONLY_FLAG.length === 0 || ONLY_FLAG.some(x => name.includes(x))
let pass = 0, fail = 0
const assert = (v, m) => { if (!v) throw new Error(typeof m === 'string' ? m : JSON.stringify(m)) }
const parse = r => { try { return JSON.parse(r.stdout) } catch { throw new Error(`non-JSON stdout: ${r.stdout}${r.stderr}`) } }
const env = home => ({ ...process.env, HOME: home, USERPROFILE: home })
function mkWorld(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `em-promote-apply-${name}-`)); const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true }); const entries = []
  const w = { root, home,
    project(n) { const p = path.join(root, n); const d = path.join(p, '.episodic-memory'); fs.mkdirSync(d, { recursive: true }); return p },
    lesson(project, summary, body) { const r = spawnSync(process.execPath, [STORE, '--project', path.basename(project), '--category', 'lesson', '--summary', summary, '--body', body, '--scope', 'local'], { cwd: project, env: env(home), encoding: 'utf8' }); const o = parse(r); assert(o.status === 'ok', `seed failed ${r.stdout}${r.stderr}`); return o.id },
    promote(args = []) { const extra = process.argv.includes('--break-apply-after-preview') ? ['--break-apply-after-preview'] : []; return spawnSync(process.execPath, [PROMOTE, ...args, ...extra], { cwd: root, env: env(home), encoding: 'utf8' }) },
    globalIndexRows() { const f = path.join(home, '.episodic-memory', 'index.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(r => r.category === 'lesson') : [] },
    globalIndexAll() { const f = path.join(home, '.episodic-memory', 'index.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] },
  }
  function register(p, identity) { entries.push({ project_path: p, tool: 'claude-code', version: 'v1', enforcement_installed: false, last_install_ts: '2026-07-08T00:00:00Z', store_id: identity.active_id, store_aliases: identity.aliases }); fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'), JSON.stringify({ schema_version: 2, entries }, null, 2)) }
  w.project = n => { const p = path.join(root, n); const d = path.join(p, '.episodic-memory'); fs.mkdirSync(d, { recursive: true }); const identity = mintStoreIdentity(d); register(p, identity); return p }
  return w
}
const body = 'always quote hook command paths in settings json S4 fixture because unquoted node paths split'
const TESTS = []
function t(name, fn) { TESTS.push({ name, fn }) }
function pair(name) { const w = mkWorld(name); const a = w.project('projA'); const b = w.project('projB'); w.lesson(a, 'always quote hook command paths', body); w.lesson(b, 'always quote hook command paths in hooks', body); return w }
function fp(c) { return crypto.createHash('sha256').update(serializePromotionSources(canonicalizePromotionSources(c.promotion_sources))).digest('hex') }

// Real-lock test helper: acquire the GLOBAL store lock from the TEST side so a
// spawned child blocks trying to acquire it. The child still computes its
// `fresh` candidate set at process start (BEFORE the lock), so its selection
// fingerprint reflects the source as-of-launch. After we mutate the source we
// release the lock; the child then acquires it, recomputes under the lock,
// and detects the mutation. This is the only way to exercise the F3 race
// (lock-around-write) AND the F6/fingerprint-stale distinction without
// weakening assertions or adding a production mutation hook.
function acquireGlobalLock(world) {
  const lockFile = path.join(world.home, '.episodic-memory', 'clerk-apply.lock')
  const got = tryAcquire(lockFile)
  if (!got.ok) throw new Error(`test could not acquire lock: heldBy=${got.heldBy}`)
  return got.handle
}
function spawnApplyChild(world, args) {
  const child = spawn(process.execPath, [PROMOTE, ...args], { cwd: world.root, env: env(world.home) })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => stdout += d)
  child.stderr.on('data', d => stderr += d)
  return {
    child, getStdout: () => stdout, getStderr: () => stderr,
    wait: () => new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) }),
  }
}

// ---- sync tests ----

t('testApplyRequiresConfirm', () => { const w = pair('requires'); const o = parse(w.promote(['--apply'])); assert(o.promoted[0].error === 'confirm-required', `expected confirm-required, got ${JSON.stringify(o)}`); assert(w.globalIndexRows().length === 0, `expected zero lesson rows, got ${JSON.stringify(w.globalIndexRows())}`); fs.rmSync(w.root, { recursive: true, force: true }) })

t('testPreviewCarriesFingerprint', () => { const w = pair('preview'); const o = parse(w.promote()); for (const c of o.candidates) assert(/^[0-9a-f]{64}$/.test(c.fingerprint) && c.fingerprint === fp(c), `fingerprint mismatch for ${c.hash}: ${c.fingerprint} vs ${fp(c)}`); fs.rmSync(w.root, { recursive: true, force: true }) })

t('testApplyWithConfirmWrites', () => { const w = pair('writes'); const p = parse(w.promote()); const o = parse(w.promote(['--apply', '--confirm', p.candidates[0].fingerprint])); assert(o.promoted.length === 1 && o.promoted[0].digest_id, `expected one promoted row, got ${JSON.stringify(o)}`); assert(w.globalIndexRows().some(r => r.promotion_sources), `expected lesson row with promotion_sources, got ${JSON.stringify(w.globalIndexRows())}`); fs.rmSync(w.root, { recursive: true, force: true }) })

// F6: any confirmed value absent from this process's selection is
// confirm-unknown-fingerprint (covers BOTH all-zeros AND foreign nonzero).
t('testConfirmUnknownFingerprint', () => { const w = pair('unknown-zeros'); const r = w.promote(['--apply', '--confirm', '0'.repeat(64)]); const o = parse(r); assert(r.status === 2 && o.error === 'confirm-unknown-fingerprint', `expected exit 2 / confirm-unknown-fingerprint, got status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`); assert(w.globalIndexRows().length === 0, `expected zero lesson rows, got ${JSON.stringify(w.globalIndexRows())}`); fs.rmSync(w.root, { recursive: true, force: true }) })

t('testConfirmUnknownFingerprintForeignNonzero', () => { const w = pair('unknown-nonzero'); const r = w.promote(['--apply', '--confirm', 'a'.repeat(64)]); const o = parse(r); assert(r.status === 2 && o.error === 'confirm-unknown-fingerprint', `foreign nonzero confirmed value must be rejected: status=${r.status} stdout=${r.stdout}`); assert(w.globalIndexRows().length === 0, `expected zero lesson rows, got ${JSON.stringify(w.globalIndexRows())}`); fs.rmSync(w.root, { recursive: true, force: true }) })

// F5: --break-apply-after-preview refuses AFTER preview (recompute under the
// lock) and BEFORE every write. One synchronous test with the runner's own
// --break-apply-after-preview flag forwarded into the child.
t('testBreakApplyAfterPreview', () => { const w = pair('break'); const p = parse(w.promote()); const fp = p.candidates[0].fingerprint; const r = spawnSync(process.execPath, [PROMOTE, '--apply', '--confirm', fp, '--break-apply-after-preview'], { cwd: w.root, env: { ...process.env, HOME: w.home, USERPROFILE: w.home }, encoding: 'utf8' }); const o = parse(r); assert(r.status === 0, `expected exit 0, got status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`); assert(o.promoted[0].error === 'break-apply-after-preview', `expected break-apply-after-preview, got ${JSON.stringify(o)}`); assert(!w.globalIndexRows().some(r => r.promotion_sources), `expected no lesson rows, got ${JSON.stringify(w.globalIndexRows())}`); fs.rmSync(w.root, { recursive: true, force: true }) })

t('testPromoteRunRecord', () => { const w = pair('record'); const p = parse(w.promote()); const o = parse(w.promote(['--apply', '--confirm', p.candidates[0].fingerprint])); assert(o.status === 'ok', `apply failed: ${JSON.stringify(o)}`); const all = w.globalIndexAll(); const runRows = all.filter(r => r.record_type === 'promote-run'); assert(runRows.length === 1, `expected one promote-run row, got ${runRows.length}: ${JSON.stringify(all)}`); const epContent = fs.readFileSync(path.join(w.home, '.episodic-memory', 'episodes', `${runRows[0].id}.md`), 'utf8'); assert(epContent.includes(p.candidates[0].fingerprint), `run-record body must name the confirmed fingerprint, got: ${epContent}`); fs.rmSync(w.root, { recursive: true, force: true }) })

t('testPromoteRunGlobalOnly', () => { const w = pair('global-only'); const p = parse(w.promote()); parse(w.promote(['--apply', '--confirm', p.candidates[0].fingerprint])); for (const proj of ['projA', 'projB']) { const idx = path.join(w.root, proj, '.episodic-memory', 'index.jsonl'); if (fs.existsSync(idx)) { const txt = fs.readFileSync(idx, 'utf8'); assert(!txt.includes('promote-run'), `project ${proj} must not contain promote-run row`) } } fs.rmSync(w.root, { recursive: true, force: true }) })

t('testWriteMatrix', () => { const w = pair('matrix'); const o = parse(w.promote(['--apply'])); assert(o.promoted[0].error === 'confirm-required', `expected confirm-required, got ${JSON.stringify(o)}`); const all = w.globalIndexAll(); assert(all.some(r => r.record_type === 'promote-run'), `expected promote-run record even when content write refused: ${JSON.stringify(all)}`); fs.rmSync(w.root, { recursive: true, force: true }) })

t('testPromoteRunProtectionArm', () => { const m = computeProtectedIds([{ id: 'pr1', _store: 'g', record_type: 'promote-run' }, { id: 'pr0', _store: 'g', record_type: 'promote-run' }, { id: 'plain1', category: 'context' }], '2026-07-08'); assert(m.get('pr1')?.reason === 'latest-promote-run', `expected pr1 to be latest-promote-run, got ${JSON.stringify([...m.entries()])}`); assert(!m.has('pr0'), `pr0 must not be protected (latest-only): ${JSON.stringify([...m.entries()])}`); assert(!m.has('plain1'), `plain1 must not be protected: ${JSON.stringify([...m.entries()])}`) })

t('testPromoteRunNotChainSeed', () => { const m = computeProtectedIds([{ id: 'pr1', _store: 'g', record_type: 'promote-run', supersedes: 'old' }], '2026-07-08'); assert(!m.has('old'), `supersedes target must not be in the protected set (chain-seed exclusion): ${JSON.stringify([...m.entries()])}`) })

// Validator-test fixture helpers (final-fold P2-A): mirror the existing
// `tests/test-workflow-validate.mjs` builders (mkEpisode) at a minimal shape
// so the S4 §A.7 step 4.1 contract is testable. Reuses the production
// `validateCategory` semantics by writing well-formed `workflow.lifecycle`
// frontmatter + a fenced ```json payload carrying the lifecycle event.
let lifecycleCounter = 0
function mkLifecycleEpisode(world, { event, task = 's4', patternId = 'bp-001-implementation-workflow', branch = 'main', head = 'abc1234', extra = {} }) {
  lifecycleCounter++
  const id = `20260721-1200${String(lifecycleCounter).padStart(2, '0')}-${event}-${lifecycleCounter.toString(16).padStart(4, '0')}`
  const payload = {
    event,
    pattern_id: patternId,
    task,
    context: { worktree: world.root, branch, head },
    ...extra,
  }
  const body = `# ${event}\n\nFinal-fold fixture.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
  const fm = [
    '---',
    `id: ${id}`,
    'date: 2026-07-21',
    'time: "12:00"',
    'project: test',
    'category: workflow.lifecycle',
    'status: active',
    'tags: []',
    `summary: ${event}`,
    '---',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(world.home, '.episodic-memory', 'episodes', `${id}.md`), fm + '\n' + body)
  fs.appendFileSync(path.join(world.home, '.episodic-memory', 'index.jsonl'), JSON.stringify({
    id, date: '2026-07-21', time: '12:00', project: 'test',
    category: 'workflow.lifecycle', status: 'active', tags: [], summary: event,
  }) + '\n')
  return id
}

// §A.7 step 4.1 (P2-A final-fold): the exact validator regression coverage.
// Fixture must contain (a) raw-JSON `clerk-run` AND `promote-run` records,
// AND (b) a valid `plan-approved` + `pre-checkpoint` lifecycle chain for the
// selected task so `valid: true, errors: []` is reachable. The same
// no-blast-radius assertion must hold from a SECOND, otherwise-empty project
// store against the same global (REQ-20 / B-3 cross-project gating).
t('testRunRecordsInvisibleToWorkflowValidate', () => {
  const w = pair('validator')
  // (a) promote-run record is auto-written by --apply.
  const p = parse(w.promote())
  parse(w.promote(['--apply', '--confirm', p.candidates[0].fingerprint]))
  // (a) write a clerk-run record into the fixture (raw JSON, no fence).
  const globalEpsDir = path.join(w.home, '.episodic-memory', 'episodes')
  const clerkRunId = '20260721-120000-clerk-run-final-fold-aaaa'
  const clerkRunBody = JSON.stringify({ run_meta: { mode: 'clerk', ts: new Date().toISOString(), note: 'final-fold fixture clerk-run (raw JSON, no fence by design)' } })
  const clerkFm = [
    '---', `id: ${clerkRunId}`, 'date: 2026-07-21', 'time: "120000"', 'project: test',
    'category: workflow.lifecycle', 'status: active', 'tags: []', `summary: clerk run`,
    'record_type: clerk-run', '---', '',
  ].join('\n')
  fs.writeFileSync(path.join(globalEpsDir, clerkRunId + '.md'), clerkFm + '\n' + clerkRunBody)
  fs.appendFileSync(path.join(w.home, '.episodic-memory', 'index.jsonl'), JSON.stringify({
    id: clerkRunId, date: '2026-07-21', time: '120000', project: 'test',
    category: 'workflow.lifecycle', status: 'active', tags: [], summary: 'clerk run', record_type: 'clerk-run',
  }) + '\n')
  // (b) seed a valid plan-approved + pre-checkpoint lifecycle chain for task=s4.
  const planId = mkLifecycleEpisode(w, { event: 'plan-approved', extra: { plan_ref: 'docs/plans/rfc-012-p2.md', classification: 'full' } })
  mkLifecycleEpisode(w, { event: 'pre-checkpoint', extra: { plan_ref: 'docs/plans/rfc-012-p2.md', approval_ref: `episode:${planId}` } })
  // First-project assertion: exit 0, valid: true, errors: [].
  const r1 = spawnSync(process.execPath, [VALIDATE, '--task', 's4', '--gate', 'pre-checkpoint', '--scope', 'all'], { cwd: w.root, env: env(w.home), encoding: 'utf8' })
  const j1 = parse(r1)
  assert(r1.status === 0, `validator must exit 0 for the seeded chain: status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`)
  assert(j1.valid === true, `validator must return valid:true: ${r1.stdout}`)
  assert(Array.isArray(j1.errors) && j1.errors.length === 0, `validator errors must be empty: ${r1.stdout}`)
  assert(!r1.stdout.includes('No ```json fenced block found'), 'clerk-run raw-JSON must NOT trip the fence parser')
  // Verify the run-record ids are not in errors[] (the §A.8 mechanical pass).
  for (const runId of [clerkRunId, ...w.globalIndexAll().filter(r => r.record_type === 'promote-run').map(r => r.id)]) {
    assert(!j1.errors.some(e => e.includes(runId)), `run-record id ${runId} must NOT appear in errors[]: ${JSON.stringify(j1.errors)}`)
  }
  // Second-project blast-radius check: invoke from an otherwise-empty project
  // store against the SAME global (reusing HOME so the global index +
  // episodes are visible to the second-project's validator). The empty
  // project has no lessons, no promotions, no run-records — but the global
  // run-records must remain invisible to the second project's lifecycle
  // scan. Pass --worktree with the FIRST project's worktree so the same
  // valid global lifecycle chain (whose episodes reference that worktree
  // path) remains valid: that is the no-blast-radius invariant under test
  // — the run-records are present in the global store but cause no error
  // from the second project.
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-promote-apply-validator-empty-'))
  const r2 = spawnSync(process.execPath, [VALIDATE, '--task', 's4', '--gate', 'pre-checkpoint', '--scope', 'all', '--worktree', w.root], { cwd: emptyRoot, env: env(w.home), encoding: 'utf8' })
  const j2 = parse(r2)
  assert(r2.status === 0, `second-project validator must exit 0: status=${r2.status} stdout=${r2.stdout} stderr=${r2.stderr}`)
  assert(j2.valid === true, `second-project validator must return valid:true: ${r2.stdout}`)
  assert(Array.isArray(j2.errors) && j2.errors.length === 0, `second-project validator errors must be empty: ${r2.stdout}`)
  for (const runId of [clerkRunId, ...w.globalIndexAll().filter(r => r.record_type === 'promote-run').map(r => r.id)]) {
    assert(!j2.errors.some(e => e.includes(runId)), `second-project blast radius: run-record id ${runId} must NOT appear in errors[]: ${JSON.stringify(j2.errors)}`)
  }
  fs.rmSync(w.root, { recursive: true, force: true })
  fs.rmSync(emptyRoot, { recursive: true, force: true })
})

// P1-C (final-fold): empty-selection unknown confirm exits 2 with
// `confirm-unknown-fingerprint` and writes nothing. A single-store world
// (1 registerable project, no recurrence ⇒ fresh=[]) plus an unrelated
// `--confirm` value must NOT exit 0.
t('testConfirmUnknownFingerprintEmptySelection', () => {
  // world with ONE project — insufficient for cross-store recurrence.
  const w = mkWorld('empty-confirm')
  const only = w.project('only')
  const r = spawnSync(process.execPath, [PROMOTE, '--apply', '--confirm', '0'.repeat(64)], { cwd: w.root, env: env(w.home), encoding: 'utf8' })
  const o = parse(r)
  assert(r.status === 2, `empty selection must exit 2, got status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`)
  assert(o.error === 'confirm-unknown-fingerprint', `empty selection must surface confirm-unknown-fingerprint, got: ${r.stdout}`)
  assert(w.globalIndexRows().length === 0, `expected zero lesson rows, got ${JSON.stringify(w.globalIndexRows())}`)
  assert(!w.globalIndexAll().some(r => r.record_type === 'promote-run'), `unknown-fingerprint must NOT write a run-record: ${JSON.stringify(w.globalIndexAll())}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// Static taxonomy gap (P4 final-fold): with multiple fresh candidates,
// confirming one does NOT make every other fresh-but-unconfirmed candidate
// stale. The unconfirmed item is `confirm-required` per §A.5-S4. The
// fixture uses four stores with deliberately disjoint vocabularies plus an
// explicit `--min-sim` so the dry-run produces two fresh candidates.
t('testApplyMultiFreshConfirmOne', () => {
  const w = mkWorld('multi-fresh')
  const a = w.project('projA'); const b = w.project('projB'); const c = w.project('projC'); const d = w.project('projD')
  // Cluster 1: quotes in hook command paths (recurs across A+B).
  w.lesson(a, 'always quote hook command paths', 'quote hook command paths because unquoted node paths split on spaces')
  w.lesson(b, 'always quote hook command paths in settings', 'quote hook command paths because unquoted node paths split on spaces')
  // Cluster 2: terminate stuck classify-correction worker (recurs across C+D).
  w.lesson(c, 'terminate stuck classify-correction worker', 'terminate stuck classify-correction worker because the marker queue wedges after a malformed payload')
  w.lesson(d, 'kill stuck classify-correction worker', 'terminate stuck classify-correction worker because the marker queue wedges after a malformed payload')
  // Two disjoint vocabularies plus a moderate --min-sim so both clusters
  // are FRESH and disjoint.
  const preview = parse(w.promote(['--min-sim', '0.3']))
  assert(preview.candidates.length === 2, `expected two fresh candidates, got ${preview.candidates.length}: ${JSON.stringify(preview.candidates)}`)
  // Confirm only the first fingerprint; the second must surface as
  // `confirm-required` (NOT `fingerprint-stale`).
  const fp1 = preview.candidates[0].fingerprint
  const fp2 = preview.candidates[1].fingerprint
  assert(fp1 !== fp2, `fingerprints must differ: ${fp1} vs ${fp2}`)
  const o = parse(w.promote(['--apply', '--confirm', fp1]))
  // Surgical match: the apply output's SUCCESSFUL row carries `hash` (the
  // candidate hash from the preview) and `digest_id`, but no fingerprint
  // (the public surface). The UNCONFIRMED row carries `fingerprint` and an
  // error. Match the confirmed row by hash, the unconfirmed by fingerprint.
  const byHash = new Map(o.promoted.filter(p => p.hash).map(p => [p.hash, p]))
  const confirmedRow = byHash.get(preview.candidates[0].hash)
  assert(confirmedRow?.digest_id, `confirmed candidate must write a digest: ${JSON.stringify(o.promoted)}`)
  const unconfirmed = o.promoted.find(p => p.fingerprint === fp2)
  assert(unconfirmed, `unconfirmed candidate must appear in promoted[]: ${JSON.stringify(o.promoted)}`)
  assert(unconfirmed.error === 'confirm-required', `unconfirmed candidate must be confirm-required, got ${unconfirmed.error}`)
  // Exactly one lesson row written (the confirmed one).
  const lessons = w.globalIndexRows().filter(r => r.promotion_sources)
  assert(lessons.length === 1, `expected exactly one lesson row, got ${lessons.length}: ${JSON.stringify(w.globalIndexRows())}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// P1-A (final-fold) negative control: surface `index_stale: true` in the
// public JSON when secondary-index maintenance degrades. Build a normal
// fresh candidate, make `GLOBAL_DIR/tags.json.tmp` a directory (the rename
// inside the writePromoteRunRecord tags block fails), run --apply without
// --confirm (so no EM_STORE content write occurs), assert: content is
// refused, run-record episode + index row are durable, output has
// `index_stale === true`, exit remains 0.
t('testRunRecordIndexStaleSurfaced', () => {
  const w = pair('index-stale')
  const o = parse(w.promote(['--apply']))
  assert(o.promoted[0].error === 'confirm-required', `expected confirm-required, got ${JSON.stringify(o)}`)
  // Degrade the tags.json.tmp tmp+rename by pre-creating the tmp path as
  // a directory. fs.renameSync over a non-empty directory errors with
  // ENOTEMPTY/EISDIR on macOS, which the catch block maps to index_stale.
  const tagsTmp = path.join(w.home, '.episodic-memory', 'tags.json.tmp')
  try { fs.rmSync(tagsTmp, { recursive: true, force: true }) } catch {}
  fs.mkdirSync(tagsTmp, { recursive: true })
  // Run --apply with a real confirm to actually trigger the writer.
  const preview = parse(w.promote())
  const fp = preview.candidates[0].fingerprint
  const r = spawnSync(process.execPath, [PROMOTE, '--apply', '--confirm', fp], { cwd: w.root, env: env(w.home), encoding: 'utf8' })
  const j = parse(r)
  assert(r.status === 0, `exit must remain 0 even on degraded index maintenance: status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`)
  assert(j.index_stale === true, `output must surface index_stale: true, got: ${r.stdout}`)
  // Lesson row + run-record episode are still durable.
  const all = w.globalIndexAll()
  const lessonRow = all.find(r => r.promotion_sources)
  assert(lessonRow, `lesson row must be durable despite degraded tags: ${JSON.stringify(all)}`)
  const runRow = all.find(r => r.record_type === 'promote-run')
  assert(runRow, `run-record row must be durable: ${JSON.stringify(all)}`)
  const runEpisodePath = path.join(w.home, '.episodic-memory', 'episodes', `${runRow.id}.md`)
  assert(fs.existsSync(runEpisodePath), `run-record episode file must be on disk: ${runEpisodePath}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// P2-C (final-fold ACCEPT-WITH-MOD): migration successor body preserves the
// legacy lesson body (active-recall surface). Seed a legacy global promoted
// lesson with a sentinel in the body; run --migrate --confirm <fp>; assert
// the sentinel appears in the successor's body. Legacy file is immutable
// (P7) — the body section (everything after the closing `---` frontmatter
// delimiter) MUST remain byte-identical before and after migration; the
// frontmatter status flips to `superseded` as part of the chain.
t('testMigrationPreservesLegacyBody', () => {
  const SENTINEL = 'SENTINEL_p2c_legacy_7c3a'
  const w = pair('preserve-body')
  const { legacyId } = seedLegacyGlobal(w)
  // Patch the legacy file in-place to insert the sentinel into the body.
  const legacyPath = path.join(w.home, '.episodic-memory', 'episodes', legacyId + '.md')
  const legacyText = fs.readFileSync(legacyPath, 'utf8')
  const sentinelText = legacyText.replace('# Legacy promoted lesson\n\n', `# Legacy promoted lesson\n\nLegacy body carries the ${SENTINEL} so the successor can echo it.\n\n`)
  fs.writeFileSync(legacyPath, sentinelText)
  // Snapshot the legacy body section (everything after the closing `---`).
  const sentinelBody = sentinelText.split('---').slice(2).join('---').trim()
  const preview = parse(w.promote(['--migrate']))
  const migFp = preview.candidates.find(c => c.id === legacyId).fingerprint
  const result = parse(w.promote(['--migrate', '--confirm', migFp]))
  assert(result.migrated.length === 1, `expected one migration, got ${JSON.stringify(result)}`)
  const successorId = result.migrated[0].successor
  const successorPath = path.join(w.home, '.episodic-memory', 'episodes', successorId + '.md')
  const successorText = fs.readFileSync(successorPath, 'utf8')
  // (a) sentinel appears in successor body (active-recall surface).
  assert(successorText.includes(SENTINEL), `successor body must preserve the legacy ${SENTINEL}: ${successorText}`)
  // (b) legacy body byte-identical (P7 immutability).
  const legacyAfter = fs.readFileSync(legacyPath, 'utf8')
  const legacyAfterBody = legacyAfter.split('---').slice(2).join('---').trim()
  assert(legacyAfterBody === sentinelBody, `legacy body must remain byte-identical (P7): before=${sentinelBody} after=${legacyAfterBody}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// ---- async tests (real-lock + genuine concurrency) ----

// F3/fingerprint-stale real-lock test: hold the global store lock from the
// TEST side, start an apply child (it computes fresh from the original
// source, then blocks on the lock), substitute the source, release the lock,
// and assert the child returns fingerprint-stale with zero writes.
t('testFingerprintRevalidation', async () => {
  const w = pair('stale')
  const p = parse(w.promote())
  const c = p.candidates[0]
  const src = c.members[0]
  const srcFile = path.join(src.stores[0], 'episodes', `${src.id}.md`)
  const lockHandle = acquireGlobalLock(w)
  let child
  try {
    child = spawnApplyChild(w, ['--apply', '--confirm', c.fingerprint])
    // Give the child time to compute `fresh` and block on the lock.
    await new Promise(r => setTimeout(r, 300))
    fs.appendFileSync(srcFile, '\nsubstituted')
    release(lockHandle)
    await child.wait()
  } catch (e) {
    try { release(lockHandle) } catch {}
    throw e
  }
  const o = JSON.parse(child.getStdout())
  assert(o.promoted[0].error === 'fingerprint-stale', `expected fingerprint-stale, got ${JSON.stringify(o)}`)
  assert(!w.globalIndexRows().some(r => r.promotion_sources), `expected no lesson rows, got ${JSON.stringify(w.globalIndexRows())}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testRebindDuringApply', async () => {
  const w = pair('rebind')
  const p = parse(w.promote())
  const c = p.candidates[0]
  const storeA = path.join(w.root, 'projA', '.episodic-memory')
  const lockHandle = acquireGlobalLock(w)
  let child
  try {
    child = spawnApplyChild(w, ['--apply', '--confirm', c.fingerprint])
    await new Promise(r => setTimeout(r, 300))
    rebindStoreIdentity(storeA)
    release(lockHandle)
    await child.wait()
  } catch (e) {
    try { release(lockHandle) } catch {}
    throw e
  }
  const o = JSON.parse(child.getStdout())
  assert(o.promoted[0].error === 'fingerprint-stale', `expected fingerprint-stale, got ${JSON.stringify(o)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testDetachDuringApply', async () => {
  const w = pair('detach')
  const p = parse(w.promote())
  const c = p.candidates[0]
  const storeA = path.join(w.root, 'projA', '.episodic-memory')
  const lockHandle = acquireGlobalLock(w)
  let child
  try {
    child = spawnApplyChild(w, ['--apply', '--confirm', c.fingerprint])
    await new Promise(r => setTimeout(r, 300))
    detachStoreIdentity(storeA)
    release(lockHandle)
    await child.wait()
  } catch (e) {
    try { release(lockHandle) } catch {}
    throw e
  }
  const o = JSON.parse(child.getStdout())
  assert(o.promoted[0].error === 'fingerprint-stale', `expected fingerprint-stale, got ${JSON.stringify(o)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// F3 genuine two-process concurrency (P3 final-fold): use the existing
// test-side real global lock-holder pattern BEFORE spawning both apply
// children. Spawn both while the lock is held, allow them to complete
// selection and queue on the lock, then release; assert exactly one write
// and one `fingerprint-stale` refusal. Do NOT accept `confirm-required` or
// `lock-timeout` as the normal expected loser — those indicate the test
// setup, not the F3 race. This is the only way to exercise the F3
// lock-around-write guarantee without weakening assertions.
t('testConcurrentApplySecondRefuses', async () => {
  const w = pair('concurrent')
  const p = parse(w.promote())
  const fp = p.candidates[0].fingerprint
  // Acquire the lock from the TEST side so both children queue on it.
  const lockHandle = acquireGlobalLock(w)
  let c1, c2
  try {
    c1 = spawnApplyChild(w, ['--apply', '--confirm', fp])
    c2 = spawnApplyChild(w, ['--apply', '--confirm', fp])
    // Give both children time to compute `fresh` and block on the lock.
    await new Promise(r => setTimeout(r, 400))
    release(lockHandle)
    await Promise.all([c1.wait(), c2.wait()])
  } catch (e) {
    try { release(lockHandle) } catch {}
    throw e
  }
  const o1 = JSON.parse(c1.getStdout())
  const o2 = JSON.parse(c2.getStdout())
  const writes = [o1, o2].filter(o => o.promoted?.some(x => x.digest_id))
  const fingerprintStale = [o1, o2].filter(o => o.promoted?.some(x => x.error === 'fingerprint-stale'))
  assert(writes.length === 1, `expected exactly one write, got ${writes.length}: o1=${JSON.stringify(o1)} o2=${JSON.stringify(o2)}`)
  assert(fingerprintStale.length === 1, `expected exactly one fingerprint-stale refusal (the F3 race), got ${fingerprintStale.length}: o1=${JSON.stringify(o1)} o2=${JSON.stringify(o2)}`)
  const lessons = w.globalIndexRows().filter(r => r.promotion_sources)
  assert(lessons.length === 1, `expected exactly one lesson row, got ${lessons.length}: ${JSON.stringify(w.globalIndexRows())}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// ---- F1 migration tests ----

// Helper: create a legacy global promoted lesson with parseable `## Sources`
// referencing episodes in the registered local stores. Returns the legacy id
// and the candidate fingerprint that --migrate will select.
function seedLegacyGlobal(w) {
  const aDir = path.join(w.root, 'projA', '.episodic-memory')
  const bDir = path.join(w.root, 'projB', '.episodic-memory')
  const idA = JSON.parse(fs.readFileSync(path.join(aDir, 'index.jsonl'), 'utf8').trim().split('\n')[0]).id
  const idB = JSON.parse(fs.readFileSync(path.join(bDir, 'index.jsonl'), 'utf8').trim().split('\n')[0]).id
  const legacyId = '20200101-120000-legacy-promoted'
  const legacyContent = `---
id: ${legacyId}
date: 2020-01-01
time: "120000"
project: cross-project
category: lesson
status: active
tags: [promoted-lesson, promoted:abc12345]
summary: Recurring lesson (legacy)
---

# Legacy promoted lesson

## Sources

- ${idA} (projA, ${aDir})
- ${idB} (projB, ${bDir})
`
  const globalEpsDir = path.join(w.home, '.episodic-memory', 'episodes')
  fs.mkdirSync(globalEpsDir, { recursive: true })
  fs.writeFileSync(path.join(globalEpsDir, legacyId + '.md'), legacyContent)
  const globalIdx = path.join(w.home, '.episodic-memory', 'index.jsonl')
  const row = JSON.stringify({
    id: legacyId,
    date: '2020-01-01',
    time: '120000',
    project: 'cross-project',
    category: 'lesson',
    status: 'active',
    tags: ['promoted-lesson', 'promoted:abc12345'],
    summary: 'Recurring lesson (legacy)',
  })
  fs.appendFileSync(globalIdx, row + '\n')
  return { legacyId, idA, idB }
}

t('testMigrationSuccessors', () => {
  const w = pair('migration')
  const { legacyId } = seedLegacyGlobal(w)
  // Dry-run --migrate to capture the candidate fingerprint
  const preview = parse(w.promote(['--migrate']))
  assert(preview.dry_run === true, `expected dry-run, got ${JSON.stringify(preview)}`)
  assert(preview.candidates.length === 1, `expected one candidate, got ${preview.candidates.length}: ${JSON.stringify(preview)}`)
  const migFp = preview.candidates[0].fingerprint
  assert(/^[0-9a-f]{64}$/.test(migFp), `expected 64-hex fingerprint, got ${migFp}`)
  assert(preview.candidates[0].id === legacyId, `expected candidate id ${legacyId}, got ${preview.candidates[0].id}`)
  // Confirm + migrate
  const result = parse(w.promote(['--migrate', '--confirm', migFp]))
  assert(result.migrated.length === 1, `expected one migrated, got ${JSON.stringify(result)}`)
  const m = result.migrated[0]
  assert(m.original === legacyId, `expected original=${legacyId}, got ${JSON.stringify(m)}`)
  assert(typeof m.successor === 'string' && m.successor !== legacyId, `expected a distinct successor id, got ${JSON.stringify(m)}`)
  // Successor has promotion_sources typed and corrected project (not cross-project)
  const succRow = w.globalIndexAll().find(r => r.id === m.successor)
  assert(succRow, `successor not in index: ${JSON.stringify(w.globalIndexAll())}`)
  assert(Array.isArray(succRow.promotion_sources) && succRow.promotion_sources.length === 2, `expected typed promotion_sources on successor, got ${JSON.stringify(succRow)}`)
  assert(succRow.project !== 'cross-project', `expected corrected project (not cross-project), got ${succRow.project}`)
  assert(succRow.supersedes === legacyId, `expected supersedes=${legacyId}, got ${succRow.supersedes}`)
  // Prior id still resolvable
  const allIds = w.globalIndexAll().map(r => r.id)
  assert(allIds.includes(legacyId), `prior id ${legacyId} must still appear in index: ${JSON.stringify(allIds)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testMigrationTypedSuccessorNotReselected', () => {
  const w = pair('migration-idempotent')
  const { legacyId } = seedLegacyGlobal(w)
  const preview = parse(w.promote(['--migrate']))
  const migFp = preview.candidates.find(c => c.id === legacyId).fingerprint
  const first = parse(w.promote(['--migrate', '--confirm', migFp]))
  assert(first.migrated.length === 1, `expected one migration, got ${JSON.stringify(first)}`)
  const successor = first.migrated[0].successor
  const afterFirst = w.globalIndexAll()
  const successorRow = afterFirst.find(r => r.id === successor)
  assert(successorRow?.status === 'active', `successor must be active: ${JSON.stringify(successorRow)}`)
  assert(Array.isArray(successorRow.promotion_sources) && successorRow.promotion_sources.length > 0,
    `successor must carry valid typed promotion_sources: ${JSON.stringify(successorRow)}`)
  assert(afterFirst.find(r => r.id === legacyId)?.status === 'superseded', 'legacy predecessor must retain superseded evidence')
  const second = parse(w.promote(['--migrate']))
  assert(second.candidates.length === 0, `repeat migration must have zero candidates: ${JSON.stringify(second)}`)
  assert(!second.candidates.some(c => c.id === successor) && !second.skipped.some(s => s.hash === successor),
    `typed successor must be absent from candidates and skipped: ${JSON.stringify(second)}`)
  const lessonIds = () => w.globalIndexRows().map(r => r.id).sort()
  const runCount = () => w.globalIndexAll().filter(r => r.record_type === 'promote-run').length
  const beforeRetryLessons = lessonIds(); const beforeRetryRuns = runCount()
  const retry = w.promote(['--migrate', '--confirm', migFp])
  const retryOutput = parse(retry)
  assert(retry.status === 2 && retryOutput.error === 'confirm-unknown-fingerprint',
    `old confirmation must be rejected: status=${retry.status} output=${JSON.stringify(retryOutput)}`)
  assert(JSON.stringify(lessonIds()) === JSON.stringify(beforeRetryLessons), 'retry wrote a new lesson row')
  assert(runCount() === beforeRetryRuns, 'unknown confirmation wrote an extra run-record')
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testPriorIdsPersist', () => {
  const w = pair('prior')
  const { legacyId } = seedLegacyGlobal(w)
  const preview = parse(w.promote(['--migrate']))
  const migFp = preview.candidates[0].fingerprint
  parse(w.promote(['--migrate', '--confirm', migFp]))
  const allIds = w.globalIndexAll().map(r => r.id)
  assert(allIds.includes(legacyId), `prior id ${legacyId} must still appear in index after migration: ${JSON.stringify(allIds)}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testHandAuthoredTagNotSwept', () => {
  const w = pair('hand')
  // Create a global episode with `promoted-lesson` tag but NO `## Sources`
  // section. Its project must remain byte-identical after --migrate.
  const legacyId = '20200202-120000-hand-authored'
  const project = 'hand-authored-project'
  const legacyContent = `---
id: ${legacyId}
date: 2020-02-02
time: "120000"
project: ${project}
category: lesson
status: active
tags: [promoted-lesson, promoted:deadbeef]
summary: Hand-authored promoted (no Sources)
---

# Hand-authored

This episode carries the promoted-lesson tag by hand but lacks a parseable
## Sources section, so the state B predicate must skip it.
`
  const globalEpsDir = path.join(w.home, '.episodic-memory', 'episodes')
  fs.mkdirSync(globalEpsDir, { recursive: true })
  fs.writeFileSync(path.join(globalEpsDir, legacyId + '.md'), legacyContent)
  const globalIdx = path.join(w.home, '.episodic-memory', 'index.jsonl')
  fs.appendFileSync(globalIdx, JSON.stringify({
    id: legacyId, date: '2020-02-02', time: '120000', project, category: 'lesson', status: 'active',
    tags: ['promoted-lesson', 'promoted:deadbeef'], summary: 'Hand-authored promoted (no Sources)',
  }) + '\n')
  // Read the project field BEFORE migration
  const beforeText = fs.readFileSync(path.join(globalEpsDir, legacyId + '.md'), 'utf8')
  const beforeProjectMatch = beforeText.match(/^project: (.+)$/m)
  assert(beforeProjectMatch && beforeProjectMatch[1] === project, `pre-migration project must be ${project}, got ${beforeProjectMatch?.[1]}`)
  // Run --migrate; the dry-run output's `skipped` list must name this id
  // with reason `no-parseable-sources`.
  const result = parse(w.promote(['--migrate']))
  assert(Array.isArray(result.skipped), `expected skipped list, got ${JSON.stringify(result)}`)
  const sk = result.skipped.find(s => s.hash === legacyId)
  assert(sk, `expected ${legacyId} in skipped, got ${JSON.stringify(result.skipped)}`)
  assert(sk.reason === 'no-parseable-sources', `expected reason no-parseable-sources, got ${sk.reason}`)
  // Project field byte-identical after migration
  const afterText = fs.readFileSync(path.join(globalEpsDir, legacyId + '.md'), 'utf8')
  const afterProjectMatch = afterText.match(/^project: (.+)$/m)
  assert(afterProjectMatch && afterProjectMatch[1] === project, `post-migration project must be byte-identical (${project}), got ${afterProjectMatch?.[1]}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

t('testMigrationRunRecord', () => {
  const w = pair('migration-record')
  const { legacyId } = seedLegacyGlobal(w)
  // Also seed a hand-authored episode that will be skipped (state B)
  const handId = '20200303-120000-hand-no-sources'
  const globalEpsDir = path.join(w.home, '.episodic-memory', 'episodes')
  const handContent = `---
id: ${handId}
date: 2020-03-03
time: "120000"
project: hand
category: lesson
status: active
tags: [promoted-lesson, promoted:feedface]
summary: hand no sources
---
no sources here
`
  fs.writeFileSync(path.join(globalEpsDir, handId + '.md'), handContent)
  fs.appendFileSync(path.join(w.home, '.episodic-memory', 'index.jsonl'), JSON.stringify({
    id: handId, date: '2020-03-03', time: '120000', project: 'hand', category: 'lesson', status: 'active',
    tags: ['promoted-lesson', 'promoted:feedface'], summary: 'hand no sources',
  }) + '\n')
  const preview = parse(w.promote(['--migrate']))
  const migFp = preview.candidates.find(c => c.id === legacyId).fingerprint
  parse(w.promote(['--migrate', '--confirm', migFp]))
  // The run-record exists, mode='migrate', and its per-item list contains
  // BOTH a `migrated` entry AND a `migration-skip` entry for the hand
  // episode.
  const all = w.globalIndexAll()
  const runRow = all.find(r => r.record_type === 'promote-run')
  assert(runRow, `expected a promote-run record, got ${JSON.stringify(all)}`)
  const runText = fs.readFileSync(path.join(globalEpsDir, runRow.id + '.md'), 'utf8')
  // Body is the JSON payload after the frontmatter delimiter
  const bodyStart = runText.indexOf('\n---\n', runText.indexOf('---')) + 5
  const runBody = JSON.parse(runText.slice(bodyStart).trim())
  assert(runBody.mode === 'migrate', `expected mode=migrate, got ${runBody.mode}`)
  const migItem = runBody.items.find(i => i.original === legacyId)
  assert(migItem, `expected migrated item for ${legacyId}, got ${JSON.stringify(runBody.items)}`)
  assert(migItem.source === 'migrated', `expected source=migrated, got ${migItem.source}`)
  const skipItem = runBody.items.find(i => i.hash === handId)
  assert(skipItem, `expected migration-skip item for ${handId}, got ${JSON.stringify(runBody.items)}`)
  assert(skipItem.source === 'migration-skip', `expected source=migration-skip, got ${skipItem.source}`)
  assert(skipItem.reason === 'no-parseable-sources', `expected reason=no-parseable-sources, got ${skipItem.reason}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// State C (not-global, P1-B tightened): a promoted-lesson episode in a LOCAL
// store must appear in --migrate's `skipped` with reason `not-global` (the
// SPEC-mandated reason). The pre-final-fold test asserted non-membership in
// BOTH `candidates` AND `skipped` — that assertion was trivially satisfied
// by the upstream filter and did not exercise the state-C branch. The
// final-fold contract: the local row surfaces with `reason === 'not-global'`.
t('testMigrationNotGlobalExcluded', () => {
  const w = pair('not-global')
  const aDir = path.join(w.root, 'projA', '.episodic-memory')
  const epId = '20200404-120000-local-promoted'
  const epContent = `---
id: ${epId}
date: 2020-04-04
time: "120000"
project: projA
category: lesson
status: active
tags: [promoted-lesson, promoted:11111111]
summary: local promoted
---
no sources
`
  fs.writeFileSync(path.join(aDir, 'episodes', epId + '.md'), epContent)
  fs.appendFileSync(path.join(aDir, 'index.jsonl'), JSON.stringify({
    id: epId, date: '2020-04-04', time: '120000', project: 'projA', category: 'lesson', status: 'active',
    tags: ['promoted-lesson', 'promoted:11111111'], summary: 'local promoted',
  }) + '\n')
  const result = parse(w.promote(['--migrate']))
  const inCandidates = result.candidates?.some(c => c.id === epId)
  const sk = result.skipped?.find(s => s.hash === epId)
  assert(!inCandidates, `local promoted-lesson must not be in --migrate candidates: ${JSON.stringify(result.candidates)}`)
  assert(sk, `local promoted-lesson must surface in skipped with reason not-global: ${JSON.stringify(result.skipped)}`)
  assert(sk.reason === 'not-global', `expected reason not-global, got ${sk.reason}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// State D (superseded, P1-D negative control): unrelated superseded rows
// must NOT pollute `skipped`. Three unrelated rows in the GLOBAL index —
// (1) category context, status superseded; (2) category context, status
// active; (3) category lesson, status superseded (no tags). After running
// --migrate on a normal pair, none of these ids may appear in `skipped`
// (the predicate filter drops them silently because they fail the category
// lesson + legacy tags shape).
t('testMigrationUnrelatedSupersededExcluded', () => {
  const w = pair('unrelated-superseded')
  const globalEpsDir = path.join(w.home, '.episodic-memory', 'episodes')
  fs.mkdirSync(globalEpsDir, { recursive: true })
  const unrelated = [
    { id: '20210101-120000-context-superseded', category: 'context', status: 'superseded', tags: [] },
    { id: '20210101-120000-context-active',      category: 'context', status: 'active',      tags: [] },
    { id: '20210101-120000-lesson-superseded',   category: 'lesson',  status: 'superseded', tags: [] },
  ]
  for (const u of unrelated) {
    const text = `---\nid: ${u.id}\ndate: 2021-01-01\ntime: "120000"\nproject: unrelated\ncategory: ${u.category}\nstatus: ${u.status}\ntags: []\nsummary: unrelated\n---\nunrelated\n`
    fs.writeFileSync(path.join(globalEpsDir, u.id + '.md'), text)
    fs.appendFileSync(path.join(w.home, '.episodic-memory', 'index.jsonl'), JSON.stringify({
      id: u.id, date: '2021-01-01', time: '120000', project: 'unrelated', category: u.category, status: u.status, tags: u.tags, summary: 'unrelated',
    }) + '\n')
  }
  const result = parse(w.promote(['--migrate']))
  for (const u of unrelated) {
    const sk = result.skipped?.find(s => s.hash === u.id)
    assert(!sk, `unrelated row ${u.id} (${u.category}/${u.status}) must NOT pollute skipped: ${JSON.stringify(result.skipped)}`)
  }
  fs.rmSync(w.root, { recursive: true, force: true })
})

// State D strict (P1-D): a global promoted-lesson episode whose status is
// ANYTHING OTHER THAN 'active' must surface in `skipped` with reason
// `superseded`. The §12 contract says "status not active" — `expired` is
// also a valid status field that triggers the same chain-already-handled
// path. The final-fold implementation uses `row.status !== 'active'`, not
// a narrow `=== 'superseded'` check.
t('testMigrationNonActiveStatusExcluded', () => {
  const w = pair('non-active-status')
  const globalEpsDir = path.join(w.home, '.episodic-memory', 'episodes')
  fs.mkdirSync(globalEpsDir, { recursive: true })
  const expId = '20200606-120000-expired-promoted'
  const expContent = `---
id: ${expId}
date: 2020-06-06
time: "120000"
project: expired
category: lesson
status: expired
tags: [promoted-lesson, promoted:33333333]
summary: expired promoted
---
no sources
`
  fs.writeFileSync(path.join(globalEpsDir, expId + '.md'), expContent)
  fs.appendFileSync(path.join(w.home, '.episodic-memory', 'index.jsonl'), JSON.stringify({
    id: expId, date: '2020-06-06', time: '120000', project: 'expired', category: 'lesson', status: 'expired',
    tags: ['promoted-lesson', 'promoted:33333333'], summary: 'expired promoted',
  }) + '\n')
  const result = parse(w.promote(['--migrate']))
  const sk = result.skipped.find(s => s.hash === expId)
  assert(sk, `expected ${expId} in skipped, got ${JSON.stringify(result.skipped)}`)
  assert(sk.reason === 'superseded', `expected reason superseded (status not active), got ${sk.reason}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// State D (superseded): a global promoted-lesson episode with status
// 'superseded' must be excluded with reason `superseded`.
t('testMigrationSupersededExcluded', () => {
  const w = pair('superseded')
  const supId = '20200505-120000-superseded-promoted'
  const globalEpsDir = path.join(w.home, '.episodic-memory', 'episodes')
  fs.mkdirSync(globalEpsDir, { recursive: true })
  const supContent = `---
id: ${supId}
date: 2020-05-05
time: "120000"
project: sup
category: lesson
status: superseded
tags: [promoted-lesson, promoted:22222222]
summary: superseded promoted
---
no sources needed for superseded
`
  fs.writeFileSync(path.join(globalEpsDir, supId + '.md'), supContent)
  fs.appendFileSync(path.join(w.home, '.episodic-memory', 'index.jsonl'), JSON.stringify({
    id: supId, date: '2020-05-05', time: '120000', project: 'sup', category: 'lesson', status: 'superseded',
    tags: ['promoted-lesson', 'promoted:22222222'], summary: 'superseded promoted',
  }) + '\n')
  const result = parse(w.promote(['--migrate']))
  const sk = result.skipped.find(s => s.hash === supId)
  assert(sk, `expected ${supId} in skipped, got ${JSON.stringify(result.skipped)}`)
  assert(sk.reason === 'superseded', `expected reason superseded, got ${sk.reason}`)
  fs.rmSync(w.root, { recursive: true, force: true })
})

// ---- runner ----

async function main() {
  for (const { name, fn } of TESTS) {
    if (!onlyMatches(name)) continue
    try { await fn(); console.log(`ok ${name}`); pass++ }
    catch (e) { console.log(`FAIL ${name}: ${e.message}`); fail++ }
  }
  process.exit(fail ? 1 : 0)
}
await main()
