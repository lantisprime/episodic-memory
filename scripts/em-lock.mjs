#!/usr/bin/env node
// em-lock.mjs — zero-dep atomic file lock with timeout.
// Replaces flock(1) for the auto-promote + em-backup-sync paths on macOS where
// flock is not present by default. Project rule: zero external deps.
//
// Usage:
//   node em-lock.mjs --file <lockpath> --timeout <seconds> -- <cmd> [args...]
//
// Semantics:
//   - Acquires <lockpath> via O_WRONLY|O_CREAT|O_EXCL (kernel-atomic).
//   - On EEXIST, polls every 100ms up to <timeout> seconds. Stale-lock guard:
//     if pid in lockfile is gone, takes over.
//   - On acquisition, writes own pid + iso timestamp + ppid to the lockfile.
//   - Spawns <cmd> as child, inherits stdio, waits for exit.
//   - Releases lock on child exit (and on SIGINT/SIGTERM/uncaught error).
//   - Exits with child's exit code (or 1 on lock-acquire timeout).
//
// JSON output on lock-acquire timeout (to stdout, then exit 1):
//   {"status":"error","code":"lock-timeout","file":"...","held_by_pid":N,"timeout_s":N}
//
// Exit codes:
//   - child's exit code on success path
//   - 1 if lock acquire times out
//   - 2 on usage error

import fs from 'node:fs'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)

// Scan only the flags before the `--` separator so a wrapped command's own
// --help/-h is not intercepted here.
const helpSep = args.indexOf('--')
const helpScan = helpSep === -1 ? args : args.slice(0, helpSep)
if (helpScan.includes('--help') || helpScan.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-lock.mjs', usage: 'node em-lock.mjs --file <lockpath> --timeout <seconds> -- <cmd> [args...]' }))
  process.exit(0)
}

const dashDash = args.indexOf('--')
if (dashDash === -1 || dashDash === args.length - 1) {
  console.error(JSON.stringify({ status: 'error', code: 'usage', message: 'Usage: em-lock.mjs --file <path> --timeout <seconds> -- <cmd> [args...]' }))
  process.exit(2)
}

const flagArgs = args.slice(0, dashDash)
const cmdArgs = args.slice(dashDash + 1)

function getFlag(name) {
  const idx = flagArgs.indexOf(name)
  if (idx === -1 || idx === flagArgs.length - 1) return null
  return flagArgs[idx + 1]
}

const lockFile = getFlag('--file')
const timeoutS = parseInt(getFlag('--timeout') ?? '60', 10)

if (!lockFile || !cmdArgs.length || Number.isNaN(timeoutS) || timeoutS < 0) {
  console.error(JSON.stringify({ status: 'error', code: 'usage', message: 'Required: --file <path> --timeout <seconds> -- <cmd> [args...]' }))
  process.exit(2)
}

const POLL_MS = 100
const startMs = Date.now()
const deadlineMs = startMs + timeoutS * 1000

function tryAcquire() {
  try {
    const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644)
    fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n${process.ppid}\n`)
    fs.closeSync(fd)
    return { ok: true }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    // Stale-lock detection: read pid, check if alive
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
              return tryAcquire()
            } catch (unlinkErr) {
              if (unlinkErr.code === 'ENOENT') return tryAcquire()
              throw unlinkErr
            }
          }
          // EPERM or other — treat as held
          return { ok: false, heldBy: pid }
        }
      }
      return { ok: false, heldBy: null }
    } catch (readErr) {
      if (readErr.code === 'ENOENT') return tryAcquire() // race; retry
      throw readErr
    }
  }
}

async function acquire() {
  while (true) {
    const result = tryAcquire()
    if (result.ok) return
    if (Date.now() >= deadlineMs) {
      console.error(JSON.stringify({
        status: 'error',
        code: 'lock-timeout',
        file: lockFile,
        held_by_pid: result.heldBy,
        timeout_s: timeoutS,
      }))
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

function release() {
  try {
    const txt = fs.readFileSync(lockFile, 'utf8')
    const pid = parseInt(txt.split('\n')[0], 10)
    if (pid === process.pid) fs.unlinkSync(lockFile)
  } catch (_err) {
    // already gone or unreadable — fine
  }
}

let released = false
function safeRelease() {
  if (released) return
  released = true
  release()
}

process.on('SIGINT', () => { safeRelease(); process.exit(130) })
process.on('SIGTERM', () => { safeRelease(); process.exit(143) })
process.on('uncaughtException', (err) => {
  safeRelease()
  console.error(JSON.stringify({ status: 'error', code: 'uncaught', message: err.message }))
  process.exit(1)
})

await acquire()

const child = spawn(cmdArgs[0], cmdArgs.slice(1), { stdio: 'inherit' })

child.on('exit', (code, signal) => {
  safeRelease()
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

child.on('error', (err) => {
  safeRelease()
  console.error(JSON.stringify({ status: 'error', code: 'spawn-error', message: err.message }))
  process.exit(1)
})
