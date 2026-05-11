/**
 * install-snapshot.mjs — Write + read the second-opinion install snapshot.
 *
 * Snapshot location: ~/.claude/hooks/second-opinion-providers.json (default,
 * overridable via SO_INSTALL_SNAPSHOT_PATH env var for testing).
 *
 * Snapshot shape:
 *   {
 *     schema_version: 1,
 *     source_hash: "<sha256>",                 // canonical hash over source files
 *     source_repo: "<absolute path>",          // where install ran from
 *     install_timestamp: "<ISO 8601>",
 *     providers: [...registry entries...],     // flattened from providers/index.json
 *     fragments: [{id, path, sha256}, ...],    // per-fragment hashes for I-27b
 *     file_hashes: {<rel-path>: sha256, ...},  // every source file's hash
 *   }
 *
 * Install snapshot is the AUTHORITY for runtime checks:
 *   - Hook reads it to know which CLI patterns to gate (Bash + Agent matrix).
 *   - Harness reads source_hash to detect drift (I-27a registry-stale-at-gate).
 *   - Composer reads per-fragment SHAs for in-flight tamper detection (I-27b).
 *
 * Why ~/.claude/hooks/ (not ~/.episodic-memory/): Claude Code's hook reader
 * looks under ~/.claude/. Both `homedir` resolutions must agree (PR #214/#217
 * worktree footgun anchor). install.mjs uses os.homedir() — consistent.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { validateProviderRegistry } from './registry-validator.mjs'

export const DEFAULT_SNAPSHOT_PATH = path.join(
  os.homedir(),
  '.claude',
  'hooks',
  'second-opinion-providers.json'
)

export function snapshotPath() {
  return process.env.SO_INSTALL_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH
}

/**
 * Write the install snapshot atomically (tmp + rename).
 */
export function writeSnapshot(snapshot, customPath) {
  const targetPath = customPath || snapshotPath()
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const tmp = targetPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, targetPath)
  return targetPath
}

/**
 * Read the install snapshot. Returns parsed JSON or throws with code:
 *   - 'snapshot-not-installed' if file missing
 *   - 'snapshot-parse-failed' if JSON malformed
 *   - 'snapshot-missing-source-hash' if source_hash field absent
 *   - 'snapshot-invalid-providers' if providers[] entries violate the
 *     shared validator contract (I-NEW-B: hook depends on cli_match /
 *     binary / agent_block_patterns / agent_allow_patterns shape; we
 *     reject malformed entries here so the hook fail-closes on read
 *     rather than silently skipping providers with bad regex).
 */
export function readSnapshot(customPath) {
  const targetPath = customPath || snapshotPath()
  if (!fs.existsSync(targetPath)) {
    const err = new Error(
      `Second-opinion install snapshot not found at ${targetPath}. ` +
      `Run: node install.mjs --install-second-opinion`
    )
    err.code = 'snapshot-not-installed'
    err.snapshotPath = targetPath
    throw err
  }
  let parsed
  try {
    const raw = fs.readFileSync(targetPath, 'utf8')
    parsed = JSON.parse(raw)
  } catch (e) {
    const err = new Error(`Snapshot parse failed at ${targetPath}: ${e.message}`)
    err.code = 'snapshot-parse-failed'
    err.snapshotPath = targetPath
    throw err
  }
  if (!parsed.source_hash) {
    const err = new Error(`Snapshot at ${targetPath} missing source_hash field`)
    err.code = 'snapshot-missing-source-hash'
    err.snapshotPath = targetPath
    throw err
  }
  // I-NEW-B: validate providers[] against the shared shape contract.
  try {
    validateProviderRegistry({ schema_version: 1, providers: parsed.providers })
  } catch (e) {
    const err = new Error(
      `Snapshot at ${targetPath} has invalid providers[]: ${e.message}`
    )
    err.code = 'snapshot-invalid-providers'
    err.snapshotPath = targetPath
    err.field = e.field
    err.provider = e.provider
    err.observed = e.observed
    if (e.regexError) err.regexError = e.regexError
    if (e.index !== undefined) err.index = e.index
    if (e.duplicate) err.duplicate = e.duplicate
    throw err
  }
  return parsed
}
