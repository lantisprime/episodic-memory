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
 * Six markers in scope (5 task-signal + 1 baseline):
 *   .checkpoint-required          (activator, armed by em-recall.mjs)
 *   .post-checkpoint-required     (activator, armed by checkpoint-gate.sh)
 *   .plan-approval-pending        (Rule 8 plan-approval gate)
 *   .pre-checkpoint-done          (Rule 18 pre-impl checkpoint)
 *   .post-checkpoint-done         (Rule 18 post-impl checkpoint)
 *   .session-baseline             (stop-gate carve-out reference mtime)
 *
 * Codex round-2 ACCEPT (episode 20260509-044331-...-bc1c) per plan v3 §B.
 */

import fs from 'fs'
import path from 'path'

export const PRIMARY_MARKER_DIR = '.checkpoints'
export const LEGACY_MARKER_DIR = '.claude'
export const BASELINE_NAME = '.session-baseline'

// Task-signal markers (mirrors em-recall.mjs:97-101 + the two -done markers).
// Used by stop-gate carve-out, push cleanup, SessionStart orphan-clear.
export const TASK_SIGNAL_MARKERS = [
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.plan-approval-pending',
  '.pre-checkpoint-done',
  '.post-checkpoint-done'
]

// All migrated markers = task-signal + baseline.
export const ALL_MARKERS = [...TASK_SIGNAL_MARKERS, BASELINE_NAME]

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
