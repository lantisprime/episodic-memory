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
 * >=2 distinct member identities. Replicas (same id AND same normalized file bytes in
 * multiple stores — clone/fork stores) collapse to one member and are NOT
 * recurrence by themselves; a coincident id with DIFFERENT bytes stays two
 * distinct members (episode ids are not proven globally unique across
 * independent stores).
 *
 * Idempotency keys on typed SOURCE IDENTITY, never similarity (a digest is a
 * token superset of its members, so similarity dilutes as clusters grow).
 * Members bind `<episode_id>#<content_sha256>` and candidates bind the sorted
 * canonical SourceRefs written in `promotion_sources`. A matching ACTIVE
 * global typed promotion is skipped (`already-promoted`). A grown cluster
 * promotes with a `Supersedes-promotion:` human-readable back-reference.
 *
 * Legacy active promotions remain read-compatible: an unambiguous candidate
 * retains the old sorted `<id>#<sha8(summary)>` hash for exact idempotency,
 * while final `## Sources` bare ids support fail-safe strict-superset backrefs.
 * Typed identity remains authoritative for every new write. Malformed legacy
 * rows surface warnings and never block.
 *
 * Candidate ordering is deterministic: sorted by typed SourceRef hash.
 *
 * Outputs JSON: { status, dry_run, min_sim, candidates|promoted, skipped,
 * warnings, missing_sources, note? }. Exit 0; exit 1 when an --apply spawn failed; exit 2 on
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
import { canonicalizePromotionSources, computeContentSha256, resolveSourceRefs, serializePromotionSources, validatePromotionSources } from './lib/promotion-sources.mjs'

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
    usage: `node em-promote.mjs [--min-sim <0..1>] [--apply] — EXPERIMENTAL (promote-or-remove decision ${PROMOTE_DECISION_DATE}): detect lessons recurring across >=2 consumer-registry project stores; dry-run by default; --apply writes ONE global lesson episode per recurrence (tag ${PROMOTED_TAG}, typed promotion_sources provenance, and a human-readable ## Sources section); legacy promoted:<sha8> rows remain read-only-compatible; source stores are never written`,
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
const insufficientStores = stores.length < 2

const warnings = []
const missingSources = []

