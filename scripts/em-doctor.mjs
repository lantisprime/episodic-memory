#!/usr/bin/env node
/**
 * em-doctor.mjs — One-command health check + repair for the episodic-memory
 * substrate. The maintenance entry point: run it any time something feels off
 * (or on a schedule) and it tells you exactly what is wrong and how to fix it
 * — or fixes it for you with --fix.
 *
 * Usage:
 *   node em-doctor.mjs [--scope local|global|all] [--fix] [--strict] [--verbose]
 *                      [--all-projects]
 *
 * --all-projects additionally runs the store-class checks once per consumer-
 * registry store (scope label `project:<basename>`; every store-class row
 * carries a `data_dir` field — the label is display-only and non-unique, the
 * dir is the identity). --fix routes rebuilds by data_dir, never by label,
 * and only for stores the substrate itself would resolve at that project root
 * (store_matches_project — a git-nested/worktree registration is reported
 * `skipped: non-root-store` because a spawned rebuild would repair a DIFFERENT
 * store than the one diagnosed).
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
 *   gate-friction     parses <repo>/.checkpoints/gate-log.jsonl (E5 gate
 *                     decision telemetry): per-decision counts, the
 *                     false-positive metric (held command shapes later
 *                     classified read_only/nonsrc_write in
 *                     .checkpoints/classify/), and a >5MB size warning.
 *                     Degrades gracefully when the log is absent/malformed.
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
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadIndex, TOKENS_DROPPED_KEY } from './lib/relevance.mjs'
import { resolveRegisteredStores, realpathSafe } from './lib/registered-stores.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-doctor.mjs', usage: 'node em-doctor.mjs [--scope local|global|all] [--fix] [--strict] [--verbose] [--all-projects] — --all-projects adds per-consumer-registry-store health checks (rows carry data_dir; --fix routes by data_dir and skips non-root-store registrations)' }))
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
const allProjects = argv.includes('--all-projects')

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

// Warn when tokens.json grows beyond this multiple of index.jsonl (S2 diet;
// the live store that motivated it measured 38x). Healthy dieted stores sit
// well under this.
const TOKENS_BLOAT_RATIO = 20

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
    for (const [key, ids] of Object.entries(idx)) {
      // tokens.json df-diet marker: value is dropped TOKEN strings, not ids.
      if (fileName === 'tokens.json' && key === TOKENS_DROPPED_KEY) continue
      if (!Array.isArray(ids)) continue
      for (const id of ids) if (!indexedIds.has(id)) danglers.push(id)
    }
    if (danglers.length) {
      report(checkId, scopeName, 'warn', `${fileName} references ${danglers.length} id(s) not in index.jsonl`, { fix: 'em-rebuild-index', ...(verbose ? { dangling: [...new Set(danglers)] } : {}) })
    } else {
      report(checkId, scopeName, 'ok', `${fileName} consistent`)
    }
  }

  // --- tokens-bloat ---------------------------------------------------------
  // tokens.json is derived from the same episodes index.jsonl describes; a
  // byte ratio above TOKENS_BLOAT_RATIO means the vocabulary is dominated by
  // non-discriminating posting lists (common tokens). A rebuild applies the
  // df diet (em-rebuild-index drops >40%-df posting lists) and shrinks it.
  try {
    const idxBytes = fs.statSync(indexFile).size
    const tokBytes = fs.statSync(path.join(dataDir, 'tokens.json')).size
    if (idxBytes > 0) {
      const ratio = tokBytes / idxBytes
      if (ratio > TOKENS_BLOAT_RATIO) {
        report('tokens-bloat', scopeName, 'warn',
          `tokens.json is ${Math.round(ratio)}x the size of index.jsonl (threshold ${TOKENS_BLOAT_RATIO}x) — rebuild to apply the df diet`,
          { fix: 'em-rebuild-index' })
      } else {
        report('tokens-bloat', scopeName, 'ok', `tokens.json/index.jsonl ratio ${Math.round(ratio * 10) / 10}x`)
      }
    }
  } catch { /* either file absent — covered by the presence checks above */ }

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
// Wave-6 #2 auto-capture drafts: pending drafts are meant to be reviewed or
// discarded promptly (confirm-before-store); ones older than 14 days are
// probably forgotten, not pending.
const DRAFT_STALE_MS = 14 * 24 * 60 * 60 * 1000
function checkDrafts() {
  const draftsDir = path.join(GLOBAL_DIR, 'drafts')
  let files = []
  try { files = fs.readdirSync(draftsDir).filter(f => f.endsWith('.json')) } catch {
    report('drafts', 'global', 'ok', 'no pending auto-capture drafts')
    return
  }
  if (!files.length) {
    report('drafts', 'global', 'ok', 'no pending auto-capture drafts')
    return
  }
  const now = Date.now()
  let stale = 0
  for (const f of files) {
    try {
      if (now - fs.statSync(path.join(draftsDir, f)).mtimeMs > DRAFT_STALE_MS) stale++
    } catch { /* raced deletion */ }
  }
  if (stale > 0) {
    report('drafts', 'global', 'warn', `${stale} auto-capture draft(s) older than 14 days — review or discard: em-capture list`, { fix: 'em-capture' })
  } else {
    report('drafts', 'global', 'ok', `${files.length} pending auto-capture draft(s) (review: em-capture list)`)
  }
}

