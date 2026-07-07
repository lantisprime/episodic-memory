// embeddings.mjs — embeddings sidecar for the semantic recall capability.
//
// CAPABILITIES.md charters recall-strategy plugins; this is the substrate
// half: a per-store sidecar (embeddings.jsonl) mapping episode id → vector,
// plus the two providers that produce vectors:
//
//   hash  (built-in, default) — signed feature hashing of the episode's
//         tokens into DIM dims, IDF-weighted from tokens.json when present,
//         L2-normalized. Deterministic, offline, zero-dep. Cosine similarity
//         over these vectors is weighted-lexical similarity — it captures
//         vocabulary overlap with rare-term emphasis, not deep semantics,
//         and it degrades to nothing worse than the lexical search.
//
//   cmd   (opt-in) — spawns a user-configured command (--cmd / $EM_EMBED_CMD)
//         speaking JSONL: {id, text} per line on stdin → {id, vector} per
//         line on stdout. Wire it to ollama, an OpenAI/Anthropic endpoint, a
//         local model — anything. The substrate stays zero-dependency; the
//         model dependency lives entirely in the user's command.
//
// Sidecar row: { id, h, model, dim, v } — h is a content hash so re-embeds
// are incremental; v is rounded to 4 decimals to keep the file small.
//
// Zero external dependencies — Node.js stdlib only.

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { tokenizeQuery } from './relevance.mjs'

export const HASH_DIM = 256
export const HASH_MODEL = `hash-v1-${HASH_DIM}`

// ---------------------------------------------------------------------------
// Persistent provider configuration: ~/.episodic-memory/embed-config.json
//   { "provider": "hash"|"cmd", "cmd": "<command>", "model": "<name>" }
// Written by the installer wizard's semantic-search step (or by hand); read
// by em-embed AND em-semantic through resolveEmbedSettings so both resolve
// the same provider — otherwise a configured setup would trip em-semantic's
// model-mismatch refusal on every query.
//
// Precedence (resolveEmbedSettings): explicit --provider/--cmd flags >
// $EM_EMBED_CMD > embed-config.json > built-in hash.
// ---------------------------------------------------------------------------
export const EMBED_CONFIG_PATH = path.join(os.homedir(), '.episodic-memory', 'embed-config.json')

export function loadEmbedConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(EMBED_CONFIG_PATH, 'utf8'))
    return typeof cfg === 'object' && cfg !== null ? cfg : {}
  } catch {
    return {}
  }
}

export function resolveEmbedSettings({ providerFlag, cmdFlag, config = {} }) {
  const envCmd = process.env.EM_EMBED_CMD
  const cmd = cmdFlag || envCmd || (typeof config.cmd === 'string' ? config.cmd : undefined)
  let provider = providerFlag
  if (!provider) {
    if (cmdFlag || envCmd) provider = 'cmd'
    else if (config.provider === 'cmd' || (config.cmd && config.provider === undefined)) provider = 'cmd'
    else provider = 'hash'
  }
  return { provider, cmd }
}

export function contentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// hash provider — signed feature hashing with optional IDF weights.
//   idf: Map<token, weight> (from buildIdf) or null → weight 1 per token.
// ---------------------------------------------------------------------------
export function hashEmbed(text, idf) {
  const v = new Array(HASH_DIM).fill(0)
  for (const tok of tokenizeQuery(text)) {
    const digest = crypto.createHash('sha256').update(tok, 'utf8').digest()
    const idx = digest.readUInt32BE(0) % HASH_DIM
    const sign = (digest[4] & 1) === 1 ? 1 : -1
    const w = idf && idf.has(tok) ? idf.get(tok) : 1
    v[idx] += sign * w
  }
  return l2normalize(v)
}

// IDF weights from a store's tokens.json vocabulary: rare tokens count more.
// totalDocs = distinct ids across the index. Returns null when unavailable.
export function buildIdf(tokensIndexes) {
  const present = tokensIndexes.filter(Boolean)
  if (present.length === 0) return null
  const df = new Map()
  const allIds = new Set()
  for (const idx of present) {
    for (const [tok, ids] of Object.entries(idx)) {
      if (!Array.isArray(ids)) continue
      df.set(tok, (df.get(tok) || 0) + ids.length)
      for (const id of ids) allIds.add(id)
    }
  }
  const total = Math.max(1, allIds.size)
  const idf = new Map()
  for (const [tok, count] of df) idf.set(tok, 1 + Math.log(total / Math.min(count, total)))
  return idf
}

export function l2normalize(v) {
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  if (norm === 0) return v
  return v.map(x => Math.round((x / norm) * 10000) / 10000)
}

export function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ---------------------------------------------------------------------------
// cmd provider — batch texts through the user's embedding command.
// Returns Map<id, vector>. Throws with the command's stderr on failure.
// ---------------------------------------------------------------------------
export function cmdEmbed(cmd, items) {
  const input = items.map(it => JSON.stringify({ id: it.id, text: it.text })).join('\n') + '\n'
  const r = spawnSync('/bin/sh', ['-c', cmd], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) {
    throw new Error(`embed command failed (exit ${r.status}): ${(r.stderr || '').slice(0, 500)}`)
  }
  const out = new Map()
  for (const line of (r.stdout || '').trim().split('\n').filter(Boolean)) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (typeof row.id === 'string' && Array.isArray(row.vector)) out.set(row.id, l2normalize(row.vector))
  }
  return out
}

// ---------------------------------------------------------------------------
// Sidecar IO
// ---------------------------------------------------------------------------
export function loadEmbeddings(dataDir) {
  const p = path.join(dataDir, 'embeddings.jsonl')
  if (!fs.existsSync(p)) return null
  const rows = new Map()
  let model = null
  for (const line of fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line)
      if (typeof row.id === 'string' && Array.isArray(row.v)) {
        rows.set(row.id, row)
        if (!model) model = row.model || null
      }
    } catch {}
  }
  return { rows, model }
}

export function writeEmbeddings(dataDir, rows) {
  const p = path.join(dataDir, 'embeddings.jsonl')
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, [...rows.values()].map(r => JSON.stringify(r)).join('\n') + (rows.size ? '\n' : ''), 'utf8')
  fs.renameSync(tmp, p)
}

// Text an episode is embedded from: summary + tags + body (file content
// after frontmatter; falls back to full content when unparseable).
export function episodeEmbedText(row, dataDir) {
  let body = ''
  try {
    const content = fs.readFileSync(path.join(dataDir, 'episodes', `${row.id}.md`), 'utf8')
    const parts = content.split('---')
    body = parts.length >= 3 ? parts.slice(2).join('---') : content
  } catch {}
  const tags = Array.isArray(row.tags) ? row.tags.join(' ') : ''
  return `${row.summary || ''}\n${tags}\n${body}`.trim()
}
