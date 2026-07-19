// activation.mjs — the single home for the lesson-activation vocabularies and shared
// validators (RFC-009 R1, plan REQ-16b). Both em-store/em-revise (lesson side) and
// em-violation (violation side) import from here so the linkage/validation logic is
// never duplicated — mirroring how P1a's lib/categories.mjs became the single
// category-vocab source.
//
// Fail direction follows the categories.mjs convention:
//   - WRITERS call validateActivation / resolveLinkage → reject the write on !ok
//     (fail CLOSED). validateActivation loads the activity-class vocab LAZILY —
//     only when the fields carry an `activity:` trigger — so a freeform or
//     phrase/tool-only lesson write never depends on the vocab being present (F4).
//   - READERS/builders (em-trigger-index) wrap loadActivationClasses() in try/catch
//     and DEGRADE (exclude + count), never throw (I5).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolveLocalDir } from './local-dir.mjs'
import { STRUCTURED_FIELDS } from './promotion-sources.mjs'
export { STRUCTURED_FIELDS } from './promotion-sources.mjs'

// Resolved relative to this file so the path is symmetric in-repo
// (<repo>/activation-classes.json) and deployed (~/.episodic-memory/activation-classes.json).
export const ACTIVATION_CLASSES_PATH = new URL('../../activation-classes.json', import.meta.url)

// Fixed tool vocabulary (REQ-5, P5) — a small closed constant, NOT a per-project extension.
export const TOOL_IDS = ['claude-code', 'codex', 'opencode', 'pi-agent', 'cursor', 'windsurf']

// One serialization class for every inline-array field this RFC introduces (REQ-2, I4):
// items containing any of these characters would break the unquoted inline-array
// round-trip through em-rebuild-index's generic frontmatter parser.
export const ILLEGAL_ARRAY_CHARS = [',', '[', ']', '"']

// Reviewer F1 (2026-07-08): the four structural chars are not the whole class —
// a raw newline/CR (or any control char) in a serialized value FABRICATES
// adjacent frontmatter keys (e.g. a forged `superseded_by:` line that the band's
// chain resolver then walks). Every serialized activation value rejects control
// chars too; returns the offending char (escaped name) or null.
export function illegalValueChar(s) {
  const str = String(s)
  for (const c of ILLEGAL_ARRAY_CHARS) {
    if (str.includes(c)) return c
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    // control chars + the Unicode line/paragraph separators (U+2028/U+2029):
    // both break em-rebuild-index's `split('\n')` + `/^(\w+):\s*(.*)$/` — a raw
    // \n forges an adjacent key, U+2028 drops the field on rebuild (F1/F2 r2).
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return `\\x${code.toString(16).padStart(2, '0')}`
  }
  return null
}

// Scalar frontmatter values (summary, project, url, each tag) legitimately carry
// prose punctuation — , [ ] " are fine — but NEVER a line-breaking char: a raw
// \n fabricates an adjacent frontmatter key (a forged `evidence:`/`superseded_by:`
// is an earned-band / chain forge that bypasses the linkage gate), and \r or the
// Unicode separators drop the field on rebuild. This is the same forge class as
// illegalValueChar, minus the structural , [ ] " that prose may contain
// (reviewer F1 round 2 — the class spans every serialized value, not just
// activation fields). Returns the offending char (escaped) or null.
export function illegalScalarChar(s) {
  const str = String(s)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return `\\x${code.toString(16).padStart(2, '0')}`
  }
  return null
}

// The activation frontmatter fields (R1). Arrays serialize as unquoted inline arrays;
// scalars as plain values. `evidence` is the lesson→violation back-link; `lessons` is
// the violation→lesson forward-link (REQ-6/7).
export const ACTIVATION_ARRAY_FIELDS = ['triggers', 'applies_to_projects', 'applies_to_tools', 'evidence', 'lessons']
export const ACTIVATION_SCALAR_FIELDS = ['priority', 'review_by']

