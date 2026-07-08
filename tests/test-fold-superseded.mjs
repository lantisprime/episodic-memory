/**
 * test-fold-superseded.mjs — S4 em-consolidate --fold-superseded.
 *
 * Rigor contract (behavior-simulated on isolated fixture stores):
 *   - chains shorter than --min-chain are refused (nothing moves — polarity);
 *   - --dry-run lists EXACTLY what a real run moves and writes nothing
 *     (byte-level snapshot); the real run's folded list equals the dry-run's;
 *   - the archive mechanism is em-prune's: file -> archived/, index row ->
 *     archived-index.jsonl, tags.json cleaned; bytes preserved (never
 *     deleted), terminal untouched;
 *   - chain resolvability: em-search --history <terminal> and <root> still
 *     show the FULL chain after folding, archived members flagged
 *     `archived: true`, --full bodies resolve from archived/;
 *   - pinned members are kept; non-linear (forked) chains skip whole;
 *   - post-fold em-doctor has no error-level findings.
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

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emfold-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emfold-home-')));
  return { cwd, home, env: { HOME: home }, store: path.join(cwd, '.episodic-memory') };
}
function rmFixture(fx) {
  fs.rmSync(fx.cwd, { recursive: true, force: true });
  fs.rmSync(fx.home, { recursive: true, force: true });
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
function mkChain(fx, name, length) {
  const first = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'decision',
    '--summary', `${name} v1`, '--body', `${name} version 1`], fx.cwd, fx.env);
  assert.equal(first.json.status, 'ok', first.stdout);
  const ids = [first.json.id];
  for (let i = 2; i <= length; i++) {
    const r = run('em-revise.mjs', ['--original', ids[ids.length - 1], '--summary', `${name} v${i}`, '--body', `${name} version ${i}`], fx.cwd, fx.env);
    assert.equal(r.json.status, 'ok', r.stdout);
    ids.push(r.json.id);
  }
  return ids;
}
function fold(fx, args) {
  return run('em-consolidate.mjs', ['--fold-superseded', '--scope', 'local', ...args], fx.cwd, fx.env);
}
function indexIds(fx) {
  return fs.readFileSync(path.join(fx.store, 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id);
}

// ---------------------------------------------------------------------------
const fx = mkFixture();
const chain5 = mkChain(fx, 'workplan', 5);      // fold target at --min-chain 5
const chain2 = mkChain(fx, 'sidenote', 2);      // must never fold (< N)
const terminal = chain5[4];
const nonTerminal = chain5.slice(0, 4);
const foldedBodies = new Map(nonTerminal.map(id =>
  [id, fs.readFileSync(path.join(fx.store, 'episodes', `${id}.md`), 'utf8')]));

t('polarity: chain below --min-chain refuses to move anything (default N=10, and N=6 > length)', () => {
  const before = snapshot(fx.store);
  for (const args of [[], ['--min-chain', '6']]) {
    const r = fold(fx, args); // real runs, not dry-runs — must still be no-ops
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.folded_total, 0, r.stdout);
    assert.equal(r.json.chains.length, 0);
  }
  const after = snapshot(fx.store);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [p, v] of before) assert.equal(after.get(p), v, `${p} changed on a no-op run`);
});

t('--min-chain rejects non-integer / < 2', () => {
  assert.equal(fold(fx, ['--min-chain', 'abc']).code, 2);
  assert.equal(fold(fx, ['--min-chain', '1']).code, 2);
});

let dryList = null;
t('--dry-run: lists non-terminal members of the >=N chain, writes NOTHING', () => {
  const before = snapshot(fx.store);
  const r = fold(fx, ['--min-chain', '5', '--dry-run']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.dry_run, true);
  assert.equal(r.json.chains.length, 1, `the 2-chain must not appear: ${r.stdout}`);
  assert.equal(r.json.chains[0].terminal, terminal);
  assert.equal(r.json.chains[0].chain_length, 5);
  assert.deepEqual(r.json.chains[0].folded, [...nonTerminal].sort());
  dryList = r.json.chains[0].folded;
  const after = snapshot(fx.store);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [p, v] of before) assert.equal(after.get(p), v, `${p} changed on dry-run`);
});

t('real run moves EXACTLY the dry-run list via the em-prune mechanism (never deletes)', () => {
  const r = fold(fx, ['--min-chain', '5']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.dry_run, false);
  assert.deepEqual(r.json.chains[0].folded, dryList, 'real fold must match the dry-run list');
  assert.equal(r.json.folded_total, 4);
  for (const id of nonTerminal) {
    assert.ok(!fs.existsSync(path.join(fx.store, 'episodes', `${id}.md`)), `${id} must leave episodes/`);
    const archived = path.join(fx.store, 'archived', `${id}.md`);
    assert.ok(fs.existsSync(archived), `${id} must land in archived/`);
    assert.equal(fs.readFileSync(archived, 'utf8'), foldedBodies.get(id), 'archival is a byte-preserving move');
  }
  const ids = indexIds(fx);
  for (const id of nonTerminal) assert.ok(!ids.includes(id), `${id} row must leave index.jsonl`);
  const archRows = fs.readFileSync(path.join(fx.store, 'archived-index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(archRows.map(a => a.id).sort(), [...nonTerminal].sort(), 'rows preserved in archived-index.jsonl');
  const tags = JSON.parse(fs.readFileSync(path.join(fx.store, 'tags.json'), 'utf8'));
  for (const list of Object.values(tags)) for (const id of list) assert.ok(!nonTerminal.includes(id), 'tags.json cleaned');
});

t('terminal untouched and still searchable; short chain untouched', () => {
  assert.ok(fs.existsSync(path.join(fx.store, 'episodes', `${terminal}.md`)));
  const ids = indexIds(fx);
  assert.ok(ids.includes(terminal));
  for (const id of chain2) assert.ok(ids.includes(id), 'the 2-chain must be intact');
  const s = run('em-search.mjs', ['--query', 'workplan', '--scope', 'local', '--no-track'], fx.cwd, fx.env);
  assert.ok(s.json.episodes.some(e => e.id === terminal), s.stdout);
});

t('chain resolvability: --history from terminal AND root shows all 5, archived members flagged', () => {
  for (const anchor of [terminal, chain5[0]]) {
    const h = run('em-search.mjs', ['--history', anchor, '--scope', 'local'], fx.cwd, fx.env);
    assert.deepEqual(h.json.chain.map(e => e.id), chain5, `history from ${anchor}: ${h.stdout}`);
    for (const e of h.json.chain) {
      if (e.id === terminal) assert.notEqual(e.archived, true);
      else assert.equal(e.archived, true, `${e.id} must be flagged archived`);
    }
  }
});

t('--history --full resolves archived bodies from archived/', () => {
  const h = run('em-search.mjs', ['--history', terminal, '--scope', 'local', '--full'], fx.cwd, fx.env);
  const v1 = h.json.chain.find(e => e.id === chain5[0]);
  assert.ok(v1.body && v1.body.includes('workplan version 1'), JSON.stringify(v1));
});

t('re-run finds nothing left to fold; post-fold em-doctor has no errors', () => {
  const again = fold(fx, ['--min-chain', '5']);
  // remaining chain rows: terminal only (component of 1) + the 2-chain
  assert.equal(again.json.folded_total, 0, again.stdout);
  const doc = run('em-doctor.mjs', ['--scope', 'local'], fx.cwd, fx.env);
  const errors = doc.json.checks.filter(c => c.level === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors));
});

t('pinned member anchors R6 chain-closure: whole chain kept, nothing folds (matches em-prune)', () => {
  // A pin is an R6 anchor; computeProtectedIds' chain-closure then protects
  // EVERY member of that supersession chain (em-prune's exact "never archive"
  // contract — fold honors it verbatim now, review finding). So a chain that
  // touches a pin folds nothing.
  const fx2 = mkFixture();
  const ids = mkChain(fx2, 'pinned-mid', 5);
  const pin = run('em-pin.mjs', ['--id', ids[1]], fx2.cwd, fx2.env);
  assert.equal(pin.json.status, 'ok', pin.stdout);
  const r = fold(fx2, ['--min-chain', '5']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.chains[0].folded, [], `pinned-anchored chain must fold nothing: ${r.stdout}`);
  const keptById = Object.fromEntries(r.json.chains[0].kept.map(k => [k.id, k.reason]));
  assert.equal(keptById[ids[1]], 'pinned');
  for (const i of [0, 2, 3]) assert.ok(/^r6-protected:/.test(keptById[ids[i]] || ''), `member ${i} should be r6-protected chain-member: ${keptById[ids[i]]}`);
  for (const id of ids) assert.ok(fs.existsSync(path.join(fx2.store, 'episodes', `${id}.md`)), `${id} stays in episodes/`);
  rmFixture(fx2);
});

t('R6: evidence-linked violation in a chain is never archived (fold honors em-prune protection)', () => {
  // The review finding: fold used to archive protected episodes. A violation
  // named in an active lesson's `evidence` is R6-protected (evidence-linked),
  // and its whole chain is closure-protected — fold must keep it all.
  const fx4 = mkFixture();
  const ids = mkChain(fx4, 'r6-evid', 5);
  // Make ids[2] a violation; add a separate ACTIVE lesson row whose `evidence`
  // names it (hand-crafted in the index — the P1b `--evidence` writer is not
  // merged yet; fold reads index rows like the substrate readers do).
  const indexFile = path.join(fx4.store, 'index.jsonl');
  const rows = fs.readFileSync(indexFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  for (const e of rows) if (e.id === ids[2]) e.category = 'violation';
  rows.push({ id: '20260101-000000-r6-lesson-aaaa', date: '2026-01-01', time: '00:00', project: 'fx', category: 'lesson', status: 'active', summary: 'lesson citing the violation', tags: [], evidence: [ids[2]] });
  fs.writeFileSync(indexFile, rows.map(e => JSON.stringify(e)).join('\n') + '\n');
  const r = fold(fx4, ['--min-chain', '5']);
  assert.equal(r.code, 0, r.stdout);
  const folded = r.json.chains[0]?.folded || [];
  assert.ok(!folded.includes(ids[2]), `evidence-linked violation must NOT be folded: ${JSON.stringify(folded)}`);
  assert.ok(fs.existsSync(path.join(fx4.store, 'episodes', `${ids[2]}.md`)), 'protected violation stays in episodes/');
  rmFixture(fx4);
});

t('forked (non-linear) chain skips whole — nothing archived', () => {
  const fx3 = mkFixture();
  const ids = mkChain(fx3, 'forked', 5);
  // Hand-craft a fork: a second episode superseding ids[1] (index row edit —
  // fold selects from index rows, matching the substrate readers).
  const extra = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'decision',
    '--summary', 'forked branch tip', '--body', 'branch body'], fx3.cwd, fx3.env);
  const indexFile = path.join(fx3.store, 'index.jsonl');
  const rewritten = fs.readFileSync(indexFile, 'utf8').trim().split('\n').map(l => {
    const e = JSON.parse(l);
    if (e.id === extra.json.id) e.supersedes = ids[1];
    return JSON.stringify(e);
  });
  fs.writeFileSync(indexFile, rewritten.join('\n') + '\n');
  const before = snapshot(fx3.store);
  const r = fold(fx3, ['--min-chain', '5']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.folded_total, 0, r.stdout);
  assert.ok(r.json.skipped?.some(s => s.reason === 'non-linear'), r.stdout);
  const after = snapshot(fx3.store);
  for (const [p, v] of before) assert.equal(after.get(p), v, `${p} changed despite non-linear skip`);
  rmFixture(fx3);
});

rmFixture(fx);
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
