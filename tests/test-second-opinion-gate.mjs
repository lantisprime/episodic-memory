#!/usr/bin/env node
/**
 * test-second-opinion-gate.mjs — Tests for hooks/second-opinion-gate.mjs
 * (Claude Code PreToolUse hook for second-opinion harness gating).
 *
 * Coverage:
 *   - I-11 (fixture): missing snapshot → block with snapshot-not-installed code
 *   - Bash branch:
 *     * codex command + run_in_background: true → block
 *     * codex command + length > prompt_max_chars → block
 *     * codex command + cwd is worktree + no --allow-worktree → block
 *     * codex command + cwd is worktree + --allow-worktree → allow
 *     * em-store --scope local + worktree cwd → block
 *     * non-provider command (e.g., ls) → allow
 *     * codex command + foreground + main repo cwd + small → allow
 *   - Agent branch:
 *     * codex:codex-rescue (in block_patterns) → block
 *     * codex:setup (in allow_patterns) → allow
 *     * unknown subagent → allow
 *   - Stdin handling:
 *     * No stdin → allow (don't block on missing input)
 *     * Malformed JSON → allow (Claude Code spec)
 *
 * Hook is invoked as a subprocess; stdin is the synthetic PreToolUse JSON.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'

import { computeSourceHash } from '../scripts/second-opinion/lib/source-hash.mjs'
import { writeSnapshot } from '../scripts/second-opinion/lib/install-snapshot.mjs'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HOOK = path.join(REPO_ROOT, 'plugins', 'claude-code', 'hooks', 'second-opinion-gate.mjs')
const SECOND_OPINION_ROOT = path.join(REPO_ROOT, 'scripts', 'second-opinion')

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-gate-test-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  return tmp
}

function makeTmpWorktree(mainRepo) {
  execFileSync('git', ['-C', mainRepo, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  const wt = path.join(path.dirname(mainRepo), `wt-${path.basename(mainRepo)}`)
  tmpDirs.push(wt)
  execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', '-b', 'wtbr', wt], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return wt
}

function makeTmpSnapshotPath() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-gate-snap-'))
  tmpDirs.push(tmp)
  return path.join(tmp, 'second-opinion-providers.json')
}

function buildLiveSnapshot(snapshotPath) {
  const hashed = computeSourceHash(SECOND_OPINION_ROOT)
  const snapshot = {
    schema_version: 1,
    source_hash: hashed.source_hash,
    source_repo: REPO_ROOT,
    install_timestamp: new Date().toISOString(),
    providers: [
      {
        id: 'codex', binary: 'codex', cli_match: '^codex\\s+exec\\b',
        prompt_max_chars: 200000,
        agent_block_patterns: ['codex:codex-rescue', 'codex:codex-cli-runtime'],
        agent_allow_patterns: ['codex:setup', 'codex:gpt-5-4-prompting', 'codex:codex-result-handling'],
      },
      {
        id: 'opencode', binary: 'opencode', cli_match: '^opencode\\s+run\\b',
        prompt_max_chars: 200000,
        agent_block_patterns: [], agent_allow_patterns: [],
      },
    ],
    fragments: hashed.fragments,
    file_hashes: hashed.file_hashes,
  }
  writeSnapshot(snapshot, snapshotPath)
  return snapshot
}

/**
 * Run the hook with synthetic stdin JSON. Returns { exitCode, stdout, stderr,
 * decision } where decision is parsed from stdout if present.
 */
function runHook(input, { snapshotPath } = {}) {
  const env = { ...process.env }
  if (snapshotPath !== undefined) env.SO_INSTALL_SNAPSHOT_PATH = snapshotPath

  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const stdout = result.stdout.toString()
  let decision = null
  if (stdout.trim()) {
    try {
      decision = JSON.parse(stdout)
    } catch {
      // Hook should always emit valid JSON or empty stdout.
    }
  }
  return {
    exitCode: result.status,
    stdout,
    stderr: result.stderr.toString(),
    decision,
  }
}

