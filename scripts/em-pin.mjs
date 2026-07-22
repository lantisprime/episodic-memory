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
import { acquireStoreWriteLocksSync, releaseStoreWriteLocks, atomicReplaceFileSync } from './lib/store-write-lock.mjs'

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

// Pinning is one transaction over the episode frontmatter and its index row.
// Locate the immutable path above, then acquire before rereading either
// mutable representation so a concurrent rebuild/pin cannot lose one side.
const lockResult = acquireStoreWriteLocksSync(dataDir)
if (!lockResult.ok) {
  console.log(JSON.stringify({ status: 'error', message: `Pin write failed: ${lockResult.code}` }))
  process.exit(1)
}

let result
let exitCode = 0
try {
  // --- frontmatter: insert or remove the `pinned: true` line -------------
  const content = fs.readFileSync(filePath, 'utf8')
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    result = { status: 'error', message: `Episode "${id}" has no parseable frontmatter.` }
    exitCode = 1
  } else {
    const fmLines = fmMatch[1].split('\n').filter(l => !/^pinned:/.test(l))
    if (!unpin) fmLines.push('pinned: true')
    const newContent = content.replace(fmMatch[0], `---\n${fmLines.join('\n')}\n---`)

    // Read and prepare the index snapshot before the first durable write.
    // Missing/corrupt index behavior remains unchanged: frontmatter is the
    // durable source and a later rebuild can regenerate its row.
    const indexFile = path.join(dataDir, 'index.jsonl')
    let indexReplacement = null
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
      indexReplacement = { indexFile, data: updated.join('\n') + '\n' }
    } catch {
      // Keep the historical best-effort index behavior.
    }

    atomicReplaceFileSync(filePath, newContent)
    if (indexReplacement) atomicReplaceFileSync(indexReplacement.indexFile, indexReplacement.data)
    result = {
      status: 'ok', id, pinned: !unpin,
      scope: dataDir === GLOBAL_DIR ? 'global' : 'local'
    }
  }
} catch (e) {
  result = { status: 'error', message: `Pin write failed: ${e.message}` }
  exitCode = 1
} finally {
  releaseStoreWriteLocks(lockResult.handles)
}

console.log(JSON.stringify(result))
if (exitCode) process.exit(exitCode)
