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

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = path.join(process.cwd(), '.episodic-memory')

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'all'
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

function loadTagsIndex(dataDir) {
  const tagsFile = path.join(dataDir, 'tags.json')
  try {
    return JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  } catch {
    return {}
  }
}

function pruneDir(dataDir, label) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  const episodesDir = path.join(dataDir, 'episodes')
  const archivedDir = path.join(dataDir, 'archived')
  const archivedIndexFile = path.join(dataDir, 'archived-index.jsonl')

  if (!fs.existsSync(indexFile)) {
    return { scope: label, pruned: 0, remaining: 0, freed_bytes: 0, episodes: [] }
  }

  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
  const entries = lines.map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)

  const toPrune = []
  const toKeep = []

  for (const entry of entries) {
    const score = computePruneScore(entry)
    if (score < threshold) {
      toPrune.push({ ...entry, _pruneScore: score })
    } else {
      toKeep.push(entry)
    }
  }

  if (checkOnly) {
    return { scope: label, prunable: toPrune.length, remaining: toKeep.length }
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
    return { scope: label, prunable: toPrune.length, remaining: toKeep.length, freed_bytes: totalSize, episodes: preview }
  }

  // Actual prune
  if (toPrune.length === 0) {
    return { scope: label, pruned: 0, remaining: toKeep.length, freed_bytes: 0 }
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

  return { scope: label, pruned: toPrune.length, remaining: toKeep.length, freed_bytes: freedBytes }
}

const results = []
if (scope === 'local' || scope === 'all') results.push(pruneDir(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') results.push(pruneDir(GLOBAL_DIR, 'global'))

const totalPruned = results.reduce((sum, r) => sum + (r.pruned || r.prunable || 0), 0)

if (checkOnly) {
  console.log(JSON.stringify({ status: 'ok', results }))
  process.exit(totalPruned > 0 ? 1 : 0)
}

console.log(JSON.stringify({ status: 'ok', results }))
