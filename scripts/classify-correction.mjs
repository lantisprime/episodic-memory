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

// codex PR #326 R3 BLOCKER: stale-lock identity binding is unsolvable in
// pure POSIX (no `rename-if-inode-matches` primitive). Per the same-class
// stop rule (feedback_handoff_complete_bug_class.md), we change the
// enforcement boundary instead of patching the same class again: drop the
// lock entirely and rely on `O_APPEND` write atomicity.
//
// POSIX guarantees that a single `write()` of size <= PIPE_BUF (4096B on
// Linux/macOS) to a file opened with O_APPEND is atomic — interleaving
// processes will get whole-line appends without truncation or interleave.
// Our entries are ~500B JSON. Safe.
//
// `fs.appendFileSync(file, line, {flag: 'a'})` opens, writes, closes in one
// call; Node's underlying syscall uses `O_APPEND` which the kernel honors.
function appendOverride(storeDir, entry) {
  fs.mkdirSync(storeDir, { recursive: true })
  const target = path.join(storeDir, 'classifier-overrides.jsonl')
  const line = JSON.stringify(entry) + '\n'
  // codex R4 BLOCKER F1: O_APPEND atomicity is BYTE-sized (PIPE_BUF =
  // 4096 bytes), not char-sized. `String.length` counts UTF-16 code units;
  // a 2200-char ASCII line is 2200 bytes but a 2200-char multibyte UTF-8
  // line can be > 4096 bytes. Use Buffer.byteLength('utf8') for the real
  // serialized size the kernel will write.
  const byteLen = Buffer.byteLength(line, 'utf8')
  if (byteLen > 4096) {
    throw new Error(`override entry size ${byteLen} bytes exceeds PIPE_BUF atomicity guarantee (4096B); refusing to append`)
  }
  fs.appendFileSync(target, line, { flag: 'a' })
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
