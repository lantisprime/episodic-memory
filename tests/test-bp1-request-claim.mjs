#!/usr/bin/env node
/**
 * test-bp1-request-claim.mjs — bp1-request-claim primitive (RFC §1214-1259).
 *
 * Slice 2e C4 forward-ready lib coverage (~6 cases):
 *   - RC1 O_EXCL create on fresh entry → claim file present, schema matches
 *         RFC §1220-1229, claim_id is random hex
 *   - RC2 O_EXCL collision → second caller sees created:false +
 *         existing_claim (preserved from first writer, not overwritten)
 *   - RC3 schema validation — bad runId / entryId / attemptNumber / negative
 *         ttlSeconds rejected with TypeError
 *   - RC4 stale-derivation helper — claimAgeSeconds reflects elapsed time;
 *         non-stale (age < TTL) does NOT clear claim (slice 2f's concern)
 *   - RC5 readClaim — returns null on ENOENT, parsed object on hit,
 *         null on malformed JSON
 *   - RC6 idempotencyKey — deterministic; differs for any field change
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const mod = await import(new URL('../scripts/lib/bp1-request-claim.mjs', import.meta.url).href)
const {
  tryCreateClaim,
  readClaim,
  claimPath,
  claimAgeSeconds,
  idempotencyKey,
  REQUEST_CLAIM_TTL_SECONDS,
} = mod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-claim-test-'))
  return fs.realpathSync(dir)
}

const RUN_ID = 'bp1-run-1730000000000-rfc-test-aabbcc'
const ENTRY_ID = 'bp1-run-1730000000000-rfc-test-aabbcc-codex-review-aabb'

// =============================================================================
// RC1 O_EXCL fresh create
// =============================================================================
tap('RC1 fresh create → claim file present, RFC §1220-1229 schema, random claim_id', () => {
  const proj = mkTmpProject()
  const r = tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 1,
  })
  assert.equal(r.created, true)
  assert.equal(r.claimPath, claimPath(proj, RUN_ID, ENTRY_ID))
  assert.ok(fs.existsSync(r.claimPath), 'claim file present on disk')
  // RFC §1220-1229 schema fields.
  assert.match(r.claim.claim_id, /^[0-9a-f]{32}$/, 'claim_id is 32-hex')
  assert.equal(r.claim.parent_episode_id, ENTRY_ID)
  assert.equal(r.claim.attempt_number, 1)
  assert.equal(r.claim.ttl_seconds, REQUEST_CLAIM_TTL_SECONDS)
  assert.equal(r.claim.writer_run_id, RUN_ID)
  assert.match(r.claim.claimed_at, /^\d{4}-\d{2}-\d{2}T/, 'claimed_at is ISO-8601')
  // Disk content matches.
  const onDisk = JSON.parse(fs.readFileSync(r.claimPath, 'utf8'))
  assert.deepEqual(onDisk, r.claim)
})

// =============================================================================
// RC2 O_EXCL collision
// =============================================================================
tap('RC2 second tryCreate collides → created:false + existing_claim preserved', () => {
  const proj = mkTmpProject()
  const first = tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 1,
  })
  assert.equal(first.created, true)
  const second = tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 2,
  })
  assert.equal(second.created, false)
  assert.deepEqual(second.existing_claim, first.claim,
    'existing_claim must match first writer; no overwrite')
  // File contents unchanged from first claim.
  const onDisk = JSON.parse(fs.readFileSync(first.claimPath, 'utf8'))
  assert.equal(onDisk.attempt_number, 1, 'attempt_number from FIRST writer, not 2')
})

// =============================================================================
// RC3 schema validation
// =============================================================================
tap('RC3 input validation rejects bad runId / entryId / attemptNumber / ttlSeconds', () => {
  const proj = mkTmpProject()
  assert.throws(() => tryCreateClaim({
    projectRoot: 'rel/path', runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 0,
  }), /projectRoot must be an absolute path/)
  assert.throws(() => tryCreateClaim({
    projectRoot: proj, runId: 'BAD UPPER', entryId: ENTRY_ID, attemptNumber: 0,
  }), /runId shape invalid/)
  assert.throws(() => tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: 'bad/slash', attemptNumber: 0,
  }), /entryId shape invalid/)
  assert.throws(() => tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: -1,
  }), /attemptNumber must be a non-negative integer/)
  assert.throws(() => tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 1.5,
  }), /attemptNumber must be a non-negative integer/)
  assert.throws(() => tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 0,
    ttlSeconds: 0,
  }), /ttlSeconds must be a positive integer/)
})

// =============================================================================
// RC4 stale-derivation (slice 2f-deferred recovery; lib only exposes the helper)
// =============================================================================
tap('RC4 claimAgeSeconds reflects elapsed time; non-stale does NOT clear claim', () => {
  const proj = mkTmpProject()
  // Stamp the claim "in the past" via opts.now.
  const fakeNow = Date.now() - 30_000
  const r = tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 0,
    now: () => fakeNow,
  })
  assert.equal(r.created, true)
  // age relative to wall-clock now should be ~30s, well under TTL.
  const age = claimAgeSeconds(r.claim, Date.now())
  assert.ok(age >= 30 && age < REQUEST_CLAIM_TTL_SECONDS,
    `expected ~30s age, got ${age} (TTL=${REQUEST_CLAIM_TTL_SECONDS})`)
  // RFC §1250-1259 stale-clear is slice 2f's concern — claim file MUST
  // still exist after age-check.
  assert.ok(fs.existsSync(r.claimPath), 'claim file untouched by helper (no auto-clear)')

  // Synthetic stale claim (age > TTL) — helper reports age correctly.
  const oldClaim = { ...r.claim, claimed_at: new Date(Date.now() - (REQUEST_CLAIM_TTL_SECONDS + 30) * 1000).toISOString() }
  const oldAge = claimAgeSeconds(oldClaim, Date.now())
  assert.ok(oldAge >= REQUEST_CLAIM_TTL_SECONDS, `stale age should be ≥ TTL; got ${oldAge}`)

  // Pure helper returns null on garbage input.
  assert.equal(claimAgeSeconds(null), null)
  assert.equal(claimAgeSeconds({ claimed_at: 'not-iso' }), null)
})

// =============================================================================
// RC5 readClaim — ENOENT / hit / malformed
// =============================================================================
tap('RC5 readClaim: ENOENT → null; hit → parsed; malformed JSON → null', () => {
  const proj = mkTmpProject()
  assert.equal(readClaim({ projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID }), null,
    'ENOENT → null')
  const r = tryCreateClaim({
    projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID, attemptNumber: 0,
  })
  const hit = readClaim({ projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID })
  assert.deepEqual(hit, r.claim, 'hit returns full RFC-shaped claim object')
  // Corrupt the file → readClaim returns null without throwing.
  fs.writeFileSync(r.claimPath, '{ this is not json')
  assert.equal(readClaim({ projectRoot: proj, runId: RUN_ID, entryId: ENTRY_ID }), null,
    'malformed JSON → null')
})

// =============================================================================
// RC6 idempotencyKey — deterministic + sensitive to every field
// =============================================================================
tap('RC6 idempotencyKey is deterministic and changes on any field flip', () => {
  const base = idempotencyKey(RUN_ID, ENTRY_ID, 1)
  assert.match(base, /^[0-9a-f]{64}$/)
  // Deterministic
  assert.equal(idempotencyKey(RUN_ID, ENTRY_ID, 1), base)
  // Sensitive to attempt_number
  assert.notEqual(idempotencyKey(RUN_ID, ENTRY_ID, 2), base)
  // Sensitive to entry_id
  assert.notEqual(idempotencyKey(RUN_ID, `${ENTRY_ID}-other`, 1), base)
  // Sensitive to run_id
  assert.notEqual(idempotencyKey(`${RUN_ID}-other`, ENTRY_ID, 1), base)
  // Rejects garbage
  assert.throws(() => idempotencyKey('BAD UPPER', ENTRY_ID, 1), /runId shape invalid/)
  assert.throws(() => idempotencyKey(RUN_ID, ENTRY_ID, -1), /non-negative integer/)
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
