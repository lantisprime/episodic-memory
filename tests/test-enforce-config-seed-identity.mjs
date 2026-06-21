#!/usr/bin/env node
// test-enforce-config-seed-identity.mjs — RFC-008 P4d S6 (REQ-7; parents R5, R3).
//
// COUPLING GUARD. The install seed (ENFORCE_CONFIG_SEED — the EXACT bytes
// install.mjs writes into a new <project>/.episodic-memory/enforce-config.json)
// must normalize, through loadEnforceConfig, to the SAME load-bearing `active`
// disposition as the absent-file IDENTITY {active:true,bps:{}}. If the seed and
// the fail-closed default ever silently diverge — someone flips the seed to
// active:false, or changes the identity default — enforcement would mean
// different things for a freshly-seeded project than for one with no file at all,
// exactly the drift Rule 14 forbids. The seed is single-sourced in
// install-manifest.mjs so this test and install.mjs bind the SAME literal (a test
// holding its own copy would be a tautology).
//
// SEMANTIC, not byte: the seed bytes `{active:true}` can never byte-equal the
// object {active:true,bps:{}}, so the compare is on the `active` field that
// actually decides enforce-ON vs OFF (F4/BL-2). The normalizer is not
// reimplemented here — the guard rides the real loadEnforceConfig. No migration
// of existing seeded files (non-goal); this covers NEW seeds only.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

import { loadEnforceConfig } from '../scripts/enforce-contract.mjs'
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs'
import { ENFORCE_CONFIG_SEED } from '../scripts/lib/install-manifest.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'patterns', 'enforce-config.schema.json'), 'utf8'))

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) ok(name); else bad(name, `expected ${e}, got ${a}`)
}
function truthy(name, v, detail) { if (v) ok(name); else bad(name, detail || 'expected truthy') }

// Write `raw` to <root>/.episodic-memory/enforce-config.json (undefined ⇒ absent),
// then read it back through the REAL loadEnforceConfig — the exact write+read+
// normalize path install.mjs (write side) and the runtime gate (read side)
// traverse. resolveSeed(undefined) reproduces the absent-file fail-closed default.
function resolveSeed(raw) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-identity-'))
  fs.mkdirSync(path.join(root, '.episodic-memory'), { recursive: true })
  if (raw !== undefined) fs.writeFileSync(path.join(root, '.episodic-memory', 'enforce-config.json'), raw)
  return loadEnforceConfig(root, SCHEMA)
}

console.log('=== RFC-008 P4d S6 — seed↔identity coupling guard (REQ-7) ===')

// The absent-file identity: the fail-closed default every miss resolves to. Pin it
// explicitly — if THIS drifts, the whole guard is comparing against the wrong thing.
const IDENTITY = resolveSeed(undefined)
eq('identity (absent file) is {active:true,bps:{}}', IDENTITY, { active: true, bps: {} })

// (a) The seed must be HONOR-ABLE, not silently fail-closed. A malformed or schema-
// invalid seed resolves to identity {active:true} INSIDE loadEnforceConfig, which
// would make the `active` compare in (b) pass for the WRONG reason. This pin proves
// the seed satisfies the same predicates loadEnforceConfig's honored branch needs
// (well-formed JSON + plain object + schema-valid). It does NOT by itself observe
// that the loader took the honored branch — the negative control (c) does that, by
// proving the load path actually READS `active`. Pin + (c) together rule out the
// "both fell through to identity" false pass.
{
  let parsed = null
  let parseOk = true
  try { parsed = JSON.parse(ENFORCE_CONFIG_SEED) } catch { parseOk = false }
  truthy('seed is well-formed JSON', parseOk, `not parseable: ${JSON.stringify(ENFORCE_CONFIG_SEED)}`)
  truthy('seed is a plain object', parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'seed is not a plain object')
  truthy('seed is schema-valid (honored, not fail-closed)', parseOk && validateInstance(parsed, SCHEMA).valid, 'seed fails the enforce-config schema → would fail-closed to identity')
}

// (b) t_seed_matches_identity (PRIMARY): the real seed, normalized through the SAME
// loadEnforceConfig path, has the same `active` disposition as the absent-file
// identity. Compare on `active` only (REQ-7: ignore the bps shape).
{
  const seeded = resolveSeed(ENFORCE_CONFIG_SEED)
  eq('t_seed_matches_identity: seeded.active === identity.active', seeded.active, IDENTITY.active)
}

// (c) t_guard_red_on_divergence (NEGATIVE CONTROL): a seed whose `active` diverges
// from the identity MUST be distinguished — the guard predicate goes red. This
// doubles as proof the load path actually READS `active`: if loadEnforceConfig
// always returned identity, a flipped seed would still report active:true and this
// assertion would fail. Red-then-green.
{
  const divergent = resolveSeed('{\n  "active": false\n}\n')
  truthy('t_guard_red_on_divergence: active:false seed distinguished from identity', divergent.active !== IDENTITY.active, 'a divergent seed was NOT distinguished from identity — the guard is blind')
}

console.log('')
if (fail > 0) {
  console.log(`FAIL — ${pass} passed, ${fail} failed`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log(`PASS — ${pass}/${pass} checks passed`)
