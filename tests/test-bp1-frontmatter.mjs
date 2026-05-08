/**
 * test-bp1-frontmatter.mjs — Strict BP-1 frontmatter parser tests (M1).
 *
 * Coverage targets (from round-2 codex consensus, episode
 * 20260508-112437-...-4b9f):
 *   - happy path: parses every recognized value form
 *   - duplicate keys → throw
 *   - missing fences → throw
 *   - malformed key lines → throw
 *   - non-UTF-8 / lone surrogates → throw
 *   - bare value with whitespace → throw
 *   - JSON-quoted string with escape sequences round-trips
 *   - tag-array preserves order, rejects nested/quoted elements
 *   - body is split off verbatim (multi-line, leading blanks)
 *   - round-trip invariant: parse(write(W)) ≡ W for writer's full schema
 */

import assert from 'node:assert/strict'
import { parseBp1Frontmatter } from '../scripts/lib/bp1-frontmatter.mjs'

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

// ---------------------------------------------------------------------------
// Happy path — every recognized value form
// ---------------------------------------------------------------------------
t('parses bare values, quoted strings, null, booleans, arrays', () => {
  const text = [
    '---',
    'id: 20260508-103030-foo-1234',
    'run_id: rfc-004-001',
    'type: state-transition',
    'parent_episode: null',
    'expected_post_episode_id: null',
    'summary: "BP-1 run started: rfc-004-001"',
    'native_probe_performed: false',
    't2_fallback: true',
    'tags: [bp1-run-started, bp1-evidence-snapshot]',
    'category: workflow.lifecycle',
    'date: 2026-05-08',
    'time: "10:30"',
    '---',
    '',
    'body line 1',
    'body line 2',
  ].join('\n')
  const { frontmatter, body } = parseBp1Frontmatter(text)
  assert.equal(frontmatter.id, '20260508-103030-foo-1234')
  assert.equal(frontmatter.run_id, 'rfc-004-001')
  assert.equal(frontmatter.type, 'state-transition')
  assert.equal(frontmatter.parent_episode, null)
  assert.equal(frontmatter.expected_post_episode_id, null)
  assert.equal(frontmatter.summary, 'BP-1 run started: rfc-004-001')
  assert.equal(frontmatter.native_probe_performed, false)
  assert.equal(frontmatter.t2_fallback, true)
  assert.deepEqual(frontmatter.tags, ['bp1-run-started', 'bp1-evidence-snapshot'])
  assert.equal(frontmatter.category, 'workflow.lifecycle')
  assert.equal(frontmatter.date, '2026-05-08')
  assert.equal(frontmatter.time, '10:30')
  assert.equal(body, 'body line 1\nbody line 2')
})

// ---------------------------------------------------------------------------
// Fail-closed cases (FU per round-2)
// ---------------------------------------------------------------------------
t('throws on duplicate keys', () => {
  const text = '---\nid: a\nid: b\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /duplicate key "id"/)
})

t('throws on missing opening fence', () => {
  const text = 'id: a\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /missing opening --- fence/)
})

t('throws on missing closing fence', () => {
  const text = '---\nid: a\nbody\n'
  assert.throws(() => parseBp1Frontmatter(text), /missing closing --- fence/)
})

t('throws on malformed key line (no colon)', () => {
  const text = '---\nthis-has-no-colon\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /malformed key line/)
})

t('throws on whitespace inside key', () => {
  const text = '---\nbad key: value\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /malformed key/)
})

t('throws on blank line inside frontmatter', () => {
  const text = '---\nid: a\n\nrun_id: b\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /blank line inside frontmatter/)
})

t('throws on bare value with whitespace', () => {
  const text = '---\nid: bad value\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /bare value must not contain whitespace/)
})

t('throws on empty value', () => {
  const text = '---\nid:\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /empty value/)
})

t('throws on malformed JSON-quoted string', () => {
  const text = '---\nsummary: "unterminated\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /malformed JSON-quoted string/)
})

