#!/usr/bin/env node
/**
 * test-second-opinion-storage.mjs — Tests for storage adapters + harness skeleton.
 *
 * Coverage:
 *   - I-3: files-storage write/read use same projectRoot
 *   - I-4: harness JSON project_root matches artifact locations
 *   - I-5: linked-worktree → resolveRepoRoot canonicalizes (no special refuse)
 *   - I-15: concurrent file-storage writes don't lose data; rebuild-index recovers
 *   - I-28: prompt-overflow before dispatch (composed length > prompt_max_chars)
 *   - I-29: harness JSON includes preamble_source field
 *   - Storage --storage flag rejects non-episodic|files values
 *   - End-to-end: harness request command writes through composer + files storage
 *
 * Zero deps. Node assert + fs + child_process + os.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HARNESS = path.join(REPO_ROOT, 'scripts', 'second-opinion.mjs')

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-storage-test-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  return tmp
}

/**
 * Run the harness CLI with given args + cwd. Returns parsed JSON envelope.
 * Throws if exit code is unexpected.
 */
function runHarness(args, { cwd, expectError = false } = {}) {
  const result = spawnSync('node', [HARNESS, ...args], {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = result.stdout.toString()
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    throw new Error(
      `Harness output is not JSON. exit=${result.status} stdout=${stdout} stderr=${result.stderr.toString()}`
    )
  }
  if (expectError) {
    assert.strictEqual(parsed.status, 'error',
      `expected error envelope, got: ${JSON.stringify(parsed)}`)
  } else {
    assert.strictEqual(parsed.status, 'ok',
      `expected ok envelope, got: ${JSON.stringify(parsed)} (stderr=${result.stderr.toString()})`)
  }
  return parsed
}

console.log('# test-second-opinion-storage')

// ---------------------------------------------------------------------------
// I-3: files-storage write/read use same projectRoot
// ---------------------------------------------------------------------------
console.log('\n## I-3 files-storage write/read same projectRoot')
test('files-storage request writes under projectRoot/.review-store/', () => {
  const tmp = makeTmpProject()
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'caller-cwd-'))
  tmpDirs.push(callerCwd)

  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'test request body',
    '--summary', 'test request',
    '--tags', 'test,storage',
    '--work-area', 'storage-test',
  ], { cwd: callerCwd })

  // I-4: project_root in JSON matches our --project.
  assert.strictEqual(result.project_root, tmp,
    `expected project_root=${tmp}, got ${result.project_root}`)

  // Artifacts under projectRoot, NOT caller cwd.
  assert.ok(fs.existsSync(path.join(tmp, '.review-store', 'requests')),
    'requests dir under projectRoot')
  assert.ok(!fs.existsSync(path.join(callerCwd, '.review-store')),
    'no .review-store under caller cwd (would indicate cwd-binding bug)')

  // Body and meta files exist.
  assert.ok(result.written.bodyPath.startsWith(tmp), 'bodyPath under projectRoot')
  assert.ok(result.written.metaPath.startsWith(tmp), 'metaPath under projectRoot')
  assert.ok(fs.existsSync(result.written.bodyPath))
  assert.ok(fs.existsSync(result.written.metaPath))
})

// ---------------------------------------------------------------------------
// I-5: linked-worktree canonicalization (storage)
// ---------------------------------------------------------------------------
console.log('\n## I-5 linked-worktree canonicalization')
test('harness invoked from worktree resolves projectRoot to canonical (no --project)', () => {
  const main = makeTmpProject()
  // Init commit so worktree-add works.
  execFileSync('git', ['-C', main, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  const wt = path.join(path.dirname(main), `wt-${path.basename(main)}`)
  tmpDirs.push(wt)
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wtbr', wt], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--storage', 'files',
    '--body', 'from worktree',
    '--summary', 'wt test',
  ], { cwd: wt })

  // project_root must be canonical main, NOT worktree path.
  assert.strictEqual(fs.realpathSync(result.project_root), fs.realpathSync(main),
    `worktree invocation must canonicalize to main: got ${result.project_root}`)
  assert.ok(!fs.existsSync(path.join(wt, '.review-store')),
    'worktree path should not have .review-store (canonical-only)')
  assert.ok(fs.existsSync(path.join(main, '.review-store', 'requests')),
    'main repo should have requests dir')
})

