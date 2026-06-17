#!/usr/bin/env node
// test-structured-alert.mjs — RFC-008 P3b-2 (CLASS-C(b) / F3 writer, LIBRARY-ONLY
// per B2). Pins the PARAMETERIZED writer scripts/lib/structured-alert.mjs:
//   M1   — the payload is parameterized: a REAL emitted_label flows through, NOT
//          the probe's hardcoded `probe_out_of_vocabulary` literal.
//   F4   — `now` is injected (never Date.now() in the lib); project_root/store_root
//          are the two distinct fields, store_root = resolveRepoRoot(input).
//   B4   — the write binds to the resolved store root from `input`, not cwd; a
//          store_root param that disagrees with resolveRepoRoot(input) throws
//          (resolve-once invariant).
//   F62  — the schema's exactly-one label-vs-event conditional is enforced (a bad
//          combo throws, never writes a half-valid alert).
//   N2   — the probe CLI's isMain is realpath-robust (symlinked invocation path
//          still runs as main; closes FU #390).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

import { emitStructuredAlert, AlertError } from '../scripts/lib/structured-alert.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const PROBE = path.join(REPO, 'scripts', 'lib', 'structured-alert-probe.mjs')

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
function throws(name, fn, re) {
  try { fn(); bad(name, 'expected throw') }
  catch (e) { if (!re || re.test(e.message)) ok(name); else bad(name, `wrong message: ${e.message}`) }
}

function mkGitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-alert-'))
  execSync('git init -q -b main', { cwd: repo })
  execSync('git config user.email test@example.com', { cwd: repo })
  execSync('git config user.name test', { cwd: repo })
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n')
  execSync('git add . && git commit -q -m init', { cwd: repo, shell: '/bin/bash' })
  return repo
}

const NOW = '2026-06-17T09:30:00.000Z'

console.log('=== M1 — parameterized payload (REAL label, not the probe literal) ===')
{
  const repo = mkGitRepo()
  const r = emitStructuredAlert({
    input: repo, now: NOW,
    alert_type: 'classifier_out_of_vocabulary',
    emitted_label: 'shared_write_typo', // a REAL offending label
    command: 'rm -rf /tmp/x',
  })
  eq('M1: status ok', r.status, 'ok')
  truthy('M1: alert file exists', fs.existsSync(r.episode_file), r.episode_file)
  const ep = JSON.parse(fs.readFileSync(r.episode_file, 'utf8'))
  eq('M1: emitted_label is the REAL label (not probe_out_of_vocabulary)', ep.emitted_label, 'shared_write_typo')
  eq('M1: alert_type passed through', ep.alert_type, 'classifier_out_of_vocabulary')
  eq('M1: command passed through', ep.command, 'rm -rf /tmp/x')
  // F4 — now injected, filename slug derives from it (no colons).
  eq('M1/F4: timestamp == injected now', ep.timestamp_iso8601, NOW)
  truthy('M1/F4: filename slug derives from now', path.basename(r.episode_file).includes('2026-06-17'), r.episode_file)
  // F4 — project_root == store_root in a non-worktree repo (the two distinct fields).
  const real = fs.realpathSync(repo)
  eq('F4: project_root == realpath(repo)', ep.project_root, real)
  eq('F4: store_root == realpath(repo)', ep.store_root, real)
  eq('F4: episode fields match the returned contract', [ep.project_root, ep.store_root], [r.project_root, r.store_root])
}

console.log('')
console.log('=== F4 — now MUST be injected (never Date.now() in the lib) ===')
throws('now omitted → throws', () => emitStructuredAlert({ input: mkGitRepo(), alert_type: 'classifier_out_of_vocabulary', emitted_label: 'x' }), /now.*injected|ISO-8601/)

console.log('')
console.log('=== B4 — store_root binds to resolveRepoRoot(input), not cwd ===')
{
  const repo = mkGitRepo()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-elsewhere-'))
  const saved = process.cwd()
  try {
    process.chdir(elsewhere) // cwd != project
    const r = emitStructuredAlert({ input: repo, now: NOW, alert_type: 'classifier_out_of_vocabulary', emitted_label: 'lbl' })
    truthy('B4: alert lands under store_root (from input), not cwd', r.episode_file.startsWith(fs.realpathSync(repo) + path.sep), r.episode_file)
    truthy('B4: alert ABSENT under cwd', !fs.existsSync(path.join(elsewhere, '.episodic-memory')), 'cwd should have no alert')
  } finally { process.chdir(saved) }
}
// store_root param that disagrees with resolveRepoRoot(input) → resolve-once throw.
{
  const repo = mkGitRepo()
  const wrong = fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-store-'))
  eq('B4: matching store_root param accepted', emitStructuredAlert({ input: repo, now: NOW, alert_type: 'classifier_out_of_vocabulary', emitted_label: 'lbl', store_root: fs.realpathSync(repo) }).status, 'ok')
  throws('B4: mismatched store_root param → throws (resolve-once)', () => emitStructuredAlert({ input: repo, now: NOW, alert_type: 'classifier_out_of_vocabulary', emitted_label: 'lbl', store_root: wrong }), /resolve-once|store_root param/)
}

console.log('')
console.log('=== F62 — exactly-one label-vs-event vocab (bad combo never writes) ===')
{
  const repo = mkGitRepo()
  throws('F62: classifier_out_of_vocabulary w/ null label → schema-invalid throw',
    () => emitStructuredAlert({ input: repo, now: NOW, alert_type: 'classifier_out_of_vocabulary', emitted_label: null }), /schema-invalid/)
  // event_out_of_vocabulary requires emitted_event_id + events_version, label null.
  const ev = emitStructuredAlert({
    input: repo, now: NOW, alert_type: 'event_out_of_vocabulary',
    emitted_label: null, emitted_event_id: 'bogus_event',
    events_version: 'sha256:' + 'a'.repeat(64),
  })
  eq('F62: well-formed event_out_of_vocabulary writes ok', ev.status, 'ok')
  throws('F62: event_out_of_vocabulary missing events_version → throw',
    () => emitStructuredAlert({ input: repo, now: NOW, alert_type: 'event_out_of_vocabulary', emitted_event_id: 'bogus_event' }), /schema-invalid/)
}

console.log('')
console.log('=== AlertError type ===')
truthy('AlertError is an Error subclass', new AlertError('x') instanceof Error, 'expected Error subclass')

console.log('')
console.log('=== N2 — probe CLI isMain realpath-robust (symlinked invocation path) ===')
{
  const repo = mkGitRepo()
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-symlink-'))
  const linkedLib = path.join(linkDir, 'lib')
  fs.symlinkSync(path.join(REPO, 'scripts', 'lib'), linkedLib) // non-canonical path to the real probe
  const r = spawnSync('node', [path.join(linkedLib, 'structured-alert-probe.mjs'), '--project', repo, '--now', NOW], { cwd: repo, encoding: 'utf8' })
  let out = null
  try { out = JSON.parse(r.stdout.trim()) } catch {}
  truthy('N2: probe via symlinked path still runs as main + emits the contract', out && out.status === 'ok' && out.input_project_root, `stdout=[${r.stdout}] stderr=[${r.stderr}]`)
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
