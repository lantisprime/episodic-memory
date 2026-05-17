#!/usr/bin/env node
/**
 * test-bp1-emit-marker-invalid-evidence.mjs — Slice 2d-R failure-evidence
 * helper tests.
 *
 * Coverage (round-2 plan F3 disposition, three-case contract):
 *   E1: Case A — key present → signed episode on disk with hmac field.
 *   E2: Case A — episode body cites marker_path + reason.
 *   E3: Case B — key missing → 0 episode files, stderr structured JSON.
 *   E4: Case B — marker file untouched after Case B emission.
 *   E5: Argv: missing --project → exit 2.
 *   E6: Argv: invalid --reason → exit 2.
 *   E7: Idempotent re-emit: two invocations produce two episode files (each
 *       has unique episode_id with random suffix; signing is deterministic
 *       per-invocation but episode ids differ).
 *   E8: Reason prefix accepted: `key-mode`, `lstat-failed:EACCES`,
 *       `read-failed:EIO` all pass argv validation.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'bp1-emit-marker-invalid-evidence.mjs')

const keysMod = await import(new URL('../scripts/lib/bp1-keys.mjs', import.meta.url).href)
const { generateRunKey, runKeyPath } = keysMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

const RUN_ID = 'bp1-run-1700000000000-rfc-004-aabbcc'

function tmpProj() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-emit-mi-')))
}

function invoke(projectRoot, args = {}) {
  const argv = [SCRIPT,
    '--project', projectRoot,
    '--run-id', args.runId ?? RUN_ID,
    '--reason', args.reason ?? 'hmac-mismatch',
    '--marker-path', args.markerPath ?? path.join(projectRoot, '.checkpoints', `bp1-approval-${RUN_ID}.json`),
  ]
  const r = spawnSync('node', argv, { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, parsed: r.stdout ? JSON.parse(r.stdout.trim().split('\n').pop()) : null }
}

function fakeMarkerOnDisk(projectRoot, runId) {
  const dir = path.join(projectRoot, '.checkpoints')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `bp1-approval-${runId}.json`)
  fs.writeFileSync(p, '{"corrupted":true}')
  return p
}

// ---------------------------------------------------------------------------
// E1-E2: Case A — key present → signed episode
// ---------------------------------------------------------------------------

tap('E1 Case A: key present → signed episode on disk with hmac field', () => {
  const proj = tmpProj()
  generateRunKey(proj, RUN_ID)
  const markerPath = fakeMarkerOnDisk(proj, RUN_ID)
  const r = invoke(proj, { markerPath, reason: 'hmac-mismatch' })
  assert.equal(r.code, 0)
  assert.equal(r.parsed.case, 'A')
  assert.ok(r.parsed.episode_path, 'episode_path returned')
  assert.ok(fs.existsSync(r.parsed.episode_path), 'episode file on disk')
  const content = fs.readFileSync(r.parsed.episode_path, 'utf8')
  assert.ok(content.includes('hmac_signature:'), 'episode has hmac_signature field')
  assert.ok(content.includes('failure_kind: "bp1-marker-invalid"'), 'failure_kind field present')
  assert.ok(/^type: failure\b/m.test(content), 'type: failure line present')
})

tap('E2 Case A: episode body cites marker_path + reason', () => {
  const proj = tmpProj()
  generateRunKey(proj, RUN_ID)
  const markerPath = fakeMarkerOnDisk(proj, RUN_ID)
  const r = invoke(proj, { markerPath, reason: 'symlink' })
  const content = fs.readFileSync(r.parsed.episode_path, 'utf8')
  assert.ok(content.includes(markerPath), 'body cites marker_path')
  assert.ok(content.includes('symlink'), 'body cites reason')
})

// ---------------------------------------------------------------------------
// E3-E4: Case B — key missing → stderr-only
// ---------------------------------------------------------------------------

tap('E3 Case B: key missing → 0 episode files + stderr structured JSON', () => {
  const proj = tmpProj()
  // Don't generate key.
  const markerPath = fakeMarkerOnDisk(proj, RUN_ID)
  const r = invoke(proj, { markerPath, reason: 'hmac-mismatch' })
  assert.equal(r.code, 0)
  assert.equal(r.parsed.case, 'B')
  assert.equal(r.parsed.key_load_error, 'missing')
  // No episode dir for this run.
  const episodesDir = path.join(proj, '.episodic-memory', 'episodes')
  const episodeFiles = fs.existsSync(episodesDir) ? fs.readdirSync(episodesDir) : []
  assert.equal(episodeFiles.length, 0, 'no episode files written in Case B')
  // Stderr contains structured JSON line.
  const stderrLine = r.stderr.split('\n').find(l => l.includes('failure:bp1-marker-invalid-unsigned'))
  assert.ok(stderrLine, 'stderr has unsigned-kind line')
  const stderrParsed = JSON.parse(stderrLine)
  assert.equal(stderrParsed.kind, 'failure:bp1-marker-invalid-unsigned')
  assert.equal(stderrParsed.case, 'B')
  assert.equal(stderrParsed.run_id, RUN_ID)
  assert.equal(stderrParsed.marker_path, markerPath)
})

tap('E4 Case B: marker file untouched after emission', () => {
  const proj = tmpProj()
  const markerPath = fakeMarkerOnDisk(proj, RUN_ID)
  const beforeMtime = fs.statSync(markerPath).mtimeMs
  const beforeBytes = fs.readFileSync(markerPath)
  invoke(proj, { markerPath, reason: 'malformed-json' })
  const afterMtime = fs.statSync(markerPath).mtimeMs
  const afterBytes = fs.readFileSync(markerPath)
  assert.equal(beforeMtime, afterMtime, 'mtime unchanged')
  assert.ok(beforeBytes.equals(afterBytes), 'bytes unchanged')
})

// ---------------------------------------------------------------------------
// E5-E6: Argv shape
// ---------------------------------------------------------------------------

tap('E5 missing --project → exit 2', () => {
  const r = spawnSync('node', [SCRIPT, '--run-id', RUN_ID, '--reason', 'symlink', '--marker-path', '/tmp/x'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--project required'))
})

tap('E6 invalid --reason → exit 2', () => {
  const proj = tmpProj()
  const r = spawnSync('node', [SCRIPT, '--project', proj, '--run-id', RUN_ID, '--reason', 'completely-unknown-reason', '--marker-path', '/tmp/x'], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.ok(r.stderr.includes('--reason invalid'))
})

// ---------------------------------------------------------------------------
// E7-E8: re-emit + reason-prefix acceptance
// ---------------------------------------------------------------------------

tap('E7 idempotent re-emit produces two episode files (each with unique id)', () => {
  const proj = tmpProj()
  generateRunKey(proj, RUN_ID)
  const markerPath = fakeMarkerOnDisk(proj, RUN_ID)
  const r1 = invoke(proj, { markerPath })
  const r2 = invoke(proj, { markerPath })
  assert.equal(r1.parsed.case, 'A')
  assert.equal(r2.parsed.case, 'A')
  assert.notEqual(r1.parsed.episode_id, r2.parsed.episode_id, 'episode ids differ')
  const episodesDir = path.join(proj, '.episodic-memory', 'episodes')
  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith('.md'))
  assert.equal(files.length, 2, '2 episode files')
})

tap('E8 reason prefixes accepted: key-*, lstat-failed:*, read-failed:*', () => {
  const proj = tmpProj()
  generateRunKey(proj, RUN_ID)
  const markerPath = fakeMarkerOnDisk(proj, RUN_ID)
  for (const reason of ['key-mode', 'lstat-failed:EACCES', 'read-failed:EIO']) {
    const r = invoke(proj, { markerPath, reason })
    assert.equal(r.code, 0, `reason "${reason}" accepted`)
  }
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail > 0 ? 1 : 0)
