/**
 * bp1-state-lock.mjs — state-transition lock primitive (RFC §1196-1212).
 *
 * Slice 2e C4 deliverable. **Forward-ready**: no callers in slice 2e itself.
 * Slice 2g (A1 retry-tree in `check-deadlines`) consumes
 * `acquireStateLock` + `releaseStateLock` when emitting new `codex_review`
 * entries so concurrent ticks cannot advance `attempt_number` twice on the
 * same run.
 *
 * # Authority root
 *
 *   <projectRoot>/.episodic-memory/runs/<runId>/state-locks/<stateTag>.lock
 *
 * The lockfile is atomically created via `link()` over a tmp file (EEXIST
 * = busy; never an overwrite). Its JSON content references the
 * `bp1-state-lock-claim` evidence episode id. The episode itself is signed
 * under the per-run HMAC key, so lockfile↔episode tampering is detectable
 * at replay time.
 *
 * # Distinct from sibling locks
 *
 * - `withLockedRun` (bp1-atomic.mjs:31) and `tryAcquireRunStateLock`
 *   (bp1-run-state.mjs, slice 2e C1) gate `runs/_index.json` mutations —
 *   one lockdir per project, blocking + non-blocking variants.
 * - `bp1-state-lock` (this file) gates `(run_id, state)` state-transition
 *   entry emission — one lockfile per (run, state) pair, with TTL stale-
 *   break + signed claim/release/stale evidence.
 *
 * # TTL semantics (RFC §1212)
 *
 * A claim older than `STATE_LOCK_TTL_SECONDS` with no matching release is
 * treated as crashed. `acquireStateLock` emits `bp1-state-lock-stale`
 * evidence (signed) and reclaims. Replay reconstructs the timeline from
 * claim → stale → claim → release sequences.
 *
 * # Idempotent release
 *
 * The closure returned from `acquireStateLock({ acquired: true }).release`
 * de-duplicates within-process; calling twice is a no-op after the first.
 * Cross-process recovery callers use the standalone `releaseStateLock`
 * with a known `claimEpisodeId`.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { writeBp1Episode } from './bp1-episode-writer.mjs'

// RFC §1198: 60 second TTL.
export const STATE_LOCK_TTL_SECONDS = 60

const RUN_ID_RE = /^[a-z0-9-]+$/
const STATE_TAG_RE = /^[a-z0-9_-]+$/

function stateLockDir(projectRoot, runId) {
  return path.join(projectRoot, '.episodic-memory', 'runs', runId, 'state-locks')
}

function stateLockPath(projectRoot, runId, stateTag) {
  return path.join(stateLockDir(projectRoot, runId), `${stateTag}.lock`)
}

function genEpisodeIdSuffix() {
  return crypto.randomBytes(2).toString('hex')
}

function claimEpisodeIdFor(runId) {
  return `${runId}-state-lock-claim-${genEpisodeIdSuffix()}`
}

function releaseEpisodeIdFor(runId) {
  return `${runId}-state-lock-release-${genEpisodeIdSuffix()}`
}

function staleEpisodeIdFor(runId) {
  return `${runId}-state-lock-stale-${genEpisodeIdSuffix()}`
}

function validateAcquireInputs(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('acquireStateLock: opts must be an object')
  }
  const { projectRoot, runId, stateTag, runKey32B } = opts
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('acquireStateLock: projectRoot must be an absolute path')
  }
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new TypeError(`acquireStateLock: runId shape invalid: ${JSON.stringify(runId)}`)
  }
  if (typeof stateTag !== 'string' || !STATE_TAG_RE.test(stateTag)) {
    throw new TypeError(`acquireStateLock: stateTag shape invalid: ${JSON.stringify(stateTag)}`)
  }
  if (!Buffer.isBuffer(runKey32B) || runKey32B.length !== 32) {
    throw new TypeError('acquireStateLock: runKey32B must be a 32-byte Buffer')
  }
}

function readLockfile(lockPath) {
  let raw
  try {
    raw = fs.readFileSync(lockPath, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(raw)
  } catch (_e) {
    return null
  }
}

function nowMsFromOpts(opts) {
  if (typeof opts.now === 'function') {
    const v = opts.now()
    return typeof v === 'number' ? v : v.getTime()
  }
  return Date.now()
}

function ageSecondsBetween(isoTimestamp, nowMs) {
  const t = Date.parse(isoTimestamp)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((nowMs - t) / 1000))
}

/**
 * Atomically publish the lockfile via tmp + linkSync. linkSync errors with
 * EEXIST if the target already exists — no overwrite is ever possible. The
 * tmp file is always unlinked (success or failure).
 *
 * @returns {boolean} true if this caller now owns the lockfile.
 */
