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

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = path.join(process.cwd(), '.episodic-memory')

const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const maxDays = parseInt(flag('--days') || '30', 10)
const project = flag('--project')
const scope = flag('--scope') || 'all'

// #651: lstat-based index existence classifier, inlined (no lib/ in this
// vendored copy). absent -> null (loadIndex returns []); unreadable (symlink
// loop/dangling, EACCES parent, FIFO/socket/device, EISDIR, or a read
// failure) -> throws with .code, so the caller aborts typed instead of
// silently degrading or blocking forever on an unguarded FIFO read.
function classifyIndexFile(filePath) {
  let st
  try { st = fs.lstatSync(filePath) } catch (e) {
    if (e && e.code === 'ENOENT') {
      const dir = path.dirname(filePath)
      let dirStat
      try { dirStat = fs.lstatSync(dir) } catch (e2) {
        return (e2 && e2.code === 'ENOENT') ? { state: 'absent' } : { state: 'unreadable', code: (e2 && e2.code) || 'UNKNOWN' }
      }
      if (dirStat.isSymbolicLink()) {
        try { fs.statSync(dir) } catch (e3) { return { state: 'unreadable', code: (e3 && e3.code) || 'UNKNOWN' } }
      }
      return { state: 'absent' }
    }
    return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN' }
  }
  if (st.isSymbolicLink()) {
    try { st = fs.statSync(filePath) } catch (e) { return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN' } }
  }
  if (st.isDirectory()) return { state: 'unreadable', code: 'EISDIR' }
  if (!st.isFile()) return { state: 'unreadable', code: 'ENOTREG' }
  return { state: 'ok' }
}

function readIndexOrThrow(filePath) {
  const c = classifyIndexFile(filePath)
  if (c.state === 'absent') return null
  if (c.state === 'unreadable') {
    const err = new Error(`episode index unreadable (${c.code}) (${filePath})`)
    err.code = c.code
    throw err
  }
  try { return fs.readFileSync(filePath, 'utf8') } catch (e) {
    const err = new Error(`episode index unreadable (${(e && e.code) || 'UNKNOWN'}) (${filePath})`)
    err.code = (e && e.code) || 'UNKNOWN'
    throw err
  }
}

function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  const raw = readIndexOrThrow(indexFile)
  if (raw === null) return []
  return raw.trim().split('\n').filter(Boolean).map(line => {
    try {
      const entry = JSON.parse(line)
      entry._source = source
      return entry
    } catch { return null }
  }).filter(Boolean)
}

let results = []
try {
  if (scope === 'local' || scope === 'all') results.push(...loadIndex(LOCAL_DIR, 'local'))
  if (scope === 'global' || scope === 'all') results.push(...loadIndex(GLOBAL_DIR, 'global'))
} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: `em-check-stale: ${e.message}` }))
  process.exit(1)
}

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
