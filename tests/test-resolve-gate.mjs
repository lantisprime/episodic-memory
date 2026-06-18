// test-resolve-gate.mjs — RFC-008 P4a.
//
// Covers the per-project enforce-config consult for the three pre_tool_use gates:
//   (A) gateDisposition() — the PURE per-gate resolution algebra (M8-before-active
//       F7, event-threaded F8, closed token vocab F5). No I/O.
//   (B) `enforce-contract --resolve-gate <gate> --marker-root <abs>` CLI — the
//       closed-token contract: stdout is `silence` | `clamp-off` ALONE, or empty
//       (→ the bash gate keeps blocking). HOME-isolated planted contract + a
//       marker-root carrying enforce-config.json, mirroring test-enforce-contract D.
//
// Fail-closed is the load-bearing invariant: every failure branch (bad gate name,
// missing/relative --marker-root, M8 duplicate, type-confused active, garbage
// config, unknown tier, no config) emits NO token so the gate enforces (B1).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { gateDisposition } from '../scripts/enforce-contract.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENFORCE = path.join(REPO, 'scripts', 'enforce-contract.mjs')

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function eq(name, actual, expected) {
  if (actual === expected) ok(name)
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// events.json pre_tool_use action grid: STRONG=block, MEDIUM=warn, WEAK=inject.
const EVENTS = {
  events: [
    { id: 'pre_tool_use', actions: { STRONG: { id: 'block' }, MEDIUM: { id: 'warn' }, WEAK: { id: 'inject' } } },
  ],
}

console.log('=== A: gateDisposition() pure algebra ===')
// Baseline: STRONG harness ∩ STRONG contract, no clamp → enforce (gate blocks).
eq('A1: STRONG cap + STRONG contract + no config → enforce',
  gateDisposition({ duplicate: false, harnessCap: 'STRONG', contractTier: 'STRONG', active: true, configTier: null, events: EVENTS, event: 'pre_tool_use' }).token, 'enforce')
// active:false → silence.
eq('A2: active:false → silence',
  gateDisposition({ duplicate: false, harnessCap: 'STRONG', contractTier: 'STRONG', active: false, configTier: null, events: EVENTS, event: 'pre_tool_use' }).token, 'silence')
// WEAK config clamp → action inject → clamp-off.
eq('A3: config WEAK → clamp-off',
  gateDisposition({ duplicate: false, harnessCap: 'STRONG', contractTier: 'STRONG', active: true, configTier: 'WEAK', events: EVENTS, event: 'pre_tool_use' }).token, 'clamp-off')
// MEDIUM config clamp → action warn → clamp-off.
eq('A4: config MEDIUM → clamp-off',
  gateDisposition({ duplicate: false, harnessCap: 'STRONG', contractTier: 'STRONG', active: true, configTier: 'MEDIUM', events: EVENTS, event: 'pre_tool_use' }).token, 'clamp-off')
// F7 — M8 duplicate forces block BEFORE active:false (corrupt install not silenceable).
eq('A5 (F7): duplicate + active:false → block (M8 precedes silence)',
  gateDisposition({ duplicate: true, harnessCap: 'STRONG', contractTier: 'STRONG', active: false, configTier: 'WEAK', events: EVENTS, event: 'pre_tool_use' }).token, 'block')
// Unknown tier never lowers (clampTier fail-closed) → STRONG → enforce.
eq('A6: unknown tier config "LOOSE" → enforce (no lower)',
  gateDisposition({ duplicate: false, harnessCap: 'STRONG', contractTier: 'STRONG', active: true, configTier: 'LOOSE', events: EVENTS, event: 'pre_tool_use' }).token, 'enforce')
// clamp-UP ignored: config STRONG when base STRONG → enforce.
eq('A7: config STRONG (no-op, never raises) → enforce',
  gateDisposition({ duplicate: false, harnessCap: 'STRONG', contractTier: 'STRONG', active: true, configTier: 'STRONG', events: EVENTS, event: 'pre_tool_use' }).token, 'enforce')
// events.json unresolved (null) → action '—' → fail-closed enforce even with a WEAK clamp.
eq('A8: events null + WEAK clamp → enforce (fail-closed; clamp inert without events)',
  gateDisposition({ duplicate: false, harnessCap: 'STRONG', contractTier: 'STRONG', active: true, configTier: 'WEAK', events: null, event: 'pre_tool_use' }).token, 'enforce')
// B1: all sources null (resolution miss) + no config → base STRONG → enforce.
eq('A9: all sources null + no config → enforce (B1 base-STRONG)',
  gateDisposition({ duplicate: false, harnessCap: null, contractTier: null, active: true, configTier: null, events: EVENTS, event: 'pre_tool_use' }).token, 'enforce')
// B1: contract STRONG + missing harness cap (null) + WEAK clamp → effTier WEAK → clamp-off
// (a legit operator downgrade still works even when the registry cap is absent).
eq('A10: null harnessCap + STRONG contract + WEAK clamp → clamp-off',
  gateDisposition({ duplicate: false, harnessCap: null, contractTier: 'STRONG', active: true, configTier: 'WEAK', events: EVENTS, event: 'pre_tool_use' }).token, 'clamp-off')

// ---------------------------------------------------------------------------
// B: CLI closed-token contract. HOME-isolated planted global contract; marker-root
// carries the enforce-config.json. stdout MUST be exactly the token or empty.
// ---------------------------------------------------------------------------
const REPO_BP001 = JSON.parse(fs.readFileSync(path.join(REPO, 'patterns', 'bp-001.json'), 'utf8'))
const REPO_EVENTS = JSON.parse(fs.readFileSync(path.join(REPO, 'patterns', 'events.json'), 'utf8'))
const REPO_CONFIG_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'patterns', 'enforce-config.schema.json'), 'utf8'))
const REPO_REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', '_index.json'), 'utf8'))

