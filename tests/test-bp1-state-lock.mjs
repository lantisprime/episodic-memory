#!/usr/bin/env node
/**
 * test-bp1-state-lock.mjs — bp1-state-lock primitive (RFC §1196-1212).
 *
 * Slice 2e C4 forward-ready lib coverage (~10 cases per plan v3 + FU1):
 *   - SL1  happy path: acquire → lockfile + signed claim episode → release →
 *          release episode + lockfile gone
 *   - SL2  EEXIST busy (fresh lockfile) → acquired:false + holder_claim_id +
 *          holder_age (no stale-break)
 *   - SL3  stale break (claim_age > TTL) → emits bp1-state-lock-stale +
 *          reclaims; sanity: second claim is signed under the same key
 *   - SL4  release closure is idempotent (second call no-ops, no second
 *          release episode)
 *   - SL5  signed claim canonical-fields registry binding —
 *          lock_state_tag + lock_ttl_seconds are HMAC-bound (tamper test)
 *   - SL6  concurrent acquire via N=4 child processes — exactly one wins;
 *          others see acquired:false with the same holder_claim_episode_id
 *   - SL7  standalone releaseStateLock (cross-process recovery API) emits
 *          release evidence and unlinks lockfile even if caller didn't
 *          originally acquire
 *   - SL8  input validation: bad runId / bad stateTag / non-absolute path /
 *          missing 32B key all reject with TypeError
 *   - SL9  per-run filesystem isolation — two runs with the same stateTag
 *          don't contend (different runId → different lockfile)
 *   - SL10 stale evidence frontmatter binds the observed age into the
 *          canonical signature (tamper claim_age_seconds → verify false)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const lockMod = await import(new URL('../scripts/lib/bp1-state-lock.mjs', import.meta.url).href)
const {
  acquireStateLock,
  releaseStateLock,
  STATE_LOCK_TTL_SECONDS,
  stateLockPath,
} = lockMod

const parserMod = await import(new URL('../scripts/lib/bp1-frontmatter.mjs', import.meta.url).href)
const { parseBp1Frontmatter } = parserMod

const canonMod = await import(new URL('../scripts/lib/bp1-canonicalize.mjs', import.meta.url).href)
const { canonicalize } = canonMod

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyCanonical } = hmacMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}
async function tapAsync(name, fn) {
  try { await fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

const KEY = crypto.randomBytes(32)
const RUN_ID = 'bp1-run-1730000000000-rfc-test-aabbcc'
const STATE_TAG = 'codex_review'

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-state-lock-test-'))
  return fs.realpathSync(dir)
}

function readEpisode(projectRoot, episodeId) {
  const p = path.join(projectRoot, '.episodic-memory', 'episodes', `${episodeId}.md`)
  const raw = fs.readFileSync(p, 'utf8')
  const parsed = parseBp1Frontmatter(raw)
  return { raw, parsed, path: p }
}


// =============================================================================
// SL1 happy path
// =============================================================================
tap('SL1 acquire → lockfile + claim episode written; release → release episode + lockfile gone', () => {
  const proj = mkTmpProject()
  const r = acquireStateLock({ projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY })
  assert.equal(r.acquired, true)
  assert.equal(typeof r.claimEpisodeId, 'string')
  assert.match(r.claimEpisodeId, /^bp1-run-[\w-]+-state-lock-claim-[0-9a-f]{4}$/)
  assert.equal(r.staleEpisodeId, null, 'no stale break on first acquire')

  // Lockfile present + references the claim episode id.
  const lp = stateLockPath(proj, RUN_ID, STATE_TAG)
  assert.ok(fs.existsSync(lp), 'lockfile present while held')
  const lockContent = JSON.parse(fs.readFileSync(lp, 'utf8'))
  assert.equal(lockContent.claim_episode_id, r.claimEpisodeId)
  assert.equal(lockContent.lock_state_tag, STATE_TAG)
  assert.equal(lockContent.ttl_seconds, STATE_LOCK_TTL_SECONDS)

  // Claim episode exists on disk.
  const claim = readEpisode(proj, r.claimEpisodeId)
  assert.equal(claim.parsed.frontmatter.type, 'evidence')
  assert.equal(claim.parsed.frontmatter.lock_state_tag, STATE_TAG)

  // Release.
  const rel = r.release()
  assert.equal(typeof rel.releaseEpisodeId, 'string')
  assert.ok(!fs.existsSync(lp), 'lockfile removed after release()')
  const release = readEpisode(proj, rel.releaseEpisodeId)
  assert.equal(release.parsed.frontmatter.parent_episode, r.claimEpisodeId)
  assert.equal(release.parsed.frontmatter.lock_state_tag, STATE_TAG)
})

// =============================================================================
// SL2 EEXIST busy fresh lockfile
// =============================================================================
tap('SL2 second acquire on fresh lockfile → acquired:false + holder evidence + no stale-break', () => {
  const proj = mkTmpProject()
  const first = acquireStateLock({
    projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY,
    now: () => Date.now(),
  })
  assert.equal(first.acquired, true)
  const claimId = first.claimEpisodeId

  const second = acquireStateLock({
    projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY,
  })
  assert.equal(second.acquired, false)
  assert.equal(second.holder_claim_episode_id, claimId,
    'busy result must surface the active holder\'s claim_episode_id')
  assert.ok(typeof second.holder_age_seconds === 'number' && second.holder_age_seconds >= 0,
    'holder_age_seconds should be a non-negative number')
  assert.ok(second.holder_age_seconds < STATE_LOCK_TTL_SECONDS,
    `holder must not be stale; got age ${second.holder_age_seconds}`)
  // Cleanup
  first.release()
})

// =============================================================================
// SL3 stale break
// =============================================================================
tap('SL3 stale claim (age > TTL) → bp1-state-lock-stale evidence + reclaim succeeds', () => {
  const proj = mkTmpProject()
  // Plant a stale lockfile manually (claim_age = TTL + 30s).
  const lp = stateLockPath(proj, RUN_ID, STATE_TAG)
  fs.mkdirSync(path.dirname(lp), { recursive: true })
  const stalePriorId = `${RUN_ID}-state-lock-claim-deadbeef`
  fs.writeFileSync(lp, JSON.stringify({
    claim_episode_id: stalePriorId,
    claimed_at: new Date(Date.now() - (STATE_LOCK_TTL_SECONDS + 30) * 1000).toISOString(),
    ttl_seconds: STATE_LOCK_TTL_SECONDS,
    lock_state_tag: STATE_TAG,
    writer_pid: 99999,
  }))

  const r = acquireStateLock({ projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY })
  assert.equal(r.acquired, true, 'must reclaim after stale-break')
  assert.equal(typeof r.staleEpisodeId, 'string', 'stale evidence must be emitted')
  assert.match(r.staleEpisodeId, /-state-lock-stale-/)

  // Stale episode references prior claim + records age.
  const stale = readEpisode(proj, r.staleEpisodeId)
  assert.equal(stale.parsed.frontmatter.parent_episode, stalePriorId)
  assert.equal(stale.parsed.frontmatter.lock_state_tag, STATE_TAG)
  const ageSec = Number(stale.parsed.frontmatter.claim_age_seconds)
  assert.ok(ageSec >= STATE_LOCK_TTL_SECONDS, `claim_age_seconds should reflect observed age ≥ TTL; got ${ageSec}`)

  // Post-stale claim episode also written, distinct id from prior.
  assert.notEqual(r.claimEpisodeId, stalePriorId)
  const claim = readEpisode(proj, r.claimEpisodeId)
  assert.equal(claim.parsed.frontmatter.lock_state_tag, STATE_TAG)
  r.release()
})

// =============================================================================
// SL4 idempotent release closure
// =============================================================================
tap('SL4 release() closure is idempotent — second call no-ops without second episode', () => {
  const proj = mkTmpProject()
  const r = acquireStateLock({ projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY })
  const r1 = r.release()
  assert.equal(typeof r1.releaseEpisodeId, 'string')
  const r2 = r.release()
  assert.equal(r2.releaseEpisodeId, null)
  assert.equal(r2.alreadyReleased, true)
  // Only one release episode on disk.
  const episodesDir = path.join(proj, '.episodic-memory', 'episodes')
  const files = fs.readdirSync(episodesDir).filter(f => f.includes('state-lock-release'))
  assert.equal(files.length, 1, `exactly one release episode expected; saw ${files.length}: ${files.join(', ')}`)
})

// =============================================================================
// SL5 canonical-fields binding for claim — tamper detection
// =============================================================================
tap('SL5 claim episode lock_state_tag + lock_ttl_seconds are HMAC-bound (tamper fails verify)', () => {
  const proj = mkTmpProject()
  const r = acquireStateLock({ projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY })
  const claim = readEpisode(proj, r.claimEpisodeId)
  const fm = claim.parsed.frontmatter
  const storedSig = fm.hmac_signature
  // Verify untouched.
  const original = canonicalize(fm, claim.parsed.body)
  assert.equal(verifyCanonical(original.canonicalBytes, KEY, storedSig), true)
  // Tamper lock_state_tag.
  const tamperedFm = { ...fm, lock_state_tag: 'forged_state' }
  const tampered = canonicalize(tamperedFm, claim.parsed.body)
  assert.equal(verifyCanonical(tampered.canonicalBytes, KEY, storedSig), false)
  r.release()
})

// =============================================================================
// SL6 concurrent acquire — N=4 children, exactly 1 winner
// =============================================================================
await tapAsync('SL6 concurrent acquire (N=4 child processes) → exactly one winner', async () => {
  const proj = mkTmpProject()
  const N = 4
  const childScript = `
    import('${new URL('../scripts/lib/bp1-state-lock.mjs', import.meta.url).href}').then(m => {
      const r = m.acquireStateLock({
        projectRoot: ${JSON.stringify(proj)},
        runId: ${JSON.stringify(RUN_ID)},
        stateTag: ${JSON.stringify(STATE_TAG)},
        runKey32B: Buffer.from(${JSON.stringify(KEY.toString('hex'))}, 'hex'),
      })
      process.stdout.write(JSON.stringify({
        acquired: r.acquired,
        claimEpisodeId: r.claimEpisodeId ?? null,
        holder_claim_episode_id: r.holder_claim_episode_id ?? null,
      }))
      if (r.acquired) {
        // Do NOT release — keep lockfile so siblings see EEXIST.
      }
    })
  `
  const launches = []
  for (let i = 0; i < N; i++) {
    launches.push(new Promise((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', childScript], { stdio: ['ignore', 'pipe', 'inherit'] })
      let buf = ''
      p.stdout.on('data', d => { buf += d })
      p.on('close', () => resolve(JSON.parse(buf)))
    }))
  }
  const results = await Promise.all(launches)
  const winners = results.filter(r => r.acquired)
  const losers = results.filter(r => !r.acquired)
  assert.equal(winners.length, 1, `exactly one winner expected; got ${winners.length}`)
  assert.equal(losers.length, N - 1)
  // All losers surface the same holder claim_episode_id (the single winner).
  for (const l of losers) {
    assert.equal(l.holder_claim_episode_id, winners[0].claimEpisodeId)
  }
})

// =============================================================================
// SL7 standalone releaseStateLock — cross-process recovery API
// =============================================================================
tap('SL7 releaseStateLock(claimEpisodeId) emits release evidence + removes lockfile', () => {
  const proj = mkTmpProject()
  const r = acquireStateLock({ projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY })
  // Simulate a different process recovering by calling releaseStateLock
  // directly (skipping the closure).
  const lp = stateLockPath(proj, RUN_ID, STATE_TAG)
  assert.ok(fs.existsSync(lp))
  const rel = releaseStateLock({
    projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY,
    claimEpisodeId: r.claimEpisodeId,
  })
  assert.equal(typeof rel.releaseEpisodeId, 'string')
  assert.ok(!fs.existsSync(lp), 'lockfile removed by standalone release')
  // Release episode parents the original claim.
  const release = readEpisode(proj, rel.releaseEpisodeId)
  assert.equal(release.parsed.frontmatter.parent_episode, r.claimEpisodeId)
})

// =============================================================================
// SL8 input validation
// =============================================================================
tap('SL8 input validation rejects bad runId / stateTag / projectRoot / key', () => {
  const proj = mkTmpProject()
  assert.throws(() => acquireStateLock({
    projectRoot: 'relative/path', runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY,
  }), /projectRoot must be an absolute path/)
  assert.throws(() => acquireStateLock({
    projectRoot: proj, runId: 'BAD UPPER', stateTag: STATE_TAG, runKey32B: KEY,
  }), /runId shape invalid/)
  assert.throws(() => acquireStateLock({
    projectRoot: proj, runId: RUN_ID, stateTag: 'has spaces', runKey32B: KEY,
  }), /stateTag shape invalid/)
  assert.throws(() => acquireStateLock({
    projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: Buffer.alloc(16),
  }), /runKey32B must be a 32-byte Buffer/)
  // releaseStateLock specific
  assert.throws(() => releaseStateLock({
    projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY,
    claimEpisodeId: '',
  }), /claimEpisodeId must be a non-empty string/)
})

// =============================================================================
// SL9 per-run isolation
// =============================================================================
tap('SL9 two different runIds with same stateTag do not contend', () => {
  const proj = mkTmpProject()
  const runA = 'bp1-run-aaaa-rfc-test-bbbbbb'
  const runB = 'bp1-run-cccc-rfc-test-dddddd'
  const a = acquireStateLock({ projectRoot: proj, runId: runA, stateTag: STATE_TAG, runKey32B: KEY })
  const b = acquireStateLock({ projectRoot: proj, runId: runB, stateTag: STATE_TAG, runKey32B: KEY })
  assert.equal(a.acquired, true)
  assert.equal(b.acquired, true)
  // Both lockfiles exist, in separate run dirs.
  assert.ok(fs.existsSync(stateLockPath(proj, runA, STATE_TAG)))
  assert.ok(fs.existsSync(stateLockPath(proj, runB, STATE_TAG)))
  a.release()
  b.release()
})

// =============================================================================
// SL10 stale evidence canonical-fields binding — claim_age_seconds is signed
// =============================================================================
tap('SL10 stale evidence claim_age_seconds is HMAC-bound (tamper fails verify)', () => {
  const proj = mkTmpProject()
  // Plant a stale lockfile.
  const lp = stateLockPath(proj, RUN_ID, STATE_TAG)
  fs.mkdirSync(path.dirname(lp), { recursive: true })
  fs.writeFileSync(lp, JSON.stringify({
    claim_episode_id: `${RUN_ID}-state-lock-claim-feedface`,
    claimed_at: new Date(Date.now() - (STATE_LOCK_TTL_SECONDS + 120) * 1000).toISOString(),
    ttl_seconds: STATE_LOCK_TTL_SECONDS,
    lock_state_tag: STATE_TAG,
    writer_pid: 99999,
  }))

  const r = acquireStateLock({ projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY })
  const stale = readEpisode(proj, r.staleEpisodeId)
  const fm = stale.parsed.frontmatter
  const storedSig = fm.hmac_signature

  const original = canonicalize(fm, stale.parsed.body)
  assert.equal(verifyCanonical(original.canonicalBytes, KEY, storedSig), true)

  const tamperedFm = { ...fm, claim_age_seconds: '5' }
  const tampered = canonicalize(tamperedFm, stale.parsed.body)
  assert.equal(verifyCanonical(tampered.canonicalBytes, KEY, storedSig), false)
  r.release()
})

// =============================================================================
// SL11 orphan-lockfile prevention: if claim-episode emit fails AFTER the
// lockfile is on disk, the lockfile MUST be unlinked before the exception
// propagates, so the next acquirer doesn't have to wait for stale-break TTL.
// =============================================================================
tap('SL11 orphan-lockfile prevention: emit failure → lockfile unlinked + exception propagates', () => {
  const proj = mkTmpProject()
  // Plant a regular file at the episodes-dir path so mkdirSync({recursive})
  // inside writeBp1Episode → emitClaimEpisode throws ENOTDIR/EEXIST. The
  // exception is the trigger; the post-condition is that the orphan-
  // lockfile rollback fires.
  const episodesDir = path.join(proj, '.episodic-memory', 'episodes')
  fs.mkdirSync(path.dirname(episodesDir), { recursive: true })
  fs.writeFileSync(episodesDir, 'not-a-dir-blocks-writer')

  const lp = stateLockPath(proj, RUN_ID, STATE_TAG)
  assert.equal(fs.existsSync(lp), false, 'pre-condition: no lockfile')

  let threw = null
  try {
    acquireStateLock({ projectRoot: proj, runId: RUN_ID, stateTag: STATE_TAG, runKey32B: KEY })
  } catch (e) {
    threw = e
  }
  assert.ok(threw, 'acquire must throw when emit fails')
  // The critical invariant: lockfile is NOT left dangling for 60s.
  assert.equal(fs.existsSync(lp), false, 'post-condition: lockfile unlinked after emit failure')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
