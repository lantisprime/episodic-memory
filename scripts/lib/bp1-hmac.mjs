/**
 * bp1-hmac.mjs — HMAC sign/verify primitives for BP-1 episodes (RFC-004 §664-674).
 *
 * Phase scoping:
 *   - Live-run phase (per-run key): signCanonical / verifyCanonical against
 *     the run's 32-byte run.key. Used by orchestrator + auditor at every
 *     authorization-bearing episode.
 *   - Post-terminal phase (verify-key): verifyKeyFingerprint computes the
 *     16-hex public fingerprint of the long-lived ~/.episodic-memory/.verify-key.
 *     Cold-start orchestrator compares activation-map fingerprint vs live key.
 *
 * Constant-time discipline (codex code-review TB1, plan v4):
 *   verifyCanonical wraps Node's crypto.timingSafeEqual primitive. Length and
 *   non-hex validation pre-checks return false (NOT throw), because
 *   crypto.timingSafeEqual throws on length mismatch and we don't want signature
 *   length to leak via exception message vs return false. Both branches are
 *   documented behaviour, both verified by tests/test-bp1-hmac-live.mjs.
 *
 * Verify-key fingerprint (RFC §682):
 *   fingerprint16 = first 16 hex chars of HMAC-SHA256(key, "verify-key-fingerprint-v1")
 *   The fingerprint is intentionally NON-SECRET (it's recorded in activation
 *   episodes for drift detection). Comparing fingerprints uses string equality —
 *   timing-safety is not required here.
 *
 * Zero deps; Node stdlib only.
 */

import crypto from 'node:crypto'

const FINGERPRINT_DOMAIN = 'verify-key-fingerprint-v1'
const FINGERPRINT_HEX_CHARS = 16

const HEX_RE = /^[0-9a-fA-F]+$/

// ---------------------------------------------------------------------------
// signCanonical / verifyCanonical (live-run phase)
// ---------------------------------------------------------------------------

/**
 * Sign canonical bytes with the per-run HMAC key.
 *
 * @param {Buffer|Uint8Array} canonicalBytes — output of canonicalize().canonicalBytes
 * @param {Buffer} runKey32B — 32-byte run.key (caller's responsibility to verify size + mode via bp1-keys)
 * @returns {string} lowercase hex HMAC-SHA256
 */
export function signCanonical(canonicalBytes, runKey32B) {
  if (!Buffer.isBuffer(canonicalBytes) && !(canonicalBytes instanceof Uint8Array)) {
    throw new TypeError('canonicalBytes must be Buffer or Uint8Array')
  }
  if (!Buffer.isBuffer(runKey32B) || runKey32B.length !== 32) {
    // Caller should have validated via loadRunKey() — defense in depth.
    throw new TypeError('runKey32B must be a 32-byte Buffer')
  }
  return crypto.createHmac('sha256', runKey32B).update(canonicalBytes).digest('hex')
}

/**
 * Verify a hex HMAC against canonical bytes + run.key.
 *
 * Returns boolean; never throws on attacker-controlled input. Specifically:
 *   - missing/null/non-string hexHmac → false
 *   - non-hex characters → false
 *   - length mismatch (signature not 64 hex chars) → false
 *   - cryptographic mismatch → false
 *   - cryptographic match → true
 *
 * Equal-length valid-hex pairs are compared via crypto.timingSafeEqual
 * (constant-time, V8-immune to early-exit optimization).
 *
 * @param {Buffer|Uint8Array} canonicalBytes
 * @param {Buffer} runKey32B
 * @param {string|null|undefined} hexHmac
 * @returns {boolean}
 */
export function verifyCanonical(canonicalBytes, runKey32B, hexHmac) {
  if (typeof hexHmac !== 'string' || hexHmac.length === 0) return false
  if (!HEX_RE.test(hexHmac)) return false

  let expected
  try {
    expected = signCanonical(canonicalBytes, runKey32B)
  } catch (_e) {
    // Bad inputs (bytes type / key size). Defense-in-depth: refuse to verify.
    return false
  }
  if (expected.length !== hexHmac.length) return false

  // Constant-time compare on equal-length Buffers.
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(hexHmac, 'hex'),
  )
}

// ---------------------------------------------------------------------------
// verifyKeyFingerprint / fingerprintEqual (post-terminal + cold-start drift)
// ---------------------------------------------------------------------------

/**
 * Compute the 16-hex public fingerprint of the verify-key.
 *
 * @param {Buffer} verifyKey32B — 32-byte ~/.episodic-memory/.verify-key bytes
 * @returns {string} 16 lowercase hex chars
 */
export function verifyKeyFingerprint(verifyKey32B) {
  if (!Buffer.isBuffer(verifyKey32B) || verifyKey32B.length !== 32) {
    throw new TypeError('verifyKey32B must be a 32-byte Buffer')
  }
  return crypto.createHmac('sha256', verifyKey32B)
    .update(FINGERPRINT_DOMAIN, 'utf8')
    .digest('hex')
    .slice(0, FINGERPRINT_HEX_CHARS)
}

/**
 * Compare two fingerprints. Plain string equality is correct: fingerprints
 * are non-secret per RFC §682 (recorded in activation episodes for drift
 * detection). Timing-safety is not required.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function fingerprintEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b
}
