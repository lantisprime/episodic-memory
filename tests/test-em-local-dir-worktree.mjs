#!/usr/bin/env node
/**
 * test-em-local-dir-worktree.mjs — Tests for #85 LOCAL_DIR worktree resolution.
 *
 * Verifies that em-store --scope local writes to the MAIN repo's
 * .episodic-memory/ regardless of whether invoked from main checkout, a linked
 * worktree, a nested cwd inside the worktree, or a non-git directory.
 *
 * Usage: node tests/test-em-local-dir-worktree.mjs
 * Zero dependencies — uses Node.js assert + fs + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const STORE = path.join(SCRIPTS, 'em-store.mjs')

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function storeFrom(cwd, summary) {
  const out = execSync(
    `node ${STORE} --scope local --project test --category context --summary "${summary}" --body "body"`,
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString()
  const res = JSON.parse(out)
  // Realpath res.file too, so macOS /var → /private/var symlinks don't
  // break startsWith() comparisons against realpathed expected stores.
  if (res.file) res.file = fs.realpathSync(res.file)
  return res
}

// ---------------------------------------------------------------------------
// Setup: temp main repo + linked worktree + nested dir + non-git dir
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-localdir-'))
// Register cleanup early so setup failures don't leak temp dirs.
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }))
const mainRepo = path.join(tmpRoot, 'main')
const worktreeRoot = path.join(tmpRoot, 'wt')
const nestedDir = path.join(worktreeRoot, 'a', 'b', 'c')
const nonGitDir = path.join(tmpRoot, 'plain')

fs.mkdirSync(mainRepo, { recursive: true })
fs.mkdirSync(nonGitDir, { recursive: true })

git(mainRepo, 'init -q -b main')
git(mainRepo, 'config user.email test@example.com')
git(mainRepo, 'config user.name test')
fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test\n')
git(mainRepo, 'add README.md')
git(mainRepo, 'commit -q -m init')
git(mainRepo, `worktree add -q -b wt-branch ${worktreeRoot}`)
fs.mkdirSync(nestedDir, { recursive: true })

// Resolve realpath upfront so assertions handle macOS /var → /private/var.
const mainStore = path.join(fs.realpathSync(mainRepo), '.episodic-memory')
const worktreeStore = path.join(fs.realpathSync(worktreeRoot), '.episodic-memory')
const nonGitStore = path.join(fs.realpathSync(nonGitDir), '.episodic-memory')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('main checkout writes episode to main repo .episodic-memory/', () => {
  const res = storeFrom(mainRepo, 'from-main')
  assert.strictEqual(res.status, 'ok')
  assert.ok(res.file.startsWith(mainStore + path.sep), `expected file under ${mainStore}, got ${res.file}`)
  assert.ok(fs.existsSync(res.file))
})

test('linked worktree writes episode to MAIN repo .episodic-memory/, not worktree', () => {
  const res = storeFrom(worktreeRoot, 'from-worktree')
  assert.strictEqual(res.status, 'ok')
  assert.ok(
    res.file.startsWith(mainStore + path.sep),
    `expected file under ${mainStore}, got ${res.file}`,
  )
  assert.ok(
    !res.file.startsWith(worktreeStore + path.sep),
    `episode leaked into worktree store: ${res.file}`,
  )
  assert.ok(!fs.existsSync(worktreeStore), `worktree .episodic-memory/ should not exist, found at ${worktreeStore}`)
})

test('nested cwd inside worktree still writes to MAIN repo .episodic-memory/', () => {
  const res = storeFrom(nestedDir, 'from-nested')
  assert.strictEqual(res.status, 'ok')
  assert.ok(
    res.file.startsWith(mainStore + path.sep),
    `expected file under ${mainStore}, got ${res.file}`,
  )
})

test('non-git cwd falls back to <cwd>/.episodic-memory/', () => {
  const res = storeFrom(nonGitDir, 'from-non-git')
  assert.strictEqual(res.status, 'ok')
  assert.ok(
    res.file.startsWith(nonGitStore + path.sep),
    `expected fallback under ${nonGitStore}, got ${res.file}`,
  )
})

// ---------------------------------------------------------------------------
// Summary (cleanup runs via process.on('exit') registered above)
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
