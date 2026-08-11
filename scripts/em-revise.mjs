#!/usr/bin/env node
/**
 * em-revise.mjs — Revise/supersede an existing decision.
 *
 * Usage:
 *   node em-revise.mjs --original <id> --project <name>
 *                      (--tags <t1,t2> | --tag <t1> --tag <t2> | both)
 *                      --summary <text> (--body <text> | --body-file <path|->)
 *                      [--scope inherit|local|global]
 *
 * Tag forms accepted (merged + deduplicated; mirrors em-store):
 *   --tags a,b,c       --tag a --tag b       --tags a,b --tag c
 *
 * --scope defaults to "inherit" (write the revision to the same store as the
 * original). Pass "local" or "global" only to force a cross-scope revision.
 *
 * `--body-file` reads body content from a file (UTF-8, BOM stripped, exactly
 * one trailing newline stripped), or from stdin when the path is `-`. Mutually
 * exclusive with `--body`. Prefer it over inline `--body` for bodies with
 * backticks / `$(...)` / `$VAR` (the shell corrupts those inside --body "…"
 * before this script runs); safe form: `--body-file - <<'EOF' … EOF`.
 *
 * Creates a new episode that supersedes the original. Marks the original
 * episode as superseded in both its file and the index.
 * Outputs JSON: { status, id, file, supersedes, scope }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { readBodyFile } from './lib/body-file.mjs'
import { validateCategory, canonicalCategory } from './lib/categories.mjs'
import { validateActivation, serializeInlineArray, loadMergedIndex, resolveLinkage, ACTIVATION_ARRAY_FIELDS, parseActivationFromFrontmatter, illegalScalarChar } from './lib/activation.mjs'
import { loadMergedTriggerIndex } from './em-trigger-index.mjs'
import { episodeTokens, updateTokensIndex, nullProtoIndex } from './lib/relevance.mjs'
import { canonicalizePromotionSources, serializePromotionSources, validatePromotionSources } from './lib/promotion-sources.mjs'
import { acquireStoreWriteLocksSync, releaseStoreWriteLocks, atomicReplaceFileSync } from './lib/store-write-lock.mjs'
import { assertReadableIndex, openReadableIndex, IndexUnreadableError, unreadableMessage, roleForFile, readBodyOrSkip, openReadableBody, BodyUnreadableError } from './lib/index-state.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-revise.mjs', usage: 'node em-revise.mjs --original <id> --project <name> [--tags <t1,t2>] [--tag <t>]... --summary <text> (--body <text> | --body-file <path|->) [--scope inherit|local|global] [--pin] [--playbook] [--no-playbook] [--register-playbook [session_start|on_demand]] [--promotion-sources-json <json> (lesson only)] [lesson-only activation: --trigger <phrase|tool:T:glob|activity:class>]... [--applies-to-project <slug|*>]... [--applies-to-tool <id>]... [--priority <1-7>] [--review-by <YYYY-MM-DD>] [--evidence <violation-id>]...  (--body-file - reads stdin; prefer it over inline --body for bodies with backticks/$()/$VAR, which the shell corrupts before this script runs — safe form: --body-file - <<\'EOF\' … EOF)' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

// flagAll(name) — collect every value of a repeated flag. Mirrors em-store's
// helper; lets users pass `--tag a --tag b` in addition to `--tags a,b`.
// Skips a position whose value starts with `--` (next flag, not a tag value).
function flagAll(name) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) {
      const val = argv[i + 1]
      if (val.startsWith('--')) continue
      out.push(val)
      i++
    }
  }
  return out
}

const originalId = flag('--original')
const project = flag('--project')
const tagsRaw = flag('--tags')
const tagRepeats = flagAll('--tag')
const summary = flag('--summary')
const bodyArg = flag('--body')
const bodyFile = flag('--body-file')
const scope = flag('--scope') || 'inherit'
// RFC-009 R1 activation flags (lesson-only; validated against the INHERITED
// category below, before the supersede mutation, via lib/activation.mjs)
const triggers = flagAll('--trigger')
const appliesToProjects = flagAll('--applies-to-project')
const appliesToTools = flagAll('--applies-to-tool')
const priorityFlag = flag('--priority')
const reviewBy = flag('--review-by')
const evidence = flagAll('--evidence')
const promotionSourcesJson = flag('--promotion-sources-json')

// RFC-015 P1-S1: marker + registration flag (revise-side parity with em-store).
// The marker is INHERITED from the original episode unless --no-playbook
// clears it; --playbook sets it on the revision; --register-playbook upserts
// the entry into the CURRENT project's local playbooks.json. Contradictions
// fire BEFORE any write (§12 validate-then-write); scope refusal defers
// until dataDir is resolved (depends on --scope inheritance).
const hasPlaybookFlag = argv.includes('--playbook')
const hasNoPlaybookFlag = argv.includes('--no-playbook')
const hasRegisterPlaybookFlag = argv.includes('--register-playbook')
if (hasPlaybookFlag && hasNoPlaybookFlag) {
  console.log(JSON.stringify({
    status: 'error',
    message: '--playbook and --no-playbook are contradictory; pass only one.',
  }))
  process.exit(1)
}
if (hasRegisterPlaybookFlag && hasNoPlaybookFlag) {
  console.log(JSON.stringify({
    status: 'error',
    message: '--register-playbook and --no-playbook are contradictory; pass only one.',
  }))
  process.exit(1)
}
let registerMode = null
if (hasRegisterPlaybookFlag) {
  const i = argv.indexOf('--register-playbook')
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) {
    registerMode = 'session_start'
  } else if (next === 'session_start' || next === 'on_demand') {
    registerMode = next
  } else {
    console.log(JSON.stringify({
      status: 'error',
      message: `--register-playbook mode must be session_start or on_demand (got "${next}")`,
    }))
    process.exit(1)
  }
}

const VALID_SCOPES_REVISE = ['inherit', 'local', 'global']
if (!VALID_SCOPES_REVISE.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_REVISE.join(', ')}` }))
  process.exit(1)
}

if (bodyArg !== undefined && bodyFile !== undefined) {
  console.log(JSON.stringify({
    status: 'error',
    message: '--body and --body-file are mutually exclusive; pass only one.'
  }))
  process.exit(1)
}

let body = bodyArg
if (bodyFile !== undefined) {
  body = readBodyFile(bodyFile)
}

if (!originalId || !summary || !body) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Missing required args. Usage: --original <id> --project <name> (--tags <t1,t2> | --tag <t> [--tag <t> ...]) --summary <text> (--body <text> | --body-file <path>) [--scope inherit|local|global]'
  }))
  process.exit(1)
}

// Reviewer F1 (round 2): user-controlled serialized scalars reject line-breaking
// chars BEFORE the supersede mutation below (I4). Inherited project/tags come
// from an already-written (write-validated) episode via the `^(\w+):\s*(.*)$`
// regex, which cannot capture a newline, so only the user inputs need guarding.
for (const [label, value] of [['summary', summary], ...(project !== undefined ? [['project', project]] : [])]) {
  const bad = illegalScalarChar(value)
  if (bad !== null) {
    console.log(JSON.stringify({ status: 'error', message: `--${label} contains illegal line-breaking character ${JSON.stringify(bad)}` }))
    process.exit(1)
  }
}
for (const tag of [...(tagsRaw ? tagsRaw.split(',') : []), ...tagRepeats]) {
  const bad = illegalScalarChar(tag)
  if (bad !== null) {
    console.log(JSON.stringify({ status: 'error', message: `--tag/--tags value contains illegal line-breaking character ${JSON.stringify(bad)}` }))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Resolve data directory — find the original episode
// ---------------------------------------------------------------------------
function findEpisode(id) {
  for (const dir of [LOCAL_DIR, GLOBAL_DIR]) {
    const filePath = path.join(dir, 'episodes', `${id}.md`)
    if (fs.existsSync(filePath)) return { dir, filePath }
  }
  return null
}

const original = findEpisode(originalId)
if (!original) {
  console.log(JSON.stringify({
    status: 'error',
    message: `Original episode "${originalId}" not found in local or global stores.`
  }))
  process.exit(1)
}

// S3 (#666): shared typed-abort emitter for em-revise's two AUTHORITATIVE
// body reads (:211 preflight below, :495 in-lock supersede — see the role
// table in docs/plans/fix-666-667.md §3). Absent (openReadableBody's null
// return) gets the SAME typed abort as unreadable, built via
// `new BodyUnreadableError(path, 'ENOENT')` even though nothing threw —
// today this is a raw ENOENT crash (TOCTOU-only: findEpisode's existsSync
// already confirmed the file moments earlier), so the envelope is additive.
function abortBodyUnreadable(err) {
  console.log(JSON.stringify({ status: 'error', message: `em-revise: ${err.message}`, code: `episode-unreadable:${err.code}` }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Validate the inherited category BEFORE any write (I4 / EC6 — a rejected revise
// must leave the store byte-unchanged; the original is marked superseded just below,
// so validation has to precede that mutation, not follow the later metadata parse).
// ---------------------------------------------------------------------------
let activation = null // normalized RFC-009 activation fields (set in the block below)
let inheritedLessons = [] // violation-side forward-links, inherited verbatim (F3)
let inheritedViolatedPattern // T6 typed scalar, inherited verbatim (F3)
let promotionSources
{
  // #666 S3 :211 — AUTHORITATIVE preflight read: openReadableBody aborts
  // typed on unreadable; null (absent) aborts typed too (see helper above).
  let origRaw
  try {
    origRaw = openReadableBody(fs, original.filePath)
  } catch (e) {
    if (e instanceof BodyUnreadableError) abortBodyUnreadable(e)
    throw e
  }
  if (origRaw === null) abortBodyUnreadable(new BodyUnreadableError(original.filePath, 'ENOENT'))
  const fm = origRaw.match(/^---\n([\s\S]*?)\n---/)
  let cat = 'decision'
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m && m[1] === 'category') cat = m[2]
    }
  }
  let rv
  try {
    rv = validateCategory(cat)
  } catch (e) {
    // vocab unloadable at a WRITE surface → fail CLOSED (§12 state E)
    console.log(JSON.stringify({ status: 'error', message: e.message }))
    process.exit(1)
  }
  if (!rv.ok) {
    const message = rv.reason === 'deprecated'
      ? `Inherited category "${cat}" is deprecated; use "${rv.successor}"`
      : `Inherited category "${cat}" is not in the vocabulary`
    console.log(JSON.stringify({ status: 'error', message }))
    process.exit(1)
  }

  // RFC-009 R1 + reviewer F3: activation, linkage, and the T6 typed field are
  // INHERITED from the original (tags already inherit — silent activation loss
  // on a typo-revision demoted lessons to freeform and dropped violation band
  // links). A flag passed on the revise OVERRIDES that field; absent flags keep
  // the original's values. Validation runs on the MERGED result against the
  // inherited category, BEFORE the supersede mutation below (I4).
  let inherited
  try { inherited = parseActivationFromFrontmatter(origRaw) } catch {
    console.log(JSON.stringify({ status: 'error', error: 'structured-frontmatter-invalid', field: 'promotion_sources', id: originalId }))
    process.exit(1)
  }
  inheritedLessons = Array.isArray(inherited.lessons) ? inherited.lessons : []
  inheritedViolatedPattern = inherited.violated_pattern
  const merged = {
    ...(triggers.length ? { triggers } : (inherited.triggers ? { triggers: inherited.triggers } : {})),
    ...(appliesToProjects.length ? { applies_to_projects: appliesToProjects } : (inherited.applies_to_projects ? { applies_to_projects: inherited.applies_to_projects } : {})),
    ...(appliesToTools.length ? { applies_to_tools: appliesToTools } : (inherited.applies_to_tools ? { applies_to_tools: inherited.applies_to_tools } : {})),
    ...(evidence.length ? { evidence } : (inherited.evidence ? { evidence: inherited.evidence } : {})),
    ...(priorityFlag !== undefined ? { priority: Number(priorityFlag) } : (inherited.priority !== undefined ? { priority: inherited.priority } : {})),
    ...(reviewBy !== undefined ? { review_by: reviewBy } : (inherited.review_by !== undefined ? { review_by: inherited.review_by } : {})),
  }
  const av = validateActivation(merged, { category: cat })
  if (!av.ok) {
    console.log(JSON.stringify({ status: 'error', errors: av.errors, message: av.errors.map(e => e.message).join('; ') }))
    process.exit(1)
  }
  activation = av.fields // null when neither flags nor the original carry activation

  let sourceValue = inherited.promotion_sources
  if (promotionSourcesJson !== undefined) {
    try { sourceValue = JSON.parse(promotionSourcesJson) } catch {
      console.log(JSON.stringify({ status: 'error', error: 'promotion-sources-shape' }))
      process.exit(1)
    }
  }
  if (sourceValue !== undefined) {
    if (cat !== 'lesson') {
      console.log(JSON.stringify({ status: 'error', error: 'lesson-only' }))
      process.exit(1)
    }
    const pv = validatePromotionSources(sourceValue)
    if (!pv.ok) {
      console.log(JSON.stringify({ status: 'error', error: pv.error, ...(pv.index !== undefined ? { index: pv.index } : {}) }))
      process.exit(1)
    }
    promotionSources = canonicalizePromotionSources(sourceValue)
  }

  // REQ-6 (revise-side parity): merged-index resolution, never per-active-scope
  // (F1). Only NEWLY passed --evidence re-validates — inherited links carry
  // verbatim (a linked violation may have been legitimately retracted since;
  // the band derivation, not the write gate, is what discounts it).
  if (evidence.length) {
    // FIX-A (#649/#653 review P1-1): loadMergedIndex throws IndexUnreadableError
    // on an unreadable (not absent) store index; this runs BEFORE any write.
    let mergedIndex
    try {
      mergedIndex = loadMergedIndex()
    } catch (e) {
      if (e instanceof IndexUnreadableError) {
        console.log(JSON.stringify({ status: 'error', message: unreadableMessage('em-revise', 'episode index', e), code: `index-unreadable:${e.code}` }))
        process.exit(1)
      }
      throw e
    }
    const lv = resolveLinkage(evidence, { requireCategory: 'violation', index: mergedIndex })
    if (!lv.ok) {
      console.log(JSON.stringify({
        status: 'error',
        message: `--evidence must name existing violation episodes; missing: [${lv.missing.join(', ')}] wrong-category: [${lv.wrongCategory.join(', ')}]`,
        missing: lv.missing, wrong_category: lv.wrongCategory
      }))
      process.exit(1)
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve BOTH store directories BEFORE ordered lock acquisition (issue 546 /
// REQ-5): the original's store (supersession target) and the revision's store
// (successor target). Cross-scope revisions lock both stores in canonical
// order; a same-store revision dedupes to a single lock.
// ---------------------------------------------------------------------------
const dataDir = scope === 'inherit'
  ? original.dir
  : (scope === 'global' ? GLOBAL_DIR : LOCAL_DIR)
const episodesDir = path.join(dataDir, 'episodes')
const indexFile = path.join(dataDir, 'index.jsonl')

// F4 (review r1): --register-playbook requires a local-scope target (B-3).
// Refuse BEFORE any lock / write so a global-target revision never lands.
// The dataDir above is already resolved (scope inheritance done), so the
// check is unconditional. Exits 1, no revision written — no stored_id
// (that asymmetry is correct: a pre-write refusal has nothing to point at).
if (hasRegisterPlaybookFlag && dataDir === GLOBAL_DIR) {
  console.log(JSON.stringify({
    status: 'error',
    code: 'playbooks-scope',
    message: '--register-playbook requires a local-scope store (B-3); registration is per-project.',
  }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// #653 S3R: classify index.jsonl AND every derived sidecar (tags/category/
// tokens) for BOTH store dirs this revision touches — original.dir (the
// supersession target) and dataDir (the successor target; may be the same
// dir) — BEFORE any read, lock, or write. Mirrors em-store's S3(a) preflight;
// placed strictly before the pre-lock snapshot below (which itself reads
// index.jsonl) and before acquireStoreWriteLocksSync.
// ---------------------------------------------------------------------------
const preflightDirs = original.dir === dataDir ? [original.dir] : [original.dir, dataDir]
for (const dir of preflightDirs) {
  for (const [role, file] of [
    ['episode index', path.join(dir, 'index.jsonl')],
    ['tags index', path.join(dir, 'tags.json')],
    ['category index', path.join(dir, 'category-index.json')],
    ['token index', path.join(dir, 'tokens.json')],
  ]) {
    try {
      assertReadableIndex(fs, file)
    } catch (e) {
      if (e instanceof IndexUnreadableError) {
        console.log(JSON.stringify({ status: 'error', message: unreadableMessage('em-revise', role, e), code: `index-unreadable:${e.code}` }))
        process.exit(1)
      }
      throw e
    }
  }
}

// ---------------------------------------------------------------------------
// PR-562 snapshot helper (§8.2 in-lock reread, file/index coherence, and the
// direct-successor set): captures (fileStatus, indexStatus, successors) so
// the in-lock state can be compared to the pre-lock snapshot. A change in
// any field between the two reads indicates a concurrent writer mutated the
// original between snapshot and lock acquisition, which fails the
// transaction. This lets a stable superseded original be revised (the
// accepted clerk merge-Revive path) while still serializing an actually
// concurrent revision. The helper tolerates missing files and missing index
// rows (status=null in both cases) so the snapshot shape is stable.
//
// fileStatus reads the episode BODY file — out of #653 scope (§4 D2 DEFER,
// the query-path body-read class); indexStatus/successors read index.jsonl
// and use the fd-based openReadableIndex (#653), which THROWS
// IndexUnreadableError on a defect instead of existsSync's silent
// false-negative (which would misreport "no index row" instead of aborting).
// ---------------------------------------------------------------------------
function snapshotOriginalState(filePath, statusDir, successorDirs, id) {
  let fileStatus = null
  // #666 S3 :387 — ADVISORY TOCTOU snapshot: readBodyOrSkip never throws, so
  // ANY unreadable/absent shape degrades to fileStatus=null exactly like the
  // old catch-all did. NO abort here — a FIFO original cannot reach a write
  // through this path: :211 above gates before it, :495 below gates after.
  const bodyRead = readBodyOrSkip(fs, filePath)
  if (bodyRead.ok) {
    const m = bodyRead.raw.match(/^status:\s*(\S+)$/m)
    if (m) fileStatus = m[1]
  }
  let indexStatus = null
  const statusIndexPath = path.join(statusDir, 'index.jsonl')
  const statusIndexRaw = openReadableIndex(fs, statusIndexPath)
  if (statusIndexRaw !== null) {
    for (const line of statusIndexRaw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry && entry.id === id) indexStatus = entry.status || null
      } catch { /* tolerate a malformed index line */ }
    }
  }
  const successors = []
  for (const storeDir of successorDirs) {
    const indexFilePath = path.join(storeDir, 'index.jsonl')
    const raw = openReadableIndex(fs, indexFilePath)
    if (raw === null) continue
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry && entry.id !== id && entry.supersedes === id) successors.push(entry.id)
      } catch { /* tolerate a malformed index line */ }
    }
  }
  successors.sort()
  return { fileStatus, indexStatus, successors: [...new Set(successors)] }
}

