#!/usr/bin/env node
/**
 * test-readonly-manifest.mjs — E4 (gate-classifier UX): first-party read-only
 * command manifest (patterns/readonly-commands.json).
 *
 *   §S  schema doc lints (mini-jsonschema) + manifest instance validates
 *       (json-instance-validate closed subset)
 *   §H  helper-level matching, BOTH polarities on the same binaries:
 *       manifest hit vs same-binary-with-write-flag miss, require_flags,
 *       allow_flags closure, non-canonicalizable refusal
 *   §E  end-to-end through the REAL checkpoint-gate.sh: manifest hit →
 *       command allowed; same binary with the write flag → held
 *
 * Usage: node tests/test-readonly-manifest.mjs   (prints "N/N pass")
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import assert from 'assert'
import { execFileSync, spawnSync } from 'child_process'
import { lintSchema } from '../scripts/lib/mini-jsonschema.mjs'
import { assertSchemaModeled, validateInstance } from '../scripts/lib/json-instance-validate.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CONSULT = path.join(REPO, 'scripts', 'classifier-hold-consult.mjs')
const GATE = path.join(REPO, 'plugins', 'claude-code', 'hooks', 'checkpoint-gate.sh')
const MANIFEST = path.join(REPO, 'patterns', 'readonly-commands.json')
const SCHEMA = path.join(REPO, 'patterns', 'readonly-commands.schema.json')

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `romanifest-${name}-`))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return fs.realpathSync(dir)
}

function runConsult(repo, command) {
  const r = spawnSync(process.execPath, [CONSULT,
    '--project-root', repo,
    '--caller-cwd', repo,
    '--command', command,
    '--session-id', 's_manifest'
  ], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ANTHROPIC_API_KEY: '' } // never live LLM in tests
  })
  assert.strictEqual(r.status, 0, `consult must always exit 0: ${r.stderr}`)
  return JSON.parse((r.stdout || '').trim().split('\n').pop())
}

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
      ANTHROPIC_API_KEY: ''
    }
  })
}

console.log('# test-readonly-manifest (E4 — first-party read-only manifest)')

// ===== §S: schema + instance validation =====================================

const schemaDoc = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'))
const manifestDoc = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))

test('§S1 readonly-commands.schema.json lints as a valid 2020-12 schema doc', () => {
  const { valid, errors } = lintSchema(schemaDoc)
  assert.ok(valid, `schema doc lint errors: ${(errors || []).join(' | ')}`)
})

test('§S2 patterns/readonly-commands.json validates against its schema', () => {
  assertSchemaModeled(schemaDoc)
  const { valid, errors } = validateInstance(manifestDoc, schemaDoc)
  assert.ok(valid, `instance errors: ${(errors || []).join(' | ')}`)
})

test('§S3 negative instance: entry with unknown field / bad flag name is REJECTED', () => {
  const bad = JSON.parse(JSON.stringify(manifestDoc))
  bad.entries[0].surprise_field = true
  let r = validateInstance(bad, schemaDoc)
  assert.ok(!r.valid, 'unknown entry field must be rejected')
  const bad2 = JSON.parse(JSON.stringify(manifestDoc))
  bad2.entries[0].deny_flags = ['not a flag']
  r = validateInstance(bad2, schemaDoc)
  assert.ok(!r.valid, 'malformed flag name must be rejected')
})

test('§S4 manifest entry ids are unique', () => {
  const ids = manifestDoc.entries.map((e) => e.id)
  assert.strictEqual(new Set(ids).size, ids.length, `duplicate ids in ${ids}`)
})

// ===== §H: helper-level matching polarities =================================

// Trust is pinned to the INSTALLED copy (<HOME>/.episodic-memory/scripts) —
// repo-relative scripts/em-*.mjs can be locally modified, write-capable files
// (review finding), so they must never match. INSTALLED below is a path SHAPE
// (canonicalization does not require the file to exist).
const INSTALLED = path.join(os.homedir(), '.episodic-memory', 'scripts')

test('§H1 HIT: installed em-stats → read_only; repo-relative form NEVER matches', () => {
  const repo = mkrepo('h1')
  const out = runConsult(repo, `node ${INSTALLED}/em-stats.mjs --scope all`)
  assert.strictEqual(out.decision, 'read_only', JSON.stringify(out))
  assert.strictEqual(out.source, 'manifest')
  assert.strictEqual(out.entry_id, 'em-stats')
  const repoForm = runConsult(repo, 'node scripts/em-stats.mjs --scope all')
  assert.strictEqual(repoForm.decision, 'hold', `repo-path script must NOT ride the manifest: ${JSON.stringify(repoForm)}`)
})

test('§H2 polarity pair (same binary): em-doctor plain → hit; em-doctor --fix → hold', () => {
  const repo = mkrepo('h2')
  const plain = runConsult(repo, `node ${INSTALLED}/em-doctor.mjs --scope all --strict`)
  assert.strictEqual(plain.decision, 'read_only', JSON.stringify(plain))
  assert.strictEqual(plain.entry_id, 'em-doctor')
  const fix = runConsult(repo, `node ${INSTALLED}/em-doctor.mjs --scope all --fix`)
  assert.strictEqual(fix.decision, 'hold', `--fix must NOT match: ${JSON.stringify(fix)}`)
})

test('§H3 require_flags: em-pattern-health --check → hit; without --check → hold', () => {
  const repo = mkrepo('h3')
  const withCheck = runConsult(repo, `node ${INSTALLED}/em-pattern-health.mjs --check`)
  assert.strictEqual(withCheck.decision, 'read_only', JSON.stringify(withCheck))
  const without = runConsult(repo, `node ${INSTALLED}/em-pattern-health.mjs`)
  assert.strictEqual(without.decision, 'hold', JSON.stringify(without))
})

test('§H4 allow_flags closure: em-recall documented flags → hit; unknown flag → hold', () => {
  const repo = mkrepo('h4')
  const ok = runConsult(repo, `node ${INSTALLED}/em-recall.mjs --project x --limit 5 --no-track`)
  assert.strictEqual(ok.decision, 'read_only', JSON.stringify(ok))
  const unknown = runConsult(repo, `node ${INSTALLED}/em-recall.mjs --project x --store-draft`)
  assert.strictEqual(unknown.decision, 'hold', JSON.stringify(unknown))
})

test('§H5 $HOME-installed script path matches via <HOME> placeholder', () => {
  const repo = mkrepo('h5')
  const p = path.join(os.homedir(), '.episodic-memory', 'scripts', 'em-stats.mjs')
  const out = runConsult(repo, `node ${p} --top 5`)
  assert.strictEqual(out.decision, 'read_only', JSON.stringify(out))
})

test('§H6 out-of-registry script location NEVER matches (e.g. /tmp/em-stats.mjs)', () => {
  const repo = mkrepo('h6')
  const out = runConsult(repo, 'node /tmp/em-stats.mjs --top 5')
  assert.strictEqual(out.decision, 'hold', JSON.stringify(out))
})

test('§H7 redirect variant of a manifest-listed command NEVER matches', () => {
  const repo = mkrepo('h7')
  const out = runConsult(repo, `node ${INSTALLED}/em-stats.mjs --scope all > dump.json`)
  assert.strictEqual(out.decision, 'hold', JSON.stringify(out))
})

test('§H9 impostor interpreter: path-qualified `node` NEVER rides a manifest entry', () => {
  const repo = mkrepo('h9')
  // Same execBase "node", arbitrary binary — the review's runtime-confirmed
  // bypass. Bare PATH-resolved names only.
  const abs = runConsult(repo, `/tmp/evil/node ${INSTALLED}/em-stats.mjs --top 5`)
  assert.strictEqual(abs.decision, 'hold', JSON.stringify(abs))
  const rel = runConsult(repo, `./node ${INSTALLED}/em-stats.mjs --top 5`)
  assert.strictEqual(rel.decision, 'hold', JSON.stringify(rel))
})

test('§H8 node --version matches the flags-only entry; node script.mjs --version does not ride it', () => {
  const repo = mkrepo('h8')
  const v = runConsult(repo, 'node --version')
  assert.strictEqual(v.decision, 'read_only', JSON.stringify(v))
  assert.strictEqual(v.entry_id, 'node-version-help')
  const s = runConsult(repo, 'node scripts/unknown.mjs --version --extra x')
  assert.strictEqual(s.decision, 'hold', JSON.stringify(s))
})

// ===== §E: end-to-end through the REAL checkpoint-gate.sh ==================

test('§E1 gate E2E HIT: manifest reader (em-stats) is allowed with no agent involvement', () => {
  const repo = mkrepo('e1')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'romanifest-home-'))
  // The gate's consult child resolves <HOME> against ITS env (testHome).
  const r = runGate(repo, testHome, 's_e1', `node ${testHome}/.episodic-memory/scripts/em-stats.mjs --scope all`)
  assert.strictEqual(r.status, 0, `gate errored: ${r.stderr}`)
  assert.ok(!(r.stdout || '').includes('"block"'), `expected allow, got: ${r.stdout}`)
  // No verdict marker persisted — the manifest is the durable authority.
  assert.ok(!fs.existsSync(path.join(repo, '.checkpoints', 'classify')),
    'manifest hit must not persist a verdict marker')
})

test('§E2 gate E2E polarity: SAME binary with the write flag (em-doctor --fix) is held', () => {
  const repo = mkrepo('e2')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'romanifest-home-'))
  const r = runGate(repo, testHome, 's_e2', `node ${testHome}/.episodic-memory/scripts/em-doctor.mjs --fix`)
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

test('§E3 gate E2E: non-manifest novel command still held (manifest is not a bypass)', () => {
  const repo = mkrepo('e3')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'romanifest-home-'))
  const r = runGate(repo, testHome, 's_e3', 'node scripts/random-tool.mjs --go')
  assert.ok((r.stdout || '').includes('"block"'), `expected block, got: ${r.stdout || r.stderr}`)
})

console.log(`\n${passed}/${passed + failed} pass`)
if (failed > 0) {
  for (const f of failures) console.error(`FAIL: ${f.name}: ${f.error}`)
  process.exit(1)
}
