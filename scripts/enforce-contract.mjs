#!/usr/bin/env node
/**
 * enforce-contract.mjs — Enforcement thin-waist (RFC-008 P3b, R1).
 *
 * P3b-1 scope: the `stop` gate decision, RELOCATED VERBATIM from em-recall.mjs's
 * `--gate stop` handler into the enforcement layer. This is the R1 strong-form
 * correction — the memory substrate (em-store / em-recall / em-search) MUST own
 * ZERO enforcement code (RFC-008:83,85); em-recall's surviving `--gate stop`
 * handler is the last violator and is DELETED in P3d once this consumer migrates.
 *
 * The claude-code stop decision is purely marker-state (RFC-008:464 — "the `stop`
 * gate is NOT per-label … it reads marker state, not command labels"), so this
 * slice reads NO contract / registry / config / events files. The contract-driven
 * effective-tier layer (effective_tier = min(harness, contract, config), the
 * `plugins/_index.json` capability lookup, the per-project clamp, and CLASS-C(a)
 * fail-closed-on-`unsupported`) is INERT for claude-code — min(STRONG,STRONG,
 * identity)=STRONG→refuse_stop reproduces today's unconditional behavior — and so
 * defers to P3b-2, landing with its real dependencies (an install-runtime contract
 * deploy + the P4 config schema). See docs/rfcs/RFC-008/P3-thin-waist.md.
 *
 * Behavior is byte-identical to `em-recall --gate stop` — stdout, exit code,
 * stderr (modulo the script-name prefix), and no marker side-effects — proven by
 * tests/test-enforce-contract.mjs (parity suite vs em-recall).
 *
 * Marker reads are owned by scripts/lib/marker-state.mjs (the R1-owned reader
 * extracted in P3a). This module performs ZERO marker logic of its own — it only
 * orchestrates the marker-state helpers into the stop decision.
 */

import fs from 'fs'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from './lib/local-dir.mjs'
import {
  BASELINE_NAME,
  writeMarkerPath,
  namespacedMarkerBasenameForSession,
} from './lib/marker-paths.mjs'
import {
  _maxMtimeAcrossRootsStrict,
  _maxMtimeAcrossRootsForPlanMarkerStrict,
  resolveOwnSessionMarkerRead,
  stopGateCarveOutApplies,
} from './lib/marker-state.mjs'
import { validateSessionId } from './lib/session-id.mjs'

/**
 * decideStop — pure stop-gate decision (no I/O, no process exit).
 *
 * Relocated VERBATIM from em-recall.mjs:141-217 (R1). em-recall's handler had
 * three terminal control-flow points; all translate to a `return` here so the
 * function is pure and the CLI wrapper is the sole I/O boundary:
 *   em-recall:182 process.exit(0)  → return null                  (plan-pending allow)
 *   em-recall:211 console.log({…})  → return {decision,reason}     (block)
 *   em-recall:216 process.exit(0)  → return null                  (carve-out / no-marker allow)
 *
 * @param {{repoRoot: string, sid: string|null}} opts
 *   repoRoot — the gate root (caller resolves via resolveRepoRoot() from cwd, the
 *              same module-load semantics as em-recall.mjs:48; stop-gate.sh `cd`s
 *              to the hook input `.cwd` before spawning, so cwd IS the project).
 *   sid      — validated own-session id, or null (legacy-literal-only mode).
 * @returns {{decision:'block', reason:string} | null}  null = allow stop.
 */
