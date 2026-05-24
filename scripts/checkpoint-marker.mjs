#!/usr/bin/env node
/**
 * checkpoint-marker.mjs — Per-session checkpoint quartet marker helper.
 *
 * Rank-2 (sibling of PR #271 / closed #268 plan-marker, and #279 sibling
 * preflight-marker). Closes the cross-session bleed for the 4 checkpoint
 * markers: `.checkpoint-required`, `.post-checkpoint-required`,
 * `.pre-checkpoint-done`, `.post-checkpoint-done`.
 *
 * Diagnosis: 20260523-080453-diagnosis-multi-session-checkpoint-marke-08ec
 * Plan v4 (codex plan-tier R4 ACCEPT): 20260524-033911-reply-codex-to-...
 *
 * Modeled on scripts/plan-marker.mjs (identical session-id sourcing,
 * atomic temp+rename, exit-code semantics, root validation).
 *
 * Session-id source: process.env.CLAUDE_CODE_SESSION_ID (NOT a CLI flag).
 * Mirrors PR #271's helper architecture exactly — the env var is the
 * trusted source-of-truth for the current session; a `--session-id`
 * flag would create a forgery surface the helper can't validate
 * (codex R2 P1 / R3 P1 / R4 ACCEPT under option-2 trust model).
 *
 * Usage:
 *   node ~/.episodic-memory/scripts/checkpoint-marker.mjs \
 *     --target .checkpoint-required \
 *     --action arm-if-missing \
 *     --root <abs>
 *
 * --target <name>: one of CHECKPOINT_QUARTET (4 marker basenames).
 * --action <act>:
 *   arm-if-missing — no-op if <legacy>.<sid> OR legacy literal exists at
 *                    either root; else atomic write empty file at
 *                    <root>/.checkpoints/<legacy>.<sid>. Best-effort by
 *                    design — callers (em-recall, checkpoint-gate) wrap
 *                    `|| true` to preserve fail-soft semantics under set -e.
 *   touch          — ensurePrimaryDir + atomic write empty file at
 *                    <root>/.checkpoints/<legacy>.<sid>. Force-overwrite.
 *                    Used by agent for content-bearing checkpoint blocks
 *                    (the actual block content is appended by the caller
 *                    after this returns — this helper only ensures the
 *                    suffixed marker exists at the primary root).
 *   rm             — Remove ONLY <legacy>.<sid> at primary AND legacy
 *                    roots. NEVER touches bare suffix-less <legacy>
 *                    (read-only-during-burn-in, mirrors PR #271 F3).
 *                    Own-session only by construction — sid comes from
 *                    env CLAUDE_CODE_SESSION_ID.
 *
 * Exit codes (matches plan-marker convention):
 *   0 — success; stdout is JSON {status:"ok", action, target, path|removed, sid}
 *   3 — fs write/rename/unlink failed
 *   4 — --root missing
 *   5 — --root invalid (non-abs / non-existent / non-dir / no repo signal)
 *   6 — mutex violation (unknown arg, missing --target / --action, etc.)
 *   7 — --target not in CHECKPOINT_QUARTET
 *   8 — CLAUDE_CODE_SESSION_ID missing/empty/invalid
 *   9 — --action not in {arm-if-missing | touch | rm}
 */

import fs from 'fs'
import path from 'path'
import process from 'process'

import {
  ensurePrimaryDir,
  primaryMarkerPath,
  legacyMarkerPath,
  namespacedMarkerBasenameForSession,
  anyNamespacedMarkerExists,
  CHECKPOINT_QUARTET,
  PRIMARY_MARKER_DIR,
} from './lib/marker-paths.mjs'
import { SESSION_ID_RE, validateSessionId } from './lib/session-id.mjs'
import { validateRoot, RootValidationError } from './lib/marker-root-validation.mjs'

const VALID_ACTIONS = ['arm-if-missing', 'touch', 'rm']

