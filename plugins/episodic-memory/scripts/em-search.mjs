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
if (tag) {
  results = results.filter(e => e.tags && e.tags.includes(tag))
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

console.log(JSON.stringify({ status: 'ok', count: output.length, episodes: output }))
