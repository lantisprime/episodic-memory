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
import { TAG_JACCARD_MIN, SUMMARY_JACCARD_MIN, HIGH_DF_MIN, CADENCE_K_SHARED, CADENCE_N_LESSONS, PROPOSED_ACTIONS } from './lib/activation-log.mjs'
import { loadMergedTriggerIndex } from './em-trigger-index.mjs'

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
const clerk = argv.includes('--clerk')
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
// Clerk report mode (--clerk, default). RFC-009 P4-S3, R9b, REQ-1..5/13/21/23.
// Pure-read: writes NOTHING to the store — byte-identical index.jsonl before/after.
// --break-report-write injects a stray appendFileSync inside the clerk branch
// (negative control for report::byteIdenticalStore; guarded so it ONLY fires
// with the flag).
// ---------------------------------------------------------------------------
// Module-level state for clerkSignals (must be declared before this block runs;
// TDZ on const/let below the if-block would otherwise break the loader path).
const _clerkTriggerPhrasesByEpisodeId = new Map()
let _clerkActiveRows = []
// Per-run memo for clerkHighDfTags: keyed on activeRows ref identity (stable
// within a run because _clerkActiveRows is assigned once). Declared at module
// scope so it's initialized BEFORE clerkSignals first runs (function decls are
// hoisted; const is not — keeping it here avoids TDZ).
const _highDfCache = new WeakMap()
// --break-highdf disables the high-df tag drop in clerkSignals (negative control
// for report::signalHighDfDrop; production runs never carry this flag).
const _BREAK_HIGHDF = process.argv.includes('--break-highdf')
if (clerk && !apply) {
  const _clerkBreakReportWrite = process.argv.includes('--break-report-write')
  const _clerkBreakDrain = process.argv.includes('--break-drain')
  const _clerkActiveRaw = loadIndex(DATA_DIR, scope).filter(r =>
    r.status !== 'superseded' &&
    typeof r.id === 'string' &&
    typeof r.summary === 'string' &&
    !EXCLUDED_CATEGORIES.has(canonicalCategory(r.category)) &&
    (includePinned || r.pinned !== true) &&
    (!categoryFilter || canonicalCategory(r.category) === canonicalCategory(categoryFilter)) &&
    (!projectFilter || r.project === projectFilter) &&
    !Array.isArray(r.consolidates)
  )
  _clerkActiveRows = _clerkActiveRaw

  // Load the R2 trigger index (merged across local+global) for shared-trigger detection.
  // FIX-1 (S3 review F2): bind `project` to path.dirname(LOCAL_DIR) so the
  // trigger-index build targets the SAME store loadIndex walks up to
  // (LOCAL_DIR = <repo-root>/.episodic-memory → path.dirname = repo-root).
  // The prior ternary (process.cwd()) created a PHANTOM .episodic-memory in
  // any subdir cwd, silently under-clustering. NOTE em-consolidate's own
  // --project flag is a NAME filter over row.project and is intentionally
  // NOT forwarded here; em-trigger-index's project arg is a PATH binding.
  let _clerkTriggerIndex = { entries: [] }
  try {
    _clerkTriggerIndex = loadMergedTriggerIndex({ project: LOCAL_DIR === DATA_DIR ? path.dirname(LOCAL_DIR) : undefined })
  } catch {}
  clerkRegisterTriggers(_clerkTriggerIndex)

  // REQ-23 cadence advisory inputs: phrase-sharing count + active-lesson count.
  const phraseSharingCount = (() => {
    const map = new Map()
    for (const e of (_clerkTriggerIndex.entries || [])) {
      if (!e || e.trigger_kind !== 'phrase' || typeof e.value !== 'string') continue
      map.set(e.value, (map.get(e.value) || 0) + 1)
    }
    let max = 0
    for (const n of map.values()) if (n > max) max = n
    return max
  })()
  const activeCount = _clerkActiveRaw.length

  // Group by (project, category) — identical to existing consolidation grouping.
  const _groups = new Map()
  for (const r of _clerkActiveRaw) {
    const key = `${r.project}\u0000${canonicalCategory(r.category)}`
    if (!_groups.has(key)) _groups.set(key, [])
    _groups.get(key).push(r)
  }

  // Union-find pair clustering over clerkSignals/clerkResolveAction.
  const _parent = new Map()
  const _find = (x) => { while (_parent.get(x) !== x) { _parent.set(x, _parent.get(_parent.get(x))); x = _parent.get(x) } return x }
  const _union = (a, b) => { const ra = _find(a), rb = _find(b); if (ra !== rb) _parent.set(ra, rb) }
  for (const r of _clerkActiveRaw) _parent.set(r.id, r.id)

  // Per-row supersession-adjacency (state D): an active that points at the SAME
  // root (r.supersedes) as another active in the group → mark both roots.
  const _supersessionRoots = new Map() // root -> [ids]
  for (const r of _clerkActiveRaw) {
    if (typeof r.supersedes === 'string' && r.supersedes) {
      if (!_supersessionRoots.has(r.supersedes)) _supersessionRoots.set(r.supersedes, [])
      _supersessionRoots.get(r.supersedes).push(r.id)
    }
  }
  const _supersessionAdjacent = new Set()
  for (const ids of _supersessionRoots.values()) {
    if (ids.length >= 2) for (const id of ids) _supersessionAdjacent.add(id)
  }

  // Pairwise signals → cluster when resolveAction returns merge or dedupe.
  for (const members of _groups.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j]
        const sig = clerkSignals(a, b)
        // EC5 — empty/whitespace summaries always keep-distinct (handled inside).
        // State D — supersession-adjacency → merge regardless of pair signal.
        let action
        if (_supersessionAdjacent.has(a.id) && _supersessionAdjacent.has(b.id) && a.supersedes === b.supersedes) {
          action = 'merge'
        } else {
          action = clerkResolveAction(sig)
        }
        if (action === 'merge' || action === 'dedupe') _union(a.id, b.id)
      }
    }
  }

  const _byRoot = new Map()
  for (const r of _clerkActiveRaw) {
    const root = _find(r.id)
    if (!_byRoot.has(root)) _byRoot.set(root, [])
    _byRoot.get(root).push(r)
  }
  const _clusters = [..._byRoot.entries()]
    .filter(([, members]) => members.length >= minCluster)
    .map(([, members]) => members.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id)))

  // Cluster envelope contract: members (id+summary), signals, proposed_action.
  // proposed_action for the WHOLE cluster = the most-actionable action seen
  // across its pairs (dedupe > merge > keep-distinct).
  const ACTION_RANK = { 'dedupe': 3, 'merge': 2, 'keep-distinct': 1 }
  const _clusterReports = _clusters.map((members) => {
    const ids = members.map(m => m.id)
    let bestAction = 'keep-distinct'
    let bestSig = null
    for (let i = 0; i < members.length && bestAction !== 'dedupe'; i++) {
      for (let j = i + 1; j < members.length && bestAction !== 'dedupe'; j++) {
        const a = members[i], b = members[j]
        const sig = clerkSignals(a, b)
        const action = (_supersessionAdjacent.has(a.id) && _supersessionAdjacent.has(b.id) && a.supersedes === b.supersedes)
          ? 'merge'
          : clerkResolveAction(sig)
        if (ACTION_RANK[action] > ACTION_RANK[bestAction]) { bestAction = action; bestSig = sig }
      }
    }
    // FIX-3 (S3 review F3): cap each cluster's members[] at CLUSTER_MEMBER_CAP
    // with a per-cluster members_truncated '+M more' sentinel, mirroring the
    // top-level clusters cap (REQ-5: every id list bounded).
    const CLUSTER_MEMBER_CAP = 500
    const memberObjs = members.map(m => ({ id: m.id, summary: m.summary }))
    const cluster = {
      members: memberObjs.slice(0, CLUSTER_MEMBER_CAP),
      signals: bestSig || { tag_jaccard: 0, summary_jaccard: 0, shared_triggers: [], dropped_high_df_tags: [], same_category: true },
      proposed_action: bestAction,
    }
    if (memberObjs.length > CLUSTER_MEMBER_CAP) {
      cluster.members_truncated = `+${memberObjs.length - CLUSTER_MEMBER_CAP} more`
    }
    return cluster
  })

  // Token-bounded envelope (REQ-5): never an unbounded id list. Cap at 500 ids.
  const CLERK_ID_CAP = 500
  let truncatedSentinel
  if (_clusterReports.length > CLERK_ID_CAP) {
    truncatedSentinel = `+${_clusterReports.length - CLERK_ID_CAP} more`
    _clusterReports.length = CLERK_ID_CAP
  }

  // REQ-23 cadence advisory (one-line string field; advisory ONLY, never a gate).
  let advisory
  if (phraseSharingCount >= CADENCE_K_SHARED) {
    advisory = `cadence: ${phraseSharingCount} trigger-index entries share a phrase (>= ${CADENCE_K_SHARED}); consider a clerk run`
  } else if (activeCount >= CADENCE_N_LESSONS) {
    advisory = `cadence: ${activeCount} active lessons (>= ${CADENCE_N_LESSONS}); consider a clerk run`
  }

  // Negative control: --break-report-write injects a stray write INSIDE the clerk
  // branch so report::byteIdenticalStore has teeth (red when the flag is set).
  if (_clerkBreakReportWrite) {
    try { fs.appendFileSync(path.join(DATA_DIR, 'index.jsonl'), '{"id":"__break-report-write-sentinel__"}\n') } catch {}
  }

  const _report = {
    status: 'ok',
    mode: 'clerk-report',
    clusters: _clusterReports,
    ...(truncatedSentinel ? { truncated: truncatedSentinel } : {}),
    ...(advisory ? { advisory } : {}),
  }

  // Drain-before-exit (#486, REQ-4): em-search.mjs:120 idiom.
  const _drain = () => new Promise(resolve => process.stdout.write(JSON.stringify(_report) + '\n', resolve))
  if (_clerkBreakDrain) {
    process.stdout.write(JSON.stringify(_report) + '\n')
    process.exit(0)
  }
  await _drain()
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

