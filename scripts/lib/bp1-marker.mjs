/**
 * bp1-marker.mjs — Approval-marker write/cleanup helpers (RFC-004 §580-patch,
 * slice 2d-W).
 *
 * Marker contract (RFC §580-patch):
 *   Path: <canonical_project_root>/.checkpoints/bp1-approval-<run_id>.json
 *   Per-run_id filename eliminates concurrent-marker ambiguity (codex r1 B3).
 *
 * Payload (JSON):
 *   {
 *     run_id,
 *     created_at,         ISO-8601 UTC (== run-state awaiting_approval_at)
 *     decided_class,      one of trivial|schema|validator|security|multi-actor
 *     deadline_at,        ISO-8601 UTC (== run-state deadline_at; deterministic)
 *     body_sha256,        64-hex over canonicalized {run_id, created_at,
 *                          decided_class, deadline_at}
 *     hmac                64-hex HMAC-SHA256 over the same canonical bytes,
 *                         signed by the per-run HMAC key
 *   }
 *
 * Determinism (codex r1 M1):
 *   Phase B retries after a crash MUST produce byte-identical markers.
 *   `created_at` + `deadline_at` come from persisted run-state, never wall-clock.
 *   `body_sha256` and `hmac` are pure functions of (canonical bytes, runKey).
 *
 * Ownership split (codex r2 FU1):
 *   This module ONLY:
 *     - canonicalizes payload bytes
 *     - writes/unlinks marker files atomically (tmp + fsync + rename / unlink)
 *     - returns status objects ({ status: 'ok' | 'error', code? })
 *   It does NOT emit evidence episodes. The caller (record-awaiting-approval
 *   for write-failures while run.key is live; finalize-* for cleanup-failures
 *   after key shred) owns evidence emission via `bp1-episode-writer.mjs`.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { signCanonical } from './bp1-hmac.mjs'

const RUN_ID_RE = /^[a-z0-9-]+$/
const VALID_DECIDED_CLASSES = Object.freeze([
  'trivial', 'schema', 'validator', 'security', 'multi-actor', 'needs-human-input',
])

// ---------------------------------------------------------------------------
// markerPath — pure path helper
// ---------------------------------------------------------------------------

/**
 * @param {string} canonicalProjectRoot — absolute path
 * @param {string} runId — shape-validated (RUN_ID_RE)
 * @returns {string}
 */
export function markerPath(canonicalProjectRoot, runId) {
  if (typeof canonicalProjectRoot !== 'string' || !path.isAbsolute(canonicalProjectRoot)) {
    throw new TypeError(`markerPath: canonicalProjectRoot must be absolute; got ${canonicalProjectRoot}`)
  }
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new TypeError(`markerPath: runId shape invalid: ${JSON.stringify(runId)}`)
  }
  return path.join(canonicalProjectRoot, '.checkpoints', `bp1-approval-${runId}.json`)
}

// ---------------------------------------------------------------------------
// canonicalizeMarkerPayload — pure canonicalization
// ---------------------------------------------------------------------------

/**
 * Project { run_id, created_at, decided_class, deadline_at } to canonical
 * bytes for HMAC + body_sha256 derivation. Sorted keys, JSON.stringify with
 * no spaces, utf8-encoded.
 *
 * Note: the returned bytes are the AUTHORIZATION-BEARING payload only —
 * body_sha256 and hmac are computed FROM these bytes by the caller, then
 * appended to the final marker file (which has 6 fields including the
 * derived ones).
 *
 * @param {{
 *   run_id: string,
 *   created_at: string,
 *   decided_class: string,
 *   deadline_at: string,
 * }} fields
 * @returns {{ canonicalBytes: Buffer, sha256: string }}
 */
export function canonicalizeMarkerPayload(fields) {
  if (!fields || typeof fields !== 'object') {
    throw new TypeError('canonicalizeMarkerPayload: fields must be an object')
  }
  const required = ['run_id', 'created_at', 'decided_class', 'deadline_at']
  for (const k of required) {
    if (typeof fields[k] !== 'string' || fields[k] === '') {
      throw new TypeError(`canonicalizeMarkerPayload: ${k} must be a non-empty string`)
    }
  }
  if (!RUN_ID_RE.test(fields.run_id)) {
    throw new TypeError(`canonicalizeMarkerPayload: run_id shape invalid: ${JSON.stringify(fields.run_id)}`)
  }
  if (!VALID_DECIDED_CLASSES.includes(fields.decided_class)) {
    throw new TypeError(`canonicalizeMarkerPayload: decided_class invalid: ${JSON.stringify(fields.decided_class)}`)
  }
  const subset = {
    created_at: fields.created_at,
    deadline_at: fields.deadline_at,
    decided_class: fields.decided_class,
    run_id: fields.run_id,
  }
  // Object literal keys already in sorted order above; sort defensively in case
  // a future caller passes a non-literal object.
  const sortedKeys = Object.keys(subset).sort()
  const sortedPayload = {}
  for (const k of sortedKeys) sortedPayload[k] = subset[k]
  const canonicalBytes = Buffer.from(JSON.stringify(sortedPayload), 'utf8')
  const sha256 = crypto.createHash('sha256').update(canonicalBytes).digest('hex')
  return { canonicalBytes, sha256 }
}

