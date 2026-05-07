/**
 * bp1-canonicalize.mjs — Canonical-field projection + sha256 for BP-1 episodes.
 *
 * Mirrors RFC-004 §689-719 (v3.13 — adds state-transition:run-started fields
 * per Resolution 4 / Issue #185). Any change here MUST be paired with:
 *   - RFC-004 §689-719 update.
 *   - validate-rfc-failure-table.mjs CI gate update.
 *   - Existing signed episodes re-signed (in practice: ship with new M1 release).
 *
 * Two-layer separation (Resolution 3):
 *   - Probe lib API (`scripts/lib/bp1-probe.mjs`) returns concise unprefixed
 *     names (`capability`, `reason`, `degraded_mode_message`).
 *   - Activation episode frontmatter uses RFC-spec self-describing names
 *     (`scheduled_tasks_capability`, `probe_reason`, `degraded_mode_statement`,
 *     `native_probe_performed`, `t2_fallback`).
 *   - The orchestrator's `init-run` projects via `projectProbeResultToFrontmatter`
 *     at the activation-episode write boundary. The projection is a pure
 *     function — same input → same output — pinned by AC1 test.
 *
 * Determinism (#18 I5):
 *   canonicalize(...) is byte-identical for inputs that differ only in
 *   non-canonical frontmatter fields OR key order in the projected subset.
 *   Object.keys(payload).sort() enforces key-order stability before
 *   JSON.stringify. body_sha256 is computed over body bytes only (frontmatter
 *   excluded) so re-serialization of frontmatter doesn't invalidate digests.
 *
 * Zero deps; Node stdlib only.
 */

import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Canonical-fields source-of-truth tables
// (mirrors RFC-004 §689-719 v3.13)
// ---------------------------------------------------------------------------

/**
 * Generic canonical fields — present on every BP-1 authorization-bearing episode.
 * RFC §690-698.
 */
export const GENERIC_CANONICAL_FIELDS = Object.freeze([
  'run_id',
  'parent_episode',
  'type',
  'expected_post_episode_id',
  'summary',
  'body_sha256',
])

/**
 * Type-specific canonical fields, keyed by `<type>:<state-or-tag>`.
 *
 * - For `type == 'state-transition'`: key = `state-transition:<state>`.
 * - For `type == 'evidence'`: key = `evidence:<dominant-tag>` (caller selects
 *   tag matching this lookup; current scope has zero evidence types in
 *   PR-1c-A — listed for forward compatibility with PR-1c-B and beyond).
 *
 * Adding a new authorization-bearing field requires:
 *   1. Add to this table.
 *   2. Update RFC-004 §689-719 canonical-fields table.
 *   3. Update validate-rfc-failure-table.mjs CI gate.
 *   4. Re-sign existing episodes (or ship as a new M-release).
 */
export const TYPE_SPECIFIC_CANONICAL_FIELDS = Object.freeze({
  'state-transition:codex_review': Object.freeze([
    'state',
    'attempt_number',
    'parent_state_transition',
  ]),
  'state-transition:run-started': Object.freeze([
    'state',
    'scheduled_tasks_capability',
    'probe_reason',
    'degraded_mode_statement',
    'native_probe_performed',
    't2_fallback',
  ]),
  'evidence:bp1-codex-request-sent': Object.freeze([
    'requested_at',
    'review_request_ref',
  ]),
  'evidence:bp1-state-lock-claim': Object.freeze([
    'lock_state_tag',
    'lock_ttl_seconds',
  ]),
})

// ---------------------------------------------------------------------------
// Subtype-key resolution
// ---------------------------------------------------------------------------

/**
 * Compute the lookup key for TYPE_SPECIFIC_CANONICAL_FIELDS from a frontmatter
 * object. Returns null when the frontmatter type carries no extra canonical
 * fields beyond GENERIC_CANONICAL_FIELDS.
 *
 * @param {object} frontmatter
 * @returns {string|null}
 */
