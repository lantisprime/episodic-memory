/**
 * bp1-frontmatter.mjs — Strict, fail-closed BP-1 frontmatter parser
 * (RFC-004 §753-771, M1 finalize/replay).
 *
 * Single source of truth for parsing BP-1 episode frontmatter on the read
 * side (manifest verification, finalize collection). Distinct from the
 * permissive parsers scattered across em-search/em-rebuild-index/em-restore;
 * those are read-anything-tolerable, this is fail-closed for security paths.
 *
 * Round-2 codex consensus (episode 20260508-112437-...-4b9f):
 *   - duplicate keys → throw
 *   - non-UTF-8 → throw
 *   - malformed key lines → throw
 *   - missing fences → throw
 *   - type mismatches preserved (string vs bool vs null vs array)
 *   - body split preserved verbatim
 *
 * Round-trip invariant: the parser is paired with bp1-orchestrator's
 * `buildEpisodeFile` writer (scripts/bp1-orchestrator.mjs:175-202). For any
 * frontmatter object W produced by the writer, parse(write(W)) must yield
 * an equivalent object up to the declared type set.
 */

// Recognized scalar value forms in BP-1 frontmatter:
//   1. JSON-quoted string:  "..."  (escapes per JSON)
//   2. null literal:        null
//   3. boolean literals:    true | false
//   4. tag-array literal:   [a, b, c]  (bare comma-separated tokens)
//   5. bare value:          <token>    (used for id, type, run_id, etc.)
//
// We do NOT accept numeric values: BP-1 frontmatter has no numeric fields.
// Adding one would require a parser change AND a writer change — fail-closed
// by default rejects any future drift here.

const FENCE = '---'

function isUtf8Encodable(s) {
  // The string is already a JS string (UTF-16 codepoints). Round-trip through
  // utf-8 to ensure no lone surrogates that would corrupt the canonical form.
  try {
    const buf = Buffer.from(s, 'utf8')
    return buf.toString('utf8') === s
  } catch {
    return false
  }
}

const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

function parseValue(raw, key, lineNo) {
  const v = raw.trim()
  if (v === 'null') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (v.startsWith('"')) {
    // JSON-quoted string. Use JSON.parse for full escape-sequence support.
    try {
      const parsed = JSON.parse(v)
      if (typeof parsed !== 'string') {
        throw new Error(`expected string for key ${key} at line ${lineNo}, got ${typeof parsed}`)
      }
      return parsed
    } catch (e) {
      throw new Error(`malformed JSON-quoted string for key ${key} at line ${lineNo}: ${e.message}`)
    }
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    // Bare-token array, e.g. [a, b, c]. No nested arrays, no quoted elements.
    const inner = v.slice(1, -1).trim()
    if (inner === '') return []
    const parts = inner.split(',').map(s => s.trim())
    for (const p of parts) {
      if (p === '') {
        throw new Error(`empty array element for key ${key} at line ${lineNo}`)
      }
      if (/[\[\]"']/.test(p)) {
        throw new Error(`array element must be a bare token for key ${key} at line ${lineNo}: ${p}`)
      }
    }
    return parts
  }
  // Bare value: must be a single non-empty token with no internal whitespace.
  if (v === '') {
    throw new Error(`empty value for key ${key} at line ${lineNo}`)
  }
  if (/\s/.test(v)) {
    throw new Error(`bare value must not contain whitespace for key ${key} at line ${lineNo}: ${v}`)
  }
  return v
}

/**
 * Parse a BP-1 episode file (frontmatter + body).
 *
 * Accepts Buffer or string. Buffer input is decoded with a fatal UTF-8 decoder
 * (round-1 codex code-review MAJOR: invalid UTF-8 bytes from `fs.readFileSync(p, 'utf8')`
 * silently normalize to U+FFFD; reading the file as a Buffer and decoding here
 * with `fatal: true` makes the read path truly fail-closed).
 *
 * @param {string|Buffer|Uint8Array} input — full file contents
 * @returns {{frontmatter: object, body: string}}
 * @throws {Error} on any malformed input (fail-closed)
 */
export function parseBp1Frontmatter(input) {
  let text
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    try {
      text = STRICT_UTF8_DECODER.decode(input)
    } catch (e) {
      throw new Error(`parseBp1Frontmatter: invalid UTF-8 in input bytes: ${e.message}`)
    }
  } else if (typeof input === 'string') {
    text = input
  } else {
    throw new TypeError('parseBp1Frontmatter: input must be string, Buffer, or Uint8Array')
  }
  if (!isUtf8Encodable(text)) {
    throw new Error('parseBp1Frontmatter: input contains lone surrogates / non-UTF-8 sequences')
  }
  const lines = text.split('\n')
  if (lines.length < 2 || lines[0] !== FENCE) {
    throw new Error('parseBp1Frontmatter: missing opening --- fence')
  }
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) { closeIdx = i; break }
  }
  if (closeIdx === -1) {
    throw new Error('parseBp1Frontmatter: missing closing --- fence')
  }
  const frontmatter = {}
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]
    if (line === '') {
      throw new Error(`parseBp1Frontmatter: blank line inside frontmatter at line ${i + 1}`)
    }
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      throw new Error(`parseBp1Frontmatter: malformed key line (no colon) at line ${i + 1}: ${line}`)
    }
    const key = line.slice(0, colonIdx).trim()
    if (key === '' || /[\s"]/.test(key)) {
      throw new Error(`parseBp1Frontmatter: malformed key at line ${i + 1}: ${JSON.stringify(line)}`)
    }
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      throw new Error(`parseBp1Frontmatter: duplicate key "${key}" at line ${i + 1}`)
    }
    frontmatter[key] = parseValue(line.slice(colonIdx + 1), key, i + 1)
  }
  // Body: everything after the closing fence. Writer emits one '\n' between
  // closing fence and body, so we drop exactly one leading newline if present
  // (preserves a deliberately-empty leading line in the body).
  const body = lines.slice(closeIdx + 1).join('\n').replace(/^\n/, '')
  return { frontmatter, body }
}
