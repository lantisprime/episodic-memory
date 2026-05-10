/**
 * files.mjs — File-storage adapter for the second-opinion harness.
 *
 * Layout under <projectRoot>/.review-store/:
 *   requests/<id>.json    — metadata (request_id, work-area, phase, round, summary, ...)
 *   requests/<id>.body.md — body content
 *   replies/<id>.json     — reply metadata (reply_id, work-area, round, verdict, ...)
 *   replies/<id>.body.md  — reply body content
 *   index.jsonl           — append-only summary log (rebuildable from files)
 *
 * Write protocol (atomic via tmp+rename, per v3 §File storage):
 *   1. Generate <id> = <UTC-timestamp>-<6-byte-random-hex>.
 *   2. Write requests/<id>.body.md via tmp + rename.
 *   3. Write requests/<id>.json via tmp + rename.
 *   4. Append summary line to index.jsonl (POSIX append-fd; cache only).
 *
 * Authority root: ALL writes use absolute paths under projectRoot. No process.cwd().
 *
 * Crash recovery: index.jsonl reconstructible by rebuildIndex() from directory contents.
 * The .json + .body.md files are the source of truth.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function reviewStoreDir(projectRoot) {
  return path.join(projectRoot, '.review-store')
}

function generateId() {
  const now = new Date()
  const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
  const rand = crypto.randomBytes(6).toString('hex')
  return `${ts}-${rand}`
}

/**
 * Write a request to <projectRoot>/.review-store/requests/<id>.{body.md,json}
 * + append to index.jsonl. Returns { id, bodyPath, metaPath }.
 */
export function writeRequest({ projectRoot, body, meta }) {
  if (!projectRoot) throw new Error('writeRequest: projectRoot is required')
  if (typeof body !== 'string') throw new Error('writeRequest: body must be a string')
  if (!meta || typeof meta !== 'object') throw new Error('writeRequest: meta object required')

  const id = generateId()
  const requestsDir = path.join(reviewStoreDir(projectRoot), 'requests')
  fs.mkdirSync(requestsDir, { recursive: true })

  const bodyPath = path.join(requestsDir, `${id}.body.md`)
  const metaPath = path.join(requestsDir, `${id}.json`)

  // Atomic body write via tmp + rename.
  const bodyTmp = bodyPath + '.tmp'
  fs.writeFileSync(bodyTmp, body, 'utf8')
  fs.renameSync(bodyTmp, bodyPath)

  // Atomic meta write via tmp + rename.
  const metaContent = { request_id: id, ...meta, body_path: bodyPath }
  const metaTmp = metaPath + '.tmp'
  fs.writeFileSync(metaTmp, JSON.stringify(metaContent, null, 2), 'utf8')
  fs.renameSync(metaTmp, metaPath)

  // Index append (best-effort cache; rebuildable from directory).
  appendIndex(projectRoot, { kind: 'request', id, ...meta })

  return { id, bodyPath, metaPath }
}

/**
 * Write a reply linked to a prior request. Returns { id, bodyPath, metaPath }.
 */
export function writeReply({ projectRoot, requestId, body, meta }) {
  if (!projectRoot) throw new Error('writeReply: projectRoot is required')
  if (!requestId) throw new Error('writeReply: requestId is required')
  if (typeof body !== 'string') throw new Error('writeReply: body must be a string')
  if (!meta || typeof meta !== 'object') throw new Error('writeReply: meta object required')

  const id = generateId()
  const repliesDir = path.join(reviewStoreDir(projectRoot), 'replies')
  fs.mkdirSync(repliesDir, { recursive: true })

  const bodyPath = path.join(repliesDir, `${id}.body.md`)
  const metaPath = path.join(repliesDir, `${id}.json`)

  const bodyTmp = bodyPath + '.tmp'
  fs.writeFileSync(bodyTmp, body, 'utf8')
  fs.renameSync(bodyTmp, bodyPath)

  const metaContent = {
    reply_id: id,
    request_id: requestId,
    ...meta,
    body_path: bodyPath,
  }
  const metaTmp = metaPath + '.tmp'
  fs.writeFileSync(metaTmp, JSON.stringify(metaContent, null, 2), 'utf8')
  fs.renameSync(metaTmp, metaPath)

  appendIndex(projectRoot, { kind: 'reply', id, request_id: requestId, ...meta })

  return { id, bodyPath, metaPath }
}

/**
 * Append one summary line to index.jsonl. Idempotent across retries (id is unique
 * per writeRequest/writeReply call; concurrent writers may interleave but the
 * source-of-truth is the directory).
 */
function appendIndex(projectRoot, entry) {
  const dir = reviewStoreDir(projectRoot)
  fs.mkdirSync(dir, { recursive: true })
  const indexPath = path.join(dir, 'index.jsonl')
  fs.appendFileSync(indexPath, JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * Rebuild index.jsonl from directory contents. Called by `second-opinion rebuild-index`
 * subcommand. Source of truth: requests/*.json and replies/*.json.
 */
export function rebuildIndex(projectRoot) {
  const dir = reviewStoreDir(projectRoot)
  if (!fs.existsSync(dir)) return { rebuilt: 0, requests: 0, replies: 0 }

  const entries = []

  const requestsDir = path.join(dir, 'requests')
  let reqCount = 0
  if (fs.existsSync(requestsDir)) {
    for (const f of fs.readdirSync(requestsDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(requestsDir, f), 'utf8'))
        entries.push({ kind: 'request', id: meta.request_id, ...meta })
        reqCount++
      } catch {
        // skip malformed
      }
    }
  }

  const repliesDir = path.join(dir, 'replies')
  let replyCount = 0
  if (fs.existsSync(repliesDir)) {
    for (const f of fs.readdirSync(repliesDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(repliesDir, f), 'utf8'))
        entries.push({ kind: 'reply', id: meta.reply_id, ...meta })
        replyCount++
      } catch {
        // skip malformed
      }
    }
  }

  // Sort by id (timestamp-prefixed) so chronology is preserved.
  entries.sort((a, b) => (a.id || '').localeCompare(b.id || ''))

  // Atomic write via tmp + rename.
  const indexPath = path.join(dir, 'index.jsonl')
  const tmp = indexPath + '.tmp'
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmp, indexPath)

  return { rebuilt: entries.length, requests: reqCount, replies: replyCount }
}

/**
 * List replies for a given work-area, sorted by id (chronological).
 */
export function listReplies({ projectRoot, workArea }) {
  const repliesDir = path.join(reviewStoreDir(projectRoot), 'replies')
  if (!fs.existsSync(repliesDir)) return []
  const out = []
  for (const f of fs.readdirSync(repliesDir)) {
    if (!f.endsWith('.json')) continue
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(repliesDir, f), 'utf8'))
      if (workArea && meta['work-area'] !== workArea) continue
      out.push(meta)
    } catch {
      // skip malformed
    }
  }
  out.sort((a, b) => (a.reply_id || '').localeCompare(b.reply_id || ''))
  return out
}