function fail(code, message) {
  process.stderr.write(`checkpoint-marker: ${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { root: null, target: null, action: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      args.root = argv[++i]
    } else if (a === '--target') {
      args.target = argv[++i]
    } else if (a === '--action') {
      args.action = argv[++i]
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: checkpoint-marker.mjs --target <name> --action <act> --root <abs>\n' +
        '  --target: one of ' + CHECKPOINT_QUARTET.join(' | ') + '\n' +
        '  --action: arm-if-missing | touch | rm\n' +
        '  Session-id read from CLAUDE_CODE_SESSION_ID env var.\n' +
        '  Exit: 0 ok / 3 fs / 4 root-missing / 5 root-invalid /\n' +
        '        6 arg-mutex / 7 bad-target / 8 sid-invalid / 9 bad-action\n'
      )
      process.exit(0)
    } else {
      fail(6, `unknown argument: ${a}`)
    }
  }
  return args
}

function getSessionIdOrExit() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID
  if (sid === undefined || sid === null || sid === '') {
    fail(8, 'SESSION_ID_REQUIRED: CLAUDE_CODE_SESSION_ID env var missing or empty')
  }
  if (!validateSessionId(sid)) {
    fail(8, `SESSION_ID_INVALID: must match ${SESSION_ID_RE.source}, got: ${JSON.stringify(sid)}`)
  }
  return sid
}

function validateRootOrExit(rootArg) {
  try {
    return validateRoot(rootArg)
  } catch (e) {
    if (e instanceof RootValidationError) fail(e.code, e.message)
    throw e
  }
}

function validateTargetOrExit(target) {
  if (target === null || target === undefined) {
    fail(6, 'MISSING_ARG: --target is required')
  }
  if (!CHECKPOINT_QUARTET.includes(target)) {
    fail(7, `BAD_TARGET: --target must be one of [${CHECKPOINT_QUARTET.join(', ')}], got: ${JSON.stringify(target)}`)
  }
}

function validateActionOrExit(action) {
  if (action === null || action === undefined) {
    fail(6, 'MISSING_ARG: --action is required')
  }
  if (!VALID_ACTIONS.includes(action)) {
    fail(9, `BAD_ACTION: --action must be one of [${VALID_ACTIONS.join(', ')}], got: ${JSON.stringify(action)}`)
  }
}

/**
 * Atomic temp+rename write of an empty file at the given final path. Same
 * pattern as plan-marker.mjs actionTouch — rename(2) is atomic on the same
 * filesystem; SIGINT/SIGTERM cleanup prevents temp orphans.
 */
function atomicWriteEmpty(canonicalRoot, basename) {
  const finalPath = primaryMarkerPath(canonicalRoot, basename)
  const hr = process.hrtime.bigint().toString()
  const tempName = `.${basename}.${process.pid}.${hr}.tmp`
  const tempPath = path.join(canonicalRoot, PRIMARY_MARKER_DIR, tempName)

  let cleanupTemp = true
  const onSig = (signal) => {
    if (cleanupTemp) {
      try { fs.unlinkSync(tempPath) } catch { /* best-effort */ }
    }
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGINT', () => onSig('SIGINT'))
  process.on('SIGTERM', () => onSig('SIGTERM'))

  try {
    fs.writeFileSync(tempPath, '')
    fs.renameSync(tempPath, finalPath)
    cleanupTemp = false
  } catch (e) {
    try { fs.unlinkSync(tempPath) } catch { /* best-effort */ }
    fail(3, `WRITE_FAILED: ${e.message}`)
  }
  return finalPath
}

function actionArmIfMissing(canonicalRoot, target, sid) {
  // No-op if any form of the target marker exists (own-session suffixed OR
  // legacy literal, at either root). Mirrors em-recall.mjs armCheckpointMarker
  // semantics — idempotent, best-effort, doesn't overwrite live state.
  if (anyNamespacedMarkerExists(canonicalRoot, target)) {
    process.stdout.write(JSON.stringify({
      status: 'ok',
      action: 'arm-if-missing',
      target,
      sid,
      noop: true,
    }) + '\n')
    process.exit(0)
  }
  ensurePrimaryDir(canonicalRoot)
  const basename = namespacedMarkerBasenameForSession(target, sid)
  const finalPath = atomicWriteEmpty(canonicalRoot, basename)
  process.stdout.write(JSON.stringify({
    status: 'ok',
    action: 'arm-if-missing',
    target,
    sid,
    path: finalPath,
    noop: false,
  }) + '\n')
  process.exit(0)
}

function actionTouch(canonicalRoot, target, sid) {
  // Force-overwrite. Used for content-bearing markers (.pre/.post-checkpoint-done)
  // where the caller will append the block content after this returns. This
  // helper only ensures the suffixed marker file exists at primary root.
  ensurePrimaryDir(canonicalRoot)
  const basename = namespacedMarkerBasenameForSession(target, sid)
  const finalPath = atomicWriteEmpty(canonicalRoot, basename)
  process.stdout.write(JSON.stringify({
    status: 'ok',
    action: 'touch',
    target,
    sid,
    path: finalPath,
  }) + '\n')
  process.exit(0)
}

function actionRm(canonicalRoot, target, sid) {
  // Own-session only by construction: sid comes from env. Removes ONLY the
  // suffixed form at primary + legacy roots. NEVER touches bare legacy
  // literal — read-only-during-burn-in invariant (PR #271 F3).
  const basename = namespacedMarkerBasenameForSession(target, sid)
  const primary = primaryMarkerPath(canonicalRoot, basename)
  const legacy = legacyMarkerPath(canonicalRoot, basename)
  const removed = []

  for (const p of [primary, legacy]) {
    try {
      fs.unlinkSync(p)
      removed.push(p)
    } catch (e) {
      if (e.code !== 'ENOENT') {
        fail(3, `RM_FAILED: ${e.message} (${p})`)
      }
      // ENOENT is fine — idempotent rm.
    }
  }

  process.stdout.write(JSON.stringify({
    status: 'ok',
    action: 'rm',
    target,
    sid,
    removed,
  }) + '\n')
  process.exit(0)
}

function main() {
  const { root, target, action } = parseArgs(process.argv)

  validateTargetOrExit(target)
  validateActionOrExit(action)

  const sid = getSessionIdOrExit()
  const canonicalRoot = validateRootOrExit(root)

  switch (action) {
    case 'arm-if-missing': actionArmIfMissing(canonicalRoot, target, sid); break
    case 'touch':          actionTouch(canonicalRoot, target, sid); break
    case 'rm':             actionRm(canonicalRoot, target, sid); break
    /* istanbul ignore next */ default:
      fail(9, `BAD_ACTION (unreachable): ${action}`)
  }
}

main()
