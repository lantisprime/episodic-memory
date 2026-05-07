#!/usr/bin/env node
/**
 * validate-rfc-artifact-manifest.mjs — RFC-004 §107-152 Rule-14 parity gate.
 *
 * The RFC documents the runtime-artifact manifest's shape in a fenced YAML
 * block (`artifact_manifest:` with surfaces scripts/hooks/settings_lines/
 * plugin_entries/agent_loaders/canonical_prompts). The builder script
 * `bp1-build-artifact-manifest.mjs` is the single source of truth for that
 * output (per RFC §154). This validator asserts the prose-illustrative YAML
 * stays in sync with the builder by checking:
 *
 *   1. Every required surface is enumerated in the RFC YAML block.
 *   2. Every explicit non-bp1-prefixed script the RFC mandates (closed list,
 *      RFC v3.11 — currently `scripts/em-review-request.mjs`) appears in the
 *      RFC's `scripts:` surface.
 *   3. The builder's output shape contains the same surface set (no extras,
 *      no missing).
 *
 * Scoped to RFC-004 (sole carrier of an artifact_manifest spec block today);
 * extensible to future RFCs that publish their own artifact_manifest.
 *
 * Usage:
 *   node validate-rfc-artifact-manifest.mjs                 # default RFC-004
 *   node validate-rfc-artifact-manifest.mjs <path-to.md>    # validate one file
 *   node validate-rfc-artifact-manifest.mjs --json
 */

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { NON_BP1_SCRIPTS, buildArtifactManifest } from './lib/bp1-manifest.mjs'

const REQUIRED_SURFACES = [
  'scripts',
  'scripts_lib',
  'hooks',
  'settings_lines',
  'plugin_entries',
  'agent_loaders',
  'canonical_prompts',
]

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const positional = argv.filter(a => !a.startsWith('--'))

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DEFAULT_RFC = path.join(REPO, 'docs', 'rfcs', 'RFC-004-bp1-auto-pilot.md')
const targets = positional.length ? positional.map(p => path.resolve(p)) : [DEFAULT_RFC]

const results = []
for (const file of targets) {
  results.push(validateFile(file))
}

const failed = results.filter(r => r.violations.length > 0)
if (wantJson) {
  console.log(JSON.stringify({
    status: failed.length ? 'fail' : 'ok',
    files_checked: results.length,
    files_failed: failed.length,
    results,
  }, null, 2))
} else {
  for (const r of results) {
    if (r.skipped) {
      console.log(`SKIP  ${path.relative(REPO, r.file)}: ${r.reason}`)
      continue
    }
    if (r.violations.length === 0) {
      console.log(`OK    ${path.relative(REPO, r.file)}: ${REQUIRED_SURFACES.length} surfaces declared`)
    } else {
      console.log(`FAIL  ${path.relative(REPO, r.file)}:`)
      for (const v of r.violations) console.log(`        ${v.kind}: ${v.detail}`)
    }
  }
}
process.exit(failed.length ? 1 : 0)

// ---------------------------------------------------------------------------
function validateFile(file) {
  if (!fs.existsSync(file)) {
    return { file, skipped: true, reason: 'not found', violations: [] }
  }
  const text = fs.readFileSync(file, 'utf8')
  const block = extractArtifactManifestBlock(text)
  if (!block) {
    return { file, skipped: true, reason: 'no artifact_manifest YAML block', violations: [] }
  }

  const violations = []

  // (1) Required surfaces present in the RFC YAML
  for (const surface of REQUIRED_SURFACES) {
    if (!hasSurfaceKey(block, surface)) {
      violations.push({ kind: 'missing-surface-in-rfc', detail: `RFC artifact_manifest block missing required surface: ${surface}` })
    }
  }

  // (2) Mandated non-bp1 scripts present in the RFC scripts: surface
  const scriptsBlock = extractSurfaceBlock(block, 'scripts')
  for (const required of NON_BP1_SCRIPTS) {
    if (!scriptsBlock || !scriptsBlock.includes(required)) {
      violations.push({ kind: 'missing-mandated-extension-script', detail: `RFC scripts: surface must explicitly enumerate "${required}" (RFC v3.11 closed-list contract)` })
    }
  }

  // (3) Builder output structural parity. Compare both surface set AND
  // top-level metadata keys (e.g. schema_version) — a future builder bump
  // that adds/removes a metadata field must update the RFC YAML in lockstep.
  let manifestKeys = []
  let manifestSchemaVersion = null
  try {
    const { manifest } = buildArtifactManifest({ projectRoot: REPO })
    manifestSchemaVersion = manifest.schema_version
    manifestKeys = Object.keys(manifest).filter(k => k !== 'schema_version').sort()
  } catch (e) {
    violations.push({ kind: 'builder-error', detail: `bp1-build-artifact-manifest failed: ${e.message}` })
  }
  const required = [...REQUIRED_SURFACES].sort()
  for (const k of required) {
    if (!manifestKeys.includes(k)) {
      violations.push({ kind: 'missing-surface-in-builder', detail: `builder output missing surface: ${k}` })
    }
  }
  for (const k of manifestKeys) {
    if (!required.includes(k)) {
      violations.push({ kind: 'unexpected-surface-in-builder', detail: `builder output has unspec'd surface: ${k}` })
    }
  }

  // (4) schema_version parity — RFC YAML must declare the same schema_version
  // value the builder emits. Without this, a builder bump can silently pass CI.
  if (manifestSchemaVersion !== null) {
    const rfcSchemaMatch = block.match(/^\s{2}schema_version:\s*(\d+)\s*$/m)
    const rfcSchemaVersion = rfcSchemaMatch ? parseInt(rfcSchemaMatch[1], 10) : null
    if (rfcSchemaVersion === null) {
      violations.push({ kind: 'rfc-missing-schema-version', detail: `builder emits schema_version=${manifestSchemaVersion}; RFC artifact_manifest block does not declare schema_version` })
    } else if (rfcSchemaVersion !== manifestSchemaVersion) {
      violations.push({ kind: 'schema-version-drift', detail: `builder schema_version=${manifestSchemaVersion} != RFC declared ${rfcSchemaVersion}` })
    }
  }

  return { file, skipped: false, surfaces: manifestKeys, violations }
}

function extractArtifactManifestBlock(text) {
  const fenceRe = /```yaml\s*\n([\s\S]*?)\n```/g
  let m
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1]
    if (/^\s*artifact_manifest:/m.test(body)) {
      return body
    }
  }
  return null
}

function hasSurfaceKey(yamlBody, key) {
  // Scope the match to children of the `artifact_manifest:` root (two-space
  // indent, but only inside that block). Codex P2: a sibling-context
  // appearance with two-space indent could otherwise satisfy the check.
  const lines = yamlBody.split('\n')
  let inRoot = false
  for (const raw of lines) {
    if (/^artifact_manifest:\s*$/.test(raw)) { inRoot = true; continue }
    if (!inRoot) continue
    if (/^\S/.test(raw)) break // exited the root block on a sibling root key
    if (new RegExp(`^\\s{2}${key}:`).test(raw)) return true
  }
  return false
}

function extractSurfaceBlock(yamlBody, surface) {
  // Pull the chunk from `^  <surface>:` until the next sibling key (also 2-space indent)
  const lines = yamlBody.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s{2}${surface}:`).test(lines[i])) { start = i + 1; break }
  }
  if (start < 0) return null
  const collected = []
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s{2}\S/.test(line)) break // next sibling
    collected.push(line)
  }
  return collected.join('\n')
}
