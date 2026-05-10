#!/usr/bin/env node
/**
 * second-opinion.mjs — Pluggable second-opinion review harness.
 *
 * Subcommands:
 *   request   — Create a review request (writes via storage adapter, optionally dispatches provider)
 *   list-replies — List replies for a work-area
 *   rebuild-index — Rebuild file-storage index.jsonl from directory contents
 *
 * Two roots (per v3 §Two roots):
 *   harnessRoot: path.dirname(fileURLToPath(import.meta.url)) walked up — this file's parent
 *   projectRoot: --project flag > resolveRepoRoot(cwd) > error
 *
 * Storage:
 *   --storage episodic (default) — shells to em-store with cwd: projectRoot
 *   --storage files               — writes to projectRoot/.review-store/
 *
 * Preamble (v3.1/v3.2/v3.3):
 *   --preamble <id>[,<id>...]     — explicit fragment composition (CLI flag wins)
 *   else: <projectRoot>/.review-store/preambles/<provider>.md (repo override)
 *   else: registry default_per_provider[provider]
 *
 * Output: JSON envelope on stdout. Includes project_root, preamble_source.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from './lib/local-dir.mjs'
import { compose } from './second-opinion/preambles/composer.mjs'
import { validateProviderRegistry } from './second-opinion/lib/registry-validator.mjs'
import * as filesStorage from './second-opinion/storage/files.mjs'
import * as episodicStorage from './second-opinion/storage/episodic.mjs'
import { computeSourceHash } from './second-opinion/lib/source-hash.mjs'
import { readSnapshot, snapshotPath } from './second-opinion/lib/install-snapshot.mjs'

// harnessRoot frozen at module load.
const __filename = fileURLToPath(import.meta.url)
const HARNESS_ROOT = path.resolve(path.dirname(__filename), '..')
const PROVIDERS_REGISTRY = path.join(HARNESS_ROOT, 'scripts', 'second-opinion', 'providers', 'index.json')

// ---------------------------------------------------------------------------
// CLI arg parsing (matches em-store style)
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function hasFlag(name) {
  return argv.indexOf(name) !== -1
}

function emitErr(code, message, extra = {}) {
  console.log(JSON.stringify({ status: 'error', code, message, ...extra }))
  process.exit(1)
}

function emitOk(payload) {
  console.log(JSON.stringify({ status: 'ok', ...payload }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Subcommand dispatch
// ---------------------------------------------------------------------------
const subcommand = argv[0]
if (!subcommand) {
  emitErr('usage', 'Usage: second-opinion <request|list-replies|rebuild-index> [options]')
}

function resolveProjectRoot() {
  const explicit = flag('--project')
  if (explicit) {
    if (!path.isAbsolute(explicit)) return path.resolve(process.cwd(), explicit)
    return explicit
  }
  return resolveRepoRoot(process.cwd())
}

function loadAndValidateProviders() {
  let reg
  try {
    reg = JSON.parse(fs.readFileSync(PROVIDERS_REGISTRY, 'utf8'))
  } catch (e) {
    emitErr('registry-load-failed', `Cannot read providers registry at ${PROVIDERS_REGISTRY}: ${e.message}`)
  }
  try {
    validateProviderRegistry(reg)
  } catch (e) {
    emitErr(e.code || 'registry-invalid', e.message, {
      provider: e.provider, field: e.field, observed: e.observed, duplicate: e.duplicate,
    })
  }
  return reg
}

function findProvider(reg, providerId) {
  return reg.providers.find((p) => p.id === providerId)
}

function readBodyFromFlag() {
  const bodyArg = flag('--body')
  const bodyFilePath = flag('--body-file')
  if (bodyArg && bodyFilePath) {
    emitErr('mutually-exclusive', '--body and --body-file are mutually exclusive')
  }
  if (bodyArg) return bodyArg
  if (bodyFilePath) {
    try {
      return fs.readFileSync(bodyFilePath, 'utf8')
    } catch (e) {
      emitErr('body-file-read-failed', `Cannot read --body-file ${bodyFilePath}: ${e.message}`)
    }
  }
  emitErr('missing-body', 'Either --body or --body-file is required')
}

// ---------------------------------------------------------------------------
// Subcommand: request
// ---------------------------------------------------------------------------
/**
 * I-27a: Registry freshness gate — recompute source hash, compare with installed
 * snapshot. Mismatch → exit registry-stale-at-gate; no dispatch.
 *
 * Behavior modes:
 *   - Snapshot exists + hash matches → proceed.
 *   - Snapshot exists + hash mismatch → fail-close (registry-stale-at-gate).
 *   - Snapshot exists + missing source_hash → fail-close (snapshot-missing-source-hash).
 *   - Snapshot missing AND --enforce-snapshot OR SO_ENFORCE_SNAPSHOT=1 → fail-close.
 *   - Snapshot missing AND no enforce flag → dev mode (skip with no-op; one-line note).
 */
