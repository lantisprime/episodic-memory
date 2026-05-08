#!/usr/bin/env node
/**
 * test-bp1-hmac-manifest.mjs — run-completion manifest unit tests (PR-1c-B Slice 1A).
 *
 * Coverage in Slice 1A (5 critical scenarios from negative-scenario matrix v2):
 *   - B1: empty-records → episode_count===0, root === sha256("")
 *   - C2: nested-keys-shuffled fixture; stableStringify normalizes inner keys
 *         so signature survives reorder of per_episode_records inner keys
 *   - N3: manifest_schema_version is in the SIGNED payload — flipping it
 *         post-sign breaks verify (semantic version check is replay-side
 *         and lands with bp1-replay.mjs in Slice 3; here we only assert
 *         the field is signed)
 *   - F1: signing key separation — verify with different key fails
 *   - H8: per-record canonical_sha256 tamper → verify fails
 *
 * Deferred to Session B (test-coverage backfill before B's implementation):
 *   - H9-H20 manifest tampering variants
 *   - H21-H28 canonical-field tampering, cross-store equality
 *   - B3 cross-project run_id collision
 *   - C1 episode_id-only tamper
 *   - F2-F4 broader key-separation matrix
 *   - N3 replay-side unknown-schema-version (lands with bp1-replay.mjs)
 *
 * Zero deps; node --test or direct invoke.
 */

import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const mod = await import(new URL('../scripts/lib/bp1-manifest.mjs', import.meta.url).href)
const {
  MANIFEST_SCHEMA_VERSION,
  buildManifestPayload,
  signManifest,
  verifyManifest,
  computeRecordsRoot,
  assertRunIdShape,
  canonicalProjectRootStrict,
} = mod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_RUN_ID = 'bp1-run-1700000000000-rfc-004-abcdef'
const VALID_PROJECT_ROOT = '/tmp/sandbox-project-fixture'
const VALID_FINALIZED_AT = '2026-05-08T18:00:00.000Z'

function makeRecord(suffix, opts = {}) {
  return {
    episode_id: `${VALID_RUN_ID}-${suffix}`,
    canonical_sha256: opts.canonical_sha256 ?? crypto.createHash('sha256').update(`canonical-${suffix}`).digest('hex'),
    body_sha256: opts.body_sha256 ?? crypto.createHash('sha256').update(`body-${suffix}`).digest('hex'),
    hmac_signature: opts.hmac_signature ?? crypto.createHash('sha256').update(`hmac-${suffix}`).digest('hex'),
  }
}

function makeKey() {
  return crypto.randomBytes(32)
}

// =============================================================================
// Tests
// =============================================================================

// --- B1: empty-records -------------------------------------------------------

tap('B1: buildManifestPayload([]) → episode_count===0, root === sha256("")', () => {
  const payload = buildManifestPayload(
    [], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 0,
  )
  assert.equal(payload.episode_count, 0)
  assert.equal(payload.per_episode_records.length, 0)
  assert.equal(payload.episodes_records_root, crypto.createHash('sha256').update('').digest('hex'))
  assert.equal(payload.manifest_schema_version, '1.0')
  assert.equal(payload.run_id, VALID_RUN_ID)
  assert.equal(payload.terminal_state, 'complete')
})

tap('B1: empty-records signature roundtrip (sign + verify)', () => {
  const key = makeKey()
  const payload = buildManifestPayload(
    [], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 0,
  )
  const sig = signManifest(payload, key)
  assert.equal(typeof sig, 'string')
  assert.match(sig, /^[0-9a-f]{64}$/)
  assert.equal(verifyManifest(payload, sig, key), true)
})

tap('B1: episodeCount mismatch with records.length throws', () => {
  assert.throws(
    () => buildManifestPayload(
      [makeRecord('e1')], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 99,
    ),
    /episodeCount \(99\) !== records.length \(1\)/,
  )
})

// --- C2: stableStringify normalizes nested key order ------------------------

tap('C2: nested-keys-shuffled per_episode_records — signature stable across key insertion order', () => {
  const key = makeKey()
  const recA = {
    episode_id: 'eid-1',
    canonical_sha256: 'a'.repeat(64),
    body_sha256: 'b'.repeat(64),
    hmac_signature: 'c'.repeat(64),
  }
  // Same logical record, different key insertion order:
  const recB = {
    hmac_signature: 'c'.repeat(64),
    body_sha256: 'b'.repeat(64),
    episode_id: 'eid-1',
    canonical_sha256: 'a'.repeat(64),
  }
  const payloadA = buildManifestPayload(
    [recA], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 1,
  )
  const payloadB = buildManifestPayload(
    [recB], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 1,
  )
  const sigA = signManifest(payloadA, key)
  const sigB = signManifest(payloadB, key)
  assert.equal(sigA, sigB, 'inner key order should not affect signature')
  assert.equal(verifyManifest(payloadA, sigB, key), true)
  assert.equal(verifyManifest(payloadB, sigA, key), true)
})