// Pre-lock snapshot (before acquireStoreWriteLocksSync). findEpisode already
// confirmed the file exists; the snapshot captures the mutable triple so
// the in-lock check below can prove no concurrent writer raced ahead. The
// direct-successor set is unioned across both locked stores
// ([original.dir, dataDir]) so a cross-scope revision detects a successor
// appended in either the original's store or the successor's store.
// No lock is held yet, so a TOCTOU-raced IndexUnreadableError here (the
// preflight above already passed) gets its own catch rather than the F6
// in-lock mechanism below.
let preLock
try {
  preLock = snapshotOriginalState(original.filePath, original.dir, [original.dir, dataDir], originalId)
} catch (e) {
  if (e instanceof IndexUnreadableError) {
    console.log(JSON.stringify({ status: 'error', message: `em-revise: ${e.message}`, code: `index-unreadable:${e.code}` }))
    process.exit(1)
  }
  throw e
}

const lockResult = acquireStoreWriteLocksSync([original.dir, dataDir])
if (!lockResult.ok) {
  console.log(JSON.stringify({ status: 'error', code: lockResult.code, heldBy: lockResult.heldBy }))
  process.exit(1)
}
const lockHandles = lockResult.handles

// Final payload + revision id. Emitted ONLY after the locks are released:
// no process.exit while a lock is held, and the collision report runs
// post-release (revise-side parity with em-store).
let result
let newId
try {
  // ---------------------------------------------------------------------------
  // In-lock reread (§8.2): re-snapshot under the lock and compare to the
  // pre-lock snapshot. A difference in any field means a concurrent writer
  // mutated the original between snapshot and lock acquisition, which fails
  // the transaction with stale-original and zero writes.
  //
  // Coherence guards (§8.2 in-lock reread + reviewer F1): the original's
  // file status and index-row status must agree AND the index row must
  // exist. A missing index row is a known-bad anchor (no provenance for the
  // supersession) and is rejected even when the snapshot is stable. A
  // stable superseded original (file: superseded, index: superseded) passes
  // both guards and is revivable — the accepted clerk merge-Revive path.
  // ---------------------------------------------------------------------------
  const originalIndexFile = path.join(original.dir, 'index.jsonl')
  const inLock = snapshotOriginalState(original.filePath, original.dir, [original.dir, dataDir], originalId)

  const snapshotStable =
    preLock.fileStatus === inLock.fileStatus &&
    preLock.indexStatus === inLock.indexStatus &&
    preLock.successors.length === inLock.successors.length &&
    preLock.successors.every((id, i) => id === inLock.successors[i])
  const indexRowPresent = inLock.indexStatus !== null
  const fileAndIndexAgree =
    inLock.fileStatus !== null &&
    inLock.indexStatus !== null &&
    inLock.fileStatus === inLock.indexStatus

  if (!snapshotStable || !indexRowPresent || !fileAndIndexAgree) {
    const reasons = []
    if (!snapshotStable) reasons.push(`snapshot drift (pre file=${preLock.fileStatus}/idx=${preLock.indexStatus}/succ=${preLock.successors.join(',')} -> in-lock file=${inLock.fileStatus}/idx=${inLock.indexStatus}/succ=${inLock.successors.join(',')})`)
    if (!indexRowPresent) reasons.push('index row status: missing')
    if (!fileAndIndexAgree) reasons.push(`file/index incoherent (file=${inLock.fileStatus}, index=${inLock.indexStatus})`)
    result = {
      status: 'error',
      code: 'stale-original',
      message: `Original episode "${originalId}" is stale (${reasons.join('; ')}); no revision written.`
    }
  } else {

  // ---------------------------------------------------------------------------
  // Mark original as superseded
  // ---------------------------------------------------------------------------
  // #666 S3 :495 — AUTHORITATIVE in-lock read: openReadableBody throws
  // BodyUnreadableError OUT of this locked try on unreadable, straight into
  // the catch below (mirrors every openReadableIndex call in this same try —
  // F6 discipline). null (absent) is thrown explicitly here so it reaches
  // the SAME typed-abort branch as :211 above.
  const currentOriginalContent = openReadableBody(fs, original.filePath)
  if (currentOriginalContent === null) throw new BodyUnreadableError(original.filePath, 'ENOENT')
  const supersededContent = currentOriginalContent.replace(/^status: active$/m, 'status: superseded')
  atomicReplaceFileSync(original.filePath, supersededContent)

  // Update the index entry for the original + capture origTags in one pass
  // #653 S3R: fd-based read (openReadableIndex) — a TOCTOU throw propagates
  // out of this locked try (F6) instead of a raw readFileSync crash.
  let origTagsFromIndex = []
  let origPinned = false
  let origPlaybook = false
  const lines = (openReadableIndex(fs, originalIndexFile) || '').trim().split('\n').filter(Boolean)
  const updated = lines.map(line => {
    try {
      const entry = JSON.parse(line)
      if (entry.id === originalId) {
        if (Array.isArray(entry.tags)) origTagsFromIndex = entry.tags
        if (entry.pinned === true) origPinned = true
        if (entry.playbook === true) origPlaybook = true
        entry.status = 'superseded'
        return JSON.stringify(entry)
      }
      return line
    } catch { return line }
  })
  // Collision-safe atomic replacement (issue 546 / REQ-10)
  atomicReplaceFileSync(originalIndexFile, updated.join('\n') + '\n')

  // ---------------------------------------------------------------------------
  // Extract original's metadata for inheritance
  // ---------------------------------------------------------------------------
  const origFmMatch = currentOriginalContent.match(/^---\n([\s\S]*?)\n---/)
  let origProject = project
  let origCategory = 'decision'
  if (origFmMatch) {
    const fmLines = origFmMatch[1].split('\n')
    for (const line of fmLines) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (!m) continue
      if (m[1] === 'project' && !project) origProject = m[2]
      if (m[1] === 'category') origCategory = m[2]
    }
  }

  // ---------------------------------------------------------------------------
  // Create the revision episode in the revision's store
  // ---------------------------------------------------------------------------
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const timeStr = now.toISOString().slice(11, 16)
  const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
  const slug = summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const randSuffix = crypto.randomBytes(2).toString('hex')
  const id = `${ts}-${slug}-${randSuffix}`

  function normalizeTags(raw, repeats = []) {
    let fromRaw = []
    if (Array.isArray(raw)) {
      fromRaw = raw
    } else if (raw) {
      fromRaw = raw.split(',')
    }
    const all = [...fromRaw, ...repeats]
      .map(t => t.trim().toLowerCase())
      .filter(Boolean)
    return [...new Set(all)].sort()
  }

  function updateTagsIndex(dataDir, episodeId, tags) {
    const tagsFile = path.join(dataDir, 'tags.json')
    // Null-proto: a tag named "constructor" must not resolve to Object.prototype (issue #469)
    // #653 S3R: fd-based read; a TOCTOU throw propagates out of this locked
    // try (F6) instead of being swallowed. Malformed CONTENT still degrades.
    let index = Object.create(null)
    const raw = openReadableIndex(fs, tagsFile)
    if (raw !== null) {
      try { index = nullProtoIndex(JSON.parse(raw)) } catch {}
    }
    for (const tag of tags) {
      if (!index[tag]) index[tag] = []
      if (!index[tag].includes(episodeId)) index[tag].push(episodeId)
    }
    atomicReplaceFileSync(tagsFile, JSON.stringify(index, null, 2))
  }

  // Mirror em-store's category-index maintenance (RFC-009 R10d); duplicated locally the same
  // way updateTagsIndex is, rather than imported from em-store (which runs top-level on import).
  function updateCategoryIndex(dataDir, episodeId, category) {
    const catFile = path.join(dataDir, 'category-index.json')
    // Null-proto: unknown categories index under their literal key, which could
    // collide with Object.prototype names (issue #469)
    // #653 S3R: fd-based read; a TOCTOU throw propagates (F6) instead of
    // being swallowed. Malformed CONTENT still degrades.
    let index = Object.create(null)
    const raw = openReadableIndex(fs, catFile)
    if (raw !== null) {
      try { index = nullProtoIndex(JSON.parse(raw)) } catch {}
    }
    const key = canonicalCategory(category)
    if (!index[key]) index[key] = []
    if (!index[key].includes(episodeId)) index[key].push(episodeId)
    atomicReplaceFileSync(catFile, JSON.stringify(index, null, 2))
  }

  const tags = normalizeTags(tagsRaw, tagRepeats)
  const resolvedProject = origProject || path.basename(process.cwd())

  // Inherit original episode's tags (captured during first index pass above)
  const mergedTags = normalizeTags([...origTagsFromIndex, ...tags])

  // Pinning survives revision: a corrected pinned decision is still a pinned
  // decision. --pin additionally pins an unpinned chain at revision time.
  const pinned = origPinned || argv.includes('--pin')

  // RFC-015 R2: marker inheritance on revise. The marker survives revision
  // the way pinning does (a corrected playbook episode is still a playbook
  // episode); --playbook additionally sets it on an undeclared chain;
  // --no-playbook clears it explicitly (R3 / OQ-1 backfill hop).
  const playbookMarker =
    !hasNoPlaybookFlag && (origPlaybook || hasPlaybookFlag || hasRegisterPlaybookFlag)

  // RFC-009 R1 activation frontmatter — present-only, arrays UNQUOTED inline
  // (REQ-2/I4); mirrors em-store's serialization (revise-side parity).
  const activationFmLines = []
  if (activation) {
    for (const field of ACTIVATION_ARRAY_FIELDS) {
      if (Array.isArray(activation[field]) && activation[field].length) {
        activationFmLines.push(`${field}: [${serializeInlineArray(activation[field])}]`)
      }
    }
    activationFmLines.push(`priority: ${activation.priority}`)
    if (activation.review_by !== undefined) activationFmLines.push(`review_by: ${activation.review_by}`)
  }
  // F3: violation-side fields inherit verbatim (no revise-side flags exist for them)
  if (inheritedLessons.length) activationFmLines.push(`lessons: [${serializeInlineArray(inheritedLessons)}]`)
  if (inheritedViolatedPattern !== undefined) activationFmLines.push(`violated_pattern: ${inheritedViolatedPattern}`)
  if (promotionSources) activationFmLines.push(`promotion_sources: ${serializePromotionSources(promotionSources)}`)

  const frontmatter = [
    '---',
    `id: ${id}`,
    `date: ${dateStr}`,
    `time: "${timeStr}"`,
    `project: ${resolvedProject}`,
    `category: ${origCategory}`,
    `status: active`,
    `supersedes: ${originalId}`,
    `tags: [${mergedTags.join(', ')}]`,
    `summary: ${summary}`,
    ...activationFmLines,
    ...(pinned ? ['pinned: true'] : []),
    ...(playbookMarker ? ['playbook: true'] : []),
    '---',
  ].join('\n')

  const episodeContent = `${frontmatter}\n\n# ${summary}\n\nRevises: \`${originalId}\`\n\n${body}\n`

  fs.mkdirSync(episodesDir, { recursive: true })

  const filePath = path.join(episodesDir, `${id}.md`)
  atomicReplaceFileSync(filePath, episodeContent)

  // Keep in LOCKSTEP with em-rebuild-index.mjs's emit (REQ-9 parity note).
  const activationIndexFields = {
    ...(activation ? Object.fromEntries(
      ACTIVATION_ARRAY_FIELDS.filter(f => Array.isArray(activation[f]) && activation[f].length)
        .map(f => [f, activation[f]])
    ) : {}),
    ...(inheritedLessons.length ? { lessons: inheritedLessons } : {}),
    ...(activation ? { priority: activation.priority } : {}),
    ...(activation && activation.review_by !== undefined ? { review_by: activation.review_by } : {}),
    ...(inheritedViolatedPattern !== undefined ? { violated_pattern: inheritedViolatedPattern } : {}),
    ...(promotionSources ? { promotion_sources: promotionSources } : {}),
  }
  const indexEntry = JSON.stringify({
    id, date: dateStr, time: timeStr, project: resolvedProject,
    category: origCategory, status: 'active', supersedes: originalId,
    tags: mergedTags, summary,
    ...activationIndexFields,
    ...(pinned ? { pinned: true } : {}),
    ...(playbookMarker ? { playbook: true } : {})
  })
  fs.appendFileSync(indexFile, indexEntry + '\n', 'utf8')

  // Update tags.json
  updateTagsIndex(dataDir, id, mergedTags)
  updateCategoryIndex(dataDir, id, origCategory)
  // Token source is the FULL FILE content (frontmatter + body): the search
  // body tier greps the whole file, so pruning must see the same text.
  updateTokensIndex(dataDir, id, episodeTokens({ summary, tags: mergedTags, body: episodeContent }))
  // If revision crosses scopes, also update original scope's tags.json + category-index.json
  if (original.dir !== dataDir) {
    updateTagsIndex(original.dir, id, mergedTags)
    updateCategoryIndex(original.dir, id, origCategory)
    updateTokensIndex(original.dir, id, episodeTokens({ summary, tags: mergedTags, body: episodeContent }))
  }

  newId = id
  result = {
    status: 'ok', id, file: filePath,
    supersedes: originalId, scope: dataDir === GLOBAL_DIR ? 'global' : 'local'
  }

  // RFC-015 P1-S1: registration + advisory. Still INSIDE the store-write-
  // lock span (NSP G1). F4 (review r1): the B-3 scope refusal is now
  // pre-write (above the lock acquisition) — this branch only handles
  // marker carry + advisory + registration.
  // F8-r2 (review r2): re-indented — the if-pb block lives INSIDE the
  // else block (which opens at indent 2), so the if keyword and its body
  // shift to indent 4 / 6 / etc. The close of the if-pb is at indent 4
  // (matching the keyword); the close of the else remains at indent 2.
    if (playbookMarker || hasRegisterPlaybookFlag) {
      try {
        const reg = await import('./lib/playbook-registration.mjs')
        let r = null
        if (hasRegisterPlaybookFlag && result.status === 'ok') {
          r = reg.registerPlaybook({ episodeId: newId, mode: registerMode, localDataDir: dataDir })
          if (!r.ok) {
            result = {
              ...result,
              status: 'error',
              code: r.code,
              message: r.message,
              stored_id: newId,
            }
          }
        }
        if (playbookMarker && result.status === 'ok') {
          // ALWAYS name the cwd LOCAL store as project_store, even when the
          // revision lives in --scope global — registration is per-project
          // (B-3), so the audit surface is the cwd local store.
          result.playbook_advisory = reg.buildPlaybookAdvisory({
            episodeId: newId,
            localDataDir: LOCAL_DIR,
            episodeStoreDir: dataDir,
            effectiveTriggers: Array.isArray(activation && activation.triggers) ? activation.triggers : [],
            mode: registerMode || 'session_start',
          })
          if (r && r.ok && r.buildCapped) {
            result.playbook_advisory = {
              ...result.playbook_advisory,
              note: result.playbook_advisory.note + ' (build will cap; session_start count exceeds max_playbooks)',
              build_capped: true,
            }
          }
        }
      } catch (e) {
        if (result.status === 'ok') {
          result.playbook_advisory = { registered: false, project_store: LOCAL_DIR, note: `advisory computation failed: ${e && e.message ? e.message : String(e)}` }
        }
      }
    }
  }
} catch (e) {
  // ABORT-INSIDE-LOCK (audit F6): a post-preflight TOCTOU swap throws
  // IndexUnreadableError OUT of this locked try, straight into this catch —
  // NEVER process.exit inside the TRY itself. But process.exit() called
  // from HERE, in the catch, ALSO skips the paired finally below (it is not
  // a normal JS return/throw — Node exits immediately without unwinding
  // pending finally blocks), so both locks are released EXPLICITLY right
  // here before exiting; the finally's own release is a no-op repeat for
  // this path (releaseStoreWriteLocks is idempotent) and the only one that
  // runs for the `throw e` (unexpected-error) path below.
  if (e instanceof IndexUnreadableError) {
    // FIX-C (#649/#653 review P3-1): this catch funnels throws from EVERY
    // in-lock read (index.jsonl in either store dir, tags.json,
    // category-index.json, tokens.json) — e.message is byte-frozen to
    // "episode index unreadable" regardless of which file failed; derive
    // the role from e.file's basename instead.
    console.log(JSON.stringify({ status: 'error', message: unreadableMessage('em-revise', roleForFile(e.file), e), code: `index-unreadable:${e.code}` }))
    releaseStoreWriteLocks(lockHandles)
    process.exit(1)
  }
  // S3 (#666): the :495 in-lock supersede-rewrite branch (BodyUnreadableError,
  // beside IndexUnreadableError above) — roleForFile/unreadableMessage do NOT
  // apply here (roleForFile's basename map does not generalize to `<id>.md`;
  // the body family carries its own message text, no role lookup).
  if (e instanceof BodyUnreadableError) {
    console.log(JSON.stringify({ status: 'error', message: `em-revise: ${e.message}`, code: `episode-unreadable:${e.code}` }))
    releaseStoreWriteLocks(lockHandles)
    process.exit(1)
  }
  throw e
} finally {
  releaseStoreWriteLocks(lockHandles)
}