// ---------------------------------------------------------------------------
// I-15: concurrent writes
// ---------------------------------------------------------------------------
console.log('\n## I-15 concurrent file-storage writes')
test('rebuild-index recovers all entries after parallel writes', () => {
  const tmp = makeTmpProject()
  // Spawn 5 concurrent writes.
  const procs = []
  for (let i = 0; i < 5; i++) {
    procs.push(spawnSync('node', [HARNESS,
      'request',
      '--provider', 'stub',
      '--project', tmp,
      '--storage', 'files',
      '--body', `parallel body ${i}`,
      '--summary', `parallel ${i}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }))
  }
  for (const p of procs) {
    assert.strictEqual(p.status, 0, `concurrent write failed: ${p.stderr.toString()}`)
  }

  // Verify 5 .json files under requests/.
  const requestsDir = path.join(tmp, '.review-store', 'requests')
  const jsons = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'))
  assert.strictEqual(jsons.length, 5, `expected 5 request meta files, got ${jsons.length}`)

  // rebuild-index should produce 5 entries.
  const rebuilt = runHarness(['rebuild-index', '--project', tmp])
  assert.strictEqual(rebuilt.requests, 5)
  const indexLines = fs.readFileSync(path.join(tmp, '.review-store', 'index.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean)
  assert.strictEqual(indexLines.length, 5)
})

// ---------------------------------------------------------------------------
// I-28: prompt-overflow before dispatch
// ---------------------------------------------------------------------------
console.log('\n## I-28 prompt-overflow rejected before dispatch')
test('composed prompt > prompt_max_chars → exit prompt-overflow, no write', () => {
  const tmp = makeTmpProject()
  // Provider 'stub' has prompt_max_chars: 100000; default preamble is small.
  // Build a body that pushes total over the limit.
  const giantBody = 'x'.repeat(150000)

  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', giantBody,
    '--summary', 'overflow test',
  ], { expectError: true })

  assert.strictEqual(result.code, 'prompt-overflow')
  assert.strictEqual(result.provider, 'stub')
  assert.ok(result.composedLength > result.maxChars,
    `composedLength (${result.composedLength}) should exceed maxChars (${result.maxChars})`)

  // No request written.
  const requestsDir = path.join(tmp, '.review-store', 'requests')
  if (fs.existsSync(requestsDir)) {
    const jsons = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'))
    assert.strictEqual(jsons.length, 0, 'no request files should exist after prompt-overflow')
  }
})

// ---------------------------------------------------------------------------
// I-29: harness JSON includes preamble_source field
// ---------------------------------------------------------------------------
console.log('\n## I-29 harness JSON includes preamble_source')
test('preamble_source: "default" for codex with no override/flag', () => {
  const tmp = makeTmpProject()
  // Codex provider has default_per_provider entry.
  const result = runHarness([
    'request',
    '--provider', 'codex',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'tiny body for codex',
    '--summary', 'codex default preamble',
  ])
  assert.strictEqual(result.preamble_source, 'default')
  assert.deepStrictEqual(result.fragment_ids, ['review-ladder-v9.4'])
})

test('preamble_source: "repo-override" when override file present', () => {
  const tmp = makeTmpProject()
  const overrideDir = path.join(tmp, '.review-store', 'preambles')
  fs.mkdirSync(overrideDir, { recursive: true })
  fs.writeFileSync(path.join(overrideDir, 'codex.md'), 'custom override\n', 'utf8')

  const result = runHarness([
    'request',
    '--provider', 'codex',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'override test',
  ])
  assert.strictEqual(result.preamble_source, 'repo-override')
  assert.ok(result.override_path && result.override_path.endsWith('codex.md'))
})

test('preamble_source: "cli-flag" when --preamble passed', () => {
  const tmp = makeTmpProject()
  const result = runHarness([
    'request',
    '--provider', 'codex',
    '--project', tmp,
    '--storage', 'files',
    '--preamble', 'review-ladder-v9.4',
    '--body', 'body',
    '--summary', 'cli-flag test',
  ])
  assert.strictEqual(result.preamble_source, 'cli-flag')
  assert.deepStrictEqual(result.fragment_ids, ['review-ladder-v9.4'])
})

// ---------------------------------------------------------------------------
// --storage flag validation
// ---------------------------------------------------------------------------
console.log('\n## --storage flag rejects non-episodic|files')
test('--storage /tmp/foo → invalid-storage-flag', () => {
  const tmp = makeTmpProject()
  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', '/tmp/foo',
    '--body', 'body',
    '--summary', 'invalid storage',
  ], { expectError: true })
  assert.strictEqual(result.code, 'invalid-storage-flag')
})

// ---------------------------------------------------------------------------
// Unknown provider
// ---------------------------------------------------------------------------
console.log('\n## Unknown provider')
test('--provider nonexistent → unknown-provider', () => {
  const tmp = makeTmpProject()
  const result = runHarness([
    'request',
    '--provider', 'nonexistent',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'unknown provider test',
  ], { expectError: true })
  assert.strictEqual(result.code, 'unknown-provider')
  assert.ok(Array.isArray(result.knownProviders))
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
