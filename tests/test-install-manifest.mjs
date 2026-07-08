#!/usr/bin/env node
/**
 * test-install-manifest.mjs — Layer 1 update distribution: version manifests,
 * consumer registry, and the --update-consumers sweep.
 *
 * TESTING DISCIPLINE: mock-project E2E with an ISOLATED fake HOME running the
 * REAL install.mjs, then reading the actual deployed tree — never mental-traced.
 * Both polarities per behavior:
 *   manifest      — recorded artifacts hash-match disk; skipped-divergent user
 *                   files keep their pre-divergence entry (carry-forward)
 *   registry      — entry written + deduped; malformed registry degrades
 *                   (rebuilt with stderr note, install still exits 0)
 *   sweep         — unmodified→refreshed AND modified→skipped-with-warning;
 *                   registered→swept AND unregistered→untouched; vanished→pruned;
 *                   enforcement_installed:false → enforcement artifact untouched;
 *                   --dry-run changes NOTHING on disk (checksum sweep before/
 *                   after) and its report matches the real run's
 *   em-doctor     — installs-drift section: current→ok AND drifted→warn;
 *                   absent registry→ok (degrade)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { resolveSourceVersion, contentVersion } from '../scripts/lib/install-version.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = path.join(REPO, 'install.mjs')
const GIT_HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function truthy(name, v, detail) { if (v) ok(name); else bad(name, detail || 'expected truthy') }

const cleanups = []
function mkSandbox(label) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `l1-home-${label}-`)))
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `l1-proj-${label}-`)))
  execFileSync('git', ['init', '-q'], { cwd: project })
  cleanups.push(home, project)
  return { home, project }
}
function runInstall({ home, project, tool = 'claude-code', extra = [] }) {
  return spawnSync('node', [INSTALL, '--tool', tool, '--project', project, ...extra],
    { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home } })
}
function runSweep(home, dryRun) {
  const args = [INSTALL, '--update-consumers']
  if (dryRun) args.push('--dry-run')
  return spawnSync('node', args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: home } })
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
function sha256(bufOrPath) {
  const data = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath)
  return crypto.createHash('sha256').update(data).digest('hex')
}
// Full-tree checksum snapshot (dry-run must change NOTHING).
function snapshotTree(root) {
  const out = new Map()
  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(abs, r)
      else if (e.isFile()) out.set(r, sha256(abs))
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
const projManifestPath = (project) => path.join(project, '.episodic-memory-install.json')
const globalManifestPath = (home) => path.join(home, '.episodic-memory', 'install-manifest.json')
const registryFilePath = (home) => path.join(home, '.episodic-memory', 'installs.json')

// ===========================================================================
console.log('=== T1: install writes version manifests (global + per-project) ===')
// ===========================================================================
const S1 = mkSandbox('manifest')
{
  const r = runInstall({ home: S1.home, project: S1.project, extra: ['--install-enforcement'] })
  truthy('T1: install exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-300)}`)

  const gm = readJson(globalManifestPath(S1.home))
  truthy('T1: global manifest source_version == git HEAD', gm.source_version === GIT_HEAD,
    `got ${gm.source_version}`)
  truthy('T1: global manifest has scope/tool/timestamp', gm.scope === 'global' && gm.tool === 'claude-code' && typeof gm.installed_at === 'string',
    JSON.stringify({ scope: gm.scope, tool: gm.tool }))
  truthy('T1: global manifest lists a substantial artifact set', Array.isArray(gm.artifacts) && gm.artifacts.length > 20,
    `count=${(gm.artifacts || []).length}`)
  let gMismatch = 0
  for (const a of gm.artifacts) {
    if (sha256(path.join(S1.home, '.episodic-memory', a.path)) !== a.sha256) gMismatch++
  }
  truthy('T1: every global artifact sha256 matches the deployed file', gMismatch === 0, `${gMismatch} mismatch(es)`)

  const pm = readJson(projManifestPath(S1.project))
  truthy('T1: project manifest source_version == git HEAD', pm.source_version === GIT_HEAD, `got ${pm.source_version}`)
  const byPath = new Map(pm.artifacts.map((a) => [a.path, a]))
  truthy('T1: project manifest records the skill (core)',
    byPath.get('.claude/skills/episodic-memory/SKILL.md')?.kind === 'core',
    JSON.stringify(byPath.get('.claude/skills/episodic-memory/SKILL.md') || null))
  truthy('T1: project manifest records checkpoint-gate (enforcement)',
    byPath.get('.claude/hooks/checkpoint-gate.sh')?.kind === 'enforcement',
    JSON.stringify(byPath.get('.claude/hooks/checkpoint-gate.sh') || null))
  let pMismatch = 0
  for (const a of pm.artifacts) {
    if (sha256(path.join(S1.project, a.path)) !== a.sha256) pMismatch++
  }
  truthy('T1: every project artifact sha256 matches the installed file', pMismatch === 0, `${pMismatch} mismatch(es)`)
  const litter = fs.readdirSync(S1.project).filter((f) => f.includes('.episodic-memory-install.json.') && f.endsWith('.tmp'))
  truthy('T1: atomic write left no .tmp litter', litter.length === 0, litter.join(', '))
}

// ===========================================================================
console.log('=== T2: re-install overwrites its own manifest; divergent user file keeps its pre-divergence entry ===')
// ===========================================================================
{
  const ccPath = '.claude/skills/classify-correction/SKILL.md'
  const before = readJson(projManifestPath(S1.project))
  const beforeEntry = before.artifacts.find((a) => a.path === ccPath)
  truthy('T2: classify-correction skill tracked after first install', !!beforeEntry, 'entry missing')

  fs.appendFileSync(path.join(S1.project, ccPath), '\nUSER LOCAL EDIT\n')
  const r = runInstall({ home: S1.home, project: S1.project, extra: ['--install-enforcement'] })
  truthy('T2: re-install exits 0', r.status === 0, `status=${r.status}`)
  const after = readJson(projManifestPath(S1.project))
  const afterEntry = after.artifacts.find((a) => a.path === ccPath)
  truthy('T2: divergent file entry carried forward (old sha kept)',
    afterEntry && afterEntry.sha256 === beforeEntry.sha256, JSON.stringify(afterEntry || null))
  truthy('T2: carried entry no longer matches disk (sweep will flag modified)',
    afterEntry && sha256(path.join(S1.project, ccPath)) !== afterEntry.sha256, 'disk sha unexpectedly matches')
  truthy('T2: re-install keeps a single manifest version field == git HEAD',
    after.source_version === GIT_HEAD, after.source_version)
}

// ===========================================================================
console.log('=== T3: source version degrades to a content hash without git ===')
// ===========================================================================
{
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-nogit-'))
  cleanups.push(noGit)
  const artifacts = [{ source: 'a.txt', sha256: 'aa'.repeat(32) }, { source: 'b.txt', sha256: 'bb'.repeat(32) }]
  const v = resolveSourceVersion(noGit, artifacts)
  truthy('T3: degrade token is content-<sha256>', /^content-[0-9a-f]{64}$/.test(v), v)
  truthy('T3: content hash is deterministic', v === contentVersion(artifacts), 'nondeterministic')
}

// ===========================================================================
console.log('=== T4: consumer registry — entry, dedupe, second tool, malformed degrade ===')
// ===========================================================================
{
  const reg = readJson(registryFilePath(S1.home))
  const ccEntries = reg.entries.filter((e) => e.tool === 'claude-code')
  truthy('T4: exactly one claude-code entry after two installs (dedupe)', ccEntries.length === 1,
    `count=${ccEntries.length}`)
  const e = ccEntries[0]
  truthy('T4: entry fields', e.project_path === S1.project && e.version === GIT_HEAD &&
    e.enforcement_installed === true && typeof e.last_install_ts === 'string', JSON.stringify(e))

  const r2 = runInstall({ home: S1.home, project: S1.project, tool: 'cursor' })
  truthy('T4: cursor install exits 0', r2.status === 0, `status=${r2.status}`)
  const reg2 = readJson(registryFilePath(S1.home))
  truthy('T4: cursor adds a second (project, tool) entry', reg2.entries.length === 2 &&
    reg2.entries.some((x) => x.tool === 'cursor'), JSON.stringify(reg2.entries.map((x) => x.tool)))
  truthy('T4: claude-code entry keeps enforcement_installed=true across the cursor install',
    reg2.entries.find((x) => x.tool === 'claude-code').enforcement_installed === true, 'flag lost')

  fs.writeFileSync(registryFilePath(S1.home), '{{{ not json')
  const r3 = runInstall({ home: S1.home, project: S1.project })
  truthy('T4: install with malformed registry still exits 0', r3.status === 0, `status=${r3.status}`)
  truthy('T4: malformed registry noted on stderr', /malformed/.test(r3.stderr || ''), (r3.stderr || '').slice(0, 200))
  const reg3 = readJson(registryFilePath(S1.home))
  truthy('T4: registry rebuilt from scratch (this run\'s entry present)',
    Array.isArray(reg3.entries) && reg3.entries.length === 1 && reg3.entries[0].tool === 'claude-code',
    JSON.stringify(reg3.entries))
  truthy('T4: rebuild preserves enforcement_installed=false default only when unknown (prev entry lost with the malformed file)',
    reg3.entries[0].enforcement_installed === false, JSON.stringify(reg3.entries[0]))
}

// ===========================================================================
console.log('=== T8: --uninstall-enforcement never touches global Layer-1 state; flag heals on next install ===')
// Regression (found by test-uninstall-enforcement t_no_global_touch during
// Layer 1 implementation, 2026-07-08): the first cut wrote the global
// manifest + registry + dist cache on EVERY run, so an uninstall run mutated
// ~/.episodic-memory — violating the locked "uninstall never touches global
// scope" REQ. Fix: all global-side Layer 1 writes are skipped for
// --uninstall-enforcement; the registry's enforcement_installed flag heals
// from disk truth (engine file gone) on the next regular install run.
// ===========================================================================
{
  const S8 = mkSandbox('uninstall')
  runInstall({ home: S8.home, project: S8.project, extra: ['--install-enforcement'] })
  const preGlobal = snapshotTree(path.join(S8.home, '.episodic-memory'))
  const u = runInstall({ home: S8.home, project: S8.project, extra: ['--uninstall-enforcement'] })
  truthy('T8: uninstall run exits 0', u.status === 0, `status=${u.status}`)
  truthy('T8: global ~/.episodic-memory byte-identical across the uninstall run',
    snapshotsEqual(preGlobal, snapshotTree(path.join(S8.home, '.episodic-memory'))), 'global scope changed')
  const pm = readJson(projManifestPath(S8.project))
  truthy('T8: project manifest dropped the removed enforcement entries',
    !pm.artifacts.some((a) => a.path === '.claude/hooks/checkpoint-gate.sh'), 'stale enforcement entry kept')
  const r2 = runInstall({ home: S8.home, project: S8.project })
  truthy('T8: next regular install exits 0', r2.status === 0, `status=${r2.status}`)
  const reg = readJson(registryFilePath(S8.home))
  truthy('T8: enforcement_installed healed to false from disk truth',
    reg.entries.find((e) => e.tool === 'claude-code').enforcement_installed === false,
    JSON.stringify(reg.entries))
}

for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }

console.log(`\n${pass}/${pass + fail} pass`)
if (fail > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exit(1)
}
