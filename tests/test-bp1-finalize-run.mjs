#!/usr/bin/env node
/**
 * test-bp1-finalize-run.mjs — orchestrator finalize-run + finalize-recover E2E.
 *
 * Coverage (plan v1, codex-consensus ACCEPT-with-FU at round 2; reply
 * 20260509-050444-...-080a):
 *   G2 happy path × invariants (5 subtests)
 *   G3 fence negative matrix (11 cases — plan v3.3 §A.4 + collect-failure FU)
 *   G4 finalize-recover state machine (7 variants)
 *   G5 abort hook + recover restart (8 hook sites N=0..7 + production guard)
 *   G6 cwd-binding matrix (7 happy axes + axis-7 traversal-variant fan-out
 *      + 2 failure-evidence cwd cases + 1 recover cwd case)
 *
 * Fixture conventions (lesson 7efe — no symlinks/pre-staging):
 *   - mkdtempSync(realpath(os.tmpdir())) + git init.
 *   - Real `git worktree add` for axis 5.
 *   - Sandbox HOME with .verify-key planted (mode 0600).
 *   - spawnSync passes explicit cwd: callerCwd; env: HOME=sandboxHome.
 *   - Hook tests add NODE_ENV=test + BP1_TEST_ALLOW_FINALIZE_ABORT=1.
 *   - Cleanup in finally; no symlinks.
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
const TMPDIR_REAL = fs.realpathSync(os.tmpdir())

const { canonicalize } = await import(new URL('../scripts/lib/bp1-canonicalize.mjs', import.meta.url).href)
const { signCanonical, verifyKeyFingerprint } = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { runKeyPath } = await import(new URL('../scripts/lib/bp1-keys.mjs', import.meta.url).href)
const { parseBp1Frontmatter } = await import(new URL('../scripts/lib/bp1-frontmatter.mjs', import.meta.url).href)

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// =============================================================================
// G1 — Sandbox fixture builders
// =============================================================================

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(TMPDIR_REAL, 'bp1-fin-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'juan.delacruz@acme.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Juan Dela Cruz'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory', 'episodes'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.episodic-memory', 'runs'), { recursive: true })
  return fs.realpathSync(dir)
}

function makeSandboxHome() {
  const dir = fs.mkdtempSync(path.join(TMPDIR_REAL, 'bp1-fin-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory', 'episodes'), { recursive: true })
  return fs.realpathSync(dir)
}

function makeNonGitCaller() {
  const dir = fs.mkdtempSync(path.join(TMPDIR_REAL, 'bp1-fin-caller-'))
  return fs.realpathSync(dir)
}

function plantVerifyKey(homeDir) {
  const keyBytes = crypto.randomBytes(32)
  fs.writeFileSync(path.join(homeDir, '.episodic-memory', '.verify-key'), keyBytes, { mode: 0o600 })
  return { keyBytes, fingerprint: verifyKeyFingerprint(keyBytes) }
}

function buildHashAgainstProject(projectRoot, homeDir) {
  const out = execFileSync('node', [ARTIFACT_BUILDER, '--project', projectRoot, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  })
  return JSON.parse(out).sha256
}

function writeConfig(homeDir, projectRoot, fingerprint) {
  const entry = {
    enabled: true,
    artifact_version_hash: 'sha256:' + buildHashAgainstProject(projectRoot, homeDir),
    enabled_at: new Date().toISOString(),
    enabled_via: 'test-fixture',
    verify_key_id: fingerprint,
  }
  const config = { bp1: { schema_version: 1, activations: { [projectRoot]: entry } } }
  fs.writeFileSync(path.join(homeDir, '.episodic-memory', 'config.json'), JSON.stringify(config, null, 2))
}

function setupActiveProject() {
  const project = makeTempProject()
  const home = makeSandboxHome()
  const { fingerprint } = plantVerifyKey(home)
  writeConfig(home, project, fingerprint)
  return { project, home }
}

function spawnOrchestrator(sub, args, opts) {
  const argv = [sub, ...args]
  return spawnSync('node', [ORCHESTRATOR, ...argv], {
    cwd: opts.callerCwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: opts.homeDir, ...(opts.env || {}) },
  })
}

function initRun(project, home, callerCwd) {
  const r = spawnOrchestrator('init-run', ['--project', project, '--rfc-id', 'TEST'], {
    callerCwd: callerCwd || project,
    homeDir: home,
  })
  if (r.status !== 0) throw new Error(`init-run failed: ${r.stderr}`)
  return JSON.parse(r.stdout).run_id
}

function readRunKey(project, runId) {
  return fs.readFileSync(runKeyPath(project, runId))
}

// Build + write a signed episode. Returns episode_id.
function writeEpisode(store, frontmatter, body, key32B) {
  const { canonicalBytes, payload } = canonicalize(frontmatter, body)
  const hmacHex = signCanonical(canonicalBytes, key32B)
  const epId = frontmatter.id
  const fmLines = ['---']
  // Always-present generic + meta keys (parser-strict; no blank lines, no dup keys).
  fmLines.push(`id: ${epId}`)
  fmLines.push(`run_id: ${frontmatter.run_id}`)
  fmLines.push(`type: ${frontmatter.type}`)
  fmLines.push(`parent_episode: ${frontmatter.parent_episode === null ? 'null' : frontmatter.parent_episode}`)
  fmLines.push(`expected_post_episode_id: ${frontmatter.expected_post_episode_id === null ? 'null' : frontmatter.expected_post_episode_id}`)
  fmLines.push(`summary: ${JSON.stringify(frontmatter.summary || `episode ${epId}`)}`)
  fmLines.push(`body_sha256: ${payload.body_sha256}`)
  fmLines.push(`hmac_signature: ${hmacHex}`)
  if (Array.isArray(frontmatter.tags)) fmLines.push(`tags: [${frontmatter.tags.join(', ')}]`)
  fmLines.push('---')
  fmLines.push('')
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(path.join(store, `${epId}.md`), fmLines.join('\n') + body)
  return epId
}

// Seed valid pre+post pair into local store. Returns {preId, postId}.
// IDs use sortable prefixes (1pre / 2post) so pre's filename sorts BEFORE
// post's in fence iteration order — required for `post-is-itself-pre` to fire
// per FU-1 logic (orchestrator l533): pre.expected_post lookup must hit the
// bad post BEFORE the bad post is itself processed as a pre.
function seedPrePost(project, runId, key32B, opts = {}) {
  const localStore = path.join(project, '.episodic-memory', 'episodes')
  const preId = opts.preId || `${runId}-1pre-${crypto.randomBytes(2).toString('hex')}`
  const postId = opts.postId || `${runId}-2post-${crypto.randomBytes(2).toString('hex')}`
  const pre = {
    id: preId,
    run_id: opts.preRunId || runId,
    type: opts.preType || 'plan',
    parent_episode: null,
    expected_post_episode_id: postId,
    summary: 'pre-decision plan',
  }
  const post = {
    id: postId,
    run_id: opts.postRunId || runId,
    type: opts.postType || 'decision',
    parent_episode: opts.postParent || preId,
    expected_post_episode_id: opts.postExpectedPost || null,
    summary: 'post-decision committed',
    tags: opts.postTags || ['bp1-decision'],
  }
  writeEpisode(localStore, pre, '# pre body\n', opts.preKey || key32B)
  writeEpisode(localStore, post, '# post body\n', opts.postKey || key32B)
  return { preId, postId }
}

function listLocalEpisodes(project) {
  const dir = path.join(project, '.episodic-memory', 'episodes')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

function readRunState(project, runId) {
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  if (!fs.existsSync(idxPath)) return null
  return JSON.parse(fs.readFileSync(idxPath, 'utf8')).runs[runId] || null
}

function findEpisodeByTag(project, runId, tag) {
  const dir = path.join(project, '.episodic-memory', 'episodes')
  if (!fs.existsSync(dir)) return null
  for (const f of fs.readdirSync(dir)) {
    const buf = fs.readFileSync(path.join(dir, f))
    let parsed
    try { parsed = parseBp1Frontmatter(buf) } catch { continue }
    if (parsed.frontmatter.run_id !== runId) continue
    if (Array.isArray(parsed.frontmatter.tags) && parsed.frontmatter.tags.includes(tag)) {
      return { path: path.join(dir, f), frontmatter: parsed.frontmatter, body: parsed.body }
    }
  }
  return null
}

// =============================================================================
// G2 — Happy path × invariants
// =============================================================================

tap('G2.1 finalize-run happy: signed manifest emitted; run.key removed; terminal=complete; no caller artifacts', () => {
  const { project, home } = setupActiveProject()
  const caller = makeNonGitCaller()
  const runId = initRun(project, home, project)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], {
    callerCwd: caller, homeDir: home,
  })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  // Manifest under target.
  const manifest = findEpisodeByTag(project, runId, 'bp1-run-manifest')
  assert.ok(manifest, 'bp1-run-manifest must exist under target')
  // run.key absent.
  assert.equal(fs.existsSync(runKeyPath(project, runId)), false)
  // Terminal complete.
  assert.equal(readRunState(project, runId).state, 'complete')
  // Caller has no .episodic-memory.
  assert.equal(fs.existsSync(path.join(caller, '.episodic-memory')), false)
})

tap('G2.2 finalize-run idempotent on already-terminal run (post-terminal absence)', () => {
  const { project, home } = setupActiveProject()
  const runId = initRun(project, home)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  // Second invocation should fail-closed (key already shredded → diagnostic).
  const r2 = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r2.status, 4, 'second finalize-run on terminal run must exit 4 (key missing)')
  assert.equal(readRunState(project, runId).state, 'complete', 'state stays complete')
})

tap('G2.3 manifest payload project_root equals realpath(--project)', () => {
  const { project, home } = setupActiveProject()
  const runId = initRun(project, home)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  const manifest = findEpisodeByTag(project, runId, 'bp1-run-manifest')
  const payload = JSON.parse(manifest.body)
  assert.equal(payload.project_root, project, 'manifest.project_root must equal realpath(--project)')
})

tap('G2.4 finalize-recover State B happy (key missing + state active)', () => {
  const { project, home } = setupActiveProject()
  const runId = initRun(project, home)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  // Run finalize, then re-create active state to simulate State B (manifest valid, key gone, state active).
  spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  // Reset state to active (manifest is preserved).
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.state, 'B')
  assert.equal(readRunState(project, runId).state, 'complete')
})

tap('G2.5 verify-key load failure at step 4 → signed fence-fail; key still present; state active', () => {
  const { project, home } = setupActiveProject()
  const runId = initRun(project, home)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  // chmod verify-key 0o000 so loadVerifyKey returns {error: 'mode'}.
  const vkPath = path.join(home, '.episodic-memory', '.verify-key')
  fs.chmodSync(vkPath, 0o000)
  try {
    const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
    assert.equal(r.status, 4)
    assert.match(r.stderr, /verify-key/)
    const fence = findEpisodeByTag(project, runId, 'bp1-finalize-fence-fail')
    assert.ok(fence, 'signed fence-fail evidence required')
    assert.ok(fs.existsSync(runKeyPath(project, runId)), 'run.key must remain')
    assert.equal(readRunState(project, runId).state, 'active', 'state must stay active')
    assert.equal(findEpisodeByTag(project, runId, 'bp1-run-manifest'), null, 'no manifest')
  } finally {
    fs.chmodSync(vkPath, 0o600)
  }
})

// =============================================================================
// G3 — Fence negative matrix (11 cases)
// =============================================================================

const G3_CASES = [
  {
    name: 'G3.1 no matching post → pre-decision-no-matching-post',
    seed: (project, runId, key) => {
      const localStore = path.join(project, '.episodic-memory', 'episodes')
      const preId = `${runId}-pre-orphan`
      writeEpisode(localStore, {
        id: preId, run_id: runId, type: 'plan', parent_episode: null,
        expected_post_episode_id: `${runId}-nonexistent-post`, summary: 'orphan pre',
      }, '# pre\n', key)
    },
    reasonRegex: /pre-decision-no-matching-post/,
  },
  {
    name: 'G3.2 wrong run_id on post → post-wrong-run-id',
    seed: (project, runId, key) => {
      seedPrePost(project, runId, key, { postRunId: 'bp1-run-9999999999999-other-aaaaaa' })
    },
    reasonRegex: /post-wrong-run-id/,
  },
  {
    name: 'G3.3 wrong parent_episode → post-wrong-parent-episode',
    seed: (project, runId, key) => {
      seedPrePost(project, runId, key, { postParent: `${runId}-bogus-parent` })
    },
    reasonRegex: /post-wrong-parent-episode/,
  },
  {
    name: 'G3.4 post-is-itself-pre → post-is-itself-pre',
    seed: (project, runId, key) => {
      seedPrePost(project, runId, key, { postExpectedPost: `${runId}-some-other-post` })
    },
    reasonRegex: /post-is-itself-pre/,
  },
  {
    name: 'G3.5 wrong type → post-wrong-type',
    seed: (project, runId, key) => {
      seedPrePost(project, runId, key, { postType: 'evidence' })
    },
    reasonRegex: /post-wrong-type/,
  },
  {
    name: 'G3.6 missing bp1-decision tag → post-missing-bp1-decision-tag',
    seed: (project, runId, key) => {
      seedPrePost(project, runId, key, { postTags: ['some-other-tag'] })
    },
    reasonRegex: /post-missing-bp1-decision-tag/,
  },
  {
    name: 'G3.7 tampered body_sha256 → post-body-sha256-mismatch',
    seed: (project, runId, key) => {
      const { postId } = seedPrePost(project, runId, key)
      // Mutate body_sha256 in the post's frontmatter on disk.
      const postPath = path.join(project, '.episodic-memory', 'episodes', `${postId}.md`)
      let text = fs.readFileSync(postPath, 'utf8')
      text = text.replace(/^body_sha256: [0-9a-f]+/m, 'body_sha256: ' + 'a'.repeat(64))
      fs.writeFileSync(postPath, text)
    },
    reasonRegex: /post-body-sha256-mismatch/,
  },
  {
    name: 'G3.8 forged HMAC → post-hmac-signature-invalid',
    seed: (project, runId, key) => {
      const wrongKey = crypto.randomBytes(32)
      seedPrePost(project, runId, key, { postKey: wrongKey })
    },
    reasonRegex: /post-hmac-signature-invalid/,
  },
  {
    name: 'G3.9 duplicate post-id with conflicting content (local + global) → exit 4 (collect throw or fence)',
    seed: (project, runId, key, home) => {
      const { postId } = seedPrePost(project, runId, key)
      // Plant a conflicting copy in HOME global store.
      const globalStore = path.join(home, '.episodic-memory', 'episodes')
      writeEpisode(globalStore, {
        id: postId, run_id: runId, type: 'decision', parent_episode: 'different-parent',
        expected_post_episode_id: null, summary: 'forged duplicate', tags: ['bp1-decision'],
      }, '# different body\n', key)
    },
    // Either collect-records-failed or one of the fence reasons fires; both are exit 4 with key+state preserved.
    reasonRegex: /(collect-records-failed|post-wrong-parent-episode|post-body-sha256-mismatch|post-hmac-signature-invalid|duplicate)/,
  },
  {
    name: 'G3.10 run.key chmod 0o000 → unsigned diagnostic; state active',
    seed: (project, runId, key) => {
      seedPrePost(project, runId, key)
      fs.chmodSync(runKeyPath(project, runId), 0o000)
    },
    reasonRegex: /run\.key (mode|missing|size|unreadable)/,
    unsigned: true,
    cleanup: (project, runId) => { try { fs.chmodSync(runKeyPath(project, runId), 0o600) } catch {} },
  },
  {
    name: 'G3.11 collect parser failure on BP1-tagged malformed file → collect-records-failed',
    seed: (project, runId, key) => {
      seedPrePost(project, runId, key)
      // Plant malformed BP1-tagged episode for SAME run that fence has already passed.
      const localStore = path.join(project, '.episodic-memory', 'episodes')
      const garbage = `---\nrun_id: ${runId}\ntags: [bp1-something]\nid: ${runId}-garbage\nbody_sha256:`  // missing closing fence
      fs.writeFileSync(path.join(localStore, `${runId}-garbage.md`), garbage)
    },
    reasonRegex: /collectEpisodeRecords failed/,
  },
]

for (const tc of G3_CASES) {
  tap(tc.name, () => {
    const { project, home } = setupActiveProject()
    const runId = initRun(project, home)
    const key = readRunKey(project, runId)
    tc.seed(project, runId, key, home)
    try {
      const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
      assert.equal(r.status, 4, `expected exit 4; got ${r.status}; stderr=${r.stderr}`)
      assert.match(r.stderr, tc.reasonRegex, `stderr must match ${tc.reasonRegex}; got: ${r.stderr}`)
      // Common asserts.
      assert.equal(findEpisodeByTag(project, runId, 'bp1-run-manifest'), null, 'no manifest')
      assert.equal(readRunState(project, runId).state, 'active', 'state must stay active')
      if (tc.unsigned) {
        const diag = findEpisodeByTag(project, runId, 'bp1-finalize-diagnostic')
        assert.ok(diag, 'unsigned diagnostic required')
        assert.equal(diag.frontmatter.hmac_signature, undefined, 'diagnostic must NOT have hmac_signature')
      } else {
        const fence = findEpisodeByTag(project, runId, 'bp1-finalize-fence-fail')
        assert.ok(fence, 'signed fence-fail evidence required')
        assert.ok(typeof fence.frontmatter.hmac_signature === 'string', 'fence-fail must be signed')
        assert.ok(fs.existsSync(runKeyPath(project, runId)), 'run.key must remain (signed branch)')
      }
    } finally {
      if (tc.cleanup) tc.cleanup(project, runId)
    }
  })
}

// =============================================================================
// G4 — finalize-recover state machine (7 variants)
// =============================================================================

function setupRunWithManifest() {
  const { project, home } = setupActiveProject()
  const runId = initRun(project, home)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r.status, 0, `setup finalize must succeed: ${r.stderr}`)
  return { project, home, runId, key }
}

tap('G4 State A happy: valid manifest + live key → exit 0; key removed; terminal', () => {
  const { project, home, runId } = setupRunWithManifest()
  // Reset to active + replant a valid key (re-derived: we only need state=A precondition).
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  // Re-plant a 32B run.key — recover State A only requires loadRunKey returns {key32B}.
  fs.mkdirSync(path.dirname(runKeyPath(project, runId)), { recursive: true })
  fs.writeFileSync(runKeyPath(project, runId), crypto.randomBytes(32), { mode: 0o600 })
  const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.equal(JSON.parse(r.stdout).state, 'A')
  assert.equal(fs.existsSync(runKeyPath(project, runId)), false)
  assert.equal(readRunState(project, runId).state, 'complete')
})

tap('G4 State A fail (shred fails) → exit 4; key still present; state active; no terminal', () => {
  const { project, home, runId } = setupRunWithManifest()
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  // Re-plant key and make run dir read-only so shred unlinkSync fails.
  const keyPath = runKeyPath(project, runId)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 })
  fs.chmodSync(path.dirname(keyPath), 0o500)
  try {
    const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
    assert.equal(r.status, 4)
    assert.ok(fs.existsSync(keyPath), 'key still present')
    assert.equal(readRunState(project, runId).state, 'active', 'state stays active')
  } finally {
    fs.chmodSync(path.dirname(keyPath), 0o700)
  }
})

tap('G4 State B happy: manifest valid + key missing + active → terminal', () => {
  const { project, home, runId } = setupRunWithManifest()
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  // Key is already shredded from setupRunWithManifest's finalize. State B precondition: missing.
  const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.equal(JSON.parse(r.stdout).state, 'B')
  assert.equal(readRunState(project, runId).state, 'complete')
})

tap('G4 State C variant 1 (corrupt signature): exit 4 fail-closed; state active', () => {
  const { project, home, runId } = setupRunWithManifest()
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  // Mutate one byte of manifest_signature.
  const manifest = findEpisodeByTag(project, runId, 'bp1-run-manifest')
  let text = fs.readFileSync(manifest.path, 'utf8')
  text = text.replace(/^manifest_signature: ([0-9a-f])/m, (_m, c) => `manifest_signature: ${c === '0' ? '1' : '0'}`)
  fs.writeFileSync(manifest.path, text)
  const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r.status, 4)
  assert.match(r.stderr, /signature invalid|State C/)
  assert.equal(readRunState(project, runId).state, 'active', 'state stays active')
})

tap('G4 State C variant 2 (disk-mismatch): valid sig + mutated covered episode → exit 4', () => {
  const { project, home, runId } = setupRunWithManifest()
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  // Mutate the body of one covered episode (post). Manifest signature stays valid
  // (it was signed over original payload), but verifyOnDiskEqualsManifest now fails.
  const ep = path.join(project, '.episodic-memory', 'episodes')
  const target = fs.readdirSync(ep).find(f => f.includes('-2post-'))
  assert.ok(target, 'post episode must exist')
  const targetPath = path.join(ep, target)
  let text = fs.readFileSync(targetPath, 'utf8')
  text = text.replace('# post body\n', '# tampered body\n')
  fs.writeFileSync(targetPath, text)
  const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r.status, 4)
  // FU from codex code-review round 1 (reply 20260509-052741-...-ec79): require
  // the disk-mismatch path explicitly so a future signature-failure short-
  // circuit cannot vacuously satisfy this named test.
  assert.match(r.stderr, /on-disk records do not match manifest/)
  assert.doesNotMatch(r.stderr, /signature invalid/)
  assert.equal(readRunState(project, runId).state, 'active')
})

tap('G4 State D happy: damaged key (mode 0o000) → unlinked + terminal', () => {
  const { project, home, runId } = setupRunWithManifest()
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  // Re-plant a key, then chmod 0o000 → loadRunKey returns {error: 'mode'}.
  const keyPath = runKeyPath(project, runId)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 })
  fs.chmodSync(keyPath, 0o000)
  const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.equal(JSON.parse(r.stdout).state, 'D')
  assert.equal(fs.existsSync(keyPath), false, 'damaged key must be unlinked')
  assert.equal(readRunState(project, runId).state, 'complete')
})

tap('G4 State D fail (unlink fails): damaged key remains; state active; no terminal', () => {
  const { project, home, runId } = setupRunWithManifest()
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  const keyPath = runKeyPath(project, runId)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 })
  fs.chmodSync(keyPath, 0o000)
  // Make run dir read-only so unlinkSync fails (non-ENOENT).
  fs.chmodSync(path.dirname(keyPath), 0o500)
  try {
    const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
    assert.equal(r.status, 4)
    assert.ok(fs.existsSync(keyPath), 'damaged key still present')
    assert.equal(readRunState(project, runId).state, 'active')
  } finally {
    fs.chmodSync(path.dirname(keyPath), 0o700)
    try { fs.chmodSync(keyPath, 0o600) } catch {}
  }
})

// =============================================================================
// G5 — Abort hook + recover restart (8 hook sites N=0..7 + production guard)
//
// G5_TABLE per codex round-2 reply (line numbers verified against ee51d1f):
// N=0 (l675) after key load     | recover State C (no manifest)
// N=1 (l684) after fence        | recover State C (no manifest)
// N=2 (l695) after collect      | recover State C (no manifest)
// N=3 (l699) after step-3 hook (records-root computed later in buildManifestPayload at l712)
// N=4 (l719) after manifest write   | recover State A (key removed, terminal)
// N=5 (l749) after disk reread fence | recover State A (key removed, terminal)
// N=6 (l763) after key shred    | recover State B (terminal)
// N=7 (l772) after terminal mark | recover idempotent (already terminal)
// =============================================================================

const G5_TABLE = [
  { N: 0, manifestAfter: false, keyAfter: true,  recoverState: 'C', recoverExit: 4 },
  { N: 1, manifestAfter: false, keyAfter: true,  recoverState: 'C', recoverExit: 4 },
  { N: 2, manifestAfter: false, keyAfter: true,  recoverState: 'C', recoverExit: 4 },
  { N: 3, manifestAfter: false, keyAfter: true,  recoverState: 'C', recoverExit: 4 },
  { N: 4, manifestAfter: true,  keyAfter: true,  recoverState: 'A', recoverExit: 0 },
  { N: 5, manifestAfter: true,  keyAfter: true,  recoverState: 'A', recoverExit: 0 },
  { N: 6, manifestAfter: true,  keyAfter: false, recoverState: 'B', recoverExit: 0 },
  { N: 7, manifestAfter: true,  keyAfter: false, recoverState: 'B', recoverExit: 0 },
]

for (const tc of G5_TABLE) {
  tap(`G5 abort N=${tc.N} → manifestAfter=${tc.manifestAfter} keyAfter=${tc.keyAfter} → recover State ${tc.recoverState} exit ${tc.recoverExit}`, () => {
    const { project, home } = setupActiveProject()
    const runId = initRun(project, home)
    const key = readRunKey(project, runId)
    seedPrePost(project, runId, key)
    // Abort.
    const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], {
      callerCwd: project, homeDir: home,
      env: { NODE_ENV: 'test', BP1_TEST_ALLOW_FINALIZE_ABORT: '1', BP1_TEST_ABORT_AFTER_FINALIZE_STEP: String(tc.N) },
    })
    assert.notEqual(r.status, 0, 'finalize must abort')
    assert.match(r.stderr, /BP1_TEST_ABORT_AFTER_FINALIZE_STEP/, 'abort stack trace must surface')
    // Post-abort state.
    assert.equal(!!findEpisodeByTag(project, runId, 'bp1-run-manifest'), tc.manifestAfter, 'manifestAfter mismatch')
    assert.equal(fs.existsSync(runKeyPath(project, runId)), tc.keyAfter, 'keyAfter mismatch')
    if (tc.N < 7) {
      assert.equal(readRunState(project, runId).state, 'active', 'pre-N=7 state must stay active')
    }
    // Recover.
    const rr = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: project, homeDir: home })
    assert.equal(rr.status, tc.recoverExit, `recover exit; stderr=${rr.stderr}`)
    if (tc.recoverExit === 0) {
      assert.equal(JSON.parse(rr.stdout).state, tc.recoverState)
      assert.equal(readRunState(project, runId).state, 'complete')
    } else {
      assert.match(rr.stderr, /State C/)
      assert.equal(readRunState(project, runId).state, 'active', 'pre-manifest crash recover must NOT mark terminal')
    }
  })
}

tap('G5.production hook env set + NODE_ENV=production → does NOT fire; finalize succeeds', () => {
  const { project, home } = setupActiveProject()
  const runId = initRun(project, home)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], {
    callerCwd: project, homeDir: home,
    env: { NODE_ENV: 'production', BP1_TEST_ALLOW_FINALIZE_ABORT: '1', BP1_TEST_ABORT_AFTER_FINALIZE_STEP: '4' },
  })
  assert.equal(r.status, 0, `production must succeed; stderr=${r.stderr}`)
  assert.doesNotMatch(r.stderr, /BP1_TEST_ABORT_AFTER_FINALIZE_STEP/, 'hook must not fire in production')
})

// =============================================================================
// G6 — #20 cwd-binding matrix
//
// Per-axis assertion (applies to all axes): callerCwd has no NEW BP1 finalize
// artifacts under .episodic-memory/episodes; sandboxHome global has no NEW
// finalize artifacts either (global may already have unrelated files; we
// snapshot before/after).
// =============================================================================

function snapshotEpisodes(dir) {
  if (!fs.existsSync(dir)) return new Set()
  return new Set(fs.readdirSync(dir))
}

function diffEpisodes(beforeSet, dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => !beforeSet.has(f))
}

function runHappyFinalizeFromCwd(project, home, callerCwd) {
  const runId = initRun(project, home, project)
  const key = readRunKey(project, runId)
  seedPrePost(project, runId, key)
  const callerEpDir = path.join(callerCwd, '.episodic-memory', 'episodes')
  const homeEpDir = path.join(home, '.episodic-memory', 'episodes')
  // Skip caller-absence asserts when callerCwd is the same as projectRoot or
  // nested inside it (axes 1 and 4): caller==target by design, so the absence
  // invariant is vacuous. Cwd-binding is still validated by axes 2/3/5/6 etc.
  const callerInsideTarget = callerCwd === project || callerCwd.startsWith(project + path.sep)
  const callerBefore = snapshotEpisodes(callerEpDir)
  const homeBefore = snapshotEpisodes(homeEpDir)
  const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd, homeDir: home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.ok(findEpisodeByTag(project, runId, 'bp1-run-manifest'), 'manifest under target')
  if (!callerInsideTarget) {
    assert.deepEqual(diffEpisodes(callerBefore, callerEpDir), [], 'caller .episodic-memory/episodes must have no new files')
  }
  assert.deepEqual(diffEpisodes(homeBefore, homeEpDir), [], 'sandbox HOME global must have no new files')
}

tap('G6 axis 1 cwd=projectRoot (baseline)', () => {
  const { project, home } = setupActiveProject()
  runHappyFinalizeFromCwd(project, home, project)
})

tap('G6 axis 2 cwd at non-git tmp dir', () => {
  const { project, home } = setupActiveProject()
  runHappyFinalizeFromCwd(project, home, makeNonGitCaller())
})

tap('G6 axis 3 cwd at sandboxHome', () => {
  const { project, home } = setupActiveProject()
  runHappyFinalizeFromCwd(project, home, home)
})

tap('G6 axis 4 cwd nested inside projectRoot', () => {
  const { project, home } = setupActiveProject()
  const sub = path.join(project, 'sub')
  fs.mkdirSync(sub)
  runHappyFinalizeFromCwd(project, home, sub)
})

tap('G6 axis 5 real `git worktree add` — caller=main worktree, --project=linked', () => {
  // Main repo with one commit so worktree add works.
  const main = makeTempProject()
  fs.writeFileSync(path.join(main, 'README.md'), '# main\n')
  execFileSync('git', ['add', '.'], { cwd: main })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: main, env: { ...process.env, GIT_AUTHOR_NAME: 'Juan Dela Cruz', GIT_AUTHOR_EMAIL: 'juan.delacruz@acme.com', GIT_COMMITTER_NAME: 'Juan Dela Cruz', GIT_COMMITTER_EMAIL: 'juan.delacruz@acme.com' } })
  // Linked worktree as the --project target.
  const linked = fs.realpathSync(fs.mkdtempSync(path.join(TMPDIR_REAL, 'bp1-fin-linked-')))
  fs.rmSync(linked, { recursive: true, force: true })  // worktree add wants empty/missing target
  execFileSync('git', ['worktree', 'add', '-q', linked, '-b', 'bp1-fin-test'], { cwd: main })
  fs.mkdirSync(path.join(linked, '.episodic-memory', 'episodes'), { recursive: true })
  fs.mkdirSync(path.join(linked, '.episodic-memory', 'runs'), { recursive: true })
  // Activate the linked worktree's project root in sandbox HOME.
  const home = makeSandboxHome()
  const { fingerprint } = plantVerifyKey(home)
  writeConfig(home, fs.realpathSync(linked), fingerprint)
  runHappyFinalizeFromCwd(fs.realpathSync(linked), home, main)
})

tap('G6 axis 6 cwd=/', () => {
  const { project, home } = setupActiveProject()
  runHappyFinalizeFromCwd(project, home, '/')
})

const TRAVERSAL_VARIANTS = ['../escape', '/etc/passwd', '..', 'bad/slash']
for (const variant of TRAVERSAL_VARIANTS) {
  tap(`G6 axis 7 invalid --run-id ${JSON.stringify(variant)} → exit 2; no artifacts`, () => {
    const { project, home } = setupActiveProject()
    const caller = makeNonGitCaller()
    const callerBefore = snapshotEpisodes(path.join(caller, '.episodic-memory', 'episodes'))
    const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', variant], { callerCwd: caller, homeDir: home })
    assert.equal(r.status, 2, `expected exit 2; got ${r.status}; stderr=${r.stderr}`)
    assert.match(r.stderr, /run-id has invalid shape/)
    assert.equal(diffEpisodes(callerBefore, path.join(caller, '.episodic-memory', 'episodes')).length, 0, 'no caller artifacts')
    assert.equal(listLocalEpisodes(project).length, 0, 'no project artifacts')
  })
}

// G6 failure-evidence cwd-binding (per round-1 finding G6-F1).
tap('G6 failure-evidence: signed fence-fail under target only when called from non-target cwd', () => {
  const { project, home } = setupActiveProject()
  const caller = makeNonGitCaller()
  const runId = initRun(project, home, project)
  const key = readRunKey(project, runId)
  // No post → fence fails with pre-decision-no-matching-post.
  const localStore = path.join(project, '.episodic-memory', 'episodes')
  writeEpisode(localStore, {
    id: `${runId}-orphan`, run_id: runId, type: 'plan', parent_episode: null,
    expected_post_episode_id: `${runId}-missing-post`, summary: 'orphan',
  }, '# orphan\n', key)
  const callerBefore = snapshotEpisodes(path.join(caller, '.episodic-memory', 'episodes'))
  const homeBefore = snapshotEpisodes(path.join(home, '.episodic-memory', 'episodes'))
  const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: caller, homeDir: home })
  assert.equal(r.status, 4)
  const fence = findEpisodeByTag(project, runId, 'bp1-finalize-fence-fail')
  assert.ok(fence, 'signed fence-fail under target')
  assert.ok(fence.path.startsWith(project), 'fence-fail path must be under project')
  assert.equal(diffEpisodes(callerBefore, path.join(caller, '.episodic-memory', 'episodes')).length, 0, 'no caller artifacts')
  assert.equal(diffEpisodes(homeBefore, path.join(home, '.episodic-memory', 'episodes')).length, 0, 'no HOME artifacts')
})

tap('G6 failure-evidence: unsigned diagnostic under target only when called from non-target cwd', () => {
  const { project, home } = setupActiveProject()
  const caller = makeNonGitCaller()
  const runId = initRun(project, home, project)
  fs.chmodSync(runKeyPath(project, runId), 0o000)
  try {
    const callerBefore = snapshotEpisodes(path.join(caller, '.episodic-memory', 'episodes'))
    const homeBefore = snapshotEpisodes(path.join(home, '.episodic-memory', 'episodes'))
    const r = spawnOrchestrator('finalize-run', ['--project', project, '--run-id', runId], { callerCwd: caller, homeDir: home })
    assert.equal(r.status, 4)
    const diag = findEpisodeByTag(project, runId, 'bp1-finalize-diagnostic')
    assert.ok(diag, 'unsigned diagnostic under target')
    assert.ok(diag.path.startsWith(project), 'diagnostic path must be under project')
    assert.equal(diag.frontmatter.hmac_signature, undefined, 'diagnostic must NOT be signed')
    assert.equal(diffEpisodes(callerBefore, path.join(caller, '.episodic-memory', 'episodes')).length, 0)
    assert.equal(diffEpisodes(homeBefore, path.join(home, '.episodic-memory', 'episodes')).length, 0)
  } finally {
    fs.chmodSync(runKeyPath(project, runId), 0o600)
  }
})

// G6 recover cwd-binding (per round-1 finding G6-F4).
tap('G6 recover cwd-binding: finalize-recover State A from non-git caller cwd → mutates target only', () => {
  const { project, home, runId } = setupRunWithManifest()
  const caller = makeNonGitCaller()
  // Reset state and replant key for State A.
  const idxPath = path.join(project, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].state = 'active'
  idx.runs[runId].terminal_at = null
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n')
  const keyPath = runKeyPath(project, runId)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 })
  const callerBefore = snapshotEpisodes(path.join(caller, '.episodic-memory', 'episodes'))
  const r = spawnOrchestrator('finalize-recover', ['--project', project, '--run-id', runId], { callerCwd: caller, homeDir: home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  assert.equal(JSON.parse(r.stdout).state, 'A')
  assert.equal(fs.existsSync(keyPath), false, 'target key removed')
  assert.equal(readRunState(project, runId).state, 'complete', 'target marked terminal')
  assert.equal(diffEpisodes(callerBefore, path.join(caller, '.episodic-memory', 'episodes')).length, 0, 'no caller artifacts')
})

// =============================================================================
// Footer — TAP summary
// =============================================================================
console.log(`# tests ${pass + fail}`)
console.log(`# pass ${pass}`)
console.log(`# fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
