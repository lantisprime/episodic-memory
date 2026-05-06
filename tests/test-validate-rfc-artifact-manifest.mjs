#!/usr/bin/env node
/**
 * test-validate-rfc-artifact-manifest.mjs — drift tests for the Rule-14
 * artifact-manifest parity validator.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'validate-rfc-artifact-manifest.mjs')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) { fail++; console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`) }
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rfc-mfst-${label}-`))
}

function fixture({ surfaces, includeEmReviewRequest = true, schemaVersion = 1 }) {
  let scriptsBlock = '  scripts:\n    - path: "scripts/bp1-orchestrator.mjs"\n      sha256: "<file-sha256>"\n'
  if (includeEmReviewRequest) {
    scriptsBlock += '    - path: "scripts/em-review-request.mjs"\n      sha256: "<file-sha256>"\n'
  }
  const surfaceBlocks = {
    scripts: scriptsBlock,
    hooks: '  hooks:\n    - path: ".claude/hooks/bp1-approval-check.sh"\n      sha256: "<sha>"\n',
    settings_lines: '  settings_lines:\n    sha256: "<filtered-sha>"\n',
    plugin_entries: '  plugin_entries:\n    sha256: "<filtered-sha>"\n',
    agent_loaders: '  agent_loaders:\n    - path: ".claude/agents/bp1-orchestrator.md"\n      sha256: "<sha>"\n',
    canonical_prompts: '  canonical_prompts:\n    - loader: ".claude/agents/bp1-orchestrator.md"\n      latest_prompt_episode_id: "20260506-X"\n',
  }
  let yaml = '```yaml\nartifact_manifest:\n'
  if (schemaVersion !== null) yaml += `  schema_version: ${schemaVersion}\n`
  for (const s of surfaces) yaml += surfaceBlocks[s]
  yaml += '```\n'
  return `# Fixture\n\n## Activation flag\n\n${yaml}`
}

function writeFixture(content) {
  const dir = makeTempDir('fix')
  const file = path.join(dir, 'RFC-fix.md')
  fs.writeFileSync(file, content)
  return file
}

function run(file) {
  const r = spawnSync('node', [SCRIPT, file, '--json'], { encoding: 'utf8' })
  return { exitCode: r.status, parsed: JSON.parse(r.stdout) }
}

const ALL = ['scripts', 'hooks', 'settings_lines', 'plugin_entries', 'agent_loaders', 'canonical_prompts']

tap('happy path: all 6 surfaces present + em-review-request listed → exit 0', () => {
  const file = writeFixture(fixture({ surfaces: ALL }))
  const r = run(file)
  assert.equal(r.exitCode, 0, JSON.stringify(r.parsed.results[0].violations))
})

tap('missing surface scripts → missing-surface-in-rfc', () => {
  const file = writeFixture(fixture({ surfaces: ALL.filter(s => s !== 'hooks') }))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  const kinds = r.parsed.results[0].violations.map(v => v.kind)
  assert.ok(kinds.includes('missing-surface-in-rfc'))
})

tap('em-review-request.mjs missing from scripts surface → missing-mandated-extension-script', () => {
  const file = writeFixture(fixture({ surfaces: ALL, includeEmReviewRequest: false }))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  const kinds = r.parsed.results[0].violations.map(v => v.kind)
  assert.ok(kinds.includes('missing-mandated-extension-script'))
})

tap('skip files without an artifact_manifest yaml block', () => {
  const file = writeFixture('# stub RFC\n\nno yaml block here\n')
  const r = run(file)
  assert.equal(r.exitCode, 0)
  assert.ok(r.parsed.results[0].skipped)
})

tap('schema_version drift between RFC and builder → schema-version-drift', () => {
  const file = writeFixture(fixture({ surfaces: ALL, schemaVersion: 99 }))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  const kinds = r.parsed.results[0].violations.map(v => v.kind)
  assert.ok(kinds.includes('schema-version-drift'))
})

tap('RFC missing schema_version → rfc-missing-schema-version', () => {
  const file = writeFixture(fixture({ surfaces: ALL, schemaVersion: null }))
  const r = run(file)
  assert.equal(r.exitCode, 1)
  const kinds = r.parsed.results[0].violations.map(v => v.kind)
  assert.ok(kinds.includes('rfc-missing-schema-version'))
})

tap('hasSurfaceKey: a key appearing only OUTSIDE artifact_manifest does not satisfy presence', () => {
  // Sibling-context fence: artifact_manifest has only 5 surfaces, but a
  // sibling root_block uses the same key name. Validator must NOT count it.
  const yaml = '```yaml\nartifact_manifest:\n  schema_version: 1\n  scripts:\n    - path: "scripts/bp1-orchestrator.mjs"\n      sha256: "<sha>"\n    - path: "scripts/em-review-request.mjs"\n      sha256: "<sha>"\n  hooks:\n    - path: ".claude/hooks/bp1-approval-check.sh"\n      sha256: "<sha>"\n  settings_lines:\n    sha256: "<sha>"\n  plugin_entries:\n    sha256: "<sha>"\n  agent_loaders:\n    - path: ".claude/agents/bp1-orchestrator.md"\n      sha256: "<sha>"\n\n# sibling root block, NOT a child of artifact_manifest:\nother_block:\n  canonical_prompts:\n    - loader: "decoy"\n      latest_prompt_episode_id: "X"\n```\n'
  const file = writeFixture(`# Fixture\n\n${yaml}`)
  const r = run(file)
  assert.equal(r.exitCode, 1)
  const kinds = r.parsed.results[0].violations.map(v => v.kind)
  assert.ok(kinds.includes('missing-surface-in-rfc'),
    `expected missing-surface-in-rfc, got ${JSON.stringify(kinds)}`)
})

tap('real RFC-004 spec validates', () => {
  const file = path.join(REPO, 'docs', 'rfcs', 'RFC-004-bp1-auto-pilot.md')
  if (!fs.existsSync(file)) return
  const r = run(file)
  assert.equal(r.exitCode, 0, `RFC-004 should validate; got ${JSON.stringify(r.parsed.results[0].violations)}`)
})

console.log(`\n1..${pass + fail}`)
if (fail) { console.log(`# FAILED ${fail} of ${pass + fail}`); process.exit(1) }
else console.log(`# PASSED ${pass}`)