export function decideStop({ repoRoot, sid }) {
  // #178 F1: defer stop-gate when plan is ACTIVELY pending at EITHER root.
  // The plan-gate blocks Write/Bash while .plan-approval-pending exists at
  // either root, creating an unrecoverable triangle when stop-gate ALSO
  // blocks. The exemption narrows to ACTIVE plan-pending only (mtime >
  // baseline) — orphan plan-pending falls through to the existing carve-out.
  //
  // Strict-lstat semantics via _maxMtimeAcrossRootsStrict (codex round-3 F11
  // + round-6 F17): ENOENT skips; any other lstat error (EACCES, ENOTDIR,
  // EIO, ELOOP) → hadOtherError → fail closed. Symlink at EITHER root → fail
  // closed (same-class with carve-out symmetric defense).
  //
  // Dual-root semantics (codex round-2 F8): plan-pending and baseline are BOTH
  // evaluated across primary and legacy.
  //
  // #268 fix E19: plan-pending deferral fires for ANY plan-marker variant
  // (legacy literal OR any suffixed) — own session or other.
  const planPending = _maxMtimeAcrossRootsForPlanMarkerStrict(repoRoot)
  const baseStrict = _maxMtimeAcrossRootsStrict(repoRoot, BASELINE_NAME)
  if (
    planPending.anyExisted && !planPending.hadSymlink && !planPending.hadOtherError &&
    baseStrict.anyExisted && !baseStrict.hadSymlink && !baseStrict.hadOtherError &&
    planPending.mtime > baseStrict.mtime
  ) {
    return null // em-recall:182 process.exit(0)
  }

  // Rank-2: session-aware reads. Resolution order for each quartet member:
  //   1. <root>/.checkpoints/<name>.<sid>   2. <root>/.claude/<name>.<sid>
  //   3. <root>/.checkpoints/<name>         4. <root>/.claude/<name>
  // When sid is null (invalid/missing), only steps 3-4 are checked (graceful
  // degrade per codex R2 Q3). Other sessions' suffixed markers are NOT probed.
  const preReqPath = resolveOwnSessionMarkerRead(repoRoot, '.checkpoint-required', sid)
  const postDonePath = resolveOwnSessionMarkerRead(repoRoot, '.post-checkpoint-done', sid)
  let postDoneSize = 0
  if (postDonePath) {
    try { postDoneSize = fs.statSync(postDonePath).size } catch {}
  }
  if (preReqPath && postDoneSize === 0) {
    if (!stopGateCarveOutApplies(repoRoot, sid)) {
      // Block-message path: emit suffixed write path when sid is valid; legacy
      // literal otherwise. Agent's block-write goes to the suffixed path.
      const writeBasename = sid
        ? namespacedMarkerBasenameForSession('.post-checkpoint-done', sid)
        : '.post-checkpoint-done'
      const writePath = writeMarkerPath(repoRoot, writeBasename)
      const reason = `Post-implementation checkpoint required. Write the Rule 18 post-implementation checkpoint block to ${writePath} (must be non-empty), then end your turn again. Hook: stop-gate.sh.`
      return { decision: 'block', reason } // em-recall:211 console.log
    }
    // else: carve-out applies — allow (return null below).
  }
  // Otherwise: allow stop. Empty stdout on Stop = allow Claude to stop.
  return null // em-recall:216 process.exit(0)
}

// ---------------------------------------------------------------------------
// CLI — the ONLY I/O + process.exit boundary. Invoked by hooks/stop-gate.sh as
// `node enforce-contract.mjs --gate stop [--session-id <sid>]`. Empty stdout =
// allow; `{decision:"block", reason}` = block. process.exit(0) on every decision
// path (exit-code parity with em-recall — a non-zero block would trip
// stop-gate.sh's `|| {block}` envelope and double-emit).
// ---------------------------------------------------------------------------
// Robust main-module detection. A plain `import.meta.url === pathToFileURL(argv[1])`
// compare FAILS when the install path contains a symlink component (macOS
// /var→/private/var, /tmp→/private/tmp, a symlinked $HOME or .episodic-memory):
// import.meta.url is canonical while pathToFileURL(argv[1]) is not, so isMain
// would be false, the CLI block would silently no-op, and the stop gate would
// degrade to allow-always — a fail-OPEN bug. realpath BOTH sides so a symlinked
// install path still resolves as main. (Caught by test-stop-gate.sh's
// /var/folders fixture during P3b-1 E2E; pinned by test-enforce-contract.mjs
// "CLI via symlinked path".)
const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    if (i === -1 || i + 1 >= argv.length) return undefined
    return argv[i + 1]
  }

  const VALID_GATES = ['stop']
  const gateFlag = flag('--gate')
  if (gateFlag !== 'stop') {
    const got = gateFlag === undefined ? 'none' : `"${gateFlag}"`
    console.log(JSON.stringify({ status: 'error', message: `enforce-contract: --gate stop is required (got ${got}). Valid gates: ${VALID_GATES.join(', ')}` }))
    process.exit(1)
  }

  // --session-id parse + validate — verbatim semantics from em-recall.mjs:78-86.
  // Missing/invalid → legacy-literal-only mode (hook reliability outweighs strict
  // contract per codex R2 Q3). The stderr warning is reproduced verbatim with the
  // script-name prefix retargeted (the only allowed parity delta vs em-recall).
  const sessionIdFlag = flag('--session-id')
  let mySid = null
  if (sessionIdFlag !== undefined) {
    if (sessionIdFlag !== '' && validateSessionId(sessionIdFlag)) {
      mySid = sessionIdFlag
    } else if (sessionIdFlag !== '') {
      process.stderr.write(`enforce-contract: warn — --session-id "${sessionIdFlag}" failed validateSessionId; legacy-literal-only mode\n`)
    }
  }

  // Gate root resolved from cwd (em-recall.mjs:48 parity). stop-gate.sh `cd`s to
  // the hook input `.cwd` before spawning, so this converges with the project the
  // hook named (closes #106 worktree-orphan for this gate).
  const repoRoot = resolveRepoRoot()
  const decision = decideStop({ repoRoot, sid: mySid })
  if (decision) {
    console.log(JSON.stringify(decision))
  }
  process.exit(0)
}
