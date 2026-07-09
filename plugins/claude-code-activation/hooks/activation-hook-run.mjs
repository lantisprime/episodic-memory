#!/usr/bin/env node
// activation-hook-run.mjs — RFC-009 P2-S4 (R3) shared event-plane runner for
// the two advisory hooks (UserPromptSubmit / PreToolUse). Invoked by the thin
// registered .sh entry points (activation-prompt.sh / activation-tool.sh)
// with the event name as argv[2] and the hook's raw stdin JSON piped in —
// mirroring em-recall-sessionstart.sh's bash-orchestrates / co-located-.mjs-
// does-the-work split. ONE shared runner (not two near-duplicate ones) is a
// deliberate §8.2 SYMMETRY choice: identity/freshness/suppress/matcher/render
// logic lives in exactly one place, closing the P1b asymmetric-validation
// class (`…3c55`) where a lenient sibling branch drifts from its twin.
//
// ADVISORY INVARIANT (holds on EVERY path — parse failure, missing manifest,
// missing/corrupt index, stale-rebuild-subprocess failure, matcher throw):
// this script prints EITHER nothing OR exactly
//   { hookSpecificOutput: { hookEventName, additionalContext } }
// and the calling .sh ALWAYS exits 0 regardless of this process's exit code.
// Never a decision/block/permissionDecision field.
//
// READ BOUNDARY (REQ-19): the FRESH path reads ONLY the persisted per-store
// trigger-index.json files (stat-only freshness check against index.jsonl,
// never its content) plus lesson-suppress.json (REQ-13) and its schema
// (REQ-14) — never index.jsonl content, tags.json, activation-classes.json,
// or process.env. The STALE/CORRUPT path's rebuild is an explicit CARVE-OUT:
// it shells out to the standalone `em-trigger-index` CLI as a SUBPROCESS
// (never imports the writer module directly), so the index.jsonl read that
// powers a rebuild happens inside that tool's own process boundary, not this
// event-plane process. Output flows only through the rebuilt trigger-index.json
// artifact this process then reads back.
//
// IDENTITY (§7.1, §8.3, REQ-4): resolved EXCLUSIVELY from the co-located
// manifest.json's `project_identity: {slug, root}` (+ `harness` as tool_id).
// stdin `.cwd` is NEVER read by this script — not even for confirmation — the
// simplest defensible posture given the plan explicitly forbids cwd/env as an
// identity SOURCE (P2-S2 REQ-4, §7.1 "adapter scope identity" row). A missing
// manifest, an unparseable manifest, or a manifest without project_identity
// all degrade to "no injection" (§12 "manifest absent -> no injection", R2-M1).
//
// MANIFEST RESOLUTION (documented choice — no install.mjs wiring exists yet,
// S6): candidate order is (1) HOOK_DIR/manifest.json — the flat co-located
// layout every OTHER claude-code hook config uses once installed (mirrors
// enforce-contract.mjs's siblings-of-the-gates placement at
// <project>/.claude/hooks/enforce-contract.mjs, and the lib-closure
// convention at <project>/.claude/hooks/lib/*); (2) HOOK_DIR/../manifest.json
// — the CURRENT repo template location (plugins/claude-code-activation/
// manifest.json, one directory above hooks/), which is what a hook running
// straight from the source tree resolves to. No global fallback: project
// identity has no meaningful global default (P12) and a manifest lacking
// project_identity must degrade to no-injection, not to some other project's
// identity.
//
// SCRIPT/LIB RESOLUTION: em-trigger-index.mjs (subprocess) and
// scripts/lib/activation-match.mjs (imported) are resolved the same way
// enforce-contract.mjs is resolved by em-recall-sessionstart.sh — co-located
// candidate first, then the in-repo scripts/ tree (three directories above
// this file: plugins/claude-code-activation/hooks -> plugins ->
// plugins/.. == repo root), then the deployed global copy under
// ~/.episodic-memory/scripts/ (already the deploy target for every other
// script per CLAUDE.md's "Global: ~/.episodic-memory/ (scripts, episodes,
// index)"). See RETURN item 7 in the S4 build report for the open question
// S6 must settle (exact deployed co-location layout).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EVENT_NAME = process.argv[2] // 'UserPromptSubmit' | 'PreToolUse'

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT_GUESS = path.join(HOOK_DIR, '..', '..', '..')
const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')

const CANDIDATE_ROOTS = [HOOK_DIR, REPO_ROOT_GUESS, GLOBAL_DIR]

function resolveAsset(relForms) {
  for (const root of CANDIDATE_ROOTS) {
    for (const rel of relForms) {
      const candidate = path.join(root, rel)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        /* keep trying */
      }
    }
  }
  return null
}

const TRIGGER_INDEX_SCRIPT = resolveAsset(['em-trigger-index.mjs', 'scripts/em-trigger-index.mjs'])
const MATCH_LIB_PATH = resolveAsset(['lib/activation-match.mjs', 'scripts/lib/activation-match.mjs'])
const VALIDATE_LIB_PATH = resolveAsset(['lib/json-instance-validate.mjs', 'scripts/lib/json-instance-validate.mjs'])
const SUPPRESS_SCHEMA_PATH = resolveAsset(['lesson-suppress.schema.json', 'schemas/lesson-suppress.schema.json'])

