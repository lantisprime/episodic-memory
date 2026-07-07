#!/usr/bin/env node
/**
 * em-doctor.mjs — One-command health check + repair for the episodic-memory
 * substrate. The maintenance entry point: run it any time something feels off
 * (or on a schedule) and it tells you exactly what is wrong and how to fix it
 * — or fixes it for you with --fix.
 *
 * Usage:
 *   node em-doctor.mjs [--scope local|global|all] [--fix] [--strict] [--verbose]
 *
 * Checks, per store scope:
 *   node-version      Node.js >= 18
 *   store             store dir + episodes/ layout
 *   index-parse       index.jsonl rows all parse as JSON
 *   index-drift       index rows ↔ episodes/*.md agree (both directions)
 *   tags-index        tags.json present; every referenced id exists
 *   category-index    category-index.json present; every referenced id exists
 *   supersedes-links  supersedes pointers resolve (dangling → warn)
 *   tmp-litter        leftover *.tmp files from interrupted atomic writes
 *   stale-locks       *.lock files whose owning pid is gone
 *   installed-scripts global ~/.episodic-memory/scripts has the core tools;
 *                     when run from a repo checkout, byte-compares installed
 *                     copies against repo sources (drift → warn)
 *   backup            backup config presence (info only)
 *
 * --fix repairs what is safely repairable: rebuilds indexes (via
 * em-rebuild-index.mjs) when index/tags/category checks fail, and removes
 * stale *.tmp files (older than 1h) and dead-pid *.lock files. Everything
 * else stays report-only.
 *
 * Exit codes: 0 = no error-level findings (warns allowed), 1 = errors found
 * (or, with --strict, warns found), 2 = usage error.
 *
 * Outputs JSON: { status, summary: {ok,warn,error}, checks: [...], fixes: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadIndex } from './lib/relevance.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-doctor.mjs', usage: 'node em-doctor.mjs [--scope local|global|all] [--fix] [--strict] [--verbose]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'all'
const fix = argv.includes('--fix')
const strict = argv.includes('--strict')
const verbose = argv.includes('--verbose')

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(2)
}

const checks = []
const fixes = []

function report(id, scopeName, level, message, extra) {
  checks.push({ id, scope: scopeName, level, message, ...(extra || {}) })
}

// Age threshold for treating a .tmp sidecar as litter rather than an
// in-flight atomic write.
const TMP_LITTER_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Environment checks
// ---------------------------------------------------------------------------
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10)
  if (major >= 18) {
    report('node-version', '-', 'ok', `Node.js ${process.versions.node}`)
  } else {
    report('node-version', '-', 'error', `Node.js ${process.versions.node} is below the supported floor (18). Upgrade Node.js.`)
  }
}

// ---------------------------------------------------------------------------
// Per-store checks
// ---------------------------------------------------------------------------
function checkStore(dataDir, scopeName) {
  if (!fs.existsSync(dataDir)) {
    // A missing store is not an error — scripts create it on first write.
    report('store', scopeName, 'ok', `No store at ${dataDir} (created on first use)`)
    return
  }

  const episodesDir = path.join(dataDir, 'episodes')
  const indexFile = path.join(dataDir, 'index.jsonl')
  const hasEpisodes = fs.existsSync(episodesDir)
  const hasIndex = fs.existsSync(indexFile)

  // Episode files on disk (source of truth for drift checks).
  const episodeIds = new Set(
    hasEpisodes
      ? fs.readdirSync(episodesDir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
      : []
  )

  if (!hasIndex && episodeIds.size === 0) {
    report('store', scopeName, 'ok', `Empty store at ${dataDir}`)
    return
  }
  report('store', scopeName, 'ok', `Store at ${dataDir}: ${episodeIds.size} episode file(s)`)

  // --- index-parse: count rows that fail to parse -------------------------
  let rawLines = []
  let badLines = 0
  if (hasIndex) {
    rawLines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
    for (const line of rawLines) {
      try { JSON.parse(line) } catch { badLines++ }
    }
  }
  if (badLines > 0) {
    report('index-parse', scopeName, 'error', `${badLines} malformed line(s) in index.jsonl`, { fix: 'em-rebuild-index' })
  } else {
    report('index-parse', scopeName, 'ok', hasIndex ? `index.jsonl: ${rawLines.length} row(s), all parse` : 'index.jsonl absent')
  }

  // --- row-shape: schema-deviant rows (#448 class) -------------------------
  // Hand-appended rows missing string date/time/summary (or with non-array
  // tags) no longer crash readers (#447) but sort last and degrade filters.
  // em-rebuild-index backfills date/time from the id prefix, so the fix hint
  // is a real repair, not just a report.
  const entriesForShape = loadIndex(dataDir, scopeName)
  const deviant = entriesForShape.filter(e =>
    typeof e.id !== 'string' || typeof e.date !== 'string' ||
    typeof e.time !== 'string' || typeof e.summary !== 'string' ||
    !Array.isArray(e.tags)
  )
  if (deviant.length) {
    report('row-shape', scopeName, 'warn',
      `${deviant.length} index row(s) missing typed id/date/time/summary/tags (hand-appended?). Rebuild backfills date/time from the episode id.`,
      { fix: 'em-rebuild-index', ...(verbose ? { rows: deviant.map(e => e.id).filter(Boolean) } : {}) })
  } else if (entriesForShape.length) {
    report('row-shape', scopeName, 'ok', 'all index rows carry typed id/date/time/summary/tags')
  }

  // --- index-drift: index rows ↔ episode files ----------------------------
  const entries = entriesForShape
  const indexedIds = new Set(entries.map(e => e.id))
  const missingFiles = [...indexedIds].filter(id => !episodeIds.has(id))
  const unindexed = [...episodeIds].filter(id => !indexedIds.has(id))
  if (missingFiles.length || unindexed.length) {
    report('index-drift', scopeName, 'error',
      `${missingFiles.length} indexed id(s) with no episode file; ${unindexed.length} episode file(s) not in index`,
      { fix: 'em-rebuild-index', ...(verbose ? { missing_files: missingFiles, unindexed_files: unindexed } : {}) })
  } else {
    report('index-drift', scopeName, 'ok', 'index.jsonl and episodes/ agree')
  }

  // --- tags-index / category-index / tokens-index ---------------------------
  for (const [checkId, fileName] of [['tags-index', 'tags.json'], ['category-index', 'category-index.json'], ['tokens-index', 'tokens.json']]) {
    const p = path.join(dataDir, fileName)
    if (!fs.existsSync(p)) {
      if (indexedIds.size > 0) {
        report(checkId, scopeName, 'warn', `${fileName} missing — searches fall back to slow linear scan`, { fix: 'em-rebuild-index' })
      } else {
        report(checkId, scopeName, 'ok', `${fileName} absent (empty store)`)
      }
      continue
    }
    let idx
    try {
      idx = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      report(checkId, scopeName, 'error', `${fileName} is corrupt (invalid JSON)`, { fix: 'em-rebuild-index' })
      continue
    }
    const danglers = []
    for (const ids of Object.values(idx)) {
      if (!Array.isArray(ids)) continue
      for (const id of ids) if (!indexedIds.has(id)) danglers.push(id)
    }
    if (danglers.length) {
      report(checkId, scopeName, 'warn', `${fileName} references ${danglers.length} id(s) not in index.jsonl`, { fix: 'em-rebuild-index', ...(verbose ? { dangling: [...new Set(danglers)] } : {}) })
    } else {
      report(checkId, scopeName, 'ok', `${fileName} consistent`)
    }
  }

  // --- supersedes-links ----------------------------------------------------
  const dangling = entries.filter(e => e.supersedes && !indexedIds.has(e.supersedes)).map(e => e.id)
  if (dangling.length) {
    // Dangling supersedes can be legitimate (chain crosses scopes, or the
    // original was pruned) — surface, don't fail.
    report('supersedes-links', scopeName, 'warn', `${dangling.length} episode(s) supersede id(s) not present in this scope`, verbose ? { episodes: dangling } : undefined)
  } else {
    report('supersedes-links', scopeName, 'ok', 'all supersedes pointers resolve')
  }

  // --- tmp-litter -----------------------------------------------------------
  const now = Date.now()
  const tmpFiles = fs.readdirSync(dataDir)
    .filter(f => f.endsWith('.tmp'))
    .map(f => path.join(dataDir, f))
    .filter(p2 => {
      try { return now - fs.statSync(p2).mtimeMs > TMP_LITTER_MS } catch { return false }
    })
  if (tmpFiles.length) {
    if (fix) {
      for (const f of tmpFiles) {
        try { fs.unlinkSync(f); fixes.push({ action: 'removed-tmp', file: f }) } catch {}
      }
      report('tmp-litter', scopeName, 'ok', `removed ${tmpFiles.length} stale .tmp file(s)`)
    } else {
      report('tmp-litter', scopeName, 'warn', `${tmpFiles.length} stale .tmp file(s) from interrupted writes (--fix removes)`, verbose ? { files: tmpFiles } : undefined)
    }
  } else {
    report('tmp-litter', scopeName, 'ok', 'no stale .tmp files')
  }

  // --- stale-locks ----------------------------------------------------------
  const lockFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.lock')).map(f => path.join(dataDir, f))
  const stale = []
  for (const lf of lockFiles) {
    let pid = null
    try {
      const m = fs.readFileSync(lf, 'utf8').match(/\d+/)
      if (m) pid = parseInt(m[0], 10)
    } catch { continue }
    let alive = false
    if (pid) {
      try { process.kill(pid, 0); alive = true } catch { alive = false }
    }
    if (!alive) stale.push(lf)
  }
  if (stale.length) {
    if (fix) {
      for (const f of stale) {
        try { fs.unlinkSync(f); fixes.push({ action: 'removed-stale-lock', file: f }) } catch {}
      }
      report('stale-locks', scopeName, 'ok', `removed ${stale.length} stale lock file(s)`)
    } else {
      report('stale-locks', scopeName, 'warn', `${stale.length} lock file(s) held by dead process(es) (--fix removes)`, verbose ? { files: stale } : undefined)
    }
  } else {
    report('stale-locks', scopeName, 'ok', lockFiles.length ? `${lockFiles.length} lock(s), all live` : 'no lock files')
  }
}

// ---------------------------------------------------------------------------
// Installed-scripts check. Two situations:
//   - running the installed copy: SCRIPT_DIR == the global scripts dir →
//     presence check only.
//   - running from a repo checkout: also byte-compare installed substrate
//     copies against the repo sources (install.mjs clobbers on every run, so
//     any diff means "re-run install").
// ---------------------------------------------------------------------------
const CORE_SCRIPTS = ['em-store.mjs', 'em-search.mjs', 'em-list.mjs', 'em-recall.mjs', 'em-revise.mjs', 'em-rebuild-index.mjs', 'em-doctor.mjs']

function checkInstalledScripts() {
  const installedDir = path.join(GLOBAL_DIR, 'scripts')
  if (!fs.existsSync(installedDir)) {
    report('installed-scripts', 'global', 'warn', `No installed scripts at ${installedDir}. Run: node <clone>/install.mjs --tool <your-tool> --project <your-project>`)
    return
  }
  const missing = CORE_SCRIPTS.filter(f => !fs.existsSync(path.join(installedDir, f)))
  if (missing.length) {
    report('installed-scripts', 'global', 'warn', `Installed scripts dir is missing: ${missing.join(', ')}. Re-run install.mjs to refresh.`)
    return
  }

  // Repo checkout detection: this script lives in <repo>/scripts iff the
  // parent holds install.mjs. The installed copy's parent is GLOBAL_DIR,
  // which has no install.mjs, so the drift comparison self-disables there.
  const repoRoot = path.dirname(SCRIPT_DIR)
  if (!fs.existsSync(path.join(repoRoot, 'install.mjs')) || path.resolve(SCRIPT_DIR) === path.resolve(installedDir)) {
    report('installed-scripts', 'global', 'ok', `All core scripts present at ${installedDir}`)
    return
  }
  const drifted = []
  for (const f of fs.readdirSync(SCRIPT_DIR).filter(f => f.startsWith('em-') && f.endsWith('.mjs'))) {
    const installed = path.join(installedDir, f)
    if (!fs.existsSync(installed)) continue
    try {
      if (!fs.readFileSync(path.join(SCRIPT_DIR, f)).equals(fs.readFileSync(installed))) drifted.push(f)
    } catch {}
  }
  if (drifted.length) {
    report('installed-scripts', 'global', 'warn', `${drifted.length} installed script(s) differ from this repo checkout: ${drifted.join(', ')}. Re-run install.mjs to refresh.`, verbose ? { drifted } : undefined)
  } else {
    report('installed-scripts', 'global', 'ok', `Installed scripts match this repo checkout`)
  }
}

function checkBackupConfig() {
  const candidates = [process.env.EM_BACKUP_CONFIG, path.join(os.homedir(), '.config/em-backup/config.json')].filter(Boolean)
  const found = candidates.find(c => fs.existsSync(c))
  if (found) {
    report('backup', '-', 'ok', `Backup config present at ${found}`)
  } else {
    report('backup', '-', 'ok', 'No backup config (optional). See scripts/em-backup.mjs --help to set one up.')
  }
}

// ---------------------------------------------------------------------------
// Run checks
// ---------------------------------------------------------------------------
checkNodeVersion()
if (scope === 'local' || scope === 'all') checkStore(LOCAL_DIR, 'local')
if (scope === 'global' || scope === 'all') checkStore(GLOBAL_DIR, 'global')
checkInstalledScripts()
checkBackupConfig()

// ---------------------------------------------------------------------------
// --fix: rebuild indexes for scopes with rebuildable findings, then re-verify
// by re-running the store checks and replacing their rows.
// ---------------------------------------------------------------------------
if (fix) {
  const rebuildScopes = new Set(
    checks.filter(c => c.fix === 'em-rebuild-index' && c.level !== 'ok').map(c => c.scope)
  )
  for (const s of rebuildScopes) {
    const rebuildScript = path.join(SCRIPT_DIR, 'em-rebuild-index.mjs')
    const r = spawnSync(process.execPath, [rebuildScript, '--scope', s], {
      encoding: 'utf8',
      // local rebuild must resolve the SAME local store this doctor saw
      cwd: s === 'local' ? path.dirname(LOCAL_DIR) : process.cwd()
    })
    fixes.push({ action: 'rebuild-index', scope: s, exit: r.status, output: (r.stdout || '').trim().slice(0, 500) })
  }
  if (rebuildScopes.size > 0) {
    // Re-verify: drop the pre-fix store rows and re-run those checks.
    const rerun = [...rebuildScopes]
    for (let i = checks.length - 1; i >= 0; i--) {
      if (rerun.includes(checks[i].scope)) checks.splice(i, 1)
    }
    for (const s of rerun) checkStore(s === 'local' ? LOCAL_DIR : GLOBAL_DIR, s)
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const summary = { ok: 0, warn: 0, error: 0 }
for (const c of checks) summary[c.level] = (summary[c.level] || 0) + 1

const healthy = summary.error === 0 && (!strict || summary.warn === 0)
const result = {
  status: healthy ? 'ok' : 'issues',
  summary,
  checks,
  ...(fixes.length ? { fixes } : {})
}
console.log(JSON.stringify(result))
process.exit(healthy ? 0 : 1)