// ---------------------------------------------------------------------------
// Gate-friction (E5): the enforcement gates (checkpoint-gate.sh, plan-gate.sh,
// stop-gate.sh) append one JSON line per terminal decision to
// <repo>/.checkpoints/gate-log.jsonl:
//   {ts, gate, tool, label, reason, decision: allow|silence|hold|block, sid,
//    cmd_sha256}
// where cmd_sha256 = sha256 of the WHITESPACE-NORMALIZED Bash command (runs of
// space/tab/CR/LF collapsed to one space, trimmed). This check reports decision
// counts and the FALSE-POSITIVE metric: a `hold` (novel command parked for
// agent classification) whose command shape LATER received a read_only or
// nonsrc_write verdict in .checkpoints/classify/ was friction the classifier
// caused on a harmless command. The join key re-hashes each classify marker's
// informational `command_normalized` field with the same collapse rules (a
// command with a trailing `#` comment misses the join — normalizeCommand also
// strips comments — which only UNDERcounts false positives; acceptable).
// Degrades gracefully: absent log → ok; unreadable → warn; malformed lines are
// counted and skipped, never fatal. Warns when the log exceeds 5MB.
// ---------------------------------------------------------------------------
const GATE_LOG_MAX_BYTES = 5 * 1024 * 1024

function checkGateFriction() {
  const repoRoot = path.dirname(LOCAL_DIR) // LOCAL_DIR = <repo>/.episodic-memory
  const logPath = path.join(repoRoot, '.checkpoints', 'gate-log.jsonl')
  let st
  try { st = fs.statSync(logPath) } catch {
    report('gate-friction', 'local', 'ok', 'no gate decision log (.checkpoints/gate-log.jsonl absent)')
    return
  }
  if (st.size > GATE_LOG_MAX_BYTES) {
    report('gate-log-size', 'local', 'warn',
      `gate-log.jsonl is ${(st.size / (1024 * 1024)).toFixed(1)}MB (limit 5MB) — rotate or truncate it (the gates only ever append)`)
  }
  let raw
  try { raw = fs.readFileSync(logPath, 'utf8') } catch (e) {
    report('gate-friction', 'local', 'warn', `gate-log.jsonl unreadable (${e.code || e.message})`)
    return
  }
  const lines = raw.split('\n').filter(Boolean)
  // Closed decision vocabulary + null-proto tally: a line whose decision is an
  // Object.prototype key ('constructor', 'toString') must count as malformed,
  // not read an inherited function as its current count (#469/#470 invariant:
  // external strings never index a default-proto object).
  const DECISIONS = ['allow', 'silence', 'hold', 'block']
  const counts = Object.assign(Object.create(null), { allow: 0, silence: 0, hold: 0, block: 0 })
  let malformed = 0
  const holdShas = new Map() // cmd_sha256 → hold-event count
  for (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { malformed++; continue }
    if (row === null || typeof row !== 'object' || typeof row.decision !== 'string'
        || !DECISIONS.includes(row.decision)) { malformed++; continue }
    counts[row.decision] = (counts[row.decision] || 0) + 1
    if (row.decision === 'hold' && typeof row.cmd_sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.cmd_sha256)) {
      holdShas.set(row.cmd_sha256, (holdShas.get(row.cmd_sha256) || 0) + 1)
    }
  }
  const countMsg =
    `${lines.length - malformed} gate decision(s): ${counts.allow} allow, ${counts.silence} silence, ` +
    `${counts.hold} hold, ${counts.block} block` +
    (malformed ? ` (${malformed} malformed line(s) skipped)` : '')
  report('gate-friction', 'local', 'ok', countMsg,
    verbose ? { counts, malformed } : undefined)

  // False-positive metric: held shapes later downgraded by an agent verdict.
  const classifyDir = path.join(repoRoot, '.checkpoints', 'classify')
  let markerFiles = []
  try {
    markerFiles = fs.readdirSync(classifyDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
  } catch { /* no classify store → no verdicts to join against */ }
  const downgradedShas = new Set()
  for (const f of markerFiles) {
    let m
    try { m = JSON.parse(fs.readFileSync(path.join(classifyDir, f), 'utf8')) } catch { continue }
    if (m === null || typeof m !== 'object') continue
    if (m.label !== 'read_only' && m.label !== 'nonsrc_write') continue
    if (typeof m.command_normalized !== 'string') continue
    const normed = m.command_normalized.replace(/[ \t\r\n]+/g, ' ').trim()
    if (!normed) continue
    const sha = crypto.createHash('sha256').update(normed).digest('hex')
    if (holdShas.has(sha)) downgradedShas.add(sha)
  }
  if (downgradedShas.size > 0) {
    let holdEvents = 0
    for (const sha of downgradedShas) holdEvents += holdShas.get(sha)
    report('gate-false-positives', 'local', 'warn',
      `${downgradedShas.size} held command shape(s) (${holdEvents} hold event(s)) later classified read_only/nonsrc_write — classifier false positives; consider a pattern/override for these shapes`,
      verbose ? { shas: [...downgradedShas] } : undefined)
  } else if (counts.hold > 0) {
    report('gate-false-positives', 'local', 'ok',
      `${counts.hold} hold(s), none later downgraded to read_only/nonsrc_write`)
  } else {
    report('gate-false-positives', 'local', 'ok', 'no holds recorded')
  }
}

