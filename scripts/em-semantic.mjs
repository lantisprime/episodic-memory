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
import { HASH_MODEL, hashEmbed, buildIdf, cmdEmbed, cosine, loadEmbeddings, contentHash } from './lib/embeddings.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-semantic.mjs', usage: 'node em-semantic.mjs --query <text> [--scope local|global|all] [--limit <n>] [--min-sim <0..1>] [--project <name>] [--provider hash|cmd] [--cmd "<command>"] [--full] [--no-track] — similarity search over the em-embed sidecar' }))
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
const provider = flag('--provider') || (flag('--cmd') || process.env.EM_EMBED_CMD ? 'cmd' : 'hash')
const cmd = flag('--cmd') || process.env.EM_EMBED_CMD
const full = argv.includes('--full')
const noTrack = argv.includes('--no-track')

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
const queryModel = flag('--model') || (provider === 'hash' ? HASH_MODEL : `cmd:${contentHash(cmd || '')}`)
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

console.log(JSON.stringify({ status: 'ok', count: episodes.length, model: queryModel, episodes }))
