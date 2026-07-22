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
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => {
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

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

// ---------------------------------------------------------------------------
// Anchor pre-flight (RFC-005 F6): IDs hardcoded in MEMORY.md files have a
// documented-anchor semantic role; moving them silently invalidates the path.
// ---------------------------------------------------------------------------
function findAnchoredIds(ids) {
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
    let content = ''
    try { content = fs.readFileSync(mf, 'utf8') } catch { continue }
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
  for (const dir of [LOCAL_DIR, GLOBAL_DIR]) {
    for (const row of readIndexRows(dir)) {
      if (typeof row.id !== 'string' || seen.has(row.id)) continue
      if (Array.isArray(row.tags) && row.tags.map(t => String(t).toLowerCase().trim()).includes(tag)) {
        seen.add(row.id)
        ids.push(row.id)
      }
    }
  }
}

if (ids.length === 0) {
  console.log(JSON.stringify({ status: 'ok', moved: [], noop: [], errors: [], message: 'No episodes selected.' }))
  process.exit(0)
}
if (ids.length > 10 && !confirm && !dryRun) {
  usageError(`${ids.length} episodes selected (> 10). Re-run with --confirm (or --dry-run to preview).`)
}

const anchoredIds = findAnchoredIds(ids)

// ---------------------------------------------------------------------------
// Per-episode move
// ---------------------------------------------------------------------------
const moved = []
const noop = []
const errors = []
const warnings = []

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
    const hLocal = sha256(path.join(LOCAL_DIR, 'episodes', `${id}.md`))
    const hGlobal = sha256(path.join(GLOBAL_DIR, 'episodes', `${id}.md`))
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
  let content = fs.readFileSync(srcFile, 'utf8')
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
    content = fs.readFileSync(srcFile, 'utf8')
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
    errors.push({ id, error: e.message, ...(steps ? { steps_succeeded: steps } : {}), recovery: 'run em-rebuild-index --scope all after resolving the reported paths' })
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
