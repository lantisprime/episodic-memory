#!/usr/bin/env node
/**
 * test-transcript-walker.mjs — unit tests for scripts/lib/transcript-walker.mjs.
 *
 * Builds a temporary projects dir with hand-crafted JSONL transcripts, points
 * the walker at it via a mocked PROJECTS_DIR-equivalent, then asserts shape
 * and classification.
 *
 * The walker hardcodes ~/.claude/projects, so we cannot inject a path. To
 * test in isolation we override HOME for the duration of the test (the walker
 * computes PROJECTS_DIR at module-load time, so we have to require it AFTER
 * setting HOME).
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'em-walker-test-'))
process.env.HOME = TMP

const projectsDir = path.join(TMP, '.claude', 'projects')
fs.mkdirSync(projectsDir, { recursive: true })

// --- fixtures --------------------------------------------------------------
const slug1 = '-Users-test-projects-foo'
const slug2 = '-Users-test-projects-bar--claude-worktrees-feature-x'
const sid1 = '11111111-1111-1111-1111-111111111111'
const sid2 = '22222222-2222-2222-2222-222222222222'

const session1 = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-01T10:00:00Z', sessionId: sid1, content: 'hey can you fix the auth bug' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-05-01T10:00:01Z', sessionId: sid1 },
  { type: 'attachment', timestamp: '2026-05-01T10:00:02Z', sessionId: sid1, attachment: { type: 'hook_success', hookName: 'SessionStart' }, cwd: '/Users/test/foo' },
  { type: 'assistant', timestamp: '2026-05-01T10:00:05Z', sessionId: sid1, cwd: '/Users/test/foo', message: { content: [{ type: 'text', text: 'looking at the auth code now' }] } },
  { type: 'assistant', timestamp: '2026-05-01T10:00:06Z', sessionId: sid1, cwd: '/Users/test/foo', message: { content: [{ type: 'tool_use', name: 'Read', id: 't1', input: { file: 'auth.js' } }] } },
  { type: 'user', timestamp: '2026-05-01T10:00:07Z', sessionId: sid1, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file content here' }] } },
  { type: 'assistant', timestamp: '2026-05-01T10:00:10Z', sessionId: sid1, cwd: '/Users/test/foo', message: { content: [{ type: 'text', text: 'we decided to use bcrypt' }] } },
]
fs.mkdirSync(path.join(projectsDir, slug1), { recursive: true })
fs.writeFileSync(
  path.join(projectsDir, slug1, sid1 + '.jsonl'),
  session1.map((r) => JSON.stringify(r)).join('\n') + '\n'
)

const session2 = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-02T10:00:00Z', sessionId: sid2, content: 'in a worktree session' },
  { type: 'assistant', timestamp: '2026-05-02T10:00:01Z', sessionId: sid2, cwd: '/Users/test/bar/.claude/worktrees/feature-x', message: { content: [{ type: 'text', text: 'on it' }] } },
]
fs.mkdirSync(path.join(projectsDir, slug2), { recursive: true })
fs.writeFileSync(
  path.join(projectsDir, slug2, sid2 + '.jsonl'),
  session2.map((r) => JSON.stringify(r)).join('\n') + '\n'
)

// Empty dir (should not break)
fs.mkdirSync(path.join(projectsDir, '-Users-empty-project'), { recursive: true })

// Garbage line (should not crash)
fs.appendFileSync(path.join(projectsDir, slug1, sid1 + '.jsonl'), '{not valid json\n')

// --- import after HOME is set ---------------------------------------------
const walker = await import('../scripts/lib/transcript-walker.mjs')

// --- TAP harness -----------------------------------------------------------
let pass = 0, fail = 0
async function tap(name, fn) {
  try { await fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) { fail++; console.log(`not ok ${pass + fail} - ${name}\n  ${e.message}`); console.log(e.stack) }
}

await tap('listSlugs() returns all dirs sorted', () => {
  const slugs = walker.listSlugs()
  assert.deepEqual(slugs, [
    '-Users-empty-project',
    slug1,
    slug2,
  ].sort())
})

await tap('listSlugs({ excludeWorktrees }) drops worktree slugs', () => {
  const slugs = walker.listSlugs({ excludeWorktrees: true })
  assert.ok(slugs.includes(slug1))
  assert.ok(!slugs.includes(slug2), 'worktree slug should be excluded')
})

await tap('listSlugs({ slugFilter }) substring-matches', () => {
  const slugs = walker.listSlugs({ slugFilter: 'foo' })
  assert.deepEqual(slugs, [slug1])
})

await tap('listTranscripts() finds JSONLs across slugs', () => {
  const ts = walker.listTranscripts()
  assert.equal(ts.length, 2)
  const ids = ts.map((t) => t.sessionId).sort()
  assert.deepEqual(ids, [sid1, sid2].sort())
})

await tap('walkTranscripts yields normalized records and skips garbage lines', async () => {
  const recs = []
  for await (const r of walker.walkTranscripts()) recs.push(r)
  // Garbage line skipped, queue-op dequeue skipped
  // session1: enqueue(user) + attachment(meta) + asst-text + asst-tool_use + user-tool_result + asst-text = 6
  // session2: enqueue(user) + asst-text = 2
  assert.equal(recs.length, 8, `expected 8 records, got ${recs.length}`)
})

await tap('classify: enqueue → user, asst tool_use → tool_use, tool_result wrapper → tool_result', async () => {
  const recs = []
  for await (const r of walker.walkTranscripts({ slugFilter: 'foo' })) recs.push(r)
  assert.equal(recs[0].role, 'user')
  assert.equal(recs[0].text, 'hey can you fix the auth bug')
  const toolUse = recs.find((r) => r.role === 'tool_use')
  assert.ok(toolUse, 'expected a tool_use record')
  assert.equal(toolUse.toolName, 'Read')
  const toolResult = recs.find((r) => r.role === 'tool_result')
  assert.ok(toolResult, 'expected a tool_result record')
})

await tap('walkTranscripts honors slugFilter', async () => {
  const recs = []
  for await (const r of walker.walkTranscripts({ slugFilter: 'foo' })) recs.push(r)
  assert.ok(recs.every((r) => r.slug === slug1))
})

await tap('walkTranscripts honors excludeWorktrees', async () => {
  const recs = []
  for await (const r of walker.walkTranscripts({ excludeWorktrees: true })) recs.push(r)
  assert.ok(recs.every((r) => r.slug !== slug2))
})

await tap('walkTranscripts honors since filter', async () => {
  const recs = []
  for await (const r of walker.walkTranscripts({ since: '2026-05-02T00:00:00Z' })) recs.push(r)
  // Only session2's transcript should pass
  assert.ok(recs.every((r) => r.sessionId === sid2), 'since should drop older transcripts')
})

await tap('groupBySession buckets correctly', async () => {
  const grouped = await walker.groupBySession(walker.walkTranscripts())
  assert.equal(grouped.size, 2)
  assert.ok(grouped.get(sid1).length >= 5)
  assert.ok(grouped.get(sid2).length >= 2)
})

await tap('sessionSnapshot summarizes a session', async () => {
  const grouped = await walker.groupBySession(walker.walkTranscripts({ slugFilter: 'foo' }))
  const snap = walker.sessionSnapshot(grouped.get(sid1))
  assert.equal(snap.sessionId, sid1)
  assert.equal(snap.slug, slug1)
  assert.ok(snap.userMessages >= 1)
  assert.ok(snap.assistantMessages >= 2)
  assert.equal(snap.cwd, '/Users/test/foo')
})

// --- #226 regression: per-file fault tolerance under EACCES ---------------
// Issue #226: one unreadable .jsonl was aborting the entire walk. The fix
// wraps the per-file stream consumption in try/catch and continues.
// Determinism: monkey-patch fs.createReadStream to return a stream that
// emits 'error' on first read (mirrors real EACCES async-error path).
// Ordering: unreadable BEFORE readable to prove continue-after-error.

const { Readable } = await import('node:stream')
const slug3 = '-Users-test-projects-eacces-fixture'
const sidUnread = '33333333-3333-3333-3333-333333333333'
const sidRead = '44444444-4444-4444-4444-444444444444'
fs.mkdirSync(path.join(projectsDir, slug3), { recursive: true })

const unreadablePath = path.join(projectsDir, slug3, sidUnread + '.jsonl')
const readablePath = path.join(projectsDir, slug3, sidRead + '.jsonl')

const readableSession = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-03T10:00:00Z', sessionId: sidRead, content: 'readable record' },
  { type: 'assistant', timestamp: '2026-05-03T10:00:01Z', sessionId: sidRead, cwd: '/Users/test/eacces', message: { content: [{ type: 'text', text: 'continued past the unreadable file' }] } },
]
// File contents don't matter for unreadablePath because createReadStream is
// monkey-patched for it; but listTranscripts.statSync requires it to exist.
fs.writeFileSync(unreadablePath, 'this content is never read because createReadStream is mocked\n')
fs.writeFileSync(readablePath, readableSession.map((r) => JSON.stringify(r)).join('\n') + '\n')
// Enforce walk order: unreadable mtime < readable mtime (listTranscripts sorts ascending)
const earlier = new Date('2026-05-03T09:00:00Z')
const later = new Date('2026-05-03T11:00:00Z')
fs.utimesSync(unreadablePath, earlier, earlier)
fs.utimesSync(readablePath, later, later)

const brokenFiles = new Set()
const origCreateReadStream = fs.createReadStream
const origStderrWrite = process.stderr.write.bind(process.stderr)
let capturedStderr = ''

// try/finally guards against future top-level failures between patch and
// restore leaking the monkey-patches into the cleanup section or subsequent
// test runs (codex code-review FU-1 on cdec66f).
try {
  fs.createReadStream = function patchedCreateReadStream(file, opts) {
    if (brokenFiles.has(file)) {
      const err = Object.assign(new Error('mocked permission denied'), { code: 'EACCES' })
      return new Readable({
        read() { process.nextTick(() => this.destroy(err)) }
      })
    }
    return origCreateReadStream.call(fs, file, opts)
  }

  process.stderr.write = (chunk, ...rest) => {
    capturedStderr += typeof chunk === 'string' ? chunk : chunk.toString()
    return true
  }

  await tap('#226: walker continues past unreadable file (unreadable-first ordering)', async () => {
    brokenFiles.clear()
    brokenFiles.add(unreadablePath)
    capturedStderr = ''
    const recs = []
    for await (const r of walker.walkTranscripts({ slugFilter: 'eacces-fixture' })) recs.push(r)
    assert.ok(
      recs.some((r) => r.sessionId === sidRead),
      'expected at least one record from readable file after unreadable file was skipped'
    )
    assert.ok(
      !recs.some((r) => r.sessionId === sidUnread),
      'no records should be attributed to the unreadable file'
    )
    assert.match(
      capturedStderr,
      new RegExp(`transcript-walker: stopped reading ${unreadablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'stderr should warn about the stopped-reading unreadable file'
    )
    assert.match(capturedStderr, /EACCES/, 'stderr should include the error code')
  })

  await tap('#226: walker handles all-N-unreadable case (zero records, N warnings, no throw)', async () => {
    brokenFiles.clear()
    brokenFiles.add(unreadablePath)
    brokenFiles.add(readablePath)
    capturedStderr = ''
    const recs = []
    for await (const r of walker.walkTranscripts({ slugFilter: 'eacces-fixture' })) recs.push(r)
    assert.equal(recs.length, 0, 'expected zero records when all files in slug are unreadable')
    const warningLines = capturedStderr.split('\n').filter((l) => l.includes('transcript-walker: stopped reading'))
    assert.equal(warningLines.length, 2, `expected 2 stopped-reading warnings, got ${warningLines.length}: ${capturedStderr}`)
  })
} finally {
  fs.createReadStream = origCreateReadStream
  process.stderr.write = origStderrWrite
}

// --- cleanup ---------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
