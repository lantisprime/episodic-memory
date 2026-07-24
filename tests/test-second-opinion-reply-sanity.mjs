#!/usr/bin/env node
/**
 * test-second-opinion-reply-sanity.mjs — unit suite for the #538 reply-sanity
 * predicate.
 *
 * Coverage: REQ-1 (empty), REQ-2 (bootstrap string), REQ-3 (fence beats
 * length), REQ-4 (long unfenced accepted), REQ-5 (non-string), REQ-6 (floor
 * override), plus the rejection-detail contract.
 *
 * Negative control (§A.9 red-then-green): run with --break-sanity to swap in
 * an always-ok predicate. Every rejection assertion MUST then fail, so the
 * suite exits non-zero. A guard never observed failing guards nothing.
 */

import assert from 'node:assert'
import { checkReplySanity, DEFAULT_MIN_REPLY_CHARS } from '../scripts/second-opinion/lib/reply-sanity.mjs'
import { parseVerdict } from '../scripts/second-opinion/lib/consensus.mjs'

const BREAK = process.argv.includes('--break-sanity')
const check = BREAK ? () => ({ ok: true }) : checkReplySanity

// The verbatim body issue #538 observed persisted as a review reply.
const BOOTSTRAP = 'Load session_handoff.md from 2026-07-14 16:32? (y/n)'

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

console.log('# test-second-opinion-reply-sanity')

test('testEmptyRejected: empty and whitespace-only bodies are rejected', () => {
  for (const body of ['', '   ', '\n\t ']) {
    const r = check(body)
    assert.strictEqual(r.ok, false, `expected rejection for ${JSON.stringify(body)}`)
    assert.strictEqual(r.reason, 'reply-empty', `expected reply-empty, got ${r.reason}`)
  }
})

test('testNonStringRejected: non-string bodies are rejected without throwing', () => {
  for (const body of [null, undefined, 42, {}]) {
    const r = check(body)
    assert.strictEqual(r.ok, false, `expected rejection for ${String(body)}`)
    assert.strictEqual(r.reason, 'reply-not-string', `expected reply-not-string, got ${r.reason}`)
  }
})

test('testBootstrapRejected: the #538 SessionStart bootstrap body is rejected', () => {
  const r = check(BOOTSTRAP)
  assert.strictEqual(r.ok, false, 'bootstrap prompt must not be persistable')
  assert.strictEqual(r.reason, 'reply-too-short-no-summary',
    `expected reply-too-short-no-summary, got ${r.reason}`)
})

test('testShortWithFenceAccepted: a short body carrying the fence is accepted', () => {
  const body = 'ok\n```json:second-opinion-summary\n{"final_verdict":"ACCEPT"}\n```'
  assert.ok(body.length < DEFAULT_MIN_REPLY_CHARS,
    `fixture must be below the floor to discriminate, got ${body.length}`)
  const r = check(body)
  assert.strictEqual(r.ok, true, `fence must short-circuit the floor, got ${JSON.stringify(r)}`)
})

test('testLongNoFenceAccepted: a long fence-less body is accepted', () => {
  const body = 'x'.repeat(DEFAULT_MIN_REPLY_CHARS + 100)
  const r = check(body)
  assert.strictEqual(r.ok, true, `long prose must not be rejected, got ${JSON.stringify(r)}`)
})

test('testFloorOverridden: minChars controls the length arm', () => {
  assert.strictEqual(check(BOOTSTRAP, { minChars: 0 }).ok, true,
    'minChars 0 disables the length arm')
  const r = check('x', { minChars: 5000 })
  assert.strictEqual(r.ok, false, 'a raised floor rejects a short body')
  assert.strictEqual(r.reason, 'reply-too-short-no-summary')
})

test('testDetailMentionsFloor: rejection detail carries observed and expected values', () => {
  const r = check(BOOTSTRAP)
  assert.strictEqual(r.ok, false)
  assert.ok(r.detail.includes(String(BOOTSTRAP.length)),
    `detail must carry the observed length ${BOOTSTRAP.length}, got: ${r.detail}`)
  assert.ok(r.detail.includes(String(DEFAULT_MIN_REPLY_CHARS)),
    `detail must carry the floor ${DEFAULT_MIN_REPLY_CHARS}, got: ${r.detail}`)
})

// EC10: the fence regex is duplicated from consensus.mjs to keep the predicate
// dependency-free. Nothing else stops the two copies drifting, so assert the
// invariant that matters: a body the gate calls fenced must still parse as a
// verdict. Uses the real predicate, never the --break-sanity substitute.
test('testFenceRegexInSyncWithConsensus: a gate-accepted fenced body still parses', () => {
  const body = '```json:second-opinion-summary\n{"final_verdict":"ACCEPT"}\n```'
  assert.strictEqual(checkReplySanity(body).ok, true,
    'gate must accept a canonical fenced body')
  assert.strictEqual(parseVerdict(body).final_verdict, 'ACCEPT',
    'consensus.mjs must parse the same body the gate accepted (FENCE_RE drift)')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
