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
 *     [--reason     "<note>"]
 *
 * Recognized by command-classifier.sh as a `helper_write` invocation when the
 * argv shape matches `node <abs-path>/classify-correction.mjs --project-root ...`.
 * The helper rejects an --project-root that does not match
 * resolveRepoRoot(process.cwd()) so a misrouted invocation cannot write into
 * a foreign repo's store.
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

// F1-fix: stale-lock detection — see llm-classifier-dispatch.mjs for the
// algorithm. Same shape: PID file inside lock dir + ESRCH-based reclaim.
function acquireLock(lockPath, timeoutMs = 5000) {
  const start = Date.now()
  while (true) {
    try {
      fs.mkdirSync(lockPath)
      try { fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid)) } catch {}
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let staleReclaimed = false
      try {
        const pidStr = fs.readFileSync(path.join(lockPath, 'pid'), 'utf8').trim()
        const pid = parseInt(pidStr, 10)
        if (!Number.isFinite(pid) || pid <= 0) {
          fs.rmSync(lockPath, { recursive: true, force: true })
          staleReclaimed = true
        } else {
          try { process.kill(pid, 0) } catch (e) {
            if (e.code === 'ESRCH') {
              fs.rmSync(lockPath, { recursive: true, force: true })
              staleReclaimed = true
            }
          }
        }
      } catch {
        try { fs.rmSync(lockPath, { recursive: true, force: true }); staleReclaimed = true } catch {}
      }
      if (staleReclaimed) continue
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock timeout: ${lockPath}`)
      }
      const end = Date.now() + 25
      while (Date.now() < end) { /* spin */ }
    }
  }
}

function releaseLock(lockPath) {
  try { fs.rmSync(lockPath, { recursive: true, force: true }) } catch {}
}

function appendOverride(storeDir, entry) {
  fs.mkdirSync(storeDir, { recursive: true })
  const target = path.join(storeDir, 'classifier-overrides.jsonl')
  const lock = path.join(storeDir, '.lock')
  acquireLock(lock)
  try {
    const line = JSON.stringify(entry) + '\n'
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    let existing = ''
    try { existing = fs.readFileSync(target, 'utf8') } catch {}
    fs.writeFileSync(tmp, existing + line)
    fs.renameSync(tmp, target)
  } finally {
    releaseLock(lock)
  }
  return target
}

function main() {
  const argv = process.argv.slice(2)
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = flag(argv, '--command')
  const label = flag(argv, '--label')
  const reason = flag(argv, '--reason') || ''

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
  // F13-fix: reject non-git cwd-fallback. resolveRepoRoot returns the cwd
  // unchanged when it cannot resolve a git context. The classifier scopes
  // overrides per git repo; allowing a non-git cwd as its own "project root"
  // would land overrides in an arbitrary directory's .episodic-memory/.
  // Require an actual `.git` (file or directory — submodules use file).
  try {
    fs.statSync(path.join(projectRootCanon, '.git'))
  } catch {
    die(2, `--project-root (${projectRootCanon}) is not a git repository (.git not found); classifier overrides require a git context`)
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
  const storeDir = path.join(projectRootCanon, '.episodic-memory')
  const target = appendOverride(storeDir, entry)
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
