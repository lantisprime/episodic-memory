#!/usr/bin/env node
// test-install-em-recall-purified.mjs — RFC-008 P3d (F45) install-time em-recall
// purity sentinel regression.
//
// install.mjs must refuse to deploy a stale pre-v11 (pre-purification) em-recall
// that still carries enforcement code (--gate stop / --session-start / markers).
// Controls:
//   1. Detection lib (clean → no tokens; dirty → tokens) — the shared Rule-14 source.
//   2. The real repo em-recall.mjs is pure (parity with the F60 source guard).
//   3. FAILURE path: install from a staged dirtied source → exit 1 + F45 message.
//   4. HAPPY path: install from the clean repo → exit 0 + deployed em-recall pure.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { findEnforcementTokens } from '../scripts/lib/em-recall-purity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

let pass = 0, fail = 0
const failures = []
const ok = (n) => { pass++; console.log(`  ✓ ${n}`) }
const bad = (n, d) => { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n}: ${d}`) }

function cpR(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name)
    if (e.isDirectory()) cpR(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

console.log('=== F45: install-time em-recall purity sentinel ===')

// --- Control 1: detection lib ---
{
  const cleanBody = `console.log('pure recall'); const scope = '--scope'`
  if (findEnforcementTokens(cleanBody).length === 0) ok('lib: clean recall body → no leaked tokens')
  else bad('lib clean', `expected [], got ${JSON.stringify(findEnforcementTokens(cleanBody))}`)

  const dirtyBody = `if (flag('--gate') === 'stop') {} // writes .session-baseline`
  const leaked = findEnforcementTokens(dirtyBody)
  if (leaked.includes('--gate') && leaked.includes('.session-baseline')) ok('lib: dirty body → leaked tokens detected')
  else bad('lib dirty', `got ${JSON.stringify(leaked)}`)
}

// --- Control 2: real repo em-recall is pure ---
{
  const leaked = findEnforcementTokens(fs.readFileSync(path.join(REPO, 'scripts', 'em-recall.mjs'), 'utf8'))
  if (leaked.length === 0) ok('repo scripts/em-recall.mjs is pure')
  else bad('repo em-recall purity', leaked.join(', '))
}

// --- Control 3: FAILURE path — staged pre-v11 source → install exits 1 ---
{
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f45-stage-')))
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f45-home-')))
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f45-proj-')))
  try {
    fs.copyFileSync(path.join(REPO, 'install.mjs'), path.join(stage, 'install.mjs'))
    cpR(path.join(REPO, 'scripts'), path.join(stage, 'scripts'))
    // Dirty the staged em-recall with a pre-v11 enforcement token.
    fs.appendFileSync(
      path.join(stage, 'scripts', 'em-recall.mjs'),
      `\n// stale pre-v11: if (flag('--gate') === 'stop') runStopGate()\n`
    )
    const r = spawnSync('node', [path.join(stage, 'install.mjs'), '--tool', 'claude-code', '--project', proj],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    if (r.status === 1) ok('F45: install exits 1 on stale pre-v11 em-recall source')
    else bad('F45 exit', `status=${r.status} stderr=${r.stderr}`)
    if (/F45/.test(r.stderr) && /--gate/.test(r.stderr)) ok('F45: error names the leaked token + F45')
    else bad('F45 message', `stderr=${r.stderr}`)
    // Defensive: prove the staged source was actually dirty (non-vacuous).
    const stagedDirty = findEnforcementTokens(fs.readFileSync(path.join(stage, 'scripts', 'em-recall.mjs'), 'utf8'))
    if (stagedDirty.includes('--gate')) ok('F45 (defensive): staged source was dirty')
    else bad('F45 defensive', 'staged source not dirty — test would be vacuous')
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
}

// --- Control 4: HAPPY path — clean repo install → exit 0 + deployed copy pure ---
{
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f45-okhome-')))
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f45-okproj-')))
  try {
    const r = spawnSync('node', [path.join(REPO, 'install.mjs'), '--tool', 'claude-code', '--project', proj],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    if (r.status === 0) ok('F45: install exits 0 on clean source')
    else bad('install clean exit', `status=${r.status} stderr=${(r.stderr || '').slice(-400)}`)
    const deployed = path.join(home, '.episodic-memory', 'scripts', 'em-recall.mjs')
    if (fs.existsSync(deployed) && findEnforcementTokens(fs.readFileSync(deployed, 'utf8')).length === 0) {
      ok('F45: deployed em-recall.mjs is pure')
    } else {
      bad('deployed purity', fs.existsSync(deployed) ? 'leaked tokens in deployed copy' : 'em-recall not deployed')
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(proj, { recursive: true, force: true })
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
