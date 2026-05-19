#!/usr/bin/env node
/**
 * test-plugin-json.mjs — slice 2f plugin.json shape + filter parity tests.
 *
 * Coverage:
 *   PJ1  .claude-plugin/plugin.json exists and parses as JSON
 *   PJ2  required top-level fields: name, version, scheduled-tasks, slash-commands
 *   PJ3  scheduled-tasks: T1 (bp1-deadline-tick) + T1b (bp1-naked-entry-sweep)
 *        present; T2 (security-audit-weekly) NOT in slice 2f
 *   PJ4  slash-commands: /bp1-auto entry present with stub command
 *   PJ5  bp1-auto-stub.mjs exists, runs, exits 2 with inert message
 *   PJ6  manifest filter (bp1-manifest.mjs) sees all bp1 entries (filter
 *        parity — artifact-version-hash deterministic over filtered subset)
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PLUGIN_PATH = path.join(REPO, '.claude-plugin', 'plugin.json')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// =============================================================================
// PJ1 plugin.json exists + parses
// =============================================================================
tap('PJ1 .claude-plugin/plugin.json exists and parses as JSON', () => {
  assert.ok(fs.existsSync(PLUGIN_PATH), `expected ${PLUGIN_PATH} to exist`)
  const raw = fs.readFileSync(PLUGIN_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  assert.ok(parsed && typeof parsed === 'object')
})

// =============================================================================
// PJ2 required top-level fields
// =============================================================================
tap('PJ2 top-level shape: name, version, scheduled-tasks, slash-commands', () => {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_PATH, 'utf8'))
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.name, 'episodic-memory')
  assert.equal(typeof plugin.version, 'string')
  assert.ok(Array.isArray(plugin['scheduled-tasks']))
  assert.ok(Array.isArray(plugin['slash-commands']))
})

// =============================================================================
// PJ3 scheduled-tasks (T1, T1b) — T2 not in slice 2f
// =============================================================================
tap('PJ3 scheduled-tasks: bp1-deadline-tick + bp1-naked-entry-sweep present; T2 absent', () => {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_PATH, 'utf8'))
  const tasks = plugin['scheduled-tasks']
  const names = tasks.map(t => t.name)
  assert.ok(names.includes('bp1-deadline-tick'), `T1 bp1-deadline-tick missing; have: ${names.join(', ')}`)
  assert.ok(names.includes('bp1-naked-entry-sweep'), `T1b bp1-naked-entry-sweep missing; have: ${names.join(', ')}`)
  assert.equal(names.includes('bp1-security-audit-weekly'), false,
    'T2 bp1-security-audit-weekly must NOT be in slice 2f (M6 deliverable)')
  const t1 = tasks.find(t => t.name === 'bp1-deadline-tick')
  assert.equal(t1.cron, '*/5 * * * *')
  assert.equal(t1.command, 'node')
  assert.ok(t1.args.includes('check-deadlines'))
  const t1b = tasks.find(t => t.name === 'bp1-naked-entry-sweep')
  assert.equal(t1b.cron, '*/1 * * * *')
  assert.ok(t1b.args.includes('sweep-naked-entries'))
})

// =============================================================================
// PJ4 slash-commands: /bp1-auto
// =============================================================================
tap('PJ4 slash-commands: bp1-auto stub entry', () => {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_PATH, 'utf8'))
  const cmds = plugin['slash-commands']
  const bp1Auto = cmds.find(c => c.name === 'bp1-auto')
  assert.ok(bp1Auto, 'bp1-auto slash command must be registered')
  assert.equal(bp1Auto.command, 'node')
  assert.ok(bp1Auto.args.some(a => a.endsWith('bp1-auto-stub.mjs')))
})

// =============================================================================
// PJ5 bp1-auto-stub.mjs exists + runs
// =============================================================================
tap('PJ5 bp1-auto-stub.mjs exits 2 with inert message', () => {
  const STUB = path.join(REPO, 'scripts', 'bp1-auto-stub.mjs')
  assert.ok(fs.existsSync(STUB), `expected ${STUB}`)
  const r = spawnSync('node', [STUB], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /BP-1 auto-pilot inert/)
  assert.match(r.stderr, /M5/)
})

// =============================================================================
// PJ6 manifest filter parity
// =============================================================================
tap('PJ6 bp1-manifest filter picks up all bp1 entries from plugin.json', async () => {
  // collectPluginEntries (or whatever the manifest module exposes) is the
  // function used to compute the artifact-version-hash. If a new bp1 entry
  // is added without matching the filter, the activation flip breaks.
  // We approximate the contract here by re-asserting both names match /bp1/i
  // (scheduled-tasks) and /^bp1-/ (slash-commands), which is what
  // scripts/lib/bp1-manifest.mjs:116-127 filters on.
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_PATH, 'utf8'))
  for (const t of plugin['scheduled-tasks']) {
    assert.match(JSON.stringify(t), /bp1/i,
      `scheduled-task ${t.name} must match the manifest filter /bp1/i`)
  }
  for (const c of plugin['slash-commands']) {
    assert.match(c.name, /^bp1-/,
      `slash-command ${c.name} must match the manifest filter /^bp1-/`)
  }
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
