#!/usr/bin/env node
/**
 * test-bp1-orchestrator-classifier-fence.mjs — record-classifier-dispatch-pre
 * + record-classification E2E tests (slice 2c, plan v4 §"Subcommand contracts").
 *
 * Coverage (~30 cases):
 *
 * Pre-dispatch:
 *   T20  happy path: pre-dispatch → state=classifier-dispatch-pending
 *   T20a empty input-sha256 → exit 2
 *   T20b non-hex input-sha256 → exit 2
 *   T22b prototype-pollution key in result-file → schema-violation
 *   T22c confidence=-0.1 → schema-violation
 *   T22d confidence=1.1 → schema-violation
 *   T22e confidence non-number → schema-violation
 *   T22f confidence Infinity → schema-violation
 *   T23b rationale empty (0 words) → schema-violation
 *   T23c rationale 301 words → schema-violation
 *   T37b run_id with traversal chars → exit 2
 *   T-pre-no-run-key: missing run.key → exit 5
 *   T-pre-wrong-state: state != rfc-detected → exit 5
 *   T-pre-missing-rfc-detected-id: rfc_detected_episode_id null → exit 5
 *   T-fail-3 parent rfc-detected tampered → exit 5 + parent-tamper failure ep
 *   T-pre-4 second pre-dispatch on same run → state=violation
 *   T-pre-5 pre-dispatch on terminal run → exit 5
 *
 * Classification:
 *   T-class-happy-trivial: trivial → state=planning + bp1-planning episode
 *   T-class-happy-risky: schema → state=needs-human + bp1-needs-human episode
 *   T-class-relative-result-file: relative path → exit 2
 *   T-class-pre-id-mismatch: --pre-episode-id != run.pre_episode_id → exit 5
 *   T-class-wrong-state: state != classifier-dispatch-pending → exit 5
 *   T-class-bad-pre-shape: --pre-episode-id with traversal chars → exit 2
 *   T-class-missing-result-file: file doesn't exist → exit 5
 *   T-class-bad-json: result-file invalid JSON → exit 5 + schema-violation ep
 *   T-class-missing-required: result-file missing 'class' field → schema-violation
 *   T-class-extra-field: additionalProperties:false catches extra → schema-violation
 *   T-class-bad-class-enum: class not in enum → schema-violation
 *   T-class-classified-fields-empty: minItems:1 catches empty → schema-violation
 *   T-class-route-eps: classified + route episodes both exist + verify HMAC
 *   T-fail-5 parent pre tampered at record-classification → exit 5 + parent-tamper
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
const { verifyKeyFingerprint } = hmacMod
const verifyMod = await import(new URL('../scripts/lib/bp1-episode-verify.mjs', import.meta.url).href)
const { verifyEpisodeOnDisk } = verifyMod
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

// =============================================================================
// Sandbox + active-project setup with one rfc-detected run
// =============================================================================

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-cf-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-cf-home-'))
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
function writeRfc(projectRoot, name, status = 'accepted') {
  fs.writeFileSync(path.join(projectRoot, 'docs', 'rfcs', `${name}.md`),
    `---\nrfc_id: ${name}\nstatus: ${JSON.stringify(status)}\ntitle: ${JSON.stringify('T')}\n---\n\nbody.\n`)
}
function runOrch(args, { project, homeDir, callerCwd }) {
  return spawnSync('node', [ORCHESTRATOR, ...args], {
    cwd: callerCwd ?? project, encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  })
}

/**
 * Make an active project with one rfc-detected run. Returns
 * { project, home, runId, rfcDetectedEpisodeId, runKey }.
 */
function setupRfcDetected() {
  const project = makeProj()
  const home = makeHome()
  const fp = writeKey(home)
  writeRfc(project, 'RFC-CF')
  writeConfig(home, project, fp)
  const r = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  if (r.status !== 0) throw new Error(`detect-rfcs failed: ${r.stderr}`)
  const det = JSON.parse(r.stdout).detected[0]
  const runKey = fs.readFileSync(path.join(project, '.episodic-memory/runs', det.run_id, 'run.key'))
  return {
    project, home,
    runId: det.run_id,
    rfcDetectedEpisodeId: det.rfc_detected_episode_id,
    runKey,
  }
}

/**
 * Run record-classifier-dispatch-pre on the rfc-detected fixture, returns
 * stdout JSON or throws.
 */
function preDispatch(ctx, { inputSha256 } = {}) {
  const sha = inputSha256 ?? crypto.randomBytes(32).toString('hex')
  const r = runOrch([
    'record-classifier-dispatch-pre',
    '--project', ctx.project,
    '--run-id', ctx.runId,
    '--input-sha256', sha,
  ], { project: ctx.project, homeDir: ctx.home })
  return { r, inputSha256: sha }
}

