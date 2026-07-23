#!/usr/bin/env node
// ---------------------------------------------------------------------------
// test-contradiction.mjs — #537 contradiction / near-duplicate advisory.
//
// Two layers:
//   Group 1  pure comparator table over scripts/lib/contradiction.mjs
//   Group 2  em-store runtime probes   — REAL script, isolated fixture store
//   Group 3  em-doctor runtime probes  — REAL script, isolated fixture store
//
// Every runtime assertion inspects OBSERVED output (captured stdout, stderr, or
// exit code) of the real script, never a constant.
//
// Usage:  node tests/test-contradiction.mjs
// Guard negative control (must exit non-zero):
//         node tests/test-contradiction.mjs --break-detector
// ---------------------------------------------------------------------------

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  summaryJaccard, summaryTokenSet, MAX_GROUP,
  findContradictionsFor, findContradictionCandidates
} from '../scripts/lib/contradiction.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.join(HERE, '..', 'scripts')
const EM_STORE = path.join(SCRIPTS, 'em-store.mjs')
const EM_REVISE = path.join(SCRIPTS, 'em-revise.mjs')
const EM_DOCTOR = path.join(SCRIPTS, 'em-doctor.mjs')

// Negative control: an unreachable threshold makes every Group-1 positive
// assertion go RED. A guard never observed failing guards nothing.
const BREAK = process.argv.includes('--break-detector')
const OPTS = BREAK ? { threshold: 1.1 } : {}

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`ok   ${name}`) }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

function row(over) {
  return { id: 'x', project: 'p', category: 'decision', status: 'active', supersedes: null, summary: 's', ...over }
}

// --- fixture helpers --------------------------------------------------------
function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contradiction-')))
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contradiction-home-')))
  return { cwd, home, env: { ...process.env, HOME: home } }
}
function cleanup(fx) {
  fs.rmSync(fx.cwd, { recursive: true, force: true })
  fs.rmSync(fx.home, { recursive: true, force: true })
}
function run(script, args, fx) {
  const r = spawnSync('node', [script, ...args], { cwd: fx.cwd, encoding: 'utf8', env: fx.env })
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}
function store(fx, summary, body, category) {
  return run(EM_STORE, ['--project', 'fx', '--category', category || 'decision',
    '--summary', summary, '--body', body, '--scope', 'local'], fx)
}

// ===========================================================================
// Group 1 — pure comparator
// ===========================================================================

function testIdenticalSummariesMatch() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testIdenticalSummariesMatch', out.pairs.length === 1 && out.pairs[0].similarity === 1,
    `pairs=${out.pairs.length} sim=${out.pairs[0] && out.pairs[0].similarity}`)
}

function testJsonVsYamlMatches() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Config files use YAML format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testJsonVsYamlMatches',
    out.pairs.length === 1 && out.pairs[0].similarity === 0.667 && out.pairs[0].a === 'a' && out.pairs[0].b === 'b',
    `pairs=${out.pairs.length} sim=${out.pairs[0] && out.pairs[0].similarity}`)
}

