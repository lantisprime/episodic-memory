#!/usr/bin/env node
// test-pattern-health-hermetic.mjs — RFC-009 P0 R5a acceptance (plan §14 group R5).
// Drives the REAL script against isolated fixture stores with controlled HOME.
// Fixture layout: PROJ (a git repo, NOT under either home), homeA (populated:
// ALL THREE $HOME read sites planted), homeB (empty). Recent violation dates keep
// rows inside the default 30-day window.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCRIPT = path.join(REPO, 'scripts', 'em-pattern-health.mjs')
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'em-p0-hermetic-'))
const PROJ = path.join(ROOT, 'proj')
const HOME_POP = path.join(ROOT, 'homeA')
const HOME_EMPTY = path.join(ROOT, 'homeB')
const RECENT = new Date().toISOString().slice(0, 10)

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
}
function writeLines(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}
function vio(id, pattern, date) {
  return { id, date, time: '00:00', project: 'fx', category: 'violation', status: 'active', supersedes: null, tags: [`violated:${pattern}`], summary: `fixture ${id}`, access_count: 0, last_accessed: null }
}

// --- fixture build ---
fs.mkdirSync(HOME_EMPTY, { recursive: true })
fs.mkdirSync(PROJ, { recursive: true })
spawnSync('git', ['init', '-q'], { cwd: PROJ })
fs.mkdirSync(path.join(PROJ, 'sub'), { recursive: true })
writeJson(path.join(PROJ, 'patterns', '_index.json'), { patterns: [{ pattern_id: 'tst-001' }, { pattern_id: 'tst-002' }] })
writeLines(path.join(PROJ, '.episodic-memory', 'index.jsonl'), [
  vio('20260701-000001-local-a', 'tst-001', RECENT),
  vio('20260701-000002-local-b', 'tst-002', RECENT),
  vio('20260701-000003-local-c', 'tst-002', RECENT),
  vio('20260701-000004-local-d', 'tst-002', RECENT),
])
// populated HOME: all three $HOME read sites (planner F4 — single-site is vacuous)
fs.mkdirSync(path.join(HOME_POP, '.claude', 'hooks'), { recursive: true })
fs.writeFileSync(path.join(HOME_POP, '.claude', 'hooks', 'enforce.sh'), '#!/bin/bash\nnode check tst-001 --gate\n')
writeLines(path.join(HOME_POP, '.episodic-memory', 'index.jsonl'), [
  vio('20260701-000005-glob-a', 'tst-001', RECENT),
  vio('20260701-000006-glob-b', 'tst-001', RECENT),
])
writeJson(path.join(HOME_POP, '.episodic-memory', 'patterns', '_index.json'), { patterns: [{ pattern_id: 'zzz-999' }] })

function run(args, home, cwd = PROJ) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
}
function row(res, id) {
  return JSON.parse(res.stdout).patterns.find(p => p.pattern_id === id)
}

const tests = []
const t = (name, fn) => tests.push([name, fn])
function assert(cond, msg) { if (!cond) throw new Error(msg) }

t('testHermeticHomeIsolation', () => {
  const a = run(['--hermetic'], HOME_POP)
  const b = run(['--hermetic'], HOME_EMPTY)
  assert(a.stdout === b.stdout, `hermetic stdout diverged:\nA=${a.stdout}\nB=${b.stdout}`)
  assert(a.status === b.status, `hermetic exit diverged: ${a.status} vs ${b.status}`)
  // divergence-without-flag leg: proves this fixture would catch a leak
  const c = run([], HOME_POP)
  const d = run([], HOME_EMPTY)
  assert(c.stdout !== d.stdout, 'no-flag runs did NOT diverge — fixture cannot discriminate, vacuous')
})

t('testHermeticScopeConflict', () => {
  for (const s of ['all', 'global']) {
    const r = run(['--hermetic', '--scope', s], HOME_EMPTY)
    assert(r.status === 1, `--scope ${s}: exit ${r.status}, want 1`)
    assert(r.stdout.includes('--hermetic is project-local only; omit --scope or pass --scope local'), `--scope ${s}: message missing: ${r.stdout}`)
  }
  const ok = run(['--hermetic', '--scope', 'local'], HOME_EMPTY)
  assert(ok.status === 0, `--scope local under hermetic: exit ${ok.status}, want 0`)
  const bad = run(['--hermetic', '--scope', 'bogus'], HOME_EMPTY)
  assert(bad.status === 1 && bad.stdout.includes('Invalid --scope'), `invalid-scope ordering: ${bad.stdout}`)
})

