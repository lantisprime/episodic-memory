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
import { validateActivation, serializeInlineArray, loadMergedIndex, resolveLinkage, ACTIVATION_ARRAY_FIELDS, parseActivationFromFrontmatter, illegalScalarChar } from './lib/activation.mjs'
import { loadMergedTriggerIndex } from './em-trigger-index.mjs'
import { episodeTokens, updateTokensIndex, nullProtoIndex } from './lib/relevance.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-revise.mjs', usage: 'node em-revise.mjs --original <id> --project <name> [--tags <t1,t2>] [--tag <t>]... --summary <text> (--body <text> | --body-file <path>) [--scope inherit|local|global] [--pin] [lesson-only activation: --trigger <phrase|tool:T:glob|activity:class>]... [--applies-to-project <slug|*>]... [--applies-to-tool <id>]... [--priority <1-7>] [--review-by <YYYY-MM-DD>] [--evidence <violation-id>]...' }))
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
// RFC-009 R1 activation flags (lesson-only; validated against the INHERITED
// category below, before the supersede mutation, via lib/activation.mjs)
const triggers = flagAll('--trigger')
const appliesToProjects = flagAll('--applies-to-project')
const appliesToTools = flagAll('--applies-to-tool')
const priorityFlag = flag('--priority')
const reviewBy = flag('--review-by')
const evidence = flagAll('--evidence')

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

