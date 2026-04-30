#!/usr/bin/env node
/**
 * em-rebuild-index.mjs — Rebuild index.jsonl from episode files.
 *
 * Usage:
 *   node em-rebuild-index.mjs [--scope local|global|all]
 *
 * Reads all .md files, extracts frontmatter, writes fresh index.jsonl.
 * Outputs JSON: { status, rebuilt: [{ scope, count }] }
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

const scope = flag('--scope') || 'all'

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

function rebuildDir(dataDir, label) {
  const episodesDir = path.join(dataDir, 'episodes')
  const indexFile = path.join(dataDir, 'index.jsonl')

  if (!fs.existsSync(episodesDir)) {
    fs.mkdirSync(episodesDir, { recursive: true })
    fs.writeFileSync(indexFile, '', 'utf8')
    return { scope: label, count: 0 }
  }

  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith('.md')).sort()
  const entries = []

  for (const file of files) {
    const content = fs.readFileSync(path.join(episodesDir, file), 'utf8')
    const fm = parseFrontmatter(content)
    if (!fm || !fm.id) continue
    entries.push(JSON.stringify({
      id: fm.id,
      date: fm.date,
      time: fm.time,
      project: fm.project,
      category: fm.category,
      status: fm.status || 'active',
      supersedes: fm.supersedes || null,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      summary: fm.summary,
      ...(fm.url ? { url: fm.url } : {})
    }))
  }

  const tmpFile = indexFile + '.tmp'
  fs.writeFileSync(tmpFile, entries.join('\n') + (entries.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmpFile, indexFile)

  return { scope: label, count: entries.length }
}

const rebuilt = []
if (scope === 'local' || scope === 'all') rebuilt.push(rebuildDir(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') rebuilt.push(rebuildDir(GLOBAL_DIR, 'global'))

console.log(JSON.stringify({ status: 'ok', rebuilt }))
