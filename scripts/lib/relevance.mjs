// relevance.mjs — shared retrieval primitives for the memory substrate.
//
// Single source of truth for the functions em-search.mjs and em-recall.mjs
// previously duplicated under SYNC: comments (computeScore, loadIndex,
// normalizeTags, loadTagsIndex, writeBackAccessTracking), plus the tokenized
// multi-term text matcher that upgrades --query from exact-substring-only to
// field-weighted token matching.
//
// Scoring contract (pinned by tests/test-phase2.mjs — do not reorder tiers):
//   exact summary match            → text_match 1.0
//   whole-query substring, summary → text_match 0.7
//   all query tokens found across
//     summary/tags/body            → text_match 0.95 × avg(per-token best
//                                    field weight)  (max 0.665 — always below
//                                    a contiguous summary substring match)
//   whole-query substring, body    → text_match 0.4
// The final signal is the MAX of the applicable tiers, so every query that
// matched before this lib existed still matches with an identical score;
// token matching only ADDS results (and never outranks a contiguous match
// in the same field).
//
// Zero external dependencies — Node.js stdlib only.

import fs from 'fs'
import path from 'path'

// Per-token field weights for the multi-term tier. Summary tokens count just
// under a contiguous summary substring (0.7); tags sit between summary and
// body; body tokens mirror the body-substring tier (0.4).
export const FIELD_WEIGHTS = { summary: 0.7, tags: 0.6, body: 0.4 }

// Discount applied to the averaged token weights so a scattered token match
// can never tie a contiguous substring match in the same field.
const TOKEN_MATCH_DISCOUNT = 0.95

// ---------------------------------------------------------------------------
// normalizeTags(raw) — comma string or array → lowercased, trimmed, deduped,
// sorted tag list.
// ---------------------------------------------------------------------------
export function normalizeTags(raw) {
  if (!raw) return []
  const arr = (Array.isArray(raw) ? raw : raw.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(arr)].sort()
}

// ---------------------------------------------------------------------------
// loadTagsIndex(dataDir) / loadCategoryIndex(dataDir) — inverted indexes.
// Return null when missing/corrupt (callers degrade to linear scan).
// ---------------------------------------------------------------------------
export function loadTagsIndex(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'tags.json'), 'utf8'))
  } catch {
    return null
  }
}

export function loadCategoryIndex(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'category-index.json'), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// loadIndex(dataDir, source) — read index.jsonl rows, tagging each with the
// scope it came from. Malformed lines are skipped, not fatal.
// ---------------------------------------------------------------------------
export function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try {
      const entry = JSON.parse(line)
      entry._source = source
      entry._dataDir = dataDir
      return entry
    } catch { return null }
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// computeScore(entry, textMatchScore) — relevance = text match × linear time
// decay × usage boost.
//
//   time decay   linear over a year, floored at 0.1 — except PINNED episodes
//                (entry.pinned === true), whose floor is 0.6: a pinned
//                architecture decision stays competitive with fresh episodes
//                indefinitely instead of decaying like a routine note.
//   usage boost  1 + log1p(access_count)·0.1 + feedback·0.05 (clamped to
//                [-0.3, +0.5]). `feedback` is the em-feedback usefulness
//                counter — retrieval alone (access_count) says an episode was
//                SEEN; feedback says it actually helped (+) or was noise (−).
//                Absent/zero feedback reproduces the historical score exactly.
// ---------------------------------------------------------------------------
export function computeScore(entry, textMatchScore) {
  const accessCount = entry.access_count || 0
  // Use new Date(entry.date) for decay — sub-day precision unnecessary
  const created = new Date(entry.date)
  const daysSince = Math.max(0, (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24))
  const floor = entry.pinned === true ? 0.6 : 0.1
  const timeFactor = Math.max(floor, 1 - (daysSince / 365))
  const feedback = typeof entry.feedback === 'number' ? entry.feedback : 0
  const feedbackBoost = Math.max(-0.3, Math.min(0.5, feedback * 0.05))
  const accessFactor = 1 + Math.log1p(accessCount) * 0.1 + feedbackBoost
  return textMatchScore * timeFactor * accessFactor
}

