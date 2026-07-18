// store-identity.mjs — RFC-012 P2 S1 (REQ-1..6): episode-carried store identity.
// Chain mechanics are P7 supersedes revisions written by THIS lib's atomic writer
// (temp + fsync + rename under the shared per-store lock, §8.2) — never em-store's
// non-atomic path. Zero deps: node stdlib + ./lock.mjs only.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { tryAcquire, release } from './lock.mjs'

// §A.5-S1 constants (verbatim)
export const STORE_IDENTITY_RECORD_TYPE = 'store-identity'
export const GLOBAL_STORE_ID = 'global'
export const STORE_ID_RE = /^([0-9a-f]{16}|global)$/
// §8.2 lock scoping: the SAME per-store lockfile the clerk uses (em-consolidate.mjs:439)
const LOCK_BASENAME = 'clerk-apply.lock'
const LOCK_TIMEOUT_S = 30
const TMP_SUFFIX = '.tmp-identity'
// §A.0 break-input override (REQ-2 negative): argv flag on the INVOKING process —
// same mechanism as em-rebuild-index.mjs BREAK_REBUILD_WHITELIST (line 28 precedent).
const BREAK_IDENTITY_WRITE = process.argv.includes('--break-identity-write')

// --- internal helpers ---

function sleepSync(ms) {
  // Busy-loop fallback in a try/catch: Atomics.wait on a SharedArrayBuffer-backed
  // Int32Array is a real SYNC sleep, not a microtask hop. Falls back to a tight
  // loop if SharedArrayBuffer is unavailable (sandboxed workers).
  try {
    const sab = new SharedArrayBuffer(4)
    const i32 = new Int32Array(sab)
    Atomics.wait(i32, 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* spin */ }
  }
}

function withStoreLockSync(storeDir, fn, { timeoutS = LOCK_TIMEOUT_S } = {}) {
  const lockFile = path.join(storeDir, LOCK_BASENAME)
  const deadlineMs = Date.now() + timeoutS * 1000
  let handle = null
  while (true) {
    let result
    try {
      // F4 fold (GLM r1 MINOR-1): mixed error contract — every other path
      // returns { error }, but a missing storeDir lets tryAcquire throw raw
      // ENOENT (lib/lock.mjs:28-30 rethrows non-EEXIST). Map the missing-dir
      // case to a uniform { error: 'store-dir-missing' } so S2/S4 direct
      // callers can branch on it; other errors propagate.
      result = tryAcquire(lockFile)
    } catch (err) {
      if (err && err.code === 'ENOENT') return { error: 'store-dir-missing' }
      throw err
    }
    if (result.ok) { handle = result.handle; break }
    if (Date.now() >= deadlineMs) return { error: 'lock-timeout' }
    sleepSync(100)
  }
  try {
    return fn()
  } finally {
    release(handle)
  }
}

function parseIdentityFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const lines = match[1].split('\n')
  const data = {}
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    let val
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      val = raw.slice(1, -1)
    } else {
      val = raw
    }
    data[key] = val
  }
  if (data.record_type !== STORE_IDENTITY_RECORD_TYPE) return null
  if (!STORE_ID_RE.test(data.store_id)) return null
  return {
    id: data.id,
    store_id: data.store_id,
    supersedes: typeof data.supersedes === 'string' ? data.supersedes : null,
    detaches_identity_root: typeof data.detaches_identity_root === 'string' ? data.detaches_identity_root : null,
    status: data.status || 'active',
  }
}

