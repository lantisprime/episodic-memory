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
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadActivationClasses, parseTriggerKind } from './lib/activation.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')

// The dir containing em-trigger-index.mjs == the dir containing em-search.mjs. The
// read_command (RFC-011 R2.4/R7) points here so the hook renders a tracked bounded
// read without deciding anything; recorded at build time (resolveAsset-consistent —
// import.meta.url resolves to this script whether run as CLI or imported).
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

// v3 (RFC-011 R2.6): additive bump — session_start.playbooks (+ playbooks_capped +
// playbooks_capped_first), entry_class/read_command entry fields, the conditional
// effective_priority minimum (0 for entry_class:"playbook" rows, 1 for lessons),
// build_report.playbooks, and the extended source fingerprint (playbooks_*
// unconditional zero-state-when-absent; global_index_* when a valid preference
// file exists). The bump invalidates every cached v2 index so it rebuilds once
// (T12) — intended. (v2 RFC-009 P2 added the top-level activity_phrases map.)
export const TRIGGER_INDEX_SCHEMA_VERSION = 3
// v3 (RFC-011 R2.6): entry_fields gains entry_class + read_command (the playbook-row
// shape) and triggers_overridden (the R1 override-clause marker, F3 S2 fix). All
// three are conditional on entry_class:'playbook' in the schema (a lesson row
// carrying any of them is rejected — F6a); they are listed here as the full set of
// fields an entry CAN carry, set-matched bidirectionally by the contract mirror.
export const TRIGGER_ENTRY_FIELDS = ['trigger_kind', 'value', 'episode_id', 'summary', 'effective_priority', 'applies_to_projects', 'applies_to_tools', 'review_by', 'entry_class', 'read_command', 'triggers_overridden']
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
// RFC-011 R1/R2: playbook preferences + cross-store build derivation
// ---------------------------------------------------------------------------
// parsePlaybooksConfig is the SHARED single source of truth for playbooks.json
// parsing (§12 states A/B/C) — the build (R2, fail OPEN: skip+note) and the R5b
// retention consumers (fail CLOSED: abort exit 1) both import it. The schema
// (schemas/playbooks.schema.json) is the CI-linted CONTRACT; this parser
// hand-rolls the SAME checks (the closed-subset instance validator cannot express
// unique-by-id or a file-size bound) plus the two bounds the schema cannot:
//   - 64 KiB whole-FILE bound (a stat; over-bound = malformed, R1 Principle 6)
//   - no two entries share the same `id` (JSON-Schema uniqueItems checks whole-
//     item deep equality, NOT unique-by-id, so two same-id/different-mode entries
//     would slip through; R1 states this is parser-enforced)
// T1 dual-tests a sample corpus against BOTH the schema doc (via validateInstance)
// AND this parser so the two cannot silently diverge.
//
// IMPORTANT: the schema file is NOT deployed to ~/.episodic-memory/schemas/, so
// the build must NOT depend on loading it at runtime — hence hand-rolled checks
// (self-contained), with the schema doc as the CI-linted contract of record.

const PLAYBOOKS_MAX_BYTES = 64 * 1024 // R1 bound: at most 64 KiB of file (over-bound = malformed)
const PLAYBOOKS_OVERSIZED_FILE_BYTES = 49152 // R2/R7 truncation-coherence: selected playbook FILE size stat proxy
const PLAYBOOKS_FP_ZERO = { playbooks_mtime_ms: 0, playbooks_size: 0, playbooks_sha256: sha256('') }

function zeroExcluded() {
  return { unresolvable: 0, cycle: 0, inactive: 0, non_lesson: 0, expired: 0, chain_collision: 0, empty_triggers: 0 }
}

function emptyPlaybooksReport(pb) {
  const report = { declared: [], capped_ids: [], excluded: zeroExcluded() }
  if (!pb.ok) report.note = pb.reason // State C malformed -> the build-report note (R1)
  return report
}

const PLAYBOOKS_MODES = new Set(['session_start', 'on_demand'])
const PLAYBOOKS_TOP_KEYS = new Set(['schema_version', 'playbooks', 'bounds'])
const PLAYBOOKS_BOUNDS_KEYS = new Set(['max_playbooks'])

