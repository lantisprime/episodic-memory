#!/usr/bin/env node
/**
 * em-sync-install.mjs — Refresh ONE consuming project's installed
 * episodic-memory artifacts from the global dist cache
 * (~/.episodic-memory/dist/<version>/), checksum-guarded exactly like
 * `install.mjs --update-consumers`:
 *
 *   - only artifacts listed in the project's .episodic-memory-install.json
 *     manifest are candidates (manifest membership == consent; never adds files)
 *   - only files whose on-disk sha256 still matches the manifest checksum
 *     (unmodified) are overwritten; user-modified files are left alone and
 *     reported
 *   - enforcement-class artifacts are skipped unless the consumer registry
 *     says enforcement_installed:true for this project
 *   - only projects present in ~/.episodic-memory/installs.json are touched
 *
 * This is the apply-side of the opt-in SessionStart auto-update
 * ("auto_update": true in <project>/.episodic-memory/enforce-config.json):
 * the hook calls this script on version drift and lifts the single-line
 * `notice` field into session output. Every missing precondition degrades to
 * a status token with exit 0 — never blocks a session.
 *
 * Usage:
 *   node em-sync-install.mjs [--project <dir>] [--dry-run]
 *
 * Output (single JSON object on stdout):
 *   { status: "refreshed"|"current"|"no-manifest"|"no-cache"|
 *             "no-global-manifest"|"unregistered",
 *     project, from_version?, to_version?, refreshed?: [paths],
 *     skipped_modified?: [paths], notice?: "episodic-memory: ..." }
 */

import path from 'path'
import os from 'os'
import { syncProjectFromDist } from './lib/install-version.mjs'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({
    status: 'help',
    script: 'em-sync-install.mjs',
    usage: 'node em-sync-install.mjs [--project <dir>] [--dry-run] — checksum-guarded refresh of one project\'s installed artifacts from the global dist cache (~/.episodic-memory/dist/<version>/). Unmodified files are updated; locally modified files are left untouched and reported. Degrades (never errors) when the manifest, cache, or registry entry is absent.',
  }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const projectDir = path.resolve(flag('--project') || process.cwd())
const dryRun = argv.includes('--dry-run')
const globalDir = path.join(os.homedir(), '.episodic-memory')

let out
try {
  out = syncProjectFromDist({ globalDir, projectDir, dryRun })
} catch (e) {
  // Degrade, never block: the SessionStart hook must always be able to fall
  // back to the plain drift notice.
  out = { status: 'error', project: projectDir, message: String(e && e.message || e) }
}
console.log(JSON.stringify(out))
process.exit(0)
