/**
 * session-id.mjs — Shared session-id validation.
 *
 * Extracted from scripts/preflight-marker-write.mjs for reuse by
 * scripts/plan-marker.mjs (#268 fix). Both helpers need identical
 * session-id validation semantics; centralizing prevents drift.
 *
 * Char-class: [A-Za-z0-9_-], length 1..128. No dots (could collide
 * with `.json` suffix in last-user-prompt files), no slashes (path
 * traversal). Claude Code session IDs are UUIDs (hyphenated hex)
 * which match this regex; other tools using other id shapes must
 * conform.
 *
 * Shell parity: hooks/lib/session-id.sh validate_session_id() must
 * mirror this regex. Drift caught by validate-plan-marker-sites.mjs
 * Direction 0.
 */

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
export const SESSION_ID_CHARCLASS = 'A-Za-z0-9_-'
export const SESSION_ID_MIN_LEN = 1
export const SESSION_ID_MAX_LEN = 128

/**
 * Returns true iff sid is a valid session-id (non-empty string matching
 * the char-class + length bounds). Use this in helper scripts before
 * constructing per-session marker paths.
 *
 * @param {unknown} sid
 * @returns {boolean}
 */
export function validateSessionId(sid) {
  return typeof sid === 'string' && SESSION_ID_RE.test(sid)
}
