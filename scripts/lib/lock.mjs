// lib/lock.mjs — zero-dep atomic file-lock primitives (DELTA-2, RFC-009 P4-S4.1).
//
// Extracted from em-lock.mjs:67-132 so callers (the em-lock CLI AND the clerk
// apply in em-consolidate.mjs) share ONE implementation. The clerk holds a
// single lock in-process across its 3 ordered clerkWrite calls via the blocking
// `acquire`, which RETURNS on contention (round-2 N3) rather than process.exit —
// process.exit is a CLI-only boundary behavior, wrapped by em-lock.mjs.
//
// Preserves the em-lock semantics verbatim:
//   - O_WRONLY|O_CREAT|O_EXCL atomic create; pid/iso/ppid payload.
//   - 100ms poll to timeout.
//   - stale reclaim via process.kill(pid,0) ESRCH → unlink → retry.
//   - release only if the stored pid matches the acquiring pid.

import fs from 'node:fs'

const POLL_MS = 100

// Non-blocking single-shot. Returns { ok:true, handle } on acquire, or
// { ok:false, heldBy:<pid|null> } when the lock is currently held.
export function tryAcquire(lockFile) {
  try {
    const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644)
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n${process.ppid}\n`)
    fs.closeSync(fd)
    return { ok: true, handle: { lockFile, pid: process.pid } }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    // Stale-lock detection: read pid, check if alive.
    try {
      const txt = fs.readFileSync(lockFile, 'utf8')
      const pid = parseInt(txt.split('\n')[0], 10)
      if (pid > 0) {
        try {
          process.kill(pid, 0) // probe — does not actually signal
          return { ok: false, heldBy: pid }
        } catch (probeErr) {
          if (probeErr.code === 'ESRCH') {
            // Holder is gone. Steal.
            try {
              fs.unlinkSync(lockFile)
              return tryAcquire(lockFile)
            } catch (unlinkErr) {
              if (unlinkErr.code === 'ENOENT') return tryAcquire(lockFile)
              throw unlinkErr
            }
          }
          // EPERM or other — treat as held
          return { ok: false, heldBy: pid }
        }
      }
      return { ok: false, heldBy: null }
    } catch (readErr) {
      if (readErr.code === 'ENOENT') return tryAcquire(lockFile) // race; retry
      throw readErr
    }
  }
}

// Blocking poll-to-timeout. Returns { ok:true, handle } on acquire, or
// { ok:false, code:'lock-timeout', heldBy } on contention past the deadline.
// Never calls process.exit (round-2 N3) — the CLI wraps this and exits itself.
export async function acquire(lockFile, timeoutS) {
  const deadlineMs = Date.now() + timeoutS * 1000
  while (true) {
    const result = tryAcquire(lockFile)
    if (result.ok) return result
    if (Date.now() >= deadlineMs) {
      return { ok: false, code: 'lock-timeout', heldBy: result.heldBy }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

// Release only if the lockfile still records the acquiring pid. handle is the
// { lockFile, pid } object returned by tryAcquire/acquire.
export function release(handle) {
  if (!handle || !handle.lockFile) return
  try {
    const txt = fs.readFileSync(handle.lockFile, 'utf8')
    const pid = parseInt(txt.split('\n')[0], 10)
    if (pid === (handle.pid ?? process.pid)) fs.unlinkSync(handle.lockFile)
  } catch (_err) {
    // already gone or unreadable — fine
  }
}
