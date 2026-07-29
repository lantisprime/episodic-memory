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

// Flag-value generalization is SAFE only for interpreter+script forms (the
// em-* reader shape): there the SCRIPT determines behavior, not a positional.
// Non-interpreter flag values are indistinguishable from write-target operands
// (`sed -i EXPR FILE`), so those refuse — see §K7.
test('§K1 interpreter flag-value variants share ONE canonical form (order-independent)', () => {
  const repo = mkrepo('k1')
  const a = canonicalizeCommand({ command: 'node app.mjs --alpha 1 --beta 2', projectRoot: repo, callerCwd: repo })
  const b = canonicalizeCommand({ command: 'node app.mjs  --beta 9   --alpha 7', projectRoot: repo, callerCwd: repo })
  assert.ok(a.canonical, 'a should be canonicalizable')
  assert.strictEqual(a.canonical, b.canonical, `expected match: ${a.canonical} vs ${b.canonical}`)
})

test('§K2 different flag-NAME sets never share a canonical form', () => {
  const repo = mkrepo('k2')
  const a = canonicalizeCommand({ command: 'node app.mjs --alpha 1', projectRoot: repo, callerCwd: repo })
  const b = canonicalizeCommand({ command: 'node app.mjs --alpha 1 --gamma', projectRoot: repo, callerCwd: repo })
  assert.ok(a.canonical && b.canonical)
  assert.notStrictEqual(a.canonical, b.canonical)
})

test('§K3 output redirect → NOT canonicalizable (conservative refusal)', () => {
  const repo = mkrepo('k3')
  const r = canonicalizeCommand({ command: 'node app.mjs --alpha 1 > out.txt', projectRoot: repo, callerCwd: repo })
  assert.strictEqual(r.canonical, null)
  assert.strictEqual(r.reason, 'shell_metachar')
})

test('§K7 non-interpreter positional operand → refused (sed -i / cp write-target bypass)', () => {
  const repo = mkrepo('k7')
  // Multi-operand and flag+operand forms drop a write-target operand → refuse.
  // (A SINGLE bare operand becomes the path-distinct `subject`, which is safe:
  //  `tee /repo/a` and `tee /repo/b` get distinct canonicals — see §K8.)
  for (const cmd of ['sed -i s/a/b/g /repo/src.js', 'cp src dst', 'tee -a /repo/out.txt', 'mv a b']) {
    const r = canonicalizeCommand({ command: cmd, projectRoot: repo, callerCwd: repo })
    assert.strictEqual(r.canonical, null, `${cmd} must refuse (operand is a write target)`)
    assert.strictEqual(r.reason, 'noninterpreter_positional_operand', `${cmd}: got ${r.reason}`)
  }
  // The confirmed bypass pair now canonicalizes to DIFFERENT (null) forms → no collision.
  const harmless = canonicalizeCommand({ command: 'sed -i s/a/b/g /tmp/scratch.txt', projectRoot: repo, callerCwd: repo })
  assert.strictEqual(harmless.canonical, null, 'harmless sibling also refuses → falls to literal key')
})