function tryPublishLockfile(lockPath, content) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const tmpPath = `${lockPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  const fd = fs.openSync(tmpPath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(content))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(tmpPath, lockPath)
    fs.unlinkSync(tmpPath)
    return true
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch (_e2) { /* best-effort */ }
    if (e.code === 'EEXIST') return false
    throw e
  }
}

// C7 round-3 P1.1: stale-break sentinel suffix. Two concurrent stale-breakers
// must serialize via O_EXCL link on `<lockPath>.breaking` so that:
//   1. Only one stale-breaker can run its compare-and-unlink at a time.
//   2. The re-read + unlink sequence is protected from another stale-breaker
//      racing to unlink + a fresh writer racing to publish in between.
// Acquirers don't take this sentinel; their O_EXCL `lockPath` link naturally
// fails while the stale lock still exists (i.e. until the breaker unlinks it).
const STALE_BREAK_SENTINEL_SUFFIX = '.breaking'

/**
 * Attempt to take the stale-break sentinel via O_EXCL link. Returns true if
 * acquired; false if another stale-breaker already holds it. Caller MUST call
 * releaseStaleBreakSentinel in a finally if true was returned.
 */
function tryAcquireStaleBreakSentinel(lockPath) {
  const breakingPath = lockPath + STALE_BREAK_SENTINEL_SUFFIX
  const tmp = `${breakingPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(tmp, breakingPath)
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  } finally {
    try { fs.unlinkSync(tmp) } catch (_e) { /* best-effort */ }
  }
}

function releaseStaleBreakSentinel(lockPath) {
  try { fs.unlinkSync(lockPath + STALE_BREAK_SENTINEL_SUFFIX) } catch (_e) { /* benign */ }
}

/**
 * Emit a signed bp1-state-lock-stale evidence episode for an observed
 * stale claim, then remove the lockfile. Caller is expected to retry
 * lockfile creation once after this.
 *
 * Returns null if another stale-breaker is concurrently active (the
 * sentinel is held). The caller treats that case as "still busy"; the
 * other breaker will perform the unlink + emit on its own behalf.
 */
function emitStaleAndUnlink({
  projectRoot, runId, runKey32B, stateTag, lockPath, existingClaim, ageSeconds,
}) {
  // C7 round-3 P1.1: serialize stale-breakers via sentinel file. Without
  // this, two breakers can both see the same stale state, both decide to
  // unlink, and the second unlink can target a fresh acquirer's lockfile
  // that arrived between the first breaker's unlink and the second's
  // unlinkSync call.
  if (!tryAcquireStaleBreakSentinel(lockPath)) {
    return null
  }

  try {
    const episodeId = staleEpisodeIdFor(runId)
    // Re-read main lockfile UNDER sentinel protection before emitting
    // evidence. If the lockfile's (claim_episode_id, claimed_at) tuple no
    // longer matches what we observed as stale, another acquirer has
    // already published a fresh lock — bail without emitting OR unlinking.
    let currentMatchesStale = false
    try {
      const currentRaw = fs.readFileSync(lockPath, 'utf8')
      const current = JSON.parse(currentRaw)
      currentMatchesStale = (
        current.claim_episode_id === existingClaim?.claim_episode_id &&
        current.claimed_at === existingClaim?.claimed_at
      )
    } catch (_e) {
      // Lockfile already gone (another breaker raced + finished). Treat
      // as already-broken: no evidence to emit, no unlink to do.
      currentMatchesStale = false
    }
    if (!currentMatchesStale) {
      return null
    }

    writeBp1Episode({
      projectRoot,
      runId,
      runKey32B,
      type: 'evidence',
      state: null,
      summary: `state-lock stale-break ${stateTag} (age ${ageSeconds}s)`,
      parentEpisode: existingClaim?.claim_episode_id ?? null,
      expectedPostEpisodeId: null,
      customFm: {
        lock_state_tag: stateTag,
        claim_age_seconds: String(ageSeconds),
      },
      tags: ['bp1-state-lock-stale'],
      body:
        `Stale state-lock broken on (${runId}, ${stateTag}).\n` +
        `Observed age: ${ageSeconds}s; TTL: ${STATE_LOCK_TTL_SECONDS}s.\n` +
        `Prior claim: ${existingClaim?.claim_episode_id ?? 'unknown'}.\n`,
      filenameSuffix: 'state-lock-stale',
      episodeId,
    })

    // Under the sentinel, unlink the main lock. Concurrent acquirers cannot
    // publish a fresh lock at lockPath until the stale lock is removed —
    // their O_EXCL link fails until we unlink. Once we unlink + release the
    // sentinel, the next acquirer's link succeeds atomically.
    try {
      fs.unlinkSync(lockPath)
    } catch (_e) {
      // Vanished between re-read and unlink (extremely narrow window —
      // would require external process unlinking from outside the lock
      // protocol). Benign.
    }
    return episodeId
  } finally {
    releaseStaleBreakSentinel(lockPath)
  }
}

