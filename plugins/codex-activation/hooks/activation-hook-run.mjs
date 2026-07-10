#!/usr/bin/env node
// activation-hook-run.mjs — RFC-009 Codex advisory activation runner for
// UserPromptSubmit, PreToolUse, and SessionStart. The three thin registered
// .sh entry points invoke it with the event name as argv[2] and pipe the hook's
// raw stdin JSON. ONE shared runner (not three near-duplicate ones) is a
// deliberate §8.2 SYMMETRY choice: identity/freshness/suppress/matcher/render
// logic lives in exactly one place, closing the P1b asymmetric-validation
// class (`…3c55`) where a lenient sibling branch drifts from its twin.
//
// ADVISORY INVARIANT (holds on EVERY path — parse failure, missing manifest,
// missing/corrupt index, stale-rebuild-subprocess failure, matcher throw):
// this script prints EITHER nothing OR exactly
//   { hookSpecificOutput: { hookEventName, additionalContext } }
// and the calling .sh ALWAYS exits 0 regardless of this process's exit code.
// Never a decision/block/permissionDecision field.
//
// READ BOUNDARY (REQ-19): the FRESH path reads ONLY the persisted per-store
// trigger-index.json files (stat-only freshness check against index.jsonl,
// never its content) plus lesson-suppress.json (REQ-13) and its schema
// (REQ-14) — never index.jsonl content, tags.json, activation-classes.json,
// or process.env. The STALE/CORRUPT path's rebuild is an explicit CARVE-OUT:
// it shells out to the standalone `em-trigger-index` CLI as a SUBPROCESS
// (never imports the writer module directly), so the index.jsonl read that
// powers a rebuild happens inside that tool's own process boundary, not this
// event-plane process. Output flows only through the rebuilt trigger-index.json
// artifact this process then reads back.
//
// IDENTITY (§7.1, §8.3, REQ-4): resolved EXCLUSIVELY from the co-located
// manifest.json's `project_identity: {slug, root}` (+ `harness` as tool_id).
// stdin `.cwd` is NEVER read by this script — not even for confirmation — the
// simplest defensible posture given the plan explicitly forbids cwd/env as an
// identity SOURCE (P2-S2 REQ-4, §7.1 "adapter scope identity" row). A missing
// manifest, an unparseable manifest, or a manifest without project_identity
// all degrade to "no injection" (§12 "manifest absent -> no injection", R2-M1).
//
// MANIFEST RESOLUTION: candidate order is (1) HOOK_DIR/manifest.json for a
// flat installed layout; (2) HOOK_DIR/../manifest.json for the source and
// deployed Codex plugin layout. No global fallback: project
// identity has no meaningful global default (P12) and a manifest lacking
// project_identity must degrade to no-injection, not to some other project's
// identity.
//
// SCRIPT/LIB RESOLUTION: em-trigger-index.mjs (subprocess) and
// scripts/lib/activation-match.mjs (imported) resolve co-located first, then
// from the in-repo scripts tree, then from the deployed global copy under
// ~/.episodic-memory/scripts/. The Codex installer co-deploys the two imported
// libraries so the event path does not depend on a prior global install.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EVENT_NAME = process.argv[2] // UserPromptSubmit | PreToolUse | SessionStart

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT_GUESS = path.join(HOOK_DIR, '..', '..', '..')
const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')

const CANDIDATE_ROOTS = [HOOK_DIR, REPO_ROOT_GUESS, GLOBAL_DIR]

function resolveAsset(relForms) {
  for (const root of CANDIDATE_ROOTS) {
    for (const rel of relForms) {
      const candidate = path.join(root, rel)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* keep trying */
      }
    }
  }
  return null
}

const TRIGGER_INDEX_SCRIPT = resolveAsset(['em-trigger-index.mjs', 'scripts/em-trigger-index.mjs'])
const MATCH_LIB_PATH = resolveAsset(['activation-match.mjs', 'lib/activation-match.mjs', 'scripts/lib/activation-match.mjs'])
const VALIDATE_LIB_PATH = resolveAsset(['json-instance-validate.mjs', 'lib/json-instance-validate.mjs', 'scripts/lib/json-instance-validate.mjs'])
const SUPPRESS_SCHEMA_PATH = resolveAsset(['lesson-suppress.schema.json', 'schemas/lesson-suppress.schema.json'])

