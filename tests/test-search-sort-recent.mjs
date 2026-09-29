#!/usr/bin/env node
/**
 * test-search-sort-recent.mjs — #123: `em-search --sort recent` + unknown-flag rejection.
 *
 * Default scored ranking can bury the newest episode for `--tag X --limit 1` (an older episode
 * with a higher access_count outranks it). `--sort recent` keeps every filter but orders matches
 * newest-first; the default ranking is unchanged. Unknown flags (`--tags`, `--id`, `--scopes`,
 * `--queries` — the typos that returned UNFILTERED results) now exit 1 with `unknown_flag`.
 *
 * Real scripts, isolated non-git scratch dir, HOME isolated (the global store lives under it),
 * access counts bumped by real `--read` calls.
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

const OLD = '20260501-045223-plan-gate-violation-770e';
const NEW = '20260503-070410-workplan-v5-f16a';
const OTHER = '20260504-000000-unrelated-lesson-aaaa';
const GLOBAL_NEWEST = '20260505-000000-global-workplan-bbbb';

function writeEp(dir, { id, date, time, tags, category = 'decision', summary }) {
  fs.mkdirSync(path.join(dir, 'episodes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'episodes', `${id}.md`), ['---', `id: ${id}`, `date: ${date}`, `time: "${time}"`,
    'project: fx', `category: ${category}`, 'status: active', `tags: [${tags.join(', ')}]`, `summary: ${summary || id}`,
    '---', '', '# x', '', 'body', ''].join('\n'));
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-sortrecent-')));
const home = path.join(root, 'home');
const cwd = path.join(root, 'w');
fs.mkdirSync(home); fs.mkdirSync(cwd);
const env = { ...process.env, HOME: home };
function raw(args, script = 'em-search.mjs') {
  const r = spawnSync('node', [S(script), ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout.trim()) };
}
function search(args) {
  const { code, out } = raw([...args, '--no-track']);
  assert.equal(code, 0, JSON.stringify(out));
  assert.equal(out.status, 'ok');
  return out;
}
const ids = (out) => out.episodes.map((e) => e.id);

const local = path.join(cwd, '.episodic-memory');
writeEp(local, { id: OLD, date: '2026-05-01', time: '04:52', tags: ['violation', 'workplan'], summary: 'plan gate violation' });
writeEp(local, { id: NEW, date: '2026-05-03', time: '07:04', tags: ['workplan'], summary: 'workplan v5' });
writeEp(local, { id: OTHER, date: '2026-05-04', time: '00:00', tags: ['lesson-x'], category: 'lesson', summary: 'unrelated lesson' });
writeEp(path.join(home, '.episodic-memory'), { id: GLOBAL_NEWEST, date: '2026-05-05', time: '00:00', tags: ['workplan'], summary: 'global workplan' });
assert.equal(raw(['--scope', 'all'], 'em-rebuild-index.mjs').code, 0);
// Real access tracking: three tracked reads of the OLD episode.
for (let i = 0; i < 3; i++) assert.equal(raw(['--read', OLD, '--scope', 'local']).code, 0);

t('default scoring UNCHANGED: the access-boosted older episode still ranks first', () => {
  assert.equal(ids(search(['--tag', 'workplan', '--scope', 'local', '--limit', '1']))[0], OLD);
});

t('--sort recent --limit 1 returns the newest tagged episode', () => {
  const out = search(['--tag', 'workplan', '--scope', 'local', '--limit', '1', '--sort', 'recent']);
  assert.deepEqual(ids(out), [NEW]);
  assert.equal(typeof out.episodes[0].score, 'number', 'score is still reported');
});

t('--sort recent with multiple matches orders newest-first and keeps the tag filter', () => {
  assert.deepEqual(ids(search(['--tag', 'workplan', '--scope', 'local', '--sort', 'recent'])), [NEW, OLD]);
});

t('--sort recent honors --scope (all includes the newer global episode; local excludes it)', () => {
  assert.deepEqual(ids(search(['--tag', 'workplan', '--scope', 'all', '--sort', 'recent'])), [GLOBAL_NEWEST, NEW, OLD]);
  assert.ok(!ids(search(['--tag', 'workplan', '--scope', 'local', '--sort', 'recent'])).includes(GLOBAL_NEWEST));
});

t('--sort recent honors --since', () => {
  assert.deepEqual(ids(search(['--tag', 'workplan', '--scope', 'local', '--since', '2026-05-02', '--sort', 'recent'])), [NEW]);
});

t('--sort recent honors --limit', () => {
  assert.deepEqual(ids(search(['--scope', 'all', '--sort', 'recent', '--limit', '2'])), [GLOBAL_NEWEST, OTHER]);
});

t('--sort recent honors --category and --query', () => {
  assert.deepEqual(ids(search(['--scope', 'local', '--category', 'lesson', '--sort', 'recent'])), [OTHER]);
  assert.deepEqual(ids(search(['--scope', 'local', '--query', 'workplan', '--sort', 'recent'])), [NEW, OLD]);
});

t('--sort recent with no matches returns count 0', () => {
  const out = search(['--tag', 'no-such-tag', '--scope', 'all', '--sort', 'recent']);
  assert.equal(out.count, 0);
});

t('--sort score is the explicit default', () => {
  assert.deepEqual(ids(search(['--tag', 'workplan', '--scope', 'local', '--sort', 'score'])),
    ids(search(['--tag', 'workplan', '--scope', 'local'])));
});

t('invalid --sort value and --no-score + --sort score are errors', () => {
  for (const args of [['--sort', 'newest'], ['--sort'], ['--no-score', '--sort', 'score']]) {
    const { code, out } = raw(args);
    assert.equal(code, 1, args.join(' '));
    assert.equal(out.status, 'error');
  }
});

t('unknown flags exit 1 naming the flag (--tags, --id, --scopes, --queries)', () => {
  for (const bad of ['--tags', '--id', '--scopes', '--queries']) {
    const { code, out } = raw([bad, 'workplan', '--scope', 'local']);
    assert.equal(code, 1, bad);
    assert.equal(out.status, 'error');
    assert.equal(out.unknown_flag, bad);
    assert.ok(out.message.includes(bad));
  }
});

t('every documented flag spelling is accepted', () => {
  const accepted = [
    ['--project', 'fx'], ['--tag', 'workplan'], ['--category', 'decision'], ['--query', 'workplan'],
    ['--since', '2026-01-01'], ['--limit', '5'], ['--scope', 'all'], ['--include-superseded'], ['--full'],
    ['--no-score'], ['--sort', 'recent'], ['--warn-time-ms', '9999'], ['--warn-count', '9999'],
    ['--history', NEW], ['--read', NEW], ['--read', NEW, '--materialize'],
  ];
  for (const args of accepted) {
    const { code, out } = raw([...args, '--no-track']);
    assert.equal(code, 0, `${args.join(' ')} → ${JSON.stringify(out)}`);
    assert.equal(out.unknown_flag, undefined);
  }
  assert.equal(raw(['--help']).out.status, 'help');
});

t('a valued flag whose value starts with "-" is not misread as an unknown flag', () => {
  assert.equal(raw(['--query', '-negative', '--scope', 'local', '--no-track']).code, 0);
});

t('--help documents --sort recent', () => {
  const help = raw(['--help']).out;
  assert.match(help.usage, /--sort score\|recent/);
  assert.ok(help.notes.some((n) => n.startsWith('--sort recent')));
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