console.log('# test-second-opinion-gate')

// ---------------------------------------------------------------------------
// Snapshot fail-closed cases
// ---------------------------------------------------------------------------
console.log('\n## Snapshot fail-closed (any provider call could be the bypass)')
test('missing snapshot → block', () => {
  const tmp = makeTmpSnapshotPath()
  // Don't write snapshot.
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "hi"' }, cwd: '/tmp' },
    { snapshotPath: tmp },
  )
  assert.strictEqual(r.exitCode, 0)
  assert.ok(r.decision, `expected JSON decision, got: ${r.stdout}`)
  assert.strictEqual(r.decision.decision, 'block')
  assert.strictEqual(r.decision.code, 'snapshot-not-installed')
})

test('malformed snapshot JSON → block', () => {
  const tmp = makeTmpSnapshotPath()
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, '{not json', 'utf8')
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "hi"' }, cwd: '/tmp' },
    { snapshotPath: tmp },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.strictEqual(r.decision.code, 'snapshot-parse-failed')
})

test('snapshot missing source_hash → block', () => {
  const tmp = makeTmpSnapshotPath()
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ schema_version: 1, providers: [] }), 'utf8')
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "hi"' }, cwd: '/tmp' },
    { snapshotPath: tmp },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.strictEqual(r.decision.code, 'snapshot-missing-source-hash')
})

// I-NEW-B: snapshot providers[] validated by same contract as source
// registry. Hook fail-closes on invalid shape rather than silent-skip
// in compileCliMatch.
test('empty providers[] snapshot → block snapshot-invalid-providers', () => {
  const tmp = makeTmpSnapshotPath()
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({
    schema_version: 1, source_hash: 'dummy', providers: [],
  }), 'utf8')
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "hi"', run_in_background: true }, cwd: '/tmp' },
    { snapshotPath: tmp },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.strictEqual(r.decision.code, 'snapshot-invalid-providers')
  assert.strictEqual(r.decision.field, 'providers')
})

test('malformed cli_match (invalid regex) → block snapshot-invalid-providers', () => {
  const tmp = makeTmpSnapshotPath()
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({
    schema_version: 1, source_hash: 'dummy',
    providers: [{
      id: 'codex', binary: 'codex', cli_match: '[', prompt_max_chars: 1000,
      agent_block_patterns: [], agent_allow_patterns: [],
    }],
  }), 'utf8')
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "hi"', run_in_background: true }, cwd: '/tmp' },
    { snapshotPath: tmp },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.strictEqual(r.decision.code, 'snapshot-invalid-providers')
  assert.strictEqual(r.decision.field, 'cli_match')
  assert.strictEqual(r.decision.provider, 'codex')
})

// F4 regression: installed hook with MISSING lib (partial install / orphan
// hook) must emit snapshot-validator-load-failed block decision rather than
// crashing at module-load with empty stdout (ambiguous fail-open class).
test('installed hook with missing validator lib → block snapshot-validator-load-failed', () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'so-orphan-hook-'))
  tmpDirs.push(tempBase)
  const installedHooksDir = path.join(tempBase, '.claude', 'hooks')
  fs.mkdirSync(installedHooksDir, { recursive: true })

  // Copy ONLY the hook — deliberately omit the validator lib to simulate
  // partial filesystem failure.
  fs.copyFileSync(HOOK, path.join(installedHooksDir, 'second-opinion-gate.mjs'))

  // Snapshot path doesn't matter (hook fails before reading snapshot).
  const snapPath = path.join(installedHooksDir, 'second-opinion-providers.json')
  const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'so-orphan-cwd-'))
  tmpDirs.push(outsideCwd)
  const r = spawnSync('node', [path.join(installedHooksDir, 'second-opinion-gate.mjs')], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'codex exec "hi"', run_in_background: true },
      cwd: outsideCwd,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: outsideCwd,
    env: { ...process.env, SO_INSTALL_SNAPSHOT_PATH: snapPath },
    encoding: 'utf8',
  })

  assert.strictEqual(r.status, 0, `hook should exit 0 with block JSON; got status=${r.status}, stderr=${r.stderr}`)
  const decision = JSON.parse(r.stdout)
  assert.strictEqual(decision.decision, 'block')
  assert.strictEqual(decision.code, 'snapshot-validator-load-failed')
})

