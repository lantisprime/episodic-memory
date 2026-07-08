#!/usr/bin/env node
/**
 * classifier-hold-consult.mjs — pre-hold consult for checkpoint-gate.sh
 * (gate-classifier UX E4 manifest + E2 LLM auto-classify).
 *
 * Invoked by checkpoint-gate.sh ONLY when an agent-classification hold is
 * otherwise imminent (LABEL=shared_write, REASON in {default_write,
 * interpreter_other} — the unevaluated-novel bucket, AFTER the per-session
 * marker cache already missed). Spawn discipline: the common allow paths
 * never pay this node spawn.
 *
 * Consult order:
 *   1. First-party read-only manifest (patterns/readonly-commands.json,
 *      matched on the canonical form from lib/command-canonical.mjs). A match
 *      classifies read_only with NO agent involvement and is NOT persisted —
 *      the manifest itself is the durable authority.
 *   2. (E2) LLM auto-classify — added in the E2 slice.
 *   3. Anything else emits {"decision":"hold"} and the gate falls through to
 *      the existing agent hold (fail-closed).
 *
 * Output (stdout, single JSON line; ALWAYS exit 0 — the gate treats a
 * non-zero exit, empty output, or garbage as hold):
 *   {"decision":"read_only","source":"manifest","entry_id":"em-stats",...}
 *   {"decision":"<label>","source":"llm","confidence":0.95,"persisted":true}
 *   {"decision":"hold","source":"none","reason":"..."}
 *
 * Usage:
 *   node classifier-hold-consult.mjs \
 *     --project-root <abs> --caller-cwd <abs> --command <text> \
 *     [--session-id <sid>] [--skip-llm]
 *
 * Zero deps, Node stdlib only. Readers degrade-not-throw: a missing or
 * malformed manifest silently skips stage 1; every unexpected error emits
 * hold.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { canonicalizeCommand } from './lib/command-canonical.mjs'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function hold(reason) {
  emit({ decision: 'hold', source: 'none', reason: String(reason).slice(0, 300) })
  process.exit(0)
}

function realpathOrSame(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

// ---------------------------------------------------------------------------
// Stage 1 — first-party read-only manifest
// ---------------------------------------------------------------------------

// Resolution: co-located repo layout (scripts/ → ../patterns/) first, then the
// global install (~/.episodic-memory/patterns/). Missing/malformed → null
// (degrade-not-throw; the gate keeps holding).
function loadManifest() {
  const candidates = [
    path.join(SELF_DIR, '..', 'patterns', 'readonly-commands.json'),
    path.join(os.homedir(), '.episodic-memory', 'patterns', 'readonly-commands.json')
  ]
  for (const p of candidates) {
    let txt
    try { txt = fs.readFileSync(p, 'utf8') } catch { continue }
    let parsed
    try { parsed = JSON.parse(txt) } catch { continue }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) continue
    return { manifest: parsed, file: p }
  }
  return null
}

// Match the canonical parts against one manifest entry. Fail-closed shape
// handling: a malformed entry never matches.
function entryMatches(entry, canon, defaultLocs) {
  if (!entry || typeof entry !== 'object') return false
  if (!Array.isArray(entry.exec) || !entry.exec.includes(canon.execBase)) return false

  if (typeof entry.script === 'string' && entry.script) {
    const locs = Array.isArray(entry.script_locations) && entry.script_locations.length
      ? entry.script_locations : defaultLocs
    if (!locs.some((loc) => canon.subject === `${loc}/${entry.script}`)) return false
  } else if (typeof entry.subcommand === 'string' && entry.subcommand) {
    if (canon.subject !== entry.subcommand) return false
  } else {
    // No script/subcommand constraint → the command must have NO subject
    // token (e.g. bare `node --version`). Prevents a subject-bearing command
    // from riding a flags-only entry.
    if (canon.subject !== '') return false
  }

  const flags = canon.flags
  if (entry.require_flags !== undefined) {
    if (!Array.isArray(entry.require_flags)) return false
    if (!entry.require_flags.every((f) => flags.includes(f))) return false
  }
  if (entry.deny_flags !== undefined) {
    if (!Array.isArray(entry.deny_flags)) return false
    if (entry.deny_flags.some((f) => flags.includes(f))) return false
  }
  if (entry.allow_flags !== undefined) {
    if (!Array.isArray(entry.allow_flags)) return false
    if (!flags.every((f) => entry.allow_flags.includes(f))) return false
  }
  return true
}

function manifestConsult(canon) {
  if (!canon.canonical) return null // non-canonicalizable shapes never match
  const loaded = loadManifest()
  if (!loaded) return null
  const defaultLocs = Array.isArray(loaded.manifest.default_script_locations)
    && loaded.manifest.default_script_locations.length
    ? loaded.manifest.default_script_locations
    : ['<REPO>/scripts', '<HOME>/.episodic-memory/scripts']
  for (const entry of loaded.manifest.entries) {
    try {
      if (entryMatches(entry, canon, defaultLocs)) {
        return { entry, file: loaded.file }
      }
    } catch { /* malformed entry never matches */ }
  }
  return null
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = flag(argv, '--command')

  if (!projectRootArg || !callerCwd || command === undefined) {
    hold('usage: --project-root, --caller-cwd, --command required')
  }
  const projectRoot = realpathOrSame(path.resolve(projectRootArg))
  const cwdCanon = realpathOrSame(callerCwd)

  const canon = canonicalizeCommand({ command, projectRoot, callerCwd: cwdCanon })

  // Stage 1: manifest.
  const m = manifestConsult(canon)
  if (m) {
    emit({
      decision: 'read_only',
      source: 'manifest',
      entry_id: typeof m.entry.id === 'string' ? m.entry.id : '',
      canonical: canon.canonical,
      manifest: m.file
    })
    process.exit(0)
  }

  hold('manifest_miss')
}

try { main() } catch (err) {
  hold(`internal_error: ${err && err.message ? err.message : String(err)}`)
}
