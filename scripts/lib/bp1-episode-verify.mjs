/**
 * bp1-episode-verify.mjs — Parent-episode HMAC verification (slice 2c CR2-2).
 *
 * The state-machine dispatch site (orchestrator subcommands
 * record-classifier-dispatch-pre, record-classification) signs CHILD episodes
 * whose `parent_episode` field points at a previously-signed parent. Without
 * this lib, an adversary with write access to `.episodic-memory/episodes/`
 * can tamper the parent post-emit and the child still gets signed on the
 * tampered parent — replay catches the divergence later, but emission-time
 * the chain is forge-able.
 *
 * verifyEpisodeOnDisk re-reads the parent from disk, re-canonicalizes its
 * frontmatter + body, recomputes HMAC with the run.key, and compares to the
 * stored hmac_signature. It also asserts that type/state/run_id match the
 * caller's expectation (an attacker who swaps a different parent file with
 * a valid signature still fails because the wrong type/state shows up).
 *
 * ## API
 *
 *   verifyEpisodeOnDisk({
 *     projectRoot,        // absolute path string
 *     episodeId,          // the parent episode-id to verify
 *     runKey32B,          // 32-byte Buffer (the run's HMAC key)
 *     expectedType,       // 'state-transition' | 'failure' | 'evidence'
 *     expectedState,      // for state-transition: state value; null for non-state-transition
 *     expectedRunId,      // the run_id the parent must belong to
 *   }) → { ok: true } | { ok: false, errors: string[] }
 *
 * The function does NOT throw on parser failures or missing files; it returns
 * a structured `{ok: false, errors}` so callers can route a single decision
 * (refuse + emit `bp1-classifier-parent-tamper` failure episode) on any check
 * miss.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'

import { parseBp1Frontmatter } from './bp1-frontmatter.mjs'
import { canonicalize } from './bp1-canonicalize.mjs'
import { verifyCanonical } from './bp1-hmac.mjs'

const EPISODE_ID_RE = /^[a-z0-9-]+$/

/**
 * Verify a parent episode on disk matches caller expectations + has a valid
 * HMAC signature for the supplied run.key.
 *
 * @param {object} opts
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function verifyEpisodeOnDisk(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, errors: ['verifyEpisodeOnDisk: opts must be an object'] }
  }
  const { projectRoot, episodeId, runKey32B, expectedType, expectedState, expectedRunId } = opts
  const errors = []

  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    errors.push(`projectRoot must be an absolute path string; got ${typeof projectRoot}`)
  }
  if (typeof episodeId !== 'string' || !EPISODE_ID_RE.test(episodeId)) {
    errors.push(`episodeId shape invalid: ${JSON.stringify(episodeId)}`)
  }
  if (!Buffer.isBuffer(runKey32B) || runKey32B.length !== 32) {
    errors.push('runKey32B must be a 32-byte Buffer')
  }
  if (typeof expectedType !== 'string' || expectedType === '') {
    errors.push('expectedType must be a non-empty string')
  }
  if (expectedState != null && typeof expectedState !== 'string') {
    errors.push('expectedState must be a string or null')
  }
  if (typeof expectedRunId !== 'string' || expectedRunId === '') {
    errors.push('expectedRunId must be a non-empty string')
  }
  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const episodePath = path.join(projectRoot, '.episodic-memory', 'episodes', `${episodeId}.md`)
  let buf
  try {
    buf = fs.readFileSync(episodePath)
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, errors: [`parent-missing: ${episodePath}`] }
    }
    return { ok: false, errors: [`parent-unreadable: ${e.message}`] }
  }

  let parsed
  try {
    parsed = parseBp1Frontmatter(buf)
  } catch (e) {
    return { ok: false, errors: [`parent-parse-failed: ${e.message}`] }
  }

  const fm = parsed.frontmatter

  // Identity check first — id stored in frontmatter must match episodeId arg
  // (defense vs an attacker who renames a file to a different episode-id).
  if (fm.id !== episodeId) {
    errors.push(`parent-id-mismatch: stored=${JSON.stringify(fm.id)} expected=${JSON.stringify(episodeId)}`)
  }
  if (fm.type !== expectedType) {
    errors.push(`parent-type-mismatch: stored=${JSON.stringify(fm.type)} expected=${JSON.stringify(expectedType)}`)
  }
  // For non-state-transition types (failure, evidence), state may be undefined
  // or differ — only assert state for state-transition.
  if (expectedState != null) {
    if (fm.state !== expectedState) {
      errors.push(`parent-state-mismatch: stored=${JSON.stringify(fm.state)} expected=${JSON.stringify(expectedState)}`)
    }
  }
  if (fm.run_id !== expectedRunId) {
    errors.push(`parent-run-id-mismatch: stored=${JSON.stringify(fm.run_id)} expected=${JSON.stringify(expectedRunId)}`)
  }

  // HMAC verification — re-canonicalize from disk + verify against runKey.
  // verifyCanonical never throws on attacker-controlled hmac string.
  const storedSig = fm.hmac_signature
  if (typeof storedSig !== 'string' || storedSig === '') {
    errors.push('parent-missing-hmac-signature')
  } else {
    let canonicalBytes
    try {
      ;({ canonicalBytes } = canonicalize(fm, parsed.body))
    } catch (e) {
      errors.push(`parent-canonicalize-failed: ${e.message}`)
    }
    if (canonicalBytes && !verifyCanonical(canonicalBytes, runKey32B, storedSig)) {
      errors.push('parent-hmac-invalid')
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true }
}