function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {
      /* keep trying */
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Identity (manifest-only, never stdin cwd / env)
// ---------------------------------------------------------------------------
function resolveIdentity() {
  const manifestPath = firstExisting([
    path.join(HOOK_DIR, 'manifest.json'),
    path.join(HOOK_DIR, '..', 'manifest.json'),
  ])
  if (!manifestPath) return null

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null // corrupt manifest -> no injection
  }
  const pi = manifest && typeof manifest === 'object' ? manifest.project_identity : null
  if (!pi || typeof pi.slug !== 'string' || !pi.slug || typeof pi.root !== 'string' || !pi.root) {
    return null // absent/malformed project_identity -> no injection (repo template / pre-install)
  }
  const toolId = typeof manifest.harness === 'string' && manifest.harness ? manifest.harness : ''
  return { slug: pi.slug, root: pi.root, tool_id: toolId }
}

// ---------------------------------------------------------------------------
// Event construction (REQ-16/17/21)
// ---------------------------------------------------------------------------
function buildEvent(payload) {
  if (EVENT_NAME === 'UserPromptSubmit') {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
    return { kind: 'prompt', prompt }
  }
  if (EVENT_NAME === 'PreToolUse') {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    const ti = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : {}
    let target = ''
    if (toolName === 'Bash') {
      target = typeof ti.command === 'string' ? ti.command : ''
    } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
      target = typeof ti.file_path === 'string'
        ? ti.file_path
        : (typeof ti.notebook_path === 'string' ? ti.notebook_path : '')
    } else {
      target = '' // EC9: unknown tool -> empty target; `tool:<Name>:*` still name-matches
    }
    return { kind: 'tool', tool: toolName, target }
  }
  return null
}

// ---------------------------------------------------------------------------
// Store read (REQ-19): stat-only freshness; STALE/CORRUPT -> subprocess
// carve-out rebuild, then a single re-read. A wholly MISSING trigger-index.json
// is a "not participating yet" store (skip; no build attempt) -- distinct from
// a CORRUPT one (existed, now broken -> rebuild once, else skip + stderr,
// EC10). A subprocess/rebuild failure of any kind still degrades to "skip (or
// best-effort stale data)", never a thrown error (EC12).
// ---------------------------------------------------------------------------
function loadStoreIndex({ scope, root }) {
  const storeDir = scope === 'global' ? GLOBAL_DIR : path.join(root, '.episodic-memory')
  const triggerIndexPath = path.join(storeDir, 'trigger-index.json')

  let raw
  try {
    raw = fs.readFileSync(triggerIndexPath, 'utf8')
  } catch {
    return null // missing -> skip this store, no build attempt
  }

  let cached
  try {
    cached = JSON.parse(raw)
  } catch {
    cached = undefined // corrupt (unparseable)
  }

  if (cached === undefined) {
    return rebuildStore({ scope, root, storeDir }) // corrupt -> rebuild once, else skip+stderr
  }

  const jsonlPath = path.join(storeDir, 'index.jsonl')
  let expectMtime = 0
  let expectSize = 0
  try {
    const st = fs.statSync(jsonlPath)
    expectMtime = st.mtimeMs
    expectSize = st.size
  } catch {
    expectMtime = 0
    expectSize = 0
  }
  const src = cached && cached.source
  const fresh = !!src && src.index_mtime_ms === expectMtime && src.index_size === expectSize
  if (fresh) return cached

  const rebuilt = rebuildStore({ scope, root, storeDir })
  return rebuilt || cached // best-effort: a failed stale rebuild still has the stale-but-parseable copy to fall back on
}

function rebuildStore({ scope, root, storeDir }) {
  if (!TRIGGER_INDEX_SCRIPT) {
    process.stderr.write(`activation-hook: em-trigger-index.mjs not found; skipping ${scope} store\n`)
    return null
  }
  const args = [TRIGGER_INDEX_SCRIPT, '--scope', scope]
  if (scope === 'local' && root) args.push('--project', root)
  try {
    spawnSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 4000 })
  } catch {
    // subprocess failed to even spawn (EC12) -- fall through to a best-effort read
  }
  const triggerIndexPath = path.join(storeDir, 'trigger-index.json')
  try {
    return JSON.parse(fs.readFileSync(triggerIndexPath, 'utf8'))
  } catch (e) {
    process.stderr.write(`activation-hook: ${scope} trigger-index.json unreadable after rebuild attempt (${e.message}); skipping store\n`)
    return null
  }
}

