#!/usr/bin/env node
// test-install-contract-deploy.mjs — RFC-008 P4d / Principle 12 (relocated
// 2026-06-19; was P3b-2 §10 global-contract deploy). The enforce-contract RUNTIME
// contract set (bp-001.json + events.json + enforce-config.schema.json + taxonomy.json)
// + plugins/_index.json is the engine's CONFIG. By the P12 function test it is
// ENFORCEMENT, not substrate, so it deploys PER-PROJECT — CO-LOCATED with the engine
// under <project>/.claude/hooks/{patterns,plugins}/ — under --install-enforcement,
// and NEVER to the global $HOME/.episodic-memory/patterns/.
//
//   T1 — --install-enforcement deploys the full coupled set per-project, byte-equal repo.
//   T2 — F-NEW-4 coupling: deployed bp-001.events_version == sha(deployed events.json).
//   T3 — GLOBAL stays clean: the contract set is ABSENT from ~/.episodic-memory/patterns/
//        even WITH --install-enforcement (P12), while the substrate patterns/_index.json
//        IS deployed global unconditionally.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { eventsVersion } from '../scripts/lib/version-hash.mjs'
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = path.join(REPO, 'install.mjs')
const CONTRACT_SET = ['bp-001.json', 'events.json', 'enforce-config.schema.json']

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function truthy(name, v, detail) { if (v) ok(name); else bad(name, detail || 'expected truthy') }

function mkSandbox(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `contract-deploy-home-${label}-`))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `contract-deploy-proj-${label}-`))
  execFileSync('git', ['init', '-q'], { cwd: project })
  return { home, project }
}
function runInstall({ home, project, enforcement, hooks, force }) {
  const args = [INSTALL, '--tool', 'claude-code', '--project', project]
  if (enforcement) args.push('--install-enforcement')
  if (hooks) args.push('--install-hooks')
  if (force) args.push('--install-hooks-force')
  return spawnSync('node', args, { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home } })
}
// Spawn the REAL DEPLOYED per-project engine (not the repo copy). resolveContractRoot
// keys off the engine's own selfDir/patterns (candidate-0), so only the deployed binary
// finds the deployed schema + seeded instance at the matching roots.
function runEngine(home, project, engineArgs) {
  const engine = path.join(project, '.claude', 'hooks', 'enforce-contract.mjs')
  return spawnSync('node', [engine, ...engineArgs], { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home } })
}
// Engine candidate-0 contract root: co-located with the engine under the project hooks dir.
function projectContractRoot(project) { return path.join(project, '.claude', 'hooks') }
function projectPatterns(project) { return path.join(projectContractRoot(project), 'patterns') }
function globalPatterns(home) { return path.join(home, '.episodic-memory', 'patterns') }
function byteEqual(a, b) { return fs.readFileSync(a).equals(fs.readFileSync(b)) }