function checkRegistryFreshness() {
  const enforce = hasFlag('--enforce-snapshot') || process.env.SO_ENFORCE_SNAPSHOT === '1'
  const secondOpinionRoot = path.join(HARNESS_ROOT, 'scripts', 'second-opinion')

  let snapshot
  try {
    snapshot = readSnapshot()
  } catch (e) {
    if (e.code === 'snapshot-not-installed' && !enforce) {
      // Dev mode — no install yet. Proceed without gate (degraded).
      return { skipped: true, reason: 'snapshot-not-installed-dev-mode' }
    }
    emitErr(e.code || 'snapshot-read-failed', e.message, {
      snapshotPath: e.snapshotPath || snapshotPath(),
    })
  }

  const computed = computeSourceHash(secondOpinionRoot)
  if (computed.source_hash !== snapshot.source_hash) {
    emitErr('registry-stale-at-gate',
      `Source hash mismatch: installed snapshot is stale relative to current source. Run: node install.mjs --install-second-opinion`,
      {
        expected: computed.source_hash,
        installed: snapshot.source_hash,
        snapshotPath: snapshotPath(),
      })
  }
  return { skipped: false, snapshot, computed }
}

async function cmdRequest() {
  const provider = flag('--provider')
  if (!provider) emitErr('missing-flag', '--provider is required')

  // I-27a gate (first action — fail-close before any other work).
  const freshness = checkRegistryFreshness()

  const projectRoot = resolveProjectRoot()
  const reg = loadAndValidateProviders()
  const providerEntry = findProvider(reg, provider)
  if (!providerEntry) {
    emitErr('unknown-provider', `Provider ${provider} not in registry`, {
      provider, knownProviders: reg.providers.map((p) => p.id),
    })
  }

  const storageKind = flag('--storage') || 'episodic'
  if (storageKind !== 'episodic' && storageKind !== 'files') {
    emitErr('invalid-storage-flag', `--storage must be 'episodic' or 'files', got: ${storageKind}`)
  }

  // Compose preamble (3-tier resolution).
  const cliPreamble = flag('--preamble')
  const cliFragments = cliPreamble ? cliPreamble.split(',').map((s) => s.trim()).filter(Boolean) : null

  let composed
  try {
    // Pass snapshot to composer so per-fragment SHA validation (I-27b) fires
    // when snapshot is available. In dev mode (snapshot absent), composer
    // skips per-fragment validation consistently with harness I-27a behavior.
    composed = compose({
      provider, projectRoot, cliFragments,
      snapshot: freshness.snapshot || null,
    })
  } catch (e) {
    emitErr(e.code || 'compose-failed', e.message, {
      provider, fragmentId: e.fragmentId, overridePath: e.overridePath,
      expectedSha: e.expectedSha, observedSha: e.observedSha, fragmentPath: e.fragmentPath,
    })
  }

  const userBody = readBodyFromFlag()
  const fullBody = `${composed.preambleBody}\n\n---\n\n${userBody}`

  // prompt_max_chars overflow check (PRE-dispatch).
  if (fullBody.length > providerEntry.prompt_max_chars) {
    emitErr('prompt-overflow',
      `Composed prompt (${fullBody.length} chars) exceeds provider ${provider} prompt_max_chars (${providerEntry.prompt_max_chars})`,
      { provider, composedLength: fullBody.length, maxChars: providerEntry.prompt_max_chars })
  }

  // Write request via chosen storage.
  const summary = flag('--summary') || `second-opinion request (${provider})`
  const tagsRaw = flag('--tags') || ''
  const workArea = flag('--work-area') || ''
  const round = flag('--round') || '1'
  const meta = { summary, tags: tagsRaw, 'work-area': workArea, round, provider }

  let written
  try {
    if (storageKind === 'files') {
      written = filesStorage.writeRequest({ projectRoot, body: fullBody, meta })
    } else {
      written = episodicStorage.writeRequest({
        projectRoot, harnessRoot: HARNESS_ROOT, body: fullBody, meta,
      })
    }
  } catch (e) {
    emitErr(e.code || 'write-failed', e.message, { stderr: e.stderr })
  }

  // Optional synchronous dispatch via provider plugin.
  let dispatchResult = null
  let replyWritten = null
  if (hasFlag('--dispatch')) {
    const providerModulePath = path.join(
      HARNESS_ROOT, 'scripts', 'second-opinion', 'providers', `${provider}.mjs`
    )
    if (!fs.existsSync(providerModulePath)) {
      emitErr('provider-module-missing',
        `Provider module not found: ${providerModulePath}`, { provider })
    }
    let providerModule
    try {
      // Dynamic import — synchronous via top-level await isn't available in CLI;
      // use require-equivalent via createRequire instead. ESM dynamic import
      // returns a Promise, so we await via top-level wrapper.
      providerModule = await import(`file://${providerModulePath}`)
    } catch (e) {
      emitErr('provider-module-load-failed',
        `Cannot load provider module ${providerModulePath}: ${e.message}`, { provider })
    }

    if (typeof providerModule.available !== 'function' ||
        typeof providerModule.dispatch !== 'function') {
      emitErr('provider-contract-violation',
        `Provider ${provider} module must export available() and dispatch()`,
        { provider, providerModulePath })
    }

    const availability = providerModule.available()
    if (!availability.ok) {
      emitErr('provider-unavailable',
        `Provider ${provider} unavailable: ${availability.reason}`,
        { provider, availability })
    }

    try {
      dispatchResult = providerModule.dispatch({ prompt: fullBody, projectRoot })
    } catch (e) {
      emitErr('provider-dispatch-failed',
        `Provider ${provider} dispatch threw: ${e.message}`, { provider })
    }
    if (!dispatchResult.ok) {
      emitErr('provider-dispatch-nonzero',
        `Provider ${provider} exited non-zero (${dispatchResult.exitCode})`,
        { provider, dispatchResult })
    }

    // Persist reply via storage adapter using requestId from the request write.
    const requestId = written.id
    const replyMeta = {
      summary: `Reply (${provider}) to ${requestId}`,
      tags: tagsRaw,
      'work-area': workArea,
      round,
      provider,
    }
    try {
      if (storageKind === 'files') {
        replyWritten = filesStorage.writeReply({
          projectRoot, requestId, body: dispatchResult.stdout, meta: replyMeta,
        })
      } else {
        replyWritten = episodicStorage.writeReply({
          projectRoot, harnessRoot: HARNESS_ROOT, requestId,
          body: dispatchResult.stdout, meta: replyMeta,
        })
      }
    } catch (e) {
      emitErr(e.code || 'reply-write-failed', e.message, { stderr: e.stderr })
    }
  }

  emitOk({
    subcommand: 'request',
    project_root: projectRoot,
    harness_root: HARNESS_ROOT,
    provider,
    storage: storageKind,
    preamble_source: composed.preambleSource,
    fragment_ids: composed.fragmentIds,
    override_path: composed.overridePath || null,
    composed_length: fullBody.length,
    written,
    dispatched: dispatchResult !== null,
    dispatch_exit_code: dispatchResult ? dispatchResult.exitCode : null,
    reply: replyWritten,
  })
}

