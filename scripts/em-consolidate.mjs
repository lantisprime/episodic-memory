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
import { fileURLToPath } from 'node:url'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { loadIndex, loadTagsIndex, normalizeTags, episodeTokens, updateTokensIndex, tokenizeQuery } from './lib/relevance.mjs'
import { loadCategories, canonicalCategory, machineConsumedCategories, validateCategory } from './lib/categories.mjs'
import { loadProtectionRows, computeProtectedIds, resolvePlaybookProtection } from './lib/protection.mjs'
import { resolveRegisteredStores, resolveRegisteredStoresWithStatus, realpathSafe } from './lib/registered-stores.mjs'
import { TAG_JACCARD_MIN, SUMMARY_JACCARD_MIN, HIGH_DF_MIN, CADENCE_K_SHARED, CADENCE_N_LESSONS, PROPOSED_ACTIONS, RUN_RECORD_CATEGORY, RUN_RECORD_TYPE, CLERK_CUTOVER_MARKER, ATTRIBUTION_WINDOW_MS, ACTIVATION_LOG_NAME, ACTIVATION_LOG_MAX_BYTES, LOG_FORMAT_VERSION, computeCadence } from './lib/activation-log.mjs'
import { illegalValueChar, illegalScalarChar, serializeInlineArray, ACTIVATION_ARRAY_FIELDS } from './lib/activation.mjs'
import { acquire, release } from './lib/lock.mjs'
import { loadMergedTriggerIndex } from './em-trigger-index.mjs'
import { spawnSync } from 'node:child_process'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-consolidate.mjs', usage: 'node em-consolidate.mjs [--scope local|global] [--min-sim <0..1>] [--min-cluster <n>] [--category <cat>] [--project <name>] [--include-pinned] [--apply] [--confirm] — fold near-duplicate episodes into digest episodes (dry-run by default) | --fold-superseded [--min-chain <n>] [--dry-run] [--all-projects] — archive non-terminal members of long supersedes-chains (reversible; terminal untouched; history walk still resolves the chain). --all-projects (fold mode only, mutually exclusive with --scope) folds every consumer-registry store; a real multi-store run requires --confirm; per-store R6 protection unions cwd-local + global + all registered stores | --clerk [--apply] [--confirm] [--window-ms <ms>] [--zero-conversion-runs <n>] — R9b lexical clerk (report by default, apply with --apply; consumes activation-log.jsonl via rotate-and-consume; the R6 conversion metric is a binary lower bound folded into the run-record; the report surfaces lessons with >= --zero-conversion-runs (default 3) consecutive zero-conversion runs as reword/demote/suppress candidates) | --clerk --enrich [--apply] [--confirm] [--reject-member <id>]... — R9c lexical enrichment backfill (proposes triggers/applies_to_project/applies_to_tool from the episode\'s OWN project and tool provenance fields ONLY, never widened; per-item confirm; apply writes via em-revise AS-IS and a run-record under the same lock)' }))
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
const enrich = argv.includes('--enrich')
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
// hoisted; const is not — keeping it here avoids TDZ). In-memory only; store
// untouched.
const _highDfCache = new WeakMap()
// --break-highdf disables the high-df tag drop in clerkSignals (negative control
// for report::signalHighDfDrop; production runs never carry this flag).
const _BREAK_HIGHDF = process.argv.includes('--break-highdf')
// Clerk apply lock file (RFC-009 P4-S4, REQ-7). Declared in the pre-branch
// module-state block to avoid the TDZ hazard (function decls are hoisted; const
// is not) — the apply branch below references it.
const CLERK_LOCK_FILE = path.join(DATA_DIR, 'clerk-apply.lock')
// clerkWrite scalar-field list — declared in the pre-branch block (not below the
// clerk branch) because clerkWrite is called from the top-level apply branch
// during module evaluation; a `const` below the branch is in the TDZ then.
const CLERK_SCALAR_FM_FIELDS = ['id', 'date', 'project', 'category', 'status', 'summary', 'record_type', 'clerk_cutover', 'superseded_by', 'supersedes', 'review_by']
if (clerk && !apply && !enrich) {
  const _clerkBreakReportWrite = process.argv.includes('--break-report-write')
  const _clerkBreakDrain = process.argv.includes('--break-drain')
  const _clerkAllRows = loadIndex(DATA_DIR, scope)
  const _clerkActiveRaw = _clerkAllRows.filter(r =>
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

  // REQ-23 cadence advisory — shared gauge computation (RFC-012 R3a, P1): the
  // N gauge now counts active category:lesson rows only (was: all eligible).
  const _cadence = computeCadence(_clerkTriggerIndex.entries || [], _clerkAllRows)

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
  const advisory = _cadence.line

  // S5 REQ-18/19/20: compute the R6 conversion metric under the SAME
  // CLERK_LOCK_FILE lock the apply mode holds (one lock, one writer). The
  // conversion rotate-and-consume mutates the activation log; the lock
  // serializes the rotate against concurrent appends AND a concurrent apply.
  // The report's envelope carries the conversion summary so a reword/demote/
  // suppress candidate surface is available to the human reviewer.
  const _zeroRuns = (() => { const v = flag('--zero-conversion-runs'); const n = v !== undefined ? parseInt(v, 10) : 3; return Number.isFinite(n) && n >= 1 ? n : 3 })()
  const _windowMs = (() => { const v = flag('--window-ms'); const n = v !== undefined ? parseInt(v, 10) : ATTRIBUTION_WINDOW_MS; return Number.isFinite(n) && n > 0 ? n : ATTRIBUTION_WINDOW_MS })()
  const _clerkReportLockHandle = await acquire(CLERK_LOCK_FILE, 30)
  let _conversion = { per_band: { imperative: { n: 0, d: 0 }, plain: { n: 0, d: 0 } }, per_lesson: [], torn_skipped: 0, carried_forward: 0, lower_bound: true }
  if (_clerkReportLockHandle && _clerkReportLockHandle.ok) {
    try {
      _conversion = clerkComputeConversion(DATA_DIR, GLOBAL_DIR, Date.now(), _windowMs)
    } finally {
      release(_clerkReportLockHandle.handle)
    }
  }
  // REQ-21: read the last N run-records; surface lessons with N consecutive
  // zero-conversion runs as reword/demote/suppress candidates. (S5 stays
  // ADVISORY — it never blocks an apply; the run-record body carries the same
  // conversion report so a later P5 needs-enforcement reader can act on it.)
  const _zeroCandidates = (() => {
    const candidates = []
    const lessonHits = new Map() // id -> [{ts,n}, ...] most-recent first
    try {
      const allRows = loadIndex(DATA_DIR, scope)
      const rrRows = allRows
        .filter(r => r.record_type === RUN_RECORD_TYPE && r.category === RUN_RECORD_CATEGORY)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')))
      for (const rr of rrRows) {
        let payload = null
        try { payload = JSON.parse((fs.readFileSync(path.join(EPISODES_DIR, `${rr.id}.md`), 'utf8').split('\n\n').slice(1).join('\n\n') || '{}').replace(/^[^{]*/, '').match(/\{[\s\S]*\}/)?.[0] || 'null') } catch {}
        if (!payload || !payload.conversion || !Array.isArray(payload.conversion.per_lesson)) continue
        for (const le of payload.conversion.per_lesson) {
          if (!le || typeof le.id !== 'string') continue
          if (!lessonHits.has(le.id)) lessonHits.set(le.id, [])
          lessonHits.get(le.id).push({ ts: rr.date || '', n: le.n || 0, d: le.d || 0 })
        }
      }
    } catch {}
    for (const [id, hits] of lessonHits) {
      if (hits.length < _zeroRuns) continue
      const recent = hits.slice(0, _zeroRuns)
      if (recent.every(h => (h.n || 0) === 0 && (h.d || 0) > 0)) {
        candidates.push({ id, consecutive_zero_runs: recent.length, suggestion: 'reword' })
      }
    }
    return candidates
  })()

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
    conversion: _conversion,
    ...(_zeroCandidates.length ? { zero_conversion_candidates: _zeroCandidates } : {}),
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
// Clerk APPLY mode (--clerk --apply). RFC-009 P4-S4, R9b, REQ-6..13.
// Mutating merge/dedupe under ONE em-lock, ordered writes (REQ-8), exactly one
// run-record (REQ-11). F2: ALL writes route through clerkWrite — NEVER the
// legacy field-blind digest writer below. Delegated to clerkApplyMain (defined
// at end of file, hoisted) so this branch stays small and the TDZ-sensitive
// module state stays in the pre-branch block above.
// ---------------------------------------------------------------------------
if (clerk && apply && !enrich) {
  await clerkApplyMain()
}

// ---------------------------------------------------------------------------
// Clerk ENRICH mode (--clerk --enrich). RFC-009 P4-S6, R9c, REQ-14.
// Lexical enrichment backfill: proposes triggers/applies_to_project/
// applies_to_tool from the episode's OWN project and tool provenance
// fields ONLY (never widened). REPORT mode (no --apply) prints proposals;
// APPLY mode (--apply --confirm) calls em-revise AS-IS per confirmed
// item and writes ONE run-record under the SAME CLERK_LOCK_FILE the
// apply path uses (one lock, one writer — reuse, never a second lock).
// Delegated to clerkEnrichMain (defined at end of file, hoisted).
// ---------------------------------------------------------------------------
if (clerk && enrich) {
  await clerkEnrichMain()
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

// ===========================================================================
// clerkWrite(kind, frontmatter, dataDir) — the F2 DIRECT-write primitive
// (RFC-009 P4-S4, REQ-8/9/11). Validation-first, fail-closed. This is the
// ONLY write path the clerk apply uses; it NEVER routes through the legacy
// field-blind digest writer above (§7 F-STRIP). kind ∈ {digest, index-flip,
// run-record}. Returns { status, written?:id, flipped?:[ids] }; any
// validation failure aborts BEFORE any mutation.
// ===========================================================================
// clerkWrite scalar-field list is declared in the pre-branch module-state block
// (above) to avoid the TDZ hazard — the apply branch calls clerkWrite during
// module evaluation, before this point in the file is reached.

function clerkValidateFrontmatter(fm) {
  // --break-validate skips the validator entirely (negative control for
  // runrecord::categoryValidatedOnDirectWrite).
  if (process.argv.includes('--break-validate')) return { ok: true }
  // Category — mirror em-store.mjs:139-167: fail CLOSED on unloadable vocab.
  if (typeof fm.category === 'string') {
    let cv
    try { cv = validateCategory(fm.category) } catch (e) { return { ok: false, message: e.message } }
    if (!cv.ok) return { ok: false, message: `Invalid category "${fm.category}" (${cv.reason})` }
  }
  // Scalar line-breaking-char rejection (illegalScalarChar).
  for (const f of CLERK_SCALAR_FM_FIELDS) {
    const v = fm[f]
    if (v === undefined || v === null) continue
    const bad = illegalScalarChar(String(v))
    if (bad !== null) return { ok: false, message: `field ${f} contains illegal line-breaking character ${JSON.stringify(bad)}` }
  }
  // Inline-array item rejection (illegalValueChar) — consolidates + tags + the
  // activation arrays. This is the unquoted-inline-array class (§7.2 axis-5).
  for (const f of ['consolidates', 'tags', ...ACTIVATION_ARRAY_FIELDS]) {
    if (!Array.isArray(fm[f])) continue
    for (const item of fm[f]) {
      const bad = illegalValueChar(String(item))
      if (bad !== null) return { ok: false, message: `inline-array field ${f} item ${JSON.stringify(item)} contains illegal character ${JSON.stringify(bad)}` }
    }
  }
  return { ok: true }
}

function clerkSerializeFrontmatter(fm) {
  const lines = ['---']
  lines.push(`id: ${fm.id}`)
  lines.push(`date: ${fm.date}`)
  lines.push(`time: "${fm.time}"`)
  lines.push(`project: ${fm.project}`)
  lines.push(`category: ${fm.category}`)
  lines.push(`status: ${fm.status || 'active'}`)
  if (typeof fm.supersedes === 'string') lines.push(`supersedes: ${fm.supersedes}`)
  if (typeof fm.superseded_by === 'string') lines.push(`superseded_by: ${fm.superseded_by}`)
  if (Array.isArray(fm.consolidates)) lines.push(`consolidates: [${serializeInlineArray(fm.consolidates)}]`)
  lines.push(`tags: [${serializeInlineArray(fm.tags || [])}]`)
  if (typeof fm.priority === 'number') lines.push(`priority: ${fm.priority}`)
  lines.push(`summary: ${fm.summary}`)
  for (const f of ACTIVATION_ARRAY_FIELDS) {
    if (Array.isArray(fm[f]) && fm[f].length) lines.push(`${f}: [${serializeInlineArray(fm[f])}]`)
  }
  if (typeof fm.review_by === 'string') lines.push(`review_by: ${fm.review_by}`)
  if (typeof fm.record_type === 'string') lines.push(`record_type: ${fm.record_type}`)
  if (typeof fm.clerk_cutover === 'string') lines.push(`clerk_cutover: ${fm.clerk_cutover}`)
  if (fm.pinned === true) lines.push('pinned: true')
  lines.push('---')
  return lines.join('\n')
}

function clerkWrite(kind, frontmatter, dataDir) {
  if (dataDir !== DATA_DIR) return { status: 'error', message: `clerkWrite dataDir mismatch (${dataDir} !== ${DATA_DIR})` }
  const episodesDir = path.join(dataDir, 'episodes')
  const indexFile = path.join(dataDir, 'index.jsonl')

  if (kind === 'index-flip') {
    const fv = clerkValidateFrontmatter({ id: frontmatter.id, superseded_by: frontmatter.superseded_by })
    if (!fv.ok) return { status: 'error', message: fv.message }
    const memberId = frontmatter.id
    const supersededBy = frontmatter.superseded_by
    // --break-index-flip-json: write index.jsonl as a single JSON OBJECT (the
    // updateInverted shape) — corrupts the line-delimited JSONL. Negative
    // control for apply::indexFlipYieldsValidJsonl (round-2 N1).
    if (process.argv.includes('--break-index-flip-json')) {
      const obj = {}; obj[memberId] = supersededBy
      const tmp = indexFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
      fs.renameSync(tmp, indexFile)
      return { status: 'ok', flipped: [memberId] }
    }
    // JSONL read-map-rewrite (em-consolidate.mjs member-flip pattern) — NOT
    // updateInverted (which JSON.parses one OBJECT and corrupts JSONL).
    const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
    const rewritten = lines.map(line => {
      try {
        const entry = JSON.parse(line)
        if (entry.id === memberId) { entry.status = 'superseded'; entry.superseded_by = supersededBy }
        return JSON.stringify(entry)
      } catch { return line }
    })
    const tmp = indexFile + '.tmp'
    fs.writeFileSync(tmp, rewritten.join('\n') + '\n', 'utf8')
    fs.renameSync(tmp, indexFile)
    // Flip the episode file frontmatter too so a rebuild stays consistent.
    try {
      const fp = path.join(episodesDir, `${memberId}.md`)
      const content = fs.readFileSync(fp, 'utf8')
      let updated = content.replace(/^status: active$/m, `status: superseded\nsuperseded_by: ${supersededBy}`)
      if (updated === content) updated = content.replace(/^---\n/, `---\nsuperseded_by: ${supersededBy}\n`)
      const ftmp = fp + '.tmp'
      fs.writeFileSync(ftmp, updated, 'utf8')
      fs.renameSync(ftmp, fp)
    } catch {}
    return { status: 'ok', flipped: [memberId] }
  }

  // digest + run-record: full episode write. Validate first, fail-closed.
  const fv = clerkValidateFrontmatter(frontmatter)
  if (!fv.ok) return { status: 'error', message: fv.message }

  let content
  try { content = `${clerkSerializeFrontmatter(frontmatter)}\n\n# ${frontmatter.summary}\n\n${frontmatter.body || ''}\n` }
  catch (e) { return { status: 'error', message: e.message } }

  fs.mkdirSync(episodesDir, { recursive: true })
  fs.writeFileSync(path.join(episodesDir, `${frontmatter.id}.md`), content, 'utf8')

  const row = {
    id: frontmatter.id, date: frontmatter.date, time: frontmatter.time,
    project: frontmatter.project, category: frontmatter.category,
    status: frontmatter.status || 'active',
    supersedes: frontmatter.supersedes || null,
    ...(Array.isArray(frontmatter.consolidates) ? { consolidates: frontmatter.consolidates } : {}),
    tags: frontmatter.tags || [],
    summary: frontmatter.summary,
    ...(Array.isArray(frontmatter.triggers) ? { triggers: frontmatter.triggers } : {}),
    ...(Array.isArray(frontmatter.applies_to_projects) ? { applies_to_projects: frontmatter.applies_to_projects } : {}),
    ...(Array.isArray(frontmatter.applies_to_tools) ? { applies_to_tools: frontmatter.applies_to_tools } : {}),
    ...(Array.isArray(frontmatter.evidence) ? { evidence: frontmatter.evidence } : {}),
    ...(Array.isArray(frontmatter.lessons) ? { lessons: frontmatter.lessons } : {}),
    ...(typeof frontmatter.priority === 'number' ? { priority: frontmatter.priority } : {}),
    ...(typeof frontmatter.review_by === 'string' ? { review_by: frontmatter.review_by } : {}),
    ...(typeof frontmatter.record_type === 'string' ? { record_type: frontmatter.record_type } : {}),
    ...(typeof frontmatter.clerk_cutover === 'string' ? { clerk_cutover: frontmatter.clerk_cutover } : {}),
    ...(frontmatter.pinned === true ? { pinned: true } : {}),
  }
  fs.appendFileSync(indexFile, JSON.stringify(row) + '\n', 'utf8')
  updateInverted('tags.json', frontmatter.id, frontmatter.tags || [], true)
  updateInverted('category-index.json', frontmatter.id, [canonicalCategory(frontmatter.category)], true)
  try { updateTokensIndex(dataDir, frontmatter.id, episodeTokens({ summary: frontmatter.summary, tags: frontmatter.tags || [], body: content })) } catch {}
  return { status: 'ok', written: frontmatter.id }
}

// ===========================================================================
// Clerk APPLY helpers (RFC-009 P4-S4). All hoisted function declarations so the
// top-level `if (clerk && apply)` branch can call them (module state stays in
// the pre-branch block above to dodge the TDZ hazard).
// ===========================================================================

// Read the current index.jsonl into a Map<id,row> (fresh, for at-apply guards).
function clerkReadIndexRows(dataDir) {
  const m = new Map()
  try {
    const lines = fs.readFileSync(path.join(dataDir, 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    for (const line of lines) { try { const e = JSON.parse(line); if (e && typeof e.id === 'string') m.set(e.id, e) } catch {} }
  } catch {}
  return m
}

// Parse a run-record episode's JSON payload (stored as the last {-line of body).
function clerkReadRunRecordPayload(dataDir, id) {
  try {
    const content = fs.readFileSync(path.join(dataDir, 'episodes', `${id}.md`), 'utf8')
    const lines = content.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim()
      if (s.startsWith('{')) { try { return JSON.parse(s) } catch {} }
    }
  } catch {}
  return null
}

// Latest run-record payload per store (canonical id sort, mirrors protection class-d).
function clerkLoadLatestRunRecord(dataDir) {
  let rows = []
  try { rows = loadIndex(dataDir, scope) } catch { return null }
  const CANONICAL = /^\d{8}-\d{6}-/
  let best = null
  for (const r of rows) {
    if (r.record_type !== 'clerk-run' || typeof r.id !== 'string') continue
    const canonical = CANONICAL.test(r.id)
    if (!best || (canonical === best.canonical ? r.id > best.id : canonical)) best = { id: r.id, canonical }
  }
  return best ? clerkReadRunRecordPayload(dataDir, best.id) : null
}

// Store fingerprint = sha256 of the sorted active-candidate ids. Baked into each
// cluster fingerprint so a store mutation (new episode) invalidates a rejected
// cluster's suppression (§7.2 axis-2). Run-records + digests are already excluded
// from the candidate set (machine-consumed category / consolidates), so an apply's
// own run-record append does NOT shift the fingerprint (keeps rejectedNotReproposed
// stable on an unchanged store).
function clerkStoreFingerprint(candidateRows) {
  const ids = candidateRows.map(r => r.id).sort()
  return crypto.createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
}
function clerkClusterFingerprint(memberIds, storeFp) {
  return crypto.createHash('sha256').update(memberIds.slice().sort().join(',') + '\u0000' + storeFp).digest('hex').slice(0, 24)
}

// Orphan reconciliation (REQ-8 / EC4 / §7.2 axis-3): a digest carrying the
// clerk_cutover stamp but absent from EVERY run-record's written-ids is an
// orphaned apply (crash before the run-record landed). benign iff no member is
// yet superseded into it (crash before the supersede loop). Clock-independent
// (stamped field, NOT a date compare, NSP F6). Legacy digests LACK clerk_cutover
// so they are never re-offered.
function clerkDetectOrphans(dataDir, scopeArg) {
  let rows = []
  try { rows = loadIndex(dataDir, scopeArg) } catch { return [] }
  const written = new Set()
  for (const r of rows) {
    if (r.record_type !== 'clerk-run' || typeof r.id !== 'string') continue
    const payload = clerkReadRunRecordPayload(dataDir, r.id)
    if (payload && Array.isArray(payload.written_ids)) for (const w of payload.written_ids) written.add(w)
  }
  const supersededByMap = new Map()
  for (const r of rows) {
    if (typeof r.superseded_by === 'string' && r.status === 'superseded') {
      if (!supersededByMap.has(r.superseded_by)) supersededByMap.set(r.superseded_by, [])
      supersededByMap.get(r.superseded_by).push(r.id)
    }
  }
  const orphans = []
  for (const r of rows) {
    if (r.clerk_cutover && Array.isArray(r.consolidates) && r.status !== 'superseded' && !written.has(r.id)) {
      const members = supersededByMap.get(r.id) || []
      orphans.push({ digest_id: r.id, superseded_member_ids: members, benign: members.length === 0 })
    }
  }
  return orphans
}

// Cluster over the active candidates (same grouping + union-find as report mode,
// clustering only pairs whose resolveAction is merge/dedupe; state D
// supersession-adjacency forces merge). Returns { clusters, supersessionAdjacent }.
function clerkBuildClusters(activeRaw) {
  const groups = new Map()
  for (const r of activeRaw) {
    const key = `${r.project}\u0000${canonicalCategory(r.category)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const parent = new Map()
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const r of activeRaw) parent.set(r.id, r.id)
  const supRoots = new Map()
  for (const r of activeRaw) if (typeof r.supersedes === 'string' && r.supersedes) {
    if (!supRoots.has(r.supersedes)) supRoots.set(r.supersedes, [])
    supRoots.get(r.supersedes).push(r.id)
  }
  const supersessionAdjacent = new Set()
  for (const ids of supRoots.values()) if (ids.length >= 2) for (const id of ids) supersessionAdjacent.add(id)
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j]
        const action = (supersessionAdjacent.has(a.id) && supersessionAdjacent.has(b.id) && a.supersedes === b.supersedes)
          ? 'merge' : clerkResolveAction(clerkSignals(a, b))
        if (action === 'merge' || action === 'dedupe') union(a.id, b.id)
      }
    }
  }
  const byRoot = new Map()
  for (const r of activeRaw) { const root = find(r.id); if (!byRoot.has(root)) byRoot.set(root, []); byRoot.get(root).push(r) }
  const clusters = [...byRoot.values()]
    .filter(m => m.length >= minCluster)
    .map(m => m.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id)))
  return { clusters, supersessionAdjacent }
}

// Cluster-wide action: the most-actionable across its pairs (dedupe > merge >
// keep-distinct), matching the report envelope.
function clerkResolveClusterAction(members, supersessionAdjacent) {
  const RANK = { 'dedupe': 3, 'merge': 2, 'keep-distinct': 1 }
  let best = 'keep-distinct'
  for (let i = 0; i < members.length && best !== 'dedupe'; i++) {
    for (let j = i + 1; j < members.length && best !== 'dedupe'; j++) {
      const a = members[i], b = members[j]
      const action = (supersessionAdjacent.has(a.id) && supersessionAdjacent.has(b.id) && a.supersedes === b.supersedes)
        ? 'merge' : clerkResolveAction(clerkSignals(a, b))
      if (RANK[action] > RANK[best]) best = action
    }
  }
  return best
}

// REQ-9 merge field contract, built DIRECTLY by the clerk (NOT the legacy
// field-blind writer): triggers/applies_to_*/evidence = union(dedup); priority =
// max of DEFINED stored values (missing stays missing); review_by = latest-or-unset;
// tags = union; consolidates = member ids; clerk_cutover stamped.
function clerkBuildMergeFrontmatter(members) {
  const { dateStr, timeStr, idStamp } = nowParts()
  const memberIds = members.map(m => m.id)
  const summary = `Consolidated: ${members[members.length - 1].summary} (+${members.length - 1} related)`
  const digestId = `${idStamp}-${slugify(summary)}-${crypto.randomBytes(2).toString('hex')}`
  const unionArr = (field) => {
    const seen = new Set(), out = []
    for (const m of members) for (const v of (Array.isArray(m[field]) ? m[field] : [])) {
      if (typeof v === 'string' && !seen.has(v)) { seen.add(v); out.push(v) }
    }
    return out
  }
  const priorities = members.map(m => m.priority).filter(p => typeof p === 'number')
  const reviewBys = members.map(m => m.review_by).filter(r => typeof r === 'string')
  const bodySections = members.map(m => {
    let body = ''
    try { body = bodyOf(fs.readFileSync(path.join(EPISODES_DIR, `${m.id}.md`), 'utf8')) } catch {}
    return `## ${m.summary}\n\n(id: \`${m.id}\`, ${m.date})\n\n${body}`
  })
  const digestBody = [`Digest of ${members.length} related episodes (clerk merge, ${dateStr}).`, '', ...bodySections].join('\n\n')
  const triggers = unionArr('triggers')
  const applies_to_projects = unionArr('applies_to_projects')
  const applies_to_tools = unionArr('applies_to_tools')
  const evidence = unionArr('evidence')
  return {
    id: digestId, date: dateStr, time: timeStr,
    project: members[0].project, category: canonicalCategory(members[0].category),
    status: 'active', consolidates: memberIds,
    tags: normalizeTags(members.flatMap(m => Array.isArray(m.tags) ? m.tags : [])),
    summary,
    ...(triggers.length ? { triggers } : {}),
    ...(applies_to_projects.length ? { applies_to_projects } : {}),
    ...(applies_to_tools.length ? { applies_to_tools } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(priorities.length ? { priority: Math.max(...priorities) } : {}),
    ...(reviewBys.length ? { review_by: reviewBys.slice().sort()[reviewBys.length - 1] } : {}),
    clerk_cutover: CLERK_CUTOVER_MARKER,
    body: digestBody,
  }
}

// Legacy field-blind digest write (--break-oldwriter red control for
// apply::mergeFieldContract): drops the union activation fields + clerk_cutover.
function clerkLegacyDigestWrite(members, digest) {
  const bare = {
    id: digest.id, date: digest.date, time: digest.time, project: digest.project,
    category: digest.category, status: 'active', consolidates: digest.consolidates,
    tags: digest.tags, summary: digest.summary, body: digest.body,
  }
  clerkWrite('digest', bare, DATA_DIR)
  for (const m of members) clerkWrite('index-flip', { id: m.id, superseded_by: digest.id }, DATA_DIR)
}

// REQ-11 run-record: category workflow.lifecycle + scalar record_type:clerk-run +
// clerk_cutover; payload (JSON body) carries the source-index fingerprint, proposals,
// per-item outcomes, written/superseded ids, and the cumulative rejected set.
// S5: payload also carries the conversion report (REQ-18/19/20) so a later
// report::zeroConversionCandidate scan can read prior run-records and surface
// lessons with N consecutive zero-conversion runs (REQ-21).
function clerkBuildRunRecord({ writtenIds, supersededIds, proposals, applied, rejected, skippedGuard, rejectedSet, storeFp, orphans, badCategory, conversion }) {
  const { dateStr, timeStr, idStamp } = nowParts()
  const id = `${idStamp}-clerk-run-${crypto.randomBytes(2).toString('hex')}`
  const payload = {
    mode: 'clerk-apply', ts: new Date().toISOString(),
    source_index_fingerprint: storeFp,
    written_ids: writtenIds, superseded_ids: supersededIds,
    proposals, applied, rejected, skipped_guard: skippedGuard,
    rejected_cumulative: rejectedSet, orphans,
    ...(conversion ? { conversion } : {}),
  }
  return {
    id, date: dateStr, time: timeStr, project: 'clerk',
    // --sim-bad-runrecord-category proves the validator runs on the direct write
    // path (runrecord::categoryValidatedOnDirectWrite): an invalid category must
    // be REJECTED by clerkWrite before any write.
    category: badCategory ? 'zzinvalidcatsentinel' : RUN_RECORD_CATEGORY,
    status: 'active', tags: [],
    summary: `Clerk apply run: ${writtenIds.length} written, ${supersededIds.length} superseded, ${rejected.length} rejected`,
    record_type: RUN_RECORD_TYPE, clerk_cutover: CLERK_CUTOVER_MARKER,
    // rejected fingerprints stored top-level too so clerkLoadLatestRunRecord can
    // read them without the full payload parse (belt-and-braces).
    body: `Clerk run record (RFC-009 R9b P4-S4).\n\n${JSON.stringify({ ...payload, rejected: rejectedSet })}`,
  }
}

// ===========================================================================
// clerkComputeConversion(localDataDir, globalDataDir, now, windowMs)
//   — RFC-009 P4-S5 (R6 conversion metric, REQ-18/19/20).
//
// Rotate-and-consume the activation-log: atomic rename of activation-log.jsonl
// to a .processing name, parse the .processing file. OPEN-window lines
// (ts ∈ (now-window, now]) are carried forward (re-appended to a fresh log) so
// a later in-window access is not lost (NSP F5 / REQ-18). CLOSED-window lines
// are consumed: for each entry, read last_accessed from the store named by
// the line's source_scope; converted iff last_accessed ∈ (ts, ts+windowMs]
// (half-open, REQ-19). An unreadable source_scope store counts UNCONVERTED
// (lower bound, never inflated, REQ-20). Torn/unknown-v lines are skipped +
// counted (EC8). Multi-injection disambiguation: a (ts, access_count_at_inject)
// tuple is the attribution unit; the binary lower bound operates per-tuple
// (a per-access delta is unreconstructable from the scalar last_accessed index,
// see §7.1 F-7.1 / D-F).
//
// Crash recovery (REQ-18, fold round 2026-07-13): a leftover
// activation-log.jsonl.processing from a PRIOR crashed rotation is consumed
// FIRST (BEFORE the current log's rename) so its lines are folded into the
// same report — the next rotate would otherwise rename ON TOP of the leftover
// and silently lose those lines. The broken --break-rotate path
// (read+unlink) never touches a leftover .processing, so the red control
// proves the recovery is wired by leaving the leftover intact. Fail-open on
// any recovery error (crash recovery is best-effort, telemetry never raises).
//
// Fail direction (REQ-16/17 + §8.2): telemetry handling fails OPEN (drop at
// bound, skip torn lines, skip leftover on read error); the run-record write
// fails CLOSED (clerkWrite). This function returns an EMPTY lower_bound:true
// report on any read/rotate failure rather than throwing — the caller folds
// the (possibly empty) report into the run-record or the report envelope,
// never raising.
//
// Negative-control argv flags (portable — no env vars):
//   --break-rotate       : non-atomic rotate (read-then-truncate-in-place) AND skip leftover consumption — proves EC9 + crash recovery wiring
//   --break-window       : inclusive lower bound (last_accessed >= ts) — proves the half-open boundary
//   --break-sourcescope  : ignore line.source_scope, always read local — proves cross-store attribution
//   --break-tornskip     : throw on torn line instead of skipping+counting — proves EC8
//   --break-openwindow   : drop open-window lines instead of carrying forward — proves REQ-18 carry-forward
// ===========================================================================

// _parseLogForConversion(filePath, now, windowMs, opts) — pure line parser
// shared by the leftover-recovery and the rotated-log paths. Reads the file
// at filePath, partitions lines by ts vs the open-window boundary, and
// returns { perBand, perLessonMap, tornSkipped, openWindowLines }. The
// caller merges the returned state into its accumulator.
function _parseLogForConversion(filePath, now, windowMs, opts) {
  const perBand = { imperative: { n: 0, d: 0 }, plain: { n: 0, d: 0 } }
  const perLessonMap = new Map()
  let tornSkipped = 0
  const openWindowLines = []
  let raw
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return { perBand, perLessonMap, tornSkipped, openWindowLines } }
  const openWindowStart = now - windowMs
  for (const lineRaw of raw.split('\n')) {
    if (!lineRaw.trim()) continue
    let parsed
    try { parsed = JSON.parse(lineRaw) } catch {
      if (opts.breakTornSkip) throw new Error('torn line (--break-tornskip)')
      tornSkipped++
      continue
    }
    if (!parsed || parsed.v !== opts.logFormatVersion) {
      if (opts.breakTornSkip) throw new Error('unknown v (--break-tornskip)')
      tornSkipped++
      continue
    }
    const tsMs = Date.parse(parsed.ts)
    if (!Number.isFinite(tsMs)) { tornSkipped++; continue }
    if (tsMs > openWindowStart) {
      if (!opts.breakOpenWindow) openWindowLines.push({ serialized: lineRaw, ts: parsed.ts })
      continue
    }
    const lineEntries = Array.isArray(parsed.entries) ? parsed.entries : []
    for (const entry of lineEntries) {
      if (!entry || typeof entry.id !== 'string') continue
      // F3 (GLM review round 1): an entry with a missing or unknown
      // source_scope is treated as UNCONVERTED for that entry — counts toward
      // d, never n (REQ-20 lower bound, never inflated). The previous
      // implementation silently coerced unknown/missing to 'local' and could
      // count CONVERTED. --break-sourcescope still forces ALL scopes to
      // local (the red control semantics).
      const isKnownScope = entry.source_scope === 'local' || entry.source_scope === 'global'
      const entrySourceScope = isKnownScope ? entry.source_scope : 'local'
      const sourceDataDir = (opts.breakSourceScope || entrySourceScope === 'local') ? opts.localDataDir : opts.globalDataDir
      let lastAccessedRow = null
      if (isKnownScope) {
        // F4 (GLM review round 1): scan ALL rows matching the id and take the
        // MINIMUM last_accessed (conservative, provably lower-bound — the
        // earliest access that could have converted). Row-order independent.
        try {
          const indexFile = path.join(sourceDataDir, 'index.jsonl')
          if (fs.existsSync(indexFile)) {
            let minLa = null
            for (const ln of fs.readFileSync(indexFile, 'utf8').split('\n')) {
              if (!ln.trim()) continue
              try {
                const row = JSON.parse(ln)
                if (!row || row.id !== entry.id) continue
                const la = row.last_accessed ? Date.parse(row.last_accessed) : null
                if (la === null || Number.isNaN(la)) continue
                if (minLa === null || la < minLa) {
                  minLa = la
                  lastAccessedRow = row
                }
              } catch {}
            }
          }
        } catch {}
      }
      const lastAccessedMs = lastAccessedRow && lastAccessedRow.last_accessed ? Date.parse(lastAccessedRow.last_accessed) : null
      let converted = false
      if (lastAccessedMs !== null) {
        const upper = tsMs + windowMs
        if (opts.breakWindow) converted = (lastAccessedMs >= tsMs && lastAccessedMs <= upper) // RED: inclusive lower bound
        else converted = (lastAccessedMs > tsMs && lastAccessedMs <= upper) // GREEN: half-open
      }
      const band = entry.rendered === 'imperative' ? 'imperative' : 'plain'
      perBand[band].d++
      if (converted) perBand[band].n++
      const lessonKey = entry.id
      if (!perLessonMap.has(lessonKey)) perLessonMap.set(lessonKey, { n: 0, d: 0, last_ts: null, last_access_count: 0, band })
      const agg = perLessonMap.get(lessonKey)
      agg.d++
      if (converted) agg.n++
      agg.last_ts = parsed.ts
      agg.last_access_count = entry.access_count_at_inject || 0
    }
  }
  return { perBand, perLessonMap, tornSkipped, openWindowLines }
}

// _mergeParseResult(into, from) — fold one _parseLogForConversion result
// into the running accumulator. All accumulators are object properties so
// mutations are visible to the caller (primitives would NOT be visible
// across a function call).
function _mergeParseResult(into, from) {
  into.perBand.imperative.n += from.perBand.imperative.n
  into.perBand.imperative.d += from.perBand.imperative.d
  into.perBand.plain.n += from.perBand.plain.n
  into.perBand.plain.d += from.perBand.plain.d
  into.tornSkipped += from.tornSkipped
  for (const l of from.openWindowLines) into.openWindowLines.push(l)
  for (const [id, v] of from.perLessonMap) {
    const existing = into.perLessonMap.get(id)
    if (existing) {
      existing.n += v.n
      existing.d += v.d
      if (v.last_ts && (!existing.last_ts || v.last_ts > existing.last_ts)) {
        existing.last_ts = v.last_ts
        existing.last_access_count = v.last_access_count
      }
    } else {
      into.perLessonMap.set(id, { n: v.n, d: v.d, last_ts: v.last_ts, last_access_count: v.last_access_count, band: v.band })
    }
  }
}

function clerkComputeConversion(localDataDir, globalDataDir, now, windowMs) {
  const _breakRotate = process.argv.includes('--break-rotate')
  const _breakWindow = process.argv.includes('--break-window')
  const _breakSourceScope = process.argv.includes('--break-sourcescope')
  const _breakTornSkip = process.argv.includes('--break-tornskip')
  const _breakOpenWindow = process.argv.includes('--break-openwindow')
  const logPath = path.join(localDataDir, ACTIVATION_LOG_NAME)
  const processingPath = logPath + '.processing'
  const freshLogPath = logPath // re-append open-window lines here
  // Single state object — all accumulators live as object properties so
  // _mergeParseResult mutations are visible to the caller (a primitive
  // local would NOT be visible across a function call).
  const state = {
    perBand: { imperative: { n: 0, d: 0 }, plain: { n: 0, d: 0 } },
    perLessonMap: new Map(),
    tornSkipped: 0,
    openWindowLines: [],
  }
  const opts = { breakTornSkip: _breakTornSkip, breakOpenWindow: _breakOpenWindow, breakSourceScope: _breakSourceScope, breakWindow: _breakWindow, localDataDir, globalDataDir, logFormatVersion: LOG_FORMAT_VERSION }
  // REQ-18 crash recovery: a leftover .processing from a prior CRASHED
  // rotation is consumed FIRST so its lines are folded into the same report.
  // The next atomic rename would otherwise overwrite the leftover, silently
  // losing those telemetry lines. The broken --break-rotate path does not
  // touch a leftover .processing, so a red run leaves the leftover intact
  // (proves the recovery is wired). Fail-open on any read/parse error.
  if (!_breakRotate && fs.existsSync(processingPath)) {
    try { _mergeParseResult(state, _parseLogForConversion(processingPath, now, windowMs, opts)) } catch {}
  }
  // FAIL OPEN: no log AND no leftover → empty lower-bound report, no throw.
  if (!fs.existsSync(logPath)) {
    if (state.openWindowLines.length) {
      try { fs.appendFileSync(freshLogPath, state.openWindowLines.map(l => l.serialized).join('\n') + '\n', 'utf8') } catch {}
      try { fs.unlinkSync(processingPath) } catch {}
    } else if (fs.existsSync(processingPath)) {
      // no log, no open-window lines: the leftover was fully consumed; clean up.
      try { fs.unlinkSync(processingPath) } catch {}
    }
    return { per_band: state.perBand, per_lesson: [...state.perLessonMap.entries()].map(([id, v]) => ({ id, n: v.n, d: v.d, last_ts: v.last_ts, last_access_count_at_inject: v.last_access_count, band: v.band })), torn_skipped: state.tornSkipped, carried_forward: state.openWindowLines.length, lower_bound: true }
  }
  // Rotate: atomic rename (.processing) or, under --break-rotate, copy-then-truncate.
  if (_breakRotate) {
    // RED (--break-rotate): non-atomic — a concurrent O_APPEND after readSync
    // but before unlink would be lost. EC9 counterexample. Also skips the
    // leftover-recovery step above (proves recovery is wired) AND refuses to
    // touch a leftover .processing (would overwrite it). The red run leaves
    // both the leftover and the current log intact, with the leftover's
    // sentinel id absent from per_lesson.
    if (fs.existsSync(processingPath)) {
      // A leftover exists; the broken path does not recover it. Leave both
      // files intact and return the (still-empty) accumulating state. The
      // leftover is preserved on disk for a later atomic run to recover.
      return { per_band: state.perBand, per_lesson: [...state.perLessonMap.entries()].map(([id, v]) => ({ id, n: v.n, d: v.d, last_ts: v.last_ts, last_access_count_at_inject: v.last_access_count, band: v.band })), torn_skipped: state.tornSkipped, carried_forward: 0, lower_bound: true }
    }
    try {
      const raw = fs.readFileSync(logPath, 'utf8')
      fs.writeFileSync(processingPath, raw, 'utf8')
      fs.unlinkSync(logPath)
    } catch { return { per_band: state.perBand, per_lesson: [...state.perLessonMap.entries()].map(([id, v]) => ({ id, n: v.n, d: v.d, last_ts: v.last_ts, last_access_count_at_inject: v.last_access_count, band: v.band })), torn_skipped: state.tornSkipped, carried_forward: 0, lower_bound: true } }
  } else {
    try { fs.renameSync(logPath, processingPath) }
    catch { return { per_band: state.perBand, per_lesson: [...state.perLessonMap.entries()].map(([id, v]) => ({ id, n: v.n, d: v.d, last_ts: v.last_ts, last_access_count_at_inject: v.last_access_count, band: v.band })), torn_skipped: state.tornSkipped, carried_forward: 0, lower_bound: true } }
  }
  // Parse the (post-rename / post-write) .processing file and fold into state.
  // No try/catch here: a throw from --break-tornskip propagates to the caller
  // (clerk report / apply) which fails-closed on the run-record write.
  _mergeParseResult(state, _parseLogForConversion(processingPath, now, windowMs, opts))
  // Re-append open-window lines to a fresh log + unlink the .processing file.
  try {
    if (state.openWindowLines.length) {
      const fresh = state.openWindowLines.map(l => l.serialized).join('\n') + '\n'
      fs.appendFileSync(freshLogPath, fresh, 'utf8')
    }
    fs.unlinkSync(processingPath)
  } catch {}
  return {
    per_band: state.perBand,
    per_lesson: [...state.perLessonMap.entries()].map(([id, v]) => ({ id, n: v.n, d: v.d, last_ts: v.last_ts, last_access_count_at_inject: v.last_access_count, band: v.band })),
    torn_skipped: state.tornSkipped,
    carried_forward: state.openWindowLines.length,
    lower_bound: true,
  }
}

// ===========================================================================
// clerkApplyMain — the top-level --clerk --apply flow (REQ-6..13). Hoisted.
// ===========================================================================
async function clerkApplyMain() {
  const _breakConfirm = process.argv.includes('--break-confirm')
  const _breakWriteOrder = process.argv.includes('--break-writeorder')
  const _breakLock = process.argv.includes('--break-lock')
  const _breakRejected = process.argv.includes('--break-rejected')
  // F1 (REQ-12/REQ-6 TOCTOU): --break-locked-reread restores the RACY pre-lock
  // rejected-set read (negative control for apply::rejectedVisibleUnderLock).
  const _breakLockedReread = process.argv.includes('--break-locked-reread')
  const _breakOldWriter = process.argv.includes('--break-oldwriter')
  const _simCrashAfterStore = process.argv.includes('--sim-crash-after-store')
  const _simCrashAfterSupersede = process.argv.includes('--sim-crash-after-supersede')
  const _simBadRunRecordCat = process.argv.includes('--sim-bad-runrecord-category')
  const _simRaceSupersedeCanonical = process.argv.includes('--sim-race-supersede-canonical')
  // Per-cluster human decision (REQ-6/12/13): --reject-all rejects every proposed
  // cluster; --reject-member <id> rejects any cluster containing that member.
  // Rejected clusters are recorded (fingerprint) into the run-record's cumulative
  // set and NOT applied; they are not re-proposed against an unchanged store.
  const _rejectAll = process.argv.includes('--reject-all')
  const _rejectMembers = new Set()
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--reject-member' && process.argv[i + 1]) _rejectMembers.add(process.argv[i + 1])
  const _lockTimeoutS = (() => { const v = flag('--lock-timeout'); const n = v !== undefined ? parseInt(v, 10) : 30; return Number.isFinite(n) && n >= 0 ? n : 30 })()

  // Orphan reconciliation BEFORE the confirm gate so a plain `--clerk --apply`
  // (no --confirm) still reports crash orphans (EC4 detection path).
  const orphans = clerkDetectOrphans(DATA_DIR, scope)

  // REQ-6: fail-closed unless confirmed. --break-confirm bypasses (red control).
  if (!confirm && !_breakConfirm) {
    process.stdout.write(JSON.stringify({ status: 'error', mode: 'clerk-apply', code: 'unconfirmed', message: 'clerk apply requires --confirm (REQ-6)', orphans }) + '\n')
    process.exit(1)
  }

  const activeRaw = loadIndex(DATA_DIR, scope).filter(r =>
    r.status !== 'superseded' &&
    typeof r.id === 'string' &&
    typeof r.summary === 'string' &&
    !EXCLUDED_CATEGORIES.has(canonicalCategory(r.category)) &&
    (includePinned || r.pinned !== true) &&
    (!categoryFilter || canonicalCategory(r.category) === canonicalCategory(categoryFilter)) &&
    (!projectFilter || r.project === projectFilter) &&
    !Array.isArray(r.consolidates)
  )
  _clerkActiveRows = activeRaw

  let triggerIndex = { entries: [] }
  try { triggerIndex = loadMergedTriggerIndex({ project: LOCAL_DIR === DATA_DIR ? path.dirname(LOCAL_DIR) : undefined }) } catch {}
  clerkRegisterTriggers(triggerIndex)

  const today = new Date().toISOString().slice(0, 10)
  let protectedIds = new Map()
  try {
    const protectionRows = [
      ...loadProtectionRows(fs, path, LOCAL_DIR, 'local'),
      ...loadProtectionRows(fs, path, GLOBAL_DIR, 'global'),
    ]
    protectedIds = computeProtectedIds(protectionRows, today, [])
  } catch {}

  const { clusters, supersessionAdjacent } = clerkBuildClusters(activeRaw)
  const storeFp = clerkStoreFingerprint(activeRaw)

  const proposals = clusters.map(members => {
    const memberIds = members.map(m => m.id)
    return {
      members, memberIds,
      action: clerkResolveClusterAction(members, supersessionAdjacent),
      fingerprint: clerkClusterFingerprint(memberIds, storeFp),
    }
  })

  const applied = []
  const rejectedThisRun = []
  const skippedGuard = []

  // F1 (REQ-12/REQ-6 TOCTOU): the latest-run-record read + suppression marking are
  // the human-consent-critical read; they MUST run UNDER the lock so a concurrent
  // apply's rejection run-record is visible before this apply acts (else B applies a
  // cluster A just rejected — reviewer reproduced 6/6). --break-locked-reread keeps
  // the racy pre-lock snapshot (the falsifiable RED per A.6b).
  const markSuppression = () => {
    const latestRR = clerkLoadLatestRunRecord(DATA_DIR)
    const priorSet = new Set((latestRR && Array.isArray(latestRR.rejected)) ? latestRR.rejected : [])
    for (const p of proposals) p.suppressed = priorSet.has(p.fingerprint) && !_breakRejected
    return priorSet
  }
  let priorRejected = null
  if (_breakLockedReread) priorRejected = markSuppression() // RED: racy pre-lock read

  let lockHandle = null
  if (!_breakLock) {
    const acq = await acquire(CLERK_LOCK_FILE, _lockTimeoutS)
    if (!acq.ok) {
      process.stdout.write(JSON.stringify({ status: 'error', mode: 'clerk-apply', locked: true, code: 'lock-held', orphans }) + '\n')
      process.exit(1)
    }
    lockHandle = acq.handle
  }
  // GREEN: read the rejected set + mark suppression AFTER the lock is held.
  if (!_breakLockedReread) priorRejected = markSuppression()
  const newRejectedSet = new Set(priorRejected)

  // S5 REQ-18/19/20: compute the R6 conversion metric INSIDE the same locked
  // block the apply holds (one lock, one writer). The rotate-and-consume is
  // bounded by _windowMs (defaults to ATTRIBUTION_WINDOW_MS, 4h); the result
  // is folded into the run-record body so report::zeroConversionCandidate
  // (REQ-21) can read it later. Moved INSIDE the try block below so a throw
  // from the conversion still releases the held lock.
  const _applyWindowMs = (() => { const v = flag('--window-ms'); const n = v !== undefined ? parseInt(v, 10) : ATTRIBUTION_WINDOW_MS; return Number.isFinite(n) && n > 0 ? n : ATTRIBUTION_WINDOW_MS })()
  let _applyConversion = { per_band: { imperative: { n: 0, d: 0 }, plain: { n: 0, d: 0 } }, per_lesson: [], torn_skipped: 0, carried_forward: 0, lower_bound: true }

  let runRecordId = null
  try {
    // R6 conversion rotate-and-consume INSIDE the held lock; a throw from
    // --break-tornskip propagates to the finally (releases the lock + exits).
    _applyConversion = clerkComputeConversion(DATA_DIR, GLOBAL_DIR, Date.now(), _applyWindowMs)
    for (const p of proposals) {
      if (p.suppressed) continue
      const humanRejected = _rejectAll || p.memberIds.some(id => _rejectMembers.has(id))
      if (humanRejected || p.action === 'keep-distinct') { rejectedThisRun.push(p.fingerprint); newRejectedSet.add(p.fingerprint); continue }
      // Guard: protected non-pinned member blocks merge/dedupe (F4).
      const protectedHit = p.memberIds.find(id => protectedIds.has(id))
      if (protectedHit) { skippedGuard.push({ members: p.memberIds, reason: `protected:${protectedIds.get(protectedHit).reason}` }); continue }
      const canonicalId = p.members[0].id
      if (_simRaceSupersedeCanonical) clerkWrite('index-flip', { id: canonicalId, superseded_by: '__race__' }, DATA_DIR)
      // Guard: canonical already superseded (F4) → refuse, no write.
      const freshCanon = clerkReadIndexRows(DATA_DIR).get(canonicalId)
      if (!freshCanon || freshCanon.status === 'superseded') { skippedGuard.push({ members: p.memberIds, reason: 'canonical-superseded' }); continue }

      if (p.action === 'dedupe') {
        for (const m of p.members) { if (m.id !== canonicalId) clerkWrite('index-flip', { id: m.id, superseded_by: canonicalId }, DATA_DIR) }
        if (_simCrashAfterSupersede) process.exit(1)
        applied.push({ action: 'dedupe', canonical: canonicalId, superseded: p.memberIds.filter(id => id !== canonicalId), members: p.memberIds })
      } else {
        const digest = clerkBuildMergeFrontmatter(p.members)
        if (_breakOldWriter) {
          clerkLegacyDigestWrite(p.members, digest)
        } else if (_breakWriteOrder) {
          for (const m of p.members) clerkWrite('index-flip', { id: m.id, superseded_by: digest.id }, DATA_DIR)
          if (_simCrashAfterSupersede) process.exit(1) // WRONG order: digest not yet written
          clerkWrite('digest', digest, DATA_DIR)
          if (_simCrashAfterStore) process.exit(1)
        } else {
          clerkWrite('digest', digest, DATA_DIR)          // (1) store FIRST
          if (_simCrashAfterStore) process.exit(1)         // benign orphan window
          for (const m of p.members) clerkWrite('index-flip', { id: m.id, superseded_by: digest.id }, DATA_DIR) // (2) supersede
          if (_simCrashAfterSupersede) process.exit(1)     // dangerous orphan window
        }
        applied.push({ action: 'merge', digest_id: digest.id, superseded: p.memberIds, members: p.memberIds })
      }
    }

    // (3) exactly ONE run-record (REQ-11), even for an empty apply.
    const writtenIds = applied.map(a => a.digest_id).filter(Boolean)
    const supersededIds = applied.flatMap(a => a.superseded || [])
    const rr = clerkBuildRunRecord({
      writtenIds, supersededIds,
      proposals: proposals.map(p => ({ members: p.memberIds, action: p.action, fingerprint: p.fingerprint, suppressed: p.suppressed })),
      applied, rejected: rejectedThisRun, skippedGuard,
      rejectedSet: [...newRejectedSet], storeFp, orphans, badCategory: _simBadRunRecordCat,
      conversion: _applyConversion,
    })
    const rrRes = clerkWrite('run-record', rr, DATA_DIR)
    if (rrRes.status === 'ok') runRecordId = rr.id
    else {
      process.stdout.write(JSON.stringify({ status: 'error', mode: 'clerk-apply', code: 'run-record-write-failed', message: rrRes.message, applied, orphans }) + '\n')
      release(lockHandle)
      process.exit(1)
    }
  } finally {
    release(lockHandle)
  }

  const out = {
    status: 'ok', mode: 'clerk-apply',
    applied,
    proposals: proposals.filter(p => !p.suppressed).map(p => ({ members: p.memberIds, action: p.action, fingerprint: p.fingerprint })),
    rejected: rejectedThisRun, skipped_guard: skippedGuard,
    run_record: runRecordId, orphans,
    conversion: _applyConversion,
  }
  await new Promise(resolve => process.stdout.write(JSON.stringify(out) + '\n', resolve))
  process.exit(0)
}

// ===========================================================================
// clerkEnrichCandidates(row, opts) — R9c lexical candidate finder (REQ-14).
// For a given active lesson row, proposes:
//   - triggers: lexemes extracted from the row's summary + tags (tokenizeQuery)
//   - applies_to_project: [row.project] — the episode's OWN project; NEVER
//     widened beyond provenance (REQ-14 hard stop, NSP T8)
//   - applies_to_tool: row.applies_to_tools — the episode's OWN tool
//     provenance; NEVER widened
//   - activity: [] (no automatic activity-class inference; humans or a
//     downstream R10 classifier would fill this in)
//
// --break-scope widens the candidate scope beyond provenance (RED control
// for enrich::scopeFromProvenanceOnly).
// ===========================================================================
function clerkEnrichCandidates(row, opts) {
  const triggers = new Set()
  for (const t of tokenizeQuery(row.summary || '')) triggers.add(t)
  for (const tag of (Array.isArray(row.tags) ? row.tags : [])) {
    for (const t of tokenizeQuery(tag)) triggers.add(t)
  }
  const appliesToProject = [row.project].filter(Boolean)
  const appliesToTool = Array.isArray(row.applies_to_tools) ? row.applies_to_tools.slice() : []
  if (opts && opts._breakScope) {
    // RED: widen beyond provenance (violates REQ-14). The red control proves
    // the green test discriminates the scope-narrow invariant.
    appliesToProject.push('unrelated-widened-project-1', 'unrelated-widened-project-2')
    appliesToTool.push('unrelated-widened-tool-1')
  }
  return {
    id: row.id,
    triggers: [...triggers].slice(0, 20),
    applies_to_project: appliesToProject,
    applies_to_tool: appliesToTool,
    activity: [],
  }
}

// ===========================================================================
// clerkEnrichMain() — the --clerk --enrich flow (REQ-14, R9c lexical
// enrichment). REPORT mode: prints per-lesson candidates. APPLY mode: per
// confirmed item, calls em-revise AS-IS via spawnSync (the
// scripts/em-capture.mjs:453 idiom), then writes ONE run-record under
// the SAME CLERK_LOCK_FILE lock the apply path uses — reuse, never a second
// writer or second lock. em-revise is NEVER modified; the clerk drives
// its existing --original --project --summary --body --trigger
// --applies-to-project --applies-to-tool surface. Fail direction split is
// preserved: the per-item em-revise subprocess failures fail CLOSED
// (the apply halts and the run-record is NOT written); a successful apply
// drains a single JSON envelope to stdout then exits 0.
// ===========================================================================
async function clerkEnrichMain() {
  const _breakScope = process.argv.includes('--break-scope')
  // --break-confirm bypasses the fail-closed confirm gate (GLM review F2 red
  // control for enrich::noConfirmNoWrite, mirroring S4's --break-confirm).
  const _breakConfirm = process.argv.includes('--break-confirm')
  // Per-item rejection (mirrors S4's --reject-member).
  const _rejectMembers = new Set()
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--reject-member' && process.argv[i + 1]) _rejectMembers.add(process.argv[i + 1])
  const _lockTimeoutS = (() => { const v = flag('--lock-timeout'); const n = v !== undefined ? parseInt(v, 10) : 30; return Number.isFinite(n) && n >= 0 ? n : 30 })()
  const _enrichHome = process.env.HOME || os.homedir()
  const _revisePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'em-revise.mjs')

  const activeRaw = loadIndex(DATA_DIR, scope).filter(r =>
    r.status !== 'superseded' &&
    typeof r.id === 'string' &&
    typeof r.summary === 'string' &&
    !EXCLUDED_CATEGORIES.has(canonicalCategory(r.category)) &&
    (includePinned || r.pinned !== true) &&
    (!categoryFilter || canonicalCategory(r.category) === canonicalCategory(categoryFilter)) &&
    (!projectFilter || r.project === projectFilter) &&
    !Array.isArray(r.consolidates)
  )

  // Compute candidates for each active row.
  const proposals = activeRaw.map(row => ({
    id: row.id,
    project: row.project,
    candidates: clerkEnrichCandidates(row, { _breakScope }),
  }))

  // REPORT mode (default): print proposals, no writes.
  if (!apply) {
    const out = {
      status: 'ok',
      mode: 'clerk-enrich',
      proposals,
    }
    await new Promise(resolve => process.stdout.write(JSON.stringify(out) + '\n', resolve))
    process.exit(0)
  }

  // APPLY mode: per-item confirmation gating (REQ-6 mirror). --break-confirm
  // bypasses the gate (red control for enrich::noConfirmNoWrite).
  if (!confirm && !_breakConfirm) {
    process.stdout.write(JSON.stringify({ status: 'error', mode: 'clerk-enrich', code: 'unconfirmed', message: 'clerk enrich apply requires --confirm (REQ-14)', proposals }) + '\n')
    process.exit(1)
  }

  // Acquire the SAME CLERK_LOCK_FILE the apply path uses (one lock, one
  // writer — reuse, never a second lock).
  const acq = await acquire(CLERK_LOCK_FILE, _lockTimeoutS)
  if (!acq.ok) {
    process.stdout.write(JSON.stringify({ status: 'error', mode: 'clerk-enrich', locked: true, code: 'lock-held', proposals }) + '\n')
    process.exit(1)
  }
  const lockHandle = acq.handle

  const applied = []
  const rejectedThisRun = []
  try {
    for (const p of proposals) {
      if (_rejectMembers.has(p.id)) { rejectedThisRun.push(p.id); continue }
      const c = p.candidates
      // Skip if no candidates to apply (no triggers, no applies, no tools).
      if (c.triggers.length === 0 && c.applies_to_project.length === 0 && c.applies_to_tool.length === 0) continue
      const row = activeRaw.find(r => r.id === p.id)
      if (!row) continue
      // Read the original body from the episode file.
      let body = ''
      try { body = bodyOf(fs.readFileSync(path.join(EPISODES_DIR, `${p.id}.md`), 'utf8')) } catch {}
      // Build em-revise args (REQ-14: provenance-only triggers/applies).
      const args = [
        _revisePath,
        '--original', p.id,
        '--project', row.project,
        '--summary', row.summary,
        '--body', body,
      ]
      for (const t of c.triggers) args.push('--trigger', t)
      for (const ap of c.applies_to_project) args.push('--applies-to-project', ap)
      for (const at of c.applies_to_tool) args.push('--applies-to-tool', at)
      // scripts/em-capture.mjs:453 idiom (cwd = TARGET project root,
      // encoding utf8, timeout 60000). HOME inherited from the test
      // fixture override.
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: process.cwd(), timeout: 60000, env: { ...process.env, HOME: _enrichHome } })
      let json = null
      try { json = JSON.parse(r.stdout.trim()) } catch {}
      if (r.status !== 0 || !json || json.status !== 'ok') {
        release(lockHandle)
        process.stdout.write(JSON.stringify({ status: 'error', mode: 'clerk-enrich', code: 'revise-failed', id: p.id, status: r.status, stderr: r.stderr, applied, rejected: rejectedThisRun }) + '\n')
        process.exit(1)
      }
      applied.push({ id: p.id, revised_id: json.id })
    }
    // Build run-record (clerkBuildRunRecord, same writer as S4) under the lock.
    const writtenIds = applied.map(a => a.revised_id).filter(Boolean)
    const supersededIds = applied.map(a => a.id)
    const rr = clerkBuildRunRecord({
      writtenIds, supersededIds,
      proposals: proposals.map(p => ({ id: p.id, candidates: p.candidates })),
      applied, rejected: rejectedThisRun, skippedGuard: [],
      rejectedSet: rejectedThisRun.slice(), storeFp: 'enrich', orphans: [], badCategory: false,
    })
    // Override the summary to reflect the enrich action.
    rr.summary = `Clerk enrich run: ${writtenIds.length} enriched, ${supersededIds.length} superseded, ${rejectedThisRun.length} rejected`
    const rrRes = clerkWrite('run-record', rr, DATA_DIR)
    let runRecordId = null
    if (rrRes.status === 'ok') runRecordId = rr.id
    else {
      release(lockHandle)
      process.stdout.write(JSON.stringify({ status: 'error', mode: 'clerk-enrich', code: 'run-record-write-failed', message: rrRes.message, applied }) + '\n')
      process.exit(1)
    }
    const out = {
      status: 'ok', mode: 'clerk-enrich',
      applied, rejected: rejectedThisRun,
      run_record: runRecordId, proposals,
    }
    release(lockHandle)
    await new Promise(resolve => process.stdout.write(JSON.stringify(out) + '\n', resolve))
    process.exit(0)
  } catch (e) {
    release(lockHandle)
    throw e
  }
}

