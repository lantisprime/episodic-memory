/**
 * bp1-run-state.mjs — Per-project run-state index helpers (RFC-004 §800,
 * Resolution 2; slice 2c v2 schema + API split).
 *
 * Source-of-truth file: `<projectRoot>/.episodic-memory/runs/_index.json`
 *
 * ```
 * {
 *   "schema_version": 2,
 *   "runs": {
 *     "<run_id>": {
 *       "project_root": "<canonicalized realpath>",
 *       "state": "active|rfc-detected|classifier-dispatch-pending|classified|
 *                planning|needs-human|complete|aborted|abandoned|archived",
 *       "created_at": "<ISO-8601 UTC>",
 *       "terminal_at": "<ISO-8601 UTC | null>",
 *       "decided_class": "trivial|schema|validator|security|multi-actor|
 *                        needs-human-input|null",
 *       "pre_episode_id": "<id>|null",
 *       "rfc_detected_episode_id": "<id>|null",
 *       "classified_episode_id": "<id>|null",
 *       "route_episode_id": "<id>|null"
 *     }
 *   }
 * }
 * ```
 *
 * `classified_episode_id` / `route_episode_id` (cluster #286/#287/#288): the
 * signed state-transition episodes emitted at the `classified` and
 * `planning|needs-human` transitions. Phase A/B split in `record-classification`
 * persists these mid-flight so resume after a crash can chain off the correct
 * parent episode. Both default to null; soft schema addition (no
 * schema_version bump) — existing v2 rows are normalized to null on read via
 * `migrateV1ToV2`'s v2 branch.
 *
 * ## API split (slice 2c CR2-3)
 *
 * `loadIndex` used to be the only entry point. It called `withRunStateLock`
 * internally when migration was needed. `appendRun` + `markTerminal` also
 * acquire `withRunStateLock`, then called `loadIndex` from inside — which
 * deadlocked when the on-disk index was v1 (loadIndex tries to re-acquire
 * the lock). The split:
 *
 *   - `readIndexNoMigrate(projectRoot)` — pure read, returns raw v1 or v2.
 *     For validators / inspection that don't need migration.
 *   - `loadIndex(projectRoot)` — public. Acquires `withRunStateLock` if
 *     migration is needed (v1 detected). Returns v2 every time.
 *   - `loadIndexLocked(projectRoot)` — caller MUST already hold
 *     `withRunStateLock`. Reads + in-memory migrates. Caller writes via
 *     `writeIndex` before releasing the lock if migration occurred.
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
 *   readIndexNoMigrate(projectRoot) → { schema_version: 1|2, runs: {...} } | throws on corrupt
 *   loadIndex(projectRoot) → { schema_version: 2, runs: {...} } | throws on corrupt
 *   loadIndexLocked(projectRoot) → { schema_version: 2, runs: {...} } (caller holds lock)
 *   writeIndex(projectRoot, idx) — atomic write (caller holds lock)
 *   appendRun(projectRoot, runId, projectRootCanonical) → { ok: true } | { error }
 *   markTerminal(projectRoot, runId, terminalState) → { ok: true } | { error }
 *   updateRunState(projectRoot, runId, patch) → { ok: true } | { error }
 *   getRunState(projectRoot, runId) → { ... } | null  (read-only, NO lock)
 *   indexPath(projectRoot) → string
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { migrateV1ToV2, V1_SCHEMA, V2_SCHEMA } from './bp1-run-state-migrate.mjs'

export const SCHEMA_VERSION = V2_SCHEMA
const VALID_TERMINAL_STATES = Object.freeze(['complete', 'aborted', 'abandoned', 'archived'])

// v2 expands the state vocabulary. Slice 2c orchestrator subcommands assert
// against this enum via updateRunState. Validator (validate-rfc-contract-mirror)
// diffs this against contract.json `run_state_schemas.v2.states`.
export const VALID_V2_STATES = Object.freeze([
  'active',
  'rfc-detected',
  'classifier-dispatch-pending',
  'classified',
  'planning',
  'needs-human',
  'awaiting_approval',
  'complete',
  'aborted',
  'abandoned',
  'archived',
])

// Patchable transition fields per v2 schema. updateRunState() refuses
// unknown keys to keep the on-disk shape locked. `classified_episode_id` /
// `route_episode_id` added (cluster #286/#287/#288 Phase A/B persistence).
// `awaiting_approval_at` + `deadline_at` added (slice 2d-W); Phase A persists
// both so Phase B retry after crash produces byte-identical marker bytes
// (codex r1 M1 — never wall-clock).
const VALID_V2_PATCH_FIELDS = Object.freeze([
  'state',
  'decided_class',
  'pre_episode_id',
  'rfc_detected_episode_id',
  'classified_episode_id',
  'route_episode_id',
  'awaiting_approval_at',
  'deadline_at',
])

// Valid classifier output classes (mirrors classifier_output_schema in
// docs/rfcs/RFC-004-bp1-auto-pilot.contract.json). updateRunState validates
// decided_class against this list when present.
const VALID_DECIDED_CLASSES = Object.freeze([
  'trivial', 'schema', 'validator', 'security', 'multi-actor', 'needs-human-input',
])

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
 * Read + parse `_index.json` WITHOUT migration. Returns the raw shape (v1 or
 * v2) for validators / inspection that need to see the on-disk schema_version
 * verbatim. Returns an empty v2 default when the file is missing.
 *
 * Throws on corrupt JSON (RC3 — never silently reset).
 *
 * @param {string} projectRoot
 * @returns {{ schema_version: 1|2, runs: Record<string, object> }}
 */