/**
 * parsePlaybooksConfig(storeDir) -> {ok, config, reason, fingerprint} (§12).
 *   A absent:    {ok:true,  config:null, fingerprint: zero-state}
 *   B valid:     {ok:true,  config,      fingerprint: real}
 *   C malformed: {ok:false, reason,      fingerprint: real} (present but
 *     unparseable/schema-invalid/over-bound/dup-id; CALLERS decide fail direction:
 *     build = skip+note; prune/consolidate = abort exit 1)
 * No side effects. The fingerprint is ALWAYS returned (zero-state if absent) so
 * the build can record playbooks_* unconditionally (R2.5: CREATE/edit/DELETE all
 * invalidate). The 64 KiB bound is checked on the BYTES READ (a stat proxy;
 * playbooks.json is the build's config INPUT, not an episode body — R2.8's
 * no-body rule governs episode bodies, not this file).
 */
export function parsePlaybooksConfig(storeDir) {
  const file = path.join(storeDir, 'playbooks.json')
  let st = null
  try { st = fs.statSync(file) } catch {}
  if (!st) return { ok: true, config: null, fingerprint: { ...PLAYBOOKS_FP_ZERO } }

  // Read the bytes and fingerprint TOCTOU-aware (stat -> read -> re-stat),
  // mirroring readIndexWithFingerprint. A read failure degrades to zero-state
  // (any later readability rebuilds).
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
    return { ok: false, reason: `unreadable: ${e.message}`, fingerprint: { ...PLAYBOOKS_FP_ZERO } }
  }
  let st2 = null
  try { st2 = fs.statSync(file) } catch {}
  const bytes = Buffer.byteLength(raw, 'utf8')
  const fingerprint = {
    playbooks_mtime_ms: st2 ? st2.mtimeMs : st.mtimeMs,
    playbooks_size: bytes,
    playbooks_sha256: sha256(raw),
  }
  // 64 KiB whole-file bound (R1): over-bound = malformed (skip the whole file).
  if (bytes > PLAYBOOKS_MAX_BYTES) {
    return { ok: false, reason: `exceeds 64 KiB bound (${bytes} bytes)`, fingerprint }
  }
  let doc
  try { doc = JSON.parse(raw) } catch (e) {
    return { ok: false, reason: `not valid JSON: ${e.message}`, fingerprint }
  }
  const reason = validatePlaybooksShape(doc)
  if (reason) return { ok: false, reason, fingerprint }
  return { ok: true, config: doc, fingerprint }
}

/** Hand-rolled structural validation mirroring schemas/playbooks.schema.json. */
function validatePlaybooksShape(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'root must be an object'
  for (const k of Object.keys(doc)) if (!PLAYBOOKS_TOP_KEYS.has(k)) return `unknown key "${k}"`
  if (doc.schema_version !== 1) return 'schema_version must be the integer 1'
  if (!Array.isArray(doc.playbooks)) return 'playbooks must be an array'
  if (doc.playbooks.length > 32) return `playbooks exceeds the 32-entry bound (${doc.playbooks.length})`
  if (doc.bounds !== undefined) {
    if (!doc.bounds || typeof doc.bounds !== 'object' || Array.isArray(doc.bounds)) return 'bounds must be an object'
    for (const k of Object.keys(doc.bounds)) if (!PLAYBOOKS_BOUNDS_KEYS.has(k)) return `unknown key "bounds.${k}"`
    if (doc.bounds.max_playbooks !== undefined) {
      const mp = doc.bounds.max_playbooks
      if (!Number.isInteger(mp) || mp < 1 || mp > 4) return 'bounds.max_playbooks must be an integer 1..4'
    }
  }
  const seenIds = new Set()
  for (let i = 0; i < doc.playbooks.length; i++) {
    const e = doc.playbooks[i]
    const ctx = `playbooks[${i}]`
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `${ctx} must be an object`
    for (const k of Object.keys(e)) if (!['id', 'mode', 'triggers'].includes(k)) return `${ctx}: unknown key "${k}"`
    if (typeof e.id !== 'string' || e.id.length < 1) return `${ctx}: id must be a non-empty string`
    if (!PLAYBOOKS_MODES.has(e.mode)) return `${ctx}: mode must be session_start or on_demand`
    if (e.triggers !== undefined) {
      if (!Array.isArray(e.triggers)) return `${ctx}: triggers must be an array`
      for (const t of e.triggers) if (typeof t !== 'string') return `${ctx}: triggers must be strings`
      if (e.mode === 'session_start') return `${ctx}: triggers is on_demand-only (rejected on session_start)`
    }
    if (seenIds.has(e.id)) return `${ctx}: duplicate literal id "${e.id}"`
    seenIds.add(e.id)
  }
  return null // valid
}

