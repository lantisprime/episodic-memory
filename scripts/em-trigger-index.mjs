#!/usr/bin/env node
/**
 * em-trigger-index.mjs — build the derived lesson-activation trigger index (RFC-009 R2).
 *
 * Usage:
 *   node em-trigger-index.mjs [--project <root>] [--scope local|global|all] [--merged]
 *
 * Builds ONE `trigger-index.json` per store from `status: active` lessons that
 * carry `triggers` frontmatter. DATA-plane substrate only: registers no hook,
 * writes nothing under ~/.claude/ (P12); the P2 R4 hook reads the artifact.
 *
 * Store binding (REQ-16/F6): `--project <root>` is a NEW explicit PATH binding —
 * when <root> is an existing directory, the local store is `<root>/.episodic-memory`
 * regardless of caller cwd (a linked worktree cwd converges to its MAIN root via
 * resolveLocalDir, so cwd-based resolution cannot target another project).
 * Without --project, the local store resolves from cwd as every other script.
 *
 * Freshness (REQ-14): lazy build with an mtime+size+sha256 fingerprint computed
 * from the BYTES THE BUILD READ (stat -> read -> re-stat; one re-read on
 * mismatch) — closes the TOCTOU window and the same-size-same-mtime rewrite
 * case. Cache hit (all three match) returns the existing file without a write.
 * Atomic write via a UNIQUE temp name `trigger-index.json.tmp.<pid>.<rand>`
 * (F2: the fixed `.tmp` convention collides when two lazy builds race).
 *
 * Earned band (REQ-13, I1/I3): `effective_priority` is DERIVED here from
 * linked-violation counts (violation-side `lessons` ∪ lesson-side `evidence`,
 * deduped by terminal violation id, chain-resolved in both directions);
 * 0 links -> stored priority (1-7), 1 -> 8, >=2 -> 9. Stored bytes are never
 * mutated; no writer can declare 8-9 (em-store rejects it).
 *
 * Degrade-not-throw (I5): malformed store index rows are skipped; an unreadable
 * activity-class vocab excludes+counts every `activity:` trigger; a failed
 * per-store build inside loadMergedTriggerIndex() degrades to the other store
 * with one stderr note. Build failures never take down a consumer read.
 *
 * Outputs JSON to stdout: { status, built: [{scope, store, entries, cache_hit}] }
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadActivationClasses, parseTriggerKind } from './lib/activation.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')

export const TRIGGER_INDEX_SCHEMA_VERSION = 1
export const TRIGGER_ENTRY_FIELDS = ['trigger_kind', 'value', 'episode_id', 'summary', 'effective_priority', 'applies_to_projects', 'applies_to_tools', 'review_by']
export const TRIGGER_KIND_ENUM = ['phrase', 'tool', 'activity']

// ---------------------------------------------------------------------------
// Store resolution (REQ-16/F6 — a real path binding, NOT the --project name filter)
// ---------------------------------------------------------------------------
export function resolveStoreDir({ project, scope } = {}) {
  if (scope === 'global') return GLOBAL_DIR
  if (project !== undefined) {
    let st = null
    try { st = fs.statSync(project) } catch {}
    if (st && st.isDirectory()) return path.join(project, '.episodic-memory')
  }
  return resolveLocalDir()
}

// ---------------------------------------------------------------------------
// Index rows + fingerprint
// ---------------------------------------------------------------------------
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Read a store's index.jsonl with a TOCTOU-safe fingerprint: stat, read,
 * re-stat; on a stat mismatch re-read ONCE and fingerprint the bytes actually
 * read (REQ-14/EC9). A missing index file fingerprints as the empty store.
 */
