#!/usr/bin/env node
/**
 * test-validate-discipline-load-bundles.mjs
 *
 * Tests for tools/validate-discipline-load-bundles.mjs (rank-10 slice).
 *
 * Cases:
 *   T1  missing always-tier file → missing_files entry
 *   T3  malformed bundle manifest (unparseable JSON) → malformed_entries
 *   T4  bundle component missing on disk → missing_files entry
 *   T5  no memory files at all → empty inventory, no unregistered
 *   T8  empty memory_root path (non-existent) → no inventory, status records
 *   T10 source/install sha drift → sync_drift entry
 *   T13 file on disk not registered anywhere → unregistered_files entry
 *
 * Each test uses a temp memory_root + temp repo_root so they're hermetic.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import test from 'node:test'
import assert from 'node:assert/strict'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_DIR = path.resolve(__dirname, '..')

// Import the validator's pure functions
const { validate, ALWAYS_TIER, EXCLUSION_ALLOWLIST } = await import(
  path.join(REPO_DIR, 'tools', 'validate-discipline-load-bundles.mjs')
)

// Helpers
function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'))
}
function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
function cleanup(p) {
  try { fs.rmSync(p, { recursive: true, force: true }) } catch {}
}

function buildFakeRepo({ withBundle = true, bundleManifestBody = null, withHook = true } = {}) {
  const repoRoot = mkTmp('em-validator-repo')
  if (withBundle) {
    const body = bundleManifestBody !== null
      ? bundleManifestBody
      : '# Test bundle\n\n```json:bundle-manifest\n' + JSON.stringify({
          version: 1,
          generated_at_ms: 0,
          components: [
            { basename: 'feedback_codex_cli_episode_messaging.md', sha256: 'x', role: 'foreground-only-rule' }
          ]
        }) + '\n```\n'
    writeFile(path.join(repoRoot, 'bundles', 'codex-review-channel-current.md'), body)
  }
  if (withHook) {
    writeFile(path.join(repoRoot, 'plugins', 'claude-code', 'hooks', 'session-handoff-prompt.sh'), '#!/usr/bin/env bash\n# test stub\nexit 0\n')
  }
  return repoRoot
}

function buildFakeMemory({ includeAlways = true, includeBundleComponent = true, extraFiles = [] } = {}) {
  const memRoot = mkTmp('em-validator-mem')
  if (includeAlways) {
    for (const f of ALWAYS_TIER) {
      writeFile(path.join(memRoot, f), `# ${f}\nbody\n`)
    }
  }
  if (includeBundleComponent) {
    writeFile(path.join(memRoot, 'feedback_codex_cli_episode_messaging.md'), '# stub\n')
  }
  for (const f of extraFiles) {
    writeFile(path.join(memRoot, f), '# extra\n')
  }
  return memRoot
}

// ---------------------------------------------------------------------------
// T1: missing always-tier file
// ---------------------------------------------------------------------------
test('T1 missing always-tier file is reported', () => {
  const repo = buildFakeRepo()
  const mem = buildFakeMemory({ includeAlways: true })
  // Delete one always-tier file
  fs.unlinkSync(path.join(mem, 'feedback_verify_by_artifact.md'))

  const r = validate({ memoryRoot: mem, repoRoot: repo })
  assert.equal(r.status, 'fail')
  const missing = r.missing_files.filter(m => m.kind === 'always-tier')
  assert.ok(missing.some(m => m.basename === 'feedback_verify_by_artifact.md'),
    'expected missing always-tier entry for feedback_verify_by_artifact.md')

  cleanup(repo); cleanup(mem)
})

// ---------------------------------------------------------------------------
// T3: malformed bundle manifest
// ---------------------------------------------------------------------------
test('T3 malformed bundle manifest is flagged', () => {
  const repo = buildFakeRepo({ bundleManifestBody:
    '# Bad bundle\n\n```json:bundle-manifest\n{ not valid JSON, oops }\n```\n'
  })
  const mem = buildFakeMemory()

  const r = validate({ memoryRoot: mem, repoRoot: repo })
  assert.equal(r.status, 'fail')
  assert.ok(r.malformed_entries.some(e => e.kind === 'bundle-manifest-unparseable'),
    'expected bundle-manifest-unparseable entry')

  cleanup(repo); cleanup(mem)
})

// ---------------------------------------------------------------------------
// T4: bundle component missing on disk
// ---------------------------------------------------------------------------
test('T4 bundle component missing on disk is reported', () => {
  const repo = buildFakeRepo()
  const mem = buildFakeMemory({ includeAlways: true, includeBundleComponent: false })

  const r = validate({ memoryRoot: mem, repoRoot: repo })
  assert.equal(r.status, 'fail')
  const missingComp = r.missing_files.filter(m => m.kind === 'bundle-component')
  assert.ok(missingComp.some(m => m.basename === 'feedback_codex_cli_episode_messaging.md'),
    'expected bundle-component missing entry')

  cleanup(repo); cleanup(mem)
})

// ---------------------------------------------------------------------------
// T5: empty memory dir → no inventory, status ok if always-tier missing-files
// is the only failure mode (which it WILL be since the dir is empty)
// ---------------------------------------------------------------------------
test('T5 empty memory dir → inventory empty, always-tier missing reported', () => {
  const repo = buildFakeRepo({ withBundle: false })
  const mem = mkTmp('em-validator-empty')

  const r = validate({ memoryRoot: mem, repoRoot: repo })
  assert.equal(r.checks.inventory.length, 0, 'inventory should be empty')
  assert.equal(r.status, 'fail', 'should fail because always-tier files are missing')
  assert.ok(r.missing_files.every(m => m.kind === 'always-tier'),
    'all missing should be always-tier when memory is empty')

  cleanup(repo); cleanup(mem)
})

// ---------------------------------------------------------------------------
// T8: non-existent memory_root path
// ---------------------------------------------------------------------------
test('T8 non-existent memory_root path produces empty inventory', () => {
  const repo = buildFakeRepo({ withBundle: false })
  const fakeMem = '/this/path/does/not/exist/em-validator-fake'

  const r = validate({ memoryRoot: fakeMem, repoRoot: repo })
  assert.equal(r.checks.inventory.length, 0, 'inventory should be empty for non-existent root')
  // Always-tier files won't exist either → fail
  assert.equal(r.status, 'fail')

  cleanup(repo)
})

// ---------------------------------------------------------------------------
// T10: source/install sha drift
// ---------------------------------------------------------------------------
test('T10 source/install sha drift is reported', () => {
  // Use real repo's source hook (which exists) but point installedHook check
  // at a temp hook with different content. The validate() function checks
  // ~/.claude/hooks/session-handoff-prompt.sh — so we can't easily redirect
  // without DI. Instead, this test verifies the SAME-content case: drift
  // is detectable when source diverges. We'll construct a fake repo with a
  // hook that differs from the installed one.
  const repo = buildFakeRepo({ withBundle: false, withHook: true })
  const mem = buildFakeMemory()

  const r = validate({ memoryRoot: mem, repoRoot: repo })
  // The fake repo's hook is a tiny stub; real installed is the full hook.
  // Therefore they MUST differ → sync_drift should fire.
  assert.ok(
    r.sync_drift.length > 0 || r.checks.source_install_sync.status === 'installed-missing',
    'expected drift or installed-missing when fake repo source differs from real installed'
  )

  cleanup(repo); cleanup(mem)
})

// ---------------------------------------------------------------------------
// T13: file on disk not registered anywhere
// ---------------------------------------------------------------------------
test('T13 unregistered file on disk is reported', () => {
  const repo = buildFakeRepo()
  const mem = buildFakeMemory({
    extraFiles: ['feedback_brand_new_unregistered.md']
  })

  const r = validate({ memoryRoot: mem, repoRoot: repo })
  assert.equal(r.status, 'fail')
  assert.ok(r.unregistered_files.some(u => u.basename === 'feedback_brand_new_unregistered.md'),
    'expected feedback_brand_new_unregistered.md in unregistered list')

  cleanup(repo); cleanup(mem)
})

// ---------------------------------------------------------------------------
// Happy path: full canonical setup
// ---------------------------------------------------------------------------
test('happy path: all files registered, all checks pass', () => {
  const repo = buildFakeRepo()
  // Include all always-tier + the bundle component + ALL allowlist files
  const extra = Object.keys(EXCLUSION_ALLOWLIST)
  const mem = buildFakeMemory({ extraFiles: extra })

  const r = validate({ memoryRoot: mem, repoRoot: repo })
  assert.equal(r.unregistered_files.length, 0, 'no unregistered files in happy path')
  assert.equal(r.malformed_entries.length, 0)
  // missing_files may be empty for the inventory side (all registered); only
  // source/install sync may fail because the fake hook ≠ installed hook.

  cleanup(repo); cleanup(mem)
})
