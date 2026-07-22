// lib/store-write-lock.mjs — zero-dep synchronous store-write lock + atomic
// replace helper (Issue 546, Slice 546-S1).
//
// Why this file exists: scripts/lib/lock.mjs already owns O_EXCL atomic
// acquisition of <store>/clerk-apply.lock, but it is a single-primitive
// primitive with no canonicalization, no inheritance policy, no multi-store
// ordering, and no same-directory atomic-replace. Every writer that mutates
// an episodic-memory store needs (a) canonical lock identity so a symlink
// alias and its target share one lock, (b) ordered multi-store acquisition
// so revise/move/restore never deadlock on source-vs-destination, (c) live
// parent inheritance so em-promote can hold the lock across its child spawn
// without the child re-acquiring or deadlocking, and (d) collision-safe
// temporary paths so two concurrent writers do not both rename the same
// `<base>.jsonl.tmp` over each other's snapshot.
//
// Contract reference: docs/plans/issue-546-concurrent-store-writes.md §12
// (acquire/release/atomic-replace), §13 (edge cases), §14 (test catalog).
//
// F1 (S1 review): public surface is exactly the six named exports below.
// F2 (S1 review): validate-then-mkdir-then-realpath-then-dedupe-then-sort;
// no lexical identity fallback after mkdir (realpath is required).
// F3 (S1 review): single ordered handles array; inheritance condition is
// strictly heldBy === process.pid or heldBy === process.ppid.
// F4 (S1 review): tmpPath must resolve to the same directory as finalPath
// BEFORE open; full-write loop protects against partial writes.
//
// Zero external deps. Node stdlib only.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { tryAcquire, release as releasePrimitive } from './lock.mjs'

// One basename per store directory. Mirrors the canonical clerk contract.
// F1: required public export name.
export const STORE_WRITE_LOCK_BASENAME = 'clerk-apply.lock'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 50
function resolveTimeoutMs(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'timeoutMs')) {
    return Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  }
  const raw = process.env.EPISODIC_MEMORY_STORE_WRITE_LOCK_TIMEOUT_MS
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_TIMEOUT_MS
}


/**
 * Reusable SharedArrayBuffer-backed Int32Array used as the synchronization
 * primitive for sleepSync. Atomics.wait on this array blocks the current
 * thread for a bounded interval without timers; in contexts where
 * Atomics.wait throws or is unavailable, sleepSync falls back to a
 * bounded Date.now busy-loop instead. The buffer is module-level so all
 * sleeps share one allocation and the wait index (0) is unambiguous.
 */
const SHARED_I32 = new Int32Array(new SharedArrayBuffer(4))

/**
 * Synchronous sleep using Atomics.wait over a module-level reusable
 * SharedArrayBuffer-backed Int32Array. Falls back to a bounded Date.now
 * busy-loop if Atomics.wait throws or is unavailable. The fallback is
 * bounded by `ms` itself — we never spin forever.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  try {
    Atomics.wait(SHARED_I32, 0, 0, ms)
    return
  } catch {
    // This host or execution context does not permit blocking waits.
    // (Node permits Atomics.wait on its main thread.) Fall through to the
    // bounded Date.now busy-loop fallback.
  }
  const end = Date.now() + ms
  while (Date.now() < end) { /* bounded spin */ }
}

/**
 * F1: resolve the canonical lock-file path for a store directory WITHOUT
 * touching the filesystem. Pure path computation; the caller still owns
 * canonicalization at acquire time. Useful for inspection, assertions,
 * and assertion helpers that need to reference the same path the helper
 * uses after canonicalization.
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function storeWriteLockPath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('store directory must be a non-empty string')
  }
  return path.join(dataDir, STORE_WRITE_LOCK_BASENAME)
}

/**
 * @typedef {{lockFile:string, pid:number, inherited:boolean}} StoreWriteLockHandle
 * @typedef {{ok:true, handles:StoreWriteLockHandle[], dirs:string[]}
 *          |{ok:false, code:'store-write-lock-timeout', heldBy:number|null}} StoreWriteLockResult
 */

