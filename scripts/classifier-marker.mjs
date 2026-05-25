#!/usr/bin/env node
/**
 * classifier-marker.mjs — Read/write per-session classification markers.
 *
 * Replaces the direct-API Tier 3 dispatch from PR #326. The active Claude
 * Code session classifies its own Bash commands using its own reasoning
 * (already paid for via the user's subscription tokens) and records the
 * verdict here. A PreToolUse shell hook reads the marker and gates.
 *
 * Mode: --read
 *   Args: --project-root <abs> --caller-cwd <abs> --command <text>
 *         --session-id <string>
 *   Emits the cached JSON verdict on stdout, exit 0; exits 1 if no marker
 *   exists or marker is stale/invalid.
 *
 * Mode: --write
 *   Args: above + --label <L> --confidence <N> --reason <S>
 *   Atomically writes to <project>/.checkpoints/classify/<sha>.json.
 *   Exits 0 on success; exits 2 on input/binding error.
 *
 * Mode: --vacuum
 *   Args: --project-root <abs> [--max-age-days N (default 30)]
 *   Removes marker files older than max-age. Idempotent.
 *
 * Threat model (deliberate scope):
 *   IN-SCOPE   — honest agent drift (skipped classification, sloppy labels);
 *                honest concurrent sessions (no accidental marker bleed);
 *                stale markers across schema/policy upgrades;
 *                path-component symlink swaps.
 *   OUT-OF-SCOPE — adversarial agent compromise; adversarial cross-session
 *                  marker forgery (an attacker who can pass --session-id <X>
 *                  with any X can write a marker for that session — no userspace
 *                  defense without OS-level isolation); compromised local user
 *                  with FS write access (already game over).
 *
 * Marker schema v2:
 *   {
 *     label, confidence, reason, command_normalized,
 *     _project_root_canonical, _cache_key, _session_id, _request_nonce,
 *     _marker_version: 2,
 *     _classifier_policy_version, _normalized_command_version,
 *     recorded_at, _expires_at,
 *     classified_by: "agent_self"
 *   }
 *
 * Marker path:
 *   <project>/.checkpoints/classify/<sha>.json
 * where <sha> = sha256(canonical({
 *   project_root_canonical, caller_cwd_or_rel, normalized_command,
 *   executable_resolved, script_digest,
 *   session_id, classifier_policy_version, normalized_command_version
 * }))
 *
 * Bumping CLASSIFIER_POLICY_VERSION or NORMALIZED_COMMAND_VERSION below
 * changes the sha for every cached tuple, making all existing markers
 * unreachable. Use --vacuum to reap them.
 *
 * Allowlisted in command-classifier.sh as `interpreter_classifier_marker`
 * with strict argv-shape match + env-prefix-form rejection (per PR #271
 * cross-session attack class).
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

// Path-versioning fields. Bumping either makes ALL existing markers
// unreachable via their old paths and forces re-classification.
const CLASSIFIER_POLICY_VERSION = 1
const NORMALIZED_COMMAND_VERSION = 1
const MARKER_SCHEMA_VERSION = 2

const TTL_MS = 24 * 60 * 60 * 1000        // 24h marker freshness
const VACUUM_MAX_AGE_DAYS_DEFAULT = 30    // vacuum default
const REASON_MAX = 500                    // reason field cap
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const COMMAND_FILE_MAX = 64 * 1024 // 64 KiB cap on --command-file content

// Resolve command text from either --command <text> or --command-file <path>.
// Exactly one must be supplied. --command-file reads the file as UTF-8 verbatim
// (no shell re-parse) so commands with quotes/spaces/newlines round-trip; the
// content is OPAQUE TEXT, never executed or resolved as a path. Returns the
// command string, undefined if neither flag is present, or die(2) on misuse.
function resolveCommandArg(argv) {
  const inline = flag(argv, '--command')
  const filePath = flag(argv, '--command-file')
  if (inline !== undefined && filePath !== undefined) {
    die(2, '--command and --command-file are mutually exclusive')
  }
  if (filePath !== undefined) {
    let buf
    try {
      buf = fs.readFileSync(filePath)
    } catch (e) {
      die(2, `cannot read --command-file ${filePath}: ${e.message}`)
    }
    if (buf.length > COMMAND_FILE_MAX) {
      die(2, `--command-file ${filePath} exceeds ${COMMAND_FILE_MAX} bytes (${buf.length})`)
    }
    return buf.toString('utf8')
  }
  return inline
}

function die(code, msg) {
  process.stderr.write(`classifier-marker: ${msg}\n`)
  process.exit(code)
}

function realpathOrSame(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

function normalizeCommand(raw) {
  // Strip trailing # comments, collapse whitespace, trim.
  return String(raw).replace(/#.*$/, '').replace(/\s+/g, ' ').trim()
}

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl'])
function resolveExeAgainstCwd(command, callerCwd) {
  const toks = command.trim().split(/\s+/)
  for (let i = 0; i < toks.length; i++) {
    if (INTERPRETERS.has(path.basename(toks[i]))) {
      const script = toks[i + 1]
      if (script && !script.startsWith('-')) {
        return path.resolve(callerCwd, script)
      }
      return null
    }
  }
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
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  } catch {
    return null
  }
}

function buildTuple({ command, projectRoot, callerCwd, sessionId }) {
  const cwdCanon = realpathOrSame(callerCwd)
  const callerCwdRelOrAbs = isUnder(cwdCanon, projectRoot)
    ? (path.relative(projectRoot, cwdCanon) || '.')
    : cwdCanon
  const exeResolved = resolveExeAgainstCwd(command, cwdCanon)
  let exeAbs = null
  let digest = null
  if (exeResolved && exeResolved.startsWith('/')) {
    try {
      if (fs.statSync(exeResolved).isFile()) {
        exeAbs = realpathOrSame(exeResolved)
        if (isUnder(exeAbs, projectRoot)) {
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
    script_digest: digest,
    session_id: sessionId,
    classifier_policy_version: CLASSIFIER_POLICY_VERSION,
    normalized_command_version: NORMALIZED_COMMAND_VERSION
  }
}

function cacheKey(tuple) {
  // Sort keys lexicographically; primitive values only.
  const sorted = {}
  for (const k of Object.keys(tuple).sort()) sorted[k] = tuple[k]
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

// ----- Path-component hardening (lstat each ancestor, refuse symlinks) -----

// validateMarkerStoreDir — hardens .checkpoints/ + .checkpoints/classify/
// against symlink swaps. Used by ALL THREE modes (--read, --write, --vacuum)
// per codex code-review BLOCKER #1. allowCreate=true creates dirs on first
// use (write/vacuum); allowCreate=false treats absence as a miss.
//
// Returns: { classifyDir } on success, { missing: true } if allowCreate=false
// and the path doesn't exist yet. die(2) on any symlink/realpath drift.
function validateMarkerStoreDir(projectRootCanon, { allowCreate, missingIsMiss }) {
  const checkpointsDir = path.join(projectRootCanon, '.checkpoints')
  const classifyDir = path.join(checkpointsDir, 'classify')

  // Step 1: ensure .checkpoints/ AND .checkpoints/classify/ are real dirs.
  // lstat each ancestor (NOT just the leaf) — a symlinked .checkpoints would
  // otherwise let writes / reads / vacuums escape to an arbitrary external
  // path. Codex BLOCKER #1: prior --read and --vacuum only checked the leaf.
  for (const dir of [checkpointsDir, classifyDir]) {
    let st
    try { st = fs.lstatSync(dir) }
    catch (e) {
      if (e.code !== 'ENOENT') throw e
      if (!allowCreate) {
        if (missingIsMiss) return { missing: true, classifyDir }
        die(2, `marker store path missing: ${dir}; refusing`)
      }
      try { fs.mkdirSync(dir) }
      catch (e2) {
        if (e2.code === 'EEXIST') { /* race winner — fall through to re-lstat */ }
        else if (e2.code === 'ENOENT') die(2, `failed to create ${dir} — an ancestor is missing or unresolvable`)
        else if (e2.code === 'ELOOP') die(2, `failed to create ${dir} (symlink loop in ancestor)`)
        else throw e2
      }
      st = fs.lstatSync(dir)
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      die(2, `${dir} must be a real directory (not a symlink or file); refusing to operate through link`)
    }
  }
  // Step 2: realpath equality — refuse if any ancestor resolved outside the
  // canonical position via a symlinked parent earlier in the chain. This
  // catches the symlinked-checkpoints-ancestor escape codex flagged.
  const realClassify = fs.realpathSync(classifyDir)
  if (realClassify !== classifyDir) {
    die(2, `${classifyDir} resolves outside expected position (got ${realClassify}); refusing`)
  }
  return { classifyDir }
}

