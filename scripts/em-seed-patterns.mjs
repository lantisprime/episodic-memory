#!/usr/bin/env node
/**
 * em-seed-patterns.mjs — Seed behavioral patterns as global episodes.
 *
 * Usage:
 *   node em-seed-patterns.mjs [--dir <patterns-dir>] [--dry-run]
 *
 * Reads _index.json from the patterns directory, checks for existing
 * episodes by pattern_id tag, and stores new patterns as global episodes.
 * Idempotent — safe to run multiple times.
 *
 * Outputs JSON: { status, seeded, skipped, total }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-seed-patterns.mjs', usage: 'node em-seed-patterns.mjs [--dir <patterns-dir>] [--dry-run]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const patternsDir = flag('--dir') || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'patterns')
const dryRun = argv.includes('--dry-run')

// ---------------------------------------------------------------------------
// Load _index.json
// ---------------------------------------------------------------------------
const indexFile = path.join(patternsDir, '_index.json')
if (!fs.existsSync(indexFile)) {
  console.log(JSON.stringify({ status: 'error', message: `No _index.json found at ${indexFile}` }))
  process.exit(1)
}

let index
try {
  index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid _index.json: ${e.message}` }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Load existing tags.json to check for already-seeded patterns
// ---------------------------------------------------------------------------
const tagsFile = path.join(GLOBAL_DIR, 'tags.json')
let tagsIndex = {}
try {
  tagsIndex = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
} catch {}

// ---------------------------------------------------------------------------
// Parse frontmatter from a pattern .md file
// ---------------------------------------------------------------------------
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const lines = match[1].split('\n')
  const data = {}
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    const arrMatch = raw.match(/^\[(.*)\]$/)
    if (arrMatch) {
      data[key] = arrMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    } else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      data[key] = raw.slice(1, -1)
    } else {
      data[key] = raw === 'null' ? null : raw
    }
  }
  return data
}

function normalizeTags(raw) {
  if (!raw) return []
  const arr = (Array.isArray(raw) ? raw : raw.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(arr)].sort()
}

// Accumulate tag updates in memory, flush once at the end
const pendingTagUpdates = []

function queueTagsUpdate(episodeId, tags) {
  pendingTagUpdates.push({ episodeId, tags })
}

function flushTagsIndex() {
  if (pendingTagUpdates.length === 0) return
  const tagsFile = path.join(GLOBAL_DIR, 'tags.json')
  let idx = {}
  try { idx = JSON.parse(fs.readFileSync(tagsFile, 'utf8')) } catch {}
  for (const { episodeId, tags } of pendingTagUpdates) {
    for (const tag of tags) {
      if (!idx[tag]) idx[tag] = []
      if (!idx[tag].includes(episodeId)) idx[tag].push(episodeId)
    }
  }
  const tmpFile = tagsFile + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(idx, null, 2), 'utf8')
  fs.renameSync(tmpFile, tagsFile)
}

// ---------------------------------------------------------------------------
// Seed patterns
// ---------------------------------------------------------------------------
const episodesDir = path.join(GLOBAL_DIR, 'episodes')
const globalIndexFile = path.join(GLOBAL_DIR, 'index.jsonl')
fs.mkdirSync(episodesDir, { recursive: true })

let seeded = 0
let skipped = 0

for (const entry of index.patterns || []) {
  const { pattern_id, file } = entry

  // Check if already seeded by pattern_id tag
  if (tagsIndex[pattern_id] && tagsIndex[pattern_id].length > 0) {
    skipped++
    continue
  }

  // Read the pattern file
  const filePath = path.join(patternsDir, file)
  if (!fs.existsSync(filePath)) {
    skipped++
    continue
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const fm = parseFrontmatter(content)
  if (!fm) {
    skipped++
    continue
  }

  // Extract body (everything after frontmatter)
  const parts = content.split('---')
  const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''

  const tags = normalizeTags(fm.tags || [])
  const summary = fm.name || entry.name || pattern_id
  const project = 'global'
  const category = fm.category || 'decision'

  if (dryRun) {
    seeded++
    continue
  }

  // Generate episode
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const timeStr = now.toISOString().slice(11, 16)
  const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
  const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const randSuffix = crypto.randomBytes(2).toString('hex')
  const id = `${ts}-${slug}-${randSuffix}`

  const episodeFm = [
    '---',
    `id: ${id}`,
    `date: ${dateStr}`,
    `time: "${timeStr}"`,
    `project: ${project}`,
    `category: ${category}`,
    `status: active`,
    `tags: [${tags.join(', ')}]`,
    `summary: ${summary}`,
    '---',
  ].join('\n')

  const episodeContent = `${episodeFm}\n\n${body}\n`

  // Write episode file
  const episodeFilePath = path.join(episodesDir, `${id}.md`)
  fs.writeFileSync(episodeFilePath, episodeContent, 'utf8')

  // Append to index.jsonl
  const indexEntry = JSON.stringify({
    id, date: dateStr, time: timeStr, project, category,
    status: 'active', supersedes: null, tags, summary
  })
  fs.appendFileSync(globalIndexFile, indexEntry + '\n', 'utf8')

  // Queue tags.json update
  queueTagsUpdate(id, tags)

  seeded++
}

// Flush all tag updates in one atomic write
flushTagsIndex()

const total = (index.patterns || []).length
console.log(JSON.stringify({
  status: 'ok',
  seeded,
  skipped,
  total,
  ...(dryRun ? { dry_run: true } : {})
}))
