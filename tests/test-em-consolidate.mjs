/**
 * test-em-consolidate.mjs — semantic consolidation (RFC-001's promised
 * capability): cluster near-duplicates, fold into digest episodes.
 *
 * Rigor contract:
 *   - dry-run (the default) writes NOTHING (byte-level snapshot);
 *   - clustering never crosses project/category boundaries and never picks
 *     up unrelated episodes (the frontmatter-token false-positive class is
 *     regression-pinned: same-day disjoint-body episodes must NOT cluster);
 *   - apply produces a digest whose consolidates[] names every member, whose
 *     body contains every member's content, tags = union, pinned inherited;
 *   - members are superseded + superseded_by in file AND index; search stops
 *     returning them; --history resolves member → digest;
 *   - digests are never re-folded; pinned members excluded by default and
 *     included with --include-pinned; machine categories never fold;
 *   - >5 clusters requires --confirm; post-apply doctor is green.
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

function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else out.set(p, fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcons-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcons-home-')));
  return { cwd, home, env: { HOME: home }, store: path.join(cwd, '.episodic-memory') };
}
function st(fx, args) {
  const r = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', ...args], fx.cwd, fx.env);
  assert.equal(r.json.status, 'ok', r.stdout);
  return r.json.id;
}
function rowsOf(fx) {
  return fs.readFileSync(path.join(fx.store, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

// Shared near-duplicate trio + one unrelated episode.
const DUPES = [
  ['Always use atomic rename for index writes', 'Index rebuilds must go through a temp file plus rename to avoid torn reads.', 'storage,index'],
  ['Atomic rename prevents torn index reads', 'We hit a torn read; the fix is temp file plus atomic rename for every index write.', 'storage'],
  ['Use temp file plus rename for index writes', 'Torn index reads again — atomic rename via temp file is mandatory for index writes.', 'index'],
];
function seedDupes(fx, extraArgs = []) {
  return DUPES.map(([s, b, tags]) => st(fx, ['--category', 'lesson', '--summary', s, '--body', b, '--tags', tags, ...extraArgs]));
}

// ---------------------------------------------------------------------------
const fx1 = mkFixture();
const dupeIds = seedDupes(fx1);
const pgId = st(fx1, ['--category', 'lesson', '--summary', 'Postgres pooling caps at 100', '--body', 'pgbouncer transaction mode limits connections.', '--tags', 'postgres']);

t('dry-run default: reports the true cluster, excludes unrelated, writes NOTHING', () => {
  const before = snapshot(fx1.store);
  const r = run('em-consolidate.mjs', ['--scope', 'local'], fx1.cwd, fx1.env);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.clusters.length, 1);
  assert.deepEqual(r.json.clusters[0].members.map(m => m.id).sort(), [...dupeIds].sort());
  assert.ok(!r.json.clusters[0].members.some(m => m.id === pgId), 'unrelated episode must not cluster');
  const after = snapshot(fx1.store);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [p, v] of before) assert.equal(after.get(p), v, `${p} changed on dry-run`);
});

t('regression (frontmatter-token class): same-day disjoint-body episodes never cluster, even at min-sim 0.3', () => {
  const fx = mkFixture();
  st(fx, ['--category', 'decision', '--summary', 'Choose Kafka for events', '--body', 'Event streaming backbone with consumer groups.', '--tags', 'kafka']);
  st(fx, ['--category', 'decision', '--summary', 'Adopt Terraform modules', '--body', 'Infrastructure layout uses reusable module registry.', '--tags', 'terraform']);
  const r = run('em-consolidate.mjs', ['--scope', 'local', '--min-sim', '0.3'], fx.cwd, fx.env);
  assert.equal(r.json.clusters.length, 0, `shared frontmatter must not create clusters: ${r.stdout}`);
  fs.rmSync(fx.cwd, { recursive: true, force: true }); fs.rmSync(fx.home, { recursive: true, force: true });
});

t('apply: digest consolidates all members, carries union tags + full bodies', () => {
  const r = run('em-consolidate.mjs', ['--scope', 'local', '--apply'], fx1.cwd, fx1.env);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.applied, 1);
  const digestId = r.json.clusters[0].digest_id;
  const row = rowsOf(fx1).find(x => x.id === digestId);
  assert.deepEqual([...row.consolidates].sort(), [...dupeIds].sort());
  assert.deepEqual(row.tags, ['index', 'storage'], 'tags = union, normalized');
  const digestFile = fs.readFileSync(path.join(fx1.store, 'episodes', `${digestId}.md`), 'utf8');
  for (const [summary, body] of DUPES) {
    assert.ok(digestFile.includes(summary), `digest must contain member summary "${summary}"`);
    assert.ok(digestFile.includes(body), 'digest must contain full member body');
  }
});

t('apply: members superseded_by digest in file AND index; search stops returning them; history resolves', () => {
  const digestId = rowsOf(fx1).find(x => Array.isArray(x.consolidates)).id;
  for (const id of dupeIds) {
    const row = rowsOf(fx1).find(x => x.id === id);
    assert.equal(row.status, 'superseded');
    assert.equal(row.superseded_by, digestId);
    const file = fs.readFileSync(path.join(fx1.store, 'episodes', `${id}.md`), 'utf8');
    assert.ok(/^status: superseded$/m.test(file), 'file status must flip');
    assert.ok(file.includes(`superseded_by: ${digestId}`), 'file must carry superseded_by');
  }
  const search = run('em-search.mjs', ['--query', 'atomic rename index', '--scope', 'local', '--no-track'], fx1.cwd, fx1.env);
  assert.equal(search.json.count, 1, 'only the digest surfaces');
  assert.equal(search.json.episodes[0].id, digestId);
  const hist = run('em-search.mjs', ['--history', dupeIds[0], '--scope', 'local', '--no-track'], fx1.cwd, fx1.env);
  assert.ok(hist.json.chain.some(c => c.id === digestId), `history must reach the digest: ${hist.stdout}`);
});

t('post-apply doctor green; re-run finds nothing (digests never re-fold)', () => {
  const doc = run('em-doctor.mjs', ['--scope', 'local'], fx1.cwd, fx1.env);
  const bad = doc.json.checks.filter(c => c.level === 'error');
  assert.deepEqual(bad, [], JSON.stringify(bad));
  const again = run('em-consolidate.mjs', ['--scope', 'local'], fx1.cwd, fx1.env);
  assert.equal(again.json.clusters.length, 0);
});

t('pinned members excluded by default, included with --include-pinned (digest inherits pin)', () => {
  const fx = mkFixture();
  const ids = seedDupes(fx, ['--pin']);
  let r = run('em-consolidate.mjs', ['--scope', 'local'], fx.cwd, fx.env);
  assert.equal(r.json.clusters.length, 0, 'pinned members must not fold by default');
  r = run('em-consolidate.mjs', ['--scope', 'local', '--include-pinned', '--apply'], fx.cwd, fx.env);
  assert.equal(r.json.applied, 1, r.stdout);
  const digest = rowsOf(fx).find(x => Array.isArray(x.consolidates));
  assert.equal(digest.pinned, true, 'digest must inherit pinning');
  assert.deepEqual([...digest.consolidates].sort(), [...ids].sort());
  fs.rmSync(fx.cwd, { recursive: true, force: true }); fs.rmSync(fx.home, { recursive: true, force: true });
});

t('cross-project and machine-category episodes never fold together', () => {
  const fx = mkFixture();
  // identical bodies but different projects
  st(fx, ['--category', 'lesson', '--summary', 'Same lesson text', '--body', 'identical body wording for the pair.', '--tags', 'x']);
  const r0 = run('em-store.mjs', ['--project', 'other', '--scope', 'local', '--category', 'lesson', '--summary', 'Same lesson text', '--body', 'identical body wording for the pair.', '--tags', 'x'], fx.cwd, fx.env);
  assert.equal(r0.json.status, 'ok');
  // identical bodies in an excluded category
  st(fx, ['--category', 'violation', '--summary', 'Same violation text', '--body', 'identical violation body wording.', '--tags', 'v']);
  st(fx, ['--category', 'violation', '--summary', 'Same violation text again', '--body', 'identical violation body wording.', '--tags', 'v']);
  const r = run('em-consolidate.mjs', ['--scope', 'local', '--min-sim', '0.3'], fx.cwd, fx.env);
  assert.equal(r.json.clusters.length, 0, `neither cross-project nor violation episodes may cluster: ${r.stdout}`);
  fs.rmSync(fx.cwd, { recursive: true, force: true }); fs.rmSync(fx.home, { recursive: true, force: true });
});

t('>5 clusters requires --confirm; usage errors exit 2', () => {
  const fx = mkFixture();
  for (let g = 0; g < 6; g++) {
    // six independent projects, each with its own near-duplicate pair
    for (const suffix of ['first wording of the shared topic body', 'second wording of the shared topic body']) {
      const r = run('em-store.mjs', ['--project', `p${g}`, '--scope', 'local', '--category', 'lesson',
        '--summary', `topic ${g} lesson`, '--body', `cluster topic ${g}: ${suffix}.`, '--tags', `t${g}`], fx.cwd, fx.env);
      assert.equal(r.json.status, 'ok');
    }
  }
  const preview = run('em-consolidate.mjs', ['--scope', 'local', '--min-sim', '0.3'], fx.cwd, fx.env);
  assert.equal(preview.json.clusters.length, 6, preview.stdout);
  const refuse = run('em-consolidate.mjs', ['--scope', 'local', '--min-sim', '0.3', '--apply'], fx.cwd, fx.env);
  assert.equal(refuse.code, 2);
  assert.ok(refuse.json.message.includes('--confirm'));
  const go = run('em-consolidate.mjs', ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'], fx.cwd, fx.env);
  assert.equal(go.json.applied, 6, go.stdout);
  assert.equal(run('em-consolidate.mjs', ['--scope', 'all'], fx.cwd, fx.env).code, 2, 'scope all rejected (single-scope by design)');
  assert.equal(run('em-consolidate.mjs', ['--min-sim', '2'], fx.cwd, fx.env).code, 2);
  fs.rmSync(fx.cwd, { recursive: true, force: true }); fs.rmSync(fx.home, { recursive: true, force: true });
});

fs.rmSync(fx1.cwd, { recursive: true, force: true });
fs.rmSync(fx1.home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
