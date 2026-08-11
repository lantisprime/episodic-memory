// index-state.mjs — lstat-based index.jsonl existence classifier (issue #651)
// + fd-based classify-and-read (issue #653 D1).
//
// existsSync(index.jsonl) is not a reliable existence check: it returns false
// for a symlink loop, a dangling symlink, or an index under an EACCES parent
// (silent fail-open — the loader takes its missing-store branch and evidence
// silently disappears), and true for a FIFO (an unguarded readFileSync then
// blocks forever). classifyIndexFile draws the distinction loaders actually
// need — 'absent' (genuinely no store, keep today's [] / skip / create) vs
// 'unreadable' (a defect: abort typed, never silently degrade, never open).
//
// D1 (issue #653): classifyIndexFile/assertReadableIndex are lstat-only and
// NEVER open the file, by design (safe to call on a FIFO). The historical
// readIndexFileOrThrow paired a classify() with a SEPARATE path-based read()
// — two syscalls with a race window between them. A regular->FIFO swap inside
// that window re-opens the hang the classifier exists to prevent.
// openReadableIndex closes that window: ONE open() (O_NONBLOCK, so a
// writer-less FIFO returns immediately instead of blocking) + fstat() on the
// resulting fd, and — only when fstat confirms a regular file — a read from
// that SAME fd. The object fstat classified is the object read; there is no
// second syscall for a swap to land between.
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
// symlink is inspected before being followed. Never opens the file. UNCHANGED
// by #653 — this stays the classification-only primitive; openReadableIndex
// below is the new fd-based read path that closes D1.
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
// (/episode index unreadable/, /index\.jsonl/). UNCHANGED — byte-frozen.
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
// UNCHANGED.
export function assertReadableIndex(fsMod, filePath) {
  const result = classifyIndexFile(fsMod, filePath)
  if (result.state === 'absent') return 'absent'
  if (result.state === 'ok') return 'ok'
  throw new IndexUnreadableError(filePath, result.code, result.detail)
}

// openReadableIndex(fsMod, filePath) — fd-based classify-and-read (closes D1).
// ONE open(O_RDONLY|O_NONBLOCK) + fstat(fd); only a regular file is read, and
// the read reuses the SAME fd fstat just classified — no second syscall, so
// no window for a regular->non-regular swap to land in. Contract identical to
// the pre-#653 readIndexFileOrThrow: null (absent) | string content (ok) |
// throws IndexUnreadableError (unreadable, incl. a read failure on a fd that
// fstat confirmed regular — file-mode-000 EACCES, or an fstat/read errno).
//
// Open-error handling (audit F4): O_NONBLOCK makes a writer-less FIFO open
// return immediately rather than block, but the FILE MAY NOT EXIST AT ALL —
// open() then fails ENOENT, which classify() alone would resolve more
// precisely (absent vs. dangling-symlink vs. broken-parent) than a bare
// open() errno can. So an ENOENT from open() delegates to classifyIndexFile:
// its 'absent' -> null; its 'unreadable' (dangling symlink, broken parent)
// -> typed throw with the classifier's own code/detail; its 'ok' means the
// file was CREATED between our open() and this classify() — retry the open
// ONCE (a second ENOENT then returns null rather than looping). Any other
// open() errno (EACCES, ELOOP, ...) throws typed directly — classification
// would not tell us more than the open() errno already does.
//
// FD hygiene (audit F5): once open() succeeds, every path below closes the
// fd via try/finally, exactly once. readFileSync(fd) does NOT close the fd
// (unlike readFileSync(path)) — an early throw from fstat must not leak it.
export function openReadableIndex(fsMod, filePath) {
  return openReadableIndexAttempt(fsMod, filePath, false)
}

function openReadableIndexAttempt(fsMod, filePath, retried) {
  const O_NONBLOCK_READ = fsMod.constants.O_RDONLY | fsMod.constants.O_NONBLOCK
  let fd
  try {
    fd = fsMod.openSync(filePath, O_NONBLOCK_READ)
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const verdict = classifyIndexFile(fsMod, filePath)
      if (verdict.state === 'absent') return null
      if (verdict.state === 'ok') {
        if (retried) return null // gone again on the second try — treat as absent
        return openReadableIndexAttempt(fsMod, filePath, true)
      }
      throw new IndexUnreadableError(filePath, verdict.code, verdict.detail)
    }
    throw new IndexUnreadableError(filePath, (e && e.code) || 'UNKNOWN', 'open failed')
  }
  try {
    let st
    try {
      st = fsMod.fstatSync(fd)
    } catch (e) {
      throw new IndexUnreadableError(filePath, (e && e.code) || 'UNKNOWN', 'fstat failed')
    }
    if (st.isDirectory()) throw new IndexUnreadableError(filePath, 'EISDIR', 'index is a directory')
    if (!st.isFile()) throw new IndexUnreadableError(filePath, 'ENOTREG', 'index is not a regular file')
    try {
      return fsMod.readFileSync(fd, 'utf8')
    } catch (e) {
      throw new IndexUnreadableError(filePath, (e && e.code) || 'UNKNOWN', 'read failed')
    }
  } finally {
    fsMod.closeSync(fd)
  }
}

// readIndexFileOrThrow — the pre-#653 public name, kept for the ~20 existing
// call sites (relevance.mjs, protection.mjs, topic-tracks/engine.mjs, and
// every script that imports it directly). Same function: fd-based
// classify-and-read closes D1 for every transitive caller without any call
// site needing to change.
export const readIndexFileOrThrow = openReadableIndex

