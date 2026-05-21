/**
 * bp1-sweep.mjs — Pure helper for the unified deadline-sweep fallback.
 *
 * RFC-004 §556-577 (PR-1b-A). Replays Path A (request-issued timeout, 30min
 * per RFC §321 / §385 / §845) and Path B (naked-entry recovery, 5min age
 * threshold per RFC §555 / §177) against an in-memory list of active runs.
 *
 * Codex plan-review consensus (round 1 Q2.2 / round 3): this module is PURE.
 *   - Zero I/O.
 *   - No episode emission.
 *   - No lock-taking.
 *   - No subprocess spawning.
 *
 * The executor (scripts/bp1-deadline-sweep.mjs) feeds in active-run state
 * read from disk, takes scanForCandidates' output, and runs the action loop
 * under within-invocation per-entry advisory locks (RFC §909-923 with
 * stale-reclaim). Persistent request-claim creation (RFC §911-929) is
 * deferred to M1's orchestrator runtime — PR-1b-A only emits
 * `bp1-sweep-action-pending-m1` evidence per detected candidate.
 */
'use strict'

// RFC-004 anchored thresholds. Caller may override via config for tests, but
// production callers should use the defaults to match the scheduled-task
// behavior the fallback replays.
export const PATH_A_TIMEOUT_MS = 30 * 60 * 1000  // 30 min, RFC §321/§385/§845
export const PATH_B_AGE_THRESHOLD_MS = 5 * 60 * 1000  // 5 min, RFC §555/§177

/**
 * Scan active runs for sweep-eligible codex_review entries.
 *
 * @param {object} args
 * @param {Array<RunInput>} args.activeRuns
 *   Active-run state. Each run is an object with `run_id` (string) and
 *   `codex_review_entries` (array of EntryInput). The executor is
 *   responsible for assembling this from disk.
 * @param {number} args.now Milliseconds since epoch (caller injects for
 *   determinism in tests; production callers pass Date.now()).
 * @param {object} [args.config]
 * @param {number} [args.config.path_a_timeout_ms=PATH_A_TIMEOUT_MS]
 * @param {number} [args.config.path_b_age_threshold_ms=PATH_B_AGE_THRESHOLD_MS]
 *
 * @returns {ScanResult}
 *
 * @typedef {object} EntryInput
 * @property {string} entry_id
 *   Stable identifier for this codex_review entry. The executor uses it to
 *   take a per-entry advisory lock (within-invocation only — RFC §909-923
 *   with stale-reclaim). Persistent request claim is M1's responsibility.
 * @property {number|null|undefined} created_at
 *   Entry created_at in ms. Missing/non-number → counted as stale_or_corrupt.
 * @property {boolean} request_sent
 *   True iff a `bp1-codex-request-sent` evidence episode exists for this
 *   entry. Path B candidates have request_sent === false.
 * @property {number|null|undefined} requested_at
 *   ms timestamp of the request-sent event. Path A candidates have a value.
 * @property {boolean} response_received
 *   True iff a Codex reply has landed (or a synthetic terminal — needs_human,
 *   cancelled, halted). Path A candidates have response_received === false.
 * @property {boolean} cancelled
 *   True iff the entry was cancelled / resolved by another path (e.g. user
 *   rejected, parent run halted). Either Path A or B path skips a cancelled
 *   entry.
 *
 * @typedef {object} RunInput
 * @property {string} run_id
 * @property {Array<EntryInput>} codex_review_entries
 *
 * @typedef {object} Candidate
 * @property {string} run_id
 * @property {string} entry_id
 * @property {'path_a'|'path_b'} path
 * @property {number} age_ms     ms since the relevant timestamp
 * @property {number} threshold_ms The threshold this candidate exceeded
 *
 * @typedef {object} ScanResult
 * @property {Array<Candidate>} path_a_candidates
 * @property {Array<Candidate>} path_b_candidates
 * @property {object} counts
 * @property {number} counts.path_a_candidate_count
 * @property {number} counts.path_b_candidate_count
 * @property {number} counts.runs_inspected_count
 * @property {number} counts.entries_inspected_count
 * @property {number} counts.stale_or_corrupt_count
 *   Entries with missing/non-number created_at, AND Path A entries with
 *   request_sent=true but missing/non-number requested_at. Logged for the
 *   operator; not an actionable candidate. Bare-catch P1 lesson (PR-1a
 *   round 3): we count + classify, never silently swallow.
 */
