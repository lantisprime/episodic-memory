#!/usr/bin/env node
/**
 * preflight-marker-write.mjs — Atomic writer for Layer D pre-flight markers.
 *
 * Why exist:
 *   The pre-flight gate (`hooks/preflight-gate.sh`) requires a structured JSON
 *   marker at `<root>/.checkpoints/.preflight-done` (and a sibling
 *   `.last-user-prompt.json` for turn-id derivation). Both files MUST be
 *   written atomically — partial writes during a tight reader loop would
 *   make the gate intermittently-pass / intermittently-fail.
 *
 *   Claude Code's `Write` tool is NOT a POSIX `rename(2)` API. To make the
 *   atomicity contract locally verifiable, this helper:
 *     1) reads JSON from stdin, validates parse,
 *     2) writes to a unique-named temp file in the SAME directory as final,
 *     3) `fs.renameSync(temp, final)` — atomic on same filesystem,
 *     4) on any failure: best-effort `unlinkSync(temp)` and exit non-zero.
 *
 *   Gate enforces helper-only writes by denying direct `Write`/`Edit`/
 *   `MultiEdit` to the final marker basename.
 *
 * Usage:
 *   echo '<JSON>'  | node /abs/path/preflight-marker-write.mjs --root /abs/repo --target preflight
 *   echo '<JSON>'  | node /abs/path/preflight-marker-write.mjs --root /abs/repo --target last-prompt --session-id <sid>
 *   cat input.json | node /abs/path/preflight-marker-write.mjs --root /abs/repo --target preflight
 *
 * Per-session namespacing (`--target last-prompt`):
 *   The last-prompt file is keyed by session_id to avoid cross-session
 *   liveness collisions (plan-time audit F4, scratch/238-plan-v2.md).
 *   Basename: `.last-user-prompt.<session_id>.json`. session_id is required
 *   for that target and must match `[A-Za-z0-9_-]{1,128}` (no dots, no
 *   slashes — prevents basename injection past the `.json` suffix).
 *   The preflight target is unchanged: single `.preflight-done` per repo,
 *   session-bound via marker JSON content.
 *
 * Exit codes:
 *   0 — success; stdout is `{"status":"ok","path":"<final>","bytes":N}`
 *   2 — JSON parse failed
 *   3 — fs write/rename failed
 *   4 — `--root` missing (no implicit cwd fallback)
 *   5 — `--root` invalid (non-existent OR not a repo root signal)
 *   6 — `--target` missing or invalid value
 *   7 — stdin read error
 *   8 — `--session-id` missing/invalid when target=last-prompt
 *
 * Discovered: codex r2 reply `20260512-071449-...-6e90` (atomicity invariant
 *   not locally verifiable for agent-side Write).
 * Refined:    codex r3-r5 (helper-only contract + --root required +
 *   canonicalize-path-tolerant lib for `--root` validation).
 * Extended:   plan v2 C2 — `--session-id` for last-prompt namespacing (F4).
 *
 * Composes with:
 *   - scripts/lib/local-dir.mjs — resolveRepoRoot for --root validation.
 *   - scripts/lib/marker-paths.mjs — primaryMarkerPath, ensurePrimaryDir.
 *   - scripts/lib/canonicalize-path-tolerant.mjs — symlink-aware --root check.
 */

import fs from 'fs'
import path from 'path'
import process from 'process'

import { ensurePrimaryDir, primaryMarkerPath } from './lib/marker-paths.mjs'
import { canonicalizePathTolerant } from './lib/canonicalize-path-tolerant.mjs'

// preflight target → fixed basename; last-prompt target → suffix template
// where {sid} is substituted with the validated --session-id value.
const VALID_TARGETS = {
  preflight: { kind: 'fixed', basename: '.preflight-done' },
  'last-prompt': { kind: 'session', template: '.last-user-prompt.{sid}.json' }
}

