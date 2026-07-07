#!/usr/bin/env node
/**
 * em-pin.mjs — pin/unpin an episode.
 *
 * Usage:
 *   node em-pin.mjs --id <episode-id> [--unpin]
 *
 * A pinned episode:
 *   - never decays below a 0.6 time factor in search/recall scoring
 *     (unpinned floor is 0.1), so foundational decisions stay competitive
 *     with fresh episodes indefinitely;
 *   - is never archived by em-prune (protection reason "pinned").
 *
 * Pinning is metadata, not content: the episode body and id are untouched.
 * The flag is written to BOTH the frontmatter (so rebuilds preserve it) and
 * the index row (so readers see it without a file read). Revisions inherit
 * it (em-revise carries pinned forward; use --unpin here to release a chain).
 *
 * Outputs JSON: { status, id, pinned, scope }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-pin.mjs', usage: 'node em-pin.mjs --id <episode-id> [--unpin] — pinned episodes never decay below 0.6 in scoring and are never pruned' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const id = flag('--id')
const unpin = argv.includes('--unpin')

if (!id) {
  console.log(JSON.stringify({ status: 'error', message: 'Missing required --id <episode-id>. Usage: node em-pin.mjs --id <episode-id> [--unpin]' }))
  process.exit(1)
}

// Locate the episode: local store first (mirrors em-revise's findEpisode).
let dataDir = null
let filePath = null
for (const dir of [LOCAL_DIR, GLOBAL_DIR]) {
  const p = path.join(dir, 'episodes', `${id}.md`)
  if (fs.existsSync(p)) { dataDir = dir; filePath = p; break }
}
if (!dataDir) {
  console.log(JSON.stringify({ status: 'error', message: `Episode "${id}" not found in local or global stores.` }))
  process.exit(1)
}

// --- frontmatter: insert or remove the `pinned: true` line -----------------
const content = fs.readFileSync(filePath, 'utf8')
const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
if (!fmMatch) {
  console.log(JSON.stringify({ status: 'error', message: `Episode "${id}" has no parseable frontmatter.` }))
  process.exit(1)
}
const fmLines = fmMatch[1].split('\n').filter(l => !/^pinned:/.test(l))
if (!unpin) fmLines.push('pinned: true')
const newContent = content.replace(fmMatch[0], `---\n${fmLines.join('\n')}\n---`)
const tmpFile = filePath + '.tmp'
fs.writeFileSync(tmpFile, newContent, 'utf8')
fs.renameSync(tmpFile, filePath)

// --- index row: set/delete pinned (atomic rewrite, mirrors access tracking) -
const indexFile = path.join(dataDir, 'index.jsonl')
try {
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
  const updated = lines.map(line => {
    try {
      const entry = JSON.parse(line)
      if (entry.id === id) {
        if (unpin) delete entry.pinned
        else entry.pinned = true
      }
      return JSON.stringify(entry)
    } catch { return line }
  })
  const idxTmp = indexFile + '.tmp'
  fs.writeFileSync(idxTmp, updated.join('\n') + '\n', 'utf8')
  fs.renameSync(idxTmp, indexFile)
} catch {
  // Index missing/corrupt: frontmatter is the durable source; a rebuild
  // regenerates the row with the new pinned state.
}

console.log(JSON.stringify({
  status: 'ok', id, pinned: !unpin,
  scope: dataDir === GLOBAL_DIR ? 'global' : 'local'
}))
