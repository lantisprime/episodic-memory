/**
 * test-history-walk.mjs — RFC-009 P1a S5: em-search --history multi-parent walk (REQ-14).
 *
 * The walk follows inverted `supersedes` (existing), the scalar `superseded_by`, and a
 * `consolidates` successor, cycle-safe. Single-supersedes chains stay byte-identical; a supersedes
 * FORK is CHARACTERIZED (last-writer-wins, the pre-existing loss deferred in §17-E, not fixed).
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
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// episodes: [{id, supersedes?, superseded_by?, consolidates?:[ids]}]
function mkStore(episodes) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cathist-')));
  const epDir = path.join(cwd, '.episodic-memory', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  for (const ep of episodes) {
    const lines = ['---', `id: ${ep.id}`, 'date: 2026-07-06', 'time: "00:00"', 'project: fx', 'category: lesson', 'status: active'];
    if (ep.supersedes) lines.push(`supersedes: ${ep.supersedes}`);
    if (ep.superseded_by) lines.push(`superseded_by: ${ep.superseded_by}`);
    if (ep.consolidates) lines.push(`consolidates: [${ep.consolidates.join(', ')}]`);
    lines.push('tags: []', `summary: ${ep.id}`, '---', '', '# x', '', 'body', '');
    fs.writeFileSync(path.join(epDir, `${ep.id}.md`), lines.join('\n'));
  }
  spawnSync('node', [EM_REBUILD, '--scope', 'local'], { cwd, encoding: 'utf8' });
  return cwd;
}
function history(cwd, id) {
  const r = spawnSync('node', [EM_SEARCH, '--history', id, '--scope', 'local'], { cwd, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim());
}

t('testHistoryFollowsSupersededBy', () => {
  const cwd = mkStore([{ id: 'A', superseded_by: 'B' }, { id: 'B' }]);
  const r = history(cwd, 'A');
  assert.deepEqual(r.chain.map((e) => e.id), ['A', 'B'], 'follows the superseded_by edge forward');
});

t('testHistorySurfacesConsolidatesSuccessor', () => {
  const cwd = mkStore([{ id: 'M1' }, { id: 'C', consolidates: ['M1'] }]);
  const r = history(cwd, 'M1');
  assert.deepEqual(r.chain.map((e) => e.id), ['M1', 'C'], 'surfaces the consolidates successor');
});

t('testHistorySingleSupersedesUnchanged', () => {
  // root ← c1 ← c2 via supersedes; byte-identical to the pre-change linear walk.
  const cwd = mkStore([{ id: 'root' }, { id: 'c1', supersedes: 'root' }, { id: 'c2', supersedes: 'c1' }]);
  const r = history(cwd, 'root');
  assert.deepEqual(r.chain.map((e) => e.id), ['root', 'c1', 'c2']);
  // querying mid-chain still resolves the root then walks forward
  const r2 = history(cwd, 'c1');
  assert.deepEqual(r2.chain.map((e) => e.id), ['root', 'c1', 'c2']);
});

t('testHistorySupersedesForkCharacterized', () => {
  // root superseded by BOTH b and c (fork). The Map is last-writer-wins, so exactly one child
  // surfaces — the pre-existing loss (§17-E), pinned here so the multi-parent walk does not
  // silently change which child is dropped.
  const cwd = mkStore([{ id: 'root' }, { id: 'b', supersedes: 'root' }, { id: 'c', supersedes: 'root' }]);
  const r = history(cwd, 'root');
  assert.equal(r.chain.length, 2, 'root + exactly one child (fork loss characterized)');
  assert.equal(r.chain[0].id, 'root');
  assert.ok(['b', 'c'].includes(r.chain[1].id), 'the surviving child is one of the fork branches');
});

t('testHistoryCycleSafe', () => {
  // A superseded_by B, B superseded_by A → a cycle. The visited Set must terminate the walk.
  const cwd = mkStore([{ id: 'A', superseded_by: 'B' }, { id: 'B', superseded_by: 'A' }]);
  const r = history(cwd, 'A');
  assert.ok(r.chain.length <= 2, 'cycle terminates without repeating');
  assert.equal(r.chain[0].id, 'A');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
