#!/usr/bin/env node
/**
 * test-bp1-canonicalize.mjs — Canonicalize lib tests.
 *
 * Coverage (plan v4):
 *   - H21-H24 (state-transition:codex_review + evidence:bp1-codex-request-sent
 *     tampering — fields canonicalized → tamper changes hmac).
 *   - H25 (non-canonical fields don't affect signature — documented behaviour).
 *   - 5 Issue #185 tamper tests (state-transition:run-started fields).
 *   - AC1 projection rename mapping pinned.
 *   - I5 determinism (key-order shuffle → identical bytes).
 *   - I8 non-canonical add/remove (same as H25).
 *   - Boundary fixtures: null projection, zero-byte body.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const cmod = await import(new URL('../scripts/lib/bp1-canonicalize.mjs', import.meta.url).href)
const {
  GENERIC_CANONICAL_FIELDS,
  TYPE_SPECIFIC_CANONICAL_FIELDS,
  canonicalize,
  canonicalizeFrontmatterBytes,
  projectProbeResultToFrontmatter,
  subtypeKey,
} = cmod

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { signCanonical, verifyCanonical } = hmacMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

const KEY = crypto.randomBytes(32)

function runStartedFrontmatter(overrides = {}) {
  return {
    type: 'state-transition',
    state: 'run-started',
    run_id: 'bp1-run-test-rfc004-aabbcc',
    parent_episode: null,
    expected_post_episode_id: null,
    summary: 'BP-1 run started',
    scheduled_tasks_capability: 'fallback',
    probe_reason: 'm1_not_implemented',
    degraded_mode_statement: 'manual fallback active',
    native_probe_performed: false,
    t2_fallback: false,
    ...overrides,
  }
}

function codexReviewFrontmatter(overrides = {}) {
  return {
    type: 'state-transition',
    state: 'codex_review',
    run_id: 'bp1-run-test-codex-aabbcc',
    parent_episode: 'parent-ep-1',
    expected_post_episode_id: null,
    summary: 'codex review entry',
    attempt_number: 1,
    parent_state_transition: null,
    ...overrides,
  }
}

function evidenceCodexRequestSentFrontmatter(overrides = {}) {
  return {
    type: 'evidence',
    tags: ['bp1-codex-request-sent'],
    run_id: 'bp1-run-test-evidence-aabbcc',
    parent_episode: null,
    expected_post_episode_id: null,
    summary: 'codex request sent',
    requested_at: '2026-05-07T12:00:00Z',
    review_request_ref: 'em-review-request-abc',
    ...overrides,
  }
}

// =============================================================================
// Determinism (#18 I5) + sorted-key invariant
// =============================================================================
tap('I5 determinism — same projected fields produce identical canonical bytes', () => {
  const fm1 = runStartedFrontmatter()
  const fm2 = runStartedFrontmatter()
  // Shuffle key order in fm2 (build a new object with reverse-sorted keys).
  const fm2Shuffled = {}
  for (const k of Object.keys(fm2).sort().reverse()) fm2Shuffled[k] = fm2[k]
  const r1 = canonicalize(fm1, 'body')
  const r2 = canonicalize(fm2Shuffled, 'body')
  assert.equal(r1.canonicalBytes.toString('hex'), r2.canonicalBytes.toString('hex'),
    'shuffled-key-order canonical bytes must be byte-identical')
})

tap('canonicalize payload keys are sorted', () => {
  const fm = runStartedFrontmatter()
  const { payload } = canonicalize(fm, 'body')
  const keys = Object.keys(payload)
  const sorted = [...keys].sort()
  assert.deepEqual(keys, sorted, 'payload keys must be sorted')
})

// =============================================================================
// Generic + type-specific projection: every registered field appears in payload
// =============================================================================
tap('payload contains all GENERIC_CANONICAL_FIELDS', () => {
  const fm = runStartedFrontmatter()
  const { payload } = canonicalize(fm, 'body')
  for (const field of GENERIC_CANONICAL_FIELDS) {
    assert.ok(field in payload, `payload missing generic field ${field}`)
  }
})

tap('payload contains all 5 Issue #185 fields for run-started subtype', () => {
  const fm = runStartedFrontmatter()
  const { payload } = canonicalize(fm, 'body')
  for (const field of TYPE_SPECIFIC_CANONICAL_FIELDS['state-transition:run-started']) {
    assert.ok(field in payload, `payload missing run-started field ${field}`)
  }
})

// =============================================================================
// Issue #185 tamper × 5 — each canonical field, when tampered, breaks the sig
// =============================================================================
const ISSUE_185_FIELDS = [
  'scheduled_tasks_capability',
  'probe_reason',
  'degraded_mode_statement',
  'native_probe_performed',
  't2_fallback',
]

for (const field of ISSUE_185_FIELDS) {
  tap(`Issue #185 tamper of ${field} → verify false`, () => {
    const fmA = runStartedFrontmatter()
    const fmB = runStartedFrontmatter({
      [field]:
        field === 'scheduled_tasks_capability' ? 'native' :
        field === 'probe_reason'                ? 'list_succeeded' :
        field === 'degraded_mode_statement'     ? 'tampered statement' :
        field === 'native_probe_performed'      ? true :
        field === 't2_fallback'                 ? true :
        '__tampered__',
    })
    const a = canonicalize(fmA, 'body')
    const b = canonicalize(fmB, 'body')
    const sigA = signCanonical(a.canonicalBytes, KEY)
    // Tampered canonical bytes must not verify against the original sig.
    assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), false)
    // Sanity: original verifies.
    assert.equal(verifyCanonical(a.canonicalBytes, KEY, sigA), true)
  })
}

// =============================================================================
// H21-H22 (codex_review subtype tamper)
// =============================================================================
tap('H21 tamper attempt_number in codex_review → verify false', () => {
  const fmA = codexReviewFrontmatter({ attempt_number: 1 })
  const fmB = codexReviewFrontmatter({ attempt_number: 2 })
  const a = canonicalize(fmA, 'body')
  const b = canonicalize(fmB, 'body')
  const sigA = signCanonical(a.canonicalBytes, KEY)
  assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), false)
})

tap('H22 tamper parent_state_transition in codex_review → verify false', () => {
  const fmA = codexReviewFrontmatter({ parent_state_transition: null })
  const fmB = codexReviewFrontmatter({ parent_state_transition: 'ep-prev' })
  const a = canonicalize(fmA, 'body')
  const b = canonicalize(fmB, 'body')
  const sigA = signCanonical(a.canonicalBytes, KEY)
  assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), false)
})

// =============================================================================
// H23-H24 (evidence:bp1-codex-request-sent subtype tamper)
// =============================================================================
tap('H23 tamper review_request_ref in evidence → verify false', () => {
  const fmA = evidenceCodexRequestSentFrontmatter({ review_request_ref: 'em-A' })
  const fmB = evidenceCodexRequestSentFrontmatter({ review_request_ref: 'em-B' })
  const a = canonicalize(fmA, 'body')
  const b = canonicalize(fmB, 'body')
  const sigA = signCanonical(a.canonicalBytes, KEY)
  assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), false)
})

tap('H24 tamper requested_at in evidence → verify false', () => {
  const fmA = evidenceCodexRequestSentFrontmatter({ requested_at: '2026-05-07T12:00:00Z' })
  const fmB = evidenceCodexRequestSentFrontmatter({ requested_at: '2026-05-07T13:00:00Z' })
  const a = canonicalize(fmA, 'body')
  const b = canonicalize(fmB, 'body')
  const sigA = signCanonical(a.canonicalBytes, KEY)
  assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), false)
})

// =============================================================================
// H25 — non-canonical frontmatter field doesn't affect signature
// =============================================================================
tap('H25 add non-canonical field → verify true (documented behaviour)', () => {
  const fmA = runStartedFrontmatter()
  const fmB = runStartedFrontmatter({ extra_metadata: 'this should be ignored' })
  const a = canonicalize(fmA, 'body')
  const b = canonicalize(fmB, 'body')
  // Both canonicalizations produce the same canonical bytes (extra field excluded).
  assert.equal(a.canonicalBytes.toString('hex'), b.canonicalBytes.toString('hex'))
  const sigA = signCanonical(a.canonicalBytes, KEY)
  assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), true)
})

// =============================================================================
// AC1 — projectProbeResultToFrontmatter pinned exact-equals
// =============================================================================
tap('AC1 projection rename mapping (capability → scheduled_tasks_capability, etc.)', () => {
  const probe = {
    capability: 'fallback',
    reason: 'no_mcp',
    degraded_mode_message: 'no scheduled-tasks',
    native_probe_performed: false,
    t2_fallback: true,
  }
  const projected = projectProbeResultToFrontmatter(probe)
  assert.deepEqual(projected, {
    state: 'run-started',
    scheduled_tasks_capability: 'fallback',
    probe_reason: 'no_mcp',
    degraded_mode_statement: 'no scheduled-tasks',
    native_probe_performed: false,
    t2_fallback: true,
  })
})

tap('I11 projection is pure — same input → same output', () => {
  const probe = {
    capability: 'native',
    reason: 'list_succeeded',
    degraded_mode_message: null,
    native_probe_performed: true,
    t2_fallback: false,
  }
  const a = projectProbeResultToFrontmatter(probe)
  const b = projectProbeResultToFrontmatter(probe)
  assert.deepEqual(a, b)
})

// =============================================================================
// Boundary: null degraded_mode_message → null degraded_mode_statement
// =============================================================================
tap('boundary: null degraded_mode_message projects to null degraded_mode_statement', () => {
  const probe = {
    capability: 'native',
    reason: 'list_succeeded',
    degraded_mode_message: null,
    native_probe_performed: true,
    t2_fallback: false,
  }
  const projected = projectProbeResultToFrontmatter(probe)
  assert.equal(projected.degraded_mode_statement, null)
  // Canonicalize still hashes deterministically.
  const fm = { ...projected, type: 'state-transition', run_id: 'r', parent_episode: null,
               expected_post_episode_id: null, summary: 's' }
  const r1 = canonicalize(fm, 'body')
  const r2 = canonicalize(fm, 'body')
  assert.equal(r1.canonicalBytes.toString('hex'), r2.canonicalBytes.toString('hex'))
})

// =============================================================================
// Boundary: zero-byte body → body_sha256 is sha256 of empty string
// =============================================================================
tap('boundary: zero-byte body produces sha256 of empty string', () => {
  const fm = runStartedFrontmatter()
  const r = canonicalize(fm, '')
  const expected = crypto.createHash('sha256').update('').digest('hex')
  assert.equal(r.payload.body_sha256, expected)
})

// =============================================================================
// subtypeKey resolution
// =============================================================================
tap('subtypeKey returns null for unknown frontmatter', () => {
  assert.equal(subtypeKey({ type: 'plan' }), null)
  assert.equal(subtypeKey({}), null)
  assert.equal(subtypeKey(null), null)
})

tap('subtypeKey returns state-transition:run-started for matching frontmatter', () => {
  assert.equal(subtypeKey({ type: 'state-transition', state: 'run-started' }), 'state-transition:run-started')
})

tap('subtypeKey returns evidence:bp1-codex-request-sent when tag present', () => {
  assert.equal(
    subtypeKey({ type: 'evidence', tags: ['something-else', 'bp1-codex-request-sent'] }),
    'evidence:bp1-codex-request-sent',
  )
})

// =============================================================================
// canonicalizeFrontmatterBytes (slice 2b — RFC frontmatter canonical form)
// =============================================================================

tap('canonicalizeFrontmatterBytes: simple LF input is byte-identical canonical', () => {
  const input = 'id: RFC-001\nstatus: accepted\nsummary: "test"'
  const r = canonicalizeFrontmatterBytes(input)
  assert.equal(r.canonical, input)
  assert.match(r.sha256, /^[0-9a-f]{64}$/)
})

tap('canonicalizeFrontmatterBytes: CRLF normalizes to LF (same sha as LF)', () => {
  const lf = 'id: RFC-001\nstatus: accepted'
  const crlf = 'id: RFC-001\r\nstatus: accepted'
  const rLf = canonicalizeFrontmatterBytes(lf)
  const rCrlf = canonicalizeFrontmatterBytes(crlf)
  assert.equal(rLf.sha256, rCrlf.sha256, 'CRLF and LF must canonicalize identically')
})

tap('canonicalizeFrontmatterBytes: lone CR also normalizes to LF', () => {
  const lf = 'id: a\nstatus: b'
  const cr = 'id: a\rstatus: b'
  assert.equal(
    canonicalizeFrontmatterBytes(lf).sha256,
    canonicalizeFrontmatterBytes(cr).sha256,
  )
})

tap('canonicalizeFrontmatterBytes: trailing whitespace per line is stripped', () => {
  const dirty = 'id: a   \nstatus: b\t\t'
  const clean = 'id: a\nstatus: b'
  assert.equal(
    canonicalizeFrontmatterBytes(dirty).sha256,
    canonicalizeFrontmatterBytes(clean).sha256,
  )
})

tap('canonicalizeFrontmatterBytes: trailing empty lines are stripped', () => {
  const trailing = 'id: a\nstatus: b\n\n\n'
  const clean = 'id: a\nstatus: b'
  assert.equal(
    canonicalizeFrontmatterBytes(trailing).sha256,
    canonicalizeFrontmatterBytes(clean).sha256,
  )
})

tap('canonicalizeFrontmatterBytes: Buffer input accepted', () => {
  const text = 'id: a\nstatus: b'
  const buf = Buffer.from(text, 'utf8')
  assert.equal(canonicalizeFrontmatterBytes(text).sha256, canonicalizeFrontmatterBytes(buf).sha256)
})

tap('canonicalizeFrontmatterBytes: throws on invalid input type', () => {
  assert.throws(() => canonicalizeFrontmatterBytes(123), /must be Buffer/)
  assert.throws(() => canonicalizeFrontmatterBytes(null), /must be Buffer/)
})

// =============================================================================
// Slice 2e C4 — new canonicalize types (state-transition:deadline-fired,
// failure:deadline-state-mismatch, evidence:bp1-state-lock-release/stale).
// =============================================================================
tap('C4 tamper deadline_type in state-transition:deadline-fired → verify false', () => {
  const baseFm = {
    type: 'state-transition',
    state: 'deadline-fired',
    run_id: 'bp1-run-test-deadline-aabbcc',
    parent_episode: 'parent-tick-ep',
    expected_post_episode_id: null,
    summary: 'A2 deadline fired',
    deadline_type: 'A2',
    fire_action: 'auto-approved',
  }
  const tamperedFm = { ...baseFm, deadline_type: 'A1' }
  const a = canonicalize(baseFm, 'body')
  const b = canonicalize(tamperedFm, 'body')
  const sigA = signCanonical(a.canonicalBytes, KEY)
  assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), false)
  // Sanity: original verifies and includes the new canonical fields.
  assert.equal(verifyCanonical(a.canonicalBytes, KEY, sigA), true)
  assert.equal(a.payload.deadline_type, 'A2')
  assert.equal(a.payload.fire_action, 'auto-approved')
})

tap('C4 tamper observed_state in failure:deadline-state-mismatch → verify false', () => {
  const baseFm = {
    type: 'failure',
    failure_kind: 'deadline-state-mismatch',
    run_id: 'bp1-run-test-mismatch-aabbcc',
    parent_episode: 'parent-tick-ep',
    expected_post_episode_id: null,
    summary: 'A2 fire state mismatch',
    observed_state: 'auto_approved',
    expected_state: 'awaiting_approval',
  }
  const tamperedFm = { ...baseFm, observed_state: 'awaiting_approval' }
  const a = canonicalize(baseFm, 'body')
  const b = canonicalize(tamperedFm, 'body')
  const sigA = signCanonical(a.canonicalBytes, KEY)
  assert.equal(verifyCanonical(b.canonicalBytes, KEY, sigA), false)
  assert.equal(verifyCanonical(a.canonicalBytes, KEY, sigA), true)
  assert.equal(a.payload.observed_state, 'auto_approved')
  assert.equal(a.payload.expected_state, 'awaiting_approval')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
