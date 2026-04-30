#!/usr/bin/env node
/**
 * em-store.mjs — Create a new episodic memory entry.
 *
 * Usage:
 *   node em-store.mjs --project <name> --category <cat> --tags <t1,t2>
 *                     --summary <text> --body <text> [--scope local|global]
 *
 * Writes a markdown episode file and appends an index entry.
 * Outputs JSON: { status, id, file, scope }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = path.join(process.cwd(), '.episodic-memory')

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
const scope = flag('--scope') || 'global'

if (!project || !category || !summary || !body) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Missing required args. Usage: --project <name> --category <decision|discovery|milestone|context> --tags <t1,t2> --summary <text> --body <text> [--scope local|global]'
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
// Resolve data directory
// ---------------------------------------------------------------------------
const dataDir = scope === 'global' ? GLOBAL_DIR : LOCAL_DIR
const episodesDir = path.join(dataDir, 'episodes')
const indexFile = path.join(dataDir, 'index.jsonl')

// ---------------------------------------------------------------------------
// Generate episode
// ---------------------------------------------------------------------------
const now = new Date()
const dateStr = now.toISOString().slice(0, 10)
const timeStr = now.toISOString().slice(11, 16)
const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const randSuffix = crypto.randomBytes(2).toString('hex')
const id = `${ts}-${slug}-${randSuffix}`

const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : []

const frontmatter = [
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

const episodeContent = `${frontmatter}\n\n# ${summary}\n\n${body}\n`

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------
fs.mkdirSync(episodesDir, { recursive: true })

const filePath = path.join(episodesDir, `${id}.md`)
fs.writeFileSync(filePath, episodeContent, 'utf8')

const indexEntry = JSON.stringify({
  id, date: dateStr, time: timeStr, project, category,
  status: 'active', supersedes: null, tags, summary
})
fs.appendFileSync(indexFile, indexEntry + '\n', 'utf8')

console.log(JSON.stringify({ status: 'ok', id, file: filePath, scope }))
