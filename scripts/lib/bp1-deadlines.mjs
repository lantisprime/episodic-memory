/**
 * bp1-deadlines.mjs — Pure deadline-math helpers for the RFC-004 BP-1
 * `check-deadlines` subcommand (slice 2e, RFC-004 M2 Path A).
 *
 * Zero I/O. Callers (orchestrator, fallback sweep) read the run-state index
 * and the most-recent `codex_review` entry + linked `bp1-codex-request-sent`
 * evidence themselves, then pass plain objects through these helpers to
 * decide which runs have a deadline that fires this tick.
 *
 * Two deadline kinds, per RFC §1261 v3.7 ("two distinct deadlines"):
 *
 *   - A1 (codex-reply timeout, 30 min from `bp1-codex-request-sent.requested_at`):
 *     fires only when a request was actually issued (`request_sent === true`).
 *     `request_sent === false` is Path B territory (naked-entry sweep, slice 2f)
 *     and is reported as `fires:false, reason:'no-request-sent'` so the caller
 *     can route accordingly.
 *
 *   - A2 (awaiting-approval timeout, persisted `deadline_at` from run-state):
 *     fires when `state === 'awaiting_approval'` and `now >= deadline_at`.
 *     `deadline_at` is minted once at fresh emit (slice 2d-W) and persisted —
 *     this helper never consults wall-clock for the deadline, only for `now`.
 *
 * Both helpers accept `now` as either an epoch-millis number or an ISO-8601
 * string (Date.parse-able). Returning the deadline_at as ISO keeps the shape
 * uniform with the run-state schema.
 *
 * The action decision (advance attempt N → N+1, or transition to needs_human
 * when attempt ≥ 2) is NOT here — it depends on `attempt_number` semantics
 * the caller reads from the decision log + state lock. This lib only answers
 * "should this run's deadline fire?".
 */

/** A1 (request-issued / codex-reply) timeout: 30 minutes. */
export const A1_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Resolve a `now` argument that may be an ISO-8601 string or epoch millis.
 *
 * @param {number|string} now
 * @returns {number}
 * @throws {Error} if the input cannot be resolved to a finite millisecond value.
 */
function resolveNowMs(now) {
  if (typeof now === 'number' && Number.isFinite(now)) return now
  if (typeof now === 'string') {
    const ms = Date.parse(now)
    if (!Number.isNaN(ms)) return ms
  }
  throw new Error(`bp1-deadlines: invalid now value ${JSON.stringify(now)}`)
}

/**
 * Compute the A1 (codex-reply) deadline for a `codex_review` entry. Requires
 * the linked `bp1-codex-request-sent` evidence's `requested_at` (the side
 * effect that started the 30-min timer) and the `request_sent` flag derived
 * from evidence presence.
 *
 * @param {{ requested_at: string|null, request_sent: boolean }} entry
 * @param {number|string} now
 * @returns {{
 *   fires: boolean,
 *   deadline_at: string|null,
 *   reason: 'fires'|'timer-active'|'no-request-sent'|'invalid-requested-at',
 * }}
 */
export function computeA1FromCodexReviewEntry(entry, now) {
  if (!entry || entry.request_sent !== true) {
    return { fires: false, deadline_at: null, reason: 'no-request-sent' }
  }
  if (typeof entry.requested_at !== 'string') {
    return { fires: false, deadline_at: null, reason: 'invalid-requested-at' }
  }
  const requestedMs = Date.parse(entry.requested_at)
  if (Number.isNaN(requestedMs)) {
    return { fires: false, deadline_at: null, reason: 'invalid-requested-at' }
  }
  const deadlineMs = requestedMs + A1_TIMEOUT_MS
  const deadlineAt = new Date(deadlineMs).toISOString()
  const nowMs = resolveNowMs(now)
  const fires = nowMs >= deadlineMs
  return { fires, deadline_at: deadlineAt, reason: fires ? 'fires' : 'timer-active' }
}

/**
 * Compute the A2 (awaiting-approval) deadline for a run-state record. The
 * deadline is persisted at fresh emit (slice 2d-W); this helper never derives
 * it from wall-clock — `now` is only used for the firing comparison.
 *
 * @param {{ state: string, deadline_at: string|null }} run
 * @param {number|string} now
 * @returns {{
 *   fires: boolean,
 *   deadline_at: string|null,
 *   reason: 'fires'|'timer-active'|'not-awaiting-approval'|'no-deadline'|'invalid-deadline',
 * }}
 */
export function computeA2Deadline(run, now) {
  if (!run || run.state !== 'awaiting_approval') {
    return { fires: false, deadline_at: null, reason: 'not-awaiting-approval' }
  }
  if (typeof run.deadline_at !== 'string' || run.deadline_at.length === 0) {
    return { fires: false, deadline_at: null, reason: 'no-deadline' }
  }
  const deadlineMs = Date.parse(run.deadline_at)
  if (Number.isNaN(deadlineMs)) {
    return { fires: false, deadline_at: run.deadline_at, reason: 'invalid-deadline' }
  }
  const nowMs = resolveNowMs(now)
  const fires = nowMs >= deadlineMs
  return { fires, deadline_at: run.deadline_at, reason: fires ? 'fires' : 'timer-active' }
}

/**
 * Evaluate deadlines across all runs in a run-state index `runs` map. For
 * runs with `state === 'awaiting_approval'`, A2 is computed from run-state
 * itself. For runs with `state === 'codex_review'`, the caller MUST supply
 * the most-recent entry's data via `runEntryDataMap[run_id] =
 * { requested_at, request_sent }`; otherwise the run is reported as
 * `fires:false, reason:'no-entry-data'`.
 *
 * Runs in any other state are skipped (not present in the output).
 *
 * @param {Record<string, { state: string, deadline_at?: string|null }>} runs
 * @param {Record<string, { requested_at: string|null, request_sent: boolean }>} runEntryDataMap
 * @param {number|string} now
 * @returns {Array<{
 *   run_id: string,
 *   type: 'A1'|'A2',
 *   fires: boolean,
 *   deadline_at: string|null,
 *   reason: string,
 * }>}
 */
export function evaluateDeadlines(runs, runEntryDataMap, now) {
  const out = []
  const entryMap = runEntryDataMap || {}
  for (const [runId, run] of Object.entries(runs || {})) {
    if (!run || typeof run !== 'object') continue
    if (run.state === 'awaiting_approval') {
      const a2 = computeA2Deadline(run, now)
      out.push({ run_id: runId, type: 'A2', ...a2 })
    } else if (run.state === 'codex_review') {
      const entry = entryMap[runId]
      if (!entry) {
        out.push({
          run_id: runId,
          type: 'A1',
          fires: false,
          deadline_at: null,
          reason: 'no-entry-data',
        })
        continue
      }
      const a1 = computeA1FromCodexReviewEntry(entry, now)
      out.push({ run_id: runId, type: 'A1', ...a1 })
    }
  }
  return out
}

/**
 * Filter a list of evaluated deadlines to only those that fire. Convenience
 * for callers that don't need the skipped-run rationale strings.
 *
 * @param {ReturnType<typeof evaluateDeadlines>} evaluated
 * @returns {ReturnType<typeof evaluateDeadlines>}
 */
export function pickFiredDeadlines(evaluated) {
  return (evaluated || []).filter(e => e && e.fires === true)
}
