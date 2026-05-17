/**
 * bp1-request-claim.mjs — per-entry request-in-flight O_EXCL claim
 *   (RFC §1214-1259).
 *
 * Slice 2e C4 deliverable. **Forward-ready**: no callers in slice 2e.
 * Slice 2g (A1 retry-tree) creates one claim per codex_review entry that
 * is about to side-effect (issue em-review-request). The claim is created
 * INSIDE the bp1-state-lock and BEFORE lock release on every issuing
 * branch — recovery, advance, and naked-entry sweep — so the post-lock
 * "issue request → write evidence" window cannot duplicate side effects.
 *
 * # Authority root
 *
 *   <projectRoot>/.episodic-memory/runs/<runId>/request-claims/<entry_id>.claim
 *
 * Created via tmp + linkSync (O_EXCL semantics — EEXIST on collision,
 * never overwrite). One claim per entry_id. RFC §1220-1229 schema:
 *
 *   {
 *     "claim_id": "<random hex>",
 *     "parent_episode_id": "<entry_id>",
 *     "attempt_number": <N>,
 *     "claimed_at": "<ISO-8601>",
 *     "ttl_seconds": 60,
 *     "writer_run_id": "<run_id>"
 *   }
 *
 * # Idempotency key (RFC §1234-1242)
 *
 *   idempotency_key = sha256(run_id || parent_episode_id || attempt_number)
 *
 * Used by future em-review-request BP1 mode to de-duplicate at the
 * request side. Exported here for slice 2g + ISSUE-A em-review-request
 * extension consumers.
 *
 * # Stale recovery DEFERRED to slice 2f
 *
 * RFC §1250-1259 specifies stale-clear semantics (claim file + TTL
 * elapsed + no matching bp1-codex-request-sent evidence → emit
 * bp1-claim-stale + clear claim + retry). That recovery path runs from
 * the naked-entry sweep (Path B), which is slice 2f's concern. This lib
 * exposes the age-derivation helper so slice 2f can call it, but does
 * NOT itself emit stale evidence or clear claim files.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// RFC §1227: claim TTL is 60s, matching state-lock TTL.
export const REQUEST_CLAIM_TTL_SECONDS = 60

const RUN_ID_RE = /^[a-z0-9-]+$/
const EPISODE_ID_RE = /^[a-z0-9-]+$/

export function claimDir(projectRoot, runId) {
  return path.join(projectRoot, '.episodic-memory', 'runs', runId, 'request-claims')
}

export function claimPath(projectRoot, runId, entryId) {
  return path.join(claimDir(projectRoot, runId), `${entryId}.claim`)
}

function validateCommon({ projectRoot, runId, entryId }) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('tryCreateClaim: projectRoot must be an absolute path')
  }
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new TypeError(`tryCreateClaim: runId shape invalid: ${JSON.stringify(runId)}`)
  }
  if (typeof entryId !== 'string' || !EPISODE_ID_RE.test(entryId)) {
    throw new TypeError(`tryCreateClaim: entryId shape invalid: ${JSON.stringify(entryId)}`)
  }
}

/**
 * Compute the local idempotency key for a (run_id, entry_id, attempt_number)
 * triple. RFC §1234-1242 — used by em-review-request BP1 mode
 * (ISSUE-A) to no-op on duplicate invocations with the same key.
 *
 * @param {string} runId
 * @param {string} entryId — the codex_review entry episode id
 * @param {number|string} attemptNumber
 * @returns {string} 64-hex sha256 digest
 */
export function idempotencyKey(runId, entryId, attemptNumber) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new TypeError(`idempotencyKey: runId shape invalid: ${JSON.stringify(runId)}`)
  }
  if (typeof entryId !== 'string' || !EPISODE_ID_RE.test(entryId)) {
    throw new TypeError(`idempotencyKey: entryId shape invalid: ${JSON.stringify(entryId)}`)
  }
  const n = Number(attemptNumber)
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`idempotencyKey: attemptNumber must be a non-negative integer; got ${JSON.stringify(attemptNumber)}`)
  }
  return crypto.createHash('sha256')
    .update(`${runId}||${entryId}||${n}`, 'utf8')
    .digest('hex')
}

/**
 * Atomically create a per-entry request-claim file. RFC §1218 O_EXCL
 * semantics: first writer wins; subsequent callers observe
 * `{ created: false, existing_claim }`.
 *
 * @param {{
 *   projectRoot: string,
 *   runId: string,            // writer_run_id field
 *   entryId: string,          // codex_review entry episode id — file basename + parent_episode_id field
 *   attemptNumber: number,
 *   ttlSeconds?: number,      // defaults to REQUEST_CLAIM_TTL_SECONDS
 *   now?: () => number|Date,
 * }} opts
 * @returns {{ created: true, claim: object, claimPath: string }
 *          | { created: false, existing_claim: object|null, claimPath: string }}
 */
export function tryCreateClaim(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('tryCreateClaim: opts must be an object')
  }
  const { projectRoot, runId, entryId, attemptNumber } = opts
  validateCommon({ projectRoot, runId, entryId })
  if (!Number.isInteger(attemptNumber) || attemptNumber < 0) {
    throw new TypeError(`tryCreateClaim: attemptNumber must be a non-negative integer; got ${JSON.stringify(attemptNumber)}`)
  }
  const ttlSeconds = opts.ttlSeconds == null ? REQUEST_CLAIM_TTL_SECONDS : opts.ttlSeconds
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('tryCreateClaim: ttlSeconds must be a positive integer')
  }
  const nowMs = typeof opts.now === 'function'
    ? (typeof opts.now() === 'number' ? opts.now() : opts.now().getTime())
    : Date.now()

  const cp = claimPath(projectRoot, runId, entryId)
  fs.mkdirSync(path.dirname(cp), { recursive: true })

  const claim = {
    claim_id: crypto.randomBytes(16).toString('hex'),
    parent_episode_id: entryId,
    attempt_number: attemptNumber,
    claimed_at: new Date(nowMs).toISOString(),
    ttl_seconds: ttlSeconds,
    writer_run_id: runId,
  }

  const tmpPath = `${cp}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  const fd = fs.openSync(tmpPath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(claim))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(tmpPath, cp)
    fs.unlinkSync(tmpPath)
    return { created: true, claim, claimPath: cp }
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch (_e2) { /* best-effort */ }
    if (e.code !== 'EEXIST') throw e
    return {
      created: false,
      existing_claim: readClaim({ projectRoot, runId, entryId }),
      claimPath: cp,
    }
  }
}

/**
 * Read an existing claim file. Returns null on ENOENT or malformed JSON.
 */
export function readClaim({ projectRoot, runId, entryId }) {
  validateCommon({ projectRoot, runId, entryId })
  const cp = claimPath(projectRoot, runId, entryId)
  let raw
  try {
    raw = fs.readFileSync(cp, 'utf8')
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

/**
 * Derive observed age in seconds for a claim. Pure helper — does NOT
 * mutate state. Slice 2f's naked-entry sweep consumes this to decide
 * whether to emit bp1-claim-stale evidence + clear the claim file.
 *
 * @param {object} claim — output of readClaim() / tryCreateClaim().claim
 * @param {number} [nowMs]
 * @returns {number|null} age in whole seconds, or null on unparseable claim
 */
export function claimAgeSeconds(claim, nowMs) {
  if (!claim || typeof claim !== 'object') return null
  const t = Date.parse(claim.claimed_at)
  if (Number.isNaN(t)) return null
  const now = nowMs ?? Date.now()
  return Math.max(0, Math.floor((now - t) / 1000))
}
