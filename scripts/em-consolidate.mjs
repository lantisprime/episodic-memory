#!/usr/bin/env node
/**
 * em-consolidate.mjs — fold clusters of near-duplicate episodes into digest
 * episodes (the semantic-consolidation capability promised by RFC-001).
 *
 * Usage:
 *   node em-consolidate.mjs [--scope local|global] [--min-sim <0..1>]
 *                           [--min-cluster <n>] [--category <cat>]
 *                           [--project <name>] [--include-pinned]
 *                           [--apply] [--confirm]
 *   node em-consolidate.mjs --fold-superseded [--min-chain <n>] [--dry-run]
 *                           [--scope local|global]
 *
 * Fold mode (--fold-superseded, S4): a long revision chain keeps every
 * superseded draft on disk forever (a single workplan chain measured ~145
 * episodes). For each LINEAR supersedes-chain with >= --min-chain members
 * (default 10), the non-terminal members' episode files are archived via the
 * SAME mechanism em-prune uses — file moved to archived/, index row moved to
 * archived-index.jsonl, tags.json cleaned — never deleted, so the move is
 * reversible by hand or restore tooling. The terminal episode is untouched.
 * Episode ids stay immutable and bodies are never edited: folding is an
 * archival MOVE only. Chain resolvability survives because the em-search
 * --history walk also reads archived-index.jsonl metadata. Pinned members
 * and members not marked superseded are kept (reported); forked/non-linear
 * chains are skipped whole. --dry-run lists exactly what a real run moves.
 *
 * Dry-run by DEFAULT: prints the clusters it would fold and writes nothing.
 * --apply performs the consolidation:
 *   - one digest episode per cluster, frontmatter `consolidates: [ids...]`,
 *     tags = union of member tags, pinned if any member was pinned, body =
 *     every member's summary + body (digests are the archive, not a teaser);
 *   - members are marked status: superseded + superseded_by: <digest-id> in
 *     BOTH the episode file and the index row, so they stop surfacing in
 *     search/recall while staying reachable via `em-search --history`
 *     (the walk follows consolidates edges) and protected references.
 *
 * Clustering: episodes group by (scope, project, canonical category); within
 * a group, pairs with token-set Jaccard similarity >= --min-sim (default
 * 0.35 — calibrated: genuine near-duplicates measure ~0.35-0.5 on body-only
 * tokens while unrelated episodes measure ~0.0) union-find into clusters of >= --min-cluster (default 2) members.
 * Tokens come from episodeTokens (summary + tags + body) — the same
 * vocabulary the token index and hash embeddings use.
 *
 * Deliberately conservative:
 *   - single-scope only (--scope local|global, default local): digests and
 *     members stay in one store; cross-scope folding would silently change
 *     an episode's sharing semantics — use em-move first if that's intended;
 *   - machine-consumed categories (violation, workplan, workflow.lifecycle)
 *     are never clustered;
 *   - pinned members are excluded unless --include-pinned (folding a pinned
 *     decision would stop it surfacing — the opposite of pinning);
 *   - >5 clusters per --apply requires --confirm.
 *
 * Outputs JSON: { status, dry_run?, clusters: [...], applied }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadIndex, loadTagsIndex, normalizeTags, episodeTokens, updateTokensIndex } from './lib/relevance.mjs'
import { loadCategories, canonicalCategory, machineConsumedCategories } from './lib/categories.mjs'
import { loadProtectionRows, computeProtectedIds, resolvePlaybookProtection } from './lib/protection.mjs'
import { resolveRegisteredStores, resolveRegisteredStoresWithStatus, realpathSafe } from './lib/registered-stores.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-consolidate.mjs', usage: 'node em-consolidate.mjs [--scope local|global] [--min-sim <0..1>] [--min-cluster <n>] [--category <cat>] [--project <name>] [--include-pinned] [--apply] [--confirm] — fold near-duplicate episodes into digest episodes (dry-run by default) | --fold-superseded [--min-chain <n>] [--dry-run] [--all-projects] — archive non-terminal members of long supersedes-chains (reversible; terminal untouched; history walk still resolves the chain). --all-projects (fold mode only, mutually exclusive with --scope) folds every consumer-registry store; a real multi-store run requires --confirm; per-store R6 protection unions cwd-local + global + all registered stores' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const scope = flag('--scope') || 'local'
const minSim = parseFloat(flag('--min-sim') || '0.35')
const minCluster = Math.max(2, parseInt(flag('--min-cluster') || '2', 10))
const categoryFilter = flag('--category')
const projectFilter = flag('--project')
const includePinned = argv.includes('--include-pinned')
const apply = argv.includes('--apply')
const confirm = argv.includes('--confirm')
const foldSuperseded = argv.includes('--fold-superseded')
const dryRun = argv.includes('--dry-run')
// Default chain length before folding kicks in. 10 keeps short, still-warm
// revision chains intact while catching the pathological ones (the live
// store's worst chain measured ~145 members).
const DEFAULT_MIN_CHAIN = 10
const minChain = parseInt(flag('--min-chain') || String(DEFAULT_MIN_CHAIN), 10)

const allProjects = argv.includes('--all-projects')
// --all-projects guards fail CLOSED before any other work: fold mode only,
// never combined with --scope (the registry, not the scope flag, names the
// stores), and a real multi-store run demands --confirm (checked in the fold
// block before the first archive move).
if (allProjects && !foldSuperseded) {
  console.log(JSON.stringify({ status: 'error', message: '--all-projects is valid only with --fold-superseded (cluster-mode digests never write into other projects\' stores; plan §5).' }))
  process.exit(2)
}
if (allProjects && argv.includes('--scope')) {
  console.log(JSON.stringify({ status: 'error', message: '--all-projects and --scope are mutually exclusive: the consumer registry names the stores.' }))
  process.exit(2)
}

if (scope !== 'local' && scope !== 'global') {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be local or global (single-scope by design; em-move first for cross-scope folding).` }))
  process.exit(2)
}
if (!(minSim > 0 && minSim <= 1)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --min-sim "${flag('--min-sim')}". Must be in (0, 1].` }))
  process.exit(2)
}

const DATA_DIR = scope === 'global' ? GLOBAL_DIR : LOCAL_DIR
const EPISODES_DIR = path.join(DATA_DIR, 'episodes')

// Machine-consumed categories never fold (strike counters, gates, queues own
// them). The set comes from categories.json's machine_consumed flags (REQ-3:
// no category-name literals in scripts). Consolidation WRITES (members flip
// to superseded), so an unloadable vocabulary fails CLOSED like em-store —
// degrading to "skip nothing" could fold violation evidence.
try {
  loadCategories()
} catch (e) {
  console.log(JSON.stringify({ status: 'error', message: e.message }))
  process.exit(1)
}
const EXCLUDED_CATEGORIES = machineConsumedCategories()

// ---------------------------------------------------------------------------
// Fold mode (--fold-superseded): archive non-terminal members of long linear
// supersedes-chains. Selection is computed ONCE and shared by --dry-run and
// the real run, so the dry-run list is exactly what a real run moves.
// ---------------------------------------------------------------------------
if (foldSuperseded) {
  if (!(Number.isInteger(minChain) && minChain >= 2)) {
    console.log(JSON.stringify({ status: 'error', message: `Invalid --min-chain "${flag('--min-chain')}". Must be an integer >= 2.` }))
    process.exit(2)
  }

  // Multi-store consent gate (plan REQ-6): a REAL --all-projects fold requires
  // --confirm, checked before ANY store is touched (fail closed).
  if (allProjects && !dryRun && !confirm) {
    console.log(JSON.stringify({ status: 'error', message: 'A real --all-projects fold archives across every registered store. Re-run with --confirm (or --dry-run to preview).' }))
    process.exit(2)
  }

  // Fold one store. Pure extraction of the single-store fold body — the
  // caller supplies the store dir, a display label, and the (possibly
  // cross-store) protected-id set; behavior for the single-store path is
  // unchanged.
  function foldStore(dataDir, loadLabel, protectedIds) {
    const episodesDir = path.join(dataDir, 'episodes')
    const rows = loadIndex(dataDir, loadLabel)
    const byId = new Map()
    for (const r of rows) {
      if (typeof r.id === 'string' && !byId.has(r.id)) byId.set(r.id, r)
    }

    // Supersession edges only (supersedes back-pointers + explicit
    // superseded_by) — consolidates edges belong to digest clusters, not
    // revision chains, and are deliberately not followed here.
    const successorsOf = new Map() // id -> Set<successor id>
    const predecessorsOf = new Map() // id -> Set<predecessor id>
    const addEdge = (from, to) => {
      if (!successorsOf.has(from)) successorsOf.set(from, new Set())
      successorsOf.get(from).add(to)
      if (!predecessorsOf.has(to)) predecessorsOf.set(to, new Set())
      predecessorsOf.get(to).add(from)
    }
    for (const r of byId.values()) {
      if (typeof r.supersedes === 'string' && byId.has(r.supersedes) && r.supersedes !== r.id) addEdge(r.supersedes, r.id)
      if (typeof r.superseded_by === 'string' && byId.has(r.superseded_by) && r.superseded_by !== r.id) addEdge(r.id, r.superseded_by)
    }

    // Connected components over the supersession edges (union-find).
    const parentUF = new Map()
    const findUF = (x) => {
      while (parentUF.get(x) !== x) { parentUF.set(x, parentUF.get(parentUF.get(x))); x = parentUF.get(x) }
      return x
    }
    const unionUF = (a, b) => { const ra = findUF(a), rb = findUF(b); if (ra !== rb) parentUF.set(ra, rb) }
    for (const id of byId.keys()) parentUF.set(id, id)
    for (const [from, succs] of successorsOf) for (const to of succs) unionUF(from, to)

    const components = new Map()
    for (const id of byId.keys()) {
      const root = findUF(id)
      if (!components.has(root)) components.set(root, [])
      components.get(root).push(id)
    }

    const chains = []
    const skipped = []
    for (const memberIds of components.values()) {
      if (memberIds.length < minChain) continue // chain shorter than N: untouched
      // Linearity: a fold-eligible chain is a simple path — every member has at
      // most one successor and one predecessor, and exactly one terminal (no
      // successor). Forks/merges (e.g. two revisions superseding the same
      // episode, or a consolidation cluster's shared superseded_by target) are
      // skipped whole: archiving any member of an ambiguous chain could hide
      // the branch the walk would have surfaced.
      const terminals = memberIds.filter(id => !(successorsOf.get(id)?.size))
      const nonLinear = memberIds.some(id => (successorsOf.get(id)?.size || 0) > 1 || (predecessorsOf.get(id)?.size || 0) > 1)
      if (terminals.length !== 1 || nonLinear) {
        skipped.push({ members: [...memberIds].sort(), reason: 'non-linear', terminals: terminals.sort() })
        continue
      }
      const terminal = terminals[0]
      const folded = []
      const kept = []
      for (const id of memberIds) {
        if (id === terminal) continue
        const r = byId.get(id)
        if (r.pinned === true) kept.push({ id, reason: 'pinned' })
        else if (r.status !== 'superseded') kept.push({ id, reason: 'not-superseded' })
        else if (protectedIds.has(id)) kept.push({ id, reason: `r6-protected:${protectedIds.get(id).reason}` })
        else folded.push(id)
      }
      folded.sort()
      kept.sort((a, b) => a.id.localeCompare(b.id))
      chains.push({ terminal, chain_length: memberIds.length, folded, kept })
    }
    chains.sort((a, b) => a.terminal.localeCompare(b.terminal))

    const allFoldIds = new Set(chains.flatMap(c => c.folded))

    if (!dryRun && allFoldIds.size > 0) {
      // SAME archive mechanism as em-prune.pruneDir: move the file to
      // archived/, drop the index row, clean tags.json, append the row to
      // archived-index.jsonl. Reversible (nothing is ever deleted); the
      // history walk keeps resolving the chain from archived metadata.
      const archivedDir = path.join(dataDir, 'archived')
      const indexFile = path.join(dataDir, 'index.jsonl')
      const archivedIndexFile = path.join(dataDir, 'archived-index.jsonl')
      fs.mkdirSync(archivedDir, { recursive: true })

      for (const id of allFoldIds) {
        try {
          fs.renameSync(path.join(episodesDir, `${id}.md`), path.join(archivedDir, `${id}.md`))
        } catch {}
      }

      // index.jsonl: keep only non-folded rows (atomic rewrite); folded rows
      // move to archived-index.jsonl with reader-internal fields stripped.
      const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      const keptLines = []
      const archivedLines = []
      for (const line of lines) {
        let entry = null
        try { entry = JSON.parse(line) } catch {}
        if (entry && allFoldIds.has(entry.id)) archivedLines.push(JSON.stringify(entry))
        else keptLines.push(line)
      }
      const tmpIndex = indexFile + '.tmp'
      fs.writeFileSync(tmpIndex, keptLines.join('\n') + (keptLines.length ? '\n' : ''), 'utf8')
      fs.renameSync(tmpIndex, indexFile)

      const tagsFile = path.join(dataDir, 'tags.json')
      // Null-proto map (#469/#470): a tag literally named "constructor"/"__proto__"
      // must not resolve to an inherited Object.prototype member. loadTagsIndex
      // is the sanctioned reader; raw JSON.parse reintroduces the collision.
      const tagsIndex = loadTagsIndex(dataDir) || Object.create(null)
      for (const tag of Object.keys(tagsIndex)) {
        if (!Array.isArray(tagsIndex[tag])) continue
        tagsIndex[tag] = tagsIndex[tag].filter(id => !allFoldIds.has(id))
        if (tagsIndex[tag].length === 0) delete tagsIndex[tag]
      }
      const tagsTmp = tagsFile + '.tmp'
      fs.writeFileSync(tagsTmp, JSON.stringify(tagsIndex, null, 2), 'utf8')
      fs.renameSync(tagsTmp, tagsFile)

      const existingArchived = fs.existsSync(archivedIndexFile) ? fs.readFileSync(archivedIndexFile, 'utf8') : ''
      const archivedTmp = archivedIndexFile + '.tmp'
      fs.writeFileSync(archivedTmp, existingArchived + archivedLines.join('\n') + '\n', 'utf8')
      fs.renameSync(archivedTmp, archivedIndexFile)
    }

    return { chains, skipped, folded_total: allFoldIds.size }
  }

  const today = new Date().toISOString().slice(0, 10)

  if (allProjects) {
    // Registry-driven fold. Protection rows are loaded ONCE as the UNION of
    // cwd-local + global + every registered store (planner B3: a referencer
    // in a THIRD store validly protects a member folded elsewhere), with
    // storeLabel = realpath(data_dir) — the display label must never feed the
    // class-d latestByStore bucket key (planner B4: basename collisions merge
    // buckets and silently unprotect one store's latest run record).
    const reg = resolveRegisteredStoresWithStatus()
    const registered = reg.stores
    const protectionDirs = new Map() // realpath -> dir
    for (const d of [LOCAL_DIR, GLOBAL_DIR, ...registered.map(s => s.data_dir)]) {
      const key = realpathSafe(d)
      if (!protectionDirs.has(key)) protectionDirs.set(key, d)
    }
    const protectionRows = []
    for (const [key, d] of protectionDirs) {
      protectionRows.push(...loadProtectionRows(fs, path, d, key))
    }
    // RFC-011 R5(b): --fold-superseded binds to the SAME protection + abort
    // semantics as em-prune. --all-projects archives across the registry, so the
    // GLOBAL abort applies: a DEGRADED registry (installs.json rebuilt) OR any
    // registered project's corrupt playbooks.json aborts exit 1 and folds NOTHING,
    // naming the offending file (retention fails closed; advisory surfaces fail open).
    const { abort: pbAbort, playbookIds } = resolvePlaybookProtection({
      localStoreDir: LOCAL_DIR,
      willArchiveLocal: false, // the registry (not a separate cwd-local fold) names the stores
      registryStores: registered,
      registryRebuilt: reg.registryRebuilt,
      registryPath: reg.registryPath,
    })
    if (pbAbort) {
      console.log(JSON.stringify({ status: 'error', message: `em-consolidate: aborting archival — ${pbAbort.reason} (${pbAbort.file})` }))
      process.exit(1)
    }
    const protectedIds = computeProtectedIds(protectionRows, today, playbookIds)

    const stores = []
    let foldedTotal = 0
    for (const st of registered) {
      if (!st.store_matches_project) {
        stores.push({ project_path: st.project_path, data_dir: st.data_dir, label: st.label, skipped_store: 'non-root-store' })
        continue
      }
      if (!fs.existsSync(path.join(st.data_dir, 'index.jsonl'))) {
        stores.push({ project_path: st.project_path, data_dir: st.data_dir, label: st.label, skipped_store: 'no-index' })
        continue
      }
      const res = foldStore(st.data_dir, st.label, protectedIds)
      foldedTotal += res.folded_total
      stores.push({ project_path: st.project_path, data_dir: st.data_dir, label: st.label, ...res })
    }

    console.log(JSON.stringify({
      status: 'ok',
      mode: 'fold-superseded',
      all_projects: true,
      dry_run: dryRun,
      min_chain: minChain,
      stores,
      folded_total: foldedTotal,
      ...(dryRun && foldedTotal ? { hint: 'Re-run without --dry-run (plus --confirm) to archive.' } : {}),
    }))
    process.exit(0)
  }

  // Single-store fold (unchanged behavior). RFC-009 R6 archival protection —
  // the SAME set em-prune honors, so a folded chain member that is
  // evidence-linked, a trigger-bearing lesson, a consolidates-member, a latest
  // run record, or in the chain-closure of any of those is NEVER archived by
  // fold. The protection scan is cross-store (a global lesson's evidence can
  // name a local violation), so it reads BOTH stores' index rows regardless of
  // the fold's own scope.
  // RFC-011 R5(b): binds to the identical SCOPED fail-closed abort as em-prune —
  // --scope local aborts only on the LOCAL corrupt playbooks.json; --scope global
  // aborts on a degraded registry OR any registered project's corrupt playbooks.json.
  const willArchiveLocalCS = scope === 'local'
  const willArchiveGlobalCS = scope === 'global'
  let csRegistryStores = [], csRegistryRebuilt = false, csRegistryPath = null
  if (willArchiveGlobalCS) {
    const reg = resolveRegisteredStoresWithStatus()
    csRegistryStores = reg.stores
    csRegistryRebuilt = reg.registryRebuilt
    csRegistryPath = reg.registryPath
  }
  const { abort: pbAbort, playbookIds } = resolvePlaybookProtection({
    localStoreDir: LOCAL_DIR,
    willArchiveLocal: willArchiveLocalCS,
    registryStores: csRegistryStores,
    registryRebuilt: csRegistryRebuilt,
    registryPath: csRegistryPath,
  })
  if (pbAbort) {
    console.log(JSON.stringify({ status: 'error', message: `em-consolidate: aborting archival — ${pbAbort.reason} (${pbAbort.file})` }))
    process.exit(1)
  }
  const protectionRows = [
    ...loadProtectionRows(fs, path, LOCAL_DIR, 'local'),
    ...loadProtectionRows(fs, path, GLOBAL_DIR, 'global')
  ]
  const protectedIds = computeProtectedIds(protectionRows, today, playbookIds)
  const res = foldStore(DATA_DIR, scope, protectedIds)

  console.log(JSON.stringify({
    status: 'ok',
    mode: 'fold-superseded',
    dry_run: dryRun,
    scope,
    min_chain: minChain,
    chains: res.chains,
    ...(res.skipped.length ? { skipped: res.skipped } : {}),
    folded_total: res.folded_total,
    ...(dryRun && res.folded_total ? { hint: 'Re-run without --dry-run to archive.' } : {}),
  }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Load candidates
// ---------------------------------------------------------------------------
const rows = loadIndex(DATA_DIR, scope).filter(r =>
  r.status !== 'superseded' &&
  typeof r.id === 'string' &&
  typeof r.summary === 'string' &&
  !EXCLUDED_CATEGORIES.has(canonicalCategory(r.category)) &&
  (includePinned || r.pinned !== true) &&
  (!categoryFilter || canonicalCategory(r.category) === canonicalCategory(categoryFilter)) &&
  (!projectFilter || r.project === projectFilter) &&
  // never re-fold digests: an episode that already consolidates others is a
  // digest; folding digests into digests compounds bodies unboundedly
  !Array.isArray(r.consolidates)
)

function readEpisode(id) {
  try { return fs.readFileSync(path.join(EPISODES_DIR, `${id}.md`), 'utf8') } catch { return null }
}

function bodyOf(content) {
  const parts = content.split('---')
  return parts.length >= 3 ? parts.slice(2).join('---').trim() : content.trim()
}

// Token sets per candidate: summary + tags + BODY ONLY. The frontmatter is
// deliberately excluded — same-day episodes share id/date/time/project/
// category/status tokens, which inflates Jaccard between unrelated episodes
// with short bodies (observed: a postgres episode clustering with storage
// lessons purely via shared frontmatter). Episodes whose file is missing are
// skipped, not fatal.
const tokenSets = new Map()
const contents = new Map()
for (const r of rows) {
  const content = readEpisode(r.id)
  if (content === null) continue
  contents.set(r.id, content)
  tokenSets.set(r.id, episodeTokens({ summary: r.summary, tags: r.tags, body: bodyOf(content) }))
}

function jaccard(a, b) {
  let inter = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const tok of small) if (large.has(tok)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// ---------------------------------------------------------------------------
// Cluster: union-find within (project, category) groups
// ---------------------------------------------------------------------------
const parent = new Map()
const find = (x) => {
  while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) }
  return x
}
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }

const groups = new Map()
for (const r of rows) {
  if (!tokenSets.has(r.id)) continue
  parent.set(r.id, r.id)
  const key = `${r.project}\u0000${canonicalCategory(r.category)}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}

const pairSims = new Map() // "idA idB" -> sim, for reporting
for (const members of groups.values()) {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const sim = jaccard(tokenSets.get(members[i].id), tokenSets.get(members[j].id))
      if (sim >= minSim) {
        union(members[i].id, members[j].id)
        pairSims.set(`${members[i].id} ${members[j].id}`, sim)
      }
    }
  }
}

const byRoot = new Map()
for (const r of rows) {
  if (!tokenSets.has(r.id)) continue
  const root = find(r.id)
  if (!byRoot.has(root)) byRoot.set(root, [])
  byRoot.get(root).push(r)
}

const clusters = [...byRoot.values()]
  .filter(members => members.length >= minCluster)
  // oldest first inside a cluster — the digest reads chronologically
  .map(members => members.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id)))

// ---------------------------------------------------------------------------
// Report / apply
// ---------------------------------------------------------------------------
function clusterReport(members) {
  const ids = members.map(m => m.id)
  let simSum = 0, simN = 0
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const s = pairSims.get(`${ids[i]} ${ids[j]}`) ?? pairSims.get(`${ids[j]} ${ids[i]}`)
      if (s !== undefined) { simSum += s; simN++ }
    }
  }
  return {
    scope,
    project: members[0].project,
    category: canonicalCategory(members[0].category),
    members: members.map(m => ({ id: m.id, summary: m.summary })),
    linked_pair_similarity_avg: simN ? Math.round((simSum / simN) * 1000) / 1000 : null,
  }
}

const report = clusters.map(clusterReport)

if (!apply) {
  console.log(JSON.stringify({ status: 'ok', dry_run: true, clusters: report, applied: 0, hint: clusters.length ? 'Re-run with --apply to consolidate.' : undefined }))
  process.exit(0)
}
if (clusters.length > 5 && !confirm) {
  console.log(JSON.stringify({ status: 'error', message: `${clusters.length} clusters would be folded (> 5). Re-run with --confirm (or narrow with --category/--project/--min-sim).` }))
  process.exit(2)
}

function nowParts() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return {
    dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeStr: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    idStamp: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

function updateInverted(fileName, id, keys, pretty) {
  if (keys.length === 0) return
  const p = path.join(DATA_DIR, fileName)
  let idx = {}
  try { idx = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
  for (const key of keys) {
    if (!idx[key]) idx[key] = []
    if (!idx[key].includes(id)) idx[key].push(id)
  }
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(idx, ...(pretty ? [null, 2] : [])), 'utf8')
  fs.renameSync(tmp, p)
}

const applied = []
for (let c = 0; c < clusters.length; c++) {
  const members = clusters[c]
  const memberIds = members.map(m => m.id)
  const category = canonicalCategory(members[0].category)
  const project = members[0].project
  const tags = normalizeTags(members.flatMap(m => Array.isArray(m.tags) ? m.tags : []))
  const pinned = members.some(m => m.pinned === true)
  const summary = `Consolidated: ${members[members.length - 1].summary} (+${members.length - 1} related)`

  const { dateStr, timeStr, idStamp } = nowParts()
  const digestId = `${idStamp}-${slugify(summary)}-${crypto.randomBytes(2).toString('hex')}`

  const bodySections = members.map(m =>
    `## ${m.summary}\n\n(id: \`${m.id}\`, ${m.date})\n\n${bodyOf(contents.get(m.id))}`
  )
  const digestBody = [
    `Digest of ${members.length} related episodes (em-consolidate, ${dateStr}).`,
    '',
    ...bodySections,
  ].join('\n\n')

  const fmLines = [
    '---',
    `id: ${digestId}`,
    `date: ${dateStr}`,
    `time: "${timeStr}"`,
    `project: ${project}`,
    `category: ${category}`,
    'status: active',
    `consolidates: [${memberIds.join(', ')}]`,
    `tags: [${tags.join(', ')}]`,
    `summary: ${summary}`,
    ...(pinned ? ['pinned: true'] : []),
    '---',
  ]
  const digestContent = `${fmLines.join('\n')}\n\n# ${summary}\n\n${digestBody}\n`

  // 1. digest file + index row + inverted indexes
  fs.mkdirSync(EPISODES_DIR, { recursive: true })
  fs.writeFileSync(path.join(EPISODES_DIR, `${digestId}.md`), digestContent, 'utf8')
  const digestRow = {
    id: digestId, date: dateStr, time: timeStr, project, category,
    status: 'active', supersedes: null, consolidates: memberIds,
    tags, summary,
    ...(pinned ? { pinned: true } : {}),
  }
  fs.appendFileSync(path.join(DATA_DIR, 'index.jsonl'), JSON.stringify(digestRow) + '\n', 'utf8')
  updateInverted('tags.json', digestId, tags, true)
  updateInverted('category-index.json', digestId, [category], true)
  updateTokensIndex(DATA_DIR, digestId, episodeTokens({ summary, tags, body: digestContent }))

  // 2. members: status superseded + superseded_by in file and index row
  for (const m of members) {
    const content = contents.get(m.id)
    let updated = content.replace(/^status: active$/m, `status: superseded\nsuperseded_by: ${digestId}`)
    if (updated === content) updated = content.replace(/^---\n/, `---\nsuperseded_by: ${digestId}\n`)
    const tmp = path.join(EPISODES_DIR, `${m.id}.md.tmp`)
    fs.writeFileSync(tmp, updated, 'utf8')
    fs.renameSync(tmp, path.join(EPISODES_DIR, `${m.id}.md`))
  }
  const idsSet = new Set(memberIds)
  const indexFile = path.join(DATA_DIR, 'index.jsonl')
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
  const rewritten = lines.map(line => {
    try {
      const entry = JSON.parse(line)
      if (idsSet.has(entry.id)) {
        entry.status = 'superseded'
        entry.superseded_by = digestId
      }
      return JSON.stringify(entry)
    } catch { return line }
  })
  const tmp = indexFile + '.tmp'
  fs.writeFileSync(tmp, rewritten.join('\n') + '\n', 'utf8')
  fs.renameSync(tmp, indexFile)

  applied.push({ ...report[c], digest_id: digestId, digest_summary: summary })
}

console.log(JSON.stringify({ status: 'ok', clusters: applied, applied: applied.length }))
