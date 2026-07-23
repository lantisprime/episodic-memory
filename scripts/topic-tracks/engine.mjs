// scripts/topic-tracks/engine.mjs — pure engine for em-topic-tracks.mjs
// (NAPMEM-C S2). Implements the §8 and §12 contract; the thin CLI is
// scripts/em-topic-tracks.mjs. Spawns scripts/em-store.mjs as the sole
// writer (no direct episode/index/tag/lock writer of its own). Zero
// external deps; Node stdlib only.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { normalizeTags, tokenizeQuery } from '../lib/relevance.mjs'
import { loadCategories, canonicalCategory } from '../lib/categories.mjs'
import {
  computeContentSha256,
  serializePromotionSources,
  canonicalizePromotionSources,
  validatePromotionSources,
} from '../lib/promotion-sources.mjs'
import { resolveRegisteredStores } from '../lib/registered-stores.mjs'
import {
  acquireStoreWriteLocksSync,
  releaseStoreWriteLocks,
} from '../lib/store-write-lock.mjs'

// --- §A.5 frozen constants ---
export const TOPIC_TRACK_TAG = 'topic-track'
export const TOPIC_TRACKS_CONFIG_VERSION = '1.0.0'
export const TOPIC_TRACKS_CONFIG_PATH = new URL('./config.json', import.meta.url)
export const TOPIC_TRACKS_CONFIG_ENV = 'EM_TOPIC_TRACKS_CONFIG_PATH'
export const GLOBAL_STORE_ID = 'global'

// SCRIPT_DIR: scripts/ (engine lives at scripts/topic-tracks/engine.mjs).
const SCRIPT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EM_STORE = path.join(SCRIPT_DIR, 'em-store.mjs')

// --- Three-line set-Jaccard helper (A.7 §2.1: inline only) ---
function jaccardSet(a, b) {
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const tok of small) if (large.has(tok)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// --- small config / error helpers ---
function makeError(code, extra) {
  const e = new Error(code)
  e.code = code
  if (extra) Object.assign(e, extra)
  return e
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

// --- §12 contract: loadTopicTracksConfig ---
//   valid    → frozen normalized object, read only
//   missing  → throws topic-tracks-config-unloadable
//   malformed→ throws topic-tracks-config-invalid
//   symlink  → throws topic-tracks-config-symlink
// Env override (EM_TOPIC_TRACKS_CONFIG_PATH) precedes argv pathOverride;
// absent both falls back to the committed scripts/topic-tracks/config.json.
export function loadTopicTracksConfig(pathOverride) {
  const fromEnv = process.env[TOPIC_TRACKS_CONFIG_ENV]
  const envPath = fromEnv && fromEnv.length ? fromEnv : null
  const defaultPath = fileURLToPath(TOPIC_TRACKS_CONFIG_PATH)
  const cfgPath = pathOverride || envPath || defaultPath

  let lstat
  try {
    lstat = fs.lstatSync(cfgPath)
  } catch (err) {
    throw makeError('topic-tracks-config-unloadable')
  }
  if (lstat.isSymbolicLink()) throw makeError('topic-tracks-config-symlink')
  if (!lstat.isFile()) throw makeError('topic-tracks-config-unloadable')

  let raw
  try {
    raw = fs.readFileSync(cfgPath, 'utf8')
  } catch (err) {
    throw makeError('topic-tracks-config-unloadable')
  }

  let doc
  try {
    doc = JSON.parse(raw)
  } catch (err) {
    throw makeError('topic-tracks-config-invalid')
  }
  if (!isPlainObject(doc)) throw makeError('topic-tracks-config-invalid')

  const required = [
    'version', 'tag_jaccard_min', 'summary_jaccard_min',
    'min_cluster', 'warn_episodes', 'max_episodes',
    'common_tag_support', 'source_categories',
  ]
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(doc, k)) {
      throw makeError('topic-tracks-config-invalid')
    }
  }
  for (const k of Object.keys(doc)) {
    if (!required.includes(k)) throw makeError('topic-tracks-config-invalid')
  }

  const frac = (v) => typeof v === 'number' && v > 0 && v <= 1
  const int = (v, min) => Number.isInteger(v) && v >= min

  if (typeof doc.version !== 'string' ||
      doc.version !== TOPIC_TRACKS_CONFIG_VERSION) {
    throw makeError('topic-tracks-config-invalid')
  }
  if (!frac(doc.tag_jaccard_min)) throw makeError('topic-tracks-config-invalid')
  if (!frac(doc.summary_jaccard_min)) throw makeError('topic-tracks-config-invalid')
  if (!int(doc.min_cluster, 3)) throw makeError('topic-tracks-config-invalid')
  if (!int(doc.warn_episodes, doc.min_cluster)) throw makeError('topic-tracks-config-invalid')
  if (!int(doc.max_episodes, doc.warn_episodes)) throw makeError('topic-tracks-config-invalid')
  if (!frac(doc.common_tag_support)) throw makeError('topic-tracks-config-invalid')
  if (!Array.isArray(doc.source_categories) || doc.source_categories.length === 0 ||
      !doc.source_categories.every(s => typeof s === 'string' && s.length > 0)) {
    throw makeError('topic-tracks-config-invalid')
  }
  const seen = new Set()
  for (const s of doc.source_categories) {
    if (seen.has(s)) throw makeError('topic-tracks-config-invalid')
    seen.add(s)
  }

  // Cross-check source_categories against the closed category vocab (REQ-2).
  // Degrade-not-throw: an unloadable vocab is an unresolved upstream state;
  // the config values are still REQ-2-conformant on their own.
  try {
    const valid = new Set(loadCategories().categories.map(c => canonicalCategory(c.name)))
    for (const s of doc.source_categories) {
      if (!valid.has(canonicalCategory(s))) throw makeError('topic-tracks-config-invalid')
    }
  } catch (err) {
    if (err && err.code === 'topic-tracks-config-invalid') throw err
    // vocab unloadable: degrade-not-throw — keep config
  }

  return Object.freeze({
    version: doc.version,
    tag_jaccard_min: doc.tag_jaccard_min,
    summary_jaccard_min: doc.summary_jaccard_min,
    min_cluster: doc.min_cluster,
    warn_episodes: doc.warn_episodes,
    max_episodes: doc.max_episodes,
    common_tag_support: doc.common_tag_support,
    source_categories: Object.freeze([...doc.source_categories].sort()),
  })
}