test('§K8 single bare operand is a path-distinct subject (no cross-path collision)', () => {
  const repo = mkrepo('k8')
  const a = canonicalizeCommand({ command: 'tee /repo/a.txt', projectRoot: repo, callerCwd: repo })
  const b = canonicalizeCommand({ command: 'tee /repo/b.txt', projectRoot: repo, callerCwd: repo })
  assert.ok(a.canonical && b.canonical, 'single-operand form canonicalizes (operand is the subject)')
  assert.notStrictEqual(a.canonical, b.canonical, 'different target paths → different canonical → no shared verdict')
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

test('§G1 HIT: interpreter verdict for `node app.mjs --alpha 1 --beta 2` serves `--beta 9 --alpha 7`', () => {
  const repo = mkrepo('g1')
  const sid = 's_g1'
  markerWrite(repo, 'node app.mjs --alpha 1 --beta 2', sid, 'read_only')
  const r = markerRead(repo, 'node app.mjs --beta 9 --alpha 7', sid)
  assert.strictEqual(r.json && r.json.status, 'hit', `expected hit, got ${JSON.stringify(r.json)}`)
  assert.strictEqual(r.json.label, 'read_only')
  assert.strictEqual(r.json.key_form, 'canonical')
})

test('§G2 MISS: same command with an EXTRA flag name does not share the verdict', () => {
  const repo = mkrepo('g2')
  const sid = 's_g2'
  markerWrite(repo, 'node app.mjs --alpha 1 --beta 2', sid, 'read_only')
  const r = markerRead(repo, 'node app.mjs --alpha 1 --beta 2 --gamma', sid)
  assert.notStrictEqual(r.json && r.json.status, 'hit', `must miss: ${JSON.stringify(r.json)}`)
})

test('§G3 MISS: redirect variant never hits the read_only verdict cached without it', () => {
  const repo = mkrepo('g3')
  const sid = 's_g3'
  markerWrite(repo, 'node app.mjs --alpha 1', sid, 'read_only')
  const r = markerRead(repo, 'node app.mjs --alpha 1 > out.txt', sid)
  assert.notStrictEqual(r.json && r.json.status, 'hit', `must miss: ${JSON.stringify(r.json)}`)
})

test('§G5 MISS: non-interpreter write-target sibling never rides a cached verdict', () => {
  const repo = mkrepo('g5')
  const sid = 's_g5'
  // The confirmed bypass: `sed -i EXPR /tmp/x` (nonsrc) must NOT lend its
  // verdict to `sed -i EXPR /repo/src`. Both refuse canonicalization → literal
  // keys → distinct → no hit.
  markerWrite(repo, 'sed -i s/a/b/g /tmp/scratch.txt', sid, 'nonsrc_write')
  const r = markerRead(repo, 'sed -i s/a/b/g /repo/src.js', sid)
  assert.notStrictEqual(r.json && r.json.status, 'hit', `write-target sibling must miss: ${JSON.stringify(r.json)}`)
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
  // `mytool2 --alpha 1 --beta 2` refuses canonicalization (non-interpreter
  // positional operands), so the read uses the LITERAL key directly — which is
  // the pre-E3 key — and the pre-E3 marker hits. (When a command DOES
  // canonicalize, a canonical miss falls back to the same literal key labeled
  // `legacy_literal`; either way pre-E3 markers stay reachable.)
  assert.strictEqual(r.json.key_form, 'literal')
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
  const raw = 'node app.mjs   --alpha 1   --beta 2'
  const w = markerWrite(repo, raw, sid, 'read_only')
  const body = JSON.parse(fs.readFileSync(w.file, 'utf8'))
  assert.strictEqual(body.command_raw, raw, 'raw command must round-trip verbatim')
  assert.strictEqual(body.key_form, 'canonical')
  assert.strictEqual(body.command_canonical, 'node <REPO>/app.mjs --alpha --beta')
  assert.strictEqual(body.command_normalized, 'node app.mjs --alpha 1 --beta 2')
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
  // Interpreter+script (out-of-repo, no digest) → canonical generalization.
  markerWrite(repo, 'node craftool.mjs --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'node craftool.mjs --alpha 2')
  assert.strictEqual(r.status, 0, `gate errored: ${r.stderr}`)
  assert.ok(!(r.stdout || '').includes('"block"'), `expected allow, got: ${r.stdout}`)
})

test('§E2 gate E2E polarity: flag-set variant of the SAME binary is still held', () => {
  const repo = mkrepo('e2')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  const sid = 's_e2'
  markerWrite(repo, 'node craftool.mjs --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'node craftool.mjs --alpha 2 --write-mode')
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

test('§E3 gate E2E polarity: redirect variant of the SAME cached command is still held', () => {
  const repo = mkrepo('e3')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  const sid = 's_e3'
  markerWrite(repo, 'node craftool.mjs --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'node craftool.mjs --alpha 1 > out.txt')
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

// ===== §EP: env-prefixed commands — literal-lane consult (issue #435) ======

test('§EP1 unit: env-prefixed and bare forms produce DISTINCT cache keys', () => {
  const repo = mkrepo('ep1')
  const sid = 's_ep1'
  const wPrefixed = markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', sid, 'read_only')
  const wBare = markerWrite(repo, 'node craftool.mjs --alpha 1', sid, 'read_only')
  assert.notStrictEqual(wPrefixed.cache_key, wBare.cache_key, 'env prefix must ride in the key')
})

test('§EP2 unit: env-prefixed write/read use the LITERAL lane and hit same-session', () => {
  const repo = mkrepo('ep2')
  const sid = 's_ep2'
  const w = markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', sid, 'read_only')
  const body = JSON.parse(fs.readFileSync(w.file, 'utf8'))
  assert.strictEqual(body.key_form, 'literal', `expected literal lane, got ${body.key_form}`)
  const r = markerRead(repo, 'FOO=bar node craftool.mjs --alpha 1', sid)
  assert.strictEqual(r.json && r.json.status, 'hit', `expected hit: ${JSON.stringify(r.json)}`)
  assert.strictEqual(r.json.key_form, 'literal')
  assert.strictEqual(r.json.cache_key, w.cache_key)
})

test('§EP3 unit polarity: bare↔prefixed never share a verdict (both directions)', () => {
  const repo = mkrepo('ep3')
  const sid = 's_ep3'
  markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', sid, 'read_only')
  const rBare = markerRead(repo, 'node craftool.mjs --alpha 1', sid)
  assert.notStrictEqual(rBare.json && rBare.json.status, 'hit', `bare must miss: ${JSON.stringify(rBare.json)}`)
  const repo2 = mkrepo('ep3b')
  markerWrite(repo2, 'node craftool.mjs --alpha 1', sid, 'read_only')
  const rPref = markerRead(repo2, 'FOO=bar node craftool.mjs --alpha 1', sid)
  assert.notStrictEqual(rPref.json && rPref.json.status, 'hit', `prefixed must miss: ${JSON.stringify(rPref.json)}`)
})

test('§EP4 unit polarity: a different prefix VALUE is a different shape', () => {
  const repo = mkrepo('ep4')
  const sid = 's_ep4'
  markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', sid, 'read_only')
  const r = markerRead(repo, 'FOO=other node craftool.mjs --alpha 1', sid)
  assert.notStrictEqual(r.json && r.json.status, 'hit', `value variant must miss: ${JSON.stringify(r.json)}`)
})

test('§EP5 unit polarity: another session never reads the prefixed verdict', () => {
  const repo = mkrepo('ep5')
  markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', 's_ep5a', 'read_only')
  const r = markerRead(repo, 'FOO=bar node craftool.mjs --alpha 1', 's_ep5b')
  assert.notStrictEqual(r.json && r.json.status, 'hit', `cross-session must miss: ${JSON.stringify(r.json)}`)
})

test('§EP6 gate E2E: same-session verdict for an env-prefixed command satisfies the gate on retry (issue #435)', () => {
  const repo = mkrepo('ep6')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  const sid = 's_ep6'
  markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'FOO=bar node craftool.mjs --alpha 1')
  assert.strictEqual(r.status, 0, `gate errored: ${r.stderr}`)
  assert.ok(!(r.stdout || '').includes('"block"'), `expected allow, got: ${r.stdout}`)
})

test('§EP7 gate E2E polarity: the bare variant is still held after the prefixed verdict', () => {
  const repo = mkrepo('ep7')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  const sid = 's_ep7'
  markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', sid, 'read_only')
  const r = runGate(repo, testHome, sid, 'node craftool.mjs --alpha 1')
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

test('§EP8 gate E2E polarity: another session\'s prefixed verdict does not satisfy the gate', () => {
  const repo = mkrepo('ep8')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'canonkey-home-'))
  markerWrite(repo, 'FOO=bar node craftool.mjs --alpha 1', 's_ep8a', 'read_only')
  const r = runGate(repo, testHome, 's_ep8b', 'FOO=bar node craftool.mjs --alpha 1')
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

test('§EP9 unit: multi-prefix is its own literal shape (exact hit; set and order variants miss)', () => {
  const repo = mkrepo('ep9')
  const sid = 's_ep9'
  const wMulti = markerWrite(repo, 'A=1 B=2 node craftool.mjs --alpha 1', sid, 'read_only')
  const bodyMulti = JSON.parse(fs.readFileSync(wMulti.file, 'utf8'))
  assert.strictEqual(bodyMulti.key_form, 'literal', `expected literal lane, got ${bodyMulti.key_form}`)
  const wSingle = markerWrite(repo, 'A=1 node craftool.mjs --alpha 1', sid, 'read_only')
  assert.notStrictEqual(wMulti.cache_key, wSingle.cache_key, 'prefix-set variant must not share a key')
  const rHit = markerRead(repo, 'A=1 B=2 node craftool.mjs --alpha 1', sid)
  assert.strictEqual(rHit.json && rHit.json.status, 'hit', `exact multi-prefix shape must hit: ${JSON.stringify(rHit.json)}`)
  const rOrder = markerRead(repo, 'B=2 A=1 node craftool.mjs --alpha 1', sid)
  assert.notStrictEqual(rOrder.json && rOrder.json.status, 'hit', `reordered prefixes are a different literal shape: ${JSON.stringify(rOrder.json)}`)
})

console.log(`\n${passed}/${passed + failed} pass`)
if (failed > 0) {
  for (const f of failures) console.error(`FAIL: ${f.name}: ${f.error}`)
  process.exit(1)
}