// --- cross-store chain resolution (R2.1) over the row UNION ---

/**
 * Merge local + global index rows for chain resolution with R2.1 precedence: a
 * row whose chain CONTINUES (carries `superseded_by`) outranks a stale terminal
 * snapshot — a superseded copy in one store can never shadow the live chain in
 * the other (the exact hazard protection.mjs:14-17 documents). When neither
 * continues (or both), LOCAL wins (the RFC-009 merge convention; round-3 planner
 * V4). LOCAL is iterated first so ties resolve to the local row by insertion order.
 */
function mergeIndexRowsForChain(localRows, globalRows) {
  const byId = new Map()
  const consider = (row) => {
    if (!row || typeof row.id !== 'string') return
    const ex = byId.get(row.id)
    if (!ex) { byId.set(row.id, row); return }
    const exCont = !!ex.superseded_by
    const curCont = !!row.superseded_by
    if (curCont && !exCont) byId.set(row.id, row) // continuing outranks a stale terminal snapshot
    // else: existing (local-if-present, since local iterates first) wins ties
  }
  for (const r of localRows) consider(r)
  for (const r of globalRows) consider(r)
  return [...byId.values()]
}

/** A returned terminal is part of a (cycle-safe) SUPERSession cycle iff it still
 *  has a resolvable forward successor (terminalOf stopped because of `seen`). */
function hasForwardSuccessor(row, byId, successorOf) {
  if (!row) return false
  const next = (typeof row.superseded_by === 'string' && row.superseded_by) || successorOf.get(row.id)
  return !!(next && byId.has(next))
}

/** Resolve a selected playbook's episode FILE (episodes/ then archived/) across
 *  both stores — a STAT only, never a content read (R2.8 no-body rule). */
function findEpisodeFile(id, localStoreDir) {
  for (const dir of [localStoreDir, GLOBAL_DIR]) {
    for (const sub of ['episodes', 'archived']) {
      const p = path.join(dir, sub, `${id}.md`)
      try { if (fs.statSync(p).isFile()) return p } catch {}
    }
  }
  return null
}

/** Effective triggers for an on_demand playbook: a declared `triggers` array is an
 *  OVERRIDE (present, even [], replaces the episode's own); absent -> the terminal
 *  episode's own triggers (R1). Empty/whitespace-only entries are dropped.
 *
 *  F2 (S2 fix): activity classes are guarded on BOTH legs — declared override AND
 *  inherited episode triggers — mirroring the lesson branch (em-trigger-index.mjs
 *  lesson loop). An unknown/deprecated `activity:` class is dropped + counted in
 *  `excludedActivity` (the SAME top-level build_report counter the lesson branch
 *  uses — "excluded + counted, never silent", RFC-009 EC11; R1 "same closed
 *  grammars"). If filtering empties the set, Phase 3 counts `empty_triggers` (the
 *  existing playbook counter — no new schema key needed). */
function playbookEffectiveTriggers(entry, terminal, classNames, excludedActivity) {
  let raw
  if (Array.isArray(entry.triggers)) raw = entry.triggers
  else raw = Array.isArray(terminal.triggers) ? terminal.triggers : []
  const out = []
  for (const value of raw) {
    const s = String(value)
    if (s.trim() === '') continue
    const kind = parseTriggerKind(s)
    if (kind === 'activity') {
      const cls = s.slice('activity:'.length)
      const member = classNames ? classNames.get(cls) : undefined
      if (!member || member.deprecated_for) {
        if (excludedActivity) excludedActivity[cls] = (excludedActivity[cls] || 0) + 1
        continue // excluded + counted (EC11), never silently matched
      }
    }
    out.push(s)
  }
  return out
}

/**
 * buildPlaybookSection — derive the playbook data for ONE local store build, per
 * RFC-011 R2. The caller ensures a VALID preference file (local scope).
 *   - resolution uses terminalOf/buildChainMaps VERBATIM over the cross-store row
 *     union (R2.1); each exclusion is counted (R2.2) and never fatal.
 *   - session_start.playbooks is pre-capped at build to bounds.max_playbooks (R3).
 *   - on_demand entries expand into entry_class:"playbook" rows pinned to
 *     effective_priority 0 (sort below every lesson; R2) with the verbatim shape.
 *   - declared lists the accepted set (resolved terminal id + mode) — the consent
 *     audit (R2.3); capped_ids lists the session_start overflow.
 *   - warnings: oversized selected-playbook FILE size (R2/R7) + unpinned selected
 *     terminals (R5a); FILE SIZE is a stat, never a content read.
 */
