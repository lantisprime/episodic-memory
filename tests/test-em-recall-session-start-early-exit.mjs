#!/usr/bin/env node
/**
 * test-em-recall-session-start-early-exit.mjs — Tests for em-recall.mjs
 * SessionStart fast path (relocated inferContext + process.exit(0) after
 * baseline write).
 *
 * Plan: round-2 ACCEPT episode 20260509-082149-...-6ef8.
 *
 * Layered coverage (T1-T11):
 *   T1  recent active bp-001 violation -> __BP1_ADVISORY__ emitted, NO marker
 *       armed (planning-passive redesign 2026-05-25: em-recall no longer arms;
 *       checkpoint-gate.sh lazily arms at first repo write). Root-resolution
 *       (T8-T11) is proven via the .session-baseline write, which is retained.
 *   T2  no recent violation -> no advisory, NOT armed
 *   T3  baseline mtime advances (ordering invariant for stop-gate carve-out)
 *   T4  orphan cleanup removes pre-baseline task-signal markers
 *   T5  NON-session-start path: JSON output structure intact (regression)
 *   T6  NON-session-start --project flag still populates context (regression)
 *   T7  PATH-stub git: no `git remote get-url origin`, no `git branch
 *       --show-current` in --session-start mode; rev-parse from
 *       resolveRepoRoot() still allowed
 *   T8  Hook E2E: callerDir != targetRepo via stdin .cwd; artifacts under
 *       targetRepo/.checkpoints/, NOT callerDir/.checkpoints/
 *   T9  Direct --session-start from linked worktree -> artifacts at
 *       canonical main-repo .checkpoints/
 *   T10 Direct --session-start from nested cwd inside target -> artifacts
 *       at repo root, not subdir
 *   T11 T8 with HOME containing spaces (PR #207 install-quoting class)
 *
 * Per feedback_fixture_transitive_imports.md: T8/T11 stage real
 * em-recall.mjs + lib/local-dir.mjs + lib/marker-paths.mjs into temp HOME.
 *
 * Per discipline #15 (same-class completeness) + existing test convention:
 * every negative assertion (artifact absent at callerDir) is paired with a
 * pre-condition existence check on the fixture dir, so the negative does
 * not pass vacuously.
 *
 * Usage: node tests/test-em-recall-session-start-early-exit.mjs
 * Zero dependencies (uses node stdlib + assert).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, spawnSync } from 'child_process'
import assert from 'assert'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, '..')
const SCRIPTS = path.join(REPO, 'scripts')
const RECALL = path.join(SCRIPTS, 'em-recall.mjs')
const STORE = path.join(SCRIPTS, 'em-store.mjs')
const HOOK = path.join(REPO, 'hooks', 'em-recall-sessionstart.sh')

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

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

// ---------------------------------------------------------------------------
// Shared fixtures: temp main repo + linked worktree + nested cwd
//
// Each test clears markers between runs (clearMarkers()) so they're
// independent. The bp-001 violation seed is rebuilt per-test where needed
// (so T2 can prove the no-violation path).
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-recall-fast-'))
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} })

const mainRepo = path.join(tmpRoot, 'main')
const worktreeRoot = path.join(tmpRoot, 'wt')
const nestedDir = path.join(mainRepo, 'a', 'b', 'c')
const callerDir = path.join(tmpRoot, 'caller')

fs.mkdirSync(mainRepo, { recursive: true })
fs.mkdirSync(callerDir, { recursive: true })

git(mainRepo, 'init -q -b main')
git(mainRepo, 'config user.email test@example.com')
git(mainRepo, 'config user.name test')
fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test\n')
// package.json with name='test' so arming-path resolveProjectName(mainRepo)
// resolves to 'test' (matches seeded violation's --project test). Post-Option-E
// arming requires e.project === resolveProjectName(REPO_ROOT, {fast:true}); without
// this fixture the arming would fall to basename(mainRepo)='main' and tests
// expecting marker arming would fail.
fs.writeFileSync(path.join(mainRepo, 'package.json'), JSON.stringify({ name: 'test' }, null, 2))
git(mainRepo, 'add README.md package.json')
git(mainRepo, 'commit -q -m init')
git(mainRepo, `worktree add -q -b wt-branch ${worktreeRoot}`)
fs.mkdirSync(nestedDir, { recursive: true })

const mainRepoReal = fs.realpathSync(mainRepo)
const worktreeRootReal = fs.realpathSync(worktreeRoot)
const callerDirReal = fs.realpathSync(callerDir)

const mainPrimaryDir = path.join(mainRepoReal, '.checkpoints')
const mainLegacyDir = path.join(mainRepoReal, '.claude')
const worktreePrimaryDir = path.join(worktreeRootReal, '.checkpoints')
const callerPrimaryDir = path.join(callerDirReal, '.checkpoints')

const mainCheckpointMarker = path.join(mainPrimaryDir, '.checkpoint-required')
const mainBaseline = path.join(mainPrimaryDir, '.session-baseline')
const worktreeCheckpointMarker = path.join(worktreePrimaryDir, '.checkpoint-required')
const worktreeBaseline = path.join(worktreePrimaryDir, '.session-baseline')
const callerCheckpointMarker = path.join(callerPrimaryDir, '.checkpoint-required')
const callerBaseline = path.join(callerPrimaryDir, '.session-baseline')

const TASK_SIGNAL_NAMES = [
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.plan-approval-pending',
]

function clearMarkers() {
  for (const dir of [mainPrimaryDir, mainLegacyDir, worktreePrimaryDir, callerPrimaryDir]) {
    for (const m of [
      ...TASK_SIGNAL_NAMES,
      '.session-baseline',
      '.pre-checkpoint-done',
      '.post-checkpoint-done',
    ]) {
      try { fs.unlinkSync(path.join(dir, m)) } catch {}
    }
  }
}

function seedBp001Violation() {
  // Use today's date so it's well within the 30-day cutoff regardless of
  // test execution timezone.
  execSync(
    `node ${STORE} --scope local --project test ` +
    `--category violation ` +
    `--tags "violated:bp-001-implementation-workflow,test-fixture" ` +
    `--summary "test fixture violation" ` +
    `--body "Seeded by test-em-recall-session-start-early-exit.mjs."`,
    { cwd: mainRepo, stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function clearLocalStore() {
  // Clear the local episode store so tests start with no violations.
  const localStore = path.join(mainRepoReal, '.episodic-memory')
  try { fs.rmSync(localStore, { recursive: true, force: true }) } catch {}
}

// ---------------------------------------------------------------------------
// T1 — recent active bp-001 violation: emits __BP1_ADVISORY__, does NOT arm
// (planning-passive redesign). Baseline still written unconditionally.
// ---------------------------------------------------------------------------
test('T1: --session-start with recent active bp-001 violation emits advisory + does NOT arm marker', () => {
  clearMarkers()
  clearLocalStore()
  seedBp001Violation()
  // Pre-condition: fixture dirs exist (defensive for negative assertions).
  assert.ok(fs.existsSync(mainRepoReal), 'pre: mainRepo exists')

  const r = spawnSync('node', [RECALL, '--session-start', '--scope', 'local', '--project', 'test', '--no-track'], {
    cwd: mainRepo, encoding: 'utf8',
  })

  assert.ok(/__BP1_ADVISORY__/.test(r.stderr || ''),
    `expected __BP1_ADVISORY__ on stderr with recent violation; got: ${r.stderr}`)
  assert.ok(!fs.existsSync(mainCheckpointMarker),
    `em-recall must NOT arm ${mainCheckpointMarker} (planning-passive — lazy-arm moved to checkpoint-gate.sh)`)
  assert.ok(fs.existsSync(mainBaseline),
    `expected ${mainBaseline} after --session-start (always written)`)
})

// ---------------------------------------------------------------------------
// T2 — no recent violation: marker NOT armed
// ---------------------------------------------------------------------------
test('T2: --session-start with no recent bp-001 violation does NOT arm .checkpoint-required', () => {
  clearMarkers()
  clearLocalStore()
  // No seed: store is empty.
  // Defensive: assert mainRepo dir exists so the !exists check below isn't vacuous.
  assert.ok(fs.existsSync(mainRepoReal), 'pre: mainRepo exists')

  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: mainRepo, stdio: ['ignore', 'ignore', 'ignore'],
  })

  assert.ok(!fs.existsSync(mainCheckpointMarker),
    `unexpected ${mainCheckpointMarker} when no violation seeded`)
  assert.ok(fs.existsSync(mainBaseline),
    `expected ${mainBaseline} (baseline write is unconditional in session-start mode)`)
})

// ---------------------------------------------------------------------------
// T3 — baseline mtime advances on each --session-start
// ---------------------------------------------------------------------------
test('T3: --session-start advances .session-baseline mtime on subsequent invocations', () => {
  clearMarkers()
  clearLocalStore()

  // First invocation seeds the baseline.
  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: mainRepo, stdio: ['ignore', 'ignore', 'ignore'],
  })
  assert.ok(fs.existsSync(mainBaseline), 'pre: first baseline exists')
  const t1 = fs.statSync(mainBaseline).mtimeMs

  // Sleep ~50ms to let mtime tick on filesystems with low-res clocks.
  execSync('sleep 0.1')

  // Second invocation must advance mtime (utimesSync forces Date.now()).
  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: mainRepo, stdio: ['ignore', 'ignore', 'ignore'],
  })
  const t2 = fs.statSync(mainBaseline).mtimeMs

  assert.ok(t2 > t1, `baseline mtime should advance (t1=${t1} t2=${t2})`)
})

// ---------------------------------------------------------------------------
// T4 — M5 retime-and-rearm: checkpoint markers PRESERVED across SessionStart,
// baseline.mtime force-monotonic dominates marker.mtime (carve-out invariant).
//
// Inverted from the prior baseline-mtime-sweep contract (2026-05-18 orphan-
// deadlock fix; codex R3 P1). Old contract removed CR/PostR with mtime <=
// baseline → rm→rearm race + cross-session A/B stomp. New contract preserves
// markers; Stop is unblocked via baseline mtime refresh while the writer-gate
// stays armed for any concurrent live session.
// ---------------------------------------------------------------------------
test('T4: --session-start PRESERVES checkpoint markers; baseline.mtime dominates (M5 retime contract)', () => {
  clearMarkers()
  clearLocalStore()

  // First invocation: seed a baseline.
  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: mainRepo, stdio: ['ignore', 'ignore', 'ignore'],
  })
  assert.ok(fs.existsSync(mainBaseline), 'pre: baseline exists')

  // Plant a pre-existing .post-checkpoint-required with mtime BEFORE baseline.
  const orphan = path.join(mainPrimaryDir, '.post-checkpoint-required')
  fs.writeFileSync(orphan, 'stale')
  const baselineMtime = fs.statSync(mainBaseline).mtimeMs / 1000
  fs.utimesSync(orphan, baselineMtime - 10, baselineMtime - 10)
  assert.ok(fs.existsSync(orphan), 'pre: marker planted')

  execSync('sleep 0.1')

  // Second invocation: marker must be PRESERVED (NOT swept).
  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: mainRepo, stdio: ['ignore', 'ignore', 'ignore'],
  })

  assert.ok(fs.existsSync(orphan),
    `marker ${orphan} should be PRESERVED across SessionStart (M5 retime contract)`)
  // Carve-out invariant: baseline.mtime >= marker.mtime so Stop is unblocked.
  const newBaselineMs = fs.statSync(mainBaseline).mtimeMs
  const markerMs = fs.statSync(orphan).mtimeMs
  assert.ok(newBaselineMs >= markerMs,
    `baseline.mtime (${newBaselineMs}) should dominate marker.mtime (${markerMs}) — Stop unblocked`)
})

// ---------------------------------------------------------------------------
// T5 — NON-session-start: JSON output structure unchanged (regression for
// inferContext relocation)
// ---------------------------------------------------------------------------
test('T5: NON --session-start emits JSON with full context/episodes/preflight_warnings shape', () => {
  clearMarkers()
  clearLocalStore()
  seedBp001Violation()

  const out = execSync(`node ${RECALL} --scope local --project test --no-track --limit 2`, {
    cwd: mainRepo, stdio: ['ignore', 'pipe', 'ignore'],
  }).toString()
  const parsed = JSON.parse(out)

  assert.strictEqual(parsed.status, 'ok', 'status field present')
  assert.ok(parsed.context && typeof parsed.context === 'object', 'context object present')
  assert.ok('project' in parsed.context, 'context.project key present')
  assert.ok(Array.isArray(parsed.context.branch_tokens), 'context.branch_tokens array')
  assert.ok(Array.isArray(parsed.episodes), 'episodes array present')
  assert.ok(Array.isArray(parsed.preflight_warnings), 'preflight_warnings array present')
})

// ---------------------------------------------------------------------------
// T6 — NON-session-start with --project: context.project populated
// (regression for inferContext relocation: --project must still flow into
// the recall-output JSON)
// ---------------------------------------------------------------------------
test('T6: NON --session-start with --project foo populates context.project=foo', () => {
  clearMarkers()
  clearLocalStore()

  const out = execSync(`node ${RECALL} --scope local --project foo --no-track --limit 1`, {
    cwd: mainRepo, stdio: ['ignore', 'pipe', 'ignore'],
  }).toString()
  const parsed = JSON.parse(out)

  assert.strictEqual(parsed.context.project, 'foo',
    `expected context.project='foo', got '${parsed.context.project}'`)
})

// ---------------------------------------------------------------------------
// T7 — PATH-stub git: --session-start does NOT call `git remote get-url
// origin` or `git branch --show-current`. resolveRepoRoot's `git rev-parse`
// is still allowed.
//
// Mechanism: stub `git` shell script logs argv to a file and delegates
// `rev-parse` to /usr/bin/git. The optimization claim is "inferContext()
// is skipped"; the test contract is "the two inferContext() git argv
// shapes do not appear in the log."
// ---------------------------------------------------------------------------
test('T7: --session-start does NOT invoke `git remote get-url origin` or `git branch --show-current`', () => {
  clearMarkers()
  clearLocalStore()
  seedBp001Violation()

  const stubDir = fs.mkdtempSync(path.join(tmpRoot, 'gitstub-'))
  const stubLog = path.join(stubDir, 'git-invocations.log')
  const stubScript = path.join(stubDir, 'git')

  // Resolve real git path BEFORE PATH override.
  const realGit = execSync('command -v git', { encoding: 'utf8' }).trim()
  assert.ok(realGit, 'pre: real git found on PATH')

  // Stub: log argv, delegate everything to real git.
  fs.writeFileSync(stubScript, [
    '#!/usr/bin/env bash',
    `echo "$@" >> ${JSON.stringify(stubLog)}`,
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n'))
  fs.chmodSync(stubScript, 0o755)

  const env = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`,
  }

  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: mainRepo, env, stdio: ['ignore', 'ignore', 'ignore'],
  })

  const log = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : ''

  // Negative: forbidden inferContext() invocations must be absent.
  assert.ok(!/^remote get-url origin/m.test(log),
    `forbidden 'git remote get-url origin' call observed:\n${log}`)
  assert.ok(!/^branch --show-current/m.test(log),
    `forbidden 'git branch --show-current' call observed:\n${log}`)

  // Positive: at least the rev-parse from resolveRepoRoot should appear,
  // proving the stub was actually on PATH (otherwise the negatives would
  // pass vacuously). resolveRepoRoot uses `rev-parse --git-common-dir`.
  assert.ok(/rev-parse/.test(log),
    `expected at least one 'git rev-parse' call (proves PATH stub was active):\n${log}`)
})

// ---------------------------------------------------------------------------
// T9 — direct --session-start from linked worktree: artifacts at canonical
// main repo .checkpoints/, not worktree
// ---------------------------------------------------------------------------
test('T9: direct --session-start from linked worktree writes baseline + marker at MAIN repo .checkpoints/, NOT worktree', () => {
  clearMarkers()
  clearLocalStore()
  seedBp001Violation()
  // Pre-condition existence checks (defensive).
  assert.ok(fs.existsSync(mainRepoReal), 'pre: main repo exists')
  assert.ok(fs.existsSync(worktreeRootReal), 'pre: worktree exists')

  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: worktreeRoot, stdio: ['ignore', 'ignore', 'ignore'],
  })

  assert.ok(fs.existsSync(mainBaseline),
    `baseline must land at canonical main: ${mainBaseline}`)
  assert.ok(!fs.existsSync(mainCheckpointMarker),
    `em-recall must NOT arm ${mainCheckpointMarker} (planning-passive — root-resolution proven by baseline)`)
  // Negative + post-fixture-existence guard: worktree dir is still here, so
  // !exists isn't vacuous.
  assert.ok(fs.existsSync(worktreeRootReal),
    'post: worktree root still exists (guards against vacuous !exists below)')
  assert.ok(!fs.existsSync(worktreeBaseline),
    `worktree baseline ${worktreeBaseline} must NOT be created (regressed #106 / canonical-root invariant)`)
  assert.ok(!fs.existsSync(worktreeCheckpointMarker),
    `worktree marker ${worktreeCheckpointMarker} must NOT be created`)
})

// ---------------------------------------------------------------------------
// T10 — direct --session-start from nested cwd inside main repo: artifacts
// at repo root, not subdir
// ---------------------------------------------------------------------------
test('T10: direct --session-start from nested cwd writes artifacts at repo root, not subdir', () => {
  clearMarkers()
  clearLocalStore()
  seedBp001Violation()
  assert.ok(fs.existsSync(nestedDir), 'pre: nested dir exists')

  execSync(`node ${RECALL} --session-start --scope local --project test --no-track`, {
    cwd: nestedDir, stdio: ['ignore', 'ignore', 'ignore'],
  })

  assert.ok(fs.existsSync(mainBaseline), 'baseline at repo root')
  assert.ok(!fs.existsSync(mainCheckpointMarker),
    'em-recall must NOT arm marker (planning-passive — root-resolution proven by baseline)')

  const nestedCheckpointsDir = path.join(nestedDir, '.checkpoints')
  assert.ok(fs.existsSync(nestedDir),
    'post: nested dir still exists (guards vacuous !exists)')
  assert.ok(!fs.existsSync(nestedCheckpointsDir),
    `nested .checkpoints/ must NOT be created at ${nestedCheckpointsDir}`)
})

// ---------------------------------------------------------------------------
// T8 / T11 — Hook E2E with callerDir != targetRepo via stdin .cwd, in a
// temp HOME with a fully-staged installed runtime.
//
// Per feedback_fixture_transitive_imports.md: stage em-recall.mjs PLUS its
// transitive lib imports (lib/local-dir.mjs, lib/marker-paths.mjs).
// ---------------------------------------------------------------------------
function buildTempHome(homeRoot) {
  const installedScripts = path.join(homeRoot, '.episodic-memory', 'scripts')
  const installedLib = path.join(installedScripts, 'lib')
  fs.mkdirSync(installedLib, { recursive: true })

  fs.copyFileSync(RECALL, path.join(installedScripts, 'em-recall.mjs'))
  fs.copyFileSync(
    path.join(SCRIPTS, 'lib', 'local-dir.mjs'),
    path.join(installedLib, 'local-dir.mjs'),
  )
  fs.copyFileSync(
    path.join(SCRIPTS, 'lib', 'marker-paths.mjs'),
    path.join(installedLib, 'marker-paths.mjs'),
  )
  // rank-1 plan v7: em-recall now imports stop-gate-helpers.mjs for the
  // active-plan exemption. Test fixture must mirror transitive imports.
  fs.copyFileSync(
    path.join(SCRIPTS, 'lib', 'stop-gate-helpers.mjs'),
    path.join(installedLib, 'stop-gate-helpers.mjs'),
  )
  // 2026-05-18 concurrent-session fix: em-recall now imports session-id.mjs
  // for the --session-id flag validation. Mirror per
  // feedback_fixture_transitive_imports.md.
  fs.copyFileSync(
    path.join(SCRIPTS, 'lib', 'session-id.mjs'),
    path.join(installedLib, 'session-id.mjs'),
  )
  // No hook-install.json; warn_hook_freshness soft-fails on missing manifest.
  return installedScripts
}

function runHookE2E({ tempHome, targetRepo, callerCwd }) {
  // Mirror the hook's stdin contract: '{"cwd":"<targetRepo>"}'.
  const stdin = JSON.stringify({ cwd: targetRepo })
  // Use bash -c so we control HOME + cwd cleanly. The hook itself reads
  // stdin and `cd "$CWD"` internally, so caller cwd != targetRepo.
  const cmd = `printf %s ${JSON.stringify(stdin)} | HOME=${JSON.stringify(tempHome)} bash ${JSON.stringify(HOOK)}`
  execSync(cmd, { cwd: callerCwd, stdio: ['ignore', 'ignore', 'ignore'] })
}

test('T8: Hook E2E with callerDir != targetRepo writes artifacts under targetRepo only', () => {
  clearMarkers()
  clearLocalStore()
  seedBp001Violation()

  const tempHome = fs.mkdtempSync(path.join(tmpRoot, 'home8-'))
  buildTempHome(tempHome)

  // Pre: caller dir exists (defensive for !exists checks); caller has no
  // pre-existing .checkpoints state.
  assert.ok(fs.existsSync(callerDirReal), 'pre: callerDir exists')
  assert.ok(!fs.existsSync(callerPrimaryDir), 'pre: callerDir/.checkpoints absent')

  runHookE2E({ tempHome, targetRepo: mainRepoReal, callerCwd: callerDirReal })

  // Positive: artifacts at targetRepo.
  assert.ok(fs.existsSync(mainBaseline), 'baseline at targetRepo')
  assert.ok(!fs.existsSync(mainCheckpointMarker),
    'em-recall must NOT arm marker at targetRepo (planning-passive)')

  // Negative + post-fixture-existence guard.
  assert.ok(fs.existsSync(callerDirReal),
    'post: callerDir still exists (guards vacuous !exists below)')
  assert.ok(!fs.existsSync(callerPrimaryDir),
    `caller dir must NOT have .checkpoints/ created: ${callerPrimaryDir}`)
})

test('T11: Hook E2E with HOME containing spaces still writes artifacts correctly', () => {
  clearMarkers()
  clearLocalStore()
  seedBp001Violation()

  // Build a HOME path that contains a space — exercises shell-quoting in
  // the hook's `node "$EM_RECALL"` call. This is the PR #207 install
  // class of failure (path quoting).
  const spacedHomeParent = fs.mkdtempSync(path.join(tmpRoot, 'home11-parent-'))
  const tempHome = path.join(spacedHomeParent, 'home with spaces')
  fs.mkdirSync(tempHome, { recursive: true })
  buildTempHome(tempHome)

  assert.ok(fs.existsSync(callerDirReal), 'pre: callerDir exists')

  runHookE2E({ tempHome, targetRepo: mainRepoReal, callerCwd: callerDirReal })

  assert.ok(fs.existsSync(mainBaseline), 'baseline at targetRepo (HOME-with-spaces)')
  assert.ok(!fs.existsSync(mainCheckpointMarker),
    'em-recall must NOT arm marker at targetRepo when HOME has spaces (planning-passive)')
  assert.ok(!fs.existsSync(callerPrimaryDir),
    `caller dir must NOT have .checkpoints/ created when HOME has spaces`)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) {
    console.log(`\n  FAIL: ${f.name}\n    ${f.error}`)
  }
  process.exit(1)
}
