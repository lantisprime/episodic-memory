/**
 * composer.mjs — Per-provider preamble composition for the second-opinion harness.
 *
 * v3.3 byte-safe override-validation contract. Plan refs:
 *   - .claude/scratch/harness-plan-v3.md (base, accepted r3)
 *   - .claude/scratch/harness-plan-v3.1-amendment.md (preamble registry)
 *   - .claude/scratch/harness-plan-v3.2-amendment.md (cwd-binding + override hardening)
 *   - .claude/scratch/harness-plan-v3.3-amendment.md (bytes-first validation chain)
 *
 * Resolution priority (3-tier):
 *   1. CLI flag (--preamble <id>[,<id>...]) — composes named fragments in order.
 *   2. Repo override at <projectRoot>/.review-store/preambles/<provider>.md
 *      — replaces default for that provider in this repo.
 *   3. Default from index.json:default_per_provider[provider].
 *
 * Override validation chain (locked precedence — UTF-8 → empty → sentinel):
 *   1. fs.readFileSync(path) → Buffer (raw bytes, no decode).
 *   2. isUtf8(raw) from node:buffer — exits override-not-utf8 if false.
 *   3. raw.toString('utf8') — decode once.
 *   4. content.trim().length === 0 — exits empty-override-file.
 *   5. content.includes('BODY_SENTINEL_') — exits override-contains-sentinel-template.
 *   6. Inline FU N3: pre-read isFile() check — rejects symlink loops, FIFOs, dirs, sockets.
 *
 * Read-once contract: override is read EXACTLY once via fs.readFileSync;
 * decoded string held in memory for composition; no second read.
 *
 * Authority roots:
 *   - harnessRoot: this file's parent walk-up (frozen via import.meta.url).
 *   - projectRoot: caller-supplied; MUST match resolveRepoRoot per I-30.
 */

import { isUtf8 } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from '../../lib/local-dir.mjs'

// harnessRoot frozen at module load — never recomputed.
const __filename = fileURLToPath(import.meta.url)
const HARNESS_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..')
const PREAMBLES_DIR = path.join(HARNESS_ROOT, 'scripts', 'second-opinion', 'preambles')

// Registry path (source — install snapshot is separate per v3 §Registry).
const REGISTRY_PATH = path.join(PREAMBLES_DIR, 'index.json')

/**
 * Load preamble fragment registry from harnessRoot/scripts/second-opinion/preambles/index.json.
 * Returns { schema_version, default_per_provider, fragments: [{id, path}] }.
 * Throws on missing/malformed registry (caller exits non-zero).
 */
export function loadRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8')
  const reg = JSON.parse(raw)
  if (reg.schema_version !== 1) {
    const err = new Error(`unsupported registry schema_version: ${reg.schema_version}`)
    err.code = 'registry-schema-unsupported'
    throw err
  }
  return reg
}

/**
 * Resolve the override file path for a given provider in projectRoot.
 *
 * Per I-30: uses shared `resolveRepoRoot` from scripts/lib/local-dir.mjs —
 * the SAME algorithm storage adapters use. Worktree-local override at
 * <wt>/.review-store/preambles/<provider>.md is ORPHANED — composer reads
 * canonical-only (per I-31 / canonical-only worktree policy).
 */
export function resolveOverridePath(projectRoot, provider) {
  const canonicalRoot = resolveRepoRoot(projectRoot)
  return path.join(canonicalRoot, '.review-store', 'preambles', `${provider}.md`)
}

/**
 * Read and validate an override file per v3.3 byte-safe contract.
 *
 * Validation precedence (LOCKED):
 *   1. NOT regular file (symlink loop, FIFO, dir, socket) → 'override-not-regular-file'
 *      (Inline FU N3 — sub-3-LOC same-surface fix; no separate issue)
 *   2. Non-UTF8 bytes → 'override-not-utf8' (raw byte check before any decode)
 *   3. Empty / whitespace-only → 'empty-override-file' (post-decode trim)
 *   4. Contains 'BODY_SENTINEL_' literal → 'override-contains-sentinel-template'
 *
 * Returns: decoded UTF-8 string ready for composition.
 * Throws: { code, message, overridePath } — caller maps to exit code.
 */
