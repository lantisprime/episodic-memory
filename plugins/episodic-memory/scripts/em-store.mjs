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
const url = flag('--url')
const scope = flag('--scope') || 'global'

// #651/#653: fd-based index existence classifier + reader, inlined (no lib/
// in this vendored copy) — mirrors scripts/lib/index-state.mjs. A single
// open() + fstat() on ONE fd (never a separate classify-then-path-read pair)
// closes the D1 TOCTOU window: even a regular file swapped to a FIFO/dir
// between calls cannot re-open a hang, because the read below reuses the
// SAME fd the fstat just classified. absent -> null (loadIndex returns []);
// unreadable (symlink loop/dangling, EACCES parent, FIFO/socket/device,
// EISDIR, or a read failure) -> throws with .code, so the caller aborts
// typed instead of silently degrading or blocking forever on an unguarded
// open.
function classifyIndexFile(filePath) {
  let st
  try { st = fs.lstatSync(filePath) } catch (e) {
    if (e && e.code === 'ENOENT') {
      const dir = path.dirname(filePath)
      let dirStat
      try { dirStat = fs.lstatSync(dir) } catch (e2) {
        return (e2 && e2.code === 'ENOENT') ? { state: 'absent' } : { state: 'unreadable', code: (e2 && e2.code) || 'UNKNOWN' }
      }
      if (dirStat.isSymbolicLink()) {
        try { fs.statSync(dir) } catch (e3) { return { state: 'unreadable', code: (e3 && e3.code) || 'UNKNOWN' } }
      }
      return { state: 'absent' }
    }
    return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN' }
  }
  if (st.isSymbolicLink()) {
    try { st = fs.statSync(filePath) } catch (e) { return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN' } }
  }
  if (st.isDirectory()) return { state: 'unreadable', code: 'EISDIR' }
  if (!st.isFile()) return { state: 'unreadable', code: 'ENOTREG' }
  return { state: 'ok' }
}

function readIndexOrThrow(filePath, retried = false) {
  let fd
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const verdict = classifyIndexFile(filePath)
      if (verdict.state === 'absent') return null
      if (verdict.state === 'ok') {
        if (retried) return null
        return readIndexOrThrow(filePath, true)
      }
      const err = new Error(`episode index unreadable (${verdict.code}) (${filePath})`)
      err.code = verdict.code
      throw err
    }
    const err = new Error(`episode index unreadable (${(e && e.code) || 'UNKNOWN'}) (${filePath})`)
    err.code = (e && e.code) || 'UNKNOWN'
    throw err
  }
  try {
    let st
    try {
      st = fs.fstatSync(fd)
    } catch (e) {
      const err = new Error(`episode index unreadable (${(e && e.code) || 'UNKNOWN'}) (${filePath})`)
      err.code = (e && e.code) || 'UNKNOWN'
      throw err
    }
    if (!st.isFile()) {
      const code = st.isDirectory() ? 'EISDIR' : 'ENOTREG'
      const err = new Error(`episode index unreadable (${code}) (${filePath})`)
      err.code = code
      throw err
    }
    try {
      return fs.readFileSync(fd, 'utf8')
    } catch (e) {
      const err = new Error(`episode index unreadable (${(e && e.code) || 'UNKNOWN'}) (${filePath})`)
      err.code = (e && e.code) || 'UNKNOWN'
      throw err
    }
  } finally {
    fs.closeSync(fd)
  }
}

if (!project || !category || !summary || !body) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Missing required args. Usage: --project <name> --category <decision|discovery|milestone|context> --tags <t1,t2> --summary <text> --body <text> [--scope local|global]'
  }))
  process.exit(1)
}

const VALID_CATEGORIES = ['decision', 'discovery', 'milestone', 'context', 'research']
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

// #653: classify index.jsonl BEFORE any read/append so a FIFO-shaped index
// aborts typed, exit 1, instead of blocking forever (this vendored copy has
// no store-write lock — the only write hazard is index.jsonl itself).
{
  const shape = classifyIndexFile(indexFile)
  if (shape.state === 'unreadable') {
    console.log(JSON.stringify({ status: 'error', message: `em-store: episode index unreadable (${shape.code}) (${indexFile})`, code: `index-unreadable:${shape.code}` }))
    process.exit(1)
  }
}

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

console.log(JSON.stringify({ status: 'ok', id, file: filePath, scope }))
