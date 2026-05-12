/**
 * Unit tests for scripts/lib/canonicalize-path-tolerant.mjs
 *
 * Covers the F2h-n bypass classes from codex r4-r5 plus base correctness.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { canonicalizePathTolerant, MAX_HOPS } from '../scripts/lib/canonicalize-path-tolerant.mjs'

function tmpDir() {
  // Canonicalize via realpathSync so macOS /var → /private/var and similar
  // platform-prefix symlinks don't surprise the assertions. Each test needs
  // a fully-resolved tmp root because the lib under test dereferences
  // symlinks (which is the entire point).
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canonpath-')))
}

test('absolute existing path returns itself', () => {
  const dir = tmpDir()
  try {
    const file = path.join(dir, 'real.txt')
    fs.writeFileSync(file, '')
    assert.equal(canonicalizePathTolerant(file, dir), file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('relative path resolves against hookCwd', () => {
  const dir = tmpDir()
  try {
    const file = path.join(dir, 'real.txt')
    fs.writeFileSync(file, '')
    assert.equal(canonicalizePathTolerant('real.txt', dir), file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing leaf is preserved literally', () => {
  const dir = tmpDir()
  try {
    const missing = path.join(dir, '.checkpoints', '.preflight-done')
    // .checkpoints/ does not exist; missing component fall-through preserves it
    assert.equal(canonicalizePathTolerant(missing, dir), missing)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing intermediate component is preserved', () => {
  const dir = tmpDir()
  try {
    const p = path.join(dir, 'nope', 'deeper', 'leaf')
    assert.equal(canonicalizePathTolerant(p, dir), p)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F2h: dangling symlink to absent target dereferences to target', () => {
  const dir = tmpDir()
  try {
    const checkpointsAbs = path.join(dir, '.checkpoints', '.preflight-done')
    const symPath = path.join(dir, 'sym')
    // Symlink target doesn't exist on disk
    fs.symlinkSync(path.join('.checkpoints', '.preflight-done'), symPath)
    const out = canonicalizePathTolerant(symPath, dir)
    assert.equal(out, checkpointsAbs, 'dangling symlink must dereference to target')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F2i: multi-hop chain dereferences fully', () => {
  const dir = tmpDir()
  try {
    const checkpointsAbs = path.join(dir, '.checkpoints', '.preflight-done')
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    fs.symlinkSync('b', a)
    fs.symlinkSync(path.join('.checkpoints', '.preflight-done'), b)
    const out = canonicalizePathTolerant(a, dir)
    assert.equal(out, checkpointsAbs)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F2j: symlink in middle of path resolves intermediate', () => {
  const dir = tmpDir()
  try {
    fs.mkdirSync(path.join(dir, '.checkpoints'))
    fs.symlinkSync('.checkpoints', path.join(dir, 'cp_alias'))
    const input = path.join(dir, 'cp_alias', '.preflight-done')
    const expected = path.join(dir, '.checkpoints', '.preflight-done')
    assert.equal(canonicalizePathTolerant(input, dir), expected)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F2k: symlink loop throws SYMLOOP_MAX', () => {
  const dir = tmpDir()
  try {
    fs.symlinkSync('loop2', path.join(dir, 'loop1'))
    fs.symlinkSync('loop1', path.join(dir, 'loop2'))
    assert.throws(
      () => canonicalizePathTolerant(path.join(dir, 'loop1'), dir),
      /SYMLOOP_MAX/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F2l: relative-target symlink resolves against symlink parent', () => {
  const dir = tmpDir()
  try {
    fs.mkdirSync(path.join(dir, '.checkpoints'))
    // Symlink at .checkpoints/dangle -> ./.preflight-done; target absent
    fs.symlinkSync('./.preflight-done', path.join(dir, '.checkpoints', 'dangle'))
    const input = path.join(dir, '.checkpoints', 'dangle')
    const expected = path.join(dir, '.checkpoints', '.preflight-done')
    assert.equal(canonicalizePathTolerant(input, dir), expected)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F2m: absolute-target symlink resolves verbatim', () => {
  const dir = tmpDir()
  try {
    const target = path.join(dir, '.checkpoints', '.preflight-done')
    fs.symlinkSync(target, path.join(dir, 'abs_sym'))
    const out = canonicalizePathTolerant(path.join(dir, 'abs_sym'), dir)
    assert.equal(out, target)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F2n: symlink to unrelated path resolves to that path (not marker)', () => {
  const dir = tmpDir()
  try {
    const otherTmp = tmpDir()
    try {
      const otherFile = path.join(otherTmp, 'scratch.txt')
      fs.writeFileSync(otherFile, '')
      fs.symlinkSync(otherFile, path.join(dir, 'scratch_sym'))
      const out = canonicalizePathTolerant(path.join(dir, 'scratch_sym'), dir)
      assert.equal(out, otherFile)
    } finally {
      fs.rmSync(otherTmp, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('throws on empty inputPath', () => {
  const dir = tmpDir()
  try {
    assert.throws(() => canonicalizePathTolerant('', dir), /non-empty string/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('throws on relative hookCwd', () => {
  assert.throws(
    () => canonicalizePathTolerant('foo', 'relative/cwd'),
    /absolute path/
  )
})

test('handles . and .. in input path', () => {
  const dir = tmpDir()
  try {
    fs.mkdirSync(path.join(dir, 'sub'))
    const input = path.join(dir, 'sub', '..', 'sub', '.', 'foo.txt')
    const expected = path.join(dir, 'sub', 'foo.txt')
    assert.equal(canonicalizePathTolerant(input, dir), expected)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('MAX_HOPS exported as 40', () => {
  assert.equal(MAX_HOPS, 40)
})

test('F1 boundary: chain of MAX_HOPS-1 symlinks succeeds', () => {
  // Build a 39-link chain: link0 -> link1 -> ... -> link38 -> target.
  // Total 39 lstat hops, under MAX_HOPS=40.
  const dir = tmpDir()
  try {
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, '')
    let prev = 'target.txt'
    for (let i = MAX_HOPS - 2; i >= 0; i--) {
      const linkName = `link${i}`
      fs.symlinkSync(prev, path.join(dir, linkName))
      prev = linkName
    }
    const out = canonicalizePathTolerant(path.join(dir, 'link0'), dir)
    assert.equal(out, target, 'just-under-budget chain should resolve')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('F1 boundary: chain of MAX_HOPS+1 symlinks throws SYMLOOP_MAX', () => {
  // Build a 41-link chain (one over budget).
  const dir = tmpDir()
  try {
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, '')
    let prev = 'target.txt'
    for (let i = MAX_HOPS; i >= 0; i--) {
      const linkName = `link${i}`
      fs.symlinkSync(prev, path.join(dir, linkName))
      prev = linkName
    }
    assert.throws(
      () => canonicalizePathTolerant(path.join(dir, 'link0'), dir),
      /SYMLOOP_MAX/
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
