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
 *   2. LLM auto-classify (scripts/llm-classify.mjs --three-way): non-
 *      interactive, requires ANTHROPIC_API_KEY (skipped fast without one — no
 *      interactive auth path exists, and the typical subscription-auth Claude
 *      Code session has no key, so the consult degrades to the hold), honors
 *      classifier-config.json (enabled:false disables), hard-killed at 10s.
 *      A verdict with confidence >= 0.8 in {read_only, nonsrc_write,
 *      shared_write} is persisted into the SAME per-session marker cache via
 *      classifier-marker.mjs --write --source llm, then returned.
 *   3. Anything else — manifest miss + LLM miss/failure/timeout/low
 *      confidence/malformed output — emits {"decision":"hold"} and the gate
 *      falls through to the existing agent hold (fail-closed).
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
import { spawnSync } from 'child_process'
import { canonicalizeCommand } from './lib/command-canonical.mjs'
import { loadConfig } from './classifier-config-loader.mjs'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const THREE_WAY_LABELS = new Set(['read_only', 'nonsrc_write', 'shared_write'])
const LLM_HARD_TIMEOUT_MS = 10000
const LLM_CONFIDENCE_FLOOR = 0.8
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

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
  // The executable must be a BARE PATH-resolved name: `/tmp/evil/node` and
  // `./node` share execBase "node" with the system interpreter but are
  // arbitrary binaries — a by-design read-only grant must never ride a
  // basename (review finding, runtime-confirmed impostor bypass).
  if (!canon.execBare) return false
  if (!Array.isArray(entry.exec) || !entry.exec.includes(canon.execBase)) return false

  if (typeof entry.script === 'string' && entry.script) {
    // Trust is pinned to the INSTALLED copy (<HOME>/.episodic-memory/scripts,
    // written only by install.mjs). <REPO>-relative locations are refused
    // even when a manifest lists them: any repo's scripts/em-*.mjs can be a
    // locally modified, write-capable file (review finding — a branch under
    // review would auto-classify its own edited script read_only).
    const locs = (Array.isArray(entry.script_locations) && entry.script_locations.length
      ? entry.script_locations : defaultLocs)
      .filter((loc) => typeof loc === 'string' && !loc.includes('<REPO>'))
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
    : ['<HOME>/.episodic-memory/scripts']
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
// Stage 2 — LLM auto-classify (E2)
// ---------------------------------------------------------------------------

function resolveSibling(name) {
  const p = path.join(SELF_DIR, name)
  return fs.existsSync(p) ? p : null
}

function llmConsult({ projectRoot, callerCwd, command, sessionId }) {
  // Non-interactive path requires an API key; skip fast without one (typical
  // subscription-auth Claude Code sessions have none) — the hold is the
  // fallback. There is no interactive-auth path here by design: a PreToolUse
  // hook can never prompt.
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: 'no_api_key' }

  let cfg
  try { cfg = loadConfig({ projectRoot }) } catch { return { skipped: 'config_error' } }
  if (!cfg.enabled) return { skipped: 'tier3_disabled' }

  const llm = resolveSibling('llm-classify.mjs')
  if (!llm) return { skipped: 'llm_classify_absent' }

  // Hard 10s wall-clock kill regardless of the config's internal timeout_ms.
  const r = spawnSync(process.execPath, [
    llm,
    '--project-root', projectRoot,
    '--caller-cwd', callerCwd,
    '--command', command,
    '--three-way'
  ], {
    cwd: projectRoot,          // llm-classify verifies process.cwd() binding
    encoding: 'utf8',
    timeout: LLM_HARD_TIMEOUT_MS
  })
  if (r.error || r.signal) return { failed: `spawn_${r.signal || (r.error && r.error.code) || 'error'}` }

  let parsed
  try { parsed = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null') }
  catch { return { failed: 'malformed_output' } }
  if (!parsed || typeof parsed !== 'object') return { failed: 'malformed_output' }
  if (!THREE_WAY_LABELS.has(parsed.label)) return { failed: `label_${parsed.label || 'none'}` }

  const confidence = Number(parsed.confidence)
  const floor = Math.max(LLM_CONFIDENCE_FLOOR,
    Number.isFinite(cfg.confidence_threshold) ? cfg.confidence_threshold : 0)
  if (!Number.isFinite(confidence) || confidence < floor) {
    return { failed: `low_confidence_${confidence}` }
  }

  // Persist into the SAME per-session marker cache (source:"llm") so the
  // retry — and every later canonical-form variant — resolves from cache
  // without re-consulting. Best-effort: a persist failure never changes the
  // verdict (the manifest/LLM re-consult is the fallback).
  let persisted = false
  if (SESSION_ID_RE.test(sessionId || '')) {
    const marker = resolveSibling('classifier-marker.mjs')
    if (marker) {
      const w = spawnSync(process.execPath, [
        marker, '--write',
        '--project-root', projectRoot,
        '--caller-cwd', callerCwd,
        '--command', command,
        '--session-id', sessionId,
        '--label', parsed.label,
        '--confidence', String(confidence),
        '--reason', `llm auto-classify (hold consult): ${String(parsed.reason || '').slice(0, 200)}`,
        '--source', 'llm'
      ], { cwd: projectRoot, encoding: 'utf8', timeout: 15000 })
      persisted = w.status === 0
    }
  }

  return { label: parsed.label, confidence, persisted }
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = flag(argv, '--command')
  const sessionId = flag(argv, '--session-id') || ''
  const skipLlm = argv.includes('--skip-llm')

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

  // Stage 2: LLM auto-classify (E2). --skip-llm for callers/tests that only
  // want the manifest answer.
  if (!skipLlm) {
    const l = llmConsult({ projectRoot, callerCwd: cwdCanon, command, sessionId })
    if (l.label) {
      emit({
        decision: l.label,
        source: 'llm',
        confidence: l.confidence,
        persisted: l.persisted,
        canonical: canon.canonical
      })
      process.exit(0)
    }
    hold(`manifest_miss; llm_${l.skipped || l.failed || 'no_decision'}`)
  }

  hold('manifest_miss')
}

try { main() } catch (err) {
  hold(`internal_error: ${err && err.message ? err.message : String(err)}`)
}
