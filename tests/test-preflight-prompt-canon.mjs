/**
 * Unit tests for scripts/lib/preflight-prompt-canon.mjs
 *
 * Covers the I-canon invariant from `scratch/238-plan-v2.md`:
 *   prompt_sha256 = sha256_hex( utf8_bytes( JSON.parse(stdin).prompt ) )
 *
 * Known-value anchors below were computed independently
 * (`printf '%s' '<input>' | shasum -a 256`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  canonicalPromptSha256,
  canonicalPromptSha256FromString
} from '../scripts/lib/preflight-prompt-canon.mjs'

// Reference shas computed locally:
//   printf '%s' 'hello'            | shasum -a 256
//   printf '%s' ''                 | shasum -a 256
const SHA_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function sha256Utf8(s) {
  return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')
}

test('canon: plain ASCII matches independent sha256', () => {
  assert.equal(canonicalPromptSha256FromString('hello'), SHA_HELLO)
})

test('canon: empty string sha is the well-known empty-input digest', () => {
  assert.equal(canonicalPromptSha256FromString(''), SHA_EMPTY)
})

test('canon: stdin wrapper extracts .prompt and hashes its bytes', () => {
  const stdin = JSON.stringify({ prompt: 'hello', session_id: 'abc' })
  assert.equal(canonicalPromptSha256(stdin), SHA_HELLO)
})

test('canon: JSON.parse unescapes \\n before hashing — escape vs raw newline match', () => {
  // The whole point of pinning canonicalization: both representations of
  // "hi<newline>there" produce the same sha. Without JSON.parse(), the raw
  // backslash-n bytes would hash differently from the actual newline byte.
  const fromEscapedJson = canonicalPromptSha256(JSON.stringify({ prompt: 'hi\nthere' }))
  const fromLiteral = canonicalPromptSha256FromString('hi\nthere')
  assert.equal(fromEscapedJson, fromLiteral)
})

test('canon: no trailing newline is appended', () => {
  // sha("hi") vs sha("hi\n") must differ; canon must produce the former.
  const withoutNl = canonicalPromptSha256FromString('hi')
  const withNl = canonicalPromptSha256FromString('hi\n')
  assert.notEqual(withoutNl, withNl)
  assert.equal(withoutNl, sha256Utf8('hi'))
})

test('canon: multi-byte UTF-8 encodes correctly', () => {
  // mix of 1-byte ASCII, 2-byte Latin-1 supplement, 3-byte CJK
  const prompt = 'héllo 你好'
  const expected = sha256Utf8(prompt)
  assert.equal(canonicalPromptSha256FromString(prompt), expected)
  assert.equal(canonicalPromptSha256(JSON.stringify({ prompt })), expected)
})

test('canon: surrogate pair (emoji) — 4-byte UTF-8 sequence', () => {
  // U+1F680 ROCKET — UTF-8 is F0 9F 9A 80
  const prompt = 'launch 🚀'
  const expected = sha256Utf8(prompt)
  assert.equal(canonicalPromptSha256FromString(prompt), expected)
  assert.equal(canonicalPromptSha256(JSON.stringify({ prompt })), expected)
})

test('canon: embedded NUL byte is hashed (not truncated)', () => {
  // \x00 hex-escape keeps the test source as text (no raw NUL in file)
  // while the JS-parsed string contains a real NUL byte at position 1.
  const prompt = 'a\x00b'
  const expected = sha256Utf8(prompt)
  assert.equal(canonicalPromptSha256FromString(prompt), expected)
  // Round-trip via JSON (which encodes NUL as "") must also match.
  assert.equal(canonicalPromptSha256(JSON.stringify({ prompt })), expected)
})

test('canon: stdin with extra fields hashes only .prompt', () => {
  const stdinA = JSON.stringify({ prompt: 'same', session_id: 'A', cwd: '/x' })
  const stdinB = JSON.stringify({ prompt: 'same', session_id: 'B', cwd: '/y', extra: 42 })
  assert.equal(canonicalPromptSha256(stdinA), canonicalPromptSha256(stdinB))
})

test('canon: invalid stdin — not a string', () => {
  assert.throws(() => canonicalPromptSha256(null), TypeError)
  assert.throws(() => canonicalPromptSha256(42), TypeError)
  assert.throws(() => canonicalPromptSha256({ prompt: 'x' }), TypeError)
})

test('canon: invalid stdin — bad JSON', () => {
  assert.throws(() => canonicalPromptSha256('not json'), SyntaxError)
  assert.throws(() => canonicalPromptSha256(''), SyntaxError)
})

test('canon: invalid stdin — JSON is not an object', () => {
  assert.throws(() => canonicalPromptSha256('null'), TypeError)
  assert.throws(() => canonicalPromptSha256('[]'), TypeError)
  assert.throws(() => canonicalPromptSha256('"raw string"'), TypeError)
  assert.throws(() => canonicalPromptSha256('42'), TypeError)
})

test('canon: invalid stdin — .prompt missing or non-string', () => {
  assert.throws(() => canonicalPromptSha256('{}'), TypeError)
  assert.throws(() => canonicalPromptSha256(JSON.stringify({ prompt: null })), TypeError)
  assert.throws(() => canonicalPromptSha256(JSON.stringify({ prompt: 42 })), TypeError)
  assert.throws(() => canonicalPromptSha256(JSON.stringify({ prompt: ['a'] })), TypeError)
})

test('canon: from-string accepts strings up to 10MB', () => {
  // Sanity: no length cap inside canon. The hook may impose limits separately.
  const big = 'x'.repeat(10 * 1024 * 1024)
  const sha = canonicalPromptSha256FromString(big)
  assert.equal(sha.length, 64)
})
