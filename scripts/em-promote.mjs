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
import { canonicalCategory, validateCategory } from './lib/categories.mjs'
import { illegalScalarChar } from './lib/activation.mjs'
import { resolveRegisteredStores } from './lib/registered-stores.mjs'
import { canonicalizePromotionSources, computeContentSha256, resolveSourceRefs, serializePromotionSources, validatePromotionSources } from './lib/promotion-sources.mjs'
import { tryAcquire, release } from './lib/lock.mjs'

export const PROMOTE_RUN_RECORD_TYPE = 'promote-run'
import { RUN_RECORD_CATEGORY } from './lib/activation-log.mjs'
const LOCK_BASENAME = 'clerk-apply.lock'
const LOCK_TIMEOUT_S = 30
const BREAK_APPLY_AFTER_PREVIEW = process.argv.includes('--break-apply-after-preview')

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
const migrate = argv.includes('--migrate')
const confirmed = new Set(argv.flatMap((a, i) => (a === '--confirm' && argv[i + 1] ? [argv[i + 1]] : [])))

export function computeSourceFingerprint(refs) {
  return crypto.createHash('sha256').update(serializePromotionSources(canonicalizePromotionSources(refs))).digest('hex')
}

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
    fingerprint: computeSourceFingerprint(c.promotion_sources),
    members: c.members.map(m => ({ id: m.id, project: m.project, summary: m.summary, stores: [...m.stores].sort() })),
  }
}

function recomputeSources(c) {
  // F3/F6: re-resolve stores AT the lock acquisition. A rebind, detach, or
  // store-id rotation between process selection and under-lock revalidation
  // changes the active_id — the OLD store_id no longer maps to any store in
  // `currentStores`, so the fingerprint over (store_id, episode_id, hash)
  // differs → refusal. Without this re-resolution the captured `stores`
  // snapshot would still resolve the old store_id and the file content
  // would still hash identically, letting the rebind sneak through.
  const currentStores = resolveRegisteredStores()
  const byStore = new Map(currentStores.map(s => [s.store_id, s]))
  const refs = []
  for (const ref of c.promotion_sources) {
    const store = byStore.get(ref.store_id)
    if (!store) return null
    const file = path.join(store.data_dir, 'episodes', `${ref.episode_id}.md`)
    let content
    try { content = fs.readFileSync(file) } catch { return null }
    const hash = computeContentSha256(content)
    if (hash !== ref.content_sha256) return null
    refs.push({ store_id: ref.store_id, episode_id: ref.episode_id, content_sha256: hash })
  }
  return canonicalizePromotionSources(refs)
}

// Migration variant: a migration candidate carries the same SourceRef[] shape
// on `.promotion_sources` as an apply candidate. We just route through the
// same recompute; the lock + fingerprint check is identical.
function recomputeSourcesForMigration(cand) {
  return recomputeSources({ promotion_sources: cand.promotion_sources })
}
function withStoreLockSync(dir, fn) {
  const lockFile = path.join(dir, LOCK_BASENAME)
  const deadline = Date.now() + LOCK_TIMEOUT_S * 1000
  let got
  while (!(got = tryAcquire(lockFile)).ok) {
    if (Date.now() >= deadline) return { error: 'lock-timeout' }
    const until = Date.now() + 100
    while (Date.now() < until) {}
  }
  try { return fn() } finally { release(got.handle) }
}

