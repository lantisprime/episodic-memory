/**
 * bp1-manifest.mjs — Build the BP-1 runtime-artifact manifest (RFC-004 §107-152).
 *
 * Single source of truth for the artifact-version hash. Used by
 * `bp1-flag-check.mjs` (recompute on every read) and
 * `bp1-build-artifact-manifest.mjs` (CLI wrapper for install + ops).
 *
 * Seven surfaces (sorted, deterministic):
 *   scripts          — scripts/bp1-*.mjs + explicit non-bp1 extensions
 *   scripts_lib      — scripts/lib/bp1-*.mjs (load-bearing helpers; PR-1b-A added)
 *   hooks            — .claude/hooks/bp1-*.sh
 *   settings_lines   — bp1-mentioning lines in .claude/settings.json (case-insensitive)
 *   plugin_entries   — bp1-related entries in .claude-plugin/plugin.json
 *   agent_loaders    — .claude/agents/bp1-*.md
 *   canonical_prompts— latest prompt episode id referenced by each agent loader
 *
 * Determinism contract (CI test A14):
 *   Two consecutive runs on the same install produce identical sha256.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { execFileSync } from 'child_process'

// Explicit non-bp1-prefixed scripts BP1 depends on for safety contracts (RFC-004
// v3.11 / CLI v3.10 F3). Closed list — additions require RFC update + builder
// update + activation re-run.
export const NON_BP1_SCRIPTS = ['scripts/em-review-request.mjs']

// Episode-id pattern: <date>-<time>-<slug>-<rand>. Matches the
// `<id>` token used in agent loader files for canonical prompt references.
// Lowercase-only: the corpus convention is lowercase IDs and case-insensitive
// matching would let two textually-different references resolve to the same
// episode and produce different stored hashes pre/post canonicalization.
const EPISODE_ID_RE = /\b(\d{8}-\d{6}-[a-z0-9-]+-[0-9a-f]+)\b/

function sha256File(filePath) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(filePath))
  return h.digest('hex')
}

function sha256String(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

function listMatching(dir, pattern) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => pattern.test(f))
    .sort()
}

function buildScripts(projectRoot) {
  const scriptsDir = path.join(projectRoot, 'scripts')
  const out = []

  for (const f of listMatching(scriptsDir, /^bp1-.*\.mjs$/)) {
    const rel = `scripts/${f}`
    out.push({ path: rel, sha256: sha256File(path.join(projectRoot, rel)) })
  }
  for (const rel of NON_BP1_SCRIPTS) {
    const abs = path.join(projectRoot, rel)
    if (fs.existsSync(abs)) {
      out.push({ path: rel, sha256: sha256File(abs) })
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function buildScriptsLib(projectRoot) {
  // PR-1b-A: load-bearing helpers under scripts/lib/. Only bp1-*.mjs files
  // are hashed — other lib files (e.g. local-dir.mjs) are not BP1-runtime
  // critical and not subject to drift detection here.
  // Codex plan-review round 1 Q3.2: prior manifest scanned only top-level
  // scripts/bp1-*.mjs, so changes to lib helpers (probe stub → real probe at
  // M1, sweep helper logic) would NOT have triggered bp1-flag-version-drift.
  // This surface closes that hole.
  const libDir = path.join(projectRoot, 'scripts', 'lib')
  return listMatching(libDir, /^bp1-.*\.mjs$/).map(f => {
    const rel = `scripts/lib/${f}`
    return { path: rel, sha256: sha256File(path.join(projectRoot, rel)) }
  })
}

function buildHooks(projectRoot) {
  const hooksDir = path.join(projectRoot, '.claude', 'hooks')
  return listMatching(hooksDir, /^bp1-.*\.sh$/).map(f => {
    const rel = `.claude/hooks/${f}`
    return { path: rel, sha256: sha256File(path.join(projectRoot, rel)) }
  })
}

function buildSettingsLinesSha(projectRoot) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) return sha256String('')
  const raw = fs.readFileSync(settingsPath, 'utf8')
  const lines = raw.split('\n')
    .filter(line => /bp1/i.test(line))
    .map(line => line.trimEnd())
    .sort()
  return sha256String(lines.join('\n'))
}

function buildPluginEntriesSha(projectRoot) {
  const pluginPath = path.join(projectRoot, '.claude-plugin', 'plugin.json')
  if (!fs.existsSync(pluginPath)) return sha256String('')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(pluginPath, 'utf8'))
  } catch {
    return sha256String('PLUGIN_PARSE_ERROR')
  }
  const filtered = {}
  if (Array.isArray(parsed['scheduled-tasks'])) {
    const bp1Tasks = parsed['scheduled-tasks']
      .filter(t => t && typeof t === 'object' && /bp1/i.test(JSON.stringify(t)))
    if (bp1Tasks.length) filtered['scheduled-tasks'] = bp1Tasks
  }
  if (Array.isArray(parsed['slash-commands'])) {
    const bp1Cmds = parsed['slash-commands']
      .filter(c => c && typeof c === 'object' && /^bp1-/.test(c.name || ''))
    if (bp1Cmds.length) filtered['slash-commands'] = bp1Cmds
  }
  return sha256String(stableStringify(filtered))
}

function buildAgentLoaders(projectRoot) {
  const agentsDir = path.join(projectRoot, '.claude', 'agents')
  return listMatching(agentsDir, /^bp1-.*\.md$/).map(f => {
    const rel = `.claude/agents/${f}`
    return { path: rel, sha256: sha256File(path.join(projectRoot, rel)) }
  })
}

function buildCanonicalPrompts(projectRoot, agentLoaders) {
  // Each loader file has a "canonical prompt episode" reference. Find the
  // first matching episode-id pattern in the loader, then resolve the
  // terminal-revision episode-id via em-search (--history). For the M0 ship
  // with zero bp1 agents installed, this returns an empty array.
  const out = []
  for (const loader of agentLoaders) {
    const abs = path.join(projectRoot, loader.path)
    const body = fs.readFileSync(abs, 'utf8')
    const m = body.match(EPISODE_ID_RE)
    if (!m) continue
    const referencedId = m[1]
    out.push({
      loader: loader.path,
      latest_prompt_episode_id: resolveLatestEpisodeId(referencedId)
    })
  }
  return out
}

function resolveLatestEpisodeId(referencedId) {
  // Walk supersedes chain via em-search --history.
  //
  // Two distinct failure classes:
  //   - em-search not present (script file missing): expected legitimate
  //     fallback to the referenced id. Tracked by #180 for M3 hardening.
  //   - em-search present but the subprocess errored or returned malformed
  //     JSON: a real signal that propagates. The outer try/catch in
  //     bp1-flag-check.mjs catches it and surfaces as bp1-flag-version-drift.
  //
  // Codex round-3 finding: bare catch{} swallowing ALL errors made the
  // I-P2-1 fail-closed invariant overbroad. Narrowed here.
  const repoScripts = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const script = path.join(repoScripts, 'em-search.mjs')
  if (!fs.existsSync(script)) return referencedId

  // From here on, throw — flag-check's outer try/catch surfaces as drift.
  const out = execFileSync('node', [script, '--history', referencedId, '--no-track'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  })
  const parsed = JSON.parse(out)
  // em-search --history emits {status, count, chain: [...]} — NOT episodes.
  // (Round-3 bug: original lib checked parsed.episodes, masked by bare catch.)
  // Three valid cases:
  //   - {chain: [...]} non-empty → use terminal id
  //   - {chain: []}            → id not in store, legitimate fallback
  //   - parsed has no chain array at all → malformed, propagate
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.chain)) {
    throw new Error(`em-search returned unexpected shape for history of ${referencedId}`)
  }
  if (parsed.chain.length) {
    // History is ordered chain; terminal is the one not superseded.
    const terminal = parsed.chain.find(e => !e.superseded_by) || parsed.chain[parsed.chain.length - 1]
    return terminal.id
  }
  return referencedId
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

export function buildArtifactManifest({ projectRoot }) {
  if (!projectRoot) throw new Error('buildArtifactManifest: projectRoot required')

  const scripts = buildScripts(projectRoot)
  const scripts_lib = buildScriptsLib(projectRoot)
  const hooks = buildHooks(projectRoot)
  const settings_lines = { sha256: buildSettingsLinesSha(projectRoot) }
  const plugin_entries = { sha256: buildPluginEntriesSha(projectRoot) }
  const agent_loaders = buildAgentLoaders(projectRoot)
  const canonical_prompts = buildCanonicalPrompts(projectRoot, agent_loaders)

  const manifest = {
    schema_version: 2,
    scripts,
    scripts_lib,
    hooks,
    settings_lines,
    plugin_entries,
    agent_loaders,
    canonical_prompts,
  }
  const sha256 = sha256String(stableStringify(manifest))
  return { manifest, sha256 }
}

export const VERIFY_KEY_PATH = path.join(os.homedir(), '.episodic-memory', '.verify-key')
export const CONFIG_PATH = path.join(os.homedir(), '.episodic-memory', 'config.json')
const VERIFY_KEY_FINGERPRINT_LABEL = 'verify-key-fingerprint-v1'

export function readVerifyKey() {
  if (!fs.existsSync(VERIFY_KEY_PATH)) {
    return { ok: false, reason: 'missing', path: VERIFY_KEY_PATH }
  }
  const stat = fs.statSync(VERIFY_KEY_PATH)
  // Mode 0600 — owner read/write only. RFC-004 §665.
  const mode = stat.mode & 0o777
  if (mode !== 0o600) {
    return { ok: false, reason: 'mode', mode: mode.toString(8), path: VERIFY_KEY_PATH }
  }
  let key
  try {
    key = fs.readFileSync(VERIFY_KEY_PATH)
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: e.message, path: VERIFY_KEY_PATH }
  }
  if (key.length !== 32) {
    return { ok: false, reason: 'size', size: key.length, path: VERIFY_KEY_PATH }
  }
  const fingerprint = crypto
    .createHmac('sha256', key)
    .update(VERIFY_KEY_FINGERPRINT_LABEL, 'utf8')
    .digest('hex')
    .slice(0, 16)
  return { ok: true, key, fingerprint, path: VERIFY_KEY_PATH }
}

export function canonicalProjectRoot(cwd = process.cwd()) {
  // git rev-parse --show-toplevel + realpath. Worktrees and submodules
  // canonicalize to the toplevel of their containing git context.
  let toplevel
  try {
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
  if (!toplevel) return null
  try {
    return fs.realpathSync(toplevel)
  } catch {
    return toplevel
  }
}

// ===========================================================================
// Run-completion manifest (RFC-004 §738-789, M1)
//
// Distinct from the artifact-version manifest above. The run-completion
// manifest is signed by the verify-key (NOT the per-run key) at finalize-run
// and verified at replay. Carries `manifest_schema_version: "1.0"` as a
// REQUIRED top-level signed field (round-2 N3 mod).
//
// All run-manifest functions are pure (caller-supplied records); disk I/O
// for collecting records lives in the orchestrator's finalize-run step (or
// future collectEpisodeRecords helper, Session B).
// ===========================================================================

export const MANIFEST_SCHEMA_VERSION = '1.0'

const RUN_ID_RE = /^[a-z0-9-]+$/

/**
 * Validate a run_id is shape-safe before any path-join (D1 fix).
 * @param {string} runId
 * @throws {Error} if shape mismatch.
 */
