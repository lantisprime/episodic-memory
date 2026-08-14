#!/usr/bin/env node
/**
 * em-move.mjs — atomic episode relocation between scopes (RFC-005).
 *
 * Usage:
 *   node em-move.mjs --id <full-episode-id> --to local|global [--dry-run]
 *   node em-move.mjs --ids <id1>,<id2>,... --to local|global [--dry-run]
 *   node em-move.mjs --filter-tag <tag> --to local|global [--dry-run]
 *
 * Optional: [--reason "<text>"] [--no-audit] [--confirm] [--break-anchors]
 *
 * Relocates episodes between the local (<repo>/.episodic-memory/) and global
 * (~/.episodic-memory/) stores while preserving the episode ID, frontmatter,
 * body, supersedes references, and access/feedback counters. Both scopes'
 * index.jsonl, tags.json, category-index.json, and tokens.json are updated
 * atomically per episode. Fixes the two recurring failure modes of manual
 * `mv` + rebuild: stale source-index rows serving search results, and
 * promotion-by-restore minting new IDs that orphan supersedes chains.
 *
 * Deliberately scope-only (RFC-005): no content edits, no cross-project
 * moves, no chain forking. A chain split across scopes still resolves via
 * `em-search --scope all`.
 *
 * Safety gates:
 *   - full IDs only (no suffix resolution — collision-prone, RFC-005 F1)
 *   - >10 episodes requires --confirm
 *   - IDs hardcoded in MEMORY.md anchors refuse to move without
 *     --break-anchors (RFC-005 F6)
 *   - found-in-both-scopes recovery: identical files → finish the interrupted
 *     move; different files → hard error, no writes (RFC-005 F3)
 *   - per-move audit episode written LAST to the destination scope, with a
 *     per-step success bitmap (RFC-005 F4/F8); suppressed by --no-audit and
 *     for no-ops
 *
 * Outputs JSON: { status, moved: [...], noop: [...], errors: [...], dry_run? }
 * Exit 0 when no per-id errors; 1 otherwise; 2 on usage error.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { normalizeTags, episodeTokens, updateTokensIndex, nullProtoIndex } from './lib/relevance.mjs'
import { canonicalCategory } from './lib/categories.mjs'
import { acquireStoreWriteLocksSync, releaseStoreWriteLocks, atomicReplaceFileSync } from './lib/store-write-lock.mjs'
import { readIndexFileOrThrow, IndexUnreadableError, readBodyOrSkip, readBodyBufferOrSkip, openReadableBody, BodyUnreadableError } from './lib/index-state.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-move.mjs', usage: 'node em-move.mjs (--id <full-id> | --ids <id1,id2,...> | --filter-tag <tag>) --to local|global [--dry-run] [--reason <text>] [--no-audit] [--confirm] [--break-anchors] — atomic scope relocation preserving id/chain/counters (RFC-005)' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const idFlag = flag('--id')
const idsFlag = flag('--ids')
const filterTag = flag('--filter-tag')
const to = flag('--to')
const dryRun = argv.includes('--dry-run')
const noAudit = argv.includes('--no-audit')
const confirm = argv.includes('--confirm')
const breakAnchors = argv.includes('--break-anchors')
const reason = flag('--reason') || ''

function usageError(message) {
  console.log(JSON.stringify({ status: 'error', message }))
  process.exit(2)
}

const selectors = [idFlag, idsFlag, filterTag].filter(v => v !== undefined)
if (selectors.length !== 1) {
  usageError('Exactly one of --id / --ids / --filter-tag is required.')
}
if (to !== 'local' && to !== 'global') {
  usageError('--to local|global is required.')
}

const DEST_DIR = to === 'global' ? GLOBAL_DIR : LOCAL_DIR
const SRC_SCOPE_OF = dir => (dir === GLOBAL_DIR ? 'global' : 'local')

// ---------------------------------------------------------------------------
// Store helpers (atomic write patterns shared with em-store/em-rebuild-index)
// ---------------------------------------------------------------------------
function readIndexRows(dataDir) {
  const p = path.join(dataDir, 'index.jsonl')
  const raw = readIndexFileOrThrow(fs, p)
  if (raw === null) return []
  return raw.trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

function writeIndexRows(dataDir, rows) {
  const p = path.join(dataDir, 'index.jsonl')
  atomicReplaceFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

// Remove an id from a { key: [ids] } inverted index; drop emptied keys.
function removeFromInverted(dataDir, fileName, id, warnings, pretty) {
  const p = path.join(dataDir, fileName)
  if (!fs.existsSync(p)) return
  let idx
  try { idx = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {
    warnings.push(`${fileName} unreadable in ${SRC_SCOPE_OF(dataDir)} scope — skipped; run em-rebuild-index.mjs`)
    return
  }
  for (const key of Object.keys(idx)) {
    if (!Array.isArray(idx[key])) continue
    const filtered = idx[key].filter(x => x !== id)
    if (filtered.length === 0) delete idx[key]
    else if (filtered.length !== idx[key].length) idx[key] = filtered
    else continue
  }
  atomicReplaceFileSync(p, JSON.stringify(idx, ...(pretty ? [null, 2] : [])))
}

function addToInverted(dataDir, fileName, id, keys, pretty) {
  if (keys.length === 0) return
  const p = path.join(dataDir, fileName)
  // Null-proto: a tag/category key named "constructor" must not resolve to
  // Object.prototype (issue #469)
  let idx = Object.create(null)
  try { idx = nullProtoIndex(JSON.parse(fs.readFileSync(p, 'utf8'))) } catch {}
  for (const key of keys) {
    if (!idx[key]) idx[key] = []
    if (!idx[key].includes(id)) idx[key].push(id)
  }
  atomicReplaceFileSync(p, JSON.stringify(idx, ...(pretty ? [null, 2] : [])))
}

// #669: readEpisodeBodyOrThrow — fd-based guarded read for the pre-lock/
// post-lock frontmatter-id content reads below (text use: regex + later
// tokenization, not byte-identity — see readEpisodeBodyRawOrThrow below for
// sha256's separate raw-Buffer need, review-round A1). openReadableBody
// never blocks on a non-regular file (FIFO/dir/EACCES/...); a genuinely-
// vanished (ENOENT) file is also converted to a throw here (plain Error, so
// the existing catch(e) => errors.push(e.message) shape needs no new
// branch) since every caller of this helper already confirmed presence
// moments earlier and a race-vanish is exceptional either way.
function readEpisodeBodyOrThrow(filePath) {
  const body = openReadableBody(fs, filePath)
  if (body === null) throw new Error(`Episode file vanished: ${filePath}`)
  return body
}

// #669 review-round A1 (MAJOR, convergent — data loss): sha256() must hash
// RAW BYTES, not the utf8-DECODED string readEpisodeBodyOrThrow returns.
// Two byte-divergent invalid-UTF-8 bodies (e.g. a trailing 0xFF vs 0xFE) both
// decode to the same string (lone surrogates become U+FFFD), so hashing the
// decoded text collapsed them to "identical" — the found-in-both-scopes
// divergence check then unlinked one copy as a false duplicate (data loss,
// reviewer-confirmed: exit 0, moved, local deleted).
//
// #670 S1: thin adapter over the shared readBodyBufferOrSkip primitive (open
// O_NONBLOCK so a FIFO/no-writer never blocks, fstat rejects any non-regular
// file BEFORE the read, readFileSync(fd) with NO encoding returns the exact
// bytes) — three raw-bytes call sites (this one, em-restore.mjs, and the new
// BP-1 Buffer sites) now share ONE fd-based implementation instead of each
// duplicating the fd logic locally. UNLIKE openReadableBody's ENOENT->null,
// this adapter KEEPS ENOENT->throw (every caller here already confirmed
// presence moments earlier; a race-vanish is exceptional either way).
function readEpisodeBodyRawOrThrow(filePath) {
  const r = readBodyBufferOrSkip(fs, filePath)
  if (r.ok) return r.raw
  throw new BodyUnreadableError(filePath, r.code)
}

function sha256(p) {
  return crypto.createHash('sha256').update(readEpisodeBodyRawOrThrow(p)).digest('hex')
}

// ---------------------------------------------------------------------------
// Anchor pre-flight (RFC-005 F6): IDs hardcoded in MEMORY.md files have a
// documented-anchor semantic role; moving them silently invalidates the path.
// ---------------------------------------------------------------------------
function findAnchoredIds(ids, warnings) {
  const anchored = new Map()
  const projectsDir = path.join(os.homedir(), '.claude', 'projects')
  let memoryFiles = []
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, proj, 'memory', 'MEMORY.md')
      if (fs.existsSync(p)) memoryFiles.push(p)
    }
  } catch {}
  for (const mf of memoryFiles) {
    // #669: readBodyOrSkip — converts a FIFO/non-regular MEMORY.md from a
    // hang into a skip. F5: ENOENT stays silent; non-ENOENT reports through
    // this file's existing warnings channel (surfaced in the final JSON).
    const r = readBodyOrSkip(fs, mf)
    if (!r.ok) {
      if (r.code !== 'ENOENT') warnings.push(`MEMORY.md anchor scan: ${mf} unreadable (${r.code}) — skipped`)
      continue
    }
    const content = r.raw
    for (const id of ids) {
      if (content.includes(`episodes/${id}.md`)) {
        if (!anchored.has(id)) anchored.set(id, [])
        anchored.get(id).push(mf)
      }
    }
  }
  return anchored
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
let ids = []
if (idFlag !== undefined) ids = [idFlag]
else if (idsFlag !== undefined) ids = idsFlag.split(',').map(s => s.trim()).filter(Boolean)
else {
  // --filter-tag: select by scanning index rows of BOTH scopes (never trust
  // tags.json for selection — RFC-005 F2: it can be stale).
  const tag = normalizeTags(filterTag)[0]
  if (!tag) usageError('--filter-tag requires a non-empty tag.')
  const seen = new Set()
  try {
    for (const dir of [LOCAL_DIR, GLOBAL_DIR]) {
      for (const row of readIndexRows(dir)) {
        if (typeof row.id !== 'string' || seen.has(row.id)) continue
        if (Array.isArray(row.tags) && row.tags.map(t => String(t).toLowerCase().trim()).includes(tag)) {
          seen.add(row.id)
          ids.push(row.id)
        }
      }
    }
  } catch (e) {
    if (e instanceof IndexUnreadableError) {
      console.log(JSON.stringify({ status: 'error', message: `em-move: ${e.message}`, code: `index-unreadable:${e.code}` }))
      process.exit(1)
    }
    throw e
  }
}

if (ids.length === 0) {
  console.log(JSON.stringify({ status: 'ok', moved: [], noop: [], errors: [], message: 'No episodes selected.' }))
  process.exit(0)
}
if (ids.length > 10 && !confirm && !dryRun) {
  usageError(`${ids.length} episodes selected (> 10). Re-run with --confirm (or --dry-run to preview).`)
}

// warnings declared before findAnchoredIds (#669) so its MEMORY.md
// unreadable-scan reports use the SAME channel the move loop below appends
// to (single warnings surface in the final JSON).
const warnings = []
const anchoredIds = findAnchoredIds(ids, warnings)

// ---------------------------------------------------------------------------
// Per-episode move
// ---------------------------------------------------------------------------
const moved = []
const noop = []
const errors = []

for (const id of ids) {
  if (!/^\d{8}-\d{6}-/.test(id)) {
    errors.push({ id, error: 'Not a full episode id (YYYYMMDD-HHMMSS-…). Suffix resolution is not supported (RFC-005 F1).' })
    continue
  }
  if (anchoredIds.has(id) && !breakAnchors) {
    errors.push({ id, error: `Anchored in ${anchoredIds.get(id).join(', ')} — refusing to move (pass --break-anchors to override).` })
    continue
  }

  const inLocal = fs.existsSync(path.join(LOCAL_DIR, 'episodes', `${id}.md`))
  const inGlobal = fs.existsSync(path.join(GLOBAL_DIR, 'episodes', `${id}.md`))

  let srcDir = null
  let resumeCleanup = false
  if (inLocal && inGlobal) {
    // F3 recovery: identical → an earlier move copied but never unlinked;
    // finish the cleanup. Different → hard error, touch nothing.
    // #669: PRE-lock, outside any try — sha256() now reads via the guarded
    // helper and can throw; wrap locally so an unreadable body becomes a
    // per-id error + continue instead of crashing the whole run.
    let hLocal, hGlobal
    try {
      hLocal = sha256(path.join(LOCAL_DIR, 'episodes', `${id}.md`))
      hGlobal = sha256(path.join(GLOBAL_DIR, 'episodes', `${id}.md`))
    } catch (e) {
      errors.push({
        id,
        error: e instanceof BodyUnreadableError ? `episode body unreadable (${e.code}) (${e.file})` : e.message,
        ...(e instanceof BodyUnreadableError ? { code: `episode-unreadable:${e.code}` } : {}),
      })
      continue
    }
    if (hLocal !== hGlobal) {
      errors.push({ id, error: 'Present in BOTH scopes with DIFFERENT content — manual reconciliation required (compare the two files, delete the stale one, run em-rebuild-index --scope all).' })
      continue
    }
    srcDir = to === 'global' ? LOCAL_DIR : GLOBAL_DIR
    resumeCleanup = true
  } else if (inLocal) srcDir = LOCAL_DIR
  else if (inGlobal) srcDir = GLOBAL_DIR
  else {
    errors.push({ id, error: 'Not found in local or global stores.' })
    continue
  }

  const from = SRC_SCOPE_OF(srcDir)
  if (srcDir === DEST_DIR && !resumeCleanup) {
    noop.push({ id, scope: to })
    continue
  }

  let srcFile = path.join(srcDir, 'episodes', `${id}.md`)

  // Defensive: frontmatter id must match the filename.
  // #669: PRE-lock (this runs before acquireStoreWriteLocksSync below) and
  // outside any try today — a bare throw here would crash the whole run.
  // Wrap locally, matching the :292 errors.push pattern, so an unreadable
  // body becomes a per-id error + continue instead of a hang or a crash.
  let content
  try {
    content = readEpisodeBodyOrThrow(srcFile)
  } catch (e) {
    errors.push({
      id,
      error: e instanceof BodyUnreadableError ? `episode body unreadable (${e.code}) (${e.file})` : e.message,
      ...(e instanceof BodyUnreadableError ? { code: `episode-unreadable:${e.code}` } : {}),
    })
    continue
  }
  let fmId = (content.match(/^id:\s*(.+)$/m) || [])[1]
  if (fmId && fmId.trim() !== id) {
    errors.push({ id, error: `Frontmatter id "${fmId.trim()}" does not match filename — refusing to move.` })
    continue
  }

  if (dryRun) {
    moved.push({ id, from, to, dry_run: true })
    continue
  }

  // Source and destination are one transaction. Acquire both canonical
  // stores in helper order before the first file move/index replacement,
  // then re-resolve location, content, and both index snapshots under lock.
  const lockResult = acquireStoreWriteLocksSync([srcDir, DEST_DIR])
  if (!lockResult.ok) {
    errors.push({ id, error: `store-write-lock-timeout (heldBy=${lockResult.heldBy ?? 'unknown'})`, code: lockResult.code, heldBy: lockResult.heldBy })
    continue
  }

  let steps = null
  try {
    const currentInLocal = fs.existsSync(path.join(LOCAL_DIR, 'episodes', `${id}.md`))
    const currentInGlobal = fs.existsSync(path.join(GLOBAL_DIR, 'episodes', `${id}.md`))
    resumeCleanup = false
    if (currentInLocal && currentInGlobal) {
      const hLocal = sha256(path.join(LOCAL_DIR, 'episodes', `${id}.md`))
      const hGlobal = sha256(path.join(GLOBAL_DIR, 'episodes', `${id}.md`))
      if (hLocal !== hGlobal) {
        errors.push({ id, error: 'Present in BOTH scopes with DIFFERENT content — manual reconciliation required (compare the two files, delete the stale one, run em-rebuild-index --scope all).' })
        continue
      }
      srcDir = to === 'global' ? LOCAL_DIR : GLOBAL_DIR
      resumeCleanup = true
    } else if (currentInLocal) srcDir = LOCAL_DIR
    else if (currentInGlobal) srcDir = GLOBAL_DIR
    else {
      errors.push({ id, error: 'Not found in local or global stores after lock acquisition.' })
      continue
    }

    if (srcDir === DEST_DIR && !resumeCleanup) {
      noop.push({ id, scope: to })
      continue
    }

    const currentFrom = SRC_SCOPE_OF(srcDir)
    srcFile = path.join(srcDir, 'episodes', `${id}.md`)
    const dstFile = path.join(DEST_DIR, 'episodes', `${id}.md`)
    // #669: already inside the lock-held try (catch below now carries
    // e.code for a BodyUnreadableError) — a natural throw here is caught,
    // reported per-id, and the finally still releases both locks.
    content = readEpisodeBodyOrThrow(srcFile)
    fmId = (content.match(/^id:\s*(.+)$/m) || [])[1]
    if (fmId && fmId.trim() !== id) {
      errors.push({ id, error: `Frontmatter id "${fmId.trim()}" does not match filename — refusing to move.` })
      continue
    }

    const srcRows = readIndexRows(srcDir)
    const dstRows = readIndexRows(DEST_DIR)
    const srcRow = srcRows.find(r => r.id === id)
    steps = { preflight: true, file_move: false, src_index: false, dst_index: false, src_inverted: false, dst_inverted: false }

    // 1. file move (atomic same-fs; copy+unlink cross-device — RFC-005 F9)
    fs.mkdirSync(path.join(DEST_DIR, 'episodes'), { recursive: true })
    if (!resumeCleanup) {
      try {
        fs.renameSync(srcFile, dstFile)
      } catch (e) {
        if (e.code === 'EXDEV') {
          fs.copyFileSync(srcFile, dstFile)
          try {
            fs.unlinkSync(srcFile)
          } catch (unlinkErr) {
            try { fs.unlinkSync(dstFile) } catch {}
            throw new Error(`cross-device unlink failed (${unlinkErr.code}); rolled back copy. Both paths: ${srcFile} | ${dstFile}`)
          }
        } else throw e
      }
    } else {
      fs.unlinkSync(srcFile)
    }
    steps.file_move = true

    // 2. source index: drop the row
    writeIndexRows(srcDir, srcRows.filter(r => r.id !== id))
    steps.src_index = true

    // 3. destination index: append the preserved row (dedupe first)
    const nextDstRows = dstRows.filter(r => r.id !== id)
    if (srcRow) nextDstRows.push(srcRow)
    writeIndexRows(DEST_DIR, nextDstRows)
    steps.dst_index = true

    // 4. inverted indexes both sides (tags pretty-printed, category pretty,
    //    tokens compact — matching each file's existing format)
    removeFromInverted(srcDir, 'tags.json', id, warnings, true)
    removeFromInverted(srcDir, 'category-index.json', id, warnings, true)
    removeFromInverted(srcDir, 'tokens.json', id, warnings, false)
    steps.src_inverted = true

    const tags = normalizeTags(srcRow?.tags || [])
    addToInverted(DEST_DIR, 'tags.json', id, tags, true)
    if (srcRow?.category) addToInverted(DEST_DIR, 'category-index.json', id, [canonicalCategory(srcRow.category)], true)
    updateTokensIndex(DEST_DIR, id, episodeTokens({ summary: srcRow?.summary || '', tags, body: content }))
    steps.dst_inverted = true
    // 5. audit episode — written LAST, to the DESTINATION scope, only on full
    //    success (RFC-005 F4/F8). The direct child inherits the destination
    //    lock, so the move keeps both locks until all destination persistence
    //    for this operation is complete.
    let auditId = null
    if (!noAudit) {
      try {
        const body = [
          `ts: ${new Date().toISOString()}`,
          `reason: ${JSON.stringify(reason)}`,
          `steps_succeeded: ${JSON.stringify(steps)}`,
        ].join('\n')
        const r = execFileSync(process.execPath, [
          path.join(SCRIPT_DIR, 'em-store.mjs'),
          '--project', srcRow?.project || 'em-move',
          '--category', 'context',
          '--tags', ['em-move', 'audit', currentFrom, to].join(','),
          '--summary', `em-move: ${id} moved from ${currentFrom} to ${to}`,
          '--body', body,
          '--scope', to,
        ], { encoding: 'utf8', cwd: process.cwd() })
        try { auditId = JSON.parse(r.trim()).id || null } catch {}
      } catch {
        warnings.push(`audit episode write failed for ${id} (move itself completed)`)
      }
    }

    moved.push({ id, from: currentFrom, to, ...(auditId ? { audit_id: auditId } : {}) })
  } catch (e) {
    // #669: e.code was previously dropped for a BodyUnreadableError thrown
    // from the guarded reads above (sha256 / readEpisodeBodyOrThrow) —
    // carry it so the per-id error entry names the typed wire code.
    errors.push({
      id,
      error: e instanceof BodyUnreadableError ? `episode body unreadable (${e.code}) (${e.file})` : e.message,
      ...(e instanceof BodyUnreadableError ? { code: `episode-unreadable:${e.code}` } : {}),
      ...(steps ? { steps_succeeded: steps } : {}),
      recovery: 'run em-rebuild-index --scope all after resolving the reported paths',
    })
    continue
  } finally {
    releaseStoreWriteLocks(lockResult.handles)
  }
}

const result = {
  status: errors.length ? 'error' : 'ok',
  ...(dryRun ? { dry_run: true } : {}),
  moved,
  noop,
  errors,
  ...(warnings.length ? { warnings } : {}),
}
console.log(JSON.stringify(result))
process.exit(errors.length ? 1 : 0)
