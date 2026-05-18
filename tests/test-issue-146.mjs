#!/usr/bin/env node
// test-issue-146.mjs — Tests for #146 session-start deadlock fix.
//
// Coverage:
//   L1 — em-recall --gate stop carve-out behavior (subprocess + temp repo)
//        - 1.1 baseline absent → block (back-compat)
//        - 1.2 baseline + all-stale → allow (carve-out fires)
//        - 1.3 baseline + plan-pending newer → block (active plan in flight)
//        - 1.4 baseline + .checkpoint-required newer → block (re-armed mid-session)
//        - 1.5 baseline + .post-checkpoint-required newer → block
//        - 1.6 baseline + plan-pending older (orphan) → allow
//   L2 — em-recall --session-start side effects
//        - 2.1 first run creates .session-baseline
//        - 2.2 second run touches baseline mtime forward
//        - 2.3 stale .plan-approval-pending cleared on second run
//        - 2.4 in-flight plan-pending (mtime > prior baseline) preserved
//        - 2.5 first-ever run leaves plan-pending alone (no prior baseline)
//   L3 — checkpoint-gate.sh block-reason absolute-path (#146 B1)
//        - dispatched via test-checkpoint-gate.sh extension; here we just
//          assert the embedded jq path interpolation works for both pre/post
//
// Defensive ordering per feedback_test_resource_existence_check.md: every
// state assertion is paired with an existence check on the artifact at
// check time. A misordered cleanup must not pass for the wrong reason.

import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const EM_RECALL = path.join(REPO_ROOT, 'scripts', 'em-recall.mjs')

let pass = 0
let fail = 0
const failures = []

function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) {
  fail++; failures.push(`${name}: ${detail}`)
  console.log(`  ✗ ${name}: ${detail}`)
}

function mkRepo(label) {
  // realpathSync canonicalizes through symlinks (e.g. macOS /var → /private/var).
  // Without this, paths derived from mkdtempSync mismatch the gate's
  // resolve_repo_root output (which uses `cd -P`), and the marker_write
  // allowlist's literal `==` compare fails. Real-session agents use the
  // B1 absolute path emitted by the gate (already canonical), so this is
  // a test-isolation concern; production path is unaffected.
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), `em-146-${label}-`))
  const d = fs.realpathSync(raw)
  execSync(`git init -q -b main "${d}"`)
  execSync(`git -C "${d}" config user.email t@t`)
  execSync(`git -C "${d}" config user.name t`)
  fs.writeFileSync(path.join(d, 'README.md'), 'x\n')
  execSync(`git -C "${d}" add . && git -C "${d}" commit -q -m init`)
  fs.mkdirSync(path.join(d, '.checkpoints'), { recursive: true })
  return d
}

// Isolated HOME directory for the whole test run. Pinning HOME ensures
// em-recall reads only the test's local episode store (none seeded), so
// shouldArmBp001Checkpoint() returns false and the arming block doesn't
// re-create .checkpoint-required after our cleanup.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'em-146-home-'))
fs.mkdirSync(path.join(TEST_HOME, '.episodic-memory', 'episodes'), { recursive: true })

function runGateStop(cwd) {
  const r = spawnSync('node', [EM_RECALL, '--gate', 'stop'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: TEST_HOME }
  })
  // Return both stdout and exit status so tests can disambiguate
  // "carve-out fired" (status 0, empty stdout) from "crashed" (non-0).
  return { stdout: r.stdout || '', status: r.status }
}

function runSessionStart(cwd, extraArgs = []) {
  const r = spawnSync('node', [EM_RECALL, '--session-start', '--limit', '1', ...extraArgs], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: TEST_HOME }
  })
  return { stdout: r.stdout || '', status: r.status }
}

function setMtime(p, ms) {
  const t = ms / 1000
  fs.utimesSync(p, t, t)
}

function isBlock(r) {
  const out = typeof r === 'string' ? r : r.stdout
  if (!out) return false
  try {
    const j = JSON.parse(out)
    return j.decision === 'block'
  } catch { return false }
}

function isCarveOutAllow(r) {
  // Strict pass: status 0 AND empty stdout. Distinguishes from a crash
  // (non-zero status) that also produces empty stdout (P2-4 vacuous fix).
  return r.status === 0 && !r.stdout
}

const cleanupDirs = []
process.on('exit', () => {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch {}
})

// ============================================================================
console.log('\n=== L1 — stop-gate carve-out behavior ===')
// ============================================================================

// 1.1 baseline absent → block (back-compat: carve-out only fires when
// SessionStart hook has shipped on this machine).
{
  const d = mkRepo('1-1'); cleanupDirs.push(d)
  fs.writeFileSync(path.join(d, '.checkpoints', '.checkpoint-required'), '')
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('1.1: armed + no baseline → block (back-compat)')
  else bad('1.1: armed + no baseline → block', `got: ${JSON.stringify(r)}`)

  // Defensive: marker still present after gate runs
  if (fs.existsSync(path.join(d, '.checkpoints', '.checkpoint-required')))
    ok('1.1 (defensive): marker still present at check time')
  else bad('1.1 defensive', 'marker disappeared')
}