/**
 * Run record-classification with a result-file containing the given classifier
 * output object.
 */
function recordClassification(ctx, classifierOutput, preEpisodeId) {
  const resultFile = path.join(ctx.project, 'classifier-result.json')
  fs.writeFileSync(resultFile, JSON.stringify(classifierOutput))
  const r = runOrch([
    'record-classification',
    '--project', ctx.project,
    '--run-id', ctx.runId,
    '--pre-episode-id', preEpisodeId,
    '--result-file', resultFile,
  ], { project: ctx.project, homeDir: ctx.home })
  return r
}

const RFC_SCAN_INPUT_SHA = 'a'.repeat(64)

// =============================================================================
// Pre-dispatch tests
// =============================================================================

tap('T20 pre-dispatch happy path → state=classifier-dispatch-pending', () => {
  const ctx = setupRfcDetected()
  const { r } = preDispatch(ctx)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.status, 'ok')
  assert.ok(out.pre_episode_id)
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'classifier-dispatch-pending')
  assert.equal(idx.runs[ctx.runId].pre_episode_id, out.pre_episode_id)
})

tap('T20a empty --input-sha256 → exit 2', () => {
  const ctx = setupRfcDetected()
  const { r } = preDispatch(ctx, { inputSha256: '' })
  assert.equal(r.status, 2)
})

tap('T20b non-hex --input-sha256 → exit 2', () => {
  const ctx = setupRfcDetected()
  const { r } = preDispatch(ctx, { inputSha256: 'g'.repeat(64) })
  assert.equal(r.status, 2)
})

tap('T20-short --input-sha256 wrong length → exit 2', () => {
  const ctx = setupRfcDetected()
  const { r } = preDispatch(ctx, { inputSha256: 'a'.repeat(63) })
  assert.equal(r.status, 2)
})

tap('T37b run_id with traversal chars → exit 2', () => {
  const ctx = setupRfcDetected()
  const r = runOrch([
    'record-classifier-dispatch-pre', '--project', ctx.project,
    '--run-id', '../escape', '--input-sha256', RFC_SCAN_INPUT_SHA,
  ], { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('T-pre-no-run-key missing run.key → exit 5', () => {
  const ctx = setupRfcDetected()
  fs.unlinkSync(path.join(ctx.project, '.episodic-memory/runs', ctx.runId, 'run.key'))
  const { r } = preDispatch(ctx)
  assert.equal(r.status, 5)
})

tap('T-pre-wrong-state pre-dispatch when state != rfc-detected → exit 5', () => {
  const ctx = setupRfcDetected()
  // Pre-dispatch once → state=classifier-dispatch-pending. Second call should fail.
  preDispatch(ctx)
  const { r } = preDispatch(ctx)
  assert.equal(r.status, 5)
})

tap('T-fail-3 parent rfc-detected tampered → exit 5 + parent-tamper failure ep', () => {
  const ctx = setupRfcDetected()
  // Tamper the rfc-detected episode body.
  const epPath = path.join(ctx.project, '.episodic-memory/episodes', `${ctx.rfcDetectedEpisodeId}.md`)
  fs.writeFileSync(epPath, fs.readFileSync(epPath, 'utf8') + '\nTAMPERED\n')
  const { r } = preDispatch(ctx)
  assert.equal(r.status, 5)
  const eps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(eps.some(f => f.includes('parent-tamper')), 'parent-tamper failure ep emitted')
})

// =============================================================================
// Classification tests
// =============================================================================

function validClassifierOutput(klass = 'trivial', overrides = {}) {
  return {
    class: klass,
    confidence: 0.9,
    rationale: 'a brief rationale of the classification',
    classified_fields: ['title', 'goal'],
    ...overrides,
  }
}

tap('T-class-happy-trivial trivial → state=classified (stable), NO bp1-planning episode (slice 2d-W Option A)', () => {
  // Slice 2d-W (Option A, codex r3 episode 20260517-021728-...-fd95):
  // trivial-class runs stop at stable `classified` state. record-classification
  // Phase B is a no-op for trivial; the safety-envelope transition into
  // `awaiting_approval` is the responsibility of `record-awaiting-approval`.
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial'), preId)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'classified')
  assert.equal(out.decided_class, 'trivial')
  assert.equal(out.route_episode_id, null, 'route_episode_id stays null for trivial')
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'classified')
  assert.equal(idx.runs[ctx.runId].decided_class, 'trivial')
  assert.equal(idx.runs[ctx.runId].route_episode_id, null)
  // classified episode exists; bp1-planning episode does NOT.
  const eps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(eps.some(f => f.includes('-classified-')), 'classified episode written')
  assert.ok(!eps.some(f => f.includes('-planning-')), 'NO bp1-planning episode emitted for trivial (Option A)')
})

tap('T-class-happy-risky schema → state=needs-human, bp1-needs-human episode emitted', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('schema'), preId)
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'needs-human')
  assert.equal(out.decided_class, 'schema')
  const eps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(eps.some(f => f.includes('-needs-human-')))
})

