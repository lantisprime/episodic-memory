/**
 * test-prototype-key-collision.mjs — regression suite for issue #469.
 *
 * Bug: index maps (tokens.json, tags.json, category-index.json, stats/drift
 * tallies) were plain {} objects, so an episode-derived key that collides
 * with an Object.prototype property name — "constructor" is the only one
 * that survives the [^a-z0-9]+ tokenizer — resolved to the inherited
 * Object function instead of undefined. Symptoms: em-rebuild-index and
 * em-store/em-revise crashed with "push is not a function" on any store
 * containing the token "constructor"; em-search --tag constructor threw
 * "not iterable"; em-stats tallied garbage strings.
 *
 * Fix: fresh maps are Object.create(null); JSON.parse-loaded maps are
 * rehydrated via nullProtoIndex() (lib/relevance.mjs).
 *
 * Runtime probes against an isolated fixture store (no mental tracing).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nullProtoIndex, updateTokensIndex, loadTagsIndex } from '../scripts/lib/relevance.mjs';

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
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Unit: the isolated mechanism
// ---------------------------------------------------------------------------
t('nullProtoIndex: "constructor" lookup is undefined, own keys survive', () => {
  const idx = nullProtoIndex({ storage: ['a'] });
  assert.equal(idx['constructor'], undefined);
  assert.deepEqual(idx['storage'], ['a']);
});

t('updateTokensIndex: token "constructor" lands as an own key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protokey-unit-'));
  updateTokensIndex(dir, 'ep1', new Set(['constructor', 'atomic']));
  updateTokensIndex(dir, 'ep2', new Set(['constructor']));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8'));
  assert.deepEqual(onDisk['constructor'], ['ep1', 'ep2']);
  assert.deepEqual(onDisk['atomic'], ['ep1']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Runtime probes — isolated fixture store
// ---------------------------------------------------------------------------
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protokey-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protokey-home-')));
const env = { HOME: home };
const store = path.join(cwd, '.episodic-memory');

let storedId = null;
t('em-store survives body + tag "constructor" (crashed before #469 fix)', () => {
  const r = run('em-store.mjs', ['--project', 'fx', '--category', 'decision',
    '--summary', 'Null-proto maps for index keys',
    '--body', 'The constructor token used to hit Object.prototype and crash the write path.',
    '--tags', 'constructor,storage', '--scope', 'local'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.json?.status, 'ok');
  storedId = r.json.id;
  const tokens = JSON.parse(fs.readFileSync(path.join(store, 'tokens.json'), 'utf8'));
  assert.ok(Object.hasOwn(tokens, 'constructor'), 'tokens.json must own-key "constructor"');
  assert.ok(tokens['constructor'].includes(storedId));
  const tags = JSON.parse(fs.readFileSync(path.join(store, 'tags.json'), 'utf8'));
  assert.deepEqual(tags['constructor'], [storedId]);
});

t('em-search --tag constructor finds the episode (threw "not iterable" before)', () => {
  const r = run('em-search.mjs', ['--tag', 'constructor', '--scope', 'local', '--no-track'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(r.json.episodes.some(e => e.id === storedId), JSON.stringify(r.json));
});

t('em-search --query constructor finds the episode via the token index', () => {
  const r = run('em-search.mjs', ['--query', 'constructor token', '--scope', 'local', '--no-track'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(r.json.episodes.some(e => e.id === storedId), JSON.stringify(r.json));
});

t('em-revise survives a chain whose text/tags contain "constructor"', () => {
  const r = run('em-revise.mjs', ['--original', storedId,
    '--summary', 'Null-proto maps for index keys (revised)',
    '--body', 'Still mentions constructor after revision.'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.json?.status, 'ok');
});

t('em-rebuild-index --scope local succeeds and indexes the token (crashed before)', () => {
  const r = run('em-rebuild-index.mjs', ['--scope', 'local'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.json?.status, 'ok');
  const tokens = JSON.parse(fs.readFileSync(path.join(store, 'tokens.json'), 'utf8'));
  assert.ok(Object.hasOwn(tokens, 'constructor'));
  assert.ok(tokens['constructor'].length >= 1);
  const tags = JSON.parse(fs.readFileSync(path.join(store, 'tags.json'), 'utf8'));
  assert.ok(Array.isArray(tags['constructor']));
});

t('rebuild survives a hand-authored episode with category "constructor" (unknown-vocab path)', () => {
  // Readers DEGRADE on unknown categories (RFC-009 R10c), so a foreign-harness
  // episode with a colliding literal category key must not crash the rebuild.
  const id = '20260101-120000-aaaa';
  fs.writeFileSync(path.join(store, 'episodes', `${id}.md`), [
    '---', `id: ${id}`, 'date: 2026-01-01', 'time: "12:00"', 'project: fx',
    'category: constructor', 'status: active', 'tags: []',
    'summary: hand-authored colliding category', '---', '',
    '# hand-authored colliding category', '', 'body text', ''
  ].join('\n'), 'utf8');
  const r = run('em-rebuild-index.mjs', ['--scope', 'local'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.json?.status, 'ok');
  const catIdx = JSON.parse(fs.readFileSync(path.join(store, 'category-index.json'), 'utf8'));
  assert.deepEqual(catIdx['constructor'], [id]);
});

t('em-stats tallies a "constructor" tag/category as numbers, not garbage strings', () => {
  const r = run('em-stats.mjs', ['--scope', 'local'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const s = JSON.stringify(r.json);
  const local = r.json.scopes.find(sc => sc.scope === 'local');
  assert.ok(local, s);
  assert.equal(typeof local.by_category['constructor'], 'number', s);
  for (const v of Object.values(local.by_category)) assert.equal(typeof v, 'number', s);
  assert.ok(!s.includes('native code'), `stats output must not serialize Object.prototype functions: ${s}`);
});

t('loadTagsIndex returns a null-proto map (read path cannot see Object.prototype)', () => {
  const idx = loadTagsIndex(store);
  assert.ok(idx, 'tags.json must load');
  assert.equal(Object.getPrototypeOf(idx), null);
});

t('em-move local->global survives a "constructor" tag (left a partial move before)', () => {
  const s = run('em-store.mjs', ['--project', 'fx', '--category', 'decision',
    '--summary', 'movable episode', '--body', 'constructor token here too',
    '--tags', 'constructor', '--scope', 'local'], cwd, env);
  assert.equal(s.json?.status, 'ok', s.stdout);
  const r = run('em-move.mjs', ['--id', s.json.id, '--to', 'global', '--confirm', '--no-audit'], cwd, env);
  assert.equal(r.code, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.equal(r.json?.status, 'ok', r.stdout);
  const globalTags = JSON.parse(fs.readFileSync(path.join(home, '.episodic-memory', 'tags.json'), 'utf8'));
  assert.ok(Object.hasOwn(globalTags, 'constructor'), 'destination tags.json must own-key "constructor"');
  assert.ok(globalTags['constructor'].includes(s.json.id));
});

t('em-seed-patterns seeds a pattern_id/tag "constructor" (falsely skipped, then crashed before)', () => {
  // Fresh HOME: the em-move probe above legitimately put a "constructor" tag
  // into the shared global store, which would make a skip here correct.
  const seedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protokey-seed-home-')));
  const seedEnv = { HOME: seedHome };
  const pdir = path.join(cwd, 'patterns-fixture');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, '_index.json'), JSON.stringify({
    patterns: [{ pattern_id: 'constructor', file: 'c.md', name: 'colliding pattern' }]
  }), 'utf8');
  fs.writeFileSync(path.join(pdir, 'c.md'), [
    '---', 'name: colliding pattern', 'category: decision',
    'tags: [constructor]', '---', '', 'pattern body', ''
  ].join('\n'), 'utf8');
  const r = run('em-seed-patterns.mjs', ['--dir', pdir], cwd, seedEnv);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.json?.seeded, 1, `inherited Object.prototype.constructor must not read as already-seeded: ${r.stdout}`);
  assert.equal(r.json?.skipped, 0, r.stdout);
  const globalTags = JSON.parse(fs.readFileSync(path.join(seedHome, '.episodic-memory', 'tags.json'), 'utf8'));
  assert.ok(Object.hasOwn(globalTags, 'constructor'), 'seeded tag must land in global tags.json');
  fs.rmSync(seedHome, { recursive: true, force: true });
});

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
