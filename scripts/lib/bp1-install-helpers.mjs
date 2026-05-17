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
 * Builds the canonical H1 command string. Shape-identical to H2 — same
 * `bash <quoted-path>` form. The distinction between H1 / H2 is the
 * basename and the placement order, not the command shape.
 */
export function makeH1Command(hookPath) {
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

/**
 * Idempotent merge of the H1 SessionStart hook into a settings JSON object.
 *
 * Slice 2d-R / PR-2d-R. Inserts H1 (approval-check) into SessionStart with
 * splice-before-H2 semantics:
 *
 *   - If an H2 entry exists (any path that matches the basename
 *     `bp1-sweep-on-session.sh`), insert H1 at that index. H2 shifts down
 *     by one. RFC §559 H-cfg ordering invariant: approval-check FIRST,
 *     sweep SECOND, relative to each other (not absolute SessionStart[0]).
 *   - If no H2 entry exists, append H1 to the END of SessionStart. The
 *     subsequent H2 install (if it runs in the same install pass) will
 *     append after H1, preserving the relative order.
 *   - If an H1 entry already exists (exact command match after
 *     normalize-shell-quoting), no-op (reason: 'h1-already-present').
 *
 * Returns { settings, changed, reason }:
 *   - settings: NEW object (input never mutated — invariant I2).
 *   - changed: true iff a new entry was inserted.
 *   - reason: 'h1-inserted-before-h2' | 'h1-appended' | 'h1-already-present'.
 *
 * @param {object} existingSettings
 * @param {string} h1HookPath — canonical absolute path to bp1-approval-check.sh
 * @param {string} h2HookPath — canonical absolute path to bp1-sweep-on-session.sh
 *                              (used only for index lookup; H2 itself is not
 *                              installed/migrated by this helper)
 * @param {object} options { timeout?: number }
 */
export function mergeSessionStartH1Hook(existingSettings, h1HookPath, h2HookPath, options = {}) {
  const timeout = typeof options.timeout === 'number' ? options.timeout : 30
  const h1Command = makeH1Command(h1HookPath)
  const settings = deepClone(existingSettings || {})
  const arr = ensureSessionStartArray(settings)
  if (arr.some(e => entryHasExactCommand(e, h1Command))) {
    return { settings, changed: false, reason: 'h1-already-present' }
  }
  const entry = { hooks: [{ type: 'command', command: h1Command, timeout }] }
  // Splice-before-H2 by basename match (any path bearing the canonical H2
  // basename qualifies — install may have wired H2 at a different path in a
  // prior run; we still want H1 to precede it).
  const h2Basename = 'bp1-sweep-on-session.sh'
  const h2Index = arr.findIndex(e => entryReferencesBasename(e, h2Basename))
  if (h2Index >= 0) {
    arr.splice(h2Index, 0, entry)
    return { settings, changed: true, reason: 'h1-inserted-before-h2' }
  }
  arr.push(entry)
  return { settings, changed: true, reason: 'h1-appended' }
}

/**
 * Predicate: does the SessionStart array contain an entry whose command
 * matches the H1 hook (after normalize-shell-quoting)?
 */
export function containsSessionStartH1Hook(settings, hookPath) {
  const arr = settings?.hooks?.SessionStart
  if (!Array.isArray(arr)) return false
  const command = makeH1Command(hookPath)
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

/**
 * Predicate: does the entry's command reference a given hook basename
 * anywhere in its path? Used by mergeSessionStartH1Hook to locate the
 * existing H2 entry for splice-before insertion regardless of the H2 path
 * it was originally wired with.
 */
function entryReferencesBasename(entry, basename) {
  const test = (cmd) => {
    if (typeof cmd !== 'string') return false
    const normalized = normalizeCommand(cmd)
    return normalized.includes(`/${basename}`) || normalized.endsWith(basename) || normalized.includes(` ${basename}`)
  }
  if (entry?.command && test(entry.command)) return true
  if (Array.isArray(entry?.hooks)) {
    return entry.hooks.some(h => h && test(h.command))
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
