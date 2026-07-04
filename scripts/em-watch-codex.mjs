#!/usr/bin/env node
/**
 * em-watch-codex.mjs — Poll project-local episodic memory for new Codex replies.
 *
 * Usage:
 *   node em-watch-codex.mjs [--scope local|global|all] [--since <id>]
 *                           [--no-update] [--project-root <path>] [--limit <n>]
 *
 * Outputs JSON: { status, count, episodes, scopes_queried,
 *                 cursor_updated, previous: {local, global},
 *                 new: {local, global}, [warning] }
 *
 * Scope semantics: scopes are independent. --scope all reads both with
 * separate cursors; no implicit fallback. Default is local (directed-watcher
 * semantics — diverges from em-list.mjs default of "all" deliberately).
 *
 * Cursor: <store>/state/codex-watcher.json with shape {local: <id>, global: <id>}.
 * Episode IDs are total-ordered (`YYYYMMDD-HHMMSS-<slug>-<hash>`), used directly
 * as a high-water mark — no wall-clock timestamp comparison.
 *
 * Cursor invariant: advance only to max-id of returned episodes, never to
 * max-id of scanned episodes. Partial-line reads of index.jsonl skip via
 * try/catch and never advance the cursor past them.
 *
 * Tag match: tag in {codex, codex-review, codex-reply}. No summary-prefix
 * fallback (foot-gun: real episodes carry both `claude` and `codex` tags).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const TAG_ALIASES = ['codex', 'codex-review', 'codex-reply']
const VALID_SCOPES = ['local', 'global', 'all']

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-watch-codex.mjs', usage: 'node em-watch-codex.mjs [--scope local|global|all] [--since <id>] [--no-update] [--project-root <path>] [--limit <n>]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const v = argv[i + 1]
  if (i + 1 >= argv.length || (typeof v === 'string' && v.startsWith('--'))) {
    fail(`Flag ${name} requires a value.`)
  }
  return v
}

function fail(message, code = 2) {
  console.log(JSON.stringify({ status: 'error', message }))
  process.exit(code)
}

const scope = flag('--scope') || 'local'
if (!VALID_SCOPES.includes(scope)) {
  fail(`Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}`)
}

const since = flag('--since')
// Episode id grammar: YYYYMMDD-HHMMSS-<slug>-<4hex>
const ID_REGEX = /^\d{8}-\d{6}-[a-z0-9-]+-[a-f0-9]{4}$/
if (since !== undefined && !ID_REGEX.test(since)) {
  fail(`Invalid --since "${since}". Must be an episode id (YYYYMMDD-HHMMSS-<slug>-<hash>).`)
}

const noUpdate = argv.includes('--no-update')
const projectRootFlag = flag('--project-root')
const limit = parseInt(flag('--limit') || '50', 10)

// ---------------------------------------------------------------------------
// Walk up to find the canonical project-local store. Stop before HOME — the
// global store at `~/.episodic-memory/` would otherwise be mistaken for a
// local project root if cwd is anywhere under HOME.
//
// Uses fs.realpathSync to canonicalize paths because on macOS /tmp is
// symlinked to /private/tmp, so process.cwd() and os.homedir() can differ
// by prefix even when they reference the same physical directory.
// ---------------------------------------------------------------------------
function canonical(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

function findLocalStore(startDir) {
  const home = canonical(os.homedir())
  let dir = canonical(startDir)
  while (true) {
    if (dir === home) return null
    const candidate = path.join(dir, '.episodic-memory', 'index.jsonl')
    if (fs.existsSync(candidate)) return path.join(dir, '.episodic-memory')
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const resolvedLocal = projectRootFlag
  ? path.join(path.resolve(projectRootFlag), '.episodic-memory')
  : findLocalStore(process.cwd())
const LOCAL_DIR = resolvedLocal || path.join(process.cwd(), '.episodic-memory')
// Track whether LOCAL_DIR was actually discovered. When false, we refuse to
// write the cursor file — otherwise --scope global from outside any project
// would silently materialize <cwd>/.episodic-memory/state/.
const HAS_LOCAL_STORE = projectRootFlag !== undefined
  || findLocalStore(process.cwd()) !== null
const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')

const SCOPES_QUERIED =
  scope === 'all' ? ['local', 'global'] :
  scope === 'local' ? ['local'] : ['global']

const dirForScope = (s) => (s === 'local' ? LOCAL_DIR : GLOBAL_DIR)

// ---------------------------------------------------------------------------
// Cursor: <local-store>/state/codex-watcher.json
//   { local: <id>|null, global: <id>|null }
// Cursor file lives in the LOCAL store regardless of which scope is queried.
// Local store doubles as the project's stateful surface; global is intentionally
// kept stateless from this script's perspective.
// ---------------------------------------------------------------------------
const CURSOR_FILE = path.join(LOCAL_DIR, 'state', 'codex-watcher.json')

function loadCursor() {
  try {
    const raw = fs.readFileSync(CURSOR_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      local: typeof parsed.local === 'string' ? parsed.local : null,
      global: typeof parsed.global === 'string' ? parsed.global : null,
    }
  } catch {
    return { local: null, global: null }
  }
}

function saveCursor(cursor) {
  const dir = path.dirname(CURSOR_FILE)
  fs.mkdirSync(dir, { recursive: true })
  // Unique tmp filename per call so concurrent writers don't race on rename:
  // without per-process suffix, A's renameSync moves the shared tmp away,
  // then B's renameSync ENOENTs.
  const tmp = `${CURSOR_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, JSON.stringify(cursor, null, 2), 'utf8')
  fs.renameSync(tmp, CURSOR_FILE)
}

// ---------------------------------------------------------------------------
// Index loading: parse each line, skip parse failures (handles partial writes
// during concurrent em-store appends).
// ---------------------------------------------------------------------------
function loadIndex(dataDir) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  const out = []
  const raw = fs.readFileSync(indexFile, 'utf8')
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // partial write or corruption — skip; cursor will not advance past it
    }
  }
  return out
}

function loadTagsIndex(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'tags.json'), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Match: tag-only filter, aliases supported.
// Use tags.json inverted index when available; fall back to linear scan.
// Mirrors em-pattern-health.mjs:140-191 for convention consistency.
// ---------------------------------------------------------------------------
function matchedIdsViaTagsIndex(tagsIdx) {
  if (!tagsIdx) return null
  const ids = new Set()
  for (const alias of TAG_ALIASES) {
    const list = tagsIdx[alias.toLowerCase()]
    if (Array.isArray(list)) for (const id of list) ids.add(id)
  }
  return ids
}

function tagAliasMatched(tags) {
  if (!Array.isArray(tags)) return null
  // Iterate the episode's tags in order so callers can route on the tag the
  // author wrote first (e.g., `[codex-reply, codex]` reports `codex-reply`),
  // rather than always returning TAG_ALIASES[0].
  const aliasSet = new Set(TAG_ALIASES)
  for (const t of tags) {
    const norm = String(t).toLowerCase().trim()
    if (aliasSet.has(norm)) return norm
  }
  return null
}

// ---------------------------------------------------------------------------
// Per-scope query
// ---------------------------------------------------------------------------
function queryScope(scopeName, sinceCursor) {
  const dir = dirForScope(scopeName)
  const tagsIdx = loadTagsIndex(dir)
  const entries = loadIndex(dir)
  const candidateIds = matchedIdsViaTagsIndex(tagsIdx)
  const usedFallback = candidateIds === null

  const matches = []
  for (const e of entries) {
    if (!e || typeof e.id !== 'string') continue
    if (e.status === 'superseded') continue
    if (sinceCursor && e.id <= sinceCursor) continue

    let alias
    if (candidateIds) {
      if (!candidateIds.has(e.id)) continue
      alias = tagAliasMatched(e.tags) || 'codex'
    } else {
      alias = tagAliasMatched(e.tags)
      if (!alias) continue
    }

    matches.push({
      id: e.id,
      date: e.date,
      time: e.time,
      project: e.project,
      category: e.category,
      tags: e.tags,
      summary: e.summary,
      source: scopeName,
      match_reason: `tag:${alias}`,
    })
  }

  // Sort by id ascending — id is total-ordered.
  matches.sort((a, b) => a.id.localeCompare(b.id))

  return { matches, usedFallback, hasIndexFile: fs.existsSync(path.join(dir, 'index.jsonl')) }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const cursorBefore = loadCursor()
const previous = { local: cursorBefore.local, global: cursorBefore.global }
const newCursor = { local: cursorBefore.local, global: cursorBefore.global }

const allMatches = []
let warning = null

for (const s of SCOPES_QUERIED) {
  const sinceForScope = since !== undefined ? since : cursorBefore[s]
  const { matches, usedFallback, hasIndexFile } = queryScope(s, sinceForScope)
  if (usedFallback && hasIndexFile) {
    warning = `tags.json missing for ${s}; used linear scan. Run em-rebuild-index.mjs to regenerate.`
  }
  for (const m of matches) allMatches.push(m)

  // Advance cursor only to max id of *returned* episodes for this scope.
  // Zero-result → no-advance (preserves cursor against partial writes / races).
  if (matches.length > 0) {
    const maxId = matches[matches.length - 1].id
    newCursor[s] = maxId
  }
}

// Dedup across scopes by id (in case of cross-scope copies — local takes priority,
// matching em-list.mjs:48-54 dedupe convention).
const seen = new Set()
const deduped = []
for (const m of allMatches) {
  if (seen.has(m.id)) continue
  seen.add(m.id)
  deduped.push(m)
}
deduped.sort((a, b) => a.id.localeCompare(b.id))
const limited = deduped.slice(0, limit)

const cursorChanged =
  newCursor.local !== cursorBefore.local || newCursor.global !== cursorBefore.global

let cursorUpdated = false
if (!noUpdate && cursorChanged && since === undefined && HAS_LOCAL_STORE) {
  // Only persist when:
  //   - --no-update wasn't passed
  //   - the cursor actually moved
  //   - --since wasn't an explicit override (one-off lookup)
  //   - we found (or were given) a real local store; otherwise refuse to
  //     materialize a phantom .episodic-memory/state/ in cwd
  saveCursor(newCursor)
  cursorUpdated = true
}

const out = {
  status: 'ok',
  count: limited.length,
  episodes: limited,
  scopes_queried: SCOPES_QUERIED,
  cursor_updated: cursorUpdated,
  previous,
  // Always echo the would-be cursor so --no-update callers can preview the
  // advance without persisting it. cursor_updated is the persistence signal.
  new: newCursor,
}
if (warning) out.warning = warning
console.log(JSON.stringify(out))
