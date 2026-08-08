#!/usr/bin/env node
/**
 * test-activation-log-schema.mjs — schemas/activation-log.schema.json vs the REAL writer
 * (#632 residual 2).
 *
 * Drives the real appendActivationLine (scripts/lib/activation-log.mjs) on an isolated tmp dir —
 * the same direct-import pattern as tests/test-rfc-009-p4-telemetry.mjs — parses every emitted
 * JSONL line, and validateInstance()s each against the schema (fail-closed import from
 * scripts/lib/json-instance-validate.mjs, matching the schema + validateInstance idiom in
 * tests/test-trigger-index-playbooks.mjs / scripts/lib/playbook-registration.mjs). Includes one
 * negative case: a mutated row must fail validation.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendActivationLine, ACTIVATION_LOG_NAME } from '../scripts/lib/activation-log.mjs'
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'activation-log.schema.json'), 'utf8'))

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })
function mkTmp(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `actlog-schema-${label}-`)))
  _tmpDirs.push(dir)
  return dir
}

function readLines(dir) {
  return fs.readFileSync(path.join(dir, ACTIVATION_LOG_NAME), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// (1) tier-1 entry (integer effective_priority, non-null source_scope), surface: per_prompt.
t('schema::tier1EntryValid', () => {
  const dir = mkTmp('tier1')
  appendActivationLine(dir, {
    ts: '2026-07-12T05:44:37.000Z', project: 'p632', event: 'inject', surface: 'per_prompt',
    entries: [{ id: 'ep-tier1', effective_priority: 8, rendered: 'imperative', source_scope: 'local', access_count_at_inject: 3 }],
  })
  const [row] = readLines(dir)
  const { valid, errors } = validateInstance(row, SCHEMA)
  assert.ok(valid, `tier-1 row must validate: ${JSON.stringify(errors)}`)
})

// (2) tier-2 entry (null effective_priority, null source_scope), surface: session_start —
// exercises the array-valued `type: ["integer","null"]` / `["string","null"]` branches.
t('schema::tier2NullFieldsValid', () => {
  const dir = mkTmp('tier2')
  appendActivationLine(dir, {
    ts: '2026-07-12T05:44:38.000Z', project: 'p632', event: 'inject', surface: 'session_start',
    entries: [{ id: 'ep-tier2', effective_priority: null, rendered: 'plain', source_scope: null, access_count_at_inject: 0 }],
  })
  const [row] = readLines(dir)
  const { valid, errors } = validateInstance(row, SCHEMA)
  assert.ok(valid, `tier-2 row (null effective_priority/source_scope) must validate: ${JSON.stringify(errors)}`)
})

// (3) surface: tool, multi-entry line (playbook-style entry mixed with a tier-1 entry).
t('schema::toolSurfaceMultiEntryValid', () => {
  const dir = mkTmp('tool')
  appendActivationLine(dir, {
    ts: '2026-07-12T05:44:39.000Z', project: 'p632', event: 'inject', surface: 'tool',
    entries: [
      { id: 'ep-a', effective_priority: 5, rendered: 'plain', source_scope: 'global', access_count_at_inject: 17 },
      { id: 'ep-playbook', effective_priority: 0, rendered: 'imperative', source_scope: 'local', access_count_at_inject: 0 },
    ],
  })
  const [row] = readLines(dir)
  assert.equal(row.entries.length, 2, 'both entries persisted')
  const { valid, errors } = validateInstance(row, SCHEMA)
  assert.ok(valid, `tool-surface multi-entry row must validate: ${JSON.stringify(errors)}`)
})

// (4) empty entries[] (writer permits it structurally; schema must not reject it — entries is
// `required` but not `minItems`-bounded).
t('schema::emptyEntriesArrayValid', () => {
  const dir = mkTmp('empty')
  appendActivationLine(dir, {
    ts: '2026-07-12T05:44:40.000Z', project: 'p632', event: 'inject', surface: 'per_prompt',
    entries: [],
  })
  const [row] = readLines(dir)
  const { valid, errors } = validateInstance(row, SCHEMA)
  assert.ok(valid, `empty-entries row must validate: ${JSON.stringify(errors)}`)
})

// (5) negative case: a captured VALID row, mutated, must FAIL validation. Multiple mutation axes
// in one test — each independently must flip `valid` to false (fail-closed teeth, not a vacuous
// single check).
t('schema::mutatedRowFailsValidation', () => {
  const dir = mkTmp('negative')
  appendActivationLine(dir, {
    ts: '2026-07-12T05:44:41.000Z', project: 'p632', event: 'inject', surface: 'per_prompt',
    entries: [{ id: 'ep-neg', effective_priority: 5, rendered: 'imperative', source_scope: 'local', access_count_at_inject: 0 }],
  })
  const [row] = readLines(dir)
  assert.ok(validateInstance(row, SCHEMA).valid, 'sanity: the captured row itself is valid before mutation')

  const wrongVersion = { ...row, v: 2 }
  assert.equal(validateInstance(wrongVersion, SCHEMA).valid, false, 'v !== 1 (const violation) must fail')

  const wrongEvent = { ...row, event: 'other' }
  assert.equal(validateInstance(wrongEvent, SCHEMA).valid, false, 'event !== "inject" (const violation) must fail')

  const missingProject = { ...row }
  delete missingProject.project
  assert.equal(validateInstance(missingProject, SCHEMA).valid, false, 'missing required `project` must fail')

  const badSurface = { ...row, surface: 'not-a-real-surface' }
  assert.equal(validateInstance(badSurface, SCHEMA).valid, false, 'surface outside the enum must fail')

  const badEntryPriorityType = {
    ...row,
    entries: [{ ...row.entries[0], effective_priority: 'eight' }],
  }
  assert.equal(validateInstance(badEntryPriorityType, SCHEMA).valid, false, 'string effective_priority (not integer|null) must fail')

  const extraProperty = { ...row, unexpected_field: 'nope' }
  assert.equal(validateInstance(extraProperty, SCHEMA).valid, false, 'additionalProperties:false must reject an unmodeled top-level key')
})

console.log(`\n${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
