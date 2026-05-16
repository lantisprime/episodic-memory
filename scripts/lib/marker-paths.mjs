/**
 * marker-paths.mjs — Shared marker-path constants and helpers.
 *
 * Mirrors hooks/lib/marker-paths.sh (single source of truth split for
 * shell/node parity). Import from em-* scripts and use the helpers below.
 *
 * Background: Claude Code's built-in sensitive-file guard prompts on Write
 * to any basename matching `.X` inside a `.claude/` segment, regardless of
 * allowlist. To escape the prompt, marker writes go to a sibling
 * `.checkpoints/` directory. Reads honor both during burn-in (primary
 * `.checkpoints/` first, fallback `.claude/` second) until the legacy
 * branch is removed in a follow-up commit.
 *
 * Six markers in migration scope:
 *
 *   Marker name                    | Set membership
 *   ---                            | ---
 *   .checkpoint-required           | TASK_SIGNAL + CHECKPOINT_CLEANUP
 *   .post-checkpoint-required      | TASK_SIGNAL + CHECKPOINT_CLEANUP
 *   .plan-approval-pending         | TASK_SIGNAL only (not cleared by push)
 *   .pre-checkpoint-done           | CHECKPOINT_CLEANUP only
 *   .post-checkpoint-done          | CHECKPOINT_CLEANUP only
 *   .session-baseline              | BASELINE only
 *
 * Adjacent UX-marker classes (NOT in any of the above sets):
 *
 *   .so-runbook-shown.<sha8>       | UX-marker only — tracks "model has been
 *                                    shown the second-opinion harness runbook
 *                                    this session." Excluded from TASK_SIGNAL
 *                                    AND CHECKPOINT_CLEANUP. SessionStart glob
 *                                    is the only cleanup path. Recognized by
 *                                    classifier marker_write handlers and by
 *                                    checkpoint-gate's runbook exemption case.
 *
 * Set semantics:
 *   TASK_SIGNAL_MARKERS         3 markers — em-recall stop-gate carve-out
 *                               class (mid-session mtime > baseline = task
 *                               work in progress). Mirrors em-recall.mjs:97.
 *   CHECKPOINT_CLEANUP_MARKERS  4 markers — push-gate clears on successful
 *                               push (Codex round-1 F2: must sweep BOTH
 *                               .checkpoints/ AND .claude/ during burn-in).
 *                               Mirrors prior checkpoint-gate.sh:200.
 *   ALL_MIGRATED_MARKERS        6 names — full migration scope used by
 *                               tests, sweep tools, and SessionEnd cleanup.
 *
 * Codex round-2 ACCEPT (episode 20260509-044331-...-bc1c) per plan v3 §B.
 */

import fs from 'fs'
import path from 'path'

export const PRIMARY_MARKER_DIR = '.checkpoints'
export const LEGACY_MARKER_DIR = '.claude'
export const BASELINE_NAME = '.session-baseline'

// Task-signal markers — em-recall stop-gate carve-out class. Mirrors
// em-recall.mjs:97-101 (TASK_SIGNAL_MARKERS).
export const TASK_SIGNAL_MARKERS = [
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.plan-approval-pending'
]

// Push-gate cleanup class — markers cleared on a successful push that has
// satisfied the post-checkpoint. .plan-approval-pending is intentionally
// NOT here (its lifecycle is plan-gate's marker_write allowance, not
// checkpoint cleanup). Mirrors the prior checkpoint-gate.sh:200 list.
export const CHECKPOINT_CLEANUP_MARKERS = [
  '.checkpoint-required',
  '.pre-checkpoint-done',
  '.post-checkpoint-required',
  '.post-checkpoint-done'
]

// Full migration scope = task-signal + done markers + baseline = 6 names.
// Used by sweep tools and tests to validate completeness.
export const ALL_MIGRATED_MARKERS = [
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.plan-approval-pending',
  '.pre-checkpoint-done',
  '.post-checkpoint-done',
  '.session-baseline'
]

export function primaryMarkerPath(repoRoot, basename) {
  return path.join(repoRoot, PRIMARY_MARKER_DIR, basename)
}

export function legacyMarkerPath(repoRoot, basename) {
  return path.join(repoRoot, LEGACY_MARKER_DIR, basename)
}

