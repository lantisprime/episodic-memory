#!/usr/bin/env node
/**
 * em-search.mjs — Search episodic memories with per-project + global fallback.
 *
 * Usage:
 *   node em-search.mjs [--project <name>] [--tag <tag>] [--category <cat>]
 *                      [--query <text>] [--since <YYYY-MM-DD>] [--limit <n>]
 *                      [--scope local|global|all] [--include-superseded]
 *                      [--history <id>] [--full]
 *                      [--no-score] [--no-track]
 *                      [--warn-time-ms <n>] [--warn-count <n>]
 *
 * By default, searches local then global (scope=all), hides superseded episodes,
 * scores results by relevance, and tracks access.
 * Outputs JSON: { status, count, episodes: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { canonicalCategory } from './lib/categories.mjs'
import {
  normalizeTags, loadTagsIndex, loadCategoryIndex, loadIndex,
  computeScore, writeBackAccessTracking, scoreTextMatch,
  tokenizeQuery, loadTokensIndex, tokenCandidates, scorePartialMatch
} from './lib/relevance.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-search.mjs', usage: 'node em-search.mjs [--project <name>] [--tag <tag>] [--category <cat>] [--query <text>] [--since <YYYY-MM-DD>] [--limit <n>] [--scope local|global|all] [--include-superseded] [--history <id>] [--full] [--no-score] [--no-track] [--warn-time-ms <n>] [--warn-count <n>]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const project = flag('--project')
const tag = flag('--tag')
const category = flag('--category')
const query = flag('--query')
const since = flag('--since')
const limit = parseInt(flag('--limit') || '10', 10)
const scope = flag('--scope') || 'all'
const full = argv.includes('--full')
const includeSuperseded = argv.includes('--include-superseded')
const historyId = flag('--history')
const noScore = argv.includes('--no-score')
const noTrack = argv.includes('--no-track')
const warnTimeMs = parseInt(flag('--warn-time-ms') || '500', 10)
const warnCount = parseInt(flag('--warn-count') || '5000', 10)

const VALID_SCOPES_SEARCH = ['local', 'global', 'all']
if (!VALID_SCOPES_SEARCH.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_SEARCH.join(', ')}` }))
  process.exit(1)
}

const searchStart = Date.now()

// Retrieval primitives (normalizeTags, loadTagsIndex, loadCategoryIndex,
// loadIndex, computeScore, writeBackAccessTracking, scoreTextMatch) are
// shared with em-recall.mjs via lib/relevance.mjs — the former SYNC: blocks.

// ---------------------------------------------------------------------------
// Collect entries based on scope
// ---------------------------------------------------------------------------
let results = []

if (scope === 'local' || scope === 'all') {
  results.push(...loadIndex(LOCAL_DIR, 'local'))
}
if (scope === 'global' || scope === 'all') {
  results.push(...loadIndex(GLOBAL_DIR, 'global'))
}

const totalEpisodeCount = results.length

// Dedupe by id (local takes priority)
const seen = new Set()
results = results.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})

// ---------------------------------------------------------------------------
// History mode: show full revision chain for an episode
// ---------------------------------------------------------------------------
if (historyId) {
  const chain = []
  // Find all episodes in the revision chain
  let currentId = historyId

  // Walk backwards: find what this episode supersedes
  const allEntries = [...results]
  const byId = new Map(allEntries.map(e => [e.id, e]))

  // Find the root of the chain
  let root = byId.get(currentId)
  while (root && root.supersedes) {
    const parent = byId.get(root.supersedes)
    if (!parent) break
    root = parent
  }

  // Walk forward from root along the many-to-one edges R9 (P4) will write (REQ-14):
  //   1. inverted supersedes (existing behavior — kept first so single-supersedes chains are
  //      byte-identical; a supersedes FORK stays last-writer-wins, characterized not fixed, §17-E),
  //   2. the scalar superseded_by edge,
  //   3. a consolidates successor (an active episode whose consolidates array names current).
  // A visited Set makes a cyclic consolidates/superseded_by fixture terminate (EC7).
  if (root) {
    chain.push(root)
    const bySupersedes = new Map()
    const byConsolidates = new Map()
    for (const e of allEntries) {
      if (e.supersedes) bySupersedes.set(e.supersedes, e)
      if (Array.isArray(e.consolidates)) {
        for (const cid of e.consolidates) byConsolidates.set(cid, e)
      }
    }
    const visited = new Set([root.id])
    let current = root
    while (true) {
      let next = null
      if (bySupersedes.has(current.id)) next = bySupersedes.get(current.id)
      else if (current.superseded_by && byId.has(current.superseded_by)) next = byId.get(current.superseded_by)
      else if (byConsolidates.has(current.id)) next = byConsolidates.get(current.id)
      if (!next || visited.has(next.id)) break
      visited.add(next.id)
      chain.push(next)
      current = next
    }
  }

  // Include full body if requested
  const output = chain.map(e => {
    if (full) {
      const filePath = path.join(e._dataDir, 'episodes', `${e.id}.md`)
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8')
        const parts = content.split('---')
        const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
        return { ...e, body, _source: e._source, _dataDir: undefined }
      }
    }
    const { _dataDir, ...rest } = e
    return rest
  })

  // No access tracking for history queries (investigative, not usage signals)
  console.log(JSON.stringify({ status: 'ok', count: output.length, chain: output }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Apply filters
// ---------------------------------------------------------------------------
if (!includeSuperseded) {
  results = results.filter(e => e.status !== 'superseded')
}
if (project) {
  results = results.filter(e => e.project === project)
}
let searchWarning = null
if (tag) {
  const normalizedTag = normalizeTags(tag)[0]
  if (normalizedTag) {
    // Try tags.json from all active scopes
    let tagIds = null
    const dirs = []
    if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
    if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
    for (const dir of dirs) {
      const idx = loadTagsIndex(dir)
      if (idx && idx[normalizedTag]) {
        if (!tagIds) tagIds = new Set()
        for (const id of idx[normalizedTag]) tagIds.add(id)
      } else if (!idx) {
        searchWarning = 'tags.json missing or corrupt. Run em-rebuild-index.mjs to regenerate.'
      }
    }
    if (tagIds) {
      results = results.filter(e => tagIds.has(e.id))
    } else {
      // Fallback: linear scan with normalized comparison
      if (!searchWarning) searchWarning = 'tags.json missing or does not contain tag. Falling back to linear scan. Run em-rebuild-index.mjs to regenerate.'
      results = results.filter(e => e.tags && e.tags.map(t => t.toLowerCase().trim()).includes(normalizedTag))
    }
  }
}
if (category) {
  // Index-backed (R10d), symmetric with --tag: canonicalize the query, read category-index.json
  // from each active scope, intersect ids. Missing/corrupt index → linear-scan fallback + a
  // rebuild warning. An active-name query returns the same set as the old exact-match filter.
  const canonical = canonicalCategory(category)
  let catIds = null
  const dirs = []
  if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
  if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
  for (const dir of dirs) {
    const idx = loadCategoryIndex(dir)
    if (idx && Object.prototype.hasOwnProperty.call(idx, canonical)) {
      if (!catIds) catIds = new Set()
      for (const id of idx[canonical]) catIds.add(id)
    } else if (!idx) {
      if (!searchWarning) searchWarning = 'category-index.json missing or corrupt. Falling back to linear scan. Run em-rebuild-index.mjs to regenerate.'
    }
  }
  if (catIds) {
    results = results.filter(e => catIds.has(e.id))
  } else {
    // Fallback: linear scan. Canonicalize stored categories too so a deprecated-alias query
    // still matches; for an active name with no aliases this is exactly the old e.category === c.
    results = results.filter(e => e.category === category || canonicalCategory(e.category) === canonical)
  }
}
if (since) {
  results = results.filter(e => e.date >= since)
}

// Full-text search: tiered matcher from lib/relevance.mjs. Contiguous
// summary/body substring matches keep their pre-lib scores (1.0/0.7/0.4);
// multi-term queries additionally match when every token lands somewhere in
// summary/tags/body, scored by discounted field weights.
//
// Acceleration: tokens.json (when present in every active scope) prunes the
// candidate set first — key-containment lookups reproduce the substring
// semantics exactly, so only true candidates get scored and bodies are read
// only for that handful instead of for every episode in the store. Missing
// tokens.json degrades to the full scan with a rebuild hint.
//
// Partial tier: when the strict AND tiers leave the limit unfilled, episodes
// matching at least half the query tokens fill the remainder (capped at
// text_match 0.35 — below the weakest full match), marked "match":"partial".
if (query) {
  const qtokens = tokenizeQuery(query)
  let candidateInfo = null
  if (qtokens.length > 0) {
    const dirs = []
    if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
    if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
    const presentDirs = dirs.filter(d => fs.existsSync(path.join(d, 'index.jsonl')))
    const idxs = presentDirs.map(d => loadTokensIndex(d))
    if (idxs.length > 0 && idxs.every(Boolean)) {
      candidateInfo = tokenCandidates(idxs, qtokens)
    } else if (results.length > 0) {
      if (!searchWarning) searchWarning = 'tokens.json missing in one or more stores — full-scan search. Run em-rebuild-index.mjs to build the token index.'
    }
  }

  // Episodes the token index has never seen (hand-written rows, stores
  // predating tokens.json) bypass pruning and take the full-scoring path —
  // index gaps degrade to a slower search, never to hidden episodes.
  //
  // Dropped-token semantics (S2 diet): a query token recorded under
  // "_dropped" is common-by-df, not absent — its posting list was removed on
  // purpose. tokenCandidates already excludes dropped tokens from the AND
  // intersection (they are non-pruning), and returns all === null when NO
  // token can prune, in which case the query full-scans. Either way the
  // final scoring below is the same scoreTextMatch a scan would run, so
  // results stay byte-identical to the pre-diet index.
  const pool = candidateInfo && candidateInfo.all !== null
    ? results.filter(e => candidateInfo.all.has(e.id) || !candidateInfo.covered.has(e.id))
    : results
  const matched = pool.filter(e => {
    const readBody = () => {
      const filePath = path.join(e._dataDir, 'episodes', `${e.id}.md`)
      try { return fs.readFileSync(filePath, 'utf8') } catch { return null }
    }
    const { matched: isMatch, textMatch, body } = scoreTextMatch(e, query, readBody)
    if (!isMatch) return false
    e._textMatch = textMatch
    if (full && body) e._body = body
    return true
  })

  let partials = []
  if (!noScore && qtokens.length > 1 && matched.length < limit) {
    const matchedIds = new Set(matched.map(e => e.id))
    // With the token index, body membership is known without file reads and
    // the pool narrows to episodes containing at least one token; on the
    // fallback path, partials come from summary/tags only (no O(n) body reads).
    //
    // Dropped tokens (S2 diet) have no posting lists, so (a) an episode whose
    // only hit is a dropped token is missing from `any` — when any query
    // token is dropped the partial pool must widen to every candidate row,
    // and (b) perToken cannot answer body membership for them — inBody falls
    // back to reading the episode body (cached per episode), reproducing the
    // pre-diet index answer exactly.
    const hasDropped = candidateInfo && candidateInfo.dropped.size > 0
    const partialPool = (candidateInfo && !hasDropped
      ? results.filter(e => candidateInfo.any.has(e.id) || !candidateInfo.covered.has(e.id))
      : results)
      .filter(e => !matchedIds.has(e.id))
    for (const e of partialPool) {
      let bodyLower // lazy, read at most once per episode
      const readBodyLower = () => {
        if (bodyLower === undefined) {
          try {
            bodyLower = fs.readFileSync(path.join(e._dataDir, 'episodes', `${e.id}.md`), 'utf8').toLowerCase()
          } catch { bodyLower = null }
        }
        return bodyLower
      }
      const inBody = candidateInfo
        ? (tok => {
            if (candidateInfo.perToken.get(tok)?.has(e.id)) return true
            if (!candidateInfo.dropped.has(tok)) return false
            const b = readBodyLower()
            return b ? b.includes(tok) : false
          })
        : (() => false)
      const { matched: isPartial, textMatch } = scorePartialMatch(e, qtokens, inBody)
      if (isPartial) {
        e._textMatch = textMatch
        e._partial = true
        partials.push(e)
      }
    }
  }

  results = [...matched, ...partials]
}

// ---------------------------------------------------------------------------
// Score and sort
// ---------------------------------------------------------------------------
if (!noScore) {
  for (const e of results) {
    const textMatch = e._textMatch || 1.0
    e._score = computeScore(e, textMatch)
  }
  results.sort((a, b) => b._score - a._score)
} else {
  // No scoring — keep date-based sort, tolerant of foreign-harness index rows
  // (hand-appended without em-store): only string-typed fields participate. A
  // non-string date would either crash (NaN.localeCompare) or, stringified,
  // out-sort ISO keys ("20260703" > "2026-07-04..."); time joins only when
  // date is a string so a time-only key cannot beat ISO date keys. Rows
  // without a string date get key '' and sort last in descending order.
  const dtKey = e => typeof e.date === 'string' ? e.date + (typeof e.time === 'string' ? e.time : '') : ''
  results.sort((a, b) => dtKey(b).localeCompare(dtKey(a)))
}

// Apply limit AFTER scoring/sorting
results = results.slice(0, limit)

// ---------------------------------------------------------------------------
// Access tracking write-back
// Skip for: --no-track, --include-superseded (investigative queries)
// ---------------------------------------------------------------------------
if (!noTrack && !includeSuperseded) {
  writeBackAccessTracking(results)
}

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------
const output = results.map(e => {
  const { _dataDir, _source, _textMatch, _score, _body, _partial, ...rest } = e
  const entry = { ...rest, source: _source }
  if (_partial) entry.match = 'partial'
  if (!noScore && _score !== undefined) {
    entry.score = Math.round(_score * 1000) / 1000
  }
  if (full) {
    const content = _body || (() => {
      const filePath = path.join(_dataDir, 'episodes', `${e.id}.md`)
      try { return fs.readFileSync(filePath, 'utf8') } catch { return null }
    })()
    if (content) {
      const parts = content.split('---')
      const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
      entry.body = body
    }
  }
  return entry
})

const result = { status: 'ok', count: output.length, episodes: output }

// Performance health check
const elapsed = Date.now() - searchStart
const warnings = []
if (searchWarning) warnings.push(searchWarning)
if (elapsed > warnTimeMs) {
  warnings.push(`Search took ${elapsed}ms across ${totalEpisodeCount} episodes. Consider running em-prune.mjs to archive stale episodes.`)
}
if (totalEpisodeCount > warnCount) {
  warnings.push(`${totalEpisodeCount} episodes in index. Performance may degrade. Run em-prune.mjs --dry-run to check for prunable episodes.`)
}
if (warnings.length) result.warning = warnings.join(' | ')

console.log(JSON.stringify(result))
