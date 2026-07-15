/**
 * test-install-scripts-subtrees.mjs — 9 tests for ISSUE-531 class-closing
 * deployment of scripts/<name>/ subtrees.
 *
 * Group 1: install E2E (isolated-HOME mock + REAL install.mjs) (4 tests)
 *   testEmConsolidateDeployed
 *   testSecondOpinionStillDeployed
 *   testScaffoldPluginNotDeployed
 *   testUnclassifiedSubtreeFailsClosed (two polarities: core + --install-second-opinion)
 *
 * Group 2: classifier + completeness units (5 tests)
 *   testClassifierUnknown
 *   testAllCurrentSubtreesClassified
 *   testRepoCompletenessGreen
 *   testRepoCompletenessRed
 *   testCompletenessSkipsSymlinks
 *
 * Zero deps. Node stdlib only. Models tests/test-install-second-opinion-e2e.mjs:197.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { mkMock, runInstall, REPO_ROOT } from './lib/activation-scoping-harness.mjs'
import {
  classifyScriptSubtree, repoCompletenessFindings,
  GLOBAL_SCRIPT_SUBTREES,
} from '../scripts/lib/install-manifest.mjs'

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
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// Group 1: install E2E (isolated-HOME mock + REAL install.mjs)
// ---------------------------------------------------------------------------

test('testEmConsolidateDeployed: mock install; clerk.md exists + bytes === repo bytes', () => {
  const { home, project, callerCwd } = mkMock('em-consolidate')
  const r = runInstall({ home, project, callerCwd })
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}; stdout=${r.stdout}`)

  const deployed = path.join(home, '.episodic-memory', 'scripts', 'em-consolidate', 'prompts', 'clerk.md')
  assert.ok(fs.existsSync(deployed), `em-consolidate/prompts/clerk.md must deploy to ${deployed}`)

  const repoFile = path.join(REPO_ROOT, 'scripts', 'em-consolidate', 'prompts', 'clerk.md')
  assert.ok(
    fs.readFileSync(deployed).equals(fs.readFileSync(repoFile)),
    'deployed clerk.md must be byte-identical to repo clerk.md'
  )
})

test('testSecondOpinionStillDeployed: adversarial-depth-v1.md exists + bytes === repo bytes', () => {
  const { home, project, callerCwd } = mkMock('so-still')
  const r = runInstall({ home, project, callerCwd })
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`)

  const deployed = path.join(
    home, '.episodic-memory', 'scripts', 'second-opinion',
    'preambles', 'fragments', 'adversarial-depth-v1.md'
  )
  assert.ok(fs.existsSync(deployed), `adversarial-depth-v1.md must deploy to ${deployed}`)

  const repoFile = path.join(
    REPO_ROOT, 'scripts', 'second-opinion', 'preambles', 'fragments', 'adversarial-depth-v1.md'
  )
  assert.ok(
    fs.readFileSync(deployed).equals(fs.readFileSync(repoFile)),
    'deployed second-opinion file must be byte-identical to repo'
  )
})

test('testScaffoldPluginNotDeployed: no scripts/scaffold-plugin in mock global', () => {
  const { home, project, callerCwd } = mkMock('scaffold-not')
  const r = runInstall({ home, project, callerCwd })
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`)

  const deployed = path.join(home, '.episodic-memory', 'scripts', 'scaffold-plugin')
  assert.ok(
    !fs.existsSync(deployed),
    `scaffold-plugin/ must NOT deploy to global (repo-only class); found at ${deployed}`
  )
})

test('testUnclassifiedSubtreeFailsClosed: copied-repo E2E, two polarities (core + --install-second-opinion)', () => {
  // Copy the repo to a temp dir; the copied install.mjs is what will run, so the
  // classification error can only fire if the COPY's classifier sweep runs (not
  // the live repo's, which would never see the fake dir).
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'p4d-531-unclassified-'))
  try {
    fs.cpSync(REPO_ROOT, tmpRepo, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !/\/(\.git|\.episodic-memory|\.review-store|\.worktrees|node_modules)(\/|$)/.test(src),
    })

    // Inject the fake unclassified subtree into the COPY (the live repo never sees it).
    const fakeDir = path.join(tmpRepo, 'scripts', 'aaa-unclassified-531')
    fs.mkdirSync(fakeDir, { recursive: true })
    fs.writeFileSync(path.join(fakeDir, 'x.txt'), 'sentinel-531-unclassified')

    // ── Polarity (i): core install on the COPIED repo. ─────────────────────
    const m1 = mkMock('unclassified-core')
    const r1 = runInstall({
      home: m1.home, project: m1.project, callerCwd: m1.callerCwd,
      installerRepo: tmpRepo,
    })
    const combined1 = `${r1.stdout || ''}${r1.stderr || ''}`
    assert.notStrictEqual(r1.status, 0,
      `unclassified dir must fail install non-zero; got exit ${r1.status}; combined=${combined1}`)
    assert.ok(/not classified in install-manifest\.mjs/.test(combined1),
      `output must contain 'not classified in install-manifest.mjs'; got: ${combined1}`)
    assert.ok(/aaa-unclassified-531/.test(combined1),
      `output must name the fake dir (proves the copied installer ran, not the live repo's); got: ${combined1}`)

    // EC4/EC6: nothing was copied under the global scripts dir — the classification
    // check ran BEFORE any write (no em-store.mjs flat, no second-opinion/ subtree).
    const gScripts = path.join(m1.home, '.episodic-memory', 'scripts')
    assert.ok(!fs.existsSync(path.join(gScripts, 'em-store.mjs')),
      `flat .mjs copy must not have run before classification; found em-store.mjs in ${gScripts}`)
    assert.ok(!fs.existsSync(path.join(gScripts, 'second-opinion')),
      `subtree copy must not have run before classification; found second-opinion/ in ${gScripts}`)

    // ── Polarity (ii): rerun with --install-second-opinion into a second mock.
    // GLM r1 B3.3: the classification throw must propagate UNCAUGHT so the
    // quarantine catch at install.mjs:411-420 never sees it (no spurious
    // snapshot quarantine, no false "Runtime copy failed / partially modified"
    // stderr under --install-second-opinion).
    const m2 = mkMock('unclassified-so')
    const r2 = runInstall({
      home: m2.home, project: m2.project, callerCwd: m2.callerCwd,
      installerRepo: tmpRepo,
      flags: ['--install-second-opinion'],
    })
    const combined2 = `${r2.stdout || ''}${r2.stderr || ''}`
    assert.notStrictEqual(r2.status, 0,
      `unclassified dir with --install-second-opinion must fail non-zero; got ${r2.status}; combined=${combined2}`)
    assert.ok(/not classified in install-manifest\.mjs/.test(combined2),
      `output must still contain 'not classified in install-manifest.mjs'; got: ${combined2}`)
    assert.ok(!/quarantining snapshot/.test(combined2),
      `output must NOT match /quarantining snapshot/ — the throw is OUTSIDE the quarantine try; got: ${combined2}`)
  } finally {
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }) } catch {}
  }
})

// ---------------------------------------------------------------------------
// Group 2: classifier + completeness units
// ---------------------------------------------------------------------------

test('testClassifierUnknown: classifyScriptSubtree("zz-no-such-dir-531") === "unclassified"', () => {
  assert.strictEqual(classifyScriptSubtree('zz-no-such-dir-531'), 'unclassified')
})

test('testAllCurrentSubtreesClassified: every scripts/ dirent at HEAD !== "unclassified"', () => {
  const scriptsDir = path.join(REPO_ROOT, 'scripts')
  const dirs = fs.readdirSync(scriptsDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name)
  assert.ok(dirs.length > 0, 'repo scripts/ must have at least one directory at HEAD')
  for (const d of dirs) {
    assert.notStrictEqual(classifyScriptSubtree(d), 'unclassified',
      `subtree ${d}/ must be classified at HEAD`)
  }
})

test('testRepoCompletenessGreen: findings === [] on a fresh mock install', () => {
  const { home, project, callerCwd } = mkMock('completeness-green')
  const r = runInstall({ home, project, callerCwd })
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`)

  const findings = repoCompletenessFindings(REPO_ROOT, path.join(home, '.episodic-memory', 'scripts'))
  assert.deepStrictEqual(findings, [], `fresh mock install must be complete; findings=${JSON.stringify(findings)}`)
})

test('testRepoCompletenessRed: delete clerk.md from MOCK → findings includes it', () => {
  const { home, project, callerCwd } = mkMock('completeness-red')
  const r = runInstall({ home, project, callerCwd })
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`)

  const deployed = path.join(home, '.episodic-memory', 'scripts', 'em-consolidate', 'prompts', 'clerk.md')
  assert.ok(fs.existsSync(deployed), `precondition: clerk.md must exist at ${deployed}`)
  fs.rmSync(deployed)

  const findings = repoCompletenessFindings(REPO_ROOT, path.join(home, '.episodic-memory', 'scripts'))
  assert.ok(findings.includes('scripts/em-consolidate/prompts/clerk.md'),
    `findings must include the deleted path; got ${JSON.stringify(findings)}`)
})

test('testCompletenessSkipsSymlinks: synthetic fixture with real symlink → findings === []', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'p4d-531-symlink-fixture-'))
  const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4d-531-symlink-installed-'))
  try {
    // Build the synthetic repo tree: scripts/em-consolidate/a.md (real) + link.md
    // (symlink → a.md). copyDirRecursive skips non-regular entries, so the
    // "installed" tree holds only a.md. The repo-side walkRegularFiles also
    // skips non-regular entries, so the symlink is never expected.
    const fixtureSub = path.join(fixture, 'scripts', 'em-consolidate')
    fs.mkdirSync(fixtureSub, { recursive: true })
    const aMd = path.join(fixtureSub, 'a.md')
    fs.writeFileSync(aMd, 'SENTINEL_531a')
    fs.symlinkSync('a.md', path.join(fixtureSub, 'link.md'))

    // Build the installed tree (only a.md — emulating copyDirRecursive's filter).
    const installedSub = path.join(installedDir, 'scripts', 'em-consolidate')
    fs.mkdirSync(installedSub, { recursive: true })
    fs.copyFileSync(aMd, path.join(installedSub, 'a.md'))

    const findings = repoCompletenessFindings(fixture, path.join(installedDir, 'scripts'))
    assert.deepStrictEqual(findings, [],
      `symlink must not be expected; findings=${JSON.stringify(findings)}`)
  } finally {
    try { fs.rmSync(fixture, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(installedDir, { recursive: true, force: true }) } catch {}
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} pass`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}

// Sanity: GLOBAL_SCRIPT_SUBTREES is the §A.5 verbatim pair.
assert.deepStrictEqual(GLOBAL_SCRIPT_SUBTREES, ['em-consolidate', 'second-opinion'],
  'GLOBAL_SCRIPT_SUBTREES drifted from §A.5')
