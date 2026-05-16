/**
 * bp1-atomic.mjs — Shared primitives for multi-step write atomicity in
 * BP-1 orchestrator subcommands.
 *
 * Closes the architectural cluster #286/#287/#288 (multi-step write
 * sequence with no atomic rollback). Codex-consensus ACCEPT round 5,
 * episode 20260516-102831-reply-codex-to-20260516-102614-plan-v5-r-b657.
 *
 * ## Primitives
 *
 *   findSignedStateEpisode(projectRoot, runId, state, runKey32B, expectedFields?)
 *     → { status: 'match', episodeId, episodePath, frontmatter }
 *     | { status: 'none' }
 *     | { status: 'field-mismatch', candidates: Array<{episodeId, episodePath, frontmatter}> }
 *     | throws { code: 'multiple-signed-match' }
 *
 *     Scans `<projectRoot>/.episodic-memory/episodes/*.md`. Parses
 *     frontmatter, filters by run_id + state, verifies HMAC + identity
 *     (id-from-frontmatter must match filename, rename-attack defense).
 *     If `expectedFields`, additionally filters surviving candidates by
 *     `frontmatter[k] === v` for each k,v in expectedFields.
 *
 *     `none` means no signed orphan exists. `field-mismatch` means signed
 *     orphan(s) exist but canonical fields differ — caller must treat as
 *     `recoverable-canonical-drift`, NEVER fresh-emit. `match` is single
 *     surviving candidate. `multiple-signed-match` throws because writes
 *     are supposed to be unique per (run_id, state) and two valid
 *     signed copies are an integrity-class anomaly, not a callable
 *     recovery case.
 *
 *   withLockedRun(projectRoot, runId, fn)
 *     Sync wrapper around withRunStateLockExclusive. Inside the lock:
 *       1. idx = loadIndexLocked(projectRoot)
 *       2. run = idx.runs[runId]   (may be undefined)
 *       3. result = fn({ idx, run })
 *       4. writeIndex(projectRoot, idx)
 *       5. return result
 *     On fn throw: NO writeIndex call; rethrow.
 *
 *     CRITICAL: fn MUST NOT call updateRunState / appendRun / markTerminal
 *     from inside — those acquire the lock and deadlock. fn mutates the
 *     idx object in place; primitive writes after fn returns.
 *
 *   removeRunFromIndex(idx, runId)
 *     Pure in-memory `delete idx.runs[runId]`. Caller is responsible for
 *     writing idx via writeIndex.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'

import { parseBp1Frontmatter } from './bp1-frontmatter.mjs'
import { canonicalize } from './bp1-canonicalize.mjs'
import { verifyCanonical } from './bp1-hmac.mjs'
import {
  withRunStateLockExclusive,
  loadIndexLocked,
  writeIndex,
} from './bp1-run-state.mjs'

const ID_RE = /^[a-z0-9-]+$/
const FILENAME_RE = /^([a-z0-9-]+)\.md$/

// ---------------------------------------------------------------------------
// findSignedStateEpisode
// ---------------------------------------------------------------------------

/**
 * @param {string} projectRoot — absolute path
 * @param {string} runId — `^[a-z0-9-]+$`
 * @param {string} state — non-empty; one of VALID_V2_STATES
 * @param {Buffer} runKey32B — 32-byte HMAC key
 * @param {Record<string,string>} [expectedFields] — optional predicate map
 * @returns {{status:'match',episodeId:string,episodePath:string,frontmatter:object}
 *          | {status:'none'}
 *          | {status:'field-mismatch',candidates:Array<{episodeId:string,episodePath:string,frontmatter:object}>}}
 * @throws {Error & {code:'multiple-signed-match'}} when >1 candidate satisfies all predicates
 */
