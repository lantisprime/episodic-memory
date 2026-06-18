#!/usr/bin/env node
// test-bp001-advisory.mjs — RFC-008 P3d (F7).
//
// Covers scripts/lib/bp001-advisory.mjs — the bp-001 SessionStart advisory
// predicate extracted VERBATIM from em-recall.mjs:405-423 so the substrate
// carries zero enforcement awareness (R1/F38). Pins shouldArmBp001Checkpoint's
// scoping/cutoff/fail-closed behavior and the advisory message constant.
//
// Dates are computed RELATIVE to a runtime `now` (passed into the predicate) so
// the fixture never rots into a CI time bomb (lesson 20260610-000157-…f9b5).

import { shouldArmBp001Checkpoint, computeBp001Advisory, BP1_ADVISORY_MESSAGE } from '../scripts/lib/bp001-advisory.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function eq(name, actual, expected) {
  if (actual === expected) ok(name)
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const NOW = new Date()
function dateStr(daysAgo) {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

const PROJECT = 'episodic-memory'
const TAG = 'violated:bp-001-implementation-workflow'

function violation(overrides = {}) {
  return {
    id: 'x',
    status: 'active',
    category: 'violation',
    project: PROJECT,
    tags: [TAG],
    date: dateStr(10),
    ...overrides,
  }
}

console.log('shouldArmBp001Checkpoint — scoping + cutoff + fail-closed')

// Positive: a recent, same-project, active bp-001 violation arms.
eq('recent same-project violation → true',
  shouldArmBp001Checkpoint([violation()], NOW, PROJECT), true)

// Fail-closed: no resolved project name.
eq('no currentProject → false (fail-closed)',
  shouldArmBp001Checkpoint([violation()], NOW, null), false)
eq('empty currentProject → false',
  shouldArmBp001Checkpoint([violation()], NOW, ''), false)

// Project scoping: a violation in a different project must NOT arm (cross-project bleed guard).
eq('different project → false',
  shouldArmBp001Checkpoint([violation({ project: 'other-proj' })], NOW, PROJECT), false)

// Cutoff: a violation older than 30 days must NOT arm.
eq('violation 40d old → false (outside 30d cutoff)',
  shouldArmBp001Checkpoint([violation({ date: dateStr(40) })], NOW, PROJECT), false)
eq('violation 10d old → true (inside cutoff)',
  shouldArmBp001Checkpoint([violation({ date: dateStr(10) })], NOW, PROJECT), true)

// Status: superseded violations must NOT arm.
eq('superseded violation → false',
  shouldArmBp001Checkpoint([violation({ status: 'superseded' })], NOW, PROJECT), false)

// Category: a non-violation episode must NOT arm.
eq('non-violation category → false',
  shouldArmBp001Checkpoint([violation({ category: 'decision' })], NOW, PROJECT), false)

// Tag: missing/other tag must NOT arm.
eq('wrong tag → false',
  shouldArmBp001Checkpoint([violation({ tags: ['violated:bp-006-push-after-verify'] })], NOW, PROJECT), false)
eq('missing tags array → false',
  shouldArmBp001Checkpoint([violation({ tags: undefined })], NOW, PROJECT), false)

// Robustness: null/garbage entries are skipped, not thrown on.
eq('null/garbage entries skipped → false',
  shouldArmBp001Checkpoint([null, undefined, 42, {}], NOW, PROJECT), false)
eq('empty list → false',
  shouldArmBp001Checkpoint([], NOW, PROJECT), false)

console.log('\nadvisory message constant')
eq('message carries the __BP1_ADVISORY__ sentinel prefix',
  BP1_ADVISORY_MESSAGE.startsWith('__BP1_ADVISORY__ '), true)
eq('message names bp-001-implementation-workflow',
  BP1_ADVISORY_MESSAGE.includes('bp-001-implementation-workflow'), true)
eq('message has no trailing newline (caller owns framing)',
  BP1_ADVISORY_MESSAGE.endsWith('\n'), false)

console.log('\ncomputeBp001Advisory — best-effort (never throws)')
// With no readable index in a bogus cwd-independent call, it must degrade to null,
// not throw. (The real-index path is covered by test-enforce-contract --session-start + E2E.)
let threw = false
let res
try { res = computeBp001Advisory('/nonexistent-project-root-xyz', NOW) } catch { threw = true }
eq('bogus root does not throw', threw, false)
eq('bogus root → null (no advisory)', res, null)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
