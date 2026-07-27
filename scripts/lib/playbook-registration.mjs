// scripts/lib/playbook-registration.mjs — RFC-015 P1-S1 shared module.
//
// One writer for `<local-store>/playbooks.json` (B-2: no other code path
// writes this file). Two advisory constructors (`buildPlaybookAdvisory`)
// read-only — their computation never throws the store/revise flow. The
// writer is invoked INSIDE the store-write-lock the caller already holds
// for the episode write (NSP G1 concurrency contract: lost-update
// serialized by the SAME lock every sibling store writer pairs with
// `atomicReplaceFileSync`; no new lock site, no new timeout shape).
//
// State table (RFC-015 §12): see the per-state table in the plan.
//
// Zero deps. Node stdlib only.

import fs from 'node:fs'
import path from 'node:path'
import {
  parsePlaybooksConfig,
  terminalOf,
  buildChainMaps,
  validatePlaybooksShape,
} from '../em-trigger-index.mjs'
import { atomicReplaceFileSync } from './store-write-lock.mjs'
import { validateInstance } from './json-instance-validate.mjs'

// Lazily resolved so the module can be imported without pulling the schema
// every time (the schema load is the slow path; tests that don't validate
// against it skip it).
let _playbooksSchema = null
function playbooksSchema() {
  if (_playbooksSchema) return _playbooksSchema
  // Walk up to the repo root: this module lives at scripts/lib/, the schema
  // at <root>/schemas/playbooks.schema.json. The repo root's parent holds
  // install.mjs (mirrors em-doctor's repoRoot detection).
  const here = path.dirname(new URL(import.meta.url).pathname)
  const root = path.resolve(here, '..', '..')
  const p = path.join(root, 'schemas', 'playbooks.schema.json')
  _playbooksSchema = JSON.parse(fs.readFileSync(p, 'utf8'))
  return _playbooksSchema
}

// 64 KiB whole-FILE bound (mirrors parsePlaybooksConfig's stat proxy; the
// schema cannot express file size so the writer enforces it here as a
// refusal).
export const PLAYBOOKS_MAX_BYTES = 64 * 1024

/**
 * Resolve the per-project playbooks.json path. Pure path computation.
 * @param {string} localDataDir
 * @returns {string}
 */
export function playbooksPath(localDataDir) {
  return path.join(localDataDir, 'playbooks.json')
}

// Read the local index rows that the advisory needs for terminal
// resolution. Index rows live at `<localDataDir>/index.jsonl`; absent file
// degrades to empty (an empty advisory list — declared-but-not-yet-stored
// is the expected shape during the EC1 missing-store-dir leg).
function readLocalIndexRows(localDataDir) {
  const rows = []
  const idx = path.join(localDataDir, 'index.jsonl')
  let raw = ''
  try { raw = fs.readFileSync(idx, 'utf8') } catch { return rows }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e === 'object' && typeof e.id === 'string') rows.push(e)
    } catch {}
  }
  return rows
}

/**
 * buildPlaybookAdvisory({ episodeId, localDataDir, indexRows, episodeStoreDir, effectiveTriggers })
 *   → PlaybookAdvisory | { registered: false, note: <string>, project_store: <abs> }
 *
 * RFC-015 R2 advisory shape (RFC:64-71): the `note` field is ALWAYS
 * present; `suggested_entry` is present only when `registered: false`; on
 * a malformed declaration file the note carries the parse reason and the
 * function NEVER writes.
 *
 * F5 (review r1): `episodeStoreDir` is the dir the episode was JUST WRITTEN
 * to (LOCAL_DIR for --scope local, GLOBAL_DIR for --scope global). It is
 * the INDEX source for terminal resolution so a global-store marker
 * episode resolves through the GLOBAL terminal — not "deferred". The
 * declaration source and the `project_store` field stay pinned to the
 * cwd-local playbooks.json (B-3, t9(b) unchanged).
 *
 * F3 (review r1): `effectiveTriggers` is the just-written episode's effective
 * trigger array (already in hand in both CLIs). When mode==='on_demand' and
 * the set is empty, the advisory appends the empty_triggers warning + sets
 * `empty_triggers: true` so the operator sees it BEFORE the build excludes
 * the entry.
 *
 * Computation is wrapped in try/catch so the advisory never throws the
 * store/revise flow (§8.1 invariant).
 *
 * @param {{
 *   episodeId: string,
 *   localDataDir: string,            // cwd-local project store (declaration source + project_store field)
 *   indexRows?: Array<object>,       // optional override; defaults to episodeStoreDir's index
 *   episodeStoreDir?: string,        // index source (defaults to localDataDir)
 *   effectiveTriggers?: string[],    // just-written episode's trigger set
 * }} args
 * @returns {{
 *   registered: boolean,
 *   project_store: string,
 *   suggested_entry?: {id: string, mode: string},
 *   empty_triggers?: boolean,
 *   note: string
 * }}
 */
