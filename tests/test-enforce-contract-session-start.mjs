#!/usr/bin/env node
// test-enforce-contract-session-start.mjs — RFC-008 P3d (F38/F60).
//
// enforce-contract.mjs `--session-start` is the RELOCATION TARGET for the
// SessionStart side-effects deleted from em-recall.mjs (the baseline write +
// marker sweeps + bp-001 advisory). These tests pin the relocated behavior:
//   - force-monotonic `.session-baseline` write (dual-root MAX probe)
//   - legacy-plan-marker sweep + preflight-orphan sweep (7-day guard)
//   - lstat/symlink-skip defenses (symlinks never followed/unlinked)
//   - --session-start dispatches BEFORE the --gate required-check (F6)
//   - --session-start ⊥ --gate (mutual exclusion)
//
// This file is the new home for assertions migrated from the deleted em-recall
// tests (baseline-monotonic, plan-marker-sweep, preflight-marker-reapers).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  PRIMARY_MARKER_DIR,
  LEGACY_MARKER_DIR,
  BASELINE_NAME,
  PLAN_MARKER_LEGACY_BASENAME,
  primaryMarkerPath,
  legacyMarkerPath,
} from '../scripts/lib/marker-paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ENFORCE = path.join(REPO, 'scripts', 'enforce-contract.mjs')

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function eq(name, actual, expected) {
  if (actual === expected) ok(name)
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function truthy(name, v, detail) { if (v) ok(name); else bad(name, detail || 'expected truthy') }

function mkGitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-ss-'))
  execSync('git init -q -b main', { cwd: repo })
  execSync('git config user.email test@example.com', { cwd: repo })
  execSync('git config user.name test', { cwd: repo })
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n')
  execSync('git add . && git commit -q -m init', { cwd: repo, shell: '/bin/bash' })
  fs.mkdirSync(path.join(repo, PRIMARY_MARKER_DIR), { recursive: true })
  fs.mkdirSync(path.join(repo, LEGACY_MARKER_DIR), { recursive: true })
  return repo
}
function writeMarker(p, mtimeSec, content = '') {
  fs.writeFileSync(p, content)
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec)
}
function runSessionStart(cwd, extraArgs = []) {
  return spawnSync('node', [ENFORCE, '--session-start', ...extraArgs], { cwd, encoding: 'utf8' })
}

console.log('=== enforce-contract --session-start side-effects ===')

// S1 — baseline is written at the primary root after --session-start.
{
  const repo = mkGitRepo()
  const r = runSessionStart(repo)
  eq('S1: exit 0', r.status, 0)
  eq('S1: empty stdout (no decision emitted)', r.stdout, '')
  truthy('S1: .session-baseline exists at primary root',
    fs.existsSync(primaryMarkerPath(repo, BASELINE_NAME)))
}

// S2 — force-monotonic: baseline.mtime dominates a planted future checkpoint marker.
{
  const repo = mkGitRepo()
  const now = Date.now() / 1000
  const future = now + 1000 // 1000s in the future
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), future)
  runSessionStart(repo)
  const baselineMs = fs.statSync(primaryMarkerPath(repo, BASELINE_NAME)).mtimeMs
  const markerMs = fs.statSync(primaryMarkerPath(repo, '.checkpoint-required')).mtimeMs
  truthy('S2: baseline.mtime > planted future checkpoint marker (force-monotonic)',
    baselineMs > markerMs, `baseline=${baselineMs} marker=${markerMs}`)
}

// S3 — cross-session suffixed checkpoint marker is also dominated by the baseline.
{
  const repo = mkGitRepo()
  const future = Date.now() / 1000 + 1000
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required.other-sid'), future)
  runSessionStart(repo)
  const baselineMs = fs.statSync(primaryMarkerPath(repo, BASELINE_NAME)).mtimeMs
  const markerMs = fs.statSync(primaryMarkerPath(repo, '.checkpoint-required.other-sid')).mtimeMs
  truthy('S3: baseline.mtime > suffixed cross-session marker', baselineMs > markerMs,
    `baseline=${baselineMs} marker=${markerMs}`)
}

// S4 — legacy plan-marker swept at BOTH roots (PR #314 contract).
{
  const repo = mkGitRepo()
  writeMarker(primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME), 200)
  writeMarker(legacyMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME), 200)
  runSessionStart(repo)
  eq('S4: legacy plan-marker removed at primary',
    fs.existsSync(primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME)), false)
  eq('S4: legacy plan-marker removed at legacy',
    fs.existsSync(legacyMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME)), false)
}

// S5 — preflight orphan >7d swept; recent (<7d) preserved.
{
  const repo = mkGitRepo()
  const nowSec = Date.now() / 1000
  const old = nowSec - 8 * 24 * 60 * 60   // 8 days old
  const recent = nowSec - 1 * 24 * 60 * 60 // 1 day old
  const orphan = primaryMarkerPath(repo, '.preflight-done.stale-sid')
  const fresh = primaryMarkerPath(repo, '.preflight-done.fresh-sid')
  writeMarker(orphan, old)
  writeMarker(fresh, recent)
  runSessionStart(repo)
  eq('S5: stale (>7d) preflight orphan swept', fs.existsSync(orphan), false)
  eq('S5: recent (<7d) preflight marker preserved', fs.existsSync(fresh), true)
}

// S6 — symlinked plan-marker is NOT followed/unlinked (lstat-skip defense).
{
  const repo = mkGitRepo()
  const target = path.join(repo, 'real-secret.txt')
  fs.writeFileSync(target, 'secret\n')
  const link = primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME)
  fs.symlinkSync(target, link)
  runSessionStart(repo)
  eq('S6: symlinked plan-marker preserved (not followed)', fs.existsSync(link), true)
  eq('S6: symlink target untouched', fs.existsSync(target), true)
}

// S7 — --session-start ⊥ --gate (mutual exclusion → error exit 1).
{
  const repo = mkGitRepo()
  const r = runSessionStart(repo, ['--gate', 'stop'])
  eq('S7: combined --session-start --gate → exit 1', r.status, 1)
  truthy('S7: error message names the mutual exclusion',
    r.stdout.includes('cannot be combined with --gate'), `stdout=${r.stdout}`)
}

// S8 — --session-start emits no block decision even when a checkpoint marker is armed
// (it is a side-effect mode, not the stop gate).
{
  const repo = mkGitRepo()
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 200)
  const r = runSessionStart(repo)
  eq('S8: armed marker → still exit 0', r.status, 0)
  eq('S8: armed marker → no decision on stdout', r.stdout, '')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
