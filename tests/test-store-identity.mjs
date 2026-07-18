#!/usr/bin/env node
/**
 * test-store-identity.mjs — RFC-012 P2 S1 store-identity chain + registry mirror.
 *
 * 22 tests across 2 groups:
 *   Group 1 (16): in-process lib + spawned rebuild/protection — identity chain
 *     mint/rebind/detach/alias/crash/duplicate/cycle/concurrent + protection arm.
 *   Group 2 (6): real install.mjs E2E with isolated HOME — registry mirror,
 *     mint-on-next-registration, ambiguous alias, copied store, duplicate chain,
 *     relocation id-stable.
 *
 * Spawned children honor the --break-identity-write argv flag to exercise the
 * negative-control crash-injection fixture (REQ-2) and duplicate-chain failure
 * (REQ-4) without touching the lib's source.
 *
 * Born partially RED (§A.9): the 3 lib-side + 6 registry-side tests fail until
 * steps 1.3-1.12 land; every other name green from the moment this file exists.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { mintStoreIdentity, resolveStoreIdentity, rebindStoreIdentity, detachStoreIdentity, GLOBAL_STORE_ID } from '../scripts/lib/store-identity.mjs'
import { computeProtectedIds } from '../scripts/lib/protection.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REBUILD = path.join(REPO, 'scripts', 'em-rebuild-index.mjs')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const INSTALL = path.join(REPO, 'install.mjs')
const LIB_URL = pathToFileURL(path.join(REPO, 'scripts', 'lib', 'store-identity.mjs')).href

// --only fixture-style filter (mirrors tests/test-rfc-009-p4-apply.mjs:53-58).
const ONLY_FLAG = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null })()

let pass = 0, fail = 0
const failures = []
function t(name, fn) {
  if (ONLY_FLAG && !name.includes(ONLY_FLAG)) return
  try { fn(); console.log(`ok ${name}`); pass++ }
  catch (e) { fail++; failures.push(`${name} - ${e && e.message}`); console.log(`FAIL ${name}: ${e && e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function eq(actual, expected, label) { if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`) }

// --- fixtures ---

function mkStore(label = 'store') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `store-identity-${label}-`)))
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true })
  const projectDir = path.join(root, label)
  fs.mkdirSync(projectDir, { recursive: true })
  const dataDir = path.join(projectDir, '.episodic-memory')
  fs.mkdirSync(path.join(dataDir, 'episodes'), { recursive: true })
  return { root, home, projectDir, dataDir }
}

function mkHome(label = 'home') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `store-identity-${label}-`)))
  const home = path.join(root, 'home')
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true })
  return { root, home }
}

function childMint(dir, extraArgs = []) {
  // Spawn a node child that imports the lib and calls mintStoreIdentity(dir).
  // argv[3+] = <dir> + extra args (--break-identity-write etc.) for the break-input
  // override (portable, §A.0).
  const code = `
    import { mintStoreIdentity } from ${JSON.stringify(LIB_URL)}
    const dir = process.argv[1]
    const result = mintStoreIdentity(dir)
    process.stdout.write(JSON.stringify(result))
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, dir, ...extraArgs],
    { encoding: 'utf8' })
}

function childRebind(dir) {
  const code = `
    import { rebindStoreIdentity } from ${JSON.stringify(LIB_URL)}
    const dir = process.argv[1]
    process.stdout.write(JSON.stringify(rebindStoreIdentity(dir)))
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, dir],
    { encoding: 'utf8' })
}

function childDetach(dir, extraArgs = []) {
  const code = `
    import { detachStoreIdentity } from ${JSON.stringify(LIB_URL)}
    const dir = process.argv[1]
    process.stdout.write(JSON.stringify(detachStoreIdentity(dir)))
  `
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, dir, ...extraArgs],
    { encoding: 'utf8' })
}

function handRoot(dir, storeId, extra = {}) {
  // Write a hand-crafted identity episode to forge duplicate/cycle/alias tests.
  const id = `19990101-000000-store-identity-${storeId.slice(0, 4)}`
  const lines = ['---', `id: ${id}`, `date: 1999-01-01`, `time: "00:00"`, `project: hand`, `category: context`, `status: active`, `tags: [store-identity]`, `summary: hand root ${storeId}`, `record_type: store-identity`, `store_id: ${storeId}`]
  if (extra.supersedes) lines.push(`supersedes: ${extra.supersedes}`)
  if (extra.detaches_identity_root) lines.push(`detaches_identity_root: ${extra.detaches_identity_root}`)
  lines.push('---', '', `# hand root ${storeId}`, '', 'hand-crafted for forged fixture.')
  fs.mkdirSync(path.join(dir, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'episodes', id + '.md'), lines.join('\n') + '\n')
}

function runInstall(projectDir, home) {
  return spawnSync(process.execPath, [INSTALL, '--tool', 'claude-code', '--project', projectDir],
    { cwd: projectDir, encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home } })
}

function readRegistry(home) {
  const p = path.join(home, '.episodic-memory', 'installs.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function episodesMd(dir) {
  try { return fs.readdirSync(path.join(dir, 'episodes')).filter((f) => f.endsWith('.md')) }
  catch { return [] }
}

// =====================
// Group 1 — lib + spawned rebuild/protection
// =====================

t('identity::testMintIdentity', () => {
  const s = mkStore('mint')
  const m = mintStoreIdentity(s.dataDir)
  assert(m.active_id, `mint failed: ${JSON.stringify(m)}`)
  assert(/^[0-9a-f]{16}$/.test(m.active_id), `active_id format: ${m.active_id}`)
  assert(/^\d{8}-\d{6}-store-identity-/.test(m.root_id), `root_id format: ${m.root_id}`)
  const r = resolveStoreIdentity(s.dataDir)
  eq(r.active_id, m.active_id, 'resolve after mint')
  const epFile = fs.readFileSync(path.join(s.dataDir, 'episodes', m.root_id + '.md'), 'utf8')
  assert(epFile.includes('record_type: store-identity'), 'episode file missing record_type')
  assert(epFile.includes(`store_id: ${m.active_id}`), 'episode file missing store_id line')
})

t('identity::testGlobalReservedId', () => {
  const s = mkStore('global')
  const m = mintStoreIdentity(s.dataDir, { reserved: GLOBAL_STORE_ID })
  eq(m.active_id, 'global', 'reserved global id')
  const epFile = fs.readFileSync(path.join(s.dataDir, 'episodes', m.root_id + '.md'), 'utf8')
  assert(epFile.includes('store_id: global'), 'episode file must carry store_id: global')
  assert(epFile.includes('project: global'), 'global reserved mint must use project: global')
})

t('identity::testIdNeverPath', () => {
  const a = mkStore('a')
  const b = mkStore('b')
  const ma = mintStoreIdentity(a.dataDir)
  const mb = mintStoreIdentity(b.dataDir)
  assert(ma.active_id !== mb.active_id, 'two stores must mint distinct ids')
  assert(/^[0-9a-f]{16}$/.test(ma.active_id), `id hex: ${ma.active_id}`)
  assert(/^[0-9a-f]{16}$/.test(mb.active_id), `id hex: ${mb.active_id}`)
  assert(!ma.active_id.includes(path.sep), 'id must not embed path separator')
  assert(!mb.active_id.includes(path.sep), 'id must not embed path separator')
})

t('identity::testIdentityWriterAtomic', () => {
  const s = mkStore('atomic')
  mintStoreIdentity(s.dataDir)
  const epsDir = path.join(s.dataDir, 'episodes')
  const tmp = fs.readdirSync(epsDir).filter((f) => f.includes('.tmp-identity'))
  eq(tmp.length, 0, 'no .tmp-identity stragglers after mint')
  const r = resolveStoreIdentity(s.dataDir)
  assert(!r.error, `resolve after mint: ${JSON.stringify(r)}`)
})

t('identity::testIdentityWriterCrashNegative', () => {
  const s = mkStore('crash')
  // Spawn a child WITH the break flag — write should stage a tmp and refuse to rename.
  const r = childMint(s.dataDir, ['--break-identity-write'])
  eq(r.status, 0, `break-flag child must exit 0 (returns error object): ${r.stderr}`)
  const out = JSON.parse(r.stdout)
  eq(out.error, 'break-identity-write', 'break-flag child error code')
  const epsDir = path.join(s.dataDir, 'episodes')
  const mdFiles = fs.readdirSync(epsDir).filter((f) => f.endsWith('.md'))
  eq(mdFiles.length, 0, 'no .md after break-flag mint')
  const tmpFiles = fs.readdirSync(epsDir).filter((f) => f.endsWith('.tmp-identity'))
  eq(tmpFiles.length, 1, 'exactly one staged .tmp-identity')
  // Resolve → no-identity (tmp is ignored).
  const r0 = resolveStoreIdentity(s.dataDir)
  eq(r0.error, 'no-identity', 'resolve after break-flag mint')
  // In-process mint (no flag) sweeps stale tmp + succeeds.
  const m = mintStoreIdentity(s.dataDir)
  assert(m.active_id, `in-process mint after break: ${JSON.stringify(m)}`)
  const tmpAfter = fs.readdirSync(epsDir).filter((f) => f.endsWith('.tmp-identity'))
  eq(tmpAfter.length, 0, 'no .tmp-identity after successful follow-up mint (stale sweep)')
})

t('identity::testActiveIsTerminal', () => {
  const s = mkStore('terminal')
  const m = mintStoreIdentity(s.dataDir)
  const rb = rebindStoreIdentity(s.dataDir)
  const r = resolveStoreIdentity(s.dataDir)
  eq(r.active_id, rb.active_id, 'active_id post-rebind = rebind result')
  assert(r.active_id !== m.active_id, 'post-rebind active_id differs from initial')
})

t('identity::testAliasResolution', () => {
  const s = mkStore('alias')
  const m = mintStoreIdentity(s.dataDir)
  const r1 = rebindStoreIdentity(s.dataDir)
  const r2 = rebindStoreIdentity(s.dataDir)
  const r = resolveStoreIdentity(s.dataDir)
  eq(r.active_id, r2.active_id, 'active_id = latest rebind')
  assert(JSON.stringify(r.aliases) === JSON.stringify([m.active_id, r1.active_id]),
    `aliases = [initial, intermediate] got ${JSON.stringify(r.aliases)}`)
})

t('identity::testPreRebindRefsResolve', () => {
  const s = mkStore('prerebind')
  const m = mintStoreIdentity(s.dataDir)
  rebindStoreIdentity(s.dataDir)
  const r = resolveStoreIdentity(s.dataDir)
  assert(r.aliases.includes(m.active_id), `pre-rebind active_id must appear in aliases: ${JSON.stringify(r.aliases)}`)
})

t('identity::testDuplicateChainFailsLoudBuild', () => {
  const s = mkStore('dupe')
  handRoot(s.dataDir, 'aaaa1111aaaa1111')
  handRoot(s.dataDir, 'bbbb2222bbbb2222')
  const r = spawnSync(process.execPath, [REBUILD, '--scope', 'local'],
    { cwd: s.projectDir, encoding: 'utf8',
      env: { ...process.env, HOME: s.home, USERPROFILE: s.home } })
  eq(r.status, 1, 'rebuild must exit 1 on duplicate chain')
  const out = JSON.parse(r.stdout)
  eq(out.status, 'error', 'status')
  eq(out.error, 'duplicate-identity-chain', 'error code')
  eq(out.scope, 'local', 'scope label')
  // EC6: no index file written.
  const idx = path.join(s.dataDir, 'index.jsonl')
  assert(!fs.existsSync(idx), 'index.jsonl must NOT be created on validate-then-write failure')
})

t('identity::testCloneDetachSingleWrite', () => {
  const a = mkStore('donor')
  mintStoreIdentity(a.dataDir)
  rebindStoreIdentity(a.dataDir) // 2 identity eps in donor
  const donorCountBefore = episodesMd(a.dataDir).length
  const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-identity-clone-'))
  const b = path.join(bRoot, 'b')
  fs.mkdirSync(b, { recursive: true })
  fs.cpSync(a.projectDir, b, { recursive: true })
  const bDataDir = path.join(b, '.episodic-memory')
  const donorRootId = resolveStoreIdentity(a.dataDir).root_id
  const det = detachStoreIdentity(bDataDir)
  eq(det.detached_root_id, donorRootId, 'detach records inherited root')
  const rb = resolveStoreIdentity(bDataDir)
  eq(rb.active_id, det.active_id, 'detach active_id')
  eq(rb.aliases.length, 0, 'detach aliases empty')
  const bCount = episodesMd(bDataDir).length
  eq(bCount, donorCountBefore + 1, 'clone + detach = donor count + 1')
})

t('identity::testCrashBeforeDetachInheritedIntact', () => {
  const a = mkStore('crashdetach-donor')
  mintStoreIdentity(a.dataDir)
  const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-identity-crashdetach-'))
  const b = path.join(bRoot, 'b')
  fs.mkdirSync(b, { recursive: true })
  fs.cpSync(a.projectDir, b, { recursive: true })
  const bDataDir = path.join(b, '.episodic-memory')
  const donorActiveBefore = resolveStoreIdentity(a.dataDir).active_id
  // Spawn a detach child WITH break flag — write must stage tmp + refuse rename.
  const r = childDetach(bDataDir, ['--break-identity-write'])
  eq(r.status, 0, 'break-flag detach child must exit 0')
  const out = JSON.parse(r.stdout)
  eq(out.error, 'break-identity-write', 'break-flag detach error')
  const md = episodesMd(bDataDir)
  eq(md.length, 1, 'no new .md after break-flag detach')
  const rb = resolveStoreIdentity(bDataDir)
  eq(rb.active_id, donorActiveBefore, 'copy still resolves to inherited chain active')
})

t('identity::testDetachedChainNoAliases', () => {
  const a = mkStore('detacha')
  mintStoreIdentity(a.dataDir)
  const r1 = rebindStoreIdentity(a.dataDir)
  const r2 = rebindStoreIdentity(a.dataDir)
  const donorActive = resolveStoreIdentity(a.dataDir).active_id
  const donorAliases = resolveStoreIdentity(a.dataDir).aliases
  const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-identity-detach-'))
  const b = path.join(bRoot, 'b')
  fs.mkdirSync(b, { recursive: true })
  fs.cpSync(a.projectDir, b, { recursive: true })
  const bDataDir = path.join(b, '.episodic-memory')
  detachStoreIdentity(bDataDir)
  const rb = resolveStoreIdentity(bDataDir)
  assert(!rb.aliases.includes(donorActive), 'donor active must NOT appear in copy aliases')
  for (const a_id of donorAliases) {
    assert(!rb.aliases.includes(a_id), `donor alias ${a_id} must NOT appear in copy aliases`)
  }
  assert(!rb.aliases.includes(r1.active_id), 'r1 active not in copy')
  assert(!rb.aliases.includes(r2.active_id), 'r2 active not in copy')
})

t('identity::testDetachCycleTerminates', () => {
  const s = mkStore('cycle')
  // Two hand roots, each detaching the OTHER's root id → cycle at resolve time.
  // Use distinct first-4-chars of storeId so each handRoot gets a distinct episode id.
  const rootAId = '19990101-000000-store-identity-aaaa'
  const rootBId = '19990101-000000-store-identity-bbbb'
  handRoot(s.dataDir, 'aaaa1111aaaa1111', { detaches_identity_root: rootBId })
  handRoot(s.dataDir, 'bbbb2222bbbb2222', { detaches_identity_root: rootAId })
  // Both roots are referenced by the other's detaches_identity_root → activeRoots=[].
  // The sync resolve returns identity-chain-cycle (termination is the absence of
  // infinite recursion — the function returns a plain object).
  const r = resolveStoreIdentity(s.dataDir)
  eq(r.error, 'identity-chain-cycle', 'mutual-detach cycle terminates as identity-chain-cycle')
})

t('identity::testConcurrentMintSingleChain', () => {
  const s = mkStore('concurrent')
  // Two simultaneous children racing on mint — the lock + identity-exists check
  // must let exactly one succeed and one fail with identity-exists.
  const a = childMint(s.dataDir)
  const b = childMint(s.dataDir)
  const aOut = JSON.parse(a.stdout)
  const bOut = JSON.parse(b.stdout)
  const successes = [aOut, bOut].filter((o) => o.active_id)
  const failures = [aOut, bOut].filter((o) => o.error === 'identity-exists')
  eq(successes.length, 1, 'exactly one successful mint')
  eq(failures.length, 1, 'exactly one identity-exists rejection')
  const r = resolveStoreIdentity(s.dataDir)
  assert(!r.error, `resolve after concurrent mint: ${JSON.stringify(r)}`)
})

t('identity::testIdentityProtectionArm', () => {
  const rows = [
    { id: 'idr1', category: 'context', status: 'active', record_type: 'store-identity' },
    { id: 'plain1', category: 'context', status: 'active' },
  ]
  const todayStr = new Date().toISOString().slice(0, 10)
  const m = computeProtectedIds(rows, todayStr)
  assert(m.has('idr1'), 'identity row must be protected')
  eq(m.get('idr1').reason, 'store-identity-chain', 'reason')
  assert(!m.has('plain1'), 'plain context row must NOT be protected by identity arm')
})

t('identity::testIndexCarriesIdentityFields', () => {
  const s = mkStore('index-fields')
  mintStoreIdentity(s.dataDir)
  rebindStoreIdentity(s.dataDir)
  const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-identity-indexfields-'))
  const b = path.join(bRoot, 'b')
  fs.mkdirSync(b, { recursive: true })
  fs.cpSync(s.projectDir, b, { recursive: true })
  const bDataDir = path.join(b, '.episodic-memory')
  detachStoreIdentity(bDataDir)
  // Rebuild on the COPY so it exercises the lockstep carry-on for the freshly-written
  // detach episode (which has detaches_identity_root).
  const r = spawnSync(process.execPath, [REBUILD, '--scope', 'local'],
    { cwd: b, encoding: 'utf8',
      env: { ...process.env, HOME: s.home, USERPROFILE: s.home } })
  eq(r.status, 0, `rebuild on copy must succeed: ${r.stderr}`)
  const idx = fs.readFileSync(path.join(bDataDir, 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  // Every identity row must carry store_id. The detach root carries detaches_identity_root.
  let detachRow = null
  for (const row of idx) {
    if (row.record_type !== 'store-identity') continue
    assert(typeof row.store_id === 'string', `identity row missing store_id: ${JSON.stringify(row)}`)
    // Read the source file's store_id and verify it matches the index row (lockstep).
    const src = fs.readFileSync(path.join(bDataDir, 'episodes', row.id + '.md'), 'utf8')
    const srcFm = src.match(/^---\n([\s\S]*?)\n---/)[1]
    const sidLine = srcFm.split('\n').find((l) => l.startsWith('store_id:'))
    const expected = sidLine.split(':')[1].trim()
    eq(row.store_id, expected, `index store_id matches file for ${row.id}`)
    if (srcFm.includes('detaches_identity_root:')) {
      detachRow = row
    }
  }
  assert(detachRow, 'detach row must be present in index')
  assert(typeof detachRow.detaches_identity_root === 'string', 'detach row must carry detaches_identity_root')
})

// =====================
// Group 2 — real install.mjs E2E
// =====================

t('registry::testRegistryMirror', () => {
  const s = mkHome('regmirror')
  // Create a project dir + git init (install requires git context).
  const project = path.join(s.root, 'p')
  fs.mkdirSync(project, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project })
  // Pre-seed identity before install runs.
  const dataDir = path.join(project, '.episodic-memory')
  fs.mkdirSync(path.join(dataDir, 'episodes'), { recursive: true })
  const minted = mintStoreIdentity(dataDir)
  assert(minted.active_id, `pre-seed mint: ${JSON.stringify(minted)}`)
  const r = runInstall(project, s.home)
  eq(r.status, 0, `install must succeed: ${r.stdout}\n${r.stderr}`)
  const reg = readRegistry(s.home)
  eq(reg.schema_version, 2, 'registry schema_version bumped to 2')
  const row = reg.entries.find((e) => e.project_path === project)
  assert(row, 'registry must contain row for project')
  assert(/^[0-9a-f]{16}$/.test(row.store_id), `row.store_id hex: ${row.store_id}`)
  eq(row.store_id, minted.active_id, 'row.store_id mirrors pre-seeded identity')
})

t('registry::testMintOnNextRegistration', () => {
  const s = mkHome('mintnext')
  const project = path.join(s.root, 'p')
  fs.mkdirSync(project, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: project })
  // Do NOT pre-seed identity. The .episodic-memory/episodes directory doesn't even
  // exist yet — install must create it AND mint on next registration.
  const r = runInstall(project, s.home)
  eq(r.status, 0, `install must succeed: ${r.stdout}\n${r.stderr}`)
  const dataDir = path.join(project, '.episodic-memory')
  const idn = resolveStoreIdentity(dataDir)
  assert(!idn.error, `identity now exists: ${JSON.stringify(idn)}`)
  const reg = readRegistry(s.home)
  const row = reg.entries.find((e) => e.project_path === project)
  assert(row, 'registry row exists')
  eq(row.store_id, idn.active_id, 'row mirrors newly minted identity')
})

t('registry::testAmbiguousAliasFailsLoud', () => {
  // Install A, rebind so A has an alias, then forge an identity in project C with
  // store_id = A's alias. Run install on C → registry write must fail loud.
  const s = mkHome('ambig')
  const aProj = path.join(s.root, 'A')
  const cProj = path.join(s.root, 'C')
  fs.mkdirSync(aProj, { recursive: true })
  fs.mkdirSync(cProj, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: aProj })
  execFileSync('git', ['init', '-q'], { cwd: cProj })
  // First install A: mints identity.
  const ra = runInstall(aProj, s.home)
  eq(ra.status, 0, `install A: ${ra.stdout}\n${ra.stderr}`)
  const aData = path.join(aProj, '.episodic-memory')
  // Rebind A so it has a retired alias.
  const rebind = rebindStoreIdentity(aData)
  const aIdn = resolveStoreIdentity(aData)
  // Forge C's identity with store_id = A's alias.
  const cData = path.join(cProj, '.episodic-memory')
  fs.mkdirSync(path.join(cData, 'episodes'), { recursive: true })
  handRoot(cData, aIdn.aliases[0])
  const rc = runInstall(cProj, s.home)
  // The install must have output ambiguous-alias-ownership AND not added C's row.
  const combined = (rc.stdout || '') + (rc.stderr || '')
  assert(combined.includes('ambiguous-alias-ownership'),
    `install output must include ambiguous-alias-ownership: ${combined.slice(0, 400)}`)
  const reg = readRegistry(s.home)
  const cRow = reg.entries.find((e) => e.project_path === cProj)
  assert(!cRow, 'C must NOT have a registry row when alias collides')
})

t('registry::testCopiedStoreRejected', () => {
  const s = mkHome('copystore')
  const aProj = path.join(s.root, 'A')
  const bProj = path.join(s.root, 'B')
  fs.mkdirSync(aProj, { recursive: true })
  fs.mkdirSync(bProj, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: aProj })
  // Install A.
  const ra = runInstall(aProj, s.home)
  eq(ra.status, 0, `install A: ${ra.stdout}\n${ra.stderr}`)
  // Copy A's store dir into B (same identity chain at a different project path).
  const aStore = path.join(aProj, '.episodic-memory')
  const bStore = path.join(bProj, '.episodic-memory')
  fs.mkdirSync(bStore, { recursive: true })
  fs.cpSync(aStore, bStore, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: bProj })
  const rb = runInstall(bProj, s.home)
  const combined = (rb.stdout || '') + (rb.stderr || '')
  assert(combined.includes('copied-store-rejected'),
    `install output must include copied-store-rejected: ${combined.slice(0, 400)}`)
  const reg = readRegistry(s.home)
  const bRow = reg.entries.find((e) => e.project_path === bProj)
  assert(!bRow, 'B must NOT have a registry row when its active id matches A')
})

t('registry::testDuplicateChainFailsLoudRegistration', () => {
  const s = mkHome('dupchain')
  const dProj = path.join(s.root, 'D')
  fs.mkdirSync(dProj, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dProj })
  // Forge two identity roots in D.
  const dStore = path.join(dProj, '.episodic-memory')
  fs.mkdirSync(path.join(dStore, 'episodes'), { recursive: true })
  handRoot(dStore, 'dddd1111dddd1111')
  handRoot(dStore, 'eeee2222eeee2222')
  const r = runInstall(dProj, s.home)
  const combined = (r.stdout || '') + (r.stderr || '')
  assert(combined.includes('duplicate-identity-chain'),
    `install output must include duplicate-identity-chain (last 600 chars): ${combined.slice(-600)}`)
  // The mirror throws on the first duplicate root it encounters — the registry write
  // is aborted. Either no registry exists OR a registry exists but has NO row for D.
  const regPath = path.join(s.home, '.episodic-memory', 'installs.json')
  let dRow = null
  if (fs.existsSync(regPath)) {
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
    dRow = (reg.entries || []).find((e) => e.project_path === dProj)
  }
  assert(!dRow, 'D must NOT have a registry row when its identity chain is duplicated')
})

t('registry::testRelocationIdStable', () => {
  const s = mkHome('reloc')
  const aProj = path.join(s.root, 'A')
  const a2Proj = path.join(s.root, 'A2')
  fs.mkdirSync(aProj, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: aProj })
  const r1 = runInstall(aProj, s.home)
  eq(r1.status, 0, `install A: ${r1.stdout}\n${r1.stderr}`)
  const reg1 = readRegistry(s.home)
  const aRow = reg1.entries.find((e) => e.project_path === aProj)
  assert(aRow, 'A row must exist after first install')
  const captured = aRow.store_id
  // §13 EC5: empty identity compares equal to itself and silently passes — require
  // a real 16-hex id so the relocation assertion actually exercises identity travel.
  assert(typeof captured === 'string' && /^[0-9a-f]{16}$/.test(captured),
    `captured store_id must be 16-hex after mirror: ${JSON.stringify(captured)}`)
  // Rename the project dir to A2 (relocation).
  fs.renameSync(aProj, a2Proj)
  const r2 = runInstall(a2Proj, s.home)
  eq(r2.status, 0, `install A2 (relocated): ${r2.stdout}\n${r2.stderr}`)
  const reg2 = readRegistry(s.home)
  const a2Row = reg2.entries.find((e) => e.project_path === a2Proj)
  assert(a2Row, 'A2 row must exist after relocation install')
  eq(a2Row.store_id, captured, 'store_id stable across relocation (identity is episode-carried)')
})

// --- main ---
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail > 0 ? 1 : 0)
