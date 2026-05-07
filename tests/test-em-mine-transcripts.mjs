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

tap('dedupe does NOT over-suppress shared-prefix candidates (Codex F3)', () => {
  // Build an isolated tmp HOME with:
  //   - existing index entry: a 90-char summary starting with a common
  //     boilerplate prefix
  //   - transcript: a NEW candidate that shares the first 60 chars but has
  //     a divergent tail (different decision content)
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mine-f3-'))
  const pd2 = path.join(TMP2, '.claude', 'projects', '-Users-test-zoo')
  const md2 = path.join(TMP2, '.episodic-memory')
  fs.mkdirSync(pd2, { recursive: true })
  fs.mkdirSync(md2, { recursive: true })
  const sid = '99999999-aaaa-aaaa-aaaa-999999999999'
  // Existing entry — first 60 chars are a common boilerplate.
  const boilerplate = 'codex review request for pr-NNN of the foo project '
  const existing = boilerplate + 'with focus on cwd-binding axis and same-class completeness'
  fs.writeFileSync(path.join(md2, 'index.jsonl'),
    JSON.stringify({ id: 'e1', date: '2099-01-01', time: '09:00', project: 'x', category: 'context', status: 'active', summary: existing }) + '\n')
  // New candidate — same first 60 chars but a substantively different tail.
  // The whole sentence must contain the trigger phrase to be picked up.
  const newSalient = boilerplate + "we decided to ship without staging because the dedupe gate is the bottleneck"
  const recs = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2099-06-01T10:00:00Z', sessionId: sid, content: newSalient },
  ]
  fs.writeFileSync(path.join(pd2, sid + '.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const out = execFileSync('node', [SCRIPT,
    '--since', '2099-01-01T00:00:00Z', '--slug', 'test-zoo', '--dry-run',
  ], { encoding: 'utf8', env: { ...process.env, HOME: TMP2 }, cwd: TMP2 })
  const status = JSON.parse(out.slice(out.indexOf('{\n  "status"')))
  // With the bug: dedupe matches first 60 chars and suppresses -> 0 candidates.
  // With the fix: full-phrase bidirectional check -> tail differs -> 1 candidate.
  assert.equal(status.candidates, 1, `expected 1 candidate (divergent tail); got ${status.candidates}`)
  fs.rmSync(TMP2, { recursive: true, force: true })
})

tap('generated em-store command is shell-safe for transcript metacharacters (Codex F2)', () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mine-f2-'))
  const pd2 = path.join(TMP2, '.claude', 'projects', '-Users-test-zoo')
  fs.mkdirSync(pd2, { recursive: true })
  const sid = 'cccccccc-dddd-eeee-ffff-000000000000'
  // Transcript salient containing $(..), backticks, $VAR, backslash, single-quote
  const evilTail = "we decided to run $(rm -rf /) and `whoami` with $HOME and \\backslash and 'quote'"
  const recs = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2099-06-01T10:00:00Z', sessionId: sid, content: evilTail },
  ]
  fs.writeFileSync(path.join(pd2, sid + '.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const out = execFileSync('node', [SCRIPT,
    '--since', '2099-01-01T00:00:00Z', '--slug', 'test-zoo', '--dry-run',
  ], { encoding: 'utf8', env: { ...process.env, HOME: TMP2 }, cwd: TMP2 })

  // Find the suggested em-store command line in the markdown body
  const m = out.match(/node scripts\/em-store\.mjs[^\n]*/)
  assert.ok(m, 'expected an em-store command in the markdown body')
  const cmd = m[0]
  // Metacharacters must NOT appear unquoted
  assert.ok(!/\$\(/.test(cmd.replace(/'[^']*'/g, '')),
    `unquoted $( found in: ${cmd}`)
  assert.ok(!/`/.test(cmd.replace(/'[^']*'/g, '')),
    `unquoted backtick found in: ${cmd}`)
  // The single-quote in the salient must be encoded as '\''
  assert.ok(/'\\''/.test(cmd), `single-quote not encoded as '\\'' in: ${cmd}`)
  // sh -n parse-check: the command must be syntactically valid shell.
  // Use bash -n if available, fall back to sh -n.
  try {
    execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' })
  } catch (e) {
    throw new Error(`generated command is not shell-parseable: ${e.stderr || e.message}\nCMD: ${cmd}`)
  }
  fs.rmSync(TMP2, { recursive: true, force: true })
})

tap('generated em-store command strips NUL + control bytes (Codex F5 round 2)', () => {
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mine-f5-'))
  const pd2 = path.join(TMP2, '.claude', 'projects', '-Users-test-zoo')
  fs.mkdirSync(pd2, { recursive: true })
  const sid = 'eeeeffff-1111-2222-3333-444444444444'
  // Salient containing NUL (
  // Whitespace controls \t \n \r are preserved (extractText already collapses
  // some of them but the dedupe key keeps them).
  const evilTail = `we decided to add ${String.fromCharCode(0)} NUL and ${String.fromCharCode(7)} bell and ${String.fromCharCode(8)} bs and ${String.fromCharCode(0x7f)} DEL to the salient`
  const recs = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2099-06-01T10:00:00Z', sessionId: sid, content: evilTail },
  ]
  fs.writeFileSync(path.join(pd2, sid + '.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const out = execFileSync('node', [SCRIPT,
    '--since', '2099-01-01T00:00:00Z', '--slug', 'test-zoo', '--dry-run',
  ], { encoding: 'utf8', env: { ...process.env, HOME: TMP2 }, cwd: TMP2 })
  const m = out.match(/node scripts\/em-store\.mjs[^\n]*/)
  assert.ok(m, 'expected an em-store command in the markdown body')
  const cmd = m[0]
  // No control bytes survive
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(cmd),
    `control byte leaked into generated command`)
  // bash -n still parses
  execFileSync('bash', ['-n', '-c', cmd], { stdio: 'pipe' })
  fs.rmSync(TMP2, { recursive: true, force: true })
})

tap('dedupe DOES suppress true duplicates after normalization', () => {
  // Existing summary and candidate identical except for whitespace + casing.
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mine-f3-dup-'))
  const pd2 = path.join(TMP2, '.claude', 'projects', '-Users-test-zoo')
  const md2 = path.join(TMP2, '.episodic-memory')
  fs.mkdirSync(pd2, { recursive: true })
  fs.mkdirSync(md2, { recursive: true })
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const text = "we decided to use the existing weekly digest task instead of a new one"
  fs.writeFileSync(path.join(md2, 'index.jsonl'),
    JSON.stringify({ id: 'd1', date: '2099-01-01', time: '09:00', project: 'x', category: 'decision', status: 'active', summary: text }) + '\n')
  // Candidate has extra whitespace + uppercase
  const recs = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2099-06-01T10:00:00Z', sessionId: sid, content: '  WE DECIDED  TO  USE the existing weekly digest task instead of a new one' },
  ]
  fs.writeFileSync(path.join(pd2, sid + '.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const out = execFileSync('node', [SCRIPT,
    '--since', '2099-01-01T00:00:00Z', '--slug', 'test-zoo', '--dry-run',
  ], { encoding: 'utf8', env: { ...process.env, HOME: TMP2 }, cwd: TMP2 })
  const status = JSON.parse(out.slice(out.indexOf('{\n  "status"')))
  assert.equal(status.candidates, 0, `expected 0 (true duplicate suppressed); got ${status.candidates}`)
  fs.rmSync(TMP2, { recursive: true, force: true })
})

// --- cleanup ---------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
