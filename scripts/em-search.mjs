#!/usr/bin/env node
/**
 * em-search.mjs — Search episodic memories with per-project + global fallback.
 *
 * Usage:
 *   node em-search.mjs [--project <name>] [--tag <tag>] [--category <cat>]
 *                      [--query <text>] [--since <YYYY-MM-DD>] [--limit <n>]
 *                      [--scope local|global|all] [--include-superseded]
 *                      [--history <id>] [--full]
 *
 * By default, searches local then global (scope=all) and hides superseded episodes.
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

// Full-text search in episode bodies
if (query) {
  const queryLower = query.toLowerCase()
  results = results.filter(e => {
    if (e.summary.toLowerCase().includes(queryLower)) return true
    const filePath = path.join(e._dataDir, 'episodes', `${e.id}.md`)
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').toLowerCase().includes(queryLower)
    }
    return false
  })
}

// Sort by date descending, apply limit
results.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
results = results.slice(0, limit)

// Optionally include full body, clean internal fields
const output = results.map(e => {
  const { _dataDir, _source, ...rest } = e
  if (full) {
    const filePath = path.join(_dataDir, 'episodes', `${e.id}.md`)
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8')
      const parts = content.split('---')
      const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
      return { ...rest, body, source: _source }
    }
  }
  return { ...rest, source: _source }
})

const result = { status: 'ok', count: output.length, episodes: output }
if (searchWarning) result.warning = searchWarning
console.log(JSON.stringify(result))