/**
 * Acquire clerk-apply.lock on every supplied store directory in canonical
 * order. Returns either `ok:true` with one handle per UNIQUE canonical store
 * directory (preserved acquisition order, owned or inherited interleaved in
 * the order each canonical dir was processed), or `ok:false` with a
 * `store-write-lock-timeout` code naming the live owner that prevented
 * acquisition.
 *
 * F2: input is validated with NO filesystem side effect first. We only
 * mkdirSync after the type check, then realpathSync (which now CANNOT
 * ENOENT-fall-back into lexical identity), then dedupe, then lexical sort.
 * F3: one ordered handles array; on timeout we release only the OWNED
 * entries from that array in reverse-acquisition order, leaving inherited
 * entries untouched.
 *
 * @param {string|string[]} dataDirsArg  one path, or an array of paths
 * @param {{timeoutMs?:number, pollMs?:number}} [options]
 * @returns {StoreWriteLockResult}
 */
export function acquireStoreWriteLocksSync(dataDirsArg, options = {}) {
  const dirs = canonicalizeAndSort(dataDirsArg)
  if (!dirs.length) {
    // canonicalizeAndSort already enforces non-empty, but be defensive.
    throw new TypeError('store directory must be an array with at least one element')
  }

  const timeoutMs = resolveTimeoutMs(options)

  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_POLL_MS
  const deadline = Date.now() + Math.max(0, timeoutMs)

  // F3: a single ordered handles array. Owned or inherited are appended in
  // the order each canonical dir was processed; on timeout, reverse-iterate
  // and release ONLY the owned entries.
  /** @type {StoreWriteLockHandle[]} */
  const handles = []

  for (const dir of dirs) {
    const lockFile = path.join(dir, STORE_WRITE_LOCK_BASENAME)
    const outcome = tryAcquireUntil(lockFile, deadline, pollMs)
    if (outcome.kind === 'owned') {
      handles.push({ lockFile, pid: process.pid, inherited: false })
      continue
    }
    if (outcome.kind === 'inherited') {
      handles.push({ lockFile, pid: outcome.heldBy, inherited: true })
      continue
    }
    // timeout: F3 requires reverse-order release of only OWNED handles from
    // this ordered array. Inherited handles in the array are NOT released
    // here — the actual owner (caller's pid or direct parent) remains
    // responsible and an inherited release would corrupt unrelated state.
    releaseOwnedOnly(handles)
    return {
      ok: false,
      code: 'store-write-lock-timeout',
      heldBy: outcome.heldBy,
    }
  }

  return { ok: true, handles, dirs }
}

/**
 * Release the handles returned by acquireStoreWriteLocksSync in REVERSE
 * acquisition order. Inherited handles are NEVER released — the owner
 * (caller's own pid or direct parent pid) remains responsible and will
 * release itself. Repeated calls are safe (releasePrimitive is already
 * idempotent against missing files).
 *
 * @param {StoreWriteLockHandle[] | undefined | null} handles
 */
export function releaseStoreWriteLocks(handles) {
  if (!Array.isArray(handles) || handles.length === 0) return
  for (let i = handles.length - 1; i >= 0; i--) {
    const h = handles[i]
    if (!h || h.inherited) continue
    releasePrimitive({ lockFile: h.lockFile, pid: h.pid })
  }
}

/**
 * Compute a unique same-directory temporary path for atomic replacement of
 * `finalPath`. The temporary name embeds PID plus eight bytes of
 * cryptographic randomness so two writers on the same store never collide.
 *
 * F1: required public export name.
 *
 * @param {string} finalPath
 * @returns {string}
 */
export function uniqueStoreTmpPath(finalPath) {
  if (typeof finalPath !== 'string' || finalPath.length === 0) {
    throw new TypeError('finalPath must be a non-empty string')
  }
  const dir = path.dirname(finalPath)
  const base = path.basename(finalPath)
  const rnd = crypto.randomBytes(8).toString('hex')
  return path.join(dir, `${base}.tmp.${process.pid}.${rnd}`)
}

