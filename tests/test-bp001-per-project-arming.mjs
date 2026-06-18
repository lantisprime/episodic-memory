#!/usr/bin/env node
/**
 * test-bp001-per-project-arming.mjs — Per-project scope for the bp-001
 * checkpoint-gate advisory engine (`shouldArmBp001Checkpoint`).
 *
 * Before: any bp-001 violation in any project armed .checkpoint-required in
 * EVERY project at SessionStart (cross-project bleed).
 * Planning-passive redesign (2026-05-25): em-recall NO LONGER arms a marker at
 * SessionStart. When `shouldArmBp001Checkpoint` is true it emits the
 * `__BP1_ADVISORY__` stderr signal instead (the pre-checkpoint requirement is
 * now lazily armed by checkpoint-gate.sh at the first repo-source write). The
 * per-project SCOPING this file guards is unchanged: the advisory fires only
 * when the current REPO_ROOT's resolved project matches the violation's
 * project. Each test asserts BOTH (a) em-recall writes NO marker (removed
 * arming) and (b) the advisory presence matches the scoping rule.
 *
 * Tests run em-recall.mjs as a subprocess with isolated HOME (fake global
 * episode store) and assert advisory emission + null marker side effect.
 *
 * Plan v3 cases A1-A9 (advisory-adapted).
 */

import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname)
// RFC-008 P3d: bp-001 advisory relocated em-recall.mjs → enforce-contract.mjs --session-start (F7/F38).
const ENFORCE = path.join(REPO_ROOT, 'scripts', 'enforce-contract.mjs')

let pass = 0, fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }

// ── Fixture builders ─────────────────────────────────────────────────────

function mkRepo(label, packageName) {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), `bp001-${label}-`))
  const d = fs.realpathSync(raw)
  execSync(`git init -q -b main "${d}"`)
  execSync(`git -C "${d}" config user.email t@t`)
  execSync(`git -C "${d}" config user.name t`)
  if (packageName) {
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: packageName }, null, 2))
  }
  fs.writeFileSync(path.join(d, 'README.md'), 'x\n')
  execSync(`git -C "${d}" add . `)
  execSync(`git -C "${d}" commit -q -m init`)
  fs.mkdirSync(path.join(d, '.checkpoints'), { recursive: true })
  return d
}

function mkFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp001-home-'))
  fs.mkdirSync(path.join(home, '.episodic-memory', 'episodes'), { recursive: true })
  // Empty global index — tests append entries as needed.
  fs.writeFileSync(path.join(home, '.episodic-memory', 'index.jsonl'), '')
  return home
}

function seedViolation(home, { project, date, status = 'active', daysAgo = null, tag = 'violated:bp-001-implementation-workflow' }) {
  const epDate = daysAgo !== null
    ? new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
    : (date || new Date().toISOString().slice(0, 10))
  const id = `${epDate.replace(/-/g, '')}-test-violation-${Math.random().toString(36).slice(2, 8)}`
  const entry = {
    id,
    date: epDate,
    time: '12:00',
    project,
    category: 'violation',
    status,
    tags: [tag, 'behavioral-pattern'],
    summary: `test bp-001 violation in ${project}`
  }
  fs.appendFileSync(path.join(home, '.episodic-memory', 'index.jsonl'),
    JSON.stringify(entry) + '\n')
  fs.writeFileSync(path.join(home, '.episodic-memory', 'episodes', `${id}.md`),
    `---\nid: ${id}\ndate: ${epDate}\ntime: "12:00"\nproject: ${project}\ncategory: violation\nstatus: ${status}\ntags: [${tag}, behavioral-pattern]\nsummary: test bp-001 violation in ${project}\n---\n\n# test\n`)
  return id
}

function runSessionStart(cwd, home, extraArgs = []) {
  const r = spawnSync('node', [ENFORCE, '--session-start', ...extraArgs], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home }
  })
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}

function markerExists(repoRoot) {
  const p = path.join(repoRoot, '.checkpoints', '.checkpoint-required')
  if (!fs.existsSync(p)) return false
  return fs.lstatSync(p).isFile()
}

// Planning-passive: the per-project gate is now observed via the advisory
// sentinel on stderr, not a marker write.
function advisoryEmitted(stderr) {
  return /__BP1_ADVISORY__/.test(stderr || '')
}

// ── Tests ────────────────────────────────────────────────────────────────

const TESTS = []
const test = (name, fn) => TESTS.push({ name, fn })

test('A1 cross-project: violation in project-A, SessionStart in project-B → NO advisory (THE FIX)', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a1-projA', 'project-a')
  const projB = mkRepo('a1-projB', 'project-b')
  seedViolation(home, { project: 'project-a' })
  const r = runSessionStart(projB, home)
  if (r.status !== 0) return bad('A1', `em-recall exited ${r.status}: ${r.stderr}`)
  if (advisoryEmitted(r.stderr)) return bad('A1', `project-b run must NOT emit bp-001 advisory`)
  if (markerExists(projB) || markerExists(projA)) return bad('A1', `em-recall must not arm any marker`)
  ok('A1')
})