// Reviewer F1 (round 2): user-controlled serialized scalars reject line-breaking
// chars BEFORE the supersede mutation below (I4). Inherited project/tags come
// from an already-written (write-validated) episode via the `^(\w+):\s*(.*)$`
// regex, which cannot capture a newline, so only the user inputs need guarding.
for (const [label, value] of [['summary', summary], ...(project !== undefined ? [['project', project]] : [])]) {
  const bad = illegalScalarChar(value)
  if (bad !== null) {
    console.log(JSON.stringify({ status: 'error', message: `--${label} contains illegal line-breaking character ${JSON.stringify(bad)}` }))
    process.exit(1)
  }
}
for (const tag of [...(tagsRaw ? tagsRaw.split(',') : []), ...tagRepeats]) {
  const bad = illegalScalarChar(tag)
  if (bad !== null) {
    console.log(JSON.stringify({ status: 'error', message: `--tag/--tags value contains illegal line-breaking character ${JSON.stringify(bad)}` }))
    process.exit(1)
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

// ---------------------------------------------------------------------------
// Validate the inherited category BEFORE any write (I4 / EC6 — a rejected revise
// must leave the store byte-unchanged; the original is marked superseded just below,
// so validation has to precede that mutation, not follow the later metadata parse).
// ---------------------------------------------------------------------------
let activation = null // normalized RFC-009 activation fields (set in the block below)
let inheritedLessons = [] // violation-side forward-links, inherited verbatim (F3)
let inheritedViolatedPattern // T6 typed scalar, inherited verbatim (F3)
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

  // RFC-009 R1 + reviewer F3: activation, linkage, and the T6 typed field are
  // INHERITED from the original (tags already inherit — silent activation loss
  // on a typo-revision demoted lessons to freeform and dropped violation band
  // links). A flag passed on the revise OVERRIDES that field; absent flags keep
  // the original's values. Validation runs on the MERGED result against the
  // inherited category, BEFORE the supersede mutation below (I4).
  const inherited = parseActivationFromFrontmatter(origRaw)
  inheritedLessons = Array.isArray(inherited.lessons) ? inherited.lessons : []
  inheritedViolatedPattern = inherited.violated_pattern
  const merged = {
    ...(triggers.length ? { triggers } : (inherited.triggers ? { triggers: inherited.triggers } : {})),
    ...(appliesToProjects.length ? { applies_to_projects: appliesToProjects } : (inherited.applies_to_projects ? { applies_to_projects: inherited.applies_to_projects } : {})),
    ...(appliesToTools.length ? { applies_to_tools: appliesToTools } : (inherited.applies_to_tools ? { applies_to_tools: inherited.applies_to_tools } : {})),
    ...(evidence.length ? { evidence } : (inherited.evidence ? { evidence: inherited.evidence } : {})),
    ...(priorityFlag !== undefined ? { priority: Number(priorityFlag) } : (inherited.priority !== undefined ? { priority: inherited.priority } : {})),
    ...(reviewBy !== undefined ? { review_by: reviewBy } : (inherited.review_by !== undefined ? { review_by: inherited.review_by } : {})),
  }
  const av = validateActivation(merged, { category: cat })
  if (!av.ok) {
    console.log(JSON.stringify({ status: 'error', errors: av.errors, message: av.errors.map(e => e.message).join('; ') }))
    process.exit(1)
  }
  activation = av.fields // null when neither flags nor the original carry activation

  // REQ-6 (revise-side parity): merged-index resolution, never per-active-scope
  // (F1). Only NEWLY passed --evidence re-validates — inherited links carry
  // verbatim (a linked violation may have been legitimately retracted since;
  // the band derivation, not the write gate, is what discounts it).
  if (evidence.length) {
    const lv = resolveLinkage(evidence, { requireCategory: 'violation', index: loadMergedIndex() })
    if (!lv.ok) {
      console.log(JSON.stringify({
        status: 'error',
        message: `--evidence must name existing violation episodes; missing: [${lv.missing.join(', ')}] wrong-category: [${lv.wrongCategory.join(', ')}]`,
        missing: lv.missing, wrong_category: lv.wrongCategory
      }))
      process.exit(1)
    }
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

// Mirror em-store's category-index maintenance (RFC-009 R10d); duplicated locally the same
// way updateTagsIndex is, rather than imported from em-store (which runs top-level on import).
function updateCategoryIndex(dataDir, episodeId, category) {
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

const tags = normalizeTags(tagsRaw, tagRepeats)
const resolvedProject = origProject || path.basename(process.cwd())

// Inherit original episode's tags (captured during first index pass above)
const mergedTags = normalizeTags([...origTagsFromIndex, ...tags])

// Pinning survives revision: a corrected pinned decision is still a pinned
// decision. --pin additionally pins an unpinned chain at revision time.
const pinned = origPinned || argv.includes('--pin')

// RFC-009 R1 activation frontmatter — present-only, arrays UNQUOTED inline
// (REQ-2/I4); mirrors em-store's serialization (revise-side parity).
const activationFmLines = []
if (activation) {
  for (const field of ACTIVATION_ARRAY_FIELDS) {
    if (Array.isArray(activation[field]) && activation[field].length) {
      activationFmLines.push(`${field}: [${serializeInlineArray(activation[field])}]`)
    }
  }
  activationFmLines.push(`priority: ${activation.priority}`)
  if (activation.review_by !== undefined) activationFmLines.push(`review_by: ${activation.review_by}`)
}
// F3: violation-side fields inherit verbatim (no revise-side flags exist for them)
if (inheritedLessons.length) activationFmLines.push(`lessons: [${serializeInlineArray(inheritedLessons)}]`)
if (inheritedViolatedPattern !== undefined) activationFmLines.push(`violated_pattern: ${inheritedViolatedPattern}`)

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
  ...activationFmLines,
  ...(pinned ? ['pinned: true'] : []),
  '---',
].join('\n')

const episodeContent = `${frontmatter}\n\n# ${summary}\n\nRevises: \`${originalId}\`\n\n${body}\n`

fs.mkdirSync(episodesDir, { recursive: true })

const filePath = path.join(episodesDir, `${id}.md`)
fs.writeFileSync(filePath, episodeContent, 'utf8')

// Keep in LOCKSTEP with em-rebuild-index.mjs's emit (REQ-9 parity note).
const activationIndexFields = {
  ...(activation ? Object.fromEntries(
    ACTIVATION_ARRAY_FIELDS.filter(f => Array.isArray(activation[f]) && activation[f].length)
      .map(f => [f, activation[f]])
  ) : {}),
  ...(inheritedLessons.length ? { lessons: inheritedLessons } : {}),
  ...(activation ? { priority: activation.priority } : {}),
  ...(activation && activation.review_by !== undefined ? { review_by: activation.review_by } : {}),
  ...(inheritedViolatedPattern !== undefined ? { violated_pattern: inheritedViolatedPattern } : {}),
}
const indexEntry = JSON.stringify({
  id, date: dateStr, time: timeStr, project: resolvedProject,
  category: origCategory, status: 'active', supersedes: originalId,
  tags: mergedTags, summary,
  ...activationIndexFields,
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

// R9a write-time collision report (REQ-18) — mirrors em-store's post-write
// block (revise-side parity): stderr-only, self-excluded, never fatal.
if (activation && Array.isArray(activation.triggers) && activation.triggers.length) {
  try {
    const merged = loadMergedTriggerIndex()
    const mine = new Set(activation.triggers)
    const reported = new Set()
    for (const e of merged.entries) {
      if (e.episode_id === id) continue // self-exclusion (CX5)
      if (!mine.has(e.value)) continue
      const key = `${e.episode_id} ${e.value}`
      if (reported.has(key)) continue
      reported.add(key)
      process.stderr.write(`collision: trigger "${e.value}" also on ${e.episode_id}: ${e.summary}\n`)
    }
  } catch {}
}

console.log(JSON.stringify({
  status: 'ok', id, file: filePath,
  supersedes: originalId, scope: dataDir === GLOBAL_DIR ? 'global' : 'local'
}))
