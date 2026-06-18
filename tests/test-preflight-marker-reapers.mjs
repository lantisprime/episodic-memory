#!/usr/bin/env node
/**
 * test-preflight-marker-reapers.mjs — checkpoint-hygiene F4 (closes #283
 * lifecycle halves): reapers for the per-session preflight families
 *   .preflight-done.<sid>
 *   .last-user-prompt.<sid>.json
 *
 * Branch B1 — SessionEnd own-session reap (em-session-end-prompt.mjs):
 *   R1  own-sid both families removed; other-sid preserved
 *   R2  invalid sid → both preserved
 *   R3  nested cwd → reap at MAIN repo root; subdir canary untouched
 *   R4  linked worktree → reap at MAIN root; worktree-local canary untouched
 *   R5  non-git cwd → resolveRepoRoot falls back to cwd; reap binds there
 *   R6  fake HOME with its own .checkpoints → never touched
 *   R7  caller process-cwd != stdin .cwd → stdin .cwd wins; caller canary untouched
 *
 * Branch B2 — SessionStart 7-day orphan sweep (em-recall.mjs):
 *   S1  8-day-old suffixed pair reaped; 1-hour-old pair preserved
 *   S2  legacy suffix-less .preflight-done (old) preserved (F7 scope)
 *   S3  symlink matching the family RE preserved; target intact
 *   S4  non-matching basenames (old) preserved
 *   S5  nested cwd → sweep at MAIN root; subdir canary untouched
 *   S6  linked worktree cwd → sweep at MAIN root; worktree-local canary untouched
 *   S7  non-git cwd → sweep binds to cwd fallback
 *   S8  fake HOME with its own old markers → never touched
 *
 * Authority-root contract per plan review R3 ACCEPT
 * (episode 20260612-094844-reply-codex-...-32bf).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SESSION_END = path.join(REPO, 'scripts', 'em-session-end-prompt.mjs')
// RFC-008 P3d: SessionStart side-effects relocated em-recall.mjs → enforce-contract.mjs --session-start (F38/F60).
const ENFORCE = path.join(REPO, 'scripts', 'enforce-contract.mjs')

const SID_A = 'session-a'
const SID_B = 'session-b'
const DAY = 24 * 60 * 60

let passed = 0
let failed = 0
const cleanups = []
process.on('exit', () => { for (const fn of cleanups) try { fn() } catch {} })

function check(cond, msg) {
  if (cond) { passed++; console.log(`  PASS  ${msg}`) }
  else { failed++; console.log(`  FAIL  ${msg}`) }
}

function mkTmpDir(prefix, { git = false } = {}) {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  fs.mkdirSync(path.join(real, '.checkpoints'), { recursive: true })
  if (git) spawnSync('git', ['init', '-q'], { cwd: real })
  cleanups.push(() => fs.rmSync(real, { recursive: true, force: true }))
  return real
}

function mkFakeHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-home-')))
  fs.mkdirSync(path.join(home, '.checkpoints'), { recursive: true })
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function familyBasenames(sid) {
  return [`.preflight-done.${sid}`, `.last-user-prompt.${sid}.json`]
}

function seedFamilies(dir, sid, secondsAgo = 60) {
  for (const b of familyBasenames(sid)) {
    const p = path.join(dir, b)
    fs.writeFileSync(p, '{}')
    const ts = (Date.now() / 1000) - secondsAgo
    fs.utimesSync(p, ts, ts)
  }
}

function familiesExist(dir, sid) {
  return familyBasenames(sid).map(b => fs.existsSync(path.join(dir, b)))
}

function runSessionEnd(stdinCwd, sid, { home, processCwd } = {}) {
  return spawnSync('node', [SESSION_END], {
    input: JSON.stringify({ session_id: sid, cwd: stdinCwd, hook_event_name: 'SessionEnd' }),
    cwd: processCwd || stdinCwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home || mkFakeHome() },
  })
}

function runSessionStart(cwd, { home } = {}) {
  return spawnSync('node', [ENFORCE, '--session-start', '--session-id', SID_A], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home || mkFakeHome() },
  })
}

function mkWorktree(mainRepo) {
  // A linked worktree needs at least one commit in main.
  fs.writeFileSync(path.join(mainRepo, 'seed.txt'), 'seed')
  spawnSync('git', ['add', 'seed.txt'], { cwd: mainRepo })
  spawnSync('git', [
    '-c', 'user.email=juan.delacruz@acme.com', '-c', 'user.name=juan',
    'commit', '-q', '-m', 'seed',
  ], { cwd: mainRepo })
  const wt = path.join(mainRepo, '..', `${path.basename(mainRepo)}-wt`)
  spawnSync('git', ['worktree', 'add', '-q', wt], { cwd: mainRepo })
  fs.mkdirSync(path.join(wt, '.checkpoints'), { recursive: true })
  cleanups.push(() => fs.rmSync(wt, { recursive: true, force: true }))
  return fs.realpathSync(wt)
}

// ============================ B1: SessionEnd reap ============================

{
  console.log('R1: own-sid both families removed; other-sid preserved')
  const repo = mkTmpDir('reaper-r1-', { git: true })
  const ck = path.join(repo, '.checkpoints')
  seedFamilies(ck, SID_A)
  seedFamilies(ck, SID_B)
  const r = runSessionEnd(repo, SID_A)
  check(r.status === 0, `R1 exit 0 (got ${r.status})`)
  check(familiesExist(ck, SID_A).every(x => !x), 'R1 own-sid pair removed')
  check(familiesExist(ck, SID_B).every(x => x), 'R1 other-sid pair preserved')
}

{
  console.log('R2: invalid sid → both preserved')
  const repo = mkTmpDir('reaper-r2-', { git: true })
  const ck = path.join(repo, '.checkpoints')
  seedFamilies(ck, SID_A)
  const r = runSessionEnd(repo, '../evil/invalid')
  check(r.status === 0, `R2 exit 0 (got ${r.status})`)
  check(familiesExist(ck, SID_A).every(x => x), 'R2 families preserved on invalid sid')
}

{
  console.log('R3: nested cwd → reap at MAIN repo root; subdir canary untouched')
  const repo = mkTmpDir('reaper-r3-', { git: true })
  const sub = path.join(repo, 'sub')
  fs.mkdirSync(path.join(sub, '.checkpoints'), { recursive: true })
  seedFamilies(path.join(repo, '.checkpoints'), SID_A)
  seedFamilies(path.join(sub, '.checkpoints'), SID_A)
  const r = runSessionEnd(sub, SID_A)
  check(r.status === 0, `R3 exit 0 (got ${r.status})`)
  check(familiesExist(path.join(repo, '.checkpoints'), SID_A).every(x => !x),
    'R3 main-root pair removed (resolveRepoRoot(subdir) → repo)')
  check(familiesExist(path.join(sub, '.checkpoints'), SID_A).every(x => x),
    'R3 subdir canary untouched')
}

{
  console.log('R4: linked worktree → reap at MAIN root; worktree-local canary untouched')
  const repo = mkTmpDir('reaper-r4-', { git: true })
  const wt = mkWorktree(repo)
  seedFamilies(path.join(repo, '.checkpoints'), SID_A)
  seedFamilies(path.join(wt, '.checkpoints'), SID_A)
  const r = runSessionEnd(wt, SID_A)
  check(r.status === 0, `R4 exit 0 (got ${r.status})`)
  check(familiesExist(path.join(repo, '.checkpoints'), SID_A).every(x => !x),
    'R4 MAIN-root pair removed (worktree converges to main)')
  check(familiesExist(path.join(wt, '.checkpoints'), SID_A).every(x => x),
    'R4 worktree-local canary untouched')
}

{
  console.log('R5: non-git cwd → reap binds to cwd fallback')
  const dir = mkTmpDir('reaper-r5-')
  const ck = path.join(dir, '.checkpoints')
  seedFamilies(ck, SID_A)
  const r = runSessionEnd(dir, SID_A)
  check(r.status === 0, `R5 exit 0 (got ${r.status})`)
  check(familiesExist(ck, SID_A).every(x => !x), 'R5 cwd-fallback pair removed')
}

{
  console.log('R6: fake HOME .checkpoints never touched')
  const repo = mkTmpDir('reaper-r6-', { git: true })
  const home = mkFakeHome()
  seedFamilies(path.join(home, '.checkpoints'), SID_A)
  seedFamilies(path.join(repo, '.checkpoints'), SID_A)
  const r = runSessionEnd(repo, SID_A, { home })
  check(r.status === 0, `R6 exit 0 (got ${r.status})`)
  check(familiesExist(path.join(home, '.checkpoints'), SID_A).every(x => x),
    'R6 HOME canaries untouched')
  check(familiesExist(path.join(repo, '.checkpoints'), SID_A).every(x => !x),
    'R6 repo pair removed')
}

{
  console.log('R7: caller process-cwd != stdin .cwd → stdin .cwd wins')
  const repo = mkTmpDir('reaper-r7a-', { git: true })
  const caller = mkTmpDir('reaper-r7b-', { git: true })
  seedFamilies(path.join(repo, '.checkpoints'), SID_A)
  seedFamilies(path.join(caller, '.checkpoints'), SID_A)
  const r = runSessionEnd(repo, SID_A, { processCwd: caller })
  check(r.status === 0, `R7 exit 0 (got ${r.status})`)
  check(familiesExist(path.join(repo, '.checkpoints'), SID_A).every(x => !x),
    'R7 stdin-.cwd repo pair removed')
  check(familiesExist(path.join(caller, '.checkpoints'), SID_A).every(x => x),
    'R7 caller-cwd canary untouched')
}

// ============================ B2: SessionStart sweep ============================

{
  console.log('S1: 8-day-old suffixed pair reaped; fresh pair preserved')
  const repo = mkTmpDir('sweep-s1-', { git: true })
  const ck = path.join(repo, '.checkpoints')
  seedFamilies(ck, 'old-crashed-sid', 8 * DAY)
  seedFamilies(ck, SID_B, 3600)
  const r = runSessionStart(repo)
  check(r.status === 0, `S1 exit 0 (got ${r.status})`)
  check(familiesExist(ck, 'old-crashed-sid').every(x => !x), 'S1 8-day-old pair reaped')
  check(familiesExist(ck, SID_B).every(x => x), 'S1 fresh pair preserved')
}

{
  console.log('S2: legacy suffix-less .preflight-done (old) preserved — F7 scope')
  const repo = mkTmpDir('sweep-s2-', { git: true })
  const ck = path.join(repo, '.checkpoints')
  const legacy = path.join(ck, '.preflight-done')
  fs.writeFileSync(legacy, '')
  const ts = (Date.now() / 1000) - 30 * DAY
  fs.utimesSync(legacy, ts, ts)
  const r = runSessionStart(repo)
  check(r.status === 0, `S2 exit 0 (got ${r.status})`)
  check(fs.existsSync(legacy), 'S2 legacy suffix-less preserved')
}

{
  console.log('S3: symlink matching family RE preserved; target intact')
  const repo = mkTmpDir('sweep-s3-', { git: true })
  const ck = path.join(repo, '.checkpoints')
  const target = path.join(repo, 'external-target.json')
  fs.writeFileSync(target, '{}')
  const link = path.join(ck, '.preflight-done.linked-sid')
  fs.symlinkSync(target, link)
  const oldTs = (Date.now() / 1000) - 8 * DAY
  try { fs.lutimesSync(link, oldTs, oldTs) } catch {}
  fs.utimesSync(target, oldTs, oldTs)
  const r = runSessionStart(repo)
  check(r.status === 0, `S3 exit 0 (got ${r.status})`)
  check(fs.lstatSync(link).isSymbolicLink(), 'S3 symlink preserved (lstat skip)')
  check(fs.existsSync(target), 'S3 link target intact')
}

{
  console.log('S4: non-matching basenames (old) preserved')
  const repo = mkTmpDir('sweep-s4-', { git: true })
  const ck = path.join(repo, '.checkpoints')
  const strays = ['.preflight-done-extra', '.last-user-prompt.json', '.preflight-done.', '.my-notes.json']
  for (const b of strays) {
    const p = path.join(ck, b)
    fs.writeFileSync(p, '')
    const ts = (Date.now() / 1000) - 8 * DAY
    fs.utimesSync(p, ts, ts)
  }
  const r = runSessionStart(repo)
  check(r.status === 0, `S4 exit 0 (got ${r.status})`)
  check(strays.every(b => fs.existsSync(path.join(ck, b))), 'S4 all non-matching strays preserved')
}

{
  console.log('S5: nested cwd → sweep at MAIN root; subdir canary untouched')
  const repo = mkTmpDir('sweep-s5-', { git: true })
  const sub = path.join(repo, 'sub')
  fs.mkdirSync(path.join(sub, '.checkpoints'), { recursive: true })
  seedFamilies(path.join(repo, '.checkpoints'), 'old-crashed-sid', 8 * DAY)
  seedFamilies(path.join(sub, '.checkpoints'), 'old-crashed-sid', 8 * DAY)
  const r = runSessionStart(sub)
  check(r.status === 0, `S5 exit 0 (got ${r.status})`)
  check(familiesExist(path.join(repo, '.checkpoints'), 'old-crashed-sid').every(x => !x),
    'S5 main-root pair reaped (resolveRepoRoot(subdir) → repo)')
  check(familiesExist(path.join(sub, '.checkpoints'), 'old-crashed-sid').every(x => x),
    'S5 subdir canary untouched')
}

{
  console.log('S6: linked worktree cwd → sweep at MAIN root; worktree canary untouched')
  const repo = mkTmpDir('sweep-s6-', { git: true })
  const wt = mkWorktree(repo)
  seedFamilies(path.join(repo, '.checkpoints'), 'old-crashed-sid', 8 * DAY)
  seedFamilies(path.join(wt, '.checkpoints'), 'old-crashed-sid', 8 * DAY)
  const r = runSessionStart(wt)
  check(r.status === 0, `S6 exit 0 (got ${r.status})`)
  check(familiesExist(path.join(repo, '.checkpoints'), 'old-crashed-sid').every(x => !x),
    'S6 MAIN-root pair reaped (worktree converges to main)')
  check(familiesExist(path.join(wt, '.checkpoints'), 'old-crashed-sid').every(x => x),
    'S6 worktree-local canary untouched')
}

{
  console.log('S7: non-git cwd → sweep binds to cwd fallback')
  const dir = mkTmpDir('sweep-s7-')
  const ck = path.join(dir, '.checkpoints')
  seedFamilies(ck, 'old-crashed-sid', 8 * DAY)
  const r = runSessionStart(dir)
  check(r.status === 0, `S7 exit 0 (got ${r.status})`)
  check(familiesExist(ck, 'old-crashed-sid').every(x => !x), 'S7 cwd-fallback pair reaped')
}

{
  console.log('S8: fake HOME with its own old markers → never touched')
  const repo = mkTmpDir('sweep-s8-', { git: true })
  const home = mkFakeHome()
  seedFamilies(path.join(home, '.checkpoints'), 'old-crashed-sid', 8 * DAY)
  seedFamilies(path.join(repo, '.checkpoints'), 'old-crashed-sid', 8 * DAY)
  const r = runSessionStart(repo, { home })
  check(r.status === 0, `S8 exit 0 (got ${r.status})`)
  check(familiesExist(path.join(home, '.checkpoints'), 'old-crashed-sid').every(x => x),
    'S8 HOME canaries untouched')
  check(familiesExist(path.join(repo, '.checkpoints'), 'old-crashed-sid').every(x => !x),
    'S8 repo pair reaped')
}

console.log(`\nPassed: ${passed}\nFailed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