// session_id format: alphanumeric, underscore, dash. No dots (could collide
// with the `.json` suffix), no slashes (path traversal), length-capped.
// Claude Code session IDs are UUIDs (hyphenated hex); this regex covers
// them while rejecting anything that could escape the basename.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function fail(code, message) {
  process.stderr.write(`preflight-marker-write: ${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { root: null, target: null, sessionId: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      args.root = argv[++i]
    } else if (a === '--target') {
      args.target = argv[++i]
    } else if (a === '--session-id') {
      args.sessionId = argv[++i]
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: echo "<JSON>" | preflight-marker-write.mjs --root <abs> --target <preflight|last-prompt> [--session-id <sid>]\n' +
        '  --session-id required when --target=last-prompt (alphanumeric/underscore/dash, max 128 chars)\n'
      )
      process.exit(0)
    } else {
      fail(6, `unknown argument: ${a}`)
    }
  }
  return args
}

// Resolve the marker basename for a target, validating any required
// per-target args (e.g. --session-id for last-prompt).
function resolveBasename(target, sessionId) {
  const spec = VALID_TARGETS[target]
  if (spec.kind === 'fixed') return spec.basename
  // kind === 'session'
  if (!sessionId) {
    fail(8, `SESSION_ID_REQUIRED: --session-id <sid> is mandatory when --target=${target}`)
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    fail(8, `SESSION_ID_INVALID: must match ${SESSION_ID_RE.source}, got: ${sessionId}`)
  }
  return spec.template.replace('{sid}', sessionId)
}

function validateRoot(rootArg) {
  if (!rootArg) fail(4, 'ROOT_REQUIRED: --root <abs> is mandatory; no cwd fallback')
  if (!path.isAbsolute(rootArg)) fail(5, `ROOT_INVALID: --root must be absolute, got: ${rootArg}`)

  let canonical
  try {
    canonical = canonicalizePathTolerant(rootArg, process.cwd())
  } catch (e) {
    fail(5, `ROOT_INVALID: canonicalization failed: ${e.message}`)
  }

  let stat
  try {
    stat = fs.statSync(canonical)
  } catch (e) {
    fail(5, `ROOT_INVALID: ${canonical} does not exist (${e.code})`)
  }
  if (!stat.isDirectory()) fail(5, `ROOT_INVALID: ${canonical} is not a directory`)

  // Repo signal: must contain .git OR .checkpoints OR .episodic-memory.
  // Any one is sufficient — the project may have any subset depending on
  // initialization state. Refusing without a signal prevents writing markers
  // into arbitrary user directories.
  const signals = ['.git', '.checkpoints', '.episodic-memory']
  const hasSignal = signals.some((s) => fs.existsSync(path.join(canonical, s)))
  if (!hasSignal) {
    fail(5, `ROOT_NOT_REPO: ${canonical} has none of [${signals.join(', ')}]`)
  }

  return canonical
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch (e) {
    fail(7, `stdin read failed: ${e.message}`)
  }
}

function main() {
  const { root, target, sessionId } = parseArgs(process.argv)
  if (!target) fail(6, 'TARGET_REQUIRED: --target <preflight|last-prompt>')
  if (!Object.prototype.hasOwnProperty.call(VALID_TARGETS, target)) {
    fail(6, `TARGET_INVALID: ${target}; valid: ${Object.keys(VALID_TARGETS).join(', ')}`)
  }

  const canonicalRoot = validateRoot(root)
  const basename = resolveBasename(target, sessionId)
  const finalPath = primaryMarkerPath(canonicalRoot, basename)

  const raw = readStdinSync()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    fail(2, `JSON parse failed: ${e.message}`)
  }
  // B1: reject non-object payloads (null, [], 42, "string"). Markers are
  // structured records; `null`/`[]` would parse but produce semantically
  // invalid markers the gate then has to reject downstream.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(2, `JSON payload must be a non-null object; got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`)
  }
  const serialized = JSON.stringify(parsed, null, 2)
  const bytes = Buffer.byteLength(serialized, 'utf8')

  ensurePrimaryDir(canonicalRoot)

  // Unique temp name in same dir as final → rename(2) atomic on same FS.
  const hr = process.hrtime.bigint().toString()
  const tempName = `.${basename}.${process.pid}.${hr}.tmp`
  const tempPath = path.join(canonicalRoot, '.checkpoints', tempName)

  let cleanupTemp = true
  process.on('SIGINT', () => {
    if (cleanupTemp) try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    if (cleanupTemp) try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    process.exit(143)
  })

  try {
    fs.writeFileSync(tempPath, serialized)
    fs.renameSync(tempPath, finalPath)
    cleanupTemp = false
  } catch (e) {
    try { fs.unlinkSync(tempPath) } catch { /* best-effort */ }
    fail(3, `WRITE_FAILED: ${e.message}`)
  }

  process.stdout.write(JSON.stringify({ status: 'ok', path: finalPath, bytes }) + '\n')
  process.exit(0)
}

main()
