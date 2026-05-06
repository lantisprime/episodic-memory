#!/usr/bin/env node
/**
 * validate-rfc-failure-table.mjs — RFC-004 §1072 CI gate.
 *
 * Parses the §11.5 failure-table prose markdown table AND the YAML mirror
 * block beneath it; rejects:
 *   - duplicate IDs (in either representation)
 *   - prose↔YAML drift (id set parity, evidence tag parity, lesson parity)
 *   - evidence-tag references that don't match the bp1-* vocabulary
 *
 * Targets: any RFC under docs/rfcs/ that contains both a markdown table
 * with header `| # | Failure | ... | Evidence | Lesson? |` and a fenced
 * `yaml` block with `failure_modes:`. RFCs without that pair are skipped.
 *
 * Per Rule 14 (machine-readable blocks for drift-prone state).
 *
 * Usage:
 *   node validate-rfc-failure-table.mjs                # scan docs/rfcs/
 *   node validate-rfc-failure-table.mjs <path-to.md>   # validate one file
 *   node validate-rfc-failure-table.mjs --json         # machine-readable output
 */

import fs from 'fs'
import path from 'path'

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const positional = argv.filter(a => !a.startsWith('--'))

const EVIDENCE_TAG_RE = /^bp1-[a-z][a-z0-9-]*$/

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const RFCS_DIR = path.join(REPO, 'docs', 'rfcs')

const targets = positional.length
  ? positional.map(p => path.resolve(p))
  : fs.existsSync(RFCS_DIR)
    ? fs.readdirSync(RFCS_DIR).filter(f => f.endsWith('.md')).map(f => path.join(RFCS_DIR, f))
    : []

const results = []
for (const file of targets) {
  results.push(validateFile(file))
}

const failed = results.filter(r => r.violations.length > 0)
const skipped = results.filter(r => r.skipped)

if (wantJson) {
  console.log(JSON.stringify({
    status: failed.length ? 'fail' : 'ok',
    files_checked: results.length,
    files_skipped: skipped.length,
    files_failed: failed.length,
    results,
  }, null, 2))
} else {
  for (const r of results) {
    if (r.skipped) continue
    if (r.violations.length === 0) {
      console.log(`OK    ${path.relative(REPO, r.file)}: ${r.row_count} rows, ${r.yaml_count} yaml`)
    } else {
      console.log(`FAIL  ${path.relative(REPO, r.file)}:`)
      for (const v of r.violations) {
        console.log(`        ${v.kind}: ${v.detail}`)
      }
    }
  }
  if (skipped.length) {
    console.log(`(skipped ${skipped.length} files without a §11.5-shaped table)`)
  }
}

process.exit(failed.length ? 1 : 0)

// ---------------------------------------------------------------------------
function validateFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  const prose = extractProseTable(text)
  const yaml = extractYamlMirror(text)
  if (!prose && !yaml) {
    return { file, skipped: true, reason: 'no failure-table markers', violations: [] }
  }
  if (!prose) {
    return { file, skipped: false, violations: [{ kind: 'missing-prose-table', detail: 'YAML mirror present but no prose table found' }] }
  }
  if (!yaml) {
    return { file, skipped: false, violations: [{ kind: 'missing-yaml-mirror', detail: 'prose table present but no YAML mirror found' }] }
  }

  const violations = []

  // Duplicate IDs in prose
  const proseIds = new Map()
  for (const row of prose) {
    if (proseIds.has(row.id)) {
      violations.push({ kind: 'duplicate-id-prose', detail: `id ${row.id} appears at prose rows for "${proseIds.get(row.id).failure}" and "${row.failure}"` })
    } else {
      proseIds.set(row.id, row)
    }
  }
  // Duplicate IDs in YAML
  const yamlIds = new Map()
  for (const row of yaml) {
    if (yamlIds.has(row.id)) {
      violations.push({ kind: 'duplicate-id-yaml', detail: `id ${row.id} appears twice in YAML mirror` })
    } else {
      yamlIds.set(row.id, row)
    }
  }
  // ID set parity
  for (const id of proseIds.keys()) {
    if (!yamlIds.has(id)) {
      violations.push({ kind: 'id-in-prose-not-yaml', detail: `id ${id} present in prose but missing from YAML mirror` })
    }
  }
  for (const id of yamlIds.keys()) {
    if (!proseIds.has(id)) {
      violations.push({ kind: 'id-in-yaml-not-prose', detail: `id ${id} present in YAML mirror but missing from prose` })
    }
  }
  // Per-ID drift: evidence tag + lesson
  for (const [id, prow] of proseIds.entries()) {
    const yrow = yamlIds.get(id)
    if (!yrow) continue
    if (prow.evidence_tag !== yrow.evidence) {
      violations.push({ kind: 'evidence-drift', detail: `id ${id}: prose evidence tag "${prow.evidence_tag}" != yaml "${yrow.evidence}"` })
    }
    if (prow.lesson !== yrow.lesson) {
      violations.push({ kind: 'lesson-drift', detail: `id ${id}: prose lesson "${prow.lesson_raw}" (=> ${prow.lesson}) != yaml ${JSON.stringify(yrow.lesson)}` })
    }
  }
  // Evidence-tag pattern
  for (const row of prose) {
    if (!row.evidence_tag) {
      violations.push({ kind: 'evidence-tag-missing', detail: `id ${row.id}: prose evidence cell has no \`bp1-*\` tag` })
    } else if (!EVIDENCE_TAG_RE.test(row.evidence_tag)) {
      violations.push({ kind: 'evidence-tag-shape', detail: `id ${row.id}: prose evidence tag "${row.evidence_tag}" does not match bp1-* pattern` })
    }
  }
  for (const row of yaml) {
    if (typeof row.evidence !== 'string' || !EVIDENCE_TAG_RE.test(row.evidence)) {
      violations.push({ kind: 'evidence-tag-shape-yaml', detail: `id ${row.id}: yaml evidence "${row.evidence}" does not match bp1-* pattern` })
    }
  }

  return { file, skipped: false, row_count: prose.length, yaml_count: yaml.length, violations }
}

