/**
 * test-feedback-scan.mjs — S3 em-feedback --scan-text batch inference.
 *
 * Rigor contract (behavior-simulated on isolated fixture stores):
 *   - the id regex is derived from em-store's generator: normal slugs, the
 *     empty-slug ("ts--hex") shape, ids inside backticks/paths all match;
 *     ellipsized ids ("20260708-…-8ff2") and longer alnum runs do not;
 *   - duplicated citations dedupe to ONE +1; unresolved ids are counted, not
 *     recorded; scope filtering resolves local/global correctly;
 *   - both polarities: a real run records feedback in index.jsonl AND
 *     --dry-run records nothing (verified by store-state snapshot);
 *   - single-id mode is unchanged (regression);
 *   - unreadable file fails closed (exit 1, no writes).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emfbscan-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emfbscan-home-')));
const env = { HOME: home };
const store = path.join(cwd, '.episodic-memory');
const globalStore = path.join(home, '.episodic-memory');

function st(scope, summary) {
  const r = run('em-store.mjs', ['--project', 'fx', '--scope', scope, '--category', 'discovery', '--summary', summary, '--body', 'body text'], cwd, env);
  assert.equal(r.json.status, 'ok', r.stdout);
  return r.json.id;
}
function feedbackOf(dir, id) {
  const rows = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return rows.find(r => r.id === id)?.feedback;
}

const idA = st('local', 'atomic rename lesson');
const idB = st('local', 'sigpipe loop lesson');
const idEmptySlug = st('local', '!!!'); // symbols-only summary -> empty slug -> "ts--hex" id shape
const idG = st('global', 'global handoff pattern');
const fakeId = '20990101-120000-never-stored-episode-abcd';

const handoff = path.join(cwd, 'handoff.md');
fs.writeFileSync(handoff, [
  '# Session handoff',
  `Root cause captured in \`${idA}\` (cited twice: ${idA}).`,
  `See also episodes/${idB}.md and the odd one ${idEmptySlug}.`,
  `Global pattern: ${idG}. Stale ref: ${fakeId}.`,
  'Ellipsized (must NOT match): `20260708-035412-…-8ff2`.',
  `Embedded run (must NOT match): x${idA}y`,
].join('\n'));

t('empty-slug id really has the ts--hex shape (fixture sanity)', () => {
  assert.match(idEmptySlug, /^\d{8}-\d{6}--[0-9a-f]{4}$/, idEmptySlug);
});

t('--dry-run: matches + resolves + counts unresolved, records NOTHING (store state proof)', () => {
  const before = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8');
  const beforeG = fs.readFileSync(path.join(globalStore, 'index.jsonl'), 'utf8');
  const r = run('em-feedback.mjs', ['--scan-text', handoff, '--dry-run'], cwd, env);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.scanned, 1);
  assert.equal(r.json.matched, 5, `dedupe to 5 unique ids: ${r.stdout}`);
  assert.equal(r.json.resolved, 4);
  assert.equal(r.json.recorded, 0);
  assert.equal(r.json.skipped_unresolved, 1);
  assert.deepEqual(r.json.skipped_ids, [fakeId]);
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'), before, 'local index must be untouched');
  assert.equal(fs.readFileSync(path.join(globalStore, 'index.jsonl'), 'utf8'), beforeG, 'global index must be untouched');
});

t('real run: one +1 per resolved id (dedup), both scopes, unresolved skipped', () => {
  const r = run('em-feedback.mjs', ['--scan-text', handoff], cwd, env);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.matched, 5);
  assert.equal(r.json.resolved, 4);
  assert.equal(r.json.recorded, 4);
  assert.equal(r.json.skipped_unresolved, 1);
  assert.equal(feedbackOf(store, idA), 1, 'cited twice must still be +1 (dedupe)');
  assert.equal(feedbackOf(store, idB), 1);
  assert.equal(feedbackOf(store, idEmptySlug), 1, 'empty-slug id shape must match the derived regex');
  assert.equal(feedbackOf(globalStore, idG), 1);
});

t('--scope local: global-only ids count as unresolved and are not written', () => {
  const r = run('em-feedback.mjs', ['--scan-text', handoff, '--scope', 'local'], cwd, env);
  assert.equal(r.json.resolved, 3);
  assert.equal(r.json.skipped_unresolved, 2, `global id + fake id: ${r.stdout}`);
  assert.equal(feedbackOf(globalStore, idG), 1, 'global feedback must not change under --scope local');
  assert.equal(feedbackOf(store, idA), 2, 'local ids take the second event');
});

t('single-id mode unchanged (regression)', () => {
  const r = run('em-feedback.mjs', ['--id', idB, '--noise'], cwd, env);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.feedback, 1, '2 - 1 = 1');
  const bad = run('em-feedback.mjs', ['--id', idB], cwd, env);
  assert.equal(bad.code, 1, 'missing --useful/--noise still errors');
});

t('unreadable --scan-text file fails closed (exit 1, no writes)', () => {
  const before = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8');
  const r = run('em-feedback.mjs', ['--scan-text', path.join(cwd, 'no-such-file.md')], cwd, env);
  assert.equal(r.code, 1, r.stdout);
  assert.equal(r.json.status, 'error');
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'), before);
});

t('invalid --scope rejected', () => {
  const r = run('em-feedback.mjs', ['--scan-text', handoff, '--scope', 'both'], cwd, env);
  assert.equal(r.code, 1);
  assert.equal(r.json.status, 'error');
});

t('file with no ids: clean zero report', () => {
  const empty = path.join(cwd, 'empty.md');
  fs.writeFileSync(empty, 'nothing to see here, just prose from 2026-07-08.');
  const r = run('em-feedback.mjs', ['--scan-text', empty], cwd, env);
  assert.equal(r.code, 0);
  assert.deepEqual(
    [r.json.matched, r.json.resolved, r.json.recorded, r.json.skipped_unresolved],
    [0, 0, 0, 0], r.stdout);
});

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
