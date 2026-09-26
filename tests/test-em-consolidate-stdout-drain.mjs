#!/usr/bin/env node
/**
 * test-em-consolidate-stdout-drain.mjs — #486 regression.
 *
 * em-consolidate emitted its large JSON reports with console.log(...) and then
 * process.exit(0). When stdout is a pipe whose reader is slower than the
 * writer, process.exit discards everything past the ~64KB pipe buffer, so the
 * consumer sees exactly 65536 bytes of unterminated JSON. The same class was
 * fixed in em-search --history (PR #485).
 *
 * Each leg builds a fixture store whose report is > 64KB, runs em-consolidate
 * through a REAL shell pipe into a slow consumer (`(sleep 1; cat)`), and
 * asserts the consumer receives the full report as valid JSON and the script
 * exits 0. Sites covered:
 *   - --fold-superseded single-scope report
 *   - --fold-superseded --all-projects report
 *   - dry-run cluster report
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
const PIPE_BUF = 65536;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkFixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcons-drain-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcons-drain-home-')));
  fs.mkdirSync(path.join(home, '.episodic-memory'), { recursive: true });
  return { cwd, home, env: { ...process.env, HOME: home, USERPROFILE: home } };
}
function cleanup(fx) {
  fs.rmSync(fx.cwd, { recursive: true, force: true });
  fs.rmSync(fx.home, { recursive: true, force: true });
}

function writeEpisode(dir, fm, body) {
  const ep = path.join(dir, '.episodic-memory', 'episodes');
  fs.mkdirSync(ep, { recursive: true });
  const lines = Object.entries(fm).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`);
  fs.writeFileSync(path.join(ep, `${fm.id}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
}
// Index is built by the real rebuild script (fixture files are written
// directly only to avoid ~1500 em-store/em-revise spawns).
function rebuildIndex(fx, projectDir) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'em-rebuild-index.mjs'), '--scope', 'local'],
    { cwd: projectDir, env: fx.env, encoding: 'utf8' });
  assert.equal(r.status, 0, `rebuild failed: ${r.stdout}${r.stderr}`);
}

// Linear supersedes chain of n members; only the terminal is active.
function seedChain(projectDir, n) {
  let prev = null;
  for (let i = 0; i < n; i++) {
    const id = `20260101-000000-drain-chain-member-long-slug-${String(i).padStart(5, '0')}`;
    writeEpisode(projectDir, {
      id, date: '2026-01-01', time: '"00:00"', project: 'fx', category: 'decision',
      status: i === n - 1 ? 'active' : 'superseded', supersedes: prev, tags: '[x]', summary: `chain ${i}`,
    }, `# chain ${i}\n\nbody ${i}`);
    prev = id;
  }
}

// n near-duplicate lessons with long summaries -> one large dry-run cluster.
function seedCluster(projectDir, n) {
  const long = 'atomic rename index rebuild lesson '.repeat(60);
  for (let i = 0; i < n; i++) {
    writeEpisode(projectDir, {
      id: `20260101-000000-drain-dup-${String(i).padStart(4, '0')}`, date: '2026-01-01', time: '"00:00"',
      project: 'fx', category: 'lesson', status: 'active', tags: '[x]', summary: `${long}${i}`,
    }, `# dup ${i}\n\nUse temp file plus rename for atomic index rebuild writes so readers never see partial state.`);
  }
}

// Runs em-consolidate through a real pipe into a consumer that sleeps before
// reading, so the writer must block on a full pipe buffer. The script's own
// exit code is reported on stderr (sh has no pipefail).
function runSlowPipe(fx, cwd, args) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `{ ${q(process.execPath)} ${q(path.join(SCRIPTS, 'em-consolidate.mjs'))} ${args.map(q).join(' ')}; echo "EXIT:$?" >&2; } | (sleep 1; cat)`;
  const r = spawnSync('sh', ['-c', cmd], { cwd, env: fx.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
  const m = /EXIT:(\d+)/.exec(r.stderr);
  return { stdout: r.stdout, exit: m ? Number(m[1]) : null, stderr: r.stderr };
}

function assertFullReport(r, label) {
  const bytes = Buffer.byteLength(r.stdout);
  assert.equal(r.exit, 0, `${label}: em-consolidate exit 0, got ${r.exit}: ${r.stderr}`);
  assert.notEqual(bytes, PIPE_BUF, `${label}: truncated at the pipe buffer (${bytes} bytes)`);
  assert.ok(bytes > PIPE_BUF, `${label}: fixture must produce > ${PIPE_BUF} bytes, got ${bytes}`);
  assert.ok(r.stdout.endsWith('\n'), `${label}: output must end with a newline`);
  let json;
  try { json = JSON.parse(r.stdout); } catch (e) { throw new Error(`${label}: invalid JSON after ${bytes} bytes: ${e.message}`); }
  assert.equal(json.status, 'ok', `${label}: status ok`);
  return json;
}

t('--fold-superseded single-scope: >64KB report reaches a slow pipe consumer intact', () => {
  const fx = mkFixture();
  seedChain(fx.cwd, 1500);
  rebuildIndex(fx, fx.cwd);
  const json = assertFullReport(runSlowPipe(fx, fx.cwd, ['--fold-superseded', '--dry-run', '--scope', 'local']), 'fold single-scope');
  assert.equal(json.mode, 'fold-superseded');
  assert.equal(json.chains.length, 1);
  assert.equal(json.chains[0].chain_length, 1500);
  cleanup(fx);
});

t('--fold-superseded --all-projects: >64KB report reaches a slow pipe consumer intact', () => {
  const fx = mkFixture();
  const proj = path.join(fx.cwd, 'proj');
  fs.mkdirSync(proj);
  seedChain(proj, 1500);
  rebuildIndex(fx, proj);
  fs.writeFileSync(path.join(fx.home, '.episodic-memory', 'installs.json'), JSON.stringify({
    schema_version: 1,
    entries: [{ project_path: proj, tool: 'claude-code', version: 'v1', enforcement_installed: false, last_install_ts: '2026-07-08T00:00:00Z' }],
  }, null, 2));
  const runDir = path.join(fx.cwd, 'elsewhere');
  fs.mkdirSync(runDir);
  const json = assertFullReport(runSlowPipe(fx, runDir, ['--fold-superseded', '--dry-run', '--all-projects']), 'fold all-projects');
  assert.equal(json.all_projects, true);
  const st = json.stores.find(s => s.chains);
  assert.ok(st, `a registered store with chains is reported: ${JSON.stringify(json.stores.map(s => s.label))}`);
  assert.equal(st.chains[0].chain_length, 1500);
  cleanup(fx);
});

t('dry-run cluster report: >64KB report reaches a slow pipe consumer intact', () => {
  const fx = mkFixture();
  seedCluster(fx.cwd, 50);
  rebuildIndex(fx, fx.cwd);
  const json = assertFullReport(runSlowPipe(fx, fx.cwd, ['--scope', 'local']), 'cluster dry-run');
  assert.equal(json.dry_run, true);
  assert.equal(json.clusters.length, 1);
  assert.equal(json.clusters[0].members.length, 50);
  cleanup(fx);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
