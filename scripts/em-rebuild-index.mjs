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
import { loadCategories, validateCategory, canonicalCategory } from './lib/categories.mjs'
import { episodeTokens, DF_DROP_RATIO, TOKENS_DROPPED_KEY } from './lib/relevance.mjs'
import { resolveStoreIdentity } from './lib/store-identity.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

// RFC-009 P4-S4 (round-2 N2): --break-rebuild-whitelist omits `record_type` from
// the rebuilt index row — negative control for runrecord::survivesRebuild (proves
// the whitelist add is load-bearing for protection.mjs class-d + crash discriminator).
const BREAK_REBUILD_WHITELIST = argv.includes('--break-rebuild-whitelist')

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-rebuild-index.mjs', usage: 'node em-rebuild-index.mjs [--scope local|global|all] [--check]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'all'
const checkMode = argv.includes('--check')

function normalizeTags(raw) {
  if (!raw) return []
  const arr = (Array.isArray(raw) ? raw : raw.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(arr)].sort()
}

// --check: drift DETECTION only (R10f). Lists every episode whose stored category is unknown or
// deprecated; exits 1 iff any drift, 0 otherwise. Writes NOTHING. Correction is the R9 clerk (P4).
if (checkMode) {
  let vocabLoaded = true
  try { loadCategories() } catch { vocabLoaded = false }
  const drift = []
  if (vocabLoaded) {
    const dirs = []
    if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
    if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
    for (const dataDir of dirs) {
      const episodesDir = path.join(dataDir, 'episodes')
      let files = []
      try { files = fs.readdirSync(episodesDir).filter(f => f.endsWith('.md')).sort() } catch { continue }
      for (const file of files) {
        const fm = parseFrontmatter(fs.readFileSync(path.join(episodesDir, file), 'utf8'))
        if (!fm || !fm.id) continue
        const v = validateCategory(fm.category, { allowDeprecated: true })
        if (!v.ok) drift.push({ id: fm.id, category: fm.category ?? null, kind: 'unknown' })
        else if (v.successor) drift.push({ id: fm.id, category: fm.category, kind: 'deprecated', successor: v.successor })
      }
    }
  } else {
    // reader surface must never be fatal (B1): degrade to an empty, clean report + a stderr warn
    process.stderr.write('em-rebuild-index --check: categories.json unloadable; drift not classified\n')
  }
  console.log(JSON.stringify({ status: 'ok', drift }))
  process.exit(drift.length ? 1 : 0)
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

  // Null-proto maps: keys come from episode content (tags, tokens, category
  // names), and "constructor" on a plain {} resolves to Object.prototype's
  // inherited function instead of undefined (issue #469).
  const tagsIndex = Object.create(null)
  const tokensIndex = Object.create(null)
  // category-index + drift counts (R10d/R10f). Reader/index surface: if the vocab cannot load,
  // DEGRADE — build index.jsonl + tags.json as before and skip category-index (B1, I3).
  const categoryIndex = Object.create(null)
  const driftUnknown = Object.create(null)
  const driftDeprecated = Object.create(null)
  let vocabLoaded = true
  try { loadCategories() } catch { vocabLoaded = false }

  for (const file of files) {
    const content = fs.readFileSync(path.join(episodesDir, file), 'utf8')
    const fm = parseFrontmatter(content)
    if (!fm || !fm.id) continue
    const normalizedTags = normalizeTags(Array.isArray(fm.tags) ? fm.tags : [])

    // Carry forward access metadata from old index, default to 0/null for new
    // entries. `feedback` (em-feedback usefulness counter) is index-only
    // metadata like access_count and survives rebuilds the same way.
    const old = oldIndex.get(fm.id)
    const accessCount = old ? (old.access_count || 0) : 0
    const lastAccessed = old ? (old.last_accessed || null) : null
    const feedback = old && typeof old.feedback === 'number' ? old.feedback : 0

    // #448 write/repair side: a hand-authored episode (foreign harness,
    // `created:` instead of `date:`/`time:`) used to round-trip its malformed
    // row through every rebuild — fm.date/fm.time copied verbatim. Backfill
    // from the id prefix (`YYYYMMDD-HHMMSS-…`, always present and
    // total-ordered) whenever the frontmatter value is not a string, so a
    // rebuild now REPAIRS the row instead of reproducing it. Well-formed
    // episodes are byte-identical: string values pass through untouched.
    let { date, time } = fm
    if (typeof date !== 'string' || typeof time !== 'string') {
      const m = fm.id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}-/)
      if (m) {
        if (typeof date !== 'string') date = `${m[1]}-${m[2]}-${m[3]}`
        if (typeof time !== 'string') time = `${m[4]}:${m[5]}`
      }
    }

    // RFC-009 P1b: numeric priority round-trip — the frontmatter parser yields a
    // string; the writers index a Number. Malformed (hand-authored) values pass
    // through raw so the row still mirrors the file.
    const priorityNum = fm.priority !== undefined ? Number(fm.priority) : undefined
    entries.push(JSON.stringify({
      id: fm.id,
      date,
      time,
      project: fm.project,
      category: fm.category,
      status: fm.status || 'active',
      supersedes: fm.supersedes || null,
      ...(Array.isArray(fm.consolidates) ? { consolidates: fm.consolidates } : {}),
      ...(typeof fm.superseded_by === 'string' ? { superseded_by: fm.superseded_by } : {}),
      tags: normalizedTags,
      summary: fm.summary,
      // RFC-009 R1/R2/T6 activation + linkage carry (REQ-9) — present-only, no
      // null spam; keep this list in LOCKSTEP with em-store/em-revise's
      // activationIndexFields (step 2.3 parity note).
      ...(Array.isArray(fm.triggers) ? { triggers: fm.triggers } : {}),
      ...(Array.isArray(fm.applies_to_projects) ? { applies_to_projects: fm.applies_to_projects } : {}),
      ...(Array.isArray(fm.applies_to_tools) ? { applies_to_tools: fm.applies_to_tools } : {}),
      ...(Array.isArray(fm.evidence) ? { evidence: fm.evidence } : {}),
      ...(Array.isArray(fm.lessons) ? { lessons: fm.lessons } : {}),
      ...(fm.priority !== undefined ? { priority: Number.isFinite(priorityNum) ? priorityNum : fm.priority } : {}),
      ...(typeof fm.review_by === 'string' ? { review_by: fm.review_by } : {}),
      ...(typeof fm.violated_pattern === 'string' ? { violated_pattern: fm.violated_pattern } : {}),
      ...(fm.pinned === true || fm.pinned === 'true' ? { pinned: true } : {}),
      // RFC-009 P4-S4 (round-2 N2): clerk run-record + digest markers. record_type
      // feeds protection.mjs class-d (latest-run-record reservation) + the crash
      // discriminator; clerk_cutover is the clock-independent orphan stamp. Keep
      // this pair in LOCKSTEP with em-store/em-revise's index fields.
      ...((fm.record_type && !BREAK_REBUILD_WHITELIST) ? { record_type: fm.record_type } : {}),
      ...(fm.clerk_cutover ? { clerk_cutover: fm.clerk_cutover } : {}),
      // RFC-012 P2 S1 (REQ-1/REQ-5 lockstep, §8.2): identity fields written by
      // scripts/lib/store-identity.mjs round-trip the rebuild.
      ...(typeof fm.store_id === 'string' ? { store_id: fm.store_id } : {}),
      ...(typeof fm.detaches_identity_root === 'string' ? { detaches_identity_root: fm.detaches_identity_root } : {}),
      access_count: accessCount,
      last_accessed: lastAccessed,
      ...(feedback !== 0 ? { feedback } : {}),
      ...(fm.url ? { url: fm.url, fetched: fm.fetched || date } : {})
    }))
    for (const tag of normalizedTags) {
      if (!tagsIndex[tag]) tagsIndex[tag] = []
      tagsIndex[tag].push(fm.id)
    }
    // Token inverted index over the FULL file content (what the search body
    // tier greps), same source as em-store's incremental writer.
    for (const tok of episodeTokens({ summary: fm.summary, tags: normalizedTags, body: content })) {
      ;(tokensIndex[tok] ||= []).push(fm.id)
    }
    if (vocabLoaded) {
      // canonical key: deprecated → successor; unknown → its literal key (and counted).
      const catKey = canonicalCategory(fm.category)
      ;(categoryIndex[catKey] ||= []).push(fm.id)
      const rawV = validateCategory(fm.category, { allowDeprecated: true })
      if (!rawV.ok) driftUnknown[catKey] = (driftUnknown[catKey] || 0) + 1
      else if (rawV.successor) {
        const name = String(fm.category)
        driftDeprecated[name] = (driftDeprecated[name] || 0) + 1
      }
    }
  }

  // RFC-012 P2 REQ-4: exactly one active identity chain per store — a duplicate
  // (or cyclic) chain fails the build LOUDLY before any index write (EC6:
  // validate-then-write). 'no-identity' stays normal (mint is lazy, REQ-6).
  const identity = resolveStoreIdentity(dataDir)
  if (identity.error && identity.error !== 'no-identity') {
    console.log(JSON.stringify({ status: 'error', error: identity.error, scope: label }))
    process.exit(1)
  }

  const tmpFile = indexFile + '.tmp'
  fs.writeFileSync(tmpFile, entries.join('\n') + (entries.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmpFile, indexFile)

  const tagsFile = path.join(dataDir, 'tags.json')
  const tagsTmp = tagsFile + '.tmp'
  fs.writeFileSync(tagsTmp, JSON.stringify(tagsIndex, null, 2), 'utf8')
  fs.renameSync(tagsTmp, tagsFile)

  // tokens.json diet (S2): drop posting lists for tokens whose document
  // frequency exceeds DF_DROP_RATIO (40%) of the corpus. Such tokens do not
  // discriminate — their posting lists approximate "every id" and dominated
  // the file (observed 38x tokens.json/index.jsonl bloat on a 1811-episode
  // store). Dropped tokens are recorded (sorted, compact) under
  // TOKENS_DROPPED_KEY so readers treat them as NON-PRUNING (full-scoring
  // fallback) instead of zero-candidate. See lib/relevance.mjs.
  const totalDocs = entries.length
  const droppedTokens = []
  for (const tok of Object.keys(tokensIndex)) {
    if (tokensIndex[tok].length > DF_DROP_RATIO * totalDocs) {
      droppedTokens.push(tok)
      delete tokensIndex[tok]
    }
  }
  if (droppedTokens.length) tokensIndex[TOKENS_DROPPED_KEY] = droppedTokens.sort()

  // tokens.json — compact (no pretty-print: the vocabulary is large and this
  // file is machine-read only).
  const tokensFile = path.join(dataDir, 'tokens.json')
  const tokensTmp = tokensFile + '.tmp'
  fs.writeFileSync(tokensTmp, JSON.stringify(tokensIndex), 'utf8')
  fs.renameSync(tokensTmp, tokensFile)

  if (vocabLoaded) {
    const catFile = path.join(dataDir, 'category-index.json')
    const catTmp = catFile + '.tmp'
    fs.writeFileSync(catTmp, JSON.stringify(categoryIndex, null, 2), 'utf8')
    fs.renameSync(catTmp, catFile)
  } else {
    process.stderr.write(`em-rebuild-index: categories.json unloadable; ${label} category-index.json skipped (index.jsonl + tags.json built normally)\n`)
  }

  return { scope: label, count: entries.length, category_drift: { unknown: driftUnknown, deprecated: driftDeprecated } }
}

const rebuilt = []
if (scope === 'local' || scope === 'all') rebuilt.push(rebuildDir(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') rebuilt.push(rebuildDir(GLOBAL_DIR, 'global'))

console.log(JSON.stringify({ status: 'ok', rebuilt }))
