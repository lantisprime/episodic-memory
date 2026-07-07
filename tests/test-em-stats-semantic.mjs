/**
 * test-em-stats-semantic.mjs — em-stats analytics + embeddings sidecar
 * (em-embed) + similarity search (em-semantic).
 *
 * Rigor contract:
 *   - stats numbers are asserted against a hand-constructed fixture
 *     (categories, superseded, pinned, feedback, age buckets, archived,
 *     prunable estimate) — not just "output exists";
 *   - stats is verified READ-ONLY (byte-level store snapshot unchanged);
 *   - hash embeddings are deterministic; incremental em-embed re-embeds
 *     exactly the changed/new episodes, drops stale rows, reuses the rest;
 *   - semantic ranking is asserted with a REAL external cmd embedder
 *     (python3, token-overlap vectors) — right episode on top, model
 *     mismatch refused, superseded excluded, min-sim/project filters work;
 *   - error paths: missing sidecar, failing embed command, missing --cmd.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashEmbed, cosine, buildIdf } from '../scripts/lib/embeddings.mjs';

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

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emstats-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emstats-home-')));
const env = { HOME: home };
const store = path.join(cwd, '.episodic-memory');

function st(args) {
  const r = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', ...args], cwd, env);
  assert.equal(r.json.status, 'ok', r.stdout);
  return r.json.id;
}

// Fixture: 2 decisions (1 pinned), 1 lesson (later superseded), 1 discovery,
// feedback +2/-1 spread, one ancient prunable row, one archived row.
const d1 = st(['--category', 'decision', '--summary', 'JWT auth token expiry handling', '--body', 'Access tokens expire after 15 minutes; refresh token rotates.', '--tags', 'auth,jwt']);
const d2 = st(['--category', 'decision', '--summary', 'Adopt pgbouncer for pooling', '--body', 'Postgres connection pooling via pgbouncer transaction mode.', '--tags', 'postgres', '--pin']);
const l1 = st(['--category', 'lesson', '--summary', 'Session cookie lifetime tuning', '--body', 'Long cookie lifetimes caused stale auth sessions in production.', '--tags', 'auth,sessions']);
const disc = st(['--category', 'discovery', '--summary', 'Redis eviction policy surprise', '--body', 'allkeys-lru evicted queue keys under memory pressure.', '--tags', 'redis']);
const rev = run('em-revise.mjs', ['--original', l1, '--summary', 'Session cookie lifetime tuning v2', '--body', 'Short lifetimes plus sliding refresh fixed stale auth sessions.'], cwd, env).json.id;
run('em-feedback.mjs', ['--id', d1, '--useful'], cwd, env);
run('em-feedback.mjs', ['--id', d1, '--useful'], cwd, env);
run('em-feedback.mjs', ['--id', disc, '--noise'], cwd, env);
// ancient prunable row (hand-aged via index rewrite, file untouched)
{
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const aged = rows.map(r => r.id === disc ? { ...r, date: '2020-01-01' } : r);
  fs.writeFileSync(path.join(store, 'index.jsonl'), aged.map(r => JSON.stringify(r)).join('\n') + '\n');
}
fs.writeFileSync(path.join(store, 'archived-index.jsonl'), JSON.stringify({ id: '20200101-000000-old-aaaa' }) + '\n');

// ---------------------------------------------------------------------------
// em-stats
// ---------------------------------------------------------------------------
t('stats: exact totals, categories, superseded, pinned, feedback, archived, prunable', () => {
  const before = snapshot(store);
  const r = run('em-stats.mjs', ['--scope', 'local'], cwd, env);
  assert.equal(r.code, 0);
  const s = r.json.scopes[0];
  assert.equal(s.episodes.total, 5, 'store + revise = 5 rows');
  assert.equal(s.episodes.superseded, 1);
  assert.equal(s.episodes.active, 4);
  assert.equal(s.episodes.pinned, 1);
  assert.deepEqual(s.by_category, { decision: 2, lesson: 2, discovery: 1 });
  assert.equal(s.feedback.positive, 2);
  assert.equal(s.feedback.negative, 1);
  assert.equal(s.feedback.net, 1);
  assert.equal(s.archived, 1);
  assert.equal(s.prunable_estimate, 1, 'exactly the aged unpinned discovery');
  assert.equal(s.age_buckets.older, 1);
  assert.equal(s.age_buckets.last_7d, 4);
  assert.equal(s.date_range.oldest, '2020-01-01');
  assert.ok(s.index_files['tokens.json'].present);
  assert.equal(r.json.totals.episodes, 5);
  // READ-ONLY: byte-identical store after stats
  const after = snapshot(store);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [p, v] of before) assert.equal(after.get(p), v, `${p} changed`);
});

t('stats: pinned episodes never count as prunable even when ancient', () => {
  const rows = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  const aged = rows.map(r => r.id === d2 ? { ...r, date: '2019-01-01' } : r);
  fs.writeFileSync(path.join(store, 'index.jsonl'), aged.map(r => JSON.stringify(r)).join('\n') + '\n');
  const s = run('em-stats.mjs', ['--scope', 'local'], cwd, env).json.scopes[0];
  assert.equal(s.prunable_estimate, 1, 'pinned ancient row must not join the estimate');
  // restore
  fs.writeFileSync(path.join(store, 'index.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
});

t('stats: invalid scope exits 1', () => {
  assert.equal(run('em-stats.mjs', ['--scope', 'bogus'], cwd, env).code, 1);
});

// ---------------------------------------------------------------------------
// hash provider unit properties
// ---------------------------------------------------------------------------
t('hashEmbed: deterministic, L2-normalized, overlap-sensitive', () => {
  const a1 = hashEmbed('jwt auth token expiry');
  const a2 = hashEmbed('jwt auth token expiry');
  assert.deepEqual(a1, a2, 'deterministic');
  const norm = Math.sqrt(a1.reduce((n, x) => n + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `unit norm, got ${norm}`);
  const near = cosine(a1, hashEmbed('auth token refresh expiry'));
  const far = cosine(a1, hashEmbed('postgres connection pooling'));
  assert.ok(near > far, `overlapping text must be nearer (${near} vs ${far})`);
});

t('buildIdf: rare tokens outweigh common ones', () => {
  const idf = buildIdf([{ common: ['a', 'b', 'c', 'd'], rare: ['a'] }]);
  assert.ok(idf.get('rare') > idf.get('common'));
});

// ---------------------------------------------------------------------------
// em-embed lifecycle
// ---------------------------------------------------------------------------
t('embed: builds sidecar for active episodes only; incremental reuse; revise re-embeds', () => {
  const r1 = run('em-embed.mjs', ['--scope', 'local'], cwd, env);
  assert.equal(r1.code, 0, r1.stdout);
  assert.equal(r1.json.scopes[0].embedded, 4, 'active rows only (superseded l1 excluded)');
  const r2 = run('em-embed.mjs', ['--scope', 'local'], cwd, env);
  assert.equal(r2.json.scopes[0].embedded, 0);
  assert.equal(r2.json.scopes[0].reused, 4);
  // revising an episode supersedes it → its sidecar row drops, successor embeds
  const rev2 = run('em-revise.mjs', ['--original', disc, '--summary', 'Redis eviction policy surprise v2', '--body', 'switched to volatile-lru.'], cwd, env).json.id;
  const r3 = run('em-embed.mjs', ['--scope', 'local'], cwd, env);
  assert.equal(r3.json.scopes[0].embedded, 1, 'only the new revision embeds');
  assert.equal(r3.json.scopes[0].dropped, 1, 'superseded original drops');
  const side = fs.readFileSync(path.join(store, 'embeddings.jsonl'), 'utf8');
  assert.ok(side.includes(rev2) && !side.includes(`"${disc}"`), 'sidecar rows follow the revision');
});

t('embed: cmd provider errors propagate (failing command → exit 1, no partial write)', () => {
  const before = fs.readFileSync(path.join(store, 'embeddings.jsonl'), 'utf8');
  const r = run('em-embed.mjs', ['--scope', 'local', '--cmd', 'false', '--rebuild'], cwd, env);
  assert.equal(r.code, 1);
  assert.equal(r.json.status, 'error');
  assert.equal(fs.readFileSync(path.join(store, 'embeddings.jsonl'), 'utf8'), before, 'sidecar untouched on failure');
  const r2 = run('em-embed.mjs', ['--scope', 'local', '--provider', 'cmd'], cwd, env);
  assert.equal(r2.code, 1, 'cmd provider without --cmd/$EM_EMBED_CMD refused');
});

// ---------------------------------------------------------------------------
// em-semantic with a REAL external embedder (token-overlap vectors)
// ---------------------------------------------------------------------------
const embedder = path.join(cwd, 'embedder.py');
fs.writeFileSync(embedder, `
import sys, json, hashlib
DIM = 64
for line in sys.stdin:
    row = json.loads(line)
    v = [0.0] * DIM
    for tok in row["text"].lower().split():
        tok = ''.join(c for c in tok if c.isalnum())
        if len(tok) < 2: continue
        h = int.from_bytes(hashlib.sha256(tok.encode()).digest()[:4], 'big')
        v[h % DIM] += 1.0
    n = sum(x*x for x in v) ** 0.5 or 1.0
    print(json.dumps({"id": row["id"], "vector": [x / n for x in v]}))
`);

t('semantic (cmd embedder): topical query ranks the right episode first', () => {
  const r = run('em-embed.mjs', ['--scope', 'local', '--cmd', `python3 ${embedder}`, '--model', 'tok-overlap', '--rebuild'], cwd, env);
  assert.equal(r.code, 0, r.stdout);
  const q = run('em-semantic.mjs', ['--query', 'jwt token expiry refresh', '--scope', 'local', '--cmd', `python3 ${embedder}`, '--model', 'tok-overlap', '--no-track', '--min-sim', '0.01'], cwd, env);
  assert.equal(q.code, 0, q.stdout);
  assert.ok(q.json.count >= 1);
  assert.ok(q.json.episodes[0].summary.startsWith('JWT auth token expiry'), `expected JWT episode on top: ${q.stdout}`);
  assert.ok(q.json.episodes[0].similarity > 0.3);
  assert.ok(q.json.episodes.every(e => e.similarity >= 0.01), 'min-sim respected');
  assert.ok(!q.json.episodes.some(e => e.id === l1), 'superseded episodes never surface');
});

t('semantic: model mismatch refused; missing sidecar refused; project filter works', () => {
  const mm = run('em-semantic.mjs', ['--query', 'x', '--scope', 'local', '--no-track'], cwd, env);
  assert.equal(mm.code, 1, 'hash query against tok-overlap sidecar must refuse');
  assert.ok(mm.json.message.includes('model'));
  const pf = run('em-semantic.mjs', ['--query', 'jwt token expiry', '--scope', 'local', '--cmd', `python3 ${embedder}`, '--model', 'tok-overlap', '--no-track', '--project', 'other', '--min-sim', '0'], cwd, env);
  assert.equal(pf.json.count, 0, 'project filter must apply');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'emsem-empty-'));
  const ms = run('em-semantic.mjs', ['--query', 'x', '--scope', 'local'], empty, env);
  assert.equal(ms.code, 1);
  assert.ok(ms.json.message.includes('em-embed'));
  fs.rmSync(empty, { recursive: true, force: true });
});

t('embed-config.json: zero-flag resolution for BOTH scripts; flags override it', () => {
  // persist the cmd provider in config; em-embed and em-semantic must both
  // pick it up with no flags (mismatched resolution would trip the model
  // refusal on every query)
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true });
  const cfgPath = path.join(home, '.episodic-memory', 'embed-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: 'cmd', cmd: `python3 ${embedder}`, model: 'cfg-model' }));
  const e = run('em-embed.mjs', ['--scope', 'local', '--rebuild'], cwd, env);
  assert.equal(e.code, 0, e.stdout);
  assert.equal(e.json.scopes[0].model, 'cfg-model');
  const q = run('em-semantic.mjs', ['--query', 'jwt token expiry', '--scope', 'local', '--no-track', '--min-sim', '0'], cwd, env);
  assert.equal(q.code, 0, q.stdout);
  assert.equal(q.json.model, 'cfg-model', 'em-semantic must resolve the same config');
  // explicit flags beat the config
  const f = run('em-embed.mjs', ['--scope', 'local', '--provider', 'hash', '--model', 'hash-v1-256', '--rebuild'], cwd, env);
  assert.equal(f.json.scopes[0].model, 'hash-v1-256');
  // malformed config degrades to hash, never crashes
  fs.writeFileSync(cfgPath, 'NOT-JSON');
  const m = run('em-embed.mjs', ['--scope', 'local', '--rebuild'], cwd, env);
  assert.equal(m.code, 0);
  assert.equal(m.json.scopes[0].model, 'hash-v1-256');
  fs.rmSync(cfgPath);
});

t('semantic: hash provider end-to-end with tracking side-effect contract', () => {
  run('em-embed.mjs', ['--scope', 'local', '--rebuild'], cwd, env); // back to hash model
  const before = fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8');
  const noTrack = run('em-semantic.mjs', ['--query', 'auth token expiry', '--scope', 'local', '--no-track', '--min-sim', '0.05'], cwd, env);
  assert.equal(noTrack.code, 0);
  assert.ok(noTrack.json.count >= 1);
  assert.equal(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'), before, '--no-track must not touch counters');
  const tracked = run('em-semantic.mjs', ['--query', 'auth token expiry', '--scope', 'local', '--min-sim', '0.05'], cwd, env);
  assert.equal(tracked.code, 0);
  assert.notEqual(fs.readFileSync(path.join(store, 'index.jsonl'), 'utf8'), before, 'tracked search must bump access counters');
});

fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
