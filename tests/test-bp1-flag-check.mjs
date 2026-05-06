#!/usr/bin/env node
/**
 * test-bp1-flag-check.mjs — Hermetic tests for bp1-flag-check.mjs.
 *
 * Builds isolated temp project roots + verify-key + config.json fixtures
 * per scenario; runs the script with --project, --config, --no-emit; asserts
 * the failure code on stdout JSON.
 *
 * Scenarios cover RFC-004 failure-table rows 25-29 plus the happy path.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'bp1-flag-check.mjs')

let pass = 0
let fail = 0
const failures = []

function tap(name, fn) {
  try {
    fn()
    pass++
    console.log(`ok ${pass + fail} - ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, error: e })
    console.log(`not ok ${pass + fail} - ${name}`)
    console.log(`  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp1-flag-check-${label}-`))
}

function writeVerifyKey(verifyKeyPath, mode = 0o600) {
  fs.mkdirSync(path.dirname(verifyKeyPath), { recursive: true })
  const key = crypto.randomBytes(32)
  fs.writeFileSync(verifyKeyPath, key)
  fs.chmodSync(verifyKeyPath, mode)
  const fp = crypto.createHmac('sha256', key)
    .update('verify-key-fingerprint-v1', 'utf8')
    .digest('hex').slice(0, 16)
  return { key, fingerprint: fp }
}

function makeProjectRoot() {
  const dir = makeTempDir('proj')
  // git init so canonical-root resolution works (we override via --project anyway)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  return fs.realpathSync(dir)
}

function buildExpectedHash(projectRoot) {
  // Run the manifest builder to pre-compute the hash that flag-check expects.
  const out = execFileSync('node', [
    path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    '--project', projectRoot,
    '--json',
  ], { encoding: 'utf8' })
  const parsed = JSON.parse(out)
  return parsed.sha256
}

function writeConfig(configPath, projectRoot, entry) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const config = {
    bp1: {
      schema_version: 1,
      activations: { [projectRoot]: entry },
    },
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function runFlagCheck({ projectRoot, configPath, env }) {
  const r = spawnSync('node', [
    SCRIPT,
    '--project', projectRoot,
    '--config', configPath,
    '--no-emit',
    '--json',
  ], { encoding: 'utf8', env: { ...process.env, ...(env || {}) } })
  return {
    exitCode: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    parsed: r.stdout ? safeParse(r.stdout) : null,
  }
}

function safeParse(s) {
  try { return JSON.parse(s.trim()) } catch { return null }
}

// ---------------------------------------------------------------------------
// Scenario: happy path
// ---------------------------------------------------------------------------
tap('happy path: enabled entry with matching hash + fingerprint → exit 0', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  const verifyKeyPath = path.join(homeDir, '.episodic-memory', '.verify-key')
  const { fingerprint } = writeVerifyKey(verifyKeyPath)
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  const hash = buildExpectedHash(proj)
  writeConfig(configPath, proj, {
    enabled: true,
    artifact_version_hash: `sha256:${hash}`,
    enabled_at: '2026-05-06T00:00:00Z',
    enabled_via: 'test',
    verify_key_id: fingerprint,
  })
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 0, `expected exit 0; stdout=${r.stdout} stderr=${r.stderr}`)
  assert.ok(r.parsed)
  assert.equal(r.parsed.status, 'ok')
})

// ---------------------------------------------------------------------------
// Scenario: bp1-disabled-refusal (no entry)
// ---------------------------------------------------------------------------
tap('row 25: no activation entry → bp1-disabled-refusal', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  writeVerifyKey(path.join(homeDir, '.episodic-memory', '.verify-key'))
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ bp1: { schema_version: 1, activations: {} } }))
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 2)
  assert.equal(r.parsed.code, 'bp1-disabled-refusal')
})

// ---------------------------------------------------------------------------
// Scenario: bp1-disabled-refusal (enabled=false)
// ---------------------------------------------------------------------------
tap('row 25: enabled=false → bp1-disabled-refusal', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  const { fingerprint } = writeVerifyKey(path.join(homeDir, '.episodic-memory', '.verify-key'))
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  const hash = buildExpectedHash(proj)
  writeConfig(configPath, proj, {
    enabled: false,
    artifact_version_hash: `sha256:${hash}`,
    verify_key_id: fingerprint,
  })
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 2)
  assert.equal(r.parsed.code, 'bp1-disabled-refusal')
})

// ---------------------------------------------------------------------------
// Scenario: bp1-flag-version-drift (script content changed)
// ---------------------------------------------------------------------------
tap('row 26: script content drift → bp1-flag-version-drift', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  const { fingerprint } = writeVerifyKey(path.join(homeDir, '.episodic-memory', '.verify-key'))
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  // Create a bp1-foo.mjs and lock its hash
  const fooPath = path.join(proj, 'scripts', 'bp1-foo.mjs')
  fs.writeFileSync(fooPath, '// v1\n')
  const hashV1 = buildExpectedHash(proj)
  writeConfig(configPath, proj, {
    enabled: true,
    artifact_version_hash: `sha256:${hashV1}`,
    verify_key_id: fingerprint,
  })
  // Drift the script
  fs.writeFileSync(fooPath, '// v2 — content drifted\n')
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 2)
  assert.equal(r.parsed.code, 'bp1-flag-version-drift')
})

// ---------------------------------------------------------------------------
// Scenario: bp1-flag-key-drift (verify-key rotated)
// ---------------------------------------------------------------------------
tap('row 27: verify-key rotated post-activation → bp1-flag-key-drift', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  const verifyKeyPath = path.join(homeDir, '.episodic-memory', '.verify-key')
  const { fingerprint: fp1 } = writeVerifyKey(verifyKeyPath)
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  const hash = buildExpectedHash(proj)
  // Activated with fp1 fingerprint
  writeConfig(configPath, proj, {
    enabled: true,
    artifact_version_hash: `sha256:${hash}`,
    verify_key_id: fp1,
  })
  // Rotate the key without re-running activation
  fs.unlinkSync(verifyKeyPath)
  writeVerifyKey(verifyKeyPath)
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 2)
  assert.equal(r.parsed.code, 'bp1-flag-key-drift')
})

// ---------------------------------------------------------------------------
// Scenario: bp1-flag-config-corrupt (parse error)
// ---------------------------------------------------------------------------
tap('row 28: corrupt config json → bp1-flag-config-corrupt', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  writeVerifyKey(path.join(homeDir, '.episodic-memory', '.verify-key'))
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, '{not json')
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 2)
  assert.equal(r.parsed.code, 'bp1-flag-config-corrupt')
})

// ---------------------------------------------------------------------------
// Scenario: bp1-hmac-keyfile-fail (mode != 0600)
// ---------------------------------------------------------------------------
tap('row 29: verify-key chmod 0644 → bp1-hmac-keyfile-fail', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  const verifyKeyPath = path.join(homeDir, '.episodic-memory', '.verify-key')
  writeVerifyKey(verifyKeyPath, 0o644)
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ bp1: { activations: {} } }))
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 2)
  assert.equal(r.parsed.code, 'bp1-hmac-keyfile-fail')
  assert.equal(r.parsed.verify_key_state.reason, 'mode')
})

// ---------------------------------------------------------------------------
// Regression: manifest builder error during recomputation must surface as
// bp1-flag-version-drift, not raw Node exit. Codex P2 finding (round 2).
// ---------------------------------------------------------------------------
tap('regression: manifest builder error → bp1-flag-version-drift exit 2', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  const { fingerprint } = writeVerifyKey(path.join(homeDir, '.episodic-memory', '.verify-key'))
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  // Make the scripts dir unreadable so buildArtifactManifest throws on its
  // first readdirSync. Skip on roots that can read anything (tests run as
  // root in some CI containers); use chmod 0000.
  fs.chmodSync(path.join(proj, 'scripts'), 0o000)
  try {
    writeConfig(configPath, proj, {
      enabled: true,
      artifact_version_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      verify_key_id: fingerprint,
    })
    const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
    // Either the builder throws (preferred path under a non-root user) or
    // it returns a hash that doesn't match the all-zero placeholder. Both
    // paths must surface as version-drift, exit 2, structured JSON.
    assert.equal(r.exitCode, 2)
    assert.equal(r.parsed.code, 'bp1-flag-version-drift')
  } finally {
    fs.chmodSync(path.join(proj, 'scripts'), 0o755)
  }
})

// ---------------------------------------------------------------------------
// Regression: --project pointing to nonexistent path must fail-closed with
// structured exit 2 (not throw a raw ENOENT). Finding 1, MAJOR, code-review.
// ---------------------------------------------------------------------------
tap('regression: --project nonexistent → bp1-disabled-refusal exit 2', () => {
  const homeDir = makeTempDir('home')
  writeVerifyKey(path.join(homeDir, '.episodic-memory', '.verify-key'))
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ bp1: { activations: {} } }))
  const r = runFlagCheck({
    projectRoot: '/nonexistent/path/that/does/not/exist',
    configPath,
    env: { HOME: homeDir },
  })
  assert.equal(r.exitCode, 2, `expected exit 2; stdout=${r.stdout} stderr=${r.stderr}`)
  assert.ok(r.parsed)
  assert.equal(r.parsed.code, 'bp1-disabled-refusal')
})

// ---------------------------------------------------------------------------
// Scenario: bp1-hmac-keyfile-fail (missing)
// ---------------------------------------------------------------------------
tap('row 29: verify-key missing → bp1-hmac-keyfile-fail', () => {
  const proj = makeProjectRoot()
  const homeDir = makeTempDir('home')
  fs.mkdirSync(path.join(homeDir, '.episodic-memory'), { recursive: true })
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ bp1: { activations: {} } }))
  const r = runFlagCheck({ projectRoot: proj, configPath, env: { HOME: homeDir } })
  assert.equal(r.exitCode, 2)
  assert.equal(r.parsed.code, 'bp1-hmac-keyfile-fail')
  assert.equal(r.parsed.verify_key_state.reason, 'missing')
})

console.log(`\n1..${pass + fail}`)
if (fail) {
  console.log(`# FAILED ${fail} of ${pass + fail}`)
  process.exit(1)
} else {
  console.log(`# PASSED ${pass}`)
}
