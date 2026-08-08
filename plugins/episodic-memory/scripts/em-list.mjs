#!/usr/bin/env node
/**
 * em-list.mjs — List recent episodic memories.
 *
 * Usage:
 *   node em-list.mjs [--project <name>] [--limit <n>] [--scope local|global|all]
 *                    [--include-superseded]
 *
 * Outputs JSON: { status, count, episodes: [...] }
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

const project = flag('--project')
const limit = parseInt(flag('--limit') || '10', 10)
const scope = flag('--scope') || 'all'
const includeSuperseded = argv.includes('--include-superseded')

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

function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  const raw = readIndexOrThrow(indexFile)
  if (raw === null) return []
  return raw.trim().split('\n').filter(Boolean).map(line => {
    try {
      const entry = JSON.parse(line)
      entry._source = source
      return entry
    } catch { return null }
  }).filter(Boolean)
}

let results = []
try {
  if (scope === 'local' || scope === 'all') results.push(...loadIndex(LOCAL_DIR, 'local'))
  if (scope === 'global' || scope === 'all') results.push(...loadIndex(GLOBAL_DIR, 'global'))
} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: `em-list: ${e.message}`, code: `index-unreadable:${e.code}` }))
  process.exit(1)
}

// Dedupe by id (local takes priority)
const seen = new Set()
results = results.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})

if (!includeSuperseded) {
  results = results.filter(e => e.status !== 'superseded')
}
if (project) {
  results = results.filter(e => e.project === project)
}

results.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
results = results.slice(0, limit)

const output = results.map(({ _source, ...rest }) => ({ ...rest, source: _source }))
console.log(JSON.stringify({ status: 'ok', count: output.length, episodes: output }))
