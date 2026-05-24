/**
 * scripts/lib/classifier-cache.mjs — Shared primitives for the classifier
 * override read/write paths.
 *
 * Consumers:
 *   - scripts/classify-correction.mjs        (user-correction write, Tier 0 source)
 *   - scripts/classifier-override-lookup.mjs (Tier 0 read, shell-side wrapper)
 *   - scripts/classifier-override-persist.mjs (auto-persist write after LLM hit)
 *   - scripts/llm-classifier-dispatch.mjs    (legacy Tier 2/3 dispatcher)
 *
 * scripts/classifier-marker.mjs intentionally does NOT consume this module —
 * its tuple shape extends with session_id + policy versions and its store
 * path is .checkpoints/classify/<sha>.json (not classifier-overrides.jsonl).
 *
 * UNIFIED normalizeCommand: strip trailing `# comment`, collapse whitespace,
 * trim. Pre-PR-#336, classify-correction used the whitespace-only form, so
 * stored entries with `#` in the command had a DIFFERENT cache_key than the
 * dispatcher/marker readers would compute — they were unreachable. Unifying
 * here closes that mislabel surface. Any pre-existing entries written under
 * the old normalizer become unreachable; re-correction is one-shot.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export const LABELS = new Set([
  'read_only',
  'shared_write',
  'marker_write',
  'push_or_pr_create',
  'unsafe_complex'
])

export const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl'])

// Carve-out lists for the Tier 0 override path (PR #336). Centralized here
// so both classifier-override-lookup.mjs and llm-classifier-dispatch.mjs
// apply the same shape check (codex REJECT on file 4/8 R1: a flag-prefixed
// interpreter command like `node --require ./noop.js scripts/em-store.mjs`
// otherwise hides a real mutator after the --require value, bypassing the
// hardcoded-mutator carve-out).
//
// Threat: a staged override matches by full normalized_command cache_key,
// so any command shape can store an override; the SHAPE CHECK at read time
// is the only defense that prevents a hidden mutator from receiving an
// override-served label.

export const OVERRIDABLE_INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl'])

// Helpers with their OWN env-prefix discipline at the interpreter case-arm.
// Overrides MUST NOT bypass that discipline.
export const NON_OVERRIDABLE_HELPER_SCRIPTS = new Set([
  'classifier-marker.mjs',
  'classify-correction.mjs',
  'plan-marker.mjs'
])

// All hardcoded em-* arms in command-classifier.sh (lines 1480 + 1489 after
// the PR #336 em-workflow-validate.mjs relabel). Adding a new arm to the
// shell case-statement without adding it here creates a new override-
// demotion path (a CI drift check is tracked as a #336 follow-up).
export const KNOWN_HARDCODED_EM_SCRIPTS = new Set([
  'em-search.mjs',
  'em-list.mjs',
  'em-watch-codex.mjs',
  'em-pattern-health.mjs',
  'em-check-stale.mjs',
  'em-rebuild-index.mjs',
  'em-workflow-validate.mjs',
  'em-store.mjs',
  'em-revise.mjs',
  'em-prune.mjs',
  'em-violation.mjs',
  'em-recall.mjs'
])

// Codex R4 ACCEPT-with-FU on plan: "explicitly correction-eligible hardcoded
// scripts, currently em-workflow-validate.mjs." Adding to this set requires
// a code change PLUS review of whether the shell-side label is actually a
// mislabel that an override should be permitted to fix.
export const OVERRIDABLE_HARDCODED_SCRIPTS = new Set([
  'em-workflow-validate.mjs'
])

// checkOverridableShape — gate for whether a command may receive a Tier 0
// override. Returns { overridable: true, scriptBase } OR
// { overridable: false, reason }.
//
// Codex REJECT on file 4/8 R1 (bypass): `node --require ./noop.js
// scripts/em-store.mjs` slipped past a "first non-flag token after interp"
// walker because `./noop.js` (the --require value) appeared as the first
// non-flag. STRICT FIX: require interpreter to be immediately followed by
// a non-flag token (i.e., toks[1] must not start with `-`). This matches
// resolveExeAgainstCwd's existing null-on-flag-script behavior, so the
// tuple key + the shape check agree on what counts as "the script".
//
// Cost: legitimate flag-prefixed invocations like `node --inspect
// script.mjs` become not-overridable. Acceptable — overrides are an opt-in
// correction mechanism, and the flag-prefixed form is rare in practice.
// Manual workaround: stage the override under the simpler `node script.mjs`
// shape, or accept that interpreter_other shared_write is the right label.
export function checkOverridableShape(command) {
  const toks = String(command).trim().split(/\s+/)
  if (toks.length === 0) return { overridable: false, reason: 'empty-command' }
  const firstBase = path.basename(toks[0])
  if (!OVERRIDABLE_INTERPRETERS.has(firstBase)) {
    return { overridable: false, reason: 'not-interpreter' }
  }
  if (toks.length < 2) {
    return { overridable: false, reason: 'no-script-arg' }
  }
  const scriptCandidate = toks[1]
  if (scriptCandidate.startsWith('-')) {
    // Codex REJECT fix: any flag at toks[1] disqualifies. We cannot safely
    // parse interpreter-specific flag-value grammars (-e/-p/--require/etc.
    // for Node; -c/-m for Python; etc.) — pretending we can is the bypass
    // vector. Refuse and let the existing classifier path handle it.
    return { overridable: false, reason: 'interpreter-flag-present' }
  }
  const scriptBase = path.basename(scriptCandidate)
  if (NON_OVERRIDABLE_HELPER_SCRIPTS.has(scriptBase)) {
    return { overridable: false, reason: 'helper-with-own-discipline' }
  }
  if (KNOWN_HARDCODED_EM_SCRIPTS.has(scriptBase) && !OVERRIDABLE_HARDCODED_SCRIPTS.has(scriptBase)) {
    return { overridable: false, reason: 'hardcoded-mutator' }
  }
  return { overridable: true, scriptBase }
}

export function realpathOrSame(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

export function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

export function normalizeCommand(raw) {
  return String(raw).replace(/#.*$/, '').replace(/\s+/g, ' ').trim()
}

// Rejects `FOO=bar python3 ...` shape. Caller MUST route to default
// (Tier 1) classification — env-prefix is a cross-session attack vector
// (PR #271 / PR #272 F-4) and overrides MUST NOT apply.
export function hasEnvPrefix(command) {
  const first = String(command).trim().split(/\s+/)[0] || ''
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)
}

export function resolveExeAgainstCwd(command, callerCwd) {
  const toks = String(command).trim().split(/\s+/)
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

export function sha256File(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  } catch {
    return null
  }
}

export function buildTuple({ command, projectRoot, callerCwd }) {
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
    script_digest: digest
  }
}

export function canonicalTupleString(tuple) {
  const sorted = {}
  for (const k of Object.keys(tuple).sort()) sorted[k] = tuple[k]
  return JSON.stringify(sorted)
}

export function cacheKey(tuple) {
  return crypto.createHash('sha256').update(canonicalTupleString(tuple)).digest('hex')
}

// Internal fail-closed wrapper. Calls caller's die(code, msg); if die returns
// (non-exiting test/log callback), throws to guarantee no subsequent code
// runs in this module's flow. Codex P2 (R1, file 1/8 review): without this,
// a non-exiting die in validateStoreDir would still create .episodic-memory
// under allowCreate:false, and a non-exiting die in appendLine would still
// append an oversize entry. The throw enforces the contract at module scope.
function _fail(die, code, msg) {
  die(code, msg)
  throw new Error(`[classifier-cache fail-closed] ${msg}`)
}

// Shared store-dir validator. Migrated from classify-correction.mjs.
//
// allowCreate=true   → mkdir if absent (NOT recursive — recursive form
//                      silently traverses symlinked ancestors). Used by
//                      git mode for first-time creation.
// allowCreate=false  → missing storeDir is fatal via die(2, ...) by default.
//                      With missingIsMiss=true, returns {missing:true,storeDir}
//                      instead — used by the Tier 0 lookup helper, where
//                      "no overrides file" is a cache miss, not an error.
//
// On EEXIST from mkdir (concurrent first-time writers race), re-lstat and
// fall through to validation — both racers proceed iff the dir is real.
//
// On success: storeDir exists, is a real directory (not symlink, not file),
// realpath(storeDir) === <projectRoot>/.episodic-memory. Returns {storeDir}.
//
// `die` is the caller's exit-with-stderr-prefix function — kept injectable
// so each helper preserves its own error prefix + exit code (classify-
// correction returns 2 on validation failure; the outer try/catch wraps
// other errors with exit 1). `_fail` enforces fail-closed even if `die`
// returns instead of exiting.
export function validateStoreDir(projectRootCanon, opts, die) {
  const { allowCreate, missingIsMiss = false } = opts
  const storeDir = path.join(projectRootCanon, '.episodic-memory')
  const expectedReal = storeDir
  let st
  try { st = fs.lstatSync(storeDir) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    if (!allowCreate) {
      if (missingIsMiss) return { missing: true, storeDir }
      _fail(die, 2, `--project-root (${projectRootCanon}) has no .episodic-memory/ directory; create it first to opt into non-git override scoping, or omit --allow-non-git`)
    }
    try { fs.mkdirSync(storeDir) }
    catch (e2) {
      if (e2.code === 'EEXIST') {
        // Concurrent creator won — fall through to re-lstat + validate.
      } else if (e2.code === 'ENOENT') {
        _fail(die, 2, `failed to create .episodic-memory/ — an ancestor of ${storeDir} is missing or unresolvable; refusing`)
      } else if (e2.code === 'ELOOP') {
        _fail(die, 2, `failed to create .episodic-memory/ (symlink loop in ancestor); refusing`)
      } else {
        throw e2
      }
    }
    st = fs.lstatSync(storeDir)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    _fail(die, 2, `.episodic-memory must be a real directory (not a symlink or file); refusing to write through link`)
  }
  const realStore = fs.realpathSync(storeDir)
  if (realStore !== expectedReal) {
    _fail(die, 2, `.episodic-memory resolves outside expected position (got ${realStore}, expected ${expectedReal}); refusing`)
  }
  // Return parent ino+dev for caller's post-openSync TOCTOU re-validation.
  // Codex P1 (R2, file 1/8 review): O_NOFOLLOW on the leaf only catches LEAF
  // symlinks; if `.episodic-memory` itself is swapped to a symlink between
  // validateStoreDir and the subsequent openSync, the open follows the
  // swapped parent and reads/writes the foreign store. Without openat(2)
  // (not exposed by Node stdlib), the best-effort defense is to capture the
  // parent's identity (ino+dev) at validate time and re-lstat after open
  // to confirm the parent hasn't been swapped. Window is tiny (open+lstat
  // syscall pair); residual TOCTOU requires a swap-during-open + swap-back
  // within microseconds, which also implies write access to projectRoot
  // (at which point the attacker can write overrides directly anyway).
  return { storeDir, parentIno: st.ino, parentDev: st.dev }
}

// Re-validate parent dir identity captured at validateStoreDir time. Call
// AFTER an openSync against a leaf under storeDir. Returns true if the
// parent is still the same inode + still a real directory; false if it has
// been swapped (in which case the caller must close fd and refuse the op).
// `validated` is the {storeDir, parentIno, parentDev} object from validateStoreDir.
export function reValidateParent(validated) {
  try {
    const st = fs.lstatSync(validated.storeDir)
    if (st.isSymbolicLink() || !st.isDirectory()) return false
    if (st.ino !== validated.parentIno) return false
    if (st.dev !== validated.parentDev) return false
    return true
  } catch {
    return false
  }
}

// Hardened leaf writer. Caller MUST have proved parent dir is real + at
// canonical position via validateStoreDir; O_NOFOLLOW catches the case
// where classifier-overrides.jsonl ITSELF is a symlink. PIPE_BUF (4096B)
// bounds the line size so a single write() is atomic for concurrent
// appenders (per POSIX guarantee for pipes; same atomicity holds on
// regular files with O_APPEND for writes < PIPE_BUF on Linux/macOS).
//
// `die` is the caller's exit-with-stderr-prefix function — preserves the
// exit-2 contract for the symlink-leaf and oversize cases.
// `validated` must be the {storeDir, parentIno, parentDev} object returned by
// validateStoreDir — appendLine uses parentIno+parentDev for post-openSync
// re-validation to close the TOCTOU window where `.episodic-memory` could be
// swapped to a symlink between validate and openSync (codex P1, R2 review).
export function appendLine(validated, entry, die) {
  const storeDir = validated.storeDir
  const target = path.join(storeDir, 'classifier-overrides.jsonl')
  const line = JSON.stringify(entry) + '\n'
  const byteLen = Buffer.byteLength(line, 'utf8')
  if (byteLen > 4096) {
    _fail(die, 2, `override entry size ${byteLen} bytes exceeds PIPE_BUF atomicity guarantee (4096B); refusing to append`)
  }
  const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
  let fd
  try { fd = fs.openSync(target, flags, 0o644) }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') {
      _fail(die, 2, `classifier-overrides.jsonl is a symlink; refusing to write through link`)
    }
    throw e
  }
  try {
    // Post-openSync TOCTOU re-validation: if `.episodic-memory` was swapped
    // to a symlink between validateStoreDir and openSync (codex P1 R2),
    // refuse to write — the fd may reference a leaf inside the swapped-in
    // foreign store.
    if (!reValidateParent(validated)) {
      _fail(die, 2, `.episodic-memory was swapped between validate and open; refusing write through unbound parent`)
    }
    fs.writeSync(fd, line)
  } finally { fs.closeSync(fd) }
  return target
}

function parseJsonlContent(text) {
  return text.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

// Last-write-wins per cache_key. Caller passes projectRoot (already
// realpath-canonicalized) + key (computed via buildTuple→cacheKey from THIS
// module so write-time and read-time keys agree). Returns the matching
// entry object or null.
//
// Codex P1 (R1, file 1/8 review): the read path MUST apply the same
// symlink+realpath validation as the write path. Without it, a symlinked
// .episodic-memory could serve an override from outside projectRoot, and
// the caller would later report project_root_used=<target> while the
// authority artifact came from elsewhere. Fix:
//   1. validateStoreDir(missingIsMiss:true) — refuses symlink/non-dir;
//      treats absent dir as a clean cache miss (returns null).
//   2. openSync(file, O_RDONLY | O_NOFOLLOW) — refuses to follow a symlinked
//      classifier-overrides.jsonl leaf. ELOOP/EMLINK → miss (null), not a
//      hard failure: a symlinked leaf is not necessarily an attack (could
//      be a misconfigured user workflow), but it MUST NOT serve a hit.
//      ENOENT → miss.
//
// `die` is the caller's exit-with-stderr-prefix function — invoked only on
// hard symlink-on-dir / wrong-realpath cases (via validateStoreDir).
// Hardened read of <validated.storeDir>/classifier-overrides.jsonl. Returns
// the array of parsed rows, or [] on ENOENT / symlinked-leaf (O_NOFOLLOW) /
// post-open parent-swap detection. Symlink/swap defenses are identical to
// the lookup path so any caller (lookup, dedup scan, future telemetry) gets
// the same authority-root binding.
//
// Codex P1 (file 5/8 R1 HOLD): persist's pre-append scan previously used
// plain `fs.readFileSync` which followed a symlinked leaf, letting a
// foreign JSONL suppress auto-persist by pretending to contain a matching
// cache_key. This shared primitive closes that bypass at the source.
export function readOverridesHardened(validated) {
  const file = path.join(validated.storeDir, 'classifier-overrides.jsonl')
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    if (e.code === 'ELOOP' || e.code === 'EMLINK') return []
    throw e
  }
  let content
  try {
    if (!reValidateParent(validated)) return []  // parent swapped between validate and open
    content = fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
  return parseJsonlContent(content)
}

export function lookupProjectOverride(projectRoot, key, die) {
  const v = validateStoreDir(projectRoot, { allowCreate: false, missingIsMiss: true }, die)
  if (v.missing) return null
  const rows = readOverridesHardened(v)
  let hit = null
  for (const r of rows) {
    if (r && r.cache_key === key) hit = r
  }
  return hit
}