/**
 * Resolve + parse the activity-class vocabulary. THROWS on any read/parse/shape
 * failure (writer callers fail closed; reader callers catch and degrade).
 * @returns {{version:string, classes:Array<{name:string,description:string,phrases:string[],deprecated_for?:string}>}}
 */
export function loadActivationClasses() {
  const p = process.env.EM_ACTIVATION_CLASSES_PATH || ACTIVATION_CLASSES_PATH
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    throw new Error(`activation-classes.json unloadable: ${e.message}`)
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(`activation-classes.json unloadable: ${e.message}`)
  }
  if (!doc || !Array.isArray(doc.classes)) {
    throw new Error('activation-classes.json unloadable: missing classes array')
  }
  return doc
}

/**
 * Discriminate the trigger kind EXPLICITLY from the value prefix (REQ-12: the
 * index carries trigger_kind; kind is never inferred downstream from value syntax).
 * @param {string} value
 * @returns {"phrase"|"tool"|"activity"}
 */
export function parseTriggerKind(value) {
  if (typeof value === 'string' && value.startsWith('tool:')) return 'tool'
  if (typeof value === 'string' && value.startsWith('activity:')) return 'activity'
  return 'phrase'
}

/**
 * Serialize an inline-array field as UNQUOTED comma-joined items (REQ-2, I4).
 * THROWS naming the field-breaking character when an item would corrupt the
 * round-trip — a backstop behind validateActivation's state B, which rejects
 * the same class at the write surface with a JSON error.
 * @param {string[]} items
 * @returns {string} e.g. "a, b, c" (caller wraps in [ ])
 */