export function readIndexNoMigrate(projectRoot) {
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
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('run-state index is not an object')
    err.code = 'corrupt'
    throw err
  }
  if (parsed.schema_version !== V1_SCHEMA && parsed.schema_version !== V2_SCHEMA) {
    const err = new Error(`run-state index has unsupported schema_version ${JSON.stringify(parsed.schema_version)}`)
    err.code = 'corrupt'
    throw err
  }
  if (!parsed.runs || typeof parsed.runs !== 'object') {
    parsed.runs = {}
  }
  return parsed
}

/**
 * In-lock variant: caller MUST already hold `withRunStateLock`. Reads the
 * on-disk index and migrates v1→v2 in memory; does NOT write. Caller is
 * responsible for `writeIndex(projectRoot, idx)` before releasing the lock if
 * mutation occurred.
 *
 * Used by appendRun + markTerminal + updateRunState, which all hold the lock
 * for the read-modify-write cycle.
 *
 * @param {string} projectRoot
 * @returns {{ schema_version: 2, runs: Record<string, object> }}
 */
export function loadIndexLocked(projectRoot) {
  const raw = readIndexNoMigrate(projectRoot)
  return migrateV1ToV2(raw)
}

/**
 * Public entry point. Reads + migrates the index for callers NOT already
 * holding the lock. If migration was needed, persists the v2 form on disk
 * inside `withRunStateLock` (RC2 atomic-write). Always returns v2.
 *
 * @param {string} projectRoot
 * @returns {{ schema_version: 2, runs: Record<string, object> }}
 */
export function loadIndex(projectRoot) {
  const raw = readIndexNoMigrate(projectRoot)
  if (raw.schema_version === V2_SCHEMA) {
    return migrateV1ToV2(raw)   // defensive copy
  }
  // v1 detected — persist migration under lock.
  return withRunStateLock(projectRoot, () => {
    // Re-read inside the lock in case another writer already migrated.
    const reReadRaw = readIndexNoMigrate(projectRoot)
    const migrated = migrateV1ToV2(reReadRaw)
    if (reReadRaw.schema_version === V1_SCHEMA) {
      writeIndex(projectRoot, migrated)
    }
    return migrated
  })
}

/**
 * Atomic-write the index file. Per-process unique temp filename
 * (codex round-1 RC2 fix); orphan cleanup happens only inside the lock.
 *
 * EXPORTED for in-lock callers (orchestrator subcommands that perform their
 * own read-modify-write inside `withRunStateLock` via `loadIndexLocked`).
 *
 * @param {string} projectRoot
 * @param {object} idx
 */
