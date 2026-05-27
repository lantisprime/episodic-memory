#!/usr/bin/env node
/**
 * test-plan-marker.mjs — Unit tests for scripts/plan-marker.mjs.
 *
 * Coverage (plan v6 §6.1):
 *   H1   --touch valid env + valid root → exit 0, file at expected path
 *   H2   --rm valid env + valid root → exit 0, suffixed-only removed; legacy untouched
 *   H3   --touch CLAUDE_CODE_SESSION_ID="" → exit 8
 *   H3b  --touch CLAUDE_CODE_SESSION_ID UNSET → exit 8 (distinct from empty)
 *   H4   --touch invalid sid (path traversal char) → exit 8
 *   H5   --touch --root missing → exit 4
 *   H6   --touch --root non-absolute → exit 5
 *   H7   --touch --root non-existent → exit 5
 *   H8   --touch --root no repo signal → exit 5
 *   H9   --touch then --rm same sid — idempotent rm → exit 0
 *   H10  --touch SIGINT mid-write — no partial .tmp left behind
 *   H11  both --touch and --rm → exit 6
 *   H12  neither --touch nor --rm → exit 6
 *   H13  --rm with legacy `.plan-approval-pending` present, suffixed absent
 *        → exit 0; legacy UNTOUCHED (F3 narrowing cross-session safety)
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HELPER = path.join(REPO_ROOT, 'scripts', 'plan-marker.mjs')

let passed = 0
let failed = 0
const cleanups = []

process.on('exit', () => {
  for (const fn of cleanups) try { fn() } catch { /* best-effort */ }
})

function mkTmpRepo() {
  // Real filesystem dir with a .checkpoints/ signal so validateRoot accepts.
  // macOS mktemp -d returns /var/folders/... — resolve via realpath so
  // process.env.PWD-style equality holds when --root is canonicalized.
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'em-plan-marker-test-'))
  const real = fs.realpathSync(raw)
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function run(args, { sid = 'valid-sid-123', unsetSid = false } = {}) {
  const env = { ...process.env }
  if (unsetSid) {
    delete env.CLAUDE_CODE_SESSION_ID
  } else {
    env.CLAUDE_CODE_SESSION_ID = sid
  }
  return spawnSync('node', [HELPER, ...args], { encoding: 'utf8', env })
}

