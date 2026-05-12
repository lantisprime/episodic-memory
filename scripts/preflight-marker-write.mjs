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
 *   echo '<JSON>'  | node /abs/path/preflight-marker-write.mjs --root /abs/repo --target last-prompt
 *   cat input.json | node /abs/path/preflight-marker-write.mjs --root /abs/repo --target preflight
 *
 * Exit codes:
 *   0 — success; stdout is `{"status":"ok","path":"<final>","bytes":N}`
 *   2 — JSON parse failed
 *   3 — fs write/rename failed
 *   4 — `--root` missing (no implicit cwd fallback)
 *   5 — `--root` invalid (non-existent OR not a repo root signal)
 *   6 — `--target` missing or invalid value
 *   7 — stdin read error
 *
 * Discovered: codex r2 reply `20260512-071449-...-6e90` (atomicity invariant
 *   not locally verifiable for agent-side Write).
 * Refined:    codex r3-r5 (helper-only contract + --root required +
 *   canonicalize-path-tolerant lib for `--root` validation).
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

const VALID_TARGETS = {
  preflight: '.preflight-done',
  'last-prompt': '.last-user-prompt.json'
}

function fail(code, message) {
  process.stderr.write(`preflight-marker-write: ${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { root: null, target: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      args.root = argv[++i]
    } else if (a === '--target') {
      args.target = argv[++i]
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: echo "<JSON>" | preflight-marker-write.mjs --root <abs> --target <preflight|last-prompt>\n'
      )
      process.exit(0)
    } else {
      fail(6, `unknown argument: ${a}`)
    }
  }
  return args
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
  const { root, target } = parseArgs(process.argv)
  if (!target) fail(6, 'TARGET_REQUIRED: --target <preflight|last-prompt>')
  if (!Object.prototype.hasOwnProperty.call(VALID_TARGETS, target)) {
    fail(6, `TARGET_INVALID: ${target}; valid: ${Object.keys(VALID_TARGETS).join(', ')}`)
  }

  const canonicalRoot = validateRoot(root)
  const basename = VALID_TARGETS[target]
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
