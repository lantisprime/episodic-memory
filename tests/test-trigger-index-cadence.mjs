#!/usr/bin/env node
/**
 * test-trigger-index-cadence.mjs - RFC-012 P1-S1 (R3a):
 * consolidation-cadence advisory reaches the activation plane.
 *
 * 24 named tests across five groups:
 *   1. computeCadence unit (isolated pure function),
 *   2. build stamp + schema (real em-trigger-index per store + merged),
 *   3. renderer (activation-match renderSessionStart),
 *   4. clerk parity + scope asymmetry (real em-consolidate --clerk),
 *   5. hook-path E2E (REAL deployed activation-sessionstart.sh runners).
 *
 * Every fixture uses an isolated temp HOME + project; global fixtures write to
 * $HOME/.episodic-memory. The hook tests copy the real committed hook bytes
 * into a temp repo-shaped tree so the runner's relative asset resolution finds
 * the current scripts/ + schemas/ without touching the developer's real store.
 *
 * Run: node tests/test-trigger-index-cadence.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { computeCadence, CADENCE_FIELDS } from '../scripts/lib/activation-log.mjs'
import { renderSessionStart } from '../scripts/lib/activation-match.mjs'
import { loadMergedTriggerIndex } from '../scripts/em-trigger-index.mjs'
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))

let pass = 0, fail = 0
const failures = []
const assert = (c, n, d) => { if (c) pass++; else { fail++; failures.push(`${n}${d ? ' — ' + d : ''}`) } }

// ---------------------------------------------------------------------------
// Fake-repo scaffold for spawned tools + hooks (built once per process).
// ---------------------------------------------------------------------------
const FAKE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-cadence-repo-')))
fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(FAKE_ROOT, 'scripts'), { recursive: true })
fs.cpSync(path.join(REPO_ROOT, 'schemas'), path.join(FAKE_ROOT, 'schemas'), { recursive: true })
fs.copyFileSync(path.join(REPO_ROOT, 'activation-classes.json'), path.join(FAKE_ROOT, 'activation-classes.json'))
fs.copyFileSync(path.join(REPO_ROOT, 'categories.json'), path.join(FAKE_ROOT, 'categories.json'))

// Claude Code session-start hook copy.
const REAL_CLAUDE_HOOKS_DIR = path.join(REPO_ROOT, 'plugins/claude-code-activation/hooks')
const FAKE_CLAUDE_HOOKS_DIR = path.join(FAKE_ROOT, 'plugins/claude-code-activation/hooks')
fs.mkdirSync(FAKE_CLAUDE_HOOKS_DIR, { recursive: true })
for (const f of ['activation-sessionstart.sh', 'activation-hook-run.mjs']) {
  const dst = path.join(FAKE_CLAUDE_HOOKS_DIR, f)
  fs.copyFileSync(path.join(REAL_CLAUDE_HOOKS_DIR, f), dst)
  fs.chmodSync(dst, 0o755)
}
const FAKE_CLAUDE_MANIFEST_PATH = path.join(FAKE_ROOT, 'plugins/claude-code-activation/manifest.json')

// Codex session-start hook copy — mirror the real installer's deployed file set
// (entry .sh + runner + vendored renderer/validator) so a stale vendored copy
// fails the E2E instead of silently falling through to the repo scripts/lib copy.
const REAL_CODEX_HOOKS_DIR = path.join(REPO_ROOT, 'plugins/codex-activation/hooks')
const FAKE_CODEX_HOOKS_DIR = path.join(FAKE_ROOT, 'plugins/codex-activation/hooks')
fs.mkdirSync(FAKE_CODEX_HOOKS_DIR, { recursive: true })
for (const f of ['activation-sessionstart.sh', 'activation-hook-run.mjs', 'activation-match.mjs', 'json-instance-validate.mjs']) {
  const dst = path.join(FAKE_CODEX_HOOKS_DIR, f)
  fs.copyFileSync(path.join(REAL_CODEX_HOOKS_DIR, f), dst)
  fs.chmodSync(dst, 0o755)
}
const FAKE_CODEX_MANIFEST_PATH = path.join(FAKE_ROOT, 'plugins/codex-activation/manifest.json')

const _tmpDirs = [FAKE_ROOT]
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

function scrubEnv(env) {
  delete env.CLAUDE_CONFIG_DIR
  delete env.EM_ACTIVATION_CLASSES_PATH
  return env
}
function mkFixture(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `em-cadence-${label}-`)))
  _tmpDirs.push(base)
  const home = path.join(base, 'home')
  const proj = path.join(base, 'proj')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
  return { base, home, proj }
}
function run(script, args, { cwd, home }) {
  return spawnSync('node', [script, ...args],
    { cwd, env: scrubEnv({ ...process.env, HOME: home, USERPROFILE: home }), encoding: 'utf8', timeout: 30000 })
}
function runShell(script, args, { cwd, home, input }) {
  return spawnSync('bash', [script, ...args],
    { cwd, env: scrubEnv({ ...process.env, HOME: home, USERPROFILE: home }), input, encoding: 'utf8', timeout: 15000 })
}

const EM_STORE_FAKE = path.join(FAKE_ROOT, 'scripts/em-store.mjs')
const EM_TRIGGER_FAKE = path.join(FAKE_ROOT, 'scripts/em-trigger-index.mjs')
const EM_CONSOLIDATE_FAKE = path.join(FAKE_ROOT, 'scripts/em-consolidate.mjs')

function storeLesson(proj, home, extra = []) {
  const r = run(EM_STORE_FAKE, ['--project', 'proj', '--category', 'lesson', '--tags', 'test',
    '--summary', 'l', '--body', 'b', '--scope', 'local', ...extra], { cwd: proj, home })
  if (r.status !== 0) throw new Error(`em-store failed: ${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}
function storeLessonGlobal(proj, home, extra = []) {
  const r = run(EM_STORE_FAKE, ['--project', 'proj', '--category', 'lesson', '--tags', 'test',
    '--summary', 'gl', '--body', 'b', '--scope', 'global', ...extra], { cwd: proj, home })
  if (r.status !== 0) throw new Error(`em-store global failed: ${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}
function storeDecision(proj, home, extra = []) {
  const r = run(EM_STORE_FAKE, ['--project', 'proj', '--category', 'decision', '--tags', 'test',
    '--summary', 'd', '--body', 'b', '--scope', 'local', ...extra], { cwd: proj, home })
  if (r.status !== 0) throw new Error(`em-store decision failed: ${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}
function buildLocal(proj, home) {
  return run(EM_TRIGGER_FAKE, ['--scope', 'local', '--project', proj], { cwd: proj, home })
}
function buildGlobal(proj, home) {
  return run(EM_TRIGGER_FAKE, ['--scope', 'global'], { cwd: proj, home })
}
function buildMerged(proj, home) {
  return run(EM_TRIGGER_FAKE, ['--merged', '--project', proj], { cwd: proj, home })
}
function readTi(proj) {
  return JSON.parse(fs.readFileSync(path.join(proj, '.episodic-memory', 'trigger-index.json'), 'utf8'))
}
function readGlobalTi(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.episodic-memory', 'trigger-index.json'), 'utf8'))
}
function runClerk(proj, home) {
  return run(EM_CONSOLIDATE_FAKE, ['--clerk', '--scope', 'local'], { cwd: proj, home })
}
function writeManifest({ proj, harness }) {
  const p = harness === 'codex' ? FAKE_CODEX_MANIFEST_PATH : FAKE_CLAUDE_MANIFEST_PATH
  fs.writeFileSync(p, JSON.stringify({
    type: 'activation', schema_version: '1.0.0', id: harness, harness, version: '1.0.0',
    blocking: false,
    capabilities: { user_prompt_submit: 'STRONG', pre_tool_use: 'STRONG', session_start: 'STRONG' },
    registrations: [],
    io_schema: 'schemas/runtime/activation-io.schema.json',
    runbook: { full: 'x', quickref: 'y' },
    project_identity: { slug: 'acme', root: proj },
  }))
}
function removeManifest() {
  fs.rmSync(FAKE_CLAUDE_MANIFEST_PATH, { force: true })
  fs.rmSync(FAKE_CODEX_MANIFEST_PATH, { force: true })
}
function runSessionStartHook({ home, harness }) {
  const dir = harness === 'codex' ? FAKE_CODEX_HOOKS_DIR : FAKE_CLAUDE_HOOKS_DIR
  const stdin = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: home })
  return runShell(path.join(dir, 'activation-sessionstart.sh'), [], { cwd: home, home, input: stdin })
}

const IDENTITY = { slug: 'acme', root: '/repo/acme', tool_id: 'claude-code' }
const BOUNDS = { max_matches: 3, max_tokens: 500 }

// ===========================================================================
// Group 1: computeCadence unit
// ===========================================================================

{
  const entries = [
    { trigger_kind: 'phrase', value: 'SENTINEL_k1' },
    { trigger_kind: 'phrase', value: 'SENTINEL_k1' },
    { trigger_kind: 'phrase', value: 'SENTINEL_k1' },
  ]
  const c = computeCadence(entries, [])
  assert(c.enabled === true && c.phrase_sharing === 3 && c.k_shared === 3 && c.n_lessons === 200,
    'testKFire: gauge values at exact K', JSON.stringify(c))
  assert(c.line === 'cadence: 3 trigger-index entries share a phrase (>= 3); consider a clerk run',
    'testKFire: line string byte-identical', c.line)
}

{
  const entries = [
    { trigger_kind: 'phrase', value: 'SENTINEL_k1' },
    { trigger_kind: 'phrase', value: 'SENTINEL_k1' },
  ]
  const c = computeCadence(entries, [])
  assert(c.enabled === true && c.phrase_sharing === 2 && c.active_lessons === 0,
    'testKQuiet: gauge values below K', JSON.stringify(c))
  assert(!('line' in c), 'testKQuiet: no line key', JSON.stringify(c))
}

{
  const rows = []
  for (let i = 0; i < 200; i++) rows.push({ category: 'lesson', status: 'active', review_by: '2099-01-01' })
  const c = computeCadence([], rows)
  assert(c.enabled === true && c.active_lessons === 200 && c.phrase_sharing === 0,
    'testNFire: gauge values at exact N', JSON.stringify(c))
  assert(c.line === 'cadence: 200 active lessons (>= 200); consider a clerk run',
    'testNFire: line string byte-identical', c.line)
}

{
  const rows = []
  for (let i = 0; i < 199; i++) rows.push({ category: 'lesson', status: 'active', review_by: '2099-01-01' })
  const c = computeCadence([], rows)
  assert(c.enabled === true && c.active_lessons === 199,
    'testNQuiet: active_lessons just below N', JSON.stringify(c))
  assert(!('line' in c), 'testNQuiet: no line key', JSON.stringify(c))
}

{
  const entries = []
  for (let i = 0; i < 3; i++) entries.push({ trigger_kind: 'phrase', value: 'SENTINEL_k1' })
  const rows = []
  for (let i = 0; i < 250; i++) rows.push({ category: 'lesson', status: 'active', review_by: '2099-01-01' })
  const c = computeCadence(entries, rows)
  assert(c.line === 'cadence: 3 trigger-index entries share a phrase (>= 3); consider a clerk run',
    'testKPrecedenceOverN: K line wins when both fire', c.line)
}

{
  const rows = []
  for (let i = 0; i < 250; i++) rows.push({ category: 'decision', status: 'active' })
  rows.push({ category: 'lesson', status: 'active', review_by: '2099-01-01' })
  const c = computeCadence([], rows)
  assert(c.active_lessons === 1 && !('line' in c),
    'testLessonFilterCorrection: only category:lesson rows count toward N', JSON.stringify(c))
}

{
  const rows = []
  for (let i = 0; i < 199; i++) rows.push({ category: 'lesson', status: 'active', review_by: '2099-01-01' })
  rows.push({ category: 'lesson', status: 'active', review_by: '2000-01-01' })
  rows.push({ category: 'lesson', status: 'active', review_by: '2099-01-01' })
  const c = computeCadence([], rows)
  assert(c.active_lessons === 200 && c.line && c.line.includes('200 active lessons'),
    'testExpiredExcluded: expired lesson excluded from active_lessons', JSON.stringify(c))
}

{
  const entries = [
    null,
    { trigger_kind: 'phrase' }, // missing value
    { value: 'x' }, // missing trigger_kind
    { trigger_kind: 'phrase', value: 'SENTINEL_m1' },
  ]
  const rows = [
    null,
    {},
    { category: null, status: 'active' },
    { category: 'lesson', status: 'active', review_by: '2020-01-01' },
    { category: 'lesson', status: 'active', review_by: '2099-01-01' },
  ]
  let threw = false
  try { computeCadence(entries, rows) } catch { threw = true }
  assert(!threw, 'testMalformedRowsDegrade: malformed members never throw')
  const c = computeCadence(entries, rows)
  assert(c.enabled === true && c.active_lessons === 1 && c.phrase_sharing === 1,
    'testMalformedRowsDegrade: counts around malformed rows', JSON.stringify(c))
  assert(!('line' in c), 'testMalformedRowsDegrade: quiet', JSON.stringify(c))
}

// ===========================================================================
// Group 2: build stamp + schema
// ===========================================================================

{
  const { home, proj } = mkFixture('build-local-k')
  const phrase = 'SENTINEL_k1'
  for (let i = 0; i < 3; i++) storeLesson(proj, home, ['--trigger', phrase])
  const r = buildLocal(proj, home)
  assert(r.status === 0, 'testBuildStampsLocal: build exits 0', r.stderr)
  const ti = readTi(proj)
  const c = ti.session_start && ti.session_start.cadence
  assert(c && c.enabled === true && c.phrase_sharing === 3 && c.k_shared === 3 && c.n_lessons === 200,
    'testBuildStampsLocal: cadence shape stamped', JSON.stringify(c))
  assert(c.line === 'cadence: 3 trigger-index entries share a phrase (>= 3); consider a clerk run',
    'testBuildStampsLocal: line fires at exact K', c.line)
  assert(ti.schema_version === 4, 'testBuildStampsLocal: index is schema v4', ti.schema_version)
}

{
  const { home, proj } = mkFixture('build-global-k')
  const phrase = 'SENTINEL_g1'
  for (let i = 0; i < 3; i++) storeLessonGlobal(proj, home, ['--trigger', phrase])
  const r = buildGlobal(proj, home)
  assert(r.status === 0, 'testBuildStampsGlobal: build exits 0', r.stderr)
  const ti = readGlobalTi(home)
  const c = ti.session_start && ti.session_start.cadence
  assert(c && c.enabled === true && c.phrase_sharing === 3,
    'testBuildStampsGlobal: global cadence stamped', JSON.stringify(c))
  assert(c.line && c.line.includes('3 trigger-index entries share a phrase'),
    'testBuildStampsGlobal: line fires', c.line)
}

{
  const { home, proj } = mkFixture('v3-cache')
  storeLesson(proj, home, ['--trigger', 'SENTINEL_v3'])
  buildLocal(proj, home)
  const tiPath = path.join(proj, '.episodic-memory', 'trigger-index.json')
  const v3 = JSON.parse(fs.readFileSync(tiPath, 'utf8'))
  v3.schema_version = 3
  delete v3.session_start.cadence
  fs.writeFileSync(tiPath, JSON.stringify(v3, null, 2))
  const r = buildLocal(proj, home)
  assert(r.status === 0, 'testV3CacheRebuilds: build exits 0', r.stderr)
  const j3 = JSON.parse(r.stdout.trim().split('\n').pop())
  const built = j3 && j3.built && j3.built[0]
  assert(built && built.cache_hit === false, 'testV3CacheRebuilds: v3 cache is stale', r.stdout)
  const ti = readTi(proj)
  assert(ti.schema_version === 4, 'testV3CacheRebuilds: rebuilt to v4', ti.schema_version)
  assert(ti.session_start && ti.session_start.cadence,
    'testV3CacheRebuilds: cadence present after rebuild', JSON.stringify(ti.session_start))
}

{
  const { home, proj } = mkFixture('schema-v4')
  for (let i = 0; i < 3; i++) storeLesson(proj, home, ['--trigger', 'SENTINEL_s1'])
  buildLocal(proj, home)
  const ti = readTi(proj)
  const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'schemas/trigger-index.schema.json'), 'utf8'))
  const res = validateInstance(ti, SCHEMA)
  assert(res.valid, 'testSchemaV4ValidatesCadence: built index validates', JSON.stringify(res.errors).slice(0, 400))
}

{
  const { home, proj } = mkFixture('merged-local')
  const { home: gHome, proj: gProj } = mkFixture('merged-global')
  for (let i = 0; i < 3; i++) storeLesson(proj, home, ['--trigger', 'SENTINEL_m1'])
  storeLesson(gProj, gHome, ['--trigger', 'SENTINEL_mg'])
  buildLocal(proj, home)
  buildGlobal(proj, home) // writes to $HOME/.episodic-memory (same home)
  const r = buildMerged(proj, home)
  assert(r.status === 0, 'testMergedThreadsLocalCadence: merge exits 0', r.stderr)
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  const c = j.session_start && j.session_start.cadence
  assert(c && c.line && c.line.includes('3 trigger-index entries share a phrase'),
    'testMergedThreadsLocalCadence: merged view carries LOCAL cadence', JSON.stringify(c))
}

{
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/rfcs/RFC-009-lesson-activation.contract.json'), 'utf8'))
  contract.cadence_shape = { fields: ['enabled', 'phrase_sharing', 'active_lessons', 'k_shared', 'n_lessons'] } // drops 'line'
  const driftFile = path.join(os.tmpdir(), `em-cadence-drift-${process.pid}.json`)
  fs.writeFileSync(driftFile, JSON.stringify(contract))
  const r = run(path.join(REPO_ROOT, 'scripts/validate-rfc-009-contract-mirror.mjs'), ['--contract', driftFile], { cwd: REPO_ROOT, home: os.homedir() })
  assert(r.status !== 0, 'testCadenceShapeMirrorDrift: drifted contract exits non-zero', `status=${r.status}`)
  assert(r.stdout.includes('cadence-shape-fields'), 'testCadenceShapeMirrorDrift: error names cadence-shape-fields', r.stdout)
  fs.rmSync(driftFile, { force: true })
}

// ===========================================================================
// Group 3: renderer
// ===========================================================================

{
  const line = 'cadence: 3 trigger-index entries share a phrase (>= 3); consider a clerk run'
  const ss = { critical_entries: [], entries: [], preflight: {}, cadence: { enabled: true, phrase_sharing: 3, active_lessons: 0, k_shared: 3, n_lessons: 200, line } }
  const r = renderSessionStart(ss, IDENTITY, new Set(), BOUNDS)
  const hits = r.lines.filter((l) => l === line).length
  assert(hits === 1, 'testRenderCadenceLine: cadence line emitted exactly once', JSON.stringify(r.lines))
}

{
  const line = 'cadence: 3 trigger-index entries share a phrase (>= 3); consider a clerk run'
  const phLine = 'pattern-health: 1 unhealthy (bp-001) - run node scripts/em-pattern-health.mjs --hermetic'
  const ss = {
    critical_entries: [],
    entries: [],
    preflight: { implementation: { 'bp-001-implementation-workflow': 2 } },
    cadence: { enabled: true, phrase_sharing: 3, active_lessons: 0, k_shared: 3, n_lessons: 200, line },
    pattern_health: { schema_version: 1, verdict: 'needs-enforcement', unhealthy: 1, pattern_ids: ['bp-001'], computed_at: new Date().toISOString() },
  }
  const r = renderSessionStart(ss, IDENTITY, new Set(), BOUNDS)
  const preIdx = r.lines.findIndex((l) => l.startsWith('preflight:'))
  const cadIdx = r.lines.indexOf(line)
  const phIdx = r.lines.findIndex((l) => l.startsWith('pattern-health:'))
  assert(preIdx !== -1 && cadIdx !== -1 && phIdx !== -1,
    'testRenderOrderBeforePatternHealth: all three advisory lines present', JSON.stringify(r.lines))
  assert(preIdx < cadIdx && cadIdx < phIdx,
    'testRenderOrderBeforePatternHealth: order is preflight < cadence < pattern_health', JSON.stringify(r.lines))
}

{
  const bigId = '20260701-000000-critical-aaaa'
  const line = 'cadence: 3 trigger-index entries share a phrase (>= 3); consider a clerk run'
  const ss = {
    critical_entries: [{ episode_id: bigId, summary: 'X', category: 'lesson', effective_priority: 9, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] }],
    entries: [],
    preflight: {},
    cadence: { enabled: true, phrase_sharing: 3, active_lessons: 0, k_shared: 3, n_lessons: 200, line },
  }
  const r = renderSessionStart(ss, IDENTITY, new Set(), { max_matches: 3, max_tokens: 40 })
  assert(r.lines.some((l) => l.startsWith('READ ' + bigId)),
    'testEnvelopeTruncationOrder: tier1 line intact', JSON.stringify(r.lines))
  assert(!r.lines.includes(line), 'testEnvelopeTruncationOrder: cadence line dropped on tight budget', JSON.stringify(r.lines))
}

{
  const cases = [
    { critical_entries: [], entries: [], preflight: {} },
    { critical_entries: [], entries: [], preflight: {}, cadence: { enabled: false, line: 'x' } },
    { critical_entries: [], entries: [], preflight: {}, cadence: { enabled: true, line: 42 } },
  ]
  for (const ss of cases) {
    let threw = false
    try { renderSessionStart(ss, IDENTITY, new Set(), BOUNDS) } catch { threw = true }
    assert(!threw, 'testRenderAbsentCadenceNoCrash: renderer never throws on absent/invalid cadence')
    const r = renderSessionStart(ss, IDENTITY, new Set(), BOUNDS)
    assert(!r.lines.some((l) => l.startsWith('cadence:')), 'testRenderAbsentCadenceNoCrash: no cadence line', JSON.stringify(r.lines))
  }
}

// ===========================================================================
// Group 4: clerk parity + scope asymmetry
// ===========================================================================

{
  const { home, proj } = mkFixture('clerk-n-correction')
  for (let i = 0; i < 210; i++) storeDecision(proj, home)
  for (let i = 0; i < 3; i++) storeLesson(proj, home)
  buildLocal(proj, home)
  const r = runClerk(proj, home)
  assert(r.status === 0, 'testClerkAdvisoryCorrectedNGauge: clerk exits 0', r.stderr)
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  assert(j.advisory === undefined || j.advisory === null,
    'testClerkAdvisoryCorrectedNGauge: no N advisory when only 3 lessons active', JSON.stringify(j.advisory))
}

{
  const { home, proj } = mkFixture('clerk-parity')
  for (let i = 0; i < 3; i++) storeLesson(proj, home, ['--trigger', 'SENTINEL_p1'])
  buildLocal(proj, home)
  const ti = readTi(proj)
  const r = runClerk(proj, home)
  assert(r.status === 0, 'testClerkAdvisoryParity: clerk exits 0', r.stderr)
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  assert(j.advisory === ti.session_start.cadence.line,
    'testClerkAdvisoryParity: clerk advisory equals built cadence.line', `${j.advisory} vs ${ti.session_start.cadence.line}`)
}

{
  const { home, proj } = mkFixture('clerk-div')
  storeLesson(proj, home, ['--trigger', 'SENTINEL_div_local'])
  for (let i = 0; i < 3; i++) storeLessonGlobal(proj, home, ['--trigger', 'SENTINEL_div_global'])
  buildLocal(proj, home)
  buildGlobal(proj, home) // writes global index under the same $HOME
  const localTi = readTi(proj)
  assert(!localTi.session_start.cadence.line, 'testMergedDivergence: local stamp quiet', JSON.stringify(localTi.session_start.cadence))
  const r = runClerk(proj, home)
  assert(r.status === 0, 'testMergedDivergence: clerk exits 0', r.stderr)
  let j
  try {
    j = JSON.parse(r.stdout.trim().split('\n').pop())
  } catch (e) {
    throw new Error(`clerk stdout parse failed: ${e.message}\nstdout=${JSON.stringify(r.stdout)}\nstderr=${JSON.stringify(r.stderr)}`)
  }
  assert(j.advisory && j.advisory.includes('3 trigger-index entries share a phrase'),
    'testMergedDivergence: clerk advisory fires on merged phrase count', JSON.stringify(j.advisory))
}

// ===========================================================================
// Group 5: hook-path E2E
// ===========================================================================

{
  const { home, proj } = mkFixture('hook-claude')
  writeManifest({ proj, harness: 'claude-code' })
  for (let i = 0; i < 3; i++) storeLesson(proj, home, ['--trigger', 'SENTINEL_h1', '--applies-to-project', 'acme', '--applies-to-tool', 'claude-code'])
  buildLocal(proj, home)
  const beforeTi = readTi(proj)
  assert(beforeTi.session_start && beforeTi.session_start.cadence && beforeTi.session_start.cadence.phrase_sharing === 3,
    'testHookPathCadenceClaudeE2E: pre-hook trigger-index has cadence phrase 3', JSON.stringify(beforeTi.session_start))
  const r = runSessionStartHook({ home, harness: 'claude-code' })
  assert(r.status === 0, 'testHookPathCadenceClaudeE2E: hook exits 0', r.stderr)
  const out = r.stdout.trim()
  const localSs = readTi(proj).session_start
  let parsed
  try { parsed = JSON.parse(out) } catch (e) {
    throw new Error(`claude hook stdout parse failed: ${e.message}\nstdout=${JSON.stringify(out)}\nstderr=${JSON.stringify(r.stderr)}`)
  }
  const ctx = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext
  assert(typeof ctx === 'string' && ctx.includes('cadence: 3 trigger-index entries share a phrase'),
    'testHookPathCadenceClaudeE2E: additionalContext includes cadence count line', ctx)
  removeManifest()
}

{
  const { home, proj } = mkFixture('hook-codex')
  writeManifest({ proj, harness: 'codex' })
  for (let i = 0; i < 3; i++) storeLesson(proj, home, ['--trigger', 'SENTINEL_h1', '--applies-to-project', 'acme', '--applies-to-tool', 'codex'])
  buildLocal(proj, home)
  const beforeTi = readTi(proj)
  assert(beforeTi.session_start && beforeTi.session_start.cadence && beforeTi.session_start.cadence.phrase_sharing === 3,
    'testHookPathCadenceCodexE2E: pre-hook trigger-index has cadence phrase 3', JSON.stringify(beforeTi.session_start))
  const r = runSessionStartHook({ home, harness: 'codex' })
  assert(r.status === 0, 'testHookPathCadenceCodexE2E: hook exits 0', r.stderr)
  const out = r.stdout.trim()
  const localSs = readTi(proj).session_start
  let parsed
  try { parsed = JSON.parse(out) } catch (e) {
    throw new Error(`codex hook stdout parse failed: ${e.message}\nstdout=${JSON.stringify(out)}\nstderr=${JSON.stringify(r.stderr)}`)
  }
  const ctx = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext
  assert(typeof ctx === 'string' && ctx.includes('cadence: 3 trigger-index entries share a phrase'),
    'testHookPathCadenceCodexE2E: additionalContext includes cadence count line', ctx)
  removeManifest()
}

// ===========================================================================
// Summary
// ===========================================================================

console.log(`\n${pass}/${pass + fail} pass`)
if (fail > 0) {
  for (const f of failures) console.error(`FAIL  ${f}`)
  process.exit(1)
}
console.log('test-trigger-index-cadence: PASS')
