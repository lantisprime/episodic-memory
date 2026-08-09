#!/usr/bin/env node
/**
 * em-rebuild-index.mjs — Rebuild index.jsonl from episode files.
 *
 * Usage:
 *   node em-rebuild-index.mjs [--scope local|global|all]
 *
 * Reads all .md files, extracts frontmatter, writes fresh index.jsonl.
 * Outputs JSON: { status, rebuilt: [{ scope, count }] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = path.join(process.cwd(), '.episodic-memory')

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'all'

// #651/#653: fd-based index existence classifier + reader, inlined (no lib/
// in this vendored copy) — mirrors scripts/lib/index-state.mjs. A single
// open() + fstat() on ONE fd (never a separate classify-then-path-read pair)
// closes the D1 TOCTOU window: even a regular file swapped to a FIFO/dir
// between calls cannot re-open a hang, because the read below reuses the
// SAME fd the fstat just classified. absent -> null (loadIndex returns []);
// unreadable (symlink loop/dangling, EACCES parent, FIFO/socket/device,
// EISDIR, or a read failure) -> throws with .code, so the caller aborts
// typed instead of silently degrading or blocking forever on an unguarded
// open.
function classifyIndexFile(filePath) {
  let st
  try { st = fs.lstatSync(filePath) } catch (e) {
    if (e && e.code === 'ENOENT') {
      const dir = path.dirname(filePath)
      let dirStat
      try { dirStat = fs.lstatSync(dir) } catch (e2) {
        return (e2 && e2.code === 'ENOENT') ? { state: 'absent' } : { state: 'unreadable', code: (e2 && e2.code) || 'UNKNOWN' }
      }
      if (dirStat.isSymbolicLink()) {
        try { fs.statSync(dir) } catch (e3) { return { state: 'unreadable', code: (e3 && e3.code) || 'UNKNOWN' } }
      }
      return { state: 'absent' }
    }
    return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN' }
  }
  if (st.isSymbolicLink()) {
    try { st = fs.statSync(filePath) } catch (e) { return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN' } }
  }
  if (st.isDirectory()) return { state: 'unreadable', code: 'EISDIR' }
  if (!st.isFile()) return { state: 'unreadable', code: 'ENOTREG' }
  return { state: 'ok' }
}

function readIndexOrThrow(filePath, retried = false) {
  let fd
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const verdict = classifyIndexFile(filePath)
      if (verdict.state === 'absent') return null
      if (verdict.state === 'ok') {
        if (retried) return null
        return readIndexOrThrow(filePath, true)
      }
      const err = new Error(`episode index unreadable (${verdict.code}) (${filePath})`)
      err.code = verdict.code
      throw err
    }
    const err = new Error(`episode index unreadable (${(e && e.code) || 'UNKNOWN'}) (${filePath})`)
    err.code = (e && e.code) || 'UNKNOWN'
    throw err
  }
  try {
    let st
    try {
      st = fs.fstatSync(fd)
    } catch (e) {
      const err = new Error(`episode index unreadable (${(e && e.code) || 'UNKNOWN'}) (${filePath})`)
      err.code = (e && e.code) || 'UNKNOWN'
      throw err
    }
    if (!st.isFile()) {
      const code = st.isDirectory() ? 'EISDIR' : 'ENOTREG'
      const err = new Error(`episode index unreadable (${code}) (${filePath})`)
      err.code = code
      throw err
    }
    try {
      return fs.readFileSync(fd, 'utf8')
    } catch (e) {
      const err = new Error(`episode index unreadable (${(e && e.code) || 'UNKNOWN'}) (${filePath})`)
      err.code = (e && e.code) || 'UNKNOWN'
      throw err
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Handles the simple subset we produce: scalar values and inline arrays.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const lines = match[1].split('\n')
  const data = {}
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    const arrMatch = raw.match(/^\[(.*)\]$/)
    if (arrMatch) {
      data[key] = arrMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    } else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      data[key] = raw.slice(1, -1)
    } else {
      data[key] = raw === 'null' ? null : raw
    }
  }
  return data
}

function rebuildDir(dataDir, label) {
  const episodesDir = path.join(dataDir, 'episodes')
  const indexFile = path.join(dataDir, 'index.jsonl')

  // #653: classify index.jsonl BEFORE any write — the absent-episodesDir
  // branch below writes indexFile DIRECTLY (not via tmp+rename), so a
  // FIFO-shaped index.jsonl there would otherwise block forever.
  const shape = classifyIndexFile(indexFile)
  if (shape.state === 'unreadable') {
    throw Object.assign(new Error(`episode index unreadable (${shape.code}) (${indexFile})`), { code: shape.code, scope: label })
  }

  if (!fs.existsSync(episodesDir)) {
    fs.mkdirSync(episodesDir, { recursive: true })
    fs.writeFileSync(indexFile, '', 'utf8')
    return { scope: label, count: 0 }
  }

  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith('.md')).sort()
  const entries = []
  const warnings = []

  for (const file of files) {
    // #653: lstat-classify before read — a FIFO-shaped episode file is not
    // a parseable episode; skip + warn instead of hanging the rebuild.
    const filePath = path.join(episodesDir, file)
    if (classifyIndexFile(filePath).state !== 'ok') {
      warnings.push(`skipped ${file}: not a regular file`)
      continue
    }
    const content = fs.readFileSync(filePath, 'utf8')
    const fm = parseFrontmatter(content)
    if (!fm || !fm.id) continue
    entries.push(JSON.stringify({
      id: fm.id,
      date: fm.date,
      time: fm.time,
      project: fm.project,
      category: fm.category,
      status: fm.status || 'active',
      supersedes: fm.supersedes || null,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      summary: fm.summary,
      ...(fm.url ? { url: fm.url, fetched: fm.fetched || fm.date } : {})
    }))
  }

  const tmpFile = indexFile + '.tmp'
  fs.writeFileSync(tmpFile, entries.join('\n') + (entries.length ? '\n' : ''), 'utf8')
  fs.renameSync(tmpFile, indexFile)

  return { scope: label, count: entries.length, ...(warnings.length ? { warnings } : {}) }
}

const rebuilt = []
try {
  if (scope === 'local' || scope === 'all') rebuilt.push(rebuildDir(LOCAL_DIR, 'local'))
  if (scope === 'global' || scope === 'all') rebuilt.push(rebuildDir(GLOBAL_DIR, 'global'))
  console.log(JSON.stringify({ status: 'ok', rebuilt }))
} catch (e) {
  console.log(JSON.stringify({ status: 'error', scope: e.scope, message: `em-rebuild-index: ${e.message}`, ...(e.code ? { code: `index-unreadable:${e.code}` } : {}) }))
  process.exit(1)
}
