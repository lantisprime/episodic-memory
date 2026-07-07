/**
 * test-relevance.mjs — lib/relevance.mjs unit tests + em-search/em-recall
 * runtime probes for the tokenized multi-term matcher.
 *
 * Back-compat invariants (must match pre-lib behavior byte-for-byte):
 *   exact summary → 1.0, summary substring → 0.7, body substring → 0.4.
 * New capability: multi-term queries match when EVERY token lands in
 * summary/tags/body, scored 0.95 × avg(field weights) — always below a
 * contiguous summary substring match.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenizeQuery, scoreTextMatch, normalizeTags, computeScore } from '../scripts/lib/relevance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
const EM_SEARCH = path.join(REPO, 'scripts/em-search.mjs');
const EM_RECALL = path.join(REPO, 'scripts/em-recall.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Unit: tokenizeQuery
// ---------------------------------------------------------------------------
t('tokenize splits on non-alphanumerics, lowercases, dedupes, keeps len>=2', () => {
  assert.deepEqual(tokenizeQuery('Auth token-refresh AUTH x'), ['auth', 'token', 'refresh']);
  assert.deepEqual(tokenizeQuery(''), []);
  assert.deepEqual(tokenizeQuery('a b c'), []);
});

// ---------------------------------------------------------------------------
// Unit: scoreTextMatch tiers
// ---------------------------------------------------------------------------
const entry = { summary: 'Use atomic rename for index writes', tags: ['storage', 'index'] };
const body = () => 'All index rebuilds go through a temp file plus rename step.';

t('exact summary match → 1.0', () => {
  const r = scoreTextMatch(entry, 'Use atomic rename for index writes', body);
  assert.equal(r.matched, true);
  assert.equal(r.textMatch, 1.0);
});

t('summary substring → 0.7', () => {
  const r = scoreTextMatch(entry, 'atomic rename', body);
  assert.equal(r.textMatch, 0.7);
});

t('body substring → 0.4', () => {
  // tokens chosen so none appear in summary/tags — body tier decides alone
  const r = scoreTextMatch(entry, 'temp file plus', body);
  assert.equal(r.textMatch, 0.4);
});

t('mixed-field tokens beat plain body substring (max-of-tiers)', () => {
  // "rename" resolves from summary (0.7), temp/file from body (0.4):
  // 0.95 × avg(0.7,0.4,0.4) > 0.4 body tier
  const r = scoreTextMatch(entry, 'temp file rename', body);
  assert.ok(r.textMatch > 0.4, `got ${r.textMatch}`);
});

t('scattered tokens all in summary → 0.95 × 0.7 = 0.665', () => {
  const r = scoreTextMatch(entry, 'index atomic writes', body);
  assert.equal(r.matched, true);
  assert.ok(Math.abs(r.textMatch - 0.665) < 1e-9, `got ${r.textMatch}`);
});

t('token match never outranks contiguous summary substring', () => {
  const contiguous = scoreTextMatch(entry, 'atomic rename', body).textMatch;
  const scattered = scoreTextMatch(entry, 'rename atomic index writes', body).textMatch;
  assert.ok(scattered < contiguous, `${scattered} !< ${contiguous}`);
});

t('AND semantics: one unmatched token → no match', () => {
  const r = scoreTextMatch(entry, 'atomic kubernetes', body);
  assert.equal(r.matched, false);
});

t('tokens can resolve from tags (weight 0.6)', () => {
  const e2 = { summary: 'Middleware ordering', tags: ['storage'] };
  const r = scoreTextMatch(e2, 'storage middleware', () => null);
  assert.equal(r.matched, true);
  // avg(0.6 tags, 0.7 summary) × 0.95
  assert.ok(Math.abs(r.textMatch - 0.95 * 0.65) < 1e-9, `got ${r.textMatch}`);
});

t('body loads lazily: summary-substring path never reads the body', () => {
  let reads = 0;
  const spyBody = () => { reads++; return 'body'; };
  scoreTextMatch(entry, 'atomic rename', spyBody);
  assert.equal(reads, 0);
  scoreTextMatch(entry, 'temp file', spyBody);
  assert.equal(reads, 1);
});

t('null readBody restricts matching to index fields without crashing', () => {
  const r = scoreTextMatch(entry, 'temp file plus rename', null);
  assert.equal(r.matched, false);
});

t('normalizeTags dedupes/sorts; computeScore floors time decay at 0.1', () => {
  assert.deepEqual(normalizeTags('B, a ,b'), ['a', 'b']);
  const old = { date: '2020-01-01', access_count: 0 };
  const s = computeScore(old, 1.0);
  assert.ok(Math.abs(s - 0.1) < 1e-9, `got ${s}`);
});

// ---------------------------------------------------------------------------
// Runtime probes: real scripts against an isolated fixture store
// ---------------------------------------------------------------------------
function run(script, args, cwd, env) {
  const r = spawnSync('node', [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-')));
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-home-')));
const env = { HOME: fakeHome };

run(EM_STORE, ['--project', 'fx', '--category', 'decision', '--summary', 'Use atomic rename for index writes',
  '--body', 'All index rebuilds go through temp file plus rename.', '--tags', 'storage,index', '--scope', 'local'], cwd, env);
run(EM_STORE, ['--project', 'fx', '--category', 'lesson', '--summary', 'Middleware ordering matters',
  '--body', 'The atomic write rename pattern also applies here.', '--tags', 'auth', '--scope', 'local'], cwd, env);
run(EM_STORE, ['--project', 'other', '--category', 'discovery', '--summary', 'Widget relevance heuristics',
  '--body', 'unrelated', '--tags', 'misc', '--scope', 'local'], cwd, env);

t('em-search: substring query behaves as before (score 0.7)', () => {
  const r = run(EM_SEARCH, ['--query', 'atomic rename', '--scope', 'local', '--no-track'], cwd, env);
  const hit = r.json.episodes.find(e => e.summary.startsWith('Use atomic'));
  assert.ok(hit, 'summary-substring episode must match');
  assert.equal(hit.score, 0.7);
});

t('em-search: scattered multi-term query now matches (new capability)', () => {
  const r = run(EM_SEARCH, ['--query', 'index atomic writes', '--scope', 'local', '--no-track'], cwd, env);
  assert.equal(r.json.count, 1);
  assert.equal(r.json.episodes[0].score, 0.665);
});

t('em-search: body substring still matches at 0.4', () => {
  const r = run(EM_SEARCH, ['--query', 'write rename pattern', '--scope', 'local', '--no-track'], cwd, env);
  const hit = r.json.episodes.find(e => e.summary.startsWith('Middleware'));
  assert.ok(hit);
  assert.equal(hit.score, 0.4);
});

t('em-search: unmatched query returns empty', () => {
  const r = run(EM_SEARCH, ['--query', 'kubernetes', '--scope', 'local', '--no-track'], cwd, env);
  assert.equal(r.json.count, 0);
});

t('em-recall: pass 2b surfaces cross-project episodes via summary tokens', () => {
  // package.json keyword "widget" (≥4 chars, not a stopword) becomes an
  // effective token; the "other"-project episode has no matching tag but
  // mentions widget in its SUMMARY → reachable only through pass 2b.
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fx', keywords: ['widget'] }));
  const r = run(EM_RECALL, ['--scope', 'local', '--no-track', '--days', '0', '--limit', '10'], cwd, env);
  const other = r.json.episodes.find(e => e.project === 'other');
  assert.ok(other, `cross-project summary-token episode missing: ${JSON.stringify(r.json.episodes.map(e => e.summary))}`);
  assert.equal(other.score, 0.6);
});

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