tap('C2: top-level keys-shuffled — signature stable', () => {
  const key = makeKey()
  const payloadCanonical = buildManifestPayload(
    [], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 0,
  )
  const sigCanonical = signManifest(payloadCanonical, key)
  // Manually rebuild a payload object with keys in different insertion order.
  const shuffled = {
    per_episode_records: payloadCanonical.per_episode_records,
    finalized_at: payloadCanonical.finalized_at,
    project_root: payloadCanonical.project_root,
    episode_count: payloadCanonical.episode_count,
    manifest_schema_version: payloadCanonical.manifest_schema_version,
    run_id: payloadCanonical.run_id,
    terminal_state: payloadCanonical.terminal_state,
    episodes_records_root: payloadCanonical.episodes_records_root,
  }
  const sigShuffled = signManifest(shuffled, key)
  assert.equal(sigShuffled, sigCanonical, 'top-level key order should not affect signature')
})

// --- N3: manifest_schema_version is in the signed payload --------------------

tap('N3: manifest_schema_version is bound by signature — flipping it breaks verify', () => {
  const key = makeKey()
  const payload = buildManifestPayload(
    [], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 0,
  )
  const sig = signManifest(payload, key)
  assert.equal(verifyManifest(payload, sig, key), true)

  // Tamper: pretend a manifest claims schema 99.0 but uses the original signature.
  const tamperedPayload = { ...payload, manifest_schema_version: '99.0' }
  assert.equal(
    verifyManifest(tamperedPayload, sig, key), false,
    'flipping manifest_schema_version after sign should break verify',
  )
})

tap('N3: MANIFEST_SCHEMA_VERSION constant === "1.0"', () => {
  assert.equal(MANIFEST_SCHEMA_VERSION, '1.0')
})

// --- F1: key separation ------------------------------------------------------

tap('F1: signing key separation — verify with a different key fails', () => {
  const keyA = makeKey()
  const keyB = makeKey()
  const payload = buildManifestPayload(
    [makeRecord('e1'), makeRecord('e2')],
    VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 2,
  )
  const sig = signManifest(payload, keyA)
  assert.equal(verifyManifest(payload, sig, keyA), true)
  assert.equal(verifyManifest(payload, sig, keyB), false)
})

tap('F1: malformed signature hex returns false (not throw)', () => {
  const key = makeKey()
  const payload = buildManifestPayload(
    [], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 0,
  )
  assert.equal(verifyManifest(payload, 'not-hex!!!', key), false)
  assert.equal(verifyManifest(payload, '', key), false)
})

// --- H8: per-record canonical_sha256 tamper ----------------------------------

tap('H8: tamper canonical_sha256 of one record post-sign → verify fails', () => {
  const key = makeKey()
  const records = [makeRecord('e1'), makeRecord('e2'), makeRecord('e3')]
  const payload = buildManifestPayload(
    records, VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 3,
  )
  const sig = signManifest(payload, key)
  assert.equal(verifyManifest(payload, sig, key), true)

  // Build a tampered payload (mutating the original payload's records would
  // also mutate the records-root; here we model "manifest read from disk
  // claims X, but actually the signed bytes were built against Y").
  const tamperedRecords = records.map((r, i) =>
    i === 1 ? { ...r, canonical_sha256: 'f'.repeat(64) } : r,
  )
  const tamperedPayload = {
    ...payload,
    per_episode_records: tamperedRecords,
    // records_root is NOT updated — modeling a forger who only mutated
    // the per_episode_records entries.
  }
  assert.equal(verifyManifest(tamperedPayload, sig, key), false)
})

tap('H8: tamper records_root post-sign → verify fails', () => {
  const key = makeKey()
  const payload = buildManifestPayload(
    [makeRecord('e1')], VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 1,
  )
  const sig = signManifest(payload, key)
  const tampered = { ...payload, episodes_records_root: 'd'.repeat(64) }
  assert.equal(verifyManifest(tampered, sig, key), false)
})

// --- computeRecordsRoot determinism -----------------------------------------

tap('computeRecordsRoot([]) === sha256("")', () => {
  const root = computeRecordsRoot([])
  assert.equal(root, crypto.createHash('sha256').update('').digest('hex'))
})

tap('computeRecordsRoot order-stable: input order does not affect output', () => {
  const r1 = makeRecord('e1')
  const r2 = makeRecord('e2')
  const r3 = makeRecord('e3')
  const root123 = computeRecordsRoot([r1, r2, r3])
  const root321 = computeRecordsRoot([r3, r2, r1])
  const root213 = computeRecordsRoot([r2, r1, r3])
  assert.equal(root123, root321)
  assert.equal(root123, root213)
})

tap('computeRecordsRoot sensitive to record-field changes', () => {
  const r1 = makeRecord('e1')
  const r1Tampered = { ...r1, canonical_sha256: 'e'.repeat(64) }
  assert.notEqual(computeRecordsRoot([r1]), computeRecordsRoot([r1Tampered]))
})

// --- assertRunIdShape (D1 fix) ----------------------------------------------

tap('assertRunIdShape: valid run_id passes', () => {
  assertRunIdShape('bp1-run-12345-rfc-004-abcdef')
})

