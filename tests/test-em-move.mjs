/**
 * test-em-move.mjs — RFC-005 em-move: atomic scope relocation.
 *
 * Rigor contract (beyond smoke):
 *   - every refusal path is verified to write NOTHING (recursive store
 *     snapshot compared byte-for-byte before/after);
 *   - every successful move is verified against the full index invariant:
 *     the id appears in EXACTLY the destination's index.jsonl, tags.json,
 *     category-index.json, and tokens.json, and in NONE of the source's;
 *   - counters (access_count, last_accessed, feedback) and pinned survive;
 *   - both-scopes recovery (identical → completes; different → hard error);
 *   - anchor gate, >10 --confirm gate, frontmatter-mismatch gate,
 *     full-id-only gate, --filter-tag selects from index not tags.json;
 *   - supersedes chain split across scopes still resolves via --history;
 *   - audit episode lands in the destination scope with the step bitmap.
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

// Recursive byte-level snapshot of both stores (path → sha or content).
function snapshot(dirs) {
  const out = new Map();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else out.set(p, fs.readFileSync(p, 'utf8'));
    }
  };
  for (const d of dirs) walk(d);
  return out;
}
function assertUnchanged(before, after, label) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: file set changed`);
  for (const [p, v] of before) assert.equal(after.get(p), v, `${label}: ${p} changed`);
}

// Index invariant: id lives in exactly `presentDir`'s four index surfaces and
// in none of `absentDir`'s.
function assertIndexInvariant(id, presentDir, absentDir) {
  const rowsIn = (d) => fs.existsSync(path.join(d, 'index.jsonl'))
    ? fs.readFileSync(path.join(d, 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const inverted = (d, f) => {
    try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return {}; }
  };
  const invertedHas = (d, f) => Object.values(inverted(d, f)).some(ids => Array.isArray(ids) && ids.includes(id));

  assert.ok(rowsIn(presentDir).some(r => r.id === id), `index.jsonl row missing in destination`);
  assert.ok(!rowsIn(absentDir).some(r => r.id === id), `index.jsonl row lingers in source`);
  assert.ok(fs.existsSync(path.join(presentDir, 'episodes', `${id}.md`)), 'episode file missing in destination');
  assert.ok(!fs.existsSync(path.join(absentDir, 'episodes', `${id}.md`)), 'episode file lingers in source');
  for (const f of ['tags.json', 'category-index.json', 'tokens.json']) {
    assert.ok(invertedHas(presentDir, f), `${f} missing id in destination`);
    assert.ok(!invertedHas(absentDir, f), `${f} still references id in source`);
  }
}

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emmove-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emmove-home-')));
  const env = { HOME: home };
  return { cwd, home, env, local: path.join(cwd, '.episodic-memory'), global: path.join(home, '.episodic-memory') };
}
function store(fx, args) {
  const r = run('em-store.mjs', ['--project', 'fx', '--body', 'body text for tokens', ...args], fx.cwd, fx.env);
  assert.equal(r.json.status, 'ok', r.stdout);
  return r.json.id;
}

// ---------------------------------------------------------------------------
// Demote: counters + pinned preserved, full index invariant, audit in dest
// ---------------------------------------------------------------------------
const fx1 = mkFixture();
const gid = store(fx1, ['--category', 'decision', '--summary', 'wrong scope decision', '--tags', 'leak,alpha', '--scope', 'global', '--pin']);
// give it usage history: access via search + explicit feedback
run('em-search.mjs', ['--query', 'wrong scope', '--scope', 'global'], fx1.cwd, fx1.env);
run('em-feedback.mjs', ['--id', gid, '--useful'], fx1.cwd, fx1.env);

t('demote global→local: moved, counters/pinned preserved, indexes consistent', () => {
  const before = JSON.parse(fs.readFileSync(path.join(fx1.global, 'index.jsonl'), 'utf8').trim().split('\n').map(l => l).filter(l => l.includes(gid))[0]);
  assert.ok(before.access_count >= 1 && before.feedback === 1 && before.pinned === true, 'fixture must have counters to preserve');

  const r = run('em-move.mjs', ['--id', gid, '--to', 'local', '--reason', 'contamination'], fx1.cwd, fx1.env);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.moved.length, 1);
  assertIndexInvariant(gid, fx1.local, fx1.global);

  const after = fs.readFileSync(path.join(fx1.local, 'index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.id === gid);
  assert.equal(after.access_count, before.access_count, 'access_count must survive');
  assert.equal(after.last_accessed, before.last_accessed, 'last_accessed must survive');
  assert.equal(after.feedback, 1, 'feedback must survive');
  assert.equal(after.pinned, true, 'pinned must survive');
});

t('audit episode written to DESTINATION scope with step bitmap + reason', () => {
  const r = run('em-search.mjs', ['--tag', 'em-move', '--scope', 'local', '--no-track', '--full'], fx1.cwd, fx1.env);
  assert.equal(r.json.count, 1, `audit must live in local (destination): ${r.stdout}`);
  const audit = r.json.episodes[0];
  assert.equal(audit.category, 'context');
  assert.ok(audit.summary.includes(`${gid} moved from global to local`));
  assert.ok(audit.body.includes('"dst_inverted":true'), 'step bitmap must attest full completion');
  assert.ok(audit.body.includes('contamination'), '--reason must land in the audit body');
});

t('post-move doctor is fully green on both stores (no dangling inverted refs)', () => {
  const r = run('em-doctor.mjs', ['--scope', 'all'], fx1.cwd, fx1.env);
  const bad = r.json.checks.filter(c => c.level !== 'ok' && c.id !== 'installed-scripts' && c.id !== 'backup');
  assert.deepEqual(bad, [], JSON.stringify(bad));
});

t('promote back local→global: round-trip returns to a consistent state', () => {
  const r = run('em-move.mjs', ['--id', gid, '--to', 'global', '--no-audit'], fx1.cwd, fx1.env);
  assert.equal(r.code, 0, r.stdout);
  assertIndexInvariant(gid, fx1.global, fx1.local);
  // --no-audit: no new audit episode appeared in global
  const audits = run('em-search.mjs', ['--tag', 'em-move', '--scope', 'global', '--no-track', '--limit', '50'], fx1.cwd, fx1.env);
  assert.equal(audits.json.count, 0, '--no-audit must suppress the audit episode');
});

t('no-op move (already in target) reported as noop, no audit, nothing written', () => {
  const before = snapshot([fx1.local, fx1.global]);
  const r = run('em-move.mjs', ['--id', gid, '--to', 'global'], fx1.cwd, fx1.env);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.moved, []);
  assert.equal(r.json.noop[0].id, gid);
  assertUnchanged(before, snapshot([fx1.local, fx1.global]), 'noop');
});

t('dry-run previews and writes NOTHING (byte-identical stores)', () => {
  const before = snapshot([fx1.local, fx1.global]);
  const r = run('em-move.mjs', ['--id', gid, '--to', 'local', '--dry-run'], fx1.cwd, fx1.env);
  assert.equal(r.code, 0);
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.moved[0].dry_run, true);
  assertUnchanged(before, snapshot([fx1.local, fx1.global]), 'dry-run');
});

// ---------------------------------------------------------------------------
// Chain split across scopes still resolves
// ---------------------------------------------------------------------------
t('supersedes chain split across scopes resolves via --history --scope all', () => {
  const origId = store(fx1, ['--category', 'lesson', '--summary', 'chain root lesson', '--tags', 'chain', '--scope', 'local']);
  const rev = run('em-revise.mjs', ['--original', origId, '--summary', 'chain revised lesson', '--body', 'corrected', '--scope', 'inherit'], fx1.cwd, fx1.env);
  assert.equal(rev.json.status, 'ok');
  // move ONLY the root to global — chain now spans scopes
  const mv = run('em-move.mjs', ['--id', origId, '--to', 'global', '--no-audit'], fx1.cwd, fx1.env);
  assert.equal(mv.code, 0, mv.stdout);
  const hist = run('em-search.mjs', ['--history', rev.json.id, '--scope', 'all', '--no-track'], fx1.cwd, fx1.env);
  assert.equal(hist.json.count, 2, `chain must fully resolve across scopes: ${hist.stdout}`);
  assert.equal(hist.json.chain[0].id, origId);
  assert.equal(hist.json.chain[1].id, rev.json.id);
});

// ---------------------------------------------------------------------------
// Refusal paths — each must write NOTHING
// ---------------------------------------------------------------------------
const fx2 = mkFixture();
const a = store(fx2, ['--category', 'decision', '--summary', 'anchored one', '--tags', 'x', '--scope', 'local']);
const b = store(fx2, ['--category', 'decision', '--summary', 'plain one', '--tags', 'x', '--scope', 'local']);

t('missing id / bad id format / usage errors: correct codes, nothing written', () => {
  const before = snapshot([fx2.local, fx2.global]);
  assert.equal(run('em-move.mjs', ['--id', '20200101-000000-nope', '--to', 'global'], fx2.cwd, fx2.env).code, 1);
  assert.equal(run('em-move.mjs', ['--id', 'b1bc', '--to', 'global'], fx2.cwd, fx2.env).json.errors[0].error.includes('full episode id'), true);
  assert.equal(run('em-move.mjs', ['--id', a, '--to', 'nowhere'], fx2.cwd, fx2.env).code, 2);
  assert.equal(run('em-move.mjs', ['--to', 'global'], fx2.cwd, fx2.env).code, 2);
  assert.equal(run('em-move.mjs', ['--id', a, '--ids', b, '--to', 'global'], fx2.cwd, fx2.env).code, 2, 'multiple selectors rejected');
  assertUnchanged(before, snapshot([fx2.local, fx2.global]), 'refusals');
});

t('anchored id refuses without --break-anchors, moves with it', () => {
  const memDir = path.join(fx2.home, '.claude', 'projects', 'proj1', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), `Anchor: see .episodic-memory/episodes/${a}.md for rationale\n`);
  const before = snapshot([fx2.local, fx2.global]);
  const refuse = run('em-move.mjs', ['--id', a, '--to', 'global'], fx2.cwd, fx2.env);
  assert.equal(refuse.code, 1);
  assert.ok(refuse.json.errors[0].error.includes('Anchored'), refuse.stdout);
  assertUnchanged(before, snapshot([fx2.local, fx2.global]), 'anchor refusal');
  const forced = run('em-move.mjs', ['--id', a, '--to', 'global', '--break-anchors', '--no-audit'], fx2.cwd, fx2.env);
  assert.equal(forced.code, 0, forced.stdout);
  assertIndexInvariant(a, fx2.global, fx2.local);
});

t('frontmatter-id mismatch refuses the move', () => {
  const evil = path.join(fx2.local, 'episodes', '20260101-000000-evil-aaaa.md');
  fs.writeFileSync(evil, `---\nid: 20260101-000000-other-bbbb\ndate: 2026-01-01\ntime: "00:00"\nproject: fx\ncategory: decision\nstatus: active\ntags: []\nsummary: mismatch\n---\n\nbody\n`);
  const r = run('em-move.mjs', ['--id', '20260101-000000-evil-aaaa', '--to', 'global'], fx2.cwd, fx2.env);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors[0].error.includes('does not match filename'));
  assert.ok(fs.existsSync(evil), 'file must not move');
  fs.rmSync(evil);
});

t('>10 episodes without --confirm refuses; --dry-run bypasses the gate', () => {
  const fx3 = mkFixture();
  const ids = [];
  for (let i = 0; i < 11; i++) ids.push(store(fx3, ['--category', 'decision', '--summary', `bulk ${i}`, '--tags', 'bulk', '--scope', 'local']));
  const refuse = run('em-move.mjs', ['--ids', ids.join(','), '--to', 'global'], fx3.cwd, fx3.env);
  assert.equal(refuse.code, 2);
  assert.ok(refuse.json.message.includes('--confirm'));
  const preview = run('em-move.mjs', ['--ids', ids.join(','), '--to', 'global', '--dry-run'], fx3.cwd, fx3.env);
  assert.equal(preview.code, 0);
  assert.equal(preview.json.moved.length, 11);
  const go = run('em-move.mjs', ['--ids', ids.join(','), '--to', 'global', '--confirm', '--no-audit'], fx3.cwd, fx3.env);
  assert.equal(go.code, 0, go.stdout);
  assert.equal(go.json.moved.length, 11);
  for (const id of ids) assertIndexInvariant(id, fx3.global, fx3.local);
  fs.rmSync(fx3.cwd, { recursive: true, force: true }); fs.rmSync(fx3.home, { recursive: true, force: true });
});

t('--filter-tag selects from index rows even when tags.json is stale/deleted', () => {
  const fx4 = mkFixture();
  const id1 = store(fx4, ['--category', 'lesson', '--summary', 'tagged lesson', '--tags', 'movable', '--scope', 'local']);
  store(fx4, ['--category', 'lesson', '--summary', 'other lesson', '--tags', 'stay', '--scope', 'local']);
  fs.rmSync(path.join(fx4.local, 'tags.json')); // stale/absent tags index must not affect selection
  const r = run('em-move.mjs', ['--filter-tag', 'movable', '--to', 'global', '--no-audit'], fx4.cwd, fx4.env);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.moved.map(m => m.id), [id1]);
  fs.rmSync(fx4.cwd, { recursive: true, force: true }); fs.rmSync(fx4.home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Both-scopes recovery (RFC-005 F3)
// ---------------------------------------------------------------------------
t('found-in-both, IDENTICAL content: completes the interrupted move (cleanup)', () => {
  const fx5 = mkFixture();
  const id = store(fx5, ['--category', 'decision', '--summary', 'twin decision', '--tags', 'tw', '--scope', 'local']);
  // simulate an interrupted move: copy already landed in global, unlink never ran
  fs.mkdirSync(path.join(fx5.global, 'episodes'), { recursive: true });
  fs.copyFileSync(path.join(fx5.local, 'episodes', `${id}.md`), path.join(fx5.global, 'episodes', `${id}.md`));
  const r = run('em-move.mjs', ['--id', id, '--to', 'global', '--no-audit'], fx5.cwd, fx5.env);
  assert.equal(r.code, 0, r.stdout);
  assertIndexInvariant(id, fx5.global, fx5.local);
  fs.rmSync(fx5.cwd, { recursive: true, force: true }); fs.rmSync(fx5.home, { recursive: true, force: true });
});

t('found-in-both, DIFFERENT content: hard error, both files untouched', () => {
  const fx6 = mkFixture();
  const id = store(fx6, ['--category', 'decision', '--summary', 'diverged decision', '--tags', 'dv', '--scope', 'local']);
  fs.mkdirSync(path.join(fx6.global, 'episodes'), { recursive: true });
  fs.writeFileSync(path.join(fx6.global, 'episodes', `${id}.md`), 'DIFFERENT CONTENT');
  const before = snapshot([fx6.local, fx6.global]);
  const r = run('em-move.mjs', ['--id', id, '--to', 'global'], fx6.cwd, fx6.env);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors[0].error.includes('DIFFERENT content'), r.stdout);
  assertUnchanged(before, snapshot([fx6.local, fx6.global]), 'divergent recovery');
  fs.rmSync(fx6.cwd, { recursive: true, force: true }); fs.rmSync(fx6.home, { recursive: true, force: true });
});

for (const fx of [fx1, fx2]) {
  fs.rmSync(fx.cwd, { recursive: true, force: true });
  fs.rmSync(fx.home, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