// R3-F1 / R7-F1: installed-hook test. Copy hook + dereferenced validator
// lib to a temp ~/.claude/hooks-shaped dir; run the COPIED hook from cwd
// outside the repo against a malformed snapshot. Verifies the install
// copy mechanics work (hook can import its colocated lib at runtime).
test('installed hook (outside-repo cwd) fail-closes on invalid snapshot', () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'so-installed-hook-'))
  tmpDirs.push(tempBase)
  const installedHooksDir = path.join(tempBase, '.claude', 'hooks')
  const installedLibDir = path.join(installedHooksDir, 'lib')
  fs.mkdirSync(installedLibDir, { recursive: true })

  // Copy hook + dereferenced validator (fs.copyFileSync dereferences the
  // repo-side symlink, writing a regular file at the destination).
  fs.copyFileSync(HOOK, path.join(installedHooksDir, 'second-opinion-gate.mjs'))
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts/second-opinion/lib/registry-validator.mjs'),
    path.join(installedLibDir, 'registry-validator.mjs'),
  )

  // Verify the copy is a regular file (not a symlink).
  const stat = fs.lstatSync(path.join(installedLibDir, 'registry-validator.mjs'))
  assert.ok(stat.isFile() && !stat.isSymbolicLink(),
    `installed validator must be regular file, got isSymlink=${stat.isSymbolicLink()}`)

  // Write malformed snapshot.
  const snapPath = path.join(installedHooksDir, 'second-opinion-providers.json')
  fs.writeFileSync(snapPath, JSON.stringify({
    schema_version: 1, source_hash: 'dummy',
    providers: [{
      id: 'codex', binary: 'codex', cli_match: '[', prompt_max_chars: 1000,
      agent_block_patterns: [], agent_allow_patterns: [],
    }],
  }), 'utf8')

  // Run the INSTALLED hook from cwd outside the repo.
  const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'so-outside-'))
  tmpDirs.push(outsideCwd)
  const r = spawnSync('node', [path.join(installedHooksDir, 'second-opinion-gate.mjs')], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'codex exec "hi"', run_in_background: true },
      cwd: outsideCwd,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: outsideCwd,
    env: { ...process.env, SO_INSTALL_SNAPSHOT_PATH: snapPath },
    encoding: 'utf8',
  })

  assert.strictEqual(r.status, 0, `hook exit should be 0; stderr=${r.stderr}`)
  const decision = JSON.parse(r.stdout)
  assert.strictEqual(decision.decision, 'block')
  assert.strictEqual(decision.code, 'snapshot-invalid-providers')
  assert.strictEqual(decision.field, 'cli_match')
})

// ---------------------------------------------------------------------------
// Bash branch
// ---------------------------------------------------------------------------
console.log('\n## Bash branch')
test('codex command + run_in_background:true → block', () => {
  const proj = makeTmpProject()
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "review this"', run_in_background: true }, cwd: proj },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.match(r.decision.reason, /run_in_background/)
})

test('codex command + length > prompt_max_chars → block', () => {
  const proj = makeTmpProject()
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const giant = 'codex exec "' + 'x'.repeat(250000) + '"'
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: giant }, cwd: proj },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.match(r.decision.reason, /prompt_max_chars/)
})

test('codex command + worktree cwd + no --allow-worktree → block', () => {
  const main = makeTmpProject()
  const wt = makeTmpWorktree(main)
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "hi"' }, cwd: wt },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.match(r.decision.reason, /worktree/)
})

