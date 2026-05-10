/**
 * source-hash.mjs — Canonical source-hash computation for the second-opinion harness.
 *
 * Single canonical hash algorithm (per Codex r3 caveat #1 + planner #20 axis 9).
 * Used by:
 *   - install.mjs (writes hash to install snapshot)
 *   - second-opinion.mjs harness gate (recomputes + compares; I-27a registry-stale-at-gate)
 *   - composer.mjs per-fragment SHA (I-27b preamble-tamper-at-composer)
 *
 * Inputs (canonical, sorted by relative path):
 *   <secondOpinionRoot>/preambles/index.json
 *   <secondOpinionRoot>/preambles/composer.mjs
 *   <secondOpinionRoot>/preambles/fragments/*.md       (sorted by basename)
 *   <secondOpinionRoot>/providers/index.json
 *   <secondOpinionRoot>/providers/*.mjs                (sorted by basename)
 *   <secondOpinionRoot>/storage/*.mjs                  (sorted by basename)
 *   <secondOpinionRoot>/lib/registry-validator.mjs
 *
 * Algorithm (deterministic across platforms):
 *   1. Build sorted list of relative paths.
 *   2. For each path: read bytes; compute SHA-256.
 *   3. source_hash = SHA-256("<path1>:<sha1>\n<path2>:<sha2>\n..." utf8)
 *
 * Result: { source_hash, fragments: [{id, path, sha256}], file_hashes: {path: sha256} }
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function sha256OfFile(filePath) {
  const bytes = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Walk second-opinion source tree; return sorted relative paths of files we hash.
 */
function listSourceFiles(secondOpinionRoot) {
  const out = []
  const dirs = [
    { rel: 'preambles', filter: (f) => f === 'index.json' || f === 'composer.mjs' },
    { rel: 'preambles/fragments', filter: (f) => f.endsWith('.md') },
    { rel: 'providers', filter: (f) => f === 'index.json' || f.endsWith('.mjs') },
    { rel: 'storage', filter: (f) => f.endsWith('.mjs') },
    { rel: 'lib', filter: (f) => f.endsWith('.mjs') },
  ]
  for (const { rel, filter } of dirs) {
    const abs = path.join(secondOpinionRoot, rel)
    if (!fs.existsSync(abs)) continue
    const files = fs.readdirSync(abs).filter(filter).sort()
    for (const f of files) {
      out.push(path.join(rel, f))
    }
  }
  return out.sort()
}

/**
 * Compute canonical source hash + per-file hashes + per-fragment hashes.
 *
 * @param {string} secondOpinionRoot — absolute path to scripts/second-opinion/
 * @returns {{source_hash, fragments, file_hashes}}
 */
export function computeSourceHash(secondOpinionRoot) {
  const relPaths = listSourceFiles(secondOpinionRoot)
  const file_hashes = {}
  const lines = []
  for (const rel of relPaths) {
    const abs = path.join(secondOpinionRoot, rel)
    const sha = sha256OfFile(abs)
    file_hashes[rel] = sha
    lines.push(`${rel}:${sha}`)
  }
  const concat = lines.join('\n')
  const source_hash = crypto.createHash('sha256').update(concat, 'utf8').digest('hex')

  // Build per-fragment hash list from preamble registry.
  const fragmentsRegPath = path.join(secondOpinionRoot, 'preambles', 'index.json')
  const fragments = []
  if (fs.existsSync(fragmentsRegPath)) {
    const reg = JSON.parse(fs.readFileSync(fragmentsRegPath, 'utf8'))
    for (const entry of reg.fragments || []) {
      const rel = path.join('preambles', entry.path)
      const sha = file_hashes[rel] || sha256OfFile(path.join(secondOpinionRoot, rel))
      fragments.push({ id: entry.id, path: entry.path, sha256: sha })
    }
  }

  return { source_hash, fragments, file_hashes }
}

/**
 * Compute SHA-256 of a single file. Used for in-flight per-fragment validation.
 */
export function sha256(filePath) {
  return sha256OfFile(filePath)
}
