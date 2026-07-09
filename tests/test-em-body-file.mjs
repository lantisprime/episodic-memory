#!/usr/bin/env node
/**
 * test-em-body-file.mjs — Tests for `--body-file` flag on em-store, em-revise,
 * em-violation. Permission-prompt step 3 fix (workplan v25 rank-28).
 *
 * Verifies:
 *   - happy path: file body equals --body body
 *   - missing file → JSON error
 *   - directory target → JSON error
 *   - empty file → JSON error
 *   - both --body and --body-file → JSON error
 *   - leading BOM stripped
 *   - exactly one trailing \n stripped, \r\n stripped, no other whitespace touched
 *   - em-violation: --body-file feeds bodyText, structuredBody built around it,
 *     subprocess invocation uses --body (never forwards --body-file)
 *
 * Usage: node tests/test-em-body-file.mjs
 * Zero deps — Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, spawnSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const STORE = path.join(REPO, 'scripts', 'em-store.mjs')
const REVISE = path.join(REPO, 'scripts', 'em-revise.mjs')
const VIOLATION = path.join(REPO, 'scripts', 'em-violation.mjs')

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

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-body-file-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  // Seed a patterns/_index.json so em-violation pattern check passes.
  const patternsDir = path.join(home, '.episodic-memory', 'patterns')
  fs.mkdirSync(patternsDir, { recursive: true })
  fs.writeFileSync(path.join(patternsDir, '_index.json'), JSON.stringify({
    patterns: [{ pattern_id: 'bp-test', name: 'Test pattern' }]
  }))
  return {
    root,
    home,
    cwd,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function runJSON(cmd, args, sandbox, input) {
  const r = spawnSync('node', [cmd, ...args], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
    // When `input` is supplied, child stdin is a pipe carrying exactly these
    // bytes — no shell in the path, so backticks/$() reach the script verbatim
    // (the same guarantee a quoted `<<'EOF'` heredoc gives an interactive user).
    ...(input !== undefined ? { input } : {}),
  })
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout.trim()) : null, stderr: r.stderr }
}

function readEpisodeBody(filePath) {
  // Strip frontmatter + leading "# summary\n\n"
  const raw = fs.readFileSync(filePath, 'utf8')
  const m = raw.match(/^---\n[\s\S]*?\n---\n\n# [^\n]*\n\n([\s\S]*)\n$/)
  if (!m) throw new Error(`could not parse body from ${filePath}`)
  return m[1]
}

// ---------------------------------------------------------------------------
// em-store
// ---------------------------------------------------------------------------
console.log('\n--- em-store ---')

test('happy path: --body-file body equals --body body', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'body.md')
    const body = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.'
    fs.writeFileSync(bodyFile, body)
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0, 'expected exit 0')
    assert.strictEqual(r.json.status, 'ok')
    assert.strictEqual(readEpisodeBody(r.json.file), body)
  } finally { sb.cleanup() }
})

test('missing file → JSON error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '/nonexistent/path.md',
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /cannot stat/)
  } finally { sb.cleanup() }
})

test('directory target → JSON error', () => {
  const sb = makeSandbox()
  try {
    const dir = path.join(sb.cwd, 'somedir')
    fs.mkdirSync(dir)
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', dir,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /not a regular file/)
  } finally { sb.cleanup() }
})

test('empty file → JSON error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'empty.md')
    fs.writeFileSync(bodyFile, '')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /is empty/)
  } finally { sb.cleanup() }
})

test('file containing only trailing newline → empty after strip → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'just-newline.md')
    fs.writeFileSync(bodyFile, '\n')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /is empty/)
  } finally { sb.cleanup() }
})

test('--body-file "" (empty argv value) → JSON error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '',
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /empty path argument/)
  } finally { sb.cleanup() }
})

test('both --body and --body-file → JSON error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'b.md')
    fs.writeFileSync(bodyFile, 'content')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body', 'inline', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /mutually exclusive/)
  } finally { sb.cleanup() }
})

test('leading BOM stripped', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'bom.md')
    fs.writeFileSync(bodyFile, '﻿body after BOM')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(readEpisodeBody(r.json.file), 'body after BOM')
  } finally { sb.cleanup() }
})

test('exactly one trailing \\n stripped (others preserved)', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'trailing.md')
    fs.writeFileSync(bodyFile, 'line1\n\n\n')  // 3 trailing \n
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    // 1 stripped → 2 remain inside body; em-store appends 1 final \n on write
    assert.strictEqual(readEpisodeBody(r.json.file), 'line1\n\n')
  } finally { sb.cleanup() }
})

test('trailing \\r\\n stripped', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'crlf.md')
    fs.writeFileSync(bodyFile, 'win-line\r\n')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(readEpisodeBody(r.json.file), 'win-line')
  } finally { sb.cleanup() }
})

test('leading whitespace preserved', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'lead.md')
    fs.writeFileSync(bodyFile, '   indented\nnext line')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(readEpisodeBody(r.json.file), '   indented\nnext line')
  } finally { sb.cleanup() }
})

test('file exceeding MAX_BODY_BYTES → JSON error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'huge.md')
    // Write 1 MB + 1 byte
    fs.writeFileSync(bodyFile, 'x'.repeat(1024 * 1024 + 1))
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /max is 1048576 bytes/)
  } finally { sb.cleanup() }
})

test('file at exactly MAX_BODY_BYTES → ok', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'maxed.md')
    fs.writeFileSync(bodyFile, 'x'.repeat(1024 * 1024))
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
  } finally { sb.cleanup() }
})

test('relative path resolves against cwd', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'rel.md')
    fs.writeFileSync(bodyFile, 'relative-path body')
    // Pass just the basename — script should resolve against process.cwd() (sb.cwd)
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', 'rel.md',
    ], sb)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(readEpisodeBody(r.json.file), 'relative-path body')
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// em-revise
// ---------------------------------------------------------------------------
console.log('\n--- em-revise ---')

test('em-revise --body-file happy path', () => {
  const sb = makeSandbox()
  try {
    // First store an original
    const orig = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 'orig', '--body', 'original body', '--scope', 'local',
    ], sb)
    assert.strictEqual(orig.json.status, 'ok')

    // Then revise via --body-file
    const bodyFile = path.join(sb.cwd, 'revision.md')
    const revBody = 'revised body\nwith multiple lines'
    fs.writeFileSync(bodyFile, revBody)
    const r = runJSON(REVISE, [
      '--original', orig.json.id, '--project', 'p', '--tags', 't',
      '--summary', 'rev', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.json.status, 'ok')
    // em-revise prepends "Revises: `<id>`\n\n" before body — verify body present
    const written = fs.readFileSync(r.json.file, 'utf8')
    assert.ok(written.includes(revBody), 'revised body should appear in file')
  } finally { sb.cleanup() }
})

test('em-revise --body and --body-file together → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'b.md')
    fs.writeFileSync(bodyFile, 'content')
    const r = runJSON(REVISE, [
      '--original', 'fake-id', '--project', 'p', '--tags', 't',
      '--summary', 's', '--body', 'inline', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /mutually exclusive/)
  } finally { sb.cleanup() }
})

test('em-revise --body-file missing → error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(REVISE, [
      '--original', 'fake-id', '--project', 'p', '--tags', 't',
      '--summary', 's', '--body-file', '/nonexistent.md',
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /cannot stat/)
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// em-violation
// ---------------------------------------------------------------------------
console.log('\n--- em-violation ---')

test('em-violation --body-file feeds bodyText, structuredBody built around it', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'what.md')
    const what = 'I skipped step 8 because I was tired.\nNot a good reason.'
    fs.writeFileSync(bodyFile, what)
    const r = runJSON(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 'skipped step 8',
      '--body-file', bodyFile,
      '--sequence', 'a,b,c', '--correct', 'a,b,c,d',
      '--project', 'p', '--scope', 'local',
    ], sb)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
    const written = fs.readFileSync(r.json.file, 'utf8')
    // Body should contain "## What happened\n\n<file content>" + sequence + correct
    assert.ok(written.includes('## What happened'), 'must include What happened')
    assert.ok(written.includes(what), 'must include file body content')
    assert.ok(written.includes('## Violation sequence\n\na,b,c'), 'must include sequence')
    assert.ok(written.includes('## Correct sequence\n\na,b,c,d'), 'must include correct')
  } finally { sb.cleanup() }
})

test('em-violation --body and --body-file together → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'b.md')
    fs.writeFileSync(bodyFile, 'content')
    const r = runJSON(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 's',
      '--body', 'inline', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /mutually exclusive/)
  } finally { sb.cleanup() }
})

test('em-violation --body-file empty file → error', () => {
  const sb = makeSandbox()
  try {
    const bodyFile = path.join(sb.cwd, 'empty.md')
    fs.writeFileSync(bodyFile, '')
    const r = runJSON(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 's', '--body-file', bodyFile,
    ], sb)
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /is empty/)
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// --body-file - (stdin)
// ---------------------------------------------------------------------------
console.log('\n--- --body-file - (stdin) ---')

test('stdin: --body-file - reads piped body', () => {
  const sb = makeSandbox()
  try {
    const body = '# From stdin\n\nMultiple lines.\nPreserved.'
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '-',
    ], sb, body)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
    assert.strictEqual(readEpisodeBody(r.json.file), body)
  } finally { sb.cleanup() }
})

test('stdin: backticks / $() / $VAR survive verbatim (the whole point)', () => {
  const sb = makeSandbox()
  try {
    // The exact content that inline --body "…" would let the shell mangle.
    const body = 'run `Escape` then $(echo hi) and keep $VAR and <socket> literal'
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '-',
    ], sb, body)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(readEpisodeBody(r.json.file), body)
  } finally { sb.cleanup() }
})

test('stdin: empty stdin → JSON error (does not hang)', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '-',
    ], sb, '')
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /stdin is empty/)
  } finally { sb.cleanup() }
})

test('stdin: only a trailing newline → empty after strip → error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '-',
    ], sb, '\n')
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /stdin is empty/)
  } finally { sb.cleanup() }
})

test('stdin: exactly one trailing newline stripped, CRLF stripped, BOM stripped', () => {
  const sb = makeSandbox()
  try {
    const r1 = runJSON(STORE, ['--project', 'p', '--category', 'decision', '--tags', 't', '--summary', 's', '--body-file', '-'], sb, 'a\n\n\n')
    assert.strictEqual(r1.code, 0, r1.stderr)
    assert.strictEqual(readEpisodeBody(r1.json.file), 'a\n\n')  // 1 stripped; em-store re-appends 1
    const r2 = runJSON(STORE, ['--project', 'p', '--category', 'decision', '--tags', 't', '--summary', 's', '--body-file', '-'], sb, 'win\r\n')
    assert.strictEqual(readEpisodeBody(r2.json.file), 'win')
    const r3 = runJSON(STORE, ['--project', 'p', '--category', 'decision', '--tags', 't', '--summary', 's', '--body-file', '-'], sb, '﻿after bom')
    assert.strictEqual(readEpisodeBody(r3.json.file), 'after bom')
  } finally { sb.cleanup() }
})

test('stdin: over MAX_BODY_BYTES → JSON error', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '-',
    ], sb, 'x'.repeat(1024 * 1024 + 1))
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /exceeds max 1048576/)
  } finally { sb.cleanup() }
})

test('stdin: bare - reads stdin even when a file literally named - exists', () => {
  const sb = makeSandbox()
  try {
    fs.writeFileSync(path.join(sb.cwd, '-'), 'FROM THE FILE')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', '-',
    ], sb, 'FROM STDIN')
    assert.strictEqual(r.code, 0, r.stderr)
    assert.strictEqual(readEpisodeBody(r.json.file), 'FROM STDIN')
  } finally { sb.cleanup() }
})

test('file: ./- targets the literal file named - (escape hatch), not stdin', () => {
  const sb = makeSandbox()
  try {
    fs.writeFileSync(path.join(sb.cwd, '-'), 'FROM THE FILE')
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body-file', './-',
    ], sb, 'FROM STDIN')
    assert.strictEqual(r.code, 0, r.stderr)
    assert.strictEqual(readEpisodeBody(r.json.file), 'FROM THE FILE')
  } finally { sb.cleanup() }
})

test('stdin: --body and --body-file - together → error before reading stdin', () => {
  const sb = makeSandbox()
  try {
    const r = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 's', '--body', 'inline', '--body-file', '-',
    ], sb, 'ignored stdin')
    assert.strictEqual(r.code, 1)
    assert.match(r.json.message, /mutually exclusive/)
  } finally { sb.cleanup() }
})

test('stdin: em-revise --body-file - happy path', () => {
  const sb = makeSandbox()
  try {
    const orig = runJSON(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't',
      '--summary', 'orig', '--body', 'original body', '--scope', 'local',
    ], sb)
    assert.strictEqual(orig.json.status, 'ok')
    const revBody = 'revised via stdin `with backticks`'
    const r = runJSON(REVISE, [
      '--original', orig.json.id, '--project', 'p', '--tags', 't',
      '--summary', 'rev', '--body-file', '-',
    ], sb, revBody)
    assert.strictEqual(r.code, 0, r.stderr)
    assert.strictEqual(r.json.status, 'ok')
    assert.ok(fs.readFileSync(r.json.file, 'utf8').includes(revBody))
  } finally { sb.cleanup() }
})

test('stdin: em-violation --body-file - happy path', () => {
  const sb = makeSandbox()
  try {
    const what = 'what happened, told via stdin with $(danger) preserved'
    const r = runJSON(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 'stdin violation',
      '--body-file', '-', '--sequence', 'a,b', '--correct', 'a,b,c',
      '--project', 'p', '--scope', 'local',
    ], sb, what)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
    assert.ok(fs.readFileSync(r.json.file, 'utf8').includes(what), 'stdin body must appear verbatim')
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// --body-file - through a REAL OS pipe (regression guard for the fd-0 blocking
// bug). spawnSync({input}) above does NOT reproduce a shell pipe/heredoc: it
// leaves fd 0 blocking, so it silently passed even while `cat big | node …`
// failed with EAGAIN at ~64 KB. These cases drive `cat file | node …` so a
// regression of the tty.isatty(0) fix (or the bounded reader) fails CI.
// ---------------------------------------------------------------------------
console.log('\n--- --body-file - through a real OS pipe ---')

function runPipe(cmd, args, sandbox, bodyFilePath) {
  const quoted = args.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')
  const shellCmd = `cat '${bodyFilePath}' | node '${cmd}' ${quoted} --body-file -`
  const r = spawnSync('sh', ['-c', shellCmd], {
    cwd: sandbox.cwd,
    env: { ...process.env, HOME: sandbox.home },
    encoding: 'utf8',
  })
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout.trim()) : null, stderr: r.stderr }
}

test('real pipe: 128 KB body survives (regresses the fd-0 EAGAIN bug)', () => {
  const sb = makeSandbox()
  try {
    const body = 'x'.repeat(128 * 1024)  // > the ~64 KB pipe buffer
    const bf = path.join(sb.cwd, 'big.md')
    fs.writeFileSync(bf, body)
    const r = runPipe(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't', '--summary', 's',
    ], sb, bf)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
    assert.strictEqual(readEpisodeBody(r.json.file), body)
  } finally { sb.cleanup() }
})

test('real pipe: body at exactly MAX_BODY_BYTES → ok (cap is reachable, not dead code)', () => {
  const sb = makeSandbox()
  try {
    const body = 'x'.repeat(1024 * 1024)
    const bf = path.join(sb.cwd, 'max.md')
    fs.writeFileSync(bf, body)
    const r = runPipe(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't', '--summary', 's',
    ], sb, bf)
    assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
  } finally { sb.cleanup() }
})

test('real pipe: body over MAX_BODY_BYTES → JSON error (bounded read, no OOM)', () => {
  const sb = makeSandbox()
  try {
    const bf = path.join(sb.cwd, 'over.md')
    fs.writeFileSync(bf, 'x'.repeat(1024 * 1024 + 1))
    const r = runPipe(STORE, [
      '--project', 'p', '--category', 'decision', '--tags', 't', '--summary', 's',
    ], sb, bf)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /exceeds max 1048576/)
  } finally { sb.cleanup() }
})

test('real pipe: em-violation near-max body delegates via child stdin (no E2BIG)', () => {
  const sb = makeSandbox()
  try {
    // Body large enough that the old `--body <structuredBody>` argv delegation
    // overflowed ARG_MAX (spawnSync E2BIG); small enough that the wrapped
    // structuredBody stays under the child's 1 MB cap. Now piped over stdin.
    const body = 'y'.repeat(1024 * 1024 - 512)
    const bf = path.join(sb.cwd, 'vio-big.md')
    fs.writeFileSync(bf, body)
    const r = runPipe(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 'big violation',
      '--sequence', 'a,b', '--correct', 'a,b,c',
      '--project', 'p', '--scope', 'local',
    ], sb, bf)
    assert.strictEqual(r.code, 0, `expected exit 0 (no E2BIG), got ${r.code}: ${r.stderr}`)
    assert.strictEqual(r.json.status, 'ok')
    assert.ok(fs.readFileSync(r.json.file, 'utf8').includes(body.slice(0, 4096)), 'body must reach the stored file')
  } finally { sb.cleanup() }
})

test('real pipe: em-violation body that overflows the child cap → clear surfaced error (not opaque)', () => {
  const sb = makeSandbox()
  try {
    // Exactly MAX passes the OUTER reader; wrapped with section headers the
    // structuredBody exceeds em-store's 1 MB cap, so the child rejects it. The
    // child's message must be surfaced, not swallowed as "Command failed".
    const bf = path.join(sb.cwd, 'vio-over.md')
    fs.writeFileSync(bf, 'z'.repeat(1024 * 1024))
    const r = runPipe(VIOLATION, [
      '--pattern', 'bp-test', '--summary', 'overflow', '--project', 'p', '--scope', 'local',
    ], sb, bf)
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.json.status, 'error')
    assert.match(r.json.message, /exceeds max 1048576/)
    assert.doesNotMatch(r.json.message, /Command failed/)
  } finally { sb.cleanup() }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('')
console.log('==================================================')
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log('==================================================')

if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