test('codex command + worktree cwd + --allow-worktree → allow', () => {
  const main = makeTmpProject()
  const wt = makeTmpWorktree(main)
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec --allow-worktree "hi"' }, cwd: wt },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null, `expected allow (empty stdout), got: ${r.stdout}`)
})

test('em-store --scope local + worktree cwd → block (PR #218 anti-pattern)', () => {
  const main = makeTmpProject()
  const wt = makeTmpWorktree(main)
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'node scripts/em-store.mjs --scope local --project x' }, cwd: wt },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.match(r.decision.reason, /em-store.*local/)
})

test('non-provider command (ls) → allow', () => {
  const proj = makeTmpProject()
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: proj },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null)
})

test('codex command + foreground + main repo + small → allow', () => {
  const proj = makeTmpProject()
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'codex exec "small prompt"' }, cwd: proj },
    { snapshotPath: snap },
  )
  // foreground + small + non-worktree + not em-store → allow.
  // Note: per the gate, direct provider calls in foreground from main repo
  // are NOT blocked as a class — only the 4 specific block conditions fire.
  // Acceptance is intentional: harness IS supposed to use foreground codex
  // exec from main repo (the wrapper script we used in this very session).
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null)
})

// opencode provider: cli_match is scoped to `^opencode\s+run\b`, so the
// review invocation is gated but the bare TUI / other subcommands are not.
test('opencode run command + run_in_background:true → block', () => {
  const proj = makeTmpProject()
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'opencode run -m deepseek/deepseek-v4-pro "review this"', run_in_background: true }, cwd: proj },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.match(r.decision.reason, /run_in_background/)
})

test('bare opencode (TUI, no run subcommand) → allow (cli_match scoping)', () => {
  const proj = makeTmpProject()
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'opencode', run_in_background: true }, cwd: proj },
    { snapshotPath: snap },
  )
  // `^opencode\s+run\b` must NOT match bare `opencode` — the interactive TUI
  // and non-review subcommands stay free even with run_in_background set.
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null, `expected allow (empty stdout), got: ${r.stdout}`)
})

test('opencode models subcommand → allow (cli_match scoping)', () => {
  const proj = makeTmpProject()
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Bash', tool_input: { command: 'opencode models deepseek', run_in_background: true }, cwd: proj },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null, `expected allow (empty stdout), got: ${r.stdout}`)
})

// ---------------------------------------------------------------------------
// Agent branch
// ---------------------------------------------------------------------------
console.log('\n## Agent branch')
test('Agent(codex:codex-rescue) → block', () => {
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Agent', tool_input: { subagent_type: 'codex:codex-rescue' }, cwd: '/tmp' },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
  assert.match(r.decision.reason, /Agent.*codex:codex-rescue/)
})

test('Agent(codex:codex-cli-runtime) → block', () => {
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Agent', tool_input: { subagent_type: 'codex:codex-cli-runtime' }, cwd: '/tmp' },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
})

test('Agent(codex:setup) → allow (in agent_allow_patterns)', () => {
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Agent', tool_input: { subagent_type: 'codex:setup' }, cwd: '/tmp' },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null)
})

test('Agent(unknown-namespace:foo) → allow (default-open)', () => {
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' }, cwd: '/tmp' },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null)
})

test('Task tool variant (subagent_type) blocks same as Agent', () => {
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Task', tool_input: { subagent_type: 'codex:codex-rescue' }, cwd: '/tmp' },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.decision.decision, 'block')
})

// ---------------------------------------------------------------------------
// Other tool names
// ---------------------------------------------------------------------------
console.log('\n## Other tools')
test('Read tool → allow (out of gate scope)', () => {
  const snap = makeTmpSnapshotPath()
  buildLiveSnapshot(snap)
  const r = runHook(
    { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, cwd: '/tmp' },
    { snapshotPath: snap },
  )
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.decision, null)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
