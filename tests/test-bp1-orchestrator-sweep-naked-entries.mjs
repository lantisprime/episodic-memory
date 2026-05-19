#!/usr/bin/env node
/**
 * test-bp1-orchestrator-sweep-naked-entries.mjs — slice 2f Path B sweep tick.
 *
 * Mirrors test-bp1-check-deadlines.mjs coverage shape. Slice 2f's sweep-
 * naked-entries subcommand consumes scripts/lib/bp1-sweep-loader.mjs +
 * scripts/lib/bp1-sweep.mjs (scanForCandidates) and emits one parent tick +
 * per-candidate children (signed when run.key available, unsigned no-key
 * audit when not) + always an unsigned action-pending-m3 hand-off.
 *
 * Cases:
 *   NS1  no runs in project → tick emitted, candidate_count=0, exit 0
 *   NS2  activation disabled (no config) → tick activation=disabled,
 *        candidate_count=0; tick lands under projectRoot
 *   NS3  one naked codex_review entry past threshold → detected + no-key audit
 *        (no run.key written) + action-pending-m3 hand-off file
 *   NS4  invalid --tick-source → exit 2
 *   NS5  missing --project → exit 2
 *   NS6  --tick-source fallback-sweep flows into tick frontmatter
 *   NS7  caller cwd != projectRoot → tick lands under projectRoot, not cwd
 *   NS8  run-state lock busy → bp1-lock-busy evidence + tick lock_busy=true
 *   NS9  RFC §104: --project <subdir-of-git> → tick lands at git toplevel
 *   NS10 corrupt bp1-runs state.json → counted as stale_or_corrupt
 *   NS11 entry below threshold (created_at <5min ago) → NOT a candidate
 *   NS12 entry with request_sent=true (Path A territory) → not Path B candidate
 *   NS13 multiple naked entries across runs → all detected; sorted by run/entry
 *   NS14 action-pending-m3 emit happens for every candidate, including no-key
 *   NS15 signed detected child carries entry_id + age_ms + threshold_ms canonical
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ORCH = path.join(REPO, 'scripts', 'bp1-orchestrator.mjs')
const ARTIFACT_BUILDER = path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs')

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyKeyFingerprint } = hmacMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ns-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ns-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}
function writeKey(homeDir) {
  const key = crypto.randomBytes(32)
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/.verify-key'), key, { mode: 0o600 })
  return verifyKeyFingerprint(key)
}
function buildHash(projectRoot, homeDir) {
  return JSON.parse(execFileSync('node', [ARTIFACT_BUILDER, '--project', projectRoot, '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: homeDir } })).sha256
}
function writeConfig(homeDir, projectRoot, fingerprint) {
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/config.json'),
    JSON.stringify({
      bp1: {
        schema_version: 1,
        activations: {
          [projectRoot]: {
            enabled: true,
            artifact_version_hash: 'sha256:' + buildHash(projectRoot, homeDir),
            enabled_at: new Date().toISOString(),
            enabled_via: 'test-fixture',
            verify_key_id: fingerprint,
          },
        },
      },
    }, null, 2))
}
function activateProject() {
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  fs.writeFileSync(path.join(project, 'docs/rfcs/RFC-NS.md'),
    `---\nrfc_id: RFC-NS\nstatus: "accepted"\ntitle: "T"\n---\n\nbody.\n`)
  writeConfig(home, project, fp)
  return { project, home }
}
function runOrch(args, env, cwd) {
  return spawnSync('node', [ORCH, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}
function writeRunStateJson(projectRoot, runId, payload) {
  const dir = path.join(projectRoot, '.episodic-memory', 'bp1-runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(payload))
}
function findTickEpisode(projectRoot, tickId) {
  const file = path.join(projectRoot, '.episodic-memory/episodes', `${tickId}.md`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

const SIX_MIN_MS = 6 * 60 * 1000
const FOUR_MIN_MS = 4 * 60 * 1000

// =============================================================================
// NS1 no runs
// =============================================================================
tap('NS1 no runs in project → tick emitted with candidate_count=0', () => {
  const { project, home } = activateProject()
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `expected exit 0; got ${r.status}; stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.status, 'ok')
  assert.equal(out.runs_inspected_count, 0)
  assert.equal(out.path_b_candidate_count, 0)
  assert.equal(out.activation, 'enabled')
  assert.equal(out.lock_busy, false)
  const tick = findTickEpisode(project, out.tick_id)
  assert.ok(tick, `tick episode must be written to projectRoot/.episodic-memory/episodes`)
  assert.match(tick, /path_b_candidate_count: "0"/)
})

// =============================================================================
// NS2 activation disabled
// =============================================================================
tap('NS2 activation disabled (no config) → tick activation=disabled', () => {
  const project = makeProj()
  const home = makeHome()
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.activation, 'disabled')
  assert.equal(out.path_b_candidate_count, 0)
  const tick = findTickEpisode(project, out.tick_id)
  assert.ok(tick, `tick must land in projectRoot even when activation is disabled`)
  assert.match(tick, /activation: "disabled"/)
})

// =============================================================================
// NS3 naked entry past threshold (no run.key) → detected + no-key audit + pending-m3
// =============================================================================
tap('NS3 naked entry past threshold → detected child (no-key) + action-pending-m3', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-ns3-rfc-ns-aabbcc'
  writeRunStateJson(project, runId, {
    run_id: runId,
    codex_review_entries: [
      { entry_id: 'entry-a', created_at: Date.now() - SIX_MIN_MS,
        request_sent: false, response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.runs_inspected_count, 1)
  assert.equal(out.entries_inspected_count, 1)
  assert.equal(out.path_b_candidate_count, 1)
  assert.equal(out.children.length, 1)
  assert.equal(out.children[0].status, 'no-key',
    `no run.key was written, so detection child must take no-key path`)
  assert.equal(out.children[0].run_id, runId)
  assert.equal(out.children[0].entry_id, 'entry-a')
  // action_pending_path is emitted regardless of key availability.
  assert.ok(out.children[0].action_pending_path, 'action_pending_path must be populated')
  assert.ok(fs.existsSync(out.children[0].action_pending_path),
    `action-pending file must exist on disk: ${out.children[0].action_pending_path}`)
  assert.ok(out.children[0].audit_episode_path, 'no-key audit_episode_path must be populated')
  assert.ok(fs.existsSync(out.children[0].audit_episode_path))
  const noKeyRaw = fs.readFileSync(out.children[0].audit_episode_path, 'utf8')
  assert.match(noKeyRaw, /failure_kind: "naked-sweep-no-run-key"/)
  assert.match(noKeyRaw, new RegExp(`run_id: "${runId}"`))
  assert.match(noKeyRaw, /signed: false/)
  const pendRaw = fs.readFileSync(out.children[0].action_pending_path, 'utf8')
  assert.match(pendRaw, /pending_action: "em-review-request-reissue"/)
})

// =============================================================================
// NS4 invalid --tick-source
// =============================================================================
tap('NS4 invalid --tick-source → exit 2', () => {
  const { project, home } = activateProject()
  const r = runOrch(['sweep-naked-entries', '--project', project, '--tick-source', 'bogus'],
    { HOME: home }, project)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /invalid --tick-source: bogus/)
})

// =============================================================================
// NS5 missing --project
// =============================================================================
tap('NS5 missing --project → exit 2', () => {
  const r = spawnSync('node', [ORCH, 'sweep-naked-entries'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--project required/)
})

// =============================================================================
// NS6 --tick-source fallback-sweep
// =============================================================================
tap('NS6 --tick-source fallback-sweep flows into tick frontmatter', () => {
  const { project, home } = activateProject()
  const r = runOrch(['sweep-naked-entries', '--project', project, '--tick-source', 'fallback-sweep'],
    { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.tick_source, 'fallback-sweep')
  const tick = findTickEpisode(project, out.tick_id)
  assert.match(tick, /tick_source: "fallback-sweep"/)
})

// =============================================================================
// NS7 caller cwd != projectRoot
// =============================================================================
tap('NS7 caller cwd ≠ projectRoot → tick landed under projectRoot, not cwd', () => {
  const { project, home } = activateProject()
  const callerCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ns-callercwd-')))
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, callerCwd)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.ok(findTickEpisode(project, out.tick_id),
    `tick must land in projectRoot/.episodic-memory/episodes`)
  assert.equal(fs.existsSync(path.join(callerCwd, '.episodic-memory')), false,
    `caller cwd must NOT have .episodic-memory created`)
})

// =============================================================================
// NS8 run-state lock busy
// =============================================================================
tap('NS8 run-state lock busy → bp1-lock-busy evidence + tick lock_busy=true', () => {
  const { project, home } = activateProject()
  const lockDir = path.join(project, '.episodic-memory/runs/_index.lock')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'pid'), `99999\n${Date.now()}\n`, { mode: 0o600 })
  try {
    const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
    assert.equal(r.status, 0, `expected exit 0 on lock busy; got ${r.status}; stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.lock_busy, true)
    assert.equal(out.activation, 'enabled')
    assert.equal(out.path_b_candidate_count, 0)
    const tick = findTickEpisode(project, out.tick_id)
    assert.ok(tick && /lock_busy: true/.test(tick))
    const lockBusyFile = path.join(project, '.episodic-memory/episodes', `bp1-lock-busy-${out.tick_id}.md`)
    assert.ok(fs.existsSync(lockBusyFile), `bp1-lock-busy evidence must be emitted under projectRoot`)
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }) } catch (_e) {}
  }
})

// =============================================================================
// NS9 RFC §104 — subdir resolves to git toplevel
// =============================================================================
tap('NS9 RFC §104: --project <subdir-of-git> → tick lands at git toplevel', () => {
  const { project, home } = activateProject()
  const subdir = path.join(project, 'feature-x')
  fs.mkdirSync(subdir, { recursive: true })
  const r = runOrch(['sweep-naked-entries', '--project', subdir], { HOME: home }, project)
  assert.equal(r.status, 0, `expected exit 0; got ${r.status}; stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.activation, 'enabled', 'subdir resolved to project-root → activation map hits')
  const topEpisode = path.join(project, '.episodic-memory/episodes', `${out.tick_id}.md`)
  const subEpisode = path.join(subdir, '.episodic-memory/episodes', `${out.tick_id}.md`)
  assert.ok(fs.existsSync(topEpisode), `tick MUST land at git toplevel: ${topEpisode}`)
  assert.equal(fs.existsSync(subEpisode), false,
    `tick MUST NOT land at subdir: ${subEpisode}`)
})

// =============================================================================
// NS10 corrupt bp1-runs state.json → counted as stale_or_corrupt
// =============================================================================
tap('NS10 corrupt state.json → stale_or_corrupt counted, sweep exits 0', () => {
  const { project, home } = activateProject()
  const dir = path.join(project, '.episodic-memory', 'bp1-runs', 'run-corrupt')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), '{ broken json')
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.runs_inspected_count, 1)
  assert.equal(out.entries_inspected_count, 0,
    'corrupt state surfaces as empty entries (loader pushes _corrupt entry with zero codex_review_entries)')
  assert.equal(out.path_b_candidate_count, 0)
})

// =============================================================================
// NS11 entry below threshold → not a candidate
// =============================================================================
tap('NS11 naked entry ≤ threshold ago → NOT a candidate', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-ns11-rfc-ns-aabbcc'
  writeRunStateJson(project, runId, {
    run_id: runId,
    codex_review_entries: [
      { entry_id: 'fresh-entry', created_at: Date.now() - FOUR_MIN_MS,
        request_sent: false, response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.entries_inspected_count, 1)
  assert.equal(out.path_b_candidate_count, 0)
  assert.equal(out.children.length, 0)
})

// =============================================================================
// NS12 request_sent=true → Path A territory, not Path B candidate
// =============================================================================
tap('NS12 entry with request_sent=true → not Path B candidate', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-ns12-rfc-ns-aabbcc'
  writeRunStateJson(project, runId, {
    run_id: runId,
    codex_review_entries: [
      { entry_id: 'path-a-entry', created_at: Date.now() - SIX_MIN_MS,
        request_sent: true, requested_at: Date.now() - SIX_MIN_MS,
        response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.path_b_candidate_count, 0,
    'request_sent=true entries are Path A candidates; Path B sweep ignores them')
})

// =============================================================================
// NS13 multiple naked entries across runs → sorted detection
// =============================================================================
tap('NS13 multiple naked entries across runs → all detected, deterministically ordered', () => {
  const { project, home } = activateProject()
  writeRunStateJson(project, 'run-a', {
    run_id: 'run-a',
    codex_review_entries: [
      { entry_id: 'e1', created_at: Date.now() - SIX_MIN_MS, request_sent: false, response_received: false },
      { entry_id: 'e2', created_at: Date.now() - SIX_MIN_MS, request_sent: false, response_received: false },
    ],
  })
  writeRunStateJson(project, 'run-b', {
    run_id: 'run-b',
    codex_review_entries: [
      { entry_id: 'e3', created_at: Date.now() - SIX_MIN_MS, request_sent: false, response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.path_b_candidate_count, 3)
  assert.equal(out.children.length, 3)
  // bp1-sweep.mjs byRunThenEntry sort: deterministic ordering by run_id then entry_id.
  assert.equal(out.children[0].run_id, 'run-a')
  assert.equal(out.children[0].entry_id, 'e1')
  assert.equal(out.children[1].run_id, 'run-a')
  assert.equal(out.children[1].entry_id, 'e2')
  assert.equal(out.children[2].run_id, 'run-b')
  assert.equal(out.children[2].entry_id, 'e3')
})

// =============================================================================
// NS14 action-pending-m3 emit for every candidate including no-key path
// =============================================================================
tap('NS14 action-pending-m3 file emitted for every candidate (incl. no-key)', () => {
  const { project, home } = activateProject()
  writeRunStateJson(project, 'run-ap', {
    run_id: 'run-ap',
    codex_review_entries: [
      { entry_id: 'ap-1', created_at: Date.now() - SIX_MIN_MS, request_sent: false, response_received: false },
      { entry_id: 'ap-2', created_at: Date.now() - SIX_MIN_MS, request_sent: false, response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.children.length, 2)
  for (const c of out.children) {
    assert.equal(c.status, 'no-key', 'no run.key was set up → all candidates take no-key path')
    assert.ok(c.action_pending_path, 'action_pending_path must be populated even on no-key path')
    assert.ok(fs.existsSync(c.action_pending_path))
  }
})

// =============================================================================
// NS15 signed detected child carries canonical fields (when run.key available)
// =============================================================================
tap('NS15 signed detected child carries entry_id + age_ms + threshold_ms', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-ns15-rfc-ns-aabbcc'
  // Write a per-run key so emitNakedSweepDetectedChild can sign.
  const runDir = path.join(project, '.episodic-memory', 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'run.key'), crypto.randomBytes(32), { mode: 0o600 })
  writeRunStateJson(project, runId, {
    run_id: runId,
    codex_review_entries: [
      { entry_id: 'signed-entry', created_at: Date.now() - SIX_MIN_MS,
        request_sent: false, response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.children.length, 1)
  assert.equal(out.children[0].status, 'detected',
    'with run.key present, detected status (signed) is expected')
  assert.ok(out.children[0].episode_id, 'episode_id must surface for signed children')
  // The signed episode lives under .episodic-memory/episodes; filename pattern
  // is ${runId}-naked-sweep-detected-<rand>.md per genEpisodeId.
  const dir = path.join(project, '.episodic-memory/episodes')
  const found = fs.readdirSync(dir).find(f => /naked-sweep-detected/.test(f) && f.endsWith('.md'))
  assert.ok(found, `signed detected episode file must exist in ${dir}; found: ${fs.readdirSync(dir).join(', ')}`)
  const raw = fs.readFileSync(path.join(dir, found), 'utf8')
  assert.match(raw, /entry_id: "signed-entry"/)
  assert.match(raw, /age_ms: "/)
  assert.match(raw, /threshold_ms: "/)
})

// =============================================================================
// NS16 BLOCKER closure (codex code-review r1 episode ...-f964):
// malformed persisted entry_id with path-traversal sequence ("../escape")
// MUST NOT become an actionable candidate. The id is interpolated into
// unsigned-episode filenames downstream; an unvalidated value silently
// loses the M3 hand-off signal because the action-pending and no-key audit
// writes fail with ENOENT/EEXIST while the parent tick still reports
// `path_b_candidate_count: 1`.
// =============================================================================
tap('NS16 BLOCKER: malformed entry_id (path-traversal) counted as stale_or_corrupt, NOT a candidate', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-ns16-rfc-ns-aabbcc'
  writeRunStateJson(project, runId, {
    run_id: runId,
    codex_review_entries: [
      { entry_id: '../escape', created_at: Date.now() - SIX_MIN_MS,
        request_sent: false, response_received: false },
      { entry_id: 'with/slash', created_at: Date.now() - SIX_MIN_MS,
        request_sent: false, response_received: false },
      { entry_id: 'has space', created_at: Date.now() - SIX_MIN_MS,
        request_sent: false, response_received: false },
      // Clean control: this one IS a valid Path B candidate.
      { entry_id: 'clean-entry', created_at: Date.now() - SIX_MIN_MS,
        request_sent: false, response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  // All four entries are inspected, but three are stale_or_corrupt; only one is a candidate.
  assert.equal(out.entries_inspected_count, 4)
  assert.equal(out.path_b_candidate_count, 1,
    'malformed IDs (../escape, with/slash, has space) MUST NOT be candidates')
  assert.equal(out.stale_or_corrupt_count, 3,
    'all three malformed entry_id shapes MUST be counted as stale_or_corrupt')
  assert.equal(out.children.length, 1, 'only the clean candidate emits a child')
  assert.equal(out.children[0].entry_id, 'clean-entry')
})

tap('NS17 malformed run_id (path-traversal) likewise rejected from candidate set', () => {
  const { project, home } = activateProject()
  // run-state dir uses safe shape, but state.run_id carries the path-traversal.
  writeRunStateJson(project, 'safe-dir-name', {
    run_id: '../malicious',
    codex_review_entries: [
      { entry_id: 'e1', created_at: Date.now() - SIX_MIN_MS,
        request_sent: false, response_received: false },
    ],
  })
  const r = runOrch(['sweep-naked-entries', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.path_b_candidate_count, 0,
    'unsafe run_id MUST disqualify the entry from candidacy')
  assert.equal(out.stale_or_corrupt_count, 1)
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
