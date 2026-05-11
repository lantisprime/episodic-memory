#!/usr/bin/env node
/**
 * test-second-opinion-preamble.mjs — Tests for v3.3 byte-safe override-validation
 * + composer + registry-validator.
 *
 * Coverage:
 *   - I-24: default preamble lands verbatim per provider
 *   - I-25: repo override supersedes default; preamble_source = 'repo-override'
 *   - I-26: --preamble CLI flag composes named fragments; unknown id non-zero
 *   - I-30: composer override-path uses shared resolveRepoRoot (algorithm parity)
 *   - I-31: worktree-local override invisible (canonical-only)
 *   - I-32: empty/whitespace override → empty-override-file
 *   - I-33: BODY_SENTINEL_ literal → override-contains-sentinel-template
 *   - I-34: non-UTF8 bytes → override-not-utf8 + precedence (utf8 wins over sentinel)
 *   - Inline FU N1: empty providers[] → registry-invalid
 *   - Inline FU N3: override-not-regular-file (dir, symlink loop)
 *   - Inline FU N5: read-once contract — fs.readFileSync called exactly once on override
 *   - Inline FU N10: duplicate provider id → registry-invalid
 *
 * Zero deps. Node assert + fs + child_process + os.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'
import { execSync } from 'node:child_process'

import {
  loadRegistry,
  resolveOverridePath,
  readAndValidateOverride,
  readFragment,
  compose,
} from '../scripts/second-opinion/preambles/composer.mjs'
import { validateProviderRegistry } from '../scripts/second-opinion/lib/registry-validator.mjs'
import { resolveRepoRoot } from '../scripts/lib/local-dir.mjs'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PROVIDERS_REGISTRY = path.join(REPO_ROOT, 'scripts', 'second-opinion', 'providers', 'index.json')

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

// Cleanup tracker — temp dirs removed at exit.
const tmpDirs = []
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function makeTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-preamble-test-'))
  tmpDirs.push(tmp)
  // Init as git repo so resolveRepoRoot returns it (not its parent).
  execSync(`git init -q ${tmp}`, { stdio: ['ignore', 'pipe', 'ignore'] })
  return tmp
}

function makeTmpWorktree(mainRepo) {
  // Create a commit so worktree-add works.
  execSync(`git -C ${mainRepo} commit --allow-empty -q -m init`,
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' } })
  const wtPath = path.join(path.dirname(mainRepo), `wt-${path.basename(mainRepo)}`)
  tmpDirs.push(wtPath)
  execSync(`git -C ${mainRepo} worktree add -q -b wt-branch ${wtPath}`,
    { stdio: ['ignore', 'pipe', 'pipe'] })
  return wtPath
}

function writeOverride(projectRoot, provider, content) {
  const overrideDir = path.join(projectRoot, '.review-store', 'preambles')
  fs.mkdirSync(overrideDir, { recursive: true })
  const filePath = path.join(overrideDir, `${provider}.md`)
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(filePath, content)
  } else {
    fs.writeFileSync(filePath, content, 'utf8')
  }
  return filePath
}

console.log('# test-second-opinion-preamble')

// ---------------------------------------------------------------------------
// I-24: default preamble lands verbatim
// ---------------------------------------------------------------------------
console.log('\n## I-24 default preamble lands verbatim')
test('default preamble for codex matches review-ladder-v9.4 fragment', () => {
  const tmp = makeTmpProject()
  const result = compose({ provider: 'codex', projectRoot: tmp, cliFragments: null })
  assert.strictEqual(result.preambleSource, 'default')
  assert.deepStrictEqual(result.fragmentIds, ['review-ladder-v9.4'])

  const reg = loadRegistry()
  const expectedFragment = readFragment(reg.fragments.find((f) => f.id === 'review-ladder-v9.4'))
  assert.strictEqual(result.preambleBody, expectedFragment,
    'composed body must equal fragment file content byte-for-byte')
})

test('default preamble for claude-subagent matches claude-subagent-loader-ref', () => {
  const tmp = makeTmpProject()
  const result = compose({ provider: 'claude-subagent', projectRoot: tmp, cliFragments: null })
  assert.strictEqual(result.preambleSource, 'default')
  assert.deepStrictEqual(result.fragmentIds, ['claude-subagent-loader-ref'])
})

test('default preamble for gemini matches gemini-ladder-v1', () => {
  const tmp = makeTmpProject()
  const result = compose({ provider: 'gemini', projectRoot: tmp, cliFragments: null })
  assert.strictEqual(result.preambleSource, 'default')
  assert.deepStrictEqual(result.fragmentIds, ['gemini-ladder-v1'])
})

test('unknown provider with no default → no-default-preamble-for-provider', () => {
  const tmp = makeTmpProject()
  assert.throws(
    () => compose({ provider: 'nonexistent', projectRoot: tmp, cliFragments: null }),
    (e) => e.code === 'no-default-preamble-for-provider'
  )
})

// ---------------------------------------------------------------------------
// I-25: repo override supersedes default; preamble_source = 'repo-override'
// ---------------------------------------------------------------------------
console.log('\n## I-25 repo override supersedes default')
test('repo override at <projectRoot>/.review-store/preambles/codex.md replaces default', () => {
  const tmp = makeTmpProject()
  const overrideContent = '# Custom override for codex\nDo this specific review.'
  writeOverride(tmp, 'codex', overrideContent)

  const result = compose({ provider: 'codex', projectRoot: tmp, cliFragments: null })
  assert.strictEqual(result.preambleSource, 'repo-override')
  assert.strictEqual(result.preambleBody, overrideContent)
  assert.deepStrictEqual(result.fragmentIds, [])
  assert.ok(result.overridePath.endsWith('.review-store/preambles/codex.md'))
})

// ---------------------------------------------------------------------------
// I-26: --preamble CLI flag composes named fragments; unknown id non-zero
// ---------------------------------------------------------------------------
console.log('\n## I-26 --preamble CLI flag')
test('--preamble review-ladder-v9.4 composes single fragment', () => {
  const tmp = makeTmpProject()
  const result = compose({
    provider: 'codex', projectRoot: tmp,
    cliFragments: ['review-ladder-v9.4'],
  })
  assert.strictEqual(result.preambleSource, 'cli-flag')
  assert.deepStrictEqual(result.fragmentIds, ['review-ladder-v9.4'])
})

test('--preamble multi-fragment composes in order', () => {
  const tmp = makeTmpProject()
  const result = compose({
    provider: 'codex', projectRoot: tmp,
    cliFragments: ['review-ladder-v9.4', 'gemini-ladder-v1'],
  })
  assert.strictEqual(result.preambleSource, 'cli-flag')
  assert.deepStrictEqual(result.fragmentIds, ['review-ladder-v9.4', 'gemini-ladder-v1'])
  // Bodies concatenated with double newline.
  const reg = loadRegistry()
  const a = readFragment(reg.fragments.find((f) => f.id === 'review-ladder-v9.4'))
  const b = readFragment(reg.fragments.find((f) => f.id === 'gemini-ladder-v1'))
  assert.strictEqual(result.preambleBody, `${a}\n\n${b}`)
})

test('--preamble unknown id → unknown-preamble-fragment', () => {
  const tmp = makeTmpProject()
  assert.throws(
    () => compose({ provider: 'codex', projectRoot: tmp, cliFragments: ['bogus-id'] }),
    (e) => e.code === 'unknown-preamble-fragment' && e.fragmentId === 'bogus-id'
  )
})

test('--preamble valid,bogus → whole composition fails', () => {
  const tmp = makeTmpProject()
  assert.throws(
    () => compose({
      provider: 'codex', projectRoot: tmp,
      cliFragments: ['review-ladder-v9.4', 'bogus-id'],
    }),
    (e) => e.code === 'unknown-preamble-fragment' && e.fragmentId === 'bogus-id'
  )
})

test('CLI flag wins over repo override', () => {
  const tmp = makeTmpProject()
  writeOverride(tmp, 'codex', 'override content')
  const result = compose({
    provider: 'codex', projectRoot: tmp,
    cliFragments: ['review-ladder-v9.4'],
  })
  assert.strictEqual(result.preambleSource, 'cli-flag')
  assert.notStrictEqual(result.preambleBody, 'override content')
})

// ---------------------------------------------------------------------------
// I-30: composer override-path uses shared resolveRepoRoot (algorithm parity)
// ---------------------------------------------------------------------------
console.log('\n## I-30 composer override-path = resolveRepoRoot(projectRoot) + .review-store/preambles')
test('resolveOverridePath uses resolveRepoRoot output', () => {
  const tmp = makeTmpProject()
  const expected = path.join(resolveRepoRoot(tmp), '.review-store', 'preambles', 'codex.md')
  const actual = resolveOverridePath(tmp, 'codex')
  assert.strictEqual(actual, expected)
})

test('resolveOverridePath in nested cwd resolves to repo root', () => {
  const tmp = makeTmpProject()
  const nested = path.join(tmp, 'sub', 'dir')
  fs.mkdirSync(nested, { recursive: true })
  const expected = path.join(resolveRepoRoot(nested), '.review-store', 'preambles', 'codex.md')
  const actual = resolveOverridePath(nested, 'codex')
  assert.strictEqual(actual, expected)
})

// ---------------------------------------------------------------------------
// I-31: worktree-local override invisible (canonical-only policy)
// ---------------------------------------------------------------------------
console.log('\n## I-31 worktree-local override invisible (canonical-only)')
test('override at worktree path orphaned; canonical override read', () => {
  const main = makeTmpProject()
  const wt = makeTmpWorktree(main)
  // Write override only at canonical (main).
  writeOverride(main, 'codex', 'canonical override content')
  // Verify resolveRepoRoot from worktree resolves to main.
  assert.strictEqual(resolveRepoRoot(wt), fs.realpathSync(main))
  // Compose from worktree path → reads canonical override.
  const result = compose({ provider: 'codex', projectRoot: wt, cliFragments: null })
  assert.strictEqual(result.preambleSource, 'repo-override')
  assert.strictEqual(result.preambleBody, 'canonical override content')
})

test('worktree-only override → composer falls through to default (canonical-only invisibility)', () => {
  const main = makeTmpProject()
  const wt = makeTmpWorktree(main)
  // Write override ONLY at worktree (orphaned from canonical).
  writeOverride(wt, 'codex', 'worktree-only override')
  // Composer resolves to canonical; canonical has no override; falls through to default.
  const result = compose({ provider: 'codex', projectRoot: wt, cliFragments: null })
  assert.strictEqual(result.preambleSource, 'default',
    'worktree-only override must be invisible (canonical-only policy)')
  assert.notStrictEqual(result.preambleBody, 'worktree-only override')
})

// ---------------------------------------------------------------------------
// I-32: empty / whitespace override → empty-override-file
// ---------------------------------------------------------------------------
console.log('\n## I-32 empty/whitespace override rejected')
test('zero-byte override → empty-override-file', () => {
  const tmp = makeTmpProject()
  writeOverride(tmp, 'codex', '')
  assert.throws(
    () => compose({ provider: 'codex', projectRoot: tmp, cliFragments: null }),
    (e) => e.code === 'empty-override-file'
  )
})

test('whitespace-only override → empty-override-file', () => {
  const tmp = makeTmpProject()
  writeOverride(tmp, 'codex', '   \n\t  \n   ')
  assert.throws(
    () => compose({ provider: 'codex', projectRoot: tmp, cliFragments: null }),
    (e) => e.code === 'empty-override-file'
  )
})

// ---------------------------------------------------------------------------
// I-33: BODY_SENTINEL_ literal → override-contains-sentinel-template
// ---------------------------------------------------------------------------
console.log('\n## I-33 BODY_SENTINEL_ literal rejected')
test('override containing BODY_SENTINEL_ literal → override-contains-sentinel-template', () => {
  const tmp = makeTmpProject()
  writeOverride(tmp, 'codex', 'Echo BODY_SENTINEL_ verbatim in your reply.')
  assert.throws(
    () => compose({ provider: 'codex', projectRoot: tmp, cliFragments: null }),
    (e) => e.code === 'override-contains-sentinel-template'
  )
})

// ---------------------------------------------------------------------------
// I-34: non-UTF8 bytes → override-not-utf8 + precedence test
// ---------------------------------------------------------------------------
console.log('\n## I-34 non-UTF8 bytes rejected (with precedence)')
test('non-UTF8 bytes → override-not-utf8', () => {
  const tmp = makeTmpProject()
  writeOverride(tmp, 'codex', Buffer.from([0xff, 0xfe, 0x00]))
  assert.throws(
    () => compose({ provider: 'codex', projectRoot: tmp, cliFragments: null }),
    (e) => e.code === 'override-not-utf8'
  )
})

test('non-UTF8 + sentinel-bytes → override-not-utf8 fires first (precedence)', () => {
  const tmp = makeTmpProject()
  // Buffer.concat: invalid byte 0xff prefix, then BODY_SENTINEL_ literal.
  // Per locked precedence (UTF-8 → empty → sentinel), utf8 must win.
  const mixed = Buffer.concat([Buffer.from([0xff]), Buffer.from('BODY_SENTINEL_value')])
  writeOverride(tmp, 'codex', mixed)
  assert.throws(
    () => compose({ provider: 'codex', projectRoot: tmp, cliFragments: null }),
    (e) => {
      assert.strictEqual(e.code, 'override-not-utf8',
        `expected override-not-utf8 (precedence), got ${e.code}`)
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// Inline FU N3: override-not-regular-file (dir, etc.)
// ---------------------------------------------------------------------------
console.log('\n## N3 override-not-regular-file')
test('override path is a directory → override-not-regular-file', () => {
  const tmp = makeTmpProject()
  // Create a directory at the override path.
  const overrideDir = path.join(tmp, '.review-store', 'preambles')
  fs.mkdirSync(overrideDir, { recursive: true })
  fs.mkdirSync(path.join(overrideDir, 'codex.md'))
  assert.throws(
    () => compose({ provider: 'codex', projectRoot: tmp, cliFragments: null }),
    (e) => e.code === 'override-not-regular-file'
  )
})

// ---------------------------------------------------------------------------
// Inline FU N5: read-once contract via fs.readFileSync spy
// ---------------------------------------------------------------------------
console.log('\n## N5 read-once contract')
test('readAndValidateOverride calls fs.readFileSync exactly once for override path', () => {
  const tmp = makeTmpProject()
  const overridePath = writeOverride(tmp, 'codex', 'valid override content')

  // Spy on fs.readFileSync — count calls with overridePath.
  const orig = fs.readFileSync
  const calls = []
  fs.readFileSync = function (p, opts) {
    if (typeof p === 'string' && p === overridePath) {
      calls.push({ path: p, opts })
    }
    return orig.call(this, p, opts)
  }
  try {
    readAndValidateOverride(overridePath)
  } finally {
    fs.readFileSync = orig
  }
  assert.strictEqual(calls.length, 1,
    `read-once contract: expected 1 read of overridePath, got ${calls.length}`)
})

// ---------------------------------------------------------------------------
// Registry validator — N1 + N10 + per-field predicates (id, prompt_max_chars,
// cli_match, binary, agent_block_patterns, agent_allow_patterns).
// ---------------------------------------------------------------------------
console.log('\n## Registry validator')

// Test helper: a minimal valid entry. Each per-field test overrides ONLY
// the field it exercises so failures isolate to the field under test.
function validEntry(overrides = {}) {
  return {
    id: 'p',
    prompt_max_chars: 100,
    cli_match: '^p\\b',
    binary: 'p',
    agent_block_patterns: [],
    agent_allow_patterns: [],
    ...overrides,
  }
}

test('valid registry passes', () => {
  const reg = JSON.parse(fs.readFileSync(PROVIDERS_REGISTRY, 'utf8'))
  const result = validateProviderRegistry(reg)
  assert.ok(result.ok)
  assert.ok(result.providerCount >= 1)
})

test('N1: empty providers[] → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'providers'
  )
})

test('N10: duplicate provider id → registry-invalid', () => {
  const reg = {
    schema_version: 1,
    providers: [
      validEntry({ id: 'codex' }),
      validEntry({ id: 'codex', prompt_max_chars: 200 }),
    ],
  }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.duplicate === 'codex'
  )
})

test('prompt_max_chars: 0 passes (legitimate "no prompt allowed")', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: 0 })] }
  assert.doesNotThrow(() => validateProviderRegistry(reg))
})

test('prompt_max_chars: null → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: null })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'prompt_max_chars' && e.observed === null
  )
})

test('prompt_max_chars: undefined (missing) → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: undefined })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'prompt_max_chars'
  )
})

test('prompt_max_chars: -1 → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: -1 })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'prompt_max_chars' && e.observed === -1
  )
})

test('prompt_max_chars: "100" (string) → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: '100' })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'prompt_max_chars'
  )
})

test('prompt_max_chars: 1.5 (float) → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: 1.5 })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'prompt_max_chars'
  )
})

test('prompt_max_chars: NaN → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: NaN })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'prompt_max_chars'
  )
})

test('prompt_max_chars: 2147483647 (INT_MAX) passes', () => {
  const reg = { schema_version: 1, providers: [validEntry({ prompt_max_chars: 2147483647 })] }
  assert.doesNotThrow(() => validateProviderRegistry(reg))
})

// ---------------------------------------------------------------------------
// New field validation (Issue #221): cli_match, binary,
// agent_block_patterns, agent_allow_patterns.
// ---------------------------------------------------------------------------

test('cli_match: missing → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ cli_match: undefined })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'cli_match' && e.provider === 'p'
  )
})

test('cli_match: empty string → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ cli_match: '' })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'cli_match' && e.observed === ''
  )
})

test('cli_match: invalid regex ("[") → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ cli_match: '[' })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'cli_match' && typeof e.regexError === 'string'
  )
})

test('binary: missing → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ binary: undefined })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'binary' && e.provider === 'p'
  )
})

test('binary: empty string → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ binary: '' })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'binary'
  )
})

test('binary: non-string (123) → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ binary: 123 })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'binary' && e.observed === 123
  )
})

test('agent_block_patterns: non-array (string) → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ agent_block_patterns: 'foo' })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'agent_block_patterns'
  )
})

test('agent_block_patterns: array with non-string entry → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ agent_block_patterns: ['ok', 42] })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'agent_block_patterns' && e.index === 1
  )
})

test('agent_allow_patterns: non-array (null) → registry-invalid', () => {
  const reg = { schema_version: 1, providers: [validEntry({ agent_allow_patterns: null })] }
  assert.throws(() => validateProviderRegistry(reg),
    (e) => e.code === 'registry-invalid' && e.field === 'agent_allow_patterns'
  )
})

test('agent_allow_patterns: empty array passes (no allowlist exceptions)', () => {
  const reg = { schema_version: 1, providers: [validEntry({ agent_allow_patterns: [] })] }
  assert.doesNotThrow(() => validateProviderRegistry(reg))
})

test('all-new-fields-valid entry passes', () => {
  const reg = {
    schema_version: 1,
    providers: [validEntry({
      cli_match: '^codex\\s+exec\\b',
      binary: 'codex',
      agent_block_patterns: ['codex:codex-rescue'],
      agent_allow_patterns: ['codex:setup'],
    })],
  }
  assert.doesNotThrow(() => validateProviderRegistry(reg))
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