/**
 * Atomically replace `finalPath` with `data`. Writes to a unique
 * same-directory `wx` (O_EXCL) temporary, fsyncs, closes, then renames. On
 * any failure before the rename, removes only THIS invocation's temporary
 * and rethrows.
 *
 * F4: if `options.tmpPath` is provided, it MUST resolve to the same
 * directory as `finalPath` (cross-device rename is unsafe and crosses
 * the contract's same-directory invariant). The check happens BEFORE
 * any open/write so no temp file is created on rejection. The write uses
 * fs.writeFileSync(fd, data) which guarantees a full-data write loop
 * (a single fs.writeSync can short-write on large buffers).
 *
 * If `options.tmpPath` already exists (EEXIST), the failure is loud: the
 * prior final file AND the pre-existing collision path are preserved (no
 * deletion of paths the call did not create).
 *
 * @param {string} finalPath
 * @param {string|Buffer} data
 * @param {{tmpPath?:string}} [options]
 * @returns {string} the finalPath that was written
 */
export function atomicReplaceFileSync(finalPath, data, options = {}) {
  if (typeof finalPath !== 'string' || finalPath.length === 0) {
    throw new TypeError('finalPath must be a non-empty string')
  }

  // F4: cross-directory tmpPath rejection happens BEFORE any open/write.
  // We resolve both paths and require identical dirname strings; a cross-
  // device tmpPath would silently lose atomicity via fs.renameSync.
  if (options.tmpPath !== undefined) {
    if (typeof options.tmpPath !== 'string' || options.tmpPath.length === 0) {
      throw new TypeError('options.tmpPath must be a non-empty string when provided')
    }
    const finalDir = path.resolve(path.dirname(finalPath))
    const tmpDir = path.resolve(path.dirname(options.tmpPath))
    if (finalDir !== tmpDir) {
      throw new Error(
        `options.tmpPath must resolve to the same directory as finalPath; ` +
        `got tmpDir=${tmpDir} finalDir=${finalDir}`,
      )
    }
  }

  const tmpPath = options.tmpPath || uniqueStoreTmpPath(finalPath)
  const finalDir = path.dirname(finalPath)
  fs.mkdirSync(finalDir, { recursive: true })

  let fd = -1
  let opened = false
  try {
    // O_EXCL (wx): if tmpPath already exists, fail loudly. We never unlink
    // a path we did not create.
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644)
    opened = true
    // F4: full-write loop. fs.writeFileSync(fd, data) loops internally
    // until the entire buffer lands; a single fs.writeSync can short-write
    // on large buffers and silently leave a partial snapshot on disk.
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = -1
    fs.renameSync(tmpPath, finalPath)
    return finalPath
  } catch (err) {
    if (fd !== -1) {
      try { fs.closeSync(fd) } catch { /* best effort */ }
    }
    if (opened) {
      try { fs.unlinkSync(tmpPath) } catch { /* best effort: collision path preserved */ }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Validate the input, ensure every supplied store directory exists, then
 * resolve each through realpathSync, dedupe, and return a lexically-sorted
 * unique list.
 *
 * F2 ordering:
 *   1. Validate type/shape of every entry with NO filesystem side effect.
 *   2. mkdirSync every entry (recursive). This means a store path that
 *      points through a symlinked parent or one that does not yet exist
 *      is now a real on-disk directory before we attempt identity.
 *   3. realpathSync every entry. After mkdir has run, ENOENT is a true
 *      filesystem failure (realpath does NOT fall back to lexical path;
 *      lexical identity would mask the canonical-vs-symlink distinction
 *      that the §12 contract relies on).
 *   4. Dedupe canonical spellings.
 *   5. Lexical sort for deterministic ordered acquisition.
 *
 * @param {unknown} arg  a string or an array of strings
 * @returns {string[]}
 */
function canonicalizeAndSort(arg) {
  // Step 1a: validate positional arg type/shape with NO filesystem side effect.
  let raw
  if (Array.isArray(arg)) {
    raw = arg
  } else if (typeof arg === 'string' && arg.length > 0) {
    raw = [arg]
  } else {
    throw new TypeError('store directory must be a non-empty string')
  }
  if (raw.length === 0) {
    throw new TypeError('store directory must be an array with at least one element')
  }
  // Step 1b: validate every entry's type/shape before touching disk.
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new TypeError('store directory must be a non-empty string')
    }
  }

  // Step 2: mkdirSync every store dir FIRST. After this point every supplied
  // path resolves to an on-disk directory; a missing entry is now an error
  // (or already canonicalized to its realpath destination via the symlink
  // chain the caller passed in).
  const canonDirs = []
  for (const entry of raw) {
    fs.mkdirSync(entry, { recursive: true })
    // Step 3: realpathSync, no lexical-identity fallback. ENOENT here means
    // a real filesystem failure (e.g. permission, vanished dir between
    // mkdir and realpath), not an opportunity to dedupe by spelling.
    canonDirs.push(fs.realpathSync(entry))
  }

  // Step 4: dedupe canonical spellings.
  const seen = new Set()
  const out = []
  for (const c of canonDirs) {
    if (!seen.has(c)) {
      seen.add(c)
      out.push(c)
    }
  }
  // Step 5: lexical sort. §12 requires deterministic ordering for deadlock
  // avoidance — two callers passing the same two stores in different input
  // orders acquire them in the same canonical order.
  out.sort()
  return out
}

