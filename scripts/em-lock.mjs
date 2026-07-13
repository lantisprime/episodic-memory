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
import { tryAcquire, acquire, release } from './lib/lock.mjs'

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

// tryAcquire/acquire/release are extracted to lib/lock.mjs (DELTA-2, S4.1) so
// the clerk (em-consolidate.mjs) shares one implementation. The CLI still owns
// the process.exit on lock-timeout (below) — acquire itself only RETURNS.
let lockHandle = null

let released = false
function safeRelease() {
  if (released) return
  released = true
  release(lockHandle)
}

process.on('SIGINT', () => { safeRelease(); process.exit(130) })
process.on('SIGTERM', () => { safeRelease(); process.exit(143) })
process.on('uncaughtException', (err) => {
  safeRelease()
  console.error(JSON.stringify({ status: 'error', code: 'uncaught', message: err.message }))
  process.exit(1)
})

// Blocking acquire (imported); the CLI boundary owns the process.exit on
// lock-timeout — acquire itself only RETURNS { ok:false, code:'lock-timeout' }.
const _acq = await acquire(lockFile, timeoutS)
if (!_acq.ok) {
  console.error(JSON.stringify({
    status: 'error',
    code: 'lock-timeout',
    file: lockFile,
    held_by_pid: _acq.heldBy,
    timeout_s: timeoutS,
  }))
  process.exit(1)
}
lockHandle = _acq.handle

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
