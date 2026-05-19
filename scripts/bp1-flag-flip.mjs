#!/usr/bin/env node
/**
 * bp1-flag-flip.mjs — Per-project activation map mutator (RFC-004 §197-205).
 *
 * Slice 2f (M2 finish-line, M5 deliverable pulled forward):
 *   - --disable <project>: WORKING. Removes the project's activation entry
 *     from ~/.episodic-memory/config.json under flock, then sweeps any
 *     bp1-approval-*.json markers from <project>/.checkpoints/ so a future
 *     re-enable does not pick up stale (expired-but-trusted) markers out of
 *     context. Emits unsigned project-level episodes:
 *       - bp1-activation-disabled (one per --disable invocation)
 *       - bp1-disable-marker-rm (one per removed marker, parented to above)
 *       - bp1-disable-already (idempotent no-op on already-absent entry)
 *   - --enable <project>: STUB. Exits 2 with "M5 not yet shipped" message.
 *     The actual flip is M5's responsibility because it requires the full
 *     dry-run safety envelope (RFC §199-205).
 *   - --dry-run-on <run_id>, --dry-run-off: STUBS. Exit 2; M5 owns these.
 *
 * Authority root (codex plan-tier r2 ACCEPT-with-FU): --disable resolves
 * --project via realpath then git-toplevel realpath. Non-git → exit 2 with
 * no config mutation, no marker rm. This matches the activation map's
 * canonical-root keying (RFC §85, bp1-flag-check.mjs:284-287).
 *
 * Episode signing (slice 2f scope simplification): --disable emits unsigned
 * episodes via the unsigned-tick writer pattern (mirrors writeUnsignedDead-
 * lineTick in bp1-orchestrator). Verify-key-signed global episodes are
 * formalized in M5 when bp1-activation (the enable counterpart) ships. The
 * security model for --disable is the flock + ~/.episodic-memory write
 * permissions, not HMAC: an attacker with HOME write access can already
 * forge the activation map directly.
 *
 * Exit codes:
 *    0  ok | inert (already-absent)
 *    2  argv | --project resolution failed (not a git repo, etc.)
 *    3  config read/write failed
 *    5  not-yet-shipped (stubs)
 *
 * Zero deps; Node stdlib only.
 */
'use strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { sweepApprovalMarkers } from './lib/bp1-marker.mjs'
import { loadVerifyKey } from './lib/bp1-keys.mjs'

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

function usage() {
  process.stderr.write(
    'Usage:\n' +
    '  bp1-flag-flip --disable <projectRoot>\n' +
    '  bp1-flag-flip --enable <projectRoot>            (M5 stub; exits 2)\n' +
    '  bp1-flag-flip --dry-run-on <run_id>             (M5 stub; exits 2)\n' +
    '  bp1-flag-flip --dry-run-off                     (M5 stub; exits 2)\n',
  )
}

function parseArgs(argv) {
  if (argv.length === 0) return { error: 'missing-subcommand' }
  const head = argv[0]
  switch (head) {
    case '--disable':
    case '--enable':
    case '--dry-run-on': {
      if (argv.length < 2) return { error: 'missing-value' }
      if (argv[1].startsWith('-')) return { error: 'missing-value' }
      if (argv.length > 2) return { error: 'unexpected-positional' }
      return { subcommand: head, target: argv[1] }
    }
    case '--dry-run-off': {
      if (argv.length > 1) return { error: 'unexpected-positional' }
      return { subcommand: head, target: null }
    }
    case '-h':
    case '--help':
      return { subcommand: 'help' }
    default:
      return { error: `unknown-subcommand: ${head}` }
  }
}

// ---------------------------------------------------------------------------
// Project-root canonicalization (RFC §85)
// ---------------------------------------------------------------------------

