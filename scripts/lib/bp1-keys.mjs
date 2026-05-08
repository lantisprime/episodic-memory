/**
 * bp1-keys.mjs — BP-1 HMAC key file management (RFC-004 §664-684).
 *
 * Two key types, parallel members of class "32-byte HMAC key file at 0o600":
 *
 *   1. Per-run key — `<projectRoot>/.episodic-memory/runs/<run_id>/run.key`.
 *      Project-local. Generated at init-run, shredded at finalize-run.
 *      Signs every authorization-bearing episode in a single run (live-run
 *      phase). 32 bytes from crypto.randomBytes.
 *
 *   2. Verify-key — `~/.episodic-memory/.verify-key` (HOME-global).
 *      Long-lived; generated once at install. Signs the bp1-run-manifest at
 *      finalize (post-terminal phase). Read by orchestrator at cold-start
 *      to compute the fingerprint that guards against verify-key drift
 *      (TB3 / Issue #185).
 *
 * Same-class invariants (#13):
 *   - Both files are 32 bytes from crypto.randomBytes.
 *   - Both files mode 0o600 (owner read/write only). Mode drift fails closed.
 *   - Both load operations return { key32B, ... } | { error: 'missing'|'mode'|'size'|'unreadable' }.
 *
 * Different-class behavior:
 *   - Path resolution differs: per-run keys take projectRoot; verify-key takes
 *     homeDir (test-overridable for sandbox-HOME fixtures, B3 from planner).
 *   - Lifetime differs: per-run keys are shredded by finalize-run (PR-1c-B);
 *     verify-key persists across runs and is rotated only by M5.
 *
 * HOME sandboxing (B3 from planner — codex round-1 confirmed CLOSED in v2):
 *   loadVerifyKey accepts an explicit `homeDir` parameter that defaults to
 *   `os.homedir()`. Test fixtures MUST pass a `fs.mkdtempSync` sandbox HOME
 *   to avoid reading the developer's real `~/.episodic-memory/.verify-key`.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { verifyKeyFingerprint } from './bp1-hmac.mjs'

const KEY_SIZE_BYTES = 32
const KEY_MODE = 0o600
const MODE_MASK = 0o777

// ---------------------------------------------------------------------------
// Shared invariant helpers (per #13 same-class)
// ---------------------------------------------------------------------------

/**
 * Assert a Buffer is exactly 32 bytes (RFC §667).
 * @param {Buffer} buf
 * @returns {{ ok: true } | { error: 'size' }}
 */
export function assertKey32Bytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== KEY_SIZE_BYTES) {
    return { error: 'size' }
  }
  return { ok: true }
}

/**
 * Assert an fs.statSync() result has mode 0o600 (RFC §670).
 * @param {fs.Stats} stat
 * @returns {{ ok: true } | { error: 'mode' }}
 */
