#!/usr/bin/env node
/**
 * test-topic-tracks.mjs — Compact tests for scripts/em-topic-tracks.mjs
 * (NAPMEM-C REQ-2/REQ-12). Covers:
 *   - Configuration: schema validation, malformed JSON, unknown keys, wrong
 *     version, fraction bounds (0 and >1), symlink rejection
 *   - CLI: --help success, --auto rejection (exit 2), unknown flag / positional
 *     argument / --flag=value form / missing --max-episodes value (all exit 2
 *     with runtime-schema-valid error objects), isolated empty HOME dry-run
 *     success without store creation
 *   - --only <substring> filtering
 *
 * Zero deps — Node stdlib + scripts/lib/json-instance-validate.mjs only.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import assert from 'assert'
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs'
import { tokenizeQuery } from '../scripts/lib/relevance.mjs'
import { computeContentSha256 } from '../scripts/lib/promotion-sources.mjs'
import {
  applyTopicTracks,
  buildTopicCandidates,
  collectTopicMembers,
  computeTopicFingerprint,
  scanTopicTracks,
} from '../scripts/topic-tracks/engine.mjs'
import { storeWriteLockPath } from '../scripts/lib/store-write-lock.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CLI = path.join(REPO, 'scripts', 'em-topic-tracks.mjs')
const COMMITTED_CONFIG_PATH = path.join(REPO, 'scripts', 'topic-tracks', 'config.json')
const CONFIG_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(REPO, 'schemas', 'topic-tracks-config.schema.json'), 'utf8'))
const IO_SCHEMA = JSON.parse(fs.readFileSync(
  path.join(REPO, 'schemas', 'runtime', 'topic-tracks-io.schema.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Registration / docs contract constants & loaders (NAPMEM-C REQ-2 / REQ-12)
// ---------------------------------------------------------------------------
const TOPIC_TRACKS_DESCRIPTOR_PATH = path.join(REPO, 'learning', 'em-topic-tracks.json')
const PROMOTE_DESCRIPTOR_PATH = path.join(REPO, 'learning', 'em-promote.json')
const LEARNING_DESCRIPTOR_SCHEMA_PATH = path.join(REPO, 'plugins', 'learning-descriptor.schema.json')
const PLUGINS_INDEX_PATH = path.join(REPO, 'plugins', '_index.json')
const CAPABILITIES_DOC_PATH = path.join(REPO, 'CAPABILITIES.md')
const RFC001_PATH = path.join(REPO, 'docs', 'rfcs', 'RFC-001-memory-improvements.md')
const EM_SCRIPTS_GUIDE_PATH = path.join(REPO, 'docs', 'EM_SCRIPTS_GUIDE.md')
const USER_MANUAL_PATH = path.join(REPO, 'docs', 'USER_MANUAL.md')
const INSTRUCTION_FILES = [
  ['SKILL.md', path.join(REPO, 'instructions', 'SKILL.md')],
  ['codex-skill.md', path.join(REPO, 'instructions', 'codex-skill.md')],
  ['AGENTS.md', path.join(REPO, 'instructions', 'AGENTS.md')],
  ['cursor.mdc', path.join(REPO, 'instructions', 'cursor.mdc')],
  ['windsurf.md', path.join(REPO, 'instructions', 'windsurf.md')],
]

function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}
function readTextFile(p) {
  return fs.readFileSync(p, 'utf8')
}
function missingFileError(label, p) {
  return `${label}: missing file ${p}`
}

let passed = 0, failed = 0
const asyncTests = []
const failures = []

const onlyArg = process.argv.slice(2)
let onlyFilter = null
const breakHardCap = onlyArg.includes('--break-hard-cap')
const breakSourceImmutability = onlyArg.includes('--break-source-immutability')
const breakStaleRevalidation = onlyArg.includes('--break-stale-revalidation')
for (let i = 0; i < onlyArg.length; i++) {
  if (onlyArg[i] === '--only' && i + 1 < onlyArg.length) {
    onlyFilter = onlyArg[i + 1]
    break
  }
}
const matches = (name) => !onlyFilter || name.includes(onlyFilter)

function test(name, fn) {
  if (!matches(name)) return
  try {
    fn()
    passed++
    console.log(`  ok ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

function testAsync(name, fn) {
  if (!matches(name)) return
  asyncTests.push((async () => {
    try {
      await fn()
      passed++
      console.log(`  ok ${name}`)
    } catch (e) {
      failed++
      failures.push({ name, error: e.message })
      console.log(`  FAIL ${name}: ${e.message}`)
    }
  })())
}

function makeSandbox(label = 'tt-test') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`)))
  const home = path.join(root, 'home')
  const cfgDir = path.join(root, 'cfg')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cfgDir, { recursive: true })
  return {
    root, home, cfgDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function runCli(args, sandbox, extraEnv = {}) {
  return spawnSync('node', [CLI, ...args], {
    cwd: sandbox.home,
    env: { ...process.env, HOME: sandbox.home, ...extraEnv },
    encoding: 'utf8',
  })
}

function readCommittedConfig() {
  return JSON.parse(fs.readFileSync(COMMITTED_CONFIG_PATH, 'utf8'))
}

function writeConfig(sandbox, mutator) {
  const cfg = readCommittedConfig()
  const mutated = mutator(cfg)
  const p = path.join(sandbox.cfgDir, 'config.json')
  fs.writeFileSync(p, JSON.stringify(mutated, null, 2))
  return p
}

// ---------------------------------------------------------------------------
// Configuration cases
// ---------------------------------------------------------------------------

test('config: committed config validates against topic-tracks-config schema', () => {
  const cfg = readCommittedConfig()
  const result = validateInstance(cfg, CONFIG_SCHEMA)
  assert.strictEqual(result.valid, true,
    'committed config must validate; errors=' + JSON.stringify(result.errors))
})

test('config: malformed JSON exits 1 with topic-tracks-config-invalid (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const cfgPath = path.join(sandbox.cfgDir, 'config.json')
    fs.writeFileSync(cfgPath, '{ this is not json }')
    const r = runCli([], sandbox, { EM_TOPIC_TRACKS_CONFIG_PATH: cfgPath })
    assert.strictEqual(r.status, 1, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.status, 'error')
    assert.strictEqual(out.error, 'topic-tracks-config-invalid')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate against runtime schema; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('apply: revalidation observes global and registered locks; releases both', () => {
  const sandbox = makeSandbox('tt-apply-revalidate')
  const globalDir = path.join(sandbox.home, '.episodic-memory')
  const regDir = path.join(sandbox.root, 'project', '.episodic-memory')
  const savedHome = process.env.HOME
  const savedReadFileSync = fs.readFileSync
  let observed = false
  try {
    writeFixtureStore(globalDir, 'global', [
      { id: 'g1', category: 'decision',
        summary: 'revalidation observes global and registered locks',
        tags: ['lock-track', 'revalidation'] },
    ])
    writeFixtureStore(regDir, 'project', [
      { id: 'r1', category: 'decision',
        summary: 'revalidation observes global and registered locks',
        tags: ['lock-track', 'revalidation'] },
      { id: 'r2', category: 'decision',
        summary: 'revalidation observes global and registered locks',
        tags: ['lock-track', 'revalidation'] },
    ])
    const cfg = readCommittedConfig()
    const registeredStores = [{
      store_id: '0123456789abcdef',
      label: 'project',
      data_dir: regDir,
      project_path: path.join(sandbox.root, 'project'),
    }]
    const dry = scanTopicTracks({ globalDir, registeredStores, config: cfg })
    assert.strictEqual(dry.candidates.length, 1,
      `expected sole candidate; got ${dry.candidates.length}; fps=${JSON.stringify(dry.candidates.map(c => c.fingerprint))}`)
    const fp = dry.candidates[0].fingerprint
    process.env.HOME = sandbox.home
    const episodePaths = new Set([
      path.join(globalDir, 'episodes', 'g1.md'),
      path.join(regDir, 'episodes', 'r1.md'),
      path.join(regDir, 'episodes', 'r2.md'),
    ])
    const gLock = storeWriteLockPath(globalDir)
    const rLock = storeWriteLockPath(regDir)
    fs.readFileSync = function(p, ...rest) {
      if (episodePaths.has(p) && fs.existsSync(gLock) && fs.existsSync(rLock)) {
        observed = true
      }
      return savedReadFileSync.call(this, p, ...rest)
    }
    const out = applyTopicTracks({
      globalDir, registeredStores, config: cfg,
      confirmed: new Set([fp]),
    })
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'apply output must validate; errors=' + JSON.stringify(valid.errors))
    assert.strictEqual(out.written.length, 1,
      `expected one written; got ${out.written.length}`)
    assert.strictEqual(observed, true,
      'revalidation readFileSync patches must have observed both locks held')
    assert.strictEqual(fs.existsSync(gLock), false,
      `expected global lock absent; ${gLock} exists=${fs.existsSync(gLock)}`)
    assert.strictEqual(fs.existsSync(rLock), false,
      `expected registered lock absent; ${rLock} exists=${fs.existsSync(rLock)}`)
  } finally {
    fs.readFileSync = savedReadFileSync
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    sandbox.cleanup()
  }
})
test('apply: registered source mutation during locked revalidation is stale; releases both locks', () => {
  const sandbox = makeSandbox('tt-apply-mutate')
  const globalDir = path.join(sandbox.home, '.episodic-memory')
  const regDir = path.join(sandbox.root, 'project', '.episodic-memory')
  const savedHome = process.env.HOME
  const savedReadFileSync = fs.readFileSync
  const r1Path = path.join(regDir, 'episodes', 'r1.md')
  let mutated = false
  try {
    writeFixtureStore(globalDir, 'global', [
      { id: 'g1', category: 'decision',
        summary: 'revalidation observes global and registered locks',
        tags: ['lock-track', 'revalidation'] },
    ])
    writeFixtureStore(regDir, 'project', [
      { id: 'r1', category: 'decision',
        summary: 'revalidation observes global and registered locks',
        tags: ['lock-track', 'revalidation'] },
      { id: 'r2', category: 'decision',
        summary: 'revalidation observes global and registered locks',
        tags: ['lock-track', 'revalidation'] },
    ])
    const cfg = readCommittedConfig()
    const registeredStores = [{
      store_id: '0123456789abcdef',
      label: 'project',
      data_dir: regDir,
      project_path: path.join(sandbox.root, 'project'),
    }]
    const dry = scanTopicTracks({ globalDir, registeredStores, config: cfg })
    assert.strictEqual(dry.candidates.length, 1,
      `expected sole candidate; got ${dry.candidates.length}; fps=${JSON.stringify(dry.candidates.map(c => c.fingerprint))}`)
    const fp = dry.candidates[0].fingerprint
    process.env.HOME = sandbox.home
    const gLock = storeWriteLockPath(globalDir)
    const rLock = storeWriteLockPath(regDir)
    fs.readFileSync = function(p, ...rest) {
      if (p === r1Path && fs.existsSync(gLock) && fs.existsSync(rLock) && !mutated) {
        fs.appendFileSync(r1Path, '\nmuta-line-during-revalidation\n')
        mutated = true
      }
      return savedReadFileSync.call(this, p, ...rest)
    }
    const out = applyTopicTracks({
      globalDir, registeredStores, config: cfg,
      confirmed: new Set([fp]),
    })
    assert.strictEqual(mutated, true,
      'monkeypatch must have appended to r1 under both locks')
    assert.strictEqual(out.written.length, 0,
      `expected no writes when revalidation goes stale; got ${out.written.length}`)
    const staleObserved = out.warnings.some(w => w.problem === 'stale-fingerprint')
    assert.ok(staleObserved !== breakStaleRevalidation,
      'expected stale-fingerprint warning (unless --break-stale-revalidation)')
    assert.strictEqual(fs.existsSync(gLock), false,
      `expected global lock absent; ${gLock} exists=${fs.existsSync(gLock)}`)
    assert.strictEqual(fs.existsSync(rLock), false,
      `expected registered lock absent; ${rLock} exists=${fs.existsSync(rLock)}`)
  } finally {
    fs.readFileSync = savedReadFileSync
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    sandbox.cleanup()
  }
})

test('config: unknown config key exits 1 with topic-tracks-config-invalid (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const cfgPath = writeConfig(sandbox, (c) => { c.bogus_key = 'hi'; return c })
    const r = runCli([], sandbox, { EM_TOPIC_TRACKS_CONFIG_PATH: cfgPath })
    assert.strictEqual(r.status, 1, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'topic-tracks-config-invalid')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('config: wrong config_version exits 1 with topic-tracks-config-invalid (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const cfgPath = writeConfig(sandbox, (c) => { c.version = '9.9.9'; return c })
    const r = runCli([], sandbox, { EM_TOPIC_TRACKS_CONFIG_PATH: cfgPath })
    assert.strictEqual(r.status, 1, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'topic-tracks-config-invalid')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('config: tag_jaccard_min = 0 (fractional zero) exits 1 with topic-tracks-config-invalid (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const cfgPath = writeConfig(sandbox, (c) => { c.tag_jaccard_min = 0; return c })
    const r = runCli([], sandbox, { EM_TOPIC_TRACKS_CONFIG_PATH: cfgPath })
    assert.strictEqual(r.status, 1, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'topic-tracks-config-invalid')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('config: tag_jaccard_min = 1.5 (>1) exits 1 with topic-tracks-config-invalid (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const cfgPath = writeConfig(sandbox, (c) => { c.tag_jaccard_min = 1.5; return c })
    const r = runCli([], sandbox, { EM_TOPIC_TRACKS_CONFIG_PATH: cfgPath })
    assert.strictEqual(r.status, 1, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'topic-tracks-config-invalid')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('config: symlinked config exits 1 with topic-tracks-config-symlink (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const real = path.join(sandbox.cfgDir, 'real.json')
    const link = path.join(sandbox.cfgDir, 'config.json')
    fs.writeFileSync(real, JSON.stringify(readCommittedConfig(), null, 2))
    fs.symlinkSync(real, link)
    const r = runCli([], sandbox, { EM_TOPIC_TRACKS_CONFIG_PATH: link })
    assert.strictEqual(r.status, 1, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'topic-tracks-config-symlink')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

// ---------------------------------------------------------------------------
// CLI cases
// ---------------------------------------------------------------------------

test('cli: --help exits 0 with structured help JSON', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--help'], sandbox)
    assert.strictEqual(r.status, 0, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.status, 'help')
    assert.strictEqual(out.script, 'em-topic-tracks.mjs')
    assert.ok(typeof out.usage === 'string' && out.usage.length > 0, 'usage must be non-empty')
    assert.ok(Array.isArray(out.notes), 'notes must be an array')
  } finally { sandbox.cleanup() }
})

test('cli: --auto exits 2 with auto-write-withdrawn (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--auto'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.status, 'error')
    assert.strictEqual(out.error, 'auto-write-withdrawn')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: mixed help input fails closed without reading config/store (table-driven)', () => {
  const cases = [
    [['--help', '--bogus'], 'unknown-flag'],
    [['--help', '--auto'], 'auto-write-withdrawn'],
    [['--help', 'extra-positional'], 'unknown-flag'],
  ]
  for (const [args, expectedError] of cases) {
    const sandbox = makeSandbox()
    try {
      const missingConfig = path.join(sandbox.cfgDir, 'no-such-config.json')
      const r = runCli(args, sandbox, {
        EM_TOPIC_TRACKS_CONFIG_PATH: missingConfig,
      })
      assert.strictEqual(r.status, 2,
        `args=${JSON.stringify(args)} exit=${r.status} stderr=${r.stderr}`)
      const out = JSON.parse(r.stdout)
      assert.strictEqual(out.status, 'error',
        `args=${JSON.stringify(args)} out=${r.stdout}`)
      assert.strictEqual(out.error, expectedError,
        `args=${JSON.stringify(args)} out=${r.stdout}`)
      const valid = validateInstance(out, IO_SCHEMA)
      assert.strictEqual(valid.valid, true,
        `error output for ${JSON.stringify(args)} must validate; errors=${JSON.stringify(valid.errors)}`)
    } finally { sandbox.cleanup() }
  }
})

test('cli: unknown flag exits 2 with unknown-flag (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--definitely-not-a-flag'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'unknown-flag')
    assert.strictEqual(out.detail, '--definitely-not-a-flag')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: positional argument exits 2 with unknown-flag (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['positional-extra'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'unknown-flag')
    assert.strictEqual(out.detail, 'positional-extra')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: --flag=value form exits 2 with unknown-flag (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--max-episodes=5'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'unknown-flag')
    assert.strictEqual(out.detail, '--max-episodes=5')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: missing --max-episodes value exits 2 with invalid-max-episodes (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--max-episodes'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'invalid-max-episodes')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: empty isolated HOME dry-run succeeds (runtime-schema-valid) and creates no ~/.episodic-memory', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli([], sandbox)
    assert.strictEqual(r.status, 0,
      `unexpected exit ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.status, 'ok')
    assert.strictEqual(out.dry_run, true)
    assert.ok(Array.isArray(out.candidates))
    assert.ok(Array.isArray(out.skipped))
    assert.ok(Array.isArray(out.warnings))
    assert.ok(Array.isArray(out.missing_sources))
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'dry-run output must validate against runtime schema; errors=' + JSON.stringify(valid.errors))
    const storeDir = path.join(sandbox.home, '.episodic-memory')
    assert.strictEqual(fs.existsSync(storeDir), false,
      `dry-run on isolated HOME must NOT create ${storeDir}`)
  } finally { sandbox.cleanup() }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// collectTopicMembers tests
// ---------------------------------------------------------------------------

function writeFixtureStore(storeDir, project, entries) {
  fs.mkdirSync(path.join(storeDir, 'episodes'), { recursive: true })
  const rows = []
  for (const e of entries) {
    const nl = e.lineEnding || '\n'
    const fmLines = [
      '---',
      `id: ${e.id}`,
      `project: ${e.project || project}`,
      `category: ${e.category}`,
      `summary: ${e.summary}`,
      `tags: ${JSON.stringify(e.tags || [])}`,
      `status: ${e.status || 'active'}`,
      `date: ${e.date || '2024-01-01'}`,
    ]
    if (e.promotion_sources) {
      fmLines.push(`promotion_sources: ${JSON.stringify(e.promotion_sources)}`)
    }
    fmLines.push('---')
    const fileContent = fmLines.join(nl) + nl + nl + (e.body || '') + nl
    fs.writeFileSync(path.join(storeDir, 'episodes', `${e.id}.md`), fileContent)
    const row = {
      id: e.id,
      project: e.project || project,
      category: e.category,
      summary: e.summary,
      tags: e.tags || [],
      status: e.status || 'active',
      date: e.date || '2024-01-01',
    }
    if (e.promotion_sources) row.promotion_sources = e.promotion_sources
    rows.push(row)
  }
  fs.writeFileSync(path.join(storeDir, 'index.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}

test('collect: global and registered members both collected', () => {
  const sandbox = makeSandbox('tt-collect-mix')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    const regDir = path.join(sandbox.root, 'reg')
    writeFixtureStore(globalDir, 'global', [
      { id: 'g1', category: 'decision', summary: 'global decision about caching', tags: ['cache'] },
    ])
    writeFixtureStore(regDir, 'projA', [
      { id: 'a1', category: 'lesson', summary: 'project lesson about caching', tags: ['cache'] },
    ])
    const cfg = readCommittedConfig()
    const result = collectTopicMembers({
      globalDir,
      registeredStores: [{ store_id: 'projA', label: 'projA', data_dir: regDir, project_path: '/p/projA' }],
      config: cfg,
    })
    assert.strictEqual(result.members.length, 2,
      `members=${JSON.stringify(result.members.map(m => m.source))}`)
    const ids = new Set(result.members.map(m => m.source.episode_id))
    assert.ok(ids.has('g1'), `missing g1; ids=${[...ids]}`)
    assert.ok(ids.has('a1'), `missing a1; ids=${[...ids]}`)
    const storeIds = new Set(result.members.map(m => m.source.store_id))
    assert.ok(storeIds.has('global'))
    assert.ok(storeIds.has('projA'))
    assert.deepStrictEqual(result.warnings, [])
    assert.deepStrictEqual(result.missing_sources, [])
  } finally { sandbox.cleanup() }
})

test('collect: only active configured source categories; excludes superseded and derived rows', () => {
  const sandbox = makeSandbox('tt-collect-filter')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    writeFixtureStore(globalDir, 'global', [
      { id: 'ok1', category: 'decision', summary: 'eligible decision row', tags: ['a'] },
      { id: 'sup1', category: 'decision', summary: 'old superseded decision', tags: ['a'], status: 'superseded' },
      { id: 'p1', category: 'pitfall', summary: 'pitfall entry not in source_categories', tags: ['a'] },
      { id: 'tt1', category: 'lesson', summary: 'topic track tag row', tags: ['topic-track'] },
      { id: 'ps1', category: 'decision', summary: 'promoted derived row', tags: ['b'],
        promotion_sources: [{ store_id: 'global', episode_id: 'x' }] },
    ])
    const cfg = readCommittedConfig()
    const result = collectTopicMembers({
      globalDir,
      registeredStores: [],
      config: cfg,
    })
    assert.strictEqual(result.members.length, 1,
      `members=${JSON.stringify(result.members.map(m => m.source))}`)
    assert.strictEqual(result.members[0].source.episode_id, 'ok1')
    assert.strictEqual(result.members[0].category, 'decision')
    assert.deepStrictEqual(result.warnings, [])
    assert.deepStrictEqual(result.missing_sources, [])
  } finally { sandbox.cleanup() }
})

test('collect: missing episode file yields missing_sources row and no member', () => {
  const sandbox = makeSandbox('tt-collect-missing')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'index.jsonl'),
      JSON.stringify({
        id: 'missing1', category: 'decision', summary: 'no file row',
        tags: [], status: 'active', date: '2024-01-01',
      }) + '\n')
    const cfg = readCommittedConfig()
    const result = collectTopicMembers({
      globalDir,
      registeredStores: [],
      config: cfg,
    })
    assert.deepStrictEqual(result.members, [])
    assert.deepStrictEqual(result.missing_sources,
      [{ store_id: 'global', episode_id: 'missing1' }])
    assert.deepStrictEqual(result.warnings, [])
  } finally { sandbox.cleanup() }
})

test('collect: registered store lacking string store_id yields store-identity-unavailable and no member', () => {
  const sandbox = makeSandbox('tt-collect-noidentity')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    const regDir = path.join(sandbox.root, 'reg')
    writeFixtureStore(regDir, 'projA', [
      { id: 'a1', category: 'lesson', summary: 'orphan row inside reg', tags: ['x'] },
    ])
    const cfg = readCommittedConfig()
    const result = collectTopicMembers({
      globalDir,
      registeredStores: [{ label: 'projA', data_dir: regDir, project_path: '/p/projA' }],
      config: cfg,
    })
    assert.deepStrictEqual(result.members, [])
    assert.strictEqual(result.warnings.length, 1)
    assert.strictEqual(result.warnings[0].problem, 'store-identity-unavailable')
    assert.strictEqual(result.warnings[0].store_id, 'projA')
    assert.deepStrictEqual(result.missing_sources, [])
  } finally { sandbox.cleanup() }
})

test('collect: identical id + LF/CRLF-normalized identical bytes across stores collapse to one with replica-collapsed warning', () => {
  const sandbox = makeSandbox('tt-collect-crlf')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    const regDir = path.join(sandbox.root, 'reg')
    writeFixtureStore(globalDir, 'shared-project', [
      { id: 'shared', category: 'decision', summary: 'shared summary text', tags: ['x'] },
    ])
    writeFixtureStore(regDir, 'shared-project', [
      { id: 'shared', category: 'decision', summary: 'shared summary text', tags: ['x'],
        lineEnding: '\r\n' },
    ])
    const cfg = readCommittedConfig()
    const result = collectTopicMembers({
      globalDir,
      registeredStores: [{ store_id: 'projA', label: 'projA', data_dir: regDir, project_path: '/p/projA' }],
      config: cfg,
    })
    assert.strictEqual(result.members.length, 1,
      `members=${JSON.stringify(result.members.map(m => m.source))}`)
    assert.strictEqual(result.members[0].source.store_id, 'global')
    assert.strictEqual(result.members[0].source.episode_id, 'shared')
    assert.strictEqual(result.warnings.length, 1)
    assert.strictEqual(result.warnings[0].problem, 'replica-collapsed')
    assert.strictEqual(result.warnings[0].store_id, 'projA')
    assert.strictEqual(result.warnings[0].episode_id, 'shared')
    assert.deepStrictEqual(result.missing_sources, [])
  } finally { sandbox.cleanup() }
})

test('collect: same id with distinct normalized bytes retains two members', () => {
  const sandbox = makeSandbox('tt-collect-distinct')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    const regDir = path.join(sandbox.root, 'reg')
    writeFixtureStore(globalDir, 'global', [
      { id: 'shared', category: 'decision', summary: 'first distinct summary content', tags: ['x'] },
    ])
    writeFixtureStore(regDir, 'projA', [
      { id: 'shared', category: 'decision', summary: 'second different distinct summary content', tags: ['x'] },
    ])
    const cfg = readCommittedConfig()
    const result = collectTopicMembers({
      globalDir,
      registeredStores: [{ store_id: 'projA', label: 'projA', data_dir: regDir, project_path: '/p/projA' }],
      config: cfg,
    })
    assert.strictEqual(result.members.length, 2,
      `members=${JSON.stringify(result.members.map(m => m.source))}`)
    const storeIds = new Set(result.members.map(m => m.source.store_id))
    assert.ok(storeIds.has('global'))
    assert.ok(storeIds.has('projA'))
    assert.strictEqual(result.warnings.length, 0)
    assert.deepStrictEqual(result.missing_sources, [])
  } finally { sandbox.cleanup() }
})

// --- mkMember helper: builds the exact member shape consumed by
// buildTopicCandidates (mirrors collectTopicMembers' pushed shape). ---
function mkMember(id, opts) {
  return {
    source: {
      store_id: opts.storeId,
      episode_id: id,
      content_sha256: opts.sha || 'a'.repeat(64),
    },
    store_dir: '/store/' + opts.storeId,
    project: opts.project,
    category: 'decision',
    date: opts.date,
    summary: opts.summary,
    tags: opts.tags,
    body: opts.body,
    tokens: new Set(opts.tokens),
  }
}

// --- buildTopicCandidates direct tests (six cases) ---
const BUILD_CFG = {
  ...readCommittedConfig(),
  min_cluster: 3,
  tag_jaccard_min: 0.5,
  summary_jaccard_min: 0.5,
}

test('build: tag threshold clusters 3 members', () => {
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['x', 'y', 'z'], tokens: ['one'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['x', 'y', 'z'], tokens: ['two'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['x', 'y', 'z'], tokens: ['three'] })
  const candidates = buildTopicCandidates([m1, m2, m3], BUILD_CFG)
  assert.strictEqual(candidates.length, 1, `expected 1 candidate; got ${candidates.length}`)
  assert.strictEqual(candidates[0].members.length, 3)
})

test('build: summary token threshold clusters 3 members', () => {
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['aa'], tokens: ['x', 'y', 'z'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['bb'], tokens: ['x', 'y', 'z'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['cc'], tokens: ['x', 'y', 'z'] })
  const candidates = buildTopicCandidates([m1, m2, m3], BUILD_CFG)
  assert.strictEqual(candidates.length, 1, `expected 1 candidate; got ${candidates.length}`)
  assert.strictEqual(candidates[0].members.length, 3)
})

test('build: below both thresholds returns no candidates', () => {
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['aa'], tokens: ['one'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['bb'], tokens: ['two'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['cc'], tokens: ['three'] })
  const candidates = buildTopicCandidates([m1, m2, m3], BUILD_CFG)
  assert.deepStrictEqual(candidates, [])
})

test('build: min_cluster=3 rejects a 2-member cluster that meets both thresholds', () => {
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const candidates = buildTopicCandidates([m1, m2], BUILD_CFG)
  assert.deepStrictEqual(candidates, [])
})

test('build: transitive A-B-C linkage produces one 3-member candidate even when A-C do not match', () => {
  const mA = mkMember('A', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'bA', summary: 'sA', tags: ['x', 'y'], tokens: [] })
  const mB = mkMember('B', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'bB', summary: 'sB', tags: ['x', 'y', 'z'], tokens: [] })
  const mC = mkMember('C', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'bC', summary: 'sC', tags: ['y', 'z', 'w'], tokens: [] })
  const candidates = buildTopicCandidates([mA, mB, mC], BUILD_CFG)
  assert.strictEqual(candidates.length, 1, `expected 1 transitive candidate; got ${candidates.length}`)
  assert.strictEqual(candidates[0].members.length, 3)
})

test('build: reversing input order yields deep-equal candidates (deterministic ordering)', () => {
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const forward = buildTopicCandidates([m1, m2, m3], BUILD_CFG)
  const reverse = buildTopicCandidates([m3, m2, m1], BUILD_CFG)
  assert.strictEqual(forward.length, 1)
  assert.deepStrictEqual(forward, reverse)
})

// --- direct-candidate spec: exact sorted keys, ceil majority common_tags,
// chronological body, fingerprint stability, max_episodes guard ---

test('build: candidate has exact sorted top-level keys and typed promotion source keys', () => {
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const candidates = buildTopicCandidates([m1, m2, m3], BUILD_CFG)
  assert.strictEqual(candidates.length, 1, `expected 1 candidate; got ${candidates.length}`)
  const c = candidates[0]
  assert.deepStrictEqual(
    Object.keys(c),
    ['fingerprint', 'common_tags', 'summary', 'body', 'promotion_sources', 'members']
  )
  assert.strictEqual(c.promotion_sources.length, 3)
  for (const ps of c.promotion_sources) {
    assert.deepStrictEqual(
      [...Object.keys(ps)].sort(),
      ['content_sha256', 'episode_id', 'store_id']
    )
  }
})

test('build: common_tags uses ceil majority support and returns sorted tags', () => {
  // 3 members; ceil(0.5 * 3) = 2 ⇒ tag must appear in >=2 members.
  // m1 tags [a,b,c]  m2 tags [a,b,d]  m3 tags [a,e,f]
  // Counts: a=3, b=2, c=1, d=1, e=1, f=1 ⇒ common = [a,b]; sort a<b.
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['a', 'b', 'c'], tokens: ['x', 'y', 'z'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['a', 'b', 'd'], tokens: ['x', 'y', 'z'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['a', 'e', 'f'], tokens: ['x', 'y', 'z'] })
  const candidates = buildTopicCandidates([m1, m2, m3], BUILD_CFG)
  assert.strictEqual(candidates.length, 1, `expected 1 candidate; got ${candidates.length}`)
  assert.deepStrictEqual(candidates[0].common_tags, ['a', 'b'])
})

test('build: chronological body lists older date before newer date regardless of input order', () => {
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  // Input order is reverse-chronological; body must still be chronological.
  const candidates = buildTopicCandidates([m3, m2, m1], BUILD_CFG)
  assert.strictEqual(candidates.length, 1, `expected 1 candidate; got ${candidates.length}`)
  const body = candidates[0].body
  const i1 = body.indexOf('2024-01-01')
  const i2 = body.indexOf('2024-01-02')
  const i3 = body.indexOf('2024-01-03')
  assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0, 'all three dates appear in body')
  assert.ok(i1 < i2, 'older date 2024-01-01 appears before 2024-01-02')
  assert.ok(i2 < i3, 'older date 2024-01-02 appears before 2024-01-03')
})

test('computeTopicFingerprint is stable under promotion-source input reordering', () => {
  const a = { store_id: 'global', episode_id: 'a', content_sha256: 'a'.repeat(64) }
  const b = { store_id: 'global', episode_id: 'b', content_sha256: 'b'.repeat(64) }
  const c = { store_id: 'global', episode_id: 'c', content_sha256: 'c'.repeat(64) }
  const fpFwd = computeTopicFingerprint([a, b, c])
  const fpRev = computeTopicFingerprint([c, b, a])
  const fpMid = computeTopicFingerprint([b, a, c])
  assert.strictEqual(fpFwd, fpRev, 'reverse order must match forward')
  assert.strictEqual(fpFwd, fpMid, 'mid order must match forward')
  assert.match(fpFwd, /^[0-9a-f]{64}$/, 'fingerprint must be 64 hex chars')
})

test('build: throws topic-tracks-max-episodes when member count exceeds max_episodes', () => {
  const tightCfg = { ...BUILD_CFG, max_episodes: 2 }
  const m1 = mkMember('a', { storeId: 'global', project: 'p', date: '2024-01-01', body: 'b1', summary: 's1', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m2 = mkMember('b', { storeId: 'global', project: 'p', date: '2024-01-02', body: 'b2', summary: 's2', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  const m3 = mkMember('c', { storeId: 'global', project: 'p', date: '2024-01-03', body: 'b3', summary: 's3', tags: ['x', 'y', 'z'], tokens: ['x', 'y', 'z'] })
  let caught = null
  try { buildTopicCandidates([m1, m2, m3], tightCfg) } catch (e) { caught = e }
  const errorObserved = caught !== null && caught.code === 'topic-tracks-max-episodes'
  assert.ok(errorObserved !== breakHardCap,
    'expected topic-tracks-max-episodes (unless --break-hard-cap)')
})

test('scan: warn_episodes threshold emits warning-threshold-exceeded', () => {
  const sandbox = makeSandbox('tt-scan-warn')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    writeFixtureStore(globalDir, 'global', [
      { id: 'w1', category: 'decision', summary: 'caching decision alpha', tags: ['cache', 'perf'] },
      { id: 'w2', category: 'decision', summary: 'caching decision beta',  tags: ['cache', 'perf'] },
      { id: 'w3', category: 'decision', summary: 'caching decision gamma', tags: ['cache', 'perf'] },
    ])
    const cfg = { ...readCommittedConfig(), warn_episodes: 2 }
    const out = scanTopicTracks({ globalDir, registeredStores: [], config: cfg })
    assert.strictEqual(out.status, 'ok')
    const warn = out.warnings.find(w => w.problem === 'warning-threshold-exceeded')
    assert.ok(warn, `expected warning-threshold-exceeded; got ${JSON.stringify(out.warnings)}`)
    assert.strictEqual(warn.count, 3)
  } finally { sandbox.cleanup() }
})

test('scan: representative dry-run output (with candidate) validates against IO_SCHEMA', () => {
  const sandbox = makeSandbox('tt-scan-io')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    writeFixtureStore(globalDir, 'global', [
      { id: 's1', category: 'decision', summary: 'caching decision alpha', tags: ['cache', 'perf'] },
      { id: 's2', category: 'decision', summary: 'caching decision beta',  tags: ['cache', 'perf'] },
      { id: 's3', category: 'decision', summary: 'caching decision gamma', tags: ['cache', 'perf'] },
    ])
    const cfg = readCommittedConfig()
    const out = scanTopicTracks({ globalDir, registeredStores: [], config: cfg })
    assert.ok(out.candidates.length >= 1, `expected at least 1 candidate; got ${out.candidates.length}`)
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'scan output must validate against IO_SCHEMA; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: --max-episodes 3 (tighten) succeeds on empty HOME; returned config.max_episodes === 3', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--max-episodes', '3'], sandbox)
    assert.strictEqual(r.status, 0,
      `unexpected exit ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.status, 'ok')
    assert.strictEqual(out.config.max_episodes, 3,
      `expected config.max_episodes=3; got ${out.config.max_episodes}`)
  } finally { sandbox.cleanup() }
})

test('cli: --max-episodes 2001 (loosen) exits 2 with invalid-max-episodes', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--max-episodes', '2001'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'invalid-max-episodes')
  } finally { sandbox.cleanup() }
})

test('cli: --apply without --confirm exits 2 with confirm-required (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--apply'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'confirm-required')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: --apply --confirm <bad> exits 2 with confirm-malformed (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const r = runCli(['--apply', '--confirm', 'bad'], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'confirm-malformed')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: --apply with repeated 64-hex confirmation exits 2 with confirm-duplicate (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const conf = 'a'.repeat(64)
    const r = runCli(['--apply', '--confirm', conf, '--confirm', conf], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'confirm-duplicate')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})

test('cli: --apply --confirm with unknown 64-hex value exits 2 with confirm-unknown (runtime-schema-valid)', () => {
  const sandbox = makeSandbox()
  try {
    const conf = 'a'.repeat(64)
    const r = runCli(['--apply', '--confirm', conf], sandbox)
    assert.strictEqual(r.status, 2, `exit=${r.status} stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.strictEqual(out.error, 'confirm-unknown')
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'error output must validate; errors=' + JSON.stringify(valid.errors))
  } finally { sandbox.cleanup() }
})
test('apply: confirmed subset writes typed provenance, preserves sources, chooses real project, and is idempotent', () => {
  const sandbox = makeSandbox('tt-apply-real')
  try {
    const globalDir = path.join(sandbox.home, '.episodic-memory')
    writeFixtureStore(globalDir, 'default-project', [
      { id: 'a1', project: 'zeta',  category: 'decision', date: '2024-01-01', summary: 'alpha zephyr quasar velvet unicorn',    tags: ['alpha-track'], body: 'velvet-uni-a1' },
      { id: 'a2', project: 'zeta',  category: 'decision', date: '2024-01-02', summary: 'alpha zephyr quasar gargoyle nucleus',  tags: ['alpha-track'], body: 'gargoyle-a2' },
      { id: 'a3', project: 'alpha', category: 'decision', date: '2024-01-03', summary: 'alpha zephyr quasar mushroom javelin',  tags: ['alpha-track'], body: 'mushroom-a3' },
      { id: 'b1', project: 'omega', category: 'decision', date: '2024-02-01', summary: 'mango horizon garden urethra oakley',   tags: ['beta-track'], body: 'urethra-b1' },
      { id: 'b2', project: 'omega', category: 'decision', date: '2024-02-02', summary: 'mango horizon garden nectarine poodle', tags: ['beta-track'], body: 'nectarine-b2' },
      { id: 'b3', project: 'omega', category: 'decision', date: '2024-02-03', summary: 'mango horizon garden penguin okra',     tags: ['beta-track'], body: 'penguin-b3' },
    ])
    const origBytes = new Map()
    for (const id of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']) {
      origBytes.set(id, fs.readFileSync(path.join(globalDir, 'episodes', `${id}.md`)))
    }
    const dry = runCli([], sandbox)
    assert.strictEqual(dry.status, 0, `dry exit=${dry.status} stdout=${dry.stdout} stderr=${dry.stderr}`)
    const dryOut = JSON.parse(dry.stdout)
    const dryValid = validateInstance(dryOut, IO_SCHEMA)
    assert.strictEqual(dryValid.valid, true,
      'dry output must validate; errors=' + JSON.stringify(dryValid.errors))
    assert.strictEqual(dryOut.status, 'ok')
    assert.strictEqual(dryOut.candidates.length, 2,
      `expected 2 candidates; got ${dryOut.candidates.length}; out=${dry.stdout}`)
    const chosen = dryOut.candidates.find(c => c.members.some(m => m.episode_id === 'a1'))
    const other = dryOut.candidates.find(c => c !== chosen)
    assert.ok(chosen, 'expected a candidate containing a1')
    assert.ok(other, 'expected the other candidate')
    const chosenFp = chosen.fingerprint
    const otherFp = other.fingerprint
    const apply = runCli(['--apply', '--confirm', chosenFp], sandbox)
    assert.strictEqual(apply.status, 0, `apply exit=${apply.status} stdout=${apply.stdout} stderr=${apply.stderr}`)
    const applyOut = JSON.parse(apply.stdout)
    const applyValid = validateInstance(applyOut, IO_SCHEMA)
    assert.strictEqual(applyValid.valid, true,
      'apply output must validate; errors=' + JSON.stringify(applyValid.errors))
    assert.strictEqual(applyOut.status, 'ok')
    assert.strictEqual(applyOut.written.length, 1,
      `expected exactly one written; got ${JSON.stringify(applyOut.written)}`)
    assert.deepStrictEqual(applyOut.unconfirmed, [otherFp],
      `unconfirmed must deep-equal [${otherFp}]; got ${JSON.stringify(applyOut.unconfirmed)}`)
    const writtenRow = applyOut.written[0]
    assert.strictEqual(writtenRow.fingerprint, chosenFp)
    assert.strictEqual(writtenRow.project, 'zeta',
      `lexical winner for alpha cluster must be zeta; got ${writtenRow.project}`)
    assert.ok(typeof writtenRow.episode_id === 'string' && writtenRow.episode_id.length > 0)
    const indexPath = path.join(globalDir, 'index.jsonl')
    const indexText = fs.readFileSync(indexPath, 'utf8')
    let persistedRow = null
    for (const line of indexText.split('\n')) {
      if (!line.trim()) continue
      const r = JSON.parse(line)
      if (r.id === writtenRow.episode_id) { persistedRow = r; break }
    }
    assert.ok(persistedRow, `no index row for written episode_id ${writtenRow.episode_id}`)
    assert.strictEqual(persistedRow.category, 'lesson',
      `written category must be lesson; got ${persistedRow.category}`)
    assert.ok(Array.isArray(persistedRow.tags) && persistedRow.tags.includes('topic-track'),
      `written tags must include topic-track; got ${JSON.stringify(persistedRow.tags)}`)
    assert.deepStrictEqual(persistedRow.promotion_sources, chosen.promotion_sources,
      `promotion_sources must deep-equal chosen typed promotion_sources`)
    let allBytesUnchanged = true
    for (const id of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']) {
      const after = fs.readFileSync(path.join(globalDir, 'episodes', `${id}.md`))
      if (Buffer.compare(origBytes.get(id), after) !== 0) allBytesUnchanged = false
    }
    assert.ok(allBytesUnchanged !== breakSourceImmutability,
      'all six source episode bytes must be unchanged (unless --break-source-immutability)')
    const dry2 = runCli([], sandbox)
    assert.strictEqual(dry2.status, 0, `second dry exit=${dry2.status} stdout=${dry2.stdout} stderr=${dry2.stderr}`)
    const dry2Out = JSON.parse(dry2.stdout)
    const dry2Valid = validateInstance(dry2Out, IO_SCHEMA)
    assert.strictEqual(dry2Valid.valid, true,
      'second dry output must validate; errors=' + JSON.stringify(dry2Valid.errors))
    const alreadyDerived = dry2Out.skipped.find(s => s.fingerprint === chosenFp)
    assert.ok(alreadyDerived,
      `expected already-derived skip for chosen fp ${chosenFp}; got ${JSON.stringify(dry2Out.skipped)}`)
    assert.strictEqual(alreadyDerived.reason, 'already-derived')
    const otherStillCandidate = dry2Out.candidates.find(c => c.fingerprint === otherFp)
    assert.ok(otherStillCandidate,
      `expected other candidate ${otherFp} to remain in second dry; got ${JSON.stringify(dry2Out.candidates.map(c => c.fingerprint))}`)
  } finally { sandbox.cleanup() }
})

test('apply: failed em-store child releases source lock', () => {
  const sandbox = makeSandbox('tt-apply-childfail')
  const sourceGlobal = path.join(sandbox.root, 'source-global')
  const failHome = path.join(sandbox.root, 'failhome')
  const savedHome = process.env.HOME
  try {
    writeFixtureStore(sourceGlobal, 'default-project', [
      { id: 'cf1', category: 'decision',
        summary: 'failed em-store child releases source lock',
        tags: ['childfail-track'] },
      { id: 'cf2', category: 'decision',
        summary: 'failed em-store child releases source lock',
        tags: ['childfail-track'] },
      { id: 'cf3', category: 'decision',
        summary: 'failed em-store child releases source lock',
        tags: ['childfail-track'] },
    ])
    const dry = scanTopicTracks({
      globalDir: sourceGlobal,
      registeredStores: [],
      config: readCommittedConfig(),
    })
    assert.strictEqual(dry.candidates.length, 1,
      `expected sole candidate; got ${dry.candidates.length}; fps=${JSON.stringify(dry.candidates.map(c => c.fingerprint))}`)
    const fp = dry.candidates[0].fingerprint
    fs.mkdirSync(failHome, { recursive: true })
    fs.writeFileSync(path.join(failHome, '.episodic-memory'), 'this is a regular file, not a directory\n')
    process.env.HOME = failHome
    const out = applyTopicTracks({
      globalDir: sourceGlobal,
      registeredStores: [],
      config: readCommittedConfig(),
      confirmed: new Set([fp]),
    })
    assert.strictEqual(out.written.length, 0,
      `expected no writes on em-store child failure; got ${out.written.length}`)
    const failed = out.warnings.find(w => w.problem === 'store-write-failed')
    assert.ok(failed, `expected store-write-failed warning; got ${JSON.stringify(out.warnings)}`)
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'apply output must validate against IO_SCHEMA; errors=' + JSON.stringify(valid.errors))
    const lockPath = storeWriteLockPath(sourceGlobal)
    assert.strictEqual(fs.existsSync(lockPath), false,
      `expected source lock ${lockPath} absent after child failure; exists=${fs.existsSync(lockPath)}`)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    sandbox.cleanup()
  }
})

testAsync('apply: concurrent confirmed applies serialize to one write and one already-derived skip', async () => {
  const sandbox = makeSandbox('tt-apply-concurrent')
  const globalDir = path.join(sandbox.home, '.episodic-memory')
  const ids = ['cc1', 'cc2', 'cc3']
  // Local marker/child collection helpers.
  const liveChildren = new Set()
  const collectChild = (child) => {
    const entry = { child }
    liveChildren.add(entry)
    child.once('exit', () => liveChildren.delete(entry))
    return entry
  }
  const releaseAndKill = async () => {
    for (const { child } of liveChildren) {
      if (child.exitCode === null && !child.killed) {
        try { child.stdin.write('release\n') } catch { /* pipe may be closed */ }
        try { child.stdin.end() } catch { /* pipe may be closed */ }
        try { child.kill('SIGTERM') } catch { /* already exited */ }
      }
    }
    await Promise.allSettled([...liveChildren].map(({ child }) => new Promise((res) => {
      if (child.exitCode !== null) return res()
      const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } res() }, 2000)
      child.once('exit', () => { clearTimeout(t); res() })
    })))
  }
  try {
    writeFixtureStore(globalDir, 'default-project', [
      { id: 'cc1', category: 'decision',
        summary: 'concurrent confirmed applies serialize to one write and one already-derived skip',
        tags: ['concurrent-track'] },
      { id: 'cc2', category: 'decision',
        summary: 'concurrent confirmed applies serialize to one write and one already-derived skip',
        tags: ['concurrent-track'] },
      { id: 'cc3', category: 'decision',
        summary: 'concurrent confirmed applies serialize to one write and one already-derived skip',
        tags: ['concurrent-track'] },
    ])
    const origBytes = new Map()
    for (const id of ids) {
      origBytes.set(id, fs.readFileSync(path.join(globalDir, 'episodes', `${id}.md`)))
    }
    const cfg = readCommittedConfig()
    const dry = scanTopicTracks({ globalDir, registeredStores: [], config: cfg })
    assert.strictEqual(dry.candidates.length, 1,
      `expected sole candidate; got ${dry.candidates.length}; fps=${JSON.stringify(dry.candidates.map(c => c.fingerprint))}`)
    const fp = dry.candidates[0].fingerprint
    // Spawn independent holder child that atomically creates the global store
    // write-lock file, prints a JSON marker, and waits for stdin release.
    const lockPath = storeWriteLockPath(globalDir)
    const holderSource = [
      "const fs = await import('node:fs');",
      `const lockPath = ${JSON.stringify(lockPath)};`,
      "let fd;",
      "try {",
      "  fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);",
      "} catch (e) {",
      "  process.stderr.write('holder: open failed: ' + e.message + '\\n');",
      "  process.exit(1);",
      "}",
      "fs.writeSync(fd, process.pid + '\\n' + new Date().toISOString() + '\\n' + process.ppid + '\\n');",
      "fs.closeSync(fd);",
      "process.stdout.write(JSON.stringify({ held: true }) + '\\n');",
      "const cleanup = () => { try { fs.unlinkSync(lockPath); } catch (_) {} process.exit(0); };",
      "const t = setTimeout(cleanup, 15000);",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk;",
      "  if (buf.includes('release')) { clearTimeout(t); cleanup(); }",
      "});",
      "process.stdin.on('end', () => { clearTimeout(t); cleanup(); });",
      "process.on('SIGTERM', () => { clearTimeout(t); cleanup(); });",
      "",
    ].join('\n')
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSource], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: sandbox.home },
    })
    collectChild(holder)
    let holderOut = ''
    let holderErr = ''
    holder.stdout.setEncoding('utf8')
    holder.stderr.setEncoding('utf8')
    holder.stdout.on('data', (d) => { holderOut += d })
    holder.stderr.on('data', (d) => { holderErr += d })
    const markerMatch = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`holder marker timeout after 5000ms; stdout=${holderOut} stderr=${holderErr}`)), 5000)
      const onChunk = (chunk) => {
        for (const line of chunk.split('\n')) {
          const t = line.trim()
          if (!t) continue
          try {
            const obj = JSON.parse(t)
            if (obj && obj.held === true) {
              clearTimeout(timer)
              holder.stdout.off('data', onChunk)
              return resolve(obj)
            }
          } catch (_) { /* keep scanning */ }
        }
      }
      holder.stdout.on('data', onChunk)
      holder.once('exit', (code) => {
        clearTimeout(timer)
        holder.stdout.off('data', onChunk)
        reject(new Error(`holder exited early code=${code}; stdout=${holderOut} stderr=${holderErr}`))
      })
    })
    assert.deepStrictEqual(markerMatch, { held: true })
    assert.strictEqual(fs.existsSync(lockPath), true,
      `expected lock ${lockPath} to exist after holder marker; exists=${fs.existsSync(lockPath)}`)
    // Spawn TWO concurrent CLI children applying the same fingerprint.
    const envCli = { ...process.env, HOME: sandbox.home }
    const cliA = spawn('node', [CLI, '--apply', '--confirm', fp], {
      env: envCli,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const cliB = spawn('node', [CLI, '--apply', '--confirm', fp], {
      env: envCli,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    collectChild(cliA)
    collectChild(cliB)
    const capture = (stream, sink) => {
      stream.setEncoding('utf8')
      stream.on('data', (d) => { sink.value += d })
      return sink
    }
    const outA = { stdout: { value: '' }, stderr: { value: '' } }
    const outB = { stdout: { value: '' }, stderr: { value: '' } }
    capture(cliA.stdout, outA.stdout)
    capture(cliA.stderr, outA.stderr)
    capture(cliB.stdout, outB.stdout)
    capture(cliB.stderr, outB.stderr)
    const waitClosed = (child) => new Promise((res) => {
      if (child.exitCode !== null) return res({ code: child.exitCode, signal: child.signalCode })
      child.once('close', (code, signal) => res({ code, signal }))
    })
    const cliAResult = waitClosed(cliA)
    const cliBResult = waitClosed(cliB)
    const holderResult = waitClosed(holder)
    await new Promise((r) => setTimeout(r, 1000))
    assert.strictEqual(cliA.exitCode, null, `cliA should still be blocked after 1000ms; exitCode=${cliA.exitCode}`)
    assert.strictEqual(cliB.exitCode, null, `cliB should still be blocked after 1000ms; exitCode=${cliB.exitCode}`)
    assert.strictEqual(holder.exitCode, null, `holder should still be alive after 1000ms; exitCode=${holder.exitCode}`)
    // Release the lock and let the holder unlink/exit.
    try { holder.stdin.write('release\n') } catch { /* pipe may be closed */ }
    try { holder.stdin.end() } catch { /* pipe may be closed */ }
    const [rA, rB, rH] = await Promise.all([cliAResult, cliBResult, holderResult])
    assert.strictEqual(rA.code, 0, `cliA exit=${rA.code} signal=${rA.signal} stdout=${outA.stdout.value} stderr=${outA.stderr.value}`)
    assert.strictEqual(rB.code, 0, `cliB exit=${rB.code} signal=${rB.signal} stdout=${outB.stdout.value} stderr=${outB.stderr.value}`)
    const parsedA = JSON.parse(outA.stdout.value)
    const parsedB = JSON.parse(outB.stdout.value)
    const validA = validateInstance(parsedA, IO_SCHEMA)
    const validB = validateInstance(parsedB, IO_SCHEMA)
    assert.strictEqual(validA.valid, true,
      `cliA IO_SCHEMA invalid; errors=${JSON.stringify(validA.errors)}; out=${outA.stdout.value}`)
    assert.strictEqual(validB.valid, true,
      `cliB IO_SCHEMA invalid; errors=${JSON.stringify(validB.errors)}; out=${outB.stdout.value}`)
    const totalWritten = parsedA.written.length + parsedB.written.length
    assert.strictEqual(totalWritten, 1,
      `expected sum written.length===1 across both CLIs; got A=${parsedA.written.length} B=${parsedB.written.length}; A=${outA.stdout.value} B=${outB.stdout.value}`)
    const skippedMatches = [...parsedA.skipped, ...parsedB.skipped].filter(
      (s) => s && s.fingerprint === fp && s.reason === 'already-derived')
    assert.strictEqual(skippedMatches.length, 1,
      `expected exactly one already-derived skip for fp ${fp}; got ${JSON.stringify([...parsedA.skipped, ...parsedB.skipped])}`)
    // Index has exactly one active lesson carrying the topic-track tag.
    const indexText = fs.readFileSync(path.join(globalDir, 'index.jsonl'), 'utf8')
    let activeLessons = 0
    let lessonRow = null
    for (const line of indexText.split('\n')) {
      if (!line.trim()) continue
      const r = JSON.parse(line)
      if (r.category === 'lesson' && r.status === 'active' &&
          Array.isArray(r.tags) && r.tags.includes('topic-track')) {
        activeLessons++
        lessonRow = r
      }
    }
    assert.strictEqual(activeLessons, 1,
      `expected exactly one active topic-track lesson in index; got ${activeLessons}; index=${indexText}`)
    assert.ok(lessonRow && Array.isArray(lessonRow.promotion_sources) && lessonRow.promotion_sources.length === 3,
      `lesson must have 3 promotion_sources; got ${JSON.stringify(lessonRow && lessonRow.promotion_sources)}`)
    // All three source bytes unchanged.
    for (const id of ids) {
      const after = fs.readFileSync(path.join(globalDir, 'episodes', `${id}.md`))
      assert.strictEqual(Buffer.compare(origBytes.get(id), after), 0,
        `source episode ${id} bytes must be unchanged`)
    }
    // Lock must be absent after both CLIs exit.
    assert.strictEqual(fs.existsSync(lockPath), false,
      `expected lock ${lockPath} absent after both CLIs exited; exists=${fs.existsSync(lockPath)}`)
  } finally {
    await releaseAndKill()
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Registration / docs contract tests (NAPMEM-C REQ-2 / REQ-12)
// ---------------------------------------------------------------------------

test('regression: bodyOf strips frontmatter and immediate H1, keeps real body', () => {
  const sandbox = makeSandbox('tt-bodyof')
  try {
    const globalDir = path.join(sandbox.root, 'global')
    fs.mkdirSync(path.join(globalDir, 'episodes'), { recursive: true })
    const episodeContent = (id, body) => {
      return '---\n' +
        `id: ${id}\n` +
        `project: global\n` +
        `category: decision\n` +
        `summary: bodyOf strips frontmatter and H1 regression\n` +
        `tags: ["bodyof-track"]\n` +
        `status: active\n` +
        `date: 2024-01-${id === 'b1' ? '01' : id === 'b2' ? '02' : '03'}\n` +
        '---\n\n' +
        `# bodyOf strips frontmatter and H1 regression\n\n` +
        body + '\n'
    }
    fs.writeFileSync(path.join(globalDir, 'episodes', 'b1.md'), episodeContent('b1', '### Section A\n\nReal body paragraph one.\n\n---\n\nA separator line inside the real body must remain.'))
    fs.writeFileSync(path.join(globalDir, 'episodes', 'b2.md'), episodeContent('b2', '### Section B\n\nReal body paragraph two.'))
    fs.writeFileSync(path.join(globalDir, 'episodes', 'b3.md'), episodeContent('b3', '### Section C\n\nReal body paragraph three.'))
    const rows = ['b1', 'b2', 'b3'].map(id => JSON.stringify({
      id, project: 'global', category: 'decision',
      summary: 'bodyOf strips frontmatter and H1 regression',
      tags: ['bodyof-track'], status: 'active',
      date: `2024-01-${id === 'b1' ? '01' : id === 'b2' ? '02' : '03'}`,
    }))
    fs.writeFileSync(path.join(globalDir, 'index.jsonl'), rows.join('\n') + '\n')
    const cfg = readCommittedConfig()
    const out = scanTopicTracks({ globalDir, registeredStores: [], config: cfg })
    assert.strictEqual(out.candidates.length, 1, `expected one candidate; got ${out.candidates.length}`)
    const body = out.candidates[0].body
    assert.ok(body.includes('Real body paragraph one'), `candidate body missing real content; body=${body}`)
    assert.ok(body.includes('A separator line inside the real body must remain'), `candidate body missing separator paragraph; body=${body}`)
    assert.ok(!body.includes('id: b1'), `candidate body must not leak frontmatter; body=${body}`)
    assert.ok(!body.includes('# bodyOf strips frontmatter'), `candidate body must not contain em-store H1; body=${body}`)
    assert.ok(!body.startsWith('---'), `candidate body must not start with frontmatter; body=${body}`)
  } finally { sandbox.cleanup() }
})

test('regression: confirmed fingerprint that disappears because source changed is stale with zero write', () => {
  const sandbox = makeSandbox('tt-preview-disappear')
  const globalDir = path.join(sandbox.home, '.episodic-memory')
  const savedHome = process.env.HOME
  try {
    writeFixtureStore(globalDir, 'global', [
      { id: 'g1', category: 'decision',
        summary: 'confirmed fingerprint that disappears because source changed',
        tags: ['disappear-track'], body: 'g-body' },
      { id: 'r1', category: 'decision',
        summary: 'confirmed fingerprint that disappears because source changed',
        tags: ['disappear-track'], body: 'r1-body' },
      { id: 'r2', category: 'decision',
        summary: 'confirmed fingerprint that disappears because source changed',
        tags: ['disappear-track'], body: 'r2-body' },
    ])
    const cfg = readCommittedConfig()
    const preview = scanTopicTracks({ globalDir, registeredStores: [], config: cfg })
    assert.strictEqual(preview.candidates.length, 1,
      `expected sole preview candidate; got ${JSON.stringify(preview.candidates.map(c => c.fingerprint))}`)
    const fp = preview.candidates[0].fingerprint

    // Mutate a source episode AFTER preview but BEFORE apply. The source bytes
    // change, so the confirmed fingerprint no longer exists under lock.
    fs.appendFileSync(path.join(globalDir, 'episodes', 'r1.md'), '\nmutation-after-preview\n')

    process.env.HOME = sandbox.home
    const out = applyTopicTracks({ globalDir, registeredStores: [], config: cfg, preview, confirmed: new Set([fp]) })

    assert.strictEqual(out.written.length, 0,
      `expected zero writes for disappeared fingerprint; got ${out.written.length}`)
    assert.ok(out.warnings.some(w => w.problem === 'stale-fingerprint'),
      `expected stale-fingerprint warning; got ${JSON.stringify(out.warnings)}`)
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'apply output must validate; errors=' + JSON.stringify(valid.errors))
    const gLock = storeWriteLockPath(globalDir)
    assert.strictEqual(fs.existsSync(gLock), false, `global lock must be released; ${gLock} exists`)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    sandbox.cleanup()
  }
})

test('regression: tags derived from freshCandidate.common_tags under lock after index-only tag drift', () => {
  const sandbox = makeSandbox('tt-tag-drift')
  const globalDir = path.join(sandbox.home, '.episodic-memory')
  const savedHome = process.env.HOME
  try {
    writeFixtureStore(globalDir, 'global', [
      { id: 't1', category: 'decision', date: '2024-01-01',
        summary: 'shared exact summary text token', tags: ['alpha-track'], body: 'b1' },
      { id: 't2', category: 'decision', date: '2024-01-02',
        summary: 'shared exact summary text token', tags: ['alpha-track'], body: 'b2' },
      { id: 't3', category: 'decision', date: '2024-01-03',
        summary: 'shared exact summary text token', tags: ['alpha-track'], body: 'b3' },
    ])
    const cfg = readCommittedConfig()
    const preview = scanTopicTracks({ globalDir, registeredStores: [], config: cfg })
    assert.strictEqual(preview.candidates.length, 1,
      `expected sole preview candidate; got ${JSON.stringify(preview.candidates.map(c => c.fingerprint))}`)
    assert.deepStrictEqual(preview.candidates[0].common_tags, ['alpha-track'],
      `preview common_tags must be alpha-track; got ${JSON.stringify(preview.candidates[0].common_tags)}`)
    const fp = preview.candidates[0].fingerprint

    const origBytes = new Map([
      ['t1', fs.readFileSync(path.join(globalDir, 'episodes', 't1.md'))],
      ['t2', fs.readFileSync(path.join(globalDir, 'episodes', 't2.md'))],
      ['t3', fs.readFileSync(path.join(globalDir, 'episodes', 't3.md'))],
    ])

    // Change ONLY index-row tags after preview; episode bytes stay identical.
    const rows = ['t1', 't2', 't3'].map(id => JSON.stringify({
      id, project: 'global', category: 'decision',
      summary: 'shared exact summary text token',
      tags: ['beta-track'], status: 'active', date: `2024-01-0${id === 't1' ? '1' : id === 't2' ? '2' : '3'}`,
    }))
    fs.writeFileSync(path.join(globalDir, 'index.jsonl'), rows.join('\n') + '\n')

    process.env.HOME = sandbox.home
    const out = applyTopicTracks({
      globalDir, registeredStores: [], config: cfg,
      preview, confirmed: new Set([fp]),
    })
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'apply output must validate; errors=' + JSON.stringify(valid.errors))
    assert.strictEqual(out.written.length, 1,
      `expected one write after index-only tag drift; got ${JSON.stringify(out.written)}`)
    assert.strictEqual(out.written[0].fingerprint, fp,
      `written fingerprint must equal confirmed preview fingerprint; got ${out.written[0].fingerprint}`)

    const indexText = fs.readFileSync(path.join(globalDir, 'index.jsonl'), 'utf8')
    let lessonRow = null
    for (const line of indexText.split('\n')) {
      if (!line.trim()) continue
      const r = JSON.parse(line)
      if (r.id === out.written[0].episode_id) { lessonRow = r; break }
    }
    assert.ok(lessonRow, `written episode ${out.written[0].episode_id} must appear in index`)
    assert.ok(Array.isArray(lessonRow.tags) && lessonRow.tags.includes('topic-track'),
      `lesson tags must include topic-track; got ${JSON.stringify(lessonRow.tags)}`)
    assert.ok(lessonRow.tags.includes('beta-track'),
      `lesson tags must include fresh majority beta-track; got ${JSON.stringify(lessonRow.tags)}`)
    assert.ok(!lessonRow.tags.includes('alpha-track'),
      `lesson tags must NOT include stale preview alpha-track; got ${JSON.stringify(lessonRow.tags)}`)

    for (const [id, before] of origBytes) {
      const after = fs.readFileSync(path.join(globalDir, 'episodes', `${id}.md`))
      assert.strictEqual(Buffer.compare(before, after), 0,
        `source episode ${id} bytes must remain unchanged`)
    }
    const lockPath = storeWriteLockPath(globalDir)
    assert.strictEqual(fs.existsSync(lockPath), false,
      `global lock must be released after tag-drift apply; ${lockPath} exists`)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    sandbox.cleanup()
  }
})

test('regression: apply crosses max-episodes cap after preview, throws topic-tracks-max-episodes, zero write, releases locks', () => {
  const sandbox = makeSandbox('tt-apply-cap')
  const globalDir = path.join(sandbox.home, '.episodic-memory')
  const savedHome = process.env.HOME
  try {
    const cfg = { ...readCommittedConfig(), max_episodes: 3 }
    writeFixtureStore(globalDir, 'global', [
      { id: 'c1', category: 'decision', date: '2024-01-01',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b1' },
      { id: 'c2', category: 'decision', date: '2024-01-02',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b2' },
      { id: 'c3', category: 'decision', date: '2024-01-03',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b3' },
    ])
    const preview = scanTopicTracks({ globalDir, registeredStores: [], config: cfg })
    assert.strictEqual(preview.candidates.length, 1,
      `expected sole preview candidate; got ${JSON.stringify(preview.candidates.map(c => c.fingerprint))}`)
    const fp = preview.candidates[0].fingerprint

    // Add two more members after preview so under-lock rebuild exceeds cap.
    writeFixtureStore(globalDir, 'global', [
      { id: 'c1', category: 'decision', date: '2024-01-01',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b1' },
      { id: 'c2', category: 'decision', date: '2024-01-02',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b2' },
      { id: 'c3', category: 'decision', date: '2024-01-03',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b3' },
      { id: 'c4', category: 'decision', date: '2024-01-04',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b4' },
      { id: 'c5', category: 'decision', date: '2024-01-05',
        summary: 'cap crossing shared summary token', tags: ['cap-track'], body: 'b5' },
    ])

    process.env.HOME = sandbox.home
    let caught = null
    try {
      applyTopicTracks({ globalDir, registeredStores: [], config: cfg, preview, confirmed: new Set([fp]) })
    } catch (err) {
      caught = err
    }
    assert.ok(caught && caught.code === 'topic-tracks-max-episodes',
      `expected topic-tracks-max-episodes throw; got ${caught && caught.code}`)

    // Zero writes: no active topic-track lesson row exists.
    const indexText = fs.existsSync(path.join(globalDir, 'index.jsonl'))
      ? fs.readFileSync(path.join(globalDir, 'index.jsonl'), 'utf8')
      : ''
    let activeLessons = 0
    for (const line of indexText.split('\n')) {
      if (!line.trim()) continue
      const r = JSON.parse(line)
      if (r.status === 'active' && r.category === 'lesson' &&
          Array.isArray(r.tags) && r.tags.includes('topic-track')) activeLessons++
    }
    assert.strictEqual(activeLessons, 0, `expected zero topic-track lesson writes; got ${activeLessons}`)

    const lockPath = storeWriteLockPath(globalDir)
    assert.strictEqual(fs.existsSync(lockPath), false,
      `global lock must be released after cap throw; ${lockPath} exists`)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    sandbox.cleanup()
  }
})

testAsync('regression: fourth matching member added after preview makes confirmed fingerprint stale; zero write, locks released, source bytes untouched', async () => {
  const sandbox = makeSandbox('tt-fourth-member')
  const globalDir = path.join(sandbox.home, '.episodic-memory')
  const regDir = path.join(sandbox.root, 'project', '.episodic-memory')
  const savedHome = process.env.HOME
  try {
    writeFixtureStore(globalDir, 'global', [
      { id: 'g1', category: 'decision',
        summary: 'fourth matching member added after preview',
        tags: ['fourth-track'], body: 'g-body' },
    ])
    writeFixtureStore(regDir, 'projA', [
      { id: 'r1', category: 'decision',
        summary: 'fourth matching member added after preview',
        tags: ['fourth-track'], body: 'r1-body' },
      { id: 'r2', category: 'decision',
        summary: 'fourth matching member added after preview',
        tags: ['fourth-track'], body: 'r2-body' },
    ])
    const cfg = readCommittedConfig()
    const registeredStores = [{
      store_id: 'aaaaaaaaaaaaaaaa',
      label: 'projA',
      data_dir: regDir,
      project_path: path.join(sandbox.root, 'project'),
    }]
    const preview = scanTopicTracks({ globalDir, registeredStores, config: cfg })
    assert.strictEqual(preview.candidates.length, 1,
      `expected sole preview candidate; got ${JSON.stringify(preview.candidates.map(c => c.fingerprint))}`)
    const fp = preview.candidates[0].fingerprint

    const origBytes = new Map([
      ['g1', fs.readFileSync(path.join(globalDir, 'episodes', 'g1.md'))],
      ['r1', fs.readFileSync(path.join(regDir, 'episodes', 'r1.md'))],
      ['r2', fs.readFileSync(path.join(regDir, 'episodes', 'r2.md'))],
    ])

    // Exactly one fourth matching member added after preview: r3 joins g1+r1+r2.
    writeFixtureStore(regDir, 'projA', [
      { id: 'r1', category: 'decision',
        summary: 'fourth matching member added after preview',
        tags: ['fourth-track'], body: 'r1-body' },
      { id: 'r2', category: 'decision',
        summary: 'fourth matching member added after preview',
        tags: ['fourth-track'], body: 'r2-body' },
      { id: 'r3', category: 'decision',
        summary: 'fourth matching member added after preview',
        tags: ['fourth-track'], body: 'r3-body' },
    ])

    process.env.HOME = sandbox.home
    const gLock = storeWriteLockPath(globalDir)
    const rLock = storeWriteLockPath(regDir)
    const out = applyTopicTracks({ globalDir, registeredStores, config: cfg, preview, confirmed: new Set([fp]) })
    const valid = validateInstance(out, IO_SCHEMA)
    assert.strictEqual(valid.valid, true,
      'apply output must validate; errors=' + JSON.stringify(valid.errors))
    assert.strictEqual(out.written.length, 0,
      `expected zero writes when fourth member changes fingerprint; got ${out.written.length}`)
    assert.ok(out.warnings.some(w => w.problem === 'stale-fingerprint'),
      `expected stale-fingerprint warning; got ${JSON.stringify(out.warnings)}`)
    assert.strictEqual(fs.existsSync(gLock), false, `global lock must be released; ${gLock} exists`)
    assert.strictEqual(fs.existsSync(rLock), false, `registered lock must be released; ${rLock} exists`)
    for (const [id, before] of origBytes) {
      const dir = id === 'g1' ? globalDir : regDir
      const after = fs.readFileSync(path.join(dir, 'episodes', `${id}.md`))
      assert.strictEqual(Buffer.compare(before, after), 0,
        `source episode ${id} bytes must remain unchanged`)
    }
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    sandbox.cleanup()
  }
})

test('contract: learning/em-topic-tracks.json validates against plugins/learning-descriptor.schema.json', () => {
  if (!fs.existsSync(TOPIC_TRACKS_DESCRIPTOR_PATH)) {
    throw new Error(missingFileError('em-topic-tracks descriptor', TOPIC_TRACKS_DESCRIPTOR_PATH))
  }
  if (!fs.existsSync(LEARNING_DESCRIPTOR_SCHEMA_PATH)) {
    throw new Error(missingFileError('learning-descriptor schema', LEARNING_DESCRIPTOR_SCHEMA_PATH))
  }
  const descriptor = readJsonFile(TOPIC_TRACKS_DESCRIPTOR_PATH)
  const schema = readJsonFile(LEARNING_DESCRIPTOR_SCHEMA_PATH)
  const result = validateInstance(descriptor, schema)
  assert.strictEqual(result.valid, true,
    'learning/em-topic-tracks.json must validate against plugins/learning-descriptor.schema.json; errors=' +
    JSON.stringify(result.errors) + '; descriptor=' + JSON.stringify(descriptor))
})

test('contract: learning-descriptor schema rejects io_schema escaping the project tree', () => {
  if (!fs.existsSync(TOPIC_TRACKS_DESCRIPTOR_PATH)) {
    throw new Error(missingFileError('em-topic-tracks descriptor', TOPIC_TRACKS_DESCRIPTOR_PATH))
  }
  if (!fs.existsSync(LEARNING_DESCRIPTOR_SCHEMA_PATH)) {
    throw new Error(missingFileError('learning-descriptor schema', LEARNING_DESCRIPTOR_SCHEMA_PATH))
  }
  const descriptor = readJsonFile(TOPIC_TRACKS_DESCRIPTOR_PATH)
  const schema = readJsonFile(LEARNING_DESCRIPTOR_SCHEMA_PATH)
  const escaped = { ...descriptor, io_schema: '../schemas/runtime/topic-tracks-io.schema.json' }
  const result = validateInstance(escaped, schema)
  assert.strictEqual(result.valid, false,
    'descriptor with io_schema "../schemas/runtime/topic-tracks-io.schema.json" must be rejected by the learning-descriptor schema; got valid=true; descriptor=' + JSON.stringify(escaped))
})

test('contract: plugins/_index.json has exactly one active learning entry id em-topic-tracks with module and descriptor', () => {
  if (!fs.existsSync(PLUGINS_INDEX_PATH)) {
    throw new Error(missingFileError('plugins/_index.json', PLUGINS_INDEX_PATH))
  }
  const index = readJsonFile(PLUGINS_INDEX_PATH)
  const learningPlugins = (index.plugins || []).filter(p => p && p.type === 'learning')
  const matches = learningPlugins.filter(p => p.id === 'em-topic-tracks')
  const activeMatches = matches.filter(p => p.status === 'active')
  assert.strictEqual(activeMatches.length, 1,
    `plugins/_index.json must have exactly one active learning entry id "em-topic-tracks"; found ${activeMatches.length} active (${matches.length} total); entries=${JSON.stringify(learningPlugins.map(p => ({ id: p.id, status: p.status })))}`)
  const entry = activeMatches[0]
  assert.strictEqual(entry.module, 'scripts/em-topic-tracks.mjs',
    `plugins/_index.json learning/em-topic-tracks entry must have module "scripts/em-topic-tracks.mjs"; got ${JSON.stringify(entry.module)}`)
  assert.strictEqual(entry.descriptor, 'learning/em-topic-tracks.json',
    `plugins/_index.json learning/em-topic-tracks entry must have descriptor "learning/em-topic-tracks.json"; got ${JSON.stringify(entry.descriptor)}`)
})

test('contract: learning/em-promote.json has confirm_gated=true and does not claim pending typed provenance in summary', () => {
  if (!fs.existsSync(PROMOTE_DESCRIPTOR_PATH)) {
    throw new Error(missingFileError('em-promote descriptor', PROMOTE_DESCRIPTOR_PATH))
  }
  const descriptor = readJsonFile(PROMOTE_DESCRIPTOR_PATH)
  assert.strictEqual(descriptor.side_effects && descriptor.side_effects.confirm_gated, true,
    `learning/em-promote.json side_effects.confirm_gated must be true; got ${JSON.stringify(descriptor.side_effects && descriptor.side_effects.confirm_gated)}`)
  const summary = typeof descriptor.summary === 'string' ? descriptor.summary : ''
  assert.ok(
    !/provenance carried in-body pending/i.test(summary),
    `learning/em-promote.json summary must NOT claim "provenance carried in-body pending"; got summary=${JSON.stringify(summary)}`)
  assert.ok(
    !/typed provenance pending/i.test(summary),
    `learning/em-promote.json summary must NOT claim "typed provenance pending"; got summary=${JSON.stringify(summary)}`)
})

test('contract: CAPABILITIES.md registers em-topic-tracks (WEAK / on-demand / global lesson / confirm) and clears em-promote stale phrase', () => {
  if (!fs.existsSync(CAPABILITIES_DOC_PATH)) {
    throw new Error(missingFileError('CAPABILITIES.md', CAPABILITIES_DOC_PATH))
  }
  const text = readTextFile(CAPABILITIES_DOC_PATH)
  const required = [
    'em-topic-tracks',
    'WEAK',
    'on-demand',
    'global lesson',
    'confirm',
  ]
  for (const phrase of required) {
    assert.ok(text.includes(phrase),
      `CAPABILITIES.md is missing required phrase "${phrase}"; file=${CAPABILITIES_DOC_PATH}`)
  }
  assert.ok(
    !/provenance carried in-body pending/i.test(text),
    `CAPABILITIES.md must NOT retain the stale em-promote phrase "provenance carried in-body pending"; file=${CAPABILITIES_DOC_PATH}`)
})

test('contract: RFC-001 contains 2026-07-23 topic-track implementation-resolution block referencing em-topic-tracks / promotion_sources / --auto / global lesson / sources untouched; source_episodes and rebuild checkboxes remain literally unchecked', () => {
  if (!fs.existsSync(RFC001_PATH)) {
    throw new Error(missingFileError('RFC-001', RFC001_PATH))
  }
  const text = readTextFile(RFC001_PATH)
  const required = [
    '2026-07-23',
    'em-topic-tracks',
    'promotion_sources',
    '--auto',
    'global lesson',
    'sources untouched',
  ]
  for (const phrase of required) {
    assert.ok(text.includes(phrase),
      `RFC-001 is missing required phrase "${phrase}"; file=${RFC001_PATH}`)
  }
  // Historical checkboxes must remain literally unchecked.
  assert.ok(/^- \[ \] lesson files include `source_episodes`/m.test(text),
    `RFC-001 historical checkbox "lesson files include \`source_episodes\`" must remain literally unchecked [ ]; file=${RFC001_PATH}`)
  assert.ok(/^- \[ \] rebuild preserves `source_episodes`/m.test(text),
    `RFC-001 historical checkbox "rebuild preserves \`source_episodes\`" must remain literally unchecked [ ]; file=${RFC001_PATH}`)
})

function docPhraseContract(name, docPath, requiredPhrases) {
  test(`contract: ${name} covers ${requiredPhrases.join(', ')}`, () => {
    if (!fs.existsSync(docPath)) {
      throw new Error(missingFileError(name, docPath))
    }
    const text = readTextFile(docPath)
    for (const phrase of requiredPhrases) {
      assert.ok(text.includes(phrase),
        `${name} (${docPath}) is missing required phrase "${phrase}"`)
    }
  })
}

docPhraseContract(
  'docs/EM_SCRIPTS_GUIDE.md',
  EM_SCRIPTS_GUIDE_PATH,
  ['em-topic-tracks', 'dry-run', '--confirm', 'global lesson', 'source', 'ordinary search'],
)
docPhraseContract(
  'docs/USER_MANUAL.md',
  USER_MANUAL_PATH,
  ['em-topic-tracks', 'dry-run', '--confirm', 'global lesson', 'source', 'ordinary search'],
)

test('contract: docs/EM_SCRIPTS_GUIDE.md mentions source immutability and explicitly notes ordinary search has no new ranking', () => {
  if (!fs.existsSync(EM_SCRIPTS_GUIDE_PATH)) {
    throw new Error(missingFileError('docs/EM_SCRIPTS_GUIDE.md', EM_SCRIPTS_GUIDE_PATH))
  }
  const text = readTextFile(EM_SCRIPTS_GUIDE_PATH)
  assert.ok(/immutab/i.test(text),
    `docs/EM_SCRIPTS_GUIDE.md must mention source immutability ("immutab…"); file=${EM_SCRIPTS_GUIDE_PATH}`)
  assert.ok(/no new ranking/i.test(text),
    `docs/EM_SCRIPTS_GUIDE.md must state ordinary search has no new ranking ("no new ranking"); file=${EM_SCRIPTS_GUIDE_PATH}`)
})

test('contract: docs/USER_MANUAL.md mentions source immutability and explicitly notes ordinary search has no new ranking', () => {
  if (!fs.existsSync(USER_MANUAL_PATH)) {
    throw new Error(missingFileError('docs/USER_MANUAL.md', USER_MANUAL_PATH))
  }
  const text = readTextFile(USER_MANUAL_PATH)
  assert.ok(/immutab/i.test(text),
    `docs/USER_MANUAL.md must mention source immutability ("immutab…"); file=${USER_MANUAL_PATH}`)
  assert.ok(/no new ranking/i.test(text),
    `docs/USER_MANUAL.md must state ordinary search has no new ranking ("no new ranking"); file=${USER_MANUAL_PATH}`)
})

for (const [label, filePath] of INSTRUCTION_FILES) {
  test(`contract: instructions/${label} exists, covers em-topic-tracks / on-demand / global / confirm, keeps transcript route unshipped, and does not claim topic tracks unimplemented/unshipped`, () => {
    if (!fs.existsSync(filePath)) {
      throw new Error(missingFileError(`instructions/${label}`, filePath))
    }
    const text = readTextFile(filePath)
    for (const phrase of ['em-topic-tracks', 'on-demand', 'global', 'confirm']) {
      assert.ok(text.includes(phrase),
        `instructions/${label} (${filePath}) is missing required phrase "${phrase}"`)
    }
    // Transcript route must remain marked unshipped.
    assert.ok(/transcript[^.\n]*\bunshipped\b/i.test(text) ||
              /transcript[^.\n]*\bnot shipped\b/i.test(text),
      `instructions/${label} (${filePath}) must mark transcript route as unshipped (e.g. "transcript-level ... unshipped" or "transcript-level ... not shipped")`)
    // The file must NOT claim topic tracks are unimplemented or unshipped.
    assert.ok(
      !/topic tracks are not implemented/i.test(text) &&
      !/topic tracks are unshipped/i.test(text) &&
      !/topic tracks[^.\n]*\bunshipped\b/i.test(text) &&
      !/topic tracks[^.\n]*\bnot shipped\b/i.test(text) &&
      !/topic-track routes are not shipped/i.test(text) &&
      !/topic-track routes are unshipped/i.test(text),
      `instructions/${label} (${filePath}) must NOT claim topic tracks are unimplemented/unshipped`)
  })
}

await Promise.all(asyncTests)

console.log('')
console.log(`passed=${passed} failed=${failed}`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
