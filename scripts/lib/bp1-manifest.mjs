/**
 * bp1-manifest.mjs — Build the BP-1 runtime-artifact manifest (RFC-004 §107-152).
 *
 * Single source of truth for the artifact-version hash. Used by
 * `bp1-flag-check.mjs` (recompute on every read) and
 * `bp1-build-artifact-manifest.mjs` (CLI wrapper for install + ops).
 *
 * Six surfaces (sorted, deterministic):
 *   scripts          — scripts/bp1-*.mjs + explicit non-bp1 extensions
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
  // Walk supersedes chain via em-search --history. Defensive: if unavailable,
  // fall back to the referenced id (drift later detected by hash mismatch).
  try {
    const repoScripts = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
    const script = path.join(repoScripts, 'em-search.mjs')
    if (!fs.existsSync(script)) return referencedId
    const out = execFileSync('node', [script, '--history', referencedId, '--no-track'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const parsed = JSON.parse(out)
    if (parsed && Array.isArray(parsed.episodes) && parsed.episodes.length) {
      // History is ordered chain; terminal is the one not superseded.
      const terminal = parsed.episodes.find(e => !e.superseded_by) || parsed.episodes[parsed.episodes.length - 1]
      return terminal.id
    }
  } catch {
    // fall through
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
  const hooks = buildHooks(projectRoot)
  const settings_lines = { sha256: buildSettingsLinesSha(projectRoot) }
  const plugin_entries = { sha256: buildPluginEntriesSha(projectRoot) }
  const agent_loaders = buildAgentLoaders(projectRoot)
  const canonical_prompts = buildCanonicalPrompts(projectRoot, agent_loaders)

  const manifest = {
    schema_version: 1,
    scripts,
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