function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {
      /* keep trying */
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Identity (manifest-only, never stdin cwd / env)
// ---------------------------------------------------------------------------
function resolveIdentity() {
  const manifestPath = firstExisting([
    path.join(HOOK_DIR, 'manifest.json'),
    path.join(HOOK_DIR, '..', 'manifest.json'),
  ])
  if (!manifestPath) return null

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null // corrupt manifest -> no injection
  }
  const pi = manifest && typeof manifest === 'object' ? manifest.project_identity : null
  if (!pi || typeof pi.slug !== 'string' || !pi.slug || typeof pi.root !== 'string' || !pi.root) {
    return null // absent/malformed project_identity -> no injection (repo template / pre-install)
  }
  const toolId = typeof manifest.harness === 'string' && manifest.harness ? manifest.harness : ''
  return { slug: pi.slug, root: pi.root, tool_id: toolId }
}

// ---------------------------------------------------------------------------
// Event construction (REQ-16/17/21)
// ---------------------------------------------------------------------------
function buildEvent(payload) {
  if (EVENT_NAME === 'UserPromptSubmit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
    return { kind: 'prompt', prompt }
  }
  if (EVENT_NAME === 'SessionStart') {
    // R4/S5: no phrase/tool/target on the event -- the two-tier blend is
    // read from merged.session_start, not matched against a prompt/target.
    return { kind: 'session_start' }
  }
  if (EVENT_NAME === 'PreToolUse') {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    const ti = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : {}
    let target = ''
    if (toolName === 'Bash' || toolName === 'apply_patch') {
      target = typeof ti.command === 'string' ? ti.command : ''
    } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
      target = typeof ti.file_path === 'string'
        ? ti.file_path
        : (typeof ti.notebook_path === 'string' ? ti.notebook_path : '')
    } else {
      target = '' // EC9: unknown tool -> empty target; `tool:<Name>:*` still name-matches
    }
    return { kind: 'tool', tool: toolName, target }
  }
  return null
}