export function serializeInlineArray(items) {
  const out = []
  for (const item of items) {
    const s = String(item).trim()
    const bad = illegalValueChar(s)
    if (bad !== null) throw new Error(`inline-array item ${JSON.stringify(s)} contains illegal character ${JSON.stringify(bad)}`)
    if (s) out.push(s)
  }
  return out.join(', ')
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// The earned-band explanation (REQ-3) — fixture-asserted; keep the wording stable.
export const EARNED_BAND_MESSAGE = '--priority must be an integer 1-7. The 8-9 critical band is EARNED from linked violations at trigger-index build time (RFC-009 R1/R2), never writer-declarable.'

/**
 * WRITE-path activation validation (§12 states A-G) — fail-closed.
 *
 * `fields` carries ONLY the values the caller actually received (present-only;
 * an omitted flag is absent/undefined, never defaulted before this call). When
 * no activation input is present at all the write is freeform: `{ok:true,
 * fields:null}` and the caller stores exactly as today (EC15).
 *
 * On success with activation input, returns `{ok:true, fields}` where `fields`
 * is the normalized present-only object with `priority` defaulted to 5 (REQ-3:
 * the default is materialized into frontmatter/index whenever activation is in
 * play, so the R2 build always has a stored priority to start from).
 *
 * @param {{triggers?:string[], applies_to_projects?:string[], applies_to_tools?:string[],
 *          priority?:number|string, review_by?:string, evidence?:string[]}} fields
 * @param {{category:string}} opts
 * @returns {{ok:true, fields:object|null}|{ok:false, errors:Array<{field:string, reason:string, message:string}>}}
 */
export function validateActivation(fields, { category } = {}) {
  const f = fields || {}
  const arrays = {
    triggers: Array.isArray(f.triggers) ? f.triggers : [],
    applies_to_projects: Array.isArray(f.applies_to_projects) ? f.applies_to_projects : [],
    applies_to_tools: Array.isArray(f.applies_to_tools) ? f.applies_to_tools : [],
    evidence: Array.isArray(f.evidence) ? f.evidence : [],
  }
  const hasAny =
    arrays.triggers.length > 0 ||
    arrays.applies_to_projects.length > 0 ||
    arrays.applies_to_tools.length > 0 ||
    arrays.evidence.length > 0 ||
    f.priority !== undefined ||
    f.review_by !== undefined

  if (!hasAny) return { ok: true, fields: null }

  const errors = []

  // State A — activation fields are lesson-only (REQ-1).
  if (category !== 'lesson') {
    const offending = []
    if (arrays.triggers.length) offending.push('triggers')
    if (arrays.applies_to_projects.length) offending.push('applies_to_projects')
    if (arrays.applies_to_tools.length) offending.push('applies_to_tools')
    if (arrays.evidence.length) offending.push('evidence')
    if (f.priority !== undefined) offending.push('priority')
    if (f.review_by !== undefined) offending.push('review_by')
    for (const field of offending) {
      errors.push({ field, reason: 'activation-fields-lesson-only', message: `"${field}" is an activation field, valid only with --category lesson (got "${category}")` })
    }
    return { ok: false, errors }
  }

  // State B — inline-array items must survive the unquoted round-trip (REQ-2).
  // Reviewer F1: control chars (\n, \r, ...) are in the same class as the four
  // structural chars — a newline fabricates adjacent frontmatter keys.
  for (const [field, items] of Object.entries(arrays)) {
    for (const item of items) {
      const s = String(item)
      const bad = illegalValueChar(s)
      if (bad !== null) {
        errors.push({ field, reason: `illegal-char:${bad}`, message: `"${field}" item ${JSON.stringify(s)} contains illegal character ${JSON.stringify(bad)} — inline-array items may not contain , [ ] " or control characters` })
      }
      if (!s.trim()) {
        errors.push({ field, reason: 'empty-item', message: `"${field}" contains an empty item` })
      }
    }
  }

  // State C — priority is an integer 1-7; 8-9 is the EARNED band (REQ-3, P4/I1).
  let priority = 5
  if (f.priority !== undefined) {
    const n = typeof f.priority === 'number' ? f.priority : Number(f.priority)
    if (!Number.isInteger(n) || n < 1 || n > 7) {
      errors.push({ field: 'priority', reason: 'earned-band', message: EARNED_BAND_MESSAGE })
    } else {
      priority = n
    }
  }

  // State D — review_by is a real YYYY-MM-DD date (REQ-4).
  if (f.review_by !== undefined) {
    const s = String(f.review_by)
    if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
      errors.push({ field: 'review_by', reason: 'bad-date', message: `--review-by "${s}" is not a valid date; accepted shape: YYYY-MM-DD` })
    }
  }

  // State E — tool ids come from the fixed vocabulary (REQ-5).
  for (const tool of arrays.applies_to_tools) {
    if (!TOOL_IDS.includes(String(tool).trim())) {
      errors.push({ field: 'applies_to_tools', reason: 'unknown-tool', message: `unknown tool id "${tool}"; the fixed vocabulary is: ${TOOL_IDS.join(', ')}` })
    }
  }

  // State F — activity-class triggers name a known, non-deprecated class (REQ-17).
  // LAZY vocab load (F4): only when an `activity:` trigger is present. An
  // unloadable vocab at this point fails CLOSED (unknown class), like every
  // other writer path.
  const activityTriggers = arrays.triggers.filter(t => parseTriggerKind(String(t)) === 'activity')
  if (activityTriggers.length > 0) {
    let classes = null
    try {
      classes = loadActivationClasses().classes
    } catch {
      classes = null
    }
    for (const t of activityTriggers) {
      const cls = String(t).slice('activity:'.length)
      const member = classes ? classes.find(k => k && k.name === cls) : undefined
      if (!member || member.deprecated_for) {
        errors.push({ field: 'triggers', reason: 'unknown-activity-class', message: `activity class "${cls}" is ${member ? 'deprecated' : 'unknown'} in activation-classes.json; known classes: ${classes ? classes.filter(k => !k.deprecated_for).map(k => k.name).join(', ') : '(vocabulary unloadable)'}` })
      }
    }
  }

  if (errors.length) return { ok: false, errors }

  // State G — normalized present-only output; priority is materialized (default 5).
  const out = { priority }
  if (arrays.triggers.length) out.triggers = arrays.triggers.map(t => String(t).trim())
  if (arrays.applies_to_projects.length) out.applies_to_projects = arrays.applies_to_projects.map(t => String(t).trim())
  if (arrays.applies_to_tools.length) out.applies_to_tools = arrays.applies_to_tools.map(t => String(t).trim())
  if (arrays.evidence.length) out.evidence = arrays.evidence.map(t => String(t).trim())
  if (f.review_by !== undefined) out.review_by = String(f.review_by)
  return { ok: true, fields: out }
}

