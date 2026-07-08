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
import { loadCategories, validateCategory, canonicalCategory } from './lib/categories.mjs'
import { validateActivation, serializeInlineArray, loadMergedIndex, resolveLinkage, ACTIVATION_ARRAY_FIELDS } from './lib/activation.mjs'
import { episodeTokens, updateTokensIndex, nullProtoIndex } from './lib/relevance.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-store.mjs', usage: 'node em-store.mjs --project <name> --category <cat> [--tags <t1,t2>] [--tag <t>]... --summary <text> (--body <text> | --body-file <path>) [--scope local|global] [--pin] [lesson-only activation: --trigger <phrase|tool:T:glob|activity:class>]... [--applies-to-project <slug|*>]... [--applies-to-tool <id>]... [--priority <1-7>] [--review-by <YYYY-MM-DD>] [--evidence <violation-id>]...' }))
  process.exit(0)
}

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
// RFC-009 R1 activation flags (lesson-only; validated below via lib/activation.mjs)
const triggers = flagAll('--trigger')
const appliesToProjects = flagAll('--applies-to-project')
const appliesToTools = flagAll('--applies-to-tool')
const priorityFlag = flag('--priority')
const reviewBy = flag('--review-by')
const evidence = flagAll('--evidence')
// Typed T6 passthrough scalar (REQ-8): set by em-violation's handoff; generic
// flag, violation-only in practice.
const violatedPattern = flag('--violated-pattern')
// --pin: exempt from time decay (recall floor 0.6 instead of 0.1) and from
// em-prune archival. For foundational decisions that must not fade.
const pinned = argv.includes('--pin')

// Category vocabulary comes from categories.json via lib/categories.mjs (RFC-009 R10b).
// USAGE derives the member list fail-safely so --help never crashes when the vocab is
// unloadable; the write path still fails CLOSED below via validateCategory.
let catNames
try { catNames = loadCategories().categories.map(c => c.name).join('|') } catch { catNames = 'see categories.json' }

const USAGE = `--project <name> --category <${catNames}> (--tags <t1,t2> | --tag <t> [--tag <t> ...]) --summary <text> (--body <text> | --body-file <path>) [--scope local|global]`

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
let catV
try {
  catV = validateCategory(category)
} catch (e) {
  // vocab unloadable at a WRITE surface → fail CLOSED (§12 state E)
  console.log(JSON.stringify({ status: 'error', message: e.message }))
  process.exit(1)
}
if (!catV.ok) {
  const message = catV.reason === 'deprecated'
    ? `Category "${category}" is deprecated; use "${catV.successor}"`
    : `Invalid category "${category}". Must be one of: ${(() => { try { return loadCategories().categories.map(c => c.name).join(', ') } catch { return 'see categories.json' } })()}`
  console.log(JSON.stringify({ status: 'error', message }))
  process.exit(1)
}

// RFC-009 R1: validate activation fields BEFORE any write (I4 — a rejected
// write leaves the store byte-unchanged). Present-only input; the lib applies
// the priority default (5) only when activation is actually in play, so a
// freeform write of ANY category carries no activation fields (EC15).
const av = validateActivation({
  ...(triggers.length ? { triggers } : {}),
  ...(appliesToProjects.length ? { applies_to_projects: appliesToProjects } : {}),
  ...(appliesToTools.length ? { applies_to_tools: appliesToTools } : {}),
  ...(evidence.length ? { evidence } : {}),
  ...(priorityFlag !== undefined ? { priority: Number(priorityFlag) } : {}),
  ...(reviewBy !== undefined ? { review_by: reviewBy } : {}),
}, { category })
if (!av.ok) {
  console.log(JSON.stringify({ status: 'error', errors: av.errors, message: av.errors.map(e => e.message).join('; ') }))
  process.exit(1)
}
const activation = av.fields // null for freeform writes

