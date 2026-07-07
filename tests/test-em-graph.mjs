/**
 * test-em-graph.mjs — RFC-007 core: typed-edge traversal over the episode
 * graph. Real scripts against an isolated fixture store.
 *
 * Fixture graph (built through the real writers):
 *   A --revised--> B (supersedes B→A)
 *   C cites B in its body (plus a fake id inside backticks that must NOT edge)
 *   digest E consolidates {C2a, C2b}
 *   D is an island (only tag edges)
 *   A/C/D share or split tags for the tag-edge test
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

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgraph-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgraph-home-')));
const env = { HOME: home };

function run(script, args) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}
function st(args) {
  const r = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', ...args]);
  assert.equal(r.json.status, 'ok', r.stdout);
  return r.json.id;
}

const A = st(['--category', 'decision', '--summary', 'root decision A', '--body', 'chose X', '--tags', 'alpha']);
const B = run('em-revise.mjs', ['--original', A, '--summary', 'revised decision B', '--body', 'chose Y instead']).json.id;
const C = st(['--category', 'lesson', '--summary', 'lesson citing B', '--body', `learned from ${B} that Y wins. fake in code: \`20200101-000000-fake-aaaa\``, '--tags', 'alpha']);
const D = st(['--category', 'discovery', '--summary', 'island D', '--body', 'isolated', '--tags', 'beta']);
// consolidation cluster → digest with consolidates edges
const C2a = st(['--category', 'context', '--summary', 'duplicate note one about redis eviction tuning', '--body', 'redis eviction policy allkeys-lru surprised the queue consumers badly.', '--tags', 'redis']);
const C2b = st(['--category', 'context', '--summary', 'duplicate note two about redis eviction tuning', '--body', 'redis eviction policy allkeys-lru surprised the queue consumers again.', '--tags', 'redis']);
const cons = run('em-consolidate.mjs', ['--scope', 'local', '--apply']);
assert.equal(cons.json.applied, 1, cons.stdout);
const E = cons.json.clusters[0].digest_id;

t('traversal from A: supersedes + cites lineage at correct distances, true edge directions', () => {
  const r = run('em-graph.mjs', ['--from', A, '--scope', 'local']);
  assert.equal(r.code, 0, r.stdout);
  const byId = Object.fromEntries(r.json.nodes.map(n => [n.id, n]));
  assert.equal(byId[A].distance, 0);
  assert.equal(byId[B].distance, 1);
  assert.equal(byId[C].distance, 2);
  assert.equal(byId[A].status, 'superseded', 'lineage keeps superseded nodes, marked');
  assert.ok(r.json.edges.some(e => e.type === 'supersedes' && e.from === B && e.to === A));
  assert.ok(r.json.edges.some(e => e.type === 'cites' && e.from === C && e.to === B));
  assert.ok(!r.json.edges.some(e => e.type === 'cites' && e.from === B), 'frontmatter ids must not fabricate cites edges');
  assert.ok(!r.json.nodes.some(n => n.id.includes('fake')), 'backticked ids never edge');
  assert.ok(!r.json.nodes.some(n => n.id === D), 'islands unreachable without tag edges');
});

t('depth and limit bound the frontier; truncated flagged', () => {
  const d1 = run('em-graph.mjs', ['--from', A, '--depth', '1', '--scope', 'local']);
  assert.deepEqual(d1.json.nodes.map(n => n.id).sort(), [A, B].sort());
  const lim = run('em-graph.mjs', ['--from', A, '--limit', '2', '--scope', 'local']);
  assert.equal(lim.json.count, 2);
  assert.equal(lim.json.truncated, true);
});

t('consolidates edges: digest → members', () => {
  const r = run('em-graph.mjs', ['--from', E, '--scope', 'local']);
  const ids = r.json.nodes.map(n => n.id);
  assert.ok(ids.includes(C2a) && ids.includes(C2b), r.stdout);
  assert.equal(r.json.edges.filter(e => e.type === 'consolidates' && e.from === E).length, 2);
});

t('tags edges are opt-in pseudo-nodes; default traversal never crosses tags', () => {
  const tagged = run('em-graph.mjs', ['--from', C, '--edges', 'tags', '--scope', 'local']);
  const ids = tagged.json.nodes.map(n => n.id);
  assert.ok(ids.includes('tag:alpha'), tagged.stdout);
  assert.ok(ids.includes(A), 'tag co-membership reachable through the tag node (superseded co-member included for lineage)');
  assert.ok(tagged.json.nodes.find(n => n.id === 'tag:alpha').type === 'tag');
  const def = run('em-graph.mjs', ['--from', D, '--scope', 'local']);
  assert.equal(def.json.count, 1, 'island stays alone under default edges');
});

t('orphans and hubs (non-tag degree over active rows)', () => {
  const o = run('em-graph.mjs', ['--orphans', '--scope', 'local']);
  assert.deepEqual(o.json.nodes.map(n => n.id), [D], o.stdout);
  const h = run('em-graph.mjs', ['--hubs', '--scope', 'local', '--top', '1']);
  assert.equal(h.json.nodes[0].id, E, 'digest with consolidates+supersedes edges per member is the top hub');
  assert.equal(h.json.nodes[0].degree, 4, 'consolidates + supersedes edge per member');
});

t('errors: unknown --from exit 1; bad edge type / mode combos exit 2', () => {
  assert.equal(run('em-graph.mjs', ['--from', '20200101-000000-nope-aaaa', '--scope', 'local']).code, 1);
  assert.equal(run('em-graph.mjs', ['--from', A, '--edges', 'wormholes']).code, 2);
  assert.equal(run('em-graph.mjs', []).code, 2);
  assert.equal(run('em-graph.mjs', ['--from', A, '--orphans']).code, 2);
});

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