export function buildPlaybookAdvisory({ episodeId, localDataDir, indexRows, episodeStoreDir, effectiveTriggers, mode }) {
  // project_store + declaration source = cwd-local store (B-3). This stays
  // even when the episode lives in --scope global.
  const project_store = localDataDir
  const base = { project_store }
  const indexSourceDir = episodeStoreDir || localDataDir
  // F3 (review r1): the caller-supplied `mode` is the AUTHORED mode (the
  // mode the operator passed to --register-playbook, or the implied
  // session_start default). The annotation fires when the actual authored
  // mode is on_demand AND the episode's effective trigger set is empty.
  try {
    const pb = parsePlaybooksConfig(localDataDir)
    if (!pb.ok) {
      // State C malformed: degrade to a note, never a write.
      return annotateEmptyTriggers({
        ...base,
        registered: false,
        note: `playbooks.json present but ${pb.reason}; declaration unreadable — register or repair it (RFC-015 R2, fail-open)`,
      }, mode, effectiveTriggers)
    }
    if (pb.config === null) {
      // State A absent: not declared, suggest an entry whose mode matches
      // the authored mode (F3: when on_demand, suggest on_demand).
      return annotateEmptyTriggers({
        ...base,
        registered: false,
        suggested_entry: { id: episodeId, mode: mode || 'session_start' },
        note: "playbook episode not declared in this project's playbooks.json; add the entry or re-run with --register-playbook",
      }, mode, effectiveTriggers)
    }
    // State B valid: walk the declared set, find the entry whose chain
    // resolves to the same terminal as episodeId.
    const rows = Array.isArray(indexRows) ? indexRows : readLocalIndexRows(indexSourceDir)
    const { byId, successorOf } = buildChainMaps(rows)
    const targetTerminal = terminalOf(episodeId, byId, successorOf)
    if (!targetTerminal) {
      return annotateEmptyTriggers({
        ...base,
        registered: false,
        suggested_entry: { id: episodeId, mode: mode || 'session_start' },
        note: "playbook episode is not in the local index yet; declaration check deferred until the index is readable",
      }, mode, effectiveTriggers)
    }
    for (const entry of pb.config.playbooks) {
      if (!entry || typeof entry.id !== 'string') continue
      const t = terminalOf(entry.id, byId, successorOf)
      if (t && t.id === targetTerminal.id) {
        return annotateEmptyTriggers({
          ...base,
          registered: true,
          note: "declared in this project's playbooks.json",
        }, mode, effectiveTriggers)
      }
    }
    return annotateEmptyTriggers({
      ...base,
      registered: false,
      suggested_entry: { id: episodeId, mode: mode || 'session_start' },
      note: "playbook episode not declared in this project's playbooks.json; add the entry or re-run with --register-playbook",
    }, mode, effectiveTriggers)
  } catch (e) {
    // Advisory must never throw the caller — degrade to a note.
    return { ...base, registered: false, note: `advisory computation failed: ${e && e.message ? e.message : String(e)}` }
  }
}

// F3 (review r1): when mode===on_demand and the episode's effective trigger
// set is empty, the advisory must warn — the build will exclude the entry
// as empty_triggers and the operator needs to know at write time, not at
// build time (REQ-12).
function annotateEmptyTriggers(advisory, mode, effectiveTriggers) {
  // Only meaningful for the on_demand case; session_start entries ignore
  // the trigger set per RFC-011 R1.
  if (mode !== 'on_demand') return advisory
  const empty = !Array.isArray(effectiveTriggers) || effectiveTriggers.length === 0
  if (!empty) return advisory
  return {
    ...advisory,
    empty_triggers: true,
    note: advisory.note + ' (build will exclude this entry as empty_triggers: the episode has no effective triggers)',
  }
}