// ---------------------------------------------------------------------------
// Store read (REQ-19): stat-only freshness; STALE/CORRUPT -> subprocess
// carve-out rebuild, then a single re-read. A wholly MISSING trigger-index.json
// is a "not participating yet" store (skip; no build attempt) -- distinct from
// a CORRUPT one (existed, now broken -> rebuild once, else skip + stderr,
// EC10). A subprocess/rebuild failure of any kind still degrades to "skip (or
// best-effort stale data)", never a thrown error (EC12).
// ---------------------------------------------------------------------------
function loadStoreIndex({ scope, root }) {
  const storeDir = scope === 'global' ? GLOBAL_DIR : path.join(root, '.episodic-memory')
  const triggerIndexPath = path.join(storeDir, 'trigger-index.json')

  let raw
  try {
    raw = fs.readFileSync(triggerIndexPath, 'utf8')
  } catch {
    return null // missing -> skip this store, no build attempt
  }

  let cached
  try {
    cached = JSON.parse(raw)
  } catch {
    cached = undefined // corrupt (unparseable)
  }

  if (cached === undefined) {
    return rebuildStore({ scope, root, storeDir }) // corrupt -> rebuild once, else skip+stderr
  }

  // Freshness (RFC-011 R2.5 / REQ-6, S3): compare MTIME+SIZE ONLY at event
  // time (never sha256 — the build-side cache probe owns the sha; the strict
  // read boundary governs CONTENT reads, and stat fingerprints are the
  // sanctioned freshness mechanism). Compares three legs:
  //   - index_* ALWAYS (the LOCAL store's index.jsonl — the existing R2.5 check).
  //   - playbooks_* UNCONDITIONALLY (v3 builds record the local playbooks.json
  //     fingerprint on every build — zero-state {0,0} when the file is absent,
  //     so CREATE/edit/DELETE all invalidate). A cached v2 index (no playbooks_*)
  //     mismatches `undefined !== 0` and rebuilds (T12).
  //   - global_index_* IFF THE CACHED SOURCE CARRIES IT (fix-round Item 1,
  //     3-way convergent: agent F2 + codex S3-F1 + kimi F1). The build records
  //     the GLOBAL store's index.jsonl fingerprint on a LOCAL index IFF a valid
  //     preference file couples this store to the global (R2.5: "config-free
  //     projects pay no cross-store coupling"). The PRIOR either-side rule also
  //     compared when an on-disk global index.jsonl existed — so EVERY config-
  //     free project with any global store spawned a rebuild subprocess on EVERY
  //     event forever (probe: 3 events = 3 spawns). Now: compare the global leg
  //     ONLY when the cached source carries `global_index_mtime_ms` (i.e., the
  //     build that produced this cache ran with a valid preference file). This
  //     mirrors the build's own sourceMatches conditional at
  //     em-trigger-index.mjs:547 (the "fresh" side only carries global_index_*
  //     when validPref). Pref CREATE is still caught by the unconditional
  //     playbooks_* leg (mtime+size move off zero-state); a global revision with
  //     a valid pref is caught here. Missed-invalidation: a same-mtime+size
  //     rewrite of playbooks.json (e.g. valid → malformed) evades until any other
  //     leg moves — the identical PRE-EXISTING residual the index.jsonl stat
  //     carries, stated per P5 (kimi F analysis: no NEW missed-invalidation
  //     beyond that accepted residual). For a GLOBAL-store cache no
  //     global_index_* is ever emitted (R2/F4) → this leg is a no-op there.
  const jsonlPath = path.join(storeDir, 'index.jsonl')
  const expectIndex = (() => {
    try { const s = fs.statSync(jsonlPath); return { mtimeMs: s.mtimeMs, size: s.size } }
    catch { return { mtimeMs: 0, size: 0 } }
  })()
  const expectPlaybooks = (() => {
    try { const s = fs.statSync(path.join(storeDir, 'playbooks.json')); return { mtimeMs: s.mtimeMs, size: s.size } }
    catch { return { mtimeMs: 0, size: 0 } } // zero-state when absent (clean uninstall)
  })()
  const src = cached && cached.source
  let fresh = !!src
    && src.index_mtime_ms === expectIndex.mtimeMs && src.index_size === expectIndex.size
    && src.playbooks_mtime_ms === expectPlaybooks.mtimeMs && src.playbooks_size === expectPlaybooks.size
  if (fresh && scope === 'local' && src.global_index_mtime_ms !== undefined) {
    // Cached source carries the global coupling fingerprint → compare it against
    // the on-disk global index.jsonl stat (computed ONLY here, lazily, iff the
    // cached source says the build recorded one — NOT unconditionally).
    let expectGM = 0, expectGS = 0
    try { const s = fs.statSync(path.join(GLOBAL_DIR, 'index.jsonl')); expectGM = s.mtimeMs; expectGS = s.size } catch { /* absent global index.jsonl -> zero-state */ }
    fresh = src.global_index_mtime_ms === expectGM && src.global_index_size === expectGS
  }
  if (fresh) return cached

  const rebuilt = rebuildStore({ scope, root, storeDir })
  return rebuilt || cached // best-effort: a failed stale rebuild still has the stale-but-parseable copy to fall back on
}

function rebuildStore({ scope, root, storeDir }) {
  if (!TRIGGER_INDEX_SCRIPT) {
    process.stderr.write(`activation-hook: em-trigger-index.mjs not found; skipping ${scope} store\n`)
    return null
  }
  const args = [TRIGGER_INDEX_SCRIPT, '--scope', scope]
  if (scope === 'local' && root) args.push('--project', root)
  try {
    spawnSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 4000 })
  } catch {
    // subprocess failed to even spawn (EC12) -- fall through to a best-effort read
  }
  const triggerIndexPath = path.join(storeDir, 'trigger-index.json')
  try {
    return JSON.parse(fs.readFileSync(triggerIndexPath, 'utf8'))
  } catch (e) {
    process.stderr.write(`activation-hook: ${scope} trigger-index.json unreadable after rebuild attempt (${e.message}); skipping store\n`)
    return null
  }
}