// REQ-16 step 3: dedup by episode_id, LOCAL precedence; activity_phrases local-wins-else-global.
function mergeIndexes(local, global) {
  const entries = []
  const seen = new Set()
  for (const idx of [local, global]) {
    if (!idx || !Array.isArray(idx.entries)) continue
    for (const e of idx.entries) {
      if (!e || typeof e.episode_id !== 'string' || seen.has(e.episode_id)) continue
      seen.add(e.episode_id)
      entries.push(e)
    }
  }
  const activityPhrases =
    local && local.activity_phrases && typeof local.activity_phrases === 'object' && !Array.isArray(local.activity_phrases)
      ? local.activity_phrases
      : (global && global.activity_phrases && typeof global.activity_phrases === 'object' && !Array.isArray(global.activity_phrases)
        ? global.activity_phrases
        : {})
  return { entries, activity_phrases: activityPhrases }
}

// ---------------------------------------------------------------------------
// Suppress (REQ-13/14): whole-file, whole-document fail-open. Missing OR
// syntax-malformed OR shape-malformed (schema-invalid) -> empty Set + ONE
// stderr note, injection proceeds. Schema validation is attempted via the
// real schema (REQ-14, a SHOULD) when resolvable; otherwise an equivalent
// manual structural check (same required/type constraints) degrades safely
// -- schemas/ is not yet part of the deployed global tree (see RETURN item 7).
// ---------------------------------------------------------------------------
let _schemaValidatorPromise = null
function getSchemaValidator() {
  if (_schemaValidatorPromise) return _schemaValidatorPromise
  _schemaValidatorPromise = (async () => {
    if (!VALIDATE_LIB_PATH || !SUPPRESS_SCHEMA_PATH) return null
    try {
      const mod = await import(pathToFileURL(VALIDATE_LIB_PATH).href)
      const schema = JSON.parse(fs.readFileSync(SUPPRESS_SCHEMA_PATH, 'utf8'))
      if (typeof mod.validateInstance !== 'function') return null
      return { validateInstance: mod.validateInstance, schema }
    } catch {
      return null
    }
  })()
  return _schemaValidatorPromise
}

function manualSuppressShapeOk(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  if (doc.schema_version !== 1) return false
  if (!Array.isArray(doc.suppress)) return false
  for (const item of doc.suppress) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    if (typeof item.episode_id !== 'string' || !item.episode_id) return false
  }
  return true
}

async function loadSuppressSet(root) {
  const p = path.join(root, '.episodic-memory', 'lesson-suppress.json')

  // ENOENT (file simply absent — the common case for a project that has never
  // authored a mute list) is SILENT: empty Set, NO stderr note (codex F2a — a
  // note on every event was noise that masked the spec-required note). Read the
  // bytes first and treat ONLY a genuine "does not exist" as the silent path;
  // any other read error (permissions, is-a-directory, ...) counts as
  // "exists-but-unusable" and DOES earn the single note, since the operator
  // authored something the hook cannot honor.
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return new Set() // absent -> silent, no note
    process.stderr.write(`activation-hook: lesson-suppress.json unreadable (${e && e.message}); proceeding with no suppression\n`)
    return new Set()
  }

  // The file EXISTS: any parse / shape / schema failure fails OPEN with exactly
  // ONE observable stderr note (REQ-13 / EC6), injection proceeds.
  try {
    const doc = JSON.parse(raw)
    const validator = await getSchemaValidator()
    let ok
    if (validator) {
      try {
        ok = validator.validateInstance(doc, validator.schema).valid
      } catch {
        ok = manualSuppressShapeOk(doc)
      }
    } else {
      ok = manualSuppressShapeOk(doc)
    }
    if (!ok) throw new Error('shape-malformed')
    const set = new Set()
    for (const item of doc.suppress) set.add(item.episode_id)
    return set
  } catch (e) {
    process.stderr.write(`activation-hook: lesson-suppress.json unusable (${e && e.message}); proceeding with no suppression\n`)
    return new Set()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return // EC1: empty/non-object stdin -> exit 0, no output
  }

  const identity = resolveIdentity()
  if (!identity) return // manifest absent/malformed/no project_identity -> no injection

  const event = buildEvent(payload)
  if (!event) return

  const local = loadStoreIndex({ scope: 'local', root: identity.root })
  const global = loadStoreIndex({ scope: 'global', root: identity.root })
  const merged = mergeIndexes(local, global)
  const suppress = await loadSuppressSet(identity.root)

  let matchActivation
  try {
    if (!MATCH_LIB_PATH) return
    const mod = await import(pathToFileURL(MATCH_LIB_PATH).href)
    matchActivation = mod.matchActivation
    if (typeof matchActivation !== 'function') return
  } catch {
    return
  }

  let result
  try {
    result = matchActivation(merged, event, identity, suppress, { max_matches: 3, max_tokens: 500 })
  } catch {
    result = { lines: [], overflowNote: null }
  }

  const lines = result && Array.isArray(result.lines) ? result.lines : []
  if (lines.length === 0) return // nothing to inject -> exit 0, no output

  let text = lines.join('\n')
  if (result.overflowNote) text += `\n${result.overflowNote}`

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EVENT_NAME,
      additionalContext: text,
    },
  }) + '\n')
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0)) // advisory invariant: never a non-zero exit, never a decision field
