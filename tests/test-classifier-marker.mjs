#!/usr/bin/env node
/**
 * test-classifier-marker.mjs — Tests for scripts/classifier-marker.mjs
 *
 * Covers the agent-self-classify + marker-gate design (replaces PR #326's
 * direct-API Tier 3 dispatch). Tests assert:
 *
 *   §M1   write + read round-trip in honest single-session case
 *   §M2   multi-session: same command from session A and session B write
 *         to DIFFERENT marker paths; session A's read can never see B's
 *   §M3   multi-project: same command from project P1 and P2 write under
 *         different .checkpoints/classify/ dirs; cross-repo write refused
 *   §M4   cross-session env defense: CLAUDE_CODE_SESSION_ID env mismatch
 *         with --session-id flag → refused
 *   §M5   cross-repo write: resolveRepoRoot(cwd) != --project-root → refused
 *   §M6   helper requires explicit cwd: subprocess invoked with cwd != root
 *         → refused
 *   §M7   write-once-or-same: concurrent writers for same tuple are no-ops
 *   §M8   marker leaf symlink → write refused, read refused
 *   §M9   marker store ancestor symlink → write refused
 *   §M10  expired marker (past _expires_at) → read returns stale
 *   §M11  schema/policy/command version mismatch → read rejects as tamper
 *   §M12  adversarial label in marker body → read rejects
 *   §M13  vacuum reaps stale markers (>30d mtime), preserves fresh ones
 *   §M14  vacuum never touches symlinks even when stale
 *
 * Zero-dep: uses node:test + assert + fs + child_process.
 *
 * Usage: node tests/test-classifier-marker.mjs
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import assert from 'assert'
import { execFileSync, spawnSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HELPER = path.join(REPO, 'scripts', 'classifier-marker.mjs')

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
      failures.push({ name, error: e.message, stack: e.stack })
      console.log(`  ✗ ${name}: ${e.message}`)
    }
  })
}

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clsmarker-${prefix}-`))
}

function mkrepo(name) {
  const dir = mktmp(name)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  return fs.realpathSync(dir)
}

function runHelper(args, opts = {}) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: 15000
  })
}

function parseStdout(r) {
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null') }
  catch { return null }
}

// ----- §M1: write + read round-trip -----
test('§M1 honest single-session write + read round-trip', () => {
  const repo = mkrepo('m1')
  const sid = 's_m1_' + crypto.randomBytes(4).toString('hex')
  const cmd = 'node ./scripts/foo.mjs --arg=value'

  const w = runHelper(['--write',
    '--project-root', repo,
    '--caller-cwd', repo,
    '--command', cmd,
    '--session-id', sid,
    '--label', 'shared_write',
    '--confidence', '0.85',
    '--reason', 'writes to project files'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w.status, 0, `write failed: ${w.stderr}`)
  const wj = parseStdout(w)
  assert.ok(wj.status === 'written' || wj.status === 'noop_same_tuple', `bad write status: ${wj.status}`)
  assert.strictEqual(wj.label, 'shared_write')

  const r = runHelper(['--read',
    '--project-root', repo,
    '--caller-cwd', repo,
    '--command', cmd,
    '--session-id', sid
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 0, `read failed: ${r.stderr}`)
  const rj = parseStdout(r)
  assert.strictEqual(rj.status, 'hit')
  assert.strictEqual(rj.label, 'shared_write')
})

// ----- §M2: multi-session isolation -----
test('§M2 multi-session: same command in 2 sessions → different markers, no cross-read', () => {
  const repo = mkrepo('m2')
  const sidA = 's_A_' + crypto.randomBytes(4).toString('hex')
  const sidB = 's_B_' + crypto.randomBytes(4).toString('hex')
  const cmd = 'node ./scripts/foo.mjs'

  // Session A writes read_only
  const wA = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sidA,
    '--label', 'read_only', '--confidence', '0.9', '--reason', 'session A view'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(wA.status, 0, `A write: ${wA.stderr}`)
  const fileA = parseStdout(wA).file

  // Session B writes shared_write
  const wB = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sidB,
    '--label', 'shared_write', '--confidence', '0.9', '--reason', 'session B view'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(wB.status, 0, `B write: ${wB.stderr}`)
  const fileB = parseStdout(wB).file

  // Different marker paths
  assert.notStrictEqual(fileA, fileB, 'sessions A and B must write to different marker paths')

  // Both files exist independently
  assert.ok(fs.existsSync(fileA), 'session A marker missing on disk')
  assert.ok(fs.existsSync(fileB), 'session B marker missing on disk')

  // Session A reads its own → hit with read_only
  const rA = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sidA
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  const rAj = parseStdout(rA)
  assert.strictEqual(rAj.status, 'hit')
  assert.strictEqual(rAj.label, 'read_only', 'session A must read its own label')

  // Session B reads its own → hit with shared_write
  const rB = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sidB
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  const rBj = parseStdout(rB)
  assert.strictEqual(rBj.status, 'hit')
  assert.strictEqual(rBj.label, 'shared_write', 'session B must read its own label')
})

// ----- §M3: multi-project isolation -----
test('§M3 multi-project: same command in 2 projects → different stores, cross-repo write refused', () => {
  const repo1 = mkrepo('m3p1')
  const repo2 = mkrepo('m3p2')
  const sid = 's_m3_' + crypto.randomBytes(4).toString('hex')
  const cmd = 'node ./scripts/foo.mjs'

  // Write to repo1 from repo1's cwd
  const w1 = runHelper(['--write',
    '--project-root', repo1, '--caller-cwd', repo1,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '0.9', '--reason', 'p1'
  ], { cwd: repo1, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w1.status, 0, `p1 write: ${w1.stderr}`)

  // Write to repo2 from repo2's cwd
  const w2 = runHelper(['--write',
    '--project-root', repo2, '--caller-cwd', repo2,
    '--command', cmd, '--session-id', sid,
    '--label', 'shared_write', '--confidence', '0.9', '--reason', 'p2'
  ], { cwd: repo2, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w2.status, 0, `p2 write: ${w2.stderr}`)

  // Markers land under their own project's .checkpoints/classify/
  const dir1 = path.join(repo1, '.checkpoints', 'classify')
  const dir2 = path.join(repo2, '.checkpoints', 'classify')
  assert.ok(fs.readdirSync(dir1).length > 0, 'p1 marker dir empty')
  assert.ok(fs.readdirSync(dir2).length > 0, 'p2 marker dir empty')
  // No markers cross-pollinate
  const inP1ForP2 = fs.readdirSync(dir1).filter(f =>
    fs.readFileSync(path.join(dir1, f), 'utf8').includes(repo2))
  assert.strictEqual(inP1ForP2.length, 0, 'p2 marker leaked into p1 store')

  // Cross-repo write attempt: from repo1 cwd, target repo2 → REFUSED
  const xw = runHelper(['--write',
    '--project-root', repo2, '--caller-cwd', repo2,
    '--command', cmd, '--session-id', sid,
    '--label', 'unsafe_complex', '--confidence', '1', '--reason', 'cross-repo'
  ], { cwd: repo1, env: { CLAUDE_CODE_SESSION_ID: '' } })  // cwd is repo1 but target is repo2
  assert.strictEqual(xw.status, 2, 'cross-repo write must fail with exit 2')
  assert.match(xw.stderr, /refusing cross-repo write/)
})

// ----- §M4: CLAUDE_CODE_SESSION_ID env defense -----
test('§M4 env vs argv session-id mismatch → refused', () => {
  const repo = mkrepo('m4')
  const r = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'ls', '--session-id', 'forged-sid',
    '--label', 'read_only', '--confidence', '1', '--reason', 'x'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: 'authentic-sid' } })
  assert.strictEqual(r.status, 2, 'env-mismatch must refuse')
  assert.match(r.stderr, /refusing cross-session write/)
})

// ----- §M5: cross-repo write refused at resolveRepoRoot boundary -----
test('§M5 resolveRepoRoot != --project-root → refused', () => {
  const repo = mkrepo('m5a')
  const otherRepo = mkrepo('m5b')
  // cwd is otherRepo but --project-root is repo
  const r = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'ls', '--session-id', 'sid-x',
    '--label', 'read_only', '--confidence', '1', '--reason', 'x'
  ], { cwd: otherRepo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 2, 'mismatched root must refuse')
  assert.match(r.stderr, /refusing cross-repo write/)
})

// ----- §M6: helper cwd binding -----
test('§M6 caller cwd may differ from --project-root, but helper subprocess cwd MUST equal --project-root', () => {
  const repo = mkrepo('m6')
  const callerCwd = mktmp('m6caller')
  // Helper invocation with cwd: repo (correct) — caller cwd field differs
  const w = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', callerCwd,
    '--command', 'ls', '--session-id', 'sid-m6',
    '--label', 'read_only', '--confidence', '1', '--reason', 'caller elsewhere'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w.status, 0, `correct subprocess cwd should succeed: ${w.stderr}`)
  // Marker lands under repo, NOT under callerCwd
  const markerDir = path.join(repo, '.checkpoints', 'classify')
  assert.ok(fs.readdirSync(markerDir).length > 0, 'marker missing under target')
  assert.ok(!fs.existsSync(path.join(callerCwd, '.checkpoints')), 'marker leaked under caller cwd')

  // Helper invocation with cwd: callerCwd (wrong) → refused
  const w2 = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', callerCwd,
    '--command', 'ls', '--session-id', 'sid-m6b',
    '--label', 'read_only', '--confidence', '1', '--reason', 'wrong cwd'
  ], { cwd: callerCwd, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w2.status, 2, 'wrong subprocess cwd must refuse')
})

// ----- §M7: write-once-or-same -----
test('§M7 concurrent same-tuple writers are no-op success', () => {
  const repo = mkrepo('m7')
  const sid = 'sid-m7'
  const cmd = 'node ./scripts/x.mjs'

  const w1 = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '0.9', '--reason', 'first'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w1.status, 0)
  const j1 = parseStdout(w1)
  assert.strictEqual(j1.status, 'written')

  // Second writer with same tuple
  const w2 = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '0.9', '--reason', 'second'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w2.status, 0, `second writer must succeed: ${w2.stderr}`)
  const j2 = parseStdout(w2)
  assert.strictEqual(j2.status, 'noop_same_tuple', `expected noop_same_tuple, got ${j2.status}`)
  assert.strictEqual(j1.file, j2.file)
})

// ----- §M8: marker leaf symlink → write/read refused -----
test('§M8 marker leaf symlink → write refuses (O_NOFOLLOW)', () => {
  const repo = mkrepo('m8')
  // First do a real write to create the dir
  runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'ls', '--session-id', 'sid-m8',
    '--label', 'read_only', '--confidence', '1', '--reason', 'seed'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })

  // Plant a symlink at a marker path that a DIFFERENT command's sha would produce
  const dir = path.join(repo, '.checkpoints', 'classify')
  const targetPath = path.join('/tmp', 'symlink-target-' + crypto.randomBytes(4).toString('hex'))
  fs.writeFileSync(targetPath, '{}')
  // We can't easily predict the sha, but we can simulate the attack by making
  // the FIRST write produce a symlinked marker. Cheaper test: pre-place a
  // symlink at any *.json under classify/ and verify a subsequent write to
  // THAT specific sha gets rejected. Use a known cmd to compute predictable
  // tuple — but the sha changes per session. Instead, verify the O_NOFOLLOW
  // open path: pre-create temp file as symlink, run helper, observe behavior.
  //
  // Concretely: place a symlink at a future temp-write path basename pattern.
  // The helper writes to `.<sha>.<pid>.<ts>.<rand>.tmp` — these paths are
  // unpredictable, so direct symlink injection at the temp is impractical.
  // Instead test the leaf-overwrite path: pre-create a symlink AT the final
  // marker path and trigger overwrite.

  // Run a write to get the sha used
  const w0 = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'unique-m8-cmd', '--session-id', 'sid-m8',
    '--label', 'read_only', '--confidence', '1', '--reason', 'first'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w0.status, 0)
  const sha = parseStdout(w0).cache_key
  const markerPath = path.join(dir, `${sha}.json`)
  // Remove the legit marker, replace with symlink
  fs.unlinkSync(markerPath)
  fs.symlinkSync(targetPath, markerPath)

  // Trigger an overwrite (stale → overwrite path). The lstat check rejects.
  // Same tuple = noop_same_tuple, BUT because we removed the real file and
  // replaced with symlink, the existsSync check sees the symlink as existing,
  // the JSON.parse of symlinked target succeeds (`{}` is valid JSON), but
  // tuple-match fails → tries to overwrite → leaf lstat catches symlink.
  const w1 = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'unique-m8-cmd', '--session-id', 'sid-m8',
    '--label', 'shared_write', '--confidence', '1', '--reason', 'attempt overwrite'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  // Either O_NOFOLLOW on temp or lstat on target catches it.
  assert.strictEqual(w1.status, 2, 'symlink leaf overwrite must be refused')
  assert.match(w1.stderr, /symlink/, `expected symlink rejection: ${w1.stderr}`)

  // Read also refuses
  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'unique-m8-cmd', '--session-id', 'sid-m8'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 1, 'read through symlink must miss/reject')
  const rj = parseStdout(r)
  assert.strictEqual(rj.status, 'reject')
  assert.strictEqual(rj.reason, 'marker_is_symlink')

  fs.unlinkSync(targetPath)
})

// ----- §M9: marker store ancestor symlink → write refused -----
test('§M9 .checkpoints/ symlinked → write refuses', () => {
  const repo = mkrepo('m9')
  // Replace .checkpoints with a symlink to /tmp
  const elsewhere = mktmp('m9-target')
  fs.symlinkSync(elsewhere, path.join(repo, '.checkpoints'))
  const w = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'ls', '--session-id', 'sid-m9',
    '--label', 'read_only', '--confidence', '1', '--reason', 'x'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w.status, 2, 'symlinked .checkpoints must refuse')
  assert.match(w.stderr, /must be a real directory/)
})

// ----- §M10: expired marker → stale -----
test('§M10 expired marker → read reports stale', () => {
  const repo = mkrepo('m10')
  const sid = 'sid-m10'
  const cmd = 'ls'
  const w = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '1', '--reason', 'x'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w.status, 0)
  const sha = parseStdout(w).cache_key
  const markerFile = path.join(repo, '.checkpoints', 'classify', `${sha}.json`)
  // Rewrite _expires_at to past
  const body = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  body._expires_at = new Date(Date.now() - 60_000).toISOString()
  fs.writeFileSync(markerFile, JSON.stringify(body, null, 2))

  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 1)
  assert.strictEqual(parseStdout(r).status, 'stale')
})

// ----- §M11: schema-version tamper rejection -----
test('§M11 _marker_version mismatch → read rejects as tamper', () => {
  const repo = mkrepo('m11')
  const sid = 'sid-m11'
  const cmd = 'ls'
  const w = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '1', '--reason', 'x'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  const sha = parseStdout(w).cache_key
  const markerFile = path.join(repo, '.checkpoints', 'classify', `${sha}.json`)
  const body = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  body._marker_version = 999  // tamper
  fs.writeFileSync(markerFile, JSON.stringify(body, null, 2))
  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 1)
  assert.match(parseStdout(r).reason, /marker_schema_mismatch/)
})

// ----- §M12: adversarial label in marker body -----
test('§M12 unknown label in marker body → read rejects', () => {
  const repo = mkrepo('m12')
  const sid = 'sid-m12'
  const cmd = 'ls'
  const w = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '1', '--reason', 'x'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  const sha = parseStdout(w).cache_key
  const markerFile = path.join(repo, '.checkpoints', 'classify', `${sha}.json`)
  const body = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  body.label = 'evil_inject'  // not in LABELS
  fs.writeFileSync(markerFile, JSON.stringify(body, null, 2))
  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 1)
  assert.match(parseStdout(r).reason, /invalid_label/)
})

// ----- §M13: vacuum reaps stale markers -----
test('§M13 vacuum reaps stale (>maxAge) markers, preserves fresh', () => {
  const repo = mkrepo('m13')
  const sid = 'sid-m13'
  // Write two markers
  const wA = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'old-cmd', '--session-id', sid,
    '--label', 'read_only', '--confidence', '1', '--reason', 'old'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  const wB = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'fresh-cmd', '--session-id', sid,
    '--label', 'read_only', '--confidence', '1', '--reason', 'fresh'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  const fileA = parseStdout(wA).file
  const fileB = parseStdout(wB).file

  // Backdate file A's mtime to 60d ago
  const ago = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000
  fs.utimesSync(fileA, ago, ago)

  const v = runHelper(['--vacuum', '--project-root', repo, '--max-age-days', '30'],
    { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(v.status, 0, `vacuum: ${v.stderr}`)
  const vj = parseStdout(v)
  assert.strictEqual(vj.removed, 1, `expected 1 removed, got ${vj.removed}`)
  assert.ok(!fs.existsSync(fileA), 'stale marker not removed')
  assert.ok(fs.existsSync(fileB), 'fresh marker incorrectly removed')
})

// ----- §M15: codex code-review BLOCKER #1 regression — --read with symlinked .checkpoints/ -----
test('§M15 (codex CR BLOCKER #1) symlinked .checkpoints/ → --read refuses', () => {
  const repo = mkrepo('m15')
  const elsewhere = mktmp('m15-elsewhere')
  // Plant a fake "hit" payload at the external store
  fs.mkdirSync(path.join(elsewhere, 'classify'), { recursive: true })
  // Symlink .checkpoints → elsewhere
  fs.symlinkSync(elsewhere, path.join(repo, '.checkpoints'))
  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'ls', '--session-id', 'sid-m15'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  // Must refuse, not follow the symlink to read external content.
  assert.strictEqual(r.status, 2, `--read through symlinked ancestor must refuse; got status=${r.status}`)
  assert.match(r.stderr, /must be a real directory/, `expected ancestor rejection: ${r.stderr}`)
})

// ----- §M16: codex code-review BLOCKER #1 regression — --vacuum with symlinked .checkpoints/ -----
test('§M16 (codex CR BLOCKER #1) symlinked .checkpoints/ → --vacuum refuses (no external deletion)', () => {
  const repo = mkrepo('m16')
  const external = mktmp('m16-external')
  // Plant an external "stale" marker that vacuum would delete IF it followed the symlink
  const externalClassify = path.join(external, 'classify')
  fs.mkdirSync(externalClassify, { recursive: true })
  const externalMarker = path.join(externalClassify, 'fake.json')
  fs.writeFileSync(externalMarker, '{}')
  const ago = (Date.now() - 100 * 86400 * 1000) / 1000
  fs.utimesSync(externalMarker, ago, ago)
  // Symlink .checkpoints → external
  fs.symlinkSync(external, path.join(repo, '.checkpoints'))

  const v = runHelper(['--vacuum', '--project-root', repo, '--max-age-days', '30'],
    { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(v.status, 2, `--vacuum through symlinked ancestor must refuse; got status=${v.status}`)
  // External file MUST still exist — vacuum must not have followed the symlink.
  assert.ok(fs.existsSync(externalMarker), 'vacuum deleted external file via symlinked ancestor (BLOCKER reproduced)')
})

// ----- §M17: codex code-review BLOCKER #2 regression — leaf-symlink-same-tuple bypass -----
test('§M17 (codex CR BLOCKER #2) leaf symlink with same-tuple body → write still refuses', () => {
  const repo = mkrepo('m17')
  const sid = 'sid-m17'
  const cmd = 'unique-m17-cmd'
  // First, do a legitimate write
  const w0 = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '1', '--reason', 'seed'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w0.status, 0)
  const sha = parseStdout(w0).cache_key
  const markerPath = path.join(repo, '.checkpoints', 'classify', `${sha}.json`)
  const legitBody = fs.readFileSync(markerPath, 'utf8')

  // Move the real marker outside the repo
  const elsewhere = mktmp('m17-elsewhere')
  const externalMarker = path.join(elsewhere, 'real-marker.json')
  fs.writeFileSync(externalMarker, legitBody)   // SAME tuple, valid body
  fs.unlinkSync(markerPath)
  fs.symlinkSync(externalMarker, markerPath)

  // Trigger a write that would hit the same-tuple noop path
  const w1 = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', 'read_only', '--confidence', '1', '--reason', 'attempt bypass'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  // Must refuse — lstat-FIRST detects the symlink before the same-tuple
  // check ever runs.
  assert.strictEqual(w1.status, 2, `leaf symlink with same-tuple body MUST refuse; got status=${w1.status}`)
  assert.match(w1.stderr, /symlink/, `expected symlink rejection: ${w1.stderr}`)
})

// ----- §M14: vacuum skips symlinks -----
test('§M14 vacuum never touches symlinks (even stale by mtime)', () => {
  const repo = mkrepo('m14')
  const dir = path.join(repo, '.checkpoints', 'classify')
  fs.mkdirSync(dir, { recursive: true })
  const target = mktmp('m14-target')
  const targetFile = path.join(target, 'inner.json')
  fs.writeFileSync(targetFile, '{}')
  const symlinkPath = path.join(dir, 'symlinked.json')
  fs.symlinkSync(targetFile, symlinkPath)
  // Backdate the SYMLINK's mtime
  const ago = (Date.now() - 100 * 24 * 60 * 60 * 1000) / 1000
  try { fs.lutimesSync(symlinkPath, ago, ago) } catch {}

  const v = runHelper(['--vacuum', '--project-root', repo, '--max-age-days', '30'],
    { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(v.status, 0)
  // Symlink should survive (vacuum skips symlinks)
  assert.ok(fs.lstatSync(symlinkPath).isSymbolicLink(), 'vacuum removed symlink — must not')
})

// ----- PR-B: --command-file flag (#333 deny-hint round-trip support) -----
test('§CF1 --command-file round-trips to the same cache_key as inline --command', () => {
  const repo = mkrepo('cf1')
  const sid = 's_cf1_' + crypto.randomBytes(4).toString('hex')
  const cmd = "node /My Scripts/inspect.mjs --flag 'a b'"
  const cmdFile = path.join(repo, 'cmd.txt')
  fs.writeFileSync(cmdFile, cmd) // verbatim, no trailing newline

  const inline = parseStdout(runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } }))
  const viaFile = parseStdout(runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command-file', cmdFile, '--session-id', sid
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } }))
  assert.ok(inline && viaFile, 'both reads returned JSON')
  assert.strictEqual(viaFile.cache_key, inline.cache_key,
    `--command-file must yield the same cache_key as inline --command (got ${viaFile.cache_key} vs ${inline.cache_key})`)
})

test('§CF2 --command and --command-file are mutually exclusive', () => {
  const repo = mkrepo('cf2')
  const cmdFile = path.join(repo, 'cmd.txt')
  fs.writeFileSync(cmdFile, 'node x.mjs')
  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', 'node y.mjs', '--command-file', cmdFile,
    '--session-id', 'sid_cf2_aaaa'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 2, 'expected exit 2')
  assert.match(r.stderr, /mutually exclusive/, `expected mutual-exclusion error; got: ${r.stderr}`)
})

test('§CF3 --command-file over the 64 KiB cap → error', () => {
  const repo = mkrepo('cf3')
  const cmdFile = path.join(repo, 'big.txt')
  fs.writeFileSync(cmdFile, 'x'.repeat(64 * 1024 + 1))
  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command-file', cmdFile, '--session-id', 'sid_cf3_aaaa'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(r.status, 2, 'expected exit 2')
  assert.match(r.stderr, /exceeds .* bytes/, `expected oversize error; got: ${r.stderr}`)
})

test('§CF4 --command-file write then inline --read hit (write path honors --command-file)', () => {
  const repo = mkrepo('cf4')
  const sid = 's_cf4_' + crypto.randomBytes(4).toString('hex')
  const cmd = "cat '/My Notes/todo.txt'"
  const cmdFile = path.join(repo, 'cmd.txt')
  fs.writeFileSync(cmdFile, cmd)
  const w = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command-file', cmdFile, '--session-id', sid,
    '--label', 'read_only', '--confidence', '0.9', '--reason', 'via command-file'
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } })
  assert.strictEqual(w.status, 0, `write failed: ${w.stderr}`)
  const r = parseStdout(runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid
  ], { cwd: repo, env: { CLAUDE_CODE_SESSION_ID: '' } }))
  assert.strictEqual(r.status, 'hit', 'inline --read must hit the marker written via --command-file')
  assert.strictEqual(r.label, 'read_only')
})

// ----- Runner -----
async function run() {
  console.log('classifier-marker.mjs tests')
  for (const t of queue) await t()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  ${f.name}: ${f.error}`)
    process.exit(1)
  }
}
run().catch(e => { console.error(e); process.exit(1) })
