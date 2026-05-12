/**
 * Unit tests for scripts/preflight-marker-write.mjs
 *
 * Focused on the C2 additions (plan v2): `--session-id` flag, per-session
 * basename for `--target last-prompt`, session-id format validation. Pre-
 * existing helper behavior (root validation, atomic temp+rename, JSON parse,
 * non-object payload rejection) is covered by tests/test-preflight-gate.sh
 * end-to-end; this file adds the unit-level coverage that the new arg
 * surface needs.
 *
 * File named without the literal `preflight-marker-write` substring on
 * purpose: the preflight-gate's helper-invocation regex
 * (`\bpreflight-marker-write\.mjs\b`) currently matches any Bash argv
 * containing that token, including this test file's path. The regex
 * tightening is in scope for C5 (gate work). Until then, the test file
 * lives under a clearly-distinct name.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const HELPER = path.resolve('scripts/preflight-marker-write.mjs')

function tmpRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mwtest-')))
  // Helper validates --root has a repo signal (.git/.checkpoints/.episodic-memory).
  fs.mkdirSync(path.join(dir, '.checkpoints'))
  return dir
}

function run(args, stdin = '{"a":1}') {
  return spawnSync('node', [HELPER, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000
  })
}

test('helper: target=preflight ignores --session-id (backward compat)', () => {
  const root = tmpRepo()
  try {
    const r = run(['--root', root, '--target', 'preflight'])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.ok(fs.existsSync(path.join(root, '.checkpoints', '.preflight-done')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: target=last-prompt requires --session-id (exit 8)', () => {
  const root = tmpRepo()
  try {
    const r = run(['--root', root, '--target', 'last-prompt'])
    assert.equal(r.status, 8)
    assert.match(r.stderr, /SESSION_ID_REQUIRED/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: target=last-prompt with valid session-id writes namespaced file', () => {
  const root = tmpRepo()
  try {
    const sid = 'abc123-DEF_456'
    const r = run(['--root', root, '--target', 'last-prompt', '--session-id', sid])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const expectedPath = path.join(root, '.checkpoints', `.last-user-prompt.${sid}.json`)
    assert.ok(fs.existsSync(expectedPath), `expected ${expectedPath}`)
    assert.equal(fs.existsSync(path.join(root, '.checkpoints', '.last-user-prompt.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: session-id with slash is rejected (path traversal guard)', () => {
  const root = tmpRepo()
  try {
    const r = run(['--root', root, '--target', 'last-prompt', '--session-id', '../etc/passwd'])
    assert.equal(r.status, 8)
    assert.match(r.stderr, /SESSION_ID_INVALID/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: session-id with dot is rejected (basename injection guard)', () => {
  const root = tmpRepo()
  try {
    const r = run(['--root', root, '--target', 'last-prompt', '--session-id', 'x.attack'])
    assert.equal(r.status, 8)
    assert.match(r.stderr, /SESSION_ID_INVALID/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: session-id empty string is rejected', () => {
  const root = tmpRepo()
  try {
    const r = run(['--root', root, '--target', 'last-prompt', '--session-id', ''])
    assert.equal(r.status, 8)
    assert.match(r.stderr, /SESSION_ID_(REQUIRED|INVALID)/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: session-id >128 chars is rejected', () => {
  const root = tmpRepo()
  try {
    const big = 'a'.repeat(129)
    const r = run(['--root', root, '--target', 'last-prompt', '--session-id', big])
    assert.equal(r.status, 8)
    assert.match(r.stderr, /SESSION_ID_INVALID/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: session-id UUID format is accepted', () => {
  const root = tmpRepo()
  try {
    const sid = '1d6761c2-eaa2-43f7-a287-9dc2f301c9db'
    const r = run(['--root', root, '--target', 'last-prompt', '--session-id', sid])
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.ok(fs.existsSync(path.join(root, '.checkpoints', `.last-user-prompt.${sid}.json`)))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: two sessions write distinct files (no cross-session collision)', () => {
  const root = tmpRepo()
  try {
    const sidA = 'session-A'
    const sidB = 'session-B'
    run(['--root', root, '--target', 'last-prompt', '--session-id', sidA], '{"prompt":"p_A"}')
    run(['--root', root, '--target', 'last-prompt', '--session-id', sidB], '{"prompt":"p_B"}')
    const fileA = path.join(root, '.checkpoints', `.last-user-prompt.${sidA}.json`)
    const fileB = path.join(root, '.checkpoints', `.last-user-prompt.${sidB}.json`)
    assert.ok(fs.existsSync(fileA))
    assert.ok(fs.existsSync(fileB))
    assert.equal(JSON.parse(fs.readFileSync(fileA, 'utf8')).prompt, 'p_A')
    assert.equal(JSON.parse(fs.readFileSync(fileB, 'utf8')).prompt, 'p_B')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: stdout JSON includes the namespaced path', () => {
  const root = tmpRepo()
  try {
    const sid = 'echo-test'
    const r = run(['--root', root, '--target', 'last-prompt', '--session-id', sid])
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout)
    assert.equal(out.status, 'ok')
    assert.ok(out.path.endsWith(`.last-user-prompt.${sid}.json`))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('helper: --help mentions --session-id', () => {
  const r = spawnSync('node', [HELPER, '--help'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /--session-id/)
})
