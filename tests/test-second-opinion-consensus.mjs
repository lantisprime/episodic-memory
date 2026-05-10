#!/usr/bin/env node
/**
 * test-second-opinion-consensus.mjs — Tests for consensus.mjs verdict parsing
 * + stop-condition logic.
 *
 * Coverage:
 *   - parseVerdict: valid, missing fence, malformed JSON, missing final_verdict.
 *   - applyStopCondition for every row in v3 §Consensus-loop v3 stop conditions
 *     table:
 *     * ACCEPT → success
 *     * REJECT → fail
 *     * ACCEPT-with-FU clean (all ACCEPT-OK or DEFERRED-AS-FU, no P1) → success
 *     * I-21: ACCEPT-with-FU with P1 → accept-with-fu-malformed
 *     * I-21: ACCEPT-with-FU with NEEDS-MORE-WORK → accept-with-fu-malformed
 *     * I-21: ACCEPT-with-FU with NEW-CONCERN → accept-with-fu-malformed
 *     * HOLD + rebuttal-cb → loop
 *     * I-16: HOLD + rebuttal-cb at max-rounds → cap-reached-no-success
 *     * HOLD + no rebuttal-cb → human-review-required
 *     * I-17 / spec-cycle-stop without --force → fail
 *     * spec-cycle-stop with --force AND all valid → forced accept
 *     * spec-cycle-stop with --force AND P2 residue → fail
 *
 * Critical: lesson `...0158` enshrined — NEVER auto-convert P1/P2 or
 * NEEDS-MORE-WORK to success.
 */

import path from 'node:path'
import assert from 'node:assert'

import { parseVerdict, applyStopCondition, summarizeFindings } from
  '../scripts/second-opinion/lib/consensus.mjs'

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

console.log('# test-second-opinion-consensus')

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------
console.log('\n## parseVerdict')

const validReply = `# A reply

Some content.

\`\`\`json:second-opinion-summary
{
  "final_verdict": "ACCEPT",
  "findings": [],
  "spec_cycle_signal": null
}
\`\`\`
`

test('valid reply parses to expected object', () => {
  const v = parseVerdict(validReply)
  assert.strictEqual(v.final_verdict, 'ACCEPT')
  assert.deepStrictEqual(v.findings, [])
  assert.strictEqual(v.spec_cycle_signal, null)
})

test('empty reply → verdict-parse-failed (empty body)', () => {
  assert.throws(() => parseVerdict(''),
    (e) => e.code === 'verdict-parse-failed' && e.detail === 'empty body')
})

test('reply without fence → verdict-parse-failed (no fence)', () => {
  assert.throws(() => parseVerdict('just some text, no fence'),
    (e) => e.code === 'verdict-parse-failed' && e.detail === 'no fence')
})

test('reply with malformed JSON in fence → verdict-parse-failed', () => {
  const bad = '```json:second-opinion-summary\n{not json\n```'
  assert.throws(() => parseVerdict(bad),
    (e) => e.code === 'verdict-parse-failed')
})

test('reply with valid JSON but missing final_verdict → verdict-parse-failed', () => {
  const bad = '```json:second-opinion-summary\n{"findings": []}\n```'
  assert.throws(() => parseVerdict(bad),
    (e) => e.code === 'verdict-parse-failed' && e.detail === 'no final_verdict')
})

// ---------------------------------------------------------------------------
// applyStopCondition: ACCEPT
// ---------------------------------------------------------------------------
console.log('\n## ACCEPT verdict')
test('ACCEPT → success exit 0', () => {
  const r = applyStopCondition({
    verdict: { final_verdict: 'ACCEPT', findings: [], spec_cycle_signal: null },
    round: 1, maxRounds: 5, hasRebuttalCb: false, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, true)
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.stopReason, 'verdict-accept')
})

