#!/usr/bin/env node
/**
 * migration-cutover.mjs — verify installed copies are byte-identical to
 * repo sources for every entry in the install manifest.
 *
 * Closes Codex round-1 F1 (runtime install parity): hooks reference scripts
 * at $HOME/.episodic-memory/scripts/, but install.mjs's freshness manifest
 * only covered hooks/*. Without an end-to-end parity check, a stale
 * installed em-recall.mjs would silently disagree with the repo source
 * after a migration commit.
 *
 * Usage:
 *   node tools/migration-cutover.mjs [--repo <dir>] [--home <dir>] [--json]
 *
 * Behavior:
 *   - Builds the install manifest from <repo> via scripts/lib/install-manifest.mjs.
 *   - For each entry, computes the diff state:
 *       OK            installed file exists and is byte-identical to source
 *       MISSING       installed file does not exist
 *       DIFF          installed file exists but content differs
 *       SOURCE_GONE   source file does not exist (manifest says it should)
 *   - Prints a per-file table to stdout (or JSON with --json).
 *   - Exits 0 if all OK, 1 otherwise.
 *
 * Run before pushing the .checkpoints/ migration. Re-run as the burn-in
 * exit gate (plan v3 §D.3).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { buildInstallManifest } from '../scripts/lib/install-manifest.mjs'

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const REPO_DIR = flag('--repo') || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME_DIR = flag('--home') || os.homedir()
const JSON_OUTPUT = argv.includes('--json')

function compareFiles(repoPath, installedPath) {
  if (!fs.existsSync(repoPath)) return 'SOURCE_GONE'
  if (!fs.existsSync(installedPath)) return 'MISSING'
  const a = fs.readFileSync(repoPath)
  const b = fs.readFileSync(installedPath)
  return a.equals(b) ? 'OK' : 'DIFF'
}

const manifest = buildInstallManifest(REPO_DIR, HOME_DIR)
const results = manifest.map(entry => ({
  relativePath: entry.relativePath,
  installedPath: entry.installedPath,
  kind: entry.kind,
  status: compareFiles(entry.repoPath, entry.installedPath)
}))

const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1
  return acc
}, {})

// Codex round-1 F3: an empty manifest (wrong --repo, missing source tree)
// must NOT report allOk. fail-closed when there's nothing to verify.
const emptyManifest = results.length === 0
const allOk = !emptyManifest && (counts.OK || 0) === results.length

if (JSON_OUTPUT) {
  console.log(JSON.stringify({
    repoDir: REPO_DIR,
    homeDir: HOME_DIR,
    counts,
    allOk,
    emptyManifest,
    results
  }, null, 2))
} else {
  console.log(`Cutover check: repo=${REPO_DIR}`)
  console.log(`               home=${HOME_DIR}`)
  console.log()
  // Print sorted by status (non-OK first) then by relativePath.
  const STATUS_ORDER = { DIFF: 0, MISSING: 1, SOURCE_GONE: 2, OK: 3 }
  const sorted = [...results].sort((a, b) => {
    const so = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)
    if (so !== 0) return so
    return a.relativePath.localeCompare(b.relativePath)
  })
  for (const r of sorted) {
    const mark = r.status === 'OK' ? ' ' : '!'
    console.log(`${mark} ${r.status.padEnd(12)} ${r.kind.padEnd(11)} ${r.relativePath}`)
    if (r.status !== 'OK') console.log(`               installed: ${r.installedPath}`)
  }
  console.log()
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`Summary: ${summary} (total=${results.length})`)
  if (allOk) {
    console.log('All entries match. Cutover safe to proceed.')
  } else if (emptyManifest) {
    console.log('Manifest is empty — no entries to verify. Check --repo points at the episodic-memory repo root.')
  } else {
    console.log('Mismatches found. Re-run install.mjs --tool claude-code --install-hooks --install-hooks-force.')
  }
}

process.exit(allOk ? 0 : 1)
