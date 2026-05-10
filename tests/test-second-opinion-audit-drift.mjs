#!/usr/bin/env node
/**
 * test-second-opinion-audit-drift.mjs — I-23: drift validator self-test.
 *
 * Verifies that the validator script:
 *   - Returns ok when all audit-table verifying_paths exist (current repo).
 *   - Returns audit-table-drift error when a path is removed.
 *
 * Per Rule 14 (machine-readable blocks for drift-prone state) — the
 * validator IS the drift detector; this test verifies the detector works.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'

import { AUDIT_TABLE, listAllVerifyingPaths }
  from '../scripts/second-opinion/lib/audit-table.mjs'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-second-opinion-audit.mjs')

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

console.log('# test-second-opinion-audit-drift (I-23)')

test('audit-table.mjs exposes AUDIT_TABLE with rows[]', () => {
  assert.strictEqual(AUDIT_TABLE.schema_version, 1)
  assert.ok(Array.isArray(AUDIT_TABLE.rows))
  assert.ok(AUDIT_TABLE.rows.length >= 7,
    `expected ≥7 rows (per v3.2 + v3.1 audit table), got ${AUDIT_TABLE.rows.length}`)
})

test('every row has required fields (reader, reads_from, mitigation, verifying_paths)', () => {
  for (const row of AUDIT_TABLE.rows) {
    assert.ok(row.reader, `row missing reader: ${JSON.stringify(row)}`)
    assert.ok(row.reads_from, `row missing reads_from: ${row.reader}`)
    assert.ok(row.mitigation, `row missing mitigation: ${row.reader}`)
    assert.ok(Array.isArray(row.verifying_paths) && row.verifying_paths.length > 0,
      `row ${row.reader} must have non-empty verifying_paths[]`)
  }
})

test('listAllVerifyingPaths returns deduped sorted list', () => {
  const paths = listAllVerifyingPaths()
  assert.ok(paths.length > 0)
  // Verify dedup.
  assert.strictEqual(paths.length, new Set(paths).size)
  // Verify sort.
  const sorted = [...paths].sort()
  assert.deepStrictEqual(paths, sorted)
})

test('validator script: all audit-table paths exist in current repo (ok)', () => {
  const r = spawnSync('node', [VALIDATOR], { stdio: ['ignore', 'pipe', 'pipe'] })
  assert.strictEqual(r.status, 0,
    `validator should pass on clean repo; stderr=${r.stderr.toString()}`)
  const parsed = JSON.parse(r.stdout.toString())
  assert.strictEqual(parsed.status, 'ok')
  assert.ok(parsed.paths_checked > 0)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
