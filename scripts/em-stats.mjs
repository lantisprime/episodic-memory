#!/usr/bin/env node
/**
 * em-stats.mjs — store analytics: what does memory actually hold?
 *
 * Usage:
 *   node em-stats.mjs [--scope local|global|all] [--top <n>]
 *
 * Per scope: episode totals (active/superseded/pinned), archived count,
 * category and project distributions, age buckets, top tags, access +
 * feedback aggregates, prunable estimate (same query-independent score and
 * threshold as em-prune), index-file presence/sizes, and date range.
 *
 * Read-only: never writes, never bumps access counters.
 *
 * Outputs JSON: { status, scopes: [...], totals }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadIndex, computeScore } from './lib/relevance.mjs'
import { canonicalCategory } from './lib/categories.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-stats.mjs', usage: 'node em-stats.mjs [--scope local|global|all] [--top <n>] — read-only store analytics (totals, categories, projects, age buckets, tags, access/feedback, prunable estimate)' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'all'
const top = parseInt(flag('--top') || '10', 10)

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}

// Same threshold em-prune uses for its dry-run suggestion.
const PRUNE_THRESHOLD = 0.15

function topN(counter, n) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }))
}

function fileInfo(dataDir, name) {
  const p = path.join(dataDir, name)
  try {
    const st = fs.statSync(p)
    return { present: true, bytes: st.size }
  } catch {
    return { present: false }
  }
}

function daysAgo(dateStr) {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)
}

function statsFor(dataDir, label) {
  const rows = loadIndex(dataDir, label)
  const active = rows.filter(r => r.status !== 'superseded')

  // Null-proto: keys are episode-derived (a tag named "constructor" would
  // otherwise tally onto Object.prototype's inherited function, issue #469)
  const byCategory = Object.create(null)
  const byProject = Object.create(null)
  const byTag = Object.create(null)
  const age = { last_7d: 0, last_30d: 0, last_90d: 0, last_year: 0, older: 0, undated: 0 }
  let pinned = 0
  let accessTotal = 0
  let neverAccessed = 0
  let feedbackPositive = 0
  let feedbackNegative = 0
  let prunable = 0
  let oldest = null
  let newest = null

  for (const r of rows) {
    const cat = canonicalCategory(r.category)
    byCategory[cat] = (byCategory[cat] || 0) + 1
    if (typeof r.project === 'string') byProject[r.project] = (byProject[r.project] || 0) + 1
    if (Array.isArray(r.tags)) for (const tag of r.tags) byTag[String(tag)] = (byTag[String(tag)] || 0) + 1
    if (r.pinned === true) pinned++

    const ac = r.access_count || 0
    accessTotal += ac
    if (ac === 0) neverAccessed++
    const fb = typeof r.feedback === 'number' ? r.feedback : 0
    if (fb > 0) feedbackPositive += fb
    else if (fb < 0) feedbackNegative += -fb

    const d = daysAgo(r.date)
    if (d === null) age.undated++
    else if (d <= 7) age.last_7d++
    else if (d <= 30) age.last_30d++
    else if (d <= 90) age.last_90d++
    else if (d <= 365) age.last_year++
    else age.older++

    if (typeof r.date === 'string') {
      if (oldest === null || r.date < oldest) oldest = r.date
      if (newest === null || r.date > newest) newest = r.date
    }

    // Query-independent relevance, mirroring em-prune's dry-run estimate.
    // Protection classes (pinned, evidence links, ...) are em-prune's job;
    // this is the "worth a look" number, and pinned rows are excluded since
    // they can never be pruned.
    if (r.pinned !== true && computeScore(r, 1.0) < PRUNE_THRESHOLD) prunable++
  }

  let archived = 0
  try {
    archived = fs.readFileSync(path.join(dataDir, 'archived-index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length
  } catch {}

  return {
    scope: label,
    dir: dataDir,
    episodes: { total: rows.length, active: active.length, superseded: rows.length - active.length, pinned },
    archived,
    by_category: byCategory,
    top_projects: topN(byProject, top),
    top_tags: topN(byTag, top),
    age_buckets: age,
    access: { total: accessTotal, never_accessed: neverAccessed },
    feedback: { positive: feedbackPositive, negative: feedbackNegative, net: feedbackPositive - feedbackNegative },
    prunable_estimate: prunable,
    date_range: { oldest, newest },
    index_files: {
      'index.jsonl': fileInfo(dataDir, 'index.jsonl'),
      'tags.json': fileInfo(dataDir, 'tags.json'),
      'category-index.json': fileInfo(dataDir, 'category-index.json'),
      'tokens.json': fileInfo(dataDir, 'tokens.json'),
    },
  }
}

const scopes = []
if (scope === 'local' || scope === 'all') scopes.push(statsFor(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') scopes.push(statsFor(GLOBAL_DIR, 'global'))

const totals = {
  episodes: scopes.reduce((n, s) => n + s.episodes.total, 0),
  active: scopes.reduce((n, s) => n + s.episodes.active, 0),
  pinned: scopes.reduce((n, s) => n + s.episodes.pinned, 0),
  archived: scopes.reduce((n, s) => n + s.archived, 0),
  prunable_estimate: scopes.reduce((n, s) => n + s.prunable_estimate, 0),
}

console.log(JSON.stringify({ status: 'ok', scopes, totals }))