// ---------------------------------------------------------------------------
// writeBackAccessTracking(results) — best-effort access_count/last_accessed
// bump, grouped per source store. Last-writer-wins for concurrent searches.
// ---------------------------------------------------------------------------
export function writeBackAccessTracking(results) {
  const byDir = new Map()
  for (const e of results) {
    if (!e._dataDir) continue
    if (!byDir.has(e._dataDir)) byDir.set(e._dataDir, new Set())
    byDir.get(e._dataDir).add(e.id)
  }

  const now = new Date().toISOString().slice(0, 19) + 'Z'

  for (const [dataDir, ids] of byDir) {
    const indexFile = path.join(dataDir, 'index.jsonl')
    try {
      // Re-read just before writing to narrow race window with concurrent em-store appends.
      // This is best-effort — last-writer-wins for concurrent searches is acceptable.
      const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      const updated = lines.map(line => {
        try {
          const entry = JSON.parse(line)
          if (ids.has(entry.id)) {
            entry.access_count = (entry.access_count || 0) + 1
            entry.last_accessed = now
          }
          return JSON.stringify(entry)
        } catch { return line }
      })
      const tmpFile = indexFile + '.tmp'
      fs.writeFileSync(tmpFile, updated.join('\n') + '\n', 'utf8')
      fs.renameSync(tmpFile, indexFile)
    } catch {
      // Access tracking is best-effort — skip silently on failure
    }
  }
}

// ---------------------------------------------------------------------------
// tokenizeQuery(text) — lowercase alphanumeric tokens (length ≥ 2), deduped,
// input order preserved. The unit the multi-term tier matches on.
// ---------------------------------------------------------------------------
export function tokenizeQuery(text) {
  if (!text) return []
  return [...new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)
  )]
}

// ---------------------------------------------------------------------------
// scoreTextMatch(entry, query, readBody) — the tiered matcher.
//
//   entry:    index row ({ summary, tags, ... })
//   query:    raw query string (case-insensitive)
//   readBody: () => string|null — lazy body loader; called at most once, only
//             when summary/tags alone cannot settle the match. Pass null to
//             restrict matching to index fields.
//
// Returns { matched, textMatch, body } — body is the loaded content when
// readBody was invoked (so callers can reuse it for --full output without a
// second read), else undefined.
// ---------------------------------------------------------------------------
export function scoreTextMatch(entry, query, readBody) {
  const queryLower = query.toLowerCase()
  const summaryLower = (entry.summary || '').toLowerCase()

  // Tier 1/2: contiguous match in summary — body never needs loading.
  if (summaryLower.includes(queryLower)) {
    return { matched: true, textMatch: summaryLower === queryLower ? 1.0 : 0.7 }
  }

  const tokens = tokenizeQuery(queryLower)
  const tagsLower = normalizeTags(entry.tags).join(' ')

  // Multi-term tier, index-field pass: which tokens already resolve from
  // summary/tags? Only unresolved tokens force a body read.
  const weights = new Map()
  for (const tok of tokens) {
    if (summaryLower.includes(tok)) weights.set(tok, FIELD_WEIGHTS.summary)
    else if (tagsLower.includes(tok)) weights.set(tok, FIELD_WEIGHTS.tags)
  }

  const needsBody = tokens.length === 0 || weights.size < tokens.length
  const body = needsBody && readBody ? readBody() : null
  const bodyLower = body ? body.toLowerCase() : null

  if (bodyLower) {
    for (const tok of tokens) {
      if (!weights.has(tok) && bodyLower.includes(tok)) weights.set(tok, FIELD_WEIGHTS.body)
    }
  }

  let tokenScore = 0
  if (tokens.length > 0 && weights.size === tokens.length) {
    // AND semantics: every token must land somewhere. Score = discounted
    // average of each token's best field weight.
    let sum = 0
    for (const w of weights.values()) sum += w
    tokenScore = TOKEN_MATCH_DISCOUNT * (sum / tokens.length)
  }

  // Tier 4: whole-query substring in body (the pre-lib body tier).
  const bodySubstring = bodyLower && bodyLower.includes(queryLower) ? FIELD_WEIGHTS.body : 0

  const textMatch = Math.max(tokenScore, bodySubstring)
  if (textMatch > 0) {
    return { matched: true, textMatch, body: body || undefined }
  }
  return { matched: false, textMatch: 0 }
}

