#!/usr/bin/env node
/**
 * bp1-rfc-scan.mjs — RFC-004 §510-547 (Agents & scripts inventory row 2)
 * + §184-196 (Gated artifacts contract) + §1157-1196 (Failure-table rows 3, 25).
 *
 * The slice 2b trigger: scans `<projectRoot>/docs/rfcs/*.md` for files whose
 * frontmatter `status` field literally equals `"accepted"`, returns them as
 * JSON to stdout. Activation-gated: when bp1-flag-check refuses, exits 0
 * with stderr inert-message and ZERO episodes emitted (`--no-emit` discipline,
 * plan v3 P1.1 fix).
 *
 * Subprocess spawn discipline (slice 2b plan v3, codex round-1 P1.1 + planner
 * P0): every subprocess gets `{cwd: projectRoot}` explicitly. The local-scope
 * `em-store` for `bp1-rfc-malformed` emission MUST land under projectRoot's
 * `.episodic-memory/`, not the caller's cwd (closes the PR #262-class bug).
 *
 * Status routing matrix (slice 2b plan v3, codex round-1 P1.2 — matches strict
 * bp1-frontmatter parser semantics; map/empty-value/duplicate-key/anchor/
 * non-UTF-8 all throw at parse, routed to `yaml-parse`):
 *
 *   string "accepted"                  → INCLUDE in output
 *   string case-variant of accepted    → MALFORMED (status-non-canonical)
 *   string whitespace-trimmed=accepted → MALFORMED (status-non-canonical-whitespace)
 *   string ""                          → MALFORMED (status-empty-string)
 *   string draft/rejected/superseded/  → SKIP silently (known other statuses)
 *           deprecated
 *   string with any other value        → SKIP silently (forward-compat;
 *                                        numeric/date bare tokens parse as
 *                                        strings under strict-parser semantics)
 *   null literal                       → MALFORMED (status-null-value)
 *   array                              → MALFORMED (status-wrong-type)
 *   boolean                            → MALFORMED (status-wrong-type)
 *   parser threw                       → MALFORMED (yaml-parse)
 *
 * Reason vocabulary (closed, 8 entries; classifier prompt — slice 2c —
 * branches on these):
 *   yaml-parse | symlink | frontmatter-exceeds-8kb-bound
 *   status-non-canonical | status-non-canonical-whitespace
 *   status-empty-string | status-null-value | status-wrong-type
 *
 * Output JSON to stdout (success path):
 *   {
 *     "status": "ok",
 *     "project_root": "<absolute>",
 *     "rfcs": [{"path": "docs/rfcs/RFC-NNN.md", "frontmatter_sha256": "<64-hex>"}],
 *     "malformed_count": N
 *   }
 *
 * On inert (activation refused):
 *   {"status": "inert", "reason": "<flag-check-reason>"}
 *   (also prints "bp1 inert for project <root>: <reason>" to stderr; exit 0)
 *
 * On argv / IO error (before flag-check):
 *   {"status": "error", "code": "...", "reason": "..."}
 *   (exit 2)
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { parseBp1Frontmatter } from './lib/bp1-frontmatter.mjs'
import { canonicalizeFrontmatterBytes } from './lib/bp1-canonicalize.mjs'

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname)
const FLAG_CHECK = path.join(SCRIPT_DIR, 'bp1-flag-check.mjs')
const EM_STORE = path.join(SCRIPT_DIR, 'em-store.mjs')

const FRONTMATTER_READ_BYTES = 8192
const FENCE_LINE = '---'

const KNOWN_OTHER_STATUSES = new Set(['draft', 'rejected', 'superseded', 'deprecated'])
const ACCEPTED_LITERAL = 'accepted'

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}
function bool(name) { return argv.includes(name) }

const projectArg = flag('--project')
const configArgRaw = flag('--config')
// Resolve --config to an absolute path BEFORE any subprocess cwd rebinding
// (codex code-tier round-2 P1). If we forwarded a relative --config to a
// child that runs with cwd: projectRoot, the path would resolve against
// projectRoot instead of the caller's cwd — ambiguous authority root.
// path.resolve(undefined) is undefined, so this is safe when --config is
// omitted (flag-check uses its own default in that case).
const configArg = configArgRaw ? path.resolve(configArgRaw) : undefined

function errorExit(code, reason, extra = {}) {
  console.log(JSON.stringify({ status: 'error', code, reason, ...extra }))
  process.exit(2)
}

if (!projectArg) {
  errorExit('missing-project-arg',
    'bp1-rfc-scan requires --project <absolute-path>. No cwd fallback (callers must declare authority root).')
}

// ---------------------------------------------------------------------------
// Resolve project root (Authority Root #1: --project arg + git canonicalization)
// ---------------------------------------------------------------------------

let projectRoot
try {
  projectRoot = fs.realpathSync(path.resolve(projectArg))
} catch (e) {
  errorExit('project-root-unresolvable',
    `Cannot realpath --project: ${e.message}`,
    { project_arg: projectArg })
}

const projectStat = fs.statSync(projectRoot)
if (!projectStat.isDirectory()) {
  errorExit('project-root-not-directory',
    `--project resolves to a non-directory: ${projectRoot}`)
}

// ---------------------------------------------------------------------------
// Activation gate (Authority Root #2: spawn cwd: projectRoot; --no-emit)
// ---------------------------------------------------------------------------

function runFlagCheck() {
  const flagArgs = [FLAG_CHECK, '--project', projectRoot, '--no-emit']
  if (configArg) flagArgs.push('--config', configArg)
  const r = spawnSync('node', flagArgs, {
    cwd: projectRoot,             // mandatory per plan v3 (closes PR #262 class)
    encoding: 'utf8',
    timeout: 10000,
  })
  if (r.error) {
    return { ok: false, reason: `flag-check-spawn-error: ${r.error.message}` }
  }
  if (r.status === 0) return { ok: true }
  // status non-zero: parse JSON for reason
  let parsed = null
  try { parsed = r.stdout ? JSON.parse(r.stdout) : null } catch { /* tolerated */ }
  const reason = (parsed && parsed.reason) || `flag-check-exit-${r.status}`
  return { ok: false, reason, code: (parsed && parsed.code) || null }
}

