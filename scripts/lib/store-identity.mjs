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

function withStoreLockSync(storeDir, fn) {
  const lockFile = path.join(storeDir, LOCK_BASENAME)
  const deadlineMs = Date.now() + LOCK_TIMEOUT_S * 1000
  let handle = null
  while (true) {
    const result = tryAcquire(lockFile)
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

export function mintStoreIdentity(storeDir, { reserved } = {}) {
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
    return { active_id: storeId, root_id: id }
  })
}

export function rebindStoreIdentity(storeDir) {
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
    return { active_id: newStoreId, prior_id: existing.active_id, root_id: existing.root_id }
  })
}

export function detachStoreIdentity(storeDir) {
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
    return { active_id: newStoreId, detached_root_id: existing.root_id }
  })
}
