/**
 * consensus.mjs — Verdict parsing + consensus-loop stop-condition logic.
 *
 * v3 §Consensus-loop v3 contract:
 *   Reply body MUST end with fenced JSON block:
 *     ```json:second-opinion-summary
 *     {
 *       "final_verdict": "ACCEPT" | "ACCEPT-with-FU" | "HOLD" | "REJECT",
 *       "findings": [
 *         {"id", "class", "severity": "P1"|"P2"|"P3", "status": "ACCEPT-OK"|...}
 *       ],
 *       "spec_cycle_signal": null | "trigger-met"
 *     }
 *     ```
 *   Verdict text line is informational; JSON is authoritative.
 *
 * Critical guard (per v3.2 + lesson `...0158` enshrined in consensus.mjs):
 *   NEVER auto-convert P1/P2 or NEEDS-MORE-WORK / NEW-CONCERN to success,
 *   regardless of round count or spec_cycle_signal.
 *
 * Stop conditions table:
 *   ACCEPT                                            → success (verdict-accept)
 *   ACCEPT-with-FU AND every status ∈ {ACCEPT-OK, DEFERRED-AS-FU} AND no P1
 *                                                     → success with FU appendix
 *   ACCEPT-with-FU BUT P1/NEEDS-MORE-WORK/NEW-CONCERN → accept-with-fu-malformed
 *   REJECT                                            → fail (verdict-reject)
 *   HOLD + --rebuttal-cb                              → loop next round
 *   HOLD + no --rebuttal-cb                           → human-review-required (exit 0 with flag)
 *   round == --max-rounds                             → cap-reached (NEVER auto-success)
 *   spec_cycle_signal: trigger-met                    → spec-cycle-stop (NEVER auto-success
 *                                                       unless --force-spec-cycle-accept AND
 *                                                       all remaining findings satisfy
 *                                                       ACCEPT-with-FU criteria)
 */

const FENCE_RE = /```json:second-opinion-summary\s*\n([\s\S]*?)\n```/

/**
 * Extract and parse the fenced JSON block from a reply body.
 * Returns the parsed object or throws { code: 'verdict-parse-failed', detail }.
 */
export function parseVerdict(replyBody) {
  if (typeof replyBody !== 'string' || replyBody.length === 0) {
    const err = new Error('Reply body is empty')
    err.code = 'verdict-parse-failed'
    err.detail = 'empty body'
    throw err
  }
  const match = FENCE_RE.exec(replyBody)
  if (!match) {
    const err = new Error('Reply body missing fenced ```json:second-opinion-summary block')
    err.code = 'verdict-parse-failed'
    err.detail = 'no fence'
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(match[1])
  } catch (e) {
    const err = new Error(`JSON parse failed inside fenced block: ${e.message}`)
    err.code = 'verdict-parse-failed'
    err.detail = e.message
    throw err
  }
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('Verdict JSON is not an object')
    err.code = 'verdict-parse-failed'
    err.detail = 'not object'
    throw err
  }
  if (!parsed.final_verdict) {
    const err = new Error('Verdict JSON missing final_verdict field')
    err.code = 'verdict-parse-failed'
    err.detail = 'no final_verdict'
    throw err
  }
  return parsed
}

/**
 * Apply the v3 §Consensus-loop v3 stop conditions.
 *
 * Args: {
 *   verdict: parsed verdict object (from parseVerdict),
 *   round: current round number (1-indexed),
 *   maxRounds: --max-rounds value,
 *   hasRebuttalCb: boolean,
 *   forceSpecCycleAccept: boolean,
 * }
 *
 * Returns: {
 *   stop: boolean,
 *   success: boolean,
 *   stopReason: string,                      // e.g., 'verdict-accept'
 *   exitCode: 0 | 1,
 *   fuAppendix?: array,                      // for ACCEPT-with-FU success
 *   nextAction: 'loop' | 'stop',
 * }
 */
