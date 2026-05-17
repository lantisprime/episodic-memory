#!/usr/bin/env node
/**
 * test-bp1-check-deadlines.mjs — slice 2e C4 check-deadlines subcommand.
 *
 * Coverage focuses on the A2-only path shipped in C4 (A1 retry-tree deferred
 * to slice 2g per plan v3). A subset of the 14 cases in plan v3 §"Revised
 * test budget" is shipped here — exhaustive A2-fire negative-path coverage
 * (CD3 idempotent-success, CD-state-mismatch parsing of confirm-approval
 * stderr) requires the heavyweight signed-awaiting_approval fixture and is
 * deferred to a follow-up. The core authority-root, activation, lock-busy,
 * multi-run, and tick-source paths are exercised here.
 *
 * Cases:
 *   CD1  no runs in index → tick emitted, runs_inspected=0, fired=0, exit 0
 *   CD2  activation disabled (no flag-check config) → tick activation=disabled,
 *        fired=0; bp1-deadline-tick episode lands under projectRoot
 *   CD3  awaiting_approval with future deadline_at → fired=0; tick fired_a2=0
 *   CD4  awaiting_approval with expired deadline_at (no per-run key) → A2
 *        fires but emits failure (no-key) — confirms the per-fire path
 *        without requiring full confirm-approval setup
 *   CD5  invalid --tick-source → exit 2
 *   CD6  missing --project → exit 2
 *   CD7  --tick-source fallback-sweep flows into tick frontmatter
 *   CD8  caller cwd != projectRoot → tick written under projectRoot,
 *        not caller's cwd (authority-root invariant)
 *   CD9  lock busy at run-state index → bp1-lock-busy evidence + tick
 *        lock_busy=true; exit 0
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
const rsmod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { appendRun, updateRunState } = rsmod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-cd-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-cd-home-'))
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
  fs.writeFileSync(path.join(project, 'docs/rfcs/RFC-CD.md'),
    `---\nrfc_id: RFC-CD\nstatus: "accepted"\ntitle: "T"\n---\n\nbody.\n`)
  writeConfig(home, project, fp)
  return { project, home }
}
function runOrch(args, env, cwd) {
  return spawnSync('node', [ORCH, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function readDir(p) {
  try { return fs.readdirSync(p) } catch (_e) { return [] }
}
function findTickEpisode(projectRoot, tickId) {
  const file = path.join(projectRoot, '.episodic-memory/episodes', `${tickId}.md`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

// =============================================================================
// CD1 no runs
// =============================================================================
tap('CD1 no runs in index → tick emitted with fired=0', () => {
  const { project, home } = activateProject()
  const r = runOrch(['check-deadlines', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `expected exit 0; got ${r.status}; stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.status, 'ok')
  assert.equal(out.runs_inspected, 0)
  assert.equal(out.fired_count, 0)
  assert.equal(out.activation, 'enabled')
  assert.equal(out.lock_busy, false)
  // Parent tick on disk in projectRoot, not home.
  const tick = findTickEpisode(project, out.tick_id)
  assert.ok(tick, `tick episode must be written to projectRoot/.episodic-memory/episodes`)
  assert.match(tick, /tick_source: "scheduled-task"/)
  assert.match(tick, /activation: "enabled"/)
})

// =============================================================================
// CD2 activation disabled (no config)
// =============================================================================
tap('CD2 activation disabled (no flag-check config) → tick activation=disabled', () => {
  const project = makeProj()
  const home = makeHome()
  // NO config written — flag-check fails.
  const r = runOrch(['check-deadlines', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.activation, 'disabled')
  assert.equal(out.fired_count, 0)
  // Tick episode written to projectRoot.
  const tick = findTickEpisode(project, out.tick_id)
  assert.ok(tick, `tick must land in projectRoot even when activation is disabled`)
  assert.match(tick, /activation: "disabled"/)
})

// =============================================================================
// CD3 awaiting_approval with future deadline
// =============================================================================
tap('CD3 awaiting_approval with future deadline_at → fired_count=0', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-cd3-rfc-cd-aabbcc'
  const ar = appendRun(project, runId, project)
  if (ar.error) throw new Error(`appendRun: ${ar.error}`)
  const upd = updateRunState(project, runId, {
    state: 'awaiting_approval',
    awaiting_approval_at: new Date(Date.now() - 60_000).toISOString(),
    deadline_at: new Date(Date.now() + 3_600_000).toISOString(),
    decided_class: 'trivial',
    classified_episode_id: 'fake-classified',
    route_episode_id: 'fake-route',
  })
  if (upd.error) throw new Error(`updateRunState: ${upd.error}`)
  const r = runOrch(['check-deadlines', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.runs_inspected, 1)
  assert.equal(out.fired_count, 0)
  assert.equal(out.fired_a2, 0)
})

// =============================================================================
// CD4 awaiting_approval with expired deadline_at (no per-run key)
// =============================================================================
tap('CD4 awaiting_approval expired + no run.key → A2 fires, child emits no-key failure', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-cd4-rfc-cd-aabbcc'
  const ar = appendRun(project, runId, project)
  if (ar.error) throw new Error(`appendRun: ${ar.error}`)
  const upd = updateRunState(project, runId, {
    state: 'awaiting_approval',
    awaiting_approval_at: new Date(Date.now() - 7_200_000).toISOString(),
    deadline_at: new Date(Date.now() - 60_000).toISOString(),
    decided_class: 'trivial',
    classified_episode_id: 'fake-classified',
    route_episode_id: 'fake-route',
  })
  if (upd.error) throw new Error(`updateRunState: ${upd.error}`)
  const r = runOrch(['check-deadlines', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.runs_inspected, 1)
  // Without per-run key, fireA2 returns status=no-key. Not counted as "fired".
  assert.equal(out.fired_count, 0)
  assert.equal(out.fired_a2, 0)
  assert.equal(out.children.length, 1)
  assert.equal(out.children[0].status, 'no-key')
  assert.equal(out.children[0].run_id, runId)
})

// =============================================================================
// CD5 invalid --tick-source
// =============================================================================
tap('CD5 invalid --tick-source → exit 2', () => {
  const { project, home } = activateProject()
  const r = runOrch(['check-deadlines', '--project', project, '--tick-source', 'bogus'],
    { HOME: home }, project)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /invalid --tick-source: bogus/)
})

// =============================================================================
// CD6 missing --project
// =============================================================================
tap('CD6 missing --project → exit 2', () => {
  const r = spawnSync('node', [ORCH, 'check-deadlines'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--project required/)
})

// =============================================================================
// CD7 --tick-source fallback-sweep
// =============================================================================
tap('CD7 --tick-source fallback-sweep flows into tick frontmatter', () => {
  const { project, home } = activateProject()
  const r = runOrch(['check-deadlines', '--project', project, '--tick-source', 'fallback-sweep'],
    { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.tick_source, 'fallback-sweep')
  const tick = findTickEpisode(project, out.tick_id)
  assert.match(tick, /tick_source: "fallback-sweep"/)
})

// =============================================================================
// CD8 caller cwd != projectRoot → artifacts land under projectRoot
// =============================================================================
tap('CD8 caller cwd ≠ projectRoot → tick landed under projectRoot, not cwd', () => {
  const { project, home } = activateProject()
  const callerCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-cd-callercwd-')))
  // Caller is outside projectRoot.
  const r = runOrch(['check-deadlines', '--project', project], { HOME: home }, callerCwd)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  // Tick under projectRoot.
  assert.ok(findTickEpisode(project, out.tick_id),
    `tick must land in projectRoot/.episodic-memory/episodes; missing under ${project}`)
  // Caller cwd has NO .episodic-memory dir.
  assert.equal(fs.existsSync(path.join(callerCwd, '.episodic-memory')), false,
    `caller cwd must NOT have .episodic-memory created`)
})

// =============================================================================
// CD9 run-state lock busy → bp1-lock-busy evidence + tick lock_busy=true
// =============================================================================
tap('CD9 run-state lock busy → bp1-lock-busy evidence + tick lock_busy=true', () => {
  const { project, home } = activateProject()
  // Plant a fresh lockdir manually (not stale) so tryAcquireRunStateLock returns busy.
  const lockDir = path.join(project, '.episodic-memory/runs/_index.lock')
  fs.mkdirSync(lockDir, { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'pid'), `99999\n${Date.now()}\n`, { mode: 0o600 })
  try {
    const r = runOrch(['check-deadlines', '--project', project], { HOME: home }, project)
    assert.equal(r.status, 0, `expected exit 0 on lock busy; got ${r.status}; stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.lock_busy, true)
    assert.equal(out.activation, 'enabled')
    assert.equal(out.fired_count, 0)
    // Tick + bp1-lock-busy episode both present.
    const tick = findTickEpisode(project, out.tick_id)
    assert.ok(tick && /lock_busy: true/.test(tick))
    const lockBusyFile = path.join(project, '.episodic-memory/episodes', `bp1-lock-busy-${out.tick_id}.md`)
    assert.ok(fs.existsSync(lockBusyFile), `bp1-lock-busy evidence must be emitted under projectRoot`)
  } finally {
    // Cleanup: remove planted lockdir so subsequent tests don't conflict.
    try { fs.rmSync(lockDir, { recursive: true, force: true }) } catch (_e) {}
  }
})

// =============================================================================
// CD10 codifies RFC §104 design: --project <non-git-subdir-of-git-repo>
// MUST canonicalize UP to git toplevel (matches init-run / confirm-approval
// behavior — "single project shares one safety envelope"). The C4 code-
// review HOLD on this resolver was REJECTED on the basis that the
// resolution is spec-mandated. This test prevents future implementers
// from accidentally inverting the design.
// =============================================================================
tap('CD10 RFC §104: --project <subdir-of-git> → tick lands at git toplevel (NOT at subdir)', () => {
  const { project, home } = activateProject()
  // Create a non-git subdir inside the activated (git-initialized) project.
  const subdir = path.join(project, 'feature-x')
  fs.mkdirSync(subdir, { recursive: true })

  const r = runOrch(['check-deadlines', '--project', subdir], { HOME: home }, project)
  assert.equal(r.status, 0, `expected exit 0; got ${r.status}; stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.activation, 'enabled', 'subdir resolved to project-root → activation map hits')

  // Critical: tick lands under the GIT TOPLEVEL, not the subdir.
  const topEpisode = path.join(project, '.episodic-memory/episodes', `${out.tick_id}.md`)
  const subEpisode = path.join(subdir, '.episodic-memory/episodes', `${out.tick_id}.md`)
  assert.ok(fs.existsSync(topEpisode), `tick MUST land at git toplevel: ${topEpisode}`)
  assert.equal(fs.existsSync(subEpisode), false,
    `tick MUST NOT land at subdir: ${subEpisode} (would violate RFC §104 single-safety-envelope)`)
})

// =============================================================================
// CD11 C7 round-2 P2.2: A2 no-key path MUST emit a durable on-disk audit
// artifact, not just a stdout JSON record. Without this the parent tick is
// the only on-disk surface; sweep-time audit reconstruction misses the
// per-run failure entirely.
// =============================================================================
tap('CD11 P2.2: no-key A2 fire emits unsigned on-disk audit child', () => {
  const { project, home } = activateProject()
  const runId = 'bp1-run-cd11-rfc-cd-aabbcc'
  const ar = appendRun(project, runId, project)
  if (ar.error) throw new Error(`appendRun: ${ar.error}`)
  const upd = updateRunState(project, runId, {
    state: 'awaiting_approval',
    awaiting_approval_at: new Date(Date.now() - 7_200_000).toISOString(),
    deadline_at: new Date(Date.now() - 60_000).toISOString(),
    decided_class: 'trivial',
    classified_episode_id: 'fake-classified',
    route_episode_id: 'fake-route',
  })
  if (upd.error) throw new Error(`updateRunState: ${upd.error}`)

  const r = runOrch(['check-deadlines', '--project', project], { HOME: home }, project)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.children.length, 1)
  assert.equal(out.children[0].status, 'no-key')

  // Critical: audit_episode_path surfaced AND file on disk.
  const auditPath = out.children[0].audit_episode_path
  assert.ok(auditPath, 'audit_episode_path MUST be populated for no-key fires')
  assert.ok(fs.existsSync(auditPath), `audit episode MUST exist on disk: ${auditPath}`)

  const auditRaw = fs.readFileSync(auditPath, 'utf8')
  assert.match(auditRaw, /failure_kind: "a2-no-run-key"/, 'audit frontmatter MUST tag failure_kind')
  assert.match(auditRaw, new RegExp(`run_id: "${runId}"`), 'audit MUST cite run_id')
  assert.match(auditRaw, /signed: false/, 'audit MUST mark itself unsigned')
  assert.match(auditRaw, new RegExp(`tick_parent: "${out.tick_id}"`), 'audit MUST link to parent tick')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