/**
 * Parse the activation/linkage/T6 fields out of an episode file's frontmatter
 * (reviewer F3: em-revise INHERITS these from the original unless overridden —
 * tags already inherit, so silent activation loss on revision was an asymmetry).
 * Mirrors em-rebuild-index's generic parser for the subset the writers emit.
 * @param {string} content full episode .md content
 * @returns {{triggers?:string[], applies_to_projects?:string[], applies_to_tools?:string[],
 *            evidence?:string[], lessons?:string[], priority?:number, review_by?:string,
 *            violated_pattern?:string, promotion_sources?:object[]}}
 */
export function parseActivationFromFrontmatter(content) {
  const out = {}
  const match = String(content).match(/^---\n([\s\S]*?)\n---/)
  if (!match) return out
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    if (STRUCTURED_FIELDS.includes(key)) {
      out[key] = JSON.parse(raw)
    } else if (ACTIVATION_ARRAY_FIELDS.includes(key)) {
      const arr = raw.match(/^\[(.*)\]$/)
      if (arr) out[key] = arr[1].split(',').map(s => s.trim()).filter(Boolean)
    } else if (key === 'priority') {
      const n = Number(raw)
      if (Number.isInteger(n)) out.priority = n
    } else if (key === 'review_by') {
      out.review_by = raw
    } else if (key === 'violated_pattern') {
      out.violated_pattern = raw
    }
  }
  return out
}

/**
 * Read BOTH scopes' index.jsonl and concat into one row array (F1: em-store and
 * em-violation have no index reader of their own; linkage resolution MUST be
 * merged, never per-active-scope — a local lesson legitimately links a global
 * violation and vice-versa). Malformed lines are skipped; a missing index file
 * contributes zero rows. Local rows come first so a local row wins any
 * first-match-by-id lookup, mirroring em-search's local precedence.
 *
 * @param {{localDir?:string, globalDir?:string}} [opts] test injection points;
 *   defaults resolve the same way the em-* writers do.
 * @returns {Array<object>}
 */
export function loadMergedIndex({ localDir, globalDir } = {}) {
  const dirs = [
    localDir !== undefined ? localDir : resolveLocalDir(),
    globalDir !== undefined ? globalDir : path.join(os.homedir(), '.episodic-memory'),
  ]
  const rows = []
  for (const dir of dirs) {
    if (!dir) continue
    let raw
    try {
      raw = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {}
    }
  }
  return rows
}

/**
 * WRITE-path linkage resolution (REQ-6/7, I2) — fail-closed and SYMMETRIC
 * across both directions: `--evidence` requires each id to resolve to an
 * existing `category: violation` row; `--lesson` to an existing
 * `category: lesson` row. The caller passes the MERGED index rows
 * (loadMergedIndex()); resolution is never per-active-scope (F1).
 *
 * @param {string[]} ids
 * @param {{requireCategory:string, index:Array<object>}} opts
 * @returns {{ok:boolean, missing:string[], wrongCategory:string[]}}
 */
export function resolveLinkage(ids, { requireCategory, index }) {
  const byId = new Map()
  for (const row of index) {
    if (row && typeof row.id === 'string' && !byId.has(row.id)) byId.set(row.id, row)
  }
  const missing = []
  const wrongCategory = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) missing.push(id)
    else if (row.category !== requireCategory) wrongCategory.push(id)
  }
  return { ok: missing.length === 0 && wrongCategory.length === 0, missing, wrongCategory }
}