// RFC-011 R2.9(a) + REQ-6b: dedup key is now (episode_id, trigger_kind, value),
// NOT episode_id alone. The prior per-episode first-row-wins collapse silently
// dropped every trigger after the first for ANY multi-trigger episode (probe-
// confirmed at activation-hook-run.mjs:240-241, the latent RFC-009 defect the
// S3 slice repairs). Tuple-key dedup preserves every trigger row across stores
// while still keeping LOCAL precedence for the SAME tuple (local iterates
// first). The CLI merged leg (loadMergedTriggerIndex) already keeps all rows
// via its delayed seen-set; the two merge sites now CONVERGE on the same shape.
//
// R2.9(b) playbook-wins: for the SAME episode_id + trigger tuple, when BOTH a
// lesson row and a playbook row exist, the PLAYBOOK form wins (it carries the
// `read_command`). Implemented by REPLACING a queued lesson entry with a later
// playbook entry of the same tuple — so an inherited playbook (episode's own
// triggers, no override) collapses its matching lesson row into the playbook
// row at MERGE time (zero new matching semantics on the matcher side, per R4).
//
// REQ-6b override-drop leg (mirrors loadMergedTriggerIndex semantics): a local
// playbook row carrying `triggers_overridden:true` marks an episode whose own
// (superseded) phrase/tool trigger set has been REPLACED within this project.
// The hook DROPS the episode's own NON-playbook lesson rows for those ids in
// BOTH local AND global streams (the matcher then never fires the old triggers —
// T6 E2E "the episode's original phrase no longer fires"). Playbook row
// presence is by-construction LOCAL-only (R2: persisted in the LOCAL store),
// so LOCAL precedence is automatic; the override-drop covers BOTH origins.
function mergeIndexes(local, global) {
  const overriddenIds = new Set()
  if (local && Array.isArray(local.entries)) {
    for (const e of local.entries) {
      if (e && e.entry_class === 'playbook' && e.triggers_overridden === true) overriddenIds.add(e.episode_id)
    }
  }
  const mapped = new Map() // tuple key -> entry (playbook-replaces-lesson for the same tuple)
  for (const idx of [local, global]) {
    if (!idx || !Array.isArray(idx.entries)) continue
    for (const e of idx.entries) {
      if (!e || typeof e.episode_id !== 'string' || !e.episode_id) continue
      if (e.entry_class !== 'playbook' && overriddenIds.has(e.episode_id)) continue
      const tk = typeof e.trigger_kind === 'string' ? e.trigger_kind : ''
      const v = typeof e.value === 'string' ? e.value : ''
      const key = `${e.episode_id}\u0000${tk}\u0000${v}`
      const existing = mapped.get(key)
      if (!existing) { mapped.set(key, e); continue }
      // R2.9(b): a playbook row replaces a lesson row for the same tuple ("the
      // PLAYBOOK form wins" — it carries the read_command). Forged/malformed
      // rows of either kind pass without replacement if entry_class is absent.
      if (e.entry_class === 'playbook' && existing.entry_class !== 'playbook') mapped.set(key, e)
    }
  }
  const entries = [...mapped.values()]
  const activityPhrases =
    local && local.activity_phrases && typeof local.activity_phrases === 'object' && !Array.isArray(local.activity_phrases)
      ? local.activity_phrases
      : (global && global.activity_phrases && typeof global.activity_phrases === 'object' && !Array.isArray(global.activity_phrases)
        ? global.activity_phrases
        : {})
  return { entries, activity_phrases: activityPhrases }
}

// ---------------------------------------------------------------------------
// REQ-19/21 (R4/S5 SessionStart only -- never computed for the R3 hooks, so
// their behavior/timing is byte-identical to before this slice): merge each
// store's `session_start` section, dedup by episode_id with LOCAL precedence
// (same rule as mergeIndexes' `entries`), and classify each store's section
// as present-and-ok / present-but-malformed / absent so main() can emit the
// single REQ-21 stderr note when a LOADED trigger-index.json lacks a usable
// session_start (never when the store itself is simply absent -- that is the
// separate, already-tested "missing index" path).
// ---------------------------------------------------------------------------
function sessionStartStatus(idx) {
  if (!idx) return { present: false, ok: true, value: null } // store not built/absent -- not an error
  const raw = idx.session_start
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { present: true, ok: false, value: null }
  return { present: true, ok: true, value: raw }
}

function dedupByEpisodeId(lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const e of list) {
      if (!e || typeof e.episode_id !== 'string' || !e.episode_id || seen.has(e.episode_id)) continue
      seen.add(e.episode_id)
      out.push(e)
    }
  }
  return out
}

