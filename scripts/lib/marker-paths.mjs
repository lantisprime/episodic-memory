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
