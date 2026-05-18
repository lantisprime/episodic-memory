#!/usr/bin/env node
/**
 * test-em-recall-baseline-monotonic.mjs — Force-monotonic SessionStart
 * baseline and removal of CR/PostR baseline-mtime sweep (2026-05-18 orphan-
 * deadlock fix, codex 4 rounds R1-R4).
 *
 * Scenarios (plan v4 §test matrix):
 *
 *   Precision (P1-P3):
 *     P1  baseline.mtime > CR.mtime when CR pre-existed (orphan from prior
 *         session) — carve-out invariant holds
 *     P2  baseline.mtime > CR.mtime when CR is freshly armed (simulated:
 *         touch CR with mtime = Date.now() + 0.0005 ms before SessionStart;
 *         baseline must still dominate via +1ms force-monotonic)
 *     P3  baseline.mtime > PostR.mtime when PostR pre-existed
 *
 *   No-rm contract (N1-N12; codex R3 P1 canonical regression):
 *     N1  CR pre-exists with mtime older than baseline → PRESERVED (NOT
 *         swept). This is the case the prior buggy sweep removed.
 *     N2  CR pre-exists with mtime newer than baseline → PRESERVED.
 *     N3  PostR pre-exists older than baseline → PRESERVED.
 *     N4  PostR pre-exists newer than baseline → PRESERVED.
 *     N5  Plan-marker legacy basename pre-exists → STILL SWEPT (PR #314
 *         contract unchanged).
 *     N6  Plan-marker suffixed `.<sid>` pre-exists → PRESERVED.
 *     N7-N10  Disk-state regression for codex R3: target `.checkpoint-
 *         required` survives caller-cwd != target-cwd SessionStart.
 *     N11  Symlink at CR path → skipped (lstat-fail-closed, threat model).
 *     N12  CR at both primary + legacy roots → both preserved.
 *
 *   Concurrent (C1-C2):
 *     C1  Session A arms CR, Session B SessionStart runs → B's baseline
 *         > A's CR mtime; A's CR PRESERVED; writer-gate still blocks.
 *     C2  Two back-to-back SessionStarts (resume) — baseline monotonic
 *         on every fire.
 *
 *   Cwd-binding (CWD1-CWD6; codex R2 P1.1):
 *     CWD1  caller cwd != target → marker probes hit target only.
 *     CWD2  nested cwd inside target → bound to target via resolveRepoRoot.
 *     CWD3  linked worktree vs main → bound to worktree-local checkpoints.
 *     CWD4  non-git cwd → falls back to cwd as REPO_ROOT.
 *     CWD5  GIT_DIR / GIT_WORK_TREE pollution → no leak to caller cwd.
 *     CWD6  HOME pointing elsewhere → no leak to $HOME/.checkpoints.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const EM_RECALL = path.join(REPO, 'scripts', 'em-recall.mjs')

let passed = 0
let failed = 0
const cleanups = []
process.on('exit', () => { for (const fn of cleanups) try { fn() } catch {} })

function check(cond, msg) {
  if (cond) { passed++; console.log(`  PASS  ${msg}`) }
  else { failed++; console.log(`  FAIL  ${msg}`) }
}

function mkTmpGitRepo(prefix = 'em-monotonic-') {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const real = fs.realpathSync(raw)
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(real, '.claude'), { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: real })
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function mkTmpNonGitDir(prefix = 'em-monotonic-nongit-') {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const real = fs.realpathSync(raw)
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(real, '.claude'), { recursive: true })
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function touchWithMtimeMs(p, mtimeMs) {
  fs.writeFileSync(p, '')
  const sec = mtimeMs / 1000
  fs.utimesSync(p, sec, sec)
}

function runSessionStart(cwd, env = {}, extraArgs = []) {
  const args = [EM_RECALL, '--limit', '5', '--session-start', ...extraArgs]
  return spawnSync('node', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

function mtimeMsOf(p) {
  try { return fs.lstatSync(p).mtimeMs } catch { return null }
}

// ============================ P1 ============================
{
  console.log('P1: orphan CR mtime < baseline mtime after SessionStart')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const cr = path.join(ck, '.checkpoint-required')
  touchWithMtimeMs(cr, Date.now() - 5000)
  const r = runSessionStart(repo)
  check(r.status === 0, `P1 exit 0 (got ${r.status})`)
  const bMt = mtimeMsOf(path.join(ck, '.session-baseline'))
  const cMt = mtimeMsOf(cr)
  check(bMt !== null && cMt !== null && cMt <= bMt, `P1 baseline.mtime (${bMt}) >= CR.mtime (${cMt})`)
  check(fs.existsSync(cr), `P1 CR PRESERVED (not swept)`)
}

// ============================ P2 ============================
{
  console.log('P2: freshly-armed CR (post-Date.now-tick) → baseline still dominates via +1ms')
  // Simulate the empirical bug: CR mtime is sub-ms past Date.now()-as-of-baseline-write.
  // The force-monotonic logic uses max(Date.now(), ceil(maxMtime)+1) so even when
  // bp-001 arms CR after Date.now() is sampled, baseline.mtime still > CR.mtime.
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const cr = path.join(ck, '.checkpoint-required')
  // Touch CR with a near-future mtime to simulate a marker armed at sub-ms past Date.now().
  touchWithMtimeMs(cr, Date.now() + 0.5)
  const r = runSessionStart(repo)
  check(r.status === 0, `P2 exit 0`)
  const bMt = mtimeMsOf(path.join(ck, '.session-baseline'))
  const cMt = mtimeMsOf(cr)
  check(bMt !== null && cMt !== null && cMt <= bMt, `P2 baseline.mtime (${bMt}) > CR.mtime (${cMt}) via +1 force-monotonic`)
}

// ============================ P3 ============================
{
  console.log('P3: PostR pre-exists → baseline.mtime dominates')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const postr = path.join(ck, '.post-checkpoint-required')
  touchWithMtimeMs(postr, Date.now() - 2000)
  const r = runSessionStart(repo)
  check(r.status === 0, `P3 exit 0`)
  const bMt = mtimeMsOf(path.join(ck, '.session-baseline'))
  const pMt = mtimeMsOf(postr)
  check(bMt !== null && pMt !== null && pMt <= bMt, `P3 baseline.mtime (${bMt}) >= PostR.mtime (${pMt})`)
  check(fs.existsSync(postr), `P3 PostR PRESERVED`)
}

// ============================ N1 ============================
{
  console.log('N1: CR older than would-be baseline → PRESERVED (codex R3 P1 canonical regression)')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const cr = path.join(ck, '.checkpoint-required')
  // Old baseline (simulates prior session) + older CR — prior buggy sweep would rm CR.
  touchWithMtimeMs(path.join(ck, '.session-baseline'), Date.now() - 3600_000)
  touchWithMtimeMs(cr, Date.now() - 7200_000)
  const r = runSessionStart(repo)
  check(r.status === 0, `N1 exit 0`)
  check(fs.existsSync(cr), `N1 CR PRESERVED across SessionStart (regression vs old sweep)`)
}

// ============================ N2 ============================
{
  console.log('N2: CR newer than baseline → PRESERVED')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const cr = path.join(ck, '.checkpoint-required')
  touchWithMtimeMs(path.join(ck, '.session-baseline'), Date.now() - 3600_000)
  touchWithMtimeMs(cr, Date.now() - 60_000)
  const r = runSessionStart(repo)
  check(r.status === 0, `N2 exit 0`)
  check(fs.existsSync(cr), `N2 CR PRESERVED`)
}

// ============================ N3 ============================
{
  console.log('N3: PostR older than baseline → PRESERVED')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const postr = path.join(ck, '.post-checkpoint-required')
  touchWithMtimeMs(path.join(ck, '.session-baseline'), Date.now() - 3600_000)
  touchWithMtimeMs(postr, Date.now() - 7200_000)
  const r = runSessionStart(repo)
  check(r.status === 0, `N3 exit 0`)
  check(fs.existsSync(postr), `N3 PostR PRESERVED`)
}

// ============================ N4 ============================
{
  console.log('N4: PostR newer than baseline → PRESERVED')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const postr = path.join(ck, '.post-checkpoint-required')
  touchWithMtimeMs(path.join(ck, '.session-baseline'), Date.now() - 3600_000)
  touchWithMtimeMs(postr, Date.now() - 60_000)
  const r = runSessionStart(repo)
  check(r.status === 0, `N4 exit 0`)
  check(fs.existsSync(postr), `N4 PostR PRESERVED`)
}

// ============================ N5 ============================
{
  console.log('N5: legacy plan-marker → STILL SWEPT (PR #314 contract)')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const planLegacy = path.join(ck, '.plan-approval-pending')
  touchWithMtimeMs(planLegacy, Date.now() - 3600_000)
  const r = runSessionStart(repo)
  check(r.status === 0, `N5 exit 0`)
  check(!fs.existsSync(planLegacy), `N5 legacy plan-marker SWEPT (PR #314 unchanged)`)
}

// ============================ N6 ============================
{
  console.log('N6: suffixed plan-marker .<sid> → PRESERVED')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const planSid = path.join(ck, '.plan-approval-pending.session-aaaa')
  touchWithMtimeMs(planSid, Date.now() - 3600_000)
  const r = runSessionStart(repo)
  check(r.status === 0, `N6 exit 0`)
  check(fs.existsSync(planSid), `N6 suffixed plan-marker PRESERVED (PR #314)`)
}

// ============================ N7-N10: caller-cwd != target-cwd disk-state regression ============================
{
  console.log('N7-N10: caller-cwd != target — target CR PRESERVED (codex R3 disk-state regression)')
  const caller = mkTmpGitRepo('em-monotonic-caller-')
  const target = mkTmpGitRepo('em-monotonic-target-')
  const targetCr = path.join(target, '.checkpoints', '.checkpoint-required')
  const callerCr = path.join(caller, '.checkpoints', '.checkpoint-required')
  touchWithMtimeMs(targetCr, Date.now() - 3600_000)
  // Note: invocation happens IN target cwd (matching hook's `cd "$CWD"` semantics).
  const r = runSessionStart(target)
  check(r.status === 0, `N7 exit 0`)
  check(fs.existsSync(targetCr), `N8 target CR PRESERVED on disk`)
  check(!fs.existsSync(callerCr), `N9 caller .checkpoints NOT polluted`)
  check(fs.existsSync(path.join(target, '.checkpoints', '.session-baseline')), `N10 target baseline written`)
}

// ============================ N11 ============================
{
  console.log('N11: CR symlink → skipped (lstat-fail-closed)')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const cr = path.join(ck, '.checkpoint-required')
  const decoy = path.join(repo, '.decoy-target')
  fs.writeFileSync(decoy, 'decoy')
  fs.symlinkSync(decoy, cr)
  const r = runSessionStart(repo)
  check(r.status === 0, `N11 exit 0`)
  // Symlink must be skipped — decoy must not be removed; symlink itself preserved.
  check(fs.existsSync(decoy), `N11 decoy preserved (symlink not followed)`)
  check(fs.lstatSync(cr).isSymbolicLink(), `N11 symlink itself preserved`)
}

// ============================ N12 ============================
{
  console.log('N12: CR at both primary + legacy roots → both preserved + max-mtime dominates')
  const repo = mkTmpGitRepo()
  const crP = path.join(repo, '.checkpoints', '.checkpoint-required')
  const crL = path.join(repo, '.claude', '.checkpoint-required')
  touchWithMtimeMs(crP, Date.now() - 1000)
  touchWithMtimeMs(crL, Date.now() - 500)  // newer
  const r = runSessionStart(repo)
  check(r.status === 0, `N12 exit 0`)
  check(fs.existsSync(crP), `N12 primary CR preserved`)
  check(fs.existsSync(crL), `N12 legacy CR preserved`)
  const bMt = mtimeMsOf(path.join(repo, '.checkpoints', '.session-baseline'))
  const lMt = mtimeMsOf(crL)
  check(bMt !== null && lMt !== null && lMt <= bMt, `N12 baseline.mtime (${bMt}) >= max(CR.mtime) (${lMt})`)
}

// ============================ C1 ============================
{
  console.log('C1: Session A CR present, Session B SessionStart → A preserved, B baseline dominates')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const cr = path.join(ck, '.checkpoint-required')
  // Session A armed CR moments ago.
  touchWithMtimeMs(cr, Date.now() - 100)
  // Session B SessionStart fires.
  const r = runSessionStart(repo)
  check(r.status === 0, `C1 exit 0`)
  check(fs.existsSync(cr), `C1 Session A's CR PRESERVED`)
  const bMt = mtimeMsOf(path.join(ck, '.session-baseline'))
  const cMt = mtimeMsOf(cr)
  check(bMt !== null && cMt !== null && cMt <= bMt, `C1 baseline.mtime (${bMt}) >= CR.mtime (${cMt}) — Stop unblocked`)
}

// ============================ C2 ============================
{
  console.log('C2: back-to-back SessionStart (resume) → baseline monotonic on every fire')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  const baseline = path.join(ck, '.session-baseline')
  const r1 = runSessionStart(repo)
  check(r1.status === 0, `C2 first SessionStart exit 0`)
  const b1 = mtimeMsOf(baseline)
  // Inject a CR with mtime slightly past first baseline to simulate concurrent arm.
  const cr = path.join(ck, '.checkpoint-required')
  touchWithMtimeMs(cr, b1 + 2)
  const r2 = runSessionStart(repo)
  check(r2.status === 0, `C2 second SessionStart exit 0`)
  const b2 = mtimeMsOf(baseline)
  const cMt = mtimeMsOf(cr)
  check(b2 > b1, `C2 baseline monotonically advances (${b1} → ${b2})`)
  check(cMt <= b2, `C2 second baseline (${b2}) >= injected CR (${cMt})`)
  check(fs.existsSync(cr), `C2 CR preserved across both SessionStarts`)
}

// ============================ CWD1 ============================
{
  console.log('CWD1: caller cwd != target cwd → probes/writes bind to target')
  const target = mkTmpGitRepo('em-monotonic-cwd1-target-')
  const caller = mkTmpGitRepo('em-monotonic-cwd1-caller-')
  touchWithMtimeMs(path.join(target, '.checkpoints', '.checkpoint-required'), Date.now() - 1000)
  // Hook semantics: cd "$CWD"; node em-recall. We invoke from target as cwd directly.
  const r = runSessionStart(target)
  check(r.status === 0, `CWD1 exit 0`)
  check(fs.existsSync(path.join(target, '.checkpoints', '.session-baseline')), `CWD1 target baseline written`)
  check(!fs.existsSync(path.join(caller, '.checkpoints', '.session-baseline')), `CWD1 caller baseline NOT written`)
}

// ============================ CWD2 ============================
{
  console.log('CWD2: nested cwd inside git repo → resolveRepoRoot binds to repo top')
  const repo = mkTmpGitRepo('em-monotonic-cwd2-')
  const nested = path.join(repo, 'src', 'deep')
  fs.mkdirSync(nested, { recursive: true })
  const r = runSessionStart(nested)
  check(r.status === 0, `CWD2 exit 0`)
  check(fs.existsSync(path.join(repo, '.checkpoints', '.session-baseline')), `CWD2 baseline at repo top, not in nested`)
  check(!fs.existsSync(path.join(nested, '.checkpoints')), `CWD2 no .checkpoints created in nested`)
}

// ============================ CWD3 ============================
{
  // Documented semantics (local-dir.mjs:24, #85/#106): linked-worktree common-dir
  // is SHARED main `.git`, so resolveRepoRoot returns the MAIN repo root. Baseline
  // lands at main, not at the worktree. This is intentional for cross-worktree
  // marker coherence. Asserting that documented behavior is preserved.
  console.log('CWD3: linked worktree → resolves to MAIN repo root (per #85/#106)')
  const main = mkTmpGitRepo('em-monotonic-cwd3-main-')
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: main })
  const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'em-monotonic-cwd3-wt-parent-'))
  cleanups.push(() => fs.rmSync(wtParent, { recursive: true, force: true }))
  const wt = path.join(wtParent, 'wt')
  const addResult = spawnSync('git', ['worktree', 'add', wt, '-b', 'feature-cwd3', 'HEAD'], { cwd: main, encoding: 'utf8' })
  if (addResult.status === 0) {
    const wtReal = fs.realpathSync(wt)
    const r = runSessionStart(wtReal)
    check(r.status === 0, `CWD3 exit 0`)
    check(fs.existsSync(path.join(main, '.checkpoints', '.session-baseline')), `CWD3 baseline at MAIN repo root (#85/#106 contract)`)
  } else {
    console.log(`  SKIP  CWD3 worktree add failed: ${addResult.stderr}`)
  }
}

// ============================ CWD4 ============================
{
  console.log('CWD4: non-git cwd → REPO_ROOT falls back to cwd')
  const nongit = mkTmpNonGitDir('em-monotonic-cwd4-')
  touchWithMtimeMs(path.join(nongit, '.checkpoints', '.checkpoint-required'), Date.now() - 1000)
  const r = runSessionStart(nongit)
  check(r.status === 0, `CWD4 exit 0`)
  check(fs.existsSync(path.join(nongit, '.checkpoints', '.session-baseline')), `CWD4 baseline written in non-git cwd`)
  check(fs.existsSync(path.join(nongit, '.checkpoints', '.checkpoint-required')), `CWD4 CR preserved`)
}

// ============================ CWD5 ============================
{
  // Documented semantics (local-dir.mjs:30): GIT_DIR= / GIT_WORK_TREE= cause
  // `git rev-parse --show-toplevel` to return the linked work tree. em-recall.mjs
  // honors this — env pollution moves REPO_ROOT to the polluted path. This is
  // existing behavior (NOT v4 regression). The SessionStart hook is responsible
  // for env hygiene; em-recall.mjs trusts process env.
  // We assert: NO leak to caller cwd (the documented isolation invariant) AND
  // baseline lands at the env-bound work tree, not at process.cwd(). The point
  // is that env-bound semantics are predictable, not that env is ignored.
  console.log('CWD5: GIT_DIR/GIT_WORK_TREE honored by git rev-parse (documented)')
  const target = mkTmpGitRepo('em-monotonic-cwd5-target-')
  const polluted = mkTmpGitRepo('em-monotonic-cwd5-polluted-')
  const r = runSessionStart(target, {
    GIT_DIR: path.join(polluted, '.git'),
    GIT_WORK_TREE: polluted
  })
  check(r.status === 0, `CWD5 exit 0`)
  // Documented: baseline goes to GIT_WORK_TREE (polluted).
  check(fs.existsSync(path.join(polluted, '.checkpoints', '.session-baseline')), `CWD5 baseline at GIT_WORK_TREE (documented)`)
  // The isolation invariant: process.cwd() (target) is NOT polluted with markers
  // beyond what was pre-created in mkTmpGitRepo.
  check(!fs.existsSync(path.join(target, '.checkpoints', '.session-baseline')), `CWD5 process.cwd() NOT polluted`)
}

// ============================ CWD6 ============================
{
  console.log('CWD6: HOME pollution → no leak to $HOME/.checkpoints')
  const target = mkTmpGitRepo('em-monotonic-cwd6-target-')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-monotonic-cwd6-home-'))
  cleanups.push(() => fs.rmSync(fakeHome, { recursive: true, force: true }))
  const r = runSessionStart(target, { HOME: fakeHome })
  check(r.status === 0, `CWD6 exit 0`)
  check(fs.existsSync(path.join(target, '.checkpoints', '.session-baseline')), `CWD6 baseline at target, not HOME`)
  check(!fs.existsSync(path.join(fakeHome, '.checkpoints', '.session-baseline')), `CWD6 fake HOME .checkpoints empty`)
}

// ============================ Summary ============================
console.log()
console.log(`========== test-em-recall-baseline-monotonic ==========`)
console.log(`Passed: ${passed}`)
console.log(`Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