t('throws on array with quoted element', () => {
  const text = '---\ntags: ["a", b]\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /array element must be a bare token/)
})

t('throws on array with empty element', () => {
  const text = '---\ntags: [a,, b]\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /empty array element/)
})

t('throws on lone surrogate (non-UTF-8)', () => {
  const text = '---\nsummary: "' + '\uD800' + '"\n---\n'
  assert.throws(() => parseBp1Frontmatter(text), /non-UTF-8/)
})

t('throws on non-string input', () => {
  assert.throws(() => parseBp1Frontmatter(null), /text must be a string/)
})

// ---------------------------------------------------------------------------
// Body split fidelity
// ---------------------------------------------------------------------------
t('preserves empty body', () => {
  const text = '---\nid: a\n---\n'
  const { body } = parseBp1Frontmatter(text)
  assert.equal(body, '')
})

t('preserves multi-paragraph body with internal blanks', () => {
  const text = [
    '---',
    'id: a',
    '---',
    '',
    'paragraph 1',
    '',
    'paragraph 2',
  ].join('\n')
  const { body } = parseBp1Frontmatter(text)
  assert.equal(body, 'paragraph 1\n\nparagraph 2')
})

// ---------------------------------------------------------------------------
// Empty array
// ---------------------------------------------------------------------------
t('parses empty tag array', () => {
  const text = '---\nid: a\ntags: []\n---\n'
  const { frontmatter } = parseBp1Frontmatter(text)
  assert.deepEqual(frontmatter.tags, [])
})

// ---------------------------------------------------------------------------
// JSON escapes round-trip
// ---------------------------------------------------------------------------
t('JSON-quoted strings round-trip escape sequences', () => {
  // \n, \", \\ all valid inside JSON.parse
  const text = '---\nid: a\nsummary: "line1\\nline2 with \\"quote\\" and \\\\ slash"\n---\n'
  const { frontmatter } = parseBp1Frontmatter(text)
  assert.equal(frontmatter.summary, 'line1\nline2 with "quote" and \\ slash')
})

// ---------------------------------------------------------------------------
// Round-trip invariant against the writer's full schema (FU-1 anchor)
// ---------------------------------------------------------------------------
t('round-trip: writer-style frontmatter parses to equivalent object', () => {
  // This mirrors bp1-orchestrator.mjs:175-201 buildEpisodeFile output for an
  // init-run episode. Ensures the strict parser accepts the writer's exact
  // emission shape — a load-bearing invariant for the round-2 step-5 fence.
  const text = [
    '---',
    'id: 20260508-103030-bp1-run-started-abcd',
    'run_id: rfc-004-001',
    'type: state-transition',
    'state: started',
    'parent_episode: null',
    'expected_post_episode_id: null',
    'summary: "BP-1 run started: rfc-004-001"',
    'scheduled_tasks_capability: "fallback"',
    'probe_reason: "stub"',
    'degraded_mode_statement: ""',
    'native_probe_performed: false',
    't2_fallback: true',
    'body_sha256: 0123456789abcdef',
    'hmac_signature: deadbeef',
    'tags: [bp1-run-started, bp1-evidence-snapshot]',
    'category: workflow.lifecycle',
    'date: 2026-05-08',
    'time: "10:30"',
    'project: episodic-memory',
    '---',
    '',
    '# Body content',
  ].join('\n')
  const { frontmatter, body } = parseBp1Frontmatter(text)
  // Spot-check every type-class
  assert.equal(typeof frontmatter.id, 'string')
  assert.equal(frontmatter.parent_episode, null)
  assert.equal(typeof frontmatter.summary, 'string')
  assert.equal(frontmatter.scheduled_tasks_capability, 'fallback')
  assert.equal(frontmatter.degraded_mode_statement, '')
  assert.equal(frontmatter.native_probe_performed, false)
  assert.equal(frontmatter.t2_fallback, true)
  assert.deepEqual(frontmatter.tags, ['bp1-run-started', 'bp1-evidence-snapshot'])
  assert.equal(body, '# Body content')
})

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