export function assertRunIdShape(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run_id shape: ${JSON.stringify(runId)}`)
  }
}

/**
 * Strict project-root resolver for finalize/replay paths (D3 fix).
 * Unlike canonicalProjectRoot above, does NOT fall back to the raw toplevel
 * when realpath fails — throws ProjectRootResolutionFailed instead.
 *
 * @param {string} [cwd]
 * @returns {string} canonical realpath of the git toplevel
 * @throws {Error} when not in a git repo OR realpath fails
 */
export function canonicalProjectRootStrict(cwd = process.cwd()) {
  let toplevel
  try {
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (e) {
    const err = new Error(`ProjectRootResolutionFailed: not a git repo at ${cwd}: ${e.message}`)
    err.code = 'ProjectRootResolutionFailed'
    throw err
  }
  if (!toplevel) {
    const err = new Error(`ProjectRootResolutionFailed: empty toplevel at ${cwd}`)
    err.code = 'ProjectRootResolutionFailed'
    throw err
  }
  try {
    return fs.realpathSync(toplevel)
  } catch (e) {
    const err = new Error(`ProjectRootResolutionFailed: realpath failed for ${toplevel}: ${e.message}`)
    err.code = 'ProjectRootResolutionFailed'
    throw err
  }
}

/**
 * Compute the records-root: sha256 of sorted-by-episode_id concat of
 * (episode_id || canonical_sha256 || body_sha256 || hmac_signature) for all
 * records. Empty records → sha256(""). Order-stable (B2 / I5).
 *
 * @param {Array<{episode_id:string, canonical_sha256:string, body_sha256:string, hmac_signature:string}>} records
 * @returns {string} hex sha256
 */
export function computeRecordsRoot(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('records must be an array')
  }
  if (records.length === 0) {
    return crypto.createHash('sha256').update('').digest('hex')
  }
  const sorted = records.slice().sort((a, b) => {
    if (a.episode_id < b.episode_id) return -1
    if (a.episode_id > b.episode_id) return 1
    return 0
  })
  const h = crypto.createHash('sha256')
  for (const r of sorted) {
    if (!r || typeof r !== 'object') {
      throw new TypeError('records must contain objects')
    }
    for (const f of ['episode_id', 'canonical_sha256', 'body_sha256', 'hmac_signature']) {
      if (typeof r[f] !== 'string') {
        throw new TypeError(`record missing string field: ${f}`)
      }
      h.update(r[f])
    }
  }
  return h.digest('hex')
}

/**
 * Build the run-completion manifest payload.
 *
 * `manifest_schema_version: "1.0"` is REQUIRED top-level signed field (N3).
 * The payload is fully self-describing: includes runId, projectRoot,
 * terminalState, finalizedAt (ISO-8601 UTC, RFC-004 line 758), episodeCount,
 * episodes_records_root, and per_episode_records.
 *
 * @param {Array} records
 * @param {string} runId
 * @param {string} projectRoot — canonical realpath
 * @param {'complete'|'aborted'|'abandoned'|'archived'} terminalState
 * @param {string} finalizedAt — ISO-8601 UTC
 * @param {number} episodeCount — must equal records.length
 * @returns {object} payload
 */
export function buildManifestPayload(
  records, runId, projectRoot, terminalState, finalizedAt, episodeCount,
) {
  assertRunIdShape(runId)
  if (typeof projectRoot !== 'string' || !projectRoot.startsWith('/')) {
    throw new TypeError('projectRoot must be absolute path string')
  }
  if (!['complete', 'aborted', 'abandoned', 'archived'].includes(terminalState)) {
    throw new Error(`invalid terminalState: ${terminalState}`)
  }
  if (typeof finalizedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(finalizedAt)) {
    throw new Error(`finalizedAt must be ISO-8601 UTC: ${finalizedAt}`)
  }
  if (!Number.isInteger(episodeCount) || episodeCount < 0) {
    throw new Error(`episodeCount must be non-negative integer: ${episodeCount}`)
  }
  if (episodeCount !== records.length) {
    throw new Error(`episodeCount (${episodeCount}) !== records.length (${records.length})`)
  }
  const root = computeRecordsRoot(records)
  return {
    manifest_schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: runId,
    project_root: projectRoot,
    terminal_state: terminalState,
    finalized_at: finalizedAt,
    episode_count: episodeCount,
    episodes_records_root: root,
    per_episode_records: records.slice(),
  }
}

/**
 * Sign a manifest payload with the verify-key (HMAC-SHA256). The payload is
 * stableStringified BEFORE signing (recursive, every nesting level — C2 fix).
 *
 * @param {object} payload
 * @param {Buffer} verifyKey32B
 * @returns {string} hex signature
 */
export function signManifest(payload, verifyKey32B) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('payload must be an object')
  }
  if (!Buffer.isBuffer(verifyKey32B) || verifyKey32B.length !== 32) {
    throw new TypeError('verifyKey32B must be a 32-byte Buffer')
  }
  const canonical = stableStringify(payload)
  return crypto.createHmac('sha256', verifyKey32B).update(canonical, 'utf8').digest('hex')
}

/**
 * Verify a manifest signature. Returns true iff the recomputed HMAC matches
 * (constant-time compare). Signature mismatch returns false; malformed inputs
 * throw.
 *
 * @param {object} payload
 * @param {string} signatureHex
 * @param {Buffer} verifyKey32B
 * @returns {boolean}
 */
export function verifyManifest(payload, signatureHex, verifyKey32B) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]+$/i.test(signatureHex)) {
    return false
  }
  const expected = signManifest(payload, verifyKey32B)
  // Constant-time compare to avoid timing leaks.
  if (expected.length !== signatureHex.length) return false
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(signatureHex, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
