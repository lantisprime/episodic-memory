#!/usr/bin/env node
/**
 * em-prune.mjs — Archive stale episodes below a relevance threshold.
 *
 * Usage:
 *   node em-prune.mjs [--scope local|global|all] [--threshold <n>]
 *                     [--dry-run] [--check]
 *
 * Prune score (query-independent):
 *   max(0.1, 1 - (days_since_creation / 365)) * (1 + log1p(access_count) * 0.1)
 *
 * At default threshold 0.15, episodes become prunable at ~310 days with 0 accesses.
 *
 * Superseded episodes are scored identically to active ones — they are not pruned
 * more aggressively. This is deliberate: superseded episodes participate in revision
 * chains (--history) and may be needed for provenance even when old.
 *
 * --dry-run: preview what would be archived (no file moves)
 * --check:  report count only, exit 1 if prunable episodes exist (for CI/hooks)
 *
 * Outputs JSON: { status, pruned, remaining, freed_bytes } or dry-run equivalent.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-prune.mjs', usage: 'node em-prune.mjs [--scope local|global|all] [--threshold <n>] [--dry-run] [--check] — RFC-009 R6 protection: evidence-linked violations, trigger-bearing lessons, consolidates members, and the latest clerk run record are never archived (see protected / protected_episodes output fields)' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'all'
const VALID_SCOPES_PRUNE = ['local', 'global', 'all']
if (!VALID_SCOPES_PRUNE.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_PRUNE.join(', ')}` }))
  process.exit(1)
}
const threshold = parseFloat(flag('--threshold') || '0.15')
const dryRun = argv.includes('--dry-run')
const checkOnly = argv.includes('--check')

function computePruneScore(entry) {
  const accessCount = entry.access_count || 0
  const created = new Date(entry.date)
  const daysSince = Math.max(0, (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24))
  const timeFactor = Math.max(0.1, 1 - (daysSince / 365))
  const accessFactor = 1 + Math.log1p(accessCount) * 0.1
  return timeFactor * accessFactor
}

const TODAY = new Date().toISOString().slice(0, 10)

function loadIndexRows(dataDir, storeLabel) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  const out = []
  for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      e._store = storeLabel
      out.push(e)
    } catch {}
  }
  return out
}

function stringItems(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
}

// RFC-009 R6 referencer validity: protection lapses when the referencing episode
// is superseded or expired. A row with NO status field is a valid referencer (the
// tolerated hand-written-writer class, #447); a malformed review_by never expires.
function isValidReferencer(row, todayStr) {
  if (!row || row.status === 'superseded') return false
  const rb = row.review_by
  if (typeof rb === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rb) && rb < todayStr) return false
  return true
}

// RFC-009 R6 protection set. rows = UNION of both stores' index rows (deliberately
// NO id-dedupe: a stale superseded copy in one store must not shadow an active
// referencer in the other). Returns Map<id, {reason, via}>; first-set reason wins in
// the order: evidence-linked-violation, trigger-bearing-lesson, consolidates-member,
// latest-run-record, chain-member.
function computeProtectedIds(rows, todayStr) {
  const map = new Map()
  const set = (id, reason, via) => { if (typeof id === 'string' && !map.has(id)) map.set(id, { reason, via }) }
  const lessonRowsById = new Map()
  for (const r of rows) {
    if (r.category === 'lesson' && typeof r.id === 'string') {
      if (!lessonRowsById.has(r.id)) lessonRowsById.set(r.id, [])
      lessonRowsById.get(r.id).push(r)
    }
  }
  // class a, forward: valid lesson's evidence names violations
  for (const r of rows) {
    if (r.category !== 'lesson' || !isValidReferencer(r, todayStr)) continue
    for (const vid of stringItems(r.evidence)) set(vid, 'evidence-linked-violation', r.id)
  }
  // class a, back-link: violation.lessons names a valid lesson (in ANY store)
  for (const r of rows) {
    if (r.category !== 'violation' || typeof r.id !== 'string') continue
    for (const lid of stringItems(r.lessons)) {
      const cands = lessonRowsById.get(lid) || []
      if (cands.some(l => isValidReferencer(l, todayStr))) {
        set(r.id, 'evidence-linked-violation', lid)
        break
      }
    }
  }
  // class b: valid trigger-bearing lessons protect themselves
  for (const r of rows) {
    if (r.category !== 'lesson' || typeof r.id !== 'string') continue
    if (!isValidReferencer(r, todayStr)) continue
    if (stringItems(r.triggers).length > 0) set(r.id, 'trigger-bearing-lesson', r.id)
  }
  // class c: consolidates members of valid referencers
  for (const r of rows) {
    if (typeof r.id !== 'string' || !isValidReferencer(r, todayStr)) continue
    for (const mid of stringItems(r.consolidates)) set(mid, 'consolidates-member', r.id)
  }
  // class d: latest clerk run record per store (max id; ids sort chronologically)
  const latestByStore = new Map()
  for (const r of rows) {
    if (r.record_type !== 'clerk-run' || typeof r.id !== 'string') continue
    const cur = latestByStore.get(r._store)
    if (!cur || r.id > cur) latestByStore.set(r._store, r.id)
  }
  for (const id of latestByStore.values()) set(id, 'latest-run-record', id)
  // chain closure over class a/b/c anchors (NOT class d): backward via each row's
  // `supersedes`, forward via INVERTED supersedes edges (superseded_by has no
  // substrate writer today) plus `superseded_by` strings when present. An archived
  // intermediate would silently break R2's chain-resolved band counting.
  const rowsById = new Map()
  const successorsOf = new Map() // supersededId -> [successor ids]
  for (const r of rows) {
    if (typeof r.id !== 'string') continue
    if (!rowsById.has(r.id)) rowsById.set(r.id, [])
    rowsById.get(r.id).push(r)
    if (typeof r.supersedes === 'string') {
      if (!successorsOf.has(r.supersedes)) successorsOf.set(r.supersedes, [])
      successorsOf.get(r.supersedes).push(r.id)
    }
  }
  const anchorOf = new Map()
  const queue = []
  for (const [id, v] of map.entries()) {
    if (v.reason === 'latest-run-record') continue
    anchorOf.set(id, id)
    queue.push(id)
  }
  const visited = new Set(queue)
  while (queue.length) {
    const id = queue.shift()
    const neighbors = []
    for (const r of rowsById.get(id) || []) {
      if (typeof r.supersedes === 'string') neighbors.push(r.supersedes)
      if (typeof r.superseded_by === 'string') neighbors.push(r.superseded_by)
    }
    for (const succ of successorsOf.get(id) || []) neighbors.push(succ)
    for (const n of neighbors) {
      if (visited.has(n)) continue
      visited.add(n)
      anchorOf.set(n, anchorOf.get(id))
      set(n, 'chain-member', anchorOf.get(id))
      queue.push(n)
    }
  }
  return map
}

function loadTagsIndex(dataDir) {
  const tagsFile = path.join(dataDir, 'tags.json')
  try {
    return JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  } catch {
    return {}
  }
}

function pruneDir(dataDir, label, protectedIds) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  const episodesDir = path.join(dataDir, 'episodes')
  const archivedDir = path.join(dataDir, 'archived')
  const archivedIndexFile = path.join(dataDir, 'archived-index.jsonl')

  if (!fs.existsSync(indexFile)) {
    return { scope: label, pruned: 0, remaining: 0, freed_bytes: 0, protected: 0, episodes: [] }
  }

  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
  const entries = lines.map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)

  const toPrune = []
  const toKeep = []
  const protectedEntries = []

  // R6: protection is decided HERE, in the one selection loop every mode shares
  // (check / dry-run / real prune) — the mode branches below only format the
  // already-decided sets. Partition: entries = toKeep (incl. protected) + toPrune.
  for (const entry of entries) {
    const score = computePruneScore(entry)
    if (score < threshold) {
      const p = protectedIds.get(entry.id)
      if (p) {
        toKeep.push(entry)
        protectedEntries.push({ id: entry.id, score: Math.round(score * 1000) / 1000, reason: p.reason, via: p.via })
      } else {
        toPrune.push({ ...entry, _pruneScore: score })
      }
    } else {
      toKeep.push(entry)
    }
  }

  if (checkOnly) {
    return { scope: label, prunable: toPrune.length, remaining: toKeep.length, protected: protectedEntries.length }
  }

  if (dryRun) {
    let totalSize = 0
    const preview = toPrune.map(e => {
      const filePath = path.join(episodesDir, `${e.id}.md`)
      let size = 0
      try { size = fs.statSync(filePath).size } catch {}
      totalSize += size
      return { id: e.id, score: Math.round(e._pruneScore * 1000) / 1000, size }
    })
    return { scope: label, prunable: toPrune.length, remaining: toKeep.length, freed_bytes: totalSize, protected: protectedEntries.length, protected_episodes: protectedEntries, episodes: preview }
  }

  // Actual prune
  if (toPrune.length === 0) {
    return { scope: label, pruned: 0, remaining: toKeep.length, freed_bytes: 0, protected: protectedEntries.length }
  }

  fs.mkdirSync(archivedDir, { recursive: true })

  let freedBytes = 0
  const archivedEntries = []

  for (const entry of toPrune) {
    const srcFile = path.join(episodesDir, `${entry.id}.md`)
    const dstFile = path.join(archivedDir, `${entry.id}.md`)
    try {
      const stat = fs.statSync(srcFile)
      freedBytes += stat.size
      fs.renameSync(srcFile, dstFile)
    } catch {}
    const { _pruneScore, ...clean } = entry
    archivedEntries.push(JSON.stringify(clean))
  }

  // Update index.jsonl — keep only non-pruned entries
  const tmpIndex = indexFile + '.tmp'
  fs.writeFileSync(tmpIndex, toKeep.map(e => JSON.stringify(e)).join('\n') + (toKeep.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmpIndex, indexFile)

  // Update tags.json — remove pruned episode IDs
  const prunedIds = new Set(toPrune.map(e => e.id))
  const tagsIndex = loadTagsIndex(dataDir)
  for (const tag of Object.keys(tagsIndex)) {
    tagsIndex[tag] = tagsIndex[tag].filter(id => !prunedIds.has(id))
    if (tagsIndex[tag].length === 0) delete tagsIndex[tag]
  }
  const tagsFile = path.join(dataDir, 'tags.json')
  const tagsTmp = tagsFile + '.tmp'
  fs.writeFileSync(tagsTmp, JSON.stringify(tagsIndex, null, 2), 'utf8')
  fs.renameSync(tagsTmp, tagsFile)

  // Append to archived-index.jsonl (read-merge-write, preserves previous prune runs)
  // Note: prune has a read-rewrite race with em-store.mjs (same pattern as search write-back).
  // A concurrent append between read and rename could lose the appended entry. This is a known
  // limitation — prune is a maintenance operation, not a hot path.
  const existingArchived = fs.existsSync(archivedIndexFile) ? fs.readFileSync(archivedIndexFile, 'utf8') : ''
  const archivedTmp = archivedIndexFile + '.tmp'
  fs.writeFileSync(archivedTmp, existingArchived + archivedEntries.join('\n') + '\n', 'utf8')
  fs.renameSync(archivedTmp, archivedIndexFile)

  return { scope: label, pruned: toPrune.length, remaining: toKeep.length, freed_bytes: freedBytes, protected: protectedEntries.length }
}

// R6 reference scan: UNION of both stores regardless of prune scope — a global
// lesson's evidence can name a local violation. Deliberately NO id-dedupe (the
// search-side local-precedence convention would let a stale superseded copy
// shadow an active referencer). Like the archived-index append race below, the
// scan-to-archive window is a documented limitation: an episode stored mid-prune
// protects one run late (recovery: em-restore / archived-index).
const referenceRows = [...loadIndexRows(LOCAL_DIR, 'local'), ...loadIndexRows(GLOBAL_DIR, 'global')]
const protectedIds = computeProtectedIds(referenceRows, TODAY)

const results = []
if (scope === 'local' || scope === 'all') results.push(pruneDir(LOCAL_DIR, 'local', protectedIds))
if (scope === 'global' || scope === 'all') results.push(pruneDir(GLOBAL_DIR, 'global', protectedIds))

const totalPruned = results.reduce((sum, r) => sum + (r.pruned || r.prunable || 0), 0)

if (checkOnly) {
  console.log(JSON.stringify({ status: 'ok', results }))
  process.exit(totalPruned > 0 ? 1 : 0)
}

console.log(JSON.stringify({ status: 'ok', results }))
