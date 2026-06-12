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
 * Seven markers in migration scope:
 *
 *   Marker name                    | Set membership
 *   ---                            | ---
 *   .checkpoint-required           | TASK_SIGNAL + CHECKPOINT_CLEANUP
 *   .post-checkpoint-required      | TASK_SIGNAL + CHECKPOINT_CLEANUP
 *   .plan-approval-pending         | TASK_SIGNAL only (not cleared by push)
 *   .plan-approved                 | ALL_MIGRATED only — own-session cleanup
 *                                    (approval token; created by plan-marker
 *                                    --approve, consumed at checkpoint-gate arm,
 *                                    one-shot). Deliberately NOT in
 *                                    CHECKPOINT_CLEANUP: the push sweep globs all
 *                                    sessions' suffixed forms, which would delete
 *                                    a CONCURRENT session's live token and skip
 *                                    its pre-checkpoint (review F1). It is
 *                                    consumed at arm in the normal flow; orphans
 *                                    are own-session-cleaned at SessionEnd.
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
 *                               Mirrors prior checkpoint-gate.sh:200. (.plan-approved
 *                               is intentionally excluded — see review F1.)
 *   ALL_MIGRATED_MARKERS        7 names — full migration scope used by
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
// satisfied the post-checkpoint. The push sweep glob-deletes ALL sessions'
// suffixed forms (`<marker>.*`) — the convergence semantics for the quartet.
// .plan-approval-pending is NOT here (plan-gate owns its lifecycle). .plan-approved
// is NOT here either (review F1): it is the per-session authorization-to-arm
// token, so cross-session glob-deletion would skip a concurrent session's
// pre-checkpoint. It is consumed at arm in the normal flow; own-session orphans
// are cleaned at SessionEnd via ALL_MIGRATED_MARKERS.
export const CHECKPOINT_CLEANUP_MARKERS = [
  '.checkpoint-required',
  '.pre-checkpoint-done',
  '.post-checkpoint-required',
  '.post-checkpoint-done'
]