const gate = runFlagCheck()
if (!gate.ok) {
  process.stderr.write(`bp1 inert for project ${projectRoot}: ${gate.reason}\n`)
  console.log(JSON.stringify({ status: 'inert', reason: gate.reason, code: gate.code || null }))
  process.exit(0)   // exit 0; zero episodes; no further FS reads
}

// ---------------------------------------------------------------------------
// Scan docs/rfcs/*.md (top-level only — closed glob, no **)
// ---------------------------------------------------------------------------

const rfcsDir = path.join(projectRoot, 'docs', 'rfcs')
if (!fs.existsSync(rfcsDir)) {
  console.log(JSON.stringify({
    status: 'ok',
    project_root: projectRoot,
    rfcs: [],
    malformed_count: 0,
    note: 'docs/rfcs directory does not exist',
  }))
  process.exit(0)
}

let dirEntries
try {
  dirEntries = fs.readdirSync(rfcsDir, { withFileTypes: true })
} catch (e) {
  errorExit('rfcs-dir-unreadable',
    `Cannot read ${rfcsDir}: ${e.message}`,
    { project_root: projectRoot })
}

const candidates = dirEntries
  .filter(e => e.name.endsWith('.md'))
  // We don't filter symlinks here — we need to emit `bp1-rfc-malformed`
  // reason=symlink for them. lstat happens per-file below.
  .map(e => path.join(rfcsDir, e.name))

const acceptedRfcs = []
let malformedCount = 0