export function writeIndex(projectRoot, idx) {
  const target = indexPath(projectRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmpPath = `${target}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`
  // Durability ordering: callers MUST sequence episode-emit (atomic
  // tmp+fsync+rename via bp1-episode-writer.mjs) BEFORE this writeIndex.
  // Both endpoints fsync now (cluster-#286/#287/#288 round-2 N1 fix). The
  // invariant is the ORDER, not the per-step durability: if a crash occurs
  // between episode-rename and index-rename, the signed episode is on disk
  // and the orchestrator's orphan-attach path finds it via
  // `findSignedStateEpisode` on retry. Reversing the order (index first)
  // would create the bad failure mode: index pointer to no-such-episode.
  const fd = fs.openSync(tmpPath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(idx, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, target)
}

/**
 * Acquire the run-state lock and call fn(). Exported so orchestrator
 * subcommands can compose multi-step transitions atomically. Re-uses the
 * file-local lockdir helper.
 *
 * @template T
 * @param {string} projectRoot
 * @param {() => T} fn
 * @returns {T}
 */
export function withRunStateLockExclusive(projectRoot, fn) {
  return withRunStateLock(projectRoot, fn)
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
      // loadIndexLocked: caller holds the lock; v1→v2 migration happens
      // in-memory + is persisted by writeIndex below. Slice 2c CR2-3 fix
      // (previously called loadIndex inside the lock → self-deadlock on v1
      // upgrade path).
      const idx = loadIndexLocked(projectRoot)
      if (idx.runs[runId]) {
        return { error: 'collision' }
      }
      const run = {
        project_root: projectRootCanonical,
        state: 'active',
        created_at: new Date().toISOString(),
        terminal_at: null,
        decided_class: null,
        pre_episode_id: null,
        rfc_detected_episode_id: null,
        classified_episode_id: null,
        route_episode_id: null,
        awaiting_approval_at: null,
        deadline_at: null,
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
      // loadIndexLocked: caller holds the lock (CR2-3 fix). Run may be in any
      // v2 non-terminal state — we don't gate on `state === 'active'` anymore
      // because slice 2c added rfc-detected / classified / planning /
      // needs-human as non-terminal intermediate states. Treat "already
      // terminal" as the failure mode; any non-terminal state is finalize-able.
      const idx = loadIndexLocked(projectRoot)
      const run = idx.runs[runId]
      if (!run) return { error: 'missing' }
      if (VALID_TERMINAL_STATES.includes(run.state)) return { error: 'already-terminal' }
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
 * Apply a partial update to a run's state-transition fields. Used by
 * orchestrator subcommands (record-classifier-dispatch-pre,
 * record-classification) to transition state + persist
 * pre_episode_id / rfc_detected_episode_id / decided_class atomically.
 *
 * Refuses unknown fields, invalid state values, and invalid decided_class
 * values. Refuses transitions on already-terminal runs.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @param {object} patch — fields from VALID_V2_PATCH_FIELDS
 * @returns {{ ok: true } | { error: string }}
 */
export function updateRunState(projectRoot, runId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'invalid-patch' }
  }
  for (const k of Object.keys(patch)) {
    if (!VALID_V2_PATCH_FIELDS.includes(k)) {
      return { error: `unknown-patch-field:${k}` }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'state')) {
    if (!VALID_V2_STATES.includes(patch.state)) {
      return { error: 'invalid-state' }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'decided_class')
      && patch.decided_class !== null
      && !VALID_DECIDED_CLASSES.includes(patch.decided_class)) {
    return { error: 'invalid-decided-class' }
  }
  try {
    return withRunStateLock(projectRoot, () => {
      cleanupOrphanTmps(projectRoot)
      const idx = loadIndexLocked(projectRoot)
      const run = idx.runs[runId]
      if (!run) return { error: 'missing' }
      if (VALID_TERMINAL_STATES.includes(run.state)) return { error: 'already-terminal' }
      for (const [k, v] of Object.entries(patch)) {
        run[k] = v
      }
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
  let raw
  try {
    raw = readIndexNoMigrate(projectRoot)
  } catch (_e) {
    return null
  }
  // Diagnostic-only: migrate in-memory for v2-shaped return without acquiring
  // the lock or persisting. Callers that need a guaranteed-on-disk v2 use
  // loadIndex (acquires lock + persists if v1 detected).
  let migrated
  try {
    migrated = migrateV1ToV2(raw)
  } catch (_e) {
    return null
  }
  return migrated.runs[runId] || null
}