export function applyStopCondition({
  verdict, round, maxRounds, hasRebuttalCb, forceSpecCycleAccept,
}) {
  const v = verdict.final_verdict
  const findings = Array.isArray(verdict.findings) ? verdict.findings : []
  const specCycleSignal = verdict.spec_cycle_signal === 'trigger-met'

  // ACCEPT — clean success.
  if (v === 'ACCEPT') {
    return {
      stop: true, success: true,
      stopReason: 'verdict-accept', exitCode: 0,
      nextAction: 'stop',
    }
  }

  // REJECT — fail.
  if (v === 'REJECT') {
    return {
      stop: true, success: false,
      stopReason: 'verdict-reject', exitCode: 1,
      nextAction: 'stop',
    }
  }

  // ACCEPT-with-FU — only succeeds if all findings are ACCEPT-OK or
  // DEFERRED-AS-FU AND no P1. Critical guard per lesson `...0158`.
  if (v === 'ACCEPT-with-FU') {
    const validStatuses = findings.every((f) =>
      f.status === 'ACCEPT-OK' || f.status === 'DEFERRED-AS-FU')
    const hasP1 = findings.some((f) => f.severity === 'P1')

    if (validStatuses && !hasP1) {
      const fuAppendix = findings.filter((f) => f.status === 'DEFERRED-AS-FU')
      return {
        stop: true, success: true,
        stopReason: 'verdict-accept-with-fu', exitCode: 0,
        fuAppendix,
        nextAction: 'stop',
      }
    }
    // Malformed ACCEPT-with-FU — has P1 OR NEEDS-MORE-WORK / NEW-CONCERN.
    return {
      stop: true, success: false,
      stopReason: 'accept-with-fu-malformed', exitCode: 1,
      nextAction: 'stop',
    }
  }

  // spec-cycle-stop — checked BEFORE HOLD-loop because the signal must take
  // precedence (v3 plan: NEVER auto-success on signal regardless of verdict).
  // Only succeeds if forceSpecCycleAccept AND all findings satisfy
  // ACCEPT-with-FU criteria (no P1, no P2).
  if (specCycleSignal) {
    if (forceSpecCycleAccept) {
      const validStatuses = findings.every((f) =>
        f.status === 'ACCEPT-OK' || f.status === 'DEFERRED-AS-FU')
      const hasP1 = findings.some((f) => f.severity === 'P1')
      const hasP2 = findings.some((f) => f.severity === 'P2')
      if (validStatuses && !hasP1 && !hasP2) {
        const fuAppendix = findings.filter((f) => f.status === 'DEFERRED-AS-FU')
        return {
          stop: true, success: true,
          stopReason: 'spec-cycle-stop-forced-accept', exitCode: 0,
          fuAppendix,
          nextAction: 'stop',
        }
      }
    }
    return {
      stop: true, success: false,
      stopReason: 'spec-cycle-stop', exitCode: 1,
      nextAction: 'stop',
    }
  }

  // HOLD — depends on rebuttal callback.
  if (v === 'HOLD') {
    if (hasRebuttalCb) {
      // Check round cap BEFORE looping.
      if (round >= maxRounds) {
        return {
          stop: true, success: false,
          stopReason: 'cap-reached-no-success', exitCode: 1,
          nextAction: 'stop',
        }
      }
      return {
        stop: false, success: false,
        stopReason: 'hold-loop-next', exitCode: 0,
        nextAction: 'loop',
      }
    }
    // No rebuttal callback — return reply for human review.
    return {
      stop: true, success: false,
      stopReason: 'human-review-required', exitCode: 0,
      nextAction: 'stop',
    }
  }

  // Unknown verdict.
  return {
    stop: true, success: false,
    stopReason: 'unknown-verdict',
    exitCode: 1,
    nextAction: 'stop',
  }
}

/**
 * Summarize findings by severity + status for round-summary output.
 */
export function summarizeFindings(findings) {
  const counts = { P1: 0, P2: 0, P3: 0 }
  const statusCounts = {
    'ACCEPT-OK': 0, 'NEEDS-MORE-WORK': 0, 'NEW-CONCERN': 0, 'DEFERRED-AS-FU': 0,
  }
  for (const f of findings || []) {
    if (f.severity && counts[f.severity] !== undefined) counts[f.severity]++
    if (f.status && statusCounts[f.status] !== undefined) statusCounts[f.status]++
  }
  return { severity: counts, status: statusCounts }
}