// ---------------------------------------------------------------------------
// writeMarker — atomic write of signed marker file
// ---------------------------------------------------------------------------

/**
 * Write the approval marker atomically. Idempotent under concurrent invocation
 * when (run_id, created_at, decided_class, deadline_at, runKey32B) are identical:
 * the canonical bytes + hmac are deterministic, so two concurrent writers
 * produce byte-identical files. Last-rename-wins is benign.
 *
 * Atomicity: tmp file in same dir → fsync → rename. Crash before rename leaves
 * no observable final path. Crash after rename leaves the marker.
 *
 * On rename failure, the tmp is unlinked best-effort and the rename error is
 * rethrown so the CALLER can emit a `marker-write-failed` HMAC-signed evidence
 * episode (this helper does not emit evidence — codex r2 FU1 ownership split).
 *
 * @param {{
 *   projectRoot: string,         absolute, canonical
 *   runId: string,               shape-validated
 *   decidedClass: string,        one of VALID_DECIDED_CLASSES
 *   createdAt: string,           ISO-8601 UTC, from run-state awaiting_approval_at
 *   deadlineAt: string,          ISO-8601 UTC, from run-state deadline_at
 *   runKey32B: Buffer,           32-byte per-run HMAC key
 * }} opts
 * @returns {{ status: 'ok', markerPath: string, body_sha256: string, hmac: string, alreadyPresent: boolean }
 *   | { status: 'error', code: string, message: string, markerPath: string }}
 */