/**
 * Returns the primary path if it exists, otherwise the legacy path if it
 * exists, otherwise null. Use for readers that need a single-path semantic
 * (e.g. fs.statSync to read mtime/size).
 *
 * Symlink-aware via fs.existsSync (which follows links). Callers that need
 * symlink-fail-closed semantics (e.g. stop-gate carve-out per
 * 20260505-124511-...-845f) MUST re-check with fs.lstatSync after.
 */
export function resolveMarkerRead(repoRoot, basename) {
  const primary = primaryMarkerPath(repoRoot, basename)
  if (fs.existsSync(primary)) return primary
  const legacy = legacyMarkerPath(repoRoot, basename)
  if (fs.existsSync(legacy)) return legacy
  return null
}

/**
 * Returns the primary path (always). Use for ALL writes. The legacy branch
 * is read-only during burn-in.
 */
export function writeMarkerPath(repoRoot, basename) {
  return primaryMarkerPath(repoRoot, basename)
}

/**
 * Returns [primaryPath, legacyPath]. Use for cleanup (rm both) and
 * orphan-clear sweeps that must touch both roots until fallback removal.
 */
export function bothMarkerPaths(repoRoot, basename) {
  return [primaryMarkerPath(repoRoot, basename), legacyMarkerPath(repoRoot, basename)]
}

/**
 * Ensure the primary marker directory exists. Idempotent. Use before
 * writeMarkerPath writes.
 */
export function ensurePrimaryDir(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, PRIMARY_MARKER_DIR), { recursive: true })
}

// ---------------------------------------------------------------------------
// #268 fix — per-session .plan-approval-pending marker contract.
//
// Canonical (new):   .plan-approval-pending.<session_id>     (per-session)
// Legacy (burn-in):  .plan-approval-pending                  (suffix-less)
//
// Both forms accepted by readers/gates during burn-in. Helper writes only
// the suffixed form. SessionStart orphan-sweep clears both. SessionEnd
// own-session-only deletes the suffixed form for the ending session.
//
// Shell parity: hooks/lib/marker-paths.sh PLAN_MARKER_*. Drift caught by
// scripts/validate-plan-marker-sites.mjs Direction 0.
// ---------------------------------------------------------------------------

export const PLAN_MARKER_LEGACY_BASENAME = '.plan-approval-pending'
export const PLAN_MARKER_BASENAME_TEMPLATE = '.plan-approval-pending.{sid}'
export const PLAN_MARKER_BASENAME_RE = /^\.plan-approval-pending(\.[A-Za-z0-9_-]{1,128})?$/

/**
 * Strict match for plan-marker basenames. Accepts ONLY:
 *   .plan-approval-pending                          (legacy suffix-less)
 *   .plan-approval-pending.<sid>                    (sid matches char-class + length)
 * Rejects:
 *   .plan-approval-pending-extra                    (suffix without dot separator)
 *   .plan-approval-pending.                         (empty suffix)
 *   .plan-approval-pending./traversal               (slash in suffix)
 *   .plan-approval-pending..                        (dot in suffix)
 *   .plan-approval-pending.<129-char>               (oversize suffix)
 *
 * Mirrors hooks/lib/marker-paths.sh plan_marker_basename_matches().
 *
 * @param {string} basename
 * @returns {boolean}
 */
export function planMarkerBasenameMatches(basename) {
  return typeof basename === 'string' && PLAN_MARKER_BASENAME_RE.test(basename)
}

/**
 * Compose the per-session plan-marker basename for a given session id.
 * Caller MUST validateSessionId(sid) first; this helper does not re-validate.
 *
 * @param {string} sid — valid session-id (matches SESSION_ID_RE)
 * @returns {string} '.plan-approval-pending.<sid>'
 */
export function planMarkerBasenameForSession(sid) {
  return PLAN_MARKER_BASENAME_TEMPLATE.replace('{sid}', sid)
}

// ---------------------------------------------------------------------------
// #279 fix — per-session .preflight-done marker contract.
//
// Canonical (new):   .preflight-done.<session_id>     (per-session)
// Legacy (burn-in):  .preflight-done                  (suffix-less)
//
// Sibling of PLAN_MARKER_* (#268 / PR #271). Both forms accepted by
// readers/gates during burn-in. Helper writes only the suffixed form when
// --session-id is provided to --target preflight.
//
// SessionStart orphan-sweep / SessionEnd own-session-only cleanup of the
// per-session form are FU — see issue #283 (`any_preflight_marker_exists`
// is defined for future wiring; not yet called by lifecycle hooks).
//
// Shell parity: hooks/lib/marker-paths.sh PREFLIGHT_MARKER_*. Drift
// detection extension to validate-plan-marker-sites.mjs for PREFLIGHT_*
// constants is FU — see issue #283 (validator currently covers
// PLAN_MARKER_* only).
// ---------------------------------------------------------------------------