function listIdentityEpisodes(storeDir) {
  const episodesDir = path.join(storeDir, 'episodes')
  let files
  try {
    files = fs.readdirSync(episodesDir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const file of files) {
    const content = fs.readFileSync(path.join(episodesDir, file), 'utf8')
    const parsed = parseIdentityFrontmatter(content)
    if (parsed) {
      parsed.filename = file
      out.push(parsed)
    }
  }
  return out
}

function newEpisodeId(storeId, now = new Date()) {
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  return `${y}${mo}${d}-${h}${mi}${s}-store-identity-${storeId.slice(0, 4)}`
}

function identityEpisodeContent(fields) {
  const lines = ['---']
  lines.push(`id: ${fields.id}`)
  lines.push(`date: ${fields.date}`)
  lines.push(`time: "${fields.time}"`)
  lines.push(`project: ${fields.project}`)
  lines.push('category: context')
  lines.push('status: active')
  lines.push('tags: [store-identity]')
  lines.push(`summary: ${fields.summary}`)
  lines.push(`record_type: ${STORE_IDENTITY_RECORD_TYPE}`)
  lines.push(`store_id: ${fields.store_id}`)
  if (fields.supersedes) lines.push(`supersedes: ${fields.supersedes}`)
  if (fields.detaches_identity_root) lines.push(`detaches_identity_root: ${fields.detaches_identity_root}`)
  lines.push('---')
  const body = `\n# ${fields.summary}\n\n${fields.bodyLine}\n`
  return lines.join('\n') + body
}

function writeIdentityEpisodeAtomic(episodesDir, id, content) {
  fs.mkdirSync(episodesDir, { recursive: true })
  // Best-effort unlink of every stale tmp file left by a prior crashed write.
  let stale
  try { stale = fs.readdirSync(episodesDir).filter((f) => f.endsWith(TMP_SUFFIX)) } catch { stale = [] }
  for (const s of stale) {
    try { fs.unlinkSync(path.join(episodesDir, s)) } catch { /* ignore */ }
  }
  const tmp = path.join(episodesDir, '.' + id + '.md' + TMP_SUFFIX)
  const finalPath = path.join(episodesDir, id + '.md')
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  if (BREAK_IDENTITY_WRITE) return { error: 'break-identity-write' }
  fs.renameSync(tmp, finalPath)
  return { ok: true }
}

// --- incremental index helpers (RFC-012 P2 S1, REQ-1..6 / §8.2) ---
// After a successful atomic episode write, the store's index.jsonl + tags.json
// MUST be brought into sync under the SAME per-store lock so a fresh install
// doesn't leave em-doctor reporting "episode file(s) not in index". The episode
// file is authoritative — a later rebuild heals any drift — so these helpers
// degrade-not-throw on failure. Field ORDER mirrors em-rebuild-index.mjs's
// emit object exactly so a post-mint rebuild is a byte-stable no-op for the
// row we just appended.

function buildIdentityIndexRow(fields) {
  // Order matches em-rebuild-index.mjs's emit object for store-identity rows
  // (id, date, time, project, category, status, supersedes, tags, summary,
  // record_type, store_id, [detaches_identity_root], access_count, last_accessed).
  const row = {
    id: fields.id,
    date: fields.date,
    time: fields.time,
    project: fields.project,
    category: 'context',
    status: 'active',
    supersedes: fields.supersedes || null,
    tags: ['store-identity'],
    summary: fields.summary,
    record_type: STORE_IDENTITY_RECORD_TYPE,
    store_id: fields.store_id,
  }
  if (fields.detaches_identity_root) {
    row.detaches_identity_root = fields.detaches_identity_root
  }
  row.access_count = 0
  row.last_accessed = null
  return JSON.stringify(row)
}

function appendIdentityIndex(storeDir, fields) {
  // (1) Append one row to <storeDir>/index.jsonl. Create the file if absent
  // (appendFileSync lazily creates; explicit mkdirSync guards the storeDir
  // itself in case the caller raced an rm).
  const indexFile = path.join(storeDir, 'index.jsonl')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.appendFileSync(indexFile, buildIdentityIndexRow(fields) + '\n', 'utf8')
}

function updateIdentityTagsIndex(storeDir, episodeId) {
  // (2) Update <storeDir>/tags.json via the SAME read-modify-tmp-rename pattern
  // em-store.mjs's updateTagsIndex uses (issue #469 null-proto guard).
  const tagsFile = path.join(storeDir, 'tags.json')
  let index = Object.create(null)
  try {
    index = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(tagsFile, 'utf8')))
  } catch { /* fresh store — index stays empty */ }
  if (!index['store-identity']) index['store-identity'] = []
  if (!index['store-identity'].includes(episodeId)) {
    index['store-identity'].push(episodeId)
  }
  const tmp = tagsFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
  fs.renameSync(tmp, tagsFile)
}