function testUnrelatedSummariesDoNotMatch() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Retry the upload queue with exponential backoff' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testUnrelatedSummariesDoNotMatch', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testCrossProjectIgnored() {
  const rows = [
    row({ id: 'a', project: 'one', summary: 'Config files use JSON format' }),
    row({ id: 'b', project: 'two', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testCrossProjectIgnored', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testNonDecisionCategoryIgnored() {
  const rows = [
    row({ id: 'a', category: 'lesson', summary: 'Config files use JSON format' }),
    row({ id: 'b', category: 'lesson', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testNonDecisionCategoryIgnored', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testSupersededStatusIgnored() {
  const rows = [
    row({ id: 'a', status: 'superseded', summary: 'Config files use JSON format' }),
    row({ id: 'b', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testSupersededStatusIgnored', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testSupersedesChainLinkedPairExcluded() {
  const rows = [
    row({ id: 'a', summary: 'Config files use JSON format' }),
    row({ id: 'mid', supersedes: 'a', summary: 'Totally unrelated middle link' }),
    row({ id: 'b', supersedes: 'mid', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  check('testSupersedesChainLinkedPairExcluded', out.pairs.length === 0, `pairs=${out.pairs.length}`)
}

function testChainCycleTerminates() {
  // A genuine CYCLE: a → b → a. Without the `seen` guard in chainLinked the
  // walk never terminates, so this test hangs rather than fails. It also
  // asserts the cyclic pair IS excluded (they are chain-linked).
  const rows = [
    row({ id: 'a', supersedes: 'b', summary: 'Config files use JSON format' }),
    row({ id: 'b', supersedes: 'a', summary: 'Config files use JSON format' })
  ]
  const out = findContradictionCandidates(rows, OPTS)
  // A self-referencing row must also terminate, and must NOT be excluded from
  // comparison against an unrelated third row.
  const selfRef = [
    row({ id: 's', supersedes: 's', summary: 'Config files use JSON format' }),
    row({ id: 't', summary: 'Config files use JSON format' })
  ]
  const out2 = findContradictionCandidates(selfRef, OPTS)
  check('testChainCycleTerminates',
    out.pairs.length === 0 && out2.pairs.length === 1 && out2.pairs[0].a === 's' && out2.pairs[0].b === 't',
    `cyclePairs=${out.pairs.length} selfRefPairs=${JSON.stringify(out2.pairs)}`)
}

function testEmptySummaryNeverMatches() {
  const rows = [row({ id: 'a', summary: '' }), row({ id: 'b', summary: '   ' })]
  const out = findContradictionCandidates(rows, OPTS)
  const j = summaryJaccard(summaryTokenSet(''), summaryTokenSet(''))
  check('testEmptySummaryNeverMatches', out.pairs.length === 0 && j === 0,
    `pairs=${out.pairs.length} jaccard=${j}`)
}

function testLargeGroupSkippedNotTruncated() {
  const rows = []
  for (let i = 0; i < 6; i++) rows.push(row({ id: `id${i}`, summary: 'Config files use JSON format' }))
  const out = findContradictionCandidates(rows, { ...OPTS, maxGroup: 5 })
  check('testLargeGroupSkippedNotTruncated',
    out.pairs.length === 0 && out.skipped.length === 1 && out.skipped[0].project === 'p' && out.skipped[0].active_decisions === 6,
    `pairs=${out.pairs.length} skipped=${JSON.stringify(out.skipped)}`)
}

function testDefaultMaxGroupIsPinned() {
  // F6: the skip mechanism is proven with an override elsewhere; this pins the
  // shipped DEFAULT. A regression setting MAX_GROUP to Infinity or 0 fails here.
  const rows = []
  for (let i = 0; i < MAX_GROUP + 1; i++) {
    rows.push(row({ id: `big${i}`, summary: 'Config files use JSON format' }))
  }
  const out = findContradictionCandidates(rows, OPTS)
  check('testDefaultMaxGroupIsPinned',
    MAX_GROUP === 2000 && out.pairs.length === 0 &&
    out.skipped.length === 1 && out.skipped[0].active_decisions === MAX_GROUP + 1,
    `MAX_GROUP=${MAX_GROUP} pairs=${out.pairs.length} skipped=${JSON.stringify(out.skipped)}`)
}

function testFindForSelfExcluded() {
  const me = row({ id: 'a', summary: 'Config files use JSON format' })
  const rows = [me, row({ id: 'b', summary: 'Config files use YAML format' })]
  const out = findContradictionsFor(me, rows, OPTS)
  check('testFindForSelfExcluded',
    out.length === 1 && out[0].id === 'b' && findContradictionsFor(me, [], OPTS).length === 0,
    `out=${JSON.stringify(out)}`)
}

// ===========================================================================
// Group 2 — em-store runtime probes (real script, isolated fixture store)
// ===========================================================================

function testStoreEmitsAdvisoryOnContradiction(fx) {
  const first = store(fx, 'Config files use JSON format', 'We standardise on JSON.')
  const second = store(fx, 'Config files use YAML format', 'We standardise on YAML.')
  const firstId = first.json && first.json.id
  check('testStoreEmitsAdvisoryOnContradiction',
    !!firstId && second.stderr.includes(`similar active decision: ${firstId}`) && second.stderr.includes('hint:'),
    `firstId=${firstId} stderr=${JSON.stringify(second.stderr)}`)
  return second
}

function testStoreStdoutContractUnchanged(second) {
  const j = second.json
  const keys = j ? Object.keys(j).sort().join(',') : ''
  check('testStoreStdoutContractUnchanged',
    second.code === 0 && keys === 'file,id,scope,status' && j.status === 'ok' && j.scope === 'local',
    `code=${second.code} keys=${keys} stdout=${JSON.stringify(second.stdout)}`)
}

function testStoreSilentOnUnrelatedDecision(fx) {
  const r = store(fx, 'Retry the upload queue with exponential backoff', 'Unrelated decision.')
  check('testStoreSilentOnUnrelatedDecision',
    r.code === 0 && !r.stderr.includes('similar active decision'),
    `code=${r.code} stderr=${JSON.stringify(r.stderr)}`)
}

function testStoreSilentOnNonDecisionCategory(fx) {
  const r = store(fx, 'Config files use JSON format', 'Same words, lesson category.', 'lesson')
  check('testStoreSilentOnNonDecisionCategory',
    r.code === 0 && !r.stderr.includes('similar active decision'),
    `code=${r.code} stderr=${JSON.stringify(r.stderr)}`)
}

// ===========================================================================
// Group 3 — em-doctor runtime probes (real script, isolated fixture store)
// ===========================================================================

function doctorRow(fx, extraArgs) {
  const r = run(EM_DOCTOR, ['--scope', 'local', ...(extraArgs || [])], fx)
  const rows = (r.json && Array.isArray(r.json.checks) ? r.json.checks : [])
    .filter(c => c.id === 'contradiction-candidates')
  return { r, rows }
}

function testDoctorWarnsOnContradiction(fx) {
  const { r, rows } = doctorRow(fx)
  check('testDoctorWarnsOnContradiction',
    rows.length === 1 && rows[0].level === 'warn' && r.code === 0 &&
    typeof rows[0].data_dir === 'string' && rows[0].data_dir.length > 0,
    `code=${r.code} rows=${JSON.stringify(rows)}`)
}

function testDoctorStrictExitsNonZero(fx) {
  const { r, rows } = doctorRow(fx, ['--strict'])
  check('testDoctorStrictExitsNonZero',
    r.code === 1 && rows.length === 1 && rows[0].level === 'warn',
    `code=${r.code} rows=${JSON.stringify(rows)}`)
}

function testDoctorOkOnCleanStore() {
  const fx = mkFixture()
  try {
    store(fx, 'Config files use JSON format', 'Only decision in the store.')
    store(fx, 'Retry the upload queue with exponential backoff', 'Unrelated decision.')
    const { r, rows } = doctorRow(fx)
    check('testDoctorOkOnCleanStore',
      rows.length === 1 && rows[0].level === 'ok' && r.code === 0,
      `code=${r.code} rows=${JSON.stringify(rows)}`)
  } finally { cleanup(fx) }
}

function testReviseChainNotFlagged() {
  const fx = mkFixture()
  try {
    const first = store(fx, 'Config files use JSON format', 'We standardise on JSON.')
    const originalId = first.json && first.json.id
    const rev = run(EM_REVISE, ['--original', originalId, '--project', 'fx',
      '--summary', 'Config files use YAML format', '--body', 'Corrected: YAML.', '--scope', 'local'], fx)
    const { r, rows } = doctorRow(fx)
    check('testReviseChainNotFlagged',
      !!originalId && rev.code === 0 && rows.length === 1 && rows[0].level === 'ok',
      `reviseCode=${rev.code} reviseOut=${JSON.stringify(rev.stdout)} rows=${JSON.stringify(rows)}`)
  } finally { cleanup(fx) }
}

// ===========================================================================
// main
// ===========================================================================

console.log('# test-contradiction')

testIdenticalSummariesMatch()
testJsonVsYamlMatches()
testUnrelatedSummariesDoNotMatch()
testCrossProjectIgnored()
testNonDecisionCategoryIgnored()
testSupersededStatusIgnored()
testSupersedesChainLinkedPairExcluded()
testChainCycleTerminates()
testEmptySummaryNeverMatches()
testLargeGroupSkippedNotTruncated()
testDefaultMaxGroupIsPinned()
testFindForSelfExcluded()

const dirty = mkFixture()
try {
  const second = testStoreEmitsAdvisoryOnContradiction(dirty)
  testStoreStdoutContractUnchanged(second)
  testStoreSilentOnUnrelatedDecision(dirty)
  testStoreSilentOnNonDecisionCategory(dirty)
  testDoctorWarnsOnContradiction(dirty)
  testDoctorStrictExitsNonZero(dirty)
} finally { cleanup(dirty) }

testDoctorOkOnCleanStore()
testReviseChainNotFlagged()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
