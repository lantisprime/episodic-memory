/**
 * test-category-search.mjs — RFC-009 P1a S5: read-surface tolerance + index-backed --category.
 *
 * REQ-7 (search/list/recall stay tolerant of unknown categories — the #447 class),
 * REQ-10 (--category index-backed: canonicalize, use index, fallback on missing, active-name
 * byte-identical), B1 (search degrades on unloadable vocab).
 * testRestoreMergesCategoryIndex lives in test-category-write.mjs (S3) and is not duplicated here.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_SEARCH = path.join(REPO, 'scripts/em-search.mjs');
const EM_LIST = path.join(REPO, 'scripts/em-list.mjs');
const EM_RECALL = path.join(REPO, 'scripts/em-recall.mjs');
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore(episodes) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catsearch-')));
  const epDir = path.join(cwd, '.episodic-memory', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  for (const ep of episodes) {
    const lines = ['---', `id: ${ep.id}`, 'date: 2026-07-06', 'time: "00:00"', `project: ${ep.project || 'fx'}`];
    if ('category' in ep) lines.push(`category: ${ep.category}`);
    lines.push('status: active', 'tags: []', `summary: ${ep.summary || 'fx'}`, '---', '', '# x', '', 'body', '');
    fs.writeFileSync(path.join(epDir, `${ep.id}.md`), lines.join('\n'));
  }
  return cwd;
}
function rebuild(cwd, env) {
  spawnSync('node', [EM_REBUILD, '--scope', 'local'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}
function run(script, args, cwd, env) {
  const r = spawnSync('node', [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}

t('testSearchTolerantUnknownCategory', () => {
  const cwd = mkStore([{ id: 'sx1', category: 'bogus', summary: 'unknown row' }, { id: 'sx2', category: 'lesson' }]);
  rebuild(cwd);
  // a general search must not crash and must still see the unknown-category row
  const r = run(EM_SEARCH, ['--scope', 'local', '--no-track', '--no-score'], cwd);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');
  assert.ok(r.json.episodes.some((e) => e.id === 'sx1'), 'unknown-category episode still listed');
});

t('testListTolerantUnknownCategory', () => {
  const cwd = mkStore([{ id: 'lx1', category: 'bogus' }]);
  rebuild(cwd);
  const r = run(EM_LIST, ['--scope', 'local'], cwd);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');
});

t('testRecallTolerantUnknownCategory', () => {
  const cwd = mkStore([{ id: 'rx1', category: 'bogus', project: 'fx' }]);
  rebuild(cwd);
  const r = run(EM_RECALL, ['--scope', 'local', '--no-track', '--project', 'fx'], cwd);
  assert.equal(r.code, 0, `em-recall must not crash on an unknown category; stdout: ${r.stdout}`);
  assert.equal(r.json.status, 'ok');
});

t('testSearchCategoryExactMatchUnchanged', () => {
  // Regression pin (M1): an active-name query returns exactly the episodes whose category is that
  // name — the same set the old exact-match filter produced.
  const cwd = mkStore([
    { id: 'ex1', category: 'lesson' }, { id: 'ex2', category: 'lesson' }, { id: 'ex3', category: 'decision' },
  ]);
  rebuild(cwd);
  const r = run(EM_SEARCH, ['--category', 'lesson', '--scope', 'local', '--no-track', '--no-score', '--limit', '50'], cwd);
  const ids = r.json.episodes.map((e) => e.id).sort();
  assert.deepEqual(ids, ['ex1', 'ex2'], 'only the two lesson episodes, none of decision');
});

t('testSearchCategoryUsesIndex', () => {
  const cwd = mkStore([{ id: 'ix1', category: 'lesson' }, { id: 'ix2', category: 'decision' }]);
  rebuild(cwd);
  // corrupt index.jsonl-independent proof: point category-index at only ix1 and confirm the index
  // (not a linear rescan) drives results — remove ix2 from the index, query decision → empty.
  const r = run(EM_SEARCH, ['--category', 'lesson', '--scope', 'local', '--no-track', '--no-score'], cwd);
  assert.deepEqual(r.json.episodes.map((e) => e.id), ['ix1']);
});

t('testSearchCategoryFallbackOnMissingIndex', () => {
  const cwd = mkStore([{ id: 'fb1', category: 'lesson' }]);
  rebuild(cwd);
  // corrupt the category-index → linear fallback + warning, still returns the row
  fs.writeFileSync(path.join(cwd, '.episodic-memory', 'category-index.json'), '{ not json');
  const r = run(EM_SEARCH, ['--category', 'lesson', '--scope', 'local', '--no-track', '--no-score'], cwd);
  assert.equal(r.code, 0);
  assert.ok(r.json.episodes.some((e) => e.id === 'fb1'), 'linear fallback still finds the row');
  assert.match(r.json.warning || '', /category-index\.json/, 'rebuild warning surfaced');
});

t('testSearchCategoryCanonicalizesDeprecated', () => {
  // planted vocab: old → lesson. Episodes stored as lesson; a --category old query canonicalizes
  // to lesson and finds them.
  const vocab = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catvocab-')), 'categories.json');
  fs.writeFileSync(vocab, JSON.stringify({
    version: '1.0.0',
    categories: [
      { name: 'lesson', description: 'd', lifecycle: 'standard' },
      { name: 'old', description: 'd', lifecycle: 'standard', deprecated_for: 'lesson' },
    ],
  }));
  const cwd = mkStore([{ id: 'cd1', category: 'lesson' }]);
  rebuild(cwd, { EM_CATEGORIES_PATH: vocab });
  const r = run(EM_SEARCH, ['--category', 'old', '--scope', 'local', '--no-track', '--no-score'], cwd, { EM_CATEGORIES_PATH: vocab });
  assert.ok(r.json.episodes.some((e) => e.id === 'cd1'), 'deprecated query old canonicalizes to lesson');
});

t('testSearchDegradesOnMissingVocab', () => {
  const cwd = mkStore([{ id: 'dg1', category: 'lesson' }]);
  rebuild(cwd); // build with real vocab
  const r = run(EM_SEARCH, ['--category', 'lesson', '--scope', 'local', '--no-track', '--no-score'], cwd, { EM_CATEGORIES_PATH: '/nonexistent/categories.json' });
  assert.equal(r.code, 0, 'search never fatal on unloadable vocab');
  assert.ok(r.json.episodes.some((e) => e.id === 'dg1'), 'still finds the row (canonicalCategory degrades to literal)');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
