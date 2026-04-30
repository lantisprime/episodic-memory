#!/usr/bin/env node
/**
 * em-store.mjs — Create a new episodic memory entry.
 *
 * Usage:
 *   node em-store.mjs --project <name> --category <cat> --tags <t1,t2> --summary <text> --body <text>
 *
 * Writes a markdown episode file to ~/.claude/episodic-memory/episodes/
 * and appends an index entry to ~/.claude/episodic-memory/index.jsonl.
 * Outputs JSON: { status, id, file }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

const DATA_DIR = path.join(os.homedir(), '.claude', 'episodic-memory')
const EPISODES_DIR = path.join(DATA_DIR, 'episodes')
const INDEX_FILE = path.join(DATA_DIR, 'index.jsonl')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const project = flag('--project')
const category = flag('--category')
const tagsRaw = flag('--tags')
const summary = flag('--summary')
const body = flag('--body')

if (!project || !category || !summary || !body) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Missing required args. Usage: --project <name> --category <decision|discovery|milestone|context> --tags <t1,t2> --summary <text> --body <text>'
  }))
  process.exit(1)
}

const VALID_CATEGORIES = ['decision', 'discovery', 'milestone', 'context']
if (!VALID_CATEGORIES.includes(category)) {
  console.log(JSON.stringify({
    status: 'error',
    message: `Invalid category "${category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`
  }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Generate episode
// ---------------------------------------------------------------------------
const now = new Date()
const dateStr = now.toISOString().slice(0, 10)
const timeStr = now.toISOString().slice(11, 16)
const timestampPrefix = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
// Format: YYYYMMDD-HHmmss
const slug = summary
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 40)
const randSuffix = crypto.randomBytes(2).toString('hex')
const id = `${timestampPrefix}-${slug}-${randSuffix}`

const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : []

const frontmatter = [
  '---',
  `id: ${id}`,
  `date: ${dateStr}`,
  `time: "${timeStr}"`,
  `project: ${project}`,
  `category: ${category}`,
  `tags: [${tags.join(', ')}]`,
  `summary: ${summary}`,
  '---',
].join('\n')

const episodeContent = `${frontmatter}\n\n# ${summary}\n\n${body}\n`

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------
fs.mkdirSync(EPISODES_DIR, { recursive: true })

const filePath = path.join(EPISODES_DIR, `${id}.md`)
fs.writeFileSync(filePath, episodeContent, 'utf8')

const indexEntry = JSON.stringify({ id, date: dateStr, time: timeStr, project, category, tags, summary })
fs.appendFileSync(INDEX_FILE, indexEntry + '\n', 'utf8')

console.log(JSON.stringify({
  status: 'ok',
  id,
  file: filePath,
  summary
}))