// ---------------------------------------------------------------------------
// installs-drift (Layer 1): compare each registered consumer project's install
// manifest against the global one — report behind/modified counts. Reads
// ~/.episodic-memory/installs.json (consumer registry) + install-manifest.json
// (global version) + each project's .episodic-memory-install.json. Degrades to
// a single ok row when the registry/manifests are absent (pre-Layer-1 installs
// or nothing installed per-project yet). Self-contained + additive — no other
// section touched.
// ---------------------------------------------------------------------------
function checkInstallsDrift() {
  const readJson = (p) => {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8'))
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch { return null }
  }
  const registry = readJson(path.join(GLOBAL_DIR, 'installs.json'))
  const entries = registry && Array.isArray(registry.entries) ? registry.entries : []
  if (entries.length === 0) {
    report('installs-drift', 'global', 'ok', 'no consumer registry entries (no per-project installs recorded yet)')
    return
  }
  const globalManifest = readJson(path.join(GLOBAL_DIR, 'install-manifest.json'))
  const globalVersion = globalManifest && typeof globalManifest.source_version === 'string'
    ? globalManifest.source_version : null
  const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

  const projects = [...new Set(entries
    .filter(e => e && typeof e.project_path === 'string')
    .map(e => e.project_path))]
  let behind = 0
  let withModified = 0
  let vanished = 0
  let noManifest = 0
  const details = []
  for (const projectPath of projects) {
    if (!fs.existsSync(projectPath)) {
      vanished++
      details.push(`${projectPath}: path gone (sweep will prune)`)
      continue
    }
    const m = readJson(path.join(projectPath, '.episodic-memory-install.json'))
    if (!m || !Array.isArray(m.artifacts)) {
      noManifest++
      details.push(`${projectPath}: no install manifest (pre-Layer-1 install; re-run install.mjs)`)
      continue
    }
    const isBehind = globalVersion && typeof m.source_version === 'string' && m.source_version !== globalVersion
    if (isBehind) behind++
    let modified = 0
    for (const a of m.artifacts) {
      if (!a || typeof a.path !== 'string' || typeof a.sha256 !== 'string') continue
      const dest = path.join(projectPath, a.path)
      try {
        if (sha256(dest) !== a.sha256) modified++
      } catch { modified++ /* missing file counts as locally changed */ }
    }
    if (modified > 0) withModified++
    if (isBehind || modified > 0) {
      details.push(`${projectPath}: ${isBehind ? `behind global (${String(m.source_version).slice(0, 12)} vs ${globalVersion.slice(0, 12)})` : 'at global version'}${modified > 0 ? `, ${modified} locally modified artifact(s)` : ''}`)
    }
  }
  if (behind + withModified + vanished + noManifest === 0) {
    report('installs-drift', 'global', 'ok', `${projects.length} consumer project(s) current with global${globalVersion ? ` (${globalVersion.slice(0, 12)})` : ''}`)
  } else {
    report('installs-drift', 'global', 'warn',
      `${projects.length} consumer project(s): ${behind} behind global, ${withModified} with locally modified artifacts, ${vanished} vanished, ${noManifest} without a manifest. Refresh: node <episodic-memory-repo>/install.mjs --update-consumers (modified files are never overwritten).`,
      verbose ? { projects: details } : undefined)
  }
}

