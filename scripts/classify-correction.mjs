#!/usr/bin/env node
/**
 * classify-correction.mjs — Record a user correction for the LLM classifier.
 *
 * Writes a line to <project_root>/.episodic-memory/classifier-overrides.jsonl
 * that Tier 2 will prefer over the global cache for the same command tuple.
 *
 * Usage:
 *   node classify-correction.mjs \
 *     --project-root <abs-path> \
 *     --caller-cwd  <abs-path> \
 *     --command     "<command text>" \
 *     --label       <read_only|shared_write|marker_write|push_or_pr_create|unsafe_complex> \
 *     [--reason     "<note>"] \
 *     [--allow-non-git]
 *
 * Recognized by command-classifier.sh as a `helper_write` invocation when the
 * argv shape matches `node <abs-path>/classify-correction.mjs --project-root ...`.
 * The helper rejects an --project-root that does not match
 * resolveRepoRoot(process.cwd()) so a misrouted invocation cannot write into
 * a foreign repo's store.
 *
 * --allow-non-git: opt into non-git projects. The .episodic-memory/ directory
 * must already exist under --project-root (created by the user) and serves as
 * the explicit opt-in sentinel. The same hardened symlink/realpath validation
 * applies to both modes.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { resolveRepoRoot } from './lib/local-dir.mjs'

const LABELS = new Set([
  'read_only',
  'shared_write',
  'marker_write',
  'push_or_pr_create',
  'unsafe_complex'
])

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function die(code, msg) {
  process.stderr.write(`classify-correction: ${msg}\n`)
  process.exit(code)
}

function realpathOrSame(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

function normalizeCommand(raw) {
  return String(raw).replace(/\s+/g, ' ').trim()
}

function resolveExeAgainstCwd(command, callerCwd) {
  const toks = command.trim().split(/\s+/)
  // Find interpreter form first (node|python|...) then take the next arg as script.
  const interps = new Set(['node', 'python', 'python3', 'ruby', 'perl'])
  for (let i = 0; i < toks.length; i++) {
    if (interps.has(path.basename(toks[i]))) {
      const script = toks[i + 1]
      if (script && !script.startsWith('-')) {
        return path.resolve(callerCwd, script)
      }
      return null
    }
  }
  // Else: first token is the exe.
  if (toks[0]) {
    if (toks[0].startsWith('/') || toks[0].startsWith('./') || toks[0].startsWith('../')) {
      return path.resolve(callerCwd, toks[0])
    }
    return toks[0]
  }
  return null
}

function sha256File(p) {
  try {
    const buf = fs.readFileSync(p)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

function buildTuple({ command, projectRoot, callerCwd }) {
  const cwdCanon = realpathOrSame(callerCwd)
  const callerCwdRelOrAbs = cwdCanon.startsWith(projectRoot + path.sep) || cwdCanon === projectRoot
    ? path.relative(projectRoot, cwdCanon) || '.'
    : cwdCanon
  const exeResolved = resolveExeAgainstCwd(command, cwdCanon)
  let exeAbs = null
  let digest = null
  if (exeResolved && exeResolved.startsWith('/')) {
    try {
      if (fs.statSync(exeResolved).isFile()) {
        exeAbs = realpathOrSame(exeResolved)
        if (exeAbs.startsWith(projectRoot + path.sep) || exeAbs === projectRoot) {
          digest = sha256File(exeAbs)
        }
      }
    } catch {}
  }
  return {
    project_root_canonical: projectRoot,
    caller_cwd_or_rel: callerCwdRelOrAbs,
    normalized_command: normalizeCommand(command),
    executable_resolved: exeAbs || exeResolved,
    script_digest: digest
  }
}

function cacheKey(tuple) {
  const canon = JSON.stringify(tuple, Object.keys(tuple).sort())
  return crypto.createHash('sha256').update(canon).digest('hex')
}

// Shared store-dir validator. Both git and non-git modes route through this.
//
// allowCreate=true  → if storeDir absent, `mkdirSync(storeDir)` (plain, NOT
//                     recursive — recursive form silently traverses
//                     symlinked ancestors). Used by git mode for first-time
//                     creation on a fresh repo.
// allowCreate=false → missing storeDir is fatal. Used by non-git mode where
//                     the dir IS the opt-in signal, and at the TOCTOU
//                     recheck right before append.
//
// On EEXIST from mkdir (concurrent first-time writers race), re-lstat and
// fall through to validation — both racers proceed iff the dir is real.
//
// On success: storeDir exists, is a real directory (not symlink, not file),
// and realpath(storeDir) === path.join(projectRootCanon, '.episodic-memory').
function validateStoreDir(projectRootCanon, { allowCreate }) {
  const storeDir = path.join(projectRootCanon, '.episodic-memory')
  const expectedReal = storeDir
  let st
  try { st = fs.lstatSync(storeDir) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    if (!allowCreate) {
      die(2, `--project-root (${projectRootCanon}) has no .episodic-memory/ directory; create it first to opt into non-git override scoping, or omit --allow-non-git`)
    }
    try { fs.mkdirSync(storeDir) }
    catch (e2) {
      if (e2.code === 'EEXIST') {
        // Concurrent creator won the race — fall through to re-lstat + validate.
      } else if (e2.code === 'ENOENT') {
        die(2, `failed to create .episodic-memory/ — an ancestor of ${storeDir} is missing or unresolvable; refusing`)
      } else if (e2.code === 'ELOOP') {
        die(2, `failed to create .episodic-memory/ (symlink loop in ancestor); refusing`)
      } else {
        throw e2
      }
    }
    st = fs.lstatSync(storeDir)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    die(2, `.episodic-memory must be a real directory (not a symlink or file); refusing to write through link`)
  }
  const realStore = fs.realpathSync(storeDir)
  if (realStore !== expectedReal) {
    die(2, `.episodic-memory resolves outside expected position (got ${realStore}, expected ${expectedReal}); refusing`)
  }
  return storeDir
}

// Hardened leaf writer. `validateStoreDir` already proved the parent dir is
// real + at the canonical position; O_NOFOLLOW catches the case where
// classifier-overrides.jsonl ITSELF is a symlink. PIPE_BUF (4096B) bounds
// the line size so a single write() is atomic for concurrent appenders.
function _appendLine(storeDir, entry) {
  const target = path.join(storeDir, 'classifier-overrides.jsonl')
  const line = JSON.stringify(entry) + '\n'
  const byteLen = Buffer.byteLength(line, 'utf8')
  if (byteLen > 4096) {
    throw new Error(`override entry size ${byteLen} bytes exceeds PIPE_BUF atomicity guarantee (4096B); refusing to append`)
  }
  const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
  let fd
  try { fd = fs.openSync(target, flags, 0o644) }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') {
      die(2, `classifier-overrides.jsonl is a symlink; refusing to write through link`)
    }
    throw e
  }
  try { fs.writeSync(fd, line) }
  finally { fs.closeSync(fd) }
  return target
}

function main() {
  const argv = process.argv.slice(2)
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = flag(argv, '--command')
  const label = flag(argv, '--label')
  const reason = flag(argv, '--reason') || ''
  const allowNonGit = argv.includes('--allow-non-git')

  if (!projectRootArg) die(2, '--project-root required')
  if (!callerCwd) die(2, '--caller-cwd required')
  if (command === undefined) die(2, '--command required')
  if (!label) die(2, '--label required')
  if (!LABELS.has(label)) die(2, `invalid --label "${label}" (allowed: ${[...LABELS].join(', ')})`)

  const projectRootCanon = realpathOrSame(path.resolve(projectRootArg))
  const resolved = realpathOrSame(resolveRepoRoot(process.cwd()))
  if (resolved !== projectRootCanon) {
    die(2, `--project-root (${projectRootCanon}) != resolveRepoRoot(process.cwd()) (${resolved}); refusing cross-repo write`)
  }

  // Mode-specific sentinel + store-dir validation (Gate 2).
  // Git mode: require .git AND allow first-time creation of .episodic-memory.
  // Non-git mode: skip .git check, require user-created .episodic-memory.
  let storeDir
  if (allowNonGit) {
    storeDir = validateStoreDir(projectRootCanon, { allowCreate: false })
  } else {
    try {
      fs.statSync(path.join(projectRootCanon, '.git'))
    } catch {
      die(2, `--project-root (${projectRootCanon}) is not a git repository (.git not found); classifier overrides require a git context, or pass --allow-non-git to opt into .episodic-memory/-scoped overrides`)
    }
    storeDir = validateStoreDir(projectRootCanon, { allowCreate: true })
  }

  const tuple = buildTuple({ command, projectRoot: projectRootCanon, callerCwd })
  const key = cacheKey(tuple)
  const entry = {
    schema: 1,
    cache_key: key,
    tuple,
    label,
    reason: String(reason).slice(0, 500),
    created_at: new Date().toISOString(),
    created_by: 'user-correction'
  }
  if (allowNonGit) entry.allow_non_git = true

  // Test seam: deterministic pause between Gate-2 validation and the append-time
  // TOCTOU recheck, so tests can plant a symlink/swap state into the window.
  // Capped at 5s to avoid hanging CI on a misconfigured env var.
  const pauseMs = Math.min(5000, Math.max(0, parseInt(process.env._CC_TEST_PAUSE_BEFORE_APPEND_MS || '0', 10) || 0))
  if (pauseMs > 0) {
    const end = Date.now() + pauseMs
    while (Date.now() < end) { /* busy-wait keeps the test seam synchronous */ }
  }

  // Gate 3 — TOCTOU recheck immediately before append (both modes).
  // Dir must already exist by this point; if it disappeared or was swapped
  // for a symlink, this catches it.
  validateStoreDir(projectRootCanon, { allowCreate: false })
  const target = _appendLine(storeDir, entry)
  process.stdout.write(JSON.stringify({
    status: 'ok',
    file: target,
    cache_key: key,
    label,
    project_root_used: projectRootCanon
  }) + '\n')
}

try { main() } catch (err) {
  die(1, err?.message || String(err))
}