// REQ-15 (§12 states A-D): assisted, lock-guarded revision migration. Predicate
// is NEVER tag-alone (EC13) — every candidate requires category `lesson` AND
// global store AND tags include `promoted-lesson` AND tags include a
// `promoted:<sha8>` member AND status `active` AND a `## Sources` section
// parseable to ≥1 source line. A valid typed `promotion_sources` field marks
// an already-migrated successor, even if em-revise inherited the legacy tags
// and the preserved body; it is silently excluded before state C/D/B reasons.
// Malformed provenance does not qualify for this exclusion. Misses emit
// { hash, reason } with reason exactly `no-parseable-sources`, `not-global`,
// or `superseded`.
//
// P1-B/P1-D final-fold predicate order (kept deterministic, filters unrelated
// rows silently, and surfaces each state reason only for legacy-shaped rows):
//   (1) id — string check + dedupe (no state reason)
//   (2) category lesson — drops unrelated context/plain lessons silently
//   (3) legacy tags — promoted-lesson AND a promoted:<sha8> member
//   (3a) valid typed promotion_sources — already-migrated successor, silent
//        exclusion (malformed promotion_sources continues through legacy logic)
//   (4) data dir (state C) — non-global rows emit `not-global` even when they
//       lack a parseable Sources section (the absence of Sources is independent
//       of the store location; the state-C reason must NOT require Sources)
//   (5) status (state D) — superseded rows emit `superseded` even when they
//       lack a parseable Sources section (chain-already-handled semantics are
//       independent of body content; the state-D reason must NOT require Sources)
//   (6) parse Sources (state B) — no parseable Sources emits `no-parseable-sources`
//   (7) candidate — full predicate match (§12 state A)
export function selectMigrationCandidates(rows) {
  const candidates = []
  const skipped = []
  // Episode ids are NOT globally unique across independent stores — two
  // different projects can mint a same-id episode with different bytes (the
  // §8 "coincident id with different bytes stays two distinct members"
  // rule). Dedupe by `${dataDir}\0${id}` so a local row cannot shadow a
  // global same-id row and a global row cannot shadow a local same-id row.
  const seen = new Set()
  for (const row of rows) {
    if (typeof row.id !== 'string') continue
    const dataDirKey = typeof row._dataDir === 'string' ? row._dataDir : GLOBAL_DIR
    const seenKey = `${dataDirKey}\0${row.id}`
    if (seen.has(seenKey)) continue
    seen.add(seenKey)
    // (2) category lesson — drop unrelated rows silently.
    if (row.category !== 'lesson') continue
    // (3) legacy tags — promoted-lesson AND a promoted:<sha8> member.
    const tags = Array.isArray(row.tags) ? row.tags.map(String) : []
    if (!tags.includes(PROMOTED_TAG)) continue
    const hashTag = tags.find(t => typeof t === 'string' && t.startsWith(PROMOTED_HASH_TAG_PREFIX))
    if (!hashTag) continue
    // (3a) A successful typed migration is already complete. em-revise may
    // merge the predecessor's legacy tags and P2-C preserves its Sources
    // body, so provenance—not tag/body absence—is the migration marker.
    // Fail closed: malformed provenance is not treated as migrated.
    if (validatePromotionSources(row.promotion_sources).ok) continue
    // (4) data dir — state C. Fired BEFORE the parse-Sources check so a
    // local row with no Sources still emits `not-global` (the store location
    // is independent of the body's content).
    if (dataDirKey !== GLOBAL_DIR) { skipped.push({ hash: row.id, reason: 'not-global' }); continue }
    // (5) status — state D (§12: "status not active"). Fired BEFORE the
    // parse-Sources check so a superseded row with no Sources still emits
    // `superseded` (the chain-already-handled semantics are independent of
    // body content).
    if (row.status !== 'active') { skipped.push({ hash: row.id, reason: 'superseded' }); continue }
    // (6) parseable `## Sources` — state B. Only reached for global+active
    // legacy-shaped rows.
    let sources = []
    try {
      const text = fs.readFileSync(path.join(GLOBAL_DIR, 'episodes', `${row.id}.md`), 'utf8')
      if (!text.includes('## Sources')) { skipped.push({ hash: row.id, reason: 'no-parseable-sources' }); continue }
      for (const match of text.matchAll(/^- (\S+) \(([^,]+),/gm)) {
        const source = stores.flatMap(st => loadIndex(st.data_dir, st.label).filter(r => r.id === match[1]).map(r => ({ store_id: st.store_id, episode_id: r.id, content_sha256: computeContentSha256(fs.readFileSync(path.join(st.data_dir, 'episodes', `${r.id}.md`))) })))
        sources.push(...source)
      }
    } catch {}
    if (sources.length === 0) { skipped.push({ hash: row.id, reason: 'no-parseable-sources' }); continue }
    // (7) §12 state A: full match.
    candidates.push({ row, promotion_sources: canonicalizePromotionSources(sources), fingerprint: computeSourceFingerprint(sources) })
  }
  return { candidates, skipped }
}

// migrationRows — final-fold helper. Returns the deterministic union of the
// global index and every registered project store's index, each row tagged
// with `_dataDir` by loadIndex. Global rows come first so a local store cannot
// shadow an active global row of the same id (the seen-set dedupe inside
// selectMigrationCandidates keeps the result deterministic). Reused by BOTH
// the F6 knownSet guard AND the migrate branch so a confirmed-fingerprint
// check sees the same row set the migration selector will iterate.
function migrationRows() {
  const out = loadIndex(GLOBAL_DIR, 'global')
  for (const st of stores) {
    for (const r of loadIndex(st.data_dir, st.label)) out.push(r)
  }
  return out
}

// REQ-17/REQ-20: one promote-run record per apply/migrate run. GLOBAL-ONLY
// (B-3). §12 state D: a run where every candidate was refused still writes
// the record with zero counts; the refusals ARE the record. Atomic writer
// (temp + fsync + rename), validation-first, fail-closed on illegal chars.
// Under the same held lock: maintain index.jsonl, tags.json, category-index.json
// consistently. If secondary index maintenance cannot complete after the durable
// episode write, return success with `index_stale:true` (degrade-not-throw per
// F2; episode file is authoritative and a rebuild heals it).
function writePromoteRunRecord(runMeta) {
  if (!validateCategory(RUN_RECORD_CATEGORY).ok) return { error: 'run-record-global-only' }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 15)
  const id = `${stamp}-promote-run-${crypto.randomBytes(2).toString('hex')}`
  const summary = `Promote ${runMeta.mode} run`
  const body = JSON.stringify({ ...runMeta, ts: new Date().toISOString() })
  if ([id, summary].some(value => illegalScalarChar(value))) return { error: 'run-record-global-only' }
  return withStoreLockSync(GLOBAL_DIR, () => {
    const dir = path.join(GLOBAL_DIR, 'episodes'); fs.mkdirSync(dir, { recursive: true })
    const content = ['---', `id: ${id}`, `date: ${stamp.slice(0, 8)}`, `time: "${stamp.slice(9, 15)}"`, 'project: promote', `category: ${RUN_RECORD_CATEGORY}`, 'status: active', 'tags: []', `summary: ${summary}`, `record_type: ${PROMOTE_RUN_RECORD_TYPE}`, '---', '', body, ''].join('\n')
    const tmp = path.join(dir, `.${id}.tmp`); const fd = fs.openSync(tmp, 'w')
    try { fs.writeSync(fd, content); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, path.join(dir, `${id}.md`))
    const row = { id, date: stamp.slice(0, 8), time: stamp.slice(9, 15), project: 'promote', category: RUN_RECORD_CATEGORY, status: 'active', tags: [], summary, record_type: PROMOTE_RUN_RECORD_TYPE }
    // Episode file is durable. Maintain the secondary indexes under the SAME
    // held lock; on any maintenance failure degrade to index_stale:true rather
    // than throw (F2: degrade-not-throw, the file is authoritative).
    let indexStale = false
    try {
      fs.appendFileSync(path.join(GLOBAL_DIR, 'index.jsonl'), JSON.stringify(row) + '\n')
    } catch { indexStale = true }
    // tags.json + category-index.json: tmp+rename mirroring clerkWrite
    // (em-consolidate.mjs:1170-1197). Tags are always [] for the run-record,
    // but tags.json still needs the row's id-anchor under [] (degrades a
    // no-op write of `[]: []` if the tag list is empty).
    try {
      const tagsFile = path.join(GLOBAL_DIR, 'tags.json')
      let tagsIndex = Object.create(null)
      try { tagsIndex = JSON.parse(fs.readFileSync(tagsFile, 'utf8')) } catch {}
      for (const tag of row.tags) {
        if (!tagsIndex[tag]) tagsIndex[tag] = []
        if (!tagsIndex[tag].includes(id)) tagsIndex[tag].push(id)
      }
      fs.writeFileSync(tagsFile + '.tmp', JSON.stringify(tagsIndex, null, 2), 'utf8')
      fs.renameSync(tagsFile + '.tmp', tagsFile)
    } catch { indexStale = true }
    try {
      const catFile = path.join(GLOBAL_DIR, 'category-index.json')
      let catIndex = Object.create(null)
      try { catIndex = JSON.parse(fs.readFileSync(catFile, 'utf8')) } catch {}
      const key = RUN_RECORD_CATEGORY
      if (!catIndex[key]) catIndex[key] = []
      if (!catIndex[key].includes(id)) catIndex[key].push(id)
      fs.writeFileSync(catFile + '.tmp', JSON.stringify(catIndex, null, 2), 'utf8')
      fs.renameSync(catFile + '.tmp', catFile)
    } catch { indexStale = true }
    return indexStale ? { ok: true, id, index_stale: true } : { ok: true, id }
  })
}

