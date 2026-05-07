/**
 * bp1-probe.mjs — Scheduled-tasks capability probe (M0 stub, M1 contract pin).
 *
 * RFC-004 §550-577. The orchestrator must probe `mcp__scheduled-tasks` at
 * cold start and record the result in the activation episode. PR-1b-A
 * (M0 part 2) ships this HELPER only; the call site lives in M1's
 * orchestrator runtime.
 *
 * Codex plan-review consensus (round 1 Q3.1): the M0 stub MUST be
 * unambiguously degraded — it must never return capability='native', and the
 * shape must be explicit enough that an M1 swap to the real probe is a
 * surgical change inside this file (not a contract-level edit elsewhere).
 *
 * M1 implementation contract (deferred to issue #185):
 *   - successful list_scheduled_tasks call → { capability: 'native', ... }
 *   - ToolNotFound / connection error / schema mismatch → { capability:
 *     'fallback', reason: 'tool_not_found' | 'connection_error' | 'schema_mismatch' }
 *   - T2 weekly meta-audit has NO fallback path (RFC §573-575): t2_fallback
 *     is always false.
 *   - The activation episode's canonical payload must HMAC-cover all five
 *     fields (capability, reason, native_probe_performed, t2_fallback,
 *     degraded_mode_message). Tampering any field must fail verification.
 */
'use strict'

/**
 * Probe the scheduled-tasks MCP capability.
 *
 * M0 implementation: returns the explicit-fallback shape unconditionally.
 * Does NOT attempt any MCP-from-script call (that pattern is M1 territory
 * via the orchestrator agent).
 *
 * Callers should pass the result into the activation-episode canonical
 * payload AS-IS. Operators reading the activation episode see exactly the
 * degraded-mode statement to follow.
 *
 * @param {object} [_opts] Reserved for M1 (e.g. injected MCP client).
 * @returns {ProbeResult}
 *
 * @typedef {object} ProbeResult
 * @property {'fallback'} capability
 *   M0 always returns 'fallback'. M1 may return 'native' on probe success.
 * @property {string} reason
 *   M0: 'm1_not_implemented'. M1: 'list_succeeded' | 'tool_not_found' |
 *   'connection_error' | 'schema_mismatch'.
 * @property {false} native_probe_performed
 *   M0 always false. M1 sets true iff list_scheduled_tasks was actually
 *   invoked (regardless of success/failure outcome).
 * @property {false} t2_fallback
 *   ALWAYS false. RFC §573-575: T2 weekly meta-audit has no fallback path.
 *   Operators must run `node scripts/bp1-security-audit.mjs --once`
 *   manually when capability='fallback'.
 * @property {string} degraded_mode_message
 *   Operator-facing instructions for fallback mode. Surfaced verbatim in
 *   the activation episode body and in the operator runbook.
 */
export function probeScheduledTasksCapability(_opts) {
  return {
    capability: 'fallback',
    reason: 'm1_not_implemented',
    native_probe_performed: false,
    t2_fallback: false,
    degraded_mode_message: DEGRADED_MODE_MESSAGE,
  }
}

export const DEGRADED_MODE_MESSAGE =
  'Scheduled-tasks native probe is pending M1 (orchestrator runtime). ' +
  'BP-1 will run T1 (deadline-tick) and T1b (naked-entry-sweep) via the ' +
  '`bp1-deadline-sweep.mjs --once` fallback script (auto-wired as a ' +
  'SessionStart hook in PR-1b-B). T2 (weekly security audit) has NO ' +
  'fallback path — operators must run `node scripts/bp1-security-audit.mjs ' +
  '--once` manually on the weekly cadence until M1 ships.'

// ---------------------------------------------------------------------------
// M1 contract assertions — exported so that M1's test harness can verify
// the real implementation conforms to the same shape the M0 stub published.
// Tests in tests/test-bp1-probe.mjs pin both the M0 stub AND these contract
// expectations so M1 cannot silently break the activation-episode schema.
// ---------------------------------------------------------------------------

export const VALID_CAPABILITIES = Object.freeze(['native', 'fallback'])

export const VALID_REASONS_M1 = Object.freeze([
  'list_succeeded',     // capability=native
  'tool_not_found',     // capability=fallback
  'connection_error',   // capability=fallback
  'schema_mismatch',    // capability=fallback
  'm1_not_implemented', // capability=fallback (M0 stub only)
])

/**
 * Validate a probe-result shape against the contract.
 *
 * Returns { ok: true } or { ok: false, errors: [...] }. M1's test harness
 * uses this to assert the real probe still conforms.
 */
export function validateProbeResult(result) {
  const errors = []
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, errors: ['result must be an object'] }
  }
  if (!VALID_CAPABILITIES.includes(result.capability)) {
    errors.push(`capability must be one of ${VALID_CAPABILITIES.join('|')}; got ${JSON.stringify(result.capability)}`)
  }
  if (typeof result.reason !== 'string' || !VALID_REASONS_M1.includes(result.reason)) {
    errors.push(`reason must be one of ${VALID_REASONS_M1.join('|')}; got ${JSON.stringify(result.reason)}`)
  }
  if (typeof result.native_probe_performed !== 'boolean') {
    errors.push('native_probe_performed must be boolean')
  }
  if (result.t2_fallback !== false) {
    errors.push('t2_fallback must be false (RFC §573-575: T2 has no fallback)')
  }
  if (typeof result.degraded_mode_message !== 'string' || result.degraded_mode_message.length === 0) {
    errors.push('degraded_mode_message must be a non-empty string')
  }
  // Cross-field: capability=native must coincide with reason=list_succeeded
  // and native_probe_performed=true.
  if (result.capability === 'native') {
    if (result.reason !== 'list_succeeded') {
      errors.push("capability=native requires reason='list_succeeded'")
    }
    if (result.native_probe_performed !== true) {
      errors.push('capability=native requires native_probe_performed=true')
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}