// 1.2 baseline + all-stale → allow (carve-out fires)
{
  const d = mkRepo('1-2'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  // Make checkpoint-required older
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // baseline now > checkpoint-required
  const r = runGateStop(d)
  if (isCarveOutAllow(r)) ok('1.2: baseline + all-stale → allow (carve-out fires)')
  else bad('1.2: carve-out should fire', `got: ${JSON.stringify(r)}`)
}

// 1.3 baseline + plan-pending newer than baseline → DEFER (rank-1 plan v7
// #178 F1 inverts the pre-existing expectation: active plan-pending in
// flight triggers the new stop-gate exemption — see L5 5.1 for the
// canonical positive test of this behavior). Active plan-pending was
// previously a TASK_SIGNAL that BLOCKED stop-gate; now it DEFERs (because
// otherwise checkpoint-gate + plan-gate + stop-gate form an unrecoverable
// triangle — see scratch/rank1-plan-v7.md §A rationale).
{
  const d = mkRepo('1-3'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // plan-pending NEWER than baseline → active (rank-1 plan v7 exemption fires)
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() + 5_000)
  const r = runGateStop(d)
  if (isCarveOutAllow(r)) ok('1.3 (rank-1 v7): plan-pending active → defer (was: block)')
  else bad('1.3: active plan-pending should defer', `got: ${JSON.stringify(r)}`)
  if (fs.existsSync(planP)) ok('1.3 (defensive): plan-pending preserved')
  else bad('1.3 defensive', 'plan-pending disappeared')
}

// 1.4 .checkpoint-required re-armed mid-session (newer than baseline) → block
{
  const d = mkRepo('1-4'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  const preReq = path.join(claudeDir, '.checkpoint-required')
  fs.writeFileSync(preReq, '')
  setMtime(preReq, Date.now() + 5_000) // mid-session re-arm
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('1.4: checkpoint-required re-armed mid-session → block')
  else bad('1.4: re-arm should block', `got: ${JSON.stringify(r)}`)
}

// 1.5 .post-checkpoint-required newer than baseline → block
{
  const d = mkRepo('1-5'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  const postReq = path.join(claudeDir, '.post-checkpoint-required')
  fs.writeFileSync(postReq, '')
  setMtime(postReq, Date.now() + 5_000)
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('1.5: post-checkpoint-required mid-session → block')
  else bad('1.5: post-required should block', `got: ${JSON.stringify(r)}`)
}

// 1.6 plan-pending OLDER than baseline (orphan) → allow
{
  const d = mkRepo('1-6'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  const r = runGateStop(d)
  if (isCarveOutAllow(r)) ok('1.6: orphan plan-pending (older than baseline) → allow')
  else bad('1.6: orphan should not block', `got: ${JSON.stringify(r)}`)
}

// ============================================================================
console.log('\n=== L2 — em-recall --session-start side effects ===')
// ============================================================================

// 2.1 first run creates .session-baseline
{
  const d = mkRepo('2-1'); cleanupDirs.push(d)
  const baseline = path.join(d, '.checkpoints', '.session-baseline')
  if (fs.existsSync(baseline)) bad('2.1 setup', 'baseline pre-existed')
  const r = runSessionStart(d)
  if (r.status === 0 && fs.existsSync(baseline)) ok('2.1: --session-start creates .session-baseline')
  else bad('2.1: baseline create', `status=${r.status} exists=${fs.existsSync(baseline)}`)
}

// 2.2 second run advances baseline mtime
{
  const d = mkRepo('2-2'); cleanupDirs.push(d)
  runSessionStart(d)
  const baseline = path.join(d, '.checkpoints', '.session-baseline')
  const m1 = fs.statSync(baseline).mtimeMs
  // Force temporal separation
  setMtime(baseline, m1 - 60_000)
  const m1adj = fs.statSync(baseline).mtimeMs
  runSessionStart(d)
  const m2 = fs.statSync(baseline).mtimeMs
  if (m2 > m1adj) ok('2.2: re-run advances baseline mtime')
  else bad('2.2: baseline mtime', `before=${m1adj} after=${m2}`)
}

// 2.3 stale plan-pending cleared on subsequent run (P2-3 stricter)
{
  const d = mkRepo('2-3'); cleanupDirs.push(d)
  runSessionStart(d) // creates baseline
  const baseline = path.join(d, '.checkpoints', '.session-baseline')
  const planP = path.join(d, '.checkpoints', '.plan-approval-pending')
  // Force temporal separation: roll back baseline by 60s so we have
  // unambiguous past/future zones to test against.
  setMtime(baseline, Date.now() - 60_000)
  const baselineM = fs.statSync(baseline).mtimeMs
  // simulate prior session's plan-pending: mtime <= prior baseline
  fs.writeFileSync(planP, '')
  setMtime(planP, baselineM - 5_000) // unambiguously older than baseline
  // second SessionStart: should clear stale plan-pending
  runSessionStart(d)
  if (!fs.existsSync(planP)) ok('2.3: stale plan-pending cleared on next SessionStart')
  else bad('2.3: stale plan-pending NOT cleared', `still exists at ${planP}`)
  // Defensive: baseline was UNAMBIGUOUSLY advanced past prior mtime
  // (P2-3 vacuous-pass fix: must be strictly greater than the rolled-back
  // baselineM, not >= which would pass even if write was skipped).
  const newBaselineM = fs.statSync(baseline).mtimeMs
  if (newBaselineM > baselineM) ok('2.3 (defensive): baseline mtime strictly advanced')
  else bad('2.3 defensive', `baseline did not advance: before=${baselineM} after=${newBaselineM}`)
}

// 2.4 in-flight plan-pending (SUFFIXED, mtime > prior baseline) preserved.
// Post-2026-05-18 policy (codex R1 P1.1 + R2 P1): suffixed forms are NEVER
// swept by SessionStart; lifecycle is em-session-end-prompt.mjs (own-session)
// + operator-cleanup FU (cross-session). Legacy suffix-less `.plan-approval-pending`
// is covered by 2.4b below.
{
  const d = mkRepo('2-4'); cleanupDirs.push(d)
  runSessionStart(d) // baseline at T0
  const baseline = path.join(d, '.checkpoints', '.session-baseline')
  const planP = path.join(d, '.checkpoints', '.plan-approval-pending.session-A')
  const baselineM = fs.statSync(baseline).mtimeMs
  fs.writeFileSync(planP, '')
  setMtime(planP, baselineM + 5_000) // newer than prior baseline
  // second SessionStart: suffixed plan-pending should NOT be cleared (in-flight)
  runSessionStart(d, ['--session-id', 'session-A'])
  if (fs.existsSync(planP)) ok('2.4: in-flight SUFFIXED plan-pending preserved across SessionStart')
  else bad('2.4: in-flight suffixed plan-pending wrongly cleared', 'suffixed forms must never be swept by SessionStart')
}

// 2.4b NEW: in-flight LEGACY-SUFFIX-LESS plan-pending is ALWAYS swept.
// Codex R1 P1.4 + R2 P1: no current code path writes the suffix-less form;
// any sighting is orphan. Unconditional sweep above the baseline guard.
{
  const d = mkRepo('2-4b'); cleanupDirs.push(d)
  runSessionStart(d)
  const baseline = path.join(d, '.checkpoints', '.session-baseline')
  const planP = path.join(d, '.checkpoints', '.plan-approval-pending')
  const baselineM = fs.statSync(baseline).mtimeMs
  fs.writeFileSync(planP, '')
  setMtime(planP, baselineM + 5_000) // newer than prior baseline (the 2026-05-18 bug class)
  runSessionStart(d)
  if (!fs.existsSync(planP)) ok('2.4b: in-flight LEGACY plan-pending swept (codex R1 P1.4 + R2 P1)')
  else bad('2.4b: legacy plan-pending wrongly preserved', 'legacy form must always be swept')
}

// 2.5 first-ever run with leftover SUFFIXED plan-pending leaves it alone.
// Post-fix: suffixed forms never swept by SessionStart.
{
  const d = mkRepo('2-5'); cleanupDirs.push(d)
  const planP = path.join(d, '.checkpoints', '.plan-approval-pending.session-A')
  fs.writeFileSync(planP, '')
  // No prior baseline exists.
  runSessionStart(d, ['--session-id', 'session-A'])
  if (fs.existsSync(planP)) ok('2.5: first-ever SessionStart leaves SUFFIXED plan-pending alone')
  else bad('2.5: first-ever wrongly cleared suffixed plan-pending', 'suffixed forms must never be swept by SessionStart')
}

// 2.5b NEW: first-ever run with leftover LEGACY plan-pending is ALWAYS swept.
// Codex R1 P1.4 + 2026-05-18 orphan-deadlock fix: the unconditional legacy
// plan-marker sweep runs regardless of baseline state, so legacy is reaped
// even when no prior baseline exists.
{
  const d = mkRepo('2-5b'); cleanupDirs.push(d)
  const planP = path.join(d, '.checkpoints', '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  // No prior baseline exists.
  runSessionStart(d)
  if (!fs.existsSync(planP)) ok('2.5b: first-ever SessionStart sweeps LEGACY plan-pending even without baseline (codex R1 P1.4)')
  else bad('2.5b: legacy plan-pending wrongly preserved on first-ever', 'unconditional sweep must fire without baseline')
}

// ============================================================================
console.log('\n=== L3 — same-class extension, symlink defense, flag combo ===')
// ============================================================================

// 3.1 SessionStart clears ALL 3 stale task-signal markers (P1-2 fix).
// Pre-fix: only .plan-approval-pending was cleared. Post-fix: all 3
// (.checkpoint-required, .post-checkpoint-required, .plan-approval-pending).
// Closes the cross-gate fractal P1-3 because write-gate then doesn't see
// stale .checkpoint-required.
{
  const d = mkRepo('3-1'); cleanupDirs.push(d)
  runSessionStart(d) // creates baseline
  const baseline = path.join(d, '.checkpoints', '.session-baseline')
  // Roll back baseline so we have a clear "older than" zone
  setMtime(baseline, Date.now() - 60_000)
  const baselineM = fs.statSync(baseline).mtimeMs
  // Plant all 3 markers older than baseline
  const planLegacy = path.join(d, '.checkpoints', '.plan-approval-pending')
  const checkReq = path.join(d, '.checkpoints', '.checkpoint-required')
  const postReq = path.join(d, '.checkpoints', '.post-checkpoint-required')
  for (const m of [planLegacy, checkReq, postReq]) {
    fs.writeFileSync(m, '')
    setMtime(m, baselineM - 5_000)
  }
  runSessionStart(d)
  // Post-2026-05-18 contract (codex R3 P1):
  //   - Legacy plan-marker SWEPT (PR #314 unchanged).
  //   - Checkpoint markers PRESERVED (M5 retime contract — Stop unblocked
  //     via baseline mtime refresh, writer-gate intact for concurrent live
  //     sessions). Replaces prior baseline-mtime-keyed sweep that created
  //     a rm→rearm transient unarmed window (codex R2 P1).
  const legacyCleared = !fs.existsSync(planLegacy)
  const crPreserved = fs.existsSync(checkReq)
  const postRPreserved = fs.existsSync(postReq)
  if (legacyCleared && crPreserved && postRPreserved) {
    ok('3.1: SessionStart sweeps legacy plan-marker; preserves CR/PostR (M5 retime)')
  } else {
    bad('3.1: M5 retime contract violated',
      `planLegacy_cleared=${legacyCleared} CR_preserved=${crPreserved} PostR_preserved=${postRPreserved}`)
  }
  // Carve-out invariant: new baseline.mtime > preserved-marker mtimes.
  const newBaselineMs = fs.lstatSync(baseline).mtimeMs
  const crMs = fs.lstatSync(checkReq).mtimeMs
  const postRMs = fs.lstatSync(postReq).mtimeMs
  if (newBaselineMs >= crMs && newBaselineMs >= postRMs) {
    ok('3.1 (carve-out): baseline.mtime dominates preserved markers (Stop unblocked)')
  } else {
    bad('3.1 carve-out invariant', `baseline=${newBaselineMs} CR=${crMs} PostR=${postRMs}`)
  }
}

// 3.2 SessionStart preserves in-flight NON-plan-marker class members.
// Post-2026-05-18 fix: plan-marker class has a different lifecycle (codex
// R1 + R2) — legacy suffix-less always swept, suffixed never swept by
// SessionStart. Other 2 task-signal markers (checkpoint-required +
// post-checkpoint-required) retain the in-flight-preserve contract.
{
  const d = mkRepo('3-2'); cleanupDirs.push(d)
  runSessionStart(d)
  const baseline = path.join(d, '.checkpoints', '.session-baseline')
  const baselineM = fs.statSync(baseline).mtimeMs
  const nonPlanMarkers = [
    '.checkpoint-required',
    '.post-checkpoint-required'
  ].map(m => path.join(d, '.checkpoints', m))
  for (const m of nonPlanMarkers) {
    fs.writeFileSync(m, '')
    setMtime(m, baselineM + 5_000) // in-flight (mid-session)
  }
  // Plus an in-flight LEGACY plan-pending — should be swept regardless
  const planLegacy = path.join(d, '.checkpoints', '.plan-approval-pending')
  fs.writeFileSync(planLegacy, '')
  setMtime(planLegacy, baselineM + 5_000)
  // Plus an in-flight SUFFIXED plan-pending — should be preserved
  const planSuffixed = path.join(d, '.checkpoints', '.plan-approval-pending.session-A')
  fs.writeFileSync(planSuffixed, '')
  setMtime(planSuffixed, baselineM + 5_000)

  runSessionStart(d, ['--session-id', 'session-A'])

  const nonPlanPreserved = nonPlanMarkers.map(m => fs.existsSync(m))
  if (nonPlanPreserved.every(Boolean)) ok('3.2: SessionStart preserves in-flight non-plan-marker class members')
  else bad('3.2: non-plan-marker in-flight wrongly cleared',
    nonPlanMarkers.map((m, i) => `${path.basename(m)}=${nonPlanPreserved[i] ? 'present' : 'CLEARED'}`).join(' '))

  if (!fs.existsSync(planLegacy)) ok('3.2: in-flight LEGACY plan-pending swept (different lifecycle — codex R1 P1.4)')
  else bad('3.2: legacy plan-pending wrongly preserved', 'must always be swept')

  if (fs.existsSync(planSuffixed)) ok('3.2: in-flight SUFFIXED plan-pending preserved (different lifecycle — codex R1 P1.1)')
  else bad('3.2: suffixed plan-pending wrongly swept', 'must never be swept by SessionStart')
}

// 3.3 Symlink defense (P2-2): a symlinked baseline does not enable the
// carve-out. Threat-model: honest-agent self-discipline; defense against
// accidental symlinks (e.g. workspace setups), not adversarial.
{
  const d = mkRepo('3-3'); cleanupDirs.push(d)
  fs.writeFileSync(path.join(d, '.checkpoints', '.checkpoint-required'), '')
  // Create a real file elsewhere with very-old mtime, then symlink
  // .session-baseline to it.
  const realFile = path.join(d, '.checkpoints', 'real-old-file')
  fs.writeFileSync(realFile, '')
  setMtime(realFile, Date.now() - 365 * 24 * 60 * 60 * 1000) // 1 year ago
  fs.symlinkSync(realFile, path.join(d, '.checkpoints', '.session-baseline'))
  // Without symlink defense, lstat(real) would say baseline is older than
  // markers → carve-out fires. With defense: symlink rejected → carve-out
  // does not fire → block.
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('3.3: symlinked baseline rejected by carve-out')
  else bad('3.3: symlink should defeat carve-out', `got: ${JSON.stringify(r)}`)
}

// 3.3b Same-class symlink defense for MARKERS (Codex round-1 P2 fix,
// episode ...845f). Pre-fix: marker symlinks were `continue`d (treated
// as absent), so a symlinked .post-checkpoint-required newer than baseline
// would let the carve-out fire incorrectly. Post-fix: any marker symlink
// fails the carve-out closed, symmetric with baseline.
{
  const d = mkRepo('3-3b-post'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // Create a real "newer" file then symlink .post-checkpoint-required to it
  const realPost = path.join(claudeDir, 'real-post-marker')
  fs.writeFileSync(realPost, '')
  setMtime(realPost, Date.now() + 5_000) // newer than baseline
  fs.symlinkSync(realPost, path.join(claudeDir, '.post-checkpoint-required'))
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('3.3b-post: symlinked .post-checkpoint-required rejects carve-out (same-class)')
  else bad('3.3b-post: marker symlink should defeat carve-out', `got: ${JSON.stringify(r)}`)
}
{
  const d = mkRepo('3-3b-checkpoint'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // Symlinked .checkpoint-required newer than baseline. The gate-stop
  // path requires preReq to exist (real or symlink) before evaluating
  // carve-out — a symlinked preReq passes existsSync but should fail
  // the carve-out closed.
  const realCp = path.join(claudeDir, 'real-cp-marker')
  fs.writeFileSync(realCp, '')
  setMtime(realCp, Date.now() + 5_000)
  fs.symlinkSync(realCp, path.join(claudeDir, '.checkpoint-required'))
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('3.3b-cp: symlinked .checkpoint-required rejects carve-out (same-class)')
  else bad('3.3b-cp: marker symlink should defeat carve-out', `got: ${JSON.stringify(r)}`)
}
{
  const d = mkRepo('3-3b-plan'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  const realPlan = path.join(claudeDir, 'real-plan-marker')
  fs.writeFileSync(realPlan, '')
  setMtime(realPlan, Date.now() + 5_000)
  fs.symlinkSync(realPlan, path.join(claudeDir, '.plan-approval-pending'))
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('3.3b-plan: symlinked .plan-approval-pending rejects carve-out (same-class)')
  else bad('3.3b-plan: plan-pending symlink should defeat carve-out', `got: ${JSON.stringify(r)}`)
}

// 3.4 --session-start + --gate stop combo rejected at CLI parse (P2-5).
// Prevents the silent failure mode where --gate stop's early exit skips
// the SessionStart-only baseline write.
{
  const d = mkRepo('3-4'); cleanupDirs.push(d)
  const r = spawnSync('node', [EM_RECALL, '--session-start', '--gate', 'stop'], {
    cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  })
  if (r.status === 1 && r.stdout.includes('cannot be combined')) {
    ok('3.4: --session-start + --gate combo rejected at CLI parse')
  } else {
    bad('3.4: combo reject', `status=${r.status} stdout=${r.stdout}`)
  }
}

// 3.5 stop-gate block reason still parses cleanly.
{
  const d = mkRepo('3-5'); cleanupDirs.push(d)
  fs.writeFileSync(path.join(d, '.checkpoints', '.checkpoint-required'), '')
  const r = runGateStop(d)
  let reason = null
  try { reason = JSON.parse(r.stdout).reason } catch {}
  if (reason && reason.includes('post-checkpoint-done')) {
    ok('3.5: stop-gate block reason names .post-checkpoint-done marker')
  } else {
    bad('3.5: stop-gate reason', `got: ${JSON.stringify(r)}`)
  }
}

// ============================================================================
console.log('\n=== L4 — Runtime-integration E2E (hook chain via real shell) ===')
// ============================================================================
// Exercises the actual hook scripts (em-recall-sessionstart.sh, stop-gate.sh,
// checkpoint-gate.sh) the way Claude Code invokes them — piping JSON
// through bash. This is the "real flow" that subprocess unit tests don't
// cover. Sandbox: fake HOME with em-recall + lib copied in, fake project
// with empty .episodic-memory/. Closes the BP-1 step 8 gap flagged in
// violation episode 20260505-123354-...-0088.

const HOOK_DIR = path.join(REPO_ROOT, 'hooks')
const SESSIONSTART_HOOK = path.join(HOOK_DIR, 'em-recall-sessionstart.sh')
const STOP_HOOK = path.join(HOOK_DIR, 'stop-gate.sh')
const CHECKPOINT_HOOK = path.join(HOOK_DIR, 'checkpoint-gate.sh')

function mkE2EHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'em-146-e2e-home-'))
  cleanupDirs.push(home)
  // Fake canonical install path expected by stop-gate.sh:58
  const scripts = path.join(home, '.episodic-memory', 'scripts')
  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true })
  fs.copyFileSync(EM_RECALL, path.join(scripts, 'em-recall.mjs'))
  // em-recall imports scripts/lib/{local-dir,marker-paths}.mjs at module load.
  // .checkpoints/ migration: marker-paths.mjs ships alongside local-dir.mjs;
  // omit it and em-recall fails to load (same fix as test-stop-gate.sh's
  // mk_fake_home).
  // 2026-05-18 concurrent-session fix: em-recall now imports session-id.mjs.
  for (const lib of ['local-dir.mjs', 'marker-paths.mjs', 'stop-gate-helpers.mjs', 'session-id.mjs']) {
    const libSrc = path.join(REPO_ROOT, 'scripts', 'lib', lib)
    fs.copyFileSync(libSrc, path.join(scripts, 'lib', lib))
  }
  // Empty episodes dir so shouldArmBp001Checkpoint returns false
  fs.mkdirSync(path.join(home, '.episodic-memory', 'episodes'), { recursive: true })
  return home
}

function runHook(hookPath, inputJson, cwd, home) {
  const r = spawnSync('bash', [hookPath], {
    input: inputJson,
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status }
}

// 4.1 Full deadlock-scenario roundtrip — closes BP-1 step 8 gap.
//
// Reproduces the original #146 deadlock chain via real hook invocations
// and verifies the fix:
//   (a) SessionStart hook runs → .session-baseline written
//   (b) Rule-9-only turn ends → Stop hook fires → carve-out allows stop
//   (c) Mid-session arm of post-required → Stop hook blocks
//   (d) Next SessionStart → stale markers cleared, baseline advanced
{
  const d = mkRepo('4-1'); cleanupDirs.push(d)
  const home = mkE2EHome()
  const claudeDir = path.join(d, '.checkpoints')
  const baseline = path.join(claudeDir, '.session-baseline')
  const preReq = path.join(claudeDir, '.checkpoint-required')
  const postReq = path.join(claudeDir, '.post-checkpoint-required')

  // Plant a stale .checkpoint-required from a "prior session" — this is
  // exactly the state that caused the original deadlock.
  fs.writeFileSync(preReq, '')
  setMtime(preReq, Date.now() - 60_000)

  // (a) SessionStart hook
  const startInput = JSON.stringify({ cwd: d, session_id: 'e2e-4-1' })
  const startR = runHook(SESSIONSTART_HOOK, startInput, d, home)
  if (startR.status === 0 && fs.existsSync(baseline)) {
    ok('4.1a: SessionStart hook → .session-baseline written')
  } else {
    bad('4.1a: SessionStart hook', `status=${startR.status} stderr=${startR.stderr} baseline_exists=${fs.existsSync(baseline)}`)
  }
  // Defensive: stale preReq still exists (we planted it) — proves we're
  // testing the carve-out path, not a vacuous no-marker path.
  if (fs.existsSync(preReq)) ok('4.1a (defensive): stale preReq still present after SessionStart')
  else bad('4.1a defensive', 'preReq disappeared (would make next assertions vacuous)')

  // (b) Stop hook for Rule-9-only turn — should ALLOW (carve-out fires)
  const stopInput = JSON.stringify({ cwd: d, session_id: 'e2e-4-1', stop_hook_active: false })
  const stopR1 = runHook(STOP_HOOK, stopInput, d, home)
  if (stopR1.status === 0 && !stopR1.stdout) {
    ok('4.1b: Stop hook on no-task-signal turn → empty stdout (carve-out allows stop)')
  } else {
    bad('4.1b: carve-out should allow stop', `status=${stopR1.status} stdout=${stopR1.stdout}`)
  }

  // (c) Simulate a real mid-session task signal — touch postReq with
  // mtime > baseline, then re-fire Stop hook → should BLOCK
  fs.writeFileSync(postReq, '')
  setMtime(postReq, Date.now() + 5_000)
  const stopR2 = runHook(STOP_HOOK, stopInput, d, home)
  if (stopR2.status === 0 && isBlock(stopR2)) {
    ok('4.1c: Stop hook with mid-session signal → block (carve-out denied)')
  } else {
    bad('4.1c: real-task signal should block', `status=${stopR2.status} stdout=${stopR2.stdout}`)
  }
  // Defensive: postReq still present at decision time
  if (fs.existsSync(postReq)) ok('4.1c (defensive): postReq still present at decision time')
  else bad('4.1c defensive', 'postReq disappeared')

  // (d) Next SessionStart — post-2026-05-18 fix (codex R3 P1): SessionStart
  // does NOT sweep .post-checkpoint-required; it advances baseline so the
  // carve-out invariant holds. postReq is PRESERVED but Stop becomes
  // unblocked because new baseline.mtime > postReq.mtime.
  const rolledBaseline = Date.now() - 60_000
  setMtime(baseline, rolledBaseline)
  const rolledBaselineM = fs.statSync(baseline).mtimeMs
  setMtime(postReq, rolledBaselineM - 5_000) // strictly older than rolled baseline
  const startR2 = runHook(SESSIONSTART_HOOK, startInput, d, home)
  if (startR2.status === 0 && fs.existsSync(postReq)) {
    ok('4.1d: SessionStart PRESERVES postReq (M5 retime contract)')
  } else {
    bad('4.1d: postReq should be preserved', `status=${startR2.status} postReq_exists=${fs.existsSync(postReq)}`)
  }
  const newBaselineM = fs.statSync(baseline).mtimeMs
  const postReqM = fs.statSync(postReq).mtimeMs
  if (newBaselineM > rolledBaselineM) ok('4.1d (defensive): baseline mtime strictly advanced')
  else bad('4.1d defensive', `baseline did not advance: rolled=${rolledBaselineM} new=${newBaselineM}`)
  if (newBaselineM >= postReqM) ok('4.1d (carve-out): new baseline.mtime dominates postReq.mtime')
  else bad('4.1d carve-out', `baseline=${newBaselineM} < postReq=${postReqM}`)
}

// 4.2 Checkpoint-gate B1 absolute-path emission via real hook.
//
// Pipes a synthetic Edit tool_input through checkpoint-gate.sh and asserts
// the block reason embeds the absolute marker path (B1 fix). Pre-#146 the
// reason had a relative path and the agent in worktree-cwd resolved it
// against the wrong root, causing the deadlock.
{
  const d = mkRepo('4-2'); cleanupDirs.push(d)
  const home = mkE2EHome()
  const preReq = path.join(d, '.checkpoints', '.checkpoint-required')
  const preDone = path.join(d, '.checkpoints', '.pre-checkpoint-done')
  fs.writeFileSync(preReq, '') // armed
  // pre-done absent (empty) → gate must block
  const editInput = JSON.stringify({
    tool_name: 'Edit',
    cwd: d,
    tool_input: {
      file_path: path.join(d, 'README.md'),
      old_string: 'x',
      new_string: 'y'
    }
  })
  const r = runHook(CHECKPOINT_HOOK, editInput, d, home)
  if (r.status === 0 && isBlock(r) && r.stdout.includes(preDone)) {
    ok('4.2: checkpoint-gate Edit → block reason embeds absolute pre-done path (B1)')
  } else {
    bad('4.2: B1 absolute path via real hook',
      `status=${r.status} stdout=${r.stdout} expected_path=${preDone}`)
  }
  // Defensive: trigger marker still present at check time
  if (fs.existsSync(preReq)) ok('4.2 (defensive): trigger marker still present at check time')
  else bad('4.2 defensive', 'preReq disappeared')
}

// 4.3 marker_write deadlock-prevention path via real hook.
//
// Pipes a Write to .pre-checkpoint-done (the marker itself) through
// checkpoint-gate.sh — when preReq is armed and preDone empty, the
// classifier should label it marker_write and the gate should ALLOW.
// Without this allowlist the agent can't satisfy the gate's precondition
// (chicken-and-egg).
{
  const d = mkRepo('4-3'); cleanupDirs.push(d)
  const home = mkE2EHome()
  const preReq = path.join(d, '.checkpoints', '.checkpoint-required')
  const preDone = path.join(d, '.checkpoints', '.pre-checkpoint-done')
  fs.writeFileSync(preReq, '')
  // preDone absent → gate's marker_write allowlist condition met
  const writeInput = JSON.stringify({
    tool_name: 'Write',
    cwd: d,
    tool_input: {
      file_path: preDone,
      content: 'pre-checkpoint block'
    }
  })
  const r = runHook(CHECKPOINT_HOOK, writeInput, d, home)
  if (r.status === 0 && !r.stdout) {
    ok('4.3: Write to .pre-checkpoint-done allowed (marker_write allowlist)')
  } else {
    bad('4.3: marker_write should be allowed',
      `status=${r.status} stdout=${r.stdout}`)
  }
}

// ============================================================================
console.log('\n=== L5 — Active-plan exemption (#178 F1, rank-1 plan v7) ===')
// ============================================================================
// Codex-reviewed 7 rounds; final ACCEPT-with-FU at episode ...e19a.
// Exemption fires iff plan-pending active (mtime > baseline) at either
// root, with strict-lstat fail-closed (codex F11). Symlink + ENOTDIR
// fail closed (codex F17). 5.11/5.12 use ENOTDIR via .checkpoints
// being a regular file — deterministic and platform-portable.

function isCarveOutAllow_v5(r) {
  // Same shape as isCarveOutAllow (above); aliased for L5 readability.
  return r.status === 0 && !r.stdout
}

// 5.1 plan-pending active at primary (mtime > baseline) → defer
{
  const d = mkRepo('5-1'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  setMtime(path.join(claudeDir, '.session-baseline'), Date.now() - 30_000)
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() + 5_000) // active mid-session
  const r = runGateStop(d)
  if (isCarveOutAllow_v5(r)) ok('5.1: plan-pending active at primary → defer')
  else bad('5.1', `got: ${JSON.stringify(r)}`)
}

// 5.2 plan-pending symlink at primary → fail closed
{
  const d = mkRepo('5-2'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  setMtime(path.join(claudeDir, '.session-baseline'), Date.now() - 30_000)
  const real = path.join(claudeDir, 'real-plan-marker')
  fs.writeFileSync(real, '')
  setMtime(real, Date.now() + 5_000)
  fs.symlinkSync(real, path.join(claudeDir, '.plan-approval-pending'))
  const r = runGateStop(d)
  // Symlink → exemption ineligible; carve-out ALSO fails closed on symlink
  // markers (existing #146 P2 symmetry). Net: block.
  if (isBlock(r) && r.status === 0) ok('5.2: symlinked plan-pending → exemption ineligible → block')
  else bad('5.2', `got: ${JSON.stringify(r)}`)
}

// 5.3 plan-pending orphan (mtime ≤ baseline) → exemption skipped; existing
// carve-out fires when ALL markers stale → defer.
{
  const d = mkRepo('5-3'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 120_000)
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() - 90_000) // older than baseline
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // baseline mtime now (newest) → carve-out fires for stale plan-pending
  if (isCarveOutAllow_v5(runGateStop(d))) ok('5.3: orphan plan-pending → exemption skipped, carve-out fires → defer')
  else bad('5.3', 'expected carve-out defer for fully orphan markers')
}

// 5.4 plan-pending orphan + .checkpoint-required ACTIVE → block. Exemption
// doesn't rescue when other carve-out signals fail.
{
  const d = mkRepo('5-4'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  setMtime(path.join(claudeDir, '.session-baseline'), Date.now() - 30_000)
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() - 90_000) // orphan
  const preReq = path.join(claudeDir, '.checkpoint-required')
  fs.writeFileSync(preReq, '')
  setMtime(preReq, Date.now() + 5_000) // re-armed mid-session
  if (isBlock(runGateStop(d))) ok('5.4: orphan plan-pending + active checkpoint-required → block (exemption skipped)')
  else bad('5.4', 'expected block when checkpoint-required is mid-session active')
}

// 5.5 plan-pending active at LEGACY root only → defer (dual-root happy path)
{
  const d = mkRepo('5-5'); cleanupDirs.push(d)
  const primary = path.join(d, '.checkpoints')
  const legacy = path.join(d, '.claude')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(primary, '.checkpoint-required'), '')
  setMtime(path.join(primary, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(primary, '.session-baseline'), '')
  setMtime(path.join(primary, '.session-baseline'), Date.now() - 30_000)
  // plan-pending lives at LEGACY only
  const planP = path.join(legacy, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() + 5_000)
  if (isCarveOutAllow_v5(runGateStop(d))) ok('5.5: active plan-pending at LEGACY only → defer (dual-root)')
  else bad('5.5', 'expected dual-root exemption to fire for legacy-only active plan-pending')
}

// 5.6 baseline absent at both roots → exemption skipped → block (preReq + empty postDone path).
{
  const d = mkRepo('5-6'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  // NO baseline at either root
  if (isBlock(runGateStop(d))) ok('5.6: baseline absent → exemption ineligible → block')
  else bad('5.6', 'expected block when no baseline anywhere')
}

// 5.7 NEGATIVE class — no plan-pending anywhere → exemption ineligible
// (anyExisted=false). Tests the negative class of the eligibility predicate;
// the strict-lstat-fails-with-non-ENOENT branch is covered by 5.11/5.12 +
// U4 in tests/test-em-strict-lstat.mjs (code-review C2 renaming).
{
  const d = mkRepo('5-7'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // No plan-pending — exemption ineligible. Carve-out evaluates;
  // checkpoint-required is stale, baseline is current → carve-out fires → defer
  if (isCarveOutAllow_v5(runGateStop(d))) ok('5.7 (C2 negative class): no plan-pending → exemption ineligible, carve-out defers')
  else bad('5.7', 'expected carve-out defer when no plan-pending')
}

// 5.8 primary stale + legacy active → defer (codex F8 dual-root active)
{
  const d = mkRepo('5-8'); cleanupDirs.push(d)
  const primary = path.join(d, '.checkpoints')
  const legacy = path.join(d, '.claude')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(primary, '.checkpoint-required'), '')
  setMtime(path.join(primary, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(primary, '.session-baseline'), '')
  setMtime(path.join(primary, '.session-baseline'), Date.now() - 30_000)
  // PRIMARY plan-pending: stale
  const primaryPlan = path.join(primary, '.plan-approval-pending')
  fs.writeFileSync(primaryPlan, '')
  setMtime(primaryPlan, Date.now() - 90_000)
  // LEGACY plan-pending: active
  const legacyPlan = path.join(legacy, '.plan-approval-pending')
  fs.writeFileSync(legacyPlan, '')
  setMtime(legacyPlan, Date.now() + 5_000)
  if (isCarveOutAllow_v5(runGateStop(d))) ok('5.8 (F8): primary stale + legacy active → defer (max-across-roots)')
  else bad('5.8', 'expected dual-root exemption to take MAX mtime; should fire')
}

// 5.9 primary symlink + legacy active → BLOCK (codex F8 symlink-at-either fails closed)
{
  const d = mkRepo('5-9'); cleanupDirs.push(d)
  const primary = path.join(d, '.checkpoints')
  const legacy = path.join(d, '.claude')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(primary, '.checkpoint-required'), '')
  setMtime(path.join(primary, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(primary, '.session-baseline'), '')
  setMtime(path.join(primary, '.session-baseline'), Date.now() - 30_000)
  // PRIMARY plan-pending: symlink
  const real = path.join(primary, 'real-plan-marker')
  fs.writeFileSync(real, '')
  fs.symlinkSync(real, path.join(primary, '.plan-approval-pending'))
  // LEGACY plan-pending: active
  const legacyPlan = path.join(legacy, '.plan-approval-pending')
  fs.writeFileSync(legacyPlan, '')
  setMtime(legacyPlan, Date.now() + 5_000)
  if (isBlock(runGateStop(d))) ok('5.9 (F8): primary symlink + legacy active → block (fail-closed)')
  else bad('5.9', 'expected block when ANY root has symlink')
}

// 5.10 both roots have active plan-pending → defer (sanity)
{
  const d = mkRepo('5-10'); cleanupDirs.push(d)
  const primary = path.join(d, '.checkpoints')
  const legacy = path.join(d, '.claude')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(primary, '.checkpoint-required'), '')
  setMtime(path.join(primary, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(primary, '.session-baseline'), '')
  setMtime(path.join(primary, '.session-baseline'), Date.now() - 30_000)
  fs.writeFileSync(path.join(primary, '.plan-approval-pending'), '')
  setMtime(path.join(primary, '.plan-approval-pending'), Date.now() + 5_000)
  fs.writeFileSync(path.join(legacy, '.plan-approval-pending'), '')
  setMtime(path.join(legacy, '.plan-approval-pending'), Date.now() + 5_000)
  if (isCarveOutAllow_v5(runGateStop(d))) ok('5.10: both roots active → defer')
  else bad('5.10', 'expected defer when both roots have active plan-pending')
}

// 5.11 ENOTDIR on primary marker dir → exemption ineligible → BLOCK (codex F17)
// Setup: primary .checkpoints is a REGULAR FILE (not dir), legacy is real
// directory with active plan-pending + baseline + checkpoint-required. The
// strict helper detects hadOtherError on primary side → exemption ineligible.
{
  const d = mkRepo('5-11'); cleanupDirs.push(d)
  // PRIMARY: regular file at .checkpoints (NOT a dir) → ENOTDIR on child lstat
  // mkRepo() creates .checkpoints as a directory — rm it first before
  // writing the regular file in its place.
  fs.rmSync(path.join(d, '.checkpoints'), { recursive: true, force: true })
  fs.writeFileSync(path.join(d, '.checkpoints'), 'not-a-dir')
  // LEGACY: full setup
  const legacy = path.join(d, '.claude')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, '.checkpoint-required'), '')
  setMtime(path.join(legacy, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(legacy, '.session-baseline'), '')
  setMtime(path.join(legacy, '.session-baseline'), Date.now() - 30_000)
  fs.writeFileSync(path.join(legacy, '.plan-approval-pending'), '')
  setMtime(path.join(legacy, '.plan-approval-pending'), Date.now() + 5_000)
  // Defensive: confirm primary .checkpoints is a regular file at check time
  const st = fs.lstatSync(path.join(d, '.checkpoints'))
  if (!st.isFile()) {
    bad('5.11 setup', `expected .checkpoints to be regular file; got mode ${st.mode.toString(8)}`)
  } else if (isBlock(runGateStop(d))) {
    ok('5.11 (F17): ENOTDIR primary + active legacy → exemption ineligible → block')
  } else {
    bad('5.11', 'expected block when primary marker dir is unreadable (ENOTDIR)')
  }
}

// 5.13 (code-review B1): active plan-pending + active checkpoint-required
// → exemption fires → defer. Documents the intentional behavior change in
// rank-1 v7: the new exemption supersedes the carve-out's TASK_SIGNAL_MARKERS
// check when plan-pending is in flight, because the agent is in the plan-
// review phase (no writes happening), and the triangle deadlock between
// checkpoint-gate + plan-gate + stop-gate would otherwise be unrecoverable.
// Plan-gate provides the writer-side defense; stop-gate stepping aside is
// the deadlock-break.
{
  const d = mkRepo('5-13'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.checkpoints')
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  setMtime(path.join(claudeDir, '.session-baseline'), Date.now() - 30_000)
  // checkpoint-required ACTIVE (mid-session re-arm)
  const preReq = path.join(claudeDir, '.checkpoint-required')
  fs.writeFileSync(preReq, '')
  setMtime(preReq, Date.now() + 5_000)
  // plan-pending ACTIVE
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() + 5_000)
  // Pre-fix: carve-out would block (active TASK_SIGNAL_MARKERS).
  // Post-fix: exemption fires first → defer (intentional).
  if (isCarveOutAllow_v5(runGateStop(d))) ok('5.13 (B1): active plan-pending + active checkpoint-required → defer (exemption supersedes carve-out)')
  else bad('5.13', 'expected exemption to fire and defer even with another active TASK_SIGNAL marker')
}

// 5.12 ENOTDIR on primary baseline (.checkpoints is a regular file) +
// legacy baseline ok + plan-pending active → BLOCK on baseline side
// (same fail-closed semantic for baseline computation).
{
  const d = mkRepo('5-12'); cleanupDirs.push(d)
  // Same shape as 5.11: primary `.checkpoints` is regular file. This also
  // affects baseline lookup at primary. Combined with the marker side
  // failing, both branches of the strict helper see hadOtherError=true.
  // This test documents that the strict semantic applies symmetrically.
  fs.rmSync(path.join(d, '.checkpoints'), { recursive: true, force: true })
  fs.writeFileSync(path.join(d, '.checkpoints'), 'not-a-dir')
  const legacy = path.join(d, '.claude')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, '.checkpoint-required'), '')
  setMtime(path.join(legacy, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(legacy, '.session-baseline'), '')
  setMtime(path.join(legacy, '.session-baseline'), Date.now() - 30_000)
  fs.writeFileSync(path.join(legacy, '.plan-approval-pending'), '')
  setMtime(path.join(legacy, '.plan-approval-pending'), Date.now() + 5_000)
  if (isBlock(runGateStop(d))) {
    ok('5.12 (F17): ENOTDIR primary baseline + legacy active → block (fail-closed on baseline)')
  } else {
    bad('5.12', 'expected block when primary baseline path is unreadable')
  }
}

// ============================================================================
console.log('\n==================================================')
console.log(`Results: ${pass} passed, ${fail} failed`)
console.log('==================================================')
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
process.exit(0)
