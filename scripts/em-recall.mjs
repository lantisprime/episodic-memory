#!/usr/bin/env node
/**
 * em-recall.mjs — Proactive session-start recall via multi-pass retrieval.
 *
 * Usage:
 *   node em-recall.mjs [--project <name>] [--scope local|global|all]
 *                      [--limit <n>] [--days <n>] [--no-track]
 *                      [--warn-time-ms <n>] [--warn-count <n>]
 *
 * Three passes:
 *   1. Project match — episodes whose `project` field matches inferred project name
 *   2. Tag match — episodes whose tags overlap with inferred context tokens
 *   3. Recent cross-project — high-relevance episodes from last N days
 *
 * Outputs JSON: { status, context, count, episodes, preflight_warnings, prune_suggestion }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { resolveLocalDir } from './lib/local-dir.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const projectOverride = flag('--project')
const scope = flag('--scope') || 'all'
const limit = parseInt(flag('--limit') || '5', 10)
const days = parseInt(flag('--days') || '7', 10)
const noTrack = argv.includes('--no-track')
const warnTimeMs = parseInt(flag('--warn-time-ms') || '500', 10)
const warnCount = parseInt(flag('--warn-count') || '500', 10)
const taskTypeFlag = flag('--task-type')

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}

const VALID_TASK_TYPES = ['implementation', 'push', 'rule', 'general']
if (taskTypeFlag !== undefined && !VALID_TASK_TYPES.includes(taskTypeFlag)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --task-type "${taskTypeFlag}". Must be one of: ${VALID_TASK_TYPES.join(', ')}` }))
  process.exit(1)
}

const recallStart = Date.now()

// ---------------------------------------------------------------------------
// Stopword list for tag matching
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'fix', 'feat', 'feature', 'bug', 'test', 'app', 'src', 'lib', 'dev',
  'main', 'master', 'release', 'hotfix', 'docs', 'chore', 'refactor',
  'style', 'ci', 'cd', 'build', 'user', 'data', 'add', 'update', 'new',
  'phase', 'merge', 'pr', 'push', 'implement', 'wip', 'draft', 'rule',
  'enforce', 'pattern'
])

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:normalizeTags — update both on change
// ---------------------------------------------------------------------------
function normalizeTags(raw) {
  if (!raw) return []
  const arr = (Array.isArray(raw) ? raw : raw.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(arr)].sort()
}

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:loadTagsIndex — update both on change
// ---------------------------------------------------------------------------
function loadTagsIndex(dataDir) {
  const tagsFile = path.join(dataDir, 'tags.json')
  try {
    return JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:computeScore — update both on change
// ---------------------------------------------------------------------------
function computeScore(entry, textMatchScore) {
  const accessCount = entry.access_count || 0
  // Use new Date(entry.date) for decay — sub-day precision unnecessary
  const created = new Date(entry.date)
  const daysSince = Math.max(0, (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24))
  const timeFactor = Math.max(0.1, 1 - (daysSince / 365))
  const accessFactor = 1 + Math.log1p(accessCount) * 0.1
  return textMatchScore * timeFactor * accessFactor
}

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:writeBackAccessTracking — update both on change
// ---------------------------------------------------------------------------
function writeBackAccessTracking(results) {
  // Group results by source data directory
  const byDir = new Map()
  for (const e of results) {
    if (!e._dataDir) continue
    if (!byDir.has(e._dataDir)) byDir.set(e._dataDir, new Set())
    byDir.get(e._dataDir).add(e.id)
  }

  const now = new Date().toISOString().slice(0, 19) + 'Z'

  for (const [dataDir, ids] of byDir) {
    const indexFile = path.join(dataDir, 'index.jsonl')
    try {
      // Re-read just before writing to narrow race window with concurrent em-store appends.
      // This is best-effort — last-writer-wins for concurrent searches is acceptable.
      const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      const updated = lines.map(line => {
        try {
          const entry = JSON.parse(line)
          if (ids.has(entry.id)) {
            entry.access_count = (entry.access_count || 0) + 1
            entry.last_accessed = now
          }
          return JSON.stringify(entry)
        } catch { return line }
      })
      const tmpFile = indexFile + '.tmp'
      fs.writeFileSync(tmpFile, updated.join('\n') + '\n', 'utf8')
      fs.renameSync(tmpFile, indexFile)
    } catch {
      // Access tracking is best-effort — skip silently on failure
    }
  }
}

// ---------------------------------------------------------------------------
// Task-type → relevant pattern_ids (RFC-002 Phase 3)
// Pre-flight surfaces violations of these patterns when task type is known.
// Empty list means no violation pre-flight runs (e.g. task-type=general).
// ---------------------------------------------------------------------------
const TASK_TYPE_PATTERNS = {
  implementation: ['bp-001-implementation-workflow', 'bp-006-push-after-verify'],
  push: ['bp-006-push-after-verify'],
  rule: ['bp-010-habits-override-knowledge'],
  general: []
}

// ---------------------------------------------------------------------------
// Branch token → task type keyword inference. First match wins. No match
// means task type stays unknown and no pre-flight runs.
// ---------------------------------------------------------------------------
const BRANCH_TYPE_KEYWORDS = {
  implementation: ['implement', 'build', 'feature', 'phase', 'feat'],
  push: ['push', 'merge', 'pr', 'release'],
  rule: ['rule', 'enforce', 'pattern']
}

function inferTaskType(branchTokens) {
  if (!branchTokens || branchTokens.length === 0) return null
  for (const type of ['implementation', 'push', 'rule']) {
    const keywords = BRANCH_TYPE_KEYWORDS[type]
    if (branchTokens.some(t => keywords.includes(t))) return type
  }
  return null
}

// ---------------------------------------------------------------------------
// Load patterns/_index.json (project-local first, then global install).
// Mirrors em-violation.mjs:loadPatternsIndex.
// ---------------------------------------------------------------------------
function loadPatternsIndex() {
  const candidates = [
    path.join(process.cwd(), 'patterns', '_index.json'),
    path.join(os.homedir(), '.episodic-memory', 'patterns', '_index.json')
  ]
  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (data.patterns && Array.isArray(data.patterns)) return data.patterns
    } catch {}
  }
  return []
}

// ---------------------------------------------------------------------------
// Violation pre-flight: scan activeEntries for violations of patterns
// relevant to the task type within the last 30 days. Returns warning objects.
// ---------------------------------------------------------------------------
function runViolationPreflight(activeEntries, taskType, patterns) {
  if (!taskType) return []
  const relevantIds = TASK_TYPE_PATTERNS[taskType] || []
  if (relevantIds.length === 0) return []

  const validIds = new Set(patterns.map(p => p.pattern_id))
  const filterIds = relevantIds.filter(id => validIds.has(id))
  if (filterIds.length === 0) return []

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const warnings = []
  for (const patternId of filterIds) {
    const violationTag = `violated:${patternId}`
    const matching = activeEntries.filter(e =>
      e.category === 'violation' &&
      Array.isArray(e.tags) &&
      e.tags.includes(violationTag) &&
      typeof e.date === 'string' &&
      e.date >= cutoffStr
    )
    if (matching.length === 0) continue
    matching.sort((a, b) => b.date.localeCompare(a.date))
    const last = matching[0].date
    warnings.push({
      type: 'violation',
      pattern_id: patternId,
      violations_last_30d: matching.length,
      last_violation: last,
      message: `${patternId} violated ${matching.length} time${matching.length === 1 ? '' : 's'} in last 30 days (last: ${last}). Remember to follow this pattern before proceeding.`
    })
  }
  return warnings
}

// ---------------------------------------------------------------------------
// Phase 3b activation predicate: returns true iff there exists at least one
// active (non-superseded) episode within the 30-day cutoff that is a
// bp-001-implementation-workflow violation. Decoupled from task_type so the
// SessionStart hook can arm the checkpoint marker even when branch/task-type
// inference returns null. Pure function — testable in isolation and stable
// for #80's later validator-backed gate to swap.
// ---------------------------------------------------------------------------
function shouldArmBp001Checkpoint(activeEntries, now) {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const tag = 'violated:bp-001-implementation-workflow'
  return activeEntries.some(e =>
    e &&
    e.category === 'violation' &&
    Array.isArray(e.tags) &&
    e.tags.includes(tag) &&
    typeof e.date === 'string' &&
    e.date >= cutoffStr
  )
}

// ---------------------------------------------------------------------------
// Idempotent marker arming. Best-effort — failures are swallowed so a
// non-writable .claude dir doesn't take down the whole recall.
// ---------------------------------------------------------------------------
function armCheckpointMarker(cwd) {
  try {
    const claudeDir = path.join(cwd, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    const markerPath = path.join(claudeDir, '.checkpoint-required')
    if (!fs.existsSync(markerPath)) fs.writeFileSync(markerPath, '')
  } catch {
    // Best-effort: marker creation failure leaves Phase 3b gate inactive
    // for this session.
  }
}

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:loadIndex — update both on change
// ---------------------------------------------------------------------------
function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try {
      const entry = JSON.parse(line)
      entry._source = source
      entry._dataDir = dataDir
      return entry
    } catch { return null }
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Context inference
// ---------------------------------------------------------------------------
function inferContext() {
  const ctx = { project: null, branch_tokens: [], keywords: [], effective_tokens: [] }

  // Always read package.json for keywords (even when project is overridden)
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    if (Array.isArray(pkg.keywords)) ctx.keywords = pkg.keywords.map(k => k.toLowerCase().trim()).filter(Boolean)
    if (!projectOverride && pkg.name && pkg.name.trim()) ctx.project = pkg.name.trim()
  } catch {}

  // 1. Project name: override → package.json (above) → git remote → basename(cwd)
  if (projectOverride) {
    ctx.project = projectOverride
  } else if (!ctx.project) {
    // Try git remote
    try {
      const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
      // SSH: git@github.com:org/repo.git → repo
      // HTTPS: https://github.com/org/repo.git → repo
      const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/) || remoteUrl.match(/:([^/]+?)(?:\.git)?$/)
      if (match) ctx.project = match[1]
    } catch {}

    // Fallback to basename(cwd)
    if (!ctx.project) {
      ctx.project = path.basename(process.cwd())
    }
  }

  // 2. Branch tokens
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    if (branch) {
      ctx.branch_tokens = branch.split(/[/\-_]/).filter(Boolean).map(t => t.toLowerCase())
    }
  } catch {}

  // 3. Effective tokens: branch tokens + keywords, stopword-filtered
  const allTokens = [...ctx.branch_tokens, ...ctx.keywords]
  ctx.effective_tokens = [...new Set(
    allTokens.filter(t => t.length >= 4 && !STOPWORDS.has(t))
  )]

  return ctx
}

// ---------------------------------------------------------------------------
// Load all entries once
// ---------------------------------------------------------------------------
let allEntries = []

if (scope === 'local' || scope === 'all') {
  allEntries.push(...loadIndex(LOCAL_DIR, 'local'))
}
if (scope === 'global' || scope === 'all') {
  allEntries.push(...loadIndex(GLOBAL_DIR, 'global'))
}

const totalEpisodeCount = allEntries.length

// Dedupe by id (local takes priority)
const seenIds = new Set()
allEntries = allEntries.filter(e => {
  if (seenIds.has(e.id)) return false
  seenIds.add(e.id)
  return true
})

// Filter out superseded
const activeEntries = allEntries.filter(e => e.status !== 'superseded')

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
const context = inferContext()
const preflight_warnings = []

// ---------------------------------------------------------------------------
// Phase 3b activation (RFC-002 Phase 3 / T7): arm the checkpoint marker
// whenever a recent bp-001-implementation-workflow violation exists,
// regardless of task_type. The SessionStart hook
// (hooks/em-recall-sessionstart.sh) does not pass --task-type, so a
// task-type-conditional arming path was inert in real sessions despite
// Phase 3b being deployed. bp-001 is workflow discipline that applies to
// any session that ends up writing files; checkpoint-gate itself only
// blocks write tools, so the false-positive surface is bounded.
// ---------------------------------------------------------------------------
if (shouldArmBp001Checkpoint(activeEntries, new Date())) {
  armCheckpointMarker(process.cwd())
}

// ---------------------------------------------------------------------------
// Task type: explicit flag wins; otherwise infer from branch tokens.
// `null` means task type is unclear → no task-type-scoped pre-flight runs
// (T3). Marker arming above is independent.
// ---------------------------------------------------------------------------
const taskType = taskTypeFlag || inferTaskType(context.branch_tokens)

// ---------------------------------------------------------------------------
// Violation pre-flight (RFC-002 Phase 3 / T1-T5) — task-type-scoped
// warnings for ranking and user-facing messaging.
// ---------------------------------------------------------------------------
if (taskType) {
  const patterns = loadPatternsIndex()
  const violationWarnings = runViolationPreflight(activeEntries, taskType, patterns)
  preflight_warnings.push(...violationWarnings)
}

// ---------------------------------------------------------------------------
// Pass 1: Project match
// ---------------------------------------------------------------------------
const pass1 = new Map()
if (context.project) {
  for (const e of activeEntries) {
    if (e.project === context.project) {
      const score = computeScore(e, 1.0)
      pass1.set(e.id, { entry: e, score })
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Tag match (using inverted index)
// ---------------------------------------------------------------------------
const pass2 = new Map()
if (context.effective_tokens.length > 0) {
  const normalizedTokens = normalizeTags(context.effective_tokens.join(','))

  // Load tags indexes
  const dirs = []
  if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
  if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)

  const matchingIds = new Set()
  let tagsIndexMissing = false

  for (const dir of dirs) {
    const idx = loadTagsIndex(dir)
    if (!idx) {
      tagsIndexMissing = true
      continue
    }
    for (const token of normalizedTokens) {
      if (idx[token]) {
        for (const id of idx[token]) matchingIds.add(id)
      }
    }
  }

  if (tagsIndexMissing) {
    // Fallback: linear scan
    preflight_warnings.push({ type: 'system', message: 'tags.json missing or corrupt in one or more stores. Run em-rebuild-index.mjs to regenerate.' })
    for (const e of activeEntries) {
      if (e.tags) {
        const eTags = e.tags.map(t => t.toLowerCase().trim())
        if (normalizedTokens.some(t => eTags.includes(t))) {
          matchingIds.add(e.id)
        }
      }
    }
  }

  for (const e of activeEntries) {
    if (matchingIds.has(e.id)) {
      const score = computeScore(e, 0.7)
      pass2.set(e.id, { entry: e, score })
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 3: Recent cross-project (last N days)
// ---------------------------------------------------------------------------
const pass3 = new Map()
if (days > 0) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  for (const e of activeEntries) {
    if (e.date >= cutoffStr) {
      const score = computeScore(e, 0.5)
      pass3.set(e.id, { entry: e, score })
    }
  }
}

// ---------------------------------------------------------------------------
// Merge: deduplicate by episode ID, keep highest score
// ---------------------------------------------------------------------------
const merged = new Map()
for (const pass of [pass1, pass2, pass3]) {
  for (const [id, { entry, score }] of pass) {
    if (!merged.has(id) || merged.get(id).score < score) {
      merged.set(id, { entry, score })
    }
  }
}

// Sort by score descending, apply limit
let results = [...merged.values()]
  .sort((a, b) => b.score - a.score)
  .slice(0, limit)

// ---------------------------------------------------------------------------
// Access tracking write-back
// ---------------------------------------------------------------------------
if (!noTrack && results.length > 0) {
  writeBackAccessTracking(results.map(r => r.entry))
}

// ---------------------------------------------------------------------------
// Prune suggestion (query-independent score, matching em-prune.mjs)
// ---------------------------------------------------------------------------
let prune_suggestion = null
const PRUNE_THRESHOLD = 0.15
let prunableCount = 0
for (const e of allEntries) {
  const pruneScore = computeScore(e, 1.0)
  if (pruneScore < PRUNE_THRESHOLD) prunableCount++
}
if (prunableCount > 0) {
  prune_suggestion = `${prunableCount} episodes below threshold. Run em-prune.mjs --dry-run to review.`
}

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------
const episodes = results.map(({ entry, score }) => {
  const { _dataDir, _source, ...rest } = entry
  return { ...rest, source: _source, score: Math.round(score * 1000) / 1000 }
})

const result = {
  status: 'ok',
  context: {
    project: context.project,
    branch_tokens: context.branch_tokens,
    effective_tokens: context.effective_tokens,
    task_type: taskType
  },
  count: episodes.length,
  episodes,
  preflight_warnings,
  prune_suggestion
}

// Performance health check
const elapsed = Date.now() - recallStart
if (elapsed > warnTimeMs) {
  preflight_warnings.push({ type: 'system', message: `Recall took ${elapsed}ms across ${totalEpisodeCount} episodes. Consider running em-prune.mjs to archive stale episodes.` })
}
if (totalEpisodeCount > warnCount) {
  preflight_warnings.push({ type: 'system', message: `${totalEpisodeCount} episodes in index. Performance may degrade. Run em-prune.mjs --dry-run to check for prunable episodes.` })
}

console.log(JSON.stringify(result))
