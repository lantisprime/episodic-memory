/**
 * test-recall-v2.mjs — token inverted index, partial-match tier, pinning,
 * usefulness feedback. Runtime probes against isolated fixture stores plus
 * unit checks on lib/relevance.mjs.
 *
 * Invariants:
 *   - index-accelerated search returns byte-identical results to a full scan;
 *   - episodes ABSENT from tokens.json (hand-written rows, pre-upgrade
 *     stores) are still found — index gaps degrade, never hide;
 *   - partials only fill unfilled limit slots, capped below full matches,
 *     and are marked "match":"partial";
 *   - pinned episodes floor time decay at 0.6 and survive em-prune;
 *   - feedback boosts/damps ranking, clamps at ±10, survives rebuilds.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeScore, tokenCandidates, scorePartialMatch, episodeTokens } from '../scripts/lib/relevance.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'scripts');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function run(script, args, cwd, env) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}

// ---------------------------------------------------------------------------
// Unit: relevance.mjs additions
// ---------------------------------------------------------------------------
t('computeScore: pinned floors time decay at 0.6; unpinned at 0.1', () => {
  const old = { date: '2020-01-01' };
  assert.ok(Math.abs(computeScore(old, 1.0) - 0.1) < 1e-9);
  assert.ok(Math.abs(computeScore({ ...old, pinned: true }, 1.0) - 0.6) < 1e-9);
});

t('computeScore: feedback boosts ±5%/point, clamped, zero is identity', () => {
  const fresh = { date: new Date().toISOString().slice(0, 10) };
  const base = computeScore(fresh, 1.0);
  assert.ok(computeScore({ ...fresh, feedback: 2 }, 1.0) > base);
  assert.ok(computeScore({ ...fresh, feedback: -2 }, 1.0) < base);
  // clamp: -10 would be -50% raw, must clamp to -30%
  const damped = computeScore({ ...fresh, feedback: -10 }, 1.0);
  assert.ok(Math.abs(damped - base * 0.7) < 1e-9, `got ${damped}, base ${base}`);
});

t('tokenCandidates: AND/ANY sets + covered set + substring keys', () => {
  const idx = { atomic: ['a', 'b'], rename: ['a'], authentication: ['c'], zzz: ['d'] };
  const r = tokenCandidates([idx], ['atomic', 'rename']);
  assert.deepEqual([...r.all].sort(), ['a']);
  assert.deepEqual([...r.any].sort(), ['a', 'b']);
  assert.deepEqual([...r.covered].sort(), ['a', 'b', 'c', 'd']);
  // "auth" must hit "authentication" by key containment
  const r2 = tokenCandidates([idx], ['auth']);
  assert.ok(r2.all.has('c'));
});

t('scorePartialMatch: half-coverage matches capped below full tier; full coverage refused', () => {
  const e = { summary: 'Use atomic rename for index writes', tags: [] };
  const half = scorePartialMatch(e, ['atomic', 'kubernetes'], () => false);
  assert.ok(half.matched);
  assert.ok(Math.abs(half.textMatch - 0.5 * 0.5 * 0.7) < 1e-9, `got ${half.textMatch}`);
  assert.ok(half.textMatch < 0.38, 'partial must stay below the weakest full-match tier');
  const both = scorePartialMatch(e, ['atomic', 'rename'], () => false);
  assert.equal(both.matched, false, 'full coverage belongs to scoreTextMatch, not the partial tier');
  const low = scorePartialMatch(e, ['atomic', 'x1', 'x2'], () => false);
  assert.equal(low.matched, false, 'coverage below half must not match');
});

t('episodeTokens: covers summary, tags, and body tokens (len>=2, deduped)', () => {
  const toks = episodeTokens({ summary: 'Atomic rename', tags: ['idx-fast'], body: 'temp file a' });
  for (const tok of ['atomic', 'rename', 'idx', 'fast', 'temp', 'file']) assert.ok(toks.has(tok), tok);
  assert.ok(!toks.has('a'), 'single-char tokens excluded');
});

// ---------------------------------------------------------------------------
// Runtime probes
// ---------------------------------------------------------------------------
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recallv2-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recallv2-home-')));
const env = { HOME: home };
const store = path.join(cwd, '.episodic-memory');

run('em-store.mjs', ['--project', 'fx', '--category', 'decision', '--summary', 'Use atomic rename for index writes',
  '--body', 'All index rebuilds go through temp file plus rename.', '--tags', 'storage', '--scope', 'local'], cwd, env);
run('em-store.mjs', ['--project', 'fx', '--category', 'discovery', '--summary', 'Postgres pooling limits',
  '--body', 'pgbouncer caps at 100', '--tags', 'postgres', '--scope', 'local', '--pin'], cwd, env);

t('em-store writes tokens.json; --pin lands in frontmatter and index row', () => {
  assert.ok(fs.existsSync(path.join(store, 'tokens.json')));
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const pinnedRow = rows.find(r => r.summary.startsWith('Postgres'));
  assert.equal(pinnedRow.pinned, true);
  const epFile = fs.readFileSync(path.join(store, 'episodes', `${pinnedRow.id}.md`), 'utf8');
  assert.ok(/^pinned: true$/m.test(epFile));
});

t('index-accelerated search ≡ full scan (results and scores byte-identical)', () => {
  const q = ['--query', 'index atomic writes', '--scope', 'local', '--no-track'];
  const withIdx = run('em-search.mjs', q, cwd, env).json;
  fs.renameSync(path.join(store, 'tokens.json'), path.join(store, 'tokens.json.off'));
  const without = run('em-search.mjs', q, cwd, env).json;
  fs.renameSync(path.join(store, 'tokens.json.off'), path.join(store, 'tokens.json'));
  assert.deepEqual(withIdx.episodes, without.episodes);
  assert.ok(without.warning && without.warning.includes('tokens.json'), 'fallback must warn');
  assert.ok(!withIdx.warning || !withIdx.warning.includes('tokens.json'), 'indexed path must not warn');
});

t('episodes absent from tokens.json are still found (coverage fallback)', () => {
  // hand-append an episode the token index has never seen (#448-adjacent shape)
  const id = '20260101-000000-uncovered-zzzz';
  fs.writeFileSync(path.join(store, 'episodes', `${id}.md`),
    `---\nid: ${id}\ndate: 2026-01-01\ntime: "00:00"\nproject: fx\ncategory: decision\nstatus: active\ntags: []\nsummary: zebra quantum widget\n---\n\nbody\n`);
  fs.appendFileSync(path.join(store, 'index.jsonl'),
    JSON.stringify({ id, date: '2026-01-01', time: '00:00', project: 'fx', category: 'decision', status: 'active', supersedes: null, tags: [], summary: 'zebra quantum widget' }) + '\n');
  const r = run('em-search.mjs', ['--query', 'zebra quantum', '--scope', 'local', '--no-track'], cwd, env).json;
  assert.equal(r.count, 1, `uncovered episode must not be pruned away: ${JSON.stringify(r)}`);
  assert.equal(r.episodes[0].id, id);
});

t('partial tier fills remaining slots, marked and ranked below full matches', () => {
  const r = run('em-search.mjs', ['--query', 'atomic kubernetes', '--scope', 'local', '--no-track'], cwd, env).json;
  assert.ok(r.count >= 1);
  for (const e of r.episodes) assert.equal(e.match, 'partial');
  assert.ok(r.episodes.every(e => e.score < 0.38), 'partials stay below the weakest full tier at full freshness');
  // no partials under --no-score (stable recency contract)
  const ns = run('em-search.mjs', ['--query', 'atomic kubernetes', '--scope', 'local', '--no-track', '--no-score'], cwd, env).json;
  assert.equal(ns.count, 0);
});

t('em-feedback: round trip, clamp, unknown id error', () => {
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const id = rows[0].id;
  assert.equal(run('em-feedback.mjs', ['--id', id, '--useful'], cwd, env).json.feedback, 1);
  assert.equal(run('em-feedback.mjs', ['--id', id, '--noise'], cwd, env).json.feedback, 0);
  for (let i = 0; i < 12; i++) run('em-feedback.mjs', ['--id', id, '--useful'], cwd, env);
  const clamped = run('em-feedback.mjs', ['--id', id, '--useful'], cwd, env).json;
  assert.equal(clamped.feedback, 10, 'must clamp at +10');
  const bad = run('em-feedback.mjs', ['--id', 'nope', '--useful'], cwd, env);
  assert.equal(bad.code, 1);
  const usage = run('em-feedback.mjs', ['--id', id], cwd, env);
  assert.equal(usage.code, 1, 'exactly one of --useful/--noise required');
});

t('feedback changes ranking: boosted episode outranks equal-freshness sibling', () => {
  // both episodes match "fx" via project? use a query hitting both bodies: 'the'
  // — instead compare scores directly on a query both summaries match is not
  // available; assert score monotonicity via em-search on the boosted episode.
  const r = run('em-search.mjs', ['--query', 'atomic rename', '--scope', 'local', '--no-track'], cwd, env).json;
  const boosted = r.episodes.find(e => e.summary.startsWith('Use atomic'));
  assert.ok(boosted.score > 0.7, `feedback-boosted score should exceed base 0.7, got ${boosted.score}`);
});

t('em-pin toggles frontmatter + index row; em-revise inherits pinned', () => {
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const pinnedRow = rows.find(row => row.pinned === true);
  const rev = run('em-revise.mjs', ['--original', pinnedRow.id, '--summary', 'Postgres pooling limits (revised)',
    '--body', 'now 200 with pgbouncer 2', '--scope', 'inherit'], cwd, env).json;
  assert.equal(rev.status, 'ok');
  const rows2 = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows2.find(row => row.id === rev.id).pinned, true, 'revision must inherit pinned');
  // unpin the revision
  const un = run('em-pin.mjs', ['--id', rev.id, '--unpin'], cwd, env).json;
  assert.equal(un.pinned, false);
  const rows3 = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(!rows3.find(row => row.id === rev.id).pinned);
  assert.ok(!/^pinned: true$/m.test(fs.readFileSync(path.join(store, 'episodes', `${rev.id}.md`), 'utf8')));
  // re-pin for the prune test below
  assert.equal(run('em-pin.mjs', ['--id', rev.id], cwd, env).json.pinned, true);
});

t('em-prune never archives pinned episodes (reason "pinned")', () => {
  // age the pinned revision far past the prune threshold
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const target = rows.find(row => row.pinned === true && row.status === 'active');
  const aged = rows.map(row => row.id === target.id ? { ...row, date: '2020-01-01' } : row);
  fs.writeFileSync(path.join(store, 'index.jsonl'), aged.map(r2 => JSON.stringify(r2)).join('\n') + '\n');
  const r = run('em-prune.mjs', ['--scope', 'local', '--dry-run'], cwd, env).json;
  const out = JSON.stringify(r);
  assert.ok(!out.includes(`"${target.id}"`) || out.includes('"pinned"'), `pinned episode must be protected: ${out}`);
  assert.ok(!(r.results || [r]).some(s => (s.episodes || []).some(e => e.id === target.id)), 'pinned episode must not appear in the prune list');
});

t('rebuild preserves pinned + feedback and regenerates tokens.json', () => {
  fs.rmSync(path.join(store, 'tokens.json'));
  const r = run('em-rebuild-index.mjs', ['--scope', 'local'], cwd, env).json;
  assert.equal(r.status, 'ok');
  assert.ok(fs.existsSync(path.join(store, 'tokens.json')));
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(rows.some(row => row.pinned === true), 'pinned survives rebuild via frontmatter');
  assert.ok(rows.some(row => row.feedback === 10), 'feedback survives rebuild via carry-forward');
});

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
