/**
 * bp1-run-state.mjs — Per-project run-state index helpers (RFC-004 §800,
 * Resolution 2).
 *
 * Source-of-truth file: `<projectRoot>/.episodic-memory/runs/_index.json`
 *
 * ```
 * {
 *   "schema_version": 1,
 *   "runs": {
 *     "<run_id>": {
 *       "project_root": "<canonicalized realpath>",
 *       "state": "active|complete|aborted|abandoned|archived",
 *       "created_at": "<ISO-8601 UTC>",
 *       "terminal_at": "<ISO-8601 UTC | null>"
 *     }
 *   }
 * }
 * ```
 *
 * ## Concurrency contract (codex round-1 RC1 + round-2 stale-lock fix)
 *
 * All writes are linearizable via a lockdir at
 * `<projectRoot>/.episodic-memory/runs/_index.lock`, acquired via atomic
 * `fs.mkdirSync` (POSIX atomic; cross-platform on Node).
 *
 * Stale-lock detection has two tiers:
 *   - Tier 1: read PID/timestamp file inside the lockdir. If parsable and old
 *     enough → stale.
 *   - Tier 2 (codex round-2 fix): if PID file missing/malformed/unreadable
 *     (acquisition-window crash between `mkdirSync` and pid-file write),
 *     fall back to lockdir's `mtimeMs`. POSIX `mkdir` sets directory mtime
 *     to creation time; same staleness threshold applies.
 *
 * Per-process unique temp filenames prevent shared-tmp collision; orphan
 * cleanup happens only inside the lock, never deleting a live writer's temp.
 *
 * Filesystem scoping: this contract assumes local POSIX-like filesystem
 * semantics (atomic mkdir + per-inode monotonic mtime). NFS/CIFS are
 * best-effort. Distributed-FS support is a future RFC.
 *
 * ## Public API
 *
 *   loadIndex(projectRoot) → { schema_version: 1, runs: {...} } | throws on corrupt
 *   appendRun(projectRoot, runId, projectRootCanonical) → { ok: true } | { error }
 *   markTerminal(projectRoot, runId, terminalState) → { ok: true } | { error }
 *   getRunState(projectRoot, runId) → { ... } | null  (read-only, NO lock)
 *   indexPath(projectRoot) → string
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SCHEMA_VERSION = 1
const VALID_TERMINAL_STATES = Object.freeze(['complete', 'aborted', 'abandoned', 'archived'])

const LOCK_DIR_NAME = '_index.lock'
const STALE_LOCK_MS = 30_000        // 30s — covers I/O + child-process latency
const LOCK_RETRY_MS = 50            // poll interval when contended
const LOCK_MAX_ATTEMPTS = 200       // ~10s total wait before timeout

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} projectRoot
 * @returns {string}
 */
export function indexPath(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'runs', '_index.json')
}

function lockDirPath(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'runs', LOCK_DIR_NAME)
}

function runsDir(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'runs')
}

// ---------------------------------------------------------------------------
// Lockdir mutex (codex round-1 RC1 + round-2 mtime fallback)
// ---------------------------------------------------------------------------

/**
 * Run `fn()` exclusively for the project's run-state index.
 *
 * Acquires lockdir via atomic mkdirSync; writes PID+timestamp inside for
 * tier-1 stale detection; always releases in `finally`. Stale-lock holders
 * are broken after STALE_LOCK_MS via two-tier check (PID metadata or
 * lockdir mtime).
 *
 * @template T
 * @param {string} projectRoot
 * @param {() => T} fn
 * @returns {T}
 * @throws {{ code: 'lock-timeout' }}
 */
function withRunStateLock(projectRoot, fn) {
  const lockDir = lockDirPath(projectRoot)
  fs.mkdirSync(path.dirname(lockDir), { recursive: true })

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      fs.mkdirSync(lockDir)               // atomic: EEXIST means held
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (isLockStale(lockDir)) {
        // Break stale lock — only the staleness check + rm here, NEVER touch
        // shared temp files outside the lock.
        try {
          fs.rmSync(lockDir, { recursive: true, force: true })
        } catch (_rmErr) {
          // Lockdir vanished mid-rm (another writer broke it concurrently).
          // Loop and retry mkdirSync.
        }
        continue
      }
      // Live lock — deterministic backoff.
      sleep(LOCK_RETRY_MS)
      continue
    }

    // Lock acquired. Write PID+timestamp for stale detection (best-effort —
    // tier-2 mtime fallback covers the case where this write fails or is
    // interrupted by a crash before completion).
    try {
      try {
        fs.writeFileSync(
          path.join(lockDir, 'pid'),
          `${process.pid}\n${Date.now()}\n`,
          { mode: 0o600 },
        )
      } catch (_pidErr) {
        // Best-effort: tier-2 mtime fallback covers stale detection if pid write fails.
      }
      return fn()
    } finally {
      // Always remove lockdir on exit (success or throw inside fn).
      try {
        fs.rmSync(lockDir, { recursive: true, force: true })
      } catch (_rmErr) {
        // Already gone; benign.
      }
    }
  }
  const err = new Error('run-state lock timeout')
  err.code = 'lock-timeout'
  throw err
}

/**
 * Two-tier stale-lock detection.
 *   Tier 1: parse `<lockDir>/pid` timestamp. If valid → stale iff now-ts > STALE_LOCK_MS.
 *   Tier 2: fall back to fs.statSync(lockDir).mtimeMs. POSIX `mkdir` sets mtime
 *     to creation time; covers acquisition-window crashes (pid not yet written).
 *
 * @param {string} lockDir
 * @returns {boolean}
 */
