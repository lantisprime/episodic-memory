#!/usr/bin/env node
/**
 * em-pattern-health.mjs — Per-pattern violation health report.
 *
 * Usage:
 *   node em-pattern-health.mjs [--pattern <id>] [--scope local|global|all]
 *                              [--window-days <N>] [--min-violations <N>]
 *                              [--has-enforcement <id>]
 *                              [--check] [--json] [--summary]
 *
 * Reads patterns/_index.json + violation episodes via tags.json (with
 * index.jsonl fallback), counts violations per pattern within rolling window,
 * detects enforcement presence in hook scripts and CI workflows, classifies
 * each pattern as healthy / needs-attention / needs-enforcement.
 *
 * Outputs JSON: { status, patterns: [...], summary: {...}, warning? }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const HOME = os.homedir()
const CWD = process.cwd()
const GLOBAL_DIR = path.join(HOME, '.episodic-memory')
const LOCAL_DIR = path.join(CWD, '.episodic-memory')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function multiFlag(name) {
  const out = []
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === name) out.push(argv[i + 1])
  }
  return out
}

const onlyPattern = flag('--pattern')
const scope = flag('--scope') || 'all'
const windowDays = parseInt(flag('--window-days') || '30', 10)
const minViolations = parseInt(flag('--min-violations') || '3', 10)
const hasEnforcementOverrides = new Set(multiFlag('--has-enforcement'))
const checkMode = argv.includes('--check')
const summaryMode = argv.includes('--summary')
const jsonMode = argv.includes('--json')

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}
if (summaryMode && jsonMode) {
  console.log(JSON.stringify({ status: 'error', message: '--summary and --json are mutually exclusive' }))
  process.exit(1)
}
if (Number.isNaN(windowDays) || windowDays <= 0) {
  console.log(JSON.stringify({ status: 'error', message: '--window-days must be a positive integer' }))
  process.exit(1)
}
if (Number.isNaN(minViolations) || minViolations <= 0) {
  console.log(JSON.stringify({ status: 'error', message: '--min-violations must be a positive integer' }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Load patterns registry (project-local first, then global install)
// ---------------------------------------------------------------------------
function loadPatternsIndex() {
  const candidates = [
    path.join(CWD, 'patterns', '_index.json'),
    path.join(HOME, '.episodic-memory', 'patterns', '_index.json'),
  ]
  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (data.patterns && Array.isArray(data.patterns)) return data.patterns
    } catch {}
  }
  return null
}

const patterns = loadPatternsIndex()
if (!patterns) {
  console.log(JSON.stringify({ status: 'error', message: 'patterns/_index.json not found in project or ~/.episodic-memory/patterns/' }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Load violation episodes from configured scopes
//   - Use tags.json `violated:<pattern_id>` lookup when available (fast path).
//   - Fall back to linear scan over index.jsonl when tags.json is missing or
//     does not contain the key (matches em-search.mjs behavior).
//   - Stale counts are acceptable: the script is read-only and concurrent
//     em-store appends will simply not appear until the next invocation.
// ---------------------------------------------------------------------------
const SCOPE_DIRS = []
if (scope === 'local' || scope === 'all') SCOPE_DIRS.push({ dir: LOCAL_DIR, source: 'local' })
if (scope === 'global' || scope === 'all') SCOPE_DIRS.push({ dir: GLOBAL_DIR, source: 'global' })

function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  const out = []
  for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      e._source = source
      out.push(e)
    } catch {}
  }
  return out
}

function loadTagsIndex(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'tags.json'), 'utf8'))
  } catch {
    return null
  }
}

const allEntries = []
for (const s of SCOPE_DIRS) allEntries.push(...loadIndex(s.dir, s.source))

// Dedupe by id (local takes priority over global) — mirrors em-search.mjs:159-164
const seen = new Set()
const dedupedEntries = allEntries.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})
const entryById = new Map(dedupedEntries.map(e => [e.id, e]))

// Cache tags.json once per scope — em-pattern-health is read-only and the same
// keys are queried per pattern × scope. Avoids O(patterns × scopes) disk reads.
const tagsByScope = SCOPE_DIRS.map(s => ({ source: s.source, idx: loadTagsIndex(s.dir) }))

const warnings = []
let usedFallback = false

function violationIdsFromTags(patternId) {
  const key = `violated:${patternId}`.toLowerCase()
  const ids = new Set()
  let anyTagsFile = false
  let foundKey = false
  for (const t of tagsByScope) {
    if (!t.idx) continue
    anyTagsFile = true
    if (Array.isArray(t.idx[key])) {
      foundKey = true
      for (const id of t.idx[key]) ids.add(id)
    }
  }
  return { ids, anyTagsFile, foundKey }
}

function violationIdsLinearScan(patternId) {
  const key = `violated:${patternId}`.toLowerCase()
  const ids = new Set()
  for (const e of dedupedEntries) {
    if (!e.tags) continue
    if (e.tags.map(t => String(t).toLowerCase().trim()).includes(key)) ids.add(e.id)
  }
  return ids
}

// Date contract: em-store.mjs writes `e.date` as `YYYY-MM-DD` from
// `now.toISOString().slice(0, 10)` (UTC). We compare numerically via
// Date.parse so malformed/non-strict dates fall through `parseDateMs` and
// are skipped instead of producing wrong string-comparison results. Cutoff
// is snapped to UTC midnight `windowDays` ago so the window is day-granular
// — an episode dated `cutoff_day` is in-window regardless of the time of day
// the script is invoked.
const cutoffMs = Date.parse(
  new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T00:00:00Z'
)

function parseDateMs(s) {
  if (!s || typeof s !== 'string') return null
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  const ms = Date.parse(s.slice(0, 10) + 'T00:00:00Z')
  return Number.isNaN(ms) ? null : ms
}

function countViolationsForPattern(patternId) {
  const { ids: tagIds, anyTagsFile, foundKey } = violationIdsFromTags(patternId)
  let candidateIds = tagIds
  if (!anyTagsFile || !foundKey) {
    // Fallback path — tags.json missing or the key is absent. The latter is
    // also the *normal* case for a pattern with zero violations, so we don't
    // warn unconditionally. We warn when there is concrete evidence of
    // staleness: either no tags.json exists anywhere, or linear scan finds
    // violations the fast path missed.
    candidateIds = violationIdsLinearScan(patternId)
    if (!usedFallback && (candidateIds.size > 0 || !anyTagsFile)) {
      usedFallback = true
      warnings.push('tags.json missing or stale. Falling back to linear scan. Run em-rebuild-index.mjs to regenerate.')
    }
  }
  let count = 0
  let lastViolated = null
  for (const id of candidateIds) {
    const e = entryById.get(id)
    if (!e) continue
    if (e.category !== 'violation') continue
    if (e.status === 'superseded') continue
    const dateMs = parseDateMs(e.date)
    if (dateMs === null) continue
    if (dateMs < cutoffMs) continue
    count++
    if (!lastViolated || e.date > lastViolated) lastViolated = e.date
  }
  return { count, lastViolated }
}

// ---------------------------------------------------------------------------
// Enforcement detection
//   Search paths (best-effort, ENOENT-safe):
//     ~/.claude/hooks/*.sh                    — global Claude Code hooks
//     <project>/.claude/hooks/*.sh            — project-local Claude Code hooks
//     <project>/.git/hooks/*                  — git hooks (no extension; .sample skipped)
//     <project>/.github/workflows/*.{yml,yaml} — GitHub Actions workflows
//   Comment-stripping heuristic: if the lstripped line starts with `#`, skip.
//   Match uses word-boundary regex around the pattern_id to avoid prefix
//   false-positives (bp-001 inside bp-001-v2). Limitations are accepted per
//   RFC-002 §Phase 2; --has-enforcement is the documented escape hatch.
// ---------------------------------------------------------------------------
const ENFORCEMENT_PATHS = [
  { dir: path.join(HOME, '.claude', 'hooks'), include: f => /\.sh$/.test(f) },
  { dir: path.join(CWD, '.claude', 'hooks'), include: f => /\.sh$/.test(f) },
  { dir: path.join(CWD, '.git', 'hooks'), include: f => !/\.sample$/.test(f) },
  { dir: path.join(CWD, '.github', 'workflows'), include: f => /\.ya?ml$/.test(f) },
]

function listEnforcementFiles() {
  const files = []
  for (const p of ENFORCEMENT_PATHS) {
    let entries
    try {
      entries = fs.readdirSync(p.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue
      if (!p.include(ent.name)) continue
      files.push(path.join(p.dir, ent.name))
    }
  }
  return files
}

const enforcementFiles = listEnforcementFiles()

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function detectEnforcement(patternId) {
  if (hasEnforcementOverrides.has(patternId)) return true
  // Strict boundary: pattern_id is not preceded or followed by a word char or
  // hyphen. Plain `\b` would let `bp-001-implementation-workflow` match inside
  // `bp-001-implementation-workflow-v2` because `-` is a non-word character.
  const re = new RegExp(`(?<![\\w-])${escapeRegex(patternId)}(?![\\w-])`)
  for (const file of enforcementFiles) {
    let content
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      const stripped = line.replace(/^\s+/, '')
      if (stripped.startsWith('#')) continue
      if (re.test(line)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Classify each pattern
// ---------------------------------------------------------------------------
function classify(violations, hasEnforcement) {
  if (violations < minViolations) return 'healthy'
  return hasEnforcement ? 'needs-attention' : 'needs-enforcement'
}

const targetPatterns = onlyPattern
  ? patterns.filter(p => p.pattern_id === onlyPattern)
  : patterns

if (onlyPattern && targetPatterns.length === 0) {
  console.log(JSON.stringify({
    status: 'error',
    message: `Unknown pattern "${onlyPattern}". Valid patterns: ${patterns.map(p => p.pattern_id).join(', ')}`,
  }))
  process.exit(1)
}

const reports = []
for (const p of targetPatterns) {
  const { count, lastViolated } = countViolationsForPattern(p.pattern_id)
  const has = detectEnforcement(p.pattern_id)
  reports.push({
    pattern_id: p.pattern_id,
    violations: count,
    last_violated: lastViolated,
    has_enforcement: has,
    recommendation: classify(count, has),
  })
}

const summary = {
  total: reports.length,
  healthy: reports.filter(r => r.recommendation === 'healthy').length,
  needs_attention: reports.filter(r => r.recommendation === 'needs-attention').length,
  needs_enforcement: reports.filter(r => r.recommendation === 'needs-enforcement').length,
}

const result = { status: 'ok', patterns: reports, summary }
if (warnings.length) result.warning = warnings.join(' | ')

// ---------------------------------------------------------------------------
// Output mode + exit code
// ---------------------------------------------------------------------------
const unhealthy = summary.needs_attention + summary.needs_enforcement

if (summaryMode) {
  console.log(`patterns: ${summary.total} | healthy: ${summary.healthy} | needs-attention: ${summary.needs_attention} | needs-enforcement: ${summary.needs_enforcement}`)
} else {
  console.log(JSON.stringify(result))
}

if (checkMode) {
  process.exit(unhealthy > 0 ? 1 : 0)
}
process.exit(0)
