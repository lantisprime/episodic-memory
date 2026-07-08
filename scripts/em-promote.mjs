#!/usr/bin/env node
/**
 * em-promote.mjs — EXPERIMENTAL cross-project recurring-lesson promotion.
 *
 * Learning strategy (CAPABILITIES.md: derives new knowledge from episodes and
 * writes it back as global episodes) shipped under the EXPERIMENTAL tier:
 * explicit opt-in command, dry-run by default, declared side effects (writes
 * GLOBAL episodes only, via the em-store subprocess; never touches a project
 * store), promote-or-remove decision date 2026-10-08.
 *
 * Usage:
 *   node em-promote.mjs [--min-sim <0..1>] [--apply]
 *
 * Scans every consumer-registry store (~/.episodic-memory/installs.json,
 * resolved via scripts/lib/registered-stores.mjs) for active `lesson`
 * episodes; clusters them by token-set Jaccard (episodeTokens over
 * summary+tags+body — the same vocabulary em-consolidate uses); a cluster is
 * a promotion candidate only when it spans >=2 DISTINCT project stores with
 * >=2 distinct member identities. Replicas (same id AND same summary in
 * multiple stores — clone/fork stores) collapse to one member and are NOT
 * recurrence by themselves; a coincident id with DIFFERENT content stays two
 * distinct members (episode ids are not proven globally unique across
 * independent stores).
 *
 * Idempotency keys on SOURCE IDENTITY, never similarity (a digest is a token
 * superset of its members, so similarity dilutes as clusters grow): each
 * member's key is `<id>#<sha8(summary)>` (stable — episode files are
 * immutable; revisions mint new ids), and the candidate hash is
 * sha8 over the newline-joined sorted key list, carried as a `promoted:<sha8>`
 * tag on the written episode. A candidate whose hash tag already exists on an
 * ACTIVE global episode is skipped (`already-promoted`). A grown cluster
 * (strict superset of an already-promoted member set) promotes under its new
 * hash with a `Supersedes-promotion:` back-reference in its Sources.
 *
 * Drift detection: existing active `promoted-lesson` episodes with a
 * malformed hash tag or an absent/malformed `## Sources` section are reported
 * in `warnings` (correction flows through em-revise; never blocks).
 *
 * Candidate ordering is deterministic: sorted by promoted-hash ascending.
 *
 * Outputs JSON: { status, dry_run, min_sim, candidates|promoted, skipped,
 * warnings, note? }. Exit 0; exit 1 when an --apply spawn failed; exit 2 on
 * usage errors.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { loadIndex, episodeTokens, normalizeTags } from './lib/relevance.mjs'
import { canonicalCategory } from './lib/categories.mjs'
import { resolveRegisteredStores } from './lib/registered-stores.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

export const PROMOTED_TAG = 'promoted-lesson'
export const PROMOTED_HASH_TAG_PREFIX = 'promoted:'
export const PROMOTE_MIN_SIM_DEFAULT = 0.35
export const PROMOTE_DECISION_DATE = '2026-10-08'
const EXCERPT_MAX_LINES = 40

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({
    status: 'help',
    script: 'em-promote.mjs',
    tier: 'EXPERIMENTAL',
    decision_date: PROMOTE_DECISION_DATE,
    usage: `node em-promote.mjs [--min-sim <0..1>] [--apply] — EXPERIMENTAL (promote-or-remove decision ${PROMOTE_DECISION_DATE}): detect lessons recurring across >=2 consumer-registry project stores; dry-run by default; --apply writes ONE global lesson episode per recurrence (tags ${PROMOTED_TAG} + ${PROMOTED_HASH_TAG_PREFIX}<sha8>, body carries a ## Sources section); source stores are never written`,
  }))
  process.exit(0)
}

function flagValue(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const minSim = parseFloat(flagValue('--min-sim') || String(PROMOTE_MIN_SIM_DEFAULT))
const apply = argv.includes('--apply')

if (!(minSim > 0 && minSim <= 1)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --min-sim "${flagValue('--min-sim')}". Must be in (0, 1].` }))
  process.exit(2)
}

function sha8(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8)
}

function bodyOf(content) {
  const parts = content.split('---')
  return parts.length >= 3 ? parts.slice(2).join('---').trim() : content.trim()
}

function jaccard(a, b) {
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const tok of small) if (large.has(tok)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// ---------------------------------------------------------------------------
// Gather candidate members from every registered store (read-only).
// ---------------------------------------------------------------------------
const stores = resolveRegisteredStores()
if (stores.length < 2) {
  console.log(JSON.stringify({ status: 'ok', dry_run: !apply, min_sim: minSim, candidates: [], skipped: [], warnings: [], note: 'needs >=2 registered stores (consumer registry lists ' + stores.length + ')' }))
  process.exit(0)
}

// memberKey `<id>#<sha8(summary)>` collapses replicas (same id + same summary)
// while keeping coincident-id-different-content rows distinct.
const byKey = new Map() // key -> {id, summary, project, tags, tokens, stores: Set, storeShown: string}
for (const st of stores) {
  const rows = loadIndex(st.data_dir, st.label)
  for (const r of rows) {
    if (r.status === 'superseded') continue
    if (typeof r.id !== 'string' || typeof r.summary !== 'string') continue
    if (canonicalCategory(r.category) !== 'lesson') continue
    const key = `${r.id}#${sha8(r.summary)}`
    if (byKey.has(key)) {
      byKey.get(key).stores.add(st.data_dir)
      continue
    }
    let body = ''
    try { body = bodyOf(fs.readFileSync(path.join(st.data_dir, 'episodes', `${r.id}.md`), 'utf8')) } catch {}
    byKey.set(key, {
      key,
      id: r.id,
      summary: r.summary,
      project: typeof r.project === 'string' ? r.project : path.basename(st.project_path),
      tags: Array.isArray(r.tags) ? r.tags : [],
      body,
      tokens: episodeTokens({ summary: r.summary, tags: r.tags, body }),
      stores: new Set([st.data_dir]),
    })
  }
}

// ---------------------------------------------------------------------------
// Cluster (union-find over Jaccard >= --min-sim).
// ---------------------------------------------------------------------------
const members = [...byKey.values()]
const parent = new Map(members.map(m => [m.key, m.key]))
const find = (x) => {
  while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) }
  return x
}
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
for (let i = 0; i < members.length; i++) {
  for (let j = i + 1; j < members.length; j++) {
    if (jaccard(members[i].tokens, members[j].tokens) >= minSim) union(members[i].key, members[j].key)
  }
}
const byRoot = new Map()
for (const m of members) {
  const root = find(m.key)
  if (!byRoot.has(root)) byRoot.set(root, [])
  byRoot.get(root).push(m)
}

// Candidate: >=2 distinct member identities spanning >=2 distinct stores.
// A lone replica (one identity present in two stores) is clone-store noise,
// not recurrence; two near-identical lessons inside ONE store are
// em-consolidate's business, not promotion's.
const candidates = []
for (const cluster of byRoot.values()) {
  if (cluster.length < 2) continue
  const storeUnion = new Set(cluster.flatMap(m => [...m.stores]))
  if (storeUnion.size < 2) continue
  cluster.sort((a, b) => a.id.localeCompare(b.id) || a.key.localeCompare(b.key))
  const keys = cluster.map(m => m.key).sort()
  candidates.push({
    hash: sha8(keys.join('\n')),
    members: cluster,
    store_dirs: [...storeUnion].sort(),
  })
}
candidates.sort((a, b) => a.hash.localeCompare(b.hash))

// ---------------------------------------------------------------------------
// Existing promoted episodes: dedupe set + drift warnings + superset back-refs.
// ---------------------------------------------------------------------------
const HASH_TAG_RE = /^promoted:[0-9a-f]{8}$/
const globalRows = loadIndex(GLOBAL_DIR, 'global')
const existingByHashTag = new Map() // 'promoted:<sha8>' -> episode id
const existingSourceSets = []       // {id, ids: Set<member episode id>}
const warnings = []
for (const r of globalRows) {
  if (r.status === 'superseded') continue
  const tags = Array.isArray(r.tags) ? r.tags.map(String) : []
  if (!tags.includes(PROMOTED_TAG)) continue
  const hashTags = tags.filter(t => t.startsWith(PROMOTED_HASH_TAG_PREFIX))
  for (const ht of hashTags) {
    if (HASH_TAG_RE.test(ht)) existingByHashTag.set(ht, r.id)
    else warnings.push({ episode: r.id, problem: `malformed hash tag "${ht}"` })
  }
  if (hashTags.length === 0) warnings.push({ episode: r.id, problem: 'promoted-lesson episode without a promoted:<sha8> tag' })
  let content = null
  try { content = fs.readFileSync(path.join(GLOBAL_DIR, 'episodes', `${r.id}.md`), 'utf8') } catch {}
  if (content === null) {
    warnings.push({ episode: r.id, problem: 'episode file missing' })
    continue
  }
  const srcSection = content.split(/^## Sources$/m)[1]
  if (typeof srcSection !== 'string') {
    warnings.push({ episode: r.id, problem: 'missing ## Sources section' })
    continue
  }
  const ids = new Set()
  for (const m of srcSection.matchAll(/^- (\S+) \(/gm)) ids.add(m[1])
  if (ids.size === 0) warnings.push({ episode: r.id, problem: 'empty/malformed ## Sources list' })
  else existingSourceSets.push({ id: r.id, ids })
}

const fresh = []
const skipped = []
for (const c of candidates) {
  const tag = `${PROMOTED_HASH_TAG_PREFIX}${c.hash}`
  const existing = existingByHashTag.get(tag)
  if (existing) {
    skipped.push({ hash: c.hash, reason: 'already-promoted', existing })
    continue
  }
  // Strict-superset of an already-promoted member set → defined disposition:
  // promote under the new hash, back-referencing the prior digest.
  const memberIds = new Set(c.members.map(m => m.id))
  const prior = existingSourceSets.find(s =>
    s.ids.size < memberIds.size && [...s.ids].every(id => memberIds.has(id)))
  if (prior) c.supersedes_promotion = prior.id
  fresh.push(c)
}

function candidateReport(c) {
  return {
    hash: c.hash,
    stores: c.store_dirs,
    ...(c.supersedes_promotion ? { supersedes_promotion: c.supersedes_promotion } : {}),
    members: c.members.map(m => ({ id: m.id, project: m.project, summary: m.summary, stores: [...m.stores].sort() })),
  }
}

if (!apply) {
  console.log(JSON.stringify({ status: 'ok', dry_run: true, min_sim: minSim, candidates: fresh.map(candidateReport), skipped, warnings }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// --apply: one global episode per fresh candidate, written via the sanctioned
// writer (em-store subprocess — never hand-written episode files). Spawn cwd
// is the GLOBAL dir (a neutral, non-project directory) and the scope is
// pinned global, so no project-local store can be resolved even under a
// regression (plan §7-C4).
// ---------------------------------------------------------------------------
const EM_STORE = path.join(SCRIPT_DIR, 'em-store.mjs')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-promote-'))
const promoted = []
let anyFailure = false
const today = new Date().toISOString().slice(0, 10)

for (const c of fresh) {
  const newest = c.members[c.members.length - 1]
  const summary = `Recurring lesson: ${newest.summary}`
  const tags = normalizeTags([
    ...c.members.flatMap(m => m.tags),
    PROMOTED_TAG,
    `${PROMOTED_HASH_TAG_PREFIX}${c.hash}`,
  ])
  const sections = c.members.map(m => {
    const excerpt = m.body.split('\n').slice(0, EXCERPT_MAX_LINES).join('\n').trim()
    return `## ${m.summary}\n\n(id: \`${m.id}\`, project: ${m.project}, stores: ${[...m.stores].sort().join(', ')})\n\n${excerpt}`
  })
  const sourceLines = c.members.map(m => `- ${m.id} (${m.project}, ${[...m.stores].sort().join(', ')})`)
  if (c.supersedes_promotion) sourceLines.push(`- Supersedes-promotion: ${c.supersedes_promotion}`)
  const body = [
    `Recurring lesson promoted from ${c.store_dirs.length} project stores (em-promote, ${today}).`,
    ...sections,
    '## Sources\n' + sourceLines.join('\n'),
  ].join('\n\n')
  const bodyFile = path.join(tmpDir, `${c.hash}.md`)
  fs.writeFileSync(bodyFile, body, 'utf8')
  const r = spawnSync(process.execPath, [
    EM_STORE,
    '--scope', 'global',
    '--project', 'cross-project',
    '--category', 'lesson',
    '--tags', tags.join(','),
    '--summary', summary,
    '--body-file', bodyFile,
  ], { cwd: GLOBAL_DIR, encoding: 'utf8' })
  let child = null
  try { child = JSON.parse(r.stdout) } catch {}
  if (r.status !== 0 || !child || child.status !== 'ok') {
    anyFailure = true
    promoted.push({ hash: c.hash, error: (child && child.message) || (r.stderr || r.stdout || '').trim().slice(0, 300) })
    continue
  }
  promoted.push({ digest_id: child.id, hash: c.hash, ...(c.supersedes_promotion ? { supersedes_promotion: c.supersedes_promotion } : {}), members: c.members.map(m => ({ id: m.id, project: m.project })) })
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

console.log(JSON.stringify({ status: 'ok', dry_run: false, min_sim: minSim, promoted, skipped, warnings }))
process.exit(anyFailure ? 1 : 0)