// REQ-6 (S3): each --evidence id must resolve to an EXISTING category:violation
// episode in the MERGED (local+global) index — never per-active-scope (F1).
if (activation && Array.isArray(activation.evidence) && activation.evidence.length) {
  const lv = resolveLinkage(activation.evidence, { requireCategory: 'violation', index: loadMergedIndex() })
  if (!lv.ok) {
    console.log(JSON.stringify({
      status: 'error',
      message: `--evidence must name existing violation episodes; missing: [${lv.missing.join(', ')}] wrong-category: [${lv.wrongCategory.join(', ')}]`,
      missing: lv.missing, wrong_category: lv.wrongCategory
    }))
    process.exit(1)
  }
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
  // Null-proto: a tag named "constructor" must not resolve to Object.prototype (issue #469)
  let index = Object.create(null)
  try {
    index = nullProtoIndex(JSON.parse(fs.readFileSync(tagsFile, 'utf8')))
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
// RFC-009 R1 activation frontmatter — present-only, arrays UNQUOTED inline
// (REQ-2/I4: items are char-rejected above, so the round-trip through
// em-rebuild-index's generic parser needs no parser change).
if (activation) {
  for (const field of ACTIVATION_ARRAY_FIELDS) {
    if (Array.isArray(activation[field]) && activation[field].length) {
      fmLines.push(`${field}: [${serializeInlineArray(activation[field])}]`)
    }
  }
  fmLines.push(`priority: ${activation.priority}`)
  if (activation.review_by !== undefined) fmLines.push(`review_by: ${activation.review_by}`)
}
// T6 typed scalar (REQ-8): violation-side passthrough from em-violation's handoff.
if (violatedPattern !== undefined) fmLines.push(`violated_pattern: ${violatedPattern}`)
if (pinned) fmLines.push('pinned: true')
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

// Activation/T6 index fields — keep this list in LOCKSTEP with
// em-rebuild-index.mjs's emit object (present-only, same key names) so a
// store-then-rebuild round-trip preserves the fields (REQ-9, step 2.3 parity note).
const activationIndexFields = {
  ...(activation ? Object.fromEntries(
    ACTIVATION_ARRAY_FIELDS.filter(f => Array.isArray(activation[f]) && activation[f].length)
      .map(f => [f, activation[f]])
  ) : {}),
  ...(activation ? { priority: activation.priority } : {}),
  ...(activation && activation.review_by !== undefined ? { review_by: activation.review_by } : {}),
  ...(violatedPattern !== undefined ? { violated_pattern: violatedPattern } : {}),
}
const indexEntry = JSON.stringify({
  id, date: dateStr, time: timeStr, project, category,
  status: 'active', supersedes: null, tags, summary,
  ...activationIndexFields,
  ...(pinned ? { pinned: true } : {}),
  ...(url ? { url, fetched: dateStr } : {})
})
fs.appendFileSync(indexFile, indexEntry + '\n', 'utf8')

updateTagsIndex(dataDir, id, tags)
updateCategoryIndex(dataDir, id, category)
// Token source is the FULL FILE content (frontmatter + body): the search
// body tier greps the whole file, so pruning must see the same text.
updateTokensIndex(dataDir, id, episodeTokens({ summary, tags, body: episodeContent }))

console.log(JSON.stringify({ status: 'ok', id, file: filePath, scope }))

// Incrementally maintain category-index.json under the episode's canonical category key,
// structurally mirroring updateTagsIndex (RFC-009 R10d). Deprecated names map to the successor
// key; unknown names index under their literal key (canonicalCategory degrades, never throws).
export function updateCategoryIndex(dataDir, episodeId, category) {
  const catFile = path.join(dataDir, 'category-index.json')
  // Null-proto: unknown categories index under their literal key, which could
  // collide with Object.prototype names (issue #469)
  let index = Object.create(null)
  try {
    index = nullProtoIndex(JSON.parse(fs.readFileSync(catFile, 'utf8')))
  } catch {}
  const key = canonicalCategory(category)
  if (!index[key]) index[key] = []
  if (!index[key].includes(episodeId)) index[key].push(episodeId)
  const tmpFile = catFile + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(index, null, 2), 'utf8')
  fs.renameSync(tmpFile, catFile)
}
