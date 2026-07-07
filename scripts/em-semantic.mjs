#!/usr/bin/env node
/**
 * em-semantic.mjs — similarity search over the embeddings sidecar.
 *
 * Usage:
 *   node em-semantic.mjs --query <text> [--scope local|global|all]
 *                        [--limit <n>] [--min-sim <0..1>] [--project <name>]
 *                        [--provider hash|cmd] [--cmd "<command>"] [--full]
 *                        [--no-track]
 *
 * Complements em-search: lexical search needs the words to overlap; semantic
 * search ranks by vector similarity, so "auth token expiry" can surface
 * "session cookie lifetime" when a real embedding model is wired in. With
 * the built-in hash provider, similarity is IDF-weighted vocabulary overlap
 * — strictly better recall than nothing, honestly less than a real model.
 *
 * The query MUST be embedded by the same provider/model as the sidecar —
 * mismatched models are refused (cosine across spaces is meaningless).
 * Missing sidecar → error with the em-embed hint.
 *
 * Ranking: final score = computeScore(entry, similarity) — the same decay/
 * usage/pinning/feedback model as em-search, with cosine similarity as the
 * text-match signal. Superseded episodes are excluded.
 *
 * Outputs JSON: { status, count, model, episodes: [{..., similarity, score}] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadIndex, loadTokensIndex, computeScore, writeBackAccessTracking } from './lib/relevance.mjs'
import {
  HASH_MODEL, hashEmbed, buildIdf, cmdEmbed, cosine, loadEmbeddings, contentHash,
  loadEmbedConfig, resolveEmbedSettings
} from './lib/embeddings.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-semantic.mjs', usage: 'node em-semantic.mjs --query <text> [--scope local|global|all] [--limit <n>] [--min-sim <0..1>] [--project <name>] [--provider hash|cmd] [--cmd "<command>"] [--rerank-cmd "<command>" | --no-rerank] [--full] [--no-track] — similarity search over the em-embed sidecar, optional LLM re-ranking' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const query = flag('--query')
const scope = flag('--scope') || 'all'
const limit = parseInt(flag('--limit') || '10', 10)
const minSim = parseFloat(flag('--min-sim') || '0.25')
const project = flag('--project')
// Same precedence as em-embed (flags > env > embed-config.json > hash), from
// the shared resolver — the two scripts must agree or every configured setup
// would trip the model-mismatch refusal.
const embedConfig = loadEmbedConfig()
const { provider, cmd } = resolveEmbedSettings({
  providerFlag: flag('--provider'),
  cmdFlag: flag('--cmd'),
  config: embedConfig,
})
const full = argv.includes('--full')
const noTrack = argv.includes('--no-track')
// LLM re-ranking (optional): vectors retrieve candidates cheaply, then a
// reranker command re-orders the top candidates by true semantic relevance.
// Protocol: stdin JSON {query, candidates:[{id,summary,similarity}]} →
// stdout JSON {"order":[ids...]}. The shipped adapter
// examples/rerankers/claude-rerank.sh drives `claude -p` (the user's
// existing Claude Code OAuth login — no separate API key). Failures fall
// back to vector order with a warning; --no-rerank disables a configured
// reranker for one call.
const rerankCmd = argv.includes('--no-rerank')
  ? undefined
  : (flag('--rerank-cmd') || process.env.EM_RERANK_CMD || (typeof embedConfig.rerank_cmd === 'string' ? embedConfig.rerank_cmd : undefined))

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}
if (!query) {
  console.log(JSON.stringify({ status: 'error', message: 'Missing required --query <text>.' }))
  process.exit(1)
}

const dirs = []
if (scope === 'local' || scope === 'all') dirs.push([LOCAL_DIR, 'local'])
if (scope === 'global' || scope === 'all') dirs.push([GLOBAL_DIR, 'global'])

// ---------------------------------------------------------------------------
// Load sidecars; refuse model mismatches instead of comparing across spaces.
// ---------------------------------------------------------------------------
const queryModel = flag('--model') || embedConfig.model || (provider === 'hash' ? HASH_MODEL : `cmd:${contentHash(cmd || '')}`)
const vectorsById = new Map()
let sidecarsSeen = 0
for (const [dir] of dirs) {
  const side = loadEmbeddings(dir)
  if (!side || side.rows.size === 0) continue
  sidecarsSeen++
  if (side.model && side.model !== queryModel) {
    console.log(JSON.stringify({ status: 'error', message: `Sidecar in ${dir} was embedded with model "${side.model}" but the query would use "${queryModel}". Re-run em-embed with the matching provider/--model, or pass the same flags here.` }))
    process.exit(1)
  }
  for (const [id, row] of side.rows) if (!vectorsById.has(id)) vectorsById.set(id, row.v)
}
if (sidecarsSeen === 0) {
  console.log(JSON.stringify({ status: 'error', message: 'No embeddings sidecar found. Build one first: node em-embed.mjs --scope all' }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Embed the query with the same provider.
// ---------------------------------------------------------------------------
let queryVec
if (provider === 'hash') {
  queryVec = hashEmbed(query, buildIdf(dirs.map(([d]) => loadTokensIndex(d))))
} else {
  if (!cmd) {
    console.log(JSON.stringify({ status: 'error', message: 'Provider "cmd" requires --cmd "<command>" or $EM_EMBED_CMD.' }))
    process.exit(1)
  }
  try {
    const got = cmdEmbed(cmd, [{ id: 'query', text: query }])
    queryVec = got.get('query')
    if (!queryVec) throw new Error('embed command returned no vector for the query')
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Rank
// ---------------------------------------------------------------------------
let entries = []
for (const [dir, label] of dirs) entries.push(...loadIndex(dir, label))
const seen = new Set()
entries = entries.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
}).filter(e => e.status !== 'superseded')
if (project) entries = entries.filter(e => e.project === project)

const scored = []
for (const e of entries) {
  const v = vectorsById.get(e.id)
  if (!v) continue
  const sim = Math.max(0, cosine(queryVec, v))
  if (sim < minSim) continue
  scored.push({ entry: e, similarity: sim, score: computeScore(e, sim) })
}
scored.sort((a, b) => b.score - a.score)

// Re-rank: hand the top candidate window (3× limit, capped at 30 — enough
// context without flooding the LLM) to the reranker; unknown/missing ids are
// tolerated (reranked subset first, remainder keeps vector order).
let rerankWarning = null
let reranked = false
if (rerankCmd && scored.length > 1) {
  const windowSize = Math.min(Math.max(limit * 3, 10), 30)
  const window = scored.slice(0, windowSize)
  try {
    const { spawnSync } = await import('child_process')
    const input = JSON.stringify({
      query,
      candidates: window.map(c => ({ id: c.entry.id, summary: c.entry.summary, similarity: Math.round(c.similarity * 1000) / 1000 })),
    })
    const r = spawnSync('/bin/sh', ['-c', rerankCmd], { input, encoding: 'utf8', timeout: 120000 })
    if (r.status !== 0) throw new Error(`reranker exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`)
    const out = JSON.parse((r.stdout || '').trim())
    if (!Array.isArray(out.order)) throw new Error('reranker output missing "order" array')
    const byId = new Map(window.map(c => [c.entry.id, c]))
    const rerankedList = []
    for (const id of out.order) {
      const c = byId.get(id)
      if (c) { rerankedList.push(c); byId.delete(c.entry.id) }
    }
    for (const c of window) if (byId.has(c.entry.id)) rerankedList.push(c)
    scored.splice(0, window.length, ...rerankedList)
    reranked = true
  } catch (e) {
    rerankWarning = `rerank skipped (vector order kept): ${e.message}`
  }
}

const results = scored.slice(0, limit)

if (!noTrack && results.length > 0) {
  writeBackAccessTracking(results.map(r => r.entry))
}

const episodes = results.map(({ entry, similarity, score }) => {
  const { _dataDir, _source, ...rest } = entry
  const out = {
    ...rest,
    source: _source,
    similarity: Math.round(similarity * 1000) / 1000,
    score: Math.round(score * 1000) / 1000,
  }
  if (full) {
    try {
      const content = fs.readFileSync(path.join(_dataDir, 'episodes', `${entry.id}.md`), 'utf8')
      const parts = content.split('---')
      out.body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
    } catch {}
  }
  return out
})

console.log(JSON.stringify({
  status: 'ok',
  count: episodes.length,
  model: queryModel,
  ...(reranked ? { reranked: true } : {}),
  ...(rerankWarning ? { warning: rerankWarning } : {}),
  episodes,
}))