// --- Minimal JSONL index reader. Tolerates missing files (returns []). ---
function loadIndexRows(dataDir) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  let text
  try { text = fs.readFileSync(indexFile, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const entry = JSON.parse(trimmed)
      if (isPlainObject(entry)) out.push(entry)
    } catch { /* skip malformed lines */ }
  }
  return out
}

// Frontmatter/body splitter: a body-file episode has frontmatter in ---\n...\n---
// and the rest is body. Returns the body after the closing fence (or the
// whole content when no fences are present), then strips one immediate H1
// heading line that em-store emits before the real body.
function bodyOf(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
  // Anchor on the first line being exactly '---' followed by a closing fence
  // '\n---\n' later in the file. Use indexOf to skip intermediate '---' lines.
  if (!text.startsWith('---\n')) return text.trim()
  let end = text.indexOf('\n---\n', 4)
  if (end === -1) end = text.indexOf('\n---\r\n', 4)
  if (end === -1) {
    // Closing fence at EOF with no trailing newline.
    if (text.endsWith('\n---')) end = text.length - 4
    else return text.trim()
  }
  let body = text.slice(end + 5)
  // Strip the immediate H1 summary heading that standard em-store episodes
  // emit immediately after the frontmatter.
  body = body.replace(/^\s*# .*(?:\r?\n)?/, '')
  return body.trim()
}

// --- §12 contract: collectTopicMembers({globalDir, registeredStores, config}) ---
// eligible            → one content-bound member
// replica             → no second member, warning {problem:'replica-collapsed', ...}
// no identity         → no member, warning {problem:'store-identity-unavailable', ...}
// missing file        → no member, missing_sources row
// derived (carries    → no member
//   promotion_sources or 'topic-track' tag)
// ineligible          → no member (category/status/superseded)
export function collectTopicMembers({ globalDir, registeredStores, config }) {
  const warnings = []
  const missing_sources = []
  const members = []
  const replicaKeys = new Set()

  // Allowed category set: config.source_categories are validated against the
  // closed vocab at config load; here we canonicalize through canonicalCategory
  // (degrade-not-throw) and compare via the same key the row carries.
  let allowedCategories
  try {
    allowedCategories = new Set(config.source_categories.map(canonicalCategory))
  } catch {
    allowedCategories = new Set(config.source_categories)
  }

  function considerRow(row, storeId, storeDir, projectName) {
    // Ineligible filters.
    if (row.status === 'superseded') return
    if (row.status !== 'active') return
    const canonical = canonicalCategory(row.category)
    if (!allowedCategories.has(canonical)) return
    if (typeof row.id !== 'string' || row.id.length === 0) return
    if (typeof row.summary !== 'string') return

    // Derived-row exclusion.
    const tags = normalizeTags(row.tags)
    if (tags.includes(TOPIC_TRACK_TAG)) return
    if (Array.isArray(row.promotion_sources) && row.promotion_sources.length > 0) return

    // Episode file required (REQ-3 missing-file).
    const epFile = path.join(storeDir, 'episodes', `${row.id}.md`)
    let buf
    try {
      buf = fs.readFileSync(epFile)
    } catch (err) {
      missing_sources.push({ store_id: storeId, episode_id: row.id })
      return
    }
    const sha = computeContentSha256(buf)
    // Replica identity: episode id + normalized content hash (no store_id so
    // byte-identical replicas across stores collapse; §12 REQ-4).
    const key = `${row.id}#${sha}`

    // Replica collapse (REQ-4).
    if (replicaKeys.has(key)) {
      warnings.push({ problem: 'replica-collapsed', store_id: storeId, episode_id: row.id })
      return
    }
    replicaKeys.add(key)

    // Jaccard token set is SUMMARY ONLY per §12 REQ-5 (tokenizeQuery supplies
    // the closed zero-dependency relevance tokenizer; bodyOf + tag-derived
    // tokens are deliberately excluded to keep threshold semantics anchored
    // to the summary text the user wrote).
    const tokens = new Set(tokenizeQuery(row.summary))
    const body = bodyOf(buf)

    members.push({
      source: { store_id: storeId, episode_id: row.id, content_sha256: sha },
      store_dir: storeDir,
      project: typeof row.project === 'string' && row.project.length ? row.project : projectName,
      category: canonical,
      date: typeof row.date === 'string' ? row.date : '',
      summary: row.summary,
      tags,
      body,
      tokens,
    })
  }

  // Global store: reserved id 'global'. NON-creating read path — an absent
  // global directory is treated as an empty source (§A.7 S2 row 2.1; EC1
  // empty world + B6 dry-run creates a missing global directory).
  if (fs.existsSync(globalDir)) {
    const gReal = fs.realpathSync(globalDir)
    for (const r of loadIndexRows(gReal)) considerRow(r, GLOBAL_STORE_ID, gReal, 'global')
  }

  // Registered project stores: id resolved by the registry resolver. A store
  // without a resolvable store_id (legacy / unconfigured) is excluded with a
  // warning — never fabricated (REQ-3 missing-store-identity).
  for (const st of registeredStores) {
    if (typeof st.store_id !== 'string') {
      warnings.push({ problem: 'store-identity-unavailable', store_id: st.label || '' })
      continue
    }
    const projectName = path.basename(st.project_path) || st.label || 'project'
    for (const r of loadIndexRows(st.data_dir)) considerRow(r, st.store_id, st.data_dir, projectName)
  }

  return { members, warnings, missing_sources }
}

// --- Tags with majority support across a cluster ---
function tagMajority(members, supportMin) {
  const counts = new Map()
  for (const m of members) for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1)
  const out = []
  const thresh = Math.ceil(supportMin * members.length)
  for (const [tag, count] of counts) if (count >= thresh) out.push(tag)
  return out.sort()
}

