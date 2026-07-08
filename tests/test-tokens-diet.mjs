/**
 * test-tokens-diet.mjs — S2 tokens.json df diet.
 *
 * Rigor contract (behavior-simulated on isolated fixture stores):
 *   - em-rebuild-index drops posting lists for tokens whose df exceeds 40% of
 *     the corpus and records them (sorted) under "_dropped";
 *   - correctness gate: em-search full matches and ANCHORED partials (those
 *     hitting at least one non-dropped token) are IDENTICAL before and after
 *     the diet. Partials whose ONLY hit is a dropped/common token are
 *     intentionally not returned when a rare anchor exists — widening the
 *     partial pool on any dropped token re-created the O(n) full-store body
 *     scan (review finding); that tail class scores ≤ ~0.1;
 *   - both polarities: a dropped-token query still finds episodes (full-scan
 *     fallback, the probe's failing case) AND rare-token pruning still prunes
 *     (asserted at the tokenCandidates level: the AND set is exactly the rare
 *     token's postings);
 *   - the incremental writer (em-store) does not regrow dropped tokens, and
 *     episodes stored after a rebuild are still findable by a dropped token;
 *   - fixture tokens.json shrinks; em-stats reports the bloat ratio;
 *     em-doctor warns above 20x, stays clean on a dieted store, and does not
 *     flag "_dropped" as dangling ids.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenCandidates, episodeTokens } from '../scripts/lib/relevance.mjs';

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

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emdiet-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emdiet-home-')));
  return { cwd, home, env: { HOME: home }, store: path.join(cwd, '.episodic-memory') };
}
function rmFixture(fx) {
  fs.rmSync(fx.cwd, { recursive: true, force: true });
  fs.rmSync(fx.home, { recursive: true, force: true });
}
function st(fx, summary, body) {
  const r = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'discovery', '--summary', summary, '--body', body], fx.cwd, fx.env);
  assert.equal(r.json.status, 'ok', r.stdout);
  return r.json.id;
}
function search(fx, args) {
  const r = run('em-search.mjs', ['--scope', 'local', '--no-track', ...args], fx.cwd, fx.env);
  assert.equal(r.json.status, 'ok', r.stdout);
  return r.json.episodes.map(e => ({ id: e.id, score: e.score, match: e.match }));
}
function tokensOf(fx) {
  return JSON.parse(fs.readFileSync(path.join(fx.store, 'tokens.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Fixture: every body contains "deployment" (df 100% — dropped); each has one
// rare discriminating token (df 20% — kept). "pipeline" sits in 2/5 (40%,
// NOT dropped: threshold is strictly-greater).
// ---------------------------------------------------------------------------
const fx = mkFixture();
const EPS = [
  ['alpha rollout', 'deployment of the zephyr service through the pipeline went fine'],
  ['beta rollout', 'deployment of the quasar service through the pipeline went fine'],
  ['gamma rollout', 'deployment of the nimbus service went fine'],
  ['delta rollout', 'deployment of the krypton service went fine'],
  ['epsilon rollout', 'deployment of the obsidian service went fine'],
];
const ids = EPS.map(([s, b]) => st(fx, s, b));

// Normalize index.jsonl row order first (a rebuild rewrites rows in filename
// order, which would confound the before/after ordering diff), then restore
// the FULL pre-diet tokens.json — exactly what the pre-diet writer produced:
// every token, complete posting lists, no _dropped marker. The only variable
// between "before" and "after" is the diet itself.
assert.equal(run('em-rebuild-index.mjs', ['--scope', 'local'], fx.cwd, fx.env).json.status, 'ok');
function writeFullTokens(fx2) {
  const rows = fs.readFileSync(path.join(fx2.store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const idx = {};
  for (const r of rows) {
    const content = fs.readFileSync(path.join(fx2.store, 'episodes', `${r.id}.md`), 'utf8');
    for (const tok of episodeTokens({ summary: r.summary, tags: r.tags, body: content })) {
      (idx[tok] ||= []).push(r.id);
    }
  }
  fs.writeFileSync(path.join(fx2.store, 'tokens.json'), JSON.stringify(idx));
}
writeFullTokens(fx);

const QUERIES = [
  ['deployment'],                       // single common token (probe's failing case)
  ['deployment zephyr'],                // common + rare: AND tier + partial tier
  ['zephyr'],                           // rare only: pruning path
  ['deployment obsidian pipeline'],     // common + rare + borderline-df
  ['zephyr quasar'],                    // two rares, no full match → partials
];
const before = new Map(QUERIES.map(([q]) => [q, search(fx, ['--query', q])]));
const sizeBefore = fs.statSync(path.join(fx.store, 'tokens.json')).size;

const rebuild = run('em-rebuild-index.mjs', ['--scope', 'local'], fx.cwd, fx.env);
assert.equal(rebuild.json.status, 'ok', rebuild.stdout);
const sizeAfter = fs.statSync(path.join(fx.store, 'tokens.json')).size;

t('writer: >40%-df posting lists dropped, recorded sorted under _dropped; borderline 40% kept', () => {
  const tok = tokensOf(fx);
  assert.ok(!('deployment' in tok), 'df-100% token must lose its posting list');
  assert.ok(Array.isArray(tok._dropped) && tok._dropped.includes('deployment'), `_dropped must record it: ${JSON.stringify(tok._dropped)}`);
  assert.deepEqual(tok._dropped, [...tok._dropped].sort(), '_dropped is sorted');
  assert.ok(Array.isArray(tok.pipeline) && tok.pipeline.length === 2, 'exactly-40%-df token keeps its postings (strictly-greater threshold)');
  assert.ok(Array.isArray(tok.zephyr) && tok.zephyr.length === 1, 'rare token keeps its postings');
});

t('fixture tokens.json shrinks', () => {
  assert.ok(sizeAfter < sizeBefore, `expected shrink, got ${sizeBefore} -> ${sizeAfter}`);
  console.log(`      tokens.json bytes: ${sizeBefore} -> ${sizeAfter} (${Math.round((1 - sizeAfter / sizeBefore) * 100)}% smaller)`);
});

t('correctness gate: full matches + anchored partials identical before/after the diet', () => {
  // Post-review contract (O(n) finding): the partial pool stays anchored to
  // non-dropped tokens' postings, so a pre-diet partial survives iff it hits
  // at least one NON-dropped query token. Full matches always survive. The
  // all-tokens-dropped query ("deployment") full-scans and stays identical.
  const tok = tokensOf(fx);
  const droppedSet = new Set(Array.isArray(tok._dropped) ? tok._dropped : []);
  const textOf = (id) => fs.readFileSync(path.join(fx.store, 'episodes', `${id}.md`), 'utf8').toLowerCase();
  for (const [q] of QUERIES) {
    const after = search(fx, ['--query', q]);
    const qtoks = q.split(' ');
    const expected = before.get(q).filter(e =>
      e.match !== 'partial' || qtoks.some(t2 => !droppedSet.has(t2) && textOf(e.id).includes(t2)));
    assert.deepEqual(after, expected, `query "${q}" diverged:\n  expected ${JSON.stringify(expected)}\n  after  ${JSON.stringify(after)}`);
  }
});

t('anchored-pool polarity: dropped-only partial tail absent WITH a rare anchor, present when ALL tokens dropped', () => {
  // With the rare anchor "zephyr", the four deployment-only episodes are no
  // longer partial hits (bounded pool). With every query token dropped, the
  // inherent full scan still surfaces every episode (polarity 1 covers it).
  const r = search(fx, ['--query', 'deployment zephyr']);
  assert.equal(r.length, 1, `expected only the full match, got ${JSON.stringify(r)}`);
  assert.equal(r[0].id, ids[0]);
});

t('polarity 1: single dropped-token query still finds all episodes (not zero candidates)', () => {
  const r = search(fx, ['--query', 'deployment']);
  assert.deepEqual(r.map(e => e.id).sort(), [...ids].sort(), 'dropped token must full-scan, not return zero');
});

t('polarity 2: rare-token pruning still prunes (AND set == the rare token postings)', () => {
  // Lib-level: the pruning contract is internal to the reader, so assert it
  // where it lives instead of inferring from output.
  const idx = tokensOf(fx);
  const c = tokenCandidates([idx], ['deployment', 'zephyr']);
  assert.ok(c.dropped.has('deployment'), 'common token flagged non-pruning');
  assert.ok(!c.dropped.has('zephyr'));
  assert.deepEqual([...c.all].sort(), [ids[0]], 'AND set constrained by the rare token only');
  const cAllDropped = tokenCandidates([idx], ['deployment']);
  assert.equal(cAllDropped.all, null, 'no pruning token -> all === null (full scan signal)');
  const cAbsent = tokenCandidates([idx], ['nonexistenttoken']);
  assert.ok(cAbsent.all instanceof Set && cAbsent.all.size === 0, 'genuinely absent token still yields zero candidates');
});

t('incremental writer: post-rebuild em-store does not regrow dropped tokens; new episode still findable by them', () => {
  const newId = st(fx, 'zeta rollout', 'deployment of the umbra service went fine');
  const tok = tokensOf(fx);
  assert.ok(!('deployment' in tok), 'dropped token must not regrow from incremental writes');
  assert.ok(Array.isArray(tok.umbra) && tok.umbra.includes(newId), 'new rare token indexed normally');
  const r = search(fx, ['--query', 'deployment', '--limit', '10']);
  assert.ok(r.some(e => e.id === newId), 'new episode reachable via the dropped token (full scan)');
});

t('em-stats reports derived_index_bloat_ratio', () => {
  const r = run('em-stats.mjs', ['--scope', 'local'], fx.cwd, fx.env);
  const s = r.json.scopes.find(x => x.scope === 'local');
  assert.equal(typeof s.derived_index_bloat_ratio, 'number', r.stdout);
  assert.ok(s.derived_index_bloat_ratio > 0);
});

t('em-doctor: dieted store clean — no dangling-id warn for _dropped, tokens-bloat ok', () => {
  const r = run('em-doctor.mjs', ['--scope', 'local'], fx.cwd, fx.env);
  const tokCheck = r.json.checks.find(c => c.id === 'tokens-index' && c.scope === 'local');
  assert.equal(tokCheck.level, 'ok', JSON.stringify(tokCheck));
  const bloat = r.json.checks.find(c => c.id === 'tokens-bloat' && c.scope === 'local');
  assert.equal(bloat.level, 'ok', JSON.stringify(bloat));
});

t('em-doctor warns above the 20x bloat threshold', () => {
  const fx2 = mkFixture();
  st(fx2, 'seed', 'tiny body');
  // Inflate tokens.json far beyond 20x index.jsonl with valid postings.
  const rows = fs.readFileSync(path.join(fx2.store, 'index.jsonl'), 'utf8').trim().split('\n');
  const id = JSON.parse(rows[0]).id;
  const idxBytes = fs.statSync(path.join(fx2.store, 'index.jsonl')).size;
  const fat = JSON.parse(fs.readFileSync(path.join(fx2.store, 'tokens.json'), 'utf8'));
  let i = 0;
  while (JSON.stringify(fat).length < idxBytes * 25) fat[`filler${i++}`] = [id];
  fs.writeFileSync(path.join(fx2.store, 'tokens.json'), JSON.stringify(fat));
  const r = run('em-doctor.mjs', ['--scope', 'local'], fx2.cwd, fx2.env);
  const bloat = r.json.checks.find(c => c.id === 'tokens-bloat' && c.scope === 'local');
  assert.equal(bloat.level, 'warn', JSON.stringify(bloat));
  assert.equal(bloat.fix, 'em-rebuild-index');
  rmFixture(fx2);
});

rmFixture(fx);
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
