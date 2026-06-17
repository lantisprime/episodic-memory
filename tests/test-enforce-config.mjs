#!/usr/bin/env node
// test-enforce-config.mjs — RFC-008 P3b-2 (R5, P4 config schema folded).
//
// Two layers:
//   (U) loadEnforceConfig() unit matrix — the M2 fail-OPEN audit: EVERY error
//       branch lands in ONE stay-STRONG sink (identity clamp), so a broken/hostile/
//       absent config can NEVER weaken a gate. Plus the schema valid/invalid cases
//       + active:false.
//   (I) integration via the enforce-contract CLI: a successfully-resolved
//       {"bp-001":{"stop":"WEAK"}} clamp DEGRADES the decideStop refuse (allow);
//       a {"bp-001":{"post_checkpoint":"WEAK"}} clamp does NOT (deferred gate —
//       stop still blocks); active:false silences with an M4 stderr notice; a
//       well-formed stop downgrade emits the M4 audit line.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

import { loadEnforceConfig, decideStop } from '../scripts/enforce-contract.mjs'
import { PRIMARY_MARKER_DIR, LEGACY_MARKER_DIR, primaryMarkerPath } from '../scripts/lib/marker-paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ENFORCE = path.join(REPO, 'scripts', 'enforce-contract.mjs')
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

const IDENTITY = { active: true, bps: {} }

// Write a config under <root>/.episodic-memory/enforce-config.json (raw string so
// we can plant malformed bytes). Returns root.
function mkRootWithConfig(raw) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-config-'))
  fs.mkdirSync(path.join(root, '.episodic-memory'), { recursive: true })
  if (raw !== undefined) fs.writeFileSync(path.join(root, '.episodic-memory', 'enforce-config.json'), raw)
  return root
}

console.log('=== U: loadEnforceConfig fail-OPEN audit (every error branch → identity stay-STRONG) ===')

// (0) no schema → cannot validate → fail-closed identity.
eq('U0: schema null → identity', loadEnforceConfig(mkRootWithConfig('{"bp-001":{"stop":"WEAK"}}'), null), IDENTITY)
// (1) file absent (ENOENT).
eq('U1: absent config → identity', loadEnforceConfig(mkRootWithConfig(undefined), SCHEMA), IDENTITY)
// (2) read error — config path is a DIRECTORY (EISDIR).
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-config-'))
  fs.mkdirSync(path.join(root, '.episodic-memory', 'enforce-config.json'), { recursive: true })
  eq('U2: config path is a directory (EISDIR) → identity', loadEnforceConfig(root, SCHEMA), IDENTITY)
}
// (3) JSON.parse throws.
eq('U3: unparseable JSON → identity', loadEnforceConfig(mkRootWithConfig('{not json'), SCHEMA), IDENTITY)
// (4) parses but not a plain object.
eq('U4a: top-level array → identity', loadEnforceConfig(mkRootWithConfig('[]'), SCHEMA), IDENTITY)
eq('U4b: top-level null → identity', loadEnforceConfig(mkRootWithConfig('null'), SCHEMA), IDENTITY)
eq('U4c: top-level scalar → identity', loadEnforceConfig(mkRootWithConfig('42'), SCHEMA), IDENTITY)
// (5) schema-invalid.
eq('U5a: bad tier value → identity', loadEnforceConfig(mkRootWithConfig('{"bp-001":{"stop":"BOGUS"}}'), SCHEMA), IDENTITY)
eq('U5b: malformed bp key (propertyNames) → identity', loadEnforceConfig(mkRootWithConfig('{"bp001":{"stop":"WEAK"}}'), SCHEMA), IDENTITY)
eq('U5c: non-bool active → identity', loadEnforceConfig(mkRootWithConfig('{"active":"yes"}'), SCHEMA), IDENTITY)
eq('U5d: unknown gate key → identity', loadEnforceConfig(mkRootWithConfig('{"bp-001":{"bogus_gate":"WEAK"}}'), SCHEMA), IDENTITY)

console.log('')
console.log('=== U: well-formed configs are HONORED ===')
eq('U6: stop clamp honored', loadEnforceConfig(mkRootWithConfig('{"bp-001":{"stop":"WEAK"}}'), SCHEMA), { active: true, bps: { 'bp-001': { stop: 'WEAK' } } })
eq('U7: active:false honored', loadEnforceConfig(mkRootWithConfig('{"active":false}'), SCHEMA), { active: false, bps: {} })
eq('U8: active:false + clamp honored', loadEnforceConfig(mkRootWithConfig('{"active":false,"bp-001":{"stop":"MEDIUM"}}'), SCHEMA), { active: false, bps: { 'bp-001': { stop: 'MEDIUM' } } })
eq('U9: empty object → identity-equivalent (active default true)', loadEnforceConfig(mkRootWithConfig('{}'), SCHEMA), { active: true, bps: {} })