function resolveDisableProjectRoot(projectArg) {
  if (typeof projectArg !== 'string' || !projectArg) return null
  let abs
  try { abs = fs.realpathSync(path.resolve(projectArg)) } catch (_e) { return null }
  // RFC §85: activation map is keyed by git-toplevel realpath. Non-git roots
  // are not addressable by the activation map; reject with no side effects.
  let toplevel
  try {
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: abs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (_e) {
    return null
  }
  if (!toplevel) return null
  try { return fs.realpathSync(toplevel) } catch (_e) { return null }
}

function projectRootSha(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Global config + flock
// ---------------------------------------------------------------------------

function configPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.episodic-memory', 'config.json')
}

function configLockPath(homeDir = os.homedir()) {
  // Lockdir (atomic mkdirSync) — matches the pattern used by bp1-run-state.mjs
  // for per-project locking. Pinning here avoids cross-project lock contention
  // when two projects' --disable calls race.
  return path.join(homeDir, '.episodic-memory', '.config.lock')
}

function acquireConfigLock(homeDir = os.homedir()) {
  const lockDir = configLockPath(homeDir)
  const start = Date.now()
  const TIMEOUT_MS = 30_000
  while (true) {
    try {
      fs.mkdirSync(lockDir)
      fs.writeFileSync(path.join(lockDir, 'pid'),
        `${process.pid}\n${Date.now()}\n`, { mode: 0o600 })
      return { acquired: true, lockDir }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // Stale-lock detection: PID-file mtime or lockdir mtime > 60s.
      let stale = false
      try {
        const st = fs.statSync(lockDir)
        if (Date.now() - st.mtimeMs > 60_000) stale = true
      } catch (_e) { /* race: lock vanished */ }
      if (stale) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }) } catch (_e) {}
        continue
      }
      if (Date.now() - start > TIMEOUT_MS) {
        return { acquired: false, reason: 'timeout', lockDir }
      }
      // Spin lightly.
      const wait = Math.min(100, TIMEOUT_MS - (Date.now() - start))
      if (wait > 0) {
        // Synchronous spin via Atomics.wait approximation — use a busy loop.
        const until = Date.now() + wait
        while (Date.now() < until) { /* busy-wait briefly */ }
      }
    }
  }
}

function releaseConfigLock(lockState) {
  if (!lockState || !lockState.acquired) return
  try { fs.rmSync(lockState.lockDir, { recursive: true, force: true }) } catch (_e) {}
}

function readConfig(homeDir = os.homedir()) {
  const p = configPath(homeDir)
  if (!fs.existsSync(p)) return { exists: false, config: null }
  let raw
  try { raw = fs.readFileSync(p, 'utf8') }
  catch (e) { return { exists: false, error: { code: e.code || 'read-failed', message: e.message } } }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch (e) { return { exists: true, error: { code: 'parse-failed', message: e.message } } }
  return { exists: true, config: parsed }
}

function atomicWriteConfig(homeDir, config) {
  const p = configPath(homeDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, p)
}

// ---------------------------------------------------------------------------
// Unsigned episode writer (mirrors writeUnsignedDeadlineTick pattern)
// ---------------------------------------------------------------------------

function writeUnsignedEpisode({ projectRoot, episodeId, type, tags, summary, body, frontmatterFields }) {
  const episodesDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const target = path.join(episodesDir, `${episodeId}.md`)
  const iso = new Date().toISOString()
  const lines = ['---']
  lines.push(`id: "${episodeId}"`)
  lines.push(`type: ${type}`)
  lines.push(`parent_episode: ${frontmatterFields.parent_episode != null ? JSON.stringify(frontmatterFields.parent_episode) : 'null'}`)
  lines.push(`summary: ${JSON.stringify(summary)}`)
  for (const [k, v] of Object.entries(frontmatterFields)) {
    if (k === 'parent_episode') continue
    if (typeof v === 'boolean' || v === null) lines.push(`${k}: ${v}`)
    else if (typeof v === 'number') lines.push(`${k}: "${v}"`)
    else lines.push(`${k}: ${JSON.stringify(String(v))}`)
  }
  lines.push(`tags: [${tags.map(t => JSON.stringify(t)).join(', ')}]`)
  lines.push('category: workflow.lifecycle')
  lines.push(`date: ${iso.slice(0, 10)}`)
  lines.push(`time: "${iso.slice(11, 16)}"`)
  lines.push(`project: ${JSON.stringify(path.basename(projectRoot) || 'unknown')}`)
  lines.push('---')
  lines.push('')
  const text = lines.join('\n') + (body ?? '')
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, target)
  return target
}

// ---------------------------------------------------------------------------
// --disable implementation
// ---------------------------------------------------------------------------

