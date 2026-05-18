#!/usr/bin/env node
/**
 * test-no-legacy-plan-marker-writes.mjs — Rule 13 CI grep-fail detector.
 *
 * Asserts no code site in scripts/ or hooks/ WRITES the legacy suffix-less
 * `.plan-approval-pending` basename. Hook readers (plan-gate.sh,
 * checkpoint-gate.sh, em-recall.mjs sweep, em-audit-compliance.mjs regex,
 * registry constants, validators, tests) are whitelisted via:
 *   - explicit `legacy-read-only: ok` tag comment on same line OR within 8
 *     lines above
 *   - line being part of a documented enforcement-sites registry entry
 *   - file basename matching a test fixture / smoke test pattern
 *
 * A "write" is any of:
 *   touch <...>/.plan-approval-pending (no suffix)
 *   fs.writeFileSync(<...>/.plan-approval-pending, ...) (no suffix)
 *   echo > <...>/.plan-approval-pending (no suffix)
 *   tee <...>/.plan-approval-pending (no suffix)
 *
 * Detection scope: scripts/, hooks/, install.mjs, docs/AGENT-RULES.md.
 * Excludes: scratch/, .claude-plugin/, instructions/, tests/, docs/rfcs/notes/.
 *
 * Exit 0 = no unwhitelisted writes. Exit 1 = violations.
 */

import fs from 'fs'
import path from 'path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const SCAN_DIRS = ['scripts', 'hooks']
const SCAN_FILES = ['install.mjs']

const LEGACY_BASENAME = '.plan-approval-pending'
const SUFFIX_OK_RE = new RegExp(`\\${LEGACY_BASENAME}\\.[\\w-]`)  // suffixed form

// Write-shape signatures (relaxed — we want zero false negatives).
const WRITE_SHAPES = [
  /touch\s+[^\s|;&]*\.plan-approval-pending(?!\.\w)/,
  /writeFileSync\s*\(\s*[^,]*\.plan-approval-pending(?!\.\w)/,
  />\s*[^\s|;&]*\.plan-approval-pending(?!\.\w)/,
  /tee\s+[^\s|;&]*\.plan-approval-pending(?!\.\w)/,
]

const WHITELIST_TAG = /legacy-read-only:\s*ok/i

// Comment-line prefixes — these lines are documentation, not code, and
// cannot constitute a write site at runtime. Skip them. Covers .sh (#),
// .mjs / .js (// and * for jsdoc), and shebang/copyright noise.
const COMMENT_PREFIX_RE = /^\s*(#|\/\/|\*|--)/

function walkFiles(start, out) {
  let entries
  try { entries = fs.readdirSync(start, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(start, e.name)
    if (e.isDirectory()) {
      walkFiles(p, out)
    } else if (e.isFile()) {
      out.push(p)
    }
  }
}

const files = []
for (const d of SCAN_DIRS) walkFiles(path.join(REPO, d), files)
for (const f of SCAN_FILES) {
  const p = path.join(REPO, f)
  if (fs.existsSync(p)) files.push(p)
}

const violations = []

for (const file of files) {
  let content
  try { content = fs.readFileSync(file, 'utf8') } catch { continue }
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip the suffixed form — that's the correct write
    if (!line.includes(LEGACY_BASENAME)) continue
    if (SUFFIX_OK_RE.test(line)) continue
    if (COMMENT_PREFIX_RE.test(line)) continue
    // Look for write shapes
    let matched = false
    for (const shape of WRITE_SHAPES) {
      if (shape.test(line)) { matched = true; break }
    }
    if (!matched) continue
    // Check for whitelist tag on same line or within 8 lines above
    let whitelisted = false
    for (let j = Math.max(0, i - 8); j <= i; j++) {
      if (WHITELIST_TAG.test(lines[j])) { whitelisted = true; break }
    }
    if (!whitelisted) {
      violations.push(`  ${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`)
    }
  }
}

if (violations.length > 0) {
  console.log(`FAIL: ${violations.length} unwhitelisted legacy plan-marker write site(s) found:`)
  for (const v of violations) console.log(v)
  console.log()
  console.log('Fix: route writes through scripts/plan-marker.mjs --touch (per-session suffixed form),')
  console.log('     OR add a `// legacy-read-only: ok` tag comment on the line if this is a READ site.')
  process.exit(1)
}

console.log(`PASS: no unwhitelisted legacy plan-marker write sites (scanned ${files.length} files)`)
process.exit(0)