// ---------------------------------------------------------------------------
// REJECT
// ---------------------------------------------------------------------------
console.log('\n## REJECT verdict')
test('REJECT → fail exit 1', () => {
  const r = applyStopCondition({
    verdict: { final_verdict: 'REJECT', findings: [] },
    round: 1, maxRounds: 5, hasRebuttalCb: false, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.exitCode, 1)
  assert.strictEqual(r.stopReason, 'verdict-reject')
})

// ---------------------------------------------------------------------------
// ACCEPT-with-FU clean
// ---------------------------------------------------------------------------
console.log('\n## ACCEPT-with-FU clean')
test('ACCEPT-with-FU + all DEFERRED-AS-FU + no P1 → success with FU appendix', () => {
  const r = applyStopCondition({
    verdict: {
      final_verdict: 'ACCEPT-with-FU',
      findings: [
        { id: 'F1', severity: 'P3', status: 'DEFERRED-AS-FU' },
        { id: 'F2', severity: 'P2', status: 'ACCEPT-OK' },
      ],
    },
    round: 1, maxRounds: 5, hasRebuttalCb: true, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, true)
  assert.strictEqual(r.exitCode, 0)
  assert.strictEqual(r.stopReason, 'verdict-accept-with-fu')
  assert.strictEqual(r.fuAppendix.length, 1)
  assert.strictEqual(r.fuAppendix[0].id, 'F1')
})

// ---------------------------------------------------------------------------
// I-21: ACCEPT-with-FU malformed
// ---------------------------------------------------------------------------
console.log('\n## I-21 ACCEPT-with-FU malformed (critical guard)')
test('I-21: ACCEPT-with-FU + P1 finding → accept-with-fu-malformed (NEVER auto-success)', () => {
  const r = applyStopCondition({
    verdict: {
      final_verdict: 'ACCEPT-with-FU',
      findings: [
        { id: 'F1', severity: 'P1', status: 'ACCEPT-OK' },
      ],
    },
    round: 1, maxRounds: 5, hasRebuttalCb: false, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.exitCode, 1)
  assert.strictEqual(r.stopReason, 'accept-with-fu-malformed')
})

test('I-21: ACCEPT-with-FU + NEEDS-MORE-WORK → accept-with-fu-malformed', () => {
  const r = applyStopCondition({
    verdict: {
      final_verdict: 'ACCEPT-with-FU',
      findings: [
        { id: 'F1', severity: 'P3', status: 'NEEDS-MORE-WORK' },
      ],
    },
    round: 1, maxRounds: 5, hasRebuttalCb: false, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.stopReason, 'accept-with-fu-malformed')
})

test('I-21: ACCEPT-with-FU + NEW-CONCERN → accept-with-fu-malformed', () => {
  const r = applyStopCondition({
    verdict: {
      final_verdict: 'ACCEPT-with-FU',
      findings: [
        { id: 'F1', severity: 'P3', status: 'NEW-CONCERN' },
      ],
    },
    round: 1, maxRounds: 5, hasRebuttalCb: false, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.stopReason, 'accept-with-fu-malformed')
})

// ---------------------------------------------------------------------------
// HOLD with rebuttal cb
// ---------------------------------------------------------------------------
console.log('\n## HOLD + --rebuttal-cb')
test('HOLD + rebuttal-cb + below cap → loop', () => {
  const r = applyStopCondition({
    verdict: { final_verdict: 'HOLD', findings: [{ id: 'F1', severity: 'P2', status: 'NEEDS-MORE-WORK' }] },
    round: 2, maxRounds: 5, hasRebuttalCb: true, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.stop, false)
  assert.strictEqual(r.nextAction, 'loop')
})

// ---------------------------------------------------------------------------
// I-16: --max-rounds cap
// ---------------------------------------------------------------------------
console.log('\n## I-16 --max-rounds cap')
test('I-16: HOLD at max-rounds → cap-reached-no-success (NEVER auto-success)', () => {
  const r = applyStopCondition({
    verdict: { final_verdict: 'HOLD', findings: [{ id: 'F1', severity: 'P2', status: 'NEEDS-MORE-WORK' }] },
    round: 5, maxRounds: 5, hasRebuttalCb: true, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.exitCode, 1)
  assert.strictEqual(r.stopReason, 'cap-reached-no-success')
})

// ---------------------------------------------------------------------------
// HOLD + no rebuttal-cb
// ---------------------------------------------------------------------------
console.log('\n## HOLD + no --rebuttal-cb')
test('HOLD + no rebuttal-cb → human-review-required', () => {
  const r = applyStopCondition({
    verdict: { final_verdict: 'HOLD', findings: [] },
    round: 1, maxRounds: 5, hasRebuttalCb: false, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.stop, true)
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.exitCode, 0, 'human review = exit 0 with flag, not error')
  assert.strictEqual(r.stopReason, 'human-review-required')
})

// ---------------------------------------------------------------------------
// I-17: spec-cycle-stop
// ---------------------------------------------------------------------------
console.log('\n## I-17 spec-cycle-stop trigger')
test('I-17: spec_cycle_signal trigger-met without --force → fail (NEVER auto-success)', () => {
  const r = applyStopCondition({
    verdict: {
      final_verdict: 'HOLD',
      findings: [{ id: 'F1', severity: 'P3', status: 'NEEDS-MORE-WORK' }],
      spec_cycle_signal: 'trigger-met',
    },
    round: 5, maxRounds: 10, hasRebuttalCb: true, forceSpecCycleAccept: false,
  })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.stopReason, 'spec-cycle-stop')
})

test('spec-cycle-stop + --force + all clean → forced accept', () => {
  const r = applyStopCondition({
    verdict: {
      final_verdict: 'HOLD',
      findings: [
        { id: 'F1', severity: 'P3', status: 'DEFERRED-AS-FU' },
        { id: 'F2', severity: 'P3', status: 'ACCEPT-OK' },
      ],
      spec_cycle_signal: 'trigger-met',
    },
    round: 5, maxRounds: 10, hasRebuttalCb: true, forceSpecCycleAccept: true,
  })
  assert.strictEqual(r.success, true)
  assert.strictEqual(r.stopReason, 'spec-cycle-stop-forced-accept')
  assert.strictEqual(r.fuAppendix.length, 1)
})

test('spec-cycle-stop + --force BUT P2 residue → fail (critical guard)', () => {
  const r = applyStopCondition({
    verdict: {
      final_verdict: 'HOLD',
      findings: [
        { id: 'F1', severity: 'P2', status: 'NEEDS-MORE-WORK' },
      ],
      spec_cycle_signal: 'trigger-met',
    },
    round: 5, maxRounds: 10, hasRebuttalCb: true, forceSpecCycleAccept: true,
  })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.stopReason, 'spec-cycle-stop')
})

// ---------------------------------------------------------------------------
// summarizeFindings
// ---------------------------------------------------------------------------
console.log('\n## summarizeFindings')
test('summarizeFindings counts severity + status', () => {
  const findings = [
    { id: 'F1', severity: 'P1', status: 'ACCEPT-OK' },
    { id: 'F2', severity: 'P2', status: 'NEEDS-MORE-WORK' },
    { id: 'F3', severity: 'P2', status: 'NEEDS-MORE-WORK' },
    { id: 'F4', severity: 'P3', status: 'DEFERRED-AS-FU' },
  ]
  const s = summarizeFindings(findings)
  assert.deepStrictEqual(s.severity, { P1: 1, P2: 2, P3: 1 })
  assert.deepStrictEqual(s.status, {
    'ACCEPT-OK': 1, 'NEEDS-MORE-WORK': 2, 'NEW-CONCERN': 0, 'DEFERRED-AS-FU': 1,
  })
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
