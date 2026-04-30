#!/usr/bin/env node
/**
 * em-search.mjs — Search episodic memories by project, tag, category, keyword, or date.
 *
 * Usage:
 *   node em-search.mjs [--project <name>] [--tag <tag>] [--category <cat>]
 *                       [--query <text>] [--since <YYYY-MM-DD>] [--limit <n>]
 *                       [--full]
 *
 * Searches index.jsonl for matching episodes. With --query, also greps episode bodies.
 * With --full, includes the full body of each matching episode.
 * Outputs JSON: { status, count, episodes: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const DATA_DIR = path.join(os.homedir(), '.claude', 'episodic-memory')
const EPISODES_DIR = path.join(DATA_DIR, 'episodes')
const INDEX_FILE = path.join(DATA_DIR, 'index.jsonl')

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
const full = argv.includes('--full')

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
if (!fs.existsSync(INDEX_FILE)) {
  console.log(JSON.stringify({ status: 'ok', count: 0, episodes: [] }))
  process.exit(0)
}

const lines = fs.readFileSync(INDEX_FILE, 'utf8').trim().split('\n').filter(Boolean)
let results = lines.map(line => {
  try { return JSON.parse(line) } catch { return null }
}).filter(Boolean)

// Apply filters
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
    // Check summary first
    if (e.summary.toLowerCase().includes(queryLower)) return true
    // Check body
    const filePath = path.join(EPISODES_DIR, `${e.id}.md`)
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').toLowerCase()
      return content.includes(queryLower)
    }
    return false
  })
}

// Sort by date descending, apply limit
results.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
results = results.slice(0, limit)

// Optionally include full body
if (full) {
  results = results.map(e => {
    const filePath = path.join(EPISODES_DIR, `${e.id}.md`)
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8')
      // Extract body (everything after the closing ---)
      const parts = content.split('---')
      const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
      return { ...e, body }
    }
    return e
  })
}

console.log(JSON.stringify({ status: 'ok', count: results.length, episodes: results }))
