/**
 * test-category-index.mjs — RFC-009 P1a S4: category-index build + drift detection (Group 3, §14).
 *
 * REQ-8 (category-index.json: canonical keys, deprecated→successor, unknown literal+counted),
 * REQ-12 (--check drift), REQ-14 rebuild half (carry consolidates/superseded_by), plus EC8/9/10,
 * atomic rename, the C4 concurrent store+rebuild probe, and B1 degrade-on-missing-vocab.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// Build a store dir with the given episodes. Each ep: {id, category?, extra?} → frontmatter.
function mkStore(episodes) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catidx-')));
  const epDir = path.join(cwd, '.episodic-memory', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  for (const ep of episodes) {
    const lines = ['---', `id: ${ep.id}`, 'date: 2026-07-06', 'time: "00:00"', 'project: fx'];
    if ('category' in ep) lines.push(`category: ${ep.category}`);
    lines.push('status: active');
    for (const [k, v] of Object.entries(ep.extra || {})) lines.push(`${k}: ${v}`);
    lines.push('tags: []', 'summary: fx', '---', '', '# x', '', 'body', '');
    fs.writeFileSync(path.join(epDir, `${ep.id}.md`), lines.join('\n'));
  }
  return cwd;
}
function store(cwd) { return path.join(cwd, '.episodic-memory'); }
function rebuild(cwd, env) {
  const r = spawnSync('node', [EM_REBUILD, '--scope', 'local'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stderr: r.stderr };
}
function check(cwd, env) {
  const r = spawnSync('node', [EM_REBUILD, '--check', '--scope', 'local'], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json };
}
function catIndex(cwd) {
  return JSON.parse(fs.readFileSync(path.join(store(cwd), 'category-index.json'), 'utf8'));
}
function indexRows(cwd) {
  return fs.readFileSync(path.join(store(cwd), 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function depVocab() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catvocab-')), 'categories.json');
  fs.writeFileSync(p, JSON.stringify({
    version: '1.0.0',
    categories: [
      { name: 'lesson', description: 'd', lifecycle: 'standard' },
      { name: 'old', description: 'd', lifecycle: 'standard', deprecated_for: 'lesson' },
    ],
  }));
  return p;
}

t('testCategoryIndexBuilt', () => {
  const cwd = mkStore([{ id: 'a1', category: 'lesson' }, { id: 'a2', category: 'decision' }]);
  rebuild(cwd);
  const idx = catIndex(cwd);
  assert.deepEqual(idx.lesson, ['a1']);
  assert.deepEqual(idx.decision, ['a2']);
});

t('testCategoryIndexDeprecatedMapped', () => {
  const cwd = mkStore([{ id: 'd1', category: 'old' }]);
  rebuild(cwd, { EM_CATEGORIES_PATH: depVocab() });
  const idx = catIndex(cwd);
  assert.deepEqual(idx.lesson, ['d1'], 'deprecated old indexed under successor key lesson');
  assert.ok(!idx.old, 'no literal old key');
});

t('testCategoryIndexUnknownCountedLiteral', () => {
  const cwd = mkStore([{ id: 'u1', category: 'bogus' }]);
  const r = rebuild(cwd);
  assert.deepEqual(catIndex(cwd).bogus, ['u1'], 'unknown indexed under literal key');
  assert.equal(r.json.rebuilt[0].category_drift.unknown.bogus, 1, 'and counted as drift');
});

t('testCategoryIndexAtomicRename', () => {
  const cwd = mkStore([{ id: 'r1', category: 'lesson' }]);
  rebuild(cwd);
  const files = fs.readdirSync(store(cwd));
  assert.ok(files.includes('category-index.json'), 'final file present');
  assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no leftover .tmp (rename is atomic)');
  assert.doesNotThrow(() => catIndex(cwd), 'file is valid JSON');
});

t('testCategoryIndexConcurrentStoreRebuild', () => {
  // C4: loop N stores while a rebuild runs; assert category-index always parses, then a final
  // rebuild lists every id. Uses parallel spawns to overlap temp+rename churn.
  const cwd = mkStore([{ id: 'seed', category: 'lesson' }]);
  const procs = [];
  for (let i = 0; i < 6; i++) {
    procs.push(spawnSync('node', [EM_STORE, '--project', 't', '--category', 'lesson', '--summary', `c${i}`, '--body', 'b', '--scope', 'local'], { cwd, encoding: 'utf8' }));
  }
  rebuild(cwd);
  // parseable at read
  assert.doesNotThrow(() => catIndex(cwd), 'category-index parseable after concurrent churn');
  rebuild(cwd); // final authoritative rebuild
  const ids = new Set(indexRows(cwd).map((r) => r.id));
  const idx = catIndex(cwd);
  const indexed = new Set(Object.values(idx).flat());
  for (const id of ids) assert.ok(indexed.has(id), `id ${id} present in category-index after final rebuild`);
});

t('testRebuildCheckListsDrift', () => {
  const cwd = mkStore([{ id: 'k1', category: 'lesson' }, { id: 'k2', category: 'bogus' }, { id: 'k3', category: 'old' }]);
  const r = check(cwd, { EM_CATEGORIES_PATH: depVocab() });
  assert.equal(r.code, 1, 'drift → exit 1');
  const byId = Object.fromEntries(r.json.drift.map((d) => [d.id, d]));
  assert.equal(byId.k2.kind, 'unknown');
  assert.equal(byId.k3.kind, 'deprecated');
  assert.equal(byId.k3.successor, 'lesson');
  assert.ok(!byId.k1, 'active category not flagged');
});

t('testRebuildCheckCleanExitsZero', () => {
  const cwd = mkStore([{ id: 'c1', category: 'lesson' }]);
  // --check must NOT write index files
  const before = fs.readdirSync(store(cwd));
  const r = check(cwd);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.drift, []);
  const after = fs.readdirSync(store(cwd));
  assert.deepEqual(after, before, '--check wrote nothing');
});

t('testRebuildCarriesNewFields', () => {
  // EC8: dotted category (workflow.lifecycle) + consolidates/superseded_by carried through.
  const cwd = mkStore([{
    id: 'nf1', category: 'workflow.lifecycle',
    extra: { consolidates: '[x1]', superseded_by: 'y1' },
  }]);
  rebuild(cwd);
  const row = indexRows(cwd).find((r) => r.id === 'nf1');
  assert.deepEqual(row.consolidates, ['x1']);
  assert.equal(row.superseded_by, 'y1');
  assert.deepEqual(catIndex(cwd)['workflow.lifecycle'], ['nf1'], 'dotted category keys fine');
});

t('testCategoryIndexUndefinedCategory', () => {
  // EC9: episode with NO category field → coerced key, counted drift, no crash.
  const cwd = mkStore([{ id: 'un1' }]); // no category
  const r = rebuild(cwd);
  assert.equal(r.code, 0, 'no crash');
  const idx = catIndex(cwd);
  assert.ok(idx.undefined && idx.undefined.includes('un1'), 'missing category → "undefined" literal key');
  assert.equal(r.json.rebuilt[0].category_drift.unknown.undefined, 1);
});

t('testCategoryNonScalarTolerated', () => {
  // EC10: non-scalar category (array) → stable string key, never [object Object], no crash.
  const cwd = mkStore([{ id: 'ns1', category: '[a, b]' }]);
  const r = rebuild(cwd);
  assert.equal(r.code, 0, 'no crash');
  const idx = catIndex(cwd);
  const keys = Object.keys(idx);
  assert.ok(!keys.includes('[object Object]'), 'never a live [object Object] key');
  assert.ok(keys.some((k) => idx[k].includes('ns1')), 'the id is indexed under some stable string key');
});

t('testRebuildDegradesOnMissingVocab', () => {
  // B1: unloadable vocab → still build index.jsonl + tags.json, skip category-index, exit 0 + warn.
  const cwd = mkStore([{ id: 'b1', category: 'lesson' }]);
  const r = rebuild(cwd, { EM_CATEGORIES_PATH: '/nonexistent/categories.json' });
  assert.equal(r.code, 0, 'degrade, never fatal');
  assert.ok(fs.existsSync(path.join(store(cwd), 'index.jsonl')), 'index.jsonl still built');
  assert.ok(fs.existsSync(path.join(store(cwd), 'tags.json')), 'tags.json still built');
  assert.ok(!fs.existsSync(path.join(store(cwd), 'category-index.json')), 'category-index skipped');
  assert.match(r.stderr, /unloadable/, 'stderr warning emitted');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