function expect(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}`)
    failed++
  }
}

// ---------- H1: --touch valid env + valid root → exit 0, file created ----------
{
  const root = mkTmpRepo()
  const r = run(['--touch', '--root', root])
  const expected = path.join(root, '.checkpoints', '.plan-approval-pending.valid-sid-123')
  expect(r.status === 0, `H1: --touch valid env+root → exit 0 (got ${r.status}; stderr=${r.stderr.trim()})`)
  expect(fs.existsSync(expected), `H1: marker file written at ${expected}`)
  const out = (() => { try { return JSON.parse(r.stdout) } catch { return null } })()
  expect(out && out.status === 'ok' && out.path === expected, `H1: stdout JSON has status=ok + correct path`)
}

// ---------- H2: --rm valid → suffixed removed; legacy untouched ----------
{
  const root = mkTmpRepo()
  const suffixed = path.join(root, '.checkpoints', '.plan-approval-pending.valid-sid-123')
  const legacy = path.join(root, '.checkpoints', '.plan-approval-pending')
  fs.writeFileSync(suffixed, '')
  fs.writeFileSync(legacy, '')
  const r = run(['--rm', '--root', root])
  expect(r.status === 0, `H2: --rm exit 0 (got ${r.status})`)
  expect(!fs.existsSync(suffixed), `H2: suffixed marker removed`)
  expect(fs.existsSync(legacy), `H2: legacy marker UNTOUCHED (F3 narrowing)`)
}

// ---------- H3: --touch empty CLAUDE_CODE_SESSION_ID → exit 8 ----------
{
  const root = mkTmpRepo()
  const r = run(['--touch', '--root', root], { sid: '' })
  expect(r.status === 8, `H3: empty SID → exit 8 (got ${r.status})`)
  expect(/SESSION_ID_REQUIRED/.test(r.stderr), `H3: stderr has SESSION_ID_REQUIRED`)
  expect(!fs.existsSync(path.join(root, '.checkpoints', '.plan-approval-pending.')), `H3: no empty-suffix file written`)
}

// ---------- H3b: --touch UNSET CLAUDE_CODE_SESSION_ID → exit 8 ----------
{
  const root = mkTmpRepo()
  const r = run(['--touch', '--root', root], { unsetSid: true })
  expect(r.status === 8, `H3b: unset SID → exit 8 (got ${r.status})`)
  expect(/SESSION_ID_REQUIRED/.test(r.stderr), `H3b: stderr has SESSION_ID_REQUIRED`)
}

// ---------- H4: --touch invalid sid (path-traversal char) → exit 8 ----------
{
  const root = mkTmpRepo()
  const r = run(['--touch', '--root', root], { sid: '../evil' })
  expect(r.status === 8, `H4: traversal sid → exit 8 (got ${r.status})`)
  expect(/SESSION_ID_INVALID/.test(r.stderr), `H4: stderr has SESSION_ID_INVALID`)
}

// ---------- H5: --root missing → exit 4 ----------
{
  const r = run(['--touch'])
  expect(r.status === 4, `H5: missing --root → exit 4 (got ${r.status})`)
  expect(/ROOT_REQUIRED/.test(r.stderr), `H5: stderr has ROOT_REQUIRED`)
}

// ---------- H6: --root non-absolute → exit 5 ----------
{
  const r = run(['--touch', '--root', 'relative/path'])
  expect(r.status === 5, `H6: non-abs --root → exit 5 (got ${r.status})`)
  expect(/ROOT_INVALID/.test(r.stderr), `H6: stderr has ROOT_INVALID`)
}

// ---------- H7: --root non-existent → exit 5 ----------
{
  const r = run(['--touch', '--root', '/nonexistent/path/xyz123'])
  expect(r.status === 5, `H7: nonexistent --root → exit 5 (got ${r.status})`)
}

// ---------- H8: --root no repo signal → exit 5 ----------
{
  // Create a dir WITHOUT .git / .checkpoints / .episodic-memory
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'em-plan-marker-norepo-'))
  const real = fs.realpathSync(raw)
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  const r = run(['--touch', '--root', real])
  expect(r.status === 5, `H8: no-signal --root → exit 5 (got ${r.status})`)
  expect(/ROOT_NOT_REPO/.test(r.stderr), `H8: stderr has ROOT_NOT_REPO`)
}

// ---------- H9: --touch then --rm same sid (idempotent rm) → exit 0 ----------
{
  const root = mkTmpRepo()
  const r1 = run(['--touch', '--root', root])
  expect(r1.status === 0, `H9: first --touch exit 0`)
  const r2 = run(['--rm', '--root', root])
  expect(r2.status === 0, `H9: --rm exit 0`)
  const r3 = run(['--rm', '--root', root])
  expect(r3.status === 0, `H9: second --rm (idempotent, no file) → exit 0`)
}

// ---------- H10: SIGINT during --touch → no partial .tmp file ----------
{
  // H10 is hard to test deterministically because the actionTouch path is
  // synchronous (writeFileSync + renameSync) — SIGINT between these is
  // unlikely to fire mid-rename. We test the post-hoc invariant: after a
  // successful --touch, no .tmp file remains in .checkpoints/.
  const root = mkTmpRepo()
  const r = run(['--touch', '--root', root])
  expect(r.status === 0, `H10: --touch exit 0`)
  const entries = fs.readdirSync(path.join(root, '.checkpoints'))
  const tmps = entries.filter((e) => /\.tmp$/.test(e))
  expect(tmps.length === 0, `H10: no .tmp files left (got ${tmps.join(',')})`)
}

// ---------- H11: both --touch and --rm → exit 6 ----------
{
  const root = mkTmpRepo()
  const r = run(['--touch', '--rm', '--root', root])
  expect(r.status === 6, `H11: --touch + --rm → exit 6 (got ${r.status})`)
  expect(/MUTEX_VIOLATION/.test(r.stderr), `H11: stderr has MUTEX_VIOLATION`)
}

// ---------- H12: neither --touch nor --rm → exit 6 ----------
{
  const root = mkTmpRepo()
  const r = run(['--root', root])
  expect(r.status === 6, `H12: no action → exit 6 (got ${r.status})`)
  expect(/MISSING_ACTION/.test(r.stderr), `H12: stderr has MISSING_ACTION`)
}

// ---------- H13: --rm with legacy present, suffixed absent → legacy UNTOUCHED ----------
{
  const root = mkTmpRepo()
  const legacy = path.join(root, '.checkpoints', '.plan-approval-pending')
  fs.writeFileSync(legacy, '')
  // No suffixed marker exists for this sid.
  const r = run(['--rm', '--root', root])
  expect(r.status === 0, `H13: --rm exit 0 even with no suffixed (idempotent)`)
  expect(fs.existsSync(legacy), `H13: legacy marker UNTOUCHED (F3 cross-session safety)`)
  const out = (() => { try { return JSON.parse(r.stdout) } catch { return null } })()
  expect(out && Array.isArray(out.removed) && out.removed.length === 0, `H13: stdout removed=[] (nothing removed)`)
}

// ---------- H14: --approve creates .plan-approved.<sid> AND removes pending ----------
{
  const root = mkTmpRepo()
  const sid = 'valid-sid-123'
  const ck = (n) => path.join(root, '.checkpoints', n)
  fs.writeFileSync(ck(`.plan-approval-pending.${sid}`), '')
  const r = run(['--approve', '--root', root])
  expect(r.status === 0, `H14: --approve exit 0 (got ${r.status}; stderr=${r.stderr.trim()})`)
  expect(fs.existsSync(ck(`.plan-approved.${sid}`)), `H14: created .plan-approved.<sid> token`)
  expect(!fs.existsSync(ck(`.plan-approval-pending.${sid}`)), `H14: removed .plan-approval-pending.<sid>`)
  const out = (() => { try { return JSON.parse(r.stdout) } catch { return null } })()
  expect(out && typeof out.approved === 'string' && Array.isArray(out.removed), `H14: stdout has approved path + removed[]`)
}

// ---------- H15: --approve with no pending → still creates token (idempotent rm) ----------
{
  const root = mkTmpRepo()
  const sid = 'valid-sid-123'
  const ck = (n) => path.join(root, '.checkpoints', n)
  const r = run(['--approve', '--root', root])
  expect(r.status === 0, `H15: --approve exit 0 with no pending`)
  expect(fs.existsSync(ck(`.plan-approved.${sid}`)), `H15: token created even when no pending existed`)
}

// ---------- H16: --touch stale-clears the .plan-approved.<sid> token ----------
{
  const root = mkTmpRepo()
  const sid = 'valid-sid-123'
  const ck = (n) => path.join(root, '.checkpoints', n)
  fs.writeFileSync(ck(`.plan-approved.${sid}`), '')  // stale approval from a prior plan
  const r = run(['--touch', '--root', root])
  expect(r.status === 0, `H16: --touch exit 0`)
  expect(fs.existsSync(ck(`.plan-approval-pending.${sid}`)), `H16: armed new pending marker`)
  expect(!fs.existsSync(ck(`.plan-approved.${sid}`)), `H16: stale-cleared the .plan-approved.<sid> token`)
}

// ---------- H17: --touch stale-clear is prefix-collision safe (no glob) ----------
{
  const root = mkTmpRepo()
  const sid = 'valid-sid-123'
  const ck = (n) => path.join(root, '.checkpoints', n)
  fs.writeFileSync(ck(`.plan-approved.${sid}`), '')        // exact token (should clear)
  fs.writeFileSync(ck(`.plan-approved.${sid}-sib`), '')    // sibling sharing the prefix (must survive)
  const r = run(['--touch', '--root', root])
  expect(r.status === 0, `H17: --touch exit 0`)
  expect(!fs.existsSync(ck(`.plan-approved.${sid}`)), `H17: cleared the EXACT token`)
  expect(fs.existsSync(ck(`.plan-approved.${sid}-sib`)), `H17: prefix-collision sibling UNTOUCHED (no glob)`)
}

// ---------- H18: three-way action mutex (--approve combos) → exit 6 ----------
{
  const root = mkTmpRepo()
  const r1 = run(['--touch', '--approve', '--root', root])
  expect(r1.status === 6, `H18: --touch + --approve → exit 6 (got ${r1.status})`)
  expect(/MUTEX_VIOLATION/.test(r1.stderr), `H18: stderr has MUTEX_VIOLATION`)
  const r2 = run(['--rm', '--approve', '--root', root])
  expect(r2.status === 6, `H18b: --rm + --approve → exit 6 (got ${r2.status})`)
}

console.log('')
console.log(`Results: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
