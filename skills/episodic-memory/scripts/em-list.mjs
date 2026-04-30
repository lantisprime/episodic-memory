#!/usr/bin/env node
/**
 * em-list.mjs — List recent episodic memories.
 *
 * Usage:
 *   node em-list.mjs [--project <name>] [--limit <n>]
 *
 * Outputs JSON: { status, count, episodes: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const DATA_DIR = path.join(os.homedir(), '.claude', 'episodic-memory')
const INDEX_FILE = path.join(DATA_DIR, 'index.jsonl')

const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const project = flag('--project')
const limit = parseInt(flag('--limit') || '10', 10)

if (!fs.existsSync(INDEX_FILE)) {
  console.log(JSON.stringify({ status: 'ok', count: 0, episodes: [] }))
  process.exit(0)
}

const lines = fs.readFileSync(INDEX_FILE, 'utf8').trim().split('\n').filter(Boolean)
let results = lines.map(line => {
  try { return JSON.parse(line) } catch { return null }
}).filter(Boolean)

if (project) {
  results = results.filter(e => e.project === project)
}

// Most recent first
results.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
results = results.slice(0, limit)

console.log(JSON.stringify({ status: 'ok', count: results.length, episodes: results }))
