#!/usr/bin/env node
/**
 * test-bp1-deadlines-lib.mjs — Pure deadline-math helpers
 * (scripts/lib/bp1-deadlines.mjs, RFC-004 slice 2e).
 *
 * Coverage:
 *   DL1  A1 fires exactly at the 30:00 boundary (now == deadline)
 *   DL2  A1 fires past the 30:00 boundary (now > deadline)
 *   DL3  A1 does NOT fire before the 30:00 boundary (now < deadline)
 *   DL4  A1 reports `no-request-sent` when request_sent !== true
 *   DL5  A1 reports `invalid-requested-at` on a non-parseable timestamp
 *   DL6  A2 fires when state=awaiting_approval AND now >= deadline_at
 *   DL7  A2 does NOT fire when state=awaiting_approval AND now < deadline_at
 *   DL8  A2 reports `not-awaiting-approval` for any other state
 *   DL9  evaluateDeadlines processes mixed states; runs in other states are skipped
 *   DL10 pickFiredDeadlines returns only fires=true rows
 *   DL11 Hour-rollover: A1 deadline crossing midnight UTC computes correctly
 *   DL12 `now` argument accepts both epoch-ms and ISO-8601 strings
 */

import assert from 'node:assert/strict'

const dl = await import(
  new URL('../scripts/lib/bp1-deadlines.mjs', import.meta.url).href
)
const {
  A1_TIMEOUT_MS,
  computeA1FromCodexReviewEntry,
  computeA2Deadline,
  evaluateDeadlines,
  pickFiredDeadlines,
} = dl

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

const REQUESTED_AT = '2026-05-17T18:00:00.000Z'
const REQUESTED_AT_MS = Date.parse(REQUESTED_AT)
const A1_DEADLINE_MS = REQUESTED_AT_MS + A1_TIMEOUT_MS
const A1_DEADLINE_ISO = new Date(A1_DEADLINE_MS).toISOString()

// ============================================================================
// DL1 — A1 fires exactly at the 30:00 boundary
// ============================================================================
tap('DL1 A1 fires at boundary (now == requested_at + 30min)', () => {
  const r = computeA1FromCodexReviewEntry(
    { requested_at: REQUESTED_AT, request_sent: true },
    A1_DEADLINE_MS,
  )
  assert.equal(r.fires, true)
  assert.equal(r.reason, 'fires')
  assert.equal(r.deadline_at, A1_DEADLINE_ISO)
})

// ============================================================================
// DL2 — A1 fires past the boundary
// ============================================================================
tap('DL2 A1 fires past boundary (now == deadline + 1s)', () => {
  const r = computeA1FromCodexReviewEntry(
    { requested_at: REQUESTED_AT, request_sent: true },
    A1_DEADLINE_MS + 1_000,
  )
  assert.equal(r.fires, true)
  assert.equal(r.reason, 'fires')
})

// ============================================================================
// DL3 — A1 does NOT fire before the boundary
// ============================================================================
tap('DL3 A1 does not fire before boundary (now == deadline - 1s)', () => {
  const r = computeA1FromCodexReviewEntry(
    { requested_at: REQUESTED_AT, request_sent: true },
    A1_DEADLINE_MS - 1_000,
  )
  assert.equal(r.fires, false)
  assert.equal(r.reason, 'timer-active')
  assert.equal(r.deadline_at, A1_DEADLINE_ISO,
    'deadline_at is still reported when timer is active')
})

// ============================================================================
// DL4 — A1: request_sent !== true → no-request-sent (Path B territory)
// ============================================================================
tap('DL4 A1 reports no-request-sent when request_sent=false', () => {
  const r = computeA1FromCodexReviewEntry(
    { requested_at: REQUESTED_AT, request_sent: false },
    A1_DEADLINE_MS + 60_000,
  )
  assert.equal(r.fires, false)
  assert.equal(r.reason, 'no-request-sent')
  assert.equal(r.deadline_at, null,
    'deadline_at is null when no-request-sent (Path A has no timer to compute)')
})

// ============================================================================
// DL5 — A1: non-parseable requested_at → invalid-requested-at
// ============================================================================
tap('DL5 A1 reports invalid-requested-at on non-parseable timestamp', () => {
  const r = computeA1FromCodexReviewEntry(
    { requested_at: 'not-a-date', request_sent: true },
    Date.now(),
  )
  assert.equal(r.fires, false)
  assert.equal(r.reason, 'invalid-requested-at')
})

// ============================================================================
// DL6 — A2 fires when now >= deadline_at
// ============================================================================
tap('DL6 A2 fires when state=awaiting_approval and now >= deadline_at', () => {
  const run = {
    state: 'awaiting_approval',
    deadline_at: '2026-05-17T19:00:00.000Z',
  }
  const r = computeA2Deadline(run, '2026-05-17T19:00:00.000Z')
  assert.equal(r.fires, true)
  assert.equal(r.reason, 'fires')
  assert.equal(r.deadline_at, run.deadline_at)
})