export const PREFLIGHT_MARKER_LEGACY_BASENAME = '.preflight-done'
export const PREFLIGHT_MARKER_BASENAME_TEMPLATE = '.preflight-done.{sid}'
export const PREFLIGHT_MARKER_BASENAME_RE = /^\.preflight-done(\.[A-Za-z0-9_-]{1,128})?$/

/**
 * Strict match for preflight-marker basenames. Accepts ONLY:
 *   .preflight-done                                 (legacy suffix-less)
 *   .preflight-done.<sid>                           (sid matches char-class + length)
 * Rejects:
 *   .preflight-done-extra                           (suffix without dot separator)
 *   .preflight-done.                                (empty suffix)
 *   .preflight-done./traversal                      (slash in suffix)
 *   .preflight-done..                               (dot in suffix)
 *   .preflight-done.<129-char>                      (oversize suffix)
 *
 * Mirrors hooks/lib/marker-paths.sh preflight_marker_basename_matches().
 *
 * @param {string} basename
 * @returns {boolean}
 */
export function preflightMarkerBasenameMatches(basename) {
  return typeof basename === 'string' && PREFLIGHT_MARKER_BASENAME_RE.test(basename)
}

/**
 * Compose the per-session preflight-marker basename for a given session id.
 * Caller MUST validateSessionId(sid) first; this helper does not re-validate.
 *
 * @param {string} sid — valid session-id (matches SESSION_ID_RE)
 * @returns {string} '.preflight-done.<sid>'
 */
export function preflightMarkerBasenameForSession(sid) {
  return PREFLIGHT_MARKER_BASENAME_TEMPLATE.replace('{sid}', sid)
}

// ---------------------------------------------------------------------------
// Enforcement-site registry — single source of truth for the validator.
//
// Every place in the codebase that recognizes, gates, iterates, or otherwise
// acts on `.plan-approval-pending` is registered here with:
//   - file:    relative path from repo root
//   - line:    target line number (validator reads ±20 lines for site span)
//   - role:    human-readable description
//   - kind:    semantic-test category (see Direction 1 in validator)
//   - semantic_role: one of {read-own-session, read-any, sweep-stale,
//                            remove-own-session, write-own-session, decoupled}
//
// Lifecycle: line numbers may drift after edits. The validator uses
// `role` + content-shape regex as the canonical lookup, with line as a hint.
// Any unregistered code reference to `.plan-approval-pending` outside test/
// doc/comment context → CI fails via validate-plan-marker-sites.mjs D2.
// ---------------------------------------------------------------------------