test('A2 same-project: violation in project-A, SessionStart in project-A → advisory (no marker)', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a2-projA', 'project-a')
  seedViolation(home, { project: 'project-a' })
  const r = runSessionStart(projA, home)
  if (r.status !== 0) return bad('A2', `em-recall exited ${r.status}: ${r.stderr}`)
  if (!advisoryEmitted(r.stderr)) return bad('A2', `advisory should be emitted but was not`)
  if (markerExists(projA)) return bad('A2', `em-recall must not arm a marker (lazy-arm moved to gate)`)
  ok('A2')
})

test('A3 nested cwd: violation in project-A, SessionStart in project-A/sub → advisory (REPO_ROOT walks up)', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a3-projA', 'project-a')
  const sub = path.join(projA, 'sub')
  fs.mkdirSync(sub)
  seedViolation(home, { project: 'project-a' })
  const r = runSessionStart(sub, home)
  if (r.status !== 0) return bad('A3', `em-recall exited ${r.status}: ${r.stderr}`)
  if (!advisoryEmitted(r.stderr)) return bad('A3', `advisory should be emitted`)
  if (markerExists(projA) || markerExists(sub)) return bad('A3', `em-recall must not arm any marker`)
  ok('A3')
})

test('A5 --project override does NOT trick the arming: cwd=project-B + --project project-a → NOT armed', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a5-projA', 'project-a')
  const projB = mkRepo('a5-projB', 'project-b')
  seedViolation(home, { project: 'project-a' })
  const r = runSessionStart(projB, home, ['--project', 'project-a'])
  if (r.status !== 0) return bad('A5', `em-recall exited ${r.status}: ${r.stderr}`)
  if (advisoryEmitted(r.stderr)) return bad('A5', `--project override must NOT trigger advisory in project-b`)
  if (markerExists(projB) || markerExists(projA)) return bad('A5', `em-recall must not arm any marker`)
  ok('A5')
})

test('A6 out-of-cutoff: 60-day-old violation in project-A → NO advisory', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a6-projA', 'project-a')
  seedViolation(home, { project: 'project-a', daysAgo: 60 })
  const r = runSessionStart(projA, home)
  if (r.status !== 0) return bad('A6', `em-recall exited ${r.status}: ${r.stderr}`)
  if (advisoryEmitted(r.stderr)) return bad('A6', `60-day-old violation should not emit advisory`)
  if (markerExists(projA)) return bad('A6', `em-recall must not arm a marker`)
  ok('A6')
})

test('A7 multi-project: violations in A,B,C + SessionStart in A → advisory (only A counts)', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a7-projA', 'project-a')
  seedViolation(home, { project: 'project-a' })
  seedViolation(home, { project: 'project-b' })
  seedViolation(home, { project: 'project-c' })
  const r = runSessionStart(projA, home)
  if (r.status !== 0) return bad('A7', `em-recall exited ${r.status}: ${r.stderr}`)
  if (!advisoryEmitted(r.stderr)) return bad('A7', `A's own violation should emit advisory`)
  if (markerExists(projA)) return bad('A7', `em-recall must not arm a marker`)
  ok('A7')
})

test('A8 superseded: only-violation-for-A is status:superseded → NO advisory (explicit status filter)', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a8-projA', 'project-a')
  seedViolation(home, { project: 'project-a', status: 'superseded' })
  const r = runSessionStart(projA, home)
  if (r.status !== 0) return bad('A8', `em-recall exited ${r.status}: ${r.stderr}`)
  if (advisoryEmitted(r.stderr)) return bad('A8', `superseded violation must not emit advisory`)
  if (markerExists(projA)) return bad('A8', `em-recall must not arm a marker`)
  ok('A8')
})

test('A9 no violations anywhere: SessionStart in any project → NO advisory', () => {
  const home = mkFakeHome()
  const projA = mkRepo('a9-projA', 'project-a')
  const r = runSessionStart(projA, home)
  if (r.status !== 0) return bad('A9', `em-recall exited ${r.status}: ${r.stderr}`)
  if (advisoryEmitted(r.stderr)) return bad('A9', `clean store must not emit advisory`)
  if (markerExists(projA)) return bad('A9', `em-recall must not arm a marker`)
  ok('A9')
})

// ── Runner ───────────────────────────────────────────────────────────────

console.log('bp-001 per-project arming integration tests')
for (const t of TESTS) {
  try { t.fn() } catch (e) { bad(t.name, `threw: ${e.message}`) }
}
console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