// Degrade-not-throw: a failure in the index/tags update must NOT fail the
// mint (the episode file is authoritative; em-rebuild-index heals). On error
// we emit a stderr warning and signal index_stale via the wrapper below so
// callers can surface it (or just rebuild) if they care.
function applyIdentityIndexUpdate(storeDir, fields) {
  try {
    appendIdentityIndex(storeDir, fields)
    updateIdentityTagsIndex(storeDir, fields.id)
    return { stale: false }
  } catch (err) {
    try { process.stderr.write(`store-identity: index/tags update failed (rebuild heals): ${err && err.message}\n`) } catch { /* ignore */ }
    return { stale: true }
  }
}

// --- exports ---

export function resolveStoreIdentity(storeDir) {
  const eps = listIdentityEpisodes(storeDir)
  if (eps.length === 0) return { error: 'no-identity' }
  // Roots: episodes whose supersedes is absent or names no identity episode.
  const byId = new Map(eps.map((e) => [e.id, e]))
  const roots = eps.filter((e) => !e.supersedes || !byId.has(e.supersedes))
  // Detached roots are those referenced by SOME episode's detaches_identity_root.
  const detachedRootIds = new Set()
  for (const e of eps) {
    if (e.detaches_identity_root && byId.has(e.detaches_identity_root)) {
      detachedRootIds.add(e.detaches_identity_root)
    }
  }
  const activeRoots = roots.filter((r) => !detachedRootIds.has(r.id))
  if (activeRoots.length === 0) return { error: 'identity-chain-cycle' }
  if (activeRoots.length > 1) return { error: 'duplicate-identity-chain' }
  const root = activeRoots[0]
  // Walk successors from the single active root. A revisit = cycle.
  const visited = new Set([root.id])
  const chainMembers = [root]
  let current = root
  while (true) {
    const successor = eps.find((e) => e.supersedes === current.id)
    if (!successor) break
    if (visited.has(successor.id)) return { error: 'identity-chain-cycle' }
    visited.add(successor.id)
    chainMembers.push(successor)
    current = successor
  }
  // Episodes belonging to detached chains (their root is in detachedRootIds) are
  // intentionally not reachable from the active root — they stay in the store but
  // contribute no active id and no aliases (§A.5 lib error 'detachedChainExcluded').
  const terminal = chainMembers[chainMembers.length - 1]
  const aliases = chainMembers.slice(0, -1).map((m) => m.store_id)
  return {
    active_id: terminal.store_id,
    aliases,
    root_id: root.id,
    terminal_episode_id: terminal.id,
  }
}

export function mintStoreIdentity(storeDir, { reserved, lockTimeoutS } = {}) {
  if (reserved !== undefined && reserved !== GLOBAL_STORE_ID) {
    return { error: 'reserved-id-invalid' }
  }
  return withStoreLockSync(storeDir, () => {
    const existing = resolveStoreIdentity(storeDir)
    if (existing.error === 'no-identity') {
      // proceed to mint
    } else if (existing.error === 'identity-exists') {
      return { error: 'identity-exists' }
    } else if (existing.error) {
      // duplicate-identity-chain / identity-chain-cycle — fail loud
      return { error: existing.error }
    } else {
      return { error: 'identity-exists' }
    }
    const storeId = reserved || crypto.randomBytes(8).toString('hex')
    const project = reserved ? 'global' : (path.basename(path.dirname(storeDir)) || 'store')
    const now = new Date()
    const id = newEpisodeId(storeId, now)
    const y = now.getFullYear()
    const mo = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const h = String(now.getHours()).padStart(2, '0')
    const mi = String(now.getMinutes()).padStart(2, '0')
    const fields = {
      id,
      date: `${y}-${mo}-${d}`,
      time: `${h}:${mi}`,
      project,
      summary: `Store identity ${storeId}`,
      store_id: storeId,
      bodyLine: 'Store identity root for this episode store (RFC-012 P2 REQ-1). store_id is opaque and episode-carried; rebind via successor revision, never an edit (P7).',
    }
    const episodesDir = path.join(storeDir, 'episodes')
    const content = identityEpisodeContent(fields)
    const writeResult = writeIdentityEpisodeAtomic(episodesDir, id, content)
    if (writeResult.error) return writeResult
    const idx = applyIdentityIndexUpdate(storeDir, fields)
    const out = { active_id: storeId, root_id: id }
    if (idx.stale) out.index_stale = true
    return out
  }, { timeoutS: lockTimeoutS })
}

