#!/usr/bin/env node
/**
 * em.mjs — unified entry point for the episodic-memory substrate.
 *
 * One command instead of 20 script paths:
 *
 *   em <command> [args...]        ≡  node <scripts-dir>/em-<command>.mjs [args...]
 *
 * Examples:
 *   em store --project demo --category decision --summary "..." --body "..."
 *   em search --query "atomic rename" --scope all
 *   em recall
 *   em doctor --fix
 *
 * `em help` prints a human-readable command table (the only non-JSON output
 * surface in the substrate — every delegated command still emits JSON).
 * `em help --json` emits the same table as JSON for tooling.
 *
 * Command resolution is directory-driven: any em-<name>.mjs sitting next to
 * this file is a valid subcommand, so newly added substrate scripts are
 * dispatchable with zero changes here. Exit code and stdio pass through from
 * the delegated script.
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

// One-line descriptions for the help table. Commands discovered on disk but
// absent here still dispatch — they just render without a description.
const DESCRIPTIONS = {
  store: 'Save a new episode (decision, lesson, discovery, ...)',
  search: 'Search episodes by query/tag/category/project',
  list: 'List episodes, newest first',
  recall: 'Proactive session-start recall for the current project',
  revise: 'Correct a past episode via a revision chain',
  doctor: 'Health-check the stores and installation (--fix repairs)',
  prune: 'Archive stale low-relevance episodes',
  'rebuild-index': 'Regenerate index.jsonl, tags.json, category-index.json',
  backup: 'Sync stores to a backup git repository',
  restore: 'Restore stores from a backup repository',
  violation: 'Record a behavioral-pattern violation',
  'check-stale': 'Flag episodes past their review-by date',
  'pattern-health': 'Report behavioral-pattern health metrics',
  'seed-patterns': 'Seed the behavioral patterns into global memory',
  'mine-transcripts': 'Mine session transcripts for storable episodes',
  'audit-compliance': 'Audit episode-storage compliance for a session',
  'review-request': 'File a cross-tool review-request episode',
  'watch-codex': 'Watch for Codex review-reply episodes',
  'rfc-validate': 'Validate RFC registry/frontmatter/README consistency',
  'workflow-validate': 'Validate a workflow definition',
  lock: 'Run a command under an atomic file lock',
  'session-end-prompt': 'SessionEnd hook helper (enforcement layer)',
}

function availableCommands() {
  return fs.readdirSync(SCRIPT_DIR)
    .filter(f => /^em-.+\.mjs$/.test(f))
    .map(f => f.slice(3, -4))
    .sort()
}

function printHelp(asJson) {
  const cmds = availableCommands()
  if (asJson) {
    console.log(JSON.stringify({
      status: 'help',
      script: 'em.mjs',
      usage: 'em <command> [args...] — every command supports --help',
      commands: cmds.map(c => ({ command: c, description: DESCRIPTIONS[c] || '' }))
    }))
    return
  }
  const pad = Math.max(...cmds.map(c => c.length)) + 2
  console.log('em — episodic memory for AI coding agents')
  console.log('')
  console.log('Usage: em <command> [args...]   (every command supports --help)')
  console.log('')
  console.log('Commands:')
  for (const c of cmds) {
    console.log(`  ${c.padEnd(pad)}${DESCRIPTIONS[c] || ''}`)
  }
  console.log('')
  console.log('Common flags: --scope local|global|all, --project <name>, --limit <n>')
  console.log('Start here:   em recall            (what does memory know right now?)')
  console.log('              em doctor            (is everything healthy?)')
  console.log('Docs:         https://github.com/lantisprime/episodic-memory')
}

const argv = process.argv.slice(2)
const command = argv[0]

if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp(argv.includes('--json'))
  process.exit(command ? 0 : 1)
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[a.length][b.length]
}

const target = path.join(SCRIPT_DIR, `em-${command}.mjs`)
if (!/^[a-z][a-z0-9-]*$/.test(command) || !fs.existsSync(target)) {
  const cmds = availableCommands()
  const close = cmds.filter(c => editDistance(c, command) <= 2 || c.startsWith(command))
  console.log(JSON.stringify({
    status: 'error',
    message: `Unknown command "${command}". Run "em help" for the command list.`,
    ...(close.length ? { did_you_mean: close } : {})
  }))
  process.exit(2)
}

const r = spawnSync(process.execPath, [target, ...argv.slice(1)], { stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)