// ---------------------------------------------------------------------------
// Clerk lexical signals + action resolution (RFC-009 P4-S3, R9b, REQ-2/3/13/21)
// ---------------------------------------------------------------------------
// Module-level trigger-phrase index populated by the clerk-report loader: id ->
// Set<phrase> (the trigger VALUES whose R2 trigger-index entry points at the id).
// Pure lexical (no body/embedding); same-category + summary-tokens are case-folded,
// /[a-z0-9-]+/, length>2, no shingling, confirmatory only.
// (state holders declared above the clerk-report branch to avoid TDZ on hoisted refs)
function clerkRegisterTriggers(triggerIndex) {
  _clerkTriggerPhrasesByEpisodeId.clear()
  if (!triggerIndex || !Array.isArray(triggerIndex.entries)) return
  for (const e of triggerIndex.entries) {
    if (!e || typeof e.episode_id !== 'string') continue
    if (e.trigger_kind !== 'phrase' || typeof e.value !== 'string') continue
    if (!_clerkTriggerPhrasesByEpisodeId.has(e.episode_id)) _clerkTriggerPhrasesByEpisodeId.set(e.episode_id, new Set())
    _clerkTriggerPhrasesByEpisodeId.get(e.episode_id).add(e.value)
  }
}
function clerkTagsFor(row) {
  return Array.isArray(row && row.tags) ? row.tags.filter(t => typeof t === 'string') : []
}
// High-df drop: a tag whose document frequency across the ACTIVE lessons meets
// HIGH_DF_MIN(activeCount) is dropped from the tag-Jaccard comparison (T2).
// _BREAK_HIGHDF declared above the clerk-report branch to avoid TDZ.
function clerkHighDfTags(activeRows) {
  if (_BREAK_HIGHDF) return new Set()
  const rows = activeRows || []
  const cached = _highDfCache.get(rows)
  if (cached) return cached
  const df = new Map()
  for (const r of rows) for (const t of clerkTagsFor(r)) df.set(t, (df.get(t) || 0) + 1)
  const cutoff = HIGH_DF_MIN(rows.length)
  const high = new Set()
  for (const [tag, n] of df) if (n >= cutoff) high.add(tag)
  _highDfCache.set(rows, high)
  return high
}
function clerkTagJaccard(aTags, bTags, highDf) {
  // FIX-2 (S3 review F5): compute `dropped` BEFORE the both-empty-after-drop
  // early-return. The prior implementation discarded `dropped` on the empty
  // path — observed a CLUSTERED state-B pair reporting dropped_high_df_tags=[]
  // where REQ-2 requires ["common"].
  const dropped = [...new Set([...aTags, ...bTags].filter(t => highDf.has(t)))].sort()
  const a = new Set(aTags.filter(t => !highDf.has(t)))
  const b = new Set(bTags.filter(t => !highDf.has(t)))
  if (a.size === 0 && b.size === 0) return { j: 0, dropped }
  let inter = 0
  const small = a.size <= b.size ? a : b
  const large = small === a ? b : a
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return { j: union === 0 ? 0 : inter / union, dropped }
}
function clerkSummaryTokens(s) {
  if (typeof s !== 'string') return new Set()
  const out = new Set()
  const lc = s.toLowerCase()
  const re = /[a-z0-9-]+/g
  let m
  while ((m = re.exec(lc)) !== null) {
    if (m[0].length > 2) out.add(m[0])
  }
  return out
}
function clerkSummaryJaccard(aSummary, bSummary) {
  const a = clerkSummaryTokens(aSummary)
  const b = clerkSummaryTokens(bSummary)
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  const small = a.size <= b.size ? a : b
  const large = small === a ? b : a
  for (const t of small) if (large.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
function clerkSharedTriggers(idA, idB) {
  const a = _clerkTriggerPhrasesByEpisodeId.get(idA)
  const b = _clerkTriggerPhrasesByEpisodeId.get(idB)
  if (!a || !b) return []
  const out = []
  for (const t of a) if (b.has(t)) out.push(t)
  return out.sort()
}
// clerkSignals(a, b) — returns the LEXICAL signal object for a pair; caller
// adds the supersession-adjacency flag separately because it needs the broader
// cluster context. NO body/embedding similarity anywhere.
// FIX-2 (S3 review N2): the activeCount parameter was dead — clerkHighDfTags
// reads _clerkActiveRows.length directly. Removed; callers no longer pass it.
// FIX-2 (S3 review N1): compare RAW jaccard values against the thresholds in
// clerkResolveAction. Round to 3 decimals ONLY for the reported signal fields
// (display). Prior code rounded BEFORE comparison, fuzzing the 0.5/0.4 boundary.
function clerkSignals(a, b) {
  const highDf = clerkHighDfTags(_clerkActiveRows || [])
  const tagJ = clerkTagJaccard(clerkTagsFor(a), clerkTagsFor(b), highDf)
  const sumJ = clerkSummaryJaccard(a && a.summary, b && b.summary)
  const triggers = clerkSharedTriggers(a && a.id, b && b.id)
  const sameCategory = !!a && !!b && canonicalCategory(a.category) === canonicalCategory(b.category)
  return {
    tag_jaccard: Math.round(tagJ.j * 1000) / 1000,
    tag_jaccard_raw: tagJ.j,
    tag_jaccard_min: TAG_JACCARD_MIN,
    dropped_high_df_tags: tagJ.dropped,
    summary_jaccard: Math.round(sumJ * 1000) / 1000,
    summary_jaccard_raw: sumJ,
    summary_jaccard_min: SUMMARY_JACCARD_MIN,
    same_category: sameCategory,
    shared_triggers: triggers,
    summary_empty_or_whitespace: !(typeof (a && a.summary) === 'string' && a.summary.trim()) ||
                                !(typeof (b && b.summary) === 'string' && b.summary.trim()),
  }
}
// clerkResolveAction(signals) — §12 5-state table. EC5 empty/whitespace summaries
// always degrade to keep-distinct (empty compares equal to itself).
// FIX-2 (S3 review N1): compare RAW jaccard values via the *_raw fields, not
// the rounded display fields. Round only for reporting.
function clerkResolveAction(signals) {
  if (!signals || signals.summary_empty_or_whitespace) return 'keep-distinct'
  const tagJ = typeof signals.tag_jaccard_raw === 'number' ? signals.tag_jaccard_raw : signals.tag_jaccard
  const sumJ = typeof signals.summary_jaccard_raw === 'number' ? signals.summary_jaccard_raw : signals.summary_jaccard
  // E: high-df-only overlap → keep-distinct (dropped tags listed in signals)
  if (tagJ === 0 && signals.shared_triggers.length === 0 && signals.dropped_high_df_tags.length > 0) {
    return 'keep-distinct'
  }
  const tagStrong = tagJ >= TAG_JACCARD_MIN
  const sumStrong = sumJ >= SUMMARY_JACCARD_MIN
  const triggerShared = signals.shared_triggers.length > 0
  // A: near-identical — summary-J + tag-J + same category → dedupe
  // §12 state A: "summary-Jaccard ≥0.4 AND tag-Jaccard ≥0.5 AND same category"
  // (trigger-shared is NOT a state A precondition — it makes B fire earlier
  // via the shared-trigger leg below; state A is the lexical-near-identical case).
  if (tagStrong && sumStrong && signals.same_category) return 'dedupe'
  // B: related distinct — shared trigger or strong tag-J, summaries diverge
  if ((triggerShared || tagStrong) && sumJ < SUMMARY_JACCARD_MIN) return 'merge'
  // C: only confirmatory summary overlap, no trigger/tag corroboration
  if (sumStrong && !triggerShared && !tagStrong) return 'keep-distinct'
  // D caller-side flag (supersession-adjacent): handled in caller, NOT here.
  return 'keep-distinct'
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