// Match the §11.5 prose table by header signature.
function extractProseTable(text) {
  const lines = text.split('\n')
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\|\s*#\s*\|\s*Failure\s*\|/i.test(line) && /Evidence/i.test(line) && /Lesson/i.test(line)) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) return null
  // Skip the divider row
  const rows = []
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) break
    const cells = parseRow(line)
    if (cells.length < 6) continue
    const id = parseInt(cells[0], 10)
    if (Number.isNaN(id)) continue
    const evidenceCell = cells[4]
    const evidenceTagMatch = evidenceCell.match(/`(bp1-[a-z0-9-]+)`/)
    const lessonRaw = cells[5].trim().toLowerCase()
    const lesson = lessonRaw === 'yes' ? true
      : lessonRaw === 'no' ? false
      : lessonRaw === 'conditional' ? 'conditional'
      : lessonRaw // unknown → preserve raw for drift detection
    rows.push({
      id,
      failure: cells[1].trim(),
      detector: cells[2].trim(),
      terminal: cells[3].trim(),
      evidence_cell: evidenceCell.trim(),
      evidence_tag: evidenceTagMatch ? evidenceTagMatch[1] : null,
      lesson_raw: lessonRaw,
      lesson,
    })
  }
  return rows.length ? rows : null
}

function parseRow(line) {
  // Split on `|`, dropping the leading + trailing empties.
  const parts = line.split('|')
  if (parts.length < 2) return []
  return parts.slice(1, -1).map(c => c.trim())
}

// Pull the YAML mirror block: a fenced ```yaml ``` block whose first
// non-comment line is `failure_modes:`.
function extractYamlMirror(text) {
  const fenceRe = /```yaml\s*\n([\s\S]*?)\n```/g
  let m
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1]
    if (/^\s*failure_modes:/m.test(body)) {
      return parseFailureModesYaml(body)
    }
  }
  return null
}

// Minimal YAML parser scoped to the failure_modes shape we expect.
// Handles: `failure_modes:` followed by `- id: N` blocks with leaf scalars.
function parseFailureModesYaml(body) {
  const out = []
  const lines = body.split('\n')
  let cur = null
  let inList = false
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '')
    if (!line.trim()) continue
    if (/^\s*failure_modes:\s*$/.test(line)) { inList = true; continue }
    if (!inList) continue
    const itemMatch = line.match(/^\s*-\s+id:\s*(\d+)\s*$/)
    if (itemMatch) {
      if (cur) out.push(cur)
      cur = { id: parseInt(itemMatch[1], 10) }
      continue
    }
    if (!cur) continue
    const kv = line.match(/^\s+([a-zA-Z_][a-zA-Z_0-9]*):\s*(.+?)\s*$/)
    if (kv) {
      const key = kv[1]
      let value = kv[2]
      if (/^"(.*)"$/.test(value)) value = value.slice(1, -1)
      else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1)
      else if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (/^-?\d+$/.test(value)) value = parseInt(value, 10)
      // 'conditional' stays a string
      cur[key] = value
    }
  }
  if (cur) out.push(cur)
  return out
}
