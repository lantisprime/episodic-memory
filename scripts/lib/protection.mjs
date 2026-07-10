/**
 * protection.mjs — RFC-009 R6 archival-protection set.
 *
 * The single source of truth for "which episodes must NEVER be archived".
 * Extracted from em-prune.mjs so em-consolidate.mjs (--fold-superseded) applies
 * the IDENTICAL guarantee — a folded chain member that is evidence-linked, a
 * trigger-bearing lesson, a consolidates-member, a latest run record, or in the
 * chain-closure of any of those is protected exactly as prune protects it.
 *
 * Pure functions only (no argv, no top-level side effects) so both callers can
 * import without triggering each other's CLI execution.
 *
 * RFC-011 R5(b): the playbook-referenced class + the shared fail-closed resolver
 * (resolvePlaybookProtection) IMPORT parsePlaybooksConfig from em-trigger-index.mjs
 * — the S2 single source of truth for playbooks.json parsing (§12). The build
 * (R2) fails OPEN (skip+note); the retention consumers here fail CLOSED (abort
 * exit 1, archive nothing). em-trigger-index.mjs's CLI is main-module-guarded, so
 * importing it for the parser helper is side-effect-free (no CLI execution).
 */

import path from 'node:path'
import { parsePlaybooksConfig } from '../em-trigger-index.mjs'

// index.jsonl rows for one store, tagged with a store label. UNION both stores'
// output before computeProtectedIds: a global lesson's evidence can name a local
// violation, so protection is cross-store. Deliberately NO id-dedupe — a stale
// superseded copy in one store must not shadow an active referencer in the other.
export function loadProtectionRows(fs, path, dataDir, storeLabel) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  const out = []
  for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      e._store = storeLabel
      out.push(e)
    } catch {}
  }
  return out
}

export function stringItems(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
}

// RFC-009 R6 referencer validity: protection lapses when the referencing episode
// is superseded or expired. A row with NO status field is a valid referencer (the
// tolerated hand-written-writer class, #447); a malformed review_by never expires.
export function isValidReferencer(row, todayStr) {
  if (!row || row.status === 'superseded') return false
  const rb = row.review_by
  if (typeof rb === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rb) && rb < todayStr) return false
  return true
}

// RFC-011 R2.1 continuing-chain-precedence merge, mirroring S2's
// mergeIndexRowsForChain over the union rows (LOCAL is iterated first by callers:
// [...localRows, ...globalRows]). A row whose chain CONTINUES (carries
// `superseded_by`) outranks a stale terminal snapshot; when neither continues (or
// both), LOCAL wins (the RFC-009 merge convention). Returns Map<id,row> — ONE row
// per id so terminalOfChain can follow a single representative forward chain.
function mergeRowsByChainPrecedence(rows) {
  const byId = new Map()
  const consider = (row) => {
    if (!row || typeof row.id !== 'string') return
    const ex = byId.get(row.id)
    if (!ex) { byId.set(row.id, row); return }
    const exCont = !!ex.superseded_by
    const curCont = !!row.superseded_by
    if (curCont && !exCont) byId.set(row.id, row) // continuing outranks a stale terminal snapshot
    // else: existing (local-if-present, since the union iterates local first) wins ties
  }
  for (const r of rows) consider(r)
  return byId
}

// successorOf map (predecessor id -> successor id) from the merged rows'
// `supersedes` back-pointers — the inverted-edge source terminalOfChain consults
// when a row lacks an explicit `superseded_by` (the revision-chain shape).
function chainSuccessorMap(mergedById) {
  const successorOf = new Map()
  for (const row of mergedById.values()) {
    if (typeof row.supersedes === 'string' && row.supersedes) successorOf.set(row.supersedes, row.id)
  }
  return successorOf
}

