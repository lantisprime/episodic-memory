#!/usr/bin/env node
/**
 * bp1-flag-check.mjs — RFC-004 §158-167 activation gate.
 *
 * Every gated artifact reads via `bp1-flag-check.mjs --project <root>`
 * (or auto-derived from cwd). The check passes iff ALL of:
 *   1. Map entry exists for canonicalized current project root
 *   2. enabled === true
 *   3. artifact_version_hash matches the recomputed hash over the FULL
 *      runtime-artifact manifest
 *   4. verify_key_id matches the live verify-key fingerprint
 *
 * Plus invariants verified by the helper:
 *   - Verify-key file exists at ~/.episodic-memory/.verify-key
 *   - Verify-key file mode is 0600 (RFC-004 §665, failure row 29)
 *
 * Failure modes (RFC-004 failure table):
 *   bp1-disabled-refusal      — entry missing or enabled=false (row 25)
 *   bp1-flag-version-drift    — manifest hash mismatch          (row 26)
 *   bp1-flag-key-drift        — verify-key fingerprint mismatch (row 27)
 *   bp1-flag-config-corrupt   — config.json unparseable          (row 28)
 *   bp1-hmac-keyfile-fail     — verify-key missing/mode/size     (row 29)
 *
 * On mismatch: exits non-zero, writes structured JSON to stdout, and (when
 * --emit is on, default for production callers) emits a local-scope episode
 * via em-store. Tests pass --no-emit to keep assertions hermetic.
 *
 * Usage:
 *   node bp1-flag-check.mjs [--project <root>] [--config <path>] [--no-emit]
 *
 * Output is JSON to stdout in all cases (status: ok | fail). Use --no-emit
 * to suppress the local-scope episode side-effect (tests use this).
 */

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  buildArtifactManifest,
  readVerifyKey,
  canonicalProjectRoot,
  CONFIG_PATH,
} from './lib/bp1-manifest.mjs'

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}
function bool(name) {
  return argv.includes(name)
}

const projectArg = flag('--project')
const configArg = flag('--config') || CONFIG_PATH
const emit = !bool('--no-emit')

function fail(code, reason, extra = {}) {
  const result = { status: 'fail', code, reason, ...extra }
  console.log(JSON.stringify(result))
  if (emit) tryEmitEpisode(code, reason, extra)
  process.exit(2)
}

function ok(extra = {}) {
  const result = { status: 'ok', ...extra }
  console.log(JSON.stringify(result))
  process.exit(0)
}

function tryEmitEpisode(code, reason, extra) {
  // Local-scope episode for forensics. Best-effort; never let an emit failure
  // mask the actual fail reason. Per RFC-004 §69-75 (local scope for halt /
  // violation episodes).
  try {
    const repoScripts = path.resolve(path.dirname(new URL(import.meta.url).pathname))
    const emStore = path.join(repoScripts, 'em-store.mjs')
    if (!fs.existsSync(emStore)) return
    const projectName = extra.project_root ? path.basename(extra.project_root) : 'unknown'
    const summary = `bp1-flag-check ${code}: ${reason}`
    const body = `# ${code}\n\n${reason}\n\n` +
      '```json\n' + JSON.stringify(extra, null, 2) + '\n```\n'
    execFileSync('node', [
      emStore,
      '--project', projectName,
      '--category', 'violation',
      '--tags', `bp1,${code}`,
      '--scope', 'local',
      '--summary', summary,
      '--body', body,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 })
  } catch {
    // swallow
  }
}

// ---------------------------------------------------------------------------
// Resolve project root
// ---------------------------------------------------------------------------
let projectRoot
try {
  projectRoot = projectArg
    ? fs.realpathSync(path.resolve(projectArg))
    : canonicalProjectRoot()
} catch (e) {
  fail('bp1-disabled-refusal',
    `Project root unresolvable: ${e.message}`,
    { project_arg: projectArg, cwd: process.cwd() })
}

if (!projectRoot) {
  fail('bp1-disabled-refusal', 'Could not resolve canonical project root from cwd', {
    cwd: process.cwd(),
  })
}

// ---------------------------------------------------------------------------
// Verify-key invariants (file mode 0600, size 32)
// ---------------------------------------------------------------------------
const vk = readVerifyKey()
if (!vk.ok) {
  fail('bp1-hmac-keyfile-fail',
    `Verify-key ${vk.reason} (path: ${vk.path})`,
    { project_root: projectRoot, verify_key_state: vk })
}

// ---------------------------------------------------------------------------
// Read activation map
// ---------------------------------------------------------------------------
if (!fs.existsSync(configArg)) {
  fail('bp1-disabled-refusal',
    `Config file missing (no projects activated): ${configArg}`,
    { project_root: projectRoot, config_path: configArg })
}

let config
try {
  config = JSON.parse(fs.readFileSync(configArg, 'utf8'))
} catch (e) {
  fail('bp1-flag-config-corrupt',
    `Config JSON parse error: ${e.message}`,
    { project_root: projectRoot, config_path: configArg })
}

const activations = (config && config.bp1 && config.bp1.activations) || null
if (!activations || typeof activations !== 'object') {
  fail('bp1-flag-config-corrupt',
    'Config missing bp1.activations map (expected object)',
    { project_root: projectRoot, config_path: configArg })
}

const entry = activations[projectRoot]
if (!entry) {
  fail('bp1-disabled-refusal',
    `No activation entry for project root: ${projectRoot}`,
    { project_root: projectRoot })
}
if (entry.enabled !== true) {
  fail('bp1-disabled-refusal',
    `Activation entry exists but enabled=${entry.enabled}`,
    { project_root: projectRoot, entry })
}

// ---------------------------------------------------------------------------
// Recompute artifact manifest hash. Manifest-build can throw on permission /
// IO errors when reading installed scripts/hooks/agents/settings; treat any
// such throw as fail-closed version-drift rather than a raw Node exit.
// ---------------------------------------------------------------------------
let liveHash
try {
  ;({ sha256: liveHash } = buildArtifactManifest({ projectRoot }))
} catch (e) {
  fail('bp1-flag-version-drift',
    `Artifact manifest recomputation failed: ${e.message}`,
    { project_root: projectRoot, builder_error: e.message })
}
const expected = entry.artifact_version_hash
const expectedSha = typeof expected === 'string' && expected.startsWith('sha256:')
  ? expected.slice('sha256:'.length)
  : expected
if (!expectedSha || expectedSha !== liveHash) {
  fail('bp1-flag-version-drift',
    'Artifact manifest hash mismatch — install drift since activation',
    { project_root: projectRoot, expected: expectedSha, computed: liveHash })
}

// ---------------------------------------------------------------------------
// Verify-key fingerprint
// ---------------------------------------------------------------------------
if (entry.verify_key_id !== vk.fingerprint) {
  fail('bp1-flag-key-drift',
    'verify_key_id does not match live verify-key fingerprint',
    { project_root: projectRoot, expected: entry.verify_key_id, computed: vk.fingerprint })
}

ok({ project_root: projectRoot, artifact_version_hash: liveHash, verify_key_id: vk.fingerprint })
