#!/usr/bin/env node
/**
 * bp1-build-artifact-manifest.mjs — Emit the BP-1 runtime-artifact manifest
 * (RFC-004 §107-152). Thin CLI wrapper over `lib/bp1-manifest.mjs`.
 *
 * Used by:
 *   - install.mjs --bp1 (write into the activation entry)
 *   - operators (debug install drift)
 *   - tests (assert determinism)
 *
 * Determinism contract: two consecutive runs on the same install produce
 * identical sha256. CI test A14 enforces this.
 *
 * Usage:
 *   node bp1-build-artifact-manifest.mjs [--project <root>] [--yaml]
 *
 * Default output: JSON (sha256 + manifest object). Pass --yaml for the
 * pretty YAML form (used by operators inspecting drift).
 */

import path from 'path'
import { buildArtifactManifest, canonicalProjectRoot } from './lib/bp1-manifest.mjs'

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}
const projectArg = flag('--project')
const wantYaml = argv.includes('--yaml')

const projectRoot = projectArg
  ? path.resolve(projectArg)
  : canonicalProjectRoot()

if (!projectRoot) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Could not resolve canonical project root from cwd. Pass --project explicitly.',
  }))
  process.exit(1)
}

const { manifest, sha256 } = buildArtifactManifest({ projectRoot })

if (wantYaml) {
  console.log(toYaml({ artifact_manifest: manifest, sha256: `sha256:${sha256}` }))
} else {
  console.log(JSON.stringify({ status: 'ok', sha256, project_root: projectRoot, manifest }, null, 2))
}

function toYaml(value, indent = 0) {
  // Minimal YAML serializer for the manifest shape (objects + arrays + strings + numbers).
  // Sorted keys for determinism.
  const pad = ' '.repeat(indent)
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map(v => `${pad}- ${toYamlInline(v, indent + 2)}`).join('\n')
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    if (keys.length === 0) return '{}'
    return keys.map(k => {
      const v = value[k]
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return `${pad}${k}:\n${toYaml(v, indent + 2)}`
      }
      if (Array.isArray(v)) {
        if (v.length === 0) return `${pad}${k}: []`
        return `${pad}${k}:\n${toYaml(v, indent + 2)}`
      }
      return `${pad}${k}: ${toYaml(v, indent + 2)}`
    }).join('\n')
  }
  return JSON.stringify(value)
}
function toYamlInline(v, indent) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v).sort()
    return keys.map(k => `${k}: ${toYaml(v[k], indent + 2)}`).join(', ')
  }
  return toYaml(v, indent)
}