// Follow the supersession chain FORWARD to the terminal (cycle-safe). Verbatim
// terminalOf semantics from em-trigger-index.mjs (R2.1): `superseded_by` first,
// then the inverted `supersedes` successor edge; stops when the next id is absent.
function terminalOfChain(id, byId, successorOf) {
  const seen = new Set()
  let cur = id
  while (!seen.has(cur)) {
    seen.add(cur)
    const row = byId.get(cur)
    const next = (row && typeof row.superseded_by === 'string' && row.superseded_by) || successorOf.get(cur)
    if (!next || !byId.has(next)) return byId.get(cur)
    cur = next
  }
  return byId.get(cur) // cycle: return where we stopped
}

/**
 * resolvePlaybookProtection — the RFC-011 R5(b) shared fail-closed resolver.
 * Parses the playbook preference configs scoped to which stores will be archived
 * and returns either an ABORT (caller exits 1, archives nothing, names the file)
 * or the resolved playbook episode ids to anchor in computeProtectedIds.
 *
 * SCOPE per R5(b) (the load-bearing bit — scoped blast radius):
 *   - LOCAL archival aborts ONLY on the LOCAL project's present-but-unparseable
 *     playbooks.json (a sibling project's corruption never blocks a local prune).
 *   - GLOBAL archival aborts on a DEGRADED registry (readRegistry rebuilt:true —
 *     installs.json present-but-unparseable) OR any registered project's
 *     present-but-unparseable playbooks.json (global protection is unknowable).
 *   - An ABSENT file is normal: no ids, no abort.
 *
 * The caller decides willArchiveLocal/willArchiveGlobal and reads the registry ONLY
 * when archiving globally (--scope local never consults the registry, so a
 * sibling's corrupt playbooks.json cannot abort an unrelated local prune).
 * parsePlaybooksConfig is the S2 single source of truth (§12); this resolver never
 * re-implements parsing.
 *
 * @returns {{ abort: ({reason: string, file: string}) | null, playbookIds: string[] }}
 */
export function resolvePlaybookProtection({ localStoreDir, willArchiveLocal = false, registryStores = [], registryRebuilt = false, registryPath = null }) {
  const playbookIds = []
  const localPb = parsePlaybooksConfig(localStoreDir)
  if (localPb.ok && localPb.config) {
    for (const e of localPb.config.playbooks) {
      if (typeof e.id === 'string') playbookIds.push(e.id)
    }
  }
  // LOCAL archival aborts ONLY on the LOCAL corrupt playbooks.json (scoped blast radius:
  // a sibling project's corruption never blocks a local prune). Absent = normal.
  if (willArchiveLocal && !localPb.ok) {
    return { abort: { reason: `local playbooks.json present but unparseable (${localPb.reason})`, file: path.join(localStoreDir, 'playbooks.json') }, playbookIds }
  }
  // GLOBAL archival aborts on a DEGRADED registry (installs.json rebuilt) — the
  // silent {entries: [], rebuilt: true} degradation archival consumers MUST surface
  // as the abort condition, not accept as an empty registry.
  if (registryRebuilt) {
    return { abort: { reason: 'global playbooks protection unknowable: registry degraded (installs.json present-but-unparseable, rebuilt from scratch)', file: registryPath || 'installs.json' }, playbookIds }
  }
  // GLOBAL archival aborts when ANY registered project's playbooks.json is
  // present-but-unparseable (global protection is then unknowable). Valid configs
  // contribute their ids; the cwd project's own config is parsed above and joins
  // the set regardless of registration (more protective, never less).
  for (const st of registryStores) {
    if (!st || typeof st.data_dir !== 'string') continue // malformed registry entry: skip (never fall back to re-parsing local)
    const dir = st.data_dir
    const pb = parsePlaybooksConfig(dir)
    if (pb.ok && pb.config) {
      for (const e of pb.config.playbooks) {
        if (typeof e.id === 'string') playbookIds.push(e.id)
      }
    } else if (!pb.ok) {
      return { abort: { reason: `global playbooks protection unknowable: registered project playbooks.json present but unparseable (${pb.reason})`, file: path.join(dir, 'playbooks.json') }, playbookIds }
    }
  }
  return { abort: null, playbookIds }
}