function readIndexWithFingerprint(storeDir) {
  const indexPath = path.join(storeDir, 'index.jsonl')
  let st1 = null
  try { st1 = fs.statSync(indexPath) } catch {}
  if (!st1) {
    return { raw: '', fingerprint: { index_mtime_ms: 0, index_size: 0, index_sha256: sha256('') } }
  }
  let raw = fs.readFileSync(indexPath, 'utf8')
  let st2 = null
  try { st2 = fs.statSync(indexPath) } catch {}
  if (!st2 || st2.mtimeMs !== st1.mtimeMs || st2.size !== st1.size) {
    // mid-read rewrite: one re-read, fingerprint what we actually consumed (EC9)
    try { raw = fs.readFileSync(indexPath, 'utf8') } catch { raw = '' }
    try { st2 = fs.statSync(indexPath) } catch { st2 = null }
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  return {
    raw,
    fingerprint: {
      index_mtime_ms: st2 ? st2.mtimeMs : 0,
      index_size: bytes,
      index_sha256: sha256(raw),
    },
  }
}

function parseRows(raw) {
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch {}
  }
  return rows
}

// ---------------------------------------------------------------------------
// Chain resolution + the earned band (REQ-13)
// ---------------------------------------------------------------------------

/** Follow the supersession chain FORWARD to the terminal row (cycle-safe). */
function terminalOf(id, byId, successorOf) {
  const seen = new Set()
  let cur = id
  while (!seen.has(cur)) {
    seen.add(cur)
    const row = byId.get(cur)
    const next = (row && typeof row.superseded_by === 'string' && row.superseded_by) || successorOf.get(cur)
    if (!next || !byId.has(next)) return byId.get(cur)
    cur = next
  }
  return byId.get(cur) // cycle: return where we stopped
}

function buildChainMaps(rows) {
  const byId = new Map()
  const successorOf = new Map() // predecessor id -> successor id (via `supersedes`)
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue
    if (!byId.has(row.id)) byId.set(row.id, row)
    if (typeof row.supersedes === 'string' && row.supersedes) successorOf.set(row.supersedes, row.id)
  }
  return { byId, successorOf }
}

/**
 * effectivePriority(lessonId, rows) -> 1..9 (REQ-13). Counts violations linked
 * to the lesson: violation-side `lessons` ∪ lesson-side `evidence`, deduped by
 * TERMINAL violation id; links to since-revised episodes follow to their active
 * terminals in BOTH directions; a retracted violation (chain terminates on a
 * non-violation or non-active row) stops counting. Reads only (I3).
 */
export function effectivePriority(lessonId, rows) {
  const { byId, successorOf } = buildChainMaps(rows)
  const lessonRow = byId.get(lessonId)
  if (!lessonRow) return 5
  const lessonTerminal = terminalOf(lessonId, byId, successorOf)
  const lessonChainIds = new Set()
  {
    // every id whose terminal IS this lesson belongs to its chain
    for (const row of byId.values()) {
      const t = terminalOf(row.id, byId, successorOf)
      if (t && lessonTerminal && t.id === lessonTerminal.id) lessonChainIds.add(row.id)
    }
  }
  const linked = new Set()
  const countViolationTerminal = (violationId) => {
    const t = terminalOf(violationId, byId, successorOf)
    if (!t) return
    if (t.category !== 'violation') return // retracted (EC7)
    if (t.status === 'superseded') return
    linked.add(t.id)
  }
  // forward direction: ACTIVE violation rows naming any id in the lesson's chain
  for (const row of byId.values()) {
    if (row.category !== 'violation' || !Array.isArray(row.lessons)) continue
    if (row.status === 'superseded') continue
    for (const lid of row.lessons) {
      const lt = terminalOf(lid, byId, successorOf)
      if (lt && lessonTerminal && lt.id === lessonTerminal.id) { countViolationTerminal(row.id); break }
    }
  }
  // back direction: the lesson chain's `evidence` links, chain-resolved
  for (const cid of lessonChainIds) {
    const row = byId.get(cid)
    if (!row || !Array.isArray(row.evidence)) continue
    for (const vid of row.evidence) countViolationTerminal(vid)
  }
  const stored = Number.isInteger(Number(lessonRow.priority)) ? Number(lessonRow.priority) : 5
  if (linked.size === 0) return Math.min(Math.max(stored, 1), 7)
  return linked.size === 1 ? 8 : 9
}

