/**
 * bp1-install-helpers.mjs — Pure helpers for BP-1 install.mjs settings.json
 * wiring (PR-1b-B / RFC-004 §559 H-cfg).
 *
 * Zero I/O. install.mjs is the call site that reads/writes settings.json via
 * its existing writeJSONAtomic helper. install.mjs's `migrateMalformedEntries`
 * (install.mjs:343) and `detectStaleCanonicalEntries` (:375) handle R4
 * (wrong-shape migration) and R6 (stale-canonical-path warning) — this lib
 * does NOT reinvent those paths.
 *
 * Tracked by manifest's `scripts_lib` surface (PR-1a) — automatic drift
 * coverage on changes.
 */

/**
 * Deep-clones a JSON-safe object. Used by mergeSessionStartH2Hook to prove
 * invariant I2 (input not mutated).
 */
export function deepClone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj))
}

/**
 * Ensures settings.hooks.SessionStart exists as an array. MUTATES input.
 * Used internally by mergeSessionStartH2Hook AFTER deep-cloning.
 */
export function ensureSessionStartArray(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = []
  return settings.hooks.SessionStart
}

/**
 * Builds the canonical H2 command string for a given hook script path.
 * Mirrors install.mjs's pattern: `bash <quoted-path>`.
 */
export function makeH2Command(hookPath) {
  return `bash ${shellQuote(hookPath)}`
}

/**
 * Idempotent merge of the H2 SessionStart hook into a settings JSON object.
 *
 * §559 ordering interpretation: H2 is appended to the END of SessionStart.
 * M2 (future PR) inserts H1 just-before this H2 entry — that is, H2's
 * relative position is preserved across M0-part-2 → M2 transitions, and
 * unrelated SessionStart entries are NOT reordered.
 *
 * Returns { settings, changed, reason }:
 *   - settings: NEW object (input never mutated — invariant I2).
 *   - changed: true iff a new entry was appended.
 *   - reason: "h2-added" | "h2-already-present".
 */
export function mergeSessionStartH2Hook(existingSettings, hookPath, options = {}) {
  const timeout = typeof options.timeout === 'number' ? options.timeout : 30
  const command = makeH2Command(hookPath)
  const settings = deepClone(existingSettings || {})
  const arr = ensureSessionStartArray(settings)
  if (arr.some(e => entryHasExactCommand(e, command))) {
    return { settings, changed: false, reason: 'h2-already-present' }
  }
  arr.push({ hooks: [{ type: 'command', command, timeout }] })
  return { settings, changed: true, reason: 'h2-added' }
}

/**
 * Predicate: does the SessionStart array contain an entry whose command
 * matches the H2 hook (after normalize-shell-quoting)?
 */
export function containsSessionStartH2Hook(settings, hookPath) {
  const arr = settings?.hooks?.SessionStart
  if (!Array.isArray(arr)) return false
  const command = makeH2Command(hookPath)
  return arr.some(e => entryHasExactCommand(e, command))
}

// ---------------------------------------------------------------------------
// Internal helpers — duplicated from install.mjs to keep this lib I/O-free
// and dependency-free. (install.mjs's helpers are not exported; refactoring
// install.mjs to expose them is out of scope for PR-1b-B.)
// ---------------------------------------------------------------------------

function entryHasExactCommand(entry, command) {
  const target = normalizeCommand(command)
  if (entry?.command && normalizeCommand(entry.command) === target) return true
  if (Array.isArray(entry?.hooks)) {
    return entry.hooks.some(h => h && normalizeCommand(h.command) === target)
  }
  return false
}

function normalizeCommand(s) {
  if (typeof s !== 'string') return s
  if (s.length > 1 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/'\\''/g, "'")
  }
  const m = s.match(/^(.*\s)'((?:[^']|'\\'')+)'$/)
  if (m) return m[1] + m[2].replace(/'\\''/g, "'")
  return s
}

function shellQuote(s) {
  if (/^[A-Za-z0-9_\-./:=,]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}
