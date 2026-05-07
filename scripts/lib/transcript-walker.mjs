/**
 * transcript-walker.mjs — iterate Claude Code session transcripts.
 *
 * Claude Code writes per-session JSONL transcripts to:
 *   ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
 *
 * Each line is a JSON record. Shapes vary (queue-operation, attachment,
 * user/assistant message, tool_use, tool_result, summary, etc.). This module
 * normalizes the message-bearing records into a uniform shape and exposes
 * helpers for downstream mining and audit scripts.
 *
 * Cold-storage discipline: this module READS transcripts only. It never
 * modifies them.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

// ---------------------------------------------------------------------------
// Slug discovery
// ---------------------------------------------------------------------------

/**
 * List every project-slug directory that contains JSONL transcripts.
 * Optionally filter by substring and exclude worktree slugs.
 */
export function listSlugs({ slugFilter, excludeWorktrees } = {}) {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      if (slugFilter && !name.includes(slugFilter)) return false
      if (excludeWorktrees && /-claude-worktrees-/.test(name)) return false
      return true
    })
    .sort()
}

/**
 * List every JSONL transcript file under the matching slugs, with stat info.
 * Returns [{ slug, sessionId, file, mtime, size }].
 */
export function listTranscripts({ slugFilter, excludeWorktrees, since } = {}) {
  const sinceMs = since ? new Date(since).getTime() : 0
  const slugs = listSlugs({ slugFilter, excludeWorktrees })
  const out = []
  for (const slug of slugs) {
    const dir = path.join(PROJECTS_DIR, slug)
    let files
    try { files = fs.readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const full = path.join(dir, f)
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (sinceMs && st.mtimeMs < sinceMs) continue
      out.push({
        slug,
        sessionId: f.replace(/\.jsonl$/, ''),
        file: full,
        mtime: st.mtime.toISOString(),
        size: st.size,
      })
    }
  }
  return out.sort((a, b) => a.mtime.localeCompare(b.mtime))
}

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

/**
 * Pull plain text out of a Claude Code message record. Handles the variety
 * of `content` shapes: string, array of blocks, missing.
 *
 * Returns '' when no extractable text. Tool calls and tool results are
 * collapsed to a short tag so they don't disappear from context windows but
 * also don't masquerade as user/assistant prose.
 */
function extractText(record) {
  // Top-level content from queue-operation enqueue (raw user prompt)
  if (typeof record.content === 'string') return record.content

  const msg = record.message
  if (!msg) return ''

  if (typeof msg.content === 'string') return msg.content

  if (Array.isArray(msg.content)) {
    const parts = []
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      } else if (block.type === 'tool_use') {
        parts.push(`[tool_use:${block.name || '?'}]`)
      } else if (block.type === 'tool_result') {
        // Skip; usually noisy and not useful for mining
        continue
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        // Skip thinking blocks for mining (not visible to user)
        continue
      }
    }
    return parts.join('\n').trim()
  }
  return ''
}

/**
 * Classify a record into one of: 'user', 'assistant', 'tool_use', 'tool_result',
 * 'system', 'meta', or 'skip'. Returns the role plus any tool name.
 */
function classify(record) {
  if (record.type === 'queue-operation' && record.operation === 'enqueue') {
    return { role: 'user', toolName: null }
  }
  if (record.type === 'queue-operation') return { role: 'skip', toolName: null }
  if (record.type === 'attachment') return { role: 'meta', toolName: null }
  if (record.type === 'summary') return { role: 'meta', toolName: null }
  if (record.type === 'system') return { role: 'system', toolName: null }

  if (record.type === 'user') {
    // Could be a tool_result wrapped as user message
    const msg = record.message
    if (msg && Array.isArray(msg.content)) {
      const onlyTool = msg.content.every((b) => b && b.type === 'tool_result')
      if (onlyTool) return { role: 'tool_result', toolName: null }
    }
    return { role: 'user', toolName: null }
  }

  if (record.type === 'assistant') {
    const msg = record.message
    if (msg && Array.isArray(msg.content)) {
      const toolUse = msg.content.find((b) => b && b.type === 'tool_use')
      if (toolUse) {
        return { role: 'tool_use', toolName: toolUse.name || null }
      }
    }
    return { role: 'assistant', toolName: null }
  }

  return { role: 'skip', toolName: null }
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/**
 * Async generator that yields normalized records from every matching
 * transcript. Each yield has shape:
 *   { sessionId, slug, file, ts, role, toolName, text, raw }
 *
 * `text` may be empty for tool_use/tool_result/meta — callers filter as
 * needed.
 *
 * Robust to malformed lines (logs warning, continues).
 */
export async function* walkTranscripts({ slugFilter, excludeWorktrees, since } = {}) {
  const sinceMs = since ? new Date(since).getTime() : 0
  // Note: pass `since` to listTranscripts only when we want to drop entire
  // files. We omit it here so we can do per-record timestamp filtering below
  // and still see records inside files whose mtime is recent but contain old
  // events (rare, but accurate).
  const transcripts = listTranscripts({ slugFilter, excludeWorktrees })
  for (const t of transcripts) {
    const stream = fs.createReadStream(t.file, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      const { role, toolName } = classify(rec)
      if (role === 'skip') continue
      if (sinceMs && rec.timestamp) {
        const recMs = new Date(rec.timestamp).getTime()
        if (Number.isFinite(recMs) && recMs < sinceMs) continue
      }
      const text = extractText(rec)
      yield {
        sessionId: t.sessionId,
        slug: t.slug,
        file: t.file,
        ts: rec.timestamp || null,
        role,
        toolName,
        text,
        raw: rec,
      }
    }
  }
}

/**
 * Bucket a stream of normalized records by sessionId, in arrival order.
 * Returns a Map<sessionId, records[]>.
 *
 * Caller is responsible for memory; suitable for sessions in the 100s,
 * not 100,000s. For high-volume audits, walk twice: first pass for session
 * IDs of interest, second pass collecting only those.
 */
export async function groupBySession(generator) {
  const out = new Map()
  for await (const rec of generator) {
    if (!out.has(rec.sessionId)) out.set(rec.sessionId, [])
    out.get(rec.sessionId).push(rec)
  }
  return out
}

// ---------------------------------------------------------------------------
// Convenience: human-readable session summary
// ---------------------------------------------------------------------------

/**
 * Produce a one-line snapshot of a session: id, slug, message count, time
 * span, last cwd. Useful for audit reports.
 */
export function sessionSnapshot(records) {
  if (!records || !records.length) return null
  const first = records[0]
  const last = records[records.length - 1]
  const userMsgs = records.filter((r) => r.role === 'user').length
  const asstMsgs = records.filter((r) => r.role === 'assistant').length
  const toolUses = records.filter((r) => r.role === 'tool_use').length
  const cwd = last.raw?.cwd || first.raw?.cwd || null
  return {
    sessionId: first.sessionId,
    slug: first.slug,
    file: first.file,
    firstTs: first.ts,
    lastTs: last.ts,
    userMessages: userMsgs,
    assistantMessages: asstMsgs,
    toolUses,
    cwd,
  }
}

export const __internal__ = { extractText, classify, PROJECTS_DIR }
