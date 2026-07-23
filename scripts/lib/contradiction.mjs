// ---------------------------------------------------------------------------
// contradiction.mjs — advisory near-duplicate / contradiction detection over
// index rows (#537).
//
// Two active `decision` episodes in the same project whose SUMMARIES share most
// of their tokens are very likely the same decision stored twice: the second one
// written with em-store instead of em-revise, so nothing links them and both
// stay active and searchable. This module finds those pairs.
//
// ADVISORY ONLY. It derives no knowledge, writes nothing, changes no ranking,
// and gates nothing (PRINCIPLES.md P1; CAPABILITIES.md criterion 4; RFC-008 R1).
// Callers surface its output and carry on.
//
// Index rows only: `summary` is present on every index row, so no episode body
// is read — em-doctor is deliberately index-only and stays that way.
// ---------------------------------------------------------------------------

import { tokenizeQuery } from './relevance.mjs'

// Summary-token Jaccard at or above this is reported. 0.6 is deliberately high:
// "Config files use JSON format" vs "Config files use YAML format" scores
// 4/6 = 0.667, while two genuinely different decisions in one project score far
// below it. Compare topic-tracks/config.json summary_jaccard_min = 0.2, which is
// tuned for clustering RECALL; an advisory needs PRECISION.
export const SUMMARY_JACCARD_MIN = 0.6

// Pairwise comparison is O(n^2) inside a project group. A group above this many
// active decisions is SKIPPED and named in the result — never silently dropped.
export const MAX_GROUP = 2000

export function summaryTokenSet(summary) {
  return new Set(tokenizeQuery(typeof summary === 'string' ? summary : ''))
}

// Jaccard over two token sets. An EMPTY set matches NOTHING, including another
// empty set: an empty summary would otherwise compare equal to itself and to
// every other empty summary, manufacturing candidates out of nothing.
export function summaryJaccard(a, b) {
  if (!a || !b || !a.size || !b.size) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function round3(n) {
  return Math.round(n * 1000) / 1000
}

// Only ACTIVE DECISION rows are candidates. A superseded row is already linked
// by its revision chain and drops out of default search, so it is not a silent
// contradiction.
function isCandidateRow(row) {
  return !!row &&
    row.status === 'active' &&
    row.category === 'decision' &&
    typeof row.id === 'string' &&
    typeof row.summary === 'string'
}

// True when `from` reaches `to` by following supersedes pointers, in either
// direction, transitively. A sanctioned correction is linked, so it is never a
// contradiction candidate. The `seen` set makes a corrupt cyclic chain
// terminate instead of hanging.
function chainLinked(a, b, byId) {
  for (const [from, to] of [[a, b], [b, a]]) {
    let cur = from
    const seen = new Set()
    while (cur && typeof cur.supersedes === 'string' && !seen.has(cur.supersedes)) {
      if (cur.supersedes === to.id) return true
      seen.add(cur.supersedes)
      cur = byId.get(cur.supersedes)
    }
  }
  return false
}

// findContradictionsFor(episode, rows, opts) — ONE vs MANY.
// Used by em-store at write time: the episode just written against everything
// already in the index. O(n).
export function findContradictionsFor(episode, rows, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : SUMMARY_JACCARD_MIN
  if (!isCandidateRow(episode)) return []
  const all = Array.isArray(rows) ? rows : []
  const byId = new Map()
  for (const r of all) if (r && typeof r.id === 'string') byId.set(r.id, r)
  byId.set(episode.id, episode)
  const mine = summaryTokenSet(episode.summary)
  if (!mine.size) return []
  const out = []
  for (const row of all) {
    if (!isCandidateRow(row)) continue
    if (row.id === episode.id) continue
    if (row.project !== episode.project) continue
    const theirs = summaryTokenSet(row.summary)
    if (!theirs.size) continue
    if (chainLinked(episode, row, byId)) continue
    const sim = summaryJaccard(mine, theirs)
    if (sim < threshold) continue
    out.push({ id: row.id, summary: row.summary, similarity: round3(sim) })
  }
  out.sort((x, y) => y.similarity - x.similarity || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  return out
}

// findContradictionCandidates(rows, opts) — ALL PAIRS, grouped by project.
// Used by em-doctor at audit time. O(n^2) inside each group, capped by maxGroup.
export function findContradictionCandidates(rows, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : SUMMARY_JACCARD_MIN
  const maxGroup = typeof opts.maxGroup === 'number' ? opts.maxGroup : MAX_GROUP
  const all = Array.isArray(rows) ? rows : []
  const byId = new Map()
  for (const r of all) if (r && typeof r.id === 'string') byId.set(r.id, r)
  const groups = new Map()
  for (const row of all) {
    if (!isCandidateRow(row)) continue
    const key = typeof row.project === 'string' ? row.project : ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const pairs = []
  const skipped = []
  for (const [project, members] of groups) {
    if (members.length > maxGroup) {
      skipped.push({ project, active_decisions: members.length })
      continue
    }
    const tokens = members.map(m => summaryTokenSet(m.summary))
    for (let i = 0; i < members.length; i++) {
      if (!tokens[i].size) continue
      for (let j = i + 1; j < members.length; j++) {
        if (!tokens[j].size) continue
        if (chainLinked(members[i], members[j], byId)) continue
        const sim = summaryJaccard(tokens[i], tokens[j])
        if (sim < threshold) continue
        const ordered = members[i].id < members[j].id ? [members[i], members[j]] : [members[j], members[i]]
        pairs.push({
          project,
          a: ordered[0].id,
          b: ordered[1].id,
          similarity: round3(sim),
          summary_a: ordered[0].summary,
          summary_b: ordered[1].summary
        })
      }
    }
  }
  pairs.sort((x, y) =>
    y.similarity - x.similarity ||
    (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
    (x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
  skipped.sort((x, y) => (x.project < y.project ? -1 : x.project > y.project ? 1 : 0))
  return { pairs, skipped }
}
