#!/usr/bin/env node
/**
 * test-em-sort-missing-datetime.mjs — Regression tests for the date/time sort
 * crash on index entries missing (or non-string) date/time fields.
 *
 * Bug context (2026-07-04, reported from the Pi Agent harness): a hand-authored
 * episode in pi-extensions was appended to index.jsonl WITHOUT date/time fields
 * (frontmatter used `created:` instead of `date:`/`time:`, bypassing em-store).
 * em-list.mjs:64 then threw:
 *   TypeError: (b.date + b.time).localeCompare is not a function
 * because undefined + undefined === NaN (a number). em-search.mjs:297 has the
 * identical pattern, reachable via --no-score. The default em-search scoring
 * path sorts numerically and never crashed, which is why em_search "worked"
 * while em_list crashed.
 *
 * Sites analyzed but NOT fixable-crash class (guards already exclude bad rows):
 *   - em-recall.mjs:235  — filter requires typeof e.date === 'string' first
 *   - em-check-stale.mjs:79 — `fetched < cutoffStr` rejects undefined/numeric
 *
 * Fix: coerce the sort key via template literal with ?? '' so malformed
 * entries sort last (descending) instead of crashing.
 *
 * Usage: node tests/test-em-sort-missing-datetime.mjs
 * Zero deps — Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const LIST = path.join(REPO, 'scripts', 'em-list.mjs')
const SEARCH = path.join(REPO, 'scripts', 'em-search.mjs')

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

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-sort-dt-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  return {
    root, home, cwd,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function run(script, args, sandbox) {
  const r = spawnSync('node', [script, ...args], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
  })
  let json = null
  try { json = r.stdout ? JSON.parse(r.stdout.trim()) : null } catch { /* leave null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}

// Seed one well-formed episode via the REAL em-store, then append malformed
// index rows the way a foreign harness did (raw JSONL append, bypassing
// em-store). Full matrix from the PR #447 codex review (round 1 REJECT:
// numeric dates stringified to "20260703" out-sort ISO keys like
// "2026-07-04...", so coercion alone is not enough — non-string dates must
// sort LAST):
//   - MISSING_ID:   no date/time at all       (undefined + undefined = NaN)
//   - NUMERIC_ID:   numeric date, no time     (20260702 + undefined = NaN)
//   - NUMBOTH_ID:   numeric date AND time     (number + number = number)
//   - NULLBOTH_ID:  null date and time        (null + null = 0)
//   - TIMEONLY_ID:  no date, string time "23:59" (a time-only key must not
//                   beat ISO date keys in the descending sort)
const MISSING_ID = '20260702-141607-handwritten-no-datetime-badc'
const NUMERIC_ID = '20260703-090000-handwritten-numeric-date-cafe'
const NUMBOTH_ID = '20260703-091500-handwritten-numeric-both-d00d'
const NULLBOTH_ID = '20260703-092000-handwritten-null-both-feed'
const TIMEONLY_ID = '20260703-235900-handwritten-time-only-beef'
const MALFORMED_IDS = [MISSING_ID, NUMERIC_ID, NUMBOTH_ID, NULLBOTH_ID, TIMEONLY_ID]

function seedStore(sandbox) {
  const r = run(STORE, [
    '--project', 'sort-dt-test',
    '--category', 'decision',
    '--summary', 'good episode SENTINEL_good_7f3a',
    '--body', 'body',
    '--scope', 'global',
  ], sandbox)
  assert.strictEqual(r.code, 0, `em-store seed failed: ${r.stderr}`)
  const indexFile = path.join(sandbox.home, '.episodic-memory', 'index.jsonl')
  const badRows = [
    { id: MISSING_ID, project: 'sort-dt-test', category: 'milestone', status: 'active', supersedes: null, tags: ['t'], summary: 'hand-authored, no date/time' },
    { id: NUMERIC_ID, project: 'sort-dt-test', category: 'milestone', status: 'active', supersedes: null, tags: ['t'], summary: 'hand-authored, numeric date', date: 20260703 },
    { id: NUMBOTH_ID, project: 'sort-dt-test', category: 'milestone', status: 'active', supersedes: null, tags: ['t'], summary: 'hand-authored, numeric date and time', date: 20260703, time: 915 },
    { id: NULLBOTH_ID, project: 'sort-dt-test', category: 'milestone', status: 'active', supersedes: null, tags: ['t'], summary: 'hand-authored, null date and time', date: null, time: null },
    { id: TIMEONLY_ID, project: 'sort-dt-test', category: 'milestone', status: 'active', supersedes: null, tags: ['t'], summary: 'hand-authored, string time only', time: '23:59' },
  ]
  fs.appendFileSync(indexFile, badRows.map(x => JSON.stringify(x)).join('\n') + '\n')
  return r.json.id
}

console.log('em-list on malformed index rows:')

test('em-list exits 0 and returns all rows across the malformed matrix', () => {
  const s = makeSandbox()
  try {
    const goodId = seedStore(s)
    const r = run(LIST, ['--project', 'sort-dt-test', '--limit', '10'], s)
    assert.strictEqual(r.code, 0, `em-list crashed: ${r.stderr}`)
    assert.ok(r.json, `em-list stdout is not JSON: ${r.stdout}`)
    assert.strictEqual(r.json.status, 'ok')
    const ids = r.json.episodes.map(e => e.id)
    assert.ok(ids.includes(goodId), `well-formed episode ${goodId} missing from ${ids}`)
    for (const badId of MALFORMED_IDS) {
      assert.ok(ids.includes(badId), `malformed row ${badId} missing from ${ids}`)
    }
  } finally { s.cleanup() }
})

test('em-list sorts ALL malformed rows after the well-formed episode', () => {
  const s = makeSandbox()
  try {
    const goodId = seedStore(s)
    const r = run(LIST, ['--project', 'sort-dt-test', '--limit', '10'], s)
    assert.strictEqual(r.code, 0, `em-list crashed: ${r.stderr}`)
    const ids = r.json.episodes.map(e => e.id)
    for (const badId of MALFORMED_IDS) {
      assert.ok(ids.indexOf(goodId) < ids.indexOf(badId),
        `expected well-formed ${goodId} before malformed ${badId}, got ${ids}`)
    }
  } finally { s.cleanup() }
})

test('em-list --limit 1 returns the well-formed episode, never a malformed row', () => {
  const s = makeSandbox()
  try {
    const goodId = seedStore(s)
    const r = run(LIST, ['--project', 'sort-dt-test', '--limit', '1'], s)
    assert.strictEqual(r.code, 0, `em-list crashed: ${r.stderr}`)
    assert.strictEqual(r.json.count, 1)
    assert.strictEqual(r.json.episodes[0].id, goodId,
      `--limit 1 surfaced ${r.json.episodes[0].id} instead of the well-formed ${goodId}`)
  } finally { s.cleanup() }
})

console.log('em-search on malformed index rows:')

test('em-search --no-score exits 0, returns all rows, malformed rows sort last', () => {
  const s = makeSandbox()
  try {
    const goodId = seedStore(s)
    const r = run(SEARCH, ['--project', 'sort-dt-test', '--no-score', '--no-track', '--limit', '10'], s)
    assert.strictEqual(r.code, 0, `em-search --no-score crashed: ${r.stderr}`)
    assert.ok(r.json, `em-search stdout is not JSON: ${r.stdout}`)
    const ids = r.json.episodes.map(e => e.id)
    assert.ok(ids.includes(goodId), `well-formed episode ${goodId} missing from ${ids}`)
    for (const badId of MALFORMED_IDS) {
      assert.ok(ids.includes(badId), `malformed row ${badId} missing from ${ids}`)
      assert.ok(ids.indexOf(goodId) < ids.indexOf(badId),
        `expected well-formed ${goodId} before malformed ${badId}, got ${ids}`)
    }
  } finally { s.cleanup() }
})

test('em-search default scoring path still exits 0 (pre-existing behavior pinned)', () => {
  const s = makeSandbox()
  try {
    seedStore(s)
    const r = run(SEARCH, ['--project', 'sort-dt-test', '--no-track'], s)
    assert.strictEqual(r.code, 0, `em-search default path crashed: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
  } finally { s.cleanup() }
})

console.log()
console.log(`Tests: ${passed + failed}  passed: ${passed}  failed: ${failed}`)
if (failed > 0) {
  console.log()
  console.log('Failures:')
  for (const f of failures) console.log(`  ${f.name}\n    ${f.error}`)
  process.exit(1)
}
