#!/usr/bin/env node
/**
 * test-em-revise-scope-inherit.mjs — Tests for #121 em-revise scope inheritance.
 *
 * Verifies that em-revise with no --scope inherits the original episode's
 * store (local or global), and that explicit --scope local|global preserves
 * cross-scope behavior. Runs the matrix against BOTH script copies:
 *   - scripts/em-revise.mjs              (canonical; tags.json mirror present)
 *   - plugins/episodic-memory/scripts/em-revise.mjs  (drifted plugin copy)
 *
 * tags.json mirror assertions only run against the canonical copy.
 *
 * Usage: node tests/test-em-revise-scope-inherit.mjs
 * Zero deps — Node stdlib + assert + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CANONICAL_STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const CANONICAL_REVISE = path.join(REPO, 'scripts', 'em-revise.mjs')
const PLUGIN_REVISE = path.join(REPO, 'plugins', 'episodic-memory', 'scripts', 'em-revise.mjs')
const SEARCH = path.join(REPO, 'scripts', 'em-search.mjs')

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

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------
function makeSandbox() {
  // Realpath because os.tmpdir() returns /var/... on macOS while the script
  // resolves files under /private/var/... — startsWith comparisons would
  // otherwise mismatch.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-revise-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  return {
    root,
    home,
    cwd,
    globalStore: path.join(home, '.episodic-memory'),
    localStore: path.join(cwd, '.episodic-memory'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function runJSON(cmd, args, sandbox) {
  const out = execSync(`node ${cmd} ${args}`, {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()
  return JSON.parse(out)
}

function runJSONExpectError(cmd, args, sandbox) {
  try {
    const out = execSync(`node ${cmd} ${args}`, {
      cwd: sandbox.cwd,
      env: { ...process.env, HOME: sandbox.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    return { ok: true, out: JSON.parse(out) }
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString() : ''
    return { ok: false, out: stdout ? JSON.parse(stdout) : null, code: e.status }
  }
}

function seed(scope, sandbox, summary = 'orig') {
  const args = `--scope ${scope} --project test --category decision --tags "a,b" --summary "${summary}" --body "original body"`
  return runJSON(CANONICAL_STORE, args, sandbox)
}

function indexHas(storeDir, id, expectedStatus) {
  const idx = path.join(storeDir, 'index.jsonl')
  if (!fs.existsSync(idx)) return false
  const lines = fs.readFileSync(idx, 'utf8').trim().split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      if (e.id === id && (!expectedStatus || e.status === expectedStatus)) return true
    } catch {}
  }
  return false
}

function tagsJsonHas(storeDir, id) {
  const tagsFile = path.join(storeDir, 'tags.json')
  if (!fs.existsSync(tagsFile)) return false
  const idx = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  for (const tag of Object.keys(idx)) {
    if (Array.isArray(idx[tag]) && idx[tag].includes(id)) return true
  }
  return false
}

function historyChain(sandbox, scope, id) {
  const args = `--history ${id} --scope ${scope} --include-superseded --no-track`
  const res = runJSON(SEARCH, args, sandbox)
  return res.chain || []
}

// ---------------------------------------------------------------------------
// Scope-inheritance matrix (runs against both canonical and plugin copies)
// ---------------------------------------------------------------------------
function runMatrix(label, REVISE, isCanonical) {
  console.log(`\n${label}`)

  // Case 1: local original, no --scope → revision lands local
  test(`${label}: local original + no --scope inherits local`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('local', sb, 'case1')
      assert.strictEqual(orig.scope, 'local')
      const rev = runJSON(REVISE, `--original ${orig.id} --summary "rev1" --body "rev body"`, sb)
      assert.strictEqual(rev.status, 'ok')
      assert.strictEqual(rev.scope, 'local', `expected local, got ${rev.scope}`)
      assert.ok(rev.file.startsWith(sb.localStore), `revision not in local store: ${rev.file}`)
      assert.ok(indexHas(sb.localStore, rev.id, 'active'), 'revision missing from local index')
      assert.ok(indexHas(sb.localStore, orig.id, 'superseded'), 'original not marked superseded in local index')
      assert.ok(!fs.existsSync(sb.globalStore), 'global store should not exist')
      // history chain in local scope should contain both
      const chain = historyChain(sb, 'local', rev.id)
      const ids = chain.map(e => e.id)
      assert.ok(ids.includes(orig.id) && ids.includes(rev.id), `chain missing ids: ${ids.join(',')}`)
    } finally { sb.cleanup() }
  })

  // Case 2: global original, no --scope → revision lands global
  test(`${label}: global original + no --scope inherits global`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('global', sb, 'case2')
      assert.strictEqual(orig.scope, 'global')
      const rev = runJSON(REVISE, `--original ${orig.id} --summary "rev2" --body "rev body"`, sb)
      assert.strictEqual(rev.scope, 'global', `expected global, got ${rev.scope}`)
      assert.ok(rev.file.startsWith(sb.globalStore), `revision not in global store: ${rev.file}`)
      assert.ok(indexHas(sb.globalStore, rev.id, 'active'))
      assert.ok(indexHas(sb.globalStore, orig.id, 'superseded'))
      assert.ok(!fs.existsSync(sb.localStore), 'local store should not exist')
      const chain = historyChain(sb, 'global', rev.id)
      const ids = chain.map(e => e.id)
      assert.ok(ids.includes(orig.id) && ids.includes(rev.id), `chain missing ids: ${ids.join(',')}`)
    } finally { sb.cleanup() }
  })

  // Case 3: explicit --scope inherit on local original
  test(`${label}: explicit --scope inherit (local original) lands local`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('local', sb, 'case3')
      const rev = runJSON(REVISE, `--original ${orig.id} --scope inherit --summary "rev3" --body "b"`, sb)
      assert.strictEqual(rev.scope, 'local')
      assert.ok(rev.file.startsWith(sb.localStore))
    } finally { sb.cleanup() }
  })

  // Case 4: explicit --scope inherit on global original
  test(`${label}: explicit --scope inherit (global original) lands global`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('global', sb, 'case4')
      const rev = runJSON(REVISE, `--original ${orig.id} --scope inherit --summary "rev4" --body "b"`, sb)
      assert.strictEqual(rev.scope, 'global')
      assert.ok(rev.file.startsWith(sb.globalStore))
    } finally { sb.cleanup() }
  })

  // Case 5: cross-scope — local original + explicit --scope global → lands global
  test(`${label}: local original + explicit --scope global lands global (cross-scope)`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('local', sb, 'case5')
      const rev = runJSON(REVISE, `--original ${orig.id} --scope global --summary "rev5" --body "b"`, sb)
      assert.strictEqual(rev.scope, 'global')
      assert.ok(rev.file.startsWith(sb.globalStore))
      assert.ok(indexHas(sb.globalStore, rev.id, 'active'), 'revision missing from global index')
      assert.ok(indexHas(sb.localStore, orig.id, 'superseded'), 'original not marked superseded in local')
      // Cross-scope history requires --scope all
      const chain = historyChain(sb, 'all', rev.id)
      const ids = chain.map(e => e.id)
      assert.ok(ids.includes(orig.id) && ids.includes(rev.id), `cross-scope chain missing ids: ${ids.join(',')}`)
      if (isCanonical) {
        // tags.json mirror: revision in target store + original store
        assert.ok(tagsJsonHas(sb.globalStore, rev.id), 'revision id missing from global tags.json')
        assert.ok(tagsJsonHas(sb.localStore, rev.id), 'revision id missing from local tags.json (cross-scope mirror)')
      }
    } finally { sb.cleanup() }
  })

  // Case 6: cross-scope — global original + explicit --scope local → lands local
  test(`${label}: global original + explicit --scope local lands local (cross-scope)`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('global', sb, 'case6')
      const rev = runJSON(REVISE, `--original ${orig.id} --scope local --summary "rev6" --body "b"`, sb)
      assert.strictEqual(rev.scope, 'local')
      assert.ok(rev.file.startsWith(sb.localStore))
      assert.ok(indexHas(sb.localStore, rev.id, 'active'))
      assert.ok(indexHas(sb.globalStore, orig.id, 'superseded'))
      const chain = historyChain(sb, 'all', rev.id)
      const ids = chain.map(e => e.id)
      assert.ok(ids.includes(orig.id) && ids.includes(rev.id), `cross-scope chain missing ids: ${ids.join(',')}`)
      if (isCanonical) {
        assert.ok(tagsJsonHas(sb.localStore, rev.id), 'revision id missing from local tags.json')
        assert.ok(tagsJsonHas(sb.globalStore, rev.id), 'revision id missing from global tags.json (cross-scope mirror)')
      }
    } finally { sb.cleanup() }
  })

  // Case 7a: explicit --scope local on local original (same-scope)
  test(`${label}: local original + explicit --scope local lands local`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('local', sb, 'case7a')
      const rev = runJSON(REVISE, `--original ${orig.id} --scope local --summary "rev7a" --body "b"`, sb)
      assert.strictEqual(rev.scope, 'local')
      assert.ok(rev.file.startsWith(sb.localStore))
      assert.ok(!fs.existsSync(sb.globalStore), 'global store should not exist')
    } finally { sb.cleanup() }
  })

  // Case 7b: explicit --scope global on global original (same-scope)
  test(`${label}: global original + explicit --scope global lands global`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('global', sb, 'case7b')
      const rev = runJSON(REVISE, `--original ${orig.id} --scope global --summary "rev7b" --body "b"`, sb)
      assert.strictEqual(rev.scope, 'global')
      assert.ok(rev.file.startsWith(sb.globalStore))
      assert.ok(!fs.existsSync(sb.localStore), 'local store should not exist')
    } finally { sb.cleanup() }
  })

  // Case 8: invalid --scope → error JSON, exit non-zero
  test(`${label}: invalid --scope foo returns error`, () => {
    const sb = makeSandbox()
    try {
      const orig = seed('local', sb, 'case7')
      const r = runJSONExpectError(REVISE, `--original ${orig.id} --scope foo --summary "x" --body "y"`, sb)
      assert.strictEqual(r.ok, false, 'expected non-zero exit')
      assert.ok(r.out && r.out.status === 'error', `expected error JSON, got ${JSON.stringify(r.out)}`)
      assert.ok(/Invalid --scope/i.test(r.out.message), `unexpected message: ${r.out.message}`)
    } finally { sb.cleanup() }
  })
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log('Running em-revise scope-inheritance tests (#121)\n')

runMatrix('scripts/em-revise.mjs (canonical)', CANONICAL_REVISE, true)
runMatrix('plugins/episodic-memory/scripts/em-revise.mjs (drifted copy)', PLUGIN_REVISE, false)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
