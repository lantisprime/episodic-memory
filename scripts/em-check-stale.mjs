#!/usr/bin/env node
/**
 * em-check-stale.mjs — Find research episodes with outdated content.
 *
 * Usage:
 *   node em-check-stale.mjs [--days <n>] [--project <name>] [--scope local|global|all]
 *
 * Lists research episodes where the source URL was fetched more than N days ago
 * (default: 30). The AI should re-fetch these URLs and revise if content has changed.
 *
 * Outputs JSON: { status, count, stale: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-check-stale.mjs', usage: 'node em-check-stale.mjs [--days <n>] [--project <name>] [--scope local|global|all]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const maxDays = parseInt(flag('--days') || '30', 10)
const project = flag('--project')
const scope = flag('--scope') || 'all'

function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try {
      const entry = JSON.parse(line)
      entry._source = source
      return entry
    } catch { return null }
  }).filter(Boolean)
}

let results = []
if (scope === 'local' || scope === 'all') results.push(...loadIndex(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') results.push(...loadIndex(GLOBAL_DIR, 'global'))

// Dedupe
const seen = new Set()
results = results.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})

// Filter: only active research episodes with URLs
results = results.filter(e =>
  e.status !== 'superseded' &&
  e.category === 'research' &&
  e.url
)

if (project) {
  results = results.filter(e => e.project === project)
}

// Check staleness
const now = new Date()
const cutoff = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000)
const cutoffStr = cutoff.toISOString().slice(0, 10)

const stale = results
  .filter(e => {
    const fetched = e.fetched || e.date
    return fetched < cutoffStr
  })
  .sort((a, b) => (a.fetched || a.date).localeCompare(b.fetched || b.date))
  .map(({ _source, ...rest }) => ({
    ...rest,
    source: _source,
    daysOld: Math.floor((now - new Date(rest.fetched || rest.date)) / (24 * 60 * 60 * 1000))
  }))

console.log(JSON.stringify({ status: 'ok', count: stale.length, stale }))