function disableProject(projectArg) {
  const projectRoot = resolveDisableProjectRoot(projectArg)
  if (!projectRoot) {
    process.stderr.write(
      `bp1-flag-flip --disable: not a git repository (no toplevel for ${projectArg})\n`)
    return 2
  }
  const homeDir = os.homedir()
  const lock = acquireConfigLock(homeDir)
  if (!lock.acquired) {
    process.stderr.write(`bp1-flag-flip --disable: config lock unavailable (${lock.reason})\n`)
    return 3
  }
  try {
    const r = readConfig(homeDir)
    if (r.error && r.error.code === 'parse-failed') {
      process.stderr.write(`bp1-flag-flip --disable: config parse failure: ${r.error.message}\n`)
      return 3
    }
    if (!r.exists) {
      // No config → no activation entry → trivially complete. Emit
      // disable-already idempotent evidence (matches operator expectation).
      emitDisableAlready({ projectRoot, reason: 'config-missing' })
      process.stdout.write(JSON.stringify({
        status: 'ok',
        action: 'already-absent',
        reason: 'config-missing',
        project_root: projectRoot,
        marker_rm_count: 0,
      }) + '\n')
      return 0
    }
    const config = r.config || {}
    config.bp1 = config.bp1 || {}
    config.bp1.activations = config.bp1.activations || {}
    if (!Object.prototype.hasOwnProperty.call(config.bp1.activations, projectRoot)) {
      // Idempotent path (RFC §217 A7).
      emitDisableAlready({ projectRoot, reason: 'entry-absent' })
      // Still sweep markers — operator intent is "make this project inert,"
      // and stale markers without an activation entry are exactly the
      // scenario the marker-rm sweep guards against.
      const sweep = sweepApprovalMarkers(projectRoot)
      process.stdout.write(JSON.stringify({
        status: 'ok',
        action: 'already-absent',
        reason: 'entry-absent',
        project_root: projectRoot,
        marker_rm_count: sweep.removed.length,
        marker_rm_errors: sweep.errors,
      }) + '\n')
      return 0
    }
    // Live path: delete entry, atomic write, sweep markers, emit evidence.
    delete config.bp1.activations[projectRoot]
    try {
      atomicWriteConfig(homeDir, config)
    } catch (e) {
      process.stderr.write(`bp1-flag-flip --disable: config write failed: ${e.message}\n`)
      return 3
    }
    const sweep = sweepApprovalMarkers(projectRoot)
    // Verify-key fingerprint (forensic — if available). Loader returns
    // `{ error: 'missing' | 'mode' | 'size' | 'unreadable' }` when the key
    // is unavailable; otherwise `{ key32B, fingerprint16 }`. We do NOT
    // block on this; --disable should succeed even when the verify-key
    // is gone (operator scenario: factory reset).
    let verifyKeyId = null
    try {
      const vk = loadVerifyKey(homeDir)
      if (vk && !vk.error && typeof vk.fingerprint16 === 'string') {
        verifyKeyId = vk.fingerprint16
      }
    } catch (_e) { /* tolerable for --disable */ }
    const parentEpisodePath = emitActivationDisabled({
      projectRoot, markerRmCount: sweep.removed.length, verifyKeyId,
    })
    const childEpisodePaths = []
    for (const markerPath of sweep.removed) {
      try {
        const childPath = emitDisableMarkerRm({
          projectRoot, parentEpisodePath, markerPath,
        })
        childEpisodePaths.push(childPath)
      } catch (e) {
        process.stderr.write(`warn: bp1-disable-marker-rm emit failed for ${markerPath}: ${e.message}\n`)
      }
    }
    process.stdout.write(JSON.stringify({
      status: 'ok',
      action: 'disabled',
      project_root: projectRoot,
      project_root_sha256: projectRootSha(projectRoot),
      marker_rm_count: sweep.removed.length,
      marker_rm_errors: sweep.errors,
      activation_disabled_episode_path: parentEpisodePath,
      marker_rm_episode_paths: childEpisodePaths,
      verify_key_id: verifyKeyId,
    }) + '\n')
    return 0
  } finally {
    releaseConfigLock(lock)
  }
}

