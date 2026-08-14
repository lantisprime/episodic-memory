#!/usr/bin/env node
/**
 * test-em-pin-body-read.mjs — issue #669 net-new suite.
 *
 * em-pin.mjs:78 read the episode body with a raw fs.readFileSync while
 * holding the store write lock (clerk-apply.lock). A FIFO-shaped body file
 * (no writer) blocked that read forever — a hang WHILE HOLDING THE LOCK,
 * confirmed pre-fix at >6s (plan §0). The fix (R-C exception, plan §1):
 * em-pin.mjs keeps readBodyOrSkip (not openReadableBody — a thrown
 * BodyUnreadableError would be swallowed by the generic catch into a
 * code-less message); on ok:false it sets result/exitCode inside the try
 * and falls through so the finally still releases the lock.
 *
 * This suite asserts:
 *   - exit 1, typed `episode-unreadable:<CODE>` envelope on the JSON;
 *   - the ON-DISK clerk-apply.lock file is ABSENT afterward (not just the
 *     JSON envelope — a released-but-unasserted lock is the exact failure
 *     mode a process.exit-inside-try would produce);
 *   - the episode frontmatter and index.jsonl are BYTE-UNCHANGED (a failed
 *     pin changes nothing on disk — the read precedes the first write).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const SCRIPTS = path.join(REPO, 'scripts')

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'empin-')))
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'empin-home-')))
  return { cwd, home, env: { ...process.env, HOME: home } }
}

function run(script, args, fx, timeout = 10000) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], { cwd: fx.cwd, encoding: 'utf8', timeout, env: fx.env })
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  return { code: r.status, signal: r.signal, json, stdout: r.stdout }
}

function cleanup(fx) {
  fs.rmSync(fx.cwd, { recursive: true, force: true })
  fs.rmSync(fx.home, { recursive: true, force: true })
}

t('--id with a FIFO-shaped body file: exit 1, typed episode-unreadable envelope, no hang', () => {
  const fx = mkFixture()
  const st = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'decision', '--summary', 'pin target', '--body', 'body text'], fx)
  assert.equal(st.json.status, 'ok', st.stdout)
  const id = st.json.id
  const epPath = path.join(fx.cwd, '.episodic-memory', 'episodes', `${id}.md`)
  const indexPath = path.join(fx.cwd, '.episodic-memory', 'index.jsonl')
  const contentBefore = fs.readFileSync(epPath, 'utf8')
  const indexBefore = fs.readFileSync(indexPath, 'utf8')
  fs.unlinkSync(epPath)
  const mk = spawnSync('mkfifo', [epPath])
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`)

  const r = run('em-pin.mjs', ['--id', id], fx, 5000)
  assert.equal(r.signal, null, `no signal (hang), got ${r.signal}`)
  assert.equal(r.code, 1, `exit 1, got ${r.code}: ${r.stdout}`)
  assert.equal(r.json.status, 'error', r.stdout)
  assert.ok(/^episode-unreadable:/.test(r.json.code || ''), `typed episode-unreadable code, got ${JSON.stringify(r.json)}`)
  assert.ok(/episode body unreadable/.test(r.json.message), `message names the unreadable body, got ${r.json.message}`)

  // On-disk lock file ABSENT (not just the JSON envelope) — the finally
  // block must have run even though the failure was detected mid-try.
  const lockPath = path.join(fx.cwd, '.episodic-memory', 'clerk-apply.lock')
  assert.equal(fs.existsSync(lockPath), false, 'clerk-apply.lock must be absent after the typed failure')

  // Index untouched — the read precedes the first write.
  const indexAfter = fs.readFileSync(indexPath, 'utf8')
  assert.equal(indexAfter, indexBefore, 'index.jsonl must be byte-unchanged on a failed pin')

  fs.unlinkSync(epPath) // remove the FIFO so cleanup's rmSync doesn't hang
  fs.writeFileSync(epPath, contentBefore)
  cleanup(fx)
})

t('--unpin with a FIFO-shaped body file: same typed failure, lock still released', () => {
  const fx = mkFixture()
  const st = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'decision', '--summary', 'unpin target', '--body', 'body text'], fx)
  const id = st.json.id
  run('em-pin.mjs', ['--id', id], fx) // pin it first, real write path
  const epPath = path.join(fx.cwd, '.episodic-memory', 'episodes', `${id}.md`)
  fs.unlinkSync(epPath)
  const mk = spawnSync('mkfifo', [epPath])
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`)

  const r = run('em-pin.mjs', ['--id', id, '--unpin'], fx, 5000)
  assert.equal(r.signal, null, `no signal (hang), got ${r.signal}`)
  assert.equal(r.code, 1, r.stdout)
  assert.ok(/^episode-unreadable:/.test(r.json.code || ''), `typed code, got ${JSON.stringify(r.json)}`)
  const lockPath = path.join(fx.cwd, '.episodic-memory', 'clerk-apply.lock')
  assert.equal(fs.existsSync(lockPath), false, 'clerk-apply.lock must be absent after the typed failure')

  fs.unlinkSync(epPath)
  cleanup(fx)
})

t('healthy control: --id with a normal body file still pins successfully', () => {
  const fx = mkFixture()
  const st = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'decision', '--summary', 'control target', '--body', 'body text'], fx)
  const id = st.json.id
  const r = run('em-pin.mjs', ['--id', id], fx)
  assert.equal(r.code, 0, r.stdout)
  assert.equal(r.json.status, 'ok')
  assert.equal(r.json.pinned, true)
  cleanup(fx)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
