#!/usr/bin/env node
/**
 * test-em-mine-transcripts.mjs — integration test for em-mine-transcripts.mjs.
 *
 * Builds a temp $HOME with:
 *   - ~/.claude/projects/<slug>/<sid>.jsonl   (fixture transcripts)
 *   - ~/.episodic-memory/index.jsonl          (fixture dedupe corpus)
 * Runs the mining script and asserts:
 *   - trigger hits are found
 *   - already-captured candidates are deduped
 *   - output JSON is well-formed
 *   - markdown output is written when --dry-run is omitted
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'em-mine-transcripts.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mine-test-'))

const projectsDir = path.join(TMP, '.claude', 'projects')
const memDir = path.join(TMP, '.episodic-memory')
fs.mkdirSync(path.join(projectsDir, '-Users-test-foo'), { recursive: true })
fs.mkdirSync(path.join(memDir, 'episodes'), { recursive: true })

const sid = '11111111-aaaa-aaaa-aaaa-111111111111'

// Fixture transcript: includes a NEW decision, a NEW lesson, a NEW violation,
// and a duplicate of an already-stored decision.
const records = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2099-01-01T10:00:00Z', sessionId: sid, content: 'we decided to switch to bcrypt for password hashing this morning' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2099-01-01T10:00:01Z', sessionId: sid },
  { type: 'assistant', timestamp: '2099-01-01T10:00:05Z', sessionId: sid, cwd: '/Users/test/foo', message: { content: [{ type: 'text', text: 'lesson: never run git push --force on main' }] } },
  { type: 'assistant', timestamp: '2099-01-01T10:00:10Z', sessionId: sid, cwd: '/Users/test/foo', message: { content: [{ type: 'text', text: 'okay you skipped the plan-gate again, bp-001 violation' }] } },
  // Duplicate of an existing index entry — should dedupe out
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2099-01-01T10:00:20Z', sessionId: sid, content: 'we decided to use the existing weekly digest task instead of a new one' },
  // Quiet message with no triggers
  { type: 'assistant', timestamp: '2099-01-01T10:00:30Z', sessionId: sid, cwd: '/Users/test/foo', message: { content: [{ type: 'text', text: 'looking at the file now, will report back' }] } },
]
fs.writeFileSync(
  path.join(projectsDir, '-Users-test-foo', sid + '.jsonl'),
  records.map((r) => JSON.stringify(r)).join('\n') + '\n'
)

// Fixture index: pretend the duplicate decision was already stored
const idx = [
  { id: 'fake-1', date: '2099-01-01', time: '09:00', project: 'episodic-memory', category: 'decision', status: 'active', tags: ['process'], summary: 'we decided to use the existing weekly digest task instead of a new one' },
  { id: 'fake-2', date: '2099-01-01', time: '09:00', project: 'global', category: 'context', status: 'active', tags: [], summary: 'unrelated entry' },
]
fs.writeFileSync(path.join(memDir, 'index.jsonl'), idx.map((r) => JSON.stringify(r)).join('\n') + '\n')

// --- TAP harness -----------------------------------------------------------
let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) { fail++; console.log(`not ok ${pass + fail} - ${name}\n  ${e.message}`); console.log(e.stack) }
}

function runScript(args) {
  return execFileSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: TMP },
    cwd: TMP,
  })
}

tap('--dry-run mines candidates and dedupes existing ones', () => {
  // Use a since covering the future-dated fixtures; default 7d ago would miss them
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--dry-run', '--slug', 'test-foo'])
  // Last block is the JSON status
  const jsonStart = out.lastIndexOf('{\n  "status"')
  assert.ok(jsonStart >= 0, 'expected JSON status block')
  const status = JSON.parse(out.slice(jsonStart))
  assert.equal(status.status, 'ok')
  // We expect 3 candidates: the new decision, the lesson, the violation.
  // The duplicate decision should be deduped.
  assert.equal(status.candidates, 3, `expected 3 candidates, got ${status.candidates}\n${out}`)
  // Markdown body should mention each category
  assert.ok(out.includes('decision'), 'markdown should include decision candidate')
  assert.ok(out.includes('lesson'), 'markdown should include lesson candidate')
  assert.ok(out.includes('violation'), 'markdown should include violation candidate')
})

tap('writes markdown to default output when --dry-run omitted', () => {
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--slug', 'test-foo', '--output', path.join(TMP, 'out.md')])
  const status = JSON.parse(out.slice(out.indexOf('{\n  "status"')))
  assert.equal(status.dryRun, false)
  assert.equal(status.output, path.join(TMP, 'out.md'))
  assert.ok(fs.existsSync(path.join(TMP, 'out.md')))
  const md = fs.readFileSync(path.join(TMP, 'out.md'), 'utf8')
  assert.ok(md.includes('# Mining candidates'))
  assert.ok(md.includes('Candidate 1'))
})

tap('honors --slug filter (no candidates when slug missing)', () => {
  const out = runScript(['--since', '2099-01-01T00:00:00Z', '--slug', 'nonexistent', '--dry-run'])
  const status = JSON.parse(out.slice(out.indexOf('{\n  "status"')))
  assert.equal(status.candidates, 0)
})

tap('honors --since filter (older window yields nothing)', () => {
  const out = runScript(['--since', '2098-01-01T00:00:00Z', '--slug', 'test-foo', '--dry-run'])
  // Records ARE within this window (2099 > 2098) so this should still match
  const status = JSON.parse(out.slice(out.indexOf('{\n  "status"')))
  assert.ok(status.candidates >= 1)
})

tap('--since after all records yields zero', () => {
  const out = runScript(['--since', '2099-12-31T00:00:00Z', '--slug', 'test-foo', '--dry-run'])
  const status = JSON.parse(out.slice(out.indexOf('{\n  "status"')))
  assert.equal(status.candidates, 0)
})

// --- cleanup ---------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
