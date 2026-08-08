#!/usr/bin/env node
/**
 * em-revise.mjs — Revise/supersede an existing decision.
 *
 * Usage:
 *   node em-revise.mjs --original <id> --project <name> --tags <t1,t2>
 *                      --summary <text> --body <text> [--scope inherit|local|global]
 *
 * --scope defaults to "inherit" (write the revision to the same store as the
 * original). Pass "local" or "global" only to force a cross-scope revision.
 *
 * Creates a new episode that supersedes the original. Marks the original
 * episode as superseded in both its file and the index.
 * Outputs JSON: { status, id, file, supersedes, scope }
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

const originalId = flag('--original')
const project = flag('--project')
const tagsRaw = flag('--tags')
const summary = flag('--summary')
const body = flag('--body')
const scope = flag('--scope') || 'inherit'

const VALID_SCOPES_REVISE = ['inherit', 'local', 'global']
if (!VALID_SCOPES_REVISE.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_REVISE.join(', ')}` }))
  process.exit(1)
}

if (!originalId || !summary || !body) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Missing required args. Usage: --original <id> --project <name> --tags <t1,t2> --summary <text> --body <text> [--scope inherit|local|global]'
  }))
  process.exit(1)
}

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

// ---------------------------------------------------------------------------
// Resolve data directory — find the original episode
// ---------------------------------------------------------------------------
function findEpisode(id) {
  for (const dir of [LOCAL_DIR, GLOBAL_DIR]) {
    const filePath = path.join(dir, 'episodes', `${id}.md`)
    if (fs.existsSync(filePath)) return { dir, filePath }
  }
  return null
}

const original = findEpisode(originalId)
if (!original) {
  console.log(JSON.stringify({
    status: 'error',
    message: `Original episode "${originalId}" not found in local or global stores.`
  }))
  process.exit(1)
}

// dataDir/indexFile are resolved here (rather than after the mark-superseded
// write below) so the #653 preflight can classify BOTH store dirs this
// revision touches — original.dir (supersession target) and dataDir
// (successor target; may be the same dir) — before ANY write.
const dataDir = scope === 'inherit'
  ? original.dir
  : (scope === 'global' ? GLOBAL_DIR : LOCAL_DIR)
const episodesDir = path.join(dataDir, 'episodes')
const indexFile = path.join(dataDir, 'index.jsonl')
const originalIndexFile = path.join(original.dir, 'index.jsonl')

// #653: classify index.jsonl for both dirs BEFORE any read/write so a
// FIFO-shaped index aborts typed, exit 1, instead of blocking forever
// (this vendored copy has no store-write lock — the only write hazard is
// index.jsonl itself).
for (const file of new Set([originalIndexFile, indexFile])) {
  const shape = classifyIndexFile(file)
  if (shape.state === 'unreadable') {
    console.log(JSON.stringify({ status: 'error', message: `em-revise: episode index unreadable (${shape.code}) (${file})`, code: `index-unreadable:${shape.code}` }))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Mark original as superseded
// ---------------------------------------------------------------------------
let originalContent = fs.readFileSync(original.filePath, 'utf8')
originalContent = originalContent.replace(/^status: active$/m, 'status: superseded')
fs.writeFileSync(original.filePath, originalContent, 'utf8')

// Update the index entry for the original. #653: fd-based read
// (readIndexOrThrow) instead of existsSync+readFileSync; only write back
// when the index was actually present (preserves the pre-#653 behavior of
// leaving a genuinely absent index.jsonl untouched).
const originalIndexRaw = readIndexOrThrow(originalIndexFile)
if (originalIndexRaw !== null) {
  const lines = originalIndexRaw.trim().split('\n').filter(Boolean)
  const updated = lines.map(line => {
    try {
      const entry = JSON.parse(line)
      if (entry.id === originalId) {
        entry.status = 'superseded'
        return JSON.stringify(entry)
      }
      return line
    } catch { return line }
  })
  fs.writeFileSync(originalIndexFile, updated.join('\n') + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Extract original's metadata for inheritance
// ---------------------------------------------------------------------------
const origFmMatch = originalContent.match(/^---\n([\s\S]*?)\n---/)
let origProject = project
let origCategory = 'decision'
if (origFmMatch) {
  const fmLines = origFmMatch[1].split('\n')
  for (const line of fmLines) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    if (m[1] === 'project' && !project) origProject = m[2]
    if (m[1] === 'category') origCategory = m[2]
  }
}

// ---------------------------------------------------------------------------
// Create the revision episode in the same store as the original
// (dataDir/episodesDir/indexFile were resolved earlier, above the #653
// preflight, so they are already in scope here.)
// ---------------------------------------------------------------------------
const now = new Date()
const dateStr = now.toISOString().slice(0, 10)
const timeStr = now.toISOString().slice(11, 16)
const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const randSuffix = crypto.randomBytes(2).toString('hex')
const id = `${ts}-${slug}-${randSuffix}`

const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : []
const resolvedProject = origProject || path.basename(process.cwd())

const frontmatter = [
  '---',
  `id: ${id}`,
  `date: ${dateStr}`,
  `time: "${timeStr}"`,
  `project: ${resolvedProject}`,
  `category: ${origCategory}`,
  `status: active`,
  `supersedes: ${originalId}`,
  `tags: [${tags.join(', ')}]`,
  `summary: ${summary}`,
  '---',
].join('\n')

const episodeContent = `${frontmatter}\n\n# ${summary}\n\nRevises: \`${originalId}\`\n\n${body}\n`

fs.mkdirSync(episodesDir, { recursive: true })

const filePath = path.join(episodesDir, `${id}.md`)
fs.writeFileSync(filePath, episodeContent, 'utf8')

const indexEntry = JSON.stringify({
  id, date: dateStr, time: timeStr, project: resolvedProject,
  category: origCategory, status: 'active', supersedes: originalId,
  tags, summary
})
fs.appendFileSync(indexFile, indexEntry + '\n', 'utf8')

console.log(JSON.stringify({
  status: 'ok', id, file: filePath,
  supersedes: originalId, scope: dataDir === GLOBAL_DIR ? 'global' : 'local'
}))
