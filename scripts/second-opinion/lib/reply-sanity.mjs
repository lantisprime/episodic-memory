/**
 * reply-sanity.mjs — Pre-persistence sanity gate for provider replies.
 *
 * Issue #538: a provider that exits 0 while emitting its own interactive
 * bootstrap prompt (e.g. "Load session_handoff.md from ...? (y/n)") had its
 * output persisted verbatim as a review reply with status ok. The harness
 * inspected only exit-status-shaped fields, never the body.
 *
 * This module is a pure predicate: no I/O, no throwing, no dependencies.
 * The harness calls it in runDispatch before any storage write.
 *
 * Ordering rule (REQ-3): a body carrying the fenced
 * json:second-opinion-summary block is ALWAYS sane, regardless of length —
 * the fence is the compliance signal, so a valid terse review is never
 * rejected for brevity.
 */

export const DEFAULT_MIN_REPLY_CHARS = 200

// Byte-identical to consensus.mjs FENCE_RE; duplicated to keep this module
// dependency-free. consensus.mjs stays authoritative for verdict parsing.
const FENCE_RE = /```json:second-opinion-summary\s*\n([\s\S]*?)\n```/

/**
 * @param {*} body — provider stdout, untrusted, any type
 * @param {{minChars?: number}} [opts]
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}}
 */
export function checkReplySanity(body, opts = {}) {
  const minChars = opts.minChars === undefined ? DEFAULT_MIN_REPLY_CHARS : opts.minChars

  if (typeof body !== 'string') {
    return {
      ok: false,
      reason: 'reply-not-string',
      detail: `typeof body is ${typeof body}`,
    }
  }

  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: 'reply-empty',
      detail: 'reply body is empty or whitespace-only',
    }
  }

  if (FENCE_RE.test(body)) {
    return { ok: true }
  }

  if (trimmed.length < minChars) {
    return {
      ok: false,
      reason: 'reply-too-short-no-summary',
      detail: `reply is ${trimmed.length} chars with no fenced json:second-opinion-summary block (floor ${minChars})`,
    }
  }

  return { ok: true }
}
