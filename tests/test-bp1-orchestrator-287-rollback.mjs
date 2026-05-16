#!/usr/bin/env node
/**
 * test-bp1-orchestrator-287-rollback.mjs — detect-rfcs per-RFC iteration
 * compensating rollback. Cluster #287 fix; plan v5 round-5 ACCEPT.
 *
 * Cases (subset; full matrix in plan):
 *   287-1 emit throws (atomic-rename injected fail) → key + index + tmp
 *         unwound; no orphaned state for the failed runId; sibling RFCs
 *         in the same iteration left intact if they ran first.
 *   287-2 rollback-failed sentinel: when shred fails, .rollback-failed.json
 *         is written under <projectRoot>/.episodic-memory/runs/<runId>/.
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
const INJECT_RENAME = path.join(REPO, 'tests', 'fixtures', 'inject-rename-fail.mjs')

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyKeyFingerprint } = hmacMod
const rsmod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { loadIndex } = rsmod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-287-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-287-home-'))
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
function writeRfc(projectRoot, name) {
  fs.writeFileSync(path.join(projectRoot, 'docs', 'rfcs', `${name}.md`),
    `---\nrfc_id: ${name}\nstatus: ${JSON.stringify('accepted')}\ntitle: ${JSON.stringify('T')}\n---\n\nbody.\n`)
}
function setupActiveProject({ rfcs = ['RFC-A'] } = {}) {
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  for (const r of rfcs) writeRfc(project, r)
  writeConfig(home, project, fp)
  return { project, home }
}

// ===========================================================================
// 287-1 — atomic-rename injection: writer's rename throws → rollback unwinds
//   key + index row + episode .md AND no .md.tmp.* leak. codex r1 C3 fix:
//   prior version filtered out .tmp.* files which masked tmp leak class.
// ===========================================================================
tap('287-1 emit throws (atomic-rename injected fail) → key + index + episode .md + tmp all unwound', () => {
  const { project, home } = setupActiveProject({ rfcs: ['RFC-A'] })
  const r = spawnSync('node', ['--import', INJECT_RENAME, ORCHESTRATOR, 'detect-rfcs', '--project', project], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, FAIL_EPISODE_RENAME: '1' },
  })
  assert.equal(r.status, 3, `expected exit 3; got ${r.status}; stderr=${r.stderr}`)
  // No run entries in index (rollback removed the row).
  const idx = loadIndex(project)
  assert.deepEqual(idx.runs, {}, `runs index should be empty after rollback; got ${JSON.stringify(idx.runs)}`)
  // No run.key directories (rollback shredded the key).
  const runsDir = path.join(project, '.episodic-memory', 'runs')
  if (fs.existsSync(runsDir)) {
    const entries = fs.readdirSync(runsDir).filter(n => n !== '_index.json' && !n.startsWith('_index.lock') && !n.startsWith('_index.json.tmp.'))
    // run.key entries unwound; .rollback-failed.json may or may not be present.
    for (const e of entries) {
      const sub = path.join(runsDir, e)
      const subEntries = fs.readdirSync(sub)
      assert.ok(!subEntries.includes('run.key'),
        `run.key should have been shredded for ${e}; got ${subEntries.join(', ')}`)
    }
  }
  // No FINAL episode files AND no .md.tmp.* leftovers. The writer's atomic-
  // rename path failed, so it should have cleaned up its tmp; if not, the
  // disk accumulates orphan tmps across crash-retry. codex r1 C3.
  const episodesDir = path.join(project, '.episodic-memory', 'episodes')
  if (fs.existsSync(episodesDir)) {
    const all = fs.readdirSync(episodesDir)
    const finals = all.filter(n => n.endsWith('.md') && !n.includes('.tmp.'))
    const tmps = all.filter(n => n.includes('.md.tmp.') || (n.startsWith('.') && n.includes('tmp')))
    assert.equal(finals.length, 0, `no final episode files; got ${finals.join(', ')}`)
    assert.equal(tmps.length, 0, `no .md.tmp.* leak; got ${tmps.join(', ')}`)
  }
})

// ===========================================================================
// 287-2 — rollback step itself fails: episode-rename injection THEN shred-key
//   injection forces a real rollback failure. Verify (a) .rollback-failed.json
//   sentinel on disk, (b) stderr contains "rollback-failed: sentinel at ...",
//   (c) sentinel JSON contains the original error + the shred-key failure
//   in the rollback_errors array. codex r1 C3 fix: prior smoke test asserted
//   assert.ok(true), never forced a rollback failure.
// ===========================================================================
tap('287-2 forced rollback failure → .rollback-failed.json sentinel + stderr line', () => {
  const { project, home } = setupActiveProject({ rfcs: ['RFC-A'] })
  const r = spawnSync('node', ['--import', INJECT_RENAME, ORCHESTRATOR, 'detect-rfcs', '--project', project], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...process.env, HOME: home,
      FAIL_EPISODE_RENAME: '1',
      FAIL_SHRED_KEY: '1',
    },
  })
  assert.equal(r.status, 3, `expected exit 3; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /detect-rfcs iteration failed/,
    `expected iteration-failure stderr; got: ${r.stderr}`)
  assert.match(r.stderr, /rollback-failed: sentinel at /,
    `expected sentinel-write stderr line; got: ${r.stderr}`)

  // Find the sentinel on disk and verify its contents.
  const runsDir = path.join(project, '.episodic-memory', 'runs')
  assert.ok(fs.existsSync(runsDir), 'runs/ should exist')
  let sentinelPath = null
  let sentinelContent = null
  for (const entry of fs.readdirSync(runsDir)) {
    const sub = path.join(runsDir, entry)
    if (!fs.statSync(sub).isDirectory()) continue
    const candidate = path.join(sub, '.rollback-failed.json')
    if (fs.existsSync(candidate)) {
      sentinelPath = candidate
      sentinelContent = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      break
    }
  }
  assert.ok(sentinelPath, `expected .rollback-failed.json on disk; runs/ entries: ${fs.readdirSync(runsDir).join(', ')}`)
  assert.ok(Array.isArray(sentinelContent.rollback_errors),
    `sentinel.rollback_errors must be array; got: ${JSON.stringify(sentinelContent)}`)
  assert.ok(
    sentinelContent.rollback_errors.some(e => /^shred-key: /.test(e)),
    `sentinel must record shred-key failure; got: ${JSON.stringify(sentinelContent.rollback_errors)}`,
  )
  assert.match(sentinelContent.original_error, /injected episode renameSync failure/,
    `sentinel.original_error must reference the writer failure; got: ${sentinelContent.original_error}`)
  assert.ok(sentinelContent.run_id, 'sentinel must include run_id')
  assert.ok(sentinelContent.at, 'sentinel must include timestamp')
})

if (fail > 0) {
  console.log(`\n# FAIL ${pass}/${pass + fail} passed`)
  process.exit(1)
}
console.log(`\n# OK ${pass}/${pass + fail} passed`)
