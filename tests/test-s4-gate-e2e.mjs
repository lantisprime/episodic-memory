#!/usr/bin/env node
// test-s4-gate-e2e.mjs — RFC-008 P4d S4 FULL mock-project GATE E2E (P12 invariant 2).
//
// Distinct from test-install-contract-deploy.mjs T4-T7b (which toggle the engine
// CLI directly via --layer-active / --resolve-gate): this drives the REAL DEPLOYED
// stop-gate.sh HOOK with a Stop event and proves the SEEDED enforce-config.json
// toggles a real gate END-TO-END through the actual bash hook → engine path:
//
//   active:true (seeded default) + armed checkpoint → stop-gate BLOCKS
//   flip seed to active:false                       → stop-gate ALLOWS (kill switch)
//   restore active:true                             → BLOCKS again (toggle is the cause)
//
// Real install.mjs into an isolated HOME + git mock project; the deployed gate
// resolves the co-located per-project engine + seeded config. No stubs, no
// hand-staged HOME, no mental tracing (feedback_mock_project_test_not_mental_trace).
//
// Requires bash + jq on PATH (CI ubuntu-latest has both; test-stop-gate.sh shares
// the requirement). Zero deps beyond the harness.

import fs from 'node:fs'
import path from 'node:path'
import { mkMock, runInstall, runHook } from './lib/activation-scoping-harness.mjs'

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ✓ ${n}`) }
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}: ${d}`) }

const M = mkMock('s4-gate-e2e')
const r = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-enforcement'] })
if (r.status !== 0) { console.error('install failed:', r.stderr); process.exit(1) }

const cfgPath = path.join(M.project, '.episodic-memory', 'enforce-config.json')
const stopGate = path.join(M.project, '.claude', 'hooks', 'stop-gate.sh')
if (fs.existsSync(cfgPath)) ok('seed: enforce-config.json provisioned (active:true)')
else bad('seed', `missing ${cfgPath}`)
if (fs.existsSync(stopGate)) ok('deployed: stop-gate.sh present per-project')
else bad('deployed gate', `missing ${stopGate}`)

// Arm the checkpoint so the stop gate WOULD block (canonical + legacy read paths).
fs.mkdirSync(path.join(M.project, '.checkpoints'), { recursive: true })
fs.mkdirSync(path.join(M.project, '.claude'), { recursive: true })
fs.writeFileSync(path.join(M.project, '.checkpoints', '.checkpoint-required'), '')
fs.writeFileSync(path.join(M.project, '.claude', '.checkpoint-required'), '')

const fireStop = () => runHook(stopGate, { stop_hook_active: false, cwd: M.project }, { home: M.home, project: M.project })
const isBlock = (o) => /"decision"\s*:\s*"block"/.test(o.stdout || '')

// 1. Default seed (active:true) + armed → BLOCK.
const a = fireStop()
if (isBlock(a)) ok('active:true (seed) + armed checkpoint → stop-gate BLOCKS')
else bad('active:true → block', `stdout="${(a.stdout || '').trim()}" stderr=${(a.stderr || '').slice(-300)}`)

// 2. Flip seed to active:false → ALLOW (the kill switch silences the real gate).
fs.writeFileSync(cfgPath, '{"active":false}\n')
const b = fireStop()
if (!isBlock(b) && (b.stdout || '').trim() === '') ok('active:false (seed) → stop-gate ALLOWS (empty) — kill switch silences the real gate')
else bad('active:false → allow', `stdout="${(b.stdout || '').trim()}" stderr=${(b.stderr || '').slice(-300)}`)

// 3. Restore active:true → BLOCK again (control: the toggle, not state drift, is the cause).
fs.writeFileSync(cfgPath, '{\n  "active": true\n}\n')
const c = fireStop()
if (isBlock(c)) ok('restore active:true → stop-gate BLOCKS again (toggle is the cause)')
else bad('restore → block', `stdout="${(c.stdout || '').trim()}" stderr=${(c.stderr || '').slice(-300)}`)

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
