/**
 * test-em-doctor.mjs — em-doctor.mjs runtime probes against isolated fixture
 * stores (real script, real corruption, isolated HOME).
 *
 * Covers: healthy store → ok/exit 0; each corruption class detected at the
 * right level; --fix repairs rebuildable + removable findings and re-verifies;
 * --strict escalates warns to exit 1; invalid scope → exit 2.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_DOCTOR = path.join(REPO, 'scripts/em-doctor.mjs');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function run(args, cwd, env) {
  const r = spawnSync('node', [EM_DOCTOR, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}

function check(json, id) {
  return json.checks.find(c => c.id === id);
}

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-home-')));
  const env = { HOME: home };
  for (let i = 0; i < 3; i++) {
    spawnSync('node', [EM_STORE, '--project', 'fx', '--category', 'decision',
      '--summary', `episode ${i}`, '--body', `body ${i}`, '--tags', 'fx', '--scope', 'local'],
      { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  }
  return { cwd, home, env, store: path.join(cwd, '.episodic-memory') };
}

// ---------------------------------------------------------------------------
const healthy = mkFixture();

t('healthy store → status ok, exit 0, no warn/error', () => {
  const r = run(['--scope', 'local'], healthy.cwd, healthy.env);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.summary.error, 0);
  for (const id of ['index-parse', 'index-drift', 'tags-index', 'category-index', 'supersedes-links', 'tmp-litter', 'stale-locks']) {
    assert.equal(check(r.json, id).level, 'ok', `${id} should be ok`);
  }
});

t('invalid --scope → exit 2', () => {
  const r = run(['--scope', 'bogus'], healthy.cwd, healthy.env);
  assert.equal(r.code, 2);
  assert.equal(r.json.status, 'error');
});

t('--help short-circuits', () => {
  const r = run(['--help'], healthy.cwd, healthy.env);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'help');
});

// ---------------------------------------------------------------------------
const sick = mkFixture();

t('corruptions detected: bad index line, missing tags.json, deleted episode file, stale tmp+lock', () => {
  fs.appendFileSync(path.join(sick.store, 'index.jsonl'), 'NOT-JSON\n');
  fs.rmSync(path.join(sick.store, 'tags.json'));
  const anyEp = fs.readdirSync(path.join(sick.store, 'episodes'))[0];
  fs.rmSync(path.join(sick.store, 'episodes', anyEp));
  const oldTmp = path.join(sick.store, 'leftover.tmp');
  fs.writeFileSync(oldTmp, 'x');
  fs.utimesSync(oldTmp, new Date(Date.now() - 2 * 3600e3), new Date(Date.now() - 2 * 3600e3));
  fs.writeFileSync(path.join(sick.store, 'dead.lock'), '999999');

  const r = run(['--scope', 'local'], sick.cwd, sick.env);
  assert.equal(r.code, 1);
  assert.equal(r.json.status, 'issues');
  assert.equal(check(r.json, 'index-parse').level, 'error');
  assert.equal(check(r.json, 'index-drift').level, 'error');
  assert.equal(check(r.json, 'tags-index').level, 'warn');
  assert.equal(check(r.json, 'tmp-litter').level, 'warn');
  assert.equal(check(r.json, 'stale-locks').level, 'warn');
});

t('--fix repairs and re-verifies: store returns to full health', () => {
  const r = run(['--scope', 'local', '--fix'], sick.cwd, sick.env);
  assert.equal(r.code, 0, `expected clean exit, got ${r.stdout}`);
  assert.equal(r.json.status, 'ok');
  assert.ok(r.json.fixes.some(f => f.action === 'rebuild-index' && f.exit === 0), 'rebuild-index fix must run');
  assert.ok(r.json.fixes.some(f => f.action === 'removed-tmp'), 'stale tmp must be removed');
  assert.ok(r.json.fixes.some(f => f.action === 'removed-stale-lock'), 'stale lock must be removed');
  for (const id of ['index-parse', 'index-drift', 'tags-index', 'tmp-litter', 'stale-locks']) {
    assert.equal(check(r.json, id).level, 'ok', `${id} should be ok after --fix`);
  }
  assert.ok(!fs.existsSync(path.join(sick.store, 'dead.lock')));
  assert.ok(!fs.existsSync(path.join(sick.store, 'leftover.tmp')));
});

// ---------------------------------------------------------------------------
const warned = mkFixture();

t('live lock is NOT flagged stale; --strict escalates warns to exit 1', () => {
  // live lock: our own pid
  fs.writeFileSync(path.join(warned.store, 'live.lock'), String(process.pid));
  let r = run(['--scope', 'local'], warned.cwd, warned.env);
  assert.equal(check(r.json, 'stale-locks').level, 'ok');
  assert.equal(r.code, 0);
  // add a warn-level finding, then --strict must exit 1
  fs.rmSync(path.join(warned.store, 'tags.json'));
  r = run(['--scope', 'local', '--strict'], warned.cwd, warned.env);
  assert.equal(r.code, 1);
  r = run(['--scope', 'local'], warned.cwd, warned.env);
  assert.equal(r.code, 0, 'warns alone must not fail without --strict');
});

t('missing store is ok (created on first use), not an error', () => {
  const emptyCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-empty-')));
  const r = run(['--scope', 'local'], emptyCwd, warned.env);
  assert.equal(check(r.json, 'store').level, 'ok');
  fs.rmSync(emptyCwd, { recursive: true, force: true });
});

for (const f of [healthy, sick, warned]) {
  fs.rmSync(f.cwd, { recursive: true, force: true });
  fs.rmSync(f.home, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
