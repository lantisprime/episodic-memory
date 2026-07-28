#!/usr/bin/env node
/**
 * test-second-opinion-maxbuffer.mjs — Regression test for issue #611.
 *
 * Provider dispatch spawnSync must pass an explicit maxBuffer (64 MiB) so
 * Node's 1 MiB default does not SIGTERM the child with ENOBUFS when the
 * review emits >1 MiB on stdout or stderr.
 *
 * Static: read each provider's dispatch function and assert every
 * spawnSync call site inside it passes maxBuffer.
 *
 * Behavioral: demonstrate the default-buffer failure mode (SIGTERM +
 * ENOBUFS) and that 64 MiB captures the full 1.5 MiB stderr.
 *
 * Zero deps. Node assert + fs + child_process.
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PROVIDERS_DIR = path.join(REPO_ROOT, 'scripts', 'second-opinion', 'providers')
const PROVIDERS = ['codex.mjs', 'opencode.mjs', 'claude-subagent.mjs', 'gemini.mjs', 'stub.mjs']

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
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

/**
 * Extract the text of the dispatch function from the provider source.
 * Counts top-level braces while ignoring strings and comments.
 */
function extractDispatchBody(text) {
  const signature = 'export function dispatch('
  const start = text.indexOf(signature)
  if (start === -1) throw new Error('export function dispatch not found')

  // Skip the parameter list so the first '{' after it is the function body.
  let i = start + signature.length
  let parenDepth = 1
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let inLineComment = false
  let inBlockComment = false
  let escape = false

  while (i < text.length && parenDepth > 0) {
    const ch = text[i]
    const next = text[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
    } else if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++ }
    } else if (inSingle) {
      if (escape) { escape = false }
      else if (ch === '\\') { escape = true }
      else if (ch === "'") inSingle = false
    } else if (inDouble) {
      if (escape) { escape = false }
      else if (ch === '\\') { escape = true }
      else if (ch === '"') inDouble = false
    } else if (inTemplate) {
      if (escape) { escape = false }
      else if (ch === '\\') { escape = true }
      else if (ch === '`') inTemplate = false
    } else {
      if (ch === '/' && next === '/') { inLineComment = true; i++ }
      else if (ch === '/' && next === '*') { inBlockComment = true; i++ }
      else if (ch === "'") inSingle = true
      else if (ch === '"') inDouble = true
      else if (ch === '`') inTemplate = true
      else if (ch === '(') parenDepth++
      else if (ch === ')') parenDepth--
    }
    i++
  }

  // Find the function body '{'.
  while (i < text.length && text[i] !== '{') i++
  if (i >= text.length) throw new Error('dispatch function body start not found')

  let depth = 0
  inSingle = false
  inDouble = false
  inTemplate = false
  inLineComment = false
  inBlockComment = false
  escape = false

  for (; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inSingle) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inDouble = false
      continue
    }
    if (inTemplate) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '`') inTemplate = false
      continue
    }

    if (ch === '/' && next === '/') { inLineComment = true; i++; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '`') { inTemplate = true; continue }

    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return text.slice(start, i + 1)
}

/**
 * Return the full spawnSync(...) call strings inside the given function body,
 * matching parentheses while ignoring strings.
 */
function findSpawnSyncCalls(body) {
  const calls = []
  let idx = 0
  while (true) {
    idx = body.indexOf('spawnSync(', idx)
    if (idx === -1) break
    let i = idx + 'spawnSync('.length
    let depth = 1
    let inSingle = false
    let inDouble = false
    let inTemplate = false
    let escape = false
    while (i < body.length && depth > 0) {
      const ch = body[i]
      if (inSingle) {
        if (escape) { escape = false }
        else if (ch === '\\') { escape = true }
        else if (ch === "'") inSingle = false
      } else if (inDouble) {
        if (escape) { escape = false }
        else if (ch === '\\') { escape = true }
        else if (ch === '"') inDouble = false
      } else if (inTemplate) {
        if (escape) { escape = false }
        else if (ch === '\\') { escape = true }
        else if (ch === '`') inTemplate = false
      } else {
        if (ch === "'") inSingle = true
        else if (ch === '"') inDouble = true
        else if (ch === '`') inTemplate = true
        else if (ch === '(') depth++
        else if (ch === ')') depth--
      }
      i++
    }
    calls.push(body.slice(idx, i))
    idx = i
  }
  return calls
}

console.log('# test-second-opinion-maxbuffer')

// ---------------------------------------------------------------------------
// Static: every dispatch spawnSync passes maxBuffer
// ---------------------------------------------------------------------------
console.log('\n## Static: dispatch spawnSync options include maxBuffer')
for (const file of PROVIDERS) {
  test(`${file} dispatch spawnSync passes maxBuffer`, () => {
    const text = fs.readFileSync(path.join(PROVIDERS_DIR, file), 'utf8')
    const body = extractDispatchBody(text)
    const calls = findSpawnSyncCalls(body)
    assert.ok(calls.length > 0, `expected at least one spawnSync in dispatch, found ${calls.length}`)
    for (const call of calls) {
      assert.ok(
        /\bmaxBuffer\s*:/.test(call),
        `spawnSync in ${file} is missing maxBuffer in options: ${call.slice(0, 200)}`
      )
    }
  })
}

// ---------------------------------------------------------------------------
// Behavioral: prove the default 1 MiB limit is real and that 64 MiB fixes it
// ---------------------------------------------------------------------------
console.log('\n## Behavioral: ENOBUFS failure mode and 64 MiB fix')
const EMIT = 'process.stderr.write("x".repeat(1536*1024))'

test('without maxBuffer: child is killed with SIGTERM + ENOBUFS', () => {
  const result = spawnSync(process.execPath, ['-e', EMIT], {
    stdio: 'pipe',
    encoding: 'utf8',
  })
  assert.strictEqual(result.status, null, 'status should be null on ENOBUFS')
  assert.strictEqual(result.signal, 'SIGTERM', 'signal should be SIGTERM')
  assert.ok(result.error, 'error should be set')
  assert.strictEqual(result.error.code, 'ENOBUFS', 'error code should be ENOBUFS')
})

test('with maxBuffer 64 MiB: child captures full 1.5 MiB stderr', () => {
  const result = spawnSync(process.execPath, ['-e', EMIT], {
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  assert.strictEqual(result.status, 0, 'status should be 0')
  assert.strictEqual(result.signal, null, 'signal should be null')
  assert.strictEqual(result.stderr.length, 1572864, 'stderr should be exactly 1536 KiB')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