// F3 (review-confirmed): merged tier-2 must be re-sorted by static_score DESC
// (tie-break episode_id asc for determinism) after the local-precedence dedup.
// dedupByEpisodeId preserves local-list-then-global ORDER, but the pure
// renderer documents its precondition as "entriesRaw is already pre-sorted by
// static_score desc" and preserves whatever order it receives. Without this
// re-sort a high-static_score GLOBAL lesson renders after / is token-budgeted
// out behind low-score LOCAL ones, diverging from the union-top-N-by-score that
// `entries` represents (and that `em-trigger-index --merged` produces for the
// handoff path). This reads static_score only (NOT effective_priority), so the
// REQ-18 plain-only tier-2 invariant is unaffected. Non-numeric static_score
// sorts last (treated as -Infinity) rather than throwing.
function sortEntriesByStaticScore(entries) {
  const scoreOf = (e) => (Number.isFinite(e.static_score) ? e.static_score : -Infinity)
  return [...entries].sort((a, b) => {
    const sa = scoreOf(a)
    const sb = scoreOf(b)
    if (sb !== sa) return sb - sa
    return a.episode_id < b.episode_id ? -1 : a.episode_id > b.episode_id ? 1 : 0
  })
}

// F2 (review-confirmed): merge the preflight per task-type key across BOTH
// stores — union of task keys; for each, union of pattern_ids; SUM the numeric
// counts. The prior `local || global || {}` took local wholesale and dropped
// global counts entirely (or a local {} shadowed a populated global). Summing
// matches what `em-trigger-index --merged` (loadMergedTriggerIndex over the
// union of both stores' rows) produces, so the R4 hook and the REQ-26 handoff
// path stay consistent. Non-finite counts are skipped; a pattern surviving
// with a >0 summed count is kept.
function mergePreflight(localVal, globalVal) {
  const validMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
  const merged = {}
  for (const val of [localVal, globalVal]) {
    const pf = val && validMap(val.preflight)
    if (!pf) continue
    for (const [taskType, counts] of Object.entries(pf)) {
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)) continue
      if (!Object.hasOwn(merged, taskType)) merged[taskType] = {}
      const bucket = merged[taskType]
      for (const [patternId, n] of Object.entries(counts)) {
        if (!Number.isFinite(n)) continue
        bucket[patternId] = (Object.hasOwn(bucket, patternId) ? bucket[patternId] : 0) + n
      }
    }
  }
  return merged
}

function mergeSessionStart(localStatus, globalStatus) {
  const localVal = localStatus.ok ? localStatus.value : null
  const globalVal = globalStatus.ok ? globalStatus.value : null
  const critical_entries = dedupByEpisodeId([
    localVal ? localVal.critical_entries : null,
    globalVal ? globalVal.critical_entries : null,
  ])
  const entries = sortEntriesByStaticScore(dedupByEpisodeId([
    localVal ? localVal.entries : null,
    globalVal ? globalVal.entries : null,
  ]))
  const preflight = mergePreflight(localVal, globalVal)
  // RFC-011 R2.7 / REQ-8: thread the LOCAL persisted playbooks trio UNCHANGED
  // (global never produces one; neither merge site recomputes any of the
  // three — the build pre-caps/pre-computes them). Present iff a valid LOCAL
  // preference file was processed (the build only attaches the trio then).
  const out = { critical_entries, entries, preflight }
  if (localVal && Object.prototype.hasOwnProperty.call(localVal, 'playbooks')) {
    out.playbooks = localVal.playbooks
    out.playbooks_capped = localVal.playbooks_capped
    out.playbooks_capped_first = localVal.playbooks_capped_first
  }
  return out
}

// ---------------------------------------------------------------------------
// Suppress (REQ-13/14): whole-file, whole-document fail-open. Missing OR
// syntax-malformed OR shape-malformed (schema-invalid) -> empty Set + ONE
// stderr note, injection proceeds. Schema validation is attempted via the
// real schema (REQ-14, a SHOULD) when resolvable; otherwise an equivalent
// manual structural check (same required/type constraints) degrades safely
// -- schemas/ is not yet part of the deployed global tree (see RETURN item 7).
// ---------------------------------------------------------------------------
let _schemaValidatorPromise = null
function getSchemaValidator() {
  if (_schemaValidatorPromise) return _schemaValidatorPromise
  _schemaValidatorPromise = (async () => {
    if (!VALIDATE_LIB_PATH || !SUPPRESS_SCHEMA_PATH) return null
    try {
      const mod = await import(pathToFileURL(VALIDATE_LIB_PATH).href)
      const schema = JSON.parse(fs.readFileSync(SUPPRESS_SCHEMA_PATH, 'utf8'))
      if (typeof mod.validateInstance !== 'function') return null
      return { validateInstance: mod.validateInstance, schema }
    } catch {
      return null
    }
  })()
  return _schemaValidatorPromise
}

