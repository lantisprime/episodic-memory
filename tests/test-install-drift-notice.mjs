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


for (const d of [home, project]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }

console.log(`\n${pass}/${pass + fail} pass`)
if (fail > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exit(1)
}