// ---------------------------------------------------------------------------
// --migrate (REQ-15) and --apply: one global episode per fresh candidate,
// written via the sanctioned writers (em-store / em-revise subprocesses — never
// hand-written episode files). Spawn cwd is the GLOBAL dir (a neutral,
// non-project directory) and the scope is pinned global, so no project-local
// store can be resolved even under a regression (plan §7-C4).
//
// Order matters: --migrate runs BEFORE the --apply dry-run early exit, since
// `--migrate` alone (no `--apply`) is the operator's "show me what would
// happen" view and must reach the migration branch, not short-circuit into
// the apply-style dry-run output.
// ---------------------------------------------------------------------------
const EM_STORE = path.join(SCRIPT_DIR, 'em-store.mjs')
const EM_REVISE = path.join(SCRIPT_DIR, 'em-revise.mjs')

// F6 (P1-C final-fold): any confirmed value that does not match a known
// fingerprint is a hard refusal (the all-zeros-only taxonomy was a near-dead
// guard). The pre-final-fold guard was conditioned on `migrate || fresh.length
// > 0`, so a non-empty `--confirm` set against an empty selection was
// silently accepted (exit 0). The final-fold contract: ANY non-empty
// `--confirm` set is checked against the current known set, even when that
// set is empty — unknown confirmation exits 2 with `confirm-unknown-fingerprint`
// and writes nothing.
if (confirmed.size > 0) {
  const knownSet = migrate
    ? new Set(selectMigrationCandidates(migrationRows()).candidates.map(c => c.fingerprint))
    : new Set(fresh.map(c => computeSourceFingerprint(c.promotion_sources)))
  for (const fp of confirmed) {
    if (!knownSet.has(fp)) {
      console.log(JSON.stringify({ status: 'error', error: 'confirm-unknown-fingerprint', fingerprint: fp }))
      process.exit(2)
    }
  }
}