function buildPlaybookSection({ config, localRows, globalRaw, storeDir, scriptsRoot, now, classNames, excludedActivity }) {
  const globalRows = globalRaw ? parseRows(globalRaw) : []
  const merged = mergeIndexRowsForChain(localRows, globalRows)
  const { byId, successorOf } = buildChainMaps(merged) // reused verbatim (R2.1)
  const todayStr = now.toISOString().slice(0, 10)
  const maxPlaybooks = (config.bounds && Number.isInteger(config.bounds.max_playbooks))
    ? config.bounds.max_playbooks : 2

  const excluded = zeroExcluded()
  const resolved = [] // {entry, terminal?, state, terminalId?, effectiveTriggers?}

  // Phase 1: resolve each declaration (verbatim terminalOf; cycle detection via a
  // resolvable forward successor on the returned stop row — terminalOf is reused
  // unchanged, per the anchor contract).
  for (const entry of config.playbooks) {
    const terminal = terminalOf(entry.id, byId, successorOf)
    if (!terminal) { excluded.unresolvable++; resolved.push({ entry, state: 'unresolvable' }); continue }
    if (hasForwardSuccessor(terminal, byId, successorOf)) { excluded.cycle++; resolved.push({ entry, terminal, state: 'cycle' }); continue }
    if (terminal.status !== 'active') { excluded.inactive++; resolved.push({ entry, terminal, state: 'inactive' }); continue }
    if (terminal.category !== 'lesson') { excluded.non_lesson++; resolved.push({ entry, terminal, state: 'non_lesson' }); continue }
    if (typeof terminal.review_by === 'string' && terminal.review_by < todayStr) { excluded.expired++; resolved.push({ entry, terminal, state: 'expired' }); continue }
    resolved.push({ entry, terminal, state: 'resolved', terminalId: terminal.id })
  }

  // Phase 2: same-chain collision — ALL entries of a shared terminal drop (R2.2;
  // one chain has at most one entry and one mode, regardless of mode).
  const byTerminal = new Map()
  resolved.forEach((r, i) => {
    if (r.state !== 'resolved') return
    if (!byTerminal.has(r.terminalId)) byTerminal.set(r.terminalId, [])
    byTerminal.get(r.terminalId).push(i)
  })
  for (const [, idxs] of byTerminal) {
    if (idxs.length > 1) {
      excluded.chain_collision += idxs.length
      for (const i of idxs) resolved[i].state = 'chain_collision'
    }
  }

  // Phase 3: empty effective triggers (on_demand resolved only). F2: activity
  // classes are guarded here (both override + inherited legs) via the new
  // playbookEffectiveTriggers signature; a filtered-to-empty set counts as
  // empty_triggers. F3: record whether a DECLARED override produced this set
  // (entry.triggers is an array) so Phase 6 can emit triggers_overridden.
  for (const r of resolved) {
    if (r.state !== 'resolved' || r.entry.mode !== 'on_demand') continue
    const eff = playbookEffectiveTriggers(r.entry, r.terminal, classNames, excludedActivity)
    if (eff.length === 0) { excluded.empty_triggers++; r.state = 'empty_triggers' }
    else { r.effectiveTriggers = eff; r.overridden = Array.isArray(r.entry.triggers) }
  }

  // Phase 4: accepted (derive rows + declared listing).
  const accepted = resolved.filter((r) => r.state === 'resolved')
  const declared = accepted.map((r) => ({ episode_id: r.terminalId, mode: r.entry.mode }))

  // Phase 5: session_start render array — preference-FILE order, capped at build.
  const indexOfEntry = (entry) => config.playbooks.indexOf(entry)
  const sessionStartAccepted = accepted
    .filter((r) => r.entry.mode === 'session_start')
    .sort((a, b) => indexOfEntry(a.entry) - indexOfEntry(b.entry))
  const capped = sessionStartAccepted.slice(maxPlaybooks)
  const playbooksArr = sessionStartAccepted.slice(0, maxPlaybooks).map((r) => ({
    episode_id: r.terminalId,
    summary: r.terminal.summary,
    read_command: `node ${scriptsRoot}/em-search.mjs --read ${r.terminalId}`,
  }))

  // Phase 6: on_demand entry rows — the FULL verbatim shape (R2), pinned to 0.
  // F3 (S2 fix): rows derived under a DECLARED override carry triggers_overridden:
  // true so the merged view can mute the episode's own (superseded) trigger rows
  // (R1 override clause; T6 E2E). The marker is optional — present only on
  // overridden rows (an inherited row leaves it absent so both rows survive
  // R2.9(b) dedup untouched).
  const slug = path.basename(path.dirname(storeDir))
  const playbookEntries = []
  for (const r of accepted.filter((r) => r.entry.mode === 'on_demand')) {
    for (const trig of r.effectiveTriggers) {
      playbookEntries.push({
        trigger_kind: parseTriggerKind(String(trig)),
        value: String(trig),
        episode_id: r.terminalId,
        summary: r.terminal.summary,
        effective_priority: 0,
        applies_to_projects: [slug],
        applies_to_tools: ['*'],
        entry_class: 'playbook',
        read_command: `node ${scriptsRoot}/em-search.mjs --read ${r.terminalId}`,
        ...(r.overridden ? { triggers_overridden: true } : {}),
      })
    }
  }

  // Phase 7: warnings (R2/R7 oversized FILE-size stat + R5a unpinned). FILE SIZE
  // is a stat (never a content read — R2.8); unpinned reads the index row's field.
  const oversized = []
  const unpinned = []
  for (const r of accepted) {
    const fp = findEpisodeFile(r.terminalId, storeDir)
    if (fp) { try { if (fs.statSync(fp).size > PLAYBOOKS_OVERSIZED_FILE_BYTES) oversized.push(r.terminalId) } catch {} }
    if (!r.terminal.pinned) unpinned.push(r.terminalId)
  }

  const report = { declared, capped_ids: capped.map((r) => r.terminalId), excluded }
  if (oversized.length || unpinned.length) report.warnings = { oversized, unpinned }

  return {
    sessionStart: {
      playbooks: playbooksArr,
      playbooks_capped: capped.length,
      playbooks_capped_first: capped.length > 0 ? capped[0].terminalId : null,
    },
    entries: playbookEntries,
    report,
  }
}