export function assertKeyMode0600(stat) {
  if (!stat || (stat.mode & MODE_MASK) !== KEY_MODE) {
    return { error: 'mode' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Per-run key (live-run phase, project-local)
// ---------------------------------------------------------------------------

/**
 * Compute the absolute path to a per-run key file.
 *
 * @param {string} projectRoot — absolute canonical project root
 * @param {string} runId — bp1-run-<ms>-<slug>-<rand6>
 * @returns {string}
 */
export function runKeyPath(projectRoot, runId) {
  return path.join(projectRoot, '.episodic-memory', 'runs', runId, 'run.key')
}

/**
 * Generate a fresh 32-byte per-run key + write to runKeyPath at mode 0o600.
 * Creates the run directory if absent.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {{ keyPath: string, key32B: Buffer }}
 */
export function generateRunKey(projectRoot, runId) {
  const keyPath = runKeyPath(projectRoot, runId)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  const key32B = crypto.randomBytes(KEY_SIZE_BYTES)
  // Open with O_EXCL to fail loud if a key already exists at that path
  // (run_id collision was already caught by run-state appendRun, but
  // defense-in-depth in case the runs/<run_id>/ dir was hand-created).
  const fd = fs.openSync(keyPath, 'wx', KEY_MODE)
  try {
    fs.writeSync(fd, key32B, 0, KEY_SIZE_BYTES, 0)
  } finally {
    fs.closeSync(fd)
  }
  // Confirm mode (some umasks/ACLs can interfere on edge platforms).
  fs.chmodSync(keyPath, KEY_MODE)
  return { keyPath, key32B }
}

/**
 * Load the per-run key. Asserts mode + size invariants. Returns the key
 * Buffer or a tagged error.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {{ key32B: Buffer } | { error: 'missing'|'mode'|'size'|'unreadable' }}
 */
export function loadRunKey(projectRoot, runId) {
  const keyPath = runKeyPath(projectRoot, runId)
  let stat
  try {
    stat = fs.statSync(keyPath)
  } catch (e) {
    if (e.code === 'ENOENT') return { error: 'missing' }
    return { error: 'unreadable' }
  }
  const modeCheck = assertKeyMode0600(stat)
  if (modeCheck.error) return { error: 'mode' }
  let buf
  try {
    buf = fs.readFileSync(keyPath)
  } catch (_e) {
    return { error: 'unreadable' }
  }
  const sizeCheck = assertKey32Bytes(buf)
  if (sizeCheck.error) return { error: 'size' }
  return { key32B: buf }
}

/**
 * Shred the per-run key: overwrite with random bytes, then unlink.
 *
 * Used by finalize-run (PR-1c-B); included here so the API surface is
 * complete for plan v4. PR-1c-A doesn't call shredRunKey but unit-tests
 * the helper for completeness.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {{ ok: true } | { error: 'missing'|'unreadable' }}
 */
export function shredRunKey(projectRoot, runId) {
  const keyPath = runKeyPath(projectRoot, runId)
  let stat
  try {
    stat = fs.statSync(keyPath)
  } catch (e) {
    if (e.code === 'ENOENT') return { error: 'missing' }
    return { error: 'unreadable' }
  }
  // Overwrite with random bytes (single pass — adequate for ephemeral
  // process-memory leakage; full DoD wipe is overkill for a 32-byte file).
  try {
    fs.writeFileSync(keyPath, crypto.randomBytes(stat.size), { mode: KEY_MODE })
    fs.unlinkSync(keyPath)
  } catch (_e) {
    return { error: 'unreadable' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Long-lived verify-key (post-terminal + cold-start drift check, HOME-global)
// ---------------------------------------------------------------------------

/**
 * Compute the absolute path to the verify-key file.
 *
 * @param {string} [homeDir] — defaults to os.homedir(); test fixtures pass
 *   a sandboxed tmpdir to avoid reading real `~/`.
 * @returns {string}
 */
export function verifyKeyPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.episodic-memory', '.verify-key')
}

/**
 * Load the verify-key + compute fingerprint. Asserts mode + size invariants.
 *
 * The fingerprint is the 16-hex public identifier recorded in activation
 * episodes (RFC §682). Mismatch between an episode's `verify_key_id` field
 * and the live verify-key fingerprint signals key rotation / drift and
 * forces orchestrator init-run to fail closed (TB3).
 *
 * @param {string} [homeDir]
 * @returns {{ key32B: Buffer, fingerprint16: string } | { error: 'missing'|'mode'|'size'|'unreadable' }}
 */
export function loadVerifyKey(homeDir = os.homedir()) {
  const keyPath = verifyKeyPath(homeDir)
  let stat
  try {
    stat = fs.statSync(keyPath)
  } catch (e) {
    if (e.code === 'ENOENT') return { error: 'missing' }
    return { error: 'unreadable' }
  }
  const modeCheck = assertKeyMode0600(stat)
  if (modeCheck.error) return { error: 'mode' }
  let buf
  try {
    buf = fs.readFileSync(keyPath)
  } catch (_e) {
    return { error: 'unreadable' }
  }
  const sizeCheck = assertKey32Bytes(buf)
  if (sizeCheck.error) return { error: 'size' }
  return { key32B: buf, fingerprint16: verifyKeyFingerprint(buf) }
}
