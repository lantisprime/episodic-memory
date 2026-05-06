#!/usr/bin/env node
/**
 * em-rfc-validate.mjs — Validate RFC registry consistency.
 *
 * Cross-checks three sources of truth for RFC metadata:
 *   1. docs/rfcs/_index.json     (machine-readable registry)
 *   2. RFC file frontmatter      (rfc_id, title, status in each RFC-NNN-*.md)
 *   3. docs/rfcs/README.md       (Active RFCs table)
 *
 * Any drift in (id, title, status) across the three is reported as a violation.
 * Sub-plan files (RFC-NNN-*-plan.md, *-review.md, *-phase*.md) without an
 * `rfc_id:` frontmatter field are skipped — they are RFC sub-documents, not
 * canonical RFCs.
 *
 * Usage:
 *   node scripts/em-rfc-validate.mjs              # human-readable output
 *   node scripts/em-rfc-validate.mjs --json       # JSON output for CI
 *   node scripts/em-rfc-validate.mjs --rfcs-dir <path>  # override default
 *
 * Exit codes:
 *   0 — no drift; registry consistent
 *   1 — drift detected (one or more violations)
 *   2 — usage error or missing input file
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const dirIdx = argv.indexOf('--rfcs-dir')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const rfcsDir = dirIdx >= 0 ? path.resolve(argv[dirIdx + 1]) : path.join(repoRoot, 'docs', 'rfcs')

function fail(message, code = 2) {
  process.stdout.write(JSON.stringify({ status: 'error', message }) + '\n')
  process.exit(code)
}

if (!fs.existsSync(rfcsDir)) fail(`RFC directory not found: ${rfcsDir}`)

const indexPath = path.join(rfcsDir, '_index.json')
const readmePath = path.join(rfcsDir, 'README.md')

if (!fs.existsSync(indexPath)) fail(`_index.json not found at ${indexPath}`)
if (!fs.existsSync(readmePath)) fail(`README.md not found at ${readmePath}`)

// ---------------------------------------------------------------------------
// Source 1: _index.json
// ---------------------------------------------------------------------------
let registry
try {
  registry = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
} catch (e) {
  fail(`_index.json is not valid JSON: ${e.message}`)
}
if (!Array.isArray(registry?.rfcs)) fail(`_index.json missing required key "rfcs" (array)`)

// ---------------------------------------------------------------------------
// Source 2: frontmatter from each canonical RFC file
// ---------------------------------------------------------------------------
const RFC_ID_RE = /^RFC-(\d{3})$/
function parseFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const lines = m[1].split(/\r?\n/)
  const fm = {}
  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (!kv) continue
    let val = kv[2].trim()
    // Strip leading/trailing quotes (frontmatter titles are sometimes quoted)
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    fm[kv[1]] = val
  }
  return fm
}

const allFiles = fs.readdirSync(rfcsDir)
  .filter(f => /^RFC-\d{3}-.+\.md$/.test(f))
  .sort()
const fileFm = []
for (const f of allFiles) {
  const fm = parseFrontmatter(path.join(rfcsDir, f))
  if (!fm || !fm.rfc_id) continue  // sub-plan, not a canonical RFC
  if (!RFC_ID_RE.test(fm.rfc_id)) continue
  fileFm.push({ file: f, fm })
}

// ---------------------------------------------------------------------------
// Source 3: README Active RFCs table
// ---------------------------------------------------------------------------
const readme = fs.readFileSync(readmePath, 'utf8')
const tableMatch = readme.match(/##\s+Active RFCs\s*\n\s*\n\s*\|\s*RFC\s*\|[\s\S]*?\n\s*\n/)
if (!tableMatch) fail(`Could not locate "## Active RFCs" markdown table in README.md`)
const tableLines = tableMatch[0].split(/\r?\n/).filter(l => l.trim().startsWith('|'))
// Skip header row + separator row
const tableRows = tableLines.slice(2).map(line => {
  const cells = line.split('|').slice(1, -1).map(c => c.trim())
  if (cells.length < 4) return null
  return { id: cells[0], title: cells[1], status: cells[2], champion: cells[3] }
}).filter(Boolean)

// ---------------------------------------------------------------------------
// Cross-check
// ---------------------------------------------------------------------------
const violations = []

// 1. ID uniqueness across files
const idCount = new Map()
for (const { file, fm } of fileFm) {
  const list = idCount.get(fm.rfc_id) ?? []
  list.push(file)
  idCount.set(fm.rfc_id, list)
}
for (const [id, files] of idCount) {
  if (files.length > 1) {
    violations.push({
      kind: 'duplicate-id-across-files',
      id,
      files,
      message: `RFC id "${id}" appears in multiple canonical files: ${files.join(', ')}. Each canonical RFC must have a unique id.`,
    })
  }
}

// 2. Filename prefix matches frontmatter rfc_id
for (const { file, fm } of fileFm) {
  const filePrefix = file.match(/^(RFC-\d{3})-/)?.[1]
  if (filePrefix && filePrefix !== fm.rfc_id) {
    violations.push({
      kind: 'filename-id-mismatch',
      file,
      filePrefix,
      frontmatterId: fm.rfc_id,
      message: `${file}: filename prefix "${filePrefix}" does not match frontmatter rfc_id "${fm.rfc_id}".`,
    })
  }
}

// 3. Each file has a registry entry, and vice versa
const registryById = new Map(registry.rfcs.map(r => [r.id, r]))
const fileById = new Map(fileFm.map(({ file, fm }) => [fm.rfc_id, { file, fm }]))

for (const { file, fm } of fileFm) {
  if (!registryById.has(fm.rfc_id)) {
    violations.push({
      kind: 'file-not-in-index',
      file,
      id: fm.rfc_id,
      message: `${file} (id ${fm.rfc_id}) is not present in _index.json.`,
    })
  }
}
for (const r of registry.rfcs) {
  if (!fileById.has(r.id)) {
    violations.push({
      kind: 'index-not-in-files',
      id: r.id,
      indexFile: r.file,
      message: `_index.json lists ${r.id} (file ${r.file}) but no canonical RFC file with that rfc_id was found.`,
    })
  }
}

// 4. Registry entry matches frontmatter (title, status, champion, file path)
for (const r of registry.rfcs) {
  const f = fileById.get(r.id)
  if (!f) continue  // already reported above
  if (r.file !== f.file) {
    violations.push({
      kind: 'index-file-mismatch',
      id: r.id,
      indexFile: r.file,
      actualFile: f.file,
      message: `${r.id}: _index.json says file is "${r.file}" but the canonical file is "${f.file}".`,
    })
  }
  if (r.title !== f.fm.title) {
    violations.push({
      kind: 'index-frontmatter-title-drift',
      id: r.id,
      indexTitle: r.title,
      frontmatterTitle: f.fm.title,
      message: `${r.id}: title drift between _index.json and frontmatter.\n    _index.json:  ${JSON.stringify(r.title)}\n    frontmatter:  ${JSON.stringify(f.fm.title)}`,
    })
  }
  if (r.status !== f.fm.status) {
    violations.push({
      kind: 'index-frontmatter-status-drift',
      id: r.id,
      indexStatus: r.status,
      frontmatterStatus: f.fm.status,
      message: `${r.id}: status drift — _index.json="${r.status}" frontmatter="${f.fm.status}".`,
    })
  }
  if (r.champion !== f.fm.champion) {
    violations.push({
      kind: 'index-frontmatter-champion-drift',
      id: r.id,
      indexChampion: r.champion,
      frontmatterChampion: f.fm.champion,
      message: `${r.id}: champion drift — _index.json="${r.champion}" frontmatter="${f.fm.champion}".`,
    })
  }
}

// 5. Registry entry matches README table row
const readmeById = new Map(tableRows.map(r => [r.id, r]))
for (const r of registry.rfcs) {
  const row = readmeById.get(r.id)
  if (!row) {
    violations.push({
      kind: 'index-not-in-readme',
      id: r.id,
      message: `${r.id} is in _index.json but missing from README's Active RFCs table.`,
    })
    continue
  }
  if (r.title !== row.title) {
    violations.push({
      kind: 'index-readme-title-drift',
      id: r.id,
      indexTitle: r.title,
      readmeTitle: row.title,
      message: `${r.id}: title drift between _index.json and README table.\n    _index.json:  ${JSON.stringify(r.title)}\n    README table: ${JSON.stringify(row.title)}`,
    })
  }
  if (r.status !== row.status) {
    violations.push({
      kind: 'index-readme-status-drift',
      id: r.id,
      indexStatus: r.status,
      readmeStatus: row.status,
      message: `${r.id}: status drift — _index.json="${r.status}" README="${row.status}".`,
    })
  }
  if (r.champion !== row.champion) {
    violations.push({
      kind: 'index-readme-champion-drift',
      id: r.id,
      indexChampion: r.champion,
      readmeChampion: row.champion,
      message: `${r.id}: champion drift — _index.json="${r.champion}" README="${row.champion}".`,
    })
  }
}
for (const row of tableRows) {
  if (!registryById.has(row.id)) {
    violations.push({
      kind: 'readme-not-in-index',
      id: row.id,
      message: `${row.id} is in README's Active RFCs table but missing from _index.json.`,
    })
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
if (jsonMode) {
  process.stdout.write(JSON.stringify({
    status: violations.length === 0 ? 'ok' : 'fail',
    rfcs_in_index: registry.rfcs.length,
    rfcs_in_files: fileFm.length,
    rfcs_in_readme: tableRows.length,
    violations,
  }, null, 2) + '\n')
} else {
  if (violations.length === 0) {
    console.log(`✓ RFC registry consistent: ${registry.rfcs.length} RFCs in _index.json, ${fileFm.length} canonical files, ${tableRows.length} README table rows.`)
  } else {
    console.log(`✗ ${violations.length} RFC registry violation(s):\n`)
    for (const v of violations) {
      console.log(`  [${v.kind}] ${v.message}`)
    }
    console.log(`\nFix: ensure (frontmatter | _index.json | README table) all agree on (id, title, status, champion) for every canonical RFC.`)
  }
}

process.exit(violations.length === 0 ? 0 : 1)
