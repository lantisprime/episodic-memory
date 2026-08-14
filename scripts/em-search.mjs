#!/usr/bin/env node
/**
 * em-search.mjs — Search episodic memories with per-project + global fallback.
 *
 * Usage:
 *   node em-search.mjs [--project <name>] [--tag <tag>] [--category <cat>]
 *                      [--query <text>] [--since <YYYY-MM-DD>] [--limit <n>]
 *                      [--scope local|global|all] [--include-superseded]
 *                      [--read <id>] [--history <id>] [--full] [--materialize]
 *                      [--no-score] [--no-track]
 *                      (if both --read and --history are passed, --read wins;
 *                      --materialize composes with --read (never ambiguous), or
 *                      with a filter query iff the pre-limit match count is 1 —
 *                      otherwise a materialize-ambiguous error)
 *                      [--warn-time-ms <n>] [--warn-count <n>]
 *
 * By default, searches local then global (scope=all), hides superseded episodes,
 * scores results by relevance, and tracks access.
 * Outputs JSON: { status, count, episodes: [...] }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { canonicalCategory } from './lib/categories.mjs'
import {
  normalizeTags, loadTagsIndex, loadCategoryIndex, loadIndex, loadArchivedIndex,
  computeScore, writeBackAccessTracking, scoreTextMatch,
  tokenizeQuery, loadTokensIndex, tokenCandidates, scorePartialMatch
} from './lib/relevance.mjs'
import { IndexUnreadableError, readBodyOrSkip, openReadableBody, BodyUnreadableError } from './lib/index-state.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-search.mjs', usage: 'node em-search.mjs [--project <name>] [--tag <tag>] [--category <cat>] [--query <text>] [--since <YYYY-MM-DD>] [--limit <n>] [--scope local|global|all] [--include-superseded] [--read <id>] [--history <id>] [--full] [--materialize] [--no-score] [--no-track] (if both --read and --history are passed, --read wins; --materialize composes with --read (never ambiguous), or with a filter query iff the pre-limit match count is 1 — otherwise a materialize-ambiguous error) [--warn-time-ms <n>] [--warn-count <n>]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const project = flag('--project')
const tag = flag('--tag')
const category = flag('--category')
const query = flag('--query')
const since = flag('--since')
const limit = parseInt(flag('--limit') || '10', 10)
const scope = flag('--scope') || 'all'
const full = argv.includes('--full')
const includeSuperseded = argv.includes('--include-superseded')
const historyId = flag('--history')
const readId = flag('--read')
const materialize = argv.includes('--materialize')
const noScore = argv.includes('--no-score')
const noTrack = argv.includes('--no-track')
const warnTimeMs = parseInt(flag('--warn-time-ms') || '500', 10)
const warnCount = parseInt(flag('--warn-count') || '5000', 10)

const VALID_SCOPES_SEARCH = ['local', 'global', 'all']
if (!VALID_SCOPES_SEARCH.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_SEARCH.join(', ')}` }))
  process.exit(1)
}

const searchStart = Date.now()

// Retrieval primitives (normalizeTags, loadTagsIndex, loadCategoryIndex,
// loadIndex, computeScore, writeBackAccessTracking, scoreTextMatch) are
// shared with em-recall.mjs via lib/relevance.mjs — the former SYNC: blocks.

// ---------------------------------------------------------------------------
// Collect entries based on scope
// ---------------------------------------------------------------------------
let results = []

try {
  if (scope === 'local' || scope === 'all') {
    results.push(...loadIndex(LOCAL_DIR, 'local'))
  }
  if (scope === 'global' || scope === 'all') {
    results.push(...loadIndex(GLOBAL_DIR, 'global'))
  }
} catch (e) {
  if (e instanceof IndexUnreadableError) {
    console.log(JSON.stringify({ status: 'error', message: `em-search: ${e.message}`, code: `index-unreadable:${e.code}` }))
    process.exit(1)
  }
  throw e
}

const totalEpisodeCount = results.length

// Dedupe by id (local takes priority)
const seen = new Set()
results = results.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})

// Preserved BEFORE any mode branch/filter narrows `results`: --history and
// --materialize's backward chain walk need EVERY live row, including ones the
// search filters below (e.g. `status !== 'superseded'`) would exclude — an
// ancestor revision is superseded by definition and would otherwise vanish
// from `results` before the walk could ever reach it.
const allLiveResults = results.slice()

// Shared by --history and --materialize: live rows (already scope-filtered +
// deduped) plus archived rows for the active scope(s) — em-prune and
// em-consolidate --fold-superseded move an episode's file to archived/ and its
// row to archived-index.jsonl, so a chain with archived members would
// otherwise silently truncate. Live rows win on id collision (`seenIds`
// already carries every live id from the dedup above); archived rows carry
// `_archived: true` (stamped by loadArchivedIndex).
function collectChainEntries(baseResults, seenIds) {
  const allEntries = [...baseResults]
  for (const [dir, label] of [[LOCAL_DIR, 'local'], [GLOBAL_DIR, 'global']]) {
    if (scope !== 'all' && scope !== label) continue
    for (const row of loadArchivedIndex(dir, label)) {
      if (seenIds.has(row.id)) continue
      seenIds.add(row.id)
      allEntries.push(row)
    }
  }
  return allEntries
}

// F5 rule (issues #666/#667, every body-read site in this file): non-ENOENT
// codes (EISDIR/ENOTREG/EACCES/...) are a shape defect — skip + warn.
// ENOENT (absent body / dangling row) preserves each site's CURRENT silent
// behavior exactly — a dangling-row store must not start spamming warnings
// on every search. Deduped per id:code so a body that fails BOTH the
// scoring read and the --full output re-read warns only once. Returns
// nothing; the caller passes the array its own output shape will surface
// the joined warning through (materializeChain/--history have their own
// output objects; the default search path shares the bottom `warnings`
// array via searchBodyWarnings).
const bodyWarnSeen = new Set()
function noteBodySkip(target, id, code) {
  if (code === 'ENOENT') return
  const key = `${id}:${code}`
  if (bodyWarnSeen.has(key)) return
  bodyWarnSeen.add(key)
  target.push(`episode body skipped ${id}: unreadable (${code})`)
}

// --materialize (#634a): walk backward via the scalar `supersedes` edge from the
// anchor to root (archived-aware via collectChainEntries — same live+archived
// merge as --history), reverse to root->terminal order, and concatenate full
// bodies with a provenance delimiter. A `consolidates`-bearing root terminates
// the walk naturally: `consolidates` is a forward-only successor edge this
// backward walk never follows.
function materializeChain(anchorRow) {
  const allEntries = collectChainEntries(allLiveResults, seen)
  const byId = new Map(allEntries.map(e => [e.id, e]))
  const spine = []
  const spineVisited = new Set()
  let node = byId.get(anchorRow.id) || anchorRow
  while (node) {
    if (spineVisited.has(node.id)) break // cyclic supersedes: truncate, do not loop forever
    spineVisited.add(node.id)
    spine.push(node)
    if (!node.supersedes) break
    const parent = byId.get(node.supersedes)
    if (!parent) break
    node = parent
  }
  spine.reverse() // root -> anchor (terminal)
  const chainWarnings = []
  const members = spine.map(e => {
    const archived = !!e._archived
    const filePath = path.join(e._dataDir, archived ? 'archived' : 'episodes', `${e.id}.md`)
    let bodyText = ''
    // #666 S2 :166: readBodyOrSkip replaces existsSync+readFileSync — a
    // FIFO-shaped member must skip+warn (F5), not hang the whole chain.
    const bodyRead = readBodyOrSkip(fs, filePath)
    if (bodyRead.ok) {
      const parts = bodyRead.raw.split('---')
      bodyText = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
    } else {
      noteBodySkip(chainWarnings, e.id, bodyRead.code)
    }
    const meta = { id: e.id, date: e.date, summary: e.summary, body_len: bodyText.length }
    if (archived) meta.archived = true
    return { meta, bodyText }
  })
  // Delimiter escaping is deliberately DEFERRED (audit F6) — id/summary are
  // store-controlled strings, not yet exposed to a structured `body` consumer.
  const body = members.map(m => `<!-- ${m.meta.id} | ${m.meta.summary} -->\n${m.bodyText}`).join('\n\n')
  return {
    status: 'ok',
    terminal_id: anchorRow.id,
    count: members.length,
    members: members.map(m => m.meta),
    body,
    ...(chainWarnings.length ? { warning: chainWarnings.join(' | ') } : {}),
  }
}

// ---------------------------------------------------------------------------
// Read mode (RFC-011 R7 / REQ-14 — amended): fetch exactly ONE episode by exact
// id. No chain walk; full frontmatter + body, returned IN FULL — no size bound
// (the former 49152 serialized-byte cap was a host DISPLAY limit misplaced into
// storage, making the round-trip lossy; see the note at the body assignment
// below). Resolves
// episodes/ then archived/ (an archived episode returns normally with its
// status visible). Frontmatter is parsed from the episode FILE and merged OVER
// the index row (file wins on frontmatter fields; the row supplies access_count,
// last_accessed, source). A row whose body file is absent from BOTH episodes/ and
// archived/ returns body_missing:true (status ok, exit 0) + a stderr note and
// SKIPS tracking (a delivered-nothing read must not feed conversion telemetry).
// Tracks access_count/last_accessed on the matched row otherwise, honoring
// --no-track; an empty `--read ''` (flag present, empty value) is an error.
// Drains stdout before exit (mirrors --history discipline ~:179-185). Does NOT
// touch --history behavior.
// ---------------------------------------------------------------------------
if (readId !== undefined) {
  // F-kimi: flag PRESENT with empty value is an error (check presence, not
  // truthiness — `--read ''` must not fall through to the search path).
  if (readId === '') {
    const out = JSON.stringify({ status: 'error', message: 'Episode "" not found' })
    await new Promise((resolve) => process.stdout.write(out + '\n', resolve))
    process.exit(1)
  }

  // Active rows for the active scopes are already collected in `results`
  // (loadIndex, local-priority dedup) BEFORE any filters apply — exact-id
  // fetch ignores project/tag/category/query filters by design. Resolve
  // episodes/ first (active index), then archived/ on miss (R7 order).
  let row = results.find(e => e.id === readId)
  let archived = false
  if (!row) {
    const archivedEntries = []
    for (const [dir, label] of [[LOCAL_DIR, 'local'], [GLOBAL_DIR, 'global']]) {
      if (scope !== 'all' && scope !== label) continue
      archivedEntries.push(...loadArchivedIndex(dir, label))
    }
    row = archivedEntries.find(e => e.id === readId)
    archived = !!row && !!row._archived
  }

  if (!row) {
    // State B (§12): unknown id → error status, exit 1, no side effects.
    const out = JSON.stringify({ status: 'error', message: `Episode "${readId}" not found` })
    await new Promise((resolve) => process.stdout.write(out + '\n', resolve))
    process.exit(1)
  }

  // --materialize composes with --read (#634a): the anchor is already resolved
  // unambiguously by exact id, so no ambiguity check is needed here (that check
  // is filter-query-only, below). Short-circuits before the single-episode read
  // path (frontmatter merge, coercions, tracking) — materialize is a chain-wide
  // retrieval, not a single-episode read. No access tracking, mirroring
  // --history's investigative-query posture.
  if (materialize) {
    const out = materializeChain(row)
    await new Promise((resolve) => process.stdout.write(JSON.stringify(out) + '\n', resolve))
    process.exit(0)
  }

  // Episode file path (episodes/ for active rows, archived/ for archived rows —
  // mirrors --history body resolution).
  const subDir = archived ? 'archived' : 'episodes'
  const filePath = path.join(row._dataDir, subDir, `${row.id}.md`)
  // #666 S2 --read row: single-target AUTHORITATIVE read — openReadableBody
  // reads the file ONCE (audit F1: this used to be TWO separate readFileSync
  // calls, here and again at the body-extraction site below); unreadable
  // (non-absent) aborts typed, absent (null) preserves the existing
  // load-bearing body_missing exit-0 path UNCHANGED.
  let fileContent
  try {
    fileContent = openReadableBody(fs, filePath)
  } catch (e) {
    if (!(e instanceof BodyUnreadableError)) throw e
    const out = JSON.stringify({ status: 'error', message: `em-search: ${e.message}`, code: `episode-unreadable:${e.code}` })
    await new Promise((resolve) => process.stdout.write(out + '\n', resolve))
    process.exit(1)
  }
  const fileExists = fileContent !== null

  // F-codex: parse the episode FILE's frontmatter and merge OVER the index row
  // (file wins for frontmatter fields). The index row supplies the operational
  // fields the file does not carry (access_count, last_accessed) plus source and
  // the archived flag. Mirrors the line-based YAML-ish parser in
  // em-rebuild-index.mjs's parseFrontmatter (the substrate convention: key: value,
  // inline arrays, quoted scalars) — keeps custom/foreign frontmatter keys.
  const entry = {}
  if (fileExists) {
    const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/)
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/)
        if (!m) continue
        const [, key, raw] = m
        const arrMatch = raw.match(/^\[(.*)\]$/)
        if (arrMatch) {
          entry[key] = arrMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        } else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
          entry[key] = raw.slice(1, -1)
        } else {
          entry[key] = raw === 'null' ? null : raw
        }
      }
    }
  }
  // Merge: file frontmatter wins for content fields; the index row fills
  // operational fields the file never carries. (Operational fields are FORCED
  // after this loop — see F1 block below — so a forged
  // access_count/last_accessed/archived/source in file frontmatter cannot
  // override the resolution.)
  const { _dataDir, _source, _archived, ...rowFrontmatter } = row
  for (const [k, v] of Object.entries(rowFrontmatter)) {
    if (!(k in entry)) entry[k] = v
  }

  // F1 (amended R7): operational fields come from the RESOLUTION, NEVER from
  // file frontmatter — a file whose frontmatter carries forged
  // access_count: 999 / last_accessed: forged / archived: true / source: global
  // must not override the index's operational values. access_count +
  // last_accessed from the index row (defaulting to 0/null matches the rebuilt
  // index surface), source from the store that resolved the id, archived from
  // which directory the body file came from (true only for an archived-row
  // resolution; deleted otherwise — the index never carries an archived field).
  entry.access_count = row.access_count ?? 0
  entry.last_accessed = row.last_accessed ?? null
  entry.source = _source
  if (archived) entry.archived = true
  else if ('archived' in entry) delete entry.archived

  // LOCKSTEP with em-rebuild-index.mjs :184,:205 (priority → Number when finite;
  // declaration at :184, the Number.isFinite coercion applied to the emitted
  // entry at :205) and :208 (pinned → true when 'true'). The file-frontmatter parser above
  // yields YAML scalars as strings; the writers/em-rebuild-index index a Number
  // and a boolean. These exact coercions keep --read byte-consistent with the
  // list/index surfaces so a priority/pinned value does not flip type between
  // `--read` and `em-list`/`em-search`. Class is closed: priority and pinned
  // are the only non-string scalars the writers emit.
  if (entry.priority !== undefined) {
    const priorityNum = Number(entry.priority)
    entry.priority = Number.isFinite(priorityNum) ? priorityNum : entry.priority
  }
  if (entry.pinned === true || entry.pinned === 'true') {
    entry.pinned = true
  } else if ('pinned' in entry) {
    delete entry.pinned
  }

  // F2: dangling body — index row present but file absent from BOTH episodes/
  // and archived/ (deleted file P5, torn-prune P5b where the file moved to
  // archived/ but the row is still active). Return body_missing:true (status ok,
  // exit 0) + stderr note, and SKIP tracking entirely (a delivered-nothing read
  // must not feed conversion telemetry).
  if (!fileExists) {
    entry.body_missing = true
    process.stderr.write(`body file missing for episode ${row.id}; read returned frontmatter only\n`)
    await new Promise((resolve) => process.stdout.write(
      JSON.stringify({ status: 'ok', episode: entry }) + '\n', resolve))
    process.exit(0)
  }

  // Body is everything after the second `---`. Reuses fileContent read ONCE
  // above (F1: no second readFileSync).
  const parts = fileContent.split('---')
  const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''

  // The body is returned IN FULL. There is deliberately no size bound here.
  //
  // The removed bound (MAX_SERIALIZED_BODY = 49152) originated as a DELIVERY
  // observation — RFC-011:28 Problem 4, a host tool-output limit seen cutting a
  // 126,148-byte `--history --full` — but was implemented as a STORAGE bound in
  // this read path. em-store.mjs and em-revise.mjs impose no body-size bound at
  // write time, so this made the round-trip lossy: the store accepted a body of
  // any size and then refused to return it, discarding the remainder with no
  // route back. Fitting output to a host is presentation, an adjacent layer
  // (CAPABILITIES.md); the substrate returns what it was given.
  entry.body = body

  // Access tracking on the matched row (R7), honoring --no-track. Mirrors the
  // search write-back for exactly one row. Archived rows live in
  // archived-index.jsonl, which writeBackAccessTracking does not target, so
  // tracking is skipped for them. body_missing reads (above) skip tracking too.
  if (!noTrack && !archived) {
    writeBackAccessTracking([row])
  }

  // State A/C (§12): found → {status:"ok", episode:{...full}}, exit 0.
  await new Promise((resolve) => process.stdout.write(
    JSON.stringify({ status: 'ok', episode: entry }) + '\n', resolve))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// History mode: show full revision chain for an episode
// ---------------------------------------------------------------------------
if (historyId) {
  // Find all episodes in the revision chain
  let currentId = historyId

  // The walk sees index rows PLUS archived metadata (collectChainEntries): em-prune and
  // em-consolidate --fold-superseded move an episode's file to archived/ and its row to
  // archived-index.jsonl, so a chain with archived members would otherwise silently truncate
  // (runtime-probed: archiving one intermediate cut a 4-link chain to 2 from the terminal and 1
  // from the root). Live rows win on id collision; archived rows are marked `archived: true` in
  // the output and their bodies resolve from archived/.
  const allEntries = collectChainEntries(allLiveResults, seen)
  const byId = new Map(allEntries.map(e => [e.id, e]))

  // Walk backward via the scalar `supersedes` edge, collecting the SPINE
  // [requested id ... root] as we go (#634b anchor fix). The requested id is
  // ALWAYS spine[0], so it is guaranteed present in its own history — previously
  // only `root` was kept and the forward walk resumed FROM root, so a supersedes
  // FORK between root and the requested id could walk past it entirely (§17-E:
  // `bySupersedes` below is last-writer-wins by Map insertion order, so the
  // fork's OTHER branch could be the one forward-from-root actually surfaced,
  // silently dropping the requested id from its own --history output).
  const spine = []
  const spineVisited = new Set()
  let node = byId.get(currentId)
  while (node) {
    if (spineVisited.has(node.id)) break // cyclic supersedes: truncate, do not loop forever
    spineVisited.add(node.id)
    spine.push(node)
    if (!node.supersedes) break
    const parent = byId.get(node.supersedes)
    if (!parent) break
    node = parent
  }

  let chain = []
  if (spine.length) {
    chain = [...spine].reverse() // root -> requested

    // Walk forward from the REQUESTED id (not root — the anchor fix above) along
    // the many-to-one edges R9 (P4) will write (REQ-14):
    //   1. inverted supersedes (existing behavior — kept first so single-supersedes chains are
    //      byte-identical),
    //   2. the scalar superseded_by edge,
    //   3. a consolidates successor (an active episode whose consolidates array names current).
    // The requested id is now the walk's anchor: §17-E fork loss is FIXED at the anchor spine
    // (querying any spine member is guaranteed to see itself in its own history). Fork selection
    // BEYOND the anchor (what supersedes/succeeds a node forward of the requested id) is
    // UNCHANGED — still last-writer-wins by Map insertion order, characterized not fixed,
    // tiebreak-by-id deferred (relates #621).
    //
    // The visited Set is seeded with the ENTIRE spine, not just root (audit F1): seeding only
    // root left every OTHER spine member free to be re-discovered and re-pushed by the forward
    // walk (a contradictory/cyclic superseded_by or consolidates edge pointing back into the
    // spine would duplicate it in `chain`); seeding the whole spine also bounds a cyclic fixture
    // to a single pass (EC7).
    const bySupersedes = new Map()
    const byConsolidates = new Map()
    for (const e of allEntries) {
      if (e.supersedes) bySupersedes.set(e.supersedes, e)
      if (Array.isArray(e.consolidates)) {
        for (const cid of e.consolidates) byConsolidates.set(cid, e)
      }
    }
    const visited = new Set(spine.map(e => e.id))
    let current = spine[0] // the requested episode
    while (true) {
      let next = null
      if (bySupersedes.has(current.id)) next = bySupersedes.get(current.id)
      else if (current.superseded_by && byId.has(current.superseded_by)) next = byId.get(current.superseded_by)
      else if (byConsolidates.has(current.id)) next = byConsolidates.get(current.id)
      if (!next || visited.has(next.id)) break
      visited.add(next.id)
      chain.push(next)
      current = next
    }
  }

  // Include full body if requested (archived members read from archived/).
  // #666 S2 :452: readBodyOrSkip replaces existsSync+readFileSync — a
  // FIFO-shaped member skips+warns (F5) instead of hanging the whole walk.
  const historyWarnings = []
  const output = chain.map(e => {
    const { _dataDir, _archived, ...rest } = e
    const row = _archived ? { ...rest, archived: true } : rest
    if (full) {
      const filePath = path.join(_dataDir, _archived ? 'archived' : 'episodes', `${e.id}.md`)
      const bodyRead = readBodyOrSkip(fs, filePath)
      if (bodyRead.ok) {
        const parts = bodyRead.raw.split('---')
        const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
        return { ...row, body }
      }
      noteBodySkip(historyWarnings, e.id, bodyRead.code)
    }
    return row
  })

  // No access tracking for history queries (investigative, not usage signals)
  // Drain stdout BEFORE exiting: a --full chain can exceed the 64KB pipe
  // buffer, and process.exit() discards unflushed writes — piped consumers
  // (em-console, execFile callers) received exactly 65536 truncated bytes.
  await new Promise((resolve) => process.stdout.write(
    JSON.stringify({
      status: 'ok', count: output.length, chain: output,
      ...(historyWarnings.length ? { warning: historyWarnings.join(' | ') } : {}),
    }) + '\n', resolve))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Apply filters
// ---------------------------------------------------------------------------
if (!includeSuperseded) {
  results = results.filter(e => e.status !== 'superseded')
}
if (project) {
  results = results.filter(e => e.project === project)
}
let searchWarning = null
// #666 S2 :583/:621/:712: per-row body-read skip warnings for the scoring +
// --full output sites below, joined into the final `warnings` array (F5).
const searchBodyWarnings = []
if (tag) {
  const normalizedTag = normalizeTags(tag)[0]
  if (normalizedTag) {
    // Try tags.json from all active scopes
    let tagIds = null
    const dirs = []
    if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
    if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
    for (const dir of dirs) {
      const idx = loadTagsIndex(dir)
      if (idx && idx[normalizedTag]) {
        if (!tagIds) tagIds = new Set()
        for (const id of idx[normalizedTag]) tagIds.add(id)
      } else if (!idx) {
        searchWarning = 'tags.json missing or corrupt. Run em-rebuild-index.mjs to regenerate.'
      }
    }
    if (tagIds) {
      results = results.filter(e => tagIds.has(e.id))
    } else {
      // Fallback: linear scan with normalized comparison
      if (!searchWarning) searchWarning = 'tags.json missing or does not contain tag. Falling back to linear scan. Run em-rebuild-index.mjs to regenerate.'
      results = results.filter(e => e.tags && e.tags.map(t => t.toLowerCase().trim()).includes(normalizedTag))
    }
  }
}
if (category) {
  // Index-backed (R10d), symmetric with --tag: canonicalize the query, read category-index.json
  // from each active scope, intersect ids. Missing/corrupt index → linear-scan fallback + a
  // rebuild warning. An active-name query returns the same set as the old exact-match filter.
  const canonical = canonicalCategory(category)
  let catIds = null
  const dirs = []
  if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
  if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
  for (const dir of dirs) {
    const idx = loadCategoryIndex(dir)
    if (idx && Object.prototype.hasOwnProperty.call(idx, canonical)) {
      if (!catIds) catIds = new Set()
      for (const id of idx[canonical]) catIds.add(id)
    } else if (!idx) {
      if (!searchWarning) searchWarning = 'category-index.json missing or corrupt. Falling back to linear scan. Run em-rebuild-index.mjs to regenerate.'
    }
  }
  if (catIds) {
    results = results.filter(e => catIds.has(e.id))
  } else {
    // Fallback: linear scan. Canonicalize stored categories too so a deprecated-alias query
    // still matches; for an active name with no aliases this is exactly the old e.category === c.
    results = results.filter(e => e.category === category || canonicalCategory(e.category) === canonical)
  }
}
if (since) {
  results = results.filter(e => e.date >= since)
}

// Full-text search: tiered matcher from lib/relevance.mjs. Contiguous
// summary/body substring matches keep their pre-lib scores (1.0/0.7/0.4);
// multi-term queries additionally match when every token lands somewhere in
// summary/tags/body, scored by discounted field weights.
//
// Acceleration: tokens.json (when present in every active scope) prunes the
// candidate set first — key-containment lookups reproduce the substring
// semantics exactly, so only true candidates get scored and bodies are read
// only for that handful instead of for every episode in the store. Missing
// tokens.json degrades to the full scan with a rebuild hint.
//
// Partial tier: when the strict AND tiers leave the limit unfilled, episodes
// matching at least half the query tokens fill the remainder (capped at
// text_match 0.35 — below the weakest full match), marked "match":"partial".
if (query) {
  const qtokens = tokenizeQuery(query)
  let candidateInfo = null
  if (qtokens.length > 0) {
    const dirs = []
    if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
    if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)
    const presentDirs = dirs.filter(d => fs.existsSync(path.join(d, 'index.jsonl')))
    const idxs = presentDirs.map(d => loadTokensIndex(d))
    if (idxs.length > 0 && idxs.every(Boolean)) {
      candidateInfo = tokenCandidates(idxs, qtokens)
    } else if (results.length > 0) {
      if (!searchWarning) searchWarning = 'tokens.json missing in one or more stores — full-scan search. Run em-rebuild-index.mjs to build the token index.'
    }
  }

  // Episodes the token index has never seen (hand-written rows, stores
  // predating tokens.json) bypass pruning and take the full-scoring path —
  // index gaps degrade to a slower search, never to hidden episodes.
  //
  // Dropped-token semantics (S2 diet): a query token recorded under
  // "_dropped" is common-by-df, not absent — its posting list was removed on
  // purpose. tokenCandidates already excludes dropped tokens from the AND
  // intersection (they are non-pruning), and returns all === null when NO
  // token can prune, in which case the query full-scans. Either way the
  // final scoring below is the same scoreTextMatch a scan would run, so
  // results stay byte-identical to the pre-diet index.
  const pool = candidateInfo && candidateInfo.all !== null
    ? results.filter(e => candidateInfo.all.has(e.id) || !candidateInfo.covered.has(e.id))
    : results
  const matched = pool.filter(e => {
    // #666 S2 :583: readBodyOrSkip replaces the swallowing try/catch —
    // scoreTextMatch's readBody contract (string|null) is unchanged, so this
    // is transparent to lib/relevance.mjs; a non-ENOENT skip now warns (F5).
    const readBody = () => {
      const filePath = path.join(e._dataDir, 'episodes', `${e.id}.md`)
      const r = readBodyOrSkip(fs, filePath)
      if (r.ok) return r.raw
      noteBodySkip(searchBodyWarnings, e.id, r.code)
      return null
    }
    const { matched: isMatch, textMatch, body } = scoreTextMatch(e, query, readBody)
    if (!isMatch) return false
    e._textMatch = textMatch
    if (full && body) e._body = body
    return true
  })

  let partials = []
  if (!noScore && qtokens.length > 1 && matched.length < limit) {
    const matchedIds = new Set(matched.map(e => e.id))
    // With the token index, body membership is known without file reads and
    // the pool narrows to episodes containing at least one token; on the
    // fallback path, partials come from summary/tags only (no O(n) body reads).
    //
    // Dropped tokens (S2 diet) have no posting lists, so perToken cannot
    // answer body membership for them — inBody falls back to reading the
    // episode body (cached per episode). The pool, however, stays ANCHORED to
    // the non-dropped tokens' postings (`any` ∪ uncovered): widening to every
    // row whenever one token was dropped re-created the O(n) full-store body
    // scan the index exists to avoid (review finding, confirmed on the
    // 1811-episode store). Only when EVERY query token is dropped
    // (candidateInfo.all === null) is a full scan inherent — same as the
    // strict tier above. Cost of the bound: an episode whose ONLY hit is a
    // common (dropped) token no longer surfaces as a partial when a rare
    // anchor exists; that class scores ≤ ~0.1 (coverage 0.5 × body weight)
    // and sat below every real match.
    const allDropped = candidateInfo && candidateInfo.all === null
    const partialPool = (candidateInfo && !allDropped
      ? results.filter(e => candidateInfo.any.has(e.id) || !candidateInfo.covered.has(e.id))
      : results)
      .filter(e => !matchedIds.has(e.id))
    for (const e of partialPool) {
      let bodyLower // lazy, read at most once per episode
      // #666 S2 :621: readBodyOrSkip replaces the swallowing try/catch.
      const readBodyLower = () => {
        if (bodyLower === undefined) {
          const r = readBodyOrSkip(fs, path.join(e._dataDir, 'episodes', `${e.id}.md`))
          if (r.ok) {
            bodyLower = r.raw.toLowerCase()
          } else {
            noteBodySkip(searchBodyWarnings, e.id, r.code)
            bodyLower = null
          }
        }
        return bodyLower
      }
      const inBody = candidateInfo
        ? (tok => {
            if (candidateInfo.perToken.get(tok)?.has(e.id)) return true
            if (!candidateInfo.dropped.has(tok)) return false
            const b = readBodyLower()
            return b ? b.includes(tok) : false
          })
        : (() => false)
      const { matched: isPartial, textMatch } = scorePartialMatch(e, qtokens, inBody)
      if (isPartial) {
        e._textMatch = textMatch
        e._partial = true
        partials.push(e)
      }
    }
  }

  results = [...matched, ...partials]
}

// ---------------------------------------------------------------------------
// --materialize (filter-anchored, #634a): only reached when --read was not
// given (the --read branch above already exited). Requires the PRE-`--limit`
// filtered result set to have EXACTLY ONE member (audit F3) — `--limit` masks
// multiplicity (the real store's 2-tombstone-plus-terminal case is exactly why
// the D3 loader fallback is a two-step: resolve-id-then-materialize, not a
// single filtered read), so this check runs BEFORE the `--limit` slice below
// ever narrows `results`. A count other than 1 (0 or many) is reported the
// same way — the caller re-runs with an explicit id via --read.
// ---------------------------------------------------------------------------
if (materialize) {
  if (results.length !== 1) {
    const matches = results.map(e => ({ id: e.id, summary: e.summary }))
    const out = JSON.stringify({ status: 'error', code: 'materialize-ambiguous', matches })
    await new Promise((resolve) => process.stdout.write(out + '\n', resolve))
    process.exit(1)
  }
  const out = materializeChain(results[0])
  await new Promise((resolve) => process.stdout.write(JSON.stringify(out) + '\n', resolve))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Score and sort
// ---------------------------------------------------------------------------
if (!noScore) {
  for (const e of results) {
    const textMatch = e._textMatch || 1.0
    e._score = computeScore(e, textMatch)
  }
  results.sort((a, b) => b._score - a._score)
} else {
  // No scoring — keep date-based sort, tolerant of foreign-harness index rows
  // (hand-appended without em-store): only string-typed fields participate. A
  // non-string date would either crash (NaN.localeCompare) or, stringified,
  // out-sort ISO keys ("20260703" > "2026-07-04..."); time joins only when
  // date is a string so a time-only key cannot beat ISO date keys. Rows
  // without a string date get key '' and sort last in descending order.
  const dtKey = e => typeof e.date === 'string' ? e.date + (typeof e.time === 'string' ? e.time : '') : ''
  results.sort((a, b) => dtKey(b).localeCompare(dtKey(a)))
}

// Apply limit AFTER scoring/sorting
results = results.slice(0, limit)

// ---------------------------------------------------------------------------
// Access tracking write-back
// Skip for: --no-track, --include-superseded (investigative queries)
// ---------------------------------------------------------------------------
if (!noTrack && !includeSuperseded) {
  writeBackAccessTracking(results)
}

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------
const output = results.map(e => {
  const { _dataDir, _source, _textMatch, _score, _body, _partial, ...rest } = e
  const entry = { ...rest, source: _source }
  if (_partial) entry.match = 'partial'
  if (!noScore && _score !== undefined) {
    entry.score = Math.round(_score * 1000) / 1000
  }
  if (full) {
    // #666 S2 :712: readBodyOrSkip replaces the swallowing try/catch — a
    // non-ENOENT skip warns (F5); ENOENT stays silent (row emitted without
    // a body field, exactly as an absent file did before).
    const content = _body || (() => {
      const filePath = path.join(_dataDir, 'episodes', `${e.id}.md`)
      const r = readBodyOrSkip(fs, filePath)
      if (r.ok) return r.raw
      noteBodySkip(searchBodyWarnings, e.id, r.code)
      return null
    })()
    if (content) {
      const parts = content.split('---')
      const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
      entry.body = body
    }
  }
  return entry
})

const result = { status: 'ok', count: output.length, episodes: output }

// Performance health check
const elapsed = Date.now() - searchStart
const warnings = []
if (searchWarning) warnings.push(searchWarning)
for (const w of searchBodyWarnings) warnings.push(w)
if (elapsed > warnTimeMs) {
  warnings.push(`Search took ${elapsed}ms across ${totalEpisodeCount} episodes. Consider running em-prune.mjs to archive stale episodes.`)
}
if (totalEpisodeCount > warnCount) {
  warnings.push(`${totalEpisodeCount} episodes in index. Performance may degrade. Run em-prune.mjs --dry-run to check for prunable episodes.`)
}
if (warnings.length) result.warning = warnings.join(' | ')

console.log(JSON.stringify(result))
