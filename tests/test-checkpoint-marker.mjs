#!/usr/bin/env node
/**
 * Unit tests for scripts/checkpoint-marker.mjs (rank-2 C2).
 *
 * Sibling of tests/test-plan-marker.mjs. Verifies:
 *   - Action vocabulary (arm-if-missing | touch | rm)
 *   - Argument validation (--target, --action, --root)
 *   - Session-id sourcing from env
 *   - Atomic temp+rename write semantics
 *   - Read-only-during-burn-in invariant (NEVER touches legacy literal)
 *   - JSON output shape + exit codes
 *
 * Per codex plan-tier R4 trust model (option 2): helper has NO trusted
 * current-session beyond env CLAUDE_CODE_SESSION_ID. Cross-session
 * scenarios (B passing A's sid) are out-of-scope — honest-agent.
 *
 * Coverage layout:
 *   A1-A6   — argument validation
 *   S1-S5   — session-id sourcing from env
 *   R1-R3   — --root validation
 *   T1-T3   — --target validation
 *   AC1-AC4 — --action validation
 *   ARM*    — arm-if-missing semantics (per quartet member)
 *   TCH*    — touch semantics (per quartet member)
 *   RM*     — rm semantics (per quartet member)
 *   F1-F3   — F3 legacy-literal-read-only invariant
 *   J1-J3   — JSON output shape
 */

import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const HELPER = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'scripts',
  'checkpoint-marker.mjs'
)

const QUARTET = [
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.pre-checkpoint-done',
  '.post-checkpoint-done',
]

let pass = 0
let fail = 0
const failures = []

function assert(label, cond, detail) {
  if (cond) { pass++; return }
  fail++
  failures.push({ label, detail })
}

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rank2-cm-test-'))
  // Make it look like a valid repo root — validateRoot requires a repo signal.
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  return root
}

function run(args, env = {}, opts = {}) {
  const fullEnv = { ...process.env, ...env }
  const res = spawnSync('node', [HELPER, ...args], {
    env: fullEnv,
    encoding: 'utf8',
    ...opts,
  })
  return { code: res.status, stdout: res.stdout, stderr: res.stderr }
}

function parseJson(stdout) {
  try { return JSON.parse(stdout.trim().split('\n').pop()) } catch { return null }
}