// ----- Marker write (O_NOFOLLOW, atomic temp+rename) -----

function writeMarker(classifyDir, sha, payload) {
  const target = path.join(classifyDir, `${sha}.json`)
  const body = JSON.stringify(payload, null, 2) + '\n'

  // Codex code-review BLOCKER #2: lstat the target leaf BEFORE existsSync /
  // readFileSync. The prior code checked existsSync first, which followed a
  // symlinked target leaf — if the symlink pointed to a fresh same-tuple JSON
  // payload, the function returned noop_same_tuple without ever rejecting
  // the symlink. lstat-first closes that bypass class.
  let targetLst = null
  try { targetLst = fs.lstatSync(target) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    // No file → fresh write, no same-tuple check needed.
  }
  if (targetLst && targetLst.isSymbolicLink()) {
    die(2, `target marker is a symlink; refusing to overwrite through link`)
  }

  // Write-once-or-same: if marker already exists with matching tuple + fresh,
  // treat as no-op success. Same-tuple second writer doesn't overwrite.
  if (targetLst && targetLst.isFile()) {
    try {
      const existingTxt = fs.readFileSync(target, 'utf8')
      const existing = JSON.parse(existingTxt)
      const tupleMatch =
        existing._cache_key === payload._cache_key &&
        existing._project_root_canonical === payload._project_root_canonical &&
        existing._session_id === payload._session_id &&
        existing._classifier_policy_version === payload._classifier_policy_version &&
        existing._normalized_command_version === payload._normalized_command_version
      if (tupleMatch) {
        // Refresh expires_at only if existing is still fresh; otherwise overwrite.
        const expiresAt = Date.parse(existing._expires_at || '')
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          return { status: 'noop_same_tuple', file: target }
        }
      }
      // Tuple mismatch or stale → overwrite intentionally.
    } catch {
      // Corrupt marker; overwrite.
    }
  }

  // Atomic temp+rename within the same real directory.
  const tmp = path.join(classifyDir, `.${sha}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
  let fd
  try { fd = fs.openSync(tmp, flags, 0o644) }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') {
      die(2, `marker temp path is a symlink; refusing to write through link`)
    }
    throw e
  }
  try { fs.writeSync(fd, body) }
  finally { fs.closeSync(fd) }

  // Re-validate parent realpath before rename — symlink swap defense.
  const realParent = fs.realpathSync(classifyDir)
  if (realParent !== classifyDir) {
    try { fs.unlinkSync(tmp) } catch {}
    die(2, `marker dir realpath drifted during write; refusing rename`)
  }

  // Refuse rename-through-symlinked target leaf.
  try {
    const targetLst = fs.lstatSync(target)
    if (targetLst.isSymbolicLink()) {
      try { fs.unlinkSync(tmp) } catch {}
      die(2, `target marker is a symlink; refusing to overwrite through link`)
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try { fs.unlinkSync(tmp) } catch {}
      throw e
    }
  }

  // Note: per codex BLOCKER #2 fix, the leaf-symlink check now happens at
  // the START of writeMarker (before existsSync), not here. This trailing
  // lstat is redundant but kept for defense in depth — a TOCTOU swap between
  // the start-of-function lstat and this rename would still get caught.
  fs.renameSync(tmp, target)
  return { status: 'written', file: target }
}

// ----- Marker read (validates tuple, TTL, schema, labels) -----

function readMarker(classifyDir, sha, expectedTuple, sessionId) {
  const target = path.join(classifyDir, `${sha}.json`)
  let st
  try { st = fs.lstatSync(target) }
  catch (e) {
    if (e.code === 'ENOENT') return { status: 'miss', reason: 'no_marker' }
    throw e
  }
  if (st.isSymbolicLink()) {
    return { status: 'reject', reason: 'marker_is_symlink' }
  }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (e) {
    return { status: 'reject', reason: `marker_parse_error: ${e.message}` }
  }

  // Schema version.
  if (parsed._marker_version !== MARKER_SCHEMA_VERSION) {
    return { status: 'reject', reason: `marker_schema_mismatch: got=${parsed._marker_version} expected=${MARKER_SCHEMA_VERSION}` }
  }

  // Tuple bindings (defense in depth — path versioning makes most of these
  // unreachable, but the read-side still rejects tampered bodies).
  if (parsed._project_root_canonical !== expectedTuple.project_root_canonical) {
    return { status: 'reject', reason: 'tamper_project_root_mismatch' }
  }
  if (parsed._cache_key !== sha) {
    return { status: 'reject', reason: 'tamper_cache_key_mismatch' }
  }
  if (parsed._session_id !== sessionId) {
    return { status: 'reject', reason: 'session_id_mismatch' }
  }
  if (parsed._classifier_policy_version !== CLASSIFIER_POLICY_VERSION) {
    return { status: 'reject', reason: 'policy_version_mismatch' }
  }
  if (parsed._normalized_command_version !== NORMALIZED_COMMAND_VERSION) {
    return { status: 'reject', reason: 'command_version_mismatch' }
  }

  // Label allowlist.
  if (!LABELS.has(parsed.label)) {
    return { status: 'reject', reason: `invalid_label: ${parsed.label}` }
  }

  // TTL.
  const expiresAt = Date.parse(parsed._expires_at || '')
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { status: 'stale', reason: 'expired' }
  }

  return { status: 'hit', payload: parsed }
}

// ----- Vacuum (reap markers older than max-age) -----

function vacuumMarkers(projectRootCanon, maxAgeDays) {
  // Codex BLOCKER #1 fix: vacuum MUST apply the same ancestor validation as
  // --write — otherwise a symlinked .checkpoints/ would let the vacuum delete
  // files OUTSIDE the project (codex reproduced this: `--vacuum` reported the
  // target project_root_used while removing files under <external>/.checkpoints/).
  const v = validateMarkerStoreDir(projectRootCanon, { allowCreate: false, missingIsMiss: true })
  if (v.missing) return { removed: 0, scanned: 0 }
  const classifyDir = v.classifyDir
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let removed = 0, scanned = 0
  for (const entry of fs.readdirSync(classifyDir, { withFileTypes: true })) {
    // Reap stale .json markers AND `pending-*.cmd` deny-hint scratch files
    // (PR-B: the deny-hint's --command-file fallback writes these here so they
    // live inside project_root and get swept by the same TTL).
    const isReapable = entry.isFile() &&
      (entry.name.endsWith('.json') || /^pending-.*\.cmd$/.test(entry.name))
    if (!isReapable) continue
    scanned++
    const p = path.join(classifyDir, entry.name)
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) continue   // never touch symlinks during vacuum
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(p)
        removed++
      }
    } catch {}
  }
  return { removed, scanned }
}

// ----- CLI entry -----

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function mainRead(argv) {
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = resolveCommandArg(argv)
  const sessionId = flag(argv, '--session-id')

  if (!projectRootArg) die(2, '--project-root required')
  if (!callerCwd) die(2, '--caller-cwd required')
  if (command === undefined) die(2, '--command or --command-file required')
  if (!sessionId) die(2, '--session-id required')
  if (!SESSION_ID_RE.test(sessionId)) die(2, `--session-id "${sessionId}" does not match ${SESSION_ID_RE}`)

  const projectRoot = realpathOrSame(path.resolve(projectRootArg))

  // Codex BLOCKER #1 fix: --read MUST apply the same ancestor validation as
  // --write. Symlinked .checkpoints/ would otherwise let a read escape to an
  // external store. missingIsMiss=true treats absent dirs as cache miss (not
  // an error) since reads can legitimately fire before any write.
  const v = validateMarkerStoreDir(projectRoot, { allowCreate: false, missingIsMiss: true })
  if (v.missing) {
    emit({ status: 'miss', reason: 'no_marker_dir', project_root_used: projectRoot })
    process.exit(1)
  }
  const classifyDir = v.classifyDir

  const tuple = buildTuple({ command, projectRoot, callerCwd, sessionId })
  const sha = cacheKey(tuple)
  const result = readMarker(classifyDir, sha, tuple, sessionId)

  if (result.status === 'hit') {
    emit({
      status: 'hit',
      label: result.payload.label,
      confidence: result.payload.confidence,
      reason: result.payload.reason,
      project_root_used: projectRoot,
      cache_key: sha,
      session_id: sessionId
    })
    process.exit(0)
  }
  emit({
    status: result.status,
    reason: result.reason,
    project_root_used: projectRoot,
    cache_key: sha,
    session_id: sessionId
  })
  process.exit(1)
}

function mainWrite(argv) {
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = resolveCommandArg(argv)
  const sessionId = flag(argv, '--session-id')
  const label = flag(argv, '--label')
  const confidenceStr = flag(argv, '--confidence')
  const reasonRaw = flag(argv, '--reason') || ''

  if (!projectRootArg) die(2, '--project-root required')
  if (!callerCwd) die(2, '--caller-cwd required')
  if (command === undefined) die(2, '--command or --command-file required')
  if (!sessionId) die(2, '--session-id required')
  if (!label) die(2, '--label required')
  if (!LABELS.has(label)) die(2, `invalid --label "${label}" (allowed: ${[...LABELS].join(', ')})`)
  if (!SESSION_ID_RE.test(sessionId)) die(2, `--session-id "${sessionId}" does not match ${SESSION_ID_RE}`)
  const confidence = Number(confidenceStr)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    die(2, `--confidence must be a number in [0,1]; got "${confidenceStr}"`)
  }

  // Defense-in-depth (per codex R3 honest-agent threat model): if the
  // canonical session-id env var is set, the --session-id flag MUST match.
  // Catches honest-agent typos and accidental cross-session writes when
  // Claude Code's runtime exposes the authoritative session_id. Does NOT
  // defend against adversarial argv forge (out-of-scope per threat model).
  const envSid = process.env.CLAUDE_CODE_SESSION_ID
  if (envSid && envSid !== sessionId) {
    die(2, `--session-id "${sessionId}" != CLAUDE_CODE_SESSION_ID env "${envSid}"; refusing cross-session write`)
  }

  // Cross-repo write defense — helper refuses to write into a foreign repo.
  const projectRoot = realpathOrSame(path.resolve(projectRootArg))
  const resolvedFromCwd = realpathOrSame(resolveRepoRoot(process.cwd()))
  if (resolvedFromCwd !== projectRoot) {
    die(2, `--project-root (${projectRoot}) != resolveRepoRoot(process.cwd()) (${resolvedFromCwd}); refusing cross-repo write`)
  }

  const { classifyDir } = validateMarkerStoreDir(projectRoot, { allowCreate: true, missingIsMiss: false })
  const tuple = buildTuple({ command, projectRoot, callerCwd, sessionId })
  const sha = cacheKey(tuple)
  const nowIso = new Date().toISOString()
  const payload = {
    label,
    confidence,
    reason: String(reasonRaw).slice(0, REASON_MAX),
    command_normalized: tuple.normalized_command,
    _project_root_canonical: projectRoot,
    _cache_key: sha,
    _session_id: sessionId,
    _request_nonce: crypto.randomUUID(),
    _marker_version: MARKER_SCHEMA_VERSION,
    _classifier_policy_version: CLASSIFIER_POLICY_VERSION,
    _normalized_command_version: NORMALIZED_COMMAND_VERSION,
    recorded_at: nowIso,
    _expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    classified_by: 'agent_self'
  }
  const written = writeMarker(classifyDir, sha, payload)
  emit({
    status: written.status,
    file: written.file,
    label,
    cache_key: sha,
    session_id: sessionId,
    project_root_used: projectRoot
  })
  process.exit(0)
}

function mainVacuum(argv) {
  const projectRootArg = flag(argv, '--project-root')
  const maxAgeStr = flag(argv, '--max-age-days')
  if (!projectRootArg) die(2, '--project-root required')
  const projectRoot = realpathOrSame(path.resolve(projectRootArg))
  const maxAge = maxAgeStr ? Number(maxAgeStr) : VACUUM_MAX_AGE_DAYS_DEFAULT
  if (!Number.isFinite(maxAge) || maxAge < 1) die(2, `--max-age-days must be >= 1; got ${maxAgeStr}`)
  const r = vacuumMarkers(projectRoot, maxAge)
  emit({ status: 'ok', ...r, project_root_used: projectRoot, max_age_days: maxAge })
  process.exit(0)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--read')) return mainRead(argv)
  if (argv.includes('--write')) return mainWrite(argv)
  if (argv.includes('--vacuum')) return mainVacuum(argv)
  die(2, 'one of --read, --write, --vacuum required')
}

try { main() } catch (err) {
  die(1, err?.message || String(err))
}
