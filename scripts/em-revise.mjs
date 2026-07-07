#!/usr/bin/env node
/**
 * em-revise.mjs — Revise/supersede an existing decision.
 *
 * Usage:
 *   node em-revise.mjs --original <id> --project <name>
 *                      (--tags <t1,t2> | --tag <t1> --tag <t2> | both)
 *                      --summary <text> (--body <text> | --body-file <path>)
 *                      [--scope inherit|local|global]
 *
 * Tag forms accepted (merged + deduplicated; mirrors em-store):
 *   --tags a,b,c       --tag a --tag b       --tags a,b --tag c
 *
 * --scope defaults to "inherit" (write the revision to the same store as the
 * original). Pass "local" or "global" only to force a cross-scope revision.
 *
 * `--body-file` reads body content from a file (UTF-8, BOM stripped, exactly
 * one trailing newline stripped). Mutually exclusive with `--body`.
 *
 * Creates a new episode that supersedes the original. Marks the original
 * episode as superseded in both its file and the index.
 * Outputs JSON: { status, id, file, supersedes, scope }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { readBodyFile } from './lib/body-file.mjs'
import { validateCategory, canonicalCategory } from './lib/categories.mjs'
import { episodeTokens, updateTokensIndex } from './lib/relevance.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-revise.mjs', usage: 'node em-revise.mjs --original <id> --project <name> [--tags <t1,t2>] [--tag <t>]... --summary <text> (--body <text> | --body-file <path>) [--scope inherit|local|global] [--pin]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

// flagAll(name) — collect every value of a repeated flag. Mirrors em-store's
// helper; lets users pass `--tag a --tag b` in addition to `--tags a,b`.
// Skips a position whose value starts with `--` (next flag, not a tag value).
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

const originalId = flag('--original')
const project = flag('--project')
const tagsRaw = flag('--tags')
const tagRepeats = flagAll('--tag')
const summary = flag('--summary')
const bodyArg = flag('--body')
const bodyFile = flag('--body-file')
const scope = flag('--scope') || 'inherit'

const VALID_SCOPES_REVISE = ['inherit', 'local', 'global']
if (!VALID_SCOPES_REVISE.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_REVISE.join(', ')}` }))
  process.exit(1)
}

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

if (!originalId || !summary || !body) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Missing required args. Usage: --original <id> --project <name> (--tags <t1,t2> | --tag <t> [--tag <t> ...]) --summary <text> (--body <text> | --body-file <path>) [--scope inherit|local|global]'
  }))
  process.exit(1)
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

// ---------------------------------------------------------------------------
// Validate the inherited category BEFORE any write (I4 / EC6 — a rejected revise
// must leave the store byte-unchanged; the original is marked superseded just below,
// so validation has to precede that mutation, not follow the later metadata parse).
// ---------------------------------------------------------------------------
{
  const origRaw = fs.readFileSync(original.filePath, 'utf8')
  const fm = origRaw.match(/^---\n([\s\S]*?)\n---/)
  let cat = 'decision'
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m && m[1] === 'category') cat = m[2]
    }
  }
  let rv
  try {
    rv = validateCategory(cat)
  } catch (e) {
    // vocab unloadable at a WRITE surface → fail CLOSED (§12 state E)
    console.log(JSON.stringify({ status: 'error', message: e.message }))
    process.exit(1)
  }
  if (!rv.ok) {
    const message = rv.reason === 'deprecated'
      ? `Inherited category "${cat}" is deprecated; use "${rv.successor}"`
      : `Inherited category "${cat}" is not in the vocabulary`
    console.log(JSON.stringify({ status: 'error', message }))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Mark original as superseded
// ---------------------------------------------------------------------------
let originalContent = fs.readFileSync(original.filePath, 'utf8')
originalContent = originalContent.replace(/^status: active$/m, 'status: superseded')
const origTmpFile = original.filePath + '.tmp'
fs.writeFileSync(origTmpFile, originalContent, 'utf8')
fs.renameSync(origTmpFile, original.filePath)

// Update the index entry for the original + capture origTags in one pass
const originalIndexFile = path.join(original.dir, 'index.jsonl')
let origTagsFromIndex = []
let origPinned = false
if (fs.existsSync(originalIndexFile)) {
  const lines = fs.readFileSync(originalIndexFile, 'utf8').trim().split('\n').filter(Boolean)
  const updated = lines.map(line => {
    try {
      const entry = JSON.parse(line)
      if (entry.id === originalId) {
        if (Array.isArray(entry.tags)) origTagsFromIndex = entry.tags
        if (entry.pinned === true) origPinned = true
        entry.status = 'superseded'
        return JSON.stringify(entry)
      }
      return line
    } catch { return line }
  })
  // Atomic write — best-effort file integrity, not full concurrency protection
  const idxTmpFile = originalIndexFile + '.tmp'
  fs.writeFileSync(idxTmpFile, updated.join('\n') + '\n', 'utf8')
  fs.renameSync(idxTmpFile, originalIndexFile)
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
// ---------------------------------------------------------------------------
const dataDir = scope === 'inherit'
  ? original.dir
  : (scope === 'global' ? GLOBAL_DIR : LOCAL_DIR)
const episodesDir = path.join(dataDir, 'episodes')
const indexFile = path.join(dataDir, 'index.jsonl')

const now = new Date()
const dateStr = now.toISOString().slice(0, 10)
const timeStr = now.toISOString().slice(11, 16)
const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const randSuffix = crypto.randomBytes(2).toString('hex')
const id = `${ts}-${slug}-${randSuffix}`

function normalizeTags(raw, repeats = []) {
  let fromRaw = []
  if (Array.isArray(raw)) {
    fromRaw = raw
  } else if (raw) {
    fromRaw = raw.split(',')
  }
  const all = [...fromRaw, ...repeats]
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

// Mirror em-store's category-index maintenance (RFC-009 R10d); duplicated locally the same
// way updateTagsIndex is, rather than imported from em-store (which runs top-level on import).
function updateCategoryIndex(dataDir, episodeId, category) {
  const catFile = path.join(dataDir, 'category-index.json')
  let index = {}
  try {
    index = JSON.parse(fs.readFileSync(catFile, 'utf8'))
  } catch {}
  const key = canonicalCategory(category)
  if (!index[key]) index[key] = []
  if (!index[key].includes(episodeId)) index[key].push(episodeId)
  const tmpFile = catFile + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(index, null, 2), 'utf8')
  fs.renameSync(tmpFile, catFile)
}

const tags = normalizeTags(tagsRaw, tagRepeats)
const resolvedProject = origProject || path.basename(process.cwd())

// Inherit original episode's tags (captured during first index pass above)
const mergedTags = normalizeTags([...origTagsFromIndex, ...tags])

// Pinning survives revision: a corrected pinned decision is still a pinned
// decision. --pin additionally pins an unpinned chain at revision time.
const pinned = origPinned || argv.includes('--pin')

const frontmatter = [
  '---',
  `id: ${id}`,
  `date: ${dateStr}`,
  `time: "${timeStr}"`,
  `project: ${resolvedProject}`,
  `category: ${origCategory}`,
  `status: active`,
  `supersedes: ${originalId}`,
  `tags: [${mergedTags.join(', ')}]`,
  `summary: ${summary}`,
  ...(pinned ? ['pinned: true'] : []),
  '---',
].join('\n')

const episodeContent = `${frontmatter}\n\n# ${summary}\n\nRevises: \`${originalId}\`\n\n${body}\n`

fs.mkdirSync(episodesDir, { recursive: true })

const filePath = path.join(episodesDir, `${id}.md`)
fs.writeFileSync(filePath, episodeContent, 'utf8')

const indexEntry = JSON.stringify({
  id, date: dateStr, time: timeStr, project: resolvedProject,
  category: origCategory, status: 'active', supersedes: originalId,
  tags: mergedTags, summary,
  ...(pinned ? { pinned: true } : {})
})
fs.appendFileSync(indexFile, indexEntry + '\n', 'utf8')

// Update tags.json
updateTagsIndex(dataDir, id, mergedTags)
updateCategoryIndex(dataDir, id, origCategory)
// Token source is the FULL FILE content (frontmatter + body): the search
// body tier greps the whole file, so pruning must see the same text.
updateTokensIndex(dataDir, id, episodeTokens({ summary, tags: mergedTags, body: episodeContent }))
// If revision crosses scopes, also update original scope's tags.json + category-index.json
if (original.dir !== dataDir) {
  updateTagsIndex(original.dir, id, mergedTags)
  updateCategoryIndex(original.dir, id, origCategory)
  updateTokensIndex(original.dir, id, episodeTokens({ summary, tags: mergedTags, body: episodeContent }))
}

console.log(JSON.stringify({
  status: 'ok', id, file: filePath,
  supersedes: originalId, scope: dataDir === GLOBAL_DIR ? 'global' : 'local'
}))
