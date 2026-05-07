#!/usr/bin/env node
/**
 * test-bp1-probe.mjs — Hermetic tests for the scheduled-tasks capability probe.
 *
 * RFC-004 §550-577 (PR-1b-A). Three must-have scenarios from the Codex
 * plan-review consensus (round 1 Q4.2):
 *   1. M0 stub shape (5 fields, never returns 'native').
 *   2. Manifest drift (changing the probe helper changes artifact_version_hash).
 *   3. M1 placeholder contract (3 injectable outcomes pinned for M1's harness).
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

let pass = 0, fail = 0
function tap(name, fn) {
  const handle = (e) => {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      return out.then(() => { pass++; console.log(`ok ${pass + fail} - ${name}`) }, handle)
    }
    pass++
    console.log(`ok ${pass + fail} - ${name}`)
  } catch (e) { handle(e) }
}

const probe = await import('../scripts/lib/bp1-probe.mjs')

// =============================================================================
// Must-have #1: M0 stub shape
// =============================================================================
tap('M0 stub: returns capability=fallback (NEVER native)', () => {
  const r = probe.probeScheduledTasksCapability()
  assert.equal(r.capability, 'fallback')
  assert.notEqual(r.capability, 'native', 'M0 must never claim native')
})

tap('M0 stub: reason=m1_not_implemented', () => {
  const r = probe.probeScheduledTasksCapability()
  assert.equal(r.reason, 'm1_not_implemented')
})

tap('M0 stub: native_probe_performed=false', () => {
  const r = probe.probeScheduledTasksCapability()
  assert.equal(r.native_probe_performed, false)
})

tap('M0 stub: t2_fallback=false (RFC §573-575)', () => {
  const r = probe.probeScheduledTasksCapability()
  assert.equal(r.t2_fallback, false,
    'T2 weekly meta-audit has NO fallback path per RFC §573-575')
})

tap('M0 stub: degraded_mode_message is non-empty + mentions T2 manual fallback', () => {
  const r = probe.probeScheduledTasksCapability()
  assert.equal(typeof r.degraded_mode_message, 'string')
  assert.ok(r.degraded_mode_message.length > 0)
  assert.match(r.degraded_mode_message, /T2/, 'must mention T2')
  assert.match(r.degraded_mode_message, /bp1-security-audit\.mjs/,
    'must point operator at the manual fallback script')
})

tap('M0 stub: shape has exactly the 5 contract fields, no extras', () => {
  const r = probe.probeScheduledTasksCapability()
  const keys = Object.keys(r).sort()
  assert.deepEqual(keys, [
    'capability', 'degraded_mode_message',
    'native_probe_performed', 'reason', 't2_fallback',
  ])
})

tap('M0 stub: validateProbeResult passes the M0 shape', () => {
  const r = probe.probeScheduledTasksCapability()
  const v = probe.validateProbeResult(r)
  assert.equal(v.ok, true, `M0 shape must validate; errors: ${JSON.stringify(v.errors)}`)
})

// =============================================================================
// Must-have #3: M1 placeholder contract — pin three outcomes for M1's harness
// =============================================================================
tap('M1 contract: success outcome shape (capability=native, reason=list_succeeded)', () => {
  const synthetic = {
    capability: 'native', reason: 'list_succeeded',
    native_probe_performed: true, t2_fallback: false,
    degraded_mode_message: 'native; no degradation',
  }
  const v = probe.validateProbeResult(synthetic)
  assert.equal(v.ok, true, `errors: ${JSON.stringify(v.errors)}`)
})

tap('M1 contract: ToolNotFound outcome (capability=fallback, reason=tool_not_found)', () => {
  const synthetic = {
    capability: 'fallback', reason: 'tool_not_found',
    native_probe_performed: true, t2_fallback: false,
    degraded_mode_message: 'mcp__scheduled-tasks not registered',
  }
  const v = probe.validateProbeResult(synthetic)
  assert.equal(v.ok, true)
})

tap('M1 contract: schema_mismatch outcome (capability=fallback, reason=schema_mismatch)', () => {
  const synthetic = {
    capability: 'fallback', reason: 'schema_mismatch',
    native_probe_performed: true, t2_fallback: false,
    degraded_mode_message: 'list_scheduled_tasks returned unexpected shape',
  }
  const v = probe.validateProbeResult(synthetic)
  assert.equal(v.ok, true)
})

tap('M1 contract: connection_error outcome', () => {
  const synthetic = {
    capability: 'fallback', reason: 'connection_error',
    native_probe_performed: true, t2_fallback: false,
    degraded_mode_message: 'MCP server unreachable',
  }
  const v = probe.validateProbeResult(synthetic)
  assert.equal(v.ok, true)
})

tap('M1 contract: invalid capability rejected', () => {
  const v = probe.validateProbeResult({
    capability: 'maybe', reason: 'list_succeeded',
    native_probe_performed: true, t2_fallback: false,
    degraded_mode_message: 'x',
  })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => /capability must be one of/.test(e)))
})

tap('M1 contract: t2_fallback=true rejected (cannot subvert RFC §573-575)', () => {
  const v = probe.validateProbeResult({
    capability: 'native', reason: 'list_succeeded',
    native_probe_performed: true, t2_fallback: true,  // ← invalid
    degraded_mode_message: 'x',
  })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => /t2_fallback must be false/.test(e)))
})

tap('M1 contract: capability=native requires reason=list_succeeded AND native_probe_performed=true', () => {
  // capability=native + reason=tool_not_found → invalid
  const v1 = probe.validateProbeResult({
    capability: 'native', reason: 'tool_not_found',
    native_probe_performed: true, t2_fallback: false,
    degraded_mode_message: 'x',
  })
  assert.equal(v1.ok, false)
  assert.ok(v1.errors.some(e => /capability=native requires reason='list_succeeded'/.test(e)))

  // capability=native + native_probe_performed=false → invalid
  const v2 = probe.validateProbeResult({
    capability: 'native', reason: 'list_succeeded',
    native_probe_performed: false, t2_fallback: false,
    degraded_mode_message: 'x',
  })
  assert.equal(v2.ok, false)
  assert.ok(v2.errors.some(e => /native_probe_performed=true/.test(e)))
})

tap('M1 contract: VALID_REASONS_M1 enumeration is frozen', () => {
  assert.ok(Object.isFrozen(probe.VALID_REASONS_M1))
  assert.ok(probe.VALID_REASONS_M1.includes('list_succeeded'))
  assert.ok(probe.VALID_REASONS_M1.includes('tool_not_found'))
  assert.ok(probe.VALID_REASONS_M1.includes('connection_error'))
  assert.ok(probe.VALID_REASONS_M1.includes('schema_mismatch'))
  assert.ok(probe.VALID_REASONS_M1.includes('m1_not_implemented'))
})

// =============================================================================
// Must-have #2: Manifest drift — changing the probe helper changes the hash
// =============================================================================
tap('drift: changing scripts/lib/bp1-probe.mjs content changes artifact_version_hash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-probe-drift-'))
  execFileSync('git', ['init', '-q'], { cwd: tmp })
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true })
  // Copy the real builder + manifest lib + probe to the tmp project
  fs.copyFileSync(path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib', 'bp1-manifest.mjs'),
    path.join(tmp, 'scripts', 'lib', 'bp1-manifest.mjs'))
  // Initial probe content
  fs.writeFileSync(path.join(tmp, 'scripts', 'lib', 'bp1-probe.mjs'),
    'export function probeScheduledTasksCapability(){return{capability:"fallback"}}\n')
  const a = JSON.parse(execFileSync('node',
    [path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'), '--project', tmp, '--json'],
    { encoding: 'utf8' }))
  // Change probe content
  fs.writeFileSync(path.join(tmp, 'scripts', 'lib', 'bp1-probe.mjs'),
    'export function probeScheduledTasksCapability(){return{capability:"native"}}\n')
  const b = JSON.parse(execFileSync('node',
    [path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'), '--project', tmp, '--json'],
    { encoding: 'utf8' }))
  assert.notEqual(a.sha256, b.sha256,
    'changing scripts/lib/bp1-probe.mjs content MUST change artifact_version_hash ' +
    '(otherwise M1 swap of probe stub → real probe would not trigger bp1-flag-version-drift)')
})

tap('drift: changing scripts/lib/bp1-sweep.mjs content changes artifact_version_hash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-sweep-drift-'))
  execFileSync('git', ['init', '-q'], { cwd: tmp })
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib', 'bp1-manifest.mjs'),
    path.join(tmp, 'scripts', 'lib', 'bp1-manifest.mjs'))
  fs.writeFileSync(path.join(tmp, 'scripts', 'lib', 'bp1-sweep.mjs'),
    'export function scanForCandidates(){return{path_a_candidates:[],path_b_candidates:[],counts:{}}}\n')
  const a = JSON.parse(execFileSync('node',
    [path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'), '--project', tmp, '--json'],
    { encoding: 'utf8' }))
  fs.writeFileSync(path.join(tmp, 'scripts', 'lib', 'bp1-sweep.mjs'),
    'export function scanForCandidates(){return{path_a_candidates:[{}],path_b_candidates:[],counts:{}}}\n')
  const b = JSON.parse(execFileSync('node',
    [path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'), '--project', tmp, '--json'],
    { encoding: 'utf8' }))
  assert.notEqual(a.sha256, b.sha256)
})

tap('drift: a non-bp1 lib file (e.g. scripts/lib/foo.mjs) is NOT in the manifest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-non-bp1-lib-'))
  execFileSync('git', ['init', '-q'], { cwd: tmp })
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib', 'bp1-manifest.mjs'),
    path.join(tmp, 'scripts', 'lib', 'bp1-manifest.mjs'))
  fs.writeFileSync(path.join(tmp, 'scripts', 'lib', 'foo.mjs'), '// not bp1\n')
  const r = JSON.parse(execFileSync('node',
    [path.join(tmp, 'scripts', 'bp1-build-artifact-manifest.mjs'), '--project', tmp, '--json'],
    { encoding: 'utf8' }))
  const fooFound = r.manifest.scripts_lib.find(s => s.path === 'scripts/lib/foo.mjs')
  assert.equal(fooFound, undefined,
    'scripts_lib must scope to scripts/lib/bp1-*.mjs ONLY (closed glob)')
})

console.log(`\n1..${pass + fail}`)
if (fail) { console.log(`# FAILED ${fail} of ${pass + fail}`); process.exit(1) }
else console.log(`# PASSED ${pass}`)
