#!/usr/bin/env node
/**
 * test-validate-plan-template.mjs — self-test for tools/validate-plan-template.mjs (#453).
 *
 * The validator is a manual authoring tool, not a CI gate on plans; this suite
 * pins its behavior. Acceptance from #453:
 *   - docs/plans/rfc-009-p0.md after the 2026-07-06 fixes → exit 0;
 *   - the pre-fix shape → exit 1 naming the pointer sections and the
 *     prose-summary A.7 cells. The pre-fix revision is not in git history (the
 *     plan landed squashed in 0776b02), so t_prefix_shape re-creates both
 *     violation shapes by transforming the real plan.
 * Every other case drives the real CLI on a seeded plan in a temp dir.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'validate-plan-template.mjs')
const TEMPLATE = fs.readFileSync(path.join(REPO, 'docs', 'PLAN_TEMPLATE.md'), 'utf8')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vpt-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function run(planPath, extra = []) {
  const r = spawnSync(process.execPath, [TOOL, planPath, ...extra], { encoding: 'utf8' })
  return { code: r.status, json: JSON.parse(r.stdout) }
}
function runText(name, text, extra) {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, text)
  return run(p, extra)
}

const HEAD = '| Step | File | Kind | Exact action | Verify (observed → expected) |\n|---|---|---|---|---|'
const SECTION_KEYS = [...Array(20)].map((_, i) => `§${i + 1}`)
const APPENDIX_KEYS = ['A.0', 'A.1', 'A.2', 'A.3', 'A.4', 'A.5', 'A.6', 'A.6b', 'A.7', 'A.8', 'A.9']

/** A structurally complete plan; `a7` is the step-table body, `tail` goes after it. */
function plan({ altitude = 'low', keys = null, a7 = '', tail = '', body = (k) => `Body of ${k} with a concrete artifact.` } = {}) {
  const all = keys || (altitude === 'low' ? [...SECTION_KEYS, ...APPENDIX_KEYS] : SECTION_KEYS)
  const out = ['# FIX-1 Test Plan', '']
  for (const k of all) {
    out.push(`## ${k} Section`, '')
    if (k === '§1') out.push('| Field | Value |', '|---|---|', `| Executor altitude (§0.1) | \`${altitude}\` |`, '')
    else if (k === 'A.7') out.push(HEAD, a7, '', tail, '')
    else out.push(body(k), '')
  }
  return out.join('\n')
}

const JS_ARTS = [
  '`S1-A1-ANCHOR`:', '', '```js', 'const a = 1', '```', '',
  '`S1-A1-REPLACE`:', '', '```js', 'const a = 1', 'const b = 2 // marker-in-comment', '```', '',
  '`S1-TEST` — the entire contents of `tests/t.mjs`:', '', '```js', "console.log('ok')", '```',
].join('\n')

test('t_p0_passes: the post-fix rfc-009-p0 plan conforms (acceptance leg 1)', () => {
  const r = run(path.join(REPO, 'docs', 'plans', 'rfc-009-p0.md'))
  assert.equal(r.code, 0, JSON.stringify(r.json.failures))
  assert.equal(r.json.status, 'ok')
  assert.equal(r.json.altitude, 'low')
  assert.equal(r.json.altitude_source, 'declared')
  assert.equal(r.json.counts.a7_rows, 29)
})