for (const filePath of candidates) {
  const relPath = path.relative(projectRoot, filePath)
  const outcome = processOneRfc(filePath, relPath)
  if (outcome.action === 'include') {
    acceptedRfcs.push({ path: relPath, frontmatter_sha256: outcome.frontmatter_sha256 })
  } else if (outcome.action === 'malformed') {
    malformedCount++
    emitMalformed(relPath, outcome.reason, outcome.detail)
  }
  // 'skip' → no-op
}

console.log(JSON.stringify({
  status: 'ok',
  project_root: projectRoot,
  rfcs: acceptedRfcs,
  malformed_count: malformedCount,
}))
process.exit(0)

// ===========================================================================
// processOneRfc — returns { action: 'include'|'skip'|'malformed', ... }
// ===========================================================================

function processOneRfc(filePath, relPath) {
  // Axis 2: lstat fail-closed on symlinks (mirror PR #170).
  let st
  try {
    st = fs.lstatSync(filePath)
  } catch (e) {
    return { action: 'malformed', reason: 'yaml-parse',
      detail: { parser_error_message: `lstat failed: ${e.message}` } }
  }
  if (st.isSymbolicLink()) {
    return { action: 'malformed', reason: 'symlink',
      detail: { link_target: tryReadlink(filePath) } }
  }
  if (!st.isFile()) {
    // Directory named *.md, FIFO, etc. — skip silently. (Authority root
    // discipline: docs/rfcs entries that aren't regular files don't count.)
    return { action: 'skip' }
  }

  // Bounded read: 8 KiB. Larger RFCs are fine — only frontmatter is read here.
  let buf
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      buf = Buffer.alloc(FRONTMATTER_READ_BYTES)
      const bytesRead = fs.readSync(fd, buf, 0, FRONTMATTER_READ_BYTES, 0)
      buf = buf.subarray(0, bytesRead)
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    return { action: 'malformed', reason: 'yaml-parse',
      detail: { parser_error_message: `read failed: ${e.message}` } }
  }

  const rawBytesSha256 = crypto.createHash('sha256').update(buf).digest('hex')

  // Fatal UTF-8 validation BEFORE any string operations (codex P1 fix).
  // `buf.toString('utf8')` lossy-decodes invalid bytes to U+FFFD, which would
  // bypass parseBp1Frontmatter's strict-decode path and let a malformed RFC
  // with valid-looking ASCII status: accepted slip through. Fail closed.
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
  } catch (e) {
    return { action: 'malformed', reason: 'yaml-parse',
      detail: { parser_error_message: `invalid UTF-8 in bounded read: ${e.message}`,
        raw_bytes_sha256: rawBytesSha256 } }
  }

  // Detect missing / not-frontmatter quickly: file must start with '---' line.
  const text = buf.toString('utf8')
  const lines = text.split('\n')
  if (lines.length < 2 || lines[0] !== FENCE_LINE) {
    // No frontmatter at all → silent skip (RFC may be a draft).
    return { action: 'skip' }
  }

  // Find closing fence within the bounded read.
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE_LINE) { closeIdx = i; break }
  }
  if (closeIdx === -1) {
    // Closing fence not within 8 KiB. We do NOT keep reading — slice 2b plan
    // v3 binds the read to 8 KiB to bound per-file memory and to keep the
    // canonical-bytes invariant well-defined.
    return { action: 'malformed', reason: 'frontmatter-exceeds-8kb-bound',
      detail: { raw_bytes_sha256: rawBytesSha256, scanned_bytes: buf.length } }
  }

  // Canonical frontmatter bytes — the content between the fences, exclusive.
  const fmText = lines.slice(1, closeIdx).join('\n')
  const { sha256: frontmatter_sha256 } = canonicalizeFrontmatterBytes(fmText)

  // Parse the full file (parseBp1Frontmatter wants opening + closing fences in
  // the input; we have them at lines[0] and lines[closeIdx]).
  const parseInput = lines.slice(0, closeIdx + 1).join('\n') + '\n'
  let parsed
  try {
    parsed = parseBp1Frontmatter(parseInput)
  } catch (e) {
    return { action: 'malformed', reason: 'yaml-parse',
      detail: { parser_error_message: e.message, raw_bytes_sha256: rawBytesSha256 } }
  }

  const fm = parsed.frontmatter
  if (!Object.prototype.hasOwnProperty.call(fm, 'status')) {
    // Frontmatter present, no status field → silent skip (draft RFC).
    return { action: 'skip' }
  }

  const routed = routeStatus(fm.status)
  if (routed.include) {
    return { action: 'include', frontmatter_sha256 }
  }
  if (routed.skip) {
    return { action: 'skip' }
  }
  return { action: 'malformed', reason: routed.reason,
    detail: {
      observed_value: describeStatus(fm.status),
      raw_bytes_sha256: rawBytesSha256,
    } }
}

