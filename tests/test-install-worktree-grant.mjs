#!/usr/bin/env node
/**
 * test-install-worktree-grant.mjs — Tests for issue #213 install.mjs
 * worktree session permission grant (canonical .checkpoints/ in
 * settings.local.json `permissions.additionalDirectories`).
 *
 * Covers the 6-axis matrix from Codex round-1 plan-review reply
 * `20260509-073135-...-4fb5`:
 *   - Worktree case → grant added
 *   - Non-worktree (main repo) case → no grant
 *   - Manual existing entries preserved (read-modify-write merge)
 *   - Symlink/literal de-dup (realpath-keyed)
 *   - Malformed settings.local.json → fail-closed (no overwrite)
 *   - Nested cwd inside worktree → still detected
 *   - Re-run idempotence (no duplicate entries)
 *
 * Defensive ordering (per feedback_test_resource_existence_check.md):
 * each positive assertion is paired with its negative — "grant present at
 * worktree" + "grant absent at main" — so a misconfigured fixture cannot
 * silently pass.
 *
 * Class-completeness reference: this is the regression test demanded by
 * Codex finding F (issue #213 fix) + Rule 15 (regression at fix time).
 *
 * Usage: node tests/test-install-worktree-grant.mjs
 * Zero dependencies.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const INSTALL = path.join(REPO, 'install.mjs')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message, stack: e.stack })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function runInstall(cwd, projectDir, opts = {}) {
  // Run install.mjs --tool claude-code --project <projectDir> from <cwd>.
  // Capture stdout for assertions about the grant message.
  //
  // Test hermeticity (Codex round-2 MAJOR finding, 2026-05-09): install.mjs
  // Section 1 writes ~/.episodic-memory/{scripts,episodes,.verify-key,...}
  // unconditionally. Without HOME isolation the test (a) fails in CI/reviewer
  // sandboxes that can't write under the developer's real HOME, and (b) on
  // an unrestricted dev shell would mutate the developer's real global
  // episodic-memory install state and become order-dependent. Mirror the
  // existing pattern from tests/test-install-hooks.sh / test-install-bp1-
  // wiring.mjs by routing every installer subprocess through a per-test HOME.
  const env = { ...process.env, HOME: opts.home || tmpHome, ...(opts.env || {}) }
  return execSync(`node "${INSTALL}" --tool claude-code --project "${projectDir}"`, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function readSettings(p) {
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function additionalDirsOf(settings) {
  if (!settings || !settings.permissions) return []
  return settings.permissions.additionalDirectories || []
}

// Mirror install.mjs's normalizePathForGrant: realpath if the path exists,
// path.resolve fallback otherwise. The implementation writes paths through
// this normalization, so tests must compare entries through the same lens.
function safeRealpath(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

function hasGrantFor(dirs, canonicalCheckpointsReal) {
  return dirs.some(d => safeRealpath(d) === canonicalCheckpointsReal)
}

function countGrantsFor(dirs, canonicalCheckpointsReal) {
  return dirs.filter(d => safeRealpath(d) === canonicalCheckpointsReal).length
}

// ---------------------------------------------------------------------------
// Setup: a single tmp root holding a main repo + linked worktree + non-git
// dir. Each test below operates on a fresh sub-fixture under tmpRoot to
// avoid cross-test settings.local.json bleed.
//
// tmpHome: dedicated temp dir used as HOME for every installer subprocess
// (Codex round-2 hermeticity finding). install.mjs Section 1 writes under
// ~/.episodic-memory/, so without this isolation the test mutates real
// developer state and fails in sandboxes that can't write real HOME.
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-install-wt-grant-'))
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-install-wt-grant-home-'))
process.on('exit', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

function freshFixture(name) {
  const root = path.join(tmpRoot, name)
  const mainRepo = path.join(root, 'main')
  const worktreeRoot = path.join(root, 'wt')
  fs.mkdirSync(mainRepo, { recursive: true })
  git(mainRepo, 'init -q -b main')
  git(mainRepo, 'config user.email test@example.com')
  git(mainRepo, 'config user.name test')
  fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test\n')
  git(mainRepo, 'add README.md')
  git(mainRepo, 'commit -q -m init')
  git(mainRepo, `worktree add -q -b ${name}-branch ${worktreeRoot}`)
  return {
    root,
    mainRepo,
    mainRepoReal: fs.realpathSync(mainRepo),
    worktreeRoot,
    worktreeRootReal: fs.realpathSync(worktreeRoot),
    canonicalCheckpoints: path.join(fs.realpathSync(mainRepo), '.checkpoints'),
    worktreeSettingsLocal: path.join(worktreeRoot, '.claude', 'settings.local.json'),
    mainSettingsLocal: path.join(mainRepo, '.claude', 'settings.local.json'),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('test-install-worktree-grant.mjs — issue #213')

test('worktree case: grant appended to <worktree>/.claude/settings.local.json', () => {
  const f = freshFixture('basic-wt')
  const stdout = runInstall(f.worktreeRoot, f.worktreeRoot)
  const ws = readSettings(f.worktreeSettingsLocal)
  assert.ok(ws, 'settings.local.json should exist after install in worktree')
  const dirs = additionalDirsOf(ws)
  assert.ok(
    hasGrantFor(dirs, f.canonicalCheckpoints),
    `expected grant for ${f.canonicalCheckpoints} in additionalDirectories; got ${JSON.stringify(dirs)}`
  )
  assert.ok(stdout.includes('Granted worktree permission'), 'stdout should announce the grant')
})

test('non-worktree case (main repo): no grant added', () => {
  const f = freshFixture('basic-main')
  runInstall(f.mainRepo, f.mainRepo)
  const ms = readSettings(f.mainSettingsLocal)
  const dirs = additionalDirsOf(ms || {})
  assert.ok(
    !hasGrantFor(dirs, f.canonicalCheckpoints),
    `non-worktree install should not add the grant; got ${JSON.stringify(dirs)}`
  )
})

test('manual existing entries are preserved (merge, not replace)', () => {
  const f = freshFixture('preserve-manual')
  fs.mkdirSync(path.dirname(f.worktreeSettingsLocal), { recursive: true })
  const manualEntry = '/some/manual/dir'
  fs.writeFileSync(
    f.worktreeSettingsLocal,
    JSON.stringify({
      permissions: { additionalDirectories: [manualEntry] },
      somethingElse: 'preserved',
    }, null, 2)
  )
  runInstall(f.worktreeRoot, f.worktreeRoot)
  const ws = readSettings(f.worktreeSettingsLocal)
  const dirs = additionalDirsOf(ws)
  assert.ok(dirs.includes(manualEntry), 'manual entry must be preserved')
  assert.ok(
    hasGrantFor(dirs, f.canonicalCheckpoints),
    'canonical .checkpoints/ grant must be appended'
  )
  assert.strictEqual(ws.somethingElse, 'preserved', 'unrelated keys must survive')
})

test('symlink/literal de-dup: realpath-equal entries are not duplicated', () => {
  const f = freshFixture('symlink-dedup')
  fs.mkdirSync(f.canonicalCheckpoints, { recursive: true })
  const symlink = path.join(f.root, 'cp-symlink')
  fs.symlinkSync(f.canonicalCheckpoints, symlink)

  fs.mkdirSync(path.dirname(f.worktreeSettingsLocal), { recursive: true })
  fs.writeFileSync(
    f.worktreeSettingsLocal,
    JSON.stringify({ permissions: { additionalDirectories: [symlink] } }, null, 2)
  )
  runInstall(f.worktreeRoot, f.worktreeRoot)
  const ws = readSettings(f.worktreeSettingsLocal)
  const dirs = additionalDirsOf(ws)
  assert.strictEqual(dirs.length, 1, `expected 1 entry after dedup; got ${dirs.length}: ${JSON.stringify(dirs)}`)
})

test('malformed settings.local.json: fail-closed, no overwrite', () => {
  const f = freshFixture('malformed')
  fs.mkdirSync(path.dirname(f.worktreeSettingsLocal), { recursive: true })
  const bad = '{ this is not: valid json '
  fs.writeFileSync(f.worktreeSettingsLocal, bad)
  // Route through runInstall so HOME isolation applies (Codex round-2 fix).
  let stderrOut = ''
  let stdoutOut = ''
  try {
    stdoutOut = runInstall(f.worktreeRoot, f.worktreeRoot)
  } catch (e) {
    stderrOut = e.stderr ? e.stderr.toString() : ''
    stdoutOut = e.stdout ? e.stdout.toString() : ''
  }
  // The install should NOT crash the whole process — it surfaces an Error
  // log and skips just the grant. Other install steps continue.
  // The malformed file must remain untouched (no atomic overwrite).
  assert.strictEqual(fs.readFileSync(f.worktreeSettingsLocal, 'utf8'), bad,
    'malformed settings.local.json must not be overwritten')
  assert.ok(
    stdoutOut.includes('not valid JSON') || stderrOut.includes('not valid JSON'),
    `expected "not valid JSON" diagnostic; stdout=${stdoutOut} stderr=${stderrOut}`
  )
})

test('nested cwd inside worktree: still detected as worktree', () => {
  const f = freshFixture('nested-cwd')
  const nested = path.join(f.worktreeRoot, 'a', 'b', 'c')
  fs.mkdirSync(nested, { recursive: true })
  // Run install from nested cwd, but --project still points at worktree root
  // (matches realistic usage; install.mjs's projectDir is the --project flag).
  runInstall(nested, f.worktreeRoot)
  const ws = readSettings(f.worktreeSettingsLocal)
  const dirs = additionalDirsOf(ws)
  assert.ok(
    hasGrantFor(dirs, f.canonicalCheckpoints),
    'nested cwd within worktree should still produce the grant'
  )
})

test('re-run idempotence: second install does not duplicate the grant', () => {
  const f = freshFixture('idempotent')
  runInstall(f.worktreeRoot, f.worktreeRoot)
  const ws1 = readSettings(f.worktreeSettingsLocal)
  const dirs1 = additionalDirsOf(ws1)
  assert.strictEqual(countGrantsFor(dirs1, f.canonicalCheckpoints), 1, 'first install: exactly one grant entry')

  runInstall(f.worktreeRoot, f.worktreeRoot)
  const ws2 = readSettings(f.worktreeSettingsLocal)
  const dirs2 = additionalDirsOf(ws2)
  assert.strictEqual(countGrantsFor(dirs2, f.canonicalCheckpoints), 1, 'second install: still exactly one grant entry (idempotent)')
  assert.deepStrictEqual(dirs1, dirs2, 'array contents identical across re-runs')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('')
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) {
    console.log(`\n✗ ${f.name}`)
    console.log(f.stack || f.error)
  }
  process.exit(1)
}