export function scanForCandidates({ activeRuns, now, config } = {}) {
  if (!Array.isArray(activeRuns)) {
    throw new TypeError('scanForCandidates: activeRuns must be an array')
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError('scanForCandidates: now must be a finite number (ms since epoch)')
  }
  const cfg = config || {}
  const pathATimeout = typeof cfg.path_a_timeout_ms === 'number' && cfg.path_a_timeout_ms > 0
    ? cfg.path_a_timeout_ms : PATH_A_TIMEOUT_MS
  const pathBThreshold = typeof cfg.path_b_age_threshold_ms === 'number' && cfg.path_b_age_threshold_ms > 0
    ? cfg.path_b_age_threshold_ms : PATH_B_AGE_THRESHOLD_MS

  const path_a_candidates = []
  const path_b_candidates = []
  let entries_inspected_count = 0
  let stale_or_corrupt_count = 0

  // Slice 2f BLOCKER closure (codex code-review r1, episode ...-f964):
  // persisted run_id + entry_id are interpolated into unsigned-episode
  // filenames downstream (e.g. `bp1-naked-sweep-action-pending-m3-${tickId}-
  // ${run_id}-${entry_id}.md`). An unvalidated string can carry path-
  // traversal sequences like "../escape" that bypass the episodes/ directory
  // boundary, causing the action-pending + no-key audit emissions to fail
  // silently while the parent tick still reports `path_b_candidate_count: 1`.
  // Reject IDs that aren't path-safe at scan time; surface them as
  // stale_or_corrupt instead of as actionable candidates.
  const ID_SHAPE_RE = /^[A-Za-z0-9_-]+$/

  for (const run of activeRuns) {
    if (!run || typeof run !== 'object') {
      stale_or_corrupt_count++
      continue
    }
    const runId = run.run_id
    const runIdSafe = typeof runId === 'string' && ID_SHAPE_RE.test(runId)
    const entries = Array.isArray(run.codex_review_entries) ? run.codex_review_entries : []
    for (const entry of entries) {
      entries_inspected_count++
      if (!entry || typeof entry !== 'object' || typeof entry.entry_id !== 'string') {
        stale_or_corrupt_count++
        continue
      }
      // Path-traversal + shape guard: both IDs become filename components.
      if (!runIdSafe || !ID_SHAPE_RE.test(entry.entry_id)) {
        stale_or_corrupt_count++
        continue
      }
      const ts = entry.created_at
      if (typeof ts !== 'number' || !Number.isFinite(ts)) {
        stale_or_corrupt_count++
        continue
      }
      if (entry.cancelled === true) continue

      // Path A: request sent, no response, past requested_at + timeout.
      if (entry.request_sent === true && entry.response_received !== true) {
        const reqAt = entry.requested_at
        if (typeof reqAt !== 'number' || !Number.isFinite(reqAt)) {
          stale_or_corrupt_count++
          continue
        }
        const age = now - reqAt
        if (age >= pathATimeout) {
          path_a_candidates.push({
            run_id: runId, entry_id: entry.entry_id,
            path: 'path_a', age_ms: age, threshold_ms: pathATimeout,
          })
        }
        continue
      }

      // Path B: naked entry (no request sent), past created_at + age threshold.
      if (entry.request_sent !== true) {
        const age = now - ts
        if (age >= pathBThreshold) {
          path_b_candidates.push({
            run_id: runId, entry_id: entry.entry_id,
            path: 'path_b', age_ms: age, threshold_ms: pathBThreshold,
          })
        }
      }
    }
  }

  // Sort for deterministic output (downstream tick payload + idempotency).
  path_a_candidates.sort(byRunThenEntry)
  path_b_candidates.sort(byRunThenEntry)

  return {
    path_a_candidates,
    path_b_candidates,
    counts: {
      path_a_candidate_count: path_a_candidates.length,
      path_b_candidate_count: path_b_candidates.length,
      runs_inspected_count: activeRuns.length,
      entries_inspected_count,
      stale_or_corrupt_count,
    },
  }
}

function byRunThenEntry(a, b) {
  if (a.run_id !== b.run_id) return a.run_id < b.run_id ? -1 : 1
  return a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0
}
