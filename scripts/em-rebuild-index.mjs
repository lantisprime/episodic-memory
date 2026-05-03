#!/usr/bin/env node
/**
 * em-rebuild-index.mjs — Rebuild index.jsonl from episode files.
 *
 * Usage:
 *   node em-rebuild-index.mjs [--scope local|global|all]
 *
 * Reads all .md files in episodes/ (ignores archived/), extracts frontmatter,
 * writes fresh index.jsonl. Preserves access_count and last_accessed from old index.
 * Outputs JSON: { status, rebuilt: [{ scope, count }] }
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

const scope = flag('--scope') || 'all'

function normalizeTags(raw) {
  if (!raw) return []
  const arr = (Array.isArray(raw) ? raw : raw.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(arr)].sort()
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Handles the simple subset we produce: scalar values and inline arrays.
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

/**
 * Load old index.jsonl into a map keyed by episode ID.
 * Used to carry forward access_count and last_accessed during rebuild.
 */
function loadOldIndex(dataDir) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  const map = new Map()
  try {
    const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.id) map.set(entry.id, entry)
      } catch {}
    }
  } catch {}
  return map
}

function rebuildDir(dataDir, label) {
  // Scans episodes/ only — archived/ is intentionally ignored
  const episodesDir = path.join(dataDir, 'episodes')
  const indexFile = path.join(dataDir, 'index.jsonl')

  if (!fs.existsSync(episodesDir)) {
    fs.mkdirSync(episodesDir, { recursive: true })
    fs.writeFileSync(indexFile, '', 'utf8')
    return { scope: label, count: 0 }
  }

  // Load old index to preserve access metadata
  const oldIndex = loadOldIndex(dataDir)

  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith('.md')).sort()
  const entries = []

  const tagsIndex = {}

  for (const file of files) {
    const content = fs.readFileSync(path.join(episodesDir, file), 'utf8')
    const fm = parseFrontmatter(content)
    if (!fm || !fm.id) continue
    const normalizedTags = normalizeTags(Array.isArray(fm.tags) ? fm.tags : [])

    // Carry forward access metadata from old index, default to 0/null for new entries
    const old = oldIndex.get(fm.id)
    const accessCount = old ? (old.access_count || 0) : 0
    const lastAccessed = old ? (old.last_accessed || null) : null

    entries.push(JSON.stringify({
      id: fm.id,
      date: fm.date,
      time: fm.time,
      project: fm.project,
      category: fm.category,
      status: fm.status || 'active',
      supersedes: fm.supersedes || null,
      tags: normalizedTags,
      summary: fm.summary,
      access_count: accessCount,
      last_accessed: lastAccessed,
      ...(fm.url ? { url: fm.url, fetched: fm.fetched || fm.date } : {})
    }))
    for (const tag of normalizedTags) {
      if (!tagsIndex[tag]) tagsIndex[tag] = []
      tagsIndex[tag].push(fm.id)
    }
  }

  const tmpFile = indexFile + '.tmp'
  fs.writeFileSync(tmpFile, entries.join('\n') + (entries.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmpFile, indexFile)

  const tagsFile = path.join(dataDir, 'tags.json')
  const tagsTmp = tagsFile + '.tmp'
  fs.writeFileSync(tagsTmp, JSON.stringify(tagsIndex, null, 2), 'utf8')
  fs.renameSync(tagsTmp, tagsFile)

  return { scope: label, count: entries.length }
}

const rebuilt = []
if (scope === 'local' || scope === 'all') rebuilt.push(rebuildDir(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') rebuilt.push(rebuildDir(GLOBAL_DIR, 'global'))

console.log(JSON.stringify({ status: 'ok', rebuilt }))