tap('assertRunIdShape: path traversal attempt throws', () => {
  assert.throws(() => assertRunIdShape('../../../etc/passwd'), /invalid run_id shape/)
  assert.throws(() => assertRunIdShape('foo/bar'), /invalid run_id shape/)
  assert.throws(() => assertRunIdShape('foo bar'), /invalid run_id shape/)
  assert.throws(() => assertRunIdShape(''), /invalid run_id shape/)
  assert.throws(() => assertRunIdShape(null), /invalid run_id shape/)
  assert.throws(() => assertRunIdShape(123), /invalid run_id shape/)
})

// --- canonicalProjectRootStrict (D3 fix) ------------------------------------

tap('canonicalProjectRootStrict: throws when not in a git repo', () => {
  // /tmp typically isn't a git repo at its root. If it is on the dev's
  // machine, the test still asserts the function returns SOMETHING string-y
  // (we're really probing that non-git failure paths throw, not crash).
  let caught = null
  try {
    canonicalProjectRootStrict('/dev/null/nope-not-a-dir-xyz')
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'expected throw on non-git cwd')
  assert.equal(caught.code, 'ProjectRootResolutionFailed')
})

// =============================================================================
// Table-driven manifest tampering (PR-1c-B Slice 2 round-2 codex backfill)
// =============================================================================
//
// Class-completeness: every signed payload field gets a post-sign mutation
// test. Mutations to verifyManifest(tampered, sig, key) MUST return false.
// Reverse direction is implied by B1 roundtrip + C2 nested-shuffle tests.

const TOP_LEVEL_MUTATIONS = [
  // [field, override-value]
  ['manifest_schema_version', '99.0'],          // also covered by N3, kept for table completeness
  ['run_id', 'bp1-run-9999999999999-tampered'],
  ['project_root', '/tmp/some-other-project'],
  ['terminal_state', 'aborted'],
  ['finalized_at', '2099-01-01T00:00:00.000Z'],
  ['episode_count', 0],
  ['episodes_records_root', 'd'.repeat(64)],    // also covered by H8 single-record case
]

for (const [field, badValue] of TOP_LEVEL_MUTATIONS) {
  tap(`tamper-table top-level: flipping ${field} after sign breaks verify`, () => {
    const key = makeKey()
    const records = [makeRecord('e1'), makeRecord('e2'), makeRecord('e3')]
    const payload = buildManifestPayload(
      records, VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 3,
    )
    const sig = signManifest(payload, key)
    assert.equal(verifyManifest(payload, sig, key), true, 'baseline must verify')
    const tampered = { ...payload, [field]: badValue }
    assert.equal(
      verifyManifest(tampered, sig, key), false,
      `flipping ${field} after sign should break verify`,
    )
  })
}

const RECORD_MUTATIONS = [
  // [field, override-value]
  ['episode_id', 'tampered-episode-id'],
  ['canonical_sha256', 'a'.repeat(64)],         // also covered by H8
  ['body_sha256', 'b'.repeat(64)],
  ['hmac_signature', 'c'.repeat(64)],
]

for (const [field, badValue] of RECORD_MUTATIONS) {
  tap(`tamper-table record-field: flipping per_episode_records[1].${field} breaks verify`, () => {
    const key = makeKey()
    const records = [makeRecord('e1'), makeRecord('e2'), makeRecord('e3')]
    const payload = buildManifestPayload(
      records, VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 3,
    )
    const sig = signManifest(payload, key)
    assert.equal(verifyManifest(payload, sig, key), true, 'baseline must verify')
    const tamperedRecords = payload.per_episode_records.map((r, i) =>
      i === 1 ? { ...r, [field]: badValue } : r,
    )
    const tampered = { ...payload, per_episode_records: tamperedRecords }
    assert.equal(
      verifyManifest(tampered, sig, key), false,
      `flipping per_episode_records[1].${field} after sign should break verify`,
    )
  })
}

// Record-list shape mutations: drop, reorder (same content), append, swap-id
tap('tamper-table list: dropping a record after sign breaks verify', () => {
  const key = makeKey()
  const records = [makeRecord('e1'), makeRecord('e2'), makeRecord('e3')]
  const payload = buildManifestPayload(
    records, VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 3,
  )
  const sig = signManifest(payload, key)
  const tampered = { ...payload, per_episode_records: payload.per_episode_records.slice(0, 2) }
  assert.equal(verifyManifest(tampered, sig, key), false)
})

tap('tamper-table list: appending a record after sign breaks verify', () => {
  const key = makeKey()
  const records = [makeRecord('e1'), makeRecord('e2')]
  const payload = buildManifestPayload(
    records, VALID_RUN_ID, VALID_PROJECT_ROOT, 'complete', VALID_FINALIZED_AT, 2,
  )
  const sig = signManifest(payload, key)
  const tampered = {
    ...payload,
    per_episode_records: [...payload.per_episode_records, makeRecord('e3')],
  }
  assert.equal(verifyManifest(tampered, sig, key), false)
})

// =============================================================================
// Summary
// =============================================================================

const total = pass + fail
console.log(`\n# tests ${total}`)
console.log(`# pass ${pass}`)
console.log(`# fail ${fail}`)
if (fail > 0) process.exit(1)