function isLockStale(lockDir) {
  // Tier 1: PID file timestamp (preferred — explicit holder metadata).
  try {
    const content = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim()
    const lines = content.split('\n')
    const ts = Number(lines[1])
    if (!Number.isNaN(ts) && ts > 0) {
      return (Date.now() - ts) > STALE_LOCK_MS
    }
    // PID file present but malformed — fall through to tier-2.
  } catch (_e) {
    // PID file missing or unreadable — fall through to tier-2.
    // Acquisition-window crash (between mkdirSync and pid-file-write) lands here.
  }

  // Tier 2 (codex round-2 fix): lockdir mtime fallback.
  try {
    const mtime = fs.statSync(lockDir).mtimeMs
    return (Date.now() - mtime) > STALE_LOCK_MS
  } catch (_e) {
    // Lockdir gone between contention check and stat (another writer broke it).
    // Treat as not-stale; let the next mkdirSync attempt naturally succeed.
    return false
  }
}

/**
 * Synchronous sleep using Atomics.wait on a transient SharedArrayBuffer.
 * Node 18+ supports this primitive in the main thread; lighter than spawning
 * a child process for `sleep`.
 *
 * @param {number} ms
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read + parse `_index.json`. Returns empty default when file is missing.
 * Throws on corrupt JSON (RC3 — never silently reset).
 *
 * @param {string} projectRoot
 * @returns {{ schema_version: 1, runs: Record<string, object> }}
 */
export function loadIndex(projectRoot) {
  const p = indexPath(projectRoot)
  let text
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { schema_version: SCHEMA_VERSION, runs: {} }
    throw e
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const err = new Error(`run-state index corrupt: ${e.message}`)
    err.code = 'corrupt'
    err.detail = e.message
    throw err
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schema_version !== SCHEMA_VERSION) {
    const err = new Error(`run-state index missing/wrong schema_version (expected ${SCHEMA_VERSION})`)
    err.code = 'corrupt'
    throw err
  }
  if (!parsed.runs || typeof parsed.runs !== 'object') {
    parsed.runs = {}
  }
  return parsed
}

/**
 * Atomic-write the index file. Per-process unique temp filename
 * (codex round-1 RC2 fix); orphan cleanup happens only inside the lock.
 *
 * @param {string} projectRoot
 * @param {object} idx
 */
function writeIndex(projectRoot, idx) {
  const target = indexPath(projectRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmpPath = `${target}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmpPath, JSON.stringify(idx, null, 2) + '\n')
  fs.renameSync(tmpPath, target)
}

/**
 * Best-effort cleanup of orphan tmp files inside the runs/ dir. Called
 * inside `withRunStateLock` only — the lock guarantees no live writer's
 * tmp is at risk.
 *
 * @param {string} projectRoot
 */
function cleanupOrphanTmps(projectRoot) {
  const dir = runsDir(projectRoot)
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch (_e) {
    return  // Dir not yet present.
  }
  const baseName = path.basename(indexPath(projectRoot))
  const tmpPrefix = `${baseName}.tmp.`
  for (const name of entries) {
    if (!name.startsWith(tmpPrefix)) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch (_e) {
      // Benign — another concurrent cleanup raced us.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: appendRun, markTerminal, getRunState
// ---------------------------------------------------------------------------

/**
 * Append a new run to `_index.json`. Wrapped in withRunStateLock.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @param {string} projectRootCanonical
 * @returns {{ ok: true, run: object } | { error: 'collision'|'lock-timeout' }}
 */
export function appendRun(projectRoot, runId, projectRootCanonical) {
  try {
    return withRunStateLock(projectRoot, () => {
      cleanupOrphanTmps(projectRoot)
      const idx = loadIndex(projectRoot)
      if (idx.runs[runId]) {
        return { error: 'collision' }
      }
      const run = {
        project_root: projectRootCanonical,
        state: 'active',
        created_at: new Date().toISOString(),
        terminal_at: null,
      }
      idx.runs[runId] = run
      writeIndex(projectRoot, idx)
      return { ok: true, run }
    })
  } catch (e) {
    if (e && e.code === 'lock-timeout') return { error: 'lock-timeout' }
    throw e
  }
}

/**
 * Mark a run terminal. PR-1c-A ships the helper for boundary cleanliness;
 * full state-machine tests in PR-1c-B's finalize-run.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @param {string} terminalState — must be one of VALID_TERMINAL_STATES
 * @returns {{ ok: true } | { error: 'missing'|'already-terminal'|'invalid-state'|'lock-timeout' }}
 */
export function markTerminal(projectRoot, runId, terminalState) {
  if (!VALID_TERMINAL_STATES.includes(terminalState)) {
    return { error: 'invalid-state' }
  }
  try {
    return withRunStateLock(projectRoot, () => {
      cleanupOrphanTmps(projectRoot)
      const idx = loadIndex(projectRoot)
      const run = idx.runs[runId]
      if (!run) return { error: 'missing' }
      if (run.state !== 'active') return { error: 'already-terminal' }
      run.state = terminalState
      run.terminal_at = new Date().toISOString()
      writeIndex(projectRoot, idx)
      return { ok: true }
    })
  } catch (e) {
    if (e && e.code === 'lock-timeout') return { error: 'lock-timeout' }
    throw e
  }
}

/**
 * Read-only inspection — does NOT acquire lock. fs.readFileSync is atomic
 * on POSIX, so callers see either the previous valid state or the new state
 * (never partial). Intended for non-critical inspection / diagnostics.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {object | null}
 */
export function getRunState(projectRoot, runId) {
  let idx
  try {
    idx = loadIndex(projectRoot)
  } catch (_e) {
    return null
  }
  return idx.runs[runId] || null
}