// readSidecarOrDegrade(fsMod, filePath) — for ADVISORY sidecar/registry
// readers that must never open a non-regular file and must never abort:
// fd-based classify-and-read, collapsing BOTH 'absent' and 'unreadable' to
// null so callers degrade uniformly (existing warning/linear-fallback path).
// Used by lib/relevance.mjs's tags/category/tokens loaders, lib/embeddings.mjs,
// and install-version.mjs's consumer-registry reader.
export function readSidecarOrDegrade(fsMod, filePath) {
  try {
    return openReadableIndex(fsMod, filePath)
  } catch (e) {
    // #653 review FIX-H: narrow the catch to the expected error class — a
    // programming error inside openReadableIndex (not a store defect) must
    // still surface, not be silently swallowed into "advisory degrade".
    if (e instanceof IndexUnreadableError) return null
    throw e
  }
}

// unreadableMessage(tool, role, err) — Family A abort message builder for a
// writer-preflight classify site. IndexUnreadableError's own .message is
// byte-frozen to the literal "episode index unreadable" wording for the
// primary index.jsonl call sites tests regex against; a sidecar file (tags.json,
// category-index.json, tokens.json, ...) needs its own role in the sentence,
// so callers build the message from err.code/err.file instead of err.message.
// For role 'episode index' this reproduces the pinned wording exactly.
export function unreadableMessage(tool, role, err) {
  return `${tool}: ${role} unreadable (${err.code}) (${err.file})`
}

// roleForFile(filePath) — derive unreadableMessage's `role` argument from a
// store-dir file's basename (#653 review FIX-C). Used by in-lock TOCTOU
// catches that funnel throws from MULTIPLE possible files (index.jsonl,
// tags.json, category-index.json, tokens.json) through ONE catch block, so
// the role can't be hardcoded per call site the way the preflight loops do.
const FILE_ROLE_BY_BASENAME = {
  'index.jsonl': 'episode index',
  'tags.json': 'tags index',
  'category-index.json': 'category index',
  'tokens.json': 'token index',
}
export function roleForFile(filePath) {
  return FILE_ROLE_BY_BASENAME[path.basename(filePath)] || 'episode index'
}

// ---------------------------------------------------------------------------
// Episode-body fd-based read helpers (issues #666/#667). Same fd-based
// classify-and-read pattern as openReadableIndex above (ONE open(O_RDONLY|
// O_NONBLOCK) + fstat(fd) + read from that SAME fd) — store-identity.mjs:114
// already proves the pattern generalizes to any store-dir file, not just
// index.jsonl. Body files get their OWN error class (BodyUnreadableError)
// and their own wire-code family (`episode-unreadable:<CODE>`) rather than
// reusing IndexUnreadableError/roleForFile: roleForFile's basename map does
// not generalize to `<id>.md` filenames, and the two families are
// semantically distinct (an unreadable BODY is not an unreadable INDEX).
// ---------------------------------------------------------------------------

// BodyUnreadableError — typed abort for a single-target body read
// (openReadableBody). Fields mirror IndexUnreadableError: .code/.file.
export class BodyUnreadableError extends Error {
  constructor(filePath, code) {
    super(`episode body unreadable (${code}) (${filePath})`)
    this.code = code
    this.file = filePath
  }
}

// readBodyOrSkip(fsMod, filePath) -> { ok:true, raw } | { ok:false, code } —
// never throws, never blocks. For per-row iteration in query tools and
// advisory reads: 'absent' and 'unreadable' both collapse to ok:false with
// the classify code (ENOENT | EISDIR | ENOTREG | ...); the CALLER decides
// warn-vs-silent per code (F5 rule: non-ENOENT warns, ENOENT stays silent).
export function readBodyOrSkip(fsMod, filePath) {
  const O_NONBLOCK_READ = fsMod.constants.O_RDONLY | fsMod.constants.O_NONBLOCK
  let fd
  try {
    fd = fsMod.openSync(filePath, O_NONBLOCK_READ)
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'UNKNOWN' }
  }
  try {
    let st
    try {
      st = fsMod.fstatSync(fd)
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'UNKNOWN' }
    }
    if (st.isDirectory()) return { ok: false, code: 'EISDIR' }
    if (!st.isFile()) return { ok: false, code: 'ENOTREG' }
    try {
      return { ok: true, raw: fsMod.readFileSync(fd, 'utf8') }
    } catch (e) {
      return { ok: false, code: (e && e.code) || 'UNKNOWN' }
    }
  } finally {
    fsMod.closeSync(fd)
  }
}

// openReadableBody(fsMod, filePath) -> raw string | null on absent (mirrors
// openReadableIndex's absent contract); throws BodyUnreadableError on
// unreadable. For single-target reads where the caller asked for THAT
// episode. Callers MUST handle the null return explicitly. Built on top of
// readBodyOrSkip rather than duplicating the fd-based pattern — the two
// helpers share ONE primitive, differing only in how they surface a defect
// (return vs throw).
export function openReadableBody(fsMod, filePath) {
  const r = readBodyOrSkip(fsMod, filePath)
  if (r.ok) return r.raw
  if (r.code === 'ENOENT') return null
  throw new BodyUnreadableError(filePath, r.code)
}
