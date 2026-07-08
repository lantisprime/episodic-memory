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
import { resolveLocalDir, resolveRepoRoot } from './lib/local-dir.mjs'
import {
  normalizeTags, loadTagsIndex, loadIndex,
  computeScore, writeBackAccessTracking
} from './lib/relevance.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()
const REPO_ROOT = resolveRepoRoot()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-recall.mjs', usage: 'node em-recall.mjs [--project <name>] [--scope local|global|all] [--limit <n>] [--days <n>] [--no-track] [--task-type implementation|push|rule|general] [--warn-time-ms <n>] [--warn-count <n>]' }))
  process.exit(0)
}

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
const warnCount = parseInt(flag('--warn-count') || '5000', 10)
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

// ---------------------------------------------------------------------------
// RFC-008 P3d (F38/F60): em-recall is the memory SUBSTRATE and carries ZERO
// enforcement awareness. The stop-gate decision handler, the SessionStart
// side-effect mode (baseline write, orphan sweeps, bp-001 advisory), and all
// enforcement-state reads that previously lived here were DELETED and relocated
// to the enforcement layer (scripts/enforce-contract.mjs — the stop decision in
// P3b-1, the SessionStart side-effects + advisory in P3d). The enforcement hooks
// now invoke enforce-contract directly. This script is pure recall.
// ---------------------------------------------------------------------------

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

// Retrieval primitives (normalizeTags, loadTagsIndex, loadIndex, computeScore,
// writeBackAccessTracking) are shared with em-search.mjs via lib/relevance.mjs
// — the former SYNC: blocks, now a single source.

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

// Resolve the project name for recall-output filtering. Precedence: --project
// override → <projectRoot>/package.json `name` → `git remote get-url origin`
// basename (subprocess cwd = projectRoot) → path.basename(projectRoot).
function resolveProjectName(projectRoot) {
  if (projectOverride) return projectOverride

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    if (pkg.name && pkg.name.trim()) return pkg.name.trim()
  } catch {}

  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/) || remoteUrl.match(/:([^/]+?)(?:\.git)?$/)
    if (match) return match[1]
  } catch {}

  return path.basename(projectRoot)
}

// ---------------------------------------------------------------------------
// Context inference
// ---------------------------------------------------------------------------
function inferContext() {
  const ctx = { project: null, branch_tokens: [], keywords: [], effective_tokens: [] }

  // Always read REPO_ROOT/package.json for keywords (independent of project resolution).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    if (Array.isArray(pkg.keywords)) ctx.keywords = pkg.keywords.map(k => k.toLowerCase().trim()).filter(Boolean)
  } catch {}

  // Project name resolution — root-bound, honors --project override here (recall
  // output filtering is the intended override contract). Arming path uses
  // ignoreOverride:true at the dedicated call site.
  ctx.project = resolveProjectName(REPO_ROOT)

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
// Context inference for the recall output.
// ---------------------------------------------------------------------------
const context = inferContext()
const preflight_warnings = []

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

  // Pass 2b: summary token match. Branch/keyword tokens rarely coincide with
  // stored tags verbatim, so episodes whose SUMMARY mentions the topic were
  // invisible to pass 2. Weighted 0.6 — below an exact tag hit (0.7), above
  // recency-only (0.5). Merge keeps the higher score when both passes hit.
  for (const e of activeEntries) {
    if (pass2.has(e.id)) continue
    const summaryLower = (e.summary || '').toLowerCase()
    if (summaryLower && normalizedTokens.some(t => summaryLower.includes(t))) {
      const score = computeScore(e, 0.6)
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

// Pending auto-capture drafts (wave-6 #2): a pure memory-side COUNT of
// ~/.episodic-memory/drafts/*.json. Drafts are not episodes and never enter
// ranking; this count only nudges the session to run `em-capture list`.
let pending_drafts = 0
try {
  pending_drafts = fs.readdirSync(path.join(os.homedir(), '.episodic-memory', 'drafts'))
    .filter(f => f.endsWith('.json')).length
} catch { /* no drafts dir yet */ }

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
  pending_drafts,
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
