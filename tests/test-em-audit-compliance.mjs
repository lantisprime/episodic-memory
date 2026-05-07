#!/usr/bin/env node
/**
 * test-em-audit-compliance.mjs — integration test for em-audit-compliance.mjs.
 *
 * Builds a temp $HOME with three fixture sessions:
 *   - clean: short, no impl, no plan, no skips
 *   - skipper: long impl session that skips all three rules
 *   - compliant: long impl session that touched plan-gate + ran tests +
 *                wrote handoff
 *
 * Runs the audit script and asserts skip counts + eligibility denominators.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'em-audit-compliance.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'em-audit-test-'))
const projectsDir = path.join(TMP, '.claude', 'projects')
fs.mkdirSync(path.join(projectsDir, '-Users-test-bar'), { recursive: true })

function ts(min) {
  return new Date(Date.UTC(2099, 0, 1, 10, min, 0)).toISOString()
}

function asst(text, min, sid) {
  return { type: 'assistant', timestamp: ts(min), sessionId: sid, message: { content: [{ type: 'text', text }] } }
}
function user(text, min, sid) {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: ts(min), sessionId: sid, content: text }
}
function toolUse(name, input, min, sid) {
  return { type: 'assistant', timestamp: ts(min), sessionId: sid, message: { content: [{ type: 'tool_use', name, id: `t${min}`, input }] } }
}

// --- session 1: clean (short, no impl) ----------------------------------
const sid1 = 'aaaa1111-0000-0000-0000-000000000000'
const session1 = [
  user('what does this script do', 0, sid1),
  asst('it does X', 1, sid1),
]
fs.writeFileSync(path.join(projectsDir, '-Users-test-bar', sid1 + '.jsonl'),
  session1.map((r) => JSON.stringify(r)).join('\n') + '\n')

// --- session 2: skipper (impl, plan mentioned, no marker, no tests, no issue) ---
const sid2 = 'bbbb2222-0000-0000-0000-000000000000'
const session2 = []
for (let i = 0; i < 25; i++) session2.push(asst(`step ${i}`, i, sid2))
session2.push(asst('here is my plan: ...', 26, sid2))
session2.push(toolUse('Edit', { file_path: '/repo/scripts/foo.mjs', old_string: 'a', new_string: 'b' }, 27, sid2))
session2.push(toolUse('Write', { file_path: '/repo/scripts/bar.mjs', content: 'x' }, 28, sid2))
fs.writeFileSync(path.join(projectsDir, '-Users-test-bar', sid2 + '.jsonl'),
  session2.map((r) => JSON.stringify(r)).join('\n') + '\n')

// --- session 3: compliant ------------------------------------------------
const sid3 = 'cccc3333-0000-0000-0000-000000000000'
const session3 = []
for (let i = 0; i < 25; i++) session3.push(asst(`step ${i}`, i, sid3))
session3.push(asst('here is my plan', 26, sid3))
session3.push(toolUse('Bash', { command: 'touch /repo/.claude/.plan-approval-pending' }, 27, sid3))
session3.push(toolUse('Edit', { file_path: '/repo/scripts/foo.mjs', old_string: 'a', new_string: 'b' }, 28, sid3))
session3.push(toolUse('Bash', { command: 'node tests/test-foo.mjs' }, 29, sid3))
session3.push(toolUse('Write', { file_path: '/repo/memory/session_handoff.md', content: 'wrap-up' }, 30, sid3))
fs.writeFileSync(path.join(projectsDir, '-Users-test-bar', sid3 + '.jsonl'),
  session3.map((r) => JSON.stringify(r)).join('\n') + '\n')

// --- TAP harness ---------------------------------------------------------
let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) { fail++; console.log(`not ok ${pass + fail} - ${name}\n  ${e.message}`); console.log(e.stack) }
}

function runScript(args) {
  return execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: TMP },
    cwd: TMP,
  })
}

tap('audit aggregates skips correctly', () => {
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--slug', 'test-bar'])
  const r = JSON.parse(out)
  assert.equal(r.totalSessions, 3)
  // rule-9: sessions >=20 records: session2 (28) + session3 (31) = 2 eligible
  // session2 lacks handoff write, session3 has it -> 1 skipped
  assert.equal(r.rules['rule-9-handoff'].eligibleSessions, 2)
  assert.equal(r.rules['rule-9-handoff'].skipped, 1)
  // rule-8: editWriteCount>0 AND planMentioned: session2 + session3 = 2
  // session2 has no marker touch -> skipped. session3 has it -> not skipped.
  assert.equal(r.rules['rule-8-plan-gate'].eligibleSessions, 2)
  assert.equal(r.rules['rule-8-plan-gate'].skipped, 1)
  // rule-18: implEditCount>0: session2 + session3 = 2
  // session2 has no test run, no issue -> skipped. session3 ran tests -> not.
  assert.equal(r.rules['rule-18-e2e'].eligibleSessions, 2)
  assert.equal(r.rules['rule-18-e2e'].skipped, 1)
})

tap('top offenders surface session2', () => {
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--slug', 'test-bar'])
  const r = JSON.parse(out)
  assert.ok(r.topOffenders.length >= 1)
  assert.equal(r.topOffenders[0].sessionId, 'bbbb2222-0000-0000-0000-000000000000')
  assert.deepEqual(r.topOffenders[0].skipped.sort(), ['rule-18-e2e', 'rule-8-plan-gate', 'rule-9-handoff'])
})

tap('clean session has no skips', () => {
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--slug', 'test-bar'])
  const r = JSON.parse(out)
  // session1 should not appear in top offenders
  const ids = r.topOffenders.map((o) => o.sessionId)
  assert.ok(!ids.includes('aaaa1111-0000-0000-0000-000000000000'))
})

tap('--format markdown produces table', () => {
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--slug', 'test-bar', '--format', 'markdown'])
  assert.ok(out.includes('# Compliance audit'))
  assert.ok(out.includes('| Rule | Skipped'))
  assert.ok(out.includes('rule-9-handoff'))
})

tap('eligibility denominators exclude inapplicable sessions', () => {
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--slug', 'test-bar'])
  const r = JSON.parse(out)
  // The clean session (2 records, no impl, no plan) should NOT be in any
  // rule's eligibility denominator. Each rule's eligible should be exactly 2,
  // not 3.
  for (const rule of Object.keys(r.rules)) {
    assert.equal(r.rules[rule].eligibleSessions, 2, `${rule} eligibility wrong`)
  }
})

// --- cleanup -------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
