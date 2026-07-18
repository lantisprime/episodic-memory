/**
 * registered-stores.mjs — resolve every registered consumer project's episode
 * store from the consumer registry (~/.episodic-memory/installs.json), for the
 * --all-projects layer (em-stats / em-doctor / em-consolidate / em-promote).
 *
 * CAPABILITIES.md sanctions the scope: "A capability may operate over a single
 * store or across many registered stores (discovery via the consumer registry)".
 * The registry is a distribution-layer artifact read here read-only (P1: no new
 * data layer); this lib imports only core scripts/lib + node stdlib (P9).
 *
 * Identity rules (plan §8.1/§8.2, planner blockers B1/B4/B5):
 *   - data_dir is what the SUBSTRATE resolves for that project —
 *     resolveLocalDir(project_path) — never a naive join. A git-nested or
 *     linked-worktree project_path resolves to a DIFFERENT directory than
 *     <project_path>/.episodic-memory; spawned scripts (em-store,
 *     em-rebuild-index) operate on the resolved store, so consumers must too.
 *   - store identity is realpath(data_dir). label is DISPLAY ONLY.
 *   - store_matches_project gates WRITE consumers (fold, doctor --fix): true
 *     only when the resolution equals the plain join AND realpath(data_dir)
 *     stays under realpath(project_path) (a symlinked store escaping the
 *     project is a poisoned-registry shape, plan §7-C2).
 *
 * Degrade-not-throw: absent/malformed registry, vanished project paths, and
 * unresolvable dirs never throw — entries are dropped or flagged. Read
 * consumers may include store_matches_project:false entries (the resolved
 * store is still real); write consumers skip them with a report.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveLocalDir } from './local-dir.mjs'
import { readRegistry, registryPath } from './install-version.mjs'
import { resolveStoreIdentity } from './store-identity.mjs'

export const STORE_DIR_BASENAME = '.episodic-memory'
export const PROJECT_SCOPE_PREFIX = 'project:'

export function realpathSafe(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

// True when child (realpath'd) is strictly inside parent (realpath'd).
function containedIn(child, parent) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * @returns {Array<{project_path: string, data_dir: string, label: string,
 *   store_matches_project: boolean}>}
 */
export function resolveRegisteredStores({ globalDir } = {}) {
  return resolveRegisteredStoresWithStatus({ globalDir }).stores
}

/**
 * Same as resolveRegisteredStores but ALSO surfaces readRegistry's `rebuilt` flag
 * (RFC-011 R5b): archival consumers (em-prune --scope global, em-consolidate
 * --fold-superseded) MUST treat a `rebuilt: true` registry (installs.json
 * present-but-unparseable, silently degraded to an empty registry) as an ABORT
 * condition, not as an empty registry — global playbooks protection would be
 * unknowable. Non-archival consumers (em-stats/em-doctor/em-promote) keep using
 * resolveRegisteredStores and degrade to an empty list as before.
 *
 * @returns {{ stores: Array<{project_path, data_dir, label, store_matches_project}>,
 *   registryRebuilt: boolean, registryPath: string }}
 */
export function resolveRegisteredStoresWithStatus({ globalDir } = {}) {
  const gDir = globalDir || path.join(os.homedir(), STORE_DIR_BASENAME)
  const regPath = registryPath(gDir)
  const { entries, rebuilt } = readRegistry(regPath)
  const globalReal = realpathSafe(gDir)
  const seen = new Set()
  const out = []
  const sorted = [...entries].sort((a, b) => a.project_path.localeCompare(b.project_path))
  for (const e of sorted) {
    let projectReal
    try {
      if (!fs.existsSync(e.project_path)) continue
      projectReal = fs.realpathSync(e.project_path)
    } catch { continue }
    // The substrate's own resolution for this project (git-common-dir walk,
    // cwd fallback for non-git dirs) — what a spawned em-* script would use.
    let resolved
    try { resolved = resolveLocalDir(projectReal) } catch { resolved = path.join(projectReal, STORE_DIR_BASENAME) }
    const plainJoin = path.join(projectReal, STORE_DIR_BASENAME)
    const dataDirReal = realpathSafe(resolved)
    if (dataDirReal === globalReal) continue // never treat the global store as a project store
    if (seen.has(dataDirReal)) continue
    seen.add(dataDirReal)
    const storeMatches =
      path.resolve(resolved) === path.resolve(plainJoin) &&
      containedIn(dataDirReal, projectReal)
    // RFC-012 P2 REQ-6 (read side): surface the store's episode-carried identity
    // to --all-projects consumers. Degrade-not-throw: hard resolution errors
    // attach as store_identity_error; absent identity attaches nothing (mint is
    // lazy — registration mints, readers never do).
    const idn = fs.existsSync(resolved) ? resolveStoreIdentity(dataDirReal) : { error: 'no-identity' }
    out.push({
      project_path: projectReal,
      data_dir: fs.existsSync(resolved) ? dataDirReal : resolved,
      label: `${PROJECT_SCOPE_PREFIX}${path.basename(projectReal)}`,
      store_matches_project: storeMatches,
      ...(idn.error ? (idn.error !== 'no-identity' ? { store_identity_error: idn.error } : {}) : { store_id: idn.active_id, ...(idn.aliases.length ? { store_aliases: idn.aliases } : {}) }),
    })
  }
  return { stores: out, registryRebuilt: rebuilt, registryPath: regPath }
}
