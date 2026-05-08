#!/usr/bin/env node
/**
 * test-bp1-orchestrator-init-run.mjs — orchestrator init-run E2E tests.
 *
 * Coverage (plan v4):
 *   - IR1: happy path; run.key + episode + index updated.
 *   - IR2: inactive project (flag-check refuses).
 *   - IR3a/b/c: caller_cwd != --project / linked-worktree → artifacts under target only.
 *   - IR4: missing --project flag.
 *   - IR5: episode signature verifies with run.key (E2E roundtrip).
 *   - IR6: 5 #185 canonical fields appear in emitted episode frontmatter.
 *   - IR7: run.key bytes never echoed in stdout / stderr / episode body (I4).
 *   - IR9: verify-key fingerprint mismatch → fail closed; no run dir.
 *   - IR10: verify-key missing in sandbox HOME → fail closed.
 *   - IR12: verify-key mode 0644 → fail closed.
 *   - IR-collision: pre-seeded run_id in index → second init-run errors collision.
 *
 * Out of scope here:
 *   - IR8 concurrent init-run (covered by run-state RC-LOCK1).
 *   - FF2 end-to-end install.mjs invocation (install.mjs is unchanged in this PR;
 *     gitignore handling is exercised by tests/test-install-bp1-runkey-gitignore.mjs).
 *
 * Fixture template (FF1 absolute-path; B3 sandbox HOME) follows lesson
 * `20260507-102705-test-fixture-symlinks-pre-staging-mask-r-7efe`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ORCHESTRATOR = path.join(REPO, 'scripts', 'bp1-orchestrator.mjs')
const ARTIFACT_BUILDER = path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs')

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { signCanonical, verifyCanonical, verifyKeyFingerprint } = hmacMod

const cmod = await import(new URL('../scripts/lib/bp1-canonicalize.mjs', import.meta.url).href)
const { canonicalize } = cmod

// Top-level dynamic import for run-state lib (used by IR-collision test).
// Codex round-1 C1: previously imported inside an async tap callback, which
// the synchronous tap() never awaited — produced a false-positive ok.
const rsmod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// =============================================================================
// Sandbox fixture builders
// =============================================================================

function makeSandboxProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-orch-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}

function makeSandboxHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-orch-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}

function makeSandboxCaller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-orch-caller-'))
  return fs.realpathSync(dir)
}

function writeVerifyKey(homeDir) {
  const keyBytes = crypto.randomBytes(32)
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/.verify-key'), keyBytes, { mode: 0o600 })
  return { keyBytes, fingerprint: verifyKeyFingerprint(keyBytes) }
}

function buildHashAgainstProject(projectRoot, homeDir) {
  const out = execFileSync(
    'node',
    [ARTIFACT_BUILDER, '--project', projectRoot, '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: homeDir } },
  )
  return JSON.parse(out).sha256
}

function activeActivation(projectRoot, homeDir, fingerprint) {
  return {
    enabled: true,
    artifact_version_hash: 'sha256:' + buildHashAgainstProject(projectRoot, homeDir),
    enabled_at: new Date().toISOString(),
    enabled_via: 'test-fixture',
    verify_key_id: fingerprint,
  }
}

function writeConfig(homeDir, projectRoot, entry) {
  const configPath = path.join(homeDir, '.episodic-memory/config.json')
  const config = entry
    ? { bp1: { schema_version: 1, activations: { [projectRoot]: entry } } }
    : { bp1: { schema_version: 1, activations: {} } }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function runOrchestrator({ project, rfcId = 'TEST', callerCwd, homeDir, env }) {
  const argv = ['init-run']
  if (project !== undefined) argv.push('--project', project)
  if (rfcId !== undefined && rfcId !== null) argv.push('--rfc-id', rfcId)
  return spawnSync(
    'node',
    [ORCHESTRATOR, ...argv],
    {
      cwd: callerCwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, ...(env || {}) },
    },
  )
}

function listEpisodes(projectRoot) {
  const dir = path.join(projectRoot, '.episodic-memory', 'episodes')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

function listRunDirs(projectRoot) {
  const dir = path.join(projectRoot, '.episodic-memory', 'runs')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(n => n.startsWith('bp1-run-'))
}

function setupActiveProject() {
  const project = makeSandboxProject()
  const home = makeSandboxHome()
  const { fingerprint } = writeVerifyKey(home)
  writeConfig(home, project, activeActivation(project, home, fingerprint))
  return { project, home }
}

// =============================================================================
// IR1 — happy path
// =============================================================================
tap('IR1 happy path: active project → run_id minted, run.key written, episode emitted, index updated', () => {
  const { project, home } = setupActiveProject()
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 0, `orchestrator failed: stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.match(out.run_id, /^bp1-run-\d+-test-[0-9a-f]{6}$/, `unexpected run_id: ${out.run_id}`)
  assert.ok(out.episode_id)
  // run.key written project-local at mode 0600.
  const keyPath = path.join(project, '.episodic-memory/runs', out.run_id, 'run.key')
  const stat = fs.statSync(keyPath)
  assert.equal(stat.mode & 0o777, 0o600)
  assert.equal(stat.size, 32)
  // Episode file written.
  const episodes = listEpisodes(project)
  assert.equal(episodes.length, 1)
  // Run-state index has the run.
  const idxPath = path.join(project, '.episodic-memory/runs/_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  assert.ok(idx.runs[out.run_id])
  assert.equal(idx.runs[out.run_id].state, 'active')
})

// =============================================================================
// IR2 — inactive project (flag-check refuses)
// =============================================================================
tap('IR2 inactive project (flag-check refuses) → exit 1; no run dir', () => {
  const project = makeSandboxProject()
  const home = makeSandboxHome()
  writeVerifyKey(home)
  writeConfig(home, project, null)  // empty activations → inactive
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 1)
  assert.equal(listRunDirs(project).length, 0)
})

// =============================================================================
// IR3a — caller_cwd != --project: run.key + episode + index under target only
// =============================================================================
tap('IR3a caller_cwd != --project: artifacts under target; absent at caller; HOME unchanged', () => {
  const { project, home } = setupActiveProject()
  const caller = makeSandboxCaller()
  // Capture HOME .episodic-memory state before.
  const homeBefore = JSON.stringify(fs.readdirSync(path.join(home, '.episodic-memory')))
  const r = runOrchestrator({ project, callerCwd: caller, homeDir: home })
  assert.equal(r.status, 0, `orchestrator failed: stderr=${r.stderr}`)
  // Artifacts under target.
  assert.ok(listRunDirs(project).length === 1)
  assert.ok(listEpisodes(project).length === 1)
  // Caller has NO bp1 artifacts.
  assert.ok(!fs.existsSync(path.join(caller, '.episodic-memory')))
  // HOME .episodic-memory only adds nothing new (verify-key + config.json existed before).
  const homeAfter = JSON.stringify(fs.readdirSync(path.join(home, '.episodic-memory')))
  assert.equal(homeBefore, homeAfter, 'HOME .episodic-memory must be unchanged')
})

// =============================================================================
// IR3b — linked worktree: caller=main repo, --project=worktree
// (Approximated via sandbox project + sandbox caller — same shape.)
// =============================================================================
tap('IR3b linked-worktree shape (caller in different sandbox project): artifacts under target only', () => {
  const { project, home } = setupActiveProject()
  const callerProject = makeSandboxProject()
  const r = runOrchestrator({ project, callerCwd: callerProject, homeDir: home })
  assert.equal(r.status, 0, `orchestrator failed: stderr=${r.stderr}`)
  assert.equal(listRunDirs(project).length, 1)
  // Caller's .episodic-memory dir was created (by `git init` and the test) but
  // has NO bp1 runs.
  assert.equal(listRunDirs(callerProject).length, 0)
  assert.equal(listEpisodes(callerProject).length, 0)
})

// =============================================================================
// IR4 — missing --project flag
// =============================================================================
tap('IR4 missing --project flag → exit 2', () => {
  const home = makeSandboxHome()
  const r = runOrchestrator({ project: undefined, callerCwd: home, homeDir: home })
  assert.equal(r.status, 2)
})

// =============================================================================
// IR5 — episode signature verifies with run.key
// =============================================================================
tap('IR5 episode signature verifies with run.key (E2E sign+verify roundtrip)', () => {
  const { project, home } = setupActiveProject()
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 0)
  const { run_id, episode_id } = JSON.parse(r.stdout)
  // Read run.key.
  const keyPath = path.join(project, '.episodic-memory/runs', run_id, 'run.key')
  const runKey = fs.readFileSync(keyPath)
  // Read episode + parse frontmatter (minimal).
  const episodePath = path.join(project, '.episodic-memory/episodes', episode_id + '.md')
  const text = fs.readFileSync(episodePath, 'utf8')
  const fmEnd = text.indexOf('\n---\n', 4)
  const fmText = text.slice(4, fmEnd)
  const body = text.slice(fmEnd + 5)
  // Extract hmac_signature.
  const hmacMatch = fmText.match(/^hmac_signature:\s*([0-9a-f]+)/m)
  assert.ok(hmacMatch, 'episode must have hmac_signature')
  const sigHex = hmacMatch[1]
  // Reconstruct frontmatter object minimally for canonicalize.
  const fmObj = parseSimpleYaml(fmText)
  const { canonicalBytes } = canonicalize(fmObj, body)
  const ok = verifyCanonical(canonicalBytes, runKey, sigHex)
  assert.equal(ok, true, `episode signature must verify with run.key; sig=${sigHex.slice(0, 16)}...`)
})

function parseSimpleYaml(text) {
  const obj = {}
  for (const line of text.split('\n')) {
    const t = line.trimEnd()
    if (!t || t.startsWith('#')) continue
    const ci = t.indexOf(':')
    if (ci === -1) continue
    const k = t.slice(0, ci).trim()
    const raw = t.slice(ci + 1).trim()
    obj[k] = parseScalar(raw)
  }
  return obj
}
function parseScalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    return inner ? inner.split(',').map(s => parseScalar(s.trim())) : []
  }
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.endsWith(raw[0])) {
    return raw.slice(1, -1)
  }
  return raw
}

// =============================================================================
// IR6 — 5 #185 canonical fields appear in emitted episode
// =============================================================================
tap('IR6 5 #185 canonical fields appear in emitted episode frontmatter', () => {
  const { project, home } = setupActiveProject()
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 0)
  const { episode_id } = JSON.parse(r.stdout)
  const episodePath = path.join(project, '.episodic-memory/episodes', episode_id + '.md')
  const text = fs.readFileSync(episodePath, 'utf8')
  for (const field of ['scheduled_tasks_capability', 'probe_reason', 'degraded_mode_statement',
                       'native_probe_performed', 't2_fallback']) {
    assert.match(text, new RegExp(`^${field}:`, 'm'),
      `episode frontmatter missing ${field}`)
  }
})

// =============================================================================
// IR7 — run.key bytes never echoed in stdout/stderr/episode body (I4)
// =============================================================================
tap('IR7 (I4) run.key bytes never echoed in stdout, stderr, or episode body', () => {
  const { project, home } = setupActiveProject()
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 0)
  const { run_id } = JSON.parse(r.stdout)
  const keyPath = path.join(project, '.episodic-memory/runs', run_id, 'run.key')
  const runKey = fs.readFileSync(keyPath)
  // Compute hex + base64 representations (paranoid grep).
  const hexKey = runKey.toString('hex')
  const b64Key = runKey.toString('base64')
  // Search stdout / stderr.
  assert.ok(!r.stdout.includes(hexKey), 'stdout must NOT contain run.key hex')
  assert.ok(!r.stdout.includes(b64Key), 'stdout must NOT contain run.key base64')
  assert.ok(!r.stderr.includes(hexKey), 'stderr must NOT contain run.key hex')
  // Search episode body bytes.
  const episodes = listEpisodes(project)
  assert.equal(episodes.length, 1)
  const epPath = path.join(project, '.episodic-memory/episodes', episodes[0])
  const epBytes = fs.readFileSync(epPath)
  // Buffer.indexOf matches raw bytes — strongest check.
  assert.equal(epBytes.indexOf(runKey), -1, 'episode file must NOT contain raw run.key bytes')
  const epText = epBytes.toString('utf8')
  assert.ok(!epText.includes(hexKey), 'episode text must NOT contain run.key hex')
  assert.ok(!epText.includes(b64Key), 'episode text must NOT contain run.key base64')
})

// =============================================================================
// IR9 — verify-key fingerprint mismatch vs activation map → fail closed
// =============================================================================
tap('IR9 verify-key fingerprint mismatch vs activation map → exit 1; bp1-flag-key-drift surfaced', () => {
  const project = makeSandboxProject()
  const home = makeSandboxHome()
  writeVerifyKey(home)  // generates real fingerprint
  // Activation entry has a BOGUS verify_key_id.
  const bogus = {
    enabled: true,
    artifact_version_hash: 'sha256:' + buildHashAgainstProject(project, home),
    enabled_at: new Date().toISOString(),
    enabled_via: 'test-fixture',
    verify_key_id: 'deadbeefdeadbeef',  // bogus — won't match
  }
  writeConfig(home, project, bogus)
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 1)
  assert.equal(listRunDirs(project).length, 0)
  // Codex round-1 B1 fix: orchestrator surfaces flag-check stdout (structured
  // failure JSON) to operators. The fingerprint-mismatch failure code is
  // bp1-flag-key-drift (RFC-004 row 27).
  assert.match(r.stderr, /bp1-flag-key-drift/, 'stderr must surface bp1-flag-key-drift code')
})

// =============================================================================
// IR10 — verify-key missing in sandbox HOME
// =============================================================================
tap('IR10 verify-key missing in sandbox HOME → flag-check refuses; exit 1; bp1-hmac-keyfile-fail surfaced', () => {
  const project = makeSandboxProject()
  const home = makeSandboxHome()
  // No verify-key written.
  writeConfig(home, project, {
    enabled: true,
    artifact_version_hash: 'sha256:placeholder',
    verify_key_id: 'deadbeefdeadbeef',
  })
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 1)
  assert.equal(listRunDirs(project).length, 0)
  // Codex round-1 B1 fix: orchestrator surfaces structured failure code
  // (bp1-hmac-keyfile-fail per RFC-004 row 29).
  assert.match(r.stderr, /bp1-hmac-keyfile-fail/, 'stderr must surface bp1-hmac-keyfile-fail code')
})

// =============================================================================
// IR12 — verify-key mode 0644 → fail closed
// =============================================================================
tap('IR12 verify-key mode 0644 in sandbox HOME → flag-check refuses; bp1-hmac-keyfile-fail surfaced', () => {
  const { project, home } = setupActiveProject()
  // Drop verify-key mode after setup.
  fs.chmodSync(path.join(home, '.episodic-memory/.verify-key'), 0o644)
  const r = runOrchestrator({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 1)
  assert.equal(listRunDirs(project).length, 0)
  // Codex round-1 B1 fix: mode-drift falls under bp1-hmac-keyfile-fail.
  assert.match(r.stderr, /bp1-hmac-keyfile-fail/, 'stderr must surface bp1-hmac-keyfile-fail code')
})

// =============================================================================
// IR-collision — pre-seeded run_id in index → second init-run errors collision
// (Hard to force a real RNG collision; instead pre-seed the index with
// a synthetic run_id that init-run might mint. We can't predict the rand6,
// so this is a synthetic check via direct appendRun.)
// =============================================================================
tap('IR-collision (synthetic via appendRun) — appendRun for existing run_id returns collision', () => {
  // Synchronous body using top-level-imported rsmod (codex C1 fix).
  const { project } = setupActiveProject()
  const synthRunId = 'bp1-run-12345-synthetic-aabbcc'
  rsmod.appendRun(project, synthRunId, project)
  const r = rsmod.appendRun(project, synthRunId, project)
  assert.equal(r.error, 'collision')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