export function readAndValidateOverride(overridePath) {
  // Inline FU N3: regular-file check (rejects symlink loops, FIFOs, dirs, sockets).
  // statSync follows symlinks; symlink-to-file is allowed; symlink loop throws.
  let st
  try {
    st = fs.statSync(overridePath)
  } catch (e) {
    const err = new Error(`Override file ${overridePath} cannot be stat'd: ${e.message}`)
    err.code = 'override-not-regular-file'
    err.overridePath = overridePath
    throw err
  }
  if (!st.isFile()) {
    const err = new Error(`Override file ${overridePath} is not a regular file`)
    err.code = 'override-not-regular-file'
    err.overridePath = overridePath
    throw err
  }

  // Read once into Buffer (raw bytes — no decode).
  // Read-once contract: this is the ONLY fs.readFileSync on overridePath in this function.
  const raw = fs.readFileSync(overridePath)

  // 2. UTF-8 validation on raw bytes — MUST fire first, before any decode.
  // Using node:buffer's isUtf8 (Buffer.isUtf8 is undefined on Node v20.12.0
  // per Codex r5 runtime probe).
  if (!isUtf8(raw)) {
    const err = new Error(`Override file ${overridePath} contains non-UTF8 bytes`)
    err.code = 'override-not-utf8'
    err.overridePath = overridePath
    throw err
  }

  // 3. Decode once for string-level checks.
  const content = raw.toString('utf8')

  // 4. Empty / whitespace-only check.
  if (content.trim().length === 0) {
    const err = new Error(`Override file ${overridePath} is empty or whitespace-only`)
    err.code = 'empty-override-file'
    err.overridePath = overridePath
    throw err
  }

  // 5. Body-sentinel template marker check.
  // Per v3.3: literal substring 'BODY_SENTINEL_' would instruct the model
  // to echo a sentinel that doesn't exist on prompt side, breaking the
  // body-sentinel probe semantics (v3 §Body-read sentinel probe).
  if (content.includes('BODY_SENTINEL_')) {
    const err = new Error(
      `Override file ${overridePath} contains BODY_SENTINEL_ literal — would break body-sentinel probe semantics`
    )
    err.code = 'override-contains-sentinel-template'
    err.overridePath = overridePath
    throw err
  }

  return content
}

/**
 * Read a fragment file from the registry.
 *
 * Note: per-fragment SHA validation (defense-in-depth against in-flight tamper)
 * is performed by the harness against the install snapshot, NOT here. This
 * function only reads.
 */
export function readFragment(fragmentEntry) {
  const fragmentPath = path.join(PREAMBLES_DIR, fragmentEntry.path)
  return fs.readFileSync(fragmentPath, 'utf8')
}

/**
 * Compose the per-provider preamble per the 3-tier resolution algorithm.
 *
 * Args: {
 *   provider: string,                  // e.g. 'codex', 'claude-subagent', 'gemini'
 *   projectRoot: string,               // canonical project root (caller resolved)
 *   cliFragments: string[]|null,       // --preamble <id>,... (null = not used)
 *   registry?: object,                 // pre-loaded registry; loadRegistry() if absent
 * }
 *
 * Returns: {
 *   preambleBody: string,              // composed preamble text
 *   preambleSource: 'cli-flag' | 'repo-override' | 'default',
 *   fragmentIds: string[],             // fragments composed (empty for repo-override)
 *   overridePath?: string,             // present iff source === 'repo-override'
 * }
 *
 * Throws: { code, message, ... } — caller maps to exit code.
 */
export function compose({ provider, projectRoot, cliFragments = null, registry }) {
  if (!provider) {
    const err = new Error('compose: provider is required')
    err.code = 'invalid-args'
    throw err
  }
  if (!projectRoot) {
    const err = new Error('compose: projectRoot is required')
    err.code = 'invalid-args'
    throw err
  }

  const reg = registry || loadRegistry()

  // Tier 1: CLI flag wins.
  if (cliFragments && cliFragments.length > 0) {
    const fragmentBodies = []
    for (const id of cliFragments) {
      const entry = reg.fragments.find((f) => f.id === id)
      if (!entry) {
        const err = new Error(`Unknown preamble fragment id: ${id}`)
        err.code = 'unknown-preamble-fragment'
        err.fragmentId = id
        throw err
      }
      fragmentBodies.push(readFragment(entry))
    }
    return {
      preambleBody: fragmentBodies.join('\n\n'),
      preambleSource: 'cli-flag',
      fragmentIds: [...cliFragments],
    }
  }

  // Tier 2: Repo override.
  const overridePath = resolveOverridePath(projectRoot, provider)
  if (fs.existsSync(overridePath)) {
    const content = readAndValidateOverride(overridePath)
    return {
      preambleBody: content,
      preambleSource: 'repo-override',
      fragmentIds: [],
      overridePath,
    }
  }

  // Tier 3: Default per provider.
  const defaultIds = reg.default_per_provider[provider]
  if (!defaultIds || defaultIds.length === 0) {
    const err = new Error(`No default preamble configured for provider: ${provider}`)
    err.code = 'no-default-preamble-for-provider'
    err.provider = provider
    throw err
  }
  const fragmentBodies = []
  for (const id of defaultIds) {
    const entry = reg.fragments.find((f) => f.id === id)
    if (!entry) {
      const err = new Error(`Default fragment id ${id} not in registry.fragments[]`)
      err.code = 'unknown-preamble-fragment'
      err.fragmentId = id
      throw err
    }
    fragmentBodies.push(readFragment(entry))
  }
  return {
    preambleBody: fragmentBodies.join('\n\n'),
    preambleSource: 'default',
    fragmentIds: [...defaultIds],
  }
}

// Exported constants for tests + harness.
export const __test_internals = { HARNESS_ROOT, PREAMBLES_DIR, REGISTRY_PATH }