export function subtypeKey(frontmatter) {
  if (!frontmatter || typeof frontmatter !== 'object') return null
  const type = frontmatter.type
  if (type === 'state-transition' && typeof frontmatter.state === 'string') {
    return `state-transition:${frontmatter.state}`
  }
  if (type === 'evidence' && Array.isArray(frontmatter.tags)) {
    for (const tag of frontmatter.tags) {
      if (typeof tag === 'string') {
        const key = `evidence:${tag}`
        if (TYPE_SPECIFIC_CANONICAL_FIELDS[key]) return key
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// canonicalize — frontmatter + body → canonical payload + bytes
// ---------------------------------------------------------------------------

/**
 * Project frontmatter to canonical fields, compute body_sha256, sort keys,
 * JSON.stringify, utf8-encode. The output `canonicalBytes` is what
 * signCanonical/verifyCanonical (bp1-hmac) operate on.
 *
 * Non-canonical frontmatter fields are excluded. Adding/removing such fields
 * does NOT invalidate the signature (H25 / I8).
 *
 * @param {object} frontmatter — parsed frontmatter object (e.g. from YAML)
 * @param {Buffer|Uint8Array|string} bodyBytes — body bytes (post-frontmatter
 *   markdown). String inputs are utf8-encoded.
 * @returns {{ canonicalBytes: Buffer, payload: object }}
 */
export function canonicalize(frontmatter, bodyBytes) {
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new TypeError('frontmatter must be an object')
  }
  const bodyBuf =
    typeof bodyBytes === 'string'
      ? Buffer.from(bodyBytes, 'utf8')
      : Buffer.isBuffer(bodyBytes) || bodyBytes instanceof Uint8Array
        ? Buffer.from(bodyBytes)
        : null
  if (!bodyBuf) {
    throw new TypeError('bodyBytes must be Buffer, Uint8Array, or string')
  }

  const bodySha = crypto.createHash('sha256').update(bodyBuf).digest('hex')

  // Build payload from generic + type-specific fields. body_sha256 is computed
  // here; whatever the caller passed in frontmatter for body_sha256 is ignored
  // (canonical signing must bind to actual body bytes, not caller-supplied).
  const payload = {}
  for (const field of GENERIC_CANONICAL_FIELDS) {
    if (field === 'body_sha256') {
      payload[field] = bodySha
    } else if (Object.prototype.hasOwnProperty.call(frontmatter, field)) {
      payload[field] = frontmatter[field]
    } else {
      payload[field] = null
    }
  }

  const subKey = subtypeKey(frontmatter)
  if (subKey) {
    const fields = TYPE_SPECIFIC_CANONICAL_FIELDS[subKey]
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(frontmatter, field)) {
        payload[field] = frontmatter[field]
      } else {
        payload[field] = null
      }
    }
  }

  // Sort keys for deterministic JSON.
  const sortedKeys = Object.keys(payload).sort()
  const sortedPayload = {}
  for (const k of sortedKeys) sortedPayload[k] = payload[k]

  const canonicalBytes = Buffer.from(JSON.stringify(sortedPayload), 'utf8')
  return { canonicalBytes, payload: sortedPayload }
}

// ---------------------------------------------------------------------------
// projectProbeResultToFrontmatter — Resolution 3 boundary
// ---------------------------------------------------------------------------

/**
 * Project a `bp1-probe.mjs` ProbeResult into the `bp1-run-started` frontmatter
 * shape. Pure function; same input → same output (pinned by AC1 test).
 *
 * Field mapping (Resolution 3):
 *   probeResult.capability             → scheduled_tasks_capability
 *   probeResult.reason                 → probe_reason
 *   probeResult.degraded_mode_message  → degraded_mode_statement
 *   probeResult.native_probe_performed → native_probe_performed (rename-identity)
 *   probeResult.t2_fallback            → t2_fallback (rename-identity)
 *
 * The `state: 'run-started'` field is always set; this is what subtypeKey()
 * matches for canonicalize() to find the type-specific canonical fields.
 *
 * @param {{
 *   capability: 'native'|'fallback',
 *   reason: string,
 *   degraded_mode_message: string|null,
 *   native_probe_performed: boolean,
 *   t2_fallback: boolean,
 * }} probeResult
 * @returns {{
 *   state: 'run-started',
 *   scheduled_tasks_capability: 'native'|'fallback',
 *   probe_reason: string,
 *   degraded_mode_statement: string|null,
 *   native_probe_performed: boolean,
 *   t2_fallback: boolean,
 * }}
 */
export function projectProbeResultToFrontmatter(probeResult) {
  if (!probeResult || typeof probeResult !== 'object') {
    throw new TypeError('probeResult must be an object')
  }
  return {
    state: 'run-started',
    scheduled_tasks_capability: probeResult.capability,
    probe_reason: probeResult.reason,
    degraded_mode_statement: probeResult.degraded_mode_message,
    native_probe_performed: probeResult.native_probe_performed,
    t2_fallback: probeResult.t2_fallback,
  }
}
