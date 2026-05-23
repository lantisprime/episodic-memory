#!/usr/bin/env node
/**
 * test-classify-correction.mjs — Tests for classify-correction.mjs
 * covering the --allow-non-git opt-in + the shared hardened store-dir
 * validator (symlink reject, realpath equality, O_NOFOLLOW leaf, TOCTOU
 * recheck, EEXIST-tolerant first-time creation).
 *
 * 16 cases — see plan v6 §"Negative-matrix coverage (final v6)" plus
 * test 16 (linked worktree + --allow-non-git) added in impl review R1.
 *
 * Usage: node tests/test-classify-correction.mjs
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import crypto from 'crypto'
import { execFileSync, spawnSync, spawn } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CORRECTION = path.join(REPO, 'scripts', 'classify-correction.mjs')

let passed = 0
let failed = 0
const failures = []
const queue = []

function test(name, fn) {
  queue.push(async () => {
    try {
      await fn()
      passed++
      console.log(`  ✓ ${name}`)
    } catch (e) {
      failed++
      failures.push({ name, error: e.message })
      console.log(`  ✗ ${name}: ${e.message}`)
    }
  })
}

function mktmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cc-${prefix}-`)))
}

function mkrepo(name) {
  const dir = mktmp(name)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  return dir
}

function run(opts) {
  const { cwd, projectRoot, callerCwd, command = 'python3 foo.py', label = 'read_only', allowNonGit = false, env = {} } = opts
  const args = [CORRECTION,
    '--project-root', projectRoot,
    '--caller-cwd', callerCwd || cwd,
    '--command', command,
    '--label', label]
  if (allowNonGit) args.push('--allow-non-git')
  return spawnSync(process.execPath, args, {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8'
  })
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

// ── Tests ────────────────────────────────────────────────────────────────

// 1. Positive baseline — git mode, .episodic-memory auto-created
test('1. git mode positive (auto-create .episodic-memory)', async () => {
  const repo = mkrepo('t1')
  const r = run({ cwd: repo, projectRoot: repo })
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.strictEqual(out.status, 'ok')
  assert.strictEqual(out.label, 'read_only')
  const lines = readLines(path.join(repo, '.episodic-memory', 'classifier-overrides.jsonl'))
  assert.strictEqual(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.strictEqual(entry.label, 'read_only')
  assert.strictEqual(entry.allow_non_git, undefined)
})

// 2. Non-git mode without sentinel → exit 2
test('2. non-git mode without .episodic-memory → exit 2', async () => {
  const dir = mktmp('t2')
  const r = run({ cwd: dir, projectRoot: dir, allowNonGit: true })
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /has no \.episodic-memory/)
})

// 3. Non-git mode positive (sentinel pre-created)
test('3. non-git mode positive — sentinel exists', async () => {
  const dir = mktmp('t3')
  fs.mkdirSync(path.join(dir, '.episodic-memory'))
  const r = run({ cwd: dir, projectRoot: dir, allowNonGit: true })
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.strictEqual(out.status, 'ok')
  const lines = readLines(path.join(dir, '.episodic-memory', 'classifier-overrides.jsonl'))
  assert.strictEqual(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.strictEqual(entry.allow_non_git, true)
})

// 4. Cross-repo write rejected
test('4. cross-repo write → exit 2', async () => {
  const repoA = mkrepo('t4a')
  const repoB = mkrepo('t4b')
  const r = run({ cwd: repoA, projectRoot: repoB, callerCwd: repoA })
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /refusing cross-repo write/)
})

// 5. Dir symlink at sentinel (non-git mode) → exit 2
test('5. non-git: .episodic-memory is symlink → exit 2', async () => {
  const dir = mktmp('t5')
  const outside = mktmp('t5out')
  fs.symlinkSync(outside, path.join(dir, '.episodic-memory'))
  const r = run({ cwd: dir, projectRoot: dir, allowNonGit: true })
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /must be a real directory/)
})

// 6. Nested cwd — git mode (resolveRepoRoot walks subdir → repo root).
//    Non-git nested cwd is correctly rejected by the cross-repo guard
//    (resolveRepoRoot returns cwd unchanged without git context); that case
//    is covered indirectly by test 4. The useful coverage is git mode.
test('6. git mode: caller cwd nested under project root', async () => {
  const repo = mkrepo('t6')
  fs.mkdirSync(path.join(repo, 'sub'))
  const sub = path.join(repo, 'sub')
  const r = run({ cwd: sub, projectRoot: repo, callerCwd: sub })
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
  const lines = readLines(path.join(repo, '.episodic-memory', 'classifier-overrides.jsonl'))
  assert.strictEqual(lines.length, 1)
})

// 7. Dispatcher-readable shape (override entry has expected fields)
test('7. override entry shape matches dispatcher schema', async () => {
  const repo = mkrepo('t7')
  const r = run({ cwd: repo, projectRoot: repo, command: 'python3 foo.py', label: 'marker_write', env: {} })
  assert.strictEqual(r.status, 0)
  const entry = JSON.parse(readLines(path.join(repo, '.episodic-memory', 'classifier-overrides.jsonl'))[0])
  assert.strictEqual(entry.schema, 1)
  assert.ok(typeof entry.cache_key === 'string' && entry.cache_key.length === 64)
  assert.strictEqual(entry.label, 'marker_write')
  assert.ok(entry.tuple)
  assert.strictEqual(entry.tuple.project_root_canonical, repo)
  assert.strictEqual(entry.tuple.normalized_command, 'python3 foo.py')
})

// 8. Dir removed mid-flight (TOCTOU between Gate 2 and Gate 3)
test('8. TOCTOU: dir removed between gates → exit 2', async () => {
  const dir = mktmp('t8')
  fs.mkdirSync(path.join(dir, '.episodic-memory'))
  const proc = spawn(process.execPath, [CORRECTION,
    '--project-root', dir, '--caller-cwd', dir,
    '--command', 'python3 foo.py', '--label', 'read_only',
    '--allow-non-git'],
    { cwd: dir, env: { ...process.env, _CC_TEST_PAUSE_BEFORE_APPEND_MS: '800' } })
  let stderr = ''
  proc.stderr.on('data', d => { stderr += d })
  // Mid-flight: remove the directory
  await new Promise(res => setTimeout(res, 200))
  fs.rmSync(path.join(dir, '.episodic-memory'), { recursive: true, force: true })
  const code = await new Promise(res => proc.on('exit', res))
  assert.strictEqual(code, 2, `stderr: ${stderr}`)
  assert.match(stderr, /has no \.episodic-memory|must be a real directory/)
})

// 9. Dir replaced with symlink mid-flight
test('9. TOCTOU: dir replaced with symlink → exit 2', async () => {
  const dir = mktmp('t9')
  const outside = mktmp('t9out')
  fs.mkdirSync(path.join(dir, '.episodic-memory'))
  const proc = spawn(process.execPath, [CORRECTION,
    '--project-root', dir, '--caller-cwd', dir,
    '--command', 'python3 foo.py', '--label', 'read_only',
    '--allow-non-git'],
    { cwd: dir, env: { ...process.env, _CC_TEST_PAUSE_BEFORE_APPEND_MS: '800' } })
  let stderr = ''
  proc.stderr.on('data', d => { stderr += d })
  await new Promise(res => setTimeout(res, 200))
  fs.rmSync(path.join(dir, '.episodic-memory'), { recursive: true, force: true })
  fs.symlinkSync(outside, path.join(dir, '.episodic-memory'))
  const code = await new Promise(res => proc.on('exit', res))
  assert.strictEqual(code, 2, `stderr: ${stderr}`)
  assert.match(stderr, /must be a real directory/)
  // Outside dir must remain untouched
  const outsideContents = fs.readdirSync(outside)
  assert.strictEqual(outsideContents.length, 0, 'outside dir was written to')
})

// 10. Leaf is symlink (non-git)
test('10. non-git: classifier-overrides.jsonl is symlink → exit 2', async () => {
  const dir = mktmp('t10')
  const outsideFile = path.join(mktmp('t10out'), 'pwned.jsonl')
  fs.writeFileSync(outsideFile, '')
  fs.mkdirSync(path.join(dir, '.episodic-memory'))
  fs.symlinkSync(outsideFile, path.join(dir, '.episodic-memory', 'classifier-overrides.jsonl'))
  const r = run({ cwd: dir, projectRoot: dir, allowNonGit: true })
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`)
  assert.match(r.stderr, /is a symlink/)
  // Outside file untouched
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), '')
})

// 11. Leaf is symlink (git mode)
test('11. git mode: classifier-overrides.jsonl is symlink → exit 2', async () => {
  const repo = mkrepo('t11')
  const outsideFile = path.join(mktmp('t11out'), 'pwned.jsonl')
  fs.writeFileSync(outsideFile, '')
  fs.mkdirSync(path.join(repo, '.episodic-memory'))
  fs.symlinkSync(outsideFile, path.join(repo, '.episodic-memory', 'classifier-overrides.jsonl'))
  const r = run({ cwd: repo, projectRoot: repo })
  assert.strictEqual(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`)
  assert.match(r.stderr, /is a symlink/)
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), '')
})

// 12. Dir symlink at sentinel (git mode)
test('12. git mode: .episodic-memory is symlink → exit 2', async () => {
  const repo = mkrepo('t12')
  const outside = mktmp('t12out')
  fs.symlinkSync(outside, path.join(repo, '.episodic-memory'))
  const r = run({ cwd: repo, projectRoot: repo })
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /must be a real directory/)
  assert.strictEqual(fs.readdirSync(outside).length, 0)
})

// 13. First-time creation (git, single-process, .episodic-memory absent)
test('13. git mode: first-time creation succeeds', async () => {
  const repo = mkrepo('t13')
  assert.strictEqual(fs.existsSync(path.join(repo, '.episodic-memory')), false)
  const r = run({ cwd: repo, projectRoot: repo })
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
  const st = fs.lstatSync(path.join(repo, '.episodic-memory'))
  assert.ok(st.isDirectory() && !st.isSymbolicLink())
})

// 14. Linked-worktree positive — caller in worktree, writes to main
test('14. linked worktree: cwd in worktree, target main → writes under main', async () => {
  const main = mkrepo('t14main')
  // Need a commit to add a worktree
  fs.writeFileSync(path.join(main, 'README'), 'x\n')
  execFileSync('git', ['add', '.'], { cwd: main })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: main })
  const wtDir = mktmp('t14wt')
  // remove the empty dir so git worktree add can create it
  fs.rmdirSync(wtDir)
  execFileSync('git', ['worktree', 'add', '-q', wtDir, 'HEAD'], { cwd: main })
  const wtSub = path.join(fs.realpathSync(wtDir), 'sub')
  fs.mkdirSync(wtSub)
  const r = run({ cwd: wtSub, projectRoot: main, callerCwd: wtSub })
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
  // Artifact under MAIN, not worktree
  assert.ok(fs.existsSync(path.join(main, '.episodic-memory', 'classifier-overrides.jsonl')),
    'expected classifier-overrides.jsonl under main repo')
  assert.strictEqual(fs.existsSync(path.join(fs.realpathSync(wtDir), '.episodic-memory')), false,
    'worktree must NOT have .episodic-memory')
})

// 15. Concurrent first-time creation in git mode — both succeed, 2 lines
test('15. git mode: concurrent first-time creators race safely', async () => {
  const repo = mkrepo('t15')
  const spawnOne = (suffix) => spawn(process.execPath, [CORRECTION,
    '--project-root', repo, '--caller-cwd', repo,
    '--command', `python3 foo${suffix}.py`, '--label', 'read_only'],
    { cwd: repo, env: process.env })
  const p1 = spawnOne('A')
  const p2 = spawnOne('B')
  const [c1, c2] = await Promise.all([
    new Promise(res => p1.on('exit', res)),
    new Promise(res => p2.on('exit', res))
  ])
  assert.strictEqual(c1, 0, 'p1 should exit 0')
  assert.strictEqual(c2, 0, 'p2 should exit 0')
  const lines = readLines(path.join(repo, '.episodic-memory', 'classifier-overrides.jsonl'))
  assert.strictEqual(lines.length, 2, `expected 2 lines, got ${lines.length}`)
  // Both lines valid JSON
  for (const l of lines) JSON.parse(l)
  // .episodic-memory is a real directory
  const st = fs.lstatSync(path.join(repo, '.episodic-memory'))
  assert.ok(st.isDirectory() && !st.isSymbolicLink())
})

// 16. Linked worktree + --allow-non-git — explicit non-git-mode coverage of
//     the worktree axis. Main has .git (worktrees require it), but the
//     script skips the .git check under --allow-non-git, so the path
//     exercised is: resolveRepoRoot from worktree walks to main → cross-repo
//     guard matches → allowCreate:false branch verifies pre-created
//     .episodic-memory → append.
test('16. linked worktree + --allow-non-git: pre-created sentinel → writes under main', async () => {
  const main = mkrepo('t16main')
  fs.writeFileSync(path.join(main, 'README'), 'x\n')
  execFileSync('git', ['add', '.'], { cwd: main })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: main })
  // Pre-create the non-git-mode sentinel under MAIN
  fs.mkdirSync(path.join(main, '.episodic-memory'))
  const wtDir = mktmp('t16wt')
  fs.rmdirSync(wtDir)
  execFileSync('git', ['worktree', 'add', '-q', wtDir, 'HEAD'], { cwd: main })
  const wtReal = fs.realpathSync(wtDir)
  const wtSub = path.join(wtReal, 'sub')
  fs.mkdirSync(wtSub)
  const r = run({ cwd: wtSub, projectRoot: main, callerCwd: wtSub, allowNonGit: true })
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
  // Artifact under MAIN
  const mainFile = path.join(main, '.episodic-memory', 'classifier-overrides.jsonl')
  assert.ok(fs.existsSync(mainFile), 'expected classifier-overrides.jsonl under main repo')
  // NO .episodic-memory under worktree
  assert.strictEqual(fs.existsSync(path.join(wtReal, '.episodic-memory')), false,
    'worktree must NOT have .episodic-memory')
  // Entry stamped allow_non_git=true
  const entry = JSON.parse(readLines(mainFile)[0])
  assert.strictEqual(entry.allow_non_git, true)
})

// ── Runner ───────────────────────────────────────────────────────────────

console.log('classify-correction tests (--allow-non-git + hardened validator)')
for (const t of queue) await t()
console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.error}`)
  process.exit(1)
}
