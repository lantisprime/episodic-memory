#!/usr/bin/env node
/**
 * em-list.mjs — List recent episodic memories.
 *
 * Usage:
 *   node em-list.mjs [--project <name>] [--limit <n>] [--scope local|global|all]
 *                    [--include-superseded]
 *
 * Outputs JSON: { status, count, episodes: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const project = flag('--project')
const limit = parseInt(flag('--limit') || '10', 10)
const scope = flag('--scope') || 'all'
const includeSuperseded = argv.includes('--include-superseded')

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

// Dedupe by id (local takes priority)
const seen = new Set()
results = results.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})

if (!includeSuperseded) {
  results = results.filter(e => e.status !== 'superseded')
}
if (project) {
  results = results.filter(e => e.project === project)
}

// Sort key tolerant of foreign-harness index rows (hand-appended without
// em-store): only string-typed fields participate. A non-string date (absent,
// null, numeric) would either crash (NaN.localeCompare) or, stringified,
// out-sort ISO keys ("20260703" > "2026-07-04..."); time joins only when date
// is a string so a time-only key like "23:59" cannot beat ISO date keys.
// Rows without a string date get key '' and sort last in descending order.
const dtKey = e => typeof e.date === 'string' ? e.date + (typeof e.time === 'string' ? e.time : '') : ''
results.sort((a, b) => dtKey(b).localeCompare(dtKey(a)))
results = results.slice(0, limit)

const output = results.map(({ _source, ...rest }) => ({ ...rest, source: _source }))
console.log(JSON.stringify({ status: 'ok', count: output.length, episodes: output }))
