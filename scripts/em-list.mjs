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
import { readIndexFileOrThrow, IndexUnreadableError } from './lib/index-state.mjs'
import { compareRecency } from './lib/relevance.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-list.mjs', usage: 'node em-list.mjs [--project <name>] [--limit <n>] [--scope local|global|all] [--include-superseded]' }))
  process.exit(0)
}

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
  const raw = readIndexFileOrThrow(fs, indexFile)
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
  if (e instanceof IndexUnreadableError) {
    console.log(JSON.stringify({ status: 'error', message: `em-list: ${e.message}`, code: `index-unreadable:${e.code}` }))
    process.exit(1)
  }
  throw e
}

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

// Newest first via the shared recency comparator (lib/relevance.mjs): date +
// time, then the id's second-granular HHMMSS stamp, then id (#621 — same-minute
// episodes are otherwise unorderable). Tolerant of foreign-harness rows.
results.sort((a, b) => compareRecency(b, a))
results = results.slice(0, limit)

const output = results.map(({ _source, ...rest }) => ({ ...rest, source: _source }))
console.log(JSON.stringify({ status: 'ok', count: output.length, episodes: output }))