// ---------------------------------------------------------------------------
// Token inverted index (tokens.json): { "<token>": [episode ids...] }.
//
// Purpose: without it, every --query that misses the summary reads EVERY
// episode body off disk — O(n) file reads per search. The token index prunes
// the candidate set first; bodies are then read only for the few candidates,
// and only when tier scoring needs them. Final scores are computed by the
// same scoreTextMatch, so index-accelerated results are byte-identical to a
// full scan.
//
// Substring equivalence: query tokens and text tokens are produced by the
// same [^a-z0-9]+ splitter, so a query token appearing as a raw-text
// substring necessarily lies inside one maximal alphanumeric run — i.e.
// inside one indexed token. Scanning vocabulary KEYS for containment
// (key.includes(qtok)) therefore reproduces `text.includes(qtok)` exactly
// ("auth" still hits "authentication").
// ---------------------------------------------------------------------------
export function episodeTokens({ summary, tags, body }) {
  const toks = new Set()
  for (const t of tokenizeQuery(summary || '')) toks.add(t)
  for (const tag of normalizeTags(tags)) for (const t of tokenizeQuery(tag)) toks.add(t)
  for (const t of tokenizeQuery(body || '')) toks.add(t)
  return toks
}

export function loadTokensIndex(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8'))
  } catch {
    return null
  }
}

// Incremental writer, structurally mirroring em-store's updateTagsIndex.
// Shared here (not in em-store) because em-store executes top-level on import.
export function updateTokensIndex(dataDir, episodeId, tokens) {
  const tokensFile = path.join(dataDir, 'tokens.json')
  let index = {}
  try {
    index = JSON.parse(fs.readFileSync(tokensFile, 'utf8'))
  } catch {}
  for (const tok of tokens) {
    if (!index[tok]) index[tok] = []
    if (!index[tok].includes(episodeId)) index[tok].push(episodeId)
  }
  const tmpFile = tokensFile + '.tmp'
  fs.writeFileSync(tmpFile, JSON.stringify(index), 'utf8')
  fs.renameSync(tmpFile, tokensFile)
}

// tokenCandidates(indexes, queryTokens) — resolve query tokens against one or
// more stores' token indexes (already-parsed objects). Returns:
//   perToken  Map<queryToken, Set<id>> — ids whose text contains that token
//   all       Set<id> — ids containing EVERY query token (the AND candidates)
//   any       Set<id> — ids containing AT LEAST ONE token (the partial pool)
//   covered   Set<id> — every id the index knows about AT ALL. An episode
//             absent from `covered` (hand-written row, store predating
//             tokens.json) must NOT be pruned by the index — callers fall
//             back to full scoring for it, so index gaps degrade to the slow
//             path instead of silently hiding episodes.
export function tokenCandidates(indexes, queryTokens) {
  const perToken = new Map(queryTokens.map(q => [q, new Set()]))
  const covered = new Set()
  for (const idx of indexes) {
    for (const key of Object.keys(idx)) {
      const ids = idx[key]
      if (!Array.isArray(ids)) continue
      for (const id of ids) covered.add(id)
      for (const qtok of queryTokens) {
        if (key.includes(qtok)) {
          const set = perToken.get(qtok)
          for (const id of ids) set.add(id)
        }
      }
    }
  }
  let all = null
  const any = new Set()
  for (const ids of perToken.values()) {
    for (const id of ids) any.add(id)
    if (all === null) all = new Set(ids)
    else for (const id of all) { if (!ids.has(id)) all.delete(id) }
  }
  return { perToken, all: all || new Set(), any, covered }
}

// ---------------------------------------------------------------------------
// scorePartialMatch(entry, queryTokens, tokenInBody) — best-effort tier for
// multi-term queries where the strict AND tiers found nothing (or too little):
// at least half the tokens must land somewhere; scored 0.5 × coverage ×
// avg(matched field weights), capping at 0.35 — always below the weakest full
// match (0.38), so partials trail full matches at equal freshness.
// tokenInBody(tok) reports body membership without a file read (token-index
// backed); pass () => false to restrict to summary/tags.
// ---------------------------------------------------------------------------
export function scorePartialMatch(entry, queryTokens, tokenInBody) {
  if (queryTokens.length < 2) return { matched: false, textMatch: 0 }
  const summaryLower = (entry.summary || '').toLowerCase()
  const tagsLower = normalizeTags(entry.tags).join(' ')
  let sum = 0
  let matched = 0
  for (const tok of queryTokens) {
    if (summaryLower.includes(tok)) { sum += FIELD_WEIGHTS.summary; matched++ }
    else if (tagsLower.includes(tok)) { sum += FIELD_WEIGHTS.tags; matched++ }
    else if (tokenInBody(tok)) { sum += FIELD_WEIGHTS.body; matched++ }
  }
  const coverage = matched / queryTokens.length
  if (coverage < 0.5 || matched === queryTokens.length) {
    // full matches belong to scoreTextMatch's tiers, not here
    return { matched: false, textMatch: 0 }
  }
  return { matched: true, textMatch: 0.5 * coverage * (sum / matched) }
}
