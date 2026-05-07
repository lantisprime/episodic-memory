#!/usr/bin/env node
/**
 * test-bp1-deadline-sweep.mjs — Hermetic tests for the unified Path A + Path B
 * fallback executor.
 *
 * RFC-004 §556-577 (PR-1b-A). Tests the three must-have scenarios from the
 * Codex plan-review consensus (round 1 Q4.1):
 *   1. Activation/dry-run-bypass matrix (RFC §177, §563-571).
 *   2. Path A/B boundary scan (RFC §321/§385/§845 + §555/§177 + PR-1a
 *      bare-catch lesson for stale_or_corrupt classification).
 *   3. Concurrent/duplicate sweep idempotency (RFC §911-929, §973-981).
 *
 * Plus pure-helper unit tests for scripts/lib/bp1-sweep.mjs.
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
const SWEEP = path.join(REPO, 'scripts', 'bp1-deadline-sweep.mjs')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp1-sweep-${label}-`))
}

function makeProjectRoot() {
  const dir = makeTempDir('proj')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}

function projectSha(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot, 'utf8').digest('hex')
}

function writeVerifyKey(homeDir) {
  const verifyDir = path.join(homeDir, '.episodic-memory')
  fs.mkdirSync(verifyDir, { recursive: true })
  const verifyPath = path.join(verifyDir, '.verify-key')
  const key = crypto.randomBytes(32)
  fs.writeFileSync(verifyPath, key)
  fs.chmodSync(verifyPath, 0o600)
  const fp = crypto.createHmac('sha256', key)
    .update('verify-key-fingerprint-v1', 'utf8')
    .digest('hex').slice(0, 16)
  return { fingerprint: fp, path: verifyPath }
}

function writeConfig(homeDir, projectRoot, entry) {
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  const config = entry
    ? { bp1: { schema_version: 1, activations: { [projectRoot]: entry } } }
    : { bp1: { schema_version: 1, activations: {} } }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  return configPath
}

function buildHash(projectRoot) {
  const out = execFileSync('node', [
    path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    '--project', projectRoot, '--json',
  ], { encoding: 'utf8' })
  return JSON.parse(out).sha256
}

function runSweep({ projectRoot, homeDir, env, inputPath, allowEmit = false }) {
  const args = [SWEEP, '--once', '--project', projectRoot, '--json']
  if (!allowEmit) args.push('--no-emit')
  if (inputPath) args.push('--input', inputPath)
  const r = spawnSync('node', args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, ...(env || {}) },
  })
  return {
    exitCode: r.status, stdout: r.stdout, stderr: r.stderr,
    parsed: r.stdout ? safeParse(r.stdout) : null,
  }
}

function safeParse(s) {
  // Sweep prints two lines (human + json) by default; with --json it prints one.
  // Either way, the LAST non-empty line is the JSON record.
  const lines = s.trim().split('\n').filter(Boolean)
  try { return JSON.parse(lines[lines.length - 1]) } catch { return null }
}

function activationEntry(projectRoot, fingerprint) {
  return {
    enabled: true,
    artifact_version_hash: 'sha256:' + buildHash(projectRoot),
    enabled_at: new Date().toISOString(),
    enabled_via: 'test-fixture',
    verify_key_id: fingerprint,
  }
}

// =============================================================================
// Pure helper unit tests (scripts/lib/bp1-sweep.mjs)
// =============================================================================
const { scanForCandidates, PATH_A_TIMEOUT_MS, PATH_B_AGE_THRESHOLD_MS }
  = await import('../scripts/lib/bp1-sweep.mjs')

tap('pure: empty input → zero counts', () => {
  const r = scanForCandidates({ activeRuns: [], now: 1_000_000_000_000 })
  assert.equal(r.counts.path_a_candidate_count, 0)
  assert.equal(r.counts.path_b_candidate_count, 0)
  assert.equal(r.counts.runs_inspected_count, 0)
  assert.equal(r.counts.entries_inspected_count, 0)
  assert.equal(r.counts.stale_or_corrupt_count, 0)
})

tap('pure: rejects bad inputs (bare-catch P1 lesson)', () => {
  assert.throws(() => scanForCandidates({ activeRuns: 'not array', now: 0 }), /must be an array/)
  assert.throws(() => scanForCandidates({ activeRuns: [], now: 'not number' }), /must be a finite number/)
  assert.throws(() => scanForCandidates({ activeRuns: [], now: NaN }), /must be a finite number/)
})

// -----------------------------------------------------------------------------
// Must-have #2: Path A/B boundary scan (4 sub-cases + corrupt classification)
// -----------------------------------------------------------------------------
const NOW = 1_700_000_000_000

tap('boundary: Path A 29:59 below threshold → no candidate', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r1', codex_review_entries: [{
        entry_id: 'e1', created_at: NOW - 30 * 60 * 1000,
        request_sent: true, requested_at: NOW - (PATH_A_TIMEOUT_MS - 1000),
        response_received: false, cancelled: false,
      }],
    }],
  })
  assert.equal(r.counts.path_a_candidate_count, 0)
})

tap('boundary: Path A 30:00 at threshold → qualifies', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r1', codex_review_entries: [{
        entry_id: 'e1', created_at: NOW - 30 * 60 * 1000,
        request_sent: true, requested_at: NOW - PATH_A_TIMEOUT_MS,
        response_received: false, cancelled: false,
      }],
    }],
  })
  assert.equal(r.counts.path_a_candidate_count, 1)
  assert.equal(r.path_a_candidates[0].run_id, 'r1')
})

tap('boundary: Path B 4:59 below threshold → no candidate', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r1', codex_review_entries: [{
        entry_id: 'e1', created_at: NOW - (PATH_B_AGE_THRESHOLD_MS - 1000),
        request_sent: false, response_received: false, cancelled: false,
      }],
    }],
  })
  assert.equal(r.counts.path_b_candidate_count, 0)
})

tap('boundary: Path B 5:00 at threshold → qualifies', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r1', codex_review_entries: [{
        entry_id: 'e1', created_at: NOW - PATH_B_AGE_THRESHOLD_MS,
        request_sent: false, response_received: false, cancelled: false,
      }],
    }],
  })
  assert.equal(r.counts.path_b_candidate_count, 1)
  assert.equal(r.path_b_candidates[0].run_id, 'r1')
})

tap('boundary: corrupt created_at (string/null/missing/NaN) → counted stale, not actioned', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r1', codex_review_entries: [
        { entry_id: 'e1', created_at: 'oops', request_sent: false },
        { entry_id: 'e2', created_at: null, request_sent: false },
        { entry_id: 'e3', request_sent: false },                       // missing
        { entry_id: 'e4', created_at: NaN, request_sent: false },
      ],
    }],
  })
  assert.equal(r.counts.path_b_candidate_count, 0)
  assert.equal(r.counts.stale_or_corrupt_count, 4)
  assert.equal(r.counts.entries_inspected_count, 4)
})

tap('boundary: cancelled entry skipped regardless of age', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r1', codex_review_entries: [{
        entry_id: 'e1', created_at: NOW - 1_000_000_000,
        request_sent: false, cancelled: true,
      }],
    }],
  })
  assert.equal(r.counts.path_a_candidate_count, 0)
  assert.equal(r.counts.path_b_candidate_count, 0)
})

tap('boundary: Path A entry without requested_at → stale', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r1', codex_review_entries: [{
        entry_id: 'e1', created_at: NOW - 1_000_000,
        request_sent: true, response_received: false, cancelled: false,
        // requested_at missing
      }],
    }],
  })
  assert.equal(r.counts.path_a_candidate_count, 0)
  assert.equal(r.counts.stale_or_corrupt_count, 1)
})

tap('determinism: candidates sorted by run_id then entry_id', () => {
  const r = scanForCandidates({
    now: NOW,
    activeRuns: [{
      run_id: 'r-z', codex_review_entries: [
        { entry_id: 'e-b', created_at: NOW - PATH_B_AGE_THRESHOLD_MS, request_sent: false },
        { entry_id: 'e-a', created_at: NOW - PATH_B_AGE_THRESHOLD_MS, request_sent: false },
      ],
    }, {
      run_id: 'r-a', codex_review_entries: [
        { entry_id: 'e-z', created_at: NOW - PATH_B_AGE_THRESHOLD_MS, request_sent: false },
      ],
    }],
  })
  assert.deepEqual(r.path_b_candidates.map(c => `${c.run_id}/${c.entry_id}`),
    ['r-a/e-z', 'r-z/e-a', 'r-z/e-b'])
})

// =============================================================================
// Executor integration tests (scripts/bp1-deadline-sweep.mjs --once)
// =============================================================================

// -----------------------------------------------------------------------------
// Must-have #1: Activation/dry-run-bypass matrix (RFC §177, §563-571 v3.12)
// -----------------------------------------------------------------------------
tap('activation: no entry + no bypass → bp1-disabled-sweep, exit 0', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  writeVerifyKey(home)
  writeConfig(home, proj, null)
  const r = runSweep({ projectRoot: proj, homeDir: home })
  assert.equal(r.exitCode, 0, 'must exit 0 on disabled per RFC §177')
  assert.equal(r.parsed.status, 'disabled')
  assert.equal(r.parsed.reason, 'bp1-disabled-refusal')
})

// Codex post-PR-186 follow-up (episode 20260507-021838-...-4c0f): when
// caller cwd != --project, evidence MUST land under target project root,
// not caller cwd. Pre-fix `em-store --scope local` resolved the local
// store from cwd. Same class as the worktree/local-store miss.
tap('cwd != --project: evidence lands under TARGET project, not caller cwd', () => {
  const callerCwd = makeProjectRoot()
  const targetProj = makeProjectRoot()
  const home = makeTempDir('home')
  // No verify-key → bp1-hmac-keyfile-fail refusal path, which still emits
  // bp1-disabled-sweep evidence per RFC §177. Perfect for proving the
  // emission path lands under --project, not cwd.
  const r = spawnSync('node', [
    SWEEP, '--once', '--project', targetProj, '--json',
  ], {
    cwd: callerCwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  const parsed = safeParse(r.stdout)
  assert.equal(r.status, 0)
  assert.equal(parsed.evidence_emission.succeeded, 1,
    'emission must succeed (em-store path is reachable)')

  // Caller cwd MUST NOT have an episodes dir
  const callerEpisodesDir = path.join(callerCwd, '.episodic-memory', 'episodes')
  assert.ok(!fs.existsSync(callerEpisodesDir),
    `evidence must NOT land in caller cwd; found dir: ${callerEpisodesDir}`)

  // Target project MUST have at least one episode
  const targetEpisodesDir = path.join(targetProj, '.episodic-memory', 'episodes')
  assert.ok(fs.existsSync(targetEpisodesDir),
    `evidence must land in target --project's .episodic-memory/episodes`)
  const targetEpisodes = fs.readdirSync(targetEpisodesDir)
  assert.ok(targetEpisodes.length >= 1,
    `target project must have at least one disabled-sweep episode; got ${targetEpisodes.length}`)
  assert.ok(targetEpisodes.some(e => /bp1-disabled-sweep|bp1-hmac-keyfile-fail/.test(e)),
    'expected bp1-disabled-sweep evidence in target episodes')
})

// Codex code-review round 2 Finding 1: production-mode (non-`--no-emit`)
// disabled-sweep path must not crash on TDZ. Pre-fix this hit
// "Cannot access 'emissionStats' before initialization". Regression test.
tap('disabled-path WITHOUT --no-emit: production emit attempt does not crash, exit 0', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  writeVerifyKey(home)
  writeConfig(home, proj, null)
  // Run with allowEmit=true so the script attempts a real em-store invocation.
  // em-store is at scripts/em-store.mjs in the repo, so it'll try the call.
  const r = runSweep({ projectRoot: proj, homeDir: home, allowEmit: true })
  assert.equal(r.exitCode, 0, 'production disabled path must exit 0 (RFC §177)')
  assert.equal(r.parsed.status, 'disabled')
  assert.ok(r.parsed.evidence_emission,
    'disabled-path final JSON must carry evidence_emission')
})

tap('bypass: lock-only (env unset) → no bypass, refused', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  writeVerifyKey(home)
  writeConfig(home, proj, null)
  fs.writeFileSync(path.join(proj, '.episodic-memory', '.bp1-dry-run.lock'),
    JSON.stringify({ run_id: 'dry-1', ttl_until: Date.now() + 60_000,
      project_root_sha256: projectSha(proj) }))
  const r = runSweep({ projectRoot: proj, homeDir: home })
  assert.equal(r.parsed.status, 'disabled', 'env-unset must NOT bypass')
})

tap('bypass: env-only (lock missing) → no bypass, refused', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  writeVerifyKey(home)
  writeConfig(home, proj, null)
  const r = runSweep({
    projectRoot: proj, homeDir: home,
    env: { BP1_DRY_RUN_MODE: projectSha(proj) },
  })
  assert.equal(r.parsed.status, 'disabled', 'lock-missing must NOT bypass')
})

tap('bypass: lock + env both for ANOTHER project → no bypass (cross-project safety, RFC v3.12)', () => {
  const proj = makeProjectRoot()
  const otherProj = makeProjectRoot()
  const home = makeTempDir('home')
  writeVerifyKey(home)
  writeConfig(home, proj, null)
  // Lock contains OTHER project's sha
  fs.writeFileSync(path.join(proj, '.episodic-memory', '.bp1-dry-run.lock'),
    JSON.stringify({ run_id: 'cross-1', ttl_until: Date.now() + 60_000,
      project_root_sha256: projectSha(otherProj) }))
  const r = runSweep({
    projectRoot: proj, homeDir: home,
    env: { BP1_DRY_RUN_MODE: projectSha(otherProj) },
  })
  assert.equal(r.parsed.status, 'disabled',
    'cross-project bypass attempt must fail closed (CLI v3.11 F3 fix)')
})

tap('bypass: lock+env both match canonical root → bypass passes, sweep runs', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  writeVerifyKey(home)
  writeConfig(home, proj, null)  // no activation entry — bypass needed
  const sha = projectSha(proj)
  fs.writeFileSync(path.join(proj, '.episodic-memory', '.bp1-dry-run.lock'),
    JSON.stringify({ run_id: 'good-1', ttl_until: Date.now() + 60_000,
      project_root_sha256: sha }))
  const r = runSweep({
    projectRoot: proj, homeDir: home,
    env: { BP1_DRY_RUN_MODE: sha },
  })
  assert.equal(r.exitCode, 0)
  assert.equal(r.parsed.status, 'ok')
  assert.equal(r.parsed.mode, 'fallback', 'sweep is the fallback executor; mode is always fallback')
  assert.equal(r.parsed.activation_mode, 'dry_run', 'activation came via dry-run bypass')
  assert.equal(r.parsed.refusal_or_bypass, 'dry_run_bypass')
  assert.equal(r.parsed.dry_run_id, 'good-1')
})

tap('bypass: TTL expired → no bypass even with matching env+sha', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  writeVerifyKey(home)
  writeConfig(home, proj, null)
  const sha = projectSha(proj)
  fs.writeFileSync(path.join(proj, '.episodic-memory', '.bp1-dry-run.lock'),
    JSON.stringify({ run_id: 'expired', ttl_until: Date.now() - 60_000,
      project_root_sha256: sha }))
  const r = runSweep({
    projectRoot: proj, homeDir: home,
    env: { BP1_DRY_RUN_MODE: sha },
  })
  assert.equal(r.parsed.status, 'disabled', 'expired TTL must NOT bypass')
})

tap('activation: enabled entry → sweep runs (mode=fallback, activation_mode=native)', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const r = runSweep({ projectRoot: proj, homeDir: home })
  assert.equal(r.exitCode, 0)
  assert.equal(r.parsed.status, 'ok')
  assert.equal(r.parsed.mode, 'fallback', 'sweep is the fallback executor')
  assert.equal(r.parsed.activation_mode, 'native')
  assert.equal(r.parsed.refusal_or_bypass, 'activated')
  assert.equal(r.parsed.counts.path_a_candidate_count, 0)
})

// -----------------------------------------------------------------------------
// Must-have #3: idempotency primitives (within-invocation lock + stale reclaim)
//
// PR-1b-A scope: locks are within-invocation idempotency only. Persistent
// request-claim lifetime is M1 territory (RFC §911-929 with full TTL/HMAC
// contract). PR-1b-A's executor takes a per-entry lock during the action
// loop, emits the pending-m1 evidence, and releases the lock. Stale locks
// (older than LOCK_TTL_MS) MUST be reclaimable so a crashed prior process
// doesn't permanently block future sweeps.
// -----------------------------------------------------------------------------
tap('idempotency: within-invocation single candidate → exactly one pending_m1 emit', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const fixturePath = path.join(makeTempDir('fixture'), 'runs.json')
  fs.writeFileSync(fixturePath, JSON.stringify([{
    run_id: 'r-once', codex_review_entries: [{
      entry_id: 'e-1', created_at: Date.now() - PATH_B_AGE_THRESHOLD_MS - 60_000,
      request_sent: false,
    }],
  }]))
  const r = runSweep({ projectRoot: proj, homeDir: home, inputPath: fixturePath })
  assert.equal(r.parsed.status, 'ok')
  assert.equal(r.parsed.actions.length, 1)
  assert.equal(r.parsed.actions[0].action, 'pending_m1')
  assert.equal(r.parsed.action_count, 1, 'tick action_count must reflect the action loop')
})

tap('idempotency: stale lock (>60s old) reclaimed by next sweep', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const fixturePath = path.join(makeTempDir('fixture'), 'runs.json')
  fs.writeFileSync(fixturePath, JSON.stringify([{
    run_id: 'r-stale', codex_review_entries: [{
      entry_id: 'e-stale', created_at: Date.now() - PATH_B_AGE_THRESHOLD_MS - 60_000,
      request_sent: false,
    }],
  }]))
  // Pre-place a stale lock (claimed_at 5 minutes ago)
  const lockDir = path.join(proj, '.episodic-memory', 'bp1-locks')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'r-stale__e-stale.lock'),
    JSON.stringify({ pid: 999_999, claimed_at: Date.now() - 5 * 60_000 }))
  const r = runSweep({ projectRoot: proj, homeDir: home, inputPath: fixturePath })
  assert.equal(r.parsed.actions[0].action, 'pending_m1',
    'stale lock must be reclaimed (RFC §909 60s TTL contract)')
})

tap('idempotency: fresh lock (<60s old) blocks second sweep', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const fixturePath = path.join(makeTempDir('fixture'), 'runs.json')
  fs.writeFileSync(fixturePath, JSON.stringify([{
    run_id: 'r-fresh', codex_review_entries: [{
      entry_id: 'e-fresh', created_at: Date.now() - PATH_B_AGE_THRESHOLD_MS - 60_000,
      request_sent: false,
    }],
  }]))
  // Pre-place a FRESH lock (claimed 5s ago) — simulates a concurrent process
  const lockDir = path.join(proj, '.episodic-memory', 'bp1-locks')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'r-fresh__e-fresh.lock'),
    JSON.stringify({ pid: 123, claimed_at: Date.now() - 5_000 }))
  const r = runSweep({ projectRoot: proj, homeDir: home, inputPath: fixturePath })
  assert.equal(r.parsed.actions[0].action, 'skipped_locked',
    'fresh lock must block — only stale locks are reclaimed')
})

tap('idempotency: corrupt lock body treated as stale and reclaimed', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const fixturePath = path.join(makeTempDir('fixture'), 'runs.json')
  fs.writeFileSync(fixturePath, JSON.stringify([{
    run_id: 'r-corrupt', codex_review_entries: [{
      entry_id: 'e-corrupt', created_at: Date.now() - PATH_B_AGE_THRESHOLD_MS - 60_000,
      request_sent: false,
    }],
  }]))
  const lockDir = path.join(proj, '.episodic-memory', 'bp1-locks')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'r-corrupt__e-corrupt.lock'), '{not json')
  const r = runSweep({ projectRoot: proj, homeDir: home, inputPath: fixturePath })
  assert.equal(r.parsed.actions[0].action, 'pending_m1',
    'corrupt lock body must be treated as stale and reclaimed')
})

// -----------------------------------------------------------------------------
// Edge: --once flag enforced
// -----------------------------------------------------------------------------
tap('cli: missing --once → exit 2', () => {
  const r = spawnSync('node', [SWEEP, '--no-emit'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--once is required/)
})

tap('cli: malformed --input file → load_issue surfaced in final JSON', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const badInput = path.join(makeTempDir('bad'), 'bad.json')
  fs.writeFileSync(badInput, '{not json')
  const r = runSweep({ projectRoot: proj, homeDir: home, inputPath: badInput })
  assert.equal(r.exitCode, 0,
    'malformed input is operator-visible but must not crash the sweep')
  assert.equal(r.parsed.counts.runs_inspected_count, 0)
  assert.ok(r.parsed.load_issue, 'final JSON must surface load_issue (Codex round 1 Finding 3)')
  assert.equal(r.parsed.load_issue.code, 'active_runs_load_error')
})

// -----------------------------------------------------------------------------
// Codex code-review round 1 Finding 3: emission status + load_issue surfaced
// in final JSON.
// -----------------------------------------------------------------------------
tap('observability: --no-emit yields evidence_emission with zero attempts', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const r = runSweep({ projectRoot: proj, homeDir: home })
  assert.ok(r.parsed.evidence_emission, 'final JSON must carry evidence_emission')
  assert.equal(r.parsed.evidence_emission.attempted, 0,
    '--no-emit means zero emission attempts')
})

tap('observability: load_issue is null when load is clean', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const r = runSweep({ projectRoot: proj, homeDir: home })
  // Either null or undefined per JSON serialization of explicit null
  assert.ok(r.parsed.load_issue === null || r.parsed.load_issue === undefined,
    'no load issue when load is clean')
})

tap('tick schema D4: action_count, refusal_or_bypass, project_root_sha256 surfaced', () => {
  const proj = makeProjectRoot()
  const home = makeTempDir('home')
  const vk = writeVerifyKey(home)
  writeConfig(home, proj, activationEntry(proj, vk.fingerprint))
  const fixturePath = path.join(makeTempDir('fixture'), 'runs.json')
  fs.writeFileSync(fixturePath, JSON.stringify([{
    run_id: 'r-tick', codex_review_entries: [{
      entry_id: 'e-tick', created_at: Date.now() - PATH_B_AGE_THRESHOLD_MS - 60_000,
      request_sent: false,
    }],
  }]))
  const r = runSweep({ projectRoot: proj, homeDir: home, inputPath: fixturePath })
  assert.equal(typeof r.parsed.project_root_sha256, 'string')
  assert.equal(r.parsed.project_root_sha256.length, 64, 'sha256 hex')
  assert.equal(r.parsed.action_count, 1)
  assert.equal(r.parsed.refusal_or_bypass, 'activated')
  assert.equal(r.parsed.mode, 'fallback')
})

console.log(`\n1..${pass + fail}`)
if (fail) { console.log(`# FAILED ${fail} of ${pass + fail}`); process.exit(1) }
else console.log(`# PASSED ${pass}`)
