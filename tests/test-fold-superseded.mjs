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

t('pinned intermediate is kept (reason: pinned); the rest folds; history still full', () => {
  const fx2 = mkFixture();
  const ids = mkChain(fx2, 'pinned-mid', 5);
  const pin = run('em-pin.mjs', ['--id', ids[1]], fx2.cwd, fx2.env);
  assert.equal(pin.json.status, 'ok', pin.stdout);
  const r = fold(fx2, ['--min-chain', '5']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.chains[0].kept, [{ id: ids[1], reason: 'pinned' }]);
  assert.deepEqual(r.json.chains[0].folded, [ids[0], ids[2], ids[3]].sort());
  assert.ok(fs.existsSync(path.join(fx2.store, 'episodes', `${ids[1]}.md`)), 'pinned member stays in episodes/');
  const h = run('em-search.mjs', ['--history', ids[4], '--scope', 'local'], fx2.cwd, fx2.env);
  assert.deepEqual(h.json.chain.map(e => e.id), ids, `mixed live/archived chain must resolve: ${h.stdout}`);
  rmFixture(fx2);
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