// ---------------------------------------------------------------------------
// Per-store build (REQ-12/14 — NO cross-store logic here, CX4)
// ---------------------------------------------------------------------------

/**
 * Build (or return the cached) trigger-index.json for ONE store. Lazy: a cache
 * whose `source` fingerprint matches the store's index.jsonl on all three
 * legs is returned WITHOUT a rewrite. Never throws for store-content reasons;
 * IO errors on the store dir itself surface to the caller (loadMergedTriggerIndex
 * degrades them).
 *
 * @param {{project?:string, scope?:'local'|'global', now?:Date}} opts
 * @returns {{index:object, cacheHit:boolean, storeDir:string}}
 */
export function buildTriggerIndex({ project, scope = 'local', now = new Date() } = {}) {
  const storeDir = resolveStoreDir({ project, scope })
  const indexPath = path.join(storeDir, 'trigger-index.json')
  const { raw, fingerprint } = readIndexWithFingerprint(storeDir)

  // cache probe — malformed cache is simply a miss (rebuilt below)
  try {
    const cached = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    const s = cached && cached.source
    if (s && s.index_mtime_ms === fingerprint.index_mtime_ms &&
        s.index_size === fingerprint.index_size &&
        s.index_sha256 === fingerprint.index_sha256 &&
        cached.schema_version === TRIGGER_INDEX_SCHEMA_VERSION) {
      return { index: cached, cacheHit: true, storeDir }
    }
  } catch {}

  const rows = parseRows(raw)
  const todayStr = now.toISOString().slice(0, 10)

  // activity-class vocab — degrade-not-throw at BUILD (F4/I5): unreadable vocab
  // means every `activity:` trigger is excluded+counted, never fatal.
  let classNames = null
  try {
    classNames = new Map(loadActivationClasses().classes.map(c => [c.name, c]))
  } catch {
    classNames = null
  }

  const excludedActivity = Object.create(null)
  const entries = []
  for (const row of rows) {
    if (!row || row.category !== 'lesson') continue
    if (row.status !== 'active') continue // superseded excluded
    if (!Array.isArray(row.triggers) || row.triggers.length === 0) continue
    if (typeof row.review_by === 'string' && row.review_by < todayStr) continue // expired
    const ep = effectivePriority(row.id, rows)
    for (const value of row.triggers) {
      const kind = parseTriggerKind(String(value))
      if (kind === 'activity') {
        const cls = String(value).slice('activity:'.length)
        const member = classNames ? classNames.get(cls) : undefined
        if (!member || member.deprecated_for) {
          excludedActivity[cls] = (excludedActivity[cls] || 0) + 1
          continue // excluded + counted (EC11), never silently matched
        }
      }
      entries.push({
        trigger_kind: kind,
        value: String(value),
        episode_id: row.id,
        summary: row.summary,
        effective_priority: ep, // DERIVED 1-9; never the stored `priority`
        applies_to_projects: Array.isArray(row.applies_to_projects) ? row.applies_to_projects : [],
        applies_to_tools: Array.isArray(row.applies_to_tools) ? row.applies_to_tools : [],
        ...(typeof row.review_by === 'string' ? { review_by: row.review_by } : {}),
      })
    }
  }

  const index = {
    schema_version: TRIGGER_INDEX_SCHEMA_VERSION,
    source: fingerprint,
    build_report: { excluded_activity_classes: { ...excludedActivity } },
    entries,
    session_start: buildSessionStart(rows, now),
  }

  // Atomic write, UNIQUE temp name (F2) — two racing lazy builds must not share
  // a temp path (fixed `.tmp` yields a torn temp / ENOENT on the loser).
  try {
    fs.mkdirSync(storeDir, { recursive: true })
    const tmp = `${indexPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
    fs.renameSync(tmp, indexPath)
  } catch (e) {
    // degrade: the in-memory index is still valid for this consumer read (I5)
    process.stderr.write(`em-trigger-index: could not persist ${indexPath}: ${e.message}\n`)
  }
  return { index, cacheHit: false, storeDir }
}

// ---------------------------------------------------------------------------
// session_start section (REQ-15, S6) — pure function of index rows + `now`;
// NO environment inputs (I6: the P2 R4 hook reads only this purpose-built data).
// ---------------------------------------------------------------------------
const SESSION_START_TOP_N = 10

// Mirrors em-recall's TASK_TYPE_PATTERNS (RFC-002 Phase 3); duplicated as DATA
// here so the builder stays environment-free — keep in lockstep.
const TASK_TYPE_PATTERNS = {
  implementation: ['bp-001-implementation-workflow', 'bp-006-push-after-verify'],
  push: ['bp-006-push-after-verify'],
  rule: ['bp-010-habits-override-knowledge'],
}

export function buildSessionStart(rows, now = new Date()) {
  const todayStr = now.toISOString().slice(0, 10)
  const nowMs = now.getTime()
  const activeLessons = rows.filter(r =>
    r && r.category === 'lesson' && r.status === 'active' &&
    !(typeof r.review_by === 'string' && r.review_by < todayStr))

  const epCache = new Map()
  const ep = (id) => {
    if (!epCache.has(id)) epCache.set(id, effectivePriority(id, rows))
    return epCache.get(id)
  }

  // critical_entries — EVERY active band-8/9 lesson, TRIGGER-INDEPENDENT (EC14:
  // R8 always-tier content carries no trigger; the band scan covers ALL lessons).
  const critical_entries = activeLessons
    .filter(r => ep(r.id) >= 8)
    .map(r => ({
      episode_id: r.id,
      summary: r.summary,
      category: r.category,
      effective_priority: ep(r.id),
      applies_to_projects: Array.isArray(r.applies_to_projects) ? r.applies_to_projects : [],
      applies_to_tools: Array.isArray(r.applies_to_tools) ? r.applies_to_tools : [],
    }))
    .sort((a, b) => b.effective_priority - a.effective_priority || (a.episode_id < b.episode_id ? -1 : 1))

  // entries — top-N by the explicit static_score blend (REQ-15):
  //   0.5*recency + 0.3*staleness + 0.2*priority
  //   recencyScore  = 1/(1 + ageDays/30)                (newer -> higher)
  //   stalenessScore= min(daysSinceAccess,365)/365; null last_accessed -> 1.0
  //   priorityScore = storedPriority/7 (default 5)
  const DAY = 24 * 60 * 60 * 1000
  const scored = activeLessons.map(r => {
    const dateMs = Date.parse(`${r.date}T00:00:00Z`)
    const ageDays = Number.isNaN(dateMs) ? 365 : Math.max(0, (nowMs - dateMs) / DAY)
    const recencyScore = 1 / (1 + ageDays / 30)
    let stalenessScore = 1.0 // never-accessed ranks highest (the R6 intent)
    if (r.last_accessed) {
      const laMs = Date.parse(r.last_accessed)
      const daysSince = Number.isNaN(laMs) ? 365 : Math.max(0, (nowMs - laMs) / DAY)
      stalenessScore = Math.min(daysSince, 365) / 365
    }
    const stored = Number.isInteger(Number(r.priority)) ? Number(r.priority) : 5
    const priorityScore = stored / 7
    const static_score = 0.5 * recencyScore + 0.3 * stalenessScore + 0.2 * priorityScore
    return { r, static_score, recencyScore }
  })
  scored.sort((a, b) =>
    b.static_score - a.static_score ||
    b.recencyScore - a.recencyScore ||
    (a.r.id < b.r.id ? -1 : 1))
  const entries = scored.slice(0, SESSION_START_TOP_N).map(({ r, static_score }) => ({
    episode_id: r.id,
    summary: r.summary,
    static_score: Number(static_score.toFixed(6)),
    applies_to_projects: Array.isArray(r.applies_to_projects) ? r.applies_to_projects : [],
    applies_to_tools: Array.isArray(r.applies_to_tools) ? r.applies_to_tools : [],
  }))

  // preflight — per-task-type recent-violation counts keyed by the TYPED
  // violated_pattern field (why T6 is a hard dep of REQ-15). 30-day window.
  const cutoff = new Date(nowMs - 30 * DAY).toISOString().slice(0, 10)
  const preflight = {}
  for (const [taskType, patternIds] of Object.entries(TASK_TYPE_PATTERNS)) {
    const counts = {}
    for (const pid of patternIds) {
      const n = rows.filter(r =>
        r && r.category === 'violation' && r.status !== 'superseded' &&
        r.violated_pattern === pid &&
        typeof r.date === 'string' && r.date >= cutoff).length
      if (n > 0) counts[pid] = n
    }
    preflight[taskType] = counts
  }

  return { critical_entries, entries, preflight }
}

// ---------------------------------------------------------------------------
// Merged read (REQ-16, CX4 — the ONLY merge site)
// ---------------------------------------------------------------------------

/**
 * Build/load BOTH stores' indexes and merge: dedupe by EPISODE id with LOCAL
 * precedence (mirrors em-search). One store failing degrades to the other with
 * a single stderr note — never throws (I5). Consumers (R9a, the P2 R4 hook)
 * call THIS, never buildTriggerIndex directly.
 */
export function loadMergedTriggerIndex({ project, now = new Date() } = {}) {
  let local = null
  let global = null
  try { local = buildTriggerIndex({ project, scope: 'local', now }).index } catch (e) {
    process.stderr.write(`em-trigger-index: local build failed (${e.message}); proceeding with global only\n`)
  }
  try { global = buildTriggerIndex({ scope: 'global', now }).index } catch (e) {
    process.stderr.write(`em-trigger-index: global build failed (${e.message}); proceeding with local only\n`)
  }
  const seenEpisodes = new Set()
  const entries = []
  for (const idx of [local, global]) { // local first -> local precedence
    if (!idx || !Array.isArray(idx.entries)) continue
    for (const e of idx.entries) {
      if (seenEpisodes.has(e.episode_id)) continue // earlier store won this episode
      entries.push(e)
    }
    for (const e of idx.entries) seenEpisodes.add(e.episode_id)
  }
  return { entries, local, global }
}

// ---------------------------------------------------------------------------
// CLI (main-module guarded so writers can import the helpers without running it)
// ---------------------------------------------------------------------------
function isMainModule() {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href } catch { return false }
}

if (isMainModule()) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(JSON.stringify({ status: 'help', script: 'em-trigger-index.mjs', usage: 'node em-trigger-index.mjs [--project <root>] [--scope local|global|all] [--merged] — builds trigger-index.json per store; --project <root> binds the LOCAL store to <root>/.episodic-memory (path binding, not a name filter); --merged prints the deduped local-precedence merged view' }))
    process.exit(0)
  }
  const flag = (name) => {
    const i = argv.indexOf(name)
    if (i === -1 || i + 1 >= argv.length) return undefined
    return argv[i + 1]
  }
  const project = flag('--project')
  const scope = flag('--scope') || 'local'
  const VALID = ['local', 'global', 'all']
  if (!VALID.includes(scope)) {
    console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID.join(', ')}` }))
    process.exit(1)
  }
  if (argv.includes('--merged')) {
    const merged = loadMergedTriggerIndex({ project })
    console.log(JSON.stringify({ status: 'ok', entries: merged.entries }))
    process.exit(0)
  }
  const built = []
  for (const s of scope === 'all' ? ['local', 'global'] : [scope]) {
    try {
      const { index, cacheHit, storeDir } = buildTriggerIndex({ project, scope: s })
      built.push({ scope: s, store: storeDir, entries: index.entries.length, cache_hit: cacheHit })
    } catch (e) {
      // per-store IO failure degrades to a named report, never a stack trace (I5)
      built.push({ scope: s, error: e.message })
      process.stderr.write(`em-trigger-index: ${s} build failed: ${e.message}\n`)
    }
  }
  console.log(JSON.stringify({ status: built.some(b => b.error) ? 'partial' : 'ok', built }))
}
