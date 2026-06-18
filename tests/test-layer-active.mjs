// test-layer-active.mjs — RFC-008 P4c.
//
// Covers the LAYER-WIDE enforcement kill switch (enforce-config.json
// {"active":false}) that every ec hook outside the 4 bp-001 gates honors:
//   (A) layerDisposition() — the PURE precedence algebra (M8 duplicate ⊐ active:false).
//   (B) `enforce-contract --layer-active --marker-root <abs>` CLI — the closed-token
//       contract: stdout is `inactive` ALONE, or empty (→ the caller keeps enforcing).
//       HOME-isolated planted contract + a marker-root carrying enforce-config.json,
//       mirroring test-resolve-gate.mjs B.
//   (C) F1 fold: `--session-start` skips ALL side-effects (baseline/sweeps/advisory)
//       on active:false; a schema-miss / active:true still RUNS them (fail-closed to
//       doing the work).
//
// Fail-closed is the load-bearing invariant: every failure branch (missing/relative
// --marker-root, M8 duplicate, type-confused active, garbage config, no config)
// emits NO token so the caller enforces (B1).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { layerDisposition } from '../scripts/enforce-contract.mjs'
import { BASELINE_NAME, PRIMARY_MARKER_DIR } from '../scripts/lib/marker-paths.mjs'

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

console.log('=== A: layerDisposition() pure precedence algebra ===')
// Baseline: enforcement on (the fail-closed default reached by loadEnforceConfig's identity).
eq('A1: active:true, no duplicate → active',
  layerDisposition({ duplicate: false, active: true }).token, 'active')
// Operator opt-out → inactive (the whole layer off).
eq('A2: active:false → inactive',
  layerDisposition({ duplicate: false, active: false }).token, 'inactive')
// M8 duplicate ⊐ active:false — a corrupt registry is NOT silenceable (byte-identical
// precedence to gateDisposition: duplicate REAL-blocks BEFORE the active:false silence).
eq('A3 (M8 ⊐ active): duplicate + active:false → block (NOT inactive)',
  layerDisposition({ duplicate: true, active: false }).token, 'block')
eq('A4: duplicate + active:true → block',
  layerDisposition({ duplicate: true, active: true }).token, 'block')