export function writeMarker(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('writeMarker: opts must be an object')
  }
  const { projectRoot, runId, decidedClass, createdAt, deadlineAt, runKey32B } = opts
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError(`writeMarker: projectRoot must be absolute; got ${projectRoot}`)
  }
  if (!Buffer.isBuffer(runKey32B) || runKey32B.length !== 32) {
    throw new TypeError('writeMarker: runKey32B must be a 32-byte Buffer')
  }

  // 1. Canonicalize + sign.
  const { canonicalBytes, sha256 } = canonicalizeMarkerPayload({
    run_id: runId,
    created_at: createdAt,
    decided_class: decidedClass,
    deadline_at: deadlineAt,
  })
  const hmac = signCanonical(canonicalBytes, runKey32B)

  // 2. Final marker file content: 6 fields. Keys sorted alphabetically for
  //    determinism, matching canonicalize discipline.
  const finalPayload = {
    body_sha256: sha256,
    created_at: createdAt,
    deadline_at: deadlineAt,
    decided_class: decidedClass,
    hmac,
    run_id: runId,
  }
  const sortedFinalKeys = Object.keys(finalPayload).sort()
  const sortedFinal = {}
  for (const k of sortedFinalKeys) sortedFinal[k] = finalPayload[k]
  const fileBytes = Buffer.from(JSON.stringify(sortedFinal) + '\n', 'utf8')

  const target = markerPath(projectRoot, runId)
  const dir = path.dirname(target)

  // 3. Idempotence check (codex r1 M1): if marker already exists with identical
  //    bytes, no-op return alreadyPresent=true. Saves an fs.rename per retry
  //    and surfaces concurrent-Phase-B byte-identical contract to caller.
  try {
    const existing = fs.readFileSync(target)
    if (existing.equals(fileBytes)) {
      return { status: 'ok', markerPath: target, body_sha256: sha256, hmac, alreadyPresent: true }
    }
    // Marker exists but bytes differ — overwrite via atomic rename below.
    // This happens if `created_at` or `deadline_at` changed between runs, which
    // shouldn't occur with persisted run-state, but we defer to the new bytes
    // rather than fail-closed: caller stays at `awaiting_approval` either way.
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { status: 'error', code: e.code || 'read-failed', message: e.message, markerPath: target }
    }
  }

  // 4. mkdir + atomic write.
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { status: 'error', code: e.code || 'mkdir-failed', message: e.message, markerPath: target }
  }
  const tmpPath = `${target}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  let fd
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600)
  } catch (e) {
    return { status: 'error', code: e.code || 'open-failed', message: e.message, markerPath: target }
  }
  try {
    try {
      fs.writeFileSync(fd, fileBytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch (_e) { /* best-effort */ }
    return { status: 'error', code: e.code || 'write-failed', message: e.message, markerPath: target }
  }
  try {
    fs.renameSync(tmpPath, target)
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch (_e) { /* best-effort */ }
    return { status: 'error', code: e.code || 'rename-failed', message: e.message, markerPath: target }
  }

  return { status: 'ok', markerPath: target, body_sha256: sha256, hmac, alreadyPresent: false }
}

// ---------------------------------------------------------------------------
// cleanupApprovalMarker — idempotent unlink helper
// ---------------------------------------------------------------------------

/**
 * Best-effort cleanup of the approval marker file. Idempotent: ENOENT is
 * status: 'ok' (no-op), not an error.
 *
 * Caller-side evidence emission contract (codex r2 FU1): this helper unlinks
 * + returns status only. The caller chooses what to do with non-ENOENT errors.
 *
 * In `finalize-run` / `finalize-recover`, callers stderr-log on non-ENOENT
 * failures and leave the marker on disk (the persisting file IS the forensic
 * evidence; the per-run HMAC key has been shredded by the time these callers
 * reach the marker cleanup step, so HMAC-signed evidence emission is no
 * longer available).
 *
 * @param {string} projectRoot — absolute canonical path
 * @param {string} runId — shape-validated
 * @returns {{ status: 'ok' | 'error', code?: string, message?: string, markerPath: string, alreadyAbsent?: boolean }}
 */
export function cleanupApprovalMarker(projectRoot, runId) {
  let target
  try {
    target = markerPath(projectRoot, runId)
  } catch (e) {
    return { status: 'error', code: 'invalid-input', message: e.message, markerPath: '' }
  }
  try {
    fs.unlinkSync(target)
    return { status: 'ok', markerPath: target, alreadyAbsent: false }
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { status: 'ok', markerPath: target, alreadyAbsent: true }
    }
    return { status: 'error', code: e.code || 'unlink-failed', message: e.message, markerPath: target }
  }
}

// ---------------------------------------------------------------------------
// sweepApprovalMarkers — slice 2f, bulk removal during --disable
// ---------------------------------------------------------------------------

/**
 * Remove ALL bp1-approval-*.json marker files from a project's .checkpoints
 * directory. Used by `bp1-flag-flip --disable` to ensure the operator-
 * disabled project does not retain expired-but-trusted approval markers that
 * a future H1 hook (after re-enable) could pick up out of context.
 *
 * Idempotent on missing directory (ENOENT → status: 'ok', removed: []).
 * Non-matching files in .checkpoints/ are left untouched.
 *
 * Per-file unlink errors are collected in `errors[]` but the sweep continues;
 * the caller decides whether 'partial' constitutes a hard failure. This
 * mirrors the bare-catch P1 lesson (PR-1a round 3): record, never silently
 * swallow.
 *
 * Authority: caller-supplied projectRoot. This helper does NOT canonicalize
 * the root — that is the caller's responsibility (bp1-flag-flip resolves to
 * git-toplevel realpath before invoking).
 *
 * @param {string} projectRoot — absolute path to the canonical project root
 * @returns {{
 *   status: 'ok' | 'partial' | 'error',
 *   removed: string[],
 *   errors: Array<{ path: string, code: string, message: string }>,
 *   code?: string,
 *   message?: string
 * }}
 */
export function sweepApprovalMarkers(projectRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    return {
      status: 'error',
      code: 'invalid-input',
      message: `sweepApprovalMarkers: projectRoot must be absolute; got ${projectRoot}`,
      removed: [],
      errors: [],
    }
  }
  const dir = path.join(projectRoot, '.checkpoints')
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { status: 'ok', removed: [], errors: [] }
    }
    return {
      status: 'error',
      code: e.code || 'readdir-failed',
      message: e.message,
      removed: [],
      errors: [],
    }
  }
  const removed = []
  const errors = []
  // The /^bp1-approval-.+\.json$/ filter assumes `readdirSync(dir)` returns
  // non-recursive basenames (no path separators). That is the documented
  // Node behavior — we do NOT pass `{ recursive: true }`. If a future
  // refactor flips the call to recursive, the regex's `.+` would match
  // strings with `/` and the unlink would target paths outside `dir`.
  // Slice 2f PR-tier M2 (PR #322 review reply ...-e2c3).
  for (const f of entries) {
    if (!/^bp1-approval-.+\.json$/.test(f)) continue
    const target = path.join(dir, f)
    try {
      fs.unlinkSync(target)
      removed.push(target)
    } catch (e) {
      if (e.code === 'ENOENT') continue
      errors.push({ path: target, code: e.code || 'unlink-failed', message: e.message })
    }
  }
  return {
    status: errors.length ? 'partial' : 'ok',
    removed,
    errors,
  }
}