function plantGlobalContract(home, { registry, bp001, events, configSchema } = {}) {
  const pat = path.join(home, '.episodic-memory', 'patterns')
  const plug = path.join(home, '.episodic-memory', 'plugins')
  fs.mkdirSync(pat, { recursive: true })
  fs.mkdirSync(plug, { recursive: true })
  if (bp001 !== null) fs.writeFileSync(path.join(pat, 'bp-001.json'), JSON.stringify(bp001 || REPO_BP001))
  if (events !== null) fs.writeFileSync(path.join(pat, 'events.json'), JSON.stringify(events || REPO_EVENTS))
  if (configSchema !== null) fs.writeFileSync(path.join(pat, 'enforce-config.schema.json'), JSON.stringify(configSchema || REPO_CONFIG_SCHEMA))
  if (registry !== null) fs.writeFileSync(path.join(plug, '_index.json'), JSON.stringify(registry || REPO_REGISTRY))
}
function mkHome(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `resolve-home-${label}-`)) }
function mkMarkerRoot(label, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `resolve-mr-${label}-`))
  if (config !== undefined) {
    fs.mkdirSync(path.join(root, '.episodic-memory'), { recursive: true })
    fs.writeFileSync(path.join(root, '.episodic-memory', 'enforce-config.json'),
      typeof config === 'string' ? config : JSON.stringify(config))
  }
  return root
}
function resolve(gate, markerRoot, home, extraArgs = []) {
  const args = [ENFORCE, '--resolve-gate', gate, ...(markerRoot !== null ? ['--marker-root', markerRoot] : []), ...extraArgs]
  const r = spawnSync('node', args, { encoding: 'utf8', env: { ...process.env, HOME: home } })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

console.log('')
console.log('=== B: --resolve-gate CLI closed-token contract ===')
// B1 — active:false → exactly "silence".
{
  const home = mkHome('b1'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b1', { active: false })
  const r = resolve('pre_checkpoint', mr, home)
  eq('B1: active:false → stdout "silence" (alone)', r.stdout.trim(), 'silence')
  eq('B1: exit 0', r.status, 0)
}
// B2 — per-gate WEAK clamp → exactly "clamp-off".
{
  const home = mkHome('b2'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b2', { 'bp-001': { post_checkpoint: 'WEAK' } })
  const r = resolve('post_checkpoint', mr, home)
  eq('B2: post_checkpoint WEAK → stdout "clamp-off"', r.stdout.trim(), 'clamp-off')
}
// B3 — SPLICE (F8): the same WEAK post_checkpoint clamp leaves plan_approval enforcing.
{
  const home = mkHome('b3'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b3', { 'bp-001': { post_checkpoint: 'WEAK' } })
  const r = resolve('plan_approval', mr, home)
  eq('B3 (splice): plan_approval under post_checkpoint clamp → empty (enforce)', r.stdout.trim(), '')
}
// B4 — no config → empty (enforce).
{
  const home = mkHome('b4'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b4') // no config file
  const r = resolve('plan_approval', mr, home)
  eq('B4: no enforce-config.json → empty (enforce)', r.stdout.trim(), '')
}
// B5 — invalid gate name → empty + exit 0 (fail-closed).
{
  const home = mkHome('b5'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b5', { active: false })
  const r = resolve('bogus_gate', mr, home)
  eq('B5: invalid gate name → empty stdout', r.stdout.trim(), '')
  eq('B5: invalid gate name → exit 0', r.status, 0)
}
// B6 — missing --marker-root → empty (fail-closed).
{
  const home = mkHome('b6'); plantGlobalContract(home, {})
  const r = resolve('plan_approval', null, home)
  eq('B6: missing --marker-root → empty stdout', r.stdout.trim(), '')
}
// B7 — relative --marker-root → empty (fail-closed; must be absolute).
{
  const home = mkHome('b7'); plantGlobalContract(home, {})
  const r = resolve('plan_approval', 'relative/path', home)
  eq('B7: relative --marker-root → empty stdout', r.stdout.trim(), '')
}
// B8 (F7) — M8 duplicate registry + active:false config → empty (block, NOT silenceable).
{
  const home = mkHome('b8')
  const dup = REPO_REGISTRY.plugins[0]
  plantGlobalContract(home, { registry: { schema_version: '1.0.0', plugins: [dup, { ...dup }] } })
  const mr = mkMarkerRoot('b8', { active: false })
  const r = resolve('pre_checkpoint', mr, home)
  eq('B8 (F7): M8 duplicate + active:false → empty (corrupt install not silenceable)', r.stdout.trim(), '')
}
// B9 — type-confused active values are schema-invalid → identity active:true → empty.
for (const [label, raw] of [['string "false"', '{"active":"false"}'], ['number 0', '{"active":0}'], ['null', '{"active":null}']]) {
  const home = mkHome('b9'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b9', raw)
  const r = resolve('pre_checkpoint', mr, home)
  eq(`B9: active ${label} → schema-invalid → empty (enforce, NOT silence)`, r.stdout.trim(), '')
}
// B10 — garbage config file → empty (enforce).
{
  const home = mkHome('b10'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b10', '{not json')
  const r = resolve('plan_approval', mr, home)
  eq('B10: garbage enforce-config.json → empty (enforce)', r.stdout.trim(), '')
}
// B11 — unknown tier string in config → never lowers → empty (enforce).
{
  const home = mkHome('b11'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b11', { 'bp-001': { plan_approval: 'LOOSE' } })
  const r = resolve('plan_approval', mr, home)
  // 'LOOSE' fails the schema tier enum → whole config schema-invalid → identity → enforce.
  eq('B11: unknown tier "LOOSE" → schema-invalid → empty (enforce)', r.stdout.trim(), '')
}
// B12 — the token is emitted ALONE (no diagnostic on stdout). Guards the bash
// exact-equality match: a multi-line / decorated stdout would break it.
{
  const home = mkHome('b12'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b12', { active: false })
  const r = resolve('pre_checkpoint', mr, home)
  eq('B12: stdout is exactly "silence\\n" (token alone, diagnostics on stderr)', r.stdout, 'silence\n')
  if (r.stderr.length > 0) ok('B12: notice present on stderr (not stdout)')
  else bad('B12: notice present on stderr', 'expected a stderr notice')
}

console.log('')
if (fail === 0) {
  console.log(`PASS — ${pass} checks`)
  process.exit(0)
} else {
  console.log(`FAIL — ${fail} of ${pass + fail} checks`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