// ---------------------------------------------------------------------------
// B: CLI closed-token contract. HOME-isolated planted global contract; marker-root
// carries the enforce-config.json. stdout MUST be exactly `inactive` or empty.
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
function mkHome(label) { return fs.mkdtempSync(path.join(os.tmpdir(), `layer-home-${label}-`)) }
function mkMarkerRoot(label, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `layer-mr-${label}-`))
  if (config !== undefined) {
    fs.mkdirSync(path.join(root, '.episodic-memory'), { recursive: true })
    fs.writeFileSync(path.join(root, '.episodic-memory', 'enforce-config.json'),
      typeof config === 'string' ? config : JSON.stringify(config))
  }
  return root
}
function layerActive(markerRoot, home, extraArgs = []) {
  const args = [ENFORCE, '--layer-active', ...(markerRoot !== null ? ['--marker-root', markerRoot] : []), ...extraArgs]
  const r = spawnSync('node', args, { encoding: 'utf8', env: { ...process.env, HOME: home } })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

console.log('')
console.log('=== B: --layer-active CLI closed-token contract ===')
// B1 (D4) — active:false → exactly "inactive".
{
  const home = mkHome('b1'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b1', { active: false })
  const r = layerActive(mr, home)
  eq('B1 (D4): active:false → stdout "inactive" (alone)', r.stdout.trim(), 'inactive')
  eq('B1: exit 0', r.status, 0)
}
// B2 — anti-vacuous: active:true → empty (enforce). Proves "inactive" is not always emitted.
{
  const home = mkHome('b2'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b2', { active: true })
  const r = layerActive(mr, home)
  eq('B2 (anti-vacuous): active:true → empty (enforce)', r.stdout.trim(), '')
}
// B3 (D1) — no config → empty (enforce).
{
  const home = mkHome('b3'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b3') // no config file
  const r = layerActive(mr, home)
  eq('B3 (D1): no enforce-config.json → empty (enforce)', r.stdout.trim(), '')
}
// B4 (D2) — garbage config → empty (enforce).
{
  const home = mkHome('b4'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b4', '{not json')
  const r = layerActive(mr, home)
  eq('B4 (D2): garbage enforce-config.json → empty (enforce)', r.stdout.trim(), '')
}
// B5 (D3) — type-confused active values are schema-invalid → identity active:true → empty.
for (const [label, raw] of [['string "false"', '{"active":"false"}'], ['number 0', '{"active":0}'], ['null', '{"active":null}']]) {
  const home = mkHome('b5'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b5', raw)
  const r = layerActive(mr, home)
  eq(`B5 (D3): active ${label} → schema-invalid → empty (enforce, NOT inactive)`, r.stdout.trim(), '')
}
// B6 (D6) — missing --marker-root → empty + exit 0 (fail-closed).
{
  const home = mkHome('b6'); plantGlobalContract(home, {})
  const r = layerActive(null, home)
  eq('B6 (D6): missing --marker-root → empty stdout', r.stdout.trim(), '')
  eq('B6: exit 0', r.status, 0)
}
// B7 (D6) — relative --marker-root → empty (must be absolute).
{
  const home = mkHome('b7'); plantGlobalContract(home, {})
  const r = layerActive('relative/path', home)
  eq('B7 (D6): relative --marker-root → empty stdout', r.stdout.trim(), '')
}
// B8 (D5) — M8 duplicate registry + active:false → empty (block, NOT silenceable).
{
  const home = mkHome('b8')
  const dup = REPO_REGISTRY.plugins[0]
  plantGlobalContract(home, { registry: { schema_version: '1.0.0', plugins: [dup, { ...dup }] } })
  const mr = mkMarkerRoot('b8', { active: false })
  const r = layerActive(mr, home)
  eq('B8 (D5): M8 duplicate + active:false → empty (corrupt install not silenceable)', r.stdout.trim(), '')
}
// B9 — the token is emitted ALONE (no diagnostic on stdout). Guards the exact-equality
// match used by the bash + node callers: a multi-line / decorated stdout would break it.
{
  const home = mkHome('b9'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('b9', { active: false })
  const r = layerActive(mr, home)
  eq('B9: stdout is exactly "inactive\\n" (token alone, diagnostics on stderr)', r.stdout, 'inactive\n')
  if (r.stderr.length > 0) ok('B9: notice present on stderr (not stdout)')
  else bad('B9: notice present on stderr', 'expected a stderr notice')
}

// ---------------------------------------------------------------------------
// C: F1 fold — `--session-start` honors the kill switch. active:false skips the
// baseline write (the dominant SessionStart cost); active:true RUNS it. Asserts the
// on-disk DIRECTION (baseline file presence), not an emission counter (D8).
// ---------------------------------------------------------------------------
console.log('')
console.log('=== C: --session-start F1 fold (D8) ===')
function gitInit(dir) { spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' }) }
function sessionStart(cwd, home) {
  return spawnSync('node', [ENFORCE, '--session-start'], { encoding: 'utf8', cwd, env: { ...process.env, HOME: home } })
}
function baselinePath(root) { return path.join(root, PRIMARY_MARKER_DIR, BASELINE_NAME) }

// C1 (D8) — active:false → NO baseline write + exit 0.
{
  const home = mkHome('c1'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('c1', { active: false }); gitInit(mr)
  const r = sessionStart(mr, home)
  eq('C1 (D8): --session-start active:false → exit 0', r.status, 0)
  eq('C1 (D8): active:false → baseline NOT written (side-effects skipped)', fs.existsSync(baselinePath(mr)), false)
}
// C2 — non-vacuous control: active:true (no config) → baseline IS written (proves the
// skip is genuine, not a fixture that never writes a baseline).
{
  const home = mkHome('c2'); plantGlobalContract(home, {})
  const mr = mkMarkerRoot('c2'); gitInit(mr) // no config → identity active:true
  const r = sessionStart(mr, home)
  eq('C2 (control): active:true → exit 0', r.status, 0)
  eq('C2 (control): active:true → baseline IS written (skip is non-vacuous)', fs.existsSync(baselinePath(mr)), true)
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
