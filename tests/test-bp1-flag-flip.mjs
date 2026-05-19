#!/usr/bin/env node
/**
 * test-bp1-flag-flip.mjs — slice 2f flag-flip CLI tests.
 *
 * Coverage:
 *   FF1  --enable stub exits 5 with M5 message
 *   FF2  --dry-run-on stub exits 5
 *   FF3  --dry-run-off stub exits 5
 *   FF4  --disable on non-git path → exit 2, no config mutation, no marker rm
 *   FF5  --disable, no config exists → idempotent ok + bp1-disable-already evidence
 *   FF6  --disable, config exists but entry absent → idempotent + sweeps markers
 *   FF7  --disable, entry present + no markers → entry removed, marker_rm_count=0
 *   FF8  --disable, entry present + N markers → entry removed, all N markers swept
 *   FF9  --disable preserves sibling-project's activation entry (RFC §216 A6)
 *   FF10 --disable emits bp1-activation-disabled + per-marker bp1-disable-marker-rm
 *   FF11 --disable + missing verify-key → verify_key_id null in output, still ok
 *   FF12 missing argv → exit 2
 *   FF13 unknown subcommand → exit 2
 *   FF14 --disable atomically rewrites config (tmp + rename leaves no junk)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const FLIP = path.join(REPO, 'scripts', 'bp1-flag-flip.mjs')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ff-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ff-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeNonGit() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ff-nongit-')))
}
function writeKey(homeDir) {
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/.verify-key'),
    crypto.randomBytes(32), { mode: 0o600 })
}
function writeActivationEntry(homeDir, projectRoot) {
  const config = {
    bp1: {
      schema_version: 1,
      activations: {
        [projectRoot]: {
          enabled: true,
          artifact_version_hash: 'sha256:' + 'a'.repeat(64),
          enabled_at: new Date().toISOString(),
          enabled_via: 'test-fixture',
          verify_key_id: '0123456789abcdef',
        },
      },
    },
  }
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/config.json'),
    JSON.stringify(config, null, 2))
}
function writeMarkerFile(projectRoot, runId) {
  const dir = path.join(projectRoot, '.checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `bp1-approval-${runId}.json`), JSON.stringify({ run_id: runId }))
}
function runFlip(args, homeDir, cwd) {
  return spawnSync('node', [FLIP, ...args], {
    cwd: cwd ?? REPO, encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  })
}

// =============================================================================
// Stubs (FF1-FF3)
// =============================================================================

tap('FF1 --enable stub exits 5 with M5 message', () => {
  const home = makeHome()
  const r = runFlip(['--enable', '/tmp/anything'], home)
  assert.equal(r.status, 5)
  assert.match(r.stderr, /M5 not yet shipped/)
})

tap('FF2 --dry-run-on stub exits 5', () => {
  const home = makeHome()
  const r = runFlip(['--dry-run-on', 'some-run-id'], home)
  assert.equal(r.status, 5)
  assert.match(r.stderr, /M5 not yet shipped/)
})

tap('FF3 --dry-run-off stub exits 5', () => {
  const home = makeHome()
  const r = runFlip(['--dry-run-off'], home)
  assert.equal(r.status, 5)
  assert.match(r.stderr, /M5 not yet shipped/)
})

// =============================================================================
// FF4 non-git --project
// =============================================================================

tap('FF4 --disable on non-git path → exit 2, no config mutation', () => {
  const home = makeHome()
  const nonGit = makeNonGit()
  writeActivationEntry(home, '/some/other/project')
  const before = fs.readFileSync(path.join(home, '.episodic-memory/config.json'), 'utf8')
  const r = runFlip(['--disable', nonGit], home)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /not a git repository/)
  const after = fs.readFileSync(path.join(home, '.episodic-memory/config.json'), 'utf8')
  assert.equal(before, after, 'config must NOT be mutated on non-git path')
})

// =============================================================================
// FF5 no config exists
// =============================================================================

tap('FF5 --disable when no config exists → ok idempotent + disable-already evidence', () => {
  const home = makeHome()
  const proj = makeProj()
  const r = runFlip(['--disable', proj], home)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.status, 'ok')
  assert.equal(out.action, 'already-absent')
  assert.equal(out.reason, 'config-missing')
  // Idempotent evidence written
  const epDir = path.join(proj, '.episodic-memory/episodes')
  const files = fs.readdirSync(epDir)
  const da = files.find(f => f.startsWith('bp1-disable-already-'))
  assert.ok(da, `bp1-disable-already evidence must exist; have: ${files.join(', ')}`)
})

// =============================================================================
// FF6 config exists but entry absent
// =============================================================================

tap('FF6 --disable when entry absent → idempotent + sweeps markers anyway', () => {
  const home = makeHome()
  const proj = makeProj()
  // Config exists with a different project's entry — not ours.
  writeActivationEntry(home, '/some/other/project')
  // Plant a stale marker that should still get swept.
  writeMarkerFile(proj, 'stale-run-x')
  const r = runFlip(['--disable', proj], home)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.action, 'already-absent')
  assert.equal(out.reason, 'entry-absent')
  assert.equal(out.marker_rm_count, 1)
  assert.equal(fs.existsSync(path.join(proj, '.checkpoints', 'bp1-approval-stale-run-x.json')), false)
})

// =============================================================================
// FF7 entry present + 0 markers
// =============================================================================

tap('FF7 --disable removes entry; marker_rm_count=0 when no markers', () => {
  const home = makeHome()
  const proj = makeProj()
  writeKey(home)
  writeActivationEntry(home, proj)
  const r = runFlip(['--disable', proj], home)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.action, 'disabled')
  assert.equal(out.marker_rm_count, 0)
  // Config no longer has our entry.
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.episodic-memory/config.json'), 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.bp1.activations, proj), false)
})

// =============================================================================
// FF8 entry present + N markers
// =============================================================================

tap('FF8 --disable removes entry + sweeps N markers', () => {
  const home = makeHome()
  const proj = makeProj()
  writeKey(home)
  writeActivationEntry(home, proj)
  writeMarkerFile(proj, 'r1')
  writeMarkerFile(proj, 'r2')
  writeMarkerFile(proj, 'r3')
  const r = runFlip(['--disable', proj], home)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.action, 'disabled')
  assert.equal(out.marker_rm_count, 3)
  for (const rid of ['r1', 'r2', 'r3']) {
    assert.equal(
      fs.existsSync(path.join(proj, '.checkpoints', `bp1-approval-${rid}.json`)), false,
      `marker for ${rid} must be removed`)
  }
})

// =============================================================================
// FF9 sibling-project entry preserved (RFC §216 A6)
// =============================================================================

tap('FF9 --disable preserves sibling-project activation entry (A6)', () => {
  const home = makeHome()
  const projA = makeProj()
  const projB = makeProj()
  writeKey(home)
  // Both projects activated.
  const config = {
    bp1: {
      schema_version: 1,
      activations: {
        [projA]: { enabled: true, artifact_version_hash: 'sha256:' + 'a'.repeat(64),
          enabled_at: new Date().toISOString(), enabled_via: 'test', verify_key_id: 'fp-a' },
        [projB]: { enabled: true, artifact_version_hash: 'sha256:' + 'b'.repeat(64),
          enabled_at: new Date().toISOString(), enabled_via: 'test', verify_key_id: 'fp-b' },
      },
    },
  }
  fs.writeFileSync(path.join(home, '.episodic-memory/config.json'),
    JSON.stringify(config, null, 2))
  const r = runFlip(['--disable', projA], home)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.episodic-memory/config.json'), 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.bp1.activations, projA), false,
    `projA entry must be removed`)
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.bp1.activations, projB), true,
    `projB entry MUST be preserved (RFC §216 A6)`)
})

// =============================================================================
// FF10 emits bp1-activation-disabled + per-marker bp1-disable-marker-rm
// =============================================================================

tap('FF10 --disable emits activation-disabled + per-marker disable-marker-rm', () => {
  const home = makeHome()
  const proj = makeProj()
  writeKey(home)
  writeActivationEntry(home, proj)
  writeMarkerFile(proj, 'evt-1')
  writeMarkerFile(proj, 'evt-2')
  const r = runFlip(['--disable', proj], home)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.ok(out.activation_disabled_episode_path, 'activation-disabled episode path surfaced')
  assert.ok(fs.existsSync(out.activation_disabled_episode_path))
  const parentRaw = fs.readFileSync(out.activation_disabled_episode_path, 'utf8')
  assert.match(parentRaw, /tags: \["bp1-activation-disabled"\]/)
  assert.match(parentRaw, /disabled_via: "bp1-flag-flip"/)
  assert.equal(out.marker_rm_episode_paths.length, 2)
  for (const cp of out.marker_rm_episode_paths) {
    assert.ok(fs.existsSync(cp), `child episode ${cp} must exist`)
    const raw = fs.readFileSync(cp, 'utf8')
    assert.match(raw, /tags: \["bp1-disable-marker-rm"\]/)
    assert.match(raw, /marker_path: "/)
    assert.match(raw, /run_id: "evt-/)
  }
})

// =============================================================================
// FF11 missing verify-key tolerated (forensic null)
// =============================================================================

tap('FF11 --disable + missing verify-key → verify_key_id null, still ok', () => {
  const home = makeHome()
  const proj = makeProj()
  // NO writeKey() → no .verify-key
  writeActivationEntry(home, proj)
  const r = runFlip(['--disable', proj], home)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.verify_key_id, null)
  assert.equal(out.action, 'disabled')
})

// =============================================================================
// FF12 missing argv
// =============================================================================

tap('FF12 missing argv → exit 2', () => {
  const home = makeHome()
  const r = runFlip([], home)
  assert.equal(r.status, 2)
})

// =============================================================================
// FF13 unknown subcommand
// =============================================================================

tap('FF13 unknown subcommand → exit 2', () => {
  const home = makeHome()
  const r = runFlip(['--bogus'], home)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown-subcommand/)
})

// =============================================================================
// FF14 atomic config write — no orphan tmp
// =============================================================================

tap('FF14 --disable leaves no orphan tmp files in HOME config dir', () => {
  const home = makeHome()
  const proj = makeProj()
  writeKey(home)
  writeActivationEntry(home, proj)
  runFlip(['--disable', proj], home)
  const dir = path.join(home, '.episodic-memory')
  const entries = fs.readdirSync(dir)
  const tmps = entries.filter(n => n.includes('config.json.tmp.'))
  assert.equal(tmps.length, 0, `no .tmp.* orphans; found: ${tmps.join(', ')}`)
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
