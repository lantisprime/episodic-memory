#!/usr/bin/env node
/**
 * test-check-plan-template-sync.mjs — self-test for tools/check-plan-template-sync.mjs (#438).
 *
 *   t_repo_in_sync       the shipped template passes (§0.2 defers to §A.1).
 *   t_issue_438_drift    the pre-fix shape (a §0.2 list of 9 vs the 12-phrase grep) fails,
 *                        naming exactly the three missing phrases the issue reported.
 *   t_a1_prose_drift     the §A.1 prose list drifting from its own grep fails.
 *   t_parse_error        a template with no §A.1 grep is a parse error (exit 2), not a pass.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'check-plan-template-sync.mjs')
const TEMPLATE = fs.readFileSync(path.join(REPO, 'docs', 'PLAN_TEMPLATE.md'), 'utf8')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpts-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function run(src) {
  const args = [TOOL]
  if (src !== undefined) {
    const p = path.join(tmp, `t${Math.random().toString(36).slice(2)}.md`)
    fs.writeFileSync(p, src)
    args.push('--template', p)
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { code: r.status, json: JSON.parse(r.stdout) }
}

const PRE_FIX_02 = `If any sentence in the plan contains the words **"decide", "choose", "figure out",
"as appropriate", "if needed", "handle accordingly", "etc.", "and so on", or "TBD"**, the
plan is not executor-ready.`

function with02(text) {
  const re = /(### 0\.2[^\n]*\n\n)[\s\S]*?(?=\n### 0\.3)/
  assert.match(TEMPLATE, re, 'fixture anchor: §0.2 body')
  return TEMPLATE.replace(re, `$1${text}\n`)
}

test('t_repo_in_sync', () => {
  const r = run()
  assert.equal(r.code, 0, JSON.stringify(r.json))
  assert.equal(r.json.status, 'ok')
  assert.equal(r.json.phrases.length, 12)
  assert.deepEqual(r.json.drift, [])
})

test('t_issue_438_drift', () => {
  const r = run(with02(PRE_FIX_02))
  assert.equal(r.code, 1)
  assert.deepEqual(r.json.drift, [{ copy: '§0.2 tripwire list', missing_vs_grep: ['should probably', 'something like', 'or similar'], extra_vs_grep: [] }])
})

test('t_a1_prose_drift', () => {
  assert.ok(TEMPLATE.includes('`something like`, `or similar`'), 'fixture anchor: §A.1 prose tail')
  const r = run(TEMPLATE.replace('`something like`, `or similar`', '`something like`, `kinda`'))
  assert.equal(r.code, 1)
  assert.deepEqual(r.json.drift, [{ copy: '§A.1 prose list', missing_vs_grep: ['or similar'], extra_vs_grep: ['kinda'] }])
})

test('t_parse_error', () => {
  const r = run(TEMPLATE.replace(/grep -niE "[^"]+"/, 'grep -n something'))
  assert.equal(r.code, 2)
  assert.equal(r.json.status, 'error')
  assert.match(r.json.message, /no grep -E/)
})
