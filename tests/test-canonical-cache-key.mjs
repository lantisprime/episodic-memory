#!/usr/bin/env node
/**
 * test-canonical-cache-key.mjs — E3 (gate-classifier UX): conservative
 * canonical cache key for classifier-marker.mjs.
 *
 * Covers BOTH polarities on the same inputs, per the testing discipline:
 *
 *   §K  command-canonical.mjs unit behavior (canonicalizable + refusals)
 *   §G  marker-level generalization: flag-VALUE variants hit the same verdict;
 *       flag-NAME-set variants and redirect variants DO NOT
 *   §L  backward compatibility: a pre-E3 legacy literal-key marker still hits
 *   §A  audit: the raw command + canonical form are preserved in the marker
 *   §E  end-to-end through the REAL checkpoint-gate.sh: cached read_only
 *       verdict generalizes to a flag-value variant (allowed) while the
 *       flag-set variant and the redirect variant are still held
 *
 * Usage: node tests/test-canonical-cache-key.mjs   (prints "N/N pass")
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import assert from 'assert'
import { execFileSync, spawnSync } from 'child_process'
import { canonicalizeCommand } from '../scripts/lib/command-canonical.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HELPER = path.join(REPO, 'scripts', 'classifier-marker.mjs')
const GATE = path.join(REPO, 'plugins', 'claude-code', 'hooks', 'checkpoint-gate.sh')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

function mkrepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `canonkey-${name}-`))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return fs.realpathSync(dir)
}

function runHelper(args, opts = {}) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: opts.sid || '', ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: 15000
  })
}

function parseStdout(r) {
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null') }
  catch { return null }
}

function markerWrite(repo, cmd, sid, label) {
  const r = runHelper(['--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid,
    '--label', label, '--confidence', '0.9', '--reason', 'test verdict'
  ], { cwd: repo, sid })
  assert.strictEqual(r.status, 0, `write failed: ${r.stderr}`)
  return parseStdout(r)
}

function markerRead(repo, cmd, sid) {
  const r = runHelper(['--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', cmd, '--session-id', sid
  ], { cwd: repo, sid })
  return { status: r.status, json: parseStdout(r) }
}

console.log('# test-canonical-cache-key (E3 — conservative canonical cache key)')

// ===== §K: command-canonical.mjs unit behavior =============================

test('§K1 flag-value variants share ONE canonical form (order-independent)', () => {
  const repo = mkrepo('k1')
  const a = canonicalizeCommand({ command: 'mytool --alpha 1 --beta 2', projectRoot: repo, callerCwd: repo })
  const b = canonicalizeCommand({ command: 'mytool  --beta 9   --alpha 7', projectRoot: repo, callerCwd: repo })
  assert.ok(a.canonical, 'a should be canonicalizable')
  assert.strictEqual(a.canonical, b.canonical, `expected match: ${a.canonical} vs ${b.canonical}`)
})

test('§K2 different flag-NAME sets never share a canonical form', () => {
  const repo = mkrepo('k2')
  const a = canonicalizeCommand({ command: 'mytool --alpha 1', projectRoot: repo, callerCwd: repo })
  const b = canonicalizeCommand({ command: 'mytool --alpha 1 --gamma', projectRoot: repo, callerCwd: repo })
  assert.ok(a.canonical && b.canonical)
  assert.notStrictEqual(a.canonical, b.canonical)
})

test('§K3 output redirect → NOT canonicalizable (conservative refusal)', () => {
  const repo = mkrepo('k3')
  const r = canonicalizeCommand({ command: 'mytool --alpha 1 > out.txt', projectRoot: repo, callerCwd: repo })
  assert.strictEqual(r.canonical, null)
  assert.strictEqual(r.reason, 'shell_metachar')
})

test('§K4 pipes / substitution / quotes / env-prefix / operand= all refused', () => {
  const repo = mkrepo('k4')
  for (const [cmd, reason] of [
    ['a | b', 'shell_metachar'],
    ['echo $(rm -rf x)', 'shell_metachar'],
    ["mytool 'quoted arg'", 'shell_metachar'],
    ['FOO=bar mytool --x', 'env_prefix'],
    ['dd if=/dev/zero of=/tmp/x', 'operand_assignment'],
    ['node -e process.exit', 'interpreter_flag_operand_mix'],
    ['mytool - --x', 'bare_dash_operand']
  ]) {
    const r = canonicalizeCommand({ command: cmd, projectRoot: repo, callerCwd: repo })
    assert.strictEqual(r.canonical, null, `${cmd} should be refused`)
    assert.strictEqual(r.reason, reason, `${cmd}: expected ${reason}, got ${r.reason}`)
  }
})

test('§K5 script path resolves under <REPO>; $HOME under <HOME>; interpreter values dropped', () => {
  const repo = mkrepo('k5')
  const a = canonicalizeCommand({ command: 'node scripts/em-x.mjs --tag a --limit 1', projectRoot: repo, callerCwd: repo })
  assert.strictEqual(a.canonical, 'node <REPO>/scripts/em-x.mjs --limit --tag')
  const home = os.homedir()
  const b = canonicalizeCommand({
    command: `node ${path.join(home, '.episodic-memory', 'scripts', 'em-x.mjs')} --tag b`,
    projectRoot: repo, callerCwd: repo
  })
  assert.strictEqual(b.canonical, 'node <HOME>/.episodic-memory/scripts/em-x.mjs --tag')
})

test('§K6 flag-only interpreter form (node --version) IS canonicalizable', () => {
  const repo = mkrepo('k6')
  const r = canonicalizeCommand({ command: 'node --version', projectRoot: repo, callerCwd: repo })
  assert.strictEqual(r.canonical, 'node --version')
  assert.strictEqual(r.subject, '')
})

// ===== §G: marker-level generalization polarities ==========================

test('§G1 HIT: verdict for `mytool --alpha 1 --beta 2` serves `mytool --beta 9 --alpha 7`', () => {
  const repo = mkrepo('g1')
  const sid = 's_g1'
  markerWrite(repo, 'mytool --alpha 1 --beta 2', sid, 'read_only')
  const r = markerRead(repo, 'mytool --beta 9 --alpha 7', sid)
  assert.strictEqual(r.json && r.json.status, 'hit', `expected hit, got ${JSON.stringify(r.json)}`)
  assert.strictEqual(r.json.label, 'read_only')
  assert.strictEqual(r.json.key_form, 'canonical')
})

test('§G2 MISS: same command with an EXTRA flag name does not share the verdict', () => {
  const repo = mkrepo('g2')
  const sid = 's_g2'
  markerWrite(repo, 'mytool --alpha 1 --beta 2', sid, 'read_only')
  const r = markerRead(repo, 'mytool --alpha 1 --beta 2 --gamma', sid)
  assert.notStrictEqual(r.json && r.json.status, 'hit', `must miss: ${JSON.stringify(r.json)}`)
})

test('§G3 MISS: redirect variant never hits the read_only verdict cached without it', () => {
  const repo = mkrepo('g3')
  const sid = 's_g3'
  markerWrite(repo, 'mytool --alpha 1', sid, 'read_only')
  const r = markerRead(repo, 'mytool --alpha 1 > out.txt', sid)
  assert.notStrictEqual(r.json && r.json.status, 'hit', `must miss: ${JSON.stringify(r.json)}`)
})

test('§G4 script-identity keying (in-repo interpreter script) is unchanged by E3', () => {
  const repo = mkrepo('g4')
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'scripts', 'hello.mjs'), 'console.log("hi")\n')
  const sid = 's_g4'
  const w = markerWrite(repo, 'node scripts/hello.mjs --a 1', sid, 'nonsrc_write')
  const r = markerRead(repo, 'node scripts/hello.mjs --completely --different args', sid)
  assert.strictEqual(r.json && r.json.status, 'hit')
  assert.strictEqual(r.json.key_form, 'script_identity')
  assert.strictEqual(r.json.cache_key, w.cache_key)
})

// ===== §L: backward compatibility with pre-E3 literal-key markers ==========

test('§L1 pre-E3 legacy literal-key marker still hits (canonical-first, literal fallback)', () => {
  const repo = mkrepo('l1')
  const sid = 's_l1'
  const cmd = 'mytool2 --alpha 1 --beta 2'
  // Hand-craft the marker EXACTLY as the pre-E3 helper wrote it: literal
  // normalized command in the tuple, no canonical_form_version field.
  const legacyTuple = {
    project_root_canonical: repo,
    caller_cwd_or_rel: '.',
    normalized_command: cmd,
    executable_resolved: 'mytool2',
    script_digest: null,
    session_id: sid,
    classifier_policy_version: 2,
    normalized_command_version: 2
  }
  const sorted = {}
  for (const k of Object.keys(legacyTuple).sort()) sorted[k] = legacyTuple[k]
  const sha = crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
  const classifyDir = path.join(repo, '.checkpoints', 'classify')
  fs.mkdirSync(classifyDir, { recursive: true })
  fs.writeFileSync(path.join(classifyDir, `${sha}.json`), JSON.stringify({
    label: 'read_only',
    confidence: 0.9,
    reason: 'legacy entry',
    command_normalized: cmd,
    _project_root_canonical: repo,
    _cache_key: sha,
    _session_id: sid,
    _request_nonce: 'legacy-nonce',
    _marker_version: 2,
    _classifier_policy_version: 2,
    _normalized_command_version: 2,
    recorded_at: new Date().toISOString(),
    _expires_at: new Date(Date.now() + 3600_000).toISOString(),
    classified_by: 'agent_self'
  }, null, 2) + '\n')

  const r = markerRead(repo, cmd, sid)
  assert.strictEqual(r.json && r.json.status, 'hit', `expected legacy hit: ${JSON.stringify(r.json)}`)
  assert.strictEqual(r.json.label, 'read_only')
  assert.strictEqual(r.json.key_form, 'legacy_literal')
  assert.strictEqual(r.json.cache_key, sha)
})

test('§L2 legacy fallback polarity: DIFFERENT literal command does not hit the legacy entry', () => {
  const repo = mkrepo('l2')
  const sid = 's_l2'
  // No canonical or legacy entry exists for this command at all → miss.
  const r = markerRead(repo, 'mytool2 --alpha 1 --beta 2', sid)
  assert.notStrictEqual(r.json && r.json.status, 'hit')
})

// ===== §A: audit fields =====================================================

test('§A1 marker preserves the RAW command + canonical form for audit', () => {
  const repo = mkrepo('a1')
  const sid = 's_a1'
  const raw = 'mytool   --alpha 1   --beta 2'
  const w = markerWrite(repo, raw, sid, 'read_only')
  const body = JSON.parse(fs.readFileSync(w.file, 'utf8'))
  assert.strictEqual(body.command_raw, raw, 'raw command must round-trip verbatim')
  assert.strictEqual(body.key_form, 'canonical')
  assert.strictEqual(body.command_canonical, 'mytool --alpha --beta')
  assert.strictEqual(body.command_normalized, 'mytool --alpha 1 --beta 2')
})

// ===== §E: end-to-end through the REAL checkpoint-gate.sh ==================

function runGate(repo, testHome, sid, command) {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: repo,
    session_id: sid
  })
  return spawnSync('bash', [GATE], {
    input,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: testHome,
      CLAUDE_CODE_SESSION_ID: sid,
      ANTHROPIC_API_KEY: '' // never let a dev-machine key trigger live LLM calls
    }
  })
}

test('§E1 gate E2E: cached read_only verdict generalizes to a flag-value variant (allowed)', () => {
  const repo = mkrepo('e1')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  const sid = 's_e1'
  // `craftool` is an unknown binary → shared_write/default_write → hold path.
  markerWrite(repo, 'craftool --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'craftool --alpha 2')
  assert.strictEqual(r.status, 0, `gate errored: ${r.stderr}`)
  assert.ok(!(r.stdout || '').includes('"block"'), `expected allow, got: ${r.stdout}`)
})

test('§E2 gate E2E polarity: flag-set variant of the SAME binary is still held', () => {
  const repo = mkrepo('e2')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  const sid = 's_e2'
  markerWrite(repo, 'craftool --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'craftool --alpha 2 --write-mode')
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

test('§E3 gate E2E polarity: redirect variant of the SAME cached command is still held', () => {
  const repo = mkrepo('e3')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  const sid = 's_e3'
  markerWrite(repo, 'craftool --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'craftool --alpha 1 > out.txt')
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

console.log(`\n${passed}/${passed + failed} pass`)
if (failed > 0) {
  for (const f of failures) console.error(`FAIL: ${f.name}: ${f.error}`)
  process.exit(1)
}
