#!/usr/bin/env node
// #628: sibling scripts abort with typed envelopes (not raw stacks) on a
// directory-shaped index.jsonl. Companion to test-prune-protection.mjs legs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function t(name, fn) { try { fn(); pass++; console.log(`ok - ${name}`) } catch (e) { fail++; console.log(`not ok - ${name}: ${e.message}`) } }

function mkStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em628-'))
  const proj = path.join(root, 'proj'); fs.mkdirSync(proj)
  const seed = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'em-store.mjs'),
    '--project', 'test', '--category', 'decision', '--summary', 'seed', '--body', 'seed', '--scope', 'local'],
    { cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: root } })
  assert(seed.status === 0, `seed store failed: ${seed.stderr}`)
  const localDir = path.join(proj, '.episodic-memory')
  fs.rmSync(path.join(localDir, 'index.jsonl'))
  fs.mkdirSync(path.join(localDir, 'index.jsonl'))
  const globalDir = path.join(root, '.episodic-memory')
  fs.mkdirSync(path.join(globalDir, 'episodes'), { recursive: true })
  fs.rmSync(path.join(globalDir, 'index.jsonl'), { force: true })
  fs.mkdirSync(path.join(globalDir, 'index.jsonl'), { recursive: true })
  return { root, proj }
}

function run(script, args, store) {
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args],
    { cwd: store.proj, encoding: 'utf8', env: { ...process.env, HOME: store.root } })
}

function lastJson(stdout) {
  try { return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()) } catch { return null }
}

function checkTyped(r, who) {
  assert(r.status === 1, `${who}: exit 1, got ${r.status}`)
  const j = lastJson(r.stdout)
  assert(j && j.status === 'error', `${who}: typed envelope on stdout, got: ${r.stdout.slice(0, 120)}`)
  assert(new RegExp(`${who}: episode index unreadable`).test(j.message), `${who}: reason discriminator`)
  assert(/index\.jsonl/.test(j.message), `${who}: names index.jsonl`)
  assert(!/at .*\.mjs/.test(r.stderr), `${who}: no raw stack frames on stderr`)
  return j
}

// T3a/T3c fixture: a REGISTERED project store with a dir-shaped index and a
// VALID (empty) global index, so the abort attribution is unambiguous. With
// identity: a hand-written store-identity episode (record_type + 16-hex
// store_id per store-identity.mjs STORE_ID_RE) — identity resolution scans
// episodes/*.md, never index.jsonl, so it survives the corrupt index and the
// :140 loop reaches the store. Without identity: :137 skips it in that loop
// and only the migrate path (:468) touches its index.
function mkRegisteredWorld({ identity }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em628r-'))
  const proj = path.join(root, 'proj'); fs.mkdirSync(proj)
  const globalDir = path.join(root, '.episodic-memory')
  fs.mkdirSync(path.join(globalDir, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(globalDir, 'index.jsonl'), '')
  const regProj = path.join(root, 'regproj')
  const regDir = path.join(regProj, '.episodic-memory')
  fs.mkdirSync(path.join(regDir, 'episodes'), { recursive: true })
  fs.mkdirSync(path.join(regDir, 'index.jsonl'))
  if (identity) {
    fs.writeFileSync(path.join(regDir, 'episodes', '20240101-000000-store-identity-abcd.md'), [
      '---', 'id: 20240101-000000-store-identity-abcd', 'record_type: store-identity',
      'store_id: abcdefabcdefabcd', 'status: active', '---', '',
    ].join('\n'))
  }
  fs.writeFileSync(path.join(globalDir, 'installs.json'),
    JSON.stringify({ schema_version: 1, entries: [{ project_path: regProj, tool: 'test' }] }))
  return { root, proj }
}

t('em-promote aborts typed on corrupt global index', () => {
  const s = mkStore()
  checkTyped(run('em-promote.mjs', [], s), 'em-promote')
})

t('em-promote :140 aborts typed on registered identity-carrying store with corrupt index', () => {
  const s = mkRegisteredWorld({ identity: true })
  const j = checkTyped(run('em-promote.mjs', [], s), 'em-promote')
  assert(j.message.includes(path.join('regproj', '.episodic-memory', 'index.jsonl')),
    'em-promote: names the REGISTERED store index, not global')
})

t('em-promote --migrate aborts typed on registered identity-less store with corrupt index', () => {
  const s = mkRegisteredWorld({ identity: false })
  checkTyped(run('em-promote.mjs', ['--migrate'], s), 'em-promote')
})

t('em-review-request aborts typed on corrupt local index', () => {
  const s = mkStore()
  const r = run('em-review-request.mjs', ['--task', 't1',
    '--plan-ref', 'file:README.md', '--approval-ref', 'episode:x',
    '--pre-checkpoint-ref', 'episode:x', '--post-checkpoint-ref', 'episode:x',
    '--tests-ref', 'file:README.md', '--code-review-ref', 'episode:x', '--no-new-bugs',
    '--scope', 'local', '--branch', 'main', '--head', 'deadbeef', '--dry-run'], s)
  const j = checkTyped(r, 'em-review-request')
  assert(Array.isArray(j.errors), 'em-review-request: errors array present')
})

t('em-workflow-validate aborts typed on corrupt local index', () => {
  const s = mkStore()
  checkTyped(run('em-workflow-validate.mjs', ['--task', 't1', '--gate', 'pre-checkpoint',
    '--scope', 'local', '--branch', 'main', '--head', 'deadbeef'], s), 'em-workflow-validate')
})

console.log(`${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
