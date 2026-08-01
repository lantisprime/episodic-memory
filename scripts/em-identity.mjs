#!/usr/bin/env node
/**
 * em-identity.mjs — store-identity diagnosis + sanctioned duplicate-root repair
 * (issue #635). Zero deps; JSON to stdout.
 *
 *   node em-identity.mjs [--project <path>|--store <dir>] [--status]
 *   node em-identity.mjs --detach-root <episode-id> [--confirm]
 *
 * Without --confirm, --detach-root prints the planned write and touches nothing
 * (#623 blast-radius discipline). The repair itself is detachStoreIdentity's
 * named-root collapse: one successor episode carrying supersedes + 
 * detaches_identity_root (P7: revision, never an edit).
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { storeIdentityStatus, detachStoreIdentity } from './lib/store-identity.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

if (flag('--help')) {
  console.log(JSON.stringify({
    status: 'help',
    script: 'em-identity.mjs',
    usage: 'node em-identity.mjs [--project <path>|--store <dir>] [--status] | --detach-root <episode-id> [--confirm]',
  }))
  process.exit(0)
}

let storeDir = opt('--store')
if (!storeDir) {
  const project = opt('--project') || process.cwd()
  try { storeDir = resolveLocalDir(fs.realpathSync(project)) } catch { storeDir = path.join(project, '.episodic-memory') }
}
if (!fs.existsSync(path.join(storeDir, 'episodes'))) {
  console.log(JSON.stringify({ status: 'error', error: 'store-not-found', store: storeDir }))
  process.exit(1)
}

const detachRootId = opt('--detach-root')
if (!detachRootId) {
  console.log(JSON.stringify({ status: 'ok', store: storeDir, ...storeIdentityStatus(storeDir) }))
  process.exit(0)
}

const before = storeIdentityStatus(storeDir)
const target = before.active_roots.find((r) => r.episode_id === detachRootId)
const survivors = before.active_roots.filter((r) => r.episode_id !== detachRootId)
if (!flag('--confirm')) {
  console.log(JSON.stringify({
    status: 'plan',
    store: storeDir,
    would_detach: target || null,
    would_survive: survivors,
    note: target && survivors.length === 1
      ? 'one successor episode will supersede the survivor terminal and detach the named root; re-run with --confirm to write'
      : 'refused: --detach-root must name one of exactly two active roots',
  }))
  process.exit(target && survivors.length === 1 ? 0 : 1)
}
const result = detachStoreIdentity(storeDir, { detachRootId })
const ok = !result.error
console.log(JSON.stringify({ status: ok ? 'ok' : 'error', store: storeDir, ...result, after: ok ? storeIdentityStatus(storeDir) : undefined }))
process.exit(ok ? 0 : 1)