/** Cache-probe fingerprint match over the extended v3 source (R2.5). Compares
 *  index_* + playbooks_* always, and global_index_* when EITHER side carries it
 *  (so pref CREATE/edit/DELETE and a valid-pref-only global revision all
 *  invalidate; config-free stores pay no cross-store coupling). */
function sourceMatches(cached, fresh) {
  if (!cached) return false
  if (cached.index_mtime_ms !== fresh.index_mtime_ms ||
      cached.index_size !== fresh.index_size ||
      cached.index_sha256 !== fresh.index_sha256) return false
  if (cached.playbooks_mtime_ms !== fresh.playbooks_mtime_ms ||
      cached.playbooks_size !== fresh.playbooks_size ||
      cached.playbooks_sha256 !== fresh.playbooks_sha256) return false
  const either = (cached.global_index_mtime_ms !== undefined) || (fresh.global_index_mtime_ms !== undefined)
  if (either) {
    if (cached.global_index_mtime_ms !== fresh.global_index_mtime_ms ||
        cached.global_index_size !== fresh.global_index_size ||
        cached.global_index_sha256 !== fresh.global_index_sha256) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Per-store build (REQ-12/14 — non-playbook logic stays single-store, CX4;
// RFC-011 R2.1 adds cross-store chain resolution for PLAYBOOKS ONLY)
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

  // --- RFC-011 R2: playbooks preference (parse once; fingerprint UNCONDITIONAL) ---
  // parsePlaybooksConfig is the shared single source of truth (§12). playbooks_*
  // is recorded on EVERY v3 build (zero-state when the file is absent — R2.5:
  // CREATE/edit/DELETE all invalidate). global_index_* is recorded when-and-only-
  // when a valid preference file exists: the local build then reads the GLOBAL
  // store's index.jsonl as BUILD INPUT for cross-store chain resolution (R2.1).
  //
  // F4 (S2 fix): a preference file is a per-project (LOCAL) artifact — RFC-011 R1
  // states "no global variant exists" and R2 states "the global store's index
  // never carries playbook data". So a GLOBAL-scope build must NOT parse a
  // global-store playbooks.json (it would fingerprint an uncontracted file
  // (invalidating the global cache on every touch) and leak parse-error notes
  // into the GLOBAL index's build_report). Non-local scopes skip the parse and
  // record the zero-state fingerprint (no note — R1/R2).
  const pb = scope === 'local'
    ? parsePlaybooksConfig(storeDir)
    : { ok: true, config: null, fingerprint: { ...PLAYBOOKS_FP_ZERO } }
  const validPref = !!(scope === 'local' && pb.ok && pb.config)
  let globalRaw = null
  let globalFp = null
  if (validPref) {
    const g = readIndexWithFingerprint(GLOBAL_DIR) // TOCTOU-safe; build input only
    globalRaw = g.raw
    globalFp = {
      global_index_mtime_ms: g.fingerprint.index_mtime_ms,
      global_index_size: g.fingerprint.index_size,
      global_index_sha256: g.fingerprint.index_sha256,
    }
  }
  const source = {
    ...fingerprint,                       // index_* (LOCAL index.jsonl)
    ...pb.fingerprint,                    // playbooks_* (unconditional; zero-state if absent)
    ...(globalFp ? globalFp : {}),        // global_index_* (valid preference file only)
  }

  // cache probe — malformed cache is simply a miss (rebuilt below). Compares the
  // full extended source (index_* + playbooks_* + global_index_* when either side
  // carries it) so preference CREATE/edit/DELETE and global revisions all
  // invalidate; a cached v2 index mismatches on schema_version and rebuilds (T12).
  try {
    const cached = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (cached && cached.schema_version === TRIGGER_INDEX_SCHEMA_VERSION && sourceMatches(cached.source, source)) {
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

  // REQ-9 (RFC-009 P2): bake the ACTIVE activity-class phrase sets into the index
  // so the event plane matches `activity:<class>` triggers by reading ONLY this
  // derived artifact — it never reads activation-classes.json (which honors the
  // EM_ACTIVATION_CLASSES_PATH env override, an event-plane read-boundary escape)
  // at event time. One copy per class (DRY, not denormalized onto every entry, so
  // the contract-mirror's pinned `entry_fields` is untouched). Deprecated classes
  // are omitted (they are excluded from entries too). Consumers MUST look this up
  // with Object.hasOwn (JSON round-trip reintroduces Object.prototype).
  const activityPhrases = {}
  if (classNames) {
    for (const [name, member] of classNames) {
      if (member && !member.deprecated_for && Array.isArray(member.phrases)) {
        activityPhrases[name] = member.phrases
      }
    }
  }

  // --- RFC-011 R2: playbook derivation (LOCAL + valid preference file only) ---
  // Declared+critical dedup is RENDER (S3); the build only ensures playbook rows
  // carry entry_class:"playbook" (EC5) and the session_start trio is present.
  let playbooksReport = emptyPlaybooksReport(pb)
  let sessionStartPlaybooks = null // null = section absent (no valid pref); an object = the trio to attach
  if (validPref) {
    const pbSection = buildPlaybookSection({ config: pb.config, localRows: rows, globalRaw, storeDir, scriptsRoot: SCRIPTS_DIR, now, classNames, excludedActivity })
    for (const pe of pbSection.entries) entries.push(pe)
    sessionStartPlaybooks = pbSection.sessionStart
    playbooksReport = pbSection.report
  } else if (scope === 'local' && !pb.ok) {
    // malformed local playbooks.json: degrade to no playbooks + a stderr note (R1:
    // a build-report note — playbooksReport.note below — AND a stderr line).
    process.stderr.write(`em-trigger-index: playbooks.json malformed (${pb.reason}); skipped, no playbooks loaded\n`)
  }

  const session_start = buildSessionStart(rows, now)
  if (sessionStartPlaybooks) {
    session_start.playbooks = sessionStartPlaybooks.playbooks
    session_start.playbooks_capped = sessionStartPlaybooks.playbooks_capped
    session_start.playbooks_capped_first = sessionStartPlaybooks.playbooks_capped_first
  }

  const index = {
    schema_version: TRIGGER_INDEX_SCHEMA_VERSION,
    source,
    build_report: { excluded_activity_classes: { ...excludedActivity }, playbooks: playbooksReport },
    entries,
    activity_phrases: activityPhrases,
    session_start,
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
  // Reviewer F4: this is the THIRD violated_pattern read site — same T6
  // dual-read as em-recall/em-pattern-health (typed field ∪ legacy tag, one
  // count per row); sunset the tag leg after the burn-in window (issue #457).
  const cutoff = new Date(nowMs - 30 * DAY).toISOString().slice(0, 10)
  const preflight = {}
  for (const [taskType, patternIds] of Object.entries(TASK_TYPE_PATTERNS)) {
    const counts = {}
    for (const pid of patternIds) {
      const legacyTag = `violated:${pid}` // T6 burn-in shim (legacy tag construction)
      const n = rows.filter(r =>
        r && r.category === 'violation' && r.status !== 'superseded' &&
        (r.violated_pattern === pid ||
          (Array.isArray(r.tags) && r.tags.includes(legacyTag))) &&
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
 *
 * Reviewer F2: the earned band is RECOMPUTED here against the UNION of both
 * stores' rows, so a cross-scope link (local lesson --evidence global
 * violation — legitimate per REQ-6/F1) earns the band a per-store artifact
 * cannot see. The per-store trigger-index.json keeps its per-store band (a
 * cached global artifact must stay deterministic — it cannot depend on
 * whichever local store a caller sits in); every consumer reads THIS merged
 * view, so the band consumers see is the cross-store one. `session_start` is
 * rebuilt from the merged rows for the same reason.
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

  // union of both stores' rows, deduped by id with LOCAL precedence — the row
  // set the cross-store band and the merged session_start are computed from.
  // Read errors degrade to whatever loaded (matching the per-store degrades).
  const mergedRows = []
  const seenRows = new Set()
  for (const scope of ['local', 'global']) {
    let raw = ''
    try {
      const dir = resolveStoreDir({ project, scope })
      raw = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8')
    } catch { continue }
    for (const row of parseRows(raw)) {
      if (!row || typeof row.id !== 'string' || seenRows.has(row.id)) continue
      seenRows.add(row.id)
      mergedRows.push(row)
    }
  }

  // F3 (S2 fix, R1 override clause / R2.9 / T6): a DECLARED override REPLACES the
  // episode's own trigger set within this project. Local playbook rows derived
  // under an override carry triggers_overridden: true; the merged view DROPS the
  // episode's non-playbook (own-phrase) lesson rows for those ids so the matcher
  // never fires the superseded own triggers (T6 E2E data path). Lesson-declared-
  // as-playbook WITHOUT an override keeps both rows (R2.9(b) dedup unchanged). The
  // hook-path sibling (mergeIndexes) is S3 (REQ-6b); this is the CLI/merged leg.
  const overriddenIds = new Set()
  if (local && Array.isArray(local.entries)) {
    for (const e of local.entries) {
      if (e.entry_class === 'playbook' && e.triggers_overridden === true) overriddenIds.add(e.episode_id)
    }
  }

  const seenEpisodes = new Set()
  const entries = []
  for (const idx of [local, global]) { // local first -> local precedence
    if (!idx || !Array.isArray(idx.entries)) continue
    for (const e of idx.entries) {
      if (seenEpisodes.has(e.episode_id)) continue // earlier store won this episode
      // F3: drop the episode's own (superseded) lesson rows when an override is
      // declared; playbook rows for the id always survive (local AND global origin).
      if (e.entry_class !== 'playbook' && overriddenIds.has(e.episode_id)) continue
      // RFC-011 R2: playbook rows are PINNED to effective_priority 0 (sort below
      // every lesson in top-K); do NOT recompute the earned band for them (REQ-8).
      const ep = e.entry_class === 'playbook' ? e.effective_priority : effectivePriority(e.episode_id, mergedRows)
      entries.push({ ...e, effective_priority: ep })
    }
    for (const e of idx.entries) seenEpisodes.add(e.episode_id)
  }
  // RFC-011 R2.7/REQ-8: session_start is rebuilt from merged rows, then the LOCAL
  // persisted playbooks trio is threaded UNCHANGED (global never produces one;
  // neither merge site recomputes any of the three).
  const session_start = buildSessionStart(mergedRows, now)
  const lp = local && local.session_start
  if (lp && Object.prototype.hasOwnProperty.call(lp, 'playbooks')) {
    session_start.playbooks = lp.playbooks
    session_start.playbooks_capped = lp.playbooks_capped
    session_start.playbooks_capped_first = lp.playbooks_capped_first
  }
  return { entries, session_start, local, global }
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
    console.log(JSON.stringify({ status: 'ok', entries: merged.entries, session_start: merged.session_start }))
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
