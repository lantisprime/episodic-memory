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
 *   node ~/.episodic-memory/scripts/plan-marker.mjs --touch   --root <abs>
 *   node ~/.episodic-memory/scripts/plan-marker.mjs --rm      --root <abs>
 *   node ~/.episodic-memory/scripts/plan-marker.mjs --approve --root <abs>
 *
 * Session-id source: process.env.CLAUDE_CODE_SESSION_ID (probed exposed
 * to Bash subprocesses 2026-05-13). NO file-based source-of-truth (the
 * `.current-session-id` file design from plan v1 was deleted after
 * planner Class C1 caught the cross-session race).
 *
 * --touch:
 *   1. Read CLAUDE_CODE_SESSION_ID; FAIL exit 8 if empty/unset/invalid
 *   2. validateRoot(--root)
 *   3. Stale-clear: rm the EXACT `.plan-approved.<sid>` at both roots (a new
 *      pending plan supersedes any prior approval for this session; no glob —
 *      prefix-collision safe)
 *   4. Atomic write empty file at <root>/.checkpoints/.plan-approval-pending.<sid>
 *
 * --rm (F3 narrowed semantics, per codex r1 F1 fold):
 *   1. Same env + root validation
 *   2. rm ONLY `.plan-approval-pending.<MY_SID>` at primary + legacy roots
 *   3. NEVER touches bare suffix-less `.plan-approval-pending` — that's
 *      reserved for burn-in compat from sessions still using the pre-v6
 *      Rule 8 fallback. Legacy is read-only-during-burn-in; cleared only
 *      by SessionStart orphan sweep (em-recall.mjs).
 *   NOTE: bare `--rm` no longer implies approval — it only clears pending.
 *   The ONLY sanctioned approval is --approve (planapproval redesign).
 *
 * --approve (planapproval redesign — the ONLY sanctioned approval):
 *   1. Same env + root validation
 *   2. Atomic write empty file at `.plan-approved.<sid>` (the approval token
 *      that checkpoint-gate's arm consumes — one-shot)
 *   3. rm `.plan-approval-pending.<sid>` at primary + legacy roots
 *   Ordering is fail-safe toward "plan still pending": create token first,
 *   then clear pending. checkpoint-gate arms `.checkpoint-required` ONLY when
 *   `.plan-approved.<sid>` exists, and deletes it on arm.
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
  namespacedMarkerBasenameForSession,
  PLAN_APPROVED_LEGACY_BASENAME,
} from './lib/marker-paths.mjs'
import { SESSION_ID_RE, validateSessionId } from './lib/session-id.mjs'
import { validateRoot, RootValidationError } from './lib/marker-root-validation.mjs'

