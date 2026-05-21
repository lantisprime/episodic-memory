#!/usr/bin/env node
/**
 * test-bp1-sweep-loader.mjs — slice 2f shared on-disk loader tests.
 *
 * Coverage:
 *   - missing project / missing bp1-runs → []
 *   - readdir failure → loadIssue surfaced
 *   - run directory present, state.json missing → skipped
 *   - run directory present, state.json corrupt → entry with _corrupt
 *   - run directory present, state.json non-object → skipped
 *   - state.json missing codex_review_entries → entries: []
 *   - state.json with naked + sent entries → preserved verbatim
 *   - mismatched state.run_id vs dir name → dir name wins fallback
 *   - non-directory entries in bp1-runs/ → ignored
 *   - cwd-mismatch axis: caller cwd differs from projectRoot → still lands
 *   - export shape: both loadActiveRunsForSweep + loadActiveRunsFromDir
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const mod = await import(new URL('../scripts/lib/bp1-sweep-loader.mjs', import.meta.url).href)
const { loadActiveRunsForSweep, loadActiveRunsFromDir } = mod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function tmpProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-sweep-loader-test-'))
  return fs.realpathSync(dir)
}

function writeRunState(projectRoot, runId, stateBody) {
  const runDir = path.join(projectRoot, '.episodic-memory', 'bp1-runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'state.json'), stateBody)
}

// ---------------------------------------------------------------------------
// missing path returns []
// ---------------------------------------------------------------------------

tap('loadActiveRunsForSweep returns [] for fresh project (no bp1-runs/)', () => {
  const root = tmpProjectRoot()
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.deepEqual(r.activeRuns, [])
  assert.equal(r.loadIssue, null)
})

tap('loadActiveRunsFromDir returns [] for missing dir', () => {
  const root = tmpProjectRoot()
  const r = loadActiveRunsFromDir(path.join(root, '.episodic-memory', 'bp1-runs'))
  assert.deepEqual(r.activeRuns, [])
  assert.equal(r.loadIssue, null)
})

// ---------------------------------------------------------------------------
// argv shape
// ---------------------------------------------------------------------------

tap('loadActiveRunsForSweep rejects relative projectRoot', () => {
  assert.throws(() => loadActiveRunsForSweep({ projectRoot: './relative' }), /must be an absolute/)
})

tap('loadActiveRunsFromDir rejects relative runsDir', () => {
  assert.throws(() => loadActiveRunsFromDir('./relative'), /must be an absolute/)
})

// ---------------------------------------------------------------------------
// run directory shape variants
// ---------------------------------------------------------------------------

tap('skips run dirs that have no state.json', () => {
  const root = tmpProjectRoot()
  fs.mkdirSync(path.join(root, '.episodic-memory', 'bp1-runs', 'run-a'), { recursive: true })
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.deepEqual(r.activeRuns, [])
})

tap('corrupt state.json surfaces _corrupt entry with empty codex_review_entries', () => {
  const root = tmpProjectRoot()
  writeRunState(root, 'run-b', '{ not json')
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.equal(r.activeRuns.length, 1)
  assert.equal(r.activeRuns[0].run_id, 'run-b')
  assert.deepEqual(r.activeRuns[0].codex_review_entries, [])
  assert.ok(r.activeRuns[0]._corrupt, '_corrupt field is populated')
})

tap('non-object state.json (e.g. literal "null") is skipped silently', () => {
  const root = tmpProjectRoot()
  writeRunState(root, 'run-c', 'null')
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.deepEqual(r.activeRuns, [])
})

tap('state.json missing codex_review_entries → entries: []', () => {
  const root = tmpProjectRoot()
  writeRunState(root, 'run-d', JSON.stringify({ run_id: 'run-d', state: 'active' }))
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.equal(r.activeRuns.length, 1)
  assert.deepEqual(r.activeRuns[0].codex_review_entries, [])
})

tap('state.json with codex_review_entries preserves array verbatim', () => {
  const root = tmpProjectRoot()
  const entries = [
    { entry_id: 'e1', created_at: 1700000000000, request_sent: false, response_received: false },
    { entry_id: 'e2', created_at: 1700000100000, request_sent: true, requested_at: 1700000100000, response_received: false },
  ]
  writeRunState(root, 'run-e', JSON.stringify({ run_id: 'run-e', codex_review_entries: entries }))
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.equal(r.activeRuns.length, 1)
  assert.deepEqual(r.activeRuns[0].codex_review_entries, entries)
})

tap('non-string state.run_id falls back to directory name', () => {
  const root = tmpProjectRoot()
  writeRunState(root, 'run-f-dir', JSON.stringify({ codex_review_entries: [] }))
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.equal(r.activeRuns.length, 1)
  assert.equal(r.activeRuns[0].run_id, 'run-f-dir')
})

tap('non-directory entries in bp1-runs/ are ignored', () => {
  const root = tmpProjectRoot()
  const runsDir = path.join(root, '.episodic-memory', 'bp1-runs')
  fs.mkdirSync(runsDir, { recursive: true })
  fs.writeFileSync(path.join(runsDir, 'README.md'), 'not a run')
  writeRunState(root, 'run-g', JSON.stringify({ run_id: 'run-g', codex_review_entries: [] }))
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.equal(r.activeRuns.length, 1)
  assert.equal(r.activeRuns[0].run_id, 'run-g')
})

// ---------------------------------------------------------------------------
// caller-cwd / axis-9 binding
// ---------------------------------------------------------------------------

tap('cwd-mismatch: loader binds to projectRoot, not process.cwd()', () => {
  const root = tmpProjectRoot()
  writeRunState(root, 'run-h', JSON.stringify({ run_id: 'run-h', codex_review_entries: [] }))
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'unrelated-cwd-'))
  const origCwd = process.cwd()
  try {
    process.chdir(otherCwd)
    const r = loadActiveRunsForSweep({ projectRoot: root })
    assert.equal(r.activeRuns.length, 1)
    assert.equal(r.activeRuns[0].run_id, 'run-h')
  } finally {
    process.chdir(origCwd)
  }
})

// ---------------------------------------------------------------------------
// mixed sources: corrupt + clean siblings
// ---------------------------------------------------------------------------

tap('mixed corrupt + clean siblings: both surface, stale_or_corrupt counted by caller', () => {
  const root = tmpProjectRoot()
  writeRunState(root, 'run-i', JSON.stringify({ run_id: 'run-i', codex_review_entries: [{ entry_id: 'x', created_at: 1, request_sent: false, response_received: false }] }))
  writeRunState(root, 'run-j', '{ broken')
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.equal(r.activeRuns.length, 2)
  const sorted = r.activeRuns.sort((a, b) => a.run_id.localeCompare(b.run_id))
  assert.equal(sorted[0].run_id, 'run-i')
  assert.equal(sorted[0].codex_review_entries.length, 1)
  assert.equal(sorted[1].run_id, 'run-j')
  assert.ok(sorted[1]._corrupt)
})

// ---------------------------------------------------------------------------
// readdir failure
// ---------------------------------------------------------------------------

tap('readdir failure surfaces as loadIssue (best-effort: chmod 0 on dir)', () => {
  if (process.getuid && process.getuid() === 0) {
    // Root bypasses permissions; skip with synthetic pass.
    console.log('# skipping readdir-failure path under uid 0')
    return
  }
  const root = tmpProjectRoot()
  const runsDir = path.join(root, '.episodic-memory', 'bp1-runs')
  fs.mkdirSync(runsDir, { recursive: true })
  fs.chmodSync(runsDir, 0o000)
  try {
    const r = loadActiveRunsFromDir(runsDir)
    assert.deepEqual(r.activeRuns, [])
    assert.ok(r.loadIssue, 'loadIssue surfaced')
    assert.equal(r.loadIssue.code, 'runs_dir_read_failed')
  } finally {
    fs.chmodSync(runsDir, 0o755)
  }
})

// ---------------------------------------------------------------------------
// v1-index FU (codex r2 follow-up): loader is path-based, not _index.json-
// based, so v1-vs-v2 schema migration in bp1-run-state.mjs does not affect
// what the sweep loader sees. This test pins that contract.
// ---------------------------------------------------------------------------

tap('v1 _index.json migration is orthogonal to sweep loader (path-based)', () => {
  const root = tmpProjectRoot()
  // Write a v1-shape _index.json (which loadIndexLocked would migrate in-place).
  // The sweep loader does NOT consult _index.json, so this should not affect
  // its output either way.
  const idxDir = path.join(root, '.episodic-memory', 'runs')
  fs.mkdirSync(idxDir, { recursive: true })
  fs.writeFileSync(path.join(idxDir, '_index.json'), JSON.stringify({
    schema_version: 1, runs: { 'run-v1': { state: 'active' } },
  }))
  // Also populate bp1-runs/run-v1/state.json with codex_review_entries.
  writeRunState(root, 'run-v1', JSON.stringify({
    run_id: 'run-v1',
    codex_review_entries: [{ entry_id: 'naked', created_at: 1, request_sent: false, response_received: false }],
  }))
  const r = loadActiveRunsForSweep({ projectRoot: root })
  assert.equal(r.activeRuns.length, 1)
  assert.equal(r.activeRuns[0].codex_review_entries.length, 1)
})

console.log(`# ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
