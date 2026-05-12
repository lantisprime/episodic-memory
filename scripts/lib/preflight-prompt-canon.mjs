/**
 * preflight-prompt-canon.mjs — Canonical sha256 of a UserPromptSubmit prompt.
 *
 * The cross-check between `<repo>/.checkpoints/.last-user-prompt.<sid>.json`
 * (written by the UserPromptSubmit hook) and a `codex-review-handoff`
 * pre-flight marker (written by `preflight-marker-write.mjs`) is meaningful
 * ONLY if both sides compute `prompt_sha256` over the same bytes. Without a
 * pinned canonicalization, the hook hashing `JSON.parse(stdin).prompt` and an
 * external constructor hashing the prompt-as-displayed produce different
 * digests; every legitimate marker mismatches; the cross-check is useless.
 *
 * Binding contract:
 *
 *     prompt_sha256 = sha256_hex( utf8_bytes( JSON.parse(stdin).prompt ) )
 *
 * - JSON parse runs first; escape sequences (\n, \t, \uXXXX) are unescaped.
 * - The resulting JS string is encoded as UTF-8 with `Buffer.from(s, 'utf8')`.
 * - No trailing newline is appended.
 * - Surrogate pairs / non-BMP code points encode to 4-byte UTF-8 sequences.
 *
 * Both the hook AND any external constructor (tests, install bootstrap, gate
 * validator) MUST import from this module — no re-implementations.
 *
 * Discovered: plan-time audit finding F3 (`scratch/238-plan-v2.md`) — without
 * this pin, "every legitimate marker would mismatch."
 */

import crypto from 'node:crypto'

/**
 * Hash the prompt extracted from a UserPromptSubmit stdin JSON payload.
 * Throws if the payload is not a JSON object or `.prompt` is not a string.
 *
 * @param {string} stdinJson — raw stdin bytes from the hook
 * @returns {string} 64-char lowercase hex sha256 digest
 */
export function canonicalPromptSha256(stdinJson) {
  if (typeof stdinJson !== 'string') {
    throw new TypeError(`stdinJson must be a string, got ${typeof stdinJson}`)
  }
  let parsed
  try {
    parsed = JSON.parse(stdinJson)
  } catch (e) {
    throw new SyntaxError(`stdin is not valid JSON: ${e.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('stdin JSON must be a non-null object')
  }
  if (typeof parsed.prompt !== 'string') {
    throw new TypeError(`.prompt must be a string, got ${typeof parsed.prompt}`)
  }
  return canonicalPromptSha256FromString(parsed.prompt)
}

/**
 * Hash a prompt string directly. Use when the prompt has already been
 * extracted (tests, install bootstrap that takes prompt as a CLI arg).
 *
 * @param {string} prompt — the prompt text exactly as JSON.parse would yield
 * @returns {string} 64-char lowercase hex sha256 digest
 */
export function canonicalPromptSha256FromString(prompt) {
  if (typeof prompt !== 'string') {
    throw new TypeError(`prompt must be a string, got ${typeof prompt}`)
  }
  return crypto.createHash('sha256').update(Buffer.from(prompt, 'utf8')).digest('hex')
}
