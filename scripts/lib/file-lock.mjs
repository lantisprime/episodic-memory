/**
 * file-lock.mjs — File-based mutex with crash-safe stale-claim via atomic
 * rename. Used by the LLM classifier subsystem (classify-correction.mjs,
 * llm-classifier-dispatch.mjs).
 *
 * Acquire path:
 *   1. `openSync(lockPath, 'wx')` — atomic O_CREAT|O_EXCL — writes our PID.
 *   2. On EEXIST: read existing PID; check `kill(pid, 0)` for ESRCH (or
 *      mtime-age > 1s for pidless/unparseable content).
 *   3. If stale: `renameSync(lockPath, <unique-claim-path>)`. Rename is
 *      atomic; only ONE racer succeeds. The successful renamer unlinks
 *      the claimed file and loops to retry fresh acquire. Losers see
 *      ENOENT on rename and loop without unlinking anything.
 *   4. If not stale: spin-wait until timeout.
 *
 * Why rename-based claim and not "read pid → unlink → retry"?
 *   codex PR #326 R2 BLOCKER repro: under contention, process A reads stale
 *   pid → unlinks the lock → another writer creates fresh lock → process B,
 *   which had ALSO read the stale pid earlier, ALSO unlinks `lockPath` —
 *   but that file is now A's LIVE lock. Result: two writers running with
 *   no mutual exclusion, lost entries on disk. atomic rename solves this
 *   because exactly one process can rename a given inode out of the way;
 *   the others see ENOENT and back off.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const STALE_GRACE_MS = 1000   // age before pidless lock is considered stale
const SPIN_QUANTUM_MS = 25

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    if (e.code === 'ESRCH') return false
    // EPERM means the process exists but we lack permission to signal.
    return true
  }
}

function uniqueClaimPath(lockPath) {
  const nonce = crypto.randomBytes(8).toString('hex')
  return `${lockPath}.stale-claim.${process.pid}.${Date.now()}.${nonce}`
}

export function acquireLock(lockPath, timeoutMs = 5000) {
  const start = Date.now()
  const myPid = String(process.pid)
  while (true) {
    // Fast path: atomic create.
    let fd
    try {
      fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, myPid)
      fs.closeSync(fd)
      return
    } catch (err) {
      if (fd) { try { fs.closeSync(fd) } catch {} }
      if (err.code !== 'EEXIST') throw err
    }

    // Slow path: existing lock — stale-check.
    let isStale = false
    try {
      const pidStr = fs.readFileSync(lockPath, 'utf8').trim()
      const pid = parseInt(pidStr, 10)
      if (!Number.isFinite(pid) || pid <= 0) {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs
        isStale = age > STALE_GRACE_MS
      } else {
        isStale = !isProcessAlive(pid)
      }
    } catch (statErr) {
      if (statErr.code === 'ENOENT') continue  // racing release; retry acquire
      throw statErr
    }

    if (isStale) {
      // Atomic stale-claim via rename: only ONE racer renames the existing
      // lock out of the way. Winner unlinks the renamed file and loops.
      // Losers see ENOENT and loop without touching disk further.
      const claim = uniqueClaimPath(lockPath)
      try {
        fs.renameSync(lockPath, claim)
        try { fs.unlinkSync(claim) } catch {}
        continue
      } catch (renameErr) {
        if (renameErr.code === 'ENOENT') continue
        throw renameErr
      }
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`lock timeout: ${lockPath}`)
    }
    const end = Date.now() + SPIN_QUANTUM_MS
    while (Date.now() < end) { /* spin */ }
  }
}

export function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath) } catch {}
}
