#!/usr/bin/env node
/**
 * plan-marker.mjs — Per-session .plan-approval-pending marker helper.
 *
 * Issue #268: cross-session .plan-approval-pending orphan markers block
 * unrelated sessions. This helper writes / removes per-session markers
 * `.plan-approval-pending.<session_id>` so each session's plan-gate state
 * is filename-isolated.
 *
 * Modeled on scripts/preflight-marker-write.mjs (same canonicalization,
 * same atomic temp+rename, same exit-code semantics). Shares the
 * extracted libs:
 *   - scripts/lib/session-id.mjs           SESSION_ID_RE + validateSessionId
 *   - scripts/lib/marker-root-validation.mjs validateRoot + RootValidationError
 *   - scripts/lib/marker-paths.mjs         primaryMarkerPath / legacyMarkerPath /
 *                                          planMarkerBasenameForSession
 *
 * Usage:
 *   node ~/.episodic-memory/scripts/plan-marker.mjs --touch --root <abs>
 *   node ~/.episodic-memory/scripts/plan-marker.mjs --rm    --root <abs>
 *
 * Session-id source: process.env.CLAUDE_CODE_SESSION_ID (probed exposed
 * to Bash subprocesses 2026-05-13). NO file-based source-of-truth (the
 * `.current-session-id` file design from plan v1 was deleted after
 * planner Class C1 caught the cross-session race).
 *
 * --touch:
 *   1. Read CLAUDE_CODE_SESSION_ID; FAIL exit 8 if empty/unset/invalid
 *   2. validateRoot(--root)
 *   3. Atomic write empty file at <root>/.checkpoints/.plan-approval-pending.<sid>
 *
 * --rm (F3 narrowed semantics, per codex r1 F1 fold):
 *   1. Same env + root validation
 *   2. rm ONLY `.plan-approval-pending.<MY_SID>` at primary + legacy roots
 *   3. NEVER touches bare suffix-less `.plan-approval-pending` — that's
 *      reserved for burn-in compat from sessions still using the pre-v6
 *      Rule 8 fallback. Legacy is read-only-during-burn-in; cleared only
 *      by SessionStart orphan sweep (em-recall.mjs).
 *
 * Exit codes (matches preflight-marker-write convention):
 *   0 — success; stdout is JSON {status:"ok", path|removed, sid}
 *   3 — fs write/rename/unlink failed
 *   4 — --root missing (no implicit cwd fallback)
 *   5 — --root invalid (non-abs / non-existent / non-dir / no repo signal)
 *   6 — --touch/--rm mutex violation (both set, or neither set, or unknown arg)
 *   8 — CLAUDE_CODE_SESSION_ID missing/empty/invalid
 */

import fs from 'fs'
import path from 'path'
import process from 'process'

import {
  ensurePrimaryDir,
  primaryMarkerPath,
  legacyMarkerPath,
  planMarkerBasenameForSession,
} from './lib/marker-paths.mjs'
import { SESSION_ID_RE, validateSessionId } from './lib/session-id.mjs'
import { validateRoot, RootValidationError } from './lib/marker-root-validation.mjs'

function fail(code, message) {
  process.stderr.write(`plan-marker: ${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { root: null, touch: false, rm: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      args.root = argv[++i]
    } else if (a === '--touch') {
      args.touch = true
    } else if (a === '--rm') {
      args.rm = true
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: plan-marker.mjs (--touch | --rm) --root <abs>\n' +
        '  Session-id read from CLAUDE_CODE_SESSION_ID env var.\n' +
        '  Exit codes: 0 ok / 3 fs / 4 root-missing / 5 root-invalid / 6 mutex / 8 sid-invalid\n'
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

function actionTouch(canonicalRoot, sid) {
  ensurePrimaryDir(canonicalRoot)
  const basename = planMarkerBasenameForSession(sid)
  const finalPath = primaryMarkerPath(canonicalRoot, basename)

  // Unique temp name in same dir → rename(2) atomic on same filesystem.
  const hr = process.hrtime.bigint().toString()
  const tempName = `.${basename}.${process.pid}.${hr}.tmp`
  const tempPath = path.join(canonicalRoot, '.checkpoints', tempName)

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

  process.stdout.write(JSON.stringify({ status: 'ok', path: finalPath, sid }) + '\n')
  process.exit(0)
}

function actionRm(canonicalRoot, sid) {
  // F3 narrowed: rm ONLY the SUFFIXED form at primary + legacy roots.
  // Bare suffix-less `.plan-approval-pending` is never touched — its
  // lifecycle is owned by SessionStart orphan-sweep during burn-in.
  const basename = planMarkerBasenameForSession(sid)
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

  process.stdout.write(JSON.stringify({ status: 'ok', removed, sid }) + '\n')
  process.exit(0)
}

function main() {
  const { root, touch, rm } = parseArgs(process.argv)

  if (touch && rm) {
    fail(6, 'MUTEX_VIOLATION: cannot specify both --touch and --rm')
  }
  if (!touch && !rm) {
    fail(6, 'MISSING_ACTION: specify exactly one of --touch or --rm')
  }

  const sid = getSessionIdOrExit()
  const canonicalRoot = validateRootOrExit(root)

  if (touch) {
    actionTouch(canonicalRoot, sid)
  } else {
    actionRm(canonicalRoot, sid)
  }
}

main()
