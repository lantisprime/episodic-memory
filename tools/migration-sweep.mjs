#!/usr/bin/env node
/**
 * migration-sweep.mjs — Inventory legacy `.claude/.X` markers across enrolled
 * project roots so the .checkpoints/ migration can drop the legacy fallback
 * branch only when ALL enrolled projects are clean.
 *
 * Closes Codex round-1 F4 (state-based fallback removal): time-based
 * burn-in is not a safety signal. Plan v3 §D.3 requires zero legacy
 * markers across configured roots before the fallback branch can be
 * removed (in addition to the 7-day floor).
 *
 * Usage:
 *   node tools/migration-sweep.mjs [--config <path>] [--root <dir>] [--json]
 *
 * Config file format (default `<repo>/.checkpoints-migration-roots`):
 *   - One absolute project root per line
 *   - Lines starting with `#` are comments
 *   - Blank lines ignored
 *   - The file is GITIGNORED (user-local state). Operators add
 *     project roots they want to track during burn-in.
 *
 * Validation: each parsed entry must (a) be non-empty, (b) contain no
 * control characters (rejects binary garbage), (c) be an absolute path,
 * (d) point at an existing directory. Any invalid entry causes the gate
 * to fail closed (Codex round-2 F4: garbage config content was previously
 * treated as a clean enrolled root).
 *
 * If --root is passed, it overrides the config and scans only that root.
 * If neither is provided and the config file is missing, the tool defaults
 * to scanning the cwd and prints a hint about the config file.
 *
 * Behavior per root:
 *   - Lists every legacy marker present at <root>/.claude/.X for the 6
 *     migrated names (5 .X + .session-baseline).
 *   - Reports filename + mtime per marker.
 *
 * Exit codes:
 *   0 → all enrolled roots clean (zero legacy markers)
 *   1 → one or more legacy markers found, OR config missing without --root,
 *       OR config exists but enrolls zero valid roots, OR any config entry
 *       failed validation.
 *
 * Pair with tools/migration-cutover.mjs (parity check) and the 7-day floor
 * to decide when the fallback branch can be removed.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ALL_MIGRATED_MARKERS, LEGACY_MARKER_DIR } from '../scripts/lib/marker-paths.mjs'

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CONFIG = path.join(REPO_DIR, '.checkpoints-migration-roots')
const configPath = flag('--config') || DEFAULT_CONFIG
const singleRoot = flag('--root')
const JSON_OUTPUT = argv.includes('--json')

function readConfigRoots(p) {
  if (!fs.existsSync(p)) return null
  // Reject directory or unreadable inputs upfront so we don't try to
  // readFileSync a non-file (which would throw with a confusing error).
  let st
  try { st = fs.statSync(p) } catch { return { error: 'unreadable' } }
  if (!st.isFile()) return { error: 'not_a_file' }
  let raw
  try { raw = fs.readFileSync(p, 'utf8') } catch { return { error: 'unreadable' } }
  return raw
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

// Codex round-2 F4: garbage / non-path content in the config must NOT
// be treated as a valid enrolled root.
//
// charCode scan rather than a literal regex so the source file stays
// free of embedded control bytes (which break basic editor tooling).
function _hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 32 || c === 127) return true
  }
  return false
}

function validateRoot(r) {
  if (typeof r !== 'string' || r.length === 0) return { valid: false, reason: 'empty' }
  if (_hasControlChar(r)) return { valid: false, reason: 'control_chars' }
  if (!path.isAbsolute(r)) return { valid: false, reason: 'not_absolute' }
  let st
  try { st = fs.statSync(r) } catch { return { valid: false, reason: 'does_not_exist' } }
  if (!st.isDirectory()) return { valid: false, reason: 'not_a_directory' }
  return { valid: true }
}

let roots = []
let configMissing = false
let configError = null
let invalidConfigEntries = []

if (singleRoot) {
  roots = [path.resolve(singleRoot)]
} else {
  const fromConfig = readConfigRoots(configPath)
  if (fromConfig === null) {
    configMissing = true
    roots = [process.cwd()]
  } else if (fromConfig && typeof fromConfig === 'object' && fromConfig.error) {
    configError = fromConfig.error
    roots = []
  } else {
    const candidates = fromConfig.map(r => path.resolve(r))
    const validations = candidates.map(r => ({ root: r, ...validateRoot(r) }))
    invalidConfigEntries = validations.filter(v => !v.valid).map(v => ({
      root: v.root, reason: v.reason
    }))
    roots = validations.filter(v => v.valid).map(v => v.root)
  }
}

function scanRoot(root) {
  const legacyDir = path.join(root, LEGACY_MARKER_DIR)
  const markers = []
  for (const name of ALL_MIGRATED_MARKERS) {
    const markerPath = path.join(legacyDir, name)
    try {
      const st = fs.statSync(markerPath)
      markers.push({
        name,
        path: markerPath,
        mtime: new Date(st.mtimeMs).toISOString(),
        size: st.size
      })
    } catch {}
  }
  return { root, legacyDir, markers, count: markers.length }
}

const scans = roots.map(scanRoot)
const totalLegacy = scans.reduce((sum, s) => sum + s.count, 0)
// Codex round-1 F2: an existing-but-empty / comment-only config produces
// roots=[] and would otherwise vacuously pass the gate. Treat zero
// enrolled roots as a failed gate (noRootsConfigured).
const noRootsConfigured = !singleRoot && roots.length === 0
// Codex round-2 F4: any invalid config entry fails closed (one bad line
// taints the whole config).
const hasInvalidEntries = invalidConfigEntries.length > 0
const allClean = totalLegacy === 0 && !configMissing && !noRootsConfigured && !configError && !hasInvalidEntries

if (JSON_OUTPUT) {
  console.log(JSON.stringify({
    configPath: singleRoot ? null : configPath,
    configMissing,
    configError,
    noRootsConfigured,
    invalidConfigEntries,
    rootsScanned: roots.length,
    totalLegacy,
    allClean,
    scans
  }, null, 2))
} else {
  if (configMissing && !singleRoot) {
    console.log(`Note: ${configPath} not found. Defaulting to cwd scan.`)
    console.log(`Create the config to enroll project roots for burn-in tracking:`)
    console.log(`  printf '%s\\n' "$PWD" > ${configPath}`)
    console.log()
  }
  if (configError) {
    console.log(`Config error: ${configPath} → ${configError}`)
    console.log()
  }
  if (hasInvalidEntries) {
    console.log(`Invalid config entries (${invalidConfigEntries.length}):`)
    for (const e of invalidConfigEntries) {
      console.log(`  ! ${e.reason.padEnd(18)} ${e.root}`)
    }
    console.log()
  }
  console.log(`Scanning ${roots.length} root${roots.length === 1 ? '' : 's'} for legacy markers under .claude/`)
  console.log()
  for (const scan of scans) {
    if (scan.count === 0) {
      console.log(`  ✓ clean   ${scan.root}`)
    } else {
      console.log(`  ! ${String(scan.count).padStart(2)} fnd  ${scan.root}`)
      for (const m of scan.markers) {
        console.log(`             ${m.name.padEnd(28)} ${m.mtime}  ${m.size}b`)
      }
    }
  }
  console.log()
  console.log(`Total legacy markers found: ${totalLegacy}`)
  if (allClean) {
    console.log('All enrolled roots are clean. Fallback branch removal safe (combine with cutover + 7-day floor).')
  } else if (configMissing && !singleRoot) {
    console.log('Config missing — exit 1 (treat as failed gate until enrolled roots are explicit).')
  } else if (configError) {
    console.log(`Config error (${configError}) — exit 1 (fix the config file before re-running).`)
  } else if (noRootsConfigured) {
    console.log(`Config exists but enrolls zero VALID roots — exit 1 (add at least one absolute project root to ${configPath} that resolves to an existing directory).`)
  } else if (hasInvalidEntries) {
    console.log(`Config has ${invalidConfigEntries.length} invalid entr${invalidConfigEntries.length === 1 ? 'y' : 'ies'} — exit 1 (one bad line taints the whole config; fix or remove).`)
  } else {
    console.log('Migrate or remove the listed legacy markers, then re-run sweep.')
  }
}

process.exit(allClean ? 0 : 1)
