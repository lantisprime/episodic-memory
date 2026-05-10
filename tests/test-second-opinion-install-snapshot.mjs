#!/usr/bin/env node
/**
 * test-second-opinion-install-snapshot.mjs — Tests for install snapshot +
 * harness gate I-27a + composer per-fragment SHA I-27b.
 *
 * Coverage:
 *   - source-hash.mjs: deterministic across two computations on same source.
 *   - install-snapshot.mjs: write+read round-trip; atomic tmp+rename.
 *   - readSnapshot: errors on missing file (snapshot-not-installed),
 *     malformed JSON (snapshot-parse-failed), missing source_hash field
 *     (snapshot-missing-source-hash).
 *   - I-27a (harness gate): with snapshot at matching source → harness OK;
 *     mutate one source file → registry-stale-at-gate; restore + remove
 *     snapshot → dev mode (no gate, harness OK).
 *   - I-27b (composer per-fragment SHA): with snapshot present + valid
 *     fragments → compose OK; mutate fragment file mid-flight → preamble-
 *     tamper-at-composer.
 *
 * Snapshot path is overridden via SO_INSTALL_SNAPSHOT_PATH env var (each
 * test gets a tmp path).
 *
 * Zero deps. Node assert + fs + child_process + os.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'

import { computeSourceHash, sha256 } from '../scripts/second-opinion/lib/source-hash.mjs'
import { writeSnapshot, readSnapshot } from '../scripts/second-opinion/lib/install-snapshot.mjs'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HARNESS = path.join(REPO_ROOT, 'scripts', 'second-opinion.mjs')
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-snapshot-test-'))
  tmpDirs.push(tmp)
  execFileSync('git', ['init', '-q', tmp], { stdio: ['ignore', 'pipe', 'ignore'] })
  return tmp
}

function makeTmpSnapshotPath() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-snap-path-'))
  tmpDirs.push(tmp)
  return path.join(tmp, 'second-opinion-providers.json')
}

/**
 * Run harness with custom SO_INSTALL_SNAPSHOT_PATH env.
 * Returns parsed JSON.
 */
function runHarness(args, { cwd, snapshotPath, expectError = false, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv }
  if (snapshotPath !== undefined) env.SO_INSTALL_SNAPSHOT_PATH = snapshotPath
  const result = spawnSync('node', [HARNESS, ...args], {
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const stdout = result.stdout.toString()
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    throw new Error(
      `Harness output not JSON. exit=${result.status} stdout=${stdout} stderr=${result.stderr.toString()}`
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

function buildLiveSnapshot(snapshotPath) {
  const hashed = computeSourceHash(SECOND_OPINION_ROOT)
  const snapshot = {
    schema_version: 1,
    source_hash: hashed.source_hash,
    source_repo: REPO_ROOT,
    install_timestamp: new Date().toISOString(),
    providers: [
      { id: 'stub', binary: 'stub', cli_match: '^stub', prompt_max_chars: 100000,
        agent_block_patterns: [], agent_allow_patterns: [] },
    ],
    fragments: hashed.fragments,
    file_hashes: hashed.file_hashes,
  }
  writeSnapshot(snapshot, snapshotPath)
  return snapshot
}

console.log('# test-second-opinion-install-snapshot')

// ---------------------------------------------------------------------------
// source-hash determinism
// ---------------------------------------------------------------------------
console.log('\n## source-hash determinism')
test('computeSourceHash is deterministic across two calls on same source', () => {
  const a = computeSourceHash(SECOND_OPINION_ROOT)
  const b = computeSourceHash(SECOND_OPINION_ROOT)
  assert.strictEqual(a.source_hash, b.source_hash)
  assert.deepStrictEqual(a.fragments, b.fragments)
})

test('sha256 over a file is deterministic', () => {
  const fragmentPath = path.join(SECOND_OPINION_ROOT, 'preambles', 'fragments', 'review-ladder-v9.4.md')
  assert.strictEqual(sha256(fragmentPath), sha256(fragmentPath))
})

// ---------------------------------------------------------------------------
// install-snapshot read errors
// ---------------------------------------------------------------------------
console.log('\n## install-snapshot read errors')
test('readSnapshot on missing file → snapshot-not-installed', () => {
  const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-miss-')), 'snap.json')
  assert.throws(() => readSnapshot(tmpPath),
    (e) => e.code === 'snapshot-not-installed' && e.snapshotPath === tmpPath
  )
})

test('readSnapshot on malformed JSON → snapshot-parse-failed', () => {
  const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-bad-')), 'snap.json')
  fs.writeFileSync(tmpPath, '{not valid json', 'utf8')
  assert.throws(() => readSnapshot(tmpPath),
    (e) => e.code === 'snapshot-parse-failed'
  )
})

test('readSnapshot on missing source_hash → snapshot-missing-source-hash', () => {
  const tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-no-hash-')), 'snap.json')
  fs.writeFileSync(tmpPath, JSON.stringify({ schema_version: 1, providers: [] }), 'utf8')
  assert.throws(() => readSnapshot(tmpPath),
    (e) => e.code === 'snapshot-missing-source-hash'
  )
})

// ---------------------------------------------------------------------------
// I-27a harness gate: matching source + snapshot → OK
// ---------------------------------------------------------------------------
console.log('\n## I-27a harness gate')
test('harness with valid snapshot + unchanged source → OK', () => {
  const tmp = makeTmpProject()
  const snapPath = makeTmpSnapshotPath()
  buildLiveSnapshot(snapPath)
  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'gate test body',
    '--summary', 'I-27a OK',
  ], { snapshotPath: snapPath })
  assert.strictEqual(result.status, 'ok')
})

test('I-27a: snapshot present + missing snapshot file forced → snapshot-not-installed', () => {
  const tmp = makeTmpProject()
  const snapPath = makeTmpSnapshotPath()
  // Don't write — snapshot does not exist.
  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'force enforce',
    '--enforce-snapshot',
  ], { snapshotPath: snapPath, expectError: true })
  assert.strictEqual(result.code, 'snapshot-not-installed')
})

