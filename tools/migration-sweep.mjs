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
 *   1 → one or more legacy markers found (or config missing without --root)
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
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

let roots = []
let configMissing = false

if (singleRoot) {
  roots = [path.resolve(singleRoot)]
} else {
  const fromConfig = readConfigRoots(configPath)
  if (fromConfig === null) {
    configMissing = true
    roots = [process.cwd()]
  } else {
    roots = fromConfig.map(r => path.resolve(r))
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
const allClean = totalLegacy === 0 && !configMissing

if (JSON_OUTPUT) {
  console.log(JSON.stringify({
    configPath: singleRoot ? null : configPath,
    configMissing,
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
  } else {
    console.log('Migrate or remove the listed legacy markers, then re-run sweep.')
  }
}

process.exit(allClean ? 0 : 1)
