/**
 * rule-nodes.mjs — project `rule` and `rfc` nodes for the RFC-007 graph projection.
 *
 * RFC-007 Phase 2 (issue #588). Read-only: this module never writes.
 *
 * `rule` nodes come from the Claude Code memory corpus
 * (`feedback_*.md`, `reference_*.md`, `MEMORY.md`, `MEMORY_*.md`) and are keyed by
 * slugify(frontmatter `name`). Files with no frontmatter `name:` are SKIPPED and counted —
 * RFC-007:133 forbids filename-derived slugs, so a file without `name:` has no id.
 *
 * `rfc` nodes come from `docs/rfcs/RFC-*.md` and are keyed by frontmatter `rfc_id`,
 * using the same `/^RFC-(\d{3})$/` grammar as scripts/em-rfc-validate.mjs:72 so both
 * RFC readers agree on what an RFC id is.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveRepoRoot } from './local-dir.mjs'

const RULE_GLOB_RE = /^(feedback_.+\.md|reference_.+\.md|MEMORY\.md|MEMORY_.+\.md)$/
const RFC_FILE_RE = /^RFC-.+\.md$/
const RFC_ID_RE = /^RFC-(\d{3})$/

/**
 * RFC-007:124-131. NFC, trim, lowercase, non-alphanumeric to '-', collapse, strip.
 * NO truncation: RFC-007 specifies none, and 101 of 125 live rule names exceed 40 chars,
 * so the repo's existing 40-char-truncating slug helpers are NOT reusable here.
 */
export function slugify(name) {
  return String(name)
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Flat (column-0) YAML frontmatter. Shape follows scripts/em-rfc-validate.mjs:73-91.
 * Indented blocks (e.g. a nested `metadata:`) are intentionally not parsed — Phase 2
 * needs only the top-level `name` and `entry_point` keys.
 * Returns a null-prototype object so a key like `__proto__` cannot pollute.
 */
export function parseFlatFrontmatter(text) {
  const out = Object.create(null)
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    out[kv[1]] = v
  }
  return out
}

/**
 * The Claude Code memory directory for THIS repo.
 *
 * Derived from resolveRepoRoot() (scripts/lib/local-dir.mjs:43), the primitive that walks a
 * linked worktree back to the main repo root. Do NOT use resolveLocalDir() — that returns
 * `<root>/.episodic-memory` (local-dir.mjs:69-71), not the root, and stripping the suffix
 * back off is forbidden.
 *
 * Claude Code names a project directory by replacing every path separator with '-'.
 * That convention is observed, not published; if it changes this returns a non-existent
 * path and rule nodes go to zero (graceful, per REQ-11).
 */
export function resolveRuleDir(cwd = process.cwd()) {
  const root = resolveRepoRoot(cwd)
  const slug = root.split(path.sep).join('-')
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory')
}

/**
 * @returns {{ruleById: Map<string,object>, collisions: string[], skipped: number}}
 * A symlinked directory is skipped: nothing in this module executes file content, but a
 * symlink is the one shape that could redirect the read outside the intended tree.
 */
export function scanRuleNodes(dir) {
  const ruleById = new Map()
  const collisions = []
  let skipped = 0
  let st = null
  try {
    st = fs.lstatSync(dir)
  } catch {
    return { ruleById, collisions, skipped }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    skipped += 1
    return { ruleById, collisions, skipped }
  }
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    skipped += 1
    return { ruleById, collisions, skipped }
  }
  for (const entry of entries.slice().sort()) {
    if (!RULE_GLOB_RE.test(entry)) continue
    const full = path.join(dir, entry)
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    const fm = parseFlatFrontmatter(text)
    const slug = slugify(typeof fm.name === 'string' ? fm.name : '')
    if (!slug) {
      skipped += 1
      continue
    }
    if (ruleById.has(slug)) {
      collisions.push(slug)
      continue
    }
    ruleById.set(slug, {
      id: slug,
      type: 'rule',
      entry_point: /^true$/i.test(fm.entry_point ?? ''),
      file: full,
    })
  }
  return { ruleById, collisions, skipped }
}

/**
 * @returns {{rfcById: Map<string,object>, skipped: number}}
 * Files matching RFC-*.md but lacking a well-formed `rfc_id` are skipped — the live corpus
 * has two (RFC-001-review.md, RFC-002-phase1-plan.md), matching em-rfc-validate.mjs:100.
 */
export function scanRfcNodes(dir) {
  const rfcById = new Map()
  let skipped = 0
  let st = null
  try {
    st = fs.lstatSync(dir)
  } catch {
    return { rfcById, skipped }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    skipped += 1
    return { rfcById, skipped }
  }
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    skipped += 1
    return { rfcById, skipped }
  }
  for (const entry of entries.slice().sort()) {
    if (!RFC_FILE_RE.test(entry)) continue
    const full = path.join(dir, entry)
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    const fm = parseFlatFrontmatter(text)
    if (typeof fm.rfc_id !== 'string' || !RFC_ID_RE.test(fm.rfc_id)) {
      skipped += 1
      continue
    }
    // Asymmetry with scanRuleNodes is deliberate (R2-5): a duplicate rule slug is a
    // user-corpus authoring error the user must fix, so it exits 2. A duplicate rfc_id
    // is impossible in a well-formed repo because em-rfc-validate.mjs already fails CI
    // on it (`duplicate-id-across-files`), so here it degrades to skip+count rather
    // than breaking every graph query on a condition another gate already owns.
    if (rfcById.has(fm.rfc_id)) {
      skipped += 1
      continue
    }
    rfcById.set(fm.rfc_id, {
      id: fm.rfc_id,
      type: 'rfc',
      entry_point: /^true$/i.test(fm.entry_point ?? ''),
      file: full,
    })
  }
  return { rfcById, skipped }
}