/**
 * Poll tryAcquire until we own the lock, inherit a live parent owner, or
 * hit the deadline. F3: inheritance is strictly heldBy === process.pid or
 * heldBy === process.ppid (the in-process re-entry and the em-promote-
 * style direct-child scenarios). A null or any other live PID never
 * inherits — the helper times out instead so the caller never writes
 * through an unowned lock.
 *
 * @returns {{kind:'owned'} | {kind:'inherited', heldBy:number} | {kind:'timeout', heldBy:number|null}}
 */
function tryAcquireUntil(lockFile, deadlineMs, pollMs) {
  // busy wait budget: deadlineMs. Honor caller by sleeping pollMs between
  // attempts. Spin instead of recursing so we can re-evaluate deadlines.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const attempt = tryAcquire(lockFile)
    if (attempt.ok) return { kind: 'owned' }

    const heldBy = attempt.heldBy
    // F3 inheritance gate: ONLY current PID (in-process re-entry, e.g. the
    // clerk's nested call) or current direct-parent PID (em-promote-style
    // spawn) qualifies. heldBy:null (malformed), foreign live PIDs, and
    // grand-parent PIDs do NOT inherit and must time out so the caller
    // never mutates state under an unowned lock. There is no multi-store
    // inheritedOwner shortcut — every canonical dir is judged independently.
    if (typeof heldBy === 'number' && heldBy > 0) {
      if (heldBy === process.pid || heldBy === process.ppid) {
        return { kind: 'inherited', heldBy }
      }
    }

    if (Date.now() >= deadlineMs) {
      return { kind: 'timeout', heldBy: typeof heldBy === 'number' && heldBy > 0 ? heldBy : null }
    }
    // Sleep, but cap at remaining budget. We deliberately do not use
    // setTimeout — this whole helper is synchronous by contract (§12).
    // sleepSync uses Atomics.wait over a module-level reusable
    // SharedArrayBuffer-backed Int32Array, with a bounded Date.now
    // busy-loop fallback for the rare context where Atomics.wait throws
    // or is unavailable. Either way the sleep is bounded by `sleep`.
    const remaining = deadlineMs - Date.now()
    const sleep = Math.max(1, Math.min(pollMs, remaining))
    sleepSync(sleep)
  }
}

/**
 * F3: on acquisition timeout, release only the OWNED entries of an ordered
 * handles array, in reverse-acquisition order. Inherited entries are
 * skipped — the real owner (caller's pid or direct parent pid) is
 * responsible for releasing its own lock. After running, the array is
 * emptied so the caller's failure path can safely discard it without risk
 * of double-release on a re-attempt.
 *
 * @param {StoreWriteLockHandle[]} handles
 */
function releaseOwnedOnly(handles) {
  for (let i = handles.length - 1; i >= 0; i--) {
    const h = handles[i]
    if (!h || h.inherited) continue
    releasePrimitive({ lockFile: h.lockFile, pid: h.pid })
  }
  handles.length = 0
}