/**
 * Emit a signed bp1-state-lock-claim evidence episode after a successful
 * lockfile publish.
 *
 * @returns {string} claim episode path (absolute).
 */
function emitClaimEpisode({
  projectRoot, runId, runKey32B, stateTag, claimEpisodeId,
}) {
  const res = writeBp1Episode({
    projectRoot,
    runId,
    runKey32B,
    type: 'evidence',
    state: null,
    summary: `state-lock claim ${stateTag}`,
    parentEpisode: null,
    expectedPostEpisodeId: null,
    customFm: {
      lock_state_tag: stateTag,
      lock_ttl_seconds: String(STATE_LOCK_TTL_SECONDS),
    },
    tags: ['bp1-state-lock-claim'],
    body:
      `Claim of state-lock on (${runId}, ${stateTag}).\n` +
      `TTL: ${STATE_LOCK_TTL_SECONDS}s.\n`,
    filenameSuffix: 'state-lock-claim',
    episodeId: claimEpisodeId,
  })
  return res.episodePath
}

/**
 * Emit a signed bp1-state-lock-release evidence episode. Linked to the
 * claim episode via parent_episode.
 *
 * @returns {string} release episode id.
 */
function emitReleaseEpisode({
  projectRoot, runId, runKey32B, stateTag, claimEpisodeId,
}) {
  const episodeId = releaseEpisodeIdFor(runId)
  writeBp1Episode({
    projectRoot,
    runId,
    runKey32B,
    type: 'evidence',
    state: null,
    summary: `state-lock release ${stateTag}`,
    parentEpisode: claimEpisodeId,
    expectedPostEpisodeId: null,
    customFm: {
      lock_state_tag: stateTag,
    },
    tags: ['bp1-state-lock-release'],
    body:
      `Release of state-lock on (${runId}, ${stateTag}).\n` +
      `Claim episode: ${claimEpisodeId}.\n`,
    filenameSuffix: 'state-lock-release',
    episodeId,
  })
  return episodeId
}

/**
 * Attempt to acquire bp1-state-lock for (runId, stateTag).
 *
 * @param {{
 *   projectRoot: string,
 *   runId: string,
 *   stateTag: string,
 *   runKey32B: Buffer,
 *   now?: () => number|Date,
 * }} opts
 *
 * @returns {{ acquired: true, claimEpisodeId: string, claimEpisodePath: string,
 *             staleEpisodeId: string|null,
 *             release: () => { releaseEpisodeId: string|null, alreadyReleased?: boolean } }
 *          | { acquired: false, holder_claim_episode_id: string|null,
 *              holder_age_seconds: number|null }}
 */
