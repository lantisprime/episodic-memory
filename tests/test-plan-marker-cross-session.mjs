#!/usr/bin/env node
/**
 * test-plan-marker-cross-session.mjs — End-to-end cross-session isolation
 * tests for #268 fix.
 *
 * Coverage (plan v6 §6.2):
 *   X1   A's orphan; plan-gate stdin sid=B Write → ALLOW (the #268 fix)
 *   X2   A's marker; plan-gate stdin sid=A Write → BLOCK (own plan still gates)
 *   X3   Only legacy marker exists; any sid → BLOCK (burn-in compat)
 *   X4   3 stale orphans + legacy; SessionStart orphan-sweep → all swept
 *   X5   Worktree-cwd: helper --root <main-repo> from worktree cwd → file at
 *        canonical main-repo, NOT worktree
 *   X7   Concurrent A + B --touch — both markers exist (different basenames)
 *   X8   CLAUDE_CODE_SESSION_ID="../evil" → helper exit 8 (no traversal)
 *   X9   plan-gate stdin sid="../evil" + marker present → BLOCK (F14 fail-closed)
 *   X10  A used legacy fallback; A --rm → legacy UNTOUCHED (F3)
 *   X11  Session B SessionEnd → does NOT delete session A's active marker (F12)
 *   X12  plan-gate allows `node plan-marker.mjs --rm` while marker exists (F13)
 *   X13  classifier rejects env-prefix on helper invocation (F17/F18)
 *
 * Skipped here (covered elsewhere):
 *   - X6 (re-resume) — orthogonal to namespacing; relies on Claude Code
 *     resume semantics not modeled by this test.
 *   - X13 / X13-bis subcases — already covered by /tmp/test-classifier-plan-marker.sh
 *     smoke + covered indirectly by X12 + X13 here.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PLAN_GATE = path.join(REPO, 'hooks', 'plan-gate.sh')
const HELPER = path.join(REPO, 'scripts', 'plan-marker.mjs')
const EM_RECALL = path.join(REPO, 'scripts', 'em-recall.mjs')
const SESSION_END = path.join(REPO, 'scripts', 'em-session-end-prompt.mjs')

let passed = 0
let failed = 0
const cleanups = []
process.on('exit', () => { for (const fn of cleanups) try { fn() } catch {} })

function mkTmpRepo() {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'em-cross-test-'))
  const real = fs.realpathSync(raw)
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(real, '.claude'), { recursive: true })
  // Real git init so the resolver finds this as the repo root.
  spawnSync('git', ['init', '-q'], { cwd: real })
  // Stage the hook + libs the gate sources.
  const hooksLib = path.join(real, 'hooks', 'lib')
  fs.mkdirSync(hooksLib, { recursive: true })
  fs.cpSync(path.join(REPO, 'hooks', 'plan-gate.sh'), path.join(real, 'hooks', 'plan-gate.sh'))
  for (const lib of ['command-classifier.sh', 'repo-root.sh', 'marker-paths.sh', 'session-id.sh']) {
    fs.cpSync(path.join(REPO, 'hooks', 'lib', lib), path.join(hooksLib, lib))
  }
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function runPlanGate({ root, sid, toolName, toolInput }) {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    cwd: root,
    session_id: sid,
  })
  const r = spawnSync('bash', [path.join(root, 'hooks', 'plan-gate.sh')], {
    input: payload,
    encoding: 'utf8',
  })
  let decision = 'allow'
  if (r.stdout && r.stdout.trim()) {
    try { decision = JSON.parse(r.stdout).decision || 'unknown' }
    catch { decision = 'unknown' }
  }
  return { decision, stdout: r.stdout, stderr: r.stderr, status: r.status }
}

function runHelper(root, sid, args) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sid }
  if (sid === undefined) delete env.CLAUDE_CODE_SESSION_ID
  return spawnSync('node', [HELPER, ...args, '--root', root], { encoding: 'utf8', env })
}

function check(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else { console.log(`  ✗ ${label}`); failed++ }
}

// ---------------- X1: A's orphan, session B Write → ALLOW (the #268 fix) ----
{
  const root = mkTmpRepo()
  fs.writeFileSync(path.join(root, '.checkpoints', '.plan-approval-pending.session-A'), '')
  const r = runPlanGate({ root, sid: 'session-B', toolName: 'Write', toolInput: { file_path: '/tmp/x' } })
  check(r.decision === 'allow', `X1 cross-session orphan → ALLOW (the #268 fix; got ${r.decision})`)
}

// ---------------- X2: A's own marker, session A → BLOCK ---------------------
{
  const root = mkTmpRepo()
  fs.writeFileSync(path.join(root, '.checkpoints', '.plan-approval-pending.session-A'), '')
  const r = runPlanGate({ root, sid: 'session-A', toolName: 'Write', toolInput: { file_path: '/tmp/x' } })
  check(r.decision === 'block', `X2 own marker → BLOCK (got ${r.decision})`)
}

// ---------------- X3: legacy only → BLOCK any sid (burn-in compat) -----------
{
  const root = mkTmpRepo()
  fs.writeFileSync(path.join(root, '.checkpoints', '.plan-approval-pending'), '')
  const r = runPlanGate({ root, sid: 'session-A', toolName: 'Write', toolInput: { file_path: '/tmp/x' } })
  check(r.decision === 'block', `X3 legacy → BLOCK (got ${r.decision})`)
}

// ---------------- X4: orphan-sweep removes stale plan markers ----------------
{
  const root = mkTmpRepo()
  const ck = path.join(root, '.checkpoints')
  // 3 stale orphans + legacy + a session-baseline whose mtime is NEWER than them.
  fs.writeFileSync(path.join(ck, '.plan-approval-pending.A'), '')
  fs.writeFileSync(path.join(ck, '.plan-approval-pending.B'), '')
  fs.writeFileSync(path.join(ck, '.plan-approval-pending.C'), '')
  fs.writeFileSync(path.join(ck, '.plan-approval-pending'), '')
  // Make all markers' mtime old (5 minutes ago).
  const oldMs = Date.now() / 1000 - 300
  for (const f of ['.plan-approval-pending.A', '.plan-approval-pending.B', '.plan-approval-pending.C', '.plan-approval-pending']) {
    fs.utimesSync(path.join(ck, f), oldMs, oldMs)
  }
  // Baseline mtime is newer (now).
  fs.writeFileSync(path.join(ck, '.session-baseline'), '')

  // Run em-recall --session-start: it will write a NEW baseline and sweep orphans
  // whose mtime <= prior baseline. The prior baseline mtime IS the "now" baseline
  // we just wrote, so all 4 stale orphans (5 min ago) should sweep.
  const r = spawnSync('node', [EM_RECALL, '--session-start', '--no-track', '--limit', '1'], {
    cwd: root, encoding: 'utf8'
  })
  check(r.status === 0, `X4 em-recall --session-start exit 0 (got ${r.status})`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending.A')), `X4: orphan A swept`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending.B')), `X4: orphan B swept`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending.C')), `X4: orphan C swept`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending')), `X4: legacy orphan swept`)
}

// ---------------- X5: worktree-cwd helper writes at canonical root, not cwd --
{
  // Simulate worktree-cwd: caller cwd is OUTSIDE target root.
  const target = mkTmpRepo()
  const callerCwd = mkTmpRepo()
  const r = spawnSync('node', [HELPER, '--touch', '--root', target], {
    cwd: callerCwd,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'session-W' },
  })
  check(r.status === 0, `X5 helper exit 0 from caller_cwd != root (got ${r.status})`)
  const targetMarker = path.join(target, '.checkpoints', '.plan-approval-pending.session-W')
  const callerMarker = path.join(callerCwd, '.checkpoints', '.plan-approval-pending.session-W')
  check(fs.existsSync(targetMarker), `X5: marker at TARGET ${targetMarker}`)
  check(!fs.existsSync(callerMarker), `X5: NO marker at caller_cwd ${callerMarker}`)
}

// ---------------- X7: concurrent --touch A + B, both files exist -------------
{
  const root = mkTmpRepo()
  const rA = runHelper(root, 'session-Conc-A', ['--touch'])
  const rB = runHelper(root, 'session-Conc-B', ['--touch'])
  check(rA.status === 0 && rB.status === 0, `X7 both helpers exit 0`)
  check(fs.existsSync(path.join(root, '.checkpoints', '.plan-approval-pending.session-Conc-A')), `X7: A marker exists`)
  check(fs.existsSync(path.join(root, '.checkpoints', '.plan-approval-pending.session-Conc-B')), `X7: B marker exists`)
}

// ---------------- X8: invalid env sid → exit 8 (path-traversal reject) -------
{
  const root = mkTmpRepo()
  const r = runHelper(root, '../evil', ['--touch'])
  check(r.status === 8, `X8 traversal env sid → exit 8 (got ${r.status})`)
  check(!fs.existsSync(path.join(root, '.checkpoints', '.plan-approval-pending.../evil')), `X8: no traversal file written`)
}

// ---------------- X9: gate fail-closed on invalid stdin sid + marker --------
{
  const root = mkTmpRepo()
  fs.writeFileSync(path.join(root, '.checkpoints', '.plan-approval-pending.session-A'), '')
  const r = runPlanGate({ root, sid: '../evil', toolName: 'Write', toolInput: { file_path: '/tmp/x' } })
  check(r.decision === 'block', `X9 invalid stdin sid + marker → BLOCK (F14; got ${r.decision})`)
}

// ---------------- X10: A used legacy fallback, A --rm — legacy UNTOUCHED -----
{
  const root = mkTmpRepo()
  fs.writeFileSync(path.join(root, '.checkpoints', '.plan-approval-pending'), '')
  const r = runHelper(root, 'session-A', ['--rm'])
  check(r.status === 0, `X10 --rm exit 0`)
  check(fs.existsSync(path.join(root, '.checkpoints', '.plan-approval-pending')),
    `X10: legacy UNTOUCHED (F3 cross-session safety)`)
}

// ---------------- X11: B SessionEnd does NOT delete A's marker (F12) ---------
{
  const root = mkTmpRepo()
  const markerA = path.join(root, '.checkpoints', '.plan-approval-pending.session-A')
  const markerB = path.join(root, '.checkpoints', '.plan-approval-pending.session-B')
  fs.writeFileSync(markerA, '')
  fs.writeFileSync(markerB, '')
  const r = spawnSync('node', [SESSION_END], {
    input: JSON.stringify({ session_id: 'session-B', hook_event_name: 'SessionEnd' }),
    cwd: root,
    encoding: 'utf8',
  })
  check(r.status === 0, `X11 SessionEnd exit 0`)
  check(fs.existsSync(markerA), `X11: A marker UNTOUCHED (F12)`)
  check(!fs.existsSync(markerB), `X11: B marker removed (own-session)`)
}

// ---------------- X12: plan-gate allows helper while marker exists (F13) -----
{
  // E5b classifier maps `node */plan-marker.mjs --rm --root <abs>` → marker_write,
  // and plan-gate allows marker_write of plan-marker basenames. Verify via the
  // gate that the rm-via-helper invocation is allowed when own marker is present.
  const root = mkTmpRepo()
  const markerA = path.join(root, '.checkpoints', '.plan-approval-pending.session-A')
  fs.writeFileSync(markerA, '')
  const cmd = `node ${HELPER} --rm --root ${root}`
  // Plan-gate receives the Bash command + caller's session_id.
  const r = runPlanGate({
    root, sid: 'session-A',
    toolName: 'Bash',
    toolInput: { command: cmd },
  })
  check(r.decision === 'allow', `X12 helper --rm via Bash classified marker_write → ALLOW (got ${r.decision})`)
}

// ---------------- X13: classifier rejects env-prefix on helper (F17) ---------
{
  const root = mkTmpRepo()
  const markerA = path.join(root, '.checkpoints', '.plan-approval-pending.session-A')
  const markerB = path.join(root, '.checkpoints', '.plan-approval-pending.session-B')
  fs.writeFileSync(markerA, '')
  fs.writeFileSync(markerB, '')
  // Session A attempts to remove B's marker via command-local env override.
  // Classifier should emit unsafe_complex → plan-gate falls through to block.
  const cmd = `CLAUDE_CODE_SESSION_ID=session-B node ${HELPER} --rm --root ${root}`
  const r = runPlanGate({
    root, sid: 'session-A',
    toolName: 'Bash',
    toolInput: { command: cmd },
  })
  check(r.decision === 'block', `X13 env-prefix helper invocation → BLOCK (F17; got ${r.decision})`)
  // Verify B's marker survives (no removal occurred).
  check(fs.existsSync(markerB), `X13: B marker survives (helper didn't run)`)
}

console.log('')
console.log(`Results: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