// R9a write-time collision report (REQ-18) — mirrors em-store's post-release
// block (revise-side parity): stderr-only, self-excluded, never fatal, and
// only AFTER the store-write locks are released (issue 546).
if (result.status === 'ok' && activation && Array.isArray(activation.triggers) && activation.triggers.length) {
  try {
    const merged = loadMergedTriggerIndex()
    const mine = new Set(activation.triggers)
    const reported = new Set()
    for (const e of merged.entries) {
      if (e.episode_id === newId) continue // self-exclusion (CX5)
      if (!mine.has(e.value)) continue
      const key = `${e.episode_id} ${e.value}`
      if (reported.has(key)) continue
      reported.add(key)
      process.stderr.write(`collision: trigger "${e.value}" also on ${e.episode_id}: ${e.summary}\n`)
    }
    // FIX-A (#649/#653 review P1-1): the write already succeeded (this block
    // runs post-lock-release) — an unreadable local/global index must never
    // misreport that as a failure. loadMergedTriggerIndex degrades instead of
    // throwing; surface the degrade on the (already-successful) stdout
    // payload so the caller knows the collision check was incomplete.
    if (merged.degraded && merged.degraded.length && result.status === 'ok') {
      result.warning = `trigger collision check incomplete: ${merged.degraded.join(', ')} index unreadable`
    }
  } catch {}
}

console.log(JSON.stringify(result))
// RFC-015: registration refusal (or scope refusal) prints the error payload
// AND exits non-zero. The revision IS already stored when this fires
// (post-store refusal per EC6).
if (result.status === 'error') process.exit(1)
