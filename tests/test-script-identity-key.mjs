#!/usr/bin/env node
/**
 * tests/test-script-identity-key.mjs
 *
 * Locks in the script-identity cache-key behavior across both buildTuple
 * implementations (classifier-marker.mjs and scripts/lib/classifier-cache.mjs)
 * + the agent_classify_command env-prefix guard (FU-1).
 *
 * Acceptance contract:
 *   1. In-repo interpreter command (`node scripts/X.mjs <args>`) keys on script
 *      identity → same key across arg variations.
 *   2. Direct in-repo executable (`scripts/X <args>`) stays arg-sensitive.
 *   3. Shell redirects (`echo x > foo`) stay arg-sensitive.
 *   4. Env-prefixed interpreter command stays arg-sensitive (NOT script-identity).
 *   5. Flag-prefixed interpreter (`node --inspect ...`) stays arg-sensitive
 *      (predicate rejects; digest is null anyway).
 *   6. External (non-in-repo) interpreter script stays arg-sensitive (digest null).
 *   7. Marker plant + read with varied args round-trips via the same key.
 *   8. agent_classify_command refuses env-prefix at the cache authority (FU-1).
 *   9. Predicate parity: classifier-marker and classifier-cache use the SAME
 *      shared predicate (no parallel divergence).
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

import {
  isInterpreterScriptIdentity,
  buildTuple as cacheBuildTuple,
  cacheKey as cacheCacheKey
} from '../scripts/lib/classifier-cache.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const MARKER = path.join(ROOT, 'scripts', 'classifier-marker.mjs')
const SHELL_LIB = path.join(ROOT, 'plugins', 'claude-code', 'hooks', 'lib', 'command-classifier.sh')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

function mkrepo(label) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sik-${label}-`)))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  execSync('git init -q', { cwd: repo })
  // Put a real interpreter script in repo so script_digest is non-null.
  fs.mkdirSync(path.join(repo, 'scripts'))
  fs.writeFileSync(path.join(repo, 'scripts', 'hello.mjs'), '#!/usr/bin/env node\nconsole.log("hi")\n')
  return repo
}

// markerKey — compute the marker's cache_key for a given command by running
// classifier-marker.mjs --write (returns key in JSON), in dry-run-ish mode
// (we just want the key; the file is written but discarded with the repo).
function markerWrite(repo, command, sessionId = 'sik-sid', label = 'read_only') {
  const r = spawnSync(process.execPath, [
    MARKER, '--write',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', command,
    '--session-id', sessionId,
    '--label', label, '--confidence', '0.9',
    '--reason', 'sik'
  ], { cwd: repo, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId }, encoding: 'utf8' })
  assert.strictEqual(r.status, 0, `marker --write failed: status=${r.status} stderr=${r.stderr}`)
  return JSON.parse(r.stdout)
}

function markerRead(repo, command, sessionId = 'sik-sid') {
  const r = spawnSync(process.execPath, [
    MARKER, '--read',
    '--project-root', repo, '--caller-cwd', repo,
    '--command', command,
    '--session-id', sessionId
  ], { cwd: repo, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId }, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, json: r.stdout ? JSON.parse(r.stdout.trim().split('\n').pop()) : null }
}

// === Predicate-level tests (no I/O) =======================================

test('SI-P01 predicate: in-repo interpreter command + digest → true', () => {
  assert.strictEqual(isInterpreterScriptIdentity('node scripts/x.mjs --a 1', 'abc'), true)
  assert.strictEqual(isInterpreterScriptIdentity('python scripts/y.py', 'abc'), true)
  assert.strictEqual(isInterpreterScriptIdentity('python3 scripts/y.py', 'abc'), true)
  assert.strictEqual(isInterpreterScriptIdentity('ruby scripts/y.rb', 'abc'), true)
  assert.strictEqual(isInterpreterScriptIdentity('perl scripts/y.pl', 'abc'), true)
})

test('SI-P02 predicate: null digest (script missing or external) → false', () => {
  assert.strictEqual(isInterpreterScriptIdentity('node scripts/x.mjs', null), false)
  assert.strictEqual(isInterpreterScriptIdentity('node scripts/x.mjs', undefined), false)
})

test('SI-P03 predicate: direct executable (toks[0] not interpreter) → false', () => {
  assert.strictEqual(isInterpreterScriptIdentity('scripts/x --a', 'abc'), false)
  assert.strictEqual(isInterpreterScriptIdentity('./build.sh', 'abc'), false)
  assert.strictEqual(isInterpreterScriptIdentity('echo hi', 'abc'), false)
})

test('SI-P04 predicate: env-prefix → false (defense-in-depth with FU-1)', () => {
  // toks[0]="FOO=bar", basename not in INTERPRETERS → predicate rejects.
  assert.strictEqual(isInterpreterScriptIdentity('FOO=bar node scripts/x.mjs', 'abc'), false)
})

test('SI-P05 predicate: flag-prefixed interpreter (`node --inspect`) → false', () => {
  // toks[1]="--inspect" starts with '-' → predicate rejects.
  assert.strictEqual(isInterpreterScriptIdentity('node --inspect scripts/x.mjs', 'abc'), false)
})

test('SI-P06 predicate: wrapper-prefixed (`time node ...`) → false', () => {
  // toks[0]="time" not in INTERPRETERS → predicate rejects.
  assert.strictEqual(isInterpreterScriptIdentity('time node scripts/x.mjs', 'abc'), false)
})

// === classifier-cache.mjs buildTuple key behavior =========================

test('SI-C01 classifier-cache: in-repo interpreter command — args do NOT affect key', () => {
  const repo = mkrepo('cache-arg-invariant')
  const t1 = cacheBuildTuple({ command: 'node scripts/hello.mjs --a 1', projectRoot: repo, callerCwd: repo })
  const t2 = cacheBuildTuple({ command: 'node scripts/hello.mjs --b 2 --c 3', projectRoot: repo, callerCwd: repo })
  assert.strictEqual(t1.normalized_command, null, 'normalized_command should be null (script-identity)')
  assert.strictEqual(t2.normalized_command, null)
  assert.strictEqual(cacheCacheKey(t1), cacheCacheKey(t2), 'arg-variant keys must MATCH for in-repo interpreter')
})

test('SI-C02 classifier-cache: direct executable — args DO affect key (arg-sensitive)', () => {
  const repo = mkrepo('cache-direct-arg-sensitive')
  const t1 = cacheBuildTuple({ command: 'scripts/hello.mjs --a 1', projectRoot: repo, callerCwd: repo })
  const t2 = cacheBuildTuple({ command: 'scripts/hello.mjs --b 2', projectRoot: repo, callerCwd: repo })
  assert.notStrictEqual(t1.normalized_command, null)
  assert.notStrictEqual(cacheCacheKey(t1), cacheCacheKey(t2), 'direct executable must stay arg-sensitive')
})

test('SI-C03 classifier-cache: shell redirect — args DO affect key', () => {
  const repo = mkrepo('cache-redirect')
  const t1 = cacheBuildTuple({ command: 'echo x > foo', projectRoot: repo, callerCwd: repo })
  const t2 = cacheBuildTuple({ command: 'echo y > foo', projectRoot: repo, callerCwd: repo })
  assert.notStrictEqual(cacheCacheKey(t1), cacheCacheKey(t2), 'redirects must stay arg-sensitive')
})

test('SI-C04 classifier-cache: env-prefix — args DO affect key (NOT script-identity)', () => {
  const repo = mkrepo('cache-env')
  const t1 = cacheBuildTuple({ command: 'FOO=bar node scripts/hello.mjs --a', projectRoot: repo, callerCwd: repo })
  const t2 = cacheBuildTuple({ command: 'FOO=bar node scripts/hello.mjs --b', projectRoot: repo, callerCwd: repo })
  assert.notStrictEqual(t1.normalized_command, null)
  assert.notStrictEqual(cacheCacheKey(t1), cacheCacheKey(t2))
})

test('SI-C05 classifier-cache: external interpreter script (digest null) — arg-sensitive', () => {
  const repo = mkrepo('cache-ext')
  const t1 = cacheBuildTuple({ command: 'node /usr/local/bin/external.mjs --a', projectRoot: repo, callerCwd: repo })
  const t2 = cacheBuildTuple({ command: 'node /usr/local/bin/external.mjs --b', projectRoot: repo, callerCwd: repo })
  assert.strictEqual(t1.script_digest, null, 'external script: digest null')
  assert.notStrictEqual(cacheCacheKey(t1), cacheCacheKey(t2))
})

test('SI-C06 classifier-cache: different in-repo scripts — different keys', () => {
  const repo = mkrepo('cache-two-scripts')
  fs.writeFileSync(path.join(repo, 'scripts', 'world.mjs'), 'console.log("w")\n')
  const t1 = cacheBuildTuple({ command: 'node scripts/hello.mjs', projectRoot: repo, callerCwd: repo })
  const t2 = cacheBuildTuple({ command: 'node scripts/world.mjs', projectRoot: repo, callerCwd: repo })
  assert.notStrictEqual(cacheCacheKey(t1), cacheCacheKey(t2), 'different scripts → different keys')
})

test('SI-C07 classifier-cache: same script, edited body — digest changes → key differs (safety axis 7)', () => {
  const repo = mkrepo('cache-digest-pin')
  const script = path.join(repo, 'scripts', 'hello.mjs')
  const t1 = cacheBuildTuple({ command: 'node scripts/hello.mjs', projectRoot: repo, callerCwd: repo })
  fs.writeFileSync(script, '// edited\nconsole.log("changed")\n')
  const t2 = cacheBuildTuple({ command: 'node scripts/hello.mjs', projectRoot: repo, callerCwd: repo })
  assert.notStrictEqual(t1.script_digest, t2.script_digest)
  assert.notStrictEqual(cacheCacheKey(t1), cacheCacheKey(t2), 'edited script must invalidate verdict')
})

// === classifier-marker.mjs end-to-end round-trip ==========================

test('SI-M01 marker round-trip: write with args A, read with args B → HIT (script-identity)', () => {
  const repo = mkrepo('marker-arg-roundtrip')
  const sid = 'sik-round-1'
  const writeOut = markerWrite(repo, 'node scripts/hello.mjs --summary "first call"', sid, 'nonsrc_write')
  assert.strictEqual(writeOut.label, 'nonsrc_write')
  // Read with COMPLETELY DIFFERENT args — must HIT under script-identity.
  const r = markerRead(repo, 'node scripts/hello.mjs --tag a --body x --different', sid)
  assert.strictEqual(r.status, 0, `marker --read should exit 0; stdout=${r.stdout}`)
  assert.strictEqual(r.json.status, 'hit', `expected hit on varied args; got: ${JSON.stringify(r.json)}`)
  assert.strictEqual(r.json.label, 'nonsrc_write')
  assert.strictEqual(r.json.cache_key, writeOut.cache_key, 'cache_key must MATCH across arg variations')
})

test('SI-M02 marker non-script-identity: different shell redirects → MISS', () => {
  const repo = mkrepo('marker-redirect-miss')
  const sid = 'sik-redirect'
  markerWrite(repo, 'echo x > foo', sid, 'read_only')
  const r = markerRead(repo, 'echo y > foo', sid)
  assert.notStrictEqual(r.json.status, 'hit', 'redirect with different value must MISS')
})

test('SI-M03 marker: env-prefix variant does NOT hit clean script marker', () => {
  const repo = mkrepo('marker-env-no-reuse')
  const sid = 'sik-env'
  // Plant clean marker.
  markerWrite(repo, 'node scripts/hello.mjs --a', sid, 'read_only')
  // Env-prefixed lookup — predicate rejects → key includes normalized_command (with env prefix) → MISS.
  const r = markerRead(repo, 'FOO=bar node scripts/hello.mjs --a', sid)
  assert.notStrictEqual(r.json.status, 'hit', 'env-prefix MUST NOT reuse clean script marker')
})

// === agent_classify_command env-prefix guard (FU-1) =======================

test('SI-A01 agent_classify_command: env-prefix command returns 1 (FU-1)', () => {
  const repo = mkrepo('agent-env-guard')
  const sid = 'sik-fu1'
  // Even with a CLEAN script marker present, the agent_classify_command guard
  // must refuse to consult the cache for an env-prefixed command.
  markerWrite(repo, 'node scripts/hello.mjs', sid, 'read_only')

  const out = spawnSync('bash', ['-c', `
    set -e
    source "${SHELL_LIB}"
    # source emits agent-classifier.sh too via internal sourcing; call directly.
    source "${path.join(ROOT, 'plugins', 'claude-code', 'hooks/lib/agent-classifier.sh')}"
    # FU-1 guard: env-prefix command returns 1 (no decision).
    if agent_classify_command "FOO=bar node scripts/hello.mjs" "${repo}" "${repo}"; then
      echo "UNEXPECTED_HIT"
    else
      echo "REFUSED_OK"
    fi
  `], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' })

  assert.ok(out.stdout.includes('REFUSED_OK'), `FU-1 guard must refuse env-prefix; got stdout=${out.stdout} stderr=${out.stderr}`)
})

// === Run ==================================================================

let pass = 0, fail = 0
const failures = []
for (const t of tests) {
  try {
    t.fn()
    console.log(`  ✓ ${t.name}`)
    pass++
  } catch (e) {
    console.log(`  ✗ ${t.name}\n    ${e.message}`)
    failures.push({ name: t.name, msg: e.message })
    fail++
  }
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  ${f.name}: ${f.msg}`)
  process.exit(1)
}