// Full migration scope = task-signal + approval token + done markers +
// baseline = 7 names. Used by sweep tools and tests to validate completeness.
export const ALL_MIGRATED_MARKERS = [
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.plan-approval-pending',
  '.plan-approved',
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
 *
 * Parent-dir symlink rejection (codex round 4 P1, #364): the primary marker
 * directory MUST be a real directory, never a symlink. Pattern matches
 * classifier-marker.mjs:validateMarkerStoreDir which has refused symlinked
 * `.checkpoints/` since the codex BLOCKER #1 round on that fix. Without
 * this guard, an attacker who plants `<repo>/.checkpoints -> <outside>`
 * makes every subsequent marker write physically land outside the
 * substrate while the gate reports paths inside it.
 *
 * Self-healing semantics (consistent with hooks/checkpoint-gate.sh
 * _arm_marker_via_touch_safely for leaf markers): if the dir is detected
 * as a symlink, `unlink` it and recreate as a real dir. The user-facing
 * substrate is restored without operator intervention (per
 * feedback_never_make_user_run_marker_commands — agent's substrate is
 * agent's job). Symlink target file is untouched (rename/unlink at the
 * symlink itself, not through it). ENOENT → mkdir; existing real
 * directory → idempotent no-op.
 *
 * Throws only on EMARKERDIRNOTDIR (path exists as a regular file, not a
 * directory) — that's a different class of substrate corruption that
 * deserves explicit surface.
 */
export function ensurePrimaryDir(repoRoot) {
  const dir = path.join(repoRoot, PRIMARY_MARKER_DIR)
  let st
  try { st = fs.lstatSync(dir) }
  catch (e) {
    if (e.code !== 'ENOENT') throw e
    // Doesn't exist — create as a regular directory.
    fs.mkdirSync(dir, { recursive: true })
    return
  }
  if (st.isSymbolicLink()) {
    // Symlink at marker-dir path — substrate tamper. Unlink (the symlink
    // entry itself, NOT its target — fs.unlinkSync on a symlink path
    // removes the link, not the target file) and recreate as a real dir.
    fs.unlinkSync(dir)
    fs.mkdirSync(dir, { recursive: true })
    return
  }
  if (!st.isDirectory()) {
    const err = new Error(`primary marker path exists but is not a directory: ${dir}`)
    err.code = 'EMARKERDIRNOTDIR'
    throw err
  }
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
// Checkpoint-planapproval redesign — `.plan-approved` approval token.
//
// Lifecycle: plan-marker.mjs --approve atomically creates
// `.plan-approved.<sid>` (and removes `.plan-approval-pending.<sid>`).
// checkpoint-gate.sh's _arm_checkpoint_required_if_missing arms
// `.checkpoint-required` ONLY when `.plan-approved.<sid>` exists, and CONSUMES
// (deletes) it on arm — one-shot, so an approval can't leak into a later
// planning phase. plan-marker.mjs --touch stale-clears the EXACT
// `.plan-approved.<sid>` (no glob — prefix-collision safe).
//
// Per-session form `.plan-approved.<sid>` uses the generic namespaced-marker
// helpers (namespacedMarkerBasenameForSession / namespacedMarkerBasenameMatches
// / anyNamespacedMarkerExists). Shell parity: PLAN_APPROVED_LEGACY_BASENAME in
// hooks/lib/marker-paths.sh.
//
// NOTE: a forged or wrong-root `.plan-approved` is INERT — arm only reads
// `.plan-approved.<sid>` at the repo root, and a forged token only opts the
// session INTO the checkpoint lifecycle (more friction), never bypassing a
// gate. So it is intentionally NOT plumbed into the wrong-root / relative-
// marker detectors (unlike the agent-writable quartet/plan-pending markers).
// ---------------------------------------------------------------------------

export const PLAN_APPROVED_LEGACY_BASENAME = '.plan-approved'

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

/**
 * Suffixed-ONLY preflight-marker match (checkpoint-hygiene F4, closes part
 * of #283). Accepts `.preflight-done.<sid>`; rejects the legacy suffix-less
 * `.preflight-done` — its lifecycle belongs to the burn-in cutover (F7),
 * not the per-session orphan sweep. Reuses PREFLIGHT_MARKER_BASENAME_RE
 * (suffix capture group must be non-null) so the two matchers cannot drift.
 *
 * @param {string} basename
 * @returns {boolean}
 */
export function preflightMarkerSuffixedBasenameMatches(basename) {
  if (typeof basename !== 'string') return false
  const m = PREFLIGHT_MARKER_BASENAME_RE.exec(basename)
  return !!(m && m[1])
}

// ---------------------------------------------------------------------------
// Checkpoint-hygiene F4 — per-session .last-user-prompt sidecar contract.
//
// Written by preflight-prompt-helper.sh (UserPromptSubmit) as
// `.last-user-prompt.<sid>.json`; consumed by preflight-gate.sh for true
// prompt binding (#238 PR1 FU-C2). Suffix-MANDATORY by construction — there
// was never a suffix-less legacy form, so the sweep matcher has no
// burn-in carve-out.
// ---------------------------------------------------------------------------

export const LAST_USER_PROMPT_BASENAME_TEMPLATE = '.last-user-prompt.{sid}.json'
export const LAST_USER_PROMPT_BASENAME_RE = /^\.last-user-prompt\.[A-Za-z0-9_-]{1,128}\.json$/

/**
 * Strict match for per-session last-user-prompt sidecar basenames. Accepts ONLY:
 *   .last-user-prompt.<sid>.json     (sid matches char-class + length)
 * Rejects:
 *   .last-user-prompt.json           (no sid)
 *   .last-user-prompt.<sid>          (missing .json)
 *   .last-user-prompt.a/b.json       (slash in sid)
 *   .last-user-prompt.<129-char>.json (oversize sid)
 *
 * @param {string} basename
 * @returns {boolean}
 */
export function lastUserPromptBasenameMatches(basename) {
  return typeof basename === 'string' && LAST_USER_PROMPT_BASENAME_RE.test(basename)
}

/**
 * Compose the per-session last-user-prompt basename for a given session id.
 * Caller MUST validateSessionId(sid) first; this helper does not re-validate.
 *
 * @param {string} sid — valid session-id
 * @returns {string} '.last-user-prompt.<sid>.json'
 */
export function lastUserPromptBasenameForSession(sid) {
  return LAST_USER_PROMPT_BASENAME_TEMPLATE.replace('{sid}', sid)
}

// ---------------------------------------------------------------------------
// Rank-2 (PR for checkpoint-quartet) — generic per-session marker contract.
//
// Third sibling of PLAN_MARKER_* (#268 / PR #271) and PREFLIGHT_MARKER_*
// (#279 / sibling PR). Codex DP-1 (plan v4): factor the namespaced-marker
// helpers instead of a fourth copy-paste of the per-marker block.
//
// Generic contract — given a `legacyBasename` (e.g. `.checkpoint-required`),
// the per-session form is `<legacyBasename>.<sid>` where sid matches the
// shared SUFFIX_CHARCLASS + SUFFIX_MAXLEN.
//
// PLAN_MARKER_* and PREFLIGHT_MARKER_* retained verbatim for back-compat
// with their existing callers and validator registry; new markers should
// use these generic helpers.
// ---------------------------------------------------------------------------

export const NAMESPACED_MARKER_SUFFIX_CHARCLASS = 'A-Za-z0-9_-'
export const NAMESPACED_MARKER_SUFFIX_MAXLEN = 128

/**
 * Strict match for namespaced marker basenames. Accepts ONLY:
 *   <legacyBasename>                                (legacy suffix-less)
 *   <legacyBasename>.<sid>                          (sid matches char-class + length)
 * Rejects:
 *   <legacyBasename>-extra                          (suffix without dot separator)
 *   <legacyBasename>.                               (empty suffix)
 *   <legacyBasename>./traversal                     (slash in suffix)
 *   <legacyBasename>..                              (dot in suffix)
 *   <legacyBasename>.<129-char>                     (oversize suffix)
 *
 * Mirrors the strict-match shape of planMarkerBasenameMatches() and
 * preflightMarkerBasenameMatches(); generalizes by accepting the legacy
 * basename as a parameter.
 *
 * @param {string} legacyBasename — the unsuffixed marker name (e.g. '.checkpoint-required')
 * @param {string} candidate — the basename to test
 * @returns {boolean}
 */
export function namespacedMarkerBasenameMatches(legacyBasename, candidate) {
  if (typeof candidate !== 'string' || typeof legacyBasename !== 'string') return false
  if (candidate === legacyBasename) return true
  const prefix = `${legacyBasename}.`
  if (!candidate.startsWith(prefix)) return false
  const suffix = candidate.slice(prefix.length)
  if (suffix.length === 0) return false
  if (suffix.length > NAMESPACED_MARKER_SUFFIX_MAXLEN) return false
  const re = new RegExp(`^[${NAMESPACED_MARKER_SUFFIX_CHARCLASS}]+$`)
  return re.test(suffix)
}

/**
 * Compose the per-session marker basename for a given legacy basename + sid.
 * Caller MUST validateSessionId(sid) first; this helper does not re-validate.
 *
 * @param {string} legacyBasename — the unsuffixed marker name
 * @param {string} sid — valid session-id
 * @returns {string} `<legacyBasename>.<sid>`
 */
export function namespacedMarkerBasenameForSession(legacyBasename, sid) {
  return `${legacyBasename}.${sid}`
}

/**
 * True if ANY namespaced marker for the given legacy basename exists at
 * either primary or legacy marker dir under <repoRoot>. Accepts both:
 *   <root>/<.checkpoints|.claude>/<legacyBasename>            (legacy literal)
 *   <root>/<.checkpoints|.claude>/<legacyBasename>.<sid>      (any sid)
 *
 * Mirrors anyPlanMarkerExists / any_preflight_marker_exists semantics for
 * an arbitrary legacy basename.
 *
 * @param {string} repoRoot
 * @param {string} legacyBasename
 * @returns {boolean}
 */
export function anyNamespacedMarkerExists(repoRoot, legacyBasename) {
  if (fs.existsSync(path.join(repoRoot, PRIMARY_MARKER_DIR, legacyBasename))) return true
  if (fs.existsSync(path.join(repoRoot, LEGACY_MARKER_DIR, legacyBasename))) return true
  const prefix = `${legacyBasename}.`
  for (const dir of [path.join(repoRoot, PRIMARY_MARKER_DIR), path.join(repoRoot, LEGACY_MARKER_DIR)]) {
    let entries
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      if (namespacedMarkerBasenameMatches(legacyBasename, name)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Rank-2 — checkpoint quartet constants.
//
// The 4 markers whose cross-session bleed motivated this PR. Per-session
// namespaced via the generic helpers above.
//
// Diagnosis episode: 20260523-080453-diagnosis-multi-session-checkpoint-marke-08ec
// Plan: scratch/rank2-checkpoint-quartet-plan-v4.md (codex R4 ACCEPT).
// ---------------------------------------------------------------------------

export const CHECKPOINT_QUARTET = Object.freeze([
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.pre-checkpoint-done',
  '.post-checkpoint-done',
])

// Strict regex spanning all 4 quartet members with optional .<sid> suffix.
// Used by the classifier + validator to match any quartet marker basename
// in a single test. Anchored; no traversal characters in the sid class.
export const CHECKPOINT_QUARTET_RE = /^\.(checkpoint-required|post-checkpoint-required|pre-checkpoint-done|post-checkpoint-done)(\.[A-Za-z0-9_-]{1,128})?$/

/**
 * True iff `basename` is one of the 4 quartet marker basenames in legacy
 * or per-session form.
 *
 * @param {string} basename
 * @returns {boolean}
 */
export function isCheckpointQuartetBasename(basename) {
  return typeof basename === 'string' && CHECKPOINT_QUARTET_RE.test(basename)
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
  { file: 'plugins/claude-code/hooks/lib/command-classifier.sh', line: 516, role: 'rm-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'plugins/claude-code/hooks/lib/command-classifier.sh', line: 640, role: 'redirect-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'plugins/claude-code/hooks/lib/command-classifier.sh', line: 685, role: 'tee-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'plugins/claude-code/hooks/lib/command-classifier.sh', line: 725, role: 'touch-target basename allowlist', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'plugins/claude-code/hooks/lib/command-classifier.sh', line: 1310, role: 'classify_path marker_write basename', kind: 'shell-case', semantic_role: 'read-any' },

  // E5b: classifier helper-invocation recognition (NEW in #268 fix commit 6).
  // F17+F18 reject leading POSIX-name env assignment before classifying as marker_write.
  { file: 'plugins/claude-code/hooks/lib/command-classifier.sh', line: 0, role: 'plan-marker.mjs helper invocation classification (F13+F17+F18)', kind: 'shell-case-helper-invocation-strict', semantic_role: 'read-own-session' },

  // E6-E9: checkpoint-gate.sh detector patterns/predicates (4 sites).
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 99, role: 'marker_basename_for_target exact-equality', kind: 'shell-equality', semantic_role: 'read-any' },
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 120, role: '_marker_basename_in_set closed set', kind: 'shell-case', semantic_role: 'read-any' },
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 196, role: '_command_has_relative_marker_path grep-E alternation', kind: 'grep-E-alternation', semantic_role: 'read-any' },
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 276, role: '_command_first_absolute_noncanonical_marker three-pass detector (token-equality + key=path walk + substring grep with relative-occurrence disambiguation; canonical short-circuit; path-with-spaces safe)', kind: 'shell-tokenizer-three-pass', semantic_role: 'read-any' },

  // E10: plan-gate.sh existence check + marker_write allowlist.
  { file: 'plugins/claude-code/hooks/plan-gate.sh', line: 57, role: 'PLAN_PENDING_W resolution + existence check + marker_write allowlist (session-aware after #268 fix)', kind: 'shell-equality', semantic_role: 'read-own-session' },

  // E11: scripts/em-recall.mjs TASK_SIGNAL_MARKERS array literal (consumer).
  { file: 'scripts/em-recall.mjs', line: 97, role: 'TASK_SIGNAL_MARKERS array literal (consumer)', kind: 'js-array', semantic_role: 'read-any' },

  // E12: scripts/em-audit-compliance.mjs compliance regex.
  { file: 'scripts/em-audit-compliance.mjs', line: 111, role: 'compliance audit regex (\\.plan-approval-pending\\b accepts both forms)', kind: 'js-regex', semantic_role: 'read-any' },

  // E13: NEW plan_marker_exists_for_session helper definition (checkpoint-gate.sh).
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 82, role: 'plan_marker_exists_for_session helper definition (NEW in #268 fix)', kind: 'shell-function', semantic_role: 'read-own-session' },

  // E14, E15, E17: cross-gate decision call-sites in checkpoint-gate.sh (3 sites).
  // Swap `marker_exists .plan-approval-pending` → `plan_marker_exists_for_session "$MY_SID"`.
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 376, role: 'cross-gate plan-pending check (Bash marker_write branch)', kind: 'shell-predicate-call', semantic_role: 'read-own-session' },
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 436, role: 'cross-gate plan-pending check (Write/Edit branch)', kind: 'shell-predicate-call', semantic_role: 'read-own-session' },
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 481, role: 'push-gate plan-pending cleanup guard', kind: 'shell-predicate-call', semantic_role: 'read-own-session' },

  // E16, E18: decoupled gate sites (DIFFERENT markers; validator asserts no coupling).
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 459, role: 'pre-checkpoint gate (.checkpoint-required — DIFFERENT marker)', kind: 'shell-decoupled', semantic_role: 'decoupled' },
  { file: 'plugins/claude-code/hooks/checkpoint-gate.sh', line: 497, role: 'pre→post arming gate (.checkpoint-required — DIFFERENT marker)', kind: 'shell-decoupled', semantic_role: 'decoupled' },

  // E19-E20: em-recall.mjs iteration consumers.
  { file: 'scripts/em-recall.mjs', line: 170, role: 'TASK_SIGNAL_MARKERS carve-out loop (glob-expands suffixed forms)', kind: 'js-array-iter', semantic_role: 'read-any' },
  { file: 'scripts/em-recall.mjs', line: 587, role: 'TASK_SIGNAL_MARKERS orphan-clear sweep (non-plan-marker class only; plan-marker handled by sibling unconditional sweep — post-2026-05-18 deadlock fix)', kind: 'js-array-iter', semantic_role: 'sweep-stale' },

  // E20b: NEW unconditional legacy-suffix-less plan-marker sweep above the
  // baseline guard. Suffixed forms `.plan-approval-pending.<sid>` are
  // intentionally NOT swept here (codex R2 P1: baseline-mtime sweep can
  // false-sweep live sessions on resume). Own-session cleanup remains the
  // exclusive responsibility of E21 (em-session-end-prompt.mjs).
  { file: 'scripts/em-recall.mjs', line: 587, role: 'unconditional .plan-approval-pending (suffix-less, legacy-only) sweep above baseline guard — post-2026-05-18 deadlock fix; suffixed forms NEVER swept here', kind: 'js-block', semantic_role: 'sweep-stale' },

  // E21: em-session-end-prompt.mjs own-session-only delete (F12 — codex r1 F1 fold).
  { file: 'scripts/em-session-end-prompt.mjs', line: 19, role: 'SessionEnd cleanup (own-session-only — F12)', kind: 'js-array-iter-own-session', semantic_role: 'remove-own-session' },

  // E22: command-classifier.sh push-cleanup loop (DECOUPLED — plan-pending not in CHECKPOINT_CLEANUP_MARKERS).
  { file: 'plugins/claude-code/hooks/lib/command-classifier.sh', line: 482, role: 'push-cleanup loop over CHECKPOINT_CLEANUP_MARKERS (REFERENCE — plan-pending intentionally excluded)', kind: 'shell-loop-decoupled', semantic_role: 'decoupled' },
]