test('t_prefix_shape: pointer sections + prose-summary A.7 cells fail by name (acceptance leg 2)', () => {
  let src = fs.readFileSync(path.join(REPO, 'docs', 'plans', 'rfc-009-p0.md'), 'utf8')
  for (const key of ['A.2', 'A.3', 'A.4']) {
    const re = new RegExp(`(## ${key.replace('.', '\\.')}[^\\n]*\\n)[\\s\\S]*?(?=\\n## )`)
    assert.match(src, re, `fixture anchor for ${key}`)
    src = src.replace(re, `$1\nSee docs/PLAN_TEMPLATE.md §${key}; copy it verbatim at handoff.\n`)
  }
  const edit = /\| 1\.1 \| `scripts\/em-pattern-health\.mjs` \| EDIT \| [^|]+\|/
  assert.match(src, edit)
  src = src.replace(edit, '| 1.1 | `scripts/em-pattern-health.mjs` | EDIT | Implementing the hermetic flag exactly as §8.3 describes. |')
  const create = /\| 1\.8 \| `tests\/test-pattern-health-hermetic\.mjs` \| CREATE \| [^|]+\|/
  assert.match(src, create)
  src = src.replace(create, '| 1.8 | `tests/test-pattern-health-hermetic.mjs` | CREATE | Write the suite covering the 8 assertions. |')
  const r = runText('p0-prefix.md', src)
  assert.equal(r.code, 1)
  const msgs = r.json.failures.map((f) => `${f.check}: ${f.message}`)
  for (const key of ['A.2', 'A.3', 'A.4']) assert.ok(msgs.some((m) => m.startsWith('sections:') && m.includes(`section ${key} is a pointer`)), `${key} named: ${msgs.join(' | ')}`)
  assert.ok(msgs.some((m) => m.includes('step 1.1: action cell is a prose summary')), msgs.join(' | '))
  assert.ok(msgs.some((m) => m.includes('step 1.1: EDIT row references no fenced ANCHOR/REPLACE')), msgs.join(' | '))
  assert.ok(msgs.some((m) => m.includes('step 1.8: action cell is a prose summary ("the 8 assertions")')), msgs.join(' | '))
  assert.ok(msgs.some((m) => m.includes('step 1.8: CREATE row references no fenced block')), msgs.join(' | '))
})

test('t_sections: missing + out-of-order + empty sections fail; high altitude needs no appendix', () => {
  const keys = SECTION_KEYS.filter((k) => k !== '§7')
  ;[keys[2], keys[3]] = [keys[3], keys[2]]
  const r = runText('order.md', plan({ altitude: 'high', keys, body: (k) => (k === '§5' ? '' : 'x') }))
  assert.equal(r.code, 1)
  const msgs = r.json.failures.map((f) => f.message)
  assert.ok(msgs.includes('missing mandatory section §7 (altitude high)'), msgs.join(' | '))
  assert.ok(msgs.includes('section §3 appears after §4; template order puts it before'), msgs.join(' | '))
  assert.ok(msgs.includes('section §5 is empty'), msgs.join(' | '))
  assert.ok(!msgs.some((m) => m.includes('A.')), 'high altitude must not require Appendix A')
  const ok = runText('high-ok.md', plan({ altitude: 'high' }))
  assert.equal(ok.code, 0, JSON.stringify(ok.json.failures))
})

test('t_default_altitude_low: an undeclared altitude requires Appendix A', () => {
  const src = plan({ altitude: 'high' }).replace(/\| Executor altitude[^\n]*\n/, '')
  const r = runText('noalt.md', src)
  assert.equal(r.json.altitude, 'low')
  assert.match(r.json.altitude_source, /^default/)
  assert.ok(r.json.failures.some((f) => f.message === 'missing mandatory section A.6b (altitude low)'))
})

test('t_forbidden_scoped: §A.1 phrases fail in A.5 and A.7 rows only', () => {
  const a7 = '| 1.0 | — | — | Pre-flight; figure out the port. | every row passes |'
  const src = plan({ a7, body: (k) => (k === 'A.5' ? '```js\n// TBD: constant\n```' : k === '§3' ? 'We decide later.' : 'x') })
  const r = runText('forbidden.md', src)
  const hits = r.json.failures.filter((f) => f.check === 'forbidden-phrase').map((f) => f.message)
  assert.deepEqual(hits.sort(), ['§A.1 forbidden phrase "TBD" inside the §A.5 block', '§A.1 forbidden phrase "figure out" inside an §A.7 step row'].sort())
})

test('t_forbidden_reads_template: the phrase list comes from the template grep', () => {
  const custom = TEMPLATE.replace(/grep -niE "[^"]+"/, 'grep -niE "zebra"')
  const tpl = path.join(tmp, 'tpl.md')
  fs.writeFileSync(tpl, custom)
  const a7 = '| 1.0 | — | — | Pre-flight; figure out the zebra. | every row passes |'
  const r = runText('custom.md', plan({ a7 }), ['--template', tpl])
  const hits = r.json.failures.filter((f) => f.check === 'forbidden-phrase').map((f) => f.message)
  assert.deepEqual(hits, ['§A.1 forbidden phrase "zebra" inside an §A.7 step row'])
})