console.log('')
console.log('=== U: decideStop honors the resolved stopTier param (pure) ===')
// A non-STRONG tier degrades the refuse regardless of markers; STRONG keeps it.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-decide-'))
  fs.mkdirSync(path.join(root, PRIMARY_MARKER_DIR), { recursive: true })
  fs.mkdirSync(path.join(root, LEGACY_MARKER_DIR), { recursive: true })
  fs.writeFileSync(primaryMarkerPath(root, '.checkpoint-required'), '') // armed, no post-done
  truthy('U10: stopTier STRONG + armed → block', decideStop({ repoRoot: root, sid: null, stopTier: 'STRONG' })?.decision === 'block', 'expected block')
  eq('U11: stopTier WEAK + armed → allow (refuse degraded)', decideStop({ repoRoot: root, sid: null, stopTier: 'WEAK' }), null)
  eq('U12: stopTier MEDIUM + armed → allow (refuse degraded)', decideStop({ repoRoot: root, sid: null, stopTier: 'MEDIUM' }), null)
}

console.log('')
console.log('=== I: integration via the enforce-contract CLI (clamp degrades the LIVE refuse) ===')

function mkGitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-cfg-e2e-'))
  execSync('git init -q -b main', { cwd: repo })
  execSync('git config user.email test@example.com', { cwd: repo })
  execSync('git config user.name test', { cwd: repo })
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n')
  execSync('git add . && git commit -q -m init', { cwd: repo, shell: '/bin/bash' })
  fs.mkdirSync(path.join(repo, PRIMARY_MARKER_DIR), { recursive: true })
  fs.mkdirSync(path.join(repo, LEGACY_MARKER_DIR), { recursive: true })
  return repo
}
function armChkpt(repo) { fs.writeFileSync(primaryMarkerPath(repo, '.checkpoint-required'), '') }
function writeConfig(repo, obj) {
  fs.mkdirSync(path.join(repo, '.episodic-memory'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.episodic-memory', 'enforce-config.json'), JSON.stringify(obj))
}
function runStop(repo) {
  const r = spawnSync('node', [ENFORCE, '--gate', 'stop'], { cwd: repo, encoding: 'utf8' })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}

// Control: armed, NO config → STRONG → block.
{
  const repo = mkGitRepo(); armChkpt(repo)
  const r = runStop(repo)
  truthy('I1: armed + no config → block (STRONG default)', /"decision":\s*"block"/.test(r.stdout), `stdout=[${r.stdout}]`)
}
// stop→WEAK clamp → refuse degraded → allow (empty stdout) + M4 stderr notice.
{
  const repo = mkGitRepo(); armChkpt(repo); writeConfig(repo, { 'bp-001': { stop: 'WEAK' } })
  const r = runStop(repo)
  eq('I2: stop→WEAK clamp → allow (empty stdout)', r.stdout.trim(), '')
  truthy('I2: stop→WEAK clamp → M4 downgrade notice on stderr', /degraded STRONG→WEAK/.test(r.stderr), `stderr=[${r.stderr}]`)
}
// post_checkpoint→WEAK clamp (DEFERRED gate) → stop UNAFFECTED → still block.
{
  const repo = mkGitRepo(); armChkpt(repo); writeConfig(repo, { 'bp-001': { post_checkpoint: 'WEAK' } })
  const r = runStop(repo)
  truthy('I3: post_checkpoint→WEAK clamp does NOT degrade the stop refuse (deferred gate) → still block',
    /"decision":\s*"block"/.test(r.stdout), `stdout=[${r.stdout}] stderr=[${r.stderr}]`)
}
// active:false → R5 silence → allow + stderr notice.
{
  const repo = mkGitRepo(); armChkpt(repo); writeConfig(repo, { active: false })
  const r = runStop(repo)
  eq('I4: active:false → allow (empty stdout)', r.stdout.trim(), '')
  truthy('I4: active:false → R5 silence notice on stderr', /enforcement disabled/.test(r.stderr), `stderr=[${r.stderr}]`)
}
// Malformed config (fail-closed) → STRONG → block (a broken file never weakens).
{
  const repo = mkGitRepo(); armChkpt(repo)
  fs.mkdirSync(path.join(repo, '.episodic-memory'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.episodic-memory', 'enforce-config.json'), '{"bp-001":{"stop":"BOGUS"}}')
  const r = runStop(repo)
  truthy('I5: schema-invalid config → fail-closed STRONG → block', /"decision":\s*"block"/.test(r.stdout), `stdout=[${r.stdout}]`)
}

console.log('')
if (fail === 0) {
  console.log(`PASS — ${pass} checks`)
  process.exit(0)
} else {
  console.log(`FAIL — ${fail} of ${pass + fail} checks failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
