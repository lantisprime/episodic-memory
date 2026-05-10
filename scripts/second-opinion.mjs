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
function cmdRequest() {
  const provider = flag('--provider')
  if (!provider) emitErr('missing-flag', '--provider is required')

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
    composed = compose({ provider, projectRoot, cliFragments })
  } catch (e) {
    emitErr(e.code || 'compose-failed', e.message, {
      provider, fragmentId: e.fragmentId, overridePath: e.overridePath,
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

switch (subcommand) {
  case 'request':
    cmdRequest()
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
