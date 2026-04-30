#!/usr/bin/env node
/**
 * em-rebuild-index.mjs — Rebuild index.jsonl from episode files.
 *
 * Usage:
 *   node em-rebuild-index.mjs
 *
 * Reads all .md files in ~/.claude/episodic-memory/episodes/,
 * extracts frontmatter, and writes a fresh index.jsonl.
 * Outputs JSON: { status, count }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const DATA_DIR = path.join(os.homedir(), '.claude', 'episodic-memory')
const EPISODES_DIR = path.join(DATA_DIR, 'episodes')
const INDEX_FILE = path.join(DATA_DIR, 'index.jsonl')

/**
 * Parse YAML frontmatter from a markdown string.
 * Handles only the simple subset we produce: scalar values and inline arrays.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const lines = match[1].split('\n')
  const data = {}
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    let value = raw
    // Inline array: [a, b, c]
    const arrMatch = raw.match(/^\[(.*)\]$/)
    if (arrMatch) {
      value = arrMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    }
    // Quoted string
    else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      value = raw.slice(1, -1)
    }
    data[key] = value
  }
  return data
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------
if (!fs.existsSync(EPISODES_DIR)) {
  fs.mkdirSync(EPISODES_DIR, { recursive: true })
  fs.writeFileSync(INDEX_FILE, '', 'utf8')
  console.log(JSON.stringify({ status: 'ok', count: 0 }))
  process.exit(0)
}

const files = fs.readdirSync(EPISODES_DIR).filter(f => f.endsWith('.md')).sort()
const entries = []

for (const file of files) {
  const content = fs.readFileSync(path.join(EPISODES_DIR, file), 'utf8')
  const fm = parseFrontmatter(content)
  if (!fm || !fm.id) continue
  entries.push(JSON.stringify({
    id: fm.id,
    date: fm.date,
    time: fm.time,
    project: fm.project,
    category: fm.category,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    summary: fm.summary
  }))
}

// Atomic write: temp file then rename
const tmpFile = INDEX_FILE + '.tmp'
fs.writeFileSync(tmpFile, entries.join('\n') + (entries.length ? '\n' : ''), 'utf8')
fs.renameSync(tmpFile, INDEX_FILE)

console.log(JSON.stringify({ status: 'ok', count: entries.length }))
