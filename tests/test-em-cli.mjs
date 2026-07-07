/**
 * test-em-cli.mjs — em.mjs unified dispatcher runtime probes.
 *
 * Covers: help output (human + --json), directory-driven command discovery,
 * delegation with argument + exit-code passthrough, unknown-command
 * suggestions, and rejection of path-shaped commands.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM = path.join(REPO, 'scripts/em.mjs');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function run(args, cwd, env) {
  const r = spawnSync('node', [EM, ...args], { cwd: cwd || REPO, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}

t('em help exits 0 and lists core commands', () => {
  const r = run(['help']);
  assert.equal(r.code, 0);
  for (const c of ['store', 'search', 'recall', 'doctor', 'revise', 'prune']) {
    assert.ok(r.stdout.includes(`  ${c}`), `help must list "${c}"`);
  }
});

t('em with no args prints help but exits 1', () => {
  const r = run([]);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('Usage: em <command>'));
});

t('em help --json emits machine-readable command table', () => {
  const r = run(['help', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'help');
  const cmds = r.json.commands.map(c => c.command);
  assert.ok(cmds.includes('search') && cmds.includes('doctor'));
  assert.ok(r.json.commands.find(c => c.command === 'doctor').description.length > 0);
});

t('command discovery is directory-driven (every em-*.mjs is dispatchable)', () => {
  const r = run(['help', '--json']);
  const onDisk = fs.readdirSync(path.join(REPO, 'scripts'))
    .filter(f => /^em-.+\.mjs$/.test(f)).map(f => f.slice(3, -4)).sort();
  assert.deepEqual(r.json.commands.map(c => c.command), onDisk);
});

t('delegation: em store → em search round-trip in isolated store', () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcli-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcli-home-')));
  const env = { HOME: home };
  const s = run(['store', '--project', 'fx', '--category', 'decision', '--summary', 'via dispatcher',
    '--body', 'stored through em.mjs', '--tags', 'cli', '--scope', 'local'], cwd, env);
  assert.equal(s.code, 0);
  assert.equal(s.json.status, 'ok');
  const q = run(['search', '--query', 'via dispatcher', '--scope', 'local', '--no-track'], cwd, env);
  assert.equal(q.json.count, 1);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

t('delegated exit codes pass through (invalid scope → 1)', () => {
  const r = run(['search', '--scope', 'bogus']);
  assert.equal(r.code, 1);
  assert.equal(r.json.status, 'error');
});

t('unknown command → exit 2 with did_you_mean suggestion', () => {
  const r = run(['sarch']);
  assert.equal(r.code, 2);
  assert.equal(r.json.status, 'error');
  assert.ok(r.json.did_you_mean.includes('search'));
});

t('path-shaped command is rejected, not resolved', () => {
  const r = run(['../evil']);
  assert.equal(r.code, 2);
  assert.equal(r.json.status, 'error');
});

t('help table stays in sync: every described command exists on disk', () => {
  // guards against DESCRIPTIONS drifting ahead of real scripts
  const src = fs.readFileSync(EM, 'utf8');
  const described = [...src.matchAll(/^\s{2}'?([a-z][a-z0-9-]*)'?:\s'/gm)].map(m => m[1]);
  const onDisk = new Set(fs.readdirSync(path.join(REPO, 'scripts'))
    .filter(f => /^em-.+\.mjs$/.test(f)).map(f => f.slice(3, -4)));
  for (const d of described) {
    assert.ok(onDisk.has(d), `DESCRIPTIONS entry "${d}" has no em-${d}.mjs on disk`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