export function rebindStoreIdentity(storeDir, { lockTimeoutS } = {}) {
  return withStoreLockSync(storeDir, () => {
    const existing = resolveStoreIdentity(storeDir)
    if (existing.error) return { error: existing.error }
    const newStoreId = crypto.randomBytes(8).toString('hex')
    const now = new Date()
    const id = newEpisodeId(newStoreId, now)
    const y = now.getFullYear()
    const mo = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const h = String(now.getHours()).padStart(2, '0')
    const mi = String(now.getMinutes()).padStart(2, '0')
    const project = path.basename(path.dirname(storeDir)) || 'store'
    const fields = {
      id,
      date: `${y}-${mo}-${d}`,
      time: `${h}:${mi}`,
      project,
      summary: `Store identity rebind ${newStoreId}`,
      store_id: newStoreId,
      supersedes: existing.terminal_episode_id,
      bodyLine: 'Store identity rebind successor (RFC-012 P2 REQ-3). Old store_id becomes a retired alias owned by this chain.',
    }
    const episodesDir = path.join(storeDir, 'episodes')
    const content = identityEpisodeContent(fields)
    const writeResult = writeIdentityEpisodeAtomic(episodesDir, id, content)
    if (writeResult.error) return writeResult
    const idx = applyIdentityIndexUpdate(storeDir, fields)
    const out = { active_id: newStoreId, prior_id: existing.active_id, root_id: existing.root_id }
    if (idx.stale) out.index_stale = true
    return out
  }, { timeoutS: lockTimeoutS })
}

export function detachStoreIdentity(storeDir, { lockTimeoutS } = {}) {
  return withStoreLockSync(storeDir, () => {
    const existing = resolveStoreIdentity(storeDir)
    if (existing.error) return { error: existing.error }
    const newStoreId = crypto.randomBytes(8).toString('hex')
    const now = new Date()
    const id = newEpisodeId(newStoreId, now)
    const y = now.getFullYear()
    const mo = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const h = String(now.getHours()).padStart(2, '0')
    const mi = String(now.getMinutes()).padStart(2, '0')
    const project = path.basename(path.dirname(storeDir)) || 'store'
    const fields = {
      id,
      date: `${y}-${mo}-${d}`,
      time: `${h}:${mi}`,
      project,
      summary: `Store identity detach ${newStoreId}`,
      store_id: newStoreId,
      detaches_identity_root: existing.root_id,
      bodyLine: 'Store identity detach root (RFC-012 P2 REQ-5). Detached chain contributes no active id and no aliases in this store.',
    }
    const episodesDir = path.join(storeDir, 'episodes')
    const content = identityEpisodeContent(fields)
    const writeResult = writeIdentityEpisodeAtomic(episodesDir, id, content)
    if (writeResult.error) return writeResult
    const idx = applyIdentityIndexUpdate(storeDir, fields)
    const out = { active_id: newStoreId, detached_root_id: existing.root_id }
    if (idx.stale) out.index_stale = true
    return out
  }, { timeoutS: lockTimeoutS })
}
