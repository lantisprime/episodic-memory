/**
 * bp1-run-state-migrate.mjs — Pure in-memory v1→v2 run-state index migration
 * (slice 2c CR2-3).
 *
 * The v1→v2 migration is additive:
 *   - Bump schema_version: 1 → 2.
 *   - For every existing entry in `runs`, default 5 new optional fields to null:
 *       - decided_class
 *       - pre_episode_id
 *       - rfc_detected_episode_id
 *       - classified_episode_id    (cluster #286/#287/#288)
 *       - route_episode_id         (cluster #286/#287/#288)
 *   - v1 fields (`project_root`, `state`, `created_at`, `terminal_at`) preserved
 *     as-is.
 *   - v2 expands the `state` value vocabulary (rfc-detected,
 *     classifier-dispatch-pending, classified, planning, needs-human) but does
 *     NOT rewrite existing state values: a v1 `state: 'active'` stays `active`.
 *
 * The v2 branch (input already v2) ALSO normalizes pre-existing rows to
 * default `classified_episode_id`, `route_episode_id`, `awaiting_approval_at`,
 * and `deadline_at` to null when missing (soft schema additions without
 * bumping schema_version). Cluster #286/#287/#288 added the first two; slice
 * 2d-W adds the latter two. The normalization here is the single read-side
 * reconciliation point.
 *
 * This module exports a **pure function** — no IO, no lock acquisition. Used
 * inside `bp1-run-state.mjs`'s `loadIndex` (unlocked entry point) and
 * `loadIndexLocked` (in-lock entry point) so the same migration semantics
 * apply in both lock contexts. The split eliminates the v1→v2 self-deadlock
 * where `loadIndex` (acquiring the lock) was being called from `appendRun`
 * (already holding the lock) — see plan v4 CR2-3.
 *
 * Idempotence: `migrateV1ToV2(v2Obj)` returns the input unchanged (cheap
 * defensive copy semantics — caller should not rely on identity). The
 * migrator never downgrades nor mutates unknown fields.
 *
 * Zero deps; Node stdlib only.
 */

export const V1_SCHEMA = 1
export const V2_SCHEMA = 2

/**
 * Migrate a v1 run-state index to v2. Idempotent on v2 input.
 *
 * @param {object} idx — parsed `_index.json` content (v1 or v2)
 * @returns {{ schema_version: 2, runs: object }}
 * @throws {TypeError} on malformed input
 */
export function migrateV1ToV2(idx) {
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) {
    throw new TypeError('migrateV1ToV2: input must be an object')
  }
  if (idx.schema_version !== V1_SCHEMA && idx.schema_version !== V2_SCHEMA) {
    throw new TypeError(`migrateV1ToV2: unsupported schema_version ${JSON.stringify(idx.schema_version)}`)
  }
  if (idx.runs != null && (typeof idx.runs !== 'object' || Array.isArray(idx.runs))) {
    throw new TypeError('migrateV1ToV2: runs must be an object')
  }
  if (idx.schema_version === V2_SCHEMA) {
    // Defensive copy so callers cannot tamper our return. Also normalize
    // pre-existing rows to default cluster #286/#287/#288 fields to null —
    // this is a soft schema addition without schema_version bump, and the
    // normalization here is the single read-side reconciliation point.
    const copy = { schema_version: V2_SCHEMA, runs: {} }
    for (const [runId, run] of Object.entries(idx.runs || {})) {
      copy.runs[runId] = {
        ...run,
        classified_episode_id: run.classified_episode_id ?? null,
        route_episode_id: run.route_episode_id ?? null,
        awaiting_approval_at: run.awaiting_approval_at ?? null,
        deadline_at: run.deadline_at ?? null,
      }
    }
    return copy
  }

  // v1 → v2 path.
  const out = { schema_version: V2_SCHEMA, runs: {} }
  for (const [runId, v1Run] of Object.entries(idx.runs || {})) {
    if (!v1Run || typeof v1Run !== 'object') {
      throw new TypeError(`migrateV1ToV2: run entry ${JSON.stringify(runId)} is not an object`)
    }
    out.runs[runId] = {
      project_root: v1Run.project_root,
      state: v1Run.state,
      created_at: v1Run.created_at,
      terminal_at: v1Run.terminal_at ?? null,
      decided_class: v1Run.decided_class ?? null,
      pre_episode_id: v1Run.pre_episode_id ?? null,
      rfc_detected_episode_id: v1Run.rfc_detected_episode_id ?? null,
      classified_episode_id: v1Run.classified_episode_id ?? null,
      route_episode_id: v1Run.route_episode_id ?? null,
      awaiting_approval_at: v1Run.awaiting_approval_at ?? null,
      deadline_at: v1Run.deadline_at ?? null,
    }
  }
  return out
}