// ============================================================================
// DL7 — A2 does NOT fire when now < deadline_at
// ============================================================================
tap('DL7 A2 does not fire when now < deadline_at', () => {
  const run = {
    state: 'awaiting_approval',
    deadline_at: '2026-05-17T19:00:00.000Z',
  }
  const r = computeA2Deadline(run, '2026-05-17T18:59:59.000Z')
  assert.equal(r.fires, false)
  assert.equal(r.reason, 'timer-active')
})

// ============================================================================
// DL8 — A2: not-awaiting-approval for other states
// ============================================================================
tap('DL8 A2 reports not-awaiting-approval for non-matching states', () => {
  const r = computeA2Deadline(
    { state: 'codex_review', deadline_at: '2026-05-17T19:00:00.000Z' },
    Date.now(),
  )
  assert.equal(r.fires, false)
  assert.equal(r.reason, 'not-awaiting-approval')
})

// ============================================================================
// DL9 — evaluateDeadlines mixed states; runs in other states are skipped
// ============================================================================
tap('DL9 evaluateDeadlines processes mixed states; skips others', () => {
  // now = REQUESTED_AT + 30min + 1s = 2026-05-17T18:30:01Z. run-a's A2
  // deadline is set just before now so it fires; run-d's A2 deadline is set
  // far in the future so it does not.
  const runs = {
    'run-a': { state: 'awaiting_approval', deadline_at: '2026-05-17T18:30:00.000Z' },
    'run-b': { state: 'codex_review' },
    'run-c': { state: 'planning' },   // skipped — not a deadline-bearing state
    'run-d': { state: 'awaiting_approval', deadline_at: '2099-01-01T00:00:00.000Z' },
  }
  const entryMap = {
    'run-b': { requested_at: REQUESTED_AT, request_sent: true },
  }
  const now = A1_DEADLINE_MS + 1_000 // past A1 deadline AND past run-a's A2 deadline
  const evaluated = evaluateDeadlines(runs, entryMap, now)
  // run-c (planning) absent.
  assert.equal(evaluated.length, 3,
    `expected 3 evaluated rows; got ${evaluated.length}: ${JSON.stringify(evaluated)}`)
  const byId = Object.fromEntries(evaluated.map(e => [e.run_id, e]))
  assert.equal(byId['run-a'].type, 'A2')
  assert.equal(byId['run-a'].fires, true)
  assert.equal(byId['run-b'].type, 'A1')
  assert.equal(byId['run-b'].fires, true)
  assert.equal(byId['run-d'].type, 'A2')
  assert.equal(byId['run-d'].fires, false)
  assert.ok(!('run-c' in byId), 'run-c (planning) must be skipped, not present')
})

// ============================================================================
// DL10 — pickFiredDeadlines filter
// ============================================================================
tap('DL10 pickFiredDeadlines returns only fires=true rows', () => {
  const evaluated = [
    { run_id: 'a', type: 'A2', fires: true, deadline_at: 'x', reason: 'fires' },
    { run_id: 'b', type: 'A1', fires: false, deadline_at: 'y', reason: 'timer-active' },
    { run_id: 'c', type: 'A1', fires: true, deadline_at: 'z', reason: 'fires' },
  ]
  const fired = pickFiredDeadlines(evaluated)
  assert.equal(fired.length, 2)
  assert.deepEqual(fired.map(f => f.run_id).sort(), ['a', 'c'])
})

// ============================================================================
// DL11 — Hour-rollover: A1 deadline crossing midnight UTC
// ============================================================================
tap('DL11 A1 deadline crossing midnight UTC is computed correctly', () => {
  const requested = '2026-05-17T23:45:00.000Z'   // 30min before midnight UTC
  const r = computeA1FromCodexReviewEntry(
    { requested_at: requested, request_sent: true },
    '2026-05-18T00:14:59.000Z',  // 59s short of deadline
  )
  assert.equal(r.fires, false)
  assert.equal(r.deadline_at, '2026-05-18T00:15:00.000Z')
  const r2 = computeA1FromCodexReviewEntry(
    { requested_at: requested, request_sent: true },
    '2026-05-18T00:15:00.000Z',  // boundary
  )
  assert.equal(r2.fires, true)
})

// ============================================================================
// DL12 — `now` accepts both epoch-ms and ISO strings
// ============================================================================
tap('DL12 now argument accepts both epoch-ms and ISO-8601 strings', () => {
  const entry = { requested_at: REQUESTED_AT, request_sent: true }
  const r1 = computeA1FromCodexReviewEntry(entry, A1_DEADLINE_ISO)
  const r2 = computeA1FromCodexReviewEntry(entry, A1_DEADLINE_MS)
  assert.equal(r1.fires, true)
  assert.equal(r2.fires, true)
  assert.equal(r1.deadline_at, r2.deadline_at)
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