// Member identity binds the immutable episode bytes. Replicas collapse only
// when id and normalized-byte content hash both match.
const byKey = new Map() // key -> {id, summary, project, tags, tokens, stores: Set, storeShown: string}
for (const st of stores) {
  if (typeof st.store_id !== 'string') {
    warnings.push({ store: st.label, problem: `store identity unavailable${st.store_identity_error ? `: ${st.store_identity_error}` : ''}` })
    continue
  }
  const rows = loadIndex(st.data_dir, st.label)
  for (const r of rows) {
    if (r.status === 'superseded') continue
    if (typeof r.id !== 'string' || typeof r.summary !== 'string') continue
    if (canonicalCategory(r.category) !== 'lesson') continue
    let content
    try { content = fs.readFileSync(path.join(st.data_dir, 'episodes', `${r.id}.md`)) } catch {
      warnings.push({ episode: r.id, store: st.label, problem: 'episode file missing' })
      continue
    }
    const contentSha256 = computeContentSha256(content)
    const key = `${r.id}#${contentSha256}`
    const source = { store_id: st.store_id, episode_id: r.id, content_sha256: contentSha256 }
    if (byKey.has(key)) {
      const member = byKey.get(key)
      member.stores.add(st.data_dir)
      member.sources.push(source)
      continue
    }
    const body = bodyOf(content.toString('utf8'))
    byKey.set(key, {
      key,
      id: r.id,
      summary: r.summary,
      project: typeof r.project === 'string' ? r.project : path.basename(st.project_path),
      tags: Array.isArray(r.tags) ? r.tags : [],
      body,
      tokens: episodeTokens({ summary: r.summary, tags: r.tags, body }),
      stores: new Set([st.data_dir]),
      sources: [source],
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

// Candidate: recurrence must be INDEPENDENT presence, never explainable by
// replication (reviewer F1: a full store clone makes every member span both
// stores, so "spans >=2 stores" is satisfiable by copying alone). The
// predicate is a pair of DISTINCT member identities whose store-sets are
// DISJOINT — the two lessons never co-reside, so no replication of one store
// can account for both. Fail-safe direction: mixed replication shapes
// (lesson1 in {A,B}, lesson2 in {B}) are excluded even when a genuine
// recurrence might hide inside — a missed promotion is recoverable, a
// fabricated one pollutes global. Near-duplicates inside ONE store are
// em-consolidate's business, not promotion's.
const candidates = []
for (const cluster of byRoot.values()) {
  if (cluster.length < 2) continue
  let independent = false
  outer: for (let i = 0; i < cluster.length; i++) {
    for (let j = i + 1; j < cluster.length; j++) {
      let sharesStore = false
      for (const s of cluster[i].stores) if (cluster[j].stores.has(s)) { sharesStore = true; break }
      if (!sharesStore) { independent = true; break outer }
    }
  }
  if (!independent) continue
  const storeUnion = new Set(cluster.flatMap(m => [...m.stores]))
  cluster.sort((a, b) => a.id.localeCompare(b.id) || a.key.localeCompare(b.key))
  const promotionSources = canonicalizePromotionSources(cluster.flatMap(m => m.sources))
  // Transition-only compatibility identity: this is exactly the pre-S2
  // candidate hash input. New writes never serialize it as a tag.
  const legacyKeys = [...new Set(cluster.map(m => `${m.id}#${sha8(m.summary)}`))].sort()
  candidates.push({
    hash: sha8(serializePromotionSources(promotionSources)),
    legacy_hash: sha8(legacyKeys.join('\n')),
    members: cluster,
    store_dirs: [...storeUnion].sort(),
    promotion_sources: promotionSources,
  })
}
candidates.sort((a, b) => a.hash.localeCompare(b.hash))

// ---------------------------------------------------------------------------
// Existing promoted episodes: dedupe set + drift warnings + superset back-refs.
// ---------------------------------------------------------------------------
const HASH_TAG_RE = /^promoted:[0-9a-f]{8}$/
const globalRows = loadIndex(GLOBAL_DIR, 'global')
const existingByHashTag = new Map() // 'promoted:<sha8>' -> episode id
const existingSourceSets = []       // {id, representation:'typed'|'legacy', ids:Set<string>}
for (const r of globalRows) {
  if (r.status === 'superseded') continue
  const tags = Array.isArray(r.tags) ? r.tags.map(String) : []
  if (!tags.includes(PROMOTED_TAG)) continue
  const typed = validatePromotionSources(r.promotion_sources)
  if (typed.ok) {
    const canonical = canonicalizePromotionSources(r.promotion_sources)
    existingByHashTag.set(`typed:${serializePromotionSources(canonical)}`, r.id)
    const resolution = resolveSourceRefs(canonical, stores)
    missingSources.push(...resolution.missing)
    existingSourceSets.push({ id: r.id, representation: 'typed', ids: new Set(canonical.map(s => `${s.episode_id}#${s.content_sha256}`)) })
    continue
  }
  if (r.promotion_sources !== undefined) warnings.push({ episode: r.id, problem: `invalid promotion_sources: ${typed.error}` })
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
  // Reviewer F2: member excerpts are UNTRUSTED text composed above the real
  // Sources section — a body containing a literal "## Sources" line would
  // hijack a first-match parse and poison the superset back-ref with fake
  // ids. The REAL section is always composed LAST, so parse the final
  // segment; multiple headers are surfaced (write-side quoting below makes
  // them rare, but hand-written episodes stay possible).
  const segments = content.split(/^## Sources$/m)
  if (segments.length < 2) {
    warnings.push({ episode: r.id, problem: 'missing ## Sources section' })
    continue
  }
  if (segments.length > 2) {
    warnings.push({ episode: r.id, problem: `multiple ## Sources headers (${segments.length - 1}) — parsing the last` })
  }
  const srcSection = segments[segments.length - 1]
  const ids = new Set()
  let ambiguous = false
  for (const m of srcSection.matchAll(/^- (\S+) \(/gm)) {
    if (ids.has(m[1])) ambiguous = true
    ids.add(m[1])
  }
  if (ids.size === 0) warnings.push({ episode: r.id, problem: 'empty/malformed ## Sources list' })
  else existingSourceSets.push({ id: r.id, representation: 'legacy', ids, ambiguous })
}

const fresh = []
const skipped = []
for (const c of candidates) {
  const typedKey = `typed:${serializePromotionSources(c.promotion_sources)}`
  const typedExisting = existingByHashTag.get(typedKey)
  if (typedExisting) {
    skipped.push({ hash: c.hash, reason: 'already-promoted', existing: typedExisting })
    continue
  }
  // Strict-superset of an already-promoted member set → defined disposition:
  // promote under the new typed hash, back-referencing the prior digest.
  const typedMemberIds = new Set(c.members.map(m => m.key))
  const bareMemberIds = new Set(c.members.map(m => m.id))
  // A bare legacy id cannot distinguish two independent same-id contents.
  // In that shape the weaker representation may neither suppress a typed
  // write nor fabricate a superset relationship.
  const legacyAmbiguous = bareMemberIds.size !== typedMemberIds.size
  if (!legacyAmbiguous) {
    const legacyExisting = existingByHashTag.get(`${PROMOTED_HASH_TAG_PREFIX}${c.legacy_hash}`)
    if (legacyExisting) {
      skipped.push({ hash: c.hash, reason: 'already-promoted', existing: legacyExisting })
      continue
    }
  }
  const prior = existingSourceSets.find(s => {
    const candidateIds = s.representation === 'typed' ? typedMemberIds : bareMemberIds
    if (s.representation === 'legacy' && (legacyAmbiguous || s.ambiguous)) return false
    return s.ids.size < candidateIds.size && [...s.ids].every(id => candidateIds.has(id))
  })
  if (prior) c.supersedes_promotion = prior.id
  fresh.push(c)
}

function candidateReport(c) {
  return {
    hash: c.hash,
    stores: c.store_dirs,
    ...(c.supersedes_promotion ? { supersedes_promotion: c.supersedes_promotion } : {}),
    promotion_sources: c.promotion_sources,
    members: c.members.map(m => ({ id: m.id, project: m.project, summary: m.summary, stores: [...m.stores].sort() })),
  }
}

if (!apply) {
  console.log(JSON.stringify({ status: 'ok', dry_run: true, min_sim: minSim, candidates: fresh.map(candidateReport), skipped, warnings, missing_sources: missingSources, ...(insufficientStores ? { note: 'needs >=2 registered stores (consumer registry lists ' + stores.length + ')' } : {}) }))
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
  // Reviewer F3: member tags are untrusted for the IDENTITY axis — a stray
  // promoted:* member tags are legacy identity and never ride a new digest.
  const tags = normalizeTags([
    ...c.members.flatMap(m => m.tags).filter(t => !String(t).startsWith(PROMOTED_HASH_TAG_PREFIX) && String(t) !== PROMOTED_TAG),
    PROMOTED_TAG,
  ])
  // Reviewer F2 (write side): excerpts and summaries are untrusted markdown —
  // quote any heading line so member text can never mint a section marker
  // (the read side additionally parses only the LAST ## Sources section).
  const quoteHeadings = (s) => s.replace(/^(#{1,6} ?)/gm, '> $1')
  const sections = c.members.map(m => {
    const excerpt = quoteHeadings(m.body.split('\n').slice(0, EXCERPT_MAX_LINES).join('\n').trim())
    return `## Member: ${quoteHeadings(m.summary)}\n\n(id: \`${m.id}\`, project: ${m.project}, stores: ${[...m.stores].sort().join(', ')})\n\n${excerpt}`
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
    '--project', newest.project,
    '--category', 'lesson',
    '--tags', tags.join(','),
    '--summary', summary,
    '--body-file', bodyFile,
    '--promotion-sources-json', serializePromotionSources(c.promotion_sources),
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

console.log(JSON.stringify({ status: 'ok', dry_run: false, min_sim: minSim, promoted, skipped, warnings, missing_sources: missingSources, ...(insufficientStores ? { note: 'needs >=2 registered stores (consumer registry lists ' + stores.length + ')' } : {}) }))
process.exit(anyFailure ? 1 : 0)
