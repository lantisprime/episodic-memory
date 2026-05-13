#!/usr/bin/env node
/**
 * em-store.mjs — Create a new episodic memory entry.
 *
 * Usage:
 *   node em-store.mjs --project <name> --category <cat>
 *                     (--tags <t1,t2> | --tag <t1> --tag <t2> | both)
 *                     --summary <text> (--body <text> | --body-file <path>)
 *                     [--scope local|global]
 *
 * Tag forms (any combination accepted; merged + deduplicated + sorted):
 *   --tags a,b,c       — comma-separated single flag
 *   --tag a --tag b    — repeated flag, one tag per occurrence
 *   --tags a,b --tag c — mixed
 *
 * `--body-file` reads body content from a file (UTF-8, BOM stripped, exactly
 * one trailing newline stripped). Mutually exclusive with `--body`. Use it
 * when the body is long enough that `--body "$(cat …)"` would trigger
 * Claude Code's unsafe-substitution permission gate.
 *
 * Writes a markdown episode file and appends an index entry.
 * Outputs JSON: { status, id, file, scope }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { readBodyFile } from './lib/body-file.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

// flagAll(name) — collect every value of a repeated flag.
// Used for --tag where users may pass `--tag a --tag b --tag c`. Returns []
// when the flag is absent. Skips an occurrence whose value position would
// fall outside argv (trailing `--tag`) OR whose value starts with `--` (the
// next option, not a tag value). Single-dash values like `-foo` are accepted
// because tags can legitimately contain leading hyphens; the `--` guard is
// just to catch the missing-value-followed-by-next-flag shape.
function flagAll(name) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) {
      const val = argv[i + 1]
      if (val.startsWith('--')) continue
      out.push(val)
      i++
    }
  }
  return out
}

const project = flag('--project')
const category = flag('--category')
const tagsRaw = flag('--tags')
const tagRepeats = flagAll('--tag')
const summary = flag('--summary')
const bodyArg = flag('--body')
const bodyFile = flag('--body-file')
const url = flag('--url')
const scope = flag('--scope') || 'global'

const VALID_CATEGORIES = ['decision', 'discovery', 'milestone', 'context', 'research', 'lesson', 'violation', 'workflow.lifecycle']

const USAGE = `--project <name> --category <${VALID_CATEGORIES.join('|')}> (--tags <t1,t2> | --tag <t> [--tag <t> ...]) --summary <text> (--body <text> | --body-file <path>) [--scope local|global]`

if (bodyArg !== undefined && bodyFile !== undefined) {
  console.log(JSON.stringify({
    status: 'error',
    message: '--body and --body-file are mutually exclusive; pass only one.'
  }))
  process.exit(1)
}

let body = bodyArg
if (bodyFile !== undefined) {
  body = readBodyFile(bodyFile)
}

if (!project || !category || !summary || !body) {
  console.log(JSON.stringify({
    status: 'error',
    message: `Missing required args. Usage: ${USAGE}`
  }))
  process.exit(1)
}
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

function normalizeTags(raw, repeats = []) {
  const fromComma = raw ? raw.split(',') : []
  const all = [...fromComma, ...repeats]
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(all)].sort()
}

function updateTagsIndex(dataDir, episodeId, tags) {
  const tagsFile = path.join(dataDir, 'tags.json')
  let index = {}
  try {
    index = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  } catch {}
  for (const tag of tags) {
    if (!index[tag]) index[tag] = []
    if (!index[tag].includes(episodeId)) index[tag].push(episodeId)
  }
  const tmpFile = tagsFile + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(index, null, 2), 'utf8')
  fs.renameSync(tmpFile, tagsFile)
}

const tags = normalizeTags(tagsRaw, tagRepeats)

const fmLines = [
  '---',
  `id: ${id}`,
  `date: ${dateStr}`,
  `time: "${timeStr}"`,
  `project: ${project}`,
  `category: ${category}`,
  `status: active`,
  `tags: [${tags.join(', ')}]`,
  `summary: ${summary}`,
]
if (url) {
  fmLines.push(`url: ${url}`)
  fmLines.push(`fetched: ${dateStr}`)
}
fmLines.push('---')
const frontmatter = fmLines.join('\n')

const episodeContent = `${frontmatter}\n\n# ${summary}\n\n${body}\n`

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------
fs.mkdirSync(episodesDir, { recursive: true })

const filePath = path.join(episodesDir, `${id}.md`)
fs.writeFileSync(filePath, episodeContent, 'utf8')

const indexEntry = JSON.stringify({
  id, date: dateStr, time: timeStr, project, category,
  status: 'active', supersedes: null, tags, summary,
  ...(url ? { url, fetched: dateStr } : {})
})
fs.appendFileSync(indexFile, indexEntry + '\n', 'utf8')

updateTagsIndex(dataDir, id, tags)

console.log(JSON.stringify({ status: 'ok', id, file: filePath, scope }))