test('t_cells_accepts_all_three_artifact_forms', () => {
  const a7 = [
    '| 1.1 | `a.mjs` | EDIT | Replace **`S1-A1-ANCHOR`** with **`S1-A1-REPLACE`**. | `grep -c "const b = 2" a.mjs` → `1` |',
    '| 1.2 | `b.mjs` | EDIT | See Listing L1. | `node b.mjs` → exit 0 |',
    '| 1.3 | `c.mjs` | EDIT | `ANCHOR:` `let x = 1` → `REPLACE:` `let x = 2` | `grep -c "let x = 2" c.mjs` → `1` |',
    '| 1.4 | `tests/t.mjs` | CREATE | Write **`S1-TEST`** as the file\'s entire contents. | `node tests/t.mjs` → `ok` |',
  ].join('\n')
  const tail = [JS_ARTS, '', '### Listing L1 — b.mjs (step 1.2)', '', '`ANCHOR` (verbatim):', '', '```js', 'old()', '```', '', '`REPLACE` with:', '', '```js', 'nu()', '```'].join('\n')
  const r = runText('forms.md', plan({ a7, tail }))
  assert.equal(r.code, 0, JSON.stringify(r.json.failures))
  assert.equal(r.json.counts.listings, 1)
})

test('t_cells_intent_verbs_outside_code_spans_fail', () => {
  const a7 = [
    '| 1.1 | `a.mjs` | EDIT | Replace **`S1-A1-ANCHOR`** with **`S1-A1-REPLACE`**; ensure it compiles. | `grep -c "const b = 2" a.mjs` → `1` |',
    '| 1.2 | `a.mjs` | EDIT | Replace **`S1-A1-ANCHOR`** with **`S1-A1-REPLACE`** (`assert that` is code). | `grep -c "const b = 2" a.mjs` → `1` |',
  ].join('\n')
  const r = runText('intent.md', plan({ a7, tail: JS_ARTS }))
  const cells = r.json.failures.filter((f) => f.check === 'a7-cells').map((f) => f.message)
  assert.deepEqual(cells, ['step 1.1: action cell describes intent ("ensure") instead of the exact change'])
})

test('t_verify_heuristics: no expected value, tolerant pattern, self-fulfilling comment grep', () => {
  const a7 = [
    '| 1.1 | `a.mjs` | EDIT | Replace **`S1-A1-ANCHOR`** with **`S1-A1-REPLACE`**. | `node a.mjs` exits cleanly |',
    '| 1.2 | `a.mjs` | EDIT | Replace **`S1-A1-ANCHOR`** with **`S1-A1-REPLACE`**. | `node a.mjs \\|\\| true` → 0 |',
    '| 1.3 | `a.mjs` | EDIT | Replace **`S1-A1-ANCHOR`** with **`S1-A1-REPLACE`**. | `grep -c "marker-in-comment" a.mjs` → `1` |',
    '| 1.4 | `a.mjs` | EDIT | Replace **`S1-A1-ANCHOR`** with **`S1-A1-REPLACE`**. | `grep -c "const b = 2" a.mjs` → `1` |',
  ].join('\n')
  const r = runText('verify.md', plan({ a7, tail: JS_ARTS }))
  const v = r.json.failures.filter((f) => f.check === 'verify').map((f) => f.message)
  assert.deepEqual(v, [
    'step 1.1: Verify names no expected value (no "→ <expected>")',
    'step 1.2: Verify uses a tolerant pattern ("|| true") a no-op passes',
    'step 1.3: Verify greps "marker-in-comment", which the step\'s own block carries only in comment/echo lines (self-fulfilling)',
  ])
})

test('t_usage: no plan path → exit 2', () => {
  const r = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.equal(JSON.parse(r.stdout).status, 'error')
})
