#!/usr/bin/env node
/**
 * test-em-recall-plan-marker-sweep.mjs — Direct enforce-contract --session-start
 * invocations exercising the post-2026-05-18 sweep policy (the sweep relocated
 * from em-recall.mjs to enforce-contract.mjs in RFC-008 P3d; this suite keeps
 * the concurrent-session SID-A/SID-B cases not covered by the S-suite):
 *
 *   - Legacy suffix-less `.plan-approval-pending` swept UNCONDITIONALLY at
 *     primary + legacy roots, regardless of baseline state
 *   - Suffixed `.plan-approval-pending.<sid>` (own AND other) NEVER swept
 *     by SessionStart (codex R1 P1.1 + R2 P1)
 *
 * Scenarios (plan v6 §test matrix):
 *   P1  legacy at primary root + valid baseline → swept
 *   P2  legacy at .claude root + valid baseline → swept
 *   P3  legacy at primary + NO baseline (first-boot) → swept (codex R1 P1.4)
 *   N1  other-session suffixed → preserved
 *   N2  7-day-old crashed-session suffixed → preserved
 *   N5  symlink at legacy path → preserved (lstat-fail-closed)
 *   N6  repeated SessionStart with same SID-A → own marker preserved
 *       across multiple SessionStart fires (codex R2 P1 canonical regression)
 *   N7  concurrent SID-A + SID-B markers → both preserved
 *   N8  non-git cwd + --project mismatch + baseline → cwd marker swept;
 *       --project marker untouched (codex R5 P1.2 + R6 ACCEPT-FU)
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// RFC-008 P3d: SessionStart side-effects relocated em-recall.mjs → enforce-contract.mjs --session-start (F38/F60).
const ENFORCE = path.join(REPO, 'scripts', 'enforce-contract.mjs')

let passed = 0
let failed = 0
const cleanups = []
process.on('exit', () => { for (const fn of cleanups) try { fn() } catch {} })

function check(cond, msg) {
  if (cond) { passed++; console.log(`  PASS  ${msg}`) }
  else { failed++; console.log(`  FAIL  ${msg}`) }
}

function mkTmpGitRepo() {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sweep-'))
  const real = fs.realpathSync(raw)
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(real, '.claude'), { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: real })
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function mkTmpNonGitDir() {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sweep-nongit-'))
  const real = fs.realpathSync(raw)
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(real, '.claude'), { recursive: true })
  // NO git init — non-git cwd
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function touchWithMtime(p, secondsAgo) {
  fs.writeFileSync(p, '')
  const ts = (Date.now() / 1000) - secondsAgo
  fs.utimesSync(p, ts, ts)
}

function runSessionStart(cwd, extraArgs = []) {
  const args = [ENFORCE, '--session-start', ...extraArgs]
  return spawnSync('node', args, { cwd, encoding: 'utf8' })
}

// ============================ P1 ============================
{
  console.log('P1: legacy at primary + valid baseline → swept')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)  // 1h ago
  touchWithMtime(path.join(ck, '.plan-approval-pending'), 1800)  // 30m ago (newer than baseline — the bug class)
  const r = runSessionStart(repo)
  check(r.status === 0, `P1 exit 0 (got ${r.status})`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending')), `P1 legacy swept`)
}

// ============================ P2 ============================
{
  console.log('P2: legacy at .claude root + valid baseline → swept')
  const repo = mkTmpGitRepo()
  const cl = path.join(repo, '.claude')
  touchWithMtime(path.join(repo, '.checkpoints', '.session-baseline'), 3600)
  touchWithMtime(path.join(cl, '.plan-approval-pending'), 1800)
  const r = runSessionStart(repo)
  check(r.status === 0, `P2 exit 0`)
  check(!fs.existsSync(path.join(cl, '.plan-approval-pending')), `P2 legacy at .claude/ swept`)
}

// ============================ P3 — first boot, no baseline ============================
{
  console.log('P3: legacy at primary + NO baseline (first boot) → swept (codex R1 P1.4)')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  // NO baseline created
  touchWithMtime(path.join(ck, '.plan-approval-pending'), 1800)
  const r = runSessionStart(repo)
  check(r.status === 0, `P3 exit 0`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending')), `P3 legacy swept on first boot`)
}

// ============================ N1 ============================
{
  console.log('N1: other-session suffixed → preserved')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  touchWithMtime(path.join(ck, '.plan-approval-pending.other-session-B'), 1800)
  const r = runSessionStart(repo, ['--session-id', 'session-A'])
  check(r.status === 0, `N1 exit 0`)
  check(fs.existsSync(path.join(ck, '.plan-approval-pending.other-session-B')), `N1 other-session marker preserved`)
}

// ============================ N2 — old crashed-session orphan ============================
{
  console.log('N2: 7-day-old crashed-session suffixed → preserved')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 60)
  touchWithMtime(path.join(ck, '.plan-approval-pending.crashed-7d'), 7 * 24 * 3600)
  const r = runSessionStart(repo, ['--session-id', 'session-A'])
  check(r.status === 0, `N2 exit 0`)
  check(fs.existsSync(path.join(ck, '.plan-approval-pending.crashed-7d')), `N2 crashed-orphan preserved (operator-cleanup FU)`)
}

// ============================ N5 — symlink preservation ============================
{
  console.log('N5: symlink at legacy path → preserved')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  const target = path.join(repo, 'sentinel.txt')
  fs.writeFileSync(target, 'must-not-be-deleted')
  fs.symlinkSync(target, path.join(ck, '.plan-approval-pending'))
  const r = runSessionStart(repo)
  check(r.status === 0, `N5 exit 0`)
  // lstat detects symlink; rmSync is skipped → symlink remains
  check(fs.lstatSync(path.join(ck, '.plan-approval-pending')).isSymbolicLink(), `N5 symlink preserved (lstat-fail-closed)`)
  check(fs.existsSync(target), `N5 symlink target intact`)
}

// ============================ N6 — repeated SessionStart, own marker preserved ============================
{
  console.log('N6: repeated SessionStart with same SID-A → own marker preserved (codex R2 P1 regression)')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  touchWithMtime(path.join(ck, '.plan-approval-pending.session-A'), 1800)
  // Fire SessionStart 3 times — codex R2 canonical scenario
  for (let i = 0; i < 3; i++) {
    const r = runSessionStart(repo, ['--session-id', 'session-A'])
    check(r.status === 0, `N6 iter ${i + 1} exit 0`)
    check(fs.existsSync(path.join(ck, '.plan-approval-pending.session-A')), `N6 iter ${i + 1} own marker preserved`)
  }
}

// ============================ N7 — concurrent A + B both preserved ============================
{
  console.log('N7: concurrent SID-A + SID-B markers → both preserved')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  touchWithMtime(path.join(ck, '.plan-approval-pending.session-A'), 1800)
  touchWithMtime(path.join(ck, '.plan-approval-pending.session-B'), 900)
  const r = runSessionStart(repo, ['--session-id', 'session-A'])
  check(r.status === 0, `N7 exit 0`)
  check(fs.existsSync(path.join(ck, '.plan-approval-pending.session-A')), `N7 own SID-A preserved`)
  check(fs.existsSync(path.join(ck, '.plan-approval-pending.session-B')), `N7 concurrent SID-B preserved`)
}

// ============================ N8 — non-git cwd + --project mismatch ============================
{
  console.log('N8: non-git cwd + --project mismatch + baseline → cwd marker swept; --project untouched (codex R6 FU)')
  const targetA = mkTmpNonGitDir()  // non-git cwd
  const targetB = mkTmpGitRepo()    // separate dir passed via --project
  const ckA = path.join(targetA, '.checkpoints')
  const ckB = path.join(targetB, '.checkpoints')
  // Codex R6 FU: pre-create baseline at target-A so the non-plan task-marker
  // branch also fires alongside the new legacy sweep. Baseline newer than
  // the legacy marker (older mtime).
  touchWithMtime(path.join(ckA, '.plan-approval-pending'), 7200)  // 2h ago
  touchWithMtime(path.join(ckA, '.session-baseline'), 3600)        // 1h ago, newer
  touchWithMtime(path.join(ckB, '.plan-approval-pending'), 3600)
  const r = runSessionStart(targetA, ['--project', targetB])
  check(r.status === 0, `N8 exit 0 (got ${r.status})`)
  check(!fs.existsSync(path.join(ckA, '.plan-approval-pending')), `N8 target-A legacy swept (cwd authority)`)
  check(fs.existsSync(path.join(ckB, '.plan-approval-pending')), `N8 target-B legacy UNTOUCHED (--project is non-authoritative for sweeps)`)
}

// ============================ summary ============================
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