if (!apply && !migrate) {
  console.log(JSON.stringify({ status: 'ok', dry_run: true, min_sim: minSim, candidates: fresh.map(candidateReport), skipped, warnings, missing_sources: missingSources, ...(insufficientStores ? { note: 'needs >=2 registered stores (consumer registry lists ' + stores.length + ')' } : {}) }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// --migrate (REQ-15): assisted, lock-guarded revision migration. Each candidate
// takes the same per-candidate `--confirm <fingerprint>` + under-lock
// revalidation as REQ-16; the successor is written via EM_REVISE carrying the
// corrected --project and the typed --promotion-sources-json. Prior ids
// persist through the supersedes chain (P7). The run-record (mode 'migrate')
// captures one unified per-item list with the §12 source discriminator:
// `migrated` (state A), `apply-refused` (fingerprint-stale / break-flag), or
// `migration-skip` (state B/C/D).
// ---------------------------------------------------------------------------
if (migrate) {
  // P1-B/P1-D final-fold: pass the deterministic union via the migrationRows
  // helper (shared with the F6 knownSet guard above so a confirmed-fingerprint
  // check sees the same row set the migration selector will iterate).
  const { candidates: migCands, skipped: migSkipped } = selectMigrationCandidates(migrationRows())
  // Dry-run path: no --confirm given → list candidates and skipped, write
  // nothing. This is the operator's "show me what would happen" view.
  if (confirmed.size === 0) {
    console.log(JSON.stringify({
      status: 'ok',
      mode: 'migrate',
      dry_run: true,
      candidates: migCands.map(c => ({ id: c.row.id, fingerprint: c.fingerprint, project: c.row.project })),
      skipped: migSkipped,
      warnings,
      missing_sources: missingSources,
    }))
    process.exit(0)
  }
  // Per-item confirm set for migration: confirmed that match a candidate's fp
  // are processed; unconfirmed candidates are emitted as `migration-skip` with
  // reason `not-confirmed` (mirrors apply's `confirm-required` for the
  // migration surface so the run-record is the operational record even when
  // the operator omits the flag).
  const migFps = new Set(migCands.map(c => c.fingerprint))
  const tmpDirMig = fs.mkdtempSync(path.join(os.tmpdir(), 'em-migrate-'))
  const migrated = []
  const migItems = []
  let migAnyFailure = false
  try {
    for (const cand of migCands) {
      if (!confirmed.has(cand.fingerprint)) {
        migItems.push({ hash: cand.row.id, source: 'migration-skip', reason: 'not-confirmed' })
        continue
      }
      // Body for the migration successor (P2-C final-fold ACCEPT-WITH-MOD):
      // migration is a metadata upgrade, not a content erasure. The successor
      // body preserves the legacy lesson body — the typed promotion_sources
      // + corrected project ARE the semantic update, but active recall should
      // see the legacy lesson's prose in the successor, not a one-line marker.
      // The legacy episode file is read here (read-only) and its body
      // (everything after the second `---`) is appended to the typed header
      // in the successor. The legacy file remains immutable (P7); normal
      // search hides superseded predecessors, so a sentinel-preserved body
      // here is the active-recall surface.
      const bodyFileMig = path.join(tmpDirMig, `${cand.row.id}.md`)
      let legacyBodyMig = ''
      try {
        const legacyText = fs.readFileSync(path.join(GLOBAL_DIR, 'episodes', `${cand.row.id}.md`), 'utf8')
        const parts = legacyText.split('---')
        if (parts.length >= 3) legacyBodyMig = parts.slice(2).join('---').trim()
      } catch {}
      const successorBodyMig = [
        `Migration successor: typed promotion_sources + corrected project for ${cand.row.id}.`,
        '',
        '## Legacy lesson body (preserved)',
        '',
        legacyBodyMig || '(no legacy body available)',
      ].join('\n')
      fs.writeFileSync(bodyFileMig, successorBodyMig, 'utf8')
      const tagsMig = normalizeTags([PROMOTED_TAG])
      // The corrected project: prefer the candidate row's existing project if
      // it is meaningful, otherwise fall back to the first source's actual
      // project label (B-2 REQ-20: every promoted episode carries a real
      // per-project label; the legacy `cross-project` placeholder must be
      // replaced with the project of one of its source episodes).
      const correctedProject = (typeof cand.row.project === 'string' && cand.row.project && cand.row.project !== 'cross-project')
        ? cand.row.project
        : (() => {
            for (const ref of cand.promotion_sources) {
              const st = stores.find(s => s.store_id === ref.store_id)
              if (!st) continue
              const rows = loadIndex(st.data_dir, st.label)
              const r = rows.find(x => x.id === ref.episode_id)
              if (r && typeof r.project === 'string' && r.project) return r.project
            }
            return cand.row.project
          })()
      // F3: under-lock revalidation, EM_REVISE spawn, AND the duplicate-digest
      // recheck all share one serialization boundary. A second concurrent
      // migrate that overlaps acquires the lock AFTER the first releases and
      // observes the new successor in the index → refuses (F3).
      const held = withStoreLockSync(GLOBAL_DIR, () => {
        const freshRefs = recomputeSourcesForMigration(cand)
        if (!freshRefs || computeSourceFingerprint(freshRefs) !== cand.fingerprint) return { error: 'fingerprint-stale' }
        if (BREAK_APPLY_AFTER_PREVIEW) return { error: 'break-apply-after-preview' }
        // Re-check: a second overlapping migration may have already written
        // a successor for this candidate. The successor is a NEW id; the
        // original is still findable (P7). Surface as fingerprint-stale so
        // the operator re-runs with a fresh fingerprint.
        const liveMig = loadIndex(GLOBAL_DIR, 'global')
        for (const r of liveMig) {
          if (r.id === cand.row.id) continue
          if (r.status === 'superseded') continue
          if (r.supersedes !== cand.row.id) continue
          return { error: 'fingerprint-stale' }
        }
        const rMig = spawnSync(process.execPath, [
          EM_REVISE,
          '--original', cand.row.id,
          '--scope', 'global',
          '--project', correctedProject,
          '--category', 'lesson',
          '--tags', tagsMig.join(','),
          '--summary', `Recurring lesson: ${cand.row.summary}`,
          '--body-file', bodyFileMig,
          '--promotion-sources-json', serializePromotionSources(cand.promotion_sources),
        ], { cwd: GLOBAL_DIR, encoding: 'utf8' })
        let childMig = null
        try { childMig = JSON.parse(rMig.stdout) } catch {}
        if (rMig.status !== 0 || !childMig || childMig.status !== 'ok') {
          return { error: (childMig && childMig.message) || (rMig.stderr || rMig.stdout || '').trim().slice(0, 300) }
        }
        return { ok: true, successor: childMig.id, project: correctedProject }
      })
      if (held.error) {
        migAnyFailure = true
        migrated.push({ original: cand.row.id, error: held.error })
        migItems.push({ hash: cand.row.id, source: 'apply-refused', error: held.error })
        continue
      }
      migrated.push({ original: cand.row.id, successor: held.successor, project: held.project })
      migItems.push({ original: cand.row.id, successor: held.successor, project: held.project, source: 'migrated' })
    }
    // Migration §12 state D: every state B/C/D candidate + every state A
    // candidate (migrated or refused) lands in the unified per-item list.
    for (const sk of migSkipped) migItems.push({ hash: sk.hash, source: 'migration-skip', reason: sk.reason })
  } finally {
    try { fs.rmSync(tmpDirMig, { recursive: true, force: true }) } catch {}
  }
  // P1-A final-fold: exactly ONE run-record write per migrate invocation.
  // Capture the return so secondary-index degradation is surfaced
  // (`index_stale: true`); a writer error is surfaced loudly/non-zero
  // WITHOUT rolling back durable content writes (REQ-17 / §12 state C). The
  // episode file is authoritative; a rebuild heals the secondary indexes.
  let migRunRecordReturn = null
  if (migCands.length > 0 || migSkipped.length > 0) migRunRecordReturn = writePromoteRunRecord({ mode: 'migrate', items: migItems, confirmed: [...confirmed] })
  const migIndexStale = !!(migRunRecordReturn && migRunRecordReturn.index_stale)
  if (migRunRecordReturn && migRunRecordReturn.error) {
    migAnyFailure = true
    warnings.push({ problem: `run-record writer returned ${migRunRecordReturn.error}` })
  }
  console.log(JSON.stringify({
    status: migAnyFailure ? 'error' : 'ok',
    mode: 'migrate',
    dry_run: false,
    migrated,
    skipped: migSkipped,
    warnings,
    missing_sources: missingSources,
    ...(migRunRecordReturn && migRunRecordReturn.id ? { run_record_id: migRunRecordReturn.id } : {}),
    ...(migRunRecordReturn && migRunRecordReturn.error ? { run_record_error: migRunRecordReturn.error } : {}),
    ...(migIndexStale ? { index_stale: true } : {}),
  }))
  process.exit(migAnyFailure ? 1 : 0)
}

// ---------------------------------------------------------------------------
// --apply: per-candidate `--confirm <fingerprint>` + under-lock revalidation
// + EM_STORE write ALL share one serialization boundary (F3). The same lock
// is held across the recompute, the duplicate-digest recheck, the temp
// bodyFile write, AND the em-store spawn — so two concurrent applies cannot
// both pass the recompute and both write.
// ---------------------------------------------------------------------------
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
  const fp = computeSourceFingerprint(c.promotion_sources)
  // Static-taxonomy gap (final-fold P4): with multiple fresh candidates,
  // confirming one does NOT make every other fresh-but-unconfirmed candidate
  // stale. Those items are `confirm-required`; only a confirmed candidate
  // whose under-lock revalidation changes is `fingerprint-stale`. Per §A.5-S4:
  // "confirm-required" = candidate fresh but no `--confirm` names its fingerprint.
  if (!confirmed.has(fp)) { promoted.push({ hash: c.hash, fingerprint: fp, error: 'confirm-required' }); continue }
  // F3: hold the lock across recompute + duplicate-digest recheck +
  // bodyFile write + em-store spawn. Two concurrent applies overlap only
  // by waiting on the lock; the second observes the first's write and
  // refuses with `fingerprint-stale` (F3 stale confirmation).
  const bodyFile = path.join(tmpDir, `${c.hash}.md`)
  fs.writeFileSync(bodyFile, body, 'utf8')
  const held = withStoreLockSync(GLOBAL_DIR, () => {
    const current = recomputeSources(c)
    if (!current || computeSourceFingerprint(current) !== fp) return { error: 'fingerprint-stale' }
    if (BREAK_APPLY_AFTER_PREVIEW) return { error: 'break-apply-after-preview' }
    // Duplicate-digest recheck under the lock: a concurrent apply may have
    // written the same digest between this process's start and lock
    // acquisition. The fingerprint is the SAME (sources unchanged) but the
    // digest now exists → refuse with fingerprint-stale (stale confirmation).
    const liveIndex = loadIndex(GLOBAL_DIR, 'global')
    for (const r of liveIndex) {
      if (r.status === 'superseded') continue
      if (!Array.isArray(r.tags) || !r.tags.map(String).includes(PROMOTED_TAG)) continue
      const typed = validatePromotionSources(r.promotion_sources)
      if (!typed.ok) continue
      if (serializePromotionSources(canonicalizePromotionSources(r.promotion_sources)) === serializePromotionSources(current)) {
        return { error: 'fingerprint-stale' }
      }
    }
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
      return { error: (child && child.message) || (r.stderr || r.stdout || '').trim().slice(0, 300) }
    }
    return { ok: true, child }
  })
  if (held.error) { promoted.push({ hash: c.hash, fingerprint: fp, error: held.error }); continue }
  if (held.ok) promoted.push({ digest_id: held.child.id, hash: c.hash, ...(c.supersedes_promotion ? { supersedes_promotion: c.supersedes_promotion } : {}), members: c.members.map(m => ({ id: m.id, project: m.project })) })
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
const runRecordItemsApplied = promoted.map(item => item.error ? { ...item, source: 'apply-refused' } : { ...item, source: 'applied' })
// P1-A final-fold: exactly ONE run-record write per --apply invocation. The
// call is UNCONDITIONAL once we have reached this branch: any zero-candidate
// empty run still writes the record (the refusals ARE the operational
// record, §12 state D). Invalid-input exits (--min-sim range, etc.) happen
// above this point and write nothing. Capture the return so secondary-index
// degradation is surfaced (`index_stale: true`); a writer error is surfaced
// loudly/non-zero WITHOUT rolling back durable content writes (REQ-17 / §12
// state C). The episode file is authoritative; a rebuild heals the
// secondary indexes.
const runRecordReturn = writePromoteRunRecord({ mode: 'apply', items: runRecordItemsApplied, confirmed: [...confirmed] })
const indexStale = !!(runRecordReturn && runRecordReturn.index_stale)
if (runRecordReturn && runRecordReturn.error) {
  anyFailure = true
  warnings.push({ problem: `run-record writer returned ${runRecordReturn.error}` })
}

console.log(JSON.stringify({ status: anyFailure ? 'error' : 'ok', dry_run: false, min_sim: minSim, promoted, skipped, warnings, missing_sources: missingSources, ...(runRecordReturn && runRecordReturn.id ? { run_record_id: runRecordReturn.id } : {}), ...(runRecordReturn && runRecordReturn.error ? { run_record_error: runRecordReturn.error } : {}), ...(indexStale ? { index_stale: true } : {}), ...(insufficientStores ? { note: 'needs >=2 registered stores (consumer registry lists ' + stores.length + ')' } : {}) }))
process.exit(anyFailure ? 1 : 0)