function fail(code, message) {
  process.stderr.write(`plan-marker: ${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { root: null, touch: false, rm: false, approve: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') {
      args.root = argv[++i]
    } else if (a === '--touch') {
      args.touch = true
    } else if (a === '--rm') {
      args.rm = true
    } else if (a === '--approve') {
      args.approve = true
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: plan-marker.mjs (--touch | --rm | --approve) --root <abs>\n' +
        '  --touch:   arm the pending plan-approval marker (stale-clears the approval token)\n' +
        '  --rm:      remove the pending plan-approval marker (own session only)\n' +
        '  --approve: atomically create the approval token AND remove the pending\n' +
        '             marker — the ONLY sanctioned approval.\n' +
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

// Atomic temp+rename write of an empty file at <root>/.checkpoints/<basename>.
// rename(2) is atomic on the same filesystem; SIGINT/SIGTERM cleanup prevents
// temp orphans. Mirrors checkpoint-marker.mjs atomicWriteEmpty. On failure,
// calls fail(3) (process exits). Returns the final path on success.
function atomicWriteEmpty(canonicalRoot, basename) {
  const finalPath = primaryMarkerPath(canonicalRoot, basename)
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
  return finalPath
}

// Idempotent removal of <basename> at BOTH primary and legacy roots. ENOENT is
// fine (idempotent rm); any other fs error fails the process (exit 3). Returns
// the list of paths actually removed.
function rmMarkerBothRoots(canonicalRoot, basename) {
  const removed = []
  for (const p of [
    primaryMarkerPath(canonicalRoot, basename),
    legacyMarkerPath(canonicalRoot, basename),
  ]) {
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
  return removed
}

function actionTouch(canonicalRoot, sid) {
  ensurePrimaryDir(canonicalRoot)

  // Stale-clear (planapproval redesign, design point 3): a NEW pending plan
  // supersedes any prior approval for THIS session. Delete the EXACT
  // `.plan-approved.<sid>` (no glob — prefix-collision safe: sid=abc must not
  // touch .plan-approved.abc2) so a stale approval can't arm a checkpoint
  // against the new plan. Own-session only (sid from env).
  const approvedBasename = namespacedMarkerBasenameForSession(PLAN_APPROVED_LEGACY_BASENAME, sid)
  const staleCleared = rmMarkerBothRoots(canonicalRoot, approvedBasename)

  const basename = planMarkerBasenameForSession(sid)
  const finalPath = atomicWriteEmpty(canonicalRoot, basename)

  process.stdout.write(JSON.stringify({ status: 'ok', path: finalPath, staleCleared, sid }) + '\n')
  process.exit(0)
}

function actionApprove(canonicalRoot, sid) {
  // The ONLY sanctioned plan approval (planapproval redesign, design point 1).
  // Bare `rm` of the pending marker no longer implies approval — only this
  // action creates the `.plan-approved.<sid>` token that checkpoint-gate's
  // arm consumes.
  //
  // Ordering = fail-safe toward "plan still pending": create the approval token
  // FIRST (atomic rename), THEN remove the pending marker. If the create fails,
  // pending remains (no spurious arm). If the rm fails after create, both exist
  // briefly — plan-gate still blocks on pending, so no write arms until pending
  // clears; harmless and self-corrects on the next --approve/--rm.
  ensurePrimaryDir(canonicalRoot)
  const approvedBasename = namespacedMarkerBasenameForSession(PLAN_APPROVED_LEGACY_BASENAME, sid)
  const approvedPath = atomicWriteEmpty(canonicalRoot, approvedBasename)

  const pendingBasename = planMarkerBasenameForSession(sid)
  const removed = rmMarkerBothRoots(canonicalRoot, pendingBasename)

  process.stdout.write(JSON.stringify({ status: 'ok', approved: approvedPath, removed, sid }) + '\n')
  process.exit(0)
}

function actionRm(canonicalRoot, sid) {
  // F3 narrowed: rm ONLY the SUFFIXED form at primary + legacy roots.
  // Bare suffix-less `.plan-approval-pending` is never touched — its
  // lifecycle is owned by SessionStart orphan-sweep during burn-in.
  const basename = planMarkerBasenameForSession(sid)
  const removed = rmMarkerBothRoots(canonicalRoot, basename)
  process.stdout.write(JSON.stringify({ status: 'ok', removed, sid }) + '\n')
  process.exit(0)
}

function main() {
  const { root, touch, rm, approve } = parseArgs(process.argv)

  const actionCount = (touch ? 1 : 0) + (rm ? 1 : 0) + (approve ? 1 : 0)
  if (actionCount > 1) {
    fail(6, 'MUTEX_VIOLATION: specify exactly one of --touch, --rm, or --approve')
  }
  if (actionCount === 0) {
    fail(6, 'MISSING_ACTION: specify exactly one of --touch, --rm, or --approve')
  }

  const sid = getSessionIdOrExit()
  const canonicalRoot = validateRootOrExit(root)

  if (touch) {
    actionTouch(canonicalRoot, sid)
  } else if (rm) {
    actionRm(canonicalRoot, sid)
  } else {
    actionApprove(canonicalRoot, sid)
  }
}

main()