export function acquireStateLock(opts) {
  validateAcquireInputs(opts)
  const { projectRoot, runId, stateTag, runKey32B } = opts
  const nowMs = nowMsFromOpts(opts)
  const lockPath = stateLockPath(projectRoot, runId, stateTag)

  // Pre-generate the claim episode_id so the lockfile content can
  // reference it atomically (lockfile-gates-episode protocol).
  let claimEpisodeId = claimEpisodeIdFor(runId)
  const buildClaimContent = () => ({
    claim_episode_id: claimEpisodeId,
    claimed_at: new Date(nowMs).toISOString(),
    ttl_seconds: STATE_LOCK_TTL_SECONDS,
    lock_state_tag: stateTag,
    writer_pid: process.pid,
  })

  let created = tryPublishLockfile(lockPath, buildClaimContent())
  let staleEpisodeId = null

  if (!created) {
    const existing = readLockfile(lockPath)
    const age = existing?.claimed_at != null
      ? ageSecondsBetween(existing.claimed_at, nowMs)
      : null
    if (age != null && age >= STATE_LOCK_TTL_SECONDS) {
      staleEpisodeId = emitStaleAndUnlink({
        projectRoot, runId, runKey32B, stateTag,
        lockPath, existingClaim: existing, ageSeconds: age,
      })
      // Fresh ID for the post-stale claim so replay can distinguish
      // pre-stale from post-stale claims (both signed under same key).
      claimEpisodeId = claimEpisodeIdFor(runId)
      created = tryPublishLockfile(lockPath, buildClaimContent())
    }
  }

  if (!created) {
    const existing = readLockfile(lockPath) || {}
    const age = existing.claimed_at != null
      ? ageSecondsBetween(existing.claimed_at, nowMs)
      : null
    return {
      acquired: false,
      holder_claim_episode_id: existing.claim_episode_id ?? null,
      holder_age_seconds: age,
    }
  }

  // Orphan-lockfile prevention: if claim-episode emit fails AFTER the
  // lockfile is on disk, the lock would block all acquirers for 60s
  // (until stale-break). Roll back the lockfile so retry is immediate.
  let claimEpisodePath
  try {
    claimEpisodePath = emitClaimEpisode({
      projectRoot, runId, runKey32B, stateTag, claimEpisodeId,
    })
  } catch (e) {
    try { fs.unlinkSync(lockPath) } catch (_e) {}
    throw e
  }

  let released = false
  const release = () => {
    if (released) return { releaseEpisodeId: null, alreadyReleased: true }
    released = true
    const releaseEpisodeId = emitReleaseEpisode({
      projectRoot, runId, runKey32B, stateTag, claimEpisodeId,
    })
    try {
      fs.unlinkSync(lockPath)
    } catch (_e) {
      // Lockfile may already be gone (concurrent stale-break by another
      // process); benign — the release episode is still authoritative.
    }
    return { releaseEpisodeId }
  }

  return {
    acquired: true,
    claimEpisodeId,
    claimEpisodePath,
    staleEpisodeId,
    release,
  }
}

/**
 * Standalone release for cross-process recovery. Emits release evidence
 * and removes the lockfile (if still present). Caller supplies the
 * `claimEpisodeId` recovered from the lockfile content.
 *
 * Idempotent at the episode level: each call emits a release episode.
 * Cross-process callers are expected to call this at most once per
 * recovery cycle; double-release leaves two release episodes for the
 * same claim, which replay tolerates (terminal release is the latest).
 */
export function releaseStateLock(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('releaseStateLock: opts must be an object')
  }
  const { projectRoot, runId, stateTag, runKey32B, claimEpisodeId } = opts
  validateAcquireInputs({ projectRoot, runId, stateTag, runKey32B })
  if (typeof claimEpisodeId !== 'string' || claimEpisodeId === '') {
    throw new TypeError('releaseStateLock: claimEpisodeId must be a non-empty string')
  }
  const releaseEpisodeId = emitReleaseEpisode({
    projectRoot, runId, runKey32B, stateTag, claimEpisodeId,
  })
  const lockPath = stateLockPath(projectRoot, runId, stateTag)
  try {
    fs.unlinkSync(lockPath)
  } catch (_e) {
    // Benign — release evidence is still authoritative.
  }
  return { releaseEpisodeId }
}

// Path helpers — exported for cross-process discovery + tests.
export { stateLockPath, stateLockDir }
