#!/usr/bin/env node
/**
 * em-embed.mjs — build or update the embeddings sidecar (embeddings.jsonl).
 *
 * Usage:
 *   node em-embed.mjs [--scope local|global|all] [--provider hash|cmd]
 *                     [--cmd "<command>"] [--model <name>] [--rebuild]
 *
 * Incremental by default: an episode is (re-)embedded only when it has no
 * sidecar row, the row's content hash differs, or the row's model differs
 * from the active provider's. --rebuild re-embeds everything.
 *
 * Providers (see lib/embeddings.mjs):
 *   hash (default) — built-in deterministic IDF-weighted feature hashing;
 *                    offline, zero-dep, no setup.
 *   cmd            — pipes {id,text} JSONL to your command (--cmd or
 *                    $EM_EMBED_CMD), reads {id,vector} JSONL back. Use it to
 *                    wire real embedding models (ollama, API endpoints).
 *
 * Superseded episodes are skipped (semantic recall only serves active ones);
 * stale sidecar rows for episodes no longer in the index are dropped.
 *
 * Outputs JSON: { status, scopes: [{scope, embedded, reused, dropped, total, model}] }
 */

import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadIndex, loadTokensIndex } from './lib/relevance.mjs'
import {
  HASH_DIM, HASH_MODEL, hashEmbed, buildIdf, cmdEmbed,
  loadEmbeddings, writeEmbeddings, episodeEmbedText, contentHash
} from './lib/embeddings.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-embed.mjs', usage: 'node em-embed.mjs [--scope local|global|all] [--provider hash|cmd] [--cmd "<command>"] [--model <name>] [--rebuild] — build/update the embeddings sidecar for em-semantic' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'all'
const provider = flag('--provider') || (flag('--cmd') || process.env.EM_EMBED_CMD ? 'cmd' : 'hash')
const cmd = flag('--cmd') || process.env.EM_EMBED_CMD
const rebuild = argv.includes('--rebuild')

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}
if (provider !== 'hash' && provider !== 'cmd') {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --provider "${provider}". Must be hash or cmd.` }))
  process.exit(1)
}
if (provider === 'cmd' && !cmd) {
  console.log(JSON.stringify({ status: 'error', message: 'Provider "cmd" requires --cmd "<command>" or $EM_EMBED_CMD.' }))
  process.exit(1)
}

const model = flag('--model') || (provider === 'hash' ? HASH_MODEL : `cmd:${contentHash(cmd)}`)

function embedDir(dataDir, label) {
  const rows = loadIndex(dataDir, label).filter(r => r.status !== 'superseded' && typeof r.id === 'string')
  const existing = (!rebuild && loadEmbeddings(dataDir)) || { rows: new Map() }
  const activeIds = new Set(rows.map(r => r.id))
  const dropped = [...existing.rows.keys()].filter(id => !activeIds.has(id)).length

  const keep = new Map()
  const todo = []
  for (const row of rows) {
    const text = episodeEmbedText(row, dataDir)
    const h = contentHash(text)
    const prior = existing.rows.get(row.id)
    if (prior && prior.h === h && prior.model === model) {
      keep.set(row.id, prior)
    } else {
      todo.push({ id: row.id, text, h })
    }
  }

  if (todo.length > 0) {
    if (provider === 'hash') {
      const idf = buildIdf([loadTokensIndex(dataDir)])
      for (const item of todo) {
        keep.set(item.id, { id: item.id, h: item.h, model, dim: HASH_DIM, v: hashEmbed(item.text, idf) })
      }
    } else {
      const vectors = cmdEmbed(cmd, todo)
      for (const item of todo) {
        const v = vectors.get(item.id)
        if (!v) throw new Error(`embed command returned no vector for ${item.id}`)
        keep.set(item.id, { id: item.id, h: item.h, model, dim: v.length, v })
      }
    }
  }

  if (todo.length > 0 || dropped > 0 || rebuild) writeEmbeddings(dataDir, keep)

  return { scope: label, embedded: todo.length, reused: keep.size - todo.length, dropped, total: keep.size, model }
}

const scopes = []
try {
  if (scope === 'local' || scope === 'all') scopes.push(embedDir(LOCAL_DIR, 'local'))
  if (scope === 'global' || scope === 'all') scopes.push(embedDir(GLOBAL_DIR, 'global'))
} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: e.message }))
  process.exit(1)
}

console.log(JSON.stringify({ status: 'ok', scopes }))
