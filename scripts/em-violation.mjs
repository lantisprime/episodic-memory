#!/usr/bin/env node
/**
 * em-violation.mjs — Store a structured behavioral pattern violation.
 *
 * Usage:
 *   node em-violation.mjs --pattern <pattern_id> --summary "<text>"
 *                         (--body "<text>" | --body-file <path>)
 *                         [--sequence "<action1,action2>"] [--correct "<action1,action2>"]
 *                         [--project <name>] [--tags "<extra_tags>"] [--scope global|local]
 *
 * `--body-file` reads the "what happened" body from a file (UTF-8, BOM stripped,
 * exactly one trailing newline stripped). Mutually exclusive with `--body`.
 *
 * Validates pattern exists in patterns/_index.json, auto-tags with
 * violation + behavioral-pattern + violated:<pattern_id>, builds structured
 * body, then delegates to em-store.mjs (always via `--body`, never forwards
 * `--body-file` to the subprocess).
 *
 * Outputs JSON: { status, id, violated_pattern, file, scope }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { readBodyFile } from './lib/body-file.mjs'
import { loadMergedIndex, resolveLinkage } from './lib/activation.mjs'

const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname)
const STORE_SCRIPT = path.join(SCRIPTS_DIR, 'em-store.mjs')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-violation.mjs', usage: 'node em-violation.mjs --pattern <pattern_id> --summary <text> (--body <text> | --body-file <path>) [--sequence <a,b>] [--correct <a,b>] [--project <name>] [--tags <extra>] [--scope global|local] [--lesson <lesson-episode-id>]...' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

// flagAll(name) — collect every value of a repeated flag (copies em-store's
// shape; introduced for --lesson, RFC-009 REQ-7). Skips a position whose value
// starts with `--` (the next flag, not a value).
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

const patternId = flag('--pattern')
const summary = flag('--summary')
const bodyArg = flag('--body')
const bodyFile = flag('--body-file')
const sequence = flag('--sequence')
const correct = flag('--correct')
const project = flag('--project') || path.basename(process.cwd())
const extraTags = flag('--tags')
const scope = flag('--scope') || 'global'
// RFC-009 REQ-7: forward-link the violation to the lesson(s) whose surfacing failed.
const lessons = flagAll('--lesson')

if (bodyArg !== undefined && bodyFile !== undefined) {
  console.log(JSON.stringify({
    status: 'error',
    message: '--body and --body-file are mutually exclusive; pass only one.'
  }))
  process.exit(1)
}

const bodyText = bodyFile !== undefined ? readBodyFile(bodyFile) : bodyArg

// ---------------------------------------------------------------------------
// Validate scope
// ---------------------------------------------------------------------------
const VALID_SCOPES = ['global', 'local']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Validate required args
// ---------------------------------------------------------------------------
if (!patternId || !summary || !bodyText) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Missing required args. Usage: --pattern <pattern_id> --summary "<text>" (--body "<text>" | --body-file <path>) [--sequence "<actions>"] [--correct "<actions>"] [--project <name>] [--tags "<extra>"] [--scope global|local]'
  }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Validate pattern exists in _index.json
// ---------------------------------------------------------------------------
function loadPatternsIndex() {
  // Try project-local first, then global install
  const candidates = [
    path.join(process.cwd(), 'patterns', '_index.json'),
    path.join(os.homedir(), '.episodic-memory', 'patterns', '_index.json')
  ]
  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (data.patterns && Array.isArray(data.patterns)) return data.patterns
    } catch {}
  }
  return null
}

const patterns = loadPatternsIndex()
const knownIds = patterns ? patterns.map(p => p.pattern_id) : []

if (patterns && !knownIds.includes(patternId)) {
  console.log(JSON.stringify({
    status: 'error',
    message: `Unknown pattern "${patternId}". Valid patterns: ${knownIds.join(', ')}`,
    known_patterns: knownIds
  }))
  process.exit(1)
}

if (!patterns) {
  // No _index.json found — warn but proceed (pattern might be valid)
  // This can happen in repos without the patterns directory
}

// ---------------------------------------------------------------------------
// RFC-009 REQ-7: validate --lesson linkage BEFORE any write — SYMMETRIC with
// em-store's --evidence check (I2: same existence + exact-category check, same
// MERGED local+global resolution, F1). Asymmetry here is the earned-band forge
// path (§7): fail closed, no partial write.
// ---------------------------------------------------------------------------
if (lessons.length) {
  const lv = resolveLinkage(lessons, { requireCategory: 'lesson', index: loadMergedIndex() })
  if (!lv.ok) {
    console.log(JSON.stringify({
      status: 'error',
      message: `--lesson must name existing lesson episodes; missing: [${lv.missing.join(', ')}] wrong-category: [${lv.wrongCategory.join(', ')}]`,
      missing: lv.missing, wrong_category: lv.wrongCategory
    }))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Build auto-tags
// ---------------------------------------------------------------------------
// T6 burn-in shim — the `violated:<id>` TAG is descriptive-only now; the typed
// `violated_pattern` frontmatter field (below) is the load-bearing surface.
// Sunset the tag after the dual-read window (issue #457).
const autoTags = ['violation', 'behavioral-pattern', `violated:${patternId}`]
if (extraTags) {
  const extras = extraTags.split(',').map(t => t.trim()).filter(Boolean)
  autoTags.push(...extras)
}
const tagsStr = autoTags.join(',')

// ---------------------------------------------------------------------------
// Build structured body
// ---------------------------------------------------------------------------
const bodyParts = [`## What happened\n\n${bodyText}`]

if (sequence) {
  bodyParts.push(`## Violation sequence\n\n${sequence}`)
} else {
  bodyParts.push(`## Violation sequence\n\nNot specified`)
}

if (correct) {
  bodyParts.push(`## Correct sequence\n\n${correct}`)
} else {
  bodyParts.push(`## Correct sequence\n\nNot specified`)
}

const structuredBody = bodyParts.join('\n\n')

// ---------------------------------------------------------------------------
// Shell out to em-store.mjs
// ---------------------------------------------------------------------------
const args = [
  `--project`, project,
  `--category`, `violation`,
  `--tags`, tagsStr,
  `--summary`, summary,
  `--body`, structuredBody,
  `--scope`, scope,
  // T6 (REQ-8): typed scalar — em-recall preflight + em-pattern-health strikes
  // read THIS field (dual-read with the legacy tag during burn-in).
  `--violated-pattern`, patternId,
]
// REQ-7: forward the (already-validated) lesson links as repeated flags.
for (const l of lessons) args.push('--lesson', l)

try {
  const result = execFileSync('node', [STORE_SCRIPT, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const parsed = JSON.parse(result)

  if (parsed.status === 'ok') {
    console.log(JSON.stringify({
      status: 'ok',
      id: parsed.id,
      violated_pattern: patternId,
      file: parsed.file,
      scope: parsed.scope
    }))
  } else {
    // Pass through em-store errors
    console.log(result)
    process.exit(1)
  }
} catch (e) {
  console.log(JSON.stringify({
    status: 'error',
    message: `em-store.mjs failed: ${e.message}`
  }))
  process.exit(1)
}