// ===========================================================================
// Status routing matrix (plan v3, strict-parser semantics)
// ===========================================================================

function routeStatus(value) {
  if (value === null) return { reason: 'status-null-value' }
  if (Array.isArray(value)) return { reason: 'status-wrong-type' }
  if (typeof value === 'boolean') return { reason: 'status-wrong-type' }
  if (typeof value !== 'string') return { reason: 'status-wrong-type' }
  if (value === ACCEPTED_LITERAL) return { include: true }
  if (value === '') return { reason: 'status-empty-string' }
  // Precedence: whitespace-canonical match (trimmed === literal exactly) takes
  // priority over case-canonical match — a value of `"accepted "` reports the
  // more specific whitespace reason. A value of `"  ACCEPTED  "` has BOTH
  // problems but routes to `status-non-canonical` because the case-fold check
  // matches first after the whitespace-literal-match branch falls through.
  const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, '')
  if (trimmed === ACCEPTED_LITERAL && trimmed !== value) {
    return { reason: 'status-non-canonical-whitespace' }
  }
  if (trimmed.toLowerCase() === ACCEPTED_LITERAL && trimmed !== ACCEPTED_LITERAL) {
    return { reason: 'status-non-canonical' }
  }
  if (KNOWN_OTHER_STATUSES.has(value)) return { skip: true }
  // Forward-compat: unknown string values silent-skip. Numeric/date bare
  // tokens land here because parseBp1Frontmatter parses them as strings.
  return { skip: true }
}

function describeStatus(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(len=${value.length})`
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value).slice(0, 66) // 64-char cap + 2 quote chars
  return `${typeof value}`
}

function tryReadlink(p) {
  try { return fs.readlinkSync(p) } catch { return null }
}

// ===========================================================================
// emitMalformed — spawn em-store with cwd: projectRoot (Authority Root #2)
// ===========================================================================

function emitMalformed(relPath, reason, detail) {
  // Slice 2b plan v3 Authority Root #2: em-store spawn cwd MUST be projectRoot
  // so local-scope episodes land under projectRoot/.episodic-memory/, NOT the
  // caller's cwd. Failure here is swallowed — bp1-rfc-malformed evidence is
  // forensic; we never let an emit failure mask the scan result.
  try {
    if (!fs.existsSync(EM_STORE)) return
    const summary = `bp1-rfc-malformed: ${reason} in ${relPath}`
    const body = '# bp1-rfc-malformed\n\n' +
      `Reason: \`${reason}\`\n\nPath: \`${relPath}\`\n\n` +
      '```json\n' +
      JSON.stringify({
        project_root: projectRoot,
        path: relPath,
        reason,
        ...detail,
      }, null, 2) +
      '\n```\n'
    execFileSync('node', [
      EM_STORE,
      '--project', path.basename(projectRoot),
      '--category', 'violation',
      '--tags', `bp1,bp1-rfc-malformed,failure-row-3,${reason}`,
      '--scope', 'local',
      '--summary', summary,
      '--body', body,
    ], {
      cwd: projectRoot,           // mandatory per plan v3
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
    })
  } catch {
    // forensics best-effort
  }
}