function manualSuppressShapeOk(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  if (doc.schema_version !== 1) return false
  if (!Array.isArray(doc.suppress)) return false
  for (const item of doc.suppress) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    if (typeof item.episode_id !== 'string' || !item.episode_id) return false
  }
  return true
}

async function loadSuppressSet(root) {
  const p = path.join(root, '.episodic-memory', 'lesson-suppress.json')

  // ENOENT (file simply absent — the common case for a project that has never
  // authored a mute list) is SILENT: empty Set, NO stderr note (codex F2a — a
  // note on every event was noise that masked the spec-required note). Read the
  // bytes first and treat ONLY a genuine "does not exist" as the silent path;
  // any other read error (permissions, is-a-directory, ...) counts as
  // "exists-but-unusable" and DOES earn the single note, since the operator
  // authored something the hook cannot honor.
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return new Set() // absent -> silent, no note
    process.stderr.write(`activation-hook: lesson-suppress.json unreadable (${e && e.message}); proceeding with no suppression\n`)
    return new Set()
  }

  // The file EXISTS: any parse / shape / schema failure fails OPEN with exactly
  // ONE observable stderr note (REQ-13 / EC6), injection proceeds.
  try {
    const doc = JSON.parse(raw)
    const validator = await getSchemaValidator()
    let ok
    if (validator) {
      try {
        ok = validator.validateInstance(doc, validator.schema).valid
      } catch {
        ok = manualSuppressShapeOk(doc)
      }
    } else {
      ok = manualSuppressShapeOk(doc)
    }
    if (!ok) throw new Error('shape-malformed')
    const set = new Set()
    for (const item of doc.suppress) set.add(item.episode_id)
    return set
  } catch (e) {
    process.stderr.write(`activation-hook: lesson-suppress.json unusable (${e && e.message}); proceeding with no suppression\n`)
    return new Set()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return // EC1: empty/non-object stdin -> exit 0, no output
  }

  const identity = resolveIdentity()
  if (!identity) return // manifest absent/malformed/no project_identity -> no injection

  const event = buildEvent(payload)
  if (!event) return

  const local = loadStoreIndex({ scope: 'local', root: identity.root })
  const global = loadStoreIndex({ scope: 'global', root: identity.root })
  const merged = mergeIndexes(local, global)

  if (EVENT_NAME === 'SessionStart') {
    // Computed ONLY on this branch -- the R3 hooks' merged shape/timing is
    // byte-identical to before this slice (§8.2 SYMMETRY: no cross-hook
    // side effect from adding R4).
    const localSS = sessionStartStatus(local)
    const globalSS = sessionStartStatus(global)
    if ((localSS.present && !localSS.ok) || (globalSS.present && !globalSS.ok)) {
      // REQ-21: missing/malformed session_start -> exactly one stderr note.
      process.stderr.write('activation-hook: session_start section missing or malformed in a trigger-index.json; rendering from available data\n')
    }
    merged.session_start = mergeSessionStart(localSS, globalSS)
  }

  const suppress = await loadSuppressSet(identity.root)

  let matchActivation
  try {
    if (!MATCH_LIB_PATH) return
    const mod = await import(pathToFileURL(MATCH_LIB_PATH).href)
    matchActivation = mod.matchActivation
    if (typeof matchActivation !== 'function') return
  } catch {
    return
  }

  let result
  try {
    result = matchActivation(merged, event, identity, suppress, { max_matches: 3, max_tokens: 500 })
  } catch {
    result = { lines: [], overflowNote: null }
  }

  const lines = result && Array.isArray(result.lines) ? result.lines : []
  if (lines.length === 0) return // nothing to inject -> exit 0, no output

  let text = lines.join('\n')
  if (result.overflowNote) text += `\n${result.overflowNote}`

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EVENT_NAME,
      additionalContext: text,
    },
  }) + '\n')
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0)) // advisory invariant: never a non-zero exit, never a decision field
