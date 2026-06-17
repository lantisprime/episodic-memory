#!/usr/bin/env node
// test-install-contract-deploy.mjs — RFC-008 P3b-2 (§10 install-runtime contract
// deploy; mirrors the P3c T20a2 coupling regression). The enforce-contract runtime
// contract set (bp-001.json + events.json + enforce-config.schema.json) is
// co-deployed to $HOME/.episodic-memory/patterns/ ONLY inside --install-hooks
// (COUPLED to the hook install, like the P3c taxonomy deploy): stop-gate.sh invokes
// enforce-contract.mjs, so a no-hooks install must NOT advance the global contract
// while the installed gate stays stale.
//
//   T1 — --install-hooks deploys the full coupled set, byte-equal to the repo.
//   T2 — F-NEW-4 coupling: deployed bp-001.events_version == sha(deployed events.json).
//   T3 — no-hooks install leaves the contract set ABSENT (the T20a2 analog), while
//        the unconditional patterns/_index.json IS deployed.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { eventsVersion } from '../scripts/lib/version-hash.mjs'

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
function runInstall({ home, project, hooks }) {
  const args = [INSTALL, '--tool', 'claude-code', '--project', project]
  if (hooks) args.push('--install-hooks')
  return spawnSync('node', args, { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home } })
}
function globalPatterns(home) { return path.join(home, '.episodic-memory', 'patterns') }
function byteEqual(a, b) { return fs.readFileSync(a).equals(fs.readFileSync(b)) }

console.log('=== T1/T2: --install-hooks deploys the coupled contract set ===')
{
  const { home, project } = mkSandbox('hooks')
  const r = runInstall({ home, project, hooks: true })
  truthy('T1: install --install-hooks exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  const gp = globalPatterns(home)
  for (const f of CONTRACT_SET) {
    const dep = path.join(gp, f)
    truthy(`T1: ${f} deployed`, fs.existsSync(dep), `missing ${dep}`)
    if (fs.existsSync(dep)) truthy(`T1: ${f} byte-equal repo`, byteEqual(dep, path.join(REPO, 'patterns', f)), 'deployed bytes differ from repo')
  }
  // T2 — coupling assertion: deployed bp-001.events_version == sha(deployed events.json).
  try {
    const depBp = JSON.parse(fs.readFileSync(path.join(gp, 'bp-001.json'), 'utf8'))
    const depEvents = JSON.parse(fs.readFileSync(path.join(gp, 'events.json'), 'utf8'))
    truthy('T2: deployed bp-001.events_version == sha(deployed events.json)', depBp.events_version === eventsVersion(depEvents),
      `bp=${depBp.events_version} live=${eventsVersion(depEvents)}`)
  } catch (e) { bad('T2: coupling readable', e.message) }
}

console.log('')
console.log('=== T3: no-hooks install leaves the contract set ABSENT (T20a2 analog) ===')
{
  const { home, project } = mkSandbox('nohooks')
  const r = runInstall({ home, project, hooks: false })
  truthy('T3: install (no hooks) exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
  const gp = globalPatterns(home)
  for (const f of CONTRACT_SET) {
    truthy(`T3: ${f} ABSENT without --install-hooks`, !fs.existsSync(path.join(gp, f)), `unexpectedly present: ${path.join(gp, f)}`)
  }
  // The unconditional _index.json IS deployed even without hooks (existing behavior).
  truthy('T3: patterns/_index.json deployed unconditionally', fs.existsSync(path.join(gp, '_index.json')), 'expected _index.json present')
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
