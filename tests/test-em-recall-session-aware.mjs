#!/usr/bin/env node
/**
 * Integration test for em-recall.mjs --gate stop session-aware reads + carve-out
 * (rank-2 C3). Verifies the cross-session bleed fix end-to-end against the real
 * em-recall binary.
 *
 * Coverage:
 *   X1 — Acceptance #1: A's marker doesn't block B's clean Stop.
 *   X2 — Acceptance #1-bis: B's own marker blocks B's Stop.
 *   X3 — Acceptance #2 (same-ms race): per-session reader stable.
 *   X4 — Carve-out own-session: B has own checkpoint-required + matching baseline → allow.
 *   X5 — Carve-out cross-session: B has no own marker, A has armed marker → allow (carve-out fires).
 *   X6 — Symlink defense: own-session marker is a symlink → fail closed (block).
 *   X7 — Legacy-literal fallback: no sid + legacy literal exists → reads legacy.
 *   X8 — Invalid sid graceful degrade: bad sid passed → falls back to legacy-only mode.
 */

import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const EM_RECALL = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'scripts',
  'em-recall.mjs'
)

let pass = 0
let fail = 0
const failures = []

function assert(label, cond, detail) {
  if (cond) { pass++; return }
  fail++
  failures.push({ label, detail })
}

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rank2-c3-test-'))
  // Make it look like a git repo so resolveRepoRoot from local-dir.mjs
  // accepts it as the project root.
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  return root
}