// RFC-009 R6 protection set. rows = UNION of both stores' index rows (deliberately
// NO id-dedupe). playbookIds = the playbook-referenced episode ids harvested by
// resolvePlaybookProtection (R5b). Returns Map<id, {reason, via}>; first-set reason
// wins in the order: pinned, evidence-linked-violation, trigger-bearing-lesson,
// consolidates-member, latest-run-record, playbook-referenced, chain-member.
export function computeProtectedIds(rows, todayStr, playbookIds = []) {
  const map = new Map()
  // via normalizes to null when the protecting referencer row has no string id
  // (the tolerated hand-written class) so the output contract field never vanishes.
  const set = (id, reason, via) => { if (typeof id === 'string' && !map.has(id)) map.set(id, { reason, via: typeof via === 'string' ? via : null }) }
  // class 0: pinned episodes protect themselves unconditionally (Recall v2).
  for (const r of rows) {
    if (r.pinned === true) set(r.id, 'pinned', typeof r.id === 'string' ? r.id : null)
  }
  const lessonRowsById = new Map()
  for (const r of rows) {
    if (r.category === 'lesson' && typeof r.id === 'string') {
      if (!lessonRowsById.has(r.id)) lessonRowsById.set(r.id, [])
      lessonRowsById.get(r.id).push(r)
    }
  }
  // class a, forward: valid lesson's evidence names violations
  for (const r of rows) {
    if (r.category !== 'lesson' || !isValidReferencer(r, todayStr)) continue
    for (const vid of stringItems(r.evidence)) set(vid, 'evidence-linked-violation', r.id)
  }
  // class a, back-link: violation.lessons names a valid lesson (in ANY store)
  for (const r of rows) {
    if (r.category !== 'violation' || typeof r.id !== 'string') continue
    for (const lid of stringItems(r.lessons)) {
      const cands = lessonRowsById.get(lid) || []
      if (cands.some(l => isValidReferencer(l, todayStr))) {
        set(r.id, 'evidence-linked-violation', lid)
        break
      }
    }
  }
  // class b: valid trigger-bearing lessons protect themselves
  for (const r of rows) {
    if (r.category !== 'lesson' || typeof r.id !== 'string') continue
    if (!isValidReferencer(r, todayStr)) continue
    if (stringItems(r.triggers).length > 0) set(r.id, 'trigger-bearing-lesson', r.id)
  }
  // class c: consolidates members of valid referencers (no id requirement on the
  // referencer — symmetric with class a; an idless valid row still protects)
  for (const r of rows) {
    if (!isValidReferencer(r, todayStr)) continue
    for (const mid of stringItems(r.consolidates)) set(mid, 'consolidates-member', r.id)
  }
  // class d: latest clerk run record per store. Canonical ids (YYYYMMDD-HHMMSS-…)
  // sort chronologically and are preferred; a hand-written non-canonical id must
  // not shadow the real latest (it competes only against other non-canonical ids).
  const latestByStore = new Map()
  const CANONICAL_ID = /^\d{8}-\d{6}-/
  for (const r of rows) {
    if (r.record_type !== 'clerk-run' || typeof r.id !== 'string') continue
    const canonical = CANONICAL_ID.test(r.id)
    const cur = latestByStore.get(r._store)
    if (!cur || (canonical === cur.canonical ? r.id > cur.id : canonical)) {
      latestByStore.set(r._store, { id: r.id, canonical })
    }
  }
  for (const v of latestByStore.values()) set(v.id, 'latest-run-record', v.id)
  // class e: RFC-011 R5(b) playbook-referenced. Each configured playbook id is
  // resolved to its terminal over the continuing-chain-precedence union (R2.1: a
  // stale superseded copy in one store must not shadow the live chain in the other
  // — the hazard loadProtectionRows above documents). The resolved terminal + the
  // configured id are BOTH anchored so the chain-closure BFS below extends
  // protection to every member including the terminal regardless of edge direction
  // (revision chains carry `supersedes` back-pointers; consolidated members carry
  // `superseded_by` and are also covered by class c). An UNRESOLVABLE id (not in
  // either store) anchors nothing — mirroring the build's R2.2 exclusion
  // (unresolvable is counted, never protected). `via` is the configured id (the
  // playbooks.json entry that named the chain).
  if (playbookIds && playbookIds.length) {
    const mergedById = mergeRowsByChainPrecedence(rows)
    const pbSucc = chainSuccessorMap(mergedById)
    for (const id of playbookIds) {
      if (typeof id !== 'string') continue
      const terminal = terminalOfChain(id, mergedById, pbSucc)
      if (terminal && typeof terminal.id === 'string') {
        set(terminal.id, 'playbook-referenced', id)
        if (terminal.id !== id) set(id, 'playbook-referenced', id)
      }
    }
  }
  // chain closure over class a/b/c/e anchors (NOT class d): every chain edge in BOTH
  // directions — backward (predecessors) AND forward (successors) — regardless of
  // which field carries it. A chain with only `superseded_by` forward edges
  // (em-consolidate --apply writes this shape on members; tolerated hand-written
  // rows; S2's build-side terminalOf resolves them) would otherwise leave members
  // BEHIND a forward-only anchor unreachable: an anchor at the terminal could not
  // walk back to its predecessors, and they would be ARCHIVED on disk (R5b / R2.1
  // fail-closed breach — build and retention would disagree). Three neighbor sources:
  //   - the row's OWN supersedes (backward back-pointer) + superseded_by (forward)
  //   - successorsOf: inverted supersedes (predecessor id -> successors that carry it)
  //   - predecessorsOf: inverted superseded_by (successor id -> predecessors). The
  //     load-bearing addition: lets a forward-only anchor reach members behind it.
  const rowsById = new Map()
  const successorsOf = new Map()   // predecessorId -> [successor ids] (via `supersedes` back-pointers)
  const predecessorsOf = new Map() // successorId   -> [predecessor ids] (via `superseded_by` forward edges)
  for (const r of rows) {
    if (typeof r.id !== 'string') continue
    if (!rowsById.has(r.id)) rowsById.set(r.id, [])
    rowsById.get(r.id).push(r)
    if (typeof r.supersedes === 'string') {
      if (!successorsOf.has(r.supersedes)) successorsOf.set(r.supersedes, [])
      successorsOf.get(r.supersedes).push(r.id)
    }
    if (typeof r.superseded_by === 'string') {
      if (!predecessorsOf.has(r.superseded_by)) predecessorsOf.set(r.superseded_by, [])
      predecessorsOf.get(r.superseded_by).push(r.id)
    }
  }
  const anchorOf = new Map()
  const queue = []
  for (const [id, v] of map.entries()) {
    if (v.reason === 'latest-run-record') continue
    anchorOf.set(id, id)
    queue.push(id)
  }
  const visited = new Set(queue)
  while (queue.length) {
    const id = queue.shift()
    const neighbors = []
    for (const r of rowsById.get(id) || []) {
      if (typeof r.supersedes === 'string') neighbors.push(r.supersedes)
      if (typeof r.superseded_by === 'string') neighbors.push(r.superseded_by)
    }
    for (const succ of successorsOf.get(id) || []) neighbors.push(succ)
    for (const pred of predecessorsOf.get(id) || []) neighbors.push(pred)
    for (const n of neighbors) {
      if (visited.has(n)) continue
      visited.add(n)
      anchorOf.set(n, anchorOf.get(id))
      set(n, 'chain-member', anchorOf.get(id))
      queue.push(n)
    }
  }
  return map
}
