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
 */

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

// RFC-009 R6 protection set. rows = UNION of both stores' index rows (deliberately
// NO id-dedupe). Returns Map<id, {reason, via}>; first-set reason wins in the
// order: pinned, evidence-linked-violation, trigger-bearing-lesson,
// consolidates-member, latest-run-record, chain-member.
export function computeProtectedIds(rows, todayStr) {
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
  // chain closure over class a/b/c anchors (NOT class d): backward via each row's
  // `supersedes`, forward via INVERTED supersedes edges (superseded_by has no
  // substrate writer today) plus `superseded_by` strings when present. An archived
  // intermediate would silently break R2's chain-resolved band counting.
  const rowsById = new Map()
  const successorsOf = new Map() // supersededId -> [successor ids]
  for (const r of rows) {
    if (typeof r.id !== 'string') continue
    if (!rowsById.has(r.id)) rowsById.set(r.id, [])
    rowsById.get(r.id).push(r)
    if (typeof r.supersedes === 'string') {
      if (!successorsOf.has(r.supersedes)) successorsOf.set(r.supersedes, [])
      successorsOf.get(r.supersedes).push(r.id)
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
