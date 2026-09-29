#!/usr/bin/env node
/**
 * test-history-fork-branches.mjs — #458: em-search --history returns EVERY branch of a fork.
 *
 * Pre-fix the forward walk keyed successors in a single-successor Map (last writer wins), so a
 * root revised twice (`em-revise --original R` run for two children) returned {count:2,
 * chain:[root, <one child>]} and the other child was silently absent. The walk is now
 * multi-successor, depth-first, siblings ordered oldest-first by the shared recency comparator
 * (#621), with a `terminals` field when the walk forks. The #634b anchored walk is kept: the
 * requested id is always in its own history, and siblings of the anchor are not "forward" of it.
 *
 * Runs the REAL scripts (em-store/em-revise/em-rebuild-index/em-search) in an isolated non-git
 * scratch dir with HOME isolated and --scope local on every write.
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-histfork-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'w');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  return { cwd, env: { ...process.env, HOME: home } };
}
function run(box, script, args) {
  const r = spawnSync('node', [S(script), ...args], { cwd: box.cwd, env: box.env, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim());
  return { code: r.status, out };
}
function history(box, id) {
  const { code, out } = run(box, 'em-search.mjs', ['--history', id, '--scope', 'local']);
  assert.equal(code, 0);
  assert.equal(out.status, 'ok');
  return out;
}

// Hand-written episodes (distinct timestamps) + real rebuild: lets a fixture pin sibling ORDER
// independently of index row order.
function mkStore(episodes) {
  const box = sandbox();
  const epDir = path.join(box.cwd, '.episodic-memory', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  for (const ep of episodes) {
    const lines = ['---', `id: ${ep.id}`, `date: ${ep.date || '2026-07-06'}`, `time: "${ep.time || '00:00'}"`,
      'project: fx', 'category: decision', 'status: active'];
    if (ep.supersedes) lines.push(`supersedes: ${ep.supersedes}`);
    if (ep.consolidates) lines.push(`consolidates: [${ep.consolidates.join(', ')}]`);
    lines.push('tags: []', `summary: ${ep.id}`, '---', '', '# x', '', 'body', '');
    fs.writeFileSync(path.join(epDir, `${ep.id}.md`), lines.join('\n'));
  }
  assert.equal(run(box, 'em-rebuild-index.mjs', ['--scope', 'local']).code, 0);
  return box;
}

t('real em-revise fork: history(root) returns root AND both children (was count 2, childA dropped)', () => {
  const box = sandbox();
  const root = run(box, 'em-store.mjs', ['--scope', 'local', '--project', 'p', '--category', 'decision',
    '--summary', 'root decision', '--body', 'root', '--tags', 'x']).out.id;
  const a = run(box, 'em-revise.mjs', ['--original', root, '--project', 'p', '--summary', 'child A',
    '--body', 'A', '--scope', 'local']).out.id;
  const b = run(box, 'em-revise.mjs', ['--original', root, '--project', 'p', '--summary', 'child B',
    '--body', 'B', '--scope', 'local']).out.id;
  const h = history(box, root);
  const ids = h.chain.map((e) => e.id);
  assert.equal(h.count, 3, `expected 3 members, got ${JSON.stringify(ids)}`);
  assert.equal(ids[0], root);
  assert.deepEqual([...ids.slice(1)].sort(), [a, b].sort(), 'both fork branches present');
  assert.deepEqual([...h.terminals].sort(), [a, b].sort(), 'terminals names each branch leaf');
});

t('sibling order is oldest-first by recency, independent of index row order', () => {
  // c is OLDER than b but sorts after it by id; index rows are in id order after rebuild.
  const box = mkStore([
    { id: '20260706-000000-root', time: '00:00' },
    { id: '20260706-020000-b', time: '02:00', supersedes: '20260706-000000-root' },
    { id: '20260706-010000-c', time: '01:00', supersedes: '20260706-000000-root' },
  ]);
  const h = history(box, '20260706-000000-root');
  assert.deepEqual(h.chain.map((e) => e.id),
    ['20260706-000000-root', '20260706-010000-c', '20260706-020000-b']);
  assert.deepEqual(h.terminals, ['20260706-010000-c', '20260706-020000-b']);
});

t('nested fork: depth-first, each branch contiguous', () => {
  const box = mkStore([
    { id: '20260706-000000-r', time: '00:00' },
    { id: '20260706-010000-a', time: '01:00', supersedes: '20260706-000000-r' },
    { id: '20260706-020000-b', time: '02:00', supersedes: '20260706-000000-r' },
    { id: '20260706-030000-a1', time: '03:00', supersedes: '20260706-010000-a' },
  ]);
  const h = history(box, '20260706-000000-r');
  assert.deepEqual(h.chain.map((e) => e.id),
    ['20260706-000000-r', '20260706-010000-a', '20260706-030000-a1', '20260706-020000-b']);
  assert.deepEqual(h.terminals, ['20260706-030000-a1', '20260706-020000-b']);
});

t('anchored walk (#634b) kept: history(branch) = spine + its own forward line, sibling excluded', () => {
  const box = mkStore([
    { id: '20260706-000000-r', time: '00:00' },
    { id: '20260706-010000-a', time: '01:00', supersedes: '20260706-000000-r' },
    { id: '20260706-020000-b', time: '02:00', supersedes: '20260706-000000-r' },
    { id: '20260706-030000-a1', time: '03:00', supersedes: '20260706-010000-a' },
  ]);
  const h = history(box, '20260706-010000-a');
  assert.deepEqual(h.chain.map((e) => e.id), ['20260706-000000-r', '20260706-010000-a', '20260706-030000-a1']);
  assert.equal(h.terminals, undefined, 'no fork forward of the anchor → no terminals field');
});

t('two consolidations of one member: both surface (byConsolidates was last-writer-wins too)', () => {
  const box = mkStore([
    { id: '20260706-000000-m', time: '00:00' },
    { id: '20260706-010000-c1', time: '01:00', consolidates: ['20260706-000000-m'] },
    { id: '20260706-020000-c2', time: '02:00', consolidates: ['20260706-000000-m'] },
  ]);
  const h = history(box, '20260706-000000-m');
  assert.deepEqual(h.chain.map((e) => e.id), ['20260706-000000-m', '20260706-010000-c1', '20260706-020000-c2']);
});

t('diamond: a node reachable along two branches is emitted once', () => {
  const box = mkStore([
    { id: '20260706-000000-r', time: '00:00' },
    { id: '20260706-010000-a', time: '01:00', supersedes: '20260706-000000-r' },
    { id: '20260706-020000-b', time: '02:00', supersedes: '20260706-000000-r' },
    { id: '20260706-030000-d', time: '03:00', consolidates: ['20260706-010000-a', '20260706-020000-b'] },
  ]);
  const ids = history(box, '20260706-000000-r').chain.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids ${JSON.stringify(ids)}`);
  assert.deepEqual(ids, ['20260706-000000-r', '20260706-010000-a', '20260706-030000-d', '20260706-020000-b']);
});

t('linear chain output shape unchanged (no terminals field)', () => {
  const box = mkStore([
    { id: '20260706-000000-r', time: '00:00' },
    { id: '20260706-010000-c1', time: '01:00', supersedes: '20260706-000000-r' },
  ]);
  const h = history(box, '20260706-000000-r');
  assert.deepEqual(Object.keys(h), ['status', 'count', 'chain']);
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
