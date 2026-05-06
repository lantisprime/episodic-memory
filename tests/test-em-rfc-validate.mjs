#!/usr/bin/env node
/**
 * test-em-rfc-validate.mjs — drift-detection tests for em-rfc-validate.mjs.
 *
 * Builds a temporary RFC tree per scenario, runs em-rfc-validate against it
 * via --rfcs-dir + --json, and asserts the expected violation kinds appear.
 *
 * Scenarios:
 *   1. Happy path — all three sources agree → exit 0.
 *   2. Duplicate id across files → duplicate-id-across-files.
 *   3. Filename prefix ≠ frontmatter id → filename-id-mismatch.
 *   4. File missing from _index.json → file-not-in-index.
 *   5. _index.json entry without a file → index-not-in-files.
 *   6. Title drift between frontmatter and _index.json → index-frontmatter-title-drift.
 *   7. Status drift between _index.json and README → index-readme-status-drift.
 *   8. README row without _index.json entry → readme-not-in-index.
 *   9. Sub-plan files (rfc_id empty) ignored — no false positive.
 *
 * Usage: node tests/test-em-rfc-validate.mjs
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'em-rfc-validate.mjs')

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rfc-validate-${label}-`))
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content)
}

function rfcContent({ id, slug, title, status = 'draft', champion = 'Charlton Ho' }) {
  return `---
rfc_id: ${id}
slug: ${slug}
title: "${title}"
status: ${status}
champion: ${champion}
created: 2026-05-06
last_modified: 2026-05-06
supersedes: ~
superseded_by: ~
---

# ${id} — ${title}

(stub)
`
}

function indexContent(rfcs) {
  return JSON.stringify({ $schema_version: '1.0.0', rfcs }, null, 2) + '\n'
}

function readmeContent(rows) {
  const header = `# RFCs

## Active RFCs

| RFC | Title | Status | Champion |
|---|---|---|---|
`
  const body = rows.map(r => `| ${r.id} | ${r.title} | ${r.status} | ${r.champion} |`).join('\n')
  return header + body + '\n\n---\n'
}

function runValidator(dir) {
  try {
    const out = execFileSync('node', [SCRIPT, '--json', '--rfcs-dir', dir], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    return { exitCode: 0, parsed: JSON.parse(out) }
  } catch (e) {
    return { exitCode: e.status, parsed: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr }
  }
}

function violationKinds(parsed) {
  return new Set((parsed?.violations || []).map(v => v.kind))
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

const cases = []

cases.push(['happy path', () => {
  const dir = makeTempDir('happy')
  try {
    writeFile(dir, 'RFC-001-foo.md', rfcContent({ id: 'RFC-001', slug: 'foo', title: 'Foo' }))
    writeFile(dir, 'RFC-002-bar.md', rfcContent({ id: 'RFC-002', slug: 'bar', title: 'Bar', status: 'accepted' }))
    writeFile(dir, '_index.json', indexContent([
      { id: 'RFC-001', slug: 'foo', title: 'Foo', status: 'draft', champion: 'Charlton Ho', file: 'RFC-001-foo.md' },
      { id: 'RFC-002', slug: 'bar', title: 'Bar', status: 'accepted', champion: 'Charlton Ho', file: 'RFC-002-bar.md' },
    ]))
    writeFile(dir, 'README.md', readmeContent([
      { id: 'RFC-001', title: 'Foo', status: 'draft', champion: 'Charlton Ho' },
      { id: 'RFC-002', title: 'Bar', status: 'accepted', champion: 'Charlton Ho' },
    ]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 0, `happy path should exit 0; got ${r.exitCode} with violations: ${JSON.stringify(r.parsed?.violations)}`)
    assert.equal(r.parsed.status, 'ok')
    assert.equal(r.parsed.rfcs_in_index, 2)
    assert.equal(r.parsed.rfcs_in_files, 2)
    assert.equal(r.parsed.rfcs_in_readme, 2)
  } finally { cleanup(dir) }
}])

cases.push(['duplicate id across files', () => {
  const dir = makeTempDir('dup-id')
  try {
    writeFile(dir, 'RFC-001-foo.md', rfcContent({ id: 'RFC-001', slug: 'foo', title: 'Foo' }))
    writeFile(dir, 'RFC-002-bar.md', rfcContent({ id: 'RFC-001', slug: 'bar', title: 'Bar' }))  // duplicate rfc_id
    writeFile(dir, '_index.json', indexContent([]))
    writeFile(dir, 'README.md', readmeContent([]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 1)
    assert.ok(violationKinds(r.parsed).has('duplicate-id-across-files'),
      `expected duplicate-id-across-files; got ${[...violationKinds(r.parsed)].join(',')}`)
  } finally { cleanup(dir) }
}])

cases.push(['filename prefix vs frontmatter id mismatch', () => {
  const dir = makeTempDir('prefix-mismatch')
  try {
    writeFile(dir, 'RFC-005-foo.md', rfcContent({ id: 'RFC-006', slug: 'foo', title: 'Foo' }))  // file says 005, frontmatter says 006
    writeFile(dir, '_index.json', indexContent([
      { id: 'RFC-006', slug: 'foo', title: 'Foo', status: 'draft', champion: 'Charlton Ho', file: 'RFC-005-foo.md' },
    ]))
    writeFile(dir, 'README.md', readmeContent([
      { id: 'RFC-006', title: 'Foo', status: 'draft', champion: 'Charlton Ho' },
    ]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 1)
    assert.ok(violationKinds(r.parsed).has('filename-id-mismatch'))
  } finally { cleanup(dir) }
}])

cases.push(['file missing from _index.json', () => {
  const dir = makeTempDir('file-missing-index')
  try {
    writeFile(dir, 'RFC-001-foo.md', rfcContent({ id: 'RFC-001', slug: 'foo', title: 'Foo' }))
    writeFile(dir, '_index.json', indexContent([]))
    writeFile(dir, 'README.md', readmeContent([]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 1)
    assert.ok(violationKinds(r.parsed).has('file-not-in-index'))
  } finally { cleanup(dir) }
}])

cases.push(['_index.json entry without a file', () => {
  const dir = makeTempDir('orphan-index')
  try {
    writeFile(dir, '_index.json', indexContent([
      { id: 'RFC-099', slug: 'ghost', title: 'Ghost', status: 'draft', champion: 'Charlton Ho', file: 'RFC-099-ghost.md' },
    ]))
    writeFile(dir, 'README.md', readmeContent([
      { id: 'RFC-099', title: 'Ghost', status: 'draft', champion: 'Charlton Ho' },
    ]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 1)
    assert.ok(violationKinds(r.parsed).has('index-not-in-files'))
  } finally { cleanup(dir) }
}])

cases.push(['title drift frontmatter vs _index.json', () => {
  const dir = makeTempDir('title-drift')
  try {
    writeFile(dir, 'RFC-001-foo.md', rfcContent({ id: 'RFC-001', slug: 'foo', title: 'Foo Real' }))
    writeFile(dir, '_index.json', indexContent([
      { id: 'RFC-001', slug: 'foo', title: 'Foo Stale', status: 'draft', champion: 'Charlton Ho', file: 'RFC-001-foo.md' },
    ]))
    writeFile(dir, 'README.md', readmeContent([
      { id: 'RFC-001', title: 'Foo Stale', status: 'draft', champion: 'Charlton Ho' },
    ]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 1)
    assert.ok(violationKinds(r.parsed).has('index-frontmatter-title-drift'))
  } finally { cleanup(dir) }
}])

cases.push(['status drift _index.json vs README', () => {
  const dir = makeTempDir('status-drift')
  try {
    writeFile(dir, 'RFC-001-foo.md', rfcContent({ id: 'RFC-001', slug: 'foo', title: 'Foo', status: 'accepted' }))
    writeFile(dir, '_index.json', indexContent([
      { id: 'RFC-001', slug: 'foo', title: 'Foo', status: 'accepted', champion: 'Charlton Ho', file: 'RFC-001-foo.md' },
    ]))
    writeFile(dir, 'README.md', readmeContent([
      { id: 'RFC-001', title: 'Foo', status: 'draft', champion: 'Charlton Ho' },  // README out of date
    ]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 1)
    assert.ok(violationKinds(r.parsed).has('index-readme-status-drift'))
  } finally { cleanup(dir) }
}])

cases.push(['README row without _index.json entry', () => {
  const dir = makeTempDir('readme-orphan')
  try {
    writeFile(dir, '_index.json', indexContent([]))
    writeFile(dir, 'README.md', readmeContent([
      { id: 'RFC-099', title: 'Phantom', status: 'draft', champion: 'Charlton Ho' },
    ]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 1)
    assert.ok(violationKinds(r.parsed).has('readme-not-in-index'))
  } finally { cleanup(dir) }
}])

cases.push(['sub-plan files (no rfc_id) are ignored', () => {
  const dir = makeTempDir('subplan')
  try {
    writeFile(dir, 'RFC-001-foo.md', rfcContent({ id: 'RFC-001', slug: 'foo', title: 'Foo' }))
    // sub-plan: matches RFC-NNN-*.md glob but has no rfc_id frontmatter
    writeFile(dir, 'RFC-001-phase2-plan.md', `---
title: Phase 2 Plan
---
# Phase 2

Sub-plan body.
`)
    writeFile(dir, '_index.json', indexContent([
      { id: 'RFC-001', slug: 'foo', title: 'Foo', status: 'draft', champion: 'Charlton Ho', file: 'RFC-001-foo.md' },
    ]))
    writeFile(dir, 'README.md', readmeContent([
      { id: 'RFC-001', title: 'Foo', status: 'draft', champion: 'Charlton Ho' },
    ]))
    const r = runValidator(dir)
    assert.equal(r.exitCode, 0, `sub-plan should be ignored; got violations: ${JSON.stringify(r.parsed?.violations)}`)
    assert.equal(r.parsed.rfcs_in_files, 1, 'sub-plan must not count as a canonical RFC')
  } finally { cleanup(dir) }
}])

let passed = 0
let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`)
    failed++
  }
}

console.log(`\n${passed}/${cases.length} passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