// Every store-class row carries data_dir (the identity; scope labels are
// display-only and can collide across same-basename registered projects).
function checkStoreWithDir(dataDir, scopeName) {
  const before = checks.length
  checkStore(dataDir, scopeName)
  for (let i = before; i < checks.length; i++) checks[i].data_dir = dataDir
}

const ranStoreDirs = new Set()
if (scope === 'local' || scope === 'all') { checkStoreWithDir(LOCAL_DIR, 'local'); ranStoreDirs.add(realpathSafe(LOCAL_DIR)) }
if (scope === 'global' || scope === 'all') { checkStoreWithDir(GLOBAL_DIR, 'global'); ranStoreDirs.add(realpathSafe(GLOBAL_DIR)) }

// --all-projects: store-class checks per consumer-registry store not already
// covered (realpath both sides — a cwd-local store symlinked to a registered
// store must not produce two blocks). Non-store checks below still run once.
const registeredStores = allProjects ? resolveRegisteredStores() : []
const registeredByDir = new Map(registeredStores.map(st => [st.data_dir, st]))
for (const st of registeredStores) {
  const key = realpathSafe(st.data_dir)
  if (ranStoreDirs.has(key)) continue
  ranStoreDirs.add(key)
  checkStoreWithDir(st.data_dir, st.label)
}

if (scope === 'local' || scope === 'all') checkGateFriction()
if (scope === 'global' || scope === 'all') checkInstallsDrift()
checkInstalledScripts()
checkBackupConfig()
checkDrafts()

// ---------------------------------------------------------------------------
// --fix: rebuild indexes for scopes with rebuildable findings, then re-verify
// by re-running the store checks and replacing their rows.
// ---------------------------------------------------------------------------
if (fix) {
  // Rebuild routing is keyed by data_dir (identity), never by the scope label
  // (display-only; two registered projects named "app" share a label). Foreign
  // stores rebuild via a spawn with cwd = that project's root, and ONLY when
  // the substrate's own resolution matches that root (store_matches_project) —
  // otherwise the spawned rebuild would repair a different store than the one
  // diagnosed, so the entry is reported and skipped.
  const rebuildTargets = new Map() // data_dir -> {scopeLabel, scopeArg, cwd}
  const skippedNonRoot = new Set()
  for (const c of checks) {
    if (c.fix !== 'em-rebuild-index' || c.level === 'ok') continue
    if (c.scope === 'local') {
      rebuildTargets.set(LOCAL_DIR, { scopeLabel: 'local', scopeArg: 'local', cwd: path.dirname(LOCAL_DIR) })
    } else if (c.scope === 'global') {
      rebuildTargets.set(GLOBAL_DIR, { scopeLabel: 'global', scopeArg: 'global', cwd: process.cwd() })
    } else if (typeof c.data_dir === 'string') {
      const st = registeredByDir.get(c.data_dir)
      if (!st) continue
      if (!st.store_matches_project) {
        if (!skippedNonRoot.has(c.data_dir)) {
          skippedNonRoot.add(c.data_dir)
          fixes.push({ action: 'skipped', reason: 'non-root-store', scope: c.scope, dir: c.data_dir, project: st.project_path })
        }
        continue
      }
      rebuildTargets.set(c.data_dir, { scopeLabel: c.scope, scopeArg: 'local', cwd: st.project_path })
    }
  }
  for (const [dataDir, t] of rebuildTargets) {
    const rebuildScript = path.join(SCRIPT_DIR, 'em-rebuild-index.mjs')
    const r = spawnSync(process.execPath, [rebuildScript, '--scope', t.scopeArg], {
      encoding: 'utf8',
      // the rebuild must resolve the SAME store this doctor saw
      cwd: t.cwd,
    })
    fixes.push({ action: 'rebuild-index', scope: t.scopeLabel, dir: dataDir, exit: r.status, output: (r.stdout || '').trim().slice(0, 500) })
  }
  if (rebuildTargets.size > 0) {
    // Re-verify: drop the pre-fix store rows for rebuilt dirs and re-run.
    const rerunDirs = new Set(rebuildTargets.keys())
    for (let i = checks.length - 1; i >= 0; i--) {
      if (typeof checks[i].data_dir === 'string' && rerunDirs.has(checks[i].data_dir)) checks.splice(i, 1)
    }
    for (const [dataDir, t] of rebuildTargets) checkStoreWithDir(dataDir, t.scopeLabel)
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