t('testHermeticDefaultsLocal', () => {
  const r = row(run(['--hermetic'], HOME_POP), 'tst-001')
  assert(r.violations === 1, `hermetic tst-001 violations ${r.violations}, want 1 (local only; global has 2 more)`)
})

t('testHermeticPatternsProjectOnly', () => {
  const out = JSON.parse(run(['--hermetic'], HOME_POP).stdout)
  assert(!out.patterns.some(p => p.pattern_id === 'zzz-999'), '$HOME-only pattern zzz-999 leaked into hermetic output')
  // subdir leg (EC10): PROJ is a git repo, so PROJECT_ROOT resolves from sub/ too
  const sub = run(['--hermetic'], HOME_EMPTY, path.join(PROJ, 'sub'))
  const root = run(['--hermetic'], HOME_EMPTY)
  assert(sub.stdout === root.stdout, `subdir cwd diverged from root cwd:\nSUB=${sub.stdout}\nROOT=${root.stdout}`)
  // LOCAL_DIR registry beats PROJECT_ROOT registry (candidate order)
  writeJson(path.join(PROJ, '.episodic-memory', 'patterns', '_index.json'), { patterns: [{ pattern_id: 'loc-111' }] })
  const loc = JSON.parse(run(['--hermetic'], HOME_EMPTY).stdout)
  fs.rmSync(path.join(PROJ, '.episodic-memory', 'patterns'), { recursive: true, force: true })
  assert(loc.patterns.length === 1 && loc.patterns[0].pattern_id === 'loc-111', `LOCAL_DIR registry did not win: ${JSON.stringify(loc.patterns)}`)
})

t('testHermeticEnforcementProjectOnly', () => {
  const before = row(run(['--hermetic'], HOME_POP), 'tst-001')
  assert(before.has_enforcement === false, 'populated-HOME hook detected under --hermetic ($HOME leak)')
  // MUTATES fixture: adds a project hook naming tst-001; later tests use tst-002 or non-hermetic runs
  fs.mkdirSync(path.join(PROJ, '.claude', 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(PROJ, '.claude', 'hooks', 'proj.sh'), '#!/bin/bash\nnode check tst-001 --gate\n')
  const after = row(run(['--hermetic'], HOME_POP), 'tst-001')
  assert(after.has_enforcement === true, 'project .claude/hooks hook NOT detected under --hermetic')
})

t('testHermeticCheckExit', () => {
  const bad = run(['--hermetic', '--check', '--pattern', 'tst-002'], HOME_EMPTY)
  assert(bad.status === 1, `3 violations, no enforcement: --check exit ${bad.status}, want 1`)
  const healthy = run(['--hermetic', '--check', '--pattern', 'tst-002', '--min-violations', '5'], HOME_EMPTY)
  assert(healthy.status === 0, `healthy fixture: --check exit ${healthy.status}, want 0`)
})

t('testHermeticHasEnforcementOverride', () => {
  const r = row(run(['--hermetic', '--has-enforcement', 'tst-002'], HOME_EMPTY), 'tst-002')
  assert(r.has_enforcement === true, 'argv --has-enforcement override ignored under --hermetic')
  assert(r.recommendation === 'needs-attention', `override recommendation ${r.recommendation}, want needs-attention`)
})

t('testNonHermeticUnchanged', () => {
  const r = row(run([], HOME_POP), 'tst-001')
  assert(r.has_enforcement === true, 'legacy path lost the $HOME/.claude/hooks scan')
  assert(r.violations === 3, `legacy scope-all tst-001 violations ${r.violations}, want 3 (1 local + 2 global)`)
})

let pass = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); pass++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
console.log(`${pass}/${tests.length} pass`)
process.exit(pass === tests.length ? 0 : 1)