// ---------------------------------------------------------------------------
// Subcommand: list-replies (file-storage only; episodic uses em-search)
// ---------------------------------------------------------------------------
function cmdListReplies() {
  const projectRoot = resolveProjectRoot()
  const workArea = flag('--work-area') || ''
  const replies = filesStorage.listReplies({ projectRoot, workArea })
  emitOk({
    subcommand: 'list-replies',
    project_root: projectRoot,
    'work-area': workArea,
    count: replies.length,
    replies,
  })
}

// ---------------------------------------------------------------------------
// Subcommand: rebuild-index (file-storage only)
// ---------------------------------------------------------------------------
function cmdRebuildIndex() {
  const projectRoot = resolveProjectRoot()
  const result = filesStorage.rebuildIndex(projectRoot)
  emitOk({ subcommand: 'rebuild-index', project_root: projectRoot, ...result })
}

async function main() {
  switch (subcommand) {
    case 'request':
      await cmdRequest()
      break
    case 'list-replies':
      cmdListReplies()
      break
    case 'rebuild-index':
      cmdRebuildIndex()
      break
    default:
      emitErr('unknown-subcommand', `Unknown subcommand: ${subcommand}`, {
        knownSubcommands: ['request', 'list-replies', 'rebuild-index'],
      })
  }
}

main().catch((e) => {
  emitErr('uncaught', e.message, { stack: e.stack })
})
