#!/usr/bin/env node
/**
 * test-revise-tag-replace.mjs — #506: em-revise can replace or remove inherited tags.
 *
 * Pre-fix `em-revise --original T --tags a` on an original tagged [a, staletag] produced
 * `tags: [a, staletag]` — tags were always unioned, so a revision could never shed a tag. The
 * default union is kept; `--replace-tags` makes the passed tags replace the inherited set, and
 * `--remove-tag <t>` / `--remove-tags <t1,t2>` drop tags from the result. Frontmatter, index row,
 * tags.json and tokens.json must agree, and a full em-rebuild-index must reproduce the same
 * tags.json.
 *
 * Real scripts, isolated non-git scratch dir, HOME isolated, --scope local on every write.
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

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-tagrepl-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'w');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  return { cwd, env: { ...process.env, HOME: home }, dir: path.join(cwd, '.episodic-memory') };
}
function run(box, script, args) {
  const r = spawnSync('node', [S(script), ...args], { cwd: box.cwd, env: box.env, encoding: 'utf8' });
  return { code: r.status, out: JSON.parse(r.stdout.trim()) };
}
function original(box) {
  const r = run(box, 'em-store.mjs', ['--scope', 'local', '--project', 'p', '--category', 'decision',
    '--summary', 'orig decision', '--body', 'orig body', '--tags', 'keeptag,staletag']);
  assert.equal(r.code, 0);
  return r.out.id;
}
function revise(box, orig, extra) {
  const r = run(box, 'em-revise.mjs', ['--original', orig, '--project', 'p', '--summary', 'revised decision',
    '--body', 'revised body', '--scope', 'local', ...extra]);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  return r.out.id;
}
function fmTags(box, id) {
  const txt = fs.readFileSync(path.join(box.dir, 'episodes', `${id}.md`), 'utf8');
  return txt.match(/^tags: \[(.*)\]$/m)[1].split(',').map((s) => s.trim()).filter(Boolean);
}
function indexRow(box, id) {
  return fs.readFileSync(path.join(box.dir, 'index.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).find((r) => r.id === id);
}
const readJson = (box, f) => JSON.parse(fs.readFileSync(path.join(box.dir, f), 'utf8'));
function tagsIndexFor(box, id) {
  const idx = readJson(box, 'tags.json');
  return Object.keys(idx).filter((k) => idx[k].includes(id)).sort();
}
function assertConsistent(box, id, expected) {
  assert.deepEqual(fmTags(box, id), expected, 'frontmatter');
  assert.deepEqual(indexRow(box, id).tags, expected, 'index row');
  assert.deepEqual(tagsIndexFor(box, id), expected, 'tags.json');
}

t('default revision still UNIONS tags (behaviour preserved)', () => {
  const box = sandbox();
  const o = original(box);
  const r = revise(box, o, ['--tags', 'keeptag']);
  assertConsistent(box, r, ['keeptag', 'staletag']);
});

t('--replace-tags: passed tags replace the inherited set; consistent everywhere', () => {
  const box = sandbox();
  const o = original(box);
  const r = revise(box, o, ['--replace-tags', '--tags', 'keeptag,newtag']);
  assertConsistent(box, r, ['keeptag', 'newtag']);
  assert.deepEqual(fmTags(box, o), ['keeptag', 'staletag'], 'the original keeps its own tags (history intact)');
  const tokens = readJson(box, 'tokens.json');
  assert.ok(!(tokens.staletag || []).includes(r), 'tokens.json does not index the dropped tag for the revision');
  assert.ok((tokens.newtag || []).includes(r), 'tokens.json indexes the new tag');
  // tag-scoped search no longer surfaces the revision chain via the dropped tag
  const s = run(box, 'em-search.mjs', ['--tag', 'staletag', '--scope', 'local', '--no-track']).out;
  assert.equal(s.count, 0, 'the superseded original is hidden and the revision no longer carries the tag');
});

t('--remove-tag: drops one inherited tag, keeps the rest (repeatable, and --remove-tags csv)', () => {
  const box = sandbox();
  const o = original(box);
  const r1 = revise(box, o, ['--remove-tag', 'staletag']);
  assertConsistent(box, r1, ['keeptag']);
  const r2 = revise(box, r1, ['--tags', 'x,y,z', '--remove-tags', 'x,y']);
  assertConsistent(box, r2, ['keeptag', 'z']);
  const r3 = revise(box, r2, ['--remove-tag', 'keeptag', '--remove-tag', 'z', '--tags', 'final']);
  assertConsistent(box, r3, ['final']);
});

t('em-rebuild-index reproduces the same tags.json after replace/remove revisions', () => {
  const box = sandbox();
  const o = original(box);
  const r = revise(box, o, ['--replace-tags', '--tags', 'onlytag']);
  const before = readJson(box, 'tags.json');
  assert.equal(run(box, 'em-rebuild-index.mjs', ['--scope', 'local']).code, 0);
  const after = readJson(box, 'tags.json');
  const norm = (idx) => Object.fromEntries(Object.keys(idx).sort().map((k) => [k, [...idx[k]].sort()]));
  assert.deepEqual(norm(after), norm(before));
  assert.deepEqual(indexRow(box, r).tags, ['onlytag']);
});

t('--remove-tag without a value is rejected BEFORE any write', () => {
  const box = sandbox();
  const o = original(box);
  const indexBefore = fs.readFileSync(path.join(box.dir, 'index.jsonl'), 'utf8');
  for (const args of [['--remove-tag'], ['--remove-tags'], ['--remove-tag', '--tags', 'a']]) {
    const r = run(box, 'em-revise.mjs', ['--original', o, '--project', 'p', '--summary', 's', '--body', 'b',
      '--scope', 'local', ...args]);
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.out.status, 'error');
  }
  assert.equal(fs.readFileSync(path.join(box.dir, 'index.jsonl'), 'utf8'), indexBefore, 'original not superseded');
});

t('--help documents the union default and the opt-outs', () => {
  const box = sandbox();
  const help = run(box, 'em-revise.mjs', ['--help']).out;
  assert.match(help.usage, /--replace-tags/);
  assert.match(help.usage, /--remove-tag/);
  assert.ok(help.notes.some((n) => /UNION/.test(n)));
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
