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
import { categoryLifecycle, canonicalCategory } from './lib/categories.mjs'
import { computeProtectedIds, resolvePlaybookProtection } from './lib/protection.mjs'
import { resolveRegisteredStoresWithStatus } from './lib/registered-stores.mjs'
import { acquireStoreWriteLocksSync, releaseStoreWriteLocks, atomicReplaceFileSync } from './lib/store-write-lock.mjs'

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


function loadInvertedIndex(dataDir, fileName) {
  const indexPath = path.join(dataDir, fileName)
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  } catch {
    return {}
  }
}

function partitionPrunable(dataDir, protectedIds) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) {
    return { missing: true, entries: [], toPrune: [], toKeep: [], protectedEntries: [] }
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
    // R10e override (checked BEFORE the score AND the R6 protection lookup): a consumed
    // aggregate-then-prune (temporary) member — one carrying superseded_by, i.e. an R9 apply
    // folded it into a consolidated successor — is aggressively prunable even if it sits in that
    // successor's `consolidates` array (R6 class-c would otherwise protect it). The member's own
    // lifecycle wins (RFC R10e "the consumed members are not [protected]"). A temporary WITHOUT
    // superseded_by falls through to the standard score below; the R6 protection set CODE (P0) is
    // untouched. categoryLifecycle degrades to null on an unloadable vocab, so the override no-ops
    // and prune behaves exactly as pre-R10 (B1).
    if (categoryLifecycle(canonicalCategory(entry.category)) === 'aggregate-then-prune' && typeof entry.superseded_by === 'string') {
      toPrune.push({ ...entry, _pruneScore: 0 })
      continue
    }
    const score = computePruneScore(entry)
    if (score < threshold) {
      const p = protectedIds.get(String(entry.id))
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

  return { missing: false, entries, toPrune, toKeep, protectedEntries }
}

function pruneDir(dataDir, label, protectedIds) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  const episodesDir = path.join(dataDir, 'episodes')
  const archivedDir = path.join(dataDir, 'archived')
  const archivedIndexFile = path.join(dataDir, 'archived-index.jsonl')
  const initial = partitionPrunable(dataDir, protectedIds)

  if (initial.missing) {
    return { scope: label, pruned: 0, remaining: 0, freed_bytes: 0, protected: 0, episodes: [] }
  }

  if (checkOnly) {
    return { scope: label, prunable: initial.toPrune.length, remaining: initial.toKeep.length, protected: initial.protectedEntries.length }
  }

  if (dryRun) {
    let totalSize = 0
    const preview = initial.toPrune.map(e => {
      const filePath = path.join(episodesDir, `${e.id}.md`)
      let size = 0
      try { size = fs.statSync(filePath).size } catch {}
      totalSize += size
      return { id: e.id, score: Math.round(e._pruneScore * 1000) / 1000, size }
    })
    return { scope: label, prunable: initial.toPrune.length, remaining: initial.toKeep.length, freed_bytes: totalSize, protected: initial.protectedEntries.length, protected_episodes: initial.protectedEntries, episodes: preview }
  }

  // A true no-op is lock-free. If the unlocked preview found work, acquire
  // the canonical store lock and repeat the mutable-state read before the
  // first archive/index write (Issue 546 REQ-8).
  if (initial.toPrune.length === 0) {
    return { scope: label, pruned: 0, remaining: initial.toKeep.length, freed_bytes: 0, protected: initial.protectedEntries.length }
  }

  const lockResult = acquireStoreWriteLocksSync(dataDir)
  if (!lockResult.ok) {
    const error = new Error(`em-prune: ${lockResult.code}`)
    error.code = lockResult.code
    error.heldBy = lockResult.heldBy
    throw error
  }

  try {
    const current = partitionPrunable(dataDir, protectedIds)
    const { toPrune, toKeep, protectedEntries } = current
    if (current.missing || toPrune.length === 0) {
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

    // Update index.jsonl — keep only non-pruned entries.
    atomicReplaceFileSync(indexFile, toKeep.map(e => JSON.stringify(e)).join('\n') + (toKeep.length ? '\n' : ''))

    // Remove pruned IDs from every present inverted index. Keeping category
    // and token postings in step with index.jsonl is part of the transaction,
    // not a later rebuild obligation.
    const prunedIds = new Set(toPrune.map(e => e.id))
    for (const [fileName, pretty] of [['tags.json', true], ['category-index.json', true], ['tokens.json', false]]) {
      const indexPath = path.join(dataDir, fileName)
      if (!fs.existsSync(indexPath)) continue
      const inverted = loadInvertedIndex(dataDir, fileName)
      for (const key of Object.keys(inverted)) {
        if (!Array.isArray(inverted[key])) continue
        inverted[key] = inverted[key].filter(id => !prunedIds.has(id))
        if (inverted[key].length === 0) delete inverted[key]
      }
      atomicReplaceFileSync(indexPath, JSON.stringify(inverted, ...(pretty ? [null, 2] : [])))
    }

    // Read-merge-replace archived-index while still holding the same lock.
    const existingArchived = fs.existsSync(archivedIndexFile) ? fs.readFileSync(archivedIndexFile, 'utf8') : ''
    atomicReplaceFileSync(archivedIndexFile, existingArchived + archivedEntries.join('\n') + '\n')

    return { scope: label, pruned: toPrune.length, remaining: toKeep.length, freed_bytes: freedBytes, protected: protectedEntries.length }
  } finally {
    releaseStoreWriteLocks(lockResult.handles)
  }
}

// R6 reference scan: UNION of both stores regardless of prune scope — a global
// lesson's evidence can name a local violation. Deliberately NO id-dedupe (the
// search-side local-precedence convention would let a stale superseded copy
// shadow an active referencer). Like the archived-index append race below, the
// scan-to-archive window is a documented limitation: an episode stored mid-prune
// protects one run late (recovery: em-restore / archived-index).
const referenceRows = [...loadIndexRows(LOCAL_DIR, 'local'), ...loadIndexRows(GLOBAL_DIR, 'global')]

// RFC-011 R5(b): playbook-referenced chain protection + SCOPED fail-closed abort.
// The registry is consulted ONLY when the GLOBAL store is being archived, so a
// sibling project's corrupt playbooks.json can never abort an unrelated LOCAL
// prune (scoped blast radius). LOCAL archival aborts only on the LOCAL corrupt
// playbooks.json; absent file = normal. An abort exits 1 and archives NOTHING,
// naming the offending file (fail direction inverts the advisory rule; retention
// fails closed). parsePlaybooksConfig (S2 single source of truth) is imported by
// resolvePlaybookProtection — never re-implemented here.
const willArchiveLocal = scope === 'local' || scope === 'all'
const willArchiveGlobal = scope === 'global' || scope === 'all'
let registryStores = [], registryRebuilt = false, registryPathUsed = null
if (willArchiveGlobal) {
  const reg = resolveRegisteredStoresWithStatus({ globalDir: GLOBAL_DIR })
  registryStores = reg.stores
  registryRebuilt = reg.registryRebuilt
  registryPathUsed = reg.registryPath
}
const { abort: pbAbort, playbookIds } = resolvePlaybookProtection({
  localStoreDir: LOCAL_DIR,
  willArchiveLocal,
  registryStores,
  registryRebuilt,
  registryPath: registryPathUsed,
})
if (pbAbort) {
  console.log(JSON.stringify({ status: 'error', message: `em-prune: aborting archival — ${pbAbort.reason} (${pbAbort.file})` }))
  process.exit(1)
}
const protectedIds = computeProtectedIds(referenceRows, TODAY, playbookIds)

const results = []
try {
  if (scope === 'local' || scope === 'all') results.push(pruneDir(LOCAL_DIR, 'local', protectedIds))
  if (scope === 'global' || scope === 'all') results.push(pruneDir(GLOBAL_DIR, 'global', protectedIds))
} catch (error) {
  if (error?.code === 'store-write-lock-timeout') {
    console.log(JSON.stringify({ status: 'error', code: error.code, heldBy: error.heldBy, message: error.message }))
    process.exit(1)
  }
  throw error
}

const totalPruned = results.reduce((sum, r) => sum + (r.pruned || r.prunable || 0), 0)

if (checkOnly) {
  console.log(JSON.stringify({ status: 'ok', results }))
  process.exit(totalPruned > 0 ? 1 : 0)
}

console.log(JSON.stringify({ status: 'ok', results }))
