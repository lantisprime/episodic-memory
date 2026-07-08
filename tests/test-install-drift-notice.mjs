#!/usr/bin/env node
/**
 * test-install-drift-notice.mjs — Layer 1 deliverables 4 + 5: the SessionStart
 * version-drift notice in em-recall-sessionstart.sh and the opt-in
 * (auto_update:true) dist-cache auto-update behind it.
 *
 * TESTING DISCIPLINE: isolated fake HOME + REAL install.mjs; the hook under
 * test is the DEPLOYED per-project copy (<proj>/.claude/hooks/), driven the way
 * Claude Code drives it (JSON on stdin). Both polarities per behavior:
 *   drift → ONE notice line;                       current → silent
 *   missing manifest (either side) → silent, exit 0
 *   auto_update:true + drift → unmodified files refreshed from the dist cache,
 *     manifest+registry updated;                   modified file → untouched
 *     and reported in the one-line output
 *   auto_update:false + drift → notice only, disk unchanged (checksum sweep)
 *   missing dist cache / unregistered project → plain-notice fallback, exit 0
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = path.join(REPO, 'install.mjs')
const GIT_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function truthy(name, v, detail) { if (v) ok(name); else bad(name, detail || 'expected truthy') }

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l1n-home-')))
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l1n-proj-')))
execFileSync('git', ['init', '-q'], { cwd: project })

const projManifest = path.join(project, '.episodic-memory-install.json')
const globalManifest = path.join(home, '.episodic-memory', 'install-manifest.json')
const enforceConfig = path.join(project, '.episodic-memory', 'enforce-config.json')
const HOOK = path.join(project, '.claude', 'hooks', 'em-recall-sessionstart.sh')
const SKILL_REL = '.claude/skills/episodic-memory/SKILL.md'
const GATE_REL = '.claude/hooks/checkpoint-gate.sh'

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }
function runHook() {
  return spawnSync('bash', [HOOK], {
    cwd: project,
    encoding: 'utf8',
    input: JSON.stringify({ cwd: project }),
    env: { ...process.env, HOME: home },
  })
}
function driftLines(stdout) {
  return (stdout || '').split('\n').filter((l) => l.startsWith('episodic-memory: project artifacts at'))
}
function autoUpdateLines(stdout) {
  return (stdout || '').split('\n').filter((l) => l.startsWith('episodic-memory: auto-updated'))
}
// Make the project look like an older install: SKILL.md carries old bytes,
// its manifest sha matches those old bytes (UNMODIFIED since that install),
// and the manifest version label is behind the global one.
function makeDrift() {
  const m = readJson(projManifest)
  const oldSkill = Buffer.from('OLD SKILL (from a previous version)\n')
  fs.writeFileSync(path.join(project, SKILL_REL), oldSkill)
  m.artifacts.find((a) => a.path === SKILL_REL).sha256 = sha256(oldSkill)
  m.source_version = '1'.repeat(40)
  fs.writeFileSync(projManifest, JSON.stringify(m, null, 2))
  return oldSkill
}
function setAutoUpdate(v) {
  const cfg = readJson(enforceConfig)
  if (v === null) delete cfg.auto_update
  else cfg.auto_update = v
  fs.writeFileSync(enforceConfig, JSON.stringify(cfg, null, 2))
}
function snapshotTree(root) {
  const out = new Map()
  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(abs, r)
      else if (e.isFile()) out.set(r, sha256(fs.readFileSync(abs)))
    }
  }
  walk(root, '')
  return out
}
function snapshotsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

// ===========================================================================
console.log('=== setup: real install (enforcement) into isolated HOME ===')
// ===========================================================================
{
  const r = spawnSync('node', [INSTALL, '--tool', 'claude-code', '--project', project, '--install-enforcement'],
    { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home } })
  truthy('setup: install exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-300)}`)
  truthy('setup: deployed SessionStart hook present', fs.existsSync(HOOK), HOOK)
  truthy('setup: dist cache deployed', fs.existsSync(path.join(home, '.episodic-memory', 'dist', GIT_HEAD)), 'dist missing')
}

// ===========================================================================
console.log('=== N1/N2/N3: drift notice — current→silent, drift→one line, missing manifests→silent ===')
// ===========================================================================
{
  const r0 = runHook()
  truthy('N1: current versions → exit 0, no drift line', r0.status === 0 && driftLines(r0.stdout).length === 0,
    `status=${r0.status} out=${(r0.stdout || '').slice(0, 200)}`)

  makeDrift()
  const r1 = runHook()
  const lines = driftLines(r1.stdout)
  truthy('N2: drift → exactly ONE notice line, exit 0', r1.status === 0 && lines.length === 1,
    `status=${r1.status} lines=${JSON.stringify(lines)}`)
  truthy('N2: notice carries both short shas + the update command',
    lines.length === 1 && lines[0].includes('111111111111') && lines[0].includes(GIT_HEAD.slice(0, 12)) &&
    lines[0].includes('install.mjs --update-consumers'), lines[0] || '(none)')
  truthy('N2: notice-only mode did not rewrite the project manifest',
    readJson(projManifest).source_version === '1'.repeat(40), 'manifest changed')

  const saved = fs.readFileSync(projManifest)
  fs.rmSync(projManifest)
  const r2 = runHook()
  truthy('N3: missing PROJECT manifest → silent, exit 0', r2.status === 0 && driftLines(r2.stdout).length === 0,
    `status=${r2.status} out=${(r2.stdout || '').slice(0, 200)}`)
  fs.writeFileSync(projManifest, saved)

  const savedG = fs.readFileSync(globalManifest)
  fs.rmSync(globalManifest)
  const r3 = runHook()
  truthy('N3: missing GLOBAL manifest → silent, exit 0', r3.status === 0 && driftLines(r3.stdout).length === 0,
    `status=${r3.status} out=${(r3.stdout || '').slice(0, 200)}`)
  fs.writeFileSync(globalManifest, savedG)
}

// ===========================================================================
console.log('=== A1: auto_update:true + drift → refreshed from dist cache ===')
// ===========================================================================
{
  setAutoUpdate(true)
  // drift is still in place from N-block (manifest restored above)
  const r = runHook()
  const lines = autoUpdateLines(r.stdout)
  truthy('A1: exit 0 with ONE auto-update line', r.status === 0 && lines.length === 1,
    `status=${r.status} lines=${JSON.stringify(lines)}`)
  truthy('A1: line reports 1 artifact at the new short sha',
    lines.length === 1 && lines[0].includes('auto-updated 1 artifact(s)') && lines[0].includes(GIT_HEAD.slice(0, 12)),
    lines[0] || '(none)')
  truthy('A1: skill refreshed to current repo bytes (checksum)',
    fs.readFileSync(path.join(project, SKILL_REL)).equals(fs.readFileSync(path.join(REPO, 'instructions', 'SKILL.md'))),
    'bytes differ')
  const m = readJson(projManifest)
  truthy('A1: project manifest bumped to the global version with the refreshed sha',
    m.source_version === GIT_HEAD &&
    m.artifacts.find((a) => a.path === SKILL_REL).sha256 === sha256(fs.readFileSync(path.join(REPO, 'instructions', 'SKILL.md'))),
    JSON.stringify({ v: m.source_version }))
  const reg = readJson(path.join(home, '.episodic-memory', 'installs.json'))
  truthy('A1: registry entry version updated', reg.entries.find((e) => e.tool === 'claude-code').version === GIT_HEAD,
    JSON.stringify(reg.entries))
  const r2 = runHook()
  truthy('A1: second run is silent (current)', r2.status === 0 &&
    driftLines(r2.stdout).length === 0 && autoUpdateLines(r2.stdout).length === 0,
    (r2.stdout || '').slice(0, 200))
}

// ===========================================================================
console.log('=== A2: auto_update:true + drift + one MODIFIED file → refreshed others, modified untouched + reported ===')
// ===========================================================================
{
  makeDrift()
  fs.appendFileSync(path.join(project, GATE_REL), '\n# operator tweak\n')
  const r = runHook()
  const lines = autoUpdateLines(r.stdout)
  truthy('A2: one auto-update line reporting the untouched modified file',
    r.status === 0 && lines.length === 1 && lines[0].includes('left untouched') && lines[0].includes(GATE_REL),
    JSON.stringify(lines))
  truthy('A2: modified checkpoint-gate.sh untouched',
    fs.readFileSync(path.join(project, GATE_REL), 'utf8').endsWith('# operator tweak\n'), 'operator tweak lost')
  truthy('A2: unmodified skill still refreshed',
    fs.readFileSync(path.join(project, SKILL_REL)).equals(fs.readFileSync(path.join(REPO, 'instructions', 'SKILL.md'))),
    'bytes differ')
  truthy('A2: manifest version bumped; modified entry keeps its old sha (stays flagged)',
    readJson(projManifest).source_version === GIT_HEAD &&
    readJson(projManifest).artifacts.find((a) => a.path === GATE_REL).sha256 !==
      sha256(fs.readFileSync(path.join(project, GATE_REL))),
    'unexpected manifest state')
}

// ===========================================================================
console.log('=== A3: auto_update:false + drift → notice only, disk unchanged ===')
// ===========================================================================
{
  setAutoUpdate(false)
  makeDrift()
  const pre = snapshotTree(project)
  const r = runHook()
  truthy('A3: plain drift notice, no auto-update line',
    r.status === 0 && driftLines(r.stdout).length === 1 && autoUpdateLines(r.stdout).length === 0,
    (r.stdout || '').slice(0, 300))
  truthy('A3: disk unchanged (checksum sweep)', snapshotsEqual(pre, snapshotTree(project)), 'tree changed')
}

// ===========================================================================
console.log('=== A4: auto_update:true + missing dist cache → plain-notice fallback, exit 0 ===')
// ===========================================================================
{
  setAutoUpdate(true)
  // drift still in place from A3
  fs.rmSync(path.join(home, '.episodic-memory', 'dist'), { recursive: true, force: true })
  const pre = snapshotTree(project)
  const r = runHook()
  truthy('A4: falls back to the plain drift notice, exit 0',
    r.status === 0 && driftLines(r.stdout).length === 1 && autoUpdateLines(r.stdout).length === 0,
    `status=${r.status} out=${(r.stdout || '').slice(0, 300)}`)
  truthy('A4: disk unchanged', snapshotsEqual(pre, snapshotTree(project)), 'tree changed')
}

// ===========================================================================
console.log('=== A5: auto_update:true + UNREGISTERED project → plain-notice fallback (consent) ===')
// ===========================================================================
{
  // Restore the dist cache by re-recording global state, then de-register.
  const r0 = spawnSync('node', [INSTALL, '--tool', 'claude-code', '--project', project, '--install-enforcement'],
    { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home } })
  truthy('A5: re-install exits 0', r0.status === 0, `status=${r0.status}`)
  makeDrift()
  fs.writeFileSync(path.join(home, '.episodic-memory', 'installs.json'),
    JSON.stringify({ schema_version: 1, entries: [] }, null, 2))
  const pre = snapshotTree(project)
  const r = runHook()
  truthy('A5: unregistered → plain notice fallback, exit 0',
    r.status === 0 && driftLines(r.stdout).length === 1 && autoUpdateLines(r.stdout).length === 0,
    `status=${r.status} out=${(r.stdout || '').slice(0, 300)}`)
  truthy('A5: disk unchanged (never touch unregistered projects)', snapshotsEqual(pre, snapshotTree(project)), 'tree changed')
}

for (const d of [home, project]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }

console.log(`\n${pass}/${pass + fail} pass`)
if (fail > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exit(1)
}
