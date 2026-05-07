#!/usr/bin/env node
/**
 * validate-rfc-canonical-fields.mjs — RFC-004 §689-719 CI gate.
 *
 * Validates the canonical-fields specification block in RFC-004:
 *
 *   1. Generic fields are present (run_id, parent_episode, type,
 *      expected_post_episode_id, summary, body_sha256).
 *   2. All registered state-transition:* subtypes have their declared
 *      fields present in the spec block.
 *   3. No duplicate state-transition:* subtype headings (AC2).
 *   4. No registered field is missing from the RFC body (BL1 — catches
 *      row deletions in the spec, not just additions).
 *
 * Source-of-truth in code: scripts/lib/bp1-canonicalize.mjs
 *   GENERIC_CANONICAL_FIELDS + TYPE_SPECIFIC_CANONICAL_FIELDS.
 *
 * Source-of-truth in spec: RFC-004 §689-719 (the `payload = { ... }` block).
 *
 * The validator parses the RFC's payload block and asserts that for every
 * field listed in the lib's tables, the field name appears in the RFC body.
 * This catches silent spec drift in either direction (lib adds a field
 * without RFC update; RFC removes a field without lib update).
 *
 * Per Rule 14 (machine-readable blocks for drift-prone state), the lib
 * tables ARE the machine-readable mirror; this validator diffs them
 * against the RFC prose.
 *
 * Usage:
 *   node validate-rfc-canonical-fields.mjs                       # docs/rfcs/rfc-004*
 *   node validate-rfc-canonical-fields.mjs <path-to.md>          # validate one file
 *   node validate-rfc-canonical-fields.mjs --json
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  GENERIC_CANONICAL_FIELDS,
  TYPE_SPECIFIC_CANONICAL_FIELDS,
} from './lib/bp1-canonicalize.mjs'

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const positional = argv.filter(a => !a.startsWith('--'))

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const RFCS_DIR = path.join(REPO, 'docs', 'rfcs')

// ---------------------------------------------------------------------------
// File targeting
// ---------------------------------------------------------------------------

let targets
if (positional.length > 0) {
  targets = positional.map(p => path.resolve(p))
} else if (fs.existsSync(RFCS_DIR)) {
  targets = fs.readdirSync(RFCS_DIR)
    .filter(f => /^rfc-004/i.test(f) && f.endsWith('.md'))
    .map(f => path.join(RFCS_DIR, f))
} else {
  targets = []
}

const results = []
for (const file of targets) {
  results.push(validateFile(file))
}

if (wantJson) {
  process.stdout.write(JSON.stringify({ results }, null, 2) + '\n')
} else {
  for (const r of results) {
    if (r.skipped) {
      process.stdout.write(`SKIP ${r.file}: ${r.reason}\n`)
    } else if (r.violations.length === 0) {
      process.stdout.write(`OK   ${r.file} (${r.fieldsChecked} canonical fields)\n`)
    } else {
      process.stdout.write(`FAIL ${r.file}\n`)
      for (const v of r.violations) {
        process.stdout.write(`     ${v}\n`)
      }
    }
  }
}

const hasFailures = results.some(r => r.violations.length > 0)
process.exit(hasFailures ? 1 : 0)

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateFile(file) {
  const result = { file, skipped: false, reason: null, violations: [], fieldsChecked: 0 }
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    result.violations.push(`cannot read: ${e.message}`)
    return result
  }

  // Locate the canonical-fields spec block.
  // Marker: a line containing "canonical = sha256(JSON.stringify(payload"
  // followed by a `payload = {` block. Body is taken until the matching `}`
  // at the start of a line.
  const blockMatch = text.match(/payload\s*=\s*\{([\s\S]*?)\n\}\s*\n/)
  if (!blockMatch) {
    result.skipped = true
    result.reason = 'no `payload = { ... }` canonical-fields block found'
    return result
  }
  const blockText = blockMatch[1]

  // Build the union of fields registered in lib tables.
  const libFields = new Set(GENERIC_CANONICAL_FIELDS)
  const seenSubtypes = new Set()
  for (const subtypeKey of Object.keys(TYPE_SPECIFIC_CANONICAL_FIELDS)) {
    if (seenSubtypes.has(subtypeKey)) {
      result.violations.push(`duplicate subtype key in lib registration: ${subtypeKey} (AC2)`)
      continue
    }
    seenSubtypes.add(subtypeKey)
    for (const field of TYPE_SPECIFIC_CANONICAL_FIELDS[subtypeKey]) {
      libFields.add(field)
    }
  }

  // Direction 1: every lib-registered field must appear in the RFC body.
  // Catches BL1 (RFC removed a row that the lib still depends on).
  for (const field of GENERIC_CANONICAL_FIELDS) {
    if (!fieldPresent(blockText, field)) {
      result.violations.push(`generic canonical field missing from RFC body: ${field}`)
    }
    result.fieldsChecked++
  }
  for (const subtypeKey of Object.keys(TYPE_SPECIFIC_CANONICAL_FIELDS)) {
    for (const field of TYPE_SPECIFIC_CANONICAL_FIELDS[subtypeKey]) {
      // 'state' is shared across many subtypes — count it once.
      if (field === 'state') {
        if (fieldPresent(blockText, 'state')) {
          result.fieldsChecked++
        } else {
          result.violations.push(`${subtypeKey} canonical field missing from RFC body: state (BL1)`)
        }
        continue
      }
      if (!fieldPresent(blockText, field)) {
        result.violations.push(
          `${subtypeKey} canonical field missing from RFC body: ${field} (BL1)`,
        )
      }
      result.fieldsChecked++
    }
  }

  // Direction 2 (codex round-1 C2 fix): every field NAMED in the RFC payload
  // block must also be registered in the lib tables. Catches the case where
  // the RFC adds a new canonical field but the lib hasn't been updated.
  // Identifiers parsed: lines matching `^  <ident>,\s*//.*` or `^  <ident>,$`
  // (lowercase identifiers ending with a comma; comments may follow).
  const RFC_IDENTIFIER_RE = /^\s{2,}([a-z][a-z0-9_]*)\s*,/gm
  const rfcFields = new Set()
  let m
  while ((m = RFC_IDENTIFIER_RE.exec(blockText)) !== null) {
    rfcFields.add(m[1])
  }
  for (const rfcField of rfcFields) {
    if (!libFields.has(rfcField)) {
      result.violations.push(
        `RFC payload block names canonical field NOT registered in lib tables: ${rfcField} (C2 — bidirectional drift)`,
      )
    }
  }

  return result
}

/**
 * Returns true iff `field` appears in `blockText` as a standalone identifier.
 * Matches `field,` or `field` at end-of-line, NOT substring-of-other-identifier.
 *
 * @param {string} blockText
 * @param {string} field
 * @returns {boolean}
 */
function fieldPresent(blockText, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[\\s])${escaped}\\s*[,]?(?:\\s|$)`, 'm')
  return re.test(blockText)
}
