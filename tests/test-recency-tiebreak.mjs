#!/usr/bin/env node
/**
 * test-recency-tiebreak.mjs — #621: recency ordering is finer than the minute-granular `time`.
 *
 * A fork-closure stub (20260726-052700-…) and its terminal (20260726-052722-…) both stamp
 * `time: "05:27"`. Pre-fix every recency sort keyed on date + time only, so the pair tied and
 * the older stub won `--limit 1` (index rows are in id order, and the stable sort kept it first).
 * The shared comparator (lib/relevance.mjs compareRecency) breaks the tie on the id's embedded
 * HHMMSS stamp, then id — in em-search --no-score, em-search --sort recent, em-list, and as the
 * tiebreak for equal scores in the default ranking. Stored frontmatter is unchanged.
 *
 * Real scripts, isolated non-git scratch dir, HOME isolated.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const S = (n) => path.join(REPO, 'scripts', n);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

const STUB = '20260726-052700-fork-closure-stub-840d';
const TERMINAL = '20260726-052722-handoff-96-b5d9';

function mkStore() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-recency-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'w');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const box = { cwd, env: { ...process.env, HOME: home } };
  const epDir = path.join(cwd, '.episodic-memory', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  for (const id of [STUB, TERMINAL]) {
    fs.writeFileSync(path.join(epDir, `${id}.md`), ['---', `id: ${id}`, 'date: 2026-07-26', 'time: "05:27"',
      'project: fx', 'category: context', 'status: active', 'tags: [session-handoff]', `summary: ${id}`,
      '---', '', '# x', '', 'body', ''].join('\n'));
  }
  assert.equal(run(box, 'em-rebuild-index.mjs', ['--scope', 'local']).status, 'ok');
  return box;
}
function run(box, script, args) {
  const r = spawnSync('node', [S(script), ...args], { cwd: box.cwd, env: box.env, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim());
}
const first = (out) => out.episodes[0].id;

const box = mkStore();

t('fixture: both rows carry the same minute-granular time', () => {
  const rows = fs.readFileSync(path.join(box.cwd, '.episodic-memory', 'index.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.time), ['05:27', '05:27']);
  assert.equal(rows[0].id, STUB, 'stub is the FIRST index row (the pre-fix tie winner)');
});

t('em-search --no-score --limit 1 resolves the terminal, not the stub', () => {
  const out = run(box, 'em-search.mjs', ['--tag', 'session-handoff', '--scope', 'local', '--limit', '1', '--no-score', '--no-track']);
  assert.equal(first(out), TERMINAL);
});

t('em-search --sort recent --limit 1 resolves the terminal', () => {
  const out = run(box, 'em-search.mjs', ['--tag', 'session-handoff', '--scope', 'local', '--limit', '1', '--sort', 'recent', '--no-track']);
  assert.equal(first(out), TERMINAL);
});

t('default scoring: an exact score tie falls back to newest-first', () => {
  const out = run(box, 'em-search.mjs', ['--tag', 'session-handoff', '--scope', 'local', '--no-track']);
  assert.equal(out.episodes[0].score, out.episodes[1].score, 'fixture scores tie');
  assert.equal(first(out), TERMINAL);
});

t('em-list --limit 1 resolves the terminal', () => {
  const out = run(box, 'em-list.mjs', ['--scope', 'local', '--limit', '1']);
  assert.equal(first(out), TERMINAL);
});

t('stored frontmatter format unchanged (time stays HH:MM)', () => {
  const txt = fs.readFileSync(path.join(box.cwd, '.episodic-memory', 'episodes', `${TERMINAL}.md`), 'utf8');
  assert.match(txt, /^time: "05:27"$/m);
});

// Imported lazily so the script-level cases above still report individually on a tree
// that predates the export.
const { compareRecency } = await import('../scripts/lib/relevance.mjs');
t('compareRecency: date+time dominates the id stamp; foreign rows sort oldest', () => {
  assert.equal(typeof compareRecency, 'function', 'lib/relevance.mjs exports compareRecency');
  const a = { id: '20260726-235959-x', date: '2026-07-26', time: '05:27' };
  const b = { id: '20260726-000000-y', date: '2026-07-26', time: '05:28' };
  assert.ok(compareRecency(a, b) < 0, 'later time wins even when its id stamp is earlier');
  assert.ok(compareRecency({ id: 'foreign', date: 20260727 }, a) < 0, 'non-string date sorts oldest');
  assert.ok(compareRecency({ id: 'p', date: '2026-07-26', time: '05:27' }, { id: 'q', date: '2026-07-26', time: '05:27' }) < 0,
    'no id stamp: id is the final total order');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
