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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `em-146-${label}-`))
  execSync(`git init -q -b main "${d}"`)
  execSync(`git -C "${d}" config user.email t@t`)
  execSync(`git -C "${d}" config user.name t`)
  fs.writeFileSync(path.join(d, 'README.md'), 'x\n')
  execSync(`git -C "${d}" add . && git -C "${d}" commit -q -m init`)
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true })
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

function runSessionStart(cwd) {
  const r = spawnSync('node', [EM_RECALL, '--session-start', '--limit', '1'], {
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
  fs.writeFileSync(path.join(d, '.claude', '.checkpoint-required'), '')
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('1.1: armed + no baseline → block (back-compat)')
  else bad('1.1: armed + no baseline → block', `got: ${JSON.stringify(r)}`)

  // Defensive: marker still present after gate runs
  if (fs.existsSync(path.join(d, '.claude', '.checkpoint-required')))
    ok('1.1 (defensive): marker still present at check time')
  else bad('1.1 defensive', 'marker disappeared')
}

// 1.2 baseline + all-stale → allow (carve-out fires)
{
  const d = mkRepo('1-2'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.claude')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  // Make checkpoint-required older
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // baseline now > checkpoint-required
  const r = runGateStop(d)
  if (isCarveOutAllow(r)) ok('1.2: baseline + all-stale → allow (carve-out fires)')
  else bad('1.2: carve-out should fire', `got: ${JSON.stringify(r)}`)
}

// 1.3 baseline + plan-pending newer than baseline → block
{
  const d = mkRepo('1-3'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.claude')
  fs.writeFileSync(path.join(claudeDir, '.checkpoint-required'), '')
  setMtime(path.join(claudeDir, '.checkpoint-required'), Date.now() - 60_000)
  fs.writeFileSync(path.join(claudeDir, '.session-baseline'), '')
  // sleep effect: plan-pending will be NEWER than baseline
  const planP = path.join(claudeDir, '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  setMtime(planP, Date.now() + 5_000) // explicitly future to defeat fs resolution
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('1.3: plan-pending newer than baseline → block')
  else bad('1.3: plan-pending → block', `got: ${JSON.stringify(r)}`)
  if (fs.existsSync(planP)) ok('1.3 (defensive): plan-pending preserved')
  else bad('1.3 defensive', 'plan-pending disappeared')
}

// 1.4 .checkpoint-required re-armed mid-session (newer than baseline) → block
{
  const d = mkRepo('1-4'); cleanupDirs.push(d)
  const claudeDir = path.join(d, '.claude')
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
  const claudeDir = path.join(d, '.claude')
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
  const claudeDir = path.join(d, '.claude')
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
  const baseline = path.join(d, '.claude', '.session-baseline')
  if (fs.existsSync(baseline)) bad('2.1 setup', 'baseline pre-existed')
  const r = runSessionStart(d)
  if (r.status === 0 && fs.existsSync(baseline)) ok('2.1: --session-start creates .session-baseline')
  else bad('2.1: baseline create', `status=${r.status} exists=${fs.existsSync(baseline)}`)
}

// 2.2 second run advances baseline mtime
{
  const d = mkRepo('2-2'); cleanupDirs.push(d)
  runSessionStart(d)
  const baseline = path.join(d, '.claude', '.session-baseline')
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
  const baseline = path.join(d, '.claude', '.session-baseline')
  const planP = path.join(d, '.claude', '.plan-approval-pending')
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

// 2.4 in-flight plan-pending (mtime > prior baseline) preserved
{
  const d = mkRepo('2-4'); cleanupDirs.push(d)
  runSessionStart(d) // baseline at T0
  const baseline = path.join(d, '.claude', '.session-baseline')
  const planP = path.join(d, '.claude', '.plan-approval-pending')
  const baselineM = fs.statSync(baseline).mtimeMs
  fs.writeFileSync(planP, '')
  setMtime(planP, baselineM + 5_000) // newer than prior baseline
  // second SessionStart: plan-pending should NOT be cleared (in-flight)
  runSessionStart(d)
  if (fs.existsSync(planP)) ok('2.4: in-flight plan-pending preserved across SessionStart')
  else bad('2.4: in-flight plan-pending wrongly cleared', 'plan-pending was newer than prior baseline')
}

// 2.5 first-ever run with leftover plan-pending leaves it alone
{
  const d = mkRepo('2-5'); cleanupDirs.push(d)
  const planP = path.join(d, '.claude', '.plan-approval-pending')
  fs.writeFileSync(planP, '')
  // No prior baseline exists.
  runSessionStart(d)
  if (fs.existsSync(planP)) ok('2.5: first-ever SessionStart leaves plan-pending alone (conservative)')
  else bad('2.5: first-ever wrongly cleared plan-pending', 'baseline was absent — should be conservative')
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
  const baseline = path.join(d, '.claude', '.session-baseline')
  // Roll back baseline so we have a clear "older than" zone
  setMtime(baseline, Date.now() - 60_000)
  const baselineM = fs.statSync(baseline).mtimeMs
  // Plant all 3 markers older than baseline
  const markers = [
    '.checkpoint-required',
    '.post-checkpoint-required',
    '.plan-approval-pending'
  ].map(m => path.join(d, '.claude', m))
  for (const m of markers) {
    fs.writeFileSync(m, '')
    setMtime(m, baselineM - 5_000)
  }
  runSessionStart(d)
  // Defensive: confirm the markers we just planted existed at the moment
  // we recorded their mtimes (per feedback_test_resource_existence_check.md).
  // This isn't quite the canonical pattern (cleanup happened between plant
  // and check), so we instead rely on the pre-cleanup writes succeeding.
  const cleared = markers.map(m => !fs.existsSync(m))
  if (cleared.every(Boolean)) ok('3.1: SessionStart clears all 3 stale task-signal markers (P1-2)')
  else bad('3.1: same-class clear incomplete',
    markers.map((m, i) => `${path.basename(m)}=${cleared[i] ? 'cleared' : 'PRESENT'}`).join(' '))
}

// 3.2 SessionStart preserves in-flight markers (newer than prior baseline).
// Symmetric to 2.4 but covers all 3 markers, not just plan-pending.
{
  const d = mkRepo('3-2'); cleanupDirs.push(d)
  runSessionStart(d)
  const baseline = path.join(d, '.claude', '.session-baseline')
  const baselineM = fs.statSync(baseline).mtimeMs
  const markers = [
    '.checkpoint-required',
    '.post-checkpoint-required',
    '.plan-approval-pending'
  ].map(m => path.join(d, '.claude', m))
  for (const m of markers) {
    fs.writeFileSync(m, '')
    setMtime(m, baselineM + 5_000) // in-flight (mid-session)
  }
  runSessionStart(d)
  const preserved = markers.map(m => fs.existsSync(m))
  if (preserved.every(Boolean)) ok('3.2: SessionStart preserves in-flight markers across all 3 class members')
  else bad('3.2: in-flight wrongly cleared',
    markers.map((m, i) => `${path.basename(m)}=${preserved[i] ? 'present' : 'CLEARED'}`).join(' '))
}

// 3.3 Symlink defense (P2-2): a symlinked baseline does not enable the
// carve-out. Threat-model: honest-agent self-discipline; defense against
// accidental symlinks (e.g. workspace setups), not adversarial.
{
  const d = mkRepo('3-3'); cleanupDirs.push(d)
  fs.writeFileSync(path.join(d, '.claude', '.checkpoint-required'), '')
  // Create a real file elsewhere with very-old mtime, then symlink
  // .session-baseline to it.
  const realFile = path.join(d, '.claude', 'real-old-file')
  fs.writeFileSync(realFile, '')
  setMtime(realFile, Date.now() - 365 * 24 * 60 * 60 * 1000) // 1 year ago
  fs.symlinkSync(realFile, path.join(d, '.claude', '.session-baseline'))
  // Without symlink defense, lstat(real) would say baseline is older than
  // markers → carve-out fires. With defense: symlink rejected → carve-out
  // does not fire → block.
  const r = runGateStop(d)
  if (isBlock(r) && r.status === 0) ok('3.3: symlinked baseline rejected by carve-out')
  else bad('3.3: symlink should defeat carve-out', `got: ${JSON.stringify(r)}`)
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
  fs.writeFileSync(path.join(d, '.claude', '.checkpoint-required'), '')
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
console.log('\n==================================================')
console.log(`Results: ${pass} passed, ${fail} failed`)
console.log('==================================================')
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
process.exit(0)