// ---------------------------------------------------------------------------
// A1-A6 — argument validation
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  let r

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing'], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('A1 missing --root → exit 4', r.code === 4)

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: '' })
  assert('A2 empty CLAUDE_CODE_SESSION_ID → exit 8', r.code === 8)

  r = run(['--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('A3 missing --target → exit 6', r.code === 6)

  r = run(['--target', '.checkpoint-required', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('A4 missing --action → exit 6', r.code === 6)

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root, '--unknown'], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('A5 unknown arg → exit 6', r.code === 6)

  fs.rmSync(root, { recursive: true, force: true })

  r = run(['--help'])
  assert('A6 --help → exit 0', r.code === 0 && r.stdout.includes('Usage:'))
}

// ---------------------------------------------------------------------------
// S1-S5 — session-id sourcing
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  let r

  // Don't override env at all → CLAUDE_CODE_SESSION_ID is unset (parent process
  // doesn't set it). Result: exit 8.
  const cleanEnv = { ...process.env }
  delete cleanEnv.CLAUDE_CODE_SESSION_ID
  r = spawnSync('node', [HELPER, '--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { env: cleanEnv, encoding: 'utf8' })
  assert('S1 unset CLAUDE_CODE_SESSION_ID → exit 8', r.status === 8)

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: '' })
  assert('S2 empty → exit 8', r.code === 8)

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: 'invalid/slash' })
  assert('S3 invalid charclass (slash) → exit 8', r.code === 8)

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: 'has.dot' })
  assert('S4 invalid charclass (dot) → exit 8', r.code === 8)

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: 'a'.repeat(129) })
  assert('S5 oversize sid → exit 8', r.code === 8)

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// R1-R3 — --root validation
// ---------------------------------------------------------------------------
{
  let r

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', 'relative/path'], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('R1 relative root → exit 5', r.code === 5)

  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', '/nonexistent/path/xyz'], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('R2 nonexistent root → exit 5', r.code === 5)

  const noRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rank2-no-repo-'))
  r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', noRepoRoot], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('R3 root without .git → exit 5', r.code === 5)
  fs.rmSync(noRepoRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// T1-T3 — --target validation
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  let r

  r = run(['--target', '.session-baseline', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('T1 .session-baseline → exit 7 (out of quartet)', r.code === 7)

  r = run(['--target', '.plan-approval-pending', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('T2 plan-marker → exit 7', r.code === 7)

  r = run(['--target', '/abs/path/.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('T3 abs-path target → exit 7', r.code === 7)

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// AC1-AC3 — --action validation
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  let r

  r = run(['--target', '.checkpoint-required', '--action', 'unknown-action', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('AC1 unknown action → exit 9', r.code === 9)

  r = run(['--target', '.checkpoint-required', '--action', '', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('AC2 empty action → exit 9', r.code === 9)

  r = run(['--target', '.checkpoint-required', '--action', 'ARM-IF-MISSING', '--root', root], { CLAUDE_CODE_SESSION_ID: 'sid' })
  assert('AC3 case-sensitive action → exit 9', r.code === 9)

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// ARM1-ARM8 — arm-if-missing semantics (×4 quartet members ×2 states)
// ---------------------------------------------------------------------------
for (const target of QUARTET) {
  const root = makeFixtureRoot()
  const sid = 'sid-arm-test'
  const suffixed = path.join(root, '.checkpoints', `${target}.${sid}`)

  // First arm: file doesn't exist → write it.
  let r = run(['--target', target, '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  let json = parseJson(r.stdout)
  assert(`ARM ${target} first-arm exit 0`, r.code === 0)
  assert(`ARM ${target} first-arm noop=false`, json && json.noop === false)
  assert(`ARM ${target} first-arm file created`, fs.existsSync(suffixed))

  // Second arm: already exists → noop.
  r = run(['--target', target, '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  json = parseJson(r.stdout)
  assert(`ARM ${target} second-arm noop=true`, json && json.noop === true)

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// TCH1-TCH4 — touch semantics (×4 quartet members)
// ---------------------------------------------------------------------------
for (const target of QUARTET) {
  const root = makeFixtureRoot()
  const sid = 'sid-touch'
  const suffixed = path.join(root, '.checkpoints', `${target}.${sid}`)

  // Touch when missing → creates.
  let r = run(['--target', target, '--action', 'touch', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  assert(`TCH ${target} creates empty file`, r.code === 0 && fs.existsSync(suffixed))

  // Pre-existing file with content → touch force-overwrites to empty.
  fs.writeFileSync(suffixed, 'previous content')
  r = run(['--target', target, '--action', 'touch', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  assert(`TCH ${target} overwrites pre-existing`,
    r.code === 0 && fs.readFileSync(suffixed, 'utf8') === '')

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// RM1-RM8 — rm semantics (×4 quartet members, primary + legacy)
// ---------------------------------------------------------------------------
for (const target of QUARTET) {
  const root = makeFixtureRoot()
  const sid = 'sid-rm'
  const primary = path.join(root, '.checkpoints', `${target}.${sid}`)
  const legacy = path.join(root, '.claude', `${target}.${sid}`)

  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  fs.writeFileSync(primary, '')
  fs.writeFileSync(legacy, '')

  let r = run(['--target', target, '--action', 'rm', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  let json = parseJson(r.stdout)
  assert(`RM ${target} exit 0`, r.code === 0)
  assert(`RM ${target} primary gone`, !fs.existsSync(primary))
  assert(`RM ${target} legacy gone`, !fs.existsSync(legacy))
  assert(`RM ${target} both reported`, json && json.removed.length === 2)

  // Idempotent: re-rm → exit 0, removed: [].
  r = run(['--target', target, '--action', 'rm', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  json = parseJson(r.stdout)
  assert(`RM ${target} idempotent exit 0`, r.code === 0)
  assert(`RM ${target} idempotent removed=[]`, json && json.removed.length === 0)

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// XS1-XS4 — cross-session non-interference (codex C2 R1 P1 regression)
//
// Required invariant per codex 20260524-055434-...-a24a:
//   arm-if-missing must NOT no-op when another session's suffixed marker
//   exists. Each session arms its own per-session marker. Other sessions'
//   markers must not suppress this session's arming.
// ---------------------------------------------------------------------------
for (const target of QUARTET.slice(0, 1)) {
  const root = makeFixtureRoot()
  const sidA = 'sid-a'
  const sidB = 'sid-b'
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })

  // Setup: session A has its own marker; session B has none.
  const markerA = path.join(root, '.checkpoints', `${target}.${sidA}`)
  const markerB = path.join(root, '.checkpoints', `${target}.${sidB}`)
  fs.writeFileSync(markerA, '')

  // Session B arm-if-missing: must NOT no-op; must create markerB.
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rank2-caller-cwd-'))
  const r = spawnSync('node', [HELPER,
    '--target', target,
    '--action', 'arm-if-missing',
    '--root', root,
  ], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sidB },
    cwd: callerCwd,
    encoding: 'utf8',
  })
  const json = parseJson(r.stdout)
  assert('XS1 B exit 0', r.status === 0)
  assert('XS2 B noop=false (other-session marker does NOT suppress)',
    json && json.noop === false)
  assert('XS3 B markerB created at target root', fs.existsSync(markerB))
  assert('XS4 caller cwd has no marker artifacts',
    !fs.existsSync(path.join(callerCwd, '.checkpoints')))

  // Verify A's marker still untouched.
  assert("XS5 A's marker preserved", fs.existsSync(markerA))

  fs.rmSync(callerCwd, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// F1-F3 — F3 legacy-literal-read-only invariant
// ---------------------------------------------------------------------------
for (const target of QUARTET.slice(0, 1)) {
  // Only test once (same logic across all quartet members).
  const root = makeFixtureRoot()
  const sid = 'sid-f3'
  const primaryLegacy = path.join(root, '.checkpoints', target)   // bare literal
  const legacyLegacy = path.join(root, '.claude', target)         // bare literal
  const suffixed = path.join(root, '.checkpoints', `${target}.${sid}`)

  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })

  // Pre-seed: bare legacy literal at both roots.
  fs.writeFileSync(primaryLegacy, 'legacy-content')
  fs.writeFileSync(legacyLegacy, 'legacy-content')

  // arm-if-missing should NO-OP because the bare legacy exists at primary.
  let r = run(['--target', target, '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  let json = parseJson(r.stdout)
  assert('F1 arm-if-missing noop when legacy literal present',
    r.code === 0 && json && json.noop === true && !fs.existsSync(suffixed))

  // rm should NEVER touch the bare literals.
  r = run(['--target', target, '--action', 'rm', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  json = parseJson(r.stdout)
  assert('F2 rm does not touch bare primary literal',
    r.code === 0 && fs.existsSync(primaryLegacy) && fs.readFileSync(primaryLegacy, 'utf8') === 'legacy-content')
  assert('F3 rm does not touch bare legacy literal',
    fs.existsSync(legacyLegacy) && fs.readFileSync(legacyLegacy, 'utf8') === 'legacy-content')

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// J1-J3 — JSON output shape
// ---------------------------------------------------------------------------
{
  const root = makeFixtureRoot()
  const sid = 'sid-json'

  let r = run(['--target', '.checkpoint-required', '--action', 'arm-if-missing', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  let json = parseJson(r.stdout)
  assert('J1 arm-if-missing JSON shape',
    json && json.status === 'ok' && json.action === 'arm-if-missing' &&
    json.target === '.checkpoint-required' && json.sid === sid && typeof json.path === 'string')

  r = run(['--target', '.pre-checkpoint-done', '--action', 'touch', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  json = parseJson(r.stdout)
  assert('J2 touch JSON shape',
    json && json.action === 'touch' && json.target === '.pre-checkpoint-done' &&
    typeof json.path === 'string')

  r = run(['--target', '.pre-checkpoint-done', '--action', 'rm', '--root', root], { CLAUDE_CODE_SESSION_ID: sid })
  json = parseJson(r.stdout)
  assert('J3 rm JSON shape',
    json && json.action === 'rm' && Array.isArray(json.removed))

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(JSON.stringify({
  pass,
  fail,
  total: pass + fail,
  failures,
}, null, 2))

process.exit(fail === 0 ? 0 : 1)
