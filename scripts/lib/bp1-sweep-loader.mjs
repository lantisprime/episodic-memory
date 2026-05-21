/**
 * bp1-sweep-loader.mjs — Shared on-disk loader for active-run codex_review
 * state, consumed by both the M0 fallback `bp1-deadline-sweep.mjs --once`
 * and the M2 scheduled-task subcommand `bp1-orchestrator sweep-naked-entries`.
 *
 * RFC-004 §556-577 + §1276-1310 (slice 2f).
 *
 * Source-of-truth path:
 *   <projectRoot>/.episodic-memory/bp1-runs/<run_id>/state.json
 *
 * Distinct from <projectRoot>/.episodic-memory/runs/_index.json — that index
 * carries run-LIFECYCLE state (active|classified|awaiting_approval|…), but
 * does NOT carry codex_review_entries. The entries live in the per-run
 * state.json files; M1's orchestrator runtime writes them when issuing /
 * tracking codex_review requests.
 *
 * Slice 2f decision: the loader walks bp1-runs/ directly (mirrors the M0
 * fallback) rather than filtering by _index.json active-state. Rationale:
 *   - bp1-runs/<run>/state.json is the authoritative codex_review_entries
 *     surface — _index.json does not mirror it (v2 schema fields list
 *     excludes codex_review_entries; see bp1-run-state.mjs:76-88).
 *   - Terminal runs leave their bp1-runs directory behind for replay; the
 *     entry-level supersession check (request_sent / response_received /
 *     cancelled) is what discriminates actionable from settled.
 *   - This matches the existing fallback's contract verbatim, so the
 *     refactor preserves behavior.
 *
 * Production reality (slice 2f): M3 hasn't shipped, so no entries exist
 * yet. The loader returns [] from a fresh repo. The test suite uses
 * fixture directories to assert behavior with realistic entries.
 *
 * Zero deps; Node stdlib only.
 */
'use strict'

import fs from 'node:fs'
import path from 'node:path'

/**
 * Load active runs from disk for sweep consumption.
 *
 * @param {object} args
 * @param {string} args.projectRoot — absolute, canonical project root
 * @returns {{
 *   activeRuns: Array<{ run_id: string, codex_review_entries: Array<object>, _corrupt?: string }>,
 *   loadIssue: null | { code: string, message: string }
 * }}
 *
 * Contract:
 *   - Missing runsDir → { activeRuns: [], loadIssue: null }  (clean fresh repo)
 *   - readdir failure (permissions etc.) → { activeRuns: [], loadIssue: {...} }
 *   - Per-run state.json parse failure → entry pushed with codex_review_entries: []
 *     and _corrupt: <err.message> (caller's scanForCandidates counts these as
 *     stale_or_corrupt; bare-catch P1 lesson — record, never silently swallow)
 *
 * Note: caller is responsible for any locking. The on-disk state.json files
 * live OUTSIDE the run-state lockdir (which guards _index.json only), so this
 * loader is lock-free; entry-level advisory locks are taken by the action
 * loop downstream.
 */
export function loadActiveRunsForSweep({ projectRoot } = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError(
      `loadActiveRunsForSweep: projectRoot must be an absolute string; got ${projectRoot}`)
  }
  const runsDir = path.join(projectRoot, '.episodic-memory', 'bp1-runs')
  return loadActiveRunsFromDir(runsDir)
}

/**
 * Lower-level variant that takes an explicit runsDir. Exported so that
 * `bp1-deadline-sweep.mjs` (which already resolves runsDir inline) can adopt
 * the shared loader without re-deriving the path.
 *
 * @param {string} runsDir — absolute path to the bp1-runs directory
 */
export function loadActiveRunsFromDir(runsDir) {
  if (typeof runsDir !== 'string' || !path.isAbsolute(runsDir)) {
    throw new TypeError(
      `loadActiveRunsFromDir: runsDir must be an absolute string; got ${runsDir}`)
  }
  if (!fs.existsSync(runsDir)) {
    return { activeRuns: [], loadIssue: null }
  }
  let entries
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
  } catch (e) {
    return {
      activeRuns: [],
      loadIssue: { code: 'runs_dir_read_failed', message: e.message },
    }
  }
  const activeRuns = []
  // Defense-in-depth: ent.name flows into path.join below. scanForCandidates
  // also shape-validates run_id before allowing candidacy, but a malformed
  // directory name shouldn't even reach the readFileSync. Slice 2f PR-tier
  // M1 (PR #322 review reply ...-e2c3).
  const ENT_NAME_RE = /^[A-Za-z0-9_-]+$/
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (!ENT_NAME_RE.test(ent.name)) continue
    const statePath = path.join(runsDir, ent.name, 'state.json')
    if (!fs.existsSync(statePath)) continue
    let state
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } catch (e) {
      activeRuns.push({
        run_id: ent.name,
        codex_review_entries: [],
        _corrupt: e.message,
      })
      continue
    }
    if (state && typeof state === 'object') {
      activeRuns.push({
        run_id: typeof state.run_id === 'string' ? state.run_id : ent.name,
        codex_review_entries: Array.isArray(state.codex_review_entries)
          ? state.codex_review_entries : [],
      })
    }
  }
  return { activeRuns, loadIssue: null }
}
