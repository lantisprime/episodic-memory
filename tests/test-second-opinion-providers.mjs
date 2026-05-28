#!/usr/bin/env node
/**
 * test-second-opinion-providers.mjs — Per-provider available() shape smoke tests.
 *
 * Coverage:
 *   - All 5 providers (codex, claude-subagent, gemini, stub, opencode) export
 *     id + binary + available + dispatch.
 *   - available() returns {ok: boolean, reason?: string} regardless of
 *     CLI presence (no throw, no undefined fields).
 *   - dispatch() throws on missing required args.
 *   - --dispatch through harness with provider missing module .mjs returns
 *     provider-module-missing (covered in test-second-opinion-dispatch
 *     for gemini; here we verify all 4 .mjs files now exist).
 *
 * Real-CLI dispatch is NOT tested here (the codex/claude/gemini binaries
 * may or may not be installed in CI). Real-CLI probes are pre-merge
 * manual probes per v3.2 §Pre-merge manual probe discipline (toolkit
 * lesson ...abbd).
 */

import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PROVIDERS_DIR = path.join(REPO_ROOT, 'scripts', 'second-opinion', 'providers')

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
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

console.log('# test-second-opinion-providers')

// ---------------------------------------------------------------------------
// All 4 providers exist + export the contract
// ---------------------------------------------------------------------------
console.log('\n## Provider module contract')
const PROVIDERS = ['codex', 'claude-subagent', 'gemini', 'stub', 'opencode']
for (const id of PROVIDERS) {
  const modPath = path.join(PROVIDERS_DIR, `${id}.mjs`)
  test(`provider module exists: ${id}.mjs`, () => {
    assert.ok(fs.existsSync(modPath), `expected ${modPath}`)
  })
}

// ---------------------------------------------------------------------------
// available() shape contract per provider
// ---------------------------------------------------------------------------
console.log('\n## available() shape contract')
for (const id of PROVIDERS) {
  await asyncTest(`${id}.available() returns {ok: boolean, reason?: string}`, async () => {
    const mod = await import(`file://${path.join(PROVIDERS_DIR, `${id}.mjs`)}`)
    assert.ok(typeof mod.available === 'function', `${id} must export available()`)
    assert.ok(typeof mod.dispatch === 'function', `${id} must export dispatch()`)
    assert.ok(typeof mod.id === 'string', `${id} must export id constant`)
    assert.ok(typeof mod.binary === 'string', `${id} must export binary constant`)
    assert.strictEqual(mod.id, id, `${id}.id must match filename`)

    const result = mod.available()
    assert.ok(typeof result.ok === 'boolean',
      `${id}.available() must return {ok: boolean}, got ${JSON.stringify(result)}`)
    if (!result.ok) {
      assert.ok(typeof result.reason === 'string',
        `when ok=false, ${id}.available() must include reason`)
    }
  })
}

// ---------------------------------------------------------------------------
// dispatch() validates required args
// ---------------------------------------------------------------------------
console.log('\n## dispatch() arg validation')
for (const id of PROVIDERS) {
  await asyncTest(`${id}.dispatch() throws on missing prompt`, async () => {
    const mod = await import(`file://${path.join(PROVIDERS_DIR, `${id}.mjs`)}`)
    assert.throws(() => mod.dispatch({ projectRoot: '/tmp' }),
      (e) => /prompt is required/.test(e.message))
  })
  await asyncTest(`${id}.dispatch() throws on missing projectRoot`, async () => {
    const mod = await import(`file://${path.join(PROVIDERS_DIR, `${id}.mjs`)}`)
    assert.throws(() => mod.dispatch({ prompt: 'hi' }),
      (e) => /projectRoot is required/.test(e.message))
  })
}

// ---------------------------------------------------------------------------
// FU-001: dispatch() surfaces spawn failures (ENOENT / bad cwd) in `error`
// instead of discarding result.error. A non-existent cwd makes spawnSync fail
// with ENOENT regardless of whether the binary is installed, so this is
// deterministic across CI hosts. Stub is in-process (no spawn) → excluded.
// ---------------------------------------------------------------------------
console.log('\n## dispatch() surfaces spawn-failure error (FU-001)')
const CLI_PROVIDERS = ['codex', 'claude-subagent', 'gemini', 'opencode']
for (const id of CLI_PROVIDERS) {
  await asyncTest(`${id}.dispatch() on bad cwd → ok:false + error string`, async () => {
    const mod = await import(`file://${path.join(PROVIDERS_DIR, `${id}.mjs`)}`)
    const r = mod.dispatch({ prompt: 'x', projectRoot: '/nonexistent-so-provider-test-xyz-123' })
    assert.strictEqual(r.ok, false, `${id}: spawn into bad cwd must be ok:false`)
    assert.strictEqual(typeof r.error, 'string',
      `${id}: spawn failure must surface error as a string, got ${JSON.stringify(r.error)}`)
    assert.ok(r.error.length > 0, `${id}: error message must be non-empty`)
  })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
