#!/usr/bin/env node
/**
 * test-second-opinion-gate-runbook.mjs — Tests for the runbook-injection
 * branch of hooks/second-opinion-gate.mjs (codex r4 ACCEPT plan v4.1).
 *
 * Coverage:
 *   Gate flow (P1-2 ordering):
 *     - Runbook gate fires BEFORE validator/snapshot load on harness Bash
 *     - Non-harness Bash falls through to existing snapshot flow
 *     - Missing snapshot doesn't preempt runbook block on harness call
 *
 *   Detection (occurrence-scoped):
 *     - Canonical harness invocation → block
 *     - Quoted/single-quoted/splice variants → block
 *     - `--help` / `info` subcommand → allow
 *     - Non-harness `node` calls (em-search, em-store) → allow
 *
 *   Runbook validation (fail-closed):
 *     - Missing runbook → block with runbook-load-failed
 *     - Missing quickref → block with runbook-load-failed
 *     - Too-short runbook → block
 *     - Missing sentinel → block
 *
 *   Marker semantics:
 *     - Marker absent → block with sha8 + marker_path
 *     - Marker present at canonical → allow
 *     - Sha drift (marker for old sha, runbook updated) → block
 *     - Linked worktree cwd → marker_path is at CANONICAL root, not worktree
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HOOK = path.join(REPO_ROOT, 'plugins', 'claude-code', 'hooks', 'second-opinion-gate.mjs')
const RUNBOOK_SRC = path.join(REPO_ROOT, 'hooks', 'runbooks', 'second-opinion-harness.md')
// Orphan-install fixtures below copy HOOK alone; the gate's harness branch
// now also dynamic-imports lib/so-timeout-floor.mjs, so fixtures must
// colocate it or they fail-closed with so-timeout-floor-load-failed before
// the local-dir layer this suite is testing.
const TIMEOUT_FLOOR_SRC = path.join(REPO_ROOT, 'plugins', 'claude-code', 'hooks', 'lib', 'so-timeout-floor.mjs')

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

const tmpDirs = []
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function makeTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-runbook-test-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  fs.mkdirSync(path.join(tmp, '.checkpoints'), { recursive: true })
  return tmp
}

function makeTmpRunbookDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-runbook-runtime-'))
  tmpDirs.push(tmp)
  return tmp
}

function installRunbook(runbookDir, runbookContent, quickrefContent) {
  const rbPath = path.join(runbookDir, 'second-opinion-harness.md')
  const qrPath = path.join(runbookDir, 'second-opinion-harness.quickref.md')
  fs.writeFileSync(rbPath, runbookContent)
  fs.writeFileSync(qrPath, quickrefContent)
  return { rbPath, qrPath }
}

function computeSha8(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8)
}

function runHook({ toolName, toolInput, cwd, env = {} }) {
  // Default timeout to TIMEOUT_FLOOR_MS for Bash so the timeout-floor layer
  // doesn't preempt the runbook-layer behavior under test here. Tests that
  // specifically exercise timeout-floor behavior live in
  // test-so-gate-timeout-floor-integration.mjs.
  const filled =
    toolName === 'Bash' && toolInput && typeof toolInput.timeout === 'undefined'
      ? { ...toolInput, timeout: 600000 }
      : toolInput
  const input = JSON.stringify({ tool_name: toolName, tool_input: filled, cwd })
  const result = spawnSync('node', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 5000,
  })
  if (result.status !== 0) {
    throw new Error(`Hook exited non-zero (${result.status}); stderr: ${result.stderr}`)
  }
  const stdout = result.stdout.trim()
  if (!stdout) return { allow: true }
  return { allow: false, decision: JSON.parse(stdout) }
}

// Validate runbook content for fixtures. Must be ≥ 256 chars and contain
// "Self-trigger checklist" sentinel.
function validRunbookContent() {
  return [
    '# Test runbook',
    '',
    '## ⚠️ Self-trigger checklist — test fixture',
    '',
    'Padding to reach 256 chars: ' + 'x'.repeat(300),
    '',
    '## Other section',
    'lorem ipsum',
  ].join('\n')
}

function validQuickrefContent() {
  return '## Self-trigger checklist (quickref)\nThis is a quickref body padded for size.\n' + 'x'.repeat(80)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('# Gate detection — positive cases')

test('canonical harness invocation → block', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request --provider codex --dispatch' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.decision, 'block')
  assert.strictEqual(r.decision.code, 'runbook-injection-required')
  assert.ok(r.decision.runbook_sha, 'runbook_sha present')
  assert.ok(r.decision.marker_path.includes('.so-runbook-shown.'))
})

test('absolute-path harness invocation → block', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node /abs/path/scripts/second-opinion.mjs request --provider codex' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'runbook-injection-required')
})

test('quoted-script harness → block', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node "scripts/second-opinion.mjs" request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false, 'quoted form must block')
})

test('splice &&: harness via && → block', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'true && node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false, '&& splice must block')
})

test('env-prefix: FOO=bar node ... request → block', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'FOO=bar node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false, 'env-prefix must block')
})

console.log('\n# Gate detection — negative cases')

test('harness --help → allow', () => {
  const project = makeTmpProject()
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs --help' },
    cwd: project,
  })
  // Allow because no `request` subcommand. May still be blocked by snapshot
  // gate (missing snapshot in test env) — we accept either pure allow OR
  // snapshot block, but NOT runbook-injection-required.
  if (!r.allow) {
    assert.notStrictEqual(r.decision.code, 'runbook-injection-required')
  }
})

test('em-search node call → not runbook-blocked', () => {
  const project = makeTmpProject()
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/em-search.mjs --category lesson' },
    cwd: project,
  })
  if (!r.allow) {
    assert.notStrictEqual(r.decision.code, 'runbook-injection-required')
  }
})

console.log('\n# Runbook validation — fail-closed cases')

test('missing runbook → block runbook-load-failed', () => {
  const project = makeTmpProject()
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: '/nonexistent/runbook.md',
      SO_QUICKREF_PATH: '/nonexistent/quickref.md',
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'runbook-load-failed')
})

test('missing quickref → block runbook-load-failed', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  fs.writeFileSync(path.join(rbDir, 'second-opinion-harness.md'), validRunbookContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'runbook-load-failed')
})

test('too-short runbook → block runbook-load-failed', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, '## ⚠️ Self-trigger checklist\nshort', validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'runbook-load-failed')
})

test('runbook missing sentinel → block runbook-load-failed', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  const noSentinel = '# Heading\n' + 'x'.repeat(400)  // long enough but lacks sentinel
  installRunbook(rbDir, noSentinel, validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'runbook-load-failed')
})

console.log('\n# Marker semantics')

test('marker absent → block, marker_path is canonical', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'runbook-injection-required')
  const sha = computeSha8(validRunbookContent())
  assert.strictEqual(r.decision.runbook_sha, sha)
  assert.ok(r.decision.marker_path.startsWith(project), `marker_path under project: ${r.decision.marker_path}`)
  assert.ok(r.decision.marker_path.endsWith(`.so-runbook-shown.${sha}`))
})

test('marker present → allow', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  const content = validRunbookContent()
  installRunbook(rbDir, content, validQuickrefContent())
  const sha = computeSha8(content)
  fs.writeFileSync(path.join(project, '.checkpoints', `.so-runbook-shown.${sha}`), '')
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, true)
})

test('sha drift → re-block', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  const oldContent = validRunbookContent()
  installRunbook(rbDir, oldContent, validQuickrefContent())
  // Plant a marker for the OLD sha
  const oldSha = computeSha8(oldContent)
  fs.writeFileSync(path.join(project, '.checkpoints', `.so-runbook-shown.${oldSha}`), '')
  // Now mutate the runbook
  const newContent = oldContent + '\n## extra section\n' + 'y'.repeat(50)
  fs.writeFileSync(path.join(rbDir, 'second-opinion-harness.md'), newContent)
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false, 'sha drift must re-block')
  const newSha = computeSha8(newContent)
  assert.strictEqual(r.decision.runbook_sha, newSha)
  assert.notStrictEqual(r.decision.runbook_sha, oldSha)
})

console.log('\n# Gate ordering (P1-2): runbook fires before snapshot')

test('missing snapshot does NOT preempt runbook block', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: project,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
      SO_INSTALL_SNAPSHOT_PATH: '/nonexistent/snap.json',
    },
  })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.decision.code, 'runbook-injection-required',
    `expected runbook-injection-required, got ${r.decision.code}`)
})

console.log('\n# local-dir.mjs failure modes (codex post-impl P1 #2)')

test('malformed local-dir.mjs → block runbook-canonicalize-failed (not silent fallback)', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())

  // Create a tmp installed-hook tree with a SYNTAX-BROKEN local-dir.mjs.
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'so-orphan-lib-'))
  tmpDirs.push(orphan)
  const orphanHooks = path.join(orphan, '.claude', 'hooks')
  const orphanLib = path.join(orphanHooks, 'lib')
  fs.mkdirSync(orphanLib, { recursive: true })
  // Copy the hook so its import.meta.url resolves to <orphan>/.claude/hooks/...
  fs.copyFileSync(HOOK, path.join(orphanHooks, 'second-opinion-gate.mjs'))
  fs.copyFileSync(TIMEOUT_FLOOR_SRC, path.join(orphanLib, 'so-timeout-floor.mjs'))
  // Write a syntactically broken local-dir.mjs
  fs.writeFileSync(path.join(orphanLib, 'local-dir.mjs'), 'export function resolveRepoRoot( {{{ INVALID')

  const r = spawnSync('node', [path.join(orphanHooks, 'second-opinion-gate.mjs')], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/second-opinion.mjs request' },
      cwd: project,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
    timeout: 5000,
  })
  assert.strictEqual(r.status, 0, `hook should exit 0; stderr=${r.stderr}`)
  const decision = JSON.parse(r.stdout)
  assert.strictEqual(decision.decision, 'block')
  assert.strictEqual(decision.code, 'runbook-canonicalize-failed',
    `expected runbook-canonicalize-failed for malformed lib, got ${decision.code}`)
})

test('transitive ERR_MODULE_NOT_FOUND in local-dir.mjs → block (PR-level P1-1)', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())

  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'so-transitive-lib-'))
  tmpDirs.push(orphan)
  const orphanHooks = path.join(orphan, '.claude', 'hooks')
  const orphanLib = path.join(orphanHooks, 'lib')
  fs.mkdirSync(orphanLib, { recursive: true })
  fs.copyFileSync(HOOK, path.join(orphanHooks, 'second-opinion-gate.mjs'))
  fs.copyFileSync(TIMEOUT_FLOOR_SRC, path.join(orphanLib, 'so-timeout-floor.mjs'))
  // local-dir.mjs exists but imports a missing transitive dep
  fs.writeFileSync(path.join(orphanLib, 'local-dir.mjs'),
    "import './nonexistent-dep.mjs'\nexport function resolveRepoRoot(cwd) { return cwd }\n")

  const r = spawnSync('node', [path.join(orphanHooks, 'second-opinion-gate.mjs')], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/second-opinion.mjs request' },
      cwd: project,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
    timeout: 5000,
  })
  assert.strictEqual(r.status, 0, `hook should exit 0; stderr=${r.stderr}`)
  const decision = JSON.parse(r.stdout)
  assert.strictEqual(decision.decision, 'block')
  // Transitive ERR_MODULE_NOT_FOUND must fail closed (not silent fallback).
  assert.strictEqual(decision.code, 'runbook-canonicalize-failed',
    `expected runbook-canonicalize-failed for transitive missing dep, got ${decision.code}`)
})

test('missing local-dir.mjs → cwd fallback (silent, plan v4.1 accepted)', () => {
  const project = makeTmpProject()
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())

  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'so-missing-lib-'))
  tmpDirs.push(orphan)
  const orphanHooks = path.join(orphan, '.claude', 'hooks')
  const orphanLib = path.join(orphanHooks, 'lib')
  fs.mkdirSync(orphanLib, { recursive: true })
  fs.copyFileSync(HOOK, path.join(orphanHooks, 'second-opinion-gate.mjs'))
  fs.copyFileSync(TIMEOUT_FLOOR_SRC, path.join(orphanLib, 'so-timeout-floor.mjs'))
  // Deliberately do NOT create lib/local-dir.mjs

  const r = spawnSync('node', [path.join(orphanHooks, 'second-opinion-gate.mjs')], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node scripts/second-opinion.mjs request' },
      cwd: project,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
    timeout: 5000,
  })
  assert.strictEqual(r.status, 0, `hook should exit 0; stderr=${r.stderr}`)
  const decision = JSON.parse(r.stdout)
  // Should block with runbook-injection-required (gate still works), not with
  // runbook-canonicalize-failed (which is reserved for malformed-lib).
  assert.strictEqual(decision.code, 'runbook-injection-required',
    `expected runbook-injection-required (cwd fallback), got ${decision.code}`)
})

console.log('\n# Worktree canonical-root binding')

test('linked-worktree cwd → marker_path is canonical, not worktree', () => {
  const main = makeTmpProject()
  // Need a commit so worktree add works
  execFileSync('git', ['-C', main, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  const wt = path.join(path.dirname(main), `wt-${path.basename(main)}`)
  tmpDirs.push(wt)
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wtbr', wt], { stdio: ['ignore', 'pipe', 'pipe'] })
  fs.mkdirSync(path.join(wt, '.checkpoints'), { recursive: true })
  const rbDir = makeTmpRunbookDir()
  installRunbook(rbDir, validRunbookContent(), validQuickrefContent())
  const r = runHook({
    toolName: 'Bash',
    toolInput: { command: 'node scripts/second-opinion.mjs request' },
    cwd: wt,
    env: {
      SO_RUNBOOK_PATH: path.join(rbDir, 'second-opinion-harness.md'),
      SO_QUICKREF_PATH: path.join(rbDir, 'second-opinion-harness.quickref.md'),
    },
  })
  assert.strictEqual(r.allow, false)
  // canonical root = main (linked worktree's common-dir is main's .git).
  // realpath both sides — macOS /var/folders is a symlink to /private/var/folders.
  const mainReal = fs.realpathSync(main)
  const wtReal = fs.realpathSync(wt)
  const markerReal = fs.realpathSync(path.dirname(r.decision.marker_path))
  assert.ok(markerReal.startsWith(mainReal),
    `marker_path canonical (${markerReal}) should be under main repo (${mainReal})`)
  assert.ok(!markerReal.startsWith(wtReal) || markerReal === mainReal + '/.checkpoints',
    `marker_path must not be at worktree (${wtReal}): ${markerReal}`)
})

// ---------------------------------------------------------------------------

console.log(`\n${passed}/${passed + failed} pass`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.error}`)
  process.exit(1)
}
