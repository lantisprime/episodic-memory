#!/usr/bin/env node
/**
 * test-em-recall-session-id-binding.mjs — Validates `--session-id` flag
 * behavior on `em-recall --session-start`.
 *
 * Scenarios:
 *   N3  --session-id missing → em-recall exits 0; legacy swept; suffixed
 *       all preserved (no functional impact in v6 sweep since suffixed
 *       forms are never swept here anyway, but flag wiring works)
 *   N4  --session-id ../../etc/passwd (malformed) → em-recall exits 0
 *       (warn-on-invalid per codex R2 Q3); legacy still swept; suffixed
 *       all preserved; stderr contains a warning line
 *   N4b --session-id empty string → exits 0, treated as missing
 *   N4c --session-id valid SID → exits 0, no stderr warning
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

function mkTmpGitRepo() {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sidbind-'))
  const real = fs.realpathSync(raw)
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(real, '.claude'), { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: real })
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function touchWithMtime(p, secondsAgo) {
  fs.writeFileSync(p, '')
  const ts = (Date.now() / 1000) - secondsAgo
  fs.utimesSync(p, ts, ts)
}

function runSessionStart(cwd, extraArgs = []) {
  const args = [EM_RECALL, '--limit', '5', '--session-start', ...extraArgs]
  return spawnSync('node', args, { cwd, encoding: 'utf8' })
}

// ============================ N3 ============================
{
  console.log('N3: --session-id missing → exit 0; legacy swept; suffixed preserved')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  touchWithMtime(path.join(ck, '.plan-approval-pending'), 1800)
  touchWithMtime(path.join(ck, '.plan-approval-pending.foreign'), 1800)
  const r = runSessionStart(repo)  // no --session-id
  check(r.status === 0, `N3 exit 0`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending')), `N3 legacy still swept (independent of session-id)`)
  check(fs.existsSync(path.join(ck, '.plan-approval-pending.foreign')), `N3 suffixed preserved`)
}

// ============================ N4 — malformed sid ============================
{
  console.log('N4: --session-id ../../etc/passwd (malformed) → exit 0; warn; legacy swept; suffixed preserved')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  touchWithMtime(path.join(ck, '.plan-approval-pending'), 1800)
  touchWithMtime(path.join(ck, '.plan-approval-pending.foreign'), 1800)
  const r = runSessionStart(repo, ['--session-id', '../../etc/passwd'])
  check(r.status === 0, `N4 exit 0 (warn-on-invalid, not exit-non-zero per codex R2 Q3)`)
  check(r.stderr.includes('failed validateSessionId'), `N4 stderr contains validateSessionId warning`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending')), `N4 legacy still swept (independent of malformed sid)`)
  check(fs.existsSync(path.join(ck, '.plan-approval-pending.foreign')), `N4 suffixed preserved`)
}

// ============================ N4b — empty string sid ============================
{
  console.log('N4b: --session-id "" (empty) → exit 0, treated as missing, no warning')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  touchWithMtime(path.join(ck, '.plan-approval-pending'), 1800)
  const r = runSessionStart(repo, ['--session-id', ''])
  check(r.status === 0, `N4b exit 0`)
  check(!r.stderr.includes('failed validateSessionId'), `N4b empty sid does not emit warning (treated as missing)`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending')), `N4b legacy still swept`)
}

// ============================ N4c — valid sid ============================
{
  console.log('N4c: --session-id <valid uuid-ish> → exit 0, no warning')
  const repo = mkTmpGitRepo()
  const ck = path.join(repo, '.checkpoints')
  touchWithMtime(path.join(ck, '.session-baseline'), 3600)
  touchWithMtime(path.join(ck, '.plan-approval-pending'), 1800)
  // Use a valid session-id shape: matches SESSION_ID_RE
  const r = runSessionStart(repo, ['--session-id', '35522aab-5f44-4b84-b1cc-035cca7b9305'])
  check(r.status === 0, `N4c exit 0`)
  check(!r.stderr.includes('failed validateSessionId'), `N4c valid sid does not emit warning`)
  check(!fs.existsSync(path.join(ck, '.plan-approval-pending')), `N4c legacy still swept`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
