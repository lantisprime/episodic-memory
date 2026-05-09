/**
 * test-bp1-manifest-collect.mjs — collectEpisodeRecords +
 * verifyOnDiskEqualsManifest + sortable-id invariant (PR-1c-B Slice 2 commit 2).
 *
 * Round-2 codex consensus FU-1: deterministic episode_id order, no chronology
 * claim. FU-2 covers a 32-byte garbage key boundary in the orchestrator E2E
 * (commit 5), not here.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  collectEpisodeRecords,
  verifyOnDiskEqualsManifest,
  buildManifestPayload,
} from '../scripts/lib/bp1-manifest.mjs'

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

function mkTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-collect-'))
  // Init as git repo so canonicalProjectRootStrict works on it (not used here
  // directly but other helpers may resolve via git in future tests).
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory', 'episodes'), { recursive: true })
  return fs.realpathSync(dir)
}

function mkHomeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory', 'episodes'), { recursive: true })
  return dir
}

function withHome(homeDir, fn) {
  const orig = process.env.HOME
  process.env.HOME = homeDir
  try { return fn() } finally { process.env.HOME = orig }
}

// Match bp1-orchestrator.mjs:175-201 buildEpisodeFile emission rules:
//   - id/run_id/type/state/parent_episode/expected_post_episode_id/body_sha256/
//     hmac_signature/category/date/project → bare (JSON quoted iff value
//     contains whitespace or empty; the parser accepts both forms)
//   - summary/scheduled_tasks_capability/probe_reason/degraded_mode_statement/
//     time → always JSON-quoted (the orchestrator JSON.stringify's them)
//   - native_probe_performed/t2_fallback → bool literal
//   - tags → bare-token array literal
const ALWAYS_QUOTED = new Set([
  'summary', 'scheduled_tasks_capability', 'probe_reason',
  'degraded_mode_statement', 'time',
])

function writeEpisode(storeDir, episodeId, frontmatter, body = 'body content') {
  const fmLines = ['---']
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}: [${v.join(', ')}]`)
    } else if (v === null) {
      fmLines.push(`${k}: null`)
    } else if (typeof v === 'boolean') {
      fmLines.push(`${k}: ${v}`)
    } else if (ALWAYS_QUOTED.has(k) || (typeof v === 'string' && (v === '' || /[:\s"]/.test(v)))) {
      fmLines.push(`${k}: ${JSON.stringify(v)}`)
    } else {
      fmLines.push(`${k}: ${v}`)
    }
  }
  fmLines.push('---')
  fmLines.push('')
  const text = fmLines.join('\n') + body
  const filePath = path.join(storeDir, `${episodeId}.md`)
  fs.writeFileSync(filePath, text)
  return filePath
}

function bp1Frontmatter(id, runId, extra = {}) {
  return {
    id,
    run_id: runId,
    type: 'state-transition',
    state: 'run-started',
    parent_episode: null,
    expected_post_episode_id: null,
    summary: `summary for ${id}`,
    scheduled_tasks_capability: 'fallback',
    probe_reason: 'stub',
    degraded_mode_statement: '',
    native_probe_performed: false,
    t2_fallback: true,
    body_sha256: 'aa'.repeat(32),
    hmac_signature: 'bb'.repeat(32),
    tags: ['bp1-run-started'],
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// collectEpisodeRecords
// ---------------------------------------------------------------------------
t('collects from local store only when global is empty', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-foo-aaaa', bp1Frontmatter('20260508-103000-foo-aaaa', 'rfc-004-001'))
    writeEpisode(localDir, '20260508-103001-bar-bbbb', bp1Frontmatter('20260508-103001-bar-bbbb', 'rfc-004-001'))
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.equal(records.length, 2)
    assert.equal(records[0].episode_id, '20260508-103000-foo-aaaa')
    assert.equal(records[1].episode_id, '20260508-103001-bar-bbbb')
  })
})

t('collects from BOTH stores and de-duplicates by id', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    const globalDir = path.join(home, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-local-aaaa', bp1Frontmatter('20260508-103000-local-aaaa', 'rfc-004-001'))
    writeEpisode(globalDir, '20260508-103000-global-cccc', bp1Frontmatter('20260508-103000-global-cccc', 'rfc-004-001'))
    // Duplicate id in global — should be deduped
    writeEpisode(globalDir, '20260508-103000-local-aaaa', bp1Frontmatter('20260508-103000-local-aaaa', 'rfc-004-001'))
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.equal(records.length, 2)
  })
})

t('filters by run_id', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-mine-aaaa', bp1Frontmatter('20260508-103000-mine-aaaa', 'rfc-004-001'))
    writeEpisode(localDir, '20260508-103001-other-bbbb', bp1Frontmatter('20260508-103001-other-bbbb', 'rfc-004-002'))
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.equal(records.length, 1)
    assert.equal(records[0].episode_id, '20260508-103000-mine-aaaa')
  })
})

t('excludes bp1-run-manifest episodes (self-exclusion per RFC §777 v3.12)', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-rec-aaaa', bp1Frontmatter('20260508-103000-rec-aaaa', 'rfc-004-001'))
    writeEpisode(localDir, '20260508-103001-mfst-bbbb', bp1Frontmatter('20260508-103001-mfst-bbbb', 'rfc-004-001', { tags: ['bp1-run-manifest'] }))
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.equal(records.length, 1)
    assert.equal(records[0].episode_id, '20260508-103000-rec-aaaa')
  })
})

t('skips non-BP1 episodes (parser silently rejects them)', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-bp1-aaaa', bp1Frontmatter('20260508-103000-bp1-aaaa', 'rfc-004-001'))
    // Workplan-style episode with permissive frontmatter (multi-line body, blank lines)
    fs.writeFileSync(
      path.join(localDir, '20260508-103001-workplan-cccc.md'),
      '---\nid: 20260508-103001-workplan-cccc\n\ntitle: not-bp1\n---\nbody\n',
    )
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.equal(records.length, 1)
  })
})

t('collects actual orchestrator-shaped episode ids', () => {
  // Round-1 codex code-review BLOCKER: the prior predicate `^\d{8}-\d{6}-`
  // rejected real ids like `bp1-run-<ts>-<rfc>-<rand>-run-started-<rand4>`.
  // After dropping the predicate, real ids must round-trip cleanly.
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    const realId = 'bp1-run-1700000000000-rfc-004-abcdef-run-started-1234'
    writeEpisode(localDir, realId, bp1Frontmatter(realId, 'rfc-004-001'))
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.equal(records.length, 1)
    assert.equal(records[0].episode_id, realId)
  })
})

t('hard-fails when a BP-1-tagged run-related episode fails strict parse', () => {
  // Round-1 codex code-review MAJOR finding 2: corrupt run-tagged episode
  // must NOT silently disappear from the manifest.
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    // Valid frontmatter mentions the target run_id, but the body has malformed
    // frontmatter syntax (duplicate-key would also do; here we use an
    // unquoted summary with whitespace which the strict parser rejects).
    fs.writeFileSync(
      path.join(localDir, 'corrupt.md'),
      [
        '---',
        'id: corrupt-id',
        'run_id: rfc-004-001',
        'tags: [bp1-run-started]',
        'summary: this has whitespace and is not quoted',
        '---',
        'body',
      ].join('\n'),
    )
    assert.throws(
      () => collectEpisodeRecords('rfc-004-001', project),
      /BP-1-tagged episode .* failed strict parse/,
    )
  })
})

t('hard-fails on duplicate episode_id across stores with conflicting content', () => {
  // Round-1 codex code-review MAJOR finding 3: same id with different
  // canonical/body/hmac in local vs global must not silently collapse.
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    const globalDir = path.join(home, '.episodic-memory', 'episodes')
    const sharedId = '20260508-103000-shared-aaaa'
    writeEpisode(localDir, sharedId, bp1Frontmatter(sharedId, 'rfc-004-001', { body_sha256: 'aa'.repeat(32) }), 'local body')
    writeEpisode(globalDir, sharedId, bp1Frontmatter(sharedId, 'rfc-004-001', { body_sha256: 'cc'.repeat(32) }), 'global body — DIFFERENT')
    assert.throws(
      () => collectEpisodeRecords('rfc-004-001', project),
      /duplicate episode_id .* with conflicting content/,
    )
  })
})

t('idempotent dedup when both stores hold byte-equal episode files', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    const globalDir = path.join(home, '.episodic-memory', 'episodes')
    const sharedId = '20260508-103000-shared-aaaa'
    const fm = bp1Frontmatter(sharedId, 'rfc-004-001')
    writeEpisode(localDir, sharedId, fm, 'identical body')
    writeEpisode(globalDir, sharedId, fm, 'identical body')
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.equal(records.length, 1)
  })
})

t('returns empty array when no records match', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const records = collectEpisodeRecords('rfc-004-001', project)
    assert.deepEqual(records, [])
  })
})

t('throws on invalid runId shape', () => {
  const project = mkTempProject()
  assert.throws(() => collectEpisodeRecords('Bad Run Id!', project), /invalid run_id shape/)
})

t('throws on relative projectRoot', () => {
  assert.throws(() => collectEpisodeRecords('rfc-004-001', 'relative/path'), /absolute path/)
})

// ---------------------------------------------------------------------------
// verifyOnDiskEqualsManifest
// ---------------------------------------------------------------------------
t('verifyOnDiskEqualsManifest happy path', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-foo-aaaa', bp1Frontmatter('20260508-103000-foo-aaaa', 'rfc-004-001'))
    writeEpisode(localDir, '20260508-103001-bar-bbbb', bp1Frontmatter('20260508-103001-bar-bbbb', 'rfc-004-001'))
    const records = collectEpisodeRecords('rfc-004-001', project)
    const payload = buildManifestPayload(records, 'rfc-004-001', project, 'complete', '2026-05-08T10:30:30Z', 2)
    const result = verifyOnDiskEqualsManifest(payload, 'rfc-004-001', project)
    assert.equal(result.ok, true)
    assert.deepEqual(result.mismatches, [])
  })
})

t('verifyOnDiskEqualsManifest detects count mismatch', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-foo-aaaa', bp1Frontmatter('20260508-103000-foo-aaaa', 'rfc-004-001'))
    writeEpisode(localDir, '20260508-103001-bar-bbbb', bp1Frontmatter('20260508-103001-bar-bbbb', 'rfc-004-001'))
    const records = collectEpisodeRecords('rfc-004-001', project)
    // Manifest claims only 1 record but disk has 2
    const payload = {
      manifest_schema_version: '1.0',
      run_id: 'rfc-004-001',
      project_root: project,
      terminal_state: 'complete',
      finalized_at: '2026-05-08T10:30:30Z',
      episode_count: 1,
      episodes_records_root: 'x'.repeat(64),
      per_episode_records: [records[0]],
    }
    const result = verifyOnDiskEqualsManifest(payload, 'rfc-004-001', project)
    assert.equal(result.ok, false)
    assert.equal(result.mismatches[0].field, 'episode_count')
  })
})

t('verifyOnDiskEqualsManifest detects field tampering', () => {
  const project = mkTempProject()
  const home = mkHomeSandbox()
  withHome(home, () => {
    const localDir = path.join(project, '.episodic-memory', 'episodes')
    writeEpisode(localDir, '20260508-103000-foo-aaaa', bp1Frontmatter('20260508-103000-foo-aaaa', 'rfc-004-001'))
    const records = collectEpisodeRecords('rfc-004-001', project)
    // Tamper: flip body_sha256 in manifest
    records[0].body_sha256 = 'ff'.repeat(32)
    const payload = buildManifestPayload(records, 'rfc-004-001', project, 'complete', '2026-05-08T10:30:30Z', 1)
    const result = verifyOnDiskEqualsManifest(payload, 'rfc-004-001', project)
    assert.equal(result.ok, false)
    const m = result.mismatches.find(x => x.field === 'body_sha256')
    assert.ok(m, 'expected body_sha256 mismatch')
  })
})

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