console.log('=== T1/T2: --install-enforcement deploys the coupled contract set PER-PROJECT ===')
{
  const { home, project } = mkSandbox('enforce')
  const r = runInstall({ home, project, enforcement: true })
  truthy('T1: install --install-enforcement exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  const pp = projectPatterns(project)
  for (const f of CONTRACT_SET) {
    const dep = path.join(pp, f)
    truthy(`T1: ${f} deployed per-project`, fs.existsSync(dep), `missing ${dep}`)
    if (fs.existsSync(dep)) truthy(`T1: ${f} byte-equal repo`, byteEqual(dep, path.join(REPO, 'patterns', f)), 'deployed bytes differ from repo')
  }
  // taxonomy.json travels with the contract set (the classifier reads it co-located).
  truthy('T1: taxonomy.json deployed per-project', fs.existsSync(path.join(pp, 'taxonomy.json')), `missing ${path.join(pp, 'taxonomy.json')}`)
  // T2 — coupling assertion: deployed bp-001.events_version == sha(deployed events.json).
  try {
    const depBp = JSON.parse(fs.readFileSync(path.join(pp, 'bp-001.json'), 'utf8'))
    const depEvents = JSON.parse(fs.readFileSync(path.join(pp, 'events.json'), 'utf8'))
    truthy('T2: deployed bp-001.events_version == sha(deployed events.json)', depBp.events_version === eventsVersion(depEvents),
      `bp=${depBp.events_version} live=${eventsVersion(depEvents)}`)
  } catch (e) { bad('T2: coupling readable', e.message) }
  // The harness-cap registry the engine reads from <contractRoot>/plugins/_index.json
  // is co-located with the engine, per-project.
  const depRegistry = path.join(projectContractRoot(project), 'plugins', '_index.json')
  truthy('PR-1: plugins/_index.json deployed per-project (co-located with engine)', fs.existsSync(depRegistry), `missing ${depRegistry}`)
  if (fs.existsSync(depRegistry)) truthy('PR-1: deployed registry byte-equal repo', byteEqual(depRegistry, path.join(REPO, 'plugins', '_index.json')), 'deployed registry differs from repo')

  // P12: the contract set must NOT appear in GLOBAL ~/.episodic-memory/patterns/.
  const gp = globalPatterns(home)
  for (const f of [...CONTRACT_SET, 'taxonomy.json']) {
    truthy(`P12: ${f} ABSENT from global patterns (even with --install-enforcement)`, !fs.existsSync(path.join(gp, f)), `LEAKED to global: ${path.join(gp, f)}`)
  }
  truthy('P12: global plugins/_index.json ABSENT (contract registry is per-project)', !fs.existsSync(path.join(home, '.episodic-memory', 'plugins', '_index.json')), 'contract plugins index leaked to global')
}

console.log('')
console.log('=== T3: substrate patterns/_index.json still deployed global unconditionally ===')
{
  const { home, project } = mkSandbox('nohooks')
  const r = runInstall({ home, project, enforcement: false })
  truthy('T3: install (core) exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  const gp = globalPatterns(home)
  // The substrate behavioral-pattern registry IS deployed global even on core.
  truthy('T3: patterns/_index.json (substrate) deployed unconditionally', fs.existsSync(path.join(gp, '_index.json')), 'expected _index.json present')
  // The enforce-contract config set is NEVER global.
  for (const f of [...CONTRACT_SET, 'taxonomy.json']) {
    truthy(`T3: ${f} ABSENT from global patterns`, !fs.existsSync(path.join(gp, f)), `unexpectedly present: ${path.join(gp, f)}`)
  }
}

console.log('')
console.log('=== T4-T7: per-project enforce-config.json switch (RFC-008 P4d S4, P12 invariant 2) ===')
{
  const { home, project } = mkSandbox('switch')
  const r = runInstall({ home, project, enforcement: true })
  truthy('T4: install --install-enforcement exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  // T4 — provisioning. NOTE: this file is gitignored BY DESIGN (install.mjs §2 appends
  // .episodic-memory/) — a per-checkout operator switch, not committed team policy.
  const cfgPath = path.join(project, '.episodic-memory', 'enforce-config.json')
  truthy('T4: enforce-config.json seeded per-project', fs.existsSync(cfgPath), `missing ${cfgPath}`)
  let parsed = null
  try { parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (e) { bad('T4: seed parses as JSON', e.message) }
  if (parsed) truthy('T4: seed is {active:true}', parsed.active === true, `got ${JSON.stringify(parsed)}`)
  // schema-valid against the DEPLOYED schema (engine candidate-0 patterns).
  const depSchemaPath = path.join(projectPatterns(project), 'enforce-config.schema.json')
  if (parsed && fs.existsSync(depSchemaPath)) {
    const schema = JSON.parse(fs.readFileSync(depSchemaPath, 'utf8'))
    truthy('T4: seed is valid against the deployed schema', validateInstance(parsed, schema).valid, 'seed failed deployed schema')
  }

  // T5 — toggle via the REAL DEPLOYED engine.
  const engine = path.join(project, '.claude', 'hooks', 'enforce-contract.mjs')
  truthy('T5: deployed engine present', fs.existsSync(engine), `missing ${engine}`)
  // default (active:true) → NO `inactive` token → layer enforces.
  const a1 = runEngine(home, project, ['--layer-active', '--marker-root', project])
  truthy('T5: active:true → no `inactive` token (layer enforces)',
    a1.status === 0 && a1.stdout.trim() !== 'inactive',
    `stdout="${(a1.stdout || '').trim()}" stderr=${(a1.stderr || '').slice(-200)}`)
  // flip to active:false → stdout === `inactive` → layer silenced.
  fs.writeFileSync(cfgPath, '{"active":false}\n')
  const a2 = runEngine(home, project, ['--layer-active', '--marker-root', project])
  truthy('T5: active:false → `inactive` token (layer silenced)',
    a2.stdout.trim() === 'inactive',
    `stdout="${(a2.stdout || '').trim()}" stderr=${(a2.stderr || '').slice(-200)}`)
  // T5b (F10) — the per-gate reader honors the SAME seeded file: --resolve-gate
  // plan_approval under active:false → `silence` (proves layer-wide AND per-gate
  // readers resolve the same seeded instance).
  const g = runEngine(home, project, ['--resolve-gate', 'plan_approval', '--marker-root', project])
  truthy('T5b: active:false → --resolve-gate plan_approval emits `silence`',
    g.stdout.trim() === 'silence',
    `stdout="${(g.stdout || '').trim()}" stderr=${(g.stderr || '').slice(-200)}`)
}

{
  // T6 (F9b) — preservation: a forced reinstall must NOT clobber operator state, and
  // preservation is WHOLE-FILE (active:false PLUS a per-bp clamp), not just the boolean.
  const { home, project } = mkSandbox('preserve')
  fs.mkdirSync(path.join(project, '.episodic-memory'), { recursive: true })
  const cfgPath = path.join(project, '.episodic-memory', 'enforce-config.json')
  const operatorCfg = '{\n  "active": false,\n  "bp-001": { "stop": "WEAK" }\n}\n'
  fs.writeFileSync(cfgPath, operatorCfg)
  const r = runInstall({ home, project, enforcement: true, force: true })
  truthy('T6: forced reinstall (--install-hooks-force) exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  truthy('T6: operator enforce-config.json preserved byte-for-byte (active:false + per-bp clamp survive --install-hooks-force)',
    fs.readFileSync(cfgPath, 'utf8') === operatorCfg,
    `clobbered → ${fs.readFileSync(cfgPath, 'utf8')}`)
}

{
  // T7 (F7) — core install (no --install-enforcement) does NOT seed the switch. The
  // .episodic-memory/ DIR is created unconditionally (install.mjs §2); only the FILE
  // is gated on enforcement. Assert the FILE is absent, NOT the dir.
  const { home, project } = mkSandbox('coreswitch')
  const r = runInstall({ home, project, enforcement: false })
  truthy('T7: core install exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  const cfgPath = path.join(project, '.episodic-memory', 'enforce-config.json')
  truthy('T7: core install does NOT seed enforce-config.json (switch ships only with enforcement)',
    !fs.existsSync(cfgPath), `unexpectedly seeded: ${cfgPath}`)
}

{
  // T7b (review F-A) — --install-hooks ALONE (without --install-enforcement) must also
  // NOT seed: the switch is gated on enforcement, not hooks. This is the path that
  // distinguishes "gated on enforcement" from "gated on hooks" (T7 covers neither-flag).
  const { home, project } = mkSandbox('hooksonly')
  const r = runInstall({ home, project, hooks: true })
  truthy('T7b: --install-hooks (no enforcement) exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  const cfgPath = path.join(project, '.episodic-memory', 'enforce-config.json')
  truthy('T7b: --install-hooks alone does NOT seed enforce-config.json (gated on enforcement, not hooks)',
    !fs.existsSync(cfgPath), `unexpectedly seeded: ${cfgPath}`)
}

console.log('')
if (fail === 0) {
  console.log(`PASS — ${pass} checks`)
  process.exit(0)
} else {
  console.log(`FAIL — ${fail} of ${pass + fail} checks failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
