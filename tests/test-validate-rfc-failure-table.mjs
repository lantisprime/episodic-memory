#!/usr/bin/env node
/**
 * test-validate-rfc-failure-table.mjs — drift-detection self-tests.
 *
 * Builds a minimal RFC-shaped fixture per scenario, runs the validator,
 * asserts on the violation kinds.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'validate-rfc-failure-table.mjs')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) { fail++; console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`) }
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rfc-failure-${label}-`))
}

function fixture(rows, yamlRows = rows) {
  const tableHeader = `| # | Failure | Detector | Terminal | Evidence | Lesson? |\n|---|---|---|---|---|---|\n`
  const proseRows = rows.map(r =>
    `| ${r.id} | ${r.failure || 'F'} | ${r.detector || 'D'} | ${r.terminal || 'C'} | \`${r.evidence}\` | ${r.lesson === true ? 'yes' : r.lesson === false ? 'no' : r.lesson} |`
  ).join('\n')
  const yamlBlock = '```yaml\nfailure_modes:\n' + yamlRows.map(r =>
    `  - id: ${r.id}\n    failure: ${r.failure || 'F'}\n    detector: ${r.detector || 'D'}\n    terminal: ${r.terminal || 'C'}\n    evidence: ${r.evidence}\n    lesson: ${typeof r.lesson === 'string' ? r.lesson : r.lesson ? 'true' : 'false'}`
  ).join('\n') + '\n```\n'
  return `# RFC fixture\n\n## §11.5 Failure modes & recovery table\n\n${tableHeader}${proseRows}\n\n${yamlBlock}`
}

function writeFixture(content) {
  const dir = makeTempDir('fix')
  const file = path.join(dir, 'RFC-test.md')
  fs.writeFileSync(file, content)
  return file
}

function run(file) {
  const r = spawnSync('node', [SCRIPT, file, '--json'], { encoding: 'utf8' })
  return { exitCode: r.status, parsed: JSON.parse(r.stdout) }
}

// ---------------------------------------------------------------------------
tap('happy path — agreeing prose + YAML → exit 0', () => {
  const file = writeFixture(fixture([
    { id: 1, evidence: 'bp1-foo', lesson: true },
    { id: 2, evidence: 'bp1-bar', lesson: false },
  ]))
  const r = run(file)
  assert.equal(r.exitCode, 0)
  assert.equal(r.parsed.results[0].violations.length, 0)
})

tap('duplicate id in prose → duplicate-id-prose', () => {
  const file = writeFixture(fixture([
    { id: 1, evidence: 'bp1-foo', lesson: true },
    { id: 1, evidence: 'bp1-bar', lesson: false },
  ]))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  assert.ok(r.parsed.results[0].violations.some(v => v.kind === 'duplicate-id-prose'))
})

tap('duplicate id in yaml → duplicate-id-yaml', () => {
  const file = writeFixture(fixture(
    [{ id: 1, evidence: 'bp1-foo', lesson: true }, { id: 2, evidence: 'bp1-bar', lesson: true }],
    [{ id: 1, evidence: 'bp1-foo', lesson: true }, { id: 1, evidence: 'bp1-bar', lesson: true }],
  ))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  assert.ok(r.parsed.results[0].violations.some(v => v.kind === 'duplicate-id-yaml'))
})

tap('id in prose but missing from yaml → id-in-prose-not-yaml', () => {
  const file = writeFixture(fixture(
    [{ id: 1, evidence: 'bp1-foo', lesson: true }, { id: 2, evidence: 'bp1-bar', lesson: true }],
    [{ id: 1, evidence: 'bp1-foo', lesson: true }],
  ))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  assert.ok(r.parsed.results[0].violations.some(v => v.kind === 'id-in-prose-not-yaml'))
})

tap('id in yaml but missing from prose → id-in-yaml-not-prose', () => {
  const file = writeFixture(fixture(
    [{ id: 1, evidence: 'bp1-foo', lesson: true }],
    [{ id: 1, evidence: 'bp1-foo', lesson: true }, { id: 5, evidence: 'bp1-extra', lesson: true }],
  ))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  assert.ok(r.parsed.results[0].violations.some(v => v.kind === 'id-in-yaml-not-prose'))
})

tap('evidence tag drift between prose and yaml → evidence-drift', () => {
  const file = writeFixture(fixture(
    [{ id: 1, evidence: 'bp1-foo', lesson: true }],
    [{ id: 1, evidence: 'bp1-bar', lesson: true }],
  ))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  assert.ok(r.parsed.results[0].violations.some(v => v.kind === 'evidence-drift'))
})

tap('lesson drift (prose yes, yaml false) → lesson-drift', () => {
  const file = writeFixture(fixture(
    [{ id: 1, evidence: 'bp1-foo', lesson: true }],
    [{ id: 1, evidence: 'bp1-foo', lesson: false }],
  ))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  assert.ok(r.parsed.results[0].violations.some(v => v.kind === 'lesson-drift'))
})

tap('non-bp1 evidence tag → evidence-tag-shape', () => {
  const file = writeFixture(fixture(
    [{ id: 1, evidence: 'something-else', lesson: true }],
  ))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  // Prose evidence cell parsing requires a backtick-wrapped bp1-* tag —
  // the prose row will trigger evidence-tag-missing; YAML row will trigger evidence-tag-shape-yaml.
  const kinds = r.parsed.results[0].violations.map(v => v.kind)
  assert.ok(kinds.includes('evidence-tag-shape-yaml') || kinds.includes('evidence-tag-missing'))
})

tap('conditional lesson value matches between prose and yaml', () => {
  const file = writeFixture(fixture(
    [{ id: 1, evidence: 'bp1-foo', lesson: 'conditional' }],
    [{ id: 1, evidence: 'bp1-foo', lesson: 'conditional' }],
  ))
  const r = run(file)
  assert.equal(r.exitCode, 0)
  assert.equal(r.parsed.results[0].violations.length, 0)
})

tap('real RFC-004 spec is currently valid', () => {
  const file = path.join(REPO, 'docs', 'rfcs', 'RFC-004-bp1-auto-pilot.md')
  if (!fs.existsSync(file)) return
  const r = run(file)
  assert.equal(r.exitCode, 0, `RFC-004 should validate; got ${JSON.stringify(r.parsed.results[0].violations)}`)
})

console.log(`\n1..${pass + fail}`)
if (fail) { console.log(`# FAILED ${fail} of ${pass + fail}`); process.exit(1) }
else console.log(`# PASSED ${pass}`)
