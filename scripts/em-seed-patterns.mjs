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
import { nullProtoIndex, episodeTokens, TOKENS_DROPPED_KEY } from './lib/relevance.mjs'
import { acquireStoreWriteLocksSync, releaseStoreWriteLocks, atomicReplaceFileSync } from './lib/store-write-lock.mjs'

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
// Null-proto: a pattern_id/tag named "constructor" must not resolve to
// Object.prototype — the inherited function reads as "already seeded" (issue #469)
let tagsIndex = Object.create(null)
try {
  tagsIndex = nullProtoIndex(JSON.parse(fs.readFileSync(tagsFile, 'utf8')))
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
  let idx = Object.create(null)
  try { idx = nullProtoIndex(JSON.parse(fs.readFileSync(tagsFile, 'utf8'))) } catch {}
  for (const { episodeId, tags } of pendingTagUpdates) {
    for (const tag of tags) {
      if (!idx[tag]) idx[tag] = []
      if (!idx[tag].includes(episodeId)) idx[tag].push(episodeId)
    }
  }
  atomicReplaceFileSync(tagsFile, JSON.stringify(idx, null, 2))
}

// Mirror of the tags flush for category-index.json (R10d). Without this a
// fresh install seeds patterns with NO category index, so every search on the
// new store degrades to the linear-scan fallback until a manual rebuild.
const pendingCategoryUpdates = []

function queueCategoryUpdate(episodeId, category) {
  pendingCategoryUpdates.push({ episodeId, category })
}

function flushCategoryIndex() {
  if (pendingCategoryUpdates.length === 0) return
  const catFile = path.join(GLOBAL_DIR, 'category-index.json')
  let idx = Object.create(null)
  try { idx = nullProtoIndex(JSON.parse(fs.readFileSync(catFile, 'utf8'))) } catch {}
  for (const { episodeId, category } of pendingCategoryUpdates) {
    if (!idx[category]) idx[category] = []
    if (!idx[category].includes(episodeId)) idx[category].push(episodeId)
  }
  atomicReplaceFileSync(catFile, JSON.stringify(idx, null, 2))
}

const pendingTokenUpdates = []

function queueTokenUpdate(episodeId, tokens) {
  pendingTokenUpdates.push({ episodeId, tokens })
}

function flushTokensIndex() {
  if (pendingTokenUpdates.length === 0) return
  const tokensFile = path.join(GLOBAL_DIR, 'tokens.json')
  let idx = Object.create(null)
  try { idx = nullProtoIndex(JSON.parse(fs.readFileSync(tokensFile, 'utf8'))) } catch {}
  const dropped = new Set(Array.isArray(idx[TOKENS_DROPPED_KEY]) ? idx[TOKENS_DROPPED_KEY] : [])
  for (const { episodeId, tokens } of pendingTokenUpdates) {
    for (const token of tokens) {
      if (dropped.has(token)) continue
      if (!idx[token]) idx[token] = []
      if (!idx[token].includes(episodeId)) idx[token].push(episodeId)
    }
  }
  atomicReplaceFileSync(tokensFile, JSON.stringify(idx))
}

// ---------------------------------------------------------------------------
// Seed patterns
// ---------------------------------------------------------------------------
const episodesDir = path.join(GLOBAL_DIR, 'episodes')
const globalIndexFile = path.join(GLOBAL_DIR, 'index.jsonl')
let seeded = 0
let skipped = 0
const prepared = []

// Pattern source validation is lock-free. Only entries that could write are
// carried into the transaction; help, invalid source, dry-run, and a fully
// seeded no-op never wait on the store lock.
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

  prepared.push({ pattern_id, body, tags, summary, project, category })

  if (dryRun) {
    seeded++
  }
}

if (dryRun || prepared.length === 0) {
  const total = (index.patterns || []).length
  console.log(JSON.stringify({
    status: 'ok',
    seeded,
    skipped,
    total,
    ...(dryRun ? { dry_run: true } : {})
  }))
  process.exit(0)
}

const lockResult = acquireStoreWriteLocksSync(GLOBAL_DIR)
if (!lockResult.ok) {
  console.log(JSON.stringify({ status: 'error', code: lockResult.code, heldBy: lockResult.heldBy, message: `em-seed-patterns: ${lockResult.code}` }))
  process.exit(1)
}

try {
  // Collision state is mutable: re-read tags and existing episode IDs only
  // after the canonical global lock is held.
  try {
    tagsIndex = nullProtoIndex(JSON.parse(fs.readFileSync(tagsFile, 'utf8')))
  } catch {
    tagsIndex = Object.create(null)
  }
  const existingIndex = fs.existsSync(globalIndexFile) ? fs.readFileSync(globalIndexFile, 'utf8') : ''
  const existingIds = new Set(existingIndex.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line).id } catch { return null }
  }).filter(Boolean))
  const pendingIndexEntries = []
  fs.mkdirSync(episodesDir, { recursive: true })

  for (const candidate of prepared) {
    const { pattern_id, body, tags, summary, project, category } = candidate

    if (tagsIndex[pattern_id] && tagsIndex[pattern_id].length > 0) {
      skipped++
      continue
    }

    // Generate episode
    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)
    const timeStr = now.toISOString().slice(11, 16)
    const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
    const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
    let id
    do {
      const randSuffix = crypto.randomBytes(2).toString('hex')
      id = `${ts}-${slug}-${randSuffix}`
    } while (existingIds.has(id) || fs.existsSync(path.join(episodesDir, `${id}.md`)))
    existingIds.add(id)

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
    atomicReplaceFileSync(episodeFilePath, episodeContent)

    // Queue one batch index replacement.
    pendingIndexEntries.push(JSON.stringify({
      id, date: dateStr, time: timeStr, project, category,
      status: 'active', supersedes: null, tags, summary
    }))

    // Queue tags/category/token updates for one replacement per derived index.
    queueTagsUpdate(id, tags)
    queueCategoryUpdate(id, category)
    queueTokenUpdate(id, episodeTokens({ summary, tags, body: episodeContent }))

    for (const tag of tags) {
      if (!tagsIndex[tag]) tagsIndex[tag] = []
      if (!tagsIndex[tag].includes(id)) tagsIndex[tag].push(id)
    }

    seeded++
  }

  if (pendingIndexEntries.length > 0) {
    atomicReplaceFileSync(globalIndexFile, existingIndex + pendingIndexEntries.join('\n') + '\n')
    flushTagsIndex()
    flushCategoryIndex()
    flushTokensIndex()
  }
} finally {
  releaseStoreWriteLocks(lockResult.handles)
}

const total = (index.patterns || []).length
console.log(JSON.stringify({
  status: 'ok',
  seeded,
  skipped,
  total,
  ...(dryRun ? { dry_run: true } : {})
}))
