#!/usr/bin/env node
/**
 * test-em-watch-codex.mjs — Tests for em-watch-codex.mjs
 *
 * Usage: node tests/test-em-watch-codex.mjs
 *
 * Covers tag-alias filtering, id-based cursor, scope independence, walk-up
 * project-root resolution, partial-line resilience, and CLI arg validation.
 * Zero dependencies — uses Node.js assert + fs + child_process.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, spawnSync, spawn } from 'child_process'
import assert from 'assert'

const SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts')
const WATCH = path.join(SCRIPTS, 'em-watch-codex.mjs')

let passed = 0
let failed = 0
const failures = []
const pending = []

function test(name, fn) {
  let result
  try {
    result = fn()
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
    return
  }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(
      () => { passed++; console.log(`  ✓ ${name}`) },
      (e) => { failed++; failures.push({ name, error: e.message }); console.log(`  ✗ ${name}: ${e.message}`) },
    ))
    return
  }
  passed++
  console.log(`  ✓ ${name}`)
}

function watchAsync(args, cwd, env) {
  return new Promise((resolve) => {
    const p = spawn('node', [WATCH, ...args.split(' ').filter(Boolean)], { cwd, env })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('close', (code) => resolve({ code, stdout, stderr, json: safeParse(stdout.trim()) }))
  })
}

function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

function watch(args, cwd, env) {
  const r = spawnSync('node', [WATCH, ...args.split(' ').filter(Boolean)], {
    encoding: 'utf8', cwd, env,
  })
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    json: safeParse((r.stdout || '').trim()),
  }
}

// ---------------------------------------------------------------------------
// Fixture: build a temp project + global store
// ---------------------------------------------------------------------------
function makeFixture() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'em-watch-codex-'))
  const tmpProject = path.join(tmpHome, 'project')
  fs.mkdirSync(tmpProject, { recursive: true })
  const localStore = path.join(tmpProject, '.episodic-memory')
  const globalStore = path.join(tmpHome, '.episodic-memory')
  fs.mkdirSync(path.join(localStore, 'episodes'), { recursive: true })
  fs.mkdirSync(path.join(globalStore, 'episodes'), { recursive: true })
  // Initialize empty index files so findLocalStore walk-up works.
  fs.writeFileSync(path.join(localStore, 'index.jsonl'), '', 'utf8')
  fs.writeFileSync(path.join(globalStore, 'index.jsonl'), '', 'utf8')
  return {
    tmpHome,
    tmpProject,
    localStore,
    globalStore,
    env: { ...process.env, HOME: tmpHome },
  }
}

function appendEntry(store, entry) {
  fs.appendFileSync(path.join(store, 'index.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
}

function writeTagsIndex(store, obj) {
  fs.writeFileSync(path.join(store, 'tags.json'), JSON.stringify(obj), 'utf8')
}

function makeEntry({ id, tags = ['codex'], summary = 'Codex something', project = 'p', category = 'context', status = 'active' }) {
  // Date/time derived from id prefix so they stay consistent.
  const date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`
  const time = `${id.slice(9, 11)}:${id.slice(11, 13)}`
  return { id, date, time, project, category, status, supersedes: null, tags, summary }
}

console.log('Running em-watch-codex tests...')

// T1: empty store → count 0, cursor not advanced
test('T1 empty store returns count 0 and does not write cursor', () => {
  const f = makeFixture()
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.code, 0)
  assert.strictEqual(r.json.status, 'ok')
  assert.strictEqual(r.json.count, 0)
  assert.strictEqual(r.json.cursor_updated, false)
  assert.ok(!fs.existsSync(path.join(f.localStore, 'state', 'codex-watcher.json')))
})

// T2: 1 new codex-tagged → returned, cursor advanced
test('T2 single codex-tagged episode returned and cursor advanced', () => {
  const f = makeFixture()
  const id = '20260501-080000-codex-reply-aaaa'
  appendEntry(f.localStore, makeEntry({ id }))
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, id)
  assert.strictEqual(r.json.cursor_updated, true)
  assert.deepStrictEqual(r.json.previous, { local: null, global: null })
  assert.strictEqual(r.json.new.local, id)
  const cursor = JSON.parse(fs.readFileSync(path.join(f.localStore, 'state', 'codex-watcher.json'), 'utf8'))
  assert.strictEqual(cursor.local, id)
})

// T3: codex + non-codex → only codex returned
test('T3 non-codex tagged episodes excluded', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-reply-aaaa', tags: ['codex'] }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080001-claude-only-bbbb', tags: ['claude'] }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080002-untagged-cccc', tags: [] }))
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, '20260501-080000-codex-reply-aaaa')
})

// T4: both `claude` and `codex` tags → returned once
test('T4 episode with both claude and codex tags returned exactly once', () => {
  const f = makeFixture()
  const id = '20260501-080000-mixed-tags-aaaa'
  appendEntry(f.localStore, makeEntry({ id, tags: ['claude', 'codex'] }))
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, id)
  assert.strictEqual(r.json.episodes[0].match_reason, 'tag:codex')
})

// T5: malformed cursor file → treated as no cursor, return all
test('T5 malformed cursor file ignored, all codex episodes returned', () => {
  const f = makeFixture()
  fs.mkdirSync(path.join(f.localStore, 'state'), { recursive: true })
  fs.writeFileSync(path.join(f.localStore, 'state', 'codex-watcher.json'), '{not json', 'utf8')
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080001-codex-bbbb' }))
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 2)
})

// T6: --no-update → cursor not advanced
test('T6 --no-update returns episodes but does not persist cursor', () => {
  const f = makeFixture()
  const id = '20260501-080000-codex-reply-aaaa'
  appendEntry(f.localStore, makeEntry({ id }))
  const r = watch('--no-update', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.cursor_updated, false)
  assert.ok(!fs.existsSync(path.join(f.localStore, 'state', 'codex-watcher.json')))
})

// T7: --since override respected (and does not write cursor)
test('T7 --since override respected and does not advance cursor', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080001-codex-bbbb' }))
  const r = watch('--since 20260501-080000-codex-aaaa', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, '20260501-080001-codex-bbbb')
  assert.strictEqual(r.json.cursor_updated, false)
  assert.ok(!fs.existsSync(path.join(f.localStore, 'state', 'codex-watcher.json')))
})

// T8: scope semantics
test('T8a --scope local reads local only', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-local-codex-aaaa' }))
  appendEntry(f.globalStore, makeEntry({ id: '20260501-080001-global-codex-bbbb' }))
  const r = watch('--scope local', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, '20260501-080000-local-codex-aaaa')
  assert.deepStrictEqual(r.json.scopes_queried, ['local'])
})

test('T8b --scope global reads global only', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-local-codex-aaaa' }))
  appendEntry(f.globalStore, makeEntry({ id: '20260501-080001-global-codex-bbbb' }))
  const r = watch('--scope global', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, '20260501-080001-global-codex-bbbb')
  assert.deepStrictEqual(r.json.scopes_queried, ['global'])
})

test('T8c --scope all reads both with independent cursors', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-local-codex-aaaa' }))
  appendEntry(f.globalStore, makeEntry({ id: '20260501-080001-global-codex-bbbb' }))
  const r = watch('--scope all', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 2)
  assert.deepStrictEqual(r.json.scopes_queried, ['local', 'global'])
  assert.strictEqual(r.json.new.local, '20260501-080000-local-codex-aaaa')
  assert.strictEqual(r.json.new.global, '20260501-080001-global-codex-bbbb')
  const sources = r.json.episodes.map(e => e.source).sort()
  assert.deepStrictEqual(sources, ['global', 'local'])
})

// T9: stale-local + new-global with --scope all returns global new (no cross-scope masking)
test('T9 stale-local + new-global: --scope all returns global new without masking', () => {
  const f = makeFixture()
  // Pre-populate cursor as if local was already seen.
  fs.mkdirSync(path.join(f.localStore, 'state'), { recursive: true })
  fs.writeFileSync(
    path.join(f.localStore, 'state', 'codex-watcher.json'),
    JSON.stringify({ local: '20260501-079999-old-codex-zzzz', global: null }),
    'utf8',
  )
  appendEntry(f.localStore, makeEntry({ id: '20260501-070000-stale-codex-aaaa' })) // older than cursor
  appendEntry(f.globalStore, makeEntry({ id: '20260501-080000-new-codex-bbbb' }))
  const r = watch('--scope all', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, '20260501-080000-new-codex-bbbb')
  assert.strictEqual(r.json.episodes[0].source, 'global')
})

// T10: cursor advance is atomic (temp+rename) — verify no .tmp file remains
test('T10 cursor write is atomic (no .tmp residue)', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  watch('', f.tmpProject, f.env)
  const stateDir = path.join(f.localStore, 'state')
  const files = fs.readdirSync(stateDir)
  assert.deepStrictEqual(files.sort(), ['codex-watcher.json'])
})

// T11: worktree run walks up to main-repo store (no worktree-local store exists)
test('T11 worktree run walks up to main repo store when worktree has no local store', () => {
  const f = makeFixture()
  const worktreeDir = path.join(f.tmpProject, '.claude', 'worktrees', 'fake-tree')
  fs.mkdirSync(worktreeDir, { recursive: true })
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  const r = watch('', worktreeDir, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, '20260501-080000-codex-aaaa')
  assert.ok(fs.existsSync(path.join(f.localStore, 'state', 'codex-watcher.json')))
  assert.ok(!fs.existsSync(path.join(worktreeDir, '.episodic-memory', 'state', 'codex-watcher.json')))
})

// T11b: worktree-local store wins over parent's store (first ancestor with index.jsonl)
test('T11b worktree-local store takes precedence over parent main repo', () => {
  const f = makeFixture()
  const worktreeDir = path.join(f.tmpProject, '.claude', 'worktrees', 'fake-tree')
  const worktreeStore = path.join(worktreeDir, '.episodic-memory')
  fs.mkdirSync(path.join(worktreeStore, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(worktreeStore, 'index.jsonl'), '', 'utf8')
  // Distinct episodes per store. Walk-up should pick the worktree's first.
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-parent-codex-aaaa' }))
  appendEntry(worktreeStore, makeEntry({ id: '20260501-080001-worktree-codex-bbbb' }))
  const r = watch('', worktreeDir, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].id, '20260501-080001-worktree-codex-bbbb')
  assert.ok(fs.existsSync(path.join(worktreeStore, 'state', 'codex-watcher.json')))
  assert.ok(!fs.existsSync(path.join(f.localStore, 'state', 'codex-watcher.json')))
})

// T12: partial last line in index.jsonl skipped; cursor advances only to last parsed id
test('T12 partial last line skipped, cursor advances only to last parsed id', () => {
  const f = makeFixture()
  // Write two valid entries, then append a partial JSON line.
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080001-codex-bbbb' }))
  // Simulate partial write — broken JSON, no closing brace, no newline at start.
  fs.appendFileSync(path.join(f.localStore, 'index.jsonl'), '{"id":"20260501-080002-codex-cccc","tags":["cod', 'utf8')
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 2)
  assert.strictEqual(r.json.new.local, '20260501-080001-codex-bbbb')
  // On a subsequent run, after the partial line gets completed, the third entry
  // should be picked up (cursor was NOT advanced past it).
  // Rewrite index with the third line completed.
  const completedThird = JSON.stringify(makeEntry({ id: '20260501-080002-codex-cccc' }))
  fs.writeFileSync(
    path.join(f.localStore, 'index.jsonl'),
    [
      JSON.stringify(makeEntry({ id: '20260501-080000-codex-aaaa' })),
      JSON.stringify(makeEntry({ id: '20260501-080001-codex-bbbb' })),
      completedThird,
      '',
    ].join('\n'),
    'utf8',
  )
  const r2 = watch('', f.tmpProject, f.env)
  assert.strictEqual(r2.json.count, 1)
  assert.strictEqual(r2.json.episodes[0].id, '20260501-080002-codex-cccc')
})

// T13: tag aliases codex-review and codex-reply matched
test('T13 codex-review and codex-reply tag aliases matched', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-rev-aaaa', tags: ['codex-review'] }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080001-rep-bbbb', tags: ['codex-reply'] }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080002-other-cccc', tags: ['random'] }))
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 2)
  const reasons = r.json.episodes.map(e => e.match_reason).sort()
  assert.deepStrictEqual(reasons, ['tag:codex-reply', 'tag:codex-review'])
})

// T14: same-second ids tie-break by full id string
test('T14 same-second ids ordered by full id string', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-zzzz' }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-mmmm' }))
  const r = watch('', f.tmpProject, f.env)
  assert.deepStrictEqual(
    r.json.episodes.map(e => e.id),
    ['20260501-080000-codex-aaaa', '20260501-080000-codex-mmmm', '20260501-080000-codex-zzzz'],
  )
  assert.strictEqual(r.json.new.local, '20260501-080000-codex-zzzz')
})

// T15: invalid --scope → exit 2 with error JSON
test('T15 invalid --scope rejected with exit 2 and error JSON', () => {
  const f = makeFixture()
  const r = watch('--scope foo', f.tmpProject, f.env)
  assert.strictEqual(r.code, 2)
  assert.strictEqual(r.json.status, 'error')
  assert.ok(/Invalid --scope/.test(r.json.message))
})

// T16: invalid --since → exit 2
test('T16 invalid --since (non-id format) rejected with exit 2', () => {
  const f = makeFixture()
  const r = watch('--since 2026-05-01T07:00:00Z', f.tmpProject, f.env)
  assert.strictEqual(r.code, 2)
  assert.strictEqual(r.json.status, 'error')
  assert.ok(/Invalid --since/.test(r.json.message))
})

// T18: tags.json missing → linear-fallback warning emitted
test('T18 tags.json missing emits linear-scan warning', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  // No tags.json written → loadTagsIndex returns null → fallback path.
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.ok(r.json.warning && /tags\.json missing/.test(r.json.warning),
    `expected tags.json warning, got: ${JSON.stringify(r.json.warning)}`)
})

// T19: --since with --prefixed value → exit 2 (catches typo "--since --scope local")
test('T19 flag with --prefixed value is rejected', () => {
  const f = makeFixture()
  const r = watch('--since --scope local', f.tmpProject, f.env)
  assert.strictEqual(r.code, 2)
  assert.strictEqual(r.json.status, 'error')
  assert.ok(/--since requires a value/.test(r.json.message))
})

// T20: --scope global from outside any project does not materialize phantom local store
test('T20 --scope global without project root does not create phantom .episodic-memory', () => {
  const f = makeFixture()
  const orphanDir = path.join(f.tmpHome, 'orphan')
  fs.mkdirSync(orphanDir, { recursive: true })
  appendEntry(f.globalStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  const r = watch('--scope global', orphanDir, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.cursor_updated, false)
  // No .episodic-memory created in the orphan cwd.
  assert.ok(!fs.existsSync(path.join(orphanDir, '.episodic-memory')))
})

// T21: --no-update preview shows would-be cursor advance
test('T21 --no-update echoes would-be cursor in new field', () => {
  const f = makeFixture()
  const id = '20260501-080000-codex-aaaa'
  appendEntry(f.localStore, makeEntry({ id }))
  const r = watch('--no-update', f.tmpProject, f.env)
  assert.strictEqual(r.json.cursor_updated, false)
  assert.strictEqual(r.json.previous.local, null)
  assert.strictEqual(r.json.new.local, id)
  assert.ok(!fs.existsSync(path.join(f.localStore, 'state', 'codex-watcher.json')))
})

// T22: tag iteration order — match_reason reflects episode's first matching tag
test('T22 match_reason reflects episode tag order, not alias precedence', () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa', tags: ['codex-reply', 'codex'] }))
  const r = watch('', f.tmpProject, f.env)
  assert.strictEqual(r.json.count, 1)
  assert.strictEqual(r.json.episodes[0].match_reason, 'tag:codex-reply')
})

// T17: concurrent watcher invocations don't double-skip
//   With cursor advance happening only to max-id of returned episodes, the
//   worst case is one run "loses" its cursor write to the other's overwrite
//   — but the run that "lost" still saw the episodes. The cursor file ends
//   up at the max-id from whichever run won the rename race. Across both
//   runs, every matching episode is observed at least once.
test('T17 two concurrent watcher invocations both see all episodes (no double-skip)', async () => {
  const f = makeFixture()
  appendEntry(f.localStore, makeEntry({ id: '20260501-080000-codex-aaaa' }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080001-codex-bbbb' }))
  appendEntry(f.localStore, makeEntry({ id: '20260501-080002-codex-cccc' }))
  // Fire two watcher processes truly concurrently. Each reads the index +
  // cursor before either has written, so both should observe all 3 episodes.
  const [r1, r2] = await Promise.all([
    watchAsync('', f.tmpProject, f.env),
    watchAsync('', f.tmpProject, f.env),
  ])
  for (const r of [r1, r2]) {
    assert.strictEqual(r.json.status, 'ok')
    assert.strictEqual(r.json.count, 3)
  }
  const cursor = JSON.parse(fs.readFileSync(path.join(f.localStore, 'state', 'codex-watcher.json'), 'utf8'))
  assert.strictEqual(cursor.local, '20260501-080002-codex-cccc')
})

// ---------------------------------------------------------------------------
// Summary (waits for any async tests to settle)
// ---------------------------------------------------------------------------
await Promise.all(pending)
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`)
  process.exit(1)
}
