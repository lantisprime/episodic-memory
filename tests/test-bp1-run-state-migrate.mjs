#!/usr/bin/env node
/**
 * test-bp1-run-state-migrate.mjs — v1→v2 migrator unit tests (slice 2c CR2-3).
 *
 * Coverage:
 *   - empty v1 → empty v2
 *   - single v1 entry → 3 new fields default to null
 *   - v2 input → defensive copy (no mutation of input)
 *   - terminal v1 entry preserved (terminal_at non-null)
 *   - multiple runs migrated independently
 *   - rejects unsupported schema_version
 *   - rejects non-object input
 *   - rejects runs non-object
 */

import assert from 'node:assert/strict'

const mod = await import(new URL('../scripts/lib/bp1-run-state-migrate.mjs', import.meta.url).href)
const { migrateV1ToV2, V1_SCHEMA, V2_SCHEMA } = mod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// =============================================================================
// M1: empty v1 → empty v2
// =============================================================================
tap('M1 empty v1 → empty v2', () => {
  const r = migrateV1ToV2({ schema_version: V1_SCHEMA, runs: {} })
  assert.deepEqual(r, { schema_version: V2_SCHEMA, runs: {} })
})

// =============================================================================
// M2: single v1 active run → 3 new fields default to null
// =============================================================================
tap('M2 single v1 active run gets 3 new null fields', () => {
  const v1 = {
    schema_version: V1_SCHEMA,
    runs: {
      'bp1-run-1-foo-aabbcc': {
        project_root: '/path/to/proj',
        state: 'active',
        created_at: '2026-05-15T10:00:00Z',
        terminal_at: null,
      },
    },
  }
  const v2 = migrateV1ToV2(v1)
  assert.equal(v2.schema_version, V2_SCHEMA)
  const run = v2.runs['bp1-run-1-foo-aabbcc']
  assert.equal(run.state, 'active')
  assert.equal(run.terminal_at, null)
  assert.equal(run.decided_class, null)
  assert.equal(run.pre_episode_id, null)
  assert.equal(run.rfc_detected_episode_id, null)
})

// =============================================================================
// M3: v2 input → defensive copy (idempotence)
// =============================================================================
tap('M3 v2 input → defensive copy (idempotence + no mutation)', () => {
  const v2 = {
    schema_version: V2_SCHEMA,
    runs: {
      'bp1-run-2-bar-ddee': {
        project_root: '/p',
        state: 'classified',
        created_at: '2026-05-15T11:00:00Z',
        terminal_at: null,
        decided_class: 'trivial',
        pre_episode_id: 'bp1-run-2-bar-ddee-pre-1234',
        rfc_detected_episode_id: 'bp1-run-2-bar-ddee-rfc-detected-5678',
      },
    },
  }
  const result = migrateV1ToV2(v2)
  assert.equal(result.schema_version, V2_SCHEMA)
  assert.deepEqual(result, v2)
  // Defensive copy: mutating result doesn't affect v2.
  result.runs['bp1-run-2-bar-ddee'].state = 'aborted'
  assert.equal(v2.runs['bp1-run-2-bar-ddee'].state, 'classified')
})

// =============================================================================
// M4: terminal v1 entry preserved
// =============================================================================
tap('M4 v1 terminal run preserved (terminal_at non-null)', () => {
  const v1 = {
    schema_version: V1_SCHEMA,
    runs: {
      'bp1-run-3-baz-eeff': {
        project_root: '/q',
        state: 'complete',
        created_at: '2026-05-15T12:00:00Z',
        terminal_at: '2026-05-15T12:05:00Z',
      },
    },
  }
  const v2 = migrateV1ToV2(v1)
  const run = v2.runs['bp1-run-3-baz-eeff']
  assert.equal(run.state, 'complete')
  assert.equal(run.terminal_at, '2026-05-15T12:05:00Z')
})

// =============================================================================
// M5: multiple runs migrated independently
// =============================================================================
tap('M5 multiple runs migrated independently', () => {
  const v1 = {
    schema_version: V1_SCHEMA,
    runs: {
      'bp1-run-4-a-1111': { project_root: '/a', state: 'active', created_at: 't1', terminal_at: null },
      'bp1-run-4-b-2222': { project_root: '/b', state: 'aborted', created_at: 't2', terminal_at: 't3' },
    },
  }
  const v2 = migrateV1ToV2(v1)
  assert.equal(Object.keys(v2.runs).length, 2)
  assert.equal(v2.runs['bp1-run-4-a-1111'].decided_class, null)
  assert.equal(v2.runs['bp1-run-4-b-2222'].state, 'aborted')
  assert.equal(v2.runs['bp1-run-4-b-2222'].terminal_at, 't3')
})

// =============================================================================
// M6: rejects unsupported schema_version
// =============================================================================
tap('M6 reject unsupported schema_version', () => {
  assert.throws(() => migrateV1ToV2({ schema_version: 99, runs: {} }), /unsupported schema_version/)
})

// =============================================================================
// M7: rejects non-object input
// =============================================================================
tap('M7 reject non-object input', () => {
  assert.throws(() => migrateV1ToV2(null), /must be an object/)
  assert.throws(() => migrateV1ToV2([]), /must be an object/)
  assert.throws(() => migrateV1ToV2('foo'), /must be an object/)
})

// =============================================================================
// M8: rejects malformed runs entry
// =============================================================================
tap('M8 reject runs entry that is not an object', () => {
  assert.throws(() => migrateV1ToV2({
    schema_version: V1_SCHEMA,
    runs: { 'bp1-run-bad': 'not-an-object' },
  }), /not an object/)
})

// =============================================================================
// M9: CR2-3 regression — appendRun on a v1 on-disk index does not deadlock
// =============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const rsMod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { appendRun, loadIndex, indexPath } = rsMod

tap('M9 CR2-3 regression — appendRun on v1 index migrates without lock-timeout', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-migrate-reentrancy-')))
  // Pre-seed a v1 index on disk so appendRun must migrate inside the lock.
  fs.mkdirSync(path.join(proj, '.episodic-memory', 'runs'), { recursive: true })
  fs.writeFileSync(indexPath(proj), JSON.stringify({
    schema_version: 1,
    runs: {
      'bp1-run-pre-existing-aabb': {
        project_root: proj,
        state: 'active',
        created_at: '2026-05-15T08:00:00Z',
        terminal_at: null,
      },
    },
  }, null, 2) + '\n')
  const r = appendRun(proj, 'bp1-run-new-after-migrate-ccdd', proj)
  assert.equal(r.error, undefined, `appendRun returned error: ${r.error}`)
  assert.ok(r.ok)
  // Verify both old + new runs exist + on-disk index is v2.
  const idx = loadIndex(proj)
  assert.equal(idx.schema_version, 2)
  assert.ok(idx.runs['bp1-run-pre-existing-aabb'])
  assert.ok(idx.runs['bp1-run-new-after-migrate-ccdd'])
  // Pre-existing run got the 3 default null fields.
  assert.equal(idx.runs['bp1-run-pre-existing-aabb'].decided_class, null)
  assert.equal(idx.runs['bp1-run-pre-existing-aabb'].pre_episode_id, null)
  assert.equal(idx.runs['bp1-run-pre-existing-aabb'].rfc_detected_episode_id, null)
  // New run also has the v2 fields populated.
  assert.equal(idx.runs['bp1-run-new-after-migrate-ccdd'].decided_class, null)
})

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