function runGateStop(repoRoot, sid) {
  const args = ['--gate', 'stop']
  if (sid !== undefined) args.push('--session-id', sid)
  const res = spawnSync('node', [EM_RECALL, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

function setBaselineAfter(repoRoot, refMs) {
  // Write baseline with mtime > refMs+1 to mimic force-monotonic SessionStart.
  const baseline = path.join(repoRoot, '.checkpoints', '.session-baseline')
  fs.writeFileSync(baseline, '')
  const t = (refMs + 100) / 1000
  fs.utimesSync(baseline, t, t)
}

function setMarkerWithMtime(p, mtimeMs) {
  fs.writeFileSync(p, '')
  const t = mtimeMs / 1000
  fs.utimesSync(p, t, t)
}

// ---------------------------------------------------------------------------
// X1: Acceptance #1 — A's marker doesn't block B's clean Stop.
// Setup: A has .post-checkpoint-required.<sidA>; B has no own quartet markers.
// B's baseline post-dates A's marker (force-monotonic). B Stop → no block.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  const sidA = 'aaaa-aaaa-aaaa'
  const sidB = 'bbbb-bbbb-bbbb'

  // A arms `.post-checkpoint-required.<sidA>` (so .checkpoint-required is set too).
  const aReq = path.join(root, '.checkpoints', `.checkpoint-required.${sidA}`)
  const aPostReq = path.join(root, '.checkpoints', `.post-checkpoint-required.${sidA}`)
  const tA = Date.now() - 5000
  setMarkerWithMtime(aReq, tA)
  setMarkerWithMtime(aPostReq, tA)

  // B baseline > A's marker mtime.
  setBaselineAfter(root, tA)

  const r = runGateStop(root, sidB)
  assert('X1 B Stop exit 0', r.code === 0)
  assert('X1 B Stop empty stdout (allow stop)', r.stdout === '',
    { stdout: r.stdout, stderr: r.stderr })

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// X2: Acceptance #1-bis — B's own marker blocks B's Stop (no post-done).
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  const sidB = 'bbbb-bbbb-bbbb'

  // B armed own `.checkpoint-required.<sidB>` POST-baseline (mid-session arm).
  const baselineT = Date.now() - 3000
  setBaselineAfter(root, baselineT - 5000)  // baseline OLDER than B's marker

  const bReq = path.join(root, '.checkpoints', `.checkpoint-required.${sidB}`)
  setMarkerWithMtime(bReq, Date.now())

  const r = runGateStop(root, sidB)
  assert('X2 B Stop exit 0 (block emits, hook still exits 0)', r.code === 0)
  const out = r.stdout.trim()
  let json = null
  try { json = JSON.parse(out) } catch {}
  assert('X2 B Stop emits block JSON', json && json.decision === 'block',
    { stdout: r.stdout })
  assert('X2 block reason mentions suffixed path',
    json && json.reason && json.reason.includes(`.post-checkpoint-done.${sidB}`),
    { reason: json && json.reason })

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// X3: Same-ms race — own marker and baseline land in the same wall-clock ms.
// Carve-out check is `marker.mtime > baselineMtime` (strict-greater), so
// same-mtime → no block → allow stop. Verifies the per-session reader is
// stable under the empirical 2026-05-23 ~15:55 same-ms scenario.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  const sidB = 'bbbb-bbbb-bbbb'

  // Same-ms race: marker AND baseline at exactly the same mtime.
  const sameT = Date.now() - 2000
  const bReq = path.join(root, '.checkpoints', `.checkpoint-required.${sidB}`)
  setMarkerWithMtime(bReq, sameT)
  // setBaselineAfter adds +100ms; use a direct utime to match exactly.
  const baseline = path.join(root, '.checkpoints', '.session-baseline')
  fs.writeFileSync(baseline, '')
  const t = sameT / 1000
  fs.utimesSync(baseline, t, t)

  const r = runGateStop(root, sidB)
  // No .checkpoint-required readable → preReqPath null → early return → allow.
  // Wait: there IS .checkpoint-required.<sidB>. Resolution: own primary →
  // exists → preReqPath set. postDonePath null (no post-done). preReqPath set
  // + postDoneSize=0 → carve-out check. marker.mtime === baselineMtime →
  // NOT > → loop continues → returns true → allow stop.
  assert('X3 same-ms own-marker + baseline → allow stop',
    r.code === 0 && r.stdout === '',
    { stdout: r.stdout, stderr: r.stderr })

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// X4: Own-session carve-out applies — B has own checkpoint-required with
// mtime <= baseline (B armed BEFORE its baseline; e.g. mid-session-restart).
// Carve-out evaluates: marker.mtime <= baseline → continue → return true →
// allow stop. Demonstrates that own-session reads + baseline dominance work
// together for the carve-out.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  const sidB = 'bbbb-bbbb-bbbb'

  // B's marker is older than B's baseline (force-monotonic dominates it).
  const markerT = Date.now() - 10000
  const bReq = path.join(root, '.checkpoints', `.checkpoint-required.${sidB}`)
  setMarkerWithMtime(bReq, markerT)
  setBaselineAfter(root, markerT)  // baseline > marker by 100ms

  const r = runGateStop(root, sidB)
  assert('X4 own-marker dominated by baseline → carve-out allows stop',
    r.code === 0 && r.stdout === '',
    { stdout: r.stdout, stderr: r.stderr })

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// X5: Cross-session bleed scenario — B has NO own quartet markers; A has
// `.checkpoint-required.<sidA>` that pre-dates B's baseline (force-monotonic
// has dominated it). B's own-session carve-out should see nothing for itself
// and allow Stop.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  const sidA = 'aaaa-aaaa-aaaa'
  const sidB = 'bbbb-bbbb-bbbb'

  const aReq = path.join(root, '.checkpoints', `.checkpoint-required.${sidA}`)
  const tA = Date.now() - 5000
  setMarkerWithMtime(aReq, tA)
  setBaselineAfter(root, tA)

  // B has nothing of its own.
  const r = runGateStop(root, sidB)
  assert('X5 B Stop allow (own-session reader sees nothing for B)',
    r.code === 0 && r.stdout === '',
    { stdout: r.stdout, stderr: r.stderr })

  // A's marker still on disk after B's Stop.
  assert("X5 A's marker preserved", fs.existsSync(aReq))

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// X7: Legacy-literal fallback — no sid + legacy literal exists at primary.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()

  const legacy = path.join(root, '.checkpoints', '.checkpoint-required')
  const tNow = Date.now() - 3000
  setMarkerWithMtime(legacy, tNow)
  setBaselineAfter(root, tNow - 5000)  // baseline OLDER → carve-out fails → block

  const r = runGateStop(root, undefined)
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  assert('X7 no-sid legacy literal triggers block',
    r.code === 0 && json && json.decision === 'block',
    { stdout: r.stdout })

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// X8: Invalid sid graceful degrade — em-recall warns + falls back.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()

  setBaselineAfter(root, Date.now() - 1000)

  const res = spawnSync('node', [EM_RECALL, '--gate', 'stop', '--session-id', 'invalid/slash'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  })
  assert('X8 invalid sid: exit 0 (graceful degrade)', res.status === 0)
  assert('X8 invalid sid: stderr warns',
    res.stderr.includes('legacy-literal-only'),
    { stderr: res.stderr })

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// X6: Symlink defense — own-session marker is a symlink → carve-out fails closed.
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  const sidB = 'bbbb-bbbb-bbbb'

  // B has both .checkpoint-required.<sidB> and a baseline OLDER than its mtime.
  // But the marker is a SYMLINK → strict helper hadSymlink=true → carve-out fails closed.
  const realFile = path.join(root, '.checkpoints', 'realtarget')
  fs.writeFileSync(realFile, '')
  const bReq = path.join(root, '.checkpoints', `.checkpoint-required.${sidB}`)
  fs.symlinkSync('realtarget', bReq)
  setBaselineAfter(root, Date.now() - 5000)

  const r = runGateStop(root, sidB)
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  assert('X6 symlink own-session marker triggers block (fail closed)',
    r.code === 0 && json && json.decision === 'block',
    { stdout: r.stdout })

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(JSON.stringify({
  pass,
  fail,
  total: pass + fail,
  failures,
}, null, 2))

process.exit(fail === 0 ? 0 : 1)