/**
 * registerPlaybook({ episodeId, mode, localDataDir })
 *   → { ok: true, entry, created, buildCapped }
 *   | { ok: false, code, message }
 *
 * RFC-015 §12 state table A-I. Single-writer contract (§8.1). The CALLER
 * holds the store-write lock — registerPlaybook does no locking of its
 * own (NSP G1 concurrency contract).
 *
 * - State A absent file   → skeleton + entry, atomic write
 * - State B valid, new id → entry appended, atomic rewrite
 * - State C valid, exists → idempotent upsert (mode replaced if different),
 *                           atomic rewrite
 * - State D 32-cap exact  → refusal, file byte-identical
 * - State E parse failure → refusal, file byte-identical
 * - State F schema-invalid→ refusal, file byte-identical
 * - State G result invalid→ refusal, file byte-identical
 * - State H bad mode      → caller refuses (CLI grammar); here it's a
 *                           defensive refusal as well
 * - State I oversize      → refusal, file byte-identical
 *
 * Side effect: atomic rewrite of `<localDataDir>/playbooks.json` on success.
 *
 * @param {{episodeId: string, mode: 'session_start'|'on_demand', localDataDir: string}} args
 */
export function registerPlaybook({ episodeId, mode, localDataDir }) {
  if (mode !== 'session_start' && mode !== 'on_demand') {
    return { ok: false, code: 'playbooks-mode', message: `playbooks.json: mode must be session_start or on_demand (got "${mode}")` }
  }
  const target = playbooksPath(localDataDir)
  fs.mkdirSync(localDataDir, { recursive: true })

  // Read raw (or start from skeleton)
  let raw = ''
  let created = false
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch {
    // absent file → State A skeleton
    raw = ''
  }
  let doc
  if (raw === '') {
    doc = { schema_version: 1, playbooks: [] }
    created = true
  } else {
    try {
      doc = JSON.parse(raw)
    } catch (e) {
      return { ok: false, code: 'playbooks-parse', message: `playbooks.json: ${e.message}` }
    }
  }

  // Validate EXISTING doc first (RFC-015 §8.1 whole-document gate).
  const shapeReason = validatePlaybooksShape(doc)
  if (shapeReason) {
    return { ok: false, code: 'playbooks-invalid', message: `playbooks.json: ${shapeReason}` }
  }
  // Schema doc validation (defense in depth: the parser's structural checks
  // ARE the unique-by-id + maxItems enforcement, but the schema doc is the
  // CI-linted contract — both must pass before any write).
  const schemaVerdict = validateInstance(doc, playbooksSchema())
  if (!schemaVerdict.valid) {
    const first = schemaVerdict.errors[0]
    return {
      ok: false,
      code: 'playbooks-invalid',
      message: `playbooks.json: ${first ? `${first.path} ${first.keyword}: ${first.detail}` : 'schema validation failed'}`,
    }
  }

  // Upsert: find existing entry by id.
  const existing = doc.playbooks.findIndex((e) => e && typeof e.id === 'string' && e.id === episodeId)
  const entry = { id: episodeId, mode }
  if (existing >= 0) {
    // State C: idempotent upsert. The 32-entry array stays at 32 (no new
    // id); we replace the entry's mode in place.
    doc.playbooks[existing] = entry
  } else {
    // New id: 32-entry bound check on the resulting doc.
    if (doc.playbooks.length >= 32) {
      // RFC-015 §12 state D: refusal, file byte-identical (we haven't
      // touched it yet — JSON.parse did NOT modify the file).
      return {
        ok: false,
        code: 'playbooks-full',
        message: `playbooks.json: playbooks has ${doc.playbooks.length} entries (maxItems); remove one before registering a new id`,
      }
    }
    doc.playbooks.push(entry)
  }

  // Validate RESULTING doc (defense against any future drift between the
  // parser's hand-rolled checks and the schema doc; also catches the
  // post-upsert schema-invalid case).
  const afterShape = validatePlaybooksShape(doc)
  if (afterShape) {
    return { ok: false, code: 'playbooks-invalid', message: `playbooks.json: ${afterShape}` }
  }
  const afterSchema = validateInstance(doc, playbooksSchema())
  if (!afterSchema.valid) {
    const first = afterSchema.errors[0]
    return {
      ok: false,
      code: 'playbooks-invalid',
      message: `playbooks.json: ${first ? `${first.path} ${first.keyword}: ${first.detail}` : 'schema validation failed'}`,
    }
  }

  // Serialize + 64 KiB oversize refusal (NSP G3).
  const serialized = JSON.stringify(doc, null, 2) + '\n'
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > PLAYBOOKS_MAX_BYTES) {
    return {
      ok: false,
      code: 'playbooks-oversize',
      message: `playbooks.json: resulting document exceeds the 64 KiB bound (${bytes} bytes)`,
    }
  }

  // Atomic write (NSP G4 disposition: accept-and-convert symlinks; uniform
  // with every atomicReplaceFileSync consumer).
  atomicReplaceFileSync(target, serialized)

  // Compute build-cap note (RFC-015 R3: session_start count > max_playbooks
  // → ok:true with buildCapped:true; the advisory carries the note).
  let buildCapped = false
  if (entry.mode === 'session_start') {
    const sessionStartCount = doc.playbooks.filter((e) => e && e.mode === 'session_start').length
    const maxPlaybooks = (doc.bounds && Number.isInteger(doc.bounds.max_playbooks)) ? doc.bounds.max_playbooks : 2
    if (sessionStartCount > maxPlaybooks) buildCapped = true
  }

  return { ok: true, entry, created, buildCapped }
}

