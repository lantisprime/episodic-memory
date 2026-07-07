/**
 * test-install-wizard.mjs — wizard E2E probes: real install.mjs --wizard runs
 * with piped answers against isolated HOMEs (the scriptable stdin contract).
 *
 * Covers: install flow (tool install + PATH rc append + doctor verify),
 * migrate flow (git-backed backup fixture → dry-run → apply → episodes land),
 * doctor flow, EOF safety (starved stdin must terminate, not hang), and the
 * clone-itself guard.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const INSTALL = path.join(REPO, 'install.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function wizard(answers, env, opts) {
  return spawnSync('node', [INSTALL, '--wizard'], {
    input: answers.join('\n') + '\n',
    encoding: 'utf8',
    cwd: REPO,
    timeout: 120000,
    env: { ...process.env, SHELL: '/bin/bash', ...env },
    ...opts,
  });
}

function mkHome(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ---------------------------------------------------------------------------
t('install flow: cursor install + PATH append + doctor verify, exit 0', () => {
  const home = mkHome('wiz-install-');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  // action=install, tools=2 (cursor), project, backup=n, PATH=y
  const r = wizard(['1', '2', proj, 'n', 'y'], { HOME: home });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(path.join(proj, '.cursor/rules/episodic-memory.mdc')), 'cursor rules must install');
  assert.ok(fs.existsSync(path.join(home, '.episodic-memory/bin/em')), 'em shim must install');
  assert.ok(fs.readFileSync(path.join(home, '.bashrc'), 'utf8').includes('.episodic-memory/bin'), 'PATH export must append to rc');
  assert.ok(r.stdout.includes('doctor: ok'), `doctor must verify clean:\n${r.stdout}`);
  fs.rmSync(home, { recursive: true, force: true });
});

t('clone-itself guard: default cwd (the repo) requires explicit confirmation', () => {
  const home = mkHome('wiz-guard-');
  // action=install, tools=1, project=<enter → cwd=REPO>, decline, then EOF
  const r = wizard(['1', '1', '', 'n'], { HOME: home });
  assert.ok(r.stdout.includes('episodic-memory clone itself'), 'must warn about installing into the clone');
  assert.notEqual(r.status, 0, 'declining the guard with no fallback path must not succeed silently');
  assert.ok(!fs.existsSync(path.join(home, '.episodic-memory/scripts')), 'no install may happen after declined guard');
  fs.rmSync(home, { recursive: true, force: true });
});

t('EOF starvation terminates cleanly (no hang, defaults applied)', () => {
  const home = mkHome('wiz-eof-');
  const r = wizard([], { HOME: home }); // zero answers: every ask hits EOF
  assert.notEqual(r.signal, 'SIGTERM', 'wizard must not hit the spawn timeout');
  assert.ok(r.stdout.includes('setup wizard'), 'banner must print');
  fs.rmSync(home, { recursive: true, force: true });
});

t('migrate flow: git backup fixture → apply → episodes restored + index rebuilt', () => {
  const home = mkHome('wiz-migrate-');
  const backup = mkHome('wiz-backup-');
  // Build a minimal em-backup-shaped fixture: <backup>/global/episodes/*.md in a git repo.
  const epDir = path.join(backup, 'global', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  const id = '20260101-000000-fixture-episode-abcd';
  fs.writeFileSync(path.join(epDir, `${id}.md`), [
    '---', `id: ${id}`, 'date: 2026-01-01', 'time: "00:00"', 'project: fx',
    'category: decision', 'status: active', 'tags: [fixture]', 'summary: wizard migrate fixture', '---', '', 'body', '',
  ].join('\n'));
  const g = (args) => spawnSync('git', args, { cwd: backup, encoding: 'utf8' });
  g(['init', '-q']);
  g(['add', '-A']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'snap']);

  // action=migrate, source=backup dir, target=<enter → ~/.episodic-memory>, apply=y
  const r = wizard(['2', backup, '', 'y'], { HOME: home });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(path.join(home, '.episodic-memory', 'episodes', `${id}.md`)), 'episode must be restored');
  assert.ok(fs.existsSync(path.join(home, '.episodic-memory', 'index.jsonl')), 'index must be rebuilt');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
});

t('migrate flow: declining apply leaves the store untouched', () => {
  const home = mkHome('wiz-dryrun-');
  const backup = mkHome('wiz-drybk-');
  const epDir = path.join(backup, 'global', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  fs.writeFileSync(path.join(epDir, '20260101-000000-x-aaaa.md'),
    '---\nid: 20260101-000000-x-aaaa\ndate: 2026-01-01\ntime: "00:00"\nproject: fx\ncategory: decision\nstatus: active\ntags: []\nsummary: x\n---\n\nbody\n');
  const g = (args) => spawnSync('git', args, { cwd: backup, encoding: 'utf8' });
  g(['init', '-q']); g(['add', '-A']); g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'snap']);

  const r = wizard(['2', backup, '', 'n'], { HOME: home });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}`);
  assert.ok(!fs.existsSync(path.join(home, '.episodic-memory', 'episodes')), 'declined apply must write nothing');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
});

t('doctor flow runs against the current stores', () => {
  const home = mkHome('wiz-doctor-');
  const r = wizard(['3', 'n'], { HOME: home });
  assert.ok(r.stdout.includes('doctor:'), 'doctor summary must print');
  assert.notEqual(r.signal, 'SIGTERM');
  fs.rmSync(home, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
