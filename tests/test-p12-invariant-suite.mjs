#!/usr/bin/env node
/**
 * test-p12-invariant-suite.mjs - RFC-008 P4d S8 (REQ-10, REQ-11).
 *
 * The Principle-12 invariant meta-runner: ONE code-defined gate that runs every
 * P12 invariant test and exits non-zero if ANY of them fails. Membership lives
 * HERE, in code (Rule 14), not as scattered CI YAML steps that can be dropped
 * silently (Rule 13). This file is promoted to a separately-named REQUIRED CI
 * job (p12-invariant-gate) so a regression in any P12 invariant blocks merge.
 *
 * PRINCIPLES.md SS12 ("Enforcement is per-project; the substrate is global") is
 * the governing principle; its "Test this" clause enumerates the invariants.
 * Each member below maps to one of them or to a P4d slice that hardens it.
 *
 * MEMBERSHIP (REQ-10) = glob(tests/test-p12-*.mjs) UNION the EXPLICIT set below,
 * minus this runner (and any sibling meta-runner). The glob captures
 * filename-prefixed members (test-p12-global-clean.mjs) and lets a NEW P12 test
 * auto-join by naming convention. The EXPLICIT set bridges the P12 invariant
 * tests that pre-date the test-p12- convention; each carries a one-line rationale
 * tying it to SS12 or a P4d slice. Meta-runner exclusion is mandatory: this
 * file's own name matches the glob, and a member that is itself a meta-runner
 * (this file, or a duplicated *-invariant-suite*) would make the runner spawn
 * itself forever, so meta-runner basenames are excluded from membership.
 *
 * t_membership_complete (REQ-10 / BL-6 / N4): membership is re-derived the same
 * way, the runner is asserted absent from its own member set, and every member
 * file is asserted present on disk, so a member renamed or removed from either
 * source fails the gate instead of silently dropping.
 *
 * t_runner_fails_on_member_failure (REQ-11): a negative control. Re-invoked with
 * P12_INJECT_FAIL=1, the runner runs a synthetic always-failing member through
 * the same status-checking path and must exit non-zero, proving a failing member
 * actually propagates to the gate (red-then-green).
 *
 * Zero deps. Node stdlib only.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SELF = fileURLToPath(import.meta.url)
const SELF_BASENAME = path.basename(SELF)
const testsDir = path.dirname(SELF)

// P12 invariant tests that pre-date the `test-p12-` filename convention. Each
// maps to a PRINCIPLES.md SS12 "Test this" clause or the P4d slice that added it.
const EXPLICIT = [
  // P4d S1 / SS12: substrate hook-independence; global AND project settings carry
  // ZERO enforcement gates (A0-A3, A1g, A1p); em-* round-trips work hook-free.
  'test-activation-scoping-e2e.mjs',
  // SS12: the enforcement set deploys ONLY under <project>/.claude/ (the
  // contract set + plugins index land per-project, never in global scope).
  'test-install-contract-deploy.mjs',
  // P4d S4: a seeded enforce-config.json toggles the REAL deployed gate hook
  // block <-> allow, so the per-project switch is load-bearing end to end.
  'test-s4-gate-e2e.mjs',
  // P4d ESC: gates block ONLY repo-source writes; episodes / reads / plan files
  // / off-repo writes are allowed; per-project, with no global touch.
  'test-enforcement-scope.mjs',
  // P4d S5 / SS12: the per-project uninstall round-trip, core+enforce+uninstall
  // == core install (both over-removal and under-removal fail it).
  'test-uninstall-enforcement.mjs',
  // P4d S6: the install seed literal normalizes to the same `active` as
  // loadEnforceConfig's absent-file identity (no silent default divergence).
  'test-enforce-config-seed-identity.mjs',
]

// The SINGLE source of truth for membership (REQ-10), derived in code. Self is
// excluded: SELF_BASENAME matches the test-p12-*.mjs glob, and including it
// would recurse forever.
function deriveMembers() {
  // Glob the test-p12-*.mjs members, excluding this runner itself AND any other
  // meta-runner-shaped file (a duplicated/templated *-invariant-suite*): a suite
  // that listed a sibling suite as a member would mutually recurse and fork-bomb.
  // Only leaf invariant tests are members. (`includes('invariant-suite')` already
  // excludes SELF_BASENAME; the explicit SELF check is kept as defense in depth
  // in case this runner is ever renamed.)
  const globbed = fs
    .readdirSync(testsDir)
    .filter((f) => /^test-p12-.*\.mjs$/.test(f) && f !== SELF_BASENAME && !f.includes('invariant-suite'))
  return [...new Set([...globbed, ...EXPLICIT])].sort()
}

const P12_MEMBERS = deriveMembers()

// Run member test files as `node <file>` subprocesses (stdio inherited so their
// output is visible). Returns true if ANY exited non-zero. When injectFail is
// set, run a synthetic always-failing member through the SAME status-checking
// path (REQ-11 negative control).
function runMembers(members, { injectFail = false } = {}) {
  let anyFailed = false
  for (const f of members) {
    const r = spawnSync('node', [path.join(testsDir, f)], { stdio: 'inherit' })
    if (r.status !== 0) {
      anyFailed = true
      console.error(`  x P12 member FAILED: ${f} (exit ${r.status})`)
    }
  }
  if (injectFail) {
    const r = spawnSync('node', ['-e', 'process.exit(1)'], { stdio: 'inherit' })
    if (r.status !== 0) anyFailed = true
  }
  return anyFailed
}

// ---------------------------------------------------------------------------
// Negative-control mode (REQ-11). When P12_INJECT_FAIL=1, run ONLY a synthetic
// failing member through the shared runMembers() status check and exit
// non-zero. This branch runs FIRST so the re-invocation from
// t_runner_fails_on_member_failure never recurses into the meta-tests and never
// re-runs the real (heavy E2E) members.
// ---------------------------------------------------------------------------
if (process.env.P12_INJECT_FAIL === '1') {
  process.exit(runMembers([], { injectFail: true }) ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Normal mode: the two meta-tests, then the real P12 member run.
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  + ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  x ${name}: ${e.message}`)
  }
}

console.log('# test-p12-invariant-suite (RFC-008 P4d S8 - Principle 12 invariant gate)')
console.log(`# members (${P12_MEMBERS.length}): ${P12_MEMBERS.join(', ')}`)

test('t_membership_complete: membership re-derives identically, excludes self, every member exists', () => {
  // Re-derive the canonical set the same way and assert P12_MEMBERS matches it
  // (guards against P12_MEMBERS drifting from the derivation).
  assert.deepStrictEqual(P12_MEMBERS, deriveMembers())
  // Pin the hand-maintained EXPLICIT half against an INDEPENDENT literal.
  // deriveMembers()-vs-deriveMembers() is a tautology for the EXPLICIT source, so
  // a member silently deleted from the EXPLICIT array (its file left on disk)
  // would otherwise drop out of the gate unnoticed. Adding or removing an EXPLICIT
  // member is now a conscious two-place edit. (glob members still auto-join.)
  assert.deepStrictEqual([...EXPLICIT].sort(), [
    'test-activation-scoping-e2e.mjs',
    'test-enforce-config-seed-identity.mjs',
    'test-enforcement-scope.mjs',
    'test-install-contract-deploy.mjs',
    'test-s4-gate-e2e.mjs',
    'test-uninstall-enforcement.mjs',
  ])
  // The runner must never list itself, nor any sibling meta-runner (mutual
  // recursion / fork-bomb guard).
  assert.ok(!P12_MEMBERS.includes(SELF_BASENAME), 'the suite must not include itself as a member')
  assert.ok(
    !P12_MEMBERS.some((f) => f.includes('invariant-suite')),
    'no member may be a meta-runner (invariant-suite): mutual-recursion guard',
  )
  // The glob must actually match the known prefixed member; a broken glob that
  // silently matches nothing is itself a P12 gate failure.
  assert.ok(
    P12_MEMBERS.includes('test-p12-global-clean.mjs'),
    'glob(test-p12-*.mjs) must include test-p12-global-clean.mjs',
  )
  // Every member file must exist on disk; a member renamed or deleted from
  // either source fails here instead of being silently skipped at run time.
  for (const f of P12_MEMBERS) {
    assert.ok(fs.existsSync(path.join(testsDir, f)), `P12 member missing on disk: ${f}`)
  }
})

test('t_runner_fails_on_member_failure: an injected failing member exits the runner non-zero', () => {
  const r = spawnSync('node', [SELF], {
    env: { ...process.env, P12_INJECT_FAIL: '1' },
    stdio: 'inherit',
  })
  assert.strictEqual(r.status, 1, 'runner must exit 1 when a member fails')
})

console.log(`\n# meta-tests: ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
}

// Run the real P12 invariant members.
console.log(`\n# running ${P12_MEMBERS.length} P12 invariant members ...`)
const membersFailed = runMembers(P12_MEMBERS)

if (failed > 0 || membersFailed) {
  console.error('\nP12 INVARIANT GATE: FAIL')
  process.exit(1)
}
console.log('\nP12 INVARIANT GATE: PASS')