export function findSignedStateEpisode(projectRoot, runId, state, runKey32B, expectedFields) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('findSignedStateEpisode: projectRoot must be an absolute path string')
  }
  if (typeof runId !== 'string' || !ID_RE.test(runId)) {
    throw new TypeError(`findSignedStateEpisode: runId shape invalid: ${JSON.stringify(runId)}`)
  }
  if (typeof state !== 'string' || state === '') {
    throw new TypeError('findSignedStateEpisode: state must be a non-empty string')
  }
  if (!Buffer.isBuffer(runKey32B) || runKey32B.length !== 32) {
    throw new TypeError('findSignedStateEpisode: runKey32B must be a 32-byte Buffer')
  }
  if (expectedFields != null && (typeof expectedFields !== 'object' || Array.isArray(expectedFields))) {
    throw new TypeError('findSignedStateEpisode: expectedFields must be an object or omitted')
  }

  const episodesDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  let entries
  try {
    entries = fs.readdirSync(episodesDir)
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'none' }
    throw e
  }

  const allCandidates = []
  for (const name of entries) {
    const m = FILENAME_RE.exec(name)
    if (!m) continue
    const episodeId = m[1]
    const episodePath = path.join(episodesDir, name)
    let buf
    try {
      buf = fs.readFileSync(episodePath)
    } catch (_e) {
      // File vanished between readdir and read (e.g. concurrent sweep). Skip.
      continue
    }
    let parsed
    try {
      parsed = parseBp1Frontmatter(buf)
    } catch (_e) {
      // Malformed frontmatter — defensive skip. Validators are the loud-fail
      // path for corruption; this primitive must not throw on unrelated drift.
      continue
    }
    const fm = parsed.frontmatter
    // Pre-filter cheap shape checks before HMAC verify.
    if (fm.run_id !== runId) continue
    if (fm.state !== state) continue
    // Identity check: fm.id must match the filename stem (rename-attack defense
    // mirroring verifyEpisodeOnDisk in bp1-episode-verify.mjs).
    if (fm.id !== episodeId) continue
    const storedSig = fm.hmac_signature
    if (typeof storedSig !== 'string' || storedSig === '') continue
    // HMAC verification: re-canonicalize from on-disk frontmatter + body, then
    // verifyCanonical. canonicalize never throws on a well-formed BP-1 fm; the
    // try wraps any unexpected internal error and treats it as not-a-candidate.
    let canonicalBytes
    try {
      ;({ canonicalBytes } = canonicalize(fm, parsed.body))
    } catch (_e) {
      continue
    }
    if (!verifyCanonical(canonicalBytes, runKey32B, storedSig)) continue
    allCandidates.push({ episodeId, episodePath, frontmatter: fm })
  }

  if (allCandidates.length === 0) {
    return { status: 'none' }
  }

  // No predicates: a single signed match wins; multiple signed matches at
  // the same (run_id, state) is an integrity anomaly.
  if (expectedFields == null) {
    if (allCandidates.length === 1) {
      return { status: 'match', ...allCandidates[0] }
    }
    const err = new Error(
      `findSignedStateEpisode: multiple-signed-match (${allCandidates.length}) for ` +
      `run_id=${runId} state=${state}`,
    )
    err.code = 'multiple-signed-match'
    err.candidates = allCandidates
    throw err
  }

  // Filter by predicates.
  const filtered = []
  for (const c of allCandidates) {
    let ok = true
    for (const k of Object.keys(expectedFields)) {
      if (c.frontmatter[k] !== expectedFields[k]) {
        ok = false
        break
      }
    }
    if (ok) filtered.push(c)
  }

  if (filtered.length === 0) {
    return { status: 'field-mismatch', candidates: allCandidates }
  }
  if (filtered.length === 1) {
    return { status: 'match', ...filtered[0] }
  }
  const err = new Error(
    `findSignedStateEpisode: multiple-signed-match (${filtered.length}) for ` +
    `run_id=${runId} state=${state} satisfying all predicates`,
  )
  err.code = 'multiple-signed-match'
  err.candidates = filtered
  throw err
}

// ---------------------------------------------------------------------------
// withLockedRun
// ---------------------------------------------------------------------------

/**
 * Sync wrapper around withRunStateLockExclusive that loads the locked index,
 * passes `{idx, run}` to fn, and writes the index after fn returns normally.
 *
 * fn must mutate idx in place. fn MUST NOT call updateRunState / appendRun /
 * markTerminal from inside (those acquire the lock and self-deadlock).
 *
 * @template T
 * @param {string} projectRoot
 * @param {string} runId
 * @param {(ctx: {idx: object, run: object|undefined}) => T} fn
 * @returns {T}
 */
export function withLockedRun(projectRoot, runId, fn) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('withLockedRun: projectRoot must be an absolute path string')
  }
  if (typeof runId !== 'string' || !ID_RE.test(runId)) {
    throw new TypeError(`withLockedRun: runId shape invalid: ${JSON.stringify(runId)}`)
  }
  if (typeof fn !== 'function') {
    throw new TypeError('withLockedRun: fn must be a function')
  }
  return withRunStateLockExclusive(projectRoot, () => {
    const idx = loadIndexLocked(projectRoot)
    const run = idx.runs[runId]
    const result = fn({ idx, run })
    writeIndex(projectRoot, idx)
    return result
  })
}

// ---------------------------------------------------------------------------
// removeRunFromIndex
// ---------------------------------------------------------------------------

/**
 * Pure in-memory delete. Caller writes via writeIndex.
 *
 * @param {object} idx — v2 index object (must have `.runs`)
 * @param {string} runId
 */
export function removeRunFromIndex(idx, runId) {
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) {
    throw new TypeError('removeRunFromIndex: idx must be an object')
  }
  if (typeof runId !== 'string') {
    throw new TypeError('removeRunFromIndex: runId must be a string')
  }
  if (idx.runs && typeof idx.runs === 'object' && Object.prototype.hasOwnProperty.call(idx.runs, runId)) {
    delete idx.runs[runId]
  }
}
