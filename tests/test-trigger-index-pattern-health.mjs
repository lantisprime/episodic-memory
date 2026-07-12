#!/usr/bin/env node
/**
 * test-trigger-index-pattern-health.mjs - RFC-009 P3-S3 (REQ-11):
 * session_start.pattern_health computed behind --with-pattern-health,
 * carried forward verbatim on unflagged builds, local-store only.
 *
 * Negative control (step 3.16b / A.9): BREAK_TI_PH=1 omits the flag in the
 * with_flag_unhealthy fixture while the assertions still expect the field.
 * Every assertion reads real artifacts (trigger-index.json bytes, build JSON,
 * captured stderr) - never constants.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const BREAK = process.env.BREAK_TI_PH === '1'

let pass = 0, fail = 0
const failures = []
const assert = (c, n, d) => { if (c) pass++; else { fail++; failures.push(`${n}${d ? ' - ' + d : ''}`) } }

// FAKE_ROOT scripts copy: spawn_fail renames em-pattern-health.mjs away safely.
const FAKE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ti-ph-repo-')))
fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(FAKE_ROOT, 'scripts'), { recursive: true })
fs.cpSync(path.join(REPO_ROOT, 'schemas'), path.join(FAKE_ROOT, 'schemas'), { recursive: true })
fs.copyFileSync(path.join(REPO_ROOT, 'activation-classes.json'), path.join(FAKE_ROOT, 'activation-classes.json'))
fs.copyFileSync(path.join(REPO_ROOT, 'categories.json'), path.join(FAKE_ROOT, 'categories.json'))
const TI = path.join(FAKE_ROOT, 'scripts/em-trigger-index.mjs')
const PH = path.join(FAKE_ROOT, 'scripts/em-pattern-health.mjs')
const EM_STORE = path.join(FAKE_ROOT, 'scripts/em-store.mjs')
const EM_VIOLATION = path.join(FAKE_ROOT, 'scripts/em-violation.mjs')

const _tmpDirs = [FAKE_ROOT]
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

function scrubEnv(env) {
  delete env.CLAUDE_CONFIG_DIR; delete env.EM_ACTIVATION_CLASSES_PATH; delete env.BREAK_TI_PH
  return env
}
function mkFixture(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ti-ph-${label}-`)))
  _tmpDirs.push(base)
  const home = path.join(base, 'home')
  const proj = path.join(base, 'proj')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
  // em-pattern-health --hermetic FAILS CLOSED without a patterns registry
  // (candidates: <LOCAL_DIR>/patterns/_index.json then <PROJECT_ROOT>/patterns/_index.json).
  fs.mkdirSync(path.join(proj, 'patterns'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'patterns', '_index.json'),
    JSON.stringify({ patterns: [{ pattern_id: 'bp-001-implementation-workflow' }] }))
  return { base, home, proj }
}
function run(script, args, { proj, home }) {
  return spawnSync('node', [script, ...args],
    { cwd: proj, env: scrubEnv({ ...process.env, HOME: home, USERPROFILE: home }), encoding: 'utf8', timeout: 30000 })
}
function seedLesson(proj, home, label) {
  const r = run(EM_STORE, ['--project', 'proj', '--category', 'lesson', '--tags', 'test',
    '--summary', `seed ${label}`, '--body', 'body', '--scope', 'local'], { proj, home })
  if (r.status !== 0) throw new Error(`em-store failed: ${r.stdout}\n${r.stderr}`)
}
function seedViolations(proj, home, n) {
  for (let i = 0; i < n; i++) {
    const r = run(EM_VIOLATION, ['--pattern', 'bp-001-implementation-workflow',
      '--summary', `probe violation ${i}`, '--body', 'violation body',
      '--project', 'proj', '--scope', 'local'], { proj, home })
    if (r.status !== 0) throw new Error(`em-violation failed: ${r.stdout}\n${r.stderr}`)
  }
}
function build(proj, home, extra = []) {
  return run(TI, ['--scope', 'local', '--project', proj, ...extra], { proj, home })
}
function readTi(proj) {
  return JSON.parse(fs.readFileSync(path.join(proj, '.episodic-memory', 'trigger-index.json'), 'utf8'))
}
function phOf(proj) {
  const ss = readTi(proj).session_start
  return ss && typeof ss === 'object' ? ss.pattern_health : undefined
}

// 1. with_flag_unhealthy (carries the BREAK inversion)
{
  const { home, proj } = mkFixture('unhealthy')
  seedViolations(proj, home, 3)
  const r = build(proj, home, BREAK ? [] : ['--with-pattern-health'])
  assert(r.status === 0, 'with_flag_unhealthy: build exits 0', `status=${r.status} stderr=${r.stderr}`)
  const ph = phOf(proj)
  assert(!!ph && ph.verdict === 'needs-enforcement', 'with_flag_unhealthy: verdict needs-enforcement', JSON.stringify(ph))
  assert(!!ph && ph.unhealthy === 1 && Array.isArray(ph.pattern_ids) && ph.pattern_ids.includes('bp-001-implementation-workflow'),
    'with_flag_unhealthy: unhealthy pattern count + id populated', JSON.stringify(ph))
  assert(!!ph && ph.schema_version === 1 && typeof ph.computed_at === 'string',
    'with_flag_unhealthy: schema_version 1 + computed_at present', JSON.stringify(ph))
}
// 2. with_flag_healthy: zero violations
{
  const { home, proj } = mkFixture('healthy')
  seedLesson(proj, home, 'healthy')
  const r = build(proj, home, ['--with-pattern-health'])
  const ph = phOf(proj)
  assert(r.status === 0 && !!ph && ph.verdict === 'healthy' && ph.unhealthy === 0 && Array.isArray(ph.pattern_ids) && ph.pattern_ids.length === 0,
    'with_flag_healthy: verdict healthy, unhealthy 0, ids empty', JSON.stringify(ph))
}
// 3. recompute_on_valid_cache (EC9): enforcement change invisible to the fingerprint
{
  const { home, proj } = mkFixture('revalid')
  seedViolations(proj, home, 3)
  const r1 = build(proj, home, ['--with-pattern-health'])
  assert(r1.status === 0 && phOf(proj).verdict === 'needs-enforcement', 'recompute_on_valid_cache: baseline needs-enforcement', JSON.stringify(phOf(proj)))
  fs.mkdirSync(path.join(proj, '.claude', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(proj, '.claude', 'hooks', 'guard.sh'), 'echo bp-001-implementation-workflow gate active\n')
  const r2 = build(proj, home, ['--with-pattern-health'])
  const j2 = JSON.parse(r2.stdout.trim().split('\n').pop())
  assert(r2.status === 0 && j2.built[0].cache_hit === true, 'recompute_on_valid_cache: fingerprint-valid cache hit', r2.stdout)
  assert(phOf(proj).verdict === 'needs-attention', 'recompute_on_valid_cache: verdict recomputed on the hit path', JSON.stringify(phOf(proj)))
}
// 4. carry_forward: unflagged rebuild carries the field verbatim
{
  const { home, proj } = mkFixture('carry')
  seedViolations(proj, home, 3)
  build(proj, home, ['--with-pattern-health'])
  const before = JSON.stringify(phOf(proj))
  seedLesson(proj, home, 'dirty index.jsonl')
  const r = build(proj, home)
  assert(r.status === 0 && JSON.stringify(phOf(proj)) === before,
    'carry_forward: field deep-equal incl. computed_at across an unflagged rebuild', `${before} vs ${JSON.stringify(phOf(proj))}`)
}
// 5. local_only: global-scope flagged build never attaches the field
{
  const { home, proj } = mkFixture('localonly')
  seedLesson(proj, home, 'global probe')
  const r = run(TI, ['--scope', 'global', '--with-pattern-health'], { proj, home })
  assert(r.status === 0, 'local_only: global build exits 0', r.stderr)
  const gti = JSON.parse(fs.readFileSync(path.join(home, '.episodic-memory', 'trigger-index.json'), 'utf8'))
  assert(!gti.session_start || gti.session_start.pattern_health === undefined,
    'local_only: no pattern_health in the global artifact', JSON.stringify(gti.session_start))
}
// 6. first_build: unflagged, no prior artifact -> absent, silent
{
  const { home, proj } = mkFixture('first')
  seedLesson(proj, home, 'first')
  const r = build(proj, home)
  assert(r.status === 0 && phOf(proj) === undefined, 'first_build: field absent', JSON.stringify(phOf(proj)))
  assert(!/carry-forward unavailable/.test(r.stderr), 'first_build: ENOENT is silent (no stderr note)', r.stderr)
}
// 7. corrupt_rebuild: prior field lost + one stderr note
{
  const { home, proj } = mkFixture('corrupt')
  seedViolations(proj, home, 3)
  build(proj, home, ['--with-pattern-health'])
  fs.writeFileSync(path.join(proj, '.episodic-memory', 'trigger-index.json'), 'garbage{{{')
  const r = build(proj, home)
  assert(r.status === 0 && phOf(proj) === undefined, 'corrupt_rebuild: field lost on corrupt prior', JSON.stringify(phOf(proj)))
  assert(/pattern_health carry-forward unavailable/.test(r.stderr), 'corrupt_rebuild: one stderr note', r.stderr)
}
// 8. spawn_fail: em-pattern-health missing -> flagged build ok, field absent, note
{
  const { home, proj } = mkFixture('spawnfail')
  seedLesson(proj, home, 'spawnfail')
  fs.renameSync(PH, PH + '.away')
  try {
    const r = build(proj, home, ['--with-pattern-health'])
    assert(r.status === 0, 'spawn_fail: build exits 0', r.stderr)
    assert(phOf(proj) === undefined, 'spawn_fail: field absent (never fabricated)', JSON.stringify(phOf(proj)))
    assert(/pattern_health unavailable/.test(r.stderr), 'spawn_fail: stderr note present', r.stderr)
  } finally { fs.renameSync(PH + '.away', PH) }
}
// 9. schema: exact key set + enum membership
{
  const { home, proj } = mkFixture('schema')
  seedViolations(proj, home, 3)
  build(proj, home, ['--with-pattern-health'])
  const ph = phOf(proj)
  assert(!!ph && JSON.stringify(Object.keys(ph).sort()) === JSON.stringify(['computed_at', 'pattern_ids', 'schema_version', 'unhealthy', 'verdict']),
    'schema: exact field set', JSON.stringify(Object.keys(ph || {})))
  assert(!!ph && ['healthy', 'needs-attention', 'needs-enforcement'].includes(ph.verdict), 'schema: verdict in enum', ph && ph.verdict)
}
// 10. merged_thread: --merged threads LOCAL field; global-only field never surfaces
{
  const { home, proj } = mkFixture('merged')
  seedViolations(proj, home, 3)
  build(proj, home, ['--with-pattern-health'])
  const r = run(TI, ['--merged', '--project', proj], { proj, home })
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  assert(r.status === 0 && j.session_start && j.session_start.pattern_health && j.session_start.pattern_health.verdict === 'needs-enforcement',
    'merged_thread: --merged carries the LOCAL field', JSON.stringify(j.session_start && j.session_start.pattern_health))
  const g = mkFixture('mergedglobal')
  seedLesson(g.proj, g.home, 'merged global')
  build(g.proj, g.home)
  run(TI, ['--scope', 'global'], { proj: g.proj, home: g.home })
  const gPath = path.join(g.home, '.episodic-memory', 'trigger-index.json')
  const gti = JSON.parse(fs.readFileSync(gPath, 'utf8'))
  gti.session_start = gti.session_start && typeof gti.session_start === 'object' ? gti.session_start : {}
  gti.session_start.pattern_health = { schema_version: 1, verdict: 'needs-enforcement', unhealthy: 9, pattern_ids: ['bp-001-implementation-workflow'], computed_at: '2026-07-11T00:00:00.000Z' }
  fs.writeFileSync(gPath, JSON.stringify(gti, null, 2))
  const r2 = run(TI, ['--merged', '--project', g.proj], { proj: g.proj, home: g.home })
  const j2 = JSON.parse(r2.stdout.trim().split('\n').pop())
  assert(r2.status === 0 && (!j2.session_start || j2.session_start.pattern_health === undefined),
    'merged_thread: global-only field never surfaces in the merged view', JSON.stringify(j2.session_start && j2.session_start.pattern_health))
}
// 11. cwd_binding: a flagged build spawned from a FOREIGN cwd (not the project) with
//     --project binds the pattern_health field + trigger-index to the TARGET store on disk,
//     ABSENT under the caller cwd; the hermetic health scan still resolves the project's
//     patterns registry (F6 / RFC-009 R2; axes: foreign cwd, wrong inherited subprocess cwd).
{
  const { home, proj } = mkFixture('cwdbind')
  seedViolations(proj, home, 3)
  const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ti-ph-foreign-')))
  _tmpDirs.push(foreign)
  const r = spawnSync('node', [TI, '--scope', 'local', '--project', proj, '--with-pattern-health'],
    { cwd: foreign, env: scrubEnv({ ...process.env, HOME: home, USERPROFILE: home }), encoding: 'utf8', timeout: 30000 })
  assert(r.status === 0, 'cwd_binding: foreign-cwd flagged build exits 0', `status=${r.status} stderr=${r.stderr}`)
  assert(fs.existsSync(path.join(proj, '.episodic-memory', 'trigger-index.json')),
    'cwd_binding: trigger-index lands under the target project store, not the caller cwd')
  assert(!fs.existsSync(path.join(foreign, '.episodic-memory')),
    'cwd_binding: no store created under the foreign caller cwd')
  const ph = phOf(proj)
  assert(ph && ph.verdict === 'needs-enforcement',
    'cwd_binding: pattern_health computed against the target project (hermetic scan bound to project root)', JSON.stringify(ph))
}

console.log(`test-trigger-index-pattern-health: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map(f => `FAIL ${f}`).join('\n')); process.exit(1) }
