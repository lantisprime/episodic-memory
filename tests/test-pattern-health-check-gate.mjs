#!/usr/bin/env node
/**
 * test-pattern-health-check-gate.mjs - RFC-009 P3-S4 (REQ-10 / R5b): the CI
 * gate semantics of `em-pattern-health --hermetic --check`, red-then-green
 * against isolated fixtures OUTSIDE the checkout, driving the REAL script.
 *
 * Negative control (step 4.1b / A.9): BREAK_PH_GATE=1 seeds only 2 violations
 * in the red fixture while the assertions still expect exit 1.
 * The needs-enforcement -> needs-attention transition is asserted on the JSON
 * `recommendation` FIELD, never on exit code (needs-attention still exits 1 -
 * em-pattern-health.mjs:409-418, NSP F3).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const PH = path.join(REPO_ROOT, 'scripts/em-pattern-health.mjs')
const EM_VIOLATION = path.join(REPO_ROOT, 'scripts/em-violation.mjs')
const BREAK = process.env.BREAK_PH_GATE === '1'

let pass = 0, fail = 0
const failures = []
const assert = (c, n, d) => { if (c) pass++; else { fail++; failures.push(`${n}${d ? ' - ' + d : ''}`) } }

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

function scrubEnv(env) {
  delete env.CLAUDE_CONFIG_DIR; delete env.EM_ACTIVATION_CLASSES_PATH; delete env.BREAK_PH_GATE
  return env
}
function mkFixture(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ph-gate-${label}-`)))
  _tmpDirs.push(base)
  const home = path.join(base, 'home')
  const proj = path.join(base, 'proj')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
  fs.mkdirSync(path.join(proj, 'patterns'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'patterns', '_index.json'),
    JSON.stringify({ patterns: [{ pattern_id: 'bp-001-implementation-workflow' }] }))
  return { base, home, proj }
}
function seedViolations(proj, home, n) {
  for (let i = 0; i < n; i++) {
    const r = spawnSync('node', [EM_VIOLATION, '--pattern', 'bp-001-implementation-workflow',
      '--summary', `probe violation ${i}`, '--body', 'violation body',
      '--project', 'proj', '--scope', 'local'],
      { cwd: proj, env: scrubEnv({ ...process.env, HOME: home, USERPROFILE: home }), encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) throw new Error(`em-violation failed: ${r.stdout}\n${r.stderr}`)
  }
}
function runGate(proj, home) {
  return spawnSync('node', [PH, '--hermetic', '--check'],
    { cwd: proj, env: scrubEnv({ ...process.env, HOME: home, USERPROFILE: home }), encoding: 'utf8', timeout: 30000 })
}
function rowFor(stdout) {
  const doc = JSON.parse(stdout.trim().split('\n').pop())
  return (doc.patterns || []).find((p) => p.pattern_id === 'bp-001-implementation-workflow')
}

// 1. red: 3 recent violations, no enforcement -> exit 1 (carries the BREAK inversion)
{
  const { home, proj } = mkFixture('red')
  seedViolations(proj, home, BREAK ? 2 : 3)
  const r = runGate(proj, home)
  assert(r.status === 1, 'red: gate exits 1', `status=${r.status} stdout=${r.stdout}`)
  const row = rowFor(r.stdout)
  assert(!!row && row.recommendation === 'needs-enforcement' && row.violations === 3,
    'red: recommendation needs-enforcement with 3 counted violations', JSON.stringify(row))
}
// 2. green_threshold: 2 violations (below --min-violations default 3) -> exit 0
{
  const { home, proj } = mkFixture('green')
  seedViolations(proj, home, 2)
  const r = runGate(proj, home)
  assert(r.status === 0, 'green_threshold: gate exits 0', `status=${r.status}`)
  const row = rowFor(r.stdout)
  assert(!!row && row.recommendation === 'healthy', 'green_threshold: recommendation healthy', JSON.stringify(row))
}
// 3. recommendation_transition: enforcement present -> FIELD flips, exit stays 1 (NSP F3)
{
  const { home, proj } = mkFixture('transition')
  seedViolations(proj, home, 3)
  fs.mkdirSync(path.join(proj, '.claude', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(proj, '.claude', 'hooks', 'guard.sh'), 'echo bp-001-implementation-workflow gate active\n')
  const r = runGate(proj, home)
  const row = rowFor(r.stdout)
  assert(!!row && row.recommendation === 'needs-attention' && row.has_enforcement === true,
    'recommendation_transition: field flips to needs-attention with enforcement present', JSON.stringify(row))
  assert(r.status === 1, 'recommendation_transition: exit code STAYS 1 (still unhealthy)', `status=${r.status}`)
}
// 4. hermetic: home-dir enforcement hook must NOT leak into the verdict
{
  const { home, proj } = mkFixture('hermetic')
  seedViolations(proj, home, 3)
  const rEmpty = runGate(proj, home)
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'hooks', 'home-guard.sh'), 'echo bp-001-implementation-workflow home hook\n')
  const rPopulated = runGate(proj, home)
  assert(rEmpty.stdout === rPopulated.stdout && rEmpty.status === rPopulated.status,
    'hermetic: byte-identical output with empty vs populated $HOME', `${rEmpty.stdout}\n---\n${rPopulated.stdout}`)
}
// 5. cwd: the store binding is the spawn cwd (B-cwd2 - no --project flag exists)
{
  const { home, proj } = mkFixture('cwd-a')
  seedViolations(proj, home, 3)
  const other = mkFixture('cwd-b')
  const rA = runGate(proj, home)
  const rB = runGate(other.proj, home)
  assert(rA.status === 1 && rB.status === 0,
    'cwd: identical command, different cwd -> different store, different verdict', `A=${rA.status} B=${rB.status}`)
}

console.log(`test-pattern-health-check-gate: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map(f => `FAIL ${f}`).join('\n')); process.exit(1) }