/**
 * buildConsolidationAdvisory({ localDataDir, protectedClusters, substitutedClusters })
 *   → ConsolidationAdvisory | null
 *
 * RFC-015 R4c. Two live triggers:
 *   (i)  a cluster skipped because a member belongs to a DECLARED chain — the
 *        operator needs to know why curation did not happen, and how to allow it;
 *   (ii) a marker-bearing but UNDECLARED member consolidated into a digest — the
 *        marker alone protects nothing (RFC-015:148), so this one really is the
 *        content substitution Problem 2a describes.
 *
 * Returns null when neither fired, so a non-playbook store's stdout stays
 * byte-identical to the pre-RFC-015 shape (Principle 6, zero cost when unused).
 * Advisory only — nothing here blocks (B-1). Never throws.
 *
 * @param {{
 *   localDataDir: string,
 *   protectedClusters?: Array<{members: string[], reason: string, via: string|null}>,
 *   substitutedClusters?: Array<{resolves_to: string, kind: 'digest'|'canonical', members: string[]}>,
 * }} args
 */
// Review r2 F3: ONE constant, shared by partitionProtectionSkips (which matches by
// prefix) and by the advisory (which matched the literal exactly). Two duplicated
// literals would drift the moment a second playbook protection class is added:
// the partition would classify it as protection while the advisory silently dropped
// it, yielding a skip with no advisory and no error. Defined here rather than
// exported from protection.mjs so that file stays byte-identical (RFC:141).
export const PLAYBOOK_PROTECTION_CLASS = 'playbook-referenced'
export const PLAYBOOK_PROTECTION_REASON = `protected:${PLAYBOOK_PROTECTION_CLASS}`

export function buildConsolidationAdvisory({ localDataDir, playbookIds, protectedClusters, markedConsolidations }) {
  const declared = new Set(Array.isArray(playbookIds) ? playbookIds : [])
  // Callers MUST pass only playbook-caused skips (partitionProtectionSkips's
  // playbookSkips). This filter is defence in depth: an advisory that calls a
  // `pinned` or `trigger-bearing-lesson` skip a declared playbook chain, and tells
  // the operator to edit a playbooks.json that may not exist, is a false statement
  // (review r1 F3). Belt and braces, because both apply paths feed this and the
  // clerk's skippedGuard also carries non-protection entries like
  // `canonical-superseded` (em-consolidate.mjs:1935).
  const prot = (Array.isArray(protectedClusters) ? protectedClusters : [])
    .filter(p => p && p.reason === PLAYBOOK_PROTECTION_REASON)
  const marked = Array.isArray(markedConsolidations) ? markedConsolidations : []
  if (prot.length === 0 && marked.length === 0) return null
  const base = { project_store: localDataDir }
  try {
    const notes = []
    const out = { ...base }
    if (prot.length) {
      out.protected_declarations = prot.map(p => ({
        declaration_id: declared.has(p.via) ? p.via : null,
        members: p.members,
        reason: p.reason,
      }))
      notes.push(
        `${prot.length} cluster(s) were not consolidated because a member belongs to a declared playbook chain; ` +
        'to allow consolidation, remove the declaration from this project\'s playbooks.json first'
      )
    }
    if (marked.length) {
      // NOT called a "substitution": these members carry the marker but are NOT
      // declared, so nothing renders them and nothing is being substituted
      // (review r1 F3). The marker is inherited so the digest stays discoverable
      // by the R1 detection predicate and by em-doctor's playbook-unregistered check.
      out.marker_inheritance = marked.map(s => ({
        resolves_to: s.resolves_to,
        kind: s.kind,
        members: s.members,
      }))
      notes.push(
        `${marked.length} consolidation(s) folded a playbook-marked but UNDECLARED episode; the marker was ` +
        'inherited by the result, whose body is now the auto-generated digest — re-curate it before declaring it'
      )
    }
    out.note = notes.join('; ')
    return out
  } catch (e) {
    return { ...base, note: `advisory computation failed: ${e && e.message ? e.message : String(e)}` }
  }
}