// ---------------------------------------------------------------------------
// Episode emission helpers (unsigned project-level evidence)
// ---------------------------------------------------------------------------

function emitActivationDisabled({ projectRoot, markerRmCount, verifyKeyId }) {
  const episodeId = `bp1-activation-disabled-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`
  return writeUnsignedEpisode({
    projectRoot,
    episodeId,
    type: 'state-transition',
    tags: ['bp1-activation-disabled'],
    summary: `bp1 activation disabled for ${path.basename(projectRoot)}`,
    body:
      `# bp1-activation-disabled\n\n` +
      `Operator-initiated activation removal via bp1-flag-flip --disable.\n` +
      `Project: ${projectRoot}\n` +
      `Markers removed: ${markerRmCount}\n` +
      `Verify-key fingerprint: ${verifyKeyId ?? 'unavailable'}\n`,
    frontmatterFields: {
      parent_episode: null,
      state: 'bp1-activation-disabled',
      project_root_sha256: projectRootSha(projectRoot),
      disabled_at: new Date().toISOString(),
      disabled_via: 'bp1-flag-flip',
      marker_rm_count: markerRmCount,
      verify_key_id: verifyKeyId == null ? null : verifyKeyId,
    },
  })
}

function emitDisableMarkerRm({ projectRoot, parentEpisodePath, markerPath: markerAbsPath }) {
  // Derive run_id from the marker filename: bp1-approval-<run_id>.json.
  const base = path.basename(markerAbsPath)
  const m = base.match(/^bp1-approval-(.+)\.json$/)
  const runId = m ? m[1] : 'unknown'
  const parentId = path.basename(parentEpisodePath, '.md')
  const episodeId = `bp1-disable-marker-rm-${parentId}-${runId}-${crypto.randomBytes(2).toString('hex')}`
  return writeUnsignedEpisode({
    projectRoot,
    episodeId,
    type: 'evidence',
    tags: ['bp1-disable-marker-rm'],
    summary: `Marker removed during --disable: ${base}`,
    body:
      `# bp1-disable-marker-rm\n\n` +
      `Removed marker: ${markerAbsPath}\n` +
      `Inferred run_id: ${runId}\n` +
      `Parent: ${parentId}\n`,
    frontmatterFields: {
      parent_episode: parentId,
      parent: parentId,
      marker_path: markerAbsPath,
      run_id: runId,
    },
  })
}

function emitDisableAlready({ projectRoot, reason }) {
  const episodeId = `bp1-disable-already-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`
  return writeUnsignedEpisode({
    projectRoot,
    episodeId,
    type: 'failure',
    tags: ['bp1-disable-already'],
    summary: `bp1-disable-already (${reason}) for ${path.basename(projectRoot)}`,
    body:
      `# bp1-disable-already\n\n` +
      `--disable invoked on an already-absent activation entry.\n` +
      `Reason: ${reason}\nProject: ${projectRoot}\n`,
    frontmatterFields: {
      parent_episode: null,
      failure_kind: 'bp1-disable-already',
      project_root_sha256: projectRootSha(projectRoot),
      reason,
    },
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
if (args.error) {
  process.stderr.write(`error: ${args.error}\n`)
  usage()
  process.exit(2)
}
let exitCode
switch (args.subcommand) {
  case '--disable':
    exitCode = disableProject(args.target)
    break
  case '--enable':
    process.stderr.write(
      `bp1-flag-flip --enable: M5 not yet shipped (slice 2f stub). ` +
      `Activation flip requires the full M5 dry-run safety envelope ` +
      `(RFC §199-205).\n`)
    exitCode = 5
    break
  case '--dry-run-on':
    process.stderr.write(
      `bp1-flag-flip --dry-run-on: M5 not yet shipped (slice 2f stub). ` +
      `Dry-run bypass requires M5 lock-file + env-binding mechanism ` +
      `(RFC §630-642).\n`)
    exitCode = 5
    break
  case '--dry-run-off':
    process.stderr.write(
      `bp1-flag-flip --dry-run-off: M5 not yet shipped (slice 2f stub).\n`)
    exitCode = 5
    break
  case 'help':
    usage()
    exitCode = 0
    break
  default:
    usage()
    exitCode = 2
}
process.exit(exitCode)
