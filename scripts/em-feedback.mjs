#!/usr/bin/env node
/**
 * em-feedback.mjs — record whether a recalled episode was actually useful.
 *
 * Usage:
 *   node em-feedback.mjs --id <episode-id> (--useful | --noise)
 *   node em-feedback.mjs --scan-text <file> [--scope local|global|all] [--dry-run]
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
 * Batch inference (--scan-text): an episode id cited in a session handoff,
 * PR body, or lessons write-up demonstrably shaped that artifact — that is
 * exactly the "genuinely helped" signal above, inferred instead of typed.
 * Extracts episode-id patterns from the file, dedupes, skips ids that do not
 * resolve in the selected scope(s), and records ONE +1 (useful) event per
 * resolved id. --dry-run reports without writing.
 *
 * Outputs JSON: { status, id, feedback, scope } (single-id mode) or
 * { status, scanned, matched, resolved, recorded, skipped_unresolved, ... }
 * (scan mode).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-feedback.mjs', usage: 'node em-feedback.mjs --id <episode-id> (--useful | --noise) | --scan-text <file> [--scope local|global|all] [--dry-run] — usefulness signal that boosts (+) or damps (-) the episode in future recall ranking; --scan-text records one +1 per episode id cited in the file' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

// ---------------------------------------------------------------------------
// Batch inference: --scan-text <file>
// ---------------------------------------------------------------------------
// Episode-id shape, derived from em-store.mjs id generation (not guessed):
//   ts     = now.toISOString().slice(0,19).replace(...)      -> \d{8}-\d{6}
//   slug   = summary.toLowerCase().replace(/[^a-z0-9]+/g,'-')
//              .replace(/^-|-$/g,'').slice(0,40)             -> [a-z0-9-]{0,40}
//            (may be EMPTY — a symbols-only summary yields "ts--hex" — and
//            slice(0,40) can leave a trailing dash)
//   suffix = crypto.randomBytes(2).toString('hex')           -> [0-9a-f]{4}
//   id     = `${ts}-${slug}-${suffix}`
// Lookarounds keep the match from starting or ending inside a longer
// alphanumeric-dash run (so an ellipsized id like "20260708-…-8ff2" or a
// concatenated blob does not half-match).
const EPISODE_ID_RE = /(?<![0-9A-Za-z-])\d{8}-\d{6}-(?:[a-z0-9-]{0,40}-)?[0-9a-f]{4}(?![0-9A-Za-z-])/g

const scanTextFile = flag('--scan-text')
if (scanTextFile !== undefined) {
  const scanScope = flag('--scope') || 'all'
  const VALID_SCOPES = ['local', 'global', 'all']
  if (!VALID_SCOPES.includes(scanScope)) {
    console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scanScope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
    process.exit(1)
  }
  const dryRun = argv.includes('--dry-run')

  let text
  try {
    text = fs.readFileSync(scanTextFile, 'utf8')
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: `Cannot read --scan-text file "${scanTextFile}": ${e.message}` }))
    process.exit(1)
  }

  // Extract + dedupe (first-seen order).
  const unique = [...new Set(text.match(EPISODE_ID_RE) || [])]

  // Resolve against the selected scope(s); local wins when an id is in both,
  // matching the single-id mode's dir order and the readers' dedupe rule.
  const dirs = []
  if (scanScope === 'local' || scanScope === 'all') dirs.push(['local', LOCAL_DIR])
  if (scanScope === 'global' || scanScope === 'all') dirs.push(['global', GLOBAL_DIR])
  const idsByDir = new Map(dirs.map(([name]) => [name, new Set()]))
  const dirIndexIds = dirs.map(([name, dir]) => {
    const ids = new Set()
    try {
      for (const line of fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (typeof e.id === 'string') ids.add(e.id)
        } catch {}
      }
    } catch {}
    return [name, ids]
  })
  const resolved = []
  const skipped = []
  for (const cid of unique) {
    const hit = dirIndexIds.find(([, ids]) => ids.has(cid))
    if (hit) {
      resolved.push(cid)
      idsByDir.get(hit[0]).add(cid)
    } else {
      skipped.push(cid)
    }
  }

  // Record: one +1 per resolved id, one atomic index rewrite per store.
  // Writer surface — fail CLOSED on any write error.
  let recorded = 0
  if (!dryRun) {
    try {
      for (const [name, dir] of dirs) {
        const targetIds = idsByDir.get(name)
        if (targetIds.size === 0) continue
        const indexFile = path.join(dir, 'index.jsonl')
        const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
        const updated = lines.map(line => {
          try {
            const entry = JSON.parse(line)
            if (targetIds.has(entry.id)) {
              const current = typeof entry.feedback === 'number' ? entry.feedback : 0
              entry.feedback = Math.max(-10, Math.min(10, current + 1))
              recorded++
            }
            return JSON.stringify(entry)
          } catch { return line }
        })
        const tmpFile = indexFile + '.tmp'
        fs.writeFileSync(tmpFile, updated.join('\n') + '\n', 'utf8')
        fs.renameSync(tmpFile, indexFile)
      }
    } catch (e) {
      console.log(JSON.stringify({ status: 'error', message: `Feedback write failed: ${e.message}`, recorded_before_failure: recorded }))
      process.exit(1)
    }
  }

  console.log(JSON.stringify({
    status: 'ok',
    mode: 'scan-text',
    ...(dryRun ? { dry_run: true } : {}),
    scope: scanScope,
    scanned: 1,
    matched: unique.length,
    resolved: resolved.length,
    recorded,
    skipped_unresolved: skipped.length,
    resolved_ids: resolved,
    skipped_ids: skipped,
  }))
  process.exit(0)
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