export const PLAN_MARKER_ENFORCEMENT_SITES = [
  // E1-E5: classifier basename allowlists (5 case-arms in command-classifier.sh).
  // Each routes shell verb (rm/redirect/tee/touch) + classify_path through
  // marker_write classification when target matches plan-marker basename.
  { file: 'hooks/lib/command-classifier.sh', line: 516, role: 'rm-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'hooks/lib/command-classifier.sh', line: 640, role: 'redirect-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'hooks/lib/command-classifier.sh', line: 685, role: 'tee-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'hooks/lib/command-classifier.sh', line: 725, role: 'touch-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'hooks/lib/command-classifier.sh', line: 1310, role: 'classify_path marker_write basename', kind: 'shell-case', semantic_role: 'read-any' },

  // E5b: classifier helper-invocation recognition (NEW in #268 fix commit 6).
  // F17+F18 reject leading POSIX-name env assignment before classifying as marker_write.
  { file: 'hooks/lib/command-classifier.sh', line: 0, role: 'plan-marker.mjs helper invocation classification (F13+F17+F18)', kind: 'shell-case-helper-invocation-strict', semantic_role: 'read-own-session' },

  // E6-E9: checkpoint-gate.sh detector patterns/predicates (4 sites).
  { file: 'hooks/checkpoint-gate.sh', line: 99, role: 'marker_basename_for_target exact-equality', kind: 'shell-equality', semantic_role: 'read-any' },
  { file: 'hooks/checkpoint-gate.sh', line: 120, role: '_marker_basename_in_set closed set', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'hooks/checkpoint-gate.sh', line: 196, role: '_command_has_relative_marker_path grep-E alternation', kind: 'grep-E-alternation', semantic_role: 'read-any' },
  { file: 'hooks/checkpoint-gate.sh', line: 213, role: '_command_first_absolute_noncanonical grep-oE alternation', kind: 'grep-E-alternation', semantic_role: 'read-any' },

  // E10: plan-gate.sh existence check + marker_write allowlist.
  { file: 'hooks/plan-gate.sh', line: 57, role: 'PLAN_PENDING_W resolution + existence check + marker_write allowlist (session-aware after #268 fix)', kind: 'shell-equality', semantic_role: 'read-own-session' },

  // E11: scripts/em-recall.mjs TASK_SIGNAL_MARKERS array literal (consumer).
  { file: 'scripts/em-recall.mjs', line: 97, role: 'TASK_SIGNAL_MARKERS array literal (consumer)', kind: 'js-array', semantic_role: 'read-any' },

  // E12: scripts/em-audit-compliance.mjs compliance regex.
  { file: 'scripts/em-audit-compliance.mjs', line: 111, role: 'compliance audit regex (\\.plan-approval-pending\\b accepts both forms)', kind: 'js-regex', semantic_role: 'read-any' },

  // E13: NEW plan_marker_exists_for_session helper definition (checkpoint-gate.sh).
  { file: 'hooks/checkpoint-gate.sh', line: 82, role: 'plan_marker_exists_for_session helper definition (NEW in #268 fix)', kind: 'shell-function', semantic_role: 'read-own-session' },

  // E14, E15, E17: cross-gate decision call-sites in checkpoint-gate.sh (3 sites).
  // Swap `marker_exists .plan-approval-pending` → `plan_marker_exists_for_session "$MY_SID"`.
  { file: 'hooks/checkpoint-gate.sh', line: 376, role: 'cross-gate plan-pending check (Bash marker_write branch)', kind: 'shell-predicate-call', semantic_role: 'read-own-session' },
  { file: 'hooks/checkpoint-gate.sh', line: 436, role: 'cross-gate plan-pending check (Write/Edit branch)', kind: 'shell-predicate-call', semantic_role: 'read-own-session' },
  { file: 'hooks/checkpoint-gate.sh', line: 481, role: 'push-gate plan-pending cleanup guard', kind: 'shell-predicate-call', semantic_role: 'read-own-session' },

  // E16, E18: decoupled gate sites (DIFFERENT markers; validator asserts no coupling).
  { file: 'hooks/checkpoint-gate.sh', line: 459, role: 'pre-checkpoint gate (.checkpoint-required — DIFFERENT marker)', kind: 'shell-decoupled', semantic_role: 'decoupled' },
  { file: 'hooks/checkpoint-gate.sh', line: 497, role: 'pre→post arming gate (.checkpoint-required — DIFFERENT marker)', kind: 'shell-decoupled', semantic_role: 'decoupled' },

  // E19-E20: em-recall.mjs iteration consumers.
  { file: 'scripts/em-recall.mjs', line: 170, role: 'TASK_SIGNAL_MARKERS carve-out loop (glob-expands suffixed forms)', kind: 'js-array-iter', semantic_role: 'read-any' },
  { file: 'scripts/em-recall.mjs', line: 587, role: 'TASK_SIGNAL_MARKERS orphan-clear sweep (glob-expands suffixed forms)', kind: 'js-array-iter', semantic_role: 'sweep-stale' },

  // E21: em-session-end-prompt.mjs own-session-only delete (F12 — codex r1 F1 fold).
  { file: 'scripts/em-session-end-prompt.mjs', line: 19, role: 'SessionEnd cleanup (own-session-only — F12)', kind: 'js-array-iter-own-session', semantic_role: 'remove-own-session' },

  // E22: command-classifier.sh push-cleanup loop (DECOUPLED — plan-pending not in CHECKPOINT_CLEANUP_MARKERS).
  { file: 'hooks/lib/command-classifier.sh', line: 482, role: 'push-cleanup loop over CHECKPOINT_CLEANUP_MARKERS (REFERENCE — plan-pending intentionally excluded)', kind: 'shell-loop-decoupled', semantic_role: 'decoupled' },
]
