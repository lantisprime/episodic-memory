#!/usr/bin/env node
// test-registered-stores.mjs — APC-S1 (plan §14 Group 1). Exercises the REAL
// lib against an isolated fixture registry: dedupe by realpath, global-store
// exclusion, malformed-registry degrade, vanished-path drop, and the planner-B1
// store-identity class (git-nested + linked-worktree entries resolve to the
// git root's store and are flagged store_matches_project:false).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { resolveRegisteredStores, STORE_DIR_BASENAME } from '../scripts/lib/registered-stores.mjs'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'em-regstores-'))
const GLOBAL_DIR = path.join(ROOT, 'home', STORE_DIR_BASENAME)

function writeRegistry(entries) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.writeFileSync(path.join(GLOBAL_DIR, 'installs.json'),
    JSON.stringify({ schema_version: 1, entries }, null, 2))
}
function entry(project_path) {
  return { project_path, tool: 'claude-code', version: 'v1', enforcement_installed: false, last_install_ts: '2026-07-08T00:00:00Z' }
}
function mkProject(name, { git = false, store = true } = {}) {
  const p = path.join(ROOT, name)
  fs.mkdirSync(p, { recursive: true })
  if (git) spawnSync('git', ['init', '-q'], { cwd: p })
  if (store) fs.mkdirSync(path.join(p, STORE_DIR_BASENAME), { recursive: true })
  return p
}

const tests = []
const t = (name, fn) => tests.push([name, fn])
function assert(cond, msg) { if (!cond) throw new Error(msg) }

t('testResolveRegisteredStoresBasic', () => {
  const a = mkProject('basicA')
  const b = mkProject('basicB', { git: true })
  writeRegistry([entry(a), entry(b)])
  const stores = resolveRegisteredStores({ globalDir: GLOBAL_DIR })
  assert(stores.length === 2, `want 2 stores, got ${stores.length}: ${JSON.stringify(stores)}`)
  const byBase = Object.fromEntries(stores.map(s => [path.basename(s.project_path), s]))
  assert(byBase.basicA.data_dir === fs.realpathSync(path.join(a, STORE_DIR_BASENAME)), `basicA data_dir: ${byBase.basicA.data_dir}`)
  assert(byBase.basicA.label === 'project:basicA', `label: ${byBase.basicA.label}`)
  assert(byBase.basicA.store_matches_project === true, 'plain dir must match')
  assert(byBase.basicB.store_matches_project === true, 'git root must match')
})

t('testResolveDedupesByRealpath', () => {
  const real = mkProject('dedupeReal')
  const alias = path.join(ROOT, 'dedupeAlias')
  fs.symlinkSync(real, alias)
  writeRegistry([entry(real), entry(alias)])
  const stores = resolveRegisteredStores({ globalDir: GLOBAL_DIR })
  assert(stores.length === 1, `symlink alias must dedupe to 1, got ${stores.length}: ${JSON.stringify(stores.map(s => s.data_dir))}`)
})

t('testResolveExcludesGlobalStore', () => {
  // A registry entry whose resolved store IS the global store must be dropped.
  const home = path.dirname(GLOBAL_DIR)
  writeRegistry([entry(home)])
  const stores = resolveRegisteredStores({ globalDir: GLOBAL_DIR })
  assert(stores.length === 0, `entry at $HOME must be dropped, got ${JSON.stringify(stores)}`)
})

t('testResolveMalformedRegistryEmpty', () => {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.writeFileSync(path.join(GLOBAL_DIR, 'installs.json'), 'not json {{{')
  assert(resolveRegisteredStores({ globalDir: GLOBAL_DIR }).length === 0, 'malformed registry must yield []')
  fs.rmSync(path.join(GLOBAL_DIR, 'installs.json'))
  assert(resolveRegisteredStores({ globalDir: GLOBAL_DIR }).length === 0, 'absent registry must yield []')
})

t('testResolveVanishedPathDropped', () => {
  const live = mkProject('vanishLive')
  writeRegistry([entry(live), entry(path.join(ROOT, 'no-such-dir'))])
  const stores = resolveRegisteredStores({ globalDir: GLOBAL_DIR })
  assert(stores.length === 1 && stores[0].project_path === fs.realpathSync(live),
    `vanished path must drop: ${JSON.stringify(stores)}`)
})

t('testResolveNonRootStoreFlagged', () => {
  // planner B1: git-nested and linked-worktree project paths resolve to the
  // git ROOT's store (what spawned em-* scripts actually operate on) and are
  // write-ineligible.
  const gitRoot = mkProject('b1root', { git: true })
  const nested = path.join(gitRoot, 'nested')
  fs.mkdirSync(nested, { recursive: true })
  spawnSync('git', ['-C', gitRoot, 'commit', '--allow-empty', '-q', '-m', 'init'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'fx', GIT_AUTHOR_EMAIL: 'fx@fx', GIT_COMMITTER_NAME: 'fx', GIT_COMMITTER_EMAIL: 'fx@fx' },
  })
  const worktree = path.join(ROOT, 'b1worktree')
  spawnSync('git', ['-C', gitRoot, 'worktree', 'add', '-q', worktree], { encoding: 'utf8' })
  writeRegistry([entry(nested), entry(worktree)])
  const stores = resolveRegisteredStores({ globalDir: GLOBAL_DIR })
  const rootStore = fs.realpathSync(path.join(gitRoot, STORE_DIR_BASENAME))
  // Both entries resolve to the SAME git-root store → dedupe to one, flagged false.
  assert(stores.length === 1, `nested+worktree must dedupe onto the root store, got ${stores.length}: ${JSON.stringify(stores.map(s => s.data_dir))}`)
  assert(stores[0].data_dir === rootStore, `resolved data_dir ${stores[0].data_dir}, want ${rootStore}`)
  assert(stores[0].store_matches_project === false, 'nested/worktree entry must be store_matches_project:false')
})

t('testResolveSymlinkAliasDedupe', () => {
  // /tmp vs /private/tmp class: two spellings realpathing to one store → one
  // entry. On non-macOS the symlink fixture below provides the same class.
  const real = mkProject('aliasReal')
  const link = path.join(ROOT, 'aliasLink')
  fs.symlinkSync(real, link)
  const spelledViaLink = path.join(link) // registry carries the alias spelling
  writeRegistry([entry(spelledViaLink), entry(real)])
  const stores = resolveRegisteredStores({ globalDir: GLOBAL_DIR })
  assert(stores.length === 1, `alias spellings must resolve to 1 store, got ${stores.length}`)
  // The store dir itself symlinked OUTSIDE the project → flagged unwritable.
  const victim = path.join(ROOT, 'victim-store')
  fs.mkdirSync(victim, { recursive: true })
  const evil = mkProject('evilProj', { store: false })
  fs.symlinkSync(victim, path.join(evil, STORE_DIR_BASENAME))
  writeRegistry([entry(evil)])
  const evilStores = resolveRegisteredStores({ globalDir: GLOBAL_DIR })
  assert(evilStores.length === 1, 'symlinked store still listed for reads')
  assert(evilStores[0].store_matches_project === false, 'store symlinked outside the project must be write-ineligible')
})

let pass = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok ${name}`); pass++ } catch (e) { console.log(`FAIL ${name}: ${e.message}`) }
}
fs.rmSync(ROOT, { recursive: true, force: true })
console.log(`${pass}/${tests.length} pass`)
process.exit(pass === tests.length ? 0 : 1)
