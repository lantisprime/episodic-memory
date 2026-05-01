#!/usr/bin/env node
/**
 * em-search.mjs — Search episodic memories with per-project + global fallback.
 *
 * Usage:
 *   node em-search.mjs [--project <name>] [--tag <tag>] [--category <cat>]
 *                      [--query <text>] [--since <YYYY-MM-DD>] [--limit <n>]
 *                      [--scope local|global|all] [--include-superseded]
 *                      [--history <id>] [--full]
 *                      [--no-score] [--no-track]
 *                      [--warn-time-ms <n>] [--warn-count <n>]
 *
 * By default, searches local then global (scope=all), hides superseded episodes,
 * scores results by relevance, and tracks access.
 * Outputs JSON: { status, count, episodes: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = path.join(process.cwd(), '.episodic-memory')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const project = flag('--project')
const tag = flag('--tag')
const category = flag('--category')
const query = flag('--query')
const since = flag('--since')
const limit = parseInt(flag('--limit') || '10', 10)
const scope = flag('--scope') || 'all'
const full = argv.includes('--full')
const includeSuperseded = argv.includes('--include-superseded')
const historyId = flag('--history')
const noScore = argv.includes('--no-score')
const noTrack = argv.includes('--no-track')
const warnTimeMs = parseInt(flag('--warn-time-ms') || '500', 10)
const warnCount = parseInt(flag('--warn-count') || '500', 10)

const VALID_SCOPES_SEARCH = ['local', 'global', 'all']
if (!VALID_SCOPES_SEARCH.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_SEARCH.join(', ')}` }))
  process.exit(1)
}

const searchStart = Date.now()

function normalizeTags(raw) {
  if (!raw) return []
  const arr = (Array.isArray(raw) ? raw : raw.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(arr)].sort()
}

function loadTagsIndex(dataDir) {
  const tagsFile = path.join(dataDir, 'tags.json')
  try {
    return JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------
function computeScore(entry, textMatchScore) {
  const accessCount = entry.access_count || 0
  // Use new Date(entry.date) for decay — sub-day precision unnecessary
  const created = new Date(entry.date)
  const daysSince = Math.max(0, (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24))
  const timeFactor = Math.max(0.1, 1 - (daysSince / 365))
  const accessFactor = 1 + Math.log1p(accessCount) * 0.1
  return textMatchScore * timeFactor * accessFactor
}

// ---------------------------------------------------------------------------
// Access tracking write-back
// ---------------------------------------------------------------------------
function writeBackAccessTracking(results) {
  // Group results by source data directory
  const byDir = new Map()
  for (const e of results) {
    if (!e._dataDir) continue
    if (!byDir.has(e._dataDir)) byDir.set(e._dataDir, new Set())
    byDir.get(e._dataDir).add(e.id)
  }

  const now = new Date().toISOString().slice(0, 19) + 'Z'

  for (const [dataDir, ids] of byDir) {
    const indexFile = path.join(dataDir, 'index.jsonl')
    try {
      // Re-read just before writing to narrow race window with concurrent em-store appends.
      // This is best-effort — last-writer-wins for concurrent searches is acceptable.
      const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      const updated = lines.map(line => {
        try {
          const entry = JSON.parse(line)
          if (ids.has(entry.id)) {
            entry.access_count = (entry.access_count || 0) + 1
            entry.last_accessed = now
          }
          return JSON.stringify(entry)
        } catch { return line }
      })
      const tmpFile = indexFile + '.tmp'
      fs.writeFileSync(tmpFile, updated.join('\n') + '\n', 'utf8')
      fs.renameSync(tmpFile, indexFile)
    } catch {
      // Access tracking is best-effort — skip silently on failure
    }
  }
}

// ---------------------------------------------------------------------------
// Load index entries from a data directory
// ---------------------------------------------------------------------------
function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try {
      const entry = JSON.parse(line)
      entry._source = source
      entry._dataDir = dataDir
      return entry
    } catch { return null }
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Collect entries based on scope
// ---------------------------------------------------------------------------
let results = []

if (scope === 'local' || scope === 'all') {
  results.push(...loadIndex(LOCAL_DIR, 'local'))
}
if (scope === 'global' || scope === 'all') {
  results.push(...loadIndex(GLOBAL_DIR, 'global'))
}

const totalEpisodeCount = results.length

// Dedupe by id (local takes priority)
const seen = new Set()
results = results.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})

// ---------------------------------------------------------------------------
// History mode: show full revision chain for an episode
// ---------------------------------------------------------------------------
if (historyId) {
  const chain = []
  // Find all episodes in the revision chain
  let currentId = historyId

  // Walk backwards: find what this episode supersedes
  const allEntries = [...results]
  const byId = new Map(allEntries.map(e => [e.id, e]))

  // Find the root of the chain
  let root = byId.get(currentId)
  while (root && root.supersedes) {
    const parent = byId.get(root.supersedes)
    if (!parent) break
    root = parent
  }

  // Walk forward from root
  if (root) {
    chain.push(root)
    const bySupersedes = new Map()
    for (const e of allEntries) {
      if (e.supersedes) bySupersedes.set(e.supersedes, e)
    }
    let current = root
    while (bySupersedes.has(current.id)) {
      current = bySupersedes.get(current.id)
      chain.push(current)
    }
  }

  // Include full body if requested
  const output = chain.map(e => {
    if (full) {
      const filePath = path.join(e._dataDir, 'episodes', `${e.id}.md`)
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8')
        const parts = content.split('---')
        const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
        return { ...e, body, _source: e._source, _dataDir: undefined }
      }
    }
    const { _dataDir, ...rest } = e
    return rest
  })

  // No access tracking for history queries (investigative, not usage signals)
  console.log(JSON.stringify({ status: 'ok', count: output.length, chain: output }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Apply filters
// ---------------------------------------------------------------------------
if (!includeSuperseded) {
  results = results.filter(e => e.status !== 'superseded')
}
if (project) {
  results = results.filter(e => e.project === project)
}
let searchWarning = null
if (tag) {
  const normalizedTag = normalizeTags(tag)[0]
  if (normalizedTag) {
    // Try tags.json from all active scopes
    let tagIds = null
    const dirs = []
    if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
    if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
    for (const dir of dirs) {
      const idx = loadTagsIndex(dir)
      if (idx && idx[normalizedTag]) {
        if (!tagIds) tagIds = new Set()
        for (const id of idx[normalizedTag]) tagIds.add(id)
      } else if (!idx) {
        searchWarning = 'tags.json missing or corrupt. Run em-rebuild-index.mjs to regenerate.'
      }
    }
    if (tagIds) {
      results = results.filter(e => tagIds.has(e.id))
    } else {
      // Fallback: linear scan with normalized comparison
      if (!searchWarning) searchWarning = 'tags.json missing or does not contain tag. Falling back to linear scan. Run em-rebuild-index.mjs to regenerate.'
      results = results.filter(e => e.tags && e.tags.map(t => t.toLowerCase().trim()).includes(normalizedTag))
    }
  }
}
if (category) {
  results = results.filter(e => e.category === category)
}
if (since) {
  results = results.filter(e => e.date >= since)
}

// Full-text search in episode bodies + compute text_match scores
const queryLower = query ? query.toLowerCase() : null
if (query) {
  results = results.filter(e => {
    const summaryLower = (e.summary || '').toLowerCase()
    if (summaryLower.includes(queryLower)) {
      e._textMatch = summaryLower === queryLower ? 1.0 : 0.7
      return true
    }
    const filePath = path.join(e._dataDir, 'episodes', `${e.id}.md`)
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8')
      if (content.toLowerCase().includes(queryLower)) {
        e._textMatch = 0.4
        if (full) e._body = content
        return true
      }
    }
    return false
  })
}

// ---------------------------------------------------------------------------
// Score and sort
// ---------------------------------------------------------------------------
if (!noScore) {
  for (const e of results) {
    const textMatch = e._textMatch || 1.0
    e._score = computeScore(e, textMatch)
  }
  results.sort((a, b) => b._score - a._score)
} else {
  // No scoring — keep date-based sort
  results.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
}

// Apply limit AFTER scoring/sorting
results = results.slice(0, limit)

// ---------------------------------------------------------------------------
// Access tracking write-back
// Skip for: --no-track, --include-superseded (investigative queries)
// ---------------------------------------------------------------------------
if (!noTrack && !includeSuperseded) {
  writeBackAccessTracking(results)
}

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------
const output = results.map(e => {
  const { _dataDir, _source, _textMatch, _score, _body, ...rest } = e
  const entry = { ...rest, source: _source }
  if (!noScore && _score !== undefined) {
    entry.score = Math.round(_score * 1000) / 1000
  }
  if (full) {
    const content = _body || (() => {
      const filePath = path.join(_dataDir, 'episodes', `${e.id}.md`)
      try { return fs.readFileSync(filePath, 'utf8') } catch { return null }
    })()
    if (content) {
      const parts = content.split('---')
      const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
      entry.body = body
    }
  }
  return entry
})

const result = { status: 'ok', count: output.length, episodes: output }

// Performance health check
const elapsed = Date.now() - searchStart
const warnings = []
if (searchWarning) warnings.push(searchWarning)
if (elapsed > warnTimeMs) {
  warnings.push(`Search took ${elapsed}ms across ${totalEpisodeCount} episodes. Consider running em-prune.mjs to archive stale episodes.`)
}
if (totalEpisodeCount > warnCount) {
  warnings.push(`${totalEpisodeCount} episodes in index. Performance may degrade. Run em-prune.mjs --dry-run to check for prunable episodes.`)
}
if (warnings.length) result.warning = warnings.join(' | ')

console.log(JSON.stringify(result))