tap('T-class-relative-result-file relative path → exit 2', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = runOrch([
    'record-classification', '--project', ctx.project,
    '--run-id', ctx.runId, '--pre-episode-id', preId,
    '--result-file', 'rel/path.json',
  ], { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('T-class-pre-id-mismatch --pre-episode-id != run.pre_episode_id → exit 5', () => {
  const ctx = setupRfcDetected()
  preDispatch(ctx)
  const wrongPre = `${ctx.runId}-pre-9999`
  const r = recordClassification(ctx, validClassifierOutput(), wrongPre)
  assert.equal(r.status, 5)
})

tap('T-class-wrong-state state != classifier-dispatch-pending → exit 5', () => {
  const ctx = setupRfcDetected()
  // No preDispatch — state is rfc-detected.
  const r = recordClassification(ctx, validClassifierOutput(), `${ctx.runId}-pre-aaaa`)
  assert.equal(r.status, 5)
})

tap('T-class-bad-pre-shape pre-episode-id with traversal chars → exit 2', () => {
  const ctx = setupRfcDetected()
  preDispatch(ctx)
  const r = runOrch([
    'record-classification', '--project', ctx.project,
    '--run-id', ctx.runId, '--pre-episode-id', '../escape',
    '--result-file', '/tmp/foo.json',
  ], { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 2)
})

tap('T-class-missing-result-file → exit 5', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = runOrch([
    'record-classification', '--project', ctx.project,
    '--run-id', ctx.runId, '--pre-episode-id', preId,
    '--result-file', '/tmp/does-not-exist-xxxxx.json',
  ], { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 5)
})

tap('T-class-bad-json → exit 5 + schema-violation ep', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const resultFile = path.join(ctx.project, 'classifier-result.json')
  fs.writeFileSync(resultFile, '{ this is not json')
  const r = runOrch([
    'record-classification', '--project', ctx.project,
    '--run-id', ctx.runId, '--pre-episode-id', preId,
    '--result-file', resultFile,
  ], { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 5)
  const eps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(eps.some(f => f.includes('schema-violation')))
})

tap('T22b prototype-pollution key in result-file → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const resultFile = path.join(ctx.project, 'classifier-result.json')
  fs.writeFileSync(resultFile, '{"__proto__": {"hack": true}, "class": "trivial", "confidence": 0.9, "rationale": "x", "classified_fields": ["a"]}')
  const r = runOrch([
    'record-classification', '--project', ctx.project,
    '--run-id', ctx.runId, '--pre-episode-id', preId,
    '--result-file', resultFile,
  ], { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 5)
})

tap('T22c confidence=-0.1 → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { confidence: -0.1 }), preId)
  assert.equal(r.status, 5)
})

tap('T22d confidence=1.1 → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { confidence: 1.1 }), preId)
  assert.equal(r.status, 5)
})

tap('T22e confidence non-number (string) → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { confidence: '0.9' }), preId)
  assert.equal(r.status, 5)
})

tap('T22f confidence Infinity → schema-violation', () => {
  // JSON.stringify(Infinity) yields null, so we write the file directly.
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const resultFile = path.join(ctx.project, 'classifier-result.json')
  fs.writeFileSync(resultFile, '{"class":"trivial","confidence":null,"rationale":"x","classified_fields":["a"]}')
  const r = runOrch([
    'record-classification', '--project', ctx.project,
    '--run-id', ctx.runId, '--pre-episode-id', preId,
    '--result-file', resultFile,
  ], { project: ctx.project, homeDir: ctx.home })
  assert.equal(r.status, 5)
})

tap('T23b rationale empty → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { rationale: '   ' }), preId)
  assert.equal(r.status, 5)
})

tap('T23c rationale 301 words → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const longRationale = Array(301).fill('w').join(' ')
  const r = recordClassification(ctx, validClassifierOutput('trivial', { rationale: longRationale }), preId)
  assert.equal(r.status, 5)
})

tap('T-class-missing-required result-file missing class field → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const out = validClassifierOutput()
  delete out.class
  const r = recordClassification(ctx, out, preId)
  assert.equal(r.status, 5)
})

