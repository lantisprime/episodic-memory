// index-state.mjs — lstat-based index.jsonl existence classifier (issue #651).
//
// existsSync(index.jsonl) is not a reliable existence check: it returns false
// for a symlink loop, a dangling symlink, or an index under an EACCES parent
// (silent fail-open — the loader takes its missing-store branch and evidence
// silently disappears), and true for a FIFO (an unguarded readFileSync then
// blocks forever). classifyIndexFile draws the distinction loaders actually
// need — 'absent' (genuinely no store, keep today's [] / skip / create) vs
// 'unreadable' (a defect: abort typed, never silently degrade, never open).
//
// Zero external dependencies — Node.js stdlib only. fsMod injection mirrors
// protection.mjs's existing injected-fs signature.

import path from 'node:path'

// classifyParent(fsMod, filePath) — invoked only when lstat(filePath) itself
// threw ENOENT, to distinguish "no store at all" from "store dir is a broken
// symlink" (a dangling/looping .episodic-memory is a defect, not an absent
// store — audit P2).
function classifyParent(fsMod, filePath) {
  const dir = path.dirname(filePath)
  let dirStat
  try {
    dirStat = fsMod.lstatSync(dir)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' } // no store dir either — genuinely missing
    return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN', detail: 'parent inspection failed' }
  }
  if (dirStat.isSymbolicLink()) {
    try {
      fsMod.statSync(dir)
    } catch (e) {
      return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN', detail: 'broken parent (dangling/loop)' }
    }
  }
  return { state: 'absent' } // store dir exists (or resolves cleanly), index genuinely missing
}

// classifyIndexFile(fsMod, filePath) — the §2 contract table, lstat-based so a
// symlink is inspected before being followed. Never opens the file.
export function classifyIndexFile(fsMod, filePath) {
  let st
  try {
    st = fsMod.lstatSync(filePath)
  } catch (e) {
    if (e && e.code === 'ENOENT') return classifyParent(fsMod, filePath) // absent vs broken-parent
    return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN', detail: 'lstat failed' }
  }
  if (st.isSymbolicLink()) {
    try {
      st = fsMod.statSync(filePath)
    } catch (e) {
      if (e && e.code === 'ENOENT') return { state: 'unreadable', code: 'ENOENT', detail: 'dangling symlink' }
      return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN', detail: 'symlink resolution failed' }
    }
  }
  if (st.isDirectory()) return { state: 'unreadable', code: 'EISDIR', detail: 'index is a directory' }
  if (!st.isFile()) return { state: 'unreadable', code: 'ENOTREG', detail: 'index is not a regular file' }
  return { state: 'ok' }
}

// IndexUnreadableError — the typed abort every loader throws for an
// 'unreadable' classification (or a read failure after an 'ok' classification
// — the file-mode-000 / post-classify swap-to-dir race, §2 last row). Message
// shape matches the #628 envelope family the existing tests regex against
// (/episode index unreadable/, /index\.jsonl/).
export class IndexUnreadableError extends Error {
  constructor(filePath, code, detail) {
    super(`episode index unreadable (${code}) (${filePath})`)
    this.code = code
    this.file = filePath
    this.detail = detail
  }
}

// assertReadableIndex(fsMod, filePath) — returns 'absent' | 'ok'; throws
// IndexUnreadableError on 'unreadable'. Classification only — never reads.
export function assertReadableIndex(fsMod, filePath) {
  const result = classifyIndexFile(fsMod, filePath)
  if (result.state === 'absent') return 'absent'
  if (result.state === 'ok') return 'ok'
  throw new IndexUnreadableError(filePath, result.code, result.detail)
}

// readIndexFileOrThrow(fsMod, filePath) — classify, then read. 'absent' ->
// null (caller's missing-store branch); 'ok' -> file contents, with any read
// failure (file-mode-000 EACCES, or a post-classify swap to directory) wrapped
// into IndexUnreadableError so no raw fs stack ever reaches a caller.
export function readIndexFileOrThrow(fsMod, filePath) {
  const state = assertReadableIndex(fsMod, filePath)
  if (state === 'absent') return null
  try {
    return fsMod.readFileSync(filePath, 'utf8')
  } catch (e) {
    throw new IndexUnreadableError(filePath, (e && e.code) || 'UNKNOWN', 'read failed')
  }
}
