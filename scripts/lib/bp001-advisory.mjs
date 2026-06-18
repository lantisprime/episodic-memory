/**
 * bp001-advisory.mjs — bp-001 SessionStart advisory predicate + computation.
 *
 * RFC-008 P3d (F7, R1): extracted from em-recall.mjs so the memory substrate
 * carries ZERO enforcement awareness. The advisory is computed by the
 * enforcement layer (enforce-contract.mjs --session-start) which imports this
 * lib; em-recall no longer knows bp-001 exists.
 *
 * The advisory is purely a stderr SIGNAL surfaced as SessionStart
 * additionalContext (planning-passive redesign 2026-05-25): a recent bp-001
 * violation NO LONGER arms the pre-checkpoint gate at session start — the
 * pre-checkpoint requirement is lazily armed by checkpoint-gate.sh at the first
 * repo-source write (the implementation boundary). This module only decides
 * whether to emit the advisory; it writes nothing and blocks nothing.
 *
 * R1 note: this lib loading episodes via the index is the enforcement layer
 * CONSUMING the substrate — the same sanctioned direction as enforce-contract
 * appending an F3 alert through em-store. It does not re-pollute the substrate
 * (R1/F38 constrains em-store/em-recall/em-search, not the enforcement layer).
 */

import fs from 'fs'
import path from 'node:path'
import os from 'node:os'
import { resolveLocalDir } from './local-dir.mjs'

export const BP1_ADVISORY_MESSAGE =
  '__BP1_ADVISORY__ A recent bp-001-implementation-workflow violation exists in this project. ' +
  'The pre-implementation checkpoint is NOT armed during planning — it is required only when you ' +
  'first edit repo source. Advisory only; not blocking.'

// ---------------------------------------------------------------------------
// Phase 3b activation predicate (moved VERBATIM from em-recall.mjs:405-423).
// Returns true iff there exists at least one active (non-superseded) episode
// within the 30-day cutoff that is a bp-001-implementation-workflow violation
// for `currentProject`. Pure function — testable in isolation.
// ---------------------------------------------------------------------------
export function shouldArmBp001Checkpoint(activeEntries, now, currentProject) {
  // Fail-closed: without a resolved project name we cannot scope the match.
  // The 30-day window arming engine bleeds across projects without this guard.
  if (!currentProject) return false
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const tag = 'violated:bp-001-implementation-workflow'
  return activeEntries.some(e =>
    e &&
    e.status !== 'superseded' &&
    e.category === 'violation' &&
    e.project === currentProject &&
    Array.isArray(e.tags) &&
    e.tags.includes(tag) &&
    typeof e.date === 'string' &&
    e.date >= cutoffStr
  )
}

// ---------------------------------------------------------------------------
// Minimal active-entry load: local + global index.jsonl, dedupe by id (local
// priority), drop superseded. A trimmed copy of the recall loader — the
// advisory only needs {id, status, category, project, tags, date}, so this does
// NOT carry the _source/_dataDir enrichment or the access-tracking write-back.
// ---------------------------------------------------------------------------
function loadActiveEntries() {
  const dirs = [resolveLocalDir(), path.join(os.homedir(), '.episodic-memory')]
  const all = []
  for (const dir of dirs) {
    const indexFile = path.join(dir, 'index.jsonl')
    let raw
    try { raw = fs.readFileSync(indexFile, 'utf8') } catch { continue }
    for (const line of raw.trim().split('\n')) {
      if (!line) continue
      try { all.push(JSON.parse(line)) } catch {}
    }
  }
  const seen = new Set()
  const deduped = []
  for (const e of all) {
    if (!e || seen.has(e.id)) continue
    seen.add(e.id)
    deduped.push(e)
  }
  return deduped.filter(e => e.status !== 'superseded')
}

// ---------------------------------------------------------------------------
// Arming-project resolution (the ignoreOverride:true + fast:true subset moved
// from em-recall.mjs:441-462). Binds to the repo authority root, NOT cwd and
// NOT any --project override (the advisory has no --project surface). fast: no
// `git remote` subprocess — violations record package.json `name` (em-store
// convention), so basename is the faithful fallback.
// ---------------------------------------------------------------------------
function resolveArmingProject(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    if (pkg.name && pkg.name.trim()) return pkg.name.trim()
  } catch {}
  return path.basename(projectRoot)
}

// ---------------------------------------------------------------------------
// computeBp001Advisory — the high-level call enforce-contract --session-start
// uses. Returns the advisory message string if a recent bp-001 violation exists
// for this project, else null. Best-effort: any failure returns null (never
// throws, never blocks).
// ---------------------------------------------------------------------------
export function computeBp001Advisory(projectRoot, now = new Date()) {
  try {
    const activeEntries = loadActiveEntries()
    const project = resolveArmingProject(projectRoot)
    if (shouldArmBp001Checkpoint(activeEntries, now, project)) {
      return BP1_ADVISORY_MESSAGE
    }
  } catch {}
  return null
}