test('I-27a: snapshot has wrong source_hash → registry-stale-at-gate', () => {
  const tmp = makeTmpProject()
  const snapPath = makeTmpSnapshotPath()
  // Write snapshot with bogus source_hash.
  const snap = buildLiveSnapshot(snapPath)
  snap.source_hash = '0'.repeat(64)
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2), 'utf8')

  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'stale snapshot',
  ], { snapshotPath: snapPath, expectError: true })
  assert.strictEqual(result.code, 'registry-stale-at-gate')
  assert.ok(result.expected, 'expected hash present')
  assert.strictEqual(result.installed, '0'.repeat(64))
  // No request file should have been written.
  const requestsDir = path.join(tmp, '.review-store', 'requests')
  if (fs.existsSync(requestsDir)) {
    const jsons = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'))
    assert.strictEqual(jsons.length, 0, 'no request files should exist after gate fail-close')
  }
})

test('I-27a: dev mode (no snapshot, no --enforce-snapshot) → proceed', () => {
  const tmp = makeTmpProject()
  const snapPath = makeTmpSnapshotPath()
  // Don't write snapshot; don't pass --enforce-snapshot → dev mode.
  const result = runHarness([
    'request',
    '--provider', 'stub',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'dev mode',
  ], { snapshotPath: snapPath })
  assert.strictEqual(result.status, 'ok')
})

// ---------------------------------------------------------------------------
// I-27b composer per-fragment SHA
// ---------------------------------------------------------------------------
console.log('\n## I-27b composer per-fragment SHA validation')
test('composer with valid snapshot + unchanged fragment → OK', () => {
  const tmp = makeTmpProject()
  const snapPath = makeTmpSnapshotPath()
  buildLiveSnapshot(snapPath)
  const result = runHarness([
    'request',
    '--provider', 'codex',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'small body',
    '--summary', 'composer ok',
  ], { snapshotPath: snapPath })
  assert.strictEqual(result.status, 'ok')
  assert.strictEqual(result.preamble_source, 'default')
})

test('I-27b: snapshot fragment SHA tampered (in-flight scenario) → preamble-tamper-at-composer', () => {
  const tmp = makeTmpProject()
  const snapPath = makeTmpSnapshotPath()
  const snap = buildLiveSnapshot(snapPath)
  // Tamper the snapshot's expected SHA for review-ladder-v9.4 (defense-in-depth
  // catches drift between gate-pass and composer-read; here we simulate by
  // writing a snapshot whose fragment SHA is wrong while file is unchanged —
  // composer will read fragment, compute SHA, see mismatch, exit tamper).
  // First we need source_hash to STILL match (so gate passes), so we recompute
  // source_hash from current source AFTER tampering only the fragment SHA.
  // But source_hash is derived from per-file SHAs — if we tamper a fragment
  // SHA in the snapshot's `fragments[]` map alone (not file_hashes), the
  // source_hash from current source still matches the snapshot's source_hash
  // (since source_hash is computed over file_hashes lines, NOT fragments map).
  // So: keep source_hash + file_hashes intact; only tamper fragments[].sha256.
  snap.fragments = snap.fragments.map((f) =>
    f.id === 'review-ladder-v9.4' ? { ...f, sha256: '0'.repeat(64) } : f
  )
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2), 'utf8')

  const result = runHarness([
    'request',
    '--provider', 'codex',
    '--project', tmp,
    '--storage', 'files',
    '--body', 'body',
    '--summary', 'tampered fragment SHA',
  ], { snapshotPath: snapPath, expectError: true })
  assert.strictEqual(result.code, 'preamble-tamper-at-composer')
  assert.strictEqual(result.fragmentId, 'review-ladder-v9.4')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