tap('T-class-extra-field additionalProperties:false catches extra → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { extra: 'field' }), preId)
  assert.equal(r.status, 5)
})

tap('T-class-bad-class-enum class not in enum → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('not-a-class'), preId)
  assert.equal(r.status, 5)
})

tap('T-class-classified-fields-empty minItems:1 catches empty → schema-violation', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { classified_fields: [] }), preId)
  assert.equal(r.status, 5)
})

tap('T-class-route-eps classified + needs-human route episodes verify HMAC (risky route)', () => {
  // Slice 2d-W (Option A): trivial no longer emits a route episode. Switch
  // this test to use a risky-class input so it still exercises the
  // classified + route HMAC verification path.
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('schema'), preId)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  // Verify classified episode HMAC.
  const v1 = verifyEpisodeOnDisk({
    projectRoot: ctx.project, episodeId: out.classified_episode_id,
    runKey32B: ctx.runKey, expectedType: 'state-transition',
    expectedState: 'classified', expectedRunId: ctx.runId,
  })
  assert.deepEqual(v1, { ok: true })
  // Verify route episode HMAC.
  const v2 = verifyEpisodeOnDisk({
    projectRoot: ctx.project, episodeId: out.route_episode_id,
    runKey32B: ctx.runKey, expectedType: 'state-transition',
    expectedState: 'needs-human', expectedRunId: ctx.runId,
  })
  assert.deepEqual(v2, { ok: true })
})

tap('T-fail-5 parent pre tampered at record-classification → exit 5 + parent-tamper', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  // Tamper pre episode body.
  const epPath = path.join(ctx.project, '.episodic-memory/episodes', `${preId}.md`)
  fs.writeFileSync(epPath, fs.readFileSync(epPath, 'utf8') + '\nTAMPERED\n')
  const r = recordClassification(ctx, validClassifierOutput(), preId)
  assert.equal(r.status, 5)
  const eps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  assert.ok(eps.some(f => f.includes('parent-tamper')))
})

tap('T-class-trivial-route-state classified state in run-state (slice 2d-W Option A)', () => {
  // Trivial-class stays at stable `classified` state per slice 2d-W Option A.
  // `awaiting_approval` is reached via the separate record-awaiting-approval
  // subcommand (1hr safety-envelope window).
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  recordClassification(ctx, validClassifierOutput('trivial'), preId)
  assert.equal(loadIndex(ctx.project).runs[ctx.runId].state, 'classified')
})

tap('T-class-validator-route-state needs-human state in run-state', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  recordClassification(ctx, validClassifierOutput('validator'), preId)
  assert.equal(loadIndex(ctx.project).runs[ctx.runId].state, 'needs-human')
})

tap('T-class-empty-string-in-classified-fields → schema-violation (self-walk fix #3)', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { classified_fields: ['', 'valid'] }), preId)
  assert.equal(r.status, 5)
})

tap('T-class-multibyte-observed-value safe-truncate preserves UTF-8 (self-walk fix #4)', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  // Construct a class value with multibyte chars exceeding 66 bytes to force
  // truncation; verify the failure episode still parses (would not parse if
  // truncate landed mid-UTF8-sequence — frontmatter parser fatal-decodes).
  const longMb = 'café'.repeat(20)   // each "é" is 2 bytes UTF-8
  const r = recordClassification(ctx, validClassifierOutput(longMb), preId)
  assert.equal(r.status, 5)
  // Find the schema-violation episode + parse it (would throw on bad UTF-8).
  const eps = fs.readdirSync(path.join(ctx.project, '.episodic-memory/episodes'))
  const violationEp = eps.find(f => f.includes('schema-violation'))
  assert.ok(violationEp)
  // Parser fatal-decodes UTF-8 — would throw if truncation broke a multi-byte sequence.
  const parsed = fs.readFileSync(path.join(ctx.project, '.episodic-memory/episodes', violationEp), 'utf8')
  assert.match(parsed, /observed_value:/)
})

tap('T-class-classified-conf-stringified classifier_confidence persisted as JSON-quoted string', () => {
  const ctx = setupRfcDetected()
  const { r: pr } = preDispatch(ctx)
  const preId = JSON.parse(pr.stdout).pre_episode_id
  const r = recordClassification(ctx, validClassifierOutput('trivial', { confidence: 0.85 }), preId)
  const out = JSON.parse(r.stdout)
  const epPath = path.join(ctx.project, '.episodic-memory/episodes', `${out.classified_episode_id}.md`)
  const text = fs.readFileSync(epPath, 'utf8')
  // classifier_confidence written as JSON-quoted "0.85" (canonicalize-stable).
  assert.match(text, /classifier_confidence: "0\.85"/)
})

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
