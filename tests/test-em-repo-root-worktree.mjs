#!/usr/bin/env node
/**
 * test-em-repo-root-worktree.mjs — Tests for #106 armCheckpointMarker
 * worktree-orphan + scripts/lib/local-dir.mjs:resolveRepoRoot extraction.
 *
 * Two layers of verification:
 *   1. Resolver unit tests — resolveRepoRoot returns the main repo working
 *      tree from main / linked worktree / nested cwd / non-git / submodule.
 *   2. Integration regression tests — em-recall.mjs invoked from a linked
 *      worktree writes .checkpoint-required at <main>/.claude/, not
 *      <worktree>/.claude/. em-session-end-prompt.mjs invoked from a worktree
 *      cleans markers at <main>/.claude/, not <worktree>/.claude/.
 *
 * Defensive ordering (per feedback_test_resource_existence_check.md):
 * each integration assertion checks BOTH "marker exists at main" AND
 * "marker does not exist at worktree" — the negative assertion is the
 * load-bearing one. Otherwise a misconfigured test that races cleanup
 * against the assertion would silently pass.
 *
 * Usage: node tests/test-em-repo-root-worktree.mjs
 * Zero dependencies.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'
import { resolveRepoRoot } from '../scripts/lib/local-dir.mjs'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const RECALL = path.join(SCRIPTS, 'em-recall.mjs')
const STORE = path.join(SCRIPTS, 'em-store.mjs')
const SESSION_END = path.join(SCRIPTS, 'em-session-end-prompt.mjs')

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
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

// ---------------------------------------------------------------------------
// Setup: temp main repo + linked worktree + nested dir + non-git dir
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-reporoot-'))
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }))

const mainRepo = path.join(tmpRoot, 'main')
const worktreeRoot = path.join(tmpRoot, 'wt')
const nestedDir = path.join(worktreeRoot, 'a', 'b', 'c')
const nonGitDir = path.join(tmpRoot, 'plain')

fs.mkdirSync(mainRepo, { recursive: true })
fs.mkdirSync(nonGitDir, { recursive: true })

git(mainRepo, 'init -q -b main')
git(mainRepo, 'config user.email test@example.com')
git(mainRepo, 'config user.name test')
fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test\n')
git(mainRepo, 'add README.md')
git(mainRepo, 'commit -q -m init')
git(mainRepo, `worktree add -q -b wt-branch ${worktreeRoot}`)
fs.mkdirSync(nestedDir, { recursive: true })

const mainRepoReal = fs.realpathSync(mainRepo)
const worktreeRootReal = fs.realpathSync(worktreeRoot)
const nonGitDirReal = fs.realpathSync(nonGitDir)

// Seed a recent bp-001 violation in mainRepo's local store so em-recall
// will arm the checkpoint marker. Use em-store --scope local — post-PR #105
// resolveLocalDir routes to mainRepo regardless of cwd.
execSync(
  `node ${STORE} --scope local --project test ` +
  `--category violation ` +
  `--tags "violated:bp-001-implementation-workflow,test-fixture" ` +
  `--summary "test fixture violation" ` +
  `--body "Seeded by test-em-repo-root-worktree.mjs to trigger marker arming."`,
  { cwd: mainRepo, stdio: ['ignore', 'pipe', 'pipe'] },
)

// ---------------------------------------------------------------------------
// Layer 1 — resolveRepoRoot unit tests
// ---------------------------------------------------------------------------

test('resolveRepoRoot: main checkout returns main repo working tree', () => {
  const got = fs.realpathSync(resolveRepoRoot(mainRepo))
  assert.strictEqual(got, mainRepoReal)
})

test('resolveRepoRoot: linked worktree returns MAIN repo working tree (not worktree)', () => {
  const got = fs.realpathSync(resolveRepoRoot(worktreeRoot))
  assert.strictEqual(got, mainRepoReal, `expected ${mainRepoReal}, got ${got}`)
  assert.notStrictEqual(got, worktreeRootReal, `resolver returned worktree path: ${got}`)
})

test('resolveRepoRoot: nested cwd inside worktree resolves to MAIN repo', () => {
  const got = fs.realpathSync(resolveRepoRoot(nestedDir))
  assert.strictEqual(got, mainRepoReal)
})

test('resolveRepoRoot: non-git cwd falls back to cwd', () => {
  const got = fs.realpathSync(resolveRepoRoot(nonGitDir))
  assert.strictEqual(got, nonGitDirReal)
})

// Regression for the v1 bug Codex caught on PR #105: an over-eager `/.git/`
// segment-strip would resolve a submodule's local memory to the SUPERPROJECT
// root, cross-contaminating two stores. Correct behavior: --show-toplevel
// returns the submodule's own working tree.
test('resolveRepoRoot: submodule resolves to SUBMODULE working tree, not superproject', () => {
  const superRepo = path.join(tmpRoot, 'super')
  const subSrc = path.join(tmpRoot, 'subsrc')
  fs.mkdirSync(superRepo, { recursive: true })
  fs.mkdirSync(subSrc, { recursive: true })

  git(subSrc, 'init -q -b main')
  git(subSrc, 'config user.email test@example.com')
  git(subSrc, 'config user.name test')
  fs.writeFileSync(path.join(subSrc, 'README.md'), '# sub\n')
  git(subSrc, 'add README.md')
  git(subSrc, 'commit -q -m sub-init')

  git(superRepo, 'init -q -b main')
  git(superRepo, 'config user.email test@example.com')
  git(superRepo, 'config user.name test')
  fs.writeFileSync(path.join(superRepo, 'README.md'), '# super\n')
  git(superRepo, 'add README.md')
  git(superRepo, 'commit -q -m super-init')
  git(superRepo, `-c protocol.file.allow=always submodule add -q file://${fs.realpathSync(subSrc)} sub`)

  const subCheckout = path.join(superRepo, 'sub')
  const subCheckoutReal = fs.realpathSync(subCheckout)
  const superRepoReal = fs.realpathSync(superRepo)

  const got = fs.realpathSync(resolveRepoRoot(subCheckout))
  assert.strictEqual(got, subCheckoutReal, `expected submodule root ${subCheckoutReal}, got ${got}`)
  assert.notStrictEqual(got, superRepoReal, `submodule resolved to superproject: ${got}`)
})

// ---------------------------------------------------------------------------
// Layer 2 — Integration regression tests for #106
// ---------------------------------------------------------------------------

// 2026-05-09 .checkpoints/ migration: em-recall writes/arms at PRIMARY
// (.checkpoints/) and reads at PRIMARY-then-LEGACY. The #106 invariant
// (marker lands at MAIN repo, NOT WORKTREE) is preserved — the marker
// just lives at .checkpoints/ now instead of .claude/. Tests assert the
// new write path; legacy paths still exercised by clearMarkers (sweep).
const mainPrimaryDir = path.join(mainRepoReal, '.checkpoints')
const mainLegacyDir = path.join(mainRepoReal, '.claude')
const worktreePrimaryDir = path.join(worktreeRootReal, '.checkpoints')
const worktreeLegacyDir = path.join(worktreeRootReal, '.claude')
const mainMarker = path.join(mainPrimaryDir, '.checkpoint-required')
const mainMarkerLegacy = path.join(mainLegacyDir, '.checkpoint-required')
const worktreeMarker = path.join(worktreePrimaryDir, '.checkpoint-required')
const worktreeMarkerLegacy = path.join(worktreeLegacyDir, '.checkpoint-required')

function clearMarkers() {
  for (const dir of [mainPrimaryDir, mainLegacyDir, worktreePrimaryDir, worktreeLegacyDir]) {
    for (const m of [
      '.checkpoint-required',
      '.pre-checkpoint-done',
      '.post-checkpoint-required',
      '.post-checkpoint-done',
      '.session-baseline',
    ]) {
      try { fs.unlinkSync(path.join(dir, m)) } catch {}
    }
  }
}

test('em-recall from main writes .checkpoint-required at <main>/.claude/', () => {
  clearMarkers()
  execSync(`node ${RECALL} --scope local --project test --no-track`, {
    cwd: mainRepo, stdio: ['ignore', 'ignore', 'ignore'],
  })
  // Defensive: assert main marker AND verify worktree did not get one too.
  assert.ok(fs.existsSync(mainMarker), `expected ${mainMarker} after em-recall from main`)
  assert.ok(!fs.existsSync(worktreeMarker), `unexpected ${worktreeMarker} after em-recall from main`)
})

test('em-recall from linked worktree writes .checkpoint-required at <main>/.claude/, NOT worktree', () => {
  clearMarkers()
  execSync(`node ${RECALL} --scope local --project test --no-track`, {
    cwd: worktreeRoot, stdio: ['ignore', 'ignore', 'ignore'],
  })
  // Positive: marker landed at main repo root.
  assert.ok(
    fs.existsSync(mainMarker),
    `expected ${mainMarker} after em-recall from worktree (regressed #106)`,
  )
  // Negative: marker did NOT land at worktree (the bug-shape assertion).
  // Defensive ordering: this assertion is the load-bearing one for #106.
  assert.ok(
    !fs.existsSync(worktreeMarker),
    `marker leaked into worktree: ${worktreeMarker} (this is the #106 bug)`,
  )
  // Defensive existence check: verify the worktree dir itself wasn't deleted
  // out from under us before the assertion, which would make the negative
  // check vacuously pass.
  assert.ok(
    fs.existsSync(worktreeRootReal),
    `worktree root went missing during test — negative assertion was vacuous`,
  )
})

test('em-recall from nested cwd inside worktree still writes marker at <main>/.claude/', () => {
  clearMarkers()
  execSync(`node ${RECALL} --scope local --project test --no-track`, {
    cwd: nestedDir, stdio: ['ignore', 'ignore', 'ignore'],
  })
  assert.ok(fs.existsSync(mainMarker))
  assert.ok(!fs.existsSync(worktreeMarker), `marker leaked into worktree from nested cwd`)
})

test('em-session-end-prompt from worktree cleans markers at <main>, not worktree', () => {
  clearMarkers()
  // Seed both stores at LEGACY (.claude/) — the dual-root sweep clears both
  // .checkpoints/ AND .claude/ at the resolved root. Seeding at legacy
  // proves the fallback-sweep branch executes; if we seeded only at
  // primary we wouldn't catch a regression that drops the legacy sweep.
  fs.mkdirSync(mainLegacyDir, { recursive: true })
  fs.mkdirSync(worktreeLegacyDir, { recursive: true })
  for (const m of [
    '.checkpoint-required',
    '.pre-checkpoint-done',
    '.post-checkpoint-required',
    '.post-checkpoint-done',
  ]) {
    fs.writeFileSync(path.join(mainLegacyDir, m), 'seed')
    fs.writeFileSync(path.join(worktreeLegacyDir, m), 'worktree-seed')
  }

  // Confirm setup is real (defensive — guards against a refactor that
  // accidentally clears the seed before the cleanup runs).
  assert.ok(fs.existsSync(mainMarkerLegacy), 'pre-condition: main legacy marker seeded')
  assert.ok(fs.existsSync(worktreeMarkerLegacy), 'pre-condition: worktree legacy marker seeded')

  execSync(`node ${SESSION_END}`, {
    cwd: worktreeRoot, stdio: ['ignore', 'ignore', 'ignore'],
  })

  // Positive: main markers swept (both .claude/ legacy and .checkpoints/
  // primary if any existed).
  assert.ok(!fs.existsSync(mainMarkerLegacy),
    `expected ${mainMarkerLegacy} cleaned after SessionEnd from worktree`)
  assert.ok(!fs.existsSync(mainMarker),
    `expected ${mainMarker} cleaned after SessionEnd from worktree`)
  // Negative: worktree markers untouched (proves the sweep targeted MAIN
  // via resolveRepoRoot, not the worktree-local dir). After #106,
  // em-session-end-prompt should NOT touch worktree-local markers unless
  // the worktree is a non-git cwd (which it isn't here).
  assert.ok(
    fs.existsSync(worktreeMarkerLegacy),
    `worktree legacy marker swept unexpectedly — em-session-end-prompt resolved to worktree, not main (regressed #106)`,
  )
})

// ---------------------------------------------------------------------------
// Layer 3 — Negative-scenario tests (verify-by-artifact Skill 2)
//
// Set up failure / edge states explicitly and observe behavior, rather than
// just testing the happy path with negative assertions.
// ---------------------------------------------------------------------------

test('NEG: stale worktree-local marker (pre-fix legacy state) is preserved, not migrated', () => {
  clearMarkers()
  // Simulate a user who ran em-recall from this worktree BEFORE PR #106 landed.
  // The pre-fix bug left a marker in <worktree>/.claude/. After the fix
  // AND the .checkpoints/ migration:
  //   - new arming writes to <main>/.checkpoints/ (correct, primary)
  //   - the legacy worktree-local marker is OUT OF BAND — we do not auto-migrate
  //   - em-session-end-prompt sweeps MAIN's roots (both .checkpoints/ and
  //     .claude/), so the worktree-local marker persists forever (acceptable:
  //     hooks resolve to main, so it's inert)
  fs.mkdirSync(worktreeLegacyDir, { recursive: true })
  fs.writeFileSync(worktreeMarkerLegacy, 'legacy-from-pre-106')
  assert.ok(fs.existsSync(worktreeMarkerLegacy), 'pre-condition: legacy worktree marker seeded')

  execSync(`node ${RECALL} --scope local --project test --no-track`, {
    cwd: worktreeRoot, stdio: ['ignore', 'ignore', 'ignore'],
  })

  // New behavior: marker now lives at main, in the PRIMARY (.checkpoints/) dir.
  assert.ok(fs.existsSync(mainMarker), 'new arming should land at main/.checkpoints/')
  // Legacy worktree marker preserved verbatim — we don't read or modify
  // worktree-local state.
  assert.ok(fs.existsSync(worktreeMarkerLegacy), 'legacy worktree marker should be untouched')
  assert.strictEqual(
    fs.readFileSync(worktreeMarkerLegacy, 'utf8'),
    'legacy-from-pre-106',
    'legacy marker contents should not be rewritten',
  )
})

test('NEG: em-recall from non-git cwd degrades gracefully (no crash, no cross-store leak)', () => {
  clearMarkers()
  // From a non-git cwd:
  //   - resolveRepoRoot returns cwd (no main repo to converge on)
  //   - LOCAL_DIR = <cwd>/.episodic-memory (does not exist; loadIndex returns [])
  //   - global store has no bp-001 violation either (test seed lives in mainRepo)
  //   - shouldArmBp001Checkpoint returns false → armCheckpointMarker never runs
  //   - em-recall exits 0 with empty episodes
  // Assertion shape: no crash, no marker anywhere, no .claude/ dir spuriously created.
  let exitOk = true
  try {
    execSync(`node ${RECALL} --scope local --no-track`, {
      cwd: nonGitDir, stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    exitOk = false
  }

  assert.ok(exitOk, 'em-recall should exit 0 from non-git cwd')
  // No marker created at cwd, main, or worktree.
  assert.ok(
    !fs.existsSync(path.join(nonGitDirReal, '.claude')),
    `.claude/ created at non-git cwd — activator armed spuriously`,
  )
  assert.ok(!fs.existsSync(mainMarker), 'non-git cwd should not write to main repo')
  assert.ok(!fs.existsSync(worktreeMarker), 'non-git cwd should not write to worktree')
})

test('NEG: em-recall with no recent bp-001 violation does NOT arm marker (activator no-op)', () => {
  clearMarkers()
  // Use a fresh ephemeral repo with NO seeded violation. shouldArmBp001Checkpoint
  // returns false → armCheckpointMarker is never called → no marker written.
  // Verifies the activator does not spuriously create marker files.
  const cleanRepo = path.join(tmpRoot, 'clean')
  fs.mkdirSync(cleanRepo, { recursive: true })
  git(cleanRepo, 'init -q -b main')
  git(cleanRepo, 'config user.email test@example.com')
  git(cleanRepo, 'config user.name test')
  fs.writeFileSync(path.join(cleanRepo, 'README.md'), '# clean\n')
  git(cleanRepo, 'add README.md')
  git(cleanRepo, 'commit -q -m init')

  const cleanRepoReal = fs.realpathSync(cleanRepo)
  // .checkpoints/ migration: new arming writes to .checkpoints/, so the
  // negative assertion targets the primary path. Legacy .claude/ is also
  // checked to guard against a regression that re-introduces legacy writes.
  const cleanMarkerPrimary = path.join(cleanRepoReal, '.checkpoints', '.checkpoint-required')
  const cleanMarkerLegacy = path.join(cleanRepoReal, '.claude', '.checkpoint-required')

  // No --project test → don't pick up the seeded violation in mainRepo.
  execSync(`node ${RECALL} --scope local --no-track`, {
    cwd: cleanRepo, stdio: ['ignore', 'ignore', 'ignore'],
  })

  assert.ok(
    !fs.existsSync(cleanMarkerPrimary),
    `unexpected marker at ${cleanMarkerPrimary} — activator armed without violation evidence`,
  )
  assert.ok(
    !fs.existsSync(cleanMarkerLegacy),
    `unexpected legacy marker at ${cleanMarkerLegacy} — activator wrote to legacy path`,
  )
  // Defensive: prove neither dir was mkdir'd by armCheckpointMarker. After
  // .checkpoints/ migration, ensurePrimaryDir is the gate; if armCheckpoint
  // had run we'd see .checkpoints/. Legacy .claude/ also asserted absent
  // because armCheckpointMarker should never touch it.
  assert.ok(
    !fs.existsSync(path.join(cleanRepoReal, '.checkpoints')),
    `.checkpoints/ dir created without arming — armCheckpointMarker ran spuriously`,
  )
  assert.ok(
    !fs.existsSync(path.join(cleanRepoReal, '.claude')),
    `.claude/ dir created without arming — legacy write path live`,
  )
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
