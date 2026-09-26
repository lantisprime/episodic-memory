/**
 * test-archive-indexes.mjs — scripts/lib/archive-indexes.mjs (#476).
 *
 * removeIdsFromInvertedIndexes is the shared inverted-index cleanup used by
 * em-prune and em-consolidate --fold-superseded when they archive episodes.
 * Exercised directly on fixture store dirs (real files, real reads/writes):
 *   - archived ids leave tags.json, category-index.json and tokens.json;
 *     survivors stay; emptied keys are deleted (em-rebuild-index never emits
 *     an empty list), including an empty-string '' category key;
 *   - "__proto__"/"constructor" keys stay own keys (null-proto reads);
 *   - tokens.json's _dropped marker (tokens, not ids) is preserved;
 *   - an absent index is not created, a corrupt one is left byte-identical;
 *   - an empty id set writes nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeIdsFromInvertedIndexes } from '../scripts/lib/archive-indexes.mjs';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emarch-')));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

t('drops archived ids from all three indexes; deletes emptied keys incl. the "" category key', () => {
  const dir = mkStore({
    'tags.json': { auth: ['a', 'b'], only_a: ['a'] },
    'category-index.json': { decision: ['a', 'b'], '': ['a'], lesson: ['c'] },
    'tokens.json': { login: ['a', 'c'], solo: ['a'] },
  });
  removeIdsFromInvertedIndexes(dir, new Set(['a']));
  assert.deepEqual(read(dir, 'tags.json'), { auth: ['b'] });
  assert.deepEqual(read(dir, 'category-index.json'), { decision: ['b'], lesson: ['c'] });
  assert.deepEqual(read(dir, 'tokens.json'), { login: ['c'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

t('non-empty "" category key survives like any other key', () => {
  const dir = mkStore({ 'category-index.json': { '': ['a', 'b'] } });
  removeIdsFromInvertedIndexes(dir, ['a']);
  assert.deepEqual(read(dir, 'category-index.json'), { '': ['b'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

t('"__proto__" and "constructor" keys stay own keys and are filtered', () => {
  const dir = mkStore({ 'tags.json': '{"__proto__":["a","b"],"constructor":["a"]}' });
  removeIdsFromInvertedIndexes(dir, ['a']);
  const raw = fs.readFileSync(path.join(dir, 'tags.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), raw);
  assert.deepEqual(parsed['__proto__'], ['b']);
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'constructor'), raw);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('tokens.json _dropped marker is preserved as-is', () => {
  const dir = mkStore({ 'tokens.json': { _dropped: ['a', 'the'], login: ['a', 'b'] } });
  removeIdsFromInvertedIndexes(dir, ['a']);
  assert.deepEqual(read(dir, 'tokens.json'), { _dropped: ['a', 'the'], login: ['b'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

t('absent index is not created; corrupt index is left byte-identical', () => {
  const dir = mkStore({ 'category-index.json': '{not json', 'tags.json': { x: ['a'] } });
  removeIdsFromInvertedIndexes(dir, ['a']);
  assert.equal(fs.readFileSync(path.join(dir, 'category-index.json'), 'utf8'), '{not json');
  assert.ok(!fs.existsSync(path.join(dir, 'tokens.json')), 'tokens.json must not be created');
  assert.deepEqual(read(dir, 'tags.json'), {});
  assert.deepEqual(fs.readdirSync(dir).sort(), ['category-index.json', 'tags.json'], 'no temp files left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('empty id set writes nothing', () => {
  const dir = mkStore({ 'tags.json': '{"x":["a"]}' });
  const before = fs.statSync(path.join(dir, 'tags.json')).mtimeMs;
  removeIdsFromInvertedIndexes(dir, new Set());
  assert.equal(fs.readFileSync(path.join(dir, 'tags.json'), 'utf8'), '{"x":["a"]}');
  assert.equal(fs.statSync(path.join(dir, 'tags.json')).mtimeMs, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
