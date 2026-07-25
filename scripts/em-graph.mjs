#!/usr/bin/env node
/**
 * em-graph.mjs — typed-edge traversal over the episode graph (RFC-007 core).
 *
 * The store is already a graph — supersedes chains, consolidation digests,
 * lesson→violation evidence links, body citations, shared tags — but nothing
 * traverses it. This projects those edges and answers the questions search
 * can't: "what led to this decision?", "what came out of this incident?",
 * "what's connected that search won't surface?".
 *
 * Usage:
 *   node em-graph.mjs --from <episode-id> [--depth <n>] [--edges <list>]
 *                     [--scope local|global|all] [--limit <n>] [--include-superseded]
 *   node em-graph.mjs --orphans [--scope ...]     # no non-tag edges at all
 *   node em-graph.mjs --hubs [--top <n>]          # highest-degree episodes
 *
 * Edge types (--edges, comma list or "all"; default supersedes,consolidates,evidence,cites):
 *   supersedes     new → old (supersedes / superseded_by index fields)
 *   consolidates   digest → member
 *   evidence       lesson → violation (evidence[] / lessons[] index fields)
 *   cites          episode → episode whose id appears in its BODY (lineage
 *                  across categories; fenced code + inline backticks skipped,
 *                  self-references filtered)
 *   tags           episode → tag:<name> pseudo-node (opt-in: tag fan-out is
 *                  the noisiest edge; include for cluster queries)
 *
 * Traversal is UNDIRECTED breadth-first from --from (edges keep their true
 * direction in the output), depth default 2, node limit default 50 (closest
 * first; `truncated: true` when hit). Projection over file storage, not a
 * graph DB (Principle 1): built fresh per query from index rows + one body
 * pass when `cites` is selected — always current, no sidecar to drift.
 *
 * Outputs JSON: { status, root, nodes: [...], edges: [{from,to,type}], truncated? }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir, resolveRepoRoot } from './lib/local-dir.mjs'
import { loadIndex } from './lib/relevance.mjs'
import { resolveRuleDir, scanRuleNodes, scanRfcNodes } from './lib/rule-nodes.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-graph.mjs', usage: 'node em-graph.mjs (--from <id> [--depth <n>] [--edges supersedes,consolidates,evidence,cites,tags|all] [--nodes episode,rule,rfc|all] [--limit <n>] | --orphans | --hubs [--top <n>]) [--scope local|global|all] [--include-superseded] — typed-edge traversal over the episode graph (RFC-007)' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

// Bounds must be real non-negative integers: parseInt('abc') is NaN, and every
// NaN comparison is false, so a garbage --limit/--depth would silently disable
// the bound instead of erroring (RFC-007 "Depth bounds" / "Result-set cap":
// invalid bounds are rejected with exit 2).
function intFlag(name, dflt, min) {
  const raw = flag(name)
  if (raw === undefined) return dflt
  if (!/^\d+$/.test(raw.trim()) || parseInt(raw, 10) < min) {
    console.log(JSON.stringify({ status: 'error', message: `Invalid ${name} "${raw}": expected an integer >= ${min}.` }))
    process.exit(2)
  }
  return parseInt(raw, 10)
}

const from = flag('--from')
const depth = intFlag('--depth', 2, 0)
const limit = intFlag('--limit', 50, 1)
const top = intFlag('--top', 10, 1)
const scope = flag('--scope') || 'all'
const orphans = argv.includes('--orphans')
const hubs = argv.includes('--hubs')
const includeSuperseded = argv.includes('--include-superseded')

const NODE_TYPES = ['episode', 'rule', 'rfc']
const DEFAULT_NODES = ['episode']
const nodesRaw = flag('--nodes')
const nodeTypes = nodesRaw === 'all' ? NODE_TYPES
  : nodesRaw ? nodesRaw.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_NODES
for (const n of nodeTypes) {
  if (!NODE_TYPES.includes(n)) {
    console.log(JSON.stringify({ status: 'error', message: `Unknown node type "${n}". Valid: ${NODE_TYPES.join(', ')} (or "all").` }))
    process.exit(2)
  }
}

const EDGE_TYPES = ['supersedes', 'consolidates', 'evidence', 'cites', 'tags']
const DEFAULT_EDGES = ['supersedes', 'consolidates', 'evidence', 'cites']
const edgesRaw = flag('--edges')
const edgeTypes = edgesRaw === 'all' ? EDGE_TYPES
  : edgesRaw ? edgesRaw.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_EDGES
for (const e of edgeTypes) {
  if (!EDGE_TYPES.includes(e)) {
    console.log(JSON.stringify({ status: 'error', message: `Unknown edge type "${e}". Valid: ${EDGE_TYPES.join(', ')} (or "all").` }))
    process.exit(2)
  }
}

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}
if ([from !== undefined, orphans, hubs].filter(Boolean).length !== 1) {
  console.log(JSON.stringify({ status: 'error', message: 'Exactly one of --from <id> / --orphans / --hubs is required.' }))
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Load rows (local shadows global on id collision, matching the readers)
// ---------------------------------------------------------------------------
let rows = []
if (scope === 'local' || scope === 'all') rows.push(...loadIndex(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') rows.push(...loadIndex(GLOBAL_DIR, 'global'))
const seen = new Set()
rows = rows.filter(r => {
  if (typeof r.id !== 'string' || seen.has(r.id)) return false
  seen.add(r.id)
  return true
})
// The projection ALWAYS includes superseded rows: lineage edges (a digest's
// consolidated members, a chain's ancestors) are real even though the rows
// no longer surface in search. Analytics modes below filter only what they
// REPORT — never what they count edges over — so a digest with two
// superseded members is a hub (degree 2), not an orphan.
const byId = new Map(rows.map(r => [r.id, r]))

// Opt-in only. With no --nodes flag the rule corpus is never read: no stat, no readdir,
// and nodeDiag() contributes nothing, so default output stays byte-identical (REQ-8).
const ruleById = new Map()
const rfcById = new Map()
let skippedNodes = 0
const REPO_ROOT = nodeTypes.includes('rfc') ? resolveRepoRoot() : null
if (nodeTypes.includes('rule')) {
  const scanned = scanRuleNodes(resolveRuleDir())
  if (scanned.collisions.length > 0) {
    console.log(JSON.stringify({ status: 'error', message: `Rule slug collision: ${[...new Set(scanned.collisions)].join(', ')}. Multiple rule files project the same slug; rename one frontmatter "name" to disambiguate.` }))
    process.exit(2)
  }
  for (const [k, v] of scanned.ruleById) ruleById.set(k, v)
  skippedNodes += scanned.skipped
}
if (nodeTypes.includes('rfc')) {
  const scanned = scanRfcNodes(path.join(REPO_ROOT, 'docs', 'rfcs'))
  for (const [k, v] of scanned.rfcById) rfcById.set(k, v)
  skippedNodes += scanned.skipped
}
const nodeDiag = () => (nodesRaw === undefined ? {} : { skipped_nodes: skippedNodes })

// ---------------------------------------------------------------------------
// Edge projection. adjacency: id -> [{from,to,type}] (edge listed under BOTH
// endpoints for undirected traversal; emitted once via a key set).
// ---------------------------------------------------------------------------
const adjacency = new Map()
const edgeKeys = new Set()

// NUL cannot appear in an episode id (ID_RE admits no control characters) or
// in a tag name, so it is a collision-proof joiner for edge keys — a tag MAY
// contain spaces (real-store precedent: a stored tag with six space-separated
// words), which is why the key is not space-joined. Built via charCode so the
// source file itself stays free of raw control bytes (guarded by
// tests/test-no-raw-control-bytes.mjs).
const EDGE_KEY_SEP = String.fromCharCode(0)
const edgeKey = (a, b, type) => a + EDGE_KEY_SEP + b + EDGE_KEY_SEP + type

function addEdge(a, b, type) {
  if (a === b) return
  const key = edgeKey(a, b, type)
  if (edgeKeys.has(key)) return
  edgeKeys.add(key)
  const edge = { from: a, to: b, type }
  for (const end of [a, b]) {
    if (!adjacency.has(end)) adjacency.set(end, [])
    adjacency.get(end).push(edge)
  }
}

const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])

// Fenced code blocks + inline backticks are stripped before citation scan so
// example ids in code samples don't fabricate lineage (RFC-007 cites rule).
const ID_RE = /\d{8}-\d{6}-[a-z0-9-]+-[a-f0-9]{4}/g
function bodyCitations(row, dataDir) {
  try {
    const content = fs.readFileSync(path.join(dataDir, 'episodes', `${row.id}.md`), 'utf8')
    // BODY only: frontmatter ids (supersedes:, superseded_by:, consolidates:)
    // are already first-class edges — rescanning them as cites would emit
    // duplicate parallel edges for every chain link.
    const parts = content.split('---')
    const body = parts.length >= 3 ? parts.slice(2).join('---') : content
    const cleaned = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    return [...new Set(cleaned.match(ID_RE) || [])].filter(id => id !== row.id && byId.has(id))
  } catch { return [] }
}

for (const r of rows) {
  if (edgeTypes.includes('supersedes')) {
    if (typeof r.supersedes === 'string' && byId.has(r.supersedes)) addEdge(r.id, r.supersedes, 'supersedes')
    if (typeof r.superseded_by === 'string' && byId.has(r.superseded_by)) addEdge(r.superseded_by, r.id, 'supersedes')
  }
  if (edgeTypes.includes('consolidates')) {
    for (const m of strings(r.consolidates)) if (byId.has(m)) addEdge(r.id, m, 'consolidates')
  }
  if (edgeTypes.includes('evidence')) {
    for (const v of strings(r.evidence)) if (byId.has(v)) addEdge(r.id, v, 'evidence')
    for (const l of strings(r.lessons)) if (byId.has(l)) addEdge(l, r.id, 'evidence')
  }
  if (edgeTypes.includes('cites')) {
    for (const cited of bodyCitations(r, r._dataDir)) addEdge(r.id, cited, 'cites')
  }
  if (edgeTypes.includes('tags')) {
    for (const tag of strings(r.tags)) addEdge(r.id, `tag:${tag.toLowerCase().trim()}`, 'tags')
  }
}

function nodeOut(id, dist) {
  if (id.startsWith('tag:')) return { id, type: 'tag', distance: dist }
  if (ruleById.has(id)) {
    const n = ruleById.get(id)
    return { id, type: 'rule', distance: dist, entry_point: n.entry_point, file: n.file }
  }
  if (rfcById.has(id)) {
    const n = rfcById.get(id)
    return { id, type: 'rfc', distance: dist, entry_point: n.entry_point, file: n.file }
  }
  const r = byId.get(id)
  return {
    id,
    type: 'episode',
    distance: dist,
    summary: r?.summary,
    category: r?.category,
    project: r?.project,
    status: r?.status,
    date: r?.date,
    source: r?._source,
    ...(r?.pinned === true ? { pinned: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
if (orphans || hubs) {
  // Degree over non-tag edges (tag fan-in would make everything a hub).
  const degree = new Map(rows.map(r => [r.id, 0]))
  for (const key of edgeKeys) {
    const [a, b, type] = key.split(EDGE_KEY_SEP)
    if (type === 'tags') continue
    if (degree.has(a)) degree.set(a, degree.get(a) + 1)
    if (degree.has(b)) degree.set(b, degree.get(b) + 1)
  }
  const reportable = r => includeSuperseded || r.status !== 'superseded'
  if (orphans) {
    const out = rows.filter(r => reportable(r) && degree.get(r.id) === 0).map(r => nodeOut(r.id, 0))
    // Phase 2 gives rule/rfc nodes no edges, so every one is degree 0 and is an orphan
    // by the mode's own definition. Appended only when --nodes opted them in; both maps
    // are empty otherwise, so the default result set is unchanged (REQ-8).
    for (const id of ruleById.keys()) out.push(nodeOut(id, 0))
    for (const id of rfcById.keys()) out.push(nodeOut(id, 0))
    console.log(JSON.stringify({ status: 'ok', mode: 'orphans', count: out.length, nodes: out, ...nodeDiag() }))
  } else {
    const ranked = [...degree.entries()].filter(([id, d]) => d > 0 && reportable(byId.get(id)))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top)
      .map(([id, d]) => ({ ...nodeOut(id, 0), degree: d }))
    console.log(JSON.stringify({ status: 'ok', mode: 'hubs', count: ranked.length, nodes: ranked }))
  }
  process.exit(0)
}

// --from traversal
if (!byId.has(from)) {
  if (ruleById.has(from) || rfcById.has(from)) {
    // A projected rule/rfc node is a legitimate traversal root. Phase 2 gives it no
    // edges, so the result is the node itself at depth 0. Once Phase 3 lands, these
    // ids gain adjacency entries and fall through to the normal BFS below.
    console.log(JSON.stringify({
      status: 'ok',
      root: from,
      depth,
      edge_types: edgeTypes,
      count: 1,
      nodes: [nodeOut(from, 0)],
      edges: [],
      ...nodeDiag(),
    }))
    process.exit(0)
  }
  console.log(JSON.stringify({ status: 'error', message: `Episode "${from}" not found in the selected scope.` }))
  process.exit(1)
}

const visited = new Map([[from, 0]])
const queue = [from]
let truncated = false

while (queue.length > 0) {
  const current = queue.shift()
  const dist = visited.get(current)
  if (dist >= depth) continue
  for (const edge of adjacency.get(current) || []) {
    const next = edge.from === current ? edge.to : edge.from
    if (!visited.has(next)) {
      if (visited.size >= limit) { truncated = true; continue }
      visited.set(next, dist + 1)
      queue.push(next)
    }
  }
}

// Edge emission is a POST-BFS sweep: report every edge whose endpoints BOTH
// landed in the visited set. The previous mid-loop emission missed edges
// between two nodes sitting at distance == depth — boundary nodes never scan
// their own adjacency (dist >= depth short-circuits), so boundary-to-boundary
// edges were silently dropped even though both endpoints appeared in nodes[].
const outEdges = []
const emittedEdges = new Set()
for (const id of visited.keys()) {
  for (const edge of adjacency.get(id) || []) {
    if (!visited.has(edge.from) || !visited.has(edge.to)) continue
    const ek = edgeKey(edge.from, edge.to, edge.type)
    if (emittedEdges.has(ek)) continue
    emittedEdges.add(ek)
    outEdges.push(edge)
  }
}

const nodes = [...visited.entries()]
  .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  .map(([id, dist]) => nodeOut(id, dist))

console.log(JSON.stringify({
  status: 'ok',
  root: from,
  depth,
  edge_types: edgeTypes,
  count: nodes.length,
  nodes,
  edges: outEdges,
  ...(truncated ? { truncated: true } : {}),
  ...nodeDiag(),
}))
