#!/usr/bin/env node
/**
 * bp1-marker-validate.mjs — Pure approval-marker validator (RFC-004 §540 row 7,
 * §1304 row 3, slice 2d-R).
 *
 * Called by `.claude/hooks/bp1-approval-check.sh` (H1) per marker to determine
 * whether the marker is a trustworthy auto-approve signal.
 *
 * Validation pipeline (fail-closed at every step):
 *   1. argv shape: `--project`, `--run-id` both required + shape-valid.
 *   2. Project root: realpath `--project`, must be absolute + exist.
 *   3. Marker path: derived via `markerPath(projectRoot, runId)` — caller-side
 *      `.checkpoints/bp1-approval-<run_id>.json`.
 *   4. `fs.lstatSync(markerPath)`: if symlink → fail-closed (`reason: "symlink"`).
 *      Mirrors PR #170 fix verbatim. NEVER follow symlinks.
 *   5. Read marker JSON. JSON.parse failure → `reason: "malformed-json"`.
 *   6. Field shape: required 6 fields present + correct types. Missing any →
 *      `reason: "missing-fields"`. Type mismatch → `reason: "shape-error"`.
 *   7. `run_id` IN-MARKER must match `--run-id` argv. Mismatch → `reason:
 *      "run-id-mismatch"` (anti-splice from foreign run).
 *   8. mtime-vs-baseline: `fs.lstatSync().mtimeMs` must be within ±10s of the
 *      marker's `created_at` field (parsed as Date). Drift → `reason:
 *      "mtime-drift"`. Defense-in-depth against touch(1) tampering even though
 *      `created_at` is HMAC-canonical.
 *   9. body_sha256: recompute from canonical payload via canonicalizeMarkerPayload.
 *      Mismatch with marker's stored body_sha256 → `reason: "sha256-mismatch"`.
 *  10. HMAC: load `<projectRoot>/.episodic-memory/runs/<run_id>/run.key` via
 *      `loadRunKey`. Verify marker's `hmac` field via `verifyCanonical`.
 *      Verification failure → `reason: "hmac-mismatch"`. Key missing/mode/size
 *      drift → `reason: "key-<error>"` (e.g. `key-missing`, `key-mode`).
 *  11. Expiry: compute `expired = Date.now() >= Date.parse(deadline_at)`.
 *      Expiry is INFORMATIONAL — does not affect validation status. The hook
 *      uses it to decide whether to auto-approve.
 *
 * Pure validation: NO episode emission, NO state mutation. Callers (the hook
 * helper bp1-emit-marker-invalid-evidence.mjs) handle evidence emission for the
 * three cases (A: signed, B: unsigned-stderr, C: unparseable-stderr). RFC §675
 * caller-side-evidence ownership split.
 *
 * Stdout: discriminated-union JSON. Always single-line for line-buffered hook
 * consumption. Always exit 0 on validation completion (status field encodes
 * outcome). Exit 2 reserved for argv/project-resolution errors that prevent
 * even attempting validation.
 *
 * Output schema (status: "ok" | "invalid" | "missing"):
 *   {
 *     status,
 *     run_id,
 *     marker_path,
 *     reason: null | <enum>,
 *     decided_class: <string> | null,
 *     deadline_at: <ISO-8601> | null,
 *     created_at: <ISO-8601> | null,
 *     expired: <bool>,
 *     now_ms,
 *   }
 *
 * Argv:
 *   --project <path>     required, will be realpath'd
 *   --run-id <id>        required, RUN_ID_RE shape
 *   --skip-mtime-check   testing-only: bypass step 8 (used by fixtures that
 *                        can't synchronize file mtime with created_at)
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  markerPath,
  canonicalizeMarkerPayload,
} from './lib/bp1-marker.mjs'
import { verifyCanonical } from './lib/bp1-hmac.mjs'
import { loadRunKey } from './lib/bp1-keys.mjs'

const RUN_ID_RE = /^[a-z0-9-]+$/
const MTIME_DRIFT_TOLERANCE_MS = 10_000

function parseArgs(argv) {
  const out = { project: null, runId: null, skipMtimeCheck: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project' && i + 1 < argv.length) {
      out.project = argv[++i]
    } else if (a === '--run-id' && i + 1 < argv.length) {
      out.runId = argv[++i]
    } else if (a === '--skip-mtime-check') {
      out.skipMtimeCheck = true
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: bp1-marker-validate.mjs --project <path> --run-id <id> [--skip-mtime-check]\n',
      )
      process.exit(0)
    } else {
      process.stderr.write(`unknown argv: ${a}\n`)
      process.exit(2)
    }
  }
  return out
}

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n')
}

function emitInvalid(reason, runId, target, partial = {}) {
  emit({
    status: 'invalid',
    run_id: runId,
    marker_path: target,
    reason,
    decided_class: partial.decided_class ?? null,
    deadline_at: partial.deadline_at ?? null,
    created_at: partial.created_at ?? null,
    expired: false,
    now_ms: Date.now(),
  })
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.project) {
    process.stderr.write('error: --project required\n')
    process.exit(2)
  }
  if (!args.runId || !RUN_ID_RE.test(args.runId)) {
    process.stderr.write('error: --run-id required and must match RUN_ID_RE\n')
    process.exit(2)
  }
  let projectRoot
  try {
    projectRoot = fs.realpathSync(args.project)
  } catch (_e) {
    process.stderr.write(`error: --project does not exist: ${args.project}\n`)
    process.exit(2)
  }

  const target = markerPath(projectRoot, args.runId)

  // Step 4: lstat fail-closed on symlinks. NEVER follow.
  let lstat
  try {
    lstat = fs.lstatSync(target)
  } catch (e) {
    if (e.code === 'ENOENT') {
      emit({
        status: 'missing',
        run_id: args.runId,
        marker_path: target,
        reason: null,
        decided_class: null,
        deadline_at: null,
        created_at: null,
        expired: false,
        now_ms: Date.now(),
      })
      return
    }
    emitInvalid(`lstat-failed:${e.code || 'unknown'}`, args.runId, target)
    return
  }
  if (lstat.isSymbolicLink()) {
    emitInvalid('symlink', args.runId, target)
    return
  }
  if (!lstat.isFile()) {
    emitInvalid('not-a-file', args.runId, target)
    return
  }

  // Step 5: read + parse.
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (e) {
    emitInvalid(`read-failed:${e.code || 'unknown'}`, args.runId, target)
    return
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_e) {
    emitInvalid('malformed-json', args.runId, target)
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    emitInvalid('shape-error', args.runId, target)
    return
  }

  // Step 6: field shape.
  const REQUIRED = ['body_sha256', 'created_at', 'deadline_at', 'decided_class', 'hmac', 'run_id']
  for (const k of REQUIRED) {
    if (typeof parsed[k] !== 'string' || parsed[k] === '') {
      emitInvalid('missing-fields', args.runId, target, parsed)
      return
    }
  }

  // Step 6b: strict key set (PR-level audit F3 closure 2026-05-17).
  // Authorization-bearing markers must carry exactly the canonical 6-field
  // set. Extra fields are NOT in body_sha256 / HMAC canonical bytes, so an
  // attacker (or a future-version writer) can append unsigned fields without
  // failing HMAC verification — creating forward-version drift and forensic
  // ambiguity. Reject any extra keys explicitly. A versioned-extension
  // envelope policy (if ever needed) requires an RFC amendment + canonicalize
  // schema bump.
  const ALLOWED_KEYS = new Set(REQUIRED)
  const extraKeys = Object.keys(parsed).filter(k => !ALLOWED_KEYS.has(k))
  if (extraKeys.length > 0) {
    emitInvalid(`unknown-fields:${extraKeys.sort().join(',')}`, args.runId, target, parsed)
    return
  }

  // Step 7: in-marker run_id must match --run-id (anti-splice).
  if (parsed.run_id !== args.runId) {
    emitInvalid('run-id-mismatch', args.runId, target, parsed)
    return
  }

  // Step 8: mtime-vs-baseline (skippable for tests).
  const createdAtMs = Date.parse(parsed.created_at)
  if (Number.isNaN(createdAtMs)) {
    emitInvalid('created-at-unparseable', args.runId, target, parsed)
    return
  }
  if (!args.skipMtimeCheck) {
    const drift = Math.abs(lstat.mtimeMs - createdAtMs)
    if (drift > MTIME_DRIFT_TOLERANCE_MS) {
      emitInvalid('mtime-drift', args.runId, target, parsed)
      return
    }
  }

  // Step 9: recompute body_sha256.
  let canonical
  try {
    canonical = canonicalizeMarkerPayload({
      run_id: parsed.run_id,
      created_at: parsed.created_at,
      decided_class: parsed.decided_class,
      deadline_at: parsed.deadline_at,
    })
  } catch (_e) {
    // canonicalizeMarkerPayload throws on shape violations (e.g. decided_class
    // not in VALID_DECIDED_CLASSES). Treat as a shape-error rather than letting
    // the throw escape.
    emitInvalid('shape-error', args.runId, target, parsed)
    return
  }
  if (canonical.sha256 !== parsed.body_sha256) {
    emitInvalid('sha256-mismatch', args.runId, target, parsed)
    return
  }

  // Step 10: load per-run key + verify HMAC.
  const keyResult = loadRunKey(projectRoot, args.runId)
  if (keyResult.error) {
    emitInvalid(`key-${keyResult.error}`, args.runId, target, parsed)
    return
  }
  if (!verifyCanonical(canonical.canonicalBytes, keyResult.key32B, parsed.hmac)) {
    emitInvalid('hmac-mismatch', args.runId, target, parsed)
    return
  }

  // Step 11: expiry (informational).
  const deadlineMs = Date.parse(parsed.deadline_at)
  const nowMs = Date.now()
  const expired = !Number.isNaN(deadlineMs) && nowMs >= deadlineMs

  emit({
    status: 'ok',
    run_id: args.runId,
    marker_path: target,
    reason: null,
    decided_class: parsed.decided_class,
    deadline_at: parsed.deadline_at,
    created_at: parsed.created_at,
    expired,
    now_ms: nowMs,
  })
}

main()