// --- Lexical source-key (stable identity) ---
function srcKey(p) {
  return `${p.store_id}\0${p.episode_id}\0${p.content_sha256}`
}

// --- Connected-component clustering by (tag OR summary) Jaccard thresholds ---
function clusterMembers(members, config) {
  const parent = new Map(members.map(m => [m.key, m.key]))
  const find = (x) => {
    let cur = x
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)
      parent.set(cur, parent.get(next))
      cur = parent.get(cur)
    }
    return cur
  }
  const union = (a, b) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const tagSets = members.map(m => new Set(m.tags))

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const tagJ = jaccardSet(tagSets[i], tagSets[j])
      const sumJ = jaccardSet(members[i].tokens, members[j].tokens)
      if (tagJ >= config.tag_jaccard_min || sumJ >= config.summary_jaccard_min) {
        union(members[i].key, members[j].key)
      }
    }
  }

  const groups = new Map()
  for (const m of members) {
    const r = find(m.key)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(m)
  }
  return [...groups.values()].filter(g => g.length >= config.min_cluster)
}

// --- §12 contract: buildTopicCandidates(members, config) ---
//   below minimum       → absent
//   matched             → one deterministic candidate
//   over hard cap       → throws topic-tracks-max-episodes BEFORE pair loop
//   exact prior         → caller detects via scanTopicTracks (already-derived skip)
export function buildTopicCandidates(members, config) {
  // Hard-cap guard runs BEFORE pair construction (REQ-11). Pair iteration is
  // O(n²); refusing early protects against a hostile / runaway registry.
  if (members.length > config.max_episodes) {
    throw makeError('topic-tracks-max-episodes', {
      max_episodes: config.max_episodes,
      observed: members.length,
    })
  }

  const sorted = [...members].sort((a, b) => {
    const ka = srcKey(a.source)
    const kb = srcKey(b.source)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const keyed = sorted.map(m => ({ ...m, key: srcKey(m.source) }))
  const groups = clusterMembers(keyed, config)

  const candidates = []
  for (const grp of groups) {
    grp.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

    const commonTags = tagMajority(grp, config.common_tag_support)

    // Lexical winner among the most frequent real source projects (REQ-9).
    const projCounts = new Map()
    for (const m of grp) projCounts.set(m.project, (projCounts.get(m.project) || 0) + 1)
    let bestProject = null
    let bestCount = -1
    for (const [p, c] of projCounts) {
      if (c > bestCount || (c === bestCount && (bestProject === null || p < bestProject))) {
        bestProject = p
        bestCount = c
      }
    }

    // Sorted typed promotion sources (REQ-6 / §8.2 invariant).
    const promotion_sources = grp
      .map(m => ({ ...m.source }))
      .sort((a, b) => {
        const ka = srcKey(a), kb = srcKey(b)
        return ka < kb ? -1 : ka > kb ? 1 : 0
      })

    const fingerprint = computeTopicFingerprint(promotion_sources)

    // Chronological body: oldest first; ties broken by stable source key.
    const chrono = [...grp].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      const ka = a.key, kb = b.key
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    const bodyLines = chrono.map(m =>
      `- ${m.date} ${m.source.episode_id} (${m.source.store_id}): ${m.summary}\n  Body: ${m.body.replace(/\n/g, ' ').slice(0, 280)}`
    )
    const body =
      `Topic track: ${chrono.length} related source episodes across ${new Set(grp.map(m => m.project)).size} project(s).\n\n` +
      `Sources (chronological):\n${bodyLines.join('\n')}\n\n` +
      `Common tags: ${commonTags.join(', ') || '(none)'}\n` +
      `Fingerprint: ${fingerprint}\n`

    const summary = commonTags.length
      ? `Topic track: ${commonTags[0]} (${chrono.length} sources)`
      : `Topic track: ${chrono[0].summary.split(/\s+/).slice(0, 5).join(' ')} (${chrono.length} sources)`

    candidates.push({
      fingerprint,
      common_tags: commonTags,
      summary,
      body,
      promotion_sources,
      members: grp.map(m => ({
        store_id: m.source.store_id,
        episode_id: m.source.episode_id,
        project: m.project,
        category: m.category,
        date: m.date,
        summary: m.summary,
      })),
    })
  }

  candidates.sort((a, b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)
  return candidates
}

// --- Fingerprint: sha256(serializePromotionSources(canonicalize(...))) ---
export function computeTopicFingerprint(promotion_sources) {
  const canonical = canonicalizePromotionSources(promotion_sources)
  return crypto.createHash('sha256')
    .update(serializePromotionSources(canonical), 'utf8')
    .digest('hex')
}

// --- Resolve global store directory; NON-creating canonical read path. ---
// §A.7 S2 row 2.1: dry-run must not create directories. Returned path is the
// canonical realpath when the directory exists, or path.resolve(d) when it
// does not. The caller (scanTopicTracks / applyTopicTracks) decides whether
// to treat the absent case as empty-source (scan) or fail-closed (apply).
export function resolveGlobalDir({ globalDir } = {}) {
  const d = globalDir || path.join(os.homedir(), '.episodic-memory')
  try { return fs.realpathSync(d) } catch { return path.resolve(d) }
}

// --- Snapshot the global store's active topic-track lessons: keyed by the
// canonical promotion-source serialization. Used by both scan and apply to
// detect exact-prior idempotency. ---
function snapshotExistingTracks(globalDir) {
  const rows = loadIndexRows(globalDir).filter(r =>
    r.status === 'active' &&
    Array.isArray(r.tags) && r.tags.includes(TOPIC_TRACK_TAG)
  )
  const out = new Map()
  for (const r of rows) {
    const ps = r.promotion_sources
    if (!Array.isArray(ps) || ps.length === 0) continue
    const v = validatePromotionSources(ps)
    if (!v.ok) continue
    const ser = serializePromotionSources(canonicalizePromotionSources(ps))
    if (!out.has(ser)) out.set(ser, r.id)
  }
  return out
}

// --- Public: scanTopicTracks(context) → dry-run JSON (§12) ---
export function scanTopicTracks(context) {
  const config = context.config
  const globalDir = resolveGlobalDir({ globalDir: context.globalDir })

  // Resolve registered project stores via the canonical resolver; the global
  // store itself never reappears as a registered entry. Honor a caller-supplied
  // context.registeredStores (an array from the same canonical resolver) so
  // scan→apply share one truth source; otherwise call resolveRegisteredStores
  // directly — it returns the array, NOT an object with `.stores` (§A.7 S2
  // row 2.1 B7).
  const resolved = (context.registeredStores && Array.isArray(context.registeredStores))
    ? context.registeredStores
    : resolveRegisteredStores({ globalDir })
  const registeredStores = resolved.filter(s => s.data_dir !== globalDir)

  const { members, warnings, missing_sources } = collectTopicMembers({
    globalDir, registeredStores, config,
  })

  const warningsPlus = [...warnings]
  if (members.length > config.warn_episodes) {
    warningsPlus.push({ problem: 'warning-threshold-exceeded', count: members.length })
  }

  const candidates = buildTopicCandidates(members, config)

  // Exact-prior idempotency: any active global topic-track lesson whose
  // canonical promotion-source set equals a candidate's is reported as
  // `already-derived` and is NOT emitted as a fresh candidate (REQ-10).
  const skipped = []
  if (candidates.length > 0) {
    const live = snapshotExistingTracks(globalDir)
    const kept = []
    for (const cand of candidates) {
      const ser = serializePromotionSources(canonicalizePromotionSources(cand.promotion_sources))
      if (live.has(ser)) {
        skipped.push({
          fingerprint: cand.fingerprint,
          reason: 'already-derived',
          existing_episode_id: live.get(ser),
        })
      } else {
        kept.push(cand)
      }
    }
    candidates.length = 0
    for (const c of kept) candidates.push(c)
  }

  return {
    status: 'ok',
    dry_run: true,
    config: {
      tag_jaccard_min: config.tag_jaccard_min,
      summary_jaccard_min: config.summary_jaccard_min,
      min_cluster: config.min_cluster,
      warn_episodes: config.warn_episodes,
      max_episodes: config.max_episodes,
      common_tag_support: config.common_tag_support,
      source_categories: config.source_categories,
    },
    candidates,
    skipped,
    warnings: warningsPlus,
    missing_sources,
  }
}

// --- §12 contract: applyTopicTracks(context) → apply JSON ---
//   unconfirmed       → confirm-required (caller maps to error or unconfirmed list)
//   unknown/malformed → error, exit class 2 (CLI maps to confirm-unknown / -malformed)
//   duplicate         → error, exit class 2 (CLI maps to confirm-duplicate)
//   stale             → stale-fingerprint
//   lock timeout      → store-write-lock-timeout
//   exact prior       → already-derived (no write)
//   fresh             → {fingerprint, episode_id}
//   child failure     → store-write-failed
export function applyTopicTracks(context) {
  // Resolve globalDir and registeredStores ONCE before scan so scan and
  // apply share one truth source (the lock acquisition + under-lock source
  // reads below must use the same canonical pair scan just observed).
  // resolveRegisteredStores returns an ARRAY, not an object with `.stores`
  // (§A.7 S2 row 2.1 B7).
  const globalDir = resolveGlobalDir({ globalDir: context.globalDir })
  const config = context.config
  const resolved = (context.registeredStores && Array.isArray(context.registeredStores))
    ? context.registeredStores
    : resolveRegisteredStores({ globalDir })
  const registeredStores = resolved.filter(s => s.data_dir !== globalDir)
  // Trust a caller-supplied preview; otherwise perform the single scan here.
  const preview = context.preview && context.preview.status === 'ok' && context.preview.dry_run
    ? context.preview
    : scanTopicTracks({ config, globalDir, registeredStores })
  const confirmed = context.confirmed instanceof Set
    ? context.confirmed
    : new Set(context.confirmed || [])

  const written = []
  const unconfirmed = []
  const applySkipped = [...preview.skipped]
  const applyWarnings = [...preview.warnings]
  const applyMissing = [...preview.missing_sources]
  // ONE explicit store_id -> canonical data_dir map, used for lock acquisition
  // AND under-lock source reads so a basename-based lookup cannot defeat typed
  // identity (§A.7 S2 row 2.1 B8).
  const storeDirByStoreId = new Map()
  for (const s of registeredStores) {
    if (typeof s.store_id === 'string' && s.store_id.length > 0) {
      storeDirByStoreId.set(s.store_id, s.data_dir)
    }
  }

  for (const c of preview.candidates) {
    if (!confirmed.has(c.fingerprint)) {
      unconfirmed.push(c.fingerprint)
      continue
    }

    // Resolve the canonical data dirs represented by this candidate's
    // promotion sources (REQ-8: lock every involved store, in canonical
    // sorted order, before any read or write). An unresolved store_id
    // surfaces as store-write-failed under lock (never fabricated).
    const storeDirs = new Set()
    let unresolvedStore = null
    for (const src of c.promotion_sources) {
      const dir = src.store_id === GLOBAL_STORE_ID
        ? globalDir
        : storeDirByStoreId.get(src.store_id)
      if (typeof dir !== 'string') { unresolvedStore = src.store_id; break }
      storeDirs.add(dir)
    }
    if (unresolvedStore) {
      applyWarnings.push({ problem: 'store-write-failed', fingerprint: c.fingerprint, detail: `unresolved store_id ${unresolvedStore}` })
      continue
    }
    // Global + every represented source store, canonical sorted order
    // (acquireStoreWriteLocksSync applies its own canonicalization + sort).
    const allDirs = [...storeDirs, globalDir].sort()

    const result = applyOneCandidate(c, allDirs, globalDir, applySkipped, registeredStores, config)
    if (!result) continue
    if (result.error) {
      applyWarnings.push({ problem: result.error, fingerprint: c.fingerprint })
      continue
    }
    if (result.skipped) continue // already-derived (no write row; applySkipped already appended inside applyOneCandidate)
    written.push({ fingerprint: c.fingerprint, episode_id: result.episode_id, project: result.project })
  }

  return {
    status: 'ok',
    dry_run: false,
    written,
    skipped: applySkipped,
    unconfirmed,
    warnings: applyWarnings,
    missing_sources: applyMissing,
  }
}

// --- Apply a single candidate under canonical store locks ---
function applyOneCandidate(candidate, allDirs, globalDir, applySkipped, registeredStores, config) {
  // Lock every involved store (incl. global), in canonical order. Failure
  // mode is a structured error; locks acquired in this call are released by
  // releaseStoreWriteLocks in finally before any return.
  let lockResult
  try {
    lockResult = acquireStoreWriteLocksSync(allDirs, { timeoutMs: 60_000 })
  } catch (err) {
    return { error: 'store-write-lock-timeout' }
  }
  if (!lockResult.ok) return { error: 'store-write-lock-timeout' }

  try {
    // Under held locks rebuild candidates from the canonical stores. This
    // catches source drift, addition, or removal affecting the confirmed
    // fingerprint. We require the EXACT confirmed fingerprint.
    const { members: freshMembers } = collectTopicMembers({ globalDir, registeredStores, config })
    const freshCandidates = buildTopicCandidates(freshMembers, config)
    const freshCandidate = freshCandidates.find(c => c.fingerprint === candidate.fingerprint)
    if (!freshCandidate) return { error: 'stale-fingerprint' }

    // Tags: TOPIC_TRACK_TAG + fresh common tags (under-lock majority), deduped + sorted.
    const tagList = [TOPIC_TRACK_TAG, ...freshCandidate.common_tags]
    const tags = [...new Set(tagList)].sort()

    const fresh = freshCandidate.promotion_sources
    const freshFp = freshCandidate.fingerprint
    if (freshFp !== candidate.fingerprint) return { error: 'stale-fingerprint' }

    // Exact-prior idempotency: any active topic-track lesson already has the
    // same canonical sources → no write. Surface the existing episode id so
    // the apply output reports already-derived under-lock, not silently (§A.7
    // S2 row 2.1 — append under-lock exact-prior to skipped).
    const live = snapshotExistingTracks(globalDir)
    const freshSer = serializePromotionSources(canonicalizePromotionSources(fresh))
    if (live.has(freshSer)) {
      applySkipped.push({
        fingerprint: candidate.fingerprint,
        reason: 'already-derived',
        existing_episode_id: live.get(freshSer),
      })
      return { skipped: true }
    }

    // Lexical winner among real source projects from the fresh candidate (REQ-9).
    const projCounts = new Map()
    for (const m of freshCandidate.members) {
      projCounts.set(m.project, (projCounts.get(m.project) || 0) + 1)
    }
    let project = null
    let bestCount = -1
    for (const [p, c] of projCounts) {
      if (c > bestCount || (c === bestCount && (project === null || p < project))) {
        project = p
        bestCount = c
      }
    }

    // Write the body to a temp file (avoids argv escaping problems; em-store
    // reads it via --body-file). Spawn is the only write surface — the engine
    // never touches episodes/, index.jsonl, tags.json, or category-index.json
    // directly.
    const tmpBody = path.join(os.tmpdir(), `topic-track-${candidate.fingerprint}.md`)
    fs.writeFileSync(tmpBody, freshCandidate.body, 'utf8')
    let child = null
    let spawnResult
    try {
      spawnResult = spawnSync(process.execPath, [
        EM_STORE,
        '--scope', 'global',
        '--project', project,
        '--category', 'lesson',
        '--tags', tags.join(','),
        '--summary', freshCandidate.summary,
        '--body-file', tmpBody,
        '--promotion-sources-json', serializePromotionSources(fresh),
      ], { cwd: globalDir, encoding: 'utf8' })
    } finally {
      try { fs.unlinkSync(tmpBody) } catch {}
    }
    try { child = JSON.parse(spawnResult.stdout) } catch {}
    if (spawnResult.status !== 0 || !child || child.status !== 'ok' ||
        typeof child.id !== 'string') {
      return {
        error: 'store-write-failed',
        detail: (child && (child.message || child.error)) ||
          (spawnResult.stderr || spawnResult.stdout || '').trim().slice(0, 300),
      }
    }
    return { episode_id: child.id, project }
  } finally {
    releaseStoreWriteLocks(lockResult.handles)
  }
}

// --- Export error code set for CLI mapping (§A.5 / §12) ---
export const ERROR_CODES = Object.freeze([
  'auto-write-withdrawn',
  'invalid-max-episodes',
  'confirm-required',
  'confirm-malformed',
  'confirm-duplicate',
  'confirm-unknown',
  'topic-tracks-config-unloadable',
  'topic-tracks-config-invalid',
  'topic-tracks-config-symlink',
  'topic-tracks-max-episodes',
  'stale-fingerprint',
  'store-write-lock-timeout',
  'store-write-failed',
])
