#!/usr/bin/env node
/**
 * em-feedback.mjs — record whether a recalled episode was actually useful.
 *
 * Usage:
 *   node em-feedback.mjs --id <episode-id> (--useful | --noise)
 *
 * Closes the retrieval feedback loop: access_count says an episode was SEEN;
 * this counter says it HELPED (+1) or was noise (-1). The scorer folds it in
 * as a ±5%-per-point boost, clamped to [-30%, +50%] (lib/relevance.mjs
 * computeScore), so consistently useful episodes rise and consistently
 * irrelevant ones sink — without any single vote dominating.
 *
 * Call it when a recalled/searched episode genuinely shaped a decision
 * (--useful) or kept surfacing without being relevant (--noise). The counter
 * is index-only metadata (like access_count): it survives rebuilds via
 * carry-forward and is clamped to [-10, 10].
 *
 * Outputs JSON: { status, id, feedback, scope }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-feedback.mjs', usage: 'node em-feedback.mjs --id <episode-id> (--useful | --noise) — usefulness signal that boosts (+) or damps (-) the episode in future recall ranking' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const id = flag('--id')
const useful = argv.includes('--useful')
const noise = argv.includes('--noise')

if (!id || useful === noise) {
  console.log(JSON.stringify({ status: 'error', message: 'Usage: node em-feedback.mjs --id <episode-id> (--useful | --noise) — exactly one of --useful/--noise required.' }))
  process.exit(1)
}

const delta = useful ? 1 : -1

// Find the index row across stores (local priority, matching read dedupe).
let updatedRow = null
let scopeName = null
for (const dir of [LOCAL_DIR, GLOBAL_DIR]) {
  const indexFile = path.join(dir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) continue
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
  let found = false
  const updated = lines.map(line => {
    try {
      const entry = JSON.parse(line)
      if (entry.id === id) {
        found = true
        const current = typeof entry.feedback === 'number' ? entry.feedback : 0
        entry.feedback = Math.max(-10, Math.min(10, current + delta))
        updatedRow = entry
      }
      return JSON.stringify(entry)
    } catch { return line }
  })
  if (found) {
    const tmpFile = indexFile + '.tmp'
    fs.writeFileSync(tmpFile, updated.join('\n') + '\n', 'utf8')
    fs.renameSync(tmpFile, indexFile)
    scopeName = dir === GLOBAL_DIR ? 'global' : 'local'
    break
  }
}

if (!updatedRow) {
  console.log(JSON.stringify({ status: 'error', message: `Episode "${id}" not found in local or global index.` }))
  process.exit(1)
}

console.log(JSON.stringify({ status: 'ok', id, feedback: updatedRow.feedback, scope: scopeName }))
