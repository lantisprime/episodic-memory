#!/usr/bin/env node
/**
 * validate-plan-marker-sites.mjs — Plan-marker enforcement-site drift validator.
 *
 * #268 fix: detects when new code references `.plan-approval-pending` without
 * being registered in PLAN_MARKER_ENFORCEMENT_SITES (scripts/lib/marker-paths.mjs).
 * An unregistered reference is a potential drift: either the new code is a
 * legitimate enforcement site that should be in the registry, or it's a
 * comment/test/doc that should be excluded explicitly.
 *
 * Two directions implemented in this initial cut (per plan v6 §5.2):
 *
 *   D0 — Lib parity
 *        scripts/lib/marker-paths.mjs and hooks/lib/marker-paths.sh must agree
 *        on the per-session SID char-class + max length, and the legacy
 *        basename. Drift FAILS the build.
 *
 *   D2 — Bidirectional drift
 *        Grep the codebase for `.plan-approval-pending`. Every hit must be:
 *          (a) inside a registered enforcement-site span (±20 lines), OR
 *          (b) a comment line (`#` or `//` prefix), OR
 *          (c) explicitly annotated `VALIDATOR-IGNORE: <rationale>`, OR
 *          (d) in this validator's own file or the registry source, OR
 *          (e) in a test file (tests/test-*), OR
 *          (f) in a doc file (docs/, *.md, scratch/), OR
 *          (g) in MEMORY.md-class files (~/.claude/projects/.../memory/).
 *        Else → FAIL "unregistered enforcement site at <file>:<line>".
 *
 * D1 (per-kind site coverage), D3 (semantic input matrix), D4 (call-site closure),
 * D5 (authority/effect closure) — deferred to follow-up FU. The above two
 * directions already catch the most common drift class (new unregistered sites
 * + lib/sh constant drift).
 *
 * Usage:
 *   node scripts/validate-plan-marker-sites.mjs              # validate; exit 0/1
 *   node scripts/validate-plan-marker-sites.mjs --json       # JSON output
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — drift detected (one or more failures); details on stderr
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

import {
  PLAN_MARKER_LEGACY_BASENAME,
  PLAN_MARKER_BASENAME_RE,
  PLAN_MARKER_ENFORCEMENT_SITES,
} from './lib/marker-paths.mjs'
import {
  SESSION_ID_CHARCLASS,
  SESSION_ID_MAX_LEN,
  SESSION_ID_MIN_LEN,
} from './lib/session-id.mjs'

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')

const failures = []
let checks = 0

function fail(msg) {
  failures.push(msg)
}

function info(msg) {
  if (!wantJson) process.stdout.write(msg + '\n')
}

// ---------------------------------------------------------------------------
// D0 — Lib parity (.mjs vs .sh)
// ---------------------------------------------------------------------------
function checkLibParity() {
  checks++
  const shPath = path.join(REPO, 'plugins', 'claude-code', 'hooks', 'lib', 'marker-paths.sh')
  let shSource
  try {
    shSource = fs.readFileSync(shPath, 'utf8')
  } catch (e) {
    fail(`D0: cannot read ${shPath}: ${e.message}`)
    return
  }

  // Extract from .sh source: readonly PLAN_MARKER_LEGACY_BASENAME='...'
  // readonly PLAN_MARKER_SUFFIX_CHARCLASS='...'
  // readonly PLAN_MARKER_SUFFIX_MAXLEN=...
  const shLegacyMatch = shSource.match(/readonly\s+PLAN_MARKER_LEGACY_BASENAME=['"]([^'"]+)['"]/)
  const shCharclassMatch = shSource.match(/readonly\s+PLAN_MARKER_SUFFIX_CHARCLASS=['"]([^'"]+)['"]/)
  const shMaxlenMatch = shSource.match(/readonly\s+PLAN_MARKER_SUFFIX_MAXLEN=(\d+)/)

  if (!shLegacyMatch) fail('D0: hooks/lib/marker-paths.sh missing PLAN_MARKER_LEGACY_BASENAME constant')
  else if (shLegacyMatch[1] !== PLAN_MARKER_LEGACY_BASENAME) {
    fail(`D0: legacy basename drift — .mjs="${PLAN_MARKER_LEGACY_BASENAME}" vs .sh="${shLegacyMatch[1]}"`)
  }

  if (!shCharclassMatch) fail('D0: hooks/lib/marker-paths.sh missing PLAN_MARKER_SUFFIX_CHARCLASS constant')
  else if (shCharclassMatch[1] !== SESSION_ID_CHARCLASS) {
    fail(`D0: charclass drift — .mjs="${SESSION_ID_CHARCLASS}" vs .sh="${shCharclassMatch[1]}"`)
  }

  if (!shMaxlenMatch) fail('D0: hooks/lib/marker-paths.sh missing PLAN_MARKER_SUFFIX_MAXLEN constant')
  else if (parseInt(shMaxlenMatch[1], 10) !== SESSION_ID_MAX_LEN) {
    fail(`D0: maxlen drift — .mjs=${SESSION_ID_MAX_LEN} vs .sh=${shMaxlenMatch[1]}`)
  }

  // Also assert the regex compiles to the expected canonical shape.
  // PLAN_MARKER_BASENAME_RE must accept '.plan-approval-pending' AND
  // '.plan-approval-pending.<any-valid-sid>'.
  if (!PLAN_MARKER_BASENAME_RE.test('.plan-approval-pending')) {
    fail('D0: PLAN_MARKER_BASENAME_RE rejects legacy literal — invariant broken')
  }
  if (!PLAN_MARKER_BASENAME_RE.test('.plan-approval-pending.abc-123')) {
    fail('D0: PLAN_MARKER_BASENAME_RE rejects valid suffixed form')
  }
  if (PLAN_MARKER_BASENAME_RE.test('.plan-approval-pending.')) {
    fail('D0: PLAN_MARKER_BASENAME_RE accepts empty-suffix (invariant broken)')
  }
  if (PLAN_MARKER_BASENAME_RE.test('.plan-approval-pending-extra')) {
    fail('D0: PLAN_MARKER_BASENAME_RE accepts no-dot suffix (invariant broken)')
  }
}

// ---------------------------------------------------------------------------
// D2 — Bidirectional drift detection
// ---------------------------------------------------------------------------
function checkBidirectionalDrift() {
  checks++

  // Files/directories where references are allowed (exclusion list).
  // Patterns are matched against the relative path from REPO.
  const EXCLUSION_PREFIXES = [
    'tests/',           // test files
    'docs/',            // doc files
    'scratch/',         // scratch artifacts
    '.episodic-memory/', // episode storage
    '.git/',            // git internals
    '.checkpoints/',    // live markers
    '.claude/',         // local settings + worktrees
    'node_modules/',
    'patterns/',        // behavioral-pattern docs (markdown)
  ]
  const EXCLUSION_FILES = new Set([
    'MEMORY.md',
    'PRINCIPLES.md',
    'README.md',
    'CLAUDE.md',
    'AGENTS.md',
    '.gitignore',
    // Validator self-exclusion (the JS + shell registry sources + validator itself).
    'scripts/lib/marker-paths.mjs',
    'plugins/claude-code/hooks/lib/marker-paths.sh',
    'scripts/validate-plan-marker-sites.mjs',
  ])
  // Any .md file (doc-class) is excluded regardless of path.
  function isExcludedByExtension(file) {
    return file.endsWith('.md')
  }

  // Registered site files — references inside these are OK regardless of line.
  const REGISTERED_FILES = new Set(
    PLAN_MARKER_ENFORCEMENT_SITES.map((s) => s.file)
  )

  // Build the union of registered + always-allowed file paths.
  const ALLOWED_FILES = new Set([...REGISTERED_FILES, ...EXCLUSION_FILES])

  // Run `git grep -n` to find all references to the literal basename.
  // Use git to avoid traversing ignored directories.
  let grepOutput
  try {
    grepOutput = execSync(
      `git -C "${REPO}" grep -n -F '.plan-approval-pending'`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    )
  } catch (e) {
    // Exit code 1 from grep = no matches. We expect MANY matches; if zero, that
    // itself is suspicious (the basename should appear in every enforcement site).
    if (e.status === 1) {
      fail('D2: no `.plan-approval-pending` references found anywhere — registry should not be empty')
      return
    }
    throw e
  }

  // Parse `file:line:content` records.
  const unregistered = []
  for (const line of grepOutput.split('\n')) {
    if (!line) continue
    const match = line.match(/^([^:]+):(\d+):(.*)$/)
    if (!match) continue
    const [, file, , content] = match

    // Skip if file is in any allowed location.
    if (ALLOWED_FILES.has(file)) continue
    if (isExcludedByExtension(file)) continue
    let inExcludedDir = false
    for (const prefix of EXCLUSION_PREFIXES) {
      if (file.startsWith(prefix)) { inExcludedDir = true; break }
    }
    if (inExcludedDir) continue

    // Comment-line exclusion (heuristic — strip leading whitespace).
    const stripped = content.replace(/^\s+/, '')
    if (stripped.startsWith('#')) continue  // shell / Python / YAML comment
    if (stripped.startsWith('//')) continue // JS line comment
    if (stripped.startsWith('*')) continue  // JS block-comment continuation
    // VALIDATOR-IGNORE annotation
    if (/VALIDATOR-IGNORE/.test(content)) continue

    // Unregistered reference.
    unregistered.push(line)
  }

  if (unregistered.length > 0) {
    fail(
      `D2: ${unregistered.length} unregistered \`.plan-approval-pending\` reference(s) found ` +
      `(must be added to PLAN_MARKER_ENFORCEMENT_SITES or annotated VALIDATOR-IGNORE):\n` +
      unregistered.slice(0, 20).map(l => `  ${l}`).join('\n') +
      (unregistered.length > 20 ? `\n  …+${unregistered.length - 20} more` : '')
    )
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
checkLibParity()
checkBidirectionalDrift()

if (wantJson) {
  process.stdout.write(JSON.stringify({
    status: failures.length === 0 ? 'ok' : 'failed',
    checks,
    failures
  }, null, 2) + '\n')
} else {
  if (failures.length === 0) {
    info(`OK  validate-plan-marker-sites: ${checks} checks passed`)
  } else {
    info(`FAIL  ${failures.length} failure(s):`)
    for (const f of failures) process.stderr.write(f + '\n')
  }
}

process.exit(failures.length === 0 ? 0 : 1)
