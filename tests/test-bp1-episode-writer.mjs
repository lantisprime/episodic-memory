#!/usr/bin/env node
/**
 * test-bp1-episode-writer.mjs — Generic episode-writer lib tests (slice 2c).
 *
 * Coverage (plan v4):
 *   - writes signed state-transition episode round-trippable through parser
 *   - HMAC verifies against canonical bytes
 *   - frontmatter ordering: id, run_id, type, state, parent_episode, ...,
 *     type-specific fields, body_sha256, hmac_signature, tags, ...
 *   - rejects: missing 32B key, bad runId shape, relative projectRoot,
 *     reserved-key collision in customFm, number values
 *   - JSON-quoting on summary preserves whitespace + special chars
 *   - tags include 'bp1-evidence-snapshot' default plus caller-supplied
 *   - failure type subtype canonicalization works (failure_kind drives lookup)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const writerMod = await import(new URL('../scripts/lib/bp1-episode-writer.mjs', import.meta.url).href)
const { writeBp1Episode } = writerMod

const parserMod = await import(new URL('../scripts/lib/bp1-frontmatter.mjs', import.meta.url).href)
const { parseBp1Frontmatter } = parserMod

const canonMod = await import(new URL('../scripts/lib/bp1-canonicalize.mjs', import.meta.url).href)
const { canonicalize } = canonMod

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyCanonical } = hmacMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-writer-test-'))
  return fs.realpathSync(dir)
}

const KEY = crypto.randomBytes(32)
const RUN_ID = 'bp1-run-1730000000000-rfc-004-aabbcc'

// =============================================================================
// T1: round-trip — write state-transition:rfc-detected, parse, verify HMAC
// =============================================================================
tap('T1 round-trip — rfc-detected episode signed + parser round-trips + HMAC verifies', () => {
  const projectRoot = mkTmpProject()
  const result = writeBp1Episode({
    projectRoot,
    runId: RUN_ID,
    runKey32B: KEY,
    type: 'state-transition',
    state: 'rfc-detected',
    summary: 'rfc-004 detected',
    parentEpisode: null,
    expectedPostEpisodeId: null,
    customFm: {
      rfc_id: 'RFC-004',
      frontmatter_sha256: 'a'.repeat(64),
    },
    tags: ['bp1-rfc-detected'],
    body: '# rfc-detected\n\nbody text\n',
    filenameSuffix: 'rfc-detected',
  })
  assert.ok(result.episodeId.includes('rfc-detected'))
  assert.ok(fs.existsSync(result.episodePath))
  const parsed = parseBp1Frontmatter(fs.readFileSync(result.episodePath))
  assert.equal(parsed.frontmatter.type, 'state-transition')
  assert.equal(parsed.frontmatter.state, 'rfc-detected')
  assert.equal(parsed.frontmatter.run_id, RUN_ID)
  assert.equal(parsed.frontmatter.rfc_id, 'RFC-004')
  assert.equal(parsed.frontmatter.frontmatter_sha256, 'a'.repeat(64))
  // HMAC verifies against canonical bytes from parsed frontmatter + body.
  const { canonicalBytes } = canonicalize(parsed.frontmatter, parsed.body)
  assert.ok(verifyCanonical(canonicalBytes, KEY, parsed.frontmatter.hmac_signature))
})

// =============================================================================
// T2: parent_episode pointer preserved (string, not 'null')
// =============================================================================
tap('T2 parent_episode pointer preserved as string', () => {
  const projectRoot = mkTmpProject()
  const result = writeBp1Episode({
    projectRoot,
    runId: RUN_ID,
    runKey32B: KEY,
    type: 'state-transition',
    state: 'classifier-dispatch-pending',
    summary: 'classifier dispatch pending',
    parentEpisode: `${RUN_ID}-rfc-detected-aabb`,
    expectedPostEpisodeId: null,
    customFm: { input_sha256: 'b'.repeat(64) },
    body: '# pre\n',
    filenameSuffix: 'pre',
  })
  const parsed = parseBp1Frontmatter(fs.readFileSync(result.episodePath))
  assert.equal(parsed.frontmatter.parent_episode, `${RUN_ID}-rfc-detected-aabb`)
  assert.equal(parsed.frontmatter.input_sha256, 'b'.repeat(64))
})

// =============================================================================
// T3: HMAC tamper — flipping a canonical field invalidates signature
// =============================================================================
tap('T3 HMAC tamper detection — flip canonical field invalidates signature', () => {
  const projectRoot = mkTmpProject()
  const result = writeBp1Episode({
    projectRoot,
    runId: RUN_ID,
    runKey32B: KEY,
    type: 'state-transition',
    state: 'rfc-detected',
    summary: 's',
    parentEpisode: null,
    expectedPostEpisodeId: null,
    customFm: { rfc_id: 'RFC-004', frontmatter_sha256: 'c'.repeat(64) },
    body: '# body\n',
    filenameSuffix: 'rfc-detected',
  })
  // Tamper the on-disk file by overwriting rfc_id to RFC-005.
  const original = fs.readFileSync(result.episodePath, 'utf8')
  const tampered = original.replace('rfc_id: "RFC-004"', 'rfc_id: "RFC-005"')
  fs.writeFileSync(result.episodePath, tampered)
  const parsed = parseBp1Frontmatter(fs.readFileSync(result.episodePath))
  const { canonicalBytes } = canonicalize(parsed.frontmatter, parsed.body)
  assert.equal(verifyCanonical(canonicalBytes, KEY, parsed.frontmatter.hmac_signature), false)
})

// =============================================================================
// T4: failure type subtype canonicalization
// =============================================================================
tap('T4 failure:classifier-schema-violation canonicalized + signed', () => {
  const projectRoot = mkTmpProject()
  const result = writeBp1Episode({
    projectRoot,
    runId: RUN_ID,
    runKey32B: KEY,
    type: 'failure',
    state: null,
    summary: 'classifier schema violation: confidence out of range',
    parentEpisode: `${RUN_ID}-pre-aabb`,
    expectedPostEpisodeId: null,
    customFm: {
      failure_kind: 'classifier-schema-violation',
      field_name: 'confidence',
      observed_value: '"1.5"',
      violation_reason: 'value above maximum 1',
    },
    body: '# failure\n',
    filenameSuffix: 'classifier-schema-violation',
  })
  const parsed = parseBp1Frontmatter(fs.readFileSync(result.episodePath))
  assert.equal(parsed.frontmatter.type, 'failure')
  assert.equal(parsed.frontmatter.failure_kind, 'classifier-schema-violation')
  assert.equal(parsed.frontmatter.field_name, 'confidence')
  const { canonicalBytes } = canonicalize(parsed.frontmatter, parsed.body)
  assert.ok(verifyCanonical(canonicalBytes, KEY, parsed.frontmatter.hmac_signature))
})

// =============================================================================
// T5: rejects wrong-size runKey
// =============================================================================
tap('T5 reject runKey wrong size', () => {
  const projectRoot = mkTmpProject()
  assert.throws(() => writeBp1Episode({
    projectRoot, runId: RUN_ID,
    runKey32B: Buffer.alloc(16),   // wrong size
    type: 'state-transition', state: 'rfc-detected',
    summary: 's', parentEpisode: null, expectedPostEpisodeId: null,
    customFm: { rfc_id: 'X', frontmatter_sha256: 'd'.repeat(64) },
    body: '', filenameSuffix: 'rfc-detected',
  }), /32-byte Buffer/)
})

// =============================================================================
// T6: rejects bad runId shape
// =============================================================================
tap('T6 reject runId with traversal chars', () => {
  const projectRoot = mkTmpProject()
  assert.throws(() => writeBp1Episode({
    projectRoot, runId: '../escape',
    runKey32B: KEY,
    type: 'state-transition', state: 'rfc-detected',
    summary: 's', parentEpisode: null, expectedPostEpisodeId: null,
    customFm: {}, body: '', filenameSuffix: 'rfc-detected',
  }), /runId shape invalid/)
})

// =============================================================================
// T7: rejects relative projectRoot
// =============================================================================
tap('T7 reject relative projectRoot', () => {
  assert.throws(() => writeBp1Episode({
    projectRoot: 'relative/path',
    runId: RUN_ID, runKey32B: KEY,
    type: 'state-transition', state: 'rfc-detected',
    summary: 's', parentEpisode: null, expectedPostEpisodeId: null,
    customFm: {}, body: '', filenameSuffix: 'rfc-detected',
  }), /must be absolute/)
})

// =============================================================================
// T8: rejects reserved key in customFm
// =============================================================================
tap('T8 reject customFm field colliding with reserved key', () => {
  const projectRoot = mkTmpProject()
  assert.throws(() => writeBp1Episode({
    projectRoot, runId: RUN_ID, runKey32B: KEY,
    type: 'state-transition', state: 'rfc-detected',
    summary: 's', parentEpisode: null, expectedPostEpisodeId: null,
    customFm: { id: 'sneaky' },    // collides with reserved 'id'
    body: '', filenameSuffix: 'rfc-detected',
  }), /reserved key/)
})

// =============================================================================
// T9: rejects numeric values in customFm (canonicalize-stable contract)
// =============================================================================
tap('T9 reject numeric customFm value (caller must pre-stringify)', () => {
  const projectRoot = mkTmpProject()
  assert.throws(() => writeBp1Episode({
    projectRoot, runId: RUN_ID, runKey32B: KEY,
    type: 'state-transition', state: 'classified',
    summary: 's', parentEpisode: null, expectedPostEpisodeId: null,
    customFm: {
      decided_class: 'trivial',
      classifier_confidence: 0.85,   // number — must be pre-stringified
    },
    body: '', filenameSuffix: 'classified',
  }), /numbers must be pre-stringified/)
})

// =============================================================================
// T10: JSON-quoted string with whitespace round-trips
// =============================================================================
tap('T10 JSON-quoted string with whitespace round-trips through parser', () => {
  const projectRoot = mkTmpProject()
  const summary = 'BP-1 run started: with spaces and "quotes" and tabs\there'
  const result = writeBp1Episode({
    projectRoot, runId: RUN_ID, runKey32B: KEY,
    type: 'state-transition', state: 'rfc-detected',
    summary,
    parentEpisode: null, expectedPostEpisodeId: null,
    customFm: { rfc_id: 'RFC-004', frontmatter_sha256: 'e'.repeat(64) },
    body: '', filenameSuffix: 'rfc-detected',
  })
  const parsed = parseBp1Frontmatter(fs.readFileSync(result.episodePath))
  assert.equal(parsed.frontmatter.summary, summary)
})

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
